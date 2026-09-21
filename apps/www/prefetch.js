// デモ（/japan/）の初回に要る世界データを、トップの背後で IDB に先に入れておく。
// 同じオリジン＝IDB 共有・同じライブラリ（geopbf / altpbf）・同じ名前で読む＝同じ鍵で入る＝/japan/ は取りに行かずに IDB から立つ。
// 対象＝/japan/ が起動直後に読む物（国境・湖・海面下の陸・恒星・全球標高アトラス）。合計 約 6.7MB（10m 版）。
// 名前と 10m/50m の出し分けはエンジンと同じ（gint/layers.js loadAdmin0・app.js loadLakes/loadBelowSea・sky/theater.js・terrain.js prefetchWorld）。
// 見送る条件＝データ節約（Save-Data）・遅い回線（2g/3g 相当）。トップだけ見て帰る人に数 MB を払わせない。
import { lowMem } from "../ortho-japan/boot/tier.js";

const API = "https://api.ortho-earth.com";

export function shouldPrefetch(nav = navigator) {
	const c = nav.connection;
	if (c?.saveData) return false;
	if (c?.effectiveType && /(^|-)2g$|^3g$/.test(c.effectiveType)) return false;
	return true;
}

export async function prefetchJapanWorld() {
	const t0 = performance.now();
	const RES = lowMem(navigator) ? "50m" : "10m";   // エンジンの LOW_MEM と同じ判定＝省メモリ端末は 50m 版を読む
	const [{ createGeopbf }, { nativeBucket }, { createTileLoader, WORLD_ATLAS }] = await Promise.all([
		import("geopbf"), import("native-bucket"), import("altpbf/loader"),
	]);
	const geopbf = createGeopbf(API, { bucket: nativeBucket });
	// 1 本ずつ（回線を一度に塞がない・背景の地球やカードの画像と取り合わない）
	const jobs = [
		() => geopbf(`ne_${RES}_admin_0_countries`),
		() => geopbf(`ne_${RES}_lakes`, { gint: false }),
		() => geopbf("below_sea_land", { gint: false }),
		() => geopbf("stars.6", { gint: false }),
		() => createTileLoader({ apiUrl: API }).then(load => load.byName(WORLD_ATLAS)),
	];
	let ok = 0;
	for (const job of jobs) {
		try { const r = await job(); if (r) ok++; r?.destroy?.(); } catch (e) { console.warn("[prefetch]", e?.message ?? e); }
	}
	console.info(`[prefetch] world data for /japan/ warmed: ${ok}/${jobs.length} (${Math.round(performance.now() - t0)} ms, ${RES})`);
}
