// 断面とクリッピング平面（#111）の純関数＝レンダラの共有部（shadow.js と同じ置き方・2026-09-29 段 0・段 1 で水平面と箱）。
// 面は単位球ワールド（camera.js lonlatTo3D と同じ軸・β空間）の平面 n·X = c。残すのは n·X − c ≥ 0 の側。
// 精度：面からの距離は「main 原点からの相対位置」で測る＝d = n·rel + K・K = n·originPt − c（CPU f64）。
// 切り口が画面にある時は原点が面の近く＝K は小さい＝f32 に落としても桁落ちしない（影の 0.4m の甘さを持ち込まない）。
// 切らない限りどの関数も呼ばれない＝切っていない描画には一切関与しない。
import { lonlatTo3D, worldRadiusM, ellAxisRatio } from "./camera.js";

export const CLIP_MAX = 6;   // 面の枚数の上限（箱＝6 枚・本人裁定）＝WGSL の ClipP と対

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// 面の幾何は world（楕円体面＝S·β・S＝diag(1, b/a, 1)・単位＝赤道半径 a）で作り、描画の β 空間へ移す：
// n_w·Y = c（Y＝S·X）⇔ (S·n_w)·X = c。β の法線を単位に正規化して返す（シェーダの d＝n·rel + K）。球では S＝単位＝同一。
// β 空間で直に作ると、楕円体では水平面が測地法線から最大 0.19° 傾く（1 km 先で 3 m 狂う）＝world で作るのが正
function toBeta(nw, cw) {
	const r = ellAxisRatio(), nb = [nw[0], r * nw[1], nw[2]], l = Math.hypot(nb[0], nb[1], nb[2]);
	return [nb[0] / l, nb[1] / l, nb[2] / l, cw / l];
}
// 接地の局所系（world）：P＝地表の点（高さ h m）・up＝測地法線（単位）・east＝経度の増える向き・north＝測地の北（3 本とも直交・単位）
function localFrame(lon, lat, h = 0) {
	const a = lon * Math.PI / 180, b = lat * Math.PI / 180, r = ellAxisRatio(), u = lonlatTo3D(lon, lat), k = h / worldRadiusM();
	const up = [Math.cos(b) * Math.cos(a), Math.sin(b), Math.cos(b) * Math.sin(a)];
	const P = [u[0] + up[0] * k, r * u[1] + up[1] * k, u[2] + up[2] * k];
	return { P, up, east: [-Math.sin(a), 0, Math.cos(a)], north: [-Math.sin(b) * Math.cos(a), Math.cos(b), -Math.sin(b) * Math.sin(a)] };
}

// 鉛直面：2 点 a→b（[lon,lat]）を通り、中点で鉛直（測地法線＝標高の持ち上げと同じ向き）。a→b に向かって右側を残す。
// 戻り＝[nx, ny, nz, c]（β 空間・n は単位）。a と b が同じ点なら null
export function clipPlaneVertical(a, b) {
	let dl = b[0] - a[0]; if (dl > 180) dl -= 360; else if (dl < -180) dl += 360;   // 日付変更線を跨ぐ 2 点は短い方の中点
	const A = localFrame(a[0], a[1]).P, B = localFrame(b[0], b[1]).P, up = localFrame(a[0] + dl / 2, (a[1] + b[1]) / 2).up;
	const n0 = cross(up, [B[0] - A[0], B[1] - A[1], B[2] - A[2]]);   // ワールドの軸（x=経度0・y=北極・z=経度90°）は地理の東北上と逆手＝この順で右側が正
	if (Math.hypot(n0[0], n0[1], n0[2]) < 1e-15) return null;
	const n = norm(n0);
	return toBeta(n, dot(n, A));
}

// 水平面：at＝[lon,lat] の接平面を高さ h(m) に置く。keep＝"below"（既定・下を残す＝上の階を外して中を見る）|"above"。
// 平面＝中心から離れるほど地表から浮く（1 km で 8 cm・10 km で 8 m）＝局所の断面向き
export function clipPlaneHorizontal(at, h = 0, keep = "below") {
	const { up, P } = localFrame(at[0], at[1], h), s = keep === "above" ? 1 : -1, n = [up[0] * s, up[1] * s, up[2] * s];
	return toBeta(n, dot(n, P));
}

// 箱：center＝[lon,lat]・size＝[東西の幅, 南北の奥行き](m)・h＝[底, 天](m)・bearing＝奥行きの向き（北から時計回り・度）。内側だけ残す＝6 枚
export function clipBox({ center, size = [200, 200], h = [-500, 9000], bearing = 0 }) {
	const { up, east, north, P: C } = localFrame(center[0], center[1], (h[0] + h[1]) / 2), Re = worldRadiusM();
	const t = bearing * Math.PI / 180, ct = Math.cos(t), st = Math.sin(t);
	const fwd = [north[0] * ct + east[0] * st, north[1] * ct + east[1] * st, north[2] * ct + east[2] * st];
	const right = [east[0] * ct - north[0] * st, east[1] * ct - north[1] * st, east[2] * ct - north[2] * st];
	const out = [];
	for (const [ax, half] of [[right, size[0] / 2], [fwd, size[1] / 2], [up, (h[1] - h[0]) / 2]]) {
		const r = half / Re, c0 = dot(ax, C);
		out.push(toBeta(ax, c0 - r));                           // ax·Y ≥ ax·C − r
		out.push(toBeta([-ax[0], -ax[1], -ax[2]], -c0 - r));   // ax·Y ≤ ax·C + r
	}
	return out;
}

// 切り方の記述 → 面の列（全部の面で残る側＝交わり）。
// spec＝{ planes?: [[nx,ny,nz,c]…], vertical?: [[a, b]…], horizontal?: [{ at, h, keep }…], box?: { center, size, h, bearing }, param?: "?clip= の文字列" }。7 枚目からは捨てる
export function clipPlanes(spec) {
	const out = [];
	if (spec?.param) { const q = parseClipParam(spec.param); if (q) out.push(...clipPlanes(q)); }   // URL の書き方（globe の ?clip=）＝読み解きはここ 1 か所
	for (const p of spec?.planes || []) if (p && p.length >= 4) out.push([+p[0], +p[1], +p[2], +p[3]]);
	for (const [a, b] of spec?.vertical || []) { const p = clipPlaneVertical(a, b); if (p) out.push(p); }
	for (const o of spec?.horizontal || []) if (o?.at) out.push(clipPlaneHorizontal(o.at, +o.h || 0, o.keep));
	if (spec?.box?.center) out.push(...clipBox(spec.box));
	return out.slice(0, CLIP_MAX);
}

// URL の書き方（?clip=）→ spec。区切り＝";"・各項：
//   lon1,lat1,lon2,lat2            … 鉛直面（a→b に向かって右側を残す）
//   h:lon,lat,高さ[,above]         … 水平面（既定は下を残す）
//   box:lon,lat,幅,奥行き[,底,天[,向き]] … 箱（内側を残す）
// 読めない項は捨てる。1 つも読めなければ null
export function parseClipParam(q) {
	if (!q) return null;
	const spec = { vertical: [], horizontal: [], box: null };
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

// 面の uniform（ClipP＝pl[6]・p）＝pl[i]＝(n.xyz, K)・K＝n·originPt − c（f64 で引いてから f32 へ）・p.x＝枚数。
// originPt＝その描画の原点の単位球点（lonlatTo3D・f64）＝main（地形・建物・メッシュ・球の床）／base／user（基図と利用者の層の塗りと線）
export function packClip(planes, originPt, out = new Float32Array(CLIP_MAX * 4 + 4)) {
	out.fill(0);
	const n = Math.min(planes.length, CLIP_MAX);
	for (let i = 0; i < n; i++) {
		const [x, y, z, c] = planes[i];
		out[i * 4] = x; out[i * 4 + 1] = y; out[i * 4 + 2] = z;
		out[i * 4 + 3] = x * originPt[0] + y * originPt[1] + z * originPt[2] - c;
	}
	out[CLIP_MAX * 4] = n;
	return out;
}

// 点 [lon,lat,hM] が残る側か（検定と問い合わせ用）＝面ごとの距離(m・楕円体でも実寸) の最小（負＝切られる）
export function clipDistanceM(planes, lon, lat, hM = 0) {
	const Re = worldRadiusM(), r = ellAxisRatio(), Y = localFrame(lon, lat, hM).P;
	let d = Infinity;
	for (const [x, y, z, c] of planes) { const l = Math.hypot(x, y / r, z); d = Math.min(d, (x * Y[0] + y / r * Y[1] + z * Y[2] - c) / l * Re); }   // β の面を world へ戻す（n_w＝S⁻¹·n_β）
	return d;
}
