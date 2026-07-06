// terrain-cache.js — single point of truth for terrain data URLs + download-once caching.
//
// Deployers: set window.RIDGELINE_DATA_BASE to an absolute URL before this module loads,
// e.g. 'https://huggingface.co/datasets/idle-intelligence/ridgeline-terrain/resolve/main'
// The local dev default is '../data' (relative to the web/ directory).
//
// Cache version: bump 'ridgeline-terrain-v1' → 'ridgeline-terrain-v2' whenever the .bin
// files are re-baked so users automatically re-download the new data.

const DATA_BASE = () => window.RIDGELINE_DATA_BASE ?? '../data';

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
    cache = await caches.open('ridgeline-terrain-v1');
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
