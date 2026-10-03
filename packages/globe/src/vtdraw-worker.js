// vector source の描く層（fill／line／circle／symbol）の worker（MapLibre 互換 段 8⑤・2026-09-27・main は gadgets/vtdraw.js）。役の名は "vtdraw"（worker.js の役表）。
// main が取ったタイルの生バイト（MVT）を預かり、(source, タイル) ごとにその source の描く層をまとめて組む（解読 1 回）：
//   filter（自前・MapLibre の意味＝過拡大の z・Feature.id／promoteId）→ タイルの枠で切る（バッファの二重を作らない）→
//   core の buildTileDrawList（fill／line・基図と同じ部品）・circle は長さ 0 の線（カプセルの丸点）・symbol は core の buildLabels。
// op の li は利用者の層の帯（vtops.liOf）＝main が core の scene worker（CPU 結合）へそのまま渡す。worker は core の index を読まない（循環 worker の轍）。
// 生バイトの出し入れは main が決める（予算と LRU は main）＝ここは言われた物を持つだけ。無い時は miss を返す（main が取り直す）。
// タイルの形式（enc＝"mvt"｜"mlt"・#88）は put のたびに main が添える（XYZ＝source の encoding・PMTiles＝ヘッダの tileType）。
// feature-state（#109）＝paint が ["feature-state"] を読む層だけ：main が添えた状態（fs＝{ source-layer: [[id, state], …] }）を core の組み立て（buildTileDrawList・buildLabels の stateOf）へ。
//   そのタイルの地物の id を source-layer ごとに返す（main が「どのタイルを組み直すか」に使う）。
// 解読は同期（build の中）なので、遅延読み込みの形式は put の時に loadTileFormat を済ませてから預かる（main は put の返事を待っている）。
import { decodeTile, loadTileFormat, tileFormatReady } from "@ortho-earth/core/decode";
import { evalExpr, truthy, setGlobalState } from "@ortho-earth/core/expr";
import { parseRGBA, isColor } from "@ortho-earth/core/color";
import { buildTileDrawList } from "@ortho-earth/core/build";
import { buildLabels } from "@ortho-earth/core/tilelabels";
import { liOf, substituteZoom, clipFillGeom, clipLineGeom, verticesOf, dotsGeom, ringGeom, unitsPerPx, labelPointsOf } from "./vtops.js";

const raw = new Map();   // "sid|z/x/y" → { buf: Uint8Array（生タイル）, enc: 形式 }
const R2D = 180 / Math.PI;
const tileNW = (z, x, y) => { const n = 2 ** z; return [x / n * 360 - 180, R2D * Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n)))]; };   // タイルの原点（core の tileworker と同じ＝北西の角）
const idOf = (f, promoteId, sl) => { const k = promoteId == null ? null : typeof promoteId === "string" ? promoteId : promoteId[sl]; return k != null ? f.props?.[k] : f.id; };
const num = (e, ctx, dflt) => { if (e == null) return dflt; const v = evalExpr(e, ctx); return typeof v === "number" && Number.isFinite(v) ? v : dflt; };   // ML の評価エラー＝既定値
const alphaOf = (e, ctx) => { const v = e == null ? "#000000" : evalExpr(e, ctx); return isColor(v) ? parseRGBA(v)[3] : 1; };
const usesFS = L => JSON.stringify(L.paint ?? null).includes('"feature-state"');   // gadgets/vtdraw.js の usesFS と同じ（worker は gadgets を読まない）

self.onmessage = e => {
	const m = e.data;
	try {
		if (m.kind === "put") {
			const enc = m.enc || "mvt", buf = m.ab ? new Uint8Array(m.ab) : new Uint8Array(0);
			if (tileFormatReady(enc)) { raw.set(`${m.sid}|${m.key}`, { buf, enc }); self.postMessage({ id: m.id, ok: true }); return; }   // 手元にある形式（mvt・読み込み済みの mlt）＝同期
			loadTileFormat(enc).then(() => { raw.set(`${m.sid}|${m.key}`, { buf, enc }); self.postMessage({ id: m.id, ok: true }); },   // 最初の 1 枚だけ解読器を待つ（未登録なら decodeTile が空を返す）
				err => self.postMessage({ id: m.id, error: err?.message || String(err) }));
			return;
		}
		if (m.kind === "drop") { raw.delete(`${m.sid}|${m.key}`); return; }   // 生バイトを捨てる（main の LRU）
		if (m.kind === "build") { if (m.gs) setGlobalState(m.gs); build(m); return; }   // gs＝main の global-state（層の filter/layout の ["global-state", k]）
		self.postMessage({ id: m.id, error: `unknown kind ${m.kind}` });
	} catch (err) { self.postMessage({ id: m.id, error: err?.message || String(err) }); }
};

// { sid, key, z, x, y, layers: [{ id, layer（正規化済み＝エンジンの目盛り）, key（層の順の鍵） }], fz（filter の zoom）, pz（paint／layout の zoom）, promoteId, fs（feature-state・無ければ null） }
// 層の ["zoom"] の置き換え（substituteZoom）の覚え＝id → { rev, pz, paint, layout }（層ごとに最新の 1 つ＝版か pz が変われば作り直す）。rev が無い呼び手（検定）は毎回
const zoomSubs = new Map();
function zoomSubst(id, rev, pz, L0) {
	const c = rev != null ? zoomSubs.get(id) : null;
	if (c && c.rev === rev && c.pz === pz) return c;
	const o = { rev, pz, paint: substituteZoom(L0.paint || {}, pz), layout: { ...substituteZoom(L0.layout || {}, pz), visibility: "visible" } };
	if (rev != null) zoomSubs.set(id, o);
	return o;
}
function build(m) {
	const { sid, key, z, x, y, fz, pz, promoteId } = m;
	const fsm = m.fs ? new Map(Object.entries(m.fs).map(([sl, list]) => [sl, new Map(list)])) : null;   // source-layer → Map<id, state>
	const R = raw.get(`${sid}|${key}`);
	if (!R) { self.postMessage({ id: m.id, miss: true }); return; }
	const need = new Set(m.layers.map(l => l.layer["source-layer"]).filter(Boolean));
	const t0 = performance.now();   // 計器（#109 段 4・?hud=1）＝解読と組み立ての時間を返す
	const data = R.buf.byteLength ? decodeTile(R.buf, need, R.enc) : {};
	const t1 = performance.now();
	const origin = tileNW(z, x, y), ops = [], labels = {}, warn = [], ids = {};   // ids＝{ source-layer: Set<id> }（feature-state を読む層の地物・読む層が無ければ null で返す）
	// 線の細分＝基図と同じ 700m（地形に沿わせる）。低ズームのタイル（z2 で 1 枚 1 万 km）では 700m だと 1 本が 24 分割に膨れる＝タイルの幅の 1/64 より細かくしない
	const subLenM = Math.max(700, 40075016.686 * Math.cos((origin[1] + tileNW(z, x, y + 1)[1]) / 2 / R2D) / 2 ** z / 64);
	let features = 0;
	for (const { id, layer: L0, key: okey, rev } of m.layers) {
		const sl = L0["source-layer"], src = sl ? data[sl] : null, fsIds = usesFS(L0) && sl ? (ids[sl] ||= new Set()) : null;   // 読む層があれば地物が無くても空の集合（main が「このタイルは含まない」と分かる）
		if (!src || !src.features.length) continue;
		const E = src.extent || 4096;
		// filter＝MapLibre はタイルの（過拡大の）z で評価・Feature.id か promoteId（ctx.id）。paint は表示の z＝式の ["zoom"] を数へ置き換えた写しで組む
		const fctx = { zoom: fz, props: null, geom: null, vars: {}, origin: "ml", id: undefined };
		const feats = L0.filter == null ? src.features : src.features.filter(f => { fctx.props = f.props; fctx.geom = f.type; fctx.id = idOf(f, promoteId, sl); return truthy(evalExpr(L0.filter, fctx)); });
		if (!feats.length) continue;
		if (fsIds) for (const f of feats) { const v = idOf(f, promoteId, sl); if (v != null) fsIds.add(v); }
		const SM = fsIds ? fsm?.get(sl) : null, stateOf = SM?.size ? f => SM.get(idOf(f, promoteId, sl)) : null;   // 地物 → 状態（読む層で、状態が置かれている時だけ）
		// ["zoom"] を置き換えた写しは層（id×版）× pz で覚える＝同じ層の次のタイルは同じ配列＝式のコンパイルの覚え（配列の同一性で引く）が効く。旧＝タイルごとに写しを作り直し＝全部の式を毎回コンパイル
		const sz = zoomSubst(id, rev, pz, L0);
		const L = { ...L0, filter: undefined, minzoom: undefined, maxzoom: undefined, paint: sz.paint, layout: sz.layout };   // 層の出しズームと出し入れは main（結合の hidden）
		const P = L.paint, pctx = { zoom: pz, props: {}, geom: null, vars: {}, origin: "ml" };
		const run = (lyr, fs, sub) => {   // core の組み立て（層 1 枚の小さな style）→ li を利用者の帯へ
			if (!fs.length) return;
			const dl = buildTileDrawList({ layers: { [sl]: { extent: E, features: fs } }, z, x, y, subLenM, stateOf }, { layers: [lyr] }, origin);
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
			const dots = [], rimDots = [], rings = [], upx = unitsPerPx(E, z, pz), ctx = { zoom: pz, props: null, geom: null, vars: {}, origin: "ml", state: undefined };
			for (const f of feats) {
				const v = verticesOf(f, E); if (!v.length) continue;
				ctx.props = f.props; ctx.geom = f.type; ctx.state = stateOf?.(f);   // 縁の太さ・透け（丸点か輪か）も状態で変わり得る
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
			const place = L.layout["symbol-placement"] ?? "point", pts = [];
			if (place === "line" || place === "line-center") { for (const f of feats) if (f.type === "LineString") { const g = f.geom && clipLineGeom(f.geom, E); if (g?.coords?.length) pts.push({ ...f, geom: g }); } }   // 線に沿う注記（段 4）＝枠で切った線（隣のタイルと二重にしない）を core の buildLabels（錨と折れ線）へ
			else for (const f of feats) for (const [px, py] of labelPointsOf(f, E)) pts.push({ type: "Point", id: f.id, props: f.props, geom: { coords: [px, py], ends: [2] } });
			if (!pts.length) continue;
			const { labels: ls } = buildLabels({ layers: { [sl]: { extent: E, features: pts } }, z, x, y, stateOf }, { layers: [L], schema: null });
			for (const lb of ls) { lb.sort = -1e6 - okey * 1e3 + (lb.sort || 0); delete lb.li; }   // 利用者の注記が基図に勝つ・上の層ほど先に置く（MapLibre と同じ）
			if (ls.length) labels[id] = ls;
			features += pts.length;
		}
	}
	const transfer = [];
	let bytes = 0;
	for (const op of ops) for (const a of op.kind === "fill" ? [op.pos, op.col, op.idx] : [op.P1, op.P2, op.col, op.half, op.off]) if (a) { transfer.push(a.buffer); bytes += a.byteLength; }
	const idl = Object.keys(ids).length ? Object.fromEntries(Object.entries(ids).map(([k, v]) => [k, [...v]])) : null;
	self.postMessage({ id: m.id, origin, ops, labels, bytes, stats: { features, ops: ops.length, decodeMs: t1 - t0, buildMs: performance.now() - t1 }, warn, ids: idl }, transfer);
}
