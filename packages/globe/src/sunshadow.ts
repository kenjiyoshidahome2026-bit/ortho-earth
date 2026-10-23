// 日影（#44・2026-09-23）＝建物の影を測定面へ投影して数える（model 役の worker で走る）。
//   建物＝3D Tiles（PLATEAU の台帳・任意の tileset）を 1 棟ずつ接地して読む（tiles3d-decode の ground:"terrain"＝高さは各棟の足元から）。
//   太陽＝真太陽時の式（日影規制と同じ流儀）：赤緯 δ・時角 H＝15°×(t−12) から高度 α と方位 A。
//   投影＝測定面の高さ h0 より上の頂点を、影の向き（太陽の反対）へ (h−h0)/tan α だけずらす。三角形ごとに升目へ塗り、同じ時刻の重なりは一度だけ数える。
//   出力＝升目の RGBA（瞬間＝影の範囲／時間＝日影になる時間の段彩＋境目の線）と数値（最大の日影時間など）。
import { decodeTile3D } from "./tiles3d-decode.ts";
import { collectLeafTiles } from "./meshdecode.ts";
import { D2R, R_EARTH, K_REFR, sunAt, sunTimes, paintSunShadow, paintViewshed, sunGrid } from "./sunshadow-core.ts";   // 太陽の式・時刻の列・色付け＝GPU 版（2026-10-24）と共有の純関数
export { sunAt };

/** 3D Tiles の境界体積（region＝ラジアン・box／sphere＝tileset の座標） */
interface BoundingVolume { region?: number[]; box?: number[]; sphere?: number[] }
/** tileset.json の 1 節 */
interface TileNode { transform?: number[]; boundingVolume: BoundingVolume; content?: { uri?: string; url?: string }; children?: TileNode[] }
/** 葉のタイル（uri・置き場の行列） */
interface Leaf { uri: string; M: ArrayLike<number> }
/** 建物の出どころ＝任意の tileset の URL・地域の建物台帳（PLATEAU 等＝base の tileset.json・bbox の外は読まない） */
export interface BuildingSource { tilesets?: string[]; sets?: Array<{ base: string; bbox?: number[] | null }>; bbox: number[]; maxTris?: number }
/** 日影の口（bbox＝[w,s,e,n]・mode＝瞬間｜時間・hours＝真太陽時の範囲・step＝時・planeH＝測定面 m・probe＝[[lon,lat]…]） */
export interface SunShadowOptions extends BuildingSource {
	mode?: "instant" | "duration"; date?: string | number | Date | null; decl?: number | null; hours?: number[]; step?: number; planeH?: number;
	cell?: number | null; maxCells?: number | null; probe?: number[][] | null;
}
/** 可視域・見通し線の口（ground＝N×N の地表 m・row0＝北・observer／los＝[lon,lat]） */
export interface ViewshedOptions extends BuildingSource {
	N: number; ground: ArrayLike<number>; observer: number[]; eyeH?: number; targetH?: number; radius?: number; buildings?: boolean;
	probe?: number[][] | null; los?: number[] | null;
	/** 地表（地形＋建物の屋根・N×N m）を外から渡す＝建物を読まない（GPU が描いた物から取った地表で見通し線を引く・2026-10-24）。surfaceTris＝その三角形数（統計） */
	surface?: ArrayLike<number> | null; surfaceTris?: number;
}

// 任意の tileset の葉（最も細かい段）を、変換行列を親から積みながら集める（範囲の外の枝は落とす）
const m4mul = (a: ArrayLike<number>, b: ArrayLike<number>): number[] => { const o: number[] = new Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c*4+r] = a[r]*b[c*4] + a[4+r]*b[c*4+1] + a[8+r]*b[c*4+2] + a[12+r]*b[c*4+3]; return o; };
const I4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function ecefLL(x: number, y: number, z: number): number[] { const p = Math.hypot(x, y); return [Math.atan2(y, x) / D2R, Math.atan2(z, p * (1 - 0.00669437999014)) / D2R]; }
function volLL(bv: BoundingVolume, M: ArrayLike<number>): number[] | null {   // 境界体積 → 経緯度の外接（度・粗くてよい）
	if (bv?.region) { const r = bv.region; return [r[0] / D2R, r[1] / D2R, r[2] / D2R, r[3] / D2R]; }
	const c = bv?.box ? bv.box.slice(0, 3) : bv?.sphere ? bv.sphere.slice(0, 3) : null; if (!c) return null;
	const rad = bv.box ? Math.hypot(bv.box[3], bv.box[4], bv.box[5]) + Math.hypot(bv.box[6], bv.box[7], bv.box[8]) + Math.hypot(bv.box[9], bv.box[10], bv.box[11]) : bv.sphere![3];
	const e: [number, number, number] = [M[0]*c[0] + M[4]*c[1] + M[8]*c[2] + M[12], M[1]*c[0] + M[5]*c[1] + M[9]*c[2] + M[13], M[2]*c[0] + M[6]*c[1] + M[10]*c[2] + M[14]];
	const [lo, la] = ecefLL(...e), d = rad / 111320;
	return [lo - d / Math.max(0.1, Math.cos(la * D2R)), la - d, lo + d / Math.max(0.1, Math.cos(la * D2R)), la + d];
}
async function leavesOf(url: string, bbox: readonly number[], M: ArrayLike<number> = I4, depth = 0): Promise<Leaf[]> {
	const r = await fetch(url, { credentials: "omit" }); if (!r.ok) throw new Error(`tileset HTTP ${r.status}`);
	const j = await r.json(), out: Leaf[] = [];
	const walk = async (t: TileNode, P: ArrayLike<number>): Promise<void> => {
		const MM = t.transform ? m4mul(P, t.transform) : P, ll = volLL(t.boundingVolume, MM);
		if (ll && (ll[2] < bbox[0] || ll[0] > bbox[2] || ll[3] < bbox[1] || ll[1] > bbox[3])) return;
		const uri = t.content?.uri ?? t.content?.url;
		if (t.children?.length) { for (const c of t.children) await walk(c, MM); return; }
		if (!uri) return;
		const abs = new URL(uri, url).href;
		if (/\.json(\?|$)/i.test(abs) && depth < 4) out.push(...await leavesOf(abs, bbox, MM, depth + 1));
		else out.push({ uri: abs, M: MM });
	};
	await walk(j.root, M);
	return out;
}

// 建物の三角形（局所の平面 m＝原点からの東・北・高さ）を集める
async function gatherTriangles({ tilesets = [], sets = [], bbox, maxTris = 3e6 }: BuildingSource): Promise<{ tris: Float32Array<ArrayBuffer>[]; count: number; tiles: number; lon0: number; lat0: number; kx: number; ky: number }> {
	const [w, s, e, n] = bbox, lon0 = (w + e) / 2 * D2R, lat0 = (s + n) / 2 * D2R, kx = Math.cos(lat0) * R_EARTH, ky = R_EARTH;
	const urls: Leaf[] = [];   // { uri, M }
	for (const t of tilesets) urls.push(...await leavesOf(new URL(t, self.location?.href).href, bbox));
	for (const st of sets) if (!st.bbox || !(st.bbox[2] < w || st.bbox[0] > e || st.bbox[3] < s || st.bbox[1] > n)) urls.push(...(await collectLeafTiles(st.base + "tileset.json", 0, null, null, bbox)).map(l => ({ uri: l.uri, M: I4 })));   // PLATEAU＝葉が RTC で自分の置き場を持つ
	const tris: Float32Array<ArrayBuffer>[] = [];   // Float32Array の塊（x0,y0,h0, x1,y1,h1, x2,y2,h2）
	let count = 0;
	const one = async ({ uri: url, M }: Leaf): Promise<void> => {
		const r = await fetch(url, { credentials: "omit" }); if (!r.ok) return;
		const out = await decodeTile3D(await r.arrayBuffer(), { transform: M, baseUri: url, textures: false, ground: "terrain" });
		for (const b of out?.batches || []) {
			const m = b.mesh, o = m.origin, P = m.pos, I = m.idx, nT = I.length / 3;
			if (count + nT > maxTris) return;
			const buf = new Float32Array(nT * 9);
			const vx = new Float64Array(P.length / 3 * 3);
			for (let i = 0; i < P.length; i += 3) {   // 単位球の世界座標（高さは各棟の足元から）→ 局所の東・北・高さ
				const x = o[0] + P[i], y = o[1] + P[i + 1], z = o[2] + P[i + 2], rr = Math.hypot(x, y, z);
				vx[i] = (Math.atan2(z, x) - lon0) * kx; vx[i + 1] = (Math.asin(y / rr) - lat0) * ky; vx[i + 2] = (rr - 1) * R_EARTH;
			}
			for (let t = 0; t < nT; t++) for (let k = 0; k < 3; k++) { const v = I[t * 3 + k] * 3; buf[t * 9 + k * 3] = vx[v]; buf[t * 9 + k * 3 + 1] = vx[v + 1]; buf[t * 9 + k * 3 + 2] = vx[v + 2]; }
			tris.push(buf); count += nT;
		}
	};
	let i = 0;
	await Promise.all(Array.from({ length: 6 }, async () => { while (i < urls.length) { const u = urls[i++]; try { await one(u); } catch (err) { console.warn("[sunshadow] tile", u.uri, (err as Error | null)?.message); } } }));
	return { tris, count, tiles: urls.length, lon0, lat0, kx, ky };
}

// 本体。opts＝{ bbox:[w,s,e,n], tilesets?, sets?, mode:"instant"|"duration", date:ISO, decl?, hours:[8,16], step:0.5（時）, planeH:4（m）, cell?:m, maxCells? }
export async function computeSunShadow(opts: SunShadowOptions) {
	const { bbox, mode = "duration", planeH = 4, hours = [8, 16], step = 0.5 } = opts;
	const g = await gatherTriangles(opts);
	const { W, H, cell, spanX, spanY } = sunGrid(bbox, opts.cell, opts.maxCells ?? 1024 * 1024);
	const x0 = -spanX / 2, y1 = spanY / 2;   // 升目の左上（局所 m）
	const cnt = new Uint16Array(W * H), stamp = new Uint16Array(W * H);
	// 時刻の列（真太陽時）と赤緯（日影図の既定＝冬至）。瞬間＝与えた時計の時刻を真太陽時へ（経度と均時差）
	const { times, decl } = sunTimes({ mode, date: opts.date, decl: opts.decl, hours, step }, g.lon0 / D2R);
	const latDeg = g.lat0 / D2R;
	let used = 0;
	for (let si = 0; si < times.length; si++) {
		const sun = sunAt(latDeg, decl, times[si]);
		if (sun.alt <= 0.5 * D2R) continue;   // 日の出前・日没後＝数えない
		used++;
		const L = 1 / Math.tan(sun.alt), dx = -Math.sin(sun.az) * L, dy = -Math.cos(sun.az) * L, sid = si + 1;
		for (const buf of g.tris) for (let t = 0; t < buf.length; t += 9) {
			let hMax = Math.max(buf[t + 2], buf[t + 5], buf[t + 8]);
			if (hMax <= planeH) continue;   // 測定面より下の三角形は影を作らない
			const px: number[] = [], py: number[] = [];
			for (let k = 0; k < 3; k++) { const h = Math.max(0, buf[t + k * 3 + 2] - planeH); px.push((buf[t + k * 3] + h * dx - x0) / cell); py.push((y1 - (buf[t + k * 3 + 1] + h * dy)) / cell); }
			fillTri(px, py, W, H, stamp, cnt, sid);
		}
	}
	// 色付け（瞬間＝影の範囲／時間＝日影規制で使う 2・3・4・5 時間の段彩＋等時間線）＝sunshadow-core（GPU 版と同じ筆）
	const { rgba, maxH } = paintSunShadow(cnt, W, H, step, mode);
	// 指定地点の値（probe＝[[lon,lat]…]）＝日影時間（時）／瞬間は 0|1
	const probes = (opts.probe || []).map(([lo, la]) => {
		const x = Math.floor(((lo * D2R - g.lon0) * g.kx - x0) / cell), y = Math.floor((y1 - (la * D2R - g.lat0) * g.ky) / cell);
		const v = x >= 0 && y >= 0 && x < W && y < H ? cnt[y * W + x] : 0;
		return mode === "instant" ? (v ? 1 : 0) : +(v * step).toFixed(2);
	});
	return { rgba, w: W, h: H, bbox, cell, probes, stats: { triangles: g.count, tiles: g.tiles, steps: used, maxHours: +maxH.toFixed(2), decl: +decl.toFixed(2), planeH, mode } };
}

// 三角形を升目へ（外接矩形を舐めて辺関数で内外判定）。同じ時刻（sid）で塗った升目は数え直さない
function fillTri(px: number[], py: number[], W: number, H: number, stamp: Uint16Array, cnt: Uint16Array, sid: number): void {
	const minX = Math.max(0, Math.floor(Math.min(px[0], px[1], px[2]))), maxX = Math.min(W - 1, Math.ceil(Math.max(px[0], px[1], px[2])));
	const minY = Math.max(0, Math.floor(Math.min(py[0], py[1], py[2]))), maxY = Math.min(H - 1, Math.ceil(Math.max(py[0], py[1], py[2])));
	if (minX > maxX || minY > maxY) return;
	const area = (px[1] - px[0]) * (py[2] - py[0]) - (px[2] - px[0]) * (py[1] - py[0]);
	if (Math.abs(area) < 1e-9) return;   // 真横から見た壁＝面積ゼロ（隣の壁と屋根が埋める）
	const sg = area > 0 ? 1 : -1;
	for (let y = minY; y <= maxY; y++) {
		const cy = y + 0.5;
		for (let x = minX; x <= maxX; x++) {
			const cx = x + 0.5;
			const e0 = ((px[1] - px[0]) * (cy - py[0]) - (py[1] - py[0]) * (cx - px[0])) * sg;
			const e1 = ((px[2] - px[1]) * (cy - py[1]) - (py[2] - py[1]) * (cx - px[1])) * sg;
			const e2 = ((px[0] - px[2]) * (cy - py[2]) - (py[0] - py[2]) * (cx - px[2])) * sg;
			if (e0 >= 0 && e1 >= 0 && e2 >= 0) { const i = y * W + x; if (stamp[i] !== sid) { stamp[i] = sid; cnt[i]++; } }
		}
	}
}

// ── 可視域と見通し線（#44・2026-09-23）＝同じ worker。地表＝main が render worker の地形から升目で渡す（外来 DEM の上書き込み）・建物＝上と同じ読み方で高さの升目へ
// 地球の丸みと大気の屈折（係数 K_REFR＝0.13）で遠方は下がる。視点＝地表（建物の上ならその屋上）＋eyeH。
function buildingGrid(g: { tris: Float32Array[] }, W: number, H: number, cell: number, x0: number, y1: number): Float32Array<ArrayBuffer> {   // 升目ごとの建物の高さ（足元から・屋根の最大）
	const bh = new Float32Array(W * H);
	for (const buf of g.tris) for (let t = 0; t < buf.length; t += 9) {
		const hm = Math.max(buf[t + 2], buf[t + 5], buf[t + 8]); if (hm < 1) continue;
		const px = [(buf[t] - x0) / cell, (buf[t + 3] - x0) / cell, (buf[t + 6] - x0) / cell], py = [(y1 - buf[t + 1]) / cell, (y1 - buf[t + 4]) / cell, (y1 - buf[t + 7]) / cell];
		const minX = Math.max(0, Math.floor(Math.min(...px))), maxX = Math.min(W - 1, Math.ceil(Math.max(...px))), minY = Math.max(0, Math.floor(Math.min(...py))), maxY = Math.min(H - 1, Math.ceil(Math.max(...py)));
		const area = (px[1] - px[0]) * (py[2] - py[0]) - (px[2] - px[0]) * (py[1] - py[0]); if (Math.abs(area) < 1e-9) continue;
		const sg = area > 0 ? 1 : -1;
		for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
			const cx = x + 0.5, cy = y + 0.5;
			if (((px[1] - px[0]) * (cy - py[0]) - (py[1] - py[0]) * (cx - px[0])) * sg < 0) continue;
			if (((px[2] - px[1]) * (cy - py[1]) - (py[2] - py[1]) * (cx - px[1])) * sg < 0) continue;
			if (((px[0] - px[2]) * (cy - py[2]) - (py[0] - py[2]) * (cx - px[2])) * sg < 0) continue;
			const i = y * W + x; if (hm > bh[i]) bh[i] = hm;
		}
	}
	return bh;
}
// opts＝{ bbox, N, ground:Float32Array(N×N・row0＝北・画素の中心), observer:[lon,lat], eyeH:1.6, targetH:0, radius(m), buildings:true, tilesets?, sets?, probe?, los?:[lon,lat] }
export async function computeViewshed(opts: ViewshedOptions) {
	const { bbox, N, ground, observer, eyeH = 1.6, targetH = 0, radius = 1000 } = opts;
	const [w, s, e, n] = bbox, lat0 = (s + n) / 2 * D2R, lon0 = (w + e) / 2 * D2R, kx = Math.cos(lat0) * R_EARTH, ky = R_EARTH;
	const spanX = (e - w) * D2R * kx, spanY = (n - s) * D2R * ky, cellX = spanX / N, cellY = spanY / N, cell = (cellX + cellY) / 2;
	// 地表 S＝地形＋建物の屋根。surface を渡されたらそれ（GPU が描いた物から取った地表＝建物は読まない・2026-10-24）
	const g = opts.surface || opts.buildings === false ? { tris: [], count: opts.surface ? (opts.surfaceTris ?? 0) : 0, tiles: 0 } : await gatherTriangles({ ...opts, bbox });
	const bh = g.tris.length ? buildingGrid({ tris: g.tris }, N, N, cell, -spanX / 2, spanY / 2) : new Float32Array(N * N);
	const S = new Float32Array(N * N); for (let i = 0; i < N * N; i++) S[i] = opts.surface ? (opts.surface[i] || 0) : (ground[i] || 0) + bh[i];
	const toCell = ([lo, la]: number[]): number[] => [((lo - w) / (e - w)) * N, ((n - la) / (n - s)) * N];
	const [ox, oy] = toCell(observer), oi = Math.min(N - 1, Math.max(0, oy | 0)) * N + Math.min(N - 1, Math.max(0, ox | 0));
	const z0 = S[oi] + eyeH;
	const drop = (d: number): number => d * d / (2 * R_EARTH) * (1 - K_REFR);
	const rCells = radius / cell;
	// 光線を 1 本（視点→(tx,ty)）歩いて、見える升目に印。los＝その 1 本の結果を返す
	const vis = new Uint8Array(N * N);
	const ray = (tx: number, ty: number, mark = true): { visible: boolean; block: number[] | null } => {
		const dx = tx - ox, dy = ty - oy, L = Math.hypot(dx, dy); if (L < 1e-6) return { visible: true, block: null };
		const steps = Math.ceil(L * 2), sx = dx / steps, sy = dy / steps;
		let maxSlope = -Infinity, block: number[] | null = null, lastVis = true;
		for (let k = 1; k <= steps; k++) {
			const x = ox + sx * k, y = oy + sy * k, ix = x | 0, iy = y | 0;
			if (ix < 0 || iy < 0 || ix >= N || iy >= N) break;
			const d = Math.hypot((x - ox) * cellX, (y - oy) * cellY), i = iy * N + ix, dr = drop(d);
			const tSlope = (S[i] + targetH - dr - z0) / d;
			lastVis = tSlope >= maxSlope;
			if (mark && lastVis && Math.hypot(x - ox, y - oy) <= rCells) vis[i] = 1;
			const sSlope = (S[i] - dr - z0) / d;
			if (sSlope > maxSlope) { if (!block && k < steps - 1 && Math.hypot(x - ox, y - oy) > 1) block = [x, y]; maxSlope = sSlope; }
		}
		return { visible: lastVis, block };
	};
	let los: { visible: boolean; blockAt: number[] | null; distance: number; profile: number[][] } | null = null;
	if (opts.los) {   // 見通し線＝視点→目標の 1 本。遮る最初の点（目標より手前で視線より高い所）
		const [tx, ty] = toCell(opts.los), L = Math.hypot(tx - ox, ty - oy), steps = Math.ceil(L * 2), prof: number[][] = [];
		const zt = S[Math.min(N - 1, Math.max(0, ty | 0)) * N + Math.min(N - 1, Math.max(0, tx | 0))] + targetH;
		let blockAt: number[] | null = null;
		for (let k = 1; k < steps; k++) {
			const f = k / steps, x = ox + (tx - ox) * f, y = oy + (ty - oy) * f, i = Math.min(N - 1, Math.max(0, y | 0)) * N + Math.min(N - 1, Math.max(0, x | 0));
			const d = Math.hypot((x - ox) * cellX, (y - oy) * cellY), sight = z0 + (zt - drop(L * cell) - z0) * f + 0;   // 視線（直線）
			const surf = S[i] - drop(d);
			if (k % Math.max(1, steps >> 7) === 0) prof.push([+d.toFixed(1), +surf.toFixed(1), +sight.toFixed(1)]);
			if (!blockAt && surf > sight) blockAt = [w + x / N * (e - w), n - y / N * (n - s)];
		}
		los = { visible: !blockAt, blockAt, distance: +(L * cell).toFixed(1), profile: prof };
	} else {
		for (let x = 0; x < N; x++) { ray(x + 0.5, 0.5); ray(x + 0.5, N - 0.5); }
		for (let y = 0; y < N; y++) { ray(0.5, y + 0.5); ray(N - 0.5, y + 0.5); }
		vis[oi] = 1;
	}
	const { rgba, inR, seen } = opts.los ? { rgba: new Uint8ClampedArray(N * N * 4), inR: 0, seen: 0 } : paintViewshed(vis, N, ox, oy, rCells);   // 色付け＝sunshadow-core（GPU 版と同じ筆）
	const probes = (opts.probe || []).map(p => { const [x, y] = toCell(p); const ix = x | 0, iy = y | 0; return ix >= 0 && iy >= 0 && ix < N && iy < N ? vis[iy * N + ix] : 0; });
	return { rgba, w: N, h: N, bbox, probes, los, stats: { cells: inR, visibleRatio: inR ? +(seen / inR).toFixed(3) : 0, triangles: g.count, eyeZ: +z0.toFixed(1), cell: +cell.toFixed(2) } };
}
