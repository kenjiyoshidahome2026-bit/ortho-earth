// デコード済みMVT + style.json → 描画op列（style層の順＝厳密な painter順）。
// 各 style層が1つの op（fill or line）になり、renderer はこの順にそのまま描く。
// 投影非依存の部分だけ担当：幾何を経緯度に戻し、シーン原点からの delta(float32) と地物ごとの色/線幅を確定。
// 線幅はスクリーン空間の定px（fat-line/capsule 展開は頂点シェーダ側）。
import earcut from "earcut";
import { evalExpr, truthy } from "./expr.js";
import { parseRGBA } from "./color.js";
import { tileLocalToLonLat } from "./tile.js";

// origin: [lon,lat] シーン原点（精度確保のため頂点は原点からの差分で持つ）
// pale: 色文字列→色文字列 の変換（無ければ恒等）
export function buildTileDrawList({ layers, z, x, y }, style, origin, pale = c => c) {
	const [ox, oy] = origin;
	const ops = [];   // { kind:'fill'|'line', li, ... } を style層順に（li=style層index、跨ぎバッチ結合用）
	const toLL = (px, py, extent) => tileLocalToLonLat(x, y, z, px, py, extent);
	// 線分細分の閾値（タイル単位）：地形にドレープする際、長い直線が尾根で折れないよう ~700m 毎に分割。
	const [, cLat] = tileLocalToLonLat(x, y, z, 2048, 2048, 4096);
	const mPerUnit = 40075016.686 * Math.cos(cLat * Math.PI / 180) / (Math.pow(2, z) * 4096);
	const subLen = Math.max(1, 700 / mPerUnit);   // 700m 相当のタイル単位

	for (let li = 0; li < style.layers.length; li++) {
		const L = style.layers[li];
		if (L.type !== "fill" && L.type !== "line") continue;
		if (L.layout && L.layout.visibility === "none") continue;
		if (L.minzoom != null && z < L.minzoom) continue;
		if (L.maxzoom != null && z >= L.maxzoom) continue;
		const src = layers[L["source-layer"]]; if (!src) continue;
		const extent = src.extent;
		// line-sort-key/fill-sort-key: 層内で昇順に並べ替え（高い値ほど後＝上に描く）。std は道路を vt_drworder で並べる。
		const feats = sortFeatures(src.features, L.layout?.["line-sort-key"] ?? L.layout?.["fill-sort-key"], z);

		if (L.type === "fill") {
			const pos = [], col = [];
			for (const f of feats) {
				const ctx = { zoom: z, props: f.props, geom: f.type, vars: {} };
				if (L.filter && !truthy(evalExpr(L.filter, ctx))) continue;
				const c = parseRGBA(pale(evalExpr(L.paint?.["fill-color"] ?? "#000", ctx)));
				const op = L.paint?.["fill-opacity"]; const a = c[3] * (op != null ? evalExpr(op, ctx) : 1);
				for (const [flat, holes] of polygons(f.geom)) {
					const tris = earcut(flat, holes, 2);
					for (const idx of tris) {
						const [lon, lat] = toLL(flat[idx * 2], flat[idx * 2 + 1], extent);
						pos.push(lon - ox, lat - oy); col.push(c[0], c[1], c[2], a);
					}
				}
			}
			if (pos.length) ops.push({ kind: "fill", li, id: L.id, pos: new Float32Array(pos), col: new Float32Array(col) });
		} else { // line
			const P1 = [], P2 = [], col = [], half = [];
			for (const f of feats) {
				const ctx = { zoom: z, props: f.props, geom: f.type, vars: {} };
				if (L.filter && !truthy(evalExpr(L.filter, ctx))) continue;
				const c = parseRGBA(pale(evalExpr(L.paint?.["line-color"] ?? "#000", ctx)));
				const op = L.paint?.["line-opacity"]; const a = c[3] * (op != null ? evalExpr(op, ctx) : 1);
				let w = evalExpr(L.paint?.["line-width"] ?? 1, ctx);
				if (typeof w !== "number" || isNaN(w) || w <= 0) w = 1;
				const hw = w * 0.5;
				for (const linePts of f.geom) {
					for (let i = 0; i + 1 < linePts.length; i++) {
						const A = linePts[i], B = linePts[i + 1];
						const dx = B.x - A.x, dy = B.y - A.y;
						const steps = Math.min(24, Math.max(1, Math.ceil(Math.hypot(dx, dy) / subLen)));  // 地形ドレープ用に細分
						for (let s = 0; s < steps; s++) {
							const t0 = s / steps, t1 = (s + 1) / steps;
							const [alon, alat] = toLL(A.x + dx * t0, A.y + dy * t0, extent);
							const [blon, blat] = toLL(A.x + dx * t1, A.y + dy * t1, extent);
							P1.push(alon - ox, alat - oy); P2.push(blon - ox, blat - oy);
							col.push(c[0], c[1], c[2], a); half.push(hw);
						}
					}
				}
			}
			if (half.length) ops.push({ kind: "line", li, id: L.id, P1: new Float32Array(P1), P2: new Float32Array(P2), col: new Float32Array(col), half: new Float32Array(half) });
		}
	}
	return { ops };
}

// sort-key 式があれば層内の地物を昇順に並べ替える（安定ソート）。無ければ元順のまま。
function sortFeatures(features, sortExpr, z) {
	if (!sortExpr) return features;
	return features
		.map((f, i) => ({ f, i, k: evalExpr(sortExpr, { zoom: z, props: f.props, geom: f.type, vars: {} }) }))
		.sort((a, b) => (a.k - b.k) || (a.i - b.i))
		.map(o => o.f);
}

// MVT のリング群を [flatCoords, holeIndices] のポリゴン単位に分割。
// 外周リング(正の面積)が新しいポリゴンを開始し、続く負の面積リングは穴。
function polygons(rings) {
	const out = [];
	let flat = null, holes = null, base = 0;
	for (const ring of rings) {
		const area = signedArea(ring);
		if (area >= 0 || !flat) {                 // 外周（または最初）
			if (flat && flat.length) out.push([flat, holes]);
			flat = []; holes = []; base = 0;
			for (const p of ring) flat.push(p.x, p.y);
			base = ring.length;
		} else {                                   // 穴
			holes.push(base);
			for (const p of ring) flat.push(p.x, p.y);
			base += ring.length;
		}
	}
	if (flat && flat.length) out.push([flat, holes]);
	return out;
}

function signedArea(ring) {
	let s = 0;
	for (let i = 0, n = ring.length; i < n; i++) {
		const a = ring[i], b = ring[(i + 1) % n];
		s += a.x * b.y - b.x * a.y;
	}
	return s / 2;
}
