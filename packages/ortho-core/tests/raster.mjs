#!/usr/bin/env node
// 画像タイル層（raster.js / raster-src.js・2026-09-21）の常設ハーネス（Node・GPU 不要）。
//   1. expandTemplate：{z}/{x}/{y}・{-y}（TMS）・{s}（サブドメイン巡回）・{q}（quadkey）
//   2. normalizeSpec：xyz/pmtiles/port の判別と既定値・不正 spec は投げる
//   3. buildTileMesh：四隅が tileBounds と一致・uv は [0,1] 単調・行の緯度は逆メルカトル（同 z 同 y なら x に依らず同一）
//   3b. buildPoleCapMesh：端の行（±85.05°）から極までの帯・uv の v は縁の行に張り付く
//   4. ancestorUV：子 (z,x,y) を祖先 d 段上のテクスチャで描く部分 uv（メルカトル線形＝厳密）
//   5. createRaster：偽 renderer＋MessagePort プロバイダで add→update→描画リスト→hideFills→set/remove の一周（fetch/ImageBitmap 不要）
// 使い方: node packages/ortho-core/tests/raster.mjs
import { expandTemplate, normalizeSpec, wmsTemplate, wmtsFromCapabilities, adjustRGBA } from "../src/raster-src.ts";
import { buildTileMesh, buildPoleCapMesh, ancestorUV, subdivOf, createRaster } from "../src/raster.ts";
import { tileBounds, tileLocalToLonLat } from "../src/tile.ts";

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

// 1b. OGC（#45）：{bbox-epsg-3857}（WMS）・{TileMatrix}/{TileRow}/{TileCol}（WMTS）・wms/wmts 記述子・GetCapabilities の最小の読み
{
	const R = 20037508.342789244;
	ok(expandTemplate("https://h/?BBOX={bbox-epsg-3857}", 0, 0, 0) === `https://h/?BBOX=${-R},${-R},${R},${R}`, "bbox z0 = whole world");
	ok(expandTemplate("https://h/?BBOX={bbox-epsg-3857}", 1, 1, 0) === `https://h/?BBOX=0,0,${R},${R}`, "bbox z1 x1 y0 = NE quadrant");
	ok(expandTemplate("https://h/{TileMatrix}/{TileRow}/{TileCol}", 2, 3, 1, null, false, ["a", "b", "c"]) === "https://h/c/1/3", "wmts rest: matrix id by z, row=y col=x");
	ok(expandTemplate("https://h/{TileMatrix}/{TileRow}/{TileCol}", 2, 3, 1) === "https://h/2/1/3", "wmts rest: no ids = z");
	const w = normalizeSpec({ wms: { url: "https://ex.com/wms", layers: "a,b" } });
	ok(w.kind === "xyz" && /REQUEST=GetMap/.test(w.url) && /CRS=EPSG%3A3857/.test(w.url) && w.url.includes("BBOX={bbox-epsg-3857}") && w.url.includes("WIDTH={width}"), "wms spec → GetMap template (1.3.0 CRS)");
	ok(/SRS=EPSG%3A3857/.test(wmsTemplate({ url: "https://ex.com/wms", layers: "a", version: "1.1.1" })), "wms 1.1.1 → SRS");
	const k = normalizeSpec({ wmts: { url: "https://ex.com/wmts", layer: "L", tileMatrixSet: "GoogleMapsCompatible" } });
	ok(/REQUEST=GetTile/.test(k.url) && k.url.includes("TILEMATRIX={TileMatrix}"), "wmts kvp spec → GetTile template");
	const caps = `<Capabilities><ows:OperationsMetadata><ows:Operation name='GetTile'><ows:Get xlink:href='https://t.example/wmts?'/></ows:Operation></ows:OperationsMetadata><Contents>
<Layer><ows:Title>Relief</ows:Title><ows:Identifier>relief</ows:Identifier><Style isDefault='true'><ows:Identifier>default</ows:Identifier></Style><Format>image/png</Format>
<TileMatrixSetLink><TileMatrixSet>wm</TileMatrixSet></TileMatrixSetLink><TileMatrixSetLink><TileMatrixSet>jgd</TileMatrixSet></TileMatrixSetLink>
<ResourceURL format='image/png' resourceType='tile' template='https://t.example/relief/{Style}/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.png'/></Layer>
<TileMatrixSet><ows:Identifier>jgd</ows:Identifier><ows:SupportedCRS>urn:ogc:def:crs:EPSG::6668</ows:SupportedCRS><TileMatrix><ows:Identifier>0</ows:Identifier><ScaleDenominator>1000</ScaleDenominator></TileMatrix></TileMatrixSet>
<TileMatrixSet><ows:Identifier>wm</ows:Identifier><ows:SupportedCRS>urn:ogc:def:crs:EPSG::3857</ows:SupportedCRS>
<TileMatrix><ows:Identifier>L05</ows:Identifier><ScaleDenominator>8735660.375448715</ScaleDenominator></TileMatrix><TileMatrix><ows:Identifier>L06</ows:Identifier><ScaleDenominator>4367830.187724357</ScaleDenominator></TileMatrix></TileMatrixSet></Contents></Capabilities>`;
	const c = wmtsFromCapabilities(caps, { layer: "relief" });
	ok(c.url === "https://t.example/relief/default/wm/{TileMatrix}/{TileRow}/{TileCol}.png" && c.minZoom === 6 && c.maxZoom === 7 && c.matrixIds[6] === "L05" && c.matrixIds[7] === "L06" && c.name === "Relief", `capabilities → web-mercator set, ids by z (${JSON.stringify(c)})`);
}

// 1c. 色調整（#39・MapLibre の raster-* paint）＝色相→彩度→コントラスト→明るさの幅
{
	const px = () => new Uint8ClampedArray([200, 100, 50, 255]);
	const a = adjustRGBA(px(), { saturation: -1 });
	ok(a[0] === a[1] && a[1] === a[2] && a[3] === 255, "saturation -1 = gray, alpha kept");
	const b = adjustRGBA(px(), { brightnessMax: 0.5 });
	ok(b[0] === 100 && b[1] === 50, "brightness-max 0.5 halves");
	const c = adjustRGBA(px(), { contrast: -1 });
	ok(c[0] === 128 && c[2] === 128, "contrast -1 = mid gray");
	const d = adjustRGBA(px(), {});
	ok(d[0] === 200 && d[1] === 100 && d[2] === 50, "no adjust = identity");
	const e = adjustRGBA(px(), { hueRotate: 360 });
	ok(Math.abs(e[0] - 200) <= 1 && Math.abs(e[1] - 100) <= 1, "hue-rotate 360 = identity");
}

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

// 3b. 極の蓋
{
	for (const z of [0, 2, 7]) for (const south of [false, true]) {
		const n = subdivOf(z), m = buildPoleCapMesh(z, south, n), [, s0, , n0] = tileBounds(0, south ? (1 << z) - 1 : 0, z), span = 360 / (1 << z);
		const tag = `cap z${z} ${south ? "S" : "N"}`;
		ok(m.pos.length === (n + 1) * 4 && m.idx.length === n * 6, `${tag}: sizes`);
		const h = south ? s0 + 90 : 90 - n0, last = ((n + 1) * 2 - 1) * 2;
		ok(near(m.pos[0], 0) && near(m.pos[1], 0) && near(m.pos[last], span, 1e-4) && near(m.pos[last + 1], -h, 1e-4), `${tag}: spans the tile width and ${h.toFixed(3)}° to the edge`);
		let v = true; for (let k = 1; k < m.uv.length; k += 2) if (m.uv[k] !== (south ? 1 : 0)) v = false;
		ok(v, `${tag}: v pinned to the edge row`);
		let inRange = true; for (const i of m.idx) if (i >= (n + 1) * 2) inRange = false;
		ok(inRange, `${tag}: indices in range`);
	}
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
	const posted = [];
	const raster = createRaster({ renderer: R, requestDraw: () => { draws++; }, lowMem: false, post: m => { if (m.type === "rasterPending") posted.push(m); } });
	ok(raster.pending().total === 0, "pending: nothing before add");
	const addP = raster.add("t", { port: ch.port2 }, { order: "under", fadeDuration: 0 });   // fadeDuration 0＝到着フェード無し（rev の静止を見る。フェードは 8. で）
	ok(raster.pending().total === 1 && raster.pending().layers.t === 1, "pending: opening layer counts 1");
	const info = await addP;
	ok(raster.pending().total === 1 && posted.length >= 1 && posted[posted.length - 1].total === 1, `pending: fresh (opened, not yet selected) counts 1 and was posted (${posted.length} posts)`);
	ok(info.kind === "port" && info.maxZoom === 12 && info.attribution === "fake attr" && info.hideFills === true, "add → info from provider (under → hideFills)");
	ok(info.resampling === "linear" && info.fadeDuration === 0, `info carries resampling/fadeDuration (${info.resampling}/${info.fadeDuration})`);
	const cam = { center: [139.7, 35.7], zoom: 10.3, pitch: 0, bearing: 0, dpr: 1 };
	const tick = async () => { raster.update(cam, 800, 600); await new Promise(r => setTimeout(r, 30)); };
	raster.update(cam, 800, 600);
	ok(raster.pending().total > 1 && raster.pending().layers.t === raster.pending().total, `pending: after first select = queued tiles (${raster.pending().total})`);
	for (let i = 0; i < 40 && !(R.last && R.last.layers[0]?.draws.length); i++) await tick();
	await tick(); await tick();
	for (let i = 0; i < 40 && raster.pending().total; i++) await tick();
	ok(raster.pending().total === 0 && posted[posted.length - 1].total === 0, `pending: all arrived → 0 and posted 0 (last post total=${posted[posted.length - 1]?.total})`);
	{ const n = posted.length; raster.update(cam, 800, 600); ok(posted.length === n, "pending: unchanged → not re-posted"); }
	const st = raster.stats();
	ok(R.last && R.last.layers.length === 1 && R.last.layers[0].draws.length > 0, `draw list populated (${R.last?.layers[0]?.draws.length ?? 0} draws, ready=${st.layers[0]?.ready})`);
	ok(R.last.hideFills === true && R.last.layers[0].order === "under", "hideFills propagated for under layer");
	ok(R.last.rev > 0, `rev (${R.last.rev})`);
	ok(R.last.layers[0].draws.every(d => d.nw && d.bounds && d.mesh && d.tex && d.uvT), "draw entries carry nw/bounds/mesh/tex/uvT");
	{ const r0 = R.last.rev; raster.update(cam, 800, 600); ok(R.last.rev === r0, "static camera + no arrivals = rev unchanged (no re-composite)"); }
	// 選抜 z≈9（10.3−1）は奇数＝無い → 祖先 z8 の部分 uv で描かれている（uvT の su=0.5）
	const anc = R.last.layers[0].draws.filter(d => d.uvT[2] < 1);
	ok(anc.length > 0 && anc.every(d => near(d.uvT[2], 0.5)), `odd zoom missing → parent fallback with quarter uv (${anc.length} draws)`);
	ok(st.layers[0].empty > 0 && st.layers[0].ready > 0, `stats: empty=${st.layers[0].empty} ready=${st.layers[0].ready}`);
	ok(raster.bytes() > 0 && R.tex > 0 && R.mesh > 0, "bytes/textures/meshes accounted");
	// set：visible=false → 描画リストから消える（テクスチャは保持）
	// 6. 祖先の取得失敗（retry）＝選抜タイルは無い（null）・祖先 z−1 は 1 回だけ失敗して次は返る → 再要求されて未着 0・描画リストに祖先の部分 uv が載る
	{
		const ch3 = new MessageChannel(); let failed = 0, selZ = null, firstZ = null;
		ch3.port1.onmessage = ev => { const q = ev.data; if (q.abort) return; selZ ??= 9; firstZ ??= q.z;   // 選抜の z＝maxZoom（要求列の先頭は粗い祖先＝z6・2026-10-26）
			if (q.z === selZ) return ch3.port1.postMessage({ id: q.id, bitmap: null });
			if (q.z === selZ - 1 && !failed++) return ch3.port1.postMessage({ id: q.id, bitmap: null, error: "boom" });
			ch3.port1.postMessage({ id: q.id, bitmap: { width: 256, height: 256 } }); };
		ch3.port1.postMessage({ type: "info", info: { tileSize: 256, minZoom: 0, maxZoom: 9, bbox: null, name: "flaky" } });   // maxZoom 9＝z12 のカメラでも選抜は全部 z9（祖先 z8 は選抜に居ない＝純粋なフォールバック）
		const raster3 = createRaster({ renderer: R, requestDraw: () => {}, post: () => {} });
		await raster3.add("f", { port: ch3.port2 }, { order: "over" });
		const cam3 = { ...cam, zoom: 12.3 };
		const tick3 = async () => { raster3.update(cam3, 800, 600); await new Promise(r => setTimeout(r, 30)); };
		for (let i = 0; i < 60; i++) await tick3();   // 約 1.8 秒＝失敗→400ms 後の retry→再要求→到着 を跨ぐ（未着 0 で止めると retry の前に抜けてしまう）
		const st3 = raster3.stats().layers[0];
		ok(failed >= 1, `ancestor failed once (${failed} selZ=${selZ})`);
		ok(firstZ === selZ - 3, `coarse ancestor (z−3) is requested before the selected tiles (first z=${firstZ})`);
		ok(raster3.pending().total === 0, `pending: failed ancestor is re-queued and settles to 0 (${JSON.stringify(raster3.pending())} error=${st3.error})`);
		ok(R.last && R.last.layers[0].draws.length > 0 && R.last.layers[0].draws.some(d => d.uvT[2] < 1), `draws include the recovered ancestor's partial uv (${R.last?.layers[0]?.draws.length ?? 0})`);
		raster3.destroy();
	}
	// 7. 移動中の絞り（並列 2）で取り残された祖先＝次の巡で要求列に戻る（旧＝queued のまま放置＝未着が永遠に残る・inflight 0）
	{
		const ch4 = new MessageChannel(); let selZ = null;
		ch4.port1.onmessage = ev => { const q = ev.data; if (q.abort) return; selZ ??= q.z;
			setTimeout(() => ch4.port1.postMessage(q.z === selZ ? { id: q.id, bitmap: null } : { id: q.id, bitmap: { width: 256, height: 256 } }), 20); };   // 遅れて返る＝絞りが効く
		ch4.port1.postMessage({ type: "info", info: { tileSize: 256, minZoom: 0, maxZoom: 8, bbox: null, name: "throttled" } });   // 選抜＝z8 の多数（祖先 z7 が何枚も居る＝取り残しが出る条件）
		const raster4 = createRaster({ renderer: R, requestDraw: () => {}, post: () => {} });
		await raster4.add("m", { port: ch4.port2 }, { order: "over" });
		const cam4 = { ...cam, zoom: 9.3 };
		for (let i = 0; i < 60; i++) { raster4.update(cam4, 800, 600, { moving: true }); await new Promise(r => setTimeout(r, 30)); }   // ずっと移動中＝並列 2 のまま
		const st4 = raster4.stats().layers[0];
		ok(raster4.pending().total === 0, `pending: ancestors left behind by the moving throttle are re-queued and settle to 0 (${JSON.stringify(raster4.pending())} loading=${st4.loading} inflight=${raster4.stats().inflight} selected=${st4.selected} empty=${st4.empty} ready=${st4.ready})`);
		ok(R.last && R.last.layers[0].draws.length > 0, `draws present after throttled loading (${R.last?.layers[0]?.draws.length ?? 0})`);
		raster4.destroy();
	}
	raster.set("t", { visible: false }); raster.update(cam, 800, 600);
	ok(R.last === null, "visible:false → no draws");
	ok(raster.pending().total === 0, "pending: hidden layer counts 0");
	raster.set("t", { visible: true, opacity: 0.5, order: "over" }); raster.update(cam, 800, 600);
	ok(R.last && R.last.layers[0].order === "over" && near(R.last.layers[0].opacity, 0.5) && R.last.hideFills === false, "set order/opacity → over layer does not hide fills");
	ok(R.last.layers[0].resampling === "linear" && R.last.layers[0].draws.every(d => d.a === 1), "rd layer carries resampling (linear) and settled draws have a=1");
	{ const r0 = R.last.rev; raster.set("t", { resampling: "nearest" }); raster.update(cam, 800, 600); ok(R.last.layers[0].resampling === "nearest" && R.last.rev > r0 && raster.stats().layers[0].resampling === "nearest", "set resampling:nearest → rd + rev bump + stats"); }
	{ raster.set("t", { resampling: "bogus" }); ok(raster.stats().layers[0].resampling === "nearest", "set resampling: unknown value ignored"); }
	// 8. 到着フェード（raster-fade-duration・C4）：着いた直後の描画は a<1・fading が立つ（pending にも載る）・時間が経つと a=1・fading が落ちて rev が止まる
	{
		const ch8 = new MessageChannel();
		ch8.port1.onmessage = ev => { const q = ev.data; if (q.abort) return; ch8.port1.postMessage({ id: q.id, bitmap: { width: 256, height: 256 } }); };
		ch8.port1.postMessage({ type: "info", info: { tileSize: 256, minZoom: 0, maxZoom: 12, bbox: null, name: "fade" } });
		let posted8 = null;
		const raster8 = createRaster({ renderer: R, requestDraw: () => {}, post: m => { if (m.type === "rasterPending") posted8 = m; } });
		const info8 = await raster8.add("f", { port: ch8.port2 }, { order: "over", fadeDuration: 250 });
		ok(info8.fadeDuration === 250, `fadeDuration in info (${info8.fadeDuration})`);
		const cam8 = { ...cam, zoom: 10.3 };
		R.last = null;   // 偽 renderer は共有＝前の層の描画リストを消してから待つ
		for (let i = 0; i < 60 && !(R.last && R.last.layers[0]?.draws.length); i++) { raster8.update(cam8, 800, 600); await new Promise(r => setTimeout(r, 10)); }
		const d8 = R.last?.layers[0]?.draws || [];
		ok(d8.length > 0 && d8.some(d => d.a < 1), `just-arrived draws fade in (a<1: ${d8.filter(d => d.a < 1).length}/${d8.length})`);
		ok(raster8.stats().fading === true && raster8.pending().fading === true && posted8?.fading === true, "fading flag in stats/pending/post while fading");
		const r8 = R.last.rev;
		await new Promise(r => setTimeout(r, 40)); raster8.update(cam8, 800, 600);
		ok(R.last.rev > r8, "fade progress bumps rev (re-composite)");
		await new Promise(r => setTimeout(r, 300)); raster8.update(cam8, 800, 600);
		ok(R.last.layers[0].draws.every(d => d.a === 1 && !d.at && !d.until) && raster8.stats().fading === false && posted8?.fading === false, "after the duration: a=1, fading off, posted off");
		{ const r1 = R.last.rev; raster8.update(cam8, 800, 600); ok(R.last.rev === r1, "settled fade = rev unchanged"); }
		raster8.set("f", { fadeDuration: 0 }); ok(raster8.stats().layers[0].fadeDuration === 0, "set fadeDuration");
		raster8.destroy();
	}
	// 合成順：重ね（over）が先に追加されていても、後から足した基図（under）が先に並ぶ（基図が重ねを覆わない）
	{
		const ch2 = new MessageChannel();
		ch2.port1.onmessage = ev => { const q = ev.data; if (q.abort) return; ch2.port1.postMessage({ id: q.id, bitmap: { width: 256, height: 256 } }); };
		ch2.port1.postMessage({ type: "info", info: { tileSize: 256, minZoom: 0, maxZoom: 12, bbox: null, name: "base2" } });
		await raster.add("u2", { port: ch2.port2 }, { order: "under" });
		for (let i = 0; i < 30 && !(R.last && R.last.layers.length === 2 && R.last.layers.every(l => l.draws.length)); i++) await tick();
		ok(R.last && R.last.layers.length === 2 && R.last.layers[0].order === "under" && R.last.layers[1].order === "over", `under composited before over regardless of add order (${R.last?.layers.map(l => l.order).join(">")})`);
		raster.remove("u2"); ch2.port1.close();
	}
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
		if (R.last) maxDraws = Math.max(maxDraws, new Set(R.last.layers[0]?.draws.map(d => d.tex)).size);   // 描画中のテクスチャの数（到着フェード中は祖先も載る）
	}
	// 20 フレーム静止＝在庫は予算超過のまま・描画リストは不変＝退避が描画中の物を触らないことの検分
	for (let i = 0; i < 20; i++) { raster.update(cam, 800, 600); await new Promise(r => setTimeout(r, 25)); if (R.last) for (const L of R.last.layers) for (const d of L.draws) if (freed.has(d.tex)) bad++; }
	const st = raster.stats();
	ok(bad === 0, `evict never frees textures in the draw list (violations=${bad}, freed=${freed.size})`);
	ok(maxDraws > 0 && maxDraws * 349525 <= 2 * 1048576 * 0.7 + 2 * 349525, `coarsening keeps visible set near budget (+1 coarse ancestor · textures=${maxDraws})`);
	ok(st.texBytes <= 2 * 1048576 + 349525 * 2 || freed.size > 0, `budget enforced or eviction ran (texBytes=${(st.texBytes / 1048576).toFixed(1)}MB freed=${freed.size})`);
	raster.destroy(); ch.port1.close();
}

// 7. 地面アトラスの窓（ground.js）：真俯瞰＝3 段（近/中/遠）・強いチルト＝前景を足して 4 段（細かい順）・スナップ＝微動で鍵が変わらない
{
	const { groundWindows, windowsKey } = await import("../src/ground.ts");
	const cam0 = { center: [139.7, 35.7], zoom: 14.5, pitch: 0, bearing: 0, dpr: 1 };
	const w0 = groundWindows(cam0, 800, 600);
	ok(w0.length === 3, `flat: 3 windows (${w0.length})`);
	const span = w => w[2] - w[0];
	ok(span(w0[1]) > span(w0[0]) * 5.9 && span(w0[2]) > span(w0[1]) * 5.9, `flat: scales 1/6/36 (${w0.map(w => span(w).toFixed(4)).join(",")})`);
	ok(w0.every(w => w[0] < cam0.center[0] && w[2] > cam0.center[0] && w[1] < cam0.center[1] && w[3] > cam0.center[1]), "flat: all windows contain the center");
	const camT = { ...cam0, pitch: 1.15 };   // ≈66°
	const wT = groundWindows(camT, 800, 600);
	ok(wT.length === 4 && span(wT[0]) < span(wT[1]), `tilt: foreground window added and finer (${wT.length}, ${wT.length === 4 ? (span(wT[1]) / span(wT[0])).toFixed(2) : "-"}x)`);
	ok(wT.length === 4 && wT[0][1] < camT.center[1] && wT[0][3] < wT[1][3], "tilt: foreground window sits below the center (toward the camera)");
	// スナップ：中心を窓幅の 1/50 動かしても鍵は不変・1/2 動かせば変わる
	const k0 = windowsKey(groundWindows(cam0, 800, 600));
	const tiny = { ...cam0, center: [cam0.center[0] + span(w0[0]) / 50, cam0.center[1]] };
	const big = { ...cam0, center: [cam0.center[0] + span(w0[0]) / 2, cam0.center[1]] };
	ok(windowsKey(groundWindows(tiny, 800, 600)) === k0, "snap: tiny pan keeps the key");
	ok(windowsKey(groundWindows(big, 800, 600)) !== k0, "snap: half-window pan changes the key");
	ok(windowsKey(groundWindows({ ...cam0, zoom: 14.6 }, 800, 600)) === k0, "zoom quantized to 1/4 steps (14.5→14.6 same key)");
	// 宙の注視点（centerAlt）：窓は目から地面までの距離で取る（注視点の zoom のまま＝数 m 四方の窓＝地面が下地の色だった）
	const camA = { ...cam0, zoom: 24, centerAlt: 100000 }, wA = groundWindows(camA, 800, 600), wZ = groundWindows({ ...cam0, zoom: 24 }, 800, 600);
	ok(span(wA[0]) > span(wZ[0]) * 1000, `aloft: windows sized by the eye's distance to the ground (${span(wA[0]).toFixed(4)}° vs ${span(wZ[0]).toFixed(7)}°)`);
	const wAT = groundWindows({ ...camA, pitch: 0.9 }, 800, 600), mid = w => (w[1] + w[3]) / 2;
	ok(mid(wAT[wAT.length - 3]) > cam0.center[1] + 0.5, `aloft + tilt: the near window is centred on the ground the view ray meets (lat ${mid(wAT[wAT.length - 3]).toFixed(3)})`);
	// 地平線：低い目で強く傾けると遠窓（36 倍）の外の地面が写る＝そこまで届く窓（Cesium の 3d-tiles-batch-table-hierarchy の紺の帯）
	const camH = { ...cam0, zoom: 19, pitch: 1.35 }, wH = groundWindows(camH, 800, 600), sH = groundWindows({ ...cam0, zoom: 19 }, 800, 600);
	const kH = span(wH[wH.length - 1]) / span(sH[0]);
	ok(wH.length === 4 && kH > 36 * 1.4, `horizon: the last window reaches past the far one (${wH.length} windows, ×${kH.toFixed(0)})`);
	ok(sH.length === 3 && span(sH[2]) / span(sH[0]) < 36.5, `horizon: none when looking straight down (${sH.length} windows)`);
	ok(windowsKey(groundWindows({ ...camH, center: [camH.center[0] + 1e-7, camH.center[1]] }, 800, 600)) === windowsKey(wH), "horizon: a tiny pan keeps the key");
}

console.log(fails ? `✗ ${fails} failure(s)` : "✓ raster: all checks passed");
process.exit(fails ? 1 : 0);
