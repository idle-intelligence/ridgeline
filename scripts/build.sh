#!/usr/bin/env bash
# Builds the ridgeline-core WASM module and assembles the deployed site into
# _site/, matching the layout deploy-gh-pages.sh has published up to now
# (a root index.html redirect to web/, plus web/ itself with its built pkg/).
#
# Usage: ENGINE_BUILD=<tag> scripts/build.sh
# ENGINE_BUILD defaults to "dev" for local builds; CI passes the commit sha.
# It is required on every real deploy - a rebuild with no tag bump keeps
# browsers running the cached wasm pkg.
set -euo pipefail

ENGINE_BUILD="${ENGINE_BUILD:-dev}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "==> Building ridgeline-core for ENGINE_BUILD=$ENGINE_BUILD"
RUSTFLAGS="--remap-path-prefix=$HOME=/home" \
  wasm-pack build core --target web --release --out-dir ../web/pkg

WASM="web/pkg/ridgeline_core_bg.wasm"

# --- Local-path / user-name leak check on the built wasm ---
LEAKS=$(strings "$WASM" | grep -F -e "$HOME" -e "Code/" -e ".claude/" -e "/Users/" || true)
USER_HITS=$(strings "$WASM" | grep -Fw -e "$(id -un)" || true)
if [ -n "$LEAKS$USER_HITS" ]; then
    echo "error: $WASM contains local paths or the user name:" >&2
    printf '%s\n%s\n' "$LEAKS" "$USER_HITS" | grep -v '^$' | head -20 >&2
    exit 1
fi
echo "==> no local paths in built wasm"

# --- Assemble the deployed site into _site/ ---
echo "==> Assembling _site"
rm -rf _site
mkdir -p _site/web
cp web/*.html web/*.js web/favicon.svg _site/web/
rm -f _site/web/*.test.js
cp -R web/pkg _site/web/pkg

cat > _site/index.html <<'HTML'
<!doctype html>
<meta charset="utf-8">
<title>ridgeline</title>
<meta http-equiv="refresh" content="0; url=web/">
<link rel="canonical" href="web/">
<a href="web/">ridgeline</a>
HTML

# --- Rewrite the ENGINE_BUILD tag on every wasm loading URL ---
echo "==> Rewriting ENGINE_BUILD tag to $ENGINE_BUILD"
sed -i.bak "s/const ENGINE_BUILD = \"[^\"]*\";/const ENGINE_BUILD = \"$ENGINE_BUILD\";/" \
  _site/web/explore.js
rm -f _site/web/explore.js.bak

COUNT="$(grep -c "ENGINE_BUILD = \"$ENGINE_BUILD\"" _site/web/explore.js)"
if [ "$COUNT" -ne 1 ]; then
    echo "error: expected 1 ENGINE_BUILD assignment rewritten to $ENGINE_BUILD, found $COUNT" >&2
    exit 1
fi

echo "==> Wrote _site"
