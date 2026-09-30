// タイル形式の登録簿（src/tileformat.js・#88）の検定：MVT が既定で登録されている・decodeTile の振り分け・未登録は空＋一度だけ警告・
// 遅延読み込み（load）は await してから同期に解ける・PMTiles の tileType の名前は登録簿から引く・resolveVectorSource は encoding を返す・
// fetchMVT（取得済みの本体）は encoding で振り分ける。node packages/ortho-core/tests/tileformat.mjs
import assert from "node:assert/strict";
import { registerTileFormat, loadTileFormat, decodeTile, hasTileFormat, tileFormatNames, tileFormatOfPmtilesType, tileFormatReady } from "../src/tileformat.js";
import { decodeMVT, fetchMVT } from "../src/decode.js";
import { resolveVectorSource, vectorLayersOf } from "../src/mlstyle.js";
import { pmtilesInfo } from "../src/pmtiles-src.js";
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log("  ✔", name); };
const warns = [];
const origWarn = console.warn; console.warn = (...a) => warns.push(a.join(" "));

// 最小の MVT（1 層 "roads"・線 1 本・props {name:"a"}）＝decodeMVT の出力と比べる基準
import Pbf from "geopbf/pbf";
const mvt = (() => {
	const p = new Pbf();
	p.writeMessage(3, (_, l) => {
		l.writeVarintField(15, 2); l.writeStringField(1, "roads");
		l.writeMessage(2, (__, f) => { f.writeVarintField(1, 7); f.writePackedVarint(2, [0, 0]); f.writeVarintField(3, 2); f.writePackedVarint(4, [9, 2, 4, 10, 6, 8]); });
		l.writeStringField(3, "name"); l.writeMessage(4, (___, v) => v.writeStringField(1, "a")); l.writeVarintField(5, 4096);
	});
	const u = p.finish();
	return u.buffer.byteLength === u.byteLength ? u : u.slice();   // 実バイトちょうどの buffer（Pbf の finish は大きめの buffer の view）
})();
const ab = () => mvt.buffer.slice(0);

await t("MVT は既定で登録されている（pmtilesType 1）", () => {
	assert.equal(hasTileFormat("mvt"), true); assert.equal(tileFormatReady("mvt"), true);
	assert.equal(tileFormatOfPmtilesType(1), "mvt"); assert.equal(tileFormatOfPmtilesType(6), null);
	assert.deepEqual(decodeTile(mvt, null, "mvt"), decodeMVT(mvt));
	assert.deepEqual(decodeTile(mvt), decodeMVT(mvt));   // 既定＝mvt
	assert.equal(decodeTile(mvt).roads.features[0].props.name, "a");
	assert.deepEqual(Array.from(decodeTile(mvt).roads.features[0].geom.coords), [1, 2, 4, 6]);
});
await t("未登録の形式＝空（層なし）＋警告は一度だけ", async () => {
	assert.deepEqual(decodeTile(mvt, null, "nope"), {});
	assert.deepEqual(decodeTile(mvt, null, "nope"), {});
	assert.equal(await loadTileFormat("nope"), null);
	assert.equal(warns.filter(w => w.includes('"nope"')).length, 1);
	assert.match(warns[0], /not registered/); assert.match(warns[0], /tile-formats\/register/);
});
await t("遅延読み込み（load）＝await してから同期に解ける・読み込み前の同期は投げる", async () => {
	let loads = 0;
	registerTileFormat({ name: "lazy", pmtilesType: 99, load: async () => { loads++; return (bytes, need) => ({ L: { extent: bytes.length, features: [], need: need ? [...need] : null } }); } });
	assert.equal(tileFormatReady("lazy"), false);
	assert.throws(() => decodeTile(mvt, null, "lazy"), /not loaded yet/);
	const [a, b] = await Promise.all([loadTileFormat("lazy"), loadTileFormat("lazy")]);   // 同時に 2 回＝読み込みは 1 回
	assert.equal(a, b); assert.equal(loads, 1); assert.equal(tileFormatReady("lazy"), true);
	assert.deepEqual(decodeTile(new Uint8Array(3), new Set(["x"]), "lazy"), { L: { extent: 3, features: [], need: ["x"] } });
	assert.equal(tileFormatOfPmtilesType(99), "lazy"); assert.ok(tileFormatNames().includes("lazy"));
});
await t("load の失敗は覚えない（次の呼び出しで再試行）・load が関数を返さなければ投げる", async () => {
	let k = 0;
	registerTileFormat({ name: "flaky", load: async () => { if (k++ === 0) throw new Error("offline"); return { decode: () => ({ ok: {} }) }; } });   // { decode } の形も受ける
	await assert.rejects(loadTileFormat("flaky"), /offline/);
	await loadTileFormat("flaky");
	assert.deepEqual(decodeTile(mvt, null, "flaky"), { ok: {} });
	registerTileFormat({ name: "bad", load: async () => 42 });
	await assert.rejects(loadTileFormat("bad"), /did not return a decode function/);
	assert.throws(() => registerTileFormat({ name: "x" }), /decode or load/);
	assert.throws(() => registerTileFormat({}), /name/);
});
await t("fetchMVT（取得済みの本体）は encoding で振り分ける", async () => {
	registerTileFormat({ name: "echo", decode: (bytes, need) => ({ E: { extent: bytes.length, features: [], need: need ? [...need].sort() : null } }) });
	assert.deepEqual(await fetchMVT("x", null, new Set(["b", "a"]), null, ab(), "echo"), { E: { extent: mvt.length, features: [], need: ["a", "b"] } });
	assert.deepEqual(await fetchMVT("x", null, null, null, ab()), decodeMVT(mvt));   // 既定＝mvt
	assert.deepEqual(await fetchMVT("x", null, null, null, new ArrayBuffer(0), "echo"), { __empty: true });   // 空＝そこに無い
	assert.deepEqual(await fetchMVT("x", null, null, null, ab(), "nope"), {});   // 未登録＝空（警告済み）
});
await t("resolveVectorSource は encoding を返す（既定 mvt・申告 mlt・TileJSON 経由・pmtiles）", async () => {
	const base = "https://example.test/style.json";
	assert.equal((await resolveVectorSource({ type: "vector", tiles: ["a/{z}/{x}/{y}.pbf"] }, base)).encoding, "mvt");
	assert.equal((await resolveVectorSource({ type: "vector", tiles: ["a/{z}/{x}/{y}.mlt"], encoding: "mlt" }, base)).encoding, "mlt");
	assert.equal((await resolveVectorSource({ type: "vector", url: "pmtiles://a.pmtiles", encoding: "mlt" }, base)).encoding, "mlt");
	const tj = await resolveVectorSource({ type: "vector", url: "tiles.json", encoding: "mlt" }, base, { fetchFn: async () => new Response(JSON.stringify({ tiles: ["t/{z}/{x}/{y}.mlt"], minzoom: 1, maxzoom: 9 })) });
	assert.equal(tj.encoding, "mlt"); assert.equal(tj.maxzoom, 9);
});
await t("PMTiles の tileType の名前は登録簿から引く（1＝mvt・6＝mlt は未登録でも名前は言える・2〜5＝ラスタ）", async () => {
	const md = new TextEncoder().encode(JSON.stringify({ vector_layers: [{ id: "roads" }] }));
	const mk = tileType => {
		const buf = new Uint8Array(128 + md.length), dv = new DataView(buf.buffer);
		buf.set(new TextEncoder().encode("PMTiles"), 0); buf[7] = 3;
		const u64 = (o, v) => dv.setBigUint64(o, BigInt(v), true);
		u64(8, 127); u64(16, 1); u64(24, 128); u64(32, md.length); u64(40, 0); u64(48, 0); u64(56, buf.length); u64(64, 0);
		buf[96] = 1; buf[97] = 1; buf[98] = 1; buf[99] = tileType; buf[100] = 0; buf[101] = 5;
		dv.setInt32(102, -1800000000, true); dv.setInt32(106, -850000000, true); dv.setInt32(110, 1800000000, true); dv.setInt32(114, 850000000, true);
		return buf;
	};
	const bufs = { "https://example.test/mvt.pmtiles": mk(1), "https://example.test/mlt.pmtiles": mk(6), "https://example.test/png.pmtiles": mk(2), "https://example.test/lazy.pmtiles": mk(99) };
	globalThis.fetch = async u => new Response(bufs[String(u)], { status: 200 });
	assert.equal((await pmtilesInfo("pmtiles://https://example.test/mvt.pmtiles")).tileType, "mvt");
	assert.equal((await pmtilesInfo("pmtiles://https://example.test/mlt.pmtiles")).tileType, "mlt");
	assert.equal((await pmtilesInfo("pmtiles://https://example.test/png.pmtiles")).tileType, "png");
	assert.equal((await pmtilesInfo("pmtiles://https://example.test/lazy.pmtiles")).tileType, "lazy");   // 登録簿の pmtilesType（上で 99 を登録）
});
await t("vector_layers＝層の一覧（id・fields・minzoom・maxzoom・description）・外のデータは素の形へ・無ければ null（検査表示 #174）", async () => {
	const base = "https://example.test/style.json";
	const vl = [{ id: "water", fields: { class: "String", n: 3 }, minzoom: 0, maxzoom: 14, description: "d" }, { id: "road" }, { id: 5 }, null, { id: "" }, { id: "poi", fields: ["x"], minzoom: "1" }];
	const want = [{ id: "water", fields: { class: "String", n: "3" }, minzoom: 0, maxzoom: 14, description: "d" }, { id: "road", fields: {} }, { id: "poi", fields: {} }];
	assert.deepEqual(vectorLayersOf({ vector_layers: vl }), want);
	assert.equal(vectorLayersOf({}), null); assert.equal(vectorLayersOf(null), null); assert.equal(vectorLayersOf({ vector_layers: "x" }), null);
	const tj = await resolveVectorSource({ type: "vector", url: "tiles.json" }, base, { fetchFn: async () => new Response(JSON.stringify({ tiles: ["t/{z}/{x}/{y}.pbf"], vector_layers: vl })) });
	assert.deepEqual(tj.vectorLayers, want);
	assert.deepEqual((await resolveVectorSource({ type: "vector", tiles: ["a/{z}/{x}/{y}.pbf"], vector_layers: [{ id: "a" }] }, base)).vectorLayers, [{ id: "a", fields: {} }]);   // 書き込みの TileJSON（tiles と一緒）
	assert.equal((await resolveVectorSource({ type: "vector", tiles: ["a/{z}/{x}/{y}.pbf"] }, base)).vectorLayers, null);
	assert.equal((await resolveVectorSource({ type: "vector", url: "pmtiles://a.pmtiles" }, base)).vectorLayers, null);   // PMTiles＝アーカイブの metadata（pmtilesInfo）が持つ
});
console.warn = origWarn;
console.log(`\n${n} passed`);
