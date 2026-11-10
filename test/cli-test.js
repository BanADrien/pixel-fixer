'use strict';
// Test de la ligne de commande : node test/cli-test.js
// Ecrit des images synthetiques en PNG, lance cli.js, et verifie que la
// sortie est identique pixel pour pixel au resultat de pixelclean-core.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const PC = require(path.join(__dirname, '..', 'pixelclean-core.js'));
const CLI = path.join(__dirname, '..', 'cli.js');
const { readImage, writePng, collect } = require(CLI);
const S = require(path.join(__dirname, 'synth.js'));

let failures = 0;
function check(name, cond, detail) {
  if (!cond) failures++;
  console.log((cond ? 'OK   ' : 'ECHEC') + '  ' + name + (detail ? '  ' + detail : ''));
}
const run = (args, cwd) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
const same = (a, b) => a.width === b.width && a.height === b.height && Buffer.compare(Buffer.from(a.data), Buffer.from(b.data)) === 0;
const hashFile = (f) => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');

function slop(seed, transparent, checker) {
  const rng = S.mulberry32(seed);
  const pal = S.genPalette(8, rng);
  const sp = S.genSprite(20, 24, 8, rng, transparent);
  return S.render(sp, 20, 24, pal, 7.3, rng, { mode: 'area', checker });
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unslop-cli-'));
  try {
    const src = path.join(tmp, 'src');
    await writePng(slop(11, true, false), path.join(src, 'a.png'));
    await writePng(slop(12, true, true), path.join(src, 'b.png'));
    await writePng(S.genSmooth(260, 300, S.mulberry32(13), { outline: 4, bg: null }), path.join(src, 'sub', 'c.png'));
    await writePng(slop(14, false, false), path.join(src, 'sub', 'd.png'));

    // 1) dossier complet -> meme resultat que processBatch (palette commune)
    const out = path.join(tmp, 'out');
    const r1 = run([src, '--out', out, '--json'], tmp);
    const j1 = JSON.parse(r1.stdout);
    check('dossier : code de sortie 0', r1.status === 0, r1.stderr.trim());
    const items = collect([src], out);
    const imgs = [];
    for (const it of items) imgs.push(await readImage(it.abs));
    const ref = PC.processBatch(imgs, {});
    let identical = 0;
    for (let i = 0; i < items.length; i++) {
      const o = await readImage(path.join(out, items[i].rel.replace(/\.[^.]+$/, '.png')));
      if (same(o, ref[i].image)) identical++;
    }
    check('dossier : sorties identiques au coeur (pixel pour pixel)', identical === items.length, identical + '/' + items.length);
    check('dossier : arborescence conservee', fs.existsSync(path.join(out, 'sub', 'c.png')) && j1.results.length === 4);
    check('dossier : sources intactes', fs.readdirSync(src).sort().join(',') === 'a.png,b.png,sub');

    // 2) fichier seul + options -> identique a process() avec les memes options
    const out2 = path.join(tmp, 'out2');
    const r2 = run([path.join(src, 'sub', 'c.png'), '--out', out2, '--height', '24', '--colors', '8', '--outline', 'darkest', '--pixel-perfect', '--scale', '4'], tmp);
    const c2 = await readImage(path.join(out2, 'c.png'));
    const ref2 = PC.process(await readImage(path.join(src, 'sub', 'c.png')), { targetHeight: 24, colors: 8, cleanOutline: true, outlineMode: 'darkest', pixelPerfect: true });
    check('fichier + options : identique au coeur', r2.status === 0 && same(c2, ref2.image), c2.width + 'x' + c2.height);
    const x4 = await readImage(path.join(out2, 'x4', 'c.png'));
    check('agrandissement x4 ecrit', x4.width === c2.width * 4 && x4.height === c2.height * 4);
    check('ligne de console courte', /c\.png\s+taille fixe -> \d+x24, \d+ couleurs/.test(r2.stdout), r2.stdout.trim());

    // 2b) --width et --height auto
    const outW = path.join(tmp, 'outW');
    const rw = run([path.join(src, 'sub', 'c.png'), '--out', outW, '--height', '40', '--width', '16', '--json'], tmp);
    const jw = JSON.parse(rw.stdout).results[0];
    check('--width : le sujet tient dans 40 x 16', rw.status === 0 && jw.width === 16 && jw.height <= 40, jw.width + 'x' + jw.height);
    const ra = run([path.join(src, 'a.png'), '--out', path.join(tmp, 'outA'), '--height', 'auto', '--json'], tmp);
    const ja = JSON.parse(ra.stdout).results[0];
    const refA = PC.process(await readImage(path.join(src, 'a.png')), { sizeMode: 'auto' });
    check('--height auto : grille detectee, identique au coeur', ra.status === 0 && ja.source === 'grid' && same(await readImage(ja.out), refA.image), ja.info + ' -> ' + ja.width + 'x' + ja.height);

    // 3) config : regles par sous-dossier (hauteur 24 pour sub/**)
    fs.writeFileSync(path.join(tmp, 'unslop.config.json'), JSON.stringify({ height: 40, rules: [{ match: 'sub/**', height: 24, width: 18, outline: 'darkest' }, { match: 'a.png', height: 'auto' }] }));
    const out3 = path.join(tmp, 'out3');
    const r3 = run(['src', '--out', out3, '--json'], tmp);
    const j3 = JSON.parse(r3.stdout);
    const c3 = j3.results.find((r) => r.file.endsWith('c.png'));
    const a3 = j3.results.find((r) => r.file.endsWith('a.png'));
    check('config : regles par dossier (hauteur, largeur, auto)', r3.status === 0 && c3 && c3.height <= 24 && c3.width <= 18 && (c3.height === 24 || c3.width === 18) && a3.source === 'grid', c3 && c3.width + 'x' + c3.height + ', a.png ' + a3.info);
    fs.unlinkSync(path.join(tmp, 'unslop.config.json'));

    // 4) sur place : copie de l'original dans _originals/, jpg remplace par png
    const ip = path.join(tmp, 'inplace');
    fs.mkdirSync(ip);
    fs.copyFileSync(path.join(src, 'a.png'), path.join(ip, 'a.png'));
    const raw = slop(15, false, false);
    await require('sharp')(Buffer.from(raw.data), { raw: { width: raw.width, height: raw.height, channels: 4 } }).jpeg({ quality: 92 }).toFile(path.join(ip, 'e.jpg'));
    const hA = hashFile(path.join(ip, 'a.png')), hE = hashFile(path.join(ip, 'e.jpg'));
    const r4 = run([ip, '--in-place'], tmp);
    check('sur place : code 0', r4.status === 0, r4.stderr.trim());
    check('sur place : originaux gardes dans _originals/', hashFile(path.join(ip, '_originals', 'a.png')) === hA && hashFile(path.join(ip, '_originals', 'e.jpg')) === hE);
    check('sur place : fichiers remplaces (jpg -> png)', hashFile(path.join(ip, 'a.png')) !== hA && fs.existsSync(path.join(ip, 'e.png')) && !fs.existsSync(path.join(ip, 'e.jpg')));
    run([ip, '--in-place'], tmp);
    check('sur place relance : l\'original n\'est pas ecrase', hashFile(path.join(ip, '_originals', 'a.png')) === hA);

    // 5) make-palette
    const palFile = path.join(tmp, 'palette.hex');
    const r5 = run(['make-palette', src, '--colors', '12', '--out', palFile], tmp);
    const pal = PC.parsePaletteText(fs.readFileSync(palFile, 'utf8'));
    check('make-palette : palette ecrite', r5.status === 0 && pal.length > 0 && pal.length <= 12, pal.length + ' couleurs');
    const out6 = path.join(tmp, 'out6');
    const r6 = run([src, '--out', out6, '--palette', palFile, '--json'], tmp);
    const used = new Set();
    for (const it of items) {
      const o = await readImage(path.join(out6, it.rel.replace(/\.[^.]+$/, '.png')));
      for (let i = 0; i < o.width * o.height; i++) if (o.data[i * 4 + 3]) used.add(o.data[i * 4] + ',' + o.data[i * 4 + 1] + ',' + o.data[i * 4 + 2]);
    }
    const palSet = new Set(pal.map((c) => c.join(',')));
    check('palette du projet respectee', r6.status === 0 && [...used].every((c) => palSet.has(c)), used.size + ' couleurs utilisees');

    // 7) erreurs : fichier illisible -> code 1 ; option inconnue -> code 2
    const bad = path.join(tmp, 'bad');
    fs.mkdirSync(bad);
    fs.writeFileSync(path.join(bad, 'casse.png'), 'pas une image');
    fs.copyFileSync(path.join(src, 'a.png'), path.join(bad, 'ok.png'));
    const r7 = run([bad, '--out', path.join(tmp, 'out7'), '--json'], tmp);
    const j7 = JSON.parse(r7.stdout);
    check('image illisible : code de sortie 1, les autres traitees', r7.status === 1 && j7.results.filter((r) => r.ok).length === 1);
    check('option inconnue : code de sortie 2', run(['--nimporte'], tmp).status === 2);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log('\n' + (failures ? failures + ' test(s) en echec' : 'Tous les tests CLI passent'));
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
