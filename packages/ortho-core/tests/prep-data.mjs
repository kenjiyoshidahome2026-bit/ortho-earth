// gint-lod.mjs --coast 用の実データ（NE10m 海岸線）を bucket から取得し GintBUF に焼いて tests/data/ に置く。
// geopbf は拡張子なし import を含むため素の Node では動かない＝prep-data.sh が esbuild でバンドルして実行する。
import init from '../../geopbf/wasm/pkg/gint_wasm.js';
import { GeoPBF } from '../../geopbf/src/pbf.js';
import { gint } from '../../geopbf/src/extension/gint.js';
import { topology } from '../../geopbf/src/extension/topology.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, 'data');
mkdirSync(DATA, { recursive: true });

const res = await fetch('https://api.ortho-earth.com/bucket/GIS/pbf/ne_10m_coastline');
if (!res.ok) { console.error('bucket fetch 失敗 HTTP', res.status); process.exit(1); }
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
const save = (name, ta) => ta?.length && writeFileSync(path.join(DATA, `coast-${name}.bin`), Buffer.from(ta.buffer, ta.byteOffset, ta.byteLength));
save('arcbuf', g.arcBuffer); save('arcmeta', g.arcMeta); save('linestream', g.lineStream); save('polystream', g.polyStream);
console.log('→', DATA);
