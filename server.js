// Mezzome — тех. карты и калькулятор закладки.
// Сервер без внешних зависимостей (Node 18+). Хранение правок:
//   • DATABASE_URL задан  → PostgreSQL (нужен пакет "pg", ставится через npm install);
//   • иначе               → файл edits.json в папке DATA_DIR (на Render — подключённый Disk).
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const PORT = process.env.PORT || 3000;
const LOGIN = process.env.APP_LOGIN || '0000';
const PASSWORD = process.env.APP_PASSWORD || '0000';
const SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('mezzome:' + LOGIN + ':' + PASSWORD).digest('hex');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'storage');
const PUBLIC = path.join(__dirname, 'public');
const BASE_FILE = path.join(__dirname, 'data', 'base.json');
const SESSION_DAYS = 30;

// ---------- base data ----------
const baseRaw = fs.readFileSync(BASE_FILE);
const BASE = JSON.parse(baseRaw);
const BASE_CODES = new Set(BASE.cards.map(c => c.code));
const baseGz = zlib.gzipSync(baseRaw);
const baseEtag = '"' + crypto.createHash('md5').update(baseRaw).digest('hex') + '"';

// ---------- storage ----------
const store = (() => {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false } });
    let ready = pool.query('CREATE TABLE IF NOT EXISTS card_edits (code TEXT PRIMARY KEY, doc JSONB NOT NULL, at BIGINT NOT NULL)')
      .then(() => pool.query('CREATE TABLE IF NOT EXISTS card_done (code TEXT PRIMARY KEY, info JSONB NOT NULL)'));
    return {
      kind: 'postgres',
      async all() { await ready; const r = await pool.query('SELECT code, doc FROM card_edits'); const o = {}; r.rows.forEach(x => o[x.code] = x.doc); return o; },
      async put(code, doc) { await ready; await pool.query('INSERT INTO card_edits(code, doc, at) VALUES($1,$2,$3) ON CONFLICT (code) DO UPDATE SET doc = EXCLUDED.doc, at = EXCLUDED.at', [code, doc, doc.at]); },
      async del(code) { await ready; await pool.query('DELETE FROM card_edits WHERE code = $1', [code]); },
      async doneAll() { await ready; const r = await pool.query('SELECT code, info FROM card_done'); const o = {}; r.rows.forEach(x => o[x.code] = x.info); return o; },
      async setDone(code, info) { await ready; if (info) await pool.query('INSERT INTO card_done(code, info) VALUES($1,$2) ON CONFLICT (code) DO UPDATE SET info = EXCLUDED.info', [code, info]); else await pool.query('DELETE FROM card_done WHERE code = $1', [code]); },
    };
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, 'edits.json');
  let mem = {};
  try { mem = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { mem = {}; }
  const doneFile = path.join(DATA_DIR, 'done.json');
  let done = {};
  try { done = JSON.parse(fs.readFileSync(doneFile, 'utf8')); } catch (e) { done = {}; }
  const flushDone = () => new Promise(res => fs.writeFile(doneFile + '.tmp', JSON.stringify(done), err => { if (err) return res(); fs.rename(doneFile + '.tmp', doneFile, () => res()); }));
  let chain = Promise.resolve();
  const flush = () => { chain = chain.then(() => new Promise(res => {
    const tmp = file + '.tmp';
    fs.writeFile(tmp, JSON.stringify(mem), err => { if (err) { console.error('write failed', err); return res(); } fs.rename(tmp, file, () => res()); });
  })); return chain; };
  return {
    kind: 'file:' + file,
    async all() { return mem; },
    async put(code, doc) { mem[code] = doc; await flush(); },
    async del(code) { delete mem[code]; await flush(); },
    async doneAll() { return done; },
    async setDone(code, info) { if (info) done[code] = info; else delete done[code]; await flushDone(); },
  };
})();

// ---------- auth ----------
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + mac;
}
function verify(token) {
  if (!token || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const good = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (mac.length !== good.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(good))) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString()); return p.exp > Date.now() ? p : null; } catch (e) { return null; }
}
function cookies(req) {
  const o = {}; (req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return o;
}
function session(req) { return verify(cookies(req).mz); }
function eqSafe(a, b) { const A = Buffer.from(String(a)), B = Buffer.from(String(b)); return A.length === B.length && crypto.timingSafeEqual(A, B); }

// ---------- helpers ----------
function send(req, res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra };
  if (buf.length > 1024 && /gzip/.test(req.headers['accept-encoding'] || '') && !headers['Content-Encoding']) { buf = zlib.gzipSync(buf); headers['Content-Encoding'] = 'gzip'; }
  headers['Content-Length'] = buf.length;
  res.writeHead(status, headers); res.end(buf);
}
function readBody(req, limit = 2e6) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
function serveStatic(req, res, rel) {
  const p = path.normalize(path.join(PUBLIC, rel));
  if (!p.startsWith(PUBLIC)) return send(req, res, 404, 'Not found', 'text/plain');
  fs.readFile(p, (err, buf) => {
    if (err) return send(req, res, 404, 'Not found', 'text/plain');
    send(req, res, 200, buf, MIME[path.extname(p)] || 'application/octet-stream', { 'Cache-Control': 'no-cache' });
  });
}
function cleanNum(v) { const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(',', '.')); return isFinite(n) ? Math.round(n * 1000) / 1000 : null; }
function cleanStr(v, max) { return String(v ?? '').slice(0, max); }
function cleanDoc(d, who, prevLog) {
  const ing = Array.isArray(d.ing) ? d.ing.slice(0, 80).map(r => ({ p: cleanStr(r.p, 200), code: cleanStr(r.code, 40), u: cleanStr(r.u, 6), br: cleanNum(r.br), nt: cleanNum(r.nt), note: cleanStr(r.note, 2000) })) : [];
  const steps = Array.isArray(d.steps) ? d.steps.slice(0, 60).map(s => cleanStr(s, 3000)) : [];
  const at = Date.now();
  const log = (Array.isArray(prevLog) ? prevLog : []).slice(-29);
  log.push({ by: who, at, what: cleanStr(d.what, 1500) });
  return { cat: cleanStr(d.cat, 120), out: cleanNum(d.out), ou: cleanStr(d.ou, 6), halal: !!d.halal, comment: cleanStr(d.comment, 2000), ing, steps, by: who, at, log };
}
function csvCell(v) { const s = v === null || v === undefined ? '' : String(v); return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
const nf = v => v === null || v === undefined ? '' : String(v).replace('.', ',');

// ---------- routes ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const me = session(req);

    if (p === '/healthz') return send(req, res, 200, { ok: true, storage: store.kind.startsWith('file') ? 'file' : 'postgres' });
    if (p === '/login' || p === '/login.html') return serveStatic(req, res, 'login.html');
    if (p.startsWith('/assets/')) return serveStatic(req, res, p.slice(1));

    if (p === '/api/login' && req.method === 'POST') {
      const b = await readBody(req, 1e4).catch(() => ({}));
      const name = cleanStr(b.name, 60).trim();
      if (!eqSafe(b.login ?? '', LOGIN) || !eqSafe(b.password ?? '', PASSWORD)) {
        await new Promise(r => setTimeout(r, 600));
        return send(req, res, 401, { error: 'Неверный логин или пароль' });
      }
      if (!name) return send(req, res, 400, { error: 'Укажите своё имя — оно будет видно в истории правок' });
      const secure = (req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
      const tok = sign({ name, exp: Date.now() + SESSION_DAYS * 864e5 });
      return send(req, res, 200, { ok: true, name }, undefined, { 'Set-Cookie': `mz=${encodeURIComponent(tok)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}` });
    }
    if (p === '/api/logout' && req.method === 'POST') return send(req, res, 200, { ok: true }, undefined, { 'Set-Cookie': 'mz=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' });

    if (!me) {
      if (p.startsWith('/api/')) return send(req, res, 401, { error: 'Нужно войти' });
      res.writeHead(302, { Location: '/login' }); return res.end();
    }

    if (p === '/' || p === '/index.html') return serveStatic(req, res, 'index.html');
    if (p === '/api/me') return send(req, res, 200, { name: me.name, storage: store.kind.startsWith('file') ? 'file' : 'postgres' });
    if (p === '/api/base') {
      if (req.headers['if-none-match'] === baseEtag) { res.writeHead(304, { ETag: baseEtag }); return res.end(); }
      const gz = /gzip/.test(req.headers['accept-encoding'] || '');
      const buf = gz ? baseGz : baseRaw;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-cache', ETag: baseEtag, 'Content-Length': buf.length, ...(gz ? { 'Content-Encoding': 'gzip' } : {}) });
      return res.end(buf);
    }
    if (p === '/api/edits' && req.method === 'GET') return send(req, res, 200, await store.all());
    if (p === '/api/state' && req.method === 'GET') { const [edits, done] = await Promise.all([store.all(), store.doneAll()]); return send(req, res, 200, { edits, done }); }
    const dm = p.match(/^\/api\/done\/([A-Za-z0-9_.\-]+)$/);
    if (dm && req.method === 'PUT') {
      if (!BASE_CODES.has(dm[1])) return send(req, res, 404, { error: 'Нет такой карты' });
      const b = await readBody(req, 1e4);
      const info = b.done ? { by: me.name, at: Date.now() } : null;
      await store.setDone(dm[1], info);
      return send(req, res, 200, { code: dm[1], done: info });
    }

    const m = p.match(/^\/api\/cards\/([A-Za-z0-9_.\-]+)$/);
    if (m) {
      const code = m[1];
      if (!BASE_CODES.has(code)) return send(req, res, 404, { error: 'Нет такой карты' });
      const all = await store.all();
      const cur = all[code] || null;
      if (req.method === 'PUT') {
        const b = await readBody(req);
        const prevAt = Number(b.prevAt || 0);
        if ((cur ? cur.at : 0) !== prevAt && !b.force) return send(req, res, 409, { error: 'conflict', current: cur });
        const doc = cleanDoc(b.doc || {}, me.name, cur && cur.log);
        await store.put(code, doc);
        return send(req, res, 200, doc);
      }
      if (req.method === 'DELETE') { await store.del(code); return send(req, res, 200, { ok: true }); }
      return send(req, res, 405, { error: 'method' });
    }

    if (p === '/api/export.csv') {
      const all = await store.all();
      const rows = [['Категория', 'Блюдо', 'Код карты', 'Выход', 'Ед. выхода', 'Продукт', 'Код SAP', 'Ед.', 'Брутто', 'Нетто', 'Примечание', 'Изменил', 'Когда', 'Готово']];
      const doneMap = await store.doneAll();
      for (const c of BASE.cards) {
        const dn = doneMap[c.code] ? 'да (' + doneMap[c.code].by + ')' : '';
        const e = all[c.code] ? { ...c, ...all[c.code] } : c;
        const who = all[c.code] ? all[c.code].by : '', when = all[c.code] ? new Date(all[c.code].at).toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' }) : '';
        for (const r of e.ing) rows.push([e.cat, c.name, c.code, nf(e.out), e.ou, (r.p || '').split(' · ')[0], r.code, r.u, nf(r.br), nf(r.nt), r.note, who, when, dn]);
      }
      const csv = '﻿' + rows.map(r => r.map(csvCell).join(';')).join('\r\n');
      return send(req, res, 200, csv, 'text/csv; charset=utf-8', { 'Content-Disposition': 'attachment; filename="mezzome_techcards.csv"' });
    }

    return send(req, res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(e);
    return send(req, res, 500, { error: 'Ошибка сервера' });
  }
});

server.listen(PORT, () => console.log(`Mezzome тех. карты: http://localhost:${PORT}  (хранение: ${store.kind})`));
