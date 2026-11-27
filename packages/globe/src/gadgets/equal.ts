// ガジェット：全球図（ortho-equal・Equal Earth）への口。34px 規格のアイコン（solar と同じ型・2026-09-20）。
// map.gadget.equal() で搭載（v1 ortho-map の gadget 作法＝this が map）。押すと Equal Earth を地図の上に重ねる。
// 繋ぎ方（本人 9/20「この方式で japan と equal を繋ぐ」「遷移の時間は準備時間」）：
//   equal は morph と #z/lat/lon を受けると、japan と同じ透視カメラ（チルト 0）の球のフレームから Equal Earth へ開く＝
//   球は japan の今の視点と 0 px で一致（実測）。ページは移らず地図の上に重ねる＝読み込みは変形の裏。
//   右クリック「この地点を中心に全球図へ」＝equalHereItem：Equal Earth の中心はその地点・球は今の視点（morph=lon,lat）。
// 重ね方は 2 つ（2026-10-04・本人「iframe でなく div で済むように」）：
//   div（既定・load を渡した時）＝部品 createEqual（packages/equal/src/equal.ts）を同じ頁の div に組む。別文書を起こさない＝
//     エンジン（globe/i18n/core/geopbf）と worker・bucket・IDB を japan と分かち合う（共有エンジン＝状態 1 つ）。
//     load＝() => import("@ortho-earth/equal")（本番＝共有エンジンの入口 equal.js）（殻が渡す＝globe はアプリ equal に依存しない・依存の向き LAYERS.md）。
//     合図は postMessage でなく部品の口そのもの（on("frame")・releaseMorph()・on("closed")）。
//   iframe（load が無い時＝旧来・SDK の利用者など equal を束ねられない頁）＝/equal/?embed=1 を透明で重ね、postMessage で話す。
//   ①チルト/回転≠0 なら 0 へ（着地待ち）②透明で置く ③equal が最初の 1 枚（japan と同じ球のフレーム）を描いたら 0.3s で重ね
//   （球の上に球＝位置は 0 px 一致）④重なり切ったら「開け」の合図＝変形の 1 秒強の裏で地図の本体が読まれる。
//   戻り＝equal が球へ畳み終えて視点を返す → location.hash に書く（hashchange＝japan は即時ジャンプ）→ 0.3s で消す。
import { gadgetStack } from "./stack.ts";
import { registerKeyOwner, claimKeys } from "./keys.ts";   // 重ねている間はキー（矢印・Esc・ショートカット）を equal が握る＝下の地図へ漏らさない（#173 段 3 の持ち主）
import { tr, getLang } from "../i18n.ts";
import { lowMem } from "../boot/tier.ts";   // 低メモリ端末（≤4GB・iOS はタッチ端末を一律）＝globe 本体と同じ物差し・同じ戻し口（?lowmem=1/0）
import type { ContextMenuItem, EqualOptions, LonLat } from "../../globe.d.ts";
import type { GlobeMap } from "../types/map.ts";
const t = tr();

/** 部品の読み込み口（div 方式の鍵）＝() => import("@ortho-earth/equal") */
type EqualLoad = NonNullable<EqualOptions["load"]>;
/** 全球図の視点（zoom・lat・lon）。戻り（closed）では文字列のこともある＝数へ直して読む */
type EqualView = { zoom: number; lat: number; lon: number };
type EqualViewBack = { zoom: number | string; lat: number | string; lon: number | string };
/** createEqual が返す部品の手綱のうち、ここが使う分（globe は @ortho-earth/equal に依存しない＝形だけ書く） */
interface EqualApp {
	drawn?: boolean;
	destroy(): void;
	releaseMorph(): void;
	on(ev: "frame", cb: () => void): unknown;
	on(ev: "closed", cb: (v?: EqualViewBack | null) => void): unknown;
	on(ev: "morph", cb: (dir?: number) => void): unknown;
}
/** load() が解決する物（部品の入口） */
interface EqualModule {
	createEqual(o: { target: HTMLElement; params: URLSearchParams; view: string; hash: boolean; assetBase?: URL; geopbf: boolean }): EqualApp | Promise<EqualApp>;
}
/** goEqual の opts（center＝全球図の中心・morph:false＝変形なし・view＝全球図の視点・load＝部品の読み込み口（null＝iframe）・onFrame＝最初の 1 枚の合図） */
export interface GoEqualOptions { url?: string; center?: LonLat; morph?: boolean; view?: EqualView; load?: EqualLoad | null; onFrame?: () => void }

const destOf = (url: string | undefined) => url ?? (["localhost", "127.0.0.1"].includes(location.hostname) ? "http://localhost:5198/" : "/equal/");
const LOADERS = new WeakMap<GlobeMap, EqualLoad>();   // map → load（equal() で渡された部品の読み込み口＝equalHere／equalStart も同じ口を使う）
// 下の地図（mapEl）の家具が拾う出来事＝重ねた div の中で起きた分は止める（右クリックメニュー・ファイルのドロップ＝equal が自分で受ける）
const FENCE = ["contextmenu", "dragenter", "dragover", "dragleave", "drop"];
// center＝Equal Earth の中心（右クリック「この地点を中心に」）・球は今の視点。
// morph:false＝変形せず Equal Earth をそのまま上に載せる（入口＝?start=equal・本人 9/20「規定を EE にした方が面白い」の体感用）。
// view＝その時の Equal Earth の視点 { zoom, lat, lon }（省略＝今のカメラ）。戻りは同じ（この地点を球体へ → 球で japan が続く）
// load＝部品の読み込み口（省略＝equal() に渡した物・無ければ iframe）。onFrame＝最初の 1 枚が重なり始めた合図（起動画面を退かせる等）
/** Equal Earth を地図の上に重ねる */
export async function goEqual(map: GlobeMap, { url, center, morph: doMorph = true, view, load = LOADERS.get(map), onFrame }: GoEqualOptions = {}): Promise<void> {
	const cam = map.cam, mapEl = map.mapEl;
	if (mapEl.querySelector("#equal-frame")) return;   // 開いている
	if (doMorph && (cam.pitch! > 1e-3 || Math.abs(cam.bearing!) > 1e-3)) await map.flyTo(cam.center[0], cam.center[1], cam.zoom, 0, 0);
	const [lon0, lat0]: LonLat = view ? [view.lon, view.lat] : cam.center, z = view ? view.zoom : cam.zoom;
	const morph = !doMorph ? "" : center ? `${lon0.toFixed(5)},${lat0.toFixed(5)}` : "1";
	const [lon, lat] = center || [lon0, lat0];
	const dest = destOf(url);
	const viewHash = `#${z.toFixed(2)}/${lat.toFixed(5)}/${lon.toFixed(5)}`;
	const place = (el: HTMLElement) => Object.assign(el.style, { position: "absolute", inset: "0", width: "100%", height: "100%", border: "0", background: "transparent", opacity: "0", transition: "opacity .3s" });
	// 戻り＝球の視点をこの頁の hash に書けば japan は hashchange で即時ジャンプ（applyView）＝下の球が同じ球になってから消す
	// 低メモリ端末は重ねない＝/equal/ の頁へ移る（本人裁定 2026-11-27）。重ねると 2 つの地図が同時にメモリへ乗る＝幕が開いた瞬間が山
	//（実測：開く前から GPU +0.5〜0.8GB・うち 0.4〜0.9GB は隠れている下の地図の分）＝タブが落ちる。頁を移れば下の地図は丸ごと解放される。
	// equal の頁は ?morph（同じ球のフレームから開く）と ?back=（「← 戻る」＝球へ畳んで、その視点を hash に載せてこの頁へ戻る）を元から持つ＝
	// 絵の繋がりは同じで、戻りだけこの頁の読み直しになる。back からは ?start=equal を抜く（戻った途端にまた開かない）
	if (/[?&]lowmem=1/.test(location.search) || (!/[?&]lowmem=0/.test(location.search) && lowMem(navigator))) {
		const back = new URL(location.href); back.searchParams.delete("start");
		const u = new URL(dest, location.href);
		u.searchParams.set("lang", getLang()); if (morph) u.searchParams.set("morph", morph);
		u.searchParams.set("back", back.href); u.hash = viewHash;
		// 移る前にこの地図を畳む（destroy）＝GPU・worker・配列を今すぐ手放す。iOS Safari は離れた頁を bfcache に生かしたまま
		// 次の頁を開く＝畳まないと「頁を移ったのに 2 つの地図が乗ったまま」になり、行きも帰りも落ちる（本人報告 2026-11-27）。
		// bfcache から戻された時（ブラウザの「戻る」）は畳んだ後の抜け殻＝読み直す
		addEventListener("pageshow", e => { if (e.persisted) location.reload(); });
		document.documentElement.style.background = document.body.style.background = "#000";   // equal は黒地の球から開く＝間に地の色を挟まない
		try { map.destroy(); } catch (e) { console.warn("[equal] destroy before leaving", e); }
		location.href = u.href;
		return;
	}
	const handBack = (v: EqualViewBack | null | undefined) => { if (v) location.hash = `#${(+v.zoom).toFixed(2)}/${(+v.lat).toFixed(5)}/${(+v.lon).toFixed(5)}`; };

	if (typeof load === "function") {   // ── div＝同じ頁に部品を組む ──
		const box = document.createElement("div");
		box.id = "equal-frame"; place(box);
		for (const ev of FENCE) box.addEventListener(ev, e => e.stopPropagation());
		mapEl.append(box);   // 後置＝家具ごと覆う（equal は自分の家具を持つ）
		const ac = new AbortController();
		registerKeyOwner(box, ac.signal); claimKeys(box);   // 開いている間はキーの持ち主＝下の地図の矢印・Esc・ショートカットは止まる
		let app: EqualApp | null = null;
		// 覆い切っている間は下の地図（canvas・家具）を visibility:hidden にする＝合成器が毎フレーム下の 5K canvas 3 枚を重ね続けない
		//（実測 2026-11-27：重ねた状態のドラッグ 53〜55fps・GPU 待ち 70ms → 下を隠すと 60fps・14ms）。畳み始め（morph −1）で戻す＝球の受け渡しは今まで通り
		const hidden: [HTMLElement, string][] = [];
		const cover = (on: boolean) => {
			if (on === hidden.length > 0) return;
			if (on) { for (const el of mapEl.children) if (el !== box && el instanceof HTMLElement) { hidden.push([el, el.style.visibility]); el.style.visibility = "hidden"; } }
			else { for (const [el, v] of hidden) el.style.visibility = v; hidden.length = 0; }
		};
		const close = () => { cover(false); ac.abort(); box.style.opacity = "0"; setTimeout(() => { try { app?.destroy(); } catch {} box.remove(); }, 320); };
		try {
			const { createEqual } = await (load() as EqualModule | Promise<EqualModule>);
			const params = new URLSearchParams({ embed: "1", lang: getLang() });   // embed=1＝「地球儀」と Esc は持ち主へ返す（closed）・morph は hold（合図まで球のまま）
			if (morph) params.set("morph", morph);
			app = await createEqual({ target: box, params, view: viewHash, hash: false, ...(url != null && { assetBase: new URL(dest, location.href) }), geopbf: false });   // hash:false＝頁の URL は japan の物・geopbf:false＝エンジンが起こした bucket 基盤をそのまま使う
			if (ac.signal.aborted) { app.destroy(); return; }
			const shown = () => { box.style.opacity = "1"; onFrame?.(); if (doMorph) setTimeout(() => app!.releaseMorph(), 320); else setTimeout(() => { if (!ac.signal.aborted) cover(true); }, 320); };   // 重なり切ってから開く
			app.on("morph", dir => cover(dir === 0));   // 0＝開き切った（不透明の地図）・±1＝変形中（球のフレーム＝下の球と重なる絵）
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
		const d: { type?: string; view?: EqualViewBack | null } = e.data || {};
		if (d.type === "equal:frame") { fr.style.opacity = "1"; onFrame?.(); if (doMorph) setTimeout(() => fr.contentWindow?.postMessage({ type: "equal:go" }, "*"), 320); }   // 重なり切ってから開く
		else if (d.type === "equal:closed") { handBack(d.view); requestAnimationFrame(() => requestAnimationFrame(close)); }
	}, { signal: ac.signal });
	mapEl.append(fr);   // 後置＝家具ごと覆う（equal は自分の家具を持つ）
}
// url＝equal の置き場（既定＝/equal/・dev は :5198）＝iframe の src（div は url を渡した時だけ koppen-clim.png の置き場にも・既定は部品の同梱）。load＝部品の読み込み口（div 方式の鍵）
/** Equal Earth へのボタン。二重搭載は undefined */
export function equal(this: GlobeMap, { url, load }: EqualOptions = {}): HTMLButtonElement | undefined {
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
export const equalHereItem = (map: GlobeMap, { url, load }: EqualOptions = {}): ContextMenuItem => ({ name: t("Equal Earth centered here"), onClick: c => c.lng != null && goEqual(map, { url, load, center: [c.lng, c.lat!] }) });
