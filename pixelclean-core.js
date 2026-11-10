/*
 * pixelclean-core.js
 * Nettoyage algorithmique de "faux pixel art" (images IA) -> vrai pixel art.
 * Aucune IA, aucun DOM : fonctions pures sur des images
 *   { width, height, data: Uint8ClampedArray RGBA }.
 * Utilisable dans le navigateur (window.PixelClean) et dans Node (require).
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PixelClean = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---------------------------------------------------------------- options

  const DEFAULTS = Object.freeze({
    pixelSize: 0,          // 0 = auto ; sinon taille de pixel (fractionnaire)
    offsetX: null,         // null = auto ; sinon position de la 1re ligne de grille (px)
    offsetY: null,
    minSize: 2,
    maxSize: 64,
    adaptive: true,        // recalage local des lignes (derive)
    margin: 0.22,          // marge ignoree de chaque cote d'une cellule
    colors: 0,             // 0 = auto ; sinon nombre de couleurs
    maxColors: 32,
    colorTolerance: 0.07,  // OKLab : ecart tolere en mode auto
    palette: null,         // palette imposee : [[r,g,b], ...]
    sharedPalette: true,
    background: 'auto',    // 'auto' (fond -> transparent) | 'keep'
    bgTolerance: 40,       // distance RGB
    alphaThreshold: 128,
    cleanup: true,         // pixels isoles / ilots
    cleanupGuard: 0.2,     // OKLab : au-dela, un pixel isole est un detail voulu
    cleanOutline: false,   // embellissement : contour propre
    outlineMode: 'darkest',// 'darkest' | 'selective'
    pixelPerfect: false,   // embellissement : lignes pixel-perfect
    inkLines: true,        // conversion : traits d'encre de l'original -> lignes d'1 pixel
    tileable: false,       // tuile qui se raccorde : grille calee sur l'image entiere, bords = suite du sol
    sizeMode: 'fixed',    // 'fixed' : taille finale imposee a toutes les images ;
                           // 'auto' : grille detectee si trouvee, sinon taille cible
    force: 'auto',         // 'auto' | 'grid' (grille detectee) | 'target' (taille cible)
    targetBy: 'height',    // 'height' | 'factor'
    targetHeight: 32,      // hauteur finale du sujet en pixels
    targetWidth: 0,        // largeur maxi (0 = libre) : le sujet tient dans H x L
    targetFactor: 8,       // facteur de reduction (targetBy = 'factor')
    seed: 1,
  });

  function withDefaults(o) {
    const r = Object.assign({}, DEFAULTS);
    if (o) for (const k in o) if (o[k] !== undefined) r[k] = o[k];
    return r;
  }

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------------------------------------------------------------- couleur

  const LIN = new Float64Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  function rgbToLab(r, g, b, out, o) {
    const lr = LIN[r], lg = LIN[g], lb = LIN[b];
    const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
    const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
    const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
    out[o] = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
    out[o + 1] = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
    out[o + 2] = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  }

  function gammaEnc(c) {
    c = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(c * 255)));
  }

  function labToRgb(L, A, B) {
    const l = L + 0.3963377774 * A + 0.2158037573 * B;
    const m = L - 0.1055613458 * A - 0.0638541728 * B;
    const s = L - 0.0894841775 * A - 1.2914855480 * B;
    const l3 = l * l * l, m3 = m * m * m, s3 = s * s * s;
    return [
      gammaEnc(4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3),
      gammaEnc(-1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3),
      gammaEnc(-0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3),
    ];
  }

  // ------------------------------------------------- a) masque alpha / fond

  function computeMask(img, o) {
    const N = img.width * img.height, d = img.data;
    const mask = new Uint8Array(N);
    const thr = Math.max(1, o.alphaThreshold);
    let transparent = 0;
    for (let i = 0; i < N; i++) {
      if (d[i * 4 + 3] >= thr) mask[i] = 1; else transparent++;
    }
    let bg = { type: transparent > 0 ? 'alpha' : 'none' };
    if (transparent === 0 && o.background === 'auto') bg = removeBackground(img, mask, o);
    return { mask, bg };
  }

  function borderIndices(W, H, band) {
    const out = [];
    for (let y = 0; y < H; y++) {
      if (y < band || y >= H - band) {
        for (let x = 0; x < W; x++) out.push(y * W + x);
      } else {
        for (let x = 0; x < band; x++) out.push(y * W + x);
        for (let x = Math.max(band, W - band); x < W; x++) out.push(y * W + x);
      }
    }
    return out;
  }

  // Fond uni ou faux damier (2 gris alternes) detecte sur les bords,
  // puis remplissage depuis les bords avec tolerance.
  function removeBackground(img, mask, o) {
    const W = img.width, H = img.height, d = img.data;
    const band = Math.max(1, Math.min(4, Math.floor(Math.min(W, H) / 64)));
    const border = borderIndices(W, H, band);
    const n = border.length;
    const tol = o.bgTolerance, tol2 = tol * tol;
    if (n === 0) return { type: 'none' };
    const dist2 = (p, c) => {
      const a = d[p] - c[0], b = d[p + 1] - c[1], e = d[p + 2] - c[2];
      return a * a + b * b + e * e;
    };
    const dominant = (excl) => {
      const hist = new Int32Array(4096);
      for (let j = 0; j < n; j++) {
        if (excl && excl[j]) continue;
        const p = border[j] * 4;
        hist[((d[p] >> 4) << 8) | ((d[p + 1] >> 4) << 4) | (d[p + 2] >> 4)]++;
      }
      let best = -1, bc = 0;
      for (let h = 0; h < 4096; h++) if (hist[h] > bc) { bc = hist[h]; best = h; }
      if (best < 0) return null;
      let sr = 0, sg = 0, sb = 0, c = 0;
      for (let j = 0; j < n; j++) {
        if (excl && excl[j]) continue;
        const p = border[j] * 4;
        if ((((d[p] >> 4) << 8) | ((d[p + 1] >> 4) << 4) | (d[p + 2] >> 4)) === best) {
          sr += d[p]; sg += d[p + 1]; sb += d[p + 2]; c++;
        }
      }
      return [sr / c, sg / c, sb / c];
    };
    const c1 = dominant(null);
    const near1 = new Uint8Array(n);
    let n1 = 0;
    for (let j = 0; j < n; j++) if (dist2(border[j] * 4, c1) <= tol2) { near1[j] = 1; n1++; }
    const c2 = n1 < n ? dominant(near1) : null;
    let n2 = 0;
    if (c2) for (let j = 0; j < n; j++) if (!near1[j] && dist2(border[j] * 4, c2) <= tol2) n2++;
    const f1 = n1 / n, f2 = n2 / n;
    const gray = (c) => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]) < 32;
    const sep = c2 ? Math.sqrt((c1[0] - c2[0]) ** 2 + (c1[1] - c2[1]) ** 2 + (c1[2] - c2[2]) ** 2) : 0;
    let mode = 'none';
    if (c2 && f2 >= 0.12 && f1 + f2 >= 0.7 && gray(c1) && gray(c2) && sep > tol) mode = 'checker';
    else if (f1 >= 0.7) mode = 'solid';
    if (mode === 'none') return { type: 'none' };

    const ux = c2 ? c2[0] - c1[0] : 0, uy = c2 ? c2[1] - c1[1] : 0, uz = c2 ? c2[2] - c1[2] : 0;
    const uu = ux * ux + uy * uy + uz * uz || 1;
    const match = mode === 'checker'
      ? (p) => {
        const a = d[p] - c1[0], b = d[p + 1] - c1[1], e = d[p + 2] - c1[2];
        let t = (a * ux + b * uy + e * uz) / uu;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qa = a - t * ux, qb = b - t * uy, qe = e - t * uz;
        return qa * qa + qb * qb + qe * qe <= tol2;
      }
      : (p) => dist2(p, c1) <= tol2;

    const N = W * H, seen = new Uint8Array(N), stack = new Int32Array(N);
    let sp = 0, removed = 0;
    const push = (i) => { if (!seen[i] && mask[i] && match(i * 4)) { seen[i] = 1; stack[sp++] = i; } };
    for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
    for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
    while (sp > 0) {
      const i = stack[--sp];
      mask[i] = 0; removed++;
      const x = i % W, y = (i - x) / W;
      if (x > 0) push(i - 1);
      if (x < W - 1) push(i + 1);
      if (y > 0) push(i - W);
      if (y < H - 1) push(i + W);
    }
    const colors = (mode === 'checker' ? [c1, c2] : [c1]).map((c) => c.map(Math.round));
    return { type: mode, colors, removed };
  }

  // ------------------------------------------------- b) detection de grille

  // Caracteristiques par pixel : RGB premultiplie par l'alpha binaire + alpha.
  // Si le fond a ete retire (uni / damier), les pixels retires prennent la
  // couleur moyenne du fond : le bord du sprite reste a sa vraie place.
  function buildFeatures(img, mask, bg) {
    const N = img.width * img.height, d = img.data, F = new Float32Array(N * 4);
    let fill = null;
    if (bg && bg.colors && bg.colors.length) {
      fill = [0, 0, 0];
      for (const c of bg.colors) { fill[0] += c[0] / bg.colors.length; fill[1] += c[1] / bg.colors.length; fill[2] += c[2] / bg.colors.length; }
    }
    for (let i = 0, p = 0; i < N; i++, p += 4) {
      if (mask[i]) { F[p] = d[p]; F[p + 1] = d[p + 1]; F[p + 2] = d[p + 2]; F[p + 3] = 255; }
      else if (fill) { F[p] = fill[0]; F[p + 1] = fill[1]; F[p + 2] = fill[2]; F[p + 3] = 255; }
    }
    return F;
  }

  const CAPQ = 0.95;           // plafond des energies de bord (quantile)
  const HARM = 0.85;           // s/k garde si son score atteint 85 % (harmoniques)
  const STROKE_MIN = 0.1;      // profondeur mini (L OKLab) d'un trait sombre
  const GRID_MIN_SCORE = -1.4; // seuil "grille de pixels detectee" (calibre par les tests)
  function quantile(arr, q) {
    if (!arr.length) return 1;
    const a = Float32Array.from(arr).sort();
    return Math.max(1e-6, a[Math.min(a.length - 1, Math.floor(q * a.length))]);
  }

  // Passe-haut a echelle fixe (en px) puis normalisation : enleve
  // l'enveloppe basse frequence (forme du sprite) et garde les pics fins.
  function highpass(P, r) {
    const n = P.length, S = new Float64Array(n + 1), out = new Float64Array(n);
    for (let i = 0; i < n; i++) S[i + 1] = S[i] + P[i];
    let scale = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - r), b = Math.min(n, i + r + 1);
      out[i] = P[i] - (S[b] - S[a]) / (b - a);
      scale += Math.abs(out[i]);
    }
    scale = scale / n || 1;
    for (let i = 0; i < n; i++) out[i] /= scale;
    return out;
  }

  // Profils d'energie le long d'un axe (n pixels), cumules sur m lignes.
  // P1[a] : |difference premiere| entre a-1 et a (position a) -> bords
  // P2[r][a] : |difference seconde| d'ecart r sur la ligne lissee (boite de
  //   largeur ~r), au pixel a (position a + 0.5) -> "genoux" des rampes
  //   d'un agrandissement bilineaire (centres de cellule). Plusieurs echelles
  //   r car le signal est faible devant le bruit quand les cellules sont grandes.
  // Valeurs plafonnees (quantile 95 %) pour que quelques bords tres forts
  // (transparence) ne dominent pas, puis passe-haut et normalisation.
  const SCALES = [1, 2, 3, 5, 8];
  function axisProfiles(F, n, m, sA, sX) {
    const line = new Float32Array(n * 4), pre = new Float64Array((n + 1) * 4), g = new Float32Array(n * 4);
    const ns = SCALES.length;
    const d1 = new Float32Array(n + 1), d2 = SCALES.map(() => new Float32Array(n + 1));
    const fillLine = (b) => {
      const b0 = b > 0 ? b - 1 : b, b2 = b < m - 1 ? b + 1 : b;
      for (let a = 0; a < n; a++) {
        const q = a * sA, p0 = (q + b0 * sX) * 4, p1 = (q + b * sX) * 4, p2 = (q + b2 * sX) * 4, o = a * 4;
        line[o] = 0.25 * F[p0] + 0.5 * F[p1] + 0.25 * F[p2];
        line[o + 1] = 0.25 * F[p0 + 1] + 0.5 * F[p1 + 1] + 0.25 * F[p2 + 1];
        line[o + 2] = 0.25 * F[p0 + 2] + 0.5 * F[p1 + 2] + 0.25 * F[p2 + 2];
        line[o + 3] = 0.25 * F[p0 + 3] + 0.5 * F[p1 + 3] + 0.25 * F[p2 + 3];
        pre[o + 4] = pre[o] + line[o]; pre[o + 5] = pre[o + 1] + line[o + 1];
        pre[o + 6] = pre[o + 2] + line[o + 2]; pre[o + 7] = pre[o + 3] + line[o + 3];
      }
      d1.fill(0);
      for (let a = 1; a < n; a++) {
        const o = a * 4;
        d1[a] = Math.abs(line[o] - line[o - 4]) + Math.abs(line[o + 1] - line[o - 3]) +
          Math.abs(line[o + 2] - line[o - 2]) + Math.abs(line[o + 3] - line[o - 1]);
      }
      for (let si = 0; si < ns; si++) {
        const r = SCALES[si], h = r >> 1, dd = d2[si];
        dd.fill(0);
        if (2 * r + 1 > n) continue;
        // ligne lissee (boite 2h+1)
        for (let a = 0; a < n; a++) {
          const lo = Math.max(0, a - h), hi = Math.min(n, a + h + 1), inv = 1 / (hi - lo), o = a * 4;
          g[o] = (pre[hi * 4] - pre[lo * 4]) * inv; g[o + 1] = (pre[hi * 4 + 1] - pre[lo * 4 + 1]) * inv;
          g[o + 2] = (pre[hi * 4 + 2] - pre[lo * 4 + 2]) * inv; g[o + 3] = (pre[hi * 4 + 3] - pre[lo * 4 + 3]) * inv;
        }
        // courbure : seulement entre pixels opaques (sinon les bords de
        // transparence ajouteraient des pics decales d'une demi-periode)
        const R = r * 4;
        for (let a = r; a < n - r; a++) {
          const o = a * 4;
          if (g[o - R + 3] < 254.9 || g[o + 3] < 254.9 || g[o + R + 3] < 254.9) continue;
          dd[a] = Math.abs(g[o + R] - 2 * g[o] + g[o - R]) + Math.abs(g[o + R + 1] - 2 * g[o + 1] + g[o - R + 1]) +
            Math.abs(g[o + R + 2] - 2 * g[o + 2] + g[o - R + 2]);
        }
      }
    };
    const v1 = [], v2 = SCALES.map(() => []);
    const stepB = Math.max(1, Math.floor(m / 96));
    for (let b = 0; b < m; b += stepB) {
      fillLine(b);
      for (let a = 1; a < n; a++) {
        if (d1[a] > 0) v1.push(d1[a]);
        for (let si = 0; si < ns; si++) if (d2[si][a] > 0) v2[si].push(d2[si][a]);
      }
    }
    const cap1 = quantile(v1, CAPQ), cap2 = v2.map((v) => quantile(v, CAPQ));
    const P1 = new Float64Array(n + 1), P2 = SCALES.map(() => new Float64Array(n + 1));
    // grandes images : une ligne sur deux (ou trois) suffit pour le profil
    const rowStep = Math.max(1, Math.round(m / 400));
    for (let b = rowStep >> 1; b < m; b += rowStep) {
      fillLine(b);
      for (let a = 1; a < n; a++) {
        P1[a] += d1[a] < cap1 ? d1[a] : cap1;
        for (let si = 0; si < ns; si++) {
          const v = d2[si][a], c = cap2[si];
          P2[si][a] += v < c ? v : c;
        }
      }
    }
    return {
      P1: highpass(P1, 4),
      P2: P2.map((P, si) => ({ r: SCALES[si], P: highpass(P, Math.max(4, 2 * SCALES[si] + 1)) })),
    };
  }

  // Repliement du profil modulo s (periodogramme par repliement) :
  // contraste relatif du profil replie lisse. Les harmoniques 2s, 3s...
  // donnent le meme contraste, s/2 environ la moitie.
  function makeFolder() {
    const sum = new Float64Array(256), cnt = new Float64Array(256), ker = new Float64Array(256);
    return function fold(P, pos0, i0, i1, s, sigmaPx) {
      const B = Math.min(128, Math.max(16, Math.ceil(s * 2)));
      sum.fill(0, 0, B); cnt.fill(0, 0, B);
      const inv = B / s;
      for (let i = i0; i < i1; i++) {
        const t = ((i + pos0) * inv) % B;
        const b0 = t | 0, f = t - b0, b1 = b0 + 1 >= B ? 0 : b0 + 1, v = P[i];
        sum[b0] += (1 - f) * v; cnt[b0] += 1 - f;
        sum[b1] += f * v; cnt[b1] += f;
      }
      const sb = Math.max(0.5, sigmaPx * inv);
      const R = Math.min((B >> 1) - 1, Math.ceil(3 * sb));
      for (let r = 0; r <= R; r++) ker[r] = Math.exp(-0.5 * r * r / (sb * sb));
      let best = -Infinity, bestB = 0, tot = 0;
      for (let b = 0; b < B; b++) {
        let a = sum[b] * ker[0], c = cnt[b] * ker[0];
        for (let r = 1; r <= R; r++) {
          const l = b - r < 0 ? b - r + B : b - r, h = b + r >= B ? b + r - B : b + r;
          a += (sum[l] + sum[h]) * ker[r];
          c += (cnt[l] + cnt[h]) * ker[r];
        }
        const v = c > 0 ? a / c : 0;
        tot += v;
        if (v > best) { best = v; bestB = b; }
      }
      const mean = tot / B;
      return { contrast: best - mean, phase: bestB / inv };
    };
  }

  function activeRange(mask, W, H, axis) {
    let lo = Infinity, hi = -1;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (mask[y * W + x]) {
          const a = axis === 0 ? x : y;
          if (a < lo) lo = a;
          if (a > hi) hi = a;
        }
      }
    }
    if (hi < 0) return [0, (axis === 0 ? W : H) - 1];
    return [lo, hi];
  }

  // Estimation de la periode (taille de pixel) commune aux deux axes.
  // Score z : contraste du profil replie x racine(nombre de periodes), ce
  // qui compense le biais des longues periodes (peu de periodes repliees).
  // En theorie z(2s) ~ z(s)/1.41 et z(s/2) ~ 0.71 z(s).
  // Deux profils : bords (P1) et courbure (P2, utile en bilineaire pur) ; on
  // garde le plus net des deux (les additionner creerait une periode s/2).
  function estimatePeriod(prof, ranges, dims, o) {
    const fold = makeFolder();
    const extA = [ranges[0][1] - ranges[0][0] + 1, ranges[1][1] - ranges[1][0] + 1];
    const ext = Math.max(extA[0], extA[1]);
    const sMin = Math.max(1.5, o.minSize);
    const sMax = Math.max(sMin * 1.5, Math.min(o.maxSize, ext / 4));
    const sigmaOf = (s) => 0.5 + 0.03 * s;

    const zAxis = (P, pos0, ax, s, sig) => {
      const n = dims[ax];
      const i0 = Math.max(1, ranges[ax][0] - 1), i1 = Math.min(n, ranges[ax][1] + 2);
      if (i1 - i0 < 4 || extA[ax] < 2 * s) return 0;
      return fold(P, pos0, i0, i1, s, sig).contrast * Math.sqrt(extA[ax] / s);
    };
    const scoreAt = (type, s) => {
      if (type === 1) return zAxis(prof[0].P1, 0, 0, s, sigmaOf(s)) + zAxis(prof[1].P1, 0, 1, s, sigmaOf(s));
      let best = 0, last = -1;
      for (let si = 0; si < prof[0].P2.length; si++) if (prof[0].P2[si].r <= s / 2.5) last = si;
      for (let si = 0; si <= last; si++) {
        const r = prof[0].P2[si].r;
        if (r < s / 12 && si < last) continue; // echelle trop fine pour cette periode

        const sig = Math.max(sigmaOf(s), 0.4 * r);
        const v = zAxis(prof[0].P2[si].P, 0.5, 0, s, sig) + zAxis(prof[1].P2[si].P, 0.5, 1, s, sig);
        if (v > best) best = v;
      }
      return best;
    };

    const sList = [];
    for (let s = sMin; s <= sMax; s *= 1.0025) sList.push(s);
    if (sList.length < 3) return { size: sMin, type: 1, confidence: 0 };

    const refine = (type, s0, rel, steps) => {
      let bs = s0, bv = scoreAt(type, s0);
      for (let i = -steps; i <= steps; i++) {
        const s = s0 * (1 + rel * i / steps);
        const v = scoreAt(type, s);
        if (v > bv) { bv = v; bs = s; }
      }
      return { s: bs, v: bv };
    };

    const results = [];
    for (const type of [1, 2]) {
      const sc = sList.map((s) => scoreAt(type, s));
      let bi = 0;
      for (let i = 1; i < sc.length; i++) if (sc[i] > sc[bi]) bi = i;
      let pick = refine(type, sList[bi], 0.004, 8);
      const top = pick.v;
      // harmoniques : si s/2 ou s/3 score presque autant, la vraie periode
      // est la plus petite
      for (let guard = 0; guard < 4; guard++) {
        let next = null;
        for (const k of [2, 3]) {
          const s = pick.s / k;
          if (s < sMin) continue;
          const c = refine(type, s, 0.006, 6);
          if (c.v >= HARM * pick.v && (!next || c.s < next.s)) next = c;
        }
        if (!next) break;
        pick = next;
      }
      const sorted = Float64Array.from(sc).sort();
      const median = sorted[sorted.length >> 1] || 1e-9;
      results.push({ type, s: pick.s, v: top, significance: top / median });
    }
    const best = results[0].v >= results[1].v ? results[0] : results[1];
    return { size: best.s, type: best.type, confidence: best.significance, all: results, scoreAt };
  }

  // Sommes prefixees sur des lignes echantillonnees (pour SSE par segment).
  function makeSampler(F, n, m, sA, sX, maxLines) {
    const step = Math.max(1, Math.floor(m / maxLines));
    const lines = [];
    for (let b = Math.floor(step / 2); b < m; b += step) lines.push(b);
    const L = lines.length, n1 = n + 1;
    const S1 = new Float64Array(L * n1 * 4), S2 = new Float64Array(L * n1);
    for (let li = 0; li < L; li++) {
      const b = lines[li], o1 = li * n1 * 4, o2 = li * n1;
      let a0 = 0, a1 = 0, a2 = 0, a3 = 0, q = 0;
      for (let a = 0; a < n; a++) {
        const p = (a * sA + b * sX) * 4;
        const v0 = F[p], v1 = F[p + 1], v2 = F[p + 2], v3 = F[p + 3];
        a0 += v0; a1 += v1; a2 += v2; a3 += v3;
        q += v0 * v0 + v1 * v1 + v2 * v2 + v3 * v3;
        const k = o1 + (a + 1) * 4;
        S1[k] = a0; S1[k + 1] = a1; S1[k + 2] = a2; S1[k + 3] = a3;
        S2[o2 + a + 1] = q;
      }
    }
    return { n, L, S1, S2 };
  }

  function segSSE(sp, a, b) {
    if (b <= a) return 0;
    const len = b - a, n1 = sp.n + 1, S1 = sp.S1, S2 = sp.S2;
    let tot = 0;
    for (let li = 0; li < sp.L; li++) {
      const o1 = li * n1 * 4, o2 = li * n1, ka = o1 + a * 4, kb = o1 + b * 4;
      const d0 = S1[kb] - S1[ka], d1 = S1[kb + 1] - S1[ka + 1], d2 = S1[kb + 2] - S1[ka + 2], d3 = S1[kb + 3] - S1[ka + 3];
      tot += (S2[o2 + b] - S2[o2 + a]) - (d0 * d0 + d1 * d1 + d2 * d2 + d3 * d3) / len;
    }
    return tot;
  }

  function gridSSE(sp, bounds) {
    let t = 0;
    for (let k = 0; k + 1 < bounds.length; k++) t += segSSE(sp, bounds[k], bounds[k + 1]);
    return t;
  }

  // Variance de bruit typique : mediane des variances de segments opaques.
  function noiseVar(sp, bounds) {
    const vals = [];
    const n1 = sp.n + 1;
    for (let li = 0; li < sp.L; li++) {
      const o1 = li * n1 * 4, o2 = li * n1;
      for (let k = 0; k + 1 < bounds.length; k++) {
        const a = bounds[k], b = bounds[k + 1], len = b - a;
        if (len < 3) continue;
        const ka = o1 + a * 4, kb = o1 + b * 4;
        if (S1alpha(sp, kb) - S1alpha(sp, ka) < 255 * len) continue; // segment entierement opaque
        const d0 = sp.S1[kb] - sp.S1[ka], d1 = sp.S1[kb + 1] - sp.S1[ka + 1], d2 = sp.S1[kb + 2] - sp.S1[ka + 2], d3 = sp.S1[kb + 3] - sp.S1[ka + 3];
        const sse = (sp.S2[o2 + b] - sp.S2[o2 + a]) - (d0 * d0 + d1 * d1 + d2 * d2 + d3 * d3) / len;
        vals.push(sse / len);
      }
    }
    if (!vals.length) return 4;
    vals.sort((x, y) => x - y);
    return Math.max(4, vals[vals.length >> 1]);
  }
  function S1alpha(sp, k) { return sp.S1[k + 3]; }

  function makeLines(s, phi, n) {
    const b = [0], e = [0];
    for (let k = 0; ; k++) {
      const x = phi + k * s;
      const p = Math.round(x);
      if (p >= n) break;
      if (p <= 0 || p <= b[b.length - 1]) continue;
      b.push(p); e.push(x);
    }
    b.push(n); e.push(n);
    return { bounds: Int32Array.from(b), expect: Float64Array.from(e) };
  }

  function bestPhase(sp, s, n) {
    const step = Math.max(0.25, s / 40);
    let best = 0, bestC = Infinity;
    for (let phi = 0; phi < s - 1e-9; phi += step) {
      const c = gridSSE(sp, makeLines(s, phi, n).bounds);
      if (c < bestC) { bestC = c; best = phi; }
    }
    return best;
  }

  // Grille adaptative : chaque ligne est recalee dans +-s/3 autour de sa
  // position attendue en minimisant l'erreur d'approximation constante par
  // morceaux (equivaut a se caler sur le pic local des contours, et marche
  // aussi pour les rampes bilineaires).
  function snapLines(sp, bounds, expect, s, sigma2) {
    const len = bounds.length;
    if (len < 3) return;
    const r = Math.max(1, Math.round(s / 3));
    const minGap = Math.max(1, Math.floor(0.5 * s));
    const pen = 2 * sigma2 * sp.L;
    for (let pass = 0; pass < 3; pass++) {
      let changed = false;
      for (let k = 1; k < len - 1; k++) {
        const g = expect[k], a = bounds[k - 1], b = bounds[k + 1];
        const gl = k - 1 === 0 ? 1 : minGap, gr = k + 1 === len - 1 ? 1 : minGap;
        const lo = Math.max(Math.ceil(g - r), a + gl), hi = Math.min(Math.floor(g + r), b - gr);
        if (lo > hi) continue;
        let best = bounds[k], bestC = Infinity;
        for (let p = lo; p <= hi; p++) {
          const c = segSSE(sp, a, p) + segSSE(sp, p, b) + pen * Math.abs(p - g);
          if (c < bestC) { bestC = c; best = p; }
        }
        if (best !== bounds[k]) { bounds[k] = best; changed = true; }
      }
      if (!changed) break;
    }
  }

  function slopeOf(bounds) {
    const len = bounds.length;
    if (len < 5) return 0;
    let n = 0, sk = 0, sx = 0, skk = 0, skx = 0;
    for (let k = 1; k < len - 1; k++) {
      n++; sk += k; sx += bounds[k]; skk += k * k; skx += k * bounds[k];
    }
    const den = n * skk - sk * sk;
    return den > 0 ? (n * skx - sk * sx) / den : 0;
  }

  function fitAxis(F, n, m, sA, sX, s, offset, o) {
    const sp = makeSampler(F, n, m, sA, sX, 160);
    const phase = offset !== null && offset !== undefined && offset !== ''
      ? ((Number(offset) % s) + s) % s
      : bestPhase(sp, s, n);
    const lines = makeLines(s, phase, n);
    const bounds = lines.bounds;
    if (o.adaptive) snapLines(sp, bounds, lines.expect, s, noiseVar(sp, bounds));
    // bandes partielles au bord (< 1/2 pixel) : ignorees ; decision prise
    // sur la grille globale (un bord invisible ne doit pas la faire varier)
    const len = bounds.length, ex = lines.expect;
    let c0 = 0, c1 = len - 1;
    if (c1 - c0 > 1 && ex[1] < 0.5 * s) c0 = 1;
    if (c1 - c0 > 1 && n - ex[len - 2] < 0.5 * s) c1 = len - 2;
    return { bounds, c0, c1, phase, slope: slopeOf(bounds), lines: len - 2 };
  }

  function axisAlignment(img, mask) {
    const W = img.width, H = img.height, d = img.data;
    const lum = (i) => mask[i] ? 0.3 * d[i * 4] + 0.59 * d[i * 4 + 1] + 0.11 * d[i * 4 + 2] : 0;
    const step = Math.max(1, Math.round(Math.sqrt(W * H / 250000)));
    let num = 0, den = 0;
    for (let y = 1; y < H - 1; y += step) {
      for (let x = 1; x < W - 1; x += step) {
        const i = y * W + x, gx = lum(i + 1) - lum(i - 1), gy = lum(i + W) - lum(i - W), m2 = gx * gx + gy * gy;
        if (m2 < 400) continue;
        num += 2 * Math.abs(gx * gy); den += m2;
      }
    }
    return den > 0 ? num / den : 0;
  }

  function detectGrid(img, mask, opts, bg) {
    const o = withDefaults(opts);
    const W = img.width, H = img.height;
    const F = buildFeatures(img, mask, bg);
    let size = Number(o.pixelSize) || 0, type = 0, confidence = 1;
    const manual = size > 0;
    if (!manual) {
      // axe vertical calcule sur une copie transposee (acces memoire contigus)
      const FT = new Float32Array(F.length);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const p = (y * W + x) * 4, q = (x * H + y) * 4;
        FT[q] = F[p]; FT[q + 1] = F[p + 1]; FT[q + 2] = F[p + 2]; FT[q + 3] = F[p + 3];
      }
      const prof = [axisProfiles(F, W, H, 1, W), axisProfiles(FT, H, W, 1, H)];
      const ranges = [activeRange(mask, W, H, 0), activeRange(mask, W, H, 1)];
      const est = estimatePeriod(prof, ranges, [W, H], o);
      size = est.size; type = est.type; confidence = est.confidence;
    }
    // Confiance "grille de pixels" : nettete du pic de periode, penalisee
    // si les bords ne sont pas alignes sur les axes (le pixel art n'a que des
    // bords horizontaux / verticaux, une illustration lisse en a dans tous les sens).
    const axisAlign = manual ? 0 : axisAlignment(img, mask);
    const score = manual ? Infinity : confidence - 10 * axisAlign;
    size = Math.max(1, size);
    const gx = fitAxis(F, W, H, 1, W, size, o.offsetX, o);
    const gy = fitAxis(F, H, W, W, 1, size, o.offsetY, o);
    let measured = size;
    if (!manual) {
      const wx = gx.slope > 0 ? gx.lines : 0, wy = gy.slope > 0 ? gy.lines : 0;
      if (wx + wy > 0) measured = (gx.slope * wx + gy.slope * wy) / (wx + wy);
      if (!(Math.abs(measured - size) < 0.1 * size)) measured = size;
    }
    return {
      size: measured, baseSize: size, manual, profileType: type, confidence, axisAlign, score,
      confident: manual || score >= GRID_MIN_SCORE,
      offsetX: gx.phase, offsetY: gy.phase,
      xs: gx.bounds, ys: gy.bounds,
      cx0: gx.c0, cx1: gx.c1, cy0: gy.c0, cy1: gy.c1,
      nx: gx.c1 - gx.c0, ny: gy.c1 - gy.c0,
    };
  }

  // ------------------------------------------------- statistiques de cellule

  function innerRange(a, b, margin) {
    const m = margin * (b - a);
    let lo = Math.ceil(a + m - 0.5), hi = Math.floor(b - m - 0.5);
    if (lo > hi) { lo = hi = Math.floor((a + b - 1) / 2); }
    return [lo, hi + 1];
  }

  function innerRanges(bounds, c0, c1, margin) {
    const r = new Int32Array((c1 - c0) * 2);
    for (let i = c0; i < c1; i++) {
      const q = innerRange(bounds[i], bounds[i + 1], margin);
      r[(i - c0) * 2] = q[0]; r[(i - c0) * 2 + 1] = q[1];
    }
    return r;
  }

  function median(buf, n) {
    const a = buf.subarray(0, n).slice().sort();
    return n & 1 ? a[n >> 1] : 0.5 * (a[(n >> 1) - 1] + a[n >> 1]);
  }

  function cellStats(img, mask, grid, o) {
    const W = img.width, d = img.data;
    const nx = grid.nx, ny = grid.ny;
    const inX = innerRanges(grid.xs, grid.cx0, grid.cx1, o.margin);
    const inY = innerRanges(grid.ys, grid.cy0, grid.cy1, o.margin);
    // couleur representative : zone centrale plus etroite (moins de melange
    // avec les voisins sur les bords flous / rampes bilineaires)
    const cm = Math.max(o.margin, 0.38);
    const ceX = innerRanges(grid.xs, grid.cx0, grid.cx1, cm), ceY = innerRanges(grid.ys, grid.cy0, grid.cy1, cm);
    let maxW = 1, maxH = 1;
    for (let i = 0; i < nx; i++) maxW = Math.max(maxW, inX[i * 2 + 1] - inX[i * 2]);
    for (let j = 0; j < ny; j++) maxH = Math.max(maxH, inY[j * 2 + 1] - inY[j * 2]);
    const cap = maxW * maxH;
    const bL = new Float32Array(cap), bA = new Float32Array(cap), bB = new Float32Array(cap);
    const cL = new Float32Array(cap), cA = new Float32Array(cap), cB = new Float32Array(cap);
    const opaque = new Uint8Array(nx * ny), rep = new Float32Array(nx * ny * 3);
    const lab = new Float64Array(3);
    for (let j = 0; j < ny; j++) {
      const y0 = inY[j * 2], y1 = inY[j * 2 + 1];
      for (let i = 0; i < nx; i++) {
        const x0 = inX[i * 2], x1 = inX[i * 2 + 1];
        const qx0 = ceX[i * 2], qx1 = ceX[i * 2 + 1], qy0 = ceY[j * 2], qy1 = ceY[j * 2 + 1];
        let no = 0, nt = 0, nc = 0;
        for (let y = y0; y < y1; y++) {
          const cy = y >= qy0 && y < qy1;
          for (let x = x0; x < x1; x++) {
            const k = y * W + x;
            if (mask[k]) {
              const p = k * 4;
              rgbToLab(d[p], d[p + 1], d[p + 2], lab, 0);
              bL[no] = lab[0]; bA[no] = lab[1]; bB[no] = lab[2]; no++;
              if (cy && x >= qx0 && x < qx1) { cL[nc] = lab[0]; cA[nc] = lab[1]; cB[nc] = lab[2]; nc++; }
            } else nt++;
          }
        }
        const c = j * nx + i;
        if (no > nt) {
          opaque[c] = 1;
          if (nc > 0) { rep[c * 3] = median(cL, nc); rep[c * 3 + 1] = median(cA, nc); rep[c * 3 + 2] = median(cB, nc); }
          else { rep[c * 3] = median(bL, no); rep[c * 3 + 1] = median(bA, no); rep[c * 3 + 2] = median(bB, no); }
        }
      }
    }
    return { nx, ny, opaque, rep, inX, inY };
  }

  // Modele "bilineaire" au niveau des cellules : moyenne interieure
  // m = w0*c + somme(w_voisin * c_voisin). Si ce modele explique mieux les
  // pixels que des cellules plates, on deconvolue les couleurs (Jacobi) pour
  // que la palette soit construite sur des couleurs pures.
  const NB = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]];
  function bilinearCells(img, mask, grid, cells) {
    const W = img.width, d = img.data;
    const { nx, ny, inX, inY, opaque } = cells;
    const N = nx * ny;
    cells.model = 'flat';
    if (nx < 3 || ny < 3) return;
    const cx = new Float64Array(nx), sx = new Float64Array(nx), cy = new Float64Array(ny), sy = new Float64Array(ny);
    for (let i = 0; i < nx; i++) { const a = grid.xs[grid.cx0 + i], b = grid.xs[grid.cx0 + i + 1]; cx[i] = (a + b) / 2; sx[i] = b - a; }
    for (let j = 0; j < ny; j++) { const a = grid.ys[grid.cy0 + j], b = grid.ys[grid.cy0 + j + 1]; cy[j] = (a + b) / 2; sy[j] = b - a; }
    const m = new Float64Array(N * 3), wt = new Float64Array(N * 9), cnt = new Float64Array(N);
    let flatRes = 0;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const c = j * nx + i;
      if (!opaque[c]) continue;
      let s0 = 0, s1 = 0, s2 = 0, q = 0, n = 0;
      for (let y = inY[j * 2]; y < inY[j * 2 + 1]; y++) {
        const v = (y + 0.5 - cy[j]) / sy[j], wy = Math.min(0.5, Math.abs(v)), dv = v >= 0 ? 1 : 0;
        for (let x = inX[i * 2]; x < inX[i * 2 + 1]; x++) {
          const k = y * W + x;
          if (!mask[k]) continue;
          const p = k * 4, u = (x + 0.5 - cx[i]) / sx[i], wx = Math.min(0.5, Math.abs(u)), du = u >= 0 ? 1 : 0;
          s0 += d[p]; s1 += d[p + 1]; s2 += d[p + 2]; q += d[p] * d[p] + d[p + 1] * d[p + 1] + d[p + 2] * d[p + 2]; n++;
          const o = c * 9;
          wt[o] += (1 - wx) * (1 - wy);
          wt[o + 1 + du] += wx * (1 - wy);            // gauche / droite
          wt[o + 3 + dv] += (1 - wx) * wy;            // haut / bas
          wt[o + 5 + du + 2 * dv] += wx * wy;         // diagonales
        }
      }
      if (!n) continue;
      cnt[c] = n;
      m[c * 3] = s0 / n; m[c * 3 + 1] = s1 / n; m[c * 3 + 2] = s2 / n;
      flatRes += q - (s0 * s0 + s1 * s1 + s2 * s2) / n;
      for (let t = 0; t < 9; t++) wt[c * 9 + t] /= n;
    }
    const nbIndex = (i, j, t) => {
      const ii = i + NB[t][0], jj = j + NB[t][1];
      if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) return -1;
      const c = jj * nx + ii;
      return opaque[c] && cnt[c] ? c : -1;
    };
    // deconvolution (Jacobi)
    let col = Float64Array.from(m);
    for (let it = 0; it < 8; it++) {
      const nxt = new Float64Array(N * 3);
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const c = j * nx + i;
        if (!cnt[c]) continue;
        let w0 = wt[c * 9];
        let a0 = m[c * 3], a1 = m[c * 3 + 1], a2 = m[c * 3 + 2];
        for (let t = 0; t < 8; t++) {
          const w = wt[c * 9 + 1 + t], nbc = nbIndex(i, j, t);
          if (!w) continue;
          if (nbc < 0) { w0 += w; continue; }
          a0 -= w * col[nbc * 3]; a1 -= w * col[nbc * 3 + 1]; a2 -= w * col[nbc * 3 + 2];
        }
        nxt[c * 3] = Math.max(0, Math.min(255, a0 / w0));
        nxt[c * 3 + 1] = Math.max(0, Math.min(255, a1 / w0));
        nxt[c * 3 + 2] = Math.max(0, Math.min(255, a2 / w0));
      }
      col = nxt;
    }
    // residu du modele bilineaire
    let bilRes = 0;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const c = j * nx + i;
      if (!cnt[c]) continue;
      for (let y = inY[j * 2]; y < inY[j * 2 + 1]; y++) {
        const v = (y + 0.5 - cy[j]) / sy[j], wy = Math.min(0.5, Math.abs(v)), dv = v >= 0 ? 1 : 0;
        for (let x = inX[i * 2]; x < inX[i * 2 + 1]; x++) {
          const k = y * W + x;
          if (!mask[k]) continue;
          const p = k * 4, u = (x + 0.5 - cx[i]) / sx[i], wx = Math.min(0.5, Math.abs(u)), du = u >= 0 ? 1 : 0;
          const tl = [[c, (1 - wx) * (1 - wy)], [nbIndex(i, j, du), wx * (1 - wy)], [nbIndex(i, j, 2 + dv), (1 - wx) * wy], [nbIndex(i, j, 4 + du + 2 * dv), wx * wy]];
          let e0 = 0, e1 = 0, e2 = 0;
          for (const [cc, w] of tl) {
            const src = cc < 0 ? c : cc;
            e0 += w * col[src * 3]; e1 += w * col[src * 3 + 1]; e2 += w * col[src * 3 + 2];
          }
          const q0 = d[p] - e0, q1 = d[p + 1] - e1, q2 = d[p + 2] - e2;
          bilRes += q0 * q0 + q1 * q1 + q2 * q2;
        }
      }
    }
    if (!(bilRes < 0.85 * flatRes)) return;
    cells.model = 'bilinear';
    const lab = new Float64Array(3);
    for (let c = 0; c < N; c++) {
      if (!cnt[c]) continue;
      rgbToLab(Math.round(col[c * 3]), Math.round(col[c * 3 + 1]), Math.round(col[c * 3 + 2]), lab, 0);
      cells.rep[c * 3] = lab[0]; cells.rep[c * 3 + 1] = lab[1]; cells.rep[c * 3 + 2] = lab[2];
    }
  }

  // ------------------------------------- grille reguliere (taille cible)
  // Pour les images sans grille de pixels (illustration, peinture, 3D...) :
  // grille reguliere calee sur la boite englobante du sujet, lissage qui
  // preserve les bords (Kuwahara) pour aplatir les ombrages, detection des
  // traits sombres fins (fermeture - image) qui gagnent le vote.

  function sat(src, w, h) {
    const W1 = w + 1, S = new Float64Array(W1 * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) {
        row += src[y * w + x];
        S[(y + 1) * W1 + x + 1] = S[y * W1 + x + 1] + row;
      }
    }
    return S;
  }

  // Kuwahara pondere par la couverture : chaque pixel prend la moyenne du
  // quadrant (sur 4) le plus homogene -> aplats, bords conserves.
  function kuwahara(rgb, cov, w, h, r) {
    const N = w * h, W1 = w + 1;
    const ch = [cov];
    for (let c = 0; c < 3; c++) {
      const a = new Float64Array(N), b = new Float64Array(N);
      for (let i = 0; i < N; i++) { const v = rgb[i * 3 + c]; a[i] = cov[i] * v; b[i] = cov[i] * v * v; }
      ch.push(a, b);
    }
    const S = ch.map((a) => sat(a, w, h));
    const rect = (k, x0, y0, x1, y1) => S[k][y1 * W1 + x1] - S[k][y0 * W1 + x1] - S[k][y1 * W1 + x0] + S[k][y0 * W1 + x0];
    const out = new Float32Array(N * 3);
    const m = [0, 0, 0];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        let bestV = Infinity, b0 = rgb[i * 3], b1 = rgb[i * 3 + 1], b2 = rgb[i * 3 + 2];
        for (let qd = 0; qd < 4; qd++) {
          const xa = qd & 1 ? x : Math.max(0, x - r), xb = qd & 1 ? Math.min(w, x + r + 1) : x + 1;
          const ya = qd & 2 ? y : Math.max(0, y - r), yb = qd & 2 ? Math.min(h, y + r + 1) : y + 1;
          const sw = rect(0, xa, ya, xb, yb);
          if (sw < 0.5 * (xb - xa) * (yb - ya)) continue;
          let v = 0;
          for (let c = 0; c < 3; c++) {
            m[c] = rect(1 + 2 * c, xa, ya, xb, yb) / sw;
            v += rect(2 + 2 * c, xa, ya, xb, yb) / sw - m[c] * m[c];
          }
          if (v < bestV) { bestV = v; b0 = m[0]; b1 = m[1]; b2 = m[2]; }
        }
        out[i * 3] = b0; out[i * 3 + 1] = b1; out[i * 3 + 2] = b2;
      }
    }
    return out;
  }

  // filtre max/min separable (carre de rayon r)
  function rankFilter(src, w, h, r, isMax) {
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = src[y * w + x];
        const k1 = Math.min(w - 1, x + r);
        for (let k = Math.max(0, x - r); k <= k1; k++) { const u = src[y * w + k]; if (isMax ? u > v : u < v) v = u; }
        tmp[y * w + x] = v;
      }
    }
    for (let y = 0; y < h; y++) {
      const k1 = Math.min(h - 1, y + r);
      for (let x = 0; x < w; x++) {
        let v = tmp[y * w + x];
        for (let k = Math.max(0, y - r); k <= k1; k++) { const u = tmp[k * w + x]; if (isMax ? u > v : u < v) v = u; }
        out[y * w + x] = v;
      }
    }
    return out;
  }

  function analyzeTarget(img, mask, o) {
    const W = img.width, H = img.height, d = img.data;
    let bx0 = W, by0 = H, bx1 = -1, by1 = -1;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!mask[y * W + x]) continue;
        if (x < bx0) bx0 = x;
        if (x > bx1) bx1 = x;
        if (y < by0) by0 = y;
        if (y > by1) by1 = y;
      }
    }
    if (bx1 < 0) { bx0 = 0; by0 = 0; bx1 = W - 1; by1 = H - 1; }
    // Tuile : la grille part du coin de l'image (et non du sujet), pour que
    // les bords des cases tombent sur les bords de la tuile (raccords).
    if (o.tileable) { bx0 = 0; by0 = 0; bx1 = W - 1; by1 = H - 1; }
    const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
    let nx, ny;
    if (o.targetBy === 'factor') {
      const f = Math.max(1, Number(o.targetFactor) || 8);
      ny = Math.max(1, Math.round(bh / f)); nx = Math.max(1, Math.round(bw / f));
    } else {
      // boite H x L (L facultative), proportions gardees, jamais d'agrandissement
      const th = Math.round(Number(o.targetHeight) || 0), tw = Math.round(Number(o.targetWidth) || 0);
      let f;
      if (th > 0 && tw > 0) f = Math.max(bh / th, bw / tw);
      else if (tw > 0) f = bw / tw;
      else f = bh / (th > 0 ? th : 32);
      f = Math.max(1, f);
      ny = Math.max(1, Math.round(bh / f)); nx = Math.max(1, Math.round(bw / f));
      if (th > 0) ny = Math.min(ny, th);
      if (tw > 0) nx = Math.min(nx, tw);
    }
    const fx = bw / nx, fy = bh / ny;
    // reduction prealable (moyenne par aire) : ~8 px de travail par cellule
    const q = Math.max(1, Math.floor(Math.min(fx, fy) / 8));
    const ww = Math.ceil(bw / q), wh = Math.ceil(bh / q), N = ww * wh;
    const acc = new Float64Array(N * 3), na = new Float64Array(N), nn = new Float64Array(N);
    for (let y = by0; y <= by1; y++) {
      const ty = ((y - by0) / q) | 0;
      for (let x = bx0; x <= bx1; x++) {
        const t = ty * ww + (((x - bx0) / q) | 0), k = y * W + x;
        nn[t]++;
        if (mask[k]) { na[t]++; acc[t * 3] += d[k * 4]; acc[t * 3 + 1] += d[k * 4 + 1]; acc[t * 3 + 2] += d[k * 4 + 2]; }
      }
    }
    const rgb = new Float32Array(N * 3), cov = new Float32Array(N);
    for (let t = 0; t < N; t++) {
      cov[t] = nn[t] ? na[t] / nn[t] : 0;
      if (na[t]) { rgb[t * 3] = acc[t * 3] / na[t]; rgb[t * 3 + 1] = acc[t * 3 + 1] / na[t]; rgb[t * 3 + 2] = acc[t * 3 + 2] / na[t]; }
    }
    const fe = Math.min(fx, fy) / q;
    const smooth = kuwahara(rgb, cov, ww, wh, Math.max(1, Math.round(fe / 4)));
    // traits sombres fins : fermeture(L) - L (le transparent compte comme clair)
    const L = new Float32Array(N), lab = new Float64Array(3), labs = new Float32Array(N * 3);
    for (let t = 0; t < N; t++) {
      if (cov[t] < 0.5) { L[t] = 1; continue; }
      rgbToLab(Math.round(smooth[t * 3]), Math.round(smooth[t * 3 + 1]), Math.round(smooth[t * 3 + 2]), lab, 0);
      L[t] = lab[0]; labs[t * 3] = lab[0]; labs[t * 3 + 1] = lab[1]; labs[t * 3 + 2] = lab[2];
    }
    const rt = Math.max(2, Math.round(fe * 0.5));
    const closing = rankFilter(rankFilter(L, ww, wh, rt, true), ww, wh, rt, false);
    const stroke = new Float32Array(N);
    for (let t = 0; t < N; t++) if (cov[t] >= 0.5) stroke[t] = Math.max(0, closing[t] - L[t]);
    // cellules (coordonnees de travail)
    const cxs = new Int32Array(nx + 1), cys = new Int32Array(ny + 1);
    for (let i = 0; i <= nx; i++) cxs[i] = Math.min(ww, Math.max(0, Math.ceil(i * fx / q - 0.5)));
    for (let j = 0; j <= ny; j++) cys[j] = Math.min(wh, Math.max(0, Math.ceil(j * fy / q - 0.5)));
    const opaque = new Uint8Array(nx * ny);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        let c = 0, n = 0;
        const y1 = Math.min(wh, Math.max(cys[j] + 1, cys[j + 1])), x1 = Math.min(ww, Math.max(cxs[i] + 1, cxs[i + 1]));
        for (let y = cys[j]; y < y1; y++) for (let x = cxs[i]; x < x1; x++) { c += cov[y * ww + x]; n++; }
        opaque[j * nx + i] = n && c / n >= 0.5 ? 1 : 0; // alpha par couverture
      }
    }
    // echantillon pour la palette
    let nOp = 0;
    for (let t = 0; t < N; t++) if (cov[t] >= 0.5) nOp++;
    const want = Math.min(30000, Math.max(2000, nx * ny * 6));
    const step = Math.max(1, Math.floor(nOp / want));
    const samp = [];
    let k = 0;
    for (let t = 0; t < N; t++) {
      if (cov[t] < 0.5) continue;
      if (k++ % step) continue;
      samp.push(labs[t * 3], labs[t * 3 + 1], labs[t * 3 + 2]);
    }
    const xs = new Float64Array(nx + 1), ys = new Float64Array(ny + 1);
    for (let i = 0; i <= nx; i++) xs[i] = bx0 + i * fx;
    for (let j = 0; j <= ny; j++) ys[j] = by0 + j * fy;
    return {
      grid: { size: Math.min(fx, fy), nx, ny, displayXs: xs, displayYs: ys, bbox: [bx0, by0, bw, bh] },
      cells: { nx, ny, opaque, model: 'target' },
      target: { ww, wh, q, labs, cov, stroke, cxs, cys, ink: o.inkLines === false ? null : inkAnalysis(ww, wh, cov, labs, stroke, !!o.tileable) },
      samples: Float32Array.from(samp),
    };
  }

  // ------------------------------------------------- traits d'encre (contours)
  // Les images IA ont des contours sombres de plusieurs pixels de large, plus
  // ou moins baveux. Un vote par cellule les rendait en points noirs epars
  // (trait a cheval sur deux cellules : aucune ne le garde, ou les deux) et
  // un contour exterieur impose ("Contour propre") en dessinait la ou
  // l'original n'en a pas. Ici on part des traits REELS de l'original :
  //  - encre = pixel sombre ET plus sombre que ses voisins (creux sous la
  //    fermeture, `stroke`) : un aplat sombre (cheveux noirs, cape) n'en est pas ;
  //  - squelette (amincissement de Zhang-Suen) : une ligne continue de
  //    l'original donne une chaine continue de cellules, d'1 pixel ;
  //  - contour de la silhouette traite a part : une cellule du bord devient
  //    encre si les pixels du bord de l'original, autour d'elle, sont encres ;
  //    le squelette de ce meme contour (juste a l'interieur) est ignore, sinon
  //    il doublait le trait.
  const INK_STROKE = 0.06;  // creux mini sous la fermeture (L OKLab)
  const INK_MAX_L = 0.45;   // L OKLab maxi d'un trait d'encre
  const INK_MIN_AREA = 0.004; // part mini d'encre dans le sujet, sinon rien (image sans contours)

  function inkAnalysis(ww, wh, cov, labs, stroke, tileable) {
    const N = ww * wh;
    const ink = new Uint8Array(N);
    let nInk = 0, nOp = 0;
    for (let t = 0; t < N; t++) {
      if (cov[t] < 0.5) continue;
      nOp++;
      if (stroke[t] >= INK_STROKE && labs[t * 3] <= INK_MAX_L) { ink[t] = 1; nInk++; }
    }
    if (!nOp || nInk < INK_MIN_AREA * nOp) return null;
    removeSmallComponents(ink, ww, wh, 4);
    const skel = thinZhangSuen(ink, ww, wh);
    let area = 0, len = 0;
    for (let t = 0; t < N; t++) { area += ink[t]; len += skel[t]; }
    if (!len) return null;
    const width = area / len;
    const dist = distanceToTransparent(cov, ww, wh, tileable);
    // encre "proche" : pour juger si le bord de la silhouette est encre
    const near = dilate(ink, ww, wh, Math.max(1, Math.round(width / 2)));
    return { ink, skel, dist, near, width, tileable };
  }

  function removeSmallComponents(m, w, h, minSize) {
    const seen = new Uint8Array(w * h), stack = [], comp = [];
    for (let s = 0; s < w * h; s++) {
      if (!m[s] || seen[s]) continue;
      stack.push(s); seen[s] = 1; comp.length = 0;
      while (stack.length) {
        const t = stack.pop(); comp.push(t);
        const x = t % w, y = (t / w) | 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const u = yy * w + xx;
          if (m[u] && !seen[u]) { seen[u] = 1; stack.push(u); }
        }
      }
      if (comp.length < minSize) for (const t of comp) m[t] = 0;
    }
  }

  function thinZhangSuen(m, w, h) {
    const a = Uint8Array.from(m);
    const P = (x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? 0 : a[y * w + x];
    const del = [];
    for (let changed = true; changed;) {
      changed = false;
      for (let step = 0; step < 2; step++) {
        del.length = 0;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            if (!a[y * w + x]) continue;
            const p2 = P(x, y - 1), p3 = P(x + 1, y - 1), p4 = P(x + 1, y), p5 = P(x + 1, y + 1);
            const p6 = P(x, y + 1), p7 = P(x - 1, y + 1), p8 = P(x - 1, y), p9 = P(x - 1, y - 1);
            const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
            if (B < 2 || B > 6) continue;
            const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
            let A = 0;
            for (let k = 0; k < 8; k++) if (!seq[k] && seq[k + 1]) A++;
            if (A !== 1) continue;
            if (step === 0 ? (p2 && p4 && p6) || (p4 && p6 && p8) : (p2 && p4 && p8) || (p2 && p6 && p8)) continue;
            del.push(y * w + x);
          }
        }
        for (const i of del) a[i] = 0;
        if (del.length) changed = true;
      }
    }
    return a;
  }

  // Distance (8-voisins, en px de travail) au plus proche pixel transparent ;
  // le dehors de l'image compte comme transparent, sauf pour une tuile (le sol
  // continue dans la case voisine : pas de contour sur les bords de l'image).
  function distanceToTransparent(cov, w, h, outsideOpaque) {
    const N = w * h, d = new Int32Array(N).fill(-1), queue = new Int32Array(N);
    let qh = 0, qt = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const t = y * w + x;
        if (cov[t] < 0.5) { d[t] = 0; continue; }
        if (!outsideOpaque && (x === 0 || y === 0 || x === w - 1 || y === h - 1)) { d[t] = 1; queue[qt++] = t; }
      }
    }
    for (let t = 0; t < N; t++) {
      if (d[t] !== 0) continue;
      const x = t % w, y = (t / w) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const u = yy * w + xx;
        if (d[u] < 0) { d[u] = 1; queue[qt++] = u; }
      }
    }
    while (qh < qt) {
      const t = queue[qh++], x = t % w, y = (t / w) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const u = yy * w + xx;
        if (d[u] < 0) { d[u] = d[t] + 1; queue[qt++] = u; }
      }
    }
    // tuile pleine : aucun pixel transparent, tout est loin du bord
    for (let t = 0; t < N; t++) if (d[t] < 0) d[t] = 1 << 30;
    return d;
  }

  function dilate(m, w, h, r) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!m[y * w + x]) continue;
        for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++) {
          for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) out[yy * w + xx] = 1;
        }
      }
    }
    return out;
  }

  function voteTarget(analysis, palette) {
    if (analysis.target.ink) return voteTargetInk(analysis, palette);
    const { ww, wh, labs, cov, stroke, cxs, cys } = analysis.target;
    const { nx, ny, opaque } = analysis.cells;
    const K = palette.size, pl = palette.lab;
    const idx = new Int16Array(nx * ny).fill(-1);
    const votes = new Float64Array(K), sv = new Float64Array(K);
    for (let j = 0; j < ny; j++) {
      const y0 = cys[j], y1 = Math.min(wh, Math.max(cys[j] + 1, cys[j + 1])), cy = (y0 + y1) / 2, hy = Math.max(0.5, (y1 - y0) / 2);
      for (let i = 0; i < nx; i++) {
        const c = j * nx + i;
        if (!opaque[c]) continue;
        const x0 = cxs[i], x1 = Math.min(ww, Math.max(cxs[i] + 1, cxs[i + 1])), cx = (x0 + x1) / 2, hx = Math.max(0.5, (x1 - x0) / 2);
        votes.fill(0); sv.fill(0);
        let nOp = 0, nSt = 0;
        for (let y = y0; y < y1; y++) {
          const wy = 1 - 0.5 * Math.min(1, Math.abs(y + 0.5 - cy) / hy);
          for (let x = x0; x < x1; x++) {
            const t = y * ww + x;
            if (cov[t] < 0.5) continue;
            const p = nearestIndex(labs[t * 3], labs[t * 3 + 1], labs[t * 3 + 2], pl, K);
            const wx = 1 - 0.5 * Math.min(1, Math.abs(x + 0.5 - cx) / hx);
            votes[p] += wx * wy; nOp++;
            if (stroke[t] >= STROKE_MIN) { sv[p] += stroke[t]; nSt++; }
          }
        }
        if (!nOp) continue;
        // un trait sombre fin qui traverse la cellule gagne (sinon il disparait)
        const src = nSt >= Math.max(1, 0.15 * nOp) ? sv : votes;
        let best = 0;
        for (let q = 1; q < K; q++) if (src[q] > src[best]) best = q;
        idx[c] = best;
      }
    }
    return idx;
  }

  // Vote avec les traits d'encre de l'original (cf. inkAnalysis) : une
  // cellule est encre si le squelette d'un trait interieur la traverse, ou,
  // au bord de la silhouette, si l'original y a un contour ; sa couleur est
  // celle de l'encre (vote sur les pixels d'encre seuls : un contour brun reste
  // brun). Les autres cellules votent SANS les pixels d'encre : un trait non
  // retenu ne salit plus la couleur voisine.
  function voteTargetInk(analysis, palette) {
    const { ww, wh, labs, cov, cxs, cys, ink } = analysis.target;
    const { nx, ny, opaque } = analysis.cells;
    const K = palette.size, pl = palette.lab;
    const idx = new Int16Array(nx * ny).fill(-1);
    const votes = new Float64Array(K), iv = new Float64Array(K);
    // bande du contour de silhouette : son squelette est a ~ largeur/2 du bord
    const band = Math.max(2, Math.ceil(ink.width * 1.5) + 1);
    const isOp = (i, j) => (i < 0 || j < 0 || i >= nx || j >= ny) ? !!ink.tileable : !!opaque[j * nx + i];
    // bord de silhouette de l'original, encre ou non, par cellule
    const edgeN = new Float64Array(nx * ny), edgeInk = new Float64Array(nx * ny);
    const cellOf = (b, n, v) => { let k = 0; while (k < n - 1 && b[k + 1] <= v) k++; return k; };
    const colOf = new Int32Array(ww), rowOf = new Int32Array(wh);
    for (let x = 0; x < ww; x++) colOf[x] = cellOf(cxs, nx, x);
    for (let y = 0; y < wh; y++) rowOf[y] = cellOf(cys, ny, y);
    // Couleur d'encre par cellule, cellules transparentes comprises : le
    // contour de l'original tombe souvent dans la cellule du dehors (restee
    // transparente) ; la cellule du bord, elle, n'a alors aucun pixel d'encre
    // et prendrait la couleur la plus sombre de l'interieur (vert de cape...).
    const inkVotes = new Float64Array(nx * ny * K);
    for (let y = 0; y < wh; y++) {
      for (let x = 0; x < ww; x++) {
        const t = y * ww + x;
        const c = rowOf[y] * nx + colOf[x];
        if (ink.ink[t] && cov[t] >= 0.5) inkVotes[c * K + nearestIndex(labs[t * 3], labs[t * 3 + 1], labs[t * 3 + 2], pl, K)]++;
        if (ink.dist[t] !== 1) continue;
        edgeN[c]++;
        if (ink.near[t]) edgeInk[c]++;
      }
    }
    const nearInkColor = (i, j) => {
      let best = -1, bv = 0;
      for (let q = 0; q < K; q++) {
        let v = 0;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
          v += inkVotes[(jj * nx + ii) * K + q] * (di || dj ? 1 : 4);
        }
        if (v > bv) { bv = v; best = q; }
      }
      return best;
    };
    for (let j = 0; j < ny; j++) {
      const y0 = cys[j], y1 = Math.min(wh, Math.max(cys[j] + 1, cys[j + 1])), cy = (y0 + y1) / 2, hy = Math.max(0.5, (y1 - y0) / 2);
      for (let i = 0; i < nx; i++) {
        const c = j * nx + i;
        if (!opaque[c]) continue;
        const x0 = cxs[i], x1 = Math.min(ww, Math.max(cxs[i] + 1, cxs[i + 1])), cx = (x0 + x1) / 2, hx = Math.max(0.5, (x1 - x0) / 2);
        votes.fill(0); iv.fill(0);
        let nOp = 0, nInk = 0, sk = 0;
        for (let y = y0; y < y1; y++) {
          const wy = 1 - 0.5 * Math.min(1, Math.abs(y + 0.5 - cy) / hy);
          for (let x = x0; x < x1; x++) {
            const t = y * ww + x;
            if (cov[t] < 0.5) continue;
            const p = nearestIndex(labs[t * 3], labs[t * 3 + 1], labs[t * 3 + 2], pl, K);
            const wx = 1 - 0.5 * Math.min(1, Math.abs(x + 0.5 - cx) / hx);
            if (ink.ink[t]) { iv[p] += 1; nInk++; } else { votes[p] += wx * wy; nOp++; }
            if (ink.skel[t] && ink.dist[t] > band) sk++;
          }
        }
        if (!nOp && !nInk) continue;
        const border = !isOp(i - 1, j) || !isOp(i + 1, j) || !isOp(i, j - 1) || !isOp(i, j + 1);
        // le trait doit TRAVERSER la cellule (longueur ~ un tiers de la cellule) :
        // un coin rogne en passant doublait les traits en escalier
        let inked = sk >= Math.max(1, 0.35 * Math.min(x1 - x0, y1 - y0));
        if (border) {
          // contour de la silhouette : bord de l'original encre autour de la cellule
          let n = 0, e = 0;
          for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
            const ii = i + di, jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
            n += edgeN[jj * nx + ii]; e += edgeInk[jj * nx + ii];
          }
          inked = n > 0 ? e >= 0.5 * n : inked;
        }
        let best = -1;
        if (inked) {
          // encre de la cellule et de ses voisines (la sienne compte 4 fois)
          best = nearInkColor(i, j);
          if (best < 0) best = darkestOf(votes, pl, K);
        } else {
          for (let q = 0; q < K; q++) if (votes[q] > 0 && (best < 0 || votes[q] > votes[best])) best = q;
          if (best < 0) for (let q = 0; q < K; q++) if (iv[q] > 0 && (best < 0 || iv[q] > iv[best])) best = q;
        }
        idx[c] = best;
      }
    }
    return idx;
  }

  function darkestOf(votes, pl, K) {
    let best = -1;
    for (let q = 0; q < K; q++) if (votes[q] > 0 && (best < 0 || pl[q * 3] < pl[best * 3])) best = q;
    return best < 0 ? 0 : best;
  }

  function countColors(img, mask, max) {
    const seen = new Set(), d = img.data;
    for (let i = 0; i < img.width * img.height; i++) {
      if (!mask[i]) continue;
      seen.add((d[i * 4] << 16) | (d[i * 4 + 1] << 8) | d[i * 4 + 2]);
      if (seen.size > max) break;
    }
    return seen.size;
  }

  // Pipeline unique : la detection de grille fixe seulement la grille de
  // sortie. Grille fiable -> cellules = grille detectee ; image deja en
  // pixel art natif -> 1 pixel = 1 cellule ; sinon -> grille reguliere
  // calculee depuis la taille cible.
  // Part des cellules qui contiennent plusieurs couleurs exactes (une image
  // propre agrandie au plus proche voisin a des cellules uniformes).
  function mixedCells(img, mask, g) {
    const W = img.width, d = img.data;
    let mixed = 0, tot = 0;
    for (let j = g.cy0; j < g.cy1; j++) {
      for (let i = g.cx0; i < g.cx1; i++) {
        let first = -2, mix = false, any = false;
        for (let y = g.ys[j]; y < g.ys[j + 1] && !mix; y++) {
          for (let x = g.xs[i]; x < g.xs[i + 1]; x++) {
            const k = y * W + x;
            const v = mask[k] ? ((d[k * 4] << 16) | (d[k * 4 + 1] << 8) | d[k * 4 + 2]) : -1;
            if (v >= 0) any = true;
            if (first === -2) first = v;
            else if (v !== first) { mix = true; break; }
          }
        }
        if (!any) continue;
        tot++;
        if (mix) mixed++;
      }
    }
    return tot ? mixed / tot : 0;
  }

  function analyze(img, opts) {
    const o = withDefaults(opts);
    const { mask, bg } = computeMask(img, o);
    let det = null;
    if (o.force !== 'target') det = detectGrid(img, mask, o, bg);
    // taille fixe : s'applique a toutes les images (la grille detectee ne sert
    // plus qu'a l'information), sauf grille imposee (taille de pixel manuelle)
    const gridForced = o.force === 'grid' || Number(o.pixelSize) > 0;
    if (!gridForced && (o.sizeMode === 'fixed' || o.force === 'target')) {
      const t = analyzeTarget(img, mask, o);
      return Object.assign(t, { width: img.width, height: img.height, mask, bg, source: 'target', sizeMode: 'fixed', detection: det });
    }
    // peu de couleurs exactes = pixel art deja propre (natif ou agrandi net)
    const clean = o.force !== 'target' && img.width * img.height <= 1024 * 1024 && countColors(img, mask, 64) <= 64;
    const native = () => {
      const a = analyzeGrid(img, mask, bg, Object.assign({}, o, { pixelSize: 1, offsetX: 0, offsetY: 0, adaptive: false }));
      a.source = 'native'; a.detection = det;
      return a;
    };
    if (det && (o.force === 'grid' || det.confident)) {
      if (clean && !det.manual && o.force !== 'grid' && mixedCells(img, mask, det) > 0.1) return native();
      const a = analyzeGrid(img, mask, bg, o, det);
      a.source = 'grid'; a.detection = det;
      return a;
    }
    if (clean) return native();
    const t = analyzeTarget(img, mask, o);
    return Object.assign(t, { width: img.width, height: img.height, mask, bg, source: 'target', sizeMode: 'auto', detection: det });
  }

  function analyzeGrid(img, mask, bg, o, det) {
    let grid = det || detectGrid(img, mask, o, bg);
    let cells = cellStats(img, mask, grid, o);
    bilinearCells(img, mask, grid, cells);
    if (cells.model === 'bilinear' && o.adaptive) {
      // rampes bilineaires : le recalage local (fait pour des bords nets) est
      // moins fiable que la grille globale -> on la garde telle quelle
      const o2 = Object.assign({}, o, { adaptive: false, pixelSize: grid.baseSize, offsetX: grid.offsetX, offsetY: grid.offsetY });
      const g2 = detectGrid(img, mask, o2, bg);
      g2.size = grid.size; g2.manual = grid.manual; g2.profileType = grid.profileType; g2.confidence = grid.confidence;
      const c2 = cellStats(img, mask, g2, o);
      bilinearCells(img, mask, g2, c2);
      if (c2.model === 'bilinear' && c2.nx === cells.nx && c2.ny === cells.ny) { grid = g2; cells = c2; }
    }
    grid.displayXs = Array.from(grid.xs.slice(grid.cx0, grid.cx1 + 1));
    grid.displayYs = Array.from(grid.ys.slice(grid.cy0, grid.cy1 + 1));
    const samples = new Float32Array(cells.nx * cells.ny * 3);
    let n = 0;
    for (let c = 0; c < cells.nx * cells.ny; c++) {
      if (!cells.opaque[c]) continue;
      samples[n * 3] = cells.rep[c * 3]; samples[n * 3 + 1] = cells.rep[c * 3 + 1]; samples[n * 3 + 2] = cells.rep[c * 3 + 2]; n++;
    }
    return { width: img.width, height: img.height, mask, bg, grid, cells, samples: samples.slice(0, n * 3) };
  }

  // ------------------------------------------------------------- c) palette

  function makePalette(rgbList) {
    const seen = new Set(), rgb = [];
    for (const c of rgbList) {
      const r = c[0] | 0, g = c[1] | 0, b = c[2] | 0, key = (r << 16) | (g << 8) | b;
      if (seen.has(key)) continue;
      seen.add(key); rgb.push([r, g, b]);
    }
    const lab = new Float32Array(rgb.length * 3), tmp = new Float64Array(3);
    rgb.forEach((c, i) => { rgbToLab(c[0], c[1], c[2], tmp, 0); lab[i * 3] = tmp[0]; lab[i * 3 + 1] = tmp[1]; lab[i * 3 + 2] = tmp[2]; });
    return { size: rgb.length, rgb, lab, hex: rgb.map(toHex) };
  }

  function toHex(c) {
    return c.map((v) => v.toString(16).padStart(2, '0')).join('');
  }

  function nearestIndex(L, A, B, lab, k) {
    let best = 0, bd = Infinity;
    for (let i = 0; i < k; i++) {
      const dl = L - lab[i * 3], da = A - lab[i * 3 + 1], db = B - lab[i * 3 + 2];
      const dd = dl * dl + da * da + db * db;
      if (dd < bd) { bd = dd; best = i; }
    }
    return best;
  }

  function lloyd(S, n, centers, maxIter) {
    const k = centers.length / 3;
    const labels = new Int32Array(n).fill(-1), dists = new Float64Array(n);
    const counts = new Float64Array(k), acc = new Float64Array(k * 3);
    let sse = 0;
    for (let it = 0; it < maxIter; it++) {
      let changed = 0;
      sse = 0;
      for (let i = 0; i < n; i++) {
        const L = S[i * 3], A = S[i * 3 + 1], B = S[i * 3 + 2];
        let best = 0, bd = Infinity;
        for (let c = 0; c < k; c++) {
          const dl = L - centers[c * 3], da = A - centers[c * 3 + 1], db = B - centers[c * 3 + 2];
          const dd = dl * dl + da * da + db * db;
          if (dd < bd) { bd = dd; best = c; }
        }
        if (labels[i] !== best) { labels[i] = best; changed++; }
        dists[i] = bd; sse += bd;
      }
      if (changed === 0 && it > 0) break;
      counts.fill(0); acc.fill(0);
      for (let i = 0; i < n; i++) {
        const c = labels[i];
        counts[c]++; acc[c * 3] += S[i * 3]; acc[c * 3 + 1] += S[i * 3 + 1]; acc[c * 3 + 2] += S[i * 3 + 2];
      }
      for (let c = 0; c < k; c++) {
        if (counts[c] > 0) {
          centers[c * 3] = acc[c * 3] / counts[c];
          centers[c * 3 + 1] = acc[c * 3 + 1] / counts[c];
          centers[c * 3 + 2] = acc[c * 3 + 2] / counts[c];
        } else {
          // cellule vide : on la replace sur le point le plus mal servi
          let far = 0;
          for (let i = 1; i < n; i++) if (dists[i] > dists[far]) far = i;
          centers[c * 3] = S[far * 3]; centers[c * 3 + 1] = S[far * 3 + 1]; centers[c * 3 + 2] = S[far * 3 + 2];
          dists[far] = 0;
        }
      }
    }
    counts.fill(0);
    for (let i = 0; i < n; i++) counts[labels[i]]++;
    return { labels, dists, counts, sse };
  }

  // k-means++ glouton : plusieurs tirages D^2, on garde le meilleur.
  function addCenter(S, n, centers, dists, rng) {
    let total = 0;
    for (let i = 0; i < n; i++) total += dists[i];
    const k = centers.length / 3;
    const trials = 2 + Math.floor(Math.log(k + 1));
    let bestIdx = 0, bestPot = Infinity;
    for (let t = 0; t < trials; t++) {
      let r = rng() * total, idx = n - 1;
      for (let i = 0; i < n; i++) { r -= dists[i]; if (r <= 0) { idx = i; break; } }
      const L = S[idx * 3], A = S[idx * 3 + 1], B = S[idx * 3 + 2];
      let pot = 0;
      for (let i = 0; i < n; i++) {
        const dl = S[i * 3] - L, da = S[i * 3 + 1] - A, db = S[i * 3 + 2] - B;
        const dd = dl * dl + da * da + db * db;
        pot += dd < dists[i] ? dd : dists[i];
      }
      if (pot < bestPot) { bestPot = pot; bestIdx = idx; }
    }
    const out = new Float64Array(centers.length + 3);
    out.set(centers);
    out[centers.length] = S[bestIdx * 3]; out[centers.length + 1] = S[bestIdx * 3 + 1]; out[centers.length + 2] = S[bestIdx * 3 + 2];
    return out;
  }

  function meanCenter(S, n) {
    const c = new Float64Array(3);
    for (let i = 0; i < n; i++) { c[0] += S[i * 3]; c[1] += S[i * 3 + 1]; c[2] += S[i * 3 + 2]; }
    c[0] /= n; c[1] /= n; c[2] /= n;
    return c;
  }

  function kmeansFixed(S, n, k, rng) {
    let best = null;
    for (let rep = 0; rep < 3; rep++) {
      let centers = meanCenter(S, n);
      let res = lloyd(S, n, centers, 1);
      while (centers.length / 3 < k) {
        centers = addCenter(S, n, centers, res.dists, rng);
        res = lloyd(S, n, centers, 1);
      }
      res = lloyd(S, n, centers, 40);
      if (!best || res.sse < best.res.sse) best = { centers, res };
    }
    return compact(best.centers, best.res.counts);
  }

  function compact(centers, counts) {
    const out = [];
    for (let c = 0; c < counts.length; c++) if (counts[c] > 0) out.push([centers[c * 3], centers[c * 3 + 1], centers[c * 3 + 2], counts[c]]);
    return out;
  }

  // Fusion des couleurs quasi identiques (moyenne ponderee).
  function fuse(list, tol) {
    const t2 = tol * tol;
    for (;;) {
      let bi = -1, bj = -1, bd = t2;
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i], b = list[j];
          const dd = (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
          if (dd < bd) { bd = dd; bi = i; bj = j; }
        }
      }
      if (bi < 0) break;
      const a = list[bi], b = list[bj], w = a[3] + b[3];
      list[bi] = [(a[0] * a[3] + b[0] * b[3]) / w, (a[1] * a[3] + b[1] * b[3]) / w, (a[2] * a[3] + b[2] * b[3]) / w, w];
      list.splice(bj, 1);
    }
    return list;
  }

  // Retire les petites couleurs qui ne sont qu'un melange de deux autres
  // (cellules a cheval sur un bord).
  function pruneBlends(list, total) {
    const small = Math.max(2, 0.015 * total);
    let changed = true;
    while (changed && list.length > 2) {
      changed = false;
      for (let c = 0; c < list.length; c++) {
        const p = list[c];
        if (p[3] > small) continue;
        let isBlend = false;
        for (let i = 0; i < list.length && !isBlend; i++) {
          if (i === c || list[i][3] < 3 * p[3]) continue;
          for (let j = i + 1; j < list.length && !isBlend; j++) {
            if (j === c || list[j][3] < 3 * p[3]) continue;
            const a = list[i], b = list[j];
            const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
            const uu = ux * ux + uy * uy + uz * uz;
            if (uu < 1e-9) continue;
            const t = ((p[0] - a[0]) * ux + (p[1] - a[1]) * uy + (p[2] - a[2]) * uz) / uu;
            if (t < 0.15 || t > 0.85) continue;
            const qx = p[0] - a[0] - t * ux, qy = p[1] - a[1] - t * uy, qz = p[2] - a[2] - t * uz;
            if (qx * qx + qy * qy + qz * qz < 0.03 * 0.03) isBlend = true;
          }
        }
        if (isBlend) { list.splice(c, 1); changed = true; break; }
      }
    }
    return list;
  }

  function kmeansAuto(S, n, o, rng) {
    const T2 = o.colorTolerance * o.colorTolerance;
    const allowed = Math.floor(n * 0.003);
    let centers = meanCenter(S, n);
    let res = lloyd(S, n, centers, 30);
    const hist = [res.sse];
    for (;;) {
      let far = 0;
      for (let i = 0; i < n; i++) if (res.dists[i] > T2) far++;
      if (far <= allowed || centers.length / 3 >= Math.min(o.maxColors, n)) break;
      const h = hist.length;
      if (h >= 4 && hist[h - 1] > 0.97 * hist[h - 2] && hist[h - 2] > 0.97 * hist[h - 3]) break;
      centers = addCenter(S, n, centers, res.dists, rng);
      res = lloyd(S, n, centers, 30);
      hist.push(res.sse);
    }
    let list = compact(centers, res.counts);
    list = fuse(list, o.colorTolerance * 0.65);
    list = pruneBlends(list, n);
    const c2 = new Float64Array(list.length * 3);
    list.forEach((c, i) => { c2[i * 3] = c[0]; c2[i * 3 + 1] = c[1]; c2[i * 3 + 2] = c[2]; });
    res = lloyd(S, n, c2, 20);
    return compact(c2, res.counts);
  }

  function gatherSamples(analyses, maxN, rng) {
    let total = 0;
    for (const a of analyses) total += a.samples.length / 3;
    const keep = total > maxN ? maxN / total : 1;
    const S = new Float32Array(Math.min(total, maxN + 16) * 3);
    let n = 0;
    for (const a of analyses) {
      const sm = a.samples;
      for (let i = 0; i < sm.length / 3; i++) {
        if (keep < 1 && rng() > keep) continue;
        if (n * 3 >= S.length) break;
        S[n * 3] = sm[i * 3]; S[n * 3 + 1] = sm[i * 3 + 1]; S[n * 3 + 2] = sm[i * 3 + 2]; n++;
      }
    }
    return { S, n };
  }

  function distinctColors(S, n, max) {
    const seen = new Map();
    for (let i = 0; i < n; i++) {
      const key = S[i * 3].toFixed(5) + ',' + S[i * 3 + 1].toFixed(5) + ',' + S[i * 3 + 2].toFixed(5);
      if (!seen.has(key)) {
        seen.set(key, [S[i * 3], S[i * 3 + 1], S[i * 3 + 2], 0]);
        if (seen.size > max) return null;
      }
      seen.get(key)[3]++;
    }
    return Array.from(seen.values());
  }

  function buildPalette(analyses, opts) {
    const o = withDefaults(opts);
    if (o.palette && o.palette.length) return makePalette(o.palette);
    const rng = mulberry32(o.seed);
    const { S, n } = gatherSamples(analyses, 50000, rng);
    if (n === 0) return makePalette([[0, 0, 0]]);
    const k = Math.round(Number(o.colors) || 0);
    let list;
    if (k > 0) list = kmeansFixed(S, n, Math.min(k, n), rng);
    else {
      // peu de couleurs distinctes (pixel art deja propre) : gardees telles quelles
      list = distinctColors(S, n, Math.min(o.maxColors, 64));
      if (!list) {
        // images converties (degrades) : palette plus petite et plus tolerante
        let tot = 0, conv = 0;
        for (const a of analyses) { const m = a.samples.length; tot += m; if (a.source === 'target') conv += m; }
        const fr = tot ? conv / tot : 0;
        const oa = Object.assign({}, o, { colorTolerance: o.colorTolerance + 0.03 * fr, maxColors: Math.max(8, Math.round(o.maxColors - 16 * fr)) });
        list = kmeansAuto(S, n, oa, rng);
      }
    }
    list.sort((a, b) => a[0] - b[0]);
    return makePalette(list.map((c) => labToRgb(c[0], c[1], c[2])));
  }

  // ----------------------------------------------------------- d) reduction

  function vote(img, analysis, palette, opts) {
    const o = withDefaults(opts);
    const { grid, mask, cells } = analysis;
    const W = img.width, d = img.data;
    const nx = cells.nx, ny = cells.ny, K = palette.size, pl = palette.lab;
    const idx = new Int16Array(nx * ny).fill(-1);
    const votes = new Float64Array(K), lab = new Float64Array(3);
    const { inX, inY } = cells;
    for (let j = 0; j < ny; j++) {
      const y0 = inY[j * 2], y1 = inY[j * 2 + 1];
      const cy = (grid.ys[grid.cy0 + j] + grid.ys[grid.cy0 + j + 1]) / 2;
      const hy = Math.max(0.5, (y1 - y0) / 2 + 0.5);
      for (let i = 0; i < nx; i++) {
        const c = j * nx + i;
        if (!cells.opaque[c]) continue;
        const x0 = inX[i * 2], x1 = inX[i * 2 + 1];
        const cx = (grid.xs[grid.cx0 + i] + grid.xs[grid.cx0 + i + 1]) / 2;
        const hx = Math.max(0.5, (x1 - x0) / 2 + 0.5);
        votes.fill(0);
        let any = false;
        for (let y = y0; y < y1; y++) {
          const wy = 1 - 0.5 * Math.min(1, Math.abs(y + 0.5 - cy) / hy);
          for (let x = x0; x < x1; x++) {
            const k = y * W + x;
            if (!mask[k]) continue;
            const p = k * 4;
            rgbToLab(d[p], d[p + 1], d[p + 2], lab, 0);
            const wx = 1 - 0.5 * Math.min(1, Math.abs(x + 0.5 - cx) / hx);
            votes[nearestIndex(lab[0], lab[1], lab[2], pl, K)] += wx * wy;
            any = true;
          }
        }
        if (!any) { idx[c] = nearestIndex(cells.rep[c * 3], cells.rep[c * 3 + 1], cells.rep[c * 3 + 2], pl, K); continue; }
        let best = 0;
        for (let q = 1; q < K; q++) if (votes[q] > votes[best]) best = q;
        idx[c] = best;
      }
    }
    return idx;
  }

  // Re-vote par modele : si l'image ressemble a un agrandissement bilineaire
  // (rampes entre centres de cellules), chaque couleur est choisie pour que
  // le rendu bilineaire avec ses voisines explique au mieux les pixels.
  // Sinon (cellules plates a bords flous), on garde le vote majoritaire.
  function refineVote(img, analysis, palette, idx) {
    const { grid, mask, cells } = analysis;
    const W = img.width, d = img.data;
    const { nx, ny, inX, inY } = cells;
    const K = palette.size, pal = palette.rgb;
    if (K < 2 || nx < 3 || ny < 3) return idx;
    const cx = new Float64Array(nx), sx = new Float64Array(nx), cy = new Float64Array(ny), sy = new Float64Array(ny);
    for (let i = 0; i < nx; i++) { const a = grid.xs[grid.cx0 + i], b = grid.xs[grid.cx0 + i + 1]; cx[i] = (a + b) / 2; sx[i] = b - a; }
    for (let j = 0; j < ny; j++) { const a = grid.ys[grid.cy0 + j], b = grid.ys[grid.cy0 + j + 1]; cy[j] = (a + b) / 2; sy[j] = b - a; }
    const cur = Int16Array.from(idx);
    const nb = (i, j, X) => (i < 0 || j < 0 || i >= nx || j >= ny || cur[j * nx + i] < 0) ? X : cur[j * nx + i];
    const cost = (i, j, X, bil) => {
      const x0 = inX[i * 2], x1 = inX[i * 2 + 1], y0 = inY[j * 2], y1 = inY[j * 2 + 1];
      const cX = pal[X];
      let tot = 0;
      for (let y = y0; y < y1; y++) {
        const v = (y + 0.5 - cy[j]) / sy[j], wy = Math.min(0.5, Math.abs(v)), vj = v >= 0 ? j + 1 : j - 1;
        for (let x = x0; x < x1; x++) {
          const k = y * W + x;
          if (!mask[k]) continue;
          const p = k * 4;
          let e0 = cX[0], e1 = cX[1], e2 = cX[2];
          if (bil) {
            const u = (x + 0.5 - cx[i]) / sx[i], wx = Math.min(0.5, Math.abs(u)), hi = u >= 0 ? i + 1 : i - 1;
            const H = pal[nb(hi, j, X)], V = pal[nb(i, vj, X)], D = pal[nb(hi, vj, X)];
            const a = (1 - wx) * (1 - wy), b = wx * (1 - wy), c = (1 - wx) * wy, e = wx * wy;
            e0 = a * cX[0] + b * H[0] + c * V[0] + e * D[0];
            e1 = a * cX[1] + b * H[1] + c * V[1] + e * D[1];
            e2 = a * cX[2] + b * H[2] + c * V[2] + e * D[2];
          }
          const q0 = d[p] - e0, q1 = d[p + 1] - e1, q2 = d[p + 2] - e2;
          tot += q0 * q0 + q1 * q1 + q2 * q2;
        }
      }
      return tot;
    };
    // choix du modele
    let cs = 0, cb = 0;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const X = cur[j * nx + i];
      if (X < 0) continue;
      cs += cost(i, j, X, false); cb += cost(i, j, X, true);
    }
    if (cells.model !== 'bilinear' && !(cb < 0.85 * cs)) return idx;
    // candidats : couleurs de palette les plus proches de la couleur representative
    const nc = Math.min(K, 8), rep = cells.rep, pl = palette.lab;
    const cand = new Int16Array(nx * ny * nc).fill(-1);
    const dist = new Float64Array(K), order = new Int32Array(K);
    for (let c = 0; c < nx * ny; c++) {
      if (cur[c] < 0) continue;
      for (let q = 0; q < K; q++) {
        const dl = rep[c * 3] - pl[q * 3], da = rep[c * 3 + 1] - pl[q * 3 + 1], db = rep[c * 3 + 2] - pl[q * 3 + 2];
        dist[q] = dl * dl + da * da + db * db; order[q] = q;
      }
      const ord = Array.from(order).sort((a, b) => dist[a] - dist[b]);
      for (let q = 0; q < nc; q++) cand[c * nc + q] = ord[q];
    }
    for (let it = 0; it < 4; it++) {
      let changed = 0;
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const c = j * nx + i;
        if (cur[c] < 0) continue;
        let best = cur[c], bc = cost(i, j, best, true);
        for (let q = 0; q < nc; q++) {
          const X = cand[c * nc + q];
          if (X < 0 || X === best) continue;
          const v = cost(i, j, X, true);
          if (v < bc) { bc = v; best = X; }
        }
        if (best !== cur[c]) { cur[c] = best; changed++; }
      }
      if (!changed) break;
    }
    return cur;
  }

  // ----------------------------------------------------------- e) nettoyage

  function labDist(pl, a, b) {
    const dl = pl[a * 3] - pl[b * 3], da = pl[a * 3 + 1] - pl[b * 3 + 1], db = pl[a * 3 + 2] - pl[b * 3 + 2];
    return Math.sqrt(dl * dl + da * da + db * db);
  }

  function cleanupIndices(idx, w, h, palette, opts) {
    const o = withDefaults(opts);
    const out = Int16Array.from(idx);
    const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? -1 : idx[y * w + x];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const c = idx[y * w + x];
        if (c < 0) continue;
        let allT = true, same = false;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const v = at(x + dx, y + dy);
            if (v >= 0) allT = false;
            if (v === c) same = true;
          }
        }
        if (allT) { out[y * w + x] = -1; continue; }   // ilot d'1 pixel dans la transparence
        if (same) continue;
        const n4 = [at(x - 1, y), at(x + 1, y), at(x, y - 1), at(x, y + 1)];
        for (let a = 0; a < 2; a++) {
          const v = n4[a];
          if (v < 0) continue;
          let cnt = 0;
          for (let b = 0; b < 4; b++) if (n4[b] === v) cnt++;
          if (cnt >= 3) {
            if (labDist(palette.lab, c, v) < o.cleanupGuard) out[y * w + x] = v;
            break;
          }
        }
      }
    }
    return out;
  }

  // ------------------------------------------------------ embellissements

  const N8 = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];

  function darkestIndex(palette, used) {
    let best = -1;
    for (let i = 0; i < palette.size; i++) {
      if (used && !used[i]) continue;
      if (best < 0 || palette.lab[i * 3] < palette.lab[best * 3]) best = i;
    }
    return best < 0 ? 0 : best;
  }

  function usedSet(idx, K) {
    const u = new Uint8Array(K);
    for (let i = 0; i < idx.length; i++) if (idx[i] >= 0) u[idx[i]] = 1;
    return u;
  }

  // Couleur de palette "assombrie" pour un contour selectif.
  function shadeIndex(palette, c, fallback) {
    const pl = palette.lab;
    const L = pl[c * 3], tL = L * 0.55, tA = pl[c * 3 + 1] * 0.8, tB = pl[c * 3 + 2] * 0.8;
    let best = -1, bd = Infinity;
    for (let i = 0; i < palette.size; i++) {
      if (pl[i * 3] > L - 0.08) continue;
      const dl = pl[i * 3] - tL, da = pl[i * 3 + 1] - tA, db = pl[i * 3 + 2] - tB;
      const dd = dl * dl + da * da + db * db;
      if (dd < bd) { bd = dd; best = i; }
    }
    return best < 0 ? fallback : best;
  }

  // Contour propre : couche exterieure (pixels opaques 4-adjacents a la
  // transparence) d'1 pixel, sans trou, couleur uniforme (ou selective).
  // Les detail d'1 pixel de large gardent leur couleur.
  function cleanOutline(idx, w, h, palette, mode) {
    const at = (a, x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? -1 : a[y * w + x];
    const N = w * h, edge = new Uint8Array(N), thin = new Uint8Array(N);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (idx[i] < 0) continue;
        const l = at(idx, x - 1, y) < 0, r = at(idx, x + 1, y) < 0, u = at(idx, x, y - 1) < 0, dn = at(idx, x, y + 1) < 0;
        if (l || r || u || dn) edge[i] = 1;
        if ((l && r) || (u && dn)) thin[i] = 1;
      }
    }
    const used = usedSet(idx, palette.size);
    const dark = darkestIndex(palette, used);
    // couleur dominante de l'ancien contour (pour amincir un contour epais)
    const cnt = new Int32Array(palette.size);
    let ne = 0;
    for (let i = 0; i < N; i++) if (edge[i]) { cnt[idx[i]]++; ne++; }
    let oc = -1;
    for (let c = 0; c < palette.size; c++) if (cnt[c] > 0 && (oc < 0 || cnt[c] > cnt[oc])) oc = c;
    if (oc >= 0 && cnt[oc] < 0.3 * ne) oc = -1;
    const out = Int16Array.from(idx);
    const interiorColor = (x, y) => {
      const votes = new Map();
      for (const [dx, dy] of N8) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx, v = idx[j];
        if (v < 0 || edge[j] || v === oc || v === dark) continue;
        votes.set(v, (votes.get(v) || 0) + 1);
      }
      let best = -1, bc = 0;
      for (const [v, c] of votes) if (c > bc) { bc = c; best = v; }
      return best;
    };
    // 1) amincir : 2e couche de la couleur de contour -> couleur interieure
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x, v = idx[i];
        if (v < 0 || edge[i] || (v !== oc && v !== dark)) continue;
        let touch = false, same = 0;
        for (const [dx, dy] of N8) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const j = yy * w + xx;
          if (edge[j] && Math.abs(dx) + Math.abs(dy) === 1) touch = true;
          if (idx[j] === oc || idx[j] === dark) same++;
        }
        if (!touch || same < 4) continue;
        const ic = interiorColor(x, y);
        if (ic >= 0) out[i] = ic;
      }
    }
    // 2) couche exterieure -> couleur de contour (comble aussi les coupures)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!edge[i] || thin[i]) continue;
        if (mode === 'selective') {
          const ic = interiorColor(x, y);
          out[i] = shadeIndex(palette, ic >= 0 ? ic : idx[i], dark);
        } else out[i] = dark;
      }
    }
    return out;
  }

  // Lignes pixel-perfect : retire le pixel de coin des L de 3 pixels dans les
  // traits d'1 pixel (contour et traits sombres), sans casser la connexite 8.
  function pixelPerfect(idx, w, h, palette) {
    const out = Int16Array.from(idx);
    const N = w * h;
    const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? -1 : out[y * w + x];
    const used = usedSet(idx, palette.size);
    let lmin = Infinity, lmax = -Infinity;
    for (let c = 0; c < palette.size; c++) {
      if (!used[c]) continue;
      lmin = Math.min(lmin, palette.lab[c * 3]); lmax = Math.max(lmax, palette.lab[c * 3]);
    }
    const darkT = lmin + 0.35 * (lmax - lmin);
    const isEdge = (x, y) => at(x, y) >= 0 && (at(x - 1, y) < 0 || at(x + 1, y) < 0 || at(x, y - 1) < 0 || at(x, y + 1) < 0);
    const edge0 = new Uint8Array(N);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (isEdge(x, y)) edge0[y * w + x] = 1;

    const tryRemove = (x, y, allowOuter) => {
      const i = y * w + x, c = out[i];
      if (c < 0) return false;
      const isStroke = edge0[i] || palette.lab[c * 3] <= darkT;
      if (!isStroke) return false;
      const L = at(x - 1, y) === c, R = at(x + 1, y) === c, U = at(x, y - 1) === c, D = at(x, y + 1) === c;
      if ((L ? 1 : 0) + (R ? 1 : 0) !== 1 || (U ? 1 : 0) + (D ? 1 : 0) !== 1) return false;
      const hx = L ? -1 : 1, vy = U ? -1 : 1;
      if (at(x + hx, y + vy) === c) return false; // bloc plein, pas un trait
      // connexite 8 locale : les voisins de meme couleur forment un seul groupe
      const ring = N8.map(([dx, dy]) => at(x + dx, y + dy) === c);
      let nSame = 0;
      for (const r of ring) if (r) nSame++;
      if (nSame < 2) return false;
      const seen = new Array(8).fill(false);
      let start = ring.indexOf(true), comp = 0;
      const stack = [start]; seen[start] = true;
      while (stack.length) {
        const a = stack.pop(); comp++;
        for (let b = 0; b < 8; b++) {
          if (!ring[b] || seen[b]) continue;
          const [ax, ay] = N8[a], [bx, by] = N8[b];
          if (Math.abs(ax - bx) <= 1 && Math.abs(ay - by) <= 1) { seen[b] = true; stack.push(b); }
        }
      }
      if (comp !== nSame) return false;
      const outer = at(x - 1, y) < 0 || at(x + 1, y) < 0 || at(x, y - 1) < 0 || at(x, y + 1) < 0;
      if (outer && !allowOuter) return false;
      if (outer) { out[i] = -1; return true; }
      const votes = new Map();
      for (const [dx, dy] of N8) {
        const v = at(x + dx, y + dy);
        if (v < 0 || v === c) continue;
        votes.set(v, (votes.get(v) || 0) + 1);
      }
      let best = -1, bc = 0;
      for (const [v, n] of votes) if (n > bc) { bc = n; best = v; }
      if (best < 0) return false;
      out[i] = best;
      return true;
    };
    // d'abord les coins interieurs (la silhouette ne bouge pas), puis exterieurs
    for (const allowOuter of [false, true]) {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) tryRemove(x, y, allowOuter);
    }
    return out;
  }

  function beautify(idx, w, h, palette, opts) {
    const o = withDefaults(opts);
    let out = idx;
    if (o.cleanOutline) out = cleanOutline(out, w, h, palette, o.outlineMode);
    if (o.pixelPerfect) out = pixelPerfect(out, w, h, palette);
    return out;
  }

  // ------------------------------------------------------------- f) sortie

  function indicesToImage(idx, w, h, palette) {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const c = idx[i];
      if (c < 0) continue;
      const rgb = palette.rgb[c];
      data[i * 4] = rgb[0]; data[i * 4 + 1] = rgb[1]; data[i * 4 + 2] = rgb[2]; data[i * 4 + 3] = 255;
    }
    return { width: w, height: h, data };
  }

  // Vote + nettoyage (cachable) puis embellissements + image.
  function reduce(img, analysis, palette, opts) {
    const o = withDefaults(opts);
    const { nx, ny } = analysis.cells;
    let idx;
    if (analysis.source === 'target') idx = voteTarget(analysis, palette);
    else {
      idx = vote(img, analysis, palette, o);
      idx = refineVote(img, analysis, palette, idx);
    }
    if (o.cleanup) idx = cleanupIndices(idx, nx, ny, palette, o);
    return idx;
  }

  function finalize(idx, w, h, palette, opts) {
    const out = beautify(idx, w, h, palette, opts);
    const image = indicesToImage(out, w, h, palette);
    image.indices = out;
    return image;
  }

  function scaleNearest(img, f) {
    f = Math.max(1, Math.round(f));
    const W = img.width * f, H = img.height * f, out = new Uint8ClampedArray(W * H * 4), s = img.data;
    for (let y = 0; y < H; y++) {
      const sy = (y / f) | 0;
      for (let x = 0; x < W; x++) {
        const p = (sy * img.width + ((x / f) | 0)) * 4, q = (y * W + x) * 4;
        out[q] = s[p]; out[q + 1] = s[p + 1]; out[q + 2] = s[p + 2]; out[q + 3] = s[p + 3];
      }
    }
    return { width: W, height: H, data: out };
  }

  // Traitement complet d'un lot (Node, tests, CLI) : memes etapes que la page.
  // opts : reglages du lot (dont la palette) ; overrides[i] : reglages propres
  // a l'image i (taille cible, contour...), appliques a toutes ses etapes.
  function processBatch(images, opts, overrides) {
    const o = withDefaults(opts);
    const per = images.map((img, i) => Object.assign({}, o, (overrides && overrides[i]) || {}));
    const analyses = images.map((img, i) => analyze(img, per[i]));
    const shared = o.sharedPalette || (o.palette && o.palette.length) ? buildPalette(analyses, o) : null;
    return analyses.map((a, i) => {
      const pal = shared || buildPalette([a], o);
      const idx = reduce(images[i], a, pal, per[i]);
      const image = finalize(idx, a.cells.nx, a.cells.ny, pal, per[i]);
      return { image, palette: pal, analysis: a, source: a.source, size: a.grid.size, width: image.width, height: image.height };
    });
  }

  function process(img, opts) {
    return processBatch([img], Object.assign({}, opts, { sharedPalette: true }))[0];
  }

  // ------------------------------------------------------ palettes imposees

  function parsePaletteText(text) {
    const out = [];
    const lines = String(text).split(/\r?\n/);
    const gpl = /^\s*GIMP Palette/i.test(lines[0] || '');
    for (let raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#') && !/^#[0-9a-f]{6}\b/i.test(line) || line.startsWith(';')) continue;
      if (gpl) {
        if (/^(GIMP Palette|Name:|Columns:)/i.test(line)) continue;
        const m = line.match(/^(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})/);
        if (m) out.push([+m[1], +m[2], +m[3]].map((v) => Math.min(255, v)));
        continue;
      }
      const hx = line.match(/^#?(?:ff)?([0-9a-f]{6})\b/i) || line.match(/#([0-9a-f]{6})\b/i);
      if (hx) { const v = parseInt(hx[1], 16); out.push([(v >> 16) & 255, (v >> 8) & 255, v & 255]); continue; }
      const m = line.match(/^(\d{1,3})[\s,;]+(\d{1,3})[\s,;]+(\d{1,3})\b/);
      if (m) out.push([+m[1], +m[2], +m[3]].map((v) => Math.min(255, v)));
    }
    return dedupe(out);
  }

  function dedupe(list) {
    const seen = new Set(), out = [];
    for (const c of list) {
      const k = (c[0] << 16) | (c[1] << 8) | c[2];
      if (!seen.has(k)) { seen.add(k); out.push(c); }
    }
    return out;
  }

  function paletteFromImage(img) {
    const out = [], d = img.data;
    for (let i = 0; i < img.width * img.height; i++) {
      if (d[i * 4 + 3] < 128) continue;
      out.push([d[i * 4], d[i * 4 + 1], d[i * 4 + 2]]);
    }
    return dedupe(out).slice(0, 256);
  }

  function paletteToHexText(palette) {
    return palette.hex.join('\r\n') + '\r\n';
  }

  return {
    DEFAULTS, withDefaults, GRID_MIN_SCORE,
    rgbToLab, labToRgb,
    computeMask, removeBackground,
    detectGrid, analyze, buildPalette, makePalette,
    vote, cleanupIndices, reduce, finalize,
    cleanOutline, pixelPerfect, beautify, indicesToImage,
    scaleNearest, processBatch, process,
    parsePaletteText, paletteFromImage, paletteToHexText,
    _internal: { buildFeatures, axisProfiles, makeFolder, activeRange, estimatePeriod },
  };
}));
