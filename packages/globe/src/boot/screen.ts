// 起動画面（#boot）の正本（2026-10-23・本人「立ち上がりまでの状態が均一ではありません。すべて日本地図（デモ）に合わせて。修正元は１か所で、それを配る形に」）。
// 形＝日本地図（/japan/?demo=1）の起動画面：濃紺の幕（#0b1021）の中央に球儀マーク（72px・1.6s で呼吸）→ 地図の初回フレームが描けたら .2s でフェードして消える。
// 旧＝各頁の HTML に CSS とマークを写していた（25 か所）＝紙色の幕・色違いのマーク・独自の絵（quiz の地球・himekuri の暦）が混ざり、起動画面の無い頁もあった。
// 配り方（ここを直せば全部に届く）：
//   ・vite の頁＝HTML に <!-- ortho:boot --> を置く → vite-app.mjs の bootScreen が head に CSS・その場所に幕を差し込む（dev も build も）
//   ・vite を通らない静的な頁（www/public/maplibre の一覧と例）＝bootStatic() の焼き物を写す（apps/www/scripts/boot-sync.mjs・検定 t-boot-sync.mjs が写しのずれを止める）
//   ・畳む＝dismissBoot()（page.js の startPage も同じ物を呼ぶ）。幕が無ければ何もしない
// 型の無い素の関数で書く＝bootStatic が dismissBoot をそのまま文字列にしてインラインの script へ焼く（node の型剥がしでも同じ字面）。

/** HTML に置く印（vite の bootScreen がここを幕に差し替える） */
export const BOOT_SLOT = "<!-- ortho:boot -->";
/** 幕の地色＝日本地図の夜の地（html の background と同じ） */
export const BOOT_BG = "#0b1021";
// フェードは短く（.2s）＝地図の初回フレームは既に描けている。長いと下の UI（出典など）の露出が遅れ LCP を押し下げる。
// z-index は最大＝頁の UI（地図の家具・ナビ）より必ず上。prefers-reduced-motion では呼吸を止める（デモ頁の門）
export const BOOT_CSS = `#boot{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:${BOOT_BG};transition:opacity .2s ease}
#boot.gone{opacity:0;pointer-events:none}
#boot svg{width:72px;height:72px;animation:boot-breathe 1.6s ease-in-out infinite}
@keyframes boot-breathe{0%,100%{opacity:.35}50%{opacity:1}}
@media (prefers-reduced-motion:reduce){#boot svg{animation:none;opacity:.8}}`;
/** 球儀マーク（aria-label は head と同じ英語） */
export const BOOT_MARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" role="img" aria-label="Loading"><g fill="none" stroke="#cdd6e6" stroke-width="6"><ellipse cx="50" cy="50" rx="45" ry="45"/><ellipse cx="50" cy="50" rx="25" ry="45"/><path d="M11 28H88 M11 72H88M50 5V95M5 50 H95"/></g></svg>`;
/** 幕そのもの（外部の CSS/JS に依らず HTML のパース直後に描ける＝FCP の実体） */
export const BOOT_HTML = `<div id="boot">${BOOT_MARK}</div>`;

// 畳む＝地図の初回フレームが描かれてから（空 canvas のちらつきを避ける 2 フレーム待ち）。.gone でフェード→消し去る。幕が無ければ何もしない
export function dismissBoot() {
	requestAnimationFrame(() => requestAnimationFrame(() => {
		const b = document.getElementById("boot");
		if (b) { b.classList.add("gone"); setTimeout(() => b.remove(), 250); }
	}));
}

// MapLibre の例の地図（packages/globe/src/maplibre/map.ts）が load の後に容れ物から出す DOM の合図（泡立つ）
export const MAP_READY_EVENT = "ortho:load";

/**
 * vite を通らない静的な頁に写す一式（head に入れる style・body の頭に入れる幕と畳む script）。
 * until＝何を待って畳むか：
 *   "map"    … MapLibre の例＝地図の load（MAP_READY_EVENT）。合図を出さない古いエンジンでも幕が残り続けないよう上限 10 秒
 *   "images" … 一覧の頁＝最初に見えるサムネイル（.shot img）が読めたら。上限 3 秒
 */
export function bootStatic(until: "map" | "images"): { head: string; body: string } {
	const wait = until === "map"
		? `addEventListener(${JSON.stringify(MAP_READY_EVENT)},d,{once:true});setTimeout(d,10000)`
		: `addEventListener("DOMContentLoaded",()=>{const v=[...document.querySelectorAll(".shot img")].filter(i=>i.getBoundingClientRect().top<innerHeight).slice(0,8);Promise.all(v.map(i=>i.complete?0:new Promise(r=>{i.onload=i.onerror=r}))).then(d)});setTimeout(d,3000)`;
	return {
		head: `<style id="boot-css">${BOOT_CSS}</style>`,
		body: `<!--boot-->${BOOT_HTML}<script>(()=>{const d=${dismissBoot.toString().replace(/^function dismissBoot\(\)/, "()=>")};${wait}})()</script><!--/boot-->`,
	};
}

/** 静的な頁の HTML に bootStatic を写す（前の写しは外してから入れ直す＝何度掛けても同じ結果）。head の終わりに style・body の頭に幕 */
export function withBootStatic(html: string, until: "map" | "images"): string {
	const { head, body } = bootStatic(until);
	return html.replace(/<style id="boot-css">[\s\S]*?<\/style>/, "").replace(/<!--boot-->[\s\S]*?<!--\/boot-->/, "")
		.replace(/<\/head>/i, `${head}</head>`).replace(/<body([^>]*)>/i, m => `${m}${body}`);
}
