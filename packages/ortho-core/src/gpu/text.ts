// 注記の字を WebGPU で塗る（テキスト GPU 化 T-P1・T-P2・`text gpu plan.md` §3）。線に沿う注記と点の注記の字＝記号・標識・format の記号の区間は Canvas2D の受け口のまま（T-P3）。
// 字の版＝SDF（R8）の 1 枚。鍵は「基準の大きさに直した書体×字」だけ＝色・大きさ・縁・ぼかし・不透明度はインスタンスとシェーダ（旧の字の版は組ごとに焼き直していた）。
// 元の絵は今と同じ Canvas2D（addFontFace の Web フォントも効く）＝白で 1 字焼いて EDT で SDF（sdf.ts）。
// 描く先は注記の canvas の上に重ねた webgpu の canvas（足場＝T-P2 で地図の描画パスの中へ移す）。1 字 1 インスタンス（72B）・4 頂点の strip。
// 版が尽きたら 2048→4096 に広げ、それも尽きたら次のフレームの頭で全部捨てて焼き直す（尽きたフレームはその字だけ出ない）
import { SDF_BASE, SDF_PAD, SDF_R, SDF_CUTOFF, baseFont, sdfFromAlpha, shelfPacker } from "../sdf.ts";
import { pointGlyphs, pxNumOf } from "../textsink.ts";
import type { Color, LabelShield, LineGlyph, LineIcon, Mat2, IconRect, TextLayout } from "../labels2d.ts";
import type { PointGlyph, PointImg, SinkStats, TextPaint, TextSink } from "../textsink.ts";

/** 版の中の字 1 つ（版の px）。ox, oy＝字の錨（中央・middle）から箱の左上（基準の大きさの px） */
export interface SdfGlyph { x: number; y: number; w: number; h: number; ox: number; oy: number }

const STRIDE = 18;   // float 16＋色 2（unorm8x4）＝72B
const WGSL = /* wgsl */`
struct U { size: vec2f, dpr: f32, atlas: f32 };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var atlas: texture_2d<f32>;
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) hp: vec2f, @location(2) fill: vec4f, @location(3) halo: vec4f };
@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) p: vec2f, @location(1) m: vec4f, @location(2) r: vec4f, @location(3) t: vec4f,
              @location(4) hp: vec2f, @location(5) fill: vec4f, @location(6) halo: vec4f) -> VO {
	let c = vec2f(f32(vi & 1u), f32(vi >> 1u));
	let l = r.xy + c * r.zw;                                     // 字の局所（CSS px・錨が原点）
	let s = (p + vec2f(m.x * l.x + m.z * l.y, m.y * l.x + m.w * l.y)) * u.dpr;   // Canvas2D の setTransform(a,b,c,d,e,f) と同じ向き
	var o: VO;
	o.pos = vec4f(s.x / u.size.x * 2.0 - 1.0, 1.0 - s.y / u.size.y * 2.0, 0.0, 1.0);
	o.uv = mix(t.xy, t.zw, c) / u.atlas; o.hp = hp; o.fill = fill; o.halo = halo;   // UV は版の px で持つ＝フレームの途中で版を広げても前に積んだ字が狂わない
	return o;
}
@fragment fn fs(i: VO) -> @location(0) vec4f {
	let v = textureSample(atlas, samp, i.uv).r;
	let d = (${1 - SDF_CUTOFF} - v) * ${SDF_R.toFixed(1)};                   // 縁からの距離（版の px・外が正）＝sdf.ts の sdfDist
	let tx = fwidth(i.uv * vec2f(textureDimensions(atlas)));
	let w = max(0.5 * (tx.x + tx.y), 1e-3);                          // 画面の 1px が版の何 px か
	let fa = clamp(0.5 - d / w, 0.0, 1.0);
	let ha = clamp(0.5 - (d - i.hp.x) / (w + i.hp.y), 0.0, 1.0);    // 縁（strokeText の幅の半分）・ぼかしは幅を広げる
	let f = vec4f(i.fill.rgb * i.fill.a, i.fill.a) * fa;
	let h = vec4f(i.halo.rgb * i.halo.a, i.halo.a) * ha;
	return f + h * (1.0 - f.a);                                      // 縁の上に本体（premultiplied）
}`;

export interface GpuText {
	/** 字を版から引く（無ければ焼く）。null＝描けない（空白・版が尽きた） */
	glyph(font: string, ch: string): SdfGlyph | null;
	/** 書体の基準化（[基準の書体, 元の px]）＝覚える */
	fontOf(font: string): [string, number];
	begin(W: number, H: number, dpr: number): void;
	/** 字 1 つ。(x,y)＝錨（CSS px）・m＝字の向きと潰れ（2×2）・k＝px/基準・fill／halo＝RGBA8（不透明度込み）・hw／blur＝縁の幅とぼかし（CSS px） */
	push(x: number, y: number, m: Mat2, sp: SdfGlyph, k: number, fill: number, halo: number, hw: number, blur: number): void;
	end(): void;
	clearCanvas(): void;
	reset(): void;
	/** 今の canvas の絵（RGBA・premultiplied・上が先頭）。end() と同じタスクで呼ぶ（present の前の写しを取る） */
	readPixels(): Promise<Uint8Array>;
	readonly count: number;
	readonly atlasSize: number;
	destroy(): void;
}

/** canvas＝描く先の webgpu canvas。null＝画面に出さずテクスチャに描く（検定：ソフトウェア WebGPU は canvas の present で device ごと落ちる） */
export function createGpuText(device: GPUDevice, canvas: OffscreenCanvas | HTMLCanvasElement | null, format: GPUTextureFormat = canvas ? navigator.gpu.getPreferredCanvasFormat() : "rgba8unorm"): GpuText {
	const ctx = canvas ? canvas.getContext("webgpu") as GPUCanvasContext : null;
	ctx?.configure({ device, format, alphaMode: "premultiplied", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });   // COPY_SRC＝readPixels（検定の読み戻し）
	let off: GPUTexture | null = null;
	const target = (): GPUTexture => {
		if (ctx) return ctx.getCurrentTexture();
		if (!off || off.width !== W || off.height !== H) { off?.destroy(); off = device.createTexture({ size: [W, H], format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC }); }
		return off;
	};
	const MAXS = Math.min(4096, device.limits.maxTextureDimension2D);
	let size = Math.min(2048, MAXS), cpu = new Uint8Array(size * size), tex = mkTex(size), dirty0 = size, dirty1 = 0, needReset = false;
	const shelf = shelfPacker(size), glyphs = new Map<string, SdfGlyph | null>(), fonts = new Map<string, [string, number]>();
	const rcv = new OffscreenCanvas(128, 128), rctx = rcv.getContext("2d", { willReadFrequently: true })!;   // 焼き場（CPU の画素＝getImageData が GPU から読み戻さない）
	function mkTex(s: number) { return device.createTexture({ size: [s, s], format: "r8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST }); }

	const mod = device.createShaderModule({ code: WGSL });
	const attrs: GPUVertexAttribute[] = [
		{ shaderLocation: 0, offset: 0, format: "float32x2" }, { shaderLocation: 1, offset: 8, format: "float32x4" },
		{ shaderLocation: 2, offset: 24, format: "float32x4" }, { shaderLocation: 3, offset: 40, format: "float32x4" },
		{ shaderLocation: 4, offset: 56, format: "float32x2" }, { shaderLocation: 5, offset: 64, format: "unorm8x4" }, { shaderLocation: 6, offset: 68, format: "unorm8x4" }];
	const blend: GPUBlendState = { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" } };
	const pipe = device.createRenderPipeline({
		layout: "auto",
		vertex: { module: mod, entryPoint: "vs", buffers: [{ arrayStride: STRIDE * 4, stepMode: "instance", attributes: attrs }] },
		fragment: { module: mod, entryPoint: "fs", targets: [{ format, blend }] },
		primitive: { topology: "triangle-strip" },
	});
	const ubuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
	const samp = device.createSampler({ magFilter: "linear", minFilter: "linear" });
	let bind = mkBind();
	function mkBind() { return device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ubuf } }, { binding: 1, resource: samp }, { binding: 2, resource: tex.createView() }] }); }

	let inst = new Float32Array(STRIDE * 1024), instU = new Uint32Array(inst.buffer), n = 0, vbuf: GPUBuffer | null = null, vcap = 0;
	let W = 1, H = 1, dpr = 1, drewLast = false;
	const uni = new Float32Array(4);

	function grow(): boolean {   // 版を 2 倍へ（中身は左上に写す＝字の版の px は変わらない）。棚は旧い領域の下から新しい幅で続ける（右上の 1/4 は空けたまま＝簡単さを採る）
		if (size >= MAXS) return false;
		const old = size, s2 = Math.min(MAXS, size * 2), c2 = new Uint8Array(s2 * s2);
		for (let y = 0; y < old; y++) c2.set(cpu.subarray(y * old, (y + 1) * old), y * s2);
		tex.destroy(); size = s2; cpu = c2; tex = mkTex(size); bind = mkBind();
		shelf.reset(size, old + 1); dirty0 = 0; dirty1 = size;
		return true;
	}
	const place = (w: number, h: number) => shelf.add(w, h) ?? (grow() ? shelf.add(w, h) : null);
	function fontOf(font: string) { let f = fonts.get(font); if (!f) fonts.set(font, f = baseFont(font, pxNumOf)); return f; }
	function glyph(font: string, ch: string): SdfGlyph | null {
		const bf = fontOf(font)[0], key = bf + "\u0001" + ch;
		let g = glyphs.get(key);
		if (g !== undefined) return g;
		rctx.setTransform(1, 0, 0, 1, 0, 0); rctx.font = bf; rctx.textAlign = "center"; rctx.textBaseline = "middle";
		const mt = rctx.measureText(ch), hw = (mt.width || 0) / 2 || SDF_BASE * 0.3;
		const l = Math.ceil(Math.max(0, mt.actualBoundingBoxLeft ?? hw)), r = Math.ceil(Math.max(0, mt.actualBoundingBoxRight ?? hw));
		const up = Math.ceil(Math.max(0, mt.actualBoundingBoxAscent ?? SDF_BASE * 0.85)), dn = Math.ceil(Math.max(0, mt.actualBoundingBoxDescent ?? SDF_BASE * 0.85));
		if (l + r <= 0 || up + dn <= 0) { glyphs.set(key, null); return null; }   // 形の無い字（空白・制御）
		const w = l + r + 2 * SDF_PAD, h = up + dn + 2 * SDF_PAD;
		if (w + 2 > MAXS || h + 2 > MAXS) { glyphs.set(key, null); return null; }   // 版の一辺より大きい（長い run sprite）＝焼けない（焼き直しても入らない＝needReset にしない）
		if (rcv.width < w || rcv.height < h) { rcv.width = Math.max(rcv.width, w); rcv.height = Math.max(rcv.height, h); rctx.font = bf; rctx.textAlign = "center"; rctx.textBaseline = "middle"; }
		const at = place(w, h);
		if (!at) { needReset = true; return null; }   // 版が尽きた＝次のフレームの頭で焼き直す（覚えない＝次は焼く）
		rctx.clearRect(0, 0, w, h); rctx.fillStyle = "#fff"; rctx.fillText(ch, SDF_PAD + l, SDF_PAD + up);
		const px = rctx.getImageData(0, 0, w, h).data, a = new Uint8Array(w * h);
		for (let i = 0; i < w * h; i++) a[i] = px[i * 4 + 3];
		const sdf = sdfFromAlpha(a, w, h);
		for (let y = 0; y < h; y++) cpu.set(sdf.subarray(y * w, (y + 1) * w), (at[1] + y) * size + at[0]);
		if (at[1] < dirty0) dirty0 = at[1]; if (at[1] + h > dirty1) dirty1 = at[1] + h;
		g = { x: at[0], y: at[1], w, h, ox: -(SDF_PAD + l), oy: -(SDF_PAD + up) };
		glyphs.set(key, g);
		return g;
	}
	function reset() { glyphs.clear(); cpu.fill(0); shelf.reset(size); dirty0 = 0; dirty1 = size; needReset = false; }
	function begin(W0: number, H0: number, dpr0: number) { if (needReset) reset(); W = W0; H = H0; dpr = dpr0; n = 0; }
	function push(x: number, y: number, m: Mat2, sp: SdfGlyph, k: number, fill: number, halo: number, hw: number, blur: number) {
		if ((n + 1) * STRIDE > inst.length) { const a = new Float32Array(inst.length * 2); a.set(inst); inst = a; instU = new Uint32Array(inst.buffer); }
		const o = n++ * STRIDE, kb = 1 / k;   // kb＝版の px／CSS px
		inst[o] = x; inst[o + 1] = y; inst[o + 2] = m.a; inst[o + 3] = m.b; inst[o + 4] = m.c; inst[o + 5] = m.d;
		inst[o + 6] = sp.ox * k; inst[o + 7] = sp.oy * k; inst[o + 8] = sp.w * k; inst[o + 9] = sp.h * k;
		inst[o + 10] = sp.x; inst[o + 11] = sp.y; inst[o + 12] = sp.x + sp.w; inst[o + 13] = sp.y + sp.h;
		inst[o + 14] = Math.min(hw * kb, SDF_R * (1 - SDF_CUTOFF) - 0.5); inst[o + 15] = blur * kb;   // 縁は SDF の外の幅で頭打ち（MapLibre と同じ制約）
		instU[o + 16] = fill; instU[o + 17] = halo;
	}
	function pass(draw: boolean) {
		const enc = device.createCommandEncoder();
		const rp = enc.beginRenderPass({ colorAttachments: [{ view: target().createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }] });
		if (draw && n) { rp.setPipeline(pipe); rp.setBindGroup(0, bind); rp.setVertexBuffer(0, vbuf!); rp.draw(4, n); }
		rp.end();
		device.queue.submit([enc.finish()]);
	}
	function end() {
		if (!n && !drewLast) return;   // 前も今も空＝canvas は前の空のまま
		if (dirty1 > dirty0) { device.queue.writeTexture({ texture: tex, origin: [0, dirty0] }, cpu, { offset: dirty0 * size, bytesPerRow: size, rowsPerImage: dirty1 - dirty0 }, [size, dirty1 - dirty0]); dirty0 = size; dirty1 = 0; }
		if (n) {
			const bytes = n * STRIDE * 4;
			if (bytes > vcap) { vbuf?.destroy(); vcap = Math.max(bytes, vcap * 2, 64 * 1024); vbuf = device.createBuffer({ size: vcap, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST }); }
			device.queue.writeBuffer(vbuf!, 0, inst.buffer, 0, bytes);
		}
		uni[0] = W; uni[1] = H; uni[2] = dpr; uni[3] = size; device.queue.writeBuffer(ubuf, 0, uni);
		pass(true); drewLast = n > 0;
	}
	function readPixels(): Promise<Uint8Array> {
		const src = target(), w = src.width, h = src.height, bpr = Math.ceil(w * 4 / 256) * 256;
		const buf = device.createBuffer({ size: bpr * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }), enc = device.createCommandEncoder();
		enc.copyTextureToBuffer({ texture: src }, { buffer: buf, bytesPerRow: bpr }, [w, h]); device.queue.submit([enc.finish()]);
		return buf.mapAsync(GPUMapMode.READ).then(() => {
			const a = new Uint8Array(buf.getMappedRange()), out = new Uint8Array(w * h * 4), bgra = format.startsWith("bgra");
			for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * bpr + x * 4, o = (y * w + x) * 4; out[o] = a[i + (bgra ? 2 : 0)]; out[o + 1] = a[i + 1]; out[o + 2] = a[i + (bgra ? 0 : 2)]; out[o + 3] = a[i + 3]; }
			buf.unmap(); buf.destroy(); return out;
		});
	}
	function clearCanvas() { n = 0; if (drewLast) { pass(false); drewLast = false; } }
	return { glyph, fontOf, begin, push, end, clearCanvas, readPixels, reset, get count() { return n; }, get atlasSize() { return size; }, destroy() { tex.destroy(); vbuf?.destroy(); ubuf.destroy(); off?.destroy(); try { ctx?.unconfigure(); } catch { /* もう無い */ } } };
}

const rgba8 = (c: Color | null | undefined, o: number) => !c ? 0 : ((Math.round(c[0] * 255) | Math.round(c[1] * 255) << 8 | Math.round(c[2] * 255) << 16 | Math.round(Math.max(0, Math.min(1, c[3] * o)) * 255) << 24) >>> 0);
const ROT = { a: 1, b: 0, c: 0, d: 1 };

/** 注記の字を GPU へ回す受け口（線に沿う注記・点の注記の字）。記号・標識・format の記号の区間・星空は Canvas2D の受け口へそのまま（T-P3）。
 *  attach(gt)＝GPU を据える（null＝外す＝全部 Canvas2D）・canvasOnly＝一時的に全部 Canvas2D（撮影＝注記の canvas 1 枚で読む） */
export interface GpuTextSink extends TextSink { attach(gt: GpuText | null): void; canvasOnly: boolean }
const R90 = (m: Mat2): Mat2 => ({ a: m.c, b: m.d, c: -m.a, d: -m.b });   // m·rotate(90°)＝縦書きの回す字（Canvas2D の rotate(π/2) と同じ向き）
export function createGpuTextSink(base: TextSink): GpuTextSink {
	let gt: GpuText | null = null, on = false, glyphsG = 0;
	// 字送りの寸法＝labels2d の寸法の口（canvasMetrics）と同じ measureText・字間（行の束はラベルごとに覚えてある＝割った字の列も行の束ごとに覚える）
	const mcv = new OffscreenCanvas(8, 8), mctx = mcv.getContext("2d")!, hasLS = "letterSpacing" in mctx;
	let mFont = "", mLs = -1;
	const measure = (t: string) => mctx.measureText(t).width;
	const measurer = (font: string, ls: number) => { if (font !== mFont) { mctx.font = mFont = font; } if (hasLS && ls !== mLs) { mctx.letterSpacing = `${ls}px`; mLs = ls; } return measure; };
	let split = new WeakMap<TextLayout, Map<string, { g: PointGlyph[]; img: PointImg[] }>>();
	const splitOf = (tl: TextLayout, font: string, just: string) => {
		let m = split.get(tl); if (!m) split.set(tl, m = new Map());
		const k = just + "\u0001" + font; let r = m.get(k);
		if (!r) m.set(k, r = pointGlyphs(tl, font, just, measurer));
		return r;
	};
	const s: GpuTextSink = {
		get kind() { return gt ? "webgpu" as const : "2d" as const; },
		get ctx2d() { return base.ctx2d; },
		canvasOnly: false,
		attach(g) { gt = g; },
		begin(W, H, dpr) { base.begin(W, H, dpr); on = !!gt && !s.canvasOnly; glyphsG = 0; if (on) gt!.begin(W, H, dpr); },
		end() { base.end(); if (on) gt!.end(); },
		clear(W, H) { base.clear(W, H); gt?.clearCanvas(); },
		fontsChanged() { base.fontsChanged(); gt?.reset(); split = new WeakMap(); mFont = ""; },
		shield: (sh: LabelShield, sx: number, sy: number, o: number) => base.shield(sh, sx, sy, o),
		lineIcon: (src: CanvasImageSource, ic: LineIcon, o: number) => base.lineIcon(src, ic, o),
		lineText(gl: readonly LineGlyph[], font: string, L: TextPaint, o: number, dpr: number) {
			if (!on) { base.lineText(gl, font, L, o, dpr); return; }
			const g0 = gt!, halo = L.haloW > 0 ? rgba8(L.halo, o) : 0, hw = halo ? L.haloW : 0, blur = halo && L.blur! > 0 ? L.blur! : 0, fill0 = rgba8(L.color, o);
			for (const g of gl) {
				if (!g.ch.trim()) continue;
				const f = g.f || font, sp = g0.glyph(f, g.ch); if (!sp) continue;
				const k = g0.fontOf(f)[1] / SDF_BASE;
				let m = g.t ?? ROT;
				if (!g.t) { const cs = Math.cos(g.a), sn = Math.sin(g.a); m = { a: cs, b: sn, c: -sn, d: cs }; }
				g0.push(g.x, g.y, m, sp, k, g.col ? rgba8(g.col, o) : fill0, halo, hw, blur);
				glyphsG++;
			}
		},
		pointIcon: (src: CanvasImageSource, ib: IconRect, sx: number, sy: number, Ti: Mat2 | null, irot: number | undefined, o: number) => base.pointIcon(src, ib, sx, sy, Ti, irot, o),
		// 点の注記＝行の束を字に割って（pointGlyphs）1 字 1 インスタンス。(x0, y0)＝箱の左上（T があれば錨 (sx, sy) を原点にした T の空間）。
		// 縁は Canvas2D と同じく haloW の幅・ぼかし（shadowBlur）は縁が無くても縁の色で掛かる。format の記号の区間は Canvas2D の受け口の記号として
		pointText(tl: TextLayout, font: string, T: Mat2 | null, sx: number, sy: number, x0: number, y0: number, just: string, L: TextPaint, o: number, img: (name: string) => CanvasImageSource | null) {
			if (!on) { base.pointText(tl, font, T, sx, sy, x0, y0, just, L, o, img); return; }
			const g0 = gt!, pg = splitOf(tl, font, just);
			for (const q of pg.g) if (q.run && !g0.glyph(q.font, q.ch)) { base.pointText(tl, font, T, sx, sy, x0, y0, just, L, o, img); return; }   // 焼けない長い列＝この注記は丸ごと Canvas2D
			const blur = L.blur! > 0 ? L.blur! : 0, halo = L.haloW > 0 || blur ? rgba8(L.halo, o) : 0, hw = L.haloW > 0 ? L.haloW : 0, fill0 = rgba8(L.color, o);
			const M = T ?? ROT, MR = R90(M);
			for (const q of pg.g) {
				const sp = g0.glyph(q.font, q.ch); if (!sp) continue;
				const lx = x0 + q.x, ly = y0 + q.y;
				g0.push(T ? sx + T.a * lx + T.c * ly : lx, T ? sy + T.b * lx + T.d * ly : ly, q.rot ? MR : M, sp, g0.fontOf(q.font)[1] / SDF_BASE, q.col ? rgba8(q.col, o) : fill0, halo, hw, blur);
				glyphsG++;
			}
			for (const im of pg.img) { const bm = img(im.name); if (bm) base.pointIcon(bm, T ? [x0 + im.x, y0 + im.y, im.w, im.h] : [x0 + im.x - sx, y0 + im.y - sy, im.w, im.h], sx, sy, T, undefined, o); }   // 記号帳の絵＝Canvas2D（T-P3 で記号の版へ）
		},
		stats: (): SinkStats => ({ glyphs: base.stats().glyphs + glyphsG }),
	};
	return s;
}
