// タイル 1 枚の CPU 経路（decode→buildTilePayload→mergeTiles）の node の計り（実機の GPU は要らない）。
// 使い方：node packages/ortho-core/scripts/bench-tile.mjs [--runs N] [--hash]
//   見本＝globe/tests/fixtures/optbv（地理院 optbv・WA/Anno だけ）× 内蔵の gsi style、tile-formats の omt 0/0/0 × 汎用 PMTiles の規則（pm-mono）
//   --hash＝出力（ops の typed array・labels）の FNV 指紋＝最適化の前後でビット同値を確かめる
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeMVT, neededSourceLayers } from "../src/decode.js";
import { buildTilePayload } from "../src/tilepayload.js";
import { mergeTiles } from "../src/scene.js";
import gsi from "../../globe/src/style-gsi.js";
import mono from "../../globe/src/style-mono.js";
import { pmLayers } from "../../globe/src/style-pm.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const runs = +(args[args.indexOf("--runs") + 1] || 0) || 20;
const wantHash = args.includes("--hash");
const only = args.includes("--case") ? args[args.indexOf("--case") + 1] : null;   // --case <名前の一部>＝その見本だけ

const PM_INFO = { layers: ["earth", "water", "waterway", "landuse", "landcover", "roads", "transportation", "buildings", "boundaries", "places", "pois", "transit", "other"] };
const CASES = [];
{
	const root = path.join(DIR, "../../globe/tests/fixtures/optbv");
	const tiles = [];
	const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith(".pbf")) tiles.push(p); } };
	walk(root);
	CASES.push({ name: "optbv×gsi", style: { layers: gsi.layers, schema: gsi.schema }, tiles: tiles.map(p => { const [y, x, z] = p.slice(0, -4).split("/").reverse().map(Number); return { z, x, y, buf: new Uint8Array(fs.readFileSync(p)) }; }) });
}
{
	const p = path.join(DIR, "../../tile-formats/tests/fixtures/omt/0_0_0.mvt");
	if (fs.existsSync(p)) CASES.push({ name: "omt z0×pm-mono", style: { layers: pmLayers(PM_INFO, { style: mono }) }, tiles: [{ z: 0, x: 0, y: 0, buf: new Uint8Array(fs.readFileSync(p)) }] });
}

const fnv = (h, b) => { const u = new Uint8Array(b.buffer, b.byteOffset, b.byteLength); for (let i = 0; i < u.length; i++) { h ^= u[i]; h = Math.imul(h, 16777619) >>> 0; } return h; };
const enc = new TextEncoder();
function hashPayload(h, pl) {
	for (const op of pl.dl.ops) { h = fnv(h, enc.encode(`${op.kind}|${op.li}|${op.id}|`)); for (const k of ["pos", "col", "idx", "P1", "P2", "half", "off"]) if (op[k]) h = fnv(h, op[k]); }
	h = fnv(h, enc.encode(JSON.stringify(pl.labels ?? null)));
	return h;
}
const ms = t => (Number(process.hrtime.bigint() - t) / 1e6);

for (const c of CASES) {
	if (only && !c.name.includes(only)) continue;
	const need = neededSourceLayers(c.style);
	let hash = 2166136261;
	for (const t of c.tiles) buildTilePayload(decodeMVT(t.buf, need), t, c.style);   // 温め
	const tDec = [], tBld = [], tMrg = [];
	let bytes = 0, feats = 0;
	for (let r = 0; r < runs; r++) {
		const payloads = new Map();
		for (const t of c.tiles) {
			let t0 = process.hrtime.bigint();
			const layers = decodeMVT(t.buf, need);
			tDec.push(ms(t0));
			if (r === 0) for (const k in layers) if (layers[k]?.features) feats += layers[k].features.length;
			t0 = process.hrtime.bigint();
			const pl = buildTilePayload(layers, t, c.style);
			tBld.push(ms(t0));
			if (r === 0) { bytes += pl.bytes; if (wantHash) hash = hashPayload(hash, pl); }
			payloads.set(`${t.z}/${t.x}/${t.y}`, { origin: pl.origin, ops: pl.dl.ops });
		}
		const order = [...payloads].map(([key, v]) => ({ key, origin: v.origin }));
		const t0 = process.hrtime.bigint();
		mergeTiles(order, k => payloads.get(k));
		tMrg.push(ms(t0));
	}
	const sum = a => a.reduce((s, v) => s + v, 0);
	console.log(`${c.name}: tiles=${c.tiles.length} feats=${feats} bytes=${(bytes / 1024).toFixed(0)}KB  decode ${(sum(tDec) / runs).toFixed(2)}ms  build ${(sum(tBld) / runs).toFixed(2)}ms  merge ${(sum(tMrg) / runs).toFixed(2)}ms  (all tiles per run, mean of ${runs})${wantHash ? `  hash=${hash.toString(16)}` : ""}`);
}
