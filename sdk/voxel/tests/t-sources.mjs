// node の検定：格子のファイルの読み手（sources.ts・第 5 段 ④）＝NetCDF classic（手で書いた CDF-1／2／5・記録変数・scale／fill）・Zarr v2／v3（偽の fetch・gzip・欠けたチャンク・frames）・CF の座標（経緯度・高さ・気圧・時刻・降順の裏返し）・手綱（file source → 描き手へ）
import { readSource, parseNetCDF, sniffNetCDF, openZarr, zarrArray, toVoxelData, axisOf, cfTimes, heightsOf, pressureToHeight, edges, unpack, isZarrUrl, createVoxel, prepareGrid } from "../src/index.ts";
import { writeNetCDF } from "./nc-write.mjs";
let fails = 0;
const ok = (name, c, note = "") => { console.log(`${c ? "PASS" : "FAIL"} ${name}${note ? " " + note : ""}`); if (!c) fails++; };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;
const rejects = async (p, re) => { try { await p; return false; } catch (e) { return re ? re.test(e.message) : true; } };

// ---- CF の小物 ----
ok("axis", axisOf("lon", { units: "degrees_east" }) === "x" && axisOf("y", { units: "degrees_north" }) === "y" && axisOf("t", { units: "hours since 2020-01-01" }) === "t" && axisOf("plev", { units: "Pa" }) === "z" && axisOf("foo", { axis: "Z" }) === "z" && axisOf("foo", {}) === null);
const t0 = Date.UTC(2020, 0, 1);
ok("cfTimes", cfTimes([0, 6], "hours since 2020-01-01 00:00:00").join() === `${t0},${t0 + 6 * 3.6e6}` && cfTimes([1], "days since 2020-01-01T00:00:00Z")[0] === t0 + 8.64e7 && cfTimes([0], "seconds since 2020-01-01 09:00 +09:00")[0] === t0 && cfTimes([0], "months since 2020-01-01") === null && cfTimes([0], null) === null);
ok("cfTimes.year1", cfTimes([0], "days since 0001-01-01")[0] === Date.UTC(1, 0, 1) - Date.UTC(1, 0, 1) + new Date("0001-01-01T00:00:00Z").getTime());
ok("heights", heightsOf([1000, 500], { units: "hPa" }).map(Math.round).join() === `${Math.round(pressureToHeight(1e5))},${Math.round(pressureToHeight(5e4))}` && heightsOf([10], { units: "m", positive: "down" })[0] === -10 && heightsOf([2], { units: "km" })[0] === 2000 && near(pressureToHeight(101325), 0, 1e-6) && near(pressureToHeight(50000), 5574, 5));
ok("edges", JSON.stringify(edges([0, 1, 2])) === JSON.stringify({ lo: -0.5, hi: 2.5, asc: true }) && JSON.stringify(edges([40, 30])) === JSON.stringify({ lo: 25, hi: 45, asc: false }) && edges([5], 10).lo === 0);
const up = unpack([1, 2, -999, 5], { scale_factor: 0.5, add_offset: 10, _FillValue: -999, valid_max: 4 });
ok("unpack", up[0] === 10.5 && up[1] === 11 && Number.isNaN(up[2]) && Number.isNaN(up[3]));
ok("isZarrUrl", isZarrUrl("https://x/a.zarr") && isZarrUrl("https://x/a.zarr/") && isZarrUrl("https://x/a.zarr/zarr.json") && !isZarrUrl("https://x/a.nc"));

// ---- NetCDF classic ----
// (time, level, lat, lon)＝2×3×2×4・緯度は北から（降順）・高さは気圧の降順（1000 → 500 hPa＝高さは昇順）・time は記録の次元
const NX = 4, NY = 2, NZ = 3, NT = 2, N = NX * NY * NZ;
const cell = (t, k, j, i) => 100 * t + 10 * k + 2 * j + i;   // ファイルの並び（j＝0 が北）
const temp = new Int16Array(NT * N); for (let t = 0; t < NT; t++) for (let k = 0; k < NZ; k++) for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) temp[t * N + i + NX * (j + NY * k)] = cell(t, k, j, i) * 2;   // scale 0.5 で元に
temp[1] = -32767;   // fill
const ncFile = ver => writeNetCDF({ version: ver, dims: [["time", 0], ["level", NZ], ["lat", NY], ["lon", NX]], numrecs: NT, gatts: { title: "t" },
	vars: [
		{ name: "time", dims: ["time"], type: "double", attrs: { units: "hours since 2020-01-01 00:00:00" }, data: [0, 6] },
		{ name: "level", dims: ["level"], type: "float", attrs: { units: "hPa" }, data: [1000, 850, 700] },
		{ name: "lat", dims: ["lat"], type: "float", attrs: { units: "degrees_north" }, data: [36, 35] },
		{ name: "lon", dims: ["lon"], type: "float", attrs: { units: "degrees_east" }, data: [139, 140, 141, 142] },
		{ name: "temp", dims: ["time", "level", "lat", "lon"], type: "short", attrs: { units: "K", long_name: "air temperature", scale_factor: 0.5, _FillValue: -32767 }, data: temp },
	] });
for (const ver of [1, 2, 5]) {
	const b = ncFile(ver);
	ok(`nc${ver}.sniff`, sniffNetCDF(b) === "classic");
	const r = parseNetCDF(b);
	ok(`nc${ver}.vars`, r.vars.map(v => v.name).join() === "time,level,lat,lon,temp" && r.vars[4].shape.join() === "2,3,2,4" && r.vars[4].attrs.long_name === "air temperature");
	const d = await toVoxelData(r);
	ok(`nc${ver}.grid`, d.dims.join() === "4,2,3" && d.times.join() === `${t0},${t0 + 6 * 3.6e6}` && d.values.length === NT * N && d.meta.variable === "temp" && d.meta.units === "K" && d.meta.format === "netcdf", JSON.stringify({ dims: d.dims, times: d.times }));
	ok(`nc${ver}.region`, near(d.region[0], 138.5) && near(d.region[2], 142.5) && near(d.region[1], 34.5) && near(d.region[3], 36.5) && d.region[4] < 0 && d.region[5] > 2000, JSON.stringify(d.region));
	// 裏返し＝j＝0 が南（ファイルの j＝1）・値は scale 済み・fill は NaN
	ok(`nc${ver}.values`, d.values[0 + NX * (0 + NY * 0)] === cell(0, 0, 1, 0) && d.values[1 + NX * (1 + NY * 2)] === cell(0, 2, 0, 1) && d.values[N + 3] === cell(1, 0, 1, 3) && Number.isNaN(d.values[1 + NX * 1]), `${d.values[0]} ${d.values[1 + NX * (1 + NY * 2)]}`);
}
{
	const d = await readSource(ncFile(1).buffer, { frames: [1, 2], heights: [0, 9000] });
	ok("nc.frames", d.values.length === N && !d.times && d.values[0] === cell(1, 0, 1, 0) && d.region[4] === 0 && d.region[5] === 9000);
	ok("nc.variable", await rejects(readSource(ncFile(1), { variable: "nope" }), /not found/));
	ok("nc.hdf5", await rejects(readSource(new Uint8Array([0x89, 0x48, 0x44, 0x46, 13, 10, 26, 10])), /NetCDF-4/));
	ok("nc.notNc", await rejects(readSource(new Uint8Array([1, 2, 3, 4])), /not NetCDF/));
	// 時間の無い 3 次元（level, lat, lon）・float の既定の fill
	const f = new Float32Array(N).fill(1); f[2] = 9.969209968386869e36;
	const b3 = writeNetCDF({ version: 1, dims: [["z", NZ], ["y", NY], ["x", NX]], vars: [
		{ name: "z", dims: ["z"], type: "float", attrs: { units: "m", positive: "up" }, data: [100, 200, 300] },
		{ name: "y", dims: ["y"], type: "double", attrs: { units: "degrees_north" }, data: [10, 11] },
		{ name: "x", dims: ["x"], type: "double", attrs: { units: "degrees_east" }, data: [0, 1, 2, 3] },
		{ name: "q", dims: ["z", "y", "x"], type: "float", attrs: {}, data: f }] });
	const d3 = await readSource(b3);
	ok("nc.3d", d3.dims.join() === "4,2,3" && !d3.times && d3.region[4] === 50 && d3.region[5] === 350 && Number.isNaN(d3.values[2]) && d3.values[0] === 1);
	const g = prepareGrid(d3);
	ok("nc.prepare", g.shape === "region" && g.geo && g.dims.join() === "4,2,3" && g.tex[2] === 0 && g.tex[0] > 0);
	// 一つだけの記録変数（詰めて並ぶ）
	const b1 = writeNetCDF({ version: 1, dims: [["time", 0], ["y", 2], ["x", 3]], numrecs: 2, vars: [
		{ name: "y", dims: ["y"], type: "float", attrs: { units: "degrees_north" }, data: [0, 1] }, { name: "x", dims: ["x"], type: "float", attrs: { units: "degrees_east" }, data: [0, 1, 2] },
		{ name: "v", dims: ["time", "y", "x"], type: "byte", attrs: {}, data: new Int8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) }] });
	const d1 = await readSource(b1);
	ok("nc.oneRecVar", d1.dims.join() === "3,2,1" && d1.times?.length === 2 && Array.from(d1.values).join() === "1,2,3,4,5,6,7,8,9,10,11,12", Array.from(d1.values).join());
}

// ---- Zarr ----
const gz = async (u8, fmt = "gzip") => new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new CompressionStream(fmt))).arrayBuffer());
const enc = o => new TextEncoder().encode(JSON.stringify(o));
const f32 = a => new Uint8Array(Float32Array.from(a).buffer);
const store = files => { const seen = []; const fetch = async u => { seen.push(u); const p = u.replace(/^https:\/\/z\/a\.zarr\//, ""); const b = files[p]; return b ? new Response(b) : new Response("", { status: 404 }); }; return { fetch, seen }; };
// v2（xarray 流・consolidated）＝(time 2, lat 2, lon 4)・チャンク (1, 2, 2)・gzip・一つのチャンクは欠ける（fill）
{
	const files = {};
	const arr = (shape, chunks, comp = { id: "gzip", level: 1 }, fill = "NaN") => ({ zarr_format: 2, shape, chunks, dtype: "<f4", compressor: comp, fill_value: fill, filters: null, order: "C" });
	const meta = { "time/.zarray": arr([2], [2], null), "time/.zattrs": { _ARRAY_DIMENSIONS: ["time"], units: "days since 2021-06-01" },
		"lat/.zarray": arr([2], [2], null), "lat/.zattrs": { _ARRAY_DIMENSIONS: ["lat"], units: "degrees_north" },
		"lon/.zarray": arr([4], [4], null), "lon/.zattrs": { _ARRAY_DIMENSIONS: ["lon"], units: "degrees_east" },
		"sst/.zarray": arr([2, 2, 4], [1, 2, 2]), "sst/.zattrs": { _ARRAY_DIMENSIONS: ["time", "lat", "lon"], units: "degC", long_name: "sea surface temperature" } };
	files[".zmetadata"] = enc({ zarr_consolidated_format: 1, metadata: meta });
	files["time/0"] = f32([0, 1]); files["lat/0"] = f32([20, 21]); files["lon/0"] = f32([130, 131, 132, 133]);
	for (const [t, y, x] of [[0, 0, 0], [0, 0, 1], [1, 0, 0]]) { const v = []; for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) v.push(1000 * t + 10 * j + 2 * x + i); files[`sst/${t}.${y}.${x}`] = await gz(f32(v)); }
	const s = store(files);
	const d = await readSource("https://z/a.zarr", { fetch: s.fetch });
	ok("zarr2.grid", d.dims.join() === "4,2,1" && d.meta.format === "zarr" && d.meta.variable === "sst" && d.times.join() === `${Date.UTC(2021, 5, 1)},${Date.UTC(2021, 5, 2)}` && near(d.region[0], 129.5) && near(d.region[3], 21.5), JSON.stringify({ dims: d.dims, r: d.region }));
	ok("zarr2.values", d.values[0] === 0 && d.values[3] === 3 && d.values[4 + 2] === 12 && d.values[8] === 1000 && Number.isNaN(d.values[8 + 2]), Array.from(d.values).join());
	const s2 = store(files);
	const df = await readSource("https://z/a.zarr/", { fetch: s2.fetch, frames: [1, 2] });
	ok("zarr2.frames", df.values.length === 8 && df.values[0] === 1000 && !s2.seen.some(u => /sst\/0\./.test(u)), s2.seen.filter(u => /sst/.test(u)).join(" "));
	// consolidated が無い＝variable で取る・座標は次元の名前で
	const nf = { ...files }; delete nf[".zmetadata"];
	for (const [k, v] of Object.entries(meta)) nf[k] = enc(v);
	ok("zarr2.noConsolidated", (await readSource("https://z/a.zarr", { fetch: store(nf).fetch, variable: "sst" })).dims.join() === "4,2,1");
	ok("zarr2.needVariable", await rejects(readSource("https://z/a.zarr", { fetch: store(nf).fetch }), /consolidated/));
	ok("zarr2.blosc", (() => { try { zarrArray({ ...arr([2], [2]), compressor: { id: "blosc" } }); return false; } catch (e) { return /blosc/.test(e.message); } })());
	ok("zarr2.zlib", zarrArray({ ...arr([2], [2]), compressor: { id: "zlib" } }).codec === "zlib");
}
// v3（consolidated_metadata・dimension_names・"c/" のキー・bytes＋gzip）＝(level 2, lat 2, lon 2)・高さ m
{
	const files = {}, a3 = (shape, chunks, codecs, dims, attributes = {}) => ({ zarr_format: 3, node_type: "array", shape, data_type: "float32", chunk_grid: { name: "regular", configuration: { chunk_shape: chunks } }, chunk_key_encoding: { name: "default", configuration: { separator: "/" } }, fill_value: 0, codecs, dimension_names: dims, attributes });
	const bytes = [{ name: "bytes", configuration: { endian: "little" } }];
	const md = { level: a3([2], [2], bytes, ["level"], { units: "m" }), lat: a3([2], [2], bytes, ["lat"], { units: "degrees_north" }), lon: a3([2], [2], bytes, ["lon"], { units: "degrees_east" }),
		w: a3([2, 2, 2], [2, 2, 2], [...bytes, { name: "gzip", configuration: { level: 1 } }], ["level", "lat", "lon"], { units: "m/s" }) };
	files["zarr.json"] = enc({ zarr_format: 3, node_type: "group", attributes: {}, consolidated_metadata: { kind: "inline", must_understand: false, metadata: md } });
	files["level/c/0"] = f32([500, 1500]); files["lat/c/0"] = f32([0, 1]); files["lon/c/0"] = f32([10, 11]);
	files["w/c/0/0/0"] = await gz(f32([1, 2, 3, 4, 5, 6, 7, 8]));
	const d = await readSource("https://z/a.zarr", { fetch: store(files).fetch });
	ok("zarr3.grid", d.dims.join() === "2,2,2" && d.region[4] === 0 && d.region[5] === 2000 && Array.from(d.values).join() === "1,2,3,4,5,6,7,8" && d.meta.units === "m/s", JSON.stringify({ r: d.region, v: Array.from(d.values) }));
	ok("zarr3.sharding", (() => { try { zarrArray(a3([2], [2], [{ name: "sharding_indexed" }], ["x"]), {}, true); return false; } catch (e) { return /sharding/.test(e.message); } })());
}

// ---- 手綱＝file source（偽の overlay・node は main で読む） ----
{
	const posts = [], ids = new Set();
	const fake = { overlay: (url, o) => ({ name: o.name, onmessage: null, post: (d, tr) => posts.push(d), remove: () => {}, addLayerId: id => ids.add(id), removeLayerId: id => ids.delete(id), el: null }), pickOverlays: async () => [{ layer: "nc", index: 0, cell: [0, 0, 0], value: null, properties: { index: 0, cell: [0, 0, 0], value: null }, distance: 0, lngLat: [0, 0], id: 1 }] };
	const h = createVoxel(fake, ncFile(2).buffer, { id: "nc", time: Date.UTC(2020, 0, 1, 7) });
	await h.ready;
	const body = posts.find(d => d.type === "layer");
	ok("handle.file", h.shape === "region" && h.dims.join() === "4,2,3" && h.times?.length === 2 && h.frame === 1 && h.source?.variable === "temp" && h.source?.units === "K" && h.reader === "main" && body?.shape === "region" && body?.geo, JSON.stringify({ s: h.shape, d: h.dims, f: h.frame, src: h.source?.variable }));
	const pk = await h.pick(0, 0);
	ok("handle.file.pick", pk[0].value === cell(1, 0, 1, 0), String(pk[0]?.value));   // こま 1 の値（main が持つ読んだ値）
	await h.setProps({ variable: "nope" }).then(() => ok("handle.file.badVar", false), e => ok("handle.file.badVar", /not found/.test(e.message)));
	ok("handle.badFrames", (() => { try { createVoxel(fake, ncFile(1).buffer, { id: "x", frames: [2, 1] }); return false; } catch (e) { return /frames/.test(e.message); } })());
	h.remove();
}
console.log(fails ? `voxel sources: ${fails} FAIL` : "voxel sources: all ok"); process.exit(fails ? 1 : 0);
