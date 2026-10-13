// LOD選択と可視タイル算出（透視カメラ）。画面をサンプリングし各点をカメラ光線でunproject→タイルへ。
import { lonLatToTile, tileBoundsInto, tileId } from "./tile.js";
import { cameraState, unproject, projectInto, lonlatTo3D } from "./camera.js";

// 節ごとの作業域（selectLOD は同期＝使い回し）：タイル境界 [w,s,e,n]・射影 [sx,sy,front]。旧＝節ごと・隅ごとに配列を作って GC が選抜の 2 割
const B = new Float64Array(4), P = new Float64Array(3);

// 距離別LOD（quadtree）：画面サンプルを含む root から、画面上のタイルサイズが閾値超なら4分割。
// 近景=高z・遠景=低z を重なりなく敷く。可視判定はサンプル包含で（大タイルの4隅誤カリングを回避）。
// sticky＝前回update で分割されたノード集合（tileId(z,x,y) の番号）。渡すとヒステリシスが効く：一度分割したノードは
// tilePx×stickyRatio まで縮むまで分割を維持（分割は >tilePx のまま）。境界上のタイルがカメラ微動で
// 親⇔子に毎フレーム振動し、merge・abort・再fetch を撒き散らすのを断つ（チルト時のちらつきの燃料）。
// floorZ＝LOD下限：z<floorZ のノードは分割閾値を tilePx×floorRatio へ下げて優先的に割る＝遠景も floorZ 以上の
// タイルで敷く（optbv は z8 から海が全面WA＝z7以下の遠景が紙色になる配信欠落を、正しいzのタイルで埋める）。
// 無条件でなく閾値式なのは地平線ぎわの掠りタイル（フォグの彼方＝どうせ見えない）まで z8 で敷き詰めて
// タイル数が爆発するのを防ぐため。floorRatio=0.45＝フォグ終端(fogDist×5)相当の画面サイズまでは floorZ を強制。
// groundR＝地形リフト球の半径（既定1=海面）。チルト時は「表示中の地形変位と同じリフト球」
// （1 + 地面標高×pitchフェード×exag/earthM）を渡すこと：標高の高い土地（草津1200m等）では持ち上がった
// 地面が海面球より画面下まで映り込む＝海面基準の被覆は手前のくさび形が欠けて紙色になる（2026-08-03根治）。
// 被覆は海面球との**和集合**で取る（サンプル・可視判定とも両球）＝リフト球は「手前の映り込み」を足すだけで、
// 遠景は海面基準のまま守られる。中心標高が遠景より高い時（山上→谷）でも旧選抜の上位集合＝欠けの退行がない。
// zOf＝(z, x, y) → そのタイルで望む z（MapLibre の選び方＝mlcover.mlTileZoomOf）。渡すと画面の大きさの閾（tilePx・sticky・floorZ）は使わず「z が望む z に届くまで割る」＝MapLibre の coveringTiles と同じ規則。可視判定はこのまま
export function selectLOD(cam, W, H, { minZ = 4, maxZ = 16, tilePx = 560, grid = 10, sticky = null, stickyRatio = 0.8, floorZ = 0, floorRatio = 0.45, groundR = 1, zOf = null } = {}) {
	const st = cameraState(cam, W, H);
	const samples = [];
	for (let iy = 0; iy <= grid; iy++) for (let ix = 0; ix <= grid; ix++) {
		const ll = unproject(st, ix / grid * W, iy / grid * H); if (ll) samples.push(ll);
		if (groundR !== 1) {
			const lg = unproject(st, ix / grid * W, iy / grid * H, groundR);
			if (lg) {
				samples.push(lg);
				// 同一レイの海面交点⇄リフト交点の線分（＝標高0..lift の地形がこのレイに露出しうる地面域）を
				// 内挿サンプル：極近景は1画面格子の間に多数の z16 タイルが挟まり、点サンプルの網も4隅投影
				// （近平面の背後に落ちて bbox が立たない）も同時にすり抜ける（63°草津で実測）。線分を刻めば
				// レイが跨ぐタイルは必ず票を得る＝格子密度に依らず被覆が閉じる。
				if (ll) for (let k = 1; k < 6; k++) samples.push([ll[0] + (lg[0] - ll[0]) * k / 6, ll[1] + (lg[1] - ll[1]) * k / 6]);
			}
		}
	}
	if (!samples.length) return [];
	// サンプルの包含判定は「親に入っていたサンプル」だけを子で見直す（子⊂親＝境界の式も親と同値）＝旧＝全サンプル（チルトで ~900 点）を
	// 見えない候補タイルごとに総なめ（選抜の 5 割）。sIn＝そのノードに入るサンプルの添字（根＝null＝全部）
	const sLo = new Float64Array(samples.length), sLa = new Float64Array(samples.length);
	for (let i = 0; i < samples.length; i++) { sLo[i] = samples[i][0]; sLa[i] = samples[i][1]; }
	const rootMap = new Map();
	// 極の上（|緯度|>85.05°）のサンプルはメルカトルの外＝y が範囲外のタイル（実在しない）になる→上下の端の行へ畳む（旧＝1/0/-1 のような偽タイルが根になり、極の周りの帯が覆われず紙色のまま・2026-09-30）
	const nRoot = 1 << minZ;
	for (const [lo, la] of samples) { const [x0, y0] = lonLatToTile(lo, la, minZ); const x = ((x0 % nRoot) + nRoot) % nRoot, y = Math.max(0, Math.min(nRoot - 1, y0)); rootMap.set(tileId(minZ, x, y), { z: minZ, x, y }); }
	const out = [], stack = [...rootMap.values()];
	let guard = 0;
	while (stack.length && guard++ < 30000) {
		const t = stack.pop();
		const b = tileBoundsInto(t.x, t.y, t.z, B);
		const size = tileMetrics(st, t, b, cam.center, W, H, sLo, sLa, t.s, groundR);
		if (size < 0) continue;                     // 画面外＆中心外＆サンプル無し → cull
		const th = t.z < floorZ ? tilePx * floorRatio
			: sticky && sticky.has(tileId(t.z, t.x, t.y)) ? tilePx * stickyRatio : tilePx;
		if (t.z < maxZ && (zOf ? t.z < zOf(t.z, t.x, t.y) : size > th)) {
			const z = t.z + 1, x = t.x * 2, y = t.y * 2, s = samplesIn(b, sLo, sLa, t.s);
			stack.push({ z, x, y, s }, { z, x: x + 1, y, s }, { z, x, y: y + 1, s }, { z, x: x + 1, y: y + 1, s });
		} else out.push({ z: t.z, x: t.x, y: t.y });
	}
	return out;
}

// 可視判定＆画面サイズ（戻り＝画面上のタイル px・見えない＝-1）。可視＝(前面4隅bbox交差) or (中心を含む) or (サンプル包含)。
// サイズはタイル中心の局所解像度から測る（巨大タイルで4隅が裏でも安定。中心が裏なら遠方=粗のまま）。
// 4隅の投影は海面と groundR（地形リフト球）の**両方**で行い bbox を合併：海面bboxだけだと、リフトで
// 画面内へ持ち上がる手前タイルが「画面外」でculされ、疎な画面サンプル（grid=10）の網に掛かった数枚しか
// 残らない（63°チルトで実測）。リフトbboxだけだと逆に、中心標高より低い遠景（山上→谷）が欠ける。
function tileMetrics(st, t, b, center, W, H, sLo, sLa, sIn, groundR = 1) {
	const w = b[0], s = b[1], e = b[2], n = b[3];
	// 四隅に加えて辺の途中も見る（粗いタイル＝z≤4）：球の縁では四隅が全部裏側でも辺の一部が表に出る（極を見下ろす時の赤道帯＝南半球の z1 タイル）。旧＝四隅だけ＝縁の帯が「見えない」と切られて紙色のまま（2026-09-30）
	const K = t.z <= 4 ? 6 : 1;
	let nf = 0, minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
	const corner = (lo, la) => {
		for (let r = 0; r < (groundR !== 1 ? 2 : 1); r++) {
			projectInto(st, lo, la, r ? groundR : 1, P);
			const sx = P[0], sy = P[1], f = P[2];
			if (f >= 0) { nf++; minx = Math.min(minx, sx); miny = Math.min(miny, sy); maxx = Math.max(maxx, sx); maxy = Math.max(maxy, sy); }
		}
	};
	for (let i = 0; i < K; i++) { const f = i / K; corner(w + (e - w) * f, n); corner(e, n + (s - n) * f); corner(e + (w - e) * f, s); corner(w, s + (n - s) * f); }
	let visible = nf > 0 && !(maxx < 0 || minx > W || maxy < 0 || miny > H);
	if (!visible) {
		if (center[0] >= w && center[0] <= e && center[1] >= s && center[1] <= n) visible = true;
		else if (sIn) { for (let k = 0; k < sIn.length; k++) { const i = sIn[k], lo = sLo[i], la = sLa[i]; if (lo >= w && lo <= e && la >= s && la <= n) { visible = true; break; } } }
		else for (let i = 0; i < sLo.length; i++) { const lo = sLo[i], la = sLa[i]; if (lo >= w && lo <= e && la >= s && la <= n) { visible = true; break; } }
	}
	if (!visible) return -1;
	// サイズ：距離ベースのスクリーン誤差。タイル内で視点直下に最も近い点までの距離で、
	// (タイル角度サイズ / 距離) × focal ≈ 画面上のタイルpx。近いほど大きい＝分割。
	const refLon = Math.min(e, Math.max(w, center[0])), refLat = Math.min(n, Math.max(s, center[1]));
	const p = lonlatTo3D(refLon, refLat);
	const dist = Math.hypot(p[0] - st.eye[0], p[1] - st.eye[1], p[2] - st.eye[2]);
	const worldSize = 2 * Math.PI / (1 << t.z);
	return worldSize / Math.max(dist, 1e-9) * st.focal;   // 画面上のタイル px（≥0）。見えない＝-1
}

// 境界 [w,s,e,n] に入るサンプルの添字（sIn＝親の分・null＝全部）
function samplesIn(b, sLo, sLa, sIn) {
	const w = b[0], s = b[1], e = b[2], n = b[3], o = [];
	if (sIn) { for (let k = 0; k < sIn.length; k++) { const i = sIn[k], lo = sLo[i], la = sLa[i]; if (lo >= w && lo <= e && la >= s && la <= n) o.push(i); } }
	else for (let i = 0; i < sLo.length; i++) { const lo = sLo[i], la = sLa[i]; if (lo >= w && lo <= e && la >= s && la <= n) o.push(i); }
	return o;
}

