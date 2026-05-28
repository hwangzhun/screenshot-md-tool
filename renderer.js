/**
 * renderer.js - 渲染进程主逻辑
 * 处理 UI 交互、图片管理、拖拽排序、API 调用调度
 */

/* ─────────────────────────────────────────
   State
───────────────────────────────────────── */
/** @type {{ id: string, path: string, dataUrl: string|null }[]} */
let imageList = []
let mdContent = ''
let isProcessing = false
let viewMode = 'edit' // 'edit' | 'preview'
let dragSrcIndex = -1

const BATCH_SIZE = 5     // 每批最多处理张数
const STORAGE_KEY_APIKEY = 'minimax_api_key'

/* ─────────────────────────────────────────
   DOM References
───────────────────────────────────────── */
const apiKeyInput    = /** @type {HTMLInputElement} */  (document.getElementById('apiKeyInput'))
const dropZone       = document.getElementById('dropZone')
const browseBtn      = document.getElementById('browseBtn')
const thumbGrid      = document.getElementById('thumbGrid')
const imageCountEl   = document.getElementById('imageCount')
const clearImgBtn    = document.getElementById('clearImgBtn')
const startBtn       = /** @type {HTMLButtonElement} */ (document.getElementById('startBtn'))
const mdEditor       = /** @type {HTMLTextAreaElement} */ (document.getElementById('mdEditor'))
const mdPreview      = document.getElementById('mdPreview')
const emptyState     = document.getElementById('emptyState')
const btnEdit        = document.getElementById('btnEdit')
const btnPreview     = document.getElementById('btnPreview')
const exportBtn      = document.getElementById('exportBtn')
const clearMdBtn     = document.getElementById('clearMdBtn')
const statusText     = document.getElementById('statusText')
const progressWrap   = document.getElementById('progressWrap')
const progressFill   = document.getElementById('progressFill')
const progressLabel  = document.getElementById('progressLabel')
const toast          = document.getElementById('toast')

/* ─────────────────────────────────────────
   Init
───────────────────────────────────────── */
function init() {
  // Restore API key from localStorage
  const savedKey = localStorage.getItem(STORAGE_KEY_APIKEY) || ''
  if (savedKey) {
    apiKeyInput.value = savedKey
  }

  // Configure marked options
  if (window.marked) {
    window.marked.setOptions({
      breaks: true,
      gfm: true
    })
  }

  bindEvents()
}

/* ─────────────────────────────────────────
   Event Binding
───────────────────────────────────────── */
function bindEvents() {
  // API key – persist on change
  apiKeyInput.addEventListener('input', () => {
    localStorage.setItem(STORAGE_KEY_APIKEY, apiKeyInput.value.trim())
  })

  // Browse button
  browseBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    openFileDialog()
  })

  // Drop zone click
  dropZone.addEventListener('click', () => {
    openFileDialog()
  })

  // Drag & drop on drop zone
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault()
    e.stopPropagation()
    dropZone.classList.add('drag-over')
  })
  dropZone.addEventListener('dragleave', (e) => {
    e.preventDefault()
    dropZone.classList.remove('drag-over')
  })
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault()
    e.stopPropagation()
    dropZone.classList.remove('drag-over')
    handleDroppedItems(e.dataTransfer.items)
  })

  // Clear images
  clearImgBtn.addEventListener('click', () => {
    if (imageList.length === 0) return
    if (confirm('确认清空所有已上传图片？')) {
      imageList = []
      renderThumbs()
      updateStartBtn()
      setStatus('已清空图片列表')
    }
  })

  // Start processing
  startBtn.addEventListener('click', () => {
    startRecognition()
  })

  // Mode toggle
  btnEdit.addEventListener('click', () => setViewMode('edit'))
  btnPreview.addEventListener('click', () => setViewMode('preview'))

  // Export MD
  exportBtn.addEventListener('click', exportMarkdown)

  // Clear MD
  clearMdBtn.addEventListener('click', () => {
    if (mdContent === '' && mdEditor.value === '') return
    if (confirm('确认清空所有识别结果？')) {
      mdContent = ''
      mdEditor.value = ''
      renderPreview()
      setStatus('已清空识别结果')
    }
  })

  // Sync mdContent from editor
  mdEditor.addEventListener('input', () => {
    mdContent = mdEditor.value
  })
}

/* ─────────────────────────────────────────
   File Handling
───────────────────────────────────────── */

/** 
 * Open system file dialog and add selected images
 */
async function openFileDialog() {
  if (isProcessing) return
  const result = await window.electronAPI.openFileDialog()
  if (result && result.success && result.filePaths) {
    await addImageFiles(result.filePaths)
  }
}

/**
 * Handle files dropped onto the drop zone (DataTransferItemList)
 * @param {DataTransferItemList} items
 */
async function handleDroppedItems(items) {
  if (isProcessing) return
  /** @type {string[]} */
  const filePaths = []
  for (const item of items) {
    if (item.kind === 'file') {
      const file = item.getAsFile()
      if (file && isImageFile(file.name)) {
        // In Electron, File objects from drag-drop have a .path property
        const p = file.path
        if (p) filePaths.push(p)
      }
    }
  }
  await addImageFiles(filePaths)
}

/**
 * Add image file paths to imageList (dedup by path)
 * @param {string[]} filePaths
 */
async function addImageFiles(filePaths) {
  const validPaths = filePaths.filter(p => isImageFile(p))
  if (validPaths.length === 0) {
    showToast('没有有效的图片文件', 'error')
    return
  }

  let added = 0
  for (const p of validPaths) {
    // Dedup
    if (imageList.some(img => img.path === p)) continue
    imageList.push({ id: generateId(), path: p, dataUrl: null })
    added++
  }

  if (added === 0) {
    showToast('所选图片已全部在列表中', 'error')
    return
  }

  setStatus(`已添加 ${added} 张图片，正在加载缩略图...`)

  // Load thumbnails in background
  await loadThumbnails()
  renderThumbs()
  updateStartBtn()
  setStatus(`就绪，共 ${imageList.length} 张图片`)
}

/**
 * Load data URLs for thumbnails that don't have one yet
 */
async function loadThumbnails() {
  for (const img of imageList) {
    if (img.dataUrl) continue
    const result = await window.electronAPI.readImageAsBase64(img.path)
    if (result && result.success) {
      img.dataUrl = result.data
    } else {
      img.dataUrl = null
    }
  }
}

/**
 * @param {string} fileName
 * @returns {boolean}
 */
function isImageFile(fileName) {
  return /\.(jpe?g|png|gif|webp|bmp)$/i.test(fileName)
}

/* ─────────────────────────────────────────
   Thumbnail Rendering & Drag-sort
───────────────────────────────────────── */
function renderThumbs() {
  thumbGrid.innerHTML = ''
  imageCountEl.textContent = String(imageList.length)

  imageList.forEach((img, index) => {
    const item = document.createElement('div')
    item.className = 'thumb-item'
    item.dataset.index = String(index)
    item.draggable = true

    if (img.dataUrl) {
      const imgEl = document.createElement('img')
      imgEl.src = img.dataUrl
      imgEl.alt = `图片 ${index + 1}`
      item.appendChild(imgEl)
    } else {
      // Placeholder for failed loads
      item.style.background = 'var(--bg-card)'
      item.style.display = 'flex'
      item.style.alignItems = 'center'
      item.style.justifyContent = 'center'
      item.style.color = 'var(--text-muted)'
      item.style.fontSize = '22px'
      item.textContent = '❌'
    }

    // Index label
    const label = document.createElement('div')
    label.className = 'thumb-index'
    label.textContent = String(index + 1)
    item.appendChild(label)

    // Delete button
    const del = document.createElement('button')
    del.className = 'thumb-del'
    del.title = '删除'
    del.textContent = '×'
    del.addEventListener('click', (e) => {
      e.stopPropagation()
      removeImage(index)
    })
    item.appendChild(del)

    // Drag sort events
    item.addEventListener('dragstart', (e) => onThumbDragStart(e, index))
    item.addEventListener('dragover', (e) => onThumbDragOver(e, index))
    item.addEventListener('dragleave', () => onThumbDragLeave(index))
    item.addEventListener('drop', (e) => onThumbDrop(e, index))
    item.addEventListener('dragend', () => onThumbDragEnd())

    thumbGrid.appendChild(item)
  })
}

/**
 * Remove image at index
 * @param {number} index
 */
function removeImage(index) {
  imageList.splice(index, 1)
  renderThumbs()
  updateStartBtn()
  setStatus(imageList.length > 0 ? `就绪，共 ${imageList.length} 张图片` : '就绪')
}

// ── Drag Sort Handlers ──

function onThumbDragStart(e, index) {
  dragSrcIndex = index
  e.dataTransfer.effectAllowed = 'move'
  setTimeout(() => {
    const items = thumbGrid.querySelectorAll('.thumb-item')
    if (items[index]) items[index].classList.add('drag-src')
  }, 0)
}

function onThumbDragOver(e, index) {
  e.preventDefault()
  e.dataTransfer.dropEffect = 'move'
  if (index === dragSrcIndex) return
  const items = thumbGrid.querySelectorAll('.thumb-item')
  items.forEach(i => i.classList.remove('drag-target'))
  if (items[index]) items[index].classList.add('drag-target')
}

function onThumbDragLeave(index) {
  const items = thumbGrid.querySelectorAll('.thumb-item')
  if (items[index]) items[index].classList.remove('drag-target')
}

function onThumbDrop(e, targetIndex) {
  e.preventDefault()
  if (dragSrcIndex === -1 || dragSrcIndex === targetIndex) return

  // Reorder imageList
  const moved = imageList.splice(dragSrcIndex, 1)[0]
  imageList.splice(targetIndex, 0, moved)

  renderThumbs()
  updateStartBtn()
}

function onThumbDragEnd() {
  dragSrcIndex = -1
  thumbGrid.querySelectorAll('.thumb-item').forEach(i => {
    i.classList.remove('drag-src', 'drag-target')
  })
}

/* ─────────────────────────────────────────
   Recognition Logic
───────────────────────────────────────── */

/**
 * Main entry point: batch-process all images via Minimax API
 */
async function startRecognition() {
  const apiKey = apiKeyInput.value.trim()
  if (!apiKey) {
    showToast('请先填写 API Key', 'error')
    apiKeyInput.focus()
    return
  }

  if (imageList.length === 0) {
    showToast('请先添加截图', 'error')
    return
  }

  isProcessing = true
  setProcessingUI(true)

  // Ensure all thumbnails (base64) are loaded
  await loadThumbnails()

  const totalImages = imageList.length
  const totalBatches = Math.ceil(totalImages / BATCH_SIZE)
  let collectedMd = mdContent ? mdContent + '\n\n---\n\n' : ''

  setProgress(0, totalBatches)
  setStatus('开始识别...')

  try {
    for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
      const start = batchIdx * BATCH_SIZE
      const end = Math.min(start + BATCH_SIZE, totalImages)
      const batch = imageList.slice(start, end)

      setStatus(`正在处理第 ${batchIdx + 1} / ${totalBatches} 批（第 ${start + 1}–${end} 张）...`)

      // Filter images that loaded successfully
      const validBase64 = batch
        .map(img => img.dataUrl)
        .filter(d => d !== null)

      if (validBase64.length === 0) {
        setStatus(`第 ${batchIdx + 1} 批图片加载失败，跳过`)
        setProgress(batchIdx + 1, totalBatches)
        continue
      }

      const result = await window.electronAPI.callMinimaxAPI(apiKey, validBase64)

      if (!result.success) {
        throw new Error(result.error || 'API 调用失败')
      }

      const apiResponse = result.data

      // Extract text from response
      const text = extractTextFromAPIResponse(apiResponse)
      if (text) {
        collectedMd += text + '\n\n'
      } else {
        // Check for API error
        if (apiResponse.error) {
          throw new Error(`API 错误: ${apiResponse.error.message || JSON.stringify(apiResponse.error)}`)
        }
        collectedMd += `<!-- 第 ${batchIdx + 1} 批未提取到内容 -->\n\n`
      }

      setProgress(batchIdx + 1, totalBatches)
    }

    // Trim trailing whitespace
    collectedMd = collectedMd.trim()

    // Update editor and preview
    mdContent = collectedMd
    mdEditor.value = collectedMd
    renderPreview()

    setStatus(`✅ 识别完成，共处理 ${totalImages} 张图片`)
    showToast('识别完成！', 'success')

    // Switch to preview mode
    setViewMode('preview')

  } catch (err) {
    setStatus(`❌ 识别失败：${err.message}`)
    showToast(`识别失败：${err.message}`, 'error')
  } finally {
    isProcessing = false
    setProcessingUI(false)
    hideProgress()
  }
}

/**
 * Extract the assistant's text content from Minimax API response
 * @param {object} apiResponse
 * @returns {string}
 */
function extractTextFromAPIResponse(apiResponse) {
  try {
    if (apiResponse && apiResponse.choices && apiResponse.choices.length > 0) {
      const choice = apiResponse.choices[0]
      if (choice.message && choice.message.content) {
        const content = choice.message.content
        if (typeof content === 'string') return content.trim()
        if (Array.isArray(content)) {
          // Some models return content as an array of parts
          return content
            .filter(p => p.type === 'text')
            .map(p => p.text)
            .join('\n')
            .trim()
        }
      }
    }
  } catch (e) {
    console.error('extractTextFromAPIResponse error:', e)
  }
  return ''
}

/* ─────────────────────────────────────────
   Markdown View Mode
───────────────────────────────────────── */

/**
 * @param {'edit'|'preview'} mode
 */
function setViewMode(mode) {
  viewMode = mode

  if (mode === 'edit') {
    btnEdit.classList.add('active')
    btnPreview.classList.remove('active')
    mdEditor.style.display = 'block'
    mdPreview.style.display = 'none'
    emptyState.style.display = 'none'
  } else {
    btnEdit.classList.remove('active')
    btnPreview.classList.add('active')
    mdEditor.style.display = 'none'
    renderPreview()
  }
}

/**
 * Render Markdown to preview pane
 */
function renderPreview() {
  const content = mdEditor.value || mdContent

  if (!content.trim()) {
    mdPreview.style.display = 'none'
    emptyState.style.display = viewMode === 'preview' ? 'flex' : 'none'
    return
  }

  emptyState.style.display = 'none'

  if (viewMode === 'preview') {
    mdPreview.style.display = 'block'
  }

  if (window.marked) {
    mdPreview.innerHTML = window.marked.parse(content)
  } else {
    // Fallback if CDN fails
    mdPreview.textContent = content
  }
}

/* ─────────────────────────────────────────
   Export
───────────────────────────────────────── */

async function exportMarkdown() {
  const content = mdEditor.value || mdContent
  if (!content.trim()) {
    showToast('暂无内容可导出', 'error')
    return
  }

  const result = await window.electronAPI.saveMDFile(content)
  if (result && result.success) {
    showToast(`已保存至：${result.filePath}`, 'success')
    setStatus(`已导出：${result.filePath}`)
  } else if (result && result.canceled) {
    // User canceled, do nothing
  } else {
    showToast(`导出失败：${result ? result.error : '未知错误'}`, 'error')
  }
}

/* ─────────────────────────────────────────
   UI Utilities
───────────────────────────────────────── */

function updateStartBtn() {
  startBtn.disabled = isProcessing || imageList.length === 0
}

function setProcessingUI(processing) {
  startBtn.disabled = processing
  startBtn.textContent = processing ? '⏳ 识别中...' : '▶ 开始识别'
  clearImgBtn.disabled = processing
}

/**
 * @param {string} msg
 */
function setStatus(msg) {
  statusText.textContent = msg
}

/**
 * @param {number} current
 * @param {number} total
 */
function setProgress(current, total) {
  progressWrap.classList.add('visible')
  const pct = total > 0 ? Math.round((current / total) * 100) : 0
  progressFill.style.width = `${pct}%`
  progressLabel.textContent = `${current} / ${total} 批`
}

function hideProgress() {
  progressWrap.classList.remove('visible')
  progressFill.style.width = '0%'
}

let toastTimer = null

/**
 * Show a brief toast notification
 * @param {string} message
 * @param {'default'|'success'|'error'} type
 */
function showToast(message, type = 'default') {
  toast.textContent = message
  toast.className = 'show ' + (type !== 'default' ? type : '')
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toast.className = ''
  }, 3000)
}

/* ─────────────────────────────────────────
   Helpers
───────────────────────────────────────── */

/**
 * Generate a simple unique ID
 * @returns {string}
 */
function generateId() {
  return Math.random().toString(36).slice(2, 10)
}

/* ─────────────────────────────────────────
   Bootstrap
───────────────────────────────────────── */
init()
