'use strict';
// Generation de faux pixel art synthetique (sprites, agrandissement, bruit).
const path = require('path');
const PC = require(path.join(__dirname, '..', 'pixelclean-core.js'));

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function lab(c) { const o = [0, 0, 0]; PC.rgbToLab(c[0], c[1], c[2], o, 0); return o; }
function labD(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }

// ------------------------------------------------------------ generation

function genPalette(n, rng) {
  const pal = [];
  let guard = 0;
  while (pal.length < n && guard++ < 20000) {
    const c = [rng() * 256 | 0, rng() * 256 | 0, rng() * 256 | 0];
    const l = lab(c);
    if (pal.every((p) => labD(lab(p), l) >= 0.12)) pal.push(c);
  }
  pal.sort((a, b) => lab(a)[0] - lab(b)[0]); // 0 = plus sombre (contour)
  return pal;
}

// Sprite symetrique : union d'ellipses, regions de Voronoi, contour sombre.
function genSprite(w, h, K, rng, transparent) {
  const mask = new Uint8Array(w * h);
  const ne = 3 + (rng() * 3 | 0);
  for (let e = 0; e < ne; e++) {
    const cx = 1 + rng() * (w / 2 - 1), cy = 1.5 + rng() * (h - 3);
    const rx = 1.5 + rng() * (w / 3), ry = 1.5 + rng() * (h / 3);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const xm = x < w / 2 ? x : w - 1 - x;
        if (((xm - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) mask[y * w + x] = 1;
      }
    }
  }
  // tronc central pour relier les ellipses
  for (let y = Math.floor(h * 0.25); y < Math.ceil(h * 0.75); y++) {
    for (let x = Math.floor(w / 2) - 2; x <= Math.ceil(w / 2) + 1; x++) if (x > 0 && x < w - 1) mask[y * w + x] = 1;
  }
  const bgIdx = transparent ? -1 : K - 1;
  const fillColors = [];
  for (let c = 1; c < (transparent ? K : K - 1); c++) fillColors.push(c);
  const seeds = [];
  const nSeeds = fillColors.length * 2;
  for (let s = 0; s < nSeeds; s++) {
    let x, y, g = 0;
    do { x = rng() * w | 0; y = rng() * h | 0; } while (!mask[y * w + x] && g++ < 1000);
    seeds.push([x, y, fillColors[s % fillColors.length]]);
  }
  const idx = new Int16Array(w * h).fill(bgIdx);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      const xm = x < w / 2 ? x : w - 1 - x;
      let best = 0, bd = Infinity;
      for (let s = 0; s < seeds.length; s++) {
        const sx = seeds[s][0] < w / 2 ? seeds[s][0] : w - 1 - seeds[s][0];
        const dd = (sx - xm) ** 2 + (seeds[s][1] - y) ** 2;
        if (dd < bd) { bd = dd; best = s; }
      }
      idx[y * w + x] = seeds[best][2];
    }
  }
  // contour
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      const out = (xx, yy) => xx < 0 || yy < 0 || xx >= w || yy >= h || !mask[yy * w + xx];
      if (out(x - 1, y) || out(x + 1, y) || out(x, y - 1) || out(x, y + 1)) idx[y * w + x] = 0;
    }
  }
  // details d'1 pixel (yeux)
  const ey = Math.floor(h * 0.4), ex = Math.floor(w / 2) - 2;
  for (const x of [ex, w - 1 - ex]) if (mask[ey * w + x] && idx[ey * w + x] !== 0) idx[ey * w + x] = 0;
  return idx;
}

// Agrandissement non entier avec derive, bilineaire ou par aire + flou.
function render(sprite, w, h, pal, s, rng, opt) {
  // derive : chaque ligne bouge de +-0.5 px -> cellules qui varient de +-1 px
  const jit = opt.jitter === undefined ? 0.5 : opt.jitter;
  const bounds = (n) => {
    const lead = (0.05 + 0.2 * rng()) * s;
    const b = new Float64Array(n + 1);
    for (let k = 0; k <= n; k++) b[k] = lead + k * s + (k > 0 && k < n ? (rng() * 2 - 1) * jit : 0);
    const trail = (0.05 + 0.2 * rng()) * s;
    return { b, size: Math.round(b[n] + trail) };
  };
  const bx = bounds(w), by = bounds(h);
  const W = bx.size, H = by.size;
  const mapU = (b, n, xc) => {
    if (xc < b[0]) return (xc - b[0]) / s;
    if (xc >= b[n]) return n + (xc - b[n]) / s;
    let k = 0;
    while (k < n - 1 && xc >= b[k + 1]) k++;
    return k + (xc - b[k]) / (b[k + 1] - b[k]);
  };
  const ux = new Float64Array(W + 1), uy = new Float64Array(H + 1);
  const cx = new Float64Array(W), cy = new Float64Array(H);
  for (let x = 0; x <= W; x++) ux[x] = mapU(bx.b, w, x);
  for (let y = 0; y <= H; y++) uy[y] = mapU(by.b, h, y);
  for (let x = 0; x < W; x++) cx[x] = mapU(bx.b, w, x + 0.5);
  for (let y = 0; y < H; y++) cy[y] = mapU(by.b, h, y + 0.5);
  const src = (i, j) => {
    i = Math.max(0, Math.min(w - 1, i)); j = Math.max(0, Math.min(h - 1, j));
    const c = sprite[j * w + i];
    return c < 0 ? [0, 0, 0, 0] : [pal[c][0], pal[c][1], pal[c][2], 1];
  };
  let buf = new Float64Array(W * H * 4); // premultiplie
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const acc = [0, 0, 0, 0];
      if (opt.mode === 'bilinear') {
        const u = cx[x] - 0.5, v = cy[y] - 0.5;
        const i0 = Math.floor(u), j0 = Math.floor(v), fu = u - i0, fv = v - j0;
        const ws = [[i0, j0, (1 - fu) * (1 - fv)], [i0 + 1, j0, fu * (1 - fv)], [i0, j0 + 1, (1 - fu) * fv], [i0 + 1, j0 + 1, fu * fv]];
        for (const [i, j, wgt] of ws) {
          const c = src(i, j);
          acc[0] += c[0] * c[3] * wgt; acc[1] += c[1] * c[3] * wgt; acc[2] += c[2] * c[3] * wgt; acc[3] += c[3] * wgt;
        }
      } else {
        // aire : moyenne exacte des cellules couvertes par le pixel
        const u0 = ux[x], u1 = ux[x + 1], v0 = uy[y], v1 = uy[y + 1];
        let tot = 0;
        for (let j = Math.floor(v0); j < v1; j++) {
          const wy = Math.min(v1, j + 1) - Math.max(v0, j);
          if (wy <= 0) continue;
          for (let i = Math.floor(u0); i < u1; i++) {
            const wx = Math.min(u1, i + 1) - Math.max(u0, i);
            if (wx <= 0) continue;
            const c = src(i, j), wgt = wx * wy;
            acc[0] += c[0] * c[3] * wgt; acc[1] += c[1] * c[3] * wgt; acc[2] += c[2] * c[3] * wgt; acc[3] += c[3] * wgt;
            tot += wgt;
          }
        }
        for (let q = 0; q < 4; q++) acc[q] /= tot || 1;
      }
      buf.set(acc, (y * W + x) * 4);
    }
  }
  if (opt.mode === 'area') {
    // bords flous : flou [1 2 1] separable
    const tmp = new Float64Array(buf.length);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let q = 0; q < 4; q++) {
      const a = buf[(y * W + Math.max(0, x - 1)) * 4 + q], b = buf[(y * W + x) * 4 + q], c = buf[(y * W + Math.min(W - 1, x + 1)) * 4 + q];
      tmp[(y * W + x) * 4 + q] = 0.25 * a + 0.5 * b + 0.25 * c;
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let q = 0; q < 4; q++) {
      const a = tmp[(Math.max(0, y - 1) * W + x) * 4 + q], b = tmp[(y * W + x) * 4 + q], c = tmp[(Math.min(H - 1, y + 1) * W + x) * 4 + q];
      buf[(y * W + x) * 4 + q] = 0.25 * a + 0.5 * b + 0.25 * c;
    }
  }
  const data = new Uint8ClampedArray(W * H * 4);
  const cs = 10 + (rng() * 8 | 0);
  const noise = opt.noise === undefined ? 8 : opt.noise;
  for (let i = 0; i < W * H; i++) {
    let a = buf[i * 4 + 3];
    let r = a > 1e-6 ? buf[i * 4] / a : 0, g = a > 1e-6 ? buf[i * 4 + 1] / a : 0, b = a > 1e-6 ? buf[i * 4 + 2] / a : 0;
    if (opt.checker) {
      const x = i % W, y = (i - x) / W;
      const bgc = ((Math.floor(x / cs) + Math.floor(y / cs)) & 1) ? 204 : 255;
      r = r * a + bgc * (1 - a); g = g * a + bgc * (1 - a); b = b * a + bgc * (1 - a); a = 1;
    }
    const nz = () => Math.round((rng() * 2 - 1) * noise);
    data[i * 4] = r + nz(); data[i * 4 + 1] = g + nz(); data[i * 4 + 2] = b + nz();
    data[i * 4 + 3] = Math.round(a * 255);
  }
  return { width: W, height: H, data, truthX: bx.b, truthY: by.b };
}

// ------------------------------------------------------------ evaluation

function evaluate(res, sprite, w, h, pal, sTrue) {
  const sizeErr = Math.abs(res.size - sTrue) / sTrue;
  const dimsOk = res.width === w && res.height === h;
  let acc = 0, accOpaque = 0;
  const truthLab = pal.map(lab);
  const used = new Set();
  for (const c of sprite) if (c >= 0) used.add(c);
  const outIdx = res.image.indices;
  const outUsed = new Set();
  for (const c of outIdx) if (c >= 0) outUsed.add(c);
  if (dimsOk) {
    const map = res.palette.rgb.map((c) => {
      const l = lab(c);
      let best = 0, bd = Infinity;
      truthLab.forEach((t, i) => { const d = labD(t, l); if (d < bd) { bd = d; best = i; } });
      return best;
    });
    let ok = 0, nOp = 0, okOp = 0;
    for (let i = 0; i < w * h; i++) {
      const o = sprite[i], r = outIdx[i];
      const good = (o < 0 && r < 0) || (o >= 0 && r >= 0 && map[r] === o);
      if (good) ok++;
      if (o >= 0) { nOp++; if (good) okOp++; }
    }
    acc = ok / (w * h); accOpaque = nOp ? okOp / nOp : 1;
  }
  const kTrue = used.size, kOut = outUsed.size;
  return { sizeErr, dimsOk, acc, accOpaque, kTrue, kOut };
}

module.exports = { mulberry32, lab, labD, genPalette, genSprite, render, evaluate };

// ------------------------------------------------ illustrations lisses
// Formes arrondies (union d'ellipses), ombrage en degrade, anticrenelage
// (sur-echantillonnage 2x), contour sombre de 3 a 6 px, petit bruit.
// Renvoie aussi la couverture vraie (0..1) pour mesurer la silhouette.
function genSmooth(W, H, rng, opt) {
  const S = 2, w2 = W * S, h2 = H * S;
  const shapes = [];
  const cx0 = W * (0.4 + 0.2 * rng()), cy0 = H * (0.45 + 0.1 * rng());
  const R = Math.min(W, H) * (0.22 + 0.06 * rng());
  shapes.push({ cx: cx0, cy: cy0, rx: R * (0.9 + 0.3 * rng()), ry: R * (1.1 + 0.3 * rng()) });            // corps
  shapes.push({ cx: cx0 + (rng() - 0.5) * R * 0.4, cy: cy0 - R * 1.25, rx: R * 0.62, ry: R * 0.58 });      // tete
  shapes.push({ cx: cx0 - R * 0.95, cy: cy0 + R * (0.1 + 0.3 * rng()), rx: R * 0.32, ry: R * 0.62 });     // bras
  shapes.push({ cx: cx0 + R * 0.95, cy: cy0 + R * (0.1 + 0.3 * rng()), rx: R * 0.32, ry: R * 0.62 });
  const hues = shapes.map(() => rng() * 360);
  const ow = opt.outline * S;
  const region = new Int8Array(w2 * h2).fill(-1);
  for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) {
    const px = (x + 0.5) / S, py = (y + 0.5) / S;
    for (let k = shapes.length - 1; k >= 0; k--) {
      const s = shapes[k];
      if (((px - s.cx) / s.rx) ** 2 + ((py - s.cy) / s.ry) ** 2 <= 1) { region[y * w2 + x] = k; break; }
    }
  }
  // distance (chanfrein) au bord exterieur et aux frontieres entre regions
  const INF = 1e9, dist = new Float64Array(w2 * h2).fill(INF);
  for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) {
    const i = y * w2 + x, r = region[i];
    if (r < 0) { dist[i] = 0; continue; }
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const xx = x + dx, yy = y + dy;
      const rr = xx < 0 || yy < 0 || xx >= w2 || yy >= h2 ? -1 : region[yy * w2 + xx];
      if (rr !== r) dist[i] = Math.min(dist[i], rr < 0 ? 0.5 : 0.5 + ow / 2);
    }
  }
  const pass = (fw) => {
    const ys = fw ? [...Array(h2).keys()] : [...Array(h2).keys()].reverse();
    const xs = fw ? [...Array(w2).keys()] : [...Array(w2).keys()].reverse();
    const nb = fw ? [[-1, 0, 1], [0, -1, 1], [-1, -1, 1.414], [1, -1, 1.414]] : [[1, 0, 1], [0, 1, 1], [1, 1, 1.414], [-1, 1, 1.414]];
    for (const y of ys) for (const x of xs) {
      const i = y * w2 + x;
      for (const [dx, dy, c] of nb) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w2 || yy >= h2) continue;
        const v = dist[yy * w2 + xx] + c;
        if (v < dist[i]) dist[i] = v;
      }
    }
  };
  pass(true); pass(false);
  const hsl = (h, s, l) => {
    const a = s * Math.min(l, 1 - l), f = (n) => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
    return [f(0) * 255, f(8) * 255, f(4) * 255];
  };
  const out = new Float64Array(w2 * h2 * 4);
  for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) {
    const i = y * w2 + x, r = region[i];
    if (r < 0) continue;
    let c;
    if (dist[i] <= ow) c = [28, 22, 34];
    else {
      const s = shapes[r], px = (x + 0.5) / S, py = (y + 0.5) / S;
      const t = Math.max(0, Math.min(1, 0.55 - 0.45 * ((px - s.cx) / s.rx * 0.6 + (py - s.cy) / s.ry * 0.8)));
      c = hsl(hues[r], 0.55, 0.22 + 0.55 * t);
    }
    out.set([c[0], c[1], c[2], 1], i * 4);
  }
  const data = new Uint8ClampedArray(W * H * 4), cover = new Float64Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let a = 0, r = 0, g = 0, b = 0;
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
      const q = ((y * S + sy) * w2 + x * S + sx) * 4, al = out[q + 3];
      a += al; r += out[q] * al; g += out[q + 1] * al; b += out[q + 2] * al;
    }
    a /= S * S;
    cover[y * W + x] = a;
    const nz = () => Math.round((rng() * 2 - 1) * 4);
    const i = (y * W + x) * 4;
    if (opt.bg) {
      const bgc = opt.bg;
      const fr = a > 0 ? r / (a * S * S) : 0, fg = a > 0 ? g / (a * S * S) : 0, fb = a > 0 ? b / (a * S * S) : 0;
      data[i] = fr * a + bgc[0] * (1 - a) + nz(); data[i + 1] = fg * a + bgc[1] * (1 - a) + nz(); data[i + 2] = fb * a + bgc[2] * (1 - a) + nz(); data[i + 3] = 255;
    } else if (a > 0) {
      data[i] = r / (a * S * S) + nz(); data[i + 1] = g / (a * S * S) + nz(); data[i + 2] = b / (a * S * S) + nz(); data[i + 3] = Math.round(a * 255);
    }
  }
  return { width: W, height: H, data, cover };
}

module.exports.genSmooth = genSmooth;
