// I3S（ArcGIS の Indexed 3D Scene Layer）の解読（#48・2026-09-23）＝model-worker（kind:"i3s"）の中で走る。
// 節点の木（nodepages）の読みと中身（ジオメトリ・テクスチャ）の解読は @loaders.gl/i3s（MIT）に任せ、出た頂点（ECEF）を
// PLATEAU・模型・3D Tiles と同じ後段（meshdecode の finishMesh）に通す＝GPU の meshSet にそのまま載る。
// 選び（どの節点を描くか）は main（gadgets/i3s.js）。ここは「節点の見出し」と「中身」を返すだけ。
// 外部に取りに行かない設定：worker:false（loaders.gl の worker を CDN から起こさない）・useCompressedTextures:false（KTX2/Basis の変換器を CDN から取らない＝jpg/png を選ぶ）・
// decodeTextures:false（画像は生のバイト列で受けて createImageBitmap で復号）。Draco の復号器は PLATEAU の経路と同じ loaders.gl の既定。
// 対応は nodepages 形式（I3S 1.6 以降）の 3D Object / IntegratedMesh。点群（PointCloud）と旧形式（nodes/root）は未対応。
import { finishMesh, ecef2geo } from "./meshdecode.js";
let _l = null;
const L = () => _l ??= import("./i3s-loaders.js");   // loaders.gl の i3s は最初の I3S を読む時だけ

const I3S_OPTS = { worker: false, i3s: { useDracoGeometry: true, useCompressedTextures: false, decodeTextures: false, coordinateSystem: 0 } };   // coordinateSystem 0＝METER_OFFSETS（頂点が ECEF で来る）
const sets = new Map();   // layer URL → Promise<tileset>
function openLayer(url, token) {
	if (!sets.has(url)) sets.set(url, (async () => {
		const { parse, I3SLoader } = await L();
		const r = await fetch(url, { credentials: "omit" });
		if (!r.ok) throw new Error(`I3S layer HTTP ${r.status}`);
		const ts = await parse(await r.arrayBuffer(), I3SLoader, { ...I3S_OPTS, i3s: { ...I3S_OPTS.i3s, isTileset: true, isTileHeader: false, token } }, { url });
		if (!ts.nodePagesTile) throw new Error("I3S: only node-page layers (I3S 1.6+) are supported");
		return ts;
	})().catch(err => { sets.delete(url); throw err; }));
	return sets.get(url);
}
// 節点の見出し＝{ id, c:[lon,lat,h], r(m), thr(px の直径), kids:[id], mesh }
function summary(node, metric) {
	const hs = node.obb?.halfSize || [0, 0, 0], c = node.obb?.center || node.mbs?.slice(0, 3) || [0, 0, 0];
	const r = node.mbs ? node.mbs[3] : Math.hypot(hs[0], hs[1], hs[2]);
	const thr = metric === "maxScreenThresholdSQ" ? Math.sqrt((node.lodThreshold || 0) / (Math.PI * 0.25)) : (node.lodThreshold || 0);
	return { id: node.index, c, r, thr, kids: node.children || [], mesh: !!node.mesh?.geometry };
}
export async function i3sOpen(url, token) {
	const ts = await openLayer(url, token), tp = ts.nodePagesTile;
	const root = await tp.getNodeById(0);
	return { root: summary(root, tp.lodSelectionMetricType), name: ts.name || ts.layerType || null, layerType: ts.layerType, metric: tp.lodSelectionMetricType, copyright: ts.copyrightText || null };
}
export async function i3sNodes(url, ids, token) {
	const ts = await openLayer(url, token), tp = ts.nodePagesTile;
	return Promise.all(ids.map(async id => summary(await tp.getNodeById(id), tp.lodSelectionMetricType)));
}
// 中身 → { batches:[{ mesh, tex, alphaMode, alphaCutoff }], stats }
export async function i3sContent(url, id, { baseH = 0, ground = "absolute", token } = {}) {
	const ts = await openLayer(url, token), { parse, I3SLoader } = await L();
	const tile = await ts.nodePagesTile.formTileFromNodePages(id);
	if (!tile.contentUrl) return { batches: [], stats: { triangles: 0 } };
	const r = await fetch(tile.contentUrl, { credentials: "omit" });
	if (!r.ok) throw new Error(`I3S geometry HTTP ${r.status}`);
	const content = await parse(await r.arrayBuffer(), I3SLoader, { ...I3S_OPTS, i3s: { ...I3S_OPTS.i3s, isTileset: false, isTileHeader: false, _tileOptions: tile, _tilesetOptions: ts, token } }, { url: tile.contentUrl });
	const A = content.attributes || {}, P = A.positions?.value;
	if (!P || !P.length) return { batches: [], stats: { triangles: 0 } };
	const n = P.length / 3;
	// 三角形の index（無ければ順番どおり）
	const idx = content.indices ? Uint32Array.from(content.indices) : Uint32Array.from({ length: n - n % 3 }, (_, i) => i);
	const geo = new Float64Array(n * 3);
	let minH = Infinity;
	for (let i = 0; i < n; i++) { const g = ecef2geo(P[i*3], P[i*3+1], P[i*3+2]); geo[i*3] = g[0]; geo[i*3+1] = g[1]; geo[i*3+2] = g[2]; if (g[2] < minH) minH = g[2]; }
	// 法線＝面を頂点へ積んで ECEF(x,y,z)→この地図の世界軸(x,z,y)（I3S の法線の座標系は層で違う＝自分で作るのが確実）
	const nE = new Float64Array(n * 3);
	for (let k = 0; k + 2 < idx.length; k += 3) {
		const a = idx[k], b = idx[k+1], c = idx[k+2];
		const ux = P[b*3] - P[a*3], uy = P[b*3+1] - P[a*3+1], uz = P[b*3+2] - P[a*3+2], vx = P[c*3] - P[a*3], vy = P[c*3+1] - P[a*3+1], vz = P[c*3+2] - P[a*3+2];
		const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
		for (const v of [a, b, c]) { nE[v*3] += fx; nE[v*3+1] += fy; nE[v*3+2] += fz; }
	}
	const nrm = new Int8Array(n * 4);
	for (let i = 0; i < n; i++) { const x = nE[i*3], y = nE[i*3+2], z = nE[i*3+1], l = Math.hypot(x, y, z); if (l > 0) { const s = 127 / l; nrm[i*4] = Math.round(x * s); nrm[i*4+1] = Math.round(y * s); nrm[i*4+2] = Math.round(z * s); } else nrm[i*4+1] = 127; }
	// uv（uvRegion＝テクスチャ集積の小窓があればその中へ畳む）と頂点色（baseColorFactor×color）
	const T = A.texCoords?.value, R = A.uvRegions?.value, C = A.colors?.value;
	const mat = content.material || null, f = mat?.pbrMetallicRoughness?.baseColorFactor || [1, 1, 1, 1];
	const uv = new Float32Array(n * 2), col = new Uint8Array(n * 4);
	const rq = R ? (R instanceof Uint16Array ? 1 / 65535 : 1) : 1;
	for (let i = 0; i < n; i++) {
		let u = T ? T[i*2] : 0, v = T ? T[i*2+1] : 0;
		if (R) { const u0 = R[i*4] * rq, v0 = R[i*4+1] * rq, u1 = R[i*4+2] * rq, v1 = R[i*4+3] * rq; u = u0 + (u - Math.floor(u)) * (u1 - u0); v = v0 + (v - Math.floor(v)) * (v1 - v0); }
		uv[i*2] = u; uv[i*2+1] = v;
		const cr = C ? C[i*4] / 255 : 1, cg = C ? C[i*4+1] / 255 : 1, cb = C ? C[i*4+2] / 255 : 1, ca = C ? C[i*4+3] / 255 : 1;
		col[i*4] = Math.round(255 * Math.min(1, f[0] * cr)); col[i*4+1] = Math.round(255 * Math.min(1, f[1] * cg)); col[i*4+2] = Math.round(255 * Math.min(1, f[2] * cb)); col[i*4+3] = Math.round(255 * Math.min(1, (f[3] ?? 1) * ca));
	}
	// テクスチャ＝生のバイト列（jpg/png）→ ImageBitmap
	const raw = mat?.pbrMetallicRoughness?.baseColorTexture?.texture?.source?.image ?? content.texture;
	let tex = null;
	if (raw && (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw))) { try { tex = { bitmap: await createImageBitmap(new Blob([raw])) }; } catch { /* 復号できない形式（圧縮テクスチャ等）＝色だけで描く */ } }
	const mesh = finishMesh(geo, nrm, idx, ground === "terrain" ? minH : baseH, null, null, true, { uv, col }, ground !== "terrain");
	const alphaMode = (mat?.alphaMode || "OPAQUE").toUpperCase();
	return { batches: [{ mesh, tex, alphaMode, alphaCutoff: mat?.alphaCutoff ?? 0.5 }], stats: { triangles: idx.length / 3, vertices: n } };
}
