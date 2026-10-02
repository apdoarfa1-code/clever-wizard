'use strict';
/*
 * auth.js — نظام المصادقة (Premium Login)
 * المستخدمون المعتمدون فقط (نفس اسم المتير username داخل الجهاز).
 * لا يوجد hint ولا ad-hoc login.
 *
 * الـ users المصرّح بيهم:
 *   101 → password 102
 * (+ admin@ في الحالة الخلفية إذا تحدد)
 *
 * الجلسة محفوظة sessionStorage (تُصفى عند إغلاق التطبيق).
 */
const Auth = {
  STATE_KEY: 'ai_auth_session',
  USER_KEY: 'ai_user',
  validUsers: { '101': '102' },

  isLoggedIn() {
    try { return sessionStorage.getItem(this.STATE_KEY) === 'ok'; }
    catch { return false; }
  },

  currentUser() {
    try { return sessionStorage.getItem(this.USER_KEY) || null; }
    catch { return null; }
  },

login() {
    const u = String(document.getElementById('loginUser')?.value || '').trim();
    const p = String(document.getElementById('loginPass')?.value || '').trim();
    const err = document.getElementById('loginErr');
    if (!u || !p) {
      if (err) err.textContent = 'أدخل اسم المستخدم وكلمة المرور';
      this._shake();
      return;
    }
    if (this.validUsers[u] === p) {
      sessionStorage.setItem(this.STATE_KEY, 'ok');
      sessionStorage.setItem(this.USER_KEY, u);
      // hide login page
      const lp = document.getElementById('loginPage');
      if (lp) { lp.style.opacity = '0'; setTimeout(() => { lp.style.display = 'none'; }, 400); }
      // show main app
      const nav = document.querySelector('.topnav');
      const main = document.querySelector('.main');
      if (nav) nav.style.display = 'flex';
      if (main) main.style.display = 'flex';
      // hide splash
      const splash = document.getElementById('splash');
      if (splash) { splash.classList.add('hide'); setTimeout(() => splash.remove(), 600); }
      if (window.App && !window._appInitialized) {
        window._appInitialized = true;
        App.init();
      }
      return;
    }
    if (err) err.textContent = 'بيانات الدخول غير صحيحة';
    this._shake();
    const pass = document.getElementById('loginPass');
    if (pass) { pass.value = ''; pass.focus(); }
  },

  gate() {
    if (this.isLoggedIn()) {
      const lp = document.getElementById('loginPage');
      if (lp) lp.style.display = 'none';
      // show app
      const nav = document.querySelector('.topnav');
      const main = document.querySelector('.main');
      if (nav) nav.style.display = 'flex';
      if (main) main.style.display = 'flex';
      return true;
    }
    // show login, hide app
    const lp = document.getElementById('loginPage');
    if (lp) lp.style.display = 'flex';
    const nav = document.querySelector('.topnav');
    const main = document.querySelector('.main');
    if (nav) nav.style.display = 'none';
    if (main) main.style.display = 'none';
    const splash = document.getElementById('splash');
    if (splash) { splash.classList.add('hide'); setTimeout(() => splash.remove(), 600); }
    return false;
  },

  logout() {
    sessionStorage.removeItem(this.STATE_KEY);
    sessionStorage.removeItem(this.USER_KEY);
    location.reload();
  },

  gate() {
    if (this.isLoggedIn()) {
      // إخفاء login لو موجود
      const lp = document.getElementById('loginPage');
      if (lp) lp.style.display = 'none';
      return true;
    }
    // عرض login
    const lp = document.getElementById('loginPage');
    if (lp) lp.style.display = 'flex';
    // إخفاء splash
    const splash = document.getElementById('splash');
    if (splash) { splash.classList.add('hide'); setTimeout(() => splash.remove(), 600); }
    return false;
  },

  _shake() {
    const card = document.querySelector('.login-card');
    if (!card) return;
    card.classList.remove('shake');
    void card.offsetWidth; // reflow
    card.classList.add('shake');
    setTimeout(() => card.classList.remove('shake'), 500);
  },
};

// Enter key → moveToPass ثم login
document.addEventListener('DOMContentLoaded', () => {
  const userInput = document.getElementById('loginUser');
  const passInput = document.getElementById('loginPass');
  userInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); passInput?.focus(); }
  });
  passInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); Auth.login(); }
  });
});

window.Auth = Auth;
