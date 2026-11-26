// Service worker of the prod build: keeps the game assets of the R2 asset store
// (Worker pb-assets) in Cache Storage so a player downloads each file once, not once per session. Registered only by
// src/cache/register.ts in a build with VITE_ASSET_BASE (never in dev): `/sw.js?base=<asset origin>`.
// Strategy per URL (strategyFor):
//   asset store, name '<stem>.<hash8>.<ext>' (immutable, includes asset-map.<hash8>.json) -> cache-first
//   asset store, 'asset-map.json' (the map of a build without VITE_ASSET_MAP)              -> network-first
//   asset store, any other name (probe of an optional file, unhashed)                      -> stale-while-revalidate
//   everything else (page, /bundle, /api, WebSocket signalling), non-GET, Range (audio)    -> not intercepted
// Only 200 CORS responses are stored (an opaque one costs ~7 MB of padded quota): the Worker answers
// Access-Control-Allow-Origin: *, so a no-cors request (CSS background) is refetched here with mode cors.
// Same-origin (PWA + speed; also works without VITE_ASSET_BASE, where the game assets are served from the page origin):
//   page '/' (navigation)                                  -> network-first, the last good copy is the offline fallback
//   /assets/ vite bundle (name-<hash>.js|css|wasm|font)    -> cache-first
//   /assets/ any other file, manifest, cursor              -> stale-while-revalidate (first visit downloads, next ones are instant)
//   /api, WebSocket signalling, the sw itself, other pages -> not intercepted
// Cleanup: caches of an older SW version are deleted on activate; when a new asset map is fetched, hashed entries it no
// longer lists are deleted; past BUDGET (or 60% of the quota) the oldest entries go first.
const CACHE = 'pb-assets-v1';
const SHELL = 'pb-shell-v1';
/** warmed at install (each one optional: a 404 on a build whose assets live on the asset store is ignored) */
const PRECACHE = [
  '/manifest.webmanifest',
  '/assets/icons/android/launchericon-192x192.png',
  '/assets/ui/cross/brand/icon.png',
  '/assets/ui/cross/brand/login-bg.jpg',
];
const BUDGET = 2 * 1024 * 1024 * 1024;
const HASHED = /\.[0-9a-f]{8}\.[A-Za-z0-9]+$/;
const MAP_NAME = /(^|\/)asset-map\.([0-9a-f]{8}\.)?json$/;
/** vite output under /assets/: name-<8 chars>.js|css|... (immutable) */
const VITE_HASHED = /^\/assets\/.+-[A-Za-z0-9_-]{8}\.(?:m?js|css|wasm|woff2?)$/;

/**
 * ctx: { assetOrigin: string|null, method: string, range: boolean, selfOrigin?: string, navigate?: boolean }
 * -> 'cache-first' | 'network-first' | 'swr' | 'shell' | 'bypass'
 */
function strategyFor(url, ctx) {
  if (ctx.method !== 'GET' || ctx.range) return 'bypass';
  let u;
  try { u = new URL(url); } catch { return 'bypass'; }
  if (ctx.assetOrigin && u.origin === ctx.assetOrigin) {
    if (HASHED.test(u.pathname)) return 'cache-first';
    if (MAP_NAME.test(u.pathname)) return 'network-first';
    return 'swr';
  }
  if (ctx.selfOrigin && u.origin === ctx.selfOrigin) {
    const p = u.pathname;
    if (ctx.navigate) return p === '/' || p === '/index.html' ? 'shell' : 'bypass';
    if (p.startsWith('/assets/')) return HASHED.test(p) || VITE_HASHED.test(p) ? 'cache-first' : 'swr';
    if (p === '/manifest.webmanifest' || p === '/pb-cursor.cur') return 'swr';
  }
  return 'bypass';
}

/** bytes the cache may hold: BUDGET, or 60% of the browser quota when that is smaller */
function budgetFor(quota) {
  return quota && quota > 0 ? Math.min(BUDGET, Math.floor(quota * 0.6)) : BUDGET;
}

/** entries: [{ key, size }] oldest first. Keys to delete (oldest first) so the total ends at <= 90% of budget; none when it fits. */
function planTrim(entries, budget) {
  let total = entries.reduce((s, e) => s + e.size, 0);
  if (total <= budget) return [];
  const out = [];
  for (const e of entries) {
    if (total <= budget * 0.9) break;
    out.push(e.key);
    total -= e.size;
  }
  return out;
}

/** every URL of the asset map (format of src/assetMap.ts) under `base`, normalised like Request.url */
function validUrls(map, base) {
  const root = base.replace(/\/+$/, '');
  const out = new Set();
  for (const [dir, names] of Object.entries(map.dirs || {})) {
    for (const [name, v] of Object.entries(names)) {
      let file;
      if (v.includes('.')) file = `${dir}/${v}`;
      else { const e = name.lastIndexOf('.'); file = e > 0 ? `${dir}/${name.slice(0, e)}.${v}${name.slice(e)}` : `${dir}/${name}.${v}`; }
      out.add(new URL(`${root}/${file.split('/').map(encodeURIComponent).join('/')}`).href);
    }
  }
  return out;
}

/** cached asset-store URLs (hashed names, not maps) that `valid` does not list */
function staleKeys(keys, valid, assetOrigin) {
  return keys.filter((k) => {
    const u = new URL(k);
    return u.origin === assetOrigin && HASHED.test(u.pathname) && !MAP_NAME.test(u.pathname) && !valid.has(u.href);
  });
}

const core = { CACHE, SHELL, strategyFor, budgetFor, planTrim, validUrls, staleKeys };

if (typeof module === 'object' && module.exports) {
  module.exports = core; // node smoke (tools/test-sw.mjs)
} else {
  const params = new URL(self.location.href).searchParams;
  const assetOrigin = params.get('base');
  const ok = (res) => res && res.status === 200 && res.type !== 'opaque';
  const selfOrigin = self.location.origin;
  // the asset store answers with CORS *: a no-cors request is refetched with mode cors; same-origin files keep the request as is
  const fetchAsset = (req) => (new URL(req.url).origin === selfOrigin
    ? fetch(req)
    : fetch(req.url, { mode: 'cors', credentials: 'omit' }).catch(() => fetch(req)));

  let trimAt = 0;
  async function trim(cache) {
    if (Date.now() - trimAt < 60000) return;
    trimAt = Date.now();
    const est = (await navigator.storage?.estimate?.().catch(() => null)) || {};
    const keys = await cache.keys();
    const entries = [];
    for (const k of keys) {
      const r = await cache.match(k);
      entries.push({ key: k, size: Number(r?.headers.get('content-length')) || 0 });
    }
    for (const k of planTrim(entries, budgetFor(est.quota))) await cache.delete(k);
  }

  async function store(cache, req, res) {
    try { await cache.put(req.url, res); await trim(cache); } catch { /* quota exceeded: the file just is not kept */ }
  }

  async function pruneForMap(cache, res) {
    try {
      const map = await res.json();
      if (map.v !== 1 || !map.dirs || !Object.keys(map.dirs).length) return;
      const keys = (await cache.keys()).map((r) => r.url);
      for (const k of staleKeys(keys, validUrls(map, assetOrigin), assetOrigin)) await cache.delete(k);
    } catch { /* not a map */ }
  }

  /** the page: network-first, the last good copy of '/' is the offline fallback (one entry: other navigations bypass) */
  async function handleShell(ev) {
    const shell = await caches.open(SHELL);
    try {
      const res = await fetch(ev.request);
      if (ok(res)) ev.waitUntil(shell.put('/', res.clone()));
      return res;
    } catch (e) {
      const hit = await shell.match('/');
      if (hit) return hit;
      throw e;
    }
  }

  async function precache() {
    const cache = await caches.open(CACHE);
    await Promise.allSettled(PRECACHE.map((u) => cache.add(u)));
  }

  async function handle(ev, kind) {
    if (kind === 'shell') return handleShell(ev);
    const req = ev.request;
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req.url);
    const isMap = MAP_NAME.test(new URL(req.url).pathname);
    const refresh = async () => {
      const res = await fetchAsset(req);
      if (ok(res)) {
        if (isMap) ev.waitUntil(pruneForMap(cache, res.clone()));
        ev.waitUntil(store(cache, req, res.clone()));
      }
      return res;
    };
    if (kind === 'cache-first') return hit || refresh();
    if (kind === 'swr') { const p = refresh().catch(() => hit); if (hit) { ev.waitUntil(p); return hit; } return p; }
    try { return await refresh(); } catch (e) { if (hit) return hit; throw e; } // network-first
  }

  self.addEventListener('install', (ev) => {
    ev.waitUntil(precache().catch(() => {}));
    self.skipWaiting();
  });
  self.addEventListener('activate', (ev) => {
    ev.waitUntil((async () => {
      for (const k of await caches.keys()) {
        if ((k.startsWith('pb-assets-') && k !== CACHE) || (k.startsWith('pb-shell-') && k !== SHELL)) await caches.delete(k);
      }
      await self.clients.claim();
    })());
  });
  self.addEventListener('fetch', (ev) => {
    const kind = strategyFor(ev.request.url, {
      assetOrigin,
      selfOrigin,
      method: ev.request.method,
      range: ev.request.headers.has('range'),
      navigate: ev.request.mode === 'navigate',
    });
    if (kind !== 'bypass') ev.respondWith(handle(ev, kind));
  });
}