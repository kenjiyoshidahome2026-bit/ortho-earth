// equal の GL ⇄ GPU 突き合わせ（gpu-parity.html から）。データは t-bake.mjs と同じ手組みの GintBUF（回線に頼らない）。
import { bakeLayer, bakeGraticule } from "../src/bake.js";
import { createRenderer } from "../src/renderer.js";
import { createRendererGPU } from "../src/renderer-gpu.js";
import { resolveWorldPal } from "@ortho-earth/core/worldpal";

const spread16 = x => { x &= 0xFFFF; x = (x | (x << 8)) & 0x00FF00FF; x = (x | (x << 4)) & 0x0F0F0F0F; x = (x | (x << 2)) & 0x33333333; x = (x | (x << 1)) & 0x55555555; return x >>> 0; };
const morton = (ix, iy) => { const xl = spread16(ix & 0xFFFF), xh = spread16(ix >>> 16), yl = spread16(iy & 0xFFFF), yh = spread16(iy >>> 16); return (BigInt((xh | (yh << 1)) >>> 0) << 32n) | BigInt((xl | (yl << 1)) >>> 0); };
const wrap = lon => ((lon + 180) % 360 + 360) % 360 - 180;
const ixy = (lon, lat) => [Math.round((wrap(lon) + 180) * 1e7) >>> 0, Math.round((lat + 90) * 1e7) >>> 0];
const V = (lon, lat) => { const [ix, iy] = ixy(lon, lat); return morton(ix, iy) | (1n << 63n); };
// 多角形の輪（閉じた折れ線・step 度で細分）
const ring = (pts, step = 2) => {
	const out = [];
	for (let i = 0; i < pts.length; i++) {
		const [a, b] = [pts[i], pts[(i + 1) % pts.length]];
		const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
		for (let k = 0; k < n; k++) out.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
	}
	out.push(out[0]);
	return out.map(([x, y]) => V(x, y));
};
const star = (cx, cy, r0, r1, n) => [...Array(n * 2)].map((_, i) => { const a = Math.PI * i / n, r = i % 2 ? r0 : r1; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; });
const arcs = [
	ring([[20, -10], [60, -10], [60, 40], [20, 40]]),            // 0 国 A 外環（反時計回り）
	ring([[30, 5], [30, 15], [40, 15], [40, 5]]),                // 1 国 A の穴（時計回り）
	ring([[160, 50], [200, 50], [200, 70], [160, 70]]),          // 2 国 B＝裏経線を跨ぐ
	ring(star(-60, -15, 12, 28, 7), 1),                           // 3 国 C＝星形（凹）
	ring([[100, -30], [140, -30], [120, 10]]),                    // 4 湖（drawFill）
];
const arcBuffer = BigUint64Array.from(arcs.flat());
const arcMeta = new Uint32Array(arcs.length * 8); let off = 0; arcs.forEach((a, i) => { arcMeta[i * 8] = off; arcMeta[i * 8 + 1] = a.length; off += a.length; });
const polyStream = Int32Array.from([0, 2, 1, 0, 1, 1, /**/ 1, 1, 1, 2, /**/ 2, 1, 1, 3, /**/ 3, 1, 1, 4]);
const pbf = { unPackGint: { arcBuffer, arcMeta, polyStream, lineStream: null, pointBuffer: null, point: null }, getProperties: fid => ({ key: fid }) };
const countries = bakeLayer(pbf, { kind: "poly", include: p => p.key < 3, fill: () => 0, unit: p => p.key, outline: () => ({ cls: 0, minZoom: 0 }) });
const lakes = bakeLayer(pbf, { kind: "poly", include: p => p.key === 3, fill: () => 0, unit: () => 0, outline: () => ({ cls: 0, minZoom: 0 }) });
const grat = bakeGraticule();
const points = Uint32Array.from([[0, 0], [45, 20], [179, 60], [-60, -15], [120, -10], [-150, 30]].flatMap(([lon, lat], i) => [...ixy(lon, lat), i % 2]));

// 標高（R90 の代わり）・近景窓・気候場・塗り表
const EW = 360, EH = 180, elev = new Float32Array(EW * EH);
for (let y = 0; y < EH; y++) for (let x = 0; x < EW; x++) { const lon = x - 180, lat = y - 90; elev[y * EW + x] = Math.max(0, 3500 * Math.sin(lon * 0.09) * Math.cos(lat * 0.06) + 800 * Math.sin(lat * 0.3)); }
const NW = 128, near = new Float32Array(NW * NW);
for (let y = 0; y < NW; y++) for (let x = 0; x < NW; x++) near[y * NW + x] = 2000 + 1800 * Math.sin(x * 0.2) * Math.cos(y * 0.15);
const clim = document.createElement("canvas"); clim.width = 64; clim.height = 32;
{ const c = clim.getContext("2d"); const g = c.createLinearGradient(0, 0, 64, 32); g.addColorStop(0, "#f00"); g.addColorStop(0.5, "#0a0"); g.addColorStop(1, "#ff0"); c.fillStyle = g; c.fillRect(0, 0, 64, 32); }
const paint = Uint8Array.from([200, 40, 40, 255, 40, 200, 40, 255, 40, 40, 200, 255, 0, 0, 0, 0]);
const pal = resolveWorldPal();

const W = 480, H = 300;
const SCENES = [
	{ name: "world z0", view: { lon: 10, lat: 5, zoom: 0 }, hypso: 1, choro: 0.7, hover: 1 },
	{ name: "seam z1.5", view: { lon: 175, lat: 45, zoom: 1.5 }, hypso: 0.6, choro: 0.5, hover: -1 },
	{ name: "near z3", view: { lon: 35, lat: 10, zoom: 3 }, hypso: 1, choro: 0, hover: 0, near: true },
	{ name: "morph t0.4", view: { lon: 0, lat: 10, zoom: 0.5 }, morph: { t: 0.4, ppuS: 150, lat: 0.3, cam: 3, dlon: 10 } },
	{ name: "morph t0", view: { lon: 0, lat: 10, zoom: 0.5 }, morph: { t: 0, ppuS: 150, lat: 0.3, cam: 3, dlon: 0 } },
];
const PROBES = [[258, 132], [197, 165], [318, 108], [240, 150], [100, 200], [400, 60], [350, 220]];   // 国 A・C・B の上＋海・外形の外

function setup(R) {
	const vtx = R.uploadVertices(countries.xy, countries.vertexCount);
	const gv = R.uploadVertices(grat.xy, grat.vertexCount);
	const ct = countries.tier(0), lt = lakes.tier(0), gt = grat.tier(0);
	const S = { vtx, gv, cl: R.instanceVAO(ct.lines, 3), cf: R.instanceVAO(ct.fills, 4), lf: R.instanceVAO(lt.fills, 4), gl: R.instanceVAO(gt.lines, 3), pts: R.instanceVAO(points, 3) };
	R.setElevation(elev, EW, EH); R.setClimate(clim); R.setPaint(paint, 4);
	return S;
}
function draw(R, S, sc) {
	R.setNearElevation(sc.near ? { data: near, width: NW, height: NW, bounds: [25, 0, 20, 20] } : null);
	R.beginFrame(sc.view, [0.1, 0.1, 0.12], sc.morph || null);
	if (sc.morph) {
		R.drawLines(S.vtx, S.cl, [{ color: [1, 1, 1, 0.9], width: 0.8 }]);
		R.drawLines(S.gv, S.gl, [{ color: [1, 1, 1, 0.35], width: 0.6 }, { color: [1, 1, 1, 0.35], width: 0.6 }]);
		R.drawPoints(S.pts, [{ color: [1, 0.3, 0.1, 1], size: 8 }, { color: [0.1, 0.4, 1, 1], size: 5 }]);
		return;
	}
	R.drawSea([0.55, 0.7, 0.85], [0.1, 0.1, 0.12], [0.2, 0.25, 0.3, 0.8]);
	R.drawIds(S.vtx, S.cf);
	R.drawLand({ land: [0.93, 0.92, 0.88], hypso: sc.hypso, pal });
	R.drawChoropleth({ alpha: sc.choro, hover: sc.hover });
	R.drawFill(S.vtx, S.lf, [0.4, 0.6, 0.9, 0.9]);
	R.drawLines(S.vtx, S.cl, [{ color: [0.2, 0.2, 0.2, 1], width: 1.2 }]);
	R.drawLines(S.gv, S.gl, [{ color: [0, 0, 0, 0.3], width: 0.6 }, { color: [0, 0, 0, 0.2], width: 0.5 }]);
	R.drawPoints(S.pts, [{ color: [1, 0.3, 0.1, 1], size: 8 }, { color: [0.1, 0.4, 1, 1], size: 5 }]);
}
const mk = () => { const c = document.createElement("canvas"); c.style.width = W + "px"; c.style.height = H + "px"; document.getElementById("row").append(c); return c; };
const pixelsGL = R => { const gl = R.gl, w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, p = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, p); const o = new Uint8Array(p.length); for (let y = 0; y < h; y++) o.set(p.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4); return o; };
const pixelsGPU = (R, canvas) => { R.flush(); const c = document.createElement("canvas"); c.width = canvas.width; c.height = canvas.height; const x = c.getContext("2d"); x.drawImage(canvas, 0, 0); return x.getImageData(0, 0, c.width, c.height).data; };

const out = document.getElementById("out"), res = { scenes: [], ok: true };
try {
	const cg = mk(), cp = mk(), cd = mk();
	const RG = createRenderer(cg), RP = await createRendererGPU(cp);
	if (!RP) throw new Error("WebGPU renderer unavailable");
	res.hasFloatId = { gl: RG.hasFloatId, gpu: RP.hasFloatId };
	const SG = setup(RG), SP = setup(RP);
	await new Promise(r => setTimeout(r, 50));   // 気候場の copyExternalImage を待つ必要はない（queue 順）が、GL 側の画像も揃える
	const shots = [];
	for (const sc of SCENES) {
		draw(RG, SG, sc); const a = pixelsGL(RG);
		const fidG = PROBES.map(([x, y]) => RG.readFid(x, y));
		draw(RP, SP, sc); const b = pixelsGPU(RP, cp);
		const fidP = await Promise.all(PROBES.map(([x, y]) => RP.readFid(x, y)));
		let n8 = 0, n32 = 0, sum = 0, max = 0;
		const diff = new Uint8ClampedArray(a.length);
		for (let i = 0; i < a.length; i += 4) {
			const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
			sum += d; if (d > max) max = d; if (d > 8) n8++; if (d > 32) n32++;
			diff[i] = diff[i + 1] = diff[i + 2] = Math.min(255, d * 8); diff[i + 3] = 255;
		}
		const px = a.length / 4;
		const r = { name: sc.name, mean: +(sum / px).toFixed(3), max, over8: +(100 * n8 / px).toFixed(3), over32: +(100 * n32 / px).toFixed(3), fidG, fidP, fidSame: fidG.every((v, i) => v === fidP[i]) };
		r.ok = r.fidSame && r.over32 < 0.5 && r.mean < 1.5;
		res.ok &&= r.ok; res.scenes.push(r);
		const toURL = px4 => { const c = document.createElement("canvas"); c.width = cp.width; c.height = cp.height; c.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(px4), c.width, c.height), 0, 0); return c.toDataURL(); };
		shots.push({ name: sc.name, gl: toURL(a), gpu: toURL(b), diff: toURL(diff) });
	}
	// float32-blendable の無い機体＝ステンシルの陸マスク（コロプレス/ホバー無し）。陸の絵は ID 経路と同じになるはず
	{
		const cs = mk(), RS = await createRendererGPU(cs, { noFloatId: true }), SS = setup(RS);
		const sc = { ...SCENES[0], choro: 0, hover: -1 };
		draw(RG, SG, sc); const a = pixelsGL(RG);
		draw(RS, SS, sc); const b = pixelsGPU(RS, cs);
		let sum = 0, n32 = 0; for (let i = 0; i < a.length; i += 4) { const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])); sum += d; if (d > 32) n32++; }
		const r = { name: "stencil fallback", hasFloatId: RS.hasFloatId, mean: +(sum / (a.length / 4)).toFixed(3), over32: +(100 * n32 / (a.length / 4)).toFixed(3), fid: await RS.readFid(258, 132) };
		r.ok = !RS.hasFloatId && r.over32 < 0.5 && r.mean < 1.5 && r.fid === -1;
		res.ok &&= r.ok; res.scenes.push(r);
	}
	res.shots = shots;
	// フレーム内に 128 描画を超える（リングの途中 submit）でも崩れないか
	RP.beginFrame(SCENES[0].view, [0, 0, 0]);
	for (let i = 0; i < 300; i++) RP.drawLines(SP.gv, SP.gl, [{ color: [1, 1, 1, 0.01], width: 0.6 }]);
	RP.flush();
	res.ringOk = true;
} catch (e) { res.ok = false; res.error = String(e.stack || e); }
window.__parity = res;
out.textContent = JSON.stringify({ ...res, shots: undefined }, null, 1);
