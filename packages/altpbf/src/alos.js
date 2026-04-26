////==================================================================================================
////	ALOS
////	See => https://www.eorc.jaxa.jp/ALOS/jp/dataset/aw3d30/aw3d30_j.htm
////	See => https://www.eorc.jaxa.jp/ALOS/en/aw3d30/data/index.htm
////	1 degree => 60 x 60 = 3600 (sec) size tile : R01
////	only land (ocean => 0)
////================================================================================================
import { Fetch, Bucket, Cache } from "native-bucket";
import { thenEach, comma, L2, L3 } from "common";
import { encode, decode, encodeName, tiff2raster } from "./altpbf.js";
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
	//	console.log(Object.entries(this.index));
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
		const fname = encodeName(lng, lat); if (!this.index[fname]) return false;
		const range = 1;
		const name = encodeName(lng, lat, range);
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
