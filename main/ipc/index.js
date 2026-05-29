/**
 * main/ipc/index.js
 * 统一注册所有 IPC 处理器
 */

const { ipcMain } = require('electron')
const { readImageAsBase64 } = require('../utils/image')
const { recognizeImagesCloudOCR } = require('../services/ocr')
const { organizeOCRText } = require('../services/organize')

let mainWindowRef = null

function setMainWindow(win) {
  mainWindowRef = win
}

function getMainWindow() {
  return mainWindowRef
}

function registerIpc() {
  // 读取图片文件并转为 base64
  ipcMain.handle('read-image-base64', async (event, filePath) => {
    return readImageAsBase64(filePath)
  })

  // 调用云端视觉 API 识别图片文字
  ipcMain.handle('recognize-images-cloud-ocr', async (event, filePaths, cloudConfig = {}) => {
    try {
      const result = await recognizeImagesCloudOCR(filePaths, cloudConfig)
      return { success: true, data: result }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  // 将 OCR 文本发送给文本模型整理为 Markdown
  ipcMain.handle('organize-ocr-text', async (event, apiConfig, ocrPages) => {
    try {
      const result = await organizeOCRText(apiConfig, ocrPages)
      return { success: true, data: result }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })
}

module.exports = { registerIpc, setMainWindow, getMainWindow }