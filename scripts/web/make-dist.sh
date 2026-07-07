#!/usr/bin/env bash
# GeneralsX Web - assemble the deployable static bundle.
#
# Iterates over all builds in web/gamedata/ (e.g. default_ru), packs each
# into dist/assets/{build}/, copies the wasm shell once, and writes build.json.
#
# dist/
#   index.html, loader.js, storage.js, signaling.js, game.js,
#   coi-serviceworker.js   <- COOP/COEP injector for bare static hosts
#   ice.json               <- EDITABLE: STUN/TURN + MQTT brokers
#   GeneralsXZH.js, GeneralsXZH.wasm
#   build.json             <- {buildId: "xxxx"}
#   assets/
#     builds.json           <- ["default_ru", ...]
#     default_ru/
#       manifest.json
#       files/...
#
# Creates:
#   scripts/web/pack-assets.sh {build}   (once per build)
#
# GeneralsX @build web-port 05/07/2026 - Web port Phase 1
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WASM_DIR="${1:-$REPO_ROOT/build/emscripten/GeneralsMD}"
DIST="$REPO_ROOT/web/dist"

if [ ! -f "$WASM_DIR/GeneralsXZH.wasm" ]; then
    echo "ERROR: $WASM_DIR/GeneralsXZH.wasm not found - build first:" >&2
    echo "  cmake --preset emscripten && cmake --build build/emscripten --target z_generals" >&2
    exit 1
fi

mkdir -p "$DIST"

# ── Shell ─────────────────────────────────────────────────────────────────────
echo "==> Shell"
cp "$REPO_ROOT"/web/shell/*.js "$REPO_ROOT"/web/shell/index.html "$DIST/"
cp "$REPO_ROOT"/web/shell/brotli_bg.wasm "$DIST/"   # brotli-wasm decoder blob
if [ ! -f "$DIST/ice.json" ]; then
    cp "$REPO_ROOT/web/shell/ice.json" "$DIST/"
else
    echo "    dist/ice.json exists - keeping your edited version"
fi

# ── Wasm build ────────────────────────────────────────────────────────────────
echo "==> Wasm build"
cp "$WASM_DIR/GeneralsXZH.js" "$WASM_DIR/GeneralsXZH.wasm" "$DIST/"
BUILD_ID=$(shasum -a 256 "$DIST/GeneralsXZH.wasm" | cut -c1-12)
printf '{"buildId": "%s"}\n' "$BUILD_ID" > "$DIST/build.json"
echo "    buildId: $BUILD_ID"

# ── Discover builds (directories under web/gamedata/) ─────────────────────────
BUILDS=()
for d in "$REPO_ROOT/web/gamedata"/*/; do
    [ -d "$d" ] || continue
    name=$(basename "$d")
    [ -n "$name" ] || continue
    BUILDS+=("$name")
done

if [ ${#BUILDS[@]} -eq 0 ]; then
    echo "ERROR: no builds found in $REPO_ROOT/web/gamedata/" >&2
    exit 1
fi

echo "==> Buildings (${#BUILDS[@]}): ${BUILDS[*]}"

# ── Pack each build ──────────────────────────────────────────────────────────
for name in "${BUILDS[@]}"; do
    echo "  -> $name"
    "$REPO_ROOT/scripts/web/pack-assets.sh" "$name"
done

# ── Builds index ──────────────────────────────────────────────────────────────
printf '[\n' > "$DIST/assets/builds.json"
first=true
for name in "${BUILDS[@]}"; do
    $first || printf ',\n' >> "$DIST/assets/builds.json"
    data="$DIST/assets/$name/build.data"
    sz=0; fc=0
    if [ -f "$data" ]; then
        sz=$(stat -f%z "$data" 2>/dev/null || stat -c%s "$data" 2>/dev/null || echo 0)
    fi
    printf '  {"name":"%s","size":%d}' "$name" "$sz" >> "$DIST/assets/builds.json"
    first=false
done
printf '\n]\n' >> "$DIST/assets/builds.json"

echo "==> Done: $DIST"
echo "    Builds: ${BUILDS[*]}"
echo "    Upload the directory to any HTTPS host, or serve locally:"
echo "    cd web && go run ./server -dir ./dist            # http://localhost:8080"
echo "    cd web && go run ./server -dir ./dist -tls-self-signed   # https://<ip>:8080"
