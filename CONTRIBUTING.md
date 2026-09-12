# Contributing to Cutora

Thanks for wanting to help! Cutora is a small, dependency-light, no-build project — please keep it that way.

## Quick start

No build step. Serve the folder over HTTP (ES modules + CDN require `http://`, not `file://`):

```powershell
npx serve . -l 5173
# or
python -m http.server 5173
```

Open http://localhost:5173 and hack away.

## Ground rules

- **It must actually work.** No placeholder buttons, fake progress, or mocked AI results. Every control you add must be wired end-to-end.
- **No heavy upfront dependencies.** New libraries must lazy-load only when their tool is opened. The initial page load stays shell + CSS + fonts.
- **Same design system.** Paper/ink/vermilion tokens in `styles.css`, Space Grotesk / Inter / JetBrains Mono, 10px radii, 1px borders. No gradients, no neon, no new accent colors without discussion.
- **Pin your CDNs.** Version-pinned immutable URLs only (e.g. `@tensorflow/tfjs@4.11.0`), and verify the files actually resolve before opening a PR.
- **Respect memory.** Cap input sizes per tool, tile heavy inference, prefer workers for blocking work, always provide a fallback path.
- **No fake numbers.** Star counts, stats, sizes — real data or nothing.

## Where things live

- `index.html` — landing + all three tool panels + open-source section
- `styles.css` — the whole brand system
- `js/main.js` — tab shell, lazy-loads tools
- `js/common.js` — shared upload/validate/encode helpers
- `js/bg.js`, `js/upscale.js`, `js/resize.js` (+ `resize.worker.js`) — the tools
- `js/opensource.js` — live GitHub stars (`GITHUB_REPO` constant)

## Pull requests

1. Fork the repo and create a branch (`feat/my-thing`, `fix/my-fix`).
2. Test all three tools end-to-end in at least one Chromium browser (upload → process → export), plus a mobile-width viewport check.
3. Open a PR describing what changed, why, and how you tested it.

## Reporting issues

Open an issue with: what you did, what you expected, what happened, browser + OS, and (for processing bugs) the input image size/format. Console errors help a lot.

## Code of conduct

Be kind, be direct, assume good faith. Maintainers may close issues/PRs that are spam, abusive, or out of scope.
