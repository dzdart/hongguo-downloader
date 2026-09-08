/**
 * main.js - 红果短剧下载器（独立版）主进程
 *
 * 功能：
 *   1. 红果短剧解析（分享链接 / series_id -> 全剧集列表）
 *   2. 批量提交下载任务到下载队列
 *   3. 并发下载：流式下载播放直链 -> spade_a 派生 AES Key -> CENC-AES-CTR 解密 -> 输出 mp4
 *   4. 下载管理：进度推送、暂停/取消、重试、删除、打开所在文件夹
 *   5. 设置：下载目录、命名规则、并发数（JSON 文件持久化）
 */
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

const hongguo = require('./src/native/hongguo');
const store = require('./src/store');
const APP_VERSION = app.getVersion() || '1.0.0';

const APP_TITLE = '小菜鸟 软件';
const OFFICIAL_WEBSITE = 'https://111330.com';

let mainWindow = null;


// ===== 下载任务管理 =====
let downloadTasks = [];
let downloadQueue = [];
let activeDownloads = 0;
let MAX_CONCURRENT_DOWNLOADS = 3;

// ===== 设置 =====
function getDefaultSettings() {
  return {
    root: app.getPath('downloads'),
    // 文件命名模板：可用变量 剧名(series_title) 集数(vid_index) 标题(ep_title)
    name_format: '剧名 集数',
    max_concurrent: 3,
  };
}

function getCurrentSettings() {
  const saved = store.getSettings() || {};
  const merged = { ...getDefaultSettings(), ...saved };
  // 保证并发数合法
  const mc = parseInt(merged.max_concurrent, 10);
  MAX_CONCURRENT_DOWNLOADS = Number.isInteger(mc) && mc >= 1 && mc <= 10 ? mc : 3;
  return { ...merged, max_concurrent: MAX_CONCURRENT_DOWNLOADS };
}

// 净化文件夹/文件名称（移除非法字符、结尾的点和空格）
function sanitizeFolderName(name) {
  return String(name || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 80) || '';
}

// 按命名模板渲染文件名，返回 名称(不含扩展名) 或 null
function renderName(format, seriesTitle, vidIndex, epTitle) {
  const fmt = String(format || '').trim();
  if (!fmt) return null;
  const vars = {
    'series_title': String(seriesTitle || '').trim(),
    'vid_index': String(vidIndex).padStart(3, '0'),
    'ep_title': String(epTitle || '').trim(),
  };
  const zhMap = {
    '剧名': 'series_title',
    '集数': 'vid_index',
    '标题': 'ep_title',
  };
  const zhRe = /剧名|集数|标题/g;
  let name = fmt
    .replace(zhRe, (w) => zhMap[w] || w)
    .replace(/([A-Za-z]+(?:_[A-Za-z]+)*)/g, (tok) => (vars[tok] !== undefined ? (vars[tok] || '') : tok));
  name = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim();
  return name || null;
}

// ===== 加载/保存下载任务 =====
function loadDownloadTasks() {
  const saved = store.getTasks() || [];
  saved.sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
  downloadTasks = saved.map((task) => {
    const inProgress = task.status === 'downloading' || task.status === 'pending';
    return {
      ...task,
      status: inProgress ? 'failed' : task.status,
      error: inProgress ? '应用关闭时任务中断' : task.error,
    };
  });
}

function saveDownloadTasks() {
  const serializable = downloadTasks.map((task) => {
    const { cancelSource, writer, ...rest } = task;
    return rest;
  });
  store.saveTasks(serializable);
}

// ===== 下载队列调度（并发 MAX_CONCURRENT_DOWNLOADS） =====
async function processDownloadQueue() {
  if (activeDownloads >= MAX_CONCURRENT_DOWNLOADS || downloadQueue.length === 0) return;
  const task = downloadQueue.shift();
  if (!task) return;
  activeDownloads++;
  try {
    await executeDownload(task);
  } catch (error) {
    console.error('[Download Queue] 下载失败:', error);
  } finally {
    activeDownloads--;
    processDownloadQueue();
  }
}

// ===== 下载分发 =====
async function executeDownload(task) {
  if (task.type === 'hongguo') {
    await executeHongguoDownload(task);
    return;
  }
  throw new Error('未知任务类型: ' + task.type);
}

// ===== 红果短剧下载 =====
async function executeHongguoDownload(task) {
  const { id, hongguoInfo, filename } = task;
  const { vid, series_title, vid_index } = hongguoInfo || {};

  try {
    console.log(`[Hongguo] 开始下载《${series_title}》第${vid_index}集:`, vid);
    task.status = 'downloading';
    task.progress = 0;
    sendToRenderer('download-progress', { id, progress: 0, receivedBytes: 0, totalBytes: 0 });

    // 1. 获取播放直链与 spade_a 加密信息
    const playInfo = await hongguo.fetchPlayUrlSingle(vid);
    if (!playInfo || !playInfo.url) {
      throw new Error('未获取到有效播放地址');
    }

    // 2. 下载目录
    const settings = getCurrentSettings();
    const root = (settings.root && String(settings.root).trim()) ? String(settings.root).trim() : app.getPath('downloads');
    const seriesFolder = sanitizeFolderName(series_title) || '未命名短剧';
    const downloadDir = task.customDir || path.join(root, '红果短剧', seriesFolder);
    fs.mkdirSync(downloadDir, { recursive: true });

    const finalPath = task.savePath || path.join(downloadDir, filename);
    task.savePath = finalPath;

    // 目标已存在且大小合格，跳过重下
    if (fs.existsSync(finalPath) && fs.statSync(finalPath).size > 1024 * 100) {
      console.log('[Hongguo] 文件已存在，直接完成:', finalPath);
      task.status = 'completed';
      task.progress = 100;
      task.endTime = Date.now();
      saveDownloadTasks();
      sendToRenderer('download-completed', { id, path: finalPath });
      return;
    }

    const tmpPath = finalPath + '.enc.tmp';

    // 3. HTTP 流式下载
    const CancelToken = axios.CancelToken;
    const source = CancelToken.source();
    task.cancelSource = source;

    let headers = { "User-Agent": hongguo.UA };
    let response;
    try {
      response = await axios({
        method: 'GET', url: playInfo.url, responseType: 'stream',
        headers, timeout: 60000, cancelToken: source.token,
      });
    } catch (err) {
      if (err.response && err.response.status === 403) {
        headers["Referer"] = hongguo.VIDEO_REFERER;
        response = await axios({
          method: 'GET', url: playInfo.url, responseType: 'stream',
          headers, timeout: 60000, cancelToken: source.token,
        });
      } else {
        throw err;
      }
    }

    const totalLength = parseInt(response.headers['content-length'], 10) || 0;
    task.totalBytes = totalLength;

    const writer = fs.createWriteStream(tmpPath);
    task.writer = writer;

    let received = 0;
    response.data.on('data', (chunk) => {
      received += chunk.length;
      task.receivedBytes = received;
      const progress = totalLength ? Math.floor((received / totalLength) * 100) : 0;
      task.progress = progress;
      sendToRenderer('download-progress', { id, progress, receivedBytes: received, totalBytes: totalLength });
    });

    response.data.pipe(writer);
    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    delete task.cancelSource;
    delete task.writer;

    if (task.cancelled) {
      if (fs.existsSync(tmpPath)) try { fs.unlinkSync(tmpPath); } catch (_) {}
      task.status = 'stopped';
      task.endTime = Date.now();
      saveDownloadTasks();
      sendToRenderer('download-stopped', { id });
      return;
    }

    // 4. CENC-AES-CTR 解密
    if (playInfo.spadeA) {
      console.log('[Hongguo] 正在派生 AES Key 并解密 MP4...');
      const key = hongguo.deriveKey(playInfo.spadeA);
      if (!key) {
        throw new Error('Key 派生失败');
      }
      hongguo.decryptMp4File(tmpPath, finalPath, key);
      try { fs.unlinkSync(tmpPath); } catch (_) {}
    } else {
      fs.renameSync(tmpPath, finalPath);
    }

    task.status = 'completed';
    task.progress = 100;
    task.endTime = Date.now();
    saveDownloadTasks();

    console.log('[Hongguo] 下载完成:', finalPath);
    sendToRenderer('download-completed', { id, path: finalPath });
  } catch (error) {
    console.error('[Hongguo] 下载失败:', error.message);
    delete task.cancelSource;
    delete task.writer;
    task.status = 'failed';
    task.error = error.message;
    saveDownloadTasks();
    sendToRenderer('download-failed', { id, error: error.message });
  }
}

// 向渲染进程发送事件
function sendToRenderer(channel, payload) {
  if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// ===== IPC：红果解析与批量下载 =====
ipcMain.handle('hongguo-resolve', async (event, input) => {
  try {
    const seriesId = await hongguo.resolveSeriesId(input);
    const data = await hongguo.fetchEpisodeList(seriesId);
    return { success: true, data };
  } catch (error) {
    console.error('[Hongguo] 解析失败:', error.message);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('hongguo-download-batch', async (event, payload) => {
  try {
    const { seriesId, seriesTitle, episodes } = payload || {};
    if (!Array.isArray(episodes) || episodes.length === 0) {
      return { success: false, error: '未选择集数' };
    }

    const settings = getCurrentSettings();
    const root = (settings.root && String(settings.root).trim()) ? String(settings.root).trim() : app.getPath('downloads');
    const cleanSeriesTitle = sanitizeFolderName(seriesTitle) || '红果短剧';
    const downloadDir = path.join(root, '红果短剧', cleanSeriesTitle);
    try { fs.mkdirSync(downloadDir, { recursive: true }); } catch (_) {}

    const batchId = 'hongguobatch_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    const firstCover = (episodes[0] && episodes[0].cover) || '';

    const batchInfo = {
      batchId,
      platform: 'hongguo',
      nickname: `《${cleanSeriesTitle}》`,
      avatar: firstCover,
      totalCount: episodes.length,
      createTime: Date.now(),
    };

    for (const ep of episodes) {
      const taskId = Date.now().toString() + Math.random().toString(36).substr(2, 9);
      const epIndexStr = String(ep.vid_index).padStart(3, '0');
      const namePart = renderName(settings.name_format, cleanSeriesTitle, ep.vid_index, ep.title);
      const baseName = namePart || `${cleanSeriesTitle}_第${epIndexStr}集`;
      const filename = `${baseName}.mp4`;
      const finalPath = path.join(downloadDir, filename);

      const task = {
        id: taskId,
        batchId,
        batchInfo,
        savePath: finalPath,
        customDir: downloadDir,
        title: `《${cleanSeriesTitle}》第${epIndexStr}集${ep.title ? ' ' + ep.title : ''}`,
        filename,
        platform: 'hongguo',
        type: 'hongguo',
        status: 'pending',
        progress: 0,
        receivedBytes: 0,
        totalBytes: 0,
        startTime: Date.now(),
        videoInfo: {
          author: cleanSeriesTitle,
          title: `《${cleanSeriesTitle}》第${epIndexStr}集`,
          cover: ep.cover || firstCover,
          aweme_id: ep.vid,
        },
        hongguoInfo: {
          vid: ep.vid,
          series_id: seriesId,
          series_title: cleanSeriesTitle,
          vid_index: ep.vid_index,
          ep_title: ep.title,
        },
      };

      downloadTasks.unshift(task);
      downloadQueue.push(task);
      sendToRenderer('download-task-added', task);
    }

    saveDownloadTasks();
    processDownloadQueue();

    return { success: true, count: episodes.length };
  } catch (error) {
    console.error('[Hongguo] 提交批量下载失败:', error.message);
    return { success: false, error: error.message };
  }
});

// ===== IPC：设置 =====
ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  if (result.canceled) return null;
  return result.filePaths[0];
});

ipcMain.handle('get-settings', async () => getCurrentSettings());

ipcMain.handle('save-settings', async (event, settings) => {
  try {
    const merged = { ...getDefaultSettings(), ...(settings || {}) };
    store.saveSettings(merged);
    getCurrentSettings(); // 刷新并发数
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// ===== IPC：下载管理 =====
ipcMain.handle('get-download-tasks', () => {
  const STATUS_ORDER = {
    downloading: 0,
    pending: 1,
    failed: 2,
    stopped: 3,
    completed: 4,
  };
  const sorted = downloadTasks.slice().sort((a, b) => {
    const wa = STATUS_ORDER[a.status] ?? 99;
    const wb = STATUS_ORDER[b.status] ?? 99;
    if (wa !== wb) return wa - wb;
    if (wa <= 1) {
      return (a.hongguoInfo?.vid_index || 0) - (b.hongguoInfo?.vid_index || 0) || (a.startTime || 0) - (b.startTime || 0);
    }
    return (b.endTime || b.startTime || 0) - (a.endTime || a.startTime || 0);
  });
  return sorted.map((task) => {
    const { cancelSource, writer, ...serializableTask } = task;
    return serializableTask;
  });
});


ipcMain.handle('delete-task', async (event, taskId) => {
  const taskIndex = downloadTasks.findIndex((t) => t.id === taskId);
  if (taskIndex === -1) return { success: false, error: '任务不存在' };

  const task = downloadTasks[taskIndex];
  if (task.status === 'downloading') {
    task.cancelled = true;
    if (task.cancelSource) {
      try { task.cancelSource.cancel('用户删除任务'); } catch (_) {}
    }
    if (task.writer) {
      try { task.writer.end(); } catch (_) {}
    }
  }

  downloadTasks.splice(taskIndex, 1);
  // 从队列移除
  const qIndex = downloadQueue.findIndex((t) => t.id === taskId);
  if (qIndex !== -1) downloadQueue.splice(qIndex, 1);

  saveDownloadTasks();
  return { success: true };
});

ipcMain.handle('delete-tasks', async (event, taskIds) => {
  if (!Array.isArray(taskIds) || taskIds.length === 0) return { success: false, error: '没有要删除的任务' };
  for (const id of taskIds) {
    deleteOneTask(id);
  }
  saveDownloadTasks();
  return { success: true, count: taskIds.length };
});

async function deleteOneTask(taskId) {
  const taskIndex = downloadTasks.findIndex((t) => t.id === taskId);
  if (taskIndex === -1) return;
  const task = downloadTasks[taskIndex];
  if (task.status === 'downloading') {
    task.cancelled = true;
    if (task.cancelSource) { try { task.cancelSource.cancel('用户删除任务'); } catch (_) {} }
    if (task.writer) { try { task.writer.end(); } catch (_) {} }
  }
  downloadTasks.splice(taskIndex, 1);
  const qIndex = downloadQueue.findIndex((t) => t.id === taskId);
  if (qIndex !== -1) downloadQueue.splice(qIndex, 1);
}

ipcMain.handle('stop-download', async (event, taskId) => {
  const task = downloadTasks.find((t) => t.id === taskId);
  if (!task) return { success: false, error: '任务不存在' };

  task.cancelled = true;
  if (task.cancelSource) { try { task.cancelSource.cancel('用户停止下载'); } catch (_) {} }
  if (task.writer) { try { task.writer.end(); } catch (_) {} }

  task.status = 'stopped';
  task.error = '';
  task.endTime = Date.now();
  delete task.cancelSource;
  delete task.writer;

  saveDownloadTasks();
  sendToRenderer('download-stopped', { id: taskId, path: task.savePath });
  return { success: true };
});

ipcMain.handle('retry-task', async (event, taskId) => {
  const task = downloadTasks.find((t) => t.id === taskId);
  if (!task) return { success: false, error: '任务不存在' };

  if (task.savePath && fs.existsSync(task.savePath)) {
    try { fs.unlinkSync(task.savePath); } catch (_) {}
  }

  task.status = 'pending';
  task.progress = 0;
  task.receivedBytes = 0;
  task.totalBytes = 0;
  task.cancelled = false;
  delete task.error;
  delete task.cancelSource;
  delete task.writer;

  if (!downloadQueue.some((t) => t.id === taskId)) downloadQueue.push(task);
  saveDownloadTasks();
  processDownloadQueue();
  return { success: true };
});

ipcMain.handle('retry-tasks', async (event, taskIds) => {
  if (!Array.isArray(taskIds) || taskIds.length === 0) return { success: false, error: '没有要重试的任务' };
  let count = 0;
  for (const taskId of taskIds) {
    const task = downloadTasks.find((t) => t.id === taskId);
    if (task && (task.status === 'failed' || task.status === 'stopped')) {
      if (task.savePath && fs.existsSync(task.savePath)) {
        try { fs.unlinkSync(task.savePath); } catch (_) {}
      }
      task.status = 'pending';
      task.progress = 0;
      task.receivedBytes = 0;
      task.totalBytes = 0;
      task.cancelled = false;
      delete task.error;
      delete task.cancelSource;
      delete task.writer;
      if (!downloadQueue.some((t) => t.id === taskId)) downloadQueue.push(task);
      count++;
    }
  }
  if (count > 0) {
    saveDownloadTasks();
    processDownloadQueue();
  }
  return { success: true, count };
});

ipcMain.handle('open-folder', async (event, taskId) => {
  const task = downloadTasks.find((t) => t.id === taskId);
  if (!task) return { success: false, error: '任务不存在' };

  if (task.customDir && fs.existsSync(task.customDir)) {
    await shell.openPath(task.customDir);
    return { success: true };
  }
  if (task.savePath && fs.existsSync(task.savePath)) {
    const isDir = fs.statSync(task.savePath).isDirectory();
    if (isDir) {
      await shell.openPath(task.savePath);
    } else {
      shell.showItemInFolder(task.savePath);
    }
    return { success: true };
  }
  if (task.savePath) {
    const parentDir = path.dirname(task.savePath);
    if (fs.existsSync(parentDir)) {
      await shell.openPath(parentDir);
      return { success: true };
    }
  }
  return { success: false, error: '文件夹不存在' };
});

// ===== 官网外链与应用信息 =====
// 获取应用信息（版本、品牌、官网链接）
ipcMain.handle('get-app-info', async () => ({
  version: APP_VERSION,
  brand: APP_TITLE,
  appName: '红果短剧下载器',
  official_website: OFFICIAL_WEBSITE,
}));

// 打开外部链接
ipcMain.handle('open-external-url', async (event, url) => {
  const target = url || OFFICIAL_WEBSITE;
  try {
    await shell.openExternal(target);
    return { success: true };
  } catch (err) {
    console.error('[Shell] 打开链接失败:', err.message);
    return { success: false, error: err.message };
  }
});

// ===== 窗口创建 =====
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 900,
    minHeight: 620,
    title: APP_TITLE + ' - 红果短剧下载器',
    autoHideMenuBar: true,
    backgroundColor: '#f5f6fa',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);

  // 开发模式加载 vite dev server，生产模式加载打包产物
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, 'dist-react', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ===== 应用生命周期 =====
app.whenReady().then(() => {
  const dataFile = path.join(app.getPath('userData'), 'data.json');
  store.init(dataFile);
  loadDownloadTasks();
  getCurrentSettings();

  createWindow();

  // 启动时强制在默认浏览器中弹窗打开官网
  setTimeout(() => {
    shell.openExternal(OFFICIAL_WEBSITE).catch((e) => {
      console.error('[Website] 自动打开官网失败:', e.message);
    });
  }, 1000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
