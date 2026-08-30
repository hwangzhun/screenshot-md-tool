const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const vm = require('vm')
const { getResizeDimensions } = require('../main/utils/image')
const { normalizeAPIHost, apiPathFor, decodeUtf8Chunks, hasDamagedContent } = require('../main/services/http-openai')
const { TaskStore } = require('../main/services/task-store')
const { SettingsStore } = require('../main/services/settings-store')
const { runSequentialOCR } = require('../main/services/ocr')
const { suggestLocalGroups, normalizeGroups, validateSuggestionGroups, parseOrganizeResponse, messageText, deepSeekJSONOptions, stripPlatformMetadata, composeMarkdown } = require('../main/services/grouping')
const { stageForTask, stageAccess, stageState, imageSummary } = require('../renderer/flow')

function temporaryDirectory() { return fs.mkdtempSync(path.join(os.tmpdir(), 'screenshot-md-tool-')) }

test('渲染脚本可与 DOM 辅助脚本共同加载', () => {
  const root = path.join(__dirname, '..')
  const scripts = [
    fs.readFileSync(path.join(root, 'renderer', 'dom.js'), 'utf8'),
    fs.readFileSync(path.join(root, 'renderer', 'flow.js'), 'utf8'),
    fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8')
  ].join('\n')
  assert.doesNotThrow(() => new vm.Script(scripts))
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
  assert.deepEqual([...html.matchAll(/data-stage="([^"]+)"/g)].map(match => match[1]), ['materials', 'review', 'organize', 'export'])
  assert.match(html, /lucide\.min\.js/)
})

test('新旧任务会映射到四阶段工作流', () => {
  assert.equal(stageForTask({ images: [] }), 'materials')
  assert.equal(stageForTask({ images: [{}], stage: 'group' }), 'materials')
  assert.equal(stageForTask({ images: [{}], stage: 'edit' }), 'review')
  assert.equal(stageForTask({ images: [{}], stage: 'result', markdown: '# 结果' }), 'export')
  assert.equal(stageForTask({ images: [{}], stage: 'edit', uiStage: 'organize' }), 'organize')
  assert.equal(stageForTask({ images: [{}], uiStage: 'export', markdown: '' }), 'organize')
})

test('阶段守卫会阻止跳过素材与整理结果', () => {
  const empty = { images: [], markdown: '' }
  assert.equal(stageAccess(empty, 'review').allowed, false)
  const ready = { images: [{ status: 'success' }], markdown: '' }
  assert.deepEqual(imageSummary(ready), { total: 1, success: 1, error: 0, processing: 0, pending: 0 })
  assert.equal(stageAccess(ready, 'organize').allowed, true)
  assert.equal(stageAccess(ready, 'export').allowed, false)
  assert.equal(stageAccess({ ...ready, markdown: '# 结果' }, 'export').allowed, true)
  assert.equal(stageState({ ...ready, groups: [{ organizeStatus: 'error' }], markdown: '# 部分结果' }, 'organize', 'export'), 'problem')
  assert.equal(stageState({ ...ready, groups: [{ organizeStatus: 'success' }], markdown: '# 完整结果' }, 'organize', 'materials'), 'complete')
})

test('缩放尺寸只在超过长边阈值时改变', () => {
  assert.deepEqual(getResizeDimensions(1200, 800), { width: 1200, height: 800, resized: false })
  assert.deepEqual(getResizeDimensions(4800, 3200), { width: 2400, height: 1600, resized: true })
})

test('OpenAI 地址能规范化为兼容的 completions 路径', () => {
  assert.equal(apiPathFor(normalizeAPIHost('api.example.com')), '/v1/chat/completions')
  assert.equal(apiPathFor(normalizeAPIHost('https://api.example.com/v1')), '/v1/chat/completions')
  assert.equal(apiPathFor(normalizeAPIHost('https://api.example.com/custom/v1/chat/completions')), '/custom/v1/chat/completions')
  assert.throws(() => normalizeAPIHost('http://api.example.com'), /HTTPS/)
})

test('跨数据块的中文字符会在合并后统一按 UTF-8 解码', () => {
  const expected = '被命运提前标好了价格'
  const bytes = Buffer.from(expected)
  const splitAt = Buffer.byteLength('被命运提前标') + 1
  const chunks = [bytes.subarray(0, splitAt), bytes.subarray(splitAt)]
  assert.match(chunks.map(chunk => chunk.toString('utf8')).join(''), /\uFFFD/)
  assert.equal(decodeUtf8Chunks(chunks), expected)
  assert.equal(hasDamagedContent({ choices: [{ message: { content: '标��了价格' } }] }), true)
  assert.equal(hasDamagedContent({ choices: [{ message: { content: expected } }] }), false)
})

test('任务会保存完整图片副本、更新内容并在重开后保留', () => {
  const root = temporaryDirectory(); const source = path.join(root, 'source.png'); fs.writeFileSync(source, 'not-a-real-png')
  const store = new TaskStore(path.join(root, 'workspace'), { prepareImage: file => ({ uploadPath: file, width: 100, height: 200, uploadBytes: 0, resized: false }) })
  const task = store.create('我的任务'); const imported = store.importImages(task.id, [source])
  assert.equal(imported.images.length, 1); assert.equal(imported.stage, 'group'); assert.notEqual(imported.images[0].originalPath, source); assert.ok(fs.existsSync(imported.images[0].originalPath))
  assert.equal(imported.uiStage, 'materials')
  store.update(task.id, { markdown: '# 保存成功', imageUpdates: [{ id: imported.images[0].id, status: 'success', ocrText: '你好' }] })
  const reopened = new TaskStore(path.join(root, 'workspace'), { prepareImage: () => { throw new Error('unused') } }).read(task.id)
  assert.equal(reopened.markdown, '# 保存成功'); assert.equal(reopened.images[0].ocrText, '你好'); assert.equal(store.list()[0].completeCount, 1)
  assert.equal(fs.readFileSync(store.markdownPath(task.id), 'utf8'), '# 保存成功')
  fs.rmSync(root, { recursive: true, force: true })
})

test('追加截图会使旧 Markdown 失效并保留为可恢复版本', () => {
  const root = temporaryDirectory()
  const first = path.join(root, 'first.png')
  const second = path.join(root, 'second.png')
  fs.writeFileSync(first, 'first')
  fs.writeFileSync(second, 'second')
  const store = new TaskStore(path.join(root, 'workspace'), { prepareImage: file => ({ uploadPath: file, width: 100, height: 200, uploadBytes: 0, resized: false }) })
  let task = store.importImages(store.create('失效测试').id, [first])
  task = store.update(task.id, {
    groups: [{ id: 'one', type: 'single', imageIds: [task.images[0].id], title: '第一篇', organizeStatus: 'success', markdown: '正文' }],
    markdown: '# 已生成内容'
  })
  task = store.importImages(task.id, [second])
  assert.equal(task.markdown, '')
  assert.equal(task.previousMarkdown, '# 已生成内容')
  assert.equal(task.groups[0].organizeStatus, 'pending')
  assert.equal(task.uiStage, 'materials')
  fs.rmSync(root, { recursive: true, force: true })
})

test('截图排序后文章组内页序与截图顺序保持一致', () => {
  const root = temporaryDirectory()
  const sources = ['a.png', 'b.png', 'c.png'].map(name => { const file = path.join(root, name); fs.writeFileSync(file, name); return file })
  const store = new TaskStore(path.join(root, 'workspace'), { prepareImage: file => ({ uploadPath: file, width: 100, height: 200, uploadBytes: 0, resized: false }) })
  const task = store.importImages(store.create('排序测试').id, sources)
  const [a, b, c] = task.images.map(image => image.id)
  store.update(task.id, { groups: [{ id: 'article', type: 'article', imageIds: [a, c], title: '文章 1' }] })
  const reordered = store.update(task.id, { imageOrder: [c, b, a] })
  assert.deepEqual(reordered.images.map(image => image.id), [c, b, a])
  assert.deepEqual(reordered.groups[0].imageIds, [c, a])
  fs.rmSync(root, { recursive: true, force: true })
})

test('设置不向渲染端返回 API Key，并支持加密保存', () => {
  const root = temporaryDirectory()
  const fakeSafeStorage = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(`encrypted:${value}`), decryptString: value => value.toString().replace('encrypted:', '') }
  const store = new SettingsStore(path.join(root, 'settings.json'), fakeSafeStorage); const visible = store.save({ ocrApi: { apiKey: 'secret', apiHost: 'api.example.com', model: 'vision' } })
  assert.equal(visible.ocrApi.hasApiKey, true); assert.equal(JSON.stringify(visible).includes('secret'), false); assert.equal(store.getApiConfig('ocrApi').apiKey, 'secret')
  fs.rmSync(root, { recursive: true, force: true })
})

test('OCR 严格按顺序处理，并在单张失败后继续', async () => {
  const events = []; let running = 0; let maxRunning = 0
  const images = [{ id: '1', uploadPath: 'one' }, { id: '2', uploadPath: 'two' }, { id: '3', uploadPath: 'three' }]
  const outcome = await runSequentialOCR(images, {}, { recognize: async file => { running += 1; maxRunning = Math.max(maxRunning, running); await new Promise(resolve => setTimeout(resolve, 5)); running -= 1; if (file === 'two') throw new Error('bad image'); return file }, onProgress: event => events.push(`${event.type}:${event.image.id}`) })
  assert.equal(maxRunning, 1); assert.deepEqual(outcome.results.map(item => item.text || item.error), ['one', 'bad image', 'three']); assert.deepEqual(events, ['start:1', 'success:1', 'start:2', 'error:2', 'start:3', 'success:3'])
})

test('文章组允许跨页且未分组截图会回退为独立摘录', () => {
  const images = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  const groups = normalizeGroups(images, [{ id: 'article', type: 'article', imageIds: ['a', 'c'], title: '跨页文章', titleMode: 'manual', source: 'manual' }])
  assert.deepEqual(groups[0].imageIds, ['a', 'c'])
  assert.equal(groups[0].titleMode, 'manual')
  assert.deepEqual(groups[1].imageIds, ['b'])
  assert.equal(groups[1].type, 'single')
})

test('本地建议不修改确认分组，AI 重复截图建议会被拒绝', () => {
  const images = [{ id: 'a', ocrText: '这是第一段，' }, { id: 'b', ocrText: '接着写第二段。' }, { id: 'c', ocrText: '独立内容。' }]
  const suggestions = suggestLocalGroups(images)
  assert.equal(suggestions.length, 1)
  assert.deepEqual(suggestions[0].imageIds, ['a', 'b'])
  assert.throws(() => validateSuggestionGroups(images, [{ imageIds: ['a', 'b'] }, { imageIds: ['b', 'c'] }]), /重复/)
})

test('最终 Markdown 按文章组顺序分节并仅包含已完成组', () => {
  const markdown = composeMarkdown([
    { title: '第一篇', organizeStatus: 'success', markdown: '第一篇正文' },
    { title: '失败内容', organizeStatus: 'error', markdown: '' },
    { title: '第二篇', organizeStatus: 'success', markdown: '第二篇正文' }
  ])
  assert.match(markdown, /## 第一篇/)
  assert.match(markdown, /## 第二篇/)
  assert.doesNotMatch(markdown, /失败内容/)
  assert.doesNotMatch(markdown, /语录收集|整理时间|处理流程/)
  assert.ok(markdown.indexOf('第一篇正文') < markdown.indexOf('第二篇正文'))
})

test('最终正文会清除地点、打卡人数、互动数据和标签行', () => {
  const markdown = stripPlatformMetadata([
    '真正重要的事，通常需要时间。',
    '',
    '地点：香港中环',
    '128 人打卡',
    '点赞：2.3万',
    '#香港 #旅行',
    'Tag：城市漫步',
    '@示例账号',
    '',
    '> 保持好奇，也保持耐心。'
  ].join('\n'))
  assert.match(markdown, /真正重要的事/)
  assert.match(markdown, /保持好奇/)
  assert.doesNotMatch(markdown, /香港中环|打卡|点赞|#香港|Tag|示例账号/)
})

test('整理响应支持 JSON 与兼容内容块', () => {
  const group = { title: '文章 2' }
  const response = { choices: [{ finish_reason: 'stop', message: { content: '{"title":"新的标题","markdown":"第一段\\n\\n第二段"}' } }] }
  assert.deepEqual(parseOrganizeResponse(response, group), { title: '新的标题', markdown: '第一段\n\n第二段' })
  assert.equal(messageText({ choices: [{ message: { content: [{ type: 'text', text: '正文' }] } }] }), '正文')
})

test('整理空响应会显示接口实际停止原因', () => {
  assert.throws(
    () => parseOrganizeResponse({ choices: [{ finish_reason: 'content_filter', message: { content: null } }] }, { title: '文章 2' }),
    /内容过滤器/
  )
  assert.throws(
    () => parseOrganizeResponse({ choices: [{ finish_reason: 'length', message: { content: '' } }] }, { title: '文章 2' }),
    /长度上限/
  )
})

test('DeepSeek 整理请求关闭思考并要求 JSON 输出', () => {
  assert.deepEqual(deepSeekJSONOptions({ apiHost: 'https://api.deepseek.com', model: 'deepseek-v4-flash' }), {
    thinking: { type: 'disabled' }, response_format: { type: 'json_object' }
  })
  assert.deepEqual(deepSeekJSONOptions({ apiHost: 'https://example.com', model: 'custom-model' }), {})
})
