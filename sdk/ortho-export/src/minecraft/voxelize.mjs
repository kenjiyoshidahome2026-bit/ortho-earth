// GLB（ortho-export の terrain.glb・buildings.glb）→ ブロックの格子（docs/notes/minecraft.md §3）。
//   座標：glTF の (E, U, −N) をそのまま Minecraft の (X, Y, Z)＝(東, 上, 南) に取る（向きの反転なし）。錨＝ブロック (0, yOrigin, 0)。
//   1 ブロック＝scale m。地形は柱（上面＝写真の色・その下 3 段は土・さらに下は石）。建物は面を塗る外殻＋床（floors m ごと）。
//   三角形は 0.4 ブロック以下の間隔で点を打ち、点の入ったマスにテクスチャの色を積む（平均→色の近いブロック）。
import { PAINT, SPECIAL, makeMatcher } from "./palette.mjs";

export const WORLD_MIN_Y = -64, WORLD_MAX_Y = 319;   // Java 1.18 以降・統合版 1.18 以降の地上界
/** 格子のブロックの番号：0＝空気・1..PAINT.length＝PAINT[i-1]・GRASS＝草ブロック */
export const AIR = 0, GRASS = PAINT.length + 1;
export const BLOCKS = [SPECIAL.air, ...PAINT, SPECIAL.grass];
const idOf = (b) => PAINT.indexOf(b) + 1;
const STONE = idOf(SPECIAL.stone), DIRT = idOf(SPECIAL.dirt), FLOOR = idOf(SPECIAL.floor);

const toSrgb = (c) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** 三角形に点を打つ：cb(x, y, z, u, v)。step＝点の間隔（m） */
function sampleTriangle(P, I, a, b, c, UV, step, cb) {
	const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2], bx = P[b * 3], by = P[b * 3 + 1], bz = P[b * 3 + 2], cx = P[c * 3], cy = P[c * 3 + 1], cz = P[c * 3 + 2];
	const L = Math.max(Math.hypot(bx - ax, by - ay, bz - az), Math.hypot(cx - ax, cy - ay, cz - az), Math.hypot(cx - bx, cy - by, cz - bz));
	const n = Math.max(1, Math.ceil(L / step));
	const au = UV ? UV[a * 2] : 0, av = UV ? UV[a * 2 + 1] : 0, bu = UV ? UV[b * 2] : 0, bv = UV ? UV[b * 2 + 1] : 0, cu = UV ? UV[c * 2] : 0, cv = UV ? UV[c * 2 + 1] : 0;
	for (let i = 0; i <= n; i++) for (let j = 0; j <= n - i; j++) {
		const s = i / n, t = j / n, r = 1 - s - t;
		cb(r * ax + s * bx + t * cx, r * ay + s * by + t * cy, r * az + s * bz + t * cz, r * au + s * bu + t * cu, r * av + s * bv + t * cv);
	}
}

/** 材質の色を返す関数：(u, v) → [r, g, b]（0..255・sRGB） */
async function colorSource(material, decodeImage, cache) {
	const k = material.baseColor || [1, 1, 1, 1];
	let img = null;
	if (material.image && decodeImage) {
		const key = material.image.bytes;
		if (!cache.has(key)) cache.set(key, decodeImage(material.image.bytes, material.image.mime).then(x => x, () => null));
		img = await cache.get(key);
	}
	if (!img) { const rgb = [toSrgb(k[0]), toSrgb(k[1]), toSrgb(k[2])]; return () => rgb; }
	const { w, h, px, bpp } = img, out = [0, 0, 0];
	// テクスチャ（sRGB）× baseColorFactor（線形）：factor が 1 の時は素の画素
	const f = [k[0], k[1], k[2]].map(x => x >= 0.999 ? 1 : toSrgb(x) / 255);
	return (u, v) => {
		let x = Math.floor((u - Math.floor(u)) * w), y = Math.floor((v - Math.floor(v)) * h);
		if (x >= w) x = w - 1; if (y >= h) y = h - 1;
		const o = (y * w + x) * bpp;
		out[0] = px[o] * f[0]; out[1] = px[o + 1] * f[1]; out[2] = px[o + 2] * f[2];
		return out;
	};
}

const sceneBox = (scenes) => {
	const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
	for (const s of scenes) for (const p of s.prims) for (let i = 0; i < p.positions.length; i += 3) for (let k = 0; k < 3; k++) { const v = p.positions[i + k]; if (v < b[k]) b[k] = v; if (v > b[3 + k]) b[3 + k] = v; }
	return b;
};

/**
 * @param {object} o
 * @param {Scene|null} o.terrain   glbToScene(terrain.glb, { anchor: false })＝頂点は錨の glTF 座標
 * @param {Scene|null} o.buildings glbToScene(buildings.glb, { anchor: false })
 * @param {number} [o.scale=1]     1 ブロックの m
 * @param {number|null} [o.yOrigin] 錨の高さ（glTF の y=0）が入るブロックの Y。省略＝0（入りきらない時はずらす）
 * @param {number} [o.floors=4]    建物の床の間隔（m）・0＝床なし
 * @param {boolean} [o.roofFromImagery=true] 屋根の色を地形の写真から取る
 * @param {number[]} [o.clip]      [x0, z0, x1, z1]（glTF の m）＝この外は捨てる（省略＝地形の広がり・地形が無ければ建物の広がり）
 * @param {(bytes, mime) => Promise<{w,h,px,bpp}>} [o.decodeImage]  画像の解読（省略＝材質の色だけ）
 * @param {string[]} [o.exclude]   色に使わないブロック（Java の名前）
 * @returns {Promise<Grid>}
 */
export async function voxelize({ terrain = null, buildings = null, scale = 1, yOrigin = null, floors = 4, roofFromImagery = true, clip = null, decodeImage = null, exclude = [], log = () => {} }) {
	const nearest = makeMatcher({ exclude });
	const tb = terrain?.prims.length ? sceneBox([terrain]) : null, bb = buildings?.prims.length ? sceneBox([buildings]) : null;
	if (!tb && !bb) throw new Error("voxelize: nothing to voxelize (no terrain and no buildings)");
	const area = clip ?? (tb ? [tb[0], tb[2], tb[3], tb[5]] : [bb[0], bb[2], bb[3], bb[5]]);
	const bx0 = Math.floor(area[0] / scale), bz0 = Math.floor(area[1] / scale), bx1 = Math.ceil(area[2] / scale) - 1, bz1 = Math.ceil(area[3] / scale) - 1;
	const W = bx1 - bx0 + 1, D = bz1 - bz0 + 1;
	const lo = Math.floor(Math.min(tb ? tb[1] : Infinity, bb ? bb[1] : Infinity) / scale), hi = Math.floor(Math.max(tb ? tb[4] : -Infinity, bb ? bb[4] : -Infinity) / scale);
	const below = tb ? 4 : 0;   // 地形の下の土と石の段
	let y0 = yOrigin ?? 0;
	if (yOrigin == null) { if (hi + y0 > WORLD_MAX_Y) y0 = WORLD_MAX_Y - hi; if (lo - below + y0 < WORLD_MIN_Y) y0 = WORLD_MIN_Y - lo + below; }
	const minY = Math.max(WORLD_MIN_Y, lo - below + y0), maxY = Math.min(WORLD_MAX_Y, hi + y0), H = maxY - minY + 1;
	if (hi + y0 > WORLD_MAX_Y || lo - below + y0 < WORLD_MIN_Y) log(`warning: the area spans ${hi - lo + below + 1} blocks, more than the world height (384): clipped (try --scale ${scale * 2})`);
	log(`grid ${W} × ${D} × ${H} blocks (x ${bx0}..${bx1}, z ${bz0}..${bz1}, y ${minY}..${maxY}), anchor at y ${y0}, ${scale} m/block`);
	const data = new Uint8Array(W * D * H);
	const at = (x, y, z) => ((y - minY) * D + (z - bz0)) * W + (x - bx0);
	const step = 0.4 * scale, cache = new Map();

	// 地形：柱の高さ（最大）と上面の色
	const top = new Float32Array(W * D).fill(-Infinity), tcol = new Float64Array(W * D * 4);
	for (const p of terrain?.prims || []) {
		const col = await colorSource(p.material, decodeImage, cache);
		for (let t = 0; t < p.indices.length; t += 3) sampleTriangle(p.positions, p.indices, p.indices[t], p.indices[t + 1], p.indices[t + 2], p.uvs, step, (x, y, z, u, v) => {
			const ix = Math.floor(x / scale) - bx0, iz = Math.floor(z / scale) - bz0;
			if (ix < 0 || iz < 0 || ix >= W || iz >= D) return;
			const k = iz * W + ix; if (y > top[k]) top[k] = y;
			const c = col(u, v), o = k * 4; tcol[o] += c[0]; tcol[o + 1] += c[1]; tcol[o + 2] += c[2]; tcol[o + 3]++;
		});
	}
	let tcount = 0;
	if (tb) {
		fillHoles(top, tcol, W, D);
		for (let iz = 0; iz < D; iz++) for (let ix = 0; ix < W; ix++) {
			const k = iz * W + ix; if (!Number.isFinite(top[k])) continue;
			const ty = Math.min(maxY, Math.floor(top[k] / scale) + y0), o = k * 4, n = tcol[o + 3] || 1;
			const surf = tcol[o + 3] ? nearest(tcol[o] / n, tcol[o + 1] / n, tcol[o + 2] / n) + 1 : GRASS;
			for (let y = minY; y <= ty; y++) data[at(ix + bx0, y, iz + bz0)] = y === ty ? surf : y >= ty - 3 ? DIRT : STONE;
			tcount++;
		}
	}

	// 建物：外殻の色を積む（疎）
	const acc = new Map();
	let bcount = 0;
	for (const p of buildings?.prims || []) {
		const col = await colorSource(p.material, decodeImage, cache);
		for (let t = 0; t < p.indices.length; t += 3) sampleTriangle(p.positions, p.indices, p.indices[t], p.indices[t + 1], p.indices[t + 2], p.uvs, step, (x, y, z, u, v) => {
			const X = Math.floor(x / scale), Y = Math.floor(y / scale) + y0, Z = Math.floor(z / scale);
			if (X < bx0 || X > bx1 || Z < bz0 || Z > bz1 || Y < minY || Y > maxY) return;
			const i = at(X, Y, Z), c = col(u, v);
			let a = acc.get(i); if (!a) acc.set(i, a = [0, 0, 0, 0]);
			a[0] += c[0]; a[1] += c[1]; a[2] += c[2]; a[3]++;
		});
	}
	// 柱ごとの一番上（屋根）と一番下
	const colTop = new Int32Array(W * D).fill(-1e9), colBot = new Int32Array(W * D).fill(1e9);
	for (const i of acc.keys()) { const k = i % (W * D), y = Math.floor(i / (W * D)) + minY; if (y > colTop[k]) colTop[k] = y; if (y < colBot[k]) colBot[k] = y; }
	for (const [i, a] of acc) {
		const k = i % (W * D), y = Math.floor(i / (W * D)) + minY, o = k * 4;
		const roof = roofFromImagery && y === colTop[k] && tcol[o + 3] > 0;
		data[i] = roof ? nearest(tcol[o] / tcol[o + 3], tcol[o + 1] / tcol[o + 3], tcol[o + 2] / tcol[o + 3]) + 1 : nearest(a[0] / a[3], a[1] / a[3], a[2] / a[3]) + 1;
		bcount++;
	}
	// 床：柱の下端が地面に近い（ひさし・渡り廊下でない）柱に floors m ごと
	let fcount = 0;
	if (floors > 0) {
		const every = Math.max(1, Math.round(floors / scale));
		for (let k = 0; k < W * D; k++) {
			if (colTop[k] < colBot[k]) continue;
			const ground = Number.isFinite(top[k]) ? Math.floor(top[k] / scale) + y0 : colBot[k];
			if (colBot[k] - ground > 2) continue;
			for (let y = colBot[k] + every; y < colTop[k]; y += every) { const i = (y - minY) * W * D + k; if (!data[i]) { data[i] = FLOOR; fcount++; } }
		}
	}
	log(`voxels: terrain ${tcount} columns, buildings ${bcount} shell + ${fcount} floor blocks`);
	return { x0: bx0, z0: bz0, y0: minY, W, D, H, data, blocks: BLOCKS, scale, yOrigin: y0, at, stats: { terrainColumns: tcount, shell: bcount, floor: fcount } };
}

/** 点の入らなかった柱（細い三角形の隙間）を隣から埋める */
function fillHoles(top, col, W, D) {
	for (let pass = 0; pass < 4; pass++) {
		let left = 0;
		for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) {
			const k = z * W + x; if (Number.isFinite(top[k])) continue;
			let s = 0, n = 0, best = -1;
			for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
				const X = x + dx, Z = z + dz; if (X < 0 || Z < 0 || X >= W || Z >= D) continue;
				const q = Z * W + X; if (Number.isFinite(top[q])) { s += top[q]; n++; best = q; }
			}
			if (!n) { left++; continue; }
			top[k] = s / n; for (let c = 0; c < 4; c++) col[k * 4 + c] = col[best * 4 + c];
		}
		if (!left) break;
	}
}

/** 格子の 1 マス（ブロックの番号） */
export const blockAt = (g, x, y, z) => x < g.x0 || z < g.z0 || y < g.y0 || x >= g.x0 + g.W || z >= g.z0 + g.D || y >= g.y0 + g.H ? AIR : g.data[((y - g.y0) * g.D + (z - g.z0)) * g.W + (x - g.x0)];
