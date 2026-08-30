const state = {
  task: null, tasks: [], settings: null, stage: 'materials', showLibrary: true,
  jobId: '', jobStage: '', selectedImages: new Set(), selectedGroupId: '',
  imageData: new Map(), preview: false, reviewFilter: 'all',
  saveTimer: null, pendingPatch: null, copyOcrToLlm: false
}

const esc = value => String(value || '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]))
const unwrap = result => { if (!result?.success) throw new Error(result?.error || '操作失败'); return result.data }
const bytes = value => value < 1048576 ? `${Math.max(1, Math.ceil((value || 0) / 1024))} KB` : `${((value || 0) / 1048576).toFixed(1)} MB`
const icon = name => `<i data-lucide="${name}"></i>`
const imageById = id => state.task?.images.find(image => image.id === id)
const processing = () => !!state.jobId || state.task?.status === 'processing'
const groupId = () => crypto.randomUUID()

function renderIcons(root = document) {
  if (window.lucide?.createIcons) window.lucide.createIcons({ root, attrs: { 'stroke-width': 1.8, 'aria-hidden': 'true' } })
}
function notice(message, kind = '') {
  const toast = $('toast')
  toast.textContent = message
  toast.className = `toast show ${kind}`
  clearTimeout(toast._timer)
  toast._timer = setTimeout(() => { toast.className = 'toast' }, 3200)
}
function status(message, kind = '') {
  $('status-text').textContent = message
  $('status-dot').className = `status-dot ${kind}`
}
function safeMarkdown(value) {
  const template = document.createElement('template')
  const parse = typeof marked.parse === 'function' ? marked.parse.bind(marked) : marked
  template.innerHTML = parse(value || '')
  template.content.querySelectorAll('script,style,iframe,object,embed,link,meta,base,form').forEach(node => node.remove())
  template.content.querySelectorAll('*').forEach(node => {
    for (const attribute of [...node.attributes]) {
      const name = attribute.name.toLowerCase()
      const content = attribute.value.trim().toLowerCase()
      if (name.startsWith('on') || (['href', 'src', 'xlink:href'].includes(name) && /^(javascript|data:text\/html)/.test(content))) node.removeAttribute(attribute.name)
    }
  })
  return template.innerHTML
}
function currentImage() { return imageById(state.task?.selectedImageId) || state.task?.images[0] }
function baseGroup(image, index) {
  return { id: `single-${image.id}`, type: 'single', imageIds: [image.id], title: `摘录 ${index + 1}`, titleMode: 'auto', source: 'manual', organizeStatus: 'pending', markdown: '', error: '' }
}
function groups() {
  const images = state.task?.images || []
  const existing = state.task?.groups?.length ? state.task.groups : []
  if (!existing.length) return images.map(baseGroup)
  const assigned = new Set(existing.flatMap(group => group.imageIds || []))
  return [...existing, ...images.filter(image => !assigned.has(image.id)).map((image, index) => baseGroup(image, existing.length + index))]
}
function imageGroup(imageId) { return groups().find(group => group.imageIds.includes(imageId)) }
function imageGroupLabel(imageId) {
  const group = imageGroup(imageId)
  return group?.type === 'article' ? `${group.title} · ${group.imageIds.indexOf(imageId) + 1}/${group.imageIds.length}` : '独立摘录'
}
function listingStage(task) {
  if (Workflow.STAGES.includes(task.uiStage)) return task.uiStage
  if (task.stage === 'result') return 'export'
  if (['ocr', 'edit', 'review'].includes(task.stage)) return 'review'
  return 'materials'
}
function mergePatch(base, incoming) {
  const merged = { ...(base || {}), ...incoming }
  if (base?.imageUpdates || incoming.imageUpdates) {
    const updates = new Map()
    for (const update of [...(base?.imageUpdates || []), ...(incoming.imageUpdates || [])]) updates.set(update.id, { ...(updates.get(update.id) || {}), ...update })
    merged.imageUpdates = [...updates.values()]
  }
  return merged
}
async function flushSave() {
  clearTimeout(state.saveTimer)
  state.saveTimer = null
  const patch = state.pendingPatch
  state.pendingPatch = null
  if (!patch || !state.task) return
  const taskId = state.task.id
  try {
    const updated = unwrap(await window.electronAPI.updateTask(taskId, patch))
    if (state.task?.id === taskId) state.task = updated
    $('autosave-state').textContent = '已自动保存'
  } catch (error) {
    $('autosave-state').textContent = '保存失败'
    notice(error.message, 'error')
  }
}
function debounceSave(patch) {
  state.pendingPatch = mergePatch(state.pendingPatch, patch)
  $('autosave-state').textContent = '正在保存…'
  clearTimeout(state.saveTimer)
  state.saveTimer = setTimeout(flushSave, 500)
}
async function saveTask(patch, redraw = true) {
  await flushSave()
  state.task = unwrap(await window.electronAPI.updateTask(state.task.id, patch))
  if (redraw) renderAll()
  return state.task
}
async function refreshTasks(render = true) {
  const data = unwrap(await window.electronAPI.listTasks())
  state.tasks = data.tasks
  if (render) renderAll()
}
async function loadTask(id) {
  await flushSave()
  state.task = unwrap(await window.electronAPI.loadTask(id))
  state.stage = Workflow.stageForTask(state.task)
  state.showLibrary = false
  state.selectedImages.clear()
  state.selectedGroupId = ''
  state.imageData.clear()
  state.preview = false
  state.reviewFilter = 'all'
  closeTaskDrawer()
  renderAll()
}
function renderAll() {
  renderHeaderStatus()
  $('library-view').classList.toggle('hidden', !state.showLibrary)
  $('workspace-view').classList.toggle('hidden', state.showLibrary)
  if (state.showLibrary) renderLibrary()
  else if (state.task) {
    renderWorkspaceHeader()
    renderSteps()
    renderSourcePanel()
    renderStage()
    renderActions()
  }
  renderTaskDrawer()
  renderIcons()
}
function renderHeaderStatus() {
  const ocrReady = state.settings?.ocrApi.hasApiKey
  const llmReady = state.settings?.llmApi.hasApiKey
  const label = ocrReady && llmReady ? 'OCR 与整理已连接' : ocrReady ? 'OCR 已连接' : 'API 未配置'
  $('api-status').innerHTML = `${icon(ocrReady ? 'circle-check' : 'circle-alert')}<span>${label}</span>`
  $('api-status').classList.toggle('ready', !!ocrReady)
}
function renderLibrary() {
  const total = state.tasks.reduce((sum, task) => sum + (task.storageBytes || 0), 0)
  $('library-storage').textContent = state.tasks.length ? `${state.tasks.length} 个任务 · 已使用 ${bytes(total)}` : '历史任务会保留在本机'
  $('library-task-list').innerHTML = state.tasks.length ? state.tasks.map(task => {
    const stage = listingStage(task)
    const meta = Workflow.STAGE_META[stage]
    const stateLabel = task.status === 'processing' ? '处理中' : `第 ${meta.number} 步 · ${meta.label}`
    return `<button class="library-task-card" data-library-task="${task.id}">
      <span class="task-accent ${stage}"></span>
      <span class="task-card-top"><b>${esc(task.name)}</b><em>${stateLabel}</em></span>
      <span class="task-card-meta">${icon('images')}${task.imageCount} 张截图 · ${task.completeCount} 张已识别</span>
      <span class="task-progress"><i style="width: ${meta.number * 25}%"></i></span>
      <span class="task-card-foot"><small>${bytes(task.storageBytes || 0)}</small><strong>继续处理 ${icon('arrow-right')}</strong></span>
    </button>`
  }).join('') : `<div class="library-empty"><span class="empty-mark">句</span><h3>从第一批截图开始</h3><p>导入后会自动创建任务，原始截图和处理结果都保存在本机。</p><button id="library-empty-import" class="btn primary">${icon('image-plus')}选择截图</button></div>`
  document.querySelectorAll('[data-library-task]').forEach(button => { button.onclick = () => loadTask(button.dataset.libraryTask) })
  if ($('library-empty-import')) $('library-empty-import').onclick = () => importImages({ newTask: true })
}
function renderWorkspaceHeader() {
  $('task-title').disabled = !state.task || processing()
  $('task-title').value = state.task?.name || '未创建任务'
  $('autosave-state').textContent = state.task ? '本机自动保存' : ''
  $('delete-task-btn').disabled = !state.task || processing()
  $('add-images-btn').disabled = processing()
}
function renderSteps() {
  document.querySelectorAll('[data-stage]').forEach(step => {
    const stage = step.dataset.stage
    const phaseState = Workflow.stageState(state.task, stage, state.stage)
    const access = Workflow.stageAccess(state.task, stage, { allowImageFailures: true })
    step.className = `step ${phaseState}`
    step.disabled = processing() || phaseState === 'locked'
    step.title = access.allowed ? '' : access.reason
    step.querySelector('span').innerHTML = phaseState === 'complete' ? icon('check') : Workflow.STAGE_META[stage].number
  })
}
function stageIntro(eyebrow, title, description, aside = '') {
  return `<header class="stage-head"><div><span class="eyebrow">${eyebrow}</span><h1>${title}</h1><p>${description}</p></div>${aside}</header>`
}
function sourcePanelHeader(eyebrow, title, badge) {
  return `<header class="source-head"><div><span class="eyebrow">${eyebrow}</span><h2>${title}</h2></div><span class="pill">${badge}</span></header>`
}

function imageStatusLabel(image) {
  return image.status === 'success' ? '已识别' : image.status === 'error' ? '失败' : image.status === 'processing' ? '处理中' : '待识别'
}
function imageRowMarkup(image, index, options = {}) {
  const canDrag = !!options.canDrag
  const canSelect = !!options.canSelect
  return `<article draggable="${canDrag}" class="image-row ${image.id === currentImage()?.id ? 'selected' : ''} ${options.grouped ? 'grouped' : ''}" data-image="${image.id}" data-index="${index}">
    ${canSelect ? `<input class="image-check" type="checkbox" data-check="${image.id}" ${state.selectedImages.has(image.id) ? 'checked' : ''}>` : ''}
    <span class="image-number">${index + 1}</span>
    <div class="image-copy"><strong>${esc(image.name)}</strong><small>${esc(imageGroupLabel(image.id))}</small></div>
    <span class="image-state ${image.status}">${imageStatusLabel(image)}</span>
    ${canDrag ? `<span class="image-sort-handle" draggable="true" title="拖动排序">${icon('grip-vertical')}</span>` : ''}
    <span class="image-group-drop-hint">${icon('combine')}松开并分组</span>
  </article>`
}
function imageListMarkup(canDrag) {
  const emittedGroups = new Set()
  return state.task.images.map((image, index) => {
    const group = imageGroup(image.id)
    if (group?.type !== 'article') return imageRowMarkup(image, index, { canDrag, canSelect: canDrag })
    if (emittedGroups.has(group.id)) return ''
    emittedGroups.add(group.id)
    const pages = group.imageIds.map(imageById).filter(Boolean)
    const rows = pages.map(page => imageRowMarkup(page, state.task.images.findIndex(item => item.id === page.id), { canDrag, canSelect: canDrag, grouped: true })).join('')
    return `<section class="image-group-frame ${state.selectedGroupId === group.id ? 'selected-group' : ''}" data-group-frame="${group.id}" data-group-last="${pages.at(-1)?.id || ''}">
      <header><div><span>${icon('layers-3')}文章组 · ${pages.length} 张</span><input data-sidebar-group-title="${group.id}" value="${esc(group.title)}" aria-label="文章组名称"></div><button data-sidebar-dissolve="${group.id}" title="解散文章组">${icon('ungroup')}</button></header>
      <div class="image-group-rows">${rows}</div><span class="group-frame-drop-hint">${icon('combine')}松开并加入此组</span>
    </section>`
  }).join('')
}
function renderSourcePanel() {
  if (state.stage === 'materials') return renderMaterialSource()
  if (state.stage === 'review') return renderReviewSource()
  if (state.stage === 'organize') return renderOrganizeSource()
  renderExportSource()
}
function renderMaterialSource() {
  $('source-panel').innerHTML = `${sourcePanelHeader('SOURCES', '截图素材', `${state.task.images.length} 张`)}
    <button id="source-drop" class="source-drop">${icon('image-plus')}<span><strong>添加更多截图</strong><small>点击选择，或直接拖入这里</small></span></button>
    <div class="source-tip">${icon('info')}拖动截图可分组，拖动手柄可排序</div>
    <div id="image-list" class="image-list grouping-enabled">${imageListMarkup(!processing()) || '<div class="list-empty">还没有截图</div>'}</div>`
  $('source-drop').onclick = importImages
  bindFileDrop($('source-drop'))
  bindMaterialRows()
}
function filteredReviewImages() {
  const images = state.task?.images || []
  if (state.reviewFilter === 'all') return images
  return images.filter(image => image.status === state.reviewFilter)
}
function renderReviewSource() {
  const summary = Workflow.imageSummary(state.task)
  const filters = [['all', '全部', summary.total], ['pending', '待识别', summary.pending], ['error', '失败', summary.error], ['success', '已完成', summary.success]]
  const images = filteredReviewImages()
  $('source-panel').innerHTML = `${sourcePanelHeader('REVIEW QUEUE', '校对队列', `${summary.success}/${summary.total}`)}
    <div class="source-filters">${filters.map(([key, label, count]) => `<button data-review-filter="${key}" class="${state.reviewFilter === key ? 'active' : ''}">${label}<span>${count}</span></button>`).join('')}</div>
    <div id="image-list" class="image-list">${images.map(image => imageRowMarkup(image, state.task.images.indexOf(image))).join('') || '<div class="list-empty">此筛选下没有截图</div>'}</div>`
  document.querySelectorAll('[data-review-filter]').forEach(button => { button.onclick = () => { state.reviewFilter = button.dataset.reviewFilter; renderAll() } })
  bindSelectableRows()
}
function renderOrganizeSource() {
  const allGroups = groups()
  $('source-panel').innerHTML = `${sourcePanelHeader('ARTICLE GROUPS', '文章组', `${allGroups.length} 组`)}
    <div class="group-nav-list">${allGroups.map((group, index) => `<button data-organize-group="${group.id}" class="group-nav-item ${state.selectedGroupId === group.id ? 'active' : ''}">
      <span class="group-index">${index + 1}</span><span><strong>${esc(group.title)}</strong><small>${group.imageIds.length} 张 · ${group.organizeStatus === 'success' ? '已完成' : group.organizeStatus === 'error' ? '失败' : group.organizeStatus === 'processing' ? '处理中' : '待整理'}</small></span><i class="group-dot ${group.organizeStatus}"></i>
    </button>`).join('')}</div>`
  document.querySelectorAll('[data-organize-group]').forEach(button => { button.onclick = () => { state.selectedGroupId = button.dataset.organizeGroup; renderStage(); renderIcons($('stage-content')) } })
}
function renderExportSource() {
  const allGroups = groups()
  const completed = allGroups.filter(group => group.organizeStatus === 'success').length
  $('source-panel').innerHTML = `${sourcePanelHeader('DOCUMENT', '文稿结构', `${completed}/${allGroups.length}`)}
    <div class="document-outline">${allGroups.map(group => `<div class="outline-item ${group.organizeStatus}">${icon(group.organizeStatus === 'success' ? 'circle-check' : group.organizeStatus === 'error' ? 'circle-alert' : 'circle-dashed')}<span><strong>${esc(group.title)}</strong><small>${group.imageIds.length} 张截图</small></span></div>`).join('')}</div>
    <div class="source-document-note">${icon('hard-drive')}文稿修改会自动保存到当前任务</div>`
}
function renderStage() {
  const target = $('stage-content')
  if (state.stage === 'materials') return renderMaterials(target)
  if (state.stage === 'review') return renderReview(target)
  if (state.stage === 'organize') return renderOrganize(target)
  renderExport(target)
}
function renderMaterials(target) {
  const allGroups = groups()
  const articles = allGroups.filter(group => group.type === 'article')
  const singles = allGroups.filter(group => group.type !== 'article')
  const selected = [...state.selectedImages]
  const active = allGroups.find(group => group.id === state.selectedGroupId) || imageGroup(currentImage()?.id) || allGroups[0]
  if (active) state.selectedGroupId = active.id
  target.innerHTML = `${stageIntro('第 1 步 · 准备处理素材', '整理截图与文章关系', '先确认顺序。属于同一篇长文的连续截图可以合并为一个文章组。', `<div class="stage-stats"><span><b>${articles.length}</b>文章组</span><span><b>${singles.length}</b>独立摘录</span></div>`)}
    <div class="selection-toolbar"><span>${icon('check-square')}已选 <b>${selected.length}</b> 张</span><button id="create-group" class="btn primary small" ${selected.length < 2 ? 'disabled' : ''}>${icon('combine')}创建文章组</button><button id="ungroup-selected" class="btn secondary small" ${selected.length ? '' : 'disabled'}>${icon('ungroup')}移出文章组</button></div>
    <div class="material-layout">
      <section class="group-board"><header><span class="eyebrow">GROUPS</span><h2>当前结构</h2></header><div class="group-board-list">${allGroups.map((group, index) => `<button data-board-group="${group.id}" class="group-board-card ${active?.id === group.id ? 'active' : ''}"><span class="board-number">${String(index + 1).padStart(2, '0')}</span><span><strong>${esc(group.title)}</strong><small>${group.type === 'article' ? '文章组' : '独立摘录'} · ${group.imageIds.length} 张</small></span>${icon('chevron-right')}</button>`).join('')}</div></section>
      <section class="group-preview-panel"><div class="group-preview-head"><div><span class="eyebrow">GROUP PREVIEW</span><h2>${esc(active?.title || '选择一个文章组')}</h2></div><div class="preview-head-actions">${active?.type === 'article' ? `<button data-main-dissolve="${active.id}" class="btn text small">${icon('ungroup')}解散</button>` : ''}<span class="pill">${active?.imageIds.length || 0} 张</span></div></div>
        ${active?.type === 'article' ? `<label class="group-title-field"><span>文章标题</span><input id="active-group-title" value="${esc(active.title)}"></label>` : ''}
        <div id="group-preview-grid" class="group-preview-grid">${active ? active.imageIds.map(id => `<button class="group-preview-item" data-preview-image="${id}"><span>${icon('image')}正在读取截图…</span></button>`).join('') : '<div class="group-preview-empty">从左侧选择截图开始</div>'}</div>
      </section>
    </div>`
  $('create-group').onclick = createArticleGroup
  $('ungroup-selected').onclick = ungroupSelected
  document.querySelectorAll('[data-board-group]').forEach(button => { button.onclick = () => selectGroup(button.dataset.boardGroup) })
  if ($('active-group-title')) $('active-group-title').onchange = () => renameGroup(active.id, $('active-group-title').value)
  const dissolve = document.querySelector('[data-main-dissolve]')
  if (dissolve) dissolve.onclick = () => dissolveGroup(dissolve.dataset.mainDissolve)
  if (active) loadGroupPreviewImages(active)
}
function renderReview(target) {
  const image = currentImage()
  if (!image) return goStage('materials')
  const summary = Workflow.imageSummary(state.task)
  const images = filteredReviewImages()
  let currentIndex = images.findIndex(item => item.id === image.id)
  if (currentIndex < 0 && images[0]) { state.task.selectedImageId = images[0].id; return renderReview(target) }
  target.innerHTML = `${stageIntro('第 2 步 · 提取并修正原文', '识别与校对', '识别结果可以直接修改；处理失败的截图会保留在队列中，不会被自动跳过。', `<div class="ocr-summary"><span>${icon('circle-check')}${summary.success} 完成</span><span class="${summary.error ? 'has-error' : ''}">${icon('circle-alert')}${summary.error} 失败</span></div>`)}
    <div class="review-toolbar"><div><strong>${esc(image.name)}</strong><span>${esc(imageGroupLabel(image.id))}</span></div><div class="review-nav"><button id="review-prev" class="square-btn" ${currentIndex <= 0 ? 'disabled' : ''}>${icon('chevron-left')}</button><span>${currentIndex + 1} / ${images.length}</span><button id="review-next" class="square-btn" ${currentIndex >= images.length - 1 ? 'disabled' : ''}>${icon('chevron-right')}</button></div></div>
    <div class="review-grid"><section class="source-card"><div class="card-label"><span>${icon('image')}原始截图</span><button id="view-full-image" class="card-text-button" disabled>查看完整截图 ${icon('expand')}</button></div><div id="image-preview" class="image-preview">正在读取原图…</div></section>
      <section class="ocr-card"><div class="card-label"><span>${icon('file-pen-line')}OCR 原文</span><span class="status-note ${image.status}">${image.status === 'success' ? '可直接修改' : image.status === 'error' ? esc(image.error) : image.status === 'processing' ? '正在识别' : '等待识别'}</span></div><textarea id="ocr-editor" ${processing() ? 'disabled' : ''} placeholder="识别结果会显示在这里，也可以手动输入。">${esc(image.ocrText)}</textarea><footer class="editor-foot"><span id="ocr-char-count">${image.ocrText.length} 字符 · 自动保存</span><button id="retry-one" class="btn secondary small" ${processing() ? 'disabled' : ''}>${icon('rotate-ccw')}重新识别此张</button></footer></section>
    </div>`
  $('ocr-editor').oninput = event => {
    image.ocrText = event.target.value
    $('ocr-char-count').textContent = `${image.ocrText.length} 字符 · 正在保存`
    const previousMarkdown = state.task.markdown || state.task.previousMarkdown || ''
    const resetGroups = groups().map(group => group.imageIds.includes(image.id) ? { ...group, organizeStatus: 'pending', markdown: '', error: '' } : group)
    state.task.groups = resetGroups
    state.task.markdown = ''
    state.task.previousMarkdown = previousMarkdown
    debounceSave({ imageUpdates: [{ id: image.id, ocrText: image.ocrText }], groups: resetGroups, markdown: '', previousMarkdown })
  }
  $('retry-one').onclick = () => startOCR([image.id])
  $('review-prev').onclick = () => selectReviewOffset(-1)
  $('review-next').onclick = () => selectReviewOffset(1)
  loadImagePreview(image)
}

function groupTextPreview(group) {
  return group.imageIds.map(imageById).filter(Boolean).map(image => image.ocrText || '').join('\n').trim()
}
function renderOrganize(target) {
  const allGroups = groups()
  const failed = allGroups.filter(group => group.organizeStatus === 'error')
  const complete = allGroups.filter(group => group.organizeStatus === 'success')
  target.innerHTML = `${stageIntro('第 3 步 · 逐篇生成文稿', '内容整理', '每个文章组会独立整理、保存和重试；失败不会影响已经完成的内容。', `<div class="stage-stats"><span><b>${complete.length}</b>已完成</span><span class="${failed.length ? 'error' : ''}"><b>${failed.length}</b>失败</span></div>`)}
    ${failed.length ? `<div class="stage-callout error">${icon('circle-alert')}<div><strong>有 ${failed.length} 个文章组整理失败</strong><span>可以单独重试，也可以使用已经完成的部分继续导出。</span></div></div>` : ''}
    <div class="organize-list">${allGroups.map((group, index) => {
      const text = groupTextPreview(group)
      return `<article class="organize-card ${group.organizeStatus}"><span class="organize-index">${String(index + 1).padStart(2, '0')}</span><div class="organize-copy"><div><strong>${esc(group.title)}</strong><span>${group.imageIds.length} 张截图 · ${text.length} 字符</span></div><p>${esc(text.slice(0, 150)) || '这个文章组还没有可整理的文字。'}</p>${group.error ? `<small>${esc(group.error)}</small>` : ''}</div><div class="organize-state">${icon(group.organizeStatus === 'success' ? 'circle-check' : group.organizeStatus === 'error' ? 'circle-alert' : group.organizeStatus === 'processing' ? 'loader-circle' : 'circle-dashed')}<span>${group.organizeStatus === 'success' ? '已完成' : group.organizeStatus === 'error' ? '整理失败' : group.organizeStatus === 'processing' ? '正在整理' : '等待整理'}</span>${group.organizeStatus === 'error' ? `<button data-retry-group="${group.id}" class="btn secondary small">重试</button>` : ''}</div></article>`
    }).join('')}</div>`
  document.querySelectorAll('[data-retry-group]').forEach(button => { button.onclick = () => organize([button.dataset.retryGroup]) })
}
function renderExport(target) {
  const allGroups = groups()
  const content = state.task.markdown || ''
  const failed = allGroups.filter(group => group.organizeStatus === 'error')
  const documentView = state.preview ? `<div id="markdown-preview" class="markdown-preview">${safeMarkdown(content) || '<p class="markdown-empty">还没有可预览的内容</p>'}</div>` : `<textarea id="markdown-editor" placeholder="整理后的 Markdown 将显示在这里">${esc(content)}</textarea>`
  target.innerHTML = `${stageIntro('第 4 步 · 检查并保存文稿', '导出 Markdown', '最后检查文稿，复制到剪贴板或保存为本地 .md 文件。', `<div class="result-tools"><div class="result-view-switch"><button id="show-markdown-source" class="${state.preview ? '' : 'active'}">原文</button><button id="show-markdown-preview" class="${state.preview ? 'active' : ''}">解析预览</button></div><button id="copy-md" class="btn secondary small">${icon('copy')}复制</button><button id="undo-md" class="btn text small" ${state.task.previousMarkdown ? '' : 'disabled'}>${icon('undo-2')}撤销整理</button></div>`)}
    ${failed.length ? `<div class="stage-callout warning">${icon('triangle-alert')}<div><strong>当前文稿缺少 ${failed.length} 个失败文章组</strong><span>返回内容整理可重试缺失部分。</span></div></div>` : ''}
    <div class="markdown-box ${state.preview ? 'preview-mode' : ''}">${documentView}</div>`
  $('show-markdown-source').onclick = () => { state.preview = false; renderStage(); renderIcons($('stage-content')) }
  $('show-markdown-preview').onclick = () => { state.preview = true; renderStage(); renderIcons($('stage-content')) }
  $('copy-md').onclick = async () => { try { await navigator.clipboard.writeText(content); notice('已复制 Markdown', 'success') } catch { notice('复制失败，请手动复制', 'error') } }
  $('undo-md').onclick = async () => { try { state.task = unwrap(await window.electronAPI.undoOrganize(state.task.id)); renderAll() } catch (error) { notice(error.message, 'error') } }
  const editor = $('markdown-editor')
  if (editor) editor.oninput = event => { state.task.markdown = event.target.value; debounceSave({ markdown: event.target.value }) }
  document.querySelectorAll('#markdown-preview a').forEach(link => { link.onclick = event => { event.preventDefault(); notice('预览中的链接不可直接打开') } })
}
function renderActions() {
  const primary = $('primary-action')
  const secondary = $('secondary-action')
  const back = $('back-action')
  const cancel = $('cancel-action')
  secondary.classList.add('hidden')
  back.classList.toggle('hidden', state.stage === 'materials' || processing())
  cancel.classList.toggle('hidden', !processing())
  back.onclick = () => goStage(Workflow.STAGES[Math.max(0, Workflow.STAGES.indexOf(state.stage) - 1)])
  if (processing()) {
    primary.textContent = state.jobStage === 'organize' ? '正在整理内容…' : '正在识别截图…'
    primary.disabled = true
    cancel.onclick = cancelJob
    return
  }
  primary.disabled = false
  const summary = Workflow.imageSummary(state.task)
  const usable = state.task.images.filter(image => image.ocrText?.trim())
  if (state.stage === 'materials') {
    if (!summary.total) { primary.textContent = '添加截图'; primary.onclick = importImages; return }
    const work = state.task.images.filter(image => image.status !== 'success')
    if (work.length) { primary.textContent = `开始识别 ${work.length} 张`; primary.onclick = () => startOCR(work.map(image => image.id)); return }
    primary.textContent = '进入识别与校对'
    primary.onclick = () => goStage('review')
    return
  }
  if (state.stage === 'review') {
    if (summary.pending) {
      primary.textContent = `开始识别 ${summary.pending} 张`
      primary.onclick = () => startOCR(state.task.images.filter(image => image.status === 'pending').map(image => image.id))
      return
    }
    if (summary.error) {
      primary.textContent = `重试失败项（${summary.error}）`
      primary.onclick = () => startOCR(state.task.images.filter(image => image.status === 'error').map(image => image.id))
      if (usable.length) {
        secondary.textContent = `忽略 ${summary.error} 张并继续`
        secondary.classList.remove('hidden')
        secondary.onclick = () => goStage('organize', { allowFailures: true })
      }
      return
    }
    primary.textContent = '完成校对，进入内容整理'
    primary.onclick = () => goStage('organize')
    return
  }
  if (state.stage === 'organize') {
    const allGroups = groups()
    const failed = allGroups.filter(group => group.organizeStatus === 'error')
    const outstanding = allGroups.filter(group => group.organizeStatus !== 'success')
    if (failed.length) {
      primary.textContent = `重试失败文章组（${failed.length}）`
      primary.onclick = () => organize(failed.map(group => group.id))
      if (String(state.task.markdown || '').trim()) {
        secondary.textContent = '使用已完成内容继续'
        secondary.classList.remove('hidden')
        secondary.onclick = () => goStage('export')
      }
      return
    }
    if (!outstanding.length && String(state.task.markdown || '').trim()) {
      primary.textContent = '查看并导出文稿'
      primary.onclick = () => goStage('export')
      return
    }
    primary.textContent = `开始整理 ${outstanding.length || allGroups.length} 个文章组`
    primary.onclick = () => organize(outstanding.length ? outstanding.map(group => group.id) : undefined)
    return
  }
  primary.textContent = '保存 Markdown'
  primary.onclick = exportMarkdown
}
async function goStage(stage, options = {}) {
  if (!state.task || processing()) return
  const access = Workflow.stageAccess(state.task, stage, options)
  if (!access.allowed) { notice(access.reason); return }
  state.stage = stage
  state.task.uiStage = stage
  const legacy = stage === 'materials' ? 'group' : stage === 'export' ? 'result' : 'edit'
  await saveTask({ uiStage: stage, stage: legacy }, false)
  renderAll()
}
async function startOCR(ids) {
  try {
    const data = unwrap(await window.electronAPI.startOCR(state.task.id, ids))
    state.jobId = data.jobId
    state.jobStage = 'ocr'
    state.stage = 'review'
    state.task.uiStage = 'review'
    renderAll()
    status('正在逐张识别截图…', 'processing')
  } catch (error) {
    notice(error.message, 'error')
    if (/未配置/.test(error.message)) openSettings()
  }
}
async function organize(groupIds) {
  try {
    const data = unwrap(await window.electronAPI.organizeTask(state.task.id, true, groupIds))
    state.jobId = data.jobId
    state.jobStage = 'organize'
    state.stage = 'organize'
    state.task.uiStage = 'organize'
    renderAll()
    status('正在逐篇整理 Markdown…', 'processing')
  } catch (error) {
    notice(error.message, 'error')
    if (/未配置/.test(error.message)) openSettings()
  }
}
async function cancelJob() {
  if (state.jobId) await window.electronAPI.cancelJob(state.jobId)
  status('正在取消，已完成内容会保留…', 'processing')
}
async function importImages(options = {}) {
  try {
    const selected = await window.electronAPI.openFileDialog()
    if (selected?.canceled) return
    if (!selected?.success) throw new Error(selected?.error || '打开文件选择器失败')
    if (!selected.filePaths?.length) return
    if (options.newTask || !state.task || state.showLibrary) {
      const name = selected.filePaths[0].split(/[\\/]/).pop().replace(/\.[^.]+$/, '')
      state.task = unwrap(await window.electronAPI.createTask(name))
    }
    state.task = unwrap(await window.electronAPI.importTaskImages(state.task.id, selected.filePaths))
    state.stage = 'materials'
    state.showLibrary = false
    state.selectedImages.clear()
    state.imageData.clear()
    await refreshTasks(false)
    renderAll()
    status(`已添加 ${selected.filePaths.length} 张截图，请确认顺序和分组`, 'success')
  } catch (error) { notice(error.message, 'error') }
}
async function createEmptyTask() {
  try {
    state.task = unwrap(await window.electronAPI.createTask('截图任务'))
    state.stage = 'materials'
    state.showLibrary = false
    await refreshTasks(false)
    renderAll()
    setTimeout(() => { $('task-title').focus(); $('task-title').select() }, 0)
  } catch (error) { notice(error.message, 'error') }
}
async function exportMarkdown() {
  await flushSave()
  const result = await window.electronAPI.saveMDFile(state.task.markdown || '')
  if (result.success) notice('Markdown 已保存', 'success')
  else if (!result.canceled) notice(result.error, 'error')
}

function bindFileDrop(target) {
  target.ondragover = event => { event.preventDefault(); target.classList.add('drag-over') }
  target.ondragleave = () => target.classList.remove('drag-over')
  target.ondrop = async event => {
    event.preventDefault()
    target.classList.remove('drag-over')
    const paths = [...event.dataTransfer.files].map(file => file.path).filter(Boolean)
    if (!paths.length) return
    try {
      state.task = unwrap(await window.electronAPI.importTaskImages(state.task.id, paths))
      state.stage = 'materials'
      state.imageData.clear()
      await refreshTasks(false)
      renderAll()
      status(`已添加 ${paths.length} 张截图`, 'success')
    } catch (error) { notice(error.message, 'error') }
  }
}
function bindSelectableRows() {
  document.querySelectorAll('[data-image]').forEach(row => { row.onclick = () => selectImage(row.dataset.image) })
}
function bindMaterialRows() {
  const canDrag = !processing()
  document.querySelectorAll('[data-image]').forEach(row => {
    row.onclick = event => { if (event.target.closest('[data-check], .image-sort-handle')) return; selectImage(row.dataset.image) }
    row.ondragstart = event => {
      if (!canDrag || event.target.closest('.image-sort-handle')) return
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('application/x-screenshot-group', row.dataset.image)
      row.classList.add('dragging')
    }
    row.ondragend = clearImageDragState
    row.ondragenter = event => showImageDropTarget(event, row)
    row.ondragover = event => showImageDropTarget(event, row)
    row.ondragleave = event => { if (!row.contains(event.relatedTarget)) row.classList.remove('group-drop-target', 'sort-drop-target') }
    row.ondrop = event => handleImageDrop(event, row)
  })
  document.querySelectorAll('.image-sort-handle').forEach(handle => {
    handle.ondragstart = event => {
      event.stopPropagation()
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('application/x-screenshot-reorder', handle.closest('[data-image]').dataset.index)
      handle.closest('[data-image]').classList.add('dragging')
    }
    handle.ondragend = clearImageDragState
  })
  document.querySelectorAll('[data-check]').forEach(box => {
    box.onchange = () => {
      box.checked ? state.selectedImages.add(box.dataset.check) : state.selectedImages.delete(box.dataset.check)
      renderStage()
      renderIcons($('stage-content'))
    }
  })
  document.querySelectorAll('[data-sidebar-group-title]').forEach(input => { input.onchange = () => renameGroup(input.dataset.sidebarGroupTitle, input.value) })
  document.querySelectorAll('[data-sidebar-dissolve]').forEach(button => { button.onclick = () => dissolveGroup(button.dataset.sidebarDissolve) })
  document.querySelectorAll('[data-group-frame]').forEach(frame => {
    frame.querySelector('header').onclick = event => { if (!event.target.closest('input, button')) selectGroup(frame.dataset.groupFrame) }
    const showFrameTarget = event => {
      if (imageDragType(event) !== 'group' || processing()) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      frame.classList.add('group-drop-target')
    }
    frame.ondragenter = showFrameTarget
    frame.ondragover = showFrameTarget
    frame.ondragleave = event => { if (!frame.contains(event.relatedTarget)) frame.classList.remove('group-drop-target') }
    frame.ondrop = async event => {
      if (imageDragType(event) !== 'group' || processing()) return
      event.preventDefault()
      event.stopPropagation()
      clearImageDragState()
      await groupImagesByDrop(event.dataTransfer.getData('application/x-screenshot-group'), frame.dataset.groupLast)
    }
  })
}
async function selectImage(id) {
  if (!imageById(id)) return
  state.task.selectedImageId = id
  state.selectedGroupId = imageGroup(id)?.id || ''
  await saveTask({ selectedImageId: id }, false)
  renderAll()
}
function selectReviewOffset(offset) {
  const images = filteredReviewImages()
  const index = images.findIndex(image => image.id === currentImage()?.id)
  const next = images[index + offset]
  if (next) selectImage(next.id)
}
function clearImageDragState() {
  document.querySelectorAll('.image-row').forEach(row => row.classList.remove('dragging', 'group-drop-target', 'sort-drop-target'))
  document.querySelectorAll('.image-group-frame').forEach(frame => frame.classList.remove('group-drop-target'))
}
function imageDragType(event) {
  const types = [...(event.dataTransfer?.types || [])]
  return types.includes('application/x-screenshot-reorder') ? 'sort' : types.includes('application/x-screenshot-group') ? 'group' : ''
}
function showImageDropTarget(event, row) {
  const type = imageDragType(event)
  if (!type || processing()) return
  event.preventDefault()
  event.dataTransfer.dropEffect = 'move'
  row.classList.toggle('sort-drop-target', type === 'sort')
  row.classList.toggle('group-drop-target', type === 'group' && !row.classList.contains('dragging'))
}
async function handleImageDrop(event, row) {
  const type = imageDragType(event)
  if (!type || processing()) return
  event.preventDefault()
  event.stopPropagation()
  clearImageDragState()
  if (type === 'sort') return reorderImages(Number(event.dataTransfer.getData('application/x-screenshot-reorder')), Number(row.dataset.index))
  await groupImagesByDrop(event.dataTransfer.getData('application/x-screenshot-group'), row.dataset.image)
}
async function reorderImages(source, destination) {
  if (!Number.isInteger(source) || source === destination || processing()) return
  const ids = state.task.images.map(image => image.id)
  const [moved] = ids.splice(source, 1)
  ids.splice(destination, 0, moved)
  await saveTask({ imageOrder: ids }, false)
  await saveGroups(groups().map(group => ({ ...group, organizeStatus: 'pending', markdown: '', error: '' })))
}
async function groupImagesByDrop(sourceId, targetId) {
  if (!sourceId || !targetId || sourceId === targetId || processing()) return
  const current = groups()
  const sourceGroup = current.find(group => group.imageIds.includes(sourceId))
  const targetGroup = current.find(group => group.imageIds.includes(targetId))
  if (!sourceGroup || !targetGroup || sourceGroup.id === targetGroup.id) { notice('这两张截图已经在同一组'); return }
  const next = current.map(group => ({ ...group, imageIds: [...group.imageIds] }))
  const from = next.find(group => group.id === sourceGroup.id)
  const target = next.find(group => group.id === targetGroup.id)
  from.imageIds = from.imageIds.filter(id => id !== sourceId)
  from.organizeStatus = 'pending'; from.markdown = ''; from.error = ''
  if (from.imageIds.length === 1) {
    const remainingIndex = state.task.images.findIndex(image => image.id === from.imageIds[0])
    from.type = 'single'; from.title = `摘录 ${remainingIndex + 1}`; from.titleMode = 'auto'; from.source = 'manual'
  }
  target.imageIds.splice(target.imageIds.indexOf(targetId) + 1, 0, sourceId)
  if (target.type !== 'article') {
    target.type = 'article'
    target.title = `文章 ${next.filter(group => group.type === 'article').length + 1}`
    target.titleMode = 'auto'
  }
  target.source = 'manual'; target.organizeStatus = 'pending'; target.markdown = ''; target.error = ''
  state.selectedGroupId = target.id
  state.task = unwrap(await window.electronAPI.updateGroups(state.task.id, next.filter(group => group.imageIds.length)))
  const imageOrder = state.task.images.map(image => image.id)
  imageOrder.splice(imageOrder.indexOf(sourceId), 1)
  imageOrder.splice(imageOrder.indexOf(targetId) + 1, 0, sourceId)
  state.task = unwrap(await window.electronAPI.updateTask(state.task.id, { imageOrder }))
  state.selectedImages.clear()
  renderAll()
  notice(`已加入“${target.title}”`, 'success')
}
async function saveGroups(next) {
  state.task = unwrap(await window.electronAPI.updateGroups(state.task.id, next))
  state.stage = 'materials'
  state.selectedImages.clear()
  if (!groups().some(group => group.id === state.selectedGroupId)) state.selectedGroupId = ''
  renderAll()
}
async function createArticleGroup() {
  const selected = [...state.selectedImages].sort((a, b) => state.task.images.findIndex(image => image.id === a) - state.task.images.findIndex(image => image.id === b))
  if (selected.length < 2) return
  const remainder = groups().map(group => ({ ...group, imageIds: group.imageIds.filter(id => !selected.includes(id)) })).filter(group => group.imageIds.length)
  const count = remainder.filter(group => group.type === 'article').length + 1
  const created = { id: groupId(), type: 'article', imageIds: selected, title: `文章 ${count}`, titleMode: 'auto', source: 'manual', organizeStatus: 'pending', markdown: '', error: '' }
  remainder.push(created)
  state.selectedGroupId = created.id
  await saveGroups(remainder)
}
async function ungroupSelected() {
  const selected = new Set(state.selectedImages)
  const next = []
  for (const group of groups()) {
    const removed = group.imageIds.filter(id => selected.has(id))
    const kept = group.imageIds.filter(id => !selected.has(id))
    if (kept.length) next.push({ ...group, imageIds: kept, type: kept.length === 1 ? 'single' : group.type })
    removed.forEach((id, index) => next.push(baseGroup(imageById(id), next.length + index)))
  }
  await saveGroups(next)
}
async function dissolveGroup(id) {
  const group = groups().find(item => item.id === id)
  if (!group) return
  const next = groups().filter(item => item.id !== id)
  group.imageIds.forEach((imageId, index) => next.splice(index, 0, baseGroup(imageById(imageId), index)))
  if (state.selectedGroupId === id) state.selectedGroupId = ''
  await saveGroups(next)
}
async function renameGroup(id, title) {
  const clean = String(title || '').trim()
  if (!clean) { notice('文章标题不能为空'); renderAll(); return }
  await saveGroups(groups().map(group => group.id === id ? { ...group, title: clean, titleMode: 'manual' } : group))
}
async function selectGroup(id) {
  const group = groups().find(item => item.id === id)
  if (!group) return
  state.selectedGroupId = id
  if (group.imageIds[0]) {
    state.task.selectedImageId = group.imageIds[0]
    await saveTask({ selectedImageId: group.imageIds[0] }, false)
  }
  renderAll()
}

async function loadGroupPreviewImages(group) {
  await Promise.all(group.imageIds.map(async id => {
    const image = imageById(id)
    if (!image) return
    try {
      let data = state.imageData.get(id)
      if (!data) { data = unwrap(await window.electronAPI.getTaskImageData(state.task.id, id)); state.imageData.set(id, data) }
      if (state.stage !== 'materials' || state.selectedGroupId !== group.id) return
      const button = document.querySelector(`[data-preview-image="${id}"]`)
      if (!button) return
      const preview = document.createElement('img')
      preview.src = data
      preview.alt = image.name
      const label = document.createElement('span')
      label.textContent = image.name
      button.replaceChildren(preview, label)
      button.onclick = () => openImageViewer(data, image.name)
    } catch (error) {
      const button = document.querySelector(`[data-preview-image="${id}"]`)
      if (button) button.textContent = `无法读取：${error.message}`
    }
  }))
}
async function loadImagePreview(image) {
  const holder = $('image-preview')
  try {
    let data = state.imageData.get(image.id)
    if (!data) { data = unwrap(await window.electronAPI.getTaskImageData(state.task.id, image.id)); state.imageData.set(image.id, data) }
    if (currentImage()?.id !== image.id || !holder) return
    const previewImage = document.createElement('img')
    previewImage.src = data
    previewImage.alt = image.name
    previewImage.title = '点击查看完整截图'
    previewImage.onclick = () => openImageViewer(data, image.name)
    holder.replaceChildren(previewImage)
    holder.onclick = event => { if (event.target === holder) openImageViewer(data, image.name) }
    $('view-full-image').disabled = false
    $('view-full-image').onclick = () => openImageViewer(data, image.name)
  } catch (error) {
    if (holder) holder.textContent = `无法读取原图：${error.message}`
  }
}
function openImageViewer(data, name) {
  $('image-viewer-image').src = data
  $('image-viewer-image').alt = name
  $('image-viewer-title').textContent = name
  $('image-viewer').classList.add('active')
  $('image-viewer').setAttribute('aria-hidden', 'false')
}
function closeImageViewer() {
  $('image-viewer').classList.remove('active')
  $('image-viewer').setAttribute('aria-hidden', 'true')
  $('image-viewer-image').removeAttribute('src')
}
function renderTaskDrawer() {
  const total = state.tasks.reduce((sum, task) => sum + (task.storageBytes || 0), 0)
  $('drawer-storage').textContent = state.tasks.length ? `${state.tasks.length} 个任务 · ${bytes(total)}` : '还没有任务'
  $('drawer-task-list').innerHTML = state.tasks.map(task => {
    const stage = listingStage(task)
    return `<button data-drawer-task="${task.id}" class="drawer-task ${task.id === state.task?.id ? 'active' : ''}"><span><strong>${esc(task.name)}</strong><small>${Workflow.STAGE_META[stage].label} · ${task.completeCount}/${task.imageCount} 已识别</small></span>${icon(task.id === state.task?.id ? 'check' : 'chevron-right')}</button>`
  }).join('') || '<div class="list-empty">导入截图后，任务会显示在这里</div>'
  document.querySelectorAll('[data-drawer-task]').forEach(button => { button.onclick = () => loadTask(button.dataset.drawerTask) })
}
function openTaskDrawer() {
  $('task-drawer-overlay').classList.add('active')
  $('task-drawer-overlay').setAttribute('aria-hidden', 'false')
  renderTaskDrawer()
  renderIcons($('task-drawer-overlay'))
}
function closeTaskDrawer() {
  $('task-drawer-overlay').classList.remove('active')
  $('task-drawer-overlay').setAttribute('aria-hidden', 'true')
}
function closeSettings() {
  $('settings-overlay').classList.remove('active')
  $('settings-overlay').setAttribute('aria-hidden', 'true')
  document.querySelectorAll('[data-toggle-password]').forEach(button => {
    const input = $(button.dataset.togglePassword)
    input.type = 'password'
    button.textContent = '显示'
  })
}
function openSettings() {
  const settings = state.settings
  state.copyOcrToLlm = false
  $('ocr-key').value = ''
  $('llm-key').value = ''
  $('ocr-host').value = settings.ocrApi.apiHost
  $('ocr-model').value = settings.ocrApi.model
  $('llm-host').value = settings.llmApi.apiHost
  $('llm-model').value = settings.llmApi.model
  $('secure-warning').textContent = settings.warning || ''
  $('secure-warning').classList.toggle('hidden', !settings.warning)
  $('settings-overlay').classList.add('active')
  $('settings-overlay').setAttribute('aria-hidden', 'false')
}
function apiDraft(kind) {
  const prefix = kind === 'ocrApi' ? 'ocr' : 'llm'
  return { apiKey: $(`${prefix}-key`).value, apiHost: $(`${prefix}-host`).value, model: $(`${prefix}-model`).value }
}
async function testApi(kind) {
  const prefix = kind === 'ocrApi' ? 'ocr' : 'llm'
  const label = kind === 'ocrApi' ? 'OCR API' : '整理 API'
  const button = $(`test-${prefix}`)
  button.disabled = true
  button.textContent = '测试中…'
  try {
    const result = unwrap(await window.electronAPI.testApiConfig(kind, apiDraft(kind)))
    notice(`${label}：${result.message || '连接成功'}`, 'success')
  } catch (error) {
    notice(`${label}：${error.message}`, 'error')
  } finally {
    button.disabled = false
    button.textContent = '测试连接'
  }
}
function copyOcrConfig() {
  $('llm-host').value = $('ocr-host').value
  $('llm-model').value = $('ocr-model').value
  if ($('ocr-key').value) $('llm-key').value = $('ocr-key').value
  state.copyOcrToLlm = true
  notice('已复制 OCR 配置，保存后生效', 'success')
}
function togglePassword(button) {
  const input = $(button.dataset.togglePassword)
  const visible = input.type === 'text'
  input.type = visible ? 'password' : 'text'
  button.textContent = visible ? '显示' : '隐藏'
}
async function saveSettings() {
  const button = $('settings-save')
  button.disabled = true
  button.textContent = '保存中…'
  try {
    state.settings = unwrap(await window.electronAPI.saveSettings({ theme: 'light', copyOcrToLlm: state.copyOcrToLlm, ocrApi: apiDraft('ocrApi'), llmApi: apiDraft('llmApi') }))
    state.copyOcrToLlm = false
    closeSettings()
    renderHeaderStatus()
    renderIcons($('api-status'))
    notice('设置已保存', 'success')
  } catch (error) { notice(error.message, 'error') }
  finally { button.disabled = false; button.textContent = '保存设置' }
}

window.electronAPI.onJobProgress(async event => {
  if (event.taskId !== state.task?.id || (state.jobId && event.jobId !== state.jobId)) return
  const terminal = ['complete', 'failed', 'canceled'].includes(event.status)
  const percent = event.total ? Math.round(event.current / event.total * 100) : 10
  $('progress-track').classList.toggle('active', !terminal)
  $('progress-bar').style.width = `${percent}%`
  status(event.message, event.status === 'error' || event.status === 'failed' ? 'error' : event.status === 'complete' ? 'success' : 'processing')
  if (terminal) { state.jobId = ''; state.jobStage = '' }
  state.task = unwrap(await window.electronAPI.loadTask(event.taskId))
  state.stage = Workflow.stageForTask(state.task)
  await refreshTasks(false)
  renderAll()
})

function bind() {
  $('library-import').onclick = () => importImages({ newTask: true })
  $('library-new-task').onclick = createEmptyTask
  $('drawer-import').onclick = () => importImages({ newTask: true })
  $('drawer-new-task').onclick = createEmptyTask
  $('add-images-btn').onclick = importImages
  $('workspace-home').onclick = async () => { await flushSave(); state.showLibrary = true; closeTaskDrawer(); await refreshTasks(false); renderAll() }
  $('task-title').oninput = event => { state.task.name = event.target.value; debounceSave({ name: event.target.value }) }
  $('delete-task-btn').onclick = async () => {
    if (!state.task || !confirm(`删除“${state.task.name}”？保存的截图和结果将无法恢复。`)) return
    try {
      unwrap(await window.electronAPI.deleteTask(state.task.id))
      state.task = null
      state.showLibrary = true
      await refreshTasks(false)
      renderAll()
      notice('任务已删除', 'success')
    } catch (error) { notice(error.message, 'error') }
  }
  document.querySelectorAll('[data-stage]').forEach(step => { step.onclick = () => goStage(step.dataset.stage) })
  $('task-drawer-open').onclick = openTaskDrawer
  $('task-drawer-close').onclick = closeTaskDrawer
  $('task-drawer-overlay').onclick = event => { if (event.target === $('task-drawer-overlay')) closeTaskDrawer() }
  $('settings-btn').onclick = openSettings
  $('api-status').onclick = openSettings
  $('settings-close').onclick = closeSettings
  $('settings-cancel').onclick = closeSettings
  $('settings-save').onclick = saveSettings
  $('test-ocr').onclick = () => testApi('ocrApi')
  $('test-llm').onclick = () => testApi('llmApi')
  $('copy-ocr-config').onclick = copyOcrConfig
  document.querySelectorAll('[data-toggle-password]').forEach(button => { button.onclick = () => togglePassword(button) })
  $('settings-overlay').onclick = event => { if (event.target === $('settings-overlay')) closeSettings() }
  $('image-viewer-close').onclick = closeImageViewer
  $('image-viewer').onclick = event => { if (event.target === $('image-viewer')) closeImageViewer() }
  $('win-minimize').onclick = () => window.electronAPI.winMinimize()
  $('win-maximize').onclick = () => window.electronAPI.winMaximize()
  $('win-close').onclick = () => window.electronAPI.winClose()
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && $('image-viewer').classList.contains('active')) return closeImageViewer()
    if (event.key === 'Escape' && $('settings-overlay').classList.contains('active')) return closeSettings()
    if (event.key === 'Escape' && $('task-drawer-overlay').classList.contains('active')) return closeTaskDrawer()
    if (!event.ctrlKey) return
    if (event.key.toLowerCase() === 'o') { event.preventDefault(); importImages({ newTask: state.showLibrary }) }
    if (event.key.toLowerCase() === 's' && !state.showLibrary && state.stage === 'export') { event.preventDefault(); exportMarkdown() }
  })
}
async function init() {
  bind()
  try {
    state.settings = unwrap(await window.electronAPI.getSettings())
    await refreshTasks(false)
    state.showLibrary = true
    renderAll()
    const version = await window.electronAPI.getAppVersion()
    $('app-version').textContent = version ? `v${version}` : ''
  } catch (error) { status(`初始化失败：${error.message}`, 'error') }
}
init()
