import { Fetch, Bucket, Cache } from "native-bucket";
import { thenEach, comma, L2, L3 } from "common";
import { encode, decode, encodeName } from "./altpbf.js";
import { fromBlob } from 'geotiff';

////================================================================================================
////	GEBCO
////	See => https://www.gebco.net/data-products/gridded-bathymetry-data
////	10 degree => 2400 size tile : HGT10
////	90 degree => 2400 size tile : HGT90
////================================================================================================
export async function GEBCO(opts = {}) {
	const year = (opts.year||2026).toString(), Console = opts.log || console;
	const SIZE = 21600; Console.clear();
	const bucket = await Bucket("GIS/alt",{silent:true});
	const cache = await Cache("GIS/alt");
	const source = `GEBCO ${year}`, cors = true;
	Console.title(source);
	const url = !!opts.noIce ? // true: without ice / false: with ice
		`https://dap.ceda.ac.uk/bodc/gebco/global/gebco_${year}/sub_ice_topography_bathymetry/geotiff/gebco_${year}_sub_ice_topo_geotiff.zip`:
		`https://dap.ceda.ac.uk/bodc/gebco/global/gebco_${year}/ice_surface_elevation/geotiff/gebco_${year}_geotiff.zip`;
	Console.log(`[extracting] ${url}`);
	const list = await Fetch(url, {target:false, cors});
	Console.log(list);
	const lats = [-90, 0], lngs = [-180, -90, 0, 90];
	await thenEach(lats, async lat => thenEach(lngs, async lng => {
		const fix = n => n.toFixed(1);
		const area = `n${fix(lat+90)}_s${fix(lat)}_w${fix(lng)}_e${fix(lng+90)}`;
		const target = list.filter(t=>t.name.match(area))[0]?.name;
		Console.log(`[loading] ${target}`);
		var dt = new Date();
		let file = await Fetch(url, {target, cors});
		let raster = await tiff2raster(file); if (!raster||!raster[0]) return console.error("geotiff raster error", raster);
		const {width, height} = raster, size = file.size;
		if (width != SIZE || height != SIZE) return Console.error("raster size error", raster);
		await create90(lng, lat, raster[0]);
		const D = 9;
		const shrink = n => (n == 80 || n == -90) ? 1 / 6 : (n == 70 || n == -80) ? 1 / 3 : (n == 60 || n == -70) ? 1 / 2 : (n == 50 || n == -60) ? 2 / 3 : 1;
		for (let j = 0; j < D; j++) for (let i = 0; i < D; i++) {
			const _lng = lng + i * 10, _lat = lat + (90 - j * 10 - 10);
			const H = SIZE / D, W = shrink(_lat) * H;
			await create10(_lng, _lat, raster[0], W, H, i, j);
		}
		file = null, raster = null;
		Console.success(`target: ${target} size: ${comma(size)} => ${(new Date() - dt) / 1000}[sec]`);
	}));

	async function create90(lng, lat, a) { const range = 90;
		const name = encodeName(lng, lat, range);
		const n = 8, width = SIZE / n, height = SIZE / n;
		const data = new Int16Array(width * height);
		let k = 0;
		for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) {
			let sum = 0;
			for (let jj = 0; jj < n; jj++) for (let ii = 0; ii < n; ii++) sum += a[(j * n + jj) * SIZE + (i * n + ii)];
			data[k++] = sum / n / n;
		}
		await save({name, source, lng, lat, range, width, height, data });
	}
	async function create10(lng, lat, a, width, height, x, y) { const range = 10;
		const name = encodeName(lng, lat, range);
		const data = new Int16Array(width * height);
		let i, j, n = 0;
		for (j = 0; j < height; j++) for (i = 0; i < width; i++) {
			const X = i * height / width, x0 = X | 0, x1 = x0 + 1;
			const v0 = a[(y * height + j) * SIZE + (x * height + x0)];
			const v1 = a[(y * height + j) * SIZE + (x * height + x1)];
			data[n++] = v0 + (v0 - v1) * (x0 - X);
		}
		await save({name, source, lng, lat, range, width, height, data });
	}
	async function save(q) {
		const buf = await encode(q), name = q.name;
		const file = new File([buf], name, { type: "application/x-altpbf" });
		Console.log(` <= ${file.name} [${q.width} x ${q.height}]: ${comma(file.size)} bytes`);
		await bucket.put(file);
		await cache(new File([await bucket.get(name)], name, {type:"application/x-altpbf"}));
	//	console.log(await decode(await cache(name)));
	}
	async function tiff2raster(file) {
		try { return (await (await fromBlob(file)).getImage()).readRasters();
		} catch(e) { return null; }
	}
}
