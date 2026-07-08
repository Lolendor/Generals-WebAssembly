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

// ── Stream extraction (worker-driven, resumable) ─────────────────────────
// The dispatcher worker fetches build.data, slices it at segment boundaries,
// decompresses segments on a parallel brotli sub-worker pool, and writes files
// to OPFS in order. The main thread relays progress, persists a resume journal
// per completed segment, and runs a watchdog: if the worker goes silent for
// 60 s (deadlock, dropped promise, killed SW...) it is terminated and
// restarted from the journaled segment — a hang becomes an automatic resume.
// Returns { files, entries }.

async function gxStreamExtract(url, storage, journalKey) {
  const ver = (window.gxEngine && window.gxEngine.buildId) || 'dev';
  const wasmUrl = new URL('brotli_bg.wasm?v=' + ver, document.baseURI).href;
  const WATCHDOG_MS = 60000;
  const MAX_RESTARTS = 4;

  let restarts = 0;
  for (;;) {
    // Resume state from the journal (OPFS mode only; the worker re-validates
    // the etag/total before honoring it).
    let resume = null;
    if (storage.kind === 'opfs' && journalKey) {
      const j = await storage.readMeta(journalKey);
      if (j && Number.isInteger(j.seg) && j.etag)
        resume = { startSeg: j.seg + 1, etag: j.etag, total: j.total };
    }

    try {
      return await gxRunUnpackWorker(url, wasmUrl, storage, journalKey, resume, ver, WATCHDOG_MS);
    } catch (e) {
      if (e && e.gxWatchdog && restarts < MAX_RESTARTS) {
        restarts++;
        console.warn('[loader] воркер молчал ' + (WATCHDOG_MS / 1000) + 'с — перезапуск ' +
          restarts + '/' + MAX_RESTARTS + ' с докачкой');
        gxUI.status('Загрузка зависла — перезапуск с докачкой (' + restarts + ')…');
        continue;
      }
      throw e;
    }
  }
}

function gxRunUnpackWorker(url, wasmUrl, storage, journalKey, resume, ver, watchdogMs) {
  // The workers are tiny — always fetch fresh so a redeploy is never served a
  // stale cached Worker script. brotli_bg.wasm (~1 MB) is versioned by buildId.
  const bust = ver + '.' + (Date.now() >>> 0);
  const worker = new Worker('unpack-worker.js?v=' + bust);

  return new Promise((resolve, reject) => {
    let watchdog = null;
    const arm = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        try { worker.terminate(); } catch {}
        const err = new Error('unpack worker silent for ' + watchdogMs + 'ms');
        err.gxWatchdog = true;
        reject(err);
      }, watchdogMs);
    };
    const done = (fn) => (v) => { if (watchdog) clearTimeout(watchdog); try { worker.terminate(); } catch {} fn(v); };
    const ok = done(resolve), fail = done(reject);
    arm();

    worker.addEventListener('message', (ev) => {
      const m = ev.data;
      arm();                                          // any message = alive
      if (m.type === 'download') {
        gxUI.download(m.received, m.total);
      } else if (m.type === 'index') {
        gxUI.unpack(0, m.entries.length);
      } else if (m.type === 'progress') {
        gxUI.unpack(m.done, m.total);
        if (m.verifying) gxUI.status('Проверка файлов…');
      } else if (m.type === 'journal') {
        // Persist resume state; fire-and-forget (journal loss only costs re-work).
        if (storage.kind === 'opfs' && journalKey)
          storage.writeMeta(journalKey, { seg: m.seg, etag: m.etag, total: m.total }).catch(() => {});
      } else if (m.type === 'reconnect') {
        gxUI.status('Соединение прервано — переподключение (попытка ' + m.attempt + ')…');
      } else if (m.type === 'complete') {
        ok({ files: m.files, entries: m.entries });
      } else if (m.type === 'error') {
        fail(new Error(m.message));
      }
    });
    worker.addEventListener('error', (e) => {
      const where = e.filename ? (' @ ' + e.filename + ':' + e.lineno) : '';
      console.error('[loader] worker error event:', e);
      fail(new Error('Worker: ' + (e.message || 'не удалось загрузить unpack-worker.js') + where));
    });
    worker.addEventListener('messageerror', (e) => {
      console.error('[loader] worker messageerror:', e);
      fail(new Error('Worker: ошибка сериализации сообщения'));
    });
    worker.postMessage({ type: 'start', url, wasmUrl, mode: storage.kind, resume, ver: bust });
  });
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

    // The dispatcher worker fetches, slices segments, decompresses them on a
    // parallel pool, and writes files — download and unpack run concurrently.
    // NOTE: a STABLE url (no cache-buster) so Range resume across page reloads
    // targets the same resource; freshness is validated by the server ETag in
    // the resume journal.
    const url = 'assets/' + encodeURIComponent(build) + '/build.data';
    const journalKey = 'unpack-journal-' + build;
    gxUI.status('Загрузка и распаковка ресурсов…');
    const result = await gxStreamExtract(url, storage, journalKey);
    console.log('[loader] распаковано ' + result.files + ' файлов');

    // IndexedDB mode: materialize files into window.gxFiles for the engine.
    if (storage.kind === 'idb') {
      gxUI.status('Подготовка файлов…');
      await gxMaterializeIdb(storage);
    }

    // Mark installed; drop the resume journal (it's for interrupted installs).
    await storage.writeMeta(markerKey, { complete: true, files: result.files, ts: Date.now() });
    if (storage.kind === 'opfs') await storage.writeMeta(journalKey, {}).catch(() => {});

    gxUI.status('Запуск движка…');
    document.getElementById('gx-progress-wrap').style.display = 'none';
    await gxStartGame();
    gxUI.overlay.style.display = 'none';
  } catch (e) {
    gxUI.error(e && e.message ? e.message : String(e));
  }
}

window.addEventListener('DOMContentLoaded', gxBoot);
