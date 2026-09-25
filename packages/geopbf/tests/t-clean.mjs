// t-clean: 位相の掃除（extension/clean.js）の検定（B5・2026-09-25）。
// 守るもの：clean の後の GintBUF で、面の各 ring が弧としてつながっていること（stream と入れ子配列の両方）・弧番号が範囲内・
// 面だけ／線だけ／面と線の混在のどれでも null にならない・pbf.cleanTopology() が描画用の GintBUF も作り直す・
// 触らないデータでは rebuildStreams が wasm の stream を一字一句再現する（隣接の規則が同じ）。
globalThis.ImageData ??= class ImageData { };
import { GeoPBF } from "../src/pbf.js";
import { topology, unPackGintBuffer, rebuildStreams } from "../src/extension/topology.js";
import { cleanGintBuffer } from "../src/extension/clean.js";
import { gint } from "../src/extension/gint.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
{
	const wasmJs = fileURLToPath(new URL("../wasm/pkg/gint_wasm.js", import.meta.url));
	const mod = await import(wasmJs);
	await mod.default({ module_or_path: readFileSync(wasmJs.replace(/\.js$/, "_bg.wasm")) });
	await gint.initialize();
}
let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };
const F = (type, coordinates, properties = {}) => ({ type: "Feature", properties, geometry: { type, coordinates } });
const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const bakeBuf = async features => topology(await new GeoPBF({ name: "t-clean" }).set({ type: "FeatureCollection", features }));

// 面の ring がつながっているか（stream 側・入れ子配列側）と弧番号の範囲
function rings(d) {
	const ends = aid => { const m = aid * 8, off = d.arcMeta[m], len = d.arcMeta[m + 1];
		return [gint.unpackToInt(d.arcBuffer[off]).join(), gint.unpackToInt(d.arcBuffer[off + len - 1]).join()]; };
	const closed = ring => { const seg = ring.map(ai => { const [s, e] = ends(ai < 0 ? ~ai : ai); return ai < 0 ? [e, s] : [s, e]; });
		return seg.every((sg, k) => sg[1] === seg[(k + 1) % seg.length][0]); };
	let n = 0, broken = 0, oob = 0;
	const ps = d.polyStream; let p = 0;
	while (ps && p < ps.length) {
		p++; const nr = ps[p++];
		for (let r = 0; r < nr; r++) { const len = ps[p++], ring = Array.from(ps.subarray(p, p + len)); p += len; n++;
			if (ring.some(ai => (ai < 0 ? ~ai : ai) >= d.arcCount)) { oob++; continue; }
			if (!closed(ring)) broken++; }
	}
	let nn = 0, nb = 0;
	for (const [, comps] of d.polygon || []) for (const rs of comps) for (const ring of rs) { nn++; if (!closed(ring)) nb++; }
	return { n, broken, oob, nn, nb };
}
const allOk = r => r.n > 0 && !r.broken && !r.oob && r.nn === r.n && !r.nb;

// 1) 触らないデータ：rebuildStreams が wasm の stream・隣接を再現（隣接する 3 面＋離れた 1 面＋線）
{
	// 属性は別々に（同じ属性の地物は decoder の dissolve で 1 つにまとまる＝隣接が消える）
	const feats = [F("Polygon", [sq(0, 0, 1, 1)], { i: 0 }), F("Polygon", [sq(1, 0, 2, 1)], { i: 1 }), F("Polygon", [sq(2, 0, 3, 1)], { i: 2 }), F("Polygon", [sq(5, 5, 6, 6)], { i: 3 }),
		F("MultiPolygon", [[sq(8, 8, 9, 9)], [sq(9, 8, 10, 9)]], { i: 4 }), F("Polygon", [sq(9, 9, 10, 10)], { i: 5 }), F("LineString", [[20, 20], [21, 21], [22, 20]], { i: 6 })];
	const d = unPackGintBuffer(await bakeBuf(feats));
	const orig = { ps: Array.from(d.polyStream), ls: Array.from(d.lineStream), ns: Array.from(d.neighborStream) };
	void d.polygon; void d.polyline;   // 遅延の入れ子配列を組ませてから
	rebuildStreams(d);
	ok(JSON.stringify(Array.from(d.polyStream)) === JSON.stringify(orig.ps), "rebuildStreams：polyStream が wasm と一致");
	ok(JSON.stringify(Array.from(d.lineStream)) === JSON.stringify(orig.ls), "rebuildStreams：lineStream が wasm と一致");
	ok(JSON.stringify(Array.from(d.neighborStream)) === JSON.stringify(orig.ns), `rebuildStreams：neighborStream が wasm と一致（${orig.ns.join(",")}）`);
}

// 2) 交差する面（重なる正方形 A・B）＋離れた正方形 C、に線を混ぜたもの／面だけ／線だけ
const A = F("Polygon", [sq(0, 0, 2, 2)], { n: "A" }), B = F("Polygon", [sq(1, 1, 3, 3)], { n: "B" }), C = F("Polygon", [sq(10, 10, 11, 11)], { n: "C" });
const L1 = F("LineString", [[0, 0], [2, 2]], { n: "L1" }), L2 = F("LineString", [[0, 2], [2, 0]], { n: "L2" });
for (const [tag, feats] of [["面と線", [A, B, C, F("LineString", [[20, 20], [21, 21]], { n: "L" })]], ["面だけ", [A, B, C]]]) {
	const before = unPackGintBuffer(await bakeBuf(feats));
	const buf = cleanGintBuffer(await bakeBuf(feats), true);
	const d = unPackGintBuffer(buf);
	ok(!!d, `${tag}：clean の GintBUF が読める`);
	const r = rings(d);
	ok(allOk(r), `${tag}：全 ring がつながる（rings=${r.n} broken=${r.broken} oob=${r.oob} nested=${r.nn}/${r.nb}）`);
	ok(d.arcCount > before.arcCount, `${tag}：交差で弧が切られた（${before.arcCount}→${d.arcCount}）`);
}
{
	const d = unPackGintBuffer(cleanGintBuffer(await bakeBuf([L1, L2]), true));
	let p = 0, sets = 0, oob = 0; const s = d.lineStream;
	while (s && p < s.length) { p++; const ns = s[p++]; for (let k = 0; k < ns; k++) { const len = s[p++]; for (let a = 0; a < len; a++) if ((s[p + a] < 0 ? ~s[p + a] : s[p + a]) >= d.arcCount) oob++; p += len; sets++; } }
	ok(!!d && d.arcCount === 4 && sets === 2 && !oob, `線だけ：交差点で 2 本→4 弧・弧番号は範囲内（arcs=${d?.arcCount} sets=${sets} oob=${oob}）`);
}

// 3) pbf.cleanTopology()：入れ子配列と stream、描画用 GintBUF（_gintBuffer）も新しい弧番号に
{
	const p = await new GeoPBF({ name: "t-clean" }).set({ type: "FeatureCollection", features: [A, B, C, L1] });
	await p.setGintBUF(topology(p));
	const before = p.unPackGint.arcCount;
	p.cleanTopology();
	const mem = rings(p.unPackGint), fromBuf = unPackGintBuffer(p._gintBuffer);
	ok(allOk(mem), `pbf.cleanTopology()：メモリ上の ring がつながる（${JSON.stringify(mem)}）`);
	ok(fromBuf.arcCount === p.unPackGint.arcCount && fromBuf.arcCount > before && allOk(rings(fromBuf)), `pbf.cleanTopology()：_gintBuffer も作り直した（arcs ${before}→${fromBuf.arcCount}）`);
}

// 4) 2 回目の clean は何も変えない（冪等）
{
	const once = cleanGintBuffer(await bakeBuf([A, B, C]), true), twice = cleanGintBuffer(once.slice(0), true);
	ok(Buffer.compare(Buffer.from(once), Buffer.from(twice)) === 0, "clean は冪等（2 回目で GintBUF が変わらない）");
}

console.log(fails ? `\n❌ t-clean ${fails} 件失敗` : "\n✅ t-clean 全件 PASS");
process.exit(fails ? 1 : 0);
