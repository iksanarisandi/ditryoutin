// Regresi ekspor tanpa akses DB produksi atau pengiriman data ke penyedia email.
// Jalankan dengan Node >=22.13: node scripts/test-contact-export.mjs
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { Hono } from 'hono';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const modules = new Map();
// Kompilasi dalam memori agar pengujian memakai handler dan middleware asli tanpa bundler baru.
function loadTs(filename) {
  if (modules.has(filename)) return modules.get(filename).exports;
  const module = { exports: {} };
  modules.set(filename, module);
  const source = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const localRequire = (specifier) => {
    if (!specifier.startsWith('.')) return require(specifier);
    const target = path.resolve(path.dirname(filename), specifier) + '.ts';
    assert.ok(existsSync(target), `Module not found: ${target}`);
    return loadTs(target);
  };
  new Function('require', 'module', 'exports', source)(localRequire, module, module.exports);
  return module.exports;
}

const { exportContacts, contactsCsv, isContactSegment } = loadTs(path.join(root, 'src/services/contact-export.ts'));
const { default: router } = loadTs(path.join(root, 'src/routes/admin/users.ts'));
const sqlite = new DatabaseSync(':memory:');
sqlite.exec(`
  CREATE TABLE users (
    id INTEGER PRIMARY KEY, email TEXT, name TEXT, role TEXT, access_expires_at TEXT,
    google_sub TEXT, email_verified_at TEXT
  );
  CREATE TABLE payments (id INTEGER PRIMARY KEY, user_id INTEGER, status TEXT);
`);
const now = '2026-10-16T00:00:00.000Z';
const users = [
  [1, ' New@Gmail.com ', 'Satu', 'user', null],
  [2, 'expired@gmail.com', 'Dua Nama', 'user', '2026-01-01T00:00:00.000Z'],
  [3, 'active@gmail.com', 'Tiga Nama Panjang', 'user', '2099-01-01T00:00:00.000Z'],
  [4, 'manual@gmail.com', 'Empat', 'user', '2099-01-01T00:00:00.000Z'],
  [5, 'admin@gmail.com', 'Admin', 'admin', null],
  [6, 'other@yahoo.com', 'Other', 'user', null],
  [7, 'fake@gmail.com.evil', 'Fake', 'user', null],
  [8, 'alias+latihan@gmail.com', 'Alias', 'user', null],
  [9, 'NEW@gmail.com', 'Duplikat', 'user', null],
  [10, 'pending@gmail.com', '=HYPERLINK("bad")', 'user', null],
  [11, 'boundary@gmail.com', 'Boundary', 'user', now],
  [12, 'alternate@googlemail.com', 'Alternate', 'user', null],
  [13, 'invalid space@gmail.com', 'Invalid', 'user', null],
  [14, 'last@gmail.com', 'Last', 'user', null],
];
for (const row of users) {
  sqlite.prepare('INSERT INTO users (id, email, name, role, access_expires_at) VALUES (?, ?, ?, ?, ?)').run(...row);
}
for (const id of [2, 4, 5, 6, 7, 8, 9, 11, 12, 13]) {
  sqlite.prepare('UPDATE users SET google_sub=?, email_verified_at=? WHERE id=?').run(`google-${id}`, now, id);
}
// Reset password juga memverifikasi email, tetapi bukan bukti pernah login Google.
sqlite.prepare('UPDATE users SET email_verified_at=? WHERE id=10').run(now);
for (const [id, userId, status] of [[1, 2, 'paid'], [2, 2, 'paid'], [3, 3, 'paid'], [4, 10, 'pending'], [5, 11, 'paid']]) {
  sqlite.prepare('INSERT INTO payments VALUES (?, ?, ?)').run(id, userId, status);
}
let queryCount = 0;
const db = {
  prepare(sql) {
    queryCount++;
    let values = [];
    return {
      bind(...args) { values = args; return this; },
      async all() {
        // SQLite Node memperlakukan parameter ?1 sebagai parameter bernama.
        const params = Object.fromEntries(values.map((value, i) => [String(i + 1), value]));
        return { results: sqlite.prepare(sql).all(params) };
      },
    };
  },
};
const emails = async (segment, googleOnly = false) => (await exportContacts(db, segment, now, googleOnly)).map((c) => c.email);
assert.deepEqual(await emails('never_paid'), ['new@gmail.com', 'alias+latihan@gmail.com', 'pending@gmail.com', 'last@gmail.com']);
assert.deepEqual(await emails('expired'), ['expired@gmail.com', 'boundary@gmail.com']);
assert.deepEqual(await emails('active'), ['active@gmail.com', 'manual@gmail.com']);
assert.equal((await emails('all')).length, 8);
assert.deepEqual(await emails('never_paid', true), ['alias+latihan@gmail.com', 'new@gmail.com']);
assert.deepEqual(await emails('expired', true), ['expired@gmail.com', 'boundary@gmail.com']);
assert.deepEqual(await emails('active', true), ['manual@gmail.com']);
assert.deepEqual(await emails('all', true), [
  'expired@gmail.com', 'manual@gmail.com', 'alias+latihan@gmail.com', 'new@gmail.com', 'boundary@gmail.com',
]);
assert.equal(isContactSegment('__proto__'), false);
assert.equal(isContactSegment('all'), true);
assert.equal(contactsCsv([]), 'EMAIL,FIRSTNAME,LASTNAME\r\n');
assert.equal(
  contactsCsv([{ email: 'one@gmail.com', name: 'Satu' }, { email: 'two@gmail.com', name: 'Dua Nama Panjang' }]),
  'EMAIL,FIRSTNAME,LASTNAME\r\n"one@gmail.com","Satu",""\r\n"two@gmail.com","Dua","Nama Panjang"\r\n',
);
assert.ok(contactsCsv([{ email: 'safe@gmail.com', name: '=FORMULA("x"), +TEST' }]).includes(`"'=FORMULA(""x""),","'+TEST"`));
assert.ok(contactsCsv([{ email: 'safe@gmail.com', name: 'Nama\nBaru' }]).includes('"Nama","Baru"'));
assert.ok(contactsCsv([{ email: 'safe@gmail.com', name: 'Éka "Nama,Baru"' }]).includes('"Éka","""Nama,Baru"""'));

const app = new Hono();
app.use('*', async (c, next) => {
  const role = c.req.header('x-test-role');
  if (role) c.set('user', { role });
  await next();
});
app.route('/api/admin/users', router);
const request = (query, role = 'admin') => app.request('/api/admin/users/export?' + query, {
  headers: role ? { 'x-test-role': role } : {},
}, { DB: db });
const before = queryCount;
assert.equal((await request('segment=all', null)).status, 401);
assert.equal((await request('segment=all', 'user')).status, 403);
assert.equal((await request('segment=__proto__')).status, 400);
assert.equal((await request('segment=all&format=xml')).status, 400);
assert.equal((await request('segment=all&google_only=true')).status, 400);
assert.equal((await request('segment=all&google_only=')).status, 400);
assert.equal((await request('segment=all&google_only=2')).status, 400);
assert.equal((await request('')).status, 400);
assert.equal(queryCount, before);
const preview = await request('segment=all&format=preview&q=no-match&page=99');
assert.equal(preview.status, 200);
assert.deepEqual(await preview.json(), { success: true, data: { total: 8 } });
assert.equal(preview.headers.get('cache-control'), 'private, no-store');
const csv = await request('segment=all');
assert.equal(csv.status, 200);
assert.equal(csv.headers.get('content-type'), 'text/csv; charset=utf-8');
assert.equal(csv.headers.get('cache-control'), 'private, no-store');
assert.match(csv.headers.get('content-disposition'), /^attachment; filename="brevo-gmail-semua-pengguna-\d{4}-\d{2}-\d{2}\.csv"$/);
assert.equal((await csv.text()).split('\r\n').length, 10);
assert.deepEqual(await (await request('segment=all&format=preview&google_only=0')).json(), {
  success: true, data: { total: 8 },
});
const googlePreview = await request('segment=all&format=preview&google_only=1&q=no-match&page=99');
assert.deepEqual(await googlePreview.json(), { success: true, data: { total: 5 } });
assert.equal(googlePreview.headers.get('cache-control'), 'private, no-store');
const googleCsv = await request('segment=all&google_only=1');
assert.equal(googleCsv.status, 200);
assert.equal(googleCsv.headers.get('content-type'), 'text/csv; charset=utf-8');
assert.equal(googleCsv.headers.get('cache-control'), 'private, no-store');
assert.match(googleCsv.headers.get('content-disposition'), /^attachment; filename="brevo-gmail-semua-pengguna-login-google-\d{4}-\d{2}-\d{2}\.csv"$/);
assert.equal(await googleCsv.text(), contactsCsv(await exportContacts(db, 'all', now, true)));
for (const segment of ['never_paid', 'expired', 'active']) {
  const expected = await exportContacts(db, segment, new Date().toISOString(), true);
  assert.deepEqual(await (await request(`segment=${segment}&format=preview&google_only=1`)).json(), {
    success: true, data: { total: expected.length },
  });
  assert.equal(await (await request(`segment=${segment}&google_only=1`)).text(), contactsCsv(expected));
}
for (let id = 20; id < 45; id++) {
  sqlite.prepare('INSERT INTO users (id, email, name, role, access_expires_at) VALUES (?, ?, ?, ?, ?)').run(id, `extra${id}@gmail.com`, 'Extra', 'user', null);
}
const beyondPage = await request('segment=all&format=preview&page=99&q=no-match');
assert.deepEqual(await beyondPage.json(), { success: true, data: { total: 33 } });
assert.equal((await (await request('segment=all')).text()).split('\r\n').length, 35);
sqlite.prepare('DELETE FROM users').run();
const empty = await request('segment=all');
assert.equal(await empty.text(), 'EMAIL,FIRSTNAME,LASTNAME\r\n');
assert.deepEqual(await (await request('segment=all&google_only=1&format=preview')).json(), {
  success: true, data: { total: 0 },
});
assert.equal(await (await request('segment=all&google_only=1')).text(), 'EMAIL,FIRSTNAME,LASTNAME\r\n');
sqlite.close();

// Uji event UI dengan DOM tiruan tanpa browser atau data pengguna.
const html = readFileSync(path.join(root, 'public/admin/users.html'), 'utf8');
const inlineScripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
for (const match of inlineScripts) new Function(match[1]);
assert.match(html, /<label class="checkbox-line"><input type="checkbox" id="export-google-only">/);
const elements = new Map();
function element(id) {
  if (!elements.has(id)) elements.set(id, {
    value: '', checked: false, disabled: false, textContent: '', innerHTML: '',
    listeners: new Map(),
    addEventListener(event, callback) { this.listeners.set(event, callback); },
  });
  return elements.get(id);
}
element('export-segment').value = 'all';
const apiUrls = [];
const downloadUrls = [];
let downloadTask;
let failDownload = false;
let previewTotal;
const errors = [];
await new Function('ADM', 'TO', 'document', 'fetch', 'URL', 'setTimeout', 'return ' + inlineScripts[0][1].trim())(
  { adminInit: async () => ({}), pagerHtml: () => '', bindPager: () => {} },
  {
    async api(url) {
      apiUrls.push(url);
      if (url.startsWith('/api/admin/users/export?')) {
        const params = new URL(url, 'https://example.test').searchParams;
        return { total: previewTotal ?? (params.get('google_only') === '1' ? 5 : 8) };
      }
      return { users: [], total: 0, page: 1, per_page: 20 };
    },
    busy(button, label, task) { downloadTask = task(); return downloadTask; },
    toast(message, type) { if (type === 'error') errors.push(message); },
  },
  {
    getElementById: element,
    createElement: () => ({ click() {}, remove() {} }),
    body: { appendChild() {} },
  },
  async (url) => {
    downloadUrls.push(url);
    assert.equal(element('export-segment').disabled, true);
    assert.equal(element('export-google-only').disabled, true);
    if (failDownload) throw new Error('Unduhan gagal');
    return new Response('EMAIL,FIRSTNAME,LASTNAME\r\n', {
      headers: { 'Content-Disposition': 'attachment; filename="test.csv"' },
    });
  },
  { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
  (callback) => callback(),
);
assert.match(element('export-count').textContent, /^8 kontak Gmail dapat diekspor/);
assert.equal(element('export-btn').disabled, false);
element('export-google-only').checked = true;
await element('export-google-only').listeners.get('change')();
assert.match(element('export-count').textContent, /^5 kontak Gmail yang pernah login Google/);
assert.equal(new URL(apiUrls.at(-1), 'https://example.test').searchParams.get('google_only'), '1');
element('export-btn').listeners.get('click')();
await downloadTask;
assert.equal(new URL(downloadUrls.at(-1), 'https://example.test').searchParams.get('google_only'), '1');
assert.equal(element('export-google-only').disabled, false);
assert.equal(element('export-segment').disabled, false);
element('export-google-only').checked = false;
await element('export-google-only').listeners.get('change')();
assert.match(element('export-count').textContent, /^8 kontak Gmail dapat diekspor/);
element('export-btn').listeners.get('click')();
await downloadTask;
assert.equal(new URL(downloadUrls.at(-1), 'https://example.test').searchParams.get('google_only'), '0');
failDownload = true;
element('export-btn').listeners.get('click')();
await assert.rejects(downloadTask, /Unduhan gagal/);
assert.equal(element('export-google-only').disabled, false);
assert.equal(element('export-segment').disabled, false);
assert.deepEqual(errors, ['Unduhan gagal']);
previewTotal = 0;
element('export-google-only').checked = true;
await element('export-google-only').listeners.get('change')();
assert.equal(element('export-btn').disabled, true);
console.log('Contact export regression checks passed (Google and segment filters, CSV, admin guard, headers, preview, empty export, UI events).');
