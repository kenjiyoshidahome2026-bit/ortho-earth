// t-cog-proj: src/cog/proj.js（Krüger TM）と warp.js の検定。
// 独立検証: 中央経線上の北距＝0.9996×子午線弧長を「数値積分」で照合（級数と独立の答え合わせ）。
import { projFor } from "../src/cog/proj.js";
import { warpRGBA, geoAtLevel, lonlatTarget } from "../src/cog/warp.js";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };

// ---- 往復誤差: 全ゾーン代表点で < 1e-9 deg ----------------------------------------------------
{
	let worst = 0;
	for (const epsg of [32601, 32630, 32654, 32660, 32701, 32733, 32760]) {
		const p = projFor(epsg);
		const zone = epsg % 100, lon0 = (zone - 30.5) * 6, south = epsg > 32700;
		for (const dlon of [-2.9, -1, 0, 1.5, 2.9]) for (const lat of south ? [-75, -40, -5] : [5, 35.681236, 70]) {
			const ll = [lon0 + dlon, lat];
			const back = p.inverse(p.forward(ll));
			worst = Math.max(worst, Math.abs(back[0] - ll[0]), Math.abs(back[1] - ll[1]));
		}
	}
	ok(worst < 1e-9, `UTM 往復誤差 < 1e-9 deg（実測 ${worst.toExponential(2)}）`);
}

// ---- 独立照合: 中央経線の北距 = k0 × 子午線弧長（数値積分・Simpson 10万分割）--------------------
{
	const a = 6378137, f = 1 / 298.257223563, e2 = f * (2 - f);
	const integrand = (phi) => a * (1 - e2) / Math.pow(1 - e2 * Math.sin(phi) ** 2, 1.5);
	const M = (latDeg) => {   // 弧長を Simpson で
		const n = 100000, h = latDeg * Math.PI / 180 / n;
		let s = integrand(0) + integrand(latDeg * Math.PI / 180);
		for (let i = 1; i < n; i++) s += integrand(i * h) * (i % 2 ? 4 : 2);
		return s * h / 3;
	};
	const p = projFor(32654);
	for (const lat of [15, 45, 70]) {
		const nKruger = p.forward([141, lat])[1];
		const nInt = 0.9996 * M(lat);
		ok(Math.abs(nKruger - nInt) < 1e-3, `中央経線 lat=${lat}: Krüger vs 数値積分 差 ${Math.abs(nKruger - nInt).toExponential(2)} m < 1mm`);
	}
	ok(Math.abs(p.forward([141, 35])[0] - 500000) < 1e-9, "中央経線 E=500000");
	ok(projFor(32754).forward([141, -35])[1] > 6e6, "南半球 FN=10,000,000 が効く");
}

// ---- 3857 の定数照合 -------------------------------------------------------------------------
{
	const m = projFor(3857);
	ok(Math.abs(m.forward([180, 0])[0] - 20037508.342789244) < 1e-6, "3857: forward(180,0) ＝ 20037508.342789244");
	const rt = m.inverse(m.forward([139.767125, 35.681236]));
	ok(Math.abs(rt[0] - 139.767125) < 1e-12 && Math.abs(rt[1] - 35.681236) < 1e-12, "3857 往復誤差 < 1e-12 deg");
}

// ---- warp: チェッカーボード合成で画素位置を検定 -----------------------------------------------
{
	// 源: 4326・32×32・1タイル・左半分赤/右半分青
	const tileW = 32, tileH = 32;
	const rgba = new Uint8ClampedArray(tileW * tileH * 4);
	for (let j = 0; j < tileH; j++) for (let i = 0; i < tileW; i++) {
		const o = (j * tileW + i) * 4;
		rgba[o] = i < 16 ? 255 : 0; rgba[o + 2] = i < 16 ? 0 : 255; rgba[o + 3] = 255;
	}
	const lv = { width: 32, height: 32, tileW, tileH, tilesX: 1, tilesY: 1 };
	const geo = { originX: 139, originY: 36, scaleX: 0.01, scaleY: 0.01 };   // 139..139.32E / 35.68..36N
	const geoL = geoAtLevel(geo, lv, lv);
	const p = projFor(4326);
	const out = warpRGBA({ lv, geoL, getTileRGBA: () => rgba, forward: p.forward }, lonlatTarget([139, 35.68, 139.32, 36], 32, 32));
	ok(out[(16 * 32 + 4) * 4] === 255 && out[(16 * 32 + 4) * 4 + 2] === 0, "warp: 左＝赤");
	ok(out[(16 * 32 + 28) * 4] === 0 && out[(16 * 32 + 28) * 4 + 2] === 255, "warp: 右＝青");
	ok(out[(16 * 32 + 4) * 4 + 3] === 255, "warp: alpha 255");
	// 範囲外ターゲット＝透明
	const out2 = warpRGBA({ lv, geoL, getTileRGBA: () => rgba, forward: p.forward }, lonlatTarget([150, 10, 151, 11], 8, 8));
	ok(out2.every((v, i) => i % 4 !== 3 || v === 0), "warp: 範囲外は透明");
}

console.log(fails ? `\n${fails} 件失敗` : "\n全件通過");
process.exit(fails ? 1 : 0);
