#!/bin/sh
# 全工程を順に実行する。--refresh を付けると raw/ のキャッシュを捨てて取り直す。
# 必要: Node 22+。プロキシ環境では NODE_USE_ENV_PROXY=1 で fetch が HTTPS_PROXY を読む。
set -e
cd "$(dirname "$0")"
export NODE_USE_ENV_PROXY=1
node 01-pages.mjs "$@"
node 02-fetch.mjs "$@"
node 03-wikidata.mjs "$@"
node 05-geocode.mjs "$@"
node 06-hitou.mjs "$@"
node 04-build.mjs
node ledger-build.mjs
node ledger-list.mjs
