import { gint } from "./gint.js";

// GintBUF のフォーマット版。レイアウトを変えたら必ず上げる：unPackGintBuffer が版不一致を拒否し、
// pbf-io.load が「キャッシュのPBFから再焼き」で自己修復する（版なし時代、polyStream/lineStream 導入(v2レイアウト)を
// 旧版キャッシュが新リーダで読まれて海岸線が全端末で黙って消えた——ETag はソース PBF の版であって派生物の版ではない）。
topology.FORMAT_VERSION = 5;   // v5: 度アンカーを大円補間に（完全球体＝頂点は大円で結ぶ・parse 時の経緯度線形 densify は撤去）＝旧キャッシュは再焼き。v4: 度アンカー（1°ごとの L1）挿入。v3: 接合点判定を出現回数→neighbor-pair方式に

export function topology(self) {
	const full = gint.topologyFullWasm(self, topology.FORMAT_VERSION);
	// JS 位相経路（parse→cutPolygon/cutPolyline→meta→buildArcs→stream 組立・部分 wasm 版込み）は 2026-09-16 に撤去。
	// 全呼び手（index.js gint()・encoder/gint Worker・convert/node-gint）は先に gint.initialize() を await している＝ここへ来るのは
	// initialize 抜きで topology() を直接呼んだ時だけ。黙って壊れた JS 経路（共有点を落とすバグ・t-large 参照）で焼くより明示的に投げる。
	if (!full) throw new Error("geopbf/topology: gint wasm が未初期化＝topology() の前に await gint.initialize() が要る（JS 位相経路は撤去済み）");
	return anchorFullGintBuf(full);   // 全wasm直行便にも度アンカー（JS後処理＝Rust改修なし）
}

// 全wasm直行便（topologyFullWasm）の GintBUF へ度アンカーを掛ける後処理。
// プリスキャン＝arcMeta の bbox だけを生バッファのビューで見る（コピーゼロ）＝1°箱超の arc が無ければ無傷で返す
// （筆/census級の密データは常にこちら）。必要時のみ unpack→insertDegreeAnchors→repack。
function anchorFullGintBuf(full) {
	const header = new Uint32Array(full, 0, 16);
	const arcLength = header[6], arcCount = header[7], mlen = 8, LIMIT = 10000000;
	if (!arcCount) return full;
	const meta = new Uint32Array(full, 64 + arcLength * 8, arcCount * mlen);
	let hit = false;
	for (let a = 0; a < arcCount && !hit; a++) {
		const r = a * mlen;
		if (meta[r + 1] >= 2 && (meta[r + 6] - meta[r + 4] > LIMIT || meta[r + 7] - meta[r + 5] > LIMIT)) hit = true;
	}
	if (!hit) return full;
	const d = unpackRawViews(full);   // 旧＝unPackGintBuffer＝GintBUF を丸ごと slice し、捨てるネスト配列と bbox 台帳まで構築していた
	const set = { count: d.arcCount, buffer: d.arcBuffer, meta: d.arcMeta, mlen };
	gint.insertDegreeAnchors(set);
	d.arcBuffer = set.buffer;
	{   // 大円アンカーの膨らみ（極側）を全体 bbox（度）にも合流
		const S = gint.SCALE_E, bb = [Infinity, Infinity, -Infinity, -Infinity];
		gint.unionArcBbox(set, bb);
		if (bb[0] !== Infinity) d.bbox = [Math.min(d.bbox[0], bb[0] / S - 180), Math.min(d.bbox[1], bb[1] / S - 90), Math.max(d.bbox[2], bb[2] / S - 180), Math.max(d.bbox[3], bb[3] / S - 90)];
	}
	return repackGintBuffer(d);
}

// polygon/polyline/neighbors（ネスト配列）は遅延生成＝読まれた時に stream から組む（非列挙の accessor＝structured clone に乗らない・
// Worker 越しは受け側で attachLazyStreams を掛け直す）。消費者は topojson/clean/large-model だけで、描画側（ortho-core）は stream しか読まない
// ＝旧は毎 unpack で全 feature ぶんのネスト配列を組み、gint Worker からの返り便で structured clone までしていた（俯瞰レビュー 2026-09-15）。
// setter は clean.js の再代入（gintData.polygon = …）用
export function attachLazyStreams(d) {
	if (!d) return d;
	const lazy = (name, stream, build) => {
		let v, done = false;
		Object.defineProperty(d, name, { configurable: true, enumerable: false,
			get() { if (!done) { v = build(d[stream]); done = true; } return v; },
			set(x) { v = x; done = true; } });
	};
	if (!Object.getOwnPropertyDescriptor(d, "polygon")?.get) lazy("polygon", "polyStream", streamToPolygon);
	if (!Object.getOwnPropertyDescriptor(d, "polyline")?.get) lazy("polyline", "lineStream", streamToPolyline);
	if (!Object.getOwnPropertyDescriptor(d, "neighbors")?.get) lazy("neighbors", "neighborStream", streamToNeighbors);
	return d;
}
// GintBUF の生ビュー（コピーなし・ネスト配列も bbox 台帳も作らない）＝anchorFullGintBuf 用。repackGintBuffer が読む項目だけを返す
function unpackRawViews(full) {
	let ptr = 0;
	const header = new Uint32Array(full, 0, 16), mlen = 8, SCALE = gint.SCALE_E; ptr += 64;
	const polygonCount = header[2], polylineCount = header[3], pointCount = header[4], nodeCount = header[5];
	const arcLength = header[6], arcCount = header[7], bbox = [...header.slice(8, 12)];
	bbox[0] = (bbox[0] - 180 * SCALE) / SCALE; bbox[1] = (bbox[1] - 90 * SCALE) / SCALE;
	bbox[2] = (bbox[2] - 180 * SCALE) / SCALE; bbox[3] = (bbox[3] - 90 * SCALE) / SCALE;
	const arcBuffer   = arcLength  ? new BigUint64Array(full, ptr, arcLength)    : null; ptr += arcLength * 8;
	const pointBuffer = pointCount ? new BigUint64Array(full, ptr, pointCount)   : null; ptr += pointCount * 8;
	const arcMeta     = arcCount   ? new Uint32Array(full, ptr, arcCount * mlen) : null; ptr += arcCount * mlen * 4;
	const point       = pointCount ? new Uint32Array(full, ptr, pointCount)      : null; ptr += pointCount * 4;
	const psLen = header[12], lsLen = header[13], nbLen = header[14];
	const polyStream     = psLen ? new Int32Array(full, ptr, psLen) : null; ptr += psLen * 4;
	const lineStream     = lsLen ? new Int32Array(full, ptr, lsLen) : null; ptr += lsLen * 4;
	const neighborStream = nbLen ? new Int32Array(full, ptr, nbLen) : null;
	return { polygonCount, polylineCount, pointCount, nodeCount, arcCount, bbox, arcBuffer, arcMeta, polyStream, lineStream, neighborStream, pointBuffer, point };
}
export function unPackGintBuffer(GintBUF) {
	try { let ptr = 0;
		const buf = new Uint8Array(GintBUF).slice().buffer, mlen = 8, SCALE = gint.SCALE_E;
		const header = new Uint32Array(buf, 0, 16); ptr += 64;
		if (header[0] !== 1953392967) throw new Error("Invalid Gint buffer");
		// 版検札：旧レイアウトの GintBUF（IDBキャッシュ由来）を現行リーダで読むとオフセットがずれ、
		// 例外にすらならず「空の絵」になり得る。ここで確実に弾く＝呼び出し側(pbf-io)が再焼きで自己修復。
		if (header[1] !== topology.FORMAT_VERSION) throw new Error(`Gint buffer format v${header[1]} (expected v${topology.FORMAT_VERSION}) — 旧キャッシュ`);
		const polygonCount = header[2], polylineCount = header[3], pointCount = header[4], nodeCount = header[5];
		const arcLength = header[6], arcCount = header[7], bbox = [...header.slice(8, 12)];
		bbox[0] = (bbox[0] - 180 * SCALE) / SCALE; bbox[1] = (bbox[1] - 90 * SCALE) / SCALE;
		bbox[2] = (bbox[2] - 180 * SCALE) / SCALE; bbox[3] = (bbox[3] - 90 * SCALE) / SCALE;
		const arcBuffer   = arcLength  ? new BigUint64Array(buf, ptr, arcLength)    : null; ptr += arcLength * 8;
		const pointBuffer = pointCount ? new BigUint64Array(buf, ptr, pointCount)   : null; ptr += pointCount * 8;
		const arcMeta     = arcCount   ? new Uint32Array(buf, ptr, arcCount * mlen) : null; ptr += arcCount * mlen * 4;
		const point       = pointCount ? new Uint32Array(buf, ptr, pointCount)      : null; ptr += pointCount * 4;
		const psLen = header[12], lsLen = header[13], nbLen = header[14];
		const polyStream     = psLen ? new Int32Array(buf, ptr, psLen) : null; ptr += psLen * 4;
		const lineStream     = lsLen ? new Int32Array(buf, ptr, lsLen) : null; ptr += lsLen * 4;
		const neighborStream = nbLen ? new Int32Array(buf, ptr, nbLen) : null; ptr += nbLen * 4;
		const polyBboxByFid = buildFeatureBboxes(polyStream, arcMeta);
		const lineBboxByFid = buildFeatureBboxes(lineStream, arcMeta);
		const polyCompBbox  = buildCompBboxes(polyStream, arcMeta);
		return attachLazyStreams({ polygonCount, polylineCount, pointCount, nodeCount, arcCount, bbox,
			arcBuffer, arcMeta, polyStream, lineStream, neighborStream,
			pointBuffer, point, polyBboxByFid, lineBboxByFid, polyCompBbox });
	} catch (e) { console.error("Failed to unpack Gint buffer:", e); return null; }
}

export function repackGintBuffer(d) {
	const mlen = 8, SCALE = gint.SCALE_E;
	const arcLength  = d.arcBuffer ? d.arcBuffer.length : 0;
	const arcCount   = d.arcCount, pointCount = d.pointCount;
	const polyStream     = d.polyStream     ?? new Int32Array(0);
	const lineStream     = d.lineStream     ?? new Int32Array(0);
	const neighborStream = d.neighborStream ?? new Int32Array(0);
	const bboxInt = [
		Math.round((d.bbox[0] + 180) * SCALE), Math.round((d.bbox[1] +  90) * SCALE),
		Math.round((d.bbox[2] + 180) * SCALE), Math.round((d.bbox[3] +  90) * SCALE),
	];
	const header = new Uint32Array([
		1953392967, topology.FORMAT_VERSION,
		d.polygonCount, d.polylineCount, pointCount, d.nodeCount,
		arcLength, arcCount, ...bboxInt,
		polyStream.length, lineStream.length, neighborStream.length, 0
	]);
	const totalLength = header.length * 4 + arcLength * 8 + pointCount * 8
		+ arcCount * mlen * 4 + pointCount * 4
		+ polyStream.byteLength + lineStream.byteLength + neighborStream.byteLength;
	const buf = new ArrayBuffer(totalLength);
	const u8  = new Uint8Array(buf);
	let ptr = 0;
	const write = ta => { u8.set(new Uint8Array(ta.buffer, ta.byteOffset, ta.byteLength), ptr); ptr += ta.byteLength; };
	write(header);
	d.arcBuffer   && write(d.arcBuffer);
	d.pointBuffer && write(d.pointBuffer);
	d.arcMeta     && write(d.arcMeta);
	d.point       && write(d.point);
	polyStream.length     && write(polyStream);
	lineStream.length     && write(lineStream);
	neighborStream.length && write(neighborStream);
	return buf;
}

// Build Stream → Map<fid, [xMin,yMin,xMax,yMax]> for per-feature early rejection in the JS identify fallback.
// Both polygon stream and polyline stream share the same 3-level structure [fid][numGroups][arcCount][arcIdx...].
function buildFeatureBboxes(stream, arcMeta) {
	if (!stream || !arcMeta || !stream.length) return null;
	const byFid = new Map();
	let p = 0;
	while (p < stream.length) {
		const fid = stream[p++], numGroups = stream[p++];
		let bb = byFid.get(fid);
		if (!bb) { bb = [0xFFFFFFFF, 0xFFFFFFFF, 0, 0]; byFid.set(fid, bb); }
		for (let g = 0; g < numGroups; g++) {
			const arcCount = stream[p++];
			for (let a = 0; a < arcCount; a++) {
				const arcIdx = stream[p++], aid = arcIdx < 0 ? ~arcIdx : arcIdx, m = aid * 8;
				if (arcMeta[m+4] < bb[0]) bb[0] = arcMeta[m+4]; if (arcMeta[m+5] < bb[1]) bb[1] = arcMeta[m+5];
				if (arcMeta[m+6] > bb[2]) bb[2] = arcMeta[m+6]; if (arcMeta[m+7] > bb[3]) bb[3] = arcMeta[m+7];
			}
		}
	}
	return byFid;
}

// Per-component (one island of a MultiPolygon) bbox, 1:1 with polygon_stream entries; passed to WASM identify_polygon.
function buildCompBboxes(polyStream, arcMeta) {
	if (!polyStream || !arcMeta || !polyStream.length) return null;
	const out = [];
	let p = 0;
	while (p < polyStream.length) {
		p++; // fid
		const numRings = polyStream[p++];
		let xMin = 0xFFFFFFFF, yMin = 0xFFFFFFFF, xMax = 0, yMax = 0;
		for (let r = 0; r < numRings; r++) {
			const arcCount = polyStream[p++];
			for (let a = 0; a < arcCount; a++) {
				const arcIdx = polyStream[p++], aid = arcIdx < 0 ? ~arcIdx : arcIdx, m = aid * 8;
				if (arcMeta[m+4] < xMin) xMin = arcMeta[m+4]; if (arcMeta[m+5] < yMin) yMin = arcMeta[m+5];
				if (arcMeta[m+6] > xMax) xMax = arcMeta[m+6]; if (arcMeta[m+7] > yMax) yMax = arcMeta[m+7];
			}
		}
		out.push(xMin, yMin, xMax, yMax);
	}
	return new Uint32Array(out);
}

// ── Stream ↔ JS array conversion (backward compatibility for topojson.js / clean.js) ──────────────────
function streamToPolygon(polyStream) {
	if (!polyStream || !polyStream.length) return null;
	const byFid = new Map(); let p = 0;
	while (p < polyStream.length) {
		const fid = polyStream[p++], numRings = polyStream[p++], rings = [];
		for (let r = 0; r < numRings; r++) {
			const arcCount = polyStream[p++], ring = [];
			for (let a = 0; a < arcCount; a++) ring.push(polyStream[p++]);
			rings.push(ring);
		}
		let comps = byFid.get(fid); if (!comps) { comps = []; byFid.set(fid, comps); }
		comps.push(rings);
	}
	return byFid.size ? [...byFid.entries()].map(([fid, comps]) => [fid, comps]) : null;
}
function streamToPolyline(lineStream) {
	if (!lineStream || !lineStream.length) return null;
	const out = []; let p = 0;
	while (p < lineStream.length) {
		const fid = lineStream[p++], numSets = lineStream[p++], sets = [];
		for (let s = 0; s < numSets; s++) {
			const arcCount = lineStream[p++], arcs = [];
			for (let a = 0; a < arcCount; a++) arcs.push(lineStream[p++]);
			sets.push(arcs);
		}
		out.push([fid, sets]);
	}
	return out.length ? out : null;
}
function streamToNeighbors(neighborStream) {
	if (!neighborStream || !neighborStream.length) return null;
	const out = []; let p = 0, hasAny = false;
	while (p < neighborStream.length) {
		const fid = neighborStream[p++], count = neighborStream[p++], nb = [];
		for (let i = 0; i < count; i++) nb.push(neighborStream[p++]);
		out[fid] = nb; hasAny = true;
	}
	return hasAny ? out : null;
}
