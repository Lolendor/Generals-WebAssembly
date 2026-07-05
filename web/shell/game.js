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
  if (!raw) return [];
  return raw.split(' ').filter(Boolean);
}

function gxStartGame() {
  return new Promise((resolve, reject) => {
    const canvas = document.getElementById('canvas');

    window.Module = {
      canvas: canvas,
      arguments: gxGameArguments(),
      locateFile: (f) => f, // relative: wasm lives next to index.html
      // 0 = OPFS (WASMFS OPFS backend), 1 = IndexedDB (js-file backend +
      // population from window.gxFiles). Read by WebMain.cpp.
      gxStorageMode: window.gxStorageKind === 'idb' ? 1 : 0,
      print: (t) => console.log('[game]', t),
      printErr: (t) => console.warn('[game]', t),
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
    s.src = 'GeneralsXZH.js';
    s.onerror = () => reject(new Error('Не удалось загрузить GeneralsXZH.js'));
    document.body.appendChild(s);
  });
}

window.gxStartGame = gxStartGame;
