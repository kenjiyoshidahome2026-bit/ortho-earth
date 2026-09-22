// 地図パネル＝カードの地図ボタン（world の on("map") 合図）の受け口。**殻の持ち物**であって部品の中身ではない
// （world.js は「地図の実体は持たない＝外へ合図だけ」＝相手が地図でなくても成り立つ設計・2026-09-12 の裁定）。
// ここが ortho-earth のエンジン（ortho-japan の SDK 配布物）を遅延 import して、その国を **スポットライト**で指す
// ＝周りを薄い黒で覆い、国の形だけ素の地図を残す（本人 2026-09-23）。
// エンジンは一度だけ起動して使い回す＝2 か国目からは spotlight を差し替えるだけ（起動のやり直しをしない）。
// エンジンは world 自身の束に焼く（本人裁定 2026-09-23「A 一択」）：dev も本番もソース直＝build 時にワークスペースの
// ortho-japan/app.js ごと束なる（地図ボタンを押した時だけ読む遅延チャンク）。旧＝本番だけ /japan/lib/ の SDK を実行時に食い、
// japan を出さないと進めず・出すと全消費者が同時に変わった。window.__orthoEngine＝検定の注入口（偽エンジン）。
import { countryLayers } from "./worldlayers.js";
const ZMAX = 8;   // この地図のズーム上限＝世界データ（NE 10m・ハイプソ）が持つ所まで（本人裁定 2026-09-23）
const engineP = () => window.__orthoEngine ? Promise.resolve(window.__orthoEngine) : import("../../ortho-japan/app.js");

let paneP = null;

/** 地図パネルを開いてその国を指す。初回だけエンジンを起動する（枠は先に見せる＝待ち時間が黒画面にならない） */
export function showMap(sign = {}, { lang = "en", nation = null } = {}) {
	return (paneP ||= build({ lang, nation })).then(p => p.show(sign));
}

async function build({ lang, nation }) {
	const pane = document.body.appendChild(Object.assign(document.createElement("div"), { id: "world-map" }));
	pane.innerHTML = `<div class="bar"><span class="title"></span><button type="button" class="close" aria-label="Close">✕</button></div><div class="host"></div>`;
	const title = pane.querySelector(".title"), host = pane.querySelector(".host");
	let open = true, spot = null, inside = null, pending = null, pendTimer = 0, lastKey = null;   // 起動中も開いている扱い＝閉じられたら片付ける（inside は起動後に入る＝早い close でも TDZ にしない）
	const hide = () => { open = false; pending = null; clearTimeout(pendTimer); pane.classList.add("hidden"); spot?.clear(); spot = null; inside?.clear(); };
	pane.querySelector(".close").addEventListener("click", hide);
	window.addEventListener("keydown", e => { if (e.key === "Escape" && open) { e.stopPropagation(); hide(); } }, true);

	const engine = await engineP();
	const map = await engine.default({
		target: host,
		lang,                      // 一覧と同じ言語で（エンジンの言語は起動時に決まる＝map.lang は読み取り専用）
		view: "#1.6/20/0",         // 世界ビューから始めて、指された国へ飛ぶ＝「どこの国か」が動きで分かる
		region: [],                // 地域の申告なし＝globe 仕様（日本の基図・標高・出典・POI・鉄道が来ない。本人裁定 2026-09-23）
		zoomMax: ZMAX,             // 世界データが在る所まで＝ここまでハイプソ（陸の段彩）と湖と罫線で描く
		mesh: false,               // 建物3D＝国の形を見る用には要らない（カタログも worker も起こさない）
		chips: false,              // 層チップは出さない
		instruments: ["attr", "scale"],   // 出典（Natural Earth・GEBCO・Beck et al.）は残す＝データの礼儀
		countryTip: false,         // 一覧側の tip と混ぜない
		persistView: false,        // /japan/ の「前回の視点」を上書きしない（localStorage はオリジン単位）
		keyboard: () => open,      // 矢印キーは地図を開いている間だけ（一覧の操作を奪わない）
		assetBase: __JAPAN_ASSETS__,   // 実行時アセットは ortho-japan の public が正本（本番 /japan/・dev は /@fs で直読み）
	});
	map.gadget.zoom(); map.gadget.compass(); map.gadget.shot();
	inside = countryLayers(map, engine.geopbf);   // その国の州境・道路・鉄道・市街地（ne-cultural＝equal と同じ 2 本）
	// tip＝自国は州の名前・他国は国の名前（本人 2026-09-23）。当たりは base の面を JS で引く＝描画の絞りに依らない
	const tip = map.gadget.tip();
	const cv = () => host.querySelector("canvas");
	let hovAt = 0, hovUnit = null;
	host.addEventListener("pointermove", e => {
		const now = performance.now(); if (now - hovAt < 60) return; hovAt = now;   // 16ms 毎に 12k 面を当てない
		const c = cv(); if (!c || !open) return;
		const r = c.getBoundingClientRect(), ll = map.unprojectXY(e.clientX - r.left, e.clientY - r.top);
		const hit = ll && inside?.query(ll, lang);
		const text = !hit ? null : hit.key === lastKey ? (hit.admin1 || null) : (nation?.(hit.key)?.label || nation?.(hit.key)?.name || null);
		tip(text ? [text] : null);
		// hover＝線だけ（自国＝その州の輪郭・他国＝その国の輪郭）。同じ単位の上では作り直さない
		const unit = !hit ? null : hit.key === lastKey ? (hit.layer === "admin_1" ? "f" + hit.fid : null) : "k" + hit.key;
		if (unit === hovUnit) return; hovUnit = unit;
		if (!unit) { map.gadget.outline(null); return; }
		const OTHER = { color: [0.96, 0.96, 0.98, 0.85], width: 1.4 };   // 他国はマスクの暗みの上＝明るい線で読ませる（自国の州は既定の濃い線）
		if (unit[0] === "f") map.gadget.outline(inside.geometry(hit.fid));
		else map.gadget.outline(hit.key, OTHER).then(r => { if (!r && hovUnit === unit) inside.shape(hit.key).then(sh => hovUnit === unit && sh && map.gadget.outline(sh.fc, OTHER)); });   // ISO で引けない主体（B コード）＝world の形で
	});
	host.addEventListener("pointerleave", () => { tip(null); hovUnit = null; map.gadget.outline(null); });
	// 他国をクリック＝その国へ移る（一覧の合図と同じ形で show）
	map.on("click", e => {
		const hit = e?.lngLat && inside?.query(e.lngLat, lang);
		if (!hit?.key || hit.key === lastKey) return;
		const n = nation?.(hit.key); if (n) { tip(null); hovUnit = null; map.gadget.outline(null); show(n); }
	});
	if (import.meta.env.DEV) window.__worldPane = { map, query: ll => inside?.query(ll, lang), key: () => lastKey };   // dev の検分窓（本番束には入らない）
	const runPending = () => { const k = pending; pending = null; clearTimeout(pendTimer); if (!k || !open) return;
		inside.show(k).catch(e => console.warn("[world] 国の中身", e));
		inside.labels(k, lang).catch(e => console.warn("[world] 都市名", e)); };
	map.on("settle", runPending);   // カメラ静止の合図（飛行が終わった）

	const show = async (sign = {}) => {
		const wasHidden = pane.classList.contains("hidden");
		open = true; pane.classList.remove("hidden");
		title.textContent = sign.label || sign.name || sign.iso2 || sign.key || "";   // label＝一覧の言語の名前（日本）・name＝英語
		lastKey = sign.key || null;
		// 閉じている間は display:none＝canvas は 0×0。開いた直後に飛ばすとリサイズと飛行が競り合って視点が動かない
		// （二か国目で実測 2026-09-23）＝レイアウトとリサイズが一巡してから寄る
		if (wasHidden) await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
		// 国の形も寄り先も **world のデータ**から（本人 2026-09-23「world の DB に全てある・ISO で対応が取れる」）：
		//   形＝ne-cultural の admin_1 を key で束ねたもの／寄り先＝NationDB の coord・area で飛び地を外した矩形。
		// エンジンには「この形を指せ」とだけ言う（国の身分はエンジンの関知するところではない）。
		const sh = await inside.shape(sign.key, sign.nation || {});
		if (!sh) { console.warn("[world] 形が無い", sign.key); return; }   // 形を持たない項目＝地図は世界のまま
		if (!open || sign.key !== lastKey) return;   // 待っている間に閉じた／別の国が押された
		spot = await map.gadget.spotlight(sh.fc, { fit: false });
		// 寄り先＝形の矩形。形が本体から遠い物しか無い時は NationDB の coord と area で矩形を作る（＝必ず寄る）
		const n = sign.nation || {}, r = Math.sqrt(Math.max(1, n.area || 0) / Math.PI) / 111.32;
		const bb = sh.bbox || (n.coord ? [n.coord[0] - r, n.coord[1] - r, n.coord[0] + r, n.coord[1] + r] : null);
		if (bb) map.flyTo((bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2, Math.min(ZMAX, map.fitZoomForBbox(bb)), 0, 0);   // 余白は fitZoomForBbox 自身が持つ（画面の 85%）
		pending = sign.key || null;
		clearTimeout(pendTimer); pendTimer = setTimeout(runPending, 4000);
	};
	return { show, hide };
}
