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
  if (!resp.ok) throw new Error('Движок недоступен: HTTP ' + resp.status);
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

async function gxStartGame() {
  // Engine wasm was pre-downloaded by gxPreloadEngine() into window.gxEngine.
  const buildId = window.gxEngine.buildId || 'dev';
  const wasmBinary = window.gxEngine.wasmBinary;

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
