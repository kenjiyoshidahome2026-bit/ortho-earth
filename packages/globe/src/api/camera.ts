// カメラの口（不透明度・上限と可動域・jumpTo／easeTo／flyTo・fitBounds・余白・注視点の高さ・制約・lookAt／follow・setCamera）と
// 光・空・太陽と月・雲（setLight／setLights／setSky／setSun／setClouds）＝createGlobe から切り出した（globe.js の分割 ⑩・2026-10-15）。中身は切り出す前と同じ。
//   live＝createGlobe の変数（let・この呼び出しより後で宣言される定数）を読み書きする口（getter／setter）。その他＝createGlobe の中の定数・関数（中身は createGlobe と共有）
import { LIGHT_TYPES, localLightsPayload, normLight, normLights } from "../light.ts";
import { WORLD_PX, shortBearingOf, wrapLon } from "@ortho-earth/core";
import { createCloudShell } from "../clouds.ts";
import { ecefToLlh, positionAt } from "../czml-time.ts";
import { moonAltAz, moonSubpoint, sunAltAz, sunSubpoint } from "@ortho-earth/ephem/sun";
import { normClouds, normSun, sunToLight } from "../weather.ts";
import { normSky } from "../sky-spec.ts";
import type { AtmosphereSpec, CameraOptions, CameraTarget, LightSpec, LonLat, MeshLightingSpec, GroundLightingSpec, GroundMaterialSpec, PaddingOptions } from "../../globe.d.ts";
import type { CameraDeps, CameraLive, CameraReturn, Installing } from "../types/install.ts";
import type { CameraApi, GlobeMap } from "../types/map.ts";
import type { FollowState } from "../types/scope.ts";
import type { CloudShell } from "../clouds.ts";
import type { SunSpecNorm } from "../weather.ts";

/** 経緯度の入力（[lon, lat]・{lng|lon, lat}） */
type LngLatIn = LonLat | { lng?: number; lon?: number; lat: number };
/** camTarget の答え（cam の単位＝ラジアン） */
interface CamGoal { lon: number; lat: number; zoom: number; pitch: number; bearing: number; roll: number }
/** 的の位置（[lon, lat, h m]） */
type LLH = [number, number, number];

export function installCamera(map: Installing<CameraApi, "__clouds">, live: CameraLive, {
	CAM_ZOOM_MIN, D2R, EARTH_M, MAXPITCH, R2D, animNow, cam, clock, flightCtl, flyTo, input, mapOn, onMove, opts, ownDestroy, pitchIn, pluginHost,
	reduceMotionOn, renderer, requestDraw, sendLight, sendSky, size, syncCenterAlt, unprojectXY, wPost
}: CameraDeps): CameraReturn {
	map.setOpacity = ({ base, globe, hypso } = {}) => { const v: { baseAlpha?: number; globeAlpha?: number; worldHypsoOpacity?: number } = {}; if (base != null) v.baseAlpha = base; if (globe != null) v.globeAlpha = globe; if (hypso != null) v.worldHypsoOpacity = hypso; renderer.set("view", v); requestDraw(); };   // hypso＝全球ハイプソ（低ズームの段彩）の濃さ＝0 で陸の地色だけ（2026-10-01）   // 基図（紙・線）と球体（globe/terrain）の不透明度＝表示パネルのスライダーと同じ口（0..1）
	// チルト上限の実行時変更（編集ガジェット＝真上固定 setMaxPitch(0)・null=起動時の上限へ戻す）。入力・飛行・共有hashの3経路が同じ値に従う
	map.setMaxPitch = deg => {
		live.maxPitchCur = pitchIn(deg) ?? (pitchIn(opts.maxPitch) ?? MAXPITCH);
		input.setMaxPitch(live.maxPitchCur); flightCtl.setMaxPitch(live.maxPitchCur);
		if (cam.pitch > live.maxPitchCur) { flightCtl.cancel(); cam.pitch = live.maxPitchCur; onMove(); }
		requestDraw();
	};
	map.maxPitch = () => live.maxPitchCur;
	map.getMaxPitch = () => live.maxPitchCur * R2D;   // MapLibre 同名＝度（maxPitch() はラジアンのまま）
	// ズーム床の実行時変更（編集ガジェット＝z2.5・null=カメラ実床へ戻す）。入力・飛行・共有hash・ズームボタンの4経路が従う
	map.setZoomMin = z => {
		live.zoomMinCur = z ?? CAM_ZOOM_MIN;
		input.setZoomMin(live.zoomMinCur); flightCtl.setMinZoom(live.zoomMinCur);
		if (cam.zoom < live.zoomMinCur) { flightCtl.cancel(); cam.zoom = live.zoomMinCur; onMove(); }
		requestDraw();
	};
	map.zoomMin = () => live.zoomMinCur;
	// ---- カメラの口（#35・2026-09-23・MapLibre と同名）----
	// 角は度（MapLibre と同じ）。map.view の pitch/bearing（ラジアン）とは単位が違う＝既存の flyTo(lon, lat, zoom, tiltDeg, bearingDeg) と揃えた。
	// padding＝{ top, right, bottom, left }（CSS px）か数値＝「中身の中心」を画面中心から寄せる（UI パネルに隠れる分）。setPadding の値が既定。
	// 近似の範囲：寄せはズーム先の地表の度/px で真俯瞰として解く（チルト中の奥行きの伸びは見ない＝MapLibre の厳密解より粗い）。
	// padding＝中身の中心＝注視点を画面の中心からずらす（cam.offset・CSS px）。MapLibre の transform.padding／centerOffset と同じ＝getCenter は頼んだ中心のまま・消失点も一緒に動く（A3・2026-10-12。旧＝経緯度の中心をずらしていた＝getCenter が頼んだ点と違った）
	const syncOffset = () => { const ox = (live.camPadding.left - live.camPadding.right) / 2, oy = (live.camPadding.top - live.camPadding.bottom) / 2; cam.offset = ox || oy ? [ox, oy] : undefined; };
	const padOf = (p: Partial<PaddingOptions> | number | null | undefined): PaddingOptions => p == null ? live.camPadding : typeof p === "number" ? { top: p, right: p, bottom: p, left: p } : { top: +p.top! || 0, right: +p.right! || 0, bottom: +p.bottom! || 0, left: +p.left! || 0 };
	const lngLatOf = (c: LngLatIn | null | undefined): LonLat | null => c == null ? null : Array.isArray(c) ? [+c[0], +c[1]] : [+(c.lng ?? c.lon)!, +c.lat];
	function camTarget(o: CameraOptions = {}): CamGoal {   // MapLibre の CameraOptions → cam の単位（ラジアン）の目標
		const zoom = o.zoom ?? cam.zoom, bearing = o.bearing != null ? o.bearing * D2R : cam.bearing, pitch = o.pitch != null ? o.pitch * D2R : cam.pitch, roll = o.roll != null ? o.roll * D2R : (cam.roll || 0);
		const c = lngLatOf(o.center) ?? [cam.center[0], cam.center[1]];
		if (o.padding != null) { live.camPadding = padOf(o.padding); syncOffset(); }   // CameraOptions.padding＝以後の padding（MapLibre と同じ＝transform.padding を書く）
		return { lon: c[0], lat: c[1], zoom: Math.max(live.zoomMinCur, Math.min(live.zoomMaxCur, zoom)), pitch, bearing, roll };
	}
	function clampCamLimits(): void {
		if (camConstrain) {
			try {
				const r = camConstrain({ center: [cam.center[0], cam.center[1]], zoom: cam.zoom, pitch: cam.pitch * R2D, bearing: cam.bearing * R2D, roll: (cam.roll || 0) * R2D });
				if (r) { const c = lngLatOf(r.center); if (c && Number.isFinite(c[0]) && Number.isFinite(c[1])) cam.center = [c[0], Math.max(-90, Math.min(90, c[1]))]; if (Number.isFinite(r.zoom)) cam.zoom = Math.max(live.zoomMinCur, Math.min(live.zoomMaxCur, r.zoom!)); }
			} catch (e) { console.error("[map.setConstrain]", e); }
		}
		if (live.camUpdateFn) {   // setTransformCameraUpdate（B6）＝制約の後にカメラを書き換える口（MapLibre と同じ順）。角は度・elevation は注視点の高さ m
			try {
				const r = live.camUpdateFn({ center: [cam.center[0], cam.center[1]], zoom: cam.zoom, pitch: cam.pitch * R2D, bearing: cam.bearing * R2D, roll: (cam.roll || 0) * R2D, elevation: cam.centerAlt || 0 });
				if (r) {
					const c = r.center != null ? lngLatOf(r.center) : null; if (c && Number.isFinite(c[0]) && Number.isFinite(c[1])) cam.center = [c[0], Math.max(-90, Math.min(90, c[1]))];
					if (Number.isFinite(r.zoom)) cam.zoom = Math.max(live.zoomMinCur, Math.min(live.zoomMaxCur, r.zoom!));
					if (Number.isFinite(r.pitch)) cam.pitch = Math.max(0, Math.min(live.maxPitchCur, r.pitch! * D2R));
					if (Number.isFinite(r.bearing)) cam.bearing = r.bearing! * D2R;
					if (Number.isFinite(r.roll)) cam.roll = r.roll! * D2R;
					if (Number.isFinite(r.elevation)) { live.centerElevFixed = r.elevation!; live.centerElevMode = r.elevation!; syncCenterAlt(); }
				}
			} catch (e) { console.error("[map.setCameraUpdate]", e); }
		}
		if (cam.zoom > live.zoomMaxCur) cam.zoom = live.zoomMaxCur;
		if (cam.pitch < live.minPitchCur) cam.pitch = live.minPitchCur;   // 最小チルト（setMinPitch・B6）
		if (!live.camBounds) return;
		const [w, s, e, n] = live.camBounds;
		cam.center[1] = Math.max(s, Math.min(n, cam.center[1]));
		const lon = wrapLon(cam.center[0]);
		const inside = w <= e ? lon >= w && lon <= e : lon >= w || lon <= e;   // w>e＝±180 を跨ぐ可動域
		if (inside) return;
		const d = (x: number) => { const v = Math.abs(wrapLon(lon - x)); return v; };
		cam.center[0] = d(w) <= d(e) ? w : e;
	}
	map.jumpTo = (o: CameraOptions & { elevation?: number } = {}) => { flightCtl.cancel(); if (o.elevation != null && Number.isFinite(+o.elevation)) live.centerElevFixed = +o.elevation; const t = camTarget(o); cam.center = [t.lon, t.lat]; cam.zoom = t.zoom; cam.pitch = Math.max(0, Math.min(live.maxPitchCur, t.pitch)); cam.bearing = t.bearing; cam.roll = t.roll; onMove(); return map; };
	const noAnim = (o: { animate?: boolean; essential?: boolean }) => o.animate === false || (!o.essential && reduceMotionOn());   // animate:false・動きを減らす（essential:true は例外＝MapLibre と同じ・C10）
	map.easeTo = (o = {}) => noAnim(o) ? (map.jumpTo(o), Promise.resolve()) : flightCtl.easeTo(camTarget(o), o.duration ?? 500);
	// flyTo：従来の位置引数（lon, lat, zoom, tiltDeg, bearingDeg）に加え、MapLibre の形 flyTo({ center, zoom, pitch, bearing, padding, animate })
	map.flyTo = ((a: number | (CameraOptions & { animate?: boolean; essential?: boolean }), ...rest: [number, number, number?, number?]) => {
		if (a == null || typeof a !== "object" || Array.isArray(a)) return flyTo(a as number, ...rest);
		if (noAnim(a)) { map.jumpTo(a); return Promise.resolve(); }
		const t = camTarget(a);
		if (t.roll !== (cam.roll || 0)) { cam.roll = t.roll; }   // roll は飛行の振り付けに無い＝離陸で書く（easeTo は補間する）
		return flyTo(t.lon, t.lat, t.zoom, t.pitch * R2D, t.bearing * R2D);   // 省略した角は今の値（MapLibre の意味論）
	}) as CameraApi["flyTo"];   // 重ね書き（位置引数／MapLibre の形）の実体は 1 本
	// bbox＝[west, south, east, north]（west>east＝±180 跨ぎ）か [[w,s],[e,n]]。options＝{ padding, maxZoom, pitch, bearing, animate, linear, duration }
	map.cameraForBounds = (bounds, o = {}) => {
		let b: number[] | null | undefined = Array.isArray(bounds?.[0]) ? [(bounds as [LonLat, LonLat])[0][0], (bounds as [LonLat, LonLat])[0][1], (bounds as [LonLat, LonLat])[1][0], (bounds as [LonLat, LonLat])[1][1]] : bounds as number[];
		if (!b || b.length < 4 || !b.every(Number.isFinite)) return null;
		let [w, s, e, n] = b; if (e < w) e += 360;
		const pad = padOf(o.padding ?? live.camPadding);
		const W = Math.max(1, size.w / live.dpr - pad.left - pad.right), H = Math.max(1, size.h / live.dpr - pad.top - pad.bottom);   // size は device px
		const latC = (s + n) / 2;
		const thX = Math.max(1e-9, (e - w) * Math.cos(latC * D2R) * D2R), thY = Math.max(1e-9, (n - s) * D2R);
		let zoom = Math.log2(Math.min(W / thX, H / thY) / (WORLD_PX / (2 * Math.PI)));
		zoom = Math.max(live.zoomMinCur, Math.min(o.maxZoom ?? live.zoomMaxCur, live.zoomMaxCur, zoom));
		return { center: [wrapLon((w + e) / 2), latC], zoom, pitch: o.pitch ?? 0, bearing: o.bearing ?? 0, padding: pad };
	};
	map.fitBounds = (bounds, o = {}) => {
		const c = map.cameraForBounds(bounds, o);
		if (!c) return Promise.resolve();
		if (noAnim(o)) { map.jumpTo(c); return Promise.resolve(); }
		return o.linear ? map.easeTo({ ...c, duration: o.duration, essential: o.essential }) : map.flyTo({ ...c, essential: o.essential });
	};
	map.setPadding = p => { live.camPadding = padOf(p ?? 0); syncOffset(); onMove(); return map; };
	map.getPadding = () => ({ ...live.camPadding });
	// 画面の 2 点（CSS px）が収まる所へ（MapLibre 同名・A3）。bearing＝着地の方位。2 点のどちらかが空（球の外）なら何もしない
	map.fitScreenCoordinates = (p0, p1, bearing, o = {}) => {
		const xy = (p: [number, number] | { x: number; y: number }): [number, number] => Array.isArray(p) ? p : [p.x, p.y], a = unprojectXY(...xy(p0)), b = unprojectXY(...xy(p1));
		if (!a || !b) return Promise.resolve();
		let w = Math.min(a[0], b[0]), e = Math.max(a[0], b[0]); if (e - w > 180) [w, e] = [e, w];   // ±180 を跨ぐ＝西>東
		return map.fitBounds([w, Math.min(a[1], b[1]), e, Math.max(a[1], b[1])], { ...o, bearing: bearing ?? o.bearing ?? 0 });
	};
	// 注視点の高さの実行時変更（MapLibre 同名・A3）：clamped＝地形の上の中心点（opts.centerElevation:"ground"）／false＝固定値（setCenterElevation・jumpTo({elevation})）
	map.setCenterClampedToGround = b => { live.centerElevMode = b ? "ground" : (live.centerElevFixed ?? 0); if (!b && live.centerElevFixed == null) live.centerElevFixed = 0; syncCenterAlt(); onMove(); return map; };
	map.getCenterClampedToGround = () => live.centerElevMode === "ground";
	map.setCenterElevation = m => { live.centerElevFixed = Number.isFinite(+m) ? +m : 0; if (live.centerElevMode !== "ground") live.centerElevMode = live.centerElevFixed; syncCenterAlt(); onMove(); return map; };
	map.getCenterElevation = () => cam.centerAlt || 0;
	map.getCameraTargetElevation = () => cam.centerAlt || 0;
	// 可動域の自作（MapLibre の setTransformConstrain 相当・A3）：fn({ center:[lon,lat], zoom, pitch, bearing, roll }) → { center?, zoom? } か null。角は度・zoom はエンジンの z（旗つきの地図でも＝"engine"）。毎移動 clamp の前に通す
	let camConstrain: Parameters<CameraApi["setConstrain"]>[0] = null;
	map.setConstrain = fn => { camConstrain = typeof fn === "function" ? fn : null; onMove(); return map; };
	// ── Navara 系の口（A4・2026-10-12・計画 parity-plan §7）：lookAt・follow・setCamera/getCamera。MapLibre に同名は無い＝shim には出さない（エンジンの口）
	//   的（target）＝[lon, lat, h?]・{lng|lon, lat, alt|height?}・関数 ms→点（時計の時刻を渡す）・文字列＝読み込み中の CZML/GPX の軌跡の id か name（時計の時刻の位置・範囲外は null＝動かない）
	//   距離（m）⇄ zoom は camera.js の式そのもの（camDist＝radPerDevPx·H/2/tan(fovy/2)）＝view.eye.distM と一致する
	const camDpr = () => cam.dpr ?? 1;
	const zoomOfDistM = (distM: number) => Math.log2(Math.PI * size.h * EARTH_M / (Math.tan((cam.fovy || 50 * D2R) / 2) * WORLD_PX * camDpr() * Math.max(1e-3, distM)));
	const distMOfZoom = (z: number) => Math.PI * size.h * EARTH_M / (Math.tan((cam.fovy || 50 * D2R) / 2) * WORLD_PX * camDpr() * Math.pow(2, z));
	const targetOf = (t: CameraTarget | null | undefined): LLH | null => {   // → [lon, lat, hM] | null
		if (t == null) return null;
		if (typeof t === "function") { let v: CameraTarget | null | undefined = null; try { v = t(clock.time); } catch (e) { console.error("[map.follow target]", e); } return typeof v === "function" ? null : targetOf(v); }
		if (typeof t === "string") { const tr = live.czmlCtl?.tracks.find(x => x.id === t || x.name === t); if (!tr) return null; const q = positionAt(tr, clock.time); return q ? ecefToLlh(q[0], q[1], q[2]) : null; }
		if (Array.isArray(t)) return t.length >= 2 && Number.isFinite(+t[0]) && Number.isFinite(+t[1]) ? [+t[0], +t[1], Number.isFinite(+t[2]!) ? +t[2]! : 0] : null;
		const lon = +(t.lng ?? t.lon)!, lat = +t.lat;
		return Number.isFinite(lon) && Number.isFinite(lat) ? [lon, lat, +(t.alt ?? t.height ?? t.elevation ?? 0) || 0] : null;
	};
	const offsetLLH = (p: LLH, off: unknown): LLH => {   // offset＝[東 m, 北 m, 上 m]（的からのずらし・Navara の cameraFollow の offset と同じ向き＝局所の東北上）
		if (!Array.isArray(off)) return p;
		const n = +off[1] || 0, e = +off[0] || 0, u = +off[2] || 0, lat = p[1] + n / EARTH_M * R2D;
		return [p[0] + e / (EARTH_M * Math.max(0.01, Math.cos(lat * D2R))) * R2D, Math.max(-90, Math.min(90, lat)), p[2] + u];
	};
	const camOfLookAt = (p: LLH, o: { zoom?: number; distance?: number; bearing?: number; pitch?: number; roll?: number }): CameraOptions & { elevation: number } => ({ center: [p[0], p[1]], elevation: p[2], zoom: o.zoom ?? (o.distance != null && Number.isFinite(+o.distance) ? zoomOfDistM(+o.distance) : undefined), bearing: o.bearing, pitch: o.pitch, roll: o.roll });
	// lookAt(target, { distance(m) | zoom, bearing, pitch, roll, duration, animate })＝的を注視点に。duration>0 なら easeTo・それ以外は即時。戻り＝Promise（着いたら）
	map.lookAt = (target, o = {}) => {
		const p = targetOf(target); if (!p) return Promise.resolve();
		live.followSt = null;
		const c = camOfLookAt(p, o);
		if (p[2]) live.centerElevMode = p[2];   // 高さのある的（航空機・衛星）＝地面の上の中心点を離れて的の高さを注視点に（getCenterClampedToGround が false になる）。h=0 の的は今の流儀のまま
		if (o.animate === false || !(o.duration! > 0)) { map.jumpTo(c); syncCenterAlt(); return Promise.resolve(); }
		live.centerElevFixed = p[2]; syncCenterAlt();
		return map.easeTo({ ...c, duration: o.duration });
	};
	// follow(target, { distance | zoom, bearing, pitch, roll, offset:[東,北,上 m], lerp:0..1（1＝即・既定）, stopOnGesture:true })＝毎フレーム的を追う（衛星・車両・CZML の時刻つき点）。
	// 省いた角・zoom は今の値のまま＝追従中に setZoom/回転の操作が効く。飛行中（flyTo）は的を待つ。follow(null)・stop()・map.stop()・操作（stopOnGesture）で止まる。戻り＝{ stop(), active, target }
	map.follow = (target, o = {}) => {
		if (target == null) { live.followSt = null; return null; }
		const st: FollowState = { target, lerp: Math.max(0, Math.min(1, +(o.lerp ?? 1))), offset: o.offset, zoom: o.zoom ?? (o.distance != null && Number.isFinite(+o.distance) ? zoomOfDistM(+o.distance) : null), bearing: o.bearing, pitch: o.pitch, roll: o.roll, stopOnGesture: o.stopOnGesture !== false,
			stop() { if (live.followSt === st) live.followSt = null; }, get active() { return live.followSt === st; } };
		live.followSt = st; flightCtl.cancel(); input.stop(); tickFollow(true);
		return st;
	};
	map.isFollowing = () => !!live.followSt;
	function tickFollow(first = false): void {
		const st = live.followSt; if (!st || live.flying) return;
		let p = targetOf(st.target); if (!p) return;
		p = offsetLLH(p, st.offset);
		const k = first ? 1 : st.lerp;
		cam.center = [cam.center[0] + wrapLon(p[0] - cam.center[0]) * k, cam.center[1] + (p[1] - cam.center[1]) * k];
		live.centerElevFixed = (live.centerElevFixed ?? 0) + (p[2] - (live.centerElevFixed ?? 0)) * k;
		if (p[2]) live.centerElevMode = live.centerElevFixed;   // 高さのある的＝lookAt と同じ（地面の上の中心点を離れる）
		if (st.zoom != null) cam.zoom = cam.zoom + (st.zoom - cam.zoom) * k;
		if (st.bearing != null) cam.bearing += shortBearingOf(st.bearing * D2R - cam.bearing) * k;
		if (st.pitch != null) cam.pitch = Math.max(0, Math.min(live.maxPitchCur, cam.pitch + (st.pitch * D2R - cam.pitch) * k));
		if (st.roll != null) cam.roll = (cam.roll || 0) + shortBearingOf(st.roll * D2R - (cam.roll || 0)) * k;
		syncCenterAlt(); onMove();
	}
	// setCamera({ lng, lat, height, distance, heading, pitch, roll })＝Navara の形を 1 対 1 で受ける薄い変換（即時）。lng/lat/height＝注視点・distance＝注視点までの m・heading＝bearing・
	// pitch＝MapLibre の意味（0＝真下・度）。負の pitch は Cesium の意味（−90＝真下）と読んで 90+pitch に直す。省いた物は今の値。getCamera＝同じ形で返す（pitch は MapLibre の意味）
	map.setCamera = (c = {}) => {
		const cur = map.getCamera();
		const p = targetOf({ lng: c.lng ?? c.lon ?? cur.lng, lat: c.lat ?? cur.lat, height: c.height ?? c.alt ?? cur.height });
		if (!p) return map;
		let pitch: number = c.pitch ?? cur.pitch; if (pitch < 0) pitch = 90 + pitch;
		map.jumpTo(camOfLookAt(p, { distance: c.distance, zoom: c.zoom, bearing: c.heading ?? c.bearing, pitch, roll: c.roll }));
		if (c.near !== undefined) cam.near = Number.isFinite(+c.near!) && +c.near! > 0 ? +c.near! : undefined;   // near 面の上限［m］（core Camera.near・省けば今の値・null/0＝従来の近さに戻す）
		syncCenterAlt(); return map;
	};
	map.getCamera = () => ({ lng: cam.center[0], lat: cam.center[1], height: cam.centerAlt || 0, distance: distMOfZoom(cam.zoom), heading: cam.bearing * R2D, pitch: cam.pitch * R2D, roll: (cam.roll || 0) * R2D, ...(cam.near ? { near: cam.near } : {}) });
	// style の light（MapLibre 同名・B3）：押し出し・glTF・LOD2 の陰影（GL2 の u_light*・WebGPU は PB の sl0/sl1＝同式・2026-10-13）。null＝従来の固定光
	map.setLight = l => { live.mlLight = l == null ? null : normLight(l); sendLight(); requestDraw(); return map; };   // setLight＝setLights の directional の別名（F1・getLights は mlLight を見る＝style の根の light も映る）
	map.getLight = () => normLight(live.mlLight);
	// 光源の口（第 2 波 F1・2026-10-12・src/light.js）：map.setLights([{ type: "directional"|"point"|"spot"|"ambient"|"hemisphere"|"ibl"|<plugin の type>, ... }])／getLights()。
	//   受けて既定を補って**保つ**。描くのは directional（setLight と同じ経路・1 つまで）と point/spot/ambient/hemisphere（第 3 波 W2・renderer "lights"・メッシュの陰影）。ibl は保つだけ（capabilities "spec"・plugin が描く）。
	//   plugin の type＝registry.lights.add(type, { apply(map, lights) })＝setLights のたびに、その type の光源の配列（無ければ []）で apply を呼ぶ（自前の overlay/three で描く約束）
	let lightsCur: LightSpec[] = [];
	map.setLights = list => {
		const reg = pluginHost.registry.lights;
		const next = normLights(list, t => reg.has(t) && !LIGHT_TYPES.includes(t));
		const dir = next.find(l => l.type === "directional");
		live.mlLight = dir ? normLight(dir) : null; sendLight();
		lightsCur = next.filter(l => l.type !== "directional");   // directional は mlLight が正本（setLight・style の根の light・setStyle の差分と同じ 1 本）
		renderer.set("lights", localLightsPayload(lightsCur, EARTH_M));   // 局所の光源（第 3 波 W2）＝point/spot/ambient/hemisphere を renderer へ（メッシュ＝模型・LOD2 の陰影に足す・上限 8）
		for (const t of reg.names()) if (!LIGHT_TYPES.includes(t)) { try { reg.get(t)!.apply(map, next.filter(l => l.type === t)); } catch (e) { console.warn(`[lights] ${t}: apply failed`, e); } }
		requestDraw(); return map;
	};
	map.getLights = () => ((live.mlLight ? [{ type: "directional", ...normLight(live.mlLight) }] : []) as LightSpec[]).concat(lightsCur.map(l => ({ ...l })));
	// style の sky（MapLibre 同名・B4）：球に当たらない視線を horizon-color→sky-color の簡易の空で塗り（GL2・不透明＝星空は隠れる）、霧の色を fog-color・濃さを fog-ground-blend に（両レンダラ）。
	// null＝従来（宇宙へ抜けるリム光・霧は紙色）。getSky は MapLibre と同じく無指定なら undefined・指定があれば既定を補った物
	map.setSky = s => { live.mlSky = s == null ? null : normSky(s); sendSky(); requestDraw(); return map; };
	map.getSky = () => (live.mlSky ? normSky(live.mlSky) : undefined);
	// 大気の描き方（2026-10-25）：{ model: "cesium" }＝CesiumJS の地面の大気と空の大気の式（ortho-core csatmo.ts）。renderer の view.csAtmo へ（両レンダラ）
	let atmoCur: AtmosphereSpec | null = null;
	map.setAtmosphere = a => {
		if (a != null && a.model !== "cesium") throw new Error(`setAtmosphere: unknown model ${String((a as { model?: unknown }).model)}`);
		atmoCur = a == null ? null : { model: "cesium", ground: a.ground !== false, sky: a.sky !== false };
		renderer.set("view", { csAtmo: atmoCur && { ground: atmoCur.ground, sky: atmoCur.sky } }); requestDraw(); return map;
	};
	map.getAtmosphere = () => (atmoCur ? { ...atmoCur } : null);
	// 模型の照明（2026-10-26・@ortho-earth/cesium）：Cesium の式でメッシュを描く（両レンダラ・renderer "meshLight"）。dir は ECEF → 世界系（x, z, y）へ
	let meshLightCur: MeshLightingSpec | null = null;
	map.setMeshLighting = l => {
		meshLightCur = l == null ? null : { ...l, sh: Float32Array.from(l.sh as ArrayLike<number>) };
		if (!l) renderer.set("meshLight", null);
		else { const d = l.dir, n = Math.hypot(d[0], d[1], d[2]) || 1; renderer.set("meshLight", { dir: [d[0] / n, d[2] / n, d[1] / n], color: l.color ?? [1, 1, 1], sh: Float32Array.from(l.sh as ArrayLike<number>), ibl: l.ibl ?? [1, 1], invL00: l.invL00 ?? 1 }); }
		requestDraw(); return map;
	};
	map.getMeshLighting = () => (meshLightCur ? { ...meshLightCur } : null);
	let groundLightCur: GroundLightingSpec | null = null;
	map.setGroundLighting = l => {
		groundLightCur = l == null ? null : { ...l };
		if (!l) renderer.set("groundLight", null);
		else { const d = l.dir, n = Math.hypot(d[0], d[1], d[2]) || 1; renderer.set("groundLight", { dir: [d[0] / n, d[2] / n, d[1] / n], color: l.color ?? [1, 1, 1], lambert: l.lambert ?? [0.9, 0.3], normal: l.normal ?? "terrain", fade: l.fade ?? null, night: l.night ?? null }); }
		requestDraw(); return map;
	};
	map.getGroundLighting = () => (groundLightCur ? { ...groundLightCur } : null);
	// 地面の材質（setGroundMaterial・2026-10-28・Cesium の globe.material）＝render worker へは kind（0 なし／1 標高／2 傾斜／3 方位／4 等高線だけ）と 1 列の色の表で
	let groundMatCur: GroundMaterialSpec | null = null;
	map.setGroundMaterial = m => {
		groundMatCur = m ? { ...m } : null;
		renderer.set("groundMaterial", m ? packGroundMaterial(m) : null);
		requestDraw(); return map;
	};
	map.getGroundMaterial = () => (groundMatCur ? { ...groundMatCur } : null);
	// ── 太陽・月の向きと雲の口（第 2 波 F2・2026-10-12・src/weather.js・ephem/sun）──
	//   getSunPosition(ms?, at?)／getMoonPosition(ms?, at?)＝{ time, subpoint:{lng,lat}, azimuth, altitude, enu }（度・at 省略＝視点の中心・ms 省略＝共通の時計）
	//   setSun({ follow:"clock" } | { azimuth, altitude } | null)＝directional の光（setLight と同じ 1 本）を太陽に合わせる。follow＝時計の変化・静止・実時間なら 60 秒ごとに追う。null＝setLight(null)
	//   setClouds(spec|null)／getClouds()＝type "image"（url の全球の雲画像を altitude の殻として描く・W6 builtin）はこちらで描き、手続きの雲・降水は受けて保つだけ。registry.clouds の plugin（{ apply(map, clouds) }）があれば呼ぶ
	const bodyAt = (altAz: typeof sunAltAz, sub: typeof sunSubpoint, ms: number | undefined, at: { lng?: number; lon?: number; lat?: number; 0?: number; 1?: number } | undefined) => {
		const t = Number.isFinite(+ms!) ? +ms! : clock.time;
		const lon = at ? (at.lng ?? at.lon ?? at[0]) : cam.center[0], lat = at ? (at.lat ?? at[1]) : cam.center[1];
		const sp = sub(t), a = altAz(t, lon!, lat!);
		return { time: t, subpoint: { lng: sp[0] * R2D, lat: sp[1] * R2D }, azimuth: a.azimuth, altitude: a.altitude, enu: a.enu };
	};
	map.getSunPosition = (ms, at) => bodyAt(sunAltAz, sunSubpoint, ms, at);
	map.getMoonPosition = (ms, at) => bodyAt(moonAltAz, moonSubpoint, ms, at);
	let sunSpec: SunSpecNorm | null = null, sunTimer: ReturnType<typeof setInterval> | 0 = 0;
	const applySun = () => { if (!sunSpec) return; map.setLight(sunToLight(sunSpec, sunSpec.follow === "clock" ? map.getSunPosition() : sunSpec)); };
	map.setSun = sp => {
		if (sp == null || sp === false) { sunSpec = null; if (sunTimer) { clearInterval(sunTimer); sunTimer = 0; } map.setLight(null); return map; }
		sunSpec = normSun(sp); applySun();
		if (!sunTimer) sunTimer = setInterval(() => { if (sunSpec?.follow === "clock" && clock.isLive()) applySun(); }, 60e3);   // 実時間＝time の合図が来ない（約 0.25°/分）
		return map;
	};
	map.getSun = () => (sunSpec ? { ...sunSpec } : null);
	map.on("time", () => { if (sunSpec?.follow === "clock") applySun(); });
	map.on("settle", () => { if (sunSpec?.follow === "clock") applySun(); });   // 視点の中心が動いた＝その場所の高度・方位で
	ownDestroy.push(() => { if (sunTimer) clearInterval(sunTimer); });
	ownDestroy.push(() => cloudShell?.destroy());
	let cloudsCur: ReturnType<typeof normClouds> = null, cloudShell: CloudShell | null = null;
	map.setClouds = c => {
		cloudsCur = normClouds(c);
		if (cloudsCur?.type === "image") {   // builtin（W6）＝全球の雲画像を高度の殻として描く。読めたら map.on("clouds") に { state:"ready" }（失敗は "error"）
			cloudShell ??= map.__clouds = createCloudShell(map, {
				setMesh: (name, data) => { wPost({ type: "set", cmd: "meshSet", data, prop: name }, data ? [...new Set([data.pos.buffer, data.nrm.buffer, data.idx.buffer, data.uv.buffer, data.col.buffer, data.tex?.rgba?.buffer].filter((b): b is ArrayBuffer => Boolean(b)))] : []); requestDraw(); },
				setMeshXf: (name, data) => { wPost({ type: "set", cmd: "meshXf", data, prop: name }); },
				requestDraw: requestDraw, earthM: EARTH_M, now: animNow,
				emit: ev => { for (const cb of mapOn.clouds) { try { cb(ev); } catch (e) { console.error("[map.on clouds]", e); } } },
			});
			cloudShell.set(cloudsCur);
		} else cloudShell?.clear();
		const reg = pluginHost.registry.clouds;
		for (const n of reg.names()) { try { reg.get(n)!.apply(map, cloudsCur); } catch (e) { console.warn(`[clouds] ${n}: apply failed`, e); } }
		requestDraw(); return map;
	};
	map.getClouds = () => (cloudsCur ? { ...cloudsCur, wind: [...cloudsCur.wind], precipitation: cloudsCur.precipitation && { ...cloudsCur.precipitation } } : null);
	return { clampCamLimits, tickFollow };
}

/** 地面の材質（GroundMaterialSpec）→ render worker の形（gl/gpu の renderer.set("groundMaterial")）。ランプは n×RGBA の写し（worker へ渡すので元の配列は触らない） */
export function packGroundMaterial(m: GroundMaterialSpec): { kind: number; min: number; max: number; landOnly: number; contour: number[] | null; spacing: number; width: number; opacity: number; ramp: Uint8Array | null; rampN: number } {
	const r = m.ramp && m.ramp.colors && m.ramp.colors.length >= 4 ? m.ramp : null;
	const n = r ? Math.floor(r.colors.length / 4) : 0;
	const c = m.contour && m.contour.spacing > 0 ? m.contour : null;
	const kind = r ? ({ elevation: 1, slope: 2, aspect: 3 } as Record<string, number>)[r.kind] || 1 : c ? 4 : 0;
	return { kind, min: r?.min ?? 0, max: r?.max ?? 1, landOnly: m.landOnly ? 1 : 0, contour: c ? [c.color[0], c.color[1], c.color[2], c.color[3] ?? 1] : null, spacing: c ? c.spacing : 1, width: c ? (c.width ?? 1) : 0, opacity: m.opacity ?? 1, ramp: n ? Uint8Array.from(r!.colors.subarray(0, n * 4)) : null, rampN: n };
}
