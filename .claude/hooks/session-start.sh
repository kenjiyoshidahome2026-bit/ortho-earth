#!/bin/bash
# Claude Code on the web（クラウドの器）で始まった時だけ、依存を入れてブラウザ検定の Chrome を用意する。
# 手元の Mac では何もしない（CLAUDE_CODE_REMOTE が立たない）。
set -euo pipefail
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
cd "$CLAUDE_PROJECT_DIR"

# npm test・build:all に要る依存（lock どおり。入っていれば npm ci は飛ばす）
[ -d node_modules/vite ] || npm ci --no-audit --no-fund

# 検定の scripts は CHROME で Chrome の場所を受ける。器は root なので sandbox 抜きの包みを渡す
if [ -x /opt/pw-browsers/chromium ] && [ -n "${CLAUDE_ENV_FILE:-}" ]; then
	echo "export CHROME=\"$CLAUDE_PROJECT_DIR/.claude/hooks/chrome-no-sandbox.sh\"" >> "$CLAUDE_ENV_FILE"
fi
