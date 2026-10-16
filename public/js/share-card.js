/* Kartu "bagikan hasil" ala Strava untuk halaman hasil tryout.
 *
 * Gambar dirender sepenuhnya di browser (canvas → PNG) dari data yang sudah
 * dimuat halaman hasil, jadi tidak ada beban render di Worker. Satu-satunya
 * request tambahan adalah GET /api/referral (sekali per buka modal) agar teks
 * bagikan memuat link undangan pengguna.
 *
 * Ukuran 1080x1920 (9:16) = format Story IG / Status WA. Konten penting
 * dijaga di area ±230–1800 px karena bagian atas/bawah tertutup UI Story.
 */
(function () {
  'use strict';

  const W = 1080, H = 1920, PAD = 96;
  const FONT = '"Plus Jakarta Sans", "Segoe UI", system-ui, Arial, sans-serif';
  const C = {
    bg1: '#0c1733', bg2: '#132a5e', glow: 'rgba(59,130,246,0.38)',
    text: '#ffffff', muted: 'rgba(255,255,255,0.62)', faint: 'rgba(255,255,255,0.12)',
    blue: '#60a5fa', accent: '#3b82f6', green: '#4ade80', amber: '#fbbf24',
  };
  const FILE_NAME = 'hasil-tryout-ditryout.png';

  function font(weight, size) { return weight + ' ' + size + 'px ' + FONT; }

  function spacing(ctx, px) {
    if ('letterSpacing' in ctx) ctx.letterSpacing = px + 'px';
  }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function fit(ctx, text, maxW, wholeWords) {
    if (ctx.measureText(text).width <= maxW) return text;
    let s = text;
    while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
    if (wholeWords && s.lastIndexOf(' ') > 0) s = s.slice(0, s.lastIndexOf(' '));
    return s.trimEnd() + '…';
  }

  function wrap(ctx, text, maxW, maxLines) {
    const words = String(text).split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = '';
    for (let i = 0; i < words.length; i++) {
      const next = cur ? cur + ' ' + words[i] : words[i];
      if (ctx.measureText(next).width <= maxW || !cur) { cur = next; continue; }
      lines.push(cur);
      cur = words[i];
      if (lines.length === maxLines - 1) { cur = words.slice(i).join(' '); break; }
    }
    if (cur) lines.push(cur);
    if (lines.length) lines[lines.length - 1] = fit(ctx, lines[lines.length - 1], maxW, true);
    return lines;
  }

  function shortDur(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h > 0 ? h + 'j ' + m + 'm' : m + 'm ' + String(s).padStart(2, '0') + 'd';
  }

  // Data per kategori untuk bar: utamakan aturan passing grade (punya minimum
  // & status lulus), selain itu skor kategori biasa.
  function categoryRows(d) {
    const csByName = new Map((d.category_scores || []).map((cs) => [cs.name, cs]));
    const maxOf = (cs) => (cs ? (cs.max_score != null ? cs.max_score : cs.total * 5) : null);
    if (d.passing_grades && d.passing_grades.length) {
      return d.passing_grades.map((g) => ({
        name: g.name, score: g.score, max: maxOf(csByName.get(g.name)),
        min: g.minimum_score, passed: g.passed,
      }));
    }
    return (d.category_scores || []).map((cs) => ({
      name: cs.name, score: cs.score, max: maxOf(cs), min: null, passed: null,
    }));
  }

  // Font halaman dimuat async oleh Google Fonts; tanpa menunggu, canvas bisa
  // memakai font fallback. Dibatasi waktunya agar koneksi lambat tidak macet.
  async function ensureFonts() {
    if (!document.fonts || !document.fonts.load) return;
    const loads = Promise.all(['600', '700', '800'].map((w) => document.fonts.load(font(w, 40))));
    await Promise.race([loads, new Promise((r) => setTimeout(r, 2500))]).catch(() => {});
  }

  function draw(d) {
    const r = d.result;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.textBaseline = 'alphabetic';

    // Latar: gradien navy + cahaya biru lembut di pojok kanan atas.
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, C.bg1);
    bg.addColorStop(1, C.bg2);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    const glow = ctx.createRadialGradient(W, 0, 0, W, 0, 900);
    glow.addColorStop(0, C.glow);
    glow.addColorStop(1, 'rgba(59,130,246,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);

    const innerW = W - PAD * 2;

    // Judul
    ctx.fillStyle = C.blue;
    ctx.font = font(700, 30);
    spacing(ctx, 5);
    ctx.fillText('HASIL TRYOUT UPKP', PAD, 280);
    spacing(ctx, 0);
    ctx.fillStyle = C.text;
    ctx.font = font(800, 54);
    wrap(ctx, r.package.title, innerW, 2).forEach((line, i) => ctx.fillText(line, PAD, 352 + i * 66));

    // Skor utama
    ctx.fillStyle = C.muted;
    ctx.font = font(700, 30);
    spacing(ctx, 5);
    ctx.fillText('SKOR', PAD, 540);
    spacing(ctx, 0);
    ctx.fillStyle = C.text;
    ctx.font = font(800, 260);
    const scoreText = String(r.score ?? 0);
    ctx.fillText(scoreText, PAD - 8, 770);
    const scoreW = ctx.measureText(scoreText).width;
    ctx.fillStyle = C.muted;
    ctx.font = font(700, 64);
    ctx.fillText('/ ' + r.max_score, PAD + scoreW + 16, 770);

    if (r.passing_available) {
      const label = r.passed ? 'LULUS PASSING GRADE' : 'BELUM LULUS';
      const color = r.passed ? C.green : C.amber;
      ctx.font = font(800, 30);
      spacing(ctx, 3);
      const tw = ctx.measureText(label).width;
      roundRect(ctx, PAD, 812, tw + 56, 64, 32);
      ctx.fillStyle = r.passed ? 'rgba(74,222,128,0.16)' : 'rgba(251,191,36,0.16)';
      ctx.fill();
      ctx.fillStyle = color;
      ctx.fillText(label, PAD + 28, 855);
      spacing(ctx, 0);
    }

    ctx.fillStyle = C.faint;
    ctx.fillRect(PAD, 930, innerW, 2);

    // Statistik ala Strava: label kecil + angka besar.
    const total = (r.correct_count || 0) + (r.wrong_count || 0) + (r.unanswered_count || 0);
    const acc = total ? Math.round(((r.correct_count || 0) / total) * 100) : 0;
    const colW = innerW / 3;
    const stat = (col, y, label, value, color, span = 1) => {
      const x = PAD + col * colW;
      ctx.fillStyle = C.muted;
      ctx.font = font(700, 26);
      spacing(ctx, 4);
      ctx.fillText(label, x, y);
      spacing(ctx, 0);
      ctx.fillStyle = color || C.text;
      ctx.font = font(800, 76);
      ctx.fillText(fit(ctx, value, colW * span - 20), x, y + 86);
    };
    stat(0, 1000, 'BENAR', String(r.correct_count ?? 0), C.green);
    stat(1, 1000, 'SALAH', String(r.wrong_count ?? 0));
    stat(2, 1000, 'KOSONG', String(r.unanswered_count ?? 0));
    stat(0, 1170, 'AKURASI', acc + '%');
    stat(1, 1170, 'WAKTU', shortDur(r.duration_seconds), null, 2);

    // Bar per kategori (maks 4 agar tetap lega dan aman dari UI Story).
    const cats = categoryRows(d).filter((c) => c.max).slice(0, 4);
    if (cats.length) {
      ctx.fillStyle = C.faint;
      ctx.fillRect(PAD, 1300, innerW, 2);
      ctx.fillStyle = C.muted;
      ctx.font = font(700, 26);
      spacing(ctx, 4);
      ctx.fillText('PER KATEGORI', PAD, 1370);
      spacing(ctx, 0);
      cats.forEach((c, i) => {
        const y = 1436 + i * 78;
        const val = (c.score ?? 0) + ' / ' + c.max;
        ctx.font = font(700, 32);
        const valW = ctx.measureText(val).width;
        ctx.fillStyle = C.text;
        ctx.fillText(val, PAD + innerW - valW, y);
        ctx.font = font(600, 32);
        ctx.fillText(fit(ctx, c.name, innerW - valW - 32), PAD, y);

        const by = y + 18, bh = 12;
        roundRect(ctx, PAD, by, innerW, bh, bh / 2);
        ctx.fillStyle = C.faint;
        ctx.fill();
        const frac = Math.max(0, Math.min(1, (c.score || 0) / c.max));
        if (frac > 0) {
          roundRect(ctx, PAD, by, innerW * frac, bh, bh / 2);
          ctx.fillStyle = c.passed === true ? C.green : c.passed === false ? C.amber : C.blue;
          ctx.fill();
        }
        if (c.min != null && c.min > 0 && c.min < c.max) {
          ctx.fillStyle = 'rgba(255,255,255,0.85)';
          ctx.fillRect(PAD + innerW * (c.min / c.max) - 2, by - 6, 4, bh + 12);
        }
      });
    }

    // Footer: tanggal (kiri) + brand kecil (kanan).
    const fy = 1790;
    ctx.fillStyle = C.muted;
    ctx.font = font(600, 28);
    ctx.fillText(TO.fmtDate(r.submitted_at), PAD, fy);

    ctx.font = font(800, 32);
    const brand = 'ditryout.in';
    const bw = ctx.measureText(brand).width;
    const icon = 40, gap = 14;
    const bx = W - PAD - bw;
    const ix = bx - gap - icon, iy = fy - 31;
    roundRect(ctx, ix, iy, icon, icon, 10);
    ctx.fillStyle = C.accent;
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(ix + 10, iy + 21);
    ctx.lineTo(ix + 17, iy + 28);
    ctx.lineTo(ix + 30, iy + 13);
    ctx.stroke();
    ctx.fillStyle = C.text;
    ctx.fillText(brand, bx, fy);

    return canvas;
  }

  function toBlob(canvas) {
    return new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Gagal membuat gambar.'))), 'image/png'));
  }

  function track(method) {
    if (typeof window.gtag === 'function') window.gtag('event', 'share_result', { method });
  }

  function shareText(r, link) {
    return 'Skor tryout UPKP saya: ' + r.score + '/' + r.max_score +
      (r.passing_available && r.passed ? ' (lulus passing grade)' : '') + '.\n' +
      'Latihan soal UPKP Imipas di ditryout.in' +
      (link ? ' — daftar lewat link saya dapat diskon 10%: ' + link : ': https://ditryout.in');
  }

  async function open(d) {
    const r = d.result;
    const referral = TO.api('/api/referral').then((x) => x.link).catch(() => null);
    await ensureFonts();
    const blob = await toBlob(draw(d));
    const url = URL.createObjectURL(blob);
    const file = typeof File === 'function' ? new File([blob], FILE_NAME, { type: 'image/png' }) : null;
    const canShareFile = !!(file && navigator.canShare && navigator.canShare({ files: [file] }));
    const link = await referral;
    const text = shareText(r, link);

    const wrapEl = document.createElement('div');
    wrapEl.className = 'modal-backdrop';
    wrapEl.innerHTML = `
      <div class="modal share-modal" role="dialog" aria-modal="true" aria-labelledby="share-title">
        <div class="share-head">
          <h3 id="share-title">Bagikan Hasil</h3>
          <button type="button" class="share-close" data-act="close" aria-label="Tutup">&times;</button>
        </div>
        <img class="share-preview" alt="Kartu hasil tryout" src="${url}">
        <p class="small muted">${canShareFile
          ? 'Bagikan ke Story/Status WhatsApp atau Instagram.'
          : 'Unduh gambar lalu unggah ke Story/Status WhatsApp atau Instagram. Di HP, Anda juga bisa menekan lama gambar untuk menyimpannya.'}</p>
        <div class="share-actions">
          ${canShareFile ? '<button type="button" class="btn btn-wide" data-act="share">Bagikan</button>' : ''}
          <a class="btn ${canShareFile ? 'btn-ghost' : 'btn-wide'}" data-act="download" href="${url}" download="${FILE_NAME}">Unduh Gambar</a>
          <button type="button" class="btn btn-ghost ${canShareFile ? '' : 'btn-wide'}" data-act="copy">Salin Teks &amp; Link</button>
        </div>
      </div>`;
    document.body.appendChild(wrapEl);

    const close = () => {
      document.removeEventListener('keydown', onKey);
      wrapEl.remove();
      URL.revokeObjectURL(url);
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    wrapEl.addEventListener('click', async (e) => {
      if (e.target === wrapEl) return close();
      const act = e.target.closest('[data-act]');
      if (!act) return;
      const kind = act.getAttribute('data-act');
      if (kind === 'close') close();
      else if (kind === 'download') track('download');
      else if (kind === 'copy') {
        const copied = await TO.copy(text);
        if (copied) track('copy_text');
        TO.toast(copied ? 'Teks & link disalin.' : 'Gagal menyalin teks.', copied ? 'success' : 'error');
      } else if (kind === 'share') {
        try {
          await navigator.share({ files: [file], text });
          track('web_share');
        } catch (err) {
          if (err && err.name !== 'AbortError') TO.toast('Gagal membagikan. Coba tombol Unduh.', 'error');
        }
      }
    });
  }

  window.ShareCard = { open };
})();
