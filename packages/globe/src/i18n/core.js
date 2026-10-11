// UI 文言の多言語化の芯（英語キー・26 言語）＝globe・solar・equal・geopbf-demo・www の i18n.js が別々に持っていた同じ 40 行を 1 本に（2026-10-03）。
// 辞書と読み方（字面の import 表・import.meta.glob・fetch）は各アプリの i18n.js に残す＝ここは「言語を決める・表を引く」だけ。
//
//   const i18n = createI18n({ langs: LANGS, load: async c => (await import(`./lang/${c}.json`)).default });
//   export const { getLang, setLang, loadLang, loadPage, registerPack, isRTL, langName, LANGUAGES, norm, t, tr, has, applyDom, applyHtml } = i18n;
//
// 契約（全アプリ共通・裁定 2026-09-16 の「形」）：
//   ・キー＝英語＝既定値。訳が無い／"" ＝英語（キー）へ落ちる＝欠落は隠れない（en は表を持たない）
//   ・" ##…" ＝文脈＝同じ英語を別の語として分けるための印。表示では捨てる
//   ・$1 $2 … ＝引数差し込み（world の trans と同じ書式）
//   ・norm：jp→ja・小文字化・"ja-JP"/"pt_BR" → 基底。一覧に無い言語は null
//   ・言語は未解決のまま始まり、最初の getLang()（または setLang()）で ?lang= → navigator.language → en の順に決まる。setLang(code) が先なら勝つ
//   ・load(code) は表（{ 英語キー: 訳 }）を返す。取れなければ英語のまま（UI は止めない）。en は呼ばれない
export function createI18n({ langs, load }) {
	const CTX_SEP = " ##";
	const CODES = new Set(langs.map(l => l.code));
	const RTL = new Set(langs.filter(l => l.rtl).map(l => l.code));
	const packs = {};                // code → { 英語キー: 訳 }。en は持たない＝キーそのもの
	let lang = null;                 // 未解決＝最初の getLang() で判定（setLang が先に来ればそちらが勝つ）

	const norm = c => {
		const s = String(c || "").trim().toLowerCase();
		if (!s) return null;
		if (s === "jp") return "ja";                                  // 歴史的別名
		if (CODES.has(s)) return s;
		const base = s.split(/[-_]/)[0];                              // "ja-JP" / "pt_BR" → 基底
		return CODES.has(base) ? base : null;
	};
	function getLang() {
		if (!lang) {
			const q = typeof location !== "undefined" ? new URLSearchParams(location.search).get("lang") : null;
			lang = norm(q) ?? norm(typeof navigator !== "undefined" ? navigator.language : null) ?? "en";
		}
		return lang;
	}
	// 言語を決め、その訳を用意して返す（en は待たない＝同期同然）。アプリは UI を組む前に一度 await する（モジュール評価時に t() を呼ばない掟とセット）
	async function setLang(code) {
		const n = norm(code);
		if (n) lang = n;
		return loadLang(getLang());
	}
	async function loadLang(code) {
		const c = norm(code) ?? "en";
		if (c === "en" || packs[c]) return c;
		try { packs[c] = (await load(c)) || {}; }
		catch { packs[c] = {}; }                                      // 訳が無い＝英語のまま（読めない時も同じ＝UI を止めない）
		return c;
	}
	// 頁ごとの辞書を本体の表に足す（import は頁側が書く＝vite の glob はその頁の 25 本だけを chunk にする）。en は表を持たない
	async function loadPage(importer, code = getLang()) {
		const c = norm(code) ?? "en";
		if (c === "en") return c;
		try { registerPack(c, (await importer(c)).default); }
		catch { /* 表が無い＝英語のまま */ }
		return c;
	}
	function registerPack(code, table) { const c = norm(code); if (c) packs[c] = { ...packs[c], ...table }; }   // 外部から訳を差し替える口
	const isRTL = (code = getLang()) => RTL.has(code);
	const langName = code => (langs.find(l => l.code === norm(code)) || {}).name || "";
	const display = key => { const i = key.indexOf(CTX_SEP); return i < 0 ? key : key.slice(0, i); };
	function t(key, ...args) {
		const p = packs[getLang()];
		const s = (p && p[key]) || display(key);                      // 訳が無い／"" ＝英語（キー）へ落ちる＝欠落も「意図して英語」も同じ道
		return args.length ? s.replace(/\$(\d)/g, (_, i) => { const v = args[Number(i) - 1]; return v === undefined ? "$" + i : String(v); }) : s;
	}
	const tr = () => t;                                               // 各モジュールの口（const t = tr();）
	const has = key => !!packs[getLang()]?.[key];                     // 訳がある（英語のまま出ていない）
	// 雛形の [data-t]（文字）と [data-t-title]（title＝aria-label）をその場で訳へ（solar の作法）
	function applyDom(root = document) {
		for (const el of root.querySelectorAll("[data-t]")) el.textContent = t(el.dataset.t || el.textContent.trim());
		for (const el of root.querySelectorAll("[data-t-title]")) { el.title = t(el.dataset.tTitle || el.title); el.setAttribute("aria-label", el.title); }
	}
	// 頁（または容れ物）の lang / dir を今の言語に（RTL＝quiet-mono の論理プロパティで家具が鏡像になる）
	function applyHtml(el = document.documentElement) { el.lang = getLang(); el.dir = isRTL() ? "rtl" : "ltr"; return el; }
	return { getLang, setLang, loadLang, loadPage, registerPack, isRTL, langName, LANGUAGES: langs, norm, t, tr, has, applyDom, applyHtml };
}
