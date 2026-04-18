import { comma, thenEach } from "common/src/utility.js";
import { Logger } from "common/src/logger.js";
import { layerList } from "ortho-map/src/modules/layerList.js";
import { Fetch, Bucket } from "native-bucket";
import { tiff2canvas, exr2canvas, tile2canvas } from './file2canvas';
import { geopbf } from "geopbf";

const logger = new Logger();
debugger
const layers = {};
layerList.forEach(t=>layers[t.name] = t);
console.log(layers);

const nvkelso = _ => `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/${_}.geojson`;
const ofrohn = _ => `https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data/${_}.json`;
await (await geopbf(nvkelso("ne_110m_land"))).save();
await (await geopbf(nvkelso("ne_50m_land"))).save();
await (await geopbf(nvkelso("ne_50m_admin_0_boundary_lines_land"))).save();
await (await geopbf(nvkelso("ne_50m_admin_0_boundary_lines_maritime_indicator"))).save();
await (await geopbf(nvkelso("ne_50m_geographic_lines"))).save();
await (await geopbf(ofrohn("stars.6"))).save();
await (await geopbf(ofrohn("stars.8"))).save();



const bucket_base = await Bucket(`GIS/base`);
console.log(await bucket_base.list());
const baseMap = {};
await thenEach(Object.values(layers), async t => {
	const base = t.base; if (base in baseMap) return;
	baseMap[base] = await bucket_base.get(base) || await createBaseMap(t);
});
console.log(baseMap);
async function createBaseMap(layer) {
	const base = layer.base;
	//console.log(`--------------------------------------------`);
	logger.title(base)
	//console.log(`--------------------------------------------`);
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
		await bucket_base.put(file);
		console.log(`%c${file.name}: [ ${comma(dstX)} x ${comma(dstY)} ] ${comma(file.size)} bytes`, "font-size:1.5em");
	}
}