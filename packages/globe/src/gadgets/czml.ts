// CZML・GPX の時刻再生の main 側（#113 段 4・2026-09-29）。読み込みの振り分け（globe.js の INTAKE の "timed" 行）から呼ばれる。
//   ・時刻付きの地物（時刻付きの線）→ 軌跡（czml-time.js の trackOf/styleOf）→ render worker の組み込みオーバーレイ czml（gadgets/czml-draw.js）へ
//   ・時計＝CZML の document の clock（区間・今・速さ・範囲）を共通の時計へ写す（#124 の setRange）。無ければ Cesium と同じく
//     データの区間（出ている区間の外枠か標本の範囲）・LOOP_STOP・速さ＝区間÷120 秒（1〜5184000）。起動時の URL の t=／s= があればそちらが勝つ（本人裁定）
//   ・押した点＝画面で近い軌跡の名前と説明（消毒）を吹き出しに（直下点に付く＝衛星のような高い物は真下）
//   ・消す＝オーバーレイを空に・写した範囲を外す
import { trackOf, styleOf, positionAt, availableAt, ecefToLlh, parseIntervals } from "../czml-time.js";
import { CLOCK_SPEEDS } from "@ortho-earth/ephem/clock";
import { sanitizeHTML } from "geopbf/sanitize";
import type { Feature } from "geopbf";
import type { LonLat, OrthoClock, OverlayHandle, Popup } from "../../globe.d.ts";
import type { CzmlStyle, CzmlTrack } from "../czml-time.d.ts";
import type { GlobeMap } from "../types/map.ts";

/** 再生している軌跡（見た目と説明つき） */
type PlayerTrack = CzmlTrack & { style: CzmlStyle; description: unknown };
/** 時計へ写す物（区間・今・速さ・範囲） */
interface ClockSpec { start: number; end: number; current: number; multiplier: number; range: Parameters<OrthoClock["setRange"]>[2] }
/** CZML・GPX の時刻再生（render worker の組み込み czml・#113） */
export interface CzmlPlayer {
	readonly tracks: CzmlTrack[];
	/** 時刻つきの地物を出す（packets＝CZML の生の packet・clock を読む）。戻り＝出した数 */
	show(features: Feature[], opts?: { packets?: unknown }): number;
	clear(): void;
	/** 時刻つきの地物か */
	isTimed(f: Feature): boolean;
	/** 出している軌跡の外接（[[w,s],[e,n]]・±180 を跨ぐ時は東へ伸ばした経度） */
	bounds(): [LonLat, LonLat] | null;
	/** 点の吹き出し（当たれば true） */
	clickAt(x: number, y: number): boolean;
	remove(): void;
}

// CZML の document の clock → { start, end, current, multiplier, range }｜null
function clockOfCzml(packets: unknown): ClockSpec | null {
	const d = Array.isArray(packets) ? packets.find(p => p?.id === "document") : null, c = d?.clock;
	if (!c) return null;
	const iv = parseIntervals(c.interval)?.[0];
	if (!iv) return null;
	const cur = Date.parse(c.currentTime);
	return { start: iv[0], end: iv[1], current: Number.isFinite(cur) ? cur : iv[0], multiplier: Number.isFinite(+c.multiplier) ? +c.multiplier : 1, range: c.range || "LOOP_STOP" };
}
// clock の無いデータ（GPX・clock の無い CZML）＝Cesium の DataSourceClock の既定と同じ組み方
function clockOfTracks(tracks: CzmlTrack[]): ClockSpec | null {
	let a = Infinity, b = -Infinity;
	for (const tr of tracks) {
		if (tr.avail) for (const [s, e] of tr.avail) { a = Math.min(a, s); b = Math.max(b, e); }
		else if (tr.t.length) { a = Math.min(a, tr.t[0]); b = Math.max(b, tr.t[tr.t.length - 1]); }
	}
	if (!(b > a)) return null;
	return { start: a, end: b, current: a, multiplier: Math.round(Math.min(Math.max((b - a) / 1000 / 120, 1), 5184000)), range: "LOOP_STOP" };
}
// 速さ（実 1 秒あたりのシミュレート秒・符号つき）→ 時計の段（離散 9 段）＝対数で最も近い段
function stepOfMultiplier(m: number) {
	if (!m) return 0;
	let best = 1, bd = Infinity;
	for (let i = 1; i < CLOCK_SPEEDS.length; i++) { const d = Math.abs(Math.log(CLOCK_SPEEDS[i].v) - Math.log(Math.abs(m))); if (d < bd) { bd = d; best = i; } }
	return Math.sign(m) * best;
}

export function createCzmlPlayer({ map, keepUrlClock = () => false }: { map: GlobeMap; keepUrlClock?: () => boolean }): CzmlPlayer {
	let ov: OverlayHandle | null = null, tracks: PlayerTrack[] = [], ranged = false, popup: Popup | null = null;
	const self: CzmlPlayer = {
		get tracks() { return tracks; },
		// features＝geopbf の地物（時刻付き以外は無視）・packets＝CZML の生のパケット（clock を読む・GPX は null）。戻り＝軌跡の数
		show(features, { packets = null } = {}) {
			const list: PlayerTrack[] = [];
			for (const f of features) { const tr = trackOf(f); if (tr) list.push({ ...tr, style: styleOf(f), description: f.properties?.description ?? null }); }
			tracks = list;
			if (!list.length) { self.clear(); return 0; }
			ov ??= map.overlay({ builtin: "czml" }, { name: "czml" });
			ov.post({ type: "tracks", tracks: list.map(({ description, ...tr }) => tr) });   // 説明は main に残す（吹き出し用）
			const ck = clockOfCzml(packets) || clockOfTracks(list);
			if (ck) {
				map.clock.setRange(ck.start, ck.end, ck.range);
				ranged = true;
				if (!keepUrlClock()) map.clock.setTime(ck.current).setStep(stepOfMultiplier(ck.multiplier));
			}
			return list.length;
		},
		clear() {
			popup?.remove(); popup = null;
			if (ov) ov.post({ type: "clear" });
			tracks = [];
			if (ranged) { map.clock.clearRange(); ranged = false; }
		},
		// 押した点（CSS px）に近い軌跡（12px 以内・手前）＝名前と説明の吹き出し。当たれば true（地面の識別はしない）
		clickAt(x, y) {
			if (!tracks.length) return false;
			const ms = map.clock.time, pj = map.makeProjectorH({ terrain: false });
			let best: { tr: PlayerTrack; lon: number; lat: number } | null = null, bd = 144;
			for (const tr of tracks) {
				if (!availableAt(tr, ms)) continue;
				const q = positionAt(tr, ms); if (!q) continue;
				const [lon, lat, h] = ecefToLlh(q[0], q[1], q[2]), [sx, sy, f] = pj(lon, lat, h);
				if (!(f > 0)) continue;
				const d = (sx - x) ** 2 + (sy - y) ** 2;
				if (d < bd) { bd = d; best = { tr, lon, lat }; }
			}
			if (!best) return false;
			const esc = (s: unknown) => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" } as Record<string, string>)[c]);
			const name = best.tr.name ?? best.tr.id ?? "", desc = best.tr.description;
			popup?.remove();
			popup = new map.Popup({ closeButton: true }).setLngLat([best.lon, best.lat]).setHTML(`<b>${esc(name)}</b>${desc ? `<div>${sanitizeHTML(String(desc))}</div>` : ""}`).addTo(map);
			return true;
		},
		isTimed: f => trackOf(f) != null,
		// 今の軌跡の外接（[[w,s],[e,n]]・標本の経緯度）｜null。±180 を跨ぐ時は経度を東へ伸ばした形（fitBounds が受ける）
		bounds() {
			const lons: number[] = [], lats: number[] = [];
			for (const tr of tracks) for (let i = 0; i < tr.t.length; i++) { const q = positionAt(tr, tr.t[i]); if (!q) continue; const [lon, lat] = ecefToLlh(q[0], q[1], q[2]); lons.push(lon); lats.push(lat); }
			if (!lons.length) return null;
			let w = Math.min(...lons), e = Math.max(...lons);
			if (e - w > 180) { const east = lons.map(v => v < 0 ? v + 360 : v); w = Math.min(...east); e = Math.max(...east); }   // 日付変更線を跨ぐ＝東回りの外接
			return [[w, Math.min(...lats)], [e, Math.max(...lats)]];
		},
		remove() { self.clear(); ov?.remove(); ov = null; },
	};
	return self;
}
