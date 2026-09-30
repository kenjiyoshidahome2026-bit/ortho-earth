#!/bin/sh
# クラウドの器（root で走る）用：Playwright の Chromium を --no-sandbox で起こす。session-start.sh が CHROME に渡す。
exec /opt/pw-browsers/chromium --no-sandbox "$@"
