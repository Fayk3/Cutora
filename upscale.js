/**
 * cutora AI upscaler — real ESRGAN inference in the browser (TensorFlow.js).
 *
 * Lazy by design: TF.js (~1.4 MB), the UpscalerJS runtime and the
 * ESRGAN-Slim weights (~0.9 MB per scale) are downloaded ONLY when this
 * tool is opened, and only for the scale the user picks. Nothing here is
 * mocked — progress comes from UpscalerJS per-patch callbacks, output
 * dimensions are the real tensor output, and failures surface as errors.
 *
 * Pinned CDN chain (verified):
 *  tfjs 4.11.0  → window.tf
 *  @upscalerjs/default-model 1.0.0 → window.DefaultUpscalerJSModel (UMD peer)
 *  upscaler 1.0.0 → window.Upscaler
 *  @upscalerjs/esrgan-slim 1.0.0 (x2/x4 defs) → window.ESRGANSlim{2,4}x
 *  weights resolve inside the lib via jsDelivr (fallback unpkg), cached
 *  by the browser afterwards (immutable versioned URLs).
 */
import {
  formatBytes, baseName, toast, validateImageFile, loadImageFile,
  fitToCap, canvasToBlob, downloadBlob, loadScript, wireDropzone,
  onPasteImage, fetchSampleFile,
} from './common.js';
import { isToolActive } from './main.js';

const CDN = {
  tf: 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.11.0/dist/tf.min.js',
  defModel: 'https://cdn.jsdelivr.net/npm/@upscalerjs/default-model@1.0.0/dist/umd/index.min.js',
  core: 'https://cdn.jsdelivr.net/npm/upscaler@1.0.0/dist/browser/umd/upscaler.min.js',
  modelDef: (s) => `https://cdn.jsdelivr.net/npm/@upscalerjs/esrgan-slim@1.0.0/dist/umd/models/esrgan-slim/src/x${s}/index.min.js`,
};
const MODEL_GLOBAL = { 2: 'ESRGANSlim2x', 4: 'ESRGANSlim4x' };
const INPUT_CAP = 1024; // longest side fed to the model (prevents GPU OOM)

const $ = (id) => document.getElementById(id);

let booted = false;
export function initUpscaler() {
  if (booted) return;
  booted = true;

  const els = {
    panel: $('panel-upscale'),
    drop: $('upDrop'), file: $('upFile'), browse: $('upBrowse'), pick: $('upPick'), sample: $('upSample'),
    status: $('upStatus'), thumb: $('upThumb'), title: $('upTitle'), sub: $('upSub'),
    pct: $('upPct'), bar: $('upBar'), log: $('upLog'),
    work: $('upWork'),
    box: $('upCompareBox'), wrap: $('upZoomWrap'),
    before: $('upBefore'), after: $('upAfter'), afterWrap: $('upAfterWrap'),
    slider: $('upSlider'), handle: $('upHandle'),
    zoomIn: $('upZoomIn'), zoomOut: $('upZoomOut'), zoomReset: $('upZoomReset'), zoomLabel: $('upZoomLabel'),
    meta: $('upMeta'),
    done: $('upDone'), doneSub: $('upDoneSub'),
    scale2: $('upScale2'), scale4: $('upScale4'), start: $('upStart'),
    origRes: $('upOrigRes'), outRes: $('upOutRes'), backend: $('upBackend'),
    download: $('upDownload'), again: $('upAgain'), newBtn: $('upNew'), fileInfo: $('upFileInfo'),
    overlay: $('upProcOverlay'), procSub: $('upProcSub'), bar2: $('upBar2'), pct2: $('upPct2'),
    error: $('upError'), errorMsg: $('upErrorMsg'), retry: $('upRetry'), dismiss: $('upDismiss'),
  };

  const state = {
    file: null, fileName: '', origURL: null, origW: 0, origH: 0,
    work: null, workW: 0, workH: 0, fitted: false, hasAlpha: false,
    scale: 2, running: false, hasResult: false,
    outBlob: null, outURL: null, outW: 0, outH: 0,
    z: 1, px: 0, py: 0,
  };
  const engines = {}; // scale -> Upscaler instance (reused = stays warm)

  /* ---------- progress (all real events) ---------- */
  function setProgress(frac, label, log) {
    const pct = Math.round(Math.min(1, Math.max(0, frac)) * 100);
    for (const [bar, p] of [[els.bar, els.pct], [els.bar2, els.pct2]]) {
      if (bar) bar.style.width = pct + '%';
      if (p) p.textContent = pct + '%';
    }
    if (label && els.sub) els.sub.textContent = label;
    if (label && els.procSub) els.procSub.textContent = label;
    if (log && els.log) els.log.textContent = log;
  }
  function showError(msg) {
    els.errorMsg.textContent = msg;
    els.error.classList.remove('hidden');
  }
  function hideError() { els.error.classList.add('hidden'); }

  /* ---------- intake ---------- */
  async function handleFiles(list) {
    hideError();
    const file = list[0];
    if (!file || state.running) return;
    const v = validateImageFile(file);
    if (!v.ok) { showError(v.err); toast(v.err, 'err'); return; }
    try {
      setProgress(0.02, 'Reading image…', file.name);
      els.status.classList.remove('hidden');
      els.title.textContent = file.name;
      if (state.origURL) URL.revokeObjectURL(state.origURL);
      const { img, url, w, h } = await loadImageFile(file);
      if (Math.min(w, h) < 8) throw new Error('Image is too small to enhance (under 8px).');
      if (w * h > 50_000_000) throw new Error('Image has too many pixels (over 50 MP).');
      state.file = file; state.fileName = file.name || 'image';
      state.origURL = url; state.origW = w; state.origH = h;
      els.thumb.style.backgroundImage = `url("${url}")`;

      const fit = fitToCap(img, INPUT_CAP);
      state.work = fit.canvas; state.workW = fit.w; state.workH = fit.h; state.fitted = fit.scaled;
      state.hasAlpha = detectAlpha(fit.canvas);
      state.hasResult = false;
      state.outBlob = null;
      if (state.outURL) { URL.revokeObjectURL(state.outURL); state.outURL = null; }

      els.before.src = url;
      els.after.removeAttribute('src');
      els.afterWrap.style.width = '50%';
      els.handle.style.left = '50%';
      els.slider.value = 50;
      resetZoom();
      els.work.classList.remove('hidden');
      els.done.classList.add('hidden');
      els.download.disabled = true;
      els.origRes.textContent = `${w}×${h}px`;
      els.outRes.textContent = `${fit.w * state.scale}×${fit.h * state.scale}px (at ${state.scale}×)`;
      els.backend.textContent = 'engine loads on first run';
      els.fileInfo.innerHTML = `<b>${baseName(state.fileName)}</b> · ${formatBytes(file.size)}` +
        (fit.scaled ? `<br>Working copy fitted to ${fit.w}×${fit.h}px for in-browser inference` : `<br>Full resolution fed to the model`);
      els.meta.textContent = `${w}×${h}px`;
      setProgress(1, fit.scaled ? `Ready — fitted to ${fit.w}×${fit.h}px` : 'Ready', 'pick a scale, then Enhance');
      els.work.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) {
      console.error(err);
      showError(err.message || String(err));
    }
  }

  function detectAlpha(canvas) {
    try {
      const g = canvas.getContext('2d', { willReadFrequently: true });
      const d = g.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 3; i < d.length; i += 64) {
        if (d[i] < 250) return true;
      }
      return false;
    } catch { return false; }
  }

  wireDropzone({ zone: els.drop, input: els.file, onFiles: handleFiles });
  els.browse.addEventListener('click', (e) => { e.stopPropagation(); els.file.click(); });
  els.pick.addEventListener('click', (e) => { e.stopPropagation(); els.file.click(); });
  els.sample.addEventListener('click', async (e) => {
    e.stopPropagation();
    toast('Loading sample image…');
    try {
      await handleFiles([await fetchSampleFile()]);
    } catch { showError('Sample failed to load. Check your connection or upload your own image.'); }
  });
  onPasteImage(() => isToolActive('upscale'), (f) => handleFiles([f]));

  /* ---------- scale select ---------- */
  function setScale(s) {
    state.scale = s;
    els.scale2.classList.toggle('active', s === 2);
    els.scale4.classList.toggle('active', s === 4);
    els.start.textContent = `Enhance ${s}×`;
    if (state.workW) els.outRes.textContent = `${state.workW * s}×${state.workH * s}px (at ${s}×)`;
  }
  els.scale2.addEventListener('click', () => setScale(2));
  els.scale4.addEventListener('click', () => setScale(4));

  /* ---------- lazy engine ---------- */
  async function ensureEngine(scale, report) {
    if (engines[scale]) return engines[scale];
    const need = [];
    if (!window.tf) need.push(['tf.js runtime', CDN.tf, 'window.tf']);
    if (!window.DefaultUpscalerJSModel) need.push(['model loader', CDN.defModel, 'window.DefaultUpscalerJSModel']);
    if (!window.Upscaler) need.push(['upscaler core', CDN.core, 'window.Upscaler']);
    need.push([`ESRGAN-Slim ${scale}× weights`, CDN.modelDef(scale), `window.${MODEL_GLOBAL[scale]}`]);
    let done = 0;
    for (const [label, src] of need) {
      report(done / need.length, `Downloading ${label}…`);
      await loadScript(src);
      done += 1;
    }
    if (!window.tf || !window.Upscaler || !window[MODEL_GLOBAL[scale]]) {
      throw new Error('Enhancement engine failed to initialise (a CDN script did not register). Check your connection and try again.');
    }
    report(1, 'Engine ready');
    const inst = new window.Upscaler({ model: window[MODEL_GLOBAL[scale]] });
    engines[scale] = inst;
    return inst;
  }

  /* ---------- enhance ---------- */
  async function start() {
    if (!state.work || state.running) return;
    hideError();
    state.running = true;
    els.start.disabled = true;
    els.download.disabled = true;
    els.overlay.classList.remove('hidden');
    const t0 = performance.now();
    try {
      // 0 → 10%: versioned CDN scripts (browser-cached after first run)
      await ensureEngine(state.scale, (f, label) => setProgress(f * 0.1, label, 'lazy-loaded on first use'));
      // 10 → 14%: warmup / shader compile happens inside first inference
      setProgress(0.12, 'Warming up…', `patching ${state.workW}×${state.workH}px in 128px tiles`);
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));

      const rgb = flattenRGB(state.work);
      const engine = engines[state.scale];
      const out = await engine.upscale(rgb, {
        output: 'base64',
        patchSize: 128,
        padding: 4,
        progress: (p) => {
          const f = typeof p === 'number' ? (p > 1 ? p / 100 : p) : 0;
          setProgress(0.14 + Math.min(1, Math.max(0, f)) * 0.84, `Enhancing… ${Math.round(f * 100)}%`, 'real per-patch progress');
        },
      });

      setProgress(0.99, 'Assembling output…', 'merging tiles');
      await new Promise((r) => setTimeout(r, 20));
      const blob = await buildOutput(out);
      const dt = ((performance.now() - t0) / 1000).toFixed(1);
      if (state.outURL) URL.revokeObjectURL(state.outURL);
      state.outURL = URL.createObjectURL(blob);
      state.outBlob = blob;
      state.hasResult = true;

      els.after.src = state.outURL;
      els.afterWrap.style.width = '50%';
      els.handle.style.left = '50%';
      els.slider.value = 50;
      els.outRes.textContent = `${state.outW}×${state.outH}px (at ${state.scale}×)`;
      els.backend.textContent = backendLabel();
      els.done.classList.remove('hidden');
      els.doneSub.textContent = `${state.origW}×${state.origH}px → ${state.outW}×${state.outH}px in ${dt}s · ${backendLabel()}`;
      els.meta.textContent = `${state.outW}×${state.outH}px · ${dt}s`;
      els.fileInfo.innerHTML += `<br>Enhanced: ${formatBytes(blob.size)} · ${dt}s`;
      els.download.disabled = false;
      setProgress(1, 'Done', `finished in ${dt}s`);
      toast('Image enhanced ✓');
    } catch (err) {
      console.error(err);
      const msg = err?.message || String(err);
      if (/memory|allocation|texture|too large/i.test(msg)) {
        showError('The GPU ran out of memory on this image. Try a smaller image or 2× instead of 4×.');
      } else if (/Failed to load|fetch|network/i.test(msg)) {
        showError('Engine download failed. Check your connection and click Enhance again — files resume from cache.');
      } else {
        showError('Enhancement failed: ' + msg);
      }
      toast('Enhancement failed', 'err');
    } finally {
      state.running = false;
      els.start.disabled = false;
      els.overlay.classList.add('hidden');
    }
  }

  function backendLabel() {
    try {
      const b = window.tf?.getBackend?.();
      if (b === 'webgl') return 'GPU · WebGL';
      if (b === 'wasm') return 'WASM';
      if (b === 'cpu') return 'CPU fallback';
      return b || 'local';
    } catch { return 'local'; }
  }

  function flattenRGB(canvas) {
    const c = document.createElement('canvas');
    c.width = canvas.width; c.height = canvas.height;
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(canvas, 0, 0);
    return c;
  }

  async function buildOutput(dataURL) {
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('Could not decode model output.'));
      im.src = dataURL;
    });
    state.outW = img.naturalWidth;
    state.outH = img.naturalHeight;
    const c = document.createElement('canvas');
    c.width = state.outW; c.height = state.outH;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    if (state.hasAlpha) {
      // Preserve transparency with a separate high-quality alpha pass
      const a = upscaleAlpha(state.work, state.outW, state.outH);
      const out = g.getImageData(0, 0, c.width, c.height);
      for (let i = 0, j = 0; i < out.data.length; i += 4, j += 1) out.data[i + 3] = a[j];
      g.putImageData(out, 0, 0);
    }
    return canvasToBlob(c, 'image/png');
  }

  function upscaleAlpha(srcCanvas, w, h) {
    const src = srcCanvas.getContext('2d', { willReadFrequently: true })
      .getImageData(0, 0, srcCanvas.width, srcCanvas.height);
    const gray = document.createElement('canvas');
    gray.width = srcCanvas.width; gray.height = srcCanvas.height;
    const gg = gray.getContext('2d');
    const gi = gg.createImageData(gray.width, gray.height);
    for (let i = 0, j = 0; i < src.data.length; i += 4, j += 1) {
      gi.data[j * 4] = gi.data[j * 4 + 1] = gi.data[j * 4 + 2] = src.data[i + 3];
      gi.data[j * 4 + 3] = 255;
    }
    gg.putImageData(gi, 0, 0);
    const big = document.createElement('canvas');
    big.width = w; big.height = h;
    const bg = big.getContext('2d');
    bg.imageSmoothingEnabled = true;
    bg.imageSmoothingQuality = 'high';
    // stepwise for smoother large jumps
    let cur = gray;
    while (cur.width * 2 <= w && cur.height * 2 <= h && (cur.width < w / 2 || cur.height < h / 2)) {
      const step = document.createElement('canvas');
      step.width = Math.min(w, cur.width * 2); step.height = Math.min(h, cur.height * 2);
      const sg = step.getContext('2d');
      sg.imageSmoothingEnabled = true; sg.imageSmoothingQuality = 'high';
      sg.drawImage(cur, 0, 0, step.width, step.height);
      cur = step;
    }
    bg.drawImage(cur, 0, 0, w, h);
    const out = bg.getImageData(0, 0, w, h).data;
    const alpha = new Uint8Array(w * h);
    for (let i = 0, j = 0; i < out.length; i += 4, j += 1) alpha[j] = out[i];
    return alpha;
  }

  els.start.addEventListener('click', start);
  els.again.addEventListener('click', start);
  els.retry.addEventListener('click', () => { hideError(); start(); });
  els.dismiss.addEventListener('click', hideError);

  els.download.addEventListener('click', () => {
    if (!state.outBlob) { toast('Nothing to download yet', 'err'); return; }
    downloadBlob(state.outBlob, `${baseName(state.fileName)}-${state.scale}x.png`);
    toast(`Exported ${state.outW}×${state.outH}px PNG (${formatBytes(state.outBlob.size)})`);
  });

  els.newBtn.addEventListener('click', () => {
    hideError();
    if (state.origURL) URL.revokeObjectURL(state.origURL);
    if (state.outURL) URL.revokeObjectURL(state.outURL);
    Object.assign(state, {
      file: null, fileName: '', origURL: null, origW: 0, origH: 0,
      work: null, workW: 0, workH: 0, fitted: false, hasAlpha: false,
      running: false, hasResult: false, outBlob: null, outURL: null, outW: 0, outH: 0,
    });
    els.work.classList.add('hidden');
    els.status.classList.add('hidden');
    els.download.disabled = true;
    setProgress(0, '', '');
  });

  /* ---------- compare slider + zoom/pan ---------- */
  els.slider.addEventListener('input', () => {
    const v = Number(els.slider.value);
    els.afterWrap.style.width = v + '%';
    els.handle.style.left = v + '%';
  });
  function applyZoom() {
    els.wrap.style.transform = `translate(${state.px}px, ${state.py}px) scale(${state.z})`;
    els.zoomLabel.textContent = Math.round(state.z * 100) + '%';
  }
  function resetZoom() {
    state.z = 1; state.px = 0; state.py = 0;
    applyZoom();
  }
  els.zoomIn.addEventListener('click', () => { state.z = Math.min(4, state.z * 1.25); applyZoom(); });
  els.zoomOut.addEventListener('click', () => { state.z = Math.max(1, state.z / 1.25); if (state.z === 1) { state.px = state.py = 0; } applyZoom(); });
  els.zoomReset.addEventListener('click', resetZoom);
  els.box.addEventListener('wheel', (e) => {
    e.preventDefault();
    state.z = Math.min(4, Math.max(1, state.z * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
    if (state.z === 1) { state.px = state.py = 0; }
    applyZoom();
  }, { passive: false });

  let panning = false, last = null;
  els.box.addEventListener('pointerdown', (e) => {
    if (e.target === els.slider || state.z <= 1) return;
    panning = true;
    last = { x: e.clientX, y: e.clientY };
    try { els.box.setPointerCapture(e.pointerId); } catch { /* noop */ }
  });
  els.box.addEventListener('pointermove', (e) => {
    if (!panning || !last) return;
    const r = els.box.getBoundingClientRect();
    const maxX = (r.width * (state.z - 1)) / 2;
    const maxY = (r.height * (state.z - 1)) / 2;
    state.px = Math.max(-maxX, Math.min(maxX, state.px + e.clientX - last.x));
    state.py = Math.max(-maxY, Math.min(maxY, state.py + e.clientY - last.y));
    last = { x: e.clientX, y: e.clientY };
    applyZoom();
  });
  const endPan = () => { panning = false; last = null; };
  els.box.addEventListener('pointerup', endPan);
  els.box.addEventListener('pointercancel', endPan);

  applyZoom();
  setScale(2);
}
