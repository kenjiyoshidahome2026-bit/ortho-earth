// LOD選択と可視タイル算出（透視カメラ）。画面をサンプリングし各点をカメラ光線でunproject→タイルへ。
import { lonLatToTile, tileBounds } from "./tile.js";
import { cameraState, unproject, project, lonlatTo3D } from "./camera.js";

// 距離別LOD（quadtree）：画面サンプルを含む root から、画面上のタイルサイズが閾値超なら4分割。
// 近景=高z・遠景=低z を重なりなく敷く。可視判定はサンプル包含で（大タイルの4隅誤カリングを回避）。
// sticky＝前回update で分割されたノード集合（"z/x/y"）。渡すとヒステリシスが効く：一度分割したノードは
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
export function selectLOD(cam, W, H, { minZ = 4, maxZ = 16, tilePx = 560, grid = 10, sticky = null, stickyRatio = 0.8, floorZ = 0, floorRatio = 0.45, groundR = 1 } = {}) {
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
	const rootMap = new Map();
	for (const [lo, la] of samples) { const [x, y] = lonLatToTile(lo, la, minZ); rootMap.set(minZ + "/" + x + "/" + y, { z: minZ, x, y }); }
	const out = [], stack = [...rootMap.values()];
	let guard = 0;
	while (stack.length && guard++ < 30000) {
		const t = stack.pop();
		const m = tileMetrics(st, t, cam.center, W, H, samples, groundR);
		if (!m.visible) continue;                   // 画面外＆中心外＆サンプル無し → cull
		const th = t.z < floorZ ? tilePx * floorRatio
			: sticky && sticky.has(t.z + "/" + t.x + "/" + t.y) ? tilePx * stickyRatio : tilePx;
		if (t.z < maxZ && m.size > th) {
			const z = t.z + 1, x = t.x * 2, y = t.y * 2;
			stack.push({ z, x, y }, { z, x: x + 1, y }, { z, x, y: y + 1 }, { z, x: x + 1, y: y + 1 });
		} else out.push(t);
	}
	return out;
}

// 可視判定＆画面サイズ。可視＝(前面4隅bbox交差) or (中心を含む) or (サンプル包含)。
// サイズはタイル中心の局所解像度から測る（巨大タイルで4隅が裏でも安定。中心が裏なら遠方=粗のまま）。
// 4隅の投影は海面と groundR（地形リフト球）の**両方**で行い bbox を合併：海面bboxだけだと、リフトで
// 画面内へ持ち上がる手前タイルが「画面外」でculされ、疎な画面サンプル（grid=10）の網に掛かった数枚しか
// 残らない（63°チルトで実測）。リフトbboxだけだと逆に、中心標高より低い遠景（山上→谷）が欠ける。
function tileMetrics(st, t, center, W, H, samples, groundR = 1) {
	const [w, s, e, n] = tileBounds(t.x, t.y, t.z);
	const corners = [[w, n], [e, n], [e, s], [w, s]];
	let nf = 0, minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
	for (const [lo, la] of corners) for (const R of groundR !== 1 ? [1, groundR] : [1]) {
		const [sx, sy, f] = project(st, lo, la, R);
		if (f >= 0) { nf++; minx = Math.min(minx, sx); miny = Math.min(miny, sy); maxx = Math.max(maxx, sx); maxy = Math.max(maxy, sy); }
	}
	let visible = nf > 0 && !(maxx < 0 || minx > W || maxy < 0 || miny > H);
	if (!visible) {
		if (center[0] >= w && center[0] <= e && center[1] >= s && center[1] <= n) visible = true;
		else for (const [lo, la] of samples) if (lo >= w && lo <= e && la >= s && la <= n) { visible = true; break; }
	}
	if (!visible) return { visible: false };
	// サイズ：距離ベースのスクリーン誤差。タイル内で視点直下に最も近い点までの距離で、
	// (タイル角度サイズ / 距離) × focal ≈ 画面上のタイルpx。近いほど大きい＝分割。
	const refLon = Math.min(e, Math.max(w, center[0])), refLat = Math.min(n, Math.max(s, center[1]));
	const p = lonlatTo3D(refLon, refLat);
	const dist = Math.hypot(p[0] - st.eye[0], p[1] - st.eye[1], p[2] - st.eye[2]);
	const worldSize = 2 * Math.PI / (1 << t.z);
	const size = worldSize / Math.max(dist, 1e-9) * st.focal;
	return { visible, size };
}

