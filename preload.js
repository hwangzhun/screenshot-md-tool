const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
  saveMDFile: content => ipcRenderer.invoke('save-md-file', content),

  listTasks: () => ipcRenderer.invoke('tasks-list'),
  createTask: name => ipcRenderer.invoke('task-create', name),
  loadTask: id => ipcRenderer.invoke('task-load', id),
  updateTask: (id, patch) => ipcRenderer.invoke('task-update', id, patch),
  deleteTask: id => ipcRenderer.invoke('task-delete', id),
  importTaskImages: (id, paths) => ipcRenderer.invoke('task-import-images', id, paths),
  removeTaskImage: (id, imageId) => ipcRenderer.invoke('task-remove-image', id, imageId),
  getTaskImageData: (id, imageId) => ipcRenderer.invoke('task-image-data', id, imageId),
  undoOrganize: id => ipcRenderer.invoke('task-undo-organize', id),

  startOCR: (taskId, imageIds) => ipcRenderer.invoke('job-start-ocr', taskId, imageIds),
  retryOCR: (taskId, imageIds) => ipcRenderer.invoke('job-start-ocr', taskId, imageIds),
  organizeTask: (taskId, allowFailures = false, groupIds) => ipcRenderer.invoke('job-start-organize', taskId, allowFailures, groupIds),
  updateGroups: (taskId, groups) => ipcRenderer.invoke('group-update', taskId, groups),
  cancelJob: jobId => ipcRenderer.invoke('job-cancel', jobId),
  onJobProgress: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('job-progress', listener)
    return () => ipcRenderer.removeListener('job-progress', listener)
  },

  getSettings: () => ipcRenderer.invoke('settings-get'),
  saveSettings: input => ipcRenderer.invoke('settings-save', input),
  migrateLegacySettings: legacy => ipcRenderer.invoke('settings-migrate', legacy),
  testApiConfig: (kind, draft) => ipcRenderer.invoke('settings-test', kind, draft),

  winMinimize: () => ipcRenderer.invoke('win-minimize'),
  winMaximize: () => ipcRenderer.invoke('win-maximize'),
  winClose: () => ipcRenderer.invoke('win-close'),
  winIsMaximized: () => ipcRenderer.invoke('win-is-maximized'),
  onMaximizeStateChanged: callback => {
    const listener = (_event, state) => callback(state)
    ipcRenderer.on('maximize-state-changed', listener)
    return () => ipcRenderer.removeListener('maximize-state-changed', listener)
  }
})
