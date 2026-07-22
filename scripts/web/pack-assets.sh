#!/usr/bin/env bash
# GeneralsX Web - pack a named build into a single .data archive.
#
# Reads:
#   web/gamedata/{BUILD_NAME}/GeneralsZH/
#   web/gamedata/{BUILD_NAME}/Generals/      (optional base game)
#
# Produces:
#   dist/assets/{BUILD_NAME}/build.data
#
# Usage:
#   scripts/web/pack-assets.sh BUILD_NAME
#
# GeneralsX @build web-port 06/07/2026
set -euo pipefail

BUILD="${1:?usage: pack-assets.sh BUILD_NAME}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DATADIR="$REPO_ROOT/web/gamedata/$BUILD"
OUTDIR="$REPO_ROOT/web/dist/assets/$BUILD"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

if [ ! -d "$DATADIR" ]; then
    echo "ERROR: build directory not found: $DATADIR" >&2
    exit 1
fi

mkdir -p "$OUTDIR"
mkdir -p "$WORK/files"

# Copy ZH data
ZH="$DATADIR/GeneralsZH"
if [ -d "$ZH" ]; then
    echo "==> Zero Hour: $ZH"
    rsync -a \
        --include='*/' \
        --include='*.big' \
        --include='Data/**' \
        --include='Maps/**' \
        --exclude='*' \
        "$ZH/" "$WORK/files/"
fi

# Copy base Generals data (prefixed with GameDataGenerals/)
BASE="$DATADIR/Generals"
if [ -d "$BASE" ]; then
    echo "==> Base Generals: $BASE"
    rsync -a \
        --include='*/' \
        --include='*.big' \
        --include='Data/**' \
        --include='Maps/**' \
        --exclude='*' \
        "$BASE/" "$WORK/files/GameDataGenerals/"
fi

# ── Fonts ─────────────────────────────────────────────────────────────────────
# The engine resolves TrueType faces from fonts/ under its CWD (/opfs/GameData).
# The game ships no .ttf files, so stage them: prefer a fonts/ dir shipped with
# the build, else download the metric-compatible Liberation fonts.
echo "==> Staging fonts"
FONTS_DIR="$WORK/files/fonts"
mkdir -p "$FONTS_DIR"
if [ -d "$ZH/fonts" ]; then
    rsync -a "$ZH/fonts/" "$FONTS_DIR/"
elif [ -d "$BASE/fonts" ]; then
    rsync -a "$BASE/fonts/" "$FONTS_DIR/"
elif [ -x "$REPO_ROOT/scripts/build/ios/stage-fonts.sh" ]; then
    GX_FONTS="$FONTS_DIR" "$REPO_ROOT/scripts/build/ios/stage-fonts.sh" || true
fi
if [ ! -f "$FONTS_DIR/arial.ttf" ]; then
    echo "WARNING: no fonts staged — game text will not render" >&2
fi

# Pack into single .data file (+ build.data.meta.json for resumable downloads).
# Segment cache lives outside dist so it is never uploaded to a host.
echo "==> Packing…"
GX_PACK_CACHE="$REPO_ROOT/web/.pack-cache" \
/opt/homebrew/bin/python3.11 "$REPO_ROOT/scripts/web/packer.py" "$WORK/files" "$OUTDIR/build.data"

echo "==> Done: $OUTDIR/build.data"
