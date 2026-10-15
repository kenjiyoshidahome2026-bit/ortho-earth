// sources/registry.js ── 列チャンクの読み手の登録簿（#90）。タイル形式の登録簿（core の tileformat.js・#88）と同じ形の別物。
// 読み手の契約：
//   registerColumnarSource({
//     name: "geoparquet",
//     test({ name, head }) → boolean,          // 拡張子と先頭バイト（PAR1 等）で名乗る（head＝先頭 16 バイト・無ければ空）
//     async open(src, ctx) → {                  // ctx＝{ name, rAx, chunkFeatures, chunkVertices }
//       meta,                                   // { name, rows, chunks:[{ bbox|null, rows, bytes }], columns:[{ name, numeric }], range:{col:[lo,hi]}, bbox|null, types:[…], crs? }
//       select(bbox) → number[],                // 視野に触れるチャンク番号（統計・索引が無ければ全部）
//       readGeometry(g) → flat,                 // フラットな幾何（flat.js）
//       readColumns(g, names) → { 列名: 値[] },  // チャンクの行に揃った列（paint が参照する列だけ）
//       readProps(g, f) → object,               // 1 行の属性（tip）。f＝チャンク内の番号
//       range?(name) → [lo, hi] | null,         // 数値列のレンジ（統計が無い読み手は自分で数える）
//       metrics?() → object | null,
//       close?() }
//   });
// 読み手の仕事は「フラットな幾何と列を返す」まで。単位球 xyz・三角形分割・LOD・fid 表は columnar 側で共通にやる。
const sources = [];
export function registerColumnarSource(def) {
	if (!def?.name || typeof def.open !== "function" || typeof def.test !== "function") throw new Error("registerColumnarSource: { name, test, open } required");
	const i = sources.findIndex(s => s.name === def.name);
	if (i >= 0) sources[i] = def; else sources.push(def);
	return def;
}
export const listColumnarSources = () => sources.map(s => s.name);
export const hasColumnarSource = name => sources.some(s => s.name === name);
// 名指し（hint）か test で選ぶ。head＝先頭バイト（Uint8Array・無ければ空）
export function findColumnarSource({ name = "", head = new Uint8Array(0), hint = null } = {}) {
	if (hint) return sources.find(s => s.name === hint) ?? null;
	for (const s of sources) { try { if (s.test({ name, head })) return s; } catch { /* 名乗り損ね＝次へ */ } }
	return null;
}
