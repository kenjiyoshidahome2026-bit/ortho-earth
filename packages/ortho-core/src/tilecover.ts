// LOD選択と可視タイル算出（透視カメラ）。画面をサンプリングし各点をカメラ光線でunproject→タイルへ。
import { lonLatToTile, tileBoundsInto, tileId, type TileXYZ } from "./tile.ts";
import { cameraState, unproject, projectInto, lonlatTo3D, geodeticOf, type CameraPose, type CameraState } from "./camera.ts";
import * as mat from "./mat.ts";

// 節ごとの作業域（selectLOD は同期＝使い回し）：タイル境界 [w,s,e,n]・射影 [sx,sy,front]。旧＝節ごと・隅ごとに配列を作って GC が選抜の 2 割
const B = new Float64Array(4), P = new Float64Array(3);

/** selectLOD の選択肢 */
export interface SelectLODOptions {
	minZ?: number; maxZ?: number; tilePx?: number; grid?: number;
	/** 前回 update で分割されたノード集合（tileId の番号） */
	sticky?: Set<number> | null; stickyRatio?: number;
	floorZ?: number; floorRatio?: number;
	/** 地形リフト球の半径（既定 1＝海面） */
	groundR?: number;
	/** 遠景のリフト球の半径（既定＝groundR）：遠景層の最大標高＝海面球の地平線の向こうに映る持ち上がった地面の分だけ標本と四隅の射影を伸ばす（手前の標本は groundR のまま＝近景が細かくならない） */
	farR?: number;
	/** (z, x, y) → そのタイルで望む z（mlcover.mlTileZoomOf） */
	zOf?: ((z: number, x: number, y: number) => number) | null;
	/** Cesium's distance (the Cesium facade's imagery, raster sse): the tile's size is measured at its point closest to the eye's nadir, on the ground
	 *  sphere (groundR), as Cesium measures a terrain tile's screen-space error from the eye to its bounding volume. Default: the point closest to
	 *  the target, on the sea-level sphere = a tilted close-up (or mountains: the ground 2–3 km above the sphere) took tiles 1–2 levels coarser
	 *  than Cesium (geometry-height-reference: Cesium z16, ortho z14, v242) */
	nearEye?: boolean;
}
/** 選抜の節（s＝そのノードに入るサンプルの添字・根＝undefined＝全部） */
interface LODNode extends TileXYZ { s?: number[] | null }

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
export function selectLOD(cam: CameraPose, W: number, H: number, { minZ = 4, maxZ = 16, tilePx = 560, grid = 10, sticky = null, stickyRatio = 0.8, floorZ = 0, floorRatio = 0.45, groundR = 1, farR = groundR, zOf = null, nearEye = false }: SelectLODOptions = {}): TileXYZ[] {
	const st = cameraState(cam, W, H);
	const eyeR = Math.hypot(st.eye[0], st.eye[1], st.eye[2]), ref: [number, number, number] | null = nearEye && eyeR > 1 ? [Math.atan2(st.eye[2], st.eye[0]) * 180 / Math.PI, geodeticOf(Math.asin(Math.max(-1, Math.min(1, st.eye[1] / eyeR))) * 180 / Math.PI), Math.max(1, groundR)] : null;   // the eye's nadir + the ground radius (nearEye)
	const samples: [number, number][] = [];
	const eyeInFar = farR > groundR && mat.dot(st.eye, st.eye) < farR * farR;   // a low camera among ground higher than the target's (a canyon): that ground can be anywhere along each ray
	for (let iy = 0; iy <= grid; iy++) for (let ix = 0; ix <= grid; ix++) {
		const ll = unproject(st, ix / grid * W, iy / grid * H); if (ll) samples.push(ll);
		if (eyeInFar) liftSamples(st, ix / grid * W, iy / grid * H, farR, samples);
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
	// 地平線ぎわの標本（2026-10-27・Cesium 例の門＝地平線の手前に下地色の帯）：格子（H/grid 刻み）は地平線の下の 1 行分（数 km〜地平線＝遠景の大半）に
	// 標本を持たず、地平線を跨ぐ粗いタイルは四隅の射影（向こう側の隅は捨てる）でも拾えない＝遠景のタイルが選抜から落ちていた。
	// 各列で最初に海面に当たる行を二分探索し、そこから 0,1,2,4,…行下の点を足す（距離は地平線ぎわで急に変わる＝等比の行が距離の等比に近い）。
	// リフト球（groundR＞1＝持ち上がった遠景）はその上の行にも映る＝視線がリフト球を通る区間の点を足す（目が球の内側でも可＝liftSamples）
	for (let ix = 0; ix <= grid; ix++) {
		const sx = ix / grid * W;
		let hi = H;   // 最初に海面に当たる行（無ければ H）
		if (unproject(st, sx, 0)) hi = 0; else if (unproject(st, sx, H)) { let lo = 0; hi = H; while (hi - lo > 1) { const mid = (lo + hi) / 2; if (unproject(st, sx, mid)) hi = mid; else lo = mid; } }
		for (let d = 0; hi + d <= H; d = d ? d * 2 : 1) { const y = hi + d, ll = unproject(st, sx, y); if (ll) samples.push(ll); if (farR > 1) liftSamples(st, sx, y, farR, samples); }
		if (farR > 1) for (let d = 1; hi - d >= 0; d *= 2) { if (!liftSamples(st, sx, hi - d, farR, samples)) break; }
	}
	// 目が海面球の内側（地下・Cesium の underground）：前方の交点が無い＝上の標本は全部空振り。視線が球を内から抜ける所（裏から見る地面）を標本に
	// （遠すぎる出口＝地球を貫いて裏側＝捨てる・UNDER_REACH 世界単位）
	// 四隅の射影は裏の面を「見えない」とする＝タイルは標本でしか拾えない＝網は 4 倍の細かさ
	// 遠い所（地平線へ向かう行）は距離が行ごとに急に伸びる＝列ごとに出口が UNDER_REACH を越える行を二分探索し、その手前 1,2,4,… 行の点を足す
	if (Math.hypot(st.eye[0], st.eye[1], st.eye[2]) < 1) {
		const g = grid * 4;
		for (let ix = 0; ix <= g; ix++) {
			const sx = ix / g * W;
			let lastIn = -1;
			for (let iy = 0; iy <= g; iy++) { const ll = unprojectUnder(st, sx, iy / g * H); if (ll) { samples.push(ll); lastIn = iy; } else if (lastIn >= 0) { let lo = lastIn / g * H, hi = iy / g * H; while (hi - lo > 1) { const mid = (lo + hi) / 2; if (unprojectUnder(st, sx, mid)) lo = mid; else hi = mid; } for (let d = 0; d < H / g; d = d ? d * 2 : 1) { const q = unprojectUnder(st, sx, lo - d); if (q) samples.push(q); } lastIn = -1; } }
		}
	}
	if (!samples.length) return [];
	// サンプルの包含判定は「親に入っていたサンプル」だけを子で見直す（子⊂親＝境界の式も親と同値）＝旧＝全サンプル（チルトで ~900 点）を
	// 見えない候補タイルごとに総なめ（選抜の 5 割）。sIn＝そのノードに入るサンプルの添字（根＝null＝全部）
	const sLo = new Float64Array(samples.length), sLa = new Float64Array(samples.length);
	for (let i = 0; i < samples.length; i++) { sLo[i] = samples[i][0]; sLa[i] = samples[i][1]; }
	const rootMap = new Map<number, LODNode>();
	// 極の上（|緯度|>85.05°）のサンプルはメルカトルの外＝y が範囲外のタイル（実在しない）になる→上下の端の行へ畳む（旧＝1/0/-1 のような偽タイルが根になり、極の周りの帯が覆われず紙色のまま・2026-09-30）
	const nRoot = 1 << minZ;
	for (const [lo, la] of samples) { const [x0, y0] = lonLatToTile(lo, la, minZ); const x = ((x0 % nRoot) + nRoot) % nRoot, y = Math.max(0, Math.min(nRoot - 1, y0)); rootMap.set(tileId(minZ, x, y), { z: minZ, x, y }); }
	const out: TileXYZ[] = [], stack: LODNode[] = [...rootMap.values()];
	let guard = 0;
	while (stack.length && guard++ < 30000) {
		const t = stack.pop()!;
		const b = tileBoundsInto(t.x, t.y, t.z, B);
		const size = tileMetrics(st, t, b, cam.center, W, H, sLo, sLa, t.s, Math.max(groundR, farR), ref);
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
function tileMetrics(st: CameraState, t: TileXYZ, b: Float64Array, center: ArrayLike<number>, W: number, H: number, sLo: Float64Array, sLa: Float64Array, sIn: number[] | null | undefined, groundR = 1, near: [number, number, number] | null = null): number {
	const w = b[0], s = b[1], e = b[2], n = b[3];
	// 四隅に加えて辺の途中も見る（粗いタイル＝z≤4）：球の縁では四隅が全部裏側でも辺の一部が表に出る（極を見下ろす時の赤道帯＝南半球の z1 タイル）。旧＝四隅だけ＝縁の帯が「見えない」と切られて紙色のまま（2026-09-30）
	const K = t.z <= 4 ? 6 : 1;
	let nf = 0, minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
	const E = st.eye, under = Math.hypot(E[0], E[1], E[2]) < 1, m = st.mvp;
	const corner = (lo: number, la: number): void => {
		if (under) {   // 地下の目＝面を裏から見る（projectInto は手前の半球だけ＝全部「見えない」）：カメラの前で UNDER_REACH より近い隅を射影
			const q = lonlatTo3D(lo, la), c3 = m[3] * q[0] + m[7] * q[1] + m[11] * q[2] + m[15];
			if (c3 > 1e-10 && Math.hypot(q[0] - E[0], q[1] - E[1], q[2] - E[2]) < UNDER_REACH) {
				const sx = ((m[0] * q[0] + m[4] * q[1] + m[8] * q[2] + m[12]) / c3 * 0.5 + 0.5) * W, sy = (1 - ((m[1] * q[0] + m[5] * q[1] + m[9] * q[2] + m[13]) / c3 * 0.5 + 0.5)) * H;
				nf++; minx = Math.min(minx, sx); miny = Math.min(miny, sy); maxx = Math.max(maxx, sx); maxy = Math.max(maxy, sy);
			}
			return;
		}
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
	const c0 = near ?? center, refLon = Math.min(e, Math.max(w, c0[0])), refLat = Math.min(n, Math.max(s, c0[1]));
	const p = lonlatTo3D(refLon, refLat);
	if (near) { p[0] *= near[2]; p[1] *= near[2]; p[2] *= near[2]; }   // Cesium: from the eye to the tile's closest point, on the ground
	const dist = Math.hypot(p[0] - st.eye[0], p[1] - st.eye[1], p[2] - st.eye[2]);
	const worldSize = 2 * Math.PI / (1 << t.z);
	return worldSize / Math.max(dist, 1e-9) * st.focal;   // 画面上のタイル px（≥0）。見えない＝-1
}

// 境界 [w,s,e,n] に入るサンプルの添字（sIn＝親の分・null＝全部）
function samplesIn(b: Float64Array, sLo: Float64Array, sLa: Float64Array, sIn: number[] | null | undefined): number[] {
	const w = b[0], s = b[1], e = b[2], n = b[3], o: number[] = [];
	if (sIn) { for (let k = 0; k < sIn.length; k++) { const i = sIn[k], lo = sLo[i], la = sLa[i]; if (lo >= w && lo <= e && la >= s && la <= n) o.push(i); } }
	else for (let i = 0; i < sLo.length; i++) { const lo = sLo[i], la = sLa[i]; if (lo >= w && lo <= e && la >= s && la <= n) o.push(i); }
	return o;
}


const UNDER_REACH = 0.16;   // 約 1000 km（Cesium の undergroundColorAlphaByDistance の far の既定 1e6 m 程度まで）
// 地下の目（海面球の内側）から画面 (sx,sy) の視線が海面球を抜ける所（遠い根）。遠すぎれば null
function unprojectUnder(st: CameraState, sx: number, sy: number): [number, number] | null {
	const ndcx = sx / st.W * 2 - 1, ndcy = (1 - sy / st.H) * 2 - 1;
	const n = mat.transform(st.invMvp!, [ndcx, ndcy, -1, 1]), f = mat.transform(st.invMvp!, [ndcx, ndcy, 1, 1]);
	const d = [f[0] / f[3] - n[0] / n[3], f[1] / f[3] - n[1] / n[3], f[2] / f[3] - n[2] / n[3]], dl = Math.hypot(d[0], d[1], d[2]);
	if (!(dl > 0)) return null;
	d[0] /= dl; d[1] /= dl; d[2] /= dl;
	const E = st.eye, b = mat.dot(E, d), disc = b * b - (mat.dot(E, E) - 1);
	if (disc <= 0) return null;
	const t = -b + Math.sqrt(disc);
	if (!(t > 0 && t < UNDER_REACH)) return null;
	const x = E[0] + d[0] * t, y = E[1] + d[1] * t, z = E[2] + d[2] * t, r = Math.hypot(x, y, z);
	return [Math.atan2(z, x) * 180 / Math.PI, geodeticOf(Math.asin(Math.max(-1, Math.min(1, y / r))) * 180 / Math.PI)];
}
// 画面 (sx,sy) の視線が半径 R の球（リフト球）を通る区間 [ta,tb]（目からの距離・目が球の内側なら ta=0・海面球に当たる視線はそこまで）の 4 点を足す。
// 持ち上がった地面がこの視線に映りうる所＝海面球の地平線の向こうの遠景（低い目で高い山を見る時は目がリフト球の内側＝unproject は交点を返せない）。戻り＝足したか
function liftSamples(st: CameraState, sx: number, sy: number, R: number, out: [number, number][]): boolean {
	const ndcx = sx / st.W * 2 - 1, ndcy = (1 - sy / st.H) * 2 - 1;
	const n = mat.transform(st.invMvp!, [ndcx, ndcy, -1, 1]), f = mat.transform(st.invMvp!, [ndcx, ndcy, 1, 1]);
	const d = [f[0] / f[3] - n[0] / n[3], f[1] / f[3] - n[1] / n[3], f[2] / f[3] - n[2] / n[3]], dl = Math.hypot(d[0], d[1], d[2]);
	if (!(dl > 0)) return false;
	d[0] /= dl; d[1] /= dl; d[2] /= dl;
	const E = st.eye, b = mat.dot(E, d), ee = mat.dot(E, E), disc = b * b - (ee - R * R);
	if (disc <= 0) return false;
	const sq = Math.sqrt(disc);
	let ta = Math.max(-b - sq, 0), tb = -b + sq;
	const d1 = b * b - (ee - 1);
	if (d1 > 0 && -b - Math.sqrt(d1) > 0) tb = Math.min(tb, -b - Math.sqrt(d1));   // 海面に当たる＝その先は隠れる
	if (!(tb > ta)) return false;
	const at = (t: number) => { const x = E[0] + d[0] * t, y = E[1] + d[1] * t, z = E[2] + d[2] * t, r = Math.hypot(x, y, z); out.push([Math.atan2(z, x) * 180 / Math.PI, geodeticOf(Math.asin(Math.max(-1, Math.min(1, y / r))) * 180 / Math.PI)]); };
	for (let k = 1; k <= 4; k++) at(ta + (tb - ta) * k / 4);
	// the eye inside the sphere (a low camera among higher ground): the ground this ray can meet starts at the eye, and near the eye the
	// distance changes fastest across the screen = geometric steps toward it (a cliff a few hundred metres away was left to the base colour)
	if (ta === 0) for (let k = 3; k <= 8; k++) at(tb / (1 << k));
	return true;
}
