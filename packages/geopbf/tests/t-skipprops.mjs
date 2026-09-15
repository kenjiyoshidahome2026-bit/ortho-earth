// t-skipprops: getPosition({skipProps:true})（decoder:pbf Worker の毎ロード経路）が全復号と同じ fmap/end を出し、props は遅延復号で同値になること
// （2026-09-15 俯瞰レビュー③。`pos += readVarint()` の評価順の罠＝varint 分ずれて "Unimplemented type" で踏んだ）
globalThis.ImageData ??= class { constructor(d, w, h) { this.data = d; this.width = w; this.height = h; } };
import fs from "node:fs";
import Pbf from "../src/modules/pbf.js";
import { GeoPBF } from "../src/pbf-base.js";
let fails = 0;
const ok = (c, m) => { if (!c) { console.error("✗", m); fails++; } else console.log("✓", m); };
const buf = fs.readFileSync(new URL("./fixtures/amedas.geopbf", import.meta.url));
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const a = new GeoPBF(); a.pbf = new Pbf(ab.slice(0)); await a.getPosition();
const b = new GeoPBF(); b.pbf = new Pbf(ab.slice(0)); await b.getPosition({ skipProps: true });
ok(a.fmap.length === b.fmap.length && a.fmap.length > 1000, `fmap 件数一致（${a.fmap.length}）`);
ok(JSON.stringify(a.fmap) === JSON.stringify(b.fmap), "fmap（位置/型）が全復号と一致");
ok(a.end === b.end && a._bodyPos === b._bodyPos && a.keys.join() === b.keys.join(), "end/bodyPos/keys 一致");
ok(b.props.every(p => p === undefined), "skipProps＝props は未復号（undefined）");
let same = true; for (let i = 0; i < a.fmap.length; i += 97) if (JSON.stringify(a.getProperties(i)) !== JSON.stringify(b.getProperties(i))) same = false;
ok(same, "遅延復号（getProperties）が全復号と同値");
ok(JSON.stringify(a.getGeometry(5)) === JSON.stringify(b.getGeometry(5)), "geometry も同値");
console.log(fails ? `FAIL (${fails})` : "PASS"); process.exit(fails ? 1 : 0);
