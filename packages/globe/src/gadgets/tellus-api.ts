// Tellus（さくらインターネットの衛星データPF・JAXA データ）の読み口＝stac ガジェットと tellus.html（専用アプリ）が共用。
// 経路：ブラウザ → native-bucket Worker の /tellus 代理口（Bearer は Worker の secret）→ Traveler API。
// 返る署名 URL（S3 型・1 時間）は CORS が tellusxdp.com 固定なので /proxy?url= 経由で Range 読み。実測は 2026-09-16。
// 純データモジュール（DOM 無し）＝Node でも動く。

// native-bucket Worker（/tellus と /proxy）。?tellusapi=http://localhost:8787 で wrangler dev の手元 Worker へ（開発用）。
// 読み込み時に一度だけ確定＝tellus.html が共有 URL を書く時に ?tellusapi= を消しても（共有先は本番を向く）手元の配線は保つ
/** データセット（台帳の 1 項） */
export interface Dataset {
	key: string; label: string; credit: string;
	/** データセット id（API の名） */
	ds: string;
	/** 雲量が properties にある（光学） */
	cloud: boolean;
	/** 既定の期間（今日から遡る日数）／固定の期間（運用終了センサ） */
	days?: number; period?: [string, string];
	level: string;
	/** 2 偏波（HH/HV）＝偽色合成を選べる */
	pol?: boolean;
	/** 全球 1 枚（GCOM-C L3） */
	global?: boolean;
	/** 行の添え書きの固定の文言（あれば偏波・ビームを出さない） */
	sub?: string;
	/** 見せ方（geopbf/cog の openCog のオプション） */
	cog?: Record<string, unknown>;
}
/** シーン検索の正規形（props＝STAC の properties） */
export interface Scene { id: string; date: string; sub: string; cloud: number; geometry: unknown; props: Record<string, unknown> }
/** Traveler API の地物（data-search の features・data の答え） */
interface ApiItem { id: string; geometry?: unknown; properties?: Record<string, unknown> }

const API_BASE = (typeof location !== "undefined" && new URLSearchParams(location.search).get("tellusapi")) || "https://api.ortho-earth.com";
export const apiBase = () => API_BASE;

// データセット台帳（【Tellus公式】…・allow_network_type=global＝Tellus 外利用可のものだけ。一覧は GET /tellus/datasets/ で 45 件・2026-09-16）。
// cloud＝雲量が properties にある（光学）＝雲量昇順／無い（SAR・海面水温）＝新しい順。
// days＝既定の期間（今日から遡る日数）／period＝固定の期間（運用終了センサ）。
// pol＝2 偏波（HH/HV）を持つ＝偽色合成（cogOpts）を選べる。cog＝そのデータの見せ方（geopbf/cog の openCog オプション）。
// global＝全球 1 枚（GCOM-C L3）＝どこをクリックしても当たる＝「同じ場所の別日」が時間の前後だけになる。
export const DATASETS: Record<"palsar2" | "palsar" | "avnir2" | "sst", Dataset> = {
	palsar2: { key: "palsar2", label: "PALSAR-2", credit: "PALSAR-2 © JAXA / Tellus", ds: "45ff087d-be02-4788-bc4c-28cd947a1167", cloud: false, days: 3 * 365, level: "L2.2", pol: true },
	palsar: { key: "palsar", label: "PALSAR", credit: "PALSAR © JAXA/METI / Tellus", ds: "654421f9-695b-4a81-9659-735445adee88", cloud: false, period: ["2006-05-16", "2011-04-22"], level: "L2.2" },
	avnir2: { key: "avnir2", label: "AVNIR-2", credit: "AVNIR-2 © JAXA / Tellus", ds: "ea71ef6e-9569-49fc-be16-ba98d876fb73", cloud: true, period: ["2006-01-01", "2011-04-30"], level: "1B1" },
	// GCOM-C/SGLI 海面水温 8 日平均（L3・全球 8640×4320 f32 ℃・nodata −9999・上昇/下降 1 枚ずつ）。webcog は無く唯一の TIFF（COG 構造）を Worker が拾う
	sst: { key: "sst", label: "GCOM-C SST", credit: "GCOM-C/SGLI SST © JAXA / Tellus", ds: "000eb404-1f69-4735-a966-2f3115269ee3", cloud: false, days: 400, level: "L3", global: true, sub: "8-day mean", cog: { stretch: [0, 32], colormap: "thermal" } },
};

// データの見せ方（openCog オプション）。pol="gray" で PALSAR-2 も先頭バンド（HH）のグレー。
export const cogOpts = (src: { cog?: Record<string, unknown>; pol?: boolean }, { pol = "color" }: { pol?: "color" | "gray" } = {}): Record<string, unknown> => ({ ...(src.cog || {}), ...(src.pol && pol !== "gray" ? { composite: "dualpol" } : {}) });

const ymd = (x: Date) => x.toISOString().slice(0, 10);
// ソースの既定期間 [from, to]（YYYY-MM-DD）
export const defaultRange = (src: { period?: [string, string]; days?: number }): string[] => src.period || [ymd(new Date(Date.now() - src.days! * 864e5)), ymd(new Date())];

const bboxPoly = ([w, s, e, n]: number[]) => ({ type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
// Tellus の intersects は Polygon 限定（Point は 422）＝中心点を極小四角で（「その地点が写っているシーン」の意味論は同じ）
const pointPoly = ([lon, lat]: number[], eps = 5e-4) => bboxPoly([lon - eps, lat - eps, lon + eps, lat + eps]);

// シーン検索 → 正規形 [{id, date, sub, cloud, geometry, props}]
//   c＝[lon,lat]（無ければ bbox）・from/to＝"YYYY-MM-DD"・size は 10 以上（cursor は null でも必須＝422）
export async function searchScenes(src: { ds: string; cloud: boolean; sub?: string }, { c, bbox, from, to, size = 40, signal }: { c?: number[] | null; bbox?: number[] | null; from?: string; to?: string; size?: number; signal?: AbortSignal } = {}): Promise<Scene[]> {
	const poly = c ? pointPoly(c) : bboxPoly(bbox!);
	const r = await fetch(`${apiBase()}/tellus/datasets/${src.ds}/data-search/`, {
		method: "POST", headers: { "content-type": "application/json" }, signal, credentials: "omit",
		body: JSON.stringify({
			intersects: poly,
			query: { start_datetime: { gte: `${from}T00:00:00Z`, lte: `${to}T23:59:59Z` } },
			sortby: [src.cloud ? { field: "properties.eo:cloud_cover", direction: "asc" } : { field: "properties.start_datetime", direction: "desc" }],
			paginate: { size: Math.max(10, size), cursor: null },
		}),
	});
	if (!r.ok) throw new Error(`HTTP ${r.status}`);
	return ((await r.json()).features || []).map((it: ApiItem) => normalize(src, it));
}

// 1 シーンの情報（共有 URL の復元用）→ 正規形
export async function getScene(src: { ds: string; cloud: boolean; sub?: string }, id: string, { signal }: { signal?: AbortSignal } = {}): Promise<Scene> {
	const r = await fetch(`${apiBase()}/tellus/datasets/${src.ds}/data/${id}/`, { signal, credentials: "omit" });
	if (!r.ok) throw new Error(`HTTP ${r.status}`);
	return normalize(src, await r.json());
}

export const orbitLabel = (p: Record<string, unknown>, t: (s: string) => string = (s) => s) => p["sat:orbit_state"] === "ascending" ? t("asc") : p["sat:orbit_state"] === "descending" ? t("desc") : "";
function normalize(src: { cloud: boolean; sub?: string }, it: ApiItem): Scene {
	const p = it.properties || {};
	const sub = src.cloud ? (p["tellus:name"] || "") : src.sub ? "" : [p["sar:polarizations"], p["palsar2:beam"] || p["palsar:beam"]].filter(Boolean).join(" ");
	return { id: it.id, date: ((p.start_datetime || "") as string).slice(0, 10), sub: sub as string, cloud: p["eo:cloud_cover"] as number ?? -1, geometry: it.geometry, props: p };
}

// シーンの webcog（Tellus 表示用 COG・EPSG:4326）の署名 URL を /proxy 経由の URL にして返す（毎回新しく発行）
export async function cogUrl(src: { ds: string }, id: string, { signal }: { signal?: AbortSignal } = {}): Promise<{ url: string; name: string; size_bytes: number }> {
	const r = await fetch(`${apiBase()}/tellus/webcog?dataset=${src.ds}&data=${id}`, { signal, credentials: "omit" });
	if (!r.ok) throw new Error(`HTTP ${r.status}`);
	const { download_url, name, size_bytes } = await r.json();
	return { url: `${apiBase()}/proxy?url=${encodeURIComponent(download_url)}`, name, size_bytes };
}

// 署名 URL 失効（403）で一度だけ再発行して読み直す fetch 包み。読み口（geopbf/cog/source）は常に同じ src を撃つので
// 引数 URL は無視して現在の URL へ＝差し替えが読み口に見えない。
export function renewingFetch(first: string, resolve?: (() => Promise<string>) | null): (u: unknown, init?: RequestInit) => Promise<Response> {
	let cur = first, inflight: Promise<void> | null = null;
	return async (_u, init) => {
		let r = await fetch(cur, init);
		if (r.status === 403 && resolve) {
			inflight ??= resolve().then(n => { cur = n; }).finally(() => { inflight = null; });
			await inflight;
			r = await fetch(cur, init);
		}
		return r;
	};
}
