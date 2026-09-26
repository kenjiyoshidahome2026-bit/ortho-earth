// vector source の描く層（fill／line／circle／symbol）の worker（MapLibre 互換 段 8⑤・2026-09-27・main は gadgets/vtdraw.js）。役の名は "vtdraw"（worker.js の役表）。
// main が取ったタイルの生バイト（MVT）を預かり、(source, タイル) ごとにその source の描く層をまとめて組む（解読 1 回）：
//   filter（自前・MapLibre の意味＝過拡大の z・Feature.id／promoteId）→ タイルの枠で切る（バッファの二重を作らない）→
//   core の buildTileDrawList（fill／line・基図と同じ部品）・circle は長さ 0 の線（カプセルの丸点）・symbol は core の buildLabels。
// op の li は利用者の層の帯（vtops.liOf）＝main が core の scene worker（CPU 結合）へそのまま渡す。worker は core の index を読まない（循環 worker の轍）。
// 生バイトの出し入れは main が決める（予算と LRU は main）＝ここは言われた物を持つだけ。無い時は miss を返す（main が取り直す）。
import { decodeMVT } from "@ortho-earth/core/decode";
import { evalExpr, truthy } from "@ortho-earth/core/expr";
import { parseRGBA, isColor } from "@ortho-earth/core/color";
import { buildTileDrawList } from "@ortho-earth/core/build";
import { buildLabels } from "@ortho-earth/core/tilelabels";
import { liOf, substituteZoom, clipFillGeom, clipLineGeom, verticesOf, dotsGeom, ringGeom, unitsPerPx, labelPointsOf } from "./vtops.js";

const raw = new Map();   // "sid|z/x/y" → Uint8Array（MVT）
const R2D = 180 / Math.PI;
const tileNW = (z, x, y) => { const n = 2 ** z; return [x / n * 360 - 180, R2D * Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n)))]; };   // タイルの原点（core の tileworker と同じ＝北西の角）
const idOf = (f, promoteId, sl) => { const k = promoteId == null ? null : typeof promoteId === "string" ? promoteId : promoteId[sl]; return k != null ? f.props?.[k] : f.id; };
const num = (e, ctx, dflt) => { if (e == null) return dflt; const v = evalExpr(e, ctx); return typeof v === "number" && Number.isFinite(v) ? v : dflt; };   // ML の評価エラー＝既定値
const alphaOf = (e, ctx) => { const v = e == null ? "#000000" : evalExpr(e, ctx); return isColor(v) ? parseRGBA(v)[3] : 1; };

self.onmessage = e => {
	const m = e.data;
	try {
		if (m.kind === "put") { raw.set(`${m.sid}|${m.key}`, m.ab ? new Uint8Array(m.ab) : new Uint8Array(0)); self.postMessage({ id: m.id, ok: true }); return; }
		if (m.kind === "drop") { raw.delete(`${m.sid}|${m.key}`); return; }   // 生バイトを捨てる（main の LRU）
		if (m.kind === "build") { build(m); return; }
		self.postMessage({ id: m.id, error: `unknown kind ${m.kind}` });
	} catch (err) { self.postMessage({ id: m.id, error: err?.message || String(err) }); }
};

// { sid, key, z, x, y, layers: [{ id, layer（正規化済み＝エンジンの目盛り）, key（層の順の鍵） }], fz（filter の zoom）, pz（paint／layout の zoom）, promoteId }
function build(m) {
	const { sid, key, z, x, y, fz, pz, promoteId } = m;
	const buf = raw.get(`${sid}|${key}`);
	if (!buf) { self.postMessage({ id: m.id, miss: true }); return; }
	const need = new Set(m.layers.map(l => l.layer["source-layer"]).filter(Boolean));
	const data = buf.byteLength ? decodeMVT(buf, need) : {};
	const origin = tileNW(z, x, y), ops = [], labels = {}, warn = [];
	// 線の細分＝基図と同じ 700m（地形に沿わせる）。低ズームのタイル（z2 で 1 枚 1 万 km）では 700m だと 1 本が 24 分割に膨れる＝タイルの幅の 1/64 より細かくしない
	const subLenM = Math.max(700, 40075016.686 * Math.cos((origin[1] + tileNW(z, x, y + 1)[1]) / 2 / R2D) / 2 ** z / 64);
	let features = 0;
	for (const { id, layer: L0, key: okey } of m.layers) {
		const sl = L0["source-layer"], src = sl ? data[sl] : null;
		if (!src || !src.features.length) continue;
		const E = src.extent || 4096;
		// filter＝MapLibre はタイルの（過拡大の）z で評価・Feature.id か promoteId（ctx.id）。paint は表示の z＝式の ["zoom"] を数へ置き換えた写しで組む
		const fctx = { zoom: fz, props: null, geom: null, vars: {}, origin: "ml", id: undefined };
		const feats = L0.filter == null ? src.features : src.features.filter(f => { fctx.props = f.props; fctx.geom = f.type; fctx.id = idOf(f, promoteId, sl); return truthy(evalExpr(L0.filter, fctx)); });
		if (!feats.length) continue;
		const L = { ...L0, filter: undefined, minzoom: undefined, maxzoom: undefined, paint: substituteZoom(L0.paint || {}, pz), layout: { ...substituteZoom(L0.layout || {}, pz), visibility: "visible" } };   // 層の出しズームと出し入れは main（結合の hidden）
		const P = L.paint, pctx = { zoom: pz, props: {}, geom: null, vars: {}, origin: "ml" };
		const run = (lyr, fs, sub) => {   // core の組み立て（層 1 枚の小さな style）→ li を利用者の帯へ
			if (!fs.length) return;
			const dl = buildTileDrawList({ layers: { [sl]: { extent: E, features: fs } }, z, x, y, subLenM }, { layers: [lyr] }, origin);
			for (const op of dl.ops) { op.li = liOf(okey, sub); op.id = id; ops.push(op); }
		};
		if (L.type === "fill") {
			const fs = []; for (const f of feats) { if (f.type !== "Polygon") continue; const g = clipFillGeom(f.geom, E); if (g) fs.push({ ...f, geom: g }); }
			run(L, fs, 0);
			features += fs.length;
			if (P["fill-outline-color"] != null) {   // 明示された輪郭（MapLibre の fill の 1px の縁）＝面の輪を線として（枠の上の辺は落とす）
				const os = []; for (const f of fs) { const g = clipLineGeom(f.geom, E, { skipBoundary: true }); if (g) os.push({ ...f, type: "LineString", geom: g }); }
				run({ ...L, type: "line", paint: { "line-color": P["fill-outline-color"], "line-width": 1, "line-opacity": P["fill-opacity"] ?? 1 }, layout: {} }, os, 1);
			}
		} else if (L.type === "line") {
			if (L.paint["line-dasharray"] != null && pz !== z) {   // 破線の模様はタイルの縮尺で刻まれる（build.js）＝表示の z との差の分だけ縮める
				const d = evalExpr(L.paint["line-dasharray"], pctx);
				if (Array.isArray(d)) L.paint = { ...L.paint, "line-dasharray": ["literal", d.map(v => v * 2 ** (z - pz))] };
			}
			const fs = [];
			for (const f of feats) {
				if (f.type === "Point") continue;
				const g = clipLineGeom(f.geom, E, { skipBoundary: f.type === "Polygon" });   // 面の輪（line 層で面を縁取る）＝枠の上の辺は落とす
				if (g) fs.push({ ...f, type: "LineString", geom: g });
			}
			run(L, fs, 0);
			features += fs.length;
		} else if (L.type === "circle") {
			// 円＝長さ 0 の線（カプセルの丸点・半径＝線幅の半分）。縁（stroke）は半径＋縁の太さの丸点を下に置く（li の副番号 1）。
			// 塗りが透ける円の縁は丸点だと中が縁の色になる＝止まった所のズームで合わせた輪（24 角形）で描く
			const r = P["circle-radius"] ?? 5, sw = P["circle-stroke-width"] ?? 0;
			const dots = [], rimDots = [], rings = [], upx = unitsPerPx(E, z, pz), ctx = { zoom: pz, props: null, geom: null, vars: {}, origin: "ml" };
			for (const f of feats) {
				const v = verticesOf(f, E); if (!v.length) continue;
				ctx.props = f.props; ctx.geom = f.type;
				dots.push({ ...f, type: "LineString", geom: dotsGeom(v) });
				const w = num(sw, ctx, 0); if (!(w > 0)) continue;
				const a = alphaOf(P["circle-color"], ctx) * num(P["circle-opacity"] ?? 1, ctx, 1);
				if (a >= 0.999) { rimDots.push({ ...f, type: "LineString", geom: dotsGeom(v) }); continue; }
				const rr = (num(r, ctx, 5) + w / 2) * upx;
				for (let i = 0; i < v.length; i += 2) rings.push({ ...f, type: "LineString", geom: ringGeom(v[i], v[i + 1], rr) });
			}
			const base = { ...L, type: "line", layout: L.layout["circle-sort-key"] != null ? { "line-sort-key": L.layout["circle-sort-key"] } : {} };
			if (rimDots.length) run({ ...base, paint: { "line-color": P["circle-stroke-color"] ?? "#000000", "line-width": ["*", 2, ["+", r, sw]], "line-opacity": P["circle-stroke-opacity"] ?? 1 } }, rimDots, 1);
			if (rings.length) run({ ...base, paint: { "line-color": P["circle-stroke-color"] ?? "#000000", "line-width": sw, "line-opacity": P["circle-stroke-opacity"] ?? 1 } }, rings, 1);
			run({ ...base, paint: { "line-color": P["circle-color"] ?? "#000000", "line-width": ["*", 2, r], "line-opacity": P["circle-opacity"] ?? 1 } }, dots, 2);
			features += dots.length;
		} else if (L.type === "symbol") {
			if ((L.layout["symbol-placement"] ?? "point") !== "point") { warn.push("symbol-placement"); continue; }   // 線の上の注記＝段 8③
			const pts = [];
			for (const f of feats) for (const [px, py] of labelPointsOf(f, E)) pts.push({ type: "Point", id: f.id, props: f.props, geom: { coords: [px, py], ends: [2] } });
			if (!pts.length) continue;
			const { labels: ls } = buildLabels({ layers: { [sl]: { extent: E, features: pts } }, z, x, y }, { layers: [L], schema: null });
			for (const lb of ls) { lb.sort = -1e6 - okey * 1e3 + (lb.sort || 0); delete lb.li; }   // 利用者の注記が基図に勝つ・上の層ほど先に置く（MapLibre と同じ）
			if (ls.length) labels[id] = ls;
			features += pts.length;
		}
	}
	const transfer = [];
	let bytes = 0;
	for (const op of ops) for (const a of op.kind === "fill" ? [op.pos, op.col, op.idx] : [op.P1, op.P2, op.col, op.half, op.off]) if (a) { transfer.push(a.buffer); bytes += a.byteLength; }
	self.postMessage({ id: m.id, origin, ops, labels, bytes, stats: { features, ops: ops.length }, warn }, transfer);
}
