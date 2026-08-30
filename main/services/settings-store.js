const fs = require('fs')
const path = require('path')

const DEFAULT_SETTINGS = {
  settingsVersion: 3,
  theme: 'light',
  ocrApi: { apiHost: '', model: '' },
  llmApi: { apiHost: '', model: '' }
}

function atomicWriteJSON(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(temporary, filePath)
}

class SettingsStore {
  constructor(filePath, safeStorage) {
    this.filePath = filePath
    this.safeStorage = safeStorage
    this.sessionKeys = { ocrApi: '', llmApi: '' }
  }

  readRaw() {
    try {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(this.filePath, 'utf8')) }
    } catch {
      return { ...DEFAULT_SETTINGS }
    }
  }

  canEncrypt() {
    try {
      return !!this.safeStorage?.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  decrypt(value) {
    if (!value || !this.canEncrypt()) return ''
    try {
      return this.safeStorage.decryptString(Buffer.from(value, 'base64'))
    } catch {
      return ''
    }
  }

  publicSettings() {
    const raw = this.readRaw()
    const apiView = (kind) => ({
      apiHost: raw[kind]?.apiHost || '',
      model: raw[kind]?.model || '',
      hasApiKey: !!(this.sessionKeys[kind] || this.decrypt(raw[kind]?.encryptedApiKey))
    })
    return {
      settingsVersion: 3,
      theme: 'light',
      ocrApi: apiView('ocrApi'),
      llmApi: apiView('llmApi'),
      encryptionAvailable: this.canEncrypt(),
      warning: this.canEncrypt() ? '' : '系统安全存储不可用，API Key 仅在本次运行期间保留'
    }
  }

  save(input = {}) {
    const raw = this.readRaw()
    raw.settingsVersion = 3
    raw.theme = 'light'

    for (const kind of ['ocrApi', 'llmApi']) {
      const next = input[kind] || {}
      raw[kind] = { ...(raw[kind] || {}) }
      if (typeof next.apiHost === 'string') raw[kind].apiHost = next.apiHost.trim()
      if (typeof next.model === 'string') raw[kind].model = next.model.trim()
      if (typeof next.apiKey === 'string' && next.apiKey.trim()) {
        const key = next.apiKey.trim()
        if (this.canEncrypt()) {
          raw[kind].encryptedApiKey = this.safeStorage.encryptString(key).toString('base64')
          this.sessionKeys[kind] = ''
        } else {
          delete raw[kind].encryptedApiKey
          this.sessionKeys[kind] = key
        }
      }
      if (next.clearApiKey === true) {
        delete raw[kind].encryptedApiKey
        this.sessionKeys[kind] = ''
      }
    }

    if (input.copyOcrToLlm) {
      raw.llmApi.apiHost = raw.ocrApi.apiHost
      raw.llmApi.model = raw.ocrApi.model
      if (raw.ocrApi.encryptedApiKey) raw.llmApi.encryptedApiKey = raw.ocrApi.encryptedApiKey
      this.sessionKeys.llmApi = this.sessionKeys.ocrApi
    }

    atomicWriteJSON(this.filePath, raw)
    return this.publicSettings()
  }

  migrateLegacy(legacy = {}) {
    const current = this.publicSettings()
    if (current.ocrApi.hasApiKey || current.llmApi.hasApiKey) return current
    const normalized = legacy.ocrApi ? legacy : {
      theme: legacy.theme,
      ocrApi: { apiKey: legacy.apiKey, apiHost: legacy.apiHost, model: legacy.model },
      llmApi: { apiKey: legacy.apiKey, apiHost: legacy.apiHost, model: legacy.model }
    }
    return this.save(normalized)
  }

  getApiConfig(kind) {
    const raw = this.readRaw()
    const stored = raw[kind] || {}
    return {
      apiHost: stored.apiHost || '',
      model: stored.model || '',
      apiKey: this.sessionKeys[kind] || this.decrypt(stored.encryptedApiKey)
    }
  }
}

module.exports = { SettingsStore, DEFAULT_SETTINGS, atomicWriteJSON }
