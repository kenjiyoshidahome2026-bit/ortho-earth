/**
 * 土地利用細分メッシュ（ラスタ版）L03-b_r TIF → WebP 変換
 *
 * 処理:
 *   1. NLFTP から全175 ZIPをダウンロード
 *   2. ZIP内の TIF を解凍（adm-zip）
 *   3. GeoTIFF からColorMap・PixelScale・Tiepoint を読み取り
 *   4. ピクセル値をRGBA化（index=0,255 は透明）してWebP変換（sharp）
 *   5. バケットに WebP をアップロード
 *   6. l03b-r-catalog.json を生成（{meshCode, bbox, file, width, height}）
 *
 * 出力バケットパス: l03b-r/{meshCode}.webp
 * 使い方: node l03b-r-convert.js [--dry-run] [--resume]
 */
import { writeFileSync, existsSync, readFileSync } from 'fs';
import AdmZip from 'adm-zip';
import sharp from 'sharp';
import { Bucket } from '../../packages/native-bucket/src/Bucket.js';

const NLFTP_BASE  = 'https://nlftp.mlit.go.jp';
const PAGE_URL    = `${NLFTP_BASE}/ksj/gml/datalist/KsjTmplt-L03-b_r.html`;
const API_BASE    = 'https://api.ortho-earth.com';
const API_KEY     = '***REMOVED***';
const BUCKET_DIR  = 'l03b-r';
const CATALOG_OUT = 'l03b-r-catalog.json';
const PROGRESS    = 'l03b-r-progress.json';
const DRY_RUN     = process.argv.includes('--dry-run');
const RESUME      = process.argv.includes('--resume');
const CONCURRENCY = 4;

// ---------------------------------------------------------------------------
// GeoTIFF パーサー（ColorMap + BBOX 抽出 + 生ピクセル取得）
// ---------------------------------------------------------------------------

function readU16LE(buf, off) { return buf[off] | (buf[off+1] << 8); }
function readU32LE(buf, off) { return (buf[off] | (buf[off+1]<<8) | (buf[off+2]<<16) | (buf[off+3]<<24)) >>> 0; }
function readF64LE(buf, off) {
  const ab = new ArrayBuffer(8);
  const dv = new DataView(ab);
  for (let i = 0; i < 8; i++) dv.setUint8(i, buf[off+i]);
  return dv.getFloat64(0, true);
}

function parseGeoTiff(buf) {
  const ifdOff  = readU32LE(buf, 4);
  const nTags   = readU16LE(buf, ifdOff);

  let width=0, height=0, bitsPerSample=8;
  let stripOffsets=[], stripByteCounts=[];
  let colorMap=null, pixelScaleOff=-1, tiepointOff=-1;

  for (let i = 0; i < nTags; i++) {
    const o = ifdOff + 2 + i * 12;
    const tag   = readU16LE(buf, o);
    const dtype = readU16LE(buf, o+2);
    const count = readU32LE(buf, o+4);
    const vOff  = readU32LE(buf, o+8);  // value or offset

    if (tag === 256) { width  = vOff; }
    if (tag === 257) { height = vOff; }
    if (tag === 258) { bitsPerSample = readU16LE(buf, o+8); }

    if (tag === 273) { // StripOffsets
      if (count === 1) {
        stripOffsets = [vOff];
      } else {
        for (let j = 0; j < count; j++)
          stripOffsets.push(readU32LE(buf, vOff + j*4));
      }
    }
    if (tag === 279) { // StripByteCounts
      if (count === 1) {
        stripByteCounts = [vOff];
      } else {
        for (let j = 0; j < count; j++)
          stripByteCounts.push(readU32LE(buf, vOff + j*4));
      }
    }
    if (tag === 320) { // ColorMap: 3*256 uint16 values (R section, G section, B section)
      colorMap = { off: vOff, n: count / 3 };
    }
    if (tag === 33550) { pixelScaleOff = vOff; } // ModelPixelScaleTag (3 doubles)
    if (tag === 33922) { tiepointOff   = vOff; } // ModelTiepointTag   (6 doubles)
  }

  // ColorMap → RGBA 256エントリ (alpha=255 、index 0 と 255 は透明)
  const palette = new Uint8Array(256 * 4);
  if (colorMap) {
    const n = colorMap.n;
    for (let k = 0; k < n; k++) {
      const r = readU16LE(buf, colorMap.off + k*2)         >> 8;
      const g = readU16LE(buf, colorMap.off + n*2 + k*2)   >> 8;
      const b = readU16LE(buf, colorMap.off + n*2*2 + k*2) >> 8;
      const a = (k === 0 || k === 255) ? 0 : 255;
      palette[k*4]   = r;
      palette[k*4+1] = g;
      palette[k*4+2] = b;
      palette[k*4+3] = a;
    }
  }

  // BBOX
  let bbox = null;
  if (pixelScaleOff >= 0 && tiepointOff >= 0) {
    const scaleX = readF64LE(buf, pixelScaleOff);
    const scaleY = readF64LE(buf, pixelScaleOff + 8);
    const tpX    = readF64LE(buf, tiepointOff + 24); // lon of (0,0)
    const tpY    = readF64LE(buf, tiepointOff + 32); // lat of (0,0)
    const west   = tpX;
    const north  = tpY;
    const east   = tpX + width  * scaleX;
    const south  = tpY - height * scaleY;
    bbox = [
      parseFloat(west.toFixed(8)),
      parseFloat(south.toFixed(8)),
      parseFloat(east.toFixed(8)),
      parseFloat(north.toFixed(8)),
    ];
  }

  // 生ピクセルデータ収集（ストリップ連結）
  const rawPx = Buffer.alloc(width * height);
  let pos = 0;
  for (let si = 0; si < stripOffsets.length; si++) {
    const src = stripOffsets[si];
    const len = stripByteCounts[si];
    buf.copy(rawPx, pos, src, src + len);
    pos += len;
  }

  // RGBA 変換
  const rgba = Buffer.alloc(width * height * 4);
  for (let p = 0; p < rawPx.length; p++) {
    const idx = rawPx[p];
    rgba[p*4]   = palette[idx*4];
    rgba[p*4+1] = palette[idx*4+1];
    rgba[p*4+2] = palette[idx*4+2];
    rgba[p*4+3] = palette[idx*4+3];
  }

  return { width, height, rgba, bbox };
}

// ---------------------------------------------------------------------------
// 並列処理
// ---------------------------------------------------------------------------
async function pool(items, limit, fn) {
  const queue = [...items];
  let active = 0, idx = 0;
  const results = new Array(items.length);
  return new Promise(resolve => {
    function next() {
      while (active < limit && queue.length) {
        active++;
        const i = idx++, item = queue.shift();
        fn(item, i)
          .then(r  => { results[i] = r; })
          .catch(e => { results[i] = { error: e.message }; })
          .finally(() => { active--; next(); if (!active && !queue.length) resolve(results); });
      }
      if (!active && !queue.length) resolve(results);
    }
    next();
  });
}

// ---------------------------------------------------------------------------
// メイン
// ---------------------------------------------------------------------------
async function main() {
  // ZIP URL 一覧取得
  console.log('L03-b_r ページからZIPリストを取得中...');
  const pageHtml = await fetch(PAGE_URL).then(r => r.text());
  const zipRe = /L03-b_r\/[^\s"'<>]+\.zip/g;
  const zipPaths = [...new Set([...pageHtml.matchAll(zipRe)].map(m => m[0]))];
  console.log(`ZIP: ${zipPaths.length} 件`);

  // メッシュコード抽出
  const items = zipPaths.map(path => {
    const meshMatch = path.match(/_(\d{4}(?:_\d+)?)\.zip$/i);
    const meshCode  = meshMatch ? meshMatch[1] : path.split('/').pop().replace('.zip','');
    return { path, meshCode, url: `${NLFTP_BASE}/ksj/gml/data/${path}` };
  });

  // 進捗復元
  const progress = (RESUME && existsSync(PROGRESS))
    ? new Set(JSON.parse(readFileSync(PROGRESS, 'utf8')))
    : new Set();
  const pending = items.filter(it => !progress.has(it.meshCode));
  console.log(`処理対象: ${pending.length} / ${items.length} 件 (完了済み: ${progress.size})`);

  if (DRY_RUN) {
    console.log('[DRY RUN] サンプル:', items.slice(0, 2));
    return;
  }

  // バケット接続
  const bucket = await Bucket(BUCKET_DIR, { baseUrl: `${API_BASE}/bucket/`, apiKey: API_KEY, silent: true });
  if (!bucket) { console.error('バケット接続失敗'); process.exit(1); }

  const catalogEntries = {};

  // 既存完了分のカタログを読み込む
  if (RESUME && existsSync(CATALOG_OUT)) {
    Object.assign(catalogEntries, JSON.parse(readFileSync(CATALOG_OUT, 'utf8')));
  }

  let done = 0, errors = 0;
  const results = await pool(pending, CONCURRENCY, async ({ path, meshCode, url }, _i) => {
    try {
      // ZIP ダウンロード
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());

      // TIF 抽出
      const zip = new AdmZip(buf);
      const tifEntry = zip.getEntries().find(e => /\.tif$/i.test(e.entryName));
      if (!tifEntry) throw new Error('TIF not found in ZIP');
      const tifBuf = tifEntry.getData();

      // GeoTIFF パース + RGBA 生成
      const { width, height, rgba, bbox } = parseGeoTiff(tifBuf);

      // WebP エンコード（透明度付き）
      const webpBuf = await sharp(rgba, { raw: { width, height, channels: 4 } })
        .webp({ quality: 80, lossless: false, alphaQuality: 100 })
        .toBuffer();

      // バケットアップロード
      const filename = `${meshCode}.webp`;
      await bucket.put(filename, new Blob([webpBuf], { type: 'image/webp' }));

      progress.add(meshCode);
      done++;
      process.stdout.write(`\r[${String(done+errors).padStart(3)}/${pending.length}] ✓ ${meshCode} ${width}x${height} ${bbox} ${webpBuf.length}B`);

      return { meshCode, bbox, file: filename, width, height, size: webpBuf.length };
    } catch (e) {
      errors++;
      process.stdout.write(`\r[${String(done+errors).padStart(3)}/${pending.length}] ✗ ${meshCode}: ${e.message}\n`);
      return { meshCode, error: e.message };
    }
  });

  // カタログ更新
  for (const r of results) {
    if (!r.error) catalogEntries[r.meshCode] = { bbox: r.bbox, file: r.file, width: r.width, height: r.height, size: r.size };
  }
  writeFileSync(CATALOG_OUT, JSON.stringify(catalogEntries, null, 2), 'utf8');
  writeFileSync(PROGRESS, JSON.stringify([...progress]), 'utf8');

  console.log(`\n\n✅ 完了: ${done}件 / エラー: ${errors}件`);
  console.log(`   ${CATALOG_OUT}: ${Object.keys(catalogEntries).length} 件`);
}

main().catch(console.error);
