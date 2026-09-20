#!/usr/bin/env node
// 画像タイル層（raster.js / raster-src.js・2026-09-21）の常設ハーネス（Node・GPU 不要）。
//   1. expandTemplate：{z}/{x}/{y}・{-y}（TMS）・{s}（サブドメイン巡回）・{q}（quadkey）
//   2. normalizeSpec：xyz/pmtiles/port の判別と既定値・不正 spec は投げる
//   3. buildTileMesh：四隅が tileBounds と一致・uv は [0,1] 単調・行の緯度は逆メルカトル（同 z 同 y なら x に依らず同一）
//   4. ancestorUV：子 (z,x,y) を祖先 d 段上のテクスチャで描く部分 uv（メルカトル線形＝厳密）
//   5. createRaster：偽 renderer＋MessagePort プロバイダで add→update→描画リスト→hideFills→set/remove の一周（fetch/ImageBitmap 不要）
// 使い方: node packages/ortho-core/tests/raster.mjs
import { expandTemplate, normalizeSpec } from "../src/raster-src.js";
import { buildTileMesh, ancestorUV, subdivOf, createRaster } from "../src/raster.js";
import { tileBounds, tileLocalToLonLat } from "../src/tile.js";

let fails = 0;
const ok = (cond, label) => { if (cond) return; fails++; console.error(`  ✗ ${label}`); };
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

// 1. テンプレ展開
ok(expandTemplate("https://h/{z}/{x}/{y}.png", 3, 5, 2) === "https://h/3/5/2.png", "xyz template");
ok(expandTemplate("https://h/{z}/{x}/{-y}.png", 3, 5, 2) === "https://h/3/5/5.png", "{-y} = TMS flip (2^3-1-2)");
ok(expandTemplate("https://h/{z}/{x}/{y}.png", 3, 5, 2, null, true) === "https://h/3/5/5.png", "tms option flips {y}");
ok(expandTemplate("https://{s}.h/{z}/{x}/{y}", 1, 1, 0, ["a", "b"]) === "https://b.h/1/1/0", "{s} cycles by x+y");
ok(expandTemplate("https://h/{q}.jpg", 3, 3, 5) === "https://h/213.jpg", "quadkey (z3 x3 y5 = 213)");
ok(expandTemplate("https://h/{q}.jpg", 0, 0, 0) === "https://h/0.jpg", "quadkey z0 = 0");

// 2. spec 正規化
{
	const a = normalizeSpec({ url: "https://h/{z}/{x}/{y}.png" });
	ok(a.kind === "xyz" && a.tileSize === 256 && a.minZoom === 0 && a.maxZoom === 18 && a.bbox === null, "xyz defaults");
	const b = normalizeSpec({ url: "https://h/world.pmtiles" });
	ok(b.kind === "pmtiles" && b.url === "pmtiles://https://h/world.pmtiles", ".pmtiles url → pmtiles kind with prefix");
	const c = normalizeSpec({ pmtiles: "pmtiles://https://h/x.pmtiles" });
	ok(c.kind === "pmtiles" && c.url === "pmtiles://https://h/x.pmtiles", "pmtiles:// kept");
	const d = normalizeSpec({ url: "https://{s}.h/{z}/{x}/{y}", subdomains: "abc", tms: true, bbox: [1, 2, 3, 4], minZoom: 2, maxZoom: 9 });
	ok(d.subdomains.join("") === "abc" && d.tms && d.bbox.join() === "1,2,3,4" && d.minZoom === 2 && d.maxZoom === 9, "xyz options");
	let threw = 0;
	for (const bad of [null, {}, { url: "https://h/no-template.png" }]) { try { normalizeSpec(bad); } catch { threw++; } }
	ok(threw === 3, "invalid specs throw");
	ok(normalizeSpec({ port: { postMessage() {} } }).kind === "port", "port kind");
}

// 3. メッシュ
{
	for (const [z, x, y] of [[0, 0, 0], [3, 5, 2], [10, 909, 403], [16, 58210, 25806]]) {
		const n = subdivOf(z), m = buildTileMesh(z, y, n);
		const [w, s, e, nn] = tileBounds(x, y, z);
		const V = (n + 1) * (n + 1);
		ok(m.pos.length === V * 2 && m.uv.length === V * 2 && m.idx.length === n * n * 6, `z${z}: sizes (n=${n})`);
		// 四隅（タイル北西隅からの差分＝x に依らない：lon 差は幅・lat 差は行）
		ok(near(m.pos[0], 0) && near(m.pos[1], 0), `z${z}: NW corner at origin`);
		const last = (V - 1) * 2;
		const tol = Math.max(1e-6, (e - w) * 2e-7);   // 頂点は Float32（タイル局所の度＝z0 で 1.7m・z16 で mm 未満）
		ok(near(m.pos[last], e - w, tol) && near(m.pos[last + 1], s - nn, tol), `z${z}: SE corner = tile span (${(e - w).toFixed(6)}, ${(s - nn).toFixed(6)})`);
		// uv 単調・[0,1]
		let mono = true;
		for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) { const k = (j * (n + 1) + i) * 2; if (!near(m.uv[k], i / n, 1e-6) || !near(m.uv[k + 1], j / n, 1e-6)) mono = false; }
		ok(mono, `z${z}: uv = (i/n, j/n)`);
		// 行の緯度＝逆メルカトル（中央行を検分）
		const jm = n >> 1, [, latMid] = tileLocalToLonLat(x, y, z, 0, jm, n);
		ok(near(m.pos[(jm * (n + 1)) * 2 + 1], latMid - nn, tol), `z${z}: mid row latitude = inverse mercator`);
		// 三角形の index は範囲内
		let inRange = true; for (const i of m.idx) if (i >= V) inRange = false;
		ok(inRange, `z${z}: indices in range`);
	}
	ok(subdivOf(0) === 32 && subdivOf(4) === 16 && subdivOf(12) === 8, "subdivOf ladder");
}

// 4. 祖先 uv
{
	ok(ancestorUV(5, 2, 1).join() === [0.5, 0, 0.5, 0.5].join(), "child (x5,y2) in parent: right-top quadrant");
	ok(ancestorUV(7, 7, 2).join() === [0.75, 0.75, 0.25, 0.25].join(), "grandparent: (3/4,3/4) quarter");
	// 子の uv を祖先で引いた時、子タイルの北西隅 = 祖先内の (x&(m-1))/m … タイル境界がメルカトル線形で一致
	const z = 6, x = 37, y = 25, d = 2, uv = ancestorUV(x, y, d);
	const [w, , , n] = tileBounds(x, y, z), [pw, , pe, pn] = tileBounds(x >> d, y >> d, z - d);
	ok(near((w - pw) / (pe - pw), uv[0], 1e-12), "ancestor u0 matches longitude fraction");
	const merc = lat => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
	const [, ps] = tileBounds(x >> d, y >> d, z - d);
	ok(near((merc(pn) - merc(n)) / (merc(pn) - merc(ps)), uv[1], 1e-9), "ancestor v0 matches mercator fraction");
}

// 5. 管理層の一周（偽 renderer・port プロバイダ）
{
	const { MessageChannel } = globalThis;
	const ch = new MessageChannel();
	// プロバイダ：info を 1 通・要求には「偽ビットマップ」（width/height/close）を返す。z が奇数のタイルは無い（null）＝祖先フォールバックの検分
	ch.port1.onmessage = ev => { const q = ev.data; if (q.abort) return; ch.port1.postMessage({ id: q.id, bitmap: q.z % 2 ? null : { width: 256, height: 256 } }); };   // 関数は port を跨げない（構造化クローン）＝close 無しの偽ビットマップ
	ch.port1.postMessage({ type: "info", info: { tileSize: 256, minZoom: 0, maxZoom: 12, bbox: null, name: "fake", attribution: "fake attr" } });
	const R = { tex: 0, mesh: 0, freed: 0, last: undefined,
		rasterTex: bm => { R.tex++; return { kind: "tex", bytes: bm.width * bm.height * 4, bm }; },
		rasterMesh: m => { R.mesh++; return { kind: "mesh", bytes: m.pos.byteLength, count: m.idx.length }; },
		rasterFree: () => { R.freed++; }, setRasterDraws: rd => { R.last = rd; } };
	let draws = 0;
	const raster = createRaster({ renderer: R, requestDraw: () => { draws++; }, lowMem: false, post: () => {} });
	const info = await raster.add("t", { port: ch.port2 }, { order: "under" });
	ok(info.kind === "port" && info.maxZoom === 12 && info.attribution === "fake attr" && info.hideFills === true, "add → info from provider (under → hideFills)");
	const cam = { center: [139.7, 35.7], zoom: 10.3, pitch: 0, bearing: 0, dpr: 1 };
	const tick = async () => { raster.update(cam, 800, 600); await new Promise(r => setTimeout(r, 30)); };
	for (let i = 0; i < 40 && !(R.last && R.last.layers[0]?.draws.length); i++) await tick();
	await tick(); await tick();
	const st = raster.stats();
	ok(R.last && R.last.layers.length === 1 && R.last.layers[0].draws.length > 0, `draw list populated (${R.last?.layers[0]?.draws.length ?? 0} draws, ready=${st.layers[0]?.ready})`);
	ok(R.last.hideFills === true && R.last.layers[0].order === "under", "hideFills propagated for under layer");
	ok(R.last.near && R.last.near[0] < cam.center[0] && R.last.near[2] > cam.center[0] && R.last.near[1] < cam.center[1] && R.last.near[3] > cam.center[1], `near window contains center (${R.last.near?.map(v => v.toFixed(3)).join(",")})`);
	ok(R.last.atlas === 2048 && R.last.rev > 0, `atlas size/rev (${R.last.atlas}, rev=${R.last.rev})`);
	ok(R.last.layers[0].draws.every(d => d.nw && d.bounds && d.mesh && d.tex && d.uvT), "draw entries carry nw/bounds/mesh/tex/uvT");
	{ const r0 = R.last.rev; raster.update(cam, 800, 600); ok(R.last.rev === r0, "static camera + no arrivals = rev unchanged (no re-composite)"); }
	// 選抜 z≈9（10.3−1）は奇数＝無い → 祖先 z8 の部分 uv で描かれている（uvT の su=0.5）
	const anc = R.last.layers[0].draws.filter(d => d.uvT[2] < 1);
	ok(anc.length > 0 && anc.every(d => near(d.uvT[2], 0.5)), `odd zoom missing → parent fallback with quarter uv (${anc.length} draws)`);
	ok(st.layers[0].empty > 0 && st.layers[0].ready > 0, `stats: empty=${st.layers[0].empty} ready=${st.layers[0].ready}`);
	ok(raster.bytes() > 0 && R.tex > 0 && R.mesh > 0, "bytes/textures/meshes accounted");
	// set：visible=false → 描画リストから消える（テクスチャは保持）
	raster.set("t", { visible: false }); raster.update(cam, 800, 600);
	ok(R.last === null, "visible:false → no draws");
	raster.set("t", { visible: true, opacity: 0.5, order: "over" }); raster.update(cam, 800, 600);
	ok(R.last && R.last.layers[0].order === "over" && near(R.last.layers[0].opacity, 0.5) && R.last.hideFills === false, "set order/opacity → over layer does not hide fills");
	// 表示域の門：配信下限 0 の 1.5 段下＝−1.5 より下は描かない
	raster.update({ ...cam, zoom: -2 }, 800, 600);
	ok(R.last === null, "below showMin → no draws");
	// remove：GPU 資産を返す・描画リスト null
	const before = R.freed;
	ok(raster.remove("t") && R.freed > before && R.last === null && raster.list().length === 0, "remove frees textures and clears draws");
	raster.destroy();
	ch.port1.close(); ch.port2.close?.();
}

// 6. 退避の掟：予算が可視集合より小さくても「描画中のテクスチャ」は絶対に破棄しない（iPhone 黒画面 2026-09-21 の回帰封じ）＋粗化で可視集合が予算に収まる
{
	const ch = new MessageChannel();
	ch.port1.onmessage = ev => { const q = ev.data; if (q.abort) return; ch.port1.postMessage({ id: q.id, bitmap: { width: 256, height: 256 } }); };
	ch.port1.postMessage({ type: "info", info: { tileSize: 256, minZoom: 0, maxZoom: 18, bbox: null, name: "tiny" } });
	const freed = new Set(), live = new Set();
	const R = { last: null,
		rasterTex: bm => { const h = { kind: "tex", bytes: Math.round(bm.width * bm.height * 4 * 4 / 3) }; live.add(h); return h; },
		rasterMesh: m => ({ kind: "mesh", bytes: m.pos.byteLength, count: m.idx.length }),
		rasterFree: h => { if (h.kind === "tex") { freed.add(h); live.delete(h); } }, setRasterDraws: rd => { R.last = rd; } };
	const raster = createRaster({ renderer: R, requestDraw: () => {}, post: () => {}, budgetMB: 2 });   // 2MB ≈ 6 枚
	await raster.add("t", { port: ch.port2 }, { order: "under" });
	const cam = { center: [139.7, 35.7], zoom: 12, pitch: 0.6, bearing: 0, dpr: 1 };
	let bad = 0, maxDraws = 0;
	for (let i = 0; i < 60; i++) {
		raster.update(i % 2 ? cam : { ...cam, zoom: 12.0001 }, 800, 600);   // 静止と微動を交互＝両方の経路で退避が走る
		await new Promise(r => setTimeout(r, 25));
		if (R.last) for (const L of R.last.layers) for (const d of L.draws) if (freed.has(d.tex)) bad++;
		if (R.last) maxDraws = Math.max(maxDraws, R.last.layers[0]?.draws.length || 0);
	}
	// 20 フレーム静止＝在庫は予算超過のまま・描画リストは不変＝退避が描画中の物を触らないことの検分
	for (let i = 0; i < 20; i++) { raster.update(cam, 800, 600); await new Promise(r => setTimeout(r, 25)); if (R.last) for (const L of R.last.layers) for (const d of L.draws) if (freed.has(d.tex)) bad++; }
	const st = raster.stats();
	ok(bad === 0, `evict never frees textures in the draw list (violations=${bad}, freed=${freed.size})`);
	ok(maxDraws > 0 && maxDraws * 349525 <= 2 * 1048576 * 0.7 + 349525, `coarsening keeps visible set near budget (maxDraws=${maxDraws})`);
	ok(st.texBytes <= 2 * 1048576 + 349525 * 2 || freed.size > 0, `budget enforced or eviction ran (texBytes=${(st.texBytes / 1048576).toFixed(1)}MB freed=${freed.size})`);
	raster.destroy(); ch.port1.close();
}

console.log(fails ? `✗ ${fails} failure(s)` : "✓ raster: all checks passed");
process.exit(fails ? 1 : 0);
