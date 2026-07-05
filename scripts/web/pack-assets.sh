#!/usr/bin/env bash
# GeneralsX Web - pack a Zero Hour installation for the web server.
#
# Copies the game data the web build needs from a GeneralsZH install
# (see docs/HOWTO/GETTING_THE_GAME_FILES.md / scripts/get-assets.sh) into
# the static bundle (web/dist/assets by default), stages the FreeType fonts,
# and generates manifest.json.
#
# Usage:
#   scripts/web/pack-assets.sh /path/to/GeneralsZH [output-dir]
#
# Output layout (fetched by the loader via relative paths):
#   <out>/files/...        the asset tree (also what lands in OPFS GameData/)
#   <out>/manifest.json    {version, totalBytes, files:[{path,size,sha256}]}
#
# GeneralsX @build web-port 05/07/2026 - Web port Phase 1
set -euo pipefail

SRC="${1:?usage: pack-assets.sh /path/to/GeneralsZH [output-dir]}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${2:-$REPO_ROOT/web/dist/assets}"

if [ ! -d "$SRC" ]; then
    echo "ERROR: $SRC is not a directory" >&2
    exit 1
fi
if ! ls "$SRC"/*.big >/dev/null 2>&1; then
    echo "ERROR: no .big archives in $SRC - is this a Zero Hour install?" >&2
    exit 1
fi

mkdir -p "$OUT/files"

echo "==> Copying game data from $SRC"
# .big archives (the bulk), plus loose data the engine reads directly.
rsync -a --delete \
    --include='*/' \
    --include='*.big' \
    --include='Data/**' \
    --include='Maps/**' \
    --exclude='*' \
    "$SRC/" "$OUT/files/"

echo "==> Staging fonts (FreeType needs .ttf files in GameData/fonts)"
FONTS_DIR="$OUT/files/fonts"
mkdir -p "$FONTS_DIR"
if [ -d "$SRC/fonts" ]; then
    rsync -a "$SRC/fonts/" "$FONTS_DIR/"
elif [ -x "$REPO_ROOT/scripts/build/ios/stage-fonts.sh" ]; then
    # Reuse the iOS font stager (Liberation fonts renamed to the faces the
    # game asks for). It stages into the dir given as $1.
    GX_FONTS="$FONTS_DIR" "$REPO_ROOT/scripts/build/ios/stage-fonts.sh" || {
        echo "WARNING: stage-fonts.sh failed; place arial.ttf into $FONTS_DIR manually" >&2
    }
else
    echo "WARNING: no fonts source found; text rendering needs $FONTS_DIR/arial.ttf" >&2
fi

echo "==> Generating manifest.json"
cd "$REPO_ROOT/web"
go run ./cmd/gen-manifest -dir "$OUT/files" -out "$OUT/manifest.json"

echo "==> Done. Assemble the static bundle (if not yet):"
echo "    scripts/web/make-dist.sh"
echo "    Then upload web/dist/ anywhere, or serve locally:"
echo "    cd $REPO_ROOT/web && go run ./server -dir ./dist"
