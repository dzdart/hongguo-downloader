/**
 * server.js - 红果短剧下载器 Web 服务端
 *
 * 功能：
 *   1. 提供 Web 页面（dist-react 构建产物）
 *   2. 红果短剧解析（分享链接 / series_id -> 全剧集列表）
 *   3. 批量提交下载任务到下载队列
 *   4. 并发下载：流式下载播放直链 -> spade_a 派生 AES Key -> CENC-AES-CTR 解密 -> 输出 mp4
 *   5. 下载管理：进度推送（SSE）、暂停/取消、重试、删除
 *   6. 设置：下载目录、命名规则、并发数（JSON 文件持久化）
 *
 * 环境变量：
 *   PORT         服务监听端口（默认 8080）
 *   DOWNLOAD_DIR 默认下载根目录（默认 ./downloads）
 *   DATA_FILE    数据持久化文件路径（默认 ./data/data.json）
 */
const path = require('path');
const fs = require('fs');
const express = require('express');
const axios = require('axios');

const hongguo = require('./src/native/hongguo');
const store = require('./src/store');

const pkg = require('./package.json');

const APP_VERSION = (pkg && pkg.version) || '1.0.0';
const APP_NAME = '红果短剧下载器';

const PORT = parseInt(process.env.PORT, 10) || 8080;
const DOWNLOAD_ROOT =
  (process.env.DOWNLOAD_DIR && String(process.env.DOWNLOAD_DIR).trim()) ||
  path.join(process.cwd(), 'downloads');
const DATA_FILE = process.env.DATA_FILE || path.join(process.cwd(), 'data', 'data.json');


// ===== 下载任务管理 =====
let downloadTasks = [];
let downloadQueue = [];
let activeDownloads = 0;
let MAX_CONCURRENT_DOWNLOADS = 3;

// ===== SSE 实时事件客户端 =====
const sseClients = new Set();

function broadcast(event, payload) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(frame);
    } catch (_) {
      /* 忽略已断开的连接 */
    }
  }
}

// ===== 设置 =====
function getDefaultSettings() {
  return {
    root: DOWNLOAD_ROOT,
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
      error: inProgress ? '服务重启时任务中断' : task.error,
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
    broadcast('download-progress', { id, progress: 0, receivedBytes: 0, totalBytes: 0 });

    // 1. 获取播放直链与 spade_a 加密信息
    const playInfo = await hongguo.fetchPlayUrlSingle(vid);
    if (!playInfo || !playInfo.url) {
      throw new Error('未获取到有效播放地址');
    }

    // 2. 下载目录
    const settings = getCurrentSettings();
    const root = (settings.root && String(settings.root).trim()) ? String(settings.root).trim() : DOWNLOAD_ROOT;
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
      broadcast('download-completed', { id, path: finalPath });
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
      broadcast('download-progress', { id, progress, receivedBytes: received, totalBytes: totalLength });
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
      broadcast('download-stopped', { id });
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
    broadcast('download-completed', { id, path: finalPath });
  } catch (error) {
    console.error('[Hongguo] 下载失败:', error.message);
    delete task.cancelSource;
    delete task.writer;
    task.status = 'failed';
    task.error = error.message;
    saveDownloadTasks();
    broadcast('download-failed', { id, error: error.message });
  }
}

// 删除单个任务（内部方法）
function deleteOneTask(taskId) {
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

// ===== 任务序列化（剔除不可持久化字段） =====
const STATUS_ORDER = {
  downloading: 0,
  pending: 1,
  failed: 2,
  stopped: 3,
  completed: 4,
};

function getSortedTasks() {
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
}

// ===== Express 应用 =====
const app = express();
app.use(express.json({ limit: '2mb' }));

// ---- API：应用信息 ----
app.get('/api/app-info', (req, res) => {
  res.json({ version: APP_VERSION, appName: APP_NAME, brand: APP_NAME });
});

// ---- API：红果解析与批量下载 ----
app.post('/api/resolve', async (req, res) => {
  try {
    const input = req.body && req.body.input;
    const seriesId = await hongguo.resolveSeriesId(input);
    const data = await hongguo.fetchEpisodeList(seriesId);
    res.json({ success: true, data });
  } catch (error) {
    console.error('[Hongguo] 解析失败:', error.message);
    res.json({ success: false, error: error.message });
  }
});

app.post('/api/download', async (req, res) => {
  try {
    const { seriesId, seriesTitle, episodes } = req.body || {};
    if (!Array.isArray(episodes) || episodes.length === 0) {
      return res.json({ success: false, error: '未选择集数' });
    }

    const settings = getCurrentSettings();
    const root = (settings.root && String(settings.root).trim()) ? String(settings.root).trim() : DOWNLOAD_ROOT;
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
      broadcast('download-task-added', task);
    }

    saveDownloadTasks();
    processDownloadQueue();

    return res.json({ success: true, count: episodes.length });
  } catch (error) {
    console.error('[Hongguo] 提交批量下载失败:', error.message);
    return res.json({ success: false, error: error.message });
  }
});

// ---- API：设置 ----
app.get('/api/settings', (req, res) => {
  res.json(getCurrentSettings());
});

app.post('/api/settings', (req, res) => {
  try {
    const merged = { ...getDefaultSettings(), ...(req.body || {}) };
    store.saveSettings(merged);
    getCurrentSettings(); // 刷新并发数
    res.json({ success: true });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// ---- API：文件系统目录浏览 ----
app.get('/api/fs/list', (req, res) => {
  try {
    const target = (req.query.path && String(req.query.path).trim()) || '/';
    let resolved;
    try {
      resolved = path.resolve(target);
    } catch (e) {
      return res.json({ success: false, error: '路径无效' });
    }

    let stat;
    try {
      stat = fs.statSync(resolved);
    } catch (e) {
      return res.json({ success: false, error: '路径不存在' });
    }
    if (!stat.isDirectory()) {
      return res.json({ success: false, error: '不是目录' });
    }

    const raw = fs.readdirSync(resolved, { withFileTypes: true });
    const dirs = [];
    for (const d of raw) {
      if (d.name.startsWith('.')) continue;
      const full = path.join(resolved, d.name);
      let isDir = d.isDirectory();
      if (!isDir && d.isSymbolicLink()) {
        try { isDir = fs.statSync(full).isDirectory(); } catch (_) { /* 忽略失效链接 */ }
      }
      if (isDir) dirs.push({ name: d.name, path: full });
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));

    const parent = path.dirname(resolved);
    res.json({
      success: true,
      path: resolved,
      parent: parent === resolved ? null : parent,
      dirs,
    });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// ---- API：下载管理 ----
app.get('/api/tasks', (req, res) => {
  res.json(getSortedTasks());
});

app.delete('/api/tasks/:id', (req, res) => {
  const taskIndex = downloadTasks.findIndex((t) => t.id === req.params.id);
  if (taskIndex === -1) return res.json({ success: false, error: '任务不存在' });
  deleteOneTask(req.params.id);
  saveDownloadTasks();
  res.json({ success: true });
});

app.delete('/api/tasks', (req, res) => {
  const ids = req.body && req.body.ids;
  if (!Array.isArray(ids) || ids.length === 0) return res.json({ success: false, error: '没有要删除的任务' });
  for (const id of ids) deleteOneTask(id);
  saveDownloadTasks();
  res.json({ success: true, count: ids.length });
});

app.post('/api/tasks/:id/stop', (req, res) => {
  const task = downloadTasks.find((t) => t.id === req.params.id);
  if (!task) return res.json({ success: false, error: '任务不存在' });

  task.cancelled = true;
  if (task.cancelSource) { try { task.cancelSource.cancel('用户停止下载'); } catch (_) {} }
  if (task.writer) { try { task.writer.end(); } catch (_) {} }

  task.status = 'stopped';
  task.error = '';
  task.endTime = Date.now();
  delete task.cancelSource;
  delete task.writer;

  saveDownloadTasks();
  broadcast('download-stopped', { id: req.params.id, path: task.savePath });
  res.json({ success: true });
});

app.post('/api/tasks/:id/retry', (req, res) => {
  const task = downloadTasks.find((t) => t.id === req.params.id);
  if (!task) return res.json({ success: false, error: '任务不存在' });

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

  if (!downloadQueue.some((t) => t.id === task.id)) downloadQueue.push(task);
  saveDownloadTasks();
  processDownloadQueue();
  res.json({ success: true });
});

app.post('/api/tasks/retry', (req, res) => {
  const ids = req.body && req.body.ids;
  if (!Array.isArray(ids) || ids.length === 0) return res.json({ success: false, error: '没有要重试的任务' });
  let count = 0;
  for (const taskId of ids) {
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
  res.json({ success: true, count });
});

// ---- API：SSE 实时事件 ----
app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  sseClients.add(res);
  req.on('close', () => {
    sseClients.delete(res);
  });
});

// ---- 静态资源与 SPA 回退 ----
const DIST_DIR = path.join(__dirname, 'dist-react');
app.use(express.static(DIST_DIR));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ success: false, error: '接口不存在' });
  }
  res.sendFile(path.join(DIST_DIR, 'index.html'));
});

// ===== 启动 =====
fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
fs.mkdirSync(DOWNLOAD_ROOT, { recursive: true });
store.init(DATA_FILE);
loadDownloadTasks();
getCurrentSettings();

app.listen(PORT, () => {
  console.log(`[Server] ${APP_NAME} 已启动: http://localhost:${PORT}`);
  console.log(`[Server] 下载目录: ${DOWNLOAD_ROOT}`);
  console.log(`[Server] 数据文件: ${DATA_FILE}`);
});
