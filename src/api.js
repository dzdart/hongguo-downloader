/**
 * api.js - 前端与服务端通信层
 * 用 fetch + SSE（EventSource）替代原 Electron IPC 桥，适配 Web 部署。
 */

async function request(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  return res.json().catch(() => ({}));
}

export const api = {
  // 应用信息
  getAppInfo: () => request('/api/app-info'),

  // 红果解析与下载
  hongguoResolve: (input) => request('/api/resolve', { method: 'POST', body: JSON.stringify({ input }) }),
  hongguoDownloadBatch: (payload) => request('/api/download', { method: 'POST', body: JSON.stringify(payload) }),

  // 设置
  getSettings: () => request('/api/settings'),
  saveSettings: (settings) => request('/api/settings', { method: 'POST', body: JSON.stringify(settings) }),

  // 文件系统目录浏览（网页版文件夹选择器）
  listDir: (dirPath) => request('/api/fs/list?path=' + encodeURIComponent(dirPath || '/')),

  // 下载管理
  getDownloadTasks: () => request('/api/tasks'),
  deleteTask: (taskId) => request('/api/tasks/' + encodeURIComponent(taskId), { method: 'DELETE' }),
  deleteTasks: (taskIds) => request('/api/tasks', { method: 'DELETE', body: JSON.stringify({ ids: taskIds }) }),
  stopDownload: (taskId) => request('/api/tasks/' + encodeURIComponent(taskId) + '/stop', { method: 'POST' }),
  retryTask: (taskId) => request('/api/tasks/' + encodeURIComponent(taskId) + '/retry', { method: 'POST' }),
  retryTasks: (taskIds) => request('/api/tasks/retry', { method: 'POST', body: JSON.stringify({ ids: taskIds }) }),

  /**
   * 订阅下载实时事件（SSE）
   * @param {object} callbacks { onDownloadProgress, onDownloadTaskAdded, onDownloadCompleted, onDownloadFailed, onDownloadStopped }
   * @returns {function} 取消订阅函数
   */
  subscribe(callbacks = {}) {
    const es = new EventSource('/api/events');
    const bind = (name, fn) => {
      es.addEventListener(name, (e) => {
        try {
          fn(JSON.parse(e.data));
        } catch (_) {
          fn({});
        }
      });
    };
    if (callbacks.onDownloadProgress) bind('download-progress', callbacks.onDownloadProgress);
    if (callbacks.onDownloadTaskAdded) bind('download-task-added', callbacks.onDownloadTaskAdded);
    if (callbacks.onDownloadCompleted) bind('download-completed', callbacks.onDownloadCompleted);
    if (callbacks.onDownloadFailed) bind('download-failed', callbacks.onDownloadFailed);
    if (callbacks.onDownloadStopped) bind('download-stopped', callbacks.onDownloadStopped);
    return () => es.close();
  },
};
