// WebGL2 border line renderer — fat lines + dash, no picking, no hover, no FBO.
// 複数スタイルのレイヤーを arcTex/metaTex ペアごとに保持し、1フレームで順次描画。

import { createGintPrograms } from './shared/gintPrograms.js';
import { buildEdgeMeta, bindSharedUniforms, uploadTex2D } from './shared/gintUtility.js';

const TEX_W = 4096;

let gl = null, canvas = null, dpr = 1, width = 0, height = 0;
let programs = null;
let layers = [];   // [{ arcTex, metaTex, totalEdges, styleTable, dashTable, lineWidth }]
let minZoom = null, maxZoom = null;

const funcs = { init, set, resize, drawing, drawn: () => {}, destroy };
onmessage = e => (funcs[e.data.type] ?? (() => {}))(e.data);

// ── init ─────────────────────────────────────────────────────────────────────
function init(data) {
	canvas = data.offscreen; dpr = data.dpr;
	gl = canvas.getContext("webgl2", { antialias: false, alpha: true, premultipliedAlpha: false });
	if (!gl) { postMessage({ action: "done", type: "init", ctx: null }); return; }
	programs = createGintPrograms(gl);
	gl.enable(gl.BLEND);
	gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
	postMessage({ action: "done", type: "init", ctx: gl.constructor.name });
}

// ── set ───────────────────────────────────────────────────────────────────────
// data.data.gintDataList : unPackGint オブジェクト配列（メインスレッドでgint済み）
// data.data.styles       : [{ color:[r,g,b,a], lineWidth, dash:[dashLen,period] }, ...]
function set(data) {
	if (data.cmd !== "gint") { postMessage({ action: "done", type: "set" }); return; }

	// 既存テクスチャを破棄
	layers.forEach(({ arcTex, metaTex }) => {
		arcTex  && gl.deleteTexture(arcTex);
		metaTex && gl.deleteTexture(metaTex);
	});
	layers = [];
	const payload = data.data ?? {};
	minZoom = payload.minZoom ?? 2;
	maxZoom = payload.maxZoom ?? 7;

	const styles       = payload.styles       ?? [];
	const gintDataList = payload.gintDataList ?? [];

	for (let i = 0; i < gintDataList.length; i++) {
		const gintData = gintDataList[i];
		const style    = styles[i] ?? {};
		if (!gintData) continue;
		try {
			const { arcBuffer, arcMeta, polyStream, lineStream } = gintData;
			const layer = buildLayer(arcBuffer, arcMeta, polyStream, lineStream, style);
			if (layer.totalEdges > 0) layers.push(layer);
		} catch (e) { console.error("[gintBorder] set error:", e); }
	}

	postMessage({ action: "done", type: "set" });
}

function buildLayer(arcBuffer, arcMeta, polyStream, lineStream, style) {
	const am = arcMeta ?? new Uint32Array(0);
	const { metaU32: edgeMeta, edgeCount: totalEdges } = buildEdgeMeta(am, polyStream ?? null, lineStream ?? null);

	let arcTex = null, metaTex = null;
	if (arcBuffer?.length) {
		const arcU32 = new Uint32Array(arcBuffer.buffer, arcBuffer.byteOffset, arcBuffer.byteLength / 4);
		const arcH   = Math.ceil(arcU32.length / 2 / TEX_W) || 1;
		const arcPad = new Uint32Array(TEX_W * arcH * 2); arcPad.set(arcU32);
		arcTex = uploadTex2D(gl, arcPad, TEX_W, arcH, gl.RG32UI, gl.RG_INTEGER);
	}
	if (totalEdges > 0) {
		const metaH  = Math.ceil(totalEdges / TEX_W) || 1;
		const metaPad = new Uint32Array(TEX_W * metaH * 4); metaPad.set(edgeMeta);
		metaTex = uploadTex2D(gl, metaPad, TEX_W, metaH, gl.RGBA32UI, gl.RGBA_INTEGER);
	}

	// style index 0 と 1（polyline）を同じ色にする（256エントリ全部同じでも可だが最小限で）
	const c = style.color ?? [1, 1, 1, 1];
	const styleTable = new Float32Array(256 * 4);
	styleTable.set(c, 0); styleTable.set(c, 4);  // style 0 & 1

	const d = style.dash ?? [0, 0];
	const dashTable = new Float32Array(256 * 2);
	if (d[1] > 0) { dashTable.set(d, 0); dashTable.set(d, 2); }

	return { arcTex, metaTex, totalEdges, styleTable, dashTable, lineWidth: style.lineWidth ?? 1.0 };
}

// ── resize ───────────────────────────────────────────────────────────────────
function resize(data) {
	width = data.width; height = data.height;
	canvas.width  = width  * dpr;
	canvas.height = height * dpr;
	gl.viewport(0, 0, width * dpr, height * dpr);
	postMessage({ action: "done", type: "resize" });
}

// ── drawing ──────────────────────────────────────────────────────────────────
function drawing(data) {
	if (!gl || !programs || layers.length === 0) return;

	const zoom = Math.log2(data.scale / 40.74);
	const effMin = Math.max(minZoom ?? 0,  data.minZoom ?? 0);
	const effMax = Math.min(maxZoom ?? 22, data.maxZoom ?? 22);

	gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	gl.clearColor(0, 0, 0, 0);
	gl.clear(gl.COLOR_BUFFER_BIT);
	if (zoom < effMin || zoom > effMax) return;

	const { renderProgram, uRender, emptyVAO } = programs;
	gl.bindVertexArray(emptyVAO);
	gl.useProgram(renderProgram);
	gl.uniform1i(uRender.u_active_id, -1);
	gl.uniform1i(uRender.u_pass, 0);

	for (const layer of layers) {
		if (!layer.arcTex || layer.totalEdges === 0) continue;
		bindSharedUniforms(gl, uRender, data, layer.arcTex, layer.metaTex, TEX_W, TEX_W, width, height);
		gl.uniform1f(uRender.u_line_width,   layer.lineWidth);
		gl.uniform4fv(uRender.u_style_table, layer.styleTable);
		gl.uniform2fv(uRender.u_dash_table,  layer.dashTable);
		gl.drawArrays(gl.TRIANGLES, 0, layer.totalEdges * 6);
	}
}

// ── destroy ──────────────────────────────────────────────────────────────────
function destroy() {
	layers.forEach(({ arcTex, metaTex }) => {
		arcTex  && gl.deleteTexture(arcTex);
		metaTex && gl.deleteTexture(metaTex);
	});
	layers = [];
	if (programs && gl) {
		const { renderProgram, stencilProgram, fillProgram, maskStencilProgram,
				pointProgram, pickLineProgram, pickPointProgram, emptyVAO } = programs;
		[renderProgram, stencilProgram, fillProgram, maskStencilProgram,
		 pointProgram, pickLineProgram, pickPointProgram].forEach(p => p && gl.deleteProgram(p));
		emptyVAO && gl.deleteVertexArray(emptyVAO);
	}
	programs = null; gl = null;
	postMessage({ action: "done", type: "destroy" });
}
