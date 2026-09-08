import React, { useState, useEffect } from 'react';
import './Settings.css';
import { Settings, Folder, Check, ExternalLink } from './icons';


const FORMAT_PRESETS = [
  { label: '剧名_第N集', value: '剧名 集数' },
  { label: '剧名_第N集_标题', value: '剧名 集数 标题' },
  { label: '仅剧名', value: '剧名' },
];

function SettingsPage() {
  const [settings, setSettings] = useState(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    window.electronAPI.getSettings().then(setSettings);
  }, []);

  const update = (key, value) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  };

  const selectFolder = async () => {
    const dir = await window.electronAPI.selectFolder();
    if (dir) update('root', dir);
  };

  const save = async () => {
    const res = await window.electronAPI.saveSettings(settings);
    if (res && res.success) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
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
            <input
              type="text"
              className="input-field"
              value={settings.root || ''}
              onChange={(e) => update('root', e.target.value)}
              placeholder="选择下载保存目录"
            />
            <button className="btn btn-outline" onClick={selectFolder}>
              <Folder size={16} />
              选择文件夹
            </button>
          </div>
          <p className="settings-hint">文件将保存到 <code>下载目录/红果短剧/剧名/</code> 下</p>
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

      <div className="settings-card mt16">
        <div className="settings-group">
          <label className="settings-label">版本更新与官方支持</label>
          <p className="settings-hint" style={{ fontSize: '13px', lineHeight: '1.6' }}>
            本客户端已完全脱机独立运行，无任何远程检测与后门。<br />
            <strong>如需获取最新版本或技术支持，请访问唯一官方网站：</strong>
            <span style={{ color: 'var(--accent)', fontWeight: 'bold', fontSize: '14px', marginLeft: '4px' }}>
              111330.com
            </span>
          </p>
          <div style={{ marginTop: '10px' }}>
            <button
              className="btn btn-outline"
              style={{ borderColor: 'var(--accent)', color: 'var(--accent)', fontWeight: 600 }}
              onClick={() => window.electronAPI.openExternalUrl('https://111330.com')}
            >
              <span>访问官网 (111330.com)</span>
              <ExternalLink size={14} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}


export default SettingsPage;
