// WebGL2 レンダラ：可視タイルを跨いで同一 style層を1バッファに結合した「シーン」を描く。
// draw call は「タイル数×層数」から「層数」へ激減し、uniform も1フレーム1回。共通のシーン原点で投影。
// fill = earcut三角形、line = capsule(SDF)。scene.layers は style層順（painter's algorithm）。
import { FILL_VS, FILL_FS, LINE_VS, LINE_FS, GLOBE_VS, GLOBE_FS, BUILDING_VS, BUILDING_FS, TERRAIN_VS, TERRAIN_FS, STENCIL_VS, STENCIL_FS, COVER_FS, PLATEAU_VS, PLATEAU_FS, CONTOUR_FS } from "./glsl.js";
import { cameraState, project } from "../camera.js";

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
	const contourProg = program(gl, GLOBE_VS, CONTOUR_FS);     // 等高線（真俯瞰でだけ茶の等高線を敷く）
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
	const MAX_PLATEAU_MASKS = 4;
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
			return;
		}
		const old = plateaux.get(key);
		if (old) { gl.deleteVertexArray(old.vao); for (const b of old.bufs) gl.deleteBuffer(b); plateaux.delete(key); }
		if (!data.pos?.length || !data.idx?.length) return;
		const vao = gl.createVertexArray(), vbo = buffer(gl, data.pos), nbo = buffer(gl, data.nrm), ibo = gl.createBuffer();
		gl.bindVertexArray(vao);
		attrib(gl, plateauProg, "a_pos", vbo, 3);
		attrib(gl, plateauProg, "a_normal", nbo, 3);
		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
		gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data.idx, gl.STATIC_DRAW);
		gl.bindVertexArray(null);
		const o = data.origin || [0, 0, 0];
		plateaux.set(key, { vao, bufs: [vbo, nbo, ibo], count: data.idx.length, origin: o, bbox: data.bbox || [1e9, 1e9, -1e9, -1e9] });
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
			attrib(gl, lineProg, "a_color", bCol, 4, 1);
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
		// ここから深度あり（建物同士の前後関係を共有）
		gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
		// 地形サーフェス（標高変位＋hillshade）。真俯瞰(pf≈0)では描かない＝平面地図。
		// 深度は書かない＝背景扱い：ALOS AW3D30 は DSM(地表面)でビル天端を含む＝都市では地形サーフェスが
		// 「屋根の高さのテント」になり、深度を書くとその下の建物(基図/PLATEAU)を z14〜16帯で丸ごと飲み込む
		// （z16+は cityFlat が平らにするので露見しない）。塗り・線が既にペインタ順で地形の上な設計（半透明の山）
		// に建物も合わせ、地形深度との衝突を根絶する。地形自身は凸地形の重なりが稀に透けるが設計内の割り切り。
		// 山岳ビュー(z<13)だけ地形が深度を書く＝凸地形の自遮蔽（富士の"頂上抜け"対策）＋基図・建物も尾根の向こうは隠れる。
		// 都市帯(z>=13)は従来通り深度を書かない：ALOS DSM はビル天端を含み、深度を書くと建物を飲む（既知のテント問題）。
		// polygonOffset で地形をわずかに奥へ＝ドレープした基図(同じ対数深度)が z-fight せず表に出る。
		const terrainDepth = terrainActive && cam.zoom < 13;
		if (terrainActive) {
			gl.depthMask(terrainDepth);
			if (terrainDepth) { gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(1.0, 4.0); }
			setCommonUniforms(terrainProg, st, [0, 0], land);
			// 地形だけフォグを「遠山ブルー」に：空気遠近法＝遠くの山は青く霞む。地平線の山並みが
			// 説明不要で"山"として読める（基図の線/塗りは従来どおり紙色へフェードアウト＝浮かない）。
			// 距離も地形だけ半分に詰める＝中景の山並み（80-150km）にしっかり青が乗る。
			// 距離は camDist 比例に「実距離の下限＝視程」を併用：ズームを寄せても 50km 手前から
			// 165km（快晴の山岳視程）までは霞み切らない＝八ヶ岳から中央・北アルプスが青い山並みとして残る。
			const dc = view.distColor || [0.63, 0.72, 0.83];
			gl.uniform3f(loc(gl, terrainProg, "u_fogColor"), dc[0], dc[1], dc[2]);
			gl.uniform1f(loc(gl, terrainProg, "u_fogNear"), Math.max(st.camDist * 1.2, 0.008));
			gl.uniform1f(loc(gl, terrainProg, "u_fogFar"), Math.max(st.camDist * 5.0, 0.026));
			gl.uniform3f(loc(gl, terrainProg, "u_land"), land[0], land[1], land[2]);
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
		const slots = (opts && opts.skipBase) ? ["main"] : ["base", "main"];   // 静止時は下地を隠しLOD痕を消す
		// 線・塗りのフォグ終端は地形と同一式＝地形が完全に霞んだ先に線だけ生き残って「空に浮く白線」に
		// なるのを構造的に防ぐ。シェーダの遠景平ら化(df)も u_fogFar 基準なので、同値なら線は地形に厳密追随する。
		const fogFarCap = Math.max(st.camDist * 5.0, 0.026);
		for (const slot of slots) {   // 粗い下書き→現ズームの順
			const scene = scenes[slot];
			if (!scene.draws.length) continue;
			setCommonUniforms(fillProg, st, scene.origin, land);
			setCommonUniforms(lineProg, st, scene.origin, land);
			gl.useProgram(fillProg); gl.uniform1f(loc(gl, fillProg, "u_fogFar"), fogFarCap);
			gl.useProgram(lineProg); gl.uniform1f(loc(gl, lineProg, "u_fogFar"), fogFarCap);
			let curProg = null;
			for (const d of scene.draws) {
				if (d.kind === "fill") {
					if ((d.li === sea.li || d.li === sea.li2) && cam.zoom < sea.minzoom) continue;   // 海：ビュー一律ゲート（詳細以外は描かない＝紙の海）。li2=水系点火面
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
		if (terrainDepth) { gl.disable(gl.DEPTH_TEST); gl.depthMask(true); }   // 基図の深度テストを解除（overlayは従来通り最前面）
		// overlay（外部ベクタ=geopbf/e-Stat）：stencil-then-cover で塗り（earcut不要・扇なし）＋境界線。深度off・最前面。
		drawOverlay(st, cam.dpr || 1, land, cam.zoom || 0);
		gl.enable(gl.DEPTH_TEST);   // 建物は常に深度で前後関係を解決（地形・尾根に遮蔽される）

		// 建物（3D押し出し）：深度で前後関係を解決（地形・尾根にも遮蔽される）。
		// PLATEAU の区bbox 内だけ基図建物を伏せる（u_plateauBboxN）＝同一体積の全面 z-fight を断ちつつ、範囲外の建物は残す。
		// マスクは区単位（plateauMasks）＝最大 MAX_PLATEAU_MASKS 区まで（シェーダのスロット数固定）。
		// 真俯瞰（チルト≈0）では基図/PLATEAU とも建物3Dを描かない＝平面地図（閾値は flat2d と同じ 0.02rad≈1.1°）。
		const show3d = (cam.pitch || 0) >= 0.02;
		const bld = show3d ? scenes.main.bld : null;
		if (bld) {
			const c = view.bldColor || [0.86, 0.86, 0.85];
			setCommonUniforms(bldProg, st, scenes.main.origin, land);
			gl.uniform3f(loc(gl, bldProg, "u_bldColor"), c[0], c[1], c[2]);
			const active = [...plateauMasks.values()].slice(0, MAX_PLATEAU_MASKS);
			gl.uniform1i(loc(gl, bldProg, "u_plateauCount"), active.length);
			for (let i = 0; i < MAX_PLATEAU_MASKS; i++) {
				const m = active[i], pb = m ? m.bbox : [1e9, 1e9, -1e9, -1e9];
				gl.uniform4f(loc(gl, bldProg, `u_plateauBbox${i}`), pb[0], pb[1], pb[2], pb[3]);
				if (m) { gl.activeTexture(gl.TEXTURE2 + i); gl.bindTexture(gl.TEXTURE_2D, m.tex); gl.activeTexture(gl.TEXTURE0); }
				gl.uniform1i(loc(gl, bldProg, `u_plateauMask${i}`), 2 + i);
			}
			gl.bindVertexArray(bld.vao);
			gl.drawArrays(gl.TRIANGLES, 0, bld.count);
		}
		// PLATEAU LOD2 建物メッシュ（任意三角形・面法線陰影）。深度で地形・自身の前後を解決。
		// ※巻き順が不揃いなデータなので back-face カリングは使わない（屋根を誤って捨てる）＝両面描画。
		//   z-fight の元＝重複面は worker 側の頂点3つ組 dedup で断つ。
		// バッチ単位でフラスタムカリング＝区全体(数百万tris)のうち画面に掛かるバッチだけ頂点処理へ流す。
		if (plateaux.size && show3d) {
			gl.useProgram(plateauProg);
			const c = view.bldColor || [0.86, 0.86, 0.85];   // 基図の押し出し建物と同色＝周辺と地続きに見せる
			const pad = 0.5 * Math.max(st.W, st.H);          // 高層ビルの頭のはみ出し余白（半画面）
			for (const p of plateaux.values()) {
				if (!plateauBboxVisible(st, p.bbox, cam.center, pad)) continue;
				setCommonUniforms(plateauProg, st, [0, 0], land);
				gl.uniform3f(loc(gl, plateauProg, "u_bldColor"), c[0], c[1], c[2]);
				gl.uniform3f(loc(gl, plateauProg, "u_meshOrigin"), p.origin[0], p.origin[1], p.origin[2]);  // RTE 錨（頂点は重心相対 delta）
				gl.bindVertexArray(p.vao);
				gl.drawElements(gl.TRIANGLES, p.count, gl.UNSIGNED_INT, 0);
			}
		}
		gl.disable(gl.DEPTH_TEST);
		gl.bindVertexArray(null);
	}

	function disposeSlot(slot) {
		for (const d of scenes[slot].draws) { for (const b of d.bufs) gl.deleteBuffer(b); gl.deleteVertexArray(d.vao); }
		if (scenes[slot].bld) { for (const b of scenes[slot].bld.bufs) gl.deleteBuffer(b); gl.deleteVertexArray(scenes[slot].bld.vao); }
		scenes[slot] = { origin: scenes[slot].origin, draws: [], bld: null };
	}
	function dispose() { disposeSlot("base"); disposeSlot("main"); disposeOverlay(overlay); disposeOverlay(overlayHi); for (const o of n02) disposeOverlay(o); }

	// 汎用 set(cmd, data, prop)：ortho-map createLayers の set プロトコルに整合。将来 worker では
	// postMessage({ type:"set", cmd, data, prop }, transferables) にそのまま載る。prop は cmd ごとに融通。
	function set(cmd, data, prop) {
		switch (cmd) {
			case "view":      setView(data); break;                                            // data={clear,land,atmo,bldColor}
			case "sea":       sea = { ...sea, ...data }; break;                                  // data={li, minzoom} 海の点火ゲート
			case "scene":     setScene(data, prop); break;                                      // prop=slot("base"|"main")
			case "overlay":   setOverlay(data, prop); break;                                    // prop=fillColor(任意)
			case "overlayHi": setOverlayHi(data, prop); break;
			case "n02":       setN02(data); break;                                               // data=[シーン…] 交通の常駐オーバーレイ群
			case "elevAtlas": setElevationAtlas(data, prop); break;                             // prop=scale
			case "elevCell":  setElevationCell(prop.cx, prop.cy, data, prop.cellRes); break;    // data=セルFloat32
			case "plateauMesh": setPlateauMesh(prop, data); break;                             // prop=地区名(key)、data={pos,idx} PLATEAU LOD2 建物（null=解放）
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
