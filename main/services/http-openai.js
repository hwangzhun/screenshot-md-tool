const https = require('https')

class APIError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = 'APIError'
    this.statusCode = options.statusCode || 0
    this.retryable = !!options.retryable
    this.code = options.code || ''
  }
}

function normalizeAPIHost(apiHost) {
  const raw = String(apiHost || '').trim()
  if (!raw) throw new Error('API 地址为空')
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  const url = new URL(withProtocol)
  if (url.protocol !== 'https:') throw new Error('目前仅支持 HTTPS API 地址')
  return url
}

function apiPathFor(url) {
  const basePath = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '')
  if (basePath.endsWith('/v1/chat/completions')) return basePath
  if (basePath.endsWith('/v1')) return `${basePath}/chat/completions`
  return `${basePath}/v1/chat/completions`
}

function decodeUtf8Chunks(chunks) {
  return Buffer.concat(chunks.map(chunk => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))).toString('utf8')
}

function hasDamagedContent(parsed) {
  const content = parsed?.choices?.[0]?.message?.content
  return typeof content === 'string'
    ? content.includes('\uFFFD')
    : JSON.stringify(content ?? '').includes('\uFFFD')
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new APIError('请求已取消', { code: 'ABORTED' }))
    }, { once: true })
  })
}

function requestOnce(apiConfig, bodyObj, label, { signal, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!apiConfig.apiKey) return reject(new APIError('API Key 为空'))
    if (!apiConfig.model) return reject(new APIError('模型名称为空'))
    let url
    try { url = normalizeAPIHost(apiConfig.apiHost) } catch (error) { reject(error); return }
    if (signal?.aborted) return reject(new APIError('请求已取消', { code: 'ABORTED' }))

    const body = JSON.stringify(bodyObj)
    const req = https.request({
      hostname: url.hostname, port: url.port || 443, path: apiPathFor(url), method: 'POST',
      headers: { Authorization: `Bearer ${apiConfig.apiKey}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, response => {
      const chunks = []
      response.on('data', chunk => { chunks.push(chunk) })
      response.on('end', () => {
        const data = decodeUtf8Chunks(chunks)
        const statusCode = response.statusCode || 0
        let parsed
        try { parsed = JSON.parse(data) } catch {
          reject(new APIError(`${label} 响应解析失败(${statusCode})：${data.slice(0, 180)}`, { statusCode, retryable: statusCode >= 500 }))
          return
        }
        if (statusCode >= 400 || parsed.error) {
          const detail = parsed.error?.message || parsed.message || JSON.stringify(parsed.error || parsed)
          reject(new APIError(`${label} 错误(${statusCode})：${detail}`, { statusCode, retryable: statusCode === 429 || statusCode >= 500 }))
          return
        }
        if (hasDamagedContent(parsed)) {
          reject(new APIError(`${label} 响应包含损坏字符，正在重新请求`, { statusCode, retryable: true, code: 'INVALID_UTF8' }))
          return
        }
        resolve(parsed)
      })
    })

    const abort = () => req.destroy(new APIError('请求已取消', { code: 'ABORTED' }))
    signal?.addEventListener('abort', abort, { once: true })
    req.on('error', error => {
      signal?.removeEventListener('abort', abort)
      if (error.code === 'ABORTED' || signal?.aborted) return reject(new APIError('请求已取消', { code: 'ABORTED' }))
      reject(new APIError(`${label} 网络错误：${error.message}`, { retryable: true, code: error.code }))
    })
    req.setTimeout(timeout, () => req.destroy(new APIError(`${label} 请求超时`, { retryable: true, code: 'TIMEOUT' })))
    req.write(body)
    req.end()
  })
}

async function postOpenAICompatible(apiConfig, bodyObj, label = 'API', options = {}) {
  const retries = Number.isInteger(options.retries) ? options.retries : 2
  let attempt = 0
  while (true) {
    try {
      return await requestOnce(apiConfig, bodyObj, label, options)
    } catch (error) {
      if (error.code === 'ABORTED' || !error.retryable || attempt >= retries) throw error
      attempt += 1
      options.onRetry?.({ attempt, error })
      await wait(500 * (2 ** (attempt - 1)), options.signal)
    }
  }
}

function cleanThinkTags(parsed) {
  const message = parsed.choices?.[0]?.message
  if (message && typeof message.content === 'string') message.content = message.content.replace(/<think[\s\S]*?<\/think>/g, '').trim()
}

module.exports = { APIError, postOpenAICompatible, cleanThinkTags, normalizeAPIHost, apiPathFor, decodeUtf8Chunks, hasDamagedContent }
