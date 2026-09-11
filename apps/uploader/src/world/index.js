// ── 国別DB（world）の uploader 組み込み（v2・2026-09-11）──
// 正本は packages/world/seed（key・QID・英語基軸）。組み立ては packages/world/build（Node CLI と共用）。
// ここは「ブラウザで組み立てて bucket に保存する」入口と、資産（旗・音源・地形PNG）の出し入れ。
//   全部作る: seed → Wikidata / World Bank / IMF / HDR / en.wikipedia → NationDB・CityDB・LanguageDB・CurrencyDB・Conflicts・i18n/<lang>
//   zip drop: flags.zip（<key>.svg）/ 音源.zip（mp3）/ geoms.zip（png）。svg 一枚差し（<key>.svg）
import * as d3 from 'd3';
import "common/d3/fileio.js";   // dropFiles 拡張
import { download } from "common";
import { decodeZIP, Cache } from "native-bucket";
import { DIRE, DBS, FLAG, SOUND, GEOMS, makeDB } from "./db.js";
import { createGeometryPNG } from "./createGeometryPNG.js";
import { makeEnv } from "../../../../packages/world/build/env.js";
import { loadSeed, SEED_FILES } from "../../../../packages/world/build/seed.js";
import { buildAll } from "../../../../packages/world/build/index.js";
// seed は同梱（ビルド時に取り込む＝repo の seed/ が正本・将来はデータ用リポジトリの submodule）
const SEEDS = import.meta.glob("../../../../packages/world/seed/*", { query: "?raw", import: "default", eager: true });
import uiJSON from "../../../../packages/world/i18n/ui.json?raw";

// TODO: 旧 FlagSVG.clean の移植待ち＝それまでは素通し（svg はそのまま保存）
const cleanSVG = async file => file;

export async function worldUI({ CMD, q, Bucket, Fetch }) {
	const bucket = await Bucket(DIRE);   // 疎通不能時は null（native-bucket の仕様）
	if (!bucket) throw new Error(`Bucket(${DIRE}) に到達できない＝国別DB節は無効`);
	const db = makeDB(bucket);
	// 実行中の console.warn/error を集めて最後に一覧（長時間ジョブで console に散った検札を見落とさない）
	const run = (name, func) => async () => {
		q.clear(); q.title(name); q.log("実行中…（進捗は console）");
		const str = t => typeof t === "string" ? t : (() => { try { return JSON.stringify(t); } catch { return String(t); } })();
		const tally = kind => { const m = new Map(); return Object.assign((...a) => { const s = a.map(str).join(" "); m.set(s, (m.get(s) || 0) + 1); }, { m, kind }); };
		const W = tally("⚠"), E = tally("✖");
		const origW = console.warn, origE = console.error;
		console.warn = (...a) => { W(...a); origW(...a); };
		console.error = (...a) => { E(...a); origE(...a); };
		const report = t => {
			const total = [...t.m.values()].reduce((p, c) => p + c, 0); if (!total) return;
			const list = [...t.m.entries()].sort((p, q2) => q2[1] - p[1]);
			q.log(`── 検札: ${t.kind} ${total} 件 / ${t.m.size} 種 ──`);
			list.slice(0, 40).forEach(([s, n]) => q.log(`${t.kind}${n > 1 ? ` ×${n}` : ""} ${s.slice(0, 200)}`));
			list.length > 40 && q.log(`…他 ${list.length - 40} 種（console 参照）`);
		};
		try { const v = await func(); q.success(`${name}: 完了（${Array.isArray(v) ? v.length + " 件" : typeof v == "string" ? v : "ok"}）`); }
		catch (e) { q.error(`${name}: 失敗 — ${e.message}`); origE(e); }
		finally { console.warn = origW; console.error = origE; report(E); report(W); }
	};
	// ブラウザ用 env: Wikidata/World Bank/DBnomics/wikipedia/commons は CORS 開放＝素の fetch、HDR の CSV だけ proxy（Fetch）経由。キャッシュは IDB
	const idb = await Cache("worldBuild/cache").catch(() => null);   // 取得キャッシュ（viewer の "world" DB とは別名）
	const env = makeEnv({
		fetchJSON: async url => { const r = await fetch(url); if (!r.ok) throw new Error(`${r.status} ${url}`); return r.json(); },
		fetchText: async (url, { proxy } = {}) => proxy ? Fetch(url, { type: "text" }) : (async () => { const r = await fetch(url); if (!r.ok) throw new Error(`${r.status} ${url}`); return r.text(); })(),
		cache: async (k, v) => idb ? (v === undefined ? idb(k) : idb(k, v)) : undefined,
		log: s => console.log(s), warn: s => console.warn(s),
	});
	const seed = await loadSeed(name => {
		if (name == "../i18n/ui.json") return uiJSON;
		const hit = Object.entries(SEEDS).find(([p]) => p.endsWith("/" + name)); if (!hit) throw new Error(`seed が無い: ${name}`);
		return hit[1];
	});
	async function buildAndSave() {
		const r = await buildAll(seed, env);
		if (r.report.errors.length) throw new Error(`検札で errors ${r.report.errors.length} 件＝保存しない（${r.report.errors.slice(0, 3).join(" / ")}）`);
		for (const n of DBS) { await db.saveJSON(n, r[n]); q.log(`${n}.json: ${r[n].length} 件`); }
		for (const [lang, v] of Object.entries(r.i18n)) { await db.saveJSON(`i18n/${lang}`, v); }
		q.log(`i18n: ${Object.keys(r.i18n).length} 言語`);
		return `国 ${r.NationDB.length} / 都市 ${r.CityDB.length} / 言語 ${r.LanguageDB.length} / 通貨 ${r.CurrencyDB.length} / 係争 ${r.Conflicts.length}・warns ${r.report.warns.length}`;
	}

	CMD.append("h1").text("国別DB (world)");
	CMD.append("button").text(`一覧 (${DIRE})`).on("click", async () => {
		q.clear(); q.title(`一覧 (${DIRE})`);
		(await bucket.list()).forEach(t => q.log(`${t.Key}  ${(t.Size / 1024).toFixed(1)}KB  ${t.LastModified}`));
	});
	CMD.append("button").text("全部作る（seed → Wikidata/統計 API → 全 DB + i18n を保存）").on("click", run("build", buildAndSave));
	CMD.append("button").text("geoPNG作成(createGeometryPNG)").on("click", run("createGeometryPNG", () => createGeometryPNG({ db }, q)));
	CMD.append("button").text(`${FLAG}.zip ダウンロード`).on("click", async () => download(await bucket.get(`${FLAG}.zip`), `${FLAG}.zip`));
	CMD.append("button").text(`${SOUND}.zip ダウンロード`).on("click", async () => download(await bucket.get(`${SOUND}.zip`), `${SOUND}.zip`));
	CMD.append("button").text("取得キャッシュ掃除（年次更新前に）").on("click", () => {
		q.clear(); q.title("取得キャッシュ掃除");
		const req = indexedDB.deleteDatabase("worldBuild");
		req.onsuccess = () => q.success("worldBuild: 削除（次の「全部作る」は全部取り直し）");
		req.onblocked = () => q.error("worldBuild: 他タブが掴んでいて削除待ち＝他の uploader タブを閉じてください");
		req.onerror = () => q.error("worldBuild: 削除失敗");
	});
	CMD.append("p").html(`seed: ${SEED_FILES.join(" / ")}（packages/world/seed・${seed.nations.length} 国 / ${seed.cities.length} 都市 / ${seed.conflicts.length} 係争地）`);

	d3.select("body").dropFiles(async files => {
		q.clear(); q.title(`drop: ${files.length} ファイル`);
		for (const file of files) {
			try { await route(file); } catch (e) { q.error(`${file.name}: 失敗 — ${e.message}`); console.error(e); }
		}
	});
	const svgs = async file => (await decodeZIP(file)).filter(t => t.name.match(/\.svg$/) && !t.name.match(/^\./)).sort((p, q) => p.name > q.name ? 1 : -1);
	async function route(file) {
		const name = file.name.normalize('NFC');
		if (name == `${FLAG}.zip`) { const files = await svgs(file); await db.saveFlagDB(files); return q.success(`${FLAG}: 保存（${files.length} 旗）`); }
		if (name == `${SOUND}.zip`) {
			const files = (await decodeZIP(file)).filter(t => t.name.match(/\.mp3$/) && !t.name.match(/^\./)).sort((p, q) => p.name > q.name ? 1 : -1);
			await db.saveSoundDB(files); return q.success(`${SOUND}: 保存（${files.length} 音源）`);
		}
		if (name == `${GEOMS}.zip`) {
			const files = (await decodeZIP(file)).filter(t => t.name.match(/\.png$/) && !t.name.match(/^\./)).sort((p, q) => p.name > q.name ? 1 : -1);
			await db.saveGeoPNG(files); return q.success(`${GEOMS}: 保存（${files.length} 図形PNG）`);
		}
		if (name.match(/\.svg$/)) {   // 国旗 svg 一枚差し（ファイル名＝<key>.svg・収蔵済みの旗と同 key のときだけ差し替え）
			const target = name.replace(/\.svg$/, ""), files = await db.loadFlagDB();
			if (!files.some(t => t.name.replace(/\.svg$/, "") == target)) return q.error(`${target}: ${FLAG}.zip に同 key の旗が無い＝差し替え対象なし（ファイル名は <key>.svg）`);
			const cleaned = await cleanSVG(file);
			await db.saveFlagDB(files.map(t => t.name.replace(/\.svg$/, "") == target ? cleaned : t));
			return q.success(`${FLAG}/${target}.svg: 差し替え`);
		}
		q.log(`${name}: 対象外（DB は「全部作る」で seed から組み立てる）`);
	}
	// console から直接叩けるように（uploader は作業台）
	Object.assign(window, { worldBucket: bucket, worldDB: db, worldSeed: seed, worldEnv: env, buildAll: () => buildAll(seed, env), buildAndSave });
	return db;
}
