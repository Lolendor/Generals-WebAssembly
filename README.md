# Command & Conquer Generals: Zero Hour — WebAssembly (play in the browser)

**Zero Hour running in the browser** — the real 2003 engine (~500k LOC of C++)
compiled to WebAssembly via [Emscripten](https://emscripten.org). One click to
play: open the site, the loader streams the game files and caches them
**permanently in OPFS** (or IndexedDB where OPFS is unavailable) — the next
visit starts instantly, fully offline-capable. Rendering is a custom
**Direct3D 8 → WebGL2** translation layer (`d3d8webgl`); no Vulkan, no plugins.

**Static-first deployment**: the `web/dist/` bundle runs on *any* web server or
static hosting — COOP/COEP headers (required for threads) are injected
client-side by a service worker, STUN/TURN + signaling brokers live in an
operator-editable `ice.json`, and multiplayer signaling (in progress) rides
public MQTT-over-WebSocket brokers with a short room code — **no backend
required**. An optional single-binary Go server is included for local dev and
self-signed-TLS deployments on a bare IP.

This is a fork of
[ammaarreshi/Generals-Mac-iOS-iPad](https://github.com/ammaarreshi/Generals-Mac-iOS-iPad)
(the macOS/iOS/iPadOS port), itself built on EA's GPL v3 source release via
[fbraz3/GeneralsX](https://github.com/fbraz3/GeneralsX). This fork adds the
browser/WASM target; the Apple-platform ports below still work.

**No game assets are included or distributed.** You need your own copy
([Steam](https://store.steampowered.com/app/2732960/), ~$5 on sale).

## Web port status

| Phase | Scope | Status |
|---|---|---|
| 0 | Emscripten toolchain: the whole engine compiles, links, and boots in the browser | ✅ done |
| 1 | Static bundle + loader UI, OPFS permanent cache (IndexedDB fallback), asset packing, optional Go server | ✅ done (validation on a full asset set pending) |
| 2 | `d3d8webgl` renderer: D3D8 fixed-function → WebGL2 | 🚧 next — until then there is no picture, engine runs headless |
| 3 | Audio (OpenAL→WebAudio), input polish, saves | planned |
| 4 | Video playback (FFmpeg-wasm, already builds) | wired |
| 5 | Multiplayer: WebRTC DataChannels P2P (host relay), serverless MQTT signaling + room codes | signaling layer ready |

Details and architecture: [`docs/WORKDIR/planning/WEB_PORT_PLAN.md`](docs/WORKDIR/planning/WEB_PORT_PLAN.md).

## Quick start — Web

```sh
# toolchain: emscripten 4.x, cmake 3.25+, ninja, go 1.22+
brew install emscripten cmake ninja go        # (or apt equivalents + emsdk)

# 1. build the engine to wasm
EMSCRIPTEN_ROOT=$(brew --prefix emscripten)/libexec cmake --preset emscripten
cmake --build build/emscripten --target z_generals -j10

# 2. assemble the static bundle and pack YOUR game files into it
scripts/web/make-dist.sh
scripts/web/pack-assets.sh /path/to/GeneralsZH     # -> web/dist/assets

# 3. deploy: upload web/dist/ to any HTTPS static host. That's it.
#    Or serve locally / on a bare IP with the optional Go server:
cd web && go run ./server -dir ./dist                   # http://localhost:8080
cd web && go run ./server -dir ./dist -tls-self-signed  # https://<your-ip>:8080
```

Edit `web/dist/ice.json` to point at your own TURN servers or MQTT brokers.
Debug flags: `?args=-headless`, `?storage=idb`.

---

The original Apple-platform port documentation follows.

<img width="500" height="281" alt="IMG_3457_500" src="https://github.com/user-attachments/assets/aeaf6692-36e6-40c8-b9f8-8066d014ec4b" />

**Zero Hour running natively on Apple Silicon Macs, iPhone, and iPad** — campaign,
skirmish, and Generals Challenge, with touch controls built for RTS (tap-select,
drag-box, long-press deselect, two-finger scroll, pinch zoom). No emulation: this
is the real 2003 engine compiled for ARM64, rendering DirectX 8 →
[DXVK](https://github.com/doitsujin/dxvk) → Vulkan →
[MoltenVK](https://github.com/KhronosGroup/MoltenVK) → Metal.

## Quick start — macOS

Prerequisites (one time):

```sh
# Toolchain
xcode-select --install
brew install cmake ninja meson pkgconf
brew install --cask steamcmd

# vcpkg (full clone — a shallow clone breaks manifest baselines)
git clone https://github.com/microsoft/vcpkg ~/vcpkg && ~/vcpkg/bootstrap-vcpkg.sh
export VCPKG_ROOT=~/vcpkg          # add to your shell profile

# LunarG Vulkan SDK (NOT the Homebrew cask) — https://vulkan.lunarg.com/sdk/home
export VULKAN_SDK=$HOME/VulkanSDK/<version>/macOS   # add to your shell profile
```

Clone, build, get assets, play:

```sh
git clone https://github.com/ammaarreshi/Generals-Mac-iOS-iPad.git GeneralsX
cd GeneralsX
./scripts/build/macos/build-macos-zh.sh     # checks deps, configures, builds
./scripts/build/macos/deploy-macos-zh.sh    # creates ~/GeneralsX/GeneralsZH + run.sh
./scripts/get-assets.sh <your_steam_username>   # fetches game data you own
cd ~/GeneralsX/GeneralsZH && ./run.sh -win
```

## Quick start — iPhone / iPad

On top of the macOS prerequisites: full Xcode (signed into your Apple ID),
`brew install xcodegen`, and a (free or paid) Apple Developer team.

```sh
cd GeneralsX
git submodule update --init references/fbraz3-dxvk   # iOS DXVK is built from this + Patches/dxvk-ios.patch
./scripts/build/ios/fetch-moltenvk.sh                # pinned MoltenVK.framework (checksummed)
./scripts/build/ios/stage-fonts.sh                   # Liberation fonts, renamed as the game expects
cmake --preset ios-vulkan
cmake --build build/ios-vulkan --target z_generals
GX_TEAM_ID=<your-team-id> GX_BUNDLE_ID=com.you.generalszh \
    ./scripts/build/ios/package-ios-zh.sh --install  # assembles, signs, installs
```

Find your team id in Xcode → Settings → Accounts. Assets ship inside the app
bundle (self-contained install); `--dev` skips the ~2.7 GB copy for fast code
iteration.

## Where things are

| Path | What it is |
|---|---|
| [`docs/port/PORTING_PLAYBOOK.md`](docs/port/PORTING_PLAYBOOK.md) | The complete engineering log of this port: every failure mode, root cause, fix — start with [§8, the bug archaeology](docs/port/PORTING_PLAYBOOK.md#8-post-ship-bug-hunts-junejuly-2026--the-archaeology-section): the black minimap, the silent EVA lines, and the chirp |
| `docs/port/PORTING_PATTERNS.md` | Generalized methodology for porting classic Windows games to Apple platforms |
| `docs/port/RELEASE_CHECKLIST.md` | Gate for public release |
| `scripts/get-assets.sh` | Steam asset fetcher (your own copy; app 2732960) |
| `scripts/build/macos/`, `scripts/build/ios/` | Build, deploy, packaging pipelines |
| `ios/` | XcodeGen signing-stub project + `ios/config/` (staged Options.ini, dxvk.conf) |
| `Patches/dxvk-ios.patch` | DXVK changes the iOS d3d8/d3d9 dylibs are built from (applied via the local-fork build) |

## Known issues

- Long sessions on iPad can be killed by iOS for memory (~3 GB+ resident); the app
  exits to the home screen with no dialog. Session logs (current + previous) are in
  the Files app under the game's folder. Under investigation.
- Backgrounding mid-game can occasionally crash on iOS — the lifecycle pause covers
  the common paths; a rare race remains. Save often.

## License & credits

Engine code **GPL v3** (EA's source release → GeneralsX → Generals-Mac-iOS-iPad →
this fork). Game assets: not included, not licensed here. Credits: Westwood/EA
Pacific (the game), EA (the source release), fbraz3/GeneralsX (the base port),
ammaarreshi/Generals-Mac-iOS-iPad (the Apple-platform port this fork builds on),
TheSuperHackers/GeneralsGameCode (community mainline), DXVK (D3D8 compat
headers), MoltenVK, SDL, OpenAL Soft, FFmpeg, Emscripten, Liberation Fonts,
[LostMyCode/d3d9-webgl](https://github.com/LostMyCode/d3d9-webgl) (the prior art
for D3D-fixed-function-to-WebGL translation).

The Apple ports were built as a human+AI collaboration: engineering by
[Claude Code](https://claude.com/claude-code) (Anthropic's Claude, Fable model),
directed and playtested on real devices by Ammaar Reshi. The engineering log in
`docs/port/` is the unedited record of how that worked. The WebAssembly port
continues the same approach, directed by Lolendor.
