// GeneralsX Web - asset loader.
//
// Streams build.data (GAXD format): reads index from stream start,
// pipes compressed blob through DecompressionStream, splits decompressed
// data into files and writes them to OPFS/IDB concurrently (4 in parallel).
//
// GeneralsX @build web-port 06/07/2026

'use strict';

const gxUI = {
  overlay: null, detail: null,
  dlBar: null, dlVal: null, unBar: null, unVal: null,
  init() {
    this.overlay = document.getElementById('gx-overlay');
    this.detail = document.getElementById('gx-detail');
    this.dlBar = document.getElementById('gx-bar');
    this.dlVal = document.getElementById('gx-dl-val');
    this.unBar = document.getElementById('gx-bar2');
    this.unVal = document.getElementById('gx-un-val');
  },
  error(msg) {
    console.error('[loader]', msg);
    const el = document.getElementById('gx-error');
    el.style.display = 'block';
    el.textContent = msg;
    document.getElementById('gx-progress-wrap').style.display = 'none';
  },
  download(done, total, detail) {
    const pct = total > 0 ? Math.floor((done / total) * 100) : 0;
    this.dlBar.style.width = pct + '%';
    this.dlVal.textContent = total > 0 ? gxHuman(done) + ' / ' + gxHuman(total) : gxHuman(done);
    if (detail) this.detail.textContent = detail;
  },
  unpack(done, total) {
    const pct = total > 0 ? Math.floor((done / total) * 100) : 0;
    this.unBar.style.width = pct + '%';
    this.unVal.textContent = done + ' / ' + total;
  },
  status(text) { this.detail.textContent = text; },
};

function gxHuman(b) {
  if (b > 1073741824) return (b / 1073741824).toFixed(2) + ' ГБ';
  if (b > 1048576) return (b / 1048576).toFixed(1) + ' МБ';
  if (b > 1024) return (b / 1024).toFixed(0) + ' КБ';
  return b + ' Б';
}

// ── Stream extraction (worker-driven) ────────────────────────────────────
// The worker fetches build.data itself and runs the whole pipeline (parse index,
// brotli decompress, write to OPFS/IDB) on its own thread — no cross-thread
// chunk flood. The main thread only relays progress to the UI.
// Returns { files, entries } (entries needed for IDB materialization).

async function gxStreamExtract(url, storage) {
  // The unpack worker is tiny (~9 KB) — always fetch fresh so a redeployed
  // worker is never served stale from the browser's Worker script cache (which
  // caused old builds to keep running with a since-fixed "offset out of bounds"
  // path). brotli_bg.wasm (~1 MB, rarely changes) is versioned by buildId.
  const ver = (window.gxEngine && window.gxEngine.buildId) || 'dev';
  const bust = ver + '.' + (Date.now() >>> 0);
  const worker = new Worker('unpack-worker.js?v=' + bust);
  const wasmUrl = new URL('brotli_bg.wasm?v=' + ver, document.baseURI).href;
  let entries = null;

  const result = await new Promise((resolve, reject) => {
    worker.addEventListener('message', (ev) => {
      const m = ev.data;
      if (m.type === 'download') {
        gxUI.download(m.received, m.total);          // gold bar — network
      } else if (m.type === 'index') {
        entries = m.entries;
        gxUI.unpack(0, entries.length);
      } else if (m.type === 'progress') {
        gxUI.unpack(m.done, m.total);                // green bar — decompress+write
      } else if (m.type === 'complete') {
        resolve({ files: m.files, entries: m.entries });
      } else if (m.type === 'error') {
        reject(new Error(m.message));
      }
    });
    worker.addEventListener('error', (e) => {
      // A worker load/parse error (e.g. failed importScripts, COEP block) fires
      // here with an empty message — surface filename:line so it's diagnosable.
      const where = e.filename ? (' @ ' + e.filename + ':' + e.lineno) : '';
      const msg = e.message || 'не удалось загрузить unpack-worker.js';
      console.error('[loader] worker error event:', e);
      reject(new Error('Worker: ' + msg + where));
    });
    worker.addEventListener('messageerror', (e) => {
      console.error('[loader] worker messageerror:', e);
      reject(new Error('Worker: ошибка сериализации сообщения'));
    });
    worker.postMessage({ type: 'start', url, wasmUrl, mode: storage.kind });
  });

  worker.terminate();
  return result;
}

// ── Checks & init ────────────────────────────────────────────────────────────

async function gxCheckEnvironment() {
  if (!crossOriginIsolated) {
    if (window.gxCoiPending) {
      gxUI.status('Настройка окружения…');
      await new Promise((r) => setTimeout(r, 4000));
    }
    if (!crossOriginIsolated) throw new Error('SharedArrayBuffer недоступен. Используйте HTTPS.');
  }
  if (typeof WebAssembly === 'undefined') throw new Error('WebAssembly не поддерживается.');
}

// IndexedDB mode: load every stored file into window.gxFiles for the engine
// (OPFS mode reads the mounted filesystem directly, so this is a no-op there).
async function gxMaterializeIdb(storage) {
  const paths = (await storage.listPaths()).filter(k => typeof k === 'string');
  const assetPaths = paths.filter(k => !k.startsWith('meta/'));
  const files = [];
  for (let i = 0; i < assetPaths.length; i++) {
    files.push({ path: assetPaths[i], data: await storage.readBytes(assetPaths[i]) });
    if (i % 20 === 0) gxUI.unpack(i, assetPaths.length);
  }
  gxUI.unpack(assetPaths.length, assetPaths.length);
  window.gxFiles = files;
  window.gxIdbPutUserFile = (path, bytes) => {
    storage.writeBlob('userdata/' + path, new Blob([bytes])).catch(e =>
      console.warn('[loader] userdata write-back failed:', path, e));
  };
}

async function gxLoadNetConfig() {
  try {
    const r = await fetch('ice.json', { cache: 'no-cache' });
    if (!r.ok) return;
    const cfg = await r.json();
    if (cfg && Array.isArray(cfg.iceServers) && cfg.iceServers.length)
      window.gxNetConfig.iceServers = cfg.iceServers;
    if (cfg && Array.isArray(cfg.mqttBrokers) && cfg.mqttBrokers.length)
      window.gxNetConfig.mqttBrokers = cfg.mqttBrokers;
  } catch (e) {
    console.warn('[loader] ice.json не прочитан:', e);
  }
}

// ── Boot ─────────────────────────────────────────────────────────────────────

async function gxBoot() {
  gxUI.init();

  try {
    await gxCheckEnvironment();
    await gxLoadNetConfig();

    const storage = await gxDetectStorage();
    console.log('[loader] хранилище:', storage.kind);
    window.gxStorageKind = storage.kind;
    document.getElementById('gx-storage-kind').textContent =
      storage.kind === 'opfs' ? 'OPFS' : 'IndexedDB (fallback)';

    // Show settings + play immediately
    document.getElementById('gx-progress-wrap').style.display = 'none';
    gxUI.status('Настройте сборку и нажмите Играть');

    const btn = document.getElementById('gx-play');
    btn.style.display = 'inline-block';

    const settingsBtn = document.getElementById('gx-settings-btn');
    const settingsBox = document.getElementById('gx-settings');
    const fpsSel = document.getElementById('gx-fps');
    fpsSel.value = localStorage.getItem('gx-fps') || '30';
    if (![...fpsSel.options].some(o => o.value === fpsSel.value)) fpsSel.value = '30';
    fpsSel.addEventListener('change', () => localStorage.setItem('gx-fps', fpsSel.value));

    const buildSel = document.getElementById('gx-build');
    buildSel.value = localStorage.getItem('gx-build') || 'default_ru';
    if (![...buildSel.options].some(o => o.value === buildSel.value)) buildSel.value = 'default_ru';
    buildSel.addEventListener('change', () => localStorage.setItem('gx-build', buildSel.value));

    settingsBtn.style.display = 'inline-block';
    settingsBtn.addEventListener('click', () => { settingsBox.hidden = !settingsBox.hidden; });

    await new Promise((resolve) => btn.addEventListener('click', resolve, { once: true }));
    btn.style.display = 'none';
    settingsBtn.style.display = 'none';
    settingsBox.hidden = true;

    const build = localStorage.getItem('gx-build') || 'default_ru';
    const markerKey = 'installed-' + build;

    // Stage 1: download the engine (wasm) into memory, with progress. Always
    // needed — done before resources so a fresh install and a cached reload both
    // fetch the engine here, and the engine never fetches its own wasm later.
    document.getElementById('gx-progress-wrap').style.display = 'block';
    gxUI.download(0, 0);
    gxUI.unpack(0, 0);
    gxUI.status('Загрузка движка…');
    await gxPreloadEngine((received, total) => gxUI.download(received, total));

    // Already installed? Skip the resource download/unpack and go straight to play.
    const marker = await storage.readMeta(markerKey);
    if (marker && marker.complete) {
      console.log('[loader] сборка ' + build + ' уже установлена (' + marker.files + ' файлов) — пропускаю загрузку');
      if (storage.kind === 'idb') {
        gxUI.status('Подготовка файлов…');
        await gxMaterializeIdb(storage);
      }
      gxUI.status('Запуск движка…');
      document.getElementById('gx-progress-wrap').style.display = 'none';
      await gxStartGame();
      gxUI.overlay.style.display = 'none';
      return;
    }

    // Stage 2: download + unpack game resources.
    gxUI.download(0, 0);
    gxUI.unpack(0, 0);

    // The worker fetches, parses the index, decompresses, and writes files to
    // storage — download and unpack progress run in parallel.
    const url = 'assets/' + encodeURIComponent(build) + '/build.data?cb=' + Date.now();
    gxUI.status('Загрузка и распаковка ресурсов…');
    const result = await gxStreamExtract(url, storage);
    console.log('[loader] распаковано ' + result.files + ' файлов');

    // IndexedDB mode: materialize files into window.gxFiles for the engine.
    if (storage.kind === 'idb') {
      gxUI.status('Подготовка файлов…');
      await gxMaterializeIdb(storage);
    }

    // Mark this build installed so a page reload skips the download.
    await storage.writeMeta(markerKey, { complete: true, files: result.files, ts: Date.now() });

    gxUI.status('Запуск движка…');
    document.getElementById('gx-progress-wrap').style.display = 'none';
    await gxStartGame();
    gxUI.overlay.style.display = 'none';
  } catch (e) {
    gxUI.error(e && e.message ? e.message : String(e));
  }
}

window.addEventListener('DOMContentLoaded', gxBoot);
