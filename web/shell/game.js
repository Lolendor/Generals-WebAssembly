// GeneralsX Web - Emscripten module bootstrap.
//
// Loaded by index.html; gxStartGame() is called by loader.js after the assets
// are in place and the user pressed Play.
//
// GeneralsX @build web-port 05/07/2026 - Web port Phase 1

'use strict';

// Cached engine payload from gxPreloadEngine(): the wasm binary + resolved
// buildId, so gxStartGame() instantiates without any further network fetch.
window.gxEngine = { wasmBinary: null, buildId: 'dev' };

// Stage 1 (after Play, before resources): download GeneralsXZH.wasm into memory
// with progress. Emscripten later instantiates from Module.wasmBinary, so the
// engine never fetches the wasm itself (works on any static host, one place to
// show progress). onProgress(received, total).
async function gxPreloadEngine(onProgress) {
  let buildId = 'dev';
  try {
    const r = await fetch('build.json', { cache: 'no-cache' });
    if (r.ok) buildId = (await r.json()).buildId || 'dev';
  } catch {}
  window.gxEngine.buildId = buildId;

  const resp = await fetch('GeneralsXZH.wasm?v=' + buildId);
  // GeneralsX @feature Lolendor 22/07/2026 Localize launch-screen engine errors.
  if (!resp.ok) throw new Error(window.gxI18n.t('error.engineHttp', { status: resp.status }));
  const total = parseInt(resp.headers.get('Content-Length') || '0') || 0;

  const reader = resp.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    if (onProgress) onProgress(received, total);
  }
  const bin = new Uint8Array(received);
  let pos = 0;
  for (const c of chunks) { bin.set(c, pos); pos += c.byteLength; }
  window.gxEngine.wasmBinary = bin;
}

function gxGameArguments() {
  // Pass engine flags via URL: ?args=-headless+-noshellmap etc.
  const p = new URLSearchParams(location.search);
  const raw = p.get('args');
  const args = raw ? raw.split(' ').filter(Boolean) : [];
  // Loader settings (index.html #gx-settings): FPS limit -> engine -fps.
  // An explicit -fps in ?args= wins.
  if (!args.includes('-fps')) {
    const fps = parseInt(localStorage.getItem('gx-fps') || '30', 10);
    if (fps > 0 && fps !== 30) {
      args.push('-fps', String(fps));
    }
  }
  return args;
}

// Keep game hotkeys away from the browser. Generals uses Ctrl+1..9 (assign
// control group), plain 1..9 (select group), Alt+combos, F-keys, Tab, Space.
// The browser's defaults (Ctrl/Cmd+digit = switch tab, Ctrl+S/P/F/D/O/U, quick
// find on '/', backspace-navigation, ...) would fire on top of the game.
// A capture-phase listener on window runs BEFORE the browser default AND does
// not stop the event from reaching SDL's canvas handler (preventDefault only
// cancels the default action, not propagation).
// NOTE: Ctrl/Cmd+W, +T, +N and Cmd+Q are reserved by the browser and cannot be
// intercepted from a page; everything else below works.
function gxInstallKeyGuard() {
  if (window.gxKeyGuard) return;
  window.gxKeyGuard = (e) => {
    // Don't interfere while a shell DOM input has focus (e.g. the multiplayer
    // room-code field needs Ctrl+V / normal editing).
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

    const k = e.key;
    const mod = e.ctrlKey || e.metaKey;

    // Ctrl/Cmd + digit (tab switching) — the control-group keys.
    if (mod && k >= '0' && k <= '9') { e.preventDefault(); return; }

    // Browser single-key/page shortcuts that break RTS input.
    if (!mod && (k === 'Tab' || k === '/' || k === "'" || k === 'F1' || k === 'F3' ||
                 k === 'F5' || k === 'F6' || k === 'F7' || k === 'F10' || k === 'F11' || k === 'F12')) {
      e.preventDefault(); return;
    }

    // Backspace navigating back when the canvas has focus.
    if (!mod && k === 'Backspace') { e.preventDefault(); return; }

    // Ctrl/Cmd + letter shortcuts (save page, print, find, bookmark, view
    // source, history, downloads, address bar, ...). The game handles its own
    // Ctrl+letter combos; W/T/N are browser-reserved and unreachable anyway.
    if (mod && k.length === 1 && ((k >= 'a' && k <= 'z') || (k >= 'A' && k <= 'Z'))) {
      e.preventDefault(); return;
    }
  };
  window.addEventListener('keydown', window.gxKeyGuard, { capture: true });
}

async function gxStartGame() {
  // Engine wasm was pre-downloaded by gxPreloadEngine() into window.gxEngine.
  const buildId = window.gxEngine.buildId || 'dev';
  const wasmBinary = window.gxEngine.wasmBinary;

  // Arm the hotkey guard for the whole game session.
  gxInstallKeyGuard();
  // And the focus guard (minimize/restore resilience).
  gxInstallFocusGuard();

  return new Promise((resolve, reject) => {
    const canvas = document.getElementById('canvas');

    window.Module = {
      canvas: canvas,
      arguments: gxGameArguments(),
      // Instantiate from the pre-downloaded binary — no wasm fetch here.
      wasmBinary: wasmBinary,
      locateFile: (f) => f + '?v=' + buildId, // for any other asset the JS glue needs
      // 0 = OPFS (WASMFS OPFS backend), 1 = IndexedDB (js-file backend +
      // population from window.gxFiles). Read by WebMain.cpp.
      gxStorageMode: window.gxStorageKind === 'idb' ? 1 : 0,
      // Loader settings: render FPS limit (see index.html #gx-settings).
      gxFps: parseInt(localStorage.getItem('gx-fps') || '30', 10),
      // Selected build name (stored by loader, consumed by WebMain if needed).
      gxBuildName: localStorage.getItem('gx-build') || 'default_ru',
      print: (t) => console.log('[game]', t),
      printErr: (t) => {
        // Drop known per-frame spam (same filter the iOS port uses in its
        // log sink) - keeps the console usable during real sessions.
        if (t.startsWith('[GX-ISSUE144]') || t.startsWith('[INI] ')) return;
        console.warn('[game]', t);
      },
      onRuntimeInitialized: () => {
        console.log('[game] runtime initialized');
        resolve();
      },
      onAbort: (why) => {
        console.error('[game] abort:', why);
        reject(new Error('Движок аварийно завершился: ' + why));
      },
      onExit: (code) => {
        console.log('[game] exited with code', code);
        gxOnEngineExit();
      },
    };

    const s = document.createElement('script');
    s.src = 'GeneralsXZH.js?v=' + buildId;
    s.onerror = () => reject(new Error('Не удалось загрузить GeneralsXZH.js'));
    document.body.appendChild(s);
  });
}

// Focus resilience: after minimize/restore churn the browser can leave the tab
// focused but SDL's notion of focus stuck at "lost" (blur delivered without a
// matching focus). Re-assert focus on the canvas whenever the tab becomes
// visible or the window regains OS focus, and on any pointer-down — a focused
// canvas makes SDL's Emscripten_GetFocusedWindow() resolve correctly and lets
// its window-level key handlers see events again.
function gxInstallFocusGuard() {
  if (window.gxFocusGuard) return;
  const refocus = () => {
    const cv = document.getElementById('canvas');
    if (!cv) return;
    // Only steal focus when nothing interactive holds it (don't fight inputs).
    const ae = document.activeElement;
    if (!ae || ae === document.body || ae === cv) {
      try { cv.focus({ preventScroll: true }); } catch {}
    }
  };
  window.gxFocusGuard = refocus;
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) setTimeout(refocus, 0);
  });
  window.addEventListener('focus', () => setTimeout(refocus, 0));
  window.addEventListener('pointerdown', refocus, { capture: true });
  refocus();
}

// Called when the engine quits (from C++ before _exit, and via Module.onExit).
// The wasm runtime is torn down and cannot restart in place, so reload the page:
// gxBoot shows the start overlay with Play, and since the build is already in
// OPFS the relaunch only re-fetches the cached engine wasm. Guarded so a double
// call (C++ hook + onExit) reloads only once.
let gxExiting = false;
function gxOnEngineExit() {
  if (gxExiting) return;
  gxExiting = true;
  try {
    const ov = document.getElementById('gx-overlay');
    if (ov) {
      ov.style.display = 'flex';
      const d = document.getElementById('gx-detail');
      if (d) d.textContent = 'Возврат в меню…';
    }
  } catch {}
  location.reload();
}

window.gxStartGame = gxStartGame;
window.gxPreloadEngine = gxPreloadEngine;
window.gxOnEngineExit = gxOnEngineExit;
