/**
 * cutora image resizer — exact dimensions, ratio lock, presets, % scaling,
 * format + quality choice, real byte-accurate output size.
 *
 * Rendering runs in js/resize.worker.js (OffscreenCanvas) with an identical
 * main-thread fallback, debounced so typing never janks. The displayed file
 * size is the real encoded Blob, re-rendered on every change — no estimates.
 */
import {
  formatBytes, baseName, toast, validateImageFile, loadImageFile,
  canvasToBlob, downloadBlob, wireDropzone, onPasteImage,
  fetchSampleFile, debounce,
} from './common.js';
import { isToolActive } from './main.js';

const $ = (id) => document.getElementById(id);
const MAX_DIM = 12000;

let booted = false;
export function initResizer() {
  if (booted) return;
  booted = true;

  const els = {
    panel: $('panel-resize'),
    drop: $('rsDrop'), file: $('rsFile'), browse: $('rsBrowse'), pick: $('rsPick'), sample: $('rsSample'),
    work: $('rsWork'),
    preview: $('rsPreview'),
    w: $('rsW'), h: $('rsH'), lock: $('rsLock'), pct: $('rsPct'), pctVal: $('rsPctVal'),
    format: $('rsFormat'), qrow: $('rsQRow'), quality: $('rsQuality'), qval: $('rsQVal'),
    origDims: $('rsOrigDims'), outDims: $('rsOutDims'), outSize: $('rsOutSize'), note: $('rsNote'),
    download: $('rsDownload'), newBtn: $('rsNew'), fileInfo: $('rsFileInfo'),
  };

  const state = {
    img: null, url: null, fileName: '', natW: 0, natH: 0,
    locked: true, format: 'image/png', quality: 92,
    outBlob: null, outURL: null, seq: 0,
    bitmap: null, worker: null, workerDead: false,
  };

  /* ---------- intake ---------- */
  async function handleFiles(list) {
    const file = list[0];
    if (!file) return;
    const v = validateImageFile(file);
    if (!v.ok) { toast(v.err, 'err'); return; }
    try {
      if (state.url) URL.revokeObjectURL(state.url);
      if (state.bitmap) { try { state.bitmap.close(); } catch { /* noop */ } state.bitmap = null; }
      const { img, url, w, h } = await loadImageFile(file);
      if (w * h > 80_000_000) throw new Error('Image has too many pixels (over 80 MP).');
      state.img = img; state.url = url; state.fileName = file.name || 'image';
      state.natW = w; state.natH = h;
      try {
        state.bitmap = await createImageBitmap(file);
      } catch { state.bitmap = null; }
      els.w.value = w;
      els.h.value = h;
      els.pct.value = 100;
      if (els.pctVal) els.pctVal.textContent = '100%';
      els.origDims.textContent = `${w}×${h}px · ${formatBytes(file.size)}`;
      els.fileInfo.innerHTML = `<b>${baseName(state.fileName)}</b> · ${w}×${h}px`;
      els.work.classList.remove('hidden');
      scheduleRender();
      els.work.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) {
      console.error(err);
      toast(err.message || String(err), 'err');
    }
  }

  wireDropzone({ zone: els.drop, input: els.file, onFiles: handleFiles });
  els.browse.addEventListener('click', (e) => { e.stopPropagation(); els.file.click(); });
  els.pick.addEventListener('click', (e) => { e.stopPropagation(); els.file.click(); });
  els.sample.addEventListener('click', async (e) => {
    e.stopPropagation();
    toast('Loading sample image…');
    try {
      await handleFiles([await fetchSampleFile()]);
    } catch { toast('Sample failed to load. Check your connection.', 'err'); }
  });
  onPasteImage(() => isToolActive('resize'), (f) => handleFiles([f]));

  /* ---------- controls ---------- */
  function clampDim(n, fallback) {
    n = Math.round(Number(n));
    if (!isFinite(n)) return fallback;
    return Math.min(MAX_DIM, Math.max(1, n));
  }
  function targets() {
    return { w: clampDim(els.w.value, state.natW), h: clampDim(els.h.value, state.natH) };
  }
  function syncPct() {
    if (!state.natW) return;
    const p = Math.round((Number(els.w.value) / state.natW) * 100);
    els.pct.value = Math.min(400, Math.max(1, p));
    if (els.pctVal) els.pctVal.textContent = p + '%';
  }

  els.w.addEventListener('input', () => {
    const w = clampDim(els.w.value, state.natW);
    if (state.locked && state.natW) els.h.value = clampDim((w * state.natH) / state.natW, state.natH);
    syncPct();
    scheduleRender();
  });
  els.h.addEventListener('input', () => {
    const h = clampDim(els.h.value, state.natH);
    if (state.locked && state.natH) els.w.value = clampDim((h * state.natW) / state.natH, state.natW);
    syncPct();
    scheduleRender();
  });
  els.lock.addEventListener('click', () => {
    state.locked = !state.locked;
    els.lock.textContent = state.locked ? '🔗 Ratio locked' : '🔓 Ratio free';
    els.lock.setAttribute('aria-pressed', String(state.locked));
    els.lock.classList.toggle('on', state.locked);
  });
  els.pct.addEventListener('input', () => {
    let p = Number(els.pct.value);
    if (!isFinite(p)) return;
    p = Math.min(400, Math.max(1, p));
    if (els.pctVal) els.pctVal.textContent = Math.round(p) + '%';
    els.w.value = clampDim((state.natW * p) / 100, state.natW);
    els.h.value = state.locked
      ? clampDim((state.natH * p) / 100, state.natH)
      : Number(els.h.value) || state.natH;
    scheduleRender();
  });
  document.querySelectorAll('.rs-preset').forEach((b) => {
    b.addEventListener('click', () => {
      const w = Number(b.dataset.w);
      const h = Number(b.dataset.h);
      if (!w || !h) return;
      if (state.locked) {
        // Fit preset box inside ratio: match width, derive height
        els.w.value = Math.min(w, MAX_DIM);
        els.h.value = clampDim((Number(els.w.value) * state.natH) / state.natW, state.natH);
      } else {
        els.w.value = Math.min(w, MAX_DIM);
        els.h.value = Math.min(h, MAX_DIM);
      }
      syncPct();
      scheduleRender();
    });
  });
  els.format.addEventListener('change', () => {
    state.format = els.format.value;
    const lossy = state.format !== 'image/png';
    els.qrow.classList.toggle('hidden', !lossy);
    scheduleRender();
  });
  els.quality.addEventListener('input', () => {
    state.quality = Number(els.quality.value);
    els.qval.textContent = state.quality + '%';
    scheduleRender();
  });

  /* ---------- render (worker → fallback) ---------- */
  const scheduleRender = debounce(() => render(), 200);

  function ensureWorker() {
    if (state.worker || state.workerDead) return state.worker;
    try {
      if (!('Worker' in window) || typeof OffscreenCanvas === 'undefined') return null;
      state.worker = new Worker(new URL('./resize.worker.js', import.meta.url));
      state.worker.addEventListener('error', () => {
        state.workerDead = true;
        try { state.worker.terminate(); } catch { /* noop */ }
        state.worker = null;
      });
      return state.worker;
    } catch {
      return null;
    }
  }

  function renderMainThread(w, h) {
    const src = state.bitmap || state.img;
    const sw = src.width || state.natW;
    const sh = src.height || state.natH;
    let cur = document.createElement('canvas');
    cur.width = sw; cur.height = sh;
    cur.getContext('2d').drawImage(src, 0, 0);
    const stepTo = (tw, th) => {
      const c = document.createElement('canvas');
      c.width = tw; c.height = th;
      const g = c.getContext('2d');
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      g.drawImage(cur, 0, 0, tw, th);
      cur = c;
    };
    let cw = sw, ch = sh, guard = 0;
    while (cw / 2 >= w && ch / 2 >= h && (cw > w * 1.5 || ch > h * 1.5) && guard++ < 12) {
      const tw = Math.max(w, Math.round(cw / 2));
      const th = Math.max(h, Math.round(ch / 2));
      stepTo(tw, th); cw = tw; ch = th;
    }
    guard = 0;
    while ((cw < w || ch < h) && (cw * 2 <= w * 1.6 || ch * 2 <= h * 1.6) && guard++ < 8) {
      const tw = Math.min(w, cw * 2);
      const th = Math.min(h, ch * 2);
      stepTo(tw, th); cw = tw; ch = th;
    }
    if (cw !== w || ch !== h) stepTo(w, h);
    return canvasToBlob(cur, state.format, state.quality / 100);
  }

  function workerRender(w, h, seq) {
    return new Promise((resolve) => {
      const worker = ensureWorker();
      if (!worker || !state.bitmap) { resolve(null); return; } // signal: use fallback
      const timer = setTimeout(() => resolve(null), 30000); // hung worker → fallback
      const onMsg = (e) => {
        if (!e.data || e.data.id !== seq) return;
        worker.removeEventListener('message', onMsg);
        clearTimeout(timer);
        resolve(e.data.ok ? e.data.blob : new Error(e.data.error || 'Worker failed'));
      };
      worker.addEventListener('message', onMsg);
      try {
        worker.postMessage({ id: seq, bitmap: state.bitmap, w, h, format: state.format, quality: state.quality });
      } catch (err) {
        worker.removeEventListener('message', onMsg);
        clearTimeout(timer);
        resolve(null);
      }
    });
  }

  async function render() {
    if (!state.img) return;
    const { w, h } = targets();
    const seq = ++state.seq;
    els.note.textContent = 'Rendering…';
    els.download.disabled = true;
    try {
      let blob = await workerRender(w, h, seq);
      if (blob instanceof Error) throw blob;
      if (!blob) blob = await renderMainThread(w, h); // worker unavailable → identical path
      if (seq !== state.seq) { return; } // stale: a newer render won
      if (state.outURL) URL.revokeObjectURL(state.outURL);
      state.outBlob = blob;
      state.outURL = URL.createObjectURL(blob);
      els.preview.src = state.outURL;
      els.outDims.textContent = `${w}×${h}px`;
      els.outSize.textContent = formatBytes(blob.size);
      const ext = (blob.type.split('/')[1] || 'png').toUpperCase();
      els.note.textContent = blob.type && blob.type !== state.format
        ? `Rendered ✓ — this browser exports ${ext} instead of the requested format`
        : `Rendered ✓ — ${ext} · ${w}×${h}px`;
      els.download.disabled = false;
    } catch (err) {
      console.error(err);
      if (seq === state.seq) els.note.textContent = 'Render failed: ' + (err.message || err);
    }
  }

  /* ---------- actions ---------- */
  els.download.addEventListener('click', () => {
    if (!state.outBlob) { toast('Nothing to download yet', 'err'); return; }
    const { w } = targets();
    const ext = (state.outBlob.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
    downloadBlob(state.outBlob, `${baseName(state.fileName)}-${w}px.${ext}`);
    toast(`Exported ${formatBytes(state.outBlob.size)}`);
  });

  els.newBtn.addEventListener('click', () => {
    if (state.url) URL.revokeObjectURL(state.url);
    if (state.outURL) URL.revokeObjectURL(state.outURL);
    if (state.bitmap) { try { state.bitmap.close(); } catch { /* noop */ } }
    Object.assign(state, {
      img: null, url: null, fileName: '', natW: 0, natH: 0,
      outBlob: null, outURL: null, bitmap: null,
    });
    els.work.classList.add('hidden');
    els.download.disabled = true;
  });

  els.lock.textContent = '🔗 Ratio locked';
  els.lock.classList.add('on');
}
