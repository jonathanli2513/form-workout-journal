/* The build fills the version and digest map. Never cache account/API responses. */
const CACHE_VERSION = 'form-v2';
const SHELL_HASHES = {};
const CACHE_PREFIX = 'form-shell-' + encodeURIComponent(self.registration.scope) + ':';
const CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;
const scope = self.registration.scope;
const shell = new Map(Object.entries(SHELL_HASHES).map(([path, hash]) => [new URL(path, scope).href, hash]));
let checkingForUpdate = false;

async function digest(response) {
  const bytes = await response.clone().arrayBuffer();
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function checkForUpdate() {
  if (checkingForUpdate) return Promise.resolve();
  checkingForUpdate = true;
  return self.registration.update().catch(() => {}).finally(() => { checkingForUpdate = false; });
}
async function shellFetch(url, request, expectedHash, tasks) {
  let cache;
  try { cache = await caches.open(CACHE_NAME); }
  catch { return fetch(request); } // Storage restrictions must not break an online visit.
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 1800);
  try {
    // The digest check keeps a single app version together while an update waits.
    const response = await fetch(new Request(request, { cache: 'no-cache', signal: abort.signal }));
    if (response.ok && await digest(response) === expectedHash) {
      tasks.push(cache.put(url, response.clone()).catch(() => {}));
      return response;
    }
    tasks.push(checkForUpdate());
  } catch { /* A paused backend is unrelated; only shell URLs reach this worker. */ }
  finally { clearTimeout(timeout); }
  const cached = await cache.match(url);
  if (cached) return cached;
  return new Response('Form is unavailable offline on this device. Connect to the internet, close all Form tabs, and reopen the app.', {
    status: 503,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      await Promise.all([...shell].map(async ([url, hash]) => {
        const response = await fetch(new Request(url, { cache: 'reload' }));
        if (!response.ok || await digest(response) !== hash) throw new Error('App shell changed during installation.');
        await cache.put(url, response);
      }));
    } catch (error) {
      await caches.delete(CACHE_NAME);
      throw error; // Keep the preceding working version when any asset is missing.
    }
    // Let the current workout finish. The update activates after existing tabs close.
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map(name => caches.delete(name)));
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Ignore search strings for the static shell, without storing auth-link URLs.
  url.search = '';
  url.hash = '';
  const expectedHash = shell.get(url.href);
  if (!expectedHash) return; // Supabase, auth, backups, and external fonts bypass this cache.
  const tasks = [];
  const response = shellFetch(url.href, request, expectedHash, tasks);
  event.respondWith(response);
  // Extend the event synchronously, then include cache/update work added by fetch.
  event.waitUntil(response.then(() => Promise.allSettled(tasks)).catch(() => {}));
});

// An explicit click on update.html activates a prepared update. Existing pages
// are not automatically reloaded, so their unsaved input is left alone.
self.addEventListener('message', event => {
  if (event.data?.type === 'FORM_ACTIVATE_UPDATE') event.waitUntil(self.skipWaiting());
});
