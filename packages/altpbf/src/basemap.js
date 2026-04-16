import nativeBucket from "native-bucket"; 
import { tiff2canvas, exr2canvas, tile2canvas } from './file2canvas';
import { comma } from "common/src/utility.js"; 
import { Resources } from "ortho-map/src/modules/resources.js";
export async function createBaseMap(name, dirName = "GIS") {
    const { Fetch, Bucket, Cache } = nativeBucket();
    var dt = new Date();
    const resources = await Resources(false);
    const bucket = await Bucket(`${dirName}/base`);
    const cache = await Cache(`${dirName}/base`);
    const NaturalEarth10m = name => `https://naciscdn.org/naturalearth/10m/raster/${name}.zip`;
    console.log(`--------------------------------------------`);
    console.log(`%c${name}`, "font-size:2em")
    console.log(`--------------------------------------------`);
    switch (name) {
        case "google.satellite": await tile2rect(resources.tileURL(name), name); break;
        case "osm.satellite": await tile2rect(resources.tileURL(name), name); break;
        case "naturalEarth": await url2rect(NaturalEarth10m("HYP_LR_SR_OB_DR"), name); break;
        case "whiteEarth": await url2rect(NaturalEarth10m("GRAY_LR_SR_OB_DR"), name); break;
        case "moon": await moon(name); break;
        case "universe": await universe(name); break;
    }
    console.log(`%c${name}: ${(new Date() - dt) / 1000}[sec]`, 'font-size: 1.5em;');
    ////================================================================================================
    async function tile2rect(url, base) {
        await saveWEBPs(await tile2canvas(url), base);
    }
    async function url2rect(url, base) {
        const tiff = await Fetch(url, { target: "HYP_LR_SR_OB_DR.tif", cors: true });
        console.log(tiff); debugger;
        await saveWEBPs(await tiff2canvas(tiff), base);
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
        const name = n => `${base}.${n}.webp`, type = `image/webp`, quality = 0.8;
        const blob = await canvas.convertToBlob({ type, quality });
        const img = await createImageBitmap(blob), w = canvas.width, h = canvas.height;
        await reduct(name(6), 1);
        await reduct(name(5), 2);
        await reduct(name(4), 4);
        async function reduct(name, n) {
            const canvas = new OffscreenCanvas(w / n, h / n);
            canvas.getContext("2d").drawImage(img, 0, 0, w, h, 0, 0, w / n, h / n);
            const file = new File([await canvas.convertToBlob({ type, quality })], name, { type });
            await bucket.put(file);
            console.log(`%c${file.name}: [ ${comma(w / n)} x ${comma(h / n)} ] ${comma(file.size)} bytes`, "font-size:1.5em");
        }
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