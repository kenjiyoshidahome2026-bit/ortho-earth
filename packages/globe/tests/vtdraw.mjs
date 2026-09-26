// vector source の描く層（段 8⑤・src/vtops.js と src/vtdraw-worker.js）の単体検定：ズームの置き換え・枠で切る（バッファの二重なし）・円＝長さ 0 の線・
// 注記の点（極・タイルの中だけ）・li の帯（基図の門に掛からない）・worker の組み立て（試料のタイルで fill／line／circle／symbol）。
// 実描画は t-mlcompat.html?g=vector。使い方：node packages/globe/tests/vtdraw.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { substituteZoom, clipFillGeom, clipLineGeom, verticesOf, dotsGeom, labelPointsOf, poleOf, liOf, USER_LI0, unitsPerPx, quantZoom, styleZoomProps } from "../src/vtops.js";
import { classifyRings, ringArea2 } from "../src/vtmesh.js";
import { seaFbReal } from "../../ortho-core/src/scene.js";
import { buildTileDrawList } from "../../ortho-core/src/build.js";
import { normalizeMLLayer } from "../../ortho-core/src/mlstyle.js";

let bad = 0, n = 0;
const ok = (name, cond, note = "") => { n++; if (!cond) { bad++; console.log(`✗ ${name}${note ? ` (${note})` : ""}`); } };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;
const E = 4096;
const geomOf = rings => { const coords = [], ends = []; for (const r of rings) { for (const [x, y] of r) coords.push(x, y); coords.push(r[0][0], r[0][1]); ends.push(coords.length); } return { coords: Int32Array.from(coords), ends }; };
const lineOf = pts => ({ coords: Int32Array.from(pts.flat()), ends: [pts.length * 2] });
const cw = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const ccw = (x0, y0, x1, y1) => [[x0, y0], [x0, y1], [x1, y1], [x1, y0]];
const areaOf = g => { let a = 0, s = 0; for (const e of g.ends) { let t = 0; for (let i = s; i + 2 < e; i += 2) t += g.coords[i] * g.coords[i + 3] - g.coords[i + 2] * g.coords[i + 1]; a += t / 2; s = e; } return a; };

// ── ズームの置き換え ──
{
	const e = ["interpolate", ["linear"], ["-", ["zoom"], 1], 10, 1, 14, ["literal", ["zoom"]]];
	const r = substituteZoom(e, 15);
	ok("subst-zoom", JSON.stringify(r) === JSON.stringify(["interpolate", ["linear"], ["-", 15, 1], 10, 1, 14, ["literal", ["zoom"]]]), JSON.stringify(r));
	ok("subst-object", JSON.stringify(substituteZoom({ a: ["zoom"], b: 3 }, 2)) === '{"a":2,"b":3}');
	ok("subst-no-mutate", JSON.stringify(e[2]) === '["-",["zoom"],1]');
	ok("quant-zoom", quantZoom(15.37) === 15.25 && quantZoom(15.38) === 15.5);
	ok("style-zoom-props", "layout:text-size" in styleZoomProps({ paint: { a: 1 }, layout: { "text-size": ["zoom"] } }));
}
// ── 面を枠で切る＝左右のタイルの面積の和が元と一致（バッファの二重なし）・穴を保つ・外周は正 ──
{
	const B = [cw(3900, 1000, 4180, 1200), ccw(3950, 1050, 4000, 1100)];   // 右の縁（E）を 84 はみ出す（MVT のバッファ）・穴つき
	const L = clipFillGeom(geomOf(B), E), R = clipFillGeom(geomOf(B.map(r => r.map(([x, y]) => [x - E, y]))), E);
	const whole = 280 * 200 - 50 * 50;
	ok("fill-clip-sum", L && R && near(areaOf(L) + areaOf(R), whole, 1e-6), `${L && areaOf(L)} + ${R && areaOf(R)} vs ${whole}`);
	ok("fill-clip-hole-kept", L?.ends.length === 2 && areaOf({ coords: L.coords.subarray(L.ends[0]), ends: [L.ends[1] - L.ends[0]] }) < 0);
	ok("fill-clip-outer-positive", L && areaOf({ coords: L.coords, ends: [L.ends[0]] }) > 0);
	ok("fill-clip-in-box", L && Math.max(...L.coords.filter((_, i) => i % 2 === 0)) === E);
	ok("fill-clip-outside-null", clipFillGeom(geomOf([cw(4200, 10, 4300, 90)]), E) === null);
	const R2 = clipFillGeom(geomOf([ccw(100, 100, 300, 300)]), E);   // 逆向きのタイル（最初の輪が外周）
	ok("fill-clip-reversed-tile", R2 && areaOf(R2) > 0);
}
// ── 線を枠で切る ──
{
	const g = clipLineGeom(lineOf([[-50, 100], [2000, 100], [4200, 100]]), E);
	ok("line-clip-ends-on-edge", g && g.coords[0] === 0 && g.coords[g.coords.length - 2] === E && g.ends.length === 1, g && JSON.stringify(Array.from(g.coords)));
	const out = clipLineGeom(lineOf([[4200, 10], [4300, 10]]), E);
	ok("line-clip-outside-null", out === null);
	const split = clipLineGeom(lineOf([[100, 100], [100, -200], [300, -200], [300, 100]]), E);   // 外へ出て戻る＝2 本
	ok("line-clip-split", split?.ends.length === 2);
	// 面の輪を線で（line 層・fill の輪郭）＝枠の上の辺は落とす
	const ring = clipFillGeom(geomOf([cw(3900, 1000, 4180, 1200)]), E);
	const edges = clipLineGeom(ring, E, { skipBoundary: true });
	let onEdge = 0; for (let s = 0, k = 0; k < edges.ends.length; s = edges.ends[k++]) for (let i = s; i + 3 < edges.ends[k]; i += 2) if (edges.coords[i] === E && edges.coords[i + 2] === E) onEdge++;
	ok("outline-skip-boundary", edges && onEdge === 0, `onEdge=${onEdge}`);
}
// ── 円＝頂点（タイルの中だけ）→ 長さ 0 の線＝core の線の経路で丸点（半幅＝半径） ──
{
	ok("vertices-in-tile", JSON.stringify(verticesOf({ type: "Point", geom: { coords: [10, 10, -5, 10, 4096, 3, 4095, 4095], ends: [8] } }, E)) === "[10,10,4095,4095]");
	ok("vertices-polygon-no-closing", verticesOf({ type: "Polygon", geom: geomOf([cw(10, 10, 20, 20)]) }, E).length === 8);
	const L = normalizeMLLayer({ id: "c", type: "line", source: "s", "source-layer": "p", paint: { "line-color": "#00ff00", "line-width": ["*", 2, 7] } });
	const dl = buildTileDrawList({ layers: { p: { extent: E, features: [{ type: "LineString", id: 1, props: {}, geom: dotsGeom([100, 200, 300, 400]) }] } }, z: 14, x: 14562, y: 6759 }, { layers: [L] }, [0, 0]);
	const op = dl.ops[0];
	ok("circle-dots", op?.kind === "line" && op.half.length === 2 && op.half[0] === 7 && op.P1[0] === op.P2[0] && op.P1[1] === op.P2[1], op && `half=${Array.from(op.half)}`);
	ok("units-per-px", unitsPerPx(E, 14, 14) === 16 && unitsPerPx(E, 14, 15) === 8);
}
// ── 注記の点 ──
{
	const Lshape = [[[0, 0], [300, 0], [300, 100], [100, 100], [100, 300], [0, 300]]];   // L 字（重心は欠けた所に落ちる）
	const p = poleOf(classifyRings(geomOf(Lshape))[0], 1);
	const inL = (x, y) => (x > 0 && x < 300 && y > 0 && y < 100) || (x > 0 && x < 100 && y > 0 && y < 300);
	ok("pole-inside-L", inL(p[0], p[1]), JSON.stringify(p));
	const pts = labelPointsOf({ type: "Polygon", geom: geomOf([cw(100, 100, 300, 300), cw(4000, 100, 4200, 300)]) }, E);   // 2 つ目の面の極はタイルの外（x≥E）
	ok("label-polygon-per-piece-in-tile", pts.length === 1 && near(pts[0][0], 200, 2) && near(pts[0][1], 200, 2), JSON.stringify(pts));
	ok("label-multipoint", labelPointsOf({ type: "Point", geom: { coords: [10, 10, 20, 20, -3, 5], ends: [6] } }, E).length === 2);
	ok("label-line-none", labelPointsOf({ type: "LineString", geom: lineOf([[0, 0], [100, 100]]) }, E).length === 0);
}
// ── li の帯＝基図の門（海・建物の塗り＝数百まで・図郭外の水域＝負の擬似帯）に掛からない・順は鍵の順・副番号は層の中 ──
{
	ok("li-band", liOf(0) >= USER_LI0 && seaFbReal(liOf(0)) === null && liOf(-0.5) > 1000);
	ok("li-order", liOf(0, 2) < liOf(0.5, 0) && liOf(0.5, 2) < liOf(1, 0) && liOf(1, 0) < liOf(1, 1) && liOf(1, 1) < liOf(1, 2));
	ok("li-deterministic", new Set([liOf(0.25, 1)]).has(liOf(0.25, 1)));
}
// ── worker の組み立て（試料の z13 のタイル＝4 層）──
{
	const replies = [];
	globalThis.self = { postMessage: m => replies.push(m) };
	await import("../src/vtdraw-worker.js");
	const buf = readFileSync(fileURLToPath(new URL("./fixtures/mlcompat/vt/13/7281/3379.pbf", import.meta.url)));
	const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
	self.onmessage({ data: { kind: "put", id: 1, sid: "s", key: "13/7281/3379", ab } });
	const ml = L => normalizeMLLayer({ source: "s", ...L }, 1);
	const layers = [
		{ id: "f", key: 0, layer: ml({ id: "f", type: "fill", "source-layer": "landuse", filter: ["==", ["get", "class"], "park"], paint: { "fill-color": "#0000ff", "fill-outline-color": "#000000" } }) },
		{ id: "l", key: 1, layer: ml({ id: "l", type: "line", "source-layer": "road", paint: { "line-color": "#ff00ff", "line-width": ["interpolate", ["linear"], ["zoom"], 12, 1, 16, 9] } }) },
		{ id: "c", key: 2, layer: ml({ id: "c", type: "circle", "source-layer": "poi", paint: { "circle-color": "#00ff00", "circle-radius": 8, "circle-stroke-width": 3 } }) },
		{ id: "h", key: 3, layer: ml({ id: "h", type: "circle", "source-layer": "poi", filter: ["==", ["id"], 301], paint: { "circle-opacity": 0, "circle-radius": 6, "circle-stroke-width": 2 } }) },
		{ id: "s", key: 4, layer: ml({ id: "s", type: "symbol", "source-layer": "poi", layout: { "text-field": ["get", "name"] } }) },
		{ id: "n", key: 5, layer: ml({ id: "n", type: "symbol", "source-layer": "landuse", layout: { "text-field": ["get", "name"] } }) },
	];
	self.onmessage({ data: { kind: "build", id: 2, sid: "s", key: "13/7281/3379", z: 13, x: 7281, y: 3379, layers, fz: 14, pz: 15, promoteId: null } });
	const r = replies.find(m => m.id === 2);
	ok("worker-build-ok", r && !r.error && !r.miss, r?.error);
	const byLi = new Map(); for (const op of r?.ops || []) byLi.set(op.li, op);
	ok("worker-fill", byLi.get(liOf(0, 0))?.kind === "fill", [...byLi.keys()].join(","));
	ok("worker-outline", byLi.get(liOf(0, 1))?.kind === "line" && byLi.get(liOf(0, 1)).half[0] === 0.5);
	const lw = byLi.get(liOf(1, 0));
	ok("worker-line-width-at-pz", lw?.kind === "line" && near(lw.half[0], ((15 - 1 - 12) / 4 * 8 + 1) / 2, 1e-6), lw && `half=${lw.half[0]}`);   // 正規化＝["-",["zoom"],1]＝pz 15 は MapLibre の 14
	const dot = byLi.get(liOf(2, 2)), rim = byLi.get(liOf(2, 1));
	ok("worker-circle", dot?.half.length === 2 && dot.half[0] === 8 && rim?.half[0] === 11, `dot=${dot && Array.from(dot.half)} rim=${rim && Array.from(rim.half)}`);
	const ring = byLi.get(liOf(3, 1));
	ok("worker-hollow-ring", ring?.half.length === 24 && ring.half[0] === 1 && byLi.get(liOf(3, 2))?.half.length === 1, `ring=${ring?.half.length}`);   // 中空＝輪（24 角形）・filter ["id"]
	ok("worker-labels", r?.labels?.s?.map(L => L.text).sort().join() === "Cafe,Shop" && r.labels.n?.map(L => L.text).sort().join() === "Lake,Park", JSON.stringify(Object.fromEntries(Object.entries(r?.labels || {}).map(([k, v]) => [k, v.map(L => L.text)]))));
	ok("worker-label-sort-user-wins", r?.labels?.s?.every(L => L.sort < -9e5));
	// バッファの外（x<0・x>E の座標）の塗りは無い＝経緯度の範囲がタイルの中
	const f = byLi.get(liOf(0, 0)), n0 = 2 ** 13, lonW = 7281 / n0 * 360 - 180, lonE = 7282 / n0 * 360 - 180;
	let inside = true; for (let i = 0; i < (f?.pos.length || 0); i += 2) { const lon = f.pos[i] + r.origin[0]; if (lon < lonW - 1e-9 || lon > lonE + 1e-9) inside = false; }
	ok("worker-fill-in-tile", inside);
	self.onmessage({ data: { kind: "build", id: 3, sid: "s", key: "13/7281/9999", z: 13, x: 7281, y: 9999, layers, fz: 14, pz: 15 } });
	ok("worker-miss", replies.find(m => m.id === 3)?.miss === true);
}

console.log(`vtdraw: ${n - bad}/${n} ok`);
if (bad) process.exit(1);
