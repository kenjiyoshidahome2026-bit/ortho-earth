// CZML・GPX の時刻再生の main 側（#113 段 4・2026-09-29）。読み込みの振り分け（globe.js の INTAKE の "timed" 行）から呼ばれる。
//   ・時刻付きの地物（時刻付きの線）→ 軌跡（czml-time.js の trackOf/styleOf）→ render worker の組み込みオーバーレイ czml（gadgets/czml-draw.js）へ
//   ・時計＝CZML の document の clock（区間・今・速さ・範囲）を共通の時計へ写す（#124 の setRange）。無ければ Cesium と同じく
//     データの区間（出ている区間の外枠か標本の範囲）・LOOP_STOP・速さ＝区間÷120 秒（1〜5184000）。起動時の URL の t=／s= があればそちらが勝つ（本人裁定）
//   ・押した点＝画面で近い軌跡の名前と説明（消毒）を吹き出しに（直下点に付く＝衛星のような高い物は真下）
//   ・消す＝オーバーレイを空に・写した範囲を外す
import { trackOf, styleOf, positionAt, availableAt, ecefToLlh, parseIntervals } from "../czml-time.js";
import { CLOCK_SPEEDS } from "@ortho-earth/ephem/clock";
import { sanitizeHTML } from "geopbf/sanitize";

// CZML の document の clock → { start, end, current, multiplier, range }｜null
export function clockOfCzml(packets) {
	const d = Array.isArray(packets) ? packets.find(p => p?.id === "document") : null, c = d?.clock;
	if (!c) return null;
	const iv = parseIntervals(c.interval)?.[0];
	if (!iv) return null;
	const cur = Date.parse(c.currentTime);
	return { start: iv[0], end: iv[1], current: Number.isFinite(cur) ? cur : iv[0], multiplier: Number.isFinite(+c.multiplier) ? +c.multiplier : 1, range: c.range || "LOOP_STOP" };
}
// clock の無いデータ（GPX・clock の無い CZML）＝Cesium の DataSourceClock の既定と同じ組み方
export function clockOfTracks(tracks) {
	let a = Infinity, b = -Infinity;
	for (const tr of tracks) {
		if (tr.avail) for (const [s, e] of tr.avail) { a = Math.min(a, s); b = Math.max(b, e); }
		else if (tr.t.length) { a = Math.min(a, tr.t[0]); b = Math.max(b, tr.t[tr.t.length - 1]); }
	}
	if (!(b > a)) return null;
	return { start: a, end: b, current: a, multiplier: Math.round(Math.min(Math.max((b - a) / 1000 / 120, 1), 5184000)), range: "LOOP_STOP" };
}
// 速さ（実 1 秒あたりのシミュレート秒・符号つき）→ 時計の段（離散 9 段）＝対数で最も近い段
export function stepOfMultiplier(m) {
	if (!m) return 0;
	let best = 1, bd = Infinity;
	for (let i = 1; i < CLOCK_SPEEDS.length; i++) { const d = Math.abs(Math.log(CLOCK_SPEEDS[i].v) - Math.log(Math.abs(m))); if (d < bd) { bd = d; best = i; } }
	return Math.sign(m) * best;
}

export function createCzmlPlayer({ map, keepUrlClock = () => false }) {
	let ov = null, tracks = [], ranged = false, popup = null;
	const self = {
		get tracks() { return tracks; },
		// features＝geopbf の地物（時刻付き以外は無視）・packets＝CZML の生のパケット（clock を読む・GPX は null）。戻り＝軌跡の数
		show(features, { packets = null } = {}) {
			const list = [];
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
			let best = null, bd = 144;
			for (const tr of tracks) {
				if (!availableAt(tr, ms)) continue;
				const q = positionAt(tr, ms); if (!q) continue;
				const [lon, lat, h] = ecefToLlh(q[0], q[1], q[2]), [sx, sy, f] = pj(lon, lat, h);
				if (!(f > 0)) continue;
				const d = (sx - x) ** 2 + (sy - y) ** 2;
				if (d < bd) { bd = d; best = { tr, lon, lat }; }
			}
			if (!best) return false;
			const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
			const name = best.tr.name ?? best.tr.id ?? "", desc = best.tr.description;
			popup?.remove();
			popup = new map.Popup({ closeButton: true }).setLngLat([best.lon, best.lat]).setHTML(`<b>${esc(name)}</b>${desc ? `<div>${sanitizeHTML(String(desc))}</div>` : ""}`).addTo(map);
			return true;
		},
		isTimed: f => trackOf(f) != null,
		// 今の軌跡の外接（[[w,s],[e,n]]・標本の経緯度）｜null。±180 を跨ぐ時は経度を東へ伸ばした形（fitBounds が受ける）
		bounds() {
			const lons = [], lats = [];
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
