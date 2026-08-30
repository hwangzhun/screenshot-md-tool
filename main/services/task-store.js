const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { prepareUploadCopy } = require('../utils/image')
const { atomicWriteJSON } = require('./settings-store')

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'])

function safeName(value) {
  return String(value || '截图任务').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 80) || '截图任务'
}

function directoryBytes(dir) {
  if (!fs.existsSync(dir)) return 0
  return fs.readdirSync(dir, { withFileTypes: true }).reduce((total, entry) => {
    const target = path.join(dir, entry.name)
    return total + (entry.isDirectory() ? directoryBytes(target) : fs.statSync(target).size)
  }, 0)
}

class TaskStore {
  constructor(rootDir, options = {}) {
    this.rootDir = rootDir
    this.tasksDir = path.join(rootDir, 'tasks')
    this.statePath = path.join(rootDir, 'task-state.json')
    this.prepareImage = options.prepareImage || prepareUploadCopy
    fs.mkdirSync(this.tasksDir, { recursive: true })
    this.recoverInterrupted()
  }

  taskDir(id) { return path.join(this.tasksDir, id) }
  manifestPath(id) { return path.join(this.taskDir(id), 'task.json') }
  markdownPath(id) { return path.join(this.taskDir(id), 'result.md') }

  read(id) {
    return JSON.parse(fs.readFileSync(this.manifestPath(id), 'utf8'))
  }

  recoverInterrupted() {
    for (const entry of fs.readdirSync(this.tasksDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      try {
        const task = this.read(entry.name)
        let recovered = false
        for (const image of task.images || []) {
          if (image.status === 'processing') {
            image.status = 'pending'
            image.error = '上次处理被中断，可继续识别'
            recovered = true
          }
        }
        if (task.status === 'processing') {
          task.status = 'paused'
          task.lastError = '上次处理被中断，已保留完成结果'
          recovered = true
        }
        if (recovered) this.write(task)
      } catch {}
    }
  }

  write(task) {
    task.updatedAt = new Date().toISOString()
    atomicWriteJSON(this.manifestPath(task.id), task)
    const markdownPath = this.markdownPath(task.id)
    if (String(task.markdown || '').trim()) {
      const temporary = `${markdownPath}.${process.pid}.tmp`
      fs.writeFileSync(temporary, task.markdown, 'utf8')
      fs.renameSync(temporary, markdownPath)
    } else if (fs.existsSync(markdownPath)) {
      fs.rmSync(markdownPath, { force: true })
    }
    return task
  }

  create(name = '截图任务') {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    fs.mkdirSync(path.join(this.taskDir(id), 'images'), { recursive: true })
    fs.mkdirSync(path.join(this.taskDir(id), 'uploads'), { recursive: true })
    const task = {
      version: 2, id, name: safeName(name), createdAt: now, updatedAt: now,
      stage: 'import', uiStage: 'materials', status: 'idle', images: [], groups: [], groupSuggestions: [], markdown: '', previousMarkdown: '',
      selectedImageId: '', lastError: ''
    }
    this.write(task)
    this.setActive(id)
    return task
  }

  list() {
    return fs.readdirSync(this.tasksDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => {
        try {
          const task = this.read(entry.name)
          const completeCount = task.images.filter(image => image.status === 'success').length
          return {
            id: task.id, name: task.name, createdAt: task.createdAt, updatedAt: task.updatedAt,
            stage: task.stage, uiStage: task.uiStage || '', status: task.status, imageCount: task.images.length,
            completeCount, storageBytes: directoryBytes(this.taskDir(task.id)), lastError: task.lastError || ''
          }
        } catch { return null }
      })
      .filter(Boolean)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  importImages(id, filePaths) {
    const task = this.read(id)
    const previousMarkdown = task.markdown || task.previousMarkdown || ''
    const added = []
    for (const sourcePath of filePaths || []) {
      const extension = path.extname(sourcePath).toLowerCase()
      if (!IMAGE_EXTENSIONS.has(extension)) continue
      const imageId = crypto.randomUUID()
      const originalName = path.basename(sourcePath)
      const storedName = `${String(task.images.length + added.length + 1).padStart(3, '0')}_${imageId}${extension}`
      const storedPath = path.join(this.taskDir(id), 'images', storedName)
      fs.copyFileSync(sourcePath, storedPath)
      try {
        const prepared = this.prepareImage(storedPath, path.join(this.taskDir(id), 'uploads'), imageId)
        added.push({
          id: imageId, name: originalName, originalPath: storedPath,
          uploadPath: prepared.uploadPath, width: prepared.width || 0, height: prepared.height || 0,
          bytes: fs.statSync(storedPath).size, uploadBytes: prepared.uploadBytes || 0,
          resized: !!prepared.resized, status: 'pending', ocrText: '', error: ''
        })
      } catch (error) {
        fs.rmSync(storedPath, { force: true })
        throw new Error(`${originalName} 导入失败：${error.message}`)
      }
    }
    task.images.push(...added)
    if (added.length) {
      task.groups = (task.groups || []).map(group => ({ ...group, organizeStatus: 'pending', markdown: '', error: '' }))
      task.previousMarkdown = previousMarkdown
      task.markdown = ''
    }
    if (!task.selectedImageId && task.images[0]) task.selectedImageId = task.images[0].id
    task.stage = 'group'
    task.uiStage = 'materials'
    task.status = 'idle'
    task.lastError = ''
    return this.write(task)
  }

  update(id, patch = {}) {
    const task = this.read(id)
    if (typeof patch.name === 'string') task.name = safeName(patch.name)
    for (const field of ['stage', 'uiStage', 'status', 'markdown', 'previousMarkdown', 'selectedImageId', 'lastError']) {
      if (typeof patch[field] === 'string') task[field] = patch[field]
    }
    if (Array.isArray(patch.groups)) {
      task.groups = patch.groups
      const membership = new Map()
      for (const group of task.groups) for (const imageId of group.imageIds || []) membership.set(imageId, group.id)
      for (const image of task.images) image.groupId = membership.get(image.id) || ''
    }
    if (Array.isArray(patch.groupSuggestions)) task.groupSuggestions = patch.groupSuggestions
    if (Array.isArray(patch.imageOrder)) {
      const byId = new Map(task.images.map(image => [image.id, image]))
      const ordered = patch.imageOrder.map(imageId => byId.get(imageId)).filter(Boolean)
      if (ordered.length === task.images.length) {
        task.images = ordered
        const position = new Map(task.images.map((image, index) => [image.id, index]))
        for (const group of task.groups || []) {
          group.imageIds.sort((a, b) => (position.get(a) ?? Number.MAX_SAFE_INTEGER) - (position.get(b) ?? Number.MAX_SAFE_INTEGER))
        }
      }
    }
    if (Array.isArray(patch.imageUpdates)) {
      for (const update of patch.imageUpdates) {
        const image = task.images.find(item => item.id === update.id)
        if (!image) continue
        for (const field of ['status', 'ocrText', 'error']) {
          if (typeof update[field] === 'string') image[field] = update[field]
        }
      }
    }
    return this.write(task)
  }

  removeImage(taskId, imageId) {
    const task = this.read(taskId)
    const image = task.images.find(item => item.id === imageId)
    if (!image) return task
    for (const target of new Set([image.originalPath, image.uploadPath])) {
      if (target && target.startsWith(this.taskDir(taskId))) fs.rmSync(target, { force: true })
    }
    task.images = task.images.filter(item => item.id !== imageId)
    task.groups = (task.groups || []).map(group => ({ ...group, imageIds: (group.imageIds || []).filter(id => id !== imageId) })).filter(group => group.imageIds.length)
    task.groups = task.groups.map(group => ({ ...group, organizeStatus: 'pending', markdown: '', error: '' }))
    task.groupSuggestions = (task.groupSuggestions || []).map(group => ({ ...group, imageIds: (group.imageIds || []).filter(id => id !== imageId) })).filter(group => group.imageIds.length > 1)
    task.selectedImageId = task.images[0]?.id || ''
    task.previousMarkdown = task.markdown || task.previousMarkdown || ''
    task.markdown = ''
    task.stage = task.images.length ? 'ocr' : 'import'
    task.uiStage = task.images.length ? 'review' : 'materials'
    return this.write(task)
  }

  delete(id) {
    const exact = this.taskDir(id)
    if (!exact.startsWith(this.tasksDir + path.sep)) throw new Error('无效任务路径')
    fs.rmSync(exact, { recursive: true, force: true })
    if (this.getActive() === id) this.setActive('')
    return true
  }

  setActive(id) { atomicWriteJSON(this.statePath, { activeTaskId: id || '' }) }
  getActive() {
    try { return JSON.parse(fs.readFileSync(this.statePath, 'utf8')).activeTaskId || '' } catch { return '' }
  }
}

module.exports = { TaskStore, safeName, directoryBytes }
