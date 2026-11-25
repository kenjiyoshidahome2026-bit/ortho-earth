#!/usr/bin/env node
// 全国の市区町村の台帳（デジタルツインを全国へ広げる前の下調べ）を組む → packages/citytwin/ledger/municipalities.tsv。
// 鍵＝5 桁の全国地方公共団体コード（チェックディジット無し・N03_007 と同じ）。同じ名の市町村（府中市・府中町・伊達市…）を名でなくコードで分ける。
//
//   node packages/citytwin/scripts/build-ledger.mjs            # 全部（クラウドで可：国土数値情報と PLATEAU の目録だけを引く）
//   node packages/citytwin/scripts/build-ledger.mjs --refresh  # 取り直し
//
// 出どころ（列ごとは packages/citytwin/ledger/README.md）：
//   名・よみ        … apps/gishub-jp/scripts/admin-boundary.csv（全国地方公共団体コード＋よみがな・欠番を除く）
//   人口・世帯      … packages/jp/census/2025-pop.json（令和 7 年国勢調査 速報）
//   郡・振興局・範囲・面積・中心 … 国土数値情報 行政区域 N03-2025（2025-01-01・都道府県ごとの zip）
//   PLATEAU        … api.plateauview.mlit.go.jp/datacatalog/plateau-datasets（建物の LOD・年度・大きさ・災害のモデル）
// 生の zip は scripts/.cache/ledger/（git に入れない）。
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, "../../..");
const CACHE = path.join(HERE, ".cache/ledger");
const OUT = path.join(ROOT, "packages/citytwin/ledger/municipalities.tsv");
const REFRESH = process.argv.includes("--refresh");
fs.mkdirSync(path.join(CACHE, "n03"), { recursive: true });

async function get(url, file) {
	if (!REFRESH && fs.existsSync(file)) return fs.readFileSync(file);
	for (let i = 0; ; i++) {
		const r = await fetch(url).catch(e => ({ ok: false, status: String(e) }));
		if (r.ok) { const b = Buffer.from(await r.arrayBuffer()); fs.writeFileSync(file, b); return b; }
		if (i >= 3) throw new Error(`${url}: HTTP ${r.status}`);
		await new Promise(res => setTimeout(res, 2000 * 2 ** i));
	}
}
function unzipEntry(buf, re) {
	let eocd = buf.length - 22;
	while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
	const n = buf.readUInt16LE(eocd + 10);
	let p = buf.readUInt32LE(eocd + 16);
	for (let i = 0; i < n; i++) {
		const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
		const name = buf.subarray(p + 46, p + 46 + nl).toString("latin1");
		p += 46 + nl + xl + cl;
		if (!re.test(name)) continue;
		const lo = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
		const data = buf.subarray(lo, lo + csize);
		return method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data);
	}
	throw new Error(`zip に ${re} が無い`);
}

// ── よみ → ローマ字（ヘボン式・長音記号なし＝今あるデジタルツインの書き方：Kyoto・Tone Chuo）──
const K1 = { あ: "a", い: "i", う: "u", え: "e", お: "o", か: "ka", き: "ki", く: "ku", け: "ke", こ: "ko", さ: "sa", し: "shi", す: "su", せ: "se", そ: "so", た: "ta", ち: "chi", つ: "tsu", て: "te", と: "to",
	な: "na", に: "ni", ぬ: "nu", ね: "ne", の: "no", は: "ha", ひ: "hi", ふ: "fu", へ: "he", ほ: "ho", ま: "ma", み: "mi", む: "mu", め: "me", も: "mo", や: "ya", ゆ: "yu", よ: "yo",
	ら: "ra", り: "ri", る: "ru", れ: "re", ろ: "ro", わ: "wa", を: "o", ん: "n", が: "ga", ぎ: "gi", ぐ: "gu", げ: "ge", ご: "go", ざ: "za", じ: "ji", ず: "zu", ぜ: "ze", ぞ: "zo",
	だ: "da", ぢ: "ji", づ: "zu", で: "de", ど: "do", ば: "ba", び: "bi", ぶ: "bu", べ: "be", ぼ: "bo", ぱ: "pa", ぴ: "pi", ぷ: "pu", ぺ: "pe", ぽ: "po", ゐ: "i", ゑ: "e", ゔ: "vu" };
const SMALL = { ゃ: "a", ゅ: "u", ょ: "o", ぁ: "a", ぃ: "i", ぅ: "u", ぇ: "e", ぉ: "o" };
export function romaji(kana) {
	const syl = [];
	const s = [...kana.replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60))];
	for (let i = 0; i < s.length; i++) {
		const c = s[i], nx = s[i + 1];
		if (c === "っ" || c === "ー") { syl.push(c); continue; }
		let r = K1[c];
		if (r == null) { syl.push(c); continue; }
		if (nx && SMALL[nx] && /[きしちにひみりぎじぢびぴ]/.test(c)) { r = /^(shi|chi|ji)$/.test(r) ? r.slice(0, -1) + SMALL[nx] : r.slice(0, -1) + "y" + SMALL[nx]; i++; }
		else if (nx && SMALL[nx]) { r = r.slice(0, -1) + SMALL[nx]; i++; }
		syl.push(r);
	}
	let out = "", prevV = "", skipped = false;
	for (let i = 0; i < syl.length; i++) {
		let r = syl[i];
		if (r === "っ") { const nx = syl[i + 1] || ""; out += nx.startsWith("ch") ? "t" : nx[0] || ""; prevV = ""; continue; }
		if (r === "ー") continue;
		// 長音を落とす：おう・おお→o、うう→u（1 回だけ＝おおうち＝Ouchi）
		if (!skipped && ((prevV === "o" && (r === "u" || r === "o")) || (prevV === "u" && r === "u"))) { skipped = true; continue; }
		skipped = false;
		if (out.endsWith("n") && syl[i - 1] === "n" && /^[aiueoy]/.test(r)) out += "'";
		out += r; prevV = r.slice(-1);
	}
	return out.replace(/'/g, "");   // 地名の英語表記は区切りの ' を書かない（Kanonji）
}
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
// 市区町村の字のよみ（市＝し・区＝く・町＝ちょう／まち・村＝むら／そん）を外す
function stripKind(name, kana) {
	const k = name.slice(-1);
	const tails = { 市: ["し"], 区: ["く"], 町: ["ちょう", "まち"], 村: ["むら", "そん"] }[k] || [];
	for (const t of tails) if (kana.endsWith(t)) return [kana.slice(0, -t.length), t];
	return [kana, ""];
}

// ── 面の計算（経度・緯度 → km）──
const R = 6371.0088, D = Math.PI / 180;
function ringKm2(r) { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * D * (2 + Math.sin(r[j][1] * D) + Math.sin(r[i][1] * D)); return Math.abs(a * R * R / 2); }
function ringCentroid(r) { let x = 0, y = 0, a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const f = r[j][0] * r[i][1] - r[i][0] * r[j][1]; x += (r[j][0] + r[i][0]) * f; y += (r[j][1] + r[i][1]) * f; a += f; } return a ? [x / (3 * a), y / (3 * a)] : r[0]; }
const r4 = v => Math.round(v * 1e4) / 1e4;

// ── 1. 名・よみ（現行のみ）──
const csv = fs.readFileSync(path.join(ROOT, "apps/gishub-jp/scripts/admin-boundary.csv"), "utf8").trim().split(/\r?\n/).map(l => l.split(","));
const H = csv.shift(), col = k => H.indexOf(k);
const rows = new Map();
for (const c of csv) {
	if (c[col("status")] === "欠番" || c[col("code")].endsWith("000")) continue;
	rows.set(c[col("code")], { code: c[col("code")], prefName: c[col("pref")], name: c[col("city")], kana: c[col("cityKana")] });
}
// ── 2. 種別・親（政令市の区）──
const SEIREI = new Set(["01100", "04100", "11100", "12100", "14100", "14130", "14150", "15100", "22100", "22130", "23100", "26100", "27100", "27140", "28100", "33100", "34100", "40100", "40130", "43100"]);
for (const r of rows.values()) {
	r.pref = r.code.slice(0, 2);
	if (SEIREI.has(r.code)) r.kind = "政令市";
	else if (r.pref === "13" && +r.code.slice(2) >= 101 && +r.code.slice(2) <= 123) r.kind = "特別区";
	else if (/市.+区$/.test(r.name)) {
		r.kind = "区";
		const p = [...SEIREI].find(c => c.slice(0, 2) === r.pref && r.name.startsWith(rows.get(c).name) && +r.code > +c && +r.code < +c + 30);
		if (!p) throw new Error(`区の親が無い：${r.code} ${r.name}`);
		r.parent = p;
	} else r.kind = r.name.slice(-1);   // 市・町・村
}
// 6 桁（チェックディジット付き）
const cd = c => { const s = [...c].reduce((a, d, i) => a + +d * (6 - i), 0); return c + (11 - s % 11) % 10; };
// ── 3. 英語の名・アプリの id ──
for (const r of rows.values()) {
	let name = r.name, kana = r.kana;
	if (r.kind === "区") { const p = rows.get(r.parent); name = name.slice(p.name.length); kana = kana.startsWith(p.kana) ? kana.slice(p.kana.length) : kana; }
	const [stem, tail] = stripKind(name, kana);
	const en = cap(romaji(stem));
	r.en = en;
	r.enFull = r.kind === "区" ? `${en}-ku` : `${en} ${{ 市: "City", 政令市: "City", 特別区: "City", 町: "Town", 村: "Village" }[r.kind]}`;
	r.kanaTail = tail;
}
// id＝英語の名を小文字に。同じ id が 2 つ以上の市区町村に出たら「-県」、それでも重なれば種別も足す。既にある頁の id は変えない
const APPS = { "14100": "yokohama", "26100": "kyoto", "40130": "fukuoka", "01100": "sapporo", "01204": "asahikawa", "40228": "asakura", "10444": "kawaba", "10426": "kusatsu" };
const PREF_EN = ["", "hokkaido", "aomori", "iwate", "miyagi", "akita", "yamagata", "fukushima", "ibaraki", "tochigi", "gunma", "saitama", "chiba", "tokyo", "kanagawa", "niigata", "toyama", "ishikawa", "fukui", "yamanashi", "nagano", "gifu", "shizuoka", "aichi", "mie", "shiga", "kyoto", "osaka", "hyogo", "nara", "wakayama", "tottori", "shimane", "okayama", "hiroshima", "yamaguchi", "tokushima", "kagawa", "ehime", "kochi", "fukuoka", "saga", "nagasaki", "kumamoto", "oita", "miyazaki", "kagoshima", "okinawa"];
const RESERVED = new Set(fs.readdirSync(path.join(ROOT, "apps")).filter(d => !Object.values(APPS).includes(d)));
const units = [...rows.values()].filter(r => r.kind !== "区");
const base = r => r.en.toLowerCase().replace(/[^a-z0-9]+/g, "-");
const count = new Map();
for (const r of units) count.set(base(r), (count.get(base(r)) || 0) + 1);
for (const r of units) {
	if (APPS[r.code]) { r.id = APPS[r.code]; r.app = `/${APPS[r.code]}/`; continue; }
	let id = base(r);
	if (count.get(id) > 1 || RESERVED.has(id) || Object.values(APPS).includes(id)) id += "-" + PREF_EN[+r.pref];
	r.id = id;
}
const ids = new Map();
for (const r of units) ids.set(r.id, [...(ids.get(r.id) || []), r]);
for (const [id, list] of ids) if (list.length > 1) for (const r of list) r.id = `${id.replace(/-[a-z]+$/, "")}-${{ 市: "city", 特別区: "city", 政令市: "city", 町: "town", 村: "village" }[r.kind]}-${PREF_EN[+r.pref]}`;
// 名の重なり（同じ漢字の名が別の市区町村にある）
const byName = new Map();
for (const r of units) byName.set(r.name, [...(byName.get(r.name) || []), r.code]);
const stemOf = r => r.name.replace(/[市町村]$/, "");
const byStem = new Map();
for (const r of units) byStem.set(stemOf(r), [...(byStem.get(stemOf(r)) || []), r.code]);
for (const r of units) r.same = [...new Set([...byName.get(r.name), ...byStem.get(stemOf(r))])].filter(c => c !== r.code).join(" ");

// ── 4. 人口 ──
const pop = JSON.parse(fs.readFileSync(path.join(ROOT, "packages/jp/census/2025-pop.json"), "utf8"));
for (const r of rows.values()) { const p = pop[r.code]; if (p) { r.pop = p.pop?.[0]; r.hh = p.hh; r.popChange = p.popChange; } }

// ── 4b. 型の判定に要る施設（国土数値情報）＝都道府県ごとに N03 の面で点を市区町村へ振る ──
//   駅 N02-25（全国 1 本）・病院 P04-20・消防署 P17-12・警察署 P18-12（管轄の面も）・用途地域 A29-19・小学校区 A27-21・中学校区 A32-21
const KSJ = "https://nlftp.mlit.go.jp/ksj/gml/data/";
fs.mkdirSync(path.join(CACHE, "ksj"), { recursive: true });
const ksjZip = async rel => { const f = path.join(CACHE, "ksj", rel.split("/").pop()); try { return await get(KSJ + rel, f); } catch (e) { console.warn(`\n✗ ${rel}: ${e.message}`); return null; } };
const zipNames = buf => { const out = []; let eocd = buf.length - 22; while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--; const n = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16); for (let i = 0; i < n; i++) { const nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32); out.push(buf.subarray(p + 46, p + 46 + nl).toString("latin1")); p += 46 + nl + xl + cl; } return out; };
function readDbf(b) {
	const n = b.readUInt32LE(4), hl = b.readUInt16LE(8), rl = b.readUInt16LE(10), dec = new TextDecoder("shift_jis"), fields = [];
	for (let o = 32; b[o] !== 0x0d; o += 32) fields.push({ name: b.subarray(o, o + 11).toString("latin1").replace(/\0.*$/, ""), len: b[o + 16] });
	const rows = [];
	for (let i = 0; i < n; i++) { let o = hl + i * rl + 1; const row = {}; for (const f of fields) { row[f.name] = dec.decode(b.subarray(o, o + f.len)).trim(); o += f.len; } rows.push(row); }
	return rows;
}
function readShp(b) {   // 点と面だけ（面は環の列のまま＝点の内外は偶奇で数えるので外周と穴を分けなくてよい）
	const geoms = [];
	for (let o = 100; o + 8 <= b.length;) {
		const len = b.readInt32BE(o + 4) * 2, t = b.readInt32LE(o + 8), c = o + 8;
		if (t === 1) geoms.push([b.readDoubleLE(c + 4), b.readDoubleLE(c + 12)]);
		else if (t === 5) {
			const np = b.readInt32LE(c + 36), nn = b.readInt32LE(c + 40), parts = [];
			for (let i = 0; i < np; i++) parts.push(b.readInt32LE(c + 44 + i * 4));
			const pts = c + 44 + np * 4, rings = [];
			for (let i = 0; i < np; i++) { const ring = []; for (let k = parts[i]; k < (parts[i + 1] ?? nn); k++) ring.push([b.readDoubleLE(pts + k * 16), b.readDoubleLE(pts + k * 16 + 8)]); rings.push(ring); }
			geoms.push(rings);
		} else geoms.push(null);
		o += 8 + len;
	}
	return geoms;
}
const shpRows = (buf, re) => { const names = zipNames(buf); const shp = names.find(n => re.test(n) && n.endsWith(".shp")), dbf = shp.replace(/\.shp$/, ".dbf"); const g = readShp(unzipEntry(buf, new RegExp(shp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$"))); return readDbf(unzipEntry(buf, new RegExp(dbf.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$"))).map((p, i) => ({ p, g: g[i] })); };
const bboxOf = ring => { const b = [180, 90, -180, -90]; for (const [x, y] of ring) { if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y; } return b; };
const inRing = ([x, y], r) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
const inRings = (pt, rings) => rings.reduce((c, r) => c !== inRing(pt, r), false);
const inBoxP = ([x, y], b) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];
const where = (pt, muni) => muni.find(m => inBoxP(pt, m.box) && inRings(pt, m.poly))?.code;
const km = (a, b) => { const dx = (a[0] - b[0]) * Math.cos((a[1] + b[1]) / 2 * D), dy = a[1] - b[1]; return Math.hypot(dx, dy) * D * R; };
// 旧コード（合併・市制）→ 今のコード
const NEWCODE = new Map(csv.filter(c => c[col("status")] === "欠番" && c[col("newCode")]).map(c => [c[col("code")], c[col("newCode")]]));
const cur = c => { for (let i = 0; i < 5 && c && !rows.has(c) && NEWCODE.has(c); i++) c = NEWCODE.get(c); return c; };
const add = (code, k, v = 1) => { const r = rows.get(code); if (!r) return; r[k] = (r[k] || 0) + v; if (r.parent) { const p = rows.get(r.parent); p[k] = (p[k] || 0) + v; } };
// 全国の点（生活圏の枠を引くのに使う）
const ALL = { sta: [], police: [], fire: [], er: [], hosp: [] };
let N02 = null;
async function stage2(pp, muni) {
	if (!N02) {
		const buf = await ksjZip("N02/N02-25/N02-25_GML.zip");
		N02 = JSON.parse(unzipEntry(buf, /UTF-8\/N02-25_Station\.geojson$/).toString("utf8")).features.map(f => {
			const c = f.geometry.coordinates, m = c[Math.floor(c.length / 2)];
			return { pt: m, name: f.properties.N02_005, line: `${f.properties.N02_004} ${f.properties.N02_003}`, grp: f.properties.N02_005g };
		});
	}
	const pbox = muni.reduce((b, m) => [Math.min(b[0], m.box[0]), Math.min(b[1], m.box[1]), Math.max(b[2], m.box[2]), Math.max(b[3], m.box[3])], [180, 90, -180, -90]);
	// 駅（同じ駅の名の集まり N02_005g を 1 つに数える）
	const seen = new Set();
	for (const s of N02) {
		if (!inBoxP(s.pt, pbox)) continue;
		const code = where(s.pt, muni); if (!code) continue;
		const r = rows.get(code); (r.lines ||= new Set()).add(s.line); if (r.parent) (rows.get(r.parent).lines ||= new Set()).add(s.line);
		if (seen.has(s.grp)) continue; seen.add(s.grp);
		add(code, "stations"); ALL.sta.push({ ...s, code });
	}
	// 病院（P04_001＝1）・救急告示（P04_009＝1）
	const p04 = await ksjZip(`P04/P04-20/P04-20_${pp}_GML.zip`);
	if (p04) for (const f of JSON.parse(unzipEntry(p04, /\.geojson$/).toString("utf8")).features) {
		const q = f.properties; if (+q.P04_001 !== 1) continue;
		const code = where(f.geometry.coordinates, muni); if (!code) continue;
		add(code, "hospitals"); ALL.hosp.push({ pt: f.geometry.coordinates, name: q.P04_002, code, pref: pp });
		if (+q.P04_009 === 1) { add(code, "erHospitals"); ALL.er.push({ pt: f.geometry.coordinates, name: q.P04_002, code }); }
	}
	// 消防（本部 1・署 2 を数える・出張所 3 は数えない）と受け持ちの署
	const p17 = await ksjZip(`P17/P17-12/P17-12_${pp}_GML.zip`);
	if (p17) {
		for (const { p, g } of shpRows(p17, /FireStation\./)) {
			if (!g || !/^[12]$/.test(p.P17_003)) continue;
			const code = where(g, muni); ALL.fire.push({ pt: g, name: p.P17_001, code });
			if (code) add(code, "fireSt");
		}
		const jur = shpRows(p17, /FireStationJurisdiction\./).filter(j => j.g);
		for (const r of rows.values()) if (r.pref === pp && r.ref) r.fireName = jur.find(j => inBoxP(r.ref, bboxOf(j.g.flat())) && inRings(r.ref, j.g))?.p.P17_005;
	}
	// 警察（本署 P18_003＝2）と管轄の署
	const p18 = await ksjZip(`P18/P18-12/P18-12_${pp}_GML.zip`);
	if (p18) {
		for (const { p, g } of shpRows(p18, /PoliceStation\./)) {
			if (!g || p.P18_003 !== "2") continue;
			const code = where(g, muni); ALL.police.push({ pt: g, name: p.P18_001, code });
			if (code) add(code, "policeSt");
		}
		const jur = shpRows(p18, /PoliceStationJurisdiction\./).filter(j => j.g);
		for (const r of rows.values()) if (r.pref === pp && r.ref) r.policeName = jur.find(j => inBoxP(r.ref, bboxOf(j.g.flat())) && inRings(r.ref, j.g))?.p.P18_005;
	}
	// 用途地域（県の zip の中に市町村ごとの shp＝A29-19_<code>.shp）
	const a29 = await ksjZip(`A29/A29-19/A29-19_${pp}_GML.zip`);
	if (a29) for (const n of zipNames(a29)) { const m = n.match(/A29-19_(\d{5})\.shp$/); if (m) { const c = cur(m[1]); const r = rows.get(c); if (r) { r.zoning = true; if (r.parent) rows.get(r.parent).zoning = true; } } }
	// 小・中学校区（面の数＝学校の数）
	for (const [k, rel, key] of [["eschool", `A27/A27-21/A27-21_${pp}_GML.zip`, "A27_001"], ["jschool", `A32/A32-21/A32-21_${pp}_GML.zip`, "A32_001"]]) {
		const z = await ksjZip(rel); if (!z) continue;
		const ids = new Map();
		for (const f of JSON.parse(unzipEntry(z, /\.geojson$/).toString("utf8")).features) { const c = cur(f.properties[key]); const id = f.properties[key.replace(/001$/, "003")]; (ids.get(c) || ids.set(c, new Set()).get(c)).add(id); }
		for (const [c, s] of ids) add(c, k, s.size);
	}
}

// ── 5. 国土数値情報 N03（郡・振興局・範囲・面積・中心）──
for (let p = 1; p <= 47; p++) {
	const pp = String(p).padStart(2, "0");
	const buf = await get(`https://nlftp.mlit.go.jp/ksj/gml/data/N03/N03-2025/N03-20250101_${pp}_GML.zip`, path.join(CACHE, "n03", `N03-20250101_${pp}_GML.zip`));
	const gj = JSON.parse(unzipEntry(buf, /\.geojson$/).toString("utf8"));
	const acc = new Map(), muni = [];
	for (const f of gj.features) {
		const pr = f.properties, code = pr.N03_007;
		if (!code) continue;   // 所属未定地
		const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
		for (const poly of polys) muni.push({ code, poly, box: bboxOf(poly[0]) });
		const targets = [code];
		const r0 = rows.get(code);
		if (r0?.parent) targets.push(r0.parent);
		for (const t of targets) {
			let a = acc.get(t);
			if (!a) acc.set(t, a = { box: [180, 90, -180, -90], km2: 0, big: null, bigA: 0, gun: null, shinko: null });
			if (t === code) { if (pr.N03_003 && /郡$/.test(pr.N03_003)) a.gun = pr.N03_003; if (pr.N03_002) a.shinko = pr.N03_002; }
			for (const poly of polys) {
				const ar = ringKm2(poly[0]) - poly.slice(1).reduce((s, h) => s + ringKm2(h), 0);
				a.km2 += ar;
				if (ar > a.bigA) { a.bigA = ar; a.big = poly[0]; }
				for (const [x, y] of poly[0]) { if (x < a.box[0]) a.box[0] = x; if (y < a.box[1]) a.box[1] = y; if (x > a.box[2]) a.box[2] = x; if (y > a.box[3]) a.box[3] = y; }
			}
		}
	}
	for (const [code, a] of acc) {
		const r = rows.get(code);
		if (!r) { console.warn(`N03 にあって台帳に無いコード：${code}`); continue; }
		// 面の中の代表点＝いちばん大きな面の重心（凹んだ面で外に出たら、その緯度で面を横切る線の最も長い区間の中点）
		let ref = ringCentroid(a.big);
		if (!inRing(ref, a.big)) {
			const y = ref[1], xs = [];
			for (let i = 0, j = a.big.length - 1; i < a.big.length; j = i++) { const [xi, yi] = a.big[i], [xj, yj] = a.big[j]; if ((yi > y) !== (yj > y)) xs.push((xj - xi) * (y - yi) / (yj - yi) + xi); }
			xs.sort((p, q) => p - q); let best = 0;
			for (let i = 0; i + 1 < xs.length; i += 2) if (xs[i + 1] - xs[i] > best) { best = xs[i + 1] - xs[i]; ref = [(xs[i] + xs[i + 1]) / 2, y]; }
		}
		Object.assign(r, { gun: a.gun, shinko: a.shinko, km2: Math.round(a.km2 * 10) / 10, bbox: a.box.map(r4), lon: r4(ref[0]), lat: r4(ref[1]), ref });
	}
	await stage2(pp, muni);
	process.stdout.write(`\rN03＋施設 ${pp}/47`);
}
console.log();

// ── 6. PLATEAU の目録 ──
const cat = JSON.parse(await get("https://api.plateauview.mlit.go.jp/datacatalog/plateau-datasets", path.join(CACHE, "plateau-datasets.json")));
const HAZ = { fld: "洪水", tnm: "津波", htd: "高潮", ifld: "内水", lsld: "土砂", rfld: "洪水(県)" };
const pl = new Map();
for (const d of cat.datasets) {
	for (const code of new Set([d.city_code, d.ward_code].filter(Boolean))) {
		let a = pl.get(code);
		if (!a) pl.set(code, a = { lods: new Set(), years: new Set(), bytes: new Map(), haz: new Set() });
		if (d.type_en === "bldg") { if (d.lod) a.lods.add(d.lod); a.years.add(d.year); a.bytes.set(d.year, (a.bytes.get(d.year) || 0) + (d.lod === "1" ? d.file_size || 0 : 0)); }
		if (HAZ[d.type_en]) a.haz.add(HAZ[d.type_en]);
	}
}
for (const [code, a] of pl) {
	const r = rows.get(code);
	if (!r) { console.warn(`PLATEAU にあって台帳に無いコード：${code}`); continue; }
	if (a.lods.size) {
		const y = Math.max(...a.years);
		Object.assign(r, { plateauLod: [...a.lods].sort().join(","), plateauYear: y, plateauLod1MB: Math.round(a.bytes.get(y) / 1e6) });
	}
	if (a.haz.size) r.plateauHaz = [...a.haz].join(",");
}

// ── 6b. 型（docs/citytwin-guide.md）と型 C の生活圏の枠の案 ──
//   A＝政令市・特別区（区を並べる）／B＝駅・警察の本署・消防署（本部か署）・病院がどれも境界の中にある／C＝どれかが外
//   C の lifeBox＝境界の矩形に、管轄の警察署・受け持ちの消防署・最寄りの駅・最寄りの救急告示病院（中に無い物だけ）を足して 0.02° の余白
//   枠に足すのは 30 km 以内だけ（島の町村で海の向こうの駅まで枠を広げない）。救急告示の印がほぼ無い県（山梨・島根・徳島・香川・神奈川）は病院の全部から
const LIFE_KM = 30;
const LOW_ER = new Set([...new Set(ALL.hosp.map(h => h.pref))].filter(p => ALL.er.filter(e => e.code.startsWith(p)).length < 0.1 * ALL.hosp.filter(h => h.pref === p).length));
const nearest = (list, pt, pred = () => true) => { let best = null, d = Infinity; for (const x of list) { if (!pred(x)) continue; const k = km(pt, x.pt); if (k < d) { d = k; best = x; } } return best && { ...best, km: Math.round(d * 10) / 10 }; };
for (const r of rows.values()) {
	if (r.kind === "区") continue;
	if (r.kind === "政令市" || r.kind === "特別区") { r.type = "A"; continue; }
	if (!r.ref) continue;
	const miss = [];
	if (!r.stations) miss.push("駅");
	if (!r.policeSt) miss.push("警察");
	if (!r.fireSt) miss.push("消防");
	if (!r.hospitals) miss.push("病院");
	r.type = miss.length ? "C" : "B";
	r.missing = miss.join("・");
	if (r.type !== "C") continue;
	const box = [...r.bbox], put = (pt, d = km(pt, r.ref)) => { if (d > LIFE_KM) return; box[0] = Math.min(box[0], pt[0]); box[1] = Math.min(box[1], pt[1]); box[2] = Math.max(box[2], pt[0]); box[3] = Math.max(box[3], pt[1]); };
	if (!r.stations) { const s = nearest(ALL.sta, r.ref); if (s) { put(s.pt); r.nearSta = `${s.name}（${s.line}・${s.km} km）`; } }
	if (!r.policeSt) { const s = (r.policeName && ALL.police.find(x => x.name === r.policeName && x.pt && km(x.pt, r.ref) < 80)) || nearest(ALL.police, r.ref); if (s) { put(s.pt); r.nearPolice = `${s.name}（${Math.round(km(s.pt, r.ref) * 10) / 10} km）`; } }
	if (!r.fireSt) { const s = (r.fireName && ALL.fire.find(x => x.name === r.fireName && km(x.pt, r.ref) < 80)) || nearest(ALL.fire, r.ref); if (s) { put(s.pt); r.nearFire = `${s.name}（${Math.round(km(s.pt, r.ref) * 10) / 10} km）`; } }
	if (!r.erHospitals) { const s = nearest(LOW_ER.has(r.pref) ? ALL.hosp : ALL.er, r.ref); if (s) { put(s.pt); r.nearEr = `${s.name}（${s.km} km）`; } }
	r.lifeBox = [box[0] - 0.02, box[1] - 0.02, box[2] + 0.02, box[3] + 0.02].map(v => Math.round(v * 100) / 100).join(",");
}

// ── 7. 書き出す ──
const COLS = [
	["code", r => r.code], ["code6", r => cd(r.code)], ["pref", r => r.pref], ["prefName", r => r.prefName], ["name", r => r.name], ["kana", r => r.kana],
	["kind", r => r.kind], ["parent", r => r.parent], ["gun", r => r.gun], ["shinko", r => r.shinko],
	["en", r => r.en], ["enFull", r => r.enFull], ["id", r => r.id], ["app", r => r.app], ["sameName", r => r.same],
	["pop2025", r => r.pop], ["hh2025", r => r.hh], ["popChange", r => r.popChange], ["km2", r => r.km2],
	["w", r => r.bbox?.[0]], ["s", r => r.bbox?.[1]], ["e", r => r.bbox?.[2]], ["n", r => r.bbox?.[3]], ["lon", r => r.lon], ["lat", r => r.lat],
	["type", r => r.type], ["missing", r => r.missing],
	["stations", r => r.stations || 0], ["lines", r => r.lines?.size || 0], ["policeSt", r => r.policeSt || 0], ["fireSt", r => r.fireSt || 0], ["hospitals", r => r.hospitals || 0], ["erHospitals", r => r.erHospitals || 0],
	["zoning", r => r.zoning ? 1 : 0], ["eschool", r => r.eschool || 0], ["jschool", r => r.jschool || 0],
	["policeName", r => r.policeName], ["fireName", r => r.fireName],
	["nearSta", r => r.nearSta], ["nearPolice", r => r.nearPolice], ["nearFire", r => r.nearFire], ["nearEr", r => r.nearEr], ["lifeBox", r => r.lifeBox],
	["plateauLod", r => r.plateauLod], ["plateauYear", r => r.plateauYear], ["plateauLod1MB", r => r.plateauLod1MB], ["plateauHaz", r => r.plateauHaz],
];
const sorted = [...rows.values()].sort((a, b) => a.code.localeCompare(b.code));
const tsv = [COLS.map(c => c[0]).join("\t"), ...sorted.map(r => COLS.map(([, f]) => f(r) ?? "").join("\t"))].join("\n") + "\n";
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, tsv);
const n = k => sorted.filter(r => r.kind === k).length, t = k => sorted.filter(r => r.type === k).length;
console.log(`✓ ${path.relative(ROOT, OUT)}：${sorted.length} 行（政令市 ${n("政令市")}・区 ${n("区")}・特別区 ${n("特別区")}・市 ${n("市")}・町 ${n("町")}・村 ${n("村")}）・型 A ${t("A")}・B ${t("B")}・C ${t("C")}`);
const miss = sorted.filter(r => r.km2 == null);
if (miss.length) console.log(`N03 に面の無いコード ${miss.length}：${miss.map(r => r.code + r.name).join(" ")}`);
