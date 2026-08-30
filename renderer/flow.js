(function exposeFlow(root, factory) {
  const api = factory()
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  if (root) root.Workflow = api
})(typeof window !== 'undefined' ? window : globalThis, function createFlow() {
  const STAGES = ['materials', 'review', 'organize', 'export']
  const STAGE_META = {
    materials: { number: 1, label: '素材整理', shortLabel: '素材' },
    review: { number: 2, label: '识别与校对', shortLabel: '校对' },
    organize: { number: 3, label: '内容整理', shortLabel: '整理' },
    export: { number: 4, label: '导出', shortLabel: '导出' }
  }

  function legacyStage(task) {
    if (!task?.images?.length) return 'materials'
    if (task.stage === 'result' && String(task.markdown || '').trim()) return 'export'
    if (['ocr', 'edit', 'review'].includes(task.stage)) return 'review'
    return 'materials'
  }

  function stageForTask(task) {
    if (!task?.images?.length) return 'materials'
    if (STAGES.includes(task.uiStage)) {
      if (task.uiStage === 'export' && !String(task.markdown || '').trim()) return 'organize'
      return task.uiStage
    }
    return legacyStage(task)
  }

  function imageSummary(task) {
    const images = task?.images || []
    return images.reduce((summary, image) => {
      if (image.status === 'success') summary.success += 1
      else if (image.status === 'error') summary.error += 1
      else if (image.status === 'processing') summary.processing += 1
      else summary.pending += 1
      return summary
    }, { total: images.length, success: 0, error: 0, processing: 0, pending: 0 })
  }

  function stageAccess(task, requestedStage, options = {}) {
    if (!STAGES.includes(requestedStage)) return { allowed: false, reason: '未知处理阶段' }
    const summary = imageSummary(task)
    if (requestedStage === 'materials') return { allowed: true, reason: '' }
    if (!summary.total) return { allowed: false, reason: '请先添加截图' }
    if (requestedStage === 'review') return { allowed: true, reason: '' }
    if (requestedStage === 'organize') {
      if (!summary.success && !options.allowImageFailures) return { allowed: false, reason: '请先完成至少一张截图的识别与校对' }
      return { allowed: true, reason: '' }
    }
    if (!String(task?.markdown || '').trim()) return { allowed: false, reason: '请先完成内容整理' }
    return { allowed: true, reason: '' }
  }

  function stageState(task, stage, currentStage) {
    const currentIndex = STAGES.indexOf(currentStage)
    const index = STAGES.indexOf(stage)
    const access = stageAccess(task, stage, { allowImageFailures: true })
    const summary = imageSummary(task)
    const groupFailures = (task?.groups || []).some(group => group.organizeStatus === 'error')
    if (stage === currentStage) return 'current'
    if (stage === 'review' && summary.error && summary.pending === 0 && index < currentIndex) return 'problem'
    if (stage === 'organize' && groupFailures) return 'problem'
    if (stage === 'materials' && summary.total) return 'complete'
    if (stage === 'review' && summary.total && summary.pending === 0 && summary.success) return 'complete'
    if (stage === 'organize' && String(task?.markdown || '').trim() && !groupFailures) return 'complete'
    if (index < currentIndex) return 'complete'
    if (!access.allowed) return 'locked'
    return 'available'
  }

  return { STAGES, STAGE_META, legacyStage, stageForTask, imageSummary, stageAccess, stageState }
})
