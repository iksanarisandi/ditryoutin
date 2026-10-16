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
  CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, name TEXT, role TEXT, access_expires_at TEXT);
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
for (const row of users) sqlite.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?)').run(...row);
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
const emails = async (segment) => (await exportContacts(db, segment, now)).map((c) => c.email);
assert.deepEqual(await emails('never_paid'), ['new@gmail.com', 'alias+latihan@gmail.com', 'pending@gmail.com', 'last@gmail.com']);
assert.deepEqual(await emails('expired'), ['expired@gmail.com', 'boundary@gmail.com']);
assert.deepEqual(await emails('active'), ['active@gmail.com', 'manual@gmail.com']);
assert.equal((await emails('all')).length, 8);
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
for (let id = 20; id < 45; id++) {
  sqlite.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?)').run(id, `extra${id}@gmail.com`, 'Extra', 'user', null);
}
const beyondPage = await request('segment=all&format=preview&page=99&q=no-match');
assert.deepEqual(await beyondPage.json(), { success: true, data: { total: 33 } });
assert.equal((await (await request('segment=all')).text()).split('\r\n').length, 35);
sqlite.prepare('DELETE FROM users').run();
const empty = await request('segment=all');
assert.equal(await empty.text(), 'EMAIL,FIRSTNAME,LASTNAME\r\n');
sqlite.close();

// Syntax-check JavaScript inline tanpa menjalankan browser atau mengubah data pengguna.
const html = readFileSync(path.join(root, 'public/admin/users.html'), 'utf8');
for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Function(match[1]);
console.log('Contact export regression checks passed (filters, CSV, admin guard, headers, preview, empty export, UI syntax).');
