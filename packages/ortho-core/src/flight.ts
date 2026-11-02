// 球面フライト＝三段の振り付け「①水平・北向きへ → ②平面のまま飛ぶ → ③着地してから起こす」。
// ①紙地図の作法＝場所の把握はまず真俯瞰・北向きで（回転や傾きを持ったまま飛ぶと現在地を見失う）。
// ②van Wijk & Nuij の厳密解（d3.interpolateZoom と同式・ρ=√2）＝知覚速度一定の最適経路。
//   「行程が視野に入る高度まで上げる」式の近似は上がりすぎて低ズーム滞在が長く、画面速度が暴れる（実証済み）。
// ③着地の瞬間 onFlying(false)＝重い自動ロード（建物メッシュ等）の解禁は呼び出し側がここで行う＝
//   デコード/GPU転送が飛行アニメと帯域を取り合わない。立ち上がりが着陸の演出になる。
// ユーザーのドラッグ/ホイールで即中断＝主導権は常に人（呼び出し側が cancel() を叩く）。
//
// ★時刻評価（プラン）＝振り付けの純関数化（2026-08-09・タイムラインスクラブの土台）：
//   各振り付けは flyPlan/glidePlan/glidePathPlan が {dur, land, at(ms)→カメラ} を返し、
//   ライブ再生（createFlight）は同じプランを rAF でなぞるだけ＝数式は一箇所（プランが単一の真実）。
//   時計は刻み上限つき仮想時計（run の STEP_MAX_MS）＝非力端末では尺を伸ばして連続に滑る（跳ばない）。
//   cam0＝出発カメラのスナップショット {lon,lat,zoom,pitch,bearing}（角はラジアン＝cam と同じ）、
//   env＝{viewW(px・プラン構築時に固定), maxPitch, minZoom}。land＝着地時刻[ms]（onFlying(false)＝③の解禁点）。
import { WORLD_PX, type CameraPose } from "./camera.ts";
const D2R = Math.PI / 180;
const ss = (k: number): number => k * k * (3 - 2 * k);   // smoothstep（各チャンネル単独の動きの緩急）

/** カメラのスナップショット（角はラジアン） */
export interface FlightTarget { lon: number; lat: number; zoom: number; pitch: number; bearing: number; /** easePlan だけが補間する（fly/glide は今の値のまま） */ roll?: number }
/** 時刻評価のプラン */
export interface FlightPlan { dur: number; land: number; at(tMs: number): FlightTarget; knots?: number[] }
export interface FlightEnv { viewW: number; maxPitch: number; minZoom?: number }
/** glidePath の通過点 */
export interface PathPoint { lon: number; lat: number; zoom: number; pitch?: number; bearing?: number; secs?: number }

// 方位角を最短回転(-π..π]へ正規化（コンパスの読みと同じ）
export const shortBearingOf = (b: number): number => ((b + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;

// シーンチェンジ＝三段の振り付け（flatten 500ms → van Wijk 巡航 → 起こし 700ms）。
// bearingDeg＝着地方位（省略=北）。巡航は常に北向き＝③の「起こす」で tilt と同時に回り込む（デモ台本の t/r 着地用）。
// 着地チルト：指定（自然地名=55°等）＞ z15+着地の既定45°。出発時の姿勢に依存しない＝毎回同じ振り付け。
export function flyPlan(cam0: FlightTarget, env: FlightEnv, lon: number, lat: number, zoom: number, tiltDeg?: number | null, bearingDeg?: number | null): FlightPlan {
	const { viewW, maxPitch, minZoom = 0 } = env;
	zoom = Math.max(minZoom, zoom);   // 床下の目標でも飛行で潜らない（applyView の床と同じ掟）
	const p1 = tiltDeg != null ? Math.min(maxPitch, tiltDeg * D2R) : (zoom >= 15 ? 45 * D2R : 0);
	const b1 = bearingDeg ? shortBearingOf(bearingDeg * D2R) : 0;   // 着地方位（最短回転側の値へ正規化）
	const P0 = cam0.pitch, B0 = shortBearingOf(cam0.bearing);
	const flatMs = (Math.abs(P0) > 0.01 || Math.abs(B0) > 0.01) ? 500 : 0;   // ①水平・北向きへ（既にそうなら飛ばす）
	const z0 = cam0.zoom, z1 = zoom, lon0 = cam0.lon, lat0 = cam0.lat;
	let dLon = lon - lon0; dLon -= Math.round(dLon / 360) * 360;   // 最短経路（antimeridian 安全側）
	const dLat = lat - lat0;
	const rho = Math.SQRT2, rho2 = 2, rho4 = 4;
	const wOf = (z: number): number => 360 * viewW / (WORLD_PX * Math.pow(2, z));       // 視野幅[deg]
	const zOf = (w: number): number => Math.log2(360 * viewW / (WORLD_PX * w));
	const w0 = wOf(z0), w1 = wOf(z1), d2 = dLon * dLon + dLat * dLat, d1 = Math.sqrt(d2);
	let S: number, frameAt: (e: number) => [number, number];   // S＝経路長（ρ単位）、frameAt(e)＝[経路割合u(0..1), 視野幅w]
	if (d1 < 1e-6 * Math.max(w0, w1)) {   // ほぼ真上＝指数ズームのみ
		S = Math.abs(Math.log(w1 / w0)) / rho;
		frameAt = e => [e, w0 * Math.pow(w1 / w0, e)];
	} else {
		const c0 = (w1 * w1 - w0 * w0 + rho4 * d2) / (2 * w0 * rho2 * d1);
		const c1 = (w1 * w1 - w0 * w0 - rho4 * d2) / (2 * w1 * rho2 * d1);
		const r0 = Math.log(Math.sqrt(c0 * c0 + 1) - c0), r1 = Math.log(Math.sqrt(c1 * c1 + 1) - c1);
		const ch0 = Math.cosh(r0), sh0 = Math.sinh(r0);
		S = (r1 - r0) / rho;
		frameAt = e => {
			const s = e * S;
			return [w0 / (rho2 * d1) * (ch0 * Math.tanh(rho * s + r0) - sh0), w0 * ch0 / Math.cosh(rho * s + r0)];
		};
	}
	const cruiseMs = Math.max(800, Math.min(4200, S * 330));            // d3既定(≈250ms/単位)より一拍ゆったり・寄りは少し遅め（トランジションが見せ場）
	const riseMs = (p1 < 0.01 && Math.abs(b1) < 0.01) ? 0 : 700;        // ③起こしながら向ける（省略時は北のまま＝無し）
	// 巡航中のズーム下限＝経路の行き過ぎ防止（van Wijkの弧が地球を米粒にしない）。ただし目標がz2未満
	// （星空劇場の深部等）の時はそこまで降りる＝下限は min(2, 目標z)。従来の一律2は着地も2で頭打ちだった。
	// 出発zも下限に加える（2026-08-21）：太陽系圏(z<2)からの帰り＝目標z≥2だと旧式は床2＝巡航全区間が
	// クランプされ「初手でz2へテレポート→着地でスナップ」の壊れたズームインになっていた（z-17→z6実測）。
	// 出発z≥2の通常飛行では min(2,z0,z1)=min(2,z1)＝従来と同値＝挙動不変。
	const zFloor = Math.min(2, z0, zoom);
	const land = flatMs + cruiseMs, dur = land + riseMs;
	const at = (t: number): FlightTarget => {
		t = Math.max(0, Math.min(t, dur));
		if (t < flatMs) {   // ①水平へ（smoothstep）
			const e = ss(t / 500);
			return { lon: lon0, lat: lat0, zoom: z0, pitch: P0 * (1 - e), bearing: B0 * (1 - e) };
		}
		if (t <= land) {   // ②巡航はlinear（van Wijk経路自体が緩急を持つ。smoothstepを重ねると速度が暴れる）
			const [u, w] = frameAt(Math.min(1, (t - flatMs) / cruiseMs));
			return { lon: lon0 + dLon * u, lat: lat0 + dLat * u, zoom: Math.max(zFloor, zOf(w)), pitch: flatMs ? 0 : P0, bearing: flatMs ? 0 : B0 };
		}
		const e = ss(Math.min(1, (t - land) / 700));   // ③起こしながら向ける
		return { lon: lon0 + dLon, lat: lat, zoom, pitch: p1 * e, bearing: b1 * e };
	};
	return { dur, land, at };
}

// 近距離滑走（glide）＝「シーン内の動き」用の第二の振り付け：三段（起きる→飛ぶ→倒す）を使わず、
// 緯度経度(+ズーム)→方位→チルト の順に時分割で滑る。動きが一つずつ読める＝画になる
// （引き・回り込み・立ち上がり。チルトが最後＝建物が立ち上がるのがフィナーレ）。
// 経路は equirect 直線＝球面最適経路ではない：近距離（同じ街・隣街）専用。シーンチェンジは従来どおり fly。
// 省略チャンネルは現状維持でなく目的値へ（tiltDeg/bearingDeg 未指定＝0＝起こして北へ。共有URLの意味論と同じ）。
export function glidePlan(cam0: FlightTarget, env: FlightEnv, lon: number, lat: number, zoom: number, tiltDeg?: number | null, bearingDeg?: number | null): FlightPlan {
	const { viewW, maxPitch, minZoom = 0 } = env;
	zoom = Math.max(minZoom, zoom);   // 同上（glide は cam 直書き＝ここで守らないと床を素通りする）
	const lon0 = cam0.lon, lat0 = cam0.lat, z0 = cam0.zoom;
	let dLon = lon - lon0; dLon -= Math.round(dLon / 360) * 360;   // 最短経路（antimeridian 安全側）
	const dLat = lat - lat0, dZ = zoom - z0, dist = Math.hypot(dLon, dLat);
	const B0 = shortBearingOf(cam0.bearing), dB = shortBearingOf((bearingDeg || 0) * D2R - B0);
	const P0 = cam0.pitch, p1 = Math.min(maxPitch, (tiltDeg || 0) * D2R), dP = p1 - P0;
	const w0 = 360 * viewW / (WORLD_PX * Math.pow(2, Math.max(z0, zoom)));   // 寄った側の視野幅[deg]＝移動の体感尺
	const phases: { ms: number; ch: "move" | "bearing" | "pitch" }[] = [];   // 各チャンネルの尺＝変化量に比例（変化ゼロのチャンネルは飛ばす）
	if (dist > 1e-7 || Math.abs(dZ) > 0.001) phases.push({ ms: Math.max(800, Math.min(4000, dist / w0 * 700 + Math.abs(dZ) * 350)), ch: "move" });
	if (Math.abs(dB) > 0.01) phases.push({ ms: Math.max(500, Math.min(2600, Math.abs(dB) / D2R * 14)), ch: "bearing" });
	if (Math.abs(dP) > 0.01) phases.push({ ms: Math.max(500, Math.min(1600, Math.abs(dP) / D2R * 16)), ch: "pitch" });
	const dur = phases.reduce((a, p) => a + p.ms, 0);
	const at = (t: number): FlightTarget => {
		t = Math.max(0, Math.min(t, dur));
		const c: FlightTarget = { lon: lon0, lat: lat0, zoom: z0, pitch: P0, bearing: B0 };
		let t0 = 0;
		for (const p of phases) {   // 時分割＝手前のチャンネルは完了値・先のチャンネルは初期値のまま
			const e = ss(Math.max(0, Math.min(1, (t - t0) / p.ms))); t0 += p.ms;
			if (p.ch === "move") { c.lon = lon0 + dLon * e; c.lat = lat0 + dLat * e; c.zoom = z0 + dZ * e; }
			else if (p.ch === "bearing") c.bearing = B0 + dB * e;
			else c.pitch = P0 + dP * e;
		}
		return c;
	};
	return { dur, land: dur, at };   // 滑走完了＝着地扱い（autoMesh 解禁）
}

// 同時補間（easeTo）＝MapLibre の easeTo と同じ意味論：経緯度・ズーム・方位・チルトを一本の緩急で同時に動かす（#35・2026-09-23）。
// fly（三段振り付け）/ glide（時分割）と違い「今の姿勢のまま滑る」＝UI 操作の追従・小さな寄せ直し用。
// target＝{ lon, lat, zoom, pitch, bearing, roll }（角はラジアン＝cam と同じ・省略=現状維持）・duration[ms]（既定 500・0 以下＝即着地）。
// 経度は最短側（antimeridian 安全）・方位は最短回転。ズームは線形（近距離前提＝van Wijk は fly の役目）。
export function easePlan(cam0: FlightTarget, env: FlightEnv, target: Partial<FlightTarget> = {}, duration = 500, easing: (t: number) => number = ss): FlightPlan {   // easing＝時間の緩急（既定 smoothstep・MapLibre の口は ML_EASING か例の easing）
	const { maxPitch, minZoom = 0 } = env;
	const lon0 = cam0.lon, lat0 = cam0.lat, z0 = cam0.zoom, P0 = cam0.pitch, B0 = shortBearingOf(cam0.bearing);
	let dLon = (target.lon ?? lon0) - lon0; dLon -= Math.round(dLon / 360) * 360;
	const dLat = (target.lat ?? lat0) - lat0;
	const dZ = Math.max(minZoom, target.zoom ?? z0) - z0;
	const dP = Math.max(0, Math.min(maxPitch, target.pitch ?? P0)) - P0;
	const dB = target.bearing == null ? 0 : shortBearingOf(target.bearing - B0);
	const R0 = cam0.roll || 0, dR = target.roll == null ? 0 : shortBearingOf(target.roll - R0);   // roll（MapLibre 6.x の easeTo の roll・最短回転）
	const dur = Math.max(0, duration);
	const at = (t: number): FlightTarget => {
		const e = dur > 0 ? easing(Math.max(0, Math.min(1, t / dur))) : 1;
		return { lon: lon0 + dLon * e, lat: lat0 + dLat * e, zoom: z0 + dZ * e, pitch: P0 + dP * e, bearing: B0 + dB * e, roll: R0 + dR * e };
	};
	return { dur, land: dur, at };
}

// MapLibre の flyTo（6.11.2 の camera.ts の flyTo と mercator の handleFlyTo をそのまま）＝MapLibre の口（src/maplibre/）の地図だけが使う（env の外の o.dz＝エンジン z − MapLibre z）。
// fly（三段の振り付け）と違い、方位・チルト・roll は全行程で同時に補間し、尺は MapLibre の式（1000·S／speed・既定 speed 1.2・curve 1.42）・時間の緩急は easing（既定＝MapLibre の defaultEasing）。
// 経路は van Wijk & Nuij（ρ＝curve・ただし最小ズームの幅で頭打ち）をメルカトルの画素（512px の世界・出発の z）で解く。経緯度はメルカトルで補間＝MapLibre と同じ道筋。
// 例 add-live-realtime-data（flyTo speed 0.5）・撮る時刻のカメラが MapLibre と同じ所に来る。
export interface MLFlyOptions { speed?: number; curve?: number; screenSpeed?: number; duration?: number; maxDuration?: number; minZoom?: number; easing?: (t: number) => number;
	/** エンジン z − MapLibre z */ dz?: number; /** 画面の幅と高さの大きい方（CSS px）＝MapLibre の w0 */ viewMax?: number; /** 画面の高さ（CSS px）＝メルカトルの最小ズーム（世界が画面を満たす z） */ viewH?: number }
// MapLibre の UnitBezier（@mapbox/unitbezier）＝defaultEasing は bezier(0.25, 0.1, 0.25, 1)
export function bezierEasing(p1x: number, p1y: number, p2x: number, p2y: number): (t: number) => number {
	const cx = 3 * p1x, bx = 3 * (p2x - p1x) - cx, ax = 1 - cx - bx, cy = 3 * p1y, by = 3 * (p2y - p1y) - cy, ay = 1 - cy - by;
	const sx = (t: number) => ((ax * t + bx) * t + cx) * t, sy = (t: number) => ((ay * t + by) * t + cy) * t, dx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
	const solve = (x: number): number => {
		let t = x;
		for (let i = 0; i < 8; i++) { const e = sx(t) - x; if (Math.abs(e) < 1e-6) return t; const d = dx(t); if (Math.abs(d) < 1e-6) break; t -= e / d; }
		let lo = 0, hi = 1; t = x;
		while (lo < hi) { const v = sx(t); if (Math.abs(v - x) < 1e-6) return t; if (x > v) lo = t; else hi = t; t = (hi - lo) * 0.5 + lo; if (hi - lo < 1e-7) break; }
		return t;
	};
	return (t: number) => t <= 0 ? 0 : t >= 1 ? 1 : sy(solve(t));
}
export const ML_EASING = bezierEasing(0.25, 0.1, 0.25, 1);
const mercXY = (lon: number, lat: number): [number, number] => { const la = Math.max(-85.051129, Math.min(85.051129, lat)) * D2R; return [(lon + 180) / 360, (1 - Math.log(Math.tan(Math.PI / 4 + la / 2)) / Math.PI) / 2]; };
const lonLatOfMerc = (x: number, y: number): [number, number] => [x * 360 - 180, 360 / Math.PI * Math.atan(Math.exp((1 - 2 * y) * Math.PI)) - 90];
export function mlFlyPlan(cam0: FlightTarget, env: FlightEnv, target: Partial<FlightTarget>, o: MLFlyOptions = {}): FlightPlan {
	const { maxPitch, minZoom = 0, viewW } = env;
	const easing = o.easing ?? ML_EASING, dz = o.dz ?? 1, w0 = Math.max(1, o.viewMax ?? viewW);
	const z0 = cam0.zoom, z1 = Math.max(minZoom, target.zoom ?? z0);
	const P0 = cam0.pitch, P1 = Math.max(0, Math.min(maxPitch, target.pitch ?? P0));
	const B0 = cam0.bearing, B1 = target.bearing == null ? B0 : B0 + shortBearingOf(target.bearing - B0);
	const R0 = cam0.roll || 0, R1 = target.roll == null ? R0 : R0 + shortBearingOf(target.roll - R0);
	let lon1 = target.lon ?? cam0.lon; lon1 = cam0.lon + (lon1 - cam0.lon) - Math.round((lon1 - cam0.lon) / 360) * 360;   // 最短側（MapLibre の normalizeCenter）
	const [x0, y0] = mercXY(cam0.lon, cam0.lat), y1 = mercXY(lon1, target.lat ?? cam0.lat)[1], x1 = x0 + (lon1 - cam0.lon) / 360;   // x は最短側のまま（±180 を跨いでも連続）
	const ws0 = 512 * 2 ** (z0 - dz), dX = (x1 - x0) * ws0, dY = (y1 - y0) * ws0, u1 = Math.hypot(dX, dY);
	const scaleOfZoom = 2 ** (z1 - z0);
	const zMinML = Math.max(Math.min(Math.max(o.minZoom ?? -2, -2), z0 - dz, z1 - dz), o.viewH ? Math.log2(o.viewH / 512) : -Infinity);   // MapLibre の handleFlyTo の最小ズーム（メルカトルの制約＝世界が画面の高さを満たす z）
	const scaleOfMinZoom = 2 ** (zMinML + dz - z0);
	const w1 = w0 / scaleOfZoom, wMax = w0 / scaleOfMinZoom;
	let rho = Math.min(o.curve ?? 1.42, Math.sqrt(wMax / u1 * 2));
	if (!Number.isFinite(rho)) rho = o.curve ?? 1.42;
	const rho2 = rho * rho;
	const zoomOutFactor = (descent: boolean): number => { const b = (w1 * w1 - w0 * w0 + (descent ? -1 : 1) * rho2 * rho2 * u1 * u1) / (2 * (descent ? w1 : w0) * rho2 * u1); return Math.log(Math.sqrt(b * b + 1) - b); };
	const r0 = zoomOutFactor(false);
	let w = (s: number): number => Math.cosh(r0) / Math.cosh(r0 + rho * s);
	let u = (s: number): number => w0 * ((Math.cosh(r0) * Math.tanh(r0 + rho * s) - Math.sinh(r0)) / rho2) / u1;
	let S = (zoomOutFactor(true) - r0) / rho;
	if (Math.abs(u1) < 2e-6 || !Number.isFinite(S)) {
		if (Math.abs(w0 - w1) < 1e-6) {   // 動かない＝MapLibre は easeTo（既定 500ms・同じ緩急）
			const e = easePlan(cam0, env, { lon: lon1, lat: target.lat ?? cam0.lat, zoom: z1, pitch: P1, bearing: B1, roll: R1 }, o.duration ?? 500);
			return { dur: e.dur, land: e.dur, at: t => { const k = e.dur > 0 ? easing(Math.max(0, Math.min(1, t / e.dur))) : 1; return { lon: cam0.lon + (lon1 - cam0.lon) * k, lat: cam0.lat + ((target.lat ?? cam0.lat) - cam0.lat) * k, zoom: z0 + (z1 - z0) * k, pitch: P0 + (P1 - P0) * k, bearing: B0 + (B1 - B0) * k, roll: R0 + (R1 - R0) * k }; } };
		}
		const kk = w1 < w0 ? -1 : 1;
		S = Math.abs(Math.log(w1 / w0)) / rho;
		u = () => 0;
		w = s => Math.exp(kk * rho * s);
	}
	let dur: number;
	if (o.duration != null) dur = +o.duration;
	else { const V = o.screenSpeed != null ? +o.screenSpeed / rho : +(o.speed ?? 1.2); dur = 1000 * S / V; }
	if (o.maxDuration && dur > o.maxDuration) dur = 0;
	dur = Math.max(0, dur);
	const at = (t: number): FlightTarget => {
		const k = dur > 0 ? easing(Math.max(0, Math.min(1, t / dur))) : 1;
		if (k >= 1) return { lon: lon1, lat: target.lat ?? cam0.lat, zoom: z1, pitch: P1, bearing: B1, roll: R1 };
		const s = k * S, f = u(s), [lon, lat] = lonLatOfMerc(x0 + (x1 - x0) * f, y0 + (y1 - y0) * f);
		return { lon, lat, zoom: Math.max(minZoom, z0 + Math.log2(1 / w(s))), pitch: P0 + (P1 - P0) * k, bearing: B0 + (B1 - B0) * k, roll: R0 + (R1 - R0) * k };
	};
	return { dur, land: dur, at };
}

// 連続ドリー（glidePath）＝via 通過点の列を1本の centripetal Catmull-Rom で通す（例：隅田川に沿ってカメラを流す）。
// pts＝[{lon,lat,zoom,pitch,bearing,secs?}]（pitch/bearing はラジアン＝cam と同じ単位）。cam0 を先頭制御点に足して滑らかに入る。
// 経緯度は曲線（通過保証・オーバーシュートなし＝centripetal α=0.5・端は反射ファントムで係数破綻を回避）、zoom/pitch/bearing は各区間を線形。
// secs＝「その点に到達するまで」の区間尺[秒]（pts[0].secs＝現カメラ→最初の点）。省略区間は経路長比例の自動尺
// ＝区間ごとに緩急が書ける（ランドマーク前だけゆっくり等・台本キーは travel）。全体に ease in/out。
// knots＝各点の実到達時刻[ms]（全体 ease の時間歪みを逆算済み＝スクラブUIの目盛り用）。
export function glidePathPlan(cam0: FlightTarget, env: FlightEnv, pts: PathPoint[]): FlightPlan | null {
	if (!Array.isArray(pts) || pts.length < 1) return null;
	if (pts.length === 1 && !pts[0].secs) return glidePlan(cam0, env, pts[0].lon, pts[0].lat, pts[0].zoom, (pts[0].pitch || 0) / D2R, (pts[0].bearing || 0) / D2R);   // 1点・尺なし＝ただの滑走（時分割）。尺あり＝1区間のスプライン（尺どおり同時補間）
	const { viewW, maxPitch, minZoom = 0 } = env;
	// 制御点＝[cam0, ...pts]。経度は前点基準で連続化（antimeridian/360跳び回避）、方位も最短側で連続化。
	const ctrl: FlightTarget[] = [{ lon: cam0.lon, lat: cam0.lat, zoom: cam0.zoom, pitch: cam0.pitch, bearing: shortBearingOf(cam0.bearing) }];
	for (const p of pts) {
		const prev = ctrl[ctrl.length - 1];
		let lon = p.lon; lon -= Math.round((lon - prev.lon) / 360) * 360;
		ctrl.push({ lon, lat: p.lat, zoom: p.zoom, pitch: Math.min(maxPitch, p.pitch || 0), bearing: prev.bearing + shortBearingOf((p.bearing || 0) - prev.bearing) });
	}
	const n = ctrl.length;
	// 端の反射ファントム（端で制御点が重なり centripetal のノット間隔が 0 になる係数破綻を避ける）
	const gp = (j: number): { lon: number; lat: number } => j < 0 ? { lon: 2 * ctrl[0].lon - ctrl[1].lon, lat: 2 * ctrl[0].lat - ctrl[1].lat }
		: j > n - 1 ? { lon: 2 * ctrl[n - 1].lon - ctrl[n - 2].lon, lat: 2 * ctrl[n - 1].lat - ctrl[n - 2].lat } : ctrl[j];
	// centripetal Catmull-Rom（Barry–Goldman の再帰形）でスカラ key を param tt（∈[t1,t2]）で評価
	const cr = (P: { lon: number; lat: number }[], t: number[], tt: number, key: "lon" | "lat"): number => {
		const g = (a: number, b: number, ta: number, tb: number): number => ((tb - tt) * P[a][key] + (tt - ta) * P[b][key]) / ((tb - ta) || 1e-9);
		const A1 = g(0, 1, t[0], t[1]), A2 = g(1, 2, t[1], t[2]), A3 = g(2, 3, t[2], t[3]);
		const B1 = ((t[2] - tt) * A1 + (tt - t[0]) * A2) / ((t[2] - t[0]) || 1e-9);
		const B2 = ((t[3] - tt) * A2 + (tt - t[1]) * A3) / ((t[3] - t[1]) || 1e-9);
		return ((t[2] - tt) * B1 + (tt - t[1]) * B2) / ((t[2] - t[1]) || 1e-9);
	};
	const posSeg = (i: number, lt: number): FlightTarget => {   // 区間 i（ctrl[i]→ctrl[i+1]）の局所位置 lt∈[0,1] を評価
		const P = [gp(i - 1), gp(i), gp(i + 1), gp(i + 2)];
		const t = [0, 0, 0, 0];
		for (let k = 1; k < 4; k++) { const d = Math.hypot(P[k].lon - P[k - 1].lon, P[k].lat - P[k - 1].lat); t[k] = t[k - 1] + Math.sqrt(Math.max(d, 1e-9)); }
		const tt = t[1] + (t[2] - t[1]) * lt, a = ctrl[i], b = ctrl[i + 1];
		return { lon: cr(P, t, tt, "lon"), lat: cr(P, t, tt, "lat"), zoom: a.zoom + (b.zoom - a.zoom) * lt, pitch: a.pitch + (b.pitch - a.pitch) * lt, bearing: a.bearing + (b.bearing - a.bearing) * lt };
	};
	// 区間尺→時間ノット：secs 指定はそのまま・無指定は経路長を寄った側の視野幅で割った体感尺（下限300ms）。
	// 全区間が無指定なら総尺を従来レンジ[1.5s,16s]に一様スケールでクランプ（旧挙動の体感を維持）。
	const w0 = 360 * viewW / (WORLD_PX * Math.pow(2, Math.max(...ctrl.map(c => c.zoom))));
	let segMs = pts.map((p, j) => p.secs ? p.secs * 1000 : Math.max(300, Math.hypot(ctrl[j + 1].lon - ctrl[j].lon, ctrl[j + 1].lat - ctrl[j].lat) / w0 * 650));
	if (!pts.some(p => p.secs)) { const tot = segMs.reduce((a, b) => a + b, 0), f = Math.max(1500, Math.min(16000, tot)) / tot; segMs = segMs.map(m => m * f); }
	const T = [0]; for (const m of segMs) T.push(T[T.length - 1] + m);
	const dur = T[n - 1];
	const at = (t: number): FlightTarget => {
		t = Math.max(0, Math.min(t, dur));
		const e = ss(t / dur), tt = e * dur;   // 全体 ease＝出入りだけ滑らか・道中は書いた区間尺どおり
		let i = 0; while (i < n - 2 && tt > T[i + 1]) i++;
		const c = posSeg(i, Math.min(1, (tt - T[i]) / ((T[i + 1] - T[i]) || 1e-9)));
		return { lon: c.lon, lat: c.lat, zoom: Math.max(minZoom, c.zoom), pitch: c.pitch, bearing: c.bearing };
	};
	// 実到達時刻＝全体 ease の逆関数（smoothstep は単調＝二分法で十分）：ss(k)=T[j]/dur → k*dur
	const kInv = (y: number): number => { let lo = 0, hi = 1; for (let j = 0; j < 24; j++) { const m = (lo + hi) / 2; if (ss(m) < y) lo = m; else hi = m; } return (lo + hi) / 2; };
	return { dur, land: dur, at, knots: pts.map((_, j) => kInv(T[j + 1] / dur) * dur) };   // 走破＝着地扱い（autoMesh 解禁）
}

/** createFlight の引数 */
export interface CreateFlightOptions {
	cam: CameraPose; viewW: () => number; maxPitch: number; minZoom?: number; onMove: () => void; onFlying?: (on: boolean) => void;
	/** 飛行の時計（C10・map.setNow で止められる＝決定論の撮影） */
	now?: () => number;
	/** 1 フレームの刻みの上限（止めた時計では無限＝呼び手が決める） */
	stepMax?: () => number;
}
/** createFlight の戻り */
export interface FlightController {
	flyTo(lon: number, lat: number, zoom: number, tiltDeg?: number | null, bearingDeg?: number | null): Promise<void>;
	glideTo(lon: number, lat: number, zoom: number, tiltDeg?: number | null, bearingDeg?: number | null): Promise<void>;
	glidePath(pts: PathPoint[]): Promise<void>;
	easeTo(target?: Partial<FlightTarget>, duration?: number, easing?: (t: number) => number): Promise<void>;
	/** MapLibre の flyTo（mlFlyPlan） */
	flyML(target: Partial<FlightTarget>, o?: MLFlyOptions): Promise<void>;
	cancel(): void;
	readonly active: boolean;
	setMaxPitch(v: number): void;
	setMinZoom(v: number): void;
	plan: {
		fly(cam0: FlightTarget | null | undefined, lon: number, lat: number, zoom: number, tiltDeg?: number | null, bearingDeg?: number | null): FlightPlan;
		glide(cam0: FlightTarget | null | undefined, lon: number, lat: number, zoom: number, tiltDeg?: number | null, bearingDeg?: number | null): FlightPlan;
		path(cam0: FlightTarget | null | undefined, pts: PathPoint[]): FlightPlan | null;
		ease(cam0: FlightTarget | null | undefined, target?: Partial<FlightTarget>, duration?: number): FlightPlan;
	};
}

// createFlight({ cam, viewW, maxPitch, minZoom, onMove, onFlying }) →
//   { flyTo, glideTo, glidePath, easeTo, cancel(), active, plan:{fly,glide,path,ease} }
//   cam＝{center,zoom,pitch,bearing} を直接書く（描画は onMove が飛ばす）。viewW()＝視野幅px（van Wijk の尺）。
//   plan.*＝時刻評価プランを「今の env（視野幅等）」で構築する口（cam0 省略=現カメラ）＝スクラブ（map.sceneTimeline）の材料。
const STEP_MAX_MS = 35;   // 1 フレームの刻みの上限（ms）＝低 fps では「大股に飛ぶ」でなく「ゆっくり滑る」（createFlight の注を参照）
export function createFlight({ cam, viewW, maxPitch, minZoom = 0, onMove, onFlying = () => {}, now = () => performance.now(), stepMax = () => STEP_MAX_MS }: CreateFlightOptions): FlightController {   // now＝飛行の時計（C10・map.setNow で止められる＝決定論の撮影）・stepMax＝1 フレームの刻みの上限（止めた時計では無限＝呼び手が決める）
	let flight: { cancel: () => void } | null = null;
	const snap = (): FlightTarget => ({ lon: cam.center[0], lat: cam.center[1], zoom: cam.zoom, pitch: cam.pitch!, bearing: cam.bearing!, roll: cam.roll || 0 });
	let maxPitchCur = maxPitch, minZoomCur = minZoom;   // 実行時に変えられる（app の setMaxPitch/setZoomMin＝飛行の着地も上限/床に従う）
	const env = (): FlightEnv => ({ viewW: viewW(), maxPitch: maxPitchCur, minZoom: minZoomCur });
	// プランをなぞる唯一のループ。着地(land)は「その次の onMove から」重い自動ロード解禁＝旧 tween 連鎖と同じ拍。
	// 時計＝刻み上限つき仮想時計（裁定 2026-08-12「非力端末は連続に滑るを優先」）：1フレームで STEP_MAX_MS までしか
	// 時を進めない＝低fps（重い都市を描くドリー等）では「大股に飛ぶ」でなく「ゆっくり滑る」（尺は伸びる側に倒す）。
	// ≈29fps以上なら dt<上限＝実時間と完全一致＝録画（desktop・pinRes）もエディタの再生ヘッド（行頭で再同期）も実尺のまま。
	// 35ms＝30Hz外部モニタ（dt≈33ms・tuneRes実測の恒常値）を素通しする下限。50→35（2026-08-12 実機「あまり変わらない」を受け一段強く）
	// 戻り値＝着地（または cancel）で解決する Promise（2026-09-11・SDK ドッグフード「flyTo の完了を知る方法がない」）。中止も resolve（reject しない）
	function run(plan: FlightPlan | null): Promise<void> {
		if (flight) flight.cancel();
		let cancelled = false, done!: () => void;
		const settled = new Promise<void>(res => { done = res; });
		flight = { cancel: () => { cancelled = true; onFlying(false); flight = null; done(); } };
		onFlying(true);
		if (!plan || !(plan.dur > 0)) { onFlying(false); flight = null; done(); return settled; }   // 変化なし（glide の全チャンネル一致等）＝即着地扱い
		let landed = false;
		let t = 0, last = now();
		const step = (): void => {
			if (cancelled) return;
			const tn = now();
			t = Math.min(t + Math.min(tn - last, stepMax()), plan.dur); last = tn;
			const c = plan.at(t);
			cam.center = [c.lon, c.lat]; cam.zoom = c.zoom; cam.pitch = c.pitch; cam.bearing = c.bearing; if (c.roll != null) cam.roll = c.roll;   // roll＝プランが持つ時だけ（easeTo）。fly/glide は今の値のまま
			onMove();
			if (t < plan.dur) {
				if (!landed && t >= plan.land) { landed = true; onFlying(false); }   // ③着地＝重い自動ロード解禁（次の onMove から動く。起こしはこの後）
				requestAnimationFrame(step);
			} else { if (!landed) onFlying(false); flight = null; onMove(); done(); }
		};
		requestAnimationFrame(step);
		return settled;
	}
	function flyTo(lon: number, lat: number, zoom: number, tiltDeg?: number | null, bearingDeg?: number | null): Promise<void> { return run(flyPlan(snap(), env(), lon, lat, zoom, tiltDeg, bearingDeg)); }
	function glideTo(lon: number, lat: number, zoom: number, tiltDeg?: number | null, bearingDeg?: number | null): Promise<void> { return run(glidePlan(snap(), env(), lon, lat, zoom, tiltDeg, bearingDeg)); }
	function flyML(target: Partial<FlightTarget>, o?: MLFlyOptions): Promise<void> { const p = mlFlyPlan(snap(), env(), target, o); if (!(p.dur > 0)) { const c = p.at(1); if (flight) flight.cancel(); cam.center = [c.lon, c.lat]; cam.zoom = c.zoom; cam.pitch = c.pitch; cam.bearing = c.bearing; if (c.roll != null) cam.roll = c.roll; onMove(); return Promise.resolve(); } return run(p); }   // 尺 0（maxDuration 越え・duration:0）＝即着地
	function easeTo(target?: Partial<FlightTarget>, duration?: number, easing?: (t: number) => number): Promise<void> { const p = easePlan(snap(), env(), target, duration, easing); if (!(p.dur > 0)) { const c = p.at(0); if (flight) flight.cancel(); cam.center = [c.lon, c.lat]; cam.zoom = c.zoom; cam.pitch = c.pitch; cam.bearing = c.bearing; if (c.roll != null) cam.roll = c.roll; onMove(); return Promise.resolve(); } return run(p); }   // duration 0＝即着地（jumpTo と同じ）
	function glidePath(pts: PathPoint[]): Promise<void> { return (Array.isArray(pts) && pts.length >= 1) ? run(glidePathPlan(snap(), env(), pts)) : Promise.resolve(); }
	return { flyTo, glideTo, glidePath, easeTo, flyML, cancel: () => { if (flight) flight.cancel(); }, get active() { return !!flight; }, setMaxPitch: v => { maxPitchCur = v; }, setMinZoom: v => { minZoomCur = v; },
		plan: {
			fly: (cam0, lon, lat, zoom, tiltDeg, bearingDeg) => flyPlan(cam0 ?? snap(), env(), lon, lat, zoom, tiltDeg, bearingDeg),
			glide: (cam0, lon, lat, zoom, tiltDeg, bearingDeg) => glidePlan(cam0 ?? snap(), env(), lon, lat, zoom, tiltDeg, bearingDeg),
			path: (cam0, pts) => glidePathPlan(cam0 ?? snap(), env(), pts),
			ease: (cam0, target, duration) => easePlan(cam0 ?? snap(), env(), target, duration),
		} };
}
