const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 应用信息 / 官网链接
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  openExternalUrl: (url) => ipcRenderer.invoke('open-external-url', url),


  // 红果解析与下载
  hongguoResolve: (input) => ipcRenderer.invoke('hongguo-resolve', input),
  hongguoDownloadBatch: (payload) => ipcRenderer.invoke('hongguo-download-batch', payload),

  // 设置
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  // 下载管理
  getDownloadTasks: () => ipcRenderer.invoke('get-download-tasks'),
  deleteTask: (taskId) => ipcRenderer.invoke('delete-task', taskId),
  deleteTasks: (taskIds) => ipcRenderer.invoke('delete-tasks', taskIds),
  stopDownload: (taskId) => ipcRenderer.invoke('stop-download', taskId),
  retryTask: (taskId) => ipcRenderer.invoke('retry-task', taskId),
  retryTasks: (taskIds) => ipcRenderer.invoke('retry-tasks', taskIds),
  openFolder: (taskId) => ipcRenderer.invoke('open-folder', taskId),

  // 事件监听
  onDownloadProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('download-progress', listener);
    return () => ipcRenderer.removeListener('download-progress', listener);
  },
  onDownloadTaskAdded: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('download-task-added', listener);
    return () => ipcRenderer.removeListener('download-task-added', listener);
  },
  onDownloadCompleted: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('download-completed', listener);
    return () => ipcRenderer.removeListener('download-completed', listener);
  },
  onDownloadFailed: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('download-failed', listener);
    return () => ipcRenderer.removeListener('download-failed', listener);
  },
  onDownloadStopped: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('download-stopped', listener);
    return () => ipcRenderer.removeListener('download-stopped', listener);
  },
});
