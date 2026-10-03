// ガジェット：全球図（ortho-equal・Equal Earth）への口。34px 規格のアイコン（solar と同じ型・2026-09-20）。
// map.gadget.equal() で搭載（v1 ortho-map の gadget 作法＝this が map）。押すと Equal Earth を地図の上に重ねる。
// 繋ぎ方（本人 9/20「この方式で japan と equal を繋ぐ」「遷移の時間は準備時間」）：
//   equal は morph と #z/lat/lon を受けると、japan と同じ透視カメラ（チルト 0）の球のフレームから Equal Earth へ開く＝
//   球は japan の今の視点と 0 px で一致（実測）。ページは移らず地図の上に重ねる＝読み込みは変形の裏。
//   右クリック「この地点を中心に全球図へ」＝equalHereItem：Equal Earth の中心はその地点・球は今の視点（morph=lon,lat）。
// 重ね方は 2 つ（2026-10-04・本人「iframe でなく div で済むように」）：
//   div（既定・load を渡した時）＝部品 createEqual（apps/equal/src/equal.js）を同じ頁の div に組む。別文書を起こさない＝
//     エンジン（globe/i18n/core/geopbf）と worker・bucket・IDB を japan と分かち合う（共有エンジン＝状態 1 つ）。
//     load＝() => import("ortho-equal/src/equal.js")（殻が渡す＝globe はアプリ equal に依存しない・依存の向き LAYERS.md）。
//     合図は postMessage でなく部品の口そのもの（on("frame")・releaseMorph()・on("closed")）。
//   iframe（load が無い時＝旧来・SDK の利用者など equal を束ねられない頁）＝/equal/?embed=1 を透明で重ね、postMessage で話す。
//   ①チルト/回転≠0 なら 0 へ（着地待ち）②透明で置く ③equal が最初の 1 枚（japan と同じ球のフレーム）を描いたら 0.3s で重ね
//   （球の上に球＝位置は 0 px 一致）④重なり切ったら「開け」の合図＝変形の 1 秒強の裏で地図の本体が読まれる。
//   戻り＝equal が球へ畳み終えて視点を返す → location.hash に書く（hashchange＝japan は即時ジャンプ）→ 0.3s で消す。
import { gadgetStack } from "./stack.js";
import { registerKeyOwner, claimKeys } from "./keys.js";   // 重ねている間はキー（矢印・Esc・ショートカット）を equal が握る＝下の地図へ漏らさない（#173 段 3 の持ち主）
import { tr, getLang } from "../i18n.js";
const t = tr();
const destOf = url => url ?? (["localhost", "127.0.0.1"].includes(location.hostname) ? "http://localhost:5198/" : "/equal/");
const LOADERS = new WeakMap();   // map → load（equal() で渡された部品の読み込み口＝equalHere／equalStart も同じ口を使う）
// 下の地図（mapEl）の家具が拾う出来事＝重ねた div の中で起きた分は止める（右クリックメニュー・ファイルのドロップ＝equal が自分で受ける）
const FENCE = ["contextmenu", "dragenter", "dragover", "dragleave", "drop"];
// center＝Equal Earth の中心（右クリック「この地点を中心に」）・球は今の視点。
// morph:false＝変形せず Equal Earth をそのまま上に載せる（入口＝?start=equal・本人 9/20「規定を EE にした方が面白い」の体感用）。
// view＝その時の Equal Earth の視点 { zoom, lat, lon }（省略＝今のカメラ）。戻りは同じ（この地点を球体へ → 球で japan が続く）
// load＝部品の読み込み口（省略＝equal() に渡した物・無ければ iframe）。onFrame＝最初の 1 枚が重なり始めた合図（起動画面を退かせる等）
export async function goEqual(map, { url, center, morph: doMorph = true, view, load = LOADERS.get(map), onFrame } = {}) {
	const cam = map.cam, mapEl = map.mapEl;
	if (mapEl.querySelector("#equal-frame")) return;   // 開いている
	if (doMorph && (cam.pitch > 1e-3 || Math.abs(cam.bearing) > 1e-3)) await map.flyTo(cam.center[0], cam.center[1], cam.zoom, 0, 0);
	const [lon0, lat0] = view ? [view.lon, view.lat] : cam.center, z = view ? view.zoom : cam.zoom;
	const morph = !doMorph ? "" : center ? `${lon0.toFixed(5)},${lat0.toFixed(5)}` : "1";
	const [lon, lat] = center || [lon0, lat0];
	const dest = destOf(url);
	const viewHash = `#${z.toFixed(2)}/${lat.toFixed(5)}/${lon.toFixed(5)}`;
	const place = el => Object.assign(el.style, { position: "absolute", inset: "0", width: "100%", height: "100%", border: "0", background: "transparent", opacity: "0", transition: "opacity .3s" });
	// 戻り＝球の視点をこの頁の hash に書けば japan は hashchange で即時ジャンプ（applyView）＝下の球が同じ球になってから消す
	const handBack = v => { if (v) location.hash = `#${(+v.zoom).toFixed(2)}/${(+v.lat).toFixed(5)}/${(+v.lon).toFixed(5)}`; };

	if (typeof load === "function") {   // ── div＝同じ頁に部品を組む ──
		const box = document.createElement("div");
		box.id = "equal-frame"; place(box);
		for (const ev of FENCE) box.addEventListener(ev, e => e.stopPropagation());
		mapEl.append(box);   // 後置＝家具ごと覆う（equal は自分の家具を持つ）
		const ac = new AbortController();
		registerKeyOwner(box, ac.signal); claimKeys(box);   // 開いている間はキーの持ち主＝下の地図の矢印・Esc・ショートカットは止まる
		let app = null;
		const close = () => { ac.abort(); box.style.opacity = "0"; setTimeout(() => { try { app?.destroy(); } catch {} box.remove(); }, 320); };
		try {
			const { createEqual } = await load();
			const params = new URLSearchParams({ embed: "1", lang: getLang() });   // embed=1＝「地球儀」と Esc は持ち主へ返す（closed）・morph は hold（合図まで球のまま）
			if (morph) params.set("morph", morph);
			app = await createEqual({ target: box, params, view: viewHash, hash: false, assetBase: new URL(dest, location.href), geopbf: false });   // hash:false＝頁の URL は japan の物・geopbf:false＝エンジンが起こした bucket 基盤をそのまま使う
			if (ac.signal.aborted) { app.destroy(); return; }
			const shown = () => { box.style.opacity = "1"; onFrame?.(); if (doMorph) setTimeout(() => app.releaseMorph(), 320); };   // 重なり切ってから開く
			if (app.drawn) shown(); else app.on("frame", shown);
			app.on("closed", v => { handBack(v); requestAnimationFrame(() => requestAnimationFrame(close)); });
		} catch (e) {
			console.error("[equal] in-page Equal Earth failed, falling back to iframe", e);
			ac.abort(); box.remove();
			return goEqual(map, { url, center, morph: doMorph, view, load: null, onFrame });
		}
		return;
	}

	// ── iframe＝別文書を重ねる（旧来） ──
	const src = dest + (dest.includes("?") ? "&" : "?") + `embed=1&lang=${getLang()}${morph ? "&morph=" + morph : ""}${viewHash}`;
	const fr = document.createElement("iframe");
	fr.id = "equal-frame"; fr.src = src; fr.setAttribute("title", "Equal Earth"); fr.setAttribute("allow", "fullscreen; clipboard-write");
	place(fr);
	const ac = new AbortController();
	const close = () => { ac.abort(); fr.style.opacity = "0"; setTimeout(() => fr.remove(), 320); };
	addEventListener("message", e => {
		if (e.source !== fr.contentWindow) return;   // 自分の iframe だけ（origin は dev で別ポート）
		const d = e.data || {};
		if (d.type === "equal:frame") { fr.style.opacity = "1"; onFrame?.(); if (doMorph) setTimeout(() => fr.contentWindow?.postMessage({ type: "equal:go" }, "*"), 320); }   // 重なり切ってから開く
		else if (d.type === "equal:closed") { handBack(d.view); requestAnimationFrame(() => requestAnimationFrame(close)); }
	}, { signal: ac.signal });
	mapEl.append(fr);   // 後置＝家具ごと覆う（equal は自分の家具を持つ）
}
// url＝equal の置き場（既定＝/equal/・dev は :5198）＝div でも koppen-clim.png の置き場・iframe の src。load＝部品の読み込み口（div 方式の鍵）
export function equal({ url, load } = {}) {
	const mapEl = this.mapEl, map = this;
	if (load) LOADERS.set(map, load);   // equalHere／equalStart も同じ口で開く
	if (mapEl.querySelector("#equal")) return;   // 二重搭載は無害
	const btn = document.createElement("button");
	btn.id = "equal"; btn.className = "qm-panel-btn";   // 34px 規格のガラス＝quiet-mono の汎用クラス（id の列挙に足さない）
	btn.dataset.tip = t("To Equal Earth (the whole Earth)"); btn.setAttribute("aria-label", t("To Equal Earth"));
	// Equal Earth の外形（擬円筒の輪郭）＋赤道・中央経線＝一目で「平らな全球図」。インクは他ガジェットと同じ #3f4757
	btn.innerHTML = `
		<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#3f4757" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true">
			<path d="M4.2 7.2 C7 4.8 17 4.8 19.8 7.2 C22.6 9.2 22.6 14.8 19.8 16.8 C17 19.2 7 19.2 4.2 16.8 C1.4 14.8 1.4 9.2 4.2 7.2 Z"/>
			<path d="M2.2 12 H21.8 M12 5.4 V18.6"/></svg>`;
	gadgetStack(mapEl).append(btn);
	btn.addEventListener("click", () => goEqual(map, { url }));
	return btn;
}
// 右クリックメニューの項目：この地点を中心に全球図へ（球は今の視点のまま＝地点が中心へ集まりながら開く）
export const equalHereItem = (map, { url, load } = {}) => ({ name: t("Equal Earth centered here"), onClick: c => c.lng != null && goEqual(map, { url, load, center: [c.lng, c.lat] }) });
