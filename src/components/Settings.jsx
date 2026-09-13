import React, { useState, useEffect } from 'react';
import './Settings.css';
import { Settings, Check, Folder, X, ChevronRight } from './icons';
import { api } from '../api';


const FORMAT_PRESETS = [
  { label: '剧名_第N集', value: '剧名 集数' },
  { label: '剧名_第N集_标题', value: '剧名 集数 标题' },
  { label: '仅剧名', value: '剧名' },
];

function SettingsPage() {
  const [settings, setSettings] = useState(null);
  const [saved, setSaved] = useState(false);

  // 文件夹选择器状态
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browserPath, setBrowserPath] = useState('');
  const [browserParent, setBrowserParent] = useState(null);
  const [browserDirs, setBrowserDirs] = useState([]);
  const [browserLoading, setBrowserLoading] = useState(false);
  const [browserError, setBrowserError] = useState('');

  useEffect(() => {
    api.getSettings().then(setSettings);
  }, []);

  const update = (key, value) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  };

  const save = async () => {
    const res = await api.saveSettings(settings);
    if (res && res.success) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  };

  // 加载某个目录的子目录列表，成功返回 true
  const loadDir = async (p) => {
    setBrowserLoading(true);
    setBrowserError('');
    try {
      const res = await api.listDir(p);
      if (res && res.success) {
        setBrowserPath(res.path);
        setBrowserParent(res.parent);
        setBrowserDirs(res.dirs || []);
        setBrowserLoading(false);
        return true;
      }
      setBrowserError((res && res.error) || '无法读取该目录');
      setBrowserLoading(false);
      return false;
    } catch (e) {
      setBrowserError('读取目录出错: ' + e.message);
      setBrowserLoading(false);
      return false;
    }
  };

  // 打开文件夹选择器
  const openBrowser = async () => {
    setBrowserOpen(true);
    const start = (settings && settings.root && String(settings.root).trim()) || '/';
    const ok = await loadDir(start);
    if (!ok) await loadDir('/');
  };

  const goParent = () => {
    if (browserParent) loadDir(browserParent);
  };

  const confirmSelect = () => {
    if (browserPath) update('root', browserPath);
    setBrowserOpen(false);
  };

  if (!settings) {
    return <div className="settings-container">加载中...</div>;
  }

  return (
    <div className="settings-container">
      <div className="settings-header">
        <Settings size={22} />
        <h2>设置</h2>
      </div>

      <div className="settings-card">
        <div className="settings-group">
          <label className="settings-label">下载目录</label>
          <div className="folder-row">
            <div className="folder-input-wrap">
              <Folder size={16} />
              <input
                type="text"
                className="input-field"
                value={settings.root || ''}
                onChange={(e) => update('root', e.target.value)}
                placeholder="请输入服务器上的下载保存目录"
              />
            </div>
            <button className="btn btn-outline" onClick={openBrowser}>
              浏览…
            </button>
          </div>
          <p className="settings-hint">
            文件将保存到 <code>下载目录/红果短剧/剧名/</code> 下。
            Docker 部署时请选择容器内挂载卷路径（例如 <code>/downloads</code>），并确保该目录已映射到宿主机。
          </p>
        </div>

        <div className="settings-group">
          <label className="settings-label">文件命名规则</label>
          <div className="preset-row">
            {FORMAT_PRESETS.map((p) => (
              <button
                key={p.value}
                className={`btn-chip ${settings.name_format === p.value ? 'btn-chip-primary' : ''}`}
                onClick={() => update('name_format', p.value)}
              >
                {p.label}
              </button>
            ))}
          </div>
          <input
            type="text"
            className="input-field mt8"
            value={settings.name_format || ''}
            onChange={(e) => update('name_format', e.target.value)}
          />
          <p className="settings-hint">
            可用变量：<code>剧名</code>（series_title）· <code>集数</code>（vid_index，如 001）· <code>标题</code>（ep_title）
          </p>
        </div>

        <div className="settings-group">
          <label className="settings-label">最大并发下载数</label>
          <select
            className="input-field select-field"
            value={settings.max_concurrent || 3}
            onChange={(e) => update('max_concurrent', parseInt(e.target.value, 10))}
          >
            {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
              <option key={n} value={n}>{n} 个同时下载</option>
            ))}
          </select>
          <p className="settings-hint">并发越高下载越快，但可能触发接口限流，建议 3~5</p>
        </div>

        <div className="settings-footer">
          <button className="btn btn-primary" onClick={save}>
            {saved ? <><Check size={16} /> 已保存</> : '保存设置'}
          </button>
        </div>
      </div>

      {/* 网页版文件夹选择器弹窗 */}
      {browserOpen && (
        <div className="dir-modal-backdrop" onClick={() => setBrowserOpen(false)}>
          <div className="dir-modal" onClick={(e) => e.stopPropagation()}>
            <div className="dir-modal-header">
              <span>选择下载目录</span>
              <button className="icon-btn" title="关闭" onClick={() => setBrowserOpen(false)}>
                <X size={18} />
              </button>
            </div>

            <div className="dir-modal-breadcrumb">
              <button className="btn-chip" onClick={goParent} disabled={!browserParent}>返回上级</button>
              <div className="dir-modal-path" title={browserPath}>{browserPath || '/'}</div>
            </div>

            <div className="dir-modal-list">
              {browserLoading && <div className="dir-modal-empty">加载中...</div>}
              {!browserLoading && browserError && (
                <div className="dir-modal-empty">
                  <span className="dir-modal-error">{browserError}</span>
                  <button className="btn btn-outline" onClick={() => loadDir('/')}>转到根目录</button>
                </div>
              )}
              {!browserLoading && !browserError && browserDirs.length === 0 && (
                <div className="dir-modal-empty">此目录下没有子文件夹</div>
              )}
              {!browserLoading && !browserError && browserDirs.map((d) => (
                <div key={d.path} className="dir-row" onClick={() => loadDir(d.path)}>
                  <Folder size={16} />
                  <span className="dir-row-name">{d.name}</span>
                  <ChevronRight size={15} className="dir-row-arrow" />
                </div>
              ))}
            </div>

            <div className="dir-modal-footer">
              <button className="btn btn-outline" onClick={() => setBrowserOpen(false)}>取消</button>
              <button className="btn btn-primary" onClick={confirmSelect} disabled={!browserPath || browserLoading}>
                <Check size={16} />
                选择此文件夹
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


export default SettingsPage;
