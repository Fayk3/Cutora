# cutora — local-first image studio

Cut out backgrounds, AI-upscale to 4×, and resize to exact dimensions — all in your browser. No uploads, no accounts, no watermark.

**Built in the open.** Inspect the code, contribute, self-host. MIT licensed.

- Live app: serve this folder and open `index.html` via `http://` (see below)
- Repo: [Fayk3/Cutora](https://github.com/Fayk3/Cutora) — ★ star count on the site loads live from the GitHub API (never hardcoded)

## Tools (one studio, three tabs)

- **Remove Background** — local segmentation, hair/fur alpha, erase/restore brushes, undo/redo, checkerboard + before/after, transparent PNG export
- **AI Upscaler** — real ESRGAN-Slim inference (TensorFlow.js, GPU) at 2×/4×, tiled so large images don't crash, before/after slider, zoom/pan, resolution readout, PNG download
- **Resize Image** — custom W×H, ratio lock, presets, % scaling, PNG/JPEG/WebP + quality, real byte-accurate output size, worker-rendered, download

Shared: drag & drop, file picker, paste (`Ctrl+V`), sample image, JPG/JPEG/PNG/WebP up to 25 MB, validated.

## Run locally (no build step)

ES modules + CDN require `http://`, not `file://`:

```powershell
cd bg-remover-app
npx serve . -l 5173
# or
python -m http.server 5173
```

Then open http://localhost:5173

First background cut fetches ~40 MB of model weights; first enhance fetches ~3 MB (TF.js + ESRGAN-Slim). Both cache afterwards. Images never leave your device.

## Structure

```
bg-remover-app/
  index.html        Landing + 3-tool studio + open-source section
  styles.css        Cutora brand system (paper/ink/vermilion, 10px radii)
  assets/logo.svg   Original cut-mark logo (navbar, favicon, loaders, footer)
  js/
    main.js         Tab shell — lazy-loads each tool on first open, instant after
    common.js       Shared upload/validate/encode/download helpers (tiny, upfront)
    bg.js           Background tool (imports @imgly lazily inside provider)
    providers.js    Swappable segmentation backends
    upscale.js      Upscaler UI — lazy-loads TF.js + ESRGAN-Slim per scale
    resize.js       Resizer UI — renders via worker, identical main-thread fallback
    resize.worker.js  OffscreenCanvas multi-step resize + encode
    opensource.js   Live GitHub star count + footer year (no fake numbers)
```

## Performance notes

- Initial load is only shell + CSS + fonts. TF.js, segmentation weights, and
  upscaler models download **only** when their tool is opened (and only the
  chosen upscale factor's weights).
- Upscaler tiles inference in 128px patches with real per-patch progress;
  inputs over 1024px are fitted first to protect GPU memory.
- Resizer work runs in a Web Worker; the main thread stays responsive.
  If workers/OffscreenCanvas are unavailable, the same pipeline runs on the
  main thread automatically.
- All CDN assets are version-pinned immutable URLs (long-lived HTTP cache).

## Pinned AI dependencies

- `@imgly/background-removal@1.7.0` (segmentation, dynamic import)
- `@tensorflow/tfjs@4.11.0` + `upscaler@1.0.0` + `@upscalerjs/esrgan-slim@1.0.0`
  + `@upscalerjs/default-model@1.0.0` (upscaler, lazy `<script>` injection)

## Brand

- **Name**: cutora · **Mark**: `assets/logo.svg` (vermilion tile `#D9480F` + white cut)
- **Type**: Space Grotesk (display/wordmark), Inter (UI), JetBrains Mono (labels/meta)
- **Color**: paper `#FAF9F6`, ink `#1C1B1A`, accent vermilion `#D9480F` — flat fills, 1px borders, subtle shadows.

## Swap the segmentation backend

Implement the interface in `js/providers.js`:

```js
{
  name: 'my-provider',
  removeBackground: async (blob, onProgress) => Blob // transparent PNG
}
```

Then set it as `activeProvider` in `js/bg.js`. For hosted APIs, proxy secret keys through your own backend — never ship keys in frontend code.

## Point at your repo

Already configured for [`Fayk3/Cutora`](https://github.com/Fayk3/Cutora) — `GITHUB_REPO` in `js/opensource.js` and every site link point there. Just push `main` and the navbar + ★ Star button + repo card pick up the **real** star count automatically. Forking under a new name? Update those two spots.

## Privacy & limits

- Local-first: models run via WebAssembly/WebGL/GPU on your machine.
- 25 MB guard + per-tool pixel caps (bg 50 MP/2048px, upscale 1024px working, resize 80 MP/12000px) prevent tab crashes.
- Undo history in the background tool is capped at 12 snapshots for memory safety.

## Contributing

Issues and PRs welcome: [Fayk3/Cutora/issues](https://github.com/Fayk3/Cutora/issues) · [Fork](https://github.com/Fayk3/Cutora/fork). See [CONTRIBUTING.md](./CONTRIBUTING.md) for the ground rules.

## License

MIT — see [LICENSE](./LICENSE).
