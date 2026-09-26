// ベクタタイルの押し出し（MapLibre の fill-extrusion を vector source で・段 8①・2026-09-26）の幾何＝純関数（node で検定・worker が使う）。
// 既存の押し出し（extrude.js・meshdecode.js の finishMesh）は触らない＝この経路だけの軽い版：
//   輪の分類（MapLibre の classifyRings）→ タイルの枠 [0, extent] で切る（バッファの重なりで屋根が二重にならない）→ earcut（タイル座標のまま）
//   → 壁（枠の上の辺には立てない＝MapLibre の isBoundaryEdge と同じ意味）→ 仕上げ（原点相対・法線・頂点色）。重ね除き・接地・LOD はしない。
// 幾何（tessellate）と高さ・色（buildMesh）を分ける＝ズームの式・setPaintProperty は buildMesh だけやり直す（earcut をやり直さない）。
// 出力の形は finishMesh と同じ契約（pos＝原点相対 Float32・nrm＝Int8×4（ortho 軸＝ECEF の x,z,y）・idx＝Uint32・uv＝0・col＝RGBA8・origin・bbox 度）
// ＝メッシュ経路（setMesh）へそのまま渡る。uv は 0 でも要る（頂点色は「uv と col がある」メッシュだけが使う）。
import earcut from "earcut";

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const MAX_RINGS = 500;              // MapLibre と同じ（穴の多すぎる面は小さい穴から捨てる）
const ELL_RAX = 1 - 1 / 298.257223563;   // b/a（?ell=1 の β 単位球＝meshdecode と同じ分解）

// 符号付き面積（×2・タイル座標＝x 右・y 下のまま）。輪は開いた平坦列 [x0,y0,x1,y1,…]
export function ringArea2(r) {
	let s = 0;
	for (let i = 0, n = r.length; i < n; i += 2) { const j = i + 2 < n ? i + 2 : 0; s += r[i] * r[j + 1] - r[j] * r[i + 1]; }
	return s;
}
// 閉じ点（先頭の複製）を落とした開いた輪
const openRing = r => r.length >= 4 && r[0] === r[r.length - 2] && r[1] === r[r.length - 1] ? r.subarray(0, r.length - 2) : r;

// MVT の面の幾何（decodeMVT の { coords, ends }）→ 面の列 [[外周, 穴, …], …]。MapLibre の classifyRings と同じ：
// 最初の（面積 0 でない）輪の向きが「外周」の向き・同じ向きの輪が新しい面を始め・逆向きは直前の面の穴・面積 0 は捨てる
export function classifyRings(geom) {
	const { coords, ends } = geom, polys = [];
	let cur = null, outerNeg = null, s = 0;
	for (const e of ends) {
		const r = openRing(coords.subarray(s, e)); s = e;
		const a = ringArea2(r);
		if (a === 0 || r.length < 6) continue;
		if (outerNeg === null) outerNeg = a < 0;
		if ((a < 0) === outerNeg) { cur = [r]; polys.push(cur); }
		else if (cur) cur.push(r);
	}
	for (let i = 0; i < polys.length; i++) {
		const p = polys[i];
		if (p.length > MAX_RINGS) polys[i] = [p[0], ...p.slice(1).sort((a, b) => Math.abs(ringArea2(b)) - Math.abs(ringArea2(a))).slice(0, MAX_RINGS - 1)];
	}
	return polys;
}

// 輪をタイルの枠 [0, E]² で切る（Sutherland–Hodgman）。戻り＝開いた Float64Array か null（3 点未満・面積ほぼ 0）。
// 交点の座標は枠の値ちょうど（0 か E）＝「枠の上の辺」の判定が厳密に効く。全部内側なら切らずに写すだけ
export function clipRing(r, E) {
	let inside = true;
	for (let i = 0; i < r.length; i += 2) if (r[i] < 0 || r[i] > E || r[i + 1] < 0 || r[i + 1] > E) { inside = false; break; }
	let pts = inside ? Array.from(r) : r;
	if (!inside) {
		const clip = (src, axis, c, keepGE) => {
			const out = [], n = src.length / 2;
			const inn = (x, y) => { const v = axis ? y : x; return keepGE ? v >= c : v <= c; };
			for (let i = 0; i < n; i++) {
				const ax = src[i * 2], ay = src[i * 2 + 1], j = (i + 1) % n, bx = src[j * 2], by = src[j * 2 + 1];
				const ai = inn(ax, ay), bi = inn(bx, by);
				if (ai !== bi) {
					if (axis) { const t = (c - ay) / (by - ay); out.push(ax + t * (bx - ax), c); }
					else { const t = (c - ax) / (bx - ax); out.push(c, ay + t * (by - ay)); }
				}
				if (bi) out.push(bx, by);
			}
			return out;
		};
		pts = clip(pts, 0, 0, true); if (pts.length) pts = clip(pts, 0, E, false);
		if (pts.length) pts = clip(pts, 1, 0, true); if (pts.length) pts = clip(pts, 1, E, false);
	}
	const out = [];   // 続く同じ点を落とす（最後と最初も）
	for (let i = 0; i < pts.length; i += 2) { const k = out.length; if (k && out[k - 2] === pts[i] && out[k - 1] === pts[i + 1]) continue; out.push(pts[i], pts[i + 1]); }
	while (out.length >= 4 && out[0] === out[out.length - 2] && out[1] === out[out.length - 1]) out.length -= 2;
	if (out.length < 6) return null;
	const f = Float64Array.from(out);
	return Math.abs(ringArea2(f)) < 1 ? null : f;   // 面積 0.5 単位²未満（z14 で 0.2m² 程度）＝切った後の糸くず
}
// 枠の上の辺か（両端が同じ枠の線の上＝タイルの継ぎ目）。MapLibre の isBoundaryEdge と同じ意味（こちらは枠で切ってあるので「上」）
const onBoundary = (ax, ay, bx, by, E) => (ax === bx && (ax <= 0 || ax >= E)) || (ay === by && (ay <= 0 || ay >= E));

// 1 つの面（[外周, 穴…]・タイル座標）→ 三角形分割済みの幾何（null＝外周が切れて消えた）。
// { xy: Float64Array（全輪の頂点を連結）, starts: [輪の先頭の頂点番号…, 総数], sgn: [輪ごとの外向きの符号], tris: Uint32Array, wall: Uint8Array（頂点 i→次の辺に壁を立てるか） }
export function tessellatePolygon(rings, E) {
	const kept = [];
	for (let k = 0; k < rings.length; k++) {
		const c = clipRing(rings[k], E);
		if (!c) { if (k === 0) return null; continue; }
		kept.push({ c, hole: k > 0 });
	}
	let n = 0; const starts = [];
	for (const r of kept) { starts.push(n); n += r.c.length / 2; }
	starts.push(n);
	const xy = new Float64Array(n * 2), holes = [], sgn = [], wall = new Uint8Array(n);
	kept.forEach((r, k) => {
		xy.set(r.c, starts[k] * 2);
		if (k) holes.push(starts[k]);
		// 外向きの符号（東・北の平面で考える＝タイルの y は南向きなので面積の符号が逆）。外周は輪の外・穴は輪の内（＝穴の中心へ）が外向き
		const aEN = -ringArea2(r.c);
		sgn.push((aEN > 0 ? 1 : -1) * (r.hole ? -1 : 1));
		const s = starts[k], m = starts[k + 1] - s;
		for (let i = 0; i < m; i++) {
			const a = s + i, b = s + (i + 1) % m;
			wall[a] = onBoundary(xy[a * 2], xy[a * 2 + 1], xy[b * 2], xy[b * 2 + 1], E) ? 0 : 1;
		}
	});
	const tris = Uint32Array.from(earcut(xy, holes.length ? holes : null, 2));
	return tris.length ? { xy, starts, sgn, tris, wall } : null;
}

// タイル座標 → 経緯度（度）
export function tileToLonLat(z, x, y, E, px, py) {
	const n = 2 ** z, wx = (x + px / E) / n, wy = (y + py / E) / n;
	return [wx * 360 - 180, R2D * Math.atan(Math.sinh(Math.PI * (1 - 2 * wy)))];
}

// MapLibre の壁の縦の陰影（fill-extrusion-vertical-gradient・既定 true・光の強さ 0.5）＝clamp((t + base)·√(h/150), mix(0.7, 0.98, 1 − 0.5), 1)。
// t＝上の頂点 1・下の頂点 0。高さ 100m 程度までの建物は上下とも 0.84（一律に少し暗い）・高い建物ほど上が明るい
export const verticalShade = (top, base, h) => Math.min(1, Math.max(0.84, ((top ? 1 : 0) + base) * Math.sqrt(Math.max(0, h) / 150)));

// 幾何の列（tessellatePolygon の出力に { fi } を添えた物）× 面ごとの高さと色 → メッシュ（null＝立つ面なし）。
// styleOf(fi) → { h, base, rgba: [r,g,b,a 0-255], grad } | null（null＝立てない＝filter と同じ）。tile＝{ z, x, y, extent }。ell＝?ell=1
export function buildMesh(geos, styleOf, tile, { ell = false } = {}) {
	const { z, x, y, extent: E } = tile, EARTH_W = ell ? 6378137 : 6371000;
	const st = geos.map(g => { const s = styleOf(g.fi); return s && s.h > s.base ? s : null; });
	let nV = 0, nI = 0;
	geos.forEach((g, i) => {
		if (!st[i]) return;
		const n = g.xy.length / 2; let w = 0;
		for (let k = 0; k < n; k++) w += g.wall[k];
		nV += n + w * 4; nI += g.tris.length + w * 6;
	});
	if (!nI) return null;
	const geo = new Float64Array(nV * 3), nrm = new Int8Array(nV * 4), col = new Uint8Array(nV * 4), idx = new Uint32Array(nI);
	let v = 0, q = 0, lo0 = Infinity, la0 = Infinity, lo1 = -Infinity, la1 = -Infinity, hMax = 0;
	const put = (lon, lat, h, nx, ny, nz, c, k) => {   // nx,ny,nz＝ECEF の向き
		geo[v * 3] = lon * D2R; geo[v * 3 + 1] = lat * D2R; geo[v * 3 + 2] = h;
		const l = Math.hypot(nx, ny, nz) || 1, s = 127 / l;
		nrm[v * 4] = Math.round(nx * s); nrm[v * 4 + 1] = Math.round(nz * s); nrm[v * 4 + 2] = Math.round(ny * s);   // ECEF → ortho (x, z, y)
		col[v * 4] = Math.min(255, Math.round(c[0] * k)); col[v * 4 + 1] = Math.min(255, Math.round(c[1] * k)); col[v * 4 + 2] = Math.min(255, Math.round(c[2] * k)); col[v * 4 + 3] = c[3];
		if (lon < lo0) lo0 = lon; if (lon > lo1) lo1 = lon; if (lat < la0) la0 = lat; if (lat > la1) la1 = lat;
		return v++;
	};
	geos.forEach((g, i) => {
		const s = st[i]; if (!s) return;
		if (s.h > hMax) hMax = s.h;
		const n = g.xy.length / 2, ll = new Array(n);
		for (let k = 0; k < n; k++) ll[k] = tileToLonLat(z, x, y, E, g.xy[k * 2], g.xy[k * 2 + 1]);
		const roof = v;
		for (let k = 0; k < n; k++) { const [lon, lat] = ll[k], lo = lon * D2R, la = lat * D2R, cl = Math.cos(la); put(lon, lat, s.h, cl * Math.cos(lo), cl * Math.sin(lo), Math.sin(la), s.rgba, 1); }
		for (let k = 0; k < g.tris.length; k++) idx[q++] = roof + g.tris[k];
		const kb = s.grad === false ? 1 : verticalShade(false, s.base, s.h), kt = s.grad === false ? 1 : verticalShade(true, s.base, s.h);
		for (let r = 0; r < g.starts.length - 1; r++) {
			const a0 = g.starts[r], m = g.starts[r + 1] - a0, sg = g.sgn[r];
			for (let t = 0; t < m; t++) {
				const a = a0 + t; if (!g.wall[a]) continue;
				const b = a0 + (t + 1) % m;
				const dx = g.xy[b * 2] - g.xy[a * 2], dy = -(g.xy[b * 2 + 1] - g.xy[a * 2 + 1]);   // 東・北（タイルの y は南向き）
				const e = sg * dy, nn = -sg * dx;   // 外向き（東・北）
				const lo = (ll[a][0] + ll[b][0]) / 2 * D2R, la = (ll[a][1] + ll[b][1]) / 2 * D2R, sl = Math.sin(lo), cl = Math.cos(lo), sp = Math.sin(la), cp = Math.cos(la);
				const nx = -sl * e - sp * cl * nn, ny = cl * e - sp * sl * nn, nz = cp * nn;   // ENU → ECEF
				const v0 = put(ll[a][0], ll[a][1], s.base, nx, ny, nz, s.rgba, kb), v1 = put(ll[b][0], ll[b][1], s.base, nx, ny, nz, s.rgba, kb);
				const v2 = put(ll[b][0], ll[b][1], s.h, nx, ny, nz, s.rgba, kt), v3 = put(ll[a][0], ll[a][1], s.h, nx, ny, nz, s.rgba, kt);
				idx[q++] = v0; idx[q++] = v1; idx[q++] = v2; idx[q++] = v0; idx[q++] = v2; idx[q++] = v3;
			}
		}
	});
	// 仕上げ＝世界座標（単位球・高さは地面から＝drape で頂点ごとに地表へ持ち上がる）→ 原点相対の Float32（finishMesh の RTE と同じ）
	const wpos = new Float64Array(v * 3);
	let ox = 0, oy = 0, oz = 0;
	for (let i = 0; i < v; i++) {
		const lon = geo[i * 3], lat = geo[i * 3 + 1], hr = geo[i * 3 + 2] / EARTH_W, cb = Math.cos(lat), sp = Math.sin(lat);
		let X, Y, Z;
		if (!ell) { const r = 1 + hr; X = cb * Math.cos(lon) * r; Y = sp * r; Z = cb * Math.sin(lon) * r; }
		else { const w = Math.hypot(cb, ELL_RAX * sp), horiz = cb / w + hr * cb; X = horiz * Math.cos(lon); Y = ELL_RAX * sp / w + hr * sp / ELL_RAX; Z = horiz * Math.sin(lon); }
		wpos[i * 3] = X; wpos[i * 3 + 1] = Y; wpos[i * 3 + 2] = Z; ox += X; oy += Y; oz += Z;
	}
	const origin = [ox / v, oy / v, oz / v], pos = new Float32Array(v * 3);
	for (let i = 0; i < v; i++) { pos[i * 3] = wpos[i * 3] - origin[0]; pos[i * 3 + 1] = wpos[i * 3 + 1] - origin[1]; pos[i * 3 + 2] = wpos[i * 3 + 2] - origin[2]; }
	return { mesh: { pos, nrm: nrm.subarray(0, v * 4).slice(), idx: idx.subarray(0, q).slice(), uv: new Float32Array(v * 2), col: col.subarray(0, v * 4).slice(), origin, bbox: [lo0, la0, lo1, la1], twoSided: 0 }, stats: { vertices: v, triangles: q / 3, hMax } };
}

// ── 選び（main）の純関数 ──────────────────────────────────────────
const keyOf = t => `${t.z}/${t.x}/${t.y}`;
const parentOf = t => t.z > 0 ? { z: t.z - 1, x: t.x >> 1, y: t.y >> 1 } : null;
// 置き換え（MapLibre の retain と同じ考え）：wanted の各タイル＝揃っていればそれ・揃っていなければ一番近い揃った祖先（minZ まで）・それも無ければ揃った子孫（2 段まで）。
// 祖先を出す所はその下の子孫を出さない＝同じ所を二度描かない（穴よりダブりを先に消す＝押し出しは深度で重なりが見える）。
// ready(key) → bool（空のタイル＝揃った扱い）。戻り＝出すタイルの鍵の Set
export function retainTiles(wanted, ready, { minZ = 0 } = {}) {
	const show = new Set();
	for (const t of wanted) {
		const k = keyOf(t);
		if (ready(k)) { show.add(k); continue; }
		let a = parentOf(t), got = false;
		while (a && a.z >= minZ) { const ak = keyOf(a); if (ready(ak)) { show.add(ak); got = true; break; } a = parentOf(a); }
		if (got) continue;
		for (let d = 1; d <= 2; d++) {   // 子孫（ズームアウトの直後＝細かいタイルが残っている）
			const n = 1 << d;
			for (let dy = 0; dy < n; dy++) for (let dx = 0; dx < n; dx++) { const ck = `${t.z + d}/${t.x * n + dx}/${t.y * n + dy}`; if (ready(ck)) show.add(ck); }
		}
	}
	// 祖先が出ている所の子孫は伏せる
	for (const k of [...show]) {
		const [z, x, y] = k.split("/").map(Number);
		let a = parentOf({ z, x, y });
		while (a) { if (show.has(keyOf(a))) { show.delete(k); break; } a = parentOf(a); }
	}
	return show;
}

// ズームの鍵（この経路だけ）＝paint の値が変わり得るかを曲線で見る。一番外の interpolate/step の入力が ["zoom"] 由来（正規化で ["-",["zoom"],k] もある）なら、
// 止まりの外は "lo"/"hi"（値が一定）・中は interpolate＝0.25 刻み／step＝段の番号。["zoom"] がそれ以外の所にある時は 0.25 刻み（今の規則）。["zoom"] 無し＝""。
// evalIn(e, z)＝入力式を zoom z で評価する関数（core evalExpr を包んで渡す＝ここは純関数のまま）
const hasZoom = e => Array.isArray(e) && (e[0] === "zoom" || e.some(hasZoom));
export function paintZoomKey(paint, z, evalIn) {
	const parts = [];
	for (const k of Object.keys(paint || {}).sort()) {
		const e = paint[k];
		if (!hasZoom(e)) continue;
		if (Array.isArray(e) && e[0] === "interpolate" && hasZoom(e[2]) && !e.slice(3).some(hasZoom)) {
			const x = +evalIn(e[2], z), s0 = e[3], sN = e[e.length - 2];
			parts.push(k + (x <= s0 ? ":lo" : x >= sN ? ":hi" : ":" + Math.round(z * 4) / 4));
		} else if (Array.isArray(e) && e[0] === "step" && hasZoom(e[1]) && !e.slice(2).some(hasZoom)) {
			const x = +evalIn(e[1], z); let seg = 0;
			for (let i = 3; i < e.length; i += 2) if (x >= e[i]) seg++;
			parts.push(k + ":s" + seg);
		} else parts.push(k + ":" + Math.round(z * 4) / 4);
	}
	return parts.join("|");
}
// filter を評価する zoom（エンジンの目盛り）。MapLibre は filter をタイルの z（過拡大なら表示の丸めた z＝vector source の roundZoom）で評価する。
// 層は正規化でエンジンの目盛り（["zoom"] → ["-",["zoom"],dz]）に直してある＝MapLibre の z＋1 を渡すと式の中で MapLibre の z に戻る
export function filterZoom(tileZ, maxzoom, camZoom) {
	const ml = tileZ < maxzoom ? tileZ : Math.max(tileZ, Math.round(camZoom - 1));
	return ml + 1;
}
export { keyOf as tileKey, hasZoom };
