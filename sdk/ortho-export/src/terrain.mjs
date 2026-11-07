// 地形メッシュ（docs/notes/unity-roundtrip.md §3.1）：航空写真（か標準地図）のタイルごとに 1 枚の面を作り、標高（DEM＋ジオイド）で持ち上げる。
//   画像は束ねない（依存ゼロ＝画像の解読と再圧縮をしない）＝タイル 1 枚＝材質 1 つ・uv 0..1。2〜3 街区・z17 なら 4〜16 枚。
//   頂点は錨の glTF 座標（E, U, −N）。地球の丸みは ECEF 経由で自然に乗る。
import { lonLatToEcef, tileRange, lonToX, latToY, xToLon, yToLat } from "./geo.mjs";

export const GSI_IMAGERY = {
	seamlessphoto: { template: "https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg", mime: "image/jpeg", maxZoom: 18, name: "全国最新写真（シームレス）" },
	std: { template: "https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png", mime: "image/png", maxZoom: 18, name: "標準地図" },
	pale: { template: "https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png", mime: "image/png", maxZoom: 18, name: "淡色地図" },
};

/**
 * @param {object} o
 * @param {number[]} o.bbox  [w,s,e,n]（度）
 * @param {object} o.anchor  makeAnchor の戻り
 * @param {object} o.dem     createDem の戻り（heightAt＝ジオイド上の標高）
 * @param {number} o.geoid   ジオイド高（m）＝楕円体高＝標高＋geoid
 * @param {number} o.zoom    画像タイルの z（既定 17）
 * @param {{template,mime}|null} o.imagery  null＝テクスチャなし（1 枚の面）
 * @param {number} o.segments  タイル 1 枚あたりの分割数（既定 32）
 * @returns {Promise<{ prims: ScenePrim[], tiles: number, vertices: number }>}
 */
export async function buildTerrain({ bbox, anchor, dem, geoid = 0, zoom = 17, imagery = GSI_IMAGERY.seamlessphoto, segments = 32, fetchFn = (u, i) => fetch(u, i), concurrency = 6 }) {
	await dem.prefetch(bbox);
	const z = imagery ? Math.min(zoom, imagery.maxZoom ?? zoom) : zoom;
	const { x0, y0, x1, y1 } = tileRange(bbox, z);
	// bbox をタイル座標（z・連続値）で
	const bx0 = lonToX(bbox[0], z), bx1 = lonToX(bbox[2], z), by0 = latToY(bbox[3], z), by1 = latToY(bbox[1], z);
	const jobs = [];
	for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) jobs.push({ tx, ty });
	const prims = new Array(jobs.length); let vertices = 0, ji = 0;
	const one = async (i) => {
		const { tx, ty } = jobs[i];
		// タイルと bbox の交わり（タイル内の 0..1）
		const u0 = Math.max(0, bx0 - tx), u1 = Math.min(1, bx1 - tx), v0 = Math.max(0, by0 - ty), v1 = Math.min(1, by1 - ty);
		if (u1 <= u0 || v1 <= v0) return;
		const nu = Math.max(1, Math.round(segments * (u1 - u0))), nv = Math.max(1, Math.round(segments * (v1 - v0)));
		const W = nu + 1, H = nv + 1, n = W * H;
		const positions = new Float32Array(n * 3), uvs = new Float32Array(n * 2), lls = new Array(n);
		for (let j = 0; j < H; j++) for (let i2 = 0; i2 < W; i2++) {
			const u = u0 + (u1 - u0) * i2 / nu, v = v0 + (v1 - v0) * j / nv;
			lls[j * W + i2] = [xToLon(tx + u, z), yToLat(ty + v, z)];
			uvs[(j * W + i2) * 2] = u; uvs[(j * W + i2) * 2 + 1] = v;   // glTF の uv は左上が原点＝タイル画像と同じ向き
		}
		const hs = await Promise.all(lls.map(([ln, lt]) => dem.heightAt(ln, lt)));
		for (let k = 0; k < n; k++) { const p = anchor.toGltf(lonLatToEcef(lls[k][0], lls[k][1], hs[k] + geoid)); positions[k * 3] = p[0]; positions[k * 3 + 1] = p[1]; positions[k * 3 + 2] = p[2]; }
		const indices = new Uint32Array(nu * nv * 6); let o = 0;
		for (let j = 0; j < nv; j++) for (let i2 = 0; i2 < nu; i2++) {
			const a = j * W + i2, b = a + 1, c = a + W, d = c + 1;
			indices[o++] = a; indices[o++] = c; indices[o++] = b;   // 上（+Y）から見て反時計回り＝表が上を向く
			indices[o++] = b; indices[o++] = c; indices[o++] = d;
		}
		const normals = smoothNormals(positions, indices);
		let image = null;
		if (imagery) {
			const url = imagery.template.replace("{z}", z).replace("{x}", tx).replace("{y}", ty);
			const r = await fetchFn(url, {});
			if (r.ok) image = { mime: imagery.mime, bytes: new Uint8Array(await r.arrayBuffer()) };
		}
		prims[i] = { positions, normals, uvs, colors: null, indices, material: { name: `terrain_${z}_${tx}_${ty}`, baseColor: image ? [1, 1, 1, 1] : [0.55, 0.6, 0.5, 1], doubleSided: false, image } };
		vertices += n;
	};
	await Promise.all(Array.from({ length: concurrency }, async () => { while (ji < jobs.length) await one(ji++); }));
	return { prims: prims.filter(Boolean), tiles: jobs.length, vertices, zoom: z };
}

/** 面法線を頂点に積んで正規化 */
export function smoothNormals(pos, idx) {
	const n = new Float32Array(pos.length);
	for (let t = 0; t < idx.length; t += 3) {
		const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
		const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2], vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
		const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
		for (const i of [a, b, c]) { n[i] += nx; n[i + 1] += ny; n[i + 2] += nz; }
	}
	for (let i = 0; i < n.length; i += 3) { const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1; n[i] /= l; n[i + 1] /= l; n[i + 2] /= l; }
	return n;
}
