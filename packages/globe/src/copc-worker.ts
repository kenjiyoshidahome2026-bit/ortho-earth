// 点群（COPC・普通の LAS/LAZ）の読み手 worker（#178）。main（gadgets/copc.js）が選んだ節だけを Range で取って LAZ を解き、原点相対の点にして返す。
//   普通の LAS/LAZ（COPC info が無い物・点群計画 段 3-3）は open で丸ごと読み、その場で八分木を作る（pointcloud-octree.js）＝以降の節は手元から集めるだけ。
//   開く  { type:"open", id, src: URL | Blob, headers?, crs?, vertical?, ell } → { type:"opened", id, info, root: { nodes, pages } }
//   頁    { type:"page", id, rid, page: { offset, byteSize } } → { type:"page", id, rid, nodes, pages }
//   節    { type:"node", id, rid, node, N, heightOffset } → { type:"node", id, rid, n, pos(Float32・原点相対), origin, rgb(Uint8×3|null), intensity(Uint16), cls(Uint8), elev(Float32・m), ms: { read, decode, proj } }
// 解読＝"#pointcloud-formats" の laz（プラグイン @ortho-earth/tile-formats/pointcloud＝laz-perf 0.0.7 の ChunkDecoder・WASM・Apache-2.0）。
//   globe 自身は laz-perf に依存しない（本人裁定＝プラグインの形）・差し込まれていなければ open で何を足すかを返す。最初の節で一度だけ起こす（起動の重さは 0）。
// 座標＝opts.crs／WKT（LASF_Projection 2112）／GeoTIFF キー（34735）→ pointcloud-crs.js（geopbf/proj の crsFromWKT＝TM・メルカトル・LCC・Albers・経緯度）→ 経緯度。高さ＝z（鉛直の単位）
//   ＋楕円体高なら N（main が節の中心で EGM96 から引いて渡す）を引いて標高へ（この地図の標高はジオイド基準）・鉛直の CRS がジオイド系を申告していればそのまま。
// 世界座標＝meshdecode の geoWorld（建物メッシュ・3D Tiles の点と同じ式・楕円体表示も）。
import { POINTCLOUD_FORMATS } from "#pointcloud-formats";
import { openSource } from "geopbf/cog/source";
import { resolveCrs } from "./pointcloud-crs.ts";
import { geoWorld, setDecodeEnv, earthW } from "./meshdecode.ts";
import { placeNode } from "./copc-place.ts";
import { wholeFileLimit, createStore, appendRaw, buildOctree, gatherNode } from "./pointcloud-octree.ts";
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
	type?: "open" | "page" | "node" | "close"; id: number; rid?: number; ell?: boolean;
	src?: string | Blob; headers?: Record<string, string>; crs?: string; vertical?: "orthometric" | "ellipsoidal";
	page?: { offset: number; byteSize: number }; node?: CopcNode; N?: number; heightOffset?: number;
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
	const src = await openSource(m.src!, { headerBytes: 65536, ...(fetchFn ? { fetch: fetchFn } : {}) });
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
	const whole = ci ? null : await readWhole(src, hdr, vlrs, typeof m.src !== "string");
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
	const dz = (set.orthometric ? 0 : -(m.N || 0)) + (m.heightOffset || 0);
	const { pos, origin, elev, affine } = placeNode(r, n, { ll, vUnit: set.vUnit, dz, EW: earthW(), bounds: nodeBounds(set.info as CopcInfo, m.node.key) });   // 節ごとの二次式（ずれ 1 cm 超は 1 点ずつ）＝copc-place.js
	let rgb: Uint8Array | Uint16Array | null = null;
	if (r.rgb && set.mem) rgb = r.rgb;
	else if (r.rgb) {   // LAS の RGB は 16bit が作法だが 8bit のまま入れる書き手もいる＝最大値で見分ける
		let mx = 0; for (let i = 0; i < r.rgb.length; i++) if (r.rgb[i] > mx) mx = r.rgb[i];
		const sh = mx > 255 ? 8 : 0; rgb = new Uint8Array(n * 3); for (let i = 0; i < rgb.length; i++) rgb[i] = r.rgb[i] >> sh;
	}
	return { n, pos, origin, affine, rgb, intensity: r.intensity, cls: r.classification, elev, ms: { read: t1 - t0, decode: t2 - t1, proj: performance.now() - t2 } };   // ms＝計測（点群計画 段 0）：取得・解読（LAZ＋記録）・投影と色
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
		else if (m.type === "close") sets.delete(m.id);
	} catch (err) {
		self.postMessage({ type: "error", id: m.id, rid: m.rid, error: String(err && (err as Error).message || err) });
	}
};
