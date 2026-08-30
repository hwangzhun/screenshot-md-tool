const crypto = require('crypto')
const { postOpenAICompatible, cleanThinkTags } = require('./http-openai')
const { buildOCRCorpus } = require('./ocr')

function cleanTitle(value, fallback) {
  const title = String(value || '').replace(/^#+\s*/, '').replace(/[\r\n]+/g, ' ').trim()
  return title.slice(0, 80) || fallback
}

function terminal(text) { return /[。！？.!?…]$/.test(String(text || '').trim()) }
function normalizedTail(text) { return String(text || '').replace(/\s+/g, '').slice(-24) }
function normalizedHead(text) { return String(text || '').replace(/\s+/g, '').slice(0, 24) }

function suggestLocalGroups(images) {
  const suggestions = []
  for (let index = 0; index < images.length - 1; index += 1) {
    const before = images[index]; const after = images[index + 1]
    if (!before.ocrText?.trim() || !after.ocrText?.trim()) continue
    const tail = normalizedTail(before.ocrText); const head = normalizedHead(after.ocrText)
    let score = 0
    if (!terminal(before.ocrText)) score += 1
    if (tail && head && (tail.includes(head.slice(0, 8)) || head.includes(tail.slice(-8)))) score += 2
    if (/[,，、：:]$/.test(String(before.ocrText).trim())) score += 1
    if (score >= 1) suggestions.push({ id: crypto.randomUUID(), imageIds: [before.id, after.id], source: 'local', score, title: `可能连续：截图 ${index + 1}–${index + 2}` })
  }
  return suggestions
}

function makeGroup(input, fallbackIndex) {
  return {
    id: input.id || crypto.randomUUID(),
    type: input.type === 'article' ? 'article' : 'single',
    imageIds: Array.isArray(input.imageIds) ? input.imageIds : [],
    title: cleanTitle(input.title, input.type === 'article' ? `文章 ${fallbackIndex}` : `摘录 ${fallbackIndex}`),
    titleMode: input.titleMode === 'manual' ? 'manual' : 'auto',
    source: ['manual', 'local', 'ai'].includes(input.source) ? input.source : 'manual',
    organizeStatus: input.organizeStatus || 'pending',
    markdown: String(input.markdown || ''),
    error: String(input.error || '')
  }
}

function normalizeGroups(images, groups = []) {
  const validIds = new Set(images.map(image => image.id)); const seen = new Set(); const normalized = []
  for (const raw of groups) {
    const group = makeGroup(raw, normalized.length + 1)
    group.imageIds = group.imageIds.filter(id => validIds.has(id) && !seen.has(id))
    if (!group.imageIds.length) continue
    group.imageIds.forEach(id => seen.add(id))
    if (group.imageIds.length === 1) group.type = 'single'
    normalized.push(group)
  }
  for (const image of images) {
    if (!seen.has(image.id)) normalized.push(makeGroup({ type: 'single', imageIds: [image.id], title: `摘录 ${normalized.length + 1}`, source: 'manual' }, normalized.length + 1))
  }
  return normalized
}

function validateSuggestionGroups(images, candidates) {
  if (!Array.isArray(candidates)) throw new Error('分组建议格式无效')
  const validIds = new Set(images.map(image => image.id)); const seen = new Set()
  return candidates.map((candidate, index) => {
    const imageIds = Array.isArray(candidate.imageIds) ? candidate.imageIds : []
    if (imageIds.length < 2 || imageIds.some(id => !validIds.has(id) || seen.has(id))) throw new Error('AI 返回了重复或不存在的截图')
    imageIds.forEach(id => seen.add(id))
    return { id: crypto.randomUUID(), imageIds, source: 'ai', title: cleanTitle(candidate.title, `建议文章 ${index + 1}`) }
  })
}

function stripJsonFence(text) { return String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '') }

function messageText(response) {
  const content = response?.choices?.[0]?.message?.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content.map(part => {
    if (typeof part === 'string') return part
    return typeof part?.text === 'string' ? part.text : (typeof part?.content === 'string' ? part.content : '')
  }).join('').trim()
}

function organizeResponseError(response) {
  const choice = response?.choices?.[0]
  const finishReason = choice?.finish_reason || ''
  const reasoning = String(choice?.message?.reasoning_content || '').trim()
  if (finishReason === 'content_filter') return new Error('文章整理被 API 内容过滤器拦截，请检查原文后重试')
  if (finishReason === 'length') return new Error('文章整理输出达到长度上限，未生成完整正文')
  if (finishReason === 'insufficient_system_resource') return new Error('文章整理 API 资源不足，重试后仍未生成正文')
  if (reasoning) return new Error('文章整理模型只返回了思考过程，没有生成最终正文')
  return new Error('文章整理 API 返回了空内容，请稍后重试')
}

function parseOrganizeResponse(response, group) {
  cleanThinkTags(response)
  const raw = messageText(response)
  if (!raw) throw organizeResponseError(response)

  let parsed
  try { parsed = JSON.parse(stripJsonFence(raw)) } catch { parsed = null }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { title: group.title, markdown: stripPlatformMetadata(raw) }
  }

  const markdown = stripPlatformMetadata(parsed.markdown ?? parsed.content ?? parsed.text)
  if (!markdown) throw new Error('文章整理 API 返回了 JSON，但正文内容为空')
  return { title: cleanTitle(parsed.title, group.title), markdown }
}

function deepSeekJSONOptions(apiConfig) {
  let hostname = ''
  try { hostname = new URL(String(apiConfig.apiHost || '')).hostname.toLowerCase() } catch {}
  if (hostname !== 'api.deepseek.com' && !String(apiConfig.model || '').toLowerCase().startsWith('deepseek-')) return {}
  return { thinking: { type: 'disabled' }, response_format: { type: 'json_object' } }
}

const PLATFORM_METADATA_LINE_PATTERNS = [
  /^(?:地点|位置|定位|所在地点|发布地点|拍摄地点|发布于|ip\s*属地)\s*[:：]/i,
  /^(?:已有|有|共)?\s*[\d.,]+\s*(?:万|w|k)?\s*人\s*(?:打卡|去过|来过|到过|想去).*$/i,
  /^[\d.,万wWkK+]+\s*(?:人)?\s*(?:点赞|评论|收藏|分享|转发|浏览|阅读|打卡|去过|想去)(?:\s*过)?$/i,
  /^(?:点赞|评论|收藏|分享|转发|浏览|阅读|获赞|打卡|去过|想去)\s*[:：]?\s*[\d.,万wWkK+]+(?:人|次)?$/i,
  /^(?:话题|标签|tags?)\s*[:：]/i,
  /^(?:#[^\s#]+\s*)+$/,
  /^@[\w\u4e00-\u9fff.-]{1,40}$/,
  /^(?:展开|收起|查看全部|更多|相关推荐|添加地点|谁来过|写评论)$/
]

function stripPlatformMetadata(markdown) {
  const lines = String(markdown || '').split(/\r?\n/)
  return lines
    .filter(line => {
      const text = line.trim()
      if (!text || text.length > 160) return true
      return !PLATFORM_METADATA_LINE_PATTERNS.some(pattern => pattern.test(text))
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function analyzeGroupsWithAI(apiConfig, images, options = {}) {
  const pages = images.map((image, index) => ({ index: index + 1, name: image.name, text: image.ocrText }))
  const prompt = [
    '分析以下 OCR 截图是否属于同一篇连续长文。只提出有明确文本衔接证据的多图文章候选；独立短语不要返回。',
    '必须保持每个候选内图片的阅读顺序，不得让同一张图片出现在多个候选中。',
    '只返回 JSON：{"groups":[{"imageIds":["图片ID"],"title":"简短主题"}]}。imageIds 必须使用输入中的图片 ID。',
    '',
    images.map((image, index) => `【图片 ID: ${image.id} / 截图 ${index + 1}: ${image.name}】\n${image.ocrText || '[无文本]'}`).join('\n\n')
  ].join('\n')
  const response = await postOpenAICompatible(apiConfig, { model: apiConfig.model, messages: [{ role: 'user', content: prompt }], max_tokens: 2048 }, '分组分析 API', options)
  cleanThinkTags(response)
  const raw = response.choices?.[0]?.message?.content || ''
  let parsed
  try { parsed = JSON.parse(stripJsonFence(raw)) } catch { throw new Error('AI 分组建议不是有效 JSON') }
  return validateSuggestionGroups(images, parsed.groups || [])
}

async function organizeGroupText(apiConfig, group, images, options = {}) {
  const pages = group.imageIds.map(id => images.find(image => image.id === id)).filter(Boolean).map((image, index) => ({ index: index + 1, name: image.name, text: image.ocrText }))
  if (!pages.length) throw new Error('文章组没有可整理的 OCR 文本')
  const prompt = [
    `以下 ${pages.length} 张截图已由用户确认属于同一篇内容，请按组内顺序合并为完整 Markdown。`,
    '输出必须只包含文档本身的标题与正文。删除明确的 UI 噪音、相邻页重复片段和所有平台元数据；不要补写、不要解释。',
    '必须删除：地点、定位、POI、距离、多少人打卡/去过/想去、用户名或账号、发布时间、IP 属地、点赞/评论/收藏/分享/浏览/阅读数量、话题标签、Tag、推荐词、广告与商品信息。',
    '这些元数据即使紧邻正文、看起来像小标题或出现在正文结尾，也不要放入 Markdown；若一行同时含正文与元数据，只保留正文部分。',
    '不要生成来源、作者、整理时间、处理流程、截图编号或清洗说明。忠实保留正文的段落、引用和必要的列表结构。',
    '生成不超过 20 字的中文主题标题。只返回 JSON：{"title":"主题标题","markdown":"不含一级或二级标题的正文 Markdown"}。',
    '',
    buildOCRCorpus(pages)
  ].join('\n')
  const body = { model: apiConfig.model, messages: [{ role: 'user', content: prompt }], max_tokens: 8192, ...deepSeekJSONOptions(apiConfig) }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await postOpenAICompatible(apiConfig, body, '文章整理 API', options)
    try {
      return parseOrganizeResponse(response, group)
    } catch (error) {
      const finishReason = response?.choices?.[0]?.finish_reason || ''
      const canRetryEmpty = !messageText(response) && !['content_filter', 'length'].includes(finishReason)
      if (attempt === 0 && canRetryEmpty) continue
      throw error
    }
  }
  throw new Error('文章整理 API 返回了空内容，请稍后重试')
}

function composeMarkdown(groups) {
  const sections = []
  for (const group of groups) {
    const body = stripPlatformMetadata(group.markdown)
    if (body) sections.push(`## ${cleanTitle(group.title, '未命名内容')}\n\n${body}`)
  }
  return sections.join('\n\n---\n\n')
}

module.exports = { suggestLocalGroups, normalizeGroups, validateSuggestionGroups, analyzeGroupsWithAI, organizeGroupText, parseOrganizeResponse, messageText, deepSeekJSONOptions, stripPlatformMetadata, composeMarkdown }
