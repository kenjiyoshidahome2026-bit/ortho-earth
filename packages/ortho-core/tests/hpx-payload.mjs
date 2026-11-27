// t-hpx-payload: HEALPix のタイルを今の組み立て（build・buildings）に通す口（tilegrid.ts の hpxTileProj／hpxToTileFrame・tilepayload.ts の buildHpxTilePayload）の検定。
// 守るもの：(1) 枠の合わせ＝y が裏返り、輪の符号（外周が正）は変わらない (2) 焼き → 解読 → 枠 → 組み立てを通した頂点が、元の図形の場所（経緯度）に出る
//          (3) 塗りの面積が元と合う (4) 三角形の巻き（経緯度での符号）がメルカトルの経路と同じ (5) 隣のタイルと線の切り口が一致する
import { encodeHpxVt, hpxTileGeoms } from "../src/healpixvt.ts";
import { lonLatToNest, hpxNeighbors } from "../src/healpix.ts";
import { hpxTileProj, hpxToTileFrame, healpixGrid } from "../src/tilegrid.ts";
import { buildTilePayload, buildHpxTilePayload } from "../src/tilepayload.ts";
import { decodeMVT, signedArea } from "../src/decode.ts";
import { lonLatToTile } from "../src/tile.ts";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };
const style = { layers: [
	{ id: "water", type: "fill", "source-layer": "water", paint: { "fill-color": "#3366ff" } },
	{ id: "roads", type: "line", "source-layer": "roads", paint: { "line-color": "#000000", "line-width": 2 } },
], schema: { buildings: { layer: "buildings", defaultHeight: 10 } } };

// 東京の小さな池（穴あき）・道・建物を N12 に焼く
const C = [139.767, 35.681], d = 0.002;
const pond = { type: "polygon", coords: [
	[[C[0] - d, C[1] - d], [C[0] + d, C[1] - d], [C[0] + d, C[1] + d], [C[0] - d, C[1] + d], [C[0] - d, C[1] - d]],                       // 外周（反時計回り）
	[[C[0] - d / 2, C[1] - d / 2], [C[0] - d / 2, C[1] + d / 2], [C[0] + d / 2, C[1] + d / 2], [C[0] + d / 2, C[1] - d / 2], [C[0] - d / 2, C[1] - d / 2]],   // 穴（時計回り）
] };
const road = { type: "line", coords: [[[C[0] - 0.03, C[1] - 0.004], [C[0] + 0.03, C[1] + 0.006]]] };
const house = { type: "polygon", coords: [[[C[0] + 0.003, C[1] + 0.003], [C[0] + 0.0032, C[1] + 0.003], [C[0] + 0.0032, C[1] + 0.0032], [C[0] + 0.003, C[1] + 0.0032], [C[0] + 0.003, C[1] + 0.003]]] };
const ORDER = 12, tiles = new Map();
const add = (layer, g) => { for (const t of hpxTileGeoms(g, ORDER)) { const m = tiles.get(t.npix) ?? tiles.set(t.npix, {}).get(t.npix); (m[layer] ??= []).push({ type: g.type, parts: t.parts, props: { kind: layer } }); } };
add("water", pond); add("roads", road); add("buildings", house);
const mvtOf = npix => encodeHpxVt(Object.entries(tiles.get(npix)).map(([name, features]) => ({ name, features })));
const home = lonLatToNest(C[0], C[1], ORDER);
ok(tiles.has(home) && tiles.get(home).water && tiles.size >= 3, `試料：N12 の ${tiles.size} 枚（池は東京のタイルの中・道は数枚をまたぐ）`);

// (1) 枠の合わせ
{
	const raw = decodeMVT(mvtOf(home)), fr = hpxToTileFrame(decodeMVT(mvtOf(home)));
	const a = raw.water.features[0].geom, b = fr.water.features[0].geom;
	let flipped = true, s = 0, signs = true;
	const ys = g => { const o = []; for (let i = 1; i < g.coords.length; i += 2) o.push(g.coords[i]); return o.sort((p, q) => p - q).join(); };
	flipped = ys(b) === [...a.coords].filter((_, i) => i % 2).map(y => 4096 - y).sort((p, q) => p - q).join();
	for (const e of a.ends) { if (Math.sign(signedArea(a.coords, s, e)) !== Math.sign(signedArea(b.coords, s, e))) signs = false; s = e; }
	ok(flipped && signs && signedArea(b.coords, 0, b.ends[0]) > 0 && signedArea(b.coords, b.ends[0], b.ends[1]) < 0, "枠の合わせ：y は裏返る・輪の符号はそのまま（外周が正・穴が負＝MVT と同じ）");
	const la = raw.roads.features[0].geom, lb = fr.roads.features[0].geom;
	ok(la.coords[0] === lb.coords[0] && lb.coords[1] === 4096 - la.coords[1], "枠の合わせ：線は向きを変えない（y だけ）");
}

// 組み立て
const payloads = new Map();
for (const npix of tiles.keys()) payloads.set(npix, buildHpxTilePayload(hpxToTileFrame(decodeMVT(mvtOf(npix))), { order: ORDER, npix }, style, { bldMinZ: 14 }));
const P = payloads.get(home), fill = P.dl.ops.find(o => o.kind === "fill"), line = P.dl.ops.find(o => o.kind === "line");
const tri = (pos, idx) => { let a = 0; for (let i = 0; i < idx.length; i += 3) { const p = idx[i] * 2, q = idx[i + 1] * 2, r = idx[i + 2] * 2; a += ((pos[q] - pos[p]) * (pos[r + 1] - pos[p + 1]) - (pos[r] - pos[p]) * (pos[q + 1] - pos[p + 1])) / 2; } return a; };

// (2) 場所
{
	const [ox, oy] = P.origin, c = healpixGrid.center({ order: ORDER, npix: home });
	ok(ox === c[0] && oy === c[1] && P.z === 15, "原点＝タイルの中心・style の zoom＝15");
	let bad = 0; const eps = 4e-5;   // 4096 刻みの丸め（N12＝約 0.4 m/刻み）＋ Float32
	for (let i = 0; i < fill.pos.length; i += 2) { const lon = ox + fill.pos[i], lat = oy + fill.pos[i + 1]; if (Math.abs(lon - C[0]) > d + eps || Math.abs(lat - C[1]) > d + eps) bad++; }
	ok(fill && fill.pos.length >= 16 && bad === 0, `塗りの頂点 ${fill.pos.length / 2} 個が池の矩形の中（経緯度）`);
	let off = 0; const k = (road.coords[0][1][1] - road.coords[0][0][1]) / (road.coords[0][1][0] - road.coords[0][0][0]);
	for (let i = 0; i < line.P1.length; i += 2) for (const A of [line.P1, line.P2]) { const lon = ox + A[i], lat = oy + A[i + 1]; if (Math.abs(lat - (road.coords[0][0][1] + k * (lon - road.coords[0][0][0]))) > 3e-5) off++; }
	ok(line && line.P1.length >= 2 && off === 0, `線の頂点が道の直線の上（${line.P1.length / 2} 線分）`);
}
// (3) 面積
{
	const want = (2 * d) ** 2 - d ** 2; let got = 0, nt = 0; for (const p of payloads.values()) { const f = p.dl.ops.find(o => o.kind === "fill"); if (f) { got += tri(f.pos, f.idx); nt++; } } got = Math.abs(got);
	ok(Math.abs(got - want) / want < 2e-3, `塗りの面積（${nt} 枚の合計・経緯度の平面で）＝外周 − 穴（比 ${(got / want).toFixed(5)}）`);
}
// (4) 巻き：同じ池をメルカトルのタイルとして組み立てた時と、経緯度での三角形の符号が同じ
{
	const z = 15, [tx, ty] = lonLatToTile(C[0], C[1], z), n = 1 << z, E = 4096;
	const toTile = ([lon, lat]) => [Math.round(((lon + 180) / 360 * n - tx) * E), Math.round(((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * n - ty) * E)];
	const merc = decodeMVT(encodeHpxVt([{ name: "water", features: [{ type: "polygon", parts: pond.coords.map(r => r.slice(0, -1).map(toTile).reverse()), props: {} }] }]));   // MVT の約束＝外周が正（y 下向きの枠で）＝経緯度の向きの逆順
	const g = merc.water.features[0].geom;
	const M = buildTilePayload(merc, { z, x: tx, y: ty }, style), mf = M.dl.ops.find(o => o.kind === "fill");
	const sM = Math.sign(tri(mf.pos, mf.idx)), sH = Math.sign(tri(fill.pos, fill.idx));
	ok(signedArea(g.coords, 0, g.ends[0]) > 0 && sM !== 0 && sM === sH, `三角形の巻き（経緯度での符号）がメルカトルの経路と同じ（${sM > 0 ? "反時計回り" : "時計回り"}）`);
	const bM = buildTilePayload(decodeMVT(encodeHpxVt([{ name: "buildings", features: [{ type: "polygon", parts: house.coords.map(r => r.slice(0, -1).map(toTile).reverse()), props: {} }] }])), { z, x: tx, y: ty }, style).buildings;
	const bH = [...payloads.values()].map(p => p.buildings).find(Boolean);
	ok(bM && bH && bH.pos.length === bM.pos.length && bH.pos.length > 0, `建物が立つ（頂点 ${bH?.pos.length / 3} 個＝メルカトルの経路と同じ数）`);
	let same = bM && bH && bH.shade.length === bM.shade.length; const sort = a => [...a].map(v => Math.round(v * 20)).sort((p, q) => p - q).join();
	ok(same && sort(bH.shade) === sort(bM.shade), "建物の面の陰影の内訳がメルカトルの経路と同じ（壁の表裏が揃っている）");
}
// (5) 継ぎ目：隣のタイルの線の端点が、経緯度で一致する
{
	const ends = new Map();   // npix → [[lon, lat]…]（線分の端点・絶対）
	for (const [npix, p] of payloads) { const l = p.dl.ops.find(o => o.kind === "line"); if (!l) continue; const a = []; for (let i = 0; i < l.P1.length; i += 2) a.push([p.origin[0] + l.P1[i], p.origin[1] + l.P1[i + 1]], [p.origin[0] + l.P2[i], p.origin[1] + l.P2[i + 1]]); ends.set(npix, a); }
	let pairs = 0, joined = 0;
	for (const [npix, a] of ends) for (const nb of hpxNeighbors(ORDER, npix)) { if (nb <= npix || !ends.has(nb)) continue; pairs++; if (a.some(p => ends.get(nb).some(q => Math.hypot(p[0] - q[0], p[1] - q[1]) < 2e-6))) joined++; }
	ok(ends.size >= 3 && pairs >= 2 && joined >= ends.size - 1, `道は ${ends.size} 枚をまたぎ、隣り合うタイルの切り口が一致（${joined} か所・2e-6°＝約 0.2 m）`);
}
{
	const pj = hpxTileProj({ order: 12, npix: home });
	ok(Math.abs(pj.sideM - 1591.7) < 1 && Math.abs(pj.zEq - 14.62) < 0.01 && pj.key === `h12/${home}`, `N12 の辺 ${pj.sideM.toFixed(1)} m・メルカトルの z ${pj.zEq.toFixed(2)} 相当`);
}
console.log(fails ? `${fails} failed` : "all passed"); process.exit(fails ? 1 : 0);
