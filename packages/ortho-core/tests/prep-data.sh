#!/bin/bash
# gint-lod.mjs --coast の実データを tests/data/ に用意する（要ネットワーク・WASM は同梱 pkg を使用）。
set -e
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
"$ROOT/node_modules/.bin/esbuild" "$ROOT/packages/ortho-core/tests/prep-data.mjs" \
	--bundle --platform=node --format=esm --outfile="$TMP/prep-data.bundle.mjs" "--external:node:*"
node "$TMP/prep-data.bundle.mjs"
