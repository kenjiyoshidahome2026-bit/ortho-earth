// WebGL2 の描画（renderer.ts）を、呼び出しを書き留める偽の GL で検定する（GPU なし・画は見ない＝GL への渡し方と前提の守り）。
//   ・作成：webgl2 が無い＝null・MAX_TEXTURE_SIZE は 4096 で頭打ち・float ID の拡張が無い機体は陸マスクだけ（警告）・シェーダの失敗は行番号つきで投げる
//   ・uploadVertices＝RG32UI を幅 MAX_TEX で折り返す・setPaint＝幅 1024 で折り返す
//   ・beginFrame＝dpr は 2 で頭打ち・canvas を合わせる・ID バッファは寸法が変わった時だけ作り直す
//   ・drawIds 前の drawLand／drawChoropleth は何もしない・コロプレスは塗り表も hover も無ければ描かない
//   ・u_morph は毎回入れる（既定 1＝平面・GL の既定値 0 は球になる）・readFid＝ID バッファの 1 px（範囲外 -1）
//   ・float ID の無い機体＝drawIds はステンシルへ・readFid は -1・destroy＝WEBGL_lose_context
import { createRenderer } from "../src/renderer.ts";

let fail = 0;
const ok = (name, cond, note = "") => { if (!cond) fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${note ? "  " + note : ""}`); };
const quiet = console.warn; let warned = 0; console.warn = () => { warned++; };
globalThis.window = { devicePixelRatio: 3 };

function fakeGL({ maxTex = 16384, floatId = true, compileOk = true, readId = 0 } = {}) {
	const calls = [], src = new Map(), progs = new Map(), lost = { v: false };
	let n = 0;
	const obj = kind => ({ kind, id: ++n });
	const impl = {
		getParameter: k => k === "MAX_TEXTURE_SIZE" ? maxTex : 0,
		getExtension: name => (!floatId && /EXT_(color_buffer|float_blend)/.test(name)) ? null : name === "WEBGL_lose_context" ? { loseContext: () => { lost.v = true; } } : {},
		createShader: () => obj("shader"), shaderSource: (sh, s) => src.set(sh, s), compileShader() {},
		getShaderParameter: () => compileOk, getShaderInfoLog: () => "ERROR: 0:2: bad",
		createProgram: () => { const p = obj("program"); progs.set(p, []); return p; },
		attachShader: (p, sh) => progs.get(p).push(src.get(sh)), linkProgram() {},
		getProgramParameter: (p, k) => k === "LINK_STATUS" ? true : uniformsOf(p).length,
		getActiveUniform: (p, i) => ({ name: uniformsOf(p)[i] }),
		getUniformLocation: (p, name) => ({ name: name.replace(/\[0\]$/, "") }),
		readPixels: (x, y, w, h, f, t, out) => { out[0] = readId; },
		createTexture: () => obj("tex"), createFramebuffer: () => obj("fbo"), createVertexArray: () => obj("vao"), createBuffer: () => obj("buf"),
	};
	const uniformsOf = p => [...new Set(progs.get(p).flatMap(s => [...s.matchAll(/uniform\s+\w+\s+(\w+)(\[\d+\])?/g)].map(m => m[1] + (m[2] ? "[0]" : ""))))];
	const gl = new Proxy({}, {
		get(t, k) {
			if (typeof k !== "string") return undefined;
			if (/^[A-Z0-9_]+$/.test(k)) return k;   // 定数は名前のまま（記録が読める）
			if (k in impl) return (...a) => { calls.push([k, a]); return impl[k](...a); };
			return (...a) => { calls.push([k, a]); };
		},
	});
	return { gl, calls, lost, since: i => calls.slice(i) };
}
const canvasOf = (G, w = 400, h = 300) => ({ clientWidth: w, clientHeight: h, width: 0, height: 0, getContext: k => k === "webgl2" ? G?.gl ?? null : null });
const uni = (calls, name) => calls.filter(c => /^uniform/.test(c[0]) && c[1][0]?.name === name).map(c => c[1].slice(1));
const view = { lon: 135, lat: 35, zoom: 2 };
const pal = { lowHumid: [0, 1, 0], lowArid: [1, 1, 0], midHumid: [0, .5, 0], midArid: [.5, .5, 0], ramp1: [1, 0, 0], ramp2: [1, .5, 0], peak: [1, 1, 1], snow: [1, 1, 1] };

// ── 作成 ──
ok("webgl2 が取れない＝null", createRenderer(canvasOf(null)) === null);
{
	let err = null; try { createRenderer(canvasOf(fakeGL({ compileOk: false }))); } catch (e) { err = e; }
	ok("シェーダの失敗＝情報と行番号つきの元を投げる", /ERROR: 0:2: bad/.test(err?.message) && /\n1: #version 300 es/.test(err?.message));
}
const G = fakeGL(), cv = canvasOf(G), R = createRenderer(cv);
ok("作成：backend・MAX_TEX は 4096 で頭打ち（maxTex は機体の値）・float ID あり", R.backend === "webgl2" && R.maxTex === 16384 && R.hasFloatId === true && warned === 0);
ok("プログラム 9 本（線・面・ID・被せ・海・合成・コロプレス・点・幕）", G.calls.filter(c => c[0] === "linkProgram").length === 9);

// ── 資源 ──
{
	const i0 = G.calls.length;
	const v = R.uploadVertices(new Uint32Array(10000 * 2), 10000);
	const tex = G.since(i0).find(c => c[0] === "texImage2D");
	ok("uploadVertices：幅 4096 で折り返す（10000 点＝4096×3）・RG32UI", v.w === 4096 && tex[1][3] === 4096 && tex[1][4] === 3 && tex[1][2] === "RG32UI" && tex[1][8].length === 4096 * 3 * 2);
	const one = R.uploadVertices(new Uint32Array(0), 0);
	ok("uploadVertices：0 点でも 1×1", one.w === 1);
	const vao = R.instanceVAO(new Uint32Array(12), 3);
	ok("instanceVAO：count＝要素÷成分・整数属性・divisor 1", vao.count === 4 && G.calls.some(c => c[0] === "vertexAttribIPointer" && c[1][1] === 3) && G.calls.some(c => c[0] === "vertexAttribDivisor" && c[1][1] === 1));
	const j = G.calls.length; R.freeVAO(vao); R.freeVAO(null);
	ok("freeVAO：VAO と buffer を消す・null は何もしない", G.since(j).map(c => c[0]).join() === "deleteVertexArray,deleteBuffer");
	const k = G.calls.length; R.setPaint(new Uint8Array(2000 * 4).fill(7), 2000);
	const pt = G.since(k).find(c => c[0] === "texImage2D");
	ok("setPaint：幅 1024 で折り返す（2000＝1024×2）", pt[1][3] === 1024 && pt[1][4] === 2 && pt[1][8][2000 * 4 - 1] === 7 && pt[1][8][2000 * 4] === 0);
}

// ── フレーム ──
{
	const i0 = G.calls.length;
	R.beginFrame(view, [0.1, 0.2, 0.3]);
	ok("beginFrame：dpr は 2 で頭打ち＝canvas 800×600", cv.width === 800 && cv.height === 600);
	ok("beginFrame：ID バッファ（R32F）を canvas の寸法で作る", G.since(i0).some(c => c[0] === "texImage2D" && c[1][2] === "R32F" && c[1][3] === 800 && c[1][4] === 600));
	const j = G.calls.length; R.beginFrame(view, [0, 0, 0]);
	ok("同じ寸法なら ID バッファは作り直さない", !G.since(j).some(c => c[0] === "createFramebuffer"));
	const k = G.calls.length;
	R.drawLand({ land: [1, 1, 1], hypso: 1, pal });
	R.drawChoropleth({ alpha: 1, hover: 3 });
	ok("drawIds の前の drawLand／drawChoropleth は何もしない", G.since(k).length === 0);
	const vtx = R.uploadVertices(new Uint32Array(8), 4), vao = R.instanceVAO(new Uint32Array(6), 3);
	ok("drawIds：空の VAO は false", R.drawIds(vtx, null) === false && R.drawIds(vtx, { count: 0 }) === false);
	const m = G.calls.length;
	ok("drawIds：ID バッファへ加算で描く", R.drawIds(vtx, vao) === true && G.since(m).some(c => c[0] === "blendFunc" && c[1].join() === "ONE,ONE") && G.since(m).some(c => c[0] === "drawArraysInstanced" && c[1][2] === 18));
	ok("u_morph は既定 1（平面）を毎回入れる", uni(G.since(m), "u_morph").at(-1)?.[0] === 1);
	const l = G.calls.length;
	R.drawLand({ land: [0.9, 0.8, 0.7], hypso: 0.5, pal });
	const L = G.since(l);
	ok("drawLand：陸色・ハイプソ・float ID あり・標高なし・近景なし", same(uni(L, "u_land")[0], [0.9, 0.8, 0.7]) && uni(L, "u_hypsoA")[0][0] === 0.5 && uni(L, "u_hasId")[0][0] === 1 && uni(L, "u_hasElev")[0][0] === 0 && uni(L, "u_hasNear")[0][0] === 0);
	R.setElevation(new Float32Array(8), 4, 2); R.setNearElevation({ data: new Float32Array(4), width: 2, height: 2, bounds: [130, 30, 20, 10] }); R.setClimate({});
	const l2 = G.calls.length; R.drawLand({ land: [1, 1, 1], pal });
	const L2 = G.since(l2);
	ok("drawLand：標高・気候・近景の窓が入る（hypso 省略＝0）", uni(L2, "u_hasElev")[0][0] === 1 && uni(L2, "u_hasClim")[0][0] === 1 && uni(L2, "u_hasNear")[0][0] === 1 && same(uni(L2, "u_nearB")[0], [130, 30, 20, 10]) && uni(L2, "u_hypsoA")[0][0] === 0);
	R.setNearElevation(null);
	const l3 = G.calls.length; R.drawLand({ land: [1, 1, 1], pal });
	ok("setNearElevation(null)＝近景を外す", uni(G.since(l3), "u_hasNear")[0][0] === 0);
	const c1 = G.calls.length; R.drawChoropleth({ alpha: 0.8 });
	const C1 = G.since(c1);
	ok("drawChoropleth：塗りの濃さ・hover なし＝-1・既定のホバー色・塗り表の幅", uni(C1, "u_choroA")[0][0] === 0.8 && uni(C1, "u_hover")[0][0] === -1 && uni(C1, "u_hoverC")[0][0].length === 4 && uni(C1, "u_paintW")[0][0] === 1024);
	const c2 = G.calls.length; R.drawChoropleth({});
	ok("drawChoropleth：濃さ 0・hover なし＝描かない", G.since(c2).length === 0);
	const lines = G.calls.length;
	R.drawLines(vtx, vao, [{ color: [1, 0, 0, 1], width: 2 }, null, { color: [0, 0, 1, 1], size: 5 }]);
	const LS = G.since(lines), col = uni(LS, "u_color")[0][0], prm = uni(LS, "u_param")[0][0];
	ok("drawLines：分類ごとの色と太さ（size も太さ・空きは 0）", col[0] === 1 && col[8 + 2] === 1 && prm[0] === 2 && prm[4] === 0 && prm[8] === 5 && LS.some(c => c[0] === "drawArraysInstanced" && c[1][2] === 12));
	const pts = G.calls.length; R.drawPoints(vao, [{ color: [0, 0, 0, 1], size: 3 }]); R.drawPoints(null, []);
	ok("drawPoints：6 頂点のインスタンス・空は何もしない", G.since(pts).filter(c => c[0] === "drawArraysInstanced").map(c => c[1][2]).join() === "6");
	const f = G.calls.length; R.drawFill(vtx, vao, [0, 0, 1, 1]); R.drawFill(vtx, null, [0, 0, 1, 1]);
	const FS = G.since(f).map(c => c[0]);
	ok("drawFill：ステンシル偶奇（INVERT）→被せ→ステンシルを切る", G.since(f).some(c => c[0] === "stencilOp" && c[1][2] === "INVERT") && FS.at(-1) === "disable" && FS.filter(x => x === "enable").length === 1);
	const s = G.calls.length; R.drawSea([0, 0, 1], [0, 0, 0], [1, 1, 1, 1]); R.drawVeil([0, 0, 0, 0]); R.drawVeil([0, 0, 0, 0.5]);
	ok("drawSea・drawVeil（透明な幕は描かない）", G.since(s).filter(c => c[0] === "drawArrays").length === 2);
	R.beginFrame(view, [0, 0, 0], { t: 2, ppuS: 10, lat: 0.5, cam: 3, dlon: 4 });
	const mo = G.calls.length; R.drawIds(vtx, vao);
	ok("morph：t は 0..1 に挟む・ppuS は dpr 倍・球の中心", uni(G.since(mo), "u_morph")[0][0] === 1 && uni(G.since(mo), "u_ppuS")[0][0] === 20 && uni(G.since(mo), "u_sphLat")[0][0] === 0.5 && uni(G.since(mo), "u_camS")[0][0] === 3 && uni(G.since(mo), "u_sphDlon")[0][0] === 4);
}

// ── 国の識別 ──
{
	const H = fakeGL({ readId: 43 }), cv2 = canvasOf(H, 200, 100), R2 = createRenderer(cv2);
	ok("readFid：フレーム前は -1", R2.readFid(10, 10) === -1);
	R2.beginFrame(view, [0, 0, 0]);
	const r = H.calls.length;
	ok("readFid：ID−1（0 は海＝-1）", R2.readFid(10, 10) === 42);
	const rp = H.since(r).find(c => c[0] === "readPixels");
	ok("readFid：CSS px→実 px・上下を返す（y＝H−1−y·dpr）", rp[1][0] === 20 && rp[1][1] === 200 - 1 - 20);
	ok("readFid：画面の外＝-1", R2.readFid(-1, 0) === -1 && R2.readFid(0, 100) === -1 && R2.readFid(200, 0) === -1);
	cv2.clientWidth = 300; const nf = H.calls.length; R2.beginFrame(view, [0, 0, 0]);
	ok("寸法が変わったら ID バッファを作り直す（古い物を消す）", H.since(nf).some(c => c[0] === "deleteTexture") && H.since(nf).some(c => c[0] === "deleteFramebuffer") && cv2.width === 600);
	R2.destroy();
	ok("destroy＝WEBGL_lose_context", H.lost.v === true);
	const Z = fakeGL({ readId: 0 }), RZ = createRenderer(canvasOf(Z)); RZ.beginFrame(view, [0, 0, 0]);
	ok("readFid：ID 0＝-1", RZ.readFid(1, 1) === -1);
}

// ── float ID の無い機体 ──
{
	warned = 0;
	const N = fakeGL({ floatId: false, maxTex: 2048 }), RN = createRenderer(canvasOf(N));
	ok("float ID なし＝警告して陸マスクだけ", RN.hasFloatId === false && warned === 1);
	const i0 = N.calls.length; RN.beginFrame(view, [0, 0, 0]);
	ok("ID バッファは作らない", !N.since(i0).some(c => c[0] === "createFramebuffer"));
	const vtx = RN.uploadVertices(new Uint32Array(5000 * 2), 5000), vao = RN.instanceVAO(new Uint32Array(3), 3);
	ok("uploadVertices：機体の MAX_TEX（2048）で折り返す", vtx.w === 2048);
	const d = N.calls.length; RN.drawIds(vtx, vao);
	ok("drawIds＝ステンシルへ（FBO は使わない）", N.since(d).some(c => c[0] === "stencilOp" && c[1][2] === "INVERT") && !N.since(d).some(c => c[0] === "bindFramebuffer"));
	const l = N.calls.length; RN.drawLand({ land: [1, 1, 1], pal }); RN.drawChoropleth({ alpha: 1, hover: 2 });
	ok("drawLand は u_hasId 0・コロプレスは描かない・readFid は -1", uni(N.since(l), "u_hasId")[0][0] === 0 && N.since(l).filter(c => c[0] === "drawArrays").length === 1 && RN.readFid(5, 5) === -1);
}

function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
console.warn = quiet;
console.log(fail ? `\n✗ ${fail} 件失敗` : "\n✓ t-renderer 全 PASS");
process.exit(fail ? 1 : 0);
