/**
 * main/services/organize.js
 * 将 OCR 文本发送给文本模型，整理为 Markdown
 */

const { postOpenAICompatible, cleanThinkTags } = require('./http-openai')
const { buildOCRCorpus } = require('./ocr')

async function organizeOCRText(apiConfig, ocrPages) {
  const { apiKey, apiHost, model } = apiConfig
  const combinedText = Array.isArray(ocrPages) ? buildOCRCorpus(ocrPages) : String(ocrPages || '')
  if (!combinedText.trim()) {
    throw new Error('OCR 文本为空，无法整理')
  }

  const pageCount = Array.isArray(ocrPages) ? ocrPages.length : 0
  const promptText = [
    `下面是 ${pageCount} 张手机截图经过 OCR 后得到的文本，每张以【截图 N: 文件名】标记。请把其中真正有价值的短语、语录、摘抄、感悟性文字整理成纯 Markdown。`,
    '',
    '处理规则：',
    '1. **必须处理全部截图**：输入中有几张【截图 N】，输出就要覆盖这几张里的有效正文；不同截图中的独立内容分别保留，不要只输出其中一张。',
    '2. 忽略 UI 噪音：按钮、导航栏、评论、点赞数、用户名、时间戳、话题标签、广告、OCR 误识别符号等。',
    '3. 仅当多张连续截图明确属于同一段长文时，才按截图顺序合并为完整段落，并去掉重复的页眉、页脚和重叠句子；若内容彼此独立，用二级标题 `## 截图 N` 分节，不要合并成一条。',
    '4. 单句短语或语录使用引用格式：> 语录内容。',
    '5. 尽量保留原文，不要改写，不要补写 OCR 没有的内容；只做必要的清洗、合并和断句。',
    '6. 仅删除能明确判断为 UI 或乱码的片段；正文宁可多留，不要误删。',
    '7. 只返回 Markdown，不要解释处理过程。',
    '',
    'OCR 文本：',
    combinedText
  ].join('\n')

  const bodyObj = {
    model,
    messages: [{ role: 'user', content: promptText }],
    max_tokens: 8192
  }

  const response = await postOpenAICompatible(apiConfig, bodyObj, '整理 API')
  cleanThinkTags(response)
  const content = response.choices?.[0]?.message?.content || response.output || ''
  return { choices: [{ message: { content: typeof content === 'string' ? content.trim() : JSON.stringify(content) } }] }
}

module.exports = { organizeOCRText }