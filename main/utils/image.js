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

function getResizeDimensions(width, height, maxDimension = 2400) {
  const largest = Math.max(width, height)
  if (!largest || largest <= maxDimension) return { width, height, resized: false }
  const scale = maxDimension / largest
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    resized: true
  }
}

function prepareUploadCopy(sourcePath, uploadDir, imageId, maxDimension = 2400) {
  const { nativeImage } = require('electron')
  const image = nativeImage.createFromPath(sourcePath)
  if (image.isEmpty()) throw new Error('无法读取图片尺寸')
  const size = image.getSize()
  const target = getResizeDimensions(size.width, size.height, maxDimension)
  if (!target.resized) {
    return { uploadPath: sourcePath, width: size.width, height: size.height, uploadBytes: 0, resized: false }
  }
  fs.mkdirSync(uploadDir, { recursive: true })
  const uploadPath = path.join(uploadDir, `${imageId}.png`)
  const resized = image.resize({ width: target.width, height: target.height, quality: 'best' })
  fs.writeFileSync(uploadPath, resized.toPNG())
  return {
    uploadPath,
    width: size.width,
    height: size.height,
    uploadBytes: fs.statSync(uploadPath).size,
    resized: true
  }
}

module.exports = { getMime, readImageAsBase64, fileExists, getResizeDimensions, prepareUploadCopy }
