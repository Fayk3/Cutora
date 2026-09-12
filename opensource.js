/**
 * Cutora open-source widget.
 * Shows a REAL star count from the GitHub API when the repo exists.
 * Never invents numbers: on 404 / rate-limit / offline the count
 * elements stay hidden and an honest note is shown instead.
 *
 * To point Cutora at your own repo, change GITHUB_REPO below
 * (and the matching hrefs in index.html + README).
 */
const GITHUB_REPO = 'Fayk3/Cutora';

function formatCount(n) {
  if (typeof n !== 'number' || !isFinite(n)) return null;
  if (n >= 1000) {
    const v = n / 1000;
    return (v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, '')) + 'k';
  }
  return String(n);
}

async function loadStars() {
  const nav = document.getElementById('ghStars');
  const btn = document.getElementById('ghStarsBtn');
  const card = document.getElementById('ghStarsCard');
  const note = document.getElementById('ghNote');
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const data = await res.json();
    const text = formatCount(data.stargazers_count);
    if (text === null) throw new Error('No star count in response');
    if (nav) {
      nav.textContent = `★ ${text}`;
      nav.classList.remove('hidden');
    }
    if (btn) {
      btn.textContent = text;
      btn.classList.remove('hidden');
    }
    if (card) card.textContent = text;
    if (note) note.textContent = 'Live from the GitHub API · updates automatically';
  } catch (err) {
    // Honest fallback: no fake numbers, ever.
    if (card) card.textContent = '—';
    if (note) {
      note.textContent =
        'Star count goes live once this repo is published — update GITHUB_REPO in js/opensource.js';
    }
  }
}

function setYear() {
  const y = document.getElementById('year');
  if (y) y.textContent = String(new Date().getFullYear());
}

loadStars();
setYear();
