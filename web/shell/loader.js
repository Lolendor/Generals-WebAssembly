// GeneralsX Web - asset loader.
//
// STATIC-FIRST: every request is a relative path, so the dist/ bundle works
// from any directory of any web server (the optional Go server is just a
// convenience for dev / self-signed TLS). COOP/COEP on bare static hosts is
// handled by coi-serviceworker.js.
//
// Flow (runs before the wasm module starts):
//   1. detect storage driver (OPFS preferred, IndexedDB fallback)
//   2. fetch assets/manifest.json (+ optional ice.json network config)
//   3. diff against the installed manifest (per-file sha256)
//   4. download missing/changed files with progress, store them
//   5. record the installed manifest
//   6. hand off to game.js (which boots the Emscripten module)
//
// GeneralsX @build web-port 05/07/2026 - Web port Phase 1

'use strict';

const gxUI = {
  overlay: null,
  bar: null,
  label: null,
  detail: null,
  error(msg) {
    console.error('[loader]', msg);
    const el = document.getElementById('gx-error');
    el.style.display = 'block';
    el.textContent = msg;
    document.getElementById('gx-progress-wrap').style.display = 'none';
  },
  progress(done, total, detail) {
    const pct = total > 0 ? Math.floor((done / total) * 100) : 0;
    this.bar.style.width = pct + '%';
    this.label.textContent = pct + '%';
    if (detail) this.detail.textContent = detail;
  },
  status(text) {
    this.detail.textContent = text;
  },
};

function gxHuman(bytes) {
  if (bytes > 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' ГБ';
  if (bytes > 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' МБ';
  if (bytes > 1024) return (bytes / 1024).toFixed(0) + ' КБ';
  return bytes + ' Б';
}

async function gxCheckEnvironment() {
  if (!crossOriginIsolated) {
    // coi-serviceworker.js may be mid-registration: on hosts without
    // COOP/COEP headers it reloads the page once to inject them.
    if (window.gxCoiPending) {
      gxUI.status('Настройка окружения (страница перезагрузится)…');
      await new Promise((r) => setTimeout(r, 4000));
    }
    if (!crossOriginIsolated) {
      throw new Error(
        'SharedArrayBuffer недоступен (нет crossOriginIsolated) — игра не сможет запуститься.\n' +
        'Причина: страница открыта не по HTTPS/localhost (нужен secure context), либо хостинг не отдаёт ' +
        'заголовки COOP/COEP и service worker не смог их добавить.\n' +
        'Решение: откройте сайт по HTTPS. Для доступа по голому IP — опциональный сервер: ' +
        '"gx-web -dir dist -tls-self-signed" и адрес https://<ip>:8080 (принять предупреждение один раз).'
      );
    }
  }
  if (typeof WebAssembly === 'undefined') {
    throw new Error('Браузер не поддерживает WebAssembly.');
  }
}

// Optional editable network config (STUN/TURN + MQTT brokers) from ice.json
// next to index.html; signaling.js defaults apply when absent/broken.
async function gxLoadNetConfig() {
  try {
    const r = await fetch('ice.json', { cache: 'no-cache' });
    if (!r.ok) return;
    const cfg = await r.json();
    if (cfg && Array.isArray(cfg.iceServers) && cfg.iceServers.length) {
      window.gxNetConfig.iceServers = cfg.iceServers;
    }
    if (cfg && Array.isArray(cfg.mqttBrokers) && cfg.mqttBrokers.length) {
      window.gxNetConfig.mqttBrokers = cfg.mqttBrokers;
    }
    console.log('[loader] сетевой конфиг из ice.json применён');
  } catch (e) {
    console.warn('[loader] ice.json не прочитан, использую значения по умолчанию:', e);
  }
}

// Relative asset URL; the sha fragment busts HTTP caches when a file changes
// between deploys (the path itself stays stable for static hosting).
function gxAssetUrl(f) {
  const encoded = f.path.split('/').map(encodeURIComponent).join('/');
  return 'assets/files/' + encoded + '?v=' + f.sha256.slice(0, 12);
}

async function gxSyncAssets(storage) {
  gxUI.status('Получаю список файлов…');
  const resp = await fetch('assets/manifest.json', { cache: 'no-cache' });
  if (!resp.ok) throw new Error('assets/manifest.json недоступен: HTTP ' + resp.status);
  const manifest = await resp.json();

  const installed = (await storage.readMeta('installed-manifest')) || { files: {} };
  const installedByPath = installed.files || {};

  // Diff: download when the hash differs or the stored size mismatches.
  const toDownload = [];
  let totalBytes = 0;
  for (const f of manifest.files) {
    const have = installedByPath[f.path];
    if (have && have.sha256 === f.sha256) {
      const size = await storage.fileSize(f.path);
      if (size === f.size) continue; // present and intact by size
    }
    toDownload.push(f);
    totalBytes += f.size;
  }

  if (toDownload.length === 0) {
    console.log('[loader] все файлы уже в кеше (' + manifest.files.length + ' шт.)');
    return manifest;
  }

  // Quota check before a big first download.
  const est = await storage.estimate();
  if (est && est.quota && est.quota - (est.usage || 0) < totalBytes) {
    throw new Error(
      'Недостаточно места в хранилище браузера: нужно ' + gxHuman(totalBytes) +
      ', доступно ' + gxHuman(est.quota - (est.usage || 0)) + '.'
    );
  }
  await storage.requestPersist();

  console.log('[loader] к загрузке: ' + toDownload.length + ' файлов, ' + gxHuman(totalBytes));
  let done = 0;
  gxUI.progress(0, totalBytes, 'Загрузка файлов игры: ' + gxHuman(totalBytes));

  // Up to 4 parallel downloads.
  const queue = toDownload.slice();
  const workers = [];
  const concurrency = Math.min(4, queue.length);
  for (let i = 0; i < concurrency; i++) {
    workers.push((async () => {
      for (;;) {
        const f = queue.shift();
        if (!f) return;
        const url = gxAssetUrl(f);
        for (let attempt = 1; ; attempt++) {
          try {
            const r = await fetch(url);
            if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + f.path);
            const written = await storage.writeStream(f.path, r, (n) => {
              done += n;
              gxUI.progress(done, totalBytes,
                'Загрузка: ' + gxHuman(done) + ' / ' + gxHuman(totalBytes));
            });
            if (written !== f.size) throw new Error('размер не совпал: ' + f.path);
            installedByPath[f.path] = { sha256: f.sha256, size: f.size };
            break;
          } catch (e) {
            console.warn('[loader] попытка ' + attempt + ' не удалась для ' + f.path + ':', e);
            await storage.remove(f.path);
            if (attempt >= 3) throw e;
          }
        }
      }
    })());
  }
  await Promise.all(workers);

  installed.files = installedByPath;
  installed.version = manifest.version;
  await storage.writeMeta('installed-manifest', installed);
  console.log('[loader] загрузка завершена');
  return manifest;
}

// IndexedDB mode: the wasm side can't read IDB, so materialize every file as
// an ArrayBuffer on window.gxFiles; WebMain.cpp copies them into a WASMFS
// js-file-backend mount at startup (JS memory, not wasm heap).
async function gxMaterializeForIdb(storage, manifest) {
  gxUI.status('Подготовка файлов (IndexedDB режим)…');
  const files = [];
  let done = 0;
  const total = manifest.files.length;
  for (const f of manifest.files) {
    files.push({ path: f.path, data: await storage.readBytes(f.path) });
    done++;
    if (done % 5 === 0 || done === total) {
      gxUI.progress(done, total, 'Подготовка файлов: ' + done + ' / ' + total);
    }
  }
  window.gxFiles = files;
}

async function gxBoot() {
  gxUI.overlay = document.getElementById('gx-overlay');
  gxUI.bar = document.getElementById('gx-bar');
  gxUI.label = document.getElementById('gx-pct');
  gxUI.detail = document.getElementById('gx-detail');

  try {
    await gxCheckEnvironment();
    await gxLoadNetConfig();

    const storage = await gxDetectStorage();
    console.log('[loader] хранилище:', storage.kind);
    window.gxStorageKind = storage.kind;
    document.getElementById('gx-storage-kind').textContent =
      storage.kind === 'opfs' ? 'OPFS' : 'IndexedDB (fallback)';

    const manifest = await gxSyncAssets(storage);

    if (storage.kind === 'idb') {
      await gxMaterializeForIdb(storage, manifest);
    }

    // Wait for the user gesture: unlocks WebAudio and feels intentional.
    gxUI.progress(1, 1, 'Готово к запуску');
    const btn = document.getElementById('gx-play');
    btn.style.display = 'inline-block';
    document.getElementById('gx-progress-wrap').style.display = 'none';
    await new Promise((resolve) => btn.addEventListener('click', resolve, { once: true }));
    btn.style.display = 'none';

    gxUI.status('Запуск движка…');
    await gxStartGame(); // game.js
    gxUI.overlay.style.display = 'none';
  } catch (e) {
    gxUI.error(e && e.message ? e.message : String(e));
  }
}

window.addEventListener('DOMContentLoaded', gxBoot);
