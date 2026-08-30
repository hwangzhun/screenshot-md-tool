const path = require('path')
const { postOpenAICompatible, cleanThinkTags } = require('./http-openai')
const { readImageAsBase64, fileExists } = require('../utils/image')
const { OCR_PROMPT } = require('./prompts')

function normalizeOCRText(text) {
  return String(text || '').replace(/\r/g, '').split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n').trim()
}

function buildOCRCorpus(pages) {
  return pages.map((page, index) => {
    const number = page.index || index + 1
    const name = path.basename(page.filePath || page.name || `image-${number}`)
    return `【截图 ${number}: ${name}】\n${page.text || page.ocrText || '[OCR 未识别到文字]'}`
  }).join('\n\n')
}

async function recognizeSingleImage(filePath, ocrApiConfig, options = {}) {
  if (!fileExists(filePath)) throw new Error('图片文件不存在')
  const image = readImageAsBase64(filePath)
  if (!image.success) throw new Error(image.error)
  const body = {
    model: ocrApiConfig.model,
    messages: [{ role: 'user', content: [
      { type: 'text', text: OCR_PROMPT },
      { type: 'image_url', image_url: { url: image.data } }
    ] }]
  }
  const response = await postOpenAICompatible(ocrApiConfig, body, 'OCR API', options)
  cleanThinkTags(response)
  const content = response.choices?.[0]?.message?.content || ''
  return normalizeOCRText(typeof content === 'string' ? content : JSON.stringify(content))
}

async function runSequentialOCR(images, ocrApiConfig, options = {}) {
  const recognize = options.recognize || recognizeSingleImage
  const results = []
  for (let index = 0; index < images.length; index += 1) {
    if (options.signal?.aborted) break
    const image = images[index]
    options.onProgress?.({ type: 'start', image, index, total: images.length })
    try {
      const text = await recognize(image.uploadPath || image.originalPath, ocrApiConfig, {
        signal: options.signal,
        onRetry: info => options.onProgress?.({ type: 'retry', image, index, total: images.length, ...info })
      })
      const result = { image, text, error: '' }
      results.push(result)
      options.onProgress?.({ type: 'success', image, text, index, total: images.length })
    } catch (error) {
      if (error.code === 'ABORTED' || options.signal?.aborted) break
      const result = { image, text: '', error: error.message }
      results.push(result)
      options.onProgress?.({ type: 'error', image, error: error.message, index, total: images.length })
    }
  }
  return { results, canceled: !!options.signal?.aborted }
}

async function recognizeImagesCloudOCR(filePaths, config, options = {}) {
  const images = (filePaths || []).map((filePath, index) => ({ id: String(index + 1), originalPath: filePath, uploadPath: filePath, name: path.basename(filePath) }))
  const result = await runSequentialOCR(images, config, options)
  const pages = result.results.map((item, index) => ({ index: index + 1, filePath: item.image.originalPath, text: item.text, error: item.error }))
  return { pages, combinedText: buildOCRCorpus(pages), canceled: result.canceled }
}

module.exports = { recognizeSingleImage, runSequentialOCR, recognizeImagesCloudOCR, buildOCRCorpus, normalizeOCRText }
