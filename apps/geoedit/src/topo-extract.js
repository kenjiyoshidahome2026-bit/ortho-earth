// GeoJSON FeatureCollection → 編集用トポロジ（arcs＋符号付き参照）の抽出。純粋モジュール＝Node試験可。
// アルゴリズムは packages/geopbf/src/extension/topology.js（v3）の移植：junction判定は「無順序の隣接対
// {prev,next} が2種類以上現れた頂点」（出現回数法は共有ランを割り損ねる＝v3の教訓）。arc重複は
// 端点キー＋内容の前進/逆進照合で親子統合し、逆走参照は ~id（ビットNOT。-0問題を避ける topology.js の作法）。
// 座標は格子 10^-gridExp 度へ量子化した「度の値そのもの」（Float64）で持つ＝共有判定は量子化後の完全一致。
// gint(1e-7固定)と違い、格子＝スナップ段（e-3〜e-7）に連動するのが editor の要。
//
// 出力（buildTopology の戻り）:
//   arcs:  Map<arcId, { pts: Float64Array(lon,lat交互・量子化済), closed: bool, refs: Set<eid> }>
//   feats: Map<eid, { type, arcs, coords, properties }>
//     type: GeoJSON型名。arcs＝Polygon:[[signedId,…]ring…] / MultiPolygon:[poly[ring[…]]] /
//     LineString:[signedId,…] / MultiLineString:[line[…]]。Point系は coords（[[lon,lat],…]）のみ。
//   nodes: Map<nodeId, { x, y, ends: [[arcId, 0|1], …] }>   端点接続表＝端点移動の同時可動域
//
// GeometryCollection は v1 非対応（skip して warnings に積む）。閉輪の孤立arc（junction無し）は
// closed=true・pts の先頭=末尾（moveVertex が両端を同時に書く）。

const key2 = (m, x, y) => { let r = m.get(x); return r && r.get(y); };
const set2 = (m, x, y, v) => { let r = m.get(x); if (!r) m.set(x, (r = new Map())); r.set(y, v); };

// 量子化：度→格子上の度（丸め誤差を残さないため 10^N 整数を経由して戻す）
export const quantize = (v, e) => Math.round(v * e) / e;

// リング/ラインの量子化＋連続重複除去。リングは閉じを保証（先頭=末尾）、退化（実質2点未満のライン・
// 3頂点未満のリング）は null。
export function quantizeLine(coords, e, isRing) {
	const out = [];
	for (const c of coords) {
		const x = Math.round(c[0] * e) / e, y = Math.round(c[1] * e) / e;
		const n = out.length;
		if (n && out[n - 1][0] === x && out[n - 1][1] === y) continue;
		out.push([x, y]);
	}
	if (isRing) {
		const n = out.length;
		if (n >= 2 && out[0][0] === out[n - 1][0] && out[0][1] === out[n - 1][1]) out.pop();   // 一旦開いて扱う
		if (out.length < 3) return null;
	} else if (out.length < 2) return null;
	return out;
}

// ---- junction 検出（無順序隣接対法）----
// 各頂点キーに最初の隣接対を記録し、異なる対が来たら junction 確定。ラインの端点は常に junction。
function findJunctions(items, e) {
	const seen = new Map();        // qx → qy → {a:pairKey|null, j:bool}
	const mark = (x, y) => { const r = key2(seen, x, y); if (r) r.j = true; else set2(seen, x, y, { a: null, j: true }); };
	const visit = (x, y, px, py, nx, ny) => {
		// 隣接対キー＝無順序（前後を辞書順に正規化）。数値文字列で十分（1回きりの構築コスト）
		const a = px < nx || (px === nx && py <= ny) ? px + "," + py + "|" + nx + "," + ny : nx + "," + ny + "|" + px + "," + py;
		const r = key2(seen, x, y);
		if (!r) set2(seen, x, y, { a, j: false });
		else if (r.a !== a) r.j = true;
	};
	for (const { line, ring } of items) {
		const n = line.length;
		if (!ring) { mark(line[0][0], line[0][1]); mark(line[n - 1][0], line[n - 1][1]); }
		for (let i = ring ? 0 : 1; i < (ring ? n : n - 1); i++) {
			const p = line[(i - 1 + n) % n], c = line[i], nx = line[(i + 1) % n];
			visit(c[0], c[1], p[0], p[1], nx[0], nx[1]);
		}
	}
	return (x, y) => { const r = key2(seen, x, y); return !!(r && r.j); };
}

// ---- arc 登録（重複統合）----
function makeArcRegistry() {
	const byKey = new Map();   // "x0,y0|xn,yn|len"（無向＝両端を辞書順） → [arcId,…]
	const arcs = new Map();
	let nextId = 0;
	const same = (pts, seg, rev) => {
		const n = seg.length;
		for (let i = 0; i < n; i++) {
			const s = seg[rev ? n - 1 - i : i];
			if (pts[i * 2] !== s[0] || pts[i * 2 + 1] !== s[1]) return false;
		}
		return true;
	};
	return {
		arcs,
		register(seg, closed) {   // seg=[[x,y],…] → signedId
			const n = seg.length;
			const a = seg[0], b = seg[n - 1];
			const ka = a[0] + "," + a[1], kb = b[0] + "," + b[1];
			const k = (ka <= kb ? ka + "|" + kb : kb + "|" + ka) + "|" + n;
			let list = byKey.get(k);
			if (list) for (const id of list) {
				const arc = arcs.get(id);
				if (same(arc.pts, seg, false)) return id;
				if (same(arc.pts, seg, true)) return ~id;
			}
			const pts = new Float64Array(n * 2);
			for (let i = 0; i < n; i++) { pts[i * 2] = seg[i][0]; pts[i * 2 + 1] = seg[i][1]; }
			const id = nextId++;
			arcs.set(id, { pts, closed: !!closed, refs: new Set() });
			if (!list) byKey.set(k, (list = []));
			list.push(id);
			return id;
		},
	};
}

// リングを junction で切る。junction 無し＝孤立リング（正規開始点=最大y,x）を閉arc1本に。
function cutRing(ring, isJ, reg) {
	const n = ring.length;
	let first = -1;
	for (let i = 0; i < n; i++) if (isJ(ring[i][0], ring[i][1])) { first = i; break; }
	if (first < 0) {
		// 孤立リング＝入力の回転を保持する（topology.js は正準開始点=max y,x に回すが、editor は
		// 安定アドレス vi が再抽出を跨いで生きることを優先＝同一図形の重複dedupより回転不変が大事）
		const rot = ring.slice();
		rot.push(rot[0]);   // 閉じる（先頭=末尾で保持）
		return [reg.register(rot, true)];
	}
	const ids = [];
	let seg = [ring[first]];
	for (let i = 1; i <= n; i++) {
		const c = ring[(first + i) % n];
		seg.push(c);
		if (isJ(c[0], c[1])) { ids.push(reg.register(seg, false)); seg = [c]; }
	}
	return ids;
}

function cutLine(line, isJ, reg) {
	const ids = [];
	let seg = [line[0]];
	for (let i = 1; i < line.length; i++) {
		const c = line[i];
		seg.push(c);
		if (i < line.length - 1 && isJ(c[0], c[1])) { ids.push(reg.register(seg, false)); seg = [c]; }
	}
	ids.push(reg.register(seg, false));
	return ids;
}

// ---- 本体（ストリーム版）＝フィーチャを1個ずつ add して finish でトポロジ確定。
// GeoJSON FC を丸ごと持たない呼び出し（pbfバイト列直・モデル再抽出）のための形（8/20 GeoJSON追放）。
// add の呼び出し順＝仮id（skip でも採番は進む）＝呼び出し側の eids 並行配列と位置対応。
export function createExtractor(gridExp) {
	const e = Math.pow(10, gridExp);
	const feats = new Map();
	const warnings = [];
	const items = [];   // junction走査用の全ライン/リング
	const preps = [];   // [id, type, prepared geometry, properties]
	let eid = 0;

	function add(g, props = {}) {
		const id = eid++;
		if (!g || !Array.isArray(g.coordinates)) { warnings.push(`feature ${id}: geometry無し/不正＝skip`); return id; }   // moj実データに壊れfeatureあり（fid整列メモの族）
		const t = g.type;
		if (t === "Point" || t === "MultiPoint") {
			const cs = (t === "Point" ? [g.coordinates] : g.coordinates).map(c => [quantize(c[0], e), quantize(c[1], e)]);
			preps.push([id, t, cs, props]);
			return id;
		}
		if (t === "LineString" || t === "MultiLineString") {
			const lines = (t === "LineString" ? [g.coordinates] : g.coordinates).map(l => quantizeLine(l, e, false)).filter(Boolean);
			if (!lines.length) { warnings.push(`feature ${id}: 量子化で退化＝skip`); return id; }
			for (const line of lines) items.push({ line, ring: false });
			preps.push([id, t, lines, props]);
			return id;
		}
		if (t === "Polygon" || t === "MultiPolygon") {
			const polys = (t === "Polygon" ? [g.coordinates] : g.coordinates)
				.map(rings => rings.map(r => quantizeLine(r, e, true)).filter(Boolean)).filter(pl => pl.length);
			if (!polys.length) { warnings.push(`feature ${id}: 量子化で退化＝skip`); return id; }
			for (const pl of polys) for (const r of pl) items.push({ line: r, ring: true });
			preps.push([id, t, polys, props]);
			return id;
		}
		warnings.push(`feature ${id}: ${t} は v1 非対応＝skip`);
		return id;
	}

	function finish() {
		const isJ = findJunctions(items, e);
		const reg = makeArcRegistry();

		for (const [id, t, prep, props] of preps) {
			if (t === "Point" || t === "MultiPoint") { feats.set(id, { type: t, coords: prep, properties: props }); continue; }
			if (t === "LineString") feats.set(id, { type: t, arcs: cutLine(prep[0], isJ, reg), properties: props });
			else if (t === "MultiLineString") feats.set(id, { type: t, arcs: prep.map(l => cutLine(l, isJ, reg)), properties: props });
			else if (t === "Polygon") feats.set(id, { type: t, arcs: prep[0].map(r => cutRing(r, isJ, reg)), properties: props });
			else feats.set(id, { type: t, arcs: prep.map(pl => pl.map(r => cutRing(r, isJ, reg))), properties: props });
			// refs 逆引き（符号を剥がして本体arcへ）
			const walk = a => Array.isArray(a) ? a.forEach(walk) : reg.arcs.get(a < 0 ? ~a : a).refs.add(id);
			walk(feats.get(id).arcs);
		}

		// ---- ノード表（arc端点の接続）：端点座標キー → node。閉arcは両端=同一点＝1エントリで両端を代表 ----
		const nodes = new Map();
		const nodeAt = new Map();   // qx → qy → nodeId
		let nextNode = 0;
		for (const [id, arc] of reg.arcs) {
			const n = arc.pts.length / 2;
			for (const end of arc.closed ? [0] : [0, 1]) {
				const i = end ? n - 1 : 0;
				const x = arc.pts[i * 2], y = arc.pts[i * 2 + 1];
				let nid = key2(nodeAt, x, y);
				if (nid === undefined) { nid = nextNode++; set2(nodeAt, x, y, nid); nodes.set(nid, { x, y, ends: [] }); }
				if (arc.closed) nodes.get(nid).ends.push([id, 0], [id, 1]);
				else nodes.get(nid).ends.push([id, end]);
			}
		}

		return { gridExp, arcs: reg.arcs, feats, nodes, nextEid: eid, warnings };
	}

	return { add, finish };
}

export function buildTopology(fc, gridExp) {
	const ex = createExtractor(gridExp);
	for (const f of fc.features || []) ex.add(f?.geometry, f?.properties || {});
	return ex.finish();
}
