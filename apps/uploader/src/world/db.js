// ── 国別DB（world）の置き場と共有ロジック ──
// 原典: packages/world/create.js（旧システム・bucket プロジェクト b1qEpPlw）。移植台帳は packages/world/README.md。
// 旧 bucket API との対応:
//   loadObject/saveObject → JSON 一個（get/put・拡張子 .json）
//   loadFiles/saveFiles   → zip 一括（gets/puts・国旗/音源/geoms）
// wiki 系は旧 d3.wiki の現行移植＝common/wiki.js を使う。
import * as d3 from 'd3';
import { thenEach, thenMap } from "common";
import { wiki } from "common/wiki.js";

export const DIRE = "GIS/world";
export const toLangs = ["en", "zh", "ko"];

// bucket 内のファイル名の幹（旧システムのオブジェクト名をそのまま踏襲）
export const SEED = "国名一覧";
export const NATION = "NationDB";
export const CITY = "CityDB";
export const LANGUAGE = "LanguageDB";
export const CURRENCY = "CurrencyDB";
export const FLAG = "国旗";
export const SOUND = "音源";
export const CONFLICT = "Conflicts";
export const GEOMS = "geoms";

// 表記ゆれ→正規名（データソース側の国名表記を NationDB の name.ja に寄せる変換表）
export const renames = {
	"アメリカ合衆国": "アメリカ",
	"アメリカ領ヴァージン諸島": "米領バージン諸島",
	"アメリカ領バージン諸島": "米領バージン諸島",
	"アメリカ領サモア": "米領サモア",
	"イギリス領ヴァージン諸島": "英領バージン諸島",
	"イギリス領バージン諸島": "英領バージン諸島",
	"イラン・イスラム共和国": "イラン",
	"コートジボワール": "コートジボアール",
	"コンゴ共和国": "コンゴ",
	"サウスジョージア・サウスサンドウィッチ諸島": "南ジョージア島・南サンドイッチ諸島",
	"サン・バルテルミー": "サン・バルテルミー島",
	"シリア・アラブ共和国": "シリア",
	"中央アフリカ共和国": "中央アフリカ",
	"ドミニカ国": "ドミニカ",
	"パプアニューギニア": "パプア・ニューギニア",
	"バミューダ": "バミューダ諸島",
	"ピトケアン": "ピトケアン諸島",
	"ブルネイ・ダルサラーム": "ブルネイ",
	"ベネズエラ・ボリバル共和国": "ベネズエラ",
	"ボネール、シント・ユースタティウスおよびサバ": "オランダ領カリブ",
	"ボリビア多民族国": "ボリビア",
	"マラウイ": "マラウィ",
	"ミクロネシア連邦": "ミクロネシア",
	"モルドバ共和国": "モルドバ",
	"ラオス人民民主共和国": "ラオス",
	"ロシア連邦": "ロシア",
	"南アフリカ共和国": "南アフリカ",
	"韓国": "大韓民国",
	"北朝鮮": "朝鮮民主主義人民共和国",
	"中国": "中華人民共和国",
	"台湾": "中華民国",
	"台湾地区": "中華民国",
	"チャイニーズタイペイ": "中華民国",
	"チェコ共和国": "チェコ",
	"スロバキア共和国": "スロバキア",
	"グルジア": "ジョージア",
	"ジョージア（グルジア）": "ジョージア",
	"スワジランド": "エスワティニ",
	"エスワティニ（スワジランド）": "エスワティニ",
	"カーボヴェルデ": "カーボベルデ",
	"セントクリストファー・ネービス": "セントクリストファー・ネイビス",
	"セントビンセントおよびグレナディーン諸島": "セントビンセント・グレナディーン",
	"キュラソー島": "キュラソー",
	"アングィラ": "アンギラ",
	"マルビナス諸島": "フォークランド諸島",
	"フォークランド諸島 (マルビナス諸島)": "フォークランド諸島",
	"セントヘレナ": "セントヘレナ・アセンションおよびトリスタンダクーニャ",
	"アセンション島": "セントヘレナ・アセンションおよびトリスタンダクーニャ",
	"トリスタン・ダ・クーニャ": "セントヘレナ・アセンションおよびトリスタンダクーニャ",
	"スヴァールバル諸島": "スヴァールバル諸島およびヤンマイエン島",
	"ヤンマイエン島": "スヴァールバル諸島およびヤンマイエン島",
	"バチカン": "バチカン市国",
	"サン・マルタン島": "サン・マルタン",
	"ガーンジー島": "ガーンジー",
	"ジャージー島": "ジャージー",
	"マヨット島": "マヨット",
	"北マケドニア共和国": "北マケドニア",
	"モンゴル国": "モンゴル",
	"タイ王国": "タイ",
	"マリ共和国": "マリ",
	"パレスチナ国": "パレスチナ",
	"オランダ王国": "オランダ",
	"デンマーク王国": "デンマーク",
};
export const rename = s => (renames[s] || s);

// ── キー台帳（2026-08-31 明確化・Kenji 裁定「現実的にキーを明確化」）──
// 国の正キー = key: ISO 3166-1 alpha-2 があればそれ。無い国はこの表（NE disputed の B コード・
// X 接尾の擬似コード・FR-CP）。旧実装はこの表が3箇所に散っていた（消費側 draw.js の isox /
// createNationDB の setConflicts / createGeometryPNG の fixISO）＝ここが唯一の正本。
// 命名は Conflicts/CurrencyDB/LanguageDB と同じ `key`（旧 seed の key 列＝無ければ英語名、は廃止・
// 消費側 draw.js の isox はこれの前身＝Kenji 裁定で統合 2026-08-31）。
// 【キー体系の契約】
//   国        : key（ビルド時に焼き込み・全国一意）
//   都市      : wiki.ja（Wikipedia 日本語版 pageid）・city.nation は name.ja（内部参照）
//   通貨      : ISO 4217（NationDB.currency は キー配列 に正規化）
//   言語      : LANG_KEYS のキー（ISO 639 風・NationDB.languages は キー配列 に正規化）
//   紛争      : Conflicts の key（NE disputed BRK_A3 の B コード系）
//   内部参照（territory/conflict/旗/geoPNG/音源のファイル名）: name.ja＝renames の影響を受けない閉じた名前空間
export const NATION_KEYS = {
	"アフガニスタン・イスラム共和国": "AFX",
	"北キプロス・トルコ共和国": "B20",
	"ソマリランド": "B30",
	"アブハジア": "B35",
	"沿ドニエストル共和国": "B36",
	"南オセチア": "B37",
	"アルツァフ共和国": "B38",
	"クリミア共和国": "B89",
	"ドネツク人民共和国": "C02",
	"ルガンスク人民共和国": "C03",
	// 西サハラは ISO 準拠で key=EH（iso から導出＝この表に不要）。SADR は他の未承認国家（B20/B30…）と同型の B コード。
	// 旧実装の EHX/「EH=SADR」の付け替えは政治的主張になるため廃止（Kenji 裁定 2026-08-31）。
	"サハラ・アラブ民主共和国": "B28",
	"クリッパートン島": "FR-CP",
};
export const nationKey = t => (t.iso ? t.iso[0] : NATION_KEYS[t.name.ja]);

// 言語のキー台帳（ISO 639 風・"hi/ur" や "zh'" 等の擬似キーを含む独自体系）。
// 原典は createLanguageDB 内の langDefinition＝LanguageDB 作成と NationDB.languages の正規化の両方が使うためここへ移設。
export const LANG_KEYS = [
	["aa", "アファル語"], ["ab", "アブハズ語"], ["aeb", "チュニジア語"], ["af", "アフリカーンス語"], ["am", "アムハラ語"],
	["ar", "アラビア語"], ["ay", "アイマラ語"], ["az", "アゼルバイジャン語"], ["be", "ベラルーシ語"], ["ber", "ベルベル語"],
	["bg", "ブルガリア語"], ["bi", "ビスラマ語"], ["bm", "バンバラ語"], ["bn", "ベンガル語"], ["bnt", "バントゥー諸語"],
	["bo", "チベット語"], ["bs", "ボスニア語"], ["ca", "カタルーニャ語"], ["cal", "カロリン語"], ["ce", "チェチェン語"],
	["ch", "チャモロ語"], ["cnr", "モンテネグロ語"], ["crs", "セーシェル・クレオール語"], ["cs", "チェコ語"], ["da", "デンマーク語"],
	["de", "ドイツ語"], ["dv", "ディベヒ語"], ["dyu", "ジュラ語"], ["dz", "ゾンカ語"], ["el", "ギリシア語"],
	["en", "英語"], ["es", "スペイン語"], ["et", "エストニア語"], ["fa", "ペルシア語"], ["ff", "フラニ語"],
	["fi", "フィンランド語"], ["fj", "フィジー語"], ["fo", "フェロー語"], ["fr", "フランス語"], ["ga", "アイルランド語"],
	["gil", "キリバス語"], ["gn", "グアラニー語"], ["gv", "マン島語"], ["he", "ヘブライ語"], ["hi", "ヒンディー語"],
	["hi/ur", "ヒンドゥスターニー語"], ["ho", "ヒリモツ語"], ["hr", "クロアチア語"], ["ht", "ハイチ語"], ["hu", "ハンガリー語"],
	["hy", "アルメニア語"], ["id", "インドネシア語"], ["is", "アイスランド語"], ["it", "イタリア語"], ["ja", "日本語"],
	["ka", "ジョージア語"], ["kea", "カーボベルデ・クレオール語"], ["kk", "カザフ語"], ["kl", "グリーンランド語"], ["km", "クメール語"],
	["ko", "朝鮮語"], ["ku", "クルド語"], ["ky", "キルギス語"], ["la", "ラテン語"], ["lb", "ルクセンブルク語"],
	["lo", "ラーオ語"], ["lt", "リトアニア語"], ["lv", "ラトビア語"], ["mfe", "モーリシャス・クレオール語"], ["mg", "マダガスカル語"],
	["mh", "マーシャル語"], ["mi", "マオリ語"], ["mk", "マケドニア語"], ["mn", "モンゴル語"], ["mos", "ムーア語"],
	["ms", "マレー語"], ["mt", "マルタ語"], ["my", "ビルマ語"], ["na", "ナウル語"], ["nd", "北ンデベレ語"],
	["ne", "ネパール語"], ["niu", "ニウエ語"], ["nl", "オランダ語"], ["no", "ノルウェー語"], ["nrf", "ジャージー語"],
	["ny", "チェワ語"], ["om", "オロモ語"], ["os", "オセット語"], ["pap", "パピアメント語"], ["pau", "パラオ語"],
	["pih", "ピトケアン語"], ["pih'", "ノーフォーク語"], ["pis", "ピジン語"], ["pl", "ポーランド語"], ["prs", "ダリー語"],
	["ps", "パシュトー語"], ["pt", "ポルトガル語"], ["qu", "ケチュア語"], ["rar", "ラロトンガ語"], ["rcf", "レユニオン・クレオール語"],
	["rm", "ロマンシュ語"], ["rn", "ルンディ語"], ["ro", "ルーマニア語"], ["rom", "ロマ語"], ["ron", "モルドバ語"],
	["ru", "ロシア語"], ["rup", "アルーマニア語"], ["rw", "ルワンダ語"], ["seh", "セナ語"], ["sg", "サンゴ語"],
	["si", "シンハラ語"], ["sk", "スロバキア語"], ["sl", "スロベニア語"], ["sm", "サモア語"], ["smi", "サーミ語"],
	["sn", "ショナ語"], ["so", "ソマリ語"], ["sov", "ソンソロール語"], ["sq", "アルバニア語"], ["sr", "セルビア語"],
	["srn", "スラナン語"], ["ss", "スワジ語"], ["st", "ソト語"], ["sv", "スウェーデン語"], ["sw", "スワヒリ語"],
	["ta", "タミル語"], ["tet", "テトゥン語"], ["tg", "タジク語"], ["th", "タイ語"], ["ti", "ティグリニャ語"],
	["tk", "トルクメン語"], ["tkl", "トケラウ語"], ["tl", "フィリピン語"], ["tn", "ツワナ語"], ["tox", "トビ語"],
	["tr", "トルコ語"], ["ts", "ツォンガ語"], ["tt", "タタール語"], ["tvl", "ツバル語"], ["ty", "タヒチ語"],
	["uk", "ウクライナ語"], ["ur", "ウルドゥー語"], ["uz", "ウズベク語"], ["ve", "ヴェンダ語"], ["vi", "ベトナム語"],
	["xh", "コサ語"], ["zh'", "広東語"], ["zdj", "コモロ語"], ["zh", "中国語"],
];
export const langKey = {};  LANG_KEYS.forEach(t => langKey[t[1]] = t[0]);   // 日本語名 → キー
export const langName = {}; LANG_KEYS.forEach(t => langName[t[0]] = t[1]);  // キー → 日本語名

// ── NationDB の最終化（ビルドの最終工程・ここ以外でパッチしない）──
// 旧システムは load 側で毎回パッチしていた（例外除去+クリッパートン追加）＝非冪等:
// createCurrencyDB が load 結果を save し戻すたびクリッパートンが増殖し、例外5地域が保存から消えていた。
// 保存されるものを完成形にし、load は素通しにする（2026-08-31 冪等化）。
export function finalizeNationDB(nations) {
	const exceptions = ["クルディスタン", "ダルフール", "チェチェン共和国", "チベット", "ブーゲンビル"];
	// クリッパートン島はここでの追補をやめ、seed の1行として通常パイプラインで作る（浮かせない＝Kenji 裁定 2026-08-31）。
	// seed に行が無い場合の既定行は createNationDB.careteList が補う。旧データ由来の重複は下の dedup が掃除。
	const seen = new Set();
	const v = nations.filter(t => !exceptions.includes(t.name.ja))
		.filter(t => seen.has(t.name.ja) ? false : (seen.add(t.name.ja), true));   // name.ja 重複の後勝ち防止＝冪等
	v.forEach(t => {
		// 正キー key の焼き込み（キー台帳＝NATION_KEYS。旧実装は消費側 draw.js の isox に同じ表が居た）
		t.key = nationKey(t);
		if (!t.key) console.warn("key なし（キー台帳 NATION_KEYS へ追加を検討）:", t.name.ja);
		// currency をキー配列へ正規化（旧: wikiInfos は単一文字列・createCurrencyDB は "USD|PAB" パイプ連結の二形）
		if (typeof t.currency == "string") t.currency = t.currency ? t.currency.split("|") : undefined;
		// languages をキー配列へ正規化（旧: 日本語名の配列＝LanguageDB の key が未使用だった）。
		// 表に無い名前は素通し+warn＝LANG_KEYS の拡充で収束させる（キー済みの値は再変換されない＝冪等）
		if (Array.isArray(t.languages)) t.languages = t.languages.map(s => {
			if (langKey[s]) return langKey[s];
			if (!langName[s]) console.warn("言語キー未定義（LANG_KEYS へ追加を検討）:", s, "@", t.name.ja);
			return s;
		});
	});
	return v;
}

// bucket（native-bucket の Bucket("GIS/world") インスタンス）を束ねて load/save 一式を返す。
// 保存形式＝{ updated, count, items } の版スタンプ包み。旧システム書き出しの素の配列もそのまま読める。
export function makeDB(bucket) {
	const unwrap = v => (v && v.items !== undefined) ? v.items : v;
	const loadJSON = async name => unwrap(await bucket.get(`${name}.json`, "json"));
	const saveJSON = (name, a) => {
		const wrapped = { updated: new Date().toISOString().slice(0, 10), count: Array.isArray(a) ? a.length : undefined, items: a };
		return bucket.put(new File([JSON.stringify(wrapped)], `${name}.json`, { type: "application/json" }));
	};
	const loadSeed = () => loadJSON(SEED);
	const saveSeed = a => saveJSON(SEED, a);
	// 素通し load（パッチは finalizeNationDB＝ビルド側へ移動）。旧システム書き出しの未最終化データが
	// 混ざっても壊れないよう、読み時に finalize を冪等適用（既に最終化済みなら無変化）。
	async function loadNationDB() {
		const v = await loadJSON(NATION);
		return v ? finalizeNationDB(v) : v;
	}
	return {
		loadSeed, saveSeed, loadNationDB,
		saveNationDB: a => saveJSON(NATION, finalizeNationDB(a)),
		loadCityDB: () => loadJSON(CITY), saveCityDB: a => saveJSON(CITY, a),
		loadLanguageDB: () => loadJSON(LANGUAGE), saveLanguageDB: a => saveJSON(LANGUAGE, a),
		loadCurrencyDB: () => loadJSON(CURRENCY), saveCurrencyDB: a => saveJSON(CURRENCY, a),
		loadConflicts: () => loadJSON(CONFLICT), saveConflicts: a => saveJSON(CONFLICT, a),
		loadFlagDB: () => bucket.gets(FLAG), saveFlagDB: files => bucket.puts(`${FLAG}.zip`, files),
		loadSoundDB: () => bucket.gets(SOUND), saveSoundDB: files => bucket.puts(`${SOUND}.zip`, files),
		loadGeoPNG: () => bucket.gets(GEOMS), saveGeoPNG: files => bucket.puts(`${GEOMS}.zip`, files),
		loadJSON, saveJSON,
	};
}

// ── wiki 連携（旧 create.js から移植・d3.wiki→common/wiki.js）──
// db の各要素 t は { name: {ja,en,...}, wiki: {ja: pageid, ...} } の形。
export async function createWiki(db, lang) {
	const names = db.map(t => t.name[lang]);
	const wikis = await wiki.title2id(names, lang);
	wikis.forEach((t, i) => { t || console.warn("fail to convert (title-id)", names[i]); });
	db.forEach((t, i) => {
		t.wiki = t.wiki || {}, t.wiki[lang] = wikis[i];
		t.name[lang] = wiki.clean(t.name[lang]).split(",")[0];
	});
}
export async function addLanguage(db, toLangs, fromLang = "en") {
	toLangs = Array.isArray(toLangs) ? toLangs : [toLangs];
	var errs = {};
	await thenEach(toLangs, t => loop(t, fromLang));
	Object.entries(errs).forEach(t => console.warn("conversion failed", t[0], ...t[1]));
	async function loop(toLang, fromLang = "en") {
		const ids = db.map(t => t.wiki[fromLang]);
		var target = await wiki.id2langlink(ids, toLang, fromLang);
		var wikis = await wiki.title2id(target, toLang);
		target = target.map(t => wiki.clean(t).split(",")[0]);
		console.log(target);
		db.forEach((t, i) => {
			target[i] && (t.name[toLang] = target[i]);
			wikis[i] && (t.wiki[toLang] = wikis[i]);
			if (!(t.name[toLang] && t.wiki[toLang])) {
				errs[t.name[fromLang]] = errs[t.name[fromLang]] || [];
				errs[t.name[fromLang]].push(toLang);
			}
		});
	}
}
export function removeLanguage(db, langs) {
	(Array.isArray(langs) ? langs : [langs]).forEach(loop);
	function loop(lang) {
		db.forEach(t => { delete t.name[lang]; delete t.wiki[lang]; });
	}
}
// def = [[[langFrom, nameFrom], [[langTo, nameTo], ...]], ...] の手直し表を db へ適用
export async function fixLanguage(db, def, convert_flag) {
	await thenEach(def, async ([[langFrom, nameFrom], to]) => {
		const target = db.filter(t => t.name[langFrom] == nameFrom)[0];
		if (!target) return console.warn(`fixLanguage: 対象なし（表記変更?）: ${langFrom}=${nameFrom}`);
		await thenEach(to, async ([langTo, nameTo]) => {
			if (target.name[langTo]) console.log("overwriting", target.name[langTo], nameTo);
			target.name[langTo] = nameTo;
			convert_flag && (target.wiki[langTo] = await wiki.title2id(nameTo, langTo));
		});
		console.log(target);
	});
}

// ── 紛争地域（Conflicts.csv → DB）── 行は配列（列順は旧CSVのまま: key,type,region,title_en,name_en,title_ja,exist,iso,sovereignt,claim）
export async function createConflicts(conflicts, nationDB) {
	var iso_tub = {}; nationDB.forEach(t => t.iso && (iso_tub[t.iso[0]] = t));
	conflicts = conflicts.map(t => ({ key: t[0], type: t[1], region: t[2], title_en: t[3], title_ja: t[5], name: { en: t[4] || t[3], ja: t[5] }, exist: !!t[6], sovereignt: t[8], iso: t[7] || undefined, claim: t[9] ? t[9].split("|") : undefined }));
	conflicts.forEach(t => {
		var key = (t.iso || t.sovereignt); if (key == "Self") key = "";
		var sovereignt = (key && iso_tub[key]) ? iso_tub[key].name.ja : "---";
		console.log(t.key, t.name.ja, t.type, sovereignt, t.claim ? t.claim.map(t => iso_tub[t].name.ja) : "");
	});
	var en = conflicts.map(t => t.title_en);
	var ja = conflicts.map(t => t.title_ja);
	await createWiki(conflicts, "en");
	await addLanguage(conflicts, ["ja", "zh", "ko"], "en");
	await thenEach(conflicts, async t => {
		if (!t.wiki.ja) {
			var id = await wiki.title2id(t.title_ja);
			if (id) console.log("!!!!!!!!!!!!!", t.title_ja, t.wiki.ja = id);
		}
	});
	conflicts.forEach((t, i) => (t.name.en = en[i], t.name.ja = ja[i], delete t.title_en, delete t.title_ja));
	return conflicts;
}

// CSV blob → 行配列（旧 bucket.blob2csv 相当＝ヘッダ行なしの生行列）。
// 旧実装同様、数値/真偽/null は型に戻す（seed の wiki.ja 列は数値の pageid ＝文字列のままだと wiki API がタイトル扱いする）。
export async function blob2rows(blob) {
	const conv = s => s === "true" ? true : s === "false" ? false : s === "null" ? null :
		(s !== "" && !isNaN(s) && isFinite(s)) ? +s : s;
	// BOM 剥がしは必須＝実物の 国名一覧.csv は BOM 付きで、d3-dsv は剥がさない（先頭セルが壊れる実測 2026-08-31）
	const text = (await blob.text()).replace(/^\uFEFF/, "");
	return d3.csvParseRows(text, row => row.map(conv));
}
