#!/usr/bin/env sh
# Publish the explorer to the gh-pages branch, served at
# https://idle-intelligence.github.io/ridgeline/web/
#
# Only web/ + the built WASM are deployed. The terrain blobs stay on the HF
# dataset and are fetched from there at runtime via window.RIDGELINE_DATA_BASE.
set -e

HF_BASE='https://huggingface.co/datasets/idle-intelligence/ridgeline-terrain/resolve/main'
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

python3 - "$WT/web/index.html" "$HF_BASE" <<'PY'
import sys
path, base = sys.argv[1], sys.argv[2]
tag = '<script type="module" src="explore.js"></script>'
html = open(path).read()
assert tag in html, 'explore.js script tag not found in index.html'
open(path, 'w').write(
    html.replace(tag, f"<script>window.RIDGELINE_DATA_BASE = {base!r};</script>\n  {tag}"))
PY

git -C "$WT" add -A
git -C "$WT" commit -qm "Deploy explorer" || echo "gh-pages: no changes to deploy"
git -C "$WT" push -q origin gh-pages
git worktree remove --force "$WT"
echo "deployed → https://idle-intelligence.github.io/ridgeline/web/"
