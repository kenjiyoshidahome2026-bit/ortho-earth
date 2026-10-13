// 共有データ（gishub-jp と census2020 が読む小地域 CSV・人口推移・郵便番号）→ bucket GIS/shared/…（2026-09-30・縮小計画 項目6b）。
// 正本＝apps/gishub-jp/shared-data/。キーは manifest.json（gishub-jp の scripts/shared-data.mjs が中身のハッシュから書く）に従う。
// 同じキー＝同じ中身＝既にあれば置き直さない。古いキーは消さない（前の版のアプリが読み続けられる）。
// 中身は dev server の /@fs で monorepo から直に読む＝dev でだけ動く（build した uploader に 22MB を抱えさせない）。
import manifest from "../../gishub-jp/shared-data/manifest.json";

const MIME = { csv: "text/csv", json: "application/json" };

export async function sharedData(q, { Bucket }) {
	q.clear(); q.title("共有データ → GIS/shared");
	if (!import.meta.env.DEV) throw new Error("dev server（npm run dev -w uploader）でだけ動く");
	for (const [name, key] of Object.entries(manifest)) {
		const dir = key.slice(0, key.lastIndexOf("/")), file = key.slice(key.lastIndexOf("/") + 1);
		const bucket = await Bucket(dir);
		if (!bucket) throw new Error(`Bucket(${dir}) に到達できない`);
		if (await bucket.exist(file)) { q.log(`= ${key}（既にある）`); continue; }
		const res = await fetch(`/@fs${__SHARED_DATA_DIR__}/${name}`);
		if (!res.ok) throw new Error(`${name} を読めない（${res.status}）`);
		const blob = await res.blob();
		await bucket.put(new File([blob], file, { type: MIME[file.split(".").pop()] || "application/octet-stream" }));
		q.success(`↑ ${key}（${(blob.size / 1e6).toFixed(1)}MB）`);
	}
}
