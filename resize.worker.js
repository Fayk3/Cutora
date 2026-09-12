/**
 * cutora resize worker — high-quality multi-step resize + encode off the
 * main thread, so huge images never freeze the UI.
 *
 * Protocol in:  { id, bitmap, w, h, format, quality }
 * Protocol out: { id, ok: true, blob, type } | { id, ok: false, error }
 *
 * Main thread (js/resize.js) falls back to an identical canvas path if
 * workers / OffscreenCanvas are unavailable or the worker errors.
 */
self.onmessage = async (e) => {
  const { id, bitmap, w, h, format, quality } = e.data || {};
  try {
    if (!bitmap || !w || !h) throw new Error('Bad resize job.');
    let cur = bitmap;
    let cw = bitmap.width;
    let ch = bitmap.height;

    const step = (tw, th) => {
      const c = new OffscreenCanvas(tw, th);
      const g = c.getContext('2d');
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      g.drawImage(cur, 0, 0, tw, th);
      if (cur !== bitmap && typeof cur.close === 'function') { try { cur.close(); } catch { /* noop */ } }
      cur = c;
      cw = tw;
      ch = th;
    };

    // Step down in halves (cleaner than one giant jump), step up in doubles.
    let guard = 0;
    while (cw / 2 >= w && ch / 2 >= h && (cw > w * 1.5 || ch > h * 1.5) && guard++ < 12) {
      step(Math.max(w, Math.round(cw / 2)), Math.max(h, Math.round(ch / 2)));
    }
    guard = 0;
    while ((cw < w || ch < h) && (cw * 2 <= w * 1.6 || ch * 2 <= h * 1.6) && guard++ < 8) {
      step(Math.min(w, cw * 2), Math.min(h, ch * 2));
    }
    if (cw !== w || ch !== h) step(w, h);

    const blob = await cur.convertToBlob({ type: format, quality: quality / 100 });
    if (!blob) throw new Error('Encoder returned nothing.');
    self.postMessage({ id, ok: true, blob, type: blob.type });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
