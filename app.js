/* Pixel Clean : interface (page locale en file:// ou vue connectee via "node cli.js serve"). */
(function () {
  'use strict';
  const PC = window.PixelClean;
  const $ = (id) => document.getElementById(id);
  const EXT = /\.(png|jpe?g|webp|gif)$/i;
  const STATUS = {
    waiting: 'En attente', processing: 'En cours', done: 'Fait', error: 'Erreur',
    missing: 'Manquant', review: 'À revoir', validated: 'Validé', stale: 'Obsolète',
  };
  const FILTERS = ['missing', 'processing', 'done', 'review', 'validated', 'error', 'stale'];
  const DONE = new Set(['done', 'review', 'validated']);
  const store = {
    get(k, d) { try { const v = localStorage.getItem('pixelclean.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('pixelclean.' + k, JSON.stringify(v)); } catch (e) { /* stockage indisponible */ } },
  };

  const state = {
    server: null,           // vue connectee : infos du serveur
    items: [],
    selected: null,
    imposed: null, imposedName: '',
    shared: null, sharedKey: '',
    run: 0, zoom: 0, nextId: 1,
    filter: 'all',
    collapsed: store.get('collapsed', {}),
    anim: null,
  };
  $('optAnim').checked = store.get('animate', true);

  const fr = (v) => Number(v).toLocaleString('fr-FR', { maximumFractionDigits: 1 });
  const dirOf = (rel) => { const i = rel.lastIndexOf('/'); return i < 0 ? '' : rel.slice(0, i); };
  const baseOf = (rel) => rel.slice(rel.lastIndexOf('/') + 1);

  // ============================================================ options (mode fichiers)

  function num(id, def) {
    const v = $(id).value.trim();
    if (v === '') return def;
    const n = Number(v.replace(',', '.'));
    return Number.isFinite(n) ? n : def;
  }

  function globalOpts() {
    return {
      colors: Number($('optColors').value) || 0,
      sharedPalette: $('optShared').checked,
      palette: state.imposed,
      background: $('optBg').value,
      bgTolerance: num('optBgTol', 40),
      alphaThreshold: num('optAlpha', 128),
      cleanup: $('optCleanup').checked,
      cleanOutline: $('optOutline').checked,
      outlineMode: $('optOutlineMode').value,
      pixelPerfect: $('optPP').checked,
      sizeMode: $('sizeAuto').checked ? 'auto' : 'fixed',
      force: 'auto',
      targetBy: 'height',
      targetHeight: num('optHeight', 32),
      targetWidth: num('optWidth', 0),
      adaptive: $('optAdaptive').checked,
    };
  }

  function applyOverrides(o, ov) {
    if (!ov) return o;
    if (ov.force) o.force = ov.force;
    if (ov.mode) o.sizeMode = ov.mode;
    if (ov.pixelSize > 0) { o.pixelSize = ov.pixelSize; o.force = 'grid'; }
    if (ov.offsetX !== null && ov.offsetX !== undefined) o.offsetX = ov.offsetX;
    if (ov.offsetY !== null && ov.offsetY !== undefined) o.offsetY = ov.offsetY;
    if (ov.targetHeight > 0) { o.targetHeight = ov.targetHeight; o.targetBy = 'height'; }
    if (ov.targetWidth > 0) { o.targetWidth = ov.targetWidth; o.targetBy = 'height'; }
    return o;
  }

  function analysisKey(it, o) {
    const k = [o.background, o.bgTolerance, o.alphaThreshold, o.sizeMode, o.force, o.pixelSize || 0, o.offsetX, o.offsetY, o.adaptive];
    // la taille cible ne compte que si l'image passe par la taille cible
    if (!it.analysis || it.analysis.source === 'target' || o.sizeMode === 'fixed') k.push(o.targetBy, o.targetHeight, o.targetWidth, o.targetFactor);
    return JSON.stringify(k);
  }

  function newItem(relPath) {
    return {
      id: state.nextId++, relPath, name: baseOf(relPath), dir: dirOf(relPath),
      status: 'waiting', error: '', file: null, img: null, srcCanvas: null,
      ov: { mode: '', force: '', pixelSize: 0, offsetX: null, offsetY: null, targetHeight: 0, targetWidth: 0 },
      analysis: null, aKey: '', aVer: 0, palette: null, pKey: '', idx: null, vKey: '', fKey: '',
      result: null, resultCanvas: null, tile: null, animateNext: false,
    };
  }

  // ============================================================ entree (mode fichiers)

  function addFiles(entries) {
    const known = new Set(state.items.map((it) => it.relPath));
    let added = 0;
    for (const { file, relPath } of entries) {
      if (!EXT.test(file.name) || known.has(relPath)) continue;
      known.add(relPath);
      const it = newItem(relPath);
      it.file = file;
      state.items.push(it);
      added++;
    }
    if (added) { renderGallery(); updateButtons(); processAll(); }
  }

  async function decodeBlob(blob) {
    const bmp = await createImageBitmap(blob);
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    if (bmp.close) bmp.close();
    const d = ctx.getImageData(0, 0, c.width, c.height);
    return { img: { width: d.width, height: d.height, data: d.data }, canvas: c };
  }

  async function walkEntry(entry, out) {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, relPath: entry.fullPath.replace(/^\/+/, '') });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const e of batch) await walkEntry(e, out);
      }
    }
  }

  document.addEventListener('dragover', (e) => { if (state.server) return; e.preventDefault(); document.body.classList.add('dragging'); });
  document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
  document.addEventListener('drop', async (e) => {
    if (state.server) return;
    e.preventDefault();
    document.body.classList.remove('dragging');
    const out = [];
    const list = e.dataTransfer.items ? Array.from(e.dataTransfer.items) : [];
    const entries = list.map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean);
    if (entries.length) { for (const en of entries) await walkEntry(en, out); }
    else for (const f of Array.from(e.dataTransfer.files || [])) out.push({ file: f, relPath: f.name });
    addFiles(out);
  });

  $('btnFiles').onclick = () => $('inFiles').click();
  $('btnFolder').onclick = () => $('inFolder').click();
  $('inFiles').onchange = (e) => { addFiles(Array.from(e.target.files).map((f) => ({ file: f, relPath: f.name }))); e.target.value = ''; };
  $('inFolder').onchange = (e) => { addFiles(Array.from(e.target.files).map((f) => ({ file: f, relPath: f.webkitRelativePath || f.name }))); e.target.value = ''; };
  $('btnClear').onclick = () => {
    state.run++;
    state.items = []; state.selected = null; state.shared = null; state.sharedKey = '';
    closeDetail();
    renderGallery();
    renderPalette();
    updateButtons();
    setProgress(null);
  };

  // ============================================================ galerie par dossier

  function tileThumb(it) {
    const box = it.tile.querySelector('.thumbbox');
    if (state.server) {
      let img = box.querySelector('img');
      if (!img) { img = document.createElement('img'); img.alt = ''; img.decoding = 'async'; box.textContent = ''; box.appendChild(img); }
      const src = it.outRel
        ? '/api/output?path=' + encodeURIComponent(it.outRel) + '&v=' + Math.round(it.outMtime || 0)
        : '/api/source?path=' + encodeURIComponent(it.relPath) + '&v=' + Math.round(it.srcMtime || 0);
      img.classList.toggle('pixelated', !!it.outRel);
      if (img.getAttribute('src') !== src) img.src = src;
      return;
    }
    let c = box.querySelector('canvas');
    if (!c) { c = document.createElement('canvas'); c.width = c.height = 96; box.textContent = ''; box.appendChild(c); }
    const src = it.resultCanvas || it.srcCanvas;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, 96, 96);
    if (!src) return;
    const s = Math.min(96 / src.width, 96 / src.height);
    const k = it.resultCanvas && s >= 1 ? Math.floor(s) : s;
    const w = Math.max(1, Math.round(src.width * k)), h = Math.max(1, Math.round(src.height * k));
    ctx.imageSmoothingEnabled = !it.resultCanvas;
    ctx.drawImage(src, (96 - w) >> 1, (96 - h) >> 1, w, h);
  }

  function updateTile(it) {
    if (!it.tile) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tile';
      b.innerHTML = '<span class="thumbbox"></span><span class="tname"></span><span class="dot"></span>';
      b.onclick = () => openDetail(it);
      it.tile = b;
    }
    it.tile.querySelector('.tname').textContent = it.name;
    it.tile.title = it.relPath + ' : ' + (STATUS[it.status] || it.status) + (it.error ? ' (' + it.error + ')' : '');
    const dot = it.tile.querySelector('.dot');
    dot.className = 'dot st-' + it.status;
    dot.title = STATUS[it.status] || it.status;
    tileThumb(it);
  }

  function renderGallery() {
    const root = $('folders');
    root.textContent = '';
    $('dropHint').hidden = state.items.length > 0 || !!state.server;
    const groups = new Map();
    for (const it of state.items) {
      if (state.filter !== 'all' && it.status !== state.filter) continue;
      if (!groups.has(it.dir)) groups.set(it.dir, []);
      groups.get(it.dir).push(it);
    }
    const all = new Map();
    for (const it of state.items) all.set(it.dir, (all.get(it.dir) || []).concat(it));
    const dirs = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b, 'fr'));
    for (const dir of dirs) {
      const sec = document.createElement('section');
      sec.className = 'folder';
      const collapsed = !!state.collapsed[dir];
      const head = document.createElement('button');
      head.type = 'button';
      head.className = 'folder-head';
      head.setAttribute('aria-expanded', String(!collapsed));
      const members = all.get(dir);
      const ok = members.filter((it) => DONE.has(it.status)).length;
      head.innerHTML = '<span class="caret"></span><span class="fname"></span><span class="count muted"></span>';
      head.querySelector('.fname').textContent = dir || '(racine)';
      head.querySelector('.count').textContent = ok + '/' + members.length + ' faits';
      head.onclick = () => {
        state.collapsed[dir] = !state.collapsed[dir];
        store.set('collapsed', state.collapsed);
        renderGallery();
      };
      sec.appendChild(head);
      if (!collapsed) {
        const grid = document.createElement('div');
        grid.className = 'tiles';
        for (const it of groups.get(dir).sort((a, b) => a.name.localeCompare(b.name, 'fr'))) {
          updateTile(it);
          grid.appendChild(it.tile);
        }
        sec.appendChild(grid);
      }
      root.appendChild(sec);
    }
    if (state.server && !state.items.length) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = 'Aucune image dans le dossier source.';
      root.appendChild(p);
    }
    renderFilters();
  }

  function renderFilters() {
    const nav = $('filters');
    nav.hidden = !state.server;
    if (!state.server) return;
    nav.textContent = '';
    const counts = {};
    for (const it of state.items) counts[it.status] = (counts[it.status] || 0) + 1;
    const mk = (key, label, n) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (state.filter === key ? ' on' : '');
      b.textContent = label + ' (' + n + ')';
      if (key !== 'all') { const d = document.createElement('span'); d.className = 'dot st-' + key; b.prepend(d); }
      b.onclick = () => { state.filter = key; renderGallery(); };
      nav.appendChild(b);
    };
    mk('all', 'Tous', state.items.length);
    for (const k of FILTERS) if (counts[k] || state.filter === k) mk(k, STATUS[k], counts[k] || 0);
    const miss = (counts.missing || 0) + (counts.stale || 0) + (counts.error || 0);
    $('btnMissing').textContent = 'Traiter les manquants' + (miss ? ' (' + miss + ')' : '');
    $('btnMissing').disabled = !miss;
  }

  // ============================================================ vue detaillee

  function infoText(it) {
    if (it.error) return it.error;
    if (state.server && !it.analysis && it.info) return it.info + (it.width ? ' → ' + it.width + '×' + it.height : '');
    const a = it.analysis, r = it.result;
    if (!a || !r) return STATUS[it.status] || '';
    const dims = r.width + '×' + r.height, d = a.detection;
    if (a.source === 'grid') return 'grille détectée : ' + fr(a.grid.size) + ' px → ' + r.height + ' px (' + dims + ')';
    if (a.source === 'native') return 'déjà en pixel art → ' + dims;
    if (a.sizeMode === 'fixed') return 'taille fixe → ' + r.height + ' px (' + dims + ')' + (d && d.confident ? ', grille détectée : ' + fr(d.size) + ' px' : '');
    return 'pas de grille, converti → ' + r.height + ' px (' + dims + ')';
  }

  function openDetail(it) {
    state.selected = it;
    state.zoom = 0;
    $('gallery').hidden = true;
    $('detail').hidden = false;
    const ov = it.ov;
    $('ovMode').value = ov.mode || '';
    $('ovSize').value = ov.pixelSize > 0 ? ov.pixelSize : '';
    $('ovOffX').value = ov.offsetX !== null && ov.offsetX !== undefined ? ov.offsetX : '';
    $('ovOffY').value = ov.offsetY !== null && ov.offsetY !== undefined ? ov.offsetY : '';
    $('ovTarget').value = ov.targetHeight > 0 ? ov.targetHeight : '';
    $('ovWidth').value = ov.targetWidth > 0 ? ov.targetWidth : '';
    if (state.server) loadServerDetail(it, true);
    else showDetail(true);
    renderPalette();
  }

  function closeDetail() {
    stopAnim();
    state.selected = null;
    $('detail').hidden = true;
    $('gallery').hidden = false;
    renderGallery();
  }

  function step(d) {
    const list = visibleItems();
    if (!state.selected || !list.length) return;
    const i = list.indexOf(state.selected);
    openDetail(list[(i + d + list.length) % list.length]);
  }

  function visibleItems() {
    return state.items
      .filter((it) => state.filter === 'all' || it.status === state.filter)
      .sort((a, b) => a.dir.localeCompare(b.dir, 'fr') || a.name.localeCompare(b.name, 'fr'));
  }

  $('btnBack').onclick = closeDetail;
  $('btnPrev').onclick = () => step(-1);
  $('btnNext').onclick = () => step(1);

  function showDetail(animate) {
    const it = state.selected;
    if (!it) return;
    $('vName').textContent = it.relPath;
    $('vInfo').textContent = infoText(it);
    $('btnValidate').hidden = !state.server;
    $('btnReview').hidden = !state.server;
    $('ovApply').hidden = !state.server;
    drawBefore();
    if (animate && $('optAnim').checked && it.result) animateBuild();
    else drawAfter();
  }

  function cropOf(it) {
    const a = it.analysis;
    if (a && it.result && a.grid.displayXs && a.cells.nx === it.result.width && a.cells.ny === it.result.height) {
      const gx = a.grid.displayXs, gy = a.grid.displayYs;
      return { x0: gx[0], y0: gy[0], w: gx[gx.length - 1] - gx[0], h: gy[gy.length - 1] - gy[0], gx, gy };
    }
    return { x0: 0, y0: 0, w: it.img ? it.img.width : 1, h: it.img ? it.img.height : 1, gx: null, gy: null };
  }

  function drawBefore() {
    const it = state.selected, c = $('cvBefore');
    if (!it || !it.srcCanvas) { c.width = c.height = 1; return; }
    const cr = cropOf(it);
    const s = Math.min(240 / cr.w, 320 / cr.h);
    c.width = Math.max(1, Math.round(cr.w * s)); c.height = Math.max(1, Math.round(cr.h * s));
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = s < 1;
    ctx.drawImage(it.srcCanvas, cr.x0, cr.y0, cr.w, cr.h, 0, 0, c.width, c.height);
    if (cr.gx && $('showGrid').checked) {
      ctx.strokeStyle = 'rgba(255, 70, 70, 0.7)';
      ctx.beginPath();
      for (const x of cr.gx) { const p = Math.round((x - cr.x0) * s) + 0.5; ctx.moveTo(p, 0); ctx.lineTo(p, c.height); }
      for (const y of cr.gy) { const p = Math.round((y - cr.y0) * s) + 0.5; ctx.moveTo(0, p); ctx.lineTo(c.width, p); }
      ctx.stroke();
    }
  }

  function zoomFor(r) {
    const pane = $('afterPane');
    const maxW = Math.max(64, pane.clientWidth - 18), maxH = Math.max(120, window.innerHeight - 250);
    const fit = Math.max(1, Math.floor(Math.min(maxW / r.width, maxH / r.height)));
    return state.zoom > 0 ? state.zoom : fit;
  }

  function drawAfter() {
    stopAnim();
    const it = state.selected, c = $('cvAfter');
    if (!it || !it.result) { c.width = c.height = 1; $('zoomVal').textContent = ''; return; }
    const r = it.result, z = zoomFor(r);
    $('zoomVal').textContent = '×' + z;
    c.width = r.width * z; c.height = r.height * z;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(it.resultCanvas, 0, 0, c.width, c.height);
    if ($('showGrid').checked && z >= 4) gridLines(ctx, r.width, r.height, z, 1, 1, 'rgba(0, 0, 0, 0.25)');
  }

  function gridLines(ctx, nx, ny, z, fx, fy, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const vx = Math.round(nx * fx), vy = Math.round(ny * fy);
    for (let i = 0; i <= vx; i++) { const p = i * z + 0.5; ctx.moveTo(p, 0); ctx.lineTo(p, ny * z); }
    for (let j = 0; j <= vy; j++) { const p = j * z + 0.5; ctx.moveTo(0, p); ctx.lineTo(nx * z, p); }
    ctx.stroke();
  }

  // Construction animee : la grille se trace sur l'original estompe, puis
  // les cellules se remplissent ligne par ligne avec les vraies couleurs.
  function animateBuild() {
    stopAnim();
    const it = state.selected, c = $('cvAfter');
    const r = it.result, z = zoomFor(r);
    $('zoomVal').textContent = '×' + z;
    c.width = r.width * z; c.height = r.height * z;
    const ctx = c.getContext('2d');
    const cr = cropOf(it);
    const nx = r.width, ny = r.height, data = r.data;
    const T1 = 450, T2 = 1600;
    let start = 0, drawn = 0;
    const ghost = () => {
      ctx.clearRect(0, 0, c.width, c.height);
      if (it.srcCanvas) {
        ctx.globalAlpha = 0.35;
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(it.srcCanvas, cr.x0, cr.y0, cr.w, cr.h, 0, 0, c.width, c.height);
        ctx.globalAlpha = 1;
      }
    };
    const anim = { raf: 0, done: false };
    state.anim = anim;
    $('btnSkip').hidden = false;
    const frame = (t) => {
      if (anim.done) return;
      if (!start) start = t;
      const e = t - start;
      if (e < T1) {
        ghost();
        const f = e / T1;
        gridLines(ctx, nx, ny, z, Math.min(1, f * 2), Math.max(0, f * 2 - 1), 'rgba(255, 70, 70, 0.6)');
      } else if (e < T2) {
        if (!drawn) { ghost(); gridLines(ctx, nx, ny, z, 1, 1, 'rgba(255, 70, 70, 0.6)'); }
        const target = Math.floor(nx * ny * Math.min(1, (e - T1) / (T2 - T1)));
        for (; drawn < target; drawn++) {
          const x = drawn % nx, y = (drawn - x) / nx, p = drawn * 4;
          ctx.clearRect(x * z, y * z, z, z);
          if (data[p + 3]) {
            ctx.fillStyle = 'rgb(' + data[p] + ',' + data[p + 1] + ',' + data[p + 2] + ')';
            ctx.fillRect(x * z, y * z, z, z);
          }
        }
      } else { finishAnim(); return; }
      anim.raf = requestAnimationFrame(frame);
    };
    anim.raf = requestAnimationFrame(frame);
  }

  function stopAnim() {
    if (state.anim) { state.anim.done = true; cancelAnimationFrame(state.anim.raf); state.anim = null; }
    $('btnSkip').hidden = true;
  }
  function finishAnim() { stopAnim(); drawAfter(); }

  $('btnSkip').onclick = finishAnim;
  $('optAnim').onchange = () => store.set('animate', $('optAnim').checked);
  $('showGrid').onchange = () => { drawBefore(); if (!state.anim) drawAfter(); };
  $('zoomIn').onclick = () => { const it = state.selected; if (!it || !it.result) return; state.zoom = Math.min(64, zoomFor(it.result) + 1); drawAfter(); };
  $('zoomOut').onclick = () => { const it = state.selected; if (!it || !it.result) return; state.zoom = Math.max(1, zoomFor(it.result) - 1); drawAfter(); };
  $('zoomFit').onclick = () => { state.zoom = 0; drawAfter(); };
  window.addEventListener('resize', () => { if (state.selected && !state.anim) drawAfter(); });
  document.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (/INPUT|SELECT|TEXTAREA/.test(tag)) return;
    if (!state.selected) return;
    if (state.anim && (e.key === ' ' || e.key === 'Escape')) { e.preventDefault(); finishAnim(); return; }
    if (e.key === 'Escape') closeDetail();
    else if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
  });

  // ============================================================ traitement (mode fichiers)

  const tick = () => new Promise((r) => setTimeout(r, 0));

  function setProgress(done, total, label) {
    const p = $('progress');
    if (done === null) { p.hidden = true; return; }
    p.hidden = false;
    $('progressBar').style.width = (total ? Math.round(100 * done / total) : 0) + '%';
    $('progressText').textContent = label;
  }

  let timer = 0;
  function schedule() { clearTimeout(timer); timer = setTimeout(processAll, 120); }

  function setStatus(it, s) {
    if (it.status === s) return;
    it.status = s;
    if (it.tile) updateTile(it);
  }

  async function processAll() {
    if (state.server) return;
    const run = ++state.run;
    const g = globalOpts();
    const items = state.items.slice();
    const total = items.length;
    for (let i = 0; i < total; i++) {
      const it = items[i];
      if (!it.img && !it.error) {
        setProgress(i, total, 'Lecture ' + (i + 1) + '/' + total);
        try { const d = await decodeBlob(it.file); it.img = d.img; it.srcCanvas = d.canvas; } catch (e) { it.error = 'Lecture impossible'; setStatus(it, 'error'); }
        if (run !== state.run) return;
        if (it.tile) updateTile(it);
      }
      if (it.error) continue;
      const o = applyOverrides(Object.assign({}, g), it.ov);
      if (it.aKey !== analysisKey(it, o)) {
        setProgress(i, total, 'Analyse ' + (i + 1) + '/' + total);
        setStatus(it, 'processing');
        await tick();
        if (run !== state.run) return;
        try {
          it.analysis = PC.analyze(it.img, o);
          it.aKey = analysisKey(it, o);
          it.aVer++;
        } catch (e) {
          console.error(e);
          it.error = 'Echec du traitement';
          setStatus(it, 'error');
        }
      }
    }
    if (run !== state.run) return;
    const ok = items.filter((it) => it.analysis && !it.error);
    const palKey = JSON.stringify([g.colors, !!g.palette, state.imposedName]);
    if (g.sharedPalette || g.palette) {
      const key = palKey + '|' + ok.map((it) => it.id + ':' + it.aVer).join(',');
      if (state.sharedKey !== key) {
        setProgress(total, total, 'Palette');
        await tick();
        if (run !== state.run) return;
        state.shared = ok.length ? PC.buildPalette(ok.map((it) => it.analysis), g) : null;
        state.sharedKey = key;
      }
      ok.forEach((it) => { it.palette = state.shared; it.pKey = key; });
    } else {
      state.shared = null; state.sharedKey = '';
      for (const it of ok) {
        const key = palKey + '|' + it.aVer;
        if (it.pKey !== key) { it.palette = PC.buildPalette([it.analysis], g); it.pKey = key; }
      }
    }
    for (let i = 0; i < ok.length; i++) {
      const it = ok[i];
      const o = applyOverrides(Object.assign({}, g), it.ov);
      const vKey = it.pKey + '|' + it.aVer + '|' + o.cleanup;
      if (it.vKey !== vKey) {
        setProgress(i, ok.length, 'Réduction ' + (i + 1) + '/' + ok.length);
        await tick();
        if (run !== state.run) return;
        it.idx = PC.reduce(it.img, it.analysis, it.palette, o);
        it.vKey = vKey;
        it.fKey = '';
      }
      const fKey = vKey + '|' + o.cleanOutline + o.outlineMode + o.pixelPerfect;
      if (it.fKey !== fKey) {
        const first = !it.result;
        const c = it.analysis.cells;
        it.result = PC.finalize(it.idx, c.nx, c.ny, it.palette, o);
        it.resultCanvas = toCanvas(it.result);
        it.fKey = fKey;
        setStatus(it, 'done');
        updateTile(it);
        if (it === state.selected) { showDetail(first || it.animateNext); it.animateNext = false; }
      } else setStatus(it, 'done');
    }
    setProgress(null);
    renderGallery();
    renderPalette();
    updateButtons();
  }

  function toCanvas(img) {
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
    return c;
  }

  function renderPalette() {
    const pal = state.shared || (state.selected && state.selected.palette);
    swatches($('swatches'), pal ? pal.hex : []);
    $('palInfo').textContent = pal ? pal.size + ' couleurs' + (state.shared ? ' (commune au lot)' : ' (image affichée)') : '';
  }

  function swatches(box, hex) {
    box.textContent = '';
    for (const h of hex) {
      const s = document.createElement('span');
      s.className = 'sw';
      s.style.background = '#' + h;
      s.title = '#' + h;
      box.appendChild(s);
    }
  }

  function updateButtons() {
    const any = state.items.some((it) => it.result);
    $('btnZip').disabled = !any;
    $('btnSaveDir').disabled = !any;
    $('btnClear').disabled = !state.items.length;
  }

  // ============================================================ reglages

  ['optColors', 'optShared', 'optBg', 'optBgTol', 'optAlpha', 'optCleanup', 'optOutline', 'optOutlineMode',
    'optPP', 'sizeAuto', 'sizeFixed', 'optHeight', 'optWidth', 'optAdaptive'].forEach((id) => {
    $(id).addEventListener('change', schedule);
    if ($(id).type === 'number') $(id).addEventListener('input', schedule);
  });
  function sizeHelp() {
    $('sizeHelp').textContent = $('sizeAuto').checked
      ? 'Grille de pixels détectée si possible ; sinon la hauteur ci-dessus.'
      : 'Toutes les images sortent à cette taille (le sujet tient dans hauteur × largeur, proportions gardées).';
  }
  $('sizeAuto').addEventListener('change', sizeHelp);
  $('sizeFixed').addEventListener('change', sizeHelp);
  sizeHelp();

  function readOverrides() {
    const it = state.selected;
    if (!it) return null;
    const n = (id) => { const v = $(id).value.trim(); if (v === '') return null; const x = Number(v.replace(',', '.')); return Number.isFinite(x) ? x : null; };
    it.ov = { mode: $('ovMode').value, force: '', pixelSize: n('ovSize') || 0, offsetX: n('ovOffX'), offsetY: n('ovOffY'), targetHeight: n('ovTarget') || 0, targetWidth: n('ovWidth') || 0 };
    if (!state.server) schedule();
    return it.ov;
  }
  ['ovMode', 'ovSize', 'ovOffX', 'ovOffY', 'ovTarget', 'ovWidth'].forEach((id) => {
    $(id).addEventListener('change', readOverrides);
    if ($(id).type === 'number') $(id).addEventListener('input', readOverrides);
  });
  $('ovReset').onclick = () => {
    ['ovSize', 'ovOffX', 'ovOffY', 'ovTarget', 'ovWidth'].forEach((id) => { $(id).value = ''; });
    $('ovMode').value = '';
    readOverrides();
    if (state.server) applyServerOverrides();
  };

  $('btnReprocess').onclick = () => {
    const it = state.selected;
    if (!it) return;
    it.animateNext = true;
    if (state.server) { api('/api/process', { paths: [it.relPath] }).catch((e) => alert(e.message)); setStatus(it, 'processing'); return; }
    it.aKey = '';
    schedule();
  };

  // palette imposee
  $('btnPal').onclick = () => $('inPal').click();
  $('inPal').onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    let pal = [];
    try {
      if (/\.png$/i.test(f.name) || f.type === 'image/png') pal = PC.paletteFromImage((await decodeBlob(f)).img);
      else pal = PC.parsePaletteText(await f.text());
    } catch (err) { pal = []; }
    if (!pal.length) { $('palName').textContent = 'Palette illisible : ' + f.name; return; }
    state.imposed = pal;
    state.imposedName = f.name + ':' + pal.length;
    $('palName').textContent = f.name + ' (' + pal.length + ' couleurs)';
    $('btnPalClear').hidden = false;
    schedule();
  };
  $('btnPalClear').onclick = () => {
    state.imposed = null; state.imposedName = '';
    $('palName').textContent = '.hex, .gpl (GIMP) ou image PNG de palette';
    $('btnPalClear').hidden = true;
    schedule();
  };

  // ============================================================ export (mode fichiers)

  function outName(relPath, used) {
    const base = relPath.replace(/\.[^./\\]+$/, '');
    let name = base + '.png', k = 2;
    while (used.has(name.toLowerCase())) name = base + '-' + (k++) + '.png';
    used.add(name.toLowerCase());
    return name;
  }

  function canvasBlob(c) { return new Promise((res) => c.toBlob(res, 'image/png')); }

  function exportFiles() {
    const scale = Number($('optScale').value) || 0;
    const used = new Set(), files = [], colors = new Map();
    for (const it of state.items) {
      if (!it.result) continue;
      const name = outName(it.relPath, used);
      files.push({ path: name, canvas: it.resultCanvas });
      if (scale > 1) files.push({ path: 'x' + scale + '/' + name, canvas: toCanvas(PC.scaleNearest(it.result, scale)) });
      for (const h of it.palette.hex) colors.set(h, true);
    }
    const pal = state.shared ? state.shared.hex : Array.from(colors.keys());
    return { files, paletteText: pal.join('\r\n') + '\r\n' };
  }

  $('btnZip').onclick = async () => {
    if (typeof JSZip === 'undefined') { alert('JSZip n\'a pas pu être chargé (connexion internet requise pour le .zip). Utilisez « Enregistrer dans un dossier… ».'); return; }
    const { files, paletteText } = exportFiles();
    const zip = new JSZip();
    for (let i = 0; i < files.length; i++) {
      setProgress(i, files.length, 'Export ' + (i + 1) + '/' + files.length);
      zip.file(files[i].path, await canvasBlob(files[i].canvas));
    }
    zip.file('palette.hex', paletteText);
    setProgress(files.length, files.length, 'Compression…');
    const blob = await zip.generateAsync({ type: 'blob' });
    setProgress(null);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'pixel-clean.zip';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  };

  if (window.showDirectoryPicker) {
    $('btnSaveDir').hidden = false;
    $('btnSaveDir').onclick = async () => {
      let root;
      try { root = await window.showDirectoryPicker({ mode: 'readwrite' }); } catch (e) { return; }
      // nouveau sous-dossier a chaque export : rien d'existant n'est jamais ecrase
      let name = 'pixel-clean', k = 2;
      for (;;) {
        try { await root.getDirectoryHandle(name); name = 'pixel-clean-' + (k++); } catch (e) { break; }
      }
      const out = await root.getDirectoryHandle(name, { create: true });
      const { files, paletteText } = exportFiles();
      const write = async (p, data) => {
        const parts = p.split('/');
        let dir = out;
        for (const s of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(s, { create: true });
        const fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
        const w = await fh.createWritable();
        await w.write(data);
        await w.close();
      };
      try {
        for (let i = 0; i < files.length; i++) {
          setProgress(i, files.length, 'Enregistrement ' + (i + 1) + '/' + files.length);
          await write(files[i].path, await canvasBlob(files[i].canvas));
        }
        await write('palette.hex', paletteText);
        setProgress(files.length, files.length, 'Enregistré dans « ' + name + ' »');
        setTimeout(() => setProgress(null), 2500);
      } catch (e) {
        console.error(e);
        setProgress(null);
        alert('Enregistrement impossible : ' + e.message);
      }
    };
  }

  // ============================================================ vue connectee (serveur)

  async function api(url, body) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Unslop': '1' },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
  }

  async function loadTree() {
    const r = await fetch('/api/tree');
    if (!r.ok) return;
    const t = await r.json();
    const byRel = new Map(state.items.map((it) => [it.relPath, it]));
    const next = [];
    let reloadSel = false;
    for (const f of t.files) {
      let it = byRel.get(f.rel);
      if (!it) it = newItem(f.rel);
      const outChanged = it.outMtime !== f.outMtime || it.srcMtime !== f.srcMtime;
      Object.assign(it, {
        status: f.status, outRel: f.outRel, outMtime: f.outMtime, srcMtime: f.srcMtime,
        info: f.info, width: f.width, height: f.height, error: f.status === 'error' ? (f.error || 'Erreur') : '',
      });
      if (f.overrides) it.ov = Object.assign({ mode: f.overrides.sizeMode || '', force: '', pixelSize: 0, offsetX: null, offsetY: null, targetHeight: 0, targetWidth: 0 }, f.overrides);
      if (it === state.selected && outChanged) reloadSel = true;
      if (it.tile) updateTile(it);
      next.push(it);
    }
    state.items = next;
    if (state.selected && !next.includes(state.selected)) closeDetail();
    else if (!state.selected) renderGallery();
    else renderFilters();
    if (reloadSel) loadServerDetail(state.selected, true);
  }

  async function loadServerDetail(it, animate) {
    const token = (it.loadToken = (it.loadToken || 0) + 1);
    $('vName').textContent = it.relPath;
    $('vInfo').textContent = infoText(it);
    try {
      const opt = await (await fetch('/api/options?path=' + encodeURIComponent(it.relPath))).json();
      if (!it.img || it.imgMtime !== it.srcMtime) {
        const d = await decodeBlob(await (await fetch('/api/source?path=' + encodeURIComponent(it.relPath) + '&v=' + Math.round(it.srcMtime))).blob());
        it.img = d.img; it.srcCanvas = d.canvas; it.imgMtime = it.srcMtime;
        it.analysis = null;
      }
      if (token !== it.loadToken) return;
      const core = Object.assign({}, opt.core);
      if (opt.palette) core.palette = opt.palette;
      const key = JSON.stringify(core) + it.srcMtime;
      if (!it.analysis || it.optKey !== key) { it.analysis = PC.analyze(it.img, core); it.optKey = key; }
      if (it.outRel) {
        const d = await decodeBlob(await (await fetch('/api/output?path=' + encodeURIComponent(it.outRel) + '&v=' + Math.round(it.outMtime))).blob());
        it.result = d.img; it.resultCanvas = d.canvas;
        $('vNote').textContent = '';
      } else {
        // pas encore de sortie : apercu calcule ici, non enregistre
        const pal = core.palette ? PC.makePalette(core.palette) : PC.buildPalette([it.analysis], core);
        const idx = PC.reduce(it.img, it.analysis, pal, core);
        it.result = PC.finalize(idx, it.analysis.cells.nx, it.analysis.cells.ny, pal, core);
        it.resultCanvas = toCanvas(it.result);
        $('vNote').textContent = '(aperçu, pas encore enregistré)';
      }
      if (token !== it.loadToken || state.selected !== it) return;
      renderProject(opt);
      showDetail(animate || it.animateNext);
      it.animateNext = false;
    } catch (e) {
      console.error(e);
      $('vInfo').textContent = 'Chargement impossible : ' + e.message;
    }
  }

  function renderProject(opt) {
    const kv = $('projOpts');
    kv.textContent = '';
    if (!opt) return;
    const c = opt.core || {};
    const rows = [
      ['Taille finale', c.targetBy === 'factor' ? 'facteur ' + (c.targetFactor || 8)
        : (c.sizeMode === 'auto' ? 'auto (sinon ' : 'fixe : ') + (c.targetHeight || 32) + ' px de haut' + (c.targetWidth ? ', ' + c.targetWidth + ' px de large maxi' : '') + (c.sizeMode === 'auto' ? ')' : '')],
      ['Couleurs', c.colors ? String(c.colors) : 'auto'],
      ['Palette', opt.palette ? 'imposée (' + opt.palette.length + ')' : (c.sharedPalette === false ? 'par image' : 'commune au lot')],
      ['Contour propre', c.cleanOutline ? (c.outlineMode === 'selective' ? 'sélectif' : 'plus sombre') : 'non'],
      ['Lignes pixel-perfect', c.pixelPerfect ? 'oui' : 'non'],
      ['Fond', c.background === 'keep' ? 'gardé' : 'transparent (auto)'],
      ['Grille', c.force === 'grid' ? 'grille détectée' : c.force === 'target' ? 'taille cible' : 'automatique'],
    ];
    for (const [k, v] of rows) {
      const dt = document.createElement('dt'); dt.textContent = k;
      const dd = document.createElement('dd'); dd.textContent = v;
      kv.append(dt, dd);
    }
    swatches($('projSwatches'), opt.palette ? opt.palette.map((p) => p.map((v) => v.toString(16).padStart(2, '0')).join('')) : []);
    $('projPalInfo').textContent = opt.palette ? '' : 'Pas de palette de projet : conseillé pour un jeu (node cli.js make-palette).';
  }

  async function applyServerOverrides() {
    const it = state.selected;
    if (!it) return;
    const ov = readOverrides();
    const clean = {};
    if (ov.mode) clean.sizeMode = ov.mode;
    if (ov.pixelSize > 0) clean.pixelSize = ov.pixelSize;
    if (ov.offsetX !== null) clean.offsetX = ov.offsetX;
    if (ov.offsetY !== null) clean.offsetY = ov.offsetY;
    if (ov.targetHeight > 0) clean.targetHeight = ov.targetHeight;
    if (ov.targetWidth > 0) clean.targetWidth = ov.targetWidth;
    try {
      await api('/api/overrides', { path: it.relPath, overrides: Object.keys(clean).length ? clean : null });
      it.animateNext = true;
      await api('/api/process', { paths: [it.relPath] });
    } catch (e) { alert(e.message); }
  }
  $('ovApply').onclick = applyServerOverrides;

  $('btnValidate').onclick = async () => { const it = state.selected; if (it) try { await api('/api/status', { path: it.relPath, status: 'validated' }); } catch (e) { alert(e.message); } };
  $('btnReview').onclick = async () => { const it = state.selected; if (it) try { await api('/api/status', { path: it.relPath, status: 'review' }); } catch (e) { alert(e.message); } };
  $('btnMissing').onclick = async () => { try { await api('/api/process', { missing: true }); } catch (e) { alert(e.message); } };

  async function initServer() {
    if (!/^https?:$/.test(location.protocol)) return;
    let info;
    try { const r = await fetch('/api/info'); if (!r.ok) return; info = await r.json(); } catch (e) { return; }
    if (!info || info.mode !== 'server') return;
    state.server = info;
    document.body.classList.add('connected');
    $('fileActions').hidden = true;
    $('serverActions').hidden = false;
    $('settings').hidden = true;
    $('project').hidden = false;
    $('connInfo').textContent = 'Dossier connecté : ' + info.source + ' → ' + info.output;
    $('projConfig').textContent = info.config;
    $('dropHint').hidden = true;
    await loadTree();
    try {
      renderProject(await (await fetch('/api/options?path=' + encodeURIComponent((state.items[0] || {}).relPath || ''))).json());
    } catch (e) { /* pas d'image */ }
    let t = 0;
    const es = new EventSource('/api/events');
    es.addEventListener('tree', () => { clearTimeout(t); t = setTimeout(loadTree, 200); });
    es.addEventListener('error', () => { /* reconnexion automatique */ });
  }

  renderGallery();
  initServer();
})();
