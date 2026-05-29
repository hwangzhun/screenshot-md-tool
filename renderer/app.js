/**
 * renderer/app.js - 渲染进程入口
 * 负责全局状态、DOM 引用、初始化和事件绑定
 */

// ─────────────────────────────────────────
//   状态
// ─────────────────────────────────────────
const state = {
  images: [],
  mdContent: '',
  processing: false,
  mode: 'edit'
}

// ─────────────────────────────────────────
//   设置管理
// ─────────────────────────────────────────
const SETTINGS_KEY = 'screenshot_md_settings'
const SETTINGS_VERSION = 2
const LEGACY_DEFAULT_API_HOST = 'api.hunyuan.cloud.tencent.com'
const LEGACY_OCR_MODEL = 'hunyuan-vision'
const LEGACY_LLM_MODEL = 'hunyuan-turbo'
const DEFAULT_SETTINGS = {
  settingsVersion: SETTINGS_VERSION,
  ocrApi: { apiKey: '', apiHost: '', model: '' },
  llmApi: { apiKey: '', apiHost: '', model: '' },
  theme: 'dark',
  batchSize: 5,
  skipOrganize: false
}

function stripLegacyApiDefaults(api, legacyModel) {
  const next = { ...api }
  if (next.apiKey?.trim()) return next
  if (next.apiHost === LEGACY_DEFAULT_API_HOST) next.apiHost = ''
  if (next.model === legacyModel) next.model = ''
  return next
}

function mergeSettings(parsed) {
  const merged = {
    ...DEFAULT_SETTINGS,
    ...parsed,
    ocrApi: { ...DEFAULT_SETTINGS.ocrApi, ...(parsed.ocrApi || {}) },
    llmApi: { ...DEFAULT_SETTINGS.llmApi, ...(parsed.llmApi || {}) }
  }
  const before = JSON.stringify(merged.ocrApi) + JSON.stringify(merged.llmApi)
  merged.ocrApi = stripLegacyApiDefaults(merged.ocrApi, LEGACY_OCR_MODEL)
  merged.llmApi = stripLegacyApiDefaults(merged.llmApi, LEGACY_LLM_MODEL)
  merged.settingsVersion = SETTINGS_VERSION
  const after = JSON.stringify(merged.ocrApi) + JSON.stringify(merged.llmApi)
  if (before !== after || (parsed.settingsVersion || 1) < SETTINGS_VERSION) {
    saveSettings(merged)
  }
  return merged
}

function loadSettings() {
  try {
    const saved = localStorage.getItem(SETTINGS_KEY)
    if (saved) {
      const parsed = JSON.parse(saved)
      if (parsed.apiKey && !parsed.ocrApi) {
        parsed.ocrApi = { apiKey: parsed.apiKey, apiHost: parsed.apiHost || '', model: parsed.model || '' }
        parsed.llmApi = { apiKey: parsed.apiKey, apiHost: parsed.apiHost || '', model: parsed.model || '' }
        delete parsed.apiKey
        delete parsed.apiHost
        delete parsed.model
      }
      delete parsed.apiPath
      delete parsed.fallback
      delete parsed.customHost
      return mergeSettings(parsed)
    }
  } catch {}
  const oldKey = localStorage.getItem('minimax_api_key')
  if (oldKey) {
    const s = { ...DEFAULT_SETTINGS, ocrApi: { ...DEFAULT_SETTINGS.ocrApi, apiKey: oldKey }, llmApi: { ...DEFAULT_SETTINGS.llmApi, apiKey: oldKey } }
    saveSettings(s)
    localStorage.removeItem('minimax_api_key')
    return s
  }
  return { ...DEFAULT_SETTINGS }
}

function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s))
}

let settings = loadSettings()

// ─────────────────────────────────────────
//   主题
// ─────────────────────────────────────────
function applyTheme(theme) {
  document.documentElement.className = theme === 'light' ? 'light' : ''
  const toggle = $('theme-toggle')
  if (toggle) toggle.textContent = theme === 'light' ? '☀️' : '🌙'
}
applyTheme(settings.theme)

// ─────────────────────────────────────────
//   DOM 引用
// ─────────────────────────────────────────
const dropZone = $('drop-zone')
const imageList = $('image-list')
const emptyHint = $('empty-hint')
const startBtn = $('start-btn')
const clearBtn = $('clear-btn')
const mdEditor = $('md-editor')
const mdPreview = $('md-preview')
const previewContent = $('preview-content')
const tabEdit = $('tab-edit')
const tabPreview = $('tab-preview')
const exportBtn = $('export-btn')
const copyBtn = $('copy-btn')
const clearMdBtn = $('clear-md-btn')
const statusDot = $('status-dot')
const statusText = $('status-text')
const statusCount = $('status-count')
const imgCountBadge = $('img-count-badge')
const progressWrap = $('progress-wrap')
const progressBar = $('progress-bar')

const settingsOverlay = $('settings-overlay')
const settingsBtn = $('settings-btn')
const settingsClose = $('settings-close')
const settingsCancel = $('settings-cancel')
const settingsSave = $('settings-save')
const sOcrApikey = $('s-ocr-apikey')
const sOcrApihost = $('s-ocr-apihost')
const sOcrModel = $('s-ocr-model')
const sLlmApikey = $('s-llm-apikey')
const sLlmApihost = $('s-llm-apihost')
const sLlmModel = $('s-llm-model')
const sTheme = $('s-theme')
const sBatchSize = $('s-batch-size')
const sSkipOrganize = $('s-skip-organize')
const themeToggle = $('theme-toggle')
const apiHint = $('api-hint')

const winMinimize = $('win-minimize')
const winMaximize = $('win-maximize')
const winClose = $('win-close')
const maxIcon = $('max-icon')

// ─────────────────────────────────────────
//   工具函数
// ─────────────────────────────────────────
function showToast(msg, type = '') {
  const t = $('toast')
  t.textContent = msg
  t.className = 'toast show ' + type
  clearTimeout(t._timer)
  t._timer = setTimeout(() => { t.className = 'toast' }, 3000)
}

function setStatus(text, stateVal = '') {
  statusText.textContent = text
  statusDot.className = 'status-dot ' + stateVal
}

function setProgress(pct) {
  progressWrap.classList.toggle('active', pct > 0 && pct < 100)
  progressBar.style.width = pct + '%'
}

function updateBadge() {
  const n = state.images.length
  imgCountBadge.textContent = n + ' 张'
  imgCountBadge.className = 'badge' + (n > 0 ? ' active' : '')
  if (emptyHint) emptyHint.style.display = n === 0 ? '' : 'none'
  startBtn.disabled = n === 0 || state.processing
}

function updateApiKeyStatus() {
  const ocrDot = $('ocr-key-dot')
  const ocrLabel = $('ocr-key-label')
  const llmDot = $('llm-key-dot')
  const llmLabel = $('llm-key-label')
  if (ocrDot && ocrLabel) {
    if (settings.ocrApi?.apiKey) {
      ocrDot.className = 'api-key-dot configured'
      ocrLabel.textContent = 'OCR ' + settings.ocrApi.apiKey.slice(0, 6) + '...'
    } else {
      ocrDot.className = 'api-key-dot'
      ocrLabel.textContent = 'OCR 未配置'
    }
  }
  if (llmDot && llmLabel) {
    if (settings.llmApi?.apiKey) {
      llmDot.className = 'api-key-dot configured'
      llmLabel.textContent = 'LLM ' + settings.llmApi.apiKey.slice(0, 6) + '...'
    } else {
      llmDot.className = 'api-key-dot'
      llmLabel.textContent = 'LLM 未配置'
    }
  }
}
updateApiKeyStatus()

// ─────────────────────────────────────────
//   设置面板
// ─────────────────────────────────────────
function openSettings() {
  settings.ocrApi = stripLegacyApiDefaults(settings.ocrApi || {}, LEGACY_OCR_MODEL)
  settings.llmApi = stripLegacyApiDefaults(settings.llmApi || {}, LEGACY_LLM_MODEL)
  sOcrApikey.value = settings.ocrApi.apiKey || ''
  sOcrApihost.value = settings.ocrApi.apiHost || ''
  sOcrModel.value = settings.ocrApi.model || ''
  sLlmApikey.value = settings.llmApi.apiKey || ''
  sLlmApihost.value = settings.llmApi.apiHost || ''
  sLlmModel.value = settings.llmApi.model || ''
  sTheme.checked = settings.theme === 'light'
  sSkipOrganize.checked = !!settings.skipOrganize
  updateThemeLabels()
  sBatchSize.value = settings.batchSize
  settingsOverlay.classList.add('active')
}

function closeSettings() {
  settingsOverlay.classList.remove('active')
}

function updateThemeLabels() {
  const isLight = sTheme.checked
  $('theme-icon-current').textContent = isLight ? '☀️' : '🌙'
  $('theme-label-text').textContent = isLight ? '明亮模式' : '暗色模式'
}

settingsBtn.addEventListener('click', openSettings)
settingsClose.addEventListener('click', closeSettings)
settingsCancel.addEventListener('click', closeSettings)
settingsOverlay.addEventListener('click', (e) => {
  if (e.target === settingsOverlay) closeSettings()
})

sTheme.addEventListener('change', updateThemeLabels)

settingsSave.addEventListener('click', () => {
  settings = {
    ...settings,
    settingsVersion: SETTINGS_VERSION,
    ocrApi: {
      apiKey: sOcrApikey.value.trim(),
      apiHost: sOcrApihost.value.trim(),
      model: sOcrModel.value.trim()
    },
    llmApi: {
      apiKey: sLlmApikey.value.trim(),
      apiHost: sLlmApihost.value.trim(),
      model: sLlmModel.value.trim()
    },
    theme: sTheme.checked ? 'light' : 'dark',
    batchSize: parseInt(sBatchSize.value),
    skipOrganize: sSkipOrganize.checked
  }
  saveSettings(settings)
  applyTheme(settings.theme)
  updateApiKeyStatus()
  closeSettings()
  showToast('设置已保存', 'success')
})

themeToggle.addEventListener('click', () => {
  settings.theme = settings.theme === 'light' ? 'dark' : 'light'
  saveSettings(settings)
  applyTheme(settings.theme)
})

// ─────────────────────────────────────────
//   图片管理
// ─────────────────────────────────────────
async function addImages(filePaths) {
  for (const fp of filePaths) {
    if (state.images.find(i => i.path === fp)) continue
    const res = await window.electronAPI.readImageAsBase64(fp)
    if (!res.success) { showToast('读取失败: ' + fp, 'error'); continue }
    const fname = fp.split(/[\\/]/).pop()
    const ext = fname.split('.').pop().toLowerCase()
    state.images.push({ path: fp, name: fname, ext, dataUrl: res.data })
  }
  renderImageList()
  updateBadge()
}

function removeImage(idx) {
  state.images.splice(idx, 1)
  renderImageList()
  updateBadge()
}

function renderImageList() {
  const items = state.images.map((img, i) => `
    <div class="image-item" draggable="true" data-idx="${i}"
         ondragstart="onDragStart(event,${i})"
         ondragover="onDragOver(event,${i})"
         ondrop="onDrop(event,${i})"
         ondragleave="onDragLeave(event,${i})">
      <img class="img-thumb" src="${img.dataUrl}" alt="${img.name}" />
      <div class="img-info">
        <div class="img-name">${img.name}</div>
        <div class="img-size">${img.ext.toUpperCase()}</div>
      </div>
      <div class="img-order">${i+1}</div>
      <button class="img-delete" onclick="removeImage(${i})" title="删除">✕</button>
    </div>
  `).join('')
  imageList.innerHTML = items + (state.images.length === 0 ? '<div class="empty-hint" id="empty-hint">添加截图后在此处显示</div>' : '')
}

// 拖拽排序
let dragIdx = null
function onDragStart(e, idx) {
  dragIdx = idx
  setTimeout(() => e.target.classList.add('dragging'), 0)
}
function onDragOver(e, idx) {
  e.preventDefault()
  document.querySelectorAll('.image-item').forEach(el => el.classList.remove('drag-target'))
  if (idx !== dragIdx) e.currentTarget.classList.add('drag-target')
}
function onDragLeave(e, idx) {
  e.currentTarget.classList.remove('drag-target')
}
function onDrop(e, idx) {
  e.preventDefault()
  document.querySelectorAll('.image-item').forEach(el => {
    el.classList.remove('drag-target')
    el.classList.remove('dragging')
  })
  if (dragIdx === null || dragIdx === idx) return
  const moved = state.images.splice(dragIdx, 1)[0]
  state.images.splice(idx, 0, moved)
  renderImageList()
  updateBadge()
  dragIdx = null
}

// 文件选择
$('open-dialog-btn').addEventListener('click', async (e) => {
  e.stopPropagation()
  const res = await window.electronAPI.openFileDialog()
  if (res.success && res.filePaths.length) {
    await addImages(res.filePaths)
    setStatus(`已添加 ${state.images.length} 张截图，等待识别`, '')
  }
})

dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over') })
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'))
dropZone.addEventListener('drop', async e => {
  e.preventDefault()
  dropZone.classList.remove('drag-over')
  const files = [...e.dataTransfer.files].filter(f => /\.(jpe?g|png|gif|webp|bmp)$/i.test(f.name))
  if (!files.length) { showToast('没有识别到图片文件', 'error'); return }
  const paths = files.map(f => f.path)
  await addImages(paths)
  setStatus(`已添加 ${state.images.length} 张截图，等待识别`, '')
})

clearBtn.addEventListener('click', () => {
  state.images = []
  renderImageList()
  updateBadge()
  setStatus('已清空截图列表', '')
})

// ─────────────────────────────────────────
//   主流程：识别
// ─────────────────────────────────────────
function buildRawOCRMarkdown(ocrPages) {
  const now = new Date().toLocaleString('zh-CN')
  const lines = [`# OCR 原始文本\n`, `> 识别时间：${now}\n> 流程：仅 OCR，未经过大模型整理\n`, `---\n`]
  for (const page of ocrPages) {
    const name = page.filePath ? page.filePath.split(/[\\/]/).pop() : `截图 ${page.index}`
    lines.push(`## 截图 ${page.index}：${name}\n`)
    if (page.error) {
      lines.push(`> OCR 失败：${page.error}\n`)
    } else if (page.text) {
      lines.push(page.text + '\n')
    } else {
      lines.push(`*（未识别到文字）*\n`)
    }
    lines.push('\n')
  }
  return lines.join('').trim()
}

startBtn.addEventListener('click', async () => {
  settings = loadSettings()
  if (!settings.ocrApi?.apiKey) {
    showToast('请先在设置中配置 OCR API Key', 'error')
    openSettings()
    return
  }
  if (!settings.ocrApi?.apiHost) {
    showToast('请先在设置中配置 OCR API 地址', 'error')
    openSettings()
    return
  }
  if (!settings.ocrApi?.model) {
    showToast('请先在设置中配置 OCR 模型', 'error')
    openSettings()
    return
  }
  if (!settings.skipOrganize && !settings.llmApi?.apiKey) {
    showToast('请先在设置中配置大模型 API Key', 'error')
    openSettings()
    return
  }
  if (!settings.skipOrganize && !settings.llmApi?.apiHost) {
    showToast('请先在设置中配置大模型 API 地址', 'error')
    openSettings()
    return
  }
  if (!settings.skipOrganize && !settings.llmApi?.model) {
    showToast('请先在设置中配置大模型名称', 'error')
    openSettings()
    return
  }
  if (state.images.length === 0) { showToast('请先添加截图', 'error'); return }

  state.processing = true
  startBtn.disabled = true

  const total = state.images.length
  setProgress(2)
  setStatus(`第 1 步：正在调用 OCR API 识别 ${total} 张截图…`, 'processing')

  const ocrRes = await window.electronAPI.recognizeImagesCloudOCR(
    state.images.map(img => img.path),
    settings.ocrApi
  )

  if (!ocrRes.success) {
    setProgress(0)
    setStatus('OCR 出错：' + ocrRes.error, 'error')
    showToast('OCR 失败：' + ocrRes.error, 'error')
    state.processing = false
    updateBadge()
    return
  }

  const ocrPages = ocrRes.data.pages || []
  const textCount = ocrPages.reduce((sum, page) => sum + (page.text || '').length, 0)
  const pageStats = ocrPages.map(p => `#${p.index}:${(p.text || '').length}字`).join(' ')

  if (settings.skipOrganize) {
    setProgress(100)
    setTimeout(() => setProgress(0), 800)
    const rawMd = buildRawOCRMarkdown(ocrPages)
    mdEditor.value = rawMd
    state.mdContent = rawMd
    updateWordCount()
    if (state.mode === 'preview') renderPreview()
    setStatus(`OCR 完成！共 ${total} 张，合计 ${textCount} 字（${pageStats}）`, 'success')
    showToast('OCR 完成（未整理）', 'success')
    state.processing = false
    updateBadge()
    return
  }

  if (textCount === 0) {
    setProgress(0)
    setStatus('OCR 完成，但没有识别到文字', '')
    showToast('没有识别到可整理的文字', '')
    state.processing = false
    updateBadge()
    return
  }

  setProgress(55)
  setStatus(`第 2 步：OCR 得到 ${textCount} 字（${pageStats}），正在交给大模型整理 Markdown…`, 'processing')

  const res = await window.electronAPI.organizeOCRText(settings.llmApi, ocrPages)

  if (!res.success) {
    setProgress(0)
    setStatus('整理出错：' + res.error, 'error')
    showToast('模型整理失败：' + res.error, 'error')
    state.processing = false
    updateBadge()
    return
  }

  const apiResp = res.data
  if (apiResp.error || apiResp.error_code) {
    setProgress(0)
    const errMsg = apiResp.error_message || (apiResp.error && apiResp.error.message) || apiResp.error_code || JSON.stringify(apiResp.error || apiResp)
    setStatus('API 返回错:' + errMsg, 'error')
    showToast('API 返回错:' + errMsg, 'error')
    state.processing = false
    updateBadge()
    return
  }

  const allMarkdown = (apiResp.choices?.[0]?.message?.content || '').trim()
  setProgress(100)
  setTimeout(() => setProgress(0), 800)

  if (allMarkdown) {
    const header = `# 语录收集\n\n> 整理时间：${new Date().toLocaleString('zh-CN')}\n> 流程：OCR API → 文本模型整理\n\n---\n\n`
    const finalMd = header + allMarkdown
    mdEditor.value = finalMd
    state.mdContent = finalMd
    updateWordCount()
    if (state.mode === 'preview') renderPreview()
    setStatus(`整理完成！共处理 ${total} 张截图，OCR ${textCount} 字`, 'success')
    showToast('✅ 整理完成', 'success')
  } else {
    setStatus('整理完成，但未提取到有效内容', '')
    showToast('未提取到有效语录', '')
  }

  state.processing = false
  updateBadge()
})

// ─────────────────────────────────────────
//   编辑器
// ─────────────────────────────────────────
mdEditor.addEventListener('input', () => {
  state.mdContent = mdEditor.value
  updateWordCount()
  if (state.mode === 'preview') renderPreview()
})

function renderPreview() {
  previewContent.innerHTML = typeof marked !== 'undefined'
    ? marked.parse(mdEditor.value || '*（暂无内容）*')
    : '<p style="color:var(--text-dim)">预览加载中…</p>'
}

function updateWordCount() {
  const n = mdEditor.value.length
  statusCount.textContent = n > 0 ? `${n} 字符` : ''
}

tabEdit.addEventListener('click', () => {
  state.mode = 'edit'
  tabEdit.classList.add('active'); tabPreview.classList.remove('active')
  mdEditor.style.display = ''; mdPreview.classList.remove('active')
})
tabPreview.addEventListener('click', () => {
  state.mode = 'preview'
  tabPreview.classList.add('active'); tabEdit.classList.remove('active')
  mdEditor.style.display = 'none'; mdPreview.classList.add('active')
  renderPreview()
})

exportBtn.addEventListener('click', async () => {
  const content = mdEditor.value
  if (!content.trim()) { showToast('没有可导出的内容', ''); return }
  const res = await window.electronAPI.saveMDFile(content)
  if (res.success) {
    showToast('✅ 已保存到：' + res.filePath.split(/[\\/]/).pop(), 'success')
    setStatus('文件已导出：' + res.filePath, 'success')
  } else if (!res.canceled) {
    showToast('导出失败：' + res.error, 'error')
  }
})

copyBtn.addEventListener('click', async () => {
  const content = mdEditor.value
  if (!content.trim()) { showToast('没有可复制的内容', ''); return }
  try {
    await navigator.clipboard.writeText(content)
    showToast('✅ 已复制到剪贴板', 'success')
  } catch {
    showToast('复制失败，请手动选中复制', 'error')
  }
})

clearMdBtn.addEventListener('click', () => {
  if (!mdEditor.value.trim()) return
  if (confirm('确定清空编辑区内容？')) {
    mdEditor.value = ''
    state.mdContent = ''
    updateWordCount()
    if (state.mode === 'preview') renderPreview()
    setStatus('已清空编辑区', '')
  }
})

// ─────────────────────────────────────────
//   窗口控制
// ─────────────────────────────────────────
winMinimize.addEventListener('click', () => window.electronAPI.winMinimize())
winMaximize.addEventListener('click', () => window.electronAPI.winMaximize())
winClose.addEventListener('click', () => window.electronAPI.winClose())

async function updateMaxIcon(isMaximized) {
  if (typeof isMaximized === 'undefined') {
    isMaximized = await window.electronAPI.winIsMaximized()
  }
  maxIcon.className = isMaximized ? 'max-icon maximized' : 'max-icon'
}
window.electronAPI.onMaximizeStateChanged((isMaximized) => updateMaxIcon(isMaximized))
updateMaxIcon()

document.querySelector('.titlebar-center').addEventListener('dblclick', () => {
  window.electronAPI.winMaximize()
})

// ─────────────────────────────────────────
//   初始化
// ─────────────────────────────────────────
;(function () {
  const el = $('app-version')
  if (!el || !window.electronAPI?.getAppVersion) return
  window.electronAPI.getAppVersion().then(ver => {
    if (ver) el.textContent = 'v' + ver
  })
})()
updateBadge()
setStatus('就绪 · 请添加截图并在设置中配置 API Key', '')