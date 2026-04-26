import { altpbfName } from "./altpbf.js";
export async function createGetHeight(opts = {}) {
	const level1 = opts.level1 || 7, level2 = opts.level2 || 12;
	const { max, min, floor } = Math;
	let clng = null, clat = null, crange = null, current = null;
    const worker = new Worker(new URL(`./worker.js`, import.meta.url), { type: 'module' });
	let loading = false;
	////---------------------------------------------------------------------------------------
	return async(lng, lat, zoom = Infinity) => {
		const range = (zoom < level1) ? 90 : (zoom < level2) ? 10 : 1;
		lng += lng < -180 ? 360 : lng > 180 ? -360 : 0;
		lat = max(min(lat, 89.999), -89.999);
		const lng0 = floor(lng / range) * range, lat0 = floor(lat / range) * range;
		console.log(lng0, lat0,range);
		const v = await load(lng0, lat0, range);
		return calcHeight((lng - lng0) / range, (lat - lat0) / range, v);
	};
	////---------------------------------------------------------------------------------------
	async function load(lng, lat, range) {
		if (clng == lng && clat == lat && crange == range) return current;
		const name = altpbfName(lng, lat, range);
		if (loading) return null;
		return new Promise(resolve=>{ loading = true;
			worker.onmessage = e => { loading = false;
				opts.onend && opts.onend(name);
				clng = lng, clat = lat, crange = range;
				resolve(current = e.data);
			};
			worker.onerror = e => console.log(e);
			console.log(worker);
			worker.postMessage({lng, lat, range});
			opts.onstart && opts.onstart(name);
		})
	}
	function calcHeight(x, y, v) {
		if (!v || !v.data) return 0;
		const a = v.data, w = v.width, h = v.height;
		const H = (x, y) => a[(h - (y || 1)) * w + ((x == w) ? w - 1 : x)];
		const avg = (v1, v2, f) => v1 + (v2 - v1) * f;
		const [X, Y] = [x * w, y * h], [x0, y0] = [X | 0, Y | 0], [x1, y1] = [x0 + 1, y0 + 1];
		const [v00, v01, v10, v11] = [H(x0, y0), H(x0, y1), H(x1, y0), H(x1, y1)];
		return avg(avg(v00, v10, X - x0), avg(v01, v11, X - x0), Y - y0);
	}
};
