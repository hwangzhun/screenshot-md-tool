const { app, ipcMain, safeStorage } = require('electron')
const path = require('path')
const crypto = require('crypto')
const { readImageAsBase64 } = require('../utils/image')
const { runSequentialOCR } = require('../services/ocr')
const { normalizeGroups, organizeGroupText, composeMarkdown } = require('../services/grouping')
const { postOpenAICompatible } = require('../services/http-openai')
const { TaskStore } = require('../services/task-store')
const { SettingsStore } = require('../services/settings-store')

let mainWindowRef = null
let taskStore = null
let settingsStore = null
const jobs = new Map()

function setMainWindow(win) { mainWindowRef = win }
function getMainWindow() { return mainWindowRef }
function sendProgress(payload) {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) mainWindowRef.webContents.send('job-progress', payload)
}
function reply(work) {
  return Promise.resolve().then(work).then(data => ({ success: true, data })).catch(error => ({ success: false, error: error.message }))
}
function configFor(kind) {
  const config = settingsStore.getApiConfig(kind)
  if (!config.apiKey) throw new Error(`${kind === 'ocrApi' ? 'OCR' : '整理'} API Key 未配置`)
  if (!config.apiHost) throw new Error('API 地址未配置')
  if (!config.model) throw new Error('模型名称未配置')
  return config
}
function taskHasJob(taskId) { return [...jobs.values()].some(job => job.taskId === taskId) }

function launchOCR(taskId, imageIds) {
  if (taskHasJob(taskId)) throw new Error('该任务正在处理中')
  const task = taskStore.read(taskId)
  const wanted = new Set(imageIds || [])
  const images = task.images.filter(image => wanted.size ? wanted.has(image.id) : image.status !== 'success')
  if (!images.length) throw new Error('没有需要识别的截图')
  const config = configFor('ocrApi')
  const jobId = crypto.randomUUID()
  const controller = new AbortController()
  jobs.set(jobId, { taskId, controller, stage: 'ocr' })
  const resetIds = new Set(images.map(image => image.id))
  const resetGroups = (task.groups || []).map(group => (group.imageIds || []).some(id => resetIds.has(id)) ? { ...group, organizeStatus: 'pending', markdown: '', error: '' } : group)
  taskStore.update(taskId, {
    status: 'processing', stage: 'ocr', uiStage: 'review', lastError: '',
    groups: resetGroups, previousMarkdown: task.markdown || task.previousMarkdown || '', markdown: ''
  })

  ;(async () => {
    try {
      const outcome = await runSequentialOCR(images, config, {
        signal: controller.signal,
        onProgress(event) {
          const base = { jobId, taskId, stage: 'ocr', imageId: event.image.id, current: event.index + 1, total: event.total }
          if (event.type === 'start') {
            taskStore.update(taskId, { imageUpdates: [{ id: event.image.id, status: 'processing', error: '' }] })
            sendProgress({ ...base, status: 'processing', message: `正在识别 ${event.image.name}` })
          } else if (event.type === 'retry') {
            sendProgress({ ...base, status: 'retrying', message: `请求异常，正在第 ${event.attempt} 次重试` })
          } else if (event.type === 'success') {
            taskStore.update(taskId, { imageUpdates: [{ id: event.image.id, status: 'success', ocrText: event.text, error: '' }] })
            sendProgress({ ...base, status: 'success', message: `${event.image.name} 识别完成` })
          } else if (event.type === 'error') {
            taskStore.update(taskId, { imageUpdates: [{ id: event.image.id, status: 'error', error: event.error }] })
            sendProgress({ ...base, status: 'error', message: event.error })
          }
        }
      })
      taskStore.update(taskId, {
        status: outcome.canceled ? 'paused' : 'idle', stage: 'edit', uiStage: 'review',
        lastError: outcome.canceled ? '识别已取消，完成结果已保留' : ''
      })
      sendProgress({ jobId, taskId, stage: 'ocr', status: outcome.canceled ? 'canceled' : 'complete', current: images.length, total: images.length, message: outcome.canceled ? '已取消' : 'OCR 阶段完成' })
    } catch (error) {
      try { taskStore.update(taskId, { status: 'idle', stage: 'edit', uiStage: 'review', lastError: error.message }) } catch {}
      sendProgress({ jobId, taskId, stage: 'ocr', status: 'failed', message: error.message })
    } finally { jobs.delete(jobId) }
  })()
  return { jobId }
}

function launchOrganize(taskId, allowFailures, requestedGroupIds) {
  if (taskHasJob(taskId)) throw new Error('该任务正在处理中')
  const task = taskStore.read(taskId)
  const failures = task.images.filter(image => image.status === 'error')
  if (failures.length && !allowFailures) throw new Error(`仍有 ${failures.length} 张截图失败，请先重试或明确忽略`)
  const usable = task.images.filter(image => image.ocrText?.trim())
  if (!usable.length) throw new Error('没有可整理的 OCR 文本')
  const allGroups = normalizeGroups(usable, task.groups || [])
  const selectedIds = new Set(requestedGroupIds || allGroups.map(group => group.id))
  const groups = allGroups.filter(group => selectedIds.has(group.id))
  if (!groups.length) throw new Error('没有可整理的文章组')
  const config = configFor('llmApi')
  const jobId = crypto.randomUUID()
  const controller = new AbortController()
  jobs.set(jobId, { taskId, controller, stage: 'organize' })
  taskStore.update(taskId, { status: 'processing', stage: 'edit', uiStage: 'organize', groups: allGroups, lastError: '' })
  sendProgress({ jobId, taskId, stage: 'organize', status: 'processing', current: 0, total: groups.length, message: '正在逐篇整理 Markdown' })

  ;(async () => {
    try {
      let working = taskStore.read(taskId)
      if (!working.previousMarkdown && working.markdown) working.previousMarkdown = working.markdown
      for (let index = 0; index < groups.length; index += 1) {
        if (controller.signal.aborted) break
        const group = groups[index]
        const position = working.groups.findIndex(item => item.id === group.id)
        if (position < 0) continue
        working.groups[position] = { ...working.groups[position], organizeStatus: 'processing', error: '' }
        taskStore.update(taskId, { groups: working.groups })
        sendProgress({ jobId, taskId, stage: 'organize', groupId: group.id, groupIndex: index + 1, groupTotal: groups.length, status: 'processing', current: index, total: groups.length, message: `正在整理 ${group.title}（${index + 1}/${groups.length}）` })
        try {
          const result = await organizeGroupText(config, working.groups[position], usable, { signal: controller.signal })
          if (!result.markdown) throw new Error('整理 API 未返回有效内容')
          const title = working.groups[position].titleMode === 'manual' ? working.groups[position].title : result.title
          working.groups[position] = { ...working.groups[position], title, organizeStatus: 'success', markdown: result.markdown, error: '' }
          taskStore.update(taskId, { groups: working.groups })
          sendProgress({ jobId, taskId, stage: 'organize', groupId: group.id, groupIndex: index + 1, groupTotal: groups.length, status: 'success', current: index + 1, total: groups.length, message: `${title} 整理完成` })
        } catch (error) {
          if (error.code === 'ABORTED' || controller.signal.aborted) break
          working.groups[position] = { ...working.groups[position], organizeStatus: 'error', error: error.message }
          taskStore.update(taskId, { groups: working.groups })
          sendProgress({ jobId, taskId, stage: 'organize', groupId: group.id, groupIndex: index + 1, groupTotal: groups.length, status: 'error', current: index + 1, total: groups.length, message: `${group.title} 整理失败：${error.message}` })
        }
      }
      const finalTask = taskStore.read(taskId)
      const canceled = controller.signal.aborted
      const finishedGroups = finalTask.groups || []
      const hasFailures = finishedGroups.some(group => group.organizeStatus === 'error')
      taskStore.update(taskId, { markdown: composeMarkdown(finishedGroups), stage: 'result', uiStage: canceled || hasFailures ? 'organize' : 'export', status: canceled ? 'paused' : 'idle', lastError: canceled ? '整理已取消，已完成文章已保留' : '' })
      sendProgress({ jobId, taskId, stage: 'organize', status: canceled ? 'canceled' : 'complete', current: groups.length, total: groups.length, message: canceled ? '整理已取消，已完成文章已保留' : '文章整理完成' })
    } catch (error) {
      const canceled = error.code === 'ABORTED' || controller.signal.aborted
      try { taskStore.update(taskId, { status: 'idle', stage: 'edit', uiStage: 'organize', lastError: canceled ? '整理已取消，已完成文章已保留' : error.message }) } catch {}
      sendProgress({ jobId, taskId, stage: 'organize', status: canceled ? 'canceled' : 'failed', current: 0, total: 1, message: canceled ? '整理已取消' : error.message })
    } finally { jobs.delete(jobId) }
  })()
  return { jobId }
}

function registerIpc() {
  const dataDir = path.join(app.getPath('userData'), 'workspace')
  taskStore = new TaskStore(dataDir)
  settingsStore = new SettingsStore(path.join(dataDir, 'settings.json'), safeStorage)

  ipcMain.handle('read-image-base64', (_event, filePath) => readImageAsBase64(filePath))
  ipcMain.handle('tasks-list', () => reply(() => ({ tasks: taskStore.list(), activeTaskId: taskStore.getActive() })))
  ipcMain.handle('task-create', (_event, name) => reply(() => taskStore.create(name)))
  ipcMain.handle('task-load', (_event, id) => reply(() => { const task = taskStore.read(id); taskStore.setActive(id); return task }))
  ipcMain.handle('task-update', (_event, id, patch) => reply(() => taskStore.update(id, patch)))
  ipcMain.handle('task-delete', (_event, id) => reply(() => { if (taskHasJob(id)) throw new Error('请先取消正在运行的任务'); return taskStore.delete(id) }))
  ipcMain.handle('task-import-images', (_event, id, paths) => reply(() => taskStore.importImages(id, paths)))
  ipcMain.handle('task-remove-image', (_event, id, imageId) => reply(() => taskStore.removeImage(id, imageId)))
  ipcMain.handle('task-image-data', (_event, id, imageId) => reply(() => {
    const task = taskStore.read(id); const image = task.images.find(item => item.id === imageId)
    if (!image) throw new Error('截图不存在')
    const result = readImageAsBase64(image.originalPath)
    if (!result.success) throw new Error(result.error)
    return result.data
  }))
  ipcMain.handle('task-undo-organize', (_event, id) => reply(() => {
    const task = taskStore.read(id)
    if (!task.previousMarkdown) throw new Error('没有可恢复的上一个结果')
    return taskStore.update(id, { markdown: task.previousMarkdown, previousMarkdown: task.markdown, stage: 'result', uiStage: 'export' })
  }))
  ipcMain.handle('group-update', (_event, id, groups) => reply(() => {
    const task = taskStore.read(id)
    const normalized = normalizeGroups(task.images, groups).map(group => ({ ...group, organizeStatus: 'pending', markdown: '', error: '' }))
    return taskStore.update(id, { groups: normalized, groupSuggestions: [], previousMarkdown: task.markdown || task.previousMarkdown || '', markdown: '', stage: 'group', uiStage: 'materials' })
  }))

  ipcMain.handle('job-start-ocr', (_event, taskId, imageIds) => reply(() => launchOCR(taskId, imageIds)))
  ipcMain.handle('job-start-organize', (_event, taskId, allowFailures, groupIds) => reply(() => launchOrganize(taskId, allowFailures, groupIds)))
  ipcMain.handle('job-cancel', (_event, jobId) => reply(() => { const job = jobs.get(jobId); if (job) job.controller.abort(); return !!job }))

  ipcMain.handle('settings-get', () => reply(() => settingsStore.publicSettings()))
  ipcMain.handle('settings-save', (_event, input) => reply(() => settingsStore.save(input)))
  ipcMain.handle('settings-migrate', (_event, legacy) => reply(() => settingsStore.migrateLegacy(legacy)))
  ipcMain.handle('settings-test', (_event, kind, draft) => reply(async () => {
    const saved = settingsStore.getApiConfig(kind)
    const config = { ...saved, apiHost: draft?.apiHost || saved.apiHost, model: draft?.model || saved.model, apiKey: draft?.apiKey || saved.apiKey }
    if (kind === 'ocrApi') {
      const sample = readImageAsBase64(path.join(__dirname, '../../build/icons/icons/png/128x128.png'))
      if (!sample.success) throw new Error(sample.error)
      await postOpenAICompatible(config, { model: config.model, max_tokens: 8, messages: [{ role: 'user', content: [{ type: 'text', text: '请只回复 OK' }, { type: 'image_url', image_url: { url: sample.data } }] }] }, 'OCR API 测试', { retries: 0, timeout: 30000 })
    } else {
      await postOpenAICompatible(config, { model: config.model, max_tokens: 8, messages: [{ role: 'user', content: '请只回复 OK' }] }, '整理 API 测试', { retries: 0, timeout: 30000 })
    }
    return { message: '连接成功' }
  }))
}

function abortAllJobs() { for (const job of jobs.values()) job.controller.abort() }

module.exports = { registerIpc, setMainWindow, getMainWindow, abortAllJobs }
