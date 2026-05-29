/**
 * main/services/http-openai.js
 * OpenAI 兼容 HTTP 请求封装
 */

const https = require('https')

function normalizeAPIHost(apiHost) {
  const raw = String(apiHost).trim()
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  const url = new URL(withProtocol)
  if (url.protocol !== 'https:') {
    throw new Error('目前仅支持 HTTPS API 地址')
  }
  return url
}

function postOpenAICompatible(apiConfig, bodyObj, label = 'API') {
  return new Promise((res, rej) => {
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

function cleanThinkTags(parsed) {
  if (parsed.choices && parsed.choices[0] && parsed.choices[0].message) {
    const content = parsed.choices[0].message.content || ''
    parsed.choices[0].message.content = content.replace(/<think[\s\S]*?<\/think>/g, '').trim()
  }
}

module.exports = { postOpenAICompatible, cleanThinkTags, normalizeAPIHost }