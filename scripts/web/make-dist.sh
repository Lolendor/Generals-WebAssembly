#!/usr/bin/env bash
# GeneralsX Web - assemble the deployable static bundle.
#
# Produces web/dist/ - a self-contained directory you can upload to ANY web
# server or static hosting (nginx, GitHub Pages, shared hosting...):
#
#   dist/
#     index.html, loader.js, storage.js, signaling.js, game.js,
#     coi-serviceworker.js       <- injects COOP/COEP on bare static hosts
#     ice.json                   <- EDITABLE: STUN/TURN + MQTT signaling brokers
#     GeneralsXZH.js, GeneralsXZH.wasm
#     assets/manifest.json, assets/files/...   <- from pack-assets.sh
#
# Usage:
#   scripts/web/make-dist.sh [wasm-build-dir]   (default build/emscripten/GeneralsMD)
#
# Run scripts/web/pack-assets.sh first (or after - assets land in dist/assets).
#
# GeneralsX @build web-port 05/07/2026 - Web port Phase 1
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WASM_DIR="${1:-$REPO_ROOT/build/emscripten/GeneralsMD}"
DIST="$REPO_ROOT/web/dist"

if [ ! -f "$WASM_DIR/GeneralsXZH.wasm" ]; then
    echo "ERROR: $WASM_DIR/GeneralsXZH.wasm not found - build first:" >&2
    echo "  EMSCRIPTEN_ROOT=\$(brew --prefix emscripten)/libexec cmake --preset emscripten" >&2
    echo "  cmake --build build/emscripten --target z_generals" >&2
    exit 1
fi

mkdir -p "$DIST"

echo "==> Shell"
cp "$REPO_ROOT"/web/shell/*.js "$REPO_ROOT"/web/shell/index.html "$DIST/"
# ice.json is operator-editable: never clobber an existing customized copy.
if [ ! -f "$DIST/ice.json" ]; then
    cp "$REPO_ROOT/web/shell/ice.json" "$DIST/"
else
    echo "    dist/ice.json exists - keeping your edited version"
fi

echo "==> Wasm build"
cp "$WASM_DIR/GeneralsXZH.js" "$WASM_DIR/GeneralsXZH.wasm" "$DIST/"

if [ -f "$DIST/assets/manifest.json" ]; then
    echo "==> Assets already packed ($(du -sh "$DIST/assets" | cut -f1))"
else
    echo "==> NOTE: no assets yet - run: scripts/web/pack-assets.sh /path/to/GeneralsZH"
fi

echo "==> Done: $DIST"
echo "    Upload the directory to any HTTPS host, or serve locally:"
echo "    cd web && go run ./server -dir ./dist            # http://localhost:8080"
echo "    cd web && go run ./server -dir ./dist -tls-self-signed   # https://<ip>:8080"
