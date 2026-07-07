// WebGL2 レンダラ：可視タイルを跨いで同一 style層を1バッファに結合した「シーン」を描く。
// draw call は「タイル数×層数」から「層数」へ激減し、uniform も1フレーム1回。共通のシーン原点で投影。
// fill = earcut三角形、line = capsule(SDF)。scene.layers は style層順（painter's algorithm）。
import { FILL_VS, FILL_FS, LINE_VS, LINE_FS, GLOBE_VS, GLOBE_FS, BUILDING_VS, BUILDING_FS, TERRAIN_VS, TERRAIN_FS, STENCIL_VS, STENCIL_FS, COVER_FS, PLATEAU_VS, PLATEAU_FS } from "./glsl.js";
import { cameraState } from "../camera.js";

const CORNERS = new Float32Array([0, -1, 0, 1, 1, -1, 1, -1, 0, 1, 1, 1]); // 6頂点×(end,side)

export function createRenderer(canvas) {
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
	const cornerBuf = buffer(gl, CORNERS);
	const emptyVAO = gl.createVertexArray();
	gl.getExtension("OES_texture_float_linear");   // R32F の線形補間
	// 標高（GEBCO/ALOS）：テクスチャ＋地形格子メッシュ
	let elevTex = null, elev = { bounds: [0, 0, 1, 0], scale: 0, has: 0 }, terrain = null;
	let plateau = null;   // PLATEAU LOD2 建物メッシュ { vao, bufs, count, origin, bbox }（頂点は重心相対 delta）
	let plateauMaskTex = null;   // PLATEAU 被覆マスク（TEXTURE2）：基図建物をこのセルだけ伏せる
	// 静的 view（色・見た目）：初期化時に一度 setView でアップロード。draw は毎フレーム幾何(cam)だけ受け、
	// 色は view から読む＝描画パラメータを「幾何(動的)」と「見た目(静的)」に分離。将来の worker payload 境界。
	let view = { clear: null, land: null, atmo: null, bldColor: null };
	function setView(v) { view = { ...view, ...v }; }
	// 海：水レイヤ(li)を cam.zoom で一律にゲート＝ビュー単位で描く/描かない（タイル毎の presence まだらを排す）。
	// cam.zoom < minzoom では水を描かない＝海は球の基色(紙)のまま。以上で一律の色を点火。
	let sea = { li: -1, minzoom: Infinity };
	let elevScaleEff = 0;   // pitchで変調した実効スケール（真俯瞰では0＝平面）
	// base=粗い下書き（underlay）、main=現ズーム、overlay=外部ベクタ(geopbf等)を最前面に。
	const scenes = {
		base: { origin: [0, 0], draws: [], bld: null },
		main: { origin: [0, 0], draws: [], bld: null },
		overlay: { origin: [0, 0], draws: [], bld: null },
	};

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
				attrib(gl, fillProg, "a_color", bCol, 4);
				gl.bindVertexArray(null);
				draws.push({ kind: "fill", li: L.li, vao, count: L.pos.length / 2, bufs: [bPos, bCol] });
			} else {
				if (!L.half.length) continue;
				const vao = gl.createVertexArray();
				const bP1 = buffer(gl, L.P1), bP2 = buffer(gl, L.P2), bCol = buffer(gl, L.col), bHalf = buffer(gl, L.half);
				gl.bindVertexArray(vao);
				attrib(gl, lineProg, "a_corner", cornerBuf, 2, 0);
				attrib(gl, lineProg, "a_p1", bP1, 2, 1);
				attrib(gl, lineProg, "a_p2", bP2, 2, 1);
				attrib(gl, lineProg, "a_color", bCol, 4, 1);
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
		elev = { bounds: [a.originLng, a.originLat, a.cellsX * span, a.cellsY * span], scale, exag: a.exag || 1, has: 1 };
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

	// PLATEAU LOD2 建物メッシュを受ける。data={ pos:Float32Array(xyz…), idx:Uint32Array }（頂点は ortho 単位球座標へ変換済み）。
	function setPlateauMesh(data) {
		if (plateau) { gl.deleteVertexArray(plateau.vao); for (const b of plateau.bufs) gl.deleteBuffer(b); plateau = null; }
		if (!data || !data.pos?.length || !data.idx?.length) return;
		const vao = gl.createVertexArray(), vbo = buffer(gl, data.pos), nbo = buffer(gl, data.nrm), ibo = gl.createBuffer();
		gl.bindVertexArray(vao);
		attrib(gl, plateauProg, "a_pos", vbo, 3);
		attrib(gl, plateauProg, "a_normal", nbo, 3);
		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
		gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data.idx, gl.STATIC_DRAW);
		gl.bindVertexArray(null);
		const o = data.origin || [0, 0, 0];
		plateau = { vao, bufs: [vbo, nbo, ibo], count: data.idx.length, origin: o, bbox: data.bbox || [1e9, 1e9, -1e9, -1e9] };
		// 被覆マスクを TEXTURE2 用に（NEAREST・CLAMP）。基図建物 FS が uv=bbox正規化で参照。
		if (!plateauMaskTex) plateauMaskTex = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, plateauMaskTex);
		gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
		const mn = data.maskN | 0;
		if (data.mask && mn > 0) gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, mn, mn, 0, gl.RED, gl.UNSIGNED_BYTE, data.mask);
		else gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([0]));
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	}

	// --- overlay（外部ベクタ=geopbf/e-Stat）：stencil-then-cover 塗り＋境界線 ---
	let overlay = null, overlayHi = null;
	function buildOverlaySlot(s, fillColor) {
		if (!s || !s.fanPos.length) return null;
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
			attrib(gl, lineProg, "a_color", bCol, 4, 1);
			attrib(gl, lineProg, "a_half", bHalf, 1, 1);
			gl.bindVertexArray(null);
			lineCount = s.lineHalf.length; bufs.push(bP1, bP2, bCol, bHalf);
		}
		return { fanVao, fanCount: s.fanPos.length / 2, lineVao, lineCount, origin: s.origin, fillColor, bufs };
	}
	function disposeOverlay(o) { if (o) { for (const b of o.bufs) gl.deleteBuffer(b); gl.deleteVertexArray(o.fanVao); if (o.lineVao) gl.deleteVertexArray(o.lineVao); } }
	function setOverlay(s, fillColor) { disposeOverlay(overlay); overlay = s ? buildOverlaySlot(s, fillColor || [0.20, 0.45, 0.85, 0.32]) : null; }
	function setOverlayHi(s, fillColor) { disposeOverlay(overlayHi); overlayHi = s ? buildOverlaySlot(s, fillColor || [0.95, 0.55, 0.15, 0.6]) : null; }
	function drawOne(o, st, dpr, land) {
		if (!o || !o.fanCount) return;
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
		// 境界線
		if (o.lineVao) {
			setCommonUniforms(lineProg, st, o.origin, land);
			gl.uniform1f(loc(gl, lineProg, "u_dpr"), dpr);
			gl.bindVertexArray(o.lineVao); gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, o.lineCount);
		}
	}
	function drawOverlay(st, dpr, land) { drawOne(overlay, st, dpr, land); drawOne(overlayHi, st, dpr, land); }

	function setCommonUniforms(prog, st, origin, fog) {
		gl.useProgram(prog);
		gl.uniformMatrix4fv(loc(gl, prog, "u_mvp"), false, st.mvp32);
		gl.uniform3f(loc(gl, prog, "u_eye"), st.eye[0], st.eye[1], st.eye[2]);
		gl.uniform2f(loc(gl, prog, "u_origin"), origin[0], origin[1]);
		gl.uniform2f(loc(gl, prog, "u_viewport"), canvas.width, canvas.height);
		gl.uniform1f(loc(gl, prog, "u_fogNear"), st.camDist * 2.5);
		gl.uniform1f(loc(gl, prog, "u_fogFar"), st.camDist * 14.0);
		gl.uniform3f(loc(gl, prog, "u_fogColor"), fog[0], fog[1], fog[2]);
		// 対数深度係数（cameraState と同じ far＝地平線 limb×1.15+camDist）。球+局所(建物)の z-fight 対策。
		const _limb = Math.sqrt(Math.max((1 + st.camDist) * (1 + st.camDist) - 1, 1e-12));
		gl.uniform1f(loc(gl, prog, "u_logCoef"), 2.0 / Math.log2(_limb * 1.15 + st.camDist + 1.0));
		gl.uniform1i(loc(gl, prog, "u_elevTex"), 1);
		gl.uniform4f(loc(gl, prog, "u_elevBounds"), elev.bounds[0], elev.bounds[1], elev.bounds[2], elev.bounds[3]);
		gl.uniform1f(loc(gl, prog, "u_elevScale"), elevScaleEff);
		gl.uniform1f(loc(gl, prog, "u_hasElev"), elev.has);
	}

	function draw(cam, opts) {
		gl.viewport(0, 0, canvas.width, canvas.height);
		const st = cameraState(cam, canvas.width, canvas.height);
		st.mvp32 = Float32Array.from(st.mvp);
		// 真俯瞰では標高オフ、傾けるほどフェードイン（3.4°→11.5°）
		const pt = Math.max(0, Math.min(1, ((cam.pitch || 0) - 0.06) / 0.14));
		const pf = pt * pt * (3 - 2 * pt);
		// ズーム taper：都市ズームでは地形を平らにする。ALOS AW3D30 は DSM(地表面)でビル/樹木を含むため、
		// 都市の"起伏"は実はビル天端＝ベクタ建物と二重になる。都市では地形を平らにし、3Dはベクタ建物に任せる。
		// 山(中ズーム)は誇張フルのまま。地形・建物・塗りは同じu_elevScaleを共有＝平らにすれば足並みも揃う。
		const cityFlat = Math.max(0, Math.min(1, (cam.zoom - 13.5) / 2.5));   // z13.5:誇張フル → z16:平ら
		elevScaleEff = elev.scale * pf * (1 - cityFlat);
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
		// ここから深度あり（地形→ベクタ→建物が前後関係を共有）
		gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
		// 地形サーフェス（標高変位＋hillshade）。真俯瞰(pf≈0)では描かない＝平面地図。
		if (terrainActive) {
			setCommonUniforms(terrainProg, st, [0, 0], land);
			gl.uniform3f(loc(gl, terrainProg, "u_land"), land[0], land[1], land[2]);
			gl.bindVertexArray(terrain.vao);
			gl.drawElements(gl.TRIANGLES, terrain.count, gl.UNSIGNED_INT, 0);
		}
		// ベクタ(塗り/線)は常にペインタ順で地形の上に描く＝深度で地形と争わせない。傾き時も平面時も、
		// 陸・海・道路が地形サーフェスと z-fight して揺れる/寸断するのを根絶（地形の起伏は先に深度で解決済）。
		gl.disable(gl.DEPTH_TEST);
		gl.useProgram(lineProg); gl.uniform1f(loc(gl, lineProg, "u_dpr"), cam.dpr || 1);

		const slots = (opts && opts.skipBase) ? ["main"] : ["base", "main"];   // 静止時は下地を隠しLOD痕を消す
		for (const slot of slots) {   // 粗い下書き→現ズームの順
			const scene = scenes[slot];
			if (!scene.draws.length) continue;
			setCommonUniforms(fillProg, st, scene.origin, land);
			setCommonUniforms(lineProg, st, scene.origin, land);
			let curProg = null;
			for (const d of scene.draws) {
				if (d.kind === "fill") {
					if (d.li === sea.li && cam.zoom < sea.minzoom) continue;   // 海：ビュー一律ゲート（詳細以外は描かない＝紙の海）
					if (curProg !== fillProg) { gl.useProgram(fillProg); curProg = fillProg; }
					gl.bindVertexArray(d.vao);
					gl.drawArrays(gl.TRIANGLES, 0, d.count);
				} else {
					if (curProg !== lineProg) { gl.useProgram(lineProg); curProg = lineProg; }
					gl.bindVertexArray(d.vao);
					gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, d.count);
				}
			}
		}
		// overlay（外部ベクタ=geopbf/e-Stat）：stencil-then-cover で塗り（earcut不要・扇なし）＋境界線。深度off・最前面。
		drawOverlay(st, cam.dpr || 1, land);
		gl.enable(gl.DEPTH_TEST);   // 建物は常に深度で前後関係を解決（地形・尾根に遮蔽される）

		// 建物（3D押し出し）：深度で前後関係を解決（地形・尾根にも遮蔽される）。
		// PLATEAU の bbox 内だけ基図建物を伏せる（u_plateauBbox）＝同一体積の全面 z-fight を断ちつつ、範囲外の建物は残す。
		const bld = scenes.main.bld;
		if (bld) {
			const c = view.bldColor || [0.86, 0.86, 0.85];
			setCommonUniforms(bldProg, st, scenes.main.origin, land);
			gl.uniform3f(loc(gl, bldProg, "u_bldColor"), c[0], c[1], c[2]);
			const pb = plateau ? plateau.bbox : [1e9, 1e9, -1e9, -1e9];   // PLATEAU 被覆セルの基図建物を伏せる（範囲外はそのまま）
			gl.uniform4f(loc(gl, bldProg, "u_plateauBbox"), pb[0], pb[1], pb[2], pb[3]);
			if (plateauMaskTex) { gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, plateauMaskTex); gl.activeTexture(gl.TEXTURE0); }
			gl.uniform1i(loc(gl, bldProg, "u_plateauMask"), 2);
			gl.bindVertexArray(bld.vao);
			gl.drawArrays(gl.TRIANGLES, 0, bld.count);
		}
		// PLATEAU LOD2 建物メッシュ（任意三角形・面法線陰影）。深度で地形・自身の前後を解決。
		// ※巻き順が不揃いなデータなので back-face カリングは使わない（屋根を誤って捨てる）＝両面描画。
		//   z-fight の元＝重複面は main 側の頂点3つ組 dedup で断つ。
		if (plateau) {
			setCommonUniforms(plateauProg, st, [0, 0], land);
			const c = view.bldColor || [0.86, 0.86, 0.85];   // 基図の押し出し建物と同色＝周辺と地続きに見せる
			gl.uniform3f(loc(gl, plateauProg, "u_bldColor"), c[0], c[1], c[2]);
			gl.uniform3f(loc(gl, plateauProg, "u_meshOrigin"), plateau.origin[0], plateau.origin[1], plateau.origin[2]);  // RTE 錨（頂点は重心相対 delta）
			gl.bindVertexArray(plateau.vao);
			gl.drawElements(gl.TRIANGLES, plateau.count, gl.UNSIGNED_INT, 0);
		}
		gl.disable(gl.DEPTH_TEST);
		gl.bindVertexArray(null);
	}

	function disposeSlot(slot) {
		for (const d of scenes[slot].draws) { for (const b of d.bufs) gl.deleteBuffer(b); gl.deleteVertexArray(d.vao); }
		if (scenes[slot].bld) { for (const b of scenes[slot].bld.bufs) gl.deleteBuffer(b); gl.deleteVertexArray(scenes[slot].bld.vao); }
		scenes[slot] = { origin: scenes[slot].origin, draws: [], bld: null };
	}
	function dispose() { disposeSlot("base"); disposeSlot("main"); disposeOverlay(overlay); disposeOverlay(overlayHi); }

	// 汎用 set(cmd, data, prop)：ortho-map createLayers の set プロトコルに整合。将来 worker では
	// postMessage({ type:"set", cmd, data, prop }, transferables) にそのまま載る。prop は cmd ごとに融通。
	function set(cmd, data, prop) {
		switch (cmd) {
			case "view":      setView(data); break;                                            // data={clear,land,atmo,bldColor}
			case "sea":       sea = { ...sea, ...data }; break;                                  // data={li, minzoom} 海の点火ゲート
			case "scene":     setScene(data, prop); break;                                      // prop=slot("base"|"main")
			case "overlay":   setOverlay(data, prop); break;                                    // prop=fillColor(任意)
			case "overlayHi": setOverlayHi(data, prop); break;
			case "elevAtlas": setElevationAtlas(data, prop); break;                             // prop=scale
			case "elevCell":  setElevationCell(prop.cx, prop.cy, data, prop.cellRes); break;    // data=セルFloat32
			case "plateauMesh": setPlateauMesh(data); break;                                   // data={pos,idx} PLATEAU LOD2 建物
			default: console.warn("renderer.set: unknown cmd", cmd);
		}
	}
	return { gl, set, draw, dispose };
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
function attrib(gl, prog, name, buf, size, divisor) {
	const l = gl.getAttribLocation(prog, name);
	if (l < 0) return;
	gl.bindBuffer(gl.ARRAY_BUFFER, buf);
	gl.enableVertexAttribArray(l);
	gl.vertexAttribPointer(l, size, gl.FLOAT, false, 0, 0);
	if (divisor != null) gl.vertexAttribDivisor(l, divisor);
}
