#!/bin/sh
# The website with the old and the new version side by side (owner, 25 Nov 2026). The new build
# (today's dist/, built first with `npm run build`) goes at the root; the old build, made from a
# git commit, puts its page and service worker in __old/ and its hashed files in assets/.
# functions/_middleware.js picks the version by cookie. Deploy the output folder, not dist/.
#
# Usage: sh scripts/build-two-version-site.sh <output folder> [old commit, default b138376]
# The old build uses today's node_modules, so it needs the same dependencies as that commit.
set -e
OUT=$1
REF=${2:-b138376}
[ -n "$OUT" ] || { echo "usage: build-two-version-site.sh <output folder> [old commit]" >&2; exit 1; }
ROOT=$(cd "$(dirname "$0")/.." && pwd)
[ -f "$ROOT/dist/index.html" ] || { echo "run npm run build first" >&2; exit 1; }
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
git -C "$ROOT" archive "$REF" | tar -x -C "$WORK"
ln -s "$ROOT/node_modules" "$WORK/node_modules"
(cd "$WORK" && npm run build > "$WORK/build.log" 2>&1) || { cat "$WORK/build.log" >&2; exit 1; }
rm -rf "$OUT"
mkdir -p "$(dirname "$OUT")"
cp -R "$ROOT/dist" "$OUT"
find "$OUT" -name .DS_Store -delete
rsync -a --ignore-existing "$WORK/dist/assets/" "$OUT/assets/"
mkdir -p "$OUT/__old"
cp "$WORK/dist/index.html" "$WORK/dist/sw.js" "$OUT/__old/"
echo "two-version site in $OUT (old: $REF)"
