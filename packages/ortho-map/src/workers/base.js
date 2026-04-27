import nativeBucket from "native-bucket";
import { geoOrthographic } from "./geoOrthoGraphic.js";
import { orthoGL2 } from "./orthoGL2.js";
import { Layers } from "../modules/Layers.js";

const { Bucket, Cache } = nativeBucket();

const proj = geoOrthographic();
let bucket, cache, canvas, gl, width, height;
let isMoving = false;

let baseName = "", baseTexture = null;

const { PI, floor, ceil, max, min, round, hypot, sin, asin, sinh, tanh, atanh, atan, atan2, cos, abs, log2, sqrt } = Math;
const rad = PI / 180, deg = 180 / PI;

const src = async e => {
	try {
		const res = await fetch(e.data, { cache: 'force-cache' });
		if (!res.ok) return postMessage({ error: 'HTTP error' });
		const blob = await res.blob();
		const bm = await createImageBitmap(blob);
		postMessage({ bitmap: bm }, [bm]);
	} catch (err) {
		postMessage({ error: err.message });
	}
};
const workerURL = URL.createObjectURL(new Blob(["onmessage=" + src.toString()], { type: "application/javascript" }));

let minZoom, zoom, currentZoom;
let MasterTub = [], WorkerTub = [], TileTub = new Map(), urlTub = [], TileServer = null;
let layerSession = 0;

const funcs = { init, set, drawing, drawn, resize, destroy };
onmessage = e => funcs[e.data.type](e.data);

async function init(data) {
	canvas = data.offscreen;
	gl = orthoGL2(canvas.getContext("webgl2"), data.dpr);
	const dire = "GIS/base";
	bucket = bucket || await Bucket(dire);
	cache = cache || await Cache(dire);
	MasterTub = []; WorkerTub = [];
	for (let i = 0; i < data.workers; i++) {
		const w = new Worker(workerURL);
		MasterTub.push(w);
		WorkerTub.push(w);
	}
	delete data.offscreen;
	postMessage(Object.assign(data, { action: "done", type: "init", ctx: gl.constructor.name }));
}

async function set(data) {
	if (data.cmd === "base") {
		const bname = Layers[data.data].base;
		if (baseName === bname) return postMessage(Object.assign(data, { action: "done", type: "set" }));
		const dt = performance.now();
		let bm = await cache(bname);
		if (!bm) {
			baseTexture && gl.deleteTexture(baseTexture); baseTexture = null;
			await cache(bname, bm = await createImageBitmap(await bucket.get(bname)));
		}
		console.log(`[orth-earth] ✅ Base Image "${bname}" ${(performance.now()-dt).toFixed(2)} msec`);
		baseTexture && gl.deleteTexture(baseTexture); baseTexture = null;
		baseTexture = gl.createBaseTexture(bm);
		bm = null; baseName = bname;
		drawing();
	////--------------------------------------------------
		layerSession++;
		minZoom = data.prop;
		const count = MasterTub.length;
		MasterTub.forEach(t => t.terminate());
		MasterTub.length = 0; WorkerTub.length = 0;
		for (let i = 0; i < count; i++) {
			const w = new Worker(workerURL);
			MasterTub.push(w);
			WorkerTub.push(w);
		}
		if (urlTub) urlTub.length = 0;
		if (TileTub) {
			TileTub.forEach((img, key) => img && removeImage(img));
			TileTub.clear();
		}
		TileServer = createTileServer(Layers[data.data].tile);
		finalize();
		postMessage(Object.assign(data, { action: "done", type: "set" }));
	}
}

function resize(data) {
	gl.resizeBySize(width = data.width, height = data.height);
	proj.fitExtent([[1, 1], [width - 1, height - 1]], { type: "Sphere" });
	postMessage(Object.assign(data, { action: "done", type: "resize" }));
}

function drawing(data) {
	isMoving = true;
	if (data) {
		proj.rotate(data.rotate).scale(data.scale);
		zoom = log2(data.scale * PI * 2 / 256);
	}
	gl.clearContext();
	if (baseTexture) gl.drawBase(baseTexture, proj);
	if (TileServer && zoom > minZoom) {
		getTileArray().forEach(([key, [img, locs]]) => {
			if (img) {
				// ✅ ここでタイル専用の関数を使う
				img._glTexture = img._glTexture || gl.createTileTexture(img);
				for (let l of locs) gl.drawTile(img._glTexture, l[0], l[1]);
			}
		});
	}
}

function drawn() {
	isMoving = false;
	finalize();
}

function finalize() {
	gl.clearContext();
	if (baseTexture) gl.drawBase(baseTexture, proj);

	if (!TileTub || zoom <= minZoom) return;
	const keep = new Set();

	getTileArray().forEach(([key, [img, locs]]) => {
		if (!img) return;
		keep.add(key);
		// ✅ ここでタイル専用の関数を使う
		img._glTexture = img._glTexture || gl.createTileTexture(img);
		for (let l of locs) gl.drawTile(img._glTexture, l[0], l[1]);
	});

	urlTub.length || TileTub.forEach((img, key) => {
		if (keep.has(key) || img === null) return;
		if (!inside(key.split('_').map(Number))) {
			img && removeImage(img);
			TileTub.delete(key);
		}
	});

	function inside([x, y, z]) {
		const n = 1 << z, invN = 1 / n;
		const xmin = x * invN * 360 - 180, xmax = (x + 1) * invN * 360 - 180;
		const ymax = Math.atan(Math.sinh(PI * (1 - 2 * y * invN))) * deg;
		const ymin = Math.atan(Math.sinh(PI * (1 - 2 * (y + 1) * invN))) * deg;
		let p;
		p = proj([xmin, ymax]); if (p && p[0] >= 0 && p[0] <= width && p[1] >= 0 && p[1] <= height) return true;
		p = proj([xmax, ymax]); if (p && p[0] >= 0 && p[0] <= width && p[1] >= 0 && p[1] <= height) return true;
		p = proj([xmax, ymin]); if (p && p[0] >= 0 && p[0] <= width && p[1] >= 0 && p[1] <= height) return true;
		p = proj([xmin, ymin]); if (p && p[0] >= 0 && p[0] <= width && p[1] >= 0 && p[1] <= height) return true;
		p = proj([(xmin + xmax) / 2, (ymin + ymax) / 2]);
		if (p && p[0] >= 0 && p[0] <= width && p[1] >= 0 && p[1] <= height) return true;
		return false;
	}
}

function removeImage(img) {
	if (img._glTexture) {
		gl.deleteTexture(img._glTexture); img._glTexture = null;
	}
	if (img.close) img.close();
}

function destroy(data) {
	canvas && (canvas.width = 0, canvas.height = 0); canvas = null;
	WorkerTub.forEach(t => t.terminate()); WorkerTub.length = 0; WorkerTub = null;
	URL.revokeObjectURL(workerURL);
	TileTub && TileTub.forEach((img, key) => img && removeImage(img));
	TileTub = TileServer = null;
	baseTexture && gl.deleteTexture(baseTexture); baseTexture = null;
	gl = proj = null;
	postMessage(Object.assign(data, { action: "done", type: "destroy" }));
}

export function createTileServer(urlFunc) {
	const session = layerSession;
	const next = w => {
		const xyz = urlTub.shift();
		if (!xyz) return WorkerTub.push(w);
		const key = xyz.join("_");
		w.onmessage = e => {
			if (session !== layerSession) {
				if (e.data?.bitmap) e.data.bitmap.close();
				return;
			}
			if (e.data?.bitmap) {
				const img = e.data.bitmap;
				// ✅ ここでタイル専用の関数を使う
				img._glTexture = gl.createTileTexture(img);
				TileTub.set(key, img);
			} else {
				TileTub.set(key, false);
			}
			isMoving ? drawing() : finalize();
			next(w);
		};
		w.postMessage(urlFunc(xyz));
	};
	return v => {
		if (!urlTub.some(t => t.join() === v.join())) urlTub.push(v);
		const w = WorkerTub.shift();
		if (w) next(w);
	};
}

export function getTileArray() {
	if (zoom <= minZoom) return [];
	const Y2T = [0, 0, 0, 2, 4, 8, 18, 36, 74, 148, 296, 594, 1188, 2378, 4756, 9514, 19030, 38062, 76126, 152252, 304506, 609012, 1218024];
	const Y4T = [0, 0, 0, 0, 0, 4, 8, 20, 44, 88, 180, 360, 724, 1452, 2904, 5808, 11616, 23236, 46476, 92952, 185908, 371820, 743644];
	const Z0 = round(zoom), n = 1 << max(Z0, minZoom), ans = {}, ents = [], pad = 2;
	urlTub.forEach(xyz => {
		const key = xyz.join("_");
		if (TileTub.get(key) === null) TileTub.delete(key);
	});
	urlTub.length = 0;
	currentZoom = Z0;

	const lps = [0, 0.5, 1].flatMap(y => [0, 0.5, 1].map(x => proj.invert([x * width, y * height]))).filter(p => p);
	if (!lps.length) return {};
	const b = [min(...lps.map(p => p[0])), min(...lps.map(p => p[1])), max(...lps.map(p => p[0])), max(...lps.map(p => p[1]))],
		cS = (v) => max(-0.9999, min(0.9999, sin(v * rad))),
		xmin = floor((0.5 + b[0] / 360) * n) - pad, xmax = ceil((0.5 + b[2] / 360) * n) + pad,
		ymin = max(0, floor((1 - atanh(cS(b[3])) / PI) * n / 2) - pad),
		ymax = min(n - 1, ceil((1 - atanh(cS(b[1])) / PI) * n / 2) + pad),
		rL = xmax - xmin + 2, vC = [];

	for (let j = ymin; j <= ymax + 1; j++) {
		const lat = asin(tanh((1 - 2 * j / n) * PI)) / rad;
		for (let i = xmin; i <= xmax + 1; i++) vC.push(proj([(i / n) * 360 - 180, lat]));
	}

	const idx = min(Z0, Y2T.length - 1), Y2 = Y2T[idx], Y4 = Y4T[idx];
	for (let j = ymin; j <= ymax; j++) {
		const zo = (j < Y4 || n - j - 1 < Y4) ? 2 : (j < Y2 || n - j - 1 < Y2) ? 1 : 0, r0 = (j - ymin) * rL, r1 = r0 + rL;
		for (let i = xmin; i <= xmax; i++) {
			const o = i - xmin, p = [vC[r0 + o], vC[r0 + o + 1], vC[r1 + o + 1], vC[r1 + o]];
			if (p.every(v => v)) {
				const wf = 2 / width, hf = -2 / height, pos = new Float32Array([p[0][0] * wf - 1, p[0][1] * hf + 1, p[1][0] * wf - 1, p[1][1] * hf + 1, p[3][0] * wf - 1, p[3][1] * hf + 1, p[2][0] * wf - 1, p[2][1] * hf + 1]);
				ents.push([i, j, zo, pos, hypot((p[0][0] + p[2][0]) / 2 - width / 2, (p[0][1] + p[2][1]) / 2 - height / 2)]);
			}
		}
	}

	ents.sort((a, b) => a[4] - b[4]).forEach(([x, y, zo, pos, dist]) => {
		let req = false;
		for (let dz of [0, 1, 2, 3]) {
			const z = Z0 - (zo + dz); if (z < 0) continue;
			const name = `${x >> (zo + dz)}_${y >> (zo + dz)}_${z}`, img = TileTub.get(name), nz = 1 << (zo + dz);
			if (img) {
				const xx = ((x % nz) + nz) % nz, yy = y % nz, uv = new Float32Array([xx / nz, yy / nz, (xx + 1) / nz, yy / nz, xx / nz, (yy + 1) / nz, (xx + 1) / nz, (yy + 1) / nz]);
				(ans[name] = ans[name] || [img, []])[1].push([uv, pos]); return;
			}
			if (img === undefined && !req) {
				req = true;
				TileTub.set(name, null);
				TileServer(name.split("_").map(Number), dist);
			}
		}
	});
	return Object.entries(ans).sort((a, b) => {
		const zA = a[0].split("_")[2], zB = b[0].split("_")[2];
		return (zA == zB) ? (a[0] < b[0]) ? -1 : (a[0] > b[0]) ? 1 : 0 : zA - zB;
	});
}