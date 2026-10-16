// ガジェット：点群（COPC＝Cloud Optimized Point Cloud・.copc.laz）を範囲読みで直に流す（#178・maplibre-gl-lidar 相当・変換無し・サーバー無し）。
//   map.addPointCloud(url | File, opts) / ?copc=<URL> / .las・.laz のドロップ。
//   普通の LAS/LAZ（COPC でない・点群計画 段 3-3）は worker が丸ごと読んでその場で八分木を作る＝ここから見ると節の並びは COPC と同じ（info.inMemory）。
//   選び＝節の点の間隔を今の距離で画面の px に直し、density（既定 2px・LOW_MEM 3px）より粗ければ子へ降りる。COPC の節は足し算（ADD）＝親も子も描く。
//   読み＝worker（copc-worker.js・copc 役）が節だけを HTTP Range で取り、LAZ をプラグイン（"#pointcloud-formats"＝@ortho-earth/tile-formats/pointcloud の laz-perf）で解き、原点相対の点にして返す。階層の頁は要る時に読む。
//   描き＝copc-gl.js（同一フレームのオーバーレイ・奥行きで隠れる・距離で縮む・色の切り替え）＝3D Tiles の点（points-gl）とは別（本人裁定）。
//   予算＝点の数（既定 600 万・LOW_MEM 200 万）＝超えたら今出していない節から古い順に捨てる。読みは同時に 4 つまで（LOW_MEM 2）。
//   高さ＝楕円体高なら節の中心の EGM96 の N（@ortho-earth/core の geoid）を引いて標高へ（この地図の標高はジオイド基準）。heightOffset[m] で合わせられる。
import { cameraState, loadGeoid, geoidHeight } from "@ortho-earth/core";
import copcGlUrl from "./copc-gl.js?url";
import type { CameraPose } from "@ortho-earth/core/camera";
import type { COPCHandle, COPCOptions, OverlayHandle } from "../../globe.d.ts";
import type { Requester } from "../request.d.ts";
import type { GlobeMap } from "../types/map.ts";

/** worker（copc 役）の open が返す見出し＝公開の COPCHandle.info */
type COPCInfo = COPCHandle["info"];
/** 八分木の節（worker の答え）＋選びの状態。key＝[d, x, y, z]・c／r＝β 単位球の外接球・ll＝中心の経緯度 */
interface NodeMsg { key: number[]; offset: number; byteSize: number; pointCount: number; c: number[]; r: number; spacingM: number; ll: number[] }
interface PcNode extends NodeMsg { state: "none" | "loading" | "ready" | "failed"; used: number; on: boolean; q?: string; points?: number }
/** 階層の頁（要る時に読む） */
interface PageMsg { key: number[]; offset: number; byteSize: number }
interface PcPage extends PageMsg { state: "none" | "loading" | "ready" | "failed" }
/** 計測（点群計画 段 0）＝読んだ量・worker の時間の合計・最初の節が出るまで＝手綱の stats に公開の分と一緒に出る */
interface COPCMetrics { affine: number; bytes: number; ms: { read: number; decode: number; proj: number }; firstAt: number; t0: number }
type SetStats = Omit<COPCHandle["stats"], "inflight" | "budget"> & COPCMetrics;
/** 1 つの点群（opts＝既定を補った物） */
interface PcSet {
	id: string; opts: COPCOptions & { density: number; heightOffset: number; color: NonNullable<COPCOptions["color"]>; pointSize: number; attenuation: boolean; depth: boolean; fit: boolean };
	nodes: Map<string, PcNode>; pages: Map<string, PcPage>; ov: OverlayHandle | null; info: COPCInfo | null; hidden: boolean; stats: SetStats;
}
/** createCOPC の手綱（公開の COPCHandle＋計測の stats） */
type COPCSetHandle = COPCHandle & { readonly stats: COPCHandle["stats"] & COPCMetrics };
/** createCOPC の deps（globe.js の copcGet が渡す） */
export interface COPCEnv {
	cam: CameraPose; size: () => { w: number; h: number }; dpr: number; lowMem: boolean; signal?: AbortSignal; requester: Requester; ell: boolean; earthM: number;
	/** 出典の欄（html＝null で外す） */
	setAttr?: (id: string, html: string | null) => void;
}

// mvp（列優先）から視錐台の 6 面（tiles3d と同じ）
function planesOf(m: ArrayLike<number>) {
	const row = (i: number) => [m[i], m[4 + i], m[8 + i], m[12 + i]];
	const r0 = row(0), r1 = row(1), r2 = row(2), r3 = row(3), out: number[][] = [];
	for (const [a, sg] of [[r0, 1], [r0, -1], [r1, 1], [r1, -1], [r2, 1], [r2, -1]] as Array<[number[], number]>) {
		const p = [r3[0] + sg * a[0], r3[1] + sg * a[1], r3[2] + sg * a[2], r3[3] + sg * a[3]], l = Math.hypot(p[0], p[1], p[2]) || 1;
		out.push([p[0] / l, p[1] / l, p[2] / l, p[3] / l]);
	}
	return out;
}
const keyStr = (k: number[]) => k.join("-");

export function createCOPC(map: GlobeMap, { cam, size, dpr, lowMem, signal, requester, ell, earthM, setAttr = () => {} }: COPCEnv) {
	const w = new Worker(new URL("../worker.ts", import.meta.url), { type: "module", name: "copc" });
	const pending = new Map<string | number, { res: (d: unknown) => void; rej: (e: Error) => void }>(); let rid = 0;
	w.onmessage = e => { const d = e.data || {}; const p = pending.get(d.rid ?? `o${d.id}`); if (!p) return; pending.delete(d.rid ?? `o${d.id}`); d.type === "error" ? p.rej(new Error(d.error)) : p.res(d); };
	const rpc = <T>(msg: Record<string, unknown>, key: string | number, transfer: Transferable[] = []) => new Promise<T>((res, rej) => { pending.set(key, { res, rej } as { res: (d: unknown) => void; rej: (e: Error) => void }); w.postMessage({ ...msg, ell }, transfer); });
	const BUDGET = lowMem ? 2e6 : 6e6, MAX_INFLIGHT = lowMem ? 2 : 4;
	const sets = new Map<string, PcSet>();
	let seq = 0, inflight = 0, loadedPts = 0, raf = 0, frameNo = 0;
	const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; update(); }); };

	async function add(src: string | File | Blob, opts: COPCOptions = {}): Promise<COPCSetHandle> {
		const id = opts.id || `copc${++seq}`;
		if (sets.has(id)) remove(id);
		const set: PcSet = { id, opts: { density: lowMem ? 3 : 2, heightOffset: 0, color: "auto", pointSize: 2, attenuation: true, depth: true, fit: true, ...opts }, nodes: new Map(), pages: new Map(), ov: null, info: null, hidden: false,
			stats: { nodes: 0, shown: 0, points: 0, shownPoints: 0, failed: 0, requests: 0, affine: 0, bytes: 0, ms: { read: 0, decode: 0, proj: 0 }, firstAt: 0, t0: performance.now() } };   // bytes・ms・firstAt＝計測（点群計画 段 0）：読んだ量・worker の時間の合計・最初の節が出るまで
		sets.set(id, set);
		let url = src, headers: Record<string, string> | undefined;
		if (typeof src === "string") { const r = requester.resolve(new URL(src, location.href).href, "Source"); url = r.url; headers = r.headers; }   // transformRequest＝鍵・独自スキームは未対応（Range を読むため）
		const opened = await rpc<{ info: COPCInfo; root: { nodes: NodeMsg[]; pages: PageMsg[] } }>({ type: "open", id, src: url, headers, crs: set.opts.crs, vertical: set.opts.vertical }, `o${id}`);
		if (!sets.has(id)) throw new Error("removed while opening");
		set.info = opened.info;
		if (set.info.inMemory) { set.stats.requests = 1; set.stats.bytes = set.info.size; }   // 丸ごと読み（段 3-3）＝取ったのは open の 1 回だけ・節は手元から
		if (set.info.vertical === "ellipsoidal") await loadGeoid().catch(() => {});
		for (const n of opened.root.nodes) addNode(set, n);
		for (const p of opened.root.pages) set.pages.set(keyStr(p.key), { ...p, state: "none" });
		const host = typeof src === "string" ? (() => { try { return new URL(src, location.href).host; } catch { return null; } })() : null;
		setAttr(id, set.opts.attribution || (host && host !== location.host ? host : null));   // 出典＝opts.attribution・無ければ他所の URL のホスト名（手元のファイル・同じオリジンは出さない）
		set.ov = map.overlay(copcGlUrl, { name: `copc:${id}`, opts: { depth: set.opts.depth !== false } });
		applyStyle(set);
		if (set.opts.fit !== false) map.fitBounds(set.info.bbox, { padding: 40, maxZoom: 18 });
		schedule();
		return handle(set);
	}
	function addNode(set: PcSet, n: NodeMsg) { set.nodes.set(keyStr(n.key), { ...n, state: "none", used: 0, on: false }); }
	function applyStyle(set: PcSet) {
		const o = set.opts, info = set.info!;
		const mode = o.color === "auto" ? (info.hasRgb ? "rgb" : "elevation") : o.color;
		set.ov?.post({ type: "style", mode, size: o.pointSize, attenuation: o.attenuation !== false, elevRange: o.elevationRange || info.zRange.map(v => v - (info.vertical === "ellipsoidal" ? geoidHeight(info.center[0], info.center[1]) || 0 : 0) + (o.heightOffset || 0)),
			intensityRange: o.intensityRange || [0, 65535], opacity: o.opacity ?? 1 });
	}
	const childrenOf = ([d, x, y, z]: number[]) => { const out: number[][] = []; for (let i = 0; i < 8; i++) out.push([d + 1, 2 * x + (i & 1), 2 * y + ((i >> 1) & 1), 2 * z + ((i >> 2) & 1)]); return out; };

	function loadPage(set: PcSet, p: PcPage) {
		p.state = "loading"; set.stats.requests++; set.stats.bytes += p.byteSize;
		rpc<{ nodes: NodeMsg[]; pages: PageMsg[] }>({ type: "page", id: set.id, rid: ++rid, page: { offset: p.offset, byteSize: p.byteSize } }, rid).then(r => {
			p.state = "ready"; for (const n of r.nodes) addNode(set, n); for (const q of r.pages) if (!set.pages.has(keyStr(q.key))) set.pages.set(keyStr(q.key), { ...q, state: "none" });
			schedule();
		}).catch(err => { p.state = "failed"; console.warn(`[copc] ${set.id}: hierarchy page`, err); });
	}
	function loadNode(set: PcSet, n: PcNode) {
		n.state = "loading"; inflight++; if (!set.info!.inMemory) { set.stats.requests++; set.stats.bytes += n.byteSize; }
		const N = set.info!.vertical === "ellipsoidal" ? geoidHeight(n.ll[0], n.ll[1]) || 0 : 0;
		const q = ++rid;
		rpc<{ n: number; pos: Float32Array; origin: number[]; rgb?: Uint8Array | null; intensity: Uint16Array; cls: Uint8Array; elev: Float32Array; affine?: boolean; ms?: Partial<COPCMetrics["ms"]> }>({ type: "node", id: set.id, rid: q, node: { key: n.key, offset: n.offset, byteSize: n.byteSize, pointCount: n.pointCount }, N, heightOffset: set.opts.heightOffset || 0 }, q).then(r => {
			inflight--;
			if (!sets.has(set.id) || set.nodes.get(keyStr(n.key)) !== n) return;
			n.state = "ready"; n.q = keyStr(n.key); n.points = r.n; loadedPts += r.n; set.stats.nodes++; set.stats.points += r.n;
			const st = set.stats; if (r.affine) st.affine++; if (r.ms) for (const k in st.ms) st.ms[k as keyof COPCMetrics["ms"]] += r.ms[k as keyof COPCMetrics["ms"]] || 0; if (!st.firstAt) st.firstAt = performance.now() - st.t0;
			set.ov!.post({ type: "layer", q: n.q, n: r.n, pos: r.pos, origin: r.origin, rgb: r.rgb, intensity: r.intensity, cls: r.cls, elev: r.elev, spacing: n.spacingM / earthM }, [r.pos.buffer, r.elev.buffer, r.intensity.buffer, r.cls.buffer, ...(r.rgb ? [r.rgb.buffer] : [])]);
			n.on = true;
			schedule();
		}).catch(err => { inflight--; n.state = "failed"; set.stats.failed++; console.warn(`[copc] ${set.id}: node ${keyStr(n.key)}`, err); schedule(); });
	}
	function unload(set: PcSet, n: PcNode) { if (n.state !== "ready") return; set.ov!.post({ type: "remove", q: n.q }); loadedPts -= n.points!; set.stats.nodes--; set.stats.points -= n.points!; n.state = "none"; n.on = false; }
	function setOn(set: PcSet, n: PcNode, on: boolean) { if (n.on === on) return; n.on = on; set.ov!.post({ type: "vis", q: n.q, on }); }

	function update() {
		if (!sets.size) return;
		frameNo++;
		const W = size().w, H = size().h, s = cameraState(cam, W, H), planes = planesOf(s.mvp), eye = s.eye, fpx = s.focal / (cam.dpr || dpr || 1), el = Math.hypot(...eye);
		const want: Array<{ set: PcSet; n: PcNode; pri: number }> = [];
		for (const set of sets.values()) {
			if (!set.info || set.hidden) continue;
			const visible = (n: PcNode) => {
				const c = n.c, r = n.r;
				for (const p of planes) if (p[0] * c[0] + p[1] * c[1] + p[2] * c[2] + p[3] < -r) return 0;
				if (el > 1 && (c[0] * eye[0] + c[1] * eye[1] + c[2] * eye[2]) / el + r < 1 / el) return 0;   // 地平線の向こう
				return Math.max(1e-9, Math.hypot(c[0] - eye[0], c[1] - eye[1], c[2] - eye[2]) - r) * earthM;
			};
			// 優先度（点の間隔の画面 px が大きい＝粗くて目立つ）の順に、予算の点の数まで選ぶ
			const show = new Set<PcNode>(), queue: Array<{ n: PcNode; px: number }> = [], root = set.nodes.get("0-0-0-0");
			let budget = BUDGET / Math.max(1, sets.size);
			const push = (n: PcNode) => { const dist = visible(n); if (!dist) return; queue.push({ n, px: n.spacingM * fpx / dist }); };
			if (root) push(root);
			while (queue.length) {
				queue.sort((a, b) => b.px - a.px);
				const { n, px } = queue.shift()!;
				if (budget < n.pointCount) break;
				n.used = frameNo; budget -= n.pointCount;
				if (n.state === "ready") show.add(n); else if (n.state === "none") want.push({ set, n, pri: px });
				if (px <= set.opts.density) continue;   // この節で十分に細かい
				for (const ck of childrenOf(n.key)) {
					const k = keyStr(ck), c = set.nodes.get(k);
					if (c) push(c);
					else { const p = set.pages.get(k); if (p && p.state === "none") loadPage(set, p); }
				}
			}
			let shownPts = 0;
			for (const n of set.nodes.values()) if (n.state === "ready") { const on = show.has(n); setOn(set, n, on); if (on) shownPts += n.points!; }
			set.stats.shown = show.size; set.stats.shownPoints = shownPts;
		}
		want.sort((a, b) => b.pri - a.pri);
		for (const { set, n } of want) { if (inflight >= MAX_INFLIGHT) break; loadNode(set, n); }
		if (loadedPts > BUDGET * 1.2) {   // 予算＝今出していない節から古い順に
			const cand = [...sets.values()].flatMap(st => [...st.nodes.values()].filter(n => n.state === "ready" && !n.on).map(n => ({ st, n }))).sort((a, b) => a.n.used - b.n.used);
			for (const { st, n } of cand) { if (loadedPts <= BUDGET) break; unload(st, n); }
		}
	}
	function handle(set: PcSet): COPCSetHandle {
		return {
			id: set.id, info: set.info!,
			get stats() { return { ...set.stats, ms: { ...set.stats.ms }, inflight, budget: BUDGET }; },
			get bbox() { return set.info!.bbox; },
			setOptions(o = {}) { Object.assign(set.opts, o); applyStyle(set); if (o.density != null) schedule(); return this; },
			setVisible(v: boolean) { set.hidden = !v; if (!v) for (const n of set.nodes.values()) if (n.state === "ready") setOn(set, n, false); schedule(); return this; },   // 出す時は次の選びが節を戻す
			remove: () => remove(set.id),
		};
	}
	function remove(id: string) {
		const set = sets.get(id); if (!set) return false;
		sets.delete(id);
		setAttr(id, null);
		for (const n of set.nodes.values()) if (n.state === "ready") loadedPts -= n.points!;
		set.ov?.remove();
		w.postMessage({ type: "close", id });
		return true;
	}
	const onMove = () => schedule();
	map.on("move", onMove); map.on("settle", onMove);
	const destroy = () => { for (const id of [...sets.keys()]) remove(id); w.terminate(); map.off?.("move", onMove); map.off?.("settle", onMove); cancelAnimationFrame(raf); };
	signal?.addEventListener("abort", destroy, { once: true });
	return { add, remove, list: () => [...sets.values()].map(handle), destroy };
}
