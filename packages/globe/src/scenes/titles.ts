// シーン上映の「見た目の層」＝字幕の型（下テロップ・大見出し・地名ピン）・開幕/終幕のタイトルカード・出典の焼き込み（2026-10-24・PLATEAU AWARD 向け）。
// 器＝#scene-titles / #scene-cards（mapEl の内側・inset:0・container-type:size）＝字の大きさは画角（cqh）基準＝エディタの枠でも全画面でも録画でも同じ比率で写る。
// 触れない（pointer-events:none）。見た目は quiet-mono components.scss（#scene-titles 節）。台本のキーは汎用名（scene-format.md §2b）。
// 文字は全部 textContent＝台本は他人作かもしれない（innerHTML に入れない）。
import { getLang } from "../i18n.ts";

/** 言語つきの文字列＝素の文字列か { ja:"…", en:"…" }（title の兄弟と同じ解き方＝視聴者の言語 → ja の旧綴り jp → en → 最初の値） */
export type LangText = string | Record<string, string>;
/** 開幕/終幕カード（台本の top-level `opening` / `ending`）。文字列だけ＝題だけのカード */
export interface CardSpec { title?: LangText; sub?: LangText; by?: LangText; hold?: number }
/** 字幕の型（行キー `look`）。top＝従来の画面上部（#demo-caption）・lower＝下三分の一のテロップ・center＝中央の大見出し・pin＝画面中央の地点に付く札 */
export type CaptionLook = "top" | "lower" | "center" | "pin";
export const LOOKS: CaptionLook[] = ["top", "lower", "center", "pin"];

export const pick = (v: unknown, lang?: string | null): string => {
	if (typeof v === "string") return v;
	if (!v || typeof v !== "object") return "";
	const o = v as Record<string, unknown>, l = lang || getLang();
	const s = o[l] ?? (l === "ja" ? o.jp : undefined) ?? o.en ?? Object.values(o).find(x => typeof x === "string");
	return typeof s === "string" ? s : "";
};
/** 台本の opening/ending を CardSpec へ（文字列＝題だけ・不正＝null） */
export const cardOf = (v: unknown): CardSpec | null => typeof v === "string" ? (v ? { title: v } : null) : v && typeof v === "object" && !Array.isArray(v) ? v as CardSpec : null;
/** カードの尺（秒）＝溶明 0.8 + 静止 hold（既定 3.5）+ 溶暗 0.8。録画の停止時刻・タイムラインの総尺が同じ式を使う */
export const CARD_FADE = 0.8;
export const cardSecs = (c: CardSpec | null): number => c ? CARD_FADE * 2 + (Number.isFinite(c.hold) && c.hold! >= 0 ? c.hold! : 3.5) : 0;

const LOGO = `<svg viewBox="0 0 100 100" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="6"><ellipse cx="50" cy="50" rx="45" ry="45"/><ellipse cx="50" cy="50" rx="25" ry="45"/><path d="M11 28H88 M11 72H88M50 5V95M5 50 H95"/></g></svg>`;

export interface SceneTitles {
	/** 字幕（look≠top）。null＝引っ込める */
	caption(c: { text: string; sub?: string; look: CaptionLook } | null): void;
	/** 開幕/終幕カード＝溶明→静止→溶暗を待つ（clear() で即解決） */
	card(c: CardSpec, lang?: string | null): Promise<void>;
	/** 出典の焼き込み（画角内の左下）。null/空＝外す */
	credit(text: string | null): void;
	/** 全部外す（停止・終演） */
	clear(): void;
}

export function createSceneTitles(mapEl: HTMLElement): SceneTitles {
	// 器は 2 枚：#scene-titles（字幕・出典＝黒幕 #scene-cover の下＝溶暗で絵と一緒に沈む）／#scene-cards（カード＝黒幕の上）
	const roots: Record<string, HTMLDivElement> = {};
	let capEl: HTMLDivElement | null = null, cardEl: HTMLDivElement | null = null, creditEl: HTMLDivElement | null = null;
	let capKey = "", cardDone: (() => void) | null = null, cardT = 0;
	const host = (id = "scene-titles") => {
		const r = roots[id] ??= Object.assign(document.createElement("div"), { id });
		if (r.parentElement !== mapEl) mapEl.append(r);
		return r;
	};
	const line = (cls: string, text: string) => { const d = document.createElement("div"); d.className = cls; d.textContent = text; return d; };
	const caption: SceneTitles["caption"] = c => {
		const key = c && c.text ? `${c.look}\n${c.text}\n${c.sub ?? ""}` : "";
		if (key === capKey) return;   // 同じ字幕の出しっぱなし（200ms 刻みの arm）＝アニメを撃ち直さない
		capKey = key;
		if (capEl) { const old = capEl; old.classList.remove("show"); setTimeout(() => old.remove(), 400); capEl = null; }
		if (!c || !c.text) return;
		capEl = document.createElement("div");
		capEl.className = `st-cap st-${c.look}`;
		if (c.look === "pin") capEl.append(Object.assign(document.createElement("i"), { className: "st-dot" }), Object.assign(document.createElement("i"), { className: "st-stem" }));
		const box = document.createElement("div"); box.className = "st-box";
		box.append(line("st-t", c.text));
		if (c.sub) box.append(line("st-s", c.sub));
		capEl.append(box);
		host().append(capEl);
		void capEl.offsetWidth; capEl.classList.add("show");   // reflow＝transition を確実に点火（demo のタイトル淡入と同じ作法）
	};
	const card: SceneTitles["card"] = (c, lang) => new Promise<void>(res => {
		cardDone?.(); clearTimeout(cardT);
		cardEl?.remove();
		const el = cardEl = document.createElement("div");
		el.className = "st-card";
		const logo = document.createElement("div"); logo.className = "st-logo"; logo.innerHTML = LOGO;   // 固定の svg（台本の文字ではない）
		el.append(logo);
		const title = pick(c.title, lang), sub = pick(c.sub, lang), by = pick(c.by, lang);
		if (title) el.append(line("st-ct", title));
		if (sub) el.append(line("st-cs", sub));
		if (by) { el.append(Object.assign(document.createElement("i"), { className: "st-rule" }), line("st-cb", by)); }
		host("scene-cards").append(el);
		void el.offsetWidth; el.classList.add("show");
		const holdMs = (cardSecs(c) - CARD_FADE) * 1000;
		const done = cardDone = () => { if (cardDone !== done) return; cardDone = null; clearTimeout(cardT); res(); };
		cardT = setTimeout(() => {
			el.classList.remove("show");
			cardT = setTimeout(() => { if (cardEl === el) { el.remove(); cardEl = null; } done(); }, CARD_FADE * 1000);
		}, holdMs);
	});
	const credit: SceneTitles["credit"] = text => {
		if (!text) { creditEl?.remove(); creditEl = null; return; }
		if (!creditEl) { creditEl = document.createElement("div"); creditEl.className = "st-credit"; }
		creditEl.textContent = text;
		host().append(creditEl);
	};
	const clear = () => {
		caption(null); credit(null);
		clearTimeout(cardT); cardEl?.remove(); cardEl = null; cardDone?.();
	};
	return { caption, card, credit, clear };
}
// 1 地図に 1 層（demo ガジェットの字幕と player のカード・出典が同じ器を使う）
const byMap = new WeakMap<HTMLElement, SceneTitles>();
export const sceneTitlesOf = (mapEl: HTMLElement): SceneTitles => { let s = byMap.get(mapEl); if (!s) byMap.set(mapEl, s = createSceneTitles(mapEl)); return s; };
