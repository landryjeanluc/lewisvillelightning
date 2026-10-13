/**
 * The worker behind the "Add to Home Screen" button.
 *
 * It is here for two reasons, in this order:
 *
 *  1. Chrome will not offer to install a site that does not control a service
 *     worker with a fetch handler. `beforeinstallprompt` — the event the
 *     install button on the home page waits for — simply never fires without
 *     one. No worker, no one-tap install on Android.
 *  2. The fonts, the stylesheet and the crests are the heavy part of a page and
 *     never change within a build, so answering them from the cache makes the
 *     second visit instant and an arena with one bar of signal survivable.
 *
 * What it deliberately does NOT touch: pages, /api, /photos and /team. Those
 * carry nineteen minors' names, faces, and the arena they will be standing in
 * on Saturday — the whole site sits behind a login gate for that reason, and
 * copying them into a cache that outlives the session is the wrong trade.
 *
 * It also keeps the gate honest. nginx answers a signed-out request with a 302
 * to /login; `response.redirected` below is what stops the login page being
 * cached in place of the font or the page it was redirected from.
 */
const CACHE = "lvlnb-static-v1";

// Hashed build output and vendored assets — the same bytes for the life of a
// build, and nothing team-specific in any of them.
const STATIC = [/^\/_astro\//, /^\/fonts\//, /^\/brand\//, /^\/icons\//];

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (!STATIC.some((re) => re.test(url.pathname))) return;
  event.respondWith(staleWhileRevalidate(req));
});

// Cache first so it is fast, refresh behind the answer so an unhashed asset —
// a replaced crest, a new icon — is at most one visit out of date.
async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  const live = fetch(req)
    .then((res) => {
      if (res.ok && !res.redirected && res.type === "basic") cache.put(req, res.clone());
      return res;
    })
    .catch(() => hit);
  return hit || live;
}
