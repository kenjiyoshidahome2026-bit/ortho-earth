// ── データ読込（GitHub Pages の ortho-data/globe/）: IDB 優先・裏で更新（2026-09-10・置き場は 2026-10-13 に bucket GIS/world から移した）──
// JSON 5本（+ 名前表 <DB>.i18n/<lang>.json を 5 本）・音源（sfx.zip）・旗の実在集合（目録の flags/）。
// 旧: ネット優先で IDB は不達時の予備＝オンラインでは毎回 Worker（1 本 0.6〜1.4s・3 段連なり）を待っていた（実測 4 秒）。
// 新: IDB に揃っていれば即返す（温）。初回だけ一段で全部並列（冷）。起動後に refresh() が目録（manifest.json＝ファイルごとの中身の要約）を 1 本取り、
//     変わったファイルだけ取り直して IDB を更新→呼び出し側へ通知（組み直して再描画）。
// 置き場＝Pages（置くのは git push だけ＝bucket の鍵が要らない・packages/world/scripts/publish-pages.mjs）。Pages に一覧 API は無い＝目録がその代わり
//（旧＝bucket の一覧を 3〜4 本）。名前は DB の隣・画面の文言（ui）はプログラム（packages/world/i18n/ui.json）＝ここで重ねて旧来の i18n の形にして渡す。
import { Cache, decodeZIP } from "native-bucket";
import { WORLD_DATA } from "@ortho-earth/core/worldcontent";
import { uiTable } from "../i18n/ui-table.js";

const DATA = (import.meta.env.VITE_WORLD_DATA || WORLD_DATA).replace(/\/*$/, "/");   // 検証用に別の置き場へ向けられる（URL）: VITE_WORLD_DATA=http://localhost:8791/globe/
export const ASSET_BASE = DATA;   // 旗/地図PNGは個別ファイル（flags/<key>.svg・geoms/<key>.png）＝見えた分だけ <img loading=lazy>

const JSONS = ["NationDB", "CityDB", "LanguageDB", "CurrencyDB", "Conflicts"];
const SFX = "音源", SFX_FILE = "sfx.zip", FLAGSET = "flagSet", MANIFEST = "manifest.json";
const needI18N = lang => !!lang && lang != "en";   // en は基軸＝NationDB の英語名と英語キーをそのまま使う（テーブル不要）
const i18nKey = lang => `i18n/${lang}`;
const namesOf = lang => JSONS.map(db => `${db}.i18n/${lang}.json`);   // 名前表＝DB ごとに 1 本（重ねて { nations, cities, languages, currencies, conflicts }）
const unwrap = v => (v && v.items !== undefined) ? v.items : v;
const withUI = (names, lang) => names ? { ...names, ...uiTable(lang) } : names;   // 文言を重ねる＝旧来の i18n/<lang>.json と同じ形

let _idb = null;
const idb = async () => _idb !== null ? _idb : (_idb = await Cache(DATA == WORLD_DATA ? "world/files" : "world/files-" + DATA.replace(/\W/g, "_")).catch(() => false));
const read = async k => { const d = await idb(); return d ? await d(k).catch(() => null) : null; };
const write = async (k, v) => { const d = await idb(); d && await d(k, v).catch(() => {}); };
// 取りに行く時は毎回確かめる（no-cache＝ETag の照合・変わっていなければ 304）＝Pages のキャッシュ（10 分）で古い版を掴まない
const getFile = async name => { const r = await fetch(DATA + name, { cache: "no-cache" }); if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`); return r; };
const getJSON = async k => k.startsWith("i18n/")
	? Object.assign({}, ...await Promise.all(namesOf(k.slice(5)).map(async f => (await getFile(f)).json())))
	: (await getFile(k + ".json")).json();
const getSounds = async () => decodeZIP(await (await getFile(SFX_FILE)).blob(), null);
// 目録＝{ files: { 相対パス: 中身の要約 } }。版の札（旧＝bucket の ETag）：DB はそのファイルの要約・名前表は 5 本の要約を繋いだ物
const listTags = async () => { const m = (await (await getFile(MANIFEST)).json()).files; return m && Object.keys(m).length ? m : null; };
const tagOf = (tags, k) => !tags ? null : k.startsWith("i18n/") ? namesOf(k.slice(5)).map(f => tags[f] || "").join("") || null : tags[k + ".json"] || null;
const flagsOf = tags => Object.keys(tags || {}).map(f => /^flags\/(.+)\.svg$/.exec(f)?.[1]).filter(Boolean);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function pack(files, soundFiles, flagKeys, lang, warm) {
	const stem = f => f.name.normalize("NFC").replace(/\.[^.]+$/, "");
	const sounds = {}; (soundFiles || []).filter(f => /\.mp3$/.test(f.name)).forEach(f => sounds[stem(f)] = f);
	return { nations: unwrap(files.NationDB), cities: unwrap(files.CityDB), languages: unwrap(files.LanguageDB), currencies: unwrap(files.CurrencyDB), conflicts: unwrap(files.Conflicts),
		i18n: needI18N(lang) ? withUI(unwrap(files[i18nKey(lang)]), lang) : null, sounds, flags: new Set(flagKeys || []), warm };
}

export async function loadWorld(lang) {
	const want = JSONS.concat(needI18N(lang) ? [i18nKey(lang)] : []), n = want.length;
	const cached = await Promise.all(want.map(read).concat([read(SFX), read(FLAGSET)]));
	const files = {};
	if (cached.slice(0, n).every(c => c && c.v) && cached[n] && cached[n + 1]) {   // 温: 全部 IDB にある＝即返す（更新は refresh() が裏で）
		want.forEach((k, i) => files[k] = cached[i].v);
		return pack(files, cached[n].files, cached[n + 1].keys, lang, true);
	}
	// 冷（初回・IDB 欠け）: 一段で全部並列。目録も同時に取って保存に添える（次回の refresh が突合できる）
	const [tags, sounds, ...jsons] = await Promise.all([
		listTags().catch(() => null), getSounds().catch(() => []), ...want.map(k => getJSON(k).catch(() => null))]);
	const flags = flagsOf(tags);
	want.forEach((k, i) => {
		const v = jsons[i] || (cached[i] && cached[i].v);
		if (!v) throw new Error(`${k} を取得できません（オフライン・未キャッシュ）`);
		files[k] = v; jsons[i] ? write(k, { etag: tagOf(tags, k), v }) : console.warn(`${k}: ネット不達＝IDB の前回分で起動`);
	});
	sounds.length && write(SFX, { etag: (tags && tags[SFX_FILE]) || null, files: sounds });
	flags.length && write(FLAGSET, { etag: null, keys: flags });
	return pack(files, sounds.length ? sounds : (cached[n] && cached[n].files), flags.length ? flags : (cached[n + 1] && cached[n + 1].keys), lang, false);
}

// 裏の更新: 目録 1 本 → 変わったファイルだけ取り直して IDB へ → 変化があれば onUpdate({ NationDB?, …, "i18n/ja"?, flags? })
// 音は次回起動から（Sound は起動時に組む）。旗の実在集合は目録そのもの＝毎回くらべる
export async function refresh(lang, onUpdate) {
	const tags = await listTags().catch(() => null); if (!tags) return;
	const want = JSONS.concat(needI18N(lang) ? [i18nKey(lang)] : []), changed = {};
	await Promise.all(want.map(async k => {
		const c = await read(k), e = tagOf(tags, k);
		if (c && c.etag && e && c.etag === e) return;
		const v = await getJSON(k).catch(() => null); if (!v) return;
		await write(k, { etag: e || null, v });
		if (!c || !same(c.v, v)) changed[k] = k.startsWith("i18n/") ? withUI(v, lang) : unwrap(v);   // 札なし（言語切替で取った分・bucket の頃の控え）は中身で比較
	}));
	const s = await read(SFX), se = tags[SFX_FILE];
	if (se && (!s || s.etag !== se)) { const f = await getSounds().catch(() => []); f.length && await write(SFX, { etag: se, files: f }); }
	const fs = await read(FLAGSET), keys = flagsOf(tags);
	if (keys.length && (!fs || !same(fs.keys, keys))) { await write(FLAGSET, { etag: null, keys }); changed.flags = new Set(keys); }
	Object.keys(changed).length && onUpdate && onUpdate(changed);
}

// 言語切替: IDB にあれば即返し、裏で取り直して差があれば onUpdate(fresh)。無ければ取得（札は次回の refresh が付ける）
export async function loadI18N(lang, onUpdate) {
	if (!needI18N(lang)) return null;
	const k = i18nKey(lang), c = await read(k);
	const fetchIt = async () => { const v = await getJSON(k).catch(() => null); if (!v) return null; await write(k, { etag: null, v }); return v; };
	if (c && c.v) { onUpdate && fetchIt().then(v => v && !same(v, c.v) && onUpdate(withUI(v, lang))); return withUI(c.v, lang); }
	return withUI(await fetchIt(), lang);
}

// 版が変わって形が合わなくなった IDB を捨てる（呼び出し側は冷やし直す）。d(k,null)=delete・d()=全キー
export async function dropCache() {
	const d = await idb(); if (!d) return 0;
	const keys = (await d().catch(() => [])) || [];
	await Promise.all(keys.map(k => d(k, null).catch(() => {})));
	return keys.length;
}

// 設定の永続化（旧 d3.cache("nations.system")）
export async function systemStore() {
	const idb = await Cache("world/system").catch(() => null);
	return {
		load: async () => (idb && await idb("SystemParameter").catch(() => null)) || {},
		save: async v => idb && idb("SystemParameter", v).catch(() => {}),
	};
}
