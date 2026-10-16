// 大規模モードのモデル（Phase1取込=8/25・Phase2ジオメトリ編集=8/26）：ZCTA級（数万ポリ・数千万頂点）は
// 全量トポロジ抽出（頂点ごとJS Map網）が数GBでtab OOM＝位相抽出を丸ごとスキップし、
// geopbf バイト列＋GintBUF（pbf.unPackGint）を真実源のまま編集背骨にする。
//
// eid＝fid 恒等。フィーチャは {fid, type, properties} の軽い facade（33k個の小オブジェクト＝無害）。
// ジオメトリは「選択・pop錨など1個だけ要る」場面に限り GintBUF から遅延lift：
//   arcs Map ＝ aid(GintBUF実ID) → { pts: Float64Array鏡像, closed, refs:[fid…] }
//   f.arcs   ＝ polyStream/lineStream 由来の符号付arc参照リスト（TopoJSON型・model.ts と同規約）
// 共有arc は同じ arc オブジェクトを複数fidが参照＝編集で隣も動く（フル位相と同じ意味論）。
//
// 頂点移動＝arcBuffer(u64) への in-place 書き（L1=Morton+終端bit / L2=8単位丸め+weight6bit の形式を保存）。
// 端点は端点索引（同座標の全arc端）で溶接＝ノードと同じ意味論。arc数を変える操作（挿入/削除/追加/削除）は
// Phase2 対象外（controller が入口で弾く）。書き出しは変更fidだけ GintBUF から再エンコード・他はバイト複写。
// 依存は geopbf のみ（model.ts を経由しない）＝Node試験可。
import { GeoPBFBase, makeKeys } from "../pbf-base.ts";
import { gint } from "../extension/gint.ts";
import type { Geometry, UnPackGint } from "../../types/geopbf.js";
import type { ArcTree, XY } from "./topo-extract.ts";

const sidOf = (s: number): number => (s < 0 ? ~s : s);
const SCALE = 1e7;   // gint.SCALE_E（PRECISION=7 固定＝gint座標系の正本）

// listsOf は model.ts の物をそのまま使う（旧＝「model.js は anno.js を連れてくる」として局所に写していたが、model.ts の import は
// geom／topo-extract／sphere／snap／spline だけ＝Node でも読める。geoedit は model も large-model も読む＝閉包は増えない）
import { listsOf } from "./model.ts";
export { listsOf };

/** 遅延 lift 済みの arc（pts＝GintBUF の Float64 鏡像・refs＝参照する fid） */
export interface LargeArc { pts: Float64Array; closed: boolean; refs: number[] }
/** フィーチャの facade（arcs／coords は初アクセスで GintBUF から lift） */
export interface LargeFeature { fid: number; type: string; properties: Record<string, unknown>; readonly arcs?: ArcTree; readonly coords?: XY[] }
/** 大規模モードの安定アドレス＝GintBUF 実 ID と頂点番号 */
export interface LargeAddr { gaid: number; idx: number }
/** controller が流すコマンド（props と move 以外は入口で弾かれる） */
export interface LargeCmd { op: string; eid?: number; addr?: LargeAddr; from?: unknown; to?: unknown; [key: string]: unknown }
/** GintBUF 位相の遅延索引 */
interface LargeTopo {
	polyMap: Map<number, number[][][]>; lineMap: Map<number, number[][]>;
	refsIndex: Map<number, number[]>;
	endpointIndex: Map<string, [number, number][]>;
}
/** 焼き込み済みの GintBUF（arcMeta／arcBuffer は必ずある） */
type Baked = UnPackGint & { arcMeta: Uint32Array; arcBuffer: BigUint64Array };

export interface LargeModel {
	large: true;
	pbf: GeoPBFBase;
	feats: Map<number, LargeFeature>; featsArr: LargeFeature[];
	arcs: { get(aid: number): LargeArc | undefined };
	warnings: string[];
	nodes: { get(key: string): { ends: [number, 0 | 1][] } | undefined };
	gridExp: number;
	stitch(list: number[]): XY[]; arcCoords(s: number): XY[];
	toPbf(opts?: { name?: string }): Promise<GeoPBFBase>;
	listsOf: typeof listsOf;
	moveVertex(aid: number, vidx: number, lng: number, lat: number): { dirty: number[] } | null;
	refreshDirty(): void;
	endNodeOf(aid: number, end: 0 | 1): string | null;
	readonly geomDirty: boolean;
	clearGeomDirty(): void;
	familyOf(t: string): "poly" | "line" | "point";
	addrOf(aid: number, idx: number): LargeAddr;
	applyCmd(cmd: LargeCmd): unknown;
	invertCmd(cmd: LargeCmd): LargeCmd;
	setGrid(): void;
	snap: { nearest(): null };
	stats(): { features: number; arcs: number; vertices: number };
}

export function createLargeModel(pbf: GeoPBFBase): LargeModel {
	const n = pbf.length;
	const feats = new Map<number, LargeFeature>(), featsArr = new Array<LargeFeature>(n);
	const arcs = new Map<number, LargeArc>();       // 遅延lift済み arc：aid → { pts, closed, refs }
	const warnings: string[] = [];
	const dirtyArcs = new Set<number>();  // 移動された arc（bbox 再計算とコミット要否の台帳）
	const dirtyFids = new Set<number>();  // ジオメトリが原本バイト列から乖離した fid（書き出しで再エンコード）
	let geomDirty = false;        // コミット（g再送）待ちの編集があるか

	// ---- GintBUF 位相の遅延索引（初アクセスで一度だけ構築）----
	// polyMap/lineMap: fid → 符号付arc参照構造（polygon=comps[rings[refs]] / line=sets[refs]）
	// refsIndex: aid → [fid…]（共有arcの隣人＝ドラッグ時の隠し集合と dirtyFids 伝播）
	// endpointIndex: "ix,iy" → [[aid, vidx(0|len-1)]…]（端点溶接＝ノードの代役）
	let topo: LargeTopo | null = null;
	const g = (): Baked => {
		const u = pbf.unPackGint;
		if (!u) throw new Error("large-model: gint not baked (call loadLarge after pbf.gint())");
		return u as Baked;
	};
	const ensureTopo = (): LargeTopo => {
		if (topo) return topo;
		const u = g();
		const polyMap = new Map<number, number[][][]>(u.polygon ?? []), lineMap = new Map<number, number[][]>(u.polyline ?? []);
		const refsIndex = new Map<number, number[]>();
		const addRef = (s: number, fid: number): void => { const aid = sidOf(s); let r = refsIndex.get(aid); if (!r) refsIndex.set(aid, (r = [])); if (!r.includes(fid)) r.push(fid); };
		// polygon: fid → comps → rings → refs（3段）／ polyline: fid → sets → refs（2段）
		for (const [fid, comps] of polyMap) for (const rings of comps) for (const list of rings) for (const s of list) addRef(s, fid);
		for (const [fid, sets] of lineMap) for (const list of sets) for (const s of list) addRef(s, fid);
		// 端点索引：全arcの両端（arcCount×2 エントリ＝ZCTA級でも数十万＝軽い）
		const endpointIndex = new Map<string, [number, number][]>();
		const meta = u.arcMeta, buf = u.arcBuffer, arcCount = u.arcCount;
		for (let aid = 0; aid < arcCount; aid++) {
			const off = meta[aid * 8], len = meta[aid * 8 + 1];
			if (!len) continue;
			for (const vidx of len === 1 ? [0] : [0, len - 1]) {
				const [ix, iy] = gint.unpackToInt(buf[off + vidx]);
				const key = ix + "," + iy;
				let e = endpointIndex.get(key);
				if (!e) endpointIndex.set(key, (e = []));
				e.push([aid, vidx]);
			}
		}
		return (topo = { polyMap, lineMap, refsIndex, endpointIndex });
	};

	// ---- arc lift：GintBUF → Float64 鏡像（表示/ハンドル用。真実源は arcBuffer）----
	const liftArc = (aid: number): LargeArc => {
		let arc = arcs.get(aid);
		if (arc) return arc;
		const u = g(), t = ensureTopo();
		const off = u.arcMeta[aid * 8], len = u.arcMeta[aid * 8 + 1];
		const pts = new Float64Array(len * 2);
		for (let i = 0; i < len; i++) {
			const [ix, iy] = gint.unpackToInt(u.arcBuffer[off + i]);
			pts[i * 2] = ix / SCALE - 180; pts[i * 2 + 1] = iy / SCALE - 90;
		}
		const closed = len > 2 && pts[0] === pts[len * 2 - 2] && pts[1] === pts[len * 2 - 1];
		arc = { pts, closed, refs: t.refsIndex.get(aid) ?? [] };
		arcs.set(aid, arc);
		return arc;
	};
	const liftFeature = (fid: number): ArcTree => {   // f.arcs（符号付参照構造）＋参照arcの鏡像を実体化
		const t = ensureTopo(), f = feats.get(fid)!;
		if (f.type === "Polygon" || f.type === "MultiPolygon") {
			const comps = t.polyMap.get(fid) ?? [];
			for (const rings of comps) for (const list of rings) for (const s of list) liftArc(sidOf(s));
			return f.type === "Polygon" ? (comps[0] ?? []) : comps;
		}
		const sets = t.lineMap.get(fid) ?? [];
		for (const list of sets) for (const s of list) liftArc(sidOf(s));
		return f.type === "LineString" ? (sets[0] ?? []) : sets;
	};
	const liftPoint = (fid: number): XY[] => {
		let gj: Geometry | null = null;
		try { gj = pbf.getGeometry(fid); } catch { /* 壊れfeature＝空 */ }
		const c = (gj as { coordinates?: unknown } | null)?.coordinates;
		if (!c) return [];
		return gj!.type === "Point" ? [c as XY] : c as XY[];
	};

	for (let i = 0; i < n; i++) {
		const type = pbf.getType(i);
		let properties: Record<string, unknown> = {};
		try { properties = (pbf.getProperties(i) as Record<string, unknown> | null) ?? {}; } catch { warnings.push(`feature[${i}]: properties could not be read`); }
		const f: LargeFeature = { fid: i, type, properties };
		if (type === "Point" || type === "MultiPoint")
			Object.defineProperty(f, "coords", { configurable: true, get() { const v = liftPoint(i); Object.defineProperty(f, "coords", { value: v, configurable: true }); return v; } });
		else
			Object.defineProperty(f, "arcs", { configurable: true, get() { const v = liftFeature(i); Object.defineProperty(f, "arcs", { value: v, configurable: true }); return v; } });
		feats.set(i, f);
		featsArr[i] = f;
	}

	// ---- 縫合（pop錨・オーバレイ・書き出しの共通規約＝model.ts と同一）----
	const arcCoords = (s: number): XY[] => {
		const arc = liftArc(sidOf(s)), pts = arc.pts, len = pts.length / 2, out = new Array<XY>(len);
		for (let i = 0; i < len; i++) { const k = s < 0 ? len - 1 - i : i; out[i] = [pts[k * 2], pts[k * 2 + 1]]; }
		return out;
	};
	const stitch = (list: number[]): XY[] => {
		const out = arcCoords(list[0]);
		for (let k = 1; k < list.length; k++) { const c = arcCoords(list[k]); for (let i = 1; i < c.length; i++) out.push(c[i]); }
		return out;
	};

	// ---- 頂点移動（Phase2 の心臓）：arcBuffer in-place パッチ＋端点溶接 ----
	// u64 の形式を保存して書く：L1(終端bit)=そのまま packFromInt／L2=8単位丸め+weight6bit を toL2 で再構成。
	const writeVertex = (aid: number, vidx: number, ix: number, iy: number): void => {
		const u = g(), off = u.arcMeta[aid * 8];
		const old = u.arcBuffer[off + vidx];
		const L1 = gint.packFromInt(ix, iy);   // 終端bit付き
		u.arcBuffer[off + vidx] = (old & gint.TERMINAL_BIT) ? L1 : gint.toL2(L1, gint.getWeight(old));
		const arc = arcs.get(aid);
		if (arc) { arc.pts[vidx * 2] = ix / SCALE - 180; arc.pts[vidx * 2 + 1] = iy / SCALE - 90; }
		dirtyArcs.add(aid);
		for (const fid of ensureTopo().refsIndex.get(aid) ?? []) dirtyFids.add(fid);
	};
	function moveVertex(aid: number, vidx: number, lng: number, lat: number): { dirty: number[] } | null {
		const u = g(), t = ensureTopo();
		const len = u.arcMeta[aid * 8 + 1];
		if (vidx < 0 || vidx >= len) return null;
		const ix = Math.round((lng + 180) * SCALE), iy = Math.round((lat + 90) * SCALE);
		const off = u.arcMeta[aid * 8];
		const [ox, oy] = gint.unpackToInt(u.arcBuffer[off + vidx]);
		if (ox === ix && oy === iy) return { dirty: [] };
		const isEnd = vidx === 0 || vidx === len - 1;
		let targets: [number, number][] = [[aid, vidx]];
		if (isEnd) {   // 溶接：同座標の全arc端（閉環1本arcの両端も同キー＝両方動く）
			const key = ox + "," + oy;
			const ends = t.endpointIndex.get(key);
			if (ends?.length) {
				targets = ends;
				t.endpointIndex.delete(key);
				const nk = ix + "," + iy;
				const cur = t.endpointIndex.get(nk);
				if (cur) cur.push(...ends); else t.endpointIndex.set(nk, ends);
			}
		}
		const dirty: number[] = [];
		for (const [a2, v2] of targets) { writeVertex(a2, v2, ix, iy); dirty.push(a2); }
		geomDirty = true;
		return { dirty };
	}

	// ---- dirty の後始末：VW weight再計算＋arcMeta bbox＋fid別bbox の部分再計算 ----
	// weight再計算＝編集で頂点が動くと周辺のVW weightは旧形状のまま＝LODがそこをスキップした弦（chord）を
	// 描き「余計な線」に見える（drawn=静止確定で露見・本人報告8/26）。dirty arcを全L1化→L1toL2で新形状の
	// weightへ焼き直す（表示LODのみの話＝位置は8単位丸め内で不変・identify/exportは無関係）。
	const reweightArc = (aid: number): void => {
		const u = g(), off = u.arcMeta[aid * 8], len = u.arcMeta[aid * 8 + 1];
		if (len < 3) return;
		const sub = u.arcBuffer.subarray(off, off + len);
		for (let i = 0; i < len; i++) { const [ix, iy] = gint.unpackToInt(sub[i]); sub[i] = gint.packFromInt(ix, iy); }   // 全L1化（位置保持）
		gint.L1toL2(sub);   // 新形状で VW → 内部頂点を L2 化
		const arc = arcs.get(aid);
		if (arc) for (let i = 0; i < len; i++) { const [ix, iy] = gint.unpackToInt(sub[i]); arc.pts[i * 2] = ix / SCALE - 180; arc.pts[i * 2 + 1] = iy / SCALE - 90; }   // 鏡像追随（L2丸め≤8単位≈9cm）
	};
	function refreshDirty(): void {
		if (!dirtyArcs.size) return;
		const u = g(), t = ensureTopo();
		const fids = new Set<number>();
		for (const aid of dirtyArcs) reweightArc(aid);
		for (const aid of dirtyArcs) {
			const off = u.arcMeta[aid * 8], len = u.arcMeta[aid * 8 + 1];
			let x0 = 0xFFFFFFFF, y0 = 0xFFFFFFFF, x1 = 0, y1 = 0;
			for (let i = 0; i < len; i++) {
				const [ix, iy] = gint.unpackToInt(u.arcBuffer[off + i]);
				if (ix < x0) x0 = ix; if (iy < y0) y0 = iy; if (ix > x1) x1 = ix; if (iy > y1) y1 = iy;
			}
			u.arcMeta[aid * 8 + 4] = x0; u.arcMeta[aid * 8 + 5] = y0; u.arcMeta[aid * 8 + 6] = x1; u.arcMeta[aid * 8 + 7] = y1;
			for (const fid of t.refsIndex.get(aid) ?? []) fids.add(fid);
		}
		for (const fid of fids) {   // fid別bbox＝所属arcのbbox和（buildFeatureBboxes と同じ物差し）
			const bb = u.polyBboxByFid?.get(fid) ?? u.lineBboxByFid?.get(fid);
			if (!bb) continue;
			bb[0] = 0xFFFFFFFF; bb[1] = 0xFFFFFFFF; bb[2] = 0; bb[3] = 0;
			const f = feats.get(fid)!;
			for (const { list } of listsOf(f)) for (const s of list) {
				const m = sidOf(s) * 8;
				if (u.arcMeta[m + 4] < bb[0]) bb[0] = u.arcMeta[m + 4]; if (u.arcMeta[m + 5] < bb[1]) bb[1] = u.arcMeta[m + 5];
				if (u.arcMeta[m + 6] > bb[2]) bb[2] = u.arcMeta[m + 6]; if (u.arcMeta[m + 7] > bb[3]) bb[3] = u.arcMeta[m + 7];
			}
		}
		dirtyArcs.clear();
	}

	// ---- 書き出し＝ストリーム置換複写＋変更fidだけ再エンコード（Phase3 の props-only を幾何へ拡張）----
	const geometryOf = (fid: number): Geometry | null => {   // GintBUF の現在値から GeoJSON geometry を縫合
		const f = feats.get(fid)!;
		if (f.type === "Polygon") return { type: "Polygon", coordinates: (f.arcs as number[][]).map(list => stitch(list)) };
		if (f.type === "MultiPolygon") return { type: "MultiPolygon", coordinates: (f.arcs as number[][][]).map(rings => rings.map(list => stitch(list))) };
		if (f.type === "LineString") return { type: "LineString", coordinates: stitch(f.arcs as number[]) };
		if (f.type === "MultiLineString") return { type: "MultiLineString", coordinates: (f.arcs as number[][]).map(list => stitch(list)) };
		return null;
	};
	async function toPbf({ name = "geoedit-export" }: { name?: string } = {}): Promise<GeoPBFBase> {
		const propsArr = featsArr.map(f => f.properties);
		const out = new GeoPBFBase({ name, precision: pbf._precision });
		const [keys, bufs] = await makeKeys(propsArr);
		out.setHead(keys, bufs).setBody(() => {
			for (let i = 0; i < n; i++) {
				if (dirtyFids.has(i)) out.setFeature({ type: "Feature", geometry: geometryOf(i), properties: propsArr[i] });   // 幾何が動いた fid＝現在値で再エンコード
				else out.setMessage(GeoPBFBase.TAGS.FEATURE, () => { out.copyGeometry(pbf, i); out.setProperties(propsArr[i]); });   // 無変更＝バイト複写
			}
		}).close();
		await out.getPosition();
		return out;
	}

	// ---- ノード相当（controller の dragTargets が読む端点接続）----
	const endNodeOf = (aid: number, end: 0 | 1): string | null => {
		const u = g(), off = u.arcMeta[aid * 8], len = u.arcMeta[aid * 8 + 1];
		if (!len) return null;
		const [ix, iy] = gint.unpackToInt(u.arcBuffer[off + (end ? len - 1 : 0)]);
		return ix + "," + iy;   // ノードID＝端点座標キー
	};
	const nodes: LargeModel["nodes"] = { get: key => { const e = ensureTopo().endpointIndex.get(key); return e ? { ends: e.map(([aid, vidx]): [number, 0 | 1] => [aid, vidx === 0 ? 0 : 1]) } : undefined; } };

	// arcs の公開面＝自動liftするfacade（Map互換の get だけ）。controller は端点ドラッグ/undoの巻き込み計算で
	// 「未liftの隣接arc」の refs を引く＝実Mapを渡すと undefined（端点ドラッグTypeError・undo時の隠し漏れ=古いgintが
	// 二重に見える「余計な線」）。lift は1arc分の鏡像化＝安い。
	const arcsView: LargeModel["arcs"] = { get: aid => (Number.isInteger(aid) && aid >= 0 && aid < g().arcCount ? liftArc(aid) : undefined) };
	return {
		large: true,
		pbf,                       // 真実源（identify・遅延lift・書き出しの原本）
		feats, featsArr, arcs: arcsView, warnings, nodes,
		gridExp: pbf._precision,
		stitch, arcCoords, toPbf, listsOf, moveVertex, refreshDirty, endNodeOf,
		get geomDirty() { return geomDirty; },
		clearGeomDirty: () => { geomDirty = false; },   // コミット（g再送）着地で寝かせる。dirtyFids は書き出し用に生涯保持
		familyOf: t => (t === "Polygon" || t === "MultiPolygon") ? "poly" : (t === "LineString" || t === "MultiLineString") ? "line" : "point",
		addrOf: (aid, idx) => ({ gaid: aid, idx }),   // 大規模モードの安定アドレス＝GintBUF実ID（Phase2はarc構造不変＝再抽出を跨がない）
		applyCmd: cmd => {
			if (cmd.op === "props") return (feats.get(cmd.eid!)!.properties = cmd.to as Record<string, unknown>, true);
			if (cmd.op === "move") { const to = cmd.to as number[]; return moveVertex(cmd.addr!.gaid, cmd.addr!.idx, to[0], to[1]); }
			return null;   // それ以外（構造操作）は controller が入口で弾く
		},
		invertCmd: cmd => (cmd.op === "props" || cmd.op === "move") ? { ...cmd, from: cmd.to, to: cmd.from } : cmd,
		setGrid: () => { },                        // 作図なし＝格子は無関係（UIの操作だけ受け流す）
		snap: { nearest: () => null },             // 吸着なし（Phase2は自由移動）
		stats: () => ({ features: n, arcs: 0, vertices: 0 }),   // 頂点数は数えない（数えない事が本旨）
	};
}
