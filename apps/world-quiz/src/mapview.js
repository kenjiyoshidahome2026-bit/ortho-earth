// 地図の面＝地球儀（@ortho-earth/globe・地域なしのホスト）を World の地図パネル（apps/world/src/mappane.js）と同じ作法で起こす。
//   正解の国へ寄る（spotlight＝周りを薄く覆って国の形だけ残す）／「地図 → 国名」は答える前に国を指す／「国名 → 地図」は押した所の国を当てる。
//   国の形＝エンジンが持つ Natural Earth admin_0 を ISO2 で引く（spotlight("JP")）。ISO の無い主体（B コード）は World の ne-cultural（worldlayers）の形で。
//   押した所の国＝worldlayers.query（ne-cultural base＝初回 16.5MB・以降 IDB）＝Lv.3 の地図モードを始めた時だけ読む。マウスの下の国は黄色の線で囲む（名前は出さない）。
// エンジンは一度だけ起動して使い回す。起動できない環境（WebGL 無し等）は null を返し、呼び手は地図なしで続ける。
import { countryLayers } from "world-data/src/worldlayers.js";
import { reachOf } from "./quiz.js";
const ZMAX = 7;
const engineP = () => window.__orthoEngine ? Promise.resolve(window.__orthoEngine) : import("@ortho-earth/globe");
const REGION_VIEW = { "0": [1.6, 20, 0], "3": [2.4, 32, 90], "1": [3.2, 52, 15], "2": [2.6, 2, 20], "4": [2.3, 42, -95], "5": [2.6, -18, -60], "6": [2.4, -22, 150] };   // [zoom, lat, lon]

let paneP = null;
export function createMapView(host, { lang = "en" } = {}) { return paneP ||= build(host, lang).catch(e => { console.warn("[quiz] map unavailable", e); return null; }); }

async function build(host, lang) {
	const engine = await engineP();
	const map = await engine.createGlobe({
		target: host, lang, view: "#1.6/20/0", zoomMax: ZMAX, mesh: false, chips: false, instruments: ["attr"], countryTip: false, persistView: false,
		keyboard: false,   // 矢印キーは答えの選択に使う
	});
	map.gadget.zoom(); map.gadget.compass();
	let inside = null, spot = null, token = 0, onTap = null, hovKey = null, hovAt = 0;
	let olQ = Promise.resolve();
	const line = (src, o) => (olQ = olQ.then(() => map.gadget.outline(src, o)).catch(() => null));   // 輪郭の枠は 1 つ＝ホバーと押した印を呼んだ順に当てる（後から来たホバーが赤い印を消さない）
	const layers = () => inside ||= countryLayers(map, engine.geopbf);
	const clear = ({ keepMark = false } = {}) => { spot?.clear(); spot = null; if (!keepMark) { hovKey = null; line(null); } };
	const bboxOf = c => { const r = Math.sqrt(Math.max(1, c.area || 0) / Math.PI) / 111.32 * 1.6 + 0.8; return c.coord ? [c.coord[0] - r, c.coord[1] - r, c.coord[0] + r, c.coord[1] + r] : null; };
	const flyBbox = (bb, pad = 1) => { if (!bb) return; const z = Math.min(ZMAX, map.fitZoomForBbox(bb) - Math.log2(pad)); map.flyTo((bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2, Math.max(1.2, z), 0, 0); };
	// 形＝ISO2 でエンジンから。無ければ World の形（ne-cultural）
	const shapeOf = async c => {
		if (c.iso2) { const s = await map.gadget.spotlight(c.iso2, { fit: false }); if (s) return s; }
		const sh = await layers().shape(c.key, c).catch(() => null);
		return sh ? await map.gadget.spotlight(sh.fc, { fit: false }) : null;
	};
	map.on("click", e => { if (!onTap || !e?.lngLat) return; const hit = inside?.query(e.lngLat, lang); onTap(hit?.key || null, e.lngLat); });
	// 押して当てる問のホバー＝マウスの下の国を黄色の線で囲む（押す前に「どの国を押すか」が分かる・Kenji 2026-10-12）。
	//   名前は出さない（出すと答えを探し当てられる）。指（ホバーが無い）とドラッグ中は出さない。当たりは押す時と同じ worldlayers.query。
	const HOVER = { color: [1, 0.82, 0.15, 0.95], width: 2.6 };
	const hover = async key => {
		if (key === hovKey) return; hovKey = key;
		if (!key) { line(null); return; }
		if (key.length === 2 && await line(key, HOVER)) return;
		const sh = await layers().shape(key).catch(() => null);   // ISO で引けない主体（B コード）＝World の形で
		if (hovKey === key && onTap && sh) line(sh.fc, HOVER);
	};
	host.addEventListener("pointermove", e => {
		if (!onTap || e.pointerType === "touch" || e.buttons) return;
		const now = performance.now(); if (now - hovAt < 60) return; hovAt = now;   // 16ms 毎に 12k 面を当てない
		const c = host.querySelector("canvas"); if (!c) return;
		const r = c.getBoundingClientRect(), ll = map.unprojectXY(e.clientX - r.left, e.clientY - r.top);
		hover((ll && inside?.query(ll, lang)?.key) || null);
	});
	host.addEventListener("pointerleave", () => { if (onTap) hover(null); });
	return {
		map,
		/** 正解の国へ寄って形を指す。pad＝周りをどれだけ見せるか（1＝ぴったり・大きいほど引く） */
		async focus(c, { pad = 1.6, fly = true, keepMark = false } = {}) {
			const my = ++token; clear({ keepMark });
			spot = await shapeOf(c);
			if (my !== token) return;
			if (fly) flyBbox(spot?.bbox || bboxOf(c), pad);
		},
		/** 地域の全体を見せる（国名 → 地図を押す問の前） */
		region(r) { clear(); const v = REGION_VIEW[r] || REGION_VIEW["0"]; map.flyTo(v[2], v[1], v[0], 0, 0); },
		/** 押した所の国を当てる準備（ne-cultural の base を読む）。cb(key|null)。戻り＝base が読めたか（読めなければ呼び手は選択肢の問に落とす） */
		async arm(cb) {
			await layers().shape("JP").catch(() => null);   // shape()＝base を読む口（結果は捨てる）
			if (!inside?.query([139.75, 35.68])) return false;   // 東京で当たらない＝base が無い（取得失敗・オフライン）
			onTap = cb; return true;
		},
		disarm() { onTap = null; hovKey = null; },
		/** 押した点から国の形までの画面上の距離（小さい国の押し損ねを救う）。戻り＝{ px, size } | null */
		async reach(c, lngLat) {
			const sh = await layers().shape(c.key, c).catch(() => null);
			if (!sh && !c.coord) return null;
			const [tx, ty] = map.projectLL(lngLat[0], lngLat[1]);
			return reachOf(sh?.fc, (lon, lat) => map.projectLL(lon, lat), [tx, ty], c.coord);
		},
		/** 押した所に印（赤い輪郭） */
		async mark(key, lngLat) {
			line(null);
			const c = { color: [0.95, 0.25, 0.2, 0.95], width: 2.2 };
			if (key && key.length === 2) { const r = await line(key, c); if (r) return; }
			if (key) { const sh = await layers().shape(key).catch(() => null); if (sh) { await line(sh.fc, c); return; } }
			if (lngLat) await line({ type: "Point", coordinates: lngLat }, c);
		},
		clear: () => clear(),
		resize() { map.resize?.(); },
	};
}
