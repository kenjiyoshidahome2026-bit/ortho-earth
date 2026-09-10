// ── データ読込（bucket GIS/world）──
// JSON 5本 + zip 3本（flags=<key>.svg / geoms=<国名>.png / 音源 mp3）。zip は IDB に ETag 付きでキャッシュ＝2回目以降は無通信。
// JSON は ?_t= でキャッシュバスター（bucket GET は edge 1h/ブラウザ 4h キャッシュ＝uploader 側の教訓）
import { nativeBucket, Cache } from "native-bucket";

const API_BASE = import.meta.env.DEV ? `${location.origin}/api` : "https://api.ortho-earth.com";
const { Bucket } = nativeBucket(API_BASE);
const DIRE = "GIS/world";

let _bucket = null;
const getBucket = async () => _bucket || (_bucket = await Bucket(DIRE));
// 言語別テーブル（i18n/<lang>.json＝名前/記事名/UI文言）。en は基軸＝NationDB の英語名と英語キーをそのまま使う（テーブル不要）
export async function loadI18N(lang) {
	if (!lang || lang == "en") return null;
	const bucket = await getBucket(); if (!bucket) return null;
	const v = await bucket.get(`i18n/${lang}.json?_t=${Date.now()}`, "json").catch(() => null);
	return v && (v.items !== undefined ? v.items : v);
}
export const ASSET_BASE = `${API_BASE}/bucket/${DIRE}/`;   // 旗/地図PNGは個別ファイル（flags/<key>.svg・geoms/<key>.png）＝見えた分だけ <img loading=lazy>
export async function loadWorld() {
	const bucket = await getBucket();
	if (!bucket) throw new Error(`bucket ${DIRE} に到達できません`);
	const unwrap = v => (v && v.items !== undefined) ? v.items : v;
	const idb = await Cache("world/files").catch(() => null);
	// JSON: ネット優先（?_t= で edge/ブラウザキャッシュ回避）・成功したら IDB へ・失敗したら IDB の前回分＝回線が切れても起動できる
	const json = async name => {
		const v = await bucket.get(`${name}.json?_t=${Date.now()}`, "json").catch(() => null);
		if (v) { idb && idb("json:" + name, v).catch(() => {}); return unwrap(v); }
		const old = idb && await idb("json:" + name).catch(() => null);
		if (!old) throw new Error(`${name} を取得できません（オフライン・未キャッシュ）`);
		console.warn(`${name}: ネット不達＝IDB の前回分で起動`); return unwrap(old);
	};
	const files = async name => {   // zip（音源）: ETag 一致なら IDB
		const etag = await bucket.etag(`${name}.zip`);
		const hit = idb && await idb(name);
		if (hit && (!etag || hit.etag === etag)) return hit.files;
		const list = await bucket.gets(name).catch(() => hit ? hit.files : []);
		idb && etag && list.length && await idb(name, { etag, files: list }).catch(() => {});
		return list;
	};
	const [nations, cities, languages, currencies, conflicts, soundFiles] = await Promise.all([
		json("NationDB"), json("CityDB"), json("LanguageDB"), json("CurrencyDB"), json("Conflicts"), files("音源"),
	]);
	const stem = f => f.name.normalize("NFC").replace(/\.[^.]+$/, "");
	const sounds = {}; soundFiles.filter(f => /\.mp3$/.test(f.name)).forEach(f => sounds[stem(f)] = f);
	return { nations, cities, languages, currencies, conflicts, sounds };
}

// 設定の永続化（旧 d3.cache("nations.system")）
export async function systemStore() {
	const idb = await Cache("world/system").catch(() => null);
	return {
		load: async () => (idb && await idb("SystemParameter").catch(() => null)) || {},
		save: async v => idb && idb("SystemParameter", v).catch(() => {}),
	};
}
