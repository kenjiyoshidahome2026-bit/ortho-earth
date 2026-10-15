// gint の属性列（geopbf 改良点 ⑦・2026-10-12）── fid 表（style.js buildFidStyle）の式が読む値を、feature ごとの属性オブジェクトでなく
// 「鍵ごとの列」に並べる＝GPU（gpu/gintexpr.js の WGSL）が ["get", k]／["feature-state", k]／["geometry-type"] を添字 1 回で読む形。
// 値の表現（1 セル＝vec2u）: x＝型 t（0 undefined・1 number・2 string・3 boolean・4 null）、y＝中身（number は f32 のビット・string は辞書 id・boolean は 0/1）。
// 文字列は層ごとの辞書（Dict）に 1 回だけ入れる＝式のリテラルも同じ辞書を引く（=== は id の一致）。id 0 は ""（truthy が偽になる唯一の文字列）。
// 列の統計（kinds）＝型の混在を compile 時に知る（数の文字列 "2.5" を持つ列は数の文脈で GPU に載せない＝JS の Number("2.5") と合わない）。
export const T_UNDEF = 0, T_NUM = 1, T_STR = 2, T_BOOL = 3, T_NULL = 4;

export class Dict {
	constructor() { this.list = [""]; this.map = new Map([["", 0]]); }
	intern(s) { let id = this.map.get(s); if (id === undefined) { id = this.list.length; this.list.push(s); this.map.set(s, id); } return id; }
	get size() { return this.list.length; }
}

const f32bits = (() => { const f = new Float32Array(1), u = new Uint32Array(f.buffer); return v => { f[0] = v; return u[0]; }; })();
const NUMERIC_STR = /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$|^\s*$/;   // Number(s) が NaN でない文字列（"" と空白だけ＝0 も含む）

// 1 つの値 → [t, payload]（kinds＝列の統計を積む・省略可）
export function encodeValue(v, dict, kinds = null) {
	if (v === undefined) { if (kinds) kinds.undef = true; return [T_UNDEF, 0]; }
	if (v === null) { if (kinds) kinds.nul = true; return [T_NULL, 0]; }
	if (typeof v === "number") { if (kinds) kinds.num = true; return [T_NUM, f32bits(v)]; }
	if (typeof v === "boolean") { if (kinds) kinds.bool = true; return [T_BOOL, v ? 1 : 0]; }
	if (typeof v === "string") { if (kinds) { kinds.str = true; if (NUMERIC_STR.test(v)) kinds.numStr = true; } return [T_STR, dict.intern(v)]; }
	if (kinds) kinds.other = true;   // Date／配列／オブジェクト＝GPU では扱わない（compile が断る）
	return [T_UNDEF, 0];
}
export const newKinds = () => ({ undef: false, nul: false, num: false, bool: false, str: false, numStr: false, other: false });

// 式が読む鍵を集める → { props: Set, states: Set, geom, zoom, dyn }（dyn＝鍵が式＝列にできない）
function exprKeys(e, out = { props: new Set(), states: new Set(), geom: false, zoom: false, dyn: false }) {
	if (!Array.isArray(e) || typeof e[0] !== "string") return out;
	const op = e[0];
	if (op === "get" || op === "has") { if (typeof e[1] === "string" && e.length === 2) out.props.add(e[1]); else out.dyn = true; return out; }
	if (op === "feature-state") { if (typeof e[1] === "string") out.states.add(e[1]); else out.dyn = true; return out; }
	if (op === "geometry-type") { out.geom = true; return out; }
	if (op === "zoom") { out.zoom = true; return out; }
	if (op === "literal") return out;
	for (let i = 1; i < e.length; i++) exprKeys(e[i], out);
	return out;
}
export function paintKeys(paint, filter) {
	const out = { props: new Set(), states: new Set(), geom: false, zoom: false, dyn: false };
	for (const v of Object.values(paint || {})) exprKeys(v, out);
	if (filter) exprKeys(filter, out);
	if (paint && (paint["circle-color"] != null || paint["line-color"] != null)) out.geom = true;   // G 欄＝点か否かで circle/line を選ぶ
	return out;
}

// 属性列（鍵 keys の順・列優先）: Uint32Array(keys.length × count × 2)。kinds＝鍵ごとの統計
export function buildPropColumns(features, keys, dict) {
	const count = features.length, data = new Uint32Array(Math.max(1, keys.length * count * 2)), kinds = new Map();
	keys.forEach((k, ki) => {
		const K = newKinds(); kinds.set(k, K);
		const base = ki * count * 2;
		for (let fid = 0; fid < count; fid++) {
			const p = features[fid]?.properties;
			const [t, y] = encodeValue(p && (k in p) ? p[k] : undefined, dict, K);
			data[base + fid * 2] = t; data[base + fid * 2 + 1] = y;
		}
	});
	return { data, kinds, count };
}
// feature-state 列（states＝Map<fid, object>）：鍵 keys の順・列優先。欠け＝undefined
export function buildStateColumns(states, keys, count, dict) {
	const data = new Uint32Array(Math.max(1, keys.length * count * 2));
	if (states) for (const [fid, st] of states) { if (!(fid >= 0 && fid < count)) continue; keys.forEach((k, ki) => { const [t, y] = encodeValue(st && (k in st) ? st[k] : undefined, dict); const o = ki * count * 2 + fid * 2; data[o] = t; data[o + 1] = y; }); }
	return data;
}
// 1 fid の state → 鍵ごとの [t, payload]（worker が列の該当セルだけ書く）
export function encodeStateRow(st, keys, dict) { return keys.map(k => encodeValue(st && (k in st) ? st[k] : undefined, dict)); }
// geometry-type 列（辞書 id・1 fid 1 u32）＝"Point"/"Polygon"/… の文字列 id。点か否かの判定も同じ列（Point/MultiPoint の id）
export function buildGeomColumn(features, dict) {
	const n = features.length, g = new Uint32Array(Math.max(1, n));
	for (let i = 0; i < n; i++) g[i] = dict.intern(features[i]?.geometry?.type ?? "");
	return g;
}
