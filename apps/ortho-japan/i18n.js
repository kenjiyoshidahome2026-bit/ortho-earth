// UI文字列の二言語化（ja正典・enは辞書引き）。地図の中身（地名等の描画テキスト）は対象外＝かなピボット戦線（別戦線）。
//
// 作法（各ガジェットが自分の辞書を持参する＝三戒:独立・遅延チャンクに文字列も同乗）：
//   import { tr } from "../i18n.js";
//   const t = tr({ "計測開始": "Start measuring", "{0}件": "{0} items" });
//   el.title = t("計測開始");          // ja=キーそのまま・en=辞書引き・未訳=jaのまま出る（欠落が隠れない）
//   el.textContent = t("{0}件", n);    // {0}{1}…＝引数差し込み（ja/en共通の一本道）
//
// 言語解決の優先順位：orthoJapan({ lang }) > ?lang= > navigator.language（ja系→ja・それ以外→en）
//   正典コードは "ja"/"en"。歴史的別名 "jp" は受けて "ja" へ正規化。
//   （.scenes台本の jp:/en: フィールドは別系統＝demo.js の T() が scene[lang] で解決する。ここはUIの衣だけ）
//
// 将来の多言語化の口：registerPack("de", {jaキー: 訳})＝外部言語パック（assetBase のJSON等）を後入れできる。
//   その日が来ても呼び出し側 t("…") は不変＝辞書だけが増える。
let lang = null;   // 未解決＝最初の getLang() で判定（setLang が先に来ればそちらが勝つ）

const norm = c => {
	const s = String(c || "").toLowerCase();
	if (s === "jp" || s.startsWith("ja")) return "ja";
	return s ? "en" : null;   // ja以外の明示指定は当面すべて en（持参辞書が en のみのため。パック後入れで将来拡張）
};

export function setLang(c) { const n = norm(c); if (n) lang = n; }
export function getLang() {
	if (!lang) {
		const q = typeof location !== "undefined" ? new URLSearchParams(location.search).get("lang") : null;
		lang = norm(q) ?? norm(typeof navigator !== "undefined" ? navigator.language : null) ?? "en";
	}
	return lang;
}

const packs = {};   // 外部言語パック { en: {ja文: 訳}, … }。持参辞書より優先＝後から訳を差し替えられる
export function registerPack(code, table) { const c = norm(code); if (c) packs[c] = { ...packs[c], ...table }; }

export const tr = dict => (key, ...args) => {
	const s = getLang() === "ja" ? key : (packs[getLang()]?.[key] ?? dict?.[key] ?? key);
	return args.length ? s.replace(/\{(\d)\}/g, (_, i) => String(args[i] ?? "")) : s;
};
