// 透視カメラ（チルト対応）。単位球ワールドで、対象地点(center)を注視する軌道カメラ。
// pitch=0 で真上（従来の真俯瞰）、pitch>0 で地平へ傾く。bearing で方位回転。
import * as mat from "./mat.js";
const D2R = Math.PI / 180, R2D = 180 / Math.PI;

// z の目盛り＝256px 世界（赤道一周 = 2^z × 256 CSSpx）。v1(d3-geo)・地理院地図・OSM と同一目盛り。
// 旧実装は 512px 世界（MapLibre 流）＝同じ視野で z が1小さく、v1 移植の gint 式（256px 前提）や
// altpbf の DEM 段閾値と1段ズレていた（2026-07-26 に 256 へ統一）。zoom→幾何の変換は必ずこの定数を通す。
export const WORLD_PX = 256;

// 経緯度 → 単位球3D
export function lonlatTo3D(lon, lat) {
	const a = lon * D2R, b = lat * D2R, cb = Math.cos(b);
	return [cb * Math.cos(a), Math.sin(b), cb * Math.sin(a)];
}

// カメラ状態を作る。cam: { center:[lon,lat], zoom, pitch(rad), bearing(rad), fovy(rad), dpr }
export function cameraState(cam, W, H) {
	const { center, zoom, pitch = 0, bearing = 0, fovy = 50 * D2R, dpr = 1 } = cam;
	const [lon, lat] = center;
	const T = lonlatTo3D(lon, lat);
	const a = lon * D2R, b = lat * D2R;
	const nrm = T;                                                  // 面法線（単位）
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
	const eye = mat.add(T, mat.scale(back, camDist));
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
	const focal = (H / 2) / Math.tan(fovy / 2);   // 距離ベースLOD用の焦点距離(device px)
	return { mvp, invMvp: mat.invert(mvp), eye, W, H, dpr, camDist, focal };
}

// 経緯度 → [screenX, screenY(devicePx), front]。front>0 で手前半球かつカメラ前方。
export function project(state, lon, lat, radius = 1) {
	const u = lonlatTo3D(lon, lat);
	const w = radius === 1 ? u : [u[0] * radius, u[1] * radius, u[2] * radius];   // 標高変位（ラベルを地形に乗せる）
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
	const lat = Math.asin(Math.max(-1, Math.min(1, P[1] / R))) * R2D;
	const lon = Math.atan2(P[2], P[0]) * R2D;
	return [lon, lat];
}
