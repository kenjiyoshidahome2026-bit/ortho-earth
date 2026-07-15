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
export function selectLOD(cam, W, H, { minZ = 4, maxZ = 16, tilePx = 560, grid = 10, sticky = null, stickyRatio = 0.8, floorZ = 0, floorRatio = 0.45 } = {}) {
	const st = cameraState(cam, W, H);
	const samples = [];
	for (let iy = 0; iy <= grid; iy++) for (let ix = 0; ix <= grid; ix++) {
		const ll = unproject(st, ix / grid * W, iy / grid * H); if (ll) samples.push(ll);
	}
	if (!samples.length) return [];
	const rootMap = new Map();
	for (const [lo, la] of samples) { const [x, y] = lonLatToTile(lo, la, minZ); rootMap.set(minZ + "/" + x + "/" + y, { z: minZ, x, y }); }
	const out = [], stack = [...rootMap.values()];
	let guard = 0;
	while (stack.length && guard++ < 30000) {
		const t = stack.pop();
		const m = tileMetrics(st, t, cam.center, W, H, samples);
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
function tileMetrics(st, t, center, W, H, samples) {
	const [w, s, e, n] = tileBounds(t.x, t.y, t.z);
	const corners = [[w, n], [e, n], [e, s], [w, s]];
	let nf = 0, minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
	for (const [lo, la] of corners) {
		const [sx, sy, f] = project(st, lo, la);
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

// cam.zoom（正射スケール＝緯度フリー）→ web-mercator タイルz。メルカトルタイルは高緯度ほど
// 地上が細かい（タイルの地上幅∝cosφ）ので、同じ画面テクセル密度には log2(cosφ) 段下のタイルでよい
//（那覇-0.15・東京-0.29・札幌-0.45）。ここが正射カメラとメルカトルタイルの唯一の換気口＝
// カメラ(camera.js)は緯度を知らず、タイル選択だけが緯度を知る。
export function pickZoom(cam, minZoom = 4, maxZoom = 16) {
	const merc = cam.zoom + Math.log2(Math.max(0.05, Math.cos(cam.center[1] * Math.PI / 180)));
	return Math.max(minZoom, Math.min(maxZoom, Math.round(merc)));
}

// 可視タイル一覧 {z,x,y}。画面 grid×grid をサンプルして unproject→タイルへ。
// 中心タイルから maxRadius 以内にクランプ：高z+チルトで地平線側が爆発するのを防ぐ（遠方は粗下敷きが担当）。
export function visibleTiles(cam, W, H, z, { grid = 6, pad = 1, maxRadius = 8 } = {}) {
	const st = cameraState(cam, W, H);
	const n = 1 << z;
	// 中心が極域（|lat|>85.05）だと mercator y が範囲外へ飛び、半径クランプで全タイルが消える。
	// 半径のアンカーはメルカトル域内へ寄せた中心で取る（極を向いていても最寄りの実在タイル行が基準になる）。
	const MERC_MAX = 85.0511;
	const [ccx, ccy] = lonLatToTile(cam.center[0], Math.max(-MERC_MAX, Math.min(MERC_MAX, cam.center[1])), z);
	let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity, hit = false;
	for (let iy = 0; iy <= grid; iy++) {
		for (let ix = 0; ix <= grid; ix++) {
			const ll = unproject(st, ix / grid * W, iy / grid * H);
			if (!ll) continue;                         // 球に当たらない（地平線より上/空）
			const [tx, ty] = lonLatToTile(ll[0], ll[1], z);
			if (!isFinite(tx) || !isFinite(ty)) continue;
			hit = true;
			xmin = Math.min(xmin, tx); xmax = Math.max(xmax, tx);
			ymin = Math.min(ymin, ty); ymax = Math.max(ymax, ty);
		}
	}
	if (!hit) return [];
	xmin = Math.max(xmin - pad, ccx - maxRadius); xmax = Math.min(xmax + pad, ccx + maxRadius);
	ymin = Math.max(ymin - pad, ccy - maxRadius, 0); ymax = Math.min(ymax + pad, ccy + maxRadius, n - 1);
	const tiles = [];
	for (let ty = ymin; ty <= ymax; ty++) {
		for (let x = xmin; x <= xmax; x++) {
			const tx = ((x % n) + n) % n;              // 経度ラップ
			tiles.push({ z, x: tx, y: ty });
		}
	}
	return tiles;
}

export { unproject } from "./camera.js";
