// 原典: packages/world/createLanguageDB.js（旧 #inline("r14WZUyG")）＝言語DBと通貨DBの二本立て
// 置換: d3.wiki→wiki(common) / d3.unique|thenEach→common。ロジックは原典のまま。
import { thenEach, unique } from "common";
import { wiki } from "common/wiki.js";
import { rename, createWiki, addLanguage, fixLanguage, LANG_KEYS, langName } from "./db.js";

export async function createLanguageDB(ctx, toLangs) {
	const { loadNationDB, saveLanguageDB } = ctx.db;
	// 言語の定義表は db.js の LANG_KEYS（キー台帳）へ移設＝NationDB.languages の正規化と共有。
	// NationDB.languages は finalize でキー化済み＝カバレッジ検札はキーの存在確認（未定義キーは finalize 側でも warn 済み）
	const nations = await loadNationDB();
	const langs = unique(nations.map(t => t.languages || []).flat()).sort((p, q) => p > q ? 1 : -1);
	langs.forEach(t => langName[t] ? console.log(t, langName[t]) : console.warn("LANG_KEYS 未定義:", t, "https://ja.wikipedia.org/wiki/" + t));
	const langDB = LANG_KEYS.map(t => ({ key: t[0], name: { ja: t[1] } }));
	await createWiki(langDB, "ja");
	await addLanguage(langDB, toLangs, "ja");
	await saveLanguageDB(langDB);
	return langDB;
}

export async function createCurrencyDB(ctx, toLangs) {
	const { loadNationDB, saveNationDB, saveCurrencyDB } = ctx.db;
	const html = await wiki.getContent("ISO_4217");
	const table = html.querySelector("table");
	var tub = {}, codes = {};
	[...table.querySelectorAll("tr")].map(t => [...t.querySelectorAll("td")]).filter(t => t.length == 5)
		.forEach(tds => {
			var name = (tds[3].querySelector("a") || {}).title; if (!name || name.match(/存在しないページ/)) return;
			var key = tds[0].querySelector("code").innerText; if (key.length != 3) console.warn(key);
			var num = +tds[1].querySelector("code").innerText; if (isNaN(num)) console.warn(num);
			var nations = [...tds[4].querySelectorAll("li a")].map(t => t.title)
				.map(t => wiki.clean(t)).filter(t => t).filter(t => !["欧州連合", "国際通貨基金", "オランダの旗"].includes(t)).map(rename);
			if (key == "AUD") nations = ["オーストラリア"];//記述ミス???
			if (!nations.length) return;
			var digit = +wiki.clean(tds[2].innerText); if (![0, 1, 2, 3, 4].includes(digit)) console.warn(key, digit)
			nations.forEach(t => { tub[t] = tub[t] || []; tub[t].push(key); });
			codes[key] = { key, name: { ja: name }, num, digit };
		});
	codes["PRB"] = { key: "PRB", name: { ja: "沿ドニエストル・ルーブル" }, num: 0, digit: 2 };//非正式
	codes["SLSH"] = { key: "SLSH", name: { ja: "ソマリランド・シリング" }, num: 0, digit: 2 };//非正式
	////-------------------------------------------------------------------------------------------
	Object.entries(tub).forEach(t => {
		t[1] = unique(t[1]);
		if (t[1].length != 1) console.log(t);
		tub[t[0]] = t[1].join("|");
	});
	////-------------------------------------------------------------------------------------------
	const nations = await loadNationDB();
	await thenEach(nations, async t => {
		// t.currency は finalize でキー配列化済み＝比較・検札も配列前提（保存時に再度 finalize が走るので代入はパイプ文字列でよい）
		const current = Array.isArray(t.currency) ? t.currency.join("|") : (t.currency || "");
		if (tub[t.name.ja]) {
			if (tub[t.name.ja] != current) console.log(t.name.ja, current, tub[t.name.ja])
			t.currency = tub[t.name.ja];
		} else if (!(t.currency || []).length || !(t.currency || []).every(k => codes[k])) {
			console.warn("nocurrency", t.name.ja, current)
		}
	});
	await saveNationDB(nations);
	////-------------------------------------------------------------------------------------------
	codes = Object.values(codes);
	await createWiki(codes, "ja");
	await addLanguage(codes, toLangs, "ja");
	const fix = [
		[["ja", "ボリバル・ソベラノ"], [["zh", "委內瑞拉玻利瓦爾"], ["ko", "베네수엘라 볼리바르"]]], //ベネズエラ新通貨
	];
	await fixLanguage(codes, fix, true);
	await saveCurrencyDB(codes);
	return codes;
}
