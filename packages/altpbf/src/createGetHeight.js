import { Cache } from "native-bucket";
import { decode, encodeName, decodeName } from "./altpbf.js";
const dire = `GIS/alt`;
const cache = await Cache(dire);

export async function createGetHeight(opts = {}) {
	const level1 = opts.level1 || 7, level2 = opts.level2 || 12;
	const { max, min, floor } = Math;
	let clng = null, clat = null, crange = null, current = null;
    const worker = new Worker(new URL(`./worker.js`, import.meta.url), { type: 'module' });
    worker.onerror = e => console.error("Worker Exception:", e);
	////---------------------------------------------------------------------------------------
	return async (lng, lat, zoom = Infinity) => {
		lng += lng < -180 ? 360 : lng > 180 ? -360 : 0;
		lat = max(min(lat, 89.999), -89.999);
		const range = (zoom < level1) ? 90 : (zoom < level2) ? 10 : 1;
		const alt = await H(range); if (alt) return alt;
		if (range == 1 && !alt) return H(10);
		if (range == 10 && !alt) return H(90);
		return alt;
		async function H(range) {
			const lng0 = floor(lng / range) * range, lat0 = floor(lat / range) * range;
			const v = await load(lng0, lat0, range);
			return calcHeight((lng - lng0) / range, (lat - lat0) / range, v);
		}
	};
	////---------------------------------------------------------------------------------------
	async function load(lng, lat, range) {
		console.log(lng, lat, range, clng, clat, crange)
		if (clng === lng && clat === lat && crange === range) return current;
		const name = encodeName(lng, lat, range);
		let v = await cache(name); if (v) return await decode(v);
		return new Promise(resolve => {
			worker.onmessage = e => {
				const { name } = e.data;
				console.log(name)
				opts.onend && opts.onend(name);
				if (e.data == null) {
					resolve(null);
				} else {
					[clng, clat, crange] = decodeName(name);
					resolve(current = e.data);
				}
			};
			opts.onstart && opts.onstart(name);
			worker.postMessage({ name, lng, lat, range });
			console.log({ name, lng, lat, range })
		});
	}
	function calcHeight(x, y, v) { if (!v || !v.data) return 0;
		const a = v.data, w = v.width, h = v.height;
		const H = (x, y) => a[(h - (y || 1)) * w + ((x == w) ? w - 1 : x)];
		const avg = (v1, v2, f) => v1 + (v2 - v1) * f;
		const [X, Y] = [x * w, y * h], [x0, y0] = [X | 0, Y | 0], [x1, y1] = [x0 + 1, y0 + 1];
		const [v00, v01, v10, v11] = [H(x0, y0), H(x0, y1), H(x1, y0), H(x1, y1)];
		return avg(avg(v00, v10, X - x0), avg(v01, v11, X - x0), Y - y0);
	}
};