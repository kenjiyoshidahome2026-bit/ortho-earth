// USGS 地震カタログ（ANSS ComCat）→ GeoPBF。1967 年以降・M2 以上・全世界の地震を 1 ファイルに。
//   ジオメトリ = Point [経度, 緯度]
//   属性      = date（DATE 型・秒精度 UTC）/ depth（震源の深さ km）/ mag（マグニチュード）/ place（M7 以上だけ・USGS の地名）
//               --props id,place,magType,net,status で追加列も載せられる（place を指定すると全件に載る）
// 取得元: https://earthquake.usgs.gov/fdsnws/event/1/ （FDSN Event API・1 リクエスト上限 20,000 件）
//   月ごとに取り、20,000 件の上限に達した月は期間を二分して取り直す。429 は Retry-After／指数バックオフで待つ。月単位の CSV を --cache に保存するので
//   中断しても再実行で続きから（月末から 30 日たつ前に取った月は次回取り直す＝未完・速報値を残さない）。
// 使い方:
//   node scripts/usgs-quakes-build.mjs                                  # 1967-01-01〜今日・M2+ → usgs-quakes-m2.geopbf（gzip）
//   node scripts/usgs-quakes-build.mjs --out apps/world/public/quakes.geopbf --start 2000-01-01 --minmag 4.5
//   node scripts/usgs-quakes-build.mjs --offline                        # 通信せずキャッシュだけで組む
//   オプション: --start --end --minmag --out --cache --precision(既定4≈11m) --concurrency(既定2) --interval(既定1000ms)
//             --props --no-gzip --offline --allow-missing（取得失敗の月があっても書き出す）
//             --refresh（全月を取り直す）/ --refresh-since 2024-01-01（その日以降を含む月だけ取り直す）
//             --manifest（<out>.json に { start, end(排他), minmag, n, builtAt } を書く＝quakes-mirror の archive 用）
// 解析と組み立ては apps/quakes-mirror/usgs.js と共有（cron Worker が直近分を同じ形で焼く）。
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { API as USGS_API, DAY, iso, fetchRange, csvText, months, parseCsvTexts, buildGeoPBF } from "../apps/quakes-mirror/usgs.js";

// ── 引数 ─────────────────────────────────────────────────────────────────────
const VALUED = ["start", "end", "minmag", "out", "cache", "precision", "concurrency", "props", "interval", "refresh-since"];
const opt = {};
for (let i = 2, a = process.argv; i < a.length; i++) {
	if (!a[i].startsWith("--")) continue;
	const k = a[i].slice(2);
	opt[k] = VALUED.includes(k) ? a[++i] : true;
}
const START = opt.start ?? "1967-01-01";
const END = opt.end ?? new Date().toISOString().slice(0, 10);
const MINMAG = Number(opt.minmag ?? 2);
const OUT = opt.out ?? `usgs-quakes-m${String(MINMAG).replace(".", "_")}.geopbf`;
const CACHE = opt.cache ?? ".cache/usgs-quakes";
const PRECISION = Number(opt.precision ?? 4);   // USGS の震央は小数 3〜4 桁が普通＝10^-4°（≈11 m）で十分
const CONCURRENCY = Number(opt.concurrency ?? 2);
const INTERVAL = Number(opt.interval ?? 1000);   // リクエスト開始の最小間隔 ms（全ワーカー共通）＝USGS の 429 対策
const EXTRA = opt.props ? String(opt.props).split(",").map(s => s.trim()).filter(Boolean) : [];
// 地名（USGS の place）は M≥PLACE_MIN だけ既定で載せる（ビューアの再生 tip・クリックの詳細用。全件だと文字列 150 万本）。--props place で全件
const PLACE_MIN = 7;
const placeOnlyBig = !EXTRA.includes("place");
if (placeOnlyBig) EXTRA.push("place");
const GZIP = !opt["no-gzip"];
const API = process.env.USGS_API ?? USGS_API;
const FRESH_MS = 30 * DAY;   // これより新しい期間を含む月はキャッシュを信用しない（速報→確定の更新がある）

// ── 通信 ─────────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
let nextSlot = 0;   // 全ワーカーで共有するリクエスト枠（INTERVAL ごとに 1 本）
async function throttle() {
	const now = Date.now(), at = Math.max(now, nextSlot);
	nextSlot = at + INTERVAL;
	if (at > now) await sleep(at - now);
}
async function get(url, tries = 10) {
	for (let k = 0; ; k++) {
		let wait = Math.min(120000, 2000 * 2 ** k);
		try {
			await throttle();
			const r = await fetch(url, { headers: { "User-Agent": "ortho-earth usgs-quakes-build" } });
			if (r.ok) return await r.text();
			if (r.status === 204) return "";   // 該当なし
			if (r.status === 400 || r.status === 404) throw Object.assign(new Error(`HTTP ${r.status} ${await r.text()}`), { fatal: true });
			if (r.status === 429 || r.status === 503) {
				const ra = Number(r.headers.get("retry-after"));
				if (ra > 0) wait = Math.max(wait, ra * 1000);
				nextSlot = Math.max(nextSlot, Date.now() + wait);   // 429 は全ワーカーでまとめて待つ
			}
			throw new Error(`HTTP ${r.status}`);
		} catch (e) {
			if (e.fatal || k >= tries - 1) throw e;
			process.stdout.write(`\n  ${e.message} → ${Math.round(wait / 1000)} 秒待って再試行 (${k + 1}/${tries - 1})`);
			await sleep(wait);
		}
	}
}
async function loadMonth([s, e]) {
	const file = join(CACHE, `${iso(s).slice(0, 10)}_${iso(e).slice(0, 10)}_m${MINMAG}.csv`);
	// キャッシュを信用するのは「その月が終わって 30 日以上たってから取った」ものだけ（mtime で判定）。
	// 月の途中や直後に取った CSV は未完・速報値なので、次回の実行で取り直す。
	const cached = existsSync(file) ? (await stat(file)).mtimeMs : 0;
	const settled = cached >= e + FRESH_MS;
	const since = opt["refresh-since"] ? Date.parse(opt["refresh-since"] + "T00:00:00Z") : Infinity;
	const forced = opt.refresh || e > since;
	if (cached && (opt.offline || (settled && !forced))) return await readFile(file, "utf8");
	if (opt.offline) return "";
	const text = csvText(await fetchRange(get, s, e, MINMAG, API));
	await writeFile(file, text);
	return text;
}

// ── 本体 ─────────────────────────────────────────────────────────────────────
const t0 = Date.now();
await mkdir(CACHE, { recursive: true });
const windows = months(Date.parse(START + "T00:00:00Z"), Date.parse(END + "T00:00:00Z") + DAY);   // END の日を含む
console.log(`USGS M${MINMAG}+ ${START} 〜 ${END}: ${windows.length} か月 (cache: ${CACHE}${opt.offline ? ", offline" : ""})`);

let done = 0;
const texts = new Array(windows.length);
let next = 0;
const failed = [];
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
	while (next < windows.length) {
		const k = next++;
		try { texts[k] = await loadMonth(windows[k]); }
		catch (e) { failed.push(iso(windows[k][0]).slice(0, 7)); texts[k] = ""; process.stdout.write(`\n  ${iso(windows[k][0]).slice(0, 7)} 取得失敗: ${e.message}`); }
		if (++done % 12 === 0 || done === windows.length) {
			process.stdout.write(`\r  ${done}/${windows.length} か月  (${iso(windows[k][0]).slice(0, 7)})   `);
		}
	}
}));
process.stdout.write("\n");
if (failed.length) {
	console.error(`取得できなかった月が ${failed.length} 件: ${failed.sort().join(", ")}`);
	console.error("取得済みの月はキャッシュ済み。少し時間をおいて同じコマンドを再実行すると続きから取れます（--interval 2000 で間隔を広げると安定します）。");
	if (!opt["allow-missing"]) process.exit(1);
}

const cols = parseCsvTexts(texts, EXTRA);
if (placeOnlyBig) { const q = EXTRA.indexOf("place"); for (let i = 0; i < cols.N; i++) if (!(cols.MAG[i] >= PLACE_MIN)) cols.X[q][i] = null; }
const { N, bad } = cols;
console.log(`地震 ${N.toLocaleString()} 件${bad ? `（壊れた行 ${bad} を除外）` : ""}`);
if (!N) { console.error("データがありません（--offline でキャッシュが空か、通信に失敗）"); process.exit(1); }

let out = Buffer.from(await buildGeoPBF(cols, { minmag: MINMAG, start: START, end: END, precision: PRECISION }));
const raw = out.length;
if (GZIP) out = gzipSync(out, { level: 9 });
await writeFile(OUT, out);
if (opt.manifest) await writeFile(OUT + ".json", JSON.stringify({
	start: START, end: iso(Date.parse(END + "T00:00:00Z") + DAY).slice(0, 10), minmag: MINMAG, n: N, bytes: out.length, builtAt: new Date().toISOString(),
}) + "\n");
const mb = b => (b / 1e6).toFixed(1) + " MB";
console.log(`→ ${OUT}  ${mb(out.length)}${GZIP ? ` (gzip, raw ${mb(raw)})` : ""}  ${N.toLocaleString()} features  ${((Date.now() - t0) / 1000).toFixed(1)} s`);
