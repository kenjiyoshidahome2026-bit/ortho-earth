// convert/tiler.js ── GeoPBF（＋gint）→ PMTiles（MVT）。
//
// 入力は GintBUF（ortho-japan が GPU で描いているのと同じ派生物＝arc・VW rank・polyStream/lineStream・点）。
// GeoPBF の feature 座標を読み直すのではなく gint の arc を使う理由は 2 つ：
//   1. 共有境界は 1 本の arc＝隣接ポリゴンは同じ頂点列に簡略化される＝低ズームのタイルに隙間・重なりが出ない
//   2. rank（VW 重要度）が焼き込み済み＝ズーム毎の簡略化が「rank ≥ 閾値」の並列フィルタになる（GPU 向き）
// ズーム z の閾値は ortho-core の r=63-3z（256px 世界）を extent へ換算した 63-3(z+log2(extent/256))。
//
// 流れ: unpack → ①project（GPU/CPU）→ ②lodCount（全ズーム 1 dispatch）→ prefix sum → ②lodWrite（出力量で
// ズームを束ねて読み戻し）→ ズーム×タイル列範囲の job を worker プールへ（環/線の組立・二分クリップ・MVT・gzip・
// 内容キー）→ main で内容を寄せて PMTiles。gzip は Node=zlib / ブラウザ=CompressionStream（pako 不使用）。
import { unPackGintBuffer } from "../extension/topology.js";
import { getDevice } from "./gpu.js";
import { createEngine, cpuEngine } from "./engine.js";
import { assembleZoom } from "./assemble.js";
import { createPool, defaultWorkers } from "./pool.js";
import { gzipMany } from "./gzip.js";
import { assemblePMTiles, sameBytes } from "./pmtiles.js";
import { attrFilter } from "./attrs.js";
import { buildTagTable } from "./tagtable.js";
import { calibrateArcThresholds } from "./calibrate.js";
export { attrFilter };

// lodBias: 正で閾値を上げる＝残る頂点が減る（3 で VW 面積 4 倍＝線形で 2 倍粗い相当）。負で細かく。
export function lodThreshold(z, extent, lodBias = 0) {
	const v = Math.round(63 - 3 * (z + Math.log2(extent / 256)) + lodBias);
	return Math.max(0, Math.min(63, v));
}

// 属性 → MVT tags（GeoPBF の値型を MVT の値型へ。入れ子は "a.b" に平坦化・Blob/ImageData/関数は落とす）。keep: attrFilter の戻り
export function propsToTags(props, fields, keep = null) {
	const tags = [];
	const put = (k, v) => {
		if (v === null || v === undefined || (keep && !keep(k))) return;
		let t;
		if (typeof v === "string") t = v;
		else if (typeof v === "number") { if (!Number.isFinite(v)) return; t = v; }
		else if (typeof v === "boolean") t = v;
		else if (v instanceof Date) t = v.toISOString();
		else if (ArrayBuffer.isView(v)) t = JSON.stringify(Array.from(v));
		else if (typeof v === "object") { if (typeof Blob !== "undefined" && v instanceof Blob) return; if (typeof ImageData !== "undefined" && v instanceof ImageData) return; t = JSON.stringify(v); }
		else return;
		tags.push([k, t]);
		if (fields) { const ty = typeof t === "number" ? "Number" : typeof t === "boolean" ? "Boolean" : "String"; const cur = fields.get(k); if (!cur) fields.set(k, ty); else if (cur !== ty) fields.set(k, "String"); }
	};
	for (const k in props) {
		const v = props[k];
		if (v && typeof v === "object" && !(v instanceof Date) && !ArrayBuffer.isView(v) && Object.getPrototypeOf(v) === Object.prototype) for (const kk in v) put(k + "." + kk, v[kk]);
		else put(k, v);
	}
	return tags;
}

// 面成分（polyStream の成分順）の外環の元解像度の面積 ×2（世界座標 2^32 尺・成分の先頭頂点を原点に取って f64 で組む＝
// 2^64 級の積の丸めを避ける）。極小判定は tippecanoe と同じく「簡略化前の面積」で行う＝低ズームで LOD が環を潰しても、
// その成分の面積は積算されて代わりの正方形になる（小島の群れ・区画の塊が「何も無い」にならない）。
export function componentAreas(ps, arcMeta, xy) {
	let nc = 0;
	for (let p = 0; p < ps.length;) { p += 2; nc++; const nr = ps[p - 1]; for (let r = 0; r < nr; r++) p += ps[p] + 1; }
	const area = new Float64Array(nc);
	let c = 0;
	for (let p = 0; p < ps.length;) {
		const nr = ps[p + 1]; p += 2;
		const ac = ps[p], idx = ps.subarray(p + 1, p + 1 + ac);
		let ox = 0, oy = 0, px = 0, py = 0, s = 0, first = true;
		for (const ai of idx) {
			const aid = ai < 0 ? ~ai : ai, o = arcMeta[aid * 8], n = arcMeta[aid * 8 + 1];
			for (let j = 0; j < n; j++) {
				const i = ai < 0 ? n - 1 - j : j, x = xy[(o + i) * 2], y = xy[(o + i) * 2 + 1];
				if (first) { ox = x; oy = y; px = 0; py = 0; first = false; continue; }
				const lx = x - ox, ly = y - oy;
				s += px * ly - lx * py; px = lx; py = ly;
			}
		}
		area[c++] = s;   // 閉環（末尾＝先頭）なら閉じ辺の項は 0
		for (let r = 0; r < nr; r++) p += ps[p] + 1;
	}
	return area;
}

// pbf: GeoPBF（属性・ヘッダ用）。opts.gint: GintBUF（ArrayBuffer）。無ければ pbf._gintBuffer（pbf.gint() 後）。
// opts.workers: worker 数（0＝インライン・既定＝コア数・最大 8）
// opts.dropRate: 点の低ズーム間引き率（tippecanoe の -r 相当・既定 2.5＝1 ズーム下がる毎に 1/2.5・1 で全点保持。面/線には効かない）
// opts.tinyPolygon: そのズームのタイル座標で面積がこれ未満のポリゴン成分を落とす（tippecanoe の -s 相当・既定 2＝4096 格子で 1.4 単位角・
//   0 で無効）。落とした面積は feature 毎に積み、閾値に達する毎に閾値面積の正方形を 1 つ残す
// opts.tinyLine: 外接がこれ未満（両辺）の線分列を落とす（既定 0＝落とさない）
// opts.include / exclude / excludeAll: 属性の選別（tippecanoe の -y / -x / -X）
// opts.simplification: DP 許容差（タイル単位・既定 1＝tippecanoe -S 1 相当）。arc ごとに VW ランク閾値を「DP が残す頂点数」へ
//   較正する（calibrate.js）。false で固定則 63−3(z+log2(extent/256)) のみ。lodBias は較正後に足す
export async function toPMTiles(pbf, opts = {}) {
	const t0 = now();
	const gintBuf = opts.gint ?? pbf._gintBuffer;
	if (!gintBuf) throw new Error("toPMTiles: GintBUF が無い（await pbf.gint() か opts.gint）");
	const d = unPackGintBuffer(gintBuf);
	if (!d) throw new Error("toPMTiles: GintBUF を読めない");
	const extent = opts.extent ?? 4096, extentShift = Math.log2(extent);
	if (!Number.isInteger(extentShift) || extent < 256 || extent > 65536) throw new Error("extent は 256〜65536 の 2 の冪");
	const minZoom = opts.minZoom ?? 0, maxZoom = opts.maxZoom ?? 14;
	if (!(minZoom >= 0 && maxZoom >= minZoom && maxZoom <= 32 - extentShift && maxZoom - minZoom < 32)) throw new Error(`zoom 範囲が不正（0 ≤ min ≤ max ≤ ${32 - extentShift}）`);
	const buffer = opts.buffer ?? 80, lodBias = opts.lodBias ?? 0;
	const tinyPolygon = opts.tinyPolygon ?? 2, tinyLine = opts.tinyLine ?? 0;
	if (!(tinyPolygon >= 0) || !(tinyLine >= 0)) throw new Error("tinyPolygon / tinyLine は 0 以上");
	const layerName = opts.layer ?? pbf.name?.() ?? "layer";
	const tileGzip = (opts.tileCompression ?? "gzip") === "gzip";
	const stats = { engine: "cpu", vertices: 0, arcs: 0, kept: 0, tiles: 0, bytes: 0, workers: 0, ms: {} };

	// ── 頂点台帳: arc 群 ＋ 点（点は長さ 1 の arc として同じ経路を通す）
	const arcU32 = d.arcBuffer ? new Uint32Array(d.arcBuffer.buffer, d.arcBuffer.byteOffset, d.arcBuffer.length * 2) : new Uint32Array(0);
	const ptU32 = d.pointBuffer ? new Uint32Array(d.pointBuffer.buffer, d.pointBuffer.byteOffset, d.pointBuffer.length * 2) : new Uint32Array(0);
	const arcLen = arcU32.length >>> 1, nPts = ptU32.length >>> 1, A = d.arcCount + nPts;
	const verts = new Uint32Array((arcLen + nPts) * 2); verts.set(arcU32, 0); verts.set(ptU32, arcLen * 2);
	const arcs = new Uint32Array(A * 2);
	for (let a = 0; a < d.arcCount; a++) { arcs[a * 2] = d.arcMeta[a * 8]; arcs[a * 2 + 1] = d.arcMeta[a * 8 + 1]; }
	for (let p = 0; p < nPts; p++) { arcs[(d.arcCount + p) * 2] = arcLen + p; arcs[(d.arcCount + p) * 2 + 1] = 1; }
	stats.vertices = arcLen + nPts; stats.arcs = d.arcCount;

	// ── エンジン（GPU/CPU）
	let device = null;
	if (opts.gpu !== false) device = await getDevice(typeof opts.gpu === "object" ? { gpu: opts.gpu } : {});
	const eng = device ? createEngine(device) : cpuEngine();
	stats.engine = eng.kind; stats.gpu = eng.info;
	const t1 = now();
	const proj = eng.project(verts);
	const zoomCount = maxZoom - minZoom + 1;
	const thresholds = Array.from({ length: zoomCount }, (_, k) => lodThreshold(minZoom + k, extent, lodBias));
	const simplification = opts.simplification ?? 1;
	let projCPU = null;   // 較正と面積計算で使う投影結果（GPU なら 1 回だけ読み戻す）
	const readProj = async () => projCPU ??= (proj.xy instanceof Uint32Array ? { xy: proj.xy, rk: proj.rk } : await proj.read());
	let arcThresholds;
	if (simplification !== false && d.arcCount) {
		if (!(simplification > 0)) throw new Error("simplification は正の数か false");
		const tc = now(), { xy, rk } = await readProj();
		const cal = calibrateArcThresholds({ xy, rk, arcs, arcCount: d.arcCount, totalArcs: A, extentShift, minZoom, maxZoom, tolerance: simplification, lodBias });
		arcThresholds = cal.arcThresholds; stats.calibration = cal.stats; stats.ms.calibrate = now() - tc;
	}
	const params = { arcCount: A, zoomCount, minZoom, extentShift, thresholds, arcThresholds };
	const { counts, bbox } = await eng.lodCount(proj, arcs, params);
	stats.ms.project_lod = now() - t1;
	const offsets = new Uint32Array(counts.length);
	let total = 0; for (let i = 0; i < counts.length; i++) { offsets[i] = total; total += counts[i]; }
	stats.kept = total;
	const zoomTotal = (k) => (k + 1 < zoomCount ? offsets[(k + 1) * A] : total) - offsets[k * A];
	// 面成分の元解像度の面積（極小判定用・tinyPolygon 0 なら不要）。GPU なら投影結果を読み戻す
	let compArea = null;
	if (tinyPolygon > 0 && d.polyStream?.length) { const ta = now(); const { xy } = await readProj(); compArea = componentAreas(d.polyStream, d.arcMeta, xy); stats.ms.area = now() - ta; }

	// ── 属性 → typed array 表（キー辞書・UTF-8 文字列辞書・feature 別エントリ）＝worker へは memcpy で渡る
	//（fid 毎の [[k,v],…] 配列の構造化クローンは 100 万件で worker あたり 4 秒＝直列で 16 秒掛かっていた）
	const tt = now();
	const fields = new Map(), keep = attrFilter(opts);
	const tagTable = buildTagTable(pbf, keep, fields);
	stats.ms.tags = now() - tt;
	const dropRate = opts.dropRate ?? 2.5;
	if (!(dropRate >= 1)) throw new Error("dropRate は 1 以上（1＝点を間引かない）");
	const S = { arcCount: d.arcCount, nPts, point: d.point ? d.point.slice() : null, polyStream: d.polyStream ? d.polyStream.slice() : null, lineStream: d.lineStream ? d.lineStream.slice() : null, extent, buffer, layerName, tagTable, featureCount: pbf.length, maxZoom, dropRate, tinyPolygon, tinyLine, compArea, extentShift };

	// ── worker プール（失敗したらインライン）
	let pool = null;
	const NW = opts.workers ?? await defaultWorkers();
	const ti = now();
	if (NW > 0) { try { pool = await createPool(NW); await pool.init(S); } catch (e) { pool = null; opts.onWarn?.(e); } }
	stats.workers = pool ? NW : 0;
	stats.ms.pool_init = now() - ti;

	// ── 結果の寄せ集め（内容キーで重複統合・同キー異内容は枝番）
	const items = [], contents = new Map();
	let tileCount = 0;
	const merge = (r) => {
		const remap = new Map();
		for (const [key0, bytes] of r.contents) {
			let key = key0, n = 0, cur = contents.get(key);
			while (cur && !sameBytes(cur, bytes)) { key = key0 + "~" + (++n); cur = contents.get(key); }
			if (!cur) contents.set(key, bytes);
			if (key !== key0) remap.set(key0, key);
		}
		for (const t of r.tiles) items.push({ id: t.id, key: remap.get(t.key) ?? t.key });
		tileCount += r.tiles.length;
	};

	// ── ズーム毎の job（GPU 読み戻しはズームを束ねて・組立は列範囲で分担）
	const batchVerts = opts.batchVertices ?? (32 << 20);
	let tAsm = 0, tLod2 = 0;
	const pending = [];
	for (let k0 = 0; k0 < zoomCount;) {
		let k1 = k0 + 1, sum = zoomTotal(k0);
		while (k1 < zoomCount && sum + zoomTotal(k1) <= batchVerts) sum += zoomTotal(k1++);
		const base0 = offsets[k0 * A], sub = offsets.slice(k0 * A, k1 * A);
		for (let i = 0; i < sub.length; i++) sub[i] -= base0;
		const tw = now();
		const out = sum ? await eng.lodWrite(proj, arcs, params, sub, sum, k0, k1) : new Uint32Array(0);
		tLod2 += now() - tw;
		const ta = now();
		for (let k = k0; k < k1; k++) {
			const z = minZoom + k, ntx = 1 << z;
			const zc = counts.subarray(k * A, (k + 1) * A), zb = bbox.subarray(k * A * 4, (k + 1) * A * 4);
			const zo = sub.subarray((k - k0) * A, (k - k0 + 1) * A), zStart = zo[0], zEnd = (k - k0 + 1 < k1 - k0 ? sub[(k - k0 + 1) * A] : sum);
			const shards = Math.max(1, Math.min(ntx, pool ? pool.size * 3 : 1));
			for (let s = 0; s < shards; s++) {
				const txFrom = Math.floor(ntx * s / shards), txTo = Math.floor(ntx * (s + 1) / shards) - 1;
				const makeJob = () => {   // worker が空いた時に複製を作る＝同時に NW 個まで
					const offs = zo.slice(); for (let i = 0; i < offs.length; i++) offs[i] -= zStart;
					const o = out.slice(zStart * 2, zEnd * 2);
					const J = { z, txFrom, txTo, counts: zc.slice(), bbox: zb.slice(), offs, out: o };
					return { msg: { type: "job", J, gzip: tileGzip }, transfers: [J.counts.buffer, J.bbox.buffer, offs.buffer, o.buffer] };
				};
				if (pool) pending.push(pool.run(makeJob).then(r => { merge(r); opts.onProgress?.({ zoom: z, tiles: tileCount }); }));
				else {
					const J = makeJob().msg.J, r = assembleZoom(S, J);
					const bytes = tileGzip ? await gzipMany(r.contents.map(c => c[1])) : r.contents.map(c => c[1]);
					merge({ tiles: r.tiles, contents: r.contents.map((c, i) => [c[0], bytes[i]]) });
					opts.onProgress?.({ zoom: z, tiles: tileCount });
				}
			}
		}
		if (pool) await Promise.all(pending.splice(0));   // この束の job を待ってから out を捨てる（次の GPU 読み戻しへ）
		tAsm += now() - ta;
		k0 = k1;
	}
	stats.ms.lod_write = tLod2; stats.ms.assemble = tAsm;
	proj.destroy(); eng.destroy(); pool?.destroy();

	// ── PMTiles
	const tp = now();
	const bounds = d.bbox;
	const metadata = {
		name: layerName, format: "pbf", type: "overlay", version: "1",
		description: pbf.description?.() || undefined, attribution: pbf.attribution?.() || undefined, license: pbf.license?.() || undefined,
		minzoom: String(minZoom), maxzoom: String(maxZoom), bounds: bounds.join(","),
		vector_layers: [{ id: layerName, description: "", minzoom: minZoom, maxzoom: maxZoom, fields: Object.fromEntries(fields) }],
		generator: "geopbf",
		...(opts.metadata || {}),
	};
	for (const k of Object.keys(metadata)) if (metadata[k] === undefined) delete metadata[k];
	const buf = await assemblePMTiles(items, contents, metadata, { minZoom, maxZoom, bounds, tileCompression: tileGzip ? "gzip" : "none", center: opts.center });
	stats.ms.pmtiles = now() - tp;
	stats.tiles = tileCount; stats.bytes = buf.length; stats.contents = contents.size; stats.ms.total = now() - t0;
	return { buffer: buf, stats, metadata };
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
