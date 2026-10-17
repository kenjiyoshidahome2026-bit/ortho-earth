// USGS ANSS ComCat（FDSN Event API）の CSV → GeoPBF。Node のビルドスクリプト（apps/quakes/scripts/usgs-quakes-build.mjs）と
// cron Worker（apps/quakes-mirror/worker.js）の共有部＝通信の作法・CSV 解析・GeoPBF の組み立て。Web 標準 API だけで書く。
// 置き場＝apps/quakes（2026-10-15・旧 packages/quakes＝読むのはこのアプリの quakes-worker.ts と scripts/usgs-quakes-build.mjs だけ。
// 配る側 apps/quakes-mirror は焼いた bytes を R2 から返すだけ＝この形を知らない）。
import { GeoPBFBase } from "geopbf/pbf-base";
import type { Properties } from "geopbf/pbf-base";

export const API = "https://earthquake.usgs.gov/fdsnws/event/1";
export const LIMIT = 20000;   // FDSN Event API の 1 リクエスト上限
export const DAY = 86400000;
export const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "");

// 期間 [s, e) の CSV 行（ヘッダ抜き）を返す。まず本体を取り、上限 20,000 件に達していたら期間を二分して取り直す
//（count を毎回引かない＝リクエスト数がほぼ半分）。get(url) → 本文（204 は ""）
/** fetchRange の戻り＝CSV のヘッダ（無ければ null）と行 */
export interface CsvRange { header: string | null; rows: string[] }
export async function fetchRange(get: (url: string) => Promise<string>, s: number, e: number, minmag: number, api = API): Promise<CsvRange> {
	const q = new URLSearchParams({
		starttime: iso(s), endtime: iso(e - 1000), minmagnitude: String(minmag), eventtype: "earthquake",
		format: "csv", orderby: "time-asc", limit: String(LIMIT),
	});
	const text = await get(`${api}/query?${q}`);
	const lines = text.split("\n").filter(Boolean);
	const header = lines.shift() ?? null;
	if (lines.length >= LIMIT && e - s > 2000) {
		const m = s + Math.floor((e - s) / 2 / 1000) * 1000;
		const a = await fetchRange(get, s, m, minmag, api), b = await fetchRange(get, m, e, minmag, api);
		return { header: a.header ?? b.header ?? header, rows: a.rows.concat(b.rows) };
	}
	return { header, rows: lines };
}
export const csvText = ({ header, rows }: CsvRange) => header ? [header, ...rows].join("\n") + "\n" : "";

// ── CSV（place に "," を含む引用符付きフィールドがある）─────────────────────────
export function splitCsv(line: string) {
	const out: string[] = []; let cur = "", q = false;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (q) { if (c === '"') { if (line[i + 1] === '"') cur += '"', i++; else q = false; } else cur += c; }
		else if (c === '"') q = true;
		else if (c === ",") out.push(cur), cur = "";
		else cur += c;
	}
	out.push(cur);
	return out;
}

// 月の窓 [s, e)（ms）。e は排他
export function months(s: number, e: number) {
	const out: [number, number][] = [];
	for (let d = new Date(s); d.getTime() < e;) {
		const a = d.getTime();
		const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
		out.push([a, Math.min(next, e)]);
		d = new Date(next);
	}
	return out;
}

// CSV 群 → 列（300 万件級でもオブジェクトを作らない）。id で重複（二分・月境界）を落とし、時刻順に並べる
/** parseCsvTexts の戻り＝列（order＝時刻順の添字・X＝extra の列ごと） */
export interface CsvColumns { N: number; bad: number; order: Uint32Array; T: number[]; LON: number[]; LAT: number[]; DEP: (number | null)[]; MAG: (number | null)[]; X: (string | null)[][]; extra: string[] }
export function parseCsvTexts(texts: (string | null | undefined)[], extra: string[] = []): CsvColumns {
	const T: number[] = [], LON: number[] = [], LAT: number[] = [], DEP: (number | null)[] = [], MAG: (number | null)[] = [], X = extra.map((): (string | null)[] => []);
	const seen = new Set<string>();
	let bad = 0;
	for (const text of texts) {
		if (!text) continue;
		const lines = text.split("\n");
		const head = splitCsv(lines[0]);
		const col = (n: string) => head.indexOf(n);
		const [iT, iLat, iLon, iDep, iMag, iId] = ["time", "latitude", "longitude", "depth", "mag", "id"].map(col);
		const iX = extra.map(col);
		for (let j = 1; j < lines.length; j++) {
			if (!lines[j]) continue;
			const c = splitCsv(lines[j]);
			const id = c[iId], t = Date.parse(c[iT]), lat = +c[iLat], lon = +c[iLon];
			if (!id || !Number.isFinite(t) || !Number.isFinite(lat) || !Number.isFinite(lon) || c[iLat] === "" || c[iLon] === "") { bad++; continue; }
			if (seen.has(id)) continue;
			seen.add(id);
			T.push(t); LAT.push(lat); LON.push(lon);
			DEP.push(c[iDep] === "" ? null : Math.round(+c[iDep] * 1000) / 1000);
			MAG.push(c[iMag] === "" ? null : Math.round(+c[iMag] * 100) / 100);
			iX.forEach((ix, q) => X[q].push(ix < 0 || c[ix] === "" ? null : c[ix]));
		}
	}
	const N = T.length;
	const order = new Uint32Array(N).map((_, i) => i).sort((a, b) => T[a] - T[b]);
	return { N, bad, order, T, LON, LAT, DEP, MAG, X, extra };
}

// 列 → GeoPBF（生のバイト列）。start/end は description 用の日付文字列（YYYY-MM-DD・end は含む）
export async function buildGeoPBF({ N, order, T, LON, LAT, DEP, MAG, X, extra }: Omit<CsvColumns, "bad">, { minmag, start, end, precision = 4, name }: { minmag: number; start: string; end: string; precision?: number; name?: string }) {
	const keys = ["date", "depth", "mag", ...extra].sort();
	const pbf = new GeoPBFBase({
		name: name ?? `usgs_earthquakes_m${minmag}`,
		precision,
		description: `USGS ANSS ComCat earthquakes, M${minmag}+, ${start} to ${end}, worldwide. Point = epicenter [lon, lat]; date = origin time (UTC, second); depth = hypocenter depth (km); mag = magnitude.`,
		license: "Public domain (U.S. Geological Survey)",
		attribution: "U.S. Geological Survey, ANSS Comprehensive Earthquake Catalog (ComCat)",
	});
	pbf.setHead(keys, []);
	await pbf.setBodyAsync(async () => {   // 1 件ずつ書く＝FeatureCollection を丸ごと作らない
		for (let k = 0; k < N; k++) {
			const i = order[k];
			const properties: NonNullable<Properties> = { date: new Date(T[i]) };
			if (DEP[i] != null) properties.depth = DEP[i];
			if (MAG[i] != null) properties.mag = MAG[i];
			extra.forEach((key, q) => { if (X[q][i] != null) properties[key] = X[q][i]; });
			pbf.setFeature({ type: "Feature", geometry: { type: "Point", coordinates: [LON[i], LAT[i]] }, properties });
		}
	});
	pbf.close();
	return new Uint8Array(pbf.arrayBuffer);
}
