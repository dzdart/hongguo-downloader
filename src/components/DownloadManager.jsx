import React, { useState, useEffect, useCallback, useMemo } from 'react';
import './DownloadManager.css';
import { Download, Trash2, RefreshCw, X, Film, Square } from './icons';
import { api } from '../api';

const STATUS_TEXT = {
  pending: '等待中',
  downloading: '下载中',
  completed: '已完成',
  failed: '失败',
  stopped: '已停止',
};

const STATUS_ORDER = {
  downloading: 0,
  pending: 1,
  failed: 2,
  stopped: 3,
  completed: 4,
};

function sortTasks(list) {
  return [...list].sort((a, b) => {
    const wa = STATUS_ORDER[a.status] ?? 99;
    const wb = STATUS_ORDER[b.status] ?? 99;
    if (wa !== wb) return wa - wb;
    if (wa <= 1) {
      return (a.hongguoInfo?.vid_index || 0) - (b.hongguoInfo?.vid_index || 0) || (a.startTime || 0) - (b.startTime || 0);
    }
    return (b.endTime || b.startTime || 0) - (a.endTime || a.startTime || 0);
  });
}


function fmtBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return v.toFixed(v >= 100 || i === 0 ? 0 : 1) + ' ' + units[i];
}

function DownloadManager({ onNavigate }) {
  const [tasks, setTasks] = useState([]);
  const [selected, setSelected] = useState(new Set());

  const refresh = useCallback(async () => {
    const list = await api.getDownloadTasks();
    setTasks(list);
  }, []);

  useEffect(() => {
    refresh();
    const unsubscribe = api.subscribe({
      onDownloadProgress: (data) => {
        setTasks((prev) =>
          prev.map((t) => (t.id === data.id ? { ...t, progress: data.progress, receivedBytes: data.receivedBytes, totalBytes: data.totalBytes, status: 'downloading' } : t))
        );
      },
      onDownloadTaskAdded: () => refresh(),
      onDownloadCompleted: (data) => {
        setTasks((prev) => prev.map((t) => (t.id === data.id ? { ...t, status: 'completed', progress: 100 } : t)));
      },
      onDownloadFailed: (data) => {
        setTasks((prev) => prev.map((t) => (t.id === data.id ? { ...t, status: 'failed', error: data.error } : t)));
      },
      onDownloadStopped: (data) => {
        setTasks((prev) => prev.map((t) => (t.id === data.id ? { ...t, status: 'stopped' } : t)));
      },
    });
    return unsubscribe;
  }, [refresh]);

  const toggleSelect = (id) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const clearSelection = () => setSelected(new Set());

  const deleteTask = async (id) => {
    await api.deleteTask(id);
    refresh();
  };

  const deleteSelected = async () => {
    if (selected.size === 0) return;
    await api.deleteTasks(Array.from(selected));
    setSelected(new Set());
    refresh();
  };

  const retrySelected = async () => {
    if (selected.size === 0) return;
    await api.retryTasks(Array.from(selected));
    setSelected(new Set());
    refresh();
  };

  const clearCompleted = async () => {
    const ids = tasks.filter((t) => t.status === 'completed').map((t) => t.id);
    if (ids.length === 0) return;
    await api.deleteTasks(ids);
    refresh();
  };

  const sortedTasks = useMemo(() => sortTasks(tasks), [tasks]);

  const activeCount = tasks.filter((t) => t.status === 'downloading' || t.status === 'pending').length;
  const completedCount = tasks.filter((t) => t.status === 'completed').length;
  const failedCount = tasks.filter((t) => t.status === 'failed' || t.status === 'stopped').length;

  return (
    <div className="dm-container">
      <div className="dm-header">
        <div className="dm-title">
          <Download size={22} />
          <h2>下载管理</h2>
        </div>
        <div className="dm-stats">
          <span className="stat stat-active">进行中 {activeCount}</span>
          <span className="stat stat-done">已完成 {completedCount}</span>
          <span className="stat stat-fail">失败/停止 {failedCount}</span>
        </div>
      </div>

      <div className="dm-toolbar">
        <button className="btn btn-outline" onClick={retrySelected} disabled={selected.size === 0}>
          <RefreshCw size={15} />
          重试选中 ({selected.size})
        </button>
        <button className="btn btn-outline" onClick={deleteSelected} disabled={selected.size === 0}>
          <Trash2 size={15} />
          删除选中
        </button>
        <button className="btn btn-outline" onClick={clearCompleted} disabled={completedCount === 0}>
          <X size={15} />
          清空已完成
        </button>
        <button className="btn btn-outline" onClick={clearSelection} disabled={selected.size === 0}>
          取消选择
        </button>
        {onNavigate && (
          <button className="btn btn-primary" onClick={() => onNavigate('download')}>
            <Film size={15} />
            去下载
          </button>
        )}
      </div>

      {sortedTasks.length === 0 ? (
        <div className="dm-empty">
          <Download size={40} />
          <p>暂无下载任务</p>
          <p className="dm-empty-sub">前往「红果下载」解析短剧并提交下载</p>
        </div>
      ) : (
        <div className="dm-list">
          {sortedTasks.map((task) => {

            const isSel = selected.has(task.id);
            const isActive = task.status === 'downloading' || task.status === 'pending';
            const canStop = task.status === 'downloading';
            const canRetry = task.status === 'failed' || task.status === 'stopped';
            const pct = task.progress || 0;
            return (
              <div key={task.id} className={`dm-task ${isSel ? 'selected' : ''}`} onClick={() => toggleSelect(task.id)}>
                <div className="dm-task-cover">
                  {task.videoInfo && task.videoInfo.cover ? (
                    <img src={task.videoInfo.cover} alt="" />
                  ) : (
                    <div className="cover-placeholder"><Film size={18} /></div>
                  )}
                </div>
                <div className="dm-task-body">
                  <div className="dm-task-title">{task.title || task.filename}</div>
                  <div className="dm-task-meta">
                    <span className={`status-tag status-${task.status}`}>{STATUS_TEXT[task.status] || task.status}</span>
                    {task.status === 'downloading' && task.totalBytes > 0 && (
                      <span className="dm-size">{fmtBytes(task.receivedBytes)} / {fmtBytes(task.totalBytes)}</span>
                    )}
                    {task.status === 'failed' && task.error && <span className="dm-error">{task.error}</span>}
                  </div>
                  {(task.status === 'downloading' || task.status === 'pending') && (
                    <div className="dm-progress">
                      <div className="dm-progress-bar">
                        <div className="dm-progress-fill" style={{ width: pct + '%' }}></div>
                      </div>
                      <span className="dm-pct">{pct}%</span>
                    </div>
                  )}
                </div>
                <div className="dm-task-actions" onClick={(e) => e.stopPropagation()}>
                  {canStop && (
                    <button className="icon-btn" title="停止" onClick={() => { api.stopDownload(task.id); refresh(); }}>
                      <Square size={16} />
                    </button>
                  )}
                  {canRetry && (
                    <button className="icon-btn" title="重试" onClick={() => { api.retryTask(task.id); }}>
                      <RefreshCw size={16} />
                    </button>
                  )}
                  <button className="icon-btn icon-btn-danger" title="删除" onClick={() => deleteTask(task.id)}>
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default DownloadManager;
