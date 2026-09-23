// 選択と識別の器（globe 層・LAYERS.md）：geopbf の地物を overlay に描いてクリックで identify／選択＝周辺マスク／ホバー＝線。
// 自前の結果パネル(identEl)を持つ自己完結の機能。必要な物は入口で受け、グローバルに手を伸ばさない。
// e-Stat 小地域（日本の地域パック）は 2026-09-23 に packages/jp/src/estat.js へ移った＝ここは use(ext) の口で識別と clear を委ねるだけ。
import { unproject, cameraState, buildGeoJSONOverlay, pointInFeature } from "@ortho-earth/core";
import { geopbf } from "geopbf";
import { tr } from "./i18n.js";

const t = tr();

// 選択の表現＝地物をべた塗りせず「周辺を薄く暗くして地物を浮かせる」マスク（本人裁定2026-08-14
// 「べた塗りはデータが見えにくい」）。setOverlayHi が {mask,color} を周辺マスクとして解釈する。
const HI_MASK = { mask: true, color: [0, 0, 0, 0.1] };

export function createOverlay({ renderer, cam, size, dpr, requestDraw }) {
	const identEl = document.createElement("div");
	identEl.id = "ident";   // スタイルは style.css（#map 配下に後置＝DOM順で上）
	(document.getElementById("map") || document.body).appendChild(identEl);
	// 空のままだと padding+背景が「小さな空箱」として常時見えてしまう＝中身がある時だけ表示
	const say = t => { identEl.textContent = t; identEl.style.display = t ? "block" : "none"; };
	let overlayFeatures = null, overlayOrigin = [138, 37];   // geopbf 経路（main側identify）用
	let ext = null;   // 地域パックの識別の器（e-Stat）＝{ active(), identify(lon,lat), clear() }。active の間はクリック識別を委ねる

	function eachCoord(g, cb) {
		if (!g || !g.coordinates) return;
		const walk = c => { if (typeof c[0] === "number") cb(c[0], c[1]); else c.forEach(walk); };
		walk(g.coordinates);
	}
	function bboxCenter(feats) {
		let lo0 = 180, la0 = 90, lo1 = -180, la1 = -90;
		for (const f of feats) eachCoord(f.geometry, (x, y) => { if (x < lo0) lo0 = x; if (x > lo1) lo1 = x; if (y < la0) la0 = y; if (y > la1) la1 = y; });
		return { lo0, la0, lo1, la1, center: [(lo0 + lo1) / 2, (la0 + la1) / 2] };
	}
	async function loadOverlay(name) {
		say(t("Loading geopbf: $1 …", name));
		const pbf = await geopbf(name, { gint: false }).catch(err => { console.warn("geopbf", err); return null; });
		if (!pbf || !pbf.features || !pbf.features.length) { say(t("geopbf load failed: $1", name)); return; }
		ext?.clear();   // 識別対象を geopbf 経路（main側）へ切り替え
		overlayFeatures = pbf.features;
		overlayOrigin = bboxCenter(overlayFeatures).center;
		renderer.set("overlay", buildGeoJSONOverlay(overlayFeatures, overlayOrigin));
		renderer.set("overlayHi", null);
		say(t("geopbf: $1\n$2 features — click to identify", name, overlayFeatures.length));
		requestDraw();
	}
	function identifyAt(clientX, clientY) {
		const extOn = !!ext?.active();
		if (!extOn && !overlayFeatures) return;
		const st = cameraState(cam, size.w, size.h);
		const ll = unproject(st, clientX * dpr, clientY * dpr);
		if (!ll) return;
		if (extOn) { ext.identify(ll[0], ll[1]); return; }   // 結果は地域パック側が描く
		const hit = overlayFeatures.findIndex(f => pointInFeature(ll[0], ll[1], f.geometry));
		renderer.set("overlayHi", hit >= 0 ? buildGeoJSONOverlay([overlayFeatures[hit]], overlayOrigin) : null);   // ヒット地物だけ別 stencil で強調
		if (hit >= 0) {
			const p = overlayFeatures[hit].properties || {};
			const kv = Object.entries(p).slice(0, 6).map(([k, v]) => `${k}: ${v}`).join("\n");
			say(`identify ✔ #${hit}\n${kv || "(no props)"}`);
		} else say(t("identify: no hit"));
		requestDraw();
	}
	function clearOverlay() {   // overlay 層を消す（識別対象も外す）＝派生アプリ（census2020 leaveCity）の受け口
		ext?.clear(); overlayFeatures = null;
		renderer.set("overlay", null); renderer.set("overlayHi", null); renderer.set("overlayHover", null);
		say(""); requestDraw();
	}
	// 選択地物（市区町村ポリゴン等）を「周辺マスク」で表示＝統一ルール（選択=マスク/ホバー=線）。geom=null で解除。
	// overlayHi スロットを使う＝町丁目選択マスクと同じ器（1度に1つ＝現在の選択の外を暗く）。
	function setSelectionMask(geom, opts = {}) {   // opts.color＝マスクの色と濃さ（既定＝HI_MASK の薄い黒）
		if (!geom) { renderer.set("overlayHi", null); return; }
		const feats = [{ geometry: geom }];
		// 線は描かない（lineWidth 0）＝マスク（外側の暗み）の縁だけが境界を示す。フル解像度の生線を半透明で
		// 重ねると頂点キャップが数珠（チリチリ）になる上、gint 側の境界線と二重になる（本人指摘2026-08-14）。
		// ranges:true＝feature 毎のレンジ＋外接円を同梱＝描画側の球体カリングが効く（国のような地球規模の面で
		// 裏半球の形が手前へ punch するのを断つ・2026-09-23）。小さな市区町村では実質 no-op（1 feature 分の円）。
		renderer.set("overlayHi", buildGeoJSONOverlay(feats, bboxCenter(feats).center, { lineColor: [0, 0, 0, 0], lineWidth: 0, ranges: true }), opts.color ? { mask: true, color: opts.color } : HI_MASK);
	}
	// ホバー中の地物を「線だけ」で示す＝統一ルールのもう半分（選択=マスク／ホバー=線）。overlayHover スロット（町丁目ホバーと同じ器・マスクと両立）。
	// geom=null で消す。opts.color＝[r,g,b,a]（既定＝濃い灰）・opts.width＝px。
	function setHoverOutline(geom, opts = {}) {
		if (!geom) { renderer.set("overlayHover", null); requestDraw(); return; }
		const feats = [{ geometry: geom }];
		renderer.set("overlayHover", buildGeoJSONOverlay(feats, bboxCenter(feats).center, { lineColor: opts.color || [0.2, 0.22, 0.28, 0.9], lineWidth: opts.width ?? 1.6, ranges: true }));
		requestDraw();
	}
	return { identifyAt, setSelectionMask, setHoverOutline, loadOverlay, clearOverlay, say, HI_MASK,
		use: e => { ext = e; },   // 地域パックの識別の器を差す（e-Stat）
		destroy: () => { identEl.remove(); } };
}
