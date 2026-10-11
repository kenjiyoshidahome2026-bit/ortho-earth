#!/usr/bin/env node
// t-cli: bin/geopbf.mjs の検定（Node 20+・外部データ不要＝決定的）。
// CLI は「別プロセスとして起動して標準出力と終了コードを見る」＝利用者と同じ経路で確かめる。
// 使い方: node packages/geopbf/tests/t-cli.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };

const CLI = new URL("../bin/geopbf.mjs", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "geopbf-cli-"));
const run = (...args) => execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, GEOPBF_LANG: "en" } });

// ---- 元データ（全ジオメトリ種・型付き属性・null 属性・日本語）--------------------
const src = {
	type: "FeatureCollection",
	name: "cli-fixture",
	features: [
		{ type: "Feature", properties: { n: 1, s: "東京", b: true, nil: null },
			geometry: { type: "Point", coordinates: [139.767125, 35.681236] } },
		{ type: "Feature", properties: { n: 2.5 },
			geometry: { type: "LineString", coordinates: [[135.5, 34.7], [135.6, 34.75], [135.7, 34.7]] } },
		{ type: "Feature", properties: { s: "square" },
			geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] } },
		{ type: "Feature", properties: {},
			geometry: { type: "MultiPolygon", coordinates: [[[[10, 10], [11, 10], [11, 11], [10, 10]]]] } },
	],
};
const geojson = join(dir, "in.geojson");
writeFileSync(geojson, JSON.stringify(src));

// ---- enc / info / dec の往復 ---------------------------------------------------
const pbfPath = join(dir, "out.geopbf");
run("enc", geojson, pbfPath);
ok(existsSync(pbfPath), "enc がファイルを書く");

const infoOut = run("info", pbfPath);
ok(/features\s+4/.test(infoOut), "info が地物数を出す");
ok(/precision\s+6/.test(infoOut), "info が既定 precision=6 を出す");
ok(infoOut.includes("cli-fixture"), "info がレイヤ名を出す");

const backPath = join(dir, "back.geojson");
run("dec", pbfPath, backPath);
const back = JSON.parse(readFileSync(backPath, "utf8"));
ok(back.features.length === 4, "dec が地物数を保つ");
ok(back.features[0].geometry.coordinates[0] === 139.767125, "点の座標が precision=6 で一致");
ok(back.features[0].properties.s === "東京", "文字列（日本語）が往復する");
ok(back.features[0].properties.n === 1, "整数が数値のまま往復する");
ok(back.features[1].properties.n === 2.5, "実数が往復する");
ok(back.features[0].properties.b === true, "真偽が往復する");
ok(!("nil" in back.features[0].properties), "null 属性は落ちる（GeoPBF では未設定と同義）");
ok(back.features.map(f => f.geometry.type).join(",") === "Point,LineString,Polygon,Polygon",
	"ジオメトリ種別が保たれる（単部の MultiPolygon は Polygon へ正規化される）");
ok(JSON.stringify(back.features[2].geometry.coordinates[0][0]) === "[0,0]",
	"リングの先頭点は保たれる（巻き方向は書き手が正規化する）");

// ---- precision ------------------------------------------------------------------
const p3 = join(dir, "p3.geopbf");
run("enc", geojson, p3, "--precision", "3");
ok(/precision\s+3/.test(run("info", p3)), "--precision がヘッダに載る");
run("dec", p3, join(dir, "p3.geojson"));
const c3 = JSON.parse(readFileSync(join(dir, "p3.geojson"), "utf8")).features[0].geometry.coordinates[0];
ok(Math.abs(c3 - 139.767125) < 1e-3 && c3 !== 139.767125, `precision=3 で桁が落ちる（${c3}）`);

let threw = false;
try { run("enc", geojson, join(dir, "bad.geopbf"), "--precision", "12"); } catch { threw = true; }
ok(threw, "範囲外の --precision は失敗する");
threw = false;
try { run("enc", geojson, join(dir, "bad0.geopbf"), "--precision", "0"); } catch { threw = true; }
ok(threw, "--precision 0 も範囲外（pbf-base が黙って 6 に落とすため 1-9 のみ）");

// ---- gzip -----------------------------------------------------------------------
const head = readFileSync(pbfPath);
ok(head[0] === 0x1f && head[1] === 0x8b, "enc の既定は gzip（署名で始まる）");
ok(/features\s+4/.test(run("info", pbfPath)), "gzip 入力を拡張子によらず透過的に読む");
const rawPath = join(dir, "out.raw.geopbf");
run("enc", geojson, rawPath, "--no-gzip");
const rawHead = readFileSync(rawPath);
ok(!(rawHead[0] === 0x1f && rawHead[1] === 0x8b), "--no-gzip は生の GeoPBF を書く");
ok(/features\s+4/.test(run("info", rawPath)), "生の GeoPBF も読める");
const gzJson = join(dir, "in.geojson.gz");
writeFileSync(gzJson, gzipSync(readFileSync(geojson)));
run("enc", gzJson, join(dir, "fromgz.geopbf"));
ok(/features\s+4/.test(run("info", join(dir, "fromgz.geopbf"))), "gzip された GeoJSON も enc が署名で判別して読む");

// ---- lod ------------------------------------------------------------------------
const lodOut = run("lod", pbfPath);
const rows = [...lodOut.matchAll(/^\s+(\d+)\s+(\d+)\s+([\d,]+)\s+/gm)]
	.map(m => ({ z: +m[1], keep: +m[3].replace(/,/g, "") }));
ok(rows.length >= 10, "lod がズーム別の表を出す");
ok(rows.every((r, i) => i === 0 || r.keep >= rows[i - 1].keep), "描画頂点数はズームに対して単調非減少");
const totalVerts = +/vertices\s+([\d,]+)/.exec(run("info", pbfPath))[1].replace(/,/g, "");
ok(rows.at(-1).z === 21 && rows.at(-1).keep === totalVerts,
	`z=21 では全頂点が残る（${totalVerts}）`);

// ---- 使い方 ----------------------------------------------------------------------
ok(run("--help").includes("geopbf <command>"), "--help が使い方を出す");
const fail = (...args) => { try { execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GEOPBF_LANG: "en" } }); return null; } catch (e) { return { code: e.status, err: String(e.stderr) }; } };
{
	const r = fail("nosuch");
	ok(r && r.code === 2 && /unknown command "nosuch"/.test(r.err), `未知のコマンドは終了コード 2（${r?.code}）`);
}
// ---- 改良点 16（2026-10-12）: オプション表・未知の --flag の拒否・<cmd> --help・数値検査・別名 ----------
{
	const h = run("enc", "--help");
	ok(h.includes("enc  <in.geojson") && h.includes("--precision") && !h.includes("pmtiles <in.geopbf>"), "enc --help はその段だけ");
	const hc = run("cog", "--help");
	ok(hc.includes("cog  info") && hc.includes("cog  png") && !hc.includes("parquet"), "cog --help は info と png の両段");
	const r1 = fail("enc", geojson, join(dir, "x.geopbf"), "--presicion", "3");
	ok(r1 && r1.code === 2 && /unknown option --presicion/.test(r1.err) && /--precision/.test(r1.err), `打ち間違いのオプションは拒む（終了 2・候補一覧つき）`);
	ok(!existsSync(join(dir, "x.geopbf")), "拒んだ時はファイルを書かない");
	const r2 = fail("enc", geojson, join(dir, "x.geopbf"), "--precision", "abc");
	ok(r2 && r2.code === 2 && /--precision must be an integer from 1 to 9/.test(r2.err), "--precision abc は 2");
	const r3 = fail("gpkg2pbf", join(dir, "nothere.gpkg"), join(dir, "x.geopbf"), "--precision", "0");
	ok(r3 && r3.code === 2 && /--precision/.test(r3.err), "gpkg2pbf でも --precision は読み込み前に同じ検査（旧＝enc だけ）");
	const r4 = fail("pmtiles", pbfPath, join(dir, "x.pmtiles"), "--minzoom", "x");
	ok(r4 && r4.code === 2 && /--minzoom must be an integer 0\.\.30 \(got "x"\)/.test(r4.err), "数値オプションの検査（旧＝NaN が通った）");
	const r5 = fail("pmtiles", pbfPath, join(dir, "x.pmtiles"), "--min-zoom", "5", "--max-zoom", "3");
	ok(r5 && r5.code === 2 && /--minzoom must be an integer 0\.\.3 \(--maxzoom\)/.test(r5.err), "--min-zoom/--max-zoom の別名・minzoom > maxzoom は誤り");
	const r6 = fail("enc", geojson);
	ok(r6 && r6.code === 2 && /usage: geopbf enc <in\.geojson/.test(r6.err), "引数不足は使い方の 1 行（t() 経由）");
	const r7 = fail("enc", geojson, join(dir, "x.geopbf"), "--no-gzip=1");
	ok(r7 && r7.code === 2 && /--no-gzip takes no value/.test(r7.err), "真偽のオプションに値は付けられない");
	const r8 = fail("info", join(dir, "nothere.geopbf"));
	ok(r8 && r8.code === 1 && /ENOENT/.test(r8.err), "実行時の失敗は終了コード 1 のまま");
	run("enc", geojson, join(dir, "eq.geopbf"), "--precision=4", "--no-gzip");
	ok(/precision\s+4/.test(run("info", join(dir, "eq.geopbf"))), "--name=value の形");
	const ja = (() => { try { return execFileSync(process.execPath, [CLI, "enc", geojson, join(dir, "x.geopbf"), "--nosuch"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GEOPBF_LANG: "ja" } }); } catch (e) { return String(e.stderr); } })();
	ok(/知らないオプション --nosuch/.test(ja), "GEOPBF_LANG=ja で日本語の文");
}
// 直接: 引数の表は使い方の文と一致（SPEC の全オプションが usage に載り、usage の --flag は SPEC にある）
{
	const { SPEC, parseArgs, numOpt } = await import("../bin/args.mjs");
	const { t } = await import("../bin/messages.mjs");
	const usage = t("usage");
	let miss = [];
	for (const [cmd, sp] of Object.entries(SPEC)) {
		const i0 = usage.indexOf(`\n  ${cmd} `); if (i0 < 0) { miss.push(`${cmd}: no usage`); continue; }
		const m = usage.slice(i0 + 1).match(/^  [a-z0-9]+ [^]*?(?=\n  [a-z0-9]+ |\n\n)/);
		let block = ""; for (const mm of usage.matchAll(/^  ([a-z0-9]+) [^]*?(?=\n  [a-z0-9]+ |\n\n)/gm)) if (mm[1] === cmd) block += mm[0];
		void m;
		for (const o of [...sp.valued, ...sp.flags]) if (!block.includes(`--${o}`)) miss.push(`${cmd}: --${o} not in usage`);
		for (const mm of block.matchAll(/--([a-z0-9-]+)/g)) if (!sp.valued.includes(mm[1]) && !sp.flags.includes(mm[1])) miss.push(`${cmd}: --${mm[1]} in usage but not in SPEC`);
	}
	ok(miss.length === 0, `SPEC と usage が一致（${miss.join("; ") || "全コマンド"}）`);
	const r = parseArgs("pmtiles", ["in", "out", "--min-zoom=2", "--", "--not-an-option"]);
	ok(r.opts.minzoom === "2" && r.pos.join() === "in,out,--not-an-option", "別名＝正規名に畳む・-- 以降は位置引数");
	ok(numOpt({ a: "1.5" }, "a") === 1.5 && numOpt({}, "a") === undefined, "numOpt: 小数・未指定");
}

console.log(fails ? `\n${fails} 件失敗` : "\n全件通過");
process.exit(fails ? 1 : 0);
