/* Popup bukti sosial di landing page: hasil tryout terbaru yang lulus.
   Muncul sebentar lalu hilang, bergantian antar peserta. Jika data kurang
   dari 3, tiap peserta hanya ditampilkan sekali (tidak berulang) agar tidak
   terlihat repetitif. Nonaktif permanen setelah pengunjung menutupnya. */
(function () {
  'use strict';
  if (localStorage.getItem('sproof-off')) return;

  var SHOW_DELAY = 4000;                    // jeda sebelum muncul pertama kali
  var VISIBLE = 5000;                       // durasi tampil tiap popup
  var GAP_MIN = 8000, GAP_MAX = 14000;      // jeda acak antar popup

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

  (async function () {
    var data;
    try { data = (await TO.api('/api/recent-results')).results; }
    catch (e) { return; }
    if (!Array.isArray(data) || data.length === 0) return;
    // Data cukup banyak: berputar terus. Data sedikit: satu putaran lalu berhenti.
    var loop = data.length >= 3;

    var el = document.createElement('div');
    el.className = 'sproof';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.innerHTML =
      '<div class="sproof-icon" aria-hidden="true">✓</div>' +
      '<div class="sproof-body"></div>' +
      '<button type="button" class="sproof-close" aria-label="Tutup notifikasi">&times;</button>';
    document.body.appendChild(el);
    var body = el.querySelector('.sproof-body');

    var stopped = false;
    el.querySelector('.sproof-close').addEventListener('click', function () {
      stopped = true;
      localStorage.setItem('sproof-off', '1');
      el.remove();
    });

    // Putar urutan acak; acak ulang tiap selesai satu putaran (jangan langsung berulang).
    var order = shuffle(data.slice());
    var idx = 0, last = null;
    function next() {
      if (idx >= order.length) {
        if (!loop) return null; // mode sedikit data: habis satu putaran, berhenti
        shuffle(order);
        idx = 0;
        if (order.length > 1 && order[0] === last) {
          var t = order[0]; order[0] = order[1]; order[1] = t;
        }
      }
      last = order[idx++];
      return last;
    }

    function show() {
      if (stopped) return;
      if (document.hidden) { setTimeout(show, 5000); return; } // tab tidak terlihat: tunda
      var it = next();
      if (!it) return;
      body.innerHTML =
        '<strong>' + TO.esc(it.first_name) + '</strong> menyelesaikan tryout' +
        '<div class="sproof-title">“' + TO.esc(it.title) + '”</div>' +
        '<div class="sproof-meta"><span class="sproof-pass">Lulus</span> · Skor ' +
        it.score + '/' + it.max_score + ' · ' + relTime(it.submitted_at) + '</div>';
      el.classList.add('show');
      setTimeout(function () {
        el.classList.remove('show');
        setTimeout(show, GAP_MIN + Math.random() * (GAP_MAX - GAP_MIN));
      }, VISIBLE);
    }
    setTimeout(show, SHOW_DELAY);
  })();
})();
