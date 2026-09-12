/**
 * cutora tool shell — instant tab switching with lazy-loaded tools.
 *
 * Initial load fetches only this shell (+ opensource widget). Each tool
 * module is dynamically imported on first activation and cached, so
 * navigation afterwards is instant and heavy AI libraries are never
 * downloaded until their tool is actually opened.
 */

const TOOLS = ['bg', 'upscale', 'resize'];
const LOADERS = {
  bg: () => import('./bg.js').then((m) => m.initBg()),
  upscale: () => import('./upscale.js').then((m) => m.initUpscaler()),
  resize: () => import('./resize.js').then((m) => m.initResizer()),
};

const loaded = new Set();
const loading = new Map();
let active = null;

export function isToolActive(name) {
  return active === name && !document.getElementById('panel-' + name)?.classList.contains('hidden');
}

async function ensureLoaded(name) {
  if (loaded.has(name)) return;
  if (loading.has(name)) { await loading.get(name); return; }
  const p = LOADERS[name]().then(() => { loaded.add(name); });
  loading.set(name, p);
  try {
    await p;
  } finally {
    loading.delete(name);
  }
}

export async function activateTool(name, { scroll = false } = {}) {
  if (!TOOLS.includes(name)) name = 'bg';
  document.querySelectorAll('.tool-tab').forEach((t) => {
    const on = t.dataset.tool === name;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  TOOLS.forEach((n) => {
    document.getElementById('panel-' + n)?.classList.toggle('hidden', n !== name);
  });
  active = name;
  try {
    history.replaceState(null, '', '#tool-' + name);
  } catch { /* file:// or sandboxed iframe — ignore */ }
  await ensureLoaded(name);
  if (scroll) {
    document.getElementById('studio')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function boot() {
  document.querySelectorAll('.tool-tab').forEach((t) => {
    t.addEventListener('click', () => activateTool(t.dataset.tool));
  });
  // In-content links that jump to a tool ("Enhance it →", footer links…)
  document.querySelectorAll('[data-tool-link]').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      activateTool(a.dataset.toolLink, { scroll: true });
    });
  });
  const m = (location.hash || '').match(/tool-(bg|upscale|resize)/);
  activateTool(m ? m[1] : 'bg');
  window.addEventListener('hashchange', () => {
    const h = (location.hash || '').match(/tool-(bg|upscale|resize)/);
    if (h && h[1] !== active) activateTool(h[1]);
  });
}

boot();
