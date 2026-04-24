import * as d3 from "d3";
import "common/d3/selection.js";
import { comma, isArray, isString, isNumber, isObject, isBlob, unique, concat, thenEach } from "common";
import { layerList } from "ortho-map/modules/layerList.js";
import { Fetch, Bucket, Cache } from "native-bucket";
import { tiff2canvas, exr2canvas, tile2canvas } from './file2canvas';
import { geopbf } from "geopbf";
import { GEBCO, ALOS } from "altpbf";
import "./main.scss";

class screenLogger {
	constructor (div) { this.target = div.classed("log", true); }
	clear(s) { this.target.empty(); }
	log(...a) {
		const toS = _ => isString(_)? _.replace(/\n/g,"<br/>"): isNumber(_)? comma(_): JSON.stringify(_);
		const o2a = o => {
			const a = unique(concat(o.map(t=>Object.keys(t))));
			const b = o.map(t=> a.map(v=>t[v]||""));
			return [a].concat(b);
		}
		const isImageBlob = _ => isBlob(_) && _.type.match(/^image/);
		const p = this.target.append("p");
		if (a.length == 1) { a = a[0];
			if (isArray(a) && a.length > 1) { 
				if (a.every(isObject)) a = o2a(a);
				if (a.every(isArray)) { const table = p.append("table");
					a.forEach(t=>{ const tr = table.append("tr");
						t.forEach(t=>tr.append("td").text(t).classed("right", isNumber(t)))
					});
					return
				}
			} else if (isImageBlob(a)) {
				return p.append("img").attr("src", URL.createObjectURL(a));
			}
			return p.append("span").html(toS(a));
		} 
		a.forEach(t=>p.append("span").html(toS(t)));
	}
	title(s) { this.target.append("p").classed("title", true).text("✨ " + s +" ✨"); }
	warn(s) { this.target.append("p").classed("warn", true).text("⚠️ " + s); }
	error(s) { this.target.append("p").classed("error", true).text("❌ " + s); }
	success(s) { this.target.append("p").classed("success", true).text("✅ " + s); }
}
const body = d3.select("body");
const CMD = body.append("div").classed("command", true);
const LOG = body.append("div").classed("logArea", true);
const q = new screenLogger(LOG);
CMD.append("h1").text("DB Updater");
CMD.append("button").text("GEBCO(90/10)").on("click", () => GEBCO());
CMD.append("button").text("base ER pictures").on("click", () => base(q, Object.values(layerList)));
CMD.append("button").text("borders and stars").on("click", () => borders(q));
await ALOS(0, 1); 
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
		"ne_50m_admin_0_boundary_lines_land": nvkelso("ne_50m_admin_0_boundary_lines_land"),
		"ne_50m_admin_0_boundary_lines_maritime_indicator": nvkelso("ne_50m_admin_0_boundary_lines_maritime_indicator"),
		"ne_50m_geographic_lines": nvkelso("ne_50m_geographic_lines"),
		"stars.6": ofrohn("stars.6"),
		"stars.8": ofrohn("stars.8")
	};
	q.clear();
	q.title("borders and stars");
	await thenEach(Object.entries(pbfs), async ([name, original]) => {
		const pbf = await geopbf(name) || await (await geopbf(original)).save();
		q.success(`${name}: (<= ${original})`)
		q.log(pbf.lint);
	})
}

