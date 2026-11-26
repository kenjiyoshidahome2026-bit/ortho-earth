#!/usr/bin/env node
// 標高の HEALPix タイルを、altpbf の経緯度タイル（R90／R10）から焼く（2026-11-26・規約＝docs/design/healpix.md）。
// 大元は bucket の GIS/alt（R90＝GEBCO 8 枚・R10＝GEBCO＋日本域は DEM10B の 648 枚）＝今の地形と同じ値から作る（本人裁定「大元は R90〜R10 をベースに」）。
// 最も細かい order を大元からバイリニアで標本化し、粗い order は子 4 枚の 2×2 平均（src/elevation/healpixbake.ts）。
//
// 使い方（repo の根から）:
//   node packages/ortho-core/scripts/bake-healpix-elev.mjs --src R90 --order 2 --min-order 0     # 全球の粗い段（252 枚）
//   node packages/ortho-core/scripts/bake-healpix-elev.mjs --src R10 --order 5 --min-order 3     # 細かい段（16,128 枚・R10 を 648 枚読む）
//   … --face 6            # Norder0 の面 6 の下だけ（試し焼き）
//   … --resume            # 出力が在るタイルは読み直して使う（途中で止めた続き）
//   … --tile 512 --ss 1 --out bake-out/hpx/elev --src-dir bake-out/hpx-src
// 目安（タイル幅 512）：1 画素＝58.6°/(512·2^order)。order 2＝0.029°（R90 の 0.033° 相当）・order 5＝0.0036°（R10 の 0.0042° 相当）。
// 出力：bake-out/hpx/elev/Norder{k}/Dir{d}/Npix{n}.altpbf（HiPS の置き場・中身は altpbf＝名前 H{order}P{npix}・Int16・行優先）＋ properties ＋ index.json。
// 大元の取り寄せ：--src-dir に在ればそれ・無ければ https://api.ortho-earth.com/bucket/GIS/alt/<名前> から取って --src-dir に控える（鍵は読まない）。
// 上げるのは uploader のボタンから（R2 へ出す物は uploader から＝本人 2026-09-30）＝ボタンは未作成（置き場が決まってから）。
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { encode, decode, encodeName } from "altpbf";
import { hpxCount, hpxPath } from "../src/healpix.ts";
import { hpxTilePoints, cellsForPoints, bakeHpxTile, hpxParentTile, hpxElevName, gebcoR10Width } from "../src/elevation/healpixbake.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const arg = (name, def) => { const i = process.argv.indexOf("--" + name); return i < 0 ? def : process.argv[i + 1]; };
const flag = name => process.argv.includes("--" + name);
const SRC = arg("src", "R90"), RANGE = SRC === "R90" ? 90 : SRC === "R10" ? 10 : 0;
if (!RANGE) { console.error("--src は R90 か R10"); process.exit(1); }
const MAX = +arg("order", SRC === "R90" ? 2 : 5), MIN = +arg("min-order", SRC === "R90" ? 0 : 3), W = +arg("tile", 512), SS = +arg("ss", 1);
const FACE = arg("face", null), RESUME = flag("resume");
const OUT = path.resolve(ROOT, arg("out", "bake-out/hpx/elev")), SRCDIR = path.resolve(ROOT, arg("src-dir", "bake-out/hpx-src"));
const BASE = arg("base", "https://api.ortho-earth.com/bucket/GIS/alt");
if (!(MIN >= 0 && MAX >= MIN && W >= 2 && (W & (W - 1)) === 0)) { console.error("--order ≥ --min-order ≥ 0・--tile は 2 の冪"); process.exit(1); }
mkdirSync(OUT, { recursive: true }); mkdirSync(SRCDIR, { recursive: true });

// ── 大元のタイル（LRU・今のタイルが触る分は追い出さない）──
const NX = 360 / RANGE, NY = 180 / RANGE, KEEP = RANGE === 90 ? 8 : +arg("keep", 24);
const WOF0 = RANGE === 10 ? gebcoR10Width : null;   // 緯度帯ごとの幅（2400 の時の値）
let WOF = WOF0;
const cells = new Map(), sources = new Set();   // "cx,cy" → タイル（無い＝null）
let cellPx = 0, fetched = 0, missing = 0;
async function loadCell(key) {
	const [cx, cy] = key.split(",").map(Number), name = encodeName(cx * RANGE - 180, cy * RANGE - 90, RANGE), file = path.join(SRCDIR, name);
	let buf;
	if (existsSync(file)) buf = readFileSync(file);
	else {
		const res = await fetch(`${BASE}/${name}`);
		if (res.status === 404) { missing++; console.warn(`  ${name}: 大元に無い（0 m で埋める）`); return null; }
		if (!res.ok) throw new Error(`${name} HTTP ${res.status}`);
		buf = Buffer.from(await res.arrayBuffer()); writeFileSync(file, buf); fetched++;
	}
	if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);
	const t = await decode(new Blob([buf]));
	// 高さは全部同じ（＝間引く前の幅）。幅は R10 だけ緯度帯で違う（GEBCO の R10＝極の帯は 400×2400・uploader の gebco.ts の shrink）
	if (t.range !== RANGE) throw new Error(`${name}: range ${t.range}`);
	if (cellPx && t.height !== cellPx) throw new Error(`${name}: 高さ ${t.height}（他は ${cellPx}）`);
	cellPx = t.height;
	const want = WOF ? WOF(cy) * cellPx / 2400 : cellPx;
	if (t.width !== want) throw new Error(`${name}: 幅 ${t.width}（この緯度帯は ${want} のはず）`);
	if (t.source) sources.add(t.source.replace(/@.*$/, ""));
	return t;
}
async function ensure(keys) {
	for (const k of keys) {
		if (cells.has(k)) { const t = cells.get(k); cells.delete(k); cells.set(k, t); }   // 使った物を末尾へ
		else cells.set(k, await loadCell(k));
	}
	for (const k of cells.keys()) { if (cells.size <= KEEP) break; if (!keys.has(k)) cells.delete(k); }
}
const get = (cx, cy) => (cx < 0 || cx >= NX || cy < 0 || cy >= NY) ? null : cells.get(cx + "," + cy);

// ── 焼く（深さ優先＝NESTED の順は場所が近い＝LRU が効く・持つのは枝 1 本ぶん）──
const written = [];
let leafDone = 0;
const leafTotal = (FACE === null ? 12 : 1) * 4 ** MAX, t0 = Date.now();
async function bake(k, n) {
	const rel = hpxPath(k, n, "altpbf"), file = path.join(OUT, rel);
	let data;
	if (RESUME && existsSync(file)) {
		data = (await decode(new Blob([readFileSync(file)]))).data;
		if (data.length !== W * W) throw new Error(`${rel}: 幅が --tile ${W} と違う`);
		if (k === MAX) leafDone++; else leafDone += 4 ** (MAX - k);
	} else {
		if (k === MAX) {
			if (!cellPx) await ensure(new Set([`0,${NY / 2}`]));   // 高さ（＝間引く前の幅）を知る
			const wOf = WOF0 && (cy => WOF0(cy) * cellPx / 2400);
			await ensure(cellsForPoints(hpxTilePoints(k, n, W, SS), RANGE, cellPx, cellPx, wOf));
			data = bakeHpxTile(get, RANGE, cellPx, k, n, W, SS, cellPx, wOf);
			if (++leafDone % 64 === 0 || leafDone === leafTotal) console.log(`  ${leafDone}/${leafTotal} 枚（${((Date.now() - t0) / 1000).toFixed(0)} 秒）`);
		} else {
			const ch = []; for (let i = 0; i < 4; i++) ch.push(await bake(k + 1, n * 4 + i));
			data = hpxParentTile(ch, W);
		}
		if (k >= MIN) {
			mkdirSync(path.dirname(file), { recursive: true });
			writeFileSync(file, await encode({ name: hpxElevName(k, n), source: `HEALPix ${W}px from ${SRC}`, lng: 0, lat: 0, range: 0, width: W, height: W, data }));
		}
	}
	if (k >= MIN) written.push(rel);
	return data;
}
console.log(`[hpx-elev] ${SRC} → Norder ${MIN}..${MAX}・タイル ${W}px・副標本 ${SS}${FACE === null ? "" : `・面 ${FACE}`} → ${path.relative(ROOT, OUT)}`);
const per = 4 ** MIN;
for (let n = 0; n < hpxCount(MIN); n++) { if (FACE !== null && Math.floor(n / per) !== +FACE) continue; await bake(MIN, n); }

// ── 目録（HiPS の properties と、uploader が読む index.json）＝全面を焼いた時だけ書く（面 1 つの試し焼きで目録を潰さない）──
if (FACE === null) {
	const idxFile = path.join(OUT, "index.json");
	const prev = existsSync(idxFile) ? JSON.parse(readFileSync(idxFile, "utf8")) : [];
	const all = [...new Set([...prev, ...written])].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
	writeFileSync(idxFile, JSON.stringify(all) + "\n");
	const orders = all.map(p => +/^Norder(\d+)/.exec(p)[1]);
	writeFileSync(path.join(OUT, "properties"), [
		"obs_title = Ortho Earth elevation (HEALPix)",
		"dataproduct_type = image", "hips_version = 1.4", "hips_frame = planet", "hips_body = earth",
		`hips_order = ${Math.max(...orders)}`, `hips_order_min = ${Math.min(...orders)}`, `hips_tile_width = ${W}`,
		"hips_tile_format = altpbf",
		"# tile = altpbf (Int16 metres, row-major). col = face x (ix), row = face y (iy); see docs/design/healpix.md",
		"# Norder 0-2 from R90, Norder 3-5 from R10 (bucket GIS/alt)", ""].join("\n"));
}
console.log(`[hpx-elev] ${written.length} 枚・大元の取り寄せ ${fetched} 枚・無いセル ${missing}・出所 ${[...sources].join(" + ") || "?"}・${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
