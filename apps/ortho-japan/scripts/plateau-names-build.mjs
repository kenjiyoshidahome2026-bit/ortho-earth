// PLATEAU の「名前のある建物」を全国分だけ焼く（第1段：採取）。
//   node scripts/plateau-names-build.mjs                 … 未取得の地区を順に焼く（中断・再開可）
//   node scripts/plateau-names-build.mjs --only 千代田区,港区
//   node scripts/plateau-names-build.mjs --limit 10 --conc 16
//   node scripts/plateau-names-build.mjs --stats         … 焼き済みの集計だけ出す
// 出力: plateau-names-out/<地区名>.json（1地区1ファイル＝再開の単位。gitignore 済み）
//
// ⚠Draco を触らない：b3dm の先頭は [header|featureTable|batchTable(JSON+binary)|glb] の順で、欲しい
// 「名前・代表点・箱・高さ」は**すべて batchTable 側**にある（`_x`/`_y`/`_zmin`/`_zmax`/`_xmin.._ymax` は
// batchTableBinary の DOUBLE 列）。だから HTTP Range で先頭だけ落とせば、ジオメトリ本体（大半のバイト）を
// 一切ダウンロードせずに済む。実測：千代田区 463タイル・全部入り160MB に対し Range 100MB・約2分。
// 名前(gml:name)の充足率は 1〜1.5%（千代田 12,558棟中176棟）＝出力は地区あたり数十KB。
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SETS = fileURLToPath(new URL("../public/plateau-sets.json", import.meta.url));
const OUTDIR = fileURLToPath(new URL("../plateau-names-out/", import.meta.url));
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i < 0 ? d : argv[i + 1]; };
const ONLY = (arg("--only", "") || "").split(",").filter(Boolean);
const LIMIT = +arg("--limit", 0) || 0;
const CONC = +arg("--conc", 12) || 12;          // タイル取得の並行数（1地区内）
const STATS_ONLY = argv.includes("--stats");
// 初回 Range 窓。足りない時だけヘッダが告げる実寸で取り直す。窓は「batchTable の JSON＋binary が収まる最小」を狙う
// （実測：千代田・いの町とも batchTableJSON ≈40KB＝64KB窓でほぼ一発。窓を広げるほど無駄な bytes を貰うだけ）。
const HEAD_WINDOW = (+arg("--window", 0) || 64) * 1024;

const td = new TextDecoder();
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchRange(url, n, tries = 3) {
	for (let i = 0; ; i++) {
		try {
			const ac = new AbortController();
			const t = setTimeout(() => ac.abort(), 25000);
			const r = await fetch(url, { headers: { Range: `bytes=0-${n - 1}` }, signal: ac.signal });
			clearTimeout(t);
			if (!r.ok && r.status !== 206) throw new Error("HTTP " + r.status);
			return new Uint8Array(await r.arrayBuffer());
		} catch (e) {
			if (i >= tries - 1) throw e;
			await sleep(400 * (i + 1));
		}
	}
}
const fetchJSON = async (url, tries = 3) => {
	for (let i = 0; ; i++) {
		try { const r = await fetch(url); if (!r.ok) throw new Error("HTTP " + r.status); return await r.json(); }
		catch (e) { if (i >= tries - 1) throw e; await sleep(400 * (i + 1)); }
	}
};

// tileset.json を降りて葉タイル（b3dm）のURLを集める。plateauworker.js collectLeafTiles と同じ規約（外部 json は深さ4まで）。
async function collectLeaves(tilesetUrl, depth = 0) {
	const ts = await fetchJSON(tilesetUrl);
	const base = tilesetUrl.slice(0, tilesetUrl.lastIndexOf("/") + 1);
	const out = [];
	const walk = async t => {
		if (!t) return;
		const ch = t.children || [];
		if (ch.length) { for (const c of ch) await walk(c); return; }
		const uri = t.content?.uri;
		if (!uri) return;
		const abs = new URL(uri, base).href;
		if (abs.endsWith(".json") && depth < 4) out.push(...await collectLeaves(abs, depth + 1));
		else out.push(abs);
	};
	await walk(ts.root);
	return out;
}

// b3dm 1枚 → 名前のある棟だけ [{n,x,y,h,b,u,a,id}]（x,y=代表点 経緯度／b=平面bbox／h=zmax-zmin）
function namedOf(buf) {
	const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	if (dv.getUint32(0, true) !== 0x6d643362) return { need: 0, rows: [] };   // "b3dm"
	const ftJ = dv.getUint32(12, true), ftB = dv.getUint32(16, true), btJ = dv.getUint32(20, true), btB = dv.getUint32(24, true);
	const need = 28 + ftJ + ftB + btJ + btB;
	if (need > buf.length) return { need, rows: [] };   // 窓が足りない＝呼び側が実寸で取り直す
	const bt = JSON.parse(td.decode(buf.subarray(28 + ftJ + ftB, 28 + ftJ + ftB + btJ)));
	const names = bt["gml:name"];
	if (!Array.isArray(names) || !names.some(v => v != null && String(v).trim() !== "")) return { need: 0, rows: [] };
	const n = bt.gml_id?.length || names.length;
	const binOff = 28 + ftJ + ftB + btJ;
	// batchTableBinary の DOUBLE 列（byteOffset は binary 先頭からの相対）。slice でアラインを保証してから読む。
	const col = key => {
		const d = bt[key];
		if (!d || typeof d.byteOffset !== "number" || d.componentType !== "DOUBLE") return null;
		const from = binOff + d.byteOffset;
		if (from + 8 * n > buf.length) return null;
		return new Float64Array(buf.buffer.slice(buf.byteOffset + from, buf.byteOffset + from + 8 * n));
	};
	const X = col("_x"), Y = col("_y"), Z0 = col("_zmin"), Z1 = col("_zmax"),
		X0 = col("_xmin"), X1 = col("_xmax"), Y0 = col("_ymin"), Y1 = col("_ymax");
	const r5 = v => Math.round(v * 1e5) / 1e5;   // 経緯度は1e-5度（≈1m）で丸め＝台帳のサイズを抑える
	const rows = [];
	for (let k = 0; k < n; k++) {
		const raw = names[k];
		if (raw == null) continue;
		const nm = String(raw).trim();
		if (!nm) continue;
		if (!X || !Y || !Number.isFinite(X[k]) || !Number.isFinite(Y[k])) continue;   // 位置なし＝台帳に載せられない
		const rec = { n: nm, x: r5(X[k]), y: r5(Y[k]) };
		if (Z0 && Z1) rec.h = Math.round((Z1[k] - Z0[k]) * 10) / 10;                  // 実形状の高さ（属性の measuredHeight は欠損が多い）
		if (X0 && Y0 && X1 && Y1) rec.b = [r5(X0[k]), r5(Y0[k]), r5(X1[k]), r5(Y1[k])];
		const u = bt["bldg:usage"]?.[k], a = bt["bldg:address"]?.[k], id = bt["uro:BuildingIDAttribute_uro:buildingID"]?.[k];
		if (u) rec.u = String(u);
		if (a) rec.a = String(a);
		if (id) rec.id = String(id);
		rows.push(rec);
	}
	return { need: 0, rows };
}

async function bakeWard(set) {
	const t0 = Date.now();
	const leaves = await collectLeaves(set.base + "tileset.json");
	let i = 0, bytes = 0, fail = 0, refetch = 0;
	const rows = [];
	const worker = async () => {
		while (i < leaves.length) {
			const url = leaves[i++];
			try {
				// 2段Range：まず28Bのヘッダだけ読んで batchTable の実寸を知り、次にその実寸ちょうどを貰う。
				// 「大きめの窓を一発」より確実に軽い（実測・千代田463枚：64KB窓=89MB／192KB窓=110MB／2段=下記の実測値。
				// batchTable JSON は地区・年度で 40KB〜200KB と幅があり、当てにいく窓は必ず外れる）。
				let buf = await fetchRange(url, 28);
				bytes += buf.length;
				const need = namedOf(buf).need;
				if (need) { refetch++; buf = await fetchRange(url, need); bytes += buf.length; }
				rows.push(...namedOf(buf).rows);
			} catch { fail++; }
		}
	};
	await Promise.all(Array.from({ length: Math.min(CONC, leaves.length) }, worker));
	// 同一棟が隣タイルにも入っている分をここで畳む（名前＋代表点1e-5度の一致＝同じ棟）
	const seen = new Set(), uniq = [];
	for (const r of rows) { const k = `${r.n}@${r.x},${r.y}`; if (seen.has(k)) continue; seen.add(k); uniq.push(r); }
	uniq.sort((a, b) => (a.n < b.n ? -1 : a.n > b.n ? 1 : 0));
	return { name: set.name, base: set.base, bbox: set.bbox, tiles: leaves.length, fail, refetch,
		mb: +(bytes / 1e6).toFixed(1), sec: +((Date.now() - t0) / 1000).toFixed(1), named: uniq };
}

// ---- 実行 -------------------------------------------------------------------
const sets = JSON.parse(await readFile(SETS, "utf8"));
await mkdir(OUTDIR, { recursive: true });
const done = new Set((await readdir(OUTDIR).catch(() => [])).filter(f => f.endsWith(".json")).map(f => f.slice(0, -5)));

if (STATS_ONLY) {
	let n = 0, b = 0, t = 0;
	const top = [];
	for (const f of done) {
		const j = JSON.parse(await readFile(path.join(OUTDIR, f + ".json"), "utf8"));
		n += j.named.length; b += j.mb; t += j.tiles;
		top.push([j.name, j.named.length]);
	}
	top.sort((a, b2) => b2[1] - a[1]);
	console.log(`焼き済み ${done.size}/${sets.length} 地区 ・ 名前付き ${n}棟 ・ タイル ${t}枚 ・ 取得 ${(b / 1000).toFixed(1)}GB`);
	console.log("多い地区:", top.slice(0, 12).map(([k, v]) => `${k}:${v}`).join(" "));
	process.exit(0);
}

let targets = sets.filter(s => !ONLY.length || ONLY.includes(s.name));
targets = targets.filter(s => !done.has(s.name));
if (LIMIT) targets = targets.slice(0, LIMIT);
console.log(`対象 ${targets.length} 地区（焼き済み ${done.size} / 全 ${sets.length}）`);

let k = 0;
for (const s of targets) {
	k++;
	try {
		const out = await bakeWard(s);
		await writeFile(path.join(OUTDIR, s.name + ".json"), JSON.stringify(out));
		console.log(`[${k}/${targets.length}] ${s.name.padEnd(10)} タイル${String(out.tiles).padStart(5)} ` +
			`名前付き${String(out.named.length).padStart(4)}棟 ${String(out.mb).padStart(6)}MB ${String(out.sec).padStart(6)}s` +
			(out.fail ? ` 失敗${out.fail}` : ""));
	} catch (e) {
		console.log(`[${k}/${targets.length}] ${s.name.padEnd(10)} 取得できず（${e.message}）＝次回再挑戦`);
	}
}
console.log("完了。集計は --stats");
