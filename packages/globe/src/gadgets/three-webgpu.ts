// three.js の WebGPURenderer で描く時の部品（map.addThree({ renderer: "webgpu" })・three-draw.ts から・2026-10-18）。
// WebGL の経路は材質ごとに GLSL を貼って本体の深度で discard するが、WebGPURenderer は材質を TSL（ノード）で組む＝onBeforeCompile が効かない。
// そこで customgl-draw と同じ「深度の前置き」にする：利用者のシーンの前に全画面 1 枚を描き、本体の深度（詰めた 24bit の対数深度）を
// three のカメラの深度（[0,1]）に戻して書く（色は書かない）＝利用者の材質は何も直さずに地形・建物に隠れる（TSL の自前の材質も）。
// 本体が WebGPU なら three は本体の GPUDevice を共有し、深度は本体の GPUTexture をそのまま束ねる（ExternalTexture・コピーなし）。
// 本体が WebGL2 なら three は自前の device で、深度は毎フレーム writeTexture で上がる（DepthApi.gpuTexture）。
// 行の向き：詰めた深度は下の行から（GL の窓座標）・WebGPU の画面座標は上から＝前置きで上下を返して引く。

/** TSL のノード（ここで使う演算だけを構造で書く・three は repo の依存にしない） */
export interface TNode {
	add(b: TNode | number): TNode; sub(b: TNode | number): TNode; mul(b: TNode | number): TNode; div(b: TNode | number): TNode;
	greaterThanEqual(b: TNode | number): TNode; lessThan(b: TNode | number): TNode; or(b: TNode): TNode;
	x: TNode; y: TNode; z: TNode; w: TNode; xy: TNode; rgb: TNode; value: unknown;
}
/** three.webgpu.js の TSL のうち使う分 */
interface Tsl {
	Fn(f: () => TNode): () => TNode; uniform(v: unknown): TNode; float(v: number | TNode): TNode; vec2(x: TNode | number, y?: TNode | number): TNode; vec3(x: number, y: number, z: number): TNode; vec4(x: TNode | number, y: TNode | number, z: TNode | number, w: TNode | number): TNode;
	ivec2(v: TNode): TNode; floor(v: TNode): TNode; dot(a: TNode, b: TNode): TNode; exp2(v: TNode): TNode; clamp(v: TNode, lo: number | TNode, hi: number | TNode): TNode; min(a: TNode, b: TNode): TNode;
	select(c: TNode, a: TNode | number, b: TNode | number): TNode; textureLoad(t: unknown, uv: TNode): TNode; screenCoordinate: TNode; positionGeometry: TNode;
}
interface TObj { frustumCulled: boolean; renderOrder: number; raycast: () => void; name: string }
interface TMat { vertexNode: TNode | null; depthNode: TNode | null; colorWrite: boolean; depthWrite: boolean; depthTest: boolean; depthFunc: number; dispose(): void }
/** 前置きで使う three.webgpu.js の口 */
export interface ThreeGPU {
	TSL: Tsl; AlwaysDepth: number;
	Scene: new () => { add(o: unknown): void };
	Mesh: new (g: unknown, m: unknown) => TObj;
	PlaneGeometry: new (w: number, h: number) => { dispose(): void };
	MeshBasicNodeMaterial: new () => TMat;
	ExternalTexture: new (t: GPUTexture | null) => { sourceTexture: GPUTexture | null; dispose?(): void };
	Vector2: new (x: number, y: number) => { set(x: number, y: number): unknown };
	Vector4: new (x: number, y: number, z: number, w: number) => { set(x: number, y: number, z: number, w: number): unknown };
}

/** 本体の深度を three の深度へ書く前置き（scene＝これだけを先に描く・update で毎フレームの値を入れる） */
export function createDepthPrepass(T: ThreeGPU, eps = 2e-6) {
	const S = T.TSL;
	let ext = new T.ExternalTexture(null);
	const uOn = S.uniform(0), uLog = S.uniform(1), uEps = S.uniform(eps);
	const uSize = S.uniform(new T.Vector2(1, 1)), uTex = S.uniform(new T.Vector2(1, 1)), uP = S.uniform(new T.Vector4(0, 0, -1, 0));   // uP＝(P10, P14, P11, P15)（GL の透視）
	const texNode = { value: ext as unknown };   // Fn の中身は shader を組む時に読まれる＝作り直す時はここを差し替えて depthNode を組み直す
	const depthFn = S.Fn(() => {
		const sc = S.screenCoordinate.xy;
		const uv = sc.div(uSize);
		const tx = S.clamp(S.floor(S.vec2(uv.x.mul(uTex.x), S.float(1).sub(uv.y).mul(uTex.y))), S.vec2(0, 0), uTex.sub(1));
		const c = S.floor(S.textureLoad(texNode.value, S.ivec2(tx)).rgb.mul(255).add(0.5));
		const d = S.dot(c, S.vec3(65536, 256, 1)).div(16777215);
		const w = S.exp2(d.add(uEps).mul(2).div(uLog)).sub(1);   // d＝½·log2(1+w)·logCoef の逆（本体の目からの距離・clip w）
		const ze = w.mul(-1);
		const ndc = uP.x.mul(ze).add(uP.y).div(uP.z.mul(ze).add(uP.w));
		const z01 = S.clamp(ndc.mul(0.5).add(0.5), 0, 1);
		return S.select(d.greaterThanEqual(1).or(uOn.lessThan(0.5)), 1, z01);   // 何も無い・深度の無いフレーム＝奥（隠さない）
	});
	const mat = new T.MeshBasicNodeMaterial();
	mat.vertexNode = S.vec4(S.positionGeometry.x, S.positionGeometry.y, 0.5, 1);
	mat.depthNode = depthFn();
	mat.colorWrite = false; mat.depthWrite = true; mat.depthTest = true; mat.depthFunc = T.AlwaysDepth;
	const geo = new T.PlaneGeometry(2, 2);
	const mesh = new T.Mesh(geo, mat);
	mesh.frustumCulled = false; mesh.renderOrder = -1e9; mesh.name = "__oe_depth"; mesh.raycast = () => {};
	const scene = new T.Scene(); scene.add(mesh);
	return {
		scene,
		/** このフレームの値。src＝本体の深度テクスチャ（null＝深度なし）・P＝three に入れる前の GL の透視（列優先） */
		update(src: GPUTexture | null, logCoef: number, texW: number, texH: number, w: number, h: number, P: ArrayLike<number>) {
			if (src && ext.sourceTexture !== src) {
				if (ext.sourceTexture) { ext = new T.ExternalTexture(src); texNode.value = ext; mat.depthNode = depthFn(); (mat as unknown as { needsUpdate: boolean }).needsUpdate = true; }   // 大きさが変わった＝別の GPUTexture
				else ext.sourceTexture = src;
			}
			uOn.value = src ? 1 : 0; uLog.value = logCoef;
			(uSize.value as { set(x: number, y: number): unknown }).set(w, h);
			(uTex.value as { set(x: number, y: number): unknown }).set(texW, texH);
			(uP.value as { set(x: number, y: number, z: number, w: number): unknown }).set(P[10], P[14], P[11], P[15]);
		},
		dispose() { mat.dispose(); geo.dispose(); },
	};
}

/** GL の透視（clip z∈[−w, w]）を WebGPU の深度（[0, w]）へ：z' = ½z + ½w（行 2 を書き換える・列優先） */
export function toWebGPUDepth(P: ArrayLike<number>): Float64Array {
	const o = Float64Array.from(P);
	for (let c = 0; c < 4; c++) o[4 * c + 2] = 0.5 * P[4 * c + 2] + 0.5 * P[4 * c + 3];
	return o;
}

/** WebGPU の canvas の今の絵を読む（検定の probe）。行は上から・BGRA は RGBA へ並べ替える */
export async function readCanvasPixels(device: GPUDevice, ctx: GPUCanvasContext, w: number, h: number): Promise<Uint8Array> {
	const tex = ctx.getCurrentTexture(), bpr = Math.ceil(w * 4 / 256) * 256;
	const buf = device.createBuffer({ size: bpr * h, usage: 0x01 | 0x08 });   // MAP_READ(1)|COPY_DST(8)
	const enc = device.createCommandEncoder();
	enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: bpr }, [w, h]);
	device.queue.submit([enc.finish()]);
	await buf.mapAsync(0x01);
	const src = new Uint8Array(buf.getMappedRange()), out = new Uint8Array(w * h * 4), bgra = /^bgra/.test(tex.format);
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
		const i = y * bpr + x * 4, o = (y * w + x) * 4;
		out[o] = src[i + (bgra ? 2 : 0)]; out[o + 1] = src[i + 1]; out[o + 2] = src[i + (bgra ? 0 : 2)]; out[o + 3] = src[i + 3];
	}
	buf.unmap(); buf.destroy();
	return out;
}
