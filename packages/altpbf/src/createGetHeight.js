import { altpbf } from "./altpbf.js";
export async function createGetHeight(opts = {}) {
    const level1 = opts.level1 || 7, level2 = opts.level2 || 12;
    const { load, isLoading, fileName, lnglat, loadIndex } = await altpbf();
    const { max, min, floor } = Math;
    const index = (await loadIndex()).map(t => t[1]).flat().map(t => t[0]);
    const matrix = new Uint8Array(369 * 180);
    index.forEach(t => { const [lng, lat] = lnglat(t); matrix[(lat + 90) * 360 + (lng + 180)] = 1; });
    const fexist = (lng, lat) => !!matrix[(lat + 90) * 360 + (lng + 180)];
    let cname = null, current = null;
    ////---------------------------------------------------------------------------------------
    return (lng, lat, zoom = Infinity) => {
        const n = (zoom < level1) ? 0 : (zoom < level2) ? 1 : 2;
        lng += lng < -180 ? 360 : lng > 180 ? -360 : 0;
        lat = max(min(lat, 89.999), -89.999);
        return [hgt90, hgt10, hgt01][n](lng, lat);
    };
    ////---------------------------------------------------------------------------------------
    async function loadc(name) {
        if (isLoading()) return null;
        if (cname == name) return current;
        opts.onstart && opts.onstart(name);
        const v = await load(name);
        opts.onend && opts.onend(name);
        cname = name; current = v;
        return v
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
    async function hgt90(lng, lat) {
        const n = 90;
        const lng0 = floor(lng / n) * n, lat0 = floor(lat / n) * n;
        const v = await loadc(fileName([lng0, lat0], n));
        return calcHeight((lng - lng0) / n, (lat - lat0) / n, v);
    }
    async function hgt10(lng, lat) {
        const n = 10;
        const lng0 = floor(lng / n) * n, lat0 = floor(lat / n) * n;
        const v = await loadc(fileName([lng0, lat0], n));
        return calcHeight((lng - lng0) / n, (lat - lat0) / n, v) || hgt90(lng, lat);
    }
    async function hgt01(lng, lat) {
        const lng0 = floor(lng), lat0 = floor(lat); if (!fexist(lng0, lat0)) return hgt10(lng, lat);
        const v = await loadc(fileName([lng0, lat0], 1));
        return calcHeight((lng - lng0), (lat - lat0), v) || hgt10(lng, lat);
    }
};
