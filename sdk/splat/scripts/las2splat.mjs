#!/usr/bin/env node
// 点群（LAS／LAZ／COPC／ZIP の中の LAS）→ Gaussian splat の段（3D Tiles ＋ SPZ）の変換 CLI（2026-11-06・本人「ついでに変換 CLI も」「CPU でやると時間がかかりませんか？」→ --gpu）。
//   node sdk/splat/scripts/las2splat.mjs <in.las|.laz|.copc.laz|.zip> --out <dir> [--gpu|--cpu] [--crs EPSG:6676] [--vertical orthometric|ellipsoidal]
//        [--max-points 4000000] [--color auto|rgb|elevation|intensity|classification] [--detail 1] [--levels N] [--opacity 1] [--format tiles|spz|both] [--timeout 600]
//   --gpu（既定＝WebGPU が要る）＝頁（packages/globe/tests/tool-las2splat.html）を headless の Chrome for Testing（実 GPU・verify:webgpu と同じ台）で開き、
//        ブラウザと同じ道（map.readPointCloud → @ortho-earth/splat の cloud-gpu.ts の WGSL）で変換して、この CLI の小さな HTTP の口へ書き戻す。vite を packages/globe で起こす（repo の中で動かす道具）。
//   --cpu＝node だけ：tile-formats（laz-perf）で解き、globe の copc-place（東北上）と pointcloud-crs（座標系）、@ortho-earth/splat の buildCloudCpu（同じアルゴリズムの参照実装）で段を作る。遅い（数百万点で分）。
//   出力＝<out>/tileset.json ＋ level<L>.glb（KHR_gaussian_splatting ＋ _compression_spz_2）／<out>/<name>.spz ＋ placement.json
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const flag = (k, d = null) => { const i = args.indexOf(k); return i >= 0 ? (args[i + 1] ?? d) : d; };
const has = k => args.includes(k);
const input = args.find(a => !a.startsWith("--") && (args.indexOf(a) === 0 || !args[args.indexOf(a) - 1].startsWith("--") || ["--gpu", "--cpu", "--both", "--quiet"].includes(args[args.indexOf(a) - 1])));
const outDir = flag("--out");
if (!input || !outDir || has("--help")) {
	console.error("usage: las2splat.mjs <in.las|.laz|.zip> --out <dir> [--gpu|--cpu] [--crs EPSG:6676] [--vertical orthometric|ellipsoidal] [--max-points N] [--color auto|rgb|elevation|intensity|classification] [--detail 1] [--levels N] [--opacity 1] [--format tiles|spz|both] [--timeout 600]");
	process.exit(input && outDir ? 0 : 2);
}
const opts = {
	crs: flag("--crs") ?? undefined, vertical: flag("--vertical") ?? undefined, maxPoints: +(flag("--max-points") ?? 4e6), color: flag("--color", "auto"), detail: +(flag("--detail") ?? 1),
	levels: flag("--levels") ? +flag("--levels") : undefined, opacity: +(flag("--opacity") ?? 1), format: flag("--format", "both"), timeout: +(flag("--timeout") ?? 600),
};
const useGpu = !has("--cpu");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const name = path.basename(input).replace(/\.(las|laz|zip)$/i, "").replace(/\.copc$/i, "").replace(/[^\w.-]+/g, "_");
fs.mkdirSync(outDir, { recursive: true });
const t0 = performance.now();
const log = (...a) => { if (!has("--quiet")) console.error(...a); };

if (useGpu) await viaGpu(); else await viaCpu();
log(`done in ${((performance.now() - t0) / 1000).toFixed(1)} s → ${outDir}`);

// ── GPU＝headless Chrome がブラウザと同じ道で変換 ──
async function viaGpu() {
	const { startVite } = await import(path.join(ROOT, "packages/globe/scripts/lib/ui-runner.mjs"));
	const { launchChrome, newTab, connect, REALGPU } = await import(path.join(ROOT, "packages/globe/scripts/lib/cdp.mjs"));
	const bytes = fs.readFileSync(input);
	// 入力を配り、出力を受ける小さな口（Range＝ZIP／COPC の範囲読み・PUT /out/<name>＝書き戻し・別オリジンなので CORS と CORP）
	const written = [];
	const srv = http.createServer((req, res) => {
		const h = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, PUT, OPTIONS", "Access-Control-Allow-Headers": "*", "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges", "Cross-Origin-Resource-Policy": "cross-origin" };
		if (req.method === "OPTIONS") { res.writeHead(204, h); return res.end(); }
		if (req.method === "GET" && req.url.startsWith("/in/")) {
			const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
			if (m) { const a = +m[1], b = m[2] ? Math.min(+m[2], bytes.length - 1) : bytes.length - 1; res.writeHead(206, { ...h, "Content-Type": "application/octet-stream", "Content-Length": b - a + 1, "Content-Range": `bytes ${a}-${b}/${bytes.length}`, "Accept-Ranges": "bytes" }); return res.end(bytes.subarray(a, b + 1)); }
			res.writeHead(200, { ...h, "Content-Type": "application/octet-stream", "Content-Length": bytes.length, "Accept-Ranges": "bytes" }); return res.end(bytes);
		}
		if (req.method === "PUT" && req.url.startsWith("/out/")) {
			const fn = path.basename(decodeURIComponent(req.url.slice(5))), parts = [];
			req.on("data", c => parts.push(c)); req.on("end", () => { const b = Buffer.concat(parts); fs.writeFileSync(path.join(outDir, fn), b); written.push([fn, b.length]); log(`  wrote ${fn} (${(b.length / 1048576).toFixed(1)} MB)`); res.writeHead(200, h); res.end("ok"); });
			return;
		}
		res.writeHead(404, h); res.end();
	});
	await new Promise(r => srv.listen(0, "127.0.0.1", r));
	const fport = srv.address().port, vport = +process.env.LAS2SPLAT_PORT || 5246;
	const stopVite = await startVite({ cwd: path.join(ROOT, "packages/globe"), port: vport, portEnv: "LAS2SPLAT_PORT", readyUrl: `http://localhost:${vport}/tests/` });
	let ch = null;
	try {
		ch = await launchChrome({ flags: REALGPU, profilePrefix: "las2splat" });
		const tab = await newTab(ch.port), cdp = await connect(tab.webSocketDebuggerUrl);
		const q = new URLSearchParams({ src: `http://127.0.0.1:${fport}/in/${encodeURIComponent(path.basename(input))}`, out: `http://127.0.0.1:${fport}/out/`, name, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v != null && v !== "").map(([k, v]) => [k, String(v)])) });
		await cdp.call("Page.enable"); await cdp.call("Runtime.enable");
		cdp.on(m => { if (m.method === "Runtime.consoleAPICalled" && m.params.type !== "log") log("  [page]", m.params.args.map(a => a.value ?? a.description ?? "").join(" ").slice(0, 200)); });
		await cdp.call("Page.navigate", { url: `http://localhost:${vport}/tests/tool-las2splat.html?${q}` });
		const t1 = performance.now(); let title = "", last = "";
		while (!/^(PASS|FAIL)/.test(title)) {
			if (cdp.dead()) throw new Error("chrome died (GPU process / OOM?)");
			if (performance.now() - t1 > opts.timeout * 1000) throw new Error(`timeout ${opts.timeout}s: ${title.slice(0, 200)}`);
			await new Promise(r => setTimeout(r, 500));
			title = (await cdp.send("Runtime.evaluate", { expression: "document.title", returnByValue: true }))?.result?.value || "";
			const st = /\[([^\]]*)\]/.exec(title)?.[1]; if (st && st !== last) { last = st; log(`  ${st}`); }
		}
		cdp.close();
		if (title.startsWith("FAIL")) throw new Error(title.slice(5));
		const r = JSON.parse(title.slice(5));
		log(`gpu: ${r.points.toLocaleString()} points → ${r.n.toLocaleString()} splats in ${r.levels.length} levels (${r.levels.join("/")}) · read ${r.ms.read} ms · build ${r.ms.build} ms · backend ${r.backend}`);
		if (!written.length) throw new Error("the page wrote nothing");
	} finally { await ch?.close(); stopVite(); srv.close(); }
}

// ── CPU＝node だけ（参照実装・遅い） ──
async function viaCpu() {
	const { parseHeader, listVlrs, readRecords, geoKeysEpsg, hasRgb } = await import(path.join(ROOT, "packages/tile-formats/src/las.ts"));
	const { decodeLazFile } = await import(path.join(ROOT, "packages/tile-formats/src/laz.ts"));
	const { resolveCrs } = await import(path.join(ROOT, "packages/globe/src/pointcloud-crs.ts"));
	const { dumpEnu, dumpStride } = await import(path.join(ROOT, "packages/globe/src/copc-place.ts"));
	const { unzipPointCloud } = await import(path.join(ROOT, "packages/globe/src/pointcloud-zip.ts"));
	const { loadGeoid, geoidHeight } = await import(path.join(ROOT, "packages/ortho-core/src/geoid.ts"));
	const { colorize, cloudPlan, buildCloudCpu, cloudTo3DTiles, cloudToSpz, spzPlacement } = await import(path.join(ROOT, "sdk/splat/src/index.ts"));
	let bytes = new Uint8Array(fs.readFileSync(input));
	if (bytes[0] === 0x50 && bytes[1] === 0x4b) {   // ZIP → 中の LAS/LAZ（globe の unzipPointCloud＝Source の形を手元のバイトで）
		const src = { head: bytes.subarray(0, 65536), size: bytes.length, read: async (o, n) => bytes.slice(o, o + n), etag: null, metrics: { rangeRequests: 0, coalescedFrom: 0, bytesFetched: 0 } };
		const { blob, name: inner } = await unzipPointCloud(src, {});
		log(`zip: ${inner} (${(blob.size / 1048576).toFixed(1)} MB)`); bytes = new Uint8Array(await blob.arrayBuffer());
	}
	const hdr = parseHeader(bytes), vlrs = listVlrs(bytes, hdr.headerSize, hdr.vlrCount);
	const wktV = vlrs.find(v => v.userId === "LASF_Projection" && v.recordId === 2112), gk = vlrs.find(v => v.userId === "LASF_Projection" && v.recordId === 34735);
	const wkt = wktV ? new TextDecoder().decode(bytes.subarray(wktV.offset, wktV.offset + wktV.length)).replace(/\0[\s\S]*$/, "") : null;
	const r = resolveCrs({ wkt, geoKeys: gk ? geoKeysEpsg(bytes, gk.offset, gk.length) : null, crs: opts.crs, vertical: opts.vertical });
	log(`las ${hdr.version.join(".")} format ${hdr.format} · ${hdr.pointCount.toLocaleString()} points · ${r.label} (${r.from}) · ${r.verticalName}`);
	const c = r.ll([(hdr.min[0] + hdr.max[0]) / 2, (hdr.min[1] + hdr.max[1]) / 2]);
	let dz = 0; if (!r.orthometric) { await loadGeoid(); dz = -(geoidHeight(c[0], c[1]) || 0); }
	const anchor = [c[0], c[1], (hdr.min[2] + hdr.max[2]) / 2 * r.vUnit + dz];
	const stride = dumpStride(hdr.pointCount, opts.maxPoints), n = Math.ceil(hdr.pointCount / stride);
	const out = { pts: new Float32Array(n * 3), elev: new Float32Array(n), at: 0, bb: [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity] };
	const rgb = hasRgb(hdr.format) ? new Uint8Array(n * 3) : null, intensity = new Uint16Array(n), cls = new Uint8Array(n);
	let shift = -1, seen = 0;
	const take = (rec, count) => {   // 等間隔に間引いて東北上へ（copc-worker の dump と同じ）
		const all = readRecords(rec, count, hdr), k = [];
		for (let i = 0; i < count; i++, seen++) if (seen % stride === 0) k.push(i);
		if (!k.length) return;
		const x = new Float64Array(k.length), y = new Float64Array(k.length), z = new Float64Array(k.length), at = out.at;
		k.forEach((i, j) => { x[j] = all.x[i]; y[j] = all.y[i]; z[j] = all.z[i]; cls[at + j] = all.classification[i]; intensity[at + j] = all.intensity[i]; });
		if (rgb && all.rgb) { if (shift < 0) { let mx = 0; for (const v of all.rgb) if (v > mx) mx = v; shift = mx > 255 ? 8 : 0; } k.forEach((i, j) => { rgb[(at + j) * 3] = all.rgb[i * 3] >> shift; rgb[(at + j) * 3 + 1] = all.rgb[i * 3 + 1] >> shift; rgb[(at + j) * 3 + 2] = all.rgb[i * 3 + 2] >> shift; }); }
		dumpEnu({ x, y, z }, k.length, { ll: r.ll, vUnit: r.vUnit, dz, anchor }, out);
	};
	const t1 = performance.now();
	if (hdr.compressed || vlrs.some(v => v.userId === "laszip encoded")) {
		const { createLazPerf } = await import("laz-perf");
		decodeLazFile(await createLazPerf(), bytes, take);
	} else {
		const L = hdr.recordLength, B = 1 << 18;
		for (let i = 0; i < hdr.pointCount; i += B) { const k = Math.min(B, hdr.pointCount - i); take(bytes.subarray(hdr.pointOffset + i * L, hdr.pointOffset + (i + k) * L), k); }
	}
	const N = out.at;
	log(`read: ${N.toLocaleString()} of ${hdr.pointCount.toLocaleString()} points in ${Math.round(performance.now() - t1)} ms (stride ${stride})`);
	const rgba = colorize({ n: N, rgb, elev: out.elev, intensity, cls }, opts.color, { opacity: opts.opacity });
	const plan = cloudPlan(N, out.bb, { detail: opts.detail, levels: opts.levels });
	const t2 = performance.now(), levels = buildCloudCpu(out.pts, rgba, N, plan);
	log(`cpu: ${levels.map(l => l.n.toLocaleString()).join("/")} splats in ${levels.length} levels · cell0 ${plan.cell0.toFixed(2)} m · ${Math.round(performance.now() - t2)} ms`);
	await writeOut({ anchor, levels }, { cloudTo3DTiles, cloudToSpz, spzPlacement });
}
async function writeOut(cloud, { cloudTo3DTiles, cloudToSpz, spzPlacement }) {
	const files = [];
	if (opts.format !== "spz") files.push(...await cloudTo3DTiles(cloud));
	if (opts.format !== "tiles") files.push({ name: `${name}.spz`, bytes: await cloudToSpz(cloud, 0) }, { name: "placement.json", bytes: new TextEncoder().encode(JSON.stringify(spzPlacement(cloud), null, "\t")) });
	for (const f of files) { fs.writeFileSync(path.join(outDir, f.name), f.bytes); log(`  wrote ${f.name} (${(f.bytes.length / 1048576).toFixed(1)} MB)`); }
}
