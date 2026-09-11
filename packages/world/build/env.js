// 実行環境の差（Node / ブラウザ）をここに閉じ込める。build 本体は env.json / env.text / env.cache だけを使う。
//   json(url)            : JSON を取る（キャッシュ経由）
//   text(url, {proxy})   : テキストを取る（proxy=true は CORS の無い先＝ブラウザでは api.ortho-earth.com の /proxy/ を通す）
//   cache(key[, value])  : 取得結果の永続キャッシュ（Node=ファイル・ブラウザ=IDB）。value 省略で読み
//   log / warn           : 進捗と検札（uploader ではパネルへ）
export const UA = "ortho-earth-world-build/2.0 (https://github.com/ortho-earth; kenji.yoshida.home.2026@gmail.com)";

export function makeEnv({ fetchJSON, fetchText, cache, log = console.log, warn = console.warn }) {
	const retry = async (f, label) => {
		let err = null;
		for (let i = 0; i < 4; i++) {
			if (i) { log(`  再試行 ${i}: ${label}`); await new Promise(r => setTimeout(r, 2000 * i)); }
			try { return await f(); } catch (e) { err = e; }
		}
		throw err;
	};
	const json = async url => {
		const hit = await cache(url); if (hit !== undefined && hit !== null) return hit;
		const v = await retry(() => fetchJSON(url), url.slice(0, 80));
		v != null && await cache(url, v);
		return v;
	};
	const text = async (url, opts = {}) => {
		const hit = await cache(url); if (typeof hit == "string") return hit;
		const v = await retry(() => fetchText(url, opts), url.slice(0, 80));
		typeof v == "string" && await cache(url, v);
		return v;
	};
	return { json, text, cache, log, warn };
}

// Node 用: fetch + ファイルキャッシュ（<dir>/<sha1>.json）。--fresh で dir を空にしてから呼ぶ
export async function nodeEnv({ cacheDir, fresh = false } = {}) {
	const fs = await import("node:fs/promises"), path = await import("node:path"), crypto = await import("node:crypto");
	cacheDir = cacheDir || path.resolve(import.meta.dirname, "../.cache");
	if (fresh) await fs.rm(cacheDir, { recursive: true, force: true });
	await fs.mkdir(cacheDir, { recursive: true });
	const file = key => path.join(cacheDir, crypto.createHash("sha1").update(key).digest("hex") + ".json");
	const cache = async (key, value) => {
		if (value === undefined) { try { return JSON.parse(await fs.readFile(file(key), "utf8")).v; } catch { return undefined; } }
		await fs.writeFile(file(key), JSON.stringify({ key, v: value }));
	};
	const headers = { "User-Agent": UA };
	const fetchJSON = async url => { const r = await fetch(url, { headers }); if (!r.ok) throw new Error(`${r.status} ${url}`); return r.json(); };
	const fetchText = async url => { const r = await fetch(url, { headers }); if (!r.ok) throw new Error(`${r.status} ${url}`); return r.text(); };
	return makeEnv({ fetchJSON, fetchText, cache });
}
