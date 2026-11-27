// t-healpix-vt: ベクタを HEALPix のタイルに切る純関数（src/healpixvt.ts）の検定。
// 物差し＝HEALPix は等積：経緯度の矩形 [lon0,lon1]×[lat0,lat1] の面積は (lon1−lon0)·(sin lat1 − sin lat0)。面の座標の面積（面 1 枚＝全球の 1/12）の合計がこれと合えば、
// 隙間・重なり・面の取り違え・向きの裏返りのどれも無い。加えて、切った頂点を経緯度へ戻して元の図形の内に在る事、線の切り口が隣のタイルと同じ点である事を見る。
import { hpxSplitFaces, hpxSliceFace, hpxTileGeoms, hpxTilePointLonLat, hpxFaceWindow, encodeHpxVt } from "../src/healpixvt.ts";
import { lonLatToNest, xyfToLonLat, hpxCorners } from "../src/healpix.ts";
import { decodeTile } from "../../geopbf/src/convert/mvt-decode.ts";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };
const R = Math.PI / 180;
const area = r => { let a = 0; for (let i = 0; i < r.length; i++) { const u = r[i], v = r[(i + 1) % r.length]; a += u[0] * v[1] - v[0] * u[1]; } return a / 2; };
const rect = (w, s, e, n) => ({ type: "polygon", coords: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
const sr = (w, s, e, n) => (e - w) * R * (Math.sin(n * R) - Math.sin(s * R));   // 矩形の立体角
const FACE_SR = 4 * Math.PI / 12;

// 1. 面の窓は面を含む（面の 4 隅が窓の内）
{
	let bad = 0;
	for (let f = 0; f < 12; f++) { const [w, s, e, n] = hpxFaceWindow(f); for (const [lon, lat] of hpxCorners(0, f)) { let l = lon; while (l < w - 1e-9) l += 360; while (l > e + 1e-9) l -= 360; if ((Math.abs(lat) < 89.999 && l < w - 1e-9) || lat < s - 1e-9 || lat > n + 1e-9) bad++; /* 極の隅の経度は決まらない＝緯度だけ見る */ } }
	ok(bad === 0, "面の窓（経緯度の矩形）は面の 4 隅を含む");
}

// 2. 等積：色々な矩形で、面ごと・タイルごとの面積の合計が立体角と合う
const cases = [
	["日本域", 122, 24, 148, 46],
	["面の境をまたぐ（赤道帯の内）", 30, -20, 60, 20],
	["180° 線をまたぐ", 170, -30, 190, 30],
	["180° 線をまたぐ（−180..180 の書き方）", 170, -10, -170, 10],
	["3 面の角（経度 0・緯度 41.8）", -10, 30, 10, 55],
	["4 面の角（経度 45・緯度 0）", 35, -10, 55, 10],
	["冠の面どうしの境（経度 90・高緯度）", 70, 50, 110, 85],
	["北極に届く", 0, 60, 120, 90],
	["南半球の冠と赤道帯", -100, -80, -20, -10],
	["帯ぐるり一周の半分", -180, -5, 180, 5],
];
for (const [name, w, s, e0, n] of cases) {
	const e = e0 < w ? e0 + 360 : e0, g = e0 < w ? { type: "polygon", coords: [[[w, s], [e0, s], [e0, n], [w, n]]] } : rect(w, s, e, n), want = sr(w, s, e, n);
	const faces = hpxSplitFaces(g), aF = faces.reduce((t, f) => t + f.parts.reduce((u, p) => u + area(p), 0), 0) * FACE_SR;
	ok(Math.abs(aF / want - 1) < 1e-6, `${name}：面の座標の面積が立体角と合う（${faces.length} 面・比 ${(aF / want).toFixed(8)}）`);
	const ORDER = 3, EXT = 4096, tiles = hpxTileGeoms(g, ORDER, EXT), aT = tiles.reduce((t, f) => t + f.parts.reduce((u, p) => u + area(p), 0), 0) / (EXT * EXT * 4 ** ORDER) * FACE_SR;
	ok(Math.abs(aT / want - 1) < 2e-4, `${name}：order ${ORDER} のタイルに刻んでも合う（${tiles.length} 枚・比 ${(aT / want).toFixed(6)}）`);
	// 戻す：タイルの頂点を経緯度へ戻すと元の矩形の内（刻みの丸めぶんの余裕）
	let out = 0; const eps = 0.02;
	for (const t of tiles) for (const p of t.parts) for (const q of p) {
		const ll = hpxTilePointLonLat(ORDER, t.npix, q[0], q[1], EXT); let lon = ll[0]; while (lon < w - eps) lon += 360; while (lon > e + eps) lon -= 360;
		if (Math.abs(ll[1]) < 89.9 && (lon < w - eps || ll[1] < s - eps || ll[1] > n + eps)) out++;
	}
	ok(out === 0, `${name}：タイルの頂点を経緯度へ戻すと元の矩形の内（外 ${out} 点）`);
	ok(tiles.every(t => t.parts.every(p => area(p) > 0)), `${name}：輪の向きは元のまま（反時計回り＝正の面積）`);
}

// 3. 極を一周する輪（緯度 80° の円＝北極の蓋・南緯 70° の円＝南極の蓋）
for (const [name, lat, pole] of [["北極の蓋", 80, 90], ["南極の蓋", -70, -90]]) {
	const ring = []; for (let i = 0; i < 72; i++) ring.push([-180 + i * 5, lat]);
	const g = { type: "polygon", coords: [ring] }, want = 2 * Math.PI * Math.abs(Math.sin(pole * R) - Math.sin(lat * R));
	const faces = hpxSplitFaces(g), a = faces.reduce((t, f) => t + f.parts.reduce((u, p) => u + Math.abs(area(p)), 0), 0) * FACE_SR;
	ok(faces.length === 4 && Math.abs(a / want - 1) < 1e-6, `${name}（極を一周する輪）：冠の 4 面に分かれ、面積が合う（比 ${(a / want).toFixed(8)}）`);
}

// 4. 全球を覆う矩形＝12 面ぜんぶが面いっぱい
{
	const faces = hpxSplitFaces(rect(-180, -90, 180, 90));
	ok(faces.length === 12 && faces.every(f => Math.abs(f.parts.reduce((u, p) => u + area(p), 0) - 1) < 1e-6), "全球の矩形は 12 面をちょうど埋める");
}

// 5. 線：切り口は隣のタイルと同じ点・長さが保たれる
{
	const line = { type: "line", coords: [[[100, -50], [140, 10], [200, 60], [260, 85], [300, 20]]] };
	const ORDER = 2, EXT = 4096, tiles = hpxTileGeoms(line, ORDER, EXT), ends = new Map();
	const key = (t, q) => { const ll = hpxTilePointLonLat(ORDER, t.npix, q[0], q[1], EXT); return `${(((ll[0] % 360) + 360) % 360).toFixed(2)},${ll[1].toFixed(2)}`; };
	for (const t of tiles) for (const p of t.parts) for (const q of [p[0], p[p.length - 1]]) { const k = key(t, q); ends.set(k, (ends.get(k) || 0) + 1); }
	const odd = [...ends.values()].filter(v => v % 2).length;
	ok(tiles.length > 8 && odd === 2, `線：切り口は 2 つずつ対になる（タイル ${tiles.length} 枚・対にならない端＝線の両端の ${odd} 点）`);
	// 細かく刻んだ元の線の各点が、どれかのタイルの線の近くに在る
	let miss = 0;
	const segs = []; for (const t of tiles) for (const p of t.parts) for (let i = 1; i < p.length; i++) { const a = hpxTilePointLonLat(ORDER, t.npix, p[i - 1][0], p[i - 1][1], EXT, []), b = hpxTilePointLonLat(ORDER, t.npix, p[i][0], p[i][1], EXT, []); segs.push([a, b]); }
	const near = (lon, lat) => segs.some(([a, b]) => { let ax = a[0], bx = b[0]; ax += Math.round((lon - ax) / 360) * 360; bx += Math.round((ax - bx) / 360) * 360; const dx = bx - ax, dy = b[1] - a[1], t = Math.max(0, Math.min(1, ((lon - ax) * dx + (lat - a[1]) * dy) / (dx * dx + dy * dy || 1))); return Math.hypot(ax + dx * t - lon, a[1] + dy * t - lat) < 0.15; });
	const c = line.coords[0]; for (let i = 1; i < c.length; i++) for (let k = 0; k <= 40; k++) { const lon = c[i - 1][0] + (c[i][0] - c[i - 1][0]) * k / 40, lat = c[i - 1][1] + (c[i][1] - c[i - 1][1]) * k / 40; if (!near(lon, lat)) miss++; }
	ok(miss === 0, `線：元の線の上の点は、切った線の上に在る（外れ ${miss}）`);
}

// 6. 点：その点を含むタイルに入る
{
	const pts = [[139.7, 35.7], [-0.1, 51.5], [0, 90], [180, 0], [-77, -89], [45, 0.001]];
	const tiles = hpxTileGeoms({ type: "point", coords: [pts] }, 6);
	ok(tiles.reduce((n, t) => n + t.parts[0].length, 0) === pts.length && pts.every(p => tiles.some(t => t.npix === lonLatToNest(p[0], p[1], 6))), "点：その点を含むタイルに入る");
}

// 7. MVT に詰めて、今の復号器で読み戻す
{
	const tiles = hpxTileGeoms(rect(130, 30, 140, 40), 3), t = tiles[0];
	const line = hpxTileGeoms({ type: "line", coords: [[[130, 30], [140, 40]]] }, 3).find(x => x.npix === t.npix);
	const buf = encodeHpxVt([{ name: "land", features: [{ id: 7, type: "polygon", parts: t.parts, props: { kind: "test", n: 3, h: -1.5, ok: true } }] }, { name: "roads", features: line ? [{ type: "line", parts: line.parts, props: { kind: "trunk" } }] : [] }]);
	const dec = decodeTile(buf), f = dec[0].features[0];
	ok(dec.length === 2 && dec[0].name === "land" && dec[0].extent === 4096 && f.id === 7 && f.type === 3, "MVT：層・id・種別が読み戻せる");
	ok(f.props.kind === "test" && f.props.n === 3 && f.props.h === -1.5 && f.props.ok === true, "MVT：属性（文字・整数・小数・真偽）が読み戻せる");
	const flat = t.parts.map(p => [...p, p[0]].flat());
	ok(JSON.stringify(f.geometry) === JSON.stringify(flat) || JSON.stringify(f.geometry) === JSON.stringify(t.parts.map(p => p.flat())), `MVT：座標が読み戻せる（${f.geometry[0].length / 2} 点）`);
}
console.log(fails ? `${fails} failed` : "all passed"); process.exit(fails ? 1 : 0);
