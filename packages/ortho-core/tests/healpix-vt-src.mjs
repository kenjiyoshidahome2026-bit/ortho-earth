// t-healpix-vt-src: HEALPix のベクタタイルの読み口（src/healpix-vt-src.ts）の検定。
// 焼き（encodeHpxVt）→ 束ね（writePMTiles・z=Norder, x=ix, y=iy）→ Range で応える偽の鯖 → 読み口、を通す。
// 守るもの：(Norder, npix) で引いた中身が焼いた物と同じ／メルカトルの範囲の門に落とされない／無い所は空／鯖が落ちても次に取り直す
import { encodeHpxVt, hpxTileGeoms, hpxFaceWindow } from "../src/healpixvt.ts";
import { cellOf, lonLatToNest, hpxParent } from "../src/healpix.ts";
import { createHpxVtSource, checkHpxVtIndex } from "../src/healpix-vt-src.ts";
import { writePMTiles } from "../../geopbf/src/convert/pmtiles.ts";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };
globalThis.self ??= globalThis;

// 東京と那覇と札幌の道 1 本ずつを Norder 6〜9 に焼く（どれも面 1）
const roads = { tokyo: [[139.70, 35.66], [139.78, 35.70]], naha: [[127.66, 26.20], [127.72, 26.24]], sapporo: [[141.30, 43.04], [141.38, 43.08]] };
const baked = new Map();   // "order/npix" → [{name, parts}]
for (let order = 6; order <= 9; order++) for (const [name, coords] of Object.entries(roads))
	for (const t of hpxTileGeoms({ type: "line", coords: [coords] }, order)) { const k = `${t.order}/${t.npix}`; (baked.get(k) ?? baked.set(k, []).get(k)).push({ name, parts: t.parts }); }
const tiles = [], faces = new Set();
for (const [k, fs] of baked) {
	const [order, npix] = k.split("/").map(Number), c = cellOf(order, npix); faces.add(c.face);
	tiles.push({ z: order, x: c.ix, y: c.iy, data: encodeHpxVt([{ name: "roads", features: fs.map(f => ({ type: "line", parts: f.parts, props: { name: f.name, kind: "primary" } })) }]) });
}
ok(faces.size === 1 && faces.has(1), "試料は面 1 だけ（日本）");
const bounds = hpxFaceWindow(1);
const pm = await writePMTiles(tiles, { name: "t", vector_layers: [{ id: "roads" }], healpix: { scheme: "healpix-face", face: 1 } }, { tileCompression: "gzip", internalCompression: "gzip", tileType: 1, minZoom: 6, maxZoom: 9, bounds, center: [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2, 6] });
const index = { made: "2026-11-27T00:00:00Z", source: "test", layers: ["roads"], minOrder: 6, maxOrder: 9, extent: 4096, faces: [{ face: 1, file: "face1.pmtiles", tiles: tiles.length, bytes: pm.length }], tiles: tiles.length, bytes: pm.length };

// 偽の鯖：index.json と Range つきの face1.pmtiles
const API = "https://api.test";
let down = false, indexHits = 0, whole = 0;
const rangeOf = init => { const h = init?.headers instanceof Headers ? init.headers.get("range") : (init?.headers?.Range ?? init?.headers?.range ?? ""); return /bytes=(\d+)-(\d+)/.exec(h || ""); };
globalThis.fetch = async (u, init) => {
	const url = String(u?.url ?? u);
	if (url === `${API}/bucket/GIS/hpx/osm/index.json`) { indexHits++; return down ? new Response("x", { status: 503 }) : Response.json(index); }
	if (url === `${API}/bucket/GIS/hpx/osm/face1.pmtiles`) {
		const r = rangeOf(init ?? u); if (!r) whole++;
		const body = r ? pm.subarray(+r[1], Math.min(pm.length, +r[2] + 1)) : pm;
		return new Response(body, { status: r ? 206 : 200, headers: { "Content-Length": String(body.byteLength), ETag: '"e1"', ...(r ? { "Content-Range": `bytes ${r[1]}-${+r[1] + body.byteLength - 1}/${pm.length}` } : {}) } });
	}
	return new Response("no", { status: 404 });
};

const src = createHpxVtSource({ apiUrl: API + "/" });
down = true;
ok(await src.index().then(() => false, e => /HTTP 503/.test(e.message)), "目録が取れない＝投げる");
down = false;
const idx = await src.index();
ok(idx.minOrder === 6 && idx.maxOrder === 9 && idx.faces.length === 1 && indexHits === 2, "失敗は覚えない＝次に取り直す");
await src.index(); ok(indexHits === 2, "目録は 1 回だけ取る");

// 焼いた全タイルが (Norder, npix) で引けて、中身が同じ
{
	let bad = 0, n = 0;
	for (const [k, fs] of baked) {
		const [order, npix] = k.split("/").map(Number), t = await src.tile(order, npix);
		const got = t.roads?.features ?? []; n++;
		if (t.__empty || got.length !== fs.length || got.map(f => f.props.name).sort().join() !== fs.map(f => f.name).sort().join()) bad++;
	}
	ok(bad === 0 && n === baked.size && n >= 12, `焼いた ${n} 枚が番地で引けて、地物が同じ（メルカトルの門に落とされない）`);
}
// 東京の点を含む Norder 9 のタイル＝東京の道だけ・頂点はタイルの中（0..4096）
{
	const npix = lonLatToNest(139.74, 35.68, 9), t = await src.tile(9, npix), f = t.roads?.features ?? [];
	ok(f.length === 1 && f[0].props.name === "tokyo" && f[0].props.kind === "primary", "東京のタイルには東京の道だけ");
	const raw = await src.raw(9, npix);
	ok(raw instanceof Uint8Array && raw.length > 10 && raw[0] !== 0x1f, "raw＝伸ばした後の MVT（gzip のままではない）");
	ok(Object.keys(await src.tile(9, npix, null, new Set(["nothing"]))).length === 0, "need＝要る層だけ");
}
// 無い所
{
	const sea = lonLatToNest(150, 30, 9), other = lonLatToNest(0, 0, 9);
	ok((await src.tile(9, sea)).__empty === true && await src.raw(9, sea) === null, "面の中で何も無い所＝空");
	ok(cellOf(9, other).face !== 1 && (await src.tile(9, other)).__empty === true, "面のファイルが無い所＝空（取りに行かない）");
	ok(await src.raw(5, lonLatToNest(139.74, 35.68, 5)) === null && await src.raw(10, lonLatToNest(139.74, 35.68, 10)) === null, "段が範囲の外＝null");
}
// nearest：最大の段より細かい頼み＝最大の段の祖先
{
	const n12 = lonLatToNest(139.74, 35.68, 12), n9 = hpxParent(hpxParent(hpxParent(n12)));
	const t = await src.nearest(12, n12);
	ok(t && t.order === 9 && t.npix === n9 && t.up === 3 && t.data.roads.features[0].props.name === "tokyo", "nearest：N12 の頼み → N9 の祖先（3 段上）");
	const same = await src.nearest(8, lonLatToNest(127.69, 26.22, 8));
	ok(same && same.up === 0 && same.order === 8 && same.data.roads.features[0].props.name === "naha", "nearest：範囲の中はそのまま");
	ok(await src.nearest(12, lonLatToNest(150, 30, 12)) === null && await src.nearest(5, lonLatToNest(139.74, 35.68, 5)) === null, "nearest：無い所・粗すぎる段＝null");
}
ok(whole === 0, "アーカイブを丸ごと取りに行かない（全部 Range）");
// 目録の検査
{
	const bad = j => { try { checkHpxVtIndex(j); return false; } catch { return true; } };
	ok(bad(null) && bad({ minOrder: 9, maxOrder: 6, faces: [] }) && bad({ minOrder: 4, maxOrder: 12, faces: [{ face: 12, file: "face12.pmtiles" }] }) && bad({ minOrder: 4, maxOrder: 12, faces: [{ face: 1, file: "../x.pmtiles" }] }), "壊れた目録は投げる（面の番号・ファイル名）");
	ok(checkHpxVtIndex({ minOrder: 4, maxOrder: 12, faces: [] }).extent === 4096, "extent の既定＝4096");
}
console.log(fails ? `${fails} failed` : "all passed"); process.exit(fails ? 1 : 0);
