/*
 * COOP/COEP via Service Worker - lets the game run on ANY static host that
 * doesn't send Cross-Origin-Opener-Policy / Cross-Origin-Embedder-Policy
 * headers (plain nginx, GitHub Pages, shared hosting...). Without those
 * headers the browser refuses SharedArrayBuffer and pthreads cannot start.
 *
 * How it works: on first visit this script registers ITSELF as a service
 * worker and reloads the page once; from then on the SW intercepts every
 * same-origin fetch and adds the two headers to the response. Requires a
 * secure context (HTTPS or localhost) - nothing can help plain http://<ip>.
 *
 * Pattern after gzuidhof/coi-serviceworker (MIT).
 * GeneralsX @build web-port 05/07/2026 - Web port (static hosting mode)
 */

/* eslint-env serviceworker, browser */
'use strict';

if (typeof window === 'undefined') {
  // ---- Service worker context ----
  self.addEventListener('install', () => self.skipWaiting());
  self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

  self.addEventListener('message', (ev) => {
    if (ev.data && ev.data.type === 'deregister') {
      self.registration.unregister().then(() => self.clients.matchAll())
        .then((clients) => clients.forEach((c) => c.navigate(c.url)));
    }
  });

  self.addEventListener('fetch', (e) => {
    const r = e.request;

    // Big binaries (the ~1.1 GB build.data archive and the ~78 MB wasm) must
    // NOT be piped through the SW: re-wrapping their body streams every chunk
    // through the service-worker thread, which blows past iOS Safari's tight SW
    // memory/lifetime limits and gets the SW killed mid-download ("Service
    // Worker context closed"). They are same-origin, so COEP: require-corp
    // allows them by default (CORP defaults to same-origin) without any rewrite
    // — fetch them straight from the network.
    const path = (() => { try { return new URL(r.url).pathname; } catch { return ''; } })();
    if (path.endsWith('.data') || path.endsWith('.wasm')) return;

    // Everything else is small (HTML, JS, the unpack worker, JSON). Add the
    // COOP/COEP/CORP headers so the document is crossOriginIsolated AND the
    // dedicated worker script carries its own require-corp — a worker created
    // in a require-corp context is blocked unless its script response has COEP.
    e.respondWith(
      fetch(r).then((res) => {
        if (res.status === 0) return res; // opaque
        const headers = new Headers(res.headers);
        headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
        headers.set('Cross-Origin-Opener-Policy', 'same-origin');
        headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
        return new Response(res.body, {
          status: res.status,
          statusText: res.statusText,
          headers: headers,
        });
      }).catch((err) => {
        console.error('[coi-sw] fetch failed:', err);
        throw err;
      })
    );
  });
} else {
  // ---- Window context: register + one-time reload ----
  (() => {
    if (window.crossOriginIsolated) return; // host already sends the headers

    if (!window.isSecureContext) {
      console.warn('[coi-sw] not a secure context - service worker cannot help; use HTTPS');
      return;
    }
    if (!('serviceWorker' in navigator)) {
      console.warn('[coi-sw] no serviceWorker support');
      return;
    }

    const swUrl = document.currentScript && document.currentScript.src;
    if (!swUrl) return;

    // Signal to the loader that a COI reload may be coming.
    window.gxCoiPending = true;

    navigator.serviceWorker.register(swUrl)
      .then((reg) => {
        console.log('[coi-sw] registered, scope:', reg.scope);
        // Force an update check so a changed SW script is picked up promptly
        // instead of the browser lazily keeping an old cached worker.
        reg.update().catch(() => {});
        // ready resolves once a worker is ACTIVE (covers the first-install
        // race where updatefound fires before listeners attach).
        return navigator.serviceWorker.ready;
      })
      .then(() => {
        if (!navigator.serviceWorker.controller) {
          console.log('[coi-sw] active but not controlling - reloading to pick up COOP/COEP...');
          window.location.reload();
        }
      })
      .catch((e) => {
        console.error('[coi-sw] registration failed:', e);
        window.gxCoiPending = false;
      });
  })();
}
