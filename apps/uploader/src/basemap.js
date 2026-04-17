import { Fetch, Bucket, Cache } from "native-bucket";
//import  from "native-bucket"; 
///import Cache from "native-bucket";
import { tiff2canvas, exr2canvas, tile2canvas } from './file2canvas';
import { comma } from "common/src/utility.js"; 
export async function createBaseMap(name, dirName = "GIS") {
 //   const { Cache } = nativeBucket();
    var dt = new Date();
    const dire = `${dirName}/base`;
    const bucket = await Bucket(dire);
    const cache = await Cache(dire);
    const NaturalEarth10m = name => `https://naciscdn.org/naturalearth/10m/raster/${name}.zip`;
    console.log(`--------------------------------------------`);
    console.log(`%c${name}`, "font-size:2em")
    console.log(`--------------------------------------------`);
    switch (name) {
        case "google.satellite": await tile2rect(name, resources.tileURL(name)); break;
        case "osm.satellite": await tile2rect(name, resources.tileURL(name)); break;
        case "naturalEarth": await NaturalEarth(name, "HYP_LR_SR_OB_DR"); break;//  url2rect(NaturalEarth10m("HYP_LR_SR_OB_DR"), "HYP_LR_SR_OB_DR.tif", name); break;
        case "whiteEarth": await NaturalEarth(name, "GRAY_LR_SR_OB_DR"); break; //url2rect(NaturalEarth10m("GRAY_LR_SR_OB_DR"), "GRAY_LR_SR_OB_DR.tif", name); break;
        case "moon": await moon(name); break;
        case "universe": await universe(name); break;
    }
    console.log(`%c${name}: ${(new Date() - dt) / 1000}[sec]`, 'font-size: 1.5em;');
    ////================================================================================================
    async function tile2rect(name, url) {
        await saveWEBPs(await tile2canvas(url), name);
    }
    async function NaturalEarth(name, target) {
        const url = `https://naciscdn.org/naturalearth/10m/raster/${target}.zip`;
        const file = `${target}.tif`;
        const tiff = await Fetch(url, { target:file, cors: true });
        await saveWEBPs(await tiff2canvas(tiff), name);
    }
    async function moon(base) {
        const tiff = await Fetch(`https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_16bit_srgb_16k.tif`);
        await saveWEBPs(await tiff2canvas(tiff), base);
    }
    async function universe(base) {
        const exr = await Fetch(`https://svs.gsfc.nasa.gov/vis/a000000/a004800/a004851/starmap_2020_16k.exr`);
        await saveWEBPs(await exr2canvas(exr), base);
    }
    ////================================================================================================
    async function saveWEBPs(canvas, base) {
        const dstX = 10000, dstY = dstX/2;
        const name = `${base}.webp`, type = `image/webp`, quality = 0.8;
        const blob = await canvas.convertToBlob({ type, quality });
        const img = await createImageBitmap(blob), w = canvas.width, h = canvas.height;
        const target = new OffscreenCanvas(dstX, dstY);
        target.getContext("2d").drawImage(img, 0, 0, w, h, 0, 0, dstX, dstY);
        const file = new File([await target.convertToBlob({ type, quality })], name, { type });
        await bucket.put(file);
        console.log(`%c${file.name}: [ ${comma(dstX)} x ${comma(dstY)} ] ${comma(file.size)} bytes`, "font-size:1.5em");
    }
    async function writeIDB() {
        const names = (await bucket.list()).map(t => t.Key);// console.log(names);
        const files = await Promise.all(names.map(t => bucket.get(t)));
        await Promise.all(files.map(t => cache(t)));
    }
    async function readIDB() {
        const keys = await cache();
        return Promise.all(keys.map(t => cache(t)));
    }
}