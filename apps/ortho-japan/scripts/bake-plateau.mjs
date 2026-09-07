#!/usr/bin/env node
// PLATEAU 焼き（2026-09-07）＝カタログ（public/plateau-sets.json）の全セットをブラウザと同じデコード経路
// （plateaudecode.decodeBatch＝fetch→Draco→座標変換→dedup→接地→LOD→RTE→マスク断片）で Node 上で煮て、
// GPU 直行形式の量子化版（plateauq.js PLQ1）に落とす。置き先＝R2（native-bucket）GIS/plateau/v{DECODE_VER}/{slug}/。
// ブラウザ（plateauworker）はこの焼きを「第三の入口」として MLIT 生経路の前に引く＝Draco もデコード過渡メモリも無し。
// 無い/古い/壊れ＝生経路へ静かに落ちる（タイル粒度）。
//
//   node scripts/bake-plateau.mjs [--only=名前や base の部分文字列] [--out=DIR] [--batch=32] [--shard=i/n]
//                                 [--force] [--redo-unbaked] [--reverse] [--repack] [--stats] [--limit=N] [--sphere-only|--ell-only] [--upload] [--upload-only]
//   --out       既定 plateau-bake-out/（gitignore 済）。セットごとに {slug}/manifest.json + b{k}.plq（球）と {slug}/ell/…（楕円体）
//   --shard=i/n カタログを n 分割して i 番目だけ（Threadripper で並列に走らせる用。実測は回線律速＝hpc で計 10MB/s）
//   再実行は完了済み（manifest あり）をスキップ＝走査失敗（✗）のセットだけ拾い直す。--redo-unbaked＝unbaked（取れなかった
//   タイル）を持つセットも焼き直し対象にする（回線が空いた後の仕上げ用）
//   --upload    焼いたセットを直後に R2 へ put（要 API_KEY 環境変数＝native-bucket の書込キー）。--upload-only＝焼かず既存出力を押す
//   球（既定 ?ell 無し）と楕円体（?ell=1）は座標が違う＝別焼き。同じバッチの b3dm はプロセス内キャッシュで 1 回しか取らない。
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setLoaderOptions } from "@loaders.gl/core";
import draco3d from "draco3d";
import { decodeBatch, setDecodeEnv, collectLeafTiles, DECODE_VER } from "../plateaudecode.js";
import { packPLQ, unpackPLQ, headPLQ, bakeDir, PLQ_VER } from "../plateauq.js";

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
const arg = (k, d = null) => { const a = process.argv.find(s => s.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : (process.argv.includes(`--${k}`) ? true : d); };
const ONLY = arg("only"), OUT = arg("out", join(APP, "plateau-bake-out")), BATCH = +arg("batch", 32) || 32;
const FORCE = !!arg("force"), REDO_UNBAKED = !!arg("redo-unbaked"), REVERSE = !!arg("reverse"), REPACK = !!arg("repack") || !!arg("reweld"), STATS = !!arg("stats"), LIMIT = +arg("limit", 0), UPLOAD = !!arg("upload") || !!arg("upload-only"), UPLOAD_ONLY = !!arg("upload-only");
const MODES = arg("sphere-only") ? [false] : arg("ell-only") ? [true] : [false, true];
const [SHARD_I, SHARD_N] = String(arg("shard", "0/1")).split("/").map(Number);
const API = process.env.API_BASE ?? "https://api.ortho-earth.com";
const API_KEY = process.env.API_KEY;
if (UPLOAD && !API_KEY) { console.error("--upload には API_KEY 環境変数（native-bucket の書込キー）が要ります"); process.exit(2); }

// Draco＝draco3d（npm）を loaders.gl に注入（Node は CDN/ローカル lib の自動解決が効かない＝これが唯一の道）
setLoaderOptions({ modules: { draco3d } });
setDecodeEnv({ tileConcurrency: 8 });

// b3dm はバッチ単位で「先に全部取ってから」デコードする（プロセス内キャッシュ・バッチ完了で捨てる）：
// ①球/楕円体の 2 回目デコードで取り直さない ②取れなかったタイルは両モードから同じように外して unbaked に記す
//（decodeBatch は失敗タイルを黙って落として残りで煮る＝焼きに任せると「欠けたまま完成」になり、クライアントはそれを
//   正として二度と取りに行かない。ブラウザの一過性 skip とは重みが違う）。再試行 4 回・600s＝CDN（reearth）の
//   遅延/瞬断（hpc 実測: "fetch failed"/abort が数%）を吸う。
const bodyCache = new Map();
const rawFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
	const key = typeof url === "string" ? url : url?.url;
	if (key && bodyCache.has(key)) return new Response(bodyCache.get(key).slice(0), { status: 200 });
	return rawFetch(url, init);
};
async function prefetchTiles(uris) {   // 成功した URI を cache に積み、失敗した URI の Set を返す
	const failed = new Set();
	let i = 0;
	await Promise.all(Array.from({ length: 8 }, async () => {
		while (i < uris.length) {
			const u = uris[i++];
			let ok = false;
			for (let a = 0; a < 4 && !ok; a++) {
				const ac = new AbortController(), tm = setTimeout(() => ac.abort(), 600000);   // 600s＝回線を分け合う並列走行でテクスチャ付きセットの 2〜4MB タイルが 180s を越えた実測（hpc・curl 単独なら 5〜17s）
				try { const r = await rawFetch(u, { signal: ac.signal }); if (r.ok) { bodyCache.set(u, await r.arrayBuffer()); ok = true; } else if (r.status === 404 || r.status === 403) break; }
				catch { /* 再試行 */ }
				finally { clearTimeout(tm); }
				if (!ok) await new Promise(r => setTimeout(r, 1000 * (a + 1)));
			}
			if (!ok) failed.add(u);
		}
	}));
	return failed;
}

const sets = JSON.parse(readFileSync(join(APP, "public/plateau-sets.json"), "utf8"));
let targets = sets.filter((s, i) => i % SHARD_N === SHARD_I);
if (ONLY) targets = targets.filter(s => s.name.includes(ONLY) || s.base.includes(ONLY));
if (REVERSE) targets.reverse();   // 別マシンと両端から挟む用（完了済みは manifest でスキップ＝出会った所で自然に終わる）
if (LIMIT) targets = targets.slice(0, LIMIT);
console.log(`対象 ${targets.length} セット（shard ${SHARD_I}/${SHARD_N}${ONLY ? `・only=${ONLY}` : ""}）→ ${OUT}${UPLOAD ? " → R2" : ""}`);

const fmt = n => (n / 1e6).toFixed(1) + "MB";
const commonPrefix = arr => { if (!arr.length) return ""; let p = arr[0]; for (const s of arr) { while (!s.startsWith(p)) p = p.slice(0, -1); } return p.slice(0, p.lastIndexOf("/") + 1); };

async function bakeSet(set) {
	const base = set.base, brid = !!set.noMask, wardBbox = brid ? null : set.bbox;
	const dirs = MODES.map(ell => join(OUT, bakeDir(base, DECODE_VER, ell)));
	if (!FORCE && dirs.every(d => existsSync(join(d, "manifest.json")))) {
		const holes = REDO_UNBAKED && dirs.some(d => { try { return JSON.parse(readFileSync(join(d, "manifest.json"), "utf8")).unbaked?.length > 0; } catch { return true; } });
		if (!holes) return "skip";
	}
	const t0 = performance.now();
	let leaves = null;   // 走査（tileset の直列往復）は回線飽和時に "fetch failed" で丸ごと落ちる（hpc 実測 24 件/バースト）＝3 回まで待って再試行
	for (let a = 0; a < 3 && !leaves; a++) {
		try { leaves = await collectLeafTiles(base + "tileset.json"); }
		catch (e) { if (a === 2) throw e; console.warn(`  ${set.name}: 走査失敗（${e?.message ?? e}）→ ${15 * (a + 1)}s 後に再試行`); await new Promise(r => setTimeout(r, 15000 * (a + 1))); }
	}
	if (!leaves.length) { console.warn(`  ${set.name}: 葉 0 枚＝空（廃止区の残骸？）`); return "empty"; }
	// 区中心からの距離順＝ブラウザの「近いバッチから」に対応する固定の並び（クライアントはバッチ bbox でさらにカメラ順に並べ替える）
	const cx = (set.bbox[0] + set.bbox[2]) / 2, cy = (set.bbox[1] + set.bbox[3]) / 2;
	const d2 = t => t.center ? (t.center[0] - cx) ** 2 + (t.center[1] - cy) ** 2 : Infinity;
	leaves.sort((a, b) => d2(a) - d2(b));
	const prefix = commonPrefix(leaves.map(t => t.uri));
	const tiles = leaves.map(t => t.uri.slice(prefix.length));
	const man = MODES.map(ell => ({ ver: DECODE_VER, plq: PLQ_VER, base, ward: set.name, brid, ell, wardBbox, prefix, tiles, batch: BATCH, batches: [], unbaked: [], pack: PACK_GEN, ts: 0 }));
	for (const d of dirs) mkdirSync(d, { recursive: true });
	let bytesRaw = 0, bytesPlq = 0, k = 0;
	let failedTiles = 0;
	for (let i = 0; i < leaves.length; i += BATCH) {
		const all = leaves.slice(i, i + BATCH);
		const failed = await prefetchTiles(all.map(t => t.uri));
		const slice = all.filter(t => !failed.has(t.uri)), ti = [];
		all.forEach((t, j) => { if (failed.has(t.uri)) { for (const mm of man) mm.unbaked.push(i + j); failedTiles++; } else ti.push(i + j); });
		if (!slice.length) { bodyCache.clear(); k++; continue; }
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
	console.log(`  ${set.name}: ${leaves.length} 枚 ${k} バッチ ×${MODES.length} raw ${fmt(bytesRaw)} → plq ${fmt(bytesPlq)} (${(bytesPlq / bytesRaw * 100).toFixed(0)}%) ${dt.toFixed(0)}s${man.some(x => x.unbaked.length) ? ` ⚠unbaked ${man.map(x => x.unbaked.length).join("/")} (fetch失敗 ${failedTiles})` : ""}`);
	return "ok";
}

// アップロード＝bucket Worker の put プロトコルを直接叩く（X-Action: put・X-API-Key・gzip 済み本体に X-Content-Encoding）。
// native-bucket の Bucket.put と同じ結果になるが、workspace 依存（geopbf 等）を持たない＝焼いた場所（hpc の最小バンドル）から
// そのまま押せる。ファイルは 50MB 未満（PLQ バッチ最大 ~25MB・gzip 後 ~10MB）＝単発 POST で足りる。
const gz = (await import("node:zlib")).gzipSync;
async function putObject(key, body, type) {
	const url = `${API}/bucket/${key}`;
	const gzBody = gz(body, { level: 6 });
	for (let a = 0; a < 3; a++) {
		try {
			const r = await fetch(url, { method: "POST", headers: { "X-Action": "put", "X-API-Key": API_KEY, "X-Metadata-Type": type, "X-Content-Encoding": "gzip" }, body: gzBody });
			if (r.ok) return gzBody.length;
			if (r.status === 401) throw new Error("401 Unauthorized（API_KEY が違う）");
			console.warn(`  put ${key}: HTTP ${r.status}（再試行 ${a + 1}）`);
		} catch (e) { if (/401/.test(e.message)) throw e; console.warn(`  put ${key}: ${e.message}（再試行 ${a + 1}）`); }
		await new Promise(r => setTimeout(r, 2000 * (a + 1)));
	}
	throw new Error(`put failed: ${key}`);
}
async function uploadSet(set) {
	let n = 0, bytes = 0, gzBytes = 0;
	for (const ell of MODES) {
		const rel = bakeDir(set.base, DECODE_VER, ell), dir = join(OUT, rel);
		if (!existsSync(join(dir, "manifest.json"))) continue;
		const files = readdirSync(dir).filter(f => f.endsWith(".plq"));
		files.push("manifest.json");   // 最後＝マニフェストが見えた時には本体が揃っている（クライアントの 404 → 生経路の判定に矛盾を作らない）
		for (const f of files) {
			const u8 = readFileSync(join(dir, f));
			gzBytes += await putObject("GIS/plateau/" + rel + f, u8, f.endsWith(".json") ? "application/json" : "application/octet-stream");
			n++; bytes += u8.length;
		}
	}
	console.log(`  ↑ ${set.name}: ${n} files ${fmt(bytes)} → gzip ${fmt(gzBytes)}`);
}

// --repack＝焼き済み出力の詰め直し（再デコード無し）：旧形式（PLQ1／溶接前／角柱前）を unpack→pack（溶接＋角柱抽出）→上書き。
// manifest.plq===PLQ_VER かつ pack 印で冪等（済みはスキップ）。バイト数も更新。統計（角柱本数・三角形の内訳）を集計に載せる。
// --stats＝書き換えず統計だけ（ヘッダ読み＝速い。PLQ2 済みのセットのみ有効）
const PACK_GEN = 3;   // 詰め直しの世代（抽出器の改良で上げる＝manifest.pack と突合して再詰め直し。形式版 PLQ_VER とは別）: 3=壁ループ段
const agg = { sets: 0, batches: 0, prisms: 0, prismTris: 0, meshTris: 0, before: 0, after: 0, rows: [] };
function repackSet(set) {
	let n = 0, before = 0, after = 0, prisms = 0, prismTris = 0, meshTris = 0;
	for (const ell of MODES) {
		const dir = join(OUT, bakeDir(set.base, DECODE_VER, ell)), mf = join(dir, "manifest.json");
		if (!existsSync(mf)) continue;
		const m = JSON.parse(readFileSync(mf, "utf8"));
		if (STATS) {
			if (ell) continue;   // 統計は球だけ（楕円体は同じ建物）
			for (const bt of m.batches) { const h = headPLQ(new Uint8Array(readFileSync(join(dir, bt.f)))); if (!h) continue; prisms += h.prisms?.n || 0; meshTris += h.nt || 0; prismTris += bt.tris - (h.nt || 0); n++; after += bt.bytes; }
			continue;
		}
		if (m.plq === PLQ_VER && m.pack === PACK_GEN) continue;
		for (const bt of m.batches) {
			const f = join(dir, bt.f), u8 = readFileSync(f), mesh = unpackPLQ(new Uint8Array(u8));
			if (!mesh) { console.warn(`  ${set.name}: ${bt.f} unreadable（skip）`); continue; }
			const st = {}, out = packPLQ(mesh, { stats: st });
			writeFileSync(f, out); before += u8.length; after += out.length; bt.bytes = out.length; bt.tris = st.prismTris + st.meshTris; n++;   // tris＝復元後の三角形数（角柱化で底が落ちる分を反映）
			if (!ell) { prisms += st.prisms; prismTris += st.prismTris; meshTris += st.meshTris; }
		}
		m.plq = PLQ_VER; m.pack = PACK_GEN; delete m.weld; writeFileSync(mf, JSON.stringify(m));
	}
	if (!n) return "skip";
	const tot = prismTris + meshTris;
	agg.sets++; agg.batches += n; agg.prisms += prisms; agg.prismTris += prismTris; agg.meshTris += meshTris; agg.before += before; agg.after += after;
	agg.rows.push({ ward: set.name, brid: !!set.noMask, prisms, prismTris, meshTris, boxShare: tot ? prismTris / tot : 0, bytes: after });
	console.log(`  ${STATS ? "≡" : "⟳"} ${set.name}: ${n} batches${STATS ? "" : ` ${fmt(before)} → ${fmt(after)} (${(after / before * 100).toFixed(0)}%)`} 角柱 ${prisms} 棟＝三角形 ${tot ? (prismTris / tot * 100).toFixed(0) : 0}%`);
	return "ok";
}

let ok = 0, skip = 0, err = 0;
for (const set of targets) {
	try {
		const r = (REPACK || STATS) ? repackSet(set) : UPLOAD_ONLY ? "ok" : await bakeSet(set);
		if (r === "skip") { skip++; if (!UPLOAD_ONLY) continue; }
		else if (r === "ok") ok++;
		if (UPLOAD && r !== "empty") await uploadSet(set);
	} catch (e) { err++; console.error(`  ✗ ${set.name}:`, e?.message ?? e); }
}
if (agg.sets) {
	const tot = agg.prismTris + agg.meshTris;
	console.log(`\n統計: ${agg.sets} セット ${agg.batches} バッチ 角柱 ${agg.prisms.toLocaleString()} 棟＝三角形の ${(agg.prismTris / tot * 100).toFixed(1)}%（角柱 ${agg.prismTris.toLocaleString()} / メッシュ ${agg.meshTris.toLocaleString()}）${agg.before ? ` サイズ ${fmt(agg.before)} → ${fmt(agg.after)} (${(agg.after / agg.before * 100).toFixed(0)}%)` : ""}`);
	const bld = agg.rows.filter(r => !r.brid).sort((a, b) => a.boxShare - b.boxShare);
	if (bld.length) {
		const bins = [0, 0.5, 0.9, 0.99, 1.01].map((lo, i, arr) => i < arr.length - 1 ? [lo, arr[i + 1]] : null).filter(Boolean);
		console.log("  建物セットの角柱率（三角形ベース）分布: " + bins.map(([lo, hi]) => `${(lo * 100).toFixed(0)}〜${Math.min(100, hi * 100).toFixed(0)}%: ${bld.filter(r => r.boxShare >= lo && r.boxShare < hi).length}`).join(" / "));
		console.log("  角柱率が低い（屋根形状あり）順: " + bld.slice(0, 8).map(r => `${r.ward} ${(r.boxShare * 100).toFixed(0)}%`).join("・"));
	}
	writeFileSync(join(OUT, "stats.json"), JSON.stringify({ ts: Date.now(), ...agg }, null, 1));
	console.log(`  → ${join(OUT, "stats.json")}`);
}
console.log(`\n完了: ok=${ok} skip=${skip} err=${err}`);
process.exit(err ? 1 : 0);
