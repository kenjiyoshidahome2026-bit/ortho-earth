async function createLanguageDB(toLangs) {
	const langDefinition = [
		["aa", "アファル語"],
		["ab", "アブハズ語"],
		["aeb", "チュニジア語"],
		["af", "アフリカーンス語"],
		["am", "アムハラ語"],
		["ar", "アラビア語"],
		["ay", "アイマラ語"],
		["az", "アゼルバイジャン語"],
		["be", "ベラルーシ語"],
		["ber", "ベルベル語"],
		["bg", "ブルガリア語"],
		["bi", "ビスラマ語"],
		["bm", "バンバラ語"],
		["bn", "ベンガル語"],
		["bnt", "バントゥー諸語"],
		["bo", "チベット語"],
		["bs", "ボスニア語"],
		["ca", "カタルーニャ語"],
		["cal", "カロリン語"],
		["ce", "チェチェン語"],
		["ch", "チャモロ語"],
		["cnr", "モンテネグロ語"],
		["crs", "セーシェル・クレオール語"],
		["cs", "チェコ語"],
		["da", "デンマーク語"],
		["de", "ドイツ語"],
		["dv", "ディベヒ語"],
		["dyu", "ジュラ語"],
		["dz", "ゾンカ語"],
		["el", "ギリシア語"],
		["en", "英語"],
		["es", "スペイン語"],
		["et", "エストニア語"],
		["fa", "ペルシア語"],
		["ff", "フラニ語"],
		["fi", "フィンランド語"],
		["fj", "フィジー語"],
		["fo", "フェロー語"],
		["fr", "フランス語"],
		["ga", "アイルランド語"],
		["gil", "キリバス語"],
		["gn", "グアラニー語"],
		["gv", "マン島語"],
		["he", "ヘブライ語"],
		["hi", "ヒンディー語"],
		["hi/ur", "ヒンドゥスターニー語"],
		["ho", "ヒリモツ語"],
		["hr", "クロアチア語"],
		["ht", "ハイチ語"],
		["hu", "ハンガリー語"],
		["hy", "アルメニア語"],
		["id", "インドネシア語"],
		["is", "アイスランド語"],
		["it", "イタリア語"],
		["ja", "日本語"],
		["ka", "ジョージア語"],
		["kea", "カーボベルデ・クレオール語"],
		["kk", "カザフ語"],
		["kl", "グリーンランド語"],
		["km", "クメール語"],
		["ko", "朝鮮語"],
		//	["ko","韓国語"],
		["ku", "クルド語"],
		["ky", "キルギス語"],
		["la", "ラテン語"],
		["lb", "ルクセンブルク語"],
		["lo", "ラーオ語"],
		["lt", "リトアニア語"],
		["lv", "ラトビア語"],
		["mfe", "モーリシャス・クレオール語"],
		["mg", "マダガスカル語"],
		["mh", "マーシャル語"],
		["mi", "マオリ語"],
		["mk", "マケドニア語"],
		["mn", "モンゴル語"],
		["mos", "ムーア語"],
		["ms", "マレー語"],
		["mt", "マルタ語"],
		["my", "ビルマ語"],
		["na", "ナウル語"],
		["nd", "北ンデベレ語"],
		["ne", "ネパール語"],
		["niu", "ニウエ語"],
		["nl", "オランダ語"],
		["no", "ノルウェー語"],
		["nrf", "ジャージー語"],
		["ny", "チェワ語"],
		["om", "オロモ語"],
		["os", "オセット語"],
		["pap", "パピアメント語"],
		["pau", "パラオ語"],
		["pih", "ピトケアン語"],
		["pih'", "ノーフォーク語"],
		["pis", "ピジン語"],
		["pl", "ポーランド語"],
		["prs", "ダリー語"],
		["ps", "パシュトー語"],
		["pt", "ポルトガル語"],
		["qu", "ケチュア語"],
		["rar", "ラロトンガ語"],
		["rcf", "レユニオン・クレオール語"],
		["rm", "ロマンシュ語"],
		["rn", "ルンディ語"],
		["ro", "ルーマニア語"],
		["rom", "ロマ語"],
		["ron", "モルドバ語"],
		["ru", "ロシア語"],
		["rup", "アルーマニア語"],
		["rw", "ルワンダ語"],
		["seh", "セナ語"],
		["sg", "サンゴ語"],
		["si", "シンハラ語"],
		["sk", "スロバキア語"],
		["sl", "スロベニア語"],
		["sm", "サモア語"],
		["smi", "サーミ語"],
		["sn", "ショナ語"],
		["so", "ソマリ語"],
		["sov", "ソンソロール語"],
		["sq", "アルバニア語"],
		["sr", "セルビア語"],
		["srn", "スラナン語"],
		["ss", "スワジ語"],
		["st", "ソト語"],
		["sv", "スウェーデン語"],
		["sw", "スワヒリ語"],
		["ta", "タミル語"],
		["tet", "テトゥン語"],
		["tg", "タジク語"],
		["th", "タイ語"],
		["ti", "ティグリニャ語"],
		["tk", "トルクメン語"],
		["tkl", "トケラウ語"],
		["tl", "フィリピン語"],
		["tn", "ツワナ語"],
		["tox", "トビ語"],
		["tr", "トルコ語"],
		["ts", "ツォンガ語"],
		//	["ts","シャンガーン語"],
		["tt", "タタール語"],
		["tvl", "ツバル語"],
		["ty", "タヒチ語"],
		["uk", "ウクライナ語"],
		["ur", "ウルドゥー語"],
		["uz", "ウズベク語"],
		["ve", "ヴェンダ語"],
		["vi", "ベトナム語"],
		["xh", "コサ語"],
		["zh'", "広東語"],
		["zdj", "コモロ語"],
		["zh", "中国語"],
	];
	const langTub = {}; langDefinition.forEach(t => langTub[t[1]] = t[0]);
	const nations = await loadNationDB();
	const langs = d3.unique(nations.map(t => t.languages).flat()).sort((p, q) => p > q ? 1 : -1);
	langs.forEach(t => langTub[t] ? console.log(t, langTub[t]) : console.warn(t, "https://ja.wikipedia.org/wiki/" + t));
	const langDB = langDefinition.map(t => ({ key: t[0], name: { ja: t[1] } }));
	await createWiki(langDB, "ja");
	await addLanguage(langDB, toLangs, "ja");
	await saveLanguageDB(langDB);
}
async function createCurrencyDB(toLangs) {
	const html = await d3.wiki.getContent("ISO_4217");
	const table = html.querySelector("table");
	var tub = {}, codes = {};
	var a = [...table.querySelectorAll("tr")].map(t => [...t.querySelectorAll("td")]).filter(t => t.length == 5)
		.forEach(tds => {
			var name = (tds[3].querySelector("a") || {}).title; if (!name || name.match(/存在しないページ/)) return;
			var key = tds[0].querySelector("code").innerText; if (key.length != 3) console.warn(key);
			var num = +tds[1].querySelector("code").innerText; if (isNaN(num)) console.warn(num);
			var nations = [...tds[4].querySelectorAll("li a")].map(t => t.title)
				.map(t => d3.wiki.clean(t)).filter(t => t).filter(t => !["欧州連合", "国際通貨基金", "オランダの旗"].includes(t)).map(rename);
			if (key == "AUD") nations = ["オーストラリア"];//記述ミス???
			if (!nations.length) return;
			var digit = +d3.wiki.clean(tds[2].innerText); if (![0, 1, 2, 3, 4].includes(digit)) console.warn(key, digit)
			nations.forEach(t => { tub[t] = tub[t] || []; tub[t].push(key); });
			codes[key] = { key, name: { ja: name }, num, digit };
		});
	codes["PRB"] = { key: "PRB", name: { ja: "沿ドニエストル・ルーブル" }, num: 0, digit: 2 };//非正式
	codes["SLSH"] = { key: "SLSH", name: { ja: "ソマリランド・シリング" }, num: 0, digit: 2 };//非正式
	////-------------------------------------------------------------------------------------------
	Object.entries(tub).forEach(t => {
		t[1] = d3.unique(t[1]);
		if (t[1].length != 1) console.log(t);
		tub[t[0]] = t[1].join("|");
	});
	////-------------------------------------------------------------------------------------------
	const nations = await loadNationDB();
	await d3.thenEach(nations, async t => {
		if (tub[t.name.ja]) {
			if (tub[t.name.ja] != t.currency) console.log(t.name.ja, t.currency, tub[t.name.ja])
			t.currency = tub[t.name.ja];
		} else if (!codes[t.currency]) {
			console.warn("nocurrency", t.name.ja)
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
}
