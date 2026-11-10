'use strict';
// Tests du serveur local (API, statuts, securite) : node test/server-test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { createApp } = require(path.join(__dirname, '..', 'server.js'));
const { writePng, readImage } = require(path.join(__dirname, '..', 'cli.js'));
const S = require(path.join(__dirname, 'synth.js'));

let failures = 0;
function check(name, cond, detail) {
  if (!cond) failures++;
  console.log((cond ? 'OK   ' : 'ECHEC') + '  ' + name + (detail ? '  ' + detail : ''));
}

function slop(seed) {
  const rng = S.mulberry32(seed);
  const pal = S.genPalette(8, rng);
  const sp = S.genSprite(20, 24, 8, rng, true);
  return S.render(sp, 20, 24, pal, 7.3, rng, { mode: 'area' });
}

function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) { out[path.relative(dir, p)] = 'lien'; continue; }
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return JSON.stringify(out);
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unslop-srv-'));
  const proj = path.join(tmp, 'jeu');
  const raw = path.join(proj, 'raw');
  let app;
  try {
    await writePng(slop(21), path.join(raw, 'a.png'));
    await writePng(slop(22), path.join(raw, 'chars', 'c.png'));
    await writePng(S.genSmooth(240, 280, S.mulberry32(23), { outline: 4, bg: null }), path.join(raw, 'chars', 'b.png'));
    fs.writeFileSync(path.join(proj, 'secret.txt'), 'secret');
    fs.mkdirSync(path.join(tmp, 'dehors'));
    await writePng(slop(24), path.join(tmp, 'dehors', 'x.png'));
    fs.writeFileSync(path.join(proj, 'unslop.config.json'), JSON.stringify({ source: 'raw', output: 'sprites', height: 32 }));

    // config refusee si la sortie est dans la source
    fs.writeFileSync(path.join(proj, 'bad.config.json'), JSON.stringify({ source: 'raw', output: 'raw/out' }));
    let refused = false;
    try { createApp({ configFile: path.join(proj, 'bad.config.json') }); } catch (e) { refused = true; }
    check('config : sortie dans la source refusee', refused);

    app = createApp({ configFile: path.join(proj, 'unslop.config.json') });
    const port = await app.listen(0);
    check('ecoute uniquement sur 127.0.0.1', app.server.address().address === '127.0.0.1');

    const req = (method, p, { headers = {}, body, raw: rawBody } = {}) => new Promise((resolve, reject) => {
      const data = rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : null;
      const h = Object.assign({ Host: '127.0.0.1:' + port }, headers);
      if (data !== null) h['Content-Length'] = Buffer.byteLength(data);
      const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          let j = null;
          try { j = JSON.parse(buf.toString('utf8')); } catch (e) { /* binaire */ }
          resolve({ status: res.statusCode, headers: res.headers, buf, json: j });
        });
      });
      r.on('error', reject);
      if (data !== null) r.write(data);
      r.end();
    });
    const post = (p, body, extra) => req('POST', p, { body, headers: Object.assign({ 'Content-Type': 'application/json', 'X-Unslop': '1', Origin: 'http://127.0.0.1:' + port }, extra || {}) });
    const statusOf = async (rel) => (await req('GET', '/api/tree')).json.files.find((f) => f.rel === rel);

    // ---------------------------------------------------------------- API
    const t0 = await req('GET', '/api/tree');
    check('liste : 3 images, toutes "manquant"', t0.status === 200 && t0.json.files.length === 3 && t0.json.files.every((f) => f.status === 'missing'));
    const page = await req('GET', '/');
    check('page servie avec CSP', page.status === 200 && /default-src 'self'/.test(page.headers['content-security-policy'] || ''));
    const snap0 = snapshot(raw);

    const p1 = await post('/api/process', { paths: ['a.png'], wait: true });
    check('traitement d\'une image', p1.status === 200 && p1.json.results[0].ok && fs.existsSync(path.join(proj, 'sprites', 'a.png')));
    const sa = await statusOf('a.png');
    check('statut apres traitement : fait', sa.status === 'done' || sa.status === 'review', sa.status);
    const p2 = await post('/api/process', { missing: true, wait: true });
    const t2 = await req('GET', '/api/tree');
    check('traiter les manquants', p2.status === 200 && p2.json.results.length === 2 && t2.json.files.every((f) => f.status !== 'missing'), p2.json.results.map((r) => r.rel).join(', '));
    check('arborescence miroir dans la sortie', fs.existsSync(path.join(proj, 'sprites', 'chars', 'b.png')));
    check('manifeste des statuts ecrit', fs.existsSync(path.join(proj, 'sprites', '.unslop-status.json')));
    const img = await req('GET', '/api/output?path=chars/b.png');
    check('lecture d\'une sortie', img.status === 200 && img.headers['content-type'] === 'image/png');
    const src = await req('GET', '/api/source?path=chars/c.png');
    check('lecture d\'une source', src.status === 200 && src.headers['content-type'] === 'image/png');

    const v = await post('/api/status', { path: 'chars/c.png', status: 'validated' });
    check('valider une image', v.status === 200 && (await statusOf('chars/c.png')).status === 'validated');
    const rv = await post('/api/status', { path: 'chars/c.png', status: 'review' });
    check('marquer a revoir', rv.status === 200 && (await statusOf('chars/c.png')).status === 'review');

    const ov = await post('/api/overrides', { path: 'chars/b.png', overrides: { targetHeight: 24, evil: '../x' } });
    await post('/api/process', { paths: ['chars/b.png'], wait: true });
    const b2 = await readImage(path.join(proj, 'sprites', 'chars', 'b.png'));
    check('correction par image (hauteur 24) memorisee et appliquee', ov.status === 200 && !('evil' in ov.json.overrides) && b2.height === 24, b2.width + 'x' + b2.height);
    const opt = await req('GET', '/api/options?path=chars/b.png');
    check('options effectives exposees', opt.status === 200 && opt.json.core.targetHeight === 24);

    // source modifiee apres la sortie -> obsolete
    await new Promise((r) => setTimeout(r, 20));
    await writePng(slop(99), path.join(raw, 'a.png'));
    check('source modifiee -> "obsolete"', (await statusOf('a.png')).status === 'stale');
    const snap1 = snapshot(raw);
    await post('/api/process', { missing: true, wait: true });
    check('retraitement de l\'obsolete', (await statusOf('a.png')).status !== 'stale');

    // --------------------------------------------------------- securite
    const bad = ['../secret.txt', '..%2Fsecret.txt', '%2E%2E/secret.txt', 'chars/../../secret.txt', 'C:/Windows/win.ini',
      '/etc/passwd', '%2Fetc%2Fpasswd', 'chars\\..\\..\\secret.txt', 'a.png%00.txt', 'a.png:flux', '..'];
    const codes = [];
    for (const b of bad) codes.push((await req('GET', '/api/source?path=' + b)).status);
    check('chemins hors dossier / absolus refuses', codes.every((c) => c === 400 || c === 403), codes.join(','));
    const leak = [];
    for (const b of bad) { const r = await req('GET', '/api/output?path=' + b); if (r.buf.toString().includes('secret')) leak.push(b); }
    check('aucune fuite de fichier hors dossiers', leak.length === 0, leak.join(' '));
    check('fichier non image refuse', (await req('GET', '/api/source?path=../unslop.config.json')).status >= 400);
    check('fichiers du serveur non servis', (await req('GET', '/server.js')).status === 404 && (await req('GET', '/../unslop.config.json')).status === 404);

    check('Host etranger refuse (DNS rebinding)', (await req('GET', '/api/tree', { headers: { Host: 'evil.example:' + port } })).status === 403);
    check('Origin etranger refuse (GET)', (await req('GET', '/api/tree', { headers: { Origin: 'http://evil.example' } })).status === 403);
    check('Origin etranger refuse (POST)', (await post('/api/process', { missing: true }, { Origin: 'http://evil.example' })).status === 403);
    check('requete inter-sites refusee', (await req('GET', '/api/tree', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status === 403);
    const noHdr = await req('POST', '/api/process', { body: { missing: true }, headers: { 'Content-Type': 'application/json' } });
    check('ecriture sans en-tete X-Unslop refusee', noHdr.status === 403);
    const form = await req('POST', '/api/process', { raw: 'missing=1', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Unslop': '1' } });
    check('corps non JSON refuse', form.status === 415);
    const big = await post('/api/overrides', { path: 'a.png', pad: 'x'.repeat(70000) });
    check('corps trop gros refuse (413)', big.status === 413);
    check('methodes PUT / DELETE refusees', (await req('PUT', '/api/output?path=a.png')).status === 405 && (await req('DELETE', '/api/source?path=a.png')).status === 405);
    check('traitement d\'un chemin hors source refuse', (await post('/api/process', { paths: ['../secret.txt'], wait: true })).status === 400);
    check('statut sur chemin hors source refuse', (await post('/api/status', { path: '../../x.png', status: 'validated' })).status === 400);

    // liens symboliques / jonctions vers l'exterieur
    let linkOk = false;
    try { fs.symlinkSync(path.join(tmp, 'dehors'), path.join(raw, 'lien'), 'junction'); linkOk = true; } catch (e) { /* non supporte */ }
    if (linkOk) {
      const r1 = await req('GET', '/api/source?path=lien/x.png');
      const listed = (await req('GET', '/api/tree')).json.files.some((f) => f.rel.startsWith('lien/'));
      const r2 = await post('/api/process', { paths: ['lien/x.png'], wait: true });
      check('lien vers l\'exterieur : lecture refusee, non liste, non traite', r1.status === 403 && !listed && r2.status === 403, r1.status + ' ' + r2.status);
      fs.mkdirSync(path.join(raw, 'jt'));
      fs.copyFileSync(path.join(raw, 'chars', 'c.png'), path.join(raw, 'jt', 'z.png'));
      fs.mkdirSync(path.join(raw, 'cible'));
      fs.symlinkSync(path.join(raw, 'cible'), path.join(proj, 'sprites', 'jt'), 'junction');
      const r3 = await post('/api/process', { paths: ['jt/z.png'], wait: true });
      check('sortie redirigee par un lien vers la source : refusee', r3.status === 403 && fs.readdirSync(path.join(raw, 'cible')).length === 0, String(r3.status));
      // retire le lien lui-meme (jamais de suppression recursive qui le suivrait)
      const unlink = (l) => { try { fs.unlinkSync(l); } catch (e) { fs.rmdirSync(l); } };
      unlink(path.join(raw, 'lien'));
      unlink(path.join(proj, 'sprites', 'jt'));
      fs.rmSync(path.join(raw, 'jt'), { recursive: true, force: true });
      fs.rmSync(path.join(raw, 'cible'), { recursive: true, force: true });
    } else console.log('(liens symboliques non disponibles : test ignore)');

    const ev = await new Promise((resolve) => {
      const r = http.get({ host: '127.0.0.1', port, path: '/api/events', headers: { Host: '127.0.0.1:' + port } }, (res) => { resolve(res.headers['content-type']); res.destroy(); });
      r.on('error', () => resolve(''));
    });
    check('notifications en direct (SSE)', /text\/event-stream/.test(ev));

    check('source jamais modifiee par le serveur', snapshot(raw) === snap1 && Object.keys(JSON.parse(snap0)).length === 3);
  } finally {
    if (app) await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log('\n' + (failures ? failures + ' test(s) en echec' : 'Tous les tests serveur passent'));
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
