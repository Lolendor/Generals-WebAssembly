# Web Port (Emscripten/WASM) — Plan & Status

**Started**: 2026-07-05
**Target**: Zero Hour (`z_generals`) in the browser — one-click play, assets
streamed from the Go backend and cached permanently in OPFS, WebGL2 rendering,
WebRTC multiplayer.

Full design rationale: the session plan at `.claude/plans/sharded-sniffing-platypus.md`
(mirrored below in condensed form).

## Architecture

**STATIC-FIRST**: деплой = залить `web/dist/` на любой веб-сервер/статик-хостинг.
Бекенда нет; опциональный Go-сервер (`web/server`) — только удобство для дева
и самоподписанного TLS при доступе по голому IP.

```
web/dist/  (самодостаточный бандл)      Game pthread (PROXY_TO_PTHREAD)
├── index.html + loader.js/storage.js   ├── main() → GameMain() → GameEngine::execute()
├── coi-serviceworker.js  <- инжектит   ├── SDL3 (emscripten backend: input, canvas)
│   COOP/COEP на голых статик-хостах    ├── d3d8webgl: IDirect3DDevice8 → WebGL2
├── ice.json  <- РЕДАКТИРУЕМЫЙ конфиг   ├── WASMFS: OPFS backend (или js-file) в /opfs
│   (STUN/TURN + MQTT-брокеры)          └── WebUDP (Phase 5: датаграммы → WebRTC)
├── signaling.js  <- MQTT по публичным
│   wss-брокерам + ключ комнаты XXXX-XXXX (перенесено из Lolendor/localhost)
├── GeneralsXZH.{js,wasm}
└── assets/manifest.json + assets/files/...
```

Key mechanics:
- **No Vulkan in browsers** → DXVK/MoltenVK replaced by the in-tree
  `Core/Libraries/Source/d3d8webgl/` static lib implementing the D3D8 subset
  the engine uses. `DX8Wrapper::Init()` binds `::Direct3DCreate8` directly
  under `__EMSCRIPTEN__` (no dlopen).
- **Blocking main loop stays**: `-sPROXY_TO_PTHREAD` runs `main()` on a worker
  where blocking + synchronous OPFS access handles are legal.
- **File system untouched**: `CNC_GENERALS_ZH_PATH=/opfs/GameData` and
  `XDG_DATA_HOME=/opfs/userdata` (set in WebMain.cpp) steer
  StdBIGFileSystem/GlobalData; all fopen/fread hit WASMFS.
- **Storage fallback**: when OPFS is unavailable, assets cache in IndexedDB
  and are copied into a WASMFS js-file backend at boot (payloads live in JS
  memory, not the wasm heap). NOTE: without a secure context there is no
  SharedArrayBuffer either — for IP-only servers run with `-tls-self-signed`.
- **Caps report no pixel shaders** → the engine takes its shipped 2-stage
  fixed-function fallbacks (terrainShader2Stage etc.), which is exactly what
  the Phase 2 WebGL2 pipeline implements.

## Build & deploy

```sh
# wasm build (emcc 4.x, e.g. brew install emscripten)
EMSCRIPTEN_ROOT=$(brew --prefix emscripten)/libexec cmake --preset emscripten
cmake --build build/emscripten --target z_generals -j10

# assemble the static bundle + pack game assets (needs a Zero Hour install)
scripts/web/make-dist.sh
scripts/web/pack-assets.sh ~/GeneralsX/GeneralsZH     # -> web/dist/assets

# deploy: upload web/dist/ to ANY https static host. Done.
# ice.json in dist is operator-editable (own TURN servers, own MQTT brokers).

# local dev / IP-only server (optional Go binary):
cd web && go run ./server -dir ./dist                  # http://localhost:8080
cd web && go run ./server -dir ./dist -tls-self-signed # https://<ip>:8080
# debug flags: ?args=-headless  ?storage=idb  env D3D8WEBGL_TRACE
```

Secure-context matrix: HTTPS-хостинг без COOP/COEP → coi-serviceworker чинит
(1 авто-перезагрузка при первом заходе); голый http://<ip> → не работает ничего
(браузерное ограничение), выход — `-tls-self-signed`.

## Phases

| Phase | Scope | Status |
|---|---|---|
| 0 | Emscripten toolchain: preset `emscripten`, cmake/emscripten.cmake, d3d8webgl null device, WebMain.cpp; engine compiles+links, boots in browser | **DONE 2026-07-05** |
| 1 | Go server (web/), loader UI, OPFS download+permanent cache, IndexedDB fallback, self-signed TLS; headless boot from storage | **infra DONE 2026-07-05** — verified end-to-end on synthetic assets (both storage modes: engine reaches INI loading); full acceptance (boot to `execute()`) needs a real asset pack |
| 2 | d3d8webgl renderer: fixed-function → WebGL2 (program cache, XYZRHW UI path, DXT textures, FBO render targets) | todo (the big one) |
| 3 | Audio (Emscripten OpenAL), input polish, web DefaultOptions.ini, FramePacer sleep, saves in /opfs/userdata | todo |
| 4 | Video: FFmpeg-wasm already builds (cmake/ffmpeg-emscripten.cmake, bink+wav+mp3 decoders); verify playback | wired, untested |
| 5 | Multiplayer: WebUDP (virtual IPs) over WebRTC DataChannels, star topology via host. Signaling SERVERLESS: MQTT over public wss-brokers + room key XXXX-XXXX (shell/signaling.js, ported from Lolendor/localhost); ICE from editable ice.json | signaling layer ready |

## Phase 0/1 implementation notes (for whoever continues)

- Emscripten flags live in `cmake/emscripten.cmake` (global; included right
  after compilers.cmake so FetchContent deps inherit `-pthread`).
- Порт-специфичные правки исходников помечены `GeneralsX @build web-port` /
  `@bugfix web-port`; ищутся grep'ом. Ключевые:
  - `GameMemoryInit.cpp`: fopen для MemoryPools.ini выключен на вебе — он
    вызывался из статической инициализации WasmFS через operator new и
    реентерабельно ронял WasmFS (bad_weak_ptr abort).
  - `bittype.h`, `endian_compat.h`, `memory_compat.h`, `osdep.h` (strupr),
    `config-build.cmake` (нет wcslcpy в musl): ветки `__EMSCRIPTEN__`.
  - GameSpy собирается с target-scoped `__linux__`/`_LINUX` (cmake/gamespy.cmake);
    рантайм-онлайн на вебе не используется.
  - fontconfig не существует на вебе: render2dsentence идёт iOS-путём
    (fonts/ рядом с GameData; pack-assets.sh стейджит Liberation-шрифты).
- FFmpeg под wasm: `cmake/ffmpeg-emscripten.cmake` (ExternalProject, emconfigure,
  только bink/wav/mp3, `--extra-cflags=-pthread` — обязательно для shared-memory ABI).
- 77 MB wasm в RelWithDebInfo — это DWARF; релизный профиль будет заметно меньше
  (добавить -O3/strip вариант при подготовке продакшена).
