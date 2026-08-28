// account Worker のルーター。/auth*（OAuth ログイン）・/me*（ユーザー別ファイル/自分の台帳）・/works*（公開台帳の公開面）を握る。
// 全アプリと同一オリジン（www.ortho-earth.com）＝CORS 無し。CSRF は「非GETは Origin 完全一致必須」＋ SameSite=Lax の二重防御。
// Origin 照合に includes() を使わないこと（evil.com/www.ortho-earth.com が通る＝native-bucket proxy.js の教訓）。
import { login, callback, logout } from "./oauth.js";
import { me, filesList, fileGet, filePut, fileDel } from "./files.js";
import { worksList, workPost, workPut, workDel, thumbPut, catalog, thumbGet } from "./works.js";
import { err } from "./http.js";

const originOk = (req, env) => {
	const origin = req.headers.get("Origin");
	return !!origin && (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).includes(origin);
};

export default {
	async fetch(req, env) {
		const p = new URL(req.url).pathname;
		try {
			if (req.method !== "GET" && req.method !== "HEAD" && !originOk(req, env))
				return err(403, "forbidden", "origin not allowed");
			let m;
			if ((m = p.match(/^\/auth\/login\/(\w+)$/)) && req.method === "GET") return await login(req, env, m[1]);
			if ((m = p.match(/^\/auth\/callback\/(\w+)$/)) && req.method === "GET") return await callback(req, env, m[1]);
			if (p === "/auth/logout" && req.method === "POST") return await logout(req, env);
			if (p === "/me" && req.method === "GET") return await me(req, env);
			if (p === "/me/files" && req.method === "GET") return await filesList(req, env);
			if ((m = p.match(/^\/me\/files\/([^/]+)$/))) {
				if (req.method === "GET") return await fileGet(req, env, m[1]);
				if (req.method === "PUT") return await filePut(req, env, m[1]);
				if (req.method === "DELETE") return await fileDel(req, env, m[1]);
			}
			if (p === "/works/catalog.json" && req.method === "GET") return await catalog(req, env);
			if ((m = p.match(/^\/works\/thumb\/([\w-]+)$/)) && req.method === "GET") return await thumbGet(req, env, m[1]);
			if (p === "/me/works" && req.method === "GET") return await worksList(req, env);
			if (p === "/me/works" && req.method === "POST") return await workPost(req, env);
			if ((m = p.match(/^\/me\/works\/([\w-]+)$/))) {
				if (req.method === "PUT") return await workPut(req, env, m[1]);
				if (req.method === "DELETE") return await workDel(req, env, m[1]);
			}
			if ((m = p.match(/^\/me\/works\/([\w-]+)\/thumb$/)) && req.method === "PUT") return await thumbPut(req, env, m[1]);
			return err(404, "not_found", `no route: ${req.method} ${p}`);
		} catch (e) {
			return err(500, "internal", e.message);
		}
	},
};
