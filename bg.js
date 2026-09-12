import { ImglyProvider } from './providers.js';

/* ============================================================
   Cutora — open-source background remover (local-first)
   Flow: upload → validate → optimize → cutout → refine → export
   Swap the segmentation backend by replacing `activeProvider`
   (see providers.js). MIT licensed.
   ============================================================ */

const activeProvider = ImglyProvider;

const MAX_FILE_MB = 25;
const MAX_DIM = 2048;          // downscale above this to prevent crashes
const ACCEPTED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const UNDO_LIMIT = 12; // capped: each snapshot is W*H*4 bytes (2048² ≈ 16MB)

const $ = (id) => document.getElementById(id);

const els = {
  uploadView: $('uploadView'),
  workView: $('workView'),
  dropzone: $('dropzone'),
  fileInput: $('fileInput'),
  browseBtn: $('browseBtn'),
  pickBtn: $('pickBtn'),
  sampleBtn: $('sampleBtn'),
  statusStrip: $('statusStrip'),
  statusTitle: $('statusTitle'),
  statusSub: $('statusSub'),
  statusPct: $('statusPct'),
  progressBar: $('progressBar'),
  statusLog: $('statusLog'),
  statusThumb: $('statusThumb'),
  viewport: $('viewport'),
  stage: $('canvasStage'),
  canvas: $('resultCanvas'),
  brushCursor: $('brushCursor'),
  processingOverlay: $('processingOverlay'),
  procSub: $('procSub'),
  progressBar2: $('progressBar2'),
  procPct: $('procPct'),
  tabResult: $('tabResult'),
  tabCompare: $('tabCompare'),
  compareWrap: $('compareWrap'),
  compareBox: $('compareBox'),
  compareOriginal: $('compareOriginal'),
  compareResult: $('compareResult'),
  compareResultWrap: $('compareResultWrap'),
  compareSlider: $('compareSlider'),
  compareHandle: $('compareHandle'),
  zoomOut: $('zoomOutBtn'),
  zoomIn: $('zoomInBtn'),
  zoomReset: $('zoomResetBtn'),
  zoomLabel: $('zoomLabel'),
  toolHint: $('toolHint'),
  imgMeta: $('imgMeta'),
  bgColor: $('bgColor'),
  customSw: $('customSw'),
  eraseBtn: $('eraseBtn'),
  restoreBtn: $('restoreBtn'),
  panBtn: $('panBtn'),
  brushSize: $('brushSize'),
  brushSizeVal: $('brushSizeVal'),
  brushSoft: $('brushSoft'),
  brushSoftVal: $('brushSoftVal'),
  undoBtn: $('undoBtn'),
  redoBtn: $('redoBtn'),
  resetEditsBtn: $('resetEditsBtn'),
  downloadBtn: $('downloadBtn'),
  replaceBtn: $('replaceBtn'),
  reprocessBtn: $('reprocessBtn'),
  newImageBtn: $('newImageBtn'),
  fileInfo: $('fileInfo'),
  successSub: $('successSub'),
  errorBox: $('errorBox'),
  errorTitle: $('errorTitle'),
  errorMsg: $('errorMsg'),
  retryBtn: $('retryBtn'),
  dismissErrorBtn: $('dismissErrorBtn'),
  toasts: $('toasts'),
};

const ctx = els.canvas.getContext('2d', { willReadFrequently: true });

const state = {
  file: null,
  fileName: '',
  optimizedBlob: null,
  originalURL: null,
  resultURL: null,
  originalCanvas: null,   // opaque source scaled to output size (for Restore brush)
  aiImageData: null,      // pristine AI result (for Reset)
  bg: 'transparent',
  tool: 'pan',
  brushSize: 40,
  brushSoft: 50,
  zoom: 1,
  baseFit: 1,
  panX: 0,
  panY: 0,
  undo: [],
  redo: [],
  processing: false,
  hasResult: false,
  origW: 0,
  origH: 0,
  lastFailedFile: null,
};

/* ---------------- helpers ---------------- */

function toast(msg, type = 'ok') {
  const d = document.createElement('div');
  d.className = `toast ${type}`;
  d.textContent = msg;
  els.toasts.appendChild(d);
  setTimeout(() => { d.style.opacity = '0'; d.style.transition = 'opacity .3s'; }, 3200);
  setTimeout(() => d.remove(), 3600);
}

function showError(title, msg) {
  els.errorTitle.textContent = title;
  els.errorMsg.textContent = msg;
  els.errorBox.classList.remove('hidden');
  els.errorBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function hideError() {
  els.errorBox.classList.add('hidden');
}

function setProgress(frac, label, sub) {
  const pct = Math.round(Math.min(1, Math.max(0, frac)) * 100);
  els.progressBar.style.width = pct + '%';
  els.progressBar2.style.width = pct + '%';
  els.statusPct.textContent = pct + '%';
  els.procPct.textContent = pct + '%';
  if (label) {
    els.statusSub.textContent = label;
    els.procSub.textContent = label;
  }
  if (sub) els.statusLog.textContent = sub;
}

function formatBytes(n) {
  if (!n && n !== 0) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

function baseName(name) {
  const b = (name || 'image').split(/[\\/]/).pop().replace(/\.[a-z0-9]+$/i, '');
  return b.replace(/[^\w\-]+/g, '-').slice(0, 60) || 'image';
}

function validateFile(file) {
  if (!file) return { ok: false, err: 'No file selected.' };
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const mimeOk = ACCEPTED_MIME.has(file.type);
  const extOk = ['jpg', 'jpeg', 'png', 'webp'].includes(ext);
  if (!mimeOk && !extOk) {
    return { ok: false, err: `Unsupported format “${file.type || ext || 'unknown'}”. Please use JPG, JPEG, PNG or WebP.` };
  }
  const maxBytes = MAX_FILE_MB * 1024 * 1024;
  if (file.size > maxBytes) {
    return { ok: false, err: `File is ${formatBytes(file.size)} — limit is ${MAX_FILE_MB} MB. Try a smaller image.` };
  }
  if (file.size === 0) return { ok: false, err: 'File is empty.' };
  return { ok: true };
}

/* ---------------- upload intake ---------------- */

function bindUpload() {
  const openPicker = () => els.fileInput.click();
  els.pickBtn.addEventListener('click', (e) => { e.stopPropagation(); openPicker(); });
  els.browseBtn.addEventListener('click', (e) => { e.stopPropagation(); openPicker(); });
  els.replaceBtn.addEventListener('click', openPicker);
  els.dropzone.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    openPicker();
  });
  els.dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPicker(); }
  });
  els.fileInput.addEventListener('change', () => {
    if (els.fileInput.files?.length) handleFiles(els.fileInput.files);
    els.fileInput.value = '';
  });

  ['dragenter', 'dragover'].forEach((ev) => els.dropzone.addEventListener(ev, (e) => {
    e.preventDefault(); e.stopPropagation();
    els.dropzone.classList.add('drag');
  }));
  ['dragleave', 'dragend'].forEach((ev) => els.dropzone.addEventListener(ev, (e) => {
    e.preventDefault(); els.dropzone.classList.remove('drag');
  }));
  els.dropzone.addEventListener('drop', (e) => {
    e.preventDefault(); e.stopPropagation();
    els.dropzone.classList.remove('drag');
    if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
  });
  // drag anywhere on page → highlight
  ['dragover', 'drop'].forEach((ev) => window.addEventListener(ev, (e) => e.preventDefault()));

  window.addEventListener('paste', (e) => {
    // Only claim pastes while the background tool is visible (lazy multi-tool shell)
    if (document.getElementById('panel-bg')?.classList.contains('hidden')) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const it of items) {
      if (it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) { handleFiles([f]); e.preventDefault(); return; }
      }
    }
  });

  els.sampleBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    await loadSample();
  });
}

async function loadSample() {
  const urls = [
    'https://images.unsplash.com/photo-1543466835-00a7907e9de1?auto=format&fit=crop&w=900&q=80',
    'https://images.unsplash.com/photo-1514888286974-6c03e2ca1dba?auto=format&fit=crop&w=900&q=80',
  ];
  toast('Loading sample image…');
  for (const u of urls) {
    try {
      const res = await fetch(u, { mode: 'cors' });
      if (!res.ok) continue;
      const blob = await res.blob();
      const file = new File([blob], 'sample.jpg', { type: blob.type || 'image/jpeg' });
      await handleFiles([file]);
      return;
    } catch { /* try next */ }
  }
  showError('Sample failed to load', 'Could not fetch a sample image (network blocked?). Please upload your own image instead.');
}

async function handleFiles(list) {
  hideError();
  const file = list[0];
  if (!file) return;
  const v = validateFile(file);
  if (!v.ok) {
    state.lastFailedFile = file;
    showError('Invalid file', v.err);
    toast(v.err, 'err');
    return;
  }
  state.lastFailedFile = null;
  await loadAndProcess(file);
}

/* ---------------- image load + optimize ---------------- */

function loadImageFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not decode this image. It may be corrupt.')); };
    img.src = url;
  });
}

function drawToSize(img, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const cctx = c.getContext('2d', { willReadFrequently: true });
  cctx.imageSmoothingEnabled = true;
  cctx.imageSmoothingQuality = 'high';
  cctx.drawImage(img, 0, 0, w, h);
  return c;
}

function canvasToBlob(canvas, type) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Image encoding failed.'))),
      type.includes('jpeg') ? 'image/jpeg' : 'image/png', 0.92);
  });
}

async function loadAndProcess(file) {
  if (state.processing) return;
  state.processing = true;
  hideError();

  // Show status strip + switch views
  els.uploadView.querySelector('.dropzone').classList.add('hidden');
  els.statusStrip.classList.remove('hidden');
  els.workView.classList.add('hidden');
  els.compareWrap.classList.add('hidden');
  setPreviewTab('result');

  try {
    setProgress(0.03, 'Validating…', `name=${file.name} size=${formatBytes(file.size)} type=${file.type}`);
    els.statusTitle.textContent = file.name || 'Pasted image';
    if (state.originalURL) URL.revokeObjectURL(state.originalURL);
    if (state.resultURL) URL.revokeObjectURL(state.resultURL);

    const { img, url } = await loadImageFromBlob(file);
    state.originalURL = url;
    els.statusThumb.style.backgroundImage = `url("${url}")`;
    setProgress(0.08, 'Reading dimensions…', `${img.naturalWidth}×${img.naturalHeight}px`);

    if (img.naturalWidth < 10 || img.naturalHeight < 10) {
      URL.revokeObjectURL(url);
      throw new Error('Image is too small (under 10px). Please use a larger image.');
    }
    const pixels = img.naturalWidth * img.naturalHeight;
    if (pixels > 50_000_000) throw new Error('Image has too many pixels (over 50 MP). Please use a smaller image.');

    // Optimize: cap longest side at MAX_DIM (prevents OOM in ONNX)
    const scale = Math.min(1, MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight));
    const pw = Math.max(1, Math.round(img.naturalWidth * scale));
    const ph = Math.max(1, Math.round(img.naturalHeight * scale));
    const wasScaled = scale < 1;

    setProgress(0.12, wasScaled ? `Optimizing large image → ${pw}×${ph}…` : 'Preparing image…',
      wasScaled ? `downscaled ${(100 * scale).toFixed(0)}% to protect memory (no visible quality loss)` : 'no downscale needed');

    const workCanvas = drawToSize(img, pw, ph);
    // Keep opaque original at processing size for the Restore brush
    state.originalCanvas = workCanvas;

    const outType = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    state.optimizedBlob = await canvasToBlob(workCanvas, outType);

    state.file = file;
    state.fileName = file.name || 'pasted-image.png';
    state.origW = img.naturalWidth;
    state.origH = img.naturalHeight;

    // Show workspace + processing overlay
    els.workView.classList.remove('hidden');
    els.processingOverlay.classList.remove('hidden');
    els.compareOriginal.src = url;
    setProgress(0.15, 'Starting cutout…', `provider=${activeProvider.name} backend=local`);
    els.workView.scrollIntoView({ behavior: 'smooth', block: 'start' });

    // ---- REAL AI CALL ----
    const t0 = performance.now();
    const resultBlob = await activeProvider.removeBackground(state.optimizedBlob, (p, label) => {
      // Map provider 0..1 → UI 15%..98%
      setProgress(0.15 + p * 0.83, label, `provider=${activeProvider.name}`);
    });
    const dt = ((performance.now() - t0) / 1000).toFixed(1);

    await consumeResult(resultBlob, { w: pw, h: ph, dt, wasScaled, origW: img.naturalWidth, origH: img.naturalHeight });
  } catch (err) {
    console.error(err);
    const msg = err?.message || String(err);
    if (/fetch|network|Failed to fetch|Load failed/i.test(msg)) {
      showError('Segmentation model failed to load', 'The local model weights (~40 MB) could not be downloaded. Check your connection and click Try again. ' + msg);
    } else {
      showError('Processing failed', msg);
    }
    toast('Processing failed', 'err');
    // back to upload view if we never had a result
    if (!state.hasResult) {
      els.workView.classList.add('hidden');
      els.uploadView.querySelector('.dropzone').classList.remove('hidden');
      els.statusStrip.classList.add('hidden');
    }
    els.processingOverlay.classList.add('hidden');
  } finally {
    state.processing = false;
  }
}

async function consumeResult(resultBlob, info) {
  setProgress(0.98, 'Compositing…', `result=${formatBytes(resultBlob.size)}`);
  const { img, url } = await loadImageFromBlob(resultBlob);
  if (state.resultURL) URL.revokeObjectURL(state.resultURL);
  state.resultURL = url;

  // Size canvas to actual model output (fallback to processing size)
  const rw = img.naturalWidth || info.w;
  const rh = img.naturalHeight || info.h;
  els.canvas.width = rw;
  els.canvas.height = rh;

  // If model returned a different size than our original canvas, rescale original for Restore brush
  if (rw !== state.originalCanvas.width || rh !== state.originalCanvas.height) {
    const tmp = document.createElement('canvas');
    tmp.width = rw; tmp.height = rh;
    tmp.getContext('2d').drawImage(state.originalCanvas, 0, 0, rw, rh);
    state.originalCanvas = tmp;
  }

  ctx.clearRect(0, 0, rw, rh);
  ctx.drawImage(img, 0, 0, rw, rh);

  // Snapshot pristine AI result
  state.aiImageData = ctx.getImageData(0, 0, rw, rh);
  state.undo = [];
  state.redo = [];
  updateUndoButtons();

  els.compareResult.src = url;
  updateCompare();

  state.hasResult = true;
  els.processingOverlay.classList.add('hidden');
  setProgress(1, 'Done', `finished in ${info.dt}s`);
  els.statusStrip.classList.add('hidden');
  els.uploadView.querySelector('.dropzone').classList.remove('hidden');

  // meta + info
  els.imgMeta.textContent = `${rw}×${rh}px • ${info.dt}s`;
  els.fileInfo.innerHTML =
    `<b>${escapeHtml(state.fileName)}</b><br>Original: ${info.origW}×${info.origH}px • ${formatBytes(state.file?.size)}<br>` +
    `Processed: ${rw}×${rh}px${info.wasScaled ? ' (optimized for speed)' : ''} • cut locally`;
  els.successSub.textContent = `Subject isolated in ${info.dt}s • alpha edges preserved`;

  resetView();
  applyBackground();
  fitCanvas();
  toast('Background removed ✓');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- preview: bg, zoom/pan, tabs, compare ---------------- */

function applyBackground() {
  if (state.bg === 'transparent') {
    els.viewport.classList.add('checker');
    els.viewport.style.background = '';
  } else {
    els.viewport.classList.remove('checker');
    els.viewport.style.background = state.bg;
  }
  document.querySelectorAll('.swatch[data-bg]').forEach((b) => {
    b.classList.toggle('active', b.dataset.bg === state.bg || (state.bg !== 'transparent' && b.dataset.bg === 'custom'));
  });
}

function bindBackground() {
  document.querySelectorAll('.swatch[data-bg]').forEach((b) => {
    b.addEventListener('click', () => {
      state.bg = b.dataset.bg;
      applyBackground();
    });
  });
  els.bgColor.addEventListener('input', () => {
    state.bg = els.bgColor.value;
    els.customSw.style.background = els.bgColor.value;
    document.querySelectorAll('.swatch[data-bg]').forEach((x) => x.classList.remove('active'));
    document.querySelector('.swatch.custom').classList.add('active');
    applyBackground();
  });
}

function applyTransform() {
  els.stage.style.transform = `translate(-50%,-50%) translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
  els.zoomLabel.textContent = Math.round(state.zoom * 100) + '%';
}

function resetView() {
  state.zoom = 1;
  state.panX = 0;
  state.panY = 0;
  applyTransform();
}

function fitCanvas() {
  const vw = els.viewport.clientWidth || 600;
  const vh = els.viewport.clientHeight || 520;
  const cw = els.canvas.width || 1;
  const ch = els.canvas.height || 1;
  state.baseFit = Math.min(vw / cw, vh / ch, 1) * 0.94;
  if (!isFinite(state.baseFit) || state.baseFit <= 0) state.baseFit = 1;
  els.canvas.style.width = Math.max(1, Math.round(cw * state.baseFit)) + 'px';
  els.canvas.style.height = Math.max(1, Math.round(ch * state.baseFit)) + 'px';
  applyTransform();
}

function bindZoomPan() {
  els.zoomIn.addEventListener('click', () => { state.zoom = Math.min(5, state.zoom * 1.25); applyTransform(); syncCursor(); });
  els.zoomOut.addEventListener('click', () => { state.zoom = Math.max(0.2, state.zoom / 1.25); applyTransform(); syncCursor(); });
  els.zoomReset.addEventListener('click', resetView);
  els.viewport.addEventListener('wheel', (e) => {
    if (!state.hasResult) return;
    e.preventDefault();
    const f = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    state.zoom = Math.min(5, Math.max(0.2, state.zoom * f));
    applyTransform();
    syncCursor();
  }, { passive: false });

  window.addEventListener('resize', () => { if (state.hasResult) fitCanvas(); });
}

function setPreviewTab(which) {
  const isCompare = which === 'compare';
  els.tabResult.classList.toggle('active', !isCompare);
  els.tabCompare.classList.toggle('active', isCompare);
  els.compareWrap.classList.toggle('hidden', !isCompare);
  els.viewport.classList.toggle('hidden', isCompare);
  if (isCompare) updateCompare();
}

function bindTabsCompare() {
  els.tabResult.addEventListener('click', () => setPreviewTab('result'));
  els.tabCompare.addEventListener('click', () => setPreviewTab('compare'));
  const update = () => {
    const v = Number(els.compareSlider.value);
    els.compareResultWrap.style.width = v + '%';
    els.compareHandle.style.left = v + '%';
  };
  els.compareSlider.addEventListener('input', update);
  update();
}

function updateCompare() {
  // Refresh result preview from live canvas (includes brush edits)
  try {
    if (state.hasResult) els.compareResult.src = els.canvas.toDataURL('image/png');
  } catch { /* ignore taint (shouldn't happen, all local) */ }
  const v = Number(els.compareSlider.value);
  els.compareResultWrap.style.width = v + '%';
  els.compareHandle.style.left = v + '%';
}

/* ---------------- brush editing: erase / restore / pan ---------------- */

function snapshot() {
  try {
    return ctx.getImageData(0, 0, els.canvas.width, els.canvas.height);
  } catch {
    return null;
  }
}

function pushUndo() {
  const s = snapshot();
  if (!s) return;
  state.undo.push(s);
  if (state.undo.length > UNDO_LIMIT) state.undo.shift();
  state.redo = [];
  updateUndoButtons();
}

function updateUndoButtons() {
  els.undoBtn.disabled = state.undo.length === 0;
  els.redoBtn.disabled = state.redo.length === 0;
}

function doUndo() {
  if (!state.undo.length) return;
  const cur = snapshot();
  if (cur) state.redo.push(cur);
  const prev = state.undo.pop();
  ctx.putImageData(prev, 0, 0);
  updateUndoButtons();
  updateCompare();
}

function doRedo() {
  if (!state.redo.length) return;
  const cur = snapshot();
  if (cur) state.undo.push(cur);
  const nxt = state.redo.pop();
  ctx.putImageData(nxt, 0, 0);
  updateUndoButtons();
  updateCompare();
}

function setTool(t) {
  state.tool = t;
  els.eraseBtn.classList.toggle('active', t === 'erase');
  els.restoreBtn.classList.toggle('active', t === 'restore');
  els.panBtn.classList.toggle('active', t === 'pan');
  els.viewport.classList.toggle('brush', t !== 'pan');
  if (t === 'pan') els.brushCursor.classList.add('hidden');
  els.toolHint.innerHTML = t === 'pan'
    ? 'Tip: scroll to zoom, drag to pan. Choose <b>Erase</b> to paint away leftovers.'
    : t === 'erase'
      ? 'Erase mode: paint over areas to make them transparent. <b>Undo</b> anytime.'
      : 'Restore mode: paint to bring back cut-away detail (hair, edges).';
}

function displayScale() {
  const r = els.canvas.getBoundingClientRect();
  return r.width / (els.canvas.width || 1);
}

function syncCursor(clientX, clientY) {
  if (state.tool === 'pan' || !state.hasResult) {
    els.brushCursor.classList.add('hidden');
    return;
  }
  const d = state.brushSize * displayScale();
  els.brushCursor.style.width = d + 'px';
  els.brushCursor.style.height = d + 'px';
  if (clientX !== undefined) {
    const vr = els.viewport.getBoundingClientRect();
    els.brushCursor.classList.remove('hidden');
    els.brushCursor.style.left = (clientX - vr.left + els.viewport.scrollLeft) + 'px';
    els.brushCursor.style.top = (clientY - vr.top + els.viewport.scrollTop) + 'px';
    // position cursor inside viewport (viewport is offset parent? stage is transformed)
    // brushCursor is child of stage → convert: simpler to attach to viewport instead.
  }
}

// NOTE: brushCursor lives inside #canvasStage which is transformed; to keep math
// simple we reposition it as a viewport child on first use.
function ensureCursorParent() {
  if (els.brushCursor.parentElement !== els.viewport) {
    els.viewport.appendChild(els.brushCursor);
    els.brushCursor.style.position = 'absolute';
  }
}

function softBrushMask(diameter, softnessPct) {
  // Returns canvas with radial alpha mask (white, alpha falloff)
  const c = document.createElement('canvas');
  c.width = c.height = Math.max(1, Math.ceil(diameter));
  const g = c.getContext('2d');
  const r = c.width / 2;
  // softness 0 → hard edge, 90 → very feathered
  const inner = r * (1 - softnessPct / 100 * 0.9);
  const grad = g.createRadialGradient(r, r, Math.max(0.1, inner * 0.55), r, r, r);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(Math.max(0.01, inner / r), 'rgba(255,255,255,1)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, c.width, c.height);
  return c;
}

function paintErase(x, y) {
  const d = state.brushSize;
  const mask = softBrushMask(d, state.brushSoft);
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.drawImage(mask, x - d / 2, y - d / 2, d, d);
  ctx.restore();
}

function paintRestore(x, y) {
  const d = state.brushSize;
  if (!state.originalCanvas) return;
  const mask = softBrushMask(d, state.brushSoft);
  // stamp = original pixels clipped by soft mask
  const stamp = document.createElement('canvas');
  stamp.width = stamp.height = Math.max(1, Math.ceil(d));
  const sctx = stamp.getContext('2d');
  const sx = Math.round(x - d / 2);
  const sy = Math.round(y - d / 2);
  // draw corresponding original region
  sctx.drawImage(state.originalCanvas, sx, sy, d, d, 0, 0, d, d);
  sctx.globalCompositeOperation = 'destination-in';
  sctx.drawImage(mask, 0, 0, d, d);
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(stamp, sx, sy, d, d);
  ctx.restore();
}

function paintAt(cx, cy) {
  if (state.tool === 'erase') paintErase(cx, cy);
  else if (state.tool === 'restore') paintRestore(cx, cy);
}

function bindBrush() {
  ensureCursorParent();
  let drawing = false;
  let panning = false;
  let last = null;
  let panLast = null;
  let spaceHeld = false;

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && state.hasResult) { spaceHeld = true; }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') spaceHeld = false;
  });

  els.eraseBtn.addEventListener('click', () => setTool(state.tool === 'erase' ? 'pan' : 'erase'));
  els.restoreBtn.addEventListener('click', () => setTool(state.tool === 'restore' ? 'pan' : 'restore'));
  els.panBtn.addEventListener('click', () => setTool('pan'));

  els.brushSize.addEventListener('input', () => {
    state.brushSize = Number(els.brushSize.value);
    els.brushSizeVal.textContent = state.brushSize + 'px';
  });
  els.brushSoft.addEventListener('input', () => {
    state.brushSoft = Number(els.brushSoft.value);
    els.brushSoftVal.textContent = state.brushSoft + '%';
  });
  els.undoBtn.addEventListener('click', doUndo);
  els.redoBtn.addEventListener('click', doRedo);
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      if (!state.hasResult) return;
      e.preventDefault();
      if (e.shiftKey) doRedo(); else doUndo();
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); doRedo(); }
  });
  els.resetEditsBtn.addEventListener('click', () => {
    if (!state.aiImageData) return;
    pushUndo();
    ctx.putImageData(state.aiImageData, 0, 0);
    updateCompare();
    toast('Edits reset to the original cutout');
  });

  const toCanvas = (clientX, clientY) => {
    const r = els.canvas.getBoundingClientRect();
    return {
      x: ((clientX - r.left) / r.width) * els.canvas.width,
      y: ((clientY - r.top) / r.height) * els.canvas.height,
    };
  };

  const moveCursor = (clientX, clientY) => {
    ensureCursorParent();
    if (state.tool === 'pan' || !state.hasResult) {
      els.brushCursor.classList.add('hidden');
      return;
    }
    const vr = els.viewport.getBoundingClientRect();
    const d = Math.max(4, state.brushSize * displayScale());
    els.brushCursor.classList.remove('hidden');
    els.brushCursor.style.width = d + 'px';
    els.brushCursor.style.height = d + 'px';
    els.brushCursor.style.left = (clientX - vr.left) + 'px';
    els.brushCursor.style.top = (clientY - vr.top) + 'px';
  };

  els.viewport.addEventListener('pointermove', (e) => {
    if (!state.hasResult || state.processing) return;
    if (!drawing && !panning) { moveCursor(e.clientX, e.clientY); return; }
    if (panning) {
      if (panLast) {
        // use client deltas (works for mouse + touch; movementX is unreliable on touch)
        state.panX += e.clientX - panLast.x;
        state.panY += e.clientY - panLast.y;
        applyTransform();
      }
      panLast = { x: e.clientX, y: e.clientY };
      return;
    }
    if (drawing) {
      moveCursor(e.clientX, e.clientY);
      const p = toCanvas(e.clientX, e.clientY);
      // interpolate between last and current for smooth strokes
      const dx = p.x - last.x;
      const dy = p.y - last.y;
      const dist = Math.hypot(dx, dy);
      const step = Math.max(1, state.brushSize * 0.25);
      const n = Math.min(50, Math.ceil(dist / step));
      for (let i = 1; i <= n; i++) {
        paintAt(last.x + (dx * i) / n, last.y + (dy * i) / n);
      }
      last = p;
    }
  });

  els.viewport.addEventListener('pointerdown', (e) => {
    if (!state.hasResult || state.processing) return;
    if (e.button === 1 || state.tool === 'pan' || spaceHeld) {
      panning = true;
      panLast = { x: e.clientX, y: e.clientY };
      try { els.viewport.setPointerCapture(e.pointerId); } catch { /* noop */ }
      return;
    }
    if (state.tool === 'erase' || state.tool === 'restore') {
      if (e.button !== 0) return;
      drawing = true;
      pushUndo();
      const p = toCanvas(e.clientX, e.clientY);
      last = p;
      paintAt(p.x, p.y);
      try { els.viewport.setPointerCapture(e.pointerId); } catch { /* noop */ }
      moveCursor(e.clientX, e.clientY);
      e.preventDefault();
    }
  });

  const endStroke = () => {
    if (drawing) { drawing = false; last = null; updateCompare(); }
    panning = false;
    panLast = null;
  };
  els.viewport.addEventListener('pointerup', endStroke);
  els.viewport.addEventListener('pointercancel', endStroke);
  els.viewport.addEventListener('pointerleave', () => {
    if (!drawing && !panning) els.brushCursor.classList.add('hidden');
  });
}

/* ---------------- export + workflow buttons ---------------- */

function bindActions() {
  els.downloadBtn.addEventListener('click', async () => {
    if (!state.hasResult) { toast('Nothing to download yet', 'err'); return; }
    try {
      const blob = await new Promise((res, rej) => els.canvas.toBlob((b) => (b ? res(b) : rej(new Error('Export failed'))), 'image/png'));
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = baseName(state.fileName) + '-no-bg.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast(`Exported transparent PNG (${formatBytes(blob.size)})`);
    } catch (err) {
      showError('Export failed', err.message);
    }
  });

  els.newImageBtn.addEventListener('click', resetToUpload);
  els.reprocessBtn.addEventListener('click', async () => {
    if (!state.file || !state.optimizedBlob || state.processing) return;
    hideError();
    try {
      state.processing = true;
      els.processingOverlay.classList.remove('hidden');
      setPreviewTab('result');
      setProgress(0.15, 'Cutting again…', `provider=${activeProvider.name}`);
      const t0 = performance.now();
      const blob = await activeProvider.removeBackground(state.optimizedBlob, (p, label) => {
        setProgress(0.15 + p * 0.83, label, '');
      });
      const dt = ((performance.now() - t0) / 1000).toFixed(1);
      await consumeResult(blob, {
        w: els.canvas.width, h: els.canvas.height, dt,
        wasScaled: false, origW: state.origW || state.originalCanvas?.width || 0, origH: state.origH || state.originalCanvas?.height || 0,
      });
      toast('Re-processed ✓');
    } catch (err) {
      console.error(err);
      showError('Re-process failed', err.message || String(err));
    } finally {
      state.processing = false;
      els.processingOverlay.classList.add('hidden');
    }
  });

  els.retryBtn.addEventListener('click', async () => {
    hideError();
    const f = state.file || state.lastFailedFile;
    if (f && !state.hasResult) await loadAndProcess(f);
    else if (state.optimizedBlob) els.reprocessBtn.click();
    else toast('Pick an image first', 'err');
  });
  els.dismissErrorBtn.addEventListener('click', hideError);
}

function resetToUpload() {
  hideError();
  if (state.originalURL) URL.revokeObjectURL(state.originalURL);
  if (state.resultURL) URL.revokeObjectURL(state.resultURL);
  Object.assign(state, {
    file: null, fileName: '', optimizedBlob: null, originalURL: null, resultURL: null,
    originalCanvas: null, aiImageData: null, undo: [], redo: [],
    processing: false, hasResult: false, panX: 0, panY: 0, zoom: 1,
  });
  ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
  els.workView.classList.add('hidden');
  els.statusStrip.classList.add('hidden');
  els.uploadView.querySelector('.dropzone').classList.remove('hidden');
  setPreviewTab('result');
  setTool('pan');
  updateUndoButtons();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ---------------- boot ---------------- */

function init() {
  bindUpload();
  bindBackground();
  bindZoomPan();
  bindTabsCompare();
  bindBrush();
  bindActions();
  setTool('pan');
  updateUndoButtons();
  fitCanvas();
  console.log('%ccutora ready — provider: ' + activeProvider.name, 'color:#D9480F;font-weight:bold');
}

let __booted = false;
/** Boot the background tool once; called lazily by js/main.js */
export function initBg() {
  if (__booted) return;
  __booted = true;
  init();
}
