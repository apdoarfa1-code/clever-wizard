'use strict';
// Matrix Rain v3 — Faster + denser + neon glow
(function() {
  const container = document.querySelector('.matrix-rain');
  if (!container) return;
  const canvas = document.createElement('canvas');
  container.appendChild(canvas);
  const ctx = canvas.getContext('2d', { alpha: true });
  // Mixed ASCII + katakana for cyber feel
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%^&*()_+-=[]{}|;:,.<>?/~abcdefghijklmnopqrstuvwxyz';
  const fontSize = 14;
  let drops = [], lastW = 0;
  function resize() {
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    canvas.width = w; canvas.height = h;
    if (drops.length !== Math.floor(w / fontSize)) {
      drops = Array(Math.floor(w / fontSize)).fill(0).map(() => Math.random() * h / fontSize);
    }
  }
  resize();
  window.addEventListener('resize', resize);

  function draw() {
    // Fade trail
    ctx.fillStyle = 'rgba(10,12,13,0.10)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.font = `${fontSize}px 'JetBrains Mono', monospace`;
    const cols = drops.length;
    for (let i = 0; i < cols; i++) {
      const ch = chars.charAt(Math.floor(Math.random() * chars.length));
      const y = drops[i] * fontSize;
      // Lead character brighter
      const isLead = Math.random() < 0.03;
      ctx.fillStyle = isLead ? '#eafff0' : '#00ff41';
      ctx.globalAlpha = isLead ? 1 : 0.7;
      ctx.shadowColor = '#00ff41';
      ctx.shadowBlur = isLead ? 8 : 0;
      ctx.fillText(ch, i * fontSize, y);
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
      // Faster fall — 2x speed
      drops[i] += 1.6;
      if (y > canvas.height && Math.random() > 0.96) drops[i] = 0;
    }
  }
  // ~60 FPS animation
  let lastTime = 0;
  const fps = 50; // ms per frame (~20 FPS, smooth + low CPU)
  function loop(now) {
    if (now - lastTime >= fps) {
      draw();
      lastTime = now;
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();