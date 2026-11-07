// 標高タイル（地理院 dem_png）の読みと双一次補間。標高は**ジオイド上（標高）**＝楕円体高にするには geoid を足す（export.mjs）。
//   dem_png：x = R<<16|G<<8|B。x==2^23 は無効、x>2^23 は (x−2^24)×0.01 m、他 x×0.01 m（海や内水面は無効＝0 m と見なす）。
import { decodePng } from "./png.mjs";
import { lonToX, latToY } from "./geo.mjs";

export const GSI_DEM_PNG = "https://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png";   // DEM10B：z14 まで（DEM5A は dem5a_png・z15）
const INVALID = 8388608;

export function createDem({ template = GSI_DEM_PNG, zoom = 14, fetchFn = (u, i) => fetch(u, i), invalidHeight = 0, concurrency = 8 } = {}) {
	const tiles = new Map();   // "z/x/y" → Promise<{ px, bpp, w, h }|null>
	let fetched = 0, missed = 0;
	const url = (x, y) => template.replace("{z}", zoom).replace("{x}", x).replace("{y}", y);
	const tile = (x, y) => {
		const k = `${x}/${y}`;
		if (!tiles.has(k)) tiles.set(k, (async () => {
			for (let a = 0; a < 3; a++) {
				try {
					const r = await fetchFn(url(x, y), {});
					if (r.status === 404) { missed++; return null; }
					if (!r.ok) throw new Error(`${r.status} ${url(x, y)}`);
					fetched++; return decodePng(new Uint8Array(await r.arrayBuffer()));
				} catch (e) { if (a === 2) throw e; await new Promise(r => setTimeout(r, 300 * (a + 1))); }
			}
			return null;
		})());
		return tiles.get(k);
	};
	const sample = (t, xi, yi) => {
		if (!t) return invalidHeight;
		const o = (yi * t.w + xi) * t.bpp, x = (t.px[o] << 16) | (t.px[o + 1] << 8) | t.px[o + 2];
		if (x === INVALID) return NaN;
		return (x > INVALID ? x - 16777216 : x) * 0.01;
	};
	/** 画素中心で双一次補間した標高（m・ジオイド上）。無効画素は invalidHeight */
	const heightAt = async (lon, lat) => {
		const n = 256, gx = lonToX(lon, zoom) * n - 0.5, gy = latToY(lat, zoom) * n - 0.5;
		const x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0;
		const px = async (X, Y) => { const t = await tile(Math.floor(X / n), Math.floor(Y / n)); const v = sample(t, ((X % n) + n) % n, ((Y % n) + n) % n); return Number.isNaN(v) ? invalidHeight : v; };
		const [h00, h10, h01, h11] = await Promise.all([px(x0, y0), px(x0 + 1, y0), px(x0, y0 + 1), px(x0 + 1, y0 + 1)]);
		return (h00 * (1 - fx) + h10 * fx) * (1 - fy) + (h01 * (1 - fx) + h11 * fx) * fy;
	};
	/** タイルを先に取る（bbox の範囲・並列） */
	const prefetch = async (bbox) => {
		const x0 = Math.floor(lonToX(bbox[0], zoom)), x1 = Math.floor(lonToX(bbox[2], zoom)), y0 = Math.floor(latToY(bbox[3], zoom)), y1 = Math.floor(latToY(bbox[1], zoom));
		const q = []; for (let y = y0 - 1; y <= y1 + 1; y++) for (let x = x0 - 1; x <= x1 + 1; x++) q.push([x, y]);
		let i = 0; await Promise.all(Array.from({ length: concurrency }, async () => { while (i < q.length) { const [x, y] = q[i++]; await tile(x, y); } }));
	};
	return { heightAt, prefetch, zoom, template, stats: () => ({ fetched, missed }) };
}
