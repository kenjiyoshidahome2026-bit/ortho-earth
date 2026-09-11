// 国別 DB（world）の bucket 入出力。データの正本と組み立ては packages/world（seed/ + build/）＝ここは保存と資産（旗・音源・地形PNG）だけ。
//   キー体系: 国=key（iso2 か B コード・FR-CP）、都市=Wikidata QID、言語=ISO 639、通貨=ISO 4217、係争地=Conflicts の key、旗=flags/<key>.svg
export const DIRE = "GIS/world";
export const NATION = "NationDB", CITY = "CityDB", LANGUAGE = "LanguageDB", CURRENCY = "CurrencyDB", CONFLICT = "Conflicts";
export const DBS = [NATION, CITY, LANGUAGE, CURRENCY, CONFLICT];
export const FLAG = "flags";     // flags.zip（<key>.svg）＋ flags/<key>.svg
export const SOUND = "音源";      // 音源.zip（mp3・OtoLogic CC BY 4.0）
export const GEOMS = "geoms";    // geoms.zip（<key>.png）＋ geoms/<key>.png
// 国以外の旗の id（flags/<id>.svg）。UI 用と旧例外地域（NationDB に無い＝資産として保持）
export const FLAG_KEYS = ["UN", "EU", "NATO", "DISPUTED", "X-CATALONIA", "X-KURDISTAN", "X-KERGUELEN", "X-DARFUR", "X-CHECHNYA", "X-TIBET", "X-BOUGAINVILLE", "X-MADEIRA", "X-WESTPAPUA"];

// 保存形式＝{ updated, count, items } の版スタンプ包み。i18n/<lang>.json はオブジェクトのまま（updated 付き）
export function makeDB(bucket) {
	const unwrap = v => (v && v.items !== undefined) ? v.items : v;
	// ?_t= キャッシュバスター必須＝bucket GET は edge(s-maxage 1h)+ブラウザ(max-age 4h)でキャッシュされる
	const loadJSON = async name => unwrap(await bucket.get(`${name}.json?_t=${Date.now()}`, "json"));
	const saveJSON = (name, a) => {
		const wrapped = Array.isArray(a) ? { updated: new Date().toISOString().slice(0, 10), count: a.length, items: a } : a;
		return bucket.put(new File([JSON.stringify(wrapped)], `${name}.json`, { type: "application/json" }));
	};
	const zipAndFiles = (name, mime) => async files => { await bucket.puts(`${name}.zip`, files); for (const f of files) await bucket.put(new File([f], `${name}/${f.name}`, { type: mime })); };
	return {
		loadJSON, saveJSON,
		// 旗/geoPNG＝zip（保管・一括DL）に加えて個別ファイル（flags/<key>.svg・geoms/<key>.png）も配置＝ビューアは見えた分だけ遅延取得
		loadFlagDB: () => bucket.gets(FLAG), saveFlagDB: zipAndFiles(FLAG, "image/svg+xml"),
		loadSoundDB: () => bucket.gets(SOUND), saveSoundDB: files => bucket.puts(`${SOUND}.zip`, files),
		loadGeoPNG: () => bucket.gets(GEOMS), saveGeoPNG: zipAndFiles(GEOMS, "image/png"),
	};
}
