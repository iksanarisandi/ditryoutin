/* Utilitas bersama Tryout UPKP (vanilla JS, tanpa framework). */
(function () {
  'use strict';

  // ---- API fetch wrapper: selalu JSON { success, data | error } ----
  async function api(path, opts = {}) {
    const init = { method: opts.method || 'GET', credentials: 'same-origin', headers: {} };
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    let res;
    try {
      res = await fetch(path, init);
    } catch (e) {
      throw new Error('Tidak dapat terhubung ke server. Periksa koneksi Anda.');
    }
    let json = null;
    try { json = await res.json(); } catch (e) { /* body bukan JSON */ }
    if (!json) throw new Error('Terjadi kesalahan pada server.');
    if (!json.success) {
      const err = new Error(json.error || 'Terjadi kesalahan.');
      err.status = res.status;
      err.data = json;
      throw err;
    }
    return json.data;
  }

  // ---- Format helper (tampilan WITA = Asia/Makassar) ----
  const TZ = 'Asia/Makassar';
  const fDate = new Intl.DateTimeFormat('id-ID', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' });
  const fDateTime = new Intl.DateTimeFormat('id-ID', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  function fmtDate(iso) { return iso ? fDate.format(new Date(iso)) : '-'; }
  function fmtDateTime(iso) { return iso ? fDateTime.format(new Date(iso)) : '-'; }
  function rupiah(n) {
    return 'Rp' + Number(n || 0).toLocaleString('id-ID');
  }
  function fmtDur(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
    return h > 0 ? `${h} jam ${m} menit ${ss} detik` : `${m} menit ${ss} detik`;
  }
  function fmtClock(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (ch) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }
  function qs(name) { return new URLSearchParams(location.search).get(name); }
  function daysLeft(iso) {
    if (!iso) return 0;
    return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000));
  }

  // ---- Toast ----
  function toast(msg, type = '') {
    let root = document.getElementById('toast-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'toast-root';
      document.body.appendChild(root);
    }
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    root.appendChild(el);
    setTimeout(() => el.remove(), 3800);
  }

  // ---- Auth guard ----
  async function fetchMe() {
    try { return await api('/api/auth/me'); }
    catch (e) { return null; }
  }
  async function requireUser(opts = {}) {
    const me = await fetchMe();
    if (!me) {
      if (opts.redirect !== false) {
        location.href = '/login.html?next=' + encodeURIComponent(location.pathname + location.search);
      }
      return null;
    }
    return me;
  }
  async function requireAdmin() {
    const me = await fetchMe();
    if (!me) { location.href = '/login.html?next=' + encodeURIComponent(location.pathname); return null; }
    if (!me.is_admin) { location.href = '/dashboard.html'; return null; }
    return me;
  }
  async function logout() {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch (e) { /* abaikan */ }
    location.href = '/';
  }

  // ---- Header render ----
  function renderHeader(active, me) {
    const el = document.getElementById('site-header');
    if (!el) return;
    const links = [
      ['/', 'Beranda', false],
      ['/artikel/', 'Artikel', false],
      ['/dashboard.html', 'Dashboard', true],
      ['/history.html', 'Riwayat', true],
    ];
    const nav = links
      .map(([href, label, needAuth]) => {
        if (needAuth && !me) return '';
        const cls = href === active || (active === '/dashboard.html' && href === '/dashboard.html') ? 'class="active"' : '';
        return `<a href="${href}" ${cls}>${label}</a>`;
      })
      .join('');
    const adminLink = me && me.is_admin ? '<a href="/admin/">Admin</a>' : '';
    const right = me
      ? `<span class="topbar-user">${esc(me.user.name)}</span>
         ${adminLink}
         <a href="#" id="btn-logout" class="btn btn-sm" style="background:rgba(255,255,255,.14)">Keluar</a>`
      : `<a href="/login.html" class="btn btn-sm" style="background:rgba(255,255,255,.14)">Masuk</a>
         <a href="/register.html" class="btn btn-sm btn-outline" style="border-color:#fff;color:#fff;background:transparent">Daftar</a>`;
    el.className = 'topbar';
    el.innerHTML = `
      <div class="container topbar-inner">
        <a class="brand" href="/"><img class="brand-logo" src="/img/favicon-48.png" alt="" width="30" height="30"><span class="brand-text">TRYOUT UPKP<span class="sub">Simulasi &amp; Latihan Ujian</span></span></a>
        <nav class="topnav">${nav}</nav>
        <div class="topbar-right">${right}</div>
      </div>`;
    const btn = document.getElementById('btn-logout');
    if (btn) btn.addEventListener('click', (e) => { e.preventDefault(); logout(); });
  }

  // ---- Modal helper ----
  function openModal(id) { const m = document.getElementById(id); if (m) m.hidden = false; }
  function closeModal(id) { const m = document.getElementById(id); if (m) m.hidden = true; }

  window.TO = {
    api, esc, rupiah, fmtDate, fmtDateTime, fmtDur, fmtClock, qs, daysLeft,
    toast, fetchMe, requireUser, requireAdmin, logout,
    renderHeader, openModal, closeModal,
  };
})();
