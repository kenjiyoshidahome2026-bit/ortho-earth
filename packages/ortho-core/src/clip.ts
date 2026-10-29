// 断面とクリッピング平面（#111）の純関数＝レンダラの共有部（shadow.js と同じ置き方・2026-09-29 段 0・段 1 で水平面と箱）。
// 面は単位球ワールド（camera.js lonlatTo3D と同じ軸・β空間）の平面 n·X = c。残すのは n·X − c ≥ 0 の側。
// 精度：面からの距離は「main 原点からの相対位置」で測る＝d = n·rel + K・K = n·originPt − c（CPU f64）。
// 切り口が画面にある時は原点が面の近く＝K は小さい＝f32 に落としても桁落ちしない（影の 0.4m の甘さを持ち込まない）。
// 切らない限りどの関数も呼ばれない＝切っていない描画には一切関与しない。
import { lonlatTo3D, worldRadiusM, ellAxisRatio } from "./camera.ts";

export const CLIP_MAX = 6;   // 面の枚数の上限（箱＝6 枚・本人裁定）＝WGSL の ClipP と対
export const CLIP_POLY_MAX = 64;   // 多角形の辺の上限（全部の輪の合計・超えたら間引く）＝WGSL の ClipP.pv と対

/** 平面＝[nx, ny, nz, c]（β 空間） */
export type ClipPlane = number[];
export const CLIP_TARGETS = ["terrain", "buildings", "models", "vector", "labels"] as const;   // 地形（床・蓋）／基図の押し出しと建物メッシュ／模型・3D Tiles・I3S・押し出し／塗り・線・gint・外部ベクタ・同一フレームのオーバーレイ／注記
export type ClipTarget = (typeof CLIP_TARGETS)[number];
export interface ClipBoxSpec { center: [number, number] | number[]; size?: [number, number] | number[]; h?: [number, number] | number[]; bearing?: number }
export interface ClipHorizontalSpec { at: [number, number] | number[]; h?: number; keep?: "below" | "above" | string }
/** 切り方の記述（1 群） */
export interface ClipSpec {
	planes?: (number[] | null | undefined)[];
	/** 地球固定の直交座標（ECEF・m＝x 経度 0・y 東経 90°・z 北極）の平面 [nx, ny, nz, d]＝n·P + d ≥ 0 を残す（Cesium の ClippingPlane を変換行列で移した物と同じ書き方） */
	ecef?: (number[] | null | undefined)[];
	vertical?: [number[], number[]][]; horizontal?: (ClipHorizontalSpec | null | undefined)[]; box?: ClipBoxSpec | null; param?: string | null;
	/** 多角形（Cesium の ClippingPolygon）＝GeoJSON の Polygon・MultiPolygon（Feature・FeatureCollection も）か輪の列 [[lon,lat]…][]。既定は内側を消す・inverse＝内側だけ残す */
	polygon?: unknown; inverse?: boolean;
	targets?: string[]; on?: boolean;
	cap?: false | { terrain?: number[]; building?: number[] } | null; edge?: false | { width?: number | string; color?: number[] } | null;
}
export interface ClipStyle { capOn: boolean; capTerrain: number[]; capBuilding: number[]; edgeColor: number[]; edgeWidth: number }
export interface ClipGroup { spec: ClipSpec; targets: Set<string> }
export interface ClipNorm { groups: ClipGroup[]; style: ClipStyle }

const dot = (a: ArrayLike<number>, b: ArrayLike<number>): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: ArrayLike<number>, b: ArrayLike<number>): number[] => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: ArrayLike<number>): number[] => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// 面の幾何は world（楕円体面＝S·β・S＝diag(1, b/a, 1)・単位＝赤道半径 a）で作り、描画の β 空間へ移す：
// n_w·Y = c（Y＝S·X）⇔ (S·n_w)·X = c。β の法線を単位に正規化して返す（シェーダの d＝n·rel + K）。球では S＝単位＝同一。
// β 空間で直に作ると、楕円体では水平面が測地法線から最大 0.19° 傾く（1 km 先で 3 m 狂う）＝world で作るのが正
function toBeta(nw: ArrayLike<number>, cw: number): ClipPlane {
	const r = ellAxisRatio(), nb = [nw[0], r * nw[1], nw[2]], l = Math.hypot(nb[0], nb[1], nb[2]);
	return [nb[0] / l, nb[1] / l, nb[2] / l, cw / l];
}
// 接地の局所系（world）：P＝地表の点（高さ h m）・up＝測地法線（単位）・east＝経度の増える向き・north＝測地の北（3 本とも直交・単位）
function localFrame(lon: number, lat: number, h = 0): { P: number[]; up: number[]; east: number[]; north: number[] } {
	const a = lon * Math.PI / 180, b = lat * Math.PI / 180, r = ellAxisRatio(), u = lonlatTo3D(lon, lat), k = h / worldRadiusM();
	const up = [Math.cos(b) * Math.cos(a), Math.sin(b), Math.cos(b) * Math.sin(a)];
	const P = [u[0] + up[0] * k, r * u[1] + up[1] * k, u[2] + up[2] * k];
	return { P, up, east: [-Math.sin(a), 0, Math.cos(a)], north: [-Math.sin(b) * Math.cos(a), Math.cos(b), -Math.sin(b) * Math.sin(a)] };
}

// 鉛直面：2 点 a→b（[lon,lat]）を通り、中点で鉛直（測地法線＝標高の持ち上げと同じ向き）。a→b に向かって右側を残す。
// 戻り＝[nx, ny, nz, c]（β 空間・n は単位）。a と b が同じ点なら null
export function clipPlaneVertical(a: ArrayLike<number>, b: ArrayLike<number>): ClipPlane | null {
	let dl = b[0] - a[0]; if (dl > 180) dl -= 360; else if (dl < -180) dl += 360;   // 日付変更線を跨ぐ 2 点は短い方の中点
	const A = localFrame(a[0], a[1]).P, B = localFrame(b[0], b[1]).P, up = localFrame(a[0] + dl / 2, (a[1] + b[1]) / 2).up;
	const n0 = cross(up, [B[0] - A[0], B[1] - A[1], B[2] - A[2]]);   // ワールドの軸（x=経度0・y=北極・z=経度90°）は地理の東北上と逆手＝この順で右側が正
	if (Math.hypot(n0[0], n0[1], n0[2]) < 1e-15) return null;
	const n = norm(n0);
	return toBeta(n, dot(n, A));
}

// 水平面：at＝[lon,lat] の接平面を高さ h(m) に置く。keep＝"below"（既定・下を残す＝上の階を外して中を見る）|"above"。
// 平面＝中心から離れるほど地表から浮く（1 km で 8 cm・10 km で 8 m）＝局所の断面向き
export function clipPlaneHorizontal(at: ArrayLike<number>, h = 0, keep: string | undefined = "below"): ClipPlane {
	const { up, P } = localFrame(at[0], at[1], h), s = keep === "above" ? 1 : -1, n = [up[0] * s, up[1] * s, up[2] * s];
	return toBeta(n, dot(n, P));
}

// 箱：center＝[lon,lat]・size＝[東西の幅, 南北の奥行き](m)・h＝[底, 天](m)・bearing＝奥行きの向き（北から時計回り・度）。内側だけ残す＝6 枚
export function clipBox({ center, size = [200, 200], h = [-500, 9000], bearing = 0 }: ClipBoxSpec): ClipPlane[] {
	const { up, east, north, P: C } = localFrame(center[0], center[1], (h[0] + h[1]) / 2), Re = worldRadiusM();
	const t = bearing * Math.PI / 180, ct = Math.cos(t), st = Math.sin(t);
	const fwd = [north[0] * ct + east[0] * st, north[1] * ct + east[1] * st, north[2] * ct + east[2] * st];
	const right = [east[0] * ct - north[0] * st, east[1] * ct - north[1] * st, east[2] * ct - north[2] * st];
	const out: ClipPlane[] = [];
	for (const [ax, half] of [[right, size[0] / 2], [fwd, size[1] / 2], [up, (h[1] - h[0]) / 2]] as [number[], number][]) {
		const r = half / Re, c0 = dot(ax, C);
		out.push(toBeta(ax, c0 - r));                           // ax·Y ≥ ax·C − r
		out.push(toBeta([-ax[0], -ax[1], -ax[2]], -c0 - r));   // ax·Y ≤ ax·C + r
	}
	return out;
}

// ECEF の平面 [nx, ny, nz, d]（m・n·P + d ≥ 0 を残す）→ β 空間。world の軸は (x, y, z)＝(ECEF x, ECEF z, ECEF y)・単位＝worldRadiusM
export function clipPlaneEcef(p: ArrayLike<number>): ClipPlane | null {
	const l = Math.hypot(p[0], p[1], p[2]);
	if (!(l > 0)) return null;
	return toBeta([p[0] / l, p[2] / l, p[1] / l], -p[3] / l / worldRadiusM());
}

// 切り方の記述 → 面の列（全部の面で残る側＝交わり）。
// spec＝{ planes?: [[nx,ny,nz,c]…], vertical?: [[a, b]…], horizontal?: [{ at, h, keep }…], box?: { center, size, h, bearing }, param?: "?clip= の文字列" }。7 枚目からは捨てる
export function clipPlanes(spec: ClipSpec | null | undefined): ClipPlane[] {
	const out: ClipPlane[] = [];
	if (spec?.param) { const q = parseClipParam(spec.param); if (q) out.push(...clipPlanes(q)); }   // URL の書き方（globe の ?clip=）＝読み解きはここ 1 か所
	for (const p of spec?.planes || []) if (p && p.length >= 4) out.push([+p[0], +p[1], +p[2], +p[3]]);
	for (const p of spec?.ecef || []) { const q = p && p.length >= 4 ? clipPlaneEcef(p) : null; if (q) out.push(q); }
	for (const [a, b] of spec?.vertical || []) { const p = clipPlaneVertical(a, b); if (p) out.push(p); }
	for (const o of spec?.horizontal || []) if (o?.at) out.push(clipPlaneHorizontal(o.at, +o.h! || 0, o.keep));
	if (spec?.box?.center) out.push(...clipBox(spec.box));
	return out.slice(0, CLIP_MAX);
}

// ── 対象ごとの面（段 4）：切り方は「群」の並び。群＝{ vertical?, horizontal?, box?, planes?, param?, targets? }（targets 省略＝全部）。
// 配列を渡すと群ごとに対象を変えられる（例：地形は箱で・建物は水平面で）。蓋と縁の帯（cap・edge）は最初に書いた群の値
export function normClip(data: ClipSpec | ClipSpec[] | null | undefined): ClipNorm | null {
	if (!data || (data as ClipSpec).on === false) return null;
	const groups = (Array.isArray(data) ? data : [data]).filter(g => g && g.on !== false).map(g => ({ spec: g, targets: new Set<string>(Array.isArray(g.targets) && g.targets.length ? g.targets : CLIP_TARGETS) }));
	if (!groups.length) return null;
	const sg = groups.find(g => "cap" in g.spec || "edge" in g.spec);
	return { groups, style: clipStyle(sg ? sg.spec : null) };
}
// その対象の面（群を順に・6 枚まで）
export function clipPlanesFor(norm: ClipNorm | null | undefined, target: string): ClipPlane[] {
	if (!norm) return [];
	const out: ClipPlane[] = [];
	for (const g of norm.groups) if (g.targets.has(target)) out.push(...clipPlanes(g.spec));
	return out.slice(0, CLIP_MAX);
}
// ── 多角形で切る（Cesium の ClippingPolygon・P0 #4・2026-10-25）。面（平面）の交わりとは別に、多角形の内側（inverse＝外側）を消す。
// 多角形の重心の接平面に平らに写した 2D（β 空間の東・北の単位ベクトルへの射影）で、画素の点の内外（偶奇）と辺までの距離を出す。
// 距離の符号＝残る側が正＝面の距離と同じ扱いで最小を取れる（縁の帯もそのまま効く）。高さは問わない＝鉛直の柱で切る（Cesium と同じ）。
// 射影の軸は重心の動径に垂直＝離れた点ほど鉛直から傾く（5 km 先の 300 m の塔で 0.24 m）
export interface ClipPoly { C: number[]; e: number[]; n: number[]; edges: number[][]; inverse: boolean }
type GeoIn = { type?: string; geometry?: GeoIn; features?: GeoIn[]; geometries?: GeoIn[]; coordinates?: unknown };
/** 多角形の記述 → 輪の列（[lon,lat][]・閉じの重複なし） */
export function clipPolygonRings(src: unknown): number[][][] {
	const rings: number[][][] = [];
	const ring = (r: unknown) => { if (!Array.isArray(r)) return; const out = r.filter(c => Array.isArray(c) && Number.isFinite(+c[0]) && Number.isFinite(+c[1])).map(c => [+c[0], +c[1]]); if (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop(); if (out.length >= 3) rings.push(out); };
	const walk = (g: GeoIn | null | undefined): void => {
		if (!g || typeof g !== "object") return;
		if (Array.isArray(g)) { const a = g as unknown[]; if (Array.isArray(a[0]) && Array.isArray((a[0] as unknown[])[0])) for (const r of a) ring(r); else ring(a); return; }   // 輪の列か輪 1 本
		if (g.type === "FeatureCollection") return void (g.features || []).forEach(walk);
		if (g.type === "Feature") return walk(g.geometry);
		if (g.type === "GeometryCollection") return void (g.geometries || []).forEach(walk);
		const c = g.coordinates as unknown[];
		if (g.type === "Polygon" && Array.isArray(c)) for (const r of c) ring(r);
		else if (g.type === "MultiPolygon" && Array.isArray(c)) for (const p of c) for (const r of p as unknown[]) ring(r);
	};
	walk(src as GeoIn);
	return rings;
}
/** 切り方の記述 → 多角形（輪が無ければ null）。辺が CLIP_POLY_MAX を超える時は輪ごとに一様に間引く */
export function clipPolygon(spec: ClipSpec | null | undefined): ClipPoly | null {
	if (!spec || spec.polygon == null) return null;
	let rings = clipPolygonRings(spec.polygon);
	if (!rings.length) return null;
	const total = rings.reduce((a, r) => a + r.length, 0);
	if (total > CLIP_POLY_MAX) {
		const k = CLIP_POLY_MAX / total;
		rings = rings.map(r => { const m = Math.max(3, Math.floor(r.length * k)); return Array.from({ length: m }, (_, i) => r[Math.floor(i * r.length / m)]); });
		while (rings.reduce((a, r) => a + r.length, 0) > CLIP_POLY_MAX && rings.length > 1) rings.pop();   // 小さい輪が多すぎる＝後ろの輪を落とす
	}
	// 重心（経度は最初の点の近くへ寄せる＝日付変更線を跨ぐ輪）
	const l0 = rings[0][0][0]; let sx = 0, sy = 0, n = 0;
	for (const r of rings) for (const c of r) { let l = c[0]; while (l - l0 > 180) l -= 360; while (l - l0 < -180) l += 360; sx += l; sy += c[1]; n++; }
	const C = lonlatTo3D(sx / n, sy / n), up = norm(C);
	const e0 = cross(up, [0, 1, 0]), e = Math.hypot(e0[0], e0[1], e0[2]) < 1e-9 ? [0, 0, 1] : norm(e0), nn = cross(e, up);   // 東（上×y 軸・極では z）・北（東×上）＝β 空間の接平面の正規直交基底
	const xy = (c: number[]) => { const p = lonlatTo3D(c[0], c[1]), d = [p[0] - C[0], p[1] - C[1], p[2] - C[2]]; return [dot(e, d), dot(nn, d)]; };
	const edges: number[][] = [];
	for (const r of rings) { const q = r.map(xy); for (let i = 0; i < q.length; i++) { const a = q[i], b = q[(i + 1) % q.length]; edges.push([a[0], a[1], b[0], b[1]]); } }
	return { C, e, n: nn, edges: edges.slice(0, CLIP_POLY_MAX), inverse: !!spec.inverse };
}
/** その対象の多角形（最初に書いた群の物・対象を問う） */
export function clipPolygonFor(norm: ClipNorm | null | undefined, target: string): ClipPoly | null {
	if (!norm) return null;
	for (const g of norm.groups) if (g.targets.has(target)) { const p = clipPolygon(g.spec); if (p) return p; }
	return null;
}
/** 点 [lon,lat] が多角形で残る側か＝符号付きの距離（m・負＝切られる）。検定と問い合わせ用 */
export function clipPolygonDistanceM(poly: ClipPoly, lon: number, lat: number): number {
	const p = lonlatTo3D(lon, lat), d = [p[0] - poly.C[0], p[1] - poly.C[1], p[2] - poly.C[2]];
	const x = dot(poly.e, d), y = dot(poly.n, d);
	let inside = false, dm = Infinity;
	for (const [ax, ay, bx, by] of poly.edges) {
		if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
		const vx = bx - ax, vy = by - ay, t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy || 1)));
		dm = Math.min(dm, Math.hypot(x - ax - t * vx, y - ay - t * vy));
	}
	const s = (inside ? -1 : 1) * (poly.inverse ? -1 : 1);
	return s * dm * worldRadiusM();
}

// 同一フレームのオーバーレイ（自前の GPU シェーダ）へ渡す面の uniform＝pl[6]＋p（112B・WGSL の ClipP の先頭と同じ並び）。K＝n·(その原点) − c を f64 で
export function clipPackOrigin(planes: ClipPlane[], origin: ArrayLike<number>): Float32Array {
	return packClip(planes, lonlatTo3D(origin[0], origin[1])).slice(0, (CLIP_MAX + 1) * 4);
}

// URL の書き方（?clip=）→ spec。区切り＝";"・各項：
//   lon1,lat1,lon2,lat2            … 鉛直面（a→b に向かって右側を残す）
//   h:lon,lat,高さ[,above]         … 水平面（既定は下を残す）
//   box:lon,lat,幅,奥行き[,底,天[,向き]] … 箱（内側を残す）
// 読めない項は捨てる。1 つも読めなければ null
export function parseClipParam(q: string | null | undefined): ClipSpec | null {
	if (!q) return null;
	const spec: { vertical: [number[], number[]][]; horizontal: ClipHorizontalSpec[]; box: ClipBoxSpec | null } = { vertical: [], horizontal: [], box: null };
	for (const raw of String(q).split(";")) {
		const [kind, rest] = raw.includes(":") ? raw.split(":", 2) : ["v", raw];
		const parts = rest.split(","), v = parts.map(Number);
		if (kind === "v" && v.length === 4 && v.every(Number.isFinite)) spec.vertical.push([[v[0], v[1]], [v[2], v[3]]]);
		else if (kind === "h" && v.length >= 3 && v.slice(0, 3).every(Number.isFinite)) spec.horizontal.push({ at: [v[0], v[1]], h: v[2], keep: parts[3] === "above" ? "above" : "below" });
		else if (kind === "box" && v.length >= 4 && v.slice(0, 4).every(Number.isFinite)) {
			const hh = v.length >= 6 && Number.isFinite(v[4]) && Number.isFinite(v[5]) ? [v[4], v[5]] : undefined;
			spec.box = { center: [v[0], v[1]], size: [v[2], v[3]], ...(hh ? { h: hh } : {}), bearing: Number.isFinite(v[6]) ? v[6] : 0 };
		}
	}
	return spec.vertical.length || spec.horizontal.length || spec.box ? spec : null;
}

// 蓋と縁の帯の既定（段 2）：地形の断面＝土の色・建物の疑似の蓋＝石の灰・帯＝橙 2 px（CSS px）。spec.cap＝false で蓋なし・spec.edge＝{ width, color }（width 0＝帯なし）
export const CLIP_STYLE: { capTerrain: number[]; capBuilding: number[]; edgeColor: number[]; edgeWidth: number } = { capTerrain: [0.60, 0.50, 0.38], capBuilding: [0.43, 0.46, 0.50], edgeColor: [0.93, 0.42, 0.13], edgeWidth: 2 };
export function clipStyle(spec: ClipSpec | null | undefined): ClipStyle {
	const cap = spec?.cap, edge = spec?.edge;
	return {
		capOn: cap !== false,
		capTerrain: (cap && cap.terrain) || CLIP_STYLE.capTerrain,
		capBuilding: (cap && cap.building) || CLIP_STYLE.capBuilding,
		edgeColor: (edge && edge.color) || CLIP_STYLE.edgeColor,
		edgeWidth: edge === false ? 0 : edge && edge.width != null ? +edge.width : CLIP_STYLE.edgeWidth,
	};
}

// 面の uniform（ClipP＝pl[6]・p・capT・capB・edgeC＝160B）＝pl[i]＝(n.xyz, K)・K＝n·originPt − c（f64 で引いてから f32 へ）・p＝(枚数, 帯の幅 px, 0, 0)。
// capT＝地形の蓋の色（w＝点ける）・capB＝建物の疑似の蓋の色（w＝点ける）・edgeC＝帯の色。
// originPt＝その描画の原点の単位球点（lonlatTo3D・f64）＝main（地形・建物・メッシュ・模型・球の床）／base／user（基図と利用者の層の塗りと線）
// 多角形（P0 #4）＝pe・pn（東・北の単位ベクトル xyz, K＝軸·(originPt − C)）・pv[i]＝辺 (ax, ay, bx, by)（重心の接平面の 2D）・p.z＝辺の数・p.w＝1 で内側だけ残す
export const CLIP_F32 = (CLIP_MAX + 4 + 2 + CLIP_POLY_MAX) * 4;
export function packClip(planes: ClipPlane[], originPt: ArrayLike<number>, out: Float32Array = new Float32Array(CLIP_F32), style: ClipStyle = clipStyle(null), poly: ClipPoly | null = null): Float32Array {
	out.fill(0, 0, CLIP_F32);
	const n = Math.min(planes.length, CLIP_MAX);
	for (let i = 0; i < n; i++) {
		const [x, y, z, c] = planes[i];
		out[i * 4] = x; out[i * 4 + 1] = y; out[i * 4 + 2] = z;
		out[i * 4 + 3] = x * originPt[0] + y * originPt[1] + z * originPt[2] - c;
	}
	const o = CLIP_MAX * 4;
	out[o] = n; out[o + 1] = style.edgeWidth;
	out.set(style.capTerrain, o + 4); out[o + 7] = style.capOn ? 1 : 0;
	out.set(style.capBuilding, o + 8); out[o + 11] = style.capOn ? 1 : 0;
	out.set(style.edgeColor, o + 12);
	if (poly && poly.edges.length) {
		const d = [originPt[0] - poly.C[0], originPt[1] - poly.C[1], originPt[2] - poly.C[2]], q = o + 16;
		out[o + 2] = poly.edges.length; out[o + 3] = poly.inverse ? 1 : 0;
		out[q] = poly.e[0]; out[q + 1] = poly.e[1]; out[q + 2] = poly.e[2]; out[q + 3] = dot(poly.e, d);
		out[q + 4] = poly.n[0]; out[q + 5] = poly.n[1]; out[q + 6] = poly.n[2]; out[q + 7] = dot(poly.n, d);
		poly.edges.forEach((ed, i) => out.set(ed, q + 8 + i * 4));
	}
	return out;
}

// 点 [lon,lat,hM] が残る側か（検定と問い合わせ用）＝面ごとの距離(m・楕円体でも実寸) の最小（負＝切られる）
export function clipDistanceM(planes: ClipPlane[], lon: number, lat: number, hM = 0): number {
	const Re = worldRadiusM(), r = ellAxisRatio(), Y = localFrame(lon, lat, hM).P;
	let d = Infinity;
	for (const [x, y, z, c] of planes) { const l = Math.hypot(x, y / r, z); d = Math.min(d, (x * Y[0] + y / r * Y[1] + z * Y[2] - c) / l * Re); }   // β の面を world へ戻す（n_w＝S⁻¹·n_β）
	return d;
}
