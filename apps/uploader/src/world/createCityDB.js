// 原典: packages/world/createCityDB.js（旧 #inline("RVkHIUhP")）
// 置換: d3.wiki→wiki(common) / d3.slice|thenEach→common / getHeight→ctx（altpbf createGetHeight）。ロジックは原典のまま。
import { thenEach, slice } from "common";
import { wiki } from "common/wiki.js";
import { rename, addLanguage, fixLanguage } from "./db.js";

const THIS_YEAR = new Date().getFullYear();   // 旧実装は 2025 固定＝翌年から今年のデータを全部弾く罠だった

export async function createCityDB(ctx, toLangs) {
	const { loadNationDB, saveCityDB } = ctx.db, { getHeight } = ctx;
	const yomi_array = [
		//	["東京","トウキョウ"],["横浜","ヨコハマ"],["大阪","オオサカ"],["名古屋","ナゴヤ"],["札幌","サッポロ"],["福岡","フクオカ"],
		//	["川崎","カワサキ"],["神戸","コウベ"],["京都","キョウト"],["さいたま","サイタマ"],["広島","ヒロシマ"],["仙台","センダイ"],
		["仁川", "インチョン"], ["蔚山", "ウルサン"], ["光州", "クァンジュ"], ["大邱", "テグ"], ["大田", "テジョン"], ["釜山", "プサン"],
		["平壌", "ピョンヤン"],
		["台北", "タイペイ"], ["高雄", "カオシュン"], ["新北", "シンペイ"], ["台中", "タイチョン"], ["台南", "タイナン"], ["桃園", "タオユェン"], ["彰化", "チャンホワ"],
		["北京", "ペキン"], ["鞍山", "アンシャン"], ["安丘", "アンチュウ"], ["宜興", "イーシン"], ["益陽", "イーヤン"], ["煙台", "イェンタイ"],
		["無錫", "ウーシー"], ["武進", "ウージン"], ["武漢", "ウーハン"], ["濰坊", "ウェイファン"], ["温州", "ウェンヂョウ"], ["温嶺", "ウェンリン"],
		["烏魯木斉", "ウルムチ"], ["鄂州", "オゥーヂョウ"], ["高州", "カオチョウ"], ["広安", "グァンアン"], ["広州", "グアンヂョウ"], ["桂平", "グイピン"],
		["貴港", "グエガン"], ["昆明", "クンミン"], ["貴陽", "コイヤン"], ["公主嶺", "ゴンヂューリン"], ["棗荘", "ザオヂュアン"], ["棗陽", "ザオヤン"],
		["江陰", "ジァンイン"], ["江都", "ジァンドゥー"], ["西安", "シーアン"], ["石家荘", "シージャーズォアン"], ["錫山", "シーシャン"], ["済南", "ジーナン"],
		["済寧", "ジーニン"], ["即墨", "ジーモー"], ["仙桃", "シェンタオ"], ["深圳", "シェンヂェン"], ["瀋陽", "シェンヤン"], ["簡陽", "ジェンヤン"],
		["廈門", "シャーメン"], ["蕭山", "シャオシャン"], ["江津", "ジャンジン"], ["商丘", "シャンチュウ"], ["項城", "シャンチョン"], ["汕頭", "シャントウ"],
		["上海", "シャンハイ"], ["徐州", "シューィヂョウ"], ["宣威", "シュエンウェイ"], ["順徳", "シュンダー"], ["寿光", "ショウグァン"], ["諸城", "ショジョウ"],
		["晋江", "ジンジアン"], ["新泰", "シンタイ"], ["荊州", "ジンヂョウ"], ["興化", "シンフア"], ["信陽", "シンヤン"], ["随州", "スイヂョウ"],
		["遂寧", "スイニン"], ["宿州", "スーヂョウ"], ["蘇州", "スーヂョウ"], ["淄博", "ズーボー"], ["資陽", "ズーヤン"], ["鄭州", "ズェンヂョウ"],
		["鄒城", "ズォウチョン"], ["中山", "ズォンシャン"], ["大慶", "ダーチン"], ["大同", "ダートン"], ["大連", "ダーリエン"], ["泰安", "タイアン"],
		["泰興", "タイシン"], ["台州", "タイヂョウ"], ["太原", "タイユアン"], ["唐山", "タンシャン"], ["啓東", "チードン"], ["赤峰", "チーフォン"],
		["吉林", "ヂーリン"], ["斉斉哈爾", "チチハル"], ["潮陽", "チャオヤン"], ["湛江", "チャンジァン"], ["長沙", "チャンシャー"], ["常熟", "チャンスゥオー"],
		["常徳", "チャンダー"], ["長春", "チャンチュン"], ["常州", "チャンヂョウ"], ["諸曁", "ヂュージー"], ["泉州", "チュワンヂョウ"], ["鍾祥", "ヂョンシャン"],
		["欽州", "チンジョウ"], ["青島", "チンダオ"], ["自貢", "ツーゴン"], ["慈渓", "ツーシー"], ["成都", "ツェンドゥー"], ["重慶", "ツォンチン"],
		["天水", "ティエンシュイ"], ["天津", "ティエンジン"], ["天門", "ティエンメン"], ["定州", "ティンチョウ"], ["鄧州", "テンチョウ"], ["東莞", "ドングアン"],
		["東台", "ドンタイ"], ["滕州", "トンヂョウ"], ["通州", "トンヂョウ"], ["南安", "ナンアン"], ["南京", "ナンジン"], ["南昌", "ナンチャン"],
		["南充", "ナンチョン"], ["南寧", "ナンニン"], ["南海", "ナンハイ"], ["南陽", "ナンヤン"], ["寧波", "ニンポー"], ["内江", "ネイジャン"],
		["哈爾浜", "ハルピン"], ["巴中", "バーヂョン"], ["合肥", "ハーフェイ"], ["海城", "ハイチョン"], ["包頭", "パオトウ"], ["邯鄲", "ハンダン"],
		["漢川", "ハンチュアン"], ["杭州", "ハンヂョウ"], ["畢節", "ビージェー"], ["邳州", "ピーヂョウ"], ["平度", "ピンドゥ"], ["淮南", "ファイナン"],
		["撫順", "フーシュン"], ["福州", "フーヂョウ"], ["撫州", "フーヂョウ"], ["湖州", "フーヂョウ"], ["福清", "フーチン"], ["普寧", "プーニン"],
		["富陽", "フーヤン"], ["豊城", "フォンチョン"], ["呼和浩特", "フフホト"], ["北流", "ベイリュウ"], ["淮安", "ホァイアン"], ["化州", "ホアチョウ"],
		["合川", "ホーチュアン"], ["亳州", "ボーヂョウ"], ["菏沢", "ホーヅー"], ["香港", "ホンコン"], ["麻城", "マーチョン"], ["綿陽", "ミエンヤン"],
		["牡丹江", "ムーダンジァン"], ["禹州", "ユィヂョウ"], ["玉樹", "ユーシュー"], ["楽清", "ユエチン"], ["永城", "ヨンチョン"], ["楽山", "ラーシャン"],
		["莱蕪", "ライウー"], ["蘭州", "ランチョウ"], ["日照", "リーザオ"], ["廉江", "リェンジャン"], ["柳州", "リュウヂョウ"], ["瀏陽", "リュウヤン"],
		["臨沂", "リンイー"], ["瑞安", "ルイアン"], ["六安", "ルーアン"], ["如皋", "ルーガオ"], ["瀘州", "ルーヂョウ"], ["陸豊", "ルーフォン"],
		["洛陽", "ルオヤン"], ["雷州", "レイジョウ"], ["耒陽", "レイヤン"],
	];
	const yomi_map = {}; yomi_array.forEach(t => yomi_map[t[0]] = t[1]);
	const kanji_map = {}; yomi_array.forEach(t => (kanji_map[t[1]] = kanji_map[t[1]] || [], kanji_map[t[1]].push(t[0])));
	////---------------------------------------
	for (let t in kanji_map) { kanji_map[t].length == 1 ? kanji_map[t] = kanji_map[t][0] : delete kanji_map[t]; }
	var cities = await getCities();
	cities = await cleanCities(cities, toLangs);
	await getCoords(cities);
	await population(cities);
	cities = cities.sort((p, q) => (p.yomi || p.name.ja) > (q.yomi || q.name.ja) ? 1 : -1);
	await saveCityDB(cities);
	return cities;
	////---------------------------------------
	async function getCities() {
		const html = await wiki.getContent("100万都市の一覧");
		var list = [...html.querySelector(".mw-parser-output").children];
		let start, end;
		list.forEach((t, i) => {
			t.innerText.match(/^一覧/) && (start = i);
			t.innerText.match(/^脚注/) && (end = i);
		});
		list = list.slice(start + 1, end).filter(t => !t.classList.contains('mw-heading3'));
		list = slice(list, 3);
		list = list.map((t) => {
			var nation = t[0].querySelector("h4").innerText;
			var date = +t[1].innerText.match(/^(\d+)年/)[1];
			var cities = [...t[2].querySelectorAll("li")].map(t => {
				[...t.querySelectorAll("sup")].forEach(t => t.remove());
				var [name, population] = t.innerText.split("：");
				name = wiki.clean(name);
				population = Math.round((+population.replace("万人", "")) * 10000);
				var title = t.querySelector("a").title;
				return { name: { ja: name }, title, nation, population: [date, population] };
			});
			return cities;
		}).flat();
		list = list.concat([
			{ name: { ja: "ケープタウン" }, title: "ケープタウン", nation: "南アフリカ", population: [2018, 3776000] },
			{ name: { ja: "ブルームフォンテーン" }, title: "ブルームフォンテーン", nation: "南アフリカ", population: [2011, 256185] },
			{ name: { ja: "ラパス" }, title: "ラパス", nation: "ボリビア", population: [2012, 758845] },
			{ name: { ja: "コトヌー" }, title: "コトヌー", nation: "ベナン", population: [2013, 679012] },
			{ name: { ja: "コロンボ" }, title: "コロンボ", nation: "スリランカ", population: [2011, 752993] },
		]);
		return list;
	}
	////---------------------------------------
	async function cleanCities(cities, toLangs) {
		const nations = await loadNationDB();
		const capital_map = {}; nations.filter(t => t.capital).forEach(nation => capital_map[nation.name.ja] = nation.capital.wiki.ja);
		cities = cities.filter(t => !["萊蕪", "香港"].includes(t.name.ja));//合併された市, 香港
		cities.forEach(t => {
			t.name.ja = ({ "バタム市": "バタム" })[t.name.ja] || t.name.ja;
			t.title = ({ "東京都区部": "東京都", "バタム (都市) (存在しないページ)": "バタム島" })[t.title] || t.title;
			t.nation = rename(t.nation);
			if (!capital_map[t.nation]) console.warn(t.nation);
		});
		var titles = cities.map(t => t.title);
		var ids = await wiki.title2id(titles);
		ids.forEach((t, i) => cities[i].wiki = { ja: t });
		var capitals = [];
		var bigcities = [];
		nations.forEach(nation => {
			if (!nation.capital) return;
			const name = nation.name.ja, wikiId = nation.capital.wiki.ja;
			const city = cities.filter(t => t.nation == name);
			const v = { name: nation.capital.name, wiki: nation.capital.wiki, nation: name, capital: true }
			capitals.push(v);
			city.forEach(t => t.wiki.ja == wikiId ? (v.population = t.population) : bigcities.push(t));
		});
		////----------------------------------- 重複する都市をまとめる
		const tub = {}; capitals.forEach(t => { tub[t.wiki.ja] = tub[t.wiki.ja] || []; tub[t.wiki.ja].push(t) });
		capitals = Object.values(tub).map(v => {
			var a = v.map(t => t.nation);
			a.length > 1 && (v[0].nation = a);
			return v[0];
		})
		console.log(capitals);
		////----------------------------------- 各言語の名称及びwikiIDの生成
		await addLanguage(bigcities, toLangs, "ja")
		bigcities.forEach(t => (delete t.title));
		const fix = [
			[["ja", "カリヤーン・ドンビヴリ"], [["zh", "卡扬多姆比维利"], ["ko", "칼얀 돔비블리"]]],
			[["ja", "バサイ・ビラール"], [["ko", "바사이 빌라"]]],
			[["ja", "バタム"], [["ko", "바탐"]]],
		];
		await fixLanguage(bigcities, fix);
		bigcities.forEach(async t => {
			if (t.name.zh && t.name.ko) {
				if (t.name.zh.match(/[廣广]域市$/) && t.name.ko.match(/광역시$/)) {
					t.name.zh = t.name.zh.replace(/[廣广]域市$/, ""), t.name.ko = t.name.ko.replace(/광역시$/, "");
				} else if (t.name.zh.match(/市$/) && t.name.ko.match(/시$/)) {
					t.name.zh = t.name.zh.replace(/市$/, ""), t.name.ko = t.name.ko.replace(/시$/, "");
				}
			}
		});
		console.log(bigcities)
		const a = [].concat(bigcities, capitals);
		a.forEach(async t => {
			kanji_map[t.name.ja] && (t.name.ja = kanji_map[t.name.ja]);
			yomi_map[t.name.ja] && (t.yomi = yomi_map[t.name.ja]);
			if (!(t.yomi || t.name.ja).match(/^[ァ-ンヴー・＝]+$/)) console.warn("読み", t.name.ja, t.yomi);
		});
		return a;
	}
	////---------------------------------------
	async function getCoords(cities) {
		// wiki.en が引けなかった都市は座標取得をスキップ（旧実装は undefined id で wiki API がクラッシュし得た）
		const targets = cities.filter(t => t.wiki && t.wiki.en);
		cities.filter(t => !(t.wiki && t.wiki.en)).forEach(t => console.warn("no wiki.en（座標スキップ）:", t.name.ja));
		var coords = await wiki.id2coords(targets.map(t => t.wiki.en), "en");
		await thenEach(targets, async (t, i) => {
			if (coords[i]) {
				t.coords = coords[i].map(t => +t.toFixed(6));
				t.coords[2] = Math.round(await getHeight(...t.coords));
				console.log(t.name.ja, t.coords);
			}
		});
	}
	////---------------------------------------
	async function population(cities) {
		const def = ({
			3389: [2020, 615],//バチカン
			41492: [2023, 674500], // ヘルシンキ
			315803: [2024, 53543], // ダラムサラ
			382702: [2006, 426], // ヌクノノ
			401359: [2024, 880], // キングストン
			1878889: [2024, 8000], // ステパナケルト
			3434635: [2011, 5416], // ブカ
			4006407: [2024, 20], // キング・エドワード・ポイント
			570926: [-1, 0], // プリマス
			2862496: [-1, 500], // ンゲルルムッド
			185725: [-1, 58000]//サイパン島
		});
		await thenEach(cities, async t => {
			const html = await wiki.getContent(t.wiki.ja);
			var value = Math.round(人口(html)), year = 年(html);
			t.population = (value && year) ? [year, value] : (t.population || def[t.wiki.ja]);
			(value && year) || console.log(t.name.ja, [year, value], t.population, "https://ja.wikipedia.org/?curid=" + t.wiki.ja);
			if (!Array.isArray(t.population)) {
				console.warn("no population data", t.name.ja, "https://ja.wikipedia.org/?curid=" + t.wiki.ja);
				t.population = [-1, 0];   // 欠測 sentinel を NationDB 系（[-1, 値]）と統一（旧 [0,0]）
			}
		});
		function 年(html) {
			const info = html.querySelector("#infoboxCountry") || html.querySelector(".infobox"); if (!info) return 0;
			var y = info.innerText.match(/\((20[0-9]{2})\)/) || info.innerText.match(/(20[0-9]{2})年/) || info.innerText.match(/(20[0-9]{2})/);
			y = y ? +y[1] : 0; return (y > THIS_YEAR || y < 2000) ? 0 : y;
		}
		function 人口(html) {
			const info = html.querySelector("#infoboxCountry") || html.querySelector(".infobox"); if (!info) return 0;
			const clean = s => wiki.clean(s).replace(/\s/g, "")
			var a = [...info.querySelectorAll("td table td")].concat([...info.querySelectorAll("td")]).map(t => clean(t.innerText).replace(/人\//, ""))//.filter(t=>t.length<50);
			var v = a.filter(t => t.match(/\d[\.万]?人/));
			if (v[0]) {
				v = v[0].split("人")[0].replace(/[^0-9\.万]/g, "");
				if (!v.match(/万/)) return +v;
				v = v.split("万").map(t => +t); return v[0] * 10000 + v[1];
			}
			return 0;
		}
	}
}
