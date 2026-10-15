// 法務省地図（登記所備付地図）の開発用の手＝任意座標系の実験（札幌・荒川区）。コンソールから叩く道具（利用者向けの機能ではない）。
// 2026-09-24 に globe の gint/layers.js から移設＝硬い層に地域の語を置かない（LAYERS.md 掟 1・verify:regionless）。
// 使うのはホストの公開面だけ：map.applyGintData（単一スロットのユーザー層）・host.dbg（手の宿主）・host.assetBase（実行時アセットの置き場）。
// moj-local/ は手元専用（apps/ortho-japan/public/moj-local・deploy では除外）。
import { geopbf } from "geopbf";

const KEYS = ["__moj", "__mojFile", "__sapporo", "__arakawaFit"];

export function installMojDebug(map, host) {
	const dbg = host.dbg;
	// bucket/moj/{code}.pbf は geopbf の名の慣習（bucket/GIS/pbf/…）でない別棚＝URL を直叩きして buffer を geopbf に食わせる（gint:true で unPackGint 生成）
	dbg.__moj = async (code = "13118") => {
		const url = `https://api.ortho-earth.com/bucket/moj/${code}.pbf`;
		const res = await fetch(url);
		if (!res.ok) { console.error("[moj14] fetch failed %s -> HTTP %s", url, res.status); return; }
		let buf = await res.arrayBuffer();
		const head = new Uint8Array(buf, 0, 2);   // bucket は gzip で置かれる。名の慣習の load は自動で解凍するが直叩きは生バイト＝手で解凍
		if (head[0] === 0x1f && head[1] === 0x8b) buf = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
		const pbf = await geopbf(buf, { gint: true, name: `moj/${code}` });
		map.applyGintData(pbf, code, true, { drape: true });   // 14 条地図の筆＝地形沿いの境界線を自動で立てる
	};
	// 任意の File/URL（例：aigid など第三者が公共座標系→WGS84 まで変換済みの GeoJSON）を直接デコードして球へ（bucket の変換を経ずに確かめる時）
	dbg.__mojFile = async (fileOrUrl, name = "moj/local") => {
		const pbf = await geopbf(fileOrUrl, { gint: true, name });
		return map.applyGintData(pbf, name, true, { drape: true });
	};
	const local = async (path, fileName, name) => {
		const res = await fetch(host.assetBase + "moj-local/" + path);
		return dbg.__mojFile(new File([await res.blob()], fileName), name);
	};
	dbg.__sapporo = () => local("01101-aigid.geojson", "01101_aigid.geojson", "moj/01101_aigid");   // aigid 変換済み（札幌市中央区）
	// 荒川区（任意座標系のみ）を、大字/丁目名で e-Stat 小地域に位置合わせしたラバーシート結果で。回転はせず地名の対応だけで平行移動＋等方スケール（表示用の近似）
	dbg.__arakawaFit = () => local("13118-rubbersheet.geojson", "13118_rubbersheet.geojson", "moj/13118_rubbersheet");
	host.onDestroy(() => { for (const k of KEYS) delete dbg[k]; });
}
