// ── 国別DB（world）の uploader 組み込み（v2・2026-09-11）──
// 正本は packages/world/seed（key・QID・英語基軸）。組み立ては packages/world/build（Node CLI と共用）。
// ここは「ブラウザで組み立てて bucket に保存する」入口と、資産（旗・音源・地形PNG）の出し入れ。
//   全部作る: seed → Wikidata / World Bank / IMF / HDR / en.wikipedia → NationDB・CityDB・TerrainDB・LanguageDB・CurrencyDB・Conflicts・i18n/<lang>・rivers（川の形状 GeoJSON）・range（山脈の軸線 GeoJSON）
//   zip drop: flags.zip（<key>.svg）/ 音源.zip（mp3）/ geoms.zip（png）。svg 一枚差し（<key>.svg）
//   NE Cultural: Natural Earth 10m から key ごとに切った台帳（ne-cultural.geopbf）を生成して保存＝apps/equal が国・道路・鉄道・市街地に読む（2026-09-18）
import * as d3 from 'd3';
import "common/d3/fileio.js";   // dropFiles 拡張
import { download } from "common";
import { decodeZIP, Cache, gzip } from "native-bucket";
import { DIRE, DBS, FLAG, SOUND, GEOMS, CULTURAL, makeDB, RIVERS, RANGES } from "./db.js";
import { createGeometryPNG } from "./createGeometryPNG.js";
import { makeEnv } from "../../../../packages/world/build/env.js";
import { loadSeed, SEED_FILES } from "../../../../packages/world/build/seed.js";
import { buildAll } from "../../../../packages/world/build/index.js";
import { buildNeCultural, NE_TAG, NE_LAYERS, NE_SOURCES, neURL, SINGLE_DESC, splitGroups, groupDesc, cityNameTables, NE_CITY_LANGS } from "../../../../packages/world/build/ne-cultural.js";
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
		if (r.rivers) { await db.saveJSON(RIVERS, r.rivers); q.log(`${RIVERS}.json: 川の形状 ${r.rivers.features.length} 件`); }
		if (r.ranges) { await db.saveJSON(RANGES, r.ranges); q.log(`${RANGES}.json: 山脈の軸線 ${r.ranges.features.length} 件`); }
		return `国 ${r.NationDB.length} / 都市 ${r.CityDB.length} / 地形 ${r.TerrainDB.length}（川の形状 ${r.rivers ? r.rivers.features.length : 0}・山脈の軸線 ${r.ranges ? r.ranges.features.length : 0}）/ 言語 ${r.LanguageDB.length} / 通貨 ${r.CurrencyDB.length} / 係争 ${r.Conflicts.length}・warns ${r.report.warns.length}`;
	}

	// ── NE Cultural（key ごとに切った台帳）＝生成して保存 ──
	// 切り分けの本体は packages/world/build/ne-cultural.js（Node CLI と同一コード＝出力はバイト一致を検証済み）。
	// 取得は raw.githubusercontent（版固定・CORS 可）を素で読む＝生 geojson 計 90MB 級なので IDB には残さない（掃除の対象を増やさない）。
	async function buildCultural() {
		q.log(`Natural Earth 10m ${NE_TAG} を読む（生 geojson 計 90MB 級・メモリを食う）: ${NE_SOURCES.length} ファイル`);
		const ne = async name => {
			q.log(`取得 ${name} …`);
			const r = await fetch(neURL(name));
			if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
			return (await r.json()).features;
		};
		const r = await buildNeCultural(seed, { ne, log: s => q.log(s), warn: s => console.warn(s) }, {});
		// 検札（保存前）：層が全部あるか・key が seed の大半に付いたか。欠けたまま上げると equal の国が消える
		const missing = NE_LAYERS.filter(l => !r.index.report[l]);
		if (missing.length) throw new Error(`層が欠けている: ${missing.join(", ")}`);
		const keys = Object.keys(r.index.keys).length;
		if (keys < seed.nations.length * 0.9) throw new Error(`key が少なすぎる: ${keys} / seed ${seed.nations.length}＝切り分けが途中`);
		const gz = await gzip(new Blob([await r.encode(CULTURAL, r.all, SINGLE_DESC)]));
		r.index.single = { file: `${CULTURAL}.geopbf`, features: r.all.length, vertices: r.countVerts(r.all), bytes: gz.size };
		await db.saveGeoPBF(`${CULTURAL}.geopbf`, gz);
		r.index.groups = {};   // 配信用の分割（base＝国・detail＝道路など）＝apps/equal が読むのはこちら
		for (const [g, feats] of Object.entries(splitGroups(r.all))) {
			const b = await gzip(new Blob([await r.encode(`${CULTURAL}-${g}`, feats, groupDesc(g))]));
			await db.saveGeoPBF(`${CULTURAL}-${g}.geopbf`, b);
			r.index.groups[g] = { file: `${CULTURAL}-${g}.geopbf`, features: feats.length, vertices: r.countVerts(feats), bytes: b.size };
			q.log(`${DIRE}/${CULTURAL}-${g}.geopbf: ${feats.length} 地物・${(b.size / 1e6).toFixed(1)}MB (gzip)`);
		}
		r.index.cityNames = await saveCityNames(r.all);   // 言語別の都市名表（NE の 24 言語・英語と違う分だけ）
		await db.saveJSON(CULTURAL, r.index);   // 要約（Node の out/ne-cultural.json と同じ中身）も棚に置く＝どの版が載っているか後から読める
		q.log(`${DIRE}/${CULTURAL}.geopbf: ${keys} key・${r.all.length} 地物・${(gz.size / 1e6).toFixed(1)}MB (gzip)`);
		q.log("apps/equal は次の訪問から反映（IDB の写しは ETag の差で入れ替わる）");
		return `${keys} key / ${r.all.length} 地物`;
	}

	// 言語別の都市名表＝GIS/world/ne-cities/<lang>.json（{ updated, tag, n, names:{QID:名前} }）。
	// apps/equal は現在の言語の 1 本だけを引く＝起動の 1 本（ne-cultural-base）は太らせない。
	async function saveCityNames(all) {
		const { tables, cities, keyed } = cityNameTables(all);
		const report = {};
		for (const lang of NE_CITY_LANGS) {
			const names = tables[lang], n = Object.keys(names).length;
			await db.saveJSON(`ne-cities/${lang}`, { updated: new Date().toISOString().slice(0, 10), tag: NE_TAG, n, names });
			report[lang] = n;
		}
		q.log(`ne-cities: ${cities} 都市（QID 付き ${keyed}）→ ${NE_CITY_LANGS.length} 言語 … ` + NE_CITY_LANGS.map(l => `${l}:${report[l]}`).join(" "));
		return { tag: NE_TAG, cities, keyed, langs: report };
	}
	// 都市名だけの焼き直し＝NE の populated_places 1 ファイルで済む（ne-cultural 全体の 90MB 取得を待たない）
	async function buildCityNames() {
		q.log(`取得 ne_10m_populated_places（Natural Earth 10m ${NE_TAG}）…`);
		const r = await fetch(neURL("ne_10m_populated_places"));
		if (!r.ok) throw new Error(`populated_places: HTTP ${r.status}`);
		const feats = (await r.json()).features.map(f => ({ ...f, properties: { ...f.properties, layer: "populated_places" } }));
		const out = await saveCityNames(feats);
		return `${out.keyed} 都市 × ${NE_CITY_LANGS.length} 言語`;
	}

	CMD.append("h1").text("国別DB (world)");
	CMD.append("button").text(`一覧 (${DIRE})`).on("click", async () => {
		q.clear(); q.title(`一覧 (${DIRE})`);
		(await bucket.list()).forEach(t => q.log(`${t.Key}  ${(t.Size / 1024).toFixed(1)}KB  ${t.LastModified}`));
	});
	CMD.append("button").text("全部作る（seed → Wikidata/統計 API → 全 DB + i18n を保存）").on("click", run("build", buildAndSave));
	CMD.append("button").text(`NE Cultural 生成→保存（${CULTURAL}.geopbf・国/道路/鉄道/市街地を key ごとに切る）`).on("click", run("ne-cultural", buildCultural));
	CMD.append("button").text(`NE 都市名の多言語表（ne-cities/<lang>.json・${NE_CITY_LANGS.length} 言語）`).on("click", run("ne-cities", buildCityNames));
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
	Object.assign(window, { worldBucket: bucket, worldDB: db, worldSeed: seed, worldEnv: env, buildAll: () => buildAll(seed, env), buildAndSave, buildCultural, buildCityNames });
	return db;
}
