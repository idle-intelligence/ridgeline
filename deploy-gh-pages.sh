#!/usr/bin/env sh
# Publish the explorer to the gh-pages branch, served at
# https://idle-intelligence.github.io/ridgeline/web/
#
# Only web/ + the built WASM are deployed. The terrain blobs stay on the HF
# dataset, which terrain-cache.js already fetches from by default.
set -e

ROOT=$(cd "$(dirname "$0")" && pwd)
cd "$ROOT"

wasm-pack build core --target web --out-dir ../web/pkg

WT=$(mktemp -d)
git fetch -q origin gh-pages 2>/dev/null || true
if git show-ref --verify --quiet refs/remotes/origin/gh-pages; then
  git worktree add -q "$WT" origin/gh-pages
  git -C "$WT" checkout -q -B gh-pages
else
  git worktree add -q --detach "$WT"
  git -C "$WT" checkout -q --orphan gh-pages
  git -C "$WT" rm -rqf . 2>/dev/null || true
fi

rm -rf "$WT/web"
mkdir -p "$WT/web"
cp web/*.html web/*.js web/favicon.svg "$WT/web/"
rm -f "$WT"/web/*.test.js
cp -R web/pkg "$WT/web/pkg"

# The app lives under web/; send the bare repo URL there so it isn't a 404.
cat > "$WT/index.html" <<'HTML'
<!doctype html>
<meta charset="utf-8">
<title>ridgeline</title>
<meta http-equiv="refresh" content="0; url=web/">
<link rel="canonical" href="web/">
<a href="web/">ridgeline</a>
HTML

# -f: web/pkg is gitignored in the source tree, but it is the whole point of the deploy.
git -C "$WT" add -Af
git -C "$WT" commit -qm "Deploy explorer" || echo "gh-pages: no changes to deploy"
git -C "$WT" push -q origin gh-pages
git worktree remove --force "$WT"
echo "deployed → https://idle-intelligence.github.io/ridgeline/web/"
