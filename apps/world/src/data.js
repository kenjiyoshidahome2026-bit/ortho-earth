// ── データ読込（bucket GIS/world）──
// JSON 5本 + zip 3本（flags=<key>.svg / geoms=<国名>.png / 音源 mp3）。zip は IDB に ETag 付きでキャッシュ＝2回目以降は無通信。
// JSON は ?_t= でキャッシュバスター（bucket GET は edge 1h/ブラウザ 4h キャッシュ＝uploader 側の教訓）
import { nativeBucket, Cache } from "native-bucket";

const API_BASE = import.meta.env.DEV ? `${location.origin}/api` : "https://api.ortho-earth.com";
const { Bucket } = nativeBucket(API_BASE);
const DIRE = "GIS/world";

export async function loadWorld() {
	const bucket = await Bucket(DIRE);
	if (!bucket) throw new Error(`bucket ${DIRE} に到達できません`);
	const unwrap = v => (v && v.items !== undefined) ? v.items : v;
	const json = async name => unwrap(await bucket.get(`${name}.json?_t=${Date.now()}`, "json"));
	// zip: ETag が一致すれば IDB の複製を使う（flags 1.3MB・geoms 5MB・音源 0.4MB）
	const files = async name => {
		const idb = await Cache("world/files").catch(() => null);
		const etag = await bucket.etag(`${name}.zip`);
		const hit = idb && await idb(name);
		if (hit && etag && hit.etag === etag) return hit.files;
		const list = await bucket.gets(name);
		idb && etag && await idb(name, { etag, files: list }).catch(() => {});
		return list;
	};
	const [nations, cities, languages, currencies, conflicts, flagFiles, geomFiles, soundFiles] = await Promise.all([
		json("NationDB"), json("CityDB"), json("LanguageDB"), json("CurrencyDB"), json("Conflicts"),
		files("flags"), files("geoms"), files("音源"),
	]);
	const stem = f => f.name.normalize("NFC").replace(/\.[^.]+$/, "");
	const flags = {}; flagFiles.filter(f => /\.svg$/.test(f.name)).forEach(f => flags[stem(f)] = f);
	const geoms = {}; geomFiles.filter(f => /\.png$/.test(f.name)).forEach(f => geoms[stem(f)] = URL.createObjectURL(f));
	const sounds = {}; soundFiles.filter(f => /\.mp3$/.test(f.name)).forEach(f => sounds[stem(f)] = f);
	return { nations, cities, languages, currencies, conflicts, flags, geoms, sounds };
}

// 設定の永続化（旧 d3.cache("nations.system")）
export async function systemStore() {
	const idb = await Cache("world/system").catch(() => null);
	return {
		load: async () => (idb && await idb("SystemParameter").catch(() => null)) || {},
		save: async v => idb && idb("SystemParameter", v).catch(() => {}),
	};
}
