// 変換 CLI（scripts/las2splat.mjs）の --cpu の検定＝COPC の試料（globe の fixtures・10 万点・EPSG:3857・ニューヨーク湾）を 3D Tiles ＋ SPZ に。node tests/t-las2splat.mjs
//   ① 書き出しの一式（tileset.json＝段の鎖・level<L>.glb＝glTF・<name>.spz＝gzip・placement.json＝錨） ② 点の上限（--max-points）と段の数（--levels） ③ 使い方の誤り＝exit 2
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { decodeSpz } from "../src/index.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url)), CLI = path.join(HERE, "../scripts/las2splat.mjs"), FX = path.join(HERE, "../../../packages/globe/tests/fixtures/copc/ellipsoid.copc.laz");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "las2splat-"));
let tn = 0;
const t = (name, fn) => { fn(); tn++; console.log("  ✔", name); };
const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { encoding: "utf8" });

const r = run(FX, "--out", out, "--cpu", "--max-points", "30000", "--levels", "3", "--quiet");
t("① 一式が書ける", () => {
	assert.equal(r.status, 0, r.stderr);
	const names = fs.readdirSync(out).sort();
	assert.deepEqual(names, ["ellipsoid.spz", "level0.glb", "level1.glb", "level2.glb", "placement.json", "tileset.json"]);
	const ts = JSON.parse(fs.readFileSync(path.join(out, "tileset.json"), "utf8"));
	assert.equal(ts.root.content.uri, "level2.glb"); assert.equal(ts.root.refine, "REPLACE"); assert.equal(ts.root.transform.length, 16);
	assert.equal(ts.root.children[0].children[0].content.uri, "level0.glb");
	for (const n of ["level0.glb", "level1.glb", "level2.glb"]) { const b = fs.readFileSync(path.join(out, n)); assert.equal(b.subarray(0, 4).toString(), "glTF", n); assert.equal(b.readUInt32LE(8), b.length, `${n} length`); }
	const spz = fs.readFileSync(path.join(out, "ellipsoid.spz"));
	assert.ok(spz[0] === 0x1f && spz[1] === 0x8b, "gzip");
	const d = decodeSpz(gunzipSync(spz));
	assert.ok(d.n > 15000 && d.n <= 25000, `level 0 has ${d.n} splats`);   // 25,000 点を読み、セルにまとめて少し減る
	const pl = JSON.parse(fs.readFileSync(path.join(out, "placement.json"), "utf8"));
	assert.ok(Math.abs(pl.anchor[0] + 74.0445) < 0.01 && Math.abs(pl.anchor[1] - 40.6892) < 0.01, JSON.stringify(pl.anchor));   // リバティ島の脇
	assert.equal(pl.addData.upAxis, "z"); assert.equal(pl.transform.length, 16);
});
t("② --format spz＝spz だけ・--max-points 0＝全点", () => {
	const o2 = fs.mkdtempSync(path.join(os.tmpdir(), "las2splat-")), r2 = run(FX, "--out", o2, "--cpu", "--format", "spz", "--max-points", "0", "--levels", "2", "--quiet");
	assert.equal(r2.status, 0, r2.stderr);
	assert.deepEqual(fs.readdirSync(o2).sort(), ["ellipsoid.spz", "placement.json"]);
	const d = decodeSpz(gunzipSync(fs.readFileSync(path.join(o2, "ellipsoid.spz"))));
	assert.ok(d.n > 40000, `all 100,000 points → ${d.n} splats`);
	fs.rmSync(o2, { recursive: true, force: true });
});
t("③ 使い方の誤り", () => {
	assert.equal(run().status, 2);
	assert.equal(run(FX).status, 2);
	assert.notEqual(run("/nonexistent.las", "--out", out, "--cpu", "--quiet").status, 0);
});
fs.rmSync(out, { recursive: true, force: true });
console.log(`t-las2splat: ${tn} 件 OK`);
