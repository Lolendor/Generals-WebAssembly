#!/usr/bin/env bash
# GeneralsX Web - pack a named build for the web server.
#
# Reads:
#   web/gamedata/{BUILD_NAME}/GeneralsZH/  (Zero Hour .big archives + data)
#   web/gamedata/{BUILD_NAME}/Generals/    (base Generals .big archives, optional)
#
# Writes:
#   web/dist/assets/{BUILD_NAME}/files/...     assets
#   web/dist/assets/{BUILD_NAME}/manifest.json {version,totalBytes,files:[...]}
#
# Usage:
#   scripts/web/pack-assets.sh BUILD_NAME
#
# Builds are directories under web/gamedata/ containing Generals/ and/or
# GeneralsZH/ subdirs. Example: web/gamedata/default_ru/{Generals,GeneralsZH}
#
# GeneralsX @build web-port 05/07/2026 - Web port Phase 1
set -euo pipefail

BUILD="${1:?usage: pack-assets.sh BUILD_NAME}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DATADIR="$REPO_ROOT/web/gamedata/$BUILD"
OUT="$REPO_ROOT/web/dist/assets/$BUILD"

if [ ! -d "$DATADIR" ]; then
    echo "ERROR: build directory not found: $DATADIR" >&2
    exit 1
fi

mkdir -p "$OUT/files"

# ── Zero Hour assets ─────────────────────────────────────────────────────────
ZH="$DATADIR/GeneralsZH"
if [ -d "$ZH" ]; then
    echo "==> Packing Zero Hour files from $ZH"
    rsync -a --delete \
        --include='*/' \
        --include='*.big' \
        --include='Data/**' \
        --include='Maps/**' \
        --exclude='*' \
        "$ZH/" "$OUT/files/"
fi

# ── Base Generals assets ─────────────────────────────────────────────────────
BASE="$DATADIR/Generals"
if [ -d "$BASE" ]; then
    echo "==> Packing base Generals files from $BASE"
    rsync -a --delete \
        --include='*/' \
        --include='*.big' \
        --include='Data/**' \
        --include='Maps/**' \
        --exclude='*' \
        "$BASE/" "$OUT/files/GameDataGenerals/"
fi

# ── Fonts ─────────────────────────────────────────────────────────────────────
echo "==> Staging fonts"
FONTS_DIR="$OUT/files/fonts"
mkdir -p "$FONTS_DIR"
if [ -d "$ZH/fonts" ]; then
    rsync -a "$ZH/fonts/" "$FONTS_DIR/"
elif [ -d "$BASE/fonts" ]; then
    rsync -a "$BASE/fonts/" "$FONTS_DIR/"
elif [ -x "$REPO_ROOT/scripts/build/ios/stage-fonts.sh" ]; then
    GX_FONTS="$FONTS_DIR" "$REPO_ROOT/scripts/build/ios/stage-fonts.sh" || true
fi

# ── Manifest ──────────────────────────────────────────────────────────────────
echo "==> Generating manifest.json"
cd "$REPO_ROOT/web"
go run ./cmd/gen-manifest -dir "$OUT/files" -out "$OUT/manifest.json"

echo "==> Done: $BUILD packed to $OUT"
