/**
 * main.js - Electron 主进程
 * 负责窗口管理、IPC 处理、文件读写、OpenAI 兼容 API 调用
 */

const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const https = require('https')

let mainWindow = null

/**
 * 创建主窗口
 */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#111113',
    frame: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  })

  mainWindow.loadFile('index.html')

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// ─────────────────────────────────────────────────────────
// IPC: 窗口控制（自定义标题栏）
// ─────────────────────────────────────────────────────────
ipcMain.handle('win-minimize', () => { if (mainWindow) mainWindow.minimize() })
ipcMain.handle('win-maximize', () => {
  if (!mainWindow) return
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()
})
ipcMain.handle('win-close', () => { if (mainWindow) mainWindow.close() })
ipcMain.handle('win-is-maximized', () => mainWindow ? mainWindow.isMaximized() : false)

let lastMaxState = false
function watchMaximize() {
  if (!mainWindow) return
  const cur = mainWindow.isMaximized()
  if (cur !== lastMaxState) {
    lastMaxState = cur
    mainWindow.webContents.send('maximize-state-changed', cur)
  }
}
app.whenReady().then(() => {
  if (mainWindow) {
    mainWindow.on('maximize', watchMaximize)
    mainWindow.on('unmaximize', watchMaximize)
  }
})

// ─────────────────────────────────────────────────────────
// IPC: 读取图片文件并转为 base64
// ─────────────────────────────────────────────────────────
ipcMain.handle('read-image-base64', async (event, filePath) => {
  try {
    const buffer = fs.readFileSync(filePath)
    const ext = path.extname(filePath).toLowerCase().replace('.', '')
    const mimeMap = {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      gif: 'image/gif',
      webp: 'image/webp',
      bmp: 'image/bmp'
    }
    const mime = mimeMap[ext] || 'image/jpeg'
    const base64 = buffer.toString('base64')
    return { success: true, data: `data:${mime};base64,${base64}` }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// ─────────────────────────────────────────────────────────
// IPC: 调用腾讯云混元多模态 API（OpenAI 兼容 Chat Completions 端点）
// ─────────────────────────────────────────────────────────
ipcMain.handle('call-vision-api', async (event, apiConfig, base64Images) => {
  try {
    const result = await callVisionAPI(apiConfig, base64Images)
    return { success: true, data: result }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('recognize-images-cloud-ocr', async (event, filePaths, cloudConfig = {}) => {
  try {
    const result = await recognizeImagesCloudOCR(filePaths, cloudConfig)
    return { success: true, data: result }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('organize-ocr-text', async (event, apiConfig, ocrPages) => {
  try {
    const result = await organizeOCRText(apiConfig, ocrPages)
    return { success: true, data: result }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// normalizeOCRText 会在云 OCR 中复用，保留
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

// ─────────────────────────────────────────────────────────
// 云 OCR：通过 OpenAI 兼容视觉 API 识别图片文字
// ─────────────────────────────────────────────────────────
async function recognizeImagesCloudOCR(filePaths, ocrApiConfig) {
  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    throw new Error('没有可识别的图片')
  }

  const ocrPrompt = '请提取图片中的所有文字，按从上到下、从左到右的阅读顺序原样输出。只输出识别到的文字，不要解释，不要 Markdown 格式。'
  const pages = []

  for (let i = 0; i < filePaths.length; i++) {
    const filePath = filePaths[i]
    if (!fs.existsSync(filePath)) {
      pages.push({ index: i + 1, filePath, text: '', error: '文件不存在' })
      continue
    }

    const buffer = fs.readFileSync(filePath)
    const ext = path.extname(filePath).toLowerCase().replace('.', '')
    const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' }
    const mime = mimeMap[ext] || 'image/jpeg'
    const base64 = `data:${mime};base64,${buffer.toString('base64')}`

    const bodyObj = {
      model: ocrApiConfig.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: ocrPrompt }, { type: 'image_url', image_url: { url: base64 } }] }]
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

/**
 * 向腾讯云混元视觉 API（OpenAI 兼容接口）发送请求
 *
 * apiConfig 格式:
 * {
 *   apiKey: string,
 *   apiHost: string,    // e.g. 'api.hunyuan.cloud.tencent.com'
 *   model: string       // e.g. 'hunyuan-vision'
 * }
 *
 * @param {object} apiConfig - API 配置
 * @param {string[]} base64Images - base64 图片数组（含 data URI 前缀）
 * @returns {Promise<object>} - API 返回的 JSON 对象
 */
async function callVisionAPI(apiConfig, base64Images) {
  const { apiKey, apiHost, model } = apiConfig

  const promptText = '这些是手机截图，来自抖音、小红书等平台。请提取其中有价值的语录、短短语、感悟性文字。注意：1)忽略所有UI元素（按钮、导航栏、评论、点赞数、时间、用户名、话题标签等）；2)如果多张截图是同一篇文章的不同部分，请合并为完整段落，去除重复内容；3)提取的文字保持原样，不要改写；4)按来源分组，每组用 ## 标题区分；5)如果截图内容较短（单句语录），直接用引用格式 > 语录内容。返回纯 Markdown 格式，不要有任何解释。'

  // 混元 OpenAI 兼容端点：POST /v1/chat/completions
  // 请求体格式：OpenAI Chat Completions，messages.content 为多模态 part 数组
  // 混元支持单次请求包含多张图片，每批 N 张图一次请求
  const contentParts = [
    { type: 'text', text: promptText },
    ...base64Images.map(b64 => ({ type: 'image_url', image_url: { url: b64 } }))
  ]
  const bodyObj = {
    model,
    messages: [{ role: 'user', content: contentParts }]
  }
  const response = await postOpenAICompatible(apiConfig, bodyObj, '视觉 API')

  // 解析混元返回：优先 choices[0].message.content，兼容 output 字段
  const content = response.choices?.[0]?.message?.content || response.output || ''

  return { choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] }
}

async function postOpenAICompatible(apiConfig, bodyObj, label = 'API') {
  const { apiKey, apiHost } = apiConfig
  if (!apiKey) throw new Error('API Key 为空')
  if (!apiHost) throw new Error('API 地址为空')

  const url = normalizeAPIHost(apiHost)
  const basePath = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '')
  const apiPath = basePath.endsWith('/v1/chat/completions')
    ? basePath
    : basePath.endsWith('/v1')
      ? `${basePath}/chat/completions`
      : `${basePath}/v1/chat/completions`
  const bodyStr = JSON.stringify(bodyObj)

  return await new Promise((res, rej) => {
    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: apiPath,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr)
      }
    }

    const req = https.request(options, (resp) => {
      let data = ''
      resp.on('data', chunk => { data += chunk })
      resp.on('end', () => {
        try {
          const parsed = JSON.parse(data)
          if (parsed.error) {
            const errMsg = parsed.error.message || JSON.stringify(parsed.error)
            rej(new Error(`${label} 错误(${resp.statusCode}): ${errMsg}`))
            return
          }
          res(parsed)
        } catch (parseErr) {
          rej(new Error(`${label} 响应解析失败(${resp.statusCode}): ${data.slice(0, 300)}`))
        }
      })
    })

    req.on('error', (err) => rej(new Error(`${label} 网络错误: ${err.message}`)))
    req.setTimeout(120000, () => { req.destroy(); rej(new Error(`${label} 请求超时(120s)`)) })
    req.write(bodyStr)
    req.end()
  })
}

function normalizeAPIHost(apiHost) {
  const raw = String(apiHost).trim()
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  const url = new URL(withProtocol)
  if (url.protocol !== 'https:') {
    throw new Error('目前仅支持 HTTPS API 地址')
  }
  return url
}

/**
 * 清理返回结果中的 <think...</think> 推理标签
 */
function cleanThinkTags(parsed) {
  if (parsed.choices && parsed.choices[0] && parsed.choices[0].message) {
    const content = parsed.choices[0].message.content || ''
    parsed.choices[0].message.content = content.replace(/<think[\s\S]*?<\/think>/g, '').trim()
  }
}

// ─────────────────────────────────────────────────────────
// IPC: 保存 Markdown 文件
// ─────────────────────────────────────────────────────────
ipcMain.handle('save-md-file', async (event, content) => {
  try {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: '保存 Markdown 文件',
      defaultPath: `语录收集_${formatDate()}.md`,
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })

    if (canceled || !filePath) {
      return { success: false, canceled: true }
    }

    fs.writeFileSync(filePath, content, 'utf-8')
    return { success: true, filePath }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// ─────────────────────────────────────────────────────────
// IPC: 打开文件选择对话框
// ─────────────────────────────────────────────────────────
ipcMain.handle('open-file-dialog', async (event) => {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: '选择截图',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '图片文件', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })

    if (canceled) {
      return { success: false, canceled: true }
    }

    return { success: true, filePaths }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

/**
 * 格式化当前日期为 YYYYMMDD 字符串
 * @returns {string}
 */
function formatDate() {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}${m}${d}`
}
