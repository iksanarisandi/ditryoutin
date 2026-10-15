/* Utilitas bersama Tryout UPKP (vanilla JS, tanpa framework). */
(function () {
  'use strict';

  // Nomor WA admin (fallback) — dipakai tombol "hubungi admin" di berbagai
  // halaman. Halaman pembayaran memakai nomor dari pengaturan server bila ada;
  // konstanta ini hanya nilai cadangannya.
  const WA_ADMIN = '6282347303153';

  // ---- API fetch wrapper: selalu JSON { success, data | error } ----
  async function api(path, opts = {}) {
    // no-store: zona Cloudflare menimpa max-age jadi 4 jam (Browser Cache TTL),
    // sehingga browser bisa menyajikan data API basi (mis. produk baru tak muncul).
    // Ini hanya bypass cache BROWSER — cache edge 60 detik tetap bekerja.
    const init = { method: opts.method || 'GET', credentials: 'same-origin', headers: {}, cache: 'no-store' };
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
  // Angka bergerak sekali saat terlihat; teks final tetap tersedia bagi
  // pembaca layar. Cleanup dipakai halaman bayar saat kartu diganti QRIS.
  function animateCounts(root = document) {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (motion.matches || !('IntersectionObserver' in window)) return () => {};
    const frames = new Map();
    const elements = Array.from(root.querySelectorAll('[data-count]'));
    const format = (el, n) => (el.dataset.countFormat === 'rupiah'
      ? rupiah(n) : n.toLocaleString('id-ID')) + (el.dataset.countSuffix || '');
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const el = entry.target;
        observer.unobserve(el);
        const target = Number(el.dataset.count);
        if (!Number.isFinite(target) || motion.matches) return;
        const label = document.createElement('span');
        label.className = 'sr-only';
        label.textContent = format(el, target);
        const value = document.createElement('span');
        value.setAttribute('aria-hidden', 'true');
        value.textContent = format(el, 0);
        el.replaceChildren(label, value);
        const start = performance.now();
        function tick(now) {
          if (!el.isConnected) { frames.delete(el); return; }
          const progress = motion.matches ? 1 : Math.max(0, Math.min((now - start) / 900, 1));
          value.textContent = format(el, Math.round(target * (1 - Math.pow(1 - progress, 3))));
          if (progress < 1) frames.set(el, requestAnimationFrame(tick));
          else {
            el.textContent = format(el, target);
            frames.delete(el);
          }
        }
        frames.set(el, requestAnimationFrame(tick));
      });
    }, { threshold: .25 });
    elements.forEach((el) => observer.observe(el));
    return () => {
      observer.disconnect();
      frames.forEach((id, el) => {
        cancelAnimationFrame(id);
        el.textContent = format(el, Number(el.dataset.count));
      });
      frames.clear();
    };
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
  // ?next= hanya boleh path di situs sendiri: "//host" dan "/\host" dibaca
  // browser sebagai URL absolut (open redirect ke situs phishing).
  function safeNext(v) { return typeof v === 'string' && /^\/(?![\/\\])/.test(v) ? v : null; }
  // Cuplikan teks soal untuk pesan WA laporan kekeliruan — nomor soal adalah
  // urutan acak per-attempt, jadi admin melacak soalnya lewat teksnya.
  function snippet(text, max = 100) {
    const s = String(text ?? '').replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max).trimEnd() + '…' : s;
  }
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

  // ---- Tombol sibuk: disable + spinner selama aksi async berjalan (cegah klik ganda) ----
  async function busy(btn, text, fn) {
    if (!btn || btn.disabled) return; // sudah diproses — abaikan klik/submit berulang
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.classList.add('is-busy');
    btn.setAttribute('aria-busy', 'true');
    btn.innerHTML = '<span class="spinner" aria-hidden="true"></span>' + esc(text);
    try {
      return await fn();
    } finally {
      btn.classList.remove('is-busy');
      btn.removeAttribute('aria-busy');
      btn.disabled = false;
      btn.innerHTML = original;
    }
  }

  // ---- Salin ke clipboard ----
  // navigator.clipboard hanya tersedia di secure context (https / localhost);
  // WebView lama atau konteks non-secure jatuh ke fallback textarea + execCommand.
  async function copy(text) {
    const s = String(text ?? '');
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(s);
        return true;
      }
    } catch (e) { /* jatuh ke fallback */ }
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta);
    // iOS Safari lama sering gagal menyeleksi textarea off-screen yang belum
    // difokus — focus + setSelectionRange membuat execCommand('copy') andal.
    ta.focus();
    ta.setSelectionRange(0, s.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
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
      ['/materi.html', 'Materi', true],
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

  // ---- Login dengan Google ----
  // Alur sepenuhnya di server (/api/auth/google → Google → callback); kegagalan
  // kembali ke halaman asal dengan ?google_error=<kode>.
  const GOOGLE_ERRORS = {
    cancelled: 'Login dengan Google dibatalkan.',
    expired: 'Sesi login Google kedaluwarsa. Silakan coba lagi.',
    failed: 'Login dengan Google gagal. Coba lagi, atau gunakan email dan password.',
    unverified: 'Email akun Google Anda belum terverifikasi. Gunakan akun Google lain atau daftar dengan email.',
    conflict: 'Email ini sudah terhubung dengan akun Google lain. Hubungi admin untuk bantuan.',
    exists: 'Email ini sudah terdaftar. Silakan masuk dengan email dan password (atau gunakan Lupa password).',
    limited: 'Terlalu banyak percobaan. Tunggu beberapa menit lalu coba lagi.',
    unavailable: 'Login dengan Google sedang tidak tersedia. Gunakan email dan password.',
  };
  function googleErrorMessage() {
    const code = qs('google_error');
    return code ? (GOOGLE_ERRORS[code] || GOOGLE_ERRORS.failed) : '';
  }
  // Google menolak OAuth di WebView aplikasi (403 disallowed_useragent) —
  // banyak pengunjung datang dari bio/iklan Instagram & TikTok.
  const IN_APP_RE = /FBAN|FBAV|FB_IAB|Instagram|Line\/|TikTok|musical_ly|BytedanceWebview|Snapchat|Twitter|; wv\)/i;
  const GOOGLE_G_SVG =
    '<svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';
  function renderGoogleAuth(el, opts = {}) {
    if (!el) return;
    const divider = '<div class="auth-or"><span>atau dengan email</span></div>';
    if (IN_APP_RE.test(navigator.userAgent)) {
      const chrome = /Android/i.test(navigator.userAgent)
        ? `<a class="btn btn-sm" href="${esc('intent://' + location.host + location.pathname + location.search + '#Intent;scheme=https;package=com.android.chrome;end')}">Buka di Chrome</a>`
        : '';
      el.innerHTML =
        '<div class="alert alert-warn small">Login dengan Google tidak bisa dibuka dari browser di dalam aplikasi (Instagram, TikTok, Facebook, dll.). ' +
        'Buka halaman ini di Chrome atau Safari, atau gunakan email di bawah.' +
        `<div class="auth-inapp-actions">${chrome}<button type="button" class="btn btn-sm btn-ghost" data-copy-link>Salin tautan</button></div></div>` +
        divider;
      el.querySelector('[data-copy-link]').addEventListener('click', async () => {
        toast((await copy(location.href)) ? 'Tautan disalin — tempel di Chrome/Safari.' : 'Gagal menyalin tautan.');
      });
    } else {
      el.innerHTML =
        `<button type="button" class="btn btn-block btn-google">${GOOGLE_G_SVG}<span>${esc(opts.label || 'Masuk dengan Google')}</span></button>` +
        divider;
      el.querySelector('.btn-google').addEventListener('click', () => {
        const p = new URLSearchParams({ from: opts.from === 'register' ? 'register' : 'login' });
        const next = safeNext(qs('next'));
        if (next) p.set('next', next);
        const ref = opts.getRef ? opts.getRef() : '';
        if (ref) p.set('ref', ref);
        location.href = '/api/auth/google?' + p.toString();
      });
    }
    el.hidden = false;
  }

  // ---- Modal helper ----
  function openModal(id) { const m = document.getElementById(id); if (m) m.hidden = false; }
  function closeModal(id) { const m = document.getElementById(id); if (m) m.hidden = true; }

  // ---- Toggle lihat password (tombol mata) ----
  // Input password dibungkus <div class="pw-field">; tombol mata disuntikkan
  // otomatis di sini agar ikon & perilakunya seragam di semua halaman.
  const EYE_SVG =
    '<svg class="ico-eye" viewBox="0 0 24 24" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>' +
    '<svg class="ico-eye-off" viewBox="0 0 24 24" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
  function initPwToggles() {
    document.querySelectorAll('.pw-field input[type="password"]').forEach((input) => {
      if (input.parentNode.querySelector('.pw-eye')) return; // sudah ada, jangan dobel
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pw-eye';
      btn.setAttribute('aria-label', 'Tampilkan password');
      btn.innerHTML = EYE_SVG;
      btn.addEventListener('click', () => {
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        btn.classList.toggle('on', show);
        btn.setAttribute('aria-label', show ? 'Sembunyikan password' : 'Tampilkan password');
      });
      input.parentNode.appendChild(btn);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initPwToggles);
  else initPwToggles();

  window.TO = {
    api, esc, rupiah, animateCounts, fmtDate, fmtDateTime, fmtDur, fmtClock, qs, safeNext, daysLeft, snippet,
    toast, busy, copy, fetchMe, requireUser, requireAdmin, logout,
    renderHeader, openModal, closeModal, WA_ADMIN, renderGoogleAuth, googleErrorMessage,
  };
})();
