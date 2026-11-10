'use strict';
/*
 * Vue connectee au dossier assets : petit serveur local (http natif).
 *   node cli.js serve [--config unslop.config.json] [--port 4870]
 * Securite : ecoute 127.0.0.1 seulement ; Host / Origin verifies (rebinding,
 * CSRF) ; en-tete X-Unslop obligatoire pour toute ecriture ; chemins resolus et
 * confines aux dossiers source / output (y compris liens symboliques) ; aucune
 * ecriture ni suppression dans source ; aucune suppression du tout ; corps de
 * requete limites.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PC = require('./pixelclean-core.js');
const CLI = require('./cli.js');

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/pixelclean-core.js': ['pixelclean-core.js', 'text/javascript; charset=utf-8'],
};
const IMG_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const MANIFEST = '.unslop-status.json';
const MAX_BODY = 64 * 1024;
const MANUAL = new Set(['validated', 'review', 'done']);
const CSP = "default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

const isWin = process.platform === 'win32';
const norm = (p) => (isWin ? p.toLowerCase() : p);
function inside(root, p) {
  const r = norm(root), q = norm(p);
  return q === r || q.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

// Resout un chemin relatif (style "dossier/image.png") sous root, ou refuse.
function safeResolve(rootReal, rel, mustExist) {
  if (typeof rel !== 'string' || !rel || rel.length > 1024) throw new HttpError(400, 'chemin invalide');
  if (/[\0\\:*?"<>|]/.test(rel) || rel.startsWith('/') || rel.startsWith('~')) throw new HttpError(400, 'chemin refuse');
  const parts = rel.split('/');
  for (const p of parts) {
    if (!p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(p)) throw new HttpError(400, 'chemin refuse');
  }
  const abs = path.resolve(rootReal, ...parts);
  if (!inside(rootReal, abs)) throw new HttpError(403, 'hors du dossier autorise');
  // liens symboliques / jonctions : le chemin reel doit rester dans root
  let probe = abs;
  while (!fs.existsSync(probe)) {
    const up = path.dirname(probe);
    if (up === probe) break;
    probe = up;
  }
  let real;
  try { real = fs.realpathSync(probe); } catch (e) { throw new HttpError(403, 'chemin refuse'); }
  if (!inside(rootReal, real)) throw new HttpError(403, 'hors du dossier autorise');
  if (mustExist && !fs.existsSync(abs)) throw new HttpError(404, 'introuvable');
  return abs;
}

function toRel(root, abs) { return path.relative(root, abs).split(path.sep).join('/'); }
function outRelOf(rel) { return rel.replace(/\.[^./]+$/, '') + '.png'; }
function sha1(file) { return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex'); }

function writeAtomic(file, text) {
  const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function createApp(opts) {
  const cfgFile = opts.configFile ? path.resolve(opts.configFile) : null;
  if (!cfgFile || !fs.existsSync(cfgFile)) throw new Error('fichier unslop.config.json introuvable (indiquez --config)');
  let cfg = CLI.loadConfig(cfgFile);
  let cfgMtime = fs.statSync(cfgFile).mtimeMs;
  const raw = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  if (!raw.source || !raw.output) throw new Error('la config doit definir "source" et "output"');
  const sourceAbs = path.resolve(cfg.dir, raw.source), outputAbs = path.resolve(cfg.dir, raw.output);
  if (!fs.existsSync(sourceAbs) || !fs.statSync(sourceAbs).isDirectory()) throw new Error('dossier source introuvable : ' + sourceAbs);
  fs.mkdirSync(outputAbs, { recursive: true });
  const SRC = fs.realpathSync(sourceAbs), OUT = fs.realpathSync(outputAbs);
  if (inside(SRC, OUT) || inside(OUT, SRC)) throw new Error('"source" et "output" doivent etre deux dossiers distincts (pas l\'un dans l\'autre)');
  const manifestFile = path.join(OUT, MANIFEST);
  const busy = new Set();
  const hashCache = new Map();
  const clients = new Set();
  let queue = Promise.resolve();

  const reloadConfig = () => {
    try {
      const m = fs.statSync(cfgFile).mtimeMs;
      if (m !== cfgMtime) { cfg = CLI.loadConfig(cfgFile); cfgMtime = m; }
    } catch (e) { /* on garde la config precedente */ }
  };
  const loadManifest = () => {
    try {
      const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      if (m && typeof m.files === 'object') return m;
    } catch (e) { /* absent ou illisible */ }
    return { version: 1, files: {} };
  };
  const saveManifest = (m) => writeAtomic(manifestFile, JSON.stringify(m, null, 1));

  const srcHash = (abs, st) => {
    const key = abs + '|' + st.mtimeMs + '|' + st.size;
    if (!hashCache.has(key)) hashCache.set(key, sha1(abs));
    return hashCache.get(key);
  };

  function sources() {
    return CLI.collect([SRC], OUT).filter((it) => {
      try { return inside(SRC, fs.realpathSync(it.abs)); } catch (e) { return false; }
    });
  }

  function statusOf(rel, abs, m) {
    const e = m.files[rel];
    const outAbs = path.join(OUT, ...outRelOf(rel).split('/'));
    const st = fs.statSync(abs);
    const hasOut = fs.existsSync(outAbs);
    const info = { rel, status: 'missing', hasOutput: hasOut, outRel: hasOut ? outRelOf(rel) : null, srcMtime: st.mtimeMs, outMtime: hasOut ? fs.statSync(outAbs).mtimeMs : null };
    if (e) Object.assign(info, { info: e.info, width: e.width, height: e.height, colors: e.colors, source: e.source, score: e.score, error: e.error, overrides: e.overrides || null });
    if (busy.has(rel)) info.status = 'processing';
    else if (e && e.srcHash && (e.srcSize !== st.size || e.srcMtime !== st.mtimeMs) && srcHash(abs, st) !== e.srcHash) info.status = 'stale';
    else if (e && e.status === 'error') info.status = 'error';
    else if (!hasOut) info.status = 'missing';
    else if (e && MANUAL.has(e.status)) info.status = e.status;
    else info.status = 'done';
    return info;
  }

  function tree() {
    const m = loadManifest();
    const files = sources().map((it) => statusOf(toRel(SRC, it.abs), it.abs, m));
    return { source: SRC, output: OUT, files };
  }

  function broadcast(event, data) {
    const msg = 'event: ' + event + '\ndata: ' + JSON.stringify(data || {}) + '\n\n';
    for (const res of clients) res.write(msg);
  }

  function cleanOverrides(o) {
    if (!o || typeof o !== 'object') return null;
    const r = {};
    if (['auto', 'grid', 'target'].includes(o.force)) r.force = o.force;
    const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined);
    if (num(o.pixelSize, 1, 512) !== undefined) { r.pixelSize = o.pixelSize; r.force = 'grid'; }
    if (num(o.offsetX, -512, 512) !== undefined) r.offsetX = o.offsetX;
    if (num(o.offsetY, -512, 512) !== undefined) r.offsetY = o.offsetY;
    if (['auto', 'fixed'].includes(o.sizeMode)) r.sizeMode = o.sizeMode;
    if (num(o.targetHeight, 1, 1024) !== undefined) { r.targetHeight = Math.round(o.targetHeight); r.targetBy = 'height'; }
    if (num(o.targetWidth, 1, 1024) !== undefined) { r.targetWidth = Math.round(o.targetWidth); r.targetBy = 'height'; }
    return Object.keys(r).length ? r : null;
  }

  async function processRels(rels) {
    reloadConfig();
    const m = loadManifest();
    const items = [];
    for (const rel of rels) {
      const abs = safeResolve(SRC, rel, true);
      if (!CLI.IMG_EXT.test(abs)) throw new HttpError(400, 'pas une image : ' + rel);
      const out = safeResolve(OUT, outRelOf(rel), false); // verifie aussi les liens dans output
      if (!inside(OUT, out)) throw new HttpError(403, 'sortie refusee');
      const e = m.files[rel];
      items.push({ abs, root: SRC, rel: path.relative(SRC, abs), extra: e && e.overrides ? e.overrides : null });
    }
    items.forEach((it) => busy.add(toRel(SRC, it.abs)));
    broadcast('tree', { reason: 'processing' });
    let results;
    try {
      results = await CLI.processFiles(items, { out: OUT, inPlace: false, flags: {} }, cfg);
    } finally {
      items.forEach((it) => busy.delete(toRel(SRC, it.abs)));
    }
    const m2 = loadManifest();
    for (const r of results) {
      const rel = toRel(SRC, r.file);
      const prev = m2.files[rel] || {};
      const st = fs.statSync(r.file);
      const entry = { overrides: prev.overrides || null, srcMtime: st.mtimeMs, srcSize: st.size, srcHash: sha1(r.file), updatedAt: new Date().toISOString() };
      if (r.ok) {
        const close = Number.isFinite(r.score) && Math.abs(r.score - PC.GRID_MIN_SCORE) < 0.6;
        Object.assign(entry, { status: close ? 'review' : 'done', outRel: toRel(OUT, r.out), source: r.source, score: r.score, info: r.info, width: r.width, height: r.height, colors: r.colors, error: null });
      } else Object.assign(entry, { status: 'error', error: r.error });
      m2.files[rel] = entry;
    }
    saveManifest(m2);
    broadcast('tree', { reason: 'processed' });
    return results.map((r) => ({ rel: toRel(SRC, r.file), ok: r.ok, info: r.info, error: r.error, width: r.width, height: r.height }));
  }

  function enqueue(rels) {
    const job = queue.then(() => processRels(rels));
    queue = job.catch(() => {});
    return job;
  }

  // -------------------------------------------------------------- HTTP

  function send(res, code, body, type, extra) {
    const headers = Object.assign({
      'Content-Type': type || 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    }, extra || {});
    res.writeHead(code, headers);
    res.end(body);
  }
  const json = (res, code, obj) => send(res, code, JSON.stringify(obj));

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let over = false;
      req.on('data', (c) => {
        if (over) return; // on vide sans garder
        size += c.length;
        if (size > MAX_BODY) { over = true; chunks.length = 0; reject(new HttpError(413, 'requete trop grosse')); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (over) return;
        try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(new HttpError(400, 'JSON invalide')); }
      });
      req.on('error', reject);
    });
  }

  let allowedHosts = new Set(), allowedOrigins = new Set();
  function setPort(port) {
    allowedHosts = new Set(['127.0.0.1:' + port, 'localhost:' + port]);
    allowedOrigins = new Set(['http://127.0.0.1:' + port, 'http://localhost:' + port]);
  }

  async function handle(req, res) {
    // anti DNS rebinding / CSRF
    if (!allowedHosts.has(String(req.headers.host || '').toLowerCase())) throw new HttpError(403, 'hote refuse');
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(String(origin).toLowerCase())) throw new HttpError(403, 'origine refusee');
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;
    const site = req.headers['sec-fetch-site'];
    if (p.startsWith('/api/') && site && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'requete inter-sites refusee');

    if (req.method === 'GET' && STATIC[p]) {
      const [file, type] = STATIC[p];
      return send(res, 200, fs.readFileSync(path.join(__dirname, file)), type, type.startsWith('text/html') ? { 'Content-Security-Policy': CSP } : {});
    }
    if (req.method === 'GET') {
      if (p === '/api/info') {
        reloadConfig();
        return json(res, 200, { mode: 'server', source: SRC, output: OUT, config: cfgFile, threshold: PC.GRID_MIN_SCORE });
      }
      if (p === '/api/tree') return json(res, 200, tree());
      if (p === '/api/source' || p === '/api/output') {
        const root = p === '/api/source' ? SRC : OUT;
        const abs = safeResolve(root, url.searchParams.get('path'), true);
        const ext = (abs.match(/\.([a-z0-9]+)$/i) || [])[1];
        const type = ext && IMG_MIME[ext.toLowerCase()];
        if (!type || (root === OUT && type !== 'image/png') || !fs.statSync(abs).isFile()) throw new HttpError(400, 'type de fichier refuse');
        return send(res, 200, fs.readFileSync(abs), type);
      }
      if (p === '/api/options') {
        reloadConfig();
        const rel = url.searchParams.get('path');
        const abs = safeResolve(SRC, rel, true);
        const o = CLI.optionsFor(abs, cfg, {});
        const e = loadManifest().files[rel];
        if (e && e.overrides) Object.assign(o.core, e.overrides);
        const palette = o.palette ? await CLI.loadPalette(o.palette) : null;
        return json(res, 200, { core: o.core, palette, scale: o.scale, overrides: e && e.overrides ? e.overrides : null });
      }
      if (p === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Connection: 'keep-alive' });
        res.write('retry: 2000\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return undefined;
      }
      throw new HttpError(404, 'introuvable');
    }
    if (req.method === 'POST') {
      if (req.headers['x-unslop'] !== '1') throw new HttpError(403, 'en-tete X-Unslop manquant');
      if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) throw new HttpError(415, 'JSON attendu');
      const body = await readBody(req);
      if (p === '/api/process') {
        let rels;
        if (body.missing) rels = tree().files.filter((f) => ['missing', 'stale', 'error'].includes(f.status)).map((f) => f.rel);
        else if (Array.isArray(body.paths) && body.paths.length <= 5000) rels = body.paths.map(String);
        else throw new HttpError(400, 'paths ou missing attendu');
        rels.forEach((rel) => safeResolve(SRC, rel, true)); // validation avant toute action
        const job = enqueue(rels);
        if (body.wait) return json(res, 200, { ok: true, results: await job });
        job.catch((e) => broadcast('error', { message: e.message }));
        return json(res, 202, { ok: true, queued: rels.length });
      }
      if (p === '/api/status') {
        const rel = String(body.path || '');
        safeResolve(SRC, rel, true);
        if (!MANUAL.has(body.status)) throw new HttpError(400, 'statut invalide');
        if (!fs.existsSync(safeResolve(OUT, outRelOf(rel), false))) throw new HttpError(409, 'pas encore de sortie pour cette image');
        const m = loadManifest();
        m.files[rel] = Object.assign(m.files[rel] || {}, { status: body.status, updatedAt: new Date().toISOString() });
        saveManifest(m);
        broadcast('tree', { reason: 'status' });
        return json(res, 200, { ok: true });
      }
      if (p === '/api/overrides') {
        const rel = String(body.path || '');
        safeResolve(SRC, rel, true);
        const m = loadManifest();
        m.files[rel] = Object.assign(m.files[rel] || {}, { overrides: cleanOverrides(body.overrides) });
        saveManifest(m);
        return json(res, 200, { ok: true, overrides: m.files[rel].overrides });
      }
      throw new HttpError(404, 'introuvable');
    }
    throw new HttpError(405, 'methode refusee');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      const code = e instanceof HttpError ? e.code : 500;
      if (!(e instanceof HttpError)) console.error(e);
      if (code === 413) { res.setHeader('Connection', 'close'); res.on('finish', () => req.destroy()); }
      if (!res.headersSent) json(res, code, { ok: false, error: code === 500 ? 'erreur interne' : e.message });
      else res.end();
    });
  });

  // surveillance : l'interface est prevenue quand un fichier apparait / change
  const watchers = [];
  let timer = 0;
  const changed = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      broadcast('tree', { reason: 'fs' });
      reloadConfig();
      if (cfg.base.autoProcess) {
        const todo = tree().files.filter((f) => f.status === 'missing' || f.status === 'stale').map((f) => f.rel);
        if (todo.length) enqueue(todo).catch((e) => broadcast('error', { message: e.message }));
      }
    }, 400);
  };
  const startWatch = () => {
    for (const dir of [SRC, OUT]) {
      try {
        watchers.push(fs.watch(dir, { recursive: true }, (evt, name) => {
          if (name && (String(name).endsWith('.tmp') || String(name).endsWith(MANIFEST))) return;
          changed();
        }));
      } catch (e) { /* surveillance indisponible : l'interface peut toujours rafraichir */ }
    }
  };
  const heartbeat = setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000);

  return {
    server, SRC, OUT,
    listen(port) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          const p = server.address().port;
          setPort(p);
          startWatch();
          resolve(p);
        });
      });
    },
    close() {
      clearInterval(heartbeat);
      clearTimeout(timer);
      watchers.forEach((w) => w.close());
      for (const res of clients) res.end();
      clients.clear();
      return new Promise((r) => server.close(() => r()));
    },
    _safeResolve: safeResolve,
  };
}

async function startServer({ configFile, port }) {
  const app = createApp({ configFile });
  const p = await app.listen(port);
  console.log('Vue connectee : http://127.0.0.1:' + p + '/');
  console.log('  source : ' + app.SRC);
  console.log('  sortie : ' + app.OUT);
  console.log('Ctrl+C pour arreter.');
  return app;
}

module.exports = { createApp, startServer, safeResolve };
