// ── 国別DB（world）の uploader 組み込み ──
// 原典: packages/world/create.js（旧システム）。移植台帳: packages/world/README.md
// データ移送＝旧システムから書き出したファイルをこのページへドロップ → bucket GIS/world/ へ保存。
//   JSON: NationDB.json / CityDB.json / LanguageDB.json / CurrencyDB.json / Conflicts.json / 国名一覧.json
//   zip : 国旗.zip（svg）/ 音源.zip（mp3）/ geoms.zip（png）
//   csv : Conflicts.csv（→ createConflicts で DB 化）/ 国名一覧.csv
// 作成系（createNationDB 等）は旧 #inline スニペットの原典待ち＝ボタンは案内のみ。
import * as d3 from 'd3';
import "common/d3/fileio.js";   // dropFiles 拡張（main.js が読む selection.js には入っていない＝ここで明示ロード）
import { download, thenMap } from "common";
import { decodeZIP } from "native-bucket";
import { createGetHeight } from "altpbf/loader";
import {
	DIRE, toLangs, SEED, NATION, CITY, LANGUAGE, CURRENCY, FLAG, SOUND, CONFLICT, GEOMS,
	renames, rename, makeDB, createWiki, addLanguage, removeLanguage, fixLanguage, createConflicts, blob2rows,
	NATION_KEYS, nationKey, LANG_KEYS,
} from "./db.js";
import { createNationDB } from "./createNationDB.js";
import { createCityDB } from "./createCityDB.js";
import { createLanguageDB, createCurrencyDB } from "./createLanguageDB.js";
import { createGeometryPNG } from "./createGeometryPNG.js";

// TODO: 旧 FlagSVG.clean の移植待ち＝それまでは素通し（svg はそのまま保存）
const cleanSVG = async file => file;

export async function worldUI({ CMD, q, Bucket, Fetch }) {
	const bucket = await Bucket(DIRE);   // 疎通不能時は null（native-bucket の仕様）
	if (!bucket) throw new Error(`Bucket(${DIRE}) に到達できない＝国別DB節は無効`);
	const db = makeDB(bucket);
	const jsonNames = [SEED, NATION, CITY, LANGUAGE, CURRENCY, CONFLICT];
	// 標高サンプラは初回要求時に一度だけ構築（worker 起動＝重い）。都市の coords[2] にだけ使う。
	let _gh = null;
	const getHeight = (...a) => (_gh = _gh || createGetHeight({})).then(f => f(...a));
	const ctx = { db, Fetch, getHeight };
	// 作成系＝ボタン一発。実行中の console.warn（＝突合失敗の検札ログ）を収集して最後に一覧表示
	//（長時間ジョブで console に散った warn を見落とすのが旧ツールの弱点だった）
	const run = (name, func) => async () => {
		q.clear(); q.title(name); q.log("実行中…（進捗は console）");
		// 同一メッセージは畳んで「×N 種類」で出す＝生の洪水を見せない（詳細は console に残る）
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
			list.slice(0, 30).forEach(([s, n]) => q.log(`${t.kind}${n > 1 ? ` ×${n}` : ""} ${s.slice(0, 180)}`));
			list.length > 30 && q.log(`…他 ${list.length - 30} 種（console 参照）`);
		};
		try { const v = await func(); q.success(`${name}: 完了（${Array.isArray(v) ? v.length + " 件" : "ok"}）`); }
		catch (e) { q.error(`${name}: 失敗 — ${e.message}`); origE(e); }
		finally { console.warn = origW; console.error = origE; report(E); report(W); }
	};

	CMD.append("h1").text("国別DB (world)");
	CMD.append("button").text(`一覧 (${DIRE})`).on("click", async () => {
		q.clear(); q.title(DIRE);
		(await bucket.list()).forEach(t => q.log(`${t.Key}: ${(t.Size || 0).toLocaleString()} bytes（${(t.LastModified || "").slice(0, 10)}）`));
	});
	CMD.append("button").text("国データ作成(createNationDB)").on("click", run("createNationDB", () => createNationDB(ctx, toLangs)));
	CMD.append("button").text("都市データ作成(createCityDB)").on("click", run("createCityDB", () => createCityDB(ctx, toLangs)));
	CMD.append("button").text("言語データ作成(createLanguageDB)").on("click", run("createLanguageDB", () => createLanguageDB(ctx, toLangs)));
	CMD.append("button").text("通貨データ作成(createCurrencyDB)").on("click", run("createCurrencyDB", () => createCurrencyDB(ctx, toLangs)));
	CMD.append("button").text("geoPNG作成(createGeometryPNG)").on("click", run("createGeometryPNG", () => createGeometryPNG(ctx, q)));
	CMD.append("button").text(`${SEED}.csv ダウンロード`).on("click", () => downloadSeed());
	CMD.append("button").text(`${CITY}.csv ダウンロード`).on("click", () => downloadCityDB());
	CMD.append("button").text(`${CONFLICT}.json ダウンロード`).on("click", async () => download(json2blob(await db.loadConflicts()), `${CONFLICT}.json`));
	CMD.append("button").text(`${FLAG}.zip ダウンロード`).on("click", async () => download(await bucket.get(`${FLAG}.zip`), `${FLAG}.zip`));
	CMD.append("button").text(`${SOUND}.zip ダウンロード`).on("click", async () => download(await bucket.get(`${SOUND}.zip`), `${SOUND}.zip`));
	// wiki 系 IDB キャッシュ（getContent/extract/sekai-hub html）は無期限＝掃除しない限り再ビルドしても
	// 前回取得の値が返り続ける。年次更新の前にこれを押してから作成系を回す。
	CMD.append("button").text("wikiキャッシュ掃除（年次更新前に）").on("click", () => {
		q.clear(); q.title("wikiキャッシュ掃除");
		["wikiDB", "wikiExtract"].forEach(name => {
			const req = indexedDB.deleteDatabase(name);
			req.onsuccess = () => q.success(`${name}: 削除`);
			req.onblocked = () => q.error(`${name}: 他タブが掴んでいて削除待ち＝他の uploader タブを閉じてください`);
			req.onerror = () => q.error(`${name}: 削除失敗`);
		});
	});

	// 一括投入可＝旧データ一式（NationDB.json + 国旗.zip + …）をまとめてドロップできる
	d3.select("body").dropFiles(async files => {
		q.clear(); q.title(`drop: ${files.length} ファイル`);
		for (const file of files) {
			try { await route(file); } catch (e) { q.error(`${file.name}: 失敗 — ${e.message}`); console.error(e); }
		}
	});
	async function route(file) {
		const name = file.name.normalize('NFC');
		const stem = name.replace(/\.[^.]+$/, "");
		// 旧システムから書き出した DB(JSON) をそのまま収蔵＝データ移送の本線
		if (name.endsWith(".json") && jsonNames.includes(stem)) {
			let v = JSON.parse(await file.text());   // 破損検知＝parse できないものは保存しない
			v = (v && v.items !== undefined) ? v.items : v;   // 版スタンプ包みの再ドロップも受ける
			// NationDB は最終化経由で収蔵＝旧システムの「loadでパッチ」時代のデータ（クリッパートン重複等）もここで正規化
			if (stem == NATION) { await db.saveNationDB(v); }
			else await db.saveJSON(stem, v);
			return q.success(`${stem}.json: 保存（${(Array.isArray(v) ? v.length + " 件" : "object")}）`);
		}
		if (name == `${SEED}.csv`) {
			// seed はヘッダ行なしの生行列（列順: name.ja, extend.ja, capital.ja, name.en, extend.en, capital.en, region, key, wiki.ja, territory, conflict, yomi）
			const v = await blob2rows(file);
			await db.saveSeed(v);
			return q.success(`${SEED}: 保存（${v.length} 件）→ createNationDB → Language → Currency → CityDB の順で再作成`);
		}
		// CityDB.csv＝downloadCityDB の書き出しの逆変換（旧ツールは書き出し専用だったが、完成済みデータの
		// 移送路として取り込みを新設 2026-08-31）。列順: name.ja,en,zh,ko, nation, capital, coords[0..2],
		// population[0..1], wiki.ja,en,zh,ko, yomi（先頭はヘッダ行）
		if (name == `${CITY}.csv`) {
			const rows = (await blob2rows(file)).slice(1);
			const cities = rows.filter(t => t[0]).map(t => {
				const c = { name: { ja: t[0], en: t[1], zh: t[2], ko: t[3] } };
				c.nation = (typeof t[4] == "string" && t[4].includes(",")) ? t[4].split(",") : t[4];   // 首都共有国は配列
				if (t[5] === true) c.capital = true;
				if (t[6] !== "" && t[7] !== "") c.coords = [t[6], t[7], t[8] === "" ? 0 : t[8]];
				c.population = [t[9] === "" ? -1 : t[9], t[10] === "" ? 0 : t[10]];
				c.wiki = { ja: t[11], en: t[12], zh: t[13], ko: t[14] };
				if (t[15]) c.yomi = t[15];
				return c;
			});
			await db.saveCityDB(cities);
			return q.success(`${CITY}: 保存（${cities.length} 都市）← CSV 逆変換`);
		}
		if (name == `${CONFLICT}.csv`) {
			const nation = await db.loadNationDB();
			if (!nation) return q.error(`${NATION} が未収蔵＝先に ${NATION}.json をドロップしてください`);
			const conflicts = await createConflicts(await blob2rows(file), nation);
			await db.saveConflicts(conflicts);
			return q.success(`${CONFLICT}: 保存（${conflicts.length} 件）`);
		}
		if (name == `${FLAG}.zip`) {
			var files = (await decodeZIP(file)).filter(t => t.name.match(/\.svg$/) && !t.name.match(/^\./)).sort((p, q) => p.name > q.name ? 1 : -1);
			// 旧zipの「ジャージー.svg」はNFD名（ジ=シ+濁点）＝国名索引(NFC)から漏れるため名前を正規化して収蔵（2026-08-31実測）
			files = files.map(t => t.name == t.name.normalize('NFC') ? t : new File([t], t.name.normalize('NFC'), { type: t.type }));
			files = await thenMap(files, cleanSVG);
			await db.saveFlagDB(files);
			return q.success(`${FLAG}: 保存（${files.length} 旗）`);
		}
		if (name == `${SOUND}.zip`) {
			const files = (await decodeZIP(file)).filter(t => t.name.match(/\.mp3$/) && !t.name.match(/^\./)).sort((p, q) => p.name > q.name ? 1 : -1);
			await db.saveSoundDB(files);
			return q.success(`${SOUND}: 保存（${files.length} 音源）`);
		}
		if (name == `${GEOMS}.zip`) {
			const files = (await decodeZIP(file)).filter(t => t.name.match(/\.png$/) && !t.name.match(/^\./)).sort((p, q) => p.name > q.name ? 1 : -1);
			await db.saveGeoPNG(files);
			return q.success(`${GEOMS}: 保存（${files.length} 図形PNG）`);
		}
		// 国旗 svg 一枚差し（収蔵済みの旗と同名のときだけ差し替え）
		if (name.match(/\.svg$/)) {
			const target = name.replace(/\.svg$/, "");
			const files = await db.loadFlagDB();
			const names = files.map(t => t.name.replace(/\.svg$/, ""));
			if (!names.includes(target)) return q.error(`${target}: ${FLAG}.zip に同名の旗が無い＝差し替え対象なし`);
			const cleaned = await cleanSVG(file);
			await db.saveFlagDB(files.map(t => t.name.replace(/\.svg$/, "") == target ? cleaned : t));
			return q.success(`${FLAG}/${target}.svg: 差し替え`);
		}
		q.log(`${name}: 対象外（何もしない）`);
	}

	async function downloadSeed() {
		const seed = await db.loadSeed();   // ヘッダ行なしの生行列（drop 側と対称）
		download(new Blob([d3.csvFormatRows(seed)], { type: "text/csv" }), `${SEED}.csv`);
	}
	async function downloadCityDB() {
		const cities = await db.loadCityDB();
		const head = ["name.ja", "name.en", "name.zh", "name.ko", "nation", "capital", "coords[0]", "coords[1]", "coords[2]",
			"population[0]", "population[1]", "wiki.ja", "wiki.en", "wiki.zh", "wiki.ko", "yomi"];
		const a = cities.map(t => [t.name.ja, t.name.en, t.name.zh, t.name.ko, t.nation, !!t.capital, t.coords[0], t.coords[1], t.coords[2],
		t.population[0], t.population[1], t.wiki.ja, t.wiki.en, t.wiki.zh, t.wiki.ko, t.yomi]);
		download(new Blob([d3.csvFormatRows([head].concat(a))], { type: "text/csv" }), `${CITY}.csv`);
	}
	const json2blob = v => new Blob([JSON.stringify(v)], { type: "application/json" });

	// 旧ツール同様、console から直接叩けるように一式を window へ（uploader は作業台＝これが流儀）
	Object.assign(window, {
		worldBucket: bucket, ...db,
		renames, rename, toLangs, createWiki, addLanguage, removeLanguage, fixLanguage, createConflicts,
		NATION_KEYS, nationKey, LANG_KEYS,
		createNationDB: (langs = toLangs) => createNationDB(ctx, langs),
		createCityDB: (langs = toLangs) => createCityDB(ctx, langs),
		createLanguageDB: (langs = toLangs) => createLanguageDB(ctx, langs),
		createCurrencyDB: (langs = toLangs) => createCurrencyDB(ctx, langs),
		createGeometryPNG: () => createGeometryPNG(ctx, q),
	});
	return db;
}
