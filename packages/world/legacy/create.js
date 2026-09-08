async function createWorldData(top) {
//	#inline("H3hXwiKH");//setupWhiteEarth
//	const resources = ["createGetHeight"];
//	scripts("ZQ1fRCut");
//	await setupWhiteEarth({}); //フレームワーク実行
	{///------------------------------------------------------------------------------------------------------------------------	
		const __seedList__ = "国名一覧";
		const __NationDB__ = "NationDB";
		const __CityDB__ = "CityDB";
		const __LanguageDB__ = "LanguageDB";
		const __CurrencyDB__ = "CurrencyDB";
		const __FlagDB__ = "国旗";
		const __SoundDB__ = "音源";
		const __Conflicts__ = "Conflicts";
		const __geopng__ = "geoms";
		////------------------------------------------------------------------------------------------------------------------------
		const project = "b1qEpPlw";
		////------------------------------------------------------------------------------------------------------------------------
		async function loadSeed() { return bucket.loadObject(__seedList__, { project }); }
		async function loadNationDB() {
			var v = (await bucket.loadObject(__NationDB__, { project }));
			const exceptions = ["クルディスタン", "ダルフール", "チェチェン共和国", "チベット", "ブーゲンビル"];
			const クリッパートン島 = { name: { ja: 'クリッパートン島', en: 'Clipperton Island', zh: '克利珀頓島', ko: '클리퍼턴섬' }, yomi: 'クリッパートン', wiki: { ja: 161127, en: 5510, zh: 687950, ko: 865828 }, territory: "フランス", region: 4, area: 6 }
			v = v.filter(t => !exceptions.includes(t.name.ja)).concat([クリッパートン島]);
			return v;
		}
		async function loadCityDB() { return bucket.loadObject(__CityDB__, { project }); }
		async function loadLanguageDB() { return bucket.loadObject(__LanguageDB__, { project }); }
		async function loadCurrencyDB() { return bucket.loadObject(__CurrencyDB__, { project }); }
		async function loadFlagDB() { return bucket.loadFiles(__FlagDB__, { project }); }
		async function loadSoundDB() { return bucket.loadFiles(__SoundDB__, { project }); }
		async function loadConflicts() { return bucket.loadObject(__Conflicts__, { project }); }
		async function loadGeoPNG() { return bucket.loadFiles(__geopng__, { project }); }
		////------------------------------------------------------------------------------------------------------------------------	
		async function saveSeed(a) { await bucket.saveObject(__seedList__, a, { project }); console.log(await loadSeed()); }
		async function saveNationDB(a) { await bucket.saveObject(__NationDB__, a, { project }); console.log(await loadNationDB()); }
		async function saveCityDB(a) { await bucket.saveObject(__CityDB__, a, { project }); console.log(await loadCityDB()); }
		async function saveLanguageDB(a) { await bucket.saveObject(__LanguageDB__, a, { project }); console.log(await loadLanguageDB()); }
		async function saveCurrencyDB(a) { await bucket.saveObject(__CurrencyDB__, a, { project }); console.log(await loadCurrencyDB()); }
		async function saveFlagDB(a) { await bucket.saveFiles(__FlagDB__, a, { project }); }
		async function saveSoundDB(a) { await bucket.saveFiles(__SoundDB__, a, { project }); }
		async function saveConflicts(a) { await bucket.saveObject(__Conflicts__, a, { project }); }
		async function saveGeoPNG(a) { return bucket.loadFiles(__geopng__, a, { project }); }
		////------------------------------------------------------------------------------------------------------------------------	
		async function makeFlags() {
			const tub = {};
			(await loadFlagDB()).map(t => new FlagSVG(t)).forEach(file => tub[file.name()] = file);
			tub["サハラ・アラブ民主共和国"] = tub["西サハラ"];
			return tub;
		}
		async function makeGeoPNG() {
			const tub = {};
			(await loadGeoPNG()).forEach(file => tub[file.name.replace(/\.png$/, "")] = URL.createObjectURL(file));
			tub["クリッパートン島"] = tub["ブーベ島"];//とりあえず・・・
			return tub;
		}
		async function makeSounds() {
			const sounds = (s, v = 1) => { sounds.src[s].currentTime = 0; sounds.src[s].volume = v; sounds.src[s].play(); };
			sounds.src = {};
			(await loadSoundDB()).forEach(t => sounds.src[t.name.replace(/\.mp3$/, "")] = new Audio(URL.createObjectURL(t)));
			sounds.list = Object.keys(sounds.src);
			return sounds;
		}
		Object.assign(window, {
			__seedList__, __NationDB__, __CityDB__, __LanguageDB__, __FlagDB__, __SoundDB__, __Conflicts__,
			loadSeed, loadNationDB, loadCityDB, loadLanguageDB, loadCurrencyDB, loadFlagDB, loadGeoPNG, loadSoundDB, loadConflicts, makeFlags, makeGeoPNG, makeSounds,
			saveSeed, saveNationDB, saveCityDB, saveLanguageDB, saveCurrencyDB, saveFlagDB, saveGeoPNG, saveSoundDB, saveConflicts
		})
	}///------------------------------------------------------------------------------------------------------------------------	
	//	await city10(); return;
	const toLangs = ["en", "zh", "ko"];
	////------------------------------------------------------------------------------------------------------------------------	
	const renames = {
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
	};
	const rename = s => (renames[s] || s);
	////---------------------------------------
	#inline("7SzWe6GP");// geometryISO
	#inline("UEVbTZC1");// new wiki api (d3.wiki)
	#inline("qjpQx44Y");// createNationDB(toLangs),
	#inline("RVkHIUhP");// createCityDB(toLangs);
	#inline("r14WZUyG");// createLanguageDB(toLangs)/createCurrencyDB(toLangs) 
	//	const name = "List_of_mountain_peaks_by_prominence";
	//	bucket.download("List_of_mountain_peaks_by_prominence.json", turf.featureCollection(await loadObject(name)));
	//await upload_river();
	//	await upload_mountain();
	//	await upload_city();
	//	await upload_conflict()
	//	return;
	// https://upload.wikimedia.org/wikipedia/commons/5/5e/K%C3%B6ppen-geiger-hessd-2007.svg
	// https://en.wikipedia.org/wiki/List_of_mountain_peaks_by_prominence
	//https://en.wikipedia.org/wiki/List_of_mountain_ranges
	// https://ja.wikipedia.org/wiki/%E5%8D%8A%E5%B3%B6
	async function createWiki(db, lang) {
		const names = db.map(t => t.name[lang]);
		const wikis = await d3.wiki.title2id(names, lang);
		wikis.forEach((t, i) => { t || console.warn("fail to convert (title-id)"), names[i] })
		db.forEach((t, i) => {
			t.wiki = t.wiki || {}, t.wiki[lang] = wikis[i];
			t.name[lang] = d3.wiki.clean(t.name[lang]).split(",")[0];
		});
	}
	async function addLanguage(db, toLangs, fromLang = "en") {
		toLangs = Array.isArray(toLangs) ? toLangs : [toLangs];
		var errs = {};
		await d3.thenEach(toLangs, t => loop(t, fromLang));
		Object.entries(errs).forEach(t => console.warn("conversion failed", t[0], ...t[1]));
		async function loop(toLang, fromLang = "en") {
			const ids = db.map(t => t.wiki[fromLang]);
			var target = await d3.wiki.id2langlink(ids, [toLang], fromLang);
			var wiki = await d3.wiki.title2id(target, toLang);
			target = target.map(t => d3.wiki.clean(t).split(",")[0]);
			console.log(target);
			db.forEach((t, i) => {
				target[i] && (t.name[toLang] = target[i]);
				wiki[i] && (t.wiki[toLang] = wiki[i]);
				if (!(t.name[toLang] && t.wiki[toLang])) {
					errs[t.name[fromLang]] = errs[t.name[fromLang]] || [];
					errs[t.name[fromLang]].push(toLang);
				}
			});
		}
	}
	function removeLanguage(db, langs) {
		(Array.isArray(langs) ? langs : [langs]).forEach(loop);
		function loop(lang) {
			db.forEach(t => { delete t.name[lang]; delete t.wiki[lang]; });
		}
	}
	////-------------------------------------------------------------------------------------------
	async function fixLanguage(db, def, convert_flag) {
		await d3.thenEach(def, async ([[langFrom, nameFrom], to]) => {
			const target = db.filter(t => t.name[langFrom] == nameFrom)[0];
			await d3.thenEach(to, async ([langTo, nameTo]) => {
				if (target.name[langTo]) console.log("overwriting", target.name[langTo], nameTo);
				target.name[langTo] = nameTo;
				convert_flag && (target.wiki[langTo] = await d3.wiki.title2id(nameTo, langTo));
			});
			console.log(target);
		});
	}
	////------------------------------------------------------------------------------------------------------------------------	
	async function createConflicts(conflicts) {
		var iso_tub = {}; (await loadNationDB()).forEach(t => t.iso && (iso_tub[t.iso[0]] = t));
		conflicts = conflicts.map(t => ({ key: t[0], type: t[1], region: t[2], title_en: t[3], title_ja: t[5], name: { en: t[4] || t[3], ja: t[5] }, exist: !!t[6], sovereignt: t[8], iso: t[7] || undefined, claim: t[9] ? t[9].split("|") : undefined }));
		conflicts.forEach(t => {
			var key = (t.iso || t.sovereignt); if (key == "Self") key = "";
			var sovereignt = (key && iso_tub[key]) ? iso_tub[key].name.ja : "---";
			console.log(t.key, t.name.ja, t.type, sovereignt, t.claim ? t.claim.map(t => iso_tub[t].name.ja) : "")
		});
		var en = conflicts.map(t => t.title_en);
		var ja = conflicts.map(t => t.title_ja);
		await createWiki(conflicts, "en");
		await addLanguage(conflicts, ["ja", "zh", "ko"], "en");
		await d3.thenEach(conflicts, async t => {
			if (!t.wiki.ja) {
				var id = await d3.wiki.title2id(t.title_ja);
				if (id) console.log("!!!!!!!!!!!!!", t.title_ja, t.wiki.ja = id);
			}
		})
		conflicts.forEach((t, i) => (t.name.en = en[i], t.name.ja = ja[i], delete t.title_en, delete t.title_ja));
		return conflicts;
	}
	//	await upload_river();
	//	await upload_ocean();
	//	return
	//	console.log((await loadConflicts()).sort((p,q)=>p.key>q.key?1:-1).map(t=>"["+[JSON.stringify(t.key), JSON.stringify(t.sovereignt), JSON.stringify(t.claim||[])].join(",")+"],//"+t.name.ja).join("\n"));
	const div = d3.select("body").empty().append("div");
	div.append("button").text("国データ作成(createNationDB)").on("click", () => createNationDB(toLangs));
	div.append("button").text("都市データ作成(createCityDB)").on("click", () => createCityDB(toLangs));
	div.append("button").text("通貨データ作成(createCurrencyDB)").on("click", () => createCurrencyDB(toLangs));
	div.append("button").text("言語データ作成(createLanguageDB)").on("click", () => createLanguageDB(toLangs));
	div.append("button").text("geoPNG作成(createGeometryPNG)").on("click", () => createGeometryPNG(toLangs));
	div.append("button").text("国データ作成用リストCSVのダウンロード").on("click", () => downloadSeed());
	div.append("button").text("都市データ作成結果CSVのダウンロード").on("click", () => downloadCityDB());
	div.append("button").text("紛争地域リストのダウンロード").on("click", () => downloadConflict());
	div.append("button").text(`${__FlagDB__}.zip`).on("click", async () => bucket.download(`${__FlagDB__}.zip`, await bucket.loadFile(`${__FlagDB__}.zip`)))
	div.append("button").text(`${__SoundDB__}.zip`).on("click", async () => bucket.download(`${__SoundDB__}.zip`, await bucket.loadFile(`${__SoundDB__}.zip`)))
	d3.select("body").dropFile(async file => {
		const cleanSVG = async file => await (new FlagSVG(file)).clean();
		if (file.name == `${__seedList__}.csv`) {
			await saveSeed(await bucket.blob2csv(file));
			await createNationDB(toLangs);
			await createLanguageDB(toLangs);
			await createCurrencyDB(toLangs);
			await createCityDB(toLangs);
		}
		if (file.name == `${__FlagDB__}.zip`) {
			var files = (await bucket.readZIP(file)).filter(t => t.name.match(/\.svg$/) && !t.name.match(/^\./)).sort((p, q) => p.name > q.name ? 1 : -1);
			files = await d3.thenMap(files, cleanSVG);
			await saveFlagDB(files);
			console.log(files);
		}
		if (file.name == `${__Conflicts__}.csv`) {
			var conflicts = await bucket.blob2csv(file);
			await saveConflicts(await createConflicts(conflicts));
			console.log(await loadConflicts());
		}
		if (file.name == `${__SoundDB__}.zip`) {
			var files = (await bucket.readZIP(file)).filter(t => t.name.match(/\.mp3$/) && !t.name.match(/^\./)).sort((p, q) => p.name > q.name ? 1 : -1);
			await saveSoundDB(files);
			console.log(files);
		}
		if (file.name == `World_EEZ_v12_20231025.zip`) {
			debugger
			var geo = await bucket.shape2geo(file);
			console.log(geo);
			//			
			//			(await bucket.readZIP(file)).filter(t=>t.name.match(/\.mp3$/)&&!t.name.match(/^\./)).sort((p,q)=>p.name>q.name?1:-1);
			//			await saveSoundDB(files);
			//			console.log(files);
		}
		if (file.name.match(/\.svg$/)) {
			const name = file.name.normalize('NFC').replace(/\.svg$/, "");
			const files = await loadFlagDB();
			const names = files.map(t => t.name.replace(/\.svg$/, ""));
			if (names.includes(name)) {
				file = await cleanSVG(file);
				await saveFlagDB(files.map(t => t.name.replace(/\.svg$/, "") == name ? file : t));
			}
		}
	});
	await setupMapGeometories();
	////------------------------------------------------------------------------------------------------------------------------	
	async function downloadSeed() {
		await bucket.download(`${__seedList__}.csv`, await loadSeed());
	}
	async function downloadConflict() {
		await bucket.download(`${__Conflicts__}.json`, await loadConflicts());
	}
	async function downloadCityDB() {
		const cities = await loadCityDB();
		const head = ["name.ja", "name.en", "name.zh", "name.ko", "nation", "capital", "coords[0]", "coords[1]", "coords[2]",
			"population[0]", "population[1]", "wiki.ja", "wiki.en", "wiki.zh", "wiki.ko", "yomi"]
		const a = cities.map(t => [t.name.ja, t.name.en, t.name.zh, t.name.ko, t.nation, !!t.capital, t.coords[0], t.coords[1], t.coords[2],
		t.population[0], t.population[1], t.wiki.ja, t.wiki.en, t.wiki.zh, t.wiki.ko, t.yomi]);
		bucket.download(`${__CityDB__}.csv`, [head].concat(a));
	}
	////------------------------------------------------------------------------------------------------------------------------	
}