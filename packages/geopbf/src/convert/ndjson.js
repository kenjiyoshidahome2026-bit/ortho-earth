// convert/ndjson.js ── NDJSON（1 行 1 GeoJSON・.ndjson/.geojsonl/.jsonl）と GeoJSON Text Sequence（RFC 8142・RS 0x1E 区切り）→ GeoPBF。
// 行は Feature が普通だが、FeatureCollection（展開）と素の Geometry（属性なしの Feature に包む）も受ける。壊れた行は数えて飛ばす
//（stats.badLines）。改行を含む pretty-print の GeoJSON は対象外＝json デコーダの仕事。
// 入力: Blob/File（stream で逐次・全文を 1 本の文字列に持たない）・Uint8Array/ArrayBuffer・string。
// 大きい入力（既定 500 MB 以上）は 2 パス＝keys を先に拾い、2 回目は行→setFeature を逐次（pbf-base setBodyAsync）＝全地物を同時に持たない。
import { GeoPBF } from "../pbf-base.js";
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const GEOM = new Set(["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon", "GeometryCollection"]);
const clean = s => s.replace(/[\u001e\r]/g, "").trim();   // RS（Text Sequence の区切り）と CR は落とす
function* splitLines(text) { for (const p of text.split("\n")) { const t = clean(p); if (t) yield t; } }

/** 行を逐次に返す（空行と RS・CR は落とす） */
export async function* linesOf(src) {
	if (typeof src === "string") { yield* splitLines(src); return; }
	if (src instanceof ArrayBuffer || ArrayBuffer.isView(src)) { yield* splitLines(new TextDecoder().decode(src)); return; }
	const reader = src.stream().getReader(), dec = new TextDecoder();
	let carry = "";
	for (;;) {
		const { value, done } = await reader.read();
		const text = carry + (value ? dec.decode(value, { stream: true }) : dec.decode());
		const parts = text.split("\n");
		carry = done ? "" : parts.pop();
		for (const p of parts) { const t = clean(p); if (t) yield t; }
		if (done) break;
	}
}

/** 1 行 → Feature の配列（壊れた行は stats.badLines++ で空） */
export function featuresOf(line, stats) {
	let o; try { o = JSON.parse(line); } catch { stats.badLines++; return []; }
	if (!o || typeof o !== "object") { stats.badLines++; return []; }
	if (o.type === "Feature") return [o];
	if (o.type === "FeatureCollection") return Array.isArray(o.features) ? o.features : [];
	if (GEOM.has(o.type)) return [{ type: "Feature", properties: {}, geometry: o }];
	stats.badLines++; return [];
}

const collectKeys = (f, keySet) => {   // json デコーダの 2 パス経路と同じ（入れ子 1 段は "a.b"）
	const p = f?.properties; if (!p || typeof p !== "object") return;
	for (const k in p) { keySet.add(k); const v = p[k]; if (v && typeof v === "object" && !Array.isArray(v)) for (const sk in v) keySet.add(`${k}.${sk}`); }
};

/** NDJSON / GeoJSON Text Sequence → { pbf, stats }。opts: { name, precision, description, license, attribution, twoPassBytes } */
export async function fromNdjson(src, opts = {}) {
	const t0 = now();
	const stats = { lines: 0, badLines: 0, features: 0, droppedGeometries: 0, passes: 1 };
	const size = src?.size ?? src?.byteLength ?? src?.length ?? 0;
	const meta = { name: opts.name ?? "layer", precision: opts.precision ?? 6, description: opts.description, license: opts.license, attribution: opts.attribution };
	let pbf;
	if (size < (opts.twoPassBytes ?? 500 * 1024 * 1024)) {
		const features = [];
		for await (const line of linesOf(src)) { stats.lines++; for (const f of featuresOf(line, stats)) features.push(f); }
		pbf = await new GeoPBF(meta).set({ type: "FeatureCollection", features });
	} else {
		stats.passes = 2;
		const keySet = new Set(), scratch = { badLines: 0 };
		for await (const line of linesOf(src)) for (const f of featuresOf(line, scratch)) collectKeys(f, keySet);
		pbf = new GeoPBF(meta);
		pbf.setHead([...keySet].sort(), []);
		await pbf.setBodyAsync(async () => { for await (const line of linesOf(src)) { stats.lines++; for (const f of featuresOf(line, stats)) pbf.setFeature(f); } });
		pbf.close();
		await pbf.getPosition();
	}
	stats.features = pbf.length; stats.droppedGeometries = pbf.dropped;
	stats.ms = { total: now() - t0 };
	return { pbf, stats };
}
