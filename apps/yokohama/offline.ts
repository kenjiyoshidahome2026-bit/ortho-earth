// 横浜デジタルツインを通信なしで使う（完全オフライン・本人 2026-11-12）。理由＝災害時に回線が落ちても動く・海外の人が通信なしで使える。
// 方針＝「通信が可能な場所で一気にダウンロードしてデータベースを更新」：ボタン一つで、今の機能が全部同じに動くだけの物を端末に詰める。
// 例外は Wikipedia だけ（「オフラインでは表示できません」と出す・本人 2026-11-12）。写真など主に使う物は全部詰める。
//
// 詰める物（市の外接矩形・細かい段は市の形で間引く）と置き場：
//   ① アプリとエンジン（このビルドの全ファイル＝offline.json・頁そのもの）… Cache Storage "oj-pack-yokohama"
//   ② 台帳（ortho-data/japan/yokohama 全部＝区・統計・施設・駅・バス・名所・学区・用途地域・歩く道）・避難場所・名所の写真 … 同上
//   ③ 基図（地理院ベクタ z4〜16）・④ 災害の想定 6 種（z2〜17・想定の無い枡の子は取らない）… 同上
//   ⑤ 地形（標高）… エンジンの IDB（map.prefetchTerrain）
//   ⑥ 建物 LOD1（13 区の 3D Tiles 全部）… 同上の Cache・⑦ 建物 LOD2（5 区＋橋梁）… エンジンの IDB/OPFS（map.prefetchBuildings）
// 配るのは共有の Service Worker（packages/globe/scripts/lib/sw.js）＝名前が oj-pack で始まる置き場にある URL は通信なしで返す。
// 束の版＝offline.json の build（アプリとエンジンのファイル名の要約）。通信のある起動で版が変わっていたら、変わったファイルだけ黙って詰め直す
import { CITY_BBOX, MASK_BOX, HAZARDS, LOD1_WARDS, LOD2_PREFETCH, HINAN_URL, lod1Url, inGeometry, tilesIn, tileKids, fillTpl, cityTileMask, tilesetRefs, slimTile } from "./data.ts";
import type { GlobeMap } from "@ortho-earth/globe";

export const PACK = "oj-pack-yokohama";
// 置き場は 3 つに分ける（名前はどれも oj-pack で始まる＝共有 SW がどれからでも返す）。Chrome は大きな Cache の keys() を
// 「Operation too large」で投げる（Mac 本番 2026-11-12：基図と災害の想定を詰めた所で建物の段の前に保存が止まった）＝
// 大きい置き場は数え上げない（有る無しは 1 本ずつ match）。数え上げる（古い版の掃除）のは小さいアプリの置き場だけ
/** 基図・災害の想定のタイル */
const PACK_TILES = PACK + "-tiles";
/** 建物 LOD1 の 3D Tiles */
const PACK_BLD = PACK + "-bld";
const REC_KEY = "yk-offline";
/** 段（進捗の見出しと、どこまで済んだかの記録） */
export type Stage = "app" | "data" | "map" | "hazard" | "terrain" | "bld1" | "bld2";
export const STAGES: Stage[] = ["app", "data", "map", "hazard", "terrain", "bld1", "bld2"];
/** 端末の記録（localStorage）：いつ・どの版を・どれだけ詰めたか */
export interface OfflineRec { v: 1; ts: number; build: string; bytes: number; done: boolean; stages: Partial<Record<Stage, boolean>> }
/** ビルドが書く目録（vite.config.js の offlineManifest）＝このビルドのファイル・エンジンの版とファイル・台帳のファイル */
export interface OfflineManifest { build: string; base: string; files: string[]; engine: { version: string; files: string[] }; data: string[] }
export interface Progress { stage: Stage; done: number; total: number; bytes: number; failed: number }

const BASEMAP_ZMAX = 16, HAZARD_ZMIN = 2, HAZARD_ZMAX = 17, MASK_FROM = 13;

export const readRec = (): OfflineRec | null => { try { const r = JSON.parse(localStorage.getItem(REC_KEY) || "null"); return r?.v === 1 ? r : null; } catch { return null; } };
const writeRec = (r: OfflineRec | null) => { try { if (r) localStorage.setItem(REC_KEY, JSON.stringify(r)); else localStorage.removeItem(REC_KEY); } catch { /* 書けない端末＝記録なし */ } };
const swNotify = () => { try { navigator.serviceWorker?.controller?.postMessage({ type: "oj-pack" }); } catch { /* SW 無し */ } };
export const canPack = () => typeof caches !== "undefined" && "serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost");

/** 目録（このビルドの offline.json）。通信なしなら束の中の物 */
export async function manifest(): Promise<OfflineManifest | null> {
	try { const r = await fetch(import.meta.env.BASE_URL + "offline.json", { cache: "no-cache" }); return r.ok ? await r.json() : null; } catch { return null; }
}

/** 束が使える状態か（記録があり、置き場が残っている）。ブラウザが容量の都合で置き場を消した時は記録も消す */
export async function status(): Promise<OfflineRec | null> {
	const rec = readRec(); if (!rec || !canPack()) return null;
	if (!(await caches.has(PACK).catch(() => false))) { writeRec(null); return null; }
	return rec;
}

/** 束を消す（建物と地形はエンジンの置き場＝普段の閲覧でも使う物なので残す） */
export async function remove(): Promise<void> {
	if (typeof caches !== "undefined") for (const n of await caches.keys().catch(() => [] as string[])) if (n === PACK || n.startsWith(PACK + "-")) await caches.delete(n).catch(() => false);
	writeRec(null); swNotify();
}

type Deps = { map: GlobeMap; dataBase: string; onProgress?: (p: Progress) => void; signal?: AbortSignal };
/** 1 本の取りの時間切れ（ms）＝応答も中身も。返らない 1 本で保存全体が止まらないように（Mac 本番 2026-11-12：建物の手前で 60 分止まった） */
const FETCH_MS = 60000;
/** 止める合図＋時間切れ（AbortSignal.any の無い古い端末は止める合図だけ） */
const sigOf = (d: Deps, ms = FETCH_MS): AbortSignal | undefined => {
	const t = typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(ms) : undefined;
	if (!d.signal) return t;
	return t && typeof AbortSignal.any === "function" ? AbortSignal.any([d.signal, t]) : d.signal;
};

/** URL の列を置き場へ（有る物は飛ばす＝続きから・fresh＝有っても取り直す）。404/204＝「無い」と分かる応答として残す（通信なしでも同じ答え） */
async function putAll(cache: Cache, urls: string[], stage: Stage, d: Deps, o: { fresh?: boolean; conc?: number; have?: Set<string>; opaque?: boolean; slim?: (u: string, b: ArrayBuffer) => ArrayBuffer } = {}) {
	const p: Progress = { stage, done: 0, total: urls.length, bytes: 0, failed: 0 };
	let i = 0;
	const one = async (u: string) => {
		if (!o.fresh && (o.have?.has(u) || await cache.match(u, { ignoreVary: true }))) return;   // 有る物は飛ばす（続きから）。keys() は大きな置き場で投げる＝1 本ずつ
		const sg = sigOf(d);   // 応答と中身の読みの両方に掛かる
		const get = (mode: RequestMode) => fetch(u, { mode, credentials: "omit", cache: o.fresh ? "reload" : "default", signal: sg });
		// 写真＝<img> で見せるだけ。CORS を開けていない置き場は不透明な応答のまま残す（<img> にはそれで足りる）
		const res = o.opaque ? await get("cors").catch(e => { if (d.signal?.aborted) throw e; return get("no-cors"); }) : await get("cors");
		if (res.type === "opaque") { await cache.put(u, res); return; }
		if (res.status === 206 || (!res.ok && res.status !== 404 && res.status !== 204)) { p.failed++; return; }
		if (res.ok && o.slim) {   // 詰める前に軽くする（LOD1 の画像を抜く）＝同じ URL に軽い中身を置く
			const body = o.slim(u, await res.arrayBuffer()), h = new Headers(res.headers); h.delete("content-length"); h.delete("content-encoding");
			await cache.put(u, new Response(body, { status: res.status, statusText: res.statusText, headers: h })); p.bytes += body.byteLength; return;
		}
		const b = res.ok ? (await res.clone().arrayBuffer()).byteLength : 0;
		await cache.put(u, res); p.bytes += b;
	};
	const worker = async () => { while (i < urls.length && !d.signal?.aborted) { const u = urls[i++]; try { await one(u); } catch { if (!d.signal?.aborted) p.failed++; } p.done++; if (p.done % 8 === 0 || p.done === p.total) d.onProgress?.({ ...p }); } };
	d.onProgress?.({ ...p });
	await Promise.all(Array.from({ length: Math.max(1, Math.min(o.conc ?? 8, urls.length)) }, worker));
	return p;
}

/** 災害の想定：粗い段から降り、想定のある枡（200）の子だけを取りに行く（404＝その下にも想定なし）。市の外の細かい段は取らない */
async function putHazards(cache: Cache, d: Deps, keep: (z: number, x: number, y: number) => boolean) {
	const tpls = HAZARDS.flatMap(h => h.urls);
	const p: Progress = { stage: "hazard", done: 0, total: 0, bytes: 0, failed: 0 };
	let queue: { tpl: string; t: [number, number, number] }[] = tpls.flatMap(tpl => tilesIn(CITY_BBOX, HAZARD_ZMIN).map(t => ({ tpl, t })));
	const one = async ({ tpl, t }: (typeof queue)[number]): Promise<boolean> => {   // 戻り＝想定がある（子へ降りる）
		const u = fillTpl(tpl, ...t);
		const had = await cache.match(u, { ignoreVary: true }); if (had) return had.ok;   // 有る物は飛ばす（keys() は大きな置き場で投げる＝1 本ずつ）
		const res = await fetch(u, { credentials: "omit", signal: sigOf(d) });
		if (!res.ok && res.status !== 404 && res.status !== 204) { p.failed++; return false; }
		if (res.ok) p.bytes += (await res.clone().arrayBuffer()).byteLength;
		await cache.put(u, res);
		return res.ok;
	};
	while (queue.length && !d.signal?.aborted) {   // 段ごと（z2→17）＝次の段の枚数は前の段の答えで決まる
		p.total += queue.length;
		const next: typeof queue = []; let i = 0;
		const worker = async () => { while (i < queue.length && !d.signal?.aborted) { const q = queue[i++]; try { if (await one(q) && q.t[0] < HAZARD_ZMAX) for (const k of tileKids(...q.t)) if (keep(...k)) next.push({ tpl: q.tpl, t: k }); } catch { if (!d.signal?.aborted) p.failed++; } p.done++; if (p.done % 16 === 0) d.onProgress?.({ ...p }); } };
		await Promise.all(Array.from({ length: 12 }, worker));
		queue = next;
	}
	d.onProgress?.({ ...p });
	return p;
}

/** 3D Tiles（LOD1 の 13 区）：tileset.json を辿って中身を全部。子の tileset.json は並べて取る（直列だと往復の数だけ待つ）。
 *  辿っている間も進み（読んだ tileset の数）を出す＝止まって見えない。読めなかった tileset は failed（その区は「保存できなかった物」） */
async function lod1Urls(d: Deps): Promise<{ urls: string[]; failed: number }> {
	const out = new Set<string>(), queue = LOD1_WARDS.map(w => lod1Url(w.code));
	const p: Progress = { stage: "bld1", done: 0, total: queue.length, bytes: 0, failed: 0 };
	for (const u of queue) out.add(u);
	let i = 0;
	const worker = async () => {
		while (i < queue.length && !d.signal?.aborted) {
			const u = queue[i++];
			try {
				const r = await fetch(u, { credentials: "omit", signal: sigOf(d) });
				if (!r.ok) throw new Error(String(r.status));
				const { contents, children } = tilesetRefs(await r.json(), u);
				for (const c of contents) out.add(c);
				for (const c of children) if (!out.has(c)) { out.add(c); queue.push(c); p.total++; }
			} catch (e) { if (d.signal?.aborted) return; p.failed++; console.warn("[offline] lod1 tileset", u, e); }
			p.done++; if (p.done % 8 === 0 || p.done === p.total) d.onProgress?.({ ...p });
		}
	};
	d.onProgress?.({ ...p });
	// queue は辿るほど伸びる＝先に手が空いた worker が抜けないよう、伸びが止まるまで回し直す
	while (i < queue.length && !d.signal?.aborted) await Promise.all(Array.from({ length: 8 }, worker));
	return { urls: [...out], failed: p.failed };
}

/** 一気に詰める（もう一度＝続きから・refresh＝台帳と写真を取り直す＝「データベースを更新」） */
export async function run(d: Deps, o: { refresh?: boolean } = {}): Promise<OfflineRec> {
	navigator.storage?.persist?.().catch(() => false);   // ブラウザ都合で消されないように（拒否でも動きは同じ）
	const man = await manifest(); if (!man) throw new Error("offline.json");
	const [cache, tiles, bld] = await Promise.all([PACK, PACK_TILES, PACK_BLD].map(n => caches.open(n))); swNotify();
	const prev = readRec();
	// 済んだ段は飛ばす（続きから）。アプリは版が変わったら・台帳と写真は「更新」で取り直す
	const rec: OfflineRec = { v: 1, ts: Date.now(), build: man.build, bytes: prev?.bytes ?? 0, done: false, stages: { ...(prev?.stages || {}), app: prev?.build === man.build && !!prev.stages.app, ...(o.refresh ? { data: false } : {}) } };
	const step = async (s: Stage, f: () => Promise<{ bytes?: number; failed?: number } | void>) => {
		if (d.signal?.aborted || rec.stages[s]) return;
		const r = await f(); rec.bytes += r?.bytes ?? 0;
		if (!d.signal?.aborted && !(r?.failed)) rec.stages[s] = true;
		writeRec(rec);
	};
	await step("app", () => putApp(cache, man, d));
	await step("data", async () => {
		const urls = man.data.map(f => d.dataBase + f);
		const a = await putAll(cache, [...urls, HINAN_URL], "data", d, { fresh: o.refresh, conc: 6 });
		// 名所の写真（photos.json の src）＝取った台帳から
		const ph = await (await cache.match(d.dataBase + "photos.json"))?.json().catch(() => null) as Record<string, { src: string }> | null;
		const b = ph ? await putAll(cache, Object.values(ph).map(p => p.src), "data", d, { fresh: o.refresh, conc: 4, opaque: true }) : { bytes: 0, failed: 1 };
		return { bytes: a.bytes + b.bytes, failed: a.failed + b.failed };
	});
	// 市の形（区の境）＝細かい段の篩
	const wards = await (await cache.match(d.dataBase + "wards.json"))?.json().catch(() => null) as { features: { geometry: { type: string; coordinates: unknown } }[] } | null;
	const inCity = wards ? (lon: number, lat: number) => wards.features.some(f => inGeometry(f.geometry, [lon, lat])) : () => true;
	const mask = cityTileMask(inCity, CITY_BBOX);
	const keep = (z: number, x: number, y: number) => z < MASK_FROM || mask(z, x, y);
	await step("map", async () => {
		const b = d.map.getBasemapTiles(); if (!b) return;
		const urls: string[] = [];
		// z12 までは市のまわり（覆いの外枠＝川崎・東京湾・鎌倉まで）も＝引いた眺めが通信のある時と同じ。z13 からは市の形の中だけ
		for (let z = b.minZoom; z <= BASEMAP_ZMAX; z++) for (const t of tilesIn(z < MASK_FROM ? MASK_BOX : CITY_BBOX, z)) if (keep(...t)) urls.push(fillTpl(b.template, ...t));
		return putAll(tiles, urls, "map", d, { conc: 8 });
	});
	await step("hazard", () => putHazards(tiles, d, keep));
	await step("terrain", async () => { const r = await d.map.prefetchTerrain({ bbox: CITY_BBOX, zmax: BASEMAP_ZMAX, signal: d.signal, onProgress: (done, total) => d.onProgress?.({ stage: "terrain", done, total, bytes: 0, failed: 0 }) }); return { failed: r.failed + r.empty }; });   // 横浜の標高セル（R10・R01 各 1）は必ず中身がある＝空は取れなかった
	// LOD1 は textures:false・pickable:false・単色で描く＝地物の属性（batch table＝b3dm の 6 割）と画像は使わない。抜いてから詰める（Mac 実測：13 区 2.9 GB → 約 1.2 GB）
	await step("bld1", async () => {
		const l = await lod1Urls(d); if (d.signal?.aborted) return;
		const r = await putAll(bld, l.urls, "bld1", d, { conc: 8, slim: (u, b) => /\.json(\?|$)/.test(u) ? b : slimTile(b) });
		return { bytes: r.bytes, failed: r.failed + l.failed };
	});
	await step("bld2", async () => {
		const got = await d.map.prefetchBuildings({ names: LOD2_PREFETCH, onProgress: (done, total) => d.onProgress?.({ stage: "bld2", done, total, bytes: 0, failed: 0 }) });
		return { failed: LOD2_PREFETCH.length - got.length };
	});
	rec.done = STAGES.every(s => rec.stages[s]);
	rec.ts = Date.now(); writeRec(rec); swNotify();
	return rec;
}

/** アプリとエンジンのファイル（頁そのものも）。古い版のファイルは新しい物を詰め終えてから掃く（途中で切れても束は前の版のまま揃う） */
async function putApp(cache: Cache, man: OfflineManifest, d: Deps) {
	const eng = `/globe/engine/${man.engine.version}/`;
	const want = [man.base, ...man.files.map(f => man.base + f), ...man.engine.files.map(f => eng + f)].map(u => new URL(u, location.origin).href);
	const page = new URL(man.base, location.origin).href;
	const r = await putAll(cache, want.filter(u => u !== page), "app", d, { conc: 8 });
	if (d.signal?.aborted || r.failed) return r;
	// 頁は最後に（頁が指す資産が全部揃ってから差し替える）。目録も束へ（通信なしの起動で版が分かる）
	const pg = await fetch(page, { cache: "no-cache", credentials: "omit" }); if (!pg.ok) return { ...r, failed: 1 };
	await cache.put(page, pg);
	const mf = await fetch(man.base + "offline.json", { cache: "no-cache" }); if (mf.ok) await cache.put(new URL(man.base + "offline.json", location.origin).href, mf);
	// 掃除：このビルドとこのエンジンに無い、同じオリジンのアプリ・エンジンのファイル
	const keepSet = new Set([...want, page, new URL(man.base + "offline.json", location.origin).href]);
	// 掃除は付け足し（失敗しても束は揃っている）＝この置き場が大きい時（タイルを同じ置き場に詰めていた 11/12 の版の束）keys() が投げても保存は止めない
	try { for (const k of await cache.keys()) { const u = new URL(k.url); if (u.origin === location.origin && !keepSet.has(k.url) && (u.pathname.startsWith(man.base) || u.pathname.startsWith("/globe/engine/"))) await cache.delete(k); } }
	catch (e) { console.warn("[offline] sweep skipped", e); }
	return r;
}

/** 通信のある起動で：束があり、版が変わっていたら（新しいデプロイ）アプリとエンジンだけ黙って詰め直す＝通信なしで開いた時に頁と資産が必ず揃う */
export async function syncApp(d: Deps): Promise<boolean> {
	const rec = await status(); if (!rec || !navigator.onLine) return false;
	const man = await manifest(); if (!man || man.build === rec.build) return false;
	const cache = await caches.open(PACK);
	const r = await putApp(cache, man, d);
	if (r.failed) return false;
	writeRec({ ...rec, build: man.build, stages: { ...rec.stages, app: true } }); swNotify();
	return true;
}
