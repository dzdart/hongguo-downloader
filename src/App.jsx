import React, { useState, useEffect } from 'react';
import { Film, Download, Settings, ExternalLink } from './components/icons';
import HongguoDownload from './components/HongguoDownload';
import DownloadManager from './components/DownloadManager';
import SettingsPage from './components/Settings';

const MENU = [
  { id: 'download', label: '红果下载', icon: Film },
  { id: 'manager', label: '下载管理', icon: Download },
  { id: 'settings', label: '设置', icon: Settings },
];

export default function App() {
  const [page, setPage] = useState('download');
  const [appInfo, setAppInfo] = useState(null); // { version, brand, appName, official_website }

  useEffect(() => {
    window.electronAPI.getAppInfo().then((info) => {
      setAppInfo(info);
    });
  }, []);

  const openOfficial = () => {
    const url = (appInfo && appInfo.official_website) || 'https://111330.com';
    if (window.electronAPI && window.electronAPI.openExternalUrl) {
      window.electronAPI.openExternalUrl(url);
    } else {
      window.open(url, '_blank');
    }
  };

  const renderPage = () => {
    switch (page) {
      case 'manager':
        return <DownloadManager onNavigate={setPage} />;
      case 'settings':
        return <SettingsPage />;
      case 'download':
      default:
        return <HongguoDownload onNavigate={setPage} />;
    }
  };

  return (
    <div className="app-layout">
      {/* 左侧边栏 */}
      <div className="sidebar">
        <div className="sidebar-brand">
          <div className="logo">
            <Film size={18} />
          </div>
          <div>
            <div className="brand-text">{appInfo ? appInfo.brand : '小菜鸟 软件'}</div>
            <div className="brand-sub">红果短剧下载器 v{appInfo ? appInfo.version : ''}</div>
          </div>
        </div>

        <div className="sidebar-menu">
          {MENU.map((item) => {
            const Icon = item.icon;
            return (
              <div
                key={item.id}
                className={`sidebar-item ${page === item.id ? 'active' : ''}`}
                onClick={() => setPage(item.id)}
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </div>
            );
          })}
        </div>

        <div className="sidebar-footer">
          {/* 超醒目的侧边栏官网更新卡片 */}
          <div className="sidebar-website-card" onClick={openOfficial} title="点击访问官网 111330.com">
            <div className="card-top-row">
              <span className="card-badge">🔥 官方更新渠道</span>
              <span className="card-pulse-dot"></span>
            </div>
            <div className="card-desc">如需更新请进入官网</div>
            <div className="card-domain">
              <span>111330.com</span>
              <ExternalLink size={14} />
            </div>
          </div>
          <div className="footer-note">AES-128 CENC 原生解密 · 无水印</div>
        </div>
      </div>

      {/* 右侧主体区域 */}
      <div className="main-wrapper">
        {/* 顶部极度醒目的强提示官网横幅 */}
        <div className="top-official-banner" onClick={openOfficial} title="点击直达官网 111330.com">
          <div className="banner-left">
            <span className="banner-icon-pulse">📢</span>
            <span className="banner-badge">官方唯一通道</span>
            <span className="banner-text">
              如需更新请进入官网：<span className="banner-domain-highlight">111330.com</span>
            </span>
          </div>
          <button className="banner-action-btn" onClick={(e) => { e.stopPropagation(); openOfficial(); }}>
            <span>👉 立即前往官网 (111330.com)</span>
            <ExternalLink size={15} />
          </button>
        </div>

        <div className="main-content">{renderPage()}</div>
      </div>

    </div>
  );
}

