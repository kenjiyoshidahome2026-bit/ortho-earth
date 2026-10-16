// CZML・GPX の時刻付きの位置を共通の時計で描く（#113 段 3・2026-09-29）＝render worker の組み込みオーバーレイ（renderworker.js の BUILTIN_OVERLAYS）。
// 地球・注記と同じフレーム・同じ cam で canvas2D に描く。main（gadgets/czml.js・段 4）は読み込み・軌跡の組み立て（czml-time.js の trackOf/styleOf）を持ち、
// ここへは { type:"tracks", tracks:[{ id, name, t, p, degree, inertial, avail, style }] }（t/p は transfer）を渡すだけ。
// 描く物＝path（尾・lead/trail/resolution）→ 点 / billboard（画像・data URI と http(s)＝取れなければ点）→ label。出ている区間の外・標本の範囲の外は描かない。
// 置き方＝衛星（apps/ortho-globe/sats.js）と同じ：球＝測地の緯度・経度・高さ（単位球の地表点×(1＋h/R)）・楕円体＝ECEF を a で割り y を b/a で割る（β ワールド）。
// 隠れ＝視線（eye→点）が地球（単位球）を通るか＝地平線の向こうでも高い衛星は地球の縁の外に見える（api.projectH の表裏は高さを見ない＝使わない）。
// 断面（#111）で切られた側も描かない。時計が動いている間（実時間を含む）は描き続ける（frame が true）。
// 契約（map.overlay）：init(canvas, opts, host) / message(data) / frame(cam, camState, size, api) / destroy()
// 当たり判定（統一 picking・deck.gl 差分 PR-1・2026-10-11）：pick(x, y, r, ctx)＝最後に描いたフレームの点・画像・札の位置（device px）から半径 r の中で一番近い軌跡
//   ＝{ id, distance, lngLat, properties:{ id, name, description } }｜null。描いた物だけ当たる（出ていない区間・地球の陰は描いていない＝当たらない）。
import { positionAt, availableAt, pathTimes, numberAt, boolAt, ecefToLlh } from "../czml-time.ts";
import { ellipsoidOn, worldRadiusM } from "@ortho-earth/core/camera";
import type { CameraPose, CameraState } from "@ortho-earth/core/camera";
import type { LonLat, OverlayFrameApi } from "../../globe.d.ts";
import type { CzmlStyle, CzmlTrack } from "../czml-time.ts";

/** render worker の host（init の第 3 引数）＝読む分 */
interface OverlayHost { post(data: unknown): void; requestDraw(): void }
/** frame の api（断面＝clip は render worker が足す・#111） */
type FrameApi = OverlayFrameApi & { clip?: { distM(lon: number, lat: number, hM?: number): number } | null };
/** main（czml.ts）から来る軌跡（style つき・description は main に残る） */
type DrawTrack = CzmlTrack & { style?: CzmlStyle };
/** 最後に描いた印（device px・r＝当たり半径） */
interface Mark { x: number; y: number; r: number; tr: DrawTrack }
/** main からの指示＋検定の probe */
type CzmlDrawMsg = { type: "probe"; id?: unknown } | { type: "tracks"; tracks?: DrawTrack[] } | { type: "clear" };

const D2R = Math.PI / 180, MIN_EARTH_PX = 14;   // 地球の見かけの半径（CSS px）がこれ未満＝太陽系圏の奥＝描かない（衛星と同じ）
const FONT = '"Noto Sans",system-ui,sans-serif';   // 地域の書体は名指ししない（regionless）＝各言語の文字は OS の書体が受ける
let canvas: OffscreenCanvas | null = null, ctx: OffscreenCanvasRenderingContext2D | null = null, host: OverlayHost | null = null, tracks: DrawTrack[] = [];
let marks2: Mark[] = [];   // 最後に描いた印＝[{ x, y, r（当たり半径・device px）, tr }]（pick が読む）
const images = new Map<string, ImageBitmap | "loading" | "bad">();   // src → ImageBitmap | "loading" | "bad"

const imageOf = (src: string) => {
	const im = images.get(src);
	if (im) return im instanceof ImageBitmap ? im : null;
	if (!/^(data:|https?:)/.test(src)) { images.set(src, "bad"); return null; }
	images.set(src, "loading");
	fetch(src, { credentials: "omit" }).then(r => r.ok ? r.blob() : Promise.reject(new Error(r.status as unknown as string))).then(b => createImageBitmap(b))
		.then(bm => { images.set(src, bm); host?.requestDraw(); }, () => { images.set(src, "bad"); host?.requestDraw(); });   // CORS で取れない等＝点で描く（本人裁定）
	return null;
};

export function init(cv: OffscreenCanvas, opts: unknown, h: OverlayHost) { canvas = cv; host = h; ctx = canvas.getContext("2d"); }
export function message(d: CzmlDrawMsg | null | undefined) {
	if (d?.type === "probe") {   // 検定用＝今の画素を main へ（dbgHost.__ovPixels）
		try { const im = ctx!.getImageData(0, 0, canvas!.width, canvas!.height); host?.post({ type: "pixels", id: d.id, w: im.width, h: im.height, data: im.data }); }
		catch (e) { host?.post({ type: "pixels", id: d.id, error: String((e as Error)?.message || e) }); }
		return;
	}
	if (d?.type === "tracks") tracks = d.tracks || [];
	else if (d?.type === "clear") tracks = [];
	host?.requestDraw();
}
export function destroy() { tracks = []; for (const v of images.values()) if (v instanceof ImageBitmap) v.close(); images.clear(); }

export function frame(cam: CameraPose, s: CameraState, { w, h }: { w: number; h: number }, api: FrameApi) {
	ctx!.clearRect(0, 0, w, h);
	if (!tracks.length) return false;
	const E = s.eye, m = s.mvp, dpr = api.dpr || 1;
	if (s.focal / Math.sqrt(Math.max(E[0] * E[0] + E[1] * E[1] + E[2] * E[2] - 1, 1e-12)) / dpr < MIN_EARTH_PX) return api.clock?.rate !== 0;
	const ell = ellipsoidOn(), R = worldRadiusM(), rAx = api.rAx || 1, ms = api.time;
	// ECEF（m）→ 画面（device px）｜null（地球の陰・カメラの後ろ・断面で切られた側）
	const toScreen = (q: ArrayLike<number>): [number, number] | null => {
		let x: number, y: number, z: number, llh: [number, number, number] | null = null;
		if (ell) { x = q[0] / R; y = q[2] / (R * rAx); z = q[1] / R; }
		else { llh = ecefToLlh(q[0], q[1], q[2]); const a = llh[0] * D2R, b = llh[1] * D2R, k = 1 + llh[2] / R, cb = Math.cos(b); x = cb * Math.cos(a) * k; y = Math.sin(b) * k; z = cb * Math.sin(a) * k; }
		const ww = m[3] * x + m[7] * y + m[11] * z + m[15];
		if (ww <= 1e-6) return null;
		const dx = x - E[0], dy = y - E[1], dz = z - E[2], dd = dx * dx + dy * dy + dz * dz, tt = -(E[0] * dx + E[1] * dy + E[2] * dz) / dd;
		if (tt > 0 && tt < 1) { const px = E[0] + dx * tt, py = E[1] + dy * tt, pz = E[2] + dz * tt; if (px * px + py * py + pz * pz < 1) return null; }
		if (api.clip) { llh ??= ecefToLlh(q[0], q[1], q[2]); if (api.clip.distM(llh[0], llh[1], llh[2]) < 0) return null; }
		return [((m[0] * x + m[4] * y + m[8] * z + m[12]) / ww * 0.5 + 0.5) * w, (1 - ((m[1] * x + m[5] * y + m[9] * z + m[13]) / ww * 0.5 + 0.5)) * h];
	};
	const marks: Array<[[number, number], Partial<CzmlStyle>, DrawTrack]> = [];
	marks2 = [];
	for (const tr of tracks) {
		if (!availableAt(tr, ms)) continue;
		const st: Partial<CzmlStyle> = tr.style || {};
		const ph = st.path;
		if (ph && boolAt(ph.show, ms, true)) {   // 尾（path）
			const times = pathTimes(tr, ms, { lead: numberAt(ph.lead, ms, null), trail: numberAt(ph.trail, ms, null), resolution: numberAt(ph.resolution, ms, 60) });
			ctx!.strokeStyle = ph.color; ctx!.lineWidth = ph.width * dpr; ctx!.lineJoin = "round"; ctx!.beginPath();
			let pen = false;
			for (const t of times) { const q = positionAt(tr, t), P = q && toScreen(q); if (!P) { pen = false; continue; } if (pen) ctx!.lineTo(P[0], P[1]); else ctx!.moveTo(P[0], P[1]); pen = true; }
			ctx!.stroke();
		}
		const q = positionAt(tr, ms), P = q && toScreen(q);
		if (P) marks.push([P, st, tr]);
	}
	for (const [P, st, tr] of marks) {   // 点・画像・札は尾の上に
		let hitR = 4 * dpr;   // 当たり半径＝描いた物の大きさ（画像＝短辺の半分・点＝半径・最低 4px）
		const img = st.image && boolAt(st.image.show, ms, true) ? imageOf(st.image.src) : null;
		if (img) {
			const sw = img.width * st.image!.scale * dpr, sh = img.height * st.image!.scale * dpr;
			ctx!.drawImage(img, P[0] + st.image!.offset[0] * dpr - sw / 2, P[1] + st.image!.offset[1] * dpr - sh / 2, sw, sh);
			hitR = Math.max(hitR, Math.min(sw, sh) / 2);
		} else if ((st.point && boolAt(st.point.show, ms, true)) || st.image) {   // 画像が取れない（取れる前も）＝点
			const pt = st.point || { size: 8, color: "rgba(255,255,255,1)", outline: "rgba(0,0,0,0.8)", outlineWidth: 1 };
			ctx!.beginPath(); ctx!.arc(P[0], P[1], Math.max(1, pt.size) * dpr / 2, 0, Math.PI * 2);
			ctx!.fillStyle = pt.color; ctx!.fill();
			if (pt.outline && pt.outlineWidth) { ctx!.lineWidth = pt.outlineWidth * dpr; ctx!.strokeStyle = pt.outline; ctx!.stroke(); }
			hitR = Math.max(hitR, Math.max(1, pt.size) * dpr / 2);
		}
		marks2.push({ x: P[0], y: P[1], r: hitR, tr });
		const lb = st.label;
		if (lb && boolAt(lb.show, ms, true) && lb.text) {
			ctx!.font = `${lb.px * dpr}px ${FONT}`; ctx!.textBaseline = "middle";
			ctx!.textAlign = lb.align === "left" ? "left" : lb.align === "right" ? "right" : "center";
			const x = P[0] + lb.offset[0] * dpr, y = P[1] + lb.offset[1] * dpr;
			ctx!.lineWidth = 3 * dpr; ctx!.strokeStyle = lb.outline || "rgba(0,0,0,0.85)"; ctx!.strokeText(lb.text, x, y);
			ctx!.fillStyle = lb.color; ctx!.fillText(lb.text, x, y);
		}
	}
	return api.clock?.rate !== 0;   // 時計が動いている（null＝実時間も）間は描き続ける
}
// 印の列から (x, y) に一番近い物（中心の距離 − 印の半径 ≤ r）＝純関数（node の検定 tests/pick.mjs が読む）
export function nearestMark<M extends { x: number; y: number; r: number }>(marks: M[], x: number, y: number, r: number) {
	let best: { m: M; d: number } | null = null;
	for (const m of marks) {
		const d = Math.hypot(m.x - x, m.y - y);
		if (d - m.r > r) continue;
		if (!best || d < best.d) best = { m, d };
	}
	return best;
}
export function pick(x: number, y: number, r: number, ctx?: { api?: { time?: number } | null } | null) {
	const b = nearestMark(marks2, x, y, r);
	if (!b) return null;
	const tr = b.m.tr, ms = ctx?.api?.time, q = ms != null ? positionAt(tr, ms) : null, llh = q ? ecefToLlh(q[0], q[1], q[2]) : null;
	return { id: tr.id, distance: b.d, lngLat: llh ? [llh[0], llh[1]] as LonLat : null, properties: { id: tr.id, name: tr.name ?? null } };   // 説明（description）は main（gadgets/czml.js）が持つ＝ここには来ない
}
