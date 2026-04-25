import { Fetch, Bucket, Cache } from "native-bucket";
import { thenEach, comma, L2, L3 } from "common";
import { encode, decode, altpbfName, tiff2raster } from "./altpbf.js";

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
		const name = altpbfName(lng, lat, range);
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
		const name = altpbfName(lng, lat, range);
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
}
////==================================================================================================
////	ALOS
////	See => https://www.eorc.jaxa.jp/ALOS/jp/dataset/aw3d30/aw3d30_j.htm
////	See => https://www.eorc.jaxa.jp/ALOS/en/aw3d30/data/index.htm
////	1 degree => 60 x 60 = 3600 (sec) size tile : R01
////	only land (ocean => 0)
////================================================================================================
export class ALOS {
	constructor () {
		this.baseUrl = "https://www.eorc.jaxa.jp/ALOS";
		this.source = "ALOS AW3D30";
		this.index = null;
		this.dire = `GIS/alt`
	}
	async init() {
		this.bucket = await Bucket(this.dire, { silent: true });
		this.cache = await Cache(this.dire);
		const indexName = "index", bucket = this.bucket;
		this.index = (await loadIndex()) || (await createIndex());
		console.log(Object.entries(this.index));
		return this;
		async function loadIndex() { return (await bucket.exist(indexName)) ? bucket.get(indexName, "json") : null; }
		async function createIndex() { const tub = {};
			const txt = (await Fetch(`${baseUrl}/jp/dataset/aw3d30/data/List_of_all_tiles_in_AW3D30.txt`, "text")).split("\n");
			txt.forEach(t => { const [fname, ver] = t.split(/\s+/);
				lnglat(fname) && (tub[fname] = ver);
			});
			await bucket.put(new File([JSON.stringify(tub)], indexName, { type: "application/json" }));
			return tub;
		}
	}
	async get(lng,lat) {
		const fname = altpbfName(lng, lat); if (!this.index[fname]) return false;
		const range = 1;
		const name = altpbfName(lng, lat, range);
		const source = [this.source, this.index[fname]].join(" ");
		const buf = await this.cache(name);
		if (buf) { const v = await decode(buf);
			if (v.source == source) return v;
		}
		const f3 = n => (n < 0 ? Math.ceil : Math.floor)(Math.abs(n) / 5) * 5 * (n < 0 ? -1 : 1);
		const LNG = n => (n < 0 ? "W" : "E") + L3(Math.abs(n)), LAT = n => (n < 0 ? "S" : "N") + L3(Math.abs(n));
		const dname = LAT(f3(lat)) + LNG(f3(lng)) + "_" + LAT(f3(lat + 5)) + LNG(f3(lng + 5));
		const url = `${this.baseUrl}/aw3d30/data/release_v2404/${dname}.zip`, cors = true;
		const target = `${dname}/ALPSMLC30_${fname}_DSM.tif`;
		const dt = new Date();
		const file = await Fetch(url, { target, cors });
		const raster = await tiff2raster(file); if (!raster||!raster[0]) return console.error("geotiff raster error", raster);
		console.log(`${url}#${target} ( ${comma(file.size)} / ${(new Date() - dt) / 1000}[sec] )`);
		const { width, height } = raster, data = raster[0];
		const v = { name, source, lng, lat, range, width, height, data };
		encode(v).then(enc => this.cache(new File([enc], name, {type: "application/x-altpbf"})));
		return v;
	}
}
