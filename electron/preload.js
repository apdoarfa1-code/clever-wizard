'use strict';
/*
 * electron/preload.js — يربط الـ renderer بالإعدادات الآمنة
 * يوفر window.appAPI للحصول على معلومات النظام والعملاء
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('appAPI', {
  isElectron: true,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
  },
  openExternal: (url) => ipcRenderer.send('open-external', url),
});
