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

async function gxSyncAssets(storage, lang) {
  gxUI.status('Получаю список файлов…');
  const resp = await fetch('assets/manifest.json', { cache: 'no-cache' });
  if (!resp.ok) throw new Error('assets/manifest.json недоступен: HTTP ' + resp.status);
  const manifest = await resp.json();

  const isEnglish = lang !== 'russian';
  // Language-specific BIGs: allowed set for this language.
  // English set:
  //   GameDataGenerals/English.big, GameDataGenerals/AudioEnglish.big,
  //   GameDataGenerals/SpeechEnglish.big, EnglishZH.big,
  //   AudioEnglishZH.big, SpeechEnglishZH.big, W3DEnglishZH.big
  // Russian set:
  //   GameDataGenerals/0!Russian.big, GameDataGenerals/00Russian.big,
  //   GameDataGenerals/Audio.big, GameDataGenerals/Speech.big,
  //   00RussianZH.big, Data/Movies/Russian_VS_small.bik
  const skipPaths = isEnglish
    ? ['00RussianZH.big', 'GameDataGenerals/0!Russian.big',
       'GameDataGenerals/00Russian.big', 'GameDataGenerals/Audio.big',
       'GameDataGenerals/Speech.big', 'Data/Movies/Russian_VS_small.bik']
    : ['AudioEnglishZH.big', 'EnglishZH.big', 'SpeechEnglishZH.big',
       'W3DEnglishZH.big', 'GameDataGenerals/AudioEnglish.big',
       'GameDataGenerals/English.big', 'GameDataGenerals/SpeechEnglish.big'];
  const skipSet = new Set(skipPaths);
  // Build a Set of allowed paths (manifest minus language-specific).
  const allowed = new Set(manifest.files.filter(f => !skipSet.has(f.path)).map(f => f.path));

  // Step 1: delete stale language files from a previous language selection.
  // These are specific known paths — no need to walk the full storage tree.
  const stale = isEnglish
    ? ['00RussianZH.big', 'GameDataGenerals/0!Russian.big',
       'GameDataGenerals/00Russian.big', 'GameDataGenerals/Audio.big',
       'GameDataGenerals/Speech.big', 'Data/Movies/Russian_VS_small.bik']
    : ['AudioEnglishZH.big', 'EnglishZH.big', 'SpeechEnglishZH.big',
       'W3DEnglishZH.big', 'GameDataGenerals/AudioEnglish.big',
       'GameDataGenerals/English.big', 'GameDataGenerals/SpeechEnglish.big'];
  for (const path of stale) {
    try {
      if (await storage.has(path)) {
        await storage.remove(path);
      }
    } catch {}
  }

  // Step 2: download missing/changed files.
  const installed = (await storage.readMeta('installed-manifest')) || { files: {} };
  const installedByPath = installed.files || {};

  const toDownload = [];
  let totalBytes = 0;
  for (const f of manifest.files) {
    if (!allowed.has(f.path)) continue;
    const have = installedByPath[f.path];
    if (have && have.sha256 === f.sha256) {
      const size = await storage.fileSize(f.path);
      if (size === f.size) continue;
    }
    toDownload.push(f);
    totalBytes += f.size;
  }

  if (toDownload.length > 0) {
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
              try { await storage.remove(f.path); } catch {}
              if (attempt >= 3) throw e;
            }
          }
        }
      })());
    }
    await Promise.all(workers);
  } else {
    console.log('[loader] все файлы уже в кеше (' + manifest.files.length + ' шт.)');
  }

  installed.files = installedByPath;
  installed.version = manifest.version;
  await storage.writeMeta('installed-manifest', installed);
  console.log('[loader] загрузка завершена');
  return { manifest, allowed };
}

// IndexedDB mode: the wasm side can't read IDB, so materialize every file as
// an ArrayBuffer on window.gxFiles; WebMain.cpp copies them into a WASMFS
// js-file-backend mount at startup (JS memory, not wasm heap).
async function gxMaterializeForIdb(storage, manifest, allowed) {
  const targets = allowed ? manifest.files.filter(f => allowed.has(f.path)) : manifest.files;
  const total = targets.length;
  gxUI.status('Подготовка файлов (IndexedDB режим)…');
  const files = [];
  let done = 0;
  for (const f of targets) {
    files.push({ path: f.path, data: await storage.readBytes(f.path) });
    done++;
    if (done % 5 === 0 || done === total) {
      gxUI.progress(done, total, 'Подготовка файлов: ' + done + ' / ' + total);
    }
  }
  // Saved games / options written back by earlier sessions (see
  // window.gxIdbPutUserFile below) live under 'userdata/' keys.
  try {
    const extra = (await storage.listPaths()).filter((k) => typeof k === 'string' && k.startsWith('userdata/'));
    for (const k of extra) {
      files.push({ path: k, data: await storage.readBytes(k) });
    }
    if (extra.length) console.log('[loader] восстановлено файлов пользователя из IndexedDB:', extra.length);
  } catch (e) {
    console.warn('[loader] не удалось восстановить userdata из IndexedDB:', e);
  }
  window.gxFiles = files;

  // Write-back sink: WebMain periodically pushes save files here (IDB mode
  // has no OPFS, so persistence goes through IndexedDB).
  window.gxIdbPutUserFile = (path, bytes) => {
    storage.writeBlob('userdata/' + path, new Blob([bytes])).catch((e) =>
      console.warn('[loader] userdata write-back failed:', path, e));
  };
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

    // Show play button and settings BEFORE downloading anything:
    // language and FPS settings are persisted in localStorage and read by
    // game.js; we read them here for the filter and the engine arguments.
    document.getElementById('gx-progress-wrap').style.display = 'none';
    gxUI.progress(1, 1, 'Настройте язык и нажмите Играть');

    const btn = document.getElementById('gx-play');
    btn.style.display = 'inline-block';

    const settingsBtn = document.getElementById('gx-settings-btn');
    const settingsBox = document.getElementById('gx-settings');
    const fpsSel = document.getElementById('gx-fps');
    fpsSel.value = localStorage.getItem('gx-fps') || '30';
    if (![...fpsSel.options].some(o => o.value === fpsSel.value)) fpsSel.value = '30';
    fpsSel.addEventListener('change', () => localStorage.setItem('gx-fps', fpsSel.value));
    const langSel = document.getElementById('gx-lang');
    langSel.value = localStorage.getItem('gx-lang') || 'english';
    if (![...langSel.options].some(o => o.value === langSel.value)) langSel.value = 'english';
    langSel.addEventListener('change', () => localStorage.setItem('gx-lang', langSel.value));
    settingsBtn.style.display = 'inline-block';
    settingsBtn.addEventListener('click', () => { settingsBox.hidden = !settingsBox.hidden; });

    // Wait for Play — language is now locked.
    await new Promise((resolve) => btn.addEventListener('click', resolve, { once: true }));
    btn.style.display = 'none';
    settingsBtn.style.display = 'none';
    settingsBox.hidden = true;

    // NOW sync assets with the chosen language (the user may have changed it
    // after the last play; gxSyncAssets deletes stale language BIGs first).
    document.getElementById('gx-progress-wrap').style.display = 'block';
    gxUI.bar.style.width = '0%';
    gxUI.label.textContent = '0%';
    const lang = localStorage.getItem('gx-lang') || 'english';
    const { manifest, allowed } = await gxSyncAssets(storage, lang);

    if (storage.kind === 'idb') {
      await gxMaterializeForIdb(storage, manifest, allowed);
    }

    document.getElementById('gx-progress-wrap').style.display = 'none';
    gxUI.status('Запуск движка…');
    await gxStartGame();
    gxUI.overlay.style.display = 'none';
  } catch (e) {
    gxUI.error(e && e.message ? e.message : String(e));
  }
}

window.addEventListener('DOMContentLoaded', gxBoot);
