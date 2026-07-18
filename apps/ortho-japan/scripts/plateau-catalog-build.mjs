// PLATEAU 登録簿（public/plateau-sets.json）の再生成。
//   node scripts/plateau-catalog-build.mjs          … 差分レポートのみ（書かない）
//   node scripts/plateau-catalog-build.mjs --write  … public/plateau-sets.json を上書き
//
// 真実は datacatalog の一覧API（plateau-datasets）。⚠ alias（…/3dtiles/{code}-bldg-lod2-notexture-latest/）は
// 存在しないコードでも 200 の空殻 tileset（children 0・日本全域のデフォルト region）を返すため、
// alias の疎通で存在判定してはならない（2026-07-18 泉佐野で実証）。
// - bldg: 一覧の type_en=bldg かつ lod=2 の市区町村コード（ward優先）を採用。base は evergreen な alias、
//   bbox は一覧の直リンク asset の tileset.json root region から取る（alias の region はデフォルト箱のことがある）。
// - brid: type_en=brid かつ lod=2。texture無し版優先・最新 registration_year。tileset が空殻（横浜・大阪等の
//   市一括 brid）はここで除外。base は直リンク asset のディレクトリ・noMask:true。
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const LIST = "https://api.plateauview.mlit.go.jp/datacatalog/plateau-datasets";
const OUT  = fileURLToPath(new URL("../public/plateau-sets.json", import.meta.url));
const R2D  = 180 / Math.PI;
const CONCURRENCY = 12;

const write = process.argv.includes("--write");

console.log("一覧API取得中…");
const ds = (await (await fetch(LIST)).json()).datasets;
console.log(`datasets: ${ds.length}`);

// ---- 候補の選抜 -------------------------------------------------------------
// bldg: code（政令市は区コード）ごとに1件。brid: 市ごとに1件（texture無し優先→新しい年度優先）。
const pick = (cands) => cands.sort((a, b) => (a.texture === false ? -1 : 1) - (b.texture === false ? -1 : 1) || b.registration_year - a.registration_year)[0];
const bldgByCode = new Map(), bridByCity = new Map();
for (const x of ds) {
	if (String(x.lod) !== "2") continue;
	if (x.type_en === "bldg") {
		const code = x.ward_code || x.city_code;
		(bldgByCode.get(code) ?? bldgByCode.set(code, { name: x.ward || x.city, cands: [] }).get(code)).cands.push(x);
	} else if (x.type_en === "brid") {
		const code = x.city_code;
		(bridByCity.get(code) ?? bridByCity.set(code, { name: x.city, cands: [] }).get(code)).cands.push(x);
	}
}
console.log(`bldg lod2: ${bldgByCode.size} 市区町村 / brid lod2: ${bridByCity.size} 市`);

// ---- tileset を引いて bbox（root region rad→deg）と空殻判定 -----------------
async function tilesetInfo(url) {
	const t = await (await fetch(url)).json();
	const r = t.root ?? {};
	const region = r.boundingVolume?.region;
	const hasContent = !!(r.content || (r.children?.length));
	if (!region || !hasContent) return null;   // 空殻（children 0）や region 無しは不採用
	return [region[0] * R2D, region[1] * R2D, region[2] * R2D, region[3] * R2D].map(v => Math.round(v * 1e9) / 1e9);
}
async function pooled(items, fn) {
	const out = []; let i = 0;
	await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
		while (i < items.length) { const k = i++; out[k] = await fn(items[k]).catch(e => { console.warn("  skip:", items[k].name ?? "", e.message); return null; }); }
	}));
	return out;
}

console.log("bldg tileset 走査中…");
const bldgEntries = (await pooled([...bldgByCode.entries()], async ([code, { name, cands }]) => {
	const bbox = await tilesetInfo(pick(cands).url);
	if (!bbox) { console.warn(`  bldg空殻: ${code} ${name}`); return null; }
	return { name, base: `https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/${code}-bldg-lod2-notexture-latest/`, bbox };
})).filter(Boolean);

console.log("brid tileset 走査中…");
const bridEntries = (await pooled([...bridByCity.entries()], async ([, { name, cands }]) => {
	const best = pick(cands);
	const bbox = await tilesetInfo(best.url);
	if (!bbox) { console.log(`  brid空殻→除外: ${name}`); return null; }
	return { name: `${name}（橋梁）`, base: best.url.replace(/tileset\.json$/, ""), bbox, noMask: true };
})).filter(Boolean);

const next = [...bldgEntries, ...bridEntries].sort((a, b) => (a.name < b.name ? -1 : 1));

// ---- 差分レポート -----------------------------------------------------------
const cur = JSON.parse(await readFile(OUT, "utf8").catch(() => "[]"));
const key = s => s.base;
const curSet = new Set(cur.map(key)), nextSet = new Set(next.map(key));
const added = next.filter(s => !curSet.has(key(s))), removed = cur.filter(s => !nextSet.has(key(s)));
console.log(`\n現行 ${cur.length} 件 → 生成 ${next.length} 件`);
console.log(`追加 ${added.length}:`, added.map(s => s.name).join("、") || "なし");
console.log(`削除 ${removed.length}:`, removed.map(s => s.name).join("、") || "なし");

if (write) {
	await writeFile(OUT, JSON.stringify(next, null, "\t") + "\n");
	console.log(`\n書き込み: ${OUT}`);
} else {
	console.log("\n（--write で public/plateau-sets.json を上書き）");
}
