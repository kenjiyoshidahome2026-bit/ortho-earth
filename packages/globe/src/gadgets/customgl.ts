// MapLibre の custom 層（CustomLayerInterface・公式例の門 4 巡目・2026-09-28）＝main スレッドの透明な WebGL2 canvas を地図に重ね、
// 層の render(gl, args) に MapLibre と同じ形の行列（args.defaultProjectionData.mainMatrix＝メルカトル座標 [0..1]・z はメルカトル単位 → クリップ）を毎フレーム渡す。
// この地図の描画は worker（OffscreenCanvas）＝MapLibre のように地図と同じ GL の文脈は渡せない。そのため：
//   ・深度は地図と共有しない＝模型は建物や地形に隠れない（常に上）。層どうしの深度はこの canvas の中で解決
//   ・行列は起動の中心（メルカトル x0,y0）で局所線形化＝メルカトル (x,y,z) → 東北上 [m] → 単位球 → この地図の mvp。狭い範囲（模型・3D Tiles・z≥8）は
//     画素の内で合う。大陸大の図形（z3 の三角形）は球とメルカトルの差の分だけ違う。globe の variant（projectTile の球の prelude・getProjectionData）は無い
//   ・行列は Float64Array で渡す（three.js は f64 で模型の行列と掛けてから f32 に落とす＝高ズームでも震えない。f32 で渡すと z18 で 10px 級の震え）
// 深度を共有したい層（renderingMode "3d"）は worker 経路（customgl-draw.js・addLayer の url＝モジュールの URL・PR-7）へ。こちらは互換用（層の object を main で呼ぶ）
// 契約（MapLibre の CustomLayerInterface）：onAdd(map, gl)・prerender?(gl, args)・render(gl, args)・onRemove?(map, gl)・renderingMode "2d"|"3d"。
// map.triggerRepaint()（＝requestDraw）で次のフレームにまた render が呼ばれる（動く層）。
import { makeCustomArgs, GLOBE_MAX_Z } from "./customgl-args.ts";
import type { CameraPose } from "@ortho-earth/core/camera";

/** render(gl, args) の args（customgl-args.ts の makeCustomArgs の戻り） */
export type CustomArgs = ReturnType<typeof makeCustomArgs>;
/** MapLibre の CustomLayerInterface（main の canvas で呼ぶ層の object・this＝層） */
export interface CustomLayer {
	id: string;
	renderingMode?: "2d" | "3d";
	onAdd?(map: unknown, gl: WebGL2RenderingContext): void;
	prerender?(gl: WebGL2RenderingContext, args: CustomArgs): void;
	render(gl: WebGL2RenderingContext, args: CustomArgs): void;
	onRemove?(map: unknown, gl: WebGL2RenderingContext): void;
}
/** createCustomGL の env */
export interface CustomGLEnv {
	mapEl: HTMLElement;
	/** この canvas をこの要素の前に差す（注記の下） */
	before?: Element | null;
	/** 描画面（device px） */
	size(): { w: number; h: number };
	cam: CameraPose;
	earthM: number;
	requestDraw(): void;
	onFrame(fn: () => void): () => void;
	/** worker が描いた絵の cam で呼ばれる（あれば同期＝こちらを使う） */
	onWorkerFrame?: (fn: (cam: CameraPose) => void) => () => void;
	/** onAdd/render に渡す map（getProjection の type "globe"＝球の variant） */
	readonly hostMap?: { getProjection?(): { type?: string } | null | undefined } | null;
}

// env＝{ mapEl, before（この canvas をこの要素の前に差す＝注記の下）, size()→{w,h}（device px）, dpr, cam, earthM, requestDraw, onFrame(fn)→off, hostMap（onAdd/render に渡す map） }
let warned3d = false;   // "3d" の層を main の経路で受けた案内（頁で 1 回）

export function createCustomGL(env: CustomGLEnv) {
	const { mapEl, before, size, cam, earthM, requestDraw, onFrame, onWorkerFrame } = env;   // onWorkerFrame＝worker が描いた絵の cam で呼ばれる（あれば同期＝こちらを使う）
	const layers: Array<{ layer: CustomLayer; order: number }> = [];   // { layer, order }
	let cv: HTMLCanvasElement | null = null, gl: WebGL2RenderingContext | null = null, off: (() => void) | null = null, lost = false;
	function ensure() {
		if (gl) return gl;
		cv = document.createElement("canvas");
		cv.className = "custom-gl"; cv.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none";
		const s = size(); cv.width = s.w; cv.height = s.h;
		if (before && before.parentNode === mapEl) mapEl.insertBefore(cv, before); else mapEl.appendChild(cv);
		gl = cv.getContext("webgl2", { alpha: true, antialias: true, premultipliedAlpha: true, preserveDrawingBuffer: false, depth: true, stencil: true });
		if (!gl) { cv.remove(); cv = null; throw new Error("custom layer: WebGL2 is not available for the overlay canvas"); }
		cv.addEventListener("webglcontextlost", e => { e.preventDefault(); lost = true; });
		cv.addEventListener("webglcontextrestored", () => { lost = false; for (const L of layers) { try { L.layer.onAdd?.(env.hostMap ?? null, gl!); } catch (err) { console.error("[custom layer] onAdd after context restore", err); } } requestDraw(); });
		off = onWorkerFrame ? onWorkerFrame(camW => frame(camW)) : onFrame(() => frame());   // 地図と同じ cam・同じ時刻で描く（main の rAF で描くと地図より先行して見える）
		return gl;
	}
	// MapLibre の args（customgl-args.js・worker 経路と同じ関数）。variant＝例が頼んだ投影に従う（既定 mercator・setProjection({type:"globe"}) で globe）。寄ったら（z≥13）どちらも mercator の局所線形化
	function makeArgs(camUse = cam) {   // camUse＝worker が描いた絵の cam（frame 事象）か main の cam
		const s = size();
		return makeCustomArgs(camUse, s.w, s.h, { earthM, globe: camUse.zoom < GLOBE_MAX_Z && env.hostMap?.getProjection?.()?.type === "globe" });
	}
	function frame(camW: CameraPose | null = null) {
		if (!gl || lost || !layers.length) return;
		const s = size();
		if (cv!.width !== s.w || cv!.height !== s.h) { cv!.width = s.w; cv!.height = s.h; }
		gl.viewport(0, 0, s.w, s.h);
		gl.disable(gl.SCISSOR_TEST); gl.colorMask(true, true, true, true); gl.depthMask(true); gl.clearColor(0, 0, 0, 0); gl.clearDepth(1); gl.clearStencil(0);
		gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
		const args = makeArgs(camW || cam);
		for (const { layer } of layers) {
			// MapLibre が層の前に整える状態（深度は 3d の層だけ・ブレンドは事前乗算の合成）
			gl.disable(gl.STENCIL_TEST); gl.disable(gl.CULL_FACE);
			if (layer.renderingMode === "3d") { gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(true); } else { gl.disable(gl.DEPTH_TEST); gl.depthMask(false); }
			gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
			try { layer.prerender?.(gl, args); layer.render(gl, args); } catch (err) { console.error(`[custom layer] ${layer.id}`, err); }
		}
	}
	return {
		get canvas() { return cv; },
		has: (id: string) => layers.some(L => L.layer.id === id),
		add(layer: CustomLayer, order = layers.length) {
			const g = ensure();
			this.remove(layer.id);
			// "3d" の層をこの経路（main の canvas）で受けると地図の深度を持てない＝模型が建物・地形の手前に出る。worker 経路の書き方を 1 回だけ案内する（THREE.md）
			if (layer.renderingMode === "3d" && !warned3d) { warned3d = true; console.warn(`[custom layer] "${layer.id}": renderingMode "3d" layers passed as objects run on the main thread and are not hidden by terrain or buildings. Pass { type: "custom", url: <module URL>, three?: <three.module.js URL> } to draw in the render worker with scene depth, or use map.addThree (see packages/globe/THREE.md).`); }
			layers.push({ layer, order }); layers.sort((p, q) => p.order - q.order);
			try { layer.onAdd?.(env.hostMap ?? null, g); } catch (err) { console.error(`[custom layer] ${layer.id} onAdd`, err); }
			requestDraw();
		},
		remove(id: string) {
			const i = layers.findIndex(L => L.layer.id === id); if (i < 0) return false;
			const [L] = layers.splice(i, 1);
			try { L.layer.onRemove?.(env.hostMap ?? null, gl!); } catch (err) { console.error(`[custom layer] ${id} onRemove`, err); }
			if (!layers.length && gl) { gl.clear(gl.COLOR_BUFFER_BIT); }
			requestDraw();
			return true;
		},
		setOrder(id: string, order: number) { const L = layers.find(x => x.layer.id === id); if (L) { L.order = order; layers.sort((p, q) => p.order - q.order); requestDraw(); } },
		destroy() { off?.(); layers.length = 0; cv?.remove(); cv = null; gl = null; },
	};
}
