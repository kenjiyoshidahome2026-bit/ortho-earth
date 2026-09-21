// 「URL → geopbf → GIS/pbf へ save」の共通手順（旧 main.js の coastline/admin0/lakes/rivers/borders は同じ 15 行の複写だった）。
// 各項目は独立＝1 本の失敗が他を巻き添えにしない（50m を先に焼く運用＝モバイルの本命を先に確保、の前提）。
// 失敗は q.error に出して続行し、最後に失敗数を返す。
import { geopbf } from "geopbf";

export const NE_HEADER = { license: "Natural Earth (public domain)", attribution: "Natural Earth" };
export const neZip = (res, group, name) => `https://naturalearth.s3.amazonaws.com/${res}_${group}/${name}.zip`;

// items: [{ name, url, header?, opts? }]（header＝updateHeader に渡す description/license/attribution・opts＝geopbf の追加オプション）
export async function bakeEach(q, title, items) {
	q.clear();
	q.title(title);
	let failed = 0;
	for (const { name, url, header, opts } of items) {
		try {
			const pbf = await geopbf(url, { name, nocache: true, ...opts });
			if (!pbf.length) throw new Error(`0 features — check source URL or decoder`);
			if (header) pbf.updateHeader(header);
			q.log(`${name}: ${pbf.length} features, keys: [${pbf.keys.join(', ')}]`);
			await pbf.save();   // ← VITE_API_KEY 未設定だとここで 403（起動時の警告が出ていたら鍵を設定して dev server 再起動）
			q.success(`${name}: saved (<= ${url})`);
			q.log(await pbf.profile());
		} catch (e) {
			failed++;
			q.error(`${name}: 失敗 — ${e.message}`);
		}
	}
	return failed;
}
