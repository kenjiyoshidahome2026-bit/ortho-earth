/**
 * L03-b_r WebP 変換ワーカー
 * 受信: { meshCode, proxyUrl }
 * 送信: { meshCode, webpData: Uint8Array, bbox } or { meshCode, error }
 */

function readU16LE(u8, off) { return u8[off] | (u8[off + 1] << 8); }
function readU32LE(u8, off) {
    return (u8[off] | (u8[off+1]<<8) | (u8[off+2]<<16) | (u8[off+3]<<24)) >>> 0;
}

function parseGeoTiff(u8) {
    const ifdOff = readU32LE(u8, 4);
    const nTags  = readU16LE(u8, ifdOff);

    let width = 0, height = 0;
    let stripOffsets = [], stripByteCounts = [];
    let colorMap = null, pixelScaleOff = -1, tiepointOff = -1;

    for (let i = 0; i < nTags; i++) {
        const o     = ifdOff + 2 + i * 12;
        const tag   = readU16LE(u8, o);
        const count = readU32LE(u8, o + 4);
        const vOff  = readU32LE(u8, o + 8);

        if (tag === 256) { width  = vOff; }
        else if (tag === 257) { height = vOff; }
        else if (tag === 273) {
            if (count === 1) stripOffsets = [vOff];
            else for (let j = 0; j < count; j++) stripOffsets.push(readU32LE(u8, vOff + j*4));
        }
        else if (tag === 279) {
            if (count === 1) stripByteCounts = [vOff];
            else for (let j = 0; j < count; j++) stripByteCounts.push(readU32LE(u8, vOff + j*4));
        }
        else if (tag === 320) { colorMap = { off: vOff, n: count / 3 }; }
        else if (tag === 33550) { pixelScaleOff = vOff; }
        else if (tag === 33922) { tiepointOff   = vOff; }
    }

    // ColorMap → RGBA パレット（index 0 と 255 は透明）
    const palette = new Uint8Array(256 * 4);
    if (colorMap) {
        const n = colorMap.n, base = colorMap.off;
        for (let k = 0; k < n; k++) {
            palette[k*4]   = readU16LE(u8, base + k*2) >> 8;
            palette[k*4+1] = readU16LE(u8, base + n*2 + k*2) >> 8;
            palette[k*4+2] = readU16LE(u8, base + n*4 + k*2) >> 8;
            palette[k*4+3] = (k === 0 || k === 255) ? 0 : 255;
        }
    }

    // BBOX (GeoTIFF ModelPixelScale + ModelTiepoint)
    let bbox = null;
    if (pixelScaleOff >= 0 && tiepointOff >= 0) {
        const dv     = new DataView(u8.buffer, u8.byteOffset);
        const scaleX = dv.getFloat64(pixelScaleOff, true);
        const scaleY = dv.getFloat64(pixelScaleOff + 8, true);
        const tpX    = dv.getFloat64(tiepointOff + 24, true);
        const tpY    = dv.getFloat64(tiepointOff + 32, true);
        bbox = [
            +tpX.toFixed(8),
            +(tpY - height * scaleY).toFixed(8),
            +(tpX + width  * scaleX).toFixed(8),
            +tpY.toFixed(8),
        ];
    }

    // ストリップ連結 → RGBA 変換
    const rawPx = new Uint8Array(width * height);
    let pos = 0;
    for (let si = 0; si < stripOffsets.length; si++) {
        rawPx.set(u8.subarray(stripOffsets[si], stripOffsets[si] + stripByteCounts[si]), pos);
        pos += stripByteCounts[si];
    }

    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let p = 0; p < rawPx.length; p++) {
        const idx = rawPx[p], b = idx * 4;
        rgba[p*4] = palette[b]; rgba[p*4+1] = palette[b+1];
        rgba[p*4+2] = palette[b+2]; rgba[p*4+3] = palette[b+3];
    }

    return { width, height, rgba, bbox };
}

async function extractTifFromZip(u8) {
    let pos = 0;
    while (pos + 30 <= u8.length) {
        if (readU32LE(u8, pos) !== 0x04034b50) break; // Local File Header
        const method    = readU16LE(u8, pos + 8);
        const compSize  = readU32LE(u8, pos + 18);
        const fnLen     = readU16LE(u8, pos + 26);
        const exLen     = readU16LE(u8, pos + 28);
        const name      = new TextDecoder().decode(u8.subarray(pos + 30, pos + 30 + fnLen));
        const dataStart = pos + 30 + fnLen + exLen;

        if (/\.tiff?$/i.test(name)) {
            const compData = u8.subarray(dataStart, dataStart + compSize);
            if (method === 0) return compData; // STORE
            if (method === 8) {               // DEFLATE
                const ds = new DecompressionStream('deflate-raw');
                const w  = ds.writable.getWriter();
                w.write(compData.slice());    // slice to own buffer
                w.close();
                return new Uint8Array(await new Response(ds.readable).arrayBuffer());
            }
            throw new Error(`ZIP method ${method} unsupported`);
        }
        pos = dataStart + compSize;
    }
    throw new Error('TIF not found in ZIP');
}

self.onmessage = async ({ data: { meshCode, proxyUrl, format = 'webp' } }) => {
    try {
        const res = await fetch(proxyUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status} (${proxyUrl})`);
        const arrayBuf = await res.arrayBuffer();

        const tifData = await extractTifFromZip(new Uint8Array(arrayBuf));
        const { width, height, rgba, bbox } = parseGeoTiff(tifData);

        const canvas = new OffscreenCanvas(width, height);
        canvas.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);
        const quality = format === 'jpeg' ? 0.8 : format === 'webp' ? 0.85 : undefined;
        const blob    = await canvas.convertToBlob({ type: `image/${format}`, quality });
        const webpData = new Uint8Array(await blob.arrayBuffer());

        self.postMessage({ meshCode, webpData, bbox, format }, [webpData.buffer]);
    } catch (e) {
        self.postMessage({ meshCode, error: e.message });
    }
};
