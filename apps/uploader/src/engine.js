// 共有エンジン（/globe/engine/<版>/・縮小計画 項目 9）の控え → bucket GIS/engine/<版>/…（2026-09-30）。
// 本番の ortho-globe は assets に今の版だけを持つ＝版を上げると前の版が消える。先に上がった他のアプリ（world・geopbf）が
// 前の版を指したままでも動くよう、ortho-globe の Worker は assets に無い版を R2 のこの控えから返す（apps/ortho-globe/deploy-worker.js ③）。
// 手順＝npm run build -w ortho-globe（dist/engine/<版>/ ができる）→ このボタン → ortho-globe を deploy。既に置いた物は置き直さない（同じ版＝同じ中身）。
// 中身は dev server の /@fs で monorepo から直に読む＝dev でだけ動く（共有データのボタンと同じ）。
const MIME = { js: "text/javascript", css: "text/css", wasm: "application/wasm", png: "image/png", json: "application/json" };

export async function engine(q, { Bucket }) {
	q.clear(); q.title("共有エンジン → GIS/engine");
	if (!import.meta.env.DEV) throw new Error("dev server（npm run dev -w uploader）でだけ動く");
	// 無いファイルでも vite の dev server は index.html を 200 で返す＝ok では見分けられない＝JSON として読めるかで判定
	const cur = await fetch(`/@fs${__ENGINE_DIR__}/current.json`).then(r => r.json()).catch(() => null);
	if (!cur?.version) throw new Error("共有エンジンがまだ焼かれていない＝先に npm run build -w ortho-globe（apps/ortho-globe/dist/engine/current.json を作る）");
	const { version, files } = cur;
	const have = new Set();
	let put = 0, bytes = 0;
	for (const f of files) {
		const key = `GIS/engine/${version}/${f}`, dir = key.slice(0, key.lastIndexOf("/")), name = key.slice(key.lastIndexOf("/") + 1);
		const bucket = await Bucket(dir);
		if (!bucket) throw new Error(`Bucket(${dir}) に到達できない`);
		if (!have.has(dir)) { for (const o of await bucket.list()) have.add(`${dir}/${o.Key}`); have.add(dir); }
		if (have.has(key)) continue;
		const r = await fetch(`/@fs${__ENGINE_DIR__}/${version}/${f}`);
		if (!r.ok || (r.headers.get("content-type") || "").startsWith("text/html")) throw new Error(`${f} を読めない（${r.status}）＝npm run build -w ortho-globe をやり直す`);
		const blob = await r.blob();
		await bucket.put(new File([blob], name, { type: MIME[name.split(".").pop()] || "application/octet-stream" }));
		put++; bytes += blob.size;
	}
	q.success(`GIS/engine/${version}：${files.length} 本のうち ${put} 本を置いた（${(bytes / 1e6).toFixed(1)}MB）${put ? "" : "＝既に全部ある"}`);
}
