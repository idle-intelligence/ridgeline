// terrain-cache.js — single point of truth for terrain data URLs + download-once caching.
//
// Terrain is streamed from the HF dataset by default, so a local checkout behaves exactly
// like the published demo without needing the ~1.1 GB of .bin files on disk.
// Escape hatches, highest precedence first:
//   window.RIDGELINE_DATA_BASE = '<absolute url>'  set before this module loads
//   ?data=local                                    serve from ../data (offline; repo root)
//
// Cache version: bump CACHE_NAME whenever the .bin files are re-baked so users
// automatically re-download the new data; stale older caches are deleted on load.
// v2: Venus re-bake (radar-gap interpolation fill + dateline edge-column fix).

const CACHE_NAME = 'ridgeline-terrain-v2';

// Evict caches from previous versions (best-effort, async, non-blocking).
try {
  caches.keys().then(keys => keys.forEach(k => {
    if (k.startsWith('ridgeline-terrain-') && k !== CACHE_NAME) caches.delete(k);
  }));
} catch (_) { /* Cache API unavailable — nothing to evict */ }

const HF_BASE = 'https://huggingface.co/datasets/idle-intelligence/ridgeline-terrain/resolve/main';

const DATA_BASE = () => {
  if (window.RIDGELINE_DATA_BASE) return window.RIDGELINE_DATA_BASE;
  return new URLSearchParams(location.search).get('data') === 'local' ? '../data' : HF_BASE;
};

// Returns the full URL for a terrain file (e.g. 'heightfield.bin', 'moon_meta.json').
export function dataUrl(file) {
  return `${DATA_BASE()}/${file}`;
}

// Fetches url with download-once caching via the Cache API.
// onProgress(loaded, total) is called as bytes arrive; total may be 0 if Content-Length
// is absent. On a cache hit, onProgress(1, 1) is called immediately.
// Returns a Response whose body is the full file content (application/octet-stream).
// Falls back to a plain streamed fetch if the Cache API is unavailable (e.g. non-secure
// context) — progress still fires, the result just isn't stored.
export async function cachedFetch(url, onProgress) {
  const progress = onProgress ?? (() => {});

  // Try to open the cache; on failure (HTTP, non-secure context, etc.) skip caching.
  let cache = null;
  try {
    cache = await caches.open(CACHE_NAME);
  } catch (_) {
    // Cache API unavailable — proceed with a plain fetch below.
  }

  if (cache) {
    const hit = await cache.match(url);
    if (hit) {
      progress(1, 1);
      return hit;
    }
  }

  // Miss (or no cache): stream the response, drive progress, then store.
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Fetch failed: ${url} — HTTP ${resp.status}`);

  const total = +(resp.headers.get('content-length') || 0);
  let loaded = 0;
  const reader = resp.body.getReader();
  const chunks = [];

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    progress(loaded, total);
  }

  const blob = new Blob(chunks, { type: 'application/octet-stream' });
  const cached = new Response(blob, {
    headers: { 'Content-Type': 'application/octet-stream' },
  });

  if (cache) {
    // Quota errors must not break the app — silently skip storing.
    try {
      await cache.put(url, cached.clone());
    } catch (_) {}
  }

  return cached;
}
