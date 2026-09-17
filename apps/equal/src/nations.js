// 国の定義＝packages/world（国別 DB v2）に合わせる（本人 2026-09-18「国等の定義は world にあります。合わせて」）。
//   ・国の単位＝NationDB の key（ISO 3166-1 alpha-2・非 ISO 主体は B コード）
//   ・国の形＝packages/world の ne-cultural（NE admin_1 を world key で束ね済み）
//   ・名前/コード/統計＝bucket GIS/world の NationDB.json（英語が基軸）＋ i18n/ja.json（日本語名＝CSV の名寄せ用）
// 項目のラベル・単位・出所は apps/world の SORTS と同じ。

const BASE = "https://api.ortho-earth.com/bucket/GIS/world/";

// apps/world model.js REGIONS と同じ番号→名前
export const REGION_NAMES = { 1: "Europe", 2: "Africa", 3: "Asia", 4: "North America", 5: "South America", 6: "Oceania/Antarctica" };

export async function loadNations() {
	const get = async name => { const r = await fetch(BASE + name); if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`); return r.json(); };
	const [db, ja] = await Promise.all([get("NationDB.json"), get("i18n/ja.json").catch(() => null)]);
	const items = db.items || db;
	const byKey = new Map(items.map((n, i) => [n.key, i]));
	return { items, byKey, ja: ja?.nations || {}, updated: db.updated };
}

// 統計の配列＝[最新年, 値(最新年), 値(前年), …]（null は欠測）→ { year, value } | null
export function latest(arr) {
	if (!Array.isArray(arr)) return null;
	for (let i = 1; i < arr.length; i++) if (arr[i] != null) return { year: arr[0] - (i - 1), value: arr[i] };
	return null;
}

// 主題（apps/world SORTS と同じ項目・単位・出所）。value(nation) → 数値 | 文字列 | null
const stat = (member, label, ramp, unit, ref, scale = 1) => ({
	label, unit, ref, type: "quantile", ramp,
	value: n => { const v = latest(n[member]); return v && v.value > 0 ? v.value * scale : null; },
	year: n => latest(n[member])?.year,
});
export const PRESETS = {
	political: { label: "Political", type: "political", ref: "Neighbors from World DB regions" },
	region: { label: "Region", type: "categorical", ref: "World DB", value: n => REGION_NAMES[n.region] || null },
	population: stat("population", "Population", "blue", "", "United Nations Population Division"),
	density: { label: "Population density", unit: "/km²", ref: "Population ÷ Area", type: "quantile", ramp: "blue",
		value: n => { const p = latest(n.population); return p && n.area > 0 ? p.value / n.area : null; } },
	gdp: stat("gdp", "GDP", "green", "US$", "World Bank / IMF", 1e6),
	gdppc: stat("gdppc", "GDP per Capita", "orange", "US$", "World Bank / IMF"),
	ppppc: stat("ppppc", "GDP (PPP) per Capita", "orange", "US$", "World Bank / IMF"),
	gnipc: stat("gnipc", "GNI per Capita", "orange", "US$", "World Bank"),
	hdi: stat("hdi", "Human Development Index", "purple", "", "Human Development Report from UNDP"),
	homicide: stat("homicide", "Intentional homicide rate", "purple", "/100k", "World Bank (UNODC)"),
	area: { label: "Area", unit: "km²", ref: "World DB", type: "quantile", ramp: "green", value: n => n.area > 0 ? n.area : null },
};

// 隣接グラフ → 色番号 1..k（次数の大きい順の貪欲彩色＝Welsh–Powell）
export function colorGraph(count, edges) {
	const adj = Array.from({ length: count }, () => []);
	for (const [a, b] of edges) if (a < count && b < count) { adj[a].push(b); adj[b].push(a); }
	const order = [...adj.keys()].sort((a, b) => adj[b].length - adj[a].length);
	const color = new Int8Array(count);
	for (const v of order) { const used = new Set(adj[v].map(u => color[u])); let c = 1; while (used.has(c)) c++; color[v] = c; }
	return color;
}
