#!/bin/sh
# The website with the old and the new version side by side (owner, 25 Nov 2026). The new build
# (today's dist/, built first with `npm run build`) goes at the root; the old build, made from a
# git commit, puts its page and service worker in __old/ and its hashed files in assets/.
# functions/_middleware.js picks the version by cookie. Deploy the output folder, not dist/.
#
# Usage: sh scripts/build-two-version-site.sh <output folder> [old commit, default b138376] [previous site folder]
#
# One build per tab (owner, 26 Nov 2026):
# - The old build gets today's service worker (public/sw.js) with its own file list, so both
#   versions follow the same rules.
# - The hashed files of the previous deployment stay in assets/. A tab that was open before this
#   release, and has no complete service-worker cache, can still load its own lazy parts. The
#   previous site folder defaults to the newest other output/web/deploy-*/site.
# The old build uses today's node_modules, so it needs the same dependencies as that commit.
set -e
OUT=$1
REF=${2:-b138376}
[ -n "$OUT" ] || { echo "usage: build-two-version-site.sh <output folder> [old commit]" >&2; exit 1; }
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# The new build is dist/, or the folder PDF_CHEF_DIST_DIR names (as for npm run build).
DIST=${PDF_CHEF_DIST_DIR:-$ROOT/dist}
[ -f "$DIST/index.html" ] || { echo "run npm run build first" >&2; exit 1; }
DIST=$(cd "$DIST" && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
git -C "$ROOT" archive "$REF" | tar -x -C "$WORK"
ln -s "$ROOT/node_modules" "$WORK/node_modules"
cp "$ROOT/public/sw.js" "$WORK/public/sw.js"
(cd "$WORK" && env -u PDF_CHEF_DIST_DIR npm run build > "$WORK/build.log" 2>&1) || { cat "$WORK/build.log" >&2; exit 1; }
rm -rf "$OUT"
mkdir -p "$(dirname "$OUT")"
cp -R "$DIST" "$OUT"
find "$OUT" -name .DS_Store -delete
rsync -a --ignore-existing "$WORK/dist/assets/" "$OUT/assets/"
mkdir -p "$OUT/__old"
cp "$WORK/dist/index.html" "$WORK/dist/sw.js" "$OUT/__old/"
OUT=$(cd "$OUT" && pwd)
PREVIOUS=${3:-$(ls -d "$ROOT"/output/web/deploy-*/site 2>/dev/null | grep -v -x "$OUT" | sort | tail -1)}
if [ -n "$PREVIOUS" ] && [ -f "$PREVIOUS/sw.js" ]; then
  # Only the files the previous deployment's own workers list, so the folder does not grow with every release.
  node -e '
    const { copyFileSync, existsSync, readFileSync } = require("node:fs");
    const [previous, out] = process.argv.slice(1);
    // Both of its workers: the new build at the root and the old one in __old/.
    const list = ["sw.js", "__old/sw.js"].filter((worker) => existsSync(`${previous}/${worker}`))
      .flatMap((worker) => JSON.parse(readFileSync(`${previous}/${worker}`, "utf8").match(/const PRECACHE_ASSETS = (\[[^;]*\]);/)[1]));
    const kept = [...new Set(list)].filter((path) => path.startsWith("/assets/") && !path.includes("..") && !existsSync(out + path) && existsSync(previous + path));
    for (const path of kept) copyFileSync(previous + path, out + path);
    console.log(`kept ${kept.length} hashed files of the previous deployment (${previous})`);
  ' "$PREVIOUS" "$OUT"
else
  echo "no previous deployment folder found: its hashed files are not kept"
fi
echo "two-version site in $OUT (old: $REF)"
