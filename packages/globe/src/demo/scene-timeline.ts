// 台本(type:"scenes")→総タイムライン＝時刻評価（スクラブの芯・純関数・再生しない）。正典＝demo/scene-format.md §7。
// プレーヤー（gadgets/demo.js＋app.js playScenes）の再生規則の写しで行を連結する：
//   先頭行=jump（遷移0秒）／view=球面フライト／glide=滑走（travel指定=1区間スプライン・無指定=時分割の自動尺）／
//   via畳み込み=連続ドリー（1本のスプライン）／fade=溶暗(travel・既定1.2)→切替0.3s→溶明(travel)＝cover(黒の濃さ)を返す／
//   pre=見せ玉の近似（pre 着地+1秒で view へカット。実プレーヤーは着地からの実測待ち＝秒単位で一致・拍は同じ）／
//   保持(hold)=着地後から（scene 再生の既定3秒）。slide の幕は時間だけ数える（カメラ据え置き・DOM演出は再現しない）。
// deps＝{plan(flightCtl.plan＝飛行の時刻評価プラン), parseView(parseViewHash), portrait, zoomMin}。
//   portrait＝mobile:Δz の判定（プレーヤーの mobView と同じ＝縦長画面だけ z に差分・zoomMin 床）。
// 返り値＝{dur(総尺・秒), rows:[{i,t0,tArrive,t1,knots[],hash}], at(秒)→{lon,lat,zoom,pitch,bearing(ラジアン),cover(0..1),i,hash}}。
//   時間は外側は全部「秒」（台本の掟）＝ms はプランの内側だけ。knots＝◇通過点の実到達時刻（末尾=着点自身）。
// 2026-10-24（PLATEAU AWARD 向け 第2便）：
//   保持中のカメラの動き＝行キー orbit（方位の増分°）・rise（チルトの増分°）・push（z の増分）＝着地の絵から保持の尺で ease in/out（次の行の出発点は動いた後の絵）。
//   時刻＝行キー time（"HH:MM"＝台本の date と utcOffset で解く・ISO も可）＝遷移の間に前の時刻から補間・保持中はその時刻（at().time＝ms・無ければ undefined）。
//   dissolve＝fade 行の溶け替え（黒を挟まない・切替 0.3s→溶け f 秒）＝カメラは頭でカット。
import { parseScenes, compileVias } from "./scene-adapter.ts";
import type { FlightController } from "@ortho-earth/core";
import type { ParsedView } from "@ortho-earth/core/viewurl";
import type { SceneRow } from "./scene-adapter.ts";
const R2D = 180 / Math.PI;

type Plan = FlightController["plan"];
/** カメラ（角はラジアン） */
interface Cam { lon: number; lat: number; zoom: number; pitch: number; bearing: number }
/** 時刻の絵（cover＝fade の黒の濃さ 0..1） */
type Pose = Cam & { cover?: number; time?: number };
const D2R = Math.PI / 180;
/** 保持中のカメラの動き（行キー orbit/rise/push）の増分。無ければ null */
export const holdMotion = (s: Record<string, unknown>): { orbit: number; rise: number; push: number } | null => {
	const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
	const m = { orbit: n(s.orbit), rise: n(s.rise), push: n(s.push) };
	return m.orbit || m.rise || m.push ? m : null;
};
/** ease in/out（保持の動き・時刻の補間の共通の曲線＝プレーヤーも同じ式） */
export const easeInOut = (u: number): number => { u = Math.max(0, Math.min(1, u)); return u * u * (3 - 2 * u); };
/** 行キー time を ms（UTC）へ。"HH:MM[:SS]"＝date（"YYYY-MM-DD"・既定＝今日）と utcOffset（時・既定＝経度/15 の丸め）の土地の時刻／日付つき＝ISO（オフセット無しは utcOffset の土地の時刻） */
export const resolveSceneTime = (v: unknown, { date, utcOffset, lon = 0 }: { date?: unknown; utcOffset?: unknown; lon?: number } = {}): number | null => {
	if (typeof v !== "string" || !v) return null;
	const off = typeof utcOffset === "number" && Number.isFinite(utcOffset) ? utcOffset : Math.round(lon / 15);
	const hm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(v);
	let y: number, mo: number, d: number, hh: number, mm: number, ss: number;
	if (hm) {
		const dm = typeof date === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(date) : null;
		const today = new Date(Date.now() + off * 3600e3);
		[y, mo, d] = dm ? [+dm[1], +dm[2] - 1, +dm[3]] : [today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()];
		[hh, mm, ss] = [+hm[1], +hm[2], +(hm[3] || 0)];
	} else {
		if (/(Z|[+-]\d{2}:?\d{2})$/.test(v)) { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }
		const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(v);
		if (!m) return null;
		[y, mo, d, hh, mm, ss] = [+m[1], +m[2] - 1, +m[3], +(m[4] || 12), +(m[5] || 0), +(m[6] || 0)];
	}
	const t = Date.UTC(y, mo, d, hh, mm, ss) - off * 3600e3;
	return Number.isFinite(t) ? t : null;
};
/** 行の記録（t0＝始まり・tArrive＝着地・t1＝保持の終わり・knots＝通過点の到達・秒） */
interface Rec { i: number; t0: number; tArrive: number; t1: number; knots: number[]; hash: string | undefined; evalT: ((sec: number) => Pose) | null; pose: Cam | null; motion: { orbit: number; rise: number; push: number } | null; time0: number | null; time1: number | null }
/** buildSceneTimeline の deps（plan＝flightCtl.plan・parseView＝parseViewHash） */
export interface SceneTimelineDeps { plan?: Plan | null; parseView?: ((hash: string) => ParsedView | null) | null; portrait?: boolean; zoomMin?: number }
/** 総タイムラインの 1 行 */
export interface SceneTimelineRow { i: number; t0: number; tArrive: number; t1: number; knots: number[]; hash: string | undefined; time: number | null }
/** 総タイムライン（dur＝総尺 秒・at(秒)＝その時刻の絵） */
export interface SceneTimeline { dur: number; rows: SceneTimelineRow[]; at(sec: number): Pose & { cover: number; i: number; hash: string | undefined } }
/** 保持の動きの絵（着地の絵＋増分×曲線）＝プレーヤーの保持アニメと同じ式 */
const moved = (p: Cam, m: { orbit: number; rise: number; push: number } | null, u: number): Cam => {
	if (!m) return p;
	const k = easeInOut(u);
	return { ...p, bearing: p.bearing + m.orbit * k * D2R, pitch: Math.max(0, Math.min(85 * D2R, p.pitch + m.rise * k * D2R)), zoom: p.zoom + m.push * k };
};

export function buildSceneTimeline(doc: unknown, { plan, parseView, portrait = false, zoomMin = 1 }: SceneTimelineDeps = {}): SceneTimeline | null {
	if (!plan || !parseView) return null;
	const { scenes, mobile, hold: holdD = 3, slideHold: slideHoldD = 4 } = parseScenes(doc);
	const rows = compileVias(scenes);
	if (!rows.length) return null;
	const camOf = (s: SceneRow, hash: unknown): Cam | null => {   // 視点ハッシュ→カメラ（mobile:Δz＝mobView と同じ規則）
		const v = typeof hash === "string" ? parseView(hash) : null;
		if (!v) return null;
		const d = s.mobile ?? mobile;
		const zoom = (portrait && d) ? Math.max(zoomMin, Math.round((v.zoom + d) * 100) / 100) : v.zoom;
		return { lon: v.lon, lat: v.lat, zoom, pitch: v.pitch || 0, bearing: v.bearing || 0 };
	};
	const recs: Rec[] = [];
	let t = 0, cam: Cam | null = null, clockT: number | null = null;
	const d0 = doc as { date?: unknown; utcOffset?: unknown } | null;
	const lon0 = (() => { for (const s of rows) { const h = s.view ?? s.glide ?? s.fade; const v = typeof h === "string" ? parseView(h) : null; if (v) return v.lon * R2D; } return 0; })();
	const timeOpt = { date: d0?.date, utcOffset: d0?.utcOffset, lon: lon0 };
	rows.forEach((s, i) => {
		const hash = s.view ?? s.glide ?? s.fade;
		const tgt = hash ? camOf(s, hash) : null;
		const from = cam;
		let trans = 0, knots: number[] = [], evalT: ((sec: number) => Pose) | null = null;   // evalT(局所秒)→{lon,lat,zoom,pitch,bearing,cover?}（遷移区間のみ）
		if (tgt && from && !s.jump) {
			if (s.path) {   // via 連続ドリー＝1本のスプライン（glidePathView と同じ pts）
				const pts = s.path.map(p => ({ ...camOf(s, p.view), secs: p.travel }) as Partial<Cam> & { secs?: number }).filter(p => Number.isFinite(p?.lon)) as Parameters<Plan["path"]>[1];
				const pl = pts.length ? plan.path(from, pts) : null;
				if (pl) { trans = pl.dur / 1000; knots = (pl.knots || []).map(ms => ms / 1000); evalT = sec => pl.at(sec * 1000); }
			} else if (s.fade && s.dissolve) {   // 溶け替え（fadeViewRun の写し）＝頭でカット→0.3s→前の絵が f 秒で溶ける（黒なし・スクラブは着点の絵）
				const f = (Number.isFinite(s.travel) && s.travel! > 0) ? s.travel! : 1.2;
				trans = 0.3 + f;
				evalT = () => tgt;
			} else if (s.fade) {   // 溶暗→切替→溶明（fadeViewRun の写し）＝カメラは黒の中でカット
				const f = (Number.isFinite(s.travel) && s.travel! > 0) ? s.travel! : 1.2;
				trans = f + 0.3 + f;
				evalT = sec => ({ ...(sec < f + 0.15 ? from : tgt),
					cover: sec < f ? sec / f : sec < f + 0.3 ? 1 : Math.max(0, 1 - (sec - f - 0.3) / f) });
			} else if (s.glide != null && s.travel) {   // 尺指定の滑走＝1区間スプライン（同時補間・尺どおり）
				const pl = plan.path(from, [{ ...tgt, secs: s.travel }]);
				if (pl) { trans = pl.dur / 1000; evalT = sec => pl.at(sec * 1000); }
			} else if (s.glide != null) {   // 滑走＝位置→方位→チルトの時分割（自動尺）
				const pl = plan.glide(from, tgt.lon, tgt.lat, tgt.zoom, tgt.pitch * R2D, tgt.bearing * R2D);
				trans = pl.dur / 1000; evalT = sec => pl.at(sec * 1000);
			} else {   // 地図遷移＝球面フライト（pre＝まず pre へ飛び、+1秒で view へカット）
				const pp = s.pre ? camOf(s, s.pre) : null, fl: Cam = pp ?? tgt;
				const pl = plan.fly(from, fl.lon, fl.lat, fl.zoom, fl.pitch * R2D, fl.bearing * R2D);
				trans = pl.dur / 1000 + (pp ? 1 : 0);
				evalT = sec => sec * 1000 < pl.dur ? pl.at(sec * 1000) : fl;
			}
		}
		// 保持（着地後から）：slide は時間だけ数える（view併記=地図ひと目+幕+三拍目／幕だけ=slideHold）＝demo.js schedule の写し
		const h = s.hold ?? holdD, sh = s.slideHold ?? slideHoldD;
		const dwell = s.slide ? (s.view ? Math.min(2, h) + sh + Math.min(1.5, h) : sh) : h;
		const t0 = t, tArrive = t0 + trans;
		const motion = s.slide ? null : holdMotion(s), pose = tgt ?? from;
		const time1 = resolveSceneTime(s.time, timeOpt) ?? clockT;
		recs.push({ i, t0, tArrive, t1: tArrive + dwell, knots, hash, evalT, pose, motion, time0: clockT ?? time1, time1 });
		clockT = time1;
		cam = pose ? moved(pose, motion, 1) : cam;   // 次の行の出発点＝保持の動きの後
		t = tArrive + dwell;
	});
	const dur = t;
	const at = (sec: number) => {
		sec = Math.max(0, Math.min(sec ?? 0, dur));
		let r = recs[0];
		for (const q of recs) { if (sec >= q.t0) r = q; else break; }
		const local = sec - r.t0, trans = r.tArrive - r.t0;
		const f: Pose = (local < trans && r.evalT) ? r.evalT(local)
			: r.pose ? moved(r.pose, r.motion, r.t1 > r.tArrive ? (sec - r.tArrive) / (r.t1 - r.tArrive) : 1) : { lon: 0, lat: 0, zoom: zoomMin, pitch: 0, bearing: 0 };
		const time = r.time1 == null ? undefined : r.time0 == null || trans <= 0 || local >= trans ? r.time1 : r.time0 + (r.time1 - r.time0) * easeInOut(local / trans);
		return { lon: f.lon, lat: f.lat, zoom: f.zoom, pitch: f.pitch || 0, bearing: f.bearing || 0, cover: f.cover || 0, time, i: r.i, hash: r.hash };
	};
	return { dur, rows: recs.map(({ i, t0, tArrive, t1, knots, hash, time1 }) => ({ i, t0, tArrive, t1, knots, hash, time: time1 })), at };
}
