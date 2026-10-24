// ガジェット：右クリックメニュー。標準装備でなくオプトイン＝orthoJapan() の戻り値から
// map.gadget.contextmenu() で搭載する（v1 ortho-map の gadget 作法＝this が map）。
// 右クリック（タッチは長押し）で #map 上の指した地点にメニューを出す。iOS Safari は長押しで contextmenu を出さない＝自前の長押し（下）で開く（2026-10-24）。
// 項目は本体が差し替え可＝戻り値の setter に配列、または (ctx, 既定項目)→配列 の関数を渡す（各項目 {name, icon?, onClick(ctx)}）。
// 未設定なら既定メニュー（この地点へ寄る／座標をコピー）＝搭載しただけで使える。
// ctx＝{ lng, lat, x, y, map }。lng/lat は指した画面座標の逆投影（screen→world。裏半球や宇宙なら undefined）。
// unprojectAt＝画面座標→経緯度（実装は engine の unproject／注入は登録側）。signal＝destroy 時のリスナー解除。
import { tr } from "../i18n.ts";
import type { ContextMenuItem, ContextMenuItems, LonLat } from "../../globe.d.ts";
import type { GlobeMap } from "../types/map.ts";
const t = tr();

export type { ContextMenuItems };
/** 搭載の opts（unprojectAt＝画面座標→経緯度・登録側が注入／items＝項目の並び） */
export interface ContextMenuOptions { unprojectAt: (clientX: number, clientY: number) => LonLat | null; signal?: AbortSignal; items?: ContextMenuItems; [k: string]: unknown }
/** 指した地点（lng/lat＝逆投影・球に当たらなければ undefined） */
type MenuCtx = Parameters<ContextMenuItem["onClick"]>[0];
/** #map＝二重搭載で項目を差し替える口を持つ */
type MenuHost = HTMLElement & { _ctxSetItems?: (fn: ContextMenuItems | undefined) => void };

/** 右クリックメニュー。戻り値＝項目の setter（二重搭載＝{ setItems }） */
export function contextmenu(this: GlobeMap, { unprojectAt, signal, items }: ContextMenuOptions = {} as ContextMenuOptions):
	((set: ContextMenuItems) => void) | { setItems(fn: ContextMenuItems): void } {
	const mapEl: MenuHost = this.mapEl, cam = this.cam, flyTo = this.flyTo, map = this;
	if (mapEl.querySelector("#ctxmenu")) { if (items !== undefined) mapEl._ctxSetItems?.(items); return { setItems: (fn: ContextMenuItems) => mapEl._ctxSetItems?.(fn) }; }   // 二重搭載＝項目の差し替えだけ受ける（編集ガジェットが本体地図に載る時＝既定へ戻すのは setItems(null)）
	const DEFAULT: ContextMenuItem[] = [
		{ name: t("Zoom to this point"), onClick: c => c.lng != null && flyTo(c.lng, c.lat!, Math.max(cam.zoom, 15), cam.pitch! * 180 / Math.PI) },
		{ name: t("Copy coordinates"), onClick: c => c.lng != null && navigator.clipboard?.writeText(`${c.lat!.toFixed(6)}, ${c.lng.toFixed(6)}`) },
	];
	let list: ContextMenuItems = items || DEFAULT;
	mapEl._ctxSetItems = fn => { list = fn || DEFAULT; };
	const menu = document.createElement("div");
	menu.id = "ctxmenu"; menu.style.display = "none";
	// 後置＝#map 直下（DOM順で上に描く。z-index不使用の掟）。
	mapEl.append(menu);
	const hide = () => { menu.style.display = "none"; };
	const ctx = (e: { clientX: number; clientY: number }): MenuCtx => {
		const r = mapEl.getBoundingClientRect();
		const ll = unprojectAt(e.clientX, e.clientY);   // 球に当たらなければ null
		return { lng: ll?.[0], lat: ll?.[1], x: e.clientX - r.left, y: e.clientY - r.top, map };
	};
	// 長押し（タッチ・1 本指で LONG_MS 動かさない）＝右クリックと同じメニュー。Android は自前でも contextmenu を出す＝長押しで開いた直後の
	// contextmenu は捨てる（二度開かない）。開いた指を離すまでの move/click は閉じる合図にしない（指の震え・離した時の click）
	const LONG_MS = 550, SLOP = 10;
	let lpTimer: ReturnType<typeof setTimeout> | 0 = 0, lpAt: [number, number] | null = null, lpOpen = false, touches = 0;
	const lpCancel = () => { clearTimeout(lpTimer); lpTimer = 0; lpAt = null; };
	mapEl.addEventListener("pointerdown", e => {
		if (e.pointerType !== "touch") return;
		touches = e.isPrimary ? 1 : touches + 1; lpOpen = false; lpCancel();   // isPrimary＝最初の指＝数え直し（取りこぼした pointerup で数がずれない）
		if (touches > 1 || menu.contains(e.target as Node | null)) return;   // 2 本目（ピンチ・回転）・メニューの上＝長押しにしない
		lpAt = [e.clientX, e.clientY];
		lpTimer = setTimeout(() => { const at = lpAt; lpCancel(); if (!at) return; lpOpen = true; open(ctx({ clientX: at[0], clientY: at[1] })); }, LONG_MS);
	}, { signal, passive: true, capture: true });   // capture＝canvas 側の掴み（setPointerCapture・stopPropagation）より先に見る
	mapEl.addEventListener("pointermove", e => { if (lpAt && e.pointerType === "touch" && Math.hypot(e.clientX - lpAt[0], e.clientY - lpAt[1]) > SLOP) lpCancel(); }, { signal, passive: true, capture: true });
	const lpUp = (e: PointerEvent) => { if (e.pointerType !== "touch") return; touches = Math.max(0, touches - 1); lpCancel(); };
	mapEl.addEventListener("pointerup", lpUp, { signal, passive: true, capture: true });
	mapEl.addEventListener("pointercancel", lpUp, { signal, passive: true, capture: true });
	mapEl.addEventListener("contextmenu", e => {
		e.preventDefault();
		if (lpOpen) return;   // 長押しで開いた直後の Android 純正 contextmenu
		open(ctx(e));
	}, { signal });
	function open(c: MenuCtx): void {
		const arr = typeof list === "function" ? list(c, DEFAULT) : list;   // 関数＝(ctx, 既定項目) → 配列（既定に足すだけの搭載側が既定を写さずに済む）
		if (!Array.isArray(arr) || !arr.length) return hide();
		menu.replaceChildren();
		for (const it of arr) {
			const p = document.createElement("button");
			p.className = "ctxmenu-item";
			p.innerHTML = it.icon || "";   // icon＝呼び手の HTML（SVG 等）
			const label = document.createElement("span");
			label.textContent = `${it.name}`;   // 名前は文字（HTML として解釈しない・2026-10-16）
			p.append(label);
			p.addEventListener("click", ev => { ev.stopPropagation(); hide(); it.onClick?.(c); });
			menu.append(p);
		}
		const r = mapEl.getBoundingClientRect();
		let cx = c.x, cy = c.y;
		menu.style.display = ""; menu.style.left = cx + "px"; menu.style.top = cy + "px";
		const m = menu.getBoundingClientRect();   // 実寸を測って端で見切れないよう内側へ寄せる
		if (cx + m.width > r.width) menu.style.left = Math.max(0, r.width - m.width - 4) + "px";
		if (cy + m.height > r.height) menu.style.top = Math.max(0, r.height - m.height - 4) + "px";
	}
	// 閉じる：地図クリック・ドラッグ開始（押したまま動く＝パン/回転）・Esc（メニュー内クリックは項目ハンドラが閉じる）。
	// 押下だけでは閉じない（メニューは瞬間に消えない）＝ボタンを押したまま動いた時に解除＝地図を掴んだ合図。
	mapEl.addEventListener("click", e => { if (lpOpen && !menu.contains(e.target as Node | null)) { lpOpen = false; return; } hide(); }, { signal });   // 長押しの指を離した click では閉じない
	mapEl.addEventListener("pointermove", e => { if (lpOpen && e.pointerType === "touch") return; if (e.buttons !== 0 && !menu.contains(e.target as Node | null)) hide(); }, { signal, passive: true });
	window.addEventListener("keydown", e => { if (e.key === "Escape") hide(); }, { signal });
	return (set: ContextMenuItems) => { list = set; };   // 呼び出し側の手綱（項目の差し替え。配列 or e→配列 の関数）
}
