#!/bin/sh
# 模擬サーバで全工程を通す検定。ROOT を一時ディレクトリに向けるため、ONSEN_ROOT を使う。
set -e
cd "$(dirname "$0")"
PORT=18080
node mock-server.mjs $PORT & MP=$!
trap 'kill $MP' EXIT
sleep 0.5
export WIKI_API=http://127.0.0.1:$PORT/w/api.php WD_API=http://127.0.0.1:$PORT/wd/api.php SPARQL=http://127.0.0.1:$PORT/sparql NOMINATIM=http://127.0.0.1:$PORT/osm GSI=http://127.0.0.1:$PORT/gsi HITOU=http://127.0.0.1:$PORT/hitou
export ONSEN_ROOT="${ONSEN_ROOT:-$(mktemp -d)}"
echo "root: $ONSEN_ROOT"
node 01-pages.mjs --refresh && node 02-fetch.mjs --refresh && node 03-wikidata.mjs --refresh && node 05-geocode.mjs --refresh && node 06-hitou.mjs --refresh && node 04-build.mjs
node test-parse.mjs
echo "--- onsen.csv"; cat "$ONSEN_ROOT/data/onsen.csv"; echo "--- onsen-kyo.geojson"; cat "$ONSEN_ROOT/data/onsen-kyo.geojson"; echo; echo "--- geocode.json"; cat "$ONSEN_ROOT/geocode.json"; echo "--- hitou-inns.csv"; cat "$ONSEN_ROOT/data/hitou-inns.csv"
