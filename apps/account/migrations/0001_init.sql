-- account の初期スキーマ。時刻は全て epoch 秒。
-- 名寄せはしない：identity（provider, provider_uid）が正。メールは参考情報（X は常に NULL）。
CREATE TABLE users (
	id          TEXT PRIMARY KEY,          -- crypto.randomUUID()
	created_at  INTEGER NOT NULL,
	name        TEXT,
	avatar_url  TEXT
);
CREATE TABLE identities (
	provider     TEXT NOT NULL,            -- 'github' | 'google' | 'x'
	provider_uid TEXT NOT NULL,            -- 数値IDも文字列で統一
	user_id      TEXT NOT NULL REFERENCES users(id),
	email        TEXT,
	profile_json TEXT,
	PRIMARY KEY (provider, provider_uid)
);
CREATE INDEX idx_identities_user ON identities(user_id);
CREATE TABLE sessions (
	sid_hash   TEXT PRIMARY KEY,           -- SHA-256(生sid) hex。生 sid は Cookie にのみ存在
	user_id    TEXT NOT NULL REFERENCES users(id),
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	ua         TEXT
);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
CREATE TABLE files (
	user_id    TEXT NOT NULL REFERENCES users(id),
	name       TEXT NOT NULL,              -- 検証済み表示名。R2 キーは u/{user_id}/{name}
	size       INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (user_id, name)
);
