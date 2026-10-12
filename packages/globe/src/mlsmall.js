// MapLibre の小口（B6・2026-10-12）の純粋な部品＝node で検定できる所だけ。sprite の一覧の正規化と echo・coveringTiles の近似（画面の点→タイル）・font-faces の読み替え。
const D2R = Math.PI / 180;

// style の sprite（文字列＝default・配列＝[{ id, url }]・MapLibre v4）→ [{ id, url }]（url の無い物は落とす・id の重複は後が勝つ）。無指定＝[]
export function normSprite(spec) {
	const list = spec == null ? [] : typeof spec === "string" ? [{ id: "default", url: spec }] : Array.isArray(spec) ? spec : [];
	const out = new Map();
	for (const e of list) { if (!e) continue; const id = String(e.id ?? "default"), url = e.url; if (typeof url === "string" && url) out.set(id, { id, url }); }
	return [...out.values()];
}
// getStyle／getSprite の形：default だけなら文字列（MapLibre の getSprite は常に配列＝こちらは getStyle 用）。無ければ undefined
export function spriteEcho(list) {
	if (!list?.length) return undefined;
	return list.length === 1 && list[0].id === "default" ? list[0].url : list.map(e => ({ id: e.id, url: e.url }));
}
// 複数 sprite の記号の名前の接頭語（MapLibre v4＝"id:name"・default は無し）
export const spritePrefix = id => (id && id !== "default" ? id + ":" : "");

// 経緯度 → タイル座標（メルカトル・z）
export function tileOf(lon, lat, z) {
	const n = 2 ** z, la = Math.max(-85.05112878, Math.min(85.05112878, lat)) * D2R;
	const x = Math.floor(((lon + 180) / 360 % 1 + 1) % 1 * n), y = Math.floor((1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2 * n);
	return [Math.max(0, Math.min(n - 1, x)), Math.max(0, Math.min(n - 1, y))];
}
// coveringTiles の近似：画面に散らした点の経緯度（null＝球の外）→ その点を含むタイルの集合。zOf＝数（一律）か (z, x, y) → z は使わず点ごとに zOf(lon, lat) の数を返す関数
// 戻り＝MapLibre の OverscaledTileID に似た形 [{ canonical: { x, y, z }, overscaledZ, wrap: 0, key }]（z→x→y の順）。minzoom/maxzoom で z を挟む
export function tilesFromPoints(points, zOf, { minzoom = 0, maxzoom = 25 } = {}) {
	const seen = new Map();
	for (const p of points) {
		if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
		let z = typeof zOf === "function" ? zOf(p[0], p[1]) : zOf;
		if (!Number.isFinite(z)) continue;
		z = Math.max(minzoom, Math.min(maxzoom, Math.floor(z)));
		const [x, y] = tileOf(p[0], p[1], z), key = `${z}/${x}/${y}`;
		if (!seen.has(key)) seen.set(key, { canonical: { x, y, z }, overscaledZ: z, wrap: 0, key });
	}
	return [...seen.values()].sort((a, b) => a.canonical.z - b.canonical.z || a.canonical.x - b.canonical.x || a.canonical.y - b.canonical.y);
}
// font-faces の 1 件 → addFontFace の引数。{ "font-family"|family, src（"url(...)" も可・配列なら最初）, weight|"font-weight", style|"font-style", "unicode-range" }。family か src が無ければ null
export function fontFaceArgs(face) {
	if (!face || typeof face !== "object") return null;
	const family = face["font-family"] ?? face.family, src0 = Array.isArray(face.src) ? face.src[0] : face.src;
	if (typeof family !== "string" || !family.trim()) return null;
	const src = typeof src0 === "string" ? src0.replace(/^\s*url\((['"]?)(.*?)\1\)\s*$/i, "$2") : src0;
	if (!src) return null;
	const d = {};
	const w = face["font-weight"] ?? face.weight, st = face["font-style"] ?? face.style, ur = face["unicode-range"] ?? face.unicodeRange;
	if (w != null) d.weight = String(w); if (st != null) d.style = String(st); if (ur != null) d.unicodeRange = String(ur);
	return { family, src, descriptors: d };
}
