// GeneralsX Web - Emscripten module bootstrap.
//
// Loaded by index.html; gxStartGame() is called by loader.js after the assets
// are in place and the user pressed Play.
//
// GeneralsX @build web-port 05/07/2026 - Web port Phase 1

'use strict';

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
  // Cache-buster for the engine code on dumb static hosts: browsers must
  // never pair a stale cached GeneralsXZH.js with a newer .wasm.
  let buildId = 'dev';
  try {
    const r = await fetch('build.json', { cache: 'no-cache' });
    if (r.ok) buildId = (await r.json()).buildId || 'dev';
  } catch {}

  return new Promise((resolve, reject) => {
    const canvas = document.getElementById('canvas');

    window.Module = {
      canvas: canvas,
      arguments: gxGameArguments(),
      locateFile: (f) => f + '?v=' + buildId, // relative: wasm lives next to index.html
      // 0 = OPFS (WASMFS OPFS backend), 1 = IndexedDB (js-file backend +
      // population from window.gxFiles). Read by WebMain.cpp.
      gxStorageMode: window.gxStorageKind === 'idb' ? 1 : 0,
      // Loader settings: render FPS limit (see index.html #gx-settings).
      gxFps: parseInt(localStorage.getItem('gx-fps') || '30', 10),
      // Loader language setting.
      gxLang: localStorage.getItem('gx-lang') || 'english',
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
        const el = document.getElementById('gx-error');
        el.style.display = 'block';
        el.textContent = 'Игра завершила работу (код ' + code + '). Обновите страницу, чтобы запустить снова.';
      },
    };

    const s = document.createElement('script');
    s.src = 'GeneralsXZH.js?v=' + buildId;
    s.onerror = () => reject(new Error('Не удалось загрузить GeneralsXZH.js'));
    document.body.appendChild(s);
  });
}

window.gxStartGame = gxStartGame;
