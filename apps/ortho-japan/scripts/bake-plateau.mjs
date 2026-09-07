#!/usr/bin/env node
// PLATEAU 焼き（2026-09-07）＝カタログ（public/plateau-sets.json）の全セットをブラウザと同じデコード経路
// （plateaudecode.decodeBatch＝fetch→Draco→座標変換→dedup→接地→LOD→RTE→マスク断片）で Node 上で煮て、
// GPU 直行形式の量子化版（plateauq.js PLQ1）に落とす。置き先＝R2（native-bucket）GIS/plateau/v{DECODE_VER}/{slug}/。
// ブラウザ（plateauworker）はこの焼きを「第三の入口」として MLIT 生経路の前に引く＝Draco もデコード過渡メモリも無し。
// 無い/古い/壊れ＝生経路へ静かに落ちる（タイル粒度）。
//
//   node scripts/bake-plateau.mjs [--only=名前や base の部分文字列] [--out=DIR] [--batch=32] [--shard=i/n]
//                                 [--force] [--limit=N] [--sphere-only|--ell-only] [--upload] [--upload-only]
//   --out       既定 plateau-bake-out/（gitignore 済）。セットごとに {slug}/manifest.json + b{k}.plq（球）と {slug}/ell/…（楕円体）
//   --shard=i/n カタログを n 分割して i 番目だけ（Threadripper で並列に走らせる用。CPU 律速＝1プロセス1コア）
//   --upload    焼いたセットを直後に R2 へ put（要 API_KEY 環境変数＝native-bucket の書込キー）。--upload-only＝焼かず既存出力を押す
//   球（既定 ?ell 無し）と楕円体（?ell=1）は座標が違う＝別焼き。同じバッチの b3dm はプロセス内キャッシュで 1 回しか取らない。
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setLoaderOptions } from "@loaders.gl/core";
import draco3d from "draco3d";
import { decodeBatch, setDecodeEnv, collectLeafTiles, DECODE_VER } from "../plateaudecode.js";
import { packPLQ, bakeDir, PLQ_VER } from "../plateauq.js";

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
const arg = (k, d = null) => { const a = process.argv.find(s => s.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : (process.argv.includes(`--${k}`) ? true : d); };
const ONLY = arg("only"), OUT = arg("out", join(APP, "plateau-bake-out")), BATCH = +arg("batch", 32) || 32;
const FORCE = !!arg("force"), LIMIT = +arg("limit", 0), UPLOAD = !!arg("upload") || !!arg("upload-only"), UPLOAD_ONLY = !!arg("upload-only");
const MODES = arg("sphere-only") ? [false] : arg("ell-only") ? [true] : [false, true];
const [SHARD_I, SHARD_N] = String(arg("shard", "0/1")).split("/").map(Number);
const API = process.env.API_BASE ?? "https://api.ortho-earth.com";
const API_KEY = process.env.API_KEY;
if (UPLOAD && !API_KEY) { console.error("--upload には API_KEY 環境変数（native-bucket の書込キー）が要ります"); process.exit(2); }

// Draco＝draco3d（npm）を loaders.gl に注入（Node は CDN/ローカル lib の自動解決が効かない＝これが唯一の道）
setLoaderOptions({ modules: { draco3d } });
setDecodeEnv({ tileConcurrency: 8 });

// b3dm のプロセス内キャッシュ＝球/楕円体の 2 回目デコードで同じタイルを取り直さない（バッチ完了で捨てる）
const bodyCache = new Map();
const rawFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
	const key = typeof url === "string" ? url : url?.url;
	if (key && bodyCache.has(key)) return new Response(bodyCache.get(key).slice(0), { status: 200 });
	const r = await rawFetch(url, init);
	if (key && r.ok && /\.(b3dm|glb|gltf)(\?|$)/.test(key)) {
		const ab = await r.arrayBuffer();
		bodyCache.set(key, ab);
		return new Response(ab.slice(0), { status: 200, headers: r.headers });
	}
	return r;
};

const sets = JSON.parse(readFileSync(join(APP, "public/plateau-sets.json"), "utf8"));
let targets = sets.filter((s, i) => i % SHARD_N === SHARD_I);
if (ONLY) targets = targets.filter(s => s.name.includes(ONLY) || s.base.includes(ONLY));
if (LIMIT) targets = targets.slice(0, LIMIT);
console.log(`対象 ${targets.length} セット（shard ${SHARD_I}/${SHARD_N}${ONLY ? `・only=${ONLY}` : ""}）→ ${OUT}${UPLOAD ? " → R2" : ""}`);

const fmt = n => (n / 1e6).toFixed(1) + "MB";
const commonPrefix = arr => { if (!arr.length) return ""; let p = arr[0]; for (const s of arr) { while (!s.startsWith(p)) p = p.slice(0, -1); } return p.slice(0, p.lastIndexOf("/") + 1); };

async function bakeSet(set) {
	const base = set.base, brid = !!set.noMask, wardBbox = brid ? null : set.bbox;
	const dirs = MODES.map(ell => join(OUT, bakeDir(base, DECODE_VER, ell)));
	if (!FORCE && dirs.every(d => existsSync(join(d, "manifest.json")))) return "skip";
	const t0 = performance.now();
	const leaves = await collectLeafTiles(base + "tileset.json");
	if (!leaves.length) { console.warn(`  ${set.name}: 葉 0 枚＝空（廃止区の残骸？）`); return "empty"; }
	// 区中心からの距離順＝ブラウザの「近いバッチから」に対応する固定の並び（クライアントはバッチ bbox でさらにカメラ順に並べ替える）
	const cx = (set.bbox[0] + set.bbox[2]) / 2, cy = (set.bbox[1] + set.bbox[3]) / 2;
	const d2 = t => t.center ? (t.center[0] - cx) ** 2 + (t.center[1] - cy) ** 2 : Infinity;
	leaves.sort((a, b) => d2(a) - d2(b));
	const prefix = commonPrefix(leaves.map(t => t.uri));
	const tiles = leaves.map(t => t.uri.slice(prefix.length));
	const man = MODES.map(ell => ({ ver: DECODE_VER, plq: PLQ_VER, base, ward: set.name, brid, ell, wardBbox, prefix, tiles, batch: BATCH, batches: [], unbaked: [], ts: 0 }));
	for (const d of dirs) mkdirSync(d, { recursive: true });
	let bytesRaw = 0, bytesPlq = 0, k = 0;
	for (let i = 0; i < leaves.length; i += BATCH) {
		const slice = leaves.slice(i, i + BATCH), ti = slice.map((_, j) => i + j);
		for (let m = 0; m < MODES.length; m++) {
			setDecodeEnv({ ell: MODES[m] });
			let mesh = null;
			try { mesh = await decodeBatch(base, slice, null, wardBbox, null, brid, null, null); }
			catch (e) { console.warn(`  ${set.name}: batch ${k} decode failed (${MODES[m] ? "ell" : "sphere"})`, e?.message ?? e); }
			if (!mesh) { man[m].unbaked.push(...ti); continue; }
			const u8 = packPLQ(mesh);
			writeFileSync(join(dirs[m], `b${k}.plq`), u8);
			bytesRaw += mesh.pos.byteLength + mesh.nrm.byteLength + mesh.idx.byteLength; bytesPlq += u8.length;
			man[m].batches.push({ f: `b${k}.plq`, t: ti, bbox: mesh.bbox, tris: mesh.idx.length / 3, bytes: u8.length });
		}
		bodyCache.clear();
		k++;
	}
	for (let m = 0; m < MODES.length; m++) { man[m].ts = Date.now(); writeFileSync(join(dirs[m], "manifest.json"), JSON.stringify(man[m])); }
	const dt = (performance.now() - t0) / 1000;
	console.log(`  ${set.name}: ${leaves.length} 枚 ${k} バッチ ×${MODES.length} raw ${fmt(bytesRaw)} → plq ${fmt(bytesPlq)} (${(bytesPlq / bytesRaw * 100).toFixed(0)}%) ${dt.toFixed(0)}s${man.some(x => x.unbaked.length) ? ` ⚠unbaked ${man.map(x => x.unbaked.length).join("/")}` : ""}`);
	return "ok";
}

let bucketMod = null;
async function uploadSet(set) {
	bucketMod ??= (await import("native-bucket")).Bucket;
	let n = 0, bytes = 0;
	for (const ell of MODES) {
		const rel = bakeDir(set.base, DECODE_VER, ell), dir = join(OUT, rel);
		if (!existsSync(join(dir, "manifest.json"))) continue;
		const b = await bucketMod("GIS/plateau/" + rel, { baseUrl: `${API}/bucket/`, apiKey: API_KEY, silent: true });
		const files = readdirSync(dir).filter(f => f.endsWith(".plq"));
		files.push("manifest.json");   // 最後＝マニフェストが見えた時には本体が揃っている（クライアントの 404 → 生経路の判定に矛盾を作らない）
		for (const f of files) {
			const u8 = readFileSync(join(dir, f));
			await b.put(f, new File([u8], f, { type: f.endsWith(".json") ? "application/json" : "application/octet-stream" }));   // put が gzip＋Content-Encoding を付ける
			n++; bytes += u8.length;
		}
	}
	console.log(`  ↑ ${set.name}: ${n} files ${fmt(bytes)} (pre-gzip)`);
}

let ok = 0, skip = 0, err = 0;
for (const set of targets) {
	try {
		const r = UPLOAD_ONLY ? "ok" : await bakeSet(set);
		if (r === "skip") { skip++; if (!UPLOAD_ONLY) continue; }
		else if (r === "ok") ok++;
		if (UPLOAD && r !== "empty") await uploadSet(set);
	} catch (e) { err++; console.error(`  ✗ ${set.name}:`, e?.message ?? e); }
}
console.log(`\n完了: ok=${ok} skip=${skip} err=${err}`);
process.exit(err ? 1 : 0);
