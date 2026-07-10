'use strict';
/*
 * packager.js — توليد حزم تثبيت جاهزة للتشغيل على أي جهاز
 * بدون مكتبات خارجية: zlib + tar عبر Node.js + cp child_process (zip/tar)
 *
 * المخرجات:
 *  - linux/macos: tar.gz يحتوي كل المشروع + start.sh
 *  - windows: zip يحتوي كل المشروع + start.bat
 *  كل حزمة فيها README + ثيمات + إعدادات جاهزة
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const zlib = require('zlib');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');

// الملفات/المجلدات اللي نضمّنها في الحزمة
const INCLUDE = [
  'server.js', 'index.html', 'package.json', 'vercel.json', 'README.md', 'manifest.json',
  '.env.example', '.gitignore', 'start.sh',
  'lib', 'assets', 'desktop', 'api', 'electron', 'scripts',
];
const EXCLUDE_NAMES = ['node_modules', '.git', 'data', '.vercel', '.env', 'settings.json', 'release', '.cache'];

function gatherFiles(baseDir, list) {
  const out = [];
  for (const item of list) {
    const full = path.join(baseDir, item);
    if (!fs.existsSync(full)) continue;
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      walkDir(full, baseDir, out);
    } else {
      out.push({ abs: full, rel: item });
    }
  }
  return out;
}

function walkDir(dir, base, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDE_NAMES.includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full);
    if (entry.isDirectory()) walkDir(full, base, out);
    else out.push({ abs: full, rel });
  }
}

// ---- بناء tar بسيط (POSIX ustar) ----
function buildTar(files) {
  // Tar header format: 512 bytes header + file content padded to 512
  const chunks = [];
  for (const { abs, rel } of files) {
    const data = fs.readFileSync(abs);
    const name = rel.replace(/\\/g, '/');
    const header = Buffer.alloc(512, 0);
    header.write(name, 0, 100, 'utf8'); // name
    header.write('0000644 ', 100, 8, 'utf8'); // mode
    header.write('0001750 ', 108, 8, 'utf8'); // uid
    header.write('0001750 ', 116, 8, 'utf8'); // gid
    header.write(data.length.toString(8).padStart(11, '0') + ' ', 124, 12, 'utf8'); // size
    header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + ' ', 136, 12, 'utf8'); // mtime
    header.write('        ', 148, 8, 'utf8'); // checksum placeholder (spaces)
    header.write('0', 156, 1, 'utf8'); // typeflag (regular)
    header.write('ustar  ', 257, 8, 'utf8'); // magic
    // checksum
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += header[i];
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8');
    chunks.push(header);
    chunks.push(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad > 0) chunks.push(Buffer.alloc(pad, 0));
  }
  chunks.push(Buffer.alloc(1024, 0)); // EOF
  return Buffer.concat(chunks);
}

function gzip(buf) {
  return zlib.gzipSync(buf);
}

// ---- Windows launcher ----
function makeWindowsLauncher() {
  return `@echo off
title AI Trading Agent
cd /d "%~dp0"
echo ========================================
echo   AI Trading Agent - Starting...
echo ========================================
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not installed!
  echo Download from: https://nodejs.org
  pause
  exit /b 1
)
start "" http://127.0.0.1:8080
node server.js
pause
`;
}

// ---- Android PWA install guide ----
function makeAndroidGuide() {
  return `# 🤖 Android Installation (PWA)

AI Trading Agent يعمل على الأندرويد كتطبيق ويب تقدمي (PWA).

## المتطلبات
- نشر الأداة على الإنترنت (Vercel — راجع README.md)
- متصفح Chrome على الأندرويد

## خطوات التثبيت
1. افتح رابط الأداة المنشورة في Chrome
2. اضغط على قائمة Chrome (⋮)
3. اختر "Add to Home screen" / "إضافة إلى الشاشة الرئيسية"
4. اضغط "Install" / "تثبيت"
5. ستظهر أيقونة AI Trading على شاشتك الرئيسية

## المميزات
- يعمل كتطبيق مستقل (بدون شريط المتصفح)
- إشعارات مثل التطبيقات الأصلية
- يعمل أوفلاين (بعد أول تحميل)
`;
}

const packager = {
  async build(osName) {
    // جمع ملفات المشروع
    let files = gatherFiles(ROOT, INCLUDE);
    // إضافة launchers خاصة بكل نظام
    if (osName === 'windows') {
      files.push({ abs: null, rel: 'start.bat', content: makeWindowsLauncher() });
    }
    if (osName === 'android') {
      files.push({ abs: null, rel: 'ANDROID-INSTALL.md', content: makeAndroidGuide() });
    }

    // بناء tar
    const realFiles = files.filter(f => f.abs);
    const virtualFiles = files.filter(f => !f.abs);

    // tar شامل
    let tarBuf = buildTar(realFiles);
    // إضافة الملفات الافتراضية (مثل start.bat)
    if (virtualFiles.length) {
      const virtualTar = buildTarVirtual(virtualFiles);
      // ندمج: header الـ tar الأصلي + virtual + EOF
      tarBuf = Buffer.concat([tarBuf.slice(0, -1024), virtualTar, Buffer.alloc(1024, 0)]);
    }

    if (osName === 'windows') {
      // zip عبر tar? الأفضل نستخدم zip لو موجود، وإلا tar.gz ونسميه .zip-notsupported
      // نحاول zip أولاً
      try {
        const tmpDir = path.join(os.tmpdir(), 'ai-ta-pkg-' + Date.now());
        fs.mkdirSync(tmpDir, { recursive: true });
        for (const f of realFiles) {
          const dest = path.join(tmpDir, f.rel);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(f.abs, dest);
        }
        for (const f of virtualFiles) {
          const dest = path.join(tmpDir, f.rel);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, f.content);
        }
        const zipPath = path.join(os.tmpdir(), `ai-trading-agent-windows-${Date.now()}.zip`);
        execSync(`cd "${tmpDir}" && zip -r -q "${zipPath}" .`, { stdio: 'ignore' });
        const data = fs.readFileSync(zipPath);
        fs.rmSync(tmpDir, { recursive: true, force: true });
        try { fs.unlinkSync(zipPath); } catch {}
        return { data, filename: 'ai-trading-agent-windows.zip', mimeType: 'application/zip' };
      } catch (e) {
        // fallback: tar.gz لكن نسميه .tar.gz
        const gz = gzip(tarBuf);
        return { data: gz, filename: 'ai-trading-agent-windows.tar.gz', mimeType: 'application/gzip' };
      }
    }

    // linux / macos / android → tar.gz
    const gz = gzip(tarBuf);
    const ext = osName === 'android' ? 'tar.gz' : 'tar.gz';
    return { data: gz, filename: `ai-trading-agent-${osName}.${ext}`, mimeType: 'application/gzip' };
  },

  // بيان الحزمة المتاحة (للعرض في الواجهة)
  async info() {
    const pkgs = await import('os');
    return {
      version: '1.0.0',
      os: process.platform,
      available: ['linux', 'windows', 'mac', 'android'],
      description: 'حزمة كاملة قابلة للتشغيل على أي جهاز مع Node.js',
      size: '~3MB',
      requirements: { node: '>=18', os: 'Linux/Windows/macOS' },
      buildTime: new Date().toISOString(),
    };
  },
};

function buildTarVirtual(virtualFiles) {
  const chunks = [];
  for (const f of virtualFiles) {
    const data = Buffer.from(f.content, 'utf8');
    const header = Buffer.alloc(512, 0);
    header.write(f.rel, 0, 100, 'utf8');
    header.write('0000755 ', 100, 8, 'utf8');
    header.write('0001750 ', 108, 8, 'utf8');
    header.write('0001750 ', 116, 8, 'utf8');
    header.write(data.length.toString(8).padStart(11, '0') + ' ', 124, 12, 'utf8');
    header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + ' ', 136, 12, 'utf8');
    header.write('        ', 148, 8, 'utf8');
    header.write('0', 156, 1, 'utf8');
    header.write('ustar  ', 257, 8, 'utf8');
    let sum = 0; for (let i = 0; i < 512; i++) sum += header[i];
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8');
    chunks.push(header);
    chunks.push(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad > 0) chunks.push(Buffer.alloc(pad, 0));
  }
  return Buffer.concat(chunks);
}

module.exports = packager;
