// node の検定：色表・値の詰め（R8／RGBA8）・置き方（origin/size/orientation・transform）・DDA（CPU 版）・prepare・plugin の形と手綱（偽の map＝描き手へ届く message）。描画は t-pvoxel（verify:ui）
import { buildColormap, colorStops, parseColor, quantize, toRgba8, valueRange, placeBox, placeRegion, unitAt, checkClip, thrOf, hprMat, inv3, mul3, ecefEnuRows, ecefToLngLat, rayBox, marchBlocks, prepare, checkVoxelData, voxelPlugin, createVoxel, COLORMAP_NAMES, SHELL_N, STYLE_KEYS, OVERLAY_LINGER_MS, VERSION, prepareGrid, maxOf, needsBricks, brickSpans, extract, parentIndex, frameValues, frameAt, BRICK, BRICK_LIMIT, LOD_MAX, levelDims, levelCount, downsample, pyramid, defaultBudgetMB } from "../src/index.ts";
import { drawBounds, isEmpty, centerDist, pickedCell, hitOf, planLevels, cellOf } from "../src/voxel-gl.ts";
let fails = 0;
const ok = (name, c, note = "") => { console.log(`${c ? "PASS" : "FAIL"} ${name}${note ? " " + note : ""}`); if (!c) fails++; };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;
const throws = (f, re) => { try { f(); return false; } catch (e) { return re ? re.test(e.message) : true; } };

// ---- 色表 ----
{
	const g = buildColormap("grey");
	ok("cmap.grey", g.length === 1024 && g[0] === 0 && g[3] === 0 && g[255 * 4] === 255 && g[255 * 4 + 3] === 255 && near(g[128 * 4], 128, 1), `${g[0]},${g[3]} … ${g[1020]},${g[1023]}`);
	ok("cmap.names", COLORMAP_NAMES.includes("viridis") && COLORMAP_NAMES.includes("turbo") && buildColormap("viridis")[1020] === 0xfd);
	const l = buildColormap(["#ff0000", "#0000ff"], [0.2, 0.6]);
	ok("cmap.list", l[0] === 255 && l[2] === 0 && l[1020] === 0 && l[1022] === 255 && near(l[3], 51, 1) && near(l[1023], 153, 1), `${l[3]} ${l[1023]}`);
	const s = buildColormap([[0, "#00000000"], [0.5, [0, 255, 0, 128]], [1, "#ffffffff"]]);
	ok("cmap.stops", s[3] === 0 && near(s[127 * 4 + 1], 254, 2) && near(s[127 * 4 + 3], 127, 2) && s[1023] === 255, `${s[127 * 4 + 1]}/${s[127 * 4 + 3]}`);
	ok("cmap.stopsPartial", colorStops([[0.25, "#ff0000"], [0.75, "#0000ff"]]).length === 4 && buildColormap([[0.25, "#ff0000"], [0.75, "#0000ff"]])[0] === 255);
	ok("cmap.bad", throws(() => buildColormap("nope"), /unknown colormap/) && throws(() => buildColormap(["#12"]), /#rrggbb/) && throws(() => buildColormap([[2, "#ff0000"]]), /0\.\.1/) && throws(() => parseColor([1, 2]), /r, g, b/));
	ok("cmap.alphaHex", parseColor("#11223344")[3] === 0x44 && parseColor("#112233")[3] === null && parseColor([1, 2, 3])[3] === null);
}
// ---- 値の詰め ----
{
	ok("range", valueRange([3, -1, 7, NaN], -1).join() === "3,7" && valueRange([5, 5]).join() === "5,6" && valueRange([], 0).join() === "0,1");
	const q = quantize(new Float32Array([-1, 0, 5, 10, 12, -3]), [0, 10], -1, null);
	ok("quantize", q.join() === "0,1,128,255,255,1", q.join());
	ok("quantize.thr", quantize(new Float32Array([0, 4.9, 5, 10]), [0, 10], undefined, 5).join() === "0,0,128,255");
	const u8 = new Uint8Array([1, 2, 3, 4]), r = toRgba8(u8, undefined);
	ok("rgba.u8", r.join() === "1,2,3,4" && r !== u8);
	ok("rgba.f32", toRgba8(new Float32Array([0, 0.5, 1, 2, 0, 0, 0, 0]), undefined).join() === "0,128,255,255,0,0,0,0");
	ok("rgba.u16", toRgba8(new Uint16Array([65535, 0, 257, 65535]), undefined).join() === "255,0,1,255");
	ok("rgba.noData", toRgba8(new Uint8Array([9, 9, 9, 7]), 7).join() === "0,0,0,0");
}
// ---- 置き方 ----
{
	const I = hprMat([0, 0, 0]);
	ok("hpr.identity", I.every((v, i) => near(v, i % 4 === 0 ? 1 : 0)));
	const R = hprMat([90, 0, 0]), y = [R[1], R[4], R[7]];   // 局所の +y（北）が heading 90 で東へ
	ok("hpr.heading90", near(y[0], 1) && near(y[1], 0) && near(y[2], 0), y.map(v => v.toFixed(3)).join());
	const p = placeBox({ origin: [139.76, 35.68, 10], size: [100, 200, 50] }, [4, 8, 2]);
	ok("box.diag", p.anchor.join() === "139.76,35.68,10" && near(p.A[0], 25) && near(p.A[4], 25) && near(p.A[8], 25) && near(p.A[1], 0) && !p.placed && near(p.radius, 350, 1e-6), Array.from(p.A).map(v => v.toFixed(2)).join());
	const AI = inv3(p.A), II = mul3(AI, p.A);
	ok("inv3", II.every((v, i) => near(v, i % 4 === 0 ? 1 : 0, 1e-9)));
	ok("inv3.singular", throws(() => inv3([1, 2, 3, 2, 4, 6, 0, 0, 1]), /degenerate/));
	// transform＝ECEF の東北上の軸に 100／200／50 m の辺・原点は (139.76, 35.68, 0)
	const lon = 139.76, lat = 35.68, D = Math.PI / 180, a = 6378137, e2 = 6.69437999014e-3, s = Math.sin(lat * D), N = a / Math.sqrt(1 - e2 * s * s);
	const O = [N * Math.cos(lat * D) * Math.cos(lon * D), N * Math.cos(lat * D) * Math.sin(lon * D), N * (1 - e2) * s];
	const rows = ecefEnuRows(lon, lat), E = [rows[0], rows[1], rows[2]], Nn = [rows[3], rows[4], rows[5]], U = [rows[6], rows[7], rows[8]];
	const M = [E[0] * 100, E[1] * 100, E[2] * 100, 0, Nn[0] * 200, Nn[1] * 200, Nn[2] * 200, 0, U[0] * 50, U[1] * 50, U[2] * 50, 0, O[0], O[1], O[2], 1];
	const t = placeBox({ transform: M }, [4, 8, 2]);
	ok("box.transform", near(t.anchor[0], lon, 1e-9) && near(t.anchor[1], lat, 1e-9) && near(t.anchor[2], 0, 1e-3) && t.placed && near(t.A[0], 25, 1e-6) && near(t.A[4], 25, 1e-6) && near(t.A[8], 25, 1e-6) && near(t.A[3], 0, 1e-6), `${t.anchor} ${Array.from(t.A).map(v => v.toFixed(3))}`);
	const ll = ecefToLngLat(O[0], O[1], O[2]);
	ok("ecef.roundtrip", near(ll[0], lon, 1e-9) && near(ll[1], lat, 1e-9) && near(ll[2], 0, 1e-3));
	ok("box.transform.bad", throws(() => placeBox({ transform: [1, 2, 3] }, [1, 1, 1]), /4×4/));
}
// ---- region ----
{
	const dims = [8, 4, 2], r = placeRegion([139, 35, 140, 36, 0, 1000], dims);
	ok("region.anchor", near(r.anchor[0], 139.5) && near(r.anchor[1], 35.5) && r.anchor[2] === 0 && r.placed);
	ok("region.geo", r.geo.west === 139 && r.geo.south === 35 && near(r.geo.spanLon, 1) && near(r.geo.spanLat, 1) && r.geo.h0 === 0 && r.geo.h1 === 1000);
	ok("region.cellM", near(r.geo.cellM[0], 111320 * Math.cos(35.5 * Math.PI / 180) / 8, 200) && near(r.geo.cellM[1], 111195 / 4, 200) && near(r.geo.cellM[2], 500), r.geo.cellM.map(v => v.toFixed(0)).join());
	ok("region.A", near(r.A[0], r.geo.cellM[0]) && near(r.A[4], r.geo.cellM[1]) && near(r.A[8], r.geo.cellM[2]) && r.A[1] === 0);
	const sh = r.geo.shell, N = SHELL_N;
	ok("region.shell.len", sh.length === 6 * N * N * 6 * 3 && sh instanceof Float32Array);
	// 外向き＝面ごとの向き（下・上・南・北・西・東の順）と三角形の法線が同じ側（cullFace FRONT で裏面だけ描く約束）
	const OUT = [[0, 0, -1], [0, 0, 1], [0, -1, 0], [0, 1, 0], [-1, 0, 0], [1, 0, 0]];
	let inward = 0; const bc = r.geo.bs, perFace = N * N * 2;
	for (let i = 0; i < sh.length; i += 9) {
		const p0 = [sh[i], sh[i + 1], sh[i + 2]], p1 = [sh[i + 3], sh[i + 4], sh[i + 5]], p2 = [sh[i + 6], sh[i + 7], sh[i + 8]], o = OUT[Math.floor(i / 9 / perFace)];
		const a = p1.map((v, k) => v - p0[k]), b = p2.map((v, k) => v - p0[k]), n = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
		if (n[0] * o[0] + n[1] * o[1] + n[2] * o[2] <= 0) inward++;
	}
	ok("region.shell.outward", inward === 0, `${inward} inward`);
	// 殻の隅＝(w, s, h0) は錨（中心・h0）から西南へ約 45／56 km・下へ丸みの分（≈ (45.3²+55.6²)/(2·6371) km ≈ 404 m）
	const sw = [sh[0], sh[1], sh[2]];
	ok("region.shell.corner", near(sw[0], -111320 * Math.cos(35.5 * Math.PI / 180) / 2, 300) && near(sw[1], -111195 / 2, 300) && near(sw[2], -404, 30), sw.map(v => v.toFixed(0)).join());
	ok("region.bs", near(bc[0], 0, 100) && near(bc[1], 0, 300) && bc[3] > 60000 && bc[3] < 80000, bc.map(v => v.toFixed(0)).join());
	ok("region.radius", r.radius > bc[3] && r.radius < bc[3] + 1000);
	// 日付変更線を跨ぐ region（e < w）
	const dl = placeRegion([179, 0, -179, 1, 0, 10], [2, 2, 2]);
	ok("region.antimeridian", near(dl.geo.spanLon, 2) && near(Math.abs(dl.anchor[0]), 180, 1e-9));
	ok("unitAt", (() => { const u = unitAt(0, 0, 0); return near(u[0], 1) && near(u[1], 0) && near(u[2], 0) && near(unitAt(90, 0, 6371000)[2], 2); })());
}
// ---- 断面・閾 ----
{
	ok("clip.null", checkClip(null) === null && checkClip(undefined) === null);
	ok("clip.ok", checkClip([0, 0.5, 0.25, 1, 0, 1]).join() === "0,0.5,0.25,1,0,1");
	ok("clip.bad", throws(() => checkClip([0, 1, 0, 1]), /6 finite/) && throws(() => checkClip([0.5, 0.5, 0, 1, 0, 1]), /lo < hi/) && throws(() => checkClip([-0.1, 1, 0, 1, 0, 1]), /lo < hi/) && throws(() => checkClip([0, 1.5, 0, 1, 0, 1]), /lo < hi/));
	ok("thrOf", thrOf(null, [0, 10]) === 0 && near(thrOf(5, [0, 10]), 0.5) && thrOf(20, [0, 10]) === 1 && thrOf(-1, [0, 10]) === 0);
}
// ---- DDA ----
{
	const dims = [4, 4, 4], tex = new Uint8Array(64); tex[2 + 4 * (1 + 4 * 3)] = 200;   // (2,1,3)
	ok("rayBox.miss", rayBox([-1, 9, 0], [1, 0, 0], dims) === null && rayBox([-1, 1, 1], [-1, 0, 0], dims) === null);
	ok("rayBox.hit", (() => { const r = rayBox([-1, 1.5, 3.5], [1, 0, 0], dims); return r && near(r[0], 1) && near(r[1], 5) && r[2] === 0; })());
	const h = marchBlocks(tex, dims, [-1, 1.5, 3.5], [1, 0, 0]);
	ok("dda.hit", h && h.cell.join() === "2,1,3" && near(h.t, 3) && h.axis === 0, JSON.stringify(h));
	ok("dda.miss", marchBlocks(tex, dims, [-1, 0.5, 0.5], [1, 0, 0]) === null);
	ok("dda.tMax", marchBlocks(tex, dims, [-1, 1.5, 3.5], [1, 0, 0], 0, 2.5) === null);
	const inside = marchBlocks(tex, dims, [2.5, 1.5, 3.5], [0, 0, -1]);
	ok("dda.inside", inside && inside.cell.join() === "2,1,3" && inside.axis === -1 && inside.steps === 0, JSON.stringify(inside));
	const diag = marchBlocks(tex, dims, [-0.5, -1.5, 0.5], [1, 1, 1].map(v => v / Math.sqrt(3)));   // s＝2.5〜3.5 で (2,1,3) を通る
	ok("dda.diagHit", diag && diag.cell.join() === "2,1,3" && near(diag.t, 2.5 * Math.sqrt(3), 1e-6), JSON.stringify(diag));
	ok("dda.diagMiss", marchBlocks(tex, dims, [-0.5, -1.5, 1.5], [1, 1, 1].map(v => v / Math.sqrt(3))) === null);   // z が 1 つ上＝(2,1,4) は外
	ok("dda.thr", marchBlocks(tex, dims, [-1, 1.5, 3.5], [1, 0, 0], 0.9) === null && marchBlocks(tex, dims, [-1, 1.5, 3.5], [1, 0, 0], 0.7) !== null);   // 200 → (199/254)=0.78
	const rgba = new Uint8Array(64 * 4); rgba[(2 + 4 * (1 + 4 * 3)) * 4 + 3] = 1;
	ok("dda.rgba", marchBlocks(rgba, dims, [-1, 1.5, 3.5], [1, 0, 0], 0, Infinity, 4)?.cell.join() === "2,1,3");
}
// ---- prepare ----
{
	const d = { dims: [2, 3, 4], box: { origin: [139.76, 35.68, 0], size: [20, 30, 40] }, values: new Float32Array(24).map((_, i) => i), range: [0, 23] };
	const p = prepare(d, { colormap: "heat", threshold: 10 });
	ok("prep", p.shape === "box" && p.dims.join() === "2,3,4" && p.comps === 1 && p.n === 24 && p.tex.length === 24 && p.cmap.length === 1024 && p.tex[9] > 0 && p.tex[10] > 0 && p.tex[23] === 255 && near(p.thr, 10 / 23) && p.range.join() === "0,23" && !p.placed && near(p.A[0], 10) && near(p.A[8], 10) && p.geo === null);   // 閾では切らない（等値面は場の全体が要る）＝描き手が見る
	ok("prep.values.kept", d.values[23] === 23);
	const r = prepare({ dims: [1, 1, 1], box: { origin: [0, 0, 0], size: [1, 1, 1] }, values: new Uint8Array([1, 2, 3, 4]), components: 4 });
	ok("prep.rgba", r.comps === 4 && r.tex.join() === "1,2,3,4" && r.range.join() === "0,1");
	const g = prepare({ dims: [4, 2, 2], region: [139, 35, 140, 36, 0, 1000], values: new Uint8Array(16) });
	ok("prep.region", g.shape === "region" && g.geo && g.geo.shell.length > 0 && g.placed && near(g.anchor[0], 139.5));
	ok("prep.bad", throws(() => checkVoxelData({ dims: [1, 1], values: new Uint8Array(1) }), /VoxelData/) && throws(() => checkVoxelData({ dims: [1, 1, 1], values: new Uint8Array(2), box: {} }), /length/) && throws(() => prepare({ dims: [1, 1, 1], box: { origin: [0, 0, 0], size: [1, 1, 1] }, values: new Float32Array(1) }, { range: [1, 1] }), /range/));
	ok("prep.rangeOpt", prepare({ ...d, range: undefined }, { range: [0, 100] }).tex[23] === 1 + Math.round(23 / 100 * 254));
	ok("prep.autoRange", prepare({ ...d, range: undefined }).range.join() === "0,23");
}
// ---- ブリック（第 5 段） ----
{
	ok("brick.consts", BRICK === 126 && BRICK_LIMIT === 256 && needsBricks([257, 1, 1]) && !needsBricks([256, 256, 256]));
	ok("brick.spans", JSON.stringify(brickSpans(300, 126)) === "[[0,126],[126,252],[252,300]]" && brickSpans(5, 126).length === 1);
	const dims = [5, 4, 3], v = new Float32Array(60 * 2).map((_, i) => i);
	const sub = extract(v, dims, 2, [1, 2, 1], [3, 2, 2]);
	const want = []; for (let k = 1; k < 3; k++) for (let j = 2; j < 4; j++) for (let i = 1; i < 4; i++) { const g = (i + 5 * (j + 4 * k)) * 2; want.push(g, g + 1); }
	ok("brick.extract", sub instanceof Float32Array && sub.join() === want.join());
	ok("brick.maxOf", maxOf(new Uint8Array([3, 9, 2]), 1) === 9 && maxOf(new Uint8Array([200, 0, 0, 7, 250, 0, 0, 5]), 4) === 7);
	ok("brick.parentIndex", JSON.stringify(parentIndex(1 + 3 * (1 + 2 * 1), [3, 2, 2], [1, 2, 1], dims)) === JSON.stringify({ index: 2 + 5 * (3 + 4 * 2), cell: [2, 3, 2] }));
	// 300×10×4 の box＝x で 3 枚（糊代つき）・値は x＝セルの番号の i
	const NX = 300, NY = 10, NZ = 4, val = new Float32Array(NX * NY * NZ);
	for (let k = 0; k < NZ; k++) for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) val[i + NX * (j + NY * k)] = i < 260 ? i : 0;   // 260 以降は空（noData 0）
	const g = prepareGrid({ dims: [NX, NY, NZ], box: { origin: [139.76, 35.68, 0], size: [300, 10, 4] }, values: val, noData: 0, range: [0, 299] }, { threshold: 100 });
	const B = g.bricks;
	ok("brick.split", B && B.length === 3 && g.tex.length === 0 && g.n === NX * NY * NZ && g.dims.join() === "300,10,4" && near(g.thr, 100 / 299), `${B?.length}`);
	ok("brick.apron", B[0].off.join() === "0,0,0" && B[0].dims.join() === "127,10,4" && B[0].own.join() === "0,0,0,126,10,4"
		&& B[1].off.join() === "125,0,0" && B[1].dims.join() === "128,10,4" && B[1].own.join() === "1,0,0,127,10,4"
		&& B[2].off.join() === "251,0,0" && B[2].dims.join() === "49,10,4" && B[2].own.join() === "1,0,0,49,10,4", JSON.stringify(B.map(b => [b.off, b.dims, b.own])));
	const q = x => 1 + Math.round(x / 299 * 254);
	ok("brick.values", B[1].tex[0] === q(125) && B[1].tex[127] === q(252) && B[2].tex[0] === q(251) && B[2].tex[9] === 0 && B[0].A.join() === g.A.join() && B[1].anchor.join() === g.anchor.join(), `${B[1].tex[0]} ${B[1].tex[127]} ${B[2].tex[9]}`);
	ok("brick.vmax", B[0].vmax === q(126) && B[2].vmax === q(259) && g.vmax === q(259));
	ok("brick.empty", !isEmpty({ vmax: B[2].vmax, thr: g.thr, comps: 1 }) && isEmpty({ vmax: B[0].vmax, thr: (200 / 299), comps: 1 }) && isEmpty({ vmax: 0, thr: 0, comps: 4 }) && !isEmpty({ vmax: 1, thr: 0.9, comps: 4 }));
	ok("brick.small", prepareGrid({ dims: [2, 2, 2], box: { origin: [0, 0, 0], size: [1, 1, 1] }, values: new Uint8Array(8).fill(3) }).bricks === null);
	// 描く範囲＝持ち分と断面（親の割合）の交わり
	const L1 = { dims: B[1].dims, off: B[1].off, own: B[1].own, full: g.dims, clip: null };
	ok("brick.bounds", JSON.stringify(drawBounds(L1)) === JSON.stringify({ lo: [1, 0, 0], hi: [127, 10, 4] }));
	ok("brick.bounds.clip", JSON.stringify(drawBounds({ ...L1, clip: [0, 0.5, 0, 1, 0, 0.5] })) === JSON.stringify({ lo: [1, 0, 0], hi: [25, 10, 2] }) && drawBounds({ ...L1, clip: [0.9, 1, 0, 1, 0, 1] }) === null);
	ok("brick.bounds.single", JSON.stringify(drawBounds({ dims: [4, 4, 4], off: null, own: null, full: null, clip: [0, 0.5, 0, 1, 0, 1] })) === JSON.stringify({ lo: [0, 0, 0], hi: [2, 4, 4] }));
	// 当たり＝親の番号と経緯度（ブリックの中心は親の同じセル）
	const P1 = { q: "big#1", layer: "big", dims: B[1].dims, off: B[1].off, full: g.dims };
	const pc = pickedCell("big#1", P1, 2 + 128 * (3 + 10 * 1));
	ok("brick.pick", pc.layer === "big" && pc.cell.join() === "127,3,1" && pc.index === 127 + 300 * (3 + 10 * 1));
	const hl = hitOf({ ...B[1], properties: null }, 2 + 128 * (3 + 10 * 1)), hp = hitOf({ dims: g.dims, A: g.A, anchor: g.anchor, geo: null, properties: null }, pc.index);
	ok("brick.pick.lngLat", near(hl.lngLat[0], hp.lngLat[0], 1e-9) && near(hl.lngLat[1], hp.lngLat[1], 1e-9), `${hl.lngLat} ${hp.lngLat}`);
	// 奥から描く順＝中心の遠い順（東の端から見る＝東のブリックが近い）
	const eye = [400, 5, 2], dd = B.map(b => centerDist({ dims: b.dims, A: b.A, off: b.off, geo: null }, eye));
	ok("brick.order", dd[0] > dd[1] && dd[1] > dd[2], dd.map(v => v.toFixed(1)).join());
	// region＝経度で 3 枚・部分の region が隣と継ぎ目で揃う
	const rg = prepareGrid({ dims: [260, 4, 2], region: [130, 30, 156, 32, 0, 2000], values: new Uint8Array(260 * 8).fill(5) });
	const R = rg.bricks;
	ok("brick.region", R.length === 3 && R.every(b => b.geo && b.geo.shell.length > 0) && near(R[0].geo.west, 130) && near(R[1].geo.west, 130 + 26 * 125 / 260, 1e-9) && near(R[2].geo.west + R[2].geo.spanLon, 156, 1e-9) && near(R[1].geo.spanLon, 26 * 128 / 260, 1e-9) && R[1].geo.h0 === 0 && R[1].geo.h1 === 2000, JSON.stringify(R.map(b => [b.geo.west, b.geo.spanLon])));
	// 手綱＝ブリックごとに layer を送る・見た目は全部へ・撤去も全部
	const posts = [], ids = new Set();
	const fake = { overlay: (url, o) => ({ name: o.name, onmessage: null, post: (d, tr) => posts.push([d, tr]), remove: () => {}, addLayerId: id => ids.add(id), removeLayerId: id => ids.delete(id), el: null }), pickOverlays: async () => [{ layer: "big", index: 127 + 300 * 13, cell: [127, 3, 1], value: null, properties: { value: null }, distance: 0, lngLat: [0, 0], id: 9 }] };
	const hb = createVoxel(fake, { dims: [NX, NY, NZ], box: { origin: [139.76, 35.68, 0], size: [300, 10, 4] }, values: val, noData: 0 }, { id: "big", render: "blocks" });
	await hb.ready;
	const lay = posts.filter(([d]) => d.type === "layer").map(([d]) => d);
	ok("brick.handle", hb.bricks === 3 && hb.n === NX * NY * NZ && hb.dims.join() === "300,10,4" && lay.length === 3 && lay.map(d => d.q).join() === "big#0,big#1,big#2" && lay.every(d => d.layer === "big" && d.full.join() === "300,10,4" && d.mode === 0 && typeof d.vmax === "number") && lay[1].off.join() === "125,0,0" && lay[0].cmap !== lay[1].cmap, lay.map(d => d.q).join());
	ok("brick.handle.value", (await hb.pick(1, 1))[0]?.value === 127);
	posts.length = 0; await hb.setProps({ opacity: 0.3, colormap: "grey" });
	ok("brick.style", posts.length === 3 && posts.every(([d]) => d.type === "style" && d.opacity === 0.3 && d.cmap.length === 1024) && posts[0][0].cmap !== posts[1][0].cmap);
	posts.length = 0; hb.setVisible(false);
	ok("brick.vis", posts.length === 3 && posts.every(([d]) => d.type === "vis" && d.on === false));
	posts.length = 0; await hb.setData({ dims: [2, 2, 2], box: { origin: [139.76, 35.68, 0], size: [10, 10, 10] }, values: new Float32Array(8).fill(1) });
	ok("brick.toSingle", hb.bricks === 0 && posts.filter(([d]) => d.type === "remove").map(([d]) => d.q).join() === "big#0,big#1,big#2" && posts.some(([d]) => d.type === "layer" && d.q === "big" && d.on === false));
	posts.length = 0; hb.remove();
	ok("brick.remove", posts.filter(([d]) => d.type === "remove").map(([d]) => d.q).join() === "big" && !ids.has("big"));
}
// ---- 時間の次元（第 5 段 ②・times） ----
{
	ok("time.frameAt", frameAt([10, 20, 30], 5) === 0 && frameAt([10, 20, 30], 10) === 0 && frameAt([10, 20, 30], 25) === 1 && frameAt([10, 20, 30], 30) === 2 && frameAt([10, 20, 30], 99) === 2 && frameAt([10], 0) === 0);
	ok("time.frameValues", frameValues(new Float32Array([1, 2, 3, 4, 5, 6]), 3, 1, 1).join() === "4,5,6");
	const v = new Float32Array(8 * 3); for (let t = 0; t < 3; t++) v.fill(t * 10, t * 8, t * 8 + 8);   // こま 0＝0・1＝10・2＝20
	const d = { dims: [2, 2, 2], box: { origin: [139.76, 35.68, 0], size: [10, 10, 10] }, values: v, times: [1000, 2000, 3000] };
	ok("time.bad", throws(() => checkVoxelData({ ...d, values: new Float32Array(8) }), /length 8 != 24/) && throws(() => checkVoxelData({ ...d, times: [3, 2, 1] }), /ascending/));
	const p = prepare(d);
	ok("time.prepare", p.times.join() === "1000,2000,3000" && p.frames.length === 3 && p.tex === p.frames[0] && p.range.join() === "0,20" && p.frames[0][0] === 1 && p.frames[1][0] === 1 + 127 && p.frames[2][0] === 255 && p.n === 8, `${p.range} ${p.frames.map(f => f[0])}`);
	ok("time.none", prepare({ ...d, values: new Float32Array(8), times: undefined }).frames === null);
	const g = prepareGrid({ dims: [300, 1, 1], box: { origin: [0, 0, 0], size: [300, 1, 1] }, values: new Float32Array(600).map((_, i) => i < 300 ? 0 : 1), times: [0, 1], range: [0, 1] });
	ok("time.bricks", g.bricks.length === 3 && g.bricks.every(b => b.frames.length === 2 && b.frames[0][0] === 1 && b.frames[1][0] === 255) && g.vmax === 255 && g.times.join() === "0,1");
	// 手綱＝map.clock に付いて行く・数で固定・当たりの値はそのこま
	const posts = [], subs = { tick: new Set(), change: new Set() };
	const clock = { time: 1500, on(ev, cb) { subs[ev].add(cb); return clock; }, off(ev, cb) { subs[ev].delete(cb); return clock; } };
	const fire = () => subs.tick.forEach(cb => cb(clock));
	const fake = { clock, overlay: (url, o) => ({ name: o.name, onmessage: null, post: (x, tr) => posts.push(x), remove: () => {}, addLayerId: () => {}, removeLayerId: () => {}, el: null }), pickOverlays: async () => [{ layer: "tv", index: 3, cell: [1, 1, 0], value: null, properties: { value: null }, distance: 0, lngLat: [0, 0], id: 4 }] };
	const h = createVoxel(fake, d, { id: "tv" });
	await h.ready;
	const L = posts.find(x => x.type === "layer");
	ok("time.handle", h.times.join() === "1000,2000,3000" && h.frame === 0 && L.frames.length === 3 && L.frame === 0 && subs.tick.size === 1 && subs.change.size === 1);
	ok("time.pick0", (await h.pick(0, 0))[0].value === 0);
	posts.length = 0; clock.time = 2500; fire();
	ok("time.follow", h.frame === 1 && posts.length === 1 && posts[0].type === "style" && posts[0].frame === 1 && posts[0].q === "tv");
	ok("time.pick1", (await h.pick(0, 0))[0].value === 10);
	posts.length = 0; fire(); ok("time.same", posts.length === 0);   // 同じこま＝送らない
	posts.length = 0; await h.setProps({ time: 3000 });
	ok("time.pin", h.frame === 2 && posts.length === 1 && posts[0].frame === 2 && subs.tick.size === 0);
	clock.time = 1000; fire(); ok("time.pinned", h.frame === 2);
	await h.setProps({ time: "clock" }); ok("time.refollow", h.frame === 0 && subs.tick.size === 1);
	ok("time.badOpt", throws(() => h.setProps({ time: "now" }), /time/));
	h.remove(); ok("time.unsub", subs.tick.size === 0 && subs.change.size === 0);
}
// ---- LoD（GPU の予算・第 5 段 ③） ----
{
	ok("lod.dims", levelDims([5, 4, 1], 2).join() === "3,2,1" && levelDims([300, 8, 4], 4).join() === "75,2,1");
	ok("lod.count", levelCount([300, 8, 4], 1, 5000) === 1 && levelCount([300, 8, 4], 1, 1e9) === 0 && levelCount([300, 8, 4], 1, null) === 0 && levelCount([8, 8, 8], 1, 100) === 2 && levelCount([512, 512, 512], 4, 1) === LOD_MAX);
	const d3 = downsample(new Uint8Array([10, 0, 30]), [3, 1, 1], 1);
	ok("lod.down.odd", d3.dims.join() === "2,1,1" && d3.tex.join() === "10,30", d3.tex.join());   // 空は平均に入れない・端の奇数は一つで
	const c8 = new Uint8Array(8).fill(100); c8[0] = 0; c8[7] = 40;
	ok("lod.down.mean", downsample(c8, [2, 2, 2], 1).tex.join() === String(Math.round((100 * 6 + 40) / 7)) && downsample(new Uint8Array(8), [2, 2, 2], 1).tex[0] === 0);
	const rg = new Uint8Array(16); rg.set([200, 0, 0, 255, 0, 0, 0, 0, 0, 100, 0, 128, 0, 0, 0, 0]);
	ok("lod.down.rgba", downsample(rg, [4, 1, 1], 4).tex.join() === "200,0,0,255,0,100,0,128");
	ok("lod.pyramid", JSON.stringify(pyramid([new Uint8Array(64).fill(5)], [4, 4, 4], 1, 2).map(l => [l.s, l.dims, l.frames[0].length, l.frames[0][0]])) === JSON.stringify([[2, [2, 2, 2], 8, 5], [4, [1, 1, 1], 1, 5]]));
	// 一枚の格子＝粗い段は own が元の格子の 1/s（奇数の端は半端）・box の A は s 倍
	const g1 = prepareGrid({ dims: [5, 4, 4], box: { origin: [139.76, 35.68, 0], size: [5, 4, 4] }, values: new Float32Array(80).fill(1) }, { lodBytes: 40 });
	const l1 = g1.lods?.[0];
	ok("lod.single", g1.bricks === null && g1.lods?.length === 2 && l1.s === 2 && l1.dims.join() === "3,2,2" && l1.off.join() === "0,0,0" && l1.own.join() === "0,0,0,2.5,2,2" && near(l1.A[0], g1.A[0] * 2) && l1.anchor.join() === g1.anchor.join(), JSON.stringify(g1.lods?.map(l => [l.s, l.dims, l.own])));
	ok("lod.none", prepareGrid({ dims: [5, 4, 4], box: { origin: [0, 0, 0], size: [1, 1, 1] }, values: new Float32Array(80) }).lods === null);
	// ブリック＝ブリックごとの粗い段・継ぎ目は粗い段でも隙間なし
	const NX = 300, val = new Float32Array(NX * 8 * 4); for (let i = 0; i < val.length; i++) val[i] = (i % NX) + 1;
	const g = prepareGrid({ dims: [NX, 8, 4], box: { origin: [139.76, 35.68, 0], size: [300, 8, 4] }, values: val, range: [1, 300] }, { lodBytes: 5000 });
	const L0 = g.bricks.map(b => b.lods?.[0]), q2 = v => 1 + Math.round((v - 1) / 299 * 254);
	ok("lod.bricks", g.bricks.length === 3 && L0.every(l => l && l.s === 2) && L0[0].off.join() === "0,0,0" && L0[0].own.join() === "0,0,0,63,4,2" && L0[1].off.join() === "62,0,0" && L0[1].own.join() === "1,0,0,64,4,2" && L0[2].own.join() === "1,0,0,25,4,2", JSON.stringify(L0.map(l => [l.off, l.dims, l.own])));
	ok("lod.seams", L0.every((l, i) => i === 0 || l.off[0] + l.own[0] === L0[i - 1].off[0] + L0[i - 1].own[3]));
	const pz = pyramid([quantize(val, [1, 300], undefined, null)], [NX, 8, 4], 1, 1)[0].frames[0];   // 粗い段のブリック＝格子全体を縮めてから切った物
	ok("lod.values", L0[1].tex[0] === pz[62] && L0[1].tex[1] === pz[63] && L0[1].tex[1 + 65] === pz[63 + 150] && pz[63] === Math.round((q2(127) + q2(128)) / 2), `${L0[1].tex[1]} ${pz[63]}`);
	ok("lod.bricks.region", prepareGrid({ dims: [NX, 8, 4], region: [130, 30, 140, 31, 0, 1000], values: val }, { lodBytes: 5000 }).bricks.every(b => b.lods?.[0]?.geo?.shell instanceof Float32Array));
	// 描く範囲・当たり（粗い段）
	ok("lod.bounds", JSON.stringify(drawBounds({ dims: L0[1].dims, off: L0[1].off, own: L0[1].own, full: g.dims, clip: null, s: 2 })) === JSON.stringify({ lo: [1, 0, 0], hi: [64, 4, 2] })
		&& JSON.stringify(drawBounds({ dims: L0[1].dims, off: L0[1].off, own: L0[1].own, full: g.dims, clip: [0, 0.5, 0, 1, 0, 1], s: 2 })) === JSON.stringify({ lo: [1, 0, 0], hi: [13, 4, 2] }));
	const pc = pickedCell("big#1", { layer: "big", dims: L0[1].dims, off: L0[1].off, full: g.dims, s: 2 }, 1 + L0[1].dims[0] * (1 + 4 * 1));
	ok("lod.pick", pc.layer === "big" && pc.cell.join() === "127,3,3" && pc.index === 127 + 300 * (3 + 8 * 3), JSON.stringify(pc));
	ok("lod.cell", near(cellOf(g.A, null), 1, 1e-6) && near(cellOf(L0[0].A, null), 2, 1e-6));
	// 割り振り＝予算の中で一番細かく・遠い方から粗く
	const it = [{ dist: 10, cell: 1, bytes: [800, 100] }, { dist: 1000, cell: 1, bytes: [800, 100] }];
	ok("lod.plan", planLevels(it, Infinity).join() === "0,0" && planLevels(it, 1000).join() === "0,1" && planLevels(it, 150).join() === "1,1" && planLevels([], 1).length === 0);
	ok("lod.plan.cell", planLevels([{ dist: 100, cell: 10, bytes: [800, 100] }, { dist: 50, cell: 1, bytes: [800, 100] }], 1000).join() === "0,1");   // 近くても細かいセル（小さく見える）の方を粗く
	ok("lod.plan.levels", planLevels([{ dist: 10, cell: 1, bytes: [800, 100, 10] }, { dist: 1e5, cell: 1, bytes: [800, 100, 10] }], 820).join() === "0,2");
}
// ---- plugin の形と手綱（偽の map） ----
{
	const p = voxelPlugin();
	ok("plugin.shape", p.name === "voxel" && p.version === VERSION && p.provides.join() === "data.voxel" && typeof p.install === "function");
	ok("plugin.badBudget", throws(() => voxelPlugin({ budget: 0 }), /budget/) && throws(() => voxelPlugin({ budget: "1" }), /budget/) && voxelPlugin({ budget: Infinity }).name === "voxel");
	ok("plugin.badBackend", throws(() => voxelPlugin({ backend: "metal" }), /backend/) && voxelPlugin({ backend: "webgpu" }).name === "voxel");
	const reg = new Map(), map = { registry: { dataKinds: { add: (k, v) => reg.set(k, v), remove: k => reg.delete(k) } } };
	const un = p.install(map);
	ok("plugin.install", reg.has("voxel") && typeof reg.get("voxel").create === "function");
	un(); ok("plugin.uninstall", !reg.has("voxel"));
	// 偽の overlay＝描き手へ届く message を見る（node には Worker が無い＝main で prepare）
	const posts = [], ids = new Set();
	const fake = { overlay: (url, o) => ({ name: o.name, onmessage: null, post: (d, tr) => posts.push([d, tr]), remove: () => posts.push(["removed"]), addLayerId: id => { if (ids.has(id)) throw new Error("dup"); ids.add(id); }, removeLayerId: id => ids.delete(id), el: null, pick: async () => [] }), pickOverlays: async () => [{ layer: "v1", index: 3, cell: [1, 1, 0], value: null, properties: { index: 3, cell: [1, 1, 0], value: null }, distance: 0, lngLat: [0, 0], id: 4 }, { layer: "other", index: 0 }] };
	const data = { dims: [2, 2, 2], box: { origin: [139.76, 35.68, 0], size: [10, 10, 10] }, values: new Float32Array([0, 1, 2, 3, 4, 5, 6, 7]) };
	const h = createVoxel(fake, data, { id: "v1", render: "blocks", colormap: "grey", opacity: 0.5, properties: { name: "x" } });
	await h.ready;
	ok("handle.budget", posts[0][0].type === "budget" && posts[0][0].bytes === defaultBudgetMB() * 2 ** 20 && defaultBudgetMB() === 512, JSON.stringify(posts[0][0])); posts.shift();   // オーバーレイを立てた時に一度
	const [body, tr] = posts[0];
	ok("handle.ready", h.n === 8 && h.dims.join() === "2,2,2" && h.reader === "main" && h.range.join() === "0,7" && h.anchor[0] === 139.76 && h.kind === "voxel" && h.backend === null && h.error === null && h.shape === "box", `${h.n} ${h.reader} ${h.range}`);
	ok("handle.post", body.type === "layer" && body.q === "v1" && body.shape === "box" && body.geo === null && body.mode === 0 && body.comps === 1 && body.tex.length === 8 && body.cmap.length === 1024 && body.opacity === 0.5 && body.alt === "relative" && body.depthTest === true && body.properties.name === "x" && body.on === true && body.clip === null && Array.isArray(tr) && tr.length >= 2, JSON.stringify({ ...body, tex: body.tex.length, cmap: body.cmap.length, A: Array.from(body.A).map(v => +v.toFixed(2)) }));
	const pk = await h.pick(1, 1);
	ok("handle.pick", pk.length === 1 && pk[0].layer === "v1" && pk[0].value === 3 && pk[0].properties.value === 3, JSON.stringify(pk));
	// 見た目だけの変更＝"style"（格子を上げ直さない）
	await h.setProps({ render: "iso", threshold: 3.5, clip: [0, 0.5, 0, 1, 0, 1], colormap: "grey" });
	const st = posts[1][0];
	ok("handle.style", st.type === "style" && st.q === "v1" && st.mode === 2 && near(st.thr, 0.5) && st.clip.join() === "0,0.5,0,1,0,1" && st.cmap instanceof Uint8Array && st.cmap.length === 1024 && st.opacity === undefined && posts.length === 2, JSON.stringify({ ...st, cmap: st.cmap?.length }));
	ok("style.keys", STYLE_KEYS.includes("clip") && !STYLE_KEYS.includes("range") && !STYLE_KEYS.includes("altitude"));
	await h.setProps({ render: "volume", altitude: "absolute" });   // altitude＝置き直し＝"layer"
	ok("handle.setProps", posts[2][0].type === "layer" && posts[2][0].mode === 1 && posts[2][0].alt === "absolute" && near(posts[2][0].thr, 0.5) && posts[2][0].clip.join() === "0,0.5,0,1,0,1");
	h.setVisible(false); ok("handle.vis", posts[3][0].type === "vis" && posts[3][0].on === false);
	ok("handle.dup", throws(() => createVoxel(fake, data, { id: "v1" }), /already exists/));
	ok("handle.badOpts", throws(() => createVoxel(fake, data, { id: "v2", render: "mesh" }), /render/) && throws(() => createVoxel(fake, data, { id: "v3", step: 0 }), /step/) && throws(() => createVoxel(fake, data, { id: "v4", opacity: 2 }), /opacity/) && throws(() => createVoxel(fake, data, { id: "v7", clip: [0, 1] }), /clip/) && throws(() => h.setProps({ threshold: "x" }), /threshold/));
	// region の手綱＝geo と殻が描き手へ届く・既定は絶対高さ
	const hr = createVoxel(fake, { dims: [4, 2, 2], region: [139, 35, 140, 36, 0, 1000], values: new Uint8Array(16).fill(9) }, { id: "r1", render: "blocks" });
	await hr.ready;
	const rb = posts[posts.length - 1][0];
	ok("handle.region", hr.shape === "region" && rb.shape === "region" && rb.geo && rb.geo.shell instanceof Float32Array && rb.alt === "absolute" && near(rb.anchor[0], 139.5) && rb.mode === 0);
	hr.remove();
	const h5 = createVoxel(fake, "a.nc", { id: "v5" });
	ok("handle.fileSource", await (async () => { try { await h5.ready; return false; } catch (e) { return /stage 5/.test(e.message); } })());
	h5.remove();   // 読めなくても手綱は生きている（setData で直せる）＝外すまでオーバーレイを持つ
	ok("handle.badData", throws(() => createVoxel(fake, { dims: [1, 1, 1], values: new Uint8Array(2), box: {} }, { id: "v6" }), /length/));
	h.remove(); ok("handle.remove", posts.some(([d]) => d?.type === "remove" && d.q === "v1") && !ids.has("v1"));
	// 場面の切り替え＝remove の直後の addData は同じオーバーレイを続投させる（片付けは猶予の後）
	const h2 = createVoxel(fake, data, { id: "v1" }); await h2.ready;
	ok("handle.readd.keeps", posts.filter(([d]) => d === "removed").length === 0 && h2.overlay === h.overlay);
	h2.remove();
	await new Promise(r => setTimeout(r, OVERLAY_LINGER_MS + 50));
	ok("handle.linger.removed", posts.filter(([d]) => d === "removed").length === 1);
	const h3 = createVoxel(fake, data, { id: "v1" }); await h3.ready;
	ok("handle.readd.new", h3.overlay !== h.overlay); h3.remove();
}
console.log(fails ? `voxel: ${fails} FAIL` : "voxel: all ok"); process.exit(fails ? 1 : 0);
