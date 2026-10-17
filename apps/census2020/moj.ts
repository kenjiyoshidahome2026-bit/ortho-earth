// 筆ポリゴン（法務省 登記所備付地図＝14条地図）の3段ラダー＋IDB爆速（裁定 2026-08-12：
// 「url/geojson読み込み、geopbfをidb保存。2回目から爆速」）。
//   ① bucket/moj/{code}.pbf   … gint焼き済み（現状 荒川区のみ）＝最速
//   ② bucket/moj/{code}.geojsonl … moj-batch 焼き（現状 疎）＝行パース→ブラウザ内gint焼き
//   ③ AIGID 公共座標 GeoJSON（geospatial.jp・1990市区町村）＝geopbf URL経路（proxy 経由・自動IDB）
// ①②は geopbf と同じ IDB 棚（GIS/pbf・{PBF,GINT}）へ手動 cache＝2回目はネットワーク0＋焼きゼロ。
// ③は geopbf の URL キャッシュ規約に最初から乗る（index.js:103-108）＝同じく2回目爆速。
import { geopbf } from "geopbf";
import { nativeBucket } from "native-bucket";
import MOJ_PBF from "./data/moj-pbf-manifest.json" with { type: "json" };
import MOJ_AIGID_URL from "./data/moj-geojson.json?url";   // 0.9 MB＝筆を見る時だけ取る（入口の束に入れない・2026-10-17）
import type { GeoPBF, GeopbfInput } from "geopbf";
import type { CacheFn } from "native-bucket";

/** AIGID 台帳の 1 項（data/moj-geojson.json） */
interface AigidEntry { name: string; target: string; precision?: number; size?: number }
/** 在庫ラダーの解決結果 */
export interface MojSource { kind: "pbf" | "aigid" | "jsonl"; key: string; precision?: number; size?: number }

const API = "https://api.ortho-earth.com";
const PBF_SET = new Set(MOJ_PBF.map(e => e.cityCode));
let _aigidP: Promise<Map<string, AigidEntry>> | null = null;   // name 先頭5桁＝市区町村コード → AIGID の項。取れなかった時は空＝次の呼び出しで取り直す
const aigid = () => (_aigidP ||= fetch(MOJ_AIGID_URL).then(r => { if (!r.ok) throw new Error(`${r.status}`); return r.json(); })
	.then((a: AigidEntry[]) => new Map(a.map(e => [e.name.slice(0, 5), e])))
	.catch(e => { console.warn("[moj] AIGID 台帳", e); _aigidP = null; return new Map(); }));

let _cacheP: Promise<CacheFn> | null = null;
const getCache = () => (_cacheP ||= nativeBucket(API).Cache("GIS/pbf"));

const gunzipBuf = async (buf: ArrayBuffer): Promise<ArrayBuffer> => {
	const h = new Uint8Array(buf, 0, 2);
	return (h[0] === 0x1f && h[1] === 0x8b)
		? await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer()
		: buf;
};

// 在庫 probe＝GET+即中断（bucket Worker は HEAD に 405 を返す＝HEAD probe は常に偽の轍・2026-08-12実測）
export async function probeBucket(url: string): Promise<boolean> {
	const ctl = new AbortController();
	try {
		const r = await fetch(url, { signal: ctl.signal });
		ctl.abort();   // ヘッダだけ見て本文は捨てる
		return r.ok;
	} catch { return false; }
}

// 在庫ラダーの解決。null＝未整備。
// ①bucket pbf(manifest・荒川) → ②AIGID(1990市・in-memory) → ③bucket geojsonl(疎・network probe)。
// ★AIGID を geojsonl 探りより先に見る＝共通ケース(1990市)で ②の 404 を撒かない（本人報告 2026-08-12：
// moj/01106.geojsonl 404）。疎な bucket geojsonl は AIGID に無い稀な市だけ探る。
export async function mojSource(code: string): Promise<MojSource | null> {
	if (PBF_SET.has(code)) return { kind: "pbf", key: `${API}/bucket/moj/${code}.pbf` };
	const e = (await aigid()).get(code);
	if (e) return { kind: "aigid", key: e.target, precision: e.precision || 7, size: e.size };
	if (await probeBucket(`${API}/bucket/moj/${code}.geojsonl`)) return { kind: "jsonl", key: `${API}/bucket/moj/${code}.geojsonl` };
	return null;
}

// 筆レイヤのロード → GeoPBF（unPackGint 済み）。onStatus は進捗の一行表示用
export async function loadMoj(code: string, { onStatus }: { onStatus?: (msg: string) => void } = {}): Promise<GeoPBF | null> {
	const src = await mojSource(code);
	if (!src) return null;
	const name = `moj/${code}`;
	if (src.kind === "aigid") {
		onStatus?.("AIGID 変換筆を取得中…（初回のみ・proxy 経由）");
		return await geopbf(src.key, { gint: true, name, precision: src.precision }).catch(e => { console.warn("[moj] aigid", e); return null; });
	}
	const cache = await getCache();
	const val = await cache(src.key).catch(() => null) as { PBF?: ArrayBuffer; GINT?: ArrayBuffer } | null;
	if (val?.PBF) {   // 2回目＝IDB直行（PBF+GINT 復元＝ネットワーク0・焼きゼロ）
		const pbf = await geopbf(val.PBF, { gint: false, name });
		if (val.GINT) await pbf.setGintBUF(val.GINT).catch(() => null);
		if (pbf?.unPackGint) return pbf;
		console.warn("[moj] %s: キャッシュの GintBUF が読めない（旧フォーマット）→ 再取得", code);
	}
	onStatus?.("筆データ取得中…（初回のみ）");
	const res = await fetch(src.key);
	if (!res.ok) return null;
	const raw = await gunzipBuf(await res.arrayBuffer());
	let pbf: GeoPBF | null = null;
	if (src.kind === "pbf") {
		pbf = await geopbf(raw, { gint: true, name });
	} else {
		const features: unknown[] = [];
		for (const line of new TextDecoder().decode(raw).split("\n")) {
			const s = line.trim();
			if (s) { try { features.push(JSON.parse(s)); } catch { /* 壊れ行 skip */ } }
		}
		if (!features.length) return null;
		onStatus?.(`gint 焼き中…（${features.length.toLocaleString()}筆・初回のみ）`);
		pbf = await geopbf({ type: "FeatureCollection", features } as GeopbfInput, { gint: true, name });
	}
	if (pbf?.unPackGint) {   // 次回爆速の仕込み＝geopbf と同じ棚・同じ値形（{PBF,GINT}）
		const GINT = new Uint8Array(pbf._gintBuffer!).slice().buffer;
		cache(src.key, { PBF: pbf.arrayBuffer, GINT }).catch(() => {});
	}
	return pbf?.unPackGint ? pbf : null;
}
