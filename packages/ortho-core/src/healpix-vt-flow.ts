// HEALPix のベクタタイルの「出し入れの流れ」（docs/design/healpix.md §6 の 4 段目の後半・2026-11-28）。
// 視点 → 選ぶ（selectHpxLOD）→ 足りない分を取る（同時の本数を絞る・要らなくなった分は止める）→ 組む（buildHpxTilePayload）→ 持つ（古い順に捨てる）→ 結合（mergeTiles）→ onScene。
// 基図の選抜・管理（tilecover.ts・tilemanager.ts）には触らない別の流れ。DOM も worker も知らない（呼び手が update を呼び、onScene を受ける）。
//   出す集合の決め方（穴も重なりも作らない）：
//     ・欲しいタイルのうち、まだ届いていない物に重なる「前に出していたタイル」は、そのまま出し続ける（親 → 子・子 → 親のどちらの切り替えでも穴を作らない）
//     ・届いた欲しいタイルは、出し続けているタイルと重ならない物だけ出す（二重に描かない）。重なる物は、相手が要らなくなった時に入れ替わる
//   重なり＝番地で見る（粗い方の番号が、細かい方の祖先）。
// まだ無い物：組み立ては呼んだスレッドで 1 枚ずつ（worker へ逃がしていない）・線に沿う注記・建物の押し出し。
import type { CameraPose } from "./camera.ts";
import { hpxId, type HpxTile } from "./healpix.ts";
import { selectHpxLOD, type SelectHpxOptions } from "./healpix-cover.ts";
import type { HpxVtSource, HpxVtIndex } from "./healpix-vt-src.ts";
import { hpxToTileFrame } from "./tilegrid.ts";
import { buildHpxTilePayload, type TilePayload } from "./tilepayload.ts";
import { mergeTiles, type MergedScene } from "./scene.ts";
import { HPX_OSM_TRIAL_STYLE } from "./healpix-vt-scene.ts";
import type { Style } from "./build.ts";
import type { DecodedTile } from "./tileformat.ts";
export { createHpxVtSource } from "./healpix-vt-src.ts";
export { hpxSceneBuffers } from "./healpix-vt-scene.ts";

export interface HpxVtFlowOptions {
	source: HpxVtSource;
	style?: Style;
	/** op の li に足す値（globe の利用者の層の帯） */
	li0?: number;
	/** 出す集合が変わるたびに呼ぶ。null＝何も出さない（遠すぎる・範囲の外） */
	onScene: (scene: MergedScene | null, info: HpxVtFlowInfo) => void;
	/** 同時に取る本数（既定 16。束の Range は no-store で引く＝HTTP/2・3 の 1 接続に同時に乗る。本番の実測で 16 本は 1 本分とほぼ同じ時間） */
	concurrency?: number;
	/** 持っておく組み立て済みタイルの上限（出している分は数えずに残す） */
	cacheMax?: number;
	/** 結合の間隔（ms）。届くたびに結合し直さない */
	mergeWait?: number;
	/** この段より粗い視点（zoom − 3 の四捨五入が目録の minOrder − coarseSlack 未満）では何も出さない */
	coarseSlack?: number;
	/** selectHpxLOD へそのまま渡す（tilePx・grid・maxTiles） */
	select?: Pick<SelectHpxOptions, "tilePx" | "grid" | "maxTiles" | "stickyRatio">;
	/** 失敗の記録（既定は黙る） */
	onError?: (e: unknown, t: HpxTile) => void;
}
export interface HpxVtFlowInfo { shown: number; wanted: number; pending: number; orders: number[] }
export interface HpxVtFlow {
	/** 視点が変わったら呼ぶ（間引きは呼び手） */
	update(cam: CameraPose, W: number, H: number): void;
	stats(): HpxVtFlowInfo & { cached: number; fetching: number; fetched: number; aborted: number; merges: number; tiles: HpxTile[] };
	destroy(): void;
}

/** a と b が重なるか（同じか、片方がもう片方の祖先） */
export function hpxOverlap(a: HpxTile, b: HpxTile): boolean {
	const [c, f] = a.order <= b.order ? [a, b] : [b, a];
	return Math.floor(f.npix / 4 ** (f.order - c.order)) === c.npix;
}

interface Entry { t: HpxTile; p: TilePayload | null }   // p＝null は「空のタイル」（取りに行った結果、無かった）

export function createHpxVtFlow({ source, style = HPX_OSM_TRIAL_STYLE, li0 = 0, onScene, concurrency = 16, cacheMax = 256, mergeWait = 120, coarseSlack = 1, select = {}, onError = () => {} }: HpxVtFlowOptions): HpxVtFlow {
	let index: HpxVtIndex | null = null, faces: Set<number> | null = null, dead = false;
	let pose: { cam: CameraPose; W: number; H: number } | null = null;
	let want: HpxTile[] = [], shown: HpxTile[] = [], sticky = new Set<number>(), center: [number, number] = [0, 0];
	const cache = new Map<number, Entry>();                 // hpxId → 組み立て済み（挿入順＝古い順）
	const inflight = new Map<number, AbortController>();
	let mergeT: ReturnType<typeof setTimeout> | 0 = 0, lastKey = "", fetched = 0, aborted = 0, merges = 0, hadScene = false;

	source.index().then(i => { index = i; faces = new Set(i.faces.map(f => f.face)); if (pose) update(pose.cam, pose.W, pose.H); }, e => onError(e, { order: -1, npix: -1 }));

	const touch = (id: number): Entry | undefined => { const e = cache.get(id); if (e) { cache.delete(id); cache.set(id, e); } return e; };
	const ready = (t: HpxTile): boolean => cache.has(hpxId(t.order, t.npix));

	function update(cam: CameraPose, W: number, H: number): void {
		if (dead) return;
		pose = { cam, W, H };
		if (!index || !faces) return;
		center = [cam.center[0], cam.center[1]];
		if (Math.round(cam.zoom - 3) < index.minOrder - coarseSlack) want = [];   // 遠すぎる＝出さない（地球全体を最小の段で埋めに行かない）
		else {
			const split = new Set<number>();
			want = selectHpxLOD(cam, W, H, { ...select, minOrder: index.minOrder, maxOrder: index.maxOrder, sticky, splitOut: split })
				.filter(t => faces!.has(Math.floor(t.npix / 4 ** t.order)));   // 束の無い面は取りに行かない
			sticky = split;
		}
		// 要らなくなった取得は止める
		const wantIds = new Set(want.map(t => hpxId(t.order, t.npix)));
		for (const [id, ac] of inflight) if (!wantIds.has(id)) { ac.abort(); inflight.delete(id); aborted++; }
		pump(); settle();
	}

	function pump(): void {
		for (const t of want) {
			if (inflight.size >= concurrency) break;
			const id = hpxId(t.order, t.npix);
			if (cache.has(id) || inflight.has(id)) continue;
			const ac = new AbortController(); inflight.set(id, ac);
			source.tile(t.order, t.npix, ac.signal).then(data => {
				if (dead || ac.signal.aborted) return;
				let p: TilePayload | null = null;
				if (!(data as { __empty?: true }).__empty) {
					p = buildHpxTilePayload(hpxToTileFrame(data as DecodedTile), t, style);
					if (li0) for (const op of p.dl.ops) op.li += li0;
				}
				cache.set(id, { t, p }); fetched++;
			}, e => { if (!ac.signal.aborted) { onError(e, t); cache.set(id, { t, p: null }); } })   // 失敗は空として持つ（同じ視点で取り直し続けない。捨てられたら次に取り直す）
				.finally(() => { if (inflight.get(id) === ac) inflight.delete(id); if (!dead) { pump(); settle(); } });
		}
	}

	/** 出す集合を決め直し、変わっていれば結合を予約する */
	function settle(): void {
		const pending = want.filter(t => !ready(t));
		const keep = shown.filter(s => ready(s) && !want.some(w => w.order === s.order && w.npix === s.npix) && pending.some(w => hpxOverlap(s, w)));
		const next = [...want.filter(t => ready(t) && !keep.some(k => hpxOverlap(k, t))), ...keep];
		for (const t of next) touch(hpxId(t.order, t.npix));
		shown = next;
		// 持ちすぎを捨てる（出している分と取得中の欲しい分は残す）
		if (cache.size > cacheMax) {
			const hold = new Set([...shown, ...want].map(t => hpxId(t.order, t.npix)));
			for (const id of cache.keys()) { if (cache.size <= cacheMax) break; if (!hold.has(id)) cache.delete(id); }
		}
		const key = shown.map(t => hpxId(t.order, t.npix)).sort((a, b) => a - b).join(",");
		if (key === lastKey) return;
		lastKey = key;
		if (!mergeT) mergeT = setTimeout(() => { mergeT = 0; if (!dead) merge(); }, mergeWait);
	}

	const info = (): HpxVtFlowInfo => ({ shown: shown.length, wanted: want.length, pending: want.filter(t => !ready(t)).length, orders: [...new Set(shown.map(t => t.order))].sort((a, b) => a - b) });

	function merge(): void {
		const list = shown.map(t => cache.get(hpxId(t.order, t.npix))).filter((e): e is Entry => !!e && !!e.p);
		if (!list.length) { if (hadScene) { hadScene = false; onScene(null, info()); } return; }
		// 結合の鍵は "z/x/y" で読まれる（子孫に覆われるタイルの線を伏せる判定）＝全部同じ z・別々の x にして「覆われない」にする（重なりは上で除いてある）
		const order = list.map((e, i) => ({ key: `0/${i}/0`, origin: e.p!.origin, bld: "no" as const })), byKey = new Map(list.map((e, i) => [`0/${i}/0`, e.p!]));
		const scene = mergeTiles(order, k => { const p = byKey.get(k); return p ? { ops: p.dl.ops, buildings: null } : null; }, { origin: center });
		merges++; hadScene = true;
		onScene(scene, info());
	}

	return {
		update,
		stats: () => ({ ...info(), cached: cache.size, fetching: inflight.size, fetched, aborted, merges, tiles: shown.slice() }),
		destroy() { dead = true; for (const ac of inflight.values()) ac.abort(); inflight.clear(); cache.clear(); if (mergeT) clearTimeout(mergeT); mergeT = 0; },
	};
}

