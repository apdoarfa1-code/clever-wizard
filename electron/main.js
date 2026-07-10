'use strict';
/*
 * electron/main.js — Electron main process
 * يفتح التطبيق كنافذة ديسكتوب مستقلة بدون متصفح،
 * يشغّل server.js على port داخلي ثم يحمّل الداش بورد عليه.
 */
const { app, BrowserWindow, shell, Menu, Tray, nativeImage } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8087;
const URL = `http://127.0.0.1:${PORT}`;

let mainWindow = null;
let tray = null;
let serverProc = null;
let isQuiting = false;

// ---- إعدادات النافذة ----
const WINDOW_CONFIG = {
  width: 1480,
  height: 920,
  minWidth: 1080,
  minHeight: 680,
  show: false,
  backgroundColor: '#030616',
  autoHideMenuBar: true,
  title: 'AI Trading Agent',
  icon: path.join(ROOT, 'desktop', 'icons', 'icon.png'),
  webPreferences: {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    backgroundThrottling: false,
    spellcheck: false,
  },
  frame: true,
  vibrancy: 'under-window',
  visualEffectState: 'active',
  roundedCorners: true,
};

// ---- تشغيل السيرفر الداخلي ----
function startInternalServer() {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      OPEN_BROWSER: 'false',
      AGENT_AUTORUN: 'false',
    };
    try {
      serverProc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
        cwd: ROOT,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      serverProc.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
      serverProc.stderr.on('data', (d) => process.stderr.write(`[server!] ${d}`));
      serverProc.on('exit', (code) => {
        if (!isQuiting) console.log('[electron] server exited', code);
      });
    } catch (e) {
      console.error('[electron] failed to spawn server:', e.message);
    }
    // انتظار رفع السيرفر
    const tryConnect = (count) => {
      if (count > 60) { resolve(false); return; }
      const req = http.get(`${URL}/api/health`, (res) => { res.resume(); resolve(true); });
      req.on('error', () => setTimeout(() => tryConnect(count + 1), 250));
      req.setTimeout(1000, () => { req.destroy(); setTimeout(() => tryConnect(count + 1), 250); });
    };
    setTimeout(() => tryConnect(0), 300);
  });
}

// ---- إنشاء النافذة ----
function createWindow() {
  mainWindow = new BrowserWindow(WINDOW_CONFIG);

  // loading splash → نحمّل الصفحة بعد رفع السيرفر
  mainWindow.loadFile(path.join(__dirname, 'splash.html'));

  startInternalServer().then((ok) => {
    if (ok) {
      mainWindow.loadURL(URL);
    } else {
      mainWindow.loadFile(path.join(ROOT, 'index.html'));
    }
    mainWindow.once('ready-to-show', () => mainWindow.show());
    setTimeout(() => mainWindow?.show(), 1200);
  });

  // فتح روابط خارجية في المتصفح
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // منع تنزيل الملفات في النافذة (نسأل المستخدم)
  mainWindow.webContents.session.on('will-download', (e, item) => {
    const filename = item.getFilename();
    const choice = require('electron').dialog.showMessageBoxSync(mainWindow, {
      type: 'question',
      buttons: ['Save', 'Cancel'],
      defaultId: 0,
      title: 'Download',
      message: `Save file: ${filename}?`,
    });
    if (choice === 1) e.preventDefault();
  });

  mainWindow.on('close', (e) => {
    if (!isQuiting) {
      e.preventDefault();
      mainWindow.hide();
      return false;
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ---- Tray icon ----
function createTray() {
  const iconPath = path.join(ROOT, 'desktop', 'icons', 'icon_64.png');
  let trayIcon;
  try { trayIcon = nativeImage.createFromPath(iconPath); trayIcon.setTemplateImage(false); }
  catch { trayIcon = nativeImage.createEmpty(); }

  tray = new Tray(trayIcon.isEmpty() ? nativeImage.createEmpty() : trayIcon);
  tray.setToolTip('AI Trading Agent');

  const menu = Menu.buildFromTemplate([
    { label: 'Show Dashboard', click: () => mainWindow?.show() },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuiting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => mainWindow?.show());
}

// ---- App lifecycle ----
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    // ما نفتح المنيو بار
    Menu.setApplicationMenu(null);
    createWindow();
    createTray();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow?.show();
  });

  app.on('before-quit', () => {
    isQuiting = true;
    if (serverProc && !serverProc.killed) {
      try { serverProc.kill('SIGTERM'); } catch {}
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
