// 地名の検索窓（M4）：端末に置いた地図の地名の索引（unmap/places/*.json＝save-worker が作る）だけを引く＝回線なしで同じ答え。
// 上の細い窓に打つ → 候補（選んだ言語の名・種類）→ 押すとそこへ飛ぶ。索引の無い時（まだ保存していない）は「保存した範囲の地名を探せます」と出す。
import { searchPlaces, zoomForKind } from "./places.ts";
import type { Place } from "./places.ts";
import { PLACES_DIR } from "./sources.ts";

/** 端末の索引を全部読む（壊れた物は飛ばす） */
export async function loadPlaces(): Promise<Place[]> {
	try {
		let d = await navigator.storage.getDirectory();
		for (const p of PLACES_DIR.split("/")) d = await d.getDirectoryHandle(p);
		const out: Place[] = [];
		for await (const [n, h] of (d as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
			if (h.kind !== "file" || !n.endsWith(".json")) continue;
			try { const a = JSON.parse(await (await (h as FileSystemFileHandle).getFile()).text()); if (Array.isArray(a)) out.push(...a); } catch { /* 壊れた索引＝飛ばす */ }
		}
		return out;
	} catch { return []; }
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const KIND: Record<string, string> = { country: "country", region: "region", locality: "town", neighbourhood: "area", macrohood: "area" };

/** 窓を組む。fly＝そこへ飛ぶ・lang＝見せる名前の言語（地名の言語の選択と同じ） */
export function mountSearch(el: HTMLElement, places: () => Place[], fly: (lon: number, lat: number, zoom: number) => void, lang: () => string): void {
	el.innerHTML = `<input type="search" placeholder="Search places on this device" aria-label="Search places on this device" autocomplete="off" enterkeyhint="search"><ul class="hits" hidden></ul>`;
	const input = el.querySelector("input")!, list = el.querySelector(".hits") as HTMLUListElement;
	let hits: ReturnType<typeof searchPlaces> = [];
	const show = () => {
		const q = input.value;
		hits = q.trim() ? searchPlaces(places(), q, { lang: lang(), limit: 12 }) : [];
		if (!q.trim()) { list.hidden = true; return; }
		list.innerHTML = hits.length
			? hits.map((h, i) => `<li><button type="button" data-i="${i}">${esc(h.label)}${h.label !== h.name ? ` <span class="sub">${esc(h.name)}</span>` : ""} <span class="kind">${esc(KIND[h.kind] ?? h.kind)}</span></button></li>`).join("")
			: `<li class="none">${places().length ? "No match in your saved areas." : "Save an area first — then its place names can be searched without a connection."}</li>`;
		list.hidden = false;
	};
	const go = (i: number) => { const h = hits[i]; if (!h) return; fly(h.lon, h.lat, zoomForKind(h.kind)); list.hidden = true; input.blur(); };
	input.addEventListener("input", show);
	input.addEventListener("focus", show);
	input.addEventListener("keydown", e => { if (e.key === "Enter") go(0); else if (e.key === "Escape") { input.value = ""; list.hidden = true; input.blur(); } });
	list.addEventListener("click", e => { const b = (e.target as HTMLElement).closest("button[data-i]") as HTMLButtonElement | null; if (b) go(+b.dataset.i!); });
	document.addEventListener("pointerdown", e => { if (!el.contains(e.target as Node)) list.hidden = true; });
}
