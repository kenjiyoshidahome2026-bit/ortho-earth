// 原典: packages/world/createNationalDB.js（旧 #inline("qjpQx44Y")）
// 置換: d3.wiki→wiki(common) / d3.thenMap等→common / bucket.getCSV|getTEXT→Fetch(type) / d3.cache→Cache(native-bucket)
// グローバル（loadSeed/saveNationDB/loadConflicts/renames…）→ ctx.db と ./db.js から供給。ロジックは原典のまま。
import { thenMap, thenEach, thread, unique, trim, L2 } from "common";
import { Cache } from "native-bucket";
import { wiki } from "common/wiki.js";
import { renames, rename, addLanguage, fixLanguage, finalizeNationDB } from "./db.js";

const THIS_YEAR = new Date().getFullYear();   // 旧実装は 2025 固定＝翌年から今年のデータを全部弾く罠だった
// 年次更新はここ（HDR の版が上がったら URL と下の slice コメントを合わせて見直す）
const HDR_CSV = "https://hdr.undp.org/sites/default/files/2023-24_HDR/HDR23-24_Composite_indices_complete_time_series.csv";

export async function createNationDB(ctx, toLangs) {
	const { loadSeed, saveNationDB, loadConflicts } = ctx.db, { Fetch } = ctx;
	// 前提の検札を先に＝数十分のクロール後に setConflicts で死なない
	const conflictsDB = await loadConflicts();
	if (!conflictsDB) throw new Error("Conflicts が未収蔵＝先に Conflicts.json（または Conflicts.csv）をドロップしてください");
	const seed = await loadSeed();
	if (!seed) throw new Error("国名一覧（seed）が未収蔵＝先に 国名一覧.csv をドロップしてください");
	const nations = await careteList();
	await Promise.all([un(nations), iso(nations), ioc(nations)]);   // 相互独立＝並列（wiki 3表）
	// 統計は「APIごとに1レーン」＝同一バックエンドへの同時発射で 504/瞬断を誘発した実測（2026-08-31）の教訓。
	// WB は頑丈なので3本並列可・DBnomics と sekai-hub は各1レーン直列・レーン同士は並列（iso 完了後＝ISO3 結合が前提）
	const lane = fs => (async () => { for (const f of fs) await f(nations); })();
	await Promise.all([population(nations), gni(nations), gnipc(nations), hdi(nations),
		lane([gdp, gdppc, ppp, ppppc]), lane([gpi, psi])]);
	//	console.log(nations)
	//	return;
	const ename = nations.map(t => t.name.en);
	await addLanguage(nations, toLangs, "ja");
	nations.map((t, i) => t.name.en = ename[i]);
	{   // 国ごとの wiki ページ読み（~260件・初回が最重量）＝並列4本。IDB キャッシュ後の再実行は数秒
		// ⚠ thread は a.shift() で配列を破壊する＝必ずコピーを渡す（nations 本体を空にすると後段が全滅）
		let done = 0;
		await thread(nations.slice(), async t => {
			try { await wikiInfos(t); } catch (e) { console.warn("wikiInfos失敗:", t.name.ja, e.message); }
			(++done % 25) || console.log(`wikiInfos: ${done}/${nations.length}`);
		}, 4);
	}
	await capital(nations, toLangs);
	await setConflicts(nations);
	await saveNationDB(nations);   // saveNationDB 内で finalizeNationDB（例外除去+クリッパートン追補）＝保存形が完成形
	return finalizeNationDB(nations);
	////==================================================================================================================
	async function careteList() {
		const csv = seed.slice();
		// クリッパートン島は通常の1行として処理（旧実装は load 側の後付けパッチだった）。
		// seed 未収録の間だけ既定行で補う＝国名一覧.csv へ行を足せばこのフォールバックは沈黙する。
		if (!csv.some(t => t[0] == "クリッパートン島")) {
			console.warn("seed に クリッパートン島 が無い＝既定行で補完（国名一覧.csv への追加を推奨）");
			csv.push(["クリッパートン島", "", "", "Clipperton Island", "", "", 4, "", 161127, "フランス", "", "クリッパートン"]);
		}
		return csv.map(t => {//[name.ja, extend.ja, capital.ja, name.en, extend.en, capital.en, region, key, wiki.ja, territory, conflit, yomi ]
			const q = { name: {}, wiki: {} };
			q.name.ja = t[0]; t[1] && t[1] != "_" && (q.extend = q.extend || {}, q.extend.ja = t[1]);
			q.name.en = t[3]; t[4] && t[4] != "_" && (q.extend = q.extend || {}, q.extend.en = t[4]);
			t[2] && t[5] && (q.capital = { name: { ja: t[2], en: t[5] } });
			q.region = t[6];
			// t[7]（旧 key 列＝無ければ英語名）は廃止＝正キー key は finalizeNationDB が焼き込む（iso2 || NATION_KEYS）
			q.wiki.ja = t[8];
			t[9] && (q.territory = t[9]);
			t[10] && (q.conflict = t[10]);
			q.yomi = (t[11] || t[0]).substring(0, 5);
			return q;
		});
	}
	////==================================================================================================================
	async function capital(nations, toLangs) {
		const tub = nations.map(t => t.capital).filter(t => t);
		const names = tub.map(t => t.wikiName || t.name.ja);
		const ids = await wiki.title2id(names);
		tub.forEach((t, i) => { t.wiki = { ja: ids[i] }; delete t.wikiName; });
		await addLanguage(tub, toLangs, "ja");
		tub.map(t => t.name).forEach(t => {
			if (t.zh && t.ko) {
				if (t.zh.match(/[廣广]域市$/) && t.ko.match(/광역시$/)) {
					t.zh = t.zh.replace(/[廣广]域市$/, ""), t.ko = t.ko.replace(/광역시$/, "");
				} else if (t.zh.match(/特別市$/) && t.ko.match(/특별시$/)) {
					t.zh = t.zh.replace(/特別市$/, ""), t.ko = t.ko.replace(/특별시$/, "");
				} else if (t.zh.match(/市$/) && t.ko.match(/시$/)) {
					t.zh = t.zh.replace(/市$/, ""), t.ko = t.ko.replace(/시$/, "");
				} else if (t.zh.match(/都$/) && t.ko.match(/도$/)) {
					t.zh = t.zh.replace(/都$/, ""), t.ko = t.ko.replace(/도$/, "");
				}
			}
		});
		const fix = [
			[["ja", "ポルトーフランセ"], [["ko", "포르토 프란세"]]],
			[["ja", "キング・エドワード・ポイント"], [["ko", "킹 에드워드 포인트"]]],
		];
		await fixLanguage(tub, fix);
	}
	////-----------------------------------------------------------------------
	async function wikiInfos(nation) {
		const name = nation.name.ja, capital = nation.capital ? nation.capital.name.ja : "", wikiId = nation.wiki.ja;
		// 2026-08-31: ja.wikipedia の基礎情報国テンプレートから infoboxCountry/infoboxCountryDataB クラスが消滅
		// （素の .infobox + th 見出しの構造へ）＝旧セレクタ依存の首都/言語/国歌が全国で空になった。掴みは三段フォールバック。
		const html = await wiki.getContent(wikiId), info = html.getElementById("infoboxCountry") || html.querySelector(".infobox") || html.body;
		////-------------------------------------要約
		//	q.extract = 要約(html);
		////-------------------------------------首都
		var cap = 首都(info, name); if (cap == "" && capital) console.warn("no_capital: ", name);
		// seed に首都が無い国（nation.capital 未定義）で wiki 側に首都行がある場合は書き込み先が無い＝warn に留める（旧実装は TypeError の地雷）
		if (capital != cap && !["香港", "マカオ", "パラオ", "パレスチナ"].includes(name)) {
			if (nation.capital) nation.capital.wikiName = cap;
			else if (cap) console.warn("capital_without_seed: ", name, cap);
		}
		if (capital.replace(/(島)$/, "") != wiki.clean(cap).replace(/(島|市|地区|特別市|都)$/, "")) console.log(name, capital, "<=>", cap);
		////-------------------------------------人口
		nation.population = nation.population || 人口(info, name); if (!nation.population) console.warn("no_population: ", name)
		////-------------------------------------面積
		nation.area = 面積(info, name); if (!nation.area) console.warn("no_area: ", name)
		////-------------------------------------言語
		nation.languages = 言語(info, name); if (nation.languages.length == 0 && capital) console.warn("no_language: ", name);
		////-------------------------------------通貨
		nation.currency = 通貨(info); //if (nation.languages.length == 0 && capital) console.warn("no_language: ",name);
		////-------------------------------------国歌
		nation.anthem = 国歌(info);
		function 要約(html) {
			const c = [...html.querySelector(".mw-parser-output").children];
			var p = [], i = 0;
			if (html.querySelector("#infoboxCountry")) { while (!c[i].id == "infoboxCountry") i++; }
			else if (html.querySelector(".infobox")) { while (!c[i].classList.contains('infobox')) i++; }
			while (c[i] && c[i].tagName != 'P') i++;
			while (c[i] && c[i].tagName == 'P') p.push(c[i++]);
			return p.map(t => { t.querySelector("#coordinates") && t.querySelector("#coordinates").remove(); return wiki.clean(t.innerText); });
		}
		function 首都(html, name) {
			if (name == "スヴァールバル諸島およびヤンマイエン島") return "ロングイェールビーン";
			if (name == "西サハラ") return "ラユーン";
			var v = [...html.querySelectorAll("tr")].filter(t => t.querySelector("th") && t.querySelector("th").innerText.match(/(首都|首府|州都|主都|行政所在地)/));
			if (v[0] && v[0].querySelector("td a")) {
				const capital = v[0].querySelector("td a").getAttribute("title");
				return (capital.match(/(都市国家|存在しないページ)/)) ? name : capital;
			}
			return "";
		}
		function 人口(html, name) {
			var def = {
				"クリッパートン島": [-1, 0],
				"イギリス領インド洋地域": [-1, 3500],
				"スヴァールバル諸島およびヤンマイエン島": [-1, 2630],
				"ダルフール": [-1, 6000000],
				"チベット": [-1, 100000],
				"ハード島とマクドナルド諸島": [-1, 0],
				"ブーベ島": [-1, 0],
				"フランス領南方・南極地域": [-1, 140],
				"合衆国領有小離島": [2009, 300],
				"南ジョージア島・南サンドイッチ諸島": [-1, 0],
				"南極": [-1, 1000],
			}
			var value = Math.round(人口(html)), year = 年(html);
			return (value && year) ? [year, value] : def[name] ? def[name] : null;
			function 年(html) {
				var y = html.innerText.match(/\((20[0-9]{2})\)/) || html.innerText.match(/(20[0-9]{2})年/) || html.innerText.match(/(20[0-9]{2})/);
				y = y ? +y[1] : 0; return (y > THIS_YEAR || y < 2000) ? 0 : y;
			}
			function 人口(html) {
				const clean = s => wiki.clean(s).replace(/\s/g, "")
				var a = [...html.querySelectorAll("td table td")].concat([...html.querySelectorAll("td")]).map(t => clean(t.innerText).replace(/人\//, ""))//.filter(t=>t.length<50);
				var v = a.filter(t => t.match(/\d[\.万]?人/));
				if (v[0]) {
					v = v[0].replace(/^.+位/, "").split("人")[0].replace(/[^0-9\.万]/g, "");
					if (!v.match(/万/)) return +v;
					v = v.split("万").map(t => +t); return v[0] * 10000 + v[1];
				}
				return 0;
			}
		}
		function 面積(html, name) {
			const rep = {
				クリッパートン島: 6,
				アルツァフ共和国: 3170, ドネツク人民共和国: 8539, チベット: 2500000,
				フランス領南方・南極地域: 7781, 米領バージン諸島: 347, 西サハラ: 266000,
				オランダ: 37354, デンマーク: 43094, ノルウェー: 323802
			}
			if (name in rep) return rep[name];
			const v = [...html.querySelectorAll("tr td")].filter(t => !t.querySelector("table")).map(t => wiki.clean(t.innerText));
			const reg = /[^0-9][0-9\,\.万]+\s*(km2|km²)/g;
			const conv = s => {
				s = s.substring(1).replace(/[\,\s]/g, "").replace(/(km2|km²)$/, "")
				s = s.split(/万/).map(t => +t); s = s.length == 2 ? s[0] * 10000 + s[1] : s[0];
				return (s > 10) ? Math.round(s) : s;
			};
			const area = v.join("|").match(reg) || html.innerText.match(reg) || [];
			return area.length == 1 ? conv(area[0]) : 0;
		}
		function 言語(html, name) {
			if (name == "西サハラ") return ["アラビア語", "ベルベル語", "スペイン語"]
			const v = [...html.querySelectorAll("tr")].filter(t => t.querySelector("th") && t.querySelector("th").innerText.match(/(公用語)/));
			return unique((v[0] && v[0].querySelector("td a")) ?
				[...v[0].querySelectorAll("td a")].filter(t => t.getAttribute("title") && t.getAttribute("title").match(/^.+語$/))
					.map(t => {
						t = wiki.clean(t.innerText);
						t = ({ 韓国語: "朝鮮語", シャンガーン語: "ツォンガ語" })[t] || t;
						let r = t.match(/.*(フランス|スペイン|ポルトガル|ヒンディー|マレー|タタール|中国)語$/); if (r) return r[1] + "語";
						return (t.match(/(公用語|共通語|.+の言語)/) || t == "国語") ? "" : t;
					}).filter(t => t) : [])
		}
		function 通貨(html) {
			const def = {
				アフガニスタン・イスラム共和国: "AFN",
				ドネツク人民共和国: "RUB", ルガンスク人民共和国: "RUB", クリミア共和国: "RUB",
				アルツァフ共和国: "AMD", チェチェン共和国: "RUB", ダルフール: "SDG"
			};
			var c = html.querySelector("a[title='ISO 4217']"); if (!c) return def[nation.name.ja] || "";
			c = c.innerText || ""; return c.match(/^[A-Z]{3,4}$/) ? c : ""
		}
		function 国歌(html) {
			const anthem = [...html.querySelectorAll("[src]")].map(t => t.getAttribute("src"))
				.filter(s => s.match(/\.mp3$/))[0];
			return anthem ? "https:" + anthem : "";
		}
	}
	////-------------------------------------------------------------------------------------------------------
	////	UN(国際連合)
	////-------------------------------------------------------------------------------------------------------
	// wiki 表の隠しソートキー（<span style="display:none">カンコク</span>韓国）は detached DOM の innerText に混入する
	// ＝「カンコク 韓国」型の突合失敗の根因（2026-08-31 実マークアップ確認）。読む前に除去する。
	function unhide(html) { [...html.querySelectorAll('[style*="display:none"]')].forEach(t => t.remove()); return html; }   // function宣言＝巻き上げ（const だと main 流れの un() 呼び出しが TDZ を踏む）
	async function un(nations) {
		var names = nations.map(t => t.name.ja);
		const todate = s => s.match(/(\d+)年(\d+)月(\d+)日/).slice(1, 4).map((t, i) => i ? L2(t) : t).join("/");
		const html = unhide(await wiki.getContent("国際連合加盟国"));
		const list = [...html.querySelectorAll("table tr")]
			.map(t => [...t.querySelectorAll("td")])
			.filter(t => t.length == 5).map(t => [t[0], t[1], t[3]].map(t => wiki.clean(trim(t.innerText))))
			.map(t => [t[0], todate(t[1]), t[2].split(/\s/).slice(1)])
		console.log(list);
		var tub = {};
		list.forEach(t => {
			var name = renames[t[0]] || t[0];
			names.includes(name) || console.warn("un: seed未突合（renames要追加?）:", t[0]);
			tub[name] = [t[1]];
			t[2] = t[2].map(t => renames[t] || t);
			t[2].forEach(t => names.includes(t) || console.warn("un(未承認side): seed未突合:", t));
			t[2].length && tub[name].push(t[2]);
		});
		nations.forEach(t => tub[t.name.ja] && (t.un = tub[t.name.ja]));
	}
	////-------------------------------------------------------------------------------------------------------
	////	ISO-3166
	////-------------------------------------------------------------------------------------------------------
	async function iso(nations) {
		var names = nations.map(t => t.name.ja);
		const html = unhide(await wiki.getContent("ISO_3166-1"));
		const list = [...html.querySelectorAll("table tr")]
			.map(t => [...t.querySelectorAll("td")])
			.filter(t => t.length == 8)
			.map(t => [t[0], t[5], t[4], t[3], t[6]].map(t => wiki.clean(trim(t.innerText))))
		console.log(list);
		var tub = {};
		list.forEach(t => {
			var name = renames[t[0]] || t[0];
			names.includes(name) || console.warn("iso: seed未突合（renames要追加?）:", t[0]);
			tub[name] = [t[1], t[2], +t[3]];
		});
		// 西サハラは ISO 表のまま＝EH は「地理的実体・西サハラ」に付く（ISO 準拠＝Kenji 裁定 2026-08-31）。
		// 旧実装は EH をサハラ・アラブ民主共和国へ付け替えていた＝「ISO実体=SADR国家」という政治的主張になっており、
		// UN 非自治地域フィルタ（EH を含む）が SADR にマッチする実害もあった。SADR は未承認国家として key=B28（NATION_KEYS）。
		tub["コソボ"] = ["XK", "KSV", 111];//コソボは正式ではない・・・
		nations.forEach(t => tub[t.name.ja] && (t.iso = tub[t.name.ja]));
	}
	////-------------------------------------------------------------------------------------------------------
	////	IOC
	////-------------------------------------------------------------------------------------------------------
	async function ioc(nations) {
		var names = nations.map(t => t.name.ja);
		const html = unhide(await wiki.getContent("IOCコード一覧"));
		const list = [...html.querySelectorAll("table tr")]
			.map(t => [...t.querySelectorAll("td")])
			.filter(t => t.length == 6)
			.map(t => [t[1], t[0], t[2], t[4]].map(t => wiki.clean(trim(t.innerText)))).filter(t => t[1]);
		console.log(list);
		const tub = {};
		list.forEach(t => {
			var name = renames[t[0]] || t[0];
			names.includes(name) || console.warn("ioc: seed未突合（renames要追加?）:", t[0]);
			tub[name] = [t[1], +t[3]];
		})
		nations.forEach(t => t.ioc = tub[t.name.ja]);
	}
	////-------------------------------------------------------------------------------------------------------
	////	HDI
	////-------------------------------------------------------------------------------------------------------
	async function hdi(nations) {
		const csv = await Fetch(HDR_CSV, "csv");
		console.log(csv[0].slice(5, 38), csv[0].slice(171, 204), csv[0].slice(137, 170));
		const tub = {};
		csv.filter(t => String(t[0]).length == 3).forEach(t => {
			var p = tub[t[0]] = {};
			p.hdi = [2022].concat(t.slice(5, 38).reverse().map(t => +t));
		});
		nations.forEach(t => {
			if (t.iso && t.iso[1] && tub[t.iso[1]]) {
				t.hdi = tub[t.iso[1]].hdi.slice(0, 5);
			}
		})
	}
	////-------------------------------------------------------------------------------------------------------
	////	population / gdp / gni / ppp / gpi / psi
	////-------------------------------------------------------------------------------------------------------
	// ── 統計は一次ソースの公式 API へ（2026-08-31・Kenji「sekai-hubよりいい先は?」）──
	// World Bank: CORS 開放＝ブラウザ直（プロキシ/キー不要）。IMF DataMapper: 公式 JSON・予測年込み（proxy 経由）。
	// どちらも ISO3 で直結＝日本語名の名寄せ（renames 突合）が統計から消える。単位は旧形式に合わせる（金額=百万USD）。
	// GPI/PSI（IEP）だけ API が無いので sekai-hub の template を継続。
	function population(nations) { return worldbank(nations, "population", "SP.POP.TOTL", 2010); }        // 出所は UN WPP
	// imf() の第6引数＝World Bank フォールバック [indicator, scale]。DBnomics 全停止（2026-08-31 実測 25秒無応答）でも
	// 実績値で完走する劣化運転（IMF 予測年は落ちる）。次回 DBnomics 復帰時の実行で上書きされる。
	function gdp(nations) { return imf(nations, "gdp", "NGDPD", 2013, 1000, ["NY.GDP.MKTP.CD", 1e-6]); }  // 10億USD→百万USD
	function gdppc(nations) { return imf(nations, "gdppc", "NGDPDPC", 2017, 1, ["NY.GDP.PCAP.CD", 1]); }
	function gni(nations) { return worldbank(nations, "gni", "NY.GNP.MKTP.CD", 2021, 1e-6); }             // USD→百万USD
	function gnipc(nations) { return worldbank(nations, "gnipc", "NY.GNP.PCAP.CD", 2021); }
	function ppp(nations) { return imf(nations, "ppp", "PPPGDP", 2022, 1000, ["NY.GDP.MKTP.PP.CD", 1e-6]); }
	function ppppc(nations) { return imf(nations, "ppppc", "PPPPC", 2022, 1, ["NY.GDP.PCAP.PP.CD", 1]); }
	function gpi(nations) { return template(nations, 2024, 2021, "gpi", "global-peace-index-ranking", 3); }
	function psi(nations) { return template(nations, 2024, 2021, "psi", "security-ranking", 3); }
	////-------------------------------------------------------------------------------------------------------
	// リトライ3回＋IDB スティッキーキャッシュ＝成功を保存し、不達時は前回取得で続行（DBnomics の一時 504 実測 2026-08-31。
	// エラー応答は CORS ヘッダ無し＝ブラウザからは CORS エラーに見えるが実体はゲートウェイ瞬断）
	async function statJSON(title, key, url) {
		const idb = statJSON.idb = statJSON.idb || (await Cache("world/stats"));
		let v = null;
		for (let i = 0; i < 3 && !v; i++) {
			if (i) { console.log(`${title}: 再試行 ${i}…`); await new Promise(r => setTimeout(r, 3000 * i)); }
			v = await fetch(url, { signal: AbortSignal.timeout(20000) }).then(r => r.ok ? r.json() : null).catch(() => null);
		}
		if (v) { await idb(key, v); return v; }
		v = await idb(key);
		if (v) { console.warn(`${title}: API 不達＝前回取得（IDB）で続行`); return v; }
		return null;
	}
	async function worldbank(nations, title, indicator, end, scale = 1) {
		const url = `https://api.worldbank.org/v2/country/all/indicator/${indicator}?format=json&per_page=20000&date=${end}:${THIS_YEAR}`;
		const v = await statJSON(title, "wb:" + indicator, url);   // CORS 開放＝素の fetch で直
		if (!v || !v[1]) return console.warn(`${title}: World Bank(${indicator}) 取得失敗`);
		const tub = {};
		(v[1] || []).forEach(r => { if (r.value != null && r.countryiso3code) (tub[r.countryiso3code] = tub[r.countryiso3code] || {})[+r.date] = r.value * scale; });
		assign(nations, title, tub, end);
	}
	async function imf(nations, title, subject, end, scale = 1, wbFallback) {
		// IMF 直（datamapper API）は Akamai が非ブラウザ指紋を 403 で弾く（2026-08-31 実測・UA偽装でも不可）
		// ＝IMF WEO の公式ミラー DBnomics から引く。CORS 開放（Origin エコー）＝ブラウザ直・proxy 不要。
		// series_code は "AFG.NGDPD.us_dollars" 形式＝ISO3 接頭・予測年込み・欠測は "NA"。
		const url = `https://api.db.nomics.world/v22/series/IMF/WEO:latest?dimensions=${encodeURIComponent(JSON.stringify({ "weo-subject": [subject] }))}&observations=1&limit=1000`;
		const v = await statJSON(title, "weo:" + subject, url);
		const docs = v && v.series && v.series.docs || [];
		if (!docs.length) {
			if (wbFallback) { console.warn(`${title}: DBnomics 不達＝World Bank 実績値で代替（IMF 予測年なし・次回復帰時に上書き）`); return worldbank(nations, title, wbFallback[0], end, wbFallback[1]); }
			return console.warn(`${title}: DBnomics(WEO/${subject}) 取得失敗`);
		}
		const tub = {};
		docs.forEach(sr => {
			const iso3 = sr.series_code.split(".")[0], years = {};
			sr.period.forEach((y, i) => { const val = sr.value[i]; if (typeof val == "number") years[+y] = val * scale; });
			tub[iso3] = years;
		});
		assign(nations, title, tub, end);
	}
	// 旧形式のまま格納: t[title] = [最新年, 最新年値, 前年値, ...]（欠測は undefined→JSONではnull）。結合キーは ISO3（iso[1]）
	function assign(nations, title, tub, end) {
		let latest = 0;
		Object.values(tub).forEach(years => Object.keys(years).forEach(y => { y = +y; if (y <= THIS_YEAR && y > latest) latest = y; }));
		if (!latest) return console.warn(`${title}: データなし`);
		let hit = 0;
		nations.forEach(t => {
			const d = t.iso && tub[t.iso[1]]; if (!d) return;
			const a = []; for (let y = latest; y >= end; y--) a.push(d[y] == null ? undefined : Math.round(d[y]));
			if (a.every(v => v === undefined)) return;
			t[title] = [latest].concat(a); hit++;
		});
		console.log(`${title}: ${latest}..${end}（${hit}か国）`);
	}
	////-------------------------------------------------------------------------------------------------------
	// start＝「この年までは存在すると分かっている年」（旧実装のハードコード起点）。実際の起点は
	// THIS_YEAR から下向きにプローブして最初に見つかった年＝年が明けても手直しゼロで最新を拾う。
	async function template(nations, start, end, title, url, n) {
		const tub = {};
		const names = nations.map(t => t.name.ja);
		let latest = 0;
		for (let y = THIS_YEAR; y >= start; y--) {
			if (await fetchTable(`https://sekai-hub.com/statistics/${url}-${y}`)) { latest = y; break; }
			console.log(`probe: ${title}(${y}) なし`);
		}
		if (!latest) return console.warn(`${title}: sekai-hub にページなし（${url}-${start}..${THIS_YEAR}）＝スキップ`);
		for (let y = latest; y >= end; y--) {
			const table = await fetchTable(`https://sekai-hub.com/statistics/${url}-${y}`);
			if (!table) { console.warn(`${title}(${y}): 取得失敗＝欠測のまま続行`); continue; }
			var a = [year0, year1, year2, year3][n](table);
			console.log(`reading: ${title}(${y})`)
			a.forEach(t => { tub[t[0]] = tub[t[0]] || []; tub[t[0]][latest - y] = t[1] });
		}
		const warns = Object.keys(tub).filter(t => !names.includes(t));
		warns.length && console.warn(`${title}: seed未突合 ${warns.length}件:`, warns.join("|"));
		nations.forEach(t => tub[t.name.ja] && (t[title] = [latest].concat(tub[t.name.ja])));
		////----------------------------------------
		// 成功したときだけ IDB へキャッシュ（404 を焼き込むと翌年のプローブが永久に「なし」を返す）。
		// 失敗時は「どの段階で落ちたか」を一行で出す＝check(門/存在)・body(取得)・内容(__NUXT_DATA__)の切り分け診断
		async function fetchTable(url) {
			var idb = fetchTable.idb = fetchTable.idb || (await Cache("wikiDB/html"));
			var v = await idb(url); if (v) return getTable(v);
			const HARD = Symbol();   // Fetch が throw＝実 404 等の確定失敗（再試行しない）
			const grab = () => Fetch(url, { type: "text", silent: true });
			v = await grab().catch(e => (console.log(`  fetch失敗(${url.split("/").pop()}): ${e.message}`), HARD));
			if (v === HARD) return null;
			if (!v) {   // check 段の静かな null＝検問/瞬断＝一度だけ再試行（並列バーストで実在ページが落ちた実測対策）
				await new Promise(r => setTimeout(r, 2000));
				v = await grab().catch(() => null);
			}
			if (!v) return null;
			if (!v.includes("__NUXT_DATA__")) {
				console.log(`  内容不一致(${url.split("/").pop()}): ${v.length}文字 先頭=「${v.slice(0, 80).replace(/\s+/g, " ")}」`);
				return null;
			}
			await idb(url, v);
			return getTable(v);
			function getTable(s) {
				var html = new DOMParser().parseFromString(s, "text/html");
				// \u002F 復元を追加＝sekai-hub が "</table>" を "<\u002Ftable>" と直列化する新形式に対応
				//（旧: \u003C のみ＝閉じタグ不一致で getTable が無言 null → gpi/psi 全滅の根因 2026-08-31）
				var s2 = html.getElementById("__NUXT_DATA__").innerText.replace(/\\u003C/g, "<").replace(/\\u002F/g, "/");
				var r = s2.match(/\<table.+\<\/table\>/g); if (!r) return null;
				s2 = new DOMParser().parseFromString(r[0].replace(/\\"/g, '"'), 'text/html');
				return [...s2.querySelectorAll("tr")].map(t => [...t.querySelectorAll("td")].map(t => t.innerText));
			};
		}
		function year0(table) {
			const num = s => {
				let r; s = s.replace(/^億/, "");
				r = s.match(/^([0-9]+)億([0-9]+)万([0-9]+)人$/); if (r) return ((+r[1]) * 10000 + (+r[2])) * 10000 + (+r[3]);
				r = s.match(/^([0-9]+)万([0-9]+)人$/); if (r) return (+r[1]) * 10000 + (+r[2]);
				r = s.match(/^([0-9]+)人$/); if (r) return +r[1];
				return 0;
			};
			return table.filter(t => t.length == 4).filter(t => t[1] != "世界合計").map(t => [rename(t[1]), num(t[2])]);
		}
		function year1(table) {
			const num = s => {
				let r;
				r = s.match(/^([0-9]+)兆([0-9]+)億([0-9]+)万ドル$/); if (r) return ((+r[1]) * 10000 + (+r[2])) * 10000 + (+r[3]);
				r = s.match(/^([0-9]+)億([0-9]+)万ドル$/); if (r) return (+r[1]) * 10000 + (+r[2]);
				r = s.match(/^([0-9]+)万ドル$/); if (r) return +r[1];
				return 0;
			};
			return table.filter(t => t.length == 4).filter(t => t[1] != "世界合計").map(t => [rename(t[1]), num(t[2]) / 100]);
		}
		function year2(table) {
			const num = s => s == "データ無し" ? 0 : +s.replace(/(\,|ドル)/g, "");
			return table.filter(t => t.length == 4).filter(t => t[1] != "世界平均").map(t => [rename(t[1]), num(t[2])]);
		}
		function year3(table) {
			return table.filter(t => t.length == 3).map(t => [rename(t[1]), +t[2]]);
		}
	}
	////-----------------------------------------------------------------------
	async function setConflicts(nations) {
		const sovereignt = {}, claim = {};
		conflictsDB.forEach(t => {   // 冒頭で検札済み（未収蔵なら開始前に止まる）
			if (t.sovereignt) {
				const s = t.iso || t.sovereignt;
				(sovereignt[s] = sovereignt[s] || []).push(t.key);
			}
			if (Array.isArray(t.claim)) t.claim.forEach(s => (claim[s] = claim[s] || []).push(t.key));
		});
		sovereignt["AF"] = ["AF"];
		// ── 西サハラの ISO 準拠整理（2026-08-31）──
		// EH＝ISO の地理的実体「西サハラ」。その領域は B19（モロッコ実効支配部）+ B28（自由地帯=SADR実効支配部）の全体。
		// 「主張」は西サハラ（領域）には帰属させない＝主張の主体は MA と SADR（B28）。
		// 旧 Conflicts.csv の B19/B28 行で SADR を "EH" と書いていた名残はここで上書き吸収（CSV 側の推奨修正は README）。
		sovereignt["EH"] = ["B19", "B28"];
		delete claim["EH"];
		////-----------------------------------------------------
		nations.forEach(t => {
			if (t.iso) {
				t.sovereignt = sovereignt[t.iso[0]];
				t.claim = claim[t.iso[0]];
				if (["US", "RU", "UM", "CA", "AQ"].includes(t.iso[0])) t.pole = true;
			} else {
				t.sovereignt = {
					"サハラ・アラブ民主共和国": ["B28"],
					"北キプロス・トルコ共和国": ["B20"],
					"ソマリランド": ["B30"],
					"アブハジア": ["B35"],
					"沿ドニエストル共和国": ["B36"],
					"南オセチア": ["B37"],
					"アルツァフ共和国": ["B38"],
					"コソボ": ["B57"],
					"クリミア共和国": ["B89"],
					"ドネツク人民共和国": ["C02"],
					"ルガンスク人民共和国": ["C03"],
				}[t.name.ja];
				t.claim = {
					"アフガニスタン・イスラム共和国": ["AF"],
					"サハラ・アラブ民主共和国": ["B19"],
				}[t.name.ja];
			}
		});
	}
}
