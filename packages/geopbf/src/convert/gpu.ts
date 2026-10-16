// convert/gpu.js ── WebGPU の「計算だけ」の薄い器。描画は一切持たない（ortho-core gpu/gint.js の compute 版の最小形）。
//
// 供給源の優先順: opts.gpu（明示注入） > setGPU() で登録した GPU > globalThis.navigator.gpu（ブラウザ・Deno）。
// Node 22 には navigator.gpu が無い＝Dawn（任意依存の `webgpu` パッケージ）は **bin/geopbf.mjs が読んで setGPU() で
// 注入する**。ここに `import("webgpu")` を置くと、ブラウザ向けバンドラ（vite/rollup/rolldown）が裸の指定子を
// 静的に解決しようとして消費者の dev が 500 で割れる＝1.5.0 の轍。指定子を "web"+"gpu" と割っても vite 8 の
// 事前バンドルが定数畳み込みで元に戻すため小技では塞げない（1.5.1 の轍）＝供給源は外から入れるのが唯一の正解。
// 「GPU が無い」は失敗ではなく通常の分岐＝例外にしない（null を返して呼び出し側が CPU 経路へ落ちる）。
//
// ⚠ 数値規律: 本パッケージのカーネルは全て整数演算（u32/i32）だけで書く＝CPU 参照実装と bit 一致が検定できる。
//   f32 の超越関数は GPU 毎に丸めが違い「ほぼ同じ」しか言えない。ここでは「同じ」を言うために f32 を使わない。

const STORAGE = 0x80, COPY_SRC = 0x04, COPY_DST = 0x08, UNIFORM = 0x40, MAP_READ = 0x01;   // GPUBufferUsage の定数（Node で未定義でも動く）

let _gpu = null;
export function setGPU(gpu) { _gpu = gpu; }

// ブラウザ/Deno: navigator.gpu。Node: setGPU() で注入された Dawn（無ければ null＝CPU 経路）。
export async function findGPU(opts = {}) {
	if (opts.gpu) return opts.gpu;
	if (_gpu) return _gpu;
	if (globalThis.navigator?.gpu) return globalThis.navigator.gpu;
	return null;   // Node の Dawn（任意依存 `webgpu`）は CLI が読んで setGPU() で注入する（下の注記）
}

export async function getDevice(opts = {}) {
	const gpu = await findGPU(opts);
	if (!gpu) return null;
	// 通常の adapter が無ければ fallback（SwiftShader などのソフトウェア実装）も試す＝CI の headless Chromium はこちら。出力は同じバイト列
	const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" }).catch(() => null)
		?? await gpu.requestAdapter({ forceFallbackAdapter: true }).catch(() => null);
	if (!adapter) return null;
	// 大きなストレージバッファ（数千万頂点＝数百 MB）を1本で束ねたい＝アダプタ上限まで要求。断られたら既定で。
	const requiredLimits = {};
	for (const k of ["maxStorageBufferBindingSize", "maxBufferSize", "maxComputeWorkgroupsPerDimension"])
		if (adapter.limits?.[k] !== undefined) requiredLimits[k] = adapter.limits[k];
	const device = await adapter.requestDevice({ requiredLimits }).catch(() => adapter.requestDevice().catch(() => null));
	if (!device) return null;
	device.__info = adapter.info ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture, description: adapter.info.description } : {};
	return device;
}

const align = (n, a = 4) => Math.ceil(n / a) * a;

// 計算コンテキスト＝パイプラインのキャッシュ・upload/alloc/dispatch/readback。
export function createContext(device) {
	const pipes = new Map();
	const pipeline = (code, entry = "main") => {
		const key = entry + "\n" + code;
		let p = pipes.get(key);
		if (!p) {
			const module = device.createShaderModule({ code });
			// WGSL のコンパイル失敗は黙って「全部ゼロ」になる＝必ず可視化（ortho-core mkMod と同じ作法）
			module.getCompilationInfo?.().then(info => { for (const m of info.messages || []) if (m.type === "error") console.error(`[convert/gpu] WGSL ${m.lineNum}:${m.linePos} ${m.message}`); });
			p = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: entry } });
			pipes.set(key, p);
		}
		return p;
	};
	const upload = (ta, usage = STORAGE | COPY_DST | COPY_SRC) => {
		const bytes = ta instanceof ArrayBuffer ? new Uint8Array(ta) : new Uint8Array(ta.buffer, ta.byteOffset, ta.byteLength);
		const size = Math.max(4, align(bytes.byteLength));
		const buf = device.createBuffer({ size, usage, mappedAtCreation: true });
		new Uint8Array(buf.getMappedRange()).set(bytes);
		buf.unmap();
		return buf;
	};
	const uniform = (u32) => upload(u32, UNIFORM | COPY_DST);
	const alloc = (byteLength) => device.createBuffer({ size: Math.max(4, align(byteLength)), usage: STORAGE | COPY_DST | COPY_SRC });
	// bindings: GPUBuffer の配列（binding 番号＝添字）。dispatch: [x, y, z] workgroups。
	const run = (pipe, bindings, [x, y = 1, z = 1]) => {
		const bg = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: bindings.map((buffer, binding) => ({ binding, resource: { buffer } })) });
		const enc = device.createCommandEncoder();
		const pass = enc.beginComputePass();
		pass.setPipeline(pipe); pass.setBindGroup(0, bg); pass.dispatchWorkgroups(x, y, z); pass.end();
		device.queue.submit([enc.finish()]);
	};
	const readback = async (buf, byteLength, offset = 0) => {
		const size = align(byteLength);
		const st = device.createBuffer({ size, usage: MAP_READ | COPY_DST });
		const enc = device.createCommandEncoder();
		enc.copyBufferToBuffer(buf, offset, st, 0, size);
		device.queue.submit([enc.finish()]);
		await st.mapAsync(1 /* GPUMapMode.READ */);
		const out = st.getMappedRange().slice(0, byteLength);
		st.unmap(); st.destroy();
		return out;
	};
	const maxWG = device.limits?.maxComputeWorkgroupsPerDimension || 65535;
	return { device, pipeline, upload, uniform, alloc, run, readback, maxWG, destroy() { pipes.clear(); } };
}
