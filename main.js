/**
 * main.js - Electron 主进程入口
 * 负责窗口管理，其他业务逻辑委托给 main/ipc 和 main/services
 */

const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const { version: appVersion } = require('./package.json')
const { registerIpc, setMainWindow } = require('./main/ipc')

let mainWindow = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#111113',
    frame: false,
    icon: path.join(__dirname, 'build/icons/icons/png/256x256.png'),
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

  // 注册窗口事件监听（用于通知渲染进程最大化状态变化）
  mainWindow.on('maximize', () => watchMaximize())
  mainWindow.on('unmaximize', () => watchMaximize())

  setMainWindow(mainWindow)
}

let lastMaxState = false
function watchMaximize() {
  if (!mainWindow) return
  const cur = mainWindow.isMaximized()
  if (cur !== lastMaxState) {
    lastMaxState = cur
    mainWindow.webContents.send('maximize-state-changed', cur)
  }
}

function formatDate() {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}${m}${d}`
}

app.whenReady().then(() => {
  createWindow()
  registerIpc()

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
// IPC: 应用版本
// ─────────────────────────────────────────────────────────
ipcMain.handle('get-app-version', () => appVersion)

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