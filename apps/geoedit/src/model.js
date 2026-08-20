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

import { buildTopology, quantize, quantizeLine } from "./topo-extract.js";
import { createSnapIndex, normLon } from "./snap.js";

const sidOf = s => (s < 0 ? ~s : s);

// フィーチャの arc リスト列挙：[{path, list, ring}]（Point系は空）
export function listsOf(f) {
	if (f.type === "LineString") return [{ path: [], list: f.arcs, ring: false }];
	if (f.type === "MultiLineString") return f.arcs.map((l, i) => ({ path: [i], list: l, ring: false }));
	if (f.type === "Polygon") return f.arcs.map((r, i) => ({ path: [i], list: r, ring: true }));
	if (f.type === "MultiPolygon") return f.arcs.flatMap((p, i) => p.map((r, j) => ({ path: [i, j], list: r, ring: true })));
	return [];
}
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

	// ---- スナップ索引（全頂点）。entry は arc毎/フィーチャ毎の並行配列で持ち、idxずれを一括補正する ----
	const snap = createSnapIndex(m.gridExp);
	const arcEntries = new Map();    // arcId → [entry aligned to idx]（閉arcの末尾重複頂点は索引に入れない）
	const ptEntries = new Map();     // eid → [entry aligned to ptIdx]
	const uniqCount = arc => arc.pts.length / 2 - (arc.closed ? 1 : 0);
	const indexArc = (aid, arc) => {
		const n = uniqCount(arc), list = new Array(n);
		for (let i = 0; i < n; i++) { const en = { x: arc.pts[i * 2], y: arc.pts[i * 2 + 1], arcId: aid, idx: i }; list[i] = en; snap.add(en); }
		arcEntries.set(aid, list);
	};
	const unindexArc = aid => { const l = arcEntries.get(aid); if (l) for (const en of l) snap.remove(en); arcEntries.delete(aid); };
	const indexPoints = (eid, f) => {
		const list = f.coords.map((c, i) => { const en = { x: c[0], y: c[1], eid, ptIdx: i }; snap.add(en); return en; });
		ptEntries.set(eid, list);
	};
	for (const [aid, arc] of m.arcs) indexArc(aid, arc);
	for (const [eid, f] of m.feats) if (f.coords) indexPoints(eid, f);

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
		const u = uniqCount(arc);
		const en = arcEntries.get(aid)[idx >= u ? 0 : idx];   // 閉arcの末尾重複頂点→索引エントリは0番が代表
		if (en) snap.move(en, x, y);
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

	// ---- 頂点挿入/削除（対象arcのみ・索引のidxずれは尾側を一括補正）----
	const shiftEntries = (aid, fromIdx, delta) => {
		const list = arcEntries.get(aid);
		for (let i = fromIdx; i < list.length; i++) list[i].idx += delta;
	};
	function insertVertex(arcId, afterIdx, lon, lat) {
		const e = Math.pow(10, m.gridExp);
		const x = quantize(normLon(lon), e), y = quantize(lat, e);
		const arc = m.arcs.get(arcId), n = arc.pts.length / 2;
		const pts = new Float64Array((n + 1) * 2);
		pts.set(arc.pts.subarray(0, (afterIdx + 1) * 2), 0);
		pts[(afterIdx + 1) * 2] = x; pts[(afterIdx + 1) * 2 + 1] = y;
		pts.set(arc.pts.subarray((afterIdx + 1) * 2), (afterIdx + 2) * 2);
		arc.pts = pts;
		const en = { x, y, arcId, idx: afterIdx + 1 };
		const list = arcEntries.get(arcId);
		list.splice(afterIdx + 1, 0, en);
		shiftEntries(arcId, afterIdx + 2, +1);
		snap.add(en);
		return { arcId, idx: afterIdx + 1 };
	}
	function deleteVertex(arcId, idx) {
		const arc = m.arcs.get(arcId), n = arc.pts.length / 2;
		if (idx === 0 || idx === n - 1) return null;                    // 端点削除＝ノード併合はv1でやらない
		if (arc.closed ? n - 1 <= 3 : n <= 2) return null;              // 退化ガード（閉=3頂点/開=2頂点を下回らない）
		const removed = [arc.pts[idx * 2], arc.pts[idx * 2 + 1]];
		const pts = new Float64Array((n - 1) * 2);
		pts.set(arc.pts.subarray(0, idx * 2), 0);
		pts.set(arc.pts.subarray((idx + 1) * 2), idx * 2);
		arc.pts = pts;
		const list = arcEntries.get(arcId);
		snap.remove(list[idx]);
		list.splice(idx, 1);
		shiftEntries(arcId, idx, -1);
		return { removed };
	}

	// ---- フィーチャ平行移動（移動ツール✥）：自分のarc全頂点＋端点は「ノード単位」で動かす＝
	//      共有端の一貫性維持（隣のarcの端も一緒に動く＝境界が切れない）。共有arcは両者が変形（トポロジの掟）----
	function translateFeature(eid, dx, dy) {
		const e = Math.pow(10, m.gridExp);
		dx = Math.round(dx * e) / e; dy = Math.round(dy * e) / e;   // 格子上を保つ（デルタも格子倍数へ）
		if (!dx && !dy) return { d: [0, 0] };
		const f = m.feats.get(eid);
		if (!f) return null;
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
	}

	// ---- ポイント移動 ----
	function movePoint(eid, ptIdx, lon, lat) {
		const e = Math.pow(10, m.gridExp);
		const x = quantize(normLon(lon), e), y = quantize(lat, e);
		const f = m.feats.get(eid);
		const from = [...f.coords[ptIdx]];
		f.coords[ptIdx] = [x, y];
		snap.move(ptEntries.get(eid)[ptIdx], x, y);
		return { from, to: [x, y] };
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
		indexArc(aid, arc);
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
		if (arc.refs.size) return;
		unindexArc(aid);
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
			indexArc(nid, arc);
		}
		const f = sub.feats.values().next().value;
		const remapSid = s => (s < 0 ? ~remap.get(~s) : remap.get(s));
		const walk = a => Array.isArray(a) ? a.map(walk) : remapSid(a);
		if (f.arcs) f.arcs = walk(f.arcs);
		m.feats.set(eid, f);
		if (f.coords) indexPoints(eid, f);
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
			if (!arc.refs.size) {
				unindexArc(aid);
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
		if (f.coords) { for (const en of ptEntries.get(eid) || []) snap.remove(en); ptEntries.delete(eid); }
		m.feats.delete(eid);
		return snapshot;
	}

	// ---- GeoJSON 出力 ----
	function featureGeoJSON(eid, withEid) {
		const f = m.feats.get(eid);
		let coordinates;
		if (f.type === "Point") coordinates = f.coords[0];
		else if (f.type === "MultiPoint") coordinates = f.coords;
		else if (f.type === "LineString") coordinates = stitch(f.arcs);
		else if (f.type === "MultiLineString") coordinates = f.arcs.map(stitch);
		else if (f.type === "Polygon") coordinates = f.arcs.map(stitch);
		else coordinates = f.arcs.map(p => p.map(stitch));
		const properties = withEid ? { ...f.properties, __eid: eid } : { ...f.properties };
		return { type: "Feature", properties, geometry: { type: f.type, coordinates } };
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
		// 削除の逆＝「1つ前の頂点の後ろへ」挿入。v1は内部頂点しか消せない＝vi≥1 が保証される
		if (cmd.op === "delete") return { op: "insert", addr: { ...cmd.addr, vi: cmd.addr.vi - 1 }, ll: cmd.ll };
		if (cmd.op === "add") return { op: "del", eid: cmd.eid, feature: cmd.feature };
		if (cmd.op === "del") return { op: "add", eid: cmd.eid, feature: cmd.feature };
	}

	// ---- 格子切替：以後の配置/移動にのみ効く（既存座標は再量子化しない＝v1裁定）----
	function setGrid(gridExp) {
		m.gridExp = gridExp;
		const all = function* () { for (const l of arcEntries.values()) yield* l; for (const l of ptEntries.values()) yield* l; };
		snap.setGrid(gridExp, all());
	}

	let vcount = 0;
	for (const arc of m.arcs.values()) vcount += arc.pts.length / 2;

	return Object.assign(m, {
		snap, moveVertex, insertVertex, deleteVertex, movePoint, translateFeature, addFeature, deleteFeature, addHole, removeRing, pointInRing,
		toGeoJSON, featureGeoJSON, addrOf, resolveAddr, applyCmd, invertCmd, setGrid, stitch, arcCoords, listsOf,
		endNodeOf: (aid, end) => endNode.get(aid)?.[end],
		stats: () => ({ features: m.feats.size, arcs: m.arcs.size, vertices: vcount }),
	});
}

// ---- トポロジ再抽出（eid保存）：構造操作（フィーチャ追加/削除）の後に呼ぶと共有が回復する。
//      素朴追加で入った複製arcが junction 検出＋arc照合で共有arcへ統合される。安定アドレス
//      {eid,path,vi} は縫合後頂点番号＝再抽出で不変（これが undo/redo を跨げる根拠）。
//      小〜中規模は main で直接、大規模は controller が model-worker 経由で同じことをする。 ----
export function adoptRebuilt(topo, old) {   // topo＝__eid入り fc から構築されたもの（main直・Worker転送後どちらでも）
	const remap = new Map();   // 仮eid（fc順） → 本来のeid（__eid）
	const feats = new Map();
	for (const [tmp, f] of topo.feats) {
		const eid = f.properties.__eid;
		remap.set(tmp, eid);
		const props = { ...f.properties };
		delete props.__eid;
		f.properties = props;
		feats.set(eid, f);
	}
	for (const arc of topo.arcs.values()) arc.refs = new Set([...arc.refs].map(t => remap.get(t)));
	topo.feats = feats;
	topo.nextEid = old.nextEid;
	return createModel(topo);
}
export function rebuildModel(old) {
	return adoptRebuilt(buildTopology(old.toGeoJSON({ eid: true }), old.gridExp), old);
}

// ---- Worker 転送（構築は Worker・編集は main）----
// arcs を flat Float64Array＋meta(Int32Array: offset,count,closed×n)へ、feats は JSON 化。
// refs/nodes は main 側で再構成（O(arcs)＝安い）。pts は big buffer 上の view＝コピーゼロ。
export function topoToTransfer(topo) {
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
		payload: { flat, meta, order, feats, gridExp: topo.gridExp, nextEid: topo.nextEid, warnings: topo.warnings },
		transfer: [flat.buffer],
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
	return { gridExp: p.gridExp, arcs, feats, nodes, nextEid: p.nextEid, warnings: p.warnings || [] };
}
