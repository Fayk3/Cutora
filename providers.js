/**
 * Cutora segmentation providers — swappable backends.
 *
 * Interface every provider must implement:
 *   name: string
 *   removeBackground(blob: Blob, onProgress?: (p: number, label: string) => void): Promise<Blob>
 *     - input:  source image Blob (jpg/png/webp)
 *     - output: PNG Blob with transparency (subject isolated)
 *     - onProgress: 0..1 + human readable stage label
 *
 * To swap providers (e.g. to a self-hosted service):
 *   1. Add a new object implementing the interface below.
 *   2. Export it and set it as `activeProvider` in app.js.
 * No other app code needs to change.
 */

export const ImglyProvider = {
  name: 'imgly-in-browser-isnet',
  _module: null,

  async _load() {
    if (this._module) return this._module;
    // Dynamic import keeps initial page load fast; model weights (~40MB)
    // download on first run and are cached by the browser afterwards.
    this._module = await import('@imgly/background-removal');
    return this._module;
  },

  /**
   * Open segmentation model (ISNet-style) running locally
   * via onnxruntime-web. Nothing is uploaded to any server.
   */
  async removeBackground(blob, onProgress) {
    const mod = await this._load();
    const fetchMap = new Map();
    let computeProgress = 0;
    let sawCompute = false;

    const report = (key, current, total) => {
      try {
        const frac = total > 0 ? current / total : 0;
        if (/comput|infer|process|segment/i.test(key)) {
          sawCompute = true;
          computeProgress = Math.min(1, Math.max(0, frac));
        } else {
          fetchMap.set(key, Math.min(1, Math.max(0, frac)));
        }
        let fetchAvg = 0;
        if (fetchMap.size > 0) {
          let s = 0;
          for (const v of fetchMap.values()) s += v;
          fetchAvg = s / fetchMap.size;
        }
        // 0 → 0.82 while fetching weights, 0.82 → 1 while segmenting
        const overall = sawCompute ? 0.82 + computeProgress * 0.18 : fetchAvg * 0.82;
        onProgress?.(Math.min(0.999, Math.max(0, overall)), sawCompute ? 'Cutting out subject…' : 'Loading local model…');
      } catch { /* progress must never break processing */ }
    };

    const result = await mod.removeBackground(blob, {
      progress: (key, current, total) => report(String(key), current, total),
    });

    onProgress?.(1, 'Done');
    // Ensure PNG blob type
    if (result instanceof Blob) {
      if (result.type === 'image/png') return result;
      return new Blob([result], { type: 'image/png' });
    }
    return result;
  },
};

/**
 * Example of a hosted-API provider (NOT active — template only).
 * To use: implement fetch to your backend which proxies the API key
 * (never expose secret keys in frontend code), then set as active.
 */
// export const HostedApiProvider = {
//   name: 'hosted-api',
//   async removeBackground(blob, onProgress) {
//     onProgress?.(0.1, 'Uploading…');
//     const fd = new FormData();
//     fd.append('image', blob);
//     const res = await fetch('/api/remove-background', { method: 'POST', body: fd });
//     if (!res.ok) throw new Error('Provider error: ' + res.status);
//     onProgress?.(0.9, 'Finalizing…');
//     const out = await res.blob();
//     onProgress?.(1, 'Done');
//     return out;
//   },
// };
