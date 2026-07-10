'use strict';
/*
 * effects.js — تأثيرات: توهج الماوس + شريط التمرير + reveal عند scroll
 */
(function () {
  // 1) Cursor glow
  const glow = document.getElementById('cursorGlow');
  if (glow) {
    let mx = window.innerWidth / 2, my = window.innerHeight / 2;
    let cx = mx, cy = my;
    document.addEventListener('mousemove', (e) => { mx = e.clientX; my = e.clientY; });
    function animateGlow() {
      cx += (mx - cx) * 0.12;
      cy += (my - cy) * 0.12;
      glow.style.transform = `translate(${cx}px, ${cy}px) translate(-50%, -50%)`;
      requestAnimationFrame(animateGlow);
    }
    animateGlow();
  }

  // 2) Scroll progress bar
  const bar = document.getElementById('scrollProgress');
  if (bar) {
    window.addEventListener('scroll', () => {
      const h = document.documentElement.scrollHeight - window.innerHeight;
      const pct = h > 0 ? (window.scrollY / h) * 100 : 0;
      bar.style.width = pct + '%';
    }, { passive: true });
  }

  // 3) Reveal on scroll (IntersectionObserver)
  const reveals = () => document.querySelectorAll('.reveal');
  function observeReveals() {
    if (!('IntersectionObserver' in window)) {
      reveals().forEach(el => el.classList.add('visible'));
      return;
    }
    const io = new IntersectionObserver((entries) => {
      entries.forEach(en => {
        if (en.isIntersecting) { en.target.classList.add('visible'); io.unobserve(en.target); }
      });
    }, { threshold: 0.08, rootMargin: '0px 0px -40px 0px' });
    reveals().forEach(el => io.observe(el));
  }

  // 4) Click ripple effect على الأزرار
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn, .topnav-link, .nav-item, .card');
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const ripple = document.createElement('span');
    const size = Math.max(rect.width, rect.height);
    ripple.style.cssText = `
      position:absolute;
      width:${size}px;height:${size}px;
      border-radius:50%;
      background:rgba(255,255,255,0.25);
      left:${e.clientX - rect.left - size / 2}px;
      top:${e.clientY - rect.top - size / 2}px;
      pointer-events:none;
      transform:scale(0);
      animation:ripple 0.6s ease-out;
    `;
    if (getComputedStyle(btn).position === 'static') btn.style.position = 'relative';
    btn.style.overflow = 'hidden';
    btn.appendChild(ripple);
    setTimeout(() => ripple.remove(), 600);
  });

  // ripple keyframes
  const style = document.createElement('style');
  style.textContent = '@keyframes ripple{to{transform:scale(2.5);opacity:0;}}';
  document.head.appendChild(style);

  // 5) Smooth scroll for in-page anchors
  document.addEventListener('DOMContentLoaded', observeReveals);
  setTimeout(observeReveals, 100);

  // Re-observe عند تغيير الصفحة
  window.addEventListener('reveal:refresh', observeReveals);
})();
