#!/usr/bin/env node
'use strict';
/*
 * Ligne de commande : meme algorithme que la page (pixelclean-core.js).
 *   node cli.js <fichier|dossier>... [options]
 *   node cli.js make-palette <dossier|fichiers>... --colors 24 --out palette.hex
 */
const fs = require('fs');
const path = require('path');
const PC = require('./pixelclean-core.js');

let sharp;
try { sharp = require('sharp'); } catch (e) {
  console.error('Dependance manquante : lancez "npm install" dans ' + __dirname);
  process.exit(2);
}

const IMG_EXT = /\.(png|jpe?g|webp|gif)$/i;
const IGNORED_DIRS = new Set(['_originals', '_upscaled', 'node_modules', '.git']);
const CONFIG_NAME = 'unslop.config.json';

const HELP = `Usage :
  node cli.js <fichier|dossier>... [options]
  node cli.js make-palette <dossier|fichiers>... [--colors 24] [--out palette.hex]
  node cli.js serve [--config <fichier>] [--port 4870]   vue web connectee au dossier assets

Options :
  --out <dossier>          dossier de sortie (defaut : sous-dossier "pixel-clean" a cote des sources)
  --in-place               remplace les fichiers (copie de l'original dans _originals/)
  --height <px>|auto       taille finale : hauteur du sujet en px pour toutes les images (defaut 32) ;
                           auto = grille detectee si trouvee, sinon 32 px
  --width <px>             largeur maxi (le sujet tient dans hauteur x largeur, proportions gardees)
  --factor <n>             ou : facteur de reduction (au lieu de --height)
  --colors <n>             nombre de couleurs (defaut : auto)
  --palette <fichier>      palette imposee (.hex, .gpl ou .png)
  --per-image-palette      une palette par image (defaut : palette commune au lot)
  --outline darkest|selective|none   contour propre
  --pixel-perfect          lignes pixel-perfect
  --scale <n>              ecrit aussi une version agrandie xN (sous-dossier xN/)
  --grid auto|grid|target  forcer la grille detectee ou la taille cible (defaut auto)
  --pixel-size <px>        taille de pixel imposee (force la grille)
  --background auto|keep   fond rendu transparent ou garde (defaut auto)
  --no-cleanup             ne pas nettoyer les pixels isoles
  --config <fichier>       fichier de config (defaut : ${CONFIG_NAME} du dossier courant ou parent)
  --watch [dossier]        surveille le dossier et traite chaque nouvelle image
  --json                   resume JSON sur la sortie standard
Code de sortie : 0 si tout est traite, 1 si au moins une image echoue, 2 si erreur d'usage.`;

// ------------------------------------------------------------ arguments

function parseArgs(argv) {
  const a = { cmd: 'run', inputs: [], flags: {} };
  const need = (i, name) => {
    if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error('valeur manquante pour ' + name);
    return argv[i + 1];
  };
  const numeric = (v, name) => {
    const n = Number(String(v).replace(',', '.'));
    if (!Number.isFinite(n) || n <= 0) throw new Error('nombre invalide pour ' + name + ' : ' + v);
    return n;
  };
  let i = 0;
  if (argv[0] === 'make-palette') { a.cmd = 'make-palette'; i = 1; }
  else if (argv[0] === 'serve') { a.cmd = 'serve'; i = 1; }
  for (; i < argv.length; i++) {
    const t = argv[i];
    switch (t) {
      case '-h': case '--help': a.cmd = 'help'; break;
      case '--out': a.out = need(i, t); i++; break;
      case '--in-place': a.inPlace = true; break;
      case '--height': { const v = need(i, t); i++; a.flags.height = v === 'auto' ? 'auto' : numeric(v, t); break; }
      case '--width': a.flags.width = Math.round(numeric(need(i, t), t)); i++; break;
      case '--factor': a.flags.factor = numeric(need(i, t), t); i++; break;
      case '--colors': a.flags.colors = Math.round(numeric(need(i, t), t)); i++; break;
      case '--palette': a.flags.palette = path.resolve(need(i, t)); i++; break;
      case '--per-image-palette': a.flags.sharedPalette = false; break;
      case '--outline': {
        const v = need(i, t); i++;
        if (!['darkest', 'selective', 'none'].includes(v)) throw new Error('--outline : darkest, selective ou none');
        a.flags.outline = v === 'none' ? false : v;
        break;
      }
      case '--pixel-perfect': a.flags.pixelPerfect = true; break;
      case '--scale': a.flags.scale = Math.round(numeric(need(i, t), t)); i++; break;
      case '--grid': {
        const v = need(i, t); i++;
        if (!['auto', 'grid', 'target'].includes(v)) throw new Error('--grid : auto, grid ou target');
        a.flags.grid = v;
        break;
      }
      case '--pixel-size': a.flags.pixelSize = numeric(need(i, t), t); i++; break;
      case '--background': {
        const v = need(i, t); i++;
        if (!['auto', 'keep'].includes(v)) throw new Error('--background : auto ou keep');
        a.flags.background = v;
        break;
      }
      case '--no-cleanup': a.flags.cleanup = false; break;
      case '--config': a.config = path.resolve(need(i, t)); i++; break;
      case '--watch':
        a.watch = true;
        if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) { a.inputs.push(argv[i + 1]); i++; }
        break;
      case '--json': a.json = true; break;
      case '--port': a.port = Math.round(numeric(need(i, t), t)); i++; break;
      default:
        if (t.startsWith('--')) throw new Error('option inconnue : ' + t);
        a.inputs.push(t);
    }
  }
  return a;
}

// ------------------------------------------------------------ config

function findConfig(start) {
  let dir = path.resolve(start);
  for (;;) {
    const f = path.join(dir, CONFIG_NAME);
    if (fs.existsSync(f)) return f;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function loadConfig(file) {
  if (!file) return { dir: process.cwd(), base: {}, rules: [] };
  let json;
  try { json = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error('config illisible (' + file + ') : ' + e.message); }
  const dir = path.dirname(file);
  const fix = (o) => {
    const r = Object.assign({}, o);
    if (typeof r.palette === 'string') r.palette = path.resolve(dir, r.palette);
    delete r.match; delete r.rules;
    return r;
  };
  const rules = (json.rules || []).map((r) => ({ re: globToRegex(String(r.match || '**')), opts: fix(r) }));
  return { file, dir, base: fix(json), rules };
}

// "characters/**" correspond a n'importe quel niveau (comme .gitignore),
// "/assets/ui/*" seulement depuis le dossier de la config.
function globToRegex(glob) {
  let g = glob.replace(/\\/g, '/');
  const anchored = g.startsWith('/');
  if (anchored) g = g.slice(1);
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') { re += '.*'; i++; if (g[i + 1] === '/') i++; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp((anchored ? '^' : '(^|/)') + re + '$', 'i');
}

// options du core pour un fichier : config < regles < options de la ligne de commande
function optionsFor(absFile, cfg, flags) {
  const rel = path.relative(cfg.dir, absFile).split(path.sep).join('/');
  const merged = Object.assign({}, cfg.base);
  for (const r of cfg.rules) if (r.re.test(rel)) Object.assign(merged, r.opts);
  Object.assign(merged, flags);
  const o = {};
  if (merged.factor) { o.targetBy = 'factor'; o.targetFactor = merged.factor; o.sizeMode = 'fixed'; }
  if (merged.height === 'auto') o.sizeMode = 'auto';
  else if (merged.height) { o.targetBy = 'height'; o.targetHeight = Number(merged.height); o.sizeMode = 'fixed'; }
  if (merged.width) { o.targetWidth = Number(merged.width); o.targetBy = 'height'; if (merged.height !== 'auto') o.sizeMode = 'fixed'; }
  if (merged.colors !== undefined) o.colors = merged.colors;
  if (merged.sharedPalette !== undefined) o.sharedPalette = merged.sharedPalette;
  if (merged.outline !== undefined) {
    o.cleanOutline = !!merged.outline && merged.outline !== 'none';
    if (o.cleanOutline) o.outlineMode = merged.outline === 'selective' ? 'selective' : 'darkest';
  }
  if (merged.pixelPerfect !== undefined) o.pixelPerfect = !!merged.pixelPerfect;
  if (merged.grid) o.force = merged.grid;
  if (merged.pixelSize) { o.pixelSize = merged.pixelSize; o.force = 'grid'; }
  if (merged.background) o.background = merged.background;
  if (merged.cleanup !== undefined) o.cleanup = !!merged.cleanup;
  if (merged.bgTolerance !== undefined) o.bgTolerance = merged.bgTolerance;
  if (merged.alphaThreshold !== undefined) o.alphaThreshold = merged.alphaThreshold;
  return { core: o, palette: merged.palette || null, scale: merged.scale || 0 };
}

// ------------------------------------------------------------ images

async function readImage(file) {
  const { data, info } = await sharp(file, { pages: 1 })
    .rotate()
    .toColourspace('srgb')
    .ensureAlpha()
    .raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 4) throw new Error('format de pixels inattendu');
  return { width: info.width, height: info.height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length) };
}

async function writePng(img, file) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const buf = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length);
  await sharp(buf, { raw: { width: img.width, height: img.height, channels: 4 } }).png({ compressionLevel: 9 }).toFile(file);
}

const paletteCache = new Map();
async function loadPalette(file) {
  if (!file) return null;
  if (paletteCache.has(file)) return paletteCache.get(file);
  let pal;
  if (/\.png$/i.test(file)) pal = PC.paletteFromImage(await readImage(file));
  else pal = PC.parsePaletteText(fs.readFileSync(file, 'utf8'));
  if (!pal.length) throw new Error('palette vide ou illisible : ' + file);
  paletteCache.set(file, pal);
  return pal;
}

function walk(dir, skip, out) {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (IGNORED_DIRS.has(e.name) || e.name.startsWith('.') || skip.has(path.resolve(p))) continue;
      walk(p, skip, out);
    } else if (IMG_EXT.test(e.name)) out.push(p);
  }
}

// liste {abs, root, rel} ; root = dossier de reference pour l'arborescence
function collect(inputs, outDir) {
  const list = [];
  for (const inp of inputs) {
    const abs = path.resolve(inp);
    if (!fs.existsSync(abs)) throw new Error('introuvable : ' + inp);
    if (fs.statSync(abs).isDirectory()) {
      const skip = new Set([path.resolve(outDir || path.join(abs, 'pixel-clean'))]);
      const files = [];
      walk(abs, skip, files);
      for (const f of files) list.push({ abs: f, root: abs, rel: path.relative(abs, f) });
    } else if (IMG_EXT.test(abs)) list.push({ abs, root: path.dirname(abs), rel: path.basename(abs) });
    else throw new Error('format non pris en charge : ' + inp);
  }
  return list;
}

// ------------------------------------------------------------ traitement

function describe(res) {
  const a = res.analysis, d = a.detection;
  if (a.source === 'grid') return 'grille ' + a.grid.size.toFixed(1) + ' px';
  if (a.source === 'native') return 'deja en pixel art';
  if (a.sizeMode === 'fixed') return 'taille fixe' + (d && d.confident ? ' (grille ' + d.size.toFixed(1) + ' px detectee)' : '');
  return 'pas de grille, converti';
}

function countUsed(res) {
  const s = new Set();
  for (const v of res.image.indices) if (v >= 0) s.add(v);
  return s.size;
}

function targetsFor(item, args, scale, used) {
  const base = item.rel.replace(/\.[^./\\]+$/, '');
  if (args.inPlace) {
    const out = path.join(item.root, base + '.png');
    return {
      out,
      original: path.join(item.root, '_originals', item.rel),
      scaled: scale > 1 ? path.join(item.root, '_upscaled', 'x' + scale, base + '.png') : null,
    };
  }
  const root = args.out ? path.resolve(args.out) : path.join(item.root, 'pixel-clean');
  let name = base + '.png', k = 2;
  while (used.has(path.join(root, name).toLowerCase())) name = base + '-' + (k++) + '.png';
  used.add(path.join(root, name).toLowerCase());
  return { out: path.join(root, name), scaled: scale > 1 ? path.join(root, 'x' + scale, name) : null };
}

async function processFiles(items, args, cfg, written) {
  // groupes : meme reglages de palette -> palette commune au groupe
  const groups = new Map();
  for (const it of items) {
    it.opts = optionsFor(it.abs, cfg, args.flags);
    if (it.extra) Object.assign(it.opts.core, it.extra); // corrections propres a l'image (serveur)
    const key = JSON.stringify([it.opts.palette, it.opts.core.colors || 0, it.opts.core.sharedPalette !== false]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  const results = [];
  const used = new Set();
  for (const group of groups.values()) {
    const pal = await loadPalette(group[0].opts.palette);
    const batchOpts = Object.assign({}, group[0].opts.core, pal ? { palette: pal } : {});
    const imgs = [], ok = [];
    for (const it of group) {
      try { imgs.push(await readImage(it.abs)); ok.push(it); } catch (e) {
        results.push({ file: it.abs, ok: false, error: 'lecture impossible : ' + e.message });
      }
    }
    if (!ok.length) continue;
    let res;
    try {
      res = PC.processBatch(imgs, batchOpts, ok.map((it) => Object.assign({}, it.opts.core, pal ? { palette: pal } : {})));
    } catch (e) {
      for (const it of ok) results.push({ file: it.abs, ok: false, error: 'traitement : ' + e.message });
      continue;
    }
    for (let i = 0; i < ok.length; i++) {
      const it = ok[i], r = res[i];
      try {
        const t = targetsFor(it, args, it.opts.scale, used);
        if (args.inPlace) {
          const isPng = /\.png$/i.test(it.abs);
          if (!isPng && fs.existsSync(t.out)) throw new Error(path.basename(t.out) + ' existe deja a cote de la source');
          if (!fs.existsSync(t.original)) {
            await fs.promises.mkdir(path.dirname(t.original), { recursive: true });
            await fs.promises.copyFile(it.abs, t.original);
          }
          await writePng(r.image, t.out);
          if (!isPng) await fs.promises.unlink(it.abs);
        } else await writePng(r.image, t.out);
        if (written) written.set(path.resolve(t.out).toLowerCase(), Date.now());
        if (t.scaled) await writePng(PC.scaleNearest(r.image, it.opts.scale), t.scaled);
        results.push({
          file: it.abs, out: t.out, ok: true, source: r.analysis.source,
          pixelSize: r.analysis.source === 'grid' ? Number(r.analysis.grid.size.toFixed(3)) : null,
          width: r.width, height: r.height, colors: countUsed(r), info: describe(r),
          score: r.analysis.detection && Number.isFinite(r.analysis.detection.score) ? Number(r.analysis.detection.score.toFixed(3)) : null,
        });
      } catch (e) {
        results.push({ file: it.abs, ok: false, error: e.message });
      }
    }
  }
  return results;
}

function printResult(r, json) {
  if (json) return;
  const rel = path.relative(process.cwd(), r.file) || r.file;
  if (r.ok) console.log(`${rel}  ${r.info} -> ${r.width}x${r.height}, ${r.colors} couleurs  -> ${path.relative(process.cwd(), r.out) || r.out}`);
  else console.log(`${rel}  ECHEC : ${r.error}`);
}

// ------------------------------------------------------------ commandes

async function makePalette(args, cfg) {
  if (!args.inputs.length) throw new Error('indiquez un dossier ou des images');
  const items = collect(args.inputs, null);
  if (!items.length) throw new Error('aucune image trouvee');
  const colors = args.flags.colors || 16;
  const analyses = [];
  for (const it of items) {
    const o = optionsFor(it.abs, cfg, args.flags).core;
    try { analyses.push(PC.analyze(await readImage(it.abs), o)); } catch (e) { console.error(it.rel + '  ignore : ' + e.message); }
  }
  if (!analyses.length) throw new Error('aucune image lisible');
  const pal = PC.buildPalette(analyses, { colors });
  const out = path.resolve(args.out || 'palette.hex');
  await fs.promises.mkdir(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, PC.paletteToHexText(pal));
  if (args.json) console.log(JSON.stringify({ ok: true, out, colors: pal.size, hex: pal.hex, images: analyses.length }));
  else console.log(`palette ${pal.size} couleurs (${analyses.length} images) -> ${path.relative(process.cwd(), out) || out}`);
  return 0;
}

async function run(args, cfg) {
  if (!args.inputs.length) throw new Error('indiquez un fichier ou un dossier (voir --help)');
  const items = collect(args.inputs, args.out);
  if (!items.length) throw new Error('aucune image trouvee');
  const results = await processFiles(items, args, cfg);
  results.forEach((r) => printResult(r, args.json));
  if (args.json) console.log(JSON.stringify({ ok: results.every((r) => r.ok), results }, null, 2));
  return results.every((r) => r.ok) ? 0 : 1;
}

async function watch(args, cfg) {
  const dir = path.resolve(args.inputs[0] || '.');
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error('--watch attend un dossier');
  const outRoot = args.inPlace ? null : path.resolve(args.out || path.join(dir, 'pixel-clean'));
  const written = new Map();   // fichiers ecrits par l'outil -> ignores
  const timers = new Map();
  const ignored = (abs) => {
    const rel = path.relative(dir, abs).split(path.sep);
    if (rel.some((p) => IGNORED_DIRS.has(p) || p.startsWith('.'))) return true;
    if (outRoot && (abs + path.sep).toLowerCase().startsWith((outRoot + path.sep).toLowerCase())) return true;
    const w = written.get(abs.toLowerCase());
    return w !== undefined && Date.now() - w < 3000;
  };
  const handle = async (abs) => {
    if (!fs.existsSync(abs) || ignored(abs)) return;
    // attendre que le fichier soit completement ecrit
    let size = -1;
    for (let k = 0; k < 20; k++) {
      const s = fs.statSync(abs).size;
      if (s > 0 && s === size) break;
      size = s;
      await new Promise((r) => setTimeout(r, 150));
    }
    const item = { abs, root: dir, rel: path.relative(dir, abs) };
    const results = await processFiles([item], args, cfg, written);
    results.forEach((r) => (args.json ? console.log(JSON.stringify(r)) : printResult(r, false)));
  };
  fs.watch(dir, { recursive: true }, (evt, filename) => {
    if (!filename || !IMG_EXT.test(filename)) return;
    const abs = path.join(dir, filename);
    if (ignored(abs)) return;
    clearTimeout(timers.get(abs));
    timers.set(abs, setTimeout(() => { timers.delete(abs); handle(abs).catch((e) => console.error(filename + '  ECHEC : ' + e.message)); }, 400));
  });
  if (!args.json) console.log('Surveillance de ' + dir + (outRoot ? ' -> ' + outRoot : ' (sur place)') + ' ; Ctrl+C pour arreter.');
  return new Promise(() => {});
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) {
    console.error('Erreur : ' + e.message + '\n\n' + HELP);
    return 2;
  }
  if (args.cmd === 'serve') {
    try {
      const { startServer } = require('./server.js');
      await startServer({ configFile: args.config || findConfig(process.cwd()), port: args.port || 4870 });
      return new Promise(() => {});
    } catch (e) { console.error('Erreur : ' + e.message); return 2; }
  }
  if (args.cmd === 'help' || (!args.inputs.length && !args.watch)) { console.log(HELP); return args.cmd === 'help' ? 0 : 2; }
  let cfg;
  try { cfg = loadConfig(args.config || findConfig(process.cwd())); } catch (e) { console.error('Erreur : ' + e.message); return 2; }
  try {
    if (args.cmd === 'make-palette') return await makePalette(args, cfg);
    if (args.watch) return await watch(args, cfg);
    return await run(args, cfg);
  } catch (e) {
    console.error('Erreur : ' + e.message);
    return 2;
  }
}

module.exports = { parseArgs, globToRegex, findConfig, loadConfig, optionsFor, readImage, writePng, collect, targetsFor, processFiles, loadPalette, IMG_EXT };

if (require.main === module) {
  main().then((code) => { process.exitCode = code; });
}
