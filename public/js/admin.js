/* Shared admin: guard + sidebar + helper tabel/pager/modal sederhana. */
(function () {
  'use strict';

  const NAV = [
    ['/admin/', 'Dashboard'],
    ['/admin/users.html', 'Users'],
    ['/admin/products.html', 'Produk Akses'],
    ['/admin/packages.html', 'Paket Tryout'],
    ['/admin/categories.html', 'Kategori'],
    ['/admin/questions.html', 'Soal'],
    ['/admin/import.html', 'Import JSON'],
    ['/admin/payments.html', 'Transaksi'],
    ['/admin/results.html', 'Hasil/Percobaan'],
  ];

  function renderAdminShell(active, me) {
    const header = document.getElementById('site-header');
    if (header) {
      header.className = 'topbar';
      header.innerHTML = `
        <div class="container topbar-inner">
          <a class="brand" href="/">TRYOUT UPKP<span class="sub">Panel Admin</span></a>
          <div class="topbar-right">
            <span class="topbar-user">${TO.esc(me.user.name)}</span>
            <a href="/dashboard.html" class="btn btn-sm" style="background:rgba(255,255,255,.14)">Ke Aplikasi</a>
            <a href="#" id="admin-logout" class="btn btn-sm" style="background:rgba(255,255,255,.14)">Keluar</a>
          </div>
        </div>`;
      document.getElementById('admin-logout').addEventListener('click', (e) => { e.preventDefault(); TO.logout(); });
    }
    const side = document.getElementById('admin-side');
    if (side) {
      side.className = 'admin-side';
      side.innerHTML = `<div class="side-brand"><img src="/img/favicon-48.png" alt="" width="26" height="26">Panel Admin</div>` +
        NAV.map(([href, label]) =>
          `<a href="${href}" ${href === active ? 'class="active"' : ''}>${label}</a>`).join('');
    }
  }

  async function adminInit(active) {
    const me = await TO.requireAdmin();
    if (!me) return null;
    renderAdminShell(active, me);
    return me;
  }

  // Render pager standar: total, page, per_page -> tombol prev/next
  function pagerHtml(total, page, per) {
    const pages = Math.max(1, Math.ceil(total / per));
    return `
      <span class="info">Total ${total} — halaman ${page} dari ${pages}</span>
      <button class="btn btn-sm btn-ghost" data-pg="${page - 1}" ${page <= 1 ? 'disabled' : ''}>&#8592; Sebelumnya</button>
      <button class="btn btn-sm btn-ghost" data-pg="${page + 1}" ${page >= pages ? 'disabled' : ''}>Berikutnya &#8594;</button>`;
  }

  function bindPager(el, onGo) {
    el.querySelectorAll('[data-pg]').forEach((b) => {
      b.addEventListener('click', () => onGo(Number(b.dataset.pg)));
    });
  }

  window.ADM = { adminInit, pagerHtml, bindPager };
})();
