import { comma, thenEach } from "common/src/utility.js"
import { layerList } from "ortho-map/src/modules/layerList.js";
import { Fetch, Bucket } from "native-bucket";
import { tiff2canvas, exr2canvas, tile2canvas } from './file2canvas';
const layers = {};
layerList.forEach(t=>layers[t.name] = t);
console.log(layers);
const bucket = await Bucket(`GIS/base`);
console.log(await bucket.list());
const baseMap = {};
await thenEach(Object.values(layers), async t =>{
	const base = t.base; if (base in baseMap) return;
	baseMap[base] = await bucket.get(base) || await createBaseMap(t);
});
console.log(baseMap);
async function createBaseMap(layer) {
	const base = layer.base;
	console.log(`--------------------------------------------`);
	console.log(`%c${base}`, "font-size:2em")
	console.log(`--------------------------------------------`);
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
