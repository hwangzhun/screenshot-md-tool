/**
 * preload.js - 预加载脚本
 * 通过 contextBridge 将主进程能力安全暴露给渲染进程
 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  /**
   * 读取图片文件并转为 base64 Data URI
   * @param {string} filePath - 文件绝对路径
   * @returns {Promise<{success: boolean, data?: string, error?: string}>}
   */
  readImageAsBase64: (filePath) =>
    ipcRenderer.invoke('read-image-base64', filePath),

  /**
   * 调用视觉识别 API（腾讯云混元视觉 API，OpenAI 兼容）
   * @param {object} apiConfig - API 配置对象 { apiKey, apiHost, model }
   * @param {string[]} base64Images - base64 图片数组（含 data URI 前缀）
   * @returns {Promise<{success: boolean, data?: object, error?: string}>}
   */
  callVisionAPI: (apiConfig, base64Images) =>
    ipcRenderer.invoke('call-vision-api', apiConfig, base64Images),

  /**
   * 先对图片做 OCR，返回每张截图的原始文本。
   * @param {string[]} filePaths - 图片文件绝对路径
   * @param {object} ocrConfig - OCR 配置，如 { lang: 'chi_sim+eng' }
   */
  recognizeImagesOCR: (filePaths, ocrConfig) =>
    ipcRenderer.invoke('recognize-images-ocr', filePaths, ocrConfig),

  /**
   * 将 OCR 文本发送给文本模型，整理为 Markdown。
   * @param {object} apiConfig - API 配置对象 { apiKey, apiHost, model }
   * @param {object[]} ocrPages - OCR 页数组
   */
  organizeOCRText: (apiConfig, ocrPages) =>
    ipcRenderer.invoke('organize-ocr-text', apiConfig, ocrPages),

  /**
   * 保存 Markdown 文件（触发系统保存对话框）
   * @param {string} content - Markdown 文本内容
   * @returns {Promise<{success: boolean, filePath?: string, canceled?: boolean, error?: string}>}
   */
  saveMDFile: (content) =>
    ipcRenderer.invoke('save-md-file', content),

  /**
   * 打开文件选择对话框（多选图片）
   * @returns {Promise<{success: boolean, filePaths?: string[], canceled?: boolean, error?: string}>}
   */
  openFileDialog: () =>
    ipcRenderer.invoke('open-file-dialog'),

  // ── 窗口控制（自定义标题栏） ──
  winMinimize: () => ipcRenderer.invoke('win-minimize'),
  winMaximize: () => ipcRenderer.invoke('win-maximize'),
  winClose: () => ipcRenderer.invoke('win-close'),
  winIsMaximized: () => ipcRenderer.invoke('win-is-maximized'),
  onMaximizeStateChanged: (callback) => {
    ipcRenderer.on('maximize-state-changed', (_event, isMaximized) => callback(isMaximized))
  }
})
