// MLT プラグイン（src/mlt.js・#88）の検定。node packages/tile-formats/tests/t-mlt.mjs
//  ① 同じタイルを MVT と MLT で解いて同じ中間表現になるか：検定の試料（globe の t-mlcompat 用 MVT）を encodeTile で MLT に変換して decodeTile(…,"mvt") と
//     decodeTile(…,"mlt") を比べる（層名・件数・型・id・props・座標・ends・polygons() の外周／穴の分け方）
//  ② 参照実装（Java）が書いた実物：OpenMapTiles の z0 タイル（fixtures/omt）＝MVT と MLT が同じ地物になるか（struct の平たいキー・FSST・三角形分割済み・64 ビット id）
//  ③ 仕様の合成試料（fixtures/synthetic・.json＝期待の論理表現）：Morton／辞書の頂点・多重幾何・穴・面の向きの正規化・int64／uint64・struct のキー名の変種
//  ④ need（参照する層だけ）・1 層の失敗はその層だけ空・空タイル・MAP（入れ子）の属性が expr で引ける・登録簿経由（loadTileFormat → decodeTile）
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { register } from "node:module";
register("../src/node-hook.mjs", import.meta.url);
const { decodeMLT } = await import("../src/mlt.js");
const { decodeMVT, polygons, decodeTile, loadTileFormat, fetchMVT } = await import("@ortho-earth/core/decode");
const { hasTileFormat, tileFormatOfPmtilesType, tileFormatReady } = await import("@ortho-earth/core/tileformat");
const { evalExpr } = await import("@ortho-earth/core/expr");
const { encodeTile } = await import("@maplibre/mlt");
const { toMLTLayers, mvtToMLT, writePMTiles } = await import("../scripts/mvt2mlt.mjs");
const { classifyRings } = await import("../../globe/src/vtmesh.js");   // 相対の巻き方で外周と穴を分ける（globe の押し出し・描く層）

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log("  ✔", name); };
const FX = p => fileURLToPath(new URL("./fixtures/" + p, import.meta.url));
const read = p => new Uint8Array(readFileSync(p));
const warns = [];
const origWarn = console.warn; console.warn = (...a) => warns.push(a.join(" "));

// 中間表現の比較（層名・件数・型・id・props・座標・ends・polygons() の分け方）
const plain = v => JSON.parse(JSON.stringify(v, (k, x) => typeof x === "bigint" ? Number(x) : x));
function sameLayers(A, B, { where = "" } = {}) {
	assert.deepEqual(Object.keys(A).sort(), Object.keys(B).sort(), `${where} layer names`);
	for (const name of Object.keys(A)) {
		const a = A[name], b = B[name];
		assert.equal(a.extent, b.extent, `${where}/${name} extent`);
		assert.equal(a.features.length, b.features.length, `${where}/${name} feature count`);
		for (let i = 0; i < a.features.length; i++) {
			const f = a.features[i], g = b.features[i], at = `${where}/${name}#${i}`;
			assert.equal(f.type, g.type, `${at} type`);
			assert.equal(f.id, g.id, `${at} id`);
			assert.deepEqual(plain(f.props), plain(g.props), `${at} props`);
			assert.deepEqual(Array.from(f.geom.coords), Array.from(g.geom.coords), `${at} coords`);
			assert.deepEqual(f.geom.ends, g.geom.ends, `${at} ends`);
			if (f.type === "Polygon") {
				const pa = polygons(f.geom), pb = polygons(g.geom);
				assert.deepEqual(pa.map(([flat, holes]) => [flat.length, holes]), pb.map(([flat, holes]) => [flat.length, holes]), `${at} polygons()`);
			}
		}
	}
}
const ringsOf = geom => { const out = []; let s = 0; for (const e of geom.ends) { out.push(Array.from(geom.coords.subarray(s, e))); s = e; } return out; };
const area = ring => { let s = 0; for (let i = 0; i + 1 < ring.length; i += 2) { const j = i + 2 < ring.length ? i + 2 : 0; s += ring[i] * ring[j + 1] - ring[j] * ring[i + 1]; } return s / 2; };

// ── ① 試料の MVT → MLT（encodeTile）→ 同じ中間表現 ──
const VT = fileURLToPath(new URL("../../globe/tests/fixtures/mlcompat/vt/", import.meta.url));
const vtTiles = ["13/7281/3379", "14/14562/6758", "14/14562/6759", "14/14563/6758", "14/14563/6759"].map(k => ({ k, mvt: read(VT + k + ".pbf") }));
await t("試料の MVT を MLT に変換して同じ中間表現（4 層・面／線／点・穴・Feature.id・props）", () => {
	for (const { k, mvt } of vtTiles) {
		const mlt = mvtToMLT(mvt);
		assert.ok(mlt.length > 0);
		sameLayers(decodeMVT(mvt), decodeMLT(mlt), { where: k });
	}
	const L = decodeMLT(mvtToMLT(vtTiles[0].mvt));
	assert.deepEqual(Object.keys(L).sort(), ["building", "landuse", "poi", "road"]);
	const court = L.building.features.find(f => f.props.name === "court");
	assert.equal(court.id, 3); assert.equal(court.props.render_height, 50);
	// 中庭＝穴 1。試料の巻き方は MVT の規約と逆（外周が負）＝globe の classifyRings（最初の輪に対する相対の巻き方）で見る。core の polygons() の答えは MVT と同じ（上の sameLayers）
	const cr = classifyRings(court.geom); assert.equal(cr.length, 1); assert.equal(cr[0].length, 2);
	assert.equal(L.building.features.find(f => f.props.name === "hidden").props.hide_3d, true);
});
await t("need＝参照する層だけ（他の層はブロックの頭で捨てる）", () => {
	const mlt = mvtToMLT(vtTiles[0].mvt);
	assert.deepEqual(Object.keys(decodeMLT(mlt, new Set(["road"]))), ["road"]);
	assert.deepEqual(Object.keys(decodeMLT(mlt, new Set(["poi", "landuse"]))).sort(), ["landuse", "poi"]);
	assert.deepEqual(Object.keys(decodeMLT(mlt, new Set(["nothing"]))), []);
	assert.deepEqual(decodeMLT(new Uint8Array(0)), {});
});
await t("登録簿経由：#tile-formats の差し替え先（register.js）→ loadTileFormat → decodeTile(…,\"mlt\")・fetchMVT の本体経路・PMTiles tileType 6", async () => {
	await import("../src/register.js");
	assert.equal(hasTileFormat("mlt"), true); assert.equal(tileFormatOfPmtilesType(6), "mlt"); assert.equal(tileFormatReady("mlt"), false);
	assert.throws(() => decodeTile(new Uint8Array(0), null, "mlt"), /not loaded yet/);
	await loadTileFormat("mlt");
	assert.equal(tileFormatReady("mlt"), true);
	const mlt = mvtToMLT(vtTiles[1].mvt);
	sameLayers(decodeTile(mlt, null, "mlt"), decodeMVT(vtTiles[1].mvt), { where: "registry" });
	sameLayers(await fetchMVT("x", null, new Set(["building"]), null, mlt.buffer.slice(mlt.byteOffset, mlt.byteOffset + mlt.byteLength), "mlt"), decodeMVT(vtTiles[1].mvt, new Set(["building"])), { where: "fetchMVT" });
	// PMTiles（tileType 6）＝ヘッダの申告で mlt として解ける（pmtiles-src の tileTypeName＝登録簿の pmtilesType）
	const { pmtilesInfo, fetchPMTiles } = await import("../../ortho-core/src/pmtiles-src.js");   // 公開面に無い（index は GL まで抱える）＝相対で（同じ実体＝登録簿は 1 つ）
	const pm = await writePMTiles(null, vtTiles.map(({ k, mvt }) => { const [z, x, y] = k.split("/").map(Number); return { z, x, y, buf: mvtToMLT(mvt) }; }), { tileType: 6, metadata: { name: "t" } });
	globalThis.fetch = async (u, init) => {   // Range 対応の鯖の振り（pmtiles.js は Content-Length を見る）
		const range = init?.headers instanceof Headers ? init.headers.get("range") : (init?.headers?.Range ?? init?.headers?.range ?? "");
		const r = /bytes=(\d+)-(\d+)/.exec(range || ""); const body = r ? pm.subarray(+r[1], Math.min(pm.length, +r[2] + 1)) : pm;
		return new Response(body, { status: r ? 206 : 200, headers: { "Content-Length": String(body.byteLength), ...(r ? { "Content-Range": `bytes ${r[1]}-${+r[1] + body.byteLength - 1}/${pm.length}` } : {}) } });
	};
	const info = await pmtilesInfo("pmtiles://https://example.test/t.pmtiles");
	assert.equal(info.tileType, "mlt"); assert.equal(info.minZoom, 13); assert.equal(info.maxZoom, 14);
	sameLayers(await fetchPMTiles("pmtiles://https://example.test/t.pmtiles", 13, 7281, 3379, null, null), decodeMVT(vtTiles[0].mvt), { where: "pmtiles" });
	assert.deepEqual(await fetchPMTiles("pmtiles://https://example.test/t.pmtiles", 14, 0, 0, null, null), { __empty: true });
});

// ── ② 参照実装（Java）の実物＝OpenMapTiles z0 ──
await t("OpenMapTiles z0：Java 実装の MLT と MVT が同じ地物（struct→name:xx の平たいキー・FSST・三角形分割済みの面・64 ビット id）", () => {
	const mvt = decodeMVT(read(FX("omt/0_0_0.mvt"))), t0 = performance.now(), mlt = decodeMLT(read(FX("omt/0_0_0.mlt"))), ms = performance.now() - t0;
	sameLayers(mvt, mlt, { where: "omt" });
	const place = mlt.place.features.find(f => f.props["name:ja"]);
	assert.ok(place && typeof place.props["name:ja"] === "string" && place.props.name, "name:ja の平たいキー");
	assert.ok(mlt.water.features.every(f => f.type === "Polygon") && mlt.water.features.some(f => polygons(f.geom).some(([, h]) => h.length)), "三角形分割済みの層（GpuVector）も輪で返る＝穴あり");
	assert.ok(mlt.place.features.every(f => typeof f.id === "number"), "id は Number");
	console.log(`     (omt z0: decodeMLT ${ms.toFixed(1)} ms・${Object.values(mlt).reduce((s, L) => s + L.features.length, 0)} features)`);
});
await t("simple/multipolygon（CC0・三角形分割済み）＝MVT と同じ（外周 2・穴 1）", () => {
	const a = decodeMVT(read(FX("simple/multipolygon-boolean.mvt"))), b = decodeMLT(read(FX("simple/multipolygon-boolean.mlt")));
	sameLayers(a, b, { where: "simple" });
	assert.equal(polygons(b.layer.features[0].geom).length, 2); assert.deepEqual(polygons(b.layer.features[0].geom)[1][1], [5]);
	assert.equal(b.layer.features[0].props.key, true);
});

// ── ③ 仕様の合成試料（.json＝期待の論理表現）──
await t("合成試料（Morton・辞書の頂点・多重幾何・int64/uint64・struct の変種）＝期待の JSON と一致（輪の順と向きもそのまま）", () => {
	const dir = FX("synthetic/"), names = readdirSync(dir).filter(f => f.endsWith(".mlt")).map(f => f.slice(0, -4)).sort();
	assert.ok(names.length >= 20);
	let checked = 0;
	for (const name of names) {
		const L = decodeMLT(read(dir + name + ".mlt")), exp = JSON.parse(readFileSync(dir + name + ".json", "utf8"));
		const feats = Object.values(L).flatMap(x => x.features);
		assert.equal(feats.length, exp.features.length, `${name} count`);
		exp.features.forEach((e, i) => {
			const f = feats[i], at = `${name}#${i}`;
			assert.equal(L[e.properties._layer].extent, e.properties._extent, `${at} extent`);
			assert.equal(f.type, e.geometry.type.replace("Multi", ""), `${at} type`);
			const props = Object.fromEntries(Object.entries(e.properties).filter(([k]) => k !== "_layer" && k !== "_extent").map(([k, v]) => [k, typeof v === "bigint" ? Number(v) : v]));
			for (const [k, v] of Object.entries(props)) {
				if (typeof v === "number" && !Number.isSafeInteger(v) && Number.isInteger(v)) assert.equal(typeof f.props[k], "number", `${at} ${k} big int → Number`);   // JSON の 2^63 は Number に落ちて比べられない
				else if (typeof v === "number" && typeof f.props[k] === "number") assert.ok(Math.abs(f.props[k] - v) <= Math.abs(v) * 1e-6 + 1e-6, `${at} ${k}`);
				else assert.deepEqual(f.props[k], v, `${at} ${k}`);
			}
			assert.deepEqual(Object.keys(f.props).sort(), Object.keys(props).sort(), `${at} keys`);
			if (e.id !== undefined) assert.equal(typeof f.id, "number", `${at} id → Number`);
			// 幾何：期待（GeoJSON 風・輪は閉じている）を輪の列に平らにして、順も向きもそのまま比べる（書かれたまま返す）
			const c = e.geometry.coordinates, g = e.geometry.type;
			const expRings = g === "Point" ? [c] : g === "MultiPoint" ? c : g === "LineString" ? [c] : g === "MultiLineString" ? c : g === "Polygon" ? c : c.flat();
			const got = ringsOf(f.geom);
			assert.equal(got.length, expRings.length, `${at} parts`);
			expRings.forEach((r, k) => assert.deepEqual(got[k], r.flat(), `${at} part ${k}`));
			checked++;
		});
	}
	console.log(`     (${names.length} fixtures・${checked} features)`);
});
await t("面の向きと順は書かれたまま（MVT と同じ列＝下流が巻き方で外周と穴を分ける・MultiPolygon は外周→穴→次の外周の順）", () => {
	// 仕様の合成試料 poly_hole＝外周が負・穴が正（MVT の規約と逆）で書かれている＝そのまま返す（MVT の同じ輪の列と同じ扱いになる）
	const f = decodeMLT(read(FX("synthetic/poly_hole.mlt"))).layer1.features[0], rs = ringsOf(f.geom);
	assert.deepEqual(rs, [[11, 52, 71, 72, 61, 22, 11, 52], [65, 66, 35, 56, 55, 36, 65, 66]]);
	assert.ok(area(rs[0]) < 0 && area(rs[1]) > 0);
	// JS の encodeTile：MVT の規約どおり（外周＝正・穴＝負）に書けば polygons() が外周 1＋穴 1 に分ける・MultiPolygon は面ごと・退化した輪もそのまま
	const mlt = encodeTile([{ name: "L", features: [
		{ id: 1, geometry: { type: "Polygon", coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10]], [[2, 2], [2, 4], [4, 4], [4, 2]]] }, properties: {} },
		{ id: 2, geometry: { type: "MultiPolygon", coordinates: [[[[20, 20], [30, 20], [30, 30]]], [[[40, 40], [50, 40], [50, 50], [40, 50]], [[42, 42], [42, 44], [44, 44]]]] }, properties: {} },
		{ id: 3, geometry: { type: "Polygon", coordinates: [[[0, 0], [5, 5], [10, 10]]] }, properties: {} },   // 退化（面積 0）
	] }]);
	const L = decodeMLT(mlt).L;
	const a = ringsOf(L.features[0].geom); assert.ok(area(a[0]) > 0 && area(a[1]) < 0); assert.deepEqual(polygons(L.features[0].geom).map(([, h]) => h), [[5]]);
	const b = polygons(L.features[1].geom); assert.equal(b.length, 2); assert.deepEqual(b[0][1], []); assert.deepEqual(b[1][1], [5]);
	assert.deepEqual(Array.from(L.features[1].geom.coords), [20, 20, 30, 20, 30, 30, 20, 20, 40, 40, 50, 40, 50, 50, 40, 50, 40, 40, 42, 42, 42, 44, 44, 44, 42, 42]);
	assert.deepEqual(Array.from(L.features[2].geom.coords), [0, 0, 5, 5, 10, 10, 0, 0]);
});
await t("多重幾何は MVT と同じ形（MultiPoint＝点ごとの ends・MultiLineString＝線ごと・閉じた輪）", () => {
	const L = decodeMLT(encodeTile([{ name: "L", features: [
		{ id: 1, geometry: { type: "MultiPoint", coordinates: [[1, 1], [2, 2], [3, 3]] }, properties: { n: 7 } },
		{ id: 2, geometry: { type: "MultiLineString", coordinates: [[[0, 0], [5, 5]], [[6, 6], [7, 7], [8, 8]]] }, properties: {} },
		{ id: 3, geometry: { type: "Point", coordinates: [9, 9] }, properties: {} },
		{ id: 4, geometry: { type: "LineString", coordinates: [[1, 2], [3, 4]] }, properties: {} },
	] }])).L;
	assert.equal(L.features[0].type, "Point"); assert.deepEqual(Array.from(L.features[0].geom.coords), [1, 1, 2, 2, 3, 3]); assert.deepEqual(L.features[0].geom.ends, [2, 4, 6]);
	assert.equal(L.features[1].type, "LineString"); assert.deepEqual(L.features[1].geom.ends, [4, 10]);
	assert.deepEqual(Array.from(L.features[2].geom.coords), [9, 9]); assert.deepEqual(L.features[2].geom.ends, [2]);
	assert.deepEqual(Array.from(L.features[3].geom.coords), [1, 2, 3, 4]); assert.deepEqual(L.features[3].geom.ends, [4]);
	assert.ok(L.features[0].geom.coords instanceof Int32Array);
});
await t("MAP（入れ子）の属性＝オブジェクト／配列のまま props に入り expr の [\"get\", key, obj]／[\"at\"] で引ける・構造化複製で落ちない・bigint の id/属性は Number", () => {
	const L = decodeMLT(encodeTile([{ name: "L", features: [
		{ id: 2n ** 40n, geometry: { type: "Point", coordinates: [1, 1] }, properties: { m: { k: "v", list: [1, 2, 3], deep: { z: true } }, big: 2n ** 40n, s: "x" } },
		{ id: 5, geometry: { type: "Point", coordinates: [2, 2] }, properties: { s: "y" } },
	] }])).L;
	const f = L.features[0], ctx = { zoom: 10, props: f.props, geom: "Point", vars: {}, origin: "ml" };
	assert.equal(evalExpr(["get", "k", ["get", "m"]], ctx), "v");
	assert.equal(evalExpr(["at", 1, ["get", "list", ["get", "m"]]], ctx), 2);
	assert.equal(evalExpr(["get", "z", ["get", "deep", ["get", "m"]]], ctx), true);
	assert.equal(evalExpr(["has", "m"], ctx), true); assert.equal(evalExpr(["has", "m"], { ...ctx, props: L.features[1].props }), false);
	assert.equal(f.id, 1099511627776); assert.equal(f.props.big, 1099511627776); assert.equal(typeof f.props.big, "number");
	const cloned = structuredClone(f); assert.equal(cloned.props.m.list[2], 3); assert.equal(cloned.props.s, "x");
	assert.equal(L.features[1].props.m, undefined);
});
await t("1 層の失敗はその層だけ空（他の層は描く）＋警告は一度だけ", () => {
	const mlt = mvtToMLT(vtTiles[0].mvt);
	// 2 番目のブロック（層）の中身を壊す：ブロックの頭（長さ・タグ・名前）は残し、その先を 0xff で埋める
	const varint = (b, p) => { let v = 0, s = 1, x; do { x = b[p++]; v += (x & 0x7f) * s; s *= 128; } while (x & 0x80); return [v, p]; };
	const [len0, p0] = varint(mlt, 0), second = p0 + len0, [len1, p1] = varint(mlt, second), [, p2] = varint(mlt, p1), [nlen, p3] = varint(mlt, p2);
	const bad = mlt.slice(); bad.fill(0xff, p3 + nlen, p1 + len1);
	const name = new TextDecoder().decode(mlt.subarray(p3, p3 + nlen));
	const before = warns.length, L = decodeMLT(bad); decodeMLT(bad);
	assert.deepEqual(Object.keys(L).sort(), ["building", "landuse", "poi", "road"].filter(k => k !== name).sort());
	assert.equal(warns.length - before, 1); assert.match(warns[warns.length - 1], new RegExp(`\\[mlt\\] layer "${name}"`));
	assert.throws(() => decodeMLT(mlt.subarray(0, mlt.length - 5)), /overruns/);   // 切れたタイル＝投げる（タイルごと失敗＝呼び手の再試行に乗る）
});
await t("toMLTLayers＝変換道具の形（Multi* の判定・閉じ点を落とす・props の null を落とす）", () => {
	const layers = toMLTLayers(decodeMVT(vtTiles[0].mvt));
	assert.deepEqual(layers.map(l => l.name).sort(), ["building", "landuse", "poi", "road"]);
	const B = layers.find(l => l.name === "building").features, tall = B.find(f => f.properties.name === "tall"), court = B.find(f => f.properties.name === "court");
	assert.equal(tall.geometry.type, "Polygon"); assert.equal(tall.geometry.coordinates.length, 1); assert.equal(tall.geometry.coordinates[0].length, 4);   // 閉じ点を落とす（4 角）
	const r = tall.geometry.coordinates[0]; assert.notDeepEqual(r[0], r[r.length - 1]);
	// 試料の巻き方は MVT の規約と逆＝core の polygons()（符号付き面積）は中庭を別の外周と見る＝道具はそれに従って MultiPolygon（2 面）に書く＝MVT と同じ輪の列（上の同じ中間表現の検定で確認済み）
	assert.equal(court.geometry.type, "MultiPolygon"); assert.equal(court.geometry.coordinates.length, 2); assert.ok(court.geometry.coordinates.every(p => p.length === 1 && p[0].length === 4));
	assert.equal(court.id, 3); assert.equal(tall.properties.render_height, 120);
});
console.warn = origWarn;
console.log(`\n${n} passed`);
