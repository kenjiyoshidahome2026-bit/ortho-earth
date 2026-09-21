// 押し出しの見本 public/showcase/pop-density-2020.geopbf を作る（node scripts/showcase-pop3d.mjs [間引き度=0.002] [1人/km²あたりの高さm=2]）。
// 入力：SHOWCASE_SRC（既定 .showcase-src/）に admin_all.gz ＝ curl -o .showcase-src/admin_all.gz https://api.ortho-earth.com/bucket/GIS/pbf/admin_all
//       人口・面積・密度＝apps/census2020/census/manifest.json（令和2年国勢調査）。
// 押し出しの見本：2020 年国勢調査の人口密度を高さにした市区町村の 3D 地図（境界＝bucket admin_all・人口/面積/密度＝census2020 の manifest）
globalThis.ImageData ??= class ImageData { };
import fs from "node:fs"; import zlib from "node:zlib";
import { GeoPBF } from "../../../packages/geopbf/src/pbf.js";
const S = process.env.SHOWCASE_SRC || new URL("../.showcase-src/", import.meta.url).pathname;
const TOL = +(process.argv[2] || 0.002), M_PER = +(process.argv[3] || 2);
const buf = zlib.gunzipSync(fs.readFileSync(S + "admin_all.gz"));
const src = (await new GeoPBF().set(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))).geojson;
const census = Object.fromEntries(JSON.parse(fs.readFileSync(new URL("../../census2020/census/manifest.json", import.meta.url), "utf8")).map(r => [r.code, r]));
// Douglas-Peucker（度・経度は緯度で縮める）
const dp = (pts, tol) => {
	if (pts.length < 5) return pts;
	const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
	const k = Math.cos(pts[0][1] * Math.PI / 180);
	let far = 1, fd = -1; for (let i = 1; i < pts.length - 1; i++) { const d = Math.hypot((pts[i][0] - pts[0][0]) * k, pts[i][1] - pts[0][1]); if (d > fd) { fd = d; far = i; } }
	keep[far] = 1;   // 閉じた輪＝始点と終点が同じ＝基準線が長さ 0 になる＝最遠点で二つに割る
	const st = [[0, far], [far, pts.length - 1]];
	while (st.length) {
		const [a, b] = st.pop(); let md = -1, mi = -1;
		const ax = pts[a][0] * k, ay = pts[a][1], bx = pts[b][0] * k, by = pts[b][1], dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1e-12;
		for (let i = a + 1; i < b; i++) { const d = Math.abs((pts[i][0] * k - ax) * dy - (pts[i][1] - ay) * dx) / L; if (d > md) { md = d; mi = i; } }
		if (md > tol) { keep[mi] = 1; st.push([a, mi], [mi, b]); }
	}
	return pts.filter((_, i) => keep[i]);
};
const areaKm2 = r => { let s = 0; const k = Math.cos(r[0][1] * Math.PI / 180) * 111.32, m = 110.57; for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j][0] * k) * (r[i][1] * m) - (r[i][0] * k) * (r[j][1] * m); return Math.abs(s / 2); };
const STOPS = [[0, "#fcfdbf"], [50, "#fed395"], [200, "#fb9b6d"], [1000, "#e8605c"], [4000, "#b63779"], [10000, "#7a2382"], [20000, "#3b0f70"]];
const colorOf = d => { let c = STOPS[0][1]; for (const [t, col] of STOPS) if (d >= t) c = col; return c; };
const out = []; let verts = 0, skipped = 0;
for (const f of src.features) {
	const c = census[f.properties.code]; if (!c || !c.area) { skipped++; continue; }
	const polys = (f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates).map(p => p.map(r => dp(r, TOL)).filter(r => r.length >= 4));
	const kept = polys.filter(p => p.length && areaKm2(p[0]) > 0.3).map(p => [p[0], ...p.slice(1).filter(h => areaKm2(h) > 0.3)]);
	const use = kept.length ? kept : polys.filter(p => p.length).sort((a, b) => areaKm2(b[0]) - areaKm2(a[0])).slice(0, 1);   // 小さい市でも本体は残す
	if (!use.length) { skipped++; continue; }
	for (const p of use) for (const r of p) verts += r.length;
	out.push({ type: "Feature", properties: { code: c.code, name: c.name, pref: c.prefName, pop: c.pop, area_km2: c.area, density: c.density, height: Math.round(c.density * M_PER), color: colorOf(c.density), source: "令和2年国勢調査（総務省統計局）／境界：国土数値情報 行政区域（国土交通省）を加工" },
		geometry: use.length === 1 ? { type: "Polygon", coordinates: use[0] } : { type: "MultiPolygon", coordinates: use } });
}
const pbf = await new GeoPBF().set({ type: "FeatureCollection", features: out });
const file = new URL("../public/showcase/", import.meta.url).pathname + "pop-density-2020.geopbf";
fs.writeFileSync(file, new Uint8Array(pbf.arrayBuffer));
console.log({ features: out.length, skipped, verts, bytes: fs.statSync(file).size, maxH: Math.max(...out.map(f => f.properties.height)) });
