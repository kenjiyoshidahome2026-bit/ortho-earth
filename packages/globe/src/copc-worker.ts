// 点群（COPC・普通の LAS/LAZ）の読み手 worker（#178）。main（gadgets/copc.js）が選んだ節だけを Range で取って LAZ を解き、原点相対の点にして返す。
//   普通の LAS/LAZ（COPC info が無い物・点群計画 段 3-3）は open で丸ごと読み、その場で八分木を作る（pointcloud-octree.js）＝以降の節は手元から集めるだけ。
//   開く  { type:"open", id, src: URL | Blob, headers?, crs?, vertical?, ell } → { type:"opened", id, info, root: { nodes, pages } }
//         ZIP（.zip・"PK\3\4"）＝中の最初の LAS/LAZ を解いてから（pointcloud-zip.js）。取る間は { type:"progress", id, loaded, total } を送る
//   頁    { type:"page", id, rid, page: { offset, byteSize } } → { type:"page", id, rid, nodes, pages }
//   丸ごと { type:"dump", id, rid, maxPoints, N } → { type:"dump", id, rid, n, anchor:[lon,lat,elev], pts(Float32・錨からの東北上 m), elev, rgb(Uint8×3|null), intensity, cls, bb, total, ms }（open の後・map.readPointCloud＝点群 → splat の材料・2026-11-06）
//         COPC は階層を全部読んで浅い節から順に maxPoints まで（＝自然な間引き）・丸ごと読みは等間隔に間引く
//   節    { type:"node", id, rid, node, N } → { type:"node", id, rid, n, pos(Float32・原点相対), origin, rgb(Uint8×3|null), intensity(Uint16), cls(Uint8), elev(Float32・m), gs, ms: { read, decode, proj } }
//         gs＝地面の見本（Float64 [経度, 緯度, 標高 m]×最大 GS 点・分類 2＝地面を優先）＝地形に合わせる（手綱の fitTerrain）の材料。heightOffset は描き（copc-gl の lift）で足す＝ここでは足さない
// 解読＝"#pointcloud-formats" の laz（プラグイン @ortho-earth/tile-formats/pointcloud＝laz-perf 0.0.7 の ChunkDecoder・WASM・Apache-2.0）。
//   globe 自身は laz-perf に依存しない（本人裁定＝プラグインの形）・差し込まれていなければ open で何を足すかを返す。最初の節で一度だけ起こす（起動の重さは 0）。
// 座標＝opts.crs／WKT（LASF_Projection 2112）／GeoTIFF キー（34735）→ pointcloud-crs.js（geopbf/proj の crsFromWKT＝TM・メルカトル・LCC・Albers・経緯度）→ 経緯度。高さ＝z（鉛直の単位）
//   ＋楕円体高なら N（main が節の中心で EGM96 から引いて渡す）を引いて標高へ（この地図の標高はジオイド基準）・鉛直の CRS がジオイド系を申告していればそのまま。
// 世界座標＝meshdecode の geoWorld（建物メッシュ・3D Tiles の点と同じ式・楕円体表示も）。
import { POINTCLOUD_FORMATS } from "#pointcloud-formats";
import { openSource } from "geopbf/cog/source";
import { resolveCrs } from "./pointcloud-crs.ts";
import { geoWorld, setDecodeEnv, earthW } from "./meshdecode.ts";
import { placeNode, dumpEnu, dumpStride } from "./copc-place.ts";
import { wholeFileLimit, createStore, appendRaw, buildOctree, gatherNode } from "./pointcloud-octree.ts";
import { isZip, unzipPointCloud } from "./pointcloud-zip.ts";
import { parseHeader, listVlrs, parseCopcInfo, parseHierarchyPage, readRecords, readRecordsRaw, rgbMax, nodeBounds, geoKeysEpsg, hasRgb } from "@ortho-earth/tile-formats/las";   // LAS/COPC の形を読む純関数（依存なし・laz-perf は読まない）
import type { CopcInfo, CopcNode, CopcPage, LasHeader, LasRecords, LasVlr, NodeKey } from "@ortho-earth/tile-formats/las";
import type { Source } from "geopbf/cog/source";
import type { CrsInfo } from "geopbf/proj";
import type { PointcloudFormats } from "./pointcloud-formats-none.ts";
import type { ResolvedCrs } from "./pointcloud-crs.ts";
import type { PointStore } from "./pointcloud-octree.ts";

/** 開いた点群（id ごと）＝src は COPC の時だけ（丸ごと読みは mem に全点） */
interface PcSet {
	src: Source | null; hdr: LasHeader; info: { center: number[]; halfsize: number; spacing: number }; crs: CrsInfo; ll: ResolvedCrs["ll"];
	vUnit: number; orthometric: boolean; lonlat: boolean; mem: { store: PointStore; idx: Uint32Array } | null;
}
/** 節ページの項（withSpheres が選びの材料を足す） */
type SphNode = CopcNode & { c?: number[]; r?: number; ll?: ArrayLike<number>; spacingM?: number };
/** main からの便（type ごとに使う欄が違う） */
interface CopcMsg {
	type?: "open" | "page" | "node" | "dump" | "close"; id: number; rid?: number; ell?: boolean;
	/** dump＝読む点の上限（等間隔に間引く・0＝全部）。N（節と同じ欄）＝楕円体高なら中心の EGM96 の N（m） */ maxPoints?: number;
	src?: string | Blob; headers?: Record<string, string>; crs?: string; vertical?: "orthometric" | "ellipsoidal";
	page?: { offset: number; byteSize: number }; node?: CopcNode; N?: number;
}

let LAZ: ReturnType<NonNullable<PointcloudFormats["laz"]>> | null = null;
const NO_LAZ = 'copc: no LAZ decoder — install @ortho-earth/tile-formats and alias "#pointcloud-formats" to "@ortho-earth/tile-formats/pointcloud" in your bundler';
const laz = () => LAZ ??= POINTCLOUD_FORMATS.laz!().catch(e => { LAZ = null; throw e; });
const sets = new Map<number, PcSet>();   // id → { src, hdr, info, crs, vUnit, ellipsoidal }
const D2R = Math.PI / 180;
// 節ページの項に選びの材料を足す：c＝境界球の中心（世界座標）・r＝半径（世界単位）・spacingM＝その節の点の間隔（m）・ll＝中心の経緯度（main が EGM96 の N を引く）
function withSpheres(set: PcSet, page: { nodes: SphNode[]; pages: CopcPage[] }) {
	const { info, ll, vUnit, lonlat } = set, EW = earthW(), w = [0, 0, 0], k = lonlat ? 111320 : vUnit;
	for (const n of page.nodes) {
		const b = nodeBounds(info as CopcInfo, n.key), c = ll([(b[0] + b[3]) / 2, (b[1] + b[4]) / 2]), size = b[3] - b[0];
		geoWorld(c[0] * D2R, c[1] * D2R, ((b[2] + b[5]) / 2 * vUnit) / EW, w);
		n.c = [w[0], w[1], w[2]]; n.r = size * Math.sqrt(3) / 2 * k / EW; n.ll = c; n.spacingM = info.spacing / 2 ** n.key[0] * k;
	}
	return page;
}

// 普通の LAS/LAZ（COPC でない・点群計画 段 3-3）＝丸ごと読んで全点を持ち、その場で八分木を作る（pointcloud-octree.js）。節は COPC と同じ形で返す（offset＝idx の始まり・byteSize 0）
async function readWhole(src: Source, hdr: LasHeader, vlrs: LasVlr[], local: boolean) {
	const over = wholeFileLimit({ count: hdr.pointCount, size: src.size, local, minBytes: hdr.pointOffset + hdr.pointCount * hdr.recordLength });   // 総長が分からない URL＝ヘッダの読む量で量る
	if (over) throw new Error(over);
	const lazed = hdr.compressed || vlrs.some(v => v.userId === "laszip encoded");
	if (lazed && !POINTCLOUD_FORMATS.lazFile) throw new Error(NO_LAZ);
	const t0 = performance.now(), L = hdr.recordLength;
	let store = null as PointStore | null, shift = 8, tRead = 0;
	const take = (rec: Uint8Array, k: number) => {
		if (!store) { shift = rgbMax(rec, k, hdr) > 255 ? 8 : 0; store = createStore(hdr.pointCount, { rgb: hasRgb(hdr.format), scale: hdr.scale, offset: hdr.offset }); }   // LAS の RGB は 16bit が作法だが 8bit のまま入れる書き手もいる＝最初の束の最大で見分ける
		appendRaw(store, readRecordsRaw(rec, k, hdr, { shift }), k);
	};
	if (lazed) {
		const [bytes, decode] = await Promise.all([src.read(0, src.size!), POINTCLOUD_FORMATS.lazFile!()]);
		tRead = performance.now() - t0;
		const r = await decode(bytes, take);
		if (r.recordLength !== L) throw new Error(`pointcloud: LAZ record length ${r.recordLength} does not match the header (${L})`);
	} else {
		const B = 1 << 18;
		for (let i = 0; i < hdr.pointCount; i += B) {
			const k = Math.min(B, hdr.pointCount - i), t = performance.now();
			const buf = new Uint8Array(await src.read(hdr.pointOffset + i * L, k * L));
			tRead += performance.now() - t;
			take(buf, Math.min(k, Math.floor(buf.byteLength / L)));
		}
	}
	if (!store || !store.at) throw new Error("pointcloud: the file has no points");
	const t1 = performance.now(), tree = buildOctree(store), t2 = performance.now();
	return { store, tree, ms: { read: Math.round(tRead), decode: Math.round(t1 - t0 - tRead), build: Math.round(t2 - t1) } };
}

async function open(m: CopcMsg) {
	const name = typeof m.src === "string" ? new URL(m.src, self.location.href).pathname : (m.src as File | undefined)?.name || "";
	if (!POINTCLOUD_FORMATS.laz && /\.laz$/i.test(name)) throw new Error(NO_LAZ);   // 取りに行く前に（.las は解読器なしで読める＝ヘッダを見るまで分からない物だけ取る）
	const fetchFn = m.headers ? (u: RequestInfo | URL, init: RequestInit = {}) => fetch(u, { ...init, headers: { ...(init.headers || {}), ...m.headers } }) : undefined;
	let src = await openSource(m.src!, { headerBytes: 65536, ...(fetchFn ? { fetch: fetchFn } : {}) }), local = typeof m.src !== "string";
	if (isZip(src.head)) {   // ZIP の中の LAS/LAZ（静岡県の配布物など）＝解いた物は手元の Blob＝以降は手元のファイルと同じ（上限は点の数だけ）
		const { blob, name: inner } = await unzipPointCloud(src, { onProgress: (loaded, total) => self.postMessage({ type: "progress", id: m.id, loaded, total }), check: count => wholeFileLimit({ count, size: null, local: true }) });
		if (!POINTCLOUD_FORMATS.laz && /\.laz$/i.test(inner)) throw new Error(NO_LAZ);
		src = await openSource(blob, { headerBytes: 65536 }); local = true;
	}
	let head = new Uint8Array(src.head);
	const hdr = parseHeader(head);
	if (hdr.pointOffset > head.byteLength) head = new Uint8Array(await src.read(0, hdr.pointOffset));
	const vlrs = listVlrs(head, hdr.headerSize, hdr.vlrCount);
	const ci = vlrs.find(v => v.userId === "copc" && v.recordId === 1);
	if (ci) {
		if (!POINTCLOUD_FORMATS.laz) throw new Error(NO_LAZ);   // 節を取りに行く前に
		if (hdr.version[1] < 4 || (!hdr.compressed && hdr.format < 6)) throw new Error(`copc: not a LAZ 1.4 point cloud (LAS ${hdr.version.join(".")}, format ${hdr.format})`);
	}
	let wktV = vlrs.find(v => v.userId === "LASF_Projection" && v.recordId === 2112);
	let wkt = wktV ? new TextDecoder().decode(head.subarray(wktV.offset, wktV.offset + wktV.length)).replace(/\0[\s\S]*$/, "") : null;
	if (!wkt && hdr.evlrCount) {   // WKT が EVLR にある物
		const tail = new Uint8Array(await src.read(hdr.evlrOffset, Math.min(src.size! - hdr.evlrOffset, 1 << 20)));
		const ev = listVlrs(tail, 0, hdr.evlrCount, true).find(v => v.userId === "LASF_Projection" && v.recordId === 2112);
		if (ev) wkt = new TextDecoder().decode(tail.subarray(ev.offset, ev.offset + ev.length)).replace(/\0[\s\S]*$/, "");
	}
	const gk = vlrs.find(v => v.userId === "LASF_Projection" && v.recordId === 34735);
	const r = resolveCrs({ wkt, geoKeys: gk ? geoKeysEpsg(head, gk.offset, gk.length) : null, crs: m.crs, vertical: m.vertical });   // 水平・鉛直の決め方＝pointcloud-crs.js（点を読む前に＝座標系が無ければ早く断る）
	const { crs, ll } = r;
	const whole = ci ? null : await readWhole(src, hdr, vlrs, local);
	const info = ci ? parseCopcInfo(head, ci.offset) : whole!.tree.info;
	const set: PcSet = { src: whole ? null : src, hdr, info, crs, ll, vUnit: r.vUnit, orthometric: r.orthometric, lonlat: r.lonlat, mem: whole && { store: whole.store, idx: whole.tree.idx } };
	sets.set(m.id, set);
	const lo = whole ? whole.store.min : hdr.min, hi = whole ? whole.store.max : hdr.max;
	const corners = [[lo[0], lo[1]], [hi[0], lo[1]], [hi[0], hi[1]], [lo[0], hi[1]]].map(ll);
	const bbox = [Math.min(...corners.map(c => c[0])), Math.min(...corners.map(c => c[1])), Math.max(...corners.map(c => c[0])), Math.max(...corners.map(c => c[1]))];
	const root = whole ? { nodes: whole.tree.nodes.map(nd => ({ key: nd.key as NodeKey, offset: nd.start, byteSize: 0, pointCount: nd.count })), pages: [] }
		: parseHierarchyPage(new Uint8Array(await src.read((info as CopcInfo).rootHierOffset, (info as CopcInfo).rootHierSize)));
	return {
		info: { count: whole ? whole.store.at : hdr.pointCount, format: hdr.format, hasRgb: hasRgb(hdr.format), bbox, center: ll([info.center[0], info.center[1]]),
			zRange: [lo[2] * r.vUnit, hi[2] * r.vUnit], cube: { center: info.center, halfsize: info.halfsize }, spacing: info.spacing, unit: r.vUnit,
			crs: r.label, crsFrom: r.from, vertical: r.verticalName, size: src.size, version: hdr.version.join("."),
			copc: !!ci, inMemory: !!whole, ...(whole ? { nodeCount: whole.tree.nodes.length, load: whole.ms } : {}) },
		root: withSpheres(set, root),
	};
}

// 地面の見本＝分類 2（地面）の点から等間隔に GS 点（地面の分類が無ければ全点から）→ [経度, 緯度, 標高 m]
const GS = 24;
function groundSample(r: { x: ArrayLike<number>; y: ArrayLike<number>; classification: Uint8Array }, n: number, ll: ResolvedCrs["ll"], elev: Float32Array) {
	let g = 0; for (let i = 0; i < n; i++) if (r.classification[i] === 2) g++;
	const want = g ? 2 : -1, m = g || n, step = Math.max(1, Math.floor(m / GS)), out: number[] = [];
	for (let i = 0, k = 0; i < n && out.length < GS * 3; i++) {
		if (want >= 0 && r.classification[i] !== want) continue;
		if (k++ % step) continue;
		const p = ll([r.x[i], r.y[i]]); out.push(p[0], p[1], elev[i]);
	}
	return new Float64Array(out);
}

async function node(m: CopcMsg & { node: CopcNode }) {
	const set = sets.get(m.id); if (!set) throw new Error("copc: not open");
	const { hdr, ll } = set, n = m.node.pointCount;
	const t0 = performance.now();
	let r: LasRecords | ReturnType<typeof gatherNode>, t1 = t0;
	if (set.mem) r = gatherNode(set.mem.store, set.mem.idx, m.node.offset, n);   // 丸ごと読み＝手元の点を集めるだけ（rgb は 8bit 済み）
	else {
		const [buf, decode] = await Promise.all([set.src!.read(m.node.offset, m.node.byteSize), laz()]);
		t1 = performance.now();
		const rec = await decode(buf, { format: hdr.format, recordLength: hdr.recordLength, count: n });
		r = readRecords(rec, n, hdr);
	}
	const t2 = performance.now();
	const dz = set.orthometric ? 0 : -(m.N || 0);
	const { pos, origin, elev, affine } = placeNode(r, n, { ll, vUnit: set.vUnit, dz, EW: earthW(), bounds: nodeBounds(set.info as CopcInfo, m.node.key) });   // 節ごとの二次式（ずれ 1 cm 超は 1 点ずつ）＝copc-place.js
	const gs = groundSample(r, n, ll, elev);
	let rgb: Uint8Array | Uint16Array | null = null;
	if (r.rgb && set.mem) rgb = r.rgb;
	else if (r.rgb) {   // LAS の RGB は 16bit が作法だが 8bit のまま入れる書き手もいる＝最大値で見分ける
		let mx = 0; for (let i = 0; i < r.rgb.length; i++) if (r.rgb[i] > mx) mx = r.rgb[i];
		const sh = mx > 255 ? 8 : 0; rgb = new Uint8Array(n * 3); for (let i = 0; i < rgb.length; i++) rgb[i] = r.rgb[i] >> sh;
	}
	return { n, pos, origin, affine, rgb, intensity: r.intensity, cls: r.classification, elev, gs, ms: { read: t1 - t0, decode: t2 - t1, proj: performance.now() - t2 } };   // ms＝計測（点群計画 段 0）：取得・解読（LAZ＋記録）・投影と色
}

// 丸ごと＝全点（上限つき）を錨からの東北上 m に（map.readPointCloud・点群 → Gaussian splat の材料・2026-11-06）。錨＝立方体の中心の経緯度・高さの範囲の中央（標高 m）
/** 節の記録を等間隔に間引く（stride 1＝そのまま）。k＝残す数 */
function thin(r: LasRecords, stride: number, k: number): LasRecords {
	if (stride <= 1) return r;
	const x = new Float64Array(k), y = new Float64Array(k), z = new Float64Array(k), intensity = new Uint16Array(k), classification = new Uint8Array(k), rgb = r.rgb ? new Uint16Array(k * 3) : null;
	for (let i = 0, p = 0; i < k; i++, p += stride) { x[i] = r.x[p]; y[i] = r.y[p]; z[i] = r.z[p]; intensity[i] = r.intensity[p]; classification[i] = r.classification[p]; if (rgb) { rgb[i * 3] = r.rgb![p * 3]; rgb[i * 3 + 1] = r.rgb![p * 3 + 1]; rgb[i * 3 + 2] = r.rgb![p * 3 + 2]; } }
	return { x, y, z, intensity, classification, rgb };
}

async function dump(m: CopcMsg) {
	const set = sets.get(m.id); if (!set) throw new Error("copc: not open");
	const { hdr, ll, info } = set, t0 = performance.now(), max = m.maxPoints || 0, dz = set.orthometric ? 0 : -(m.N || 0);
	const c = ll([info.center[0], info.center[1]]), vUnit = set.vUnit;
	let z0: number, z1: number;
	if (set.mem) { z0 = set.mem.store.min[2]; z1 = set.mem.store.max[2]; } else { z0 = hdr.min[2]; z1 = hdr.max[2]; }
	const anchor = [c[0], c[1], (z0 + z1) / 2 * vUnit + dz];
	const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
	let total: number, n: number, out: { pts: Float32Array<ArrayBuffer>; elev: Float32Array<ArrayBuffer>; at: number; bb: number[] }, rgb: Uint8Array<ArrayBuffer> | null, cls: Uint8Array<ArrayBuffer>, intensity: Uint16Array<ArrayBuffer>;
	let tRead = 0;
	if (set.mem) {   // 丸ごと読み＝等間隔に間引く
		const st = set.mem.store; total = st.at;
		const stride = dumpStride(total, max); n = Math.ceil(total / stride);
		out = { pts: new Float32Array(n * 3), elev: new Float32Array(n), at: 0, bb };
		rgb = st.rgb ? new Uint8Array(n * 3) : null; cls = new Uint8Array(n); intensity = new Uint16Array(n);
		const [sx, sy, sz] = st.scale as number[], [ox, oy, oz] = st.offset as number[], B = 65536;
		const x = new Float64Array(B), y = new Float64Array(B), z = new Float64Array(B);
		for (let i = 0, k = 0; i < total; i += stride * B) {   // B 点ずつ原座標に戻して置く
			let b = 0;
			for (let p = i; p < total && b < B; p += stride, b++, k++) { x[b] = st.X[p] * sx + ox; y[b] = st.Y[p] * sy + oy; z[b] = st.Z[p] * sz + oz; cls[k] = st.classification[p]; intensity[k] = st.intensity[p]; if (rgb) { rgb[k * 3] = st.rgb![p * 3]; rgb[k * 3 + 1] = st.rgb![p * 3 + 1]; rgb[k * 3 + 2] = st.rgb![p * 3 + 2]; } }
			dumpEnu({ x, y, z }, b, { ll, vUnit, dz, anchor }, out);
		}
	} else {   // COPC＝階層を全部読み、浅い節から順に上限まで（深さの順＝自然な間引き）
		const nodes: CopcNode[] = [], pages: CopcPage[] = [{ key: [0, 0, 0, 0], offset: (info as CopcInfo).rootHierOffset, byteSize: (info as CopcInfo).rootHierSize }], seen = new Set<string>();
		while (pages.length) {
			const pg = pages.pop()!, k = pg.key.join("-"); if (seen.has(k)) continue; seen.add(k);
			const page = parseHierarchyPage(new Uint8Array(await set.src!.read(pg.offset, pg.byteSize)));
			for (const nd of page.nodes) if (nd.pointCount > 0) nodes.push(nd);
			for (const sp of page.pages) pages.push(sp);
		}
		nodes.sort((a, b) => a.key[0] - b.key[0] || a.offset - b.offset);
		total = nodes.reduce((s, nd) => s + nd.pointCount, 0);
		// 浅い深さは丸ごと・上限に当たる深さは（その深さの節を全部・各節を等間隔に間引いて）残りの枠に収める＝偏らない。より深い節は読まない
		const take: { nd: CopcNode; stride: number; k: number }[] = []; let want = 0;
		for (let i = 0; i < nodes.length;) {
			const d = nodes[i].key[0]; let j = i, sum = 0; while (j < nodes.length && nodes[j].key[0] === d) sum += nodes[j++].pointCount;
			const room = max ? max - want : Infinity;
			if (room <= 0) break;
			const stride = dumpStride(sum, room);
			for (let q = i; q < j; q++) { const k = Math.ceil(nodes[q].pointCount / stride); take.push({ nd: nodes[q], stride, k }); want += k; }
			if (stride > 1) break;
			i = j;
		}
		n = want;
		out = { pts: new Float32Array(n * 3), elev: new Float32Array(n), at: 0, bb };
		rgb = hasRgb(hdr.format) ? new Uint8Array(n * 3) : null; cls = new Uint8Array(n); intensity = new Uint16Array(n);
		const decode = await laz();
		let shift = -1;   // RGB の 16bit／8bit＝最初の節で見分ける
		for (let i = 0; i < take.length; i += 4) {   // 4 節ずつ取る（読みと解読を重ねる）
			const batch = take.slice(i, i + 4), t1 = performance.now();
			const bufs = await Promise.all(batch.map(b => set.src!.read(b.nd.offset, b.nd.byteSize)));
			tRead += performance.now() - t1;
			for (let j = 0; j < batch.length; j++) {
				const { nd, stride, k } = batch[j], rec = await decode(bufs[j], { format: hdr.format, recordLength: hdr.recordLength, count: nd.pointCount }), r = thin(readRecords(rec, nd.pointCount, hdr), stride, k), at = out.at;
				dumpEnu(r, k, { ll, vUnit, dz, anchor }, out);
				cls.set(r.classification, at); intensity.set(r.intensity, at);
				if (rgb && r.rgb) { if (shift < 0) { let mx = 0; for (let q = 0; q < r.rgb.length; q++) if (r.rgb[q] > mx) mx = r.rgb[q]; shift = mx > 255 ? 8 : 0; } for (let q = 0; q < r.rgb.length; q++) rgb[at * 3 + q] = r.rgb[q] >> shift; }
			}
		}
	}
	if (!n) bb.fill(0);
	return { n, anchor, pts: out.pts, elev: out.elev, rgb, intensity, cls, bb, total, ms: { read: Math.round(tRead), total: Math.round(performance.now() - t0) } };
}

self.onmessage = async (e: MessageEvent<CopcMsg | null>) => {
	const m = (e.data || {}) as CopcMsg;
	try {
		if (m.ell !== undefined) setDecodeEnv({ ell: m.ell });
		if (m.type === "open") { const r = await open(m); self.postMessage({ type: "opened", id: m.id, ...r }); }
		else if (m.type === "page") { const s = sets.get(m.id); const b = new Uint8Array(await s!.src!.read(m.page!.offset, m.page!.byteSize)); self.postMessage({ type: "page", id: m.id, rid: m.rid, ...withSpheres(s!, parseHierarchyPage(b)) }); }
		else if (m.type === "node") {
			const r = await node(m as CopcMsg & { node: CopcNode });
			self.postMessage({ type: "node", id: m.id, rid: m.rid, ...r }, [r.pos.buffer, r.elev.buffer, r.intensity.buffer, r.cls.buffer, ...(r.rgb ? [r.rgb.buffer] : [])]);
		}
		else if (m.type === "dump") {
			const r = await dump(m);
			self.postMessage({ type: "dump", id: m.id, rid: m.rid, ...r }, [r.pts.buffer, r.elev.buffer, r.intensity.buffer, r.cls.buffer, ...(r.rgb ? [r.rgb.buffer] : [])]);
		}
		else if (m.type === "close") sets.delete(m.id);
	} catch (err) {
		self.postMessage({ type: "error", id: m.id, rid: m.rid, error: String(err && (err as Error).message || err) });
	}
};
