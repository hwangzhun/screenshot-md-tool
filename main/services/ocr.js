/**
 * main/services/ocr.js
 * 云端 OCR：通过 OpenAI 兼容视觉 API 识别图片文字
 */

const path = require('path')
const { postOpenAICompatible, cleanThinkTags } = require('./http-openai')
const { readImageAsBase64, fileExists } = require('../utils/image')
const { OCR_PROMPT } = require('./prompts')

function normalizeOCRText(text) {
  return String(text)
    .replace(/\r/g, '')
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim()
}

function buildOCRCorpus(pages) {
  return pages
    .map(page => {
      const name = path.basename(page.filePath || `image-${page.index}`)
      const text = page.text || ''
      return `【截图 ${page.index}: ${name}】\n${text || '[OCR 未识别到文字]'}`
    })
    .join('\n\n')
}

async function recognizeImagesCloudOCR(filePaths, ocrApiConfig) {
  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    throw new Error('没有可识别的图片')
  }

  const pages = []

  for (let i = 0; i < filePaths.length; i++) {
    const filePath = filePaths[i]
    if (!fileExists(filePath)) {
      pages.push({ index: i + 1, filePath, text: '', error: '文件不存在' })
      continue
    }

    const result = readImageAsBase64(filePath)
    if (!result.success) {
      pages.push({ index: i + 1, filePath, text: '', error: result.error })
      continue
    }

    const bodyObj = {
      model: ocrApiConfig.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: OCR_PROMPT }, { type: 'image_url', image_url: { url: result.data } }] }]
    }

    try {
      const response = await postOpenAICompatible(ocrApiConfig, bodyObj, 'OCR API')
      const content = response.choices?.[0]?.message?.content || ''
      const text = normalizeOCRText(typeof content === 'string' ? content : JSON.stringify(content))
      pages.push({ index: i + 1, filePath, text })
    } catch (err) {
      pages.push({ index: i + 1, filePath, text: '', error: err.message })
    }
  }

  return { pages, combinedText: buildOCRCorpus(pages) }
}

module.exports = { recognizeImagesCloudOCR, buildOCRCorpus, normalizeOCRText }