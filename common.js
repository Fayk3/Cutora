/**
 * cutora shared helpers — tiny, dependency-free, loaded upfront.
 * Heavy work (segmentation, upscaling) stays in lazily-loaded tool modules.
 */

export const MAX_FILE_MB = 25;
export const ACCEPTED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

export const SAMPLE_URLS = [
  'https://images.unsplash.com/photo-1543466835-00a7907e9de1?auto=format&fit=crop&w=900&q=80',
  'https://images.unsplash.com/photo-1514888286974-6c03e2ca1dba?auto=format&fit=crop&w=900&q=80',
];

export function formatBytes(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

export function baseName(name) {
  const b = (name || 'image').split(/[\\/]/).pop().replace(/\.[a-z0-9]+$/i, '');
  return b.replace(/[^\w\-]+/g, '-').slice(0, 60) || 'image';
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function toast(msg, type = 'ok') {
  const box = document.getElementById('toasts');
  if (!box) return;
  const d = document.createElement('div');
  d.className = `toast ${type}`;
  d.textContent = msg;
  box.appendChild(d);
  setTimeout(() => { d.style.opacity = '0'; d.style.transition = 'opacity .3s'; }, 3400);
  setTimeout(() => d.remove(), 3800);
}

export function validateImageFile(file) {
  if (!file) return { ok: false, err: 'No file selected.' };
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const mimeOk = ACCEPTED_MIME.has(file.type);
  const extOk = ['jpg', 'jpeg', 'png', 'webp'].includes(ext);
  if (!mimeOk && !extOk) {
    return { ok: false, err: `Unsupported format “${file.type || ext || 'unknown'}”. Use JPG, JPEG, PNG or WebP.` };
  }
  if (file.size > MAX_FILE_MB * 1024 * 1024) {
    return { ok: false, err: `File is ${formatBytes(file.size)} — limit is ${MAX_FILE_MB} MB.` };
  }
  if (file.size === 0) return { ok: false, err: 'File is empty.' };
  return { ok: true };
}

export function loadImageFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url, w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not decode this image. It may be corrupt.')); };
    img.src = url;
  });
}

export function loadImageURL(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load this image URL.'));
    img.src = url;
  });
}

export async function fetchSampleFile() {
  let lastErr = null;
  for (const u of SAMPLE_URLS) {
    try {
      const res = await fetch(u, { mode: 'cors' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const blob = await res.blob();
      return new File([blob], 'sample.jpg', { type: blob.type || 'image/jpeg' });
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('Sample fetch failed');
}

/** High-quality fit of an image inside `cap` (longest side). Returns a canvas. */
export function fitToCap(img, cap) {
  const scale = Math.min(1, cap / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height));
  const w = Math.max(1, Math.round((img.naturalWidth || img.width) * scale));
  const h = Math.max(1, Math.round((img.naturalHeight || img.height) * scale));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, 0, 0, w, h);
  return { canvas: c, w, h, scaled: scale < 1, scale };
}

export function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Image encoding failed (this browser may not support ' + type + ').'))),
      type,
      quality,
    );
  });
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Load a classic script once; resolves on load, rejects on error. Cached by URL. */
const scriptCache = new Map();
export function loadScript(src) {
  if (scriptCache.has(src)) return scriptCache.get(src);
  const p = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Failed to load ' + src));
    document.head.appendChild(s);
  });
  scriptCache.set(src, p);
  return p;
}

export function debounce(fn, ms) {
  let t = 0;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** Wire drag/drop + click-to-browse + keyboard for a dropzone. Paste is wired per-tool. */
export function wireDropzone({ zone, input, onFiles }) {
  const open = () => input.click();
  zone.addEventListener('click', (e) => {
    if (e.target.closest('button,input,a')) return;
    open();
  });
  zone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });
  ['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, (e) => {
    e.preventDefault(); e.stopPropagation();
    zone.classList.add('drag');
  }));
  ['dragleave', 'dragend'].forEach((ev) => zone.addEventListener(ev, (e) => {
    e.preventDefault();
    zone.classList.remove('drag');
  }));
  zone.addEventListener('drop', (e) => {
    e.preventDefault(); e.stopPropagation();
    zone.classList.remove('drag');
    if (e.dataTransfer?.files?.length) onFiles(e.dataTransfer.files);
  });
  input.addEventListener('change', () => {
    if (input.files?.length) onFiles(input.files);
    input.value = '';
  });
}

/** Claim pasted images only while `isActive()` is true. Returns an unlisten fn. */
export function onPasteImage(isActive, onFile) {
  const h = (e) => {
    if (!isActive()) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const it of items) {
      if (it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) { onFile(f); e.preventDefault(); return; }
      }
    }
  };
  window.addEventListener('paste', h);
  return () => window.removeEventListener('paste', h);
}
