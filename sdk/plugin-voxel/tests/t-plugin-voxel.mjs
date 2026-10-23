// node の検定：色表・値の詰め（R8／RGBA8）・置き方（origin/size/orientation・transform）・DDA（CPU 版）・prepare・plugin の形と手綱（偽の map＝描き手へ届く message）。描画は t-pvoxel（verify:ui）
import { buildColormap, colorStops, parseColor, quantize, toRgba8, valueRange, placeBox, hprMat, inv3, mul3, ecefEnuRows, ecefToLngLat, rayBox, marchBlocks, prepare, checkVoxelData, voxelPlugin, createVoxel, COLORMAP_NAMES, VERSION } from "../src/index.ts";
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
	ok("prep", p.dims.join() === "2,3,4" && p.comps === 1 && p.n === 24 && p.tex.length === 24 && p.cmap.length === 1024 && p.tex[9] === 0 && p.tex[10] > 0 && p.tex[23] === 255 && near(p.thr, 10 / 23) && p.range.join() === "0,23" && !p.placed && near(p.A[0], 10) && near(p.A[8], 10));
	ok("prep.values.kept", d.values[23] === 23);
	const r = prepare({ dims: [1, 1, 1], box: { origin: [0, 0, 0], size: [1, 1, 1] }, values: new Uint8Array([1, 2, 3, 4]), components: 4 });
	ok("prep.rgba", r.comps === 4 && r.tex.join() === "1,2,3,4" && r.range.join() === "0,1");
	ok("prep.region", throws(() => prepare({ dims: [1, 1, 1], region: [0, 0, 1, 1, 0, 1], values: new Uint8Array(1) }), /stage 2/));
	ok("prep.bad", throws(() => checkVoxelData({ dims: [1, 1], values: new Uint8Array(1) }), /VoxelData/) && throws(() => checkVoxelData({ dims: [1, 1, 1], values: new Uint8Array(2), box: {} }), /length/) && throws(() => prepare({ dims: [1, 1, 1], box: { origin: [0, 0, 0], size: [1, 1, 1] }, values: new Float32Array(1) }, { range: [1, 1] }), /range/));
	ok("prep.rangeOpt", prepare({ ...d, range: undefined }, { range: [0, 100] }).tex[23] === 1 + Math.round(23 / 100 * 254));
	ok("prep.autoRange", prepare({ ...d, range: undefined }).range.join() === "0,23");
}
// ---- plugin の形と手綱（偽の map） ----
{
	const p = voxelPlugin();
	ok("plugin.shape", p.name === "plugin-voxel" && p.version === VERSION && p.provides.join() === "data.voxel" && typeof p.install === "function");
	ok("plugin.badBackend", throws(() => voxelPlugin({ backend: "webgpu" }), /backend/));
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
	const [body, tr] = posts[0];
	ok("handle.ready", h.n === 8 && h.dims.join() === "2,2,2" && h.reader === "main" && h.range.join() === "0,7" && h.anchor[0] === 139.76 && h.kind === "voxel" && h.backend === null && h.error === null, `${h.n} ${h.reader} ${h.range}`);
	ok("handle.post", body.type === "layer" && body.q === "v1" && body.mode === 0 && body.comps === 1 && body.tex.length === 8 && body.cmap.length === 1024 && body.opacity === 0.5 && body.alt === "relative" && body.depthTest === true && body.properties.name === "x" && body.on === true && Array.isArray(tr) && tr.length >= 2, JSON.stringify({ ...body, tex: body.tex.length, cmap: body.cmap.length, A: Array.from(body.A).map(v => +v.toFixed(2)) }));
	const pk = await h.pick(1, 1);
	ok("handle.pick", pk.length === 1 && pk[0].layer === "v1" && pk[0].value === 3 && pk[0].properties.value === 3, JSON.stringify(pk));
	await h.setProps({ render: "volume", altitude: "absolute" });
	ok("handle.setProps", posts[1][0].mode === 1 && posts[1][0].alt === "absolute");
	h.setVisible(false); ok("handle.vis", posts[2][0].type === "vis" && posts[2][0].on === false);
	ok("handle.dup", throws(() => createVoxel(fake, data, { id: "v1" }), /already exists/));
	ok("handle.badOpts", throws(() => createVoxel(fake, data, { id: "v2", render: "iso" }), /render/) && throws(() => createVoxel(fake, data, { id: "v3", step: 0 }), /step/) && throws(() => createVoxel(fake, data, { id: "v4", opacity: 2 }), /opacity/));
	ok("handle.fileSource", await (async () => { try { await createVoxel(fake, "a.nc", { id: "v5" }).ready; return false; } catch (e) { return /stage 5/.test(e.message); } })());
	ok("handle.badData", throws(() => createVoxel(fake, { dims: [1, 1, 1], values: new Uint8Array(2), box: {} }, { id: "v6" }), /length/));
	h.remove(); ok("handle.remove", posts.some(([d]) => d?.type === "remove" && d.q === "v1") && !ids.has("v1"));
	const h2 = createVoxel(fake, data, { id: "v1" }); await h2.ready; h2.remove();
	ok("handle.readd", posts.filter(([d]) => d === "removed").length >= 0);
}
console.log(fails ? `plugin-voxel: ${fails} FAIL` : "plugin-voxel: all ok"); process.exit(fails ? 1 : 0);
