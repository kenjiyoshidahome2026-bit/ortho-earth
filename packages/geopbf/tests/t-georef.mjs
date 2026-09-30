// 基準点の当てはめ（#177・src/georef）＝既知の写像を点から当てはめ直せるか・往復誤差・注記の読み書き・IIIF の段とタイルの URL。
import { fitTransform, residuals, parseGeoreference, toGeoreferenceAnnotation, georefMapping, iiifImage, infoUrl, lonLatToWorld, worldToLonLat } from "../src/georef/index.js";

let fails = 0;
const ok = (name, cond, note = "") => { if (!cond) fails++; console.log(`${cond ? "ok" : "NG"} ${name}${note ? "  " + note : ""}`); };
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const pts = n => Array.from({ length: n }, () => [rnd() * 4000, rnd() * 3000]);   // 画像の画素のような桁
const maxErr = (fn, P, f) => Math.max(...P.map(p => { const a = fn(p), b = f(p); return Math.hypot(a[0] - b[0], a[1] - b[1]); }));
const probe = pts(200);

// ── 多項式：その次数の写像は点から当てはめ直せる ──
const aff = ([x, y]) => [0.00001 * x - 0.000002 * y + 0.3, 0.000003 * x + 0.000012 * y + 0.4];
const quad = ([x, y]) => [aff([x, y])[0] + 1e-10 * x * x - 2e-10 * x * y, aff([x, y])[1] + 3e-10 * y * y];
const cub = ([x, y]) => [quad([x, y])[0] + 1e-14 * x * x * x, quad([x, y])[1] - 2e-14 * x * y * y];
for (const [name, f, order, n] of [["poly1", aff, 1, 6], ["poly2", quad, 2, 12], ["poly3", cub, 3, 20]]) {
	const S = pts(n), fn = fitTransform(S, S.map(f), { type: "polynomial", order });
	ok(name, maxErr(fn, probe, f) < 1e-9, maxErr(fn, probe, f).toExponential(2));
}
// 1 次は 2 次の写像に残差が出る（最小二乗）
{ const S = pts(12), fn = fitTransform(S, S.map(quad), { type: "polynomial", order: 1 }); ok("poly1-residual", Math.max(...residuals(fn, S, S.map(quad))) > 1e-5); }
// ── 射影・Helmert ──
const H = [1.2e-5, 2e-6, 0.3, -1e-6, 1.1e-5, 0.4, 2e-5 / 4000, -1e-5 / 3000];
const proj = ([x, y]) => { const w = H[6] * x + H[7] * y + 1; return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w]; };
{ const S = pts(8), fn = fitTransform(S, S.map(proj), { type: "projective" }); ok("projective", maxErr(fn, probe, proj) < 1e-9, maxErr(fn, probe, proj).toExponential(2)); }
const sim = ([x, y]) => { const a = 0.9e-5, b = 0.3e-5; return [a * x - b * y + 0.1, b * x + a * y + 0.2]; };
{ const S = pts(5), fn = fitTransform(S, S.map(sim), { type: "helmert" }); ok("helmert", maxErr(fn, probe, sim) < 1e-9); }
// ── TPS：基準点を必ず通る・アフィンの点ならアフィンを再現・逆向きの当てはめで往復が近い ──
{
	const S = pts(15), D = S.map(quad), fn = fitTransform(S, D, { type: "thinPlateSpline" });
	ok("tps-interpolates", Math.max(...residuals(fn, S, D)) < 1e-10, Math.max(...residuals(fn, S, D)).toExponential(2));
	const fa = fitTransform(S, S.map(aff), { type: "thinPlateSpline" });
	ok("tps-affine", maxErr(fa, probe, aff) < 1e-9, maxErr(fa, probe, aff).toExponential(2));
	const back = fitTransform(D, S, { type: "thinPlateSpline" });
	const inner = probe.filter(([x, y]) => x > 800 && x < 3200 && y > 600 && y < 2400);
	const rt = Math.max(...inner.map(p => { const q = back(fn(p)); return Math.hypot(q[0] - p[0], q[1] - p[1]); }));
	ok("tps-roundtrip", rt < 2, `max ${rt.toFixed(3)} px`);   // 点の内側＝往復で 2 画素以内（Allmaps と同じ「逆向きにもう 1 本」の近似）
}
let err = null; try { fitTransform(pts(2), pts(2), { type: "polynomial", order: 1 }); } catch (e) { err = e; }
ok("min-points", /at least 3/.test(err?.message || ""), err?.message);
ok("mercator", (() => { const w = lonLatToWorld([139.7, 35.7]), b = worldToLonLat(w); return Math.abs(b[0] - 139.7) < 1e-9 && Math.abs(b[1] - 35.7) < 1e-9 && Math.abs(lonLatToWorld([0, 0])[1] - 0.5) < 1e-12; })());

// ── 注記（Allmaps の形・旧 pixelCoords・ページ）──
const ann = {
	type: "AnnotationPage", items: [{
		type: "Annotation", id: "https://annotations.example/a1", motivation: "georeferencing",
		target: { type: "SpecificResource", source: { id: "https://iiif.example/img/abc", type: "ImageService2", width: 4000, height: 3000 }, selector: { type: "SvgSelector", value: '<svg width="4000" height="3000"><polygon points="100,100 3900,100 3900,2900 100,2900" /></svg>' } },
		body: { type: "FeatureCollection", transformation: { type: "thinPlateSpline" }, features: [[100, 100, 139.70, 35.72], [3900, 100, 139.80, 35.72], [3900, 2900, 139.80, 35.65], [100, 2900, 139.70, 35.65], [2000, 1500, 139.751, 35.686]].map(([x, y, lon, lat]) => ({ type: "Feature", properties: { resourceCoords: [x, y] }, geometry: { type: "Point", coordinates: [lon, lat] } })) },
	}, {
		type: "Annotation", motivation: "georeferencing", target: { source: { "@id": "https://iiif.example/img/old" } },
		body: { type: "FeatureCollection", transformation: { type: "polynomial", options: { order: 2 } }, features: [{ type: "Feature", properties: { pixelCoords: [1, 2] }, geometry: { type: "Point", coordinates: [3, 4] } }] },
	}],
};
const G = parseGeoreference(ann);
ok("parse", G.length === 2 && G[0].image.id === "https://iiif.example/img/abc" && G[0].image.width === 4000 && G[0].gcps.length === 5 && G[0].mask.length === 4 && G[0].transformation.type === "thinPlateSpline"
	&& G[1].image.id === "https://iiif.example/img/old" && G[1].gcps[0].resource.join() === "1,2" && G[1].transformation.order === 2 && G[1].mask === null, JSON.stringify(G[1]));
const back = parseGeoreference(toGeoreferenceAnnotation(G[0]))[0];
ok("write-read", JSON.stringify(back.gcps) === JSON.stringify(G[0].gcps) && JSON.stringify(back.mask) === JSON.stringify(G[0].mask) && back.transformation.type === "thinPlateSpline" && back.image.width === 4000);
const M = georefMapping(G[0]);
const c = M.toWorld([2000, 1500]), cl = worldToLonLat(c), r = M.toResource(lonLatToWorld([139.751, 35.686]));
ok("mapping", Math.max(...M.residuals) < 0.01 && Math.abs(cl[0] - 139.751) < 1e-9 && Math.hypot(r[0] - 2000, r[1] - 1500) < 0.5 && M.bbox[0] < 139.701 && M.bbox[2] > 139.799 && M.bbox[1] < 35.651 && M.bbox[3] > 35.719, `res=${Math.max(...M.residuals).toExponential(1)}m r=${r.map(v => v.toFixed(2))} bbox=${M.bbox.map(v => v.toFixed(3))}`);
// 点が足りない＝型を下げる（TPS 指定で 2 点＝Helmert）
const M2 = georefMapping({ ...G[0], gcps: G[0].gcps.slice(0, 2) });
ok("fallback", M2.transformation.type === "helmert");

// ── IIIF の段とタイル ──
const v2 = iiifImage({ "@context": "http://iiif.io/api/image/2/context.json", "@id": "https://iiif.example/img/abc", width: 4000, height: 3000, profile: ["http://iiif.io/api/image/2/level0.json", { formats: ["png"] }], tiles: [{ width: 512, scaleFactors: [1, 2, 4, 8] }] });
const L4 = v2.levelFor(5), t = v2.tile(L4, 1, 1), last = v2.tile(v2.levels[0], 7, 5);
ok("iiif-v2", v2.version === 2 && v2.format === "png" && L4.scale === 4 && t.url === "https://iiif.example/img/abc/2048,2048,1952,952/488,/0/default.png" && last.url === "https://iiif.example/img/abc/3584,2560,416,440/416,/0/default.png"
	&& v2.levelFor(0.3).scale === 1 && v2.levelFor(100).scale === 8 && v2.tilesIn(v2.levels[0], [600, 0, 1100, 10]).map(x => x.join()).join(" ") === "1,0 2,0", `${t.url} ${last.url}`);
const v3 = iiifImage({ "@context": "http://iiif.io/api/image/3/context.json", id: "https://iiif.example/v3/x/", type: "ImageService3", width: 1000, height: 800, tiles: [{ width: 256, height: 256, scaleFactors: [1, 2] }] });
ok("iiif-v3", v3.version === 3 && v3.format === "jpg" && v3.tile(v3.levels[1], 1, 0).url === "https://iiif.example/v3/x/512,0,488,512/244,256/0/default.jpg", v3.tile(v3.levels[1], 1, 0).url);
const sz = iiifImage({ "@context": "http://iiif.io/api/image/2/context.json", "@id": "https://i/s", width: 2000, height: 1000, sizes: [{ width: 500, height: 250 }, { width: 1000, height: 500 }] });
ok("iiif-sizes", sz.levels.length === 2 && !sz.levels[0].tiled && sz.levelFor(3).w === 1000 && sz.levelFor(5).w === 500 && sz.tile(sz.levelFor(1), 0, 0).url === "https://i/s/full/1000,/0/default.jpg" && infoUrl("https://i/s/") === "https://i/s/info.json" && infoUrl("https://i/s/info.json") === "https://i/s/info.json");

const v3x = iiifImage({ "@context": "http://iiif.io/api/image/3/context.json", id: "https://ia/x", type: "ImageService3", profile: "level2", width: 5373, height: 3633, extraFormats: ["tif", "png"], tiles: [{ width: 512, height: 512, scaleFactors: [1, 2, 4] }] });
const l2 = iiifImage({ "@context": "http://iiif.io/api/image/2/context.json", "@id": "https://uc/y", width: 12018, height: 9274, profile: ["http://iiif.io/api/image/2/level2.json", { formats: ["jpg", "png"] }], sizes: [] });
ok("iiif-formats-level2", v3x.format === "jpg" && l2.format === "jpg" && l2.levels.length === 6 && l2.levels.every(L => L.tiled && L.tw === 512) && l2.levels.at(-1).scale === 32 && l2.tile(l2.levels[0], 0, 0).url === "https://uc/y/0,0,512,512/512,/0/default.jpg", `${v3x.format} ${l2.levels.map(L => L.scale)}`);
console.log(fails ? `\nFAIL ${fails}` : "\n全件通過");
process.exit(fails ? 1 : 0);
