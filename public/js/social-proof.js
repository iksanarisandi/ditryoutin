/* Popup bukti sosial di landing page: hasil tryout yang lulus, peserta yang
   sedang mengerjakan tryout, dan langganan paket terbaru — bergantian agar
   terlihat hidup dan tidak repetitif. Jika total data kurang dari 3, tiap
   entri hanya ditampilkan sekali. Nonaktif permanen setelah pengunjung
   menutupnya. */
(function () {
  'use strict';
  if (localStorage.getItem('sproof-off')) return;

  var SHOW_DELAY = 3000;                    // jeda sebelum muncul pertama kali
  var VISIBLE = 4500;                       // durasi tampil tiap popup
  var GAP_MIN = 4000, GAP_MAX = 7000;       // jeda acak antar popup

  function relTime(iso) {
    var min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (min < 1) return 'baru saja';
    if (min < 60) return min + ' menit lalu';
    var h = Math.round(min / 60);
    if (h < 24) return h + ' jam lalu';
    var d = Math.round(h / 24);
    return d === 1 ? 'kemarin' : d + ' hari lalu';
  }

  function shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  // Ikon & teks per jenis aktivitas.
  var ICONS = {
    passed: { glyph: '✓', cls: '' },
    active: { glyph: '✎', cls: 'active' },
    purchase: { glyph: '★', cls: 'purchase' },
  };
  function tpl(it) {
    var name = '<strong>' + TO.esc(it.first_name) + '</strong>';
    var title = '<div class="sproof-title">“' + TO.esc(it.title) + '”</div>';
    if (it.type === 'passed')
      return name + ' menyelesaikan tryout' + title +
        '<div class="sproof-meta"><span class="sproof-pass">Lulus</span> · Skor ' +
        it.score + '/' + it.max_score + ' · ' + relTime(it.time) + '</div>';
    if (it.type === 'active')
      return name + ' sedang mengerjakan tryout' + title +
        '<div class="sproof-meta"><span class="sproof-live">Berlangsung</span> · mulai ' +
        relTime(it.time) + '</div>';
    return name + ' berlangganan paket' + title +
      '<div class="sproof-meta"><span class="sproof-buy">Akses aktif</span> · ' +
      relTime(it.time) + '</div>';
  }

  (async function () {
    var feed;
    try { feed = (await TO.api('/api/recent-results')).feed; }
    catch (e) { return; }
    if (!Array.isArray(feed) || feed.length === 0) return;
    // Data cukup banyak: berputar terus. Data sedikit: satu putaran lalu berhenti.
    var loop = feed.length >= 3;

    var el = document.createElement('div');
    el.className = 'sproof';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.innerHTML =
      '<div class="sproof-icon" aria-hidden="true"></div>' +
      '<div class="sproof-body"></div>' +
      '<button type="button" class="sproof-close" aria-label="Tutup notifikasi">&times;</button>';
    document.body.appendChild(el);
    var icon = el.querySelector('.sproof-icon');
    var body = el.querySelector('.sproof-body');

    var stopped = false;
    el.querySelector('.sproof-close').addEventListener('click', function () {
      stopped = true;
      localStorage.setItem('sproof-off', '1');
      el.remove();
    });

    // Putar urutan acak; acak ulang tiap selesai satu putaran. Jangan tampilkan
    // jenis sama dua kali berturut-turut selama masih ada jenis lain.
    var order = [], last = null;
    function refill() {
      shuffle(order = feed.slice());
      if (last && order.length > 1 && order[0].type === last.type) {
        for (var k = 1; k < order.length; k++) {
          if (order[k].type !== last.type) {
            var t = order[0]; order[0] = order[k]; order[k] = t;
            break;
          }
        }
      }
    }
    function next() {
      if (order.length === 0) {
        if (!loop) return null; // mode sedikit data: habis satu putaran, berhenti
        refill();
      }
      var pick = 0;
      if (last && order[0].type === last.type) {
        for (var k = 1; k < order.length; k++) {
          if (order[k].type !== last.type) { pick = k; break; }
        }
      }
      last = order.splice(pick, 1)[0];
      return last;
    }

    function show() {
      if (stopped) return;
      if (document.hidden) { setTimeout(show, 5000); return; } // tab tidak terlihat: tunda
      var it = next();
      if (!it) return;
      icon.textContent = ICONS[it.type].glyph;
      icon.className = 'sproof-icon' + (ICONS[it.type].cls ? ' ' + ICONS[it.type].cls : '');
      body.innerHTML = tpl(it);
      el.classList.add('show');
      setTimeout(function () {
        el.classList.remove('show');
        setTimeout(show, GAP_MIN + Math.random() * (GAP_MAX - GAP_MIN));
      }, VISIBLE);
    }
    setTimeout(show, SHOW_DELAY);
  })();
})();
