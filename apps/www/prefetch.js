// システムがほぼ必ず使う世界データを、トップ（www）の背後で IDB に先に入れておく。
// 同じオリジン＝IDB 共有・同じライブラリ（geopbf / altpbf）・同じ鍵で入れる＝各アプリ（/japan/・/equal/・/world/…）は取りに行かずに IDB から立つ。
//
// 二段（2026-09-24 本人裁定「ne-cultural-base は全アプリの前提＝R90 と同じ格」）：
//   1 段目（必ず）＝起動直後に誰かが必ず読む物。全球標高アトラス（R90 の焼き直し）・ne-cultural-base（admin1＋都市）・
//                   国境 50m（japan 系の起動）・湖・海面下の陸・恒星・ミニ地球儀の陸・河川・海洋境界（河川/海洋境界は省メモリ端末では読まない＝エンジンと同じ）
//   2 段目（余裕がある時だけ）＝寄った時にだけ読む重い物。ne-cultural-detail（道路・鉄道・市街地）・国境 10m（japan の z≥7）
//
// 鍵と gint の有無は消費者と一致させること（ずれると「先読みしたのに使われない」＝9/22 に国境が 50m 先行へ変わって 10m だけ先読みしていた実例）：
//   ・ne_*_admin_0_countries … packages/globe/src/gint/layers.js loadAdmin0（起動 50m → z≥7 で 10m・gint あり）
//   ・ne_10m_lakes …………… globe.js loadLakes（gint:false）と equal layers.js（gint あり）＝gint ありで入れれば両方が IDB から即立つ
//   ・ne_50m_lakes …………… globe.js loadLakes の省メモリ版（gint:false）
//   ・below_sea_land ………… globe.js loadBelowSea（gint:false）
//   ・stars.6 ……………………… globe sky/theater.js・solar（gint:false）
//   ・ne_110m_land …………… globe gadgets/globe.js＝ミニ地球儀（gint:false）
//   ・ne_10m_rivers_… / maritime … gint/layers.js loadWorldLines（LOW_MEM は読まない）と equal layers.js（どちらも gint あり）
//   ・ne-cultural-{base,detail} … equal.js getCultural・world worldlayers.js fetchGroup（URL が鍵・name 付き・gint あり）
//   ・WORLD1024_1 ……………… ortho-core terrain.js・equal hypso.js（altpbf loadTile.byName＝IDB GIS/alt）
//
// 既に IDB にある物は取りに行かない・解かない（鍵の有無だけ見る）＝二度目以降の www は通信も CPU も払わない。
// 版の更新は各アプリ自身の読み込み（ETag の裏確認）に任せる。
// 見送る条件＝データ節約（Save-Data）・遅い回線（2g/3g 相当）。デモを iframe で開いている間は止める（同じ物を二重に落とさない・回線を取り合わない）。
import { lowMem } from "@ortho-earth/globe/boot/tier.js";   // 地球儀のホストの公開面（S4 2026-09-23）＝エンジンと同じ省メモリ判定

export const API = "https://api.ortho-earth.com";
const CULTURAL = g => `${API}/bucket/GIS/world/ne-cultural-${g}.geopbf`;
const WORLD_ATLAS_KEY = "WORLD1024_1";   // altpbf WORLD_ATLAS と同値（import すると 1 段目の前に altpbf を読む＝plan は純関数に保つ）
const MB = 1 << 20;
const TIER2_FREE = 512 * MB;   // 2 段目＝保存領域の空きがこれ未満なら見送る（ne-cultural-detail は十数 MB・GINT 込みでその倍）

export function shouldPrefetch(nav = navigator) {
	const c = nav.connection;
	if (c?.saveData) return false;
	if (c?.effectiveType && /(^|-)2g$|^3g$/.test(c.effectiveType)) return false;
	return true;
}

// 先読みの一覧（純関数＝tests/t-prefetch.mjs）。
//   job＝{ id, store:"pbf"|"alt", key（IDB の鍵）, gint（GINT まで要るか）, kind:"bucket"|"url"|"atlas", name?, opts? }
//   free＝保存領域の空き（bytes・不明は null＝2 段目は見送り）
export function planPrefetch({ low = false, effectiveType = null, free = null } = {}) {
	const pbf = (id, key, gint = true, extra = {}) => ({ id, store: "pbf", key, gint, kind: "bucket", name: key, opts: gint ? {} : { gint: false }, ...extra });
	const url = (id, g) => ({ id, store: "pbf", key: CULTURAL(g), gint: true, kind: "url", name: CULTURAL(g), opts: { name: `ne-cultural-${g}.geopbf` } });
	const tier1 = [
		pbf("admin0-50m", "ne_50m_admin_0_countries"),   // 小さい・japan 系は起動で必ず読む＝最初に
		{ id: "world-atlas", store: "alt", key: WORLD_ATLAS_KEY, gint: false, kind: "atlas" },
		url("cultural-base", "base"),
		low ? pbf("lakes-50m", "ne_50m_lakes", false) : pbf("lakes-10m", "ne_10m_lakes"),
		pbf("below-sea", "below_sea_land", false),
		pbf("stars", "stars.6", false),
		pbf("minimap-land", "ne_110m_land", false),   // ミニ地球儀（gadgets/globe.js）＝japan 系の起動で読む・小さい
		...(low ? [] : [
			pbf("rivers", "ne_10m_rivers_lake_centerlines"),
			pbf("maritime", "ne_10m_admin_0_boundary_lines_maritime_indicator"),
		]),
	];
	const roomy = free != null && free >= TIER2_FREE;
	const fast = !effectiveType || effectiveType === "4g";   // 不明（Safari/Firefox）は速い扱い＝空きと省メモリで絞る
	const tier2 = !low && fast && roomy ? [
		url("cultural-detail", "detail"),
		pbf("admin0-10m", "ne_10m_admin_0_countries"),
	] : [];
	return { tier1, tier2, tier2Skipped: tier2.length ? null : low ? "lowMem" : !fast ? "slow" : "storage" };
}

// IDB に既にあるか（鍵の有無＝値は読まない。GINT が要る物だけ値を読んで GINT の有無を見る）
async function presence(Cache) {
	const stores = {};
	const open = async s => stores[s] ??= await Cache(`GIS/${s}`).catch(() => null);
	return async job => {
		const c = await open(job.store); if (!c) return false;
		const keys = (stores[job.store + ":keys"] ??= new Set(await c().catch(() => []) || []));
		if (!keys.has(job.key)) return false;
		if (!job.gint) return true;
		const v = await c(job.key).catch(() => null);
		return !!(v?.PBF && v.GINT);
	};
}

// デモの iframe が開いている間（body.in-demo＝main.js showDemo）は次の仕事へ進まない
const waitNoDemo = () => !document.body.classList.contains("in-demo") ? Promise.resolve() : new Promise(res => {
	const mo = new MutationObserver(() => { if (!document.body.classList.contains("in-demo")) { mo.disconnect(); res(); } });
	mo.observe(document.body, { attributes: true, attributeFilter: ["class"] });
});

export async function prefetchWorldData(nav = navigator) {
	const t0 = performance.now();
	const low = lowMem(nav);
	const est = await nav.storage?.estimate?.().catch(() => null);
	const free = est?.quota != null ? est.quota - (est.usage ?? 0) : null;
	const plan = planPrefetch({ low, effectiveType: nav.connection?.effectiveType ?? null, free });
	const [{ createGeopbf }, { nativeBucket, Cache }, { createTileLoader }] = await Promise.all([
		import("geopbf"), import("native-bucket"), import("altpbf/loader"),
	]);
	const geopbf = createGeopbf(API, { bucket: nativeBucket });
	const has = await presence(Cache);
	let loadTile = null;
	const run = async job => {
		if (job.kind === "atlas") {
			loadTile ??= await createTileLoader({ apiUrl: API });
			const a = await loadTile.byName(job.key);
			return a?.data?.byteLength ?? 0;
		}
		const pbf = await geopbf(job.name, job.opts);
		const n = pbf?.size ?? 0; pbf?.destroy?.();
		return n;
	};
	const log = [];
	// 1 本ずつ（回線を一度に塞がない・背景の地球やカードの画像と取り合わない）
	for (const [tier, jobs] of [[1, plan.tier1], [2, plan.tier2]]) {
		for (const job of jobs) {
			await waitNoDemo();
			const t = performance.now();
			try {
				if (await has(job)) { log.push({ tier, id: job.id, state: "cached" }); continue; }
				const bytes = await run(job);
				log.push({ tier, id: job.id, state: bytes ? "fetched" : "empty", MB: +(bytes / MB).toFixed(2), ms: Math.round(performance.now() - t) });
			} catch (e) {
				log.push({ tier, id: job.id, state: "failed", error: String(e?.message ?? e) });
			}
		}
	}
	const n = s => log.filter(r => r.state === s).length;
	console.info(`[prefetch] world data: ${n("fetched")} fetched, ${n("cached")} already cached, ${n("failed") + n("empty")} failed` +
		` (${Math.round(performance.now() - t0)} ms, ${low ? "lowMem" : "full"}${plan.tier2Skipped ? `, tier 2 skipped: ${plan.tier2Skipped}` : ""})`);
	console.table?.(log);
	return log;
}
