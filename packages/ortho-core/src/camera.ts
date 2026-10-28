// 透視カメラ（チルト対応）。単位球ワールドで、対象地点(center)を注視する軌道カメラ。
// pitch=0 で真上（従来の真俯瞰）、pitch>0 で地平へ傾く。bearing で方位回転。
// この地図は常に地球儀＝平面メルカトルの変換は無い。z の目盛りは 256px 世界（WORLD_PX）＝MapLibre の z＋1。
import * as mat from "./mat.ts";
const D2R = Math.PI / 180, R2D = 180 / Math.PI;

/** 経緯度（度）。[lon, lat] */
export type LonLat = [number, number];
/** β 単位球（楕円体 off では単位球）上の 3D 点 */
export type Vec3 = [number, number, number] | number[];

/** カメラの生の状態（`map.cam`）。角はラジアン。 */
export interface CameraPose {
	center: LonLat;
	/** エンジンの z（256px 世界）。 */
	zoom: number;
	/** チルト［rad］。0＝真上。 */
	pitch?: number;
	/** 方位［rad］。0＝北が上。 */
	bearing?: number;
	/** 視線まわりの回転［rad］（MapLibre の roll・正＝絵が時計回り・無指定＝0）。 */
	roll?: number;
	/** 縦の視野角［rad］。既定 50°。 */
	fovy?: number;
	dpr?: number;
	/** 注視点の高さ［m］（MapLibre の centerClampedToGround 相当・無指定＝0）。 */
	centerAlt?: number;
	/** 注視点を画面の中心からずらす量［CSS px・右・下が正］＝MapLibre の centerOffset（padding の中身の中心）。消失点も動く。無指定＝[0,0]。 */
	offset?: [number, number];
	/** near 面の上限［m］（無指定＝従来＝注視距離の 3〜30%）。注視点より手前に描く物がある時（Cesium の frustum.near＝1 m・目標点が楕円体で 3D Tiles の地面の下）に下げる。深度は対数なので far との比は問わない */
	near?: number;
}

/** 視線の基底（viewRays の戻り） */
export interface ViewRays { F: number[]; X: number[]; Y: number[] }

/** cameraState の戻り＝1 フレームの行列と派生量。mvp/invMvp は列優先 f64。 */
export interface CameraState {
	mvp: Float64Array;
	invMvp: Float64Array | null;
	/** カメラ位置（β 空間）。 */
	eye: number[];
	W: number;
	H: number;
	dpr: number;
	/** 注視点からカメラまでの距離（単位球のラジアン≈弧長）。 */
	camDist: number;
	/** 焦点距離（device px）。 */
	focal: number;
	/** 透視行列だけ（clip.x の反転込み）。MapLibre custom 層の projectionMatrix 相当。 */
	projection: Float64Array;
	/** 視線の基底の覚え書き（sphereRayUniforms が 1 フレームに 1 度だけ作る） */
	rays?: ViewRays;
}

/** sphereRayUniforms の戻り（origin を渡すと錨 O・rho・beta0・EO・ll も付く） */
export interface SphereRayUniforms {
	F: number[]; X: number[]; Y: number[]; E: number[]; c: number;
	O?: number[]; rho?: number; beta0?: number; EO?: number[]; ll?: [number, number];
}

// z の目盛り＝256px 世界（赤道一周 = 2^z × 256 CSSpx）。v1(d3-geo)・地理院地図・OSM と同一目盛り。
// 旧実装は 512px 世界（MapLibre 流）＝同じ視野で z が1小さく、v1 移植の gint 式（256px 前提）や
// altpbf の DEM 段閾値と1段ズレていた（2026-07-26 に 256 へ統一）。zoom→幾何の変換は必ずこの定数を通す。
export const WORLD_PX = 256;

// ── 楕円体ノブ（?ell=1 実験・2026-08-11 段階B）────────────────────────────────
// 世界＝WGS84楕円体を「β（更成緯度）単位球 × S=diag(1, b/a, 1)」に厳密分解して立てる：
//   P_world = S · u(β),  tanβ = (b/a)·tanφ（φ=測地緯度）。世界単位 = a（長半径）。
// 球面機械（versor回転・limb接線・レイ×球交差・RTE の相殺回避）は全て β 単位球上でそのまま厳密に生きる
// （線形写像 S は接線性を保存）。S は cameraState が mvp へ一度だけ畳む＝下流の式は一切変わらない。
// r=1（球・既定）で全式がビット同値に退化する＝フラグ1本で新旧を往復でき、回帰面がゼロ。
// 各実行文脈（main・render worker・mesh worker）は起動時に setEllipsoid を同値で呼ぶこと（init で搬送）。
let R_AX = 1;   // b/a（球=1）。シェーダ側の dβ 補正は u_ellTrig=(0,…)＝球で厳密0（renderer が配る）
/** WGS84 楕円体で立てる（全実行文脈で同値に呼ぶ）。 */
export function setEllipsoid(on: boolean): void { R_AX = on ? 1 - 1 / 298.257223563 : 1; }
export const ellipsoidOn = (): boolean => R_AX !== 1;
export const ellAxisRatio = (): number => R_AX;   // b/a（球=1）＝world＝S·β の S＝diag(1, b/a, 1)（断面の面を world で作って β へ移す・clip.js）
export const worldRadiusM = (): 6371000 | 6378137 => R_AX === 1 ? 6371000 : 6378137;   // m→世界単位の換算半径（球＝従来値／楕円体＝a）
// 測地緯度 φ ⇄ 更成緯度 β（deg）。閉形式（atan2＝極も厳密）。球では恒等。
/** 測地緯度 → 更成緯度（度）。球では恒等。 */
export const betaOf = (latDeg: number): number => R_AX === 1 ? latDeg
	: Math.atan2(R_AX * Math.sin(latDeg * D2R), Math.cos(latDeg * D2R)) * R2D;
export const geodeticOf = (betaDeg: number): number => R_AX === 1 ? betaDeg
	: Math.atan2(Math.sin(betaDeg * D2R), R_AX * Math.cos(betaDeg * D2R)) * R2D;

// world空間の3D点（S 込み＝楕円体面上の点・S·eye）→ 測地経緯度 [lon,lat]（deg）。S⁻¹（yだけ1/R_AX）で
// β空間へ戻してから geodeticOf で β→測地緯度へ。球(R_AX=1)は恒等。world の y を直に asin すると【地心緯度】
// になり、楕円体では測地緯度と緯度36°で約0.09°（≒10km 南）ずれる。
// ⚠ cameraState().eye は既に S⁻¹ 済み（β空間）＝こちらでなく betaToLonLat を通すこと。β点をここへ入れると
// S⁻¹ が二重に掛かり、緯度が反対側へ同じ量（36°で約+0.09°≒10km 北）ずれる＝updateUnderground の地中フェード
// 誤発動の真因その2（2026-09-21・?ell=1）。8/15 の修正（57a1f19）は地心緯度(−10km)を +10km に裏返しただけで、
// 加賀市は北 10km が日本海(0m)ゆえ「直った」ように見えていた。
export function worldToLonLat(p: ArrayLike<number>): LonLat {
	const yb = p[1] / R_AX;                                       // world → β空間（S⁻¹＝y だけ 1/R_AX）
	const len = Math.hypot(p[0], yb, p[2]) || 1;
	const lat = geodeticOf(Math.asin(Math.max(-1, Math.min(1, yb / len))) * R2D);
	const lon = Math.atan2(p[2], p[0]) * R2D;                     // 経度は S（y方向）に不変
	return [lon, lat];
}

// β単位球空間の3D点（cameraState().eye・invMvp の出口・unproject の交点）→ 測地経緯度 [lon,lat]（deg）。
// asin が返すのは β＝geodeticOf で測地緯度へ復元（unproject と同じ手順）。球では恒等。
// updateUnderground/eyePose が「eye 直下の地表点」を引くための逆変換。β空間では動径が測地法線と ≤f·sin2φ/2
// (≈0.1°) 開くため、eye の動径投影は測地的な直下点から高度×0.0017 だけずれる（高度 600m で約 1m＝
// 地中フェードの帯 20m の内。高度 100km で 170m＝影響する消費者が出たら測地法線の足を反復で解くこと）。
export function betaToLonLat(p: ArrayLike<number>): LonLat {
	const len = Math.hypot(p[0], p[1], p[2]) || 1;
	const lat = geodeticOf(Math.asin(Math.max(-1, Math.min(1, p[1] / len))) * R2D);
	const lon = Math.atan2(p[2], p[0]) * R2D;
	return [lon, lat];
}

// 経緯度 → β単位球3D（球では従来の単位球そのまま＝ビット同値）。
// 消費者（versor・LOD・ラベル・タイル被覆…）は「単位球上の点」として扱い続けてよい＝内部の主空間。
export function lonlatTo3D(lon: number, lat: number): number[] {
	const a = lon * D2R, b = lat * D2R;
	let sb = Math.sin(b), cb = Math.cos(b);
	if (R_AX !== 1) { const w = Math.hypot(cb, R_AX * sb); sb = R_AX * sb / w; cb = cb / w; }
	return [cb * Math.cos(a), sb, cb * Math.sin(a)];
}

// 経緯度 → 点 p（β空間）までの距離（割り当てなし）＝lonlatTo3D と同じ式・同じ順（注記の標高フェード・距離フェード＝毎フレーム数千回）
export function distTo(lon: number, lat: number, p: ArrayLike<number>): number {
	const a = lon * D2R, b = lat * D2R;
	let sb = Math.sin(b), cb = Math.cos(b);
	if (R_AX !== 1) { const w = Math.hypot(cb, R_AX * sb); sb = R_AX * sb / w; cb = cb / w; }
	return Math.hypot(cb * Math.cos(a) - p[0], sb - p[1], cb * Math.sin(a) - p[2]);
}

// 測地法線（楕円体の「上」）の β空間像 m = S⁻¹·n_geo = (cosφcosλ, sinφ/r, cosφsinλ)。
// 標高 h[m] の変位＝world で (h/a)·n_geo ＝ β空間で (h/a)·m（S を通すと単位法線に戻る）。球では m=u(φ)＝動径。
export function ellNormal3D(lon: number, lat: number): number[] {
	const a = lon * D2R, b = lat * D2R, cb = Math.cos(b);
	return [cb * Math.cos(a), Math.sin(b) / R_AX, cb * Math.sin(a)];
}

// カメラ状態を作る。cam: { center:[lon,lat], zoom, pitch(rad), bearing(rad), roll(rad), fovy(rad), dpr, offset:[x,y] }
// roll＝視線（boresight）まわりの回転［rad］（MapLibre の roll と同じ向き＝正で絵が時計回りに回る・2026-10-12 A1）。0＝従来とビット同値
// offset＝注視点（center）を画面の中心からずらす量［CSS px・右・下が正］＝MapLibre の transform.centerOffset（padding の中身の中心）。消失点も一緒に動く
//   （clip 空間の平行移動＝x'＝x＋dx·w）。無指定・[0,0]＝従来とビット同値（2026-10-12 A3）
export function cameraState(cam: CameraPose, W: number, H: number): CameraState {
	const { center, zoom, pitch = 0, bearing = 0, fovy = 50 * D2R, dpr = 1 } = cam;
	const roll = cam.roll || 0;
	const [lon, lat] = center;
	const Tb = lonlatTo3D(lon, lat);                                // β単位球上の注視点
	const T0 = R_AX === 1 ? Tb : [Tb[0], R_AX * Tb[1], Tb[2]];      // world（楕円体面）＝S·u(β)。球では同一
	const a = lon * D2R, b = lat * D2R, cb = Math.cos(b);
	// 面法線＝測地法線（楕円体の「上」＝測地緯度の定義そのもの）。球では従来の動径と同式＝ビット同値。
	const nrm = [cb * Math.cos(a), Math.sin(b), cb * Math.sin(a)];
	// 注視点の高さ cam.centerAlt［m］（無指定＝0＝従来とビット同値）：注視点を測地法線に沿って持ち上げ、そこから camDist だけ離れた所にカメラを置く
	// ＝MapLibre の transform.elevation（centerClampedToGround＝地形の上の中心点からズームを測る・2026-09-30）。ズーム↔距離の式は変えない
	const alt = cam.centerAlt || 0;
	const T = alt ? mat.add(T0, mat.scale(nrm, alt / worldRadiusM())) : T0;
	const north = mat.norm([-Math.sin(b) * Math.cos(a), Math.cos(b), -Math.sin(b) * Math.sin(a)]);
	const east = [-Math.sin(a), 0, Math.cos(a)];
	const fwdH = mat.norm(mat.add(mat.scale(north, Math.cos(bearing)), mat.scale(east, Math.sin(bearing))));
	// zoom → 対象での解像度 → カメラ高さ(camDist, 単位球のラジアン≈弧長)
	// z は正射(orthographic)スケールそのもの＝同一zは緯度によらず同一倍率（v1 d3-geo と同じ定義）。
	// 旧実装は ×cos(lat) のwebメルカトル互換定義＝北へパンするほど膨らむ（那覇→札幌で約26%）違和感の原因だった。
	// メルカトルタイルの緯度分の細かさ補正はタイル選択（tilecover.selectLOD）の仕事＝カメラには漏らさない。
	const radPerDevPx = 2 * Math.PI / (Math.pow(2, zoom) * WORLD_PX * dpr);
	const camDist = radPerDevPx * (H / 2) / Math.tan(fovy / 2);
	// カメラ基底を pitch/bearing から明示構築（退化なし）:
	//   pitch=0 で真上・screen-up=北。pitch>0 で fwdH 方向の地平へ傾く。
	const back = mat.add(mat.scale(nrm, Math.cos(pitch)), mat.scale(fwdH, -Math.sin(pitch)));   // 対象→カメラ
	let upCam = mat.add(mat.scale(nrm, Math.sin(pitch)), mat.scale(fwdH, Math.cos(pitch)));   // 画面上方向
	// roll＝画面上方向を視線軸（back）まわりに回す（Rodrigues・back と upCam は直交・clip.x の鏡像反転の後で正の roll＝絵が時計回り）。roll=0 はこの枝を通らない＝ビット同値
	if (roll) upCam = mat.add(mat.scale(upCam, Math.cos(roll)), mat.scale(mat.cross(upCam, back), Math.sin(roll)));
	// 地形クランプ（eye の押し上げ）は廃止（2026-07-28）：山頂×高チルトで eye が sea-level 軌道ごと山体に
	// 埋まり、eye直下サンプルは下った斜面＝山頂を見ないため効かなかった（富士 z15/75° で裏面を見上げる絵）。
	// 代替＝カメラは一切動かさず、地表より下に潜ったら app が全画面 DOM オーバーレイ(#underground)を暗くする。
	// カメラ数学に触れない＝「妙なブレ」を作らない（cameraState は純関数のまま＝全消費者で整合）。
	const eye = mat.add(T, mat.scale(back, camDist));               // world のカメラ位置（測地法線基底の軌道）
	const view = mat.lookAt(eye, T, upCam);
	const aspect = W / H;
	// near/far を可視範囲（最近点camDist〜地平線limb）にタイトに。極端なオーバーズームでの精度崩壊を防ぐ。
	// 注視点が宙にある（centerAlt）時は目の本当の高さから地平線までを測る（注視点の近くに寄っても、遠景の地球が far で切れない）
	const limb0 = Math.sqrt(Math.max((1 + camDist) * (1 + camDist) - 1, 1e-12)), limb = alt ? Math.max(limb0, Math.sqrt(Math.max(mat.dot(eye, eye) - 1, 1e-12))) : limb0;
	// 傾けるほど近景の足元がカメラに寄るので、near を浅くして下が抜けるのを防ぐ（真俯瞰0.3→急チルト0.03）。
	const pf = Math.min(1, pitch / (60 * D2R));
	const near0 = camDist * (0.3 - 0.27 * pf), nearCap = cam.near! > 0 ? cam.near! / worldRadiusM() : Infinity;   // cam.near［m］＝上限（Cesium の frustum.near・無指定＝従来）
	const near = Math.max(Math.min(near0, nearCap), 1e-7), far = limb * 1.15 + camDist;
	const proj = mat.perspective(fovy, aspect, near, far);
	const mvp = mat.multiply(proj, view);
	// 上空から見ると座標系が鏡像になるため clip.x を反転（東=画面右）。行0を符号反転。
	mvp[0] = -mvp[0]; mvp[4] = -mvp[4]; mvp[8] = -mvp[8]; mvp[12] = -mvp[12];
	// S=diag(1,r,1) を mvp へ畳む（列1×r）＝以降の全消費（project・shader・unproject 逆行列）は
	// β単位球の座標を入れるだけで楕円体に立つ。eye も S⁻¹ で β空間へ＝手前半球判定 dot(u,eye)-1 や
	// limb 接線が球の式のまま厳密（線形写像は接線性を保存）。球（r=1）は無変換＝ビット同値。
	if (R_AX !== 1) {
		mvp[4] *= R_AX; mvp[5] *= R_AX; mvp[6] *= R_AX; mvp[7] *= R_AX;
		eye[1] /= R_AX;
	}
	const focal = (H / 2) / Math.tan(fovy / 2);   // 距離ベースLOD用の焦点距離(device px)
	const projection = Float64Array.from(proj); projection[0] = -projection[0];   // 透視だけ（clip.x の反転込み＝mvp＝projection·view·S）。MapLibre の custom 層の args.projectionMatrix（inv(P)·mainMatrix で視点を取り出す書き方）用（2026-09-30）
	const off = cam.offset;
	if (off && (off[0] || off[1])) {   // 消失点のずらし＝clip の x,y に w の倍を足す（ndc で +dx,+dy）。行 0・1 に行 3 を足す（列優先＝添字 r, 4+r, 8+r, 12+r）
		const dx = 2 * off[0] * dpr / W, dy = -2 * off[1] * dpr / H;
		for (const m of [mvp, projection]) for (let c = 0; c < 4; c++) { m[4 * c] += dx * m[4 * c + 3]; m[4 * c + 1] += dy * m[4 * c + 3]; }
	}
	return { mvp, invMvp: mat.invert(mvp), eye, W, H, dpr, camDist, focal, projection };
}

// 視線の基底（f64・純関数）：v(ndc)＝F＋ndc.x·X＋ndc.y·Y＝目から出る視線。長さは clip w が 1 になる向き（g·v＝1・g＝mvp の w 行）＝
// 目からの相対位置は P＝w·v（w＝clip w＝深度から戻す奥行き）。透視は ndc に対して v がアフィン＝3 点で決まる。mvp/invMvp は列優先（mat.js）。
// invMvp（f32）を GPU で積和すると近平面が浅い高ズームのチルトで視線が画素単位で揺れる（#46 の AO・#65 の球の床）＝CPU の f64 で作って uniform で渡す。
export function viewRays(mvp: ArrayLike<number>, invMvp: ArrayLike<number>): ViewRays {
	const M = invMvp, g = [mvp[3], mvp[7], mvp[11]];
	const un = (x: number, y: number, z: number): number[] => { const o = [0, 1, 2, 3].map(r => M[r] * x + M[4 + r] * y + M[8 + r] * z + M[12 + r]); return [o[0] / o[3], o[1] / o[3], o[2] / o[3]]; };
	const ray = (x: number, y: number): number[] => { const a = un(x, y, 0), b = un(x, y, 1), v = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], k = g[0] * v[0] + g[1] * v[1] + g[2] * v[2]; return v.map(c => c / k); };
	const F = ray(0, 0), X = ray(1, 0), Y = ray(0, 1);
	return { F, X: X.map((c, i) => c - F[i]), Y: Y.map((c, i) => c - F[i]) };
}
// 全画面レイキャスト（球の床・海面下・経緯線・等高線・夜面）の uniform 一式（#65）：基底＋目の位置＋c＝|E|²−1（f64＝2·camDist＋camDist²。
// f32 の |E|² から 1 を引くと桁が落ちる）。球との交点は t＝2c/(−b＋√h)（近い根を桁落ちなしで）＝GPU 側 sphereRay と対
// origin（シーン原点 lon/lat・deg）を渡すと錨も付く：O＝lonlatTo3D(origin)（β単位球の点）・rho＝cos β0・beta0（rad）・EO＝E−O（f64 で引いて f32 へ＝
// 目の原点相対＝小さい）。シェーダは交点を δ＝EO＋t·d（原点相対・f32 で mm 級）で持ち、δ から経緯度の差を桁落ちなしの恒等式で作る（wgsl/glsl の deltaLL）＝
// 絶対の経緯度（f32 で 139° は 1.5e-5°＝1.4 m 刻み）を経ない。uv は anchorUV の (off, 1/span) で off＋δll·inv（頂点パスの cogP/gnd と同じ作法）
export function sphereRayUniforms(st: CameraState, origin?: ArrayLike<number> | null): SphereRayUniforms {
	const r = st.rays ??= viewRays(st.mvp, st.invMvp!), E = st.eye;
	const u: SphereRayUniforms = { F: r.F, X: r.X, Y: r.Y, E, c: E[0] * E[0] + E[1] * E[1] + E[2] * E[2] - 1 };
	if (origin) {
		const O = lonlatTo3D(origin[0], origin[1]), b0 = betaOf(origin[1]) * D2R;
		u.O = O; u.rho = Math.cos(b0); u.beta0 = b0; u.EO = [E[0] - O[0], E[1] - O[1], E[2] - O[2]]; u.ll = [origin[0], origin[1]];
	}
	return u;
}
// 窓（[west, south, spanLon, spanLat]・deg）の uv 係数＝(原点の uv, 1/span)（f64）。uv＝off＋δll·inv。窓なし＝0
export function anchorUV(origin: ArrayLike<number>, win?: ArrayLike<number> | null): number[] { return win ? [(origin[0] - win[0]) / win[2], (origin[1] - win[1]) / win[3], 1 / win[2], 1 / win[3]] : [0, 0, 0, 0]; }

// 経緯度＋動径 → 世界座標（単位球）。標高変位（ラベルを地形に乗せる）：球＝動径倍。楕円体＝測地法線に沿って持ち上げる（動径だと富士級で
// 水平に十数mズレ＝シェーダの地形変位（同じ測地法線）とラベルの足が合わなくなる）。
function liftedPos(u: number[], lon: number, lat: number, radius: number): number[] {
	return radius === 1 ? u
		: R_AX === 1 ? [u[0] * radius, u[1] * radius, u[2] * radius]
		: ((m: number[]) => [u[0] + (radius - 1) * m[0], u[1] + (radius - 1) * m[1], u[2] + (radius - 1) * m[2]])(ellNormal3D(lon, lat));
}
// 経緯度＋動径 → clip 座標 [x, y, z, w]（state.mvp・クランプなし）。w＝目からの奥行き＝シーンの深度（#47）と比べる尺度
export function projectClip(state: CameraState, lon: number, lat: number, radius = 1): number[] {
	const w = liftedPos(lonlatTo3D(lon, lat), lon, lat, radius);
	return mat.transform(state.mvp, [w[0], w[1], w[2], 1]);
}
// 経緯度 → [screenX, screenY(devicePx), front]。front>0 で手前半球かつカメラ前方。
export function project(state: CameraState, lon: number, lat: number, radius = 1): number[] { return projectInto(state, lon, lat, radius, new Array<number>(3)); }
// project の結果を device px → CSS px へ（÷dpr）。写らない点の同次座標（r[3..5]）も運ぶ＝塗りの経路が近平面で切れる（hw は割らない＝比が画面座標）
export function projectCss(r: ArrayLike<number>, dpr: number): [number, number, number] { return (r.length > 5 ? [r[0] / dpr, r[1] / dpr, r[2], r[3] / dpr, r[4] / dpr, r[5]] : [r[0] / dpr, r[1] / dpr, r[2]]) as [number, number, number]; }
// project の割り当てなし版：out[0..2] に書いて out を返す（タイル選抜＝1 update で数千点＝旧 project は 1 点 5 配列）。
// 見える点の経路は lonlatTo3D・liftedPos・mat.transform・mat.dot と同じ式・同じ順＝ビット同値。見えない点（稀）は従来の経路へ
export function projectInto<T extends { [i: number]: number }>(state: CameraState, lon: number, lat: number, radius: number, out: T): T {
	const a = lon * D2R, b = lat * D2R;
	let sb = Math.sin(b), cb = Math.cos(b);
	if (R_AX !== 1) { const w = Math.hypot(cb, R_AX * sb); sb = R_AX * sb / w; cb = cb / w; }
	const u0 = cb * Math.cos(a), u1 = sb, u2 = cb * Math.sin(a);
	let w0 = u0, w1 = u1, w2 = u2;
	if (radius !== 1) {
		if (R_AX === 1) { w0 = u0 * radius; w1 = u1 * radius; w2 = u2 * radius; }
		else { const m = ellNormal3D(lon, lat); w0 = u0 + (radius - 1) * m[0]; w1 = u1 + (radius - 1) * m[1]; w2 = u2 + (radius - 1) * m[2]; }
	}
	const m = state.mvp, E = state.eye;
	const c3 = m[3] * w0 + m[7] * w1 + m[11] * w2 + m[15] * 1;
	const frontHemi = u0 * E[0] + u1 * E[1] + u2 * E[2] - radius;     // >0 手前半球（半径 radius の球の上の点＝持ち上がった地面は海面の地平線の向こうでも映る・旧＝海面球固定＝リフト隅が地平線で捨てられタイル選抜が遠景で止まった 2026-10-27）
	if (c3 <= 1e-6 || frontHemi < 0) {
		const r = projectClamped(state, lon, lat, radius); out[0] = r[0]; out[1] = r[1]; out[2] = r[2];
		if (Array.isArray(out)) { if (r.length > 3) { out[3] = r[3]; out[4] = r[4]; out[5] = r[5]; } else out.length = 3; }   // 写らない点の同次座標（project の新しい配列だけが運ぶ＝作業域の型付き配列は 3 要素のまま）
		return out;
	}
	const c0 = m[0] * w0 + m[4] * w1 + m[8] * w2 + m[12] * 1, c1 = m[1] * w0 + m[5] * w1 + m[9] * w2 + m[13] * 1;
	out[0] = (c0 / c3 * 0.5 + 0.5) * state.W;
	out[1] = (1 - (c1 / c3 * 0.5 + 0.5)) * state.H;
	out[2] = frontHemi;
	return out;
}
// 見えない点（地平線の向こう・カメラ後方）の射影クランプ＝project の遅い枝（呼び手は projectInto）。
// 画面に写らない点（カメラ後方＝clip w≦0）は [0, 0, front<0, hx, hy, hw]：x,y は意味なし（従来どおり 0）、hx/hy/hw は画面 px の同次座標
//（screen＝(hx/hw, hy/hw)・clip から線形）。塗りの経路（geopbf/edit/draw makeTracer）はこれで近平面の手前で環を切る＝旧は (0,0)＝画面左上へ
// 頂点を置いた＝チルトで面が画面下へ出てカメラ後方へ回った時、左上へ伸びる細い楔が塗られた（本人スクショ 2026-10-24 温泉郷）
const homPx = (state: CameraState, c: ArrayLike<number>): number[] => [0, 0, -1, (c[0] + c[3]) * 0.5 * state.W, (c[3] - c[1]) * 0.5 * state.H, c[3]];
function projectClamped(state: CameraState, lon: number, lat: number, radius: number): number[] {
	const u = lonlatTo3D(lon, lat);
	const w = liftedPos(u, lon, lat, radius);
	const c = mat.transform(state.mvp, [w[0], w[1], w[2], 1]);
	const frontHemi = mat.dot(u, state.eye) - 1;
	if (frontHemi >= 0 && c[3] <= 1e-6) return homPx(state, c);   // 手前半球だがカメラ後方＝地平円へ寄せない（寄せ先は別の場所）＝写らない点
	{
		// 見えない点（地平線の向こう＝dot(u,E)<1・カメラ後方）は捨てずに、可視キャップの縁（地平円：中心 E/|E|²・半径 √(1−1/|E|²)）
		// の少し内側へ射影クランプして写す＝符号は負のまま（呼び手は符号で可視判定＝従来どおり）、x,y は「地平線上の最寄り点」。
		// 塗りの経路（geoedit オーバレイ/注記/計測）はこれで可視部＋地平線沿いの一本の閉路になる＝旧 [0,0,-1] で path を
		// 切ると環が 2 本の subpath に割れ evenodd で相殺（本人スクショ 2026-09-15 の帯）。gint の horizonClamp と同じ幾何。
		const E = state.eye, e2 = mat.dot(E, E), el = Math.sqrt(e2);
		const k = mat.dot(u, E) / e2;
		let t = [u[0] - E[0] * k, u[1] - E[1] * k, u[2] - E[2] * k];
		const lt = Math.hypot(t[0], t[1], t[2]);
		if (lt > 1e-9) t = [t[0] / lt, t[1] / lt, t[2] / lt];
		else { const q = mat.cross(E, Math.abs(E[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]), lq = Math.hypot(q[0], q[1], q[2]) || 1; t = [q[0] / lq, q[1] / lq, q[2] / lq]; }   // u∥E（対蹠/直下）＝任意の直交基底
		const hor = Math.acos(Math.min(1, 1 / el)) - 1e-3;         // 地平角（rad）− 0.057°＝縁の内側（front を確実に正側で写す）
		const ch = Math.cos(hor) / el, sh = Math.sin(hor);
		const P = [E[0] * ch + t[0] * sh, E[1] * ch + t[1] * sh, E[2] * ch + t[2] * sh];
		const c2 = mat.transform(state.mvp, [P[0], P[1], P[2], 1]);
		if (c2[3] <= 1e-6) return homPx(state, c2);   // 地平円の寄せ先もカメラ後方＝写らない点
		return [(c2[0] / c2[3] * 0.5 + 0.5) * state.W, (1 - (c2[1] / c2[3] * 0.5 + 0.5)) * state.H, Math.min(frontHemi, -1e-9)];
	}
	// TODO(ts): 上の block は常に return する＝ここから下は到達しない（従来のまま残す）
	const sx = (c[0] / c[3] * 0.5 + 0.5) * state.W;
	const sy = (1 - (c[1] / c[3] * 0.5 + 0.5)) * state.H;
	return [sx, sy, frontHemi];
}

// screen(devicePx) → [lon,lat] または null（球に当たらない）。カメラ光線×半径R球（既定=海面球）。
// R>1＝地形リフト球：チルト時、標高hの地面は海面球より手前（画面下）まで映り込む。タイル選抜
// (tilecover.selectLOD) が海面基準のままだと、その手前領域を「画面外」と誤判定して被覆が欠ける
//（実測: 草津1200m・z15.8・チルト52°で画面下1/3が紙色＝タイル未選抜。2026-08-03）。
export function unproject(state: CameraState, sx: number, sy: number, R = 1): LonLat | null {
	const ndcx = sx / state.W * 2 - 1, ndcy = (1 - sy / state.H) * 2 - 1;
	const near = mat.transform(state.invMvp!, [ndcx, ndcy, -1, 1]);
	const far = mat.transform(state.invMvp!, [ndcx, ndcy, 1, 1]);
	const A = [near[0] / near[3], near[1] / near[3], near[2] / near[3]];
	const B = [far[0] / far[3], far[1] / far[3], far[2] / far[3]];
	const d = mat.sub(B, A);
	// |A + t d|^2 = R^2
	const aa = mat.dot(d, d), bb = 2 * mat.dot(A, d), cc = mat.dot(A, A) - R * R;
	const disc = bb * bb - 4 * aa * cc;
	if (disc < 0) return null;
	const t = (-bb - Math.sqrt(disc)) / (2 * aa);                   // 手前の交点
	// t<0＝交点が視線の「後方延長」上（高チルトで地平線より上の空を指した時、直線を後ろへ延ばすと
	// カメラ背後の地球に当たる）。裏半球の鏡像地点（実測: 富士上空で lat19 の海）を返すため null に。
	// ただし R≠1（地形リフト球）で cc<0＝レイ起点(近平面点)が球の内側（高チルトで近平面が球面を割る＝
	// 草津63°で実測：下端レイが全滅しタイル選抜が崩壊）は、起点直下の地面位置を返す：正根（前方の出口）は
	// 惑星を貫いた裏側＝ゴミ。起点の真下がこのレイに映りうる最も手前の地面＝被覆サンプルとして正しい端点。
	// R=1（海面球＝カメラ埋没時）は従来通り null＝picker 等の既定挙動を変えない。
	const P = t >= 0 ? mat.add(A, mat.scale(d, t))
		: (R !== 1 && cc < 0) ? A : null;
	if (!P) return null;
	// invMvp は S 込み＝P は β単位球上の点。asin が返すのは β＝測地緯度へ復元して返す（球では恒等）。
	const lat = geodeticOf(Math.asin(Math.max(-1, Math.min(1, P[1] / R))) * R2D);
	const lon = Math.atan2(P[2], P[0]) * R2D;
	return [lon, lat];
}
