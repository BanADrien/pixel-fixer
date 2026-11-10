'use strict';
// Tests sans dependance : node test/run-tests.js  (-v : detail par tirage)
// Fabrique du "faux pixel art" synthetique et des illustrations lisses,
// les fait passer par le MEME pipeline (aucun parametre de mode) et verifie.

const path = require('path');
const PC = require(path.join(__dirname, '..', 'pixelclean-core.js'));

const { mulberry32, genPalette, genSprite, render, evaluate, genSmooth } = require(path.join(__dirname, 'synth.js'));

// ------------------------------------------------------------ cas

const CASES = [
  { name: '16x16  t  x4    bil', w: 16, h: 16, K: 6, s: 4, transparent: true, mode: 'bilinear' },
  { name: '24x32  op x6    bil', w: 24, h: 32, K: 8, s: 6, transparent: false, mode: 'bilinear', opts: { background: 'keep' } },
  { name: '48x48  t  x7.5  bil', w: 48, h: 48, K: 12, s: 7.5, transparent: true, mode: 'bilinear' },
  { name: '32x32  op x10.3 bil', w: 32, h: 32, K: 10, s: 10.3, transparent: false, mode: 'bilinear', opts: { background: 'keep' } },
  { name: '16x24  t  x13.7 bil', w: 16, h: 24, K: 7, s: 13.7, transparent: true, mode: 'bilinear' },
  { name: '24x24  damier x8.3 bil', w: 24, h: 24, K: 9, s: 8.3, transparent: true, checker: true, mode: 'bilinear' },
  { name: '32x32  t  x9.2  aire', w: 32, h: 32, K: 8, s: 9.2, transparent: true, mode: 'area' },
  { name: '24x24  damier x11.6 aire', w: 24, h: 24, K: 7, s: 11.6, transparent: true, checker: true, mode: 'area' },
  { name: '40x24  op x5.4  aire', w: 40, h: 24, K: 9, s: 5.4, transparent: false, mode: 'area', opts: { background: 'keep' } },
];
const SEEDS = 5;

function runCase(c, seed, extraOpts) {
  const rng = mulberry32(seed * 7919 + c.w * 31 + c.h);
  const pal = genPalette(c.K, rng);
  const sprite = genSprite(c.w, c.h, c.K, rng, c.transparent);
  const img = render(sprite, c.w, c.h, pal, c.s, rng, c);
  const t0 = Date.now();
  const res = PC.process(img, Object.assign({ sizeMode: 'auto' }, c.opts || {}, extraOpts || {}));
  const ms = Date.now() - t0;
  const ev = evaluate(res, sprite, c.w, c.h, pal, c.s);
  ev.ms = ms; ev.detected = res.size; ev.out = res.width + 'x' + res.height;
  ev.source = res.analysis.source; ev.score = res.analysis.detection ? res.analysis.detection.score : NaN;
  ev.pass = ev.source === 'grid' && ev.sizeErr <= 0.03 && ev.dimsOk && ev.acc >= 0.95 && ev.kOut <= ev.kTrue + 3 && ev.kOut >= ev.kTrue - 1;
  return ev;
}

let failures = 0;
const verbose = process.argv.includes('-v');

function check(name, cond, detail) {
  if (!cond) failures++;
  console.log((cond ? 'OK   ' : 'ECHEC') + '  ' + name + (detail ? '  ' + detail : ''));
}

console.log('== Faux pixel art (' + SEEDS + ' tirages par cas, palette par image) ==');
const t0 = Date.now();
const slopScores = [];
for (const c of CASES) {
  let pass = 0, accSum = 0, accOpSum = 0, worst = 1, maxErr = 0;
  const lines = [];
  for (let s = 0; s < SEEDS; s++) {
    const ev = runCase(c, s + 1);
    if (ev.pass) pass++;
    slopScores.push(ev.score);
    accSum += ev.acc; accOpSum += ev.accOpaque; worst = Math.min(worst, ev.acc); maxErr = Math.max(maxErr, ev.sizeErr);
    lines.push(`    seed ${s + 1}: pixel ${ev.detected.toFixed(2)} (vrai ${c.s}) -> ${ev.out}, exact ${(ev.acc * 100).toFixed(1)}%` +
      ` (opaques ${(ev.accOpaque * 100).toFixed(1)}%), couleurs ${ev.kOut}/${ev.kTrue}, grille ${ev.source} (score ${ev.score.toFixed(2)}), ${ev.ms} ms${ev.pass ? '' : '  <-- ECHEC'}`);
  }
  check(c.name.padEnd(26), pass === SEEDS,
    `${pass}/${SEEDS}  exact moy ${(accSum / SEEDS * 100).toFixed(1)}% (opaques ${(accOpSum / SEEDS * 100).toFixed(1)}%), pire ${(worst * 100).toFixed(1)}%, err taille max ${(maxErr * 100).toFixed(2)}%`);
  if (verbose || pass < SEEDS) lines.forEach((l) => console.log(l));
}
console.log('  (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)');

// ---------------------------------------------- lot avec palette partagee
console.log('\n== Lot, palette partagee (palette maitre commune) ==');
{
  const rng = mulberry32(4242);
  const master = genPalette(14, rng);
  const specs = [[16, 16, 5.5], [24, 24, 8.3], [20, 28, 6.7], [32, 32, 4.6]];
  const imgs = [], sprites = [], pals = [];
  for (const [w, h, s] of specs) {
    // chaque sprite utilise un sous-ensemble de la palette maitre (contour commun)
    const sub = [master[0]];
    const pool = master.slice(1).map((c, i) => i).sort(() => rng() - 0.5).slice(0, 6).sort((a, b) => a - b);
    for (const i of pool) sub.push(master[i + 1]);
    const sp = genSprite(w, h, sub.length, rng, true);
    imgs.push(render(sp, w, h, sub, s, rng, { mode: 'bilinear' }));
    sprites.push({ sp, w, h, s }); pals.push(sub);
  }
  const res = PC.processBatch(imgs, { sharedPalette: true, sizeMode: 'auto' });
  const usedMaster = new Set();
  pals.forEach((p) => p.forEach((c) => usedMaster.add(c.join(','))));
  let allOk = true;
  res.forEach((r, i) => {
    const ev = evaluate(r, sprites[i].sp, sprites[i].w, sprites[i].h, pals[i], sprites[i].s);
    const ok = ev.sizeErr <= 0.03 && ev.dimsOk && ev.acc >= 0.95;
    if (!ok) allOk = false;
    console.log(`    image ${i + 1}: pixel ${r.size.toFixed(2)} (vrai ${sprites[i].s}) -> ${r.width}x${r.height}, exact ${(ev.acc * 100).toFixed(1)}%`);
  });
  const k = res[0].palette.size;
  check('palette partagee commune', allOk && res.every((r) => r.palette === res[0].palette) && k <= usedMaster.size + 3 && k >= usedMaster.size - 1,
    `${k} couleurs (vraies : ${usedMaster.size})`);
}

// ---------------------------------------------- illustrations lisses
console.log('\n== Illustrations lisses -> pixel art (meme pipeline) ==');
function comps8(set, w, h) {
  const seen = new Uint8Array(w * h);
  let n = 0;
  for (let i = 0; i < w * h; i++) {
    if (!set[i] || seen[i]) continue;
    n++;
    const st = [i]; seen[i] = 1;
    while (st.length) {
      const p = st.pop(), x = p % w, y = (p - x) / w;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const q = yy * w + xx;
        if (set[q] && !seen[q]) { seen[q] = 1; st.push(q); }
      }
    }
  }
  return n;
}
const smoothScores = [];
{
  const t1 = Date.now();
  const groups = {};
  for (const [W, H] of [[256, 256], [384, 320], [512, 512], [300, 420]]) {
    for (const seed of [1, 2, 3]) {
      for (const bg of [null, [235, 225, 200]]) {
        for (const target of [24, 32, 48]) {
          const rng = mulberry32(seed * 101 + W);
          const img = genSmooth(W, H, rng, { outline: 3 + (seed % 4), bg });
          const colors = target === 32 ? 8 : 0; // 8 couleurs imposees, sinon auto
          const r = PC.process(img, { targetHeight: target, cleanOutline: true, colors });
          const a = r.analysis, w = r.width, h = r.height, idx = r.image.indices;
          smoothScores.push(a.detection.score);
          // dimensions attendues : boite englobante vraie (couverture >= 1/2)
          let x0 = W, y0 = H, x1 = -1, y1 = -1;
          for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            if (img.cover[y * W + x] < 0.5) continue;
            x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
          }
          const expW = Math.round((x1 - x0 + 1) * target / (y1 - y0 + 1));
          // silhouette vs reduction du masque d'origine sur la meme grille
          const gx = a.grid.displayXs, gy = a.grid.displayYs;
          let inter = 0, uni = 0;
          for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
            let c = 0, n = 0;
            for (let y = Math.ceil(gy[j] - 0.5); y < Math.ceil(gy[j + 1] - 0.5); y++) {
              for (let x = Math.ceil(gx[i] - 0.5); x < Math.ceil(gx[i + 1] - 0.5); x++) { c += img.cover[y * W + x]; n++; }
            }
            const t = n > 0 && c / n >= 0.5, o = idx[j * w + i] >= 0;
            if (t && o) inter++;
            if (t || o) uni++;
          }
          const iou = uni ? inter / uni : 0;
          // contour : couche exterieure continue et de la couleur la plus sombre
          const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? -1 : idx[y * w + x];
          let dark = -1;
          for (let q = 0; q < r.palette.size; q++) if (dark < 0 || r.palette.lab[q * 3] < r.palette.lab[dark * 3]) dark = q;
          const edge = new Uint8Array(w * h), op = new Uint8Array(w * h);
          let ne = 0, nd = 0;
          for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            if (at(x, y) < 0) continue;
            op[y * w + x] = 1;
            if (at(x - 1, y) < 0 || at(x + 1, y) < 0 || at(x, y - 1) < 0 || at(x, y + 1) < 0) { edge[y * w + x] = 1; ne++; if (at(x, y) === dark) nd++; }
          }
          const used = new Set(Array.from(idx).filter((v) => v >= 0)).size;
          const maxCol = colors || 16;
          const ok = {
            classe: a.source === 'target',
            dims: h === target && w === expW,
            couleurs: used <= r.palette.size && used <= maxCol,
            contour: ne > 0 && nd / ne >= 0.95 && comps8(edge, w, h) === comps8(op, w, h),
            silhouette: iou >= 0.9,
          };
          const key = (bg ? 'fond uni   ' : 'transparent') + ' -> ' + target + ' px';
          const g = groups[key] || (groups[key] = { n: 0, pass: 0, iou: 1, fails: [] });
          g.n++; g.iou = Math.min(g.iou, iou);
          if (Object.values(ok).every(Boolean)) g.pass++;
          else g.fails.push(`${W}x${H} seed ${seed}: ${Object.keys(ok).filter((k) => !ok[k]).join(', ')} (${w}x${h}, att ${expW}x${target}, IoU ${iou.toFixed(2)}, ${used} coul.)`);
          if (verbose) console.log(`    ${key} ${W}x${H} s${seed}: ${w}x${h} IoU ${iou.toFixed(3)} coul ${used}/${r.palette.size} contour ${(nd / ne * 100).toFixed(0)}% score ${a.detection.score.toFixed(2)}`);
        }
      }
    }
  }
  for (const key of Object.keys(groups).sort()) {
    const g = groups[key];
    check(key.padEnd(26), g.pass === g.n, `${g.pass}/${g.n}  IoU silhouette min ${g.iou.toFixed(3)}`);
    g.fails.forEach((f) => console.log('    ' + f));
  }
  console.log('  (' + ((Date.now() - t1) / 1000).toFixed(1) + ' s)');
}

console.log('\n== Classification automatique (grille detectee ou taille cible) ==');
{
  const minSlop = Math.min(...slopScores), maxSmooth = Math.max(...smoothScores);
  check('faux pixel art -> grille detectee', slopScores.every((v) => v >= -1.4), `${slopScores.filter((v) => v >= -1.4).length}/${slopScores.length}, score min ${minSlop.toFixed(2)}`);
  check('illustrations lisses -> taille cible', smoothScores.every((v) => v < -1.4), `${smoothScores.filter((v) => v < -1.4).length}/${smoothScores.length}, score max ${maxSmooth.toFixed(2)} (seuil -1.40)`);
  // pixel art deja propre : natif (1:1) et agrandi au plus proche voisin
  const rng = mulberry32(5);
  const pal = genPalette(8, rng);
  const sp = genSprite(24, 24, 8, rng, true);
  const data = new Uint8ClampedArray(24 * 24 * 4);
  for (let i = 0; i < 576; i++) if (sp[i] >= 0) { data.set(pal[sp[i]], i * 4); data[i * 4 + 3] = 255; }
  const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  const r1 = PC.process({ width: 24, height: 24, data }, { sizeMode: 'auto' });
  check('pixel art natif -> rendu a l\'identique', r1.analysis.source === 'native' && same(r1.image.data, data));
  const r2 = PC.process(PC.scaleNearest({ width: 24, height: 24, data }, 4), { sizeMode: 'auto' });
  check('pixel art agrandi x4 net -> identique', r2.width === 24 && same(r2.image.data, data));
}

// ---------------------------------------------- taille finale fixe
console.log('\n== Taille finale fixe ==');
{
  const c = CASES[6];
  const rng = mulberry32(31);
  const pal = genPalette(c.K, rng);
  const sprite = genSprite(c.w, c.h, c.K, rng, true);
  const img = render(sprite, c.w, c.h, pal, c.s, rng, c);
  const r = PC.process(img, { targetHeight: 20 });
  const d = r.analysis.detection;
  check('defaut "Fixe" : hauteur imposee meme avec une grille detectee', r.height === 20 && r.analysis.sizeMode === 'fixed' && d && d.confident, r.width + 'x' + r.height + ', grille detectee ' + (d ? d.size.toFixed(2) : '-') + ' px');
  const ra = PC.process(img, { sizeMode: 'auto', targetHeight: 20 });
  check('"Auto" : taille de la grille detectee', ra.analysis.source === 'grid' && ra.height === c.h, ra.width + 'x' + ra.height);
  const sm = genSmooth(300, 420, mulberry32(77), { outline: 4, bg: null });
  const b1 = PC.process(sm, { targetHeight: 40, targetWidth: 20 });
  const b2 = PC.process(sm, { targetHeight: 16, targetWidth: 40 });
  const b3 = PC.process(sm, { targetHeight: 0, targetWidth: 18 });
  check('boite H x L : le sujet tient dedans, proportions gardees',
    b1.width === 20 && b1.height <= 40 && b2.height === 16 && b2.width <= 40 && b3.width === 18,
    b1.width + 'x' + b1.height + ' (40x20), ' + b2.width + 'x' + b2.height + ' (16x40), ' + b3.width + 'x' + b3.height + ' (L 18)');
  const pf = PC.process(img, { pixelSize: c.s, targetHeight: 20 });
  check('taille de pixel reglee : la grille prime sur la taille fixe', pf.analysis.source === 'grid' && pf.height === c.h);
}

// ---------------------------------------------- palette imposee + parsing
console.log('\n== Palettes ==');
{
  const hex = PC.parsePaletteText('FF0000\n#00ff00\n0000FF\n\n; commentaire\n');
  check('lecture .hex', hex.length === 3 && hex[1][1] === 255, JSON.stringify(hex));
  const gpl = PC.parsePaletteText('GIMP Palette\nName: test\nColumns: 4\n#\n 10  20  30\tUn\n255 255 255 Blanc\n');
  check('lecture .gpl', gpl.length === 2 && gpl[0][2] === 30 && gpl[1][0] === 255, JSON.stringify(gpl));
  const pimg = { width: 3, height: 1, data: new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255, 1, 2, 3, 255]) };
  const pp = PC.paletteFromImage(pimg);
  check('palette depuis image', pp.length === 2 && pp[1][0] === 4);

  const c = CASES[2];
  const rng = mulberry32(99);
  const pal = genPalette(c.K, rng);
  const sprite = genSprite(c.w, c.h, c.K, rng, true);
  const img = render(sprite, c.w, c.h, pal, c.s, rng, c);
  const res = PC.process(img, { palette: pal, sizeMode: 'auto' });
  const ev = evaluate(res, sprite, c.w, c.h, pal, c.s);
  const exact = res.palette.rgb.every((rgb) => pal.some((p) => p[0] === rgb[0] && p[1] === rgb[1] && p[2] === rgb[2]));
  check('palette imposee', exact && ev.acc >= 0.95, `exact ${(ev.acc * 100).toFixed(1)}%`);

  const res2 = PC.process(img, { colors: 4, sizeMode: 'auto' });
  check('nombre de couleurs force (4)', res2.palette.size === 4);
}

// ---------------------------------------------- reglages manuels
console.log('\n== Reglages manuels ==');
{
  const c = CASES[3];
  const rng = mulberry32(7);
  const pal = genPalette(c.K, rng);
  const sprite = genSprite(c.w, c.h, c.K, rng, false);
  const img = render(sprite, c.w, c.h, pal, c.s, rng, c);
  const res = PC.process(img, { pixelSize: c.s, background: 'keep' });
  const ev = evaluate(res, sprite, c.w, c.h, pal, c.s);
  check('taille de pixel manuelle', ev.dimsOk && ev.acc >= 0.95, `${res.width}x${res.height}, exact ${(ev.acc * 100).toFixed(1)}%`);
  const up = PC.scaleNearest(res.image, 4);
  check('agrandissement x4', up.width === res.width * 4 && up.data[0] === res.image.data[0]);
}

// ---------------------------------------------- embellissements
console.log('\n== Embellissements ==');

function gridFrom(rows, legend) {
  const h = rows.length, w = rows[0].length, idx = new Int16Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) idx[y * w + x] = legend[rows[y][x]];
  return { idx, w, h };
}
function components8(idx, w, h, color) {
  const seen = new Uint8Array(w * h);
  let comps = 0;
  for (let i = 0; i < w * h; i++) {
    if (idx[i] !== color || seen[i]) continue;
    comps++;
    const st = [i]; seen[i] = 1;
    while (st.length) {
      const p = st.pop(), x = p % w, y = (p - x) / w;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const q = yy * w + xx;
        if (!seen[q] && idx[q] === color) { seen[q] = 1; st.push(q); }
      }
    }
  }
  return comps;
}
function lCorners(idx, w, h, color) {
  let n = 0;
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? -9 : idx[y * w + x];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (at(x, y) !== color) continue;
    const L = at(x - 1, y) === color, R = at(x + 1, y) === color, U = at(x, y - 1) === color, D = at(x, y + 1) === color;
    if ((L !== R) && (U !== D)) {
      const hx = L ? -1 : 1, vy = U ? -1 : 1;
      if (at(x + hx, y + vy) !== color) n++;
    }
  }
  return n;
}
const PAL = PC.makePalette([[20, 20, 30], [200, 60, 60], [240, 220, 180], [90, 140, 60]]);
// 0 = trait sombre, 1 = rouge, 2 = clair, 3 = vert ; '.' = transparent
{
  // trait sombre en escalier avec doublons, sur fond clair
  const g = gridFrom([
    '2222222222',
    '2000222222',
    '2220022222',
    '2222002222',
    '2222200022',
    '2222222022',
    '2222222002',
    '2222222222',
  ], { '0': 0, '2': 2, '.': -1 });
  const before = lCorners(g.idx, g.w, g.h, 0);
  const out = PC.pixelPerfect(g.idx, g.w, g.h, PAL);
  const after = lCorners(out, g.w, g.h, 0);
  const comps = components8(out, g.w, g.h, 0);
  let removed = 0;
  for (let i = 0; i < out.length; i++) if (g.idx[i] === 0 && out[i] !== 0) removed++;
  check('pixel-perfect : doublons en escalier retires', before > 0 && after === 0 && removed > 0, `coins ${before} -> ${after}, ${removed} retires`);
  check('pixel-perfect : trait toujours connexe', comps === 1);
  let filled = true;
  for (let i = 0; i < out.length; i++) if (g.idx[i] === 0 && out[i] !== 0 && out[i] !== 2) filled = false;
  check('pixel-perfect : pixel retire -> couleur voisine', filled);
}
{
  // bloc plein (pas un trait) : rien ne doit bouger
  const g = gridFrom(['....', '.00.', '.00.', '....'], { '0': 0, '.': -1 });
  const out = PC.pixelPerfect(g.idx, g.w, g.h, PAL);
  check('pixel-perfect : bloc 2x2 intact', out.every((v, i) => v === g.idx[i]));
}
{
  // contour epais (2 px) et troue (pixel rouge touchant la transparence)
  const g = gridFrom([
    '..........',
    '.00000000.',
    '.00000000.',
    '.00111100.',
    '.0011111..',
    '.00111100.',
    '.00000000.',
    '.00000000.',
    '..........',
  ], { '0': 0, '1': 1, '.': -1 });
  const out = PC.cleanOutline(g.idx, g.w, g.h, PAL, 'darkest');
  const at = (x, y) => (x < 0 || y < 0 || x >= g.w || y >= g.h) ? -1 : out[y * g.w + x];
  let edgeOk = true, innerOk = true, nEdge = 0;
  for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
    const v = at(x, y);
    if (v < 0) continue;
    const edge = at(x - 1, y) < 0 || at(x + 1, y) < 0 || at(x, y - 1) < 0 || at(x, y + 1) < 0;
    if (edge) { nEdge++; if (v !== 0) edgeOk = false; } else if (v === 0) innerOk = false;
  }
  check('contour propre : bord exterieur uniforme et sans trou', edgeOk && nEdge > 0);
  check('contour propre : epaisseur ramenee a 1 px', innerOk);
  check('contour propre : contour continu (connexite 8)', components8(out, g.w, g.h, 0) === 1);
  check('contour propre : silhouette inchangee', out.every((v, i) => (v < 0) === (g.idx[i] < 0)));
}
{
  // detail fin d'1 pixel de large (bras) : couleur conservee
  const g = gridFrom([
    '.........',
    '.000.....',
    '.0110....',
    '.01111333',
    '.0110....',
    '.000.....',
    '.........',
  ], { '0': 0, '1': 1, '3': 3, '.': -1 });
  const out = PC.cleanOutline(g.idx, g.w, g.h, PAL, 'darkest');
  const arm = [6, 7, 8].map((x) => out[3 * g.w + x]);
  check('contour propre : bras d\'1 px conserve', arm.every((v) => v === 3), JSON.stringify(arm));
  const out2 = PC.cleanOutline(g.idx, g.w, g.h, PAL, 'selective');
  const e = out2[1 * g.w + 1];
  check('contour selectif : couleur plus sombre de la palette', e >= 0 && PAL.lab[e * 3] < PAL.lab[1 * 3]);
}

console.log('\n' + (failures ? failures + ' test(s) en echec' : 'Tous les tests passent'));
process.exitCode = failures ? 1 : 0;
