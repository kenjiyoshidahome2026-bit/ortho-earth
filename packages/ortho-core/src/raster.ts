// 画像タイル層（メルカトル XYZ ラスタ）＝v1 ortho-map base.js の知見を v2 のノード（mat4／球／worker／地形）で再導出したもの。
//
// 置き場＝render worker（terrain.js と同じ流儀：自前で取得し、GPU 資産は renderer の口で作る）。DOM に触れない。
// 描画方式＝「先に合成・後で貼る」（RTT ドレープ・2026-09-21 本人指摘「基図をしっかり合成してから処理」）：
//   1. タイル群を GPU で経緯度整列のアトラス（近窓＝視野 1.8 画面幅・遠窓＝選抜の外接）へ合成する（タイル 1 枚＝タイル北西隅からの
//      dLL 格子メッシュ＋uv。uv の v はメルカトル線形＝格子の行・緯度は逆メルカトルで CPU が置く＝メルカトル→経緯度の warp は
//      このメッシュが担う。CRS はシェーダに入れない）
//   2. 地形・球・塗りの FS が画素ごとにアトラスを標本化する（COG スロットと同じ配線）＝地形面そのものに写る＝幾何の不一致がゼロ
//      （頂点で貼る方式は「折れ目をまたぐ弦が地形に潜る」＝細分・バイアス・リフトでは消えなかった＝iPhone 実機）。
// 携えた v1 の知見＝祖先フォールバック（親テクスチャの部分 uv）・CLAMP_TO_EDGE＋mips・世代番号で在庫を全捨て。
// 再導出した所＝選抜（selectLOD：距離 LOD・sticky・地形リフト球）・貼り方（画素標本化）・可視判定（地形/球の FS に委ねる）。
//
// renderer 契約（gl/renderer.js・gpu/renderer.js が実装）：
//   rasterTex(bitmap) → { kind:"tex", bytes, … }      rasterMesh({pos,uv,idx}) → { kind:"mesh", bytes, count, … }
//   rasterFree(handle)                                  setRasterDraws(rd | null)
//   rd = { rev, hideFills:bool, layers:[{ order:"under"|"over", opacity, resampling:"linear"|"nearest", draws:[{ mesh, tex, nw:[lon,lat], bounds:[w,s,e,n], uvT:[u0,v0,su,sv], a }] }] }
//   resampling＝層ごとの標本化（MapLibre の raster-resampling・C4）・a＝描画 1 枚の到着フェード（0→1・MapLibre の raster-fade-duration・既定 300ms。
//   フェード中は直下の祖先を先に描く＝親→子のクロスフェード。フェードの進行は rev を進めて合成し直す＝止まれば静止コスト 0 に戻る）
//   窓（近/中/遠）は renderer が持つ（ベクタ塗りと同じ「地面アトラス」＝2026-09-21 RTT ドレープ統合）。renderer は rev か窓か塗りが
//   変わった時だけアトラスを描き直し、毎フレームは標本化だけ（合成は静止中ゼロコスト）
import { selectLOD } from "./tilecover.ts";
import { tileBounds, tileLocalToLonLat, tileOutsideCoverage, tileId } from "./tile.ts";
import { createRasterSource } from "./raster-src.ts";
import type { CameraPose } from "./camera.ts";
import type { TileXYZ } from "./tile.ts";
import type { RasterSpec, RasterSource } from "./raster-src.ts";

/** タイル 1 枚の格子メッシュ（buildTileMesh の戻り） */
export interface TileMesh { pos: Float32Array; uv: Float32Array; idx: Uint16Array; n: number }
/** renderer が返す GPU 資産の把手（bytes＝常駐量・id＝署名用の通し番号） */
export interface RasterHandle { kind?: string; bytes?: number; id?: number; [k: string]: unknown }
/** 描画 1 枚 */
export interface RasterDraw { mesh: RasterHandle; tex: RasterHandle; nw: number[]; bounds: number[]; uvT: number[]; z: number; a: number; at?: number; until?: number }
export type RasterOrder = "under" | "over";
export type RasterResampling = "linear" | "nearest";
export interface RasterDrawLayer { order: RasterOrder; opacity: number; resampling: RasterResampling; draws: RasterDraw[]; rank?: number }
export interface RasterDraws { rev: number; hideFills: boolean; layers: RasterDrawLayer[] }
/** renderer 契約（gl/renderer.js・gpu/renderer.js が実装） */
export interface RasterRenderer { rasterTex(bitmap: ImageBitmap): RasterHandle; rasterMesh(m: TileMesh): RasterHandle; rasterFree(h: RasterHandle): void; setRasterDraws(rd: RasterDraws | null): void }
export interface RasterLayerOptions { rank?: number; order?: string; opacity?: number; visible?: boolean; hideFills?: boolean; tileBias?: number; resampling?: string; fadeDuration?: number; minZoom?: number; maxZoom?: number }
export interface RasterLayerSet { rank?: number | null; opacity?: number | null; visible?: boolean | null; order?: string; hideFills?: boolean | null; minZoom?: number | null; maxZoom?: number | null; resampling?: string; fadeDuration?: number | null }
export interface RasterInfo { id: string; kind: string; tileSize: number; minZoom: number; maxZoom: number; bbox: number[] | null; attribution: string | null; name: string | null; tileType: string | null; order: RasterOrder; opacity: number; hideFills: boolean; resampling: RasterResampling; fadeDuration: number }
export interface RasterPending { total: number; layers: Record<string, number>; fading: boolean }
export interface RasterLayerStats { id: string; kind: string | null; ready: number; loading: number; empty: number; error: number; selected: number; draws: number; order: RasterOrder; opacity: number; visible: boolean; hideFills: boolean; resampling: RasterResampling; fadeDuration: number; fading: boolean }
export interface RasterStats { layers: RasterLayerStats[]; texBytes: number; meshBytes: number; draws: number; meshes: number; inflight: number; budget: number; fading: boolean }
export interface RasterUpdateOptions { moving?: boolean; groundR?: number; /** 遠景のリフト球（遠景層の最大標高）＝tilecover.selectLOD の farR */ farR?: number }
export interface RasterOptions { renderer: RasterRenderer; requestDraw?: (() => void) | null; lowMem?: boolean; post?: ((m: unknown) => void) | null; maxTiles?: number; budgetMB?: number | null }
export interface Raster {
	add(id: string, spec: RasterSpec, opts?: RasterLayerOptions): Promise<RasterInfo>; remove(id: string): boolean; set(id: string, o?: RasterLayerSet): boolean;
	update(cam: CameraPose, W: number, H: number, opts?: RasterUpdateOptions | null): boolean | undefined; stats(): RasterStats; pending(): RasterPending; destroy(): void;
	bytes(): number; has(id: string): boolean; list(): string[];
}
type EntryStatus = "queued" | "loading" | "ready" | "empty" | "error" | "retry";
interface Entry { status: EntryStatus; z: number; x: number; y: number; tex: RasterHandle | null; bytes: number; seen: number; tries: number; ac?: AbortController | null; at?: number | null; err?: string }
interface QueueItem { key: string; z: number; x: number; y: number; dist: number }
interface Layer {
	id: string; spec: RasterSpec; source: RasterSource | null; error: string | null; gen: number; rank: number; order: RasterOrder; opacity: number; visible: boolean; hideFills: boolean; tileBias: number;
	resampling: RasterResampling; fadeDur: number; showMin: number; showMax: number; cache: Map<string, Entry>; queue: QueueItem[]; sticky: Set<number> | null; draws: RasterDraw[];
	dirty: boolean; camKey: string; selN: number; warned: boolean; fresh: boolean; inView: boolean; info?: RasterInfo;
}

const keyOf = (z: number, x: number, y: number): string => `${z}/${x}/${y}`;
const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());
const MAX_UP = 5;   // 祖先フォールバックの段数（v1＝3段＋高緯度補正。5 段＝1/32 の部分 uv までは絵として成立）
const COARSE_UP = 3;   // 先に取る粗い祖先の段（1 枚＝選抜 64 枚分・MAX_UP 以内＝描画の祖先フォールバックが届く）

// タイル 1 枚の格子メッシュ（純関数＝Node で検定）。頂点＝タイル北西隅からの (dlon, dlat) 度・uv＝(i/n, j/n)。
// 同じ z・同じ行 y なら x に依らず同一（経度は線形・緯度は行で決まる）＝メッシュは (z, y, n) でキャッシュできる。
export function buildTileMesh(z: number, y: number, n: number): TileMesh {
	const [w, , , north] = tileBounds(0, y, z);
	const V = (n + 1) * (n + 1);
	const pos = new Float32Array(V * 2), uv = new Float32Array(V * 2);
	for (let j = 0; j <= n; j++) {
		const [, lat] = tileLocalToLonLat(0, y, z, 0, j, n);
		for (let i = 0; i <= n; i++) {
			const [lon] = tileLocalToLonLat(0, y, z, i, 0, n);
			const k = (j * (n + 1) + i) * 2;
			pos[k] = lon - w; pos[k + 1] = lat - north;
			uv[k] = i / n; uv[k + 1] = j / n;
		}
	}
	const idx = new Uint16Array(n * n * 6);
	let o = 0;
	for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
		const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
		idx[o++] = a; idx[o++] = c; idx[o++] = b; idx[o++] = b; idx[o++] = c; idx[o++] = d;
	}
	return { pos, uv, idx, n };
}
// 極の蓋（2026-10-25）：メルカトルの端（±85.05°）から極までを、端の行のタイルの縁の 1 行で塗る帯（CesiumJS・MapLibre の globe と同じく画像の縁を極へ伸ばす）。
// 頂点＝帯の北西隅（北の蓋＝(w, 90)・南の蓋＝(w, −85.05)）からの (dlon, dlat) 度・uv の v は縁の行（北＝0・南＝1）＝伸ばすだけ。2 行 × n 列
export function buildPoleCapMesh(z: number, south: boolean, n: number): TileMesh {
	const span = 360 / (1 << z), [, s0, , n0] = tileBounds(0, south ? (1 << z) - 1 : 0, z), h = south ? s0 + 90 : 90 - n0;
	const pos = new Float32Array((n + 1) * 4), uv = new Float32Array((n + 1) * 4);
	for (let j = 0; j <= 1; j++) for (let i = 0; i <= n; i++) {
		const k = (j * (n + 1) + i) * 2;
		pos[k] = span * i / n; pos[k + 1] = -h * j;
		uv[k] = i / n; uv[k + 1] = south ? 1 : 0;
	}
	const idx = new Uint16Array(n * 6);
	for (let i = 0, o = 0; i < n; i++) { const a = i, b = i + 1, c = i + n + 1, d = c + 1; idx[o++] = a; idx[o++] = c; idx[o++] = b; idx[o++] = b; idx[o++] = c; idx[o++] = d; }
	return { pos, uv, idx, n };
}
// 細分数＝メルカトル→経緯度 warp の精度（アトラスは経緯度整列・タイルはメルカトル）。低 z ほど非線形＝細かく。z≥6 は 8 で十分
export const subdivOf = (z: number): number => z < 3 ? 32 : z < 6 ? 16 : 8;

// 祖先の部分 uv：タイル (z,x,y) を祖先 (z−d) のテクスチャで描く時の [u0, v0, su, sv]（メルカトルは段を跨いでも線形＝厳密）
export function ancestorUV(x: number, y: number, d: number): number[] {
	const m = 1 << d, inv = 1 / m;
	return [(x & (m - 1)) * inv, (y & (m - 1)) * inv, inv, inv];
}

export function createRaster({ renderer, requestDraw, lowMem = false, post = null, maxTiles = lowMem ? 160 : 400, budgetMB = null }: RasterOptions): Raster {
	const layers = new Map<string, Layer>();          // id → L
	const meshes = new Map<string, { h: RasterHandle; seen: number }>();          // "z/y/n" → { h, seen }（層をまたいで共有）
	const MESH_CAP = 256;
	const BUDGET = budgetMB ? Math.round(budgetMB * 1048576) : (lowMem ? 24 : 64) << 20;   // GPU テクスチャの常駐予算（mips 込み）。LOW_MEM＝iOS jetsam 対策の側。budgetMB＝検定用の明示
	const CONC = lowMem ? 4 : 8;       // 同時取得数（v1 は hardwareConcurrency 本の sub-worker・ここは fetch の並列）
	const CONC_MOVING = lowMem ? 1 : 2;   // 遷移中（飛行/入力）は絞る＝「トランジション通過点で重い層を発火させない」の一般則（着地で本来の並列へ戻る）
	let inflight = 0, clock = 0, texBytes = 0, meshBytes = 0, drawCount = 0, gen = 0, moving = false, rev = 0, lastSig = "", sigDirty = true, texSeq = 0;
	let fading = false;   // 直近の update で到着フェードが進行中（rasterPending に載せる＝idle が待つ）
	let lastPendSig = "";   // rasterPending の前回の申告（変わった時だけ main へ）
	// 未着の申告（idle / isSourceLoaded の材料・2026-09-28）＝層ごとに「開いている途中＝1」「開いた直後で一度も選抜していない＝1」「見えている選抜の未着（queued/loading/retry）の枚数」。
	// 見えていない層（visible:false・表示域の外）は 0。合計が変わった時だけ post（main の checkIdle と isSourceLoaded が読む）
	function pendingOf(L: Layer): number {
		if (!L.source || L.fresh) return 1;
		if (!L.inView) return 0;
		let n = 0;
		for (const e of L.cache.values()) if (e.status === "queued" || e.status === "loading" || e.status === "retry" || (e.status === "error" && (e.tries || 0) <= 3)) n++;   // 失敗して再試行待ち（400ms×回数の後に retry）も未着
		return n;
	}
	function pending(): RasterPending { const layers_: Record<string, number> = {}; let total = 0; for (const L of layers.values()) { const n = pendingOf(L); if (n) { layers_[L.id] = n; total += n; } } return { total, layers: layers_, fading }; }
	function reportPending(): void {
		const p = pending(), sig = Object.entries(p.layers).map(([k, n]) => k + ":" + n).join(",") + (p.fading ? "~" : "");
		if (sig === lastPendSig) return;
		lastPendSig = sig;
		say({ type: "rasterPending", total: p.total, layers: p.layers, fading: p.fading });   // fading＝到着フェードの最中（idle はこれも待つ＝MapLibre の hasTransition と同じ）
	}
	const say = (m: unknown): void => { if (post) try { post(m); } catch { /* main が居ない（検定等）＝無害 */ } };

	function meshFor(z: number, y: number, cap: "" | "n" | "s" = ""): RasterHandle {
		const n = subdivOf(z), k = `${z}/${y}/${n}${cap}`;
		let m = meshes.get(k);
		if (!m) {
			const h = renderer.rasterMesh(cap ? buildPoleCapMesh(z, cap === "s", n) : buildTileMesh(z, y, n));
			meshBytes += h.bytes || 0;
			m = { h, seen: 0 }; meshes.set(k, m);
			if (meshes.size > MESH_CAP) {   // 最も古いものを落とす（LRU）
				let oldK: string | null = null, old = Infinity;
				for (const [kk, mm] of meshes) if (mm.seen < old && kk !== k) { old = mm.seen; oldK = kk; }
				if (oldK) { const mm = meshes.get(oldK)!; meshBytes -= mm.h.bytes || 0; renderer.rasterFree(mm.h); meshes.delete(oldK); }
			}
		}
		m.seen = clock;
		return m.h;
	}

	function freeEntry(e: Entry): void {
		if (e.ac) { e.ac.abort(); e.ac = null; }
		if (e.tex) { texBytes -= e.bytes || 0; renderer.rasterFree(e.tex); e.tex = null; e.bytes = 0; }
	}

	// 取得（並列上限つき・距離順）。ready で層を dirty＝次フレームで描画リストが更新される
	function pump(): void {
		while (inflight < (moving ? CONC_MOVING : CONC)) {
			let best: QueueItem | null = null, bestL: Layer | null = null;
			for (const L of layers.values()) {
				if (!L.source || !L.queue.length) continue;
				const q = L.queue[0];
				if (!best || q.dist < best.dist) { best = q; bestL = L; }
			}
			if (!best) return;
			bestL!.queue.shift();
			const L = bestL!, e = L.cache.get(best.key), q = best;
			if (!e || e.status !== "queued") continue;
			e.status = "loading"; e.ac = new AbortController(); inflight++;
			const myGen = L.gen, src = L.source!;
			src.get(q.z, q.x, q.y, e.ac.signal).then(bitmap => {
				inflight--; e.ac = null;
				if (L.gen !== myGen || !layers.has(L.id)) { bitmap?.close?.(); return; }   // 世代替わり（remove/再 add）の遅着＝捨てる
				if (!bitmap) { e.status = "empty"; }
				else {
					try { e.tex = renderer.rasterTex(bitmap); e.tex.id = ++texSeq; e.bytes = e.tex.bytes || 0; texBytes += e.bytes; e.status = "ready"; e.at = now(); }
					catch (err) { e.status = "error"; e.tries = (e.tries || 0) + 1; console.warn("[raster] texture upload failed", (err as Error)?.message); }
					bitmap.close?.();
				}
				L.dirty = true; requestDraw && requestDraw(); pump();
			}, (err: unknown) => {
				inflight--; e.ac = null;
				const er = err as { message?: string; name?: string } | null;
				if (String(er && er.message) === "aborted" || er?.name === "AbortError") { L.cache.delete(q.key); pump(); return; }   // 視野外中断＝再訪で再取得
				e.status = "error"; e.tries = (e.tries || 0) + 1; e.err = String(er && er.message || err);
				if (e.tries <= 3) setTimeout(() => { if (layers.has(L.id) && L.cache.get(q.key) === e && e.status === "error") { e.status = "retry"; L.dirty = true; requestDraw && requestDraw(); } }, 400 * e.tries);
				else if (!L.warned) { L.warned = true; console.warn(`[raster] ${L.id}: tile fetch keeps failing (${e.err})`); say({ type: "rasterError", id: L.id, error: e.err }); }
				pump();
			});
		}
	}

	function selectFor(L: Layer, cam: CameraPose, W: number, H: number, opts: RasterUpdateOptions | null | undefined): TileXYZ[] {
		const src = L.source!;
		// 可視集合そのものが予算を超えるなら一段粗く（tilePx を上げる＝分割を早く止める）：退避は「今描いている物」を触れない
		// ので、可視集合を予算内に収めるのは選抜の責任（LOW_MEM 24MB＝写真 256²+mips≈350KB×68 枚）。層が複数なら分け合う。
		const perTile = src.tileSize * src.tileSize * 4 * 4 / 3, share = BUDGET * 0.7 / Math.max(1, layers.size);
		let tilePx = src.tileSize * 1.1 * (L.tileBias || 1), sel: (TileXYZ & { _d?: number })[] = [];   // 256px タイル＝画面上 ≈282px を超えたら分割（bvmap 512px の 560 と同じ比率）。tileBias＝mercator の目盛り
		for (let step = 0; step < 4; step++) {
			sel = selectLOD(cam, W, H, { minZ: Math.max(0, src.minZoom), maxZ: src.maxZoom, tilePx, sticky: step ? null : L.sticky, groundR: opts?.groundR ?? 1, farR: opts?.farR ?? opts?.groundR ?? 1 });
			if (sel.length * perTile <= share) break;   // 選抜だけで数える＝先に取る粗い祖先は余りの枠だけ（updateLayer）。旧（2026-10-26〜）＝祖先も数えて超えたら tilePx を上げた＝足元まで一段粗くなった（2026-10-31・MapLibre 公式例の門 3d-terrain）
			tilePx *= 1.6;
		}
		// 枚数の上限（低 z の巨大視野・極端なチルト）：遠い順に親へまとめる（4 枚→1 枚）＝遠景を粗くして埋める。
		// 旧＝遠い順に捨てる＝地平線の手前に下地の色（Cesium 例の既定は青）の帯が残った（2026-10-25・公式例の門）。まとめ切れない時だけ捨てる
		if (sel.length > maxTiles) {
			const c = cam.center, minZ = Math.max(0, src.minZoom);
			const dist = (t: TileXYZ): number => { const [w, s, e, n] = tileBounds(t.x, t.y, t.z); return Math.hypot((w + e) / 2 - c[0], (s + n) / 2 - c[1]); };
			for (let guard = 0; sel.length > maxTiles && guard < 32; guard++) {
				for (const t of sel) t._d = dist(t);
				sel.sort((a, b) => a._d! - b._d!);
				const far = Math.max(1, Math.ceil((sel.length - maxTiles) * 4 / 3)), up = new Map<string, TileXYZ>();
				for (let i = sel.length - 1; i >= 0 && sel.length - i <= far; i--) { const t = sel[i]; if (t.z > minZ) up.set(keyOf(t.z - 1, t.x >> 1, t.y >> 1), { z: t.z - 1, x: t.x >> 1, y: t.y >> 1 }); }
				if (!up.size) break;
				const covered = (t: TileXYZ): boolean => { for (let z = t.z, x = t.x, y = t.y; z > minZ;) { z--; x >>= 1; y >>= 1; if (up.has(keyOf(z, x, y))) return true; } return false; };
				const next = sel.filter(t => !covered(t) && !up.has(keyOf(t.z, t.x, t.y)));
				for (const t of up.values()) if (!covered(t)) next.push(t);
				if (next.length >= sel.length) break;
				sel = next;
			}
			if (sel.length > maxTiles) { for (const t of sel) t._d = dist(t); sel.sort((a, b) => a._d! - b._d!); sel.length = maxTiles; }
		}
		L.sticky = new Set();
		for (const t of sel) { let z = t.z, x = t.x, y = t.y; while (z > src.minZoom) { z--; x >>= 1; y >>= 1; const k = tileId(z, x, y); if (L.sticky.has(k)) break; L.sticky.add(k); } }   // selectLOD の sticky は tileId の番号鍵
		return sel;
	}

	// 選抜タイルを在庫へ（未着は取得列へ）・視野外の取得は中断・予算超過は LRU 退避・描画リストを組む
	function updateLayer(L: Layer, cam: CameraPose, W: number, H: number, opts: RasterUpdateOptions | null | undefined): void {
		L.fresh = false;
		const src = L.source!, sel = selectFor(L, cam, W, H, opts);
		const keep = new Set<string>(), pushed = new Set<string>();   // pushed＝この巡で要求列に入れた鍵（祖先の連鎖と retry の拾い直しで二重に入れない）
		const c = cam.center;
		L.queue.length = 0;
		const enqueue = (k: string, z: number, x: number, y: number, dist: number): void => { if (pushed.has(k)) return; pushed.add(k); L.queue.push({ key: k, z, x, y, dist }); };
		for (const t of sel) {
			const k = keyOf(t.z, t.x, t.y);
			keep.add(k);
			let e = L.cache.get(k);
			if (!e) {
				e = { status: "queued", z: t.z, x: t.x, y: t.y, tex: null, bytes: 0, seen: clock, tries: 0 };
				if (tileOutsideCoverage(t.x, t.y, t.z, src.bbox)) e.status = "empty";   // 配信圏外＝要求を作らない（404 の無駄打ちを断つ）
				L.cache.set(k, e);
			} else if (e.status === "retry") e.status = "queued";
			e.seen = clock;
			const [w, s, ea, n] = tileBounds(t.x, t.y, t.z), dist = Math.hypot((w + ea) / 2 - c[0], (s + n) / 2 - c[1]);
			if (e.status === "queued") enqueue(k, t.z, t.x, t.y, dist);
			else if (e.status === "empty" || (e.status === "error" && (e.tries || 0) > 3)) {
				// 無い（404/索引外）・取得を諦めた（失敗 4 回）＝v1 base.js と同じく祖先で埋める：連鎖の最初の「未知」の祖先を要求（ready/取得中に当たれば止まる）
				let z = t.z, x = t.x, y = t.y;
				for (let d = 1; d <= MAX_UP && z > 0; d++) {
					z--; x >>= 1; y >>= 1;
					const ak = keyOf(z, x, y), ae = L.cache.get(ak);
					if (!ae) {
						const aq: Entry = { status: "queued", z, x, y, tex: null, bytes: 0, seen: clock, tries: 0 };
						if (tileOutsideCoverage(x, y, z, src.bbox)) aq.status = "empty";
						L.cache.set(ak, aq); keep.add(ak);
						if (aq.status === "queued") enqueue(ak, z, x, y, dist + d);   // 同距離なら子を先に
						break;
					}
					// まだ取りに行っていない祖先（前の巡で queued にしたが並列の絞り＝移動中 2 本で取り残された・失敗して retry）＝要求列に戻す。
					// 旧＝「empty でなければ break」で放置＝queue は巡ごとに空にするので二度と要求されず、未着が永遠に残り idle が来ない（2026-09-28・公式例の門で発見）
					if (ae.status === "queued" || ae.status === "retry") { ae.status = "queued"; keep.add(ak); enqueue(ak, z, x, y, dist + d); break; }
					if (ae.status !== "empty" && !(ae.status === "error" && (ae.tries || 0) > 3)) break;
				}
			}
		}
		// 祖先（フォールバック候補）も「最近見えた」扱い＝LRU で先に消えて穴にならない
		for (const t of sel) { let z = t.z, x = t.x, y = t.y; for (let d = 1; d <= MAX_UP && z > 0; d++) { z--; x >>= 1; y >>= 1; const e = L.cache.get(keyOf(z, x, y)); if (e) { e.seen = clock; keep.add(keyOf(z, x, y)); } } }
		// 粗い祖先を先に（Cesium の preloadAncestors と同じ考え・2026-10-26）：選抜タイルの COARSE_UP 段上の祖先を距離より先に取る＝
		// 数枚で視野全体が粗く埋まり、細かいタイルが届くまで地平線側に下地の色（Cesium 例の既定は青）が残らない（旧＝距離順だけ＝遠景が最後）
		// 枠＝予算の残り（選抜が先・祖先は余りで取る）。足りなければ遠い祖先から＝近くの細かいタイルは距離順ですぐ届く・粗い埋めが効くのは地平線側
		const room = Math.floor(BUDGET * 0.7 / Math.max(1, layers.size) / (src.tileSize * src.tileSize * 4 * 4 / 3)) - sel.length;
		const coarse = new Map<string, { z: number; x: number; y: number; dist: number }>();
		for (const t of sel) {
			const d = Math.min(COARSE_UP, t.z - Math.max(0, src.minZoom)); if (d <= 0) continue;
			const z = t.z - d, x = t.x >> d, y = t.y >> d, k = keyOf(z, x, y);
			if (coarse.has(k) || keep.has(k) && L.cache.get(k)?.status === "ready") continue;
			const [w, s_, ea, n] = tileBounds(x, y, z); coarse.set(k, { z, x, y, dist: Math.hypot((w + ea) / 2 - c[0], (s_ + n) / 2 - c[1]) });
		}
		const coarseList = [...coarse].sort((a, b) => b[1].dist - a[1].dist).slice(0, Math.max(0, room));
		for (const [k, { z, x, y, dist }] of coarseList) {
			if (pushed.has(k)) continue;
			let e = L.cache.get(k);
			if (!e) { e = { status: "queued", z, x, y, tex: null, bytes: 0, seen: clock, tries: 0 }; if (tileOutsideCoverage(x, y, z, src.bbox)) e.status = "empty"; L.cache.set(k, e); }
			else if (e.status === "retry") e.status = "queued";
			e.seen = clock; keep.add(k);
			if (e.status === "queued") enqueue(k, z, x, y, dist - 1e6);
		}
		// 取得に失敗して retry になった祖先＝上の祖先の連鎖は「empty でない」所で止まるので、ここで拾って要求列へ戻す（旧＝放置＝穴が残り・未着 1 が永遠に消えず idle が来ない・2026-09-28）
		for (const [k, e] of L.cache) if ((e.status === "retry" || e.status === "queued") && keep.has(k) && !pushed.has(k)) { e.status = "queued"; const [w, s_, ea, n] = tileBounds(e.x, e.y, e.z); enqueue(k, e.z, e.x, e.y, Math.hypot((w + ea) / 2 - c[0], (s_ + n) / 2 - c[1]) + 1); }
		L.queue.sort((a, b) => a.dist - b.dist);
		for (const [k, e] of L.cache) if (e.status === "loading" && !keep.has(k)) { e.ac?.abort(); }   // 視野外は fetch ごと中断（catch が cache から消す）
		for (const [k, e] of L.cache) if (e.status === "queued" && !keep.has(k)) L.cache.delete(k);
		pump();
		// 描画リスト：自身が ready ならそのまま・未着/無しなら ready な祖先の部分 uv（v1 の親フォールバック）・祖先も無ければ描かない（球の下地が透ける）
		// 到着フェード（raster-fade-duration・C4）：着いたばかりのタイル（at から fadeDur 未満）は a を 0→1 で描き、その間だけ直下の ready な祖先を先に描く
		// （until＝祖先を外す時刻）＝MapLibre の親→子クロスフェード。a と until の進行は update が毎フレーム見る（選抜は走らせない）
		const draws: RasterDraw[] = [], t0 = now();
		for (const t of sel) {
			let z = t.z, x = t.x, y = t.y, e = L.cache.get(keyOf(z, x, y));
			let d = 0;
			while (!(e && e.status === "ready") && d < MAX_UP && z > 0) { z--; x >>= 1; y >>= 1; d++; e = L.cache.get(keyOf(z, x, y)); }
			if (!(e && e.status === "ready")) continue;
			const b = tileBounds(t.x, t.y, t.z), mesh = meshFor(t.z, t.y), nw = [b[0], b[3]];
			const fade = L.fadeDur > 0 && e.at != null && t0 - e.at < L.fadeDur;
			if (fade) {
				let az = z, ax = x, ay = y, ae: Entry | null | undefined = null, ad = d;
				while (ad < MAX_UP && az > 0) { az--; ax >>= 1; ay >>= 1; ad++; ae = L.cache.get(keyOf(az, ax, ay)); if (ae && ae.status === "ready") break; ae = null; }
				if (ae) draws.push({ mesh, tex: ae.tex!, nw, bounds: b, uvT: ancestorUV(t.x, t.y, ad), z: t.z, a: 1, until: e.at! + L.fadeDur });
			}
			draws.push({ mesh, tex: e.tex!, nw, bounds: b, uvT: d ? ancestorUV(t.x, t.y, d) : [0, 0, 1, 1], z: t.z, a: fade ? 0 : 1, at: fade ? e.at! : 0 });
			const cap = t.y === 0 ? "n" : t.y === (1 << t.z) - 1 ? "s" : "";   // 端の行＝極の蓋も（縁の 1 行を極まで伸ばす）
			if (cap) draws.push({ mesh: meshFor(t.z, t.y, cap), tex: e.tex!, nw: [b[0], cap === "n" ? 90 : b[1]], bounds: cap === "n" ? [b[0], b[3], b[2], 90] : [b[0], -90, b[2], b[1]], uvT: d ? ancestorUV(t.x, t.y, d) : [0, 0, 1, 1], z: t.z, a: 1, at: 0 });
		}
		L.draws = draws;
		L.selN = sel.length;
	}

	function evict(): void {
		if (texBytes <= BUDGET) return;
		// ⚠描画リストが参照中のテクスチャは絶対に退避しない：WebGPU は「破棄済みテクスチャを submit で使用」＝検証エラーで
		// フレームが丸ごと落ちる（＝黒画面。iPhone 実機で 2026-09-21 に被弾：静止中は seen が進まないのに時計だけ進み、
		// 予算超過の瞬間に可視タイルまで destroy していた）。可視集合が予算を超える分は selectFor の粗化が受け持つ。
		const inUse = new Set<RasterHandle>();
		for (const L of layers.values()) for (const d of L.draws) inUse.add(d.tex);
		const cands: [Layer, string, Entry][] = [];
		for (const L of layers.values()) for (const [k, e] of L.cache) if (e.status === "ready" && e.tex && !inUse.has(e.tex)) cands.push([L, k, e]);
		cands.sort((a, b) => a[2].seen - b[2].seen);
		for (const [L, k, e] of cands) { if (texBytes <= BUDGET) break; freeEntry(e); L.cache.delete(k); }
	}

	// 毎フレーム（render worker の frame から。カメラ不変・在庫不変なら選抜は走らない）
	function update(cam: CameraPose, W: number, H: number, opts?: RasterUpdateOptions | null): boolean | undefined {
		if (!layers.size) { reportPending(); return; }
		clock++;
		const wasMoving = moving; moving = !!opts?.moving;
		if (wasMoving && !moving) { for (const L of layers.values()) L.dirty = true; pump(); }   // 着地＝絞っていた取得を本来の並列で再開
		// 鍵のリフト球（groundR/farR）は 1e-7（≈0.6 m）まで見る：旧＝toFixed(4)＝637 m 刻み＝地形が後から届いて中心の標高が 95 m 持ち上がっても
		// 鍵が変わらず選び直されない（中心の標高 centerAlt＝目の高さも鍵に無かった）＝低い目（shadows 例・目が地面の 28 m 上）の足元のタイルが海面球の視野のまま＝下地色の長方形（2026-10-28・Mac 実機）
		const key = `${cam.zoom.toFixed(3)}/${cam.center[0].toFixed(5)}/${cam.center[1].toFixed(5)}/${(cam.pitch || 0).toFixed(3)}/${(cam.bearing || 0).toFixed(3)}/${W}x${H}/${(cam.centerAlt || 0).toFixed(1)}/${(opts?.groundR ?? 1).toFixed(7)}/${(opts?.farR ?? opts?.groundR ?? 1).toFixed(7)}`;
		let changed = false, anyFade = false;
		const tNow = now();
		const rd: RasterDraws = { rev: 0, hideFills: false, layers: [] };
		for (const L of layers.values()) {
			if (!L.source || !L.visible) { L.inView = false; L.fresh = false; if (L.draws.length) { L.draws = []; changed = true; } continue; }   // fresh を落とす＝伏せた層は未着に数えない
			const inRange = cam.zoom >= L.showMin && cam.zoom <= L.showMax;
			if (!inRange) { L.inView = false; L.fresh = false; if (L.draws.length) { L.draws = []; changed = true; } continue; }
			L.inView = true;
			if (L.camKey !== key || L.dirty) { L.camKey = key; L.dirty = false; updateLayer(L, cam, W, H, opts); changed = true; }
			else {
				// 原点は cam.center＝カメラ不変なら off も不変（camKey が同じ＝center 同じ）
			}
			let draws = L.draws;
			if (draws.some(d => d.at || d.until)) {   // 到着フェードの進行（a を進める・済んだ祖先を外す）＝描画リストが変わる＝署名で rev が進む
				draws = [];
				let live = false;
				for (const d of L.draws) {
					if (d.until) { if (tNow >= d.until) continue; live = true; draws.push(d); continue; }
					if (d.at) { const a = Math.min(1, (tNow - d.at) / Math.max(1, L.fadeDur)); if (a < 1) live = true; else d.at = 0; d.a = a; }
					draws.push(d);
				}
				if (live) anyFade = true; else L.draws = draws;   // 全部済んだ＝以後は組み直さない
				changed = true;
			}
			if (draws.length) rd.layers.push({ order: L.order, opacity: L.opacity, resampling: L.resampling, draws, rank: L.rank });
			if (L.order === "under" && L.hideFills && L.draws.length) rd.hideFills = true;
		}
		evict();
		// 合成順＝under（基図）を先に・over（重ね）を後に（同種内は追加順）。Map の追加順のままだと「重ねを先に点けてから基図を選ぶ」で
		// 基図が重ねの上に描かれ、ハザード等が見えなくなる（俯瞰レビューで発見 2026-09-21）
		// rank (the style order, set by the map's moveLayer) orders layers of the same kind when both have one; otherwise the order they were added
		rd.layers.sort((a, b) => (a.order === "over" ? 1 : 0) - (b.order === "over" ? 1 : 0) || (Number.isFinite(a.rank) && Number.isFinite(b.rank) ? a.rank! - b.rank! : 0));
		drawCount = 0; for (const l of rd.layers) drawCount += l.draws.length;
		if (rd.layers.length) {
			// 改訂番号：描画リスト（tex/uvT/位置/不透明度）が変わった時だけ進める＝静止中に到着が無ければアトラスは描き直さない。
			// 署名を組むのは描画リストが変わり得た時（選抜が走った・層の設定が変わった・層が消えた）だけ＝静止フレームは文字列を組まない（旧＝毎フレーム・層×描画の数だけ toFixed と join）
			if (changed || sigDirty) {
				const sig = rd.layers.map(l => l.order + l.opacity + l.resampling + ":" + l.draws.map(d => d.tex.id + "/" + d.uvT.join(",") + "/" + d.nw[0].toFixed(6) + "," + d.nw[1].toFixed(6) + (d.a < 1 ? "~" + d.a.toFixed(3) : "")).join(";")).join("#");
				if (sig !== lastSig) { lastSig = sig; rev++; }
				sigDirty = false;
			}
			rd.rev = rev;
		} else { lastSig = ""; sigDirty = false; }
		renderer.setRasterDraws(rd.layers.length ? rd : null);
		fading = anyFade;
		if (anyFade && requestDraw) requestDraw();   // フェード中は次のフレームも要る
		reportPending();
		return changed;
	}

	async function add(id: string, spec: RasterSpec, opts: RasterLayerOptions = {}): Promise<RasterInfo> {
		if (layers.has(id)) remove(id);
		const L: Layer = {
			id, spec, source: null, error: null, gen: ++gen, rank: Number.isFinite(opts.rank) ? opts.rank! : NaN,
			order: opts.order === "over" ? "over" : "under",
			opacity: Number.isFinite(opts.opacity) ? Math.max(0, Math.min(1, opts.opacity!)) : 1,
			visible: opts.visible !== false,
			hideFills: opts.hideFills !== undefined ? !!opts.hideFills : opts.order !== "over",   // 基図（under）は塗りを伏せる（裁定：線と注記は残す）
			tileBias: Number.isFinite(opts.tileBias) && opts.tileBias! > 0 ? opts.tileBias! : 1,
			resampling: opts.resampling === "nearest" ? "nearest" : "linear",   // MapLibre の raster-resampling（C4）＝層ごとの標本化
			fadeDur: Number.isFinite(opts.fadeDuration) ? Math.max(0, opts.fadeDuration!) : 300,   // MapLibre の raster-fade-duration（ms・既定 300）＝到着フェード   // 分割の閾の倍率（目盛り "mercator"＝タイルの z を MapLibre と同じに・globe.js の TILE_BIAS）
			showMin: -Infinity, showMax: Infinity, cache: new Map(), queue: [], sticky: null, draws: [], dirty: true, camKey: "", selN: 0, warned: false,
			fresh: false, inView: false,   // fresh＝開いた直後（最初の選抜まで未着 1 と数える）・inView＝直近の update で見えていた（pendingOf）
		};
		layers.set(id, L);
		reportPending();   // 開いている途中＝未着 1
		try {
			const src = await createRasterSource(spec);
			if (!layers.has(id) || layers.get(id) !== L) { src.close(); throw new Error("removed while opening"); }
			L.source = src;
			L.showMin = Number.isFinite(opts.minZoom) ? opts.minZoom! : src.minZoom - 1.5;   // 表示域＝配信下限の 1.5 段下から（v1 minZoom 門）。下は選抜爆発を避ける
			L.showMax = Number.isFinite(opts.maxZoom) ? opts.maxZoom! : Infinity;
			const info: RasterInfo = { id, kind: src.kind, tileSize: src.tileSize, minZoom: src.minZoom, maxZoom: src.maxZoom, bbox: src.bbox, attribution: src.attribution, name: src.name, tileType: src.tileType || null, order: L.order, opacity: L.opacity, hideFills: L.hideFills, resampling: L.resampling, fadeDuration: L.fadeDur };
			L.info = info;
			L.fresh = true; L.dirty = true; requestDraw && requestDraw();
			reportPending();   // rasterInfo より先に届く＝main は「開けた」を知る時すでに未着を知っている
			say({ type: "rasterInfo", id, info });
			return info;
		} catch (err) {
			L.error = String(err && (err as Error).message || err);
			if (layers.get(id) === L) layers.delete(id);
			reportPending();
			say({ type: "rasterError", id, error: L.error });
			throw err;
		}
	}
	function remove(id: string): boolean {
		const L = layers.get(id); if (!L) return false;
		L.gen = ++gen;
		for (const e of L.cache.values()) freeEntry(e);
		L.cache.clear(); L.queue.length = 0; L.draws = [];
		L.source?.close?.();
		layers.delete(id); sigDirty = true;
		if (!layers.size) renderer.setRasterDraws(null);
		reportPending();
		requestDraw && requestDraw();
		return true;
	}
	function set(id: string, o: RasterLayerSet = {}): boolean {
		const L = layers.get(id); if (!L) return false;
		if (o.opacity != null && Number.isFinite(o.opacity)) L.opacity = Math.max(0, Math.min(1, o.opacity));
		if (o.visible != null) L.visible = !!o.visible;
		if (o.order === "under" || o.order === "over") L.order = o.order;
		if (o.rank != null && Number.isFinite(o.rank)) L.rank = o.rank;
		if (o.hideFills != null) L.hideFills = !!o.hideFills;
		if (o.minZoom != null) L.showMin = o.minZoom;
		if (o.maxZoom != null) L.showMax = o.maxZoom;
		if (o.resampling === "nearest" || o.resampling === "linear") L.resampling = o.resampling;
		if (o.fadeDuration != null && Number.isFinite(o.fadeDuration)) L.fadeDur = Math.max(0, o.fadeDuration);
		L.dirty = true; sigDirty = true; requestDraw && requestDraw();
		return true;
	}
	function stats(): RasterStats {
		const out: RasterStats = { layers: [], texBytes, meshBytes, draws: drawCount, meshes: meshes.size, inflight, budget: BUDGET, fading };
		for (const L of layers.values()) {
			let ready = 0, loading = 0, empty = 0, error = 0;
			for (const e of L.cache.values()) { if (e.status === "ready") ready++; else if (e.status === "loading" || e.status === "queued") loading++; else if (e.status === "empty") empty++; else error++; }
			out.layers.push({ id: L.id, kind: L.source?.kind || null, ready, loading, empty, error, selected: L.selN, draws: L.draws.length, order: L.order, opacity: L.opacity, visible: L.visible, hideFills: L.hideFills, resampling: L.resampling, fadeDuration: L.fadeDur, fading: L.draws.some(d => d.at || d.until) });
		}
		return out;
	}
	function destroy(): void {
		for (const id of [...layers.keys()]) remove(id);
		for (const m of meshes.values()) renderer.rasterFree(m.h);
		meshes.clear(); meshBytes = 0;
	}
	return { add, remove, set, update, stats, pending, destroy, bytes: () => texBytes + meshBytes, has: id => layers.has(id), list: () => [...layers.keys()] };   // pending＝未着の申告（rasterPending と同じ形・検定と計器）
}
