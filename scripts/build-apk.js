'use strict';
/*
 * scripts/build-apk.js — بسيطة لإنشاء "حزمة تثبيت أندرويد" بنمط PWA.
 * لا يستخدم gradle — ينشئ ملف ZIP يحتوي على manifest.json + index.html + assets + تعليمات التثبيت.
 * بعد التثبيت على Android، يضيف المستخدم الأداة للشاشة الرئيسية من Chrome → تعمل كـ تطبيق مستقل.
 *
 * ملاحظة: لإنشاء APK حقيقي يتطلب Cordova/Capacitor + Java SDK; هذا يلبي حاجة "حزمة" فقط.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');

const INCLUDE = [
  'index.html', 'manifest.json', 'assets', 'api', 'lib',
];

function buildApk() {
  const tmpDir = path.join(os.tmpdir(), `ai-ta-apk-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  // نسخ الملفات المطلوبة
  for (const item of INCLUDE) {
    const src = path.join(ROOT, item);
    const dest = path.join(tmpDir, item);
    if (!fs.existsSync(src)) continue;
    copyRecursive(src, dest);
  }

  // أضف ملف تثبيت README-ANDROID
  fs.writeFileSync(path.join(tmpDir, 'README-ANDROID.md'), `# 🤖 Android Installation

1. انسخ مجلد \`www\` كاملاً لخادم ويب (Apache/Nginx/Vercel)
2. افتح الرابط على Chrome Android
3. قائمة ⋮ > Add to Home screen
4. اضغط Install — يصبح تطبيق على شاشتك الرئيسية

## متطلبات:
- متصفح Chrome ≥ 90
- اتصال إنترنت
- الموقع لازم يكون HTTPS (Vercel مشهور بده)

## كيفية النشر على Vercel (مجاني):
\`\`\`bash
npx vercel
\`\`\`
`);

  // ضغط بصيغة zip
  const zipPath = path.join(os.tmpdir(), `ai-trading-agent-android-${Date.now()}.apk.zip`);
  try {
    execSync(`cd "${tmpDir}" && zip -r -q "${zipPath}" .`, { stdio: 'ignore' });
    const data = fs.readFileSync(zipPath);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    try { fs.unlinkSync(zipPath); } catch {}
    return { data, filename: 'ai-trading-agent-android.apk.zip', mimeType: 'application/zip' };
  } catch (e) {
    // fallback：نرجع tar
    const tar = require('child_process').execSync(
      `cd "${tmpDir}" && tar czf - .`
    );
    return { data: tar, filename: 'ai-trading-agent-android.tar.gz', mimeType: 'application/gzip' };
  }
}

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      if (['node_modules', '.git', 'data', 'release'].includes(entry.name)) continue;
      copyRecursive(path.join(src, entry.name), path.join(dest, entry.name));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

module.exports = { buildApk };

// تشغيل CLI: node scripts/build-apk.js
if (require.main === module) {
  console.log('Building Android package...');
  try {
    const out = buildApk();
    const outPath = path.join(ROOT, 'release', out.filename);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, out.data);
    console.log(`✅ Built ${out.filename} (${(out.data.length/1024/1024).toFixed(2)}MB)`);
    console.log(`   Saved to: ${outPath}`);
  } catch (e) {
    console.error('❌ Build failed:', e.message);
    process.exit(1);
  }
}
