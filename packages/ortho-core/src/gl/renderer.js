// WebGL2 レンダラ：可視タイルを跨いで同一 style層を1バッファに結合した「シーン」を描く。
// draw call は「タイル数×層数」から「層数」へ激減し、uniform も1フレーム1回。共通のシーン原点で投影。
// fill = earcut三角形、line = capsule(SDF)。scene.layers は style層順（painter's algorithm）。
import { FILL_VS, FILL_FS, LINE_VS, LINE_FS, GLOBE_VS, GLOBE_FS, WDEPR_FS, GRAT_FS, BUILDING_VS, BUILDING_FS, TERRAIN_VS, TERRAIN_FS, STENCIL_VS, STENCIL_FS, COVER_FS, PLATEAU_VS, PLATEAU_FS, CONTOUR_FS, STARS_VS, STARS_FS, STARLINE_FS, NIGHT_FS, FILL_MD_VS, LINE_MD_VS, BUILDING_MD_VS, MD_MAX_DRAWS } from "./glsl.js";
import { cameraState, project, lonlatTo3D, betaOf, ellipsoidOn } from "../camera.js";   // betaOf/ellipsoidOn＝setCommonUniforms の楕円体錨（WGS84化でGL2側だけimport漏れ＝GL2全描画が毎フレームReferenceErrorの実バグを2026-08-12修正）
import { seaFbReal } from "../scene.js";   // 図郭外フォールバック水域の擬似li帯判定（build.js buildEmptySeaOps と対）
import { resolveWorldPal } from "../worldpal.js";   // 全球ハイプソの正準パレット（テーマ＝view.worldHypso の部分上書き）
import * as mat from "../mat.js";

const CORNERS = new Float32Array([0, -1, 0, 1, 1, -1, 1, -1, 0, 1, 1, 1]); // 6頂点×(end,side)

export function createRenderer(canvas, rOpts = {}) {
	// antialias＝ブラウザ暗黙確保の MSAA（フルRetina面積で ~100MB級）。msaa1（LOW_MEM 既定・?msaa=0）＝1x 直描き。
	const gl = canvas.getContext("webgl2", { antialias: !rOpts.msaa1, premultipliedAlpha: true, stencil: true });
	if (!gl) throw new Error("WebGL2 unavailable");

	const fillProg = program(gl, FILL_VS, FILL_FS);
	const lineProg = program(gl, LINE_VS, LINE_FS);
	const globeProg = program(gl, GLOBE_VS, GLOBE_FS);
	const wdCoverProg = program(gl, GLOBE_VS, WDEPR_FS);   // 海面下の陸地の cover＝landK=1 強制のハイプソ本体（フルスクリーン・stencil≠0 のみ）
	const gratProg = program(gl, GLOBE_VS, GRAT_FS);       // 10度レチクル（v1 geoGraticule10 移植・フルスクリーン計算）
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
	// 標高アトラスは R16F（half-float）。R32F は線形補間に OES_texture_float_linear が必須で、非対応GPU
	// （古い4GB機など）では NEAREST に落ちて地形が市松模様になる（R01 の高密度で顕著）。R16F は WebGL2 の
	// コアで線形フィルタ可（拡張不要）＝全デバイスで滑らか。おまけにアトラスの GPU メモリが半分（4B→2B/texel）
	// ＝jetsam にも効く。標高はメートル値を half-float で格納＝精度は十分（~4km で ±2m・低地は ±0.25m 級）。
	// 標高（GEBCO/ALOS）：テクスチャ＋地形格子メッシュ
	let elevTex = null, elev = { bounds: [0, 0, 1, 0], scale: 0, has: 0 }, terrain = null;
	// 遠景層（far）＝近窓の外を受け持つ粗い R10 第2アトラス（terrain.js が深ズーム×チルトで常設）。unit8（2-5=PLATEAUマスク・6=md線・7=gint elev と不干渉）
	let farTex = null, far = { bounds: [0, 0, 1, 0], has: 0, edgeFade: 0 };
	// 気候場テクスチャ（全球ハイプソの cross-blend 用・view.worldHypso.clim の URL から一度だけ取得）。
	// 未着の間はシェーダが緯度近似へフォールバック（u_hasClim=0）＝1-2フレームの色ズレのみ。
	let climTex = null, climLoading = false;
	function ensureClimTex(url) {
		if (climTex || climLoading || !url) return;
		climLoading = true;
		fetch(url).then(r => r.blob()).then(b => createImageBitmap(b, { premultiplyAlpha: "none" })).then(bm => {
			climTex = gl.createTexture();
			gl.activeTexture(gl.TEXTURE12); gl.bindTexture(gl.TEXTURE_2D, climTex);
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bm);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);          // 経度ラップ（±180の継ぎ目）
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
			gl.activeTexture(gl.TEXTURE0);
			bm.close(); rOpts.requestDraw?.();   // 到着フレームを一枚要求（静止中でも気候色へ差し替わる）
		}).catch(e => { console.warn("[hypso] climate texture load failed (緯度近似で継続)", e); });
	}
	// 気候場のサンプラ結線（globe/terrain 両プログラム共用）。⚠サンプラは常に有効unitへ向ける
	// （未設定＝unit0の整数テクスチャを掴んでドロー全体が死ぬ轍と同族）。unit12＝空き（他パス未使用）。
	function bindClim(prog) {
		gl.uniform1i(loc(gl, prog, "u_climTex"), 12);
		gl.uniform1f(loc(gl, prog, "u_hasClim"), climTex ? 1 : 0);
		gl.activeTexture(gl.TEXTURE12); gl.bindTexture(gl.TEXTURE_2D, climTex); gl.activeTexture(gl.TEXTURE0);
	}
	// 世界パレット（view.worldHypso の参照変化でだけ再解決＝setView は浅マージでオブジェクト丸ごと差し替わる）。
	// globe/terrain/wdepr は同一フレームの同一戻り値を使う＝wdepr⇄globe の縫い目（色の bit 一致契約）が構造的に保たれる。
	let wpal = resolveWorldPal(null), wpalSrc = null;
	const worldPal = () => {
		if (view.worldHypso !== wpalSrc) { wpalSrc = view.worldHypso; wpal = resolveWorldPal(wpalSrc); }
		return wpal;
	};
	function bindWorldPal(prog) {   // 要 useProgram 済み。8色＝WORLD_HYPSO チャンクの uniform
		const p = worldPal();
		gl.uniform3f(loc(gl, prog, "u_whLowH"), ...p.lowHumid);
		gl.uniform3f(loc(gl, prog, "u_whLowA"), ...p.lowArid);
		gl.uniform3f(loc(gl, prog, "u_whMidH"), ...p.midHumid);
		gl.uniform3f(loc(gl, prog, "u_whMidA"), ...p.midArid);
		gl.uniform3f(loc(gl, prog, "u_whR1"), ...p.ramp1);
		gl.uniform3f(loc(gl, prog, "u_whR2"), ...p.ramp2);
		gl.uniform3f(loc(gl, prog, "u_whPeak"), ...p.peak);
		gl.uniform3f(loc(gl, prog, "u_whSnow"), ...p.snow);
	}
	// ?mem=1 台帳のGPU固定常駐（自前確保分の概算）：標高アトラス（近/舞台裏/遠）＋地形メッシュ。
	// canvas antialias:true の MSAA はブラウザ暗黙確保＝ここでは数えない（HUD 側注記）。
	let memAtlas = 0, memStage = 0, memFar = 0, memMesh = 0;
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
	let bldFill = { li: -1 };   // 建物フットプリント塗り（基図 fill）の layer index。3D（チルト）時は伏せる＝押し出しと二重表現になるため
	let gintBld = null;   // gint ユーザー層（moj筆/ドロップ図形）の地形沿い境界線＝独自 origin・BUILDING_VS 再利用・GL_LINES（各頂点 anchor=自分＝自標高に乗る）
	const OVERLAY_LIFT_M = 3;   // overlay（外部ベクタ線/面）を地形から浮かせる(m)＝地形メッシュとの z-fight（境界線の明滅・消失）を断つ。gint drape(2m)同族＝高ズームで浮きが見えない最小値（15mは上げすぎ・本人指摘）。WebGPU OVERLAY_LIFT と対
	const WATER_LIFT_M = 30;   // 水面リフト(m)：DSM水面ノイズ瘤(±10m級)を沈める深度テスト用の嵩上げ（誇張前の実標高）
	const CITY_WATER_LIFT_M = 10;   // 都市帯(z≥13・DTM)の水面リフト(m)：河道の彫り込み・中州へ疎頂点の水ポリ三角形が潜るのを沈める（豊平川実測。5mでは不足・30mは近接ズームで川が堤防より浮く）
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

	// gint ユーザー層の地形沿いジオメトリを差し替え。data＝{origin, batches:[{lines,points,color}...]}（色別バッチ＝
	// 田/畑等の fid 色をドレープへ運ぶ）または旧形 { origin, lines:{pos,shade,anchor}?, points:{…}?, color? }。
	// 全て BUILDING_VS の 24B レイアウト（a_pos xyz / a_shade / a_anchor）＝bldProg で line=GL_LINES / point=GL_POINTS 描画。null=解放。
	function setGintBld(data) {
		if (gintBld) { for (const bt of gintBld.batches) { for (const b of bt.bufs) gl.deleteBuffer(b); if (bt.lineVAO) gl.deleteVertexArray(bt.lineVAO); if (bt.pointVAO) gl.deleteVertexArray(bt.pointVAO); } gintBld = null; }
		if (!data) return;
		const mk = g => {
			if (!g || !g.pos.length) return null;
			const vao = gl.createVertexArray();
			const bP = buffer(gl, g.pos), bS = buffer(gl, g.shade), bA = buffer(gl, g.anchor);
			gl.bindVertexArray(vao);
			attrib(gl, bldProg, "a_pos", bP, 3); attrib(gl, bldProg, "a_shade", bS, 1); attrib(gl, bldProg, "a_anchor", bA, 2);
			gl.bindVertexArray(null);
			return { vao, count: g.pos.length / 3, bufs: [bP, bS, bA] };
		};
		const batches = (data.batches || [data]).map(b => {
			const L = mk(b.lines), P = mk(b.points);
			if (!L && !P) return null;
			return {
				lineVAO: L?.vao || null, lineCount: L?.count || 0,
				pointVAO: P?.vao || null, pointCount: P?.count || 0,
				bufs: [...(L?.bufs || []), ...(P?.bufs || [])], color: b.color || null,
			};
		}).filter(Boolean);
		if (!batches.length) return;
		gintBld = { origin: data.origin, batches };
	}

	// 標高アトラス：セル群を1枚のテクスチャに敷く。a:{originLng,originLat,cellsX,cellsY,cellRes,cellSpan}
	// cellSpan=1セルの度数（R90=90/R10=10/R01=1）。
	// R16F アトラスを確保して 0(海)で初期化。全面ぶんの Float32Array（4096²＝67MB）を毎回作らず、
	// 4MB 級の使い回しストリップを縦に流す＝窓替えのたびの巨大な一時確保を無くす（GC 圧・footprint 対策）。
	let zeroStrip = null;
	function allocZeroR16F(W, H) {
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, W, H, 0, gl.RED, gl.FLOAT, null);
		const rows = Math.max(1, Math.min(H, (1 << 20) / W | 0));
		if (!zeroStrip || zeroStrip.length < W * rows) zeroStrip = new Float32Array(W * rows);
		for (let y = 0; y < H; y += rows) {
			const h = Math.min(rows, H - y);
			gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y, W, h, gl.RED, gl.FLOAT, zeroStrip.subarray(0, W * h));
		}
	}
	function setElevationAtlas(a, scale) {
		const W = a.cellsX * a.cellRes, H = a.cellsY * a.cellRes, span = a.cellSpan || 10;
		memAtlas = W * H * 2;   // R16F=2B/texel
		if (!elevTex) elevTex = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, elevTex);
		gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
		allocZeroR16F(W, H);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		elev = { bounds: [a.originLng, a.originLat, a.cellsX * span, a.cellsY * span], scale, exag: a.exag || 1, has: 1, edgeFade: a.edgeFade || 0, liftBounds: a.liftBounds || null };
		const G = Math.min(a.gMax || 1536, Math.max(768, 768 * Math.max(a.cellsX, a.cellsY)));   // gMax＝terrain.js が lowMem で 1024 に絞る（メッシュ 75→33.5MB）
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
		memStage = W * H * 2;
		const tex = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, tex);
		gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
		allocZeroR16F(W, H);
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
		memAtlas = memStage; memStage = 0;
		const a = elevStage.a, span = a.cellSpan || 10;
		elev = { bounds: [a.originLng, a.originLat, a.cellsX * span, a.cellsY * span], scale: elevStage.scale, exag: a.exag || 1, has: 1, edgeFade: a.edgeFade || 0, liftBounds: a.liftBounds || null };
		const G = Math.min(a.gMax || 1536, Math.max(768, 768 * Math.max(a.cellsX, a.cellsY)));   // gMax＝terrain.js が lowMem で 1024 に絞る（メッシュ 75→33.5MB）
		buildTerrainMesh(a.originLng, a.originLat, a.cellsX * span, a.cellsY * span, G);
		elevStage = null;
	}
	// ── 遠景層（far）アトラス ──：ダブルバッファ無し（R10 は LRU ヒットが常＝ゼロ初期化→同フレーム書込で
	// 埋まる。terrain.js 側コメント参照）。メッシュは近窓と同じ単位格子を u_mesh で遠窓へ伸ばす＝専用メッシュ不要。
	function setElevationAtlasFar(a) {
		const W = a.cellsX * a.cellRes, H = a.cellsY * a.cellRes, span = a.cellSpan || 10;
		memFar = W * H * 2;
		if (!farTex) farTex = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, farTex);
		gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
		allocZeroR16F(W, H);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		far = { bounds: [a.originLng, a.originLat, a.cellsX * span, a.cellsY * span], has: 1, edgeFade: a.edgeFade || 0 };
	}
	function setElevationCellFar(cx, cy, data, cellRes) {
		if (!farTex) return;
		gl.bindTexture(gl.TEXTURE_2D, farTex);
		gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
		gl.texSubImage2D(gl.TEXTURE_2D, 0, cx * cellRes, cy * cellRes, cellRes, cellRes, gl.RED, gl.FLOAT, data);
	}
	function clearElevationFar() {   // 深ズーム離脱＝GPU メモリを返す（10-16MB）
		if (farTex) gl.deleteTexture(farTex);
		farTex = null; far = { bounds: [0, 0, 1, 0], has: 0, edgeFade: 0 }; memFar = 0;
	}
	// 地形メッシュ＝単位格子 [0,1]²（G だけに依存）。窓の原点/幅は uniform u_mesh で渡す＝
	// 標高アトラスの窓替え（パンのたび）でメッシュを作り直さない。旧実装は毎回 lon/lat を焼いた
	// 頂点配列(G=1536 で 18.9MB)＋index(56.5MB)を作って GPU へ上げ直しており、広域×高チルトの
	// パンで「1窓替えごとに 75MB の GPU バッファ再確保＋CPU 一時配列」＝GPUプロセスが単調に膨れる
	// 主因だった（実測: 陸上パン34ホップで累計 GL alloc 1.2GB・GPUプロセス 1.45→1.95GB）。
	// G が変わる時だけ作り直す＝実質「起動時に一度」。
	function buildTerrainMesh(oLng, oLat, spanLng, spanLat, G) {
		if (terrain && terrain.G === G) { terrain.mesh = [oLng, oLat, spanLng, spanLat]; return; }
		const uv = new Float32Array(G * G * 2);
		for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) { const k = (j * G + i) * 2; uv[k] = i / (G - 1); uv[k + 1] = j / (G - 1); }
		const idx = new Uint32Array((G - 1) * (G - 1) * 6);
		let p = 0; for (let j = 0; j < G - 1; j++) for (let i = 0; i < G - 1; i++) { const a = j * G + i, b = a + 1, c = a + G, d = c + 1; idx[p++] = a; idx[p++] = c; idx[p++] = b; idx[p++] = b; idx[p++] = c; idx[p++] = d; }
		if (terrain) { gl.deleteVertexArray(terrain.vao); gl.deleteBuffer(terrain.vbo); gl.deleteBuffer(terrain.ibo); }
		const vao = gl.createVertexArray(), vbo = buffer(gl, uv), ibo = gl.createBuffer();
		gl.bindVertexArray(vao);
		attrib(gl, terrainProg, "a_uv", vbo, 2);
		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
		gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
		gl.bindVertexArray(null);
		memMesh = uv.byteLength + idx.byteLength;
		terrain = { vao, vbo, ibo, count: idx.length, G, mesh: [oLng, oLat, spanLng, spanLat] };
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
		// 被覆マスク（NEAREST・CLAMP）＝届いたバッチの断片(maskCells)だけをOR合成（gpu/renderer.js と同意味論）。
		// 旧・全量スナップショット差し替えはマスクがメッシュに先行し「矩形の隙間」を作った＝断片方式で根治。
		if (data.ward && (data.maskCells || data.mask) && (data.maskN | 0) > 0 && data.maskBbox) {
			const N = data.maskN | 0;
			let m = plateauMasks.get(data.ward);
			if (!m || m.n !== N) {
				if (m) gl.deleteTexture(m.tex);
				m = { tex: gl.createTexture(), bbox: data.maskBbox, n: N, bytes: new Uint8Array(N * N) };
				plateauMasks.set(data.ward, m);
			}
			m.bbox = data.maskBbox;
			if (data.maskCells) { for (let i = 0; i < data.maskCells.length; i++) { const c = data.maskCells[i]; if (c < m.bytes.length) m.bytes[c] = 255; } }
			else for (let i = 0; i < data.mask.length && i < m.bytes.length; i++) if (data.mask[i]) m.bytes[i] = 255;   // 旧worker互換（全量OR＝単調なので破壊しない）
			gl.bindTexture(gl.TEXTURE_2D, m.tex);
			gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, N, N, 0, gl.RED, gl.UNSIGNED_BYTE, m.bytes);
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
	let overlay = null, overlayHi = null, overlayHover = null, n02 = [];   // overlayHover＝ホバー境界の太線（選択マスク overlayHi と別スロット）。n02＝交通の常駐オーバーレイ群
	let wdepr = null;   // 海面下の陸地（?world=1・全球ハイプソの一部）＝タイル(湖)より先に描く専用スロット。whK フェードに連動
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
		return { fanVao, fanCount: s.fanPos.length / 2, lineVao, lineCount, origin: s.origin, fillColor, bufs, minZoom: s.minZoom || 0, feats: s.feats || null };   // minZoom＝シーン単位のズームゲート。feats＝feature毎レンジ+外接円（wdepr の球体カリング用）
	}
	function disposeOverlay(o) { if (o) { for (const b of o.bufs) gl.deleteBuffer(b); gl.deleteVertexArray(o.fanVao); if (o.lineVao) gl.deleteVertexArray(o.lineVao); } }
	function setOverlay(s, fillColor) { disposeOverlay(overlay); overlay = s ? buildOverlaySlot(s, fillColor || [0.20, 0.45, 0.85, 0.32]) : null; }
	// N02 交通の常駐オーバーレイ群を丸ごと差し替え。各要素は buildGeoJSONOverlay のシーン（線色は焼込済）。
	function setN02(scenes) { for (const o of n02) disposeOverlay(o); n02 = (scenes || []).map(s => buildOverlaySlot(s, [0, 0, 0, 0])); }
	function setOverlayHi(s, fillColor) {   // fillColor=配列は従来の面塗り／{mask,color}は周辺マスク（外側を暗く・地物は塗らない）
		disposeOverlay(overlayHi);
		if (!s) { overlayHi = null; return; }
		const isMask = fillColor && !Array.isArray(fillColor);
		overlayHi = buildOverlaySlot(s, isMask ? (fillColor.color || [0, 0, 0, 0.15]) : (fillColor || [0.95, 0.55, 0.15, 0.6]));
		if (overlayHi) overlayHi.mask = !!(isMask && fillColor.mask);
	}
	function setOverlayHover(s) { disposeOverlay(overlayHover); overlayHover = s ? buildOverlaySlot(s, [0, 0, 0, 0]) : null; }   // 塗り透明＝境界線のみ（太線はシーンの lineWidth）
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
			gl.uniform1f(loc(gl, stencilProg, "u_lift"), OVERLAY_LIFT_M);   // 地形から浮かせて z-fight を断つ（面の stencil 位置）
			gl.bindVertexArray(o.fanVao); gl.drawArrays(gl.TRIANGLES, 0, o.fanCount);
			// cover パス：通常＝stencil≠0(内側)を塗り0へ戻す／o.mask＝stencil==0(外側)を暗く塗り→内側stencilは後始末
			gl.colorMask(true, true, true, true);
			gl.useProgram(coverProg);
			gl.uniform4f(loc(gl, coverProg, "u_fill"), o.fillColor[0], o.fillColor[1], o.fillColor[2], o.fillColor[3]);
			if (o.mask) {
				gl.stencilFunc(gl.EQUAL, 0, 0xFF); gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);   // 外側(stencil==0)を暗く
				gl.bindVertexArray(emptyVAO); gl.drawArrays(gl.TRIANGLES, 0, 3);
				gl.clearStencil(0); gl.clear(gl.STENCIL_BUFFER_BIT);   // 内側stencilを後始末（次スロット/gintのため）
			} else {
				gl.stencilFunc(gl.NOTEQUAL, 0, 0xFF); gl.stencilOp(gl.KEEP, gl.KEEP, gl.ZERO);   // 内側(stencil≠0)を塗り0へ
				gl.bindVertexArray(emptyVAO); gl.drawArrays(gl.TRIANGLES, 0, 3);
			}
			gl.disable(gl.STENCIL_TEST);
		}
		// 線（境界線 or N02 の鉄道線）
		if (o.lineVao) {
			setCommonUniforms(lineProg, st, o.origin, land);
			gl.uniform1f(loc(gl, lineProg, "u_lift"), OVERLAY_LIFT_M);   // 地形から浮かせて z-fight を断つ（境界線が明滅・消失する件の根治）
			gl.uniform1f(loc(gl, lineProg, "u_dpr"), dpr);
			gl.bindVertexArray(o.lineVao); gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, o.lineCount);
		}
	}
	function drawOverlay(st, dpr, land, zoom) {
		if (view.showN02 !== false) for (const o of n02) { if (zoom >= o.minZoom) drawOne(o, st, dpr, land); }   // N02 交通（新幹線/駅）＝基図の上・identify overlay の下
		drawOne(overlay, st, dpr, land); drawOne(overlayHi, st, dpr, land); drawOne(overlayHover, st, dpr, land);   // ホバー境界は最前面
	}
	// 海面下の陸地（wdepr）＝stencil は drawOne と同一・cover だけ WDEPR_FS（landK=1 強制のハイプソ本体）。
	// フラット色でなく画素単位で標高ランプ×気候×hillshade を計算＝ポリゴンは「ここは海でなく陸」の粗い印
	// （海→海面下→陸の描画順・2026-09-01 本人設計）。呼び出しは draw() の globe/terrain 後・タイル(湖)前。
	function drawWdepr(st, land, whK) {
		const o = wdepr;
		if (!o || !o.fanCount) return;
		gl.enable(gl.STENCIL_TEST);
		gl.clearStencil(0); gl.clear(gl.STENCIL_BUFFER_BIT);
		gl.colorMask(false, false, false, false);
		gl.stencilMask(0xFF); gl.stencilFunc(gl.ALWAYS, 0, 0xFF);
		gl.stencilOpSeparate(gl.FRONT, gl.KEEP, gl.KEEP, gl.INCR_WRAP);
		gl.stencilOpSeparate(gl.BACK, gl.KEEP, gl.KEEP, gl.DECR_WRAP);
		setCommonUniforms(stencilProg, st, o.origin, land);
		gl.uniform1f(loc(gl, stencilProg, "u_lift"), OVERLAY_LIFT_M);
		gl.uniform1f(loc(gl, stencilProg, "u_sphereClip"), 1);   // 跨ぎ feature の裏側頂点を地平円へクランプ（可視部だけを囲む）
		gl.bindVertexArray(o.fanVao);
		// 球体カリング二段構え：①完全裏側 feature は CPU でレンジごと描かない（対蹠点付近は VS クランプが
		// リング一周巻き＝全面+1 化する実測 2026-09-02＝クランプだけでは守れない）②地平線跨ぎは VS クランプ。
		// 可視判定＝中心方向と視線の角 − 角半径 < 地平角 ⇔ dot(C,Ê) > cos(hor+rad)（cos加法・全て事前計算値）。
		if (o.feats) {
			const E = st.eye, eLen = Math.hypot(E[0], E[1], E[2]) || 1;
			const cosH = Math.min(1, 1 / eLen), sinH = Math.sqrt(Math.max(0, 1 - cosH * cosH));
			const ex = E[0] / eLen, ey = E[1] / eLen, ez = E[2] / eLen;
			let run0 = -1, runN = 0;
			for (const f of o.feats) {
				const vis = f.C[0] * ex + f.C[1] * ey + f.C[2] * ez > f.cosR * cosH - f.sinR * sinH;
				if (vis && run0 >= 0 && f.start === run0 + runN) { runN += f.count; continue; }   // 連続レンジは結合
				if (runN) gl.drawArrays(gl.TRIANGLES, run0, runN);
				run0 = vis ? f.start : -1; runN = vis ? f.count : 0;
			}
			if (runN) gl.drawArrays(gl.TRIANGLES, run0, runN);
		} else gl.drawArrays(gl.TRIANGLES, 0, o.fanCount);
		gl.uniform1f(loc(gl, stencilProg, "u_sphereClip"), 0);   // 共有プログラム＝通常 overlay（局所ポリゴン）へ持ち越さない
		gl.colorMask(true, true, true, true);
		gl.useProgram(wdCoverProg);
		gl.uniformMatrix4fv(loc(gl, wdCoverProg, "u_invMvp"), false, Float32Array.from(st.invMvp));
		const atmo = view.atmo || [0.45, 0.62, 0.95, 0.6];   // draw() の既定と同値＝globe と同じ紙/大気で厳密同色
		gl.uniform4f(loc(gl, wdCoverProg, "u_land"), land[0], land[1], land[2], land[3]);
		gl.uniform4f(loc(gl, wdCoverProg, "u_atmo"), atmo[0], atmo[1], atmo[2], atmo[3]);
		gl.uniform1i(loc(gl, wdCoverProg, "u_elevTex"), 1);   // unit1＝直前に elevTex を必ずバインド済み（globe パスと同じ轍対策の共通バインド）
		gl.uniform4f(loc(gl, wdCoverProg, "u_elevBounds"), elev.bounds[0], elev.bounds[1], elev.bounds[2], elev.bounds[3]);
		gl.uniform1f(loc(gl, wdCoverProg, "u_ell"), ellipsoidOn() ? 1 : 0);
		gl.uniform1f(loc(gl, wdCoverProg, "u_whK"), whK);
		bindClim(wdCoverProg);   // 気候場 unit12（未着は u_hasClim=0＝緯度近似フォールバック・globe と同じ）
		bindWorldPal(wdCoverProg);   // globe と同一フレーム・同一パレット＝縫い目の色 bit 一致
		gl.uniform3f(loc(gl, wdCoverProg, "u_whDeep"), ...worldPal().belowSea);
		// 球体カリングは VS の地平円クランプ（u_sphereClip）が担う＝裏側ポリゴンは円周に縮退（巻き数0）・
		// 地平線跨ぎは可視部だけを囲む。旧・ref=±1 方式は「跨ぎポリゴンの投影折返し」が円盤内に作る
		// ±1 斑を殺しきれなかった（GL/WebGPU で符号逆＝GL だけ幻影が残った実測 2026-09-02）。
		gl.stencilFunc(gl.NOTEQUAL, 0, 0xFF); gl.stencilOp(gl.KEEP, gl.KEEP, gl.ZERO);   // 内側を塗り 0 へ後始末
		gl.bindVertexArray(emptyVAO); gl.drawArrays(gl.TRIANGLES, 0, 3);
		gl.clearStencil(0); gl.clear(gl.STENCIL_BUFFER_BIT);   // 地平円上の縮退スライバー残渣を掃除（後段 overlay/gint を汚さない）
		gl.disable(gl.STENCIL_TEST);
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
		// 楕円体＝緯度側は β（更成緯度）の三角＝deltaToRel は純球面式のまま（球＝β=φ＝従来値）。
		const lr = origin[0] * Math.PI / 180, br = betaOf(origin[1]) * Math.PI / 180;
		gl.uniform4f(loc(gl, prog, "u_originTrig"), Math.cos(lr), Math.sin(lr), Math.cos(br), Math.sin(br));
		// 楕円体 dβ 錨（原点の測地緯度の 2φ/4φ 三角・CPU double）＋変位方向ゲート。球＝全0＝シェーダ補正が厳密0
		const _ell = ellipsoidOn(), _pr = origin[1] * Math.PI / 180;
		gl.uniform4f(loc(gl, prog, "u_ellTrig"), ...(_ell ? [Math.cos(2 * _pr), Math.sin(2 * _pr), Math.cos(4 * _pr), Math.sin(4 * _pr)] : [0, 0, 0, 0]));
		gl.uniform1f(loc(gl, prog, "u_ell"), _ell ? 1 : 0);
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
		gl.uniform1i(loc(gl, prog, "u_farElevTex"), 8);   // 遠景層（unit8＝PLATEAUマスク2-5/md線6/gint7と不干渉）
		gl.uniform4f(loc(gl, prog, "u_farBounds"), far.bounds[0], far.bounds[1], far.bounds[2], far.bounds[3]);
		gl.uniform1f(loc(gl, prog, "u_hasFar"), far.has);
		gl.uniform1f(loc(gl, prog, "u_farEdgeFade"), far.edgeFade || 0);
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
		// 全球ハイプソの出現度（globe パスと terrain パスが共有＝ピッチで色が変わらない）。z5.7→6.5 でフェードアウト
		// ＝R90 全球窓の限界（z6.5 でアトラスがビュー窓へ切替）に着地し、そこで基図（BASEMAP_MINZOOM=6.5）と交代
		const worldHypsoK = view.worldHypso && elev.has ? Math.max(0, Math.min(1, (6.5 - cam.zoom) / 0.8)) : 0;
		const flat2d = (cam.pitch || 0) < 0.02 && cam.zoom >= 9;
		const c = flat2d ? [land[0], land[1], land[2], 1] : (view.clear || [1, 1, 1, 1]);
		gl.clearColor(c[0] * c[3], c[1] * c[3], c[2] * c[3], c[3]);
		gl.clear(gl.COLOR_BUFFER_BIT);
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
		gl.disable(gl.DEPTH_TEST);
		gl.clear(gl.DEPTH_BUFFER_BIT);

		// 星空劇場（z<5）：globe より先に描く＝陸には上書きされ・大気ハローは星の上に薄く重なり・宇宙には星が残る。
		// 深度無関係の背景（VSが clip.z=0 固定）。天球の向きは恒星時(GMST)＝実時刻の空。versor回転にもそのまま追随。
		const worldFade = !flat2d && cam.zoom < 5 ? Math.min(1, (5 - cam.zoom) / 0.5) : 0;   // 星空劇場（星・夜面）共通の出現フェード
		const starFade = (stars || constel || planets) ? worldFade : 0;
		if (starFade > 0) {
			const gmst = (((18.697374 + 24.0657098 * (Date.now() / 864e5 + 2440587.5 - 2451545.0)) * 15) % 360) * Math.PI / 180;
			const cg = Math.cos(gmst), sg = Math.sin(gmst);
			// 遠近表現（v1移植）：天球倍率 ∝ (0.4+0.3z)＝ズームに線形（地球は2^z）。z4（フェード境界）で1に正規化
			// ＝出現時のスケールが素の投影と連続（ポップしない）。ズームアウトで星空が密に寄る＝空が「遠くなる」。
			// z1 の硬クランプ（max）は天球スケールの変化が z1 で急停止＝太陽系圏の出入りで星の動きが不連続に
			// 見えた（本人指摘 2026-09-02「上手に繋げて」）→ softplus の軟クランプ＝C∞接続：z≫1 は従来の線形・
			// z≪1 は z1 相当へ漸近凍結（無限遠の星空はズームアウトで縮まない・負zの係数反転も防ぐ＝旧仕様を保存）。
			const zx = cam.zoom - 1, zs = 1 + (zx > 0 ? zx + 0.25 * Math.log(1 + Math.exp(-zx / 0.25)) : 0.25 * Math.log(1 + Math.exp(zx / 0.25)));   // 数値安定形 softplus（幅0.25z）
			const skyK = (0.4 + 0.3 * zs) / 1.6;
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
				// view.skySolar（太陽系圏 z<1・l=sky 点灯時）：黄道/天の赤道は消灯（「地球から見た空」の注記＝
				// 実位置3Dの太陽系と矛盾）・星座線は減光（本人裁定 2026-09-02「少し薄くした方が見栄えがいい」）
				const dimC = view.skySolar ? 0.55 : 1;
				const lines = [   // [バッファ, 色（定数attrib＝VAO外の文脈状態）]
					[constel, [0.47, 0.63, 1.0, 0.4 * dimC]],   // 星座線＝v1と同じ青（rgba(120,160,255)）
					[view.skySolar ? null : ecliptic, [1.0, 0.8, 0.45, 0.35]],   // 黄道＝淡い黄（太陽・月・惑星の通り道）
					[view.skySolar ? null : celeq, [1.0, 0.55, 0.5, 0.32]],      // 天の赤道＝淡い紅（地球の赤道の空への投影）
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
			// 全球ハイプソ（view.worldHypso＝テーマ/アプリのknob）：z5.5 まで全開→z6.3 で消灯。
			// 終端 6.3＝R90 全球窓の終わり（z6.5 でアトラスがビュー窓へ切替＝窓の外の陸が「標高0＝海」に化ける）
			// より手前。地形面（TERRAIN_FS u_whK）と同じ係数＝チルトでも色が連続。
			// ⚠サンプラは K=0 でも毎フレーム unit1 へ向ける：未設定だと既定 unit0＝同居 gint の整数テクスチャを
			// float sampler が掴み、globe ドロー全体が GL_INVALID_OPERATION で死ぬ（＝海が宇宙の黒に抜ける。
			// 下方の共通バインドと同じ轍。z>5.2 で実際に被弾 2026-08-30）。unit1 は elevTex か null（incomplete=黒で無害）。
			gl.uniform1f(loc(gl, globeProg, "u_whK"), worldHypsoK);
			gl.uniform1i(loc(gl, globeProg, "u_elevTex"), 1);
			gl.uniform1i(loc(gl, globeProg, "u_climTex"), 12);   // 気候場サンプラも常時 unit12（K=0でも。unit0整数テクスチャの轍）
			gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, (elev.has && elevTex) ? elevTex : null); gl.activeTexture(gl.TEXTURE0);
			if (worldHypsoK > 0) {
				gl.uniform4f(loc(gl, globeProg, "u_elevBounds"), elev.bounds[0], elev.bounds[1], elev.bounds[2], elev.bounds[3]);
				gl.uniform1f(loc(gl, globeProg, "u_hasElev"), 1);
				gl.uniform1f(loc(gl, globeProg, "u_ell"), ellipsoidOn() ? 1 : 0);
				const sc = worldPal().sea;   // 正準パレット（worldpal.js 既定＝NE流の淡青・knobで差し替え可）
				gl.uniform3f(loc(gl, globeProg, "u_seaC"), sc[0], sc[1], sc[2]);
				bindWorldPal(globeProg);
				ensureClimTex(view.worldHypso.clim);   // 気候場（cross-blend）＝初回だけ取得。未着は緯度近似
				bindClim(globeProg);
			}
			gl.bindVertexArray(emptyVAO);
			gl.drawArrays(gl.TRIANGLES, 0, 3);
		}

		// 標高テクスチャをユニット1へ（全プログラムが elev() で参照）。標高なしでも必ず「null を」バインド＝
		// 同居する gint が unit1 に RGBA32UI（metaTex/ptMetaTex＝整数）を残すため、条件付きバインドだと
		// 標高未着/noTerrain のフレームで float sampler(u_elevTex) が整数テクスチャを掴み、全ドローが
		// GL_INVALID_OPERATION「Mismatch between texture format and sampler type」を吐く（実機GPUログで確認）。
		// null＝incomplete texture は黒を返すだけでエラーにならない（u_hasElev=0 ガードで値は不使用）。
		gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, (elev.has && elevTex) ? elevTex : null);
		gl.activeTexture(gl.TEXTURE8); gl.bindTexture(gl.TEXTURE_2D, (far.has && farTex) ? farTex : null);   // 遠景層（null＝incomplete=黒。u_hasFar=0 ガードで不使用）
		gl.activeTexture(gl.TEXTURE0);
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
		// 水面リフト(+30m)は DSM 帯（R10 混成があり得る z<14）限定＝DTM の都市帯で川を 30m 浮かせない。
		// 都市帯の基図接地リフト(+5m)：深度テスト×DTM起伏で、線/塗りのドレープ（頂点毎バイリニア）と
		// 地形メッシュ（72m級格子）の近似差から道路が地形面を出入りしてギザギザになる（札幌 z16.9 実測）
		// のを上へ逃がす。山岳帯(z<14)は 0＝従来の見た目。根治は RTT ドレープ（基図を地形に貼る）＝将来課題。
		// z14切替はランプ化（z13.5→14 の0.5幅で連続モーフ）＝keepFine保持のズームアウトで露出した段差ポップ対策。
		// 両端値は実測チューニングのまま＝z≥14とz≤13.5の絵は従来と完全一致。gpu/renderer.js と同式。
		const cityK = terrainDepth ? Math.max(0, Math.min(1, (cam.zoom - 13.5) / 0.5)) : 0;
		const cityLift = 5 * cityK;
		const waterLiftM = terrainDepth ? WATER_LIFT_M + (CITY_WATER_LIFT_M - WATER_LIFT_M) * cityK : CITY_WATER_LIFT_M;
		// 3D（チルト）では建物フットプリント塗りを伏せる：押し出し建物と二重表現になり、起伏＋接地リフト下では
		// 「浮いた濃い平板」として露出する（札幌 z16.9 実測・本人指摘「3Dならフットプリント不要では」）。
		// 真俯瞰(2D)では従来どおり描く＝平面地図の建物表現はフットプリントが本体。閾値は show3d と同じ。
		const hideBldFill = bldFill.li >= 0 && (cam.pitch || 0) >= 0.02;
		// 標高パイプライン計器（?perf=1 時・2秒毎）：「高度が消える」系の切り分け用＝どの因子が0かを1行で。
		if (self.__perfElev && performance.now() - (self.__perfElevT || 0) > 2000) {
			self.__perfElevT = performance.now();
			console.log('[elev] z=%s pitch=%s scale=%s pf=%s eff=%s has=%s mesh=%s active=%s depth=%s bounds=%s far=%s farBounds=%s',
				cam.zoom.toFixed(2), ((cam.pitch || 0) * 180 / Math.PI).toFixed(0),
				elev.scale?.toExponential?.(2), pf.toFixed(2), elevScaleEff?.toExponential?.(2),
				elev.has, !!terrain, terrainActive, terrainDepth, elev.bounds?.map(v => +v.toFixed(2)).join(','),
				far.has, far.bounds?.map(v => +v.toFixed(2)).join(','));
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
			gl.uniform1f(loc(gl, terrainProg, "u_whK"), worldHypsoK);   // 全球ハイプソ（低ズーム帯）＝globe パスと同色
			if (worldHypsoK > 0) { ensureClimTex(view.worldHypso.clim); bindClim(terrainProg); bindWorldPal(terrainProg); }
			else { gl.uniform1i(loc(gl, terrainProg, "u_climTex"), 12); gl.uniform1f(loc(gl, terrainProg, "u_hasClim"), 0); }   // サンプラは常時unit12へ（未設定=unit0整数テクスチャの轍）
			const mh = terrain.mesh;   // 窓の原点/幅＝単位格子メッシュを実座標へ伸ばす（メッシュ自体は使い回し）
			gl.uniform1f(loc(gl, terrainProg, "u_farPass"), 0);
			gl.uniform4f(loc(gl, terrainProg, "u_mesh"), mh[0], mh[1], mh[2], mh[3]);
			gl.bindVertexArray(terrain.vao);
			gl.drawElements(gl.TRIANGLES, terrain.count, gl.UNSIGNED_INT, 0);
			if (far.has && farTex) {
				// 遠景メッシュ＝同じ単位格子を遠窓へ2度目のドロー（FS が近窓の内側を discard＝二重描画なし）。
				// 近を先に描く＝遠の被り分は深度で早期棄却。頂点コストは近と同額＝チルト×深ズーム時のみ発生。
				gl.uniform1f(loc(gl, terrainProg, "u_farPass"), 1);
				gl.uniform4f(loc(gl, terrainProg, "u_mesh"), far.bounds[0], far.bounds[1], far.bounds[2], far.bounds[3]);
				gl.drawElements(gl.TRIANGLES, terrain.count, gl.UNSIGNED_INT, 0);
				gl.uniform1f(loc(gl, terrainProg, "u_farPass"), 0);
			}
			gl.depthMask(true);
			if (terrainDepth) gl.disable(gl.POLYGON_OFFSET_FILL);
		}
		// ベクタ(塗り/線)は常にペインタ順で地形の上に描く＝深度で地形と争わせない。傾き時も平面時も、
		// 陸・海・道路が地形サーフェスと z-fight して揺れる/寸断するのを根絶（地形の起伏は先に深度で解決済）。
		gl.disable(gl.DEPTH_TEST);
		// 海面下の陸地（?world=1・bucket below_sea_land）＝全球ハイプソの一部として「タイル(湖)より先」に敷く。
		// 描画順が精度を代替する設計（2026-09-01 本人指摘）：海側の境界だけ焼きが正確（admin0海岸線でクリップ）なら
		// よく、湖側（死海・カスピ沿岸）は上に乗る湖の塗りが、陸側は cover（landK=1 のハイプソ本体）が外側と同色に
		// 溶けるので広く荒くてよい。フェードは whK 連動＝ハイプソと同時に現れ同時に消える（z≥6.5 は自動不可視）。
		if (wdepr && worldHypsoK > 0) drawWdepr(st, land, worldHypsoK);
		// 等高線：真俯瞰(チルト≈0)でだけ茶の等高線を敷く（3Dが立ち上がる前＝ちょうど入れ替わりでフェード）。ベクタの下＝道路/区界は上に乗る。
		{
			const ps = Math.max(0, Math.min(1, ((cam.pitch || 0) - 0.01) / 0.05));   // pitch 0.01→0.06rad で 3D と入れ替わり
			const zf = 1 - Math.max(0, Math.min(1, (cam.zoom - 17.5) / 1.5));        // z17.5→19 でフェードアウト（DEM過拡大＝ボケ/汚れを出さない）
			const cAlpha = (elev.has && !(opts && opts.noTerrain) && view.showContour === true) ? (1 - ps * ps * (3 - 2 * ps)) * zf : 0;
			if (cAlpha > 0.003 && cam.zoom >= 9) {
				gl.useProgram(contourProg);
				gl.uniformMatrix4fv(loc(gl, contourProg, "u_invMvp"), false, Float32Array.from(st.invMvp));
				gl.uniform1i(loc(gl, contourProg, "u_elevTex"), 1);
				gl.uniform4f(loc(gl, contourProg, "u_elevBounds"), elev.bounds[0], elev.bounds[1], elev.bounds[2], elev.bounds[3]);
				gl.uniform1f(loc(gl, contourProg, "u_hasElev"), elev.has);
				const iv = cam.zoom >= 15 ? 15 : cam.zoom >= 12 ? 30 : 60;   // 寄るほど細かい間隔(m)
				gl.uniform1f(loc(gl, contourProg, "u_ell"), ellipsoidOn() ? 1 : 0);   // レイ交点 β→測地の復元ゲート
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
				gl.uniform1f(loc(gl, md.lineProg, "u_lift"), cityLift);
				gl.uniform1f(loc(gl, md.lineProg, "u_dpr"), cam.dpr || 1);
				gl.uniform1i(loc(gl, md.lineProg, "u_segTex"), 6);
				if (md.lineTex) { gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, md.lineTex); gl.activeTexture(gl.TEXTURE0); }
				let curProgM = null;
				for (const e of scene.md.layers) {
					if (e.kind === "fill") {
						const seaFBM = seaFbReal(e.li) != null;   // 図郭外フォールバック水域（標高ゲート付き全面WA）
						if ((seaFBM || e.li === sea.li || e.li === sea.li2) && cam.zoom < sea.minzoom) continue;   // 海：ビュー一律ゲート（classicと同じ。フォールバックも紙の海に従う）
						if (hideBldFill && e.li === bldFill.li) continue;   // 3D時＝フットプリント塗りを伏せる（押し出しに委ねる）
						// 水面：全帯で深度テスト維持＝尾根遮蔽（深度免除は「尾根の向こうの湖が山腹に透ける」＝
						// 山中湖バグの復活＝富士 z13 で実測・撤回済み）。DSM帯(z<13)=+30m（ノイズ瘤・偽島対策）、
						// 都市帯(z≥13)=+10m（DTM の河道彫り込み・中州へ疎頂点の水ポリが潜る豊平川対策。5m では不足）。
						if (curProgM !== md.fillProg) { gl.useProgram(md.fillProg); gl.bindVertexArray(md.fillVAO); curProgM = md.fillProg; }
						const waterM = e.li === sea.li || e.li === sea.li2;
						gl.uniform1f(loc(gl, md.fillProg, "u_seaGate"), seaFBM ? 1 : 0);
						gl.uniform1f(loc(gl, md.fillProg, "u_lift"), waterM ? waterLiftM : cityLift);
						gl.uniform1f(loc(gl, md.fillProg, "u_exactDepth"), (terrainDepth && (waterM || seaFBM)) ? 1 : 0);   // 湖級の巨大水ポリ＝頂点補間対数深度の誤差で偽島（FSで厳密化）
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
			gl.uniform1f(loc(gl, lineProg, "u_lift"), cityLift);
			let curProg = null;
			for (const d of scene.draws) {
				if (d.kind === "fill") {
					const seaFBC = seaFbReal(d.li) != null;   // 図郭外フォールバック水域（標高ゲート付き全面WA）
					if ((seaFBC || d.li === sea.li || d.li === sea.li2) && cam.zoom < sea.minzoom) continue;   // 海：ビュー一律ゲート（詳細以外は描かない＝紙の海）。li2=水系点火面
					if (hideBldFill && d.li === bldFill.li) continue;   // 3D時＝フットプリント塗りを伏せる（押し出しに委ねる）
					// 水面は「+30mリフトして深度テスト復帰」：旧・免除（後書き）はチルトで尾根の遮蔽が効かず、
					// 稜線の向こうの湖が山腹に透けた（山中湖で顕在化）。リフトが DSM の水面ノイズ瘤(±10m級)を
					// 沈め「湖の偽の島」（琵琶湖）も防ぐ＝両立。数百m級の尾根には引き続き隠される。
					if (curProg !== fillProg) { gl.useProgram(fillProg); curProg = fillProg; }
					// 水面リフト＝md 経路と同判断（深度は全帯維持・DSM帯30m/都市帯10m）
					const waterC = d.li === sea.li || d.li === sea.li2;
					gl.uniform1f(loc(gl, fillProg, "u_seaGate"), seaFBC ? 1 : 0);
					gl.uniform1f(loc(gl, fillProg, "u_lift"), waterC ? waterLiftM : cityLift);
					gl.uniform1f(loc(gl, fillProg, "u_exactDepth"), (terrainDepth && (waterC || seaFBC)) ? 1 : 0);   // 湖級の巨大水ポリ＝頂点補間対数深度の誤差で偽島（FSで厳密化）
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
		// 10度レチクル（view.graticule・v1「地図の上に Canvas2D で重ねる」と同じ最前面・ラベルの下）：
		// z1.7→2.2 で出現（v1 borders minZoom2）・z6.0→6.5 で退場（基図=日本帯へ委ねる）。白の細線＝v1と同じ。
		if (view.graticule && !flat2d) {
			const gratA = Math.max(0, Math.min(1, ((cam.zoom || 0) - 1.7) / 0.5)) * Math.max(0, Math.min(1, (6.5 - (cam.zoom || 0)) / 0.5)) * 0.5;
			if (gratA > 0.003) {
				gl.useProgram(gratProg);
				gl.uniformMatrix4fv(loc(gl, gratProg, "u_invMvp"), false, Float32Array.from(st.invMvp));
				gl.uniform1f(loc(gl, gratProg, "u_ell"), ellipsoidOn() ? 1 : 0);
				gl.uniform1f(loc(gl, gratProg, "u_alpha"), gratA);
				gl.uniform4f(loc(gl, gratProg, "u_gratC"), ...worldPal().grat);   // テーマのレチクル色（既定=白）
				gl.bindVertexArray(emptyVAO); gl.drawArrays(gl.TRIANGLES, 0, 3);
			}
		}
		gl.enable(gl.DEPTH_TEST);   // 建物は常に深度で前後関係を解決（地形・尾根に遮蔽される）

		// 建物（3D押し出し）：深度で前後関係を解決（地形・尾根にも遮蔽される）。
		// PLATEAU の区bbox 内だけ基図建物を伏せる（u_plateauBboxN）＝同一体積の全面 z-fight を断ちつつ、範囲外の建物は残す。
		// マスクは区単位（plateauMasks）＝最大 MAX_PLATEAU_MASKS 区まで（シェーダのスロット数固定）。
		// 真俯瞰（チルト≈0）では基図/PLATEAU とも建物3Dを描かない＝平面地図（閾値は flat2d と同じ 0.02rad≈1.1°）。
		const show3d = (cam.pitch || 0) >= 0.02;
		// 建物マスク bit7(0x80)＝面ドレープの深度統合（2026-08-14・WebGPU dsWriteBld と同義）：建物の見えている画素に
		// stencil bit7 を刻む→gint の cover/idResolve が「建物の陰」を画素単位でスキップ。毎フレーム bit7 だけ先に掃除
		//（前フレームの残骸＝カメラ移動で建物が動いた分の staleを断つ）。winding(0x7F) は gint 側が自前 clear＝不干渉。
		gl.stencilMask(0x80);
		gl.clearStencil(0);
		gl.clear(gl.STENCIL_BUFFER_BIT);
		const bldStencil = on => {   // on＝建物ドロー中だけ REPLACE で bit7 を刻む（gintBld の線/点は対象外）
			if (on) { gl.enable(gl.STENCIL_TEST); gl.stencilFunc(gl.ALWAYS, 0x80, 0xFF); gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE); gl.stencilMask(0x80); }
			else { gl.disable(gl.STENCIL_TEST); gl.stencilMask(0xFF); }
		};
		const mdBld = scenes.main.md && scenes.main.md.bld;   // multi_draw シーンの建物＝プールレンジ列（チャンク配列）
		const bld = show3d && !(opts && opts.skipMain) && !(opts && opts.noBld) ? (scenes.main.bld || mdBld) : null;   // 建物はmainシーンの一部＝一緒に退場。noBld=?nobld=1診断ノブ（二重壁の切り分け）
		if (bld) {
			bldStencil(true);
			const prog = scenes.main.bld ? bldProg : md.bldProg;
			const c = view.bldColor || [0.86, 0.86, 0.85];
			setCommonUniforms(prog, st, scenes.main.origin, land);
			gl.uniform3f(loc(gl, prog, "u_bldColor"), c[0], c[1], c[2]);
			// 可視優先の4枠選抜（2026-08-04）：旧・読み込み順slice(0,4)は、全保持化(2026-08-03)でマスクが何区も
			// 溜まると「今見ている区が枠に入らない」→基図建物が伏せられずPLATEAU壁と数十cm差の深度戦い＝
			// pan/zoom中だけ壁面が瞬く（対数深度係数が毎フレーム再配分・大きいビルは基図押し出しが低いぶん
			// 下部だけ・本人実機で特定）。カメラ→区bbox距離の昇順＝画面の区が必ず枠を取る（内包=距離0・
			// 同率はsort安定性でMap挿入順のまま＝フレーム間で選抜が揺れない）。
			const mcx = cam.center[0], mcy = cam.center[1], mcw = Math.cos(mcy * Math.PI / 180);
			const mdist = m => { const bb = m.bbox; const dx = Math.max(bb[0] - mcx, 0, mcx - bb[2]) * mcw, dy = Math.max(bb[1] - mcy, 0, mcy - bb[3]); return dx * dx + dy * dy; };
			const active = [...plateauMasks.entries()].filter(([w]) => !plateauHidden.has(w)).map(([, m]) => m)
				.sort((a, b) => mdist(a) - mdist(b)).slice(0, MAX_PLATEAU_MASKS);   // 非表示区のマスクはスロットに載せない＝基図建物が戻る
			gl.uniform1i(loc(gl, prog, "u_plateauCount"), active.length);
			const mo = scenes.main.origin || [0, 0];
			for (let i = 0; i < MAX_PLATEAU_MASKS; i++) {
				// スロットは (off, inv)＝FS の uv = off + rel×inv。off=(origin−bboxMin)/span を JS の f64 で前計算＝
				// FS は原点相対の小値だけ扱う（絶対経緯度 varying の f32 ジッタ＝深ズームの点描ゴースト根治）。空きは uv 圏外。
				const m = active[i], bb = m && m.bbox;
				const sx = bb ? bb[2] - bb[0] : 1, sy = bb ? bb[3] - bb[1] : 1;
				gl.uniform4f(loc(gl, prog, `u_plateauBbox${i}`), bb ? (mo[0] - bb[0]) / sx : 2e9, bb ? (mo[1] - bb[1]) / sy : 2e9, bb ? 1 / sx : 0, bb ? 1 / sy : 0);
				// 空きスロットも「null を」バインド＝unit2..5 は gint（pivotTex/idTex/fidStyle＝RGBA32UI整数）と共用。
				// 残留整数テクスチャを float sampler(u_plateauMask) が掴むと sampler型不整合で draw 全滅（unit1 と同病）。
				gl.activeTexture(gl.TEXTURE2 + i); gl.bindTexture(gl.TEXTURE_2D, m ? m.tex : null); gl.activeTexture(gl.TEXTURE0);
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
			bldStencil(false);   // gintBld（筆ドレープ線/点）は建物でない＝bit7 を刻まない
		}
		// gint ユーザー層（moj筆/ドロップ図形）の地形沿い境界線：各頂点が自分の標高に乗る（anchor=自分）＝辺が地形に沿う。
		// ★常時描画（show3d ゲートなし）＝平面との連続性：高さ=elev×elevScaleEff で、真俯瞰(elevScaleEff=0)は海面の平面、
		//   チルトで滑らかに地形へ立ち上がる（同じ線が elevScale でモーフ＝ポップしない）。独自 origin・深度で地形/尾根に遮蔽。
		// fillなし＝GL_LINES。PLATEAUマスク不要(count0)。
		if (gintBld) {
			setCommonUniforms(bldProg, st, gintBld.origin, land);
			gl.uniform1i(loc(gl, bldProg, "u_plateauCount"), 0);
			for (let i = 0; i < MAX_PLATEAU_MASKS; i++) {   // 空きスロットも null バインド＝残留整数texをfloat samplerが掴む事故を防ぐ（main bld と同病対策）
				gl.uniform4f(loc(gl, bldProg, `u_plateauBbox${i}`), 1e9, 1e9, -1e9, -1e9);
				gl.activeTexture(gl.TEXTURE2 + i); gl.bindTexture(gl.TEXTURE_2D, null); gl.activeTexture(gl.TEXTURE0);
				gl.uniform1i(loc(gl, bldProg, `u_plateauMask${i}`), 2 + i);
			}
			for (const bt of gintBld.batches) {
				const c = bt.color || view.bldColor || [0.86, 0.86, 0.85];
				gl.uniform3f(loc(gl, bldProg, "u_bldColor"), c[0], c[1], c[2]);
				if (bt.lineCount) { gl.bindVertexArray(bt.lineVAO); gl.drawArrays(gl.LINES, 0, bt.lineCount); }
				if (bt.pointCount) { gl.bindVertexArray(bt.pointVAO); gl.drawArrays(gl.POINTS, 0, bt.pointCount); }
			}
		}
		// PLATEAU LOD2 建物メッシュ（任意三角形・面法線陰影）。深度で地形・自身の前後を解決。
		// ※巻き順が不揃いなデータなので back-face カリングは使わない（屋根を誤って捨てる）＝両面描画。
		//   z-fight の元＝重複面は worker 側の頂点3つ組 dedup で断つ。
		// バッチ単位でフラスタムカリング＝区全体(数百万tris)のうち画面に掛かるバッチだけ頂点処理へ流す。
		if (plateaux.size && show3d) {
			bldStencil(true);   // PLATEAU も建物＝bit7 を刻む
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
				const lb = elev.liftBounds;   // DTM保証域（無ければ全0＝リフトなし）
				gl.uniform4f(loc(gl, plateauProg, "u_liftBounds"), lb ? lb[0] : 0, lb ? lb[1] : 0, lb ? lb[2] : 0, lb ? lb[3] : 0);
				gl.uniform3f(loc(gl, plateauProg, "u_bldColor"), c[0], c[1], c[2]);
				gl.uniform1f(loc(gl, plateauProg, "u_cullBack"), p.two ? 0 : 1);   // 橋梁＝両面（開いた薄面が裏から消えない）
				gl.uniform3f(loc(gl, plateauProg, "u_meshOrigin"), p.origin[0], p.origin[1], p.origin[2]);  // RTE 錨（頂点は重心相対 delta）
				const cM = mat.transform(st.mvp, [p.origin[0], p.origin[1], p.origin[2], 1]);   // clip錨を CPU(double) で（旧: シェーダ float32 で mvp*meshOrigin＝相殺）
				gl.uniform4f(loc(gl, plateauProg, "u_clipMesh"), cM[0], cM[1], cM[2], cM[3]);
				gl.bindVertexArray(p.vao);
				gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_INT, 0);
			}
			bldStencil(false);
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
	function dispose() { disposeSlot("base"); disposeSlot("main"); disposeOverlay(overlay); disposeOverlay(overlayHi); disposeOverlay(overlayHover); disposeOverlay(wdepr); for (const o of n02) disposeOverlay(o); setGintBld(null); }

	// 汎用 set(cmd, data, prop)：ortho-map createLayers の set プロトコルに整合。将来 worker では
	// postMessage({ type:"set", cmd, data, prop }, transferables) にそのまま載る。prop は cmd ごとに融通。
	function set(cmd, data, prop) {
		switch (cmd) {
			case "view":      setView(data); break;                                            // data={clear,land,atmo,bldColor}
			case "sea":       sea = { ...sea, ...data }; break;                                  // data={li, minzoom} 海の点火ゲート
			case "bldFill":   bldFill = { ...bldFill, ...data }; break;                          // data={li} 建物フットプリント塗り（3D時に伏せる）
			case "gintBld":   setGintBld(data); break;                                          // data={origin,walls,roof,color} gintユーザー層の3D押し出し（null=解放）
			case "scene":     setScene(data, prop); break;                                      // prop=slot("base"|"main")
			case "mdGrow":    mdGrow(data.pool, data.units); break;                            // multi_draw: プール成長（GPU内コピー）
			case "mdUp":      mdUpload(data); break;                                           // multi_draw: タイルブロック転送
			case "mdScene":   mdScene(data); break;                                            // multi_draw: draw list 差し替え（転送ゼロ）
			case "overlay":   setOverlay(data, prop); break;                                    // prop=fillColor(任意)
			case "overlayHi": setOverlayHi(data, prop); break;
			case "overlayHover": setOverlayHover(data); break;
			case "n02":       setN02(data); break;                                               // data=[シーン…] 交通の常駐オーバーレイ群
			case "wdepr":     disposeOverlay(wdepr); wdepr = data ? buildOverlaySlot(data, [0, 0, 0, 0]) : null; break;   // 海面下の陸地（?world=1）＝タイル前に描く塗り専用シーン（色は drawWdepr の cover が画素単位で計算＝fill 不使用）
			case "elevAtlas": setElevationAtlas(data, prop); break;                             // prop=scale
			case "elevCell":  setElevationCell(prop.cx, prop.cy, data, prop.cellRes); break;    // data=セルFloat32
			case "elevAtlasStage": setElevationAtlasStage(data, prop); break;                   // 舞台裏アトラス（ダブルバッファ）
			case "elevCellStage": setElevationCellStage(prop.cx, prop.cy, data, prop.cellRes); break;
			case "elevAtlasCommit": commitElevationStage(); break;                              // 揃ったら一括スワップ＝山影が消えない
			case "elevAtlasFar": setElevationAtlasFar(data); break;                             // 遠景層（R10 第2アトラス）
			case "elevCellFar": setElevationCellFar(prop.cx, prop.cy, data, prop.cellRes); break;
			case "elevAtlasFarOff": clearElevationFar(); break;                                 // 深ズーム離脱＝GPUメモリ返却
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
	// ?mem=1 台帳のGPU固定常駐（自前確保分の概算バイト）。msaa=0＝canvas antialias:true はブラウザ暗黙確保（HUD 注記）
	const memEstimate = () => ({ atlas: memAtlas + memStage + memFar, mesh: memMesh, msaa: 0 });
	return { gl, set, draw, dispose, md: !!md, mdMax: MD_MAX_DRAWS, gintCtx: () => gintCtx, memEstimate };
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
