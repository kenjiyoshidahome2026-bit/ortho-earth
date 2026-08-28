-- 公開台帳：作品＝URL で公開された GeoPBF 地図のポインタ。データ本体は預からない（非所有）。
-- url は https 完全形か gh:user/repo[@ref]/path 短縮形（検証は workers/works.js が正本）。
-- (user_id, url) 一意＝同じ URL の再公開は上書き更新（重複スパムを構造的に封じる）。
CREATE TABLE works (
	id         TEXT PRIMARY KEY,          -- crypto.randomUUID()
	user_id    TEXT NOT NULL REFERENCES users(id),
	title      TEXT NOT NULL,
	url        TEXT NOT NULL,
	author     TEXT,                      -- 公開表示名（既定＝users.name のスナップショット）
	view       TEXT,                      -- 初期視点（共有ハッシュ断片・任意）
	summary    TEXT,                      -- 一言説明（任意）
	thumb      INTEGER NOT NULL DEFAULT 0,-- サムネ有無（R2 キー w/{id}）
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	UNIQUE (user_id, url)
);
CREATE INDEX idx_works_user ON works(user_id);
CREATE INDEX idx_works_updated ON works(updated_at DESC);
