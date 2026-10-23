// 日影（map.sunShadow）・影（map.setShadows）・切断（map.setClipping）・可視域と見通し線（map.viewshed／lineOfSight）・
// 時計／撮影／QR／ホーム／印刷／閉じる等の gadget・POI 編集＝createGlobe から切り出した（globe.js の分割 ⑧・2026-10-15）。中身は切り出す前と同じ。
//   live＝createGlobe の変数（let・この呼び出しより後で宣言される定数）を読み書きする口（getter／setter）。その他＝createGlobe の中の定数・関数（中身は createGlobe と共有）
import { clipDistanceM, clipPlanesFor, normClip } from "@ortho-earth/core/clip";
import { clockGadget } from "../gadgets/clock.ts";
import { close as closeGadget } from "../gadgets/close.ts";
import { createTileLoader } from "@ortho-earth/core/elevation";
import { home as homeGadget } from "../gadgets/home.ts";
import { offline as offlineGadget } from "../gadgets/offline.ts";
import { print as printGadget } from "../gadgets/print-stub.ts";
import { qr as qrGadget } from "../gadgets/qr-stub.ts";
import { shot as shotGadget } from "../gadgets/shot-stub.ts";
import { sunShadow as sunShadowGadget } from "../gadgets/sunshadow.ts";
import { viewshed as viewshedGadget } from "../gadgets/viewshed.ts";
import { sunTimes, sunsOf, sunGrid } from "../sunshadow-core.ts";   // 日影時間の GPU 版（2026-10-24）＝時刻の列と升目は CPU 版と同じ式
import type { ClipPlane } from "@ortho-earth/core/clip";
import type { TileLoader } from "@ortho-earth/core/elevation";
import type { Bbox, GeoJSONFeature, GeoJSONFeatureCollection, LonLat } from "../../globe.d.ts";
import type { Installing, ShadowsDeps, ShadowsLive, ShadowsReturn } from "../types/install.ts";
import type { ShadowsApi } from "../types/map.ts";
import type { OfflineSources } from "../gadgets/offline.ts";

type SunStats = Omit<Awaited<ReturnType<ShadowsApi["sunShadow"]>>, "probes">;
type VisStats = Omit<Awaited<ReturnType<ShadowsApi["viewshed"]>>, "probes">;
/** model worker の答え（日影・可視域＝四隅で貼る画像と統計） */
interface SunReply<S> { rgba: Uint8Array<ArrayBuffer>; w: number; h: number; bbox: Bbox; stats: S; probes: number[] }
type VisReply = SunReply<VisStats> & { los: Omit<Awaited<ReturnType<ShadowsApi["lineOfSight"]>>, "triangles"> };
type SunWait = { res: (d: unknown) => void; rej: (e: Error) => void };
type VisOpts = { eyeH?: number; targetH?: number; buildings?: boolean; tilesets?: string[]; cell?: number; gpu?: boolean };
/** 解析（GPU 版）の答え＝CPU 版の SunReply と同じ形（stats は種類ごと） */
type AnaReply<S> = { rgba: Uint8Array<ArrayBuffer> | Uint8ClampedArray<ArrayBuffer>; w: number; h: number; bbox: Bbox; probes: number[]; stats: S };
/** 画像タイルの一覧の spec（XYZ の URL の物だけ読む） */
type RasterRow = { id: string; spec: { url?: string; minZoom?: number; minzoom?: number; maxZoom?: number; maxzoom?: number; subdomains?: string[] | string; tms?: boolean } };
/** 入れ子の座標（clipAllCut が数える） */
type Coords = readonly unknown[];

export function installShadows(map: Installing<ShadowsApi>, live: ShadowsLive, {
	BASE_SOURCE, D2R, LOW_MEM, REGION_DTM, REGION_HOME, REGION_PRINT_ATTR, TILE_MINZOOM, ac, approxViewBbox, attrTextNow, cam, dbgHost, makeProjector,
	mapOn, meshMgr, meshOn, onMove, ownDestroy, poi, printCapture, renderer, requestDraw, requestSnapshot, setLayer, t, toolClose, toolOpen, unprojectXY,
	registerGadget, viewHash, wPost, wakeMesh
}: ShadowsDeps): ShadowsReturn {
	// ── 日影（#44・2026-09-23）＝建物の影を地面に描く。map.sunShadow({ mode:"duration"|"instant", date, planeH, hours, step, bbox, tilesets, probe:[[lon,lat]…] })
	//   建物＝既定は地域の建物台帳（日本＝PLATEAU）・tilesets で任意の 3D Tiles。範囲＝既定は画面に見えている所（中心から一辺 3km まで）。
	//   結果＝四隅の画像として地面に貼る（map.raster の "sunshadow"）。戻り＝stats（三角形数・最大の日影時間ほか）
	let sunWorker: Worker | null = null, sunSeq = 0;
	const sunWaiting = new Map<number, SunWait>();
	ownDestroy.push(() => { sunWorker?.terminate(); sunWorker = null; for (const p of sunWaiting.values()) p.rej(new Error("destroyed")); sunWaiting.clear(); });
	// ── GPU 版（2026-10-24・WebGPU だけ）＝描いている物（PLATEAU・3D Tiles・模型・基図の押し出し・地形）から render worker が測る＝建物を読み直さない・その場で返る。
	//   既定＝WebGPU なら GPU 版。gpu:false か tilesets（描いていない物を名指し）で CPU 版（model worker・tileset を読む）。GL2 は CPU 版だけ
	const anaWait = new Map<number, { res: (d: unknown) => void; rej: (e: Error) => void }>(); let anaSeq = 0;
	const anaCall = <R>(type: string, payload: object) => new Promise<R>((res, rej) => { const id = ++anaSeq; anaWait.set(id, { res: res as (d: unknown) => void, rej }); wPost({ type, id, ...payload }); });
	const gpuPath = (o: { gpu?: boolean; tilesets?: string[] }) => live.renderBackend === "webgpu" && o.gpu !== false && !(o.tilesets && o.tilesets.length);
	map.sunShadow = async (o = {}) => {
		let bb = o.bbox || map.getBounds() || approxViewBbox(cam);
		const c = [cam.center[0], cam.center[1]], half = 1500 / 111320, hx = half / Math.max(0.2, Math.cos(c[1] * D2R));
		bb = [Math.max(bb[0], c[0] - hx), Math.max(bb[1], c[1] - half), Math.min(bb[2], c[0] + hx), Math.min(bb[3], c[1] + half)];   // 一辺 3km まで
		const maxCells = LOW_MEM ? 512 * 512 : 1024 * 1024;
		if (gpuPath(o)) try {   // GPU 版が立たない時（描く前・デバイス喪失）は CPU 版へ落ちる
			const mode = o.mode || "duration", step = o.step ?? 0.5;
			const { W, H, cell, lon0, lat0 } = sunGrid(bb, o.cell, maxCells);
			const { times, decl } = sunTimes({ mode, date: o.date, decl: o.decl, hours: o.hours || [8, 16], step }, lon0 / D2R);
			const suns = sunsOf(lat0 / D2R, decl, times);
			const r = await anaCall<AnaReply<{ triangles: number; steps: number; maxHours: number; texelM: number }>>("anaSun", { bbox: bb, W, H, planeH: o.planeH ?? 4, suns: suns.map(x => ({ alt: x.alt, az: x.az })), step, mode, probe: o.probe || null });
			const image = await createImageBitmap(new ImageData(new Uint8ClampedArray(r.rgba.buffer), r.w, r.h));
			const [w, s, e, n] = r.bbox;
			await map.raster.add("sunshadow", { image, corners: [[w, n], [e, n], [e, s], [w, s]], name: "sunshadow" }, { order: "over", opacity: 1, hideFills: false });
			return { ...r.stats, tiles: 0, decl: +decl.toFixed(2), planeH: o.planeH ?? 4, mode, cell: +cell.toFixed(2), probes: r.probes, gpu: true };
		} catch (err) { console.warn("[sunShadow] GPU path failed, falling back to the CPU path:", (err as Error)?.message || err); }
		sunWorker ??= (() => { const w = new Worker(new URL("../worker.ts", import.meta.url), { type: "module", name: "model" }); w.onmessage = e => { const p = sunWaiting.get(e.data.id); if (!p) return; sunWaiting.delete(e.data.id); e.data.error ? p.rej(new Error(e.data.error)) : p.res(e.data); }; return w; })();
		const opts = { mode: o.mode || "duration", date: (o.date instanceof Date ? o.date : o.date ? new Date(o.date) : new Date()).toISOString(), planeH: o.planeH ?? 4, hours: o.hours || [8, 16], step: o.step ?? 0.5, decl: o.decl, bbox: bb,
			tilesets: (o.tilesets || []).map(u => new URL(u, location.href).href), sets: o.tilesets ? [] : (meshMgr.sets || []).map(st => ({ base: st.base, bbox: st.bbox })), maxCells, cell: o.cell, probe: o.probe || null };
		const r = await new Promise<SunReply<SunStats>>((res, rej) => { const id = ++sunSeq; sunWaiting.set(id, { res: res as SunWait["res"], rej }); sunWorker!.postMessage({ id, kind: "sunshadow", opts }); });
		const image = await createImageBitmap(new ImageData(new Uint8ClampedArray(r.rgba.buffer), r.w, r.h));
		const [w, s, e, n] = r.bbox;
		await map.raster.add("sunshadow", { image, corners: [[w, n], [e, n], [e, s], [w, s]], name: "sunshadow" }, { order: "over", opacity: 1, hideFills: false });
		return { ...r.stats, probes: r.probes, gpu: false };   // probes＝指定地点の日影時間（時）／瞬間は 0|1
	};
	// ── 建物の影（リアルタイム・2026-09-24）＝描画の中で太陽から建物の深度を描き、地面・建物に落とす（WebGPU 専用。
	// GL2 はフォールバック＝影をかけない仕様（本人裁定 2026-09-24）＝GL レンダラは "shadow" を素通しする）。
	// map.setShadows(true | false | { on, time: Date|ms|ISO, darkness: 0..1 })。time 無指定＝共通の時計（view.clock）。z13 以上・太陽が出ている時だけ。
	// 消している間は描画に一切関与しない（資源も持たない）。
	map.setShadows = (o = true) => {
		const v: { on: boolean; time?: Date | number | string; darkness?: number } = typeof o === "object" && o ? { ...o, on: o.on !== false } : { on: !!o };
		if (v.time != null) v.time = v.time instanceof Date ? +v.time : typeof v.time === "string" ? Date.parse(v.time) : +v.time;
		renderer.set("shadow", v); requestDraw(); onMove();
	};
	dbgHost.__shadow = (o: Parameters<ShadowsApi["setShadows"]>[0]) => map.setShadows(o);   // 検証窓（t-shadow・実機の切り分け）
	// ── 断面とクリッピング平面（#111・2026-09-29）＝建物・地形・基図を平面で切って中を見る（Cesium の ClippingPlane 相当・WebGPU 専用）。
	// map.setClipping(false | { vertical?: [[a, b]…], horizontal?: [{ at, h, keep }…], box?: { center, size, h, bearing }, planes?, cap?, edge? })
	//   vertical＝2 点 a→b（[lon,lat]）を通る鉛直面（a→b に向かって右側を残す）・horizontal＝高さ h(m) の水平面（keep "below"＝既定／"above"）・
	//   box＝箱の内側（center・size [幅, 奥行き] m・h [底, 天] m・bearing 度）。面は全部の交わり・6 枚まで。cap:false＝蓋なし・edge:false|{ width, color }＝縁の帯。
	// 切れる物＝地形（切り口に土の色の蓋）・球の床・基図の塗りと線と押し出し建物・建物メッシュ（閉じた建物は疑似の蓋）・模型/3D Tiles/I3S・gint・外部ベクタ・注記・
	// 同一フレームのオーバーレイ（api.clip）。影は切った形で落ちる。日影図・可視域・見通し線（worker の計算）は切らない＝実物の地形と建物で測る。
	// GL2 では何もしない（影と同じ扱い・本人裁定 2026-09-29）。消している間は描画に一切関与しない。?clip=項;項…＝URL の書き方（core clip.js parseClipParam）
	const clipFor = (t: string) => live.clipByT?.[t] ?? null;
	map.setClipping = (o = false) => {
		const v = Array.isArray(o) ? (o.length ? o.map(g => ({ ...g })) : null) : o && typeof o === "object" && o.on !== false ? { ...o, on: true } : null;
		const apply = () => {
			if (v && live.renderBackend !== "webgpu") { console.warn("[clip] setClipping needs WebGPU (WebGL2 = no-op)"); return; }
			const n = normClip(v);
			live.clipSpec = n ? v : null;
			live.clipByT = n ? Object.fromEntries(["terrain", "buildings", "models", "vector", "labels"].map(t => { const a = clipPlanesFor(n, t); return [t, a.length ? a : null]; })) : null;
			live.clipMain = clipFor("vector");
			renderer.set("clip", live.clipSpec || { on: false }); requestDraw(); onMove();
		};
		if (live.mapLoaded) apply(); else mapOn.load.push(apply);   // 描画 worker のレンダラが立つ前の set は落ちる＝初描画を待つ
	};
	map.getClipping = () => live.clipSpec ? (Array.isArray(live.clipSpec) ? live.clipSpec.map(g => ({ ...g })) : { ...live.clipSpec }) : null;
	dbgHost.__clip = (o: Parameters<ShadowsApi["setClipping"]>[0]) => map.setClipping(o);   // 検証窓
	{ const q = new URLSearchParams(location.search).get("clip"); if (q) map.setClipping({ param: q }); }
	// 画素 (x, y)（CSS px）の地面（海抜 0）が切られた側か＝識別・ホバー・問い合わせで外す
	const clipCutXY = (x: number, y: number) => { if (!live.clipMain) return false; const ll = unprojectXY(x, y); return !!ll && clipDistanceM(live.clipMain, ll[0], ll[1], 0) < 0; };
	// 地物の形が全部切られた側か（座標を最大 400 点だけ見る）＝箱の問い合わせと押し出しの当たりで外す
	const clipAllCut: ShadowsReturn["clipAllCut"] = (g, hM = 0, pl = live.clipMain) => {
		if (!pl || !g) return false;
		const cs: number[][] = []; const walk = (c: Coords): void => { if (cs.length > 400) return; if (typeof c[0] === "number") cs.push(c as number[]); else for (const x of c) walk(x as Coords); };
		walk((g.type === "GeometryCollection" ? g.geometries!.map(x => x.coordinates) : g.coordinates || []) as Coords);
		return cs.length > 0 && cs.every(c => clipDistanceM(pl, c[0], c[1], hM) < 0);
	};
	// ── 可視域と見通し線（#44・2026-09-23）──────────────────────────────────────
	// map.viewshed({ observer:[lon,lat], eyeH:1.6, targetH:0, radius:1000(m), buildings:true, tilesets? , probe? })＝見える所（緑）と見えない所を地面に貼る（map.raster の "viewshed"）
	// map.lineOfSight(a, b, { eyeH, targetH, buildings })＝視点 a→目標 b。見えるか・遮る最初の点・断面（距離・地表・視線）。線を地図に引く（見える区間＝緑・遮られた先＝赤）
	// 地表＝render worker の地形のセル（外来 DEM の上書き込み）を升目で・建物＝地域の建物台帳（PLATEAU）か任意の 3D Tiles（日影と同じ読み方）
	const elevGridWait = new Map<number, (grid: unknown) => void>(); let elevGridSeq = 0;
	const elevGrid = (bbox: Bbox, N: number) => new Promise(res => { const id = ++elevGridSeq; elevGridWait.set(id, res); wPost({ type: "elevGrid", id, bbox, N }); });
	const sunCall = <R>(kind: string, opts: object) => new Promise<R>((res, rej) => {
		sunWorker ??= (() => { const w = new Worker(new URL("../worker.ts", import.meta.url), { type: "module", name: "model" }); w.onmessage = e => { const p = sunWaiting.get(e.data.id); if (!p) return; sunWaiting.delete(e.data.id); e.data.error ? p.rej(new Error(e.data.error)) : p.res(e.data); }; return w; })();
		const id = ++sunSeq; sunWaiting.set(id, { res: res as SunWait["res"], rej }); sunWorker.postMessage({ id, kind, opts });
	});
	const visBox = (center: LonLat, radius: number, o: VisOpts) => {   // 範囲（半径の 1.02 倍の正方形）と升目の数（CPU/GPU 共通）
		const R = Math.min(5000, Math.max(50, radius)), dLat = R * 1.02 / 111320, dLon = dLat / Math.max(0.2, Math.cos(center[1] * D2R));
		const bbox: Bbox = [center[0] - dLon, center[1] - dLat, center[0] + dLon, center[1] + dLat];
		return { R, bbox, N: Math.max(64, Math.min(LOW_MEM ? 384 : 768, Math.round(2 * R / (o.cell ?? 2)))) };
	};
	const visArea = async (center: LonLat, radius: number, extra: object, o: VisOpts) => {
		const { R, bbox, N } = visBox(center, radius, o);
		const ground = await elevGrid(bbox, N);
		return sunCall<VisReply>("viewshed", { bbox, N, ground, eyeH: o.eyeH ?? 1.6, targetH: o.targetH ?? 0, radius: R, buildings: o.buildings !== false,
			tilesets: (o.tilesets || []).map(u => new URL(u, location.href).href), sets: o.tilesets ? [] : (meshMgr.sets || []).map(st => ({ base: st.base, bbox: st.bbox })), ...extra });
	};
	map.viewshed = async (o = {}) => {
		const obs: LonLat = o.observer ?? [cam.center[0], cam.center[1]];
		let gpu = gpuPath(o) && o.buildings !== false;   // 建物なし（地形だけ）は CPU 版（地形の升目だけで済む）
		let r: AnaReply<VisStats> | null = null;
		if (gpu) {
			const { R, bbox, N } = visBox(obs, o.radius ?? 1000, o);
			r = await anaCall<AnaReply<VisStats>>("anaVis", { bbox, N, observer: obs, eyeH: o.eyeH ?? 1.6, targetH: o.targetH ?? 0, radius: R, probe: o.probe || null }).catch(err => { console.warn("[viewshed] GPU path failed, falling back to the CPU path:", (err as Error)?.message || err); gpu = false; return null; });
		}
		r ??= await visArea(obs, o.radius ?? 1000, { observer: obs, probe: o.probe || null }, o);
		const image = await createImageBitmap(new ImageData(new Uint8ClampedArray(r.rgba.buffer), r.w, r.h));
		const [w, s, e, n] = r.bbox;
		await map.raster.add("viewshed", { image, corners: [[w, n], [e, n], [e, s], [w, s]], name: "viewshed" }, { order: "over", opacity: 1, hideFills: false });
		return { ...r.stats, probes: r.probes, gpu };
	};
	map.lineOfSight = async (a, b, o = {}) => {
		const mid: LonLat = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], half = Math.hypot((b[0] - a[0]) * 111320 * Math.cos(mid[1] * D2R), (b[1] - a[1]) * 111320) / 2;
		const vo: VisOpts = { ...o, cell: o.cell ?? Math.max(1, half / 300) };
		let gpu = gpuPath(o) && o.buildings !== false;
		let extra: object = { observer: a, los: b };
		if (gpu) {   // 地表（地形＋屋根）だけ GPU で取り、断面は CPU 版の式で引く（建物を読まない）
			const { bbox, N } = visBox(mid, half + 60, vo);
			const sf = await anaCall<{ S: Float32Array; tris: number }>("anaSurf", { bbox, N }).catch(err => { console.warn("[lineOfSight] GPU path failed, falling back to the CPU path:", (err as Error)?.message || err); gpu = false; return null; });
			if (sf) extra = { observer: a, los: b, surface: sf.S, surfaceTris: sf.tris, buildings: false };
		}
		const r = await visArea(mid, half + 60, extra, vo);
		const L = r.los, cut = L.blockAt;
		const line = (c: string, from: LonLat, to: LonLat): GeoJSONFeature => ({ type: "Feature", properties: { c }, geometry: { type: "LineString", coordinates: [from, to] } });
		const data: GeoJSONFeatureCollection = { type: "FeatureCollection", features: cut ? [line("ok", a, cut), line("ng", cut, b)] : [line("ok", a, b)] };
		if (map.getSource("los")) await map.getSource("los")!.setData(data);
		else { live.addSourceAt("los", { type: "geojson", data }, 0); await live.addLayerAt({ id: "los", type: "line", source: "los", paint: { "line-color": ["match", ["get", "c"], "ok", "#1faa55", "#d23c3c"], "line-width": 4 } }, undefined, 0); }   // 内部の層＝エンジンの目盛り（dz 0）を明示
		return { ...L, triangles: r.stats.triangles, gpu };
	};
	// オフラインパック（#40）：地域の申告（基図・標高・建物・ラスタ）を読んだ結果だけを渡す＝gadget は地域を知らない。
	// 標高は core のローダ（IDB GIS/alt）を要る時に一度だけ作る。建物は meshMgr（起こしてから台帳を読む）
	let offlineDem: TileLoader | null = null;
	registerGadget("offline", (m, opts) => {
		const sources: OfflineSources = {
			// XYZ の基図だけ（PMTiles・基図なしは tileUrl が型紙にならない＝gadget は載らない）
			basemap: typeof BASE_SOURCE.tileUrl === "function" && /^https?:/.test(String(BASE_SOURCE.tileUrl(1, 0, 0) ?? "")) ? { tileUrl: BASE_SOURCE.tileUrl, coverage: BASE_SOURCE.coverage, minZ: Math.max(4, Math.floor(TILE_MINZOOM)) } : null,
			dem: live.noTerr || live.EXT ? null : { byName: async n => (offlineDem ??= await createTileLoader({ apiUrl: "https://api.ortho-earth.com", dtm: REGION_DTM })).byName(n) },
			rasters: { list: () => (map.raster.list() as RasterRow[]).filter(r => r.spec?.url && /\{z\}/.test(r.spec.url)).map(r => ({ id: r.id, url: r.spec.url, minZoom: r.spec.minZoom ?? r.spec.minzoom ?? 0, maxZoom: r.spec.maxZoom ?? r.spec.maxzoom ?? 22, subdomains: r.spec.subdomains || null, tms: !!r.spec.tms })) },
			mesh: meshOn ? { warm: () => wakeMesh(), sets: () => meshMgr.sets, prefetch: (names, onProg) => meshMgr.prefetch([], names, onProg) } : null,
		};
		const h = offlineGadget.call(m, { sources, bounds: () => map.getBounds(), onOpen: () => toolOpen("offline"), signal: ac.signal, ...opts });
		if (h?.close) toolClose.set("offline", h.close);
		return h;
	});
	registerGadget("sunshadow", (m, opts) => {
		const h = sunShadowGadget.call(m, { run: o => map.sunShadow(o), clear: () => map.raster.remove("sunshadow"), live: o => map.setShadows(o), canLive: () => live.renderBackend === "webgpu", onOpen: () => toolOpen("sunshadow"), signal: ac.signal, ...opts });
		if (h?.close) toolClose.set("sunshadow", h.close);
		return h;
	});
	map.clearViewshed = async () => { map.raster.remove("viewshed"); if (map.getLayer("los")) { map.removeLayer("los"); map.removeSource("los"); } };
	registerGadget("clock", (m, opts) => { return clockGadget.call(m, { signal: ac.signal, ...opts }); });
	registerGadget("viewshed", (m, opts) => {
		const h = viewshedGadget.call(m, { run: { viewshed: o => map.viewshed(o), lineOfSight: (a, b, o) => map.lineOfSight(a, b, o), clear: () => map.clearViewshed() }, onOpen: () => toolOpen("viewshed"), signal: ac.signal, ...opts });
		if (h?.close) toolClose.set("viewshed", h.close);
		return h;
	});
	registerGadget("shot", (m, opts) => {   // 画面保存 … worker越しの3層+measure層を合成する requestSnapshot を注入
		return shotGadget.call(m, { requestSnapshot, attribution: attrTextNow, signal: ac.signal, ...opts });   // attribution＝#attr の無い画面で焼く出典（今の圏）
	});
	registerGadget("qr", (m, opts) => {   // 共有QR … 現在の共有URL(origin+path+search+viewHash＝今の視点)を注入＝スクリーン投影→スキャンでその視点を開く＝拡散
		// location.search を挟む＝アドレスバーの ?hud=1 等のフラグもQRに載る（スキャン先で同じ計器/条件が点く）。順は path→?query→#hash＝URLの正順。
		return qrGadget.call(m, { getUrl: () => location.origin + location.pathname + location.search + viewHash(), signal: ac.signal, ...opts });
	});
	registerGadget("home", (m, opts) => {   // 地域の全体へ戻る（真俯瞰・北向き）… 着地点は地域宣言の home（日本＝列島ビュー）・J キー
		if (!REGION_HOME) return null;   // 戻り先を宣言しない地域（/nl/・地球儀）＝ボタンを出さない
		return homeGadget.call(m, { view: REGION_HOME.view, icon: REGION_HOME.icon, label: REGION_HOME.label, id: REGION_HOME.id, signal: ac.signal, ...opts });
	});
	registerGadget("print", (m, opts) => {   // 印刷（平面図）… 撮影ハイジャック printCapture を注入。プレビュー→印刷/PDF。本体は初回起動時import()
		return printGadget.call(m, { capture: printCapture, attribution: () => REGION_PRINT_ATTR.length ? REGION_PRINT_ATTR.map(k => t(k)) : attrTextNow(), signal: ac.signal, ...opts });
	});
	registerGadget("close", (m, opts) => {   // 閉じる×（埋め込み用）… ortho:close を飛ばすだけ＝閉じる実務は埋め込み側
		return closeGadget.call(m, { signal: ac.signal, ...opts });
	});
	// POI台帳の手差分編集（§12）＝?poiedit=1 のときだけ本体を import して搭載＝一般ビルドの死荷重ゼロ（作者用・
	// 書込は bucket API key 保持者のみ）。注入＝抽象アクセス：台帳フィード getPOI（パッチ適用済＝表示と同じ景色から
	// 対象を選ぶ）・手差分の読み書き getOvr/setOvr（保存成功→差し替え→poiVer++＝ラベルのみ再構築で即反映）・座標ブリッジ。
	if (poi && /[?&]poiedit=1/.test(location.search)) poi.ready().then(() => import("../gadgets/poiedit.ts")).then(({ poiedit }) => {
		setLayer("facility", true);   // 編集の舞台＝施設層を正規経路で自動点灯（チップ不在の埋め込みでも効く）
		registerGadget("poiedit", (m, opts) => {
			const L = live.poiReal!;   // ?poiedit=1 は下で poi.ready() を待ってから搭載＝ここでは必ず本物
			return poiedit.call(m, {
				// クリックは createInput の onClick 横取り（measure と同型）＝ドラッグ弁別は input.js が正本・
				// armed中の選択クリックが識別/星座へ素通りしない。座標は unprojectXY/makeProjector と同じ canvas CSS系。
				setClick: fn => { live.poiClick = fn; }, unprojectXY, makeProjector, distM: L.distM,
				apiBase: L.apiBase, name: L.ovrName,
				getPOI: () => L.patchedAll(), getOvr: L.getOvr,
				setOvr: L.setOvr,
				signal: ac.signal, ...opts,
			});
		});
		map.gadget.poiedit!();
	}).catch(e => console.error("[poiedit] load failed", e));
	return { elevGridWait, anaWait, clipFor, clipCutXY, clipAllCut };
}
