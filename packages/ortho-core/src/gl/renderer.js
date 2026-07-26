// WebGL2 レンダラ：可視タイルを跨いで同一 style層を1バッファに結合した「シーン」を描く。
// draw call は「タイル数×層数」から「層数」へ激減し、uniform も1フレーム1回。共通のシーン原点で投影。
// fill = earcut三角形、line = capsule(SDF)。scene.layers は style層順（painter's algorithm）。
import { FILL_VS, FILL_FS, LINE_VS, LINE_FS, GLOBE_VS, GLOBE_FS, BUILDING_VS, BUILDING_FS, TERRAIN_VS, TERRAIN_FS, STENCIL_VS, STENCIL_FS, COVER_FS, PLATEAU_VS, PLATEAU_FS, CONTOUR_FS, STARS_VS, STARS_FS, STARLINE_FS, NIGHT_FS, FILL_MD_VS, LINE_MD_VS, BUILDING_MD_VS, MD_MAX_DRAWS } from "./glsl.js";
import { cameraState, project, lonlatTo3D } from "../camera.js";
import * as mat from "../mat.js";

const CORNERS = new Float32Array([0, -1, 0, 1, 1, -1, 1, -1, 0, 1, 1, 1]); // 6頂点×(end,side)

export function createRenderer(canvas, rOpts = {}) {
	const gl = canvas.getContext("webgl2", { antialias: true, premultipliedAlpha: true, stencil: true });
	if (!gl) throw new Error("WebGL2 unavailable");

	const fillProg = program(gl, FILL_VS, FILL_FS);
	const lineProg = program(gl, LINE_VS, LINE_FS);
	const globeProg = program(gl, GLOBE_VS, GLOBE_FS);
	const bldProg = program(gl, BUILDING_VS, BUILDING_FS);
	const terrainProg = program(gl, TERRAIN_VS, TERRAIN_FS);
	const plateauProg = program(gl, PLATEAU_VS, PLATEAU_FS);   // PLATEAU LOD2 建物メッシュ
	const stencilProg = program(gl, STENCIL_VS, STENCIL_FS);   // 塗りの stencil パス（fan→巻き数）
	const coverProg = program(gl, GLOBE_VS, COVER_FS);          // 塗りの cover パス（stencil≠0 を塗る）
	const contourProg = program(gl, GLOBE_VS, CONTOUR_FS);     // 等高線（真俯瞰でだけ茶の等高線を敷く）
	const starsProg = program(gl, STARS_VS, STARS_FS);         // 星空（z<4・globeパスの下敷き）
	const starLineProg = program(gl, STARS_VS, STARLINE_FS);   // 星座線（VS共用・gl.LINES）
	const nightProg = program(gl, GLOBE_VS, NIGHT_FS);         // 夜面（現在時刻の太陽＝平行光源・全レイヤの上）
	const cornerBuf = buffer(gl, CORNERS);
	const emptyVAO = gl.createVertexArray();
	gl.getExtension("OES_texture_float_linear");   // R32F の線形補間
	// 標高（GEBCO/ALOS）：テクスチャ＋地形格子メッシュ
	let elevTex = null, elev = { bounds: [0, 0, 1, 0], scale: 0, has: 0 }, terrain = null;
	// PLATEAU LOD2 建物メッシュ：バッチキー "区名#i" →{ vao, bufs, count, origin, bbox }（頂点は重心相対 delta）。
	// worker が区をバッチ分割して逐次送ってくる＝完成した近傍から順に立つ。bbox は draw 時のフラスタムカリングに使う。
	// 基図建物を伏せる被覆マスクは区単位で別管理（plateauMasks）＝バッチ数でシェーダの固定スロットを枯渇させない。
	const plateaux = new Map();
	const plateauMasks = new Map();   // 区名 → { tex, bbox }（worker が累積スナップショットを送る度に丸ごと差し替え）
	const plateauHidden = new Set();  // 非表示の区名（VAO/マスクはVRAM保持＝draw skipとスロット除外だけ。再訪は plateauVis 切替のみで再アップロード不要）
	const MAX_PLATEAU_MASKS = 4;
	// 静的 view（色・見た目）：初期化時に一度 setView でアップロード。draw は毎フレーム幾何(cam)だけ受け、
	// 色は view から読む＝描画パラメータを「幾何(動的)」と「見た目(静的)」に分離。将来の worker payload 境界。
	let view = { clear: null, land: null, atmo: null, bldColor: null };
	function setView(v) { view = { ...view, ...v }; }
	// 海：水レイヤ(li)を cam.zoom で一律にゲート＝ビュー単位で描く/描かない（タイル毎の presence まだらを排す）。
	// cam.zoom < minzoom では水を描かない＝海は球の基色(紙)のまま。以上で一律の色を点火。
	let sea = { li: -1, minzoom: Infinity };
	const WATER_LIFT_M = 30;   // 水面リフト(m)：DSM水面ノイズ瘤(±10m級)を沈める深度テスト用の嵩上げ（誇張前の実標高）
	// 星空（z<4）：stars＝点（[cel.xyz, rgb, alpha, size]×8f interleaved）、constel＝星座線（[cel.xyz]×3f、LINES端点列）、
	// planets＝惑星（starsと同レイアウト・アプリが実位置を計算し10分毎に差し替え）。
	// 表示のON/OFFは view.showConst（星座線のみトグル・星と惑星は常設）。
	let stars = null, constel = null, planets = null, ecliptic = null, celeq = null;
	function setStarBuf(cur, data, stride, setup) {
		if (cur) { gl.deleteBuffer(cur.buf); gl.deleteVertexArray(cur.vao); }
		if (!data || !data.length) return null;
		const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
		const buf = buffer(gl, data);
		setup();
		gl.bindVertexArray(null);
		return { vao, buf, count: data.length / stride };
	}
	function setStars(data) {
		stars = setStarBuf(stars, data, 8, () => {
			gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 32, 0);
			gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 12);
			gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 32, 28);
		});
	}
	function setConstellations(data) {
		constel = setStarBuf(constel, data, 3, () => {
			gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
		});
	}
	function setPlanets(data) {
		planets = setStarBuf(planets, data, 8, () => {
			gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 32, 0);
			gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 12);
			gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 32, 28);
		});
	}
	const lineSetup = () => { gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0); };
	function setEcliptic(data) { ecliptic = setStarBuf(ecliptic, data, 3, lineSetup); }
	function setCelEquator(data) { celeq = setStarBuf(celeq, data, 3, lineSetup); }
	let fogDist = 0;   // フォグ距離の基準 camDist。ズーム中は凍結（チラチラ防止）、静止で追随
	let elevScaleEff = 0;   // pitchで変調した実効スケール（真俯瞰では0＝平面）
	let gintCtx = null;   // gint 埋込パス用の frame コンテキスト（terrainDepth 時のみ非null。draw() が毎フレーム更新）
	// base=粗い下書き（underlay）、main=現ズーム、overlay=外部ベクタ(geopbf等)を最前面に。
	// md（multi_draw モード）のシーンは draws でなく md={layers,bld}＝常駐プールへの参照リストだけを持つ。
	const scenes = {
		base: { origin: [0, 0], draws: [], bld: null, md: null },
		main: { origin: [0, 0], draws: [], bld: null, md: null },
		overlay: { origin: [0, 0], draws: [], bld: null, md: null },
	};

	// --- multi_draw タイル常駐プール ---
	// タイル geometry を GPU に常駐させ、シーンは「プール内レンジの列」＝merge の CPU memcpy と
	// setScene の全バッファ再生成を廃す。配置（アロケータ）の権限は scene worker：ここは
	// mdGrow（プール成長＝GPU内コピー）/ mdUp（タイルブロックの bufferSubData/texSubImage2D）/
	// mdScene（draw list 差し替え）を言われた通り実行するだけ。
	const MD_TEXW = 2048;   // 線分テクスチャの幅（texel）。2texel/線分＝1024線分/行
	const mdExt = rOpts.noMD ? null : gl.getExtension("WEBGL_multi_draw");
	const md = mdExt ? {
		ext: mdExt,
		fillProg: program(gl, FILL_MD_VS, FILL_FS),
		lineProg: program(gl, LINE_MD_VS, LINE_FS),
		bldProg: program(gl, BUILDING_MD_VS, BUILDING_FS),
		fillV: { buf: null, bytes: 0 },   // 頂点 12B: pos f32×2 + col u8×4（interleave）
		fillI: { buf: null, bytes: 0 },   // index u32（値はプール絶対頂点番号＝upload 時に再ベース済み）
		bldV: { buf: null, bytes: 0 },    // 建物頂点 24B: pos f32×3 + shade f32 + anchor f32×2
		lineTex: null, lineTexH: 0,       // RGBA32UI・2texel/線分
		fillVAO: null, bldVAO: null,
	} : null;
	function mdRebuildFillVAO() {
		if (md.fillVAO) gl.deleteVertexArray(md.fillVAO);
		md.fillVAO = gl.createVertexArray(); gl.bindVertexArray(md.fillVAO);
		gl.bindBuffer(gl.ARRAY_BUFFER, md.fillV.buf);
		let l = gl.getAttribLocation(md.fillProg, "a_delta");
		gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, 2, gl.FLOAT, false, 12, 0);
		l = gl.getAttribLocation(md.fillProg, "a_color");
		gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, 4, gl.UNSIGNED_BYTE, true, 12, 8);
		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, md.fillI.buf);   // ELEMENT_ARRAY は VAO 状態
		gl.bindVertexArray(null);
	}
	function mdRebuildBldVAO() {
		if (md.bldVAO) gl.deleteVertexArray(md.bldVAO);
		md.bldVAO = gl.createVertexArray(); gl.bindVertexArray(md.bldVAO);
		gl.bindBuffer(gl.ARRAY_BUFFER, md.bldV.buf);
		let l = gl.getAttribLocation(md.bldProg, "a_pos");
		gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, 3, gl.FLOAT, false, 24, 0);
		l = gl.getAttribLocation(md.bldProg, "a_shade");
		gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, 1, gl.FLOAT, false, 24, 12);
		l = gl.getAttribLocation(md.bldProg, "a_anchor");
		gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, 2, gl.FLOAT, false, 24, 16);
		gl.bindVertexArray(null);
	}
	// プール成長＝新バッファへ GPU 内コピー（CPU の再アップロード不要）。VAO は旧バッファを掴んでいるので作り直す。
	// WebGL はバッファを「element / 非element」で型ロックする（最初に COPY_WRITE に bind しただけでも非element に
	// 固定され、以後 ELEMENT_ARRAY_BUFFER に bind できない＝multiDrawElements が黙って空振り）。
	// index プールは elem=true：生成・確保を ELEMENT_ARRAY_BUFFER で行い element 型に確定させる
	// （ELEMENT bind は VAO 状態なので default VAO(null) に退避してから）。型確定後の COPY_READ/COPY_WRITE は合法。
	function mdGrowBuf(pool, bytes, elem) {
		if (bytes <= pool.bytes) return;
		const target = elem ? gl.ELEMENT_ARRAY_BUFFER : gl.COPY_WRITE_BUFFER;
		if (elem) gl.bindVertexArray(null);
		const nb = gl.createBuffer();
		gl.bindBuffer(target, nb);
		gl.bufferData(target, bytes, gl.DYNAMIC_DRAW);
		if (pool.buf) {
			gl.bindBuffer(gl.COPY_READ_BUFFER, pool.buf);
			gl.copyBufferSubData(gl.COPY_READ_BUFFER, target, 0, 0, pool.bytes);
			gl.deleteBuffer(pool.buf);
		}
		gl.bindBuffer(target, null);
		pool.buf = nb; pool.bytes = bytes;
	}
	function mdGrow(pool, units) {
		if (pool === "fillV") { mdGrowBuf(md.fillV, units * 12); mdRebuildFillVAO(); }
		else if (pool === "fillI") { mdGrowBuf(md.fillI, units * 4, true); mdRebuildFillVAO(); }
		else if (pool === "bldV") { mdGrowBuf(md.bldV, units * 24); mdRebuildBldVAO(); }
		else if (pool === "line") {   // 線分テクスチャ：高さを伸ばして旧内容を FBO 経由で GPU 内コピー
			const H = Math.ceil(units * 2 / MD_TEXW);
			if (H <= md.lineTexH) return;
			const nt = gl.createTexture();
			gl.bindTexture(gl.TEXTURE_2D, nt);
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32UI, MD_TEXW, H, 0, gl.RGBA_INTEGER, gl.UNSIGNED_INT, null);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
			if (md.lineTex) {
				const fbo = gl.createFramebuffer();
				gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo);
				gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, md.lineTex, 0);
				gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, MD_TEXW, md.lineTexH);   // RGBA32UI→RGBA32UI＝成分型一致でコピー可
				gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
				gl.deleteFramebuffer(fbo);
				gl.deleteTexture(md.lineTex);
			}
			md.lineTex = nt; md.lineTexH = H;
		}
	}
	// タイル1枚分のブロック転送。頂点系は COPY_WRITE 経由（VAO 状態を汚さない）。
	// index プールは element 型ロック済み＝ELEMENT_ARRAY_BUFFER で書く（default VAO(null) に退避してから）。
	function mdUpload(p) {
		if (p.fill) { gl.bindBuffer(gl.COPY_WRITE_BUFFER, md.fillV.buf); gl.bufferSubData(gl.COPY_WRITE_BUFFER, p.fill.base * 12, new Uint8Array(p.fill.buf)); }
		if (p.bld) { gl.bindBuffer(gl.COPY_WRITE_BUFFER, md.bldV.buf); gl.bufferSubData(gl.COPY_WRITE_BUFFER, p.bld.base * 24, p.bld.arr); }
		gl.bindBuffer(gl.COPY_WRITE_BUFFER, null);
		if (p.idx) {
			gl.bindVertexArray(null);
			gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, md.fillI.buf);
			gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, p.idx.base * 4, p.idx.arr);
			gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
		}
		if (p.line) {   // 線分ブロックはテクスチャ内で行を跨ぎ得る＝先頭の欠け行・中間の全行・末尾の欠け行の最大3回に分けて書く
			gl.bindTexture(gl.TEXTURE_2D, md.lineTex);
			gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
			let t = p.line.base * 2, arr = p.line.arr, off = 0;   // t=先頭texel、off=arr内の消化texel数
			let left = arr.length / 4;
			const put = (x, y, w, rows) => {
				gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, rows, gl.RGBA_INTEGER, gl.UNSIGNED_INT, arr.subarray(off * 4, (off + w * rows) * 4));
				off += w * rows; t += w * rows; left -= w * rows;
			};
			const headX = t % MD_TEXW;
			if (headX) put(headX, (t / MD_TEXW) | 0, Math.min(MD_TEXW - headX, left), 1);
			const rows = (left / MD_TEXW) | 0;
			if (rows) put(0, (t / MD_TEXW) | 0, MD_TEXW, rows);
			if (left) put(0, (t / MD_TEXW) | 0, left, 1);
		}
	}
	// draw list 差し替え：GPU 転送ゼロ（参照リストの入れ替えだけ）。layers は li 昇順＝painter順。
	function mdScene(m) {
		disposeSlot(m.slot);
		scenes[m.slot] = { origin: m.origin, draws: [], bld: null, md: { layers: m.layers, bld: m.bld } };
	}
	const sceneHasDraws = s => s.draws.length > 0 || !!(s.md && s.md.layers.length);

	// s: { origin:[lon,lat], layers:[{kind:'fill'|'line', ...typed arrays}] }（style層順）。slot: 'base'|'main'
	function setScene(s, slot = "main") {
		disposeSlot(slot);
		const draws = [];
		for (const L of s.layers) {
			if (!L) continue;
			if (L.kind === "fill") {
				if (!L.pos.length) continue;
				const vao = gl.createVertexArray();
				const bPos = buffer(gl, L.pos), bCol = buffer(gl, L.col);
				gl.bindVertexArray(vao);
				attrib(gl, fillProg, "a_delta", bPos, 2);
				attrib(gl, fillProg, "a_color", bCol, 4, null, L.col instanceof Uint8Array);   // タイル由来=Uint8正規化／geojson由来=float32 の両対応
				const bufs = [bPos, bCol];
				let idxN = 0, idxT = 0;
				if (L.idx && L.idx.length) {   // タイル由来＝index描画（ELEMENT_ARRAY_BUFFER は VAO 状態）。geojson由来＝三角形スープのまま
					const ibo = gl.createBuffer();
					gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
					gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, L.idx, gl.STATIC_DRAW);
					bufs.push(ibo); idxN = L.idx.length;
					idxT = L.idx instanceof Uint16Array ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT;   // merge後は常にUint32だが型は実物から
				}
				gl.bindVertexArray(null);
				draws.push({ kind: "fill", li: L.li, vao, count: idxN || L.pos.length / 2, idxT, bufs });
			} else {
				if (!L.half.length) continue;
				const vao = gl.createVertexArray();
				const bP1 = buffer(gl, L.P1), bP2 = buffer(gl, L.P2), bCol = buffer(gl, L.col), bHalf = buffer(gl, L.half);
				gl.bindVertexArray(vao);
				attrib(gl, lineProg, "a_corner", cornerBuf, 2, 0);
				attrib(gl, lineProg, "a_p1", bP1, 2, 1);
				attrib(gl, lineProg, "a_p2", bP2, 2, 1);
				attrib(gl, lineProg, "a_color", bCol, 4, 1, L.col instanceof Uint8Array);
				attrib(gl, lineProg, "a_half", bHalf, 1, 1);
				gl.bindVertexArray(null);
				draws.push({ kind: "line", vao, count: L.half.length, bufs: [bP1, bP2, bCol, bHalf] });
			}
		}
		let bld = null;
		if (s.buildings && s.buildings.pos.length) {
			const vao = gl.createVertexArray();
			const bPos = buffer(gl, s.buildings.pos), bSh = buffer(gl, s.buildings.shade), bAnc = buffer(gl, s.buildings.anchor);
			gl.bindVertexArray(vao);
			attrib(gl, bldProg, "a_pos", bPos, 3);
			attrib(gl, bldProg, "a_shade", bSh, 1);
			attrib(gl, bldProg, "a_anchor", bAnc, 2);
			gl.bindVertexArray(null);
			bld = { vao, count: s.buildings.pos.length / 3, bufs: [bPos, bSh, bAnc] };
		}
		scenes[slot] = { origin: s.origin, draws, bld };
	}

	// 標高アトラス：セル群を1枚のテクスチャに敷く。a:{originLng,originLat,cellsX,cellsY,cellRes,cellSpan}
	// cellSpan=1セルの度数（R90=90/R10=10/R01=1）。
	function setElevationAtlas(a, scale) {
		const W = a.cellsX * a.cellRes, H = a.cellsY * a.cellRes, span = a.cellSpan || 10;
		if (!elevTex) elevTex = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, elevTex);
		gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, W, H, 0, gl.RED, gl.FLOAT, new Float32Array(W * H));  // 0(海)で初期化
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		elev = { bounds: [a.originLng, a.originLat, a.cellsX * span, a.cellsY * span], scale, exag: a.exag || 1, has: 1, edgeFade: a.edgeFade || 0 };
		const G = Math.min(1536, Math.max(768, 768 * Math.max(a.cellsX, a.cellsY)));
		buildTerrainMesh(a.originLng, a.originLat, a.cellsX * span, a.cellsY * span, G);
	}
	// セル(cx,cy)の N×N Float32(南上げ)をアトラスへ。
	function setElevationCell(cx, cy, data, cellRes) {
		if (!elevTex) return;
		gl.bindTexture(gl.TEXTURE_2D, elevTex);
		gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
		gl.texSubImage2D(gl.TEXTURE_2D, 0, cx * cellRes, cy * cellRes, cellRes, cellRes, gl.RED, gl.FLOAT, data);
	}
	// 標高アトラスのダブルバッファ：2枚目以降の再構築は舞台裏（stage）で行い、セルが揃ったら一括スワップ。
	// 直接 elevAtlas を張り替えるとゼロ初期化の瞬間に山影が全画面でパッと消える（ズーム静止のたびに発症）。
	let elevStage = null;   // { tex, a, scale }
	function setElevationAtlasStage(a, scale) {
		if (elevStage) gl.deleteTexture(elevStage.tex);
		const W = a.cellsX * a.cellRes, H = a.cellsY * a.cellRes;
		const tex = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, tex);
		gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, W, H, 0, gl.RED, gl.FLOAT, new Float32Array(W * H));
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		elevStage = { tex, a, scale };
	}
	function setElevationCellStage(cx, cy, data, cellRes) {
		if (!elevStage) return;
		gl.bindTexture(gl.TEXTURE_2D, elevStage.tex);
		gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
		gl.texSubImage2D(gl.TEXTURE_2D, 0, cx * cellRes, cy * cellRes, cellRes, cellRes, gl.RED, gl.FLOAT, data);
	}
	function commitElevationStage() {
		if (!elevStage) return;
		if (elevTex) gl.deleteTexture(elevTex);
		elevTex = elevStage.tex;
		const a = elevStage.a, span = a.cellSpan || 10;
		elev = { bounds: [a.originLng, a.originLat, a.cellsX * span, a.cellsY * span], scale: elevStage.scale, exag: a.exag || 1, has: 1, edgeFade: a.edgeFade || 0 };
		const G = Math.min(1536, Math.max(768, 768 * Math.max(a.cellsX, a.cellsY)));
		buildTerrainMesh(a.originLng, a.originLat, a.cellsX * span, a.cellsY * span, G);
		elevStage = null;
	}
	function buildTerrainMesh(oLng, oLat, spanLng, spanLat, G) {
		const ll = new Float32Array(G * G * 2);
		for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) { const k = (j * G + i) * 2; ll[k] = oLng + spanLng * i / (G - 1); ll[k + 1] = oLat + spanLat * j / (G - 1); }
		const idx = new Uint32Array((G - 1) * (G - 1) * 6);
		let p = 0; for (let j = 0; j < G - 1; j++) for (let i = 0; i < G - 1; i++) { const a = j * G + i, b = a + 1, c = a + G, d = c + 1; idx[p++] = a; idx[p++] = c; idx[p++] = b; idx[p++] = b; idx[p++] = c; idx[p++] = d; }
		if (terrain) { gl.deleteVertexArray(terrain.vao); gl.deleteBuffer(terrain.vbo); gl.deleteBuffer(terrain.ibo); }
		const vao = gl.createVertexArray(), vbo = buffer(gl, ll), ibo = gl.createBuffer();
		gl.bindVertexArray(vao);
		attrib(gl, terrainProg, "a_ll", vbo, 2);
		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
		gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
		gl.bindVertexArray(null);
		terrain = { vao, vbo, ibo, count: idx.length };
	}

	// PLATEAU LOD2 建物メッシュを受ける。key=バッチキー "区名#i"（data あり）または区名（data=null＝区の全バッチ+マスク解放）。
	// data={ pos:Float32Array(xyz…), idx:Uint32Array, ward, mask, maskN, maskBbox }（頂点は ortho 単位球座標へ変換済み）。
	function setPlateauMesh(key, data) {
		if (!data) {   // key=区名：その区の全バッチとマスクを解放
			for (const k of [...plateaux.keys()]) {
				if (k !== key && !k.startsWith(key + "#")) continue;
				const p = plateaux.get(k);
				gl.deleteVertexArray(p.vao); for (const b of p.bufs) gl.deleteBuffer(b);
				plateaux.delete(k);
			}
			const m = plateauMasks.get(key);
			if (m) { gl.deleteTexture(m.tex); plateauMasks.delete(key); }
			plateauHidden.delete(key);
			return;
		}
		const old = plateaux.get(key);
		if (old) { gl.deleteVertexArray(old.vao); for (const b of old.bufs) gl.deleteBuffer(b); plateaux.delete(key); }
		if (!data.pos?.length || !data.idx?.length) return;
		const vao = gl.createVertexArray(), vbo = buffer(gl, data.pos), nbo = buffer(gl, data.nrm), ibo = gl.createBuffer();
		gl.bindVertexArray(vao);
		attrib(gl, plateauProg, "a_pos", vbo, 3);
		if (data.nrm instanceof Int8Array) {   // v4: int8量子化法線（xyz+pad 4B/頂点）。FS が normalize するので精度 1/127 で十分
			const l = gl.getAttribLocation(plateauProg, "a_normal");
			gl.bindBuffer(gl.ARRAY_BUFFER, nbo);
			gl.enableVertexAttribArray(l);
			gl.vertexAttribPointer(l, 3, gl.BYTE, true, 4, 0);
		} else attrib(gl, plateauProg, "a_normal", nbo, 3);   // 旧 float32（同セッション内の残骸互換）
		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
		gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data.idx, gl.STATIC_DRAW);
		gl.bindVertexArray(null);
		const o = data.origin || [0, 0, 0];
		// lodH/lodCounts（v4）：index は建物高さ降順＝lodCounts[k] で「高さ lodH[k] 以上だけ」を先頭打ち切り描画できる
		plateaux.set(key, { vao, bufs: [vbo, nbo, ibo], count: data.idx.length, origin: o, bbox: data.bbox || [1e9, 1e9, -1e9, -1e9], ward: data.ward || String(key).split("#")[0], lodH: data.lodH || null, lodCounts: data.lodCounts || null, two: data.twoSided ? 1 : 0 });
		// 被覆マスク（NEAREST・CLAMP）。基図建物 FS が uv=区bbox正規化で参照。区単位＝バッチごとに累積スナップショットで丸ごと差し替え。
		if (data.ward && data.mask && (data.maskN | 0) > 0 && data.maskBbox) {
			let m = plateauMasks.get(data.ward);
			if (!m) { m = { tex: gl.createTexture(), bbox: data.maskBbox }; plateauMasks.set(data.ward, m); }
			m.bbox = data.maskBbox;
			gl.bindTexture(gl.TEXTURE_2D, m.tex);
			gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, data.maskN, data.maskN, 0, gl.RED, gl.UNSIGNED_BYTE, data.mask);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		}
	}

	// PLATEAU 区単位の表示切替（GPU常駐のまま）。off＝draw skip＋被覆マスクのスロット除外（基図建物が復活する）。
	// バッファ削除ではないので on へ戻すのは無料＝視野外れの「解放」をこれに置き換えると再訪の再アップロードが消える。
	function setPlateauVis(ward, on) {
		if (on) plateauHidden.delete(ward); else plateauHidden.add(ward);
	}

	// バッチ bbox（経緯度deg）の可視判定：4隅+中心を投影し、拡張スクリーン矩形と交差するか。
	// pad は高層ビルの頭が地表bbox角の投影から食み出す分の余白（半画面）。カメラがbbox内に居れば無条件で可視。
	function plateauBboxVisible(st, bbox, center, pad) {
		if (center[0] >= bbox[0] && center[0] <= bbox[2] && center[1] >= bbox[1] && center[1] <= bbox[3]) return true;
		const pts = [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[0], bbox[3]], [bbox[2], bbox[3]], [(bbox[0] + bbox[2]) * 0.5, (bbox[1] + bbox[3]) * 0.5]];
		let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9, nf = 0;
		for (const q of pts) {
			const [sx, sy, f] = project(st, q[0], q[1]);
			if (f < 0) continue;
			nf++;
			if (sx < minx) minx = sx; if (sx > maxx) maxx = sx;
			if (sy < miny) miny = sy; if (sy > maxy) maxy = sy;
		}
		if (!nf) return false;   // 全点が裏半球/カメラ背後
		return !(maxx < -pad || minx > st.W + pad || maxy < -pad || miny > st.H + pad);
	}

	// --- overlay（外部ベクタ=geopbf/e-Stat）：stencil-then-cover 塗り＋境界線 ---
	let overlay = null, overlayHi = null, n02 = [];   // n02＝交通の常駐オーバーレイ群（新幹線/駅…各色）。showN02 で表示切替
	function buildOverlaySlot(s, fillColor) {
		if (!s || (!s.fanPos.length && !(s.lineHalf && s.lineHalf.length))) return null;   // 面も線も無い時だけ捨てる（純線＝N02新幹線は面ゼロで通す）
		const fanVao = gl.createVertexArray(), bFan = buffer(gl, s.fanPos);
		gl.bindVertexArray(fanVao); attrib(gl, stencilProg, "a_delta", bFan, 2); gl.bindVertexArray(null);
		const bufs = [bFan];
		let lineVao = null, lineCount = 0;
		if (s.lineHalf && s.lineHalf.length) {
			lineVao = gl.createVertexArray();
			const bP1 = buffer(gl, s.P1), bP2 = buffer(gl, s.P2), bCol = buffer(gl, s.lineCol), bHalf = buffer(gl, s.lineHalf);
			gl.bindVertexArray(lineVao);
			attrib(gl, lineProg, "a_corner", cornerBuf, 2, 0);
			attrib(gl, lineProg, "a_p1", bP1, 2, 1);
			attrib(gl, lineProg, "a_p2", bP2, 2, 1);
			attrib(gl, lineProg, "a_color", bCol, 4, 1, s.lineCol instanceof Uint8Array);
			attrib(gl, lineProg, "a_half", bHalf, 1, 1);
			gl.bindVertexArray(null);
			lineCount = s.lineHalf.length; bufs.push(bP1, bP2, bCol, bHalf);
		}
		return { fanVao, fanCount: s.fanPos.length / 2, lineVao, lineCount, origin: s.origin, fillColor, bufs, minZoom: s.minZoom || 0 };   // minZoom＝シーン単位のズームゲート（N02通常駅は駅名の出るズームから）
	}
	function disposeOverlay(o) { if (o) { for (const b of o.bufs) gl.deleteBuffer(b); gl.deleteVertexArray(o.fanVao); if (o.lineVao) gl.deleteVertexArray(o.lineVao); } }
	function setOverlay(s, fillColor) { disposeOverlay(overlay); overlay = s ? buildOverlaySlot(s, fillColor || [0.20, 0.45, 0.85, 0.32]) : null; }
	// N02 交通の常駐オーバーレイ群を丸ごと差し替え。各要素は buildGeoJSONOverlay のシーン（線色は焼込済）。
	function setN02(scenes) { for (const o of n02) disposeOverlay(o); n02 = (scenes || []).map(s => buildOverlaySlot(s, [0, 0, 0, 0])); }
	function setOverlayHi(s, fillColor) { disposeOverlay(overlayHi); overlayHi = s ? buildOverlaySlot(s, fillColor || [0.95, 0.55, 0.15, 0.6]) : null; }
	function drawOne(o, st, dpr, land) {
		if (!o) return;
		if (o.fanCount) {   // 面がある時だけ stencil 塗り（純線オーバーレイ＝N02 は面ゼロでも線を描く）
			// stencil パス：fan を巻き数へ（色は書かない・FRONT+1/BACK-1、球の前後半球も相殺）
			gl.enable(gl.STENCIL_TEST);
			gl.clearStencil(0); gl.clear(gl.STENCIL_BUFFER_BIT);
			gl.colorMask(false, false, false, false);
			gl.stencilMask(0xFF); gl.stencilFunc(gl.ALWAYS, 0, 0xFF);
			gl.stencilOpSeparate(gl.FRONT, gl.KEEP, gl.KEEP, gl.INCR_WRAP);
			gl.stencilOpSeparate(gl.BACK, gl.KEEP, gl.KEEP, gl.DECR_WRAP);
			setCommonUniforms(stencilProg, st, o.origin, land);
			gl.bindVertexArray(o.fanVao); gl.drawArrays(gl.TRIANGLES, 0, o.fanCount);
			// cover パス：stencil≠0 の画素だけ塗り、通過画素は0へ戻して次に備える
			gl.colorMask(true, true, true, true);
			gl.stencilFunc(gl.NOTEQUAL, 0, 0xFF); gl.stencilOp(gl.KEEP, gl.KEEP, gl.ZERO);
			gl.useProgram(coverProg);
			gl.uniform4f(loc(gl, coverProg, "u_fill"), o.fillColor[0], o.fillColor[1], o.fillColor[2], o.fillColor[3]);
			gl.bindVertexArray(emptyVAO); gl.drawArrays(gl.TRIANGLES, 0, 3);
			gl.disable(gl.STENCIL_TEST);
		}
		// 線（境界線 or N02 の鉄道線）
		if (o.lineVao) {
			setCommonUniforms(lineProg, st, o.origin, land);
			gl.uniform1f(loc(gl, lineProg, "u_dpr"), dpr);
			gl.bindVertexArray(o.lineVao); gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, o.lineCount);
		}
	}
	function drawOverlay(st, dpr, land, zoom) {
		if (view.showN02 !== false) for (const o of n02) { if (zoom >= o.minZoom) drawOne(o, st, dpr, land); }   // N02 交通（新幹線/駅）＝基図の上・identify overlay の下
		drawOne(overlay, st, dpr, land); drawOne(overlayHi, st, dpr, land);
	}

	function setCommonUniforms(prog, st, origin, fog) {
		gl.useProgram(prog);
		gl.uniformMatrix4fv(loc(gl, prog, "u_mvp"), false, st.mvp32);
		gl.uniform3f(loc(gl, prog, "u_eye"), st.eye[0], st.eye[1], st.eye[2]);
		gl.uniform2f(loc(gl, prog, "u_origin"), origin[0], origin[1]);
		// RTE の錨（MVP相殺回避）＝原点3D の clip 位置と三角比を CPU(double) で（Float32化前の st.mvp で）。
		const oPt = lonlatTo3D(origin[0], origin[1]);
		const cT = mat.transform(st.mvp, [oPt[0], oPt[1], oPt[2], 1]);
		gl.uniform4f(loc(gl, prog, "u_clipT"), cT[0], cT[1], cT[2], cT[3]);
		gl.uniform3f(loc(gl, prog, "u_originPt"), oPt[0], oPt[1], oPt[2]);
		const lr = origin[0] * Math.PI / 180, br = origin[1] * Math.PI / 180;
		gl.uniform4f(loc(gl, prog, "u_originTrig"), Math.cos(lr), Math.sin(lr), Math.cos(br), Math.sin(br));
		gl.uniform2f(loc(gl, prog, "u_viewport"), canvas.width, canvas.height);
		gl.uniform1f(loc(gl, prog, "u_fogNear"), (st.fogDist || st.camDist) * 2.5);
		gl.uniform1f(loc(gl, prog, "u_fogFar"), (st.fogDist || st.camDist) * 14.0);
		gl.uniform3f(loc(gl, prog, "u_fogColor"), fog[0], fog[1], fog[2]);
		// 対数深度係数（cameraState と同じ far＝地平線 limb×1.15+camDist）。球+局所(建物)の z-fight 対策。
		const _limb = Math.sqrt(Math.max((1 + st.camDist) * (1 + st.camDist) - 1, 1e-12));
		gl.uniform1f(loc(gl, prog, "u_logCoef"), 2.0 / Math.log2(_limb * 1.15 + st.camDist + 1.0));
		gl.uniform1i(loc(gl, prog, "u_elevTex"), 1);
		gl.uniform4f(loc(gl, prog, "u_elevBounds"), elev.bounds[0], elev.bounds[1], elev.bounds[2], elev.bounds[3]);
		gl.uniform1f(loc(gl, prog, "u_elevScale"), elevScaleEff);
		gl.uniform1f(loc(gl, prog, "u_hasElev"), elev.has);
		gl.uniform1f(loc(gl, prog, "u_elevEdgeFade"), elev.edgeFade || 0);   // 窓の縁のフェード幅(deg)。R90全球窓=0
	}

	function draw(cam, opts) {
		gl.viewport(0, 0, canvas.width, canvas.height);
		const st = cameraState(cam, canvas.width, canvas.height);
		st.mvp32 = Float32Array.from(st.mvp);
		// フォグ距離（遠山ブルーの帯・遠景平坦化dfの境界）は camDist へ滑らかに追従（臨界減衰）：
		// 直結だとホイール1ノッチ毎に霞の帯が跳んでチラチラし、凍結だとズームアウトで旧距離の霞が
		// 画面を覆ってから静止時にパッと晴れる（不自然）。ローパスなら両方向とも霞が滑らかに動く。
		if (!fogDist) fogDist = st.camDist;
		else fogDist += (st.camDist - fogDist) * 0.18;
		if (Math.abs(st.camDist - fogDist) < st.camDist * 0.002) fogDist = st.camDist;
		st.fogDist = fogDist;
		const fogAnimating = fogDist !== st.camDist;   // 収束まで追加フレームを要求（呼び出し側が dirty 継続）
		// 視程下限のチルト係数（20°→46°）：真俯瞰0＝平面地図の縁を青く染めない／傾けるほど実距離の視程が効く
		const pfFog = Math.max(0, Math.min(1, ((cam.pitch || 0) - 0.35) / 0.45));
		// 真俯瞰では標高オフ、傾けるほどフェードイン（3.4°→11.5°）
		const pt = Math.max(0, Math.min(1, ((cam.pitch || 0) - 0.06) / 0.14));
		const pf = pt * pt * (3 - 2 * pt);
		// 都市ズームの平ら化(cityFlat: z13.5→16)は撤去（2026-07-26）。あれは ALOS AW3D30=DSM 時代の名残で、
		// 「都市の起伏＝ビル天端がベクタ建物と二重になる」対策だった。現在 z≥12 の標高源は R01=DEM10B（地理院
		// 10m DTM＝裸地）＝都市の起伏は本物の地形（台地・谷・扇状地）なので全ズームで見せるのが正しい。
		// ⚠轍：都市帯の標高源を DSM 系へ戻す時はこの taper（と深度のテント問題）が再び必要になる。
		elevScaleEff = elev.scale * pf;
		// 真俯瞰(pitch≈0)＋十分な寄り＝画面全面が陸。地球の縁/大気のレイキャストは映らず無駄なので、
		// 陸色で塗りつぶす clear だけの2D高速パスへ（フルスクリーンの球シェーダを丸ごと省略）。
		const land = view.land || [0.96, 0.96, 0.95, 1], atmo = view.atmo || [0.45, 0.62, 0.95, 0.6];
		const flat2d = (cam.pitch || 0) < 0.02 && cam.zoom >= 8;
		const c = flat2d ? [land[0], land[1], land[2], 1] : (view.clear || [1, 1, 1, 1]);
		gl.clearColor(c[0] * c[3], c[1] * c[3], c[2] * c[3], c[3]);
		gl.clear(gl.COLOR_BUFFER_BIT);
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
		gl.disable(gl.DEPTH_TEST);
		gl.clear(gl.DEPTH_BUFFER_BIT);

		// 星空劇場（z<4）：globe より先に描く＝陸には上書きされ・大気ハローは星の上に薄く重なり・宇宙には星が残る。
		// 深度無関係の背景（VSが clip.z=0 固定）。天球の向きは恒星時(GMST)＝実時刻の空。versor回転にもそのまま追随。
		const worldFade = !flat2d && cam.zoom < 4 ? Math.min(1, (4 - cam.zoom) / 0.5) : 0;   // 星空劇場（星・夜面）共通の出現フェード
		const starFade = (stars || constel || planets) ? worldFade : 0;
		if (starFade > 0) {
			const gmst = (((18.697374 + 24.0657098 * (Date.now() / 864e5 + 2440587.5 - 2451545.0)) * 15) % 360) * Math.PI / 180;
			const cg = Math.cos(gmst), sg = Math.sin(gmst);
			// 遠近表現（v1移植）：天球倍率 ∝ (0.4+0.3z)＝ズームに線形（地球は2^z）。z4（フェード境界）で1に正規化
			// ＝出現時のスケールが素の投影と連続（ポップしない）。ズームアウトで星空が密に寄る＝空が「遠くなる」。
			const skyK = (0.4 + 0.3 * cam.zoom) / 1.6;
			const starUniforms = prog => {
				gl.uniformMatrix4fv(loc(gl, prog, "u_mvp"), false, st.mvp32);
				gl.uniform2f(loc(gl, prog, "u_gmst"), cg, sg);
				gl.uniform1f(loc(gl, prog, "u_fade"), starFade);
				gl.uniform1f(loc(gl, prog, "u_sky"), skyK);
			};
			if (stars || planets) {
				gl.useProgram(starsProg);
				starUniforms(starsProg);
				if (stars) { gl.bindVertexArray(stars.vao); gl.drawArrays(gl.POINTS, 0, stars.count); }
				if (planets) { gl.bindVertexArray(planets.vao); gl.drawArrays(gl.POINTS, 0, planets.count); }   // 惑星＝同じ点プログラム（実位置はアプリが更新）
			}
			if (view.showConst && (constel || ecliptic || celeq)) {
				gl.useProgram(starLineProg);
				starUniforms(starLineProg);
				const lines = [   // [バッファ, 色（定数attrib＝VAO外の文脈状態）]
					[constel, [0.47, 0.63, 1.0, 0.4]],    // 星座線＝v1と同じ青（rgba(120,160,255)）
					[ecliptic, [1.0, 0.8, 0.45, 0.35]],   // 黄道＝淡い黄（太陽・月・惑星の通り道）
					[celeq, [1.0, 0.55, 0.5, 0.32]],      // 天の赤道＝淡い紅（「赤道」の名の通り。地球の赤道の空への投影）
				];
				for (const [b, c] of lines) {
					if (!b) continue;
					gl.bindVertexArray(b.vao);
					gl.vertexAttrib4f(1, c[0], c[1], c[2], c[3]);
					gl.drawArrays(gl.LINES, 0, b.count);
				}
			}
			gl.bindVertexArray(emptyVAO);
		}

		// 球体本体：land基色を縁(リム)まで敷く（宇宙を背に丸い地球）。2D高速パス時は clear で代替＝省略。
		if (!flat2d) {
			gl.useProgram(globeProg);
			gl.uniformMatrix4fv(loc(gl, globeProg, "u_invMvp"), false, Float32Array.from(st.invMvp));
			gl.uniform4f(loc(gl, globeProg, "u_land"), land[0], land[1], land[2], land[3]);
			gl.uniform4f(loc(gl, globeProg, "u_atmo"), atmo[0], atmo[1], atmo[2], atmo[3]);
			gl.bindVertexArray(emptyVAO);
			gl.drawArrays(gl.TRIANGLES, 0, 3);
		}

		// 標高テクスチャをユニット1へ（全プログラムが elev() で参照）
		if (elev.has && elevTex) { gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, elevTex); gl.activeTexture(gl.TEXTURE0); }
		const terrainActive = !!(terrain && elev.has && elevScaleEff > 1e-9) && !(opts && opts.noTerrain);   // 傾き時のみ地形あり。noTerrain=全球ビューでは矩形アトラスを描かない
		// ここから深度あり（建物同士の前後関係を共有）
		gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
		// 地形サーフェス（標高変位＋hillshade）。真俯瞰(pf≈0)では描かない＝平面地図。
		// 深度は書かない＝背景扱い：地形サーフェスが深度を書くと、その上に立つ建物(基図/PLATEAU)と
		// 干渉し得る（DSM時代は「屋根の高さのテント」が建物を丸ごと飲んだ。現 R01=DTM でも接地誤差の
		// z-fight を避ける）。塗り・線が既にペインタ順で地形の上な設計（半透明の山）
		// に建物も合わせ、地形深度との衝突を根絶する。地形自身は凸地形の重なりが稀に透けるが設計内の割り切り。
		// 地形の深度書き＝凸地形の自遮蔽（富士の"頂上抜け"対策）＋基図・建物も尾根の向こうは隠れる。
		// 旧: z<13 限定（都市帯は ALOS DSM のビル天端が建物を飲む＝テント問題）。cityFlat 撤去（2026-07-26）と
		// ペアで全ズーム化：z≥12 の標高源は R01=DEM10B（DTM＝裸地）なのでテントは存在せず、都市帯にも起伏が
		// 出た以上、深度が無いと尾根の向こうの建物・道路が透ける（札幌 藻岩山で実測）。
		// polygonOffset で地形をわずかに奥へ＝ドレープした基図(同じ対数深度)が z-fight せず表に出る。
		const terrainDepth = terrainActive;
		// 水面リフト(+30m)は DSM 帯（R10 混成があり得る z<13）限定＝DTM の都市帯で川を 30m 浮かせない。
		const dsmLift = terrainDepth && cam.zoom < 13;
		// 標高パイプライン計器（?perf=1 時・2秒毎）：「高度が消える」系の切り分け用＝どの因子が0かを1行で。
		if (self.__perfElev && performance.now() - (self.__perfElevT || 0) > 2000) {
			self.__perfElevT = performance.now();
			console.log('[elev] z=%s pitch=%s scale=%s pf=%s eff=%s has=%s mesh=%s active=%s depth=%s bounds=%s',
				cam.zoom.toFixed(2), ((cam.pitch || 0) * 180 / Math.PI).toFixed(0),
				elev.scale?.toExponential?.(2), pf.toFixed(2), elevScaleEff?.toExponential?.(2),
				elev.has, !!terrain, terrainActive, terrainDepth, elev.bounds?.map(v => +v.toFixed(2)).join(','));
		}
		if (terrainActive) {
			gl.depthMask(terrainDepth);
			if (terrainDepth) { gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(1.0, 4.0); }
			setCommonUniforms(terrainProg, st, scenes.main.origin || [0, 0], land);   // RTE 錨＝シーン原点（旧[0,0]だと錨が地物から遠く相殺回避が効かない）
			// 地形だけフォグを「遠山ブルー」に：空気遠近法＝遠くの山は青く霞む。地平線の山並みが
			// 説明不要で"山"として読める（基図の線/塗りは従来どおり紙色へフェードアウト＝浮かない）。
			// 距離も地形だけ半分に詰める＝中景の山並み（80-150km）にしっかり青が乗る。
			// 距離は camDist 比例に「実距離の下限＝視程」を併用：ズームを寄せても 50km 手前から
			// 165km（快晴の山岳視程）までは霞み切らない＝八ヶ岳から中央・北アルプスが青い山並みとして残る。
			const dc = view.distColor || [0.63, 0.72, 0.83];
			gl.uniform3f(loc(gl, terrainProg, "u_fogColor"), dc[0], dc[1], dc[2]);
			// 視程の下限（50km/165km）はチルト連動：真俯瞰では0＝純camDist比例（見下ろす平面地図の縁が
			// 青く染まるのを防ぐ）。傾けるほど（20°→46°）横に大気を見通す＝実距離の視程が効く。
			gl.uniform1f(loc(gl, terrainProg, "u_fogNear"), Math.max(st.fogDist * 1.2, 0.008 * pfFog));
			gl.uniform1f(loc(gl, terrainProg, "u_fogFar"), Math.max(st.fogDist * 5.0, 0.026 * pfFog));
			gl.uniform3f(loc(gl, terrainProg, "u_land"), land[0], land[1], land[2]);
			// 標高ティント（view.hypso={color,max,amount}＝テーマのノブ）。未指定は amount=0＝恒等（従来の単色陰影）
			const hy = view.hypso;
			gl.uniform3f(loc(gl, terrainProg, "u_hypso"), hy ? hy.color[0] : 0, hy ? hy.color[1] : 0, hy ? hy.color[2] : 0);
			gl.uniform2f(loc(gl, terrainProg, "u_hypsoP"), hy ? 1 / (hy.max || 3000) : 0, hy ? (hy.amount ?? 0.5) : 0);
			gl.bindVertexArray(terrain.vao);
			gl.drawElements(gl.TRIANGLES, terrain.count, gl.UNSIGNED_INT, 0);
			gl.depthMask(true);
			if (terrainDepth) gl.disable(gl.POLYGON_OFFSET_FILL);
		}
		// ベクタ(塗り/線)は常にペインタ順で地形の上に描く＝深度で地形と争わせない。傾き時も平面時も、
		// 陸・海・道路が地形サーフェスと z-fight して揺れる/寸断するのを根絶（地形の起伏は先に深度で解決済）。
		gl.disable(gl.DEPTH_TEST);
		// 等高線：真俯瞰(チルト≈0)でだけ茶の等高線を敷く（3Dが立ち上がる前＝ちょうど入れ替わりでフェード）。ベクタの下＝道路/区界は上に乗る。
		{
			const ps = Math.max(0, Math.min(1, ((cam.pitch || 0) - 0.01) / 0.05));   // pitch 0.01→0.06rad で 3D と入れ替わり
			const zf = 1 - Math.max(0, Math.min(1, (cam.zoom - 16.5) / 1.5));        // z16.5→18 でフェードアウト（DEM過拡大＝ボケ/汚れを出さない）
			const cAlpha = (elev.has && !(opts && opts.noTerrain) && view.showContour === true) ? (1 - ps * ps * (3 - 2 * ps)) * zf : 0;
			if (cAlpha > 0.003 && cam.zoom >= 8) {
				gl.useProgram(contourProg);
				gl.uniformMatrix4fv(loc(gl, contourProg, "u_invMvp"), false, Float32Array.from(st.invMvp));
				gl.uniform1i(loc(gl, contourProg, "u_elevTex"), 1);
				gl.uniform4f(loc(gl, contourProg, "u_elevBounds"), elev.bounds[0], elev.bounds[1], elev.bounds[2], elev.bounds[3]);
				gl.uniform1f(loc(gl, contourProg, "u_hasElev"), elev.has);
				const iv = cam.zoom >= 14 ? 15 : cam.zoom >= 11 ? 30 : 60;   // 寄るほど細かい間隔(m)
				gl.uniform1f(loc(gl, contourProg, "u_interval"), iv);
				gl.uniform1f(loc(gl, contourProg, "u_major"), iv * 5.0);
				gl.uniform1f(loc(gl, contourProg, "u_alpha"), cAlpha * (view.contourAlpha || 1));
				const cc = view.contourColor || [0.42, 0.30, 0.18];   // 茶(セピア)
				gl.uniform3f(loc(gl, contourProg, "u_cColor"), cc[0], cc[1], cc[2]);
				gl.bindVertexArray(emptyVAO);
				gl.drawArrays(gl.TRIANGLES, 0, 3);
			}
		}
		gl.useProgram(lineProg); gl.uniform1f(loc(gl, lineProg, "u_dpr"), cam.dpr || 1);

		// 山岳ビュー＝基図(塗り/線)は地形深度でテストだけする（書かない）：尾根の向こうの道路・塗りが透けない。
		// fill/line の VS は applyLogDepth と同式の対数深度を焼いており地形と直接比較できる。
		if (terrainDepth) { gl.enable(gl.DEPTH_TEST); gl.depthMask(false); }
		// skipMain＝ズームアウト中の「古い詳細シーン」を隠し、常設の粗い下地に揃える（縮んだ細密パッチが
		// 周囲と質感違いで浮くのを防ぐ）。下地は代役なので skipBase より優先＝空白フレームを作らない。
		const slots = (opts && opts.skipMain) ? ["base"]
			: (opts && opts.skipBase) ? ["main"] : ["base", "main"];   // 静止時は下地を隠しLOD痕を消す
		// 線・塗りのフォグ終端は地形と同一式＝地形が完全に霞んだ先に線だけ生き残って「空に浮く白線」に
		// なるのを構造的に防ぐ。シェーダの遠景平ら化(df)も u_fogFar 基準なので、同値なら線は地形に厳密追随する。
		const fogFarCap = Math.max(st.fogDist * 5.0, 0.026 * pfFog);
		// gint（1canvas統合・埋込パス）向けの frame コンテキスト：山岳ビュー（terrainDepth）の間だけ、
		// 対数深度係数（setCommonUniforms の u_logCoef と同式）と標高ドレープ一式を渡す＝gint 線が
		// 基図の線と同じ高さ・同じ深度空間で地形に参加（尾根の向こうは隠線＝淡破線）。それ以外は null＝最前面。
		if (terrainDepth) {
			const _lb = Math.sqrt(Math.max((1 + st.camDist) * (1 + st.camDist) - 1, 1e-12));
			gintCtx = { terrainDepth: true,
				logCoef: 2.0 / Math.log2(_lb * 1.15 + st.camDist + 1.0),
				fogFar: fogFarCap, elevTex, elevBounds: elev.bounds,
				elevScale: elevScaleEff, hasElev: elev.has, edgeFade: elev.edgeFade || 0 };
		} else gintCtx = null;
		// 下地の線は「本命(main)の線と同時に出る時だけ」伏せる＝ズーム中に太さ・形状のズレた「LODの荒い線」が
		// 透けるのを防ぐ（従来はmerge時に間引いていたがdraw時判断へ移設）。下地が主役の間（skipMain=ズームアウト
		// 退場中や本命未着）は線も描く＝低ズームは線が絵の本体なので、これが無いと引いた瞬間に真っ白になる。
		const mainLinesOn = slots.indexOf("main") >= 0 && sceneHasDraws(scenes.main);
		for (const slot of slots) {   // 粗い下書き→現ズームの順
			const scene = scenes[slot];
			if (scene.md) {   // multi_draw シーン＝常駐プールのレンジ列を li 順に流す（分岐ロジックは classic と同一）
				setCommonUniforms(md.fillProg, st, scene.origin, land);
				setCommonUniforms(md.lineProg, st, scene.origin, land);
				gl.useProgram(md.fillProg); gl.uniform1f(loc(gl, md.fillProg, "u_fogFar"), fogFarCap);
				gl.useProgram(md.lineProg); gl.uniform1f(loc(gl, md.lineProg, "u_fogFar"), fogFarCap);
				gl.uniform1f(loc(gl, md.lineProg, "u_dpr"), cam.dpr || 1);
				gl.uniform1i(loc(gl, md.lineProg, "u_segTex"), 6);
				if (md.lineTex) { gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, md.lineTex); gl.activeTexture(gl.TEXTURE0); }
				let curProgM = null;
				for (const e of scene.md.layers) {
					if (e.kind === "fill") {
						if ((e.li === sea.li || e.li === sea.li2) && cam.zoom < sea.minzoom) continue;   // 海：ビュー一律ゲート（classicと同じ）
						// 水面は「+30mリフトして深度テスト復帰」（classic 側と同判断＝チルトの尾根遮蔽と琵琶湖の偽島を両立）
						if (curProgM !== md.fillProg) { gl.useProgram(md.fillProg); gl.bindVertexArray(md.fillVAO); curProgM = md.fillProg; }
						gl.uniform1f(loc(gl, md.fillProg, "u_lift"), (dsmLift && (e.li === sea.li || e.li === sea.li2)) ? WATER_LIFT_M : 0);
						gl.uniform2fv(loc(gl, md.fillProg, "u_tileOff"), e.origins);
						md.ext.multiDrawElementsWEBGL(gl.TRIANGLES, e.counts, 0, gl.UNSIGNED_INT, e.offsets, 0, e.counts.length);
					} else {
						if (slot === "base" && mainLinesOn) continue;   // 本命の線が出ている間は下地の線を伏せる
						if (curProgM !== md.lineProg) { gl.useProgram(md.lineProg); gl.bindVertexArray(emptyVAO); curProgM = md.lineProg; }
						gl.uniform2fv(loc(gl, md.lineProg, "u_tileOff"), e.origins);
						md.ext.multiDrawArraysWEBGL(gl.TRIANGLES, e.firsts, 0, e.counts, 0, e.counts.length);
					}
				}
				gl.bindVertexArray(null);
				continue;
			}
			if (!scene.draws.length) continue;
			setCommonUniforms(fillProg, st, scene.origin, land);
			setCommonUniforms(lineProg, st, scene.origin, land);
			gl.useProgram(fillProg); gl.uniform1f(loc(gl, fillProg, "u_fogFar"), fogFarCap);
			gl.useProgram(lineProg); gl.uniform1f(loc(gl, lineProg, "u_fogFar"), fogFarCap);
			let curProg = null;
			for (const d of scene.draws) {
				if (d.kind === "fill") {
					if ((d.li === sea.li || d.li === sea.li2) && cam.zoom < sea.minzoom) continue;   // 海：ビュー一律ゲート（詳細以外は描かない＝紙の海）。li2=水系点火面
					// 水面は「+30mリフトして深度テスト復帰」：旧・免除（後書き）はチルトで尾根の遮蔽が効かず、
					// 稜線の向こうの湖が山腹に透けた（山中湖で顕在化）。リフトが DSM の水面ノイズ瘤(±10m級)を
					// 沈め「湖の偽の島」（琵琶湖）も防ぐ＝両立。数百m級の尾根には引き続き隠される。
					if (curProg !== fillProg) { gl.useProgram(fillProg); curProg = fillProg; }
					gl.uniform1f(loc(gl, fillProg, "u_lift"), (dsmLift && (d.li === sea.li || d.li === sea.li2)) ? WATER_LIFT_M : 0);
					gl.bindVertexArray(d.vao);
					if (d.idxT) gl.drawElements(gl.TRIANGLES, d.count, d.idxT, 0);
					else gl.drawArrays(gl.TRIANGLES, 0, d.count);
				} else {
					if (slot === "base" && mainLinesOn) continue;   // 本命の線が出ている間は下地の線を伏せる
					if (curProg !== lineProg) { gl.useProgram(lineProg); curProg = lineProg; }
					gl.bindVertexArray(d.vao);
					gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, d.count);
				}
			}
		}
		if (terrainDepth) { gl.disable(gl.DEPTH_TEST); gl.depthMask(true); }   // 基図の深度テストを解除（overlayは従来通り最前面）
		// overlay（外部ベクタ=geopbf/e-Stat）：stencil-then-cover で塗り（earcut不要・扇なし）＋境界線。深度off・最前面。
		drawOverlay(st, cam.dpr || 1, land, cam.zoom || 0);
		gl.enable(gl.DEPTH_TEST);   // 建物は常に深度で前後関係を解決（地形・尾根に遮蔽される）

		// 建物（3D押し出し）：深度で前後関係を解決（地形・尾根にも遮蔽される）。
		// PLATEAU の区bbox 内だけ基図建物を伏せる（u_plateauBboxN）＝同一体積の全面 z-fight を断ちつつ、範囲外の建物は残す。
		// マスクは区単位（plateauMasks）＝最大 MAX_PLATEAU_MASKS 区まで（シェーダのスロット数固定）。
		// 真俯瞰（チルト≈0）では基図/PLATEAU とも建物3Dを描かない＝平面地図（閾値は flat2d と同じ 0.02rad≈1.1°）。
		const show3d = (cam.pitch || 0) >= 0.02;
		const mdBld = scenes.main.md && scenes.main.md.bld;   // multi_draw シーンの建物＝プールレンジ列（チャンク配列）
		const bld = show3d && !(opts && opts.skipMain) ? (scenes.main.bld || mdBld) : null;   // 建物はmainシーンの一部＝一緒に退場
		if (bld) {
			const prog = scenes.main.bld ? bldProg : md.bldProg;
			const c = view.bldColor || [0.86, 0.86, 0.85];
			setCommonUniforms(prog, st, scenes.main.origin, land);
			gl.uniform3f(loc(gl, prog, "u_bldColor"), c[0], c[1], c[2]);
			const active = [...plateauMasks.entries()].filter(([w]) => !plateauHidden.has(w)).map(([, m]) => m).slice(0, MAX_PLATEAU_MASKS);   // 非表示区のマスクはスロットに載せない＝基図建物が戻る
			gl.uniform1i(loc(gl, prog, "u_plateauCount"), active.length);
			for (let i = 0; i < MAX_PLATEAU_MASKS; i++) {
				const m = active[i], pb = m ? m.bbox : [1e9, 1e9, -1e9, -1e9];
				gl.uniform4f(loc(gl, prog, `u_plateauBbox${i}`), pb[0], pb[1], pb[2], pb[3]);
				if (m) { gl.activeTexture(gl.TEXTURE2 + i); gl.bindTexture(gl.TEXTURE_2D, m.tex); gl.activeTexture(gl.TEXTURE0); }
				gl.uniform1i(loc(gl, prog, `u_plateauMask${i}`), 2 + i);
			}
			if (scenes.main.bld) {
				gl.bindVertexArray(bld.vao);
				gl.drawArrays(gl.TRIANGLES, 0, bld.count);
			} else {
				gl.bindVertexArray(md.bldVAO);
				for (const e of mdBld) {
					gl.uniform2fv(loc(gl, prog, "u_tileOff"), e.origins);
					md.ext.multiDrawArraysWEBGL(gl.TRIANGLES, e.firsts, 0, e.counts, 0, e.counts.length);
				}
			}
		}
		// PLATEAU LOD2 建物メッシュ（任意三角形・面法線陰影）。深度で地形・自身の前後を解決。
		// ※巻き順が不揃いなデータなので back-face カリングは使わない（屋根を誤って捨てる）＝両面描画。
		//   z-fight の元＝重複面は worker 側の頂点3つ組 dedup で断つ。
		// バッチ単位でフラスタムカリング＝区全体(数百万tris)のうち画面に掛かるバッチだけ頂点処理へ流す。
		if (plateaux.size && show3d) {
			gl.useProgram(plateauProg);
			const c = view.bldColor || [0.86, 0.86, 0.85];   // 基図の押し出し建物と同色＝周辺と地続きに見せる
			const pad = 0.5 * Math.max(st.W, st.H);          // 高層ビルの頭のはみ出し余白（半画面）
			// LOD打ち切りの物差し＝画面1pxが何mか（app.js approxViewBbox と同式。ortho-z は緯度非依存）。
			// 「画面上~1px未満の建物は描かない」＝見た目は変えずに頂点処理を捨てる。遠方バッチは距離で緩やかに閾値を上げる
			// （チルト時の遠景は透視で1pxがもっと大きい＝控えめ側の近似）。
			const mppx = 156543.03392 * 0.819 / Math.pow(2, cam.zoom || 0);
			const cosLat = Math.cos((cam.center[1] || 0) * Math.PI / 180);
			for (const p of plateaux.values()) {
				if (plateauHidden.has(p.ward)) continue;   // 常駐中の非表示区（VRAM保持・draw skip）
				if (!plateauBboxVisible(st, p.bbox, cam.center, pad)) continue;
				let count = p.count;
				// LOD打ち切りは建物のみ。橋梁（two＝両面）は「高さ3〜5m×長さ数百m」＝高さ基準だと小物と誤判定され
				// 桁が距離で歯抜けになる（横浜ベイブリッジで実測）ため適用しない。橋梁データは軽い＝全描画で問題ない。
				if (p.lodH && !p.two) {   // index は建物高さ降順＝先頭 count で「高さ閾値以上だけ」になる
					const dm = Math.hypot(((p.bbox[0] + p.bbox[2]) / 2 - cam.center[0]) * 111320 * cosLat, ((p.bbox[1] + p.bbox[3]) / 2 - cam.center[1]) * 111320);
					const minH = mppx * (1 + dm / 4000);
					let li = 0;
					for (let i = p.lodH.length - 1; i > 0; i--) if (p.lodH[i] <= minH) { li = i; break; }
					count = p.lodCounts[li];
					if (!count) continue;
				}
				setCommonUniforms(plateauProg, st, [0, 0], land);
				gl.uniform3f(loc(gl, plateauProg, "u_bldColor"), c[0], c[1], c[2]);
				gl.uniform1f(loc(gl, plateauProg, "u_cullBack"), p.two ? 0 : 1);   // 橋梁＝両面（開いた薄面が裏から消えない）
				gl.uniform3f(loc(gl, plateauProg, "u_meshOrigin"), p.origin[0], p.origin[1], p.origin[2]);  // RTE 錨（頂点は重心相対 delta）
				const cM = mat.transform(st.mvp, [p.origin[0], p.origin[1], p.origin[2], 1]);   // clip錨を CPU(double) で（旧: シェーダ float32 で mvp*meshOrigin＝相殺）
				gl.uniform4f(loc(gl, plateauProg, "u_clipMesh"), cM[0], cM[1], cM[2], cM[3]);
				gl.bindVertexArray(p.vao);
				gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_INT, 0);
			}
		}
		gl.disable(gl.DEPTH_TEST);
		// 夜面（星空劇場と同じ z<4 ゲート・同じフェード）：現在時刻の太陽直下点（v1 nightJSON と同式＝
		// 赤緯23.4°正弦近似＋UTC時刻→経度）を平行光源に、夜半球を夜紺で減光。地図の全レイヤの上に重ねる。
		if (worldFade > 0) {
			const dDay = Date.now() / 864e5;
			const sunLat = 23.4 * Math.sin((dDay / 365.24 % 1 - 0.225) * 2 * Math.PI) * Math.PI / 180;
			const sunLng = (((dDay % 1 * -360 + 360) % 360) - 180) * Math.PI / 180;
			const cs = Math.cos(sunLat);
			gl.useProgram(nightProg);
			gl.uniformMatrix4fv(loc(gl, nightProg, "u_invMvp"), false, Float32Array.from(st.invMvp));
			gl.uniform3f(loc(gl, nightProg, "u_sun"), cs * Math.cos(sunLng), Math.sin(sunLat), cs * Math.sin(sunLng));
			gl.uniform1f(loc(gl, nightProg, "u_alpha"), 0.5 * worldFade);   // v1 の夜面 50% × 出現フェード
			gl.bindVertexArray(emptyVAO);
			gl.drawArrays(gl.TRIANGLES, 0, 3);
		}
		gl.bindVertexArray(null);
		return fogAnimating;   // true＝フォグ距離が収束中（呼び出し側は次フレームも描く）
	}

	function disposeSlot(slot) {
		for (const d of scenes[slot].draws) { for (const b of d.bufs) gl.deleteBuffer(b); gl.deleteVertexArray(d.vao); }
		if (scenes[slot].bld) { for (const b of scenes[slot].bld.bufs) gl.deleteBuffer(b); gl.deleteVertexArray(scenes[slot].bld.vao); }
		scenes[slot] = { origin: scenes[slot].origin, draws: [], bld: null, md: null };   // md シーンは参照リストだけ＝GL資源なし（プールは常駐）
	}
	function dispose() { disposeSlot("base"); disposeSlot("main"); disposeOverlay(overlay); disposeOverlay(overlayHi); for (const o of n02) disposeOverlay(o); }

	// 汎用 set(cmd, data, prop)：ortho-map createLayers の set プロトコルに整合。将来 worker では
	// postMessage({ type:"set", cmd, data, prop }, transferables) にそのまま載る。prop は cmd ごとに融通。
	function set(cmd, data, prop) {
		switch (cmd) {
			case "view":      setView(data); break;                                            // data={clear,land,atmo,bldColor}
			case "sea":       sea = { ...sea, ...data }; break;                                  // data={li, minzoom} 海の点火ゲート
			case "scene":     setScene(data, prop); break;                                      // prop=slot("base"|"main")
			case "mdGrow":    mdGrow(data.pool, data.units); break;                            // multi_draw: プール成長（GPU内コピー）
			case "mdUp":      mdUpload(data); break;                                           // multi_draw: タイルブロック転送
			case "mdScene":   mdScene(data); break;                                            // multi_draw: draw list 差し替え（転送ゼロ）
			case "overlay":   setOverlay(data, prop); break;                                    // prop=fillColor(任意)
			case "overlayHi": setOverlayHi(data, prop); break;
			case "n02":       setN02(data); break;                                               // data=[シーン…] 交通の常駐オーバーレイ群
			case "elevAtlas": setElevationAtlas(data, prop); break;                             // prop=scale
			case "elevCell":  setElevationCell(prop.cx, prop.cy, data, prop.cellRes); break;    // data=セルFloat32
			case "elevAtlasStage": setElevationAtlasStage(data, prop); break;                   // 舞台裏アトラス（ダブルバッファ）
			case "elevCellStage": setElevationCellStage(prop.cx, prop.cy, data, prop.cellRes); break;
			case "elevAtlasCommit": commitElevationStage(); break;                              // 揃ったら一括スワップ＝山影が消えない
			case "plateauMesh": setPlateauMesh(prop, data); break;                             // prop=地区名(key)、data={pos,idx} PLATEAU LOD2 建物（null=解放）
			case "plateauVis":  setPlateauVis(prop, data); break;                              // prop=区名、data=真偽（GPU常駐のまま表示切替＝再訪の再アップロード不要）
			case "stars":     setStars(data); break;                                           // data=Float32Array [cel.xyz,rgb,a,size]×n
			case "constellations": setConstellations(data); break;                             // data=Float32Array [cel.xyz]×2n（LINES端点列）表示は view.showConst
			case "planets":   setPlanets(data); break;                                         // data=Float32Array（starsと同8fレイアウト・惑星5点＋月）
			case "ecliptic":  setEcliptic(data); break;                                        // data=Float32Array [cel.xyz]×2n（黄道の大円・LINES）表示は view.showConst
			case "celequator": setCelEquator(data); break;                                     // data=同上（天の赤道の大円）
			default: console.warn("renderer.set: unknown cmd", cmd);
		}
	}
	// md/mdMax は renderworker が scene worker へ「multi_draw モードで動け」を通知するための能力表明
	// gintCtx＝直近 draw の gint 深度統合コンテキスト（renderworker が gint パスへ渡す）
	return { gl, set, draw, dispose, md: !!md, mdMax: MD_MAX_DRAWS, gintCtx: () => gintCtx };
}

// --- GL ヘルパ ---
function program(gl, vsSrc, fsSrc) {
	const p = gl.createProgram();
	gl.attachShader(p, shader(gl, gl.VERTEX_SHADER, vsSrc));
	gl.attachShader(p, shader(gl, gl.FRAGMENT_SHADER, fsSrc));
	gl.linkProgram(p);
	if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("link: " + gl.getProgramInfoLog(p));
	return p;
}
function shader(gl, type, src) {
	const s = gl.createShader(type);
	gl.shaderSource(s, src); gl.compileShader(s);
	if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error("compile: " + gl.getShaderInfoLog(s) + "\n" + src);
	return s;
}
function buffer(gl, data) {
	const b = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, b);
	gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
	return b;
}
const _locCache = new WeakMap();
function loc(gl, prog, name) {
	let m = _locCache.get(prog); if (!m) _locCache.set(prog, m = new Map());
	if (!m.has(name)) m.set(name, gl.getUniformLocation(prog, name));
	return m.get(name);
}
// u8=true で UNSIGNED_BYTE 正規化（頂点色は Uint8×4＝float32×4 の1/4。シェーダは同じ 0..1 を受ける）
function attrib(gl, prog, name, buf, size, divisor, u8) {
	const l = gl.getAttribLocation(prog, name);
	if (l < 0) return;
	gl.bindBuffer(gl.ARRAY_BUFFER, buf);
	gl.enableVertexAttribArray(l);
	gl.vertexAttribPointer(l, size, u8 ? gl.UNSIGNED_BYTE : gl.FLOAT, !!u8, 0, 0);
	if (divisor != null) gl.vertexAttribDivisor(l, divisor);
}
