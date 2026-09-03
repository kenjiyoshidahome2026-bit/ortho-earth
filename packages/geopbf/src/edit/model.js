// 編集モデル（純粋モジュール＝Node試験可）。topo-extract の出力を包み、編集操作を提供する。
//
// 分類（プランの背骨）:
//   不変条件を保つ操作＝moveVertex/insertVertex/deleteVertex/movePoint/setProperties
//     → arc を直接書く。共有境界は「1本のarcをN個のフィーチャが参照」なので構造的に同時変形。
//       端点はノード（端点接続表）単位で全接続arcの端が一括で動く。再抽出は不要。
//   構造が変わる操作＝addFeature/deleteFeature
//     → 素朴に入れる（新フィーチャは自前arc・端点が既存ノードに一致すれば即接続）。既存arcの
//       内部頂点との共有化（junction分割）は controller が Worker でのトポロジ再抽出（デバウンス）
//       で回復する＝v1裁定「吸着は頂点のみ」の実装形。
//
// undo/redo のアドレスは arcId でなく GeoJSONレベルの安定アドレス {eid, path, vi}
// （vi＝そのリング/ラインの縫合後の頂点番号）＝トポロジ再抽出を跨いでも壊れない。
//
// メモリ注：スナップ索引は頂点1個=1エントリobject（{x,y,arcId,idx}）＝100万頂点で数十MB。
// v0はこれで進め、M8の実測で苦しければ TypedArray 化（arc毎の並行配列）に置換する。

import { buildTopology, createExtractor, quantize, quantizeLine } from "./topo-extract.js";
import { createSnapIndex, buildBase, normLon } from "./snap.js";

const sidOf = s => (s < 0 ? ~s : s);

// フィーチャの arc リスト列挙：[{path, list, ring}]（Point系は空）
export function listsOf(f) {
	if (f.type === "LineString") return [{ path: [], list: f.arcs, ring: false }];
	if (f.type === "MultiLineString") return f.arcs.map((l, i) => ({ path: [i], list: l, ring: false }));
	if (f.type === "Polygon") return f.arcs.map((r, i) => ({ path: [i], list: r, ring: true }));
	if (f.type === "MultiPolygon") return f.arcs.flatMap((p, i) => p.map((r, j) => ({ path: [i, j], list: r, ring: true })));
	return [];
}
// arc表と feats エントリから GeoJSON geometry を1個だけ縫合（モデル・Worker・エンコーダ共用＝FC全体は作らない）
export function stitchGeometry(arcs, f) {
	if (f.type === "Point") return { type: "Point", coordinates: f.coords[0] };
	if (f.type === "MultiPoint") return { type: "MultiPoint", coordinates: f.coords };
	const coordsOf = s => {
		const arc = arcs.get(s < 0 ? ~s : s), pts = arc.pts, n = pts.length / 2, out = new Array(n);
		for (let i = 0; i < n; i++) { const k = s < 0 ? n - 1 - i : i; out[i] = [pts[k * 2], pts[k * 2 + 1]]; }
		return out;
	};
	const st = list => {
		const out = coordsOf(list[0]);
		for (let k = 1; k < list.length; k++) { const c = coordsOf(list[k]); for (let i = 1; i < c.length; i++) out.push(c[i]); }
		return out;
	};
	if (f.type === "LineString") return { type: f.type, coordinates: st(f.arcs) };
	if (f.type === "MultiLineString" || f.type === "Polygon") return { type: f.type, coordinates: f.arcs.map(st) };
	return { type: f.type, coordinates: f.arcs.map(pt => pt.map(st)) };
}

// ---- @spline（滑らか曲線）＝正本はエンジンの anno ガジェット（ビューア再生と単一実装）。ここは再輸出のみ ----
export { smoothRing, smoothGeom } from "./spline.js";
const listAtPath = (f, path) => {
	if (f.type === "LineString") return f.arcs;
	if (f.type === "Polygon" || f.type === "MultiLineString") return f.arcs[path[0]];
	return f.arcs[path[0]][path[1]];
};

export function createModel(topo) {
	const m = {
		gridExp: topo.gridExp,
		arcs: topo.arcs,       // Map<arcId, {pts, closed, refs}>
		feats: topo.feats,     // Map<eid, {type, arcs|coords, properties}>
		nodes: topo.nodes,     // Map<nodeId, {x, y, ends:[[arcId,0|1],…]}>
		nextEid: topo.nextEid,
		warnings: topo.warnings || [],
	};
	// Math.max(...keys()) はスプレッド＝引数スタック積み＝数十万arcで RangeError（moj荒川区で実証 8/20）。ループで取る
	let nextArcId = 0, nextNodeId = 0;
	for (const k of m.arcs.keys()) if (k >= nextArcId) nextArcId = k + 1;
	for (const k of m.nodes.keys()) if (k >= nextNodeId) nextNodeId = k + 1;

	// ---- 逆引き表：arc端→node・座標→node ----
	const endNode = new Map();   // arcId → [nodeId(始端), nodeId(終端)]
	const nodeAt = new Map();    // "x,y"（量子化済の度） → nodeId（ノードは疎＝文字列キーで十分）
	const nkey = (x, y) => x + "," + y;
	for (const [nid, nd] of m.nodes) {
		nodeAt.set(nkey(nd.x, nd.y), nid);
		for (const [aid, end] of nd.ends) {
			let r = endNode.get(aid); if (!r) endNode.set(aid, (r = [null, null]));
			r[end] = nid;
		}
	}

	// ---- スナップ索引 v2（snap.js）：基底=Morton typed配列（Worker構築ならゼロコスト搭載）＋追記ジャーナル。
	//      座標は持たない＝deref がモデルの現在値を引く（削除/短縮は null で自動失効・墓標なし）----
	const uniqCount = arc => arc.pts.length / 2 - (arc.closed ? 1 : 0);
	const deref = (a, b) => {
		if (a >= 0) {
			const arc = m.arcs.get(a);
			if (!arc || b >= uniqCount(arc)) return null;
			return [arc.pts[b * 2], arc.pts[b * 2 + 1]];
		}
		const c = m.feats.get(-1 - a)?.coords?.[b];
		return c ? [c[0], c[1]] : null;
	};
	function* allRefs() {
		for (const [aid, arc] of m.arcs) { const u = uniqCount(arc); for (let i = 0; i < u; i++) yield [aid, i, arc.pts[i * 2], arc.pts[i * 2 + 1]]; }
		for (const [eid, f] of m.feats) if (f.coords) for (let i = 0; i < f.coords.length; i++) yield [-1 - eid, i, f.coords[i][0], f.coords[i][1]];
	}
	const snap = createSnapIndex(m.gridExp, deref);
	snap.setRefSource(allRefs);
	if (topo.snapBase) snap.setBase(topo.snapBase);   // Worker がソート済み基底を持参＝main コストゼロ
	else snap.rebuild();
	let indexing = true;   // translate ドラッグ中は追記を止め、drag終端で reindexFeature 一括（ジャーナル爆発の抑止）

	// ---- 縫合（toGeoJSON と addressing の共通規約）----
	const arcCoords = s => {
		const arc = m.arcs.get(sidOf(s)), pts = arc.pts, n = pts.length / 2, out = new Array(n);
		for (let i = 0; i < n; i++) { const k = s < 0 ? n - 1 - i : i; out[i] = [pts[k * 2], pts[k * 2 + 1]]; }
		return out;
	};
	const stitch = list => {
		const out = arcCoords(list[0]);
		for (let k = 1; k < list.length; k++) { const c = arcCoords(list[k]); for (let i = 1; i < c.length; i++) out.push(c[i]); }
		return out;
	};

	// ---- 安定アドレス（eid＋path＋縫合後頂点番号 vi）⇄（arcId＋idx）----
	const resolveAddr = ({ eid, path, vi }) => {
		const f = m.feats.get(eid), list = listAtPath(f, path);
		let off = 0;
		for (let k = 0; k < list.length; k++) {
			const s = list[k], n = m.arcs.get(sidOf(s)).pts.length / 2;
			const last = k === list.length - 1 ? off + n - 1 : off + n - 2;   // 継ぎ目頂点は次arcの0番に譲る
			if (vi <= last) { const local = vi - off; return { arcId: sidOf(s), idx: s < 0 ? n - 1 - local : local }; }
			off += n - 1;
		}
		return null;
	};
	const addrOf = (arcId, idx) => {
		const arc = m.arcs.get(arcId);
		const eid = arc.refs.values().next().value;
		const f = m.feats.get(eid);
		for (const { path, list, ring } of listsOf(f)) {
			let off = 0, hit = null;
			for (const s of list) {
				const n = m.arcs.get(sidOf(s)).pts.length / 2;
				if (hit === null && sidOf(s) === arcId) hit = off + (s < 0 ? n - 1 - idx : idx);
				off += n - 1;   // off の合計＝リングの一意頂点数（閉じ重複を除く）
			}
			if (hit !== null) return { eid, path, vi: ring && hit >= off ? 0 : hit };   // リング末尾＝先頭へ巻き戻し
		}
		return null;
	};

	// ---- 頂点移動（不変条件を保つ）----
	const setArcVertex = (aid, idx, x, y, dirty) => {
		const arc = m.arcs.get(aid), n = arc.pts.length / 2;
		arc.pts[idx * 2] = x; arc.pts[idx * 2 + 1] = y;
		if (arc.closed && (idx === 0 || idx === n - 1)) { const j = idx === 0 ? n - 1 : 0; arc.pts[j * 2] = x; arc.pts[j * 2 + 1] = y; }
		if (indexing) snap.addRef(aid, idx >= uniqCount(arc) ? 0 : idx, x, y);   // 新セルへ追記（旧掲載は実座標derefで自然失効）
		dirty.add(aid);
	};
	function moveVertex(arcId, idx, lon, lat) {
		const e = Math.pow(10, m.gridExp);
		const x = quantize(normLon(lon), e), y = quantize(lat, e);
		const arc = m.arcs.get(arcId), n = arc.pts.length / 2;
		const dirty = new Set();
		const from = [arc.pts[idx * 2], arc.pts[idx * 2 + 1]];
		const isEnd = idx === 0 || idx === n - 1;
		if (isEnd) {
			const nid = endNode.get(arcId)[idx === 0 ? 0 : 1];
			const nd = m.nodes.get(nid);
			nodeAt.delete(nkey(nd.x, nd.y));
			for (const [aid, end] of nd.ends) {
				const a = m.arcs.get(aid);
				setArcVertex(aid, end === 0 ? 0 : a.pts.length / 2 - 1, x, y, dirty);
			}
			nd.x = x; nd.y = y;
			nodeAt.set(nkey(x, y), nid);
		} else {
			setArcVertex(arcId, idx, x, y, dirty);
		}
		return { from, to: [x, y], dirty };
	}

	// ---- 頂点挿入/削除。索引は「挿入点＋末尾一意頂点」の追記だけ（中間のidxずれは基底参照が
	//      「別の実在頂点」を指すだけ＝スナップ先として依然正しい）。削除は追記すら不要（derefが自動失効）----
	function insertVertex(arcId, afterIdx, lon, lat) {
		const e = Math.pow(10, m.gridExp);
		const x = quantize(normLon(lon), e), y = quantize(lat, e);
		const arc = m.arcs.get(arcId), n = arc.pts.length / 2;
		const pts = new Float64Array((n + 1) * 2);
		pts.set(arc.pts.subarray(0, (afterIdx + 1) * 2), 0);
		pts[(afterIdx + 1) * 2] = x; pts[(afterIdx + 1) * 2 + 1] = y;
		pts.set(arc.pts.subarray((afterIdx + 1) * 2), (afterIdx + 2) * 2);
		arc.pts = pts;
		snap.addRef(arcId, afterIdx + 1, x, y);
		const u = uniqCount(arc);
		snap.addRef(arcId, u - 1, arc.pts[(u - 1) * 2], arc.pts[(u - 1) * 2 + 1]);   // 伸びた分＝末尾一意頂点も索引到達可能に
		return { arcId, idx: afterIdx + 1 };
	}
	// 環の固有頂点数（閉arc1本=n-1・開arcの連なり=Σ(n_i-1)）＝退化ガードは arc 単位でなく**環単位**で見る。
	// 共有辺を持つ三角形＝「共有arc(2点)＋自前の開arc(3点)」で、開arc単独の n<=2 判定は通ってしまい 2頂点の環に潰れた（9/4）。
	const ringUniq = list => { let u = 0; for (const s of list) u += m.arcs.get(sidOf(s)).pts.length / 2 - 1; return u; };
	function deleteVertex(arcId, idx) {
		const arc = m.arcs.get(arcId), n = arc.pts.length / 2;
		if (idx === 0 || idx === n - 1) return null;                    // 端点削除＝ノード併合はv1でやらない
		if (arc.closed ? n - 1 <= 3 : n <= 2) return null;              // 退化ガード（閉=3頂点/開=2頂点を下回らない）
		for (const eid of arc.refs) for (const { list, ring } of listsOf(m.feats.get(eid)))   // この arc を含む全ての環＝削除後も3頂点を保つ
			if (ring && list.some(s => sidOf(s) === arcId) && ringUniq(list) - 1 < 3) return null;
		const removed = [arc.pts[idx * 2], arc.pts[idx * 2 + 1]];
		const pts = new Float64Array((n - 1) * 2);
		pts.set(arc.pts.subarray(0, idx * 2), 0);
		pts.set(arc.pts.subarray((idx + 1) * 2), idx * 2);
		arc.pts = pts;
		return { removed };
	}

	// ---- フィーチャ平行移動（移動ツール✥）：自分のarc全頂点＋端点は「ノード単位」で動かす＝
	//      共有端の一貫性維持（隣のarcの端も一緒に動く＝境界が切れない）。共有arcは両者が変形（トポロジの掟）----
	function reindexFeature(eid) {   // translateドラッグ終端の一括追記（ドラッグ中は indexing=false）
		const f = m.feats.get(eid);
		if (!f) return;
		if (f.coords) { f.coords.forEach((c, i) => snap.addRef(-1 - eid, i, c[0], c[1])); return; }
		const seen = new Set();
		for (const { list } of listsOf(f)) for (const s of list) {
			const aid = sidOf(s);
			if (seen.has(aid)) continue;
			seen.add(aid);
			const arc = m.arcs.get(aid);
			for (let i = 0, u = uniqCount(arc); i < u; i++) snap.addRef(aid, i, arc.pts[i * 2], arc.pts[i * 2 + 1]);
		}
	}
	function translateFeature(eid, dx, dy, { index = true } = {}) {
		const e = Math.pow(10, m.gridExp);
		dx = Math.round(dx * e) / e; dy = Math.round(dy * e) / e;   // 格子上を保つ（デルタも格子倍数へ）
		if (!dx && !dy) return { d: [0, 0] };
		const f = m.feats.get(eid);
		if (!f) return null;
		const wasIndexing = indexing;
		indexing = index;
		try {
		if (f.coords) { f.coords.forEach((c, i) => movePoint(eid, i, c[0] + dx, c[1] + dy)); return { d: [dx, dy] }; }
		const dirty = new Set(), seenArc = new Set(), seenNode = new Set();
		for (const { list } of listsOf(f)) for (const s of list) {
			const aid = sidOf(s);
			if (seenArc.has(aid)) continue;
			seenArc.add(aid);
			const arc = m.arcs.get(aid), n = arc.pts.length / 2;
			for (const end of arc.closed ? [0] : [0, 1]) {
				const nid = endNode.get(aid)?.[end];
				if (nid == null || seenNode.has(nid)) continue;
				seenNode.add(nid);
				const nd = m.nodes.get(nid);
				nodeAt.delete(nkey(nd.x, nd.y));
				const nx = quantize(normLon(nd.x + dx), e), ny = quantize(nd.y + dy, e);
				for (const [aid2, end2] of nd.ends) {
					const a2 = m.arcs.get(aid2);
					setArcVertex(aid2, end2 === 0 ? 0 : a2.pts.length / 2 - 1, nx, ny, dirty);
				}
				nd.x = nx; nd.y = ny;
				nodeAt.set(nkey(nx, ny), nid);
			}
			for (let i = 1; i < n - 1; i++) setArcVertex(aid, i, quantize(normLon(arc.pts[i * 2] + dx), e), quantize(arc.pts[i * 2 + 1] + dy, e), dirty);
		}
		return { d: [dx, dy] };
		} finally { indexing = wasIndexing; }
	}

	// ---- ポイント移動 ----
	function movePoint(eid, ptIdx, lon, lat) {
		const e = Math.pow(10, m.gridExp);
		const x = quantize(normLon(lon), e), y = quantize(lat, e);
		const f = m.feats.get(eid);
		const from = [...f.coords[ptIdx]];
		f.coords[ptIdx] = [x, y];
		if (indexing) snap.addRef(-1 - eid, ptIdx, x, y);
		return { from, to: [x, y] };
	}

	// ---- 束ね（multi化）：同族の面/線を1フィーチャへ。ジオメトリ（arc）は無傷＝arc.refs を代表eidへ寄せ替えるだけ。
	//      snap索引/安定アドレスは arc を触らないので不変（＝再抽出不要・可逆）。点は snap 調整が要るため対象外。----
	const familyOf = t => (t === "Polygon" || t === "MultiPolygon") ? "poly" : (t === "LineString" || t === "MultiLineString") ? "line" : "point";
	function combineFeatures(eids) {
		if (!eids || eids.length < 2) return null;
		const feats = eids.map(e => m.feats.get(e));
		if (feats.some(f => !f)) return null;
		const fam = familyOf(feats[0].type);
		if (fam === "point" || feats.some(f => familyOf(f.type) !== fam)) return null;   // 同族の面/線のみ
		const parts = eids.map((e, i) => ({ eid: e, type: feats[i].type, arcs: JSON.parse(JSON.stringify(feats[i].arcs)), properties: { ...feats[i].properties } }));   // undo用スナップショット（arcは数値入れ子＝JSON複製で安全）
		const primary = eids[0], pf = feats[0];
		const units = [];   // Multi の単位列（面=[ring…]／線=[signed…]）を連結
		for (let i = 0; i < eids.length; i++) {
			const f = feats[i];
			if (f.type === "Polygon" || f.type === "LineString") units.push(f.arcs);   // 単一＝その入れ子が1単位
			else for (const u of f.arcs) units.push(u);                                 // Multi＝各単位を展開
			if (i > 0) for (const { list } of listsOf(f)) for (const s of list) m.arcs.get(sidOf(s))?.refs.delete(eids[i]);   // 非代表の参照を外す（共有境界はここで1本へ）
		}
		pf.type = fam === "poly" ? "MultiPolygon" : "MultiLineString";
		pf.arcs = units;
		for (const { list } of listsOf(pf)) for (const s of list) m.arcs.get(sidOf(s))?.refs.add(primary);   // 束ねた全arcを代表が所有
		for (let i = 1; i < eids.length; i++) m.feats.delete(eids[i]);
		return { eid: primary, parts };
	}
	function uncombineFeatures(parts) {   // combine の逆＝各パートを保存eidで元の型/arcsへ復元し refs を戻す
		if (!parts || !parts.length) return null;
		const pf = m.feats.get(parts[0].eid);   // 代表は今 Multi＝一旦 refs を剥がしてから各パートで貼り直す
		if (pf) for (const { list } of listsOf(pf)) for (const s of list) m.arcs.get(sidOf(s))?.refs.delete(parts[0].eid);
		for (const p of parts) {
			const f = { type: p.type, arcs: JSON.parse(JSON.stringify(p.arcs)), properties: { ...p.properties } };
			m.feats.set(p.eid, f);
			for (const { list } of listsOf(f)) for (const s of list) m.arcs.get(sidOf(s))?.refs.add(p.eid);   // 共有境界は各パートが自eidを足す＝元の集合に戻る
			if (p.eid >= m.nextEid) m.nextEid = p.eid + 1;
		}
		return true;
	}

	function splitFeature(eid, forcedEids) {   // 束ねの逆＝Multi を単位ごとに別フィーチャへ。先頭は eid を再利用・残りは新eid。
		const f = m.feats.get(eid);
		if (!f || (f.type !== "MultiPolygon" && f.type !== "MultiLineString")) return null;
		const units = f.arcs;   // 面=[poly…]／線=[line…]
		if (units.length < 2) return null;
		const childType = f.type === "MultiPolygon" ? "Polygon" : "LineString";
		const props = { ...f.properties };
		for (const { list } of listsOf(f)) for (const s of list) m.arcs.get(sidOf(s))?.refs.delete(eid);   // 一旦 refs を剥がす
		const made = [];
		units.forEach((unit, i) => {
			const e = i === 0 ? eid : (forcedEids?.[i - 1] ?? m.nextEid++);   // redo は保存eidを再利用（決定的）
			if (e >= m.nextEid) m.nextEid = e + 1;
			const nf = { type: childType, arcs: JSON.parse(JSON.stringify(unit)), properties: { ...props } };
			m.feats.set(e, nf);
			for (const { list } of listsOf(nf)) for (const s of list) m.arcs.get(sidOf(s))?.refs.add(e);   // 共有境界は各パートが自eidを足す
			if (i > 0) made.push(e);
		});
		return { eids: made };
	}

	// ---- 穴（内環）：選択ポリゴンへ 1 リング追加/除去。向きは外環と逆へ正規化（winding-sum塗りで穴になる条件）----
	const shoelace = coords => {   // 符号付き面積（開リング前提）
		let a = 0;
		for (let i = 0, n = coords.length; i < n; i++) { const p = coords[i], q = coords[(i + 1) % n]; a += p[0] * q[1] - q[0] * p[1]; }
		return a / 2;
	};
	const pointInRing = (x, y, coords) => {   // 開リング・偶奇則
		let inside = false;
		for (let i = 0, n = coords.length, j = n - 1; i < n; j = i++) {
			const [xi, yi] = coords[i], [xj, yj] = coords[j];
			if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
		}
		return inside;
	};
	function addHole(eid, ring) {
		const f = m.feats.get(eid);
		if (!f || !f.type.includes("Poly")) return null;
		const e = Math.pow(10, m.gridExp);
		const open = quantizeLine(ring, e, true);
		if (!open) return null;
		// 置き場所＝穴の1点目を外環に含む part（Polygon は単一 part）
		let part = 0;
		if (f.type === "MultiPolygon") {
			part = f.arcs.findIndex(p => pointInRing(open[0][0], open[0][1], stitch(p[0]).slice(0, -1)));
			if (part < 0) return null;
		}
		const outerList = f.type === "Polygon" ? f.arcs[0] : f.arcs[part][0];
		if ((shoelace(open) > 0) === (shoelace(stitch(outerList).slice(0, -1)) > 0)) open.reverse();   // 外環と逆回り＝穴
		const pts = new Float64Array((open.length + 1) * 2);
		open.forEach((c, i) => { pts[i * 2] = c[0]; pts[i * 2 + 1] = c[1]; });
		pts[open.length * 2] = open[0][0]; pts[open.length * 2 + 1] = open[0][1];   // 閉じる（先頭=末尾）
		const aid = nextArcId++;
		const arc = { pts, closed: true, refs: new Set([eid]) };
		m.arcs.set(aid, arc);
		for (let i = 0, u = uniqCount(arc); i < u; i++) snap.addRef(aid, i, pts[i * 2], pts[i * 2 + 1]);
		// ノード接続（閉arc＝両端が同一ノード。既存ノード座標に一致すれば合流）
		const x = pts[0], y = pts[1];
		let nid = nodeAt.get(nkey(x, y));
		if (nid === undefined) { nid = nextNodeId++; nodeAt.set(nkey(x, y), nid); m.nodes.set(nid, { x, y, ends: [] }); }
		m.nodes.get(nid).ends.push([aid, 0], [aid, 1]);
		endNode.set(aid, [nid, nid]);
		const ringList = [aid];
		if (f.type === "Polygon") { f.arcs.push(ringList); return { path: [f.arcs.length - 1] }; }
		f.arcs[part].push(ringList);
		return { path: [part, f.arcs[part].length - 1] };
	}
	const dropArcIfOrphan = (eid, aid) => {   // この feature から参照が消えた arc の後始末（deleteFeature と同じ規約）
		const f = m.feats.get(eid);
		for (const { list } of listsOf(f)) for (const s of list) if (sidOf(s) === aid) return;   // まだ使っている
		const arc = m.arcs.get(aid);
		if (!arc) return;
		arc.refs.delete(eid);
		if (arc.refs.size) return;   // 索引掃除は不要＝arcs から消えれば deref が null（自動失効）
		for (const end of [0, 1]) {
			const nid = endNode.get(aid)?.[end];
			if (nid == null) continue;
			const nd = m.nodes.get(nid);
			if (!nd) continue;
			nd.ends = nd.ends.filter(([a]) => a !== aid);
			if (!nd.ends.length) { m.nodes.delete(nid); nodeAt.delete(nkey(nd.x, nd.y)); }
		}
		endNode.delete(aid);
		m.arcs.delete(aid);
	};
	function removeRing(eid, path) {   // path＝addHole の戻り（[ringIdx] / [part, ringIdx]）。外環(0)は対象外
		const f = m.feats.get(eid);
		if (!f || path[path.length - 1] === 0) return null;
		const rings = f.type === "Polygon" ? f.arcs : f.arcs[path[0]];
		const ringList = rings.splice(path[path.length - 1], 1)[0];
		if (!ringList) return null;
		const removed = stitch(ringList);
		for (const s of ringList) dropArcIfOrphan(eid, sidOf(s));
		return { removed };
	}

	// ---- 構造操作：追加（素朴＝自前arc。端点が既存ノード座標に一致すれば即接続）・削除 ----
	function addFeature(gf, forcedEid) {
		const sub = buildTopology({ features: [gf] }, m.gridExp);
		if (!sub.feats.size) return null;
		const eid = forcedEid ?? m.nextEid++;
		if (forcedEid != null) m.nextEid = Math.max(m.nextEid, forcedEid + 1);
		const remap = new Map();
		for (const [aid, arc] of sub.arcs) {
			const nid = nextArcId++;
			remap.set(aid, nid);
			arc.refs = new Set([eid]);
			m.arcs.set(nid, arc);
			for (let i = 0, u = uniqCount(arc); i < u; i++) snap.addRef(nid, i, arc.pts[i * 2], arc.pts[i * 2 + 1]);
		}
		const f = sub.feats.values().next().value;
		const remapSid = s => (s < 0 ? ~remap.get(~s) : remap.get(s));
		const walk = a => Array.isArray(a) ? a.map(walk) : remapSid(a);
		if (f.arcs) f.arcs = walk(f.arcs);
		m.feats.set(eid, f);
		if (f.coords) f.coords.forEach((c, i) => snap.addRef(-1 - eid, i, c[0], c[1]));
		// 端点接続：既存ノード座標に一致＝そのノードへ合流（境界の同時可動が即日効く）。無ければ新ノード
		for (const [said, arc] of sub.arcs) {
			const aid = remap.get(said), n = arc.pts.length / 2;
			for (const end of arc.closed ? [0] : [0, 1]) {
				const i = end ? n - 1 : 0;
				const x = arc.pts[i * 2], y = arc.pts[i * 2 + 1];
				let nid = nodeAt.get(nkey(x, y));
				if (nid === undefined) { nid = nextNodeId++; nodeAt.set(nkey(x, y), nid); m.nodes.set(nid, { x, y, ends: [] }); }
				const nd = m.nodes.get(nid);
				if (arc.closed) nd.ends.push([aid, 0], [aid, 1]);
				else nd.ends.push([aid, end]);
				let r = endNode.get(aid); if (!r) endNode.set(aid, (r = [null, null]));
				if (arc.closed) { r[0] = r[1] = nid; } else r[end] = nid;
			}
		}
		return eid;
	}
	function deleteFeature(eid) {
		const f = m.feats.get(eid);
		if (!f) return null;
		const snapshot = featureGeoJSON(eid, false);
		for (const { list } of listsOf(f)) for (const s of list) {
			const aid = sidOf(s), arc = m.arcs.get(aid);
			if (!arc) continue;
			arc.refs.delete(eid);
			if (!arc.refs.size) {   // 索引は deref 自動失効＝掃除不要
				for (const end of [0, 1]) {
					const nid = endNode.get(aid)?.[end];
					if (nid === undefined || nid === null) continue;
					const nd = m.nodes.get(nid);
					if (!nd) continue;   // 閉arc＝両端が同一ノード＝1周目で消えていることがある
					nd.ends = nd.ends.filter(([a]) => a !== aid);
					if (!nd.ends.length) { m.nodes.delete(nid); nodeAt.delete(nkey(nd.x, nd.y)); }
				}
				endNode.delete(aid);
				m.arcs.delete(aid);
			}
		}
		m.feats.delete(eid);   // ポイント索引も deref 自動失効
		return snapshot;
	}

	// ---- GeoJSON 出力 ----
	function featureGeoJSON(eid, withEid) {
		const f = m.feats.get(eid);
		const properties = withEid ? { ...f.properties, __eid: eid } : { ...f.properties };
		return { type: "Feature", properties, geometry: stitchGeometry(m.arcs, f) };
	}
	const toGeoJSON = ({ eid = false } = {}) =>
		({ type: "FeatureCollection", features: [...m.feats.keys()].sort((a, b) => a - b).map(id => featureGeoJSON(id, eid)) });   // eid昇順＝削除undo（末尾再挿入）でも出力順が揺れない

	// ---- コマンド（history 用）：apply は再抽出を跨いでも安定アドレスで届く。
	//      undo に要る事後情報（挿入後アドレス・削除座標・確定eid・削除スナップショット）は apply が
	//      cmd へ書き戻す＝コマンドは1回の apply で自己完結する（redo も同じ経路）。 ----
	// 番地の内容検証つき解決（move用の安全網）：再抽出でリングの縫合開始が動く稀な場合に備え、
	// 解決先の現座標が expect と違えば同じリスト内を座標一致で探し直す（量子化済＝完全一致で引ける）
	const resolveAddrExpect = (addr, expect) => {
		const r = resolveAddr(addr);
		if (r) {
			const a = m.arcs.get(r.arcId);
			if (a.pts[r.idx * 2] === expect[0] && a.pts[r.idx * 2 + 1] === expect[1]) return r;
		}
		const f = m.feats.get(addr.eid), list = listAtPath(f, addr.path);
		for (const s of list) {
			const aid = sidOf(s), a = m.arcs.get(aid), n = a.pts.length / 2;
			for (let i = 0; i < n; i++) if (a.pts[i * 2] === expect[0] && a.pts[i * 2 + 1] === expect[1]) return { arcId: aid, idx: i };
		}
		return r;
	};
	function applyCmd(cmd) {
		if (cmd.op === "move") { const r = resolveAddrExpect(cmd.addr, cmd.from); return moveVertex(r.arcId, r.idx, cmd.to[0], cmd.to[1]); }
		if (cmd.op === "movePt") return movePoint(cmd.eid, cmd.ptIdx, cmd.to[0], cmd.to[1]);
		if (cmd.op === "tr") return translateFeature(cmd.eid, cmd.d[0], cmd.d[1]);
		if (cmd.op === "insert") {
			const r = resolveAddr(cmd.addr);
			const res = insertVertex(r.arcId, r.idx, cmd.ll[0], cmd.ll[1]);
			cmd.addrNew = addrOf(res.arcId, res.idx);
			return res;
		}
		if (cmd.op === "delete") {
			const a = resolveAddr(cmd.addr);
			const res = deleteVertex(a.arcId, a.idx);
			if (res && !cmd.ll) cmd.ll = res.removed;
			return res;
		}
		if (cmd.op === "hole") {
			const res = addHole(cmd.eid, cmd.ring);
			if (res) cmd.path = res.path;   // undo（unhole）用に確定位置を書き戻す
			return res;
		}
		if (cmd.op === "unhole") return removeRing(cmd.eid, cmd.path);
		if (cmd.op === "combine") { const r = combineFeatures(cmd.eids); if (r) cmd.parts = r.parts; return r ? r.eid : null; }   // parts＝undo用スナップショットを書き戻す
		if (cmd.op === "uncombine") return uncombineFeatures(cmd.parts);
		if (cmd.op === "split") { const r = splitFeature(cmd.eid, cmd.newEids); if (r) cmd.newEids = r.eids; return r ? true : null; }   // newEids＝redo決定化のため書き戻す
		if (cmd.op === "add") { cmd.eid = addFeature(cmd.feature, cmd.eid); return cmd.eid; }
		if (cmd.op === "del") {
			if (!cmd.feature) cmd.feature = featureGeoJSON(cmd.eid, false);
			return deleteFeature(cmd.eid);
		}
		if (cmd.op === "props") { m.feats.get(cmd.eid).properties = cmd.to; return true; }
	}
	function invertCmd(cmd) {
		if (cmd.op === "move" || cmd.op === "movePt" || cmd.op === "props") return { ...cmd, from: cmd.to, to: cmd.from };
		if (cmd.op === "tr") return { op: "tr", eid: cmd.eid, d: [-cmd.d[0], -cmd.d[1]] };
		if (cmd.op === "insert") return { op: "delete", addr: cmd.addrNew, ll: cmd.ll };
		if (cmd.op === "hole") return { op: "unhole", eid: cmd.eid, path: cmd.path, ring: cmd.ring };
		if (cmd.op === "unhole") return { op: "hole", eid: cmd.eid, ring: cmd.ring };
		if (cmd.op === "combine") return { op: "uncombine", parts: cmd.parts };
		if (cmd.op === "uncombine") return { op: "combine", eids: cmd.parts.map(p => p.eid) };
		if (cmd.op === "split") return { op: "combine", eids: [cmd.eid, ...(cmd.newEids || [])] };
		// 削除の逆＝「1つ前の頂点の後ろへ」挿入。v1は内部頂点しか消せない＝vi≥1 が保証される
		if (cmd.op === "delete") return { op: "insert", addr: { ...cmd.addr, vi: cmd.addr.vi - 1 }, ll: cmd.ll };
		if (cmd.op === "add") return { op: "del", eid: cmd.eid, feature: cmd.feature };
		if (cmd.op === "del") return { op: "add", eid: cmd.eid, feature: cmd.feature };
	}

	// ---- 格子切替：以後の配置/移動にのみ効く（既存座標は再量子化しない＝v1裁定）----
	function setGrid(gridExp) {
		m.gridExp = gridExp;
		snap.setGrid(gridExp);   // セル寸変更＝基底を allRefs から焼き直し
	}

	let vcount = 0;
	for (const arc of m.arcs.values()) vcount += arc.pts.length / 2;

	return Object.assign(m, {
		snap, moveVertex, insertVertex, deleteVertex, movePoint, translateFeature, reindexFeature, addFeature, deleteFeature, addHole, removeRing, pointInRing,
		toGeoJSON, featureGeoJSON, addrOf, resolveAddr, applyCmd, invertCmd, setGrid, stitch, arcCoords, listsOf, familyOf,
		endNodeOf: (aid, end) => endNode.get(aid)?.[end],
		stats: () => ({ features: m.feats.size, arcs: m.arcs.size, vertices: vcount }),
	});
}

// ---- トポロジ再抽出（eid保存）：構造操作（フィーチャ追加/削除）の後に呼ぶと共有が回復する。
//      素朴追加で入った複製arcが junction 検出＋arc照合で共有arcへ統合される。安定アドレス
//      {eid,path,vi} は縫合後頂点番号＝再抽出で不変（これが undo/redo を跨げる根拠）。
//      小〜中規模は main で直接、大規模は controller が model-worker 経由で同じことをする。 ----
// 再抽出（構造操作後の共有回復）＝GeoJSON中間を作らない：モデルのフィーチャを1個ずつ縫合して
// extractor へ流す。eid は「投入順」の並行配列で保存（__eid プロパティは全廃 8/20＝propTub対策は
// コミット側の一意 __eid 注入だけに残る）。main同期（小規模）と Worker（retopoモード）で同じ規約。
export function retopoTopo(model) {   // → { topo, eids }
	const ex = createExtractor(model.gridExp);
	const eids = [...model.feats.keys()].sort((a, b) => a - b);
	for (const eid of eids) {
		const f = model.feats.get(eid);
		ex.add(stitchGeometry(model.arcs, f), f.properties);
	}
	return { topo: ex.finish(), eids };
}
export function adoptRebuilt(topo, eids, old) {   // topo.feats の仮id（投入順）→ eids[i] へ付け替え
	const remap = new Map();
	const feats = new Map();
	for (const [tmp, f] of topo.feats) { const eid = eids[tmp]; remap.set(tmp, eid); feats.set(eid, f); }
	for (const arc of topo.arcs.values()) arc.refs = new Set([...arc.refs].map(t => remap.get(t)));
	topo.feats = feats;
	topo.nextEid = old.nextEid;
	return createModel(topo);
}
export function rebuildModel(old) {
	const { topo, eids } = retopoTopo(old);
	return adoptRebuilt(topo, eids, old);
}

// ---- Worker 転送（構築は Worker・編集は main）----
// arcs を flat Float64Array＋meta(Int32Array: offset,count,closed×n)へ、feats は JSON 化。
// refs/nodes は main 側で再構成（O(arcs)＝安い）。pts は big buffer 上の view＝コピーゼロ。
function* topoRefs(topo) {   // snap基底の材料（allRefs と同じ規約＝topo構造の上で）
	const uniq = arc => arc.pts.length / 2 - (arc.closed ? 1 : 0);
	for (const [aid, arc] of topo.arcs) { const u = uniq(arc); for (let i = 0; i < u; i++) yield [aid, i, arc.pts[i * 2], arc.pts[i * 2 + 1]]; }
	for (const [eid, f] of topo.feats) if (f.coords) for (let i = 0; i < f.coords.length; i++) yield [-1 - eid, i, f.coords[i][0], f.coords[i][1]];
}
export function topoToTransfer(topo, { snap: withSnap = true } = {}) {
	const snap = withSnap ? buildBase(topoRefs(topo), topo.gridExp) : null;   // Worker側でソート＝mainゼロコスト（送り便は省略可）
	let total = 0;
	for (const arc of topo.arcs.values()) total += arc.pts.length;
	const flat = new Float64Array(total);
	const meta = new Int32Array(topo.arcs.size * 3);
	let off = 0, i = 0;
	const order = [];
	for (const [aid, arc] of topo.arcs) {
		flat.set(arc.pts, off);
		meta[i * 3] = off; meta[i * 3 + 1] = arc.pts.length; meta[i * 3 + 2] = arc.closed ? 1 : 0;
		order.push(aid); off += arc.pts.length; i++;
	}
	const feats = [...topo.feats].map(([eid, f]) => [eid, { type: f.type, arcs: f.arcs, coords: f.coords, properties: f.properties }]);
	return {
		payload: { flat, meta, order, feats, snap, gridExp: topo.gridExp, nextEid: topo.nextEid, warnings: topo.warnings },
		transfer: snap ? [flat.buffer, snap.codes.buffer, snap.refA.buffer, snap.refB.buffer] : [flat.buffer],
	};
}
export function topoFromTransfer(p) {
	const arcs = new Map();
	for (let i = 0; i < p.order.length; i++)
		arcs.set(p.order[i], { pts: new Float64Array(p.flat.buffer, p.meta[i * 3] * 8, p.meta[i * 3 + 1]), closed: !!p.meta[i * 3 + 2], refs: new Set() });
	const feats = new Map(p.feats);
	for (const [eid, f] of feats) if (f.arcs) {
		const walk = a => Array.isArray(a) ? a.forEach(walk) : arcs.get(a < 0 ? ~a : a).refs.add(eid);
		walk(f.arcs);
	}
	// ノード表を再構成（topo-extract と同じ規約）
	const nodes = new Map(), nodeAt = new Map();
	let nextNode = 0;
	const key = (x, y) => x + "," + y;
	for (const [aid, arc] of arcs) {
		const n = arc.pts.length / 2;
		for (const end of arc.closed ? [0] : [0, 1]) {
			const i = end ? n - 1 : 0;
			const x = arc.pts[i * 2], y = arc.pts[i * 2 + 1];
			let nid = nodeAt.get(key(x, y));
			if (nid === undefined) { nid = nextNode++; nodeAt.set(key(x, y), nid); nodes.set(nid, { x, y, ends: [] }); }
			if (arc.closed) nodes.get(nid).ends.push([aid, 0], [aid, 1]);
			else nodes.get(nid).ends.push([aid, end]);
		}
	}
	return { gridExp: p.gridExp, arcs, feats, nodes, snapBase: p.snap ?? null, nextEid: p.nextEid, warnings: p.warnings || [] };
}
