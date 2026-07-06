// GeneralsX Web - asset loader.
//
// Builds: each build (e.g. default_ru) lives in its own directory under
// /assets/{build}/ on the server, containing manifest.json + files/ subdir.
// The user selects a build before pressing Play; assets for that build are
// then downloaded and stored. Switching builds clears old cached files.
//
// Coop/coep on bare static hosts is handled by coi-serviceworker.js.
//
// GeneralsX @build web-port 05/07/2026 - Web port Phase 1

'use strict';

const gxUI = {
  overlay: null, bar: null, label: null, detail: null,
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
  status(text) { this.detail.textContent = text; },
};

function gxHuman(bytes) {
  if (bytes > 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' ГБ';
  if (bytes > 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' МБ';
  if (bytes > 1024) return (bytes / 1024).toFixed(0) + ' КБ';
  return bytes + ' Б';
}

async function gxCheckEnvironment() {
  if (!crossOriginIsolated) {
    if (window.gxCoiPending) {
      gxUI.status('Настройка окружения (страница перезагрузится)…');
      await new Promise((r) => setTimeout(r, 4000));
    }
    if (!crossOriginIsolated) throw new Error(
      'SharedArrayBuffer недоступен (нет crossOriginIsolated).\n' +
      'Откройте сайт по HTTPS или localhost.');
  }
  if (typeof WebAssembly === 'undefined')
    throw new Error('Браузер не поддерживает WebAssembly.');
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
    console.log('[loader] сетевой конфиг из ice.json применён');
  } catch (e) {
    console.warn('[loader] ice.json не прочитан, использую значения по умолчанию:', e);
  }
}

// Manifest + file URL for a given build name.
const gxAssetUrl = (build) => (f) =>
  'assets/' + encodeURIComponent(build) + '/files/' +
  f.path.split('/').map(encodeURIComponent).join('/') +
  '?v=' + f.sha256.slice(0, 12);

async function gxSyncAssets(storage, build) {
  const assetUrl = gxAssetUrl(build);
  console.log('[loader] синхронизация сборки: ' + build);

  gxUI.status('Получаю список файлов…');
  const resp = await fetch('assets/' + encodeURIComponent(build) + '/manifest.json', { cache: 'no-cache' });
  if (!resp.ok) throw new Error('манифест сборки ' + build + ' недоступен: HTTP ' + resp.status);
  const manifest = await resp.json();

  const installed = (await storage.readMeta('installed-manifest-' + build)) || { files: {} };
  const installedByPath = installed.files || {};

  const toDownload = [];
  let totalBytes = 0;
  for (const f of manifest.files) {
    const have = installedByPath[f.path];
    if (have && have.sha256 === f.sha256) {
      const size = await storage.fileSize(f.path);
      if (size === f.size) continue;
    }
    toDownload.push(f);
    totalBytes += f.size;
  }

  if (toDownload.length === 0) {
    console.log('[loader] все файлы сборки ' + build + ' уже в кеше (' + manifest.files.length + ' шт.)');
    return manifest;
  }

  const est = await storage.estimate();
  if (est && est.quota && est.quota - (est.usage || 0) < totalBytes)
    throw new Error('Недостаточно места: нужно ' + gxHuman(totalBytes) +
      ', доступно ' + gxHuman(est.quota - (est.usage || 0)) + '.');
  await storage.requestPersist();

  console.log('[loader] к загрузке: ' + toDownload.length + ' файлов, ' + gxHuman(totalBytes));
  let done = 0;
  gxUI.progress(0, totalBytes, 'Загрузка файлов игры: ' + gxHuman(totalBytes));

  const queue = toDownload.slice();
  const concurrency = Math.min(4, queue.length);
  const workers = [];
  for (let i = 0; i < concurrency; i++) {
    workers.push((async () => {
      for (;;) {
        const f = queue.shift();
        if (!f) return;
        for (let attempt = 1; ; attempt++) {
          try {
            const r = await fetch(assetUrl(f));
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

  installed.files = installedByPath;
  installed.version = manifest.version;
  await storage.writeMeta('installed-manifest-' + build, installed);
  console.log('[loader] загрузка сборки ' + build + ' завершена');
  return manifest;
}

// IndexedDB mode: materialize every file as ArrayBuffer on window.gxFiles.
async function gxMaterializeForIdb(storage, manifest) {
  gxUI.status('Подготовка файлов (IndexedDB режим)…');
  const files = [];
  let done = 0;
  const total = manifest.files.length;
  for (const f of manifest.files) {
    files.push({ path: f.path, data: await storage.readBytes(f.path) });
    done++;
    if (done % 5 === 0 || done === total)
      gxUI.progress(done, total, 'Подготовка файлов: ' + done + ' / ' + total);
  }
  try {
    const extra = (await storage.listPaths()).filter((k) => typeof k === 'string' && k.startsWith('userdata/'));
    for (const k of extra)
      files.push({ path: k, data: await storage.readBytes(k) });
    if (extra.length) console.log('[loader] восстановлено файлов пользователя из IndexedDB:', extra.length);
  } catch (e) {
    console.warn('[loader] не удалось восстановить userdata из IndexedDB:', e);
  }
  window.gxFiles = files;
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

    // Show Play + settings BEFORE downloading anything.
    document.getElementById('gx-progress-wrap').style.display = 'none';
    gxUI.progress(1, 1, 'Выберите сборку и нажмите Играть');

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

    // Wait for Play — build is now locked.
    await new Promise((resolve) => btn.addEventListener('click', resolve, { once: true }));
    btn.style.display = 'none';
    settingsBtn.style.display = 'none';
    settingsBox.hidden = true;

    // Sync assets for the selected build.
    document.getElementById('gx-progress-wrap').style.display = 'block';
    gxUI.bar.style.width = '0%';
    gxUI.label.textContent = '0%';
    const build = localStorage.getItem('gx-build') || 'default_ru';

    // Detect build switch: if the previous build differs, wipe all game files
    // so stale BIGs from the old build don't leak into the new one.
    const prevBuild = localStorage.getItem('gx-prev-build');
    if (prevBuild && prevBuild !== build) {
      console.log('[loader] смена сборки: ' + prevBuild + ' -> ' + build + ', очистка…');
      const allPaths = (await storage.listPaths()).filter(
        (k) => typeof k === 'string' && !k.startsWith('userdata/') && k !== 'installed-manifest' &&
               !k.startsWith('installed-manifest-'));
      let cleared = 0;
      for (const p of allPaths) {
        try { await storage.remove(p); cleared++; } catch {}
      }
      if (cleared) console.log('[loader] удалено старых файлов: ' + cleared);
    }
    localStorage.setItem('gx-prev-build', build);

    const manifest = await gxSyncAssets(storage, build);

    if (storage.kind === 'idb')
      await gxMaterializeForIdb(storage, manifest);

    document.getElementById('gx-progress-wrap').style.display = 'none';
    gxUI.status('Запуск движка…');
    await gxStartGame();
    gxUI.overlay.style.display = 'none';
  } catch (e) {
    gxUI.error(e && e.message ? e.message : String(e));
  }
}

window.addEventListener('DOMContentLoaded', gxBoot);
