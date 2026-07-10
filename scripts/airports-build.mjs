// 全国の空港・飛行場の位置を optimal_bvmap から一度だけ収穫して静的JSONへ。
// Anno vt_code 441（空港名）は z11 以上のタイルにしか無い＝低ズームで空港マークを出すための座標台帳を作る。
// z8 で陸タイル（RdCL あり）に絞り込み → 配下の z11 タイル(64個/親)を走査 → 「〜空港/〜飛行場」を収集。
// 使い方: node scripts/airports-build.mjs
import { fetchMVT, lonLatToTile, tileLocalToLonLat } from "ortho-japan";
import { writeFileSync } from "fs";

const OUT = "apps/ortho-japan/public/airports.json";
const CONCURRENCY = 16;
const URL8 = (z, x, y) => `https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/${z}/${x}/${y}.pbf`;

// 日本域 z8 タイル範囲（沖縄〜北海道・小笠原は 142E までに含まれる）
const [x0] = lonLatToTile(122.5, 30, 8), [x1] = lonLatToTile(154.0, 30, 8);
const [, y0] = lonLatToTile(140, 45.8, 8), [, y1] = lonLatToTile(140, 24.0, 8);

async function pooled(items, fn) {
	const out = []; let i = 0;
	await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
		while (i < items.length) { const k = i++; out[k] = await fn(items[k]).catch(() => null); }
	}));
	return out;
}

// 1) z8 陸タイル
const z8tiles = [];
for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) z8tiles.push([x, y]);
console.log(`z8 走査: ${z8tiles.length} タイル`);
let done = 0;
const land = (await pooled(z8tiles, async ([x, y]) => {
	const layers = await fetchMVT(URL8(8, x, y));
	if (++done % 50 === 0) console.log(`  z8 ${done}/${z8tiles.length}`);
	return (layers.RdCL || layers.RailCL) ? [x, y] : null;
})).filter(Boolean);
console.log(`陸タイル: ${land.length}`);

// 2) 配下 z11 を走査して 441 を収穫
const z11tiles = [];
for (const [x8, y8] of land) for (let dy = 0; dy < 8; dy++) for (let dx = 0; dx < 8; dx++) z11tiles.push([x8 * 8 + dx, y8 * 8 + dy]);
console.log(`z11 走査: ${z11tiles.length} タイル`);
done = 0;
const found = new Map();   // name → { lons:[], lats:[] }（バッファ重複はまとめて平均）
await pooled(z11tiles, async ([x, y]) => {
	const layers = await fetchMVT(URL8(11, x, y));
	if (++done % 500 === 0) console.log(`  z11 ${done}/${z11tiles.length} (空港 ${found.size})`);
	const A = layers.Anno; if (!A) return;
	for (const f of A.features) {
		if (f.props.vt_code !== 441) continue;
		const t = f.props.vt_text || "";
		if (!/(空港|飛行場)$/.test(t)) continue;
		const p = f.geom[0][0];
		const [lon, lat] = tileLocalToLonLat(x, y, 11, p.x, p.y, A.extent);
		let e = found.get(t); if (!e) found.set(t, e = { lons: [], lats: [] });
		e.lons.push(lon); e.lats.push(lat);
	}
});
const list = [...found.entries()]
	.map(([name, e]) => ({ name, lon: +(e.lons.reduce((a, b) => a + b) / e.lons.length).toFixed(5), lat: +(e.lats.reduce((a, b) => a + b) / e.lats.length).toFixed(5) }))
	.sort((a, b) => a.name.localeCompare(b.name, "ja"));
writeFileSync(OUT, JSON.stringify(list, null, "\t"));
console.log(`Done. ${list.length} 空港 → ${OUT}`);
