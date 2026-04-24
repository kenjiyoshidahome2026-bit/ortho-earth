import { fromBlob } from 'geotiff'; 
import { Fetch, decodeZIP } from "native-bucket";
import { thenEach, comma, min, sum, L3 } from "common";
import { altpbf } from "./altpbf.js";
import { TriangleFanDrawMode } from 'three/src/constants.js';
const { save, fileName, lnglat, size, saveIndex, loadIndex } = await altpbf();

////================================================================================================
////	GEBCO
////	See => https://www.gebco.net/data-products/gridded-bathymetry-data
////	10 degree => 2400 size tile : HGT10
////	90 degree => 2400 size tile : HGT90
////================================================================================================
export async function GEBCO(flag = true) {
    const source = "GEBCO 2025";
    const SIZE = 21600; console.clear();
    const url = flag ? // true: with ice / false: without ice
        `https://dap.ceda.ac.uk/bodc/gebco/global/gebco_2025/ice_surface_elevation/geotiff/gebco_2025_geotiff.zip` :
        `https://dap.ceda.ac.uk/bodc/gebco/global/gebco_2025/sub_ice_topography_bathymetry/geotiff/gebco_2025_sub_ice_topo_geotiff.zip`;
    const zip = await Fetch(url);
    const files = (await decodeZIP(zip)).filter(t=>t.name.match(/\.tif$/));
    await thenEach(files, gebco);
    async function gebco(file) {
        var dt = new Date();
        console.log(`-----------------------------------------------------------------------------`);
        console.log(`%c ${file.name} `, 'font-size: 1.5em;');
        console.log(`-----------------------------------------------------------------------------`);
        const xxx = file.name.match(/w-180.0_e-90.0/) ? -180 : file.name.match(/w-90.0_e0.0/) ? -90 : file.name.match(/w0.0_e90.0/) ? 0 : 90;
        const yyy = file.name.match(/n0.0_s-90.0/) ? -90 : 0;
        const tiff = await fromBlob(file);
        const image = await tiff.getImage();
        const raster = await image.readRasters();
        if (!raster || raster.width != SIZE || raster.height != SIZE) return console.error("raster size error", raster);
        await create90(fileName([xxx, yyy], 90), raster[0]);
        const D = 9, H = SIZE / D;
        const shrink = n => (n == 80 || n == -90) ? 1 / 6 : (n == 70 || n == -80) ? 1 / 3 : (n == 60 || n == -70) ? 1 / 2 : (n == 50 || n == -60) ? 2 / 3 : 1;
        for (let j = 0; j < D; j++) for (let i = 0; i < D; i++) {
            const lng = xxx + i * 10, lat = yyy + (90 - j * 10 - 10);
            const W = shrink(lat) * H;
            await create10(fileName([lng, lat], 10), raster[0], W, H, i, j);
        }
        console.log(`size: ${comma(file.size)} => ${(new Date() - dt) * 1000}[sec]\n`);
    }

    async function create90(name, a) {
        const n = 8;
        const width = SIZE / n, height = SIZE / n;
        const data = new Int16Array(width * height);
        let k = 0;
        for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) {
            let sum = 0;
            for (let jj = 0; jj < n; jj++) for (let ii = 0; ii < n; ii++) sum += a[(j * n + jj) * SIZE + (i * n + ii)];
            data[k++] = sum / n / n;
        }
        await save(name, { width, height, data, source });
    }
    async function create10(name, a, width, height, x, y) {
        const data = new Int16Array(width * height);
        let i, j, n = 0;
        for (j = 0; j < height; j++) for (i = 0; i < width; i++) {
            const X = i * height / width, x0 = X | 0, x1 = x0 + 1;
            const v0 = a[(y * height + j) * SIZE + (x * height + x0)];
            const v1 = a[(y * height + j) * SIZE + (x * height + x1)];
            data[n++] = v0 + (v0 - v1) * (x0 - X);
        }
        await save(name, { width, height, data, source });
    }
}
////==================================================================================================
////	ALOS
////	See => https://www.eorc.jaxa.jp/ALOS/jp/dataset/aw3d30/aw3d30_j.htm
////	See => https://www.eorc.jaxa.jp/ALOS/en/aw3d30/data/index.htm
////	1 degree => 60 x 60 = 3600 (sec) size tile : HGT01
////	only land (ocean => 0)
////================================================================================================
export async function ALOS(start, count = 10, flag) {
    const source = "ALOS AW3D30";
 //   console.clear();
    const index = (await loadIndex()) || (await createIndex()); console.log(index);
    thenEach(Object.keys(index).slice(0, 100), t => createTile(t));
    //	---------------------------------------------------------------------------
    async function createTile(fname) {
        const dname = get_dname(fname)
        const dt = new Date();
        const url = `https://www.eorc.jaxa.jp/ALOS/aw3d30/data/release_v2404/${dname}.zip`, cors = true;
        const target = `${dname}/ALPSMLC30_${fname}_DSM.tif`
        console.log(`${url}#${target}`);
        const file = await Fetch(url, { target, cors });
        await create01(file);
        console.log(`${target} ( ${comma(file.size)} ) => ${(new Date() - dt) / 1000}[sec]`);
    }
    async function checkTiles(pos, fname, file) {
        const sizes = await Promise.all(file.map(t => size("HGT01" + t[0])));
        min(sizes) ?
            console.log(`[${pos}] ${fname} : complete( ${comma(sum(sizes))} bytes / ${file.length} files )`) :
            console.log(`%c[${pos}] ${fname} : incomplete( ${file.length} files )`, 'color:yellow;');
    }
    async function createIndex() { 
        const url = `https://www.eorc.jaxa.jp/ALOS/jp/dataset/aw3d30/data/List_of_all_tiles_in_AW3D30.txt`;
        const Q = {};
        const txt = (await Fetch(url, "text")).split("\n");
        txt.forEach(t => { const [fname, ver] = t.split(/\s+/);
            lnglat(fname) && (Q[fname] = ver);
        });
        return saveIndex(Q);
    }
    function get_dname(fname) {
        const f3 = n => (n < 0 ? Math.ceil : Math.floor)(Math.abs(n) / 5) * 5 * (n < 0 ? -1 : 1);
        const LNG = n => (n < 0 ? "W" : "E") + L3(n), LAT = n => (n < 0 ? "S" : "N") + L3(n);
        const dname = ([x, y]) => LAT(f3(y)) + LNG(f3(x)) + "_" + LAT(f3(y + 5)) + LNG(f3(x + 5));
        return dname(lnglat(fname));
     }
    async function create01(file) {
        const name = fileName(lnglat(file.name));
        const tiff = await fromBlob(file); file = null;
        const image = await tiff.getImage();
        const raster = await image.readRasters();
        if (!raster) return console.error("raster size error", raster);
        const { width, height } = raster, data = raster[0];
        console.log(name, { width, height, data, source });
    }
}
////==================================================================================================
export function AltitudeColor(n, flag = false) {
    const Altitude = n =>
        n < 200 ? [85, 107, 47, 255] :
            n < 500 ? [124, 150, 90, 255] :
                n < 1000 ? [189, 183, 107, 255] :
                    n < 2000 ? [180, 130, 70, 255] :
                        n < 4000 ? [130, 80, 60, 255] :
                            n < 6000 ? [100, 60, 40, 255] : [200, 200, 200, 255];
    const Depth = n =>
        n < 200 ? [170, 220, 240, 255] :
            n < 2000 ? [100, 180, 210, 255] :
                n < 6000 ? [40, 100, 150, 255] : [20, 50, 100, 255];
    return n > 0 ? Altitude(n) : flag ? [0, 0, 0, 0] : Depth(n);
}