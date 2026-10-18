// WebGPU の描画（renderer-gpu.ts）を、命令を書き留める偽の GPU で検定する（GPU なし・画は見ない＝命令の組み方と前提の守り）。
//   ・作成：アダプタ無し／デバイス無し／パイプラインの検証エラー／webgpu の context 無し＝null（同じ canvas で WebGL2 へ落ちる）
//   ・float32-blendable の有無（noFloatId でも落とせる）・maxTex は機体の値・頂点テクスチャは 4096 で折り返す
//   ・1 フレーム＝命令を記録して microtask で submit・何も描かなくても背景色で消す・uniform は 1 描画 1 スロット（満杯で途中 submit）
//   ・drawIds 前の drawLand／drawChoropleth は何もしない・ID パスは別パス（r32float へ加算）・float ID 無しはステンシル
//   ・readFid＝ID テクスチャを 1 px 写して読む（ID−1・範囲外 -1）・freeVAO は submit の後で捨てる・device lost／destroy 後は描かない
import { createRendererGPU } from "../src/renderer-gpu.ts";

let fail = 0;
const ok = (name, cond, note = "") => { if (!cond) fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${note ? "  " + note : ""}`); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const tick = () => new Promise(r => setTimeout(r, 0));
const quiet = console.warn; let warned = []; console.warn = (...a) => warned.push(a.join(" "));
globalThis.window = { devicePixelRatio: 1.5 };
globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2 };
globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2, VERTEX: 4, MAP_READ: 8 };
globalThis.GPUTextureUsage = { TEXTURE_BINDING: 1, COPY_DST: 2, RENDER_ATTACHMENT: 4, COPY_SRC: 8 };
globalThis.GPUMapMode = { READ: 1 };

function fakeGPU({ adapter = true, device = true, float = true, scopeErr = null, maxTex = 8192, readId = 0, mapFails = false } = {}) {
	const log = { submits: 0, passes: [], uniforms: [], textures: [], writes: [], destroyed: [], devDestroyed: false, configured: null, pipelines: [] };
	let loseDevice;
	const tex = d => { const t = { ...d, width: d.size[0], height: d.size[1], createView: () => ({ of: t }), destroy: () => log.destroyed.push(t) }; log.textures.push(t); return t; };
	const buf = d => { const b = { ...d, destroy: () => log.destroyed.push(b), mapAsync: async () => { if (mapFails) throw new Error("map"); }, getMappedRange: () => new Float32Array([readId]).buffer, unmap() {} }; return b; };
	const encoder = () => ({
		beginRenderPass(desc) { const p = { desc, cmds: [], ended: false }; log.passes.push(p);
			return { setPipeline: pl => p.cmds.push(["pipe", pl.fs]), setBindGroup: (i, g, off) => p.cmds.push(["bg", i, off?.[0]]), setVertexBuffer: () => p.cmds.push(["vb"]), draw: (n, inst) => p.cmds.push(["draw", n, inst]), setStencilReference: r => p.cmds.push(["ref", r]), end: () => { p.ended = true; } }; },
		copyTextureToBuffer: (src, dst) => { log.copy = { src, dst }; },
		finish: () => ({}),
	});
	const dev = {
		limits: { maxTextureDimension2D: maxTex },
		lost: new Promise(r => { loseDevice = r; }),
		pushErrorScope() {}, popErrorScope: async () => scopeErr,
		createShaderModule: d => d, createBindGroupLayout: d => d, createPipelineLayout: d => d,
		createRenderPipeline: d => { const pl = { fs: d.fragment.entryPoint, target: d.fragment.targets[0].format, samples: d.multisample.count, stencil: d.depthStencil?.stencilFront?.compare ?? null }; log.pipelines.push(pl); return pl; },
		createTexture: tex, createSampler: d => d, createBuffer: buf, createBindGroup: d => d,
		createCommandEncoder: encoder,
		queue: {
			writeBuffer: (b, o, data, so, n) => { if (data instanceof Float32Array && n) log.uniforms.push(data.slice(0, n)); else log.writes.push(["buf", data.byteLength]); },
			writeTexture: (dst, data, layout, size) => log.writes.push(["tex", dst.texture.format, layout.bytesPerRow, size]),
			copyExternalImageToTexture: (src, dst, size) => log.writes.push(["img", size]),
			submit: () => { log.submits++; },
		},
		destroy: () => { log.devDestroyed = true; loseDevice({ reason: "destroyed" }); },
	};
	const ad = { features: new Set(float ? ["float32-blendable"] : []), requestDevice: async d => { log.required = d.requiredFeatures; return device ? dev : Promise.reject(new Error("no")); } };
	Object.defineProperty(globalThis, "navigator", { value: { gpu: adapter ? { requestAdapter: async () => ad, getPreferredCanvasFormat: () => "bgra8unorm" } : undefined }, configurable: true, writable: true });
	const ctx = { configure: c => { log.configured = c; }, unconfigure: () => { log.unconfigured = true; }, getCurrentTexture: () => ({ createView: () => ({ canvas: true }) }) };
	return { log, ctx, lose: info => loseDevice(info) };
}
const canvasOf = (G, w = 400, h = 200, noCtx = false) => ({ clientWidth: w, clientHeight: h, width: 0, height: 0, getContext: k => k === "webgpu" && !noCtx ? G.ctx : null });
// スロット s の uniform（float 単位のオフセット）
const U = (log, s, o, n = 1) => { const all = log.uniforms.at(-1); return n === 1 ? all[s * 256 + o] : [...all.slice(s * 256 + o, s * 256 + o + n)]; };
const O = { vp: 0, vw: 3, ppu: 5, dpr: 7, morph: 8, ppuS: 9, hypsoA: 14, hasElev: 15, hasClim: 16, hasNear: 17, hasId: 18, choroA: 19, hover: 20, paintW: 21, nearB: 24, col: 28, land: 44, hoverC: 48, pal: 52, color: 84, param: 148 };
const view = { lon: 135, lat: 35, zoom: 2 };
const pal = { lowHumid: [0, 1, 0], lowArid: [1, 1, 0], midHumid: [0, .5, 0], midArid: [.5, .5, 0], ramp1: [1, 0, 0], ramp2: [1, .5, 0], peak: [1, 1, 1], snow: [.9, .9, .9] };

// ── 作成の失敗＝null ──
{
	let G = fakeGPU({ adapter: false });
	ok("navigator.gpu 無し＝null", await createRendererGPU(canvasOf(G)) === null);
	G = fakeGPU({ device: false });
	ok("requestDevice 失敗＝null", await createRendererGPU(canvasOf(G)) === null);
	G = fakeGPU({ scopeErr: { message: "bad pipeline" } }); warned = [];
	ok("パイプラインの検証エラー＝null・device を捨てる・context は取らない", await createRendererGPU(canvasOf(G)) === null && G.log.devDestroyed && G.log.configured === null && warned.some(w => /bad pipeline/.test(w)));
	G = fakeGPU();
	ok("webgpu の context が取れない＝null・device を捨てる", await createRendererGPU(canvasOf(G, 1, 1, true)) === null && G.log.devDestroyed);
}

// ── 作成と資源 ──
const G = fakeGPU({ readId: 8 }), cv = canvasOf(G), R = await createRendererGPU(cv);
const L = G.log;
ok("作成：webgpu・float ID・float32-blendable を要求・maxTex は機体の値", R.backend === "webgpu" && R.hasFloatId && same(L.required, ["float32-blendable"]) && R.maxTex === 8192);
ok("context を opaque で設定・パイプライン 11 本（ID は r32float・1 サンプル）", L.configured?.alphaMode === "opaque" && L.pipelines.length === 11 && L.pipelines.some(p => p.fs === "fsId" && p.target === "r32float" && p.samples === 1));
{
	const v = R.uploadVertices(new Uint32Array(5000 * 2), 5000);
	ok("uploadVertices：幅 4096 で折り返す（rg32uint・1 行 8 バイト）", v.w === 4096 && same(L.writes.at(-1), ["tex", "rg32uint", 4096 * 8, [4096, 2]]));
	const vao = R.instanceVAO(new Uint32Array(9), 3), empty = R.instanceVAO(new Uint32Array(0), 3);
	ok("instanceVAO：count＝要素÷成分・空でも 4 バイト確保", vao.count === 3 && empty.count === 0 && empty.buf.size === 4);
	R.freeVAO(empty); R.freeVAO(null);
	ok("freeVAO：記録中でなければすぐ捨てる", L.destroyed.includes(empty.buf));
	R.setPaint(new Uint8Array(3000 * 4), 3000);
	ok("setPaint：幅 1024 で折り返す", same(L.writes.at(-1), ["tex", "rgba8unorm", 4096, [1024, 3]]));
	const n0 = L.textures.length; R.setPaint(new Uint8Array(3000 * 4), 3000);
	ok("setPaint：同じ寸法ならテクスチャを使い回す", L.textures.length === n0);
	R.setElevation(new Float32Array(8), 4, 2);
	ok("setElevation：r16float（f16 へ詰める＝1 行 2 バイト/texel）", same(L.writes.at(-1), ["tex", "r16float", 8, [4, 2]]));
	R.setClimate({ naturalWidth: 720, naturalHeight: 360 });
	ok("setClimate：画像の寸法で写す", same(L.writes.at(-1), ["img", [720, 360]]));
	R.setNearElevation({ data: new Float32Array(4), width: 2, height: 2, bounds: [130, 30, 20, 10] });
	ok("setNearElevation：r16float", same(L.writes.at(-1), ["tex", "r16float", 4, [2, 2]]));
	globalThis.__v = { v, vao };
}

// ── フレーム ──
{
	const { v, vao } = globalThis.__v;
	const s0 = L.submits, p0 = L.passes.length;
	R.drawSea([0, 0, 1], [0, 0, 0], [1, 1, 1, 1]);
	ok("beginFrame の前は描かない", L.passes.length === p0);
	R.beginFrame(view, [0.1, 0.2, 0.3]);
	ok("beginFrame：dpr 1.5＝canvas 600×300・MSAA・ステンシル・ID テクスチャ", cv.width === 600 && cv.height === 300 && L.textures.some(t => t.sampleCount === 4 && t.format === "stencil8" && t.width === 600) && L.textures.some(t => t.format === "r32float" && t.width === 600));
	await tick();
	ok("何も描かないフレームも背景色で消して submit", L.submits === s0 + 1 && L.passes.at(-1).desc.colorAttachments[0].loadOp === "clear" && L.passes.at(-1).desc.colorAttachments[0].clearValue.g === 0.2 && L.passes.at(-1).ended);

	R.beginFrame(view, [0, 0, 0]);
	const p1 = L.passes.length;
	R.drawLand({ land: [1, 1, 1], pal }); R.drawChoropleth({ alpha: 1 });
	ok("drawIds の前の drawLand／drawChoropleth は何もしない", L.passes.length === p1);
	ok("drawIds：空は false", R.drawIds(v, null) === false);
	ok("drawIds：別パス（ID テクスチャへ clear→加算）", R.drawIds(v, vao) === true && L.passes.at(-1).desc.colorAttachments[0].view.of.format === "r32float" && same(L.passes.at(-1).cmds.at(-1), ["draw", 18, 3]) && L.passes.at(-1).ended);
	R.drawSea([0, 0, 1], [0, 0, 0], [1, 1, 1, 1]);
	R.drawLand({ land: [0.9, 0.8, 0.7], hypso: 0.4, pal });
	R.drawChoropleth({ alpha: 0.6, hover: 5 });
	R.drawChoropleth({});
	R.drawLines(v, vao, [{ color: [1, 0, 0, 1], width: 2 }, null, { color: [0, 0, 1, 1], size: 4 }]);
	R.drawLines(v, null, []);
	R.drawPoints(vao, [{ color: [0, 1, 0, 1], size: 3 }]);
	R.drawFill(v, vao, [0, 0, 1, 0.5]);
	R.drawVeil([0, 0, 0, 0]); R.drawVeil([0, 0, 0, 0.3]);
	const main = L.passes.at(-1);
	R.freeVAO(R.instanceVAO(new Uint32Array(3), 3));
	const pending = L.destroyed.length;
	await tick();
	ok("記録中の freeVAO は submit の後で捨てる", L.destroyed.length === pending + 1);
	const fsSeq = main.cmds.filter(c => c[0] === "pipe").map(c => c[1]).join(",");
	ok("主パス：海→合成→コロプレス→線→点→ステンシル 0→扇→被せ→幕", fsSeq === "fsSea,fsComposite,fsChoro,fsLine,fsPoint,fsNone,fsNone,fsCover,fsVeil", fsSeq);
	ok("主パスは初回 clear（ID パスの後に開く）", main.desc.colorAttachments[0].loadOp === "clear" && main.desc.depthStencilAttachment.stencilLoadOp === "clear");
	ok("被せはステンシル参照 1", main.cmds.some(c => c[0] === "ref" && c[1] === 1));
	const offs = main.cmds.filter(c => c[0] === "bg" && c[1] === 0).map(c => c[2]);
	ok("uniform は描画ごとに別スロット（動的オフセット 1024 刻み）", offs.every((o, i) => i === 0 || o >= offs[i - 1]) && offs.includes(1024) && offs.every(o => o % 1024 === 0));
	// スロット：0=ID 1=海 2=合成 3=コロプレス 4=線 5=点 6=扇 7=被せ 8=幕
	ok("合成：陸色・ハイプソ・float ID・標高・気候・近景の窓・配色", same(U(L, 2, O.land, 4), [0.9, 0.8, 0.7, 0].map(Math.fround)) && U(L, 2, O.hypsoA) === Math.fround(0.4) && U(L, 2, O.hasId) === 1 && U(L, 2, O.hasElev) === 1 && U(L, 2, O.hasClim) === 1 && U(L, 2, O.hasNear) === 1 && same(U(L, 2, O.nearB, 4), [130, 30, 20, 10]) && U(L, 2, O.pal + 7 * 4) === Math.fround(0.9));
	ok("コロプレス：濃さ・hover・既定のホバー色・塗り表の幅（int）", U(L, 3, O.choroA) === Math.fround(0.6) && U(L, 3, O.hover) === 5 && U(L, 3, O.hoverC) === Math.fround(0.1) && new Int32Array(L.uniforms.at(-1).buffer)[3 * 256 + O.paintW] === 1024);
	ok("線：分類ごとの色と太さ（size も太さ・空きは 0）・頂点テクスチャの幅", U(L, 4, O.color) === 1 && U(L, 4, O.color + 8 + 2) === 1 && U(L, 4, O.param) === 2 && U(L, 4, O.param + 4) === 0 && U(L, 4, O.param + 8) === 4 && new Int32Array(L.uniforms.at(-1).buffer)[4 * 256 + O.vw] === 4096);
	ok("点：前の線の色を消してから入れる", U(L, 5, O.color + 1) === 1 && U(L, 5, O.color + 8 + 2) === 0);
	ok("被せと幕の色", U(L, 7, O.col + 3) === 0.5 && U(L, 8, O.col + 3) === Math.fround(0.3));
	ok("共通：画面寸法・dpr・u_morph 既定 1", U(L, 1, O.vp) === 600 && U(L, 1, O.dpr) === 1.5 && U(L, 1, O.morph) === 1);

	R.beginFrame(view, [0, 0, 0], { t: -1, ppuS: 10, lat: 0.5, cam: 3 });
	R.drawSea([0, 0, 1], [0, 0, 0], [1, 1, 1, 1]); await tick();
	ok("morph：t は 0..1 に挟む・ppuS は dpr 倍", U(L, 0, O.morph) === 0 && U(L, 0, O.ppuS) === 15);

	R.beginFrame(view, [0, 0, 0]);
	const s1 = L.submits;
	for (let i = 0; i < 130; i++) R.drawSea([0, 0, 1], [0, 0, 0], [1, 1, 1, 1]);
	await tick();
	ok("1 フレーム 128 描画を超えたら途中で submit・続きは load で開き直す", L.submits === s1 + 2 && L.passes.at(-1).desc.colorAttachments[0].loadOp === "load");
	const s2 = L.submits; R.beginFrame(view, [0, 0, 0]); R.drawSea([0, 0, 1], [0, 0, 0], [1, 1, 1, 1]); R.beginFrame(view, [0, 0, 0]);
	ok("記録中に次の beginFrame＝先に submit", L.submits === s2 + 1);
	await tick();
}

// ── 国の識別 ──
{
	ok("readFid：ID−1", await R.readFid(10, 20) === 7);
	ok("readFid：CSS px→実 px（上下はそのまま）・1 px を写す", L.copy.src.origin.x === 15 && L.copy.src.origin.y === 30 && L.copy.dst.bytesPerRow === 256);
	ok("readFid：画面の外＝-1", await R.readFid(-1, 0) === -1 && await R.readFid(0, 200) === -1 && await R.readFid(400, 0) === -1);
	const H = fakeGPU({ readId: 0 }), RH = await createRendererGPU(canvasOf(H));
	ok("readFid：フレーム前は -1", await RH.readFid(1, 1) === -1);
	RH.beginFrame(view, [0, 0, 0]);
	ok("readFid：ID 0（海）＝-1", await RH.readFid(1, 1) === -1);
	const M = fakeGPU({ readId: 3, mapFails: true }), RM = await createRendererGPU(canvasOf(M)); RM.beginFrame(view, [0, 0, 0]);
	ok("readFid：mapAsync の失敗＝-1", await RM.readFid(1, 1) === -1);
	cv.clientWidth = 500; const d0 = L.destroyed.length; R.beginFrame(view, [0, 0, 0]); await tick();
	ok("寸法が変わったら描き先を作り直す（古い 3 枚を捨てる）", L.destroyed.length - d0 >= 3 && cv.width === 750);
}

// ── float ID の無い機体 ──
{
	warned = [];
	const N = fakeGPU({ float: false }), RN = await createRendererGPU(canvasOf(N));
	ok("float32-blendable 無し＝陸マスクだけ（警告・要求しない・ID パイプライン無し）", RN.hasFloatId === false && warned.length === 1 && same(N.log.required, []) && N.log.pipelines.length === 10);
	const F = fakeGPU(), RF = await createRendererGPU(canvasOf(F), { noFloatId: true });
	ok("noFloatId＝同じ落ち方を踏む", RF.hasFloatId === false);
	RN.beginFrame(view, [0, 0, 0]);
	ok("ID テクスチャは作らない", !N.log.textures.some(t => t.format === "r32float"));
	const v = RN.uploadVertices(new Uint32Array(8), 4), vao = RN.instanceVAO(new Uint32Array(6), 3);
	RN.drawIds(v, vao); RN.drawLand({ land: [1, 1, 1], pal }); RN.drawChoropleth({ alpha: 1, hover: 2 });
	await tick();
	const p = N.log.passes.at(-1), seq = p.cmds.filter(c => c[0] === "pipe").map(c => c[1]).join(",");
	ok("drawIds＝主パスのステンシル（0 書き→扇）・合成はステンシル付き（参照 1）・コロプレスは描かない", N.log.passes.length === 1 && seq === "fsNone,fsNone,fsComposite" && p.cmds.some(c => c[0] === "ref") && N.log.pipelines.some(pl => pl.fs === "fsComposite" && pl.stencil === "equal"), seq);
	ok("合成の u_hasId 0", U(N.log, 1, O.hasId) === 0);
	ok("readFid は -1", await RN.readFid(1, 1) === -1);
}

// ── device lost／destroy ──
{
	const D = fakeGPU(), RD = await createRendererGPU(canvasOf(D));
	warned = [];
	D.lose({ reason: "unknown", message: "gpu reset" }); await tick();
	const p0 = D.log.passes.length;
	RD.beginFrame(view, [0, 0, 0]); RD.drawSea([0, 0, 1], [0, 0, 0], [1, 1, 1, 1]); await tick();
	ok("device lost＝警告・以後は描かない", warned.some(w => /gpu reset/.test(w)) && D.log.passes.length === p0);
	const E2 = fakeGPU(), RE = await createRendererGPU(canvasOf(E2)); warned = [];
	RE.destroy(); await tick();
	ok("destroy＝unconfigure・device を捨てる（destroyed は警告しない）", E2.log.unconfigured && E2.log.devDestroyed && warned.length === 0);
}

console.warn = quiet;
console.log(fail ? `\n✗ ${fail} 件失敗` : "\n✓ t-renderer-gpu 全 PASS");
process.exit(fail ? 1 : 0);
