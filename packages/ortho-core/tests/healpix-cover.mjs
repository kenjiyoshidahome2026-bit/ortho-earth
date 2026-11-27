// t-healpix-cover: HEALPix のタイル選び（src/healpix-cover.ts）の検定。
// 守るもの：選んだタイルは重ならない（祖先と子孫が同居しない）／画面に映る地面の点はどれかのタイルに入る（抜け無し）／近い所ほど細かい段／枚数がメルカトルの選抜と同じ桁／sticky でばたつかない
import { selectHpxLOD } from "../src/healpix-cover.ts";
import { selectLOD } from "../src/tilecover.ts";
import { cameraState, unproject } from "../src/camera.ts";
import { lonLatToNest, hpxId } from "../src/healpix.ts";
import { healpixGrid } from "../src/tilegrid.ts";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };
let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const W = 1600, H = 1000, OPT = { minOrder: 0, maxOrder: 12, tilePx: 560 };
const cams = [
	["東京・真上・z15", { center: [139.767, 35.681], zoom: 15, pitch: 0, bearing: 0 }],
	["東京・真上・z11", { center: [139.767, 35.681], zoom: 11, pitch: 0, bearing: 0 }],
	["東京・傾き 60°・z14", { center: [139.767, 35.681], zoom: 14, pitch: 1.05, bearing: 0.6 }],
	["日本全体・z5", { center: [137, 37], zoom: 5, pitch: 0, bearing: 0 }],
	["地球全体・z1.5", { center: [137, 20], zoom: 1.5, pitch: 0, bearing: 0 }],
	["日付変更線・z7", { center: [179.9, -17], zoom: 7, pitch: 0.4, bearing: 2 }],
	["北極・z4", { center: [30, 89], zoom: 4, pitch: 0, bearing: 0 }],
	["面の継ぎ目（経度 135°・赤道）・z9", { center: [135, 0], zoom: 9, pitch: 0.8, bearing: 1 }],
];
for (const [name, cam] of cams) {
	const sel = selectHpxLOD(cam, W, H, OPT), st = cameraState(cam, W, H);
	// 重なりなし
	const ids = new Set(sel.map(t => hpxId(t.order, t.npix))); let overlap = 0;
	for (const t of sel) for (let o = t.order - 1, n = Math.floor(t.npix / 4); o >= 0; o--, n = Math.floor(n / 4)) if (ids.has(hpxId(o, n))) overlap++;
	// 抜け無し：画面の乱数の点 2000 個
	let miss = 0, hit = 0;
	for (let i = 0; i < 2000; i++) { const ll = unproject(st, rnd() * W, rnd() * H); if (!ll) continue; hit++; let found = false; for (let o = 0; o <= 12 && !found; o++) found = ids.has(hpxId(o, lonLatToNest(ll[0], ll[1], o))); if (!found) miss++; }
	const orders = sel.map(t => t.order), lo = Math.min(...orders), hi = Math.max(...orders), merc = selectLOD(cam, W, H, { minZ: 0, maxZ: 16, tilePx: 560 }).length;
	const home = sel.find(t => t.npix === lonLatToNest(cam.center[0], cam.center[1], t.order));
	const why = [sel.length > 0, ids.size === sel.length, overlap === 0, miss === 0, hit > 40, !!home];
	ok(why.every(Boolean), `${name}：${sel.length} 枚（N${lo}〜N${hi}・メルカトルの選抜は ${merc} 枚）・重なり 0・抜け 0／${hit} 点・注視点は N${home?.order}${why.every(Boolean) ? "" : " " + why.join()}`);
	if (sel.length > merc * 4 + 40 || sel.length > 400) { console.error("  ✗ 枚数が多すぎる"); fails++; }
}
{
	// 段は zoom に合う：真上の z15 → 注視点は N12（zoom − 3）・z11 → N8 前後
	const at = z => { const cam = { center: [139.767, 35.681], zoom: z, pitch: 0, bearing: 0 }; return selectHpxLOD(cam, W, H, OPT).find(t => t.npix === lonLatToNest(139.767, 35.681, t.order)).order; };
	const o15 = at(15), o11 = at(11), o7 = at(7);
	ok(o15 === 12 && Math.abs(o11 - 8) <= 1 && Math.abs(o7 - 4) <= 1 && healpixGrid.styleZoom({ order: o11, npix: 0 }) >= 10, `注視点の段：z15 → N${o15}・z11 → N${o11}・z7 → N${o7}（zoom − 3 の前後）`);
	// 傾けると遠くは粗い
	const tilt = selectHpxLOD({ center: [139.767, 35.681], zoom: 14, pitch: 1.2, bearing: 0 }, W, H, OPT), os = tilt.map(t => t.order);
	ok(Math.max(...os) - Math.min(...os) >= 2, `傾き 69°：近くは N${Math.max(...os)}・遠くは N${Math.min(...os)}`);
	// 範囲：maxOrder で止まる・minOrder より粗くならない
	const cl = selectHpxLOD({ center: [139.767, 35.681], zoom: 15, pitch: 0, bearing: 0 }, W, H, { minOrder: 4, maxOrder: 9 });
	ok(cl.every(t => t.order >= 4 && t.order <= 9) && cl.some(t => t.order === 9), "段の範囲（minOrder〜maxOrder）を守る");
	ok(selectHpxLOD({ center: [139.767, 35.681], zoom: 15, pitch: 0, bearing: 0 }, W, H, { ...OPT, maxTiles: 6 }).length <= 6, "maxTiles で頭打ち");
}
{
	// sticky：割る境のすぐ下まで引いても、前回割ったタイルは割ったまま
	const key = s => s.map(t => `${t.order}/${t.npix}`).sort().join();
	let flipZ = 0;
	for (let z = 12; z > 10; z -= 0.01) { const a = selectHpxLOD({ center: [139.767, 35.681], zoom: z, pitch: 0, bearing: 0 }, W, H, OPT), b = selectHpxLOD({ center: [139.767, 35.681], zoom: z - 0.01, pitch: 0, bearing: 0 }, W, H, OPT); if (Math.max(...a.map(t => t.order)) !== Math.max(...b.map(t => t.order))) { flipZ = z; break; } }
	const cam = { center: [139.767, 35.681], zoom: flipZ - 0.01, pitch: 0, bearing: 0 }, split = new Set();
	selectHpxLOD({ ...cam, zoom: flipZ }, W, H, { ...OPT, splitOut: split });
	const plain = selectHpxLOD(cam, W, H, OPT), held = selectHpxLOD(cam, W, H, { ...OPT, sticky: split });
	ok(flipZ > 0 && split.size > 0 && key(plain) !== key(held) && Math.max(...held.map(t => t.order)) > Math.max(...plain.map(t => t.order)), `sticky：段が切り替わる zoom（${flipZ.toFixed(2)}）のすぐ下でも、割ったタイルは割ったまま`);
	ok(selectHpxLOD({ center: [0, 0], zoom: 3, pitch: 0, bearing: 0 }, 0, 0, OPT).length >= 0, "画面の大きさ 0 でも落ちない");
}
console.log(fails ? `${fails} failed` : "all passed"); process.exit(fails ? 1 : 0);
