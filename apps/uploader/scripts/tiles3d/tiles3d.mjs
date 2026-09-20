// Cesium 3D Tiles の木を降りて、指定の地点を含む最詳細タイル（b3dm）を取り、glb を抜き出す（依存ゼロ）。
// 要点 ①サブ tileset の root は transform を持つ＝boundingVolume は局所座標。降りながら行列を積む
//      ②選ぶのは「中心が近い子」ではなく「点を含む子」＝OBB の厳密判定（重なる子が複数ある木では中心距離だと外す）
const A = 6378137, F = 1 / 298.257223563, E2 = F * (2 - F);
export const ecefToLonLat = (x, y, z) => {
	const lon = Math.atan2(y, x) * 180 / Math.PI, p = Math.hypot(x, y);
	let lat = Math.atan2(z, p * (1 - E2));
	for (let i = 0; i < 6; i++) { const s = Math.sin(lat), N = A / Math.sqrt(1 - E2 * s * s); lat = Math.atan2(z + E2 * N * s, p); }
	return [lon, lat * 180 / Math.PI];
};
export const lonLatToEcef = (lon, lat, h = 0) => {
	const la = lat * Math.PI / 180, lo = lon * Math.PI / 180, s = Math.sin(la), N = A / Math.sqrt(1 - E2 * s * s);
	return [(N + h) * Math.cos(la) * Math.cos(lo), (N + h) * Math.cos(la) * Math.sin(lo), (N * (1 - E2) + h) * s];
};
const I4 = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];                       // 3D Tiles は列優先
const mul = (a, b) => { const o = new Array(16).fill(0);
	for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; };
const pt = (m, p) => [m[0]*p[0] + m[4]*p[1] + m[8]*p[2] + m[12], m[1]*p[0] + m[5]*p[1] + m[9]*p[2] + m[13], m[2]*p[0] + m[6]*p[1] + m[10]*p[2] + m[14]];
const vec = (m, p) => [m[0]*p[0] + m[4]*p[1] + m[8]*p[2], m[1]*p[0] + m[5]*p[1] + m[9]*p[2], m[2]*p[0] + m[6]*p[1] + m[10]*p[2]];
const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2], len = a => Math.hypot(a[0], a[1], a[2]);
// P（ECEF）が bv（局所 OBB・行列 m）の中か。戻り＝はみ出し距離（m・0 以下＝中）
export function outside(bv, m, P) {
	if (bv.sphere) { const c = pt(m, [bv.sphere[0], bv.sphere[1], bv.sphere[2]]); return len([P[0]-c[0], P[1]-c[1], P[2]-c[2]]) - bv.sphere[3]; }
	if (bv.region) { const [w, s, e, n] = bv.region, [lo, la] = ecefToLonLat(P[0], P[1], P[2]), R = 180 / Math.PI;
		return Math.max(w * R - lo, lo - e * R, s * R - la, la - n * R) * 111320; }
	if (!bv.box) return Infinity;
	const C = pt(m, [bv.box[0], bv.box[1], bv.box[2]]);
	const d = [P[0]-C[0], P[1]-C[1], P[2]-C[2]];
	let worst = -Infinity;
	for (let i = 0; i < 3; i++) {
		const ax = vec(m, [bv.box[3 + i*3], bv.box[4 + i*3], bv.box[5 + i*3]]), L = len(ax);
		if (L < 1e-9) continue;
		worst = Math.max(worst, Math.abs(dot(d, ax) / L) - L);
	}
	return worst;
}
const getJson = async u => { const r = await fetch(u); if (!r.ok) throw new Error(`${r.status} ${u}`); return r.json(); };
// bbox（[w,s,e,n]・度）に重なる葉タイルを全部集める
export async function collectTiles(tilesetUrl, bbox, { maxNodes = 20000, minGE = 0 } = {}) {
	const R = 180 / Math.PI, hits = [], seenUrl = new Set();
	let seen = 0;
	const hitBox = (bv, m) => {   // region は度で、box は ECEF＝bbox 四隅の ECEF で粗く判定
		if (bv.region) { const [w, s, e, n] = bv.region; return !(e * R < bbox[0] || w * R > bbox[2] || n * R < bbox[1] || s * R > bbox[3]); }
		for (const [lo, la] of [[bbox[0],bbox[1]],[bbox[2],bbox[1]],[bbox[0],bbox[3]],[bbox[2],bbox[3]],[(bbox[0]+bbox[2])/2,(bbox[1]+bbox[3])/2]])
			if (outside(bv, m, lonLatToEcef(lo, la, 60)) <= 0) return true;
		return false;
	};
	const walk = async (node, M, base, depth) => {
		if (++seen > maxNodes) return;
		const uri = node.content?.uri;
		const kids = node.children || [];
		if (uri) {
			const u = new URL(uri, base).href;
			if (/\.json$/i.test(u)) { const j = await getJson(u); const r = j.root; await walk(r, r.transform ? mul(M, r.transform) : M, u, depth + 1); return; }
			if (!kids.length && !seenUrl.has(u)) { seenUrl.add(u); hits.push({ url: u, transform: M, depth, geometricError: node.geometricError ?? 0 }); }
		}
		for (const k of kids) { const m = k.transform ? mul(M, k.transform) : M; if (hitBox(k.boundingVolume, m)) await walk(k, m, base, depth + 1); }
	};
	const j = await getJson(tilesetUrl), r = j.root;
	await walk(r, r.transform ? mul(I4, r.transform) : I4, tilesetUrl, 0);
	return hits;
}
// 点を含む最深の b3dm。slack＝はみ出し許容（m）
export async function findTile(tilesetUrl, target, { slack = 50, h = 60, maxNodes = 4000, maxGE = 0 } = {}) {
	const P = lonLatToEcef(target[0], target[1], h);
	let best = null, seen = 0;
	const walk = async (node, M, base, depth) => {
		if (++seen > maxNodes) return;
		const uri = node.content?.uri;
		if (uri) {
			const u = new URL(uri, base).href;
			if (/\.json$/i.test(u)) { const j = await getJson(u); const r = j.root; await walk(r, r.transform ? mul(M, r.transform) : M, u, depth + 1); }
			else if (/\.b3dm$|\.glb$/i.test(u)) { const off = outside(node.boundingVolume, M, P), ge = node.geometricError ?? 0;
				const okGE = !maxGE || ge <= maxGE;   // maxGE＝この粗さ以下で最も粗いものを採る（広い一枚が欲しい時）
				if (off <= slack && okGE && (!best || (maxGE ? ge > best.geometricError : depth > best.depth))) best = { url: u, off, depth, geometricError: ge, transform: M }; }
		}
		for (const k of node.children || []) {
			const m = k.transform ? mul(M, k.transform) : M;
			if (outside(k.boundingVolume, m, P) <= slack) await walk(k, m, base, depth + 1);
		}
	};
	const j = await getJson(tilesetUrl), r = j.root;
	await walk(r, r.transform ? mul(I4, r.transform) : I4, tilesetUrl, 0);
	return best;
}
export function b3dmToGlb(buf) {
	const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	const magic = new TextDecoder().decode(buf.subarray(0, 4));
	if (magic === "glTF") return { glb: buf, rtc: null, ft: {} };
	if (magic !== "b3dm") throw new Error("not b3dm: " + magic);
	const ftJ = dv.getUint32(12, true), ftB = dv.getUint32(16, true), btJ = dv.getUint32(20, true), btB = dv.getUint32(24, true);
	const ft = ftJ ? JSON.parse(new TextDecoder().decode(buf.subarray(28, 28 + ftJ))) : {};
	return { glb: buf.subarray(28 + ftJ + ftB + btJ + btB), rtc: ft.RTC_CENTER || null, ft };
}
