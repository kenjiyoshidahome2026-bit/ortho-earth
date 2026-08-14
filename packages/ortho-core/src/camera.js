// 透視カメラ（チルト対応）。単位球ワールドで、対象地点(center)を注視する軌道カメラ。
// pitch=0 で真上（従来の真俯瞰）、pitch>0 で地平へ傾く。bearing で方位回転。
import * as mat from "./mat.js";
const D2R = Math.PI / 180, R2D = 180 / Math.PI;

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
// 各実行文脈（main・render worker・plateau worker）は起動時に setEllipsoid を同値で呼ぶこと（init で搬送）。
let R_AX = 1;   // b/a（球=1）。シェーダ側の dβ 補正は u_ellTrig=(0,…)＝球で厳密0（renderer が配る）
export function setEllipsoid(on) { R_AX = on ? 1 - 1 / 298.257223563 : 1; }
export const ellipsoidOn = () => R_AX !== 1;
export const worldRadiusM = () => R_AX === 1 ? 6371000 : 6378137;   // m→世界単位の換算半径（球＝従来値／楕円体＝a）
// 測地緯度 φ ⇄ 更成緯度 β（deg）。閉形式（atan2＝極も厳密）。球では恒等。
export const betaOf = latDeg => R_AX === 1 ? latDeg
	: Math.atan2(R_AX * Math.sin(latDeg * D2R), Math.cos(latDeg * D2R)) * R2D;
export const geodeticOf = betaDeg => R_AX === 1 ? betaDeg
	: Math.atan2(Math.sin(betaDeg * D2R), R_AX * Math.cos(betaDeg * D2R)) * R2D;

// world空間の3D点 → 測地経緯度 [lon,lat]（deg）。unproject の復元と同じ流儀＝S⁻¹（yだけ1/R_AX＝β空間へ戻す）
// してから geodeticOf で β→測地緯度へ。球(R_AX=1)は恒等。updateUnderground/eyePose が「eyeの地上位置」を
// 正しく引くための逆変換：world の y を直に asin すると【地心緯度】になり、楕円体では測地緯度と緯度36°で
// 約0.09°ずれ、eye直下の地表サンプルが約10km飛ぶ（実測：加賀市の地中フェード誤発動の真因 2026-08-15）。
export function worldToLonLat(p) {
	const yb = p[1] / R_AX;                                       // world → β空間（S⁻¹＝y だけ 1/R_AX）
	const len = Math.hypot(p[0], yb, p[2]) || 1;
	const lat = geodeticOf(Math.asin(Math.max(-1, Math.min(1, yb / len))) * R2D);
	const lon = Math.atan2(p[2], p[0]) * R2D;                     // 経度は S（y方向）に不変
	return [lon, lat];
}

// 経緯度 → β単位球3D（球では従来の単位球そのまま＝ビット同値）。
// 消費者（versor・LOD・ラベル・タイル被覆…）は「単位球上の点」として扱い続けてよい＝内部の主空間。
export function lonlatTo3D(lon, lat) {
	const a = lon * D2R, b = lat * D2R;
	let sb = Math.sin(b), cb = Math.cos(b);
	if (R_AX !== 1) { const w = Math.hypot(cb, R_AX * sb); sb = R_AX * sb / w; cb = cb / w; }
	return [cb * Math.cos(a), sb, cb * Math.sin(a)];
}

// 測地法線（楕円体の「上」）の β空間像 m = S⁻¹·n_geo = (cosφcosλ, sinφ/r, cosφsinλ)。
// 標高 h[m] の変位＝world で (h/a)·n_geo ＝ β空間で (h/a)·m（S を通すと単位法線に戻る）。球では m=u(φ)＝動径。
export function ellNormal3D(lon, lat) {
	const a = lon * D2R, b = lat * D2R, cb = Math.cos(b);
	return [cb * Math.cos(a), Math.sin(b) / R_AX, cb * Math.sin(a)];
}

// カメラ状態を作る。cam: { center:[lon,lat], zoom, pitch(rad), bearing(rad), fovy(rad), dpr }
export function cameraState(cam, W, H) {
	const { center, zoom, pitch = 0, bearing = 0, fovy = 50 * D2R, dpr = 1 } = cam;
	const [lon, lat] = center;
	const Tb = lonlatTo3D(lon, lat);                                // β単位球上の注視点
	const T = R_AX === 1 ? Tb : [Tb[0], R_AX * Tb[1], Tb[2]];       // world（楕円体面）＝S·u(β)。球では同一
	const a = lon * D2R, b = lat * D2R, cb = Math.cos(b);
	// 面法線＝測地法線（楕円体の「上」＝測地緯度の定義そのもの）。球では従来の動径と同式＝ビット同値。
	const nrm = [cb * Math.cos(a), Math.sin(b), cb * Math.sin(a)];
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
	const upCam = mat.add(mat.scale(nrm, Math.sin(pitch)), mat.scale(fwdH, Math.cos(pitch)));   // 画面上方向
	// 地形クランプ（eye の押し上げ）は廃止（2026-07-28）：山頂×高チルトで eye が sea-level 軌道ごと山体に
	// 埋まり、eye直下サンプルは下った斜面＝山頂を見ないため効かなかった（富士 z15/75° で裏面を見上げる絵）。
	// 代替＝カメラは一切動かさず、地表より下に潜ったら app が全画面 DOM オーバーレイ(#underground)を暗くする。
	// カメラ数学に触れない＝「妙なブレ」を作らない（cameraState は純関数のまま＝全消費者で整合）。
	const eye = mat.add(T, mat.scale(back, camDist));               // world のカメラ位置（測地法線基底の軌道）
	const view = mat.lookAt(eye, T, upCam);
	const aspect = W / H;
	// near/far を可視範囲（最近点camDist〜地平線limb）にタイトに。極端なオーバーズームでの精度崩壊を防ぐ。
	const limb = Math.sqrt(Math.max((1 + camDist) * (1 + camDist) - 1, 1e-12));
	// 傾けるほど近景の足元がカメラに寄るので、near を浅くして下が抜けるのを防ぐ（真俯瞰0.3→急チルト0.03）。
	const pf = Math.min(1, pitch / (60 * D2R));
	const near = Math.max(camDist * (0.3 - 0.27 * pf), 1e-7), far = limb * 1.15 + camDist;
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
	return { mvp, invMvp: mat.invert(mvp), eye, W, H, dpr, camDist, focal };
}

// 経緯度 → [screenX, screenY(devicePx), front]。front>0 で手前半球かつカメラ前方。
export function project(state, lon, lat, radius = 1) {
	const u = lonlatTo3D(lon, lat);
	// 標高変位（ラベルを地形に乗せる）：球＝動径倍。楕円体＝測地法線に沿って持ち上げる（動径だと富士級で
	// 水平に十数mズレ＝シェーダの地形変位（同じ測地法線）とラベルの足が合わなくなる）。
	const w = radius === 1 ? u
		: R_AX === 1 ? [u[0] * radius, u[1] * radius, u[2] * radius]
		: (m => [u[0] + (radius - 1) * m[0], u[1] + (radius - 1) * m[1], u[2] + (radius - 1) * m[2]])(ellNormal3D(lon, lat));
	const c = mat.transform(state.mvp, [w[0], w[1], w[2], 1]);
	const frontHemi = mat.dot(u, state.eye) - 1;                     // >0 手前半球（基準球方向で判定）
	if (c[3] <= 1e-6 || frontHemi < 0) return [0, 0, -1];
	const sx = (c[0] / c[3] * 0.5 + 0.5) * state.W;
	const sy = (1 - (c[1] / c[3] * 0.5 + 0.5)) * state.H;
	return [sx, sy, frontHemi];
}

// screen(devicePx) → [lon,lat] または null（球に当たらない）。カメラ光線×半径R球（既定=海面球）。
// R>1＝地形リフト球：チルト時、標高hの地面は海面球より手前（画面下）まで映り込む。タイル選抜
// (tilecover.selectLOD) が海面基準のままだと、その手前領域を「画面外」と誤判定して被覆が欠ける
//（実測: 草津1200m・z15.8・チルト52°で画面下1/3が紙色＝タイル未選抜。2026-08-03）。
export function unproject(state, sx, sy, R = 1) {
	const ndcx = sx / state.W * 2 - 1, ndcy = (1 - sy / state.H) * 2 - 1;
	const near = mat.transform(state.invMvp, [ndcx, ndcy, -1, 1]);
	const far = mat.transform(state.invMvp, [ndcx, ndcy, 1, 1]);
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
