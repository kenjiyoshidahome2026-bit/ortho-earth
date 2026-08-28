// 3社の OAuth 差分を全部ここに閉じ込める（oauth.js 側にはプロバイダ分岐を作らない）。
//  - github: PKCE は無視される（送って無害）。userinfo は User-Agent 必須。email は public 設定のみ＝当てにしない
//  - google: OIDC だが id_token は検証せず userinfo エンドポイントで済ます（JWKS 取得や JWT 検証を持ち込まない）
//  - x: PKCE S256 必須・token は Basic クライアント認証・メールは返らない（メール名寄せをしない設計の根拠）
export const PROVIDERS = {
	github: {
		authorize: "https://github.com/login/oauth/authorize",
		token: "https://github.com/login/oauth/access_token",
		userinfo: "https://api.github.com/user",
		scope: "read:user",
		clientAuth: "body",
		tokenHeaders: { Accept: "application/json" },   // 既定は form-encoded 応答＝JSON を明示
		userHeaders: t => ({ Authorization: `Bearer ${t}`, "User-Agent": "ortho-earth-account", Accept: "application/vnd.github+json" }),
		map: j => ({ uid: String(j.id), name: j.name || j.login, avatar: j.avatar_url || null, email: j.email || null }),
		creds: env => [env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET],
	},
	google: {
		authorize: "https://accounts.google.com/o/oauth2/v2/auth",
		token: "https://oauth2.googleapis.com/token",
		userinfo: "https://openidconnect.googleapis.com/v1/userinfo",
		scope: "openid email profile",
		clientAuth: "body",
		userHeaders: t => ({ Authorization: `Bearer ${t}` }),
		map: j => ({ uid: j.sub, name: j.name || null, avatar: j.picture || null, email: j.email || null }),
		creds: env => [env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET],
	},
	x: {
		authorize: "https://x.com/i/oauth2/authorize",
		token: "https://api.x.com/2/oauth2/token",
		userinfo: "https://api.x.com/2/users/me?user.fields=profile_image_url",
		scope: "users.read tweet.read",   // users.read は tweet.read 同伴が必須
		clientAuth: "basic",
		userHeaders: t => ({ Authorization: `Bearer ${t}` }),
		map: j => ({ uid: j.data?.id, name: j.data?.name || j.data?.username, avatar: j.data?.profile_image_url || null, email: null }),
		creds: env => [env.X_CLIENT_ID, env.X_CLIENT_SECRET],
	},
};
