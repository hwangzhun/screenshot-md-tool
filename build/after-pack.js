/**
 * build/after-pack.js
 * electron-builder afterPack 钩子：打包后裁剪不必要的资源
 * - 仅保留 en-US / zh-CN locale（其他语言包全删）
 * - 保留所有核心运行时文件（ffmpeg, resources.pak, icudtl.dat, chrome_*.pak 及关键 DLL）
 */
const path = require('path')
const fs = require('fs')

// 仅保留的 locales，白名单机制
const KEEP_LOCALES = ['en-US.pak', 'zh-CN.pak']

exports.default = async function afterPack(context) {
  const unpackedDir = path.join(context.appOutDir, 'locales')
  if (!fs.existsSync(unpackedDir)) return

  const entries = fs.readdirSync(unpackedDir)
  let removed = 0
  for (const entry of entries) {
    if (entry.endsWith('.pak') && !KEEP_LOCALES.includes(entry)) {
      try {
        fs.unlinkSync(path.join(unpackedDir, entry))
        removed++
      } catch {}
    }
  }

  if (removed > 0) {
    const { execSync } = require('child_process')
    try {
      // 同步目录时间戳，帮助压缩算法更高效
      const dirStat = fs.statSync(unpackedDir)
      fs.utimesSync(unpackedDir, dirStat.atime, dirStat.mtime)
    } catch {}
    console.log(`[afterPack] removed ${removed} locale file(s), kept: ${KEEP_LOCALES.join(', ')}`)
  }
}