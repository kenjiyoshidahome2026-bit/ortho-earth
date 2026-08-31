async function createNationDB(toLangs) {
	const nations = await careteList();
	await un(nations);
	await iso(nations);
	await ioc(nations);
	await population(nations);
	await gdp(nations); await gdppc(nations);
	await gni(nations); await gnipc(nations);
	await ppp(nations); await ppppc(nations);
	await gpi(nations); await psi(nations);
	await hdi(nations);
	//	console.log(nations)
	//	return;
	const ename = nations.map(t => t.name.en);
	await addLanguage(nations, toLangs, "ja");
	nations.map((t, i) => t.name.en = ename[i]);
	await d3.thenMap(nations, wikiInfos);
	await capital(nations, toLangs);
	await setConflicts(nations);
	await saveNationDB(nations);
	////==================================================================================================================
	async function careteList() {
		const csv = await loadSeed();
		return csv.map(t => {//[name.ja, extend.ja, capital.ja, name.en, extend.en, capital.en, region, key, wiki.ja, territory, conflit, yomi ]
			const q = { name: {}, wiki: {} };
			q.name.ja = t[0]; t[1] && t[1] != "_" && (q.extend = q.extend || {}, q.extend.ja = t[1]);
			q.name.en = t[3]; t[4] && t[4] != "_" && (q.extend = q.extend || {}, q.extend.en = t[4]);
			t[2] && t[5] && (q.capital = { name: { ja: t[2], en: t[5] } });
			q.region = t[6];
			q.key = t[7] || t[3];
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
		const ids = await d3.wiki.title2id(names);
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
		const name = nation.name.ja, capital = nation.capital ? nation.capital.name.ja : "", wiki = nation.wiki.ja;
		const html = await d3.wiki.getContent(wiki), info = html.getElementById("infoboxCountry") || html.body;
		////-------------------------------------要約
		//	q.extract = 要約(html);
		////-------------------------------------首都
		var cap = 首都(info, name); if (cap == "" && capital) console.warn("no_capital: ", name);
		if (capital != cap && !["香港", "マカオ", "パラオ", "パレスチナ"].includes(name)) nation.capital.wikiName = cap;
		if (capital.replace(/(島)$/, "") != d3.wiki.clean(cap).replace(/(島|市|地区|特別市|都)$/, "")) console.log(name, capital, "<=>", cap);
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
			return p.map(t => { t.querySelector("#coordinates") && t.querySelector("#coordinates").remove(); return d3.wiki.clean(t.innerText); });
		}
		function 首都(html, name) {
			if (name == "スヴァールバル諸島およびヤンマイエン島") return "ロングイェールビーン";
			if (name == "西サハラ") return "ラユーン";
			var v = [...html.querySelectorAll(".infoboxCountryDataB tr")].filter(t => t.querySelector("th") && t.querySelector("th").innerText.match(/(首都|首府|州都|主都|行政所在地)/));
			if (v[0] && v[0].querySelector("td a")) {
				const capital = v[0].querySelector("td a").getAttribute("title");
				return (capital.match(/(都市国家|存在しないページ)/)) ? name : capital;
			}
			return "";
		}
		function 人口(html, name) {
			var def = {
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
				y = y ? +y[1] : 0; return (y > 2025 || y < 2000) ? 0 : y;
			}
			function 人口(html) {
				const clean = s => d3.wiki.clean(s).replace(/\s/g, "")
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
				アルツァフ共和国: 3170, ドネツク人民共和国: 8539, チベット: 2500000,
				フランス領南方・南極地域: 7781, 米領バージン諸島: 347, 西サハラ: 266000,
				オランダ: 37354, デンマーク: 43094, ノルウェー: 323802
			}
			if (name in rep) return rep[name];
			const v = [...html.querySelectorAll("tr td")].filter(t => !t.querySelector("table")).map(t => d3.wiki.clean(t.innerText));
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
			const v = [...html.querySelectorAll(".infoboxCountryDataB tr")].filter(t => t.querySelector("th") && t.querySelector("th").innerText.match(/(公用語)/));
			return d3.unique((v[0] && v[0].querySelector("td a")) ?
				[...v[0].querySelectorAll("td a")].filter(t => t.getAttribute("title") && t.getAttribute("title").match(/^.+語$/))
					.map(t => {
						t = d3.wiki.clean(t.innerText);
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
			const anthem = [...html.querySelectorAll(".infoboxCountryAnthem [src]")].map(t => t.getAttribute("src"))
				.filter(s => s.match(/\.mp3$/))[0];
			return anthem ? "https:" + anthem : "";
		}
	}
	////-------------------------------------------------------------------------------------------------------
	////	UN(国際連合)
	////-------------------------------------------------------------------------------------------------------
	async function un(nations) {
		var names = nations.map(t => t.name.ja);
		const todate = s => s.match(/(\d+)年(\d+)月(\d+)日/).slice(1, 4).map((t, i) => i ? d3.L2(t) : t).join("/");
		const html = await d3.wiki.getContent("国際連合加盟国");
		const list = [...html.querySelectorAll("table tr")]
			.map(t => [...t.querySelectorAll("td")])
			.filter(t => t.length == 5).map(t => [t[0], t[1], t[3]].map(t => d3.wiki.clean(d3.trim(t.innerText))))
			.map(t => [t[0], todate(t[1]), t[2].split(/\s/).slice(1)])
		console.log(list);
		var tub = {};
		list.forEach(t => {
			var name = renames[t[0]] || t[0];
			names.includes(name) || console.warn(t[0]);
			tub[name] = [t[1]];
			t[2] = t[2].map(t => renames[t] || t);
			t[2].forEach(t => names.includes(t) || console.warn(t));
			t[2].length && tub[name].push(t[2]);
		});
		nations.forEach(t => tub[t.name.ja] && (t.un = tub[t.name.ja]));
	}
	////-------------------------------------------------------------------------------------------------------
	////	ISO-3166
	////-------------------------------------------------------------------------------------------------------
	async function iso(nations) {
		var names = nations.map(t => t.name.ja);
		const html = await d3.wiki.getContent("ISO_3166-1");
		const list = [...html.querySelectorAll("table tr")]
			.map(t => [...t.querySelectorAll("td")])
			.filter(t => t.length == 8)
			.map(t => [t[0], t[5], t[4], t[3], t[6]].map(t => d3.wiki.clean(d3.trim(t.innerText))))
		console.log(list);
		var tub = {};
		list.forEach(t => {
			var name = renames[t[0]] || t[0];
			names.includes(name) || console.warn(t[0]);
			tub[name] = [t[1], t[2], +t[3]];
		});
		tub["サハラ・アラブ民主共和国"] = tub["西サハラ"];
		delete tub["西サハラ"];
		tub["コソボ"] = ["XK", "KSV", 111];//コソボは正式ではない・・・
		nations.forEach(t => tub[t.name.ja] && (t.iso = tub[t.name.ja]));
		//		tub = {};
		//		list.forEach(t=>(tub[t[4]]=tub[t[4]]||[], tub[t[4]].push(t[0])));
		//		console.log(Object.keys(tub).join("\n"))
		//		console.log(tub)
	}
	////-------------------------------------------------------------------------------------------------------
	////	IOC
	////-------------------------------------------------------------------------------------------------------
	async function ioc(nations) {
		var names = nations.map(t => t.name.ja);
		const html = await d3.wiki.getContent("IOCコード一覧");
		const list = [...html.querySelectorAll("table tr")]
			.map(t => [...t.querySelectorAll("td")])
			.filter(t => t.length == 6)
			.map(t => [t[1], t[0], t[2], t[4]].map(t => d3.wiki.clean(d3.trim(t.innerText)))).filter(t => t[1]);
		console.log(list);
		const tub = {};
		list.forEach(t => {
			var name = renames[t[0]] || t[0];
			names.includes(name) || console.warn(t[0]);
			tub[name] = [t[1], +t[3]];
		})
		nations.forEach(t => t.ioc = tub[t.name.ja]);
	}
	////-------------------------------------------------------------------------------------------------------
	////	HDI
	////-------------------------------------------------------------------------------------------------------
	async function hdi(nations) {
		const csv = await bucket.getCSV("https://hdr.undp.org/sites/default/files/2023-24_HDR/HDR23-24_Composite_indices_complete_time_series.csv");
		console.log(csv[0].slice(5, 38), csv[0].slice(171, 204), csv[0].slice(137, 170));
		const tub = {};
		csv.filter(t => t[0].length == 3).forEach(t => {
			var p = tub[t[0]] = {};
			p.hdi = [2022].concat(t.slice(5, 38).reverse().map(t => +t));
			//		p.gni = [2022].concat(t.slice(171, 204).reverse().map(t=>+t));
			//		p.gnipc = [2022].concat(t.slice(137, 170).reverse().map(t=>Math.round(+t)));
		});
		nations.forEach(t => {
			if (t.iso && t.iso[1] && tub[t.iso[1]]) {
				t.hdi = tub[t.iso[1]].hdi.slice(0, 5);
				//		t.gni = tub[t.iso[1]].gni;
				//		t.gnipc = tub[t.iso[1]].gnipc;
			}

		})
	}
	////-------------------------------------------------------------------------------------------------------
	////	population / gdp / gni / ppp / gpi / psi
	////-------------------------------------------------------------------------------------------------------
	function population(nations) { return template(nations, 2024, 2010, "population", "un-population-ranking", 0); }
	function gdp(nations) { return template(nations, 2025, 2013, "gdp", "imf-gdp-ranking", 1); }
	function gdppc(nations) { return template(nations, 2025, 2017, "gdppc", "imf-gdp-per-capita-ranking", 2); }
	function gni(nations) { return template(nations, 2023, 2021, "gni", "wb-gni-ranking", 1); }
	function gnipc(nations) { return template(nations, 2023, 2021, "gnipc", "wb-gni-per-capita-ranking", 2); }
	function ppp(nations) { return template(nations, 2024, 2022, "ppp", "imf-gdp-ppp-ranking", 1); }
	function ppppc(nations) { return template(nations, 2024, 2022, "ppppc", "imf-gdp-per-capita-ppp-ranking", 2); }
	function gpi(nations) { return template(nations, 2024, 2021, "gpi", "global-peace-index-ranking", 3); }
	function psi(nations) { return template(nations, 2024, 2021, "psi", "security-ranking", 3); }
	////-------------------------------------------------------------------------------------------------------
	async function template(nations, start, end, title, url, n) {
		const tub = {};
		const names = nations.map(t => t.name.ja);
		for (let y = start; y >= end; y--) {
			const table = await fetchTable(`https://sekai-hub.com/statistics/${url}-${y}`);
			var a = [year0, year1, year2, year3][n](table);
			console.log(`reading: ${title}(${y})`)
			a.forEach(t => { tub[t[0]] = tub[t[0]] || []; tub[t[0]][start - y] = t[1] });
		}
		const warns = Object.keys(tub).filter(t => !names.includes(t));
		warns.length && console.warn(warns);
		nations.forEach(t => tub[t.name.ja] && (t[title] = [start].concat(tub[t.name.ja])));
		////----------------------------------------
		async function fetchTable(url) {
			var wikiDB = window._wikiDB_ = window._wikiDB_ || {};
			var idb = wikiDB.html = wikiDB.html || (await d3.cache(["wikiDB", "html"].join(".")));
			var v = await idb(url); if (v) return getTable(v);
			await idb(url, await bucket.getTEXT(url));
			return fetchTable(url);
			function getTable(s) {
				var html = new DOMParser().parseFromString(s, "text/html");
				var s = html.getElementById("__NUXT_DATA__").innerText.replace(/\\u003C/g, "<");
				s = s.match(/\<table.+\<\/table\>/g)[0];
				s = new DOMParser().parseFromString(s, 'text/html');
				return [...s.querySelectorAll("tr")].map(t => [...t.querySelectorAll("td")].map(t => t.innerText));
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
		(await loadConflicts()).forEach(t => {
			if (t.sovereignt) {
				const s = t.iso || t.sovereignt;
				(sovereignt[s] = sovereignt[s] || []).push(t.key);
			}
			if (Array.isArray(t.claim)) t.claim.forEach(s => (claim[s] = claim[s] || []).push(t.key));
		});
		sovereignt["AF"] = ["AF"];
		sovereignt["EH"] = ["B28"];
		////-----------------------------------------------------
		nations.forEach(t => {
			if (t.iso) {
				t.sovereignt = sovereignt[t.iso[0]];
				t.claim = claim[t.iso[0]];
				if (["US", "RU", "UM", "CA", "AQ"].includes(t.iso[0])) t.pole = true;
			} else {
				t.sovereignt = {
					"西サハラ": ["B19", "B28"],
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
				}[t.name.ja];
			}
		});
	}
}