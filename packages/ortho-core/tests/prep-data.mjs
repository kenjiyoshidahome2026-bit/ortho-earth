// gint-lod.mjs --coast 等の実データを bucket から取得し GintBUF に焼いて tests/data/ に置く。
// 引数でデータセットを選ぶ（既定=NE10m海岸線）: bash prep-data.sh [bucket名] [保存プレフィクス]
//   例: bash prep-data.sh nps_all nps   → tests/data/nps-*.bin（国立公園＝離散ポリゴンの基準データ）
// geopbf は拡張子なし import を含むため素の Node では動かない＝prep-data.sh が esbuild でバンドルして実行する。
import init from '../../geopbf/wasm/pkg/gint_wasm.js';
import { GeoPBF } from '../../geopbf/src/pbf.js';
import { gint } from '../../geopbf/src/extension/gint.js';
import { topology } from '../../geopbf/src/extension/topology.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// esbuild バンドルは $TMP で走る＝import.meta.url 相対は壊れる。prep-data.sh が ORTHO_ROOT を渡す。
const HERE = process.env.ORTHO_ROOT
	? path.join(process.env.ORTHO_ROOT, 'packages/ortho-core/tests')
	: path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, 'data');
mkdirSync(DATA, { recursive: true });

const DATASET = process.argv[2] || 'ne_10m_coastline';
const PREFIX  = process.argv[3] || (DATASET === 'ne_10m_coastline' ? 'coast' : DATASET.replace(/[^a-z0-9]+/gi, '-'));
const res = await fetch(`https://api.ortho-earth.com/bucket/GIS/pbf/${DATASET}`);
if (!res.ok) { console.error('bucket fetch 失敗 HTTP', res.status, DATASET); process.exit(1); }
let buf = Buffer.from(await res.arrayBuffer());
if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);

await init(readFileSync(path.join(HERE, '../../geopbf/wasm/pkg/gint_wasm_bg.wasm')));
const pbf = await new GeoPBF().set(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
await gint.initialize();
await pbf.setGintBUF(topology(pbf));
const g = pbf.unPackGint;
if (!g?.arcBuffer) { console.error('GintBUF 焼き失敗'); process.exit(1); }
console.log('arcs:', g.arcMeta.length / 8, '頂点:', g.arcBuffer.length,
	'lineStream:', g.lineStream?.length ?? 0, 'polyStream:', g.polyStream?.length ?? 0);
const save = (name, ta) => ta?.length && writeFileSync(path.join(DATA, `${PREFIX}-${name}.bin`), Buffer.from(ta.buffer, ta.byteOffset, ta.byteLength));
save('arcbuf', g.arcBuffer); save('arcmeta', g.arcMeta); save('linestream', g.lineStream); save('polystream', g.polyStream);
console.log('→', DATA, `(${PREFIX}-*.bin)`);
