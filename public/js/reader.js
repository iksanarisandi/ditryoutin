/* Pembaca PDF materi bacaan — mode GULIR KONTINU.
 * Semua halaman tersusun dalam satu kolom vertikal dan bisa diskrol
 * sampai akhir dokumen (pola baca paling alami di mobile). Halaman
 * dirender hanya saat mendekati viewport (IntersectionObserver) dan
 * dilepas kembali setelah jauh, sehingga dokumen ratusan halaman
 * tetap ringan di memori.
 *
 * pdf.js build LEGACY v4.10.38 yang di-host sendiri:
 *   public/js/vendor/pdf.min.mjs + pdf.worker.min.mjs
 * (disalin dari node_modules/pdfjs-dist/legacy/build/ — perbarui dengan
 * menyalin ulang dari versi pdfjs-dist yang sama bila upgrade).
 */
import * as pdfjsLib from '/js/vendor/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/js/vendor/pdf.worker.min.mjs';

const $ = (id) => document.getElementById(id);
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

(async function () {
  const id = parseInt(new URLSearchParams(location.search).get('id') || '', 10);
  const me = await TO.requireUser();
  if (!me) return;
  TO.renderHeader('/materi.html', me);

  const scrollEl = $('r-scroll');
  // Kolom halaman memakai id "r-col" — JANGAN pakai "r-pages", itu sudah
  // dipakai span jumlah halaman di toolbar; ID duplikat bikin getElementById
  // mengembalikan elemen yang salah dan halaman tidak pernah tampil.
  const pagesEl = $('r-col');
  const readerEl = $('reader');
  const statusEl = $('r-status');
  const statusText = $('r-status-text');

  const fileUrl = `/api/materials/${id}/file`;
  $('r-dl').href = fileUrl + '?download=1';
  $('r-new').href = fileUrl;
  $('r-retry').href = fileUrl;

  function showError(msg, showRetry) {
    statusEl.hidden = false;
    $('r-spinner').style.display = 'none';
    statusText.textContent = msg;
    $('r-retry').hidden = !showRetry;
  }

  if (!Number.isInteger(id) || id <= 0) return showError('Materi tidak ditemukan.', false);

  // ---- Metadata untuk judul ----
  try {
    const { material } = await TO.api(`/api/materials/${id}`);
    $('r-title').textContent = material.title;
    document.title = material.title + ' — Materi — Tryout UPKP';
  } catch (e) {
    return showError('Materi tidak ditemukan.', false);
  }

  // ---- Muat dokumen ----
  let pdfDoc = null;
  const task = pdfjsLib.getDocument({ url: fileUrl, withCredentials: true });
  task.onProgress = ({ loaded, total }) => {
    if (total) statusText.textContent = `Memuat dokumen… ${Math.round((loaded / total) * 100)}%`;
  };
  try {
    pdfDoc = await task.promise;
  } catch (e) {
    return showError('Dokumen tidak dapat dibuka. File mungkin rusak atau sesi Anda berakhir — coba masuk ulang.', true);
  }
  statusEl.hidden = true;

  const p1 = await pdfDoc.getPage(1);
  const vp1 = p1.getViewport({ scale: 1 });
  const N = pdfDoc.numPages;

  let baseFit = 1;   // skala agar lebar halaman pas kontainer
  let zoom = 1;      // pengali dari baseFit
  let scale = 1;     // baseFit * zoom — skala render efektif
  let current = 1;   // halaman yang sedang terlihat
  let topsDirty = true;
  const tops = [];   // posisi Y konten tiap halaman (cache layout)

  const wrappers = new Map();  // n -> elemen .reader-page
  const visible = new Set();   // halaman dalam jangkauan render
  const tasks = new Map();     // n -> RenderTask yang berjalan
  const queue = new Set();     // halaman menunggu render
  let active = 0;

  // ---------- Kolom halaman ----------
  const SCROLL_PAD = 16;

  function computeBaseFit() {
    baseFit = Math.max(0.1, (scrollEl.clientWidth - SCROLL_PAD * 2) / vp1.width);
  }

  function makeCanvas(vp) {
    // Ketajaman layar retina dengan batas memori: DPR maks 2, dan total
    // piksel canvas dibatasi 16 MP agar zoom besar tidak meledakkan memori.
    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    const px = vp.width * dpr * vp.height * dpr;
    if (px > 16e6) dpr = Math.max(0.75, Math.sqrt(16e6 / (vp.width * vp.height)));
    const cv = document.createElement('canvas');
    cv.width = Math.floor(vp.width * dpr);
    cv.height = Math.floor(vp.height * dpr);
    cv.style.width = Math.floor(vp.width) + 'px';
    cv.style.height = Math.floor(vp.height) + 'px';
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return cv;
  }

  function buildPages() {
    scale = baseFit * zoom;
    const w = Math.round(vp1.width * scale);
    const h = Math.round(vp1.height * scale);
    const frag = document.createDocumentFragment();
    for (let n = 1; n <= N; n++) {
      const el = document.createElement('div');
      el.className = 'reader-page';
      el.dataset.n = n;
      el.style.width = w + 'px';
      el.style.height = h + 'px';
      const ph = document.createElement('div');
      ph.className = 'reader-ph';
      ph.innerHTML = '<span class="spinner" aria-hidden="true"></span><span>Halaman ' + n + '</span>';
      const no = document.createElement('div');
      no.className = 'reader-pageno';
      no.textContent = n + ' / ' + N;
      el.append(ph, no);
      frag.append(el);
      wrappers.set(n, el);
    }
    pagesEl.append(frag);
    for (const el of wrappers.values()) io.observe(el);
  }

  // ---------- Render berjendela (IntersectionObserver) ----------
  // Render halaman yang berjarak <= 300px di atas / 900px di bawah
  // viewport; di luar band itu canvas dilepas untuk menjaga memori.
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      const n = Number(en.target.dataset.n);
      if (en.isIntersecting) {
        visible.add(n);
        ensure(n);
      } else {
        visible.delete(n);
        releasePage(n);
      }
    }
  }, { root: scrollEl, rootMargin: '300px 0px 900px 0px' });

  function ensure(n) {
    const el = wrappers.get(n);
    if (!el || el.dataset.rendered === String(scale)) return;
    if (!queue.has(n)) {
      queue.add(n);
      el.dataset.rel = '';
      pump();
    }
  }

  function pump() {
    while (active < 2 && queue.size) {
      // Prioritaskan halaman terdekat dari posisi baca sekarang.
      let best = null;
      let bestD = Infinity;
      for (const n of queue) {
        const d = Math.abs(n - current);
        if (d < bestD) { bestD = d; best = n; }
      }
      queue.delete(best);
      active++;
      renderOne(best).finally(() => { active--; pump(); });
    }
  }

  async function renderOne(n) {
    const el = wrappers.get(n);
    const myScale = scale;
    try {
      const page = await pdfDoc.getPage(n);
      if (el.dataset.rel === '1' || scale !== myScale) return;
      const vp = page.getViewport({ scale });
      const cv = makeCanvas(vp);
      const t = page.render({ canvasContext: cv.getContext('2d'), viewport: vp });
      tasks.set(n, t);
      await t.promise;
      tasks.delete(n);
      if (el.dataset.rel === '1' || scale !== myScale) return;
      // Ukuran sebenarnya halaman (dokumen bisa campur orientasi).
      el.style.width = Math.floor(vp.width) + 'px';
      el.style.height = Math.floor(vp.height) + 'px';
      el.append(cv);
      el.classList.add('ready');
      el.dataset.rendered = String(scale);
      topsDirty = true;
    } catch (e) {
      tasks.delete(n);
      if (e && e.name === 'RenderingCancelledException') return;
      const ph = el.querySelector('.reader-ph');
      if (ph) ph.innerHTML = '<span>Gagal memuat halaman ' + n + '.</span>';
      console.error('[reader] render halaman ' + n + ' gagal:', e);
    }
  }

  function releasePage(n) {
    queue.delete(n);
    const t = tasks.get(n);
    if (t) { try { t.cancel(); } catch (e) { /* abaikan */ } tasks.delete(n); }
    const el = wrappers.get(n);
    if (!el) return;
    el.dataset.rel = '1';
    el.dataset.rendered = '';
    el.classList.remove('ready');
    const cv = el.querySelector('canvas');
    if (cv) { cv.width = 0; cv.height = 0; cv.remove(); }
    const ph = el.querySelector('.reader-ph');
    if (ph && !ph.querySelector('.spinner')) {
      ph.innerHTML = '<span class="spinner" aria-hidden="true"></span><span>Halaman ' + n + '</span>';
    }
  }

  function relayout(restoreScroll) {
    const oldTotal = scrollEl.scrollHeight - scrollEl.clientHeight;
    const ratio = oldTotal > 0 ? scrollEl.scrollTop / oldTotal : 0;
    scale = baseFit * zoom;
    queue.clear();
    for (const t of tasks.values()) { try { t.cancel(); } catch (e) { /* abaikan */ } }
    tasks.clear();
    const w = Math.round(vp1.width * scale);
    const h = Math.round(vp1.height * scale);
    for (const el of wrappers.values()) {
      releasePageLite(el);
      el.style.width = w + 'px';
      el.style.height = h + 'px';
    }
    topsDirty = true;
    if (typeof restoreScroll === 'function') restoreScroll();
    else scrollEl.scrollTop = ratio * (scrollEl.scrollHeight - scrollEl.clientHeight);
    for (const n of visible) ensure(n);
  }

  // Versi release tanpa membatalkan antrean (dipakai saat relayout
  // yang sudah mengosongkan queue & tasks sendiri).
  function releasePageLite(el) {
    el.dataset.rel = '1';
    el.dataset.rendered = '';
    el.classList.remove('ready');
    const cv = el.querySelector('canvas');
    if (cv) { cv.width = 0; cv.height = 0; cv.remove(); }
    const ph = el.querySelector('.reader-ph');
    if (ph && !ph.querySelector('.spinner')) {
      ph.innerHTML = '<span class="spinner" aria-hidden="true"></span><span>Halaman ' + el.dataset.n + '</span>';
    }
  }

  // ---------- Posisi & halaman aktif ----------
  function computeTops() {
    const s = scrollEl.getBoundingClientRect().top;
    tops.length = N;
    for (let n = 1; n <= N; n++) {
      tops[n - 1] = wrappers.get(n).getBoundingClientRect().top - s + scrollEl.scrollTop;
    }
    topsDirty = false;
  }
  function pageTop(n) {
    if (topsDirty) computeTops();
    return tops[n - 1];
  }

  let ticking = false;
  scrollEl.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      updateCurrent();
    });
  }, { passive: true });

  function updateCurrent() {
    const y = scrollEl.scrollTop + scrollEl.clientHeight * 0.35;
    let lo = 0;
    let hi = N - 1;
    let res = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (pageTop(mid + 1) <= y) { res = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (res + 1 !== current) {
      current = res + 1;
      updateUI();
    }
  }

  function scrollToPage(n, smooth) {
    n = clamp(n, 1, N);
    current = n;
    updateUI();
    scrollEl.scrollTo({ top: Math.max(0, pageTop(n) - 8), behavior: smooth ? 'smooth' : 'auto' });
  }

  function updateUI() {
    const pageInput = $('r-page');
    if (document.activeElement !== pageInput) pageInput.value = current;
    $('r-pages').textContent = N;
    $('r-prev').disabled = current <= 1;
    $('r-next').disabled = current >= N;
    $('r-zpct').textContent = Math.round(scale * 100) + '%';
  }

  // ---------- Zoom ----------
  function setZoom(z) {
    zoom = clamp(z, 0.5, 5);
    relayout();
  }
  $('r-zin').addEventListener('click', () => setZoom(zoom * 1.25));
  $('r-zout').addEventListener('click', () => setZoom(zoom / 1.25));
  $('r-fit').addEventListener('click', () => setZoom(1));

  // ---------- Navigasi ----------
  $('r-prev').addEventListener('click', () => scrollToPage(current - 1, true));
  $('r-next').addEventListener('click', () => scrollToPage(current + 1, true));
  $('r-page').addEventListener('change', (e) => {
    scrollToPage(clamp(parseInt(e.target.value, 10) || 1, 1, N), true);
    e.target.blur();
  });

  document.addEventListener('keydown', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT')) return;
    if (e.key === 'ArrowRight') scrollToPage(current + 1, true);
    else if (e.key === 'ArrowLeft') scrollToPage(current - 1, true);
    else if (e.key === '+' || e.key === '=') setZoom(zoom * 1.25);
    else if (e.key === '-') setZoom(zoom / 1.25);
    else if (e.key === '0') setZoom(1);
    // ArrowUp/Down/PageUp/PageDown: gulir native browser, tidak dihalangi.
  });

  // ---- Resize / fullscreen: hitung ulang baseFit ----
  let resizeTimer = null;
  // Tinggi pembaca = sisa viewport di bawah topbar (topbar bisa membungkus
  // lebih tinggi di mobile, jadi tidak bisa hardcoded di CSS).
  function sizeReader() {
    const top = readerEl.getBoundingClientRect().top;
    const h = Math.round(clamp(window.innerHeight - top, 320, window.innerHeight));
    readerEl.style.height = h + 'px';
  }
  function refit() {
    sizeReader();
    const prev = baseFit;
    computeBaseFit();
    if (Math.abs(prev - baseFit) / baseFit > 0.01) relayout();
    else updateUI();
  }
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(refit, 200);
  });
  document.addEventListener('fullscreenchange', () => setTimeout(refit, 60));

  // ---- Layar penuh (fallback CSS untuk iOS Safari) ----
  function syncFullLabel() {
    const on = !!document.fullscreenElement || readerEl.classList.contains('is-fullscreen');
    $('r-full').textContent = on ? '✕ Keluar' : '⛶ Layar penuh';
  }
  $('r-full').addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (readerEl.requestFullscreen) {
        await readerEl.requestFullscreen();
      } else {
        readerEl.classList.toggle('is-fullscreen');
        document.body.style.overflow = readerEl.classList.contains('is-fullscreen') ? 'hidden' : '';
      }
    } catch (e) { /* ditolak browser — abaikan */ }
    syncFullLabel();
    setTimeout(refit, 60);
  });
  document.addEventListener('fullscreenchange', syncFullLabel);
  // Escape mengakhiri mode layar penuh fallback (CSS) di iOS Safari.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && readerEl.classList.contains('is-fullscreen')) {
      readerEl.classList.remove('is-fullscreen');
      document.body.style.overflow = '';
      syncFullLabel();
      setTimeout(refit, 60);
    }
  });

  // ---- Pinch-zoom mobile ----
  // Selama pinch: seluruh kolom diberi transform scale untuk umpan balik
  // instan, lalu pada touchend dihitung ulang layout pada zoom final dan
  // scroll digeser agar titik fokus jari tetap di tempatnya. Satu jari =
  // gulir native.
  let pinch = null;
  let liveK = 1;
  const touchDist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

  // iOS Safari: cegah zoom halaman browser saat pinch di dalam pembaca.
  document.addEventListener('gesturestart', (e) => e.preventDefault());

  scrollEl.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      const [a, b] = e.touches;
      const rect = pagesEl.getBoundingClientRect();
      pinch = {
        dist: Math.max(1, touchDist(a, b)),
        originX: (a.clientX + b.clientX) / 2 - rect.left,
        originY: (a.clientY + b.clientY) / 2 - rect.top,
        prevTop: scrollEl.scrollTop,
        prevLeft: scrollEl.scrollLeft,
      };
      liveK = 1;
      scrollEl.style.touchAction = 'none';
    }
  }, { passive: true });

  scrollEl.addEventListener('touchmove', (e) => {
    if (!pinch || e.touches.length < 2) return;
    e.preventDefault();
    const [a, b] = e.touches;
    liveK = clamp(zoom * touchDist(a, b) / pinch.dist, 0.5, 5) / zoom;
    pagesEl.style.transformOrigin = `${pinch.originX}px ${pinch.originY}px`;
    pagesEl.style.transform = `scale(${liveK})`;
  }, { passive: false });

  function endPinch() {
    if (!pinch) return;
    scrollEl.style.touchAction = '';
    pagesEl.style.transform = '';
    pagesEl.style.transformOrigin = '';
    const k = liveK;
    const { originX, originY, prevTop, prevLeft } = pinch;
    pinch = null;
    liveK = 1;
    if (Math.abs(k - 1) > 0.02) {
      const newZoom = clamp(zoom * k, 0.5, 5);
      const realK = newZoom / zoom; // k bisa terpangkas batas clamp
      zoom = newZoom;
      // Seluruh kolom menskala linear → posisi konten titik fokus
      // bergeser sebesar origin*(realK-1) dari tepi; koreksi scroll agar
      // titik itu tetap di posisi layar yang sama.
      relayout(() => {
        scrollEl.scrollTop = prevTop + originY * (realK - 1);
        scrollEl.scrollLeft = prevLeft + originX * (realK - 1);
      });
    }
  }
  scrollEl.addEventListener('touchend', endPinch);
  scrollEl.addEventListener('touchcancel', endPinch);

  // ---- Mulai ----
  sizeReader();
  computeBaseFit();
  buildPages();
  updateUI();
})();
