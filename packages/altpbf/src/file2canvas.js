import { fromBlob } from 'geotiff'; 
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { comma, thenEach } from "common/src/utility.js";
////================================================================================================
//// tiffファイルから、equirectangularのcanvasを作成
////================================================================================================
export async function tiff2canvas(file) {
    const tiff = await fromBlob(file);
    const image = await tiff.getImage();
    const data = await image.readRasters();
    const width = image.getWidth(), height = image.getHeight(), len = width * height;
    console.log(`%c${file.name}: size=${comma(file.size)} ${comma(width)} x ${comma(height)}`, "font-size:1.5em");
    let i, j;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    const target = ctx.createImageData(width, height), dst = target.data;
    const fix = (data[0] instanceof Uint16Array) ? t => Math.min(t / 65535 * 255, 255) | 0 : t => t;
    switch (image.getSamplesPerPixel()) {
        case 1: for (i = 0; i < len; i++) { for (j = 0; j < 3; j++) dst[i * 4 + j] = fix(data[0][i]); dst[i * 4 + 3] = 255; } break;
        case 3: for (i = 0; i < len; i++) { for (j = 0; j < 3; j++) dst[i * 4 + j] = fix(data[j][i]); dst[i * 4 + 3] = 255; } break;
        default: for (i = 0; i < len; i++) for (j = 0; j < 4; j++) dst[i * 4 + j] = fix(data[j][i]);
    }
    ctx.putImageData(target, 0, 0);
    return canvas;
}
////================================================================================================
//// exrファイルから、equirectangularのcanvasを作成
////================================================================================================
export async function exr2canvas(file) {
    const loader = new EXRLoader();
    const texture = await loader.loadAsync(URL.createObjectURL(file));
    const toneMapping = 3;//1~4 コントラストを向上
    const { data, width, height } = texture.image, { length } = data;
    const range = (t => {
        let min = Infinity, max = -Infinity, sum = 0;
        t.forEach(u => { min = Math.min(min, u), max = Math.max(max, u), sum += u; });
        return { min, max, avr: sum / t.length };
    })(data);
    console.log(`%c${file.name}: size=${comma(file.size)} ${comma(width)} x ${comma(height)}`, "font-size:1.5em");
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    const target = ctx.createImageData(width, height), dst = target.data;
    const fix = t => Math.min(Math.pow((t - range.min) / (range.max - range.min), toneMapping) * 255, 255) | 0;
    data.forEach((t, i) => dst[i] = (i % 4) == 3 ? 255 : fix(t));
    ctx.putImageData(target, 0, 0);
    return canvas;
}
////================================================================================================
//// tileデータから、equirectangularのcanvasを作成
////================================================================================================
export async function tile2canvasx(url, z = 6) {
    let a = [];
    const AY4 = [0, 0, 0, 0, 0, 4, 8, 20, 44, 88, 180, 360, 724, 1452, 2904, 5808, 11616, 23236, 46476, 92952, 185908, 371820, 743644];
    const AY2 = [0, 0, 0, 2, 4, 8, 18, 36, 74, 148, 296, 594, 1188, 2378, 4756, 9514, 19030, 38062, 76126, 152252, 304506, 609012, 1218024];
    const fetchImage = async (url, xyz) => {
        async function blob2image(blob) {
            let img = new Image(); img.src = URL.createObjectURL(blob);
            return img.decode().then(() => { URL.revokeObjectURL(img.src); return img });
        }
        return fetch(url(xyz)).then(async v => v.ok ? blob2image(await v.blob()) : null).catch(e => null);
    };
    const tileSize = 256, n = 1 << z, size = tileSize * n, Y4 = AY4[z], Y2 = AY2[z];
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext("2d");
    for (let j = 0; j < n; j++) {
        let dz = (j < Y4 || n - j - 1 < Y4) ? 2 : (j < Y2 || n - j - 1 < Y2) ? 1 : 0; if (j % (1 << dz)) continue;
        for (let i = 0; i < n; i += (1 << dz)) a.push([i, j, dz]);
    }
    console.log(` <= reading ${comma(a.length)} tiles`);
    await thenEach(a, ([x, y, dz]) => fetchImage(url, [x >> dz, y >> dz, z - dz])
        .then(v => v && ctx.drawImage(v, x * tileSize, y * tileSize, tileSize * (1 << dz), tileSize * (1 << dz))));
    const src = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const width = size, height = size / 2;
    const target = ctx.createImageData(width, height), dst = target.data;
    console.log(` mapping titles to imag [ ${comma(width)} x ${comma(height)} ]`);
    let ii = 0;
    for (let j = 0; j < height; j++) {
        let y = ((1 - Math.atanh(Math.sin((0.5 - j / height) * Math.PI)) / Math.PI) * 0.5) * size;
        if (y < 0) {
            let jj = 0;
            for (let i = 0; i < width * 4; i++) dst[ii++] = src[jj++];
        } else if (y > size - 2) {
            let jj = (size - 1) * width * 4;
            for (let i = 0; i < width * 4; i++) dst[ii++] = src[jj++];
        } else {
            let y0 = y | 0, y1 = y0 + 1, dy = y - y0;
            for (let i = 0; i < width; i++) {
                let j0 = (y0 * width + i) * 4, j1 = (y1 * width + i) * 4;
                for (let k = 0; k < 4; k++) {
                    let v0 = src[j0++], v1 = src[j1++]
                    dst[ii++] = (v0 + (v1 - v0) * dy) | 0
                }
            }
        }
    }
    canvas.width = width, canvas.height = height;
    ctx.putImageData(target, 0, 0);
    return canvas;
}
export async function tile2canvas(url, z = 6) {
    let a = [];
    const AY4 = [0, 0, 0, 0, 0, 4, 8, 20, 44, 88, 180, 360, 724, 1452, 2904, 5808, 11616, 23236, 46476, 92952, 185908, 371820, 743644];
    const AY2 = [0, 0, 0, 2, 4, 8, 18, 36, 74, 148, 296, 594, 1188, 2378, 4756, 9514, 19030, 38062, 76126, 152252, 304506, 609012, 1218024];
    const fetchImage = async (url, xyz) => {
        return fetch(url(xyz)).then(async v => {
            if (!v.ok) return null;
            let img = new Image(); img.src = URL.createObjectURL(await v.blob());
            await img.decode(); URL.revokeObjectURL(img.src); return img;
        }).catch(() => null);
    };
    const tileSize = 256, n = 1 << z, size = tileSize * n, Y4 = AY4[z], Y2 = AY2[z];
    const srcCanvas = new OffscreenCanvas(size, size), srcCtx = srcCanvas.getContext("2d", { willReadFrequently: true });
    for (let j = 0; j < n; j++) {
        let dz = (j < Y4 || n - j - 1 < Y4) ? 2 : (j < Y2 || n - j - 1 < Y2) ? 1 : 0;
        if (j % (1 << dz)) continue;
        for (let i = 0; i < n; i += (1 << dz)) a.push([i, j, dz]);
    }
    console.log(` <= reading ${a.length} tiles`);
    await thenEach(a, ([x, y, dz]) => fetchImage(url, [x >> dz, y >> dz, z - dz])
        .then(v => v && srcCtx.drawImage(v, x * tileSize, y * tileSize, tileSize * (1 << dz), tileSize * (1 << dz))));
    const width = size, height = size / 2, destCanvas = new OffscreenCanvas(width, height), destCtx = destCanvas.getContext("2d");
    console.log(` mapping tiles to image [ ${width} x ${height} ]`);
    const CHUNK = 256, getY = (j) => ((1 - Math.atanh(Math.sin((0.5 - j / height) * Math.PI)) / Math.PI) * 0.5) * size;
    for (let chunkY = 0; chunkY < height; chunkY += CHUNK) {
        let jEnd = Math.min(height, chunkY + CHUNK) - 1;
        let srcY0 = Math.max(0, Math.min(size - 1, Math.floor(getY(chunkY))));
        let srcY1 = Math.max(0, Math.min(size - 1, Math.floor(getY(jEnd)) + 1));
        let srcH = srcY1 - srcY0 + 1, srcData = srcCtx.getImageData(0, srcY0, width, srcH).data;
        let destH = jEnd - chunkY + 1, destImgData = destCtx.createImageData(width, destH), dst = destImgData.data, ii = 0;
        for (let j = chunkY; j <= jEnd; j++) {
            let y = getY(j), localY = Math.floor(y) - srcY0, useRow1 = true, dy = y - Math.floor(y);
            if (y < 0) { localY = 0; useRow1 = false; dy = 0; }
            else if (y > size - 2) { localY = srcH - 1; useRow1 = false; dy = 0; }
            let row0Offset = localY * width * 4, row1Offset = useRow1 ? (localY + 1) * width * 4 : row0Offset;
            for (let i = 0; i < width; i++) {
                let idx = i << 2, p0 = row0Offset + idx, p1 = row1Offset + idx;
                dst[ii++] = (srcData[p0] + (srcData[p1] - srcData[p0]) * dy) | 0;
                dst[ii++] = (srcData[p0 + 1] + (srcData[p1 + 1] - srcData[p0 + 1]) * dy) | 0;
                dst[ii++] = (srcData[p0 + 2] + (srcData[p1 + 2] - srcData[p0 + 2]) * dy) | 0;
                dst[ii++] = (srcData[p0 + 3] + (srcData[p1 + 3] - srcData[p0 + 3]) * dy) | 0;
            }
        }
        destCtx.putImageData(destImgData, 0, chunkY);
    }
    srcCanvas.width = srcCanvas.height = 0;
    return destCanvas;
}