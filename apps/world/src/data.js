// ── データ読込（bucket GIS/world）: IDB 優先・裏で更新（2026-09-10）──
// JSON 5本（+ i18n/<lang>.json）・音源.zip・旗の実在集合（flags/ 一覧）。
// 旧: ネット優先で IDB は不達時の予備＝オンラインでは毎回 Worker（1 本 0.6〜1.4s・3 段連なり）を待っていた（実測 4 秒）。
// 新: IDB に揃っていれば即返す（温）。初回だけ一段で全部並列（冷）。起動後に refresh() が一覧（ETag）を 1 本取り、
//     変わったファイルだけ取り直して IDB を更新→呼び出し側へ通知（組み直して再描画）。native-bucket の部品（Cache/list/get/gets）で組む。
import { nativeBucket, Cache } from "native-bucket";

const API_BASE = import.meta.env.DEV ? `${location.origin}/api` : "https://api.ortho-earth.com";
const { Bucket } = nativeBucket(API_BASE);
const DIRE = "GIS/world";                                        // 資産（flags/ geoms/ 音源.zip）
const DATA = import.meta.env.VITE_WORLD_DATA || DIRE;             // DB と i18n（検証用に別ディレクトリへ向けられる: VITE_WORLD_DATA=GIS/world-v2）
export const ASSET_BASE = `${API_BASE}/bucket/${DIRE}/`;   // 旗/地図PNGは個別ファイル（flags/<key>.svg・geoms/<key>.png）＝見えた分だけ <img loading=lazy>

const JSONS = ["NationDB", "CityDB", "LanguageDB", "CurrencyDB", "Conflicts"];
const SFX = "音源", FLAGSET = "flagSet";
const needI18N = lang => !!lang && lang != "en";   // en は基軸＝NationDB の英語名と英語キーをそのまま使う（テーブル不要）
const i18nKey = lang => `i18n/${lang}`;
const fileOf = k => k.split("/").pop() + ".json";   // 一覧の Key は末尾名（native-bucket _conv）。i18n/ja → ja.json
const unwrap = v => (v && v.items !== undefined) ? v.items : v;

// Bucket は lazy＝到達確認の list() を省く（旧: getBucket の競合で一覧を 2 本取っていた）
let _b = null, _fb = null, _ib = null, _idb = null;
let _ab = null;
const bucket = async () => _b || (_b = await Bucket(DATA, { lazy: true, silent: true }));                 // DB/i18n
const assetBucket = async () => _ab || (_ab = await Bucket(DIRE, { lazy: true, silent: true }));           // 音源.zip
const flagsBucket = async () => _fb || (_fb = await Bucket(`${DIRE}/flags`, { lazy: true, silent: true }));
const i18nBucket = async () => _ib || (_ib = await Bucket(`${DATA}/i18n`, { lazy: true, silent: true }));
const idb = async () => _idb !== null ? _idb : (_idb = await Cache(DATA == DIRE ? "world/files" : "world/files-" + DATA.replace(/\W/g, "_")).catch(() => false));
const read = async k => { const d = await idb(); return d ? await d(k).catch(() => null) : null; };
const write = async (k, v) => { const d = await idb(); d && await d(k, v).catch(() => {}); };
const getJSON = async k => (await bucket()).get(`${k}.json?_t=${Date.now()}`, "json");   // ?_t= で edge(1h)/ブラウザ(4h) キャッシュ回避
// 一覧は再帰しない＝GIS/world（JSON/zip）と i18n/（言語表）を別々に取り、末尾名→ETag に併合（言語が en なら i18n/ は省く）
const listETags = async lang => {
	const m = {}, dirs = [bucket(), assetBucket()].concat(needI18N(lang) ? [i18nBucket()] : []);
	(await Promise.all(dirs.map(async b => (await b).list()))).flat().forEach(t => m[t.Key] = t.ETag);
	return Object.keys(m).length ? m : null;
};
const listFlags = async () => (await (await flagsBucket()).list()).map(t => t.Key.replace(/\.svg$/, "")).filter(k => k);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function pack(files, soundFiles, flagKeys, lang, warm) {
	const stem = f => f.name.normalize("NFC").replace(/\.[^.]+$/, "");
	const sounds = {}; (soundFiles || []).filter(f => /\.mp3$/.test(f.name)).forEach(f => sounds[stem(f)] = f);
	return { nations: unwrap(files.NationDB), cities: unwrap(files.CityDB), languages: unwrap(files.LanguageDB), currencies: unwrap(files.CurrencyDB), conflicts: unwrap(files.Conflicts),
		i18n: needI18N(lang) ? unwrap(files[i18nKey(lang)]) : null, sounds, flags: new Set(flagKeys || []), warm };
}

export async function loadWorld(lang) {
	const want = JSONS.concat(needI18N(lang) ? [i18nKey(lang)] : []), n = want.length;
	const cached = await Promise.all(want.map(read).concat([read(SFX), read(FLAGSET)]));
	const files = {};
	if (cached.slice(0, n).every(c => c && c.v) && cached[n] && cached[n + 1]) {   // 温: 全部 IDB にある＝即返す（更新は refresh() が裏で）
		want.forEach((k, i) => files[k] = cached[i].v);
		return pack(files, cached[n].files, cached[n + 1].keys, lang, true);
	}
	// 冷（初回・IDB 欠け）: 一段で全部並列。一覧の ETag も同時に取って保存に添える（次回の refresh が突合できる）
	const [etags, sounds, flags, ...jsons] = await Promise.all([
		listETags(lang).catch(() => null), (await assetBucket()).gets(SFX).catch(() => []), listFlags().catch(() => []), ...want.map(k => getJSON(k).catch(() => null))]);
	want.forEach((k, i) => {
		const v = jsons[i] || (cached[i] && cached[i].v);
		if (!v) throw new Error(`${k} を取得できません（オフライン・未キャッシュ）`);
		files[k] = v; jsons[i] ? write(k, { etag: (etags && etags[fileOf(k)]) || null, v }) : console.warn(`${k}: ネット不達＝IDB の前回分で起動`);
	});
	sounds.length && write(SFX, { etag: (etags && etags[SFX + ".zip"]) || null, files: sounds });
	flags.length && write(FLAGSET, { etag: (etags && etags["flags.zip"]) || null, keys: flags });
	return pack(files, sounds.length ? sounds : (cached[n] && cached[n].files), flags.length ? flags : (cached[n + 1] && cached[n + 1].keys), lang, false);
}

// 裏の更新: 一覧（ETag）1 本 → 変わったファイルだけ取り直して IDB へ → 変化があれば onUpdate({ NationDB?, …, "i18n/ja"?, flags? })
// 音は次回起動から（Sound は起動時に組む）。旗は uploader が flags.zip と個別を同時に置く＝zip の ETag で一覧の取り直しを判断
export async function refresh(lang, onUpdate) {
	const etags = await listETags(lang).catch(() => null); if (!etags) return;
	const want = JSONS.concat(needI18N(lang) ? [i18nKey(lang)] : []), changed = {};
	await Promise.all(want.map(async k => {
		const c = await read(k), e = etags[fileOf(k)];
		if (c && c.etag && e && c.etag === e) return;
		const v = await getJSON(k).catch(() => null); if (!v) return;
		await write(k, { etag: e || null, v });
		if (!c || !same(c.v, v)) changed[k] = unwrap(v);   // ETag 無し（言語切替で取った分）は中身で比較
	}));
	const s = await read(SFX), se = etags[SFX + ".zip"];
	if (se && (!s || s.etag !== se)) { const f = await (await assetBucket()).gets(SFX).catch(() => []); f.length && await write(SFX, { etag: se, files: f }); }
	const fs = await read(FLAGSET), fe = etags["flags.zip"];
	if (!fs || (fe && fs.etag !== fe)) { const keys = await listFlags().catch(() => []); if (keys.length) { await write(FLAGSET, { etag: fe || null, keys }); (!fs || !same(fs.keys, keys)) && (changed.flags = new Set(keys)); } }
	Object.keys(changed).length && onUpdate && onUpdate(changed);
}

// 言語切替: IDB にあれば即返し、裏で取り直して差があれば onUpdate(fresh)。無ければ取得（ETag は次回の refresh が付ける）
export async function loadI18N(lang, onUpdate) {
	if (!needI18N(lang)) return null;
	const k = i18nKey(lang), c = await read(k);
	const fetchIt = async () => { const v = await getJSON(k).catch(() => null); if (!v) return null; await write(k, { etag: null, v }); return unwrap(v); };
	if (c && c.v) { onUpdate && fetchIt().then(v => v && !same(v, unwrap(c.v)) && onUpdate(v)); return unwrap(c.v); }
	return fetchIt();
}

// 設定の永続化（旧 d3.cache("nations.system")）
export async function systemStore() {
	const idb = await Cache("world/system").catch(() => null);
	return {
		load: async () => (idb && await idb("SystemParameter").catch(() => null)) || {},
		save: async v => idb && idb("SystemParameter", v).catch(() => {}),
	};
}
