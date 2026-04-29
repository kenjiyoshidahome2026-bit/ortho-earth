import { index_alos, encodeName } from "./altpbf.js";
import { Cache } from "native-bucket";

export async function createGetHeight(opts = {}) {
	const dire = `GIS/alt`;
	const cache = await Cache(dire);
	const indexName = "index_alos";
	const index = (await cache(indexName)) || (await index_alos());
	cache(indexName, index);
	const exist = (lng,lat) => index[encodeName(lng, lat)];
	let isLoading = null;
////---------------------------------------------------------------------------------------
	const level1 = opts.level1||7, level2 = opts.level2||12;
	const {max, min, floor} = Math;
	let cname = null, current = null;
    const worker = new Worker(new URL(`./worker.js?worker&url`, import.meta.url), { type: 'module' });
    worker.onerror = e => console.error("Worker Exception:", e);
////---------------------------------------------------------------------------------------
	return (lng, lat, zoom = Infinity) => {
		const n = (zoom < level1)? 0: (zoom < level2)? 1: 2;
		lng += lng < -180? 360: lng > 180? -360: 0;
		lat = max(min(lat, 89.999),-89.999);
		return [hgt90, hgt10, hgt01][n](lng,lat);
	};
////---------------------------------------------------------------------------------------
	async function load(lng, lat, range) {
		const name = encodeName(lng, lat, range);
		if (cname == name) return current;
		const obj = cache(name); if (obj) return obj;
		if (isLoading) return null;
		return new Promise(res=>{
			isLoading = performance.now();
			opts.onstart && opts.onstart(name);
			worker.postMessage(name);
			worker.onmessage = async e => { const obj = e.data;
				if (obj) {
					obj && await cache(name, obj);
    				obj && console.log(`[altpbf]  📥 ${name} (${obj.width} x ${obj.height}) ${(performance.now() - isLoading).toFixed(2) } msec`);
					cname = name; current = obj;
				}
				opts.onend && opts.onend(name);
				isLoading = null;
				res(obj);
			};
			worker.onerror = e => {
				opts.onend && opts.onend(name);
				isLoading = null;
				res(null);
			}
		});
	}
	function calcHeight(x,y,v) { if (!v || !v.data) return 0;
		const a = v.data, w = v.width, h = v.height;
		const H = (x,y)=> a[(h - (y||1)) * w + ((x==w)?w-1:x)];
		const avg = (v1, v2, f) => v1 + (v2 - v1) * f;
		const [X,Y] = [x*w,y*h], [x0,y0] = [X|0,Y|0], [x1,y1] = [x0+1,y0+1];
		const [v00,v01,v10,v11] = [H(x0,y0),H(x0,y1),H(x1,y0),H(x1,y1)];
		return avg(avg(v00,v10,X-x0), avg(v01,v11,X-x0),Y-y0);
	}
	async function hgt90(lng,lat)  { const range = 90;
		const lng0 = floor(lng/range)*range, lat0 = floor(lat/range)*range;
		const v = await load(lng0, lat0, range);
		return calcHeight((lng-lng0)/range, (lat-lat0)/range, v);
	}
	async function hgt10(lng,lat)  { const range = 10;
		const lng0 = floor(lng/range)*range, lat0 = floor(lat/range)*range;
		const v = await load(lng0, lat0, range);
		return calcHeight((lng-lng0)/range, (lat-lat0)/range, v)||hgt90(lng,lat);
	}
	async function hgt01(lng,lat)  { const range = 1;
		const lng0 = floor(lng), lat0 = floor(lat); if (!exist(lng,lat)) return hgt10(lng,lat);
		const v = await load(lng0, lat0, range);
		return calcHeight((lng-lng0), (lat-lat0), v)||hgt10(lng,lat);
	}
};
