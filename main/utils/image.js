/**
 * main/utils/image.js
 * 图片读写与 MIME 类型工具
 */

const path = require('path')
const fs = require('fs')

const MIME_MAP = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp'
}

function getMime(ext) {
  return MIME_MAP[ext.toLowerCase().replace('.', '')] || 'image/jpeg'
}

function readImageAsBase64(filePath) {
  try {
    const buffer = fs.readFileSync(filePath)
    const ext = path.extname(filePath).toLowerCase().replace('.', '')
    const mime = getMime(ext)
    const base64 = buffer.toString('base64')
    return { success: true, data: `data:${mime};base64,${base64}` }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath)
  } catch {
    return false
  }
}

module.exports = { getMime, readImageAsBase64, fileExists }