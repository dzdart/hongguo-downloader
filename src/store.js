/**
 * store.js - 精简持久化模块
 * 用单个 JSON 文件保存「设置」与「下载任务」，替代原项目里的 sql.js 数据库 + electron-store，
 * 减少依赖，方便独立打包。
 */
const fs = require('fs');
const path = require('path');

let dataFile = null;
let cache = null; // { settings, tasks }

function loadCache() {
  if (!dataFile) throw new Error('store 未初始化');
  if (cache) return cache;
  try {
    if (fs.existsSync(dataFile)) {
      cache = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    }
  } catch (e) {
    console.error('[Store] 读取数据文件失败，使用空数据:', e.message);
  }
  if (!cache || typeof cache !== 'object') cache = {};
  if (!Array.isArray(cache.tasks)) cache.tasks = [];
  if (!cache.settings || typeof cache.settings !== 'object') cache.settings = {};
  return cache;
}

function flush() {
  if (!dataFile) return;
  try {
    fs.mkdirSync(path.dirname(dataFile), { recursive: true });
    fs.writeFileSync(dataFile, JSON.stringify(cache || {}, null, 2), 'utf8');
  } catch (e) {
    console.error('[Store] 写入数据文件失败:', e.message);
  }
}

function init(filePath) {
  dataFile = filePath;
  loadCache();
}

function getSettings() {
  return loadCache().settings;
}

function saveSettings(settings) {
  loadCache().settings = settings || {};
  flush();
}

function getTasks() {
  return loadCache().tasks;
}

function saveTasks(tasks) {
  loadCache().tasks = tasks || [];
  flush();
}

module.exports = {
  init,
  getSettings,
  saveSettings,
  getTasks,
  saveTasks,
};

