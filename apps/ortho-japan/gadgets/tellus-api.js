// Tellus（さくらインターネットの衛星データPF・JAXA データ）の読み口＝stac ガジェットと tellus.html（専用アプリ）が共用。
// 経路：ブラウザ → native-bucket Worker の /tellus 代理口（Bearer は Worker の secret）→ Traveler API。
// 返る署名 URL（S3 型・1 時間）は CORS が tellusxdp.com 固定なので /proxy?url= 経由で Range 読み。実測は 2026-09-16。
// 純データモジュール（DOM 無し）＝Node でも動く。

// native-bucket Worker（/tellus と /proxy）。?tellusapi=http://localhost:8787 で wrangler dev の手元 Worker へ（開発用）。
// 読み込み時に一度だけ確定＝tellus.html が共有 URL を書く時に ?tellusapi= を消しても（共有先は本番を向く）手元の配線は保つ
const API_BASE = (typeof location !== "undefined" && new URLSearchParams(location.search).get("tellusapi")) || "https://api.ortho-earth.com";
export const apiBase = () => API_BASE;

// データセット台帳（【Tellus公式】…・allow_network_type=global＝Tellus 外利用可のものだけ）。
// cloud＝雲量が properties にある（光学）＝雲量昇順／無い（SAR）＝新しい順。
// days＝既定の期間（今日から遡る日数）／period＝固定の期間（運用終了センサ）。
export const DATASETS = {
	palsar2: { key: "palsar2", label: "PALSAR-2", credit: "PALSAR-2 © JAXA / Tellus", ds: "45ff087d-be02-4788-bc4c-28cd947a1167", cloud: false, days: 3 * 365, level: "L2.2" },
	avnir2: { key: "avnir2", label: "AVNIR-2", credit: "AVNIR-2 © JAXA / Tellus", ds: "ea71ef6e-9569-49fc-be16-ba98d876fb73", cloud: true, period: ["2006-01-01", "2011-04-30"], level: "1B1" },
};

const ymd = (x) => x.toISOString().slice(0, 10);
// ソースの既定期間 [from, to]（YYYY-MM-DD）
export const defaultRange = (src) => src.period || [ymd(new Date(Date.now() - src.days * 864e5)), ymd(new Date())];

export const bboxPoly = ([w, s, e, n]) => ({ type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
// Tellus の intersects は Polygon 限定（Point は 422）＝中心点を極小四角で（「その地点が写っているシーン」の意味論は同じ）
export const pointPoly = ([lon, lat], eps = 5e-4) => bboxPoly([lon - eps, lat - eps, lon + eps, lat + eps]);

// シーン検索 → 正規形 [{id, date, sub, cloud, geometry, props}]
//   c＝[lon,lat]（無ければ bbox）・from/to＝"YYYY-MM-DD"・size は 10 以上（cursor は null でも必須＝422）
export async function searchScenes(src, { c, bbox, from, to, size = 40, signal } = {}) {
	const poly = c ? pointPoly(c) : bboxPoly(bbox);
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
	return ((await r.json()).features || []).map(it => normalize(src, it));
}

// 1 シーンの情報（共有 URL の復元用）→ 正規形
export async function getScene(src, id, { signal } = {}) {
	const r = await fetch(`${apiBase()}/tellus/datasets/${src.ds}/data/${id}/`, { signal, credentials: "omit" });
	if (!r.ok) throw new Error(`HTTP ${r.status}`);
	return normalize(src, await r.json());
}

export const orbitLabel = (p, t = (s) => s) => p["sat:orbit_state"] === "ascending" ? t("上昇") : p["sat:orbit_state"] === "descending" ? t("下降") : "";
function normalize(src, it) {
	const p = it.properties || {};
	const sub = src.cloud ? (p["tellus:name"] || "") : [p["sar:polarizations"], p["palsar2:beam"]].filter(Boolean).join(" ");
	return { id: it.id, date: (p.start_datetime || "").slice(0, 10), sub, cloud: p["eo:cloud_cover"] ?? -1, geometry: it.geometry, props: p };
}

// シーンの webcog（Tellus 表示用 COG・EPSG:4326）の署名 URL を /proxy 経由の URL にして返す（毎回新しく発行）
export async function cogUrl(src, id, { signal } = {}) {
	const r = await fetch(`${apiBase()}/tellus/webcog?dataset=${src.ds}&data=${id}`, { signal, credentials: "omit" });
	if (!r.ok) throw new Error(`HTTP ${r.status}`);
	const { download_url, name, size_bytes } = await r.json();
	return { url: `${apiBase()}/proxy?url=${encodeURIComponent(download_url)}`, name, size_bytes };
}

// 署名 URL 失効（403）で一度だけ再発行して読み直す fetch 包み。読み口（geopbf/cog/source）は常に同じ src を撃つので
// 引数 URL は無視して現在の URL へ＝差し替えが読み口に見えない。
export function renewingFetch(first, resolve) {
	let cur = first, inflight = null;
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
