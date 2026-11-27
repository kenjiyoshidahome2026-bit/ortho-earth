// t-healpix-vt-scene: HEALPix のタイル数枚 → 結合済みの scene（src/healpix-vt-scene.ts・?hpxvt= の中身）の検定。
// 焼き → 束ね → Range の偽の鯖 → loadHpxVtScene。守るもの：真ん中と隣（9 枚）を取る／層の順と li の帯／結合後の頂点が元の場所（経緯度）／無い所は空の scene
import { encodeHpxVt, hpxTileGeoms } from "../src/healpixvt.ts";
import { cellOf, lonLatToNest, hpxNeighbors } from "../src/healpix.ts";
import { loadHpxVtScene, hpxSceneBuffers, HPX_OSM_TRIAL_STYLE } from "../src/healpix-vt-scene.ts";
import { healpixGrid } from "../src/tilegrid.ts";
import { writePMTiles } from "../../geopbf/src/convert/pmtiles.ts";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };
globalThis.self ??= globalThis;
const C = [139.767, 35.681], ORDER = 11, LI0 = 1 << 20;
// 東西に長い幹線（9 枚の端まで届く）・南北の細い道・池・建物
const feats = [
	["roads", { type: "line", coords: [[[C[0] - 0.06, C[1] - 0.01], [C[0] + 0.06, C[1] + 0.012]]] }, { kind: "major_road" }],
	["roads", { type: "line", coords: [[[C[0] + 0.004, C[1] - 0.05], [C[0] - 0.003, C[1] + 0.05]]] }, { kind: "minor_road" }],
	["roads", { type: "line", coords: [[[C[0] - 0.05, C[1] + 0.02], [C[0] + 0.05, C[1] + 0.021]]] }, { kind: "rail" }],
	["water", { type: "polygon", coords: [[[C[0] - 0.004, C[1] - 0.004], [C[0] + 0.004, C[1] - 0.004], [C[0] + 0.004, C[1] + 0.004], [C[0] - 0.004, C[1] + 0.004], [C[0] - 0.004, C[1] - 0.004]]] }, { kind: "water" }],
	["water", { type: "line", coords: [[[C[0] - 0.02, C[1] - 0.02], [C[0] + 0.02, C[1] - 0.018]]] }, { kind: "river" }],
	["buildings", { type: "polygon", coords: [[[C[0] + 0.01, C[1] + 0.01], [C[0] + 0.0103, C[1] + 0.01], [C[0] + 0.0103, C[1] + 0.0103], [C[0] + 0.01, C[1] + 0.0103], [C[0] + 0.01, C[1] + 0.01]]] }, {}],
];
const baked = new Map();
for (const [layer, g, props] of feats) for (const t of hpxTileGeoms(g, ORDER)) { const m = baked.get(t.npix) ?? baked.set(t.npix, {}).get(t.npix); (m[layer] ??= []).push({ type: g.type, parts: t.parts, props }); }
const tiles = [...baked].map(([npix, m]) => { const c = cellOf(ORDER, npix); return { z: ORDER, x: c.ix, y: c.iy, data: encodeHpxVt(Object.entries(m).map(([name, features]) => ({ name, features }))) }; });
const pm = await writePMTiles(tiles, { name: "t" }, { tileCompression: "gzip", internalCompression: "gzip", tileType: 1, minZoom: ORDER, maxZoom: ORDER, bounds: [-180, -85, 180, 85], center: [0, 0, ORDER] });
const index = { minOrder: ORDER, maxOrder: ORDER, extent: 4096, layers: ["water", "roads", "buildings"], faces: [{ face: 1, file: "face1.pmtiles", tiles: tiles.length, bytes: pm.length }] };
globalThis.fetch = async (u, init) => {
	const url = String(u?.url ?? u);
	if (url.endsWith("/index.json")) return Response.json(index);
	const h = init?.headers instanceof Headers ? init.headers.get("range") : (init?.headers?.Range ?? init?.headers?.range ?? ""), r = /bytes=(\d+)-(\d+)/.exec(h || "");
	const body = r ? pm.subarray(+r[1], Math.min(pm.length, +r[2] + 1)) : pm;
	return new Response(body, { status: r ? 206 : 200, headers: { "Content-Length": String(body.byteLength), ETag: '"e"', ...(r ? { "Content-Range": `bytes ${r[1]}-${+r[1] + body.byteLength - 1}/${pm.length}` } : {}) } });
};

const r = await loadHpxVtScene({ apiUrl: "https://api.test", order: 9, lon: C[0], lat: C[1], li0: LI0 });
const home = lonLatToNest(C[0], C[1], ORDER), want9 = new Set([home, ...hpxNeighbors(ORDER, home)]);
ok(r.order === ORDER && r.tiles.length === 9 && r.tiles.every(t => want9.has(t.npix)) && r.found >= 5 && r.found <= 9, `頼んだ段（9）は目録の範囲（${ORDER}）へ寄せる・真ん中＋隣の 9 枚のうち ${r.found} 枚に中身`);
const s = r.scene, c = healpixGrid.center({ order: ORDER, npix: home });
ok(s.origin[0] === c[0] && s.origin[1] === c[1] && s.buildings === null, "原点＝真ん中のタイルの中心・建物の押し出しは無し（塗りで出す）");
const ids = s.layers.map(L => HPX_OSM_TRIAL_STYLE.layers[L.li - LI0]?.id), lis = s.layers.map(L => L.li);
ok(s.layers.length >= 6 && lis.every(l => l >= LI0 && l < LI0 + HPX_OSM_TRIAL_STYLE.layers.length) && lis.join() === [...lis].sort((a, b) => a - b).join(), `層は li の帯（li0＋style の添字）で昇順（${ids.join(", ")}）`);
ok(["hpx-water", "hpx-waterway", "hpx-buildings", "hpx-roads-minor", "hpx-roads-major", "hpx-rail"].every(id => ids.includes(id)) && !ids.includes("hpx-roads-highway"), "池・川・建物・細い道・幹線・鉄道がそれぞれの層に出る（無い種別の層は出ない）");
// 場所：幹線の全線分が元の直線の上・9 枚の範囲で途切れない
{
	const L = s.layers.find(l => HPX_OSM_TRIAL_STYLE.layers[l.li - LI0].id === "hpx-roads-major"), [ox, oy] = s.origin, a = feats[0][1].coords[0], k = (a[1][1] - a[0][1]) / (a[1][0] - a[0][0]);
	let off = 0, len = 0; const ends = [];
	for (let i = 0; i < L.P1.length; i += 2) { const x1 = ox + L.P1[i], y1 = oy + L.P1[i + 1], x2 = ox + L.P2[i], y2 = oy + L.P2[i + 1]; for (const [x, y] of [[x1, y1], [x2, y2]]) if (Math.abs(y - (a[0][1] + k * (x - a[0][0]))) > 5e-5) off++; len += Math.abs(x2 - x1); ends.push([Math.min(x1, x2), Math.max(x1, x2)]); }
	ends.sort((p, q) => p[0] - q[0]); let gap = 0; for (let i = 1; i < ends.length; i++) gap = Math.max(gap, ends[i][0] - ends[i - 1][1]);
	ok(off === 0 && L.P1.length / 2 >= 3 && gap < 5e-5 && Math.abs(len - (ends[ends.length - 1][1] - ends[0][0])) < 2e-4, `幹線：${L.P1.length / 2} 線分が元の直線の上・タイルの境で途切れも重なりも無い（最大の隙間 ${gap.toExponential(1)}°）`);
	const F = s.layers.find(l => HPX_OSM_TRIAL_STYLE.layers[l.li - LI0].id === "hpx-water"); let bad = 0, area = 0;
	for (let i = 0; i < F.pos.length; i += 2) if (Math.abs(F.pos[i] + ox - C[0]) > 0.00405 || Math.abs(F.pos[i + 1] + oy - C[1]) > 0.00405) bad++;
	for (let i = 0; i < F.idx.length; i += 3) { const p = F.idx[i] * 2, q = F.idx[i + 1] * 2, t = F.idx[i + 2] * 2; area += Math.abs((F.pos[q] - F.pos[p]) * (F.pos[t + 1] - F.pos[p + 1]) - (F.pos[t] - F.pos[p]) * (F.pos[q + 1] - F.pos[p + 1])) / 2; }
	ok(bad === 0 && Math.abs(area / 0.008 ** 2 - 1) < 3e-3, `池：頂点は元の矩形の中・面積の比 ${(area / 0.008 ** 2).toFixed(5)}（タイルをまたいでも重なり・抜け無し）`);
}
{
	const b = hpxSceneBuffers(s), n = s.layers.reduce((a, L) => a + Object.values(L).filter(v => ArrayBuffer.isView(v)).length, 0);
	ok(b.length === n && b.every(x => x instanceof ArrayBuffer) && new Set(b).size === b.length, `transfer する ArrayBuffer ${b.length} 本（重複なし）`);
	const one = await loadHpxVtScene({ apiUrl: "https://api.test", order: ORDER, lon: C[0], lat: C[1], neighbors: false });
	ok(one.tiles.length === 1 && one.found === 1 && one.scene.layers.every(L => L.li < 100), "neighbors:false＝真ん中の 1 枚だけ・li0 を省けば style の添字のまま");
	const none = await loadHpxVtScene({ apiUrl: "https://api.test", order: ORDER, lon: 131, lat: 33 });
	ok(none.found === 0 && none.scene.layers.length === 0, "何も無い所＝空の scene（落ちない）");
}
console.log(fails ? `${fails} failed` : "all passed"); process.exit(fails ? 1 : 0);
