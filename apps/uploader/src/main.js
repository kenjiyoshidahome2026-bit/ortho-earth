import * as d3 from 'd3';
import "./main.scss";
import { screenLogger } from "../../gishub/screenLogger.js";
import "../../gishub/screenLogger.scss";
import "common/d3/selection.js";
import { comma, isArray, isString, isNumber, isObject, isBlob, unique, concat, thenEach } from "common";
import { Layers } from "ortho-map/modules/Layers.js";
import { nativeBucket } from "native-bucket";

import { tiff2canvas, exr2canvas, tile2canvas } from './file2canvas';
import { geopbf, setApiUrl } from "geopbf";

const API_BASE = import.meta.env.DEV ? `${location.origin}/api` : "https://api.ortho-earth.com";
const API_KEY = "my-lovely-dog-betty-was-born-on-2019-09-01";
setApiUrl(API_BASE, { apiKey: API_KEY });
const { Fetch, Bucket, Cache } = nativeBucket(API_BASE, { apiKey: API_KEY });
import { GEBCO, createGetHeight } from "altpbf";

import { 世界時計 } from 'calender';
const clock = 世界時計({});
//clock.redraw({digital:false})

const body = d3.select("body");
const CMD = body.append("div").classed("command", true);
const LOG = body.append("div").attr("id","logArea").classed("logArea", true);
LOG.appendNode(clock);

const q = new screenLogger(LOG);

CMD.append("h1").text("DB Updater");
CMD.append("button").text("create GEBCO(R90/R10)").on("click", () => GEBCO({year:2026, log:q}));
CMD.append("button").text("base ER pictures").on("click", () => base(q, Object.values(Layers)));
CMD.append("button").text("borders and stars").on("click", () => borders(q));

// var getHeight = await createGetHeight({onstart:s=>console.log("start: "+s),onend:s=>console.log("end: "+s)});
// console.log(await getHeight(135.2,35.2,10));
// console.log((await geopbf({type:"Feature", geometry:d3.geoGraticule10()})).geojson);

async function base(q, list) {
	const dire = `GIS/base`;
	const bucket = await Bucket(dire);
	const cache = await Cache(dire);
	q.clear();
	q.title("base ER pictures");
	const baseMap = {};
	await thenEach(list, async t => {
		const base = t.base; if (base in baseMap) return;
		baseMap[base] = await bucket.get(base) || await createBaseMap(t);
		q.success(base);
		q.log(baseMap[base]);
		await cache(base, await createImageBitmap(baseMap[base]))
	});
	q.log(await bucket.list());
	async function createBaseMap(layer) {
		const base = layer.base;
		switch (base) {
			case "naturalEarth.webp": await NaturalEarth("HYP_LR_SR_OB_DR"); break;
			case "whiteEarth.webp": await NaturalEarth("GRAY_LR_SR_OB_DR"); break;
			case "google.satellite.webp": await tile2rect(layer.tile); break;
			case "osm.satellite.webp": await tile2rect(layer.tile); break;
			case "moon.webp": await moon(); break;
			case "universe.webp": await universe(); break;
		}
		async function tile2rect(url) { await saveWEBPs(await tile2canvas(url)); }
		async function NaturalEarth(target) {
			const url = `https://naciscdn.org/naturalearth/10m/raster/${target}.zip`;
			const tiff = await Fetch(url, { target: `${target}.tif`, cors: true });
			await saveWEBPs(await tiff2canvas(tiff));
		}
		async function moon() {
			const tiff = await Fetch(`https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_16bit_srgb_16k.tif`);
			await saveWEBPs(await tiff2canvas(tiff));
		}
		async function universe() {
			const exr = await Fetch(`https://svs.gsfc.nasa.gov/vis/a000000/a004800/a004851/starmap_2020_16k.exr`);
			await saveWEBPs(await exr2canvas(exr));
		}
		async function saveWEBPs(canvas) {
			const dstX = 10000, dstY = dstX / 2;
			const type = `image/webp`, quality = 0.8;
			const blob = await canvas.convertToBlob({ type, quality });
			const img = await createImageBitmap(blob), w = canvas.width, h = canvas.height;
			const target = new OffscreenCanvas(dstX, dstY);
			target.getContext("2d").drawImage(img, 0, 0, w, h, 0, 0, dstX, dstY);
			const file = new File([await target.convertToBlob({ type, quality })], base, { type });
			await bucket.put(file);
			console.log(`%c${file.name}: [ ${comma(dstX)} x ${comma(dstY)} ] ${comma(file.size)} bytes`, "font-size:1.5em");
		}
	}
}
async function borders(q) {
	const nvkelso = _ => `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/${_}.geojson`;
	const ofrohn = _ => `https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data/${_}.json`;
	const pbfs = {
		"ne_110m_land": nvkelso("ne_110m_land"),
		"ne_50m_land": nvkelso("ne_50m_land"),
		"ne_110m_graticules_10": nvkelso("ne_110m_graticules_10"),
		"ne_50m_admin_0_boundary_lines_land": nvkelso("ne_50m_admin_0_boundary_lines_land"),
		"ne_50m_admin_0_boundary_lines_maritime_indicator": nvkelso("ne_50m_admin_0_boundary_lines_maritime_indicator"),
		"ne_50m_geographic_lines": nvkelso("ne_50m_geographic_lines"),
		"stars.6": ofrohn("stars.6"),
		"stars.8": ofrohn("stars.8")
	};
	q.clear();
	q.title("borders and stars");
	await thenEach(Object.entries(pbfs), async ([name, original]) => {
		const pbf = await geopbf(original, { name, nocache: true });
		if (!pbf.length) throw new Error(`${name}: encoding produced 0 features — check source URL or decoder`);
		q.log(`${name}: ${pbf.length} features, keys: [${pbf.keys.join(', ')}]`);
		await pbf.save();
		q.success(`${name}: (<= ${original})`)
		q.log(await pbf.profile());
	})
}

