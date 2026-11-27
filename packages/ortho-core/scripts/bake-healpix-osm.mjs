#!/usr/bin/env node
// OpenStreetMap の生データ（PBF）を、HEALPix のベクタタイル（MVT の器・座標は面ごとの x, y＝docs/design/healpix.md §5）に焼く（2026-11-27・日本域の試し焼き）。
// 本人裁定（2026-11-27）「OSM の生データ＋日本域で行きましょう」。PBF の読み方は歩ける道の網（packages/citytwin/scripts/bake-walk-japan.mjs）と同じ＝GDAL の ogr2ogr で 1 度読む。
//
// 使い方（repo の根から・手元の Mac で＝brew install gdal）:
//   node packages/ortho-core/scripts/bake-healpix-osm.mjs                      # 日本の PBF（無ければ Geofabrik から約 2.3 GB）→ Norder 4..12
//   node packages/ortho-core/scripts/bake-healpix-osm.mjs --pbf=<file.osm.pbf>  # 手元の PBF（県・地方の PBF＝試し焼き）
//   node packages/ortho-core/scripts/bake-healpix-osm.mjs --box=139.5,35.5,140,35.9   # 範囲だけ
//   … --order=12 --min-order=4 --extent=4096 --out=bake-out/hpx/osm --jobs=<働き手の数>
//   … --lines=<a.geojsonl> --polys=<b.geojsonl>   # ogr2ogr の代わりに GeoJSONSeq を直に読む（検定用）
// 層（Protomaps の層名と kind に寄せる＝今の style が効きやすい）と、出し始める段（Norder k ≒ メルカトルの z k+2.6）:
//   roads     … 道（kind＝highway／major_road／minor_road／path・kind_detail＝highway の値）と鉄道（kind＝rail）
//   water     … 水面（多角形・kind＝water）と水路（線・kind＝river／canal／stream）
//   buildings … 建物（多角形・最も細かい段だけ＝既定 Norder 12。11 だと都心の 1 枚が約 710 KB・2 万 4 千棟＝重すぎた＝2026-11-27 の試し焼き）
// 海岸線（陸の多角形）は PBF からは出ない（osmcoastline の仕事）＝入れていない。地名・施設の点もまだ。
// 間引き：最も細かい段は丸めるだけ。粗い段は Douglas–Peucker（1.5 刻み）と小さい多角形の切り捨て。タイルの縁の点は動かさない。
// 線のまとめ：タイルごと・層ごとに、属性が同じ線を 1 つの地物にまとめ、端点が 2 本だけ出会う所でつなぐ（`hpxMergeLines`）。粗い段はつないだ後にもう 1 度間引き、縁に触れない短い線（4 刻み未満）を捨てる。
//   （東京の試し焼きで Norder 7・8 の 1 枚が約 600 KB＝細かい段より重かった＝短い way が 1 本ずつ別の地物だったため・2026-11-27）
// 並列（2026-11-27・本人「可能ならば並列化しませんか？」）：読む口（ogr2ogr）は線と面を同時に走らせ、切る・間引く・タイルへ詰めるのは働き手（worker_threads・既定＝コア数−1・--jobs=N）へ配る。
//   働き手ごとに別の仮のファイルへ書く＝取り合いは無い。タイルの中の地物と部品は並べ直す＝働き手の数によらず同じタイルになる。
// 出力：bake-out/hpx/osm/Norder{k}/Dir{d}/Npix{n}.mvt ＋ index.json { made, source, layers, minOrder, maxOrder, extent, tiles, bytes }。上げるのは uploader のボタン。
// 許諾：© OpenStreetMap contributors（ODbL）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { hpxPath, cellOf, nestOf } from "../src/healpix.ts";
import { hpxSplitFaces, hpxSliceFace, hpxSimplify, hpxMergeLines, encodeHpxVt } from "../src/healpixvt.ts";

const SELF = fileURLToPath(import.meta.url), ROOT = path.join(path.dirname(SELF), "../../..");
const opt = (k, d) => process.argv.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const MAX = +opt("order", 12), MIN = +opt("min-order", 4), EXT = +opt("extent", 4096);
const OUT = path.resolve(ROOT, opt("out", "bake-out/hpx/osm")), TMP = OUT + "-tmp", OSM = path.join(ROOT, "bake-out/osm");
const BOX = opt("box")?.split(",").map(Number), LINES = opt("lines"), POLYS = opt("polys");
const JOBS = Math.max(1, +opt("jobs", Math.max(1, Math.min(12, os.availableParallelism() - 1))));
const GEOFABRIK = "https://download.geofabrik.de/asia/japan-latest.osm.pbf";
const LAYERS = ["water", "roads", "buildings"];
if (!(MAX >= MIN && MIN >= 0 && MAX <= 14)) { console.error("--order ≥ --min-order ≥ 0・--order ≤ 14"); process.exit(1); }

// ── 層分け：タグ → { layer, type, min（出し始める段）, props }。null＝採らない ──
const ROAD = { motorway: ["highway", 4], motorway_link: ["highway", 7], trunk: ["highway", 4], trunk_link: ["highway", 7], primary: ["major_road", 6], primary_link: ["major_road", 8], secondary: ["major_road", 7], secondary_link: ["major_road", 9],
	tertiary: ["major_road", 8], tertiary_link: ["major_road", 10], unclassified: ["minor_road", 10], residential: ["minor_road", 10], living_street: ["minor_road", 10], road: ["minor_road", 10], service: ["minor_road", 11], pedestrian: ["minor_road", 11], track: ["path", 11],
	path: ["path", 11], footway: ["path", 11], cycleway: ["path", 11], steps: ["path", 11], bridleway: ["path", 11] };
const RAIL = { rail: 6, subway: 9, light_rail: 9, monorail: 9, tram: 10, narrow_gauge: 9, funicular: 10 };
const WATERWAY = { river: 7, canal: 9, stream: 11, ditch: 11, drain: 11 };
function classifyLine(t) {
	if (t.highway && ROAD[t.highway]) { const [kind, min] = ROAD[t.highway], p = { kind, kind_detail: t.highway }; if (t.name) p.name = t.name; if (t.ref) p.ref = t.ref; if (t.tunnel && t.tunnel !== "no") p.is_tunnel = true; if (t.bridge && t.bridge !== "no") p.is_bridge = true; return { layer: "roads", min, props: p, nameFrom: 9 }; }
	if (t.railway && RAIL[t.railway] !== undefined) { const p = { kind: "rail", kind_detail: t.railway }; /* 側線・車庫の線（service＝yard／siding／spur…）は Norder 10 から */ if (t.name) p.name = t.name; if (t.tunnel && t.tunnel !== "no") p.is_tunnel = true; return { layer: "roads", min: t.service ? Math.max(RAIL[t.railway], 10) : RAIL[t.railway], props: p, nameFrom: 10 }; }
	if (t.waterway && WATERWAY[t.waterway] !== undefined) { const p = { kind: t.waterway === "river" ? "river" : t.waterway === "canal" ? "canal" : "stream" }; if (t.name) p.name = t.name; return { layer: "water", min: WATERWAY[t.waterway], props: p, nameFrom: 9 }; }
	return null;
}
function classifyPoly(t) {
	if (t.natural === "water" || t.waterway === "riverbank" || t.landuse === "reservoir" || t.landuse === "basin") { const p = { kind: "water" }; if (t.water) p.kind_detail = t.water; if (t.name) p.name = t.name; return { layer: "water", min: 5, props: p, nameFrom: 9 }; }
	if (t.building && t.building !== "no") return { layer: "buildings", min: MAX, props: {}, nameFrom: 99 };
	return null;
}

// ═══ 働き手：行（GeoJSONSeq）を受けて切る → 自分の仮のファイルへ。束を受けてタイルへ詰める ═══
// 仮の束：タイルの行（"order/npix \t 層 \t 種別 \t 属性 \t 座標"）を、祖先の束ごとのファイルへ（粗い段＝top・Norder 6〜7＝Norder 6 の祖先・それより細かい段＝Norder 8 の祖先）。開いたままの口は持たない。
function worker() {
	const ID = workerData.id, buf = new Map(), CODE = { point: "n", line: "l", polygon: "a" }, TYPE = { n: "point", l: "line", a: "polygon" }; let buffered = 0, pieces = 0;
	const flush = () => { for (const [k, a] of buf) fs.appendFileSync(path.join(TMP, `${k}.w${ID}.tsv`), a.join("")); buf.clear(); buffered = 0; };
	const anc = (t, lv) => { const c = cellOf(t.order, t.npix); return nestOf(lv, c.face, c.ix >> (t.order - lv), c.iy >> (t.order - lv)); };
	function put(t, layer, props) {
		const key = t.order < 6 ? "top" : t.order < 8 ? `a${anc(t, 6)}` : `b${anc(t, 8)}`;
		const line = `${t.order}/${t.npix}\t${layer}\t${CODE[t.type]}\t${JSON.stringify(props)}\t${t.parts.map(p => p.map(q => q[0] + " " + q[1]).join(" ")).join(";")}\n`;
		(buf.get(key) ?? buf.set(key, []).get(key)).push(line); buffered += line.length;
		if (buffered > 24e6) flush();
	}
	function emit(geom, cls) {
		const faces = hpxSplitFaces(geom, 1 / (2 ** MAX * EXT * 4));
		for (let k = Math.max(MIN, cls.min); k <= MAX; k++) {
			let props = cls.props;
			if (k < cls.nameFrom && (props.name || props.ref)) { props = { ...props }; delete props.name; delete props.ref; }   // 粗い段は名前を持たない（大きさの節約）
			for (const f of faces) for (const t0 of hpxSliceFace(f, k, EXT)) {
				const t = k < MAX ? hpxSimplify(t0, 1.5, 8, EXT) : t0;
				if (t) { put(t, cls.layer, props); pieces++; }
			}
		}
	}
	const signed = r => { let a = 0; for (let i = 0; i < r.length - 1; i++) a += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1]; return a; };
	const orient = (r, outer) => (signed(r) > 0) === outer ? r : [...r].reverse();
	const tags = hs => { const t = {}; for (const m of (hs || "").matchAll(/"((?:[^"\\]|\\.)*)"=>"((?:[^"\\]|\\.)*)"/g)) t[m[1]] = m[2]; return t; };
	function cut(kind, rows) {   // kind＝"lines"｜"multipolygons"。返り＝採った件数
		let used = 0;
		for (const s of rows) {
			const i = s.indexOf("{"); if (i < 0) continue;
			const f = JSON.parse(s.slice(i)), p = f.properties || {}, t = { ...tags(p.other_tags) }, g = f.geometry;
			for (const [k, v] of Object.entries(p)) if (v !== null && k !== "other_tags" && k !== "osm_id") t[k] = String(v);
			if (!g) continue;
			if (kind === "lines") {
				const cls = classifyLine(t); if (!cls) continue;
				const coords = g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : null; if (!coords) continue;
				used++; emit({ type: "line", coords }, cls);
			} else {
				const cls = classifyPoly(t); if (!cls) continue;
				const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : null; if (!polys) continue;
				used++; emit({ type: "polygon", coords: polys.flatMap(rings => rings.map((r, j) => orient(r, j === 0))) }, cls);   // 外周＝反時計回り（正の面積）・穴＝時計回りにそろえる（y が上向きの約束）
			}
		}
		return used;
	}
	function pack(files) {   // 1 つの束（働き手ごとのファイルの組）→ タイル。返り＝[相対パス, 大きさ] の列
		const by = new Map(), made = [];
		for (const file of files) for (const l of fs.readFileSync(path.join(TMP, file), "utf8").split("\n")) {
			if (!l) continue;
			const [key, layer, ty, props, co] = l.split("\t");
			const parts = co.split(";").map(s => { const v = s.split(" ").map(Number), p = []; for (let i = 0; i < v.length; i += 2) p.push([v[i], v[i + 1]]); return p; });
			const tl = by.get(key) ?? by.set(key, new Map()).get(key);
			const fs_ = tl.get(layer) ?? tl.set(layer, { list: [], lines: new Map() }).get(layer);
			if (ty === "l") { const g = fs_.lines.get(props); if (g) g.push(...parts); else fs_.lines.set(props, parts); }   // 線は属性ごとに束ねる
			else fs_.list.push({ type: TYPE[ty], parts, props: JSON.parse(props) });
		}
		const ord = (a, b) => { const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) { const d = a[i][0] - b[i][0] || a[i][1] - b[i][1]; if (d) return d; } return a.length - b.length; };   // 部品の並びを決める（働き手の数・届く順によらず同じタイルになるように）＝座標の辞書順（近い物が隣に来る＝差分が小さい）
		for (const [key, tl] of by) {
			const [k, n] = key.split("/").map(Number), rel = hpxPath(k, n, "mvt"), out = path.join(OUT, rel);
			for (const fs_ of tl.values()) for (const [props, raw] of [...fs_.lines].sort((a, b) => a[0] < b[0] ? -1 : 1)) {
				let parts = hpxMergeLines(raw.sort(ord), EXT, k < MAX ? 4 : 0);
				if (k < MAX) parts = hpxSimplify({ order: k, npix: n, type: "line", parts }, 1.5, 0, EXT)?.parts ?? [];
				if (parts.length) fs_.list.push({ type: "line", parts: parts.sort(ord), props: JSON.parse(props), key: props });
			}
			for (const fs_ of tl.values()) { for (const f of fs_.list) f.key ??= JSON.stringify(f.props); fs_.list.sort((a, b) => a.type < b.type ? -1 : a.type > b.type ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : ord(a.parts[0], b.parts[0]) || a.parts.length - b.parts.length); }
			const b = encodeHpxVt(LAYERS.filter(L => tl.get(L)?.list.length).map(L => ({ name: L, extent: EXT, features: tl.get(L).list })));
			if (!b.length) continue;
			fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, b); made.push([rel, b.length]);
		}
		return made;
	}
	parentPort.on("message", m => {
		if (m.rows) { const p0 = pieces, used = cut(m.kind, m.rows); parentPort.postMessage({ cut: 1, seen: m.rows.length, used, pieces: pieces - p0 }); }
		else if (m.flush) { flush(); parentPort.postMessage({ flushed: 1 }); }
		else if (m.files) parentPort.postMessage({ packed: pack(m.files) });
	});
}

// ═══ 親：読む口を回して行を配る → 束を配って詰めさせる → 目次 ═══
async function main() {
	const t0 = Date.now(); let pbf = opt("pbf"), source = "OpenStreetMap";
	if (!LINES && !POLYS) {
		if (!pbf) {
			pbf = path.join(OSM, "japan-latest.osm.pbf");
			if (!fs.existsSync(pbf)) { fs.mkdirSync(OSM, { recursive: true }); console.log(`PBF を取る：${GEOFABRIK}`); execFileSync("curl", ["-fL", "--retry", "5", "-o", pbf + ".part", GEOFABRIK], { stdio: "inherit" }); fs.renameSync(pbf + ".part", pbf); }
		}
		try { execFileSync("ogr2ogr", ["--version"], { stdio: "ignore" }); } catch { console.error("ogr2ogr が無い＝brew install gdal"); process.exit(1); }
		source = `OpenStreetMap（${path.basename(pbf)}）`;
	}
	fs.rmSync(TMP, { recursive: true, force: true }); fs.mkdirSync(TMP, { recursive: true });
	console.log(`[hpx-osm] Norder ${MIN}..${MAX}・刻み ${EXT}${BOX ? `・範囲 ${BOX.join(",")}` : ""}・働き手 ${JOBS} → ${path.relative(ROOT, OUT)}`);

	// 働き手の群れ：仕事（msg）を空いた働き手へ。返事 1 つで 1 仕事が終わる
	const ws = [], idle = [], queue = []; let waiters = [];
	const pump = () => { while (idle.length && queue.length) { const w = idle.pop(), j = queue.shift(); w.job = j; w.postMessage(j.msg); } if (queue.length < JOBS * 2) { const a = waiters; waiters = []; for (const r of a) r(); } };
	for (let id = 0; id < JOBS; id++) {
		const w = new Worker(SELF, { workerData: { id }, argv: process.argv.slice(2) });
		w.on("message", r => { const j = w.job; w.job = null; idle.push(w); j.done(r); pump(); });
		w.on("error", e => { console.error(`\n働き手 ${id} が落ちた：`, e); process.exit(1); });
		ws.push(w); idle.push(w);
	}
	const run = msg => new Promise(done => { queue.push({ msg, done }); pump(); });
	const room = () => queue.length < JOBS * 2 ? null : new Promise(r => waiters.push(r));   // 配りすぎない（読む口を待たせる）

	// ── 読む：ogr2ogr の GeoJSONSeq（か、検定用のファイル）を 2,000 行ずつ配る。線と面は同時 ──
	const st = { lines: { seen: 0, used: 0 }, multipolygons: { seen: 0, used: 0 } }; let pieces = 0, lastTick = 0;
	const tick = force => { const now = Date.now(); if (!force && now - lastTick < 2000) return; lastTick = now; process.stdout.write(`\r線 ${st.lines.seen} 件（採った ${st.lines.used}）・面 ${st.multipolygons.seen} 件（採った ${st.multipolygons.used}）・タイルの切れ ${pieces}・${((now - t0) / 1000).toFixed(0)} 秒   `); };
	async function feed(layer, file, want) {
		let input, ogr = null;
		if (file) input = fs.createReadStream(file);
		else {
			// GDAL の版で列が違う（railway が列か other_tags か）＝先に列を見て、在る列だけで条件と選択を組む
			const info = execFileSync("ogrinfo", ["-so", pbf, layer], { encoding: "utf8" }), cols = new Set([...info.matchAll(/^(\w+): \w+/gm)].map(m => m[1]));
			const has = want.filter(c => cols.has(c)), where = [...has.map(c => `${c} IS NOT NULL`), ...want.filter(c => !cols.has(c)).map(c => `other_tags LIKE '%"${c}"=>%'`)].join(" OR ");
			const args = ["-f", "GeoJSONSeq", "/vsistdout/", pbf, layer, "-where", where, "-select", ["osm_id", ...(cols.has("name") ? ["name"] : []), ...has, "other_tags"].join(","), "-lco", "COORDINATE_PRECISION=7"];
			if (BOX) args.push("-spat", ...BOX.map(String));
			ogr = spawn("ogr2ogr", args, { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, OGR_INTERLEAVED_READING: "YES", OSM_MAX_TMPFILE_SIZE: "4096" } });
			input = ogr.stdout;
		}
		const jobs = []; let rows = [];
		const send = () => { const n = rows; rows = []; jobs.push(run({ kind: layer, rows: n }).then(r => { st[layer].seen += r.seen; st[layer].used += r.used; pieces += r.pieces; tick(); })); };
		for await (const s of readline.createInterface({ input, crlfDelay: Infinity })) {
			rows.push(s);
			if (rows.length >= 2000) { send(); const r = room(); if (r) await r; }
		}
		if (rows.length) send();
		await Promise.all(jobs);
		if (ogr) { const code = await new Promise(r => ogr.exitCode !== null ? r(ogr.exitCode) : ogr.on("close", r)); if (code) { console.error(`\nogr2ogr（${layer}）が ${code} で止まった`); process.exit(1); } }
	}
	await Promise.all([
		LINES || pbf ? feed("lines", LINES, ["highway", "railway", "waterway"]) : null,
		POLYS || pbf ? feed("multipolygons", POLYS, ["building", "natural", "landuse", "waterway"]) : null,
	]);
	idle.length = 0; await Promise.all(ws.map(w => new Promise(done => { w.job = { done }; w.postMessage({ flush: 1 }); })));   // 全員の残りを書き出す（1 人ずつ名指しで＝返事で空きに戻る）
	tick(true);
	const seen = st.lines.seen + st.multipolygons.seen, used = st.lines.used + st.multipolygons.used, tRead = (Date.now() - t0) / 1000;
	console.log(`\n読み終わり：${seen} 件を見た・採った ${used} 件・タイルの切れ ${pieces}・${tRead.toFixed(0)} 秒`);

	// ── 束ごとにタイルへ詰める（束＝働き手ごとのファイルの組・大きい束から配る）──
	fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
	const groups = new Map(); for (const f of fs.readdirSync(TMP)) { const k = f.slice(0, f.indexOf(".w")), g = groups.get(k) ?? groups.set(k, { files: [], size: 0 }).get(k); g.files.push(f); g.size += fs.statSync(path.join(TMP, f)).size; }
	const written = [], perBytes = {}, perMax = {}, perOrder = {}; let bytes = 0, big = 0;
	await Promise.all([...groups.values()].sort((a, b) => b.size - a.size).map(g => run({ files: g.files }).then(r => {
		for (const [rel, n] of r.packed) { const k = +/^Norder(\d+)/.exec(rel)[1]; written.push(rel); bytes += n; if (n > 500e3) big++; perOrder[k] = (perOrder[k] || 0) + 1; perBytes[k] = (perBytes[k] || 0) + n; perMax[k] = Math.max(perMax[k] || 0, n); }
		process.stdout.write(`\rタイル：${written.length} 枚・${(bytes / 1e6).toFixed(0)} MB   `);
	})));
	for (const w of ws) await w.terminate();
	fs.rmSync(TMP, { recursive: true, force: true });
	written.sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
	fs.writeFileSync(path.join(OUT, "index.json"), JSON.stringify({ made: new Date().toISOString(), source: `${source}・© OpenStreetMap contributors・ODbL`, layers: LAYERS, minOrder: MIN, maxOrder: MAX, extent: EXT, tiles: written, bytes }) + "\n");
	const orders = Object.keys(perOrder).map(Number).sort((a, b) => a - b), tAll = (Date.now() - t0) / 1000;
	console.log(`\n[hpx-osm] ${written.length} 枚・${(bytes / 1e6).toFixed(1)} MB・500 KB を超えるタイル ${big} 枚・段ごと ${orders.map(k => `N${k}:${perOrder[k]}`).join(" ")}・${tAll.toFixed(0)} 秒（読む・切る ${tRead.toFixed(0)}・詰める ${(tAll - tRead).toFixed(0)}）`);
	console.log(`  段ごとの大きさ（枚・合計・1 枚の最大）：${orders.map(k => `N${k} ${perOrder[k]} 枚 ${(perBytes[k] / 1e6).toFixed(1)} MB 最大 ${(perMax[k] / 1e3).toFixed(0)} KB`).join("／")}`);
}
if (isMainThread) await main(); else worker();
