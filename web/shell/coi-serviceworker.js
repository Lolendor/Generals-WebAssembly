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
    if (r.cache === 'only-if-cached' && r.mode !== 'same-origin') return;

    e.respondWith(
      fetch(r).then((res) => {
        if (res.status === 0) return res; // opaque
        const headers = new Headers(res.headers);
        headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
        headers.set('Cross-Origin-Opener-Policy', 'same-origin');
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
