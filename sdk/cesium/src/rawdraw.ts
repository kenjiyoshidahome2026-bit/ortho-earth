// A primitive written against Cesium's renderer (its own update(frameState) pushing DrawCommands: VertexArray, ShaderProgram, Texture3D, RenderState
// from scene.context, as the volumecloud example does). scene.context is then a real Cesium Context on a WebGL2 canvas over the globe's (made on first
// use), and each frame the primitive's commands run there with Cesium's own UniformState set from the Cesium camera, so its GLSL (czm_ uniforms and
// functions) draws as in Cesium. The canvas has its own depth buffer: the globe does not hide what it draws.
import { Color, Ellipsoid, EllipsoidGeometry, GeometryInstance, VertexFormat } from "@cesium/core";
import * as engine from "@cesium/engine";
import { unsupported } from "./report.ts";

type Any = any;
const { Context, FrameState, Pass, SceneMode, ClearCommand, PassState, RenderState, BlendingState, Primitive, MaterialAppearance, Material } = engine as Any;

// the Earth in this canvas's depth only (no colour): what the globe hides behind the horizon is hidden here too (a line round the back of the globe,
// polyline-material-dev turned round). A tessellated ellipsoid lies inside the true one between its vertices, so it never hides what is on the ground
function earthOccluder(): Any {
	return new Primitive({
		geometryInstances: new GeometryInstance({ geometry: new EllipsoidGeometry({ radii: Ellipsoid.WGS84.radii, vertexFormat: VertexFormat.POSITION_ONLY, stackPartitions: 64, slicePartitions: 128 }) }),
		appearance: new MaterialAppearance({ material: Material.fromType("Color"), flat: true, renderState: { colorMask: { red: false, green: false, blue: false, alpha: false }, depthTest: { enabled: true }, depthMask: true } }),
		asynchronous: false,
	});
}

// Cesium draws a TRANSLUCENT command through order-independent translucency, whatever its blending: the colour it writes is put over what is
// behind with its alpha. Here: alpha blending into the cleared canvas, which leaves premultiplied colour for the page to put over the globe.
const overOf = new WeakMap<object, Any>();
function translucentState(rs: Any): Any {
	let o = overOf.get(rs);
	if (!o) { o = RenderState.fromCache({ ...RenderState.getState(rs), blending: BlendingState.ALPHA_BLEND }); overOf.set(rs, o); }
	return o;
}

/** an object scene.primitives cannot place otherwise: it draws itself (update(frameState) pushes commands) */
export const isRawPrimitive = (p: Any) => !!p && typeof p.update === "function" && typeof p.isDestroyed === "function";

export class RawDrawer {
	readonly #scene: Any; readonly #under: HTMLCanvasElement;
	#canvas: HTMLCanvasElement | null = null; #ctx: Any = null; #failed = false;
	#drew = false; #fs: Any = null; #pass: Any = null; #clear: Any = null; #earth: Any = null;
	readonly items = new Set<Any>();
	constructor(scene: Any, under: HTMLCanvasElement) { this.#scene = scene; this.#under = under; }

	/** the real Context (null when WebGL2 cannot be had) */
	get context(): Any {
		if (this.#ctx || this.#failed) return this.#ctx;
		try {
			const c = document.createElement("canvas");
			c.className = "cesium-ortho-raw";
			Object.assign(c.style, { position: "absolute", inset: "0", width: "100%", height: "100%", pointerEvents: "none" });
			this.#under.insertAdjacentElement("afterend", c);
			this.#size(c);
			this.#ctx = new Context(c, { requestWebgl1: false, webgl: { alpha: true, premultipliedAlpha: true, depth: true, stencil: true, antialias: true, preserveDrawingBuffer: true } });
			this.#canvas = c;
			this.#pass = new PassState(this.#ctx);
			this.#clear = new ClearCommand({ color: new Color(0, 0, 0, 0), depth: 1, stencil: 0 });
		} catch (e) { this.#failed = true; console.warn("[csshim] scene.context", (e as Error)?.message || e); }
		return this.#ctx;
	}
	add(p: Any) { this.items.add(p); void this.context; }   // the canvas and its Context from the first one on (an example's own primitive may never ask for scene.context itself)
	remove(p: Any) { this.items.delete(p); }
	#size(c: HTMLCanvasElement) {
		const s = this.#scene, w = s.drawingBufferWidth, h = s.drawingBufferHeight;
		if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
	}
	/** Scene.render's part for these primitives: update → the commands, by pass */
	render(time: Any) {
		const ctx = this.#ctx, c = this.#canvas;
		if (!ctx || !c || (!this.items.size && !this.#drew)) return;
		this.#drew = this.items.size > 0;   // once more after the last is removed: the clear
		this.#size(c);
		// over the globe's canvas and its 3D overlay (made after this canvas), under its labels
		const at = this.#under.parentElement?.querySelector(":scope > canvas.overlay-gl") ?? this.#under;
		if (c.previousElementSibling !== at) at.insertAdjacentElement("afterend", c);
		const s = this.#scene, cam = s.camera;
		const fs = this.#fs ??= new FrameState(ctx, undefined, undefined);
		fs.mode = SceneMode.SCENE3D; fs.mapProjection = s.mapProjection; fs.camera = cam; fs.time = time; fs.frameNumber = s.frameState.frameNumber;
		fs.pixelRatio = s.pixelRatio; fs.light = s.light; fs.useLogDepth = false; fs.passes.render = true; fs.commandList.length = 0;
		fs.cullingVolume = cam.frustum.computeCullingVolume(cam.positionWC, cam.directionWC, cam.upWC);
		fs.afterRender = [];
		if (this.items.size) { try { (this.#earth ??= earthOccluder()).update(fs); } catch { /* without it the drawing is only over the globe, as before */ } }
		const n0 = fs.commandList.length;
		for (const p of this.items) {
			if (p.show === false || p.isDestroyed?.()) continue;
			try { p.update(fs); } catch (e) { unsupported(`primitive update (${(e as Error)?.message || e})`); this.items.delete(p); }
		}
		const us = ctx.uniformState;
		us.gamma = s.gamma ?? 2.2;
		us.update(fs);
		us.updateFrustum(cam.frustum);
		this.#pass.viewport = undefined;
		this.#clear.execute(ctx, this.#pass);
		const cmds = [...fs.commandList.slice(0, n0), ...fs.commandList.slice(n0).sort((a: Any, b: Any) => (a.pass ?? 0) - (b.pass ?? 0))];   // the Earth's depth first
		for (const cmd of cmds) {
			if (cmd.pass === Pass.COMPUTE) continue;
			us.updatePass(cmd.pass ?? Pass.OPAQUE);
			const rs = cmd.renderState;
			if (cmd.pass === Pass.TRANSLUCENT && rs) cmd.renderState = translucentState(rs);
			try { cmd.execute(ctx, this.#pass); } catch (e) { unsupported(`draw command (${(e as Error)?.message || e})`); }
			cmd.renderState = rs;
		}
		ctx.endFrame();
		for (const f of fs.afterRender) { try { f(); } catch { /* as Scene: a callback's error is the example's */ } }
	}
}
