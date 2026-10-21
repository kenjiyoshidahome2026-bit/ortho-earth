// common/bigtable.ts（仮想スクロール表）の検定。node で動く口だけ（解析・列の推定・絞り込みと並べ替え・スクロールの換算・CSV のセル）。描画はブラウザ側。
import { toNumber, parseCSV, inferColumns, computeView, csvCell, scrollToContent, contentToScroll, MAX_SCROLL_PX } from "../src/bigtable.ts";

let fail = 0;
const ok = (name, cond, note = "") => { if (!cond) fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${note ? "  " + note : ""}`); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── toNumber ──
ok("toNumber：数・桁区切り・空と - は null", toNumber(3) === 3 && toNumber("1,234.5") === 1234.5 && toNumber(" 7 ") === 7 && toNumber("") === null && toNumber("-") === null && toNumber(null) === null && toNumber("abc") === null && toNumber(NaN) === null && toNumber(Infinity) === null);

// ── parseCSV ──
{
	const { header, rows } = await parseCSV('﻿a,b,c\r\n1,"x,y",3\n"he said ""hi""","line1\nline2",\r\n\n');
	ok("parseCSV：BOM を落とす・見出し", same(header, ["a", "b", "c"]));
	ok("parseCSV：囲みの中の , と改行と \"\"", same(rows[0], ["1", "x,y", "3"]) && same(rows[1], ['he said "hi"', "line1\nline2", ""]));
	ok("parseCSV：末尾の空行を落とす", rows.length === 2, `rows=${rows.length}`);
}
{
	const { rows } = await parseCSV("a\tb\n1\t2", { delimiter: "\t" });
	ok("parseCSV：区切り文字・末尾に改行なし", same(rows, [["1", "2"]]));
	ok("parseCSV：CR だけの改行", same((await parseCSV("a\r1\r2")).rows, [["1"], ["2"]]));
	ok("parseCSV：空文字", same(await parseCSV(""), { header: [], rows: [] }));
}
{
	const seen = [];
	const text = "n\n" + Array.from({ length: 50 }, (_, i) => i).join("\n");
	const { rows } = await parseCSV(text, { yieldEvery: 20, onProgress: (n) => seen.push(n) });
	ok("parseCSV：yieldEvery ごとと最後に onProgress", rows.length === 50 && same(seen, [19, 39, 50]), JSON.stringify(seen));
}

// ── inferColumns ──
{
	const cols = inferColumns(["名称", "出力MW", "メモ"], [["北海道発電所", "1,200", ""], ["B", "-", ""], ["C", "35.5", "x"]]);
	ok("inferColumns：数値列は numeric・右揃え", cols[1].numeric === true && cols[1].align === "right" && cols[0].numeric === false && cols[0].align === "left");
	ok("inferColumns：全角は 2 文字ぶん（幅）", cols[0].width === 6 * 2 * 8 + 20, `width=${cols[0].width}`);
	ok("inferColumns：幅は min〜max", cols[2].width === 70 && inferColumns(["x"], [["y".repeat(100)]])[0].width === 340 && inferColumns(["x"], [["y".repeat(100)]], { maxWidth: 200 })[0].width === 200);
	ok("inferColumns：全部空なら数値でない", inferColumns(["a"], [[""], ["-"]])[0].numeric === false);
}

// ── computeView ──
const rows = [
	["札幌", "太陽光", "10"],
	["函館", "風力", "2,000"],
	["旭川", "太陽光", ""],
	["釧路", "水力", "300"],
	["帯広", "太陽光", "300"],
];
const cols = [{ index: 0 }, { index: 1 }, { index: 2 }];
ok("computeView：何もしなければ null", computeView(rows, cols) === null && computeView(rows, cols, { query: "  " }) === null);
ok("computeView：全列の部分一致", same(computeView(rows, cols, { query: "太陽" }), [0, 2, 4]));
ok("computeView：大文字小文字を区別しない", same(computeView([["ABC"], ["x"]], [{ index: 0 }], { query: "abc" }), [0]));
ok("computeView：全列＝columns に載った列だけ", same(computeView(rows, [{ index: 0 }], { query: "太陽" }), []));
ok("computeView：列別はすべて満たす", same(computeView(rows, cols, { colQueries: [[1, "太陽光"], [2, "300"]] }), [4]));
ok("computeView：数値の昇順＝空は末尾・同値は元の順", same(computeView(rows, cols, { sort: { col: 2, dir: "asc" } }), [0, 3, 4, 1, 2]));
ok("computeView：数値の降順でも空は末尾", same(computeView(rows, cols, { sort: { col: 2, dir: "desc" } }), [1, 3, 4, 0, 2]));
ok("computeView：絞り込み＋並べ替え", same(computeView(rows, cols, { query: "太陽光", sort: { col: 2, dir: "desc" } }), [4, 0, 2]));
ok("computeView：文字の並べ替え（数字は数として）", same(computeView([["a10"], ["a9"], [""], ["a1"]], [{ index: 0 }], { sort: { col: 0, dir: "asc" } }), [3, 1, 0, 2]));
ok("computeView：numeric:false なら数として読める値も文字として（1e1 は 9 より前）", same(computeView([["1e1"], ["9"]], [{ index: 0 }], { sort: { col: 0, dir: "asc" } }), [1, 0]) && same(computeView([["1e1"], ["9"]], [{ index: 0, numeric: false }], { sort: { col: 0, dir: "asc" } }), [0, 1]) && same(computeView([["1e1"], ["9"]], [{ index: 0 }], { numeric: false, sort: { col: 0, dir: "asc" } }), [0, 1]));
{
	const obj = [{ name: "b", mw: 5 }, { name: "a", mw: 50 }];
	ok("computeView：オブジェクトの行（キー名の列）", same(computeView(obj, [{ index: "name" }, { index: "mw" }], { sort: { col: "mw", dir: "desc" } }), [1, 0]) && same(computeView(obj, [{ index: "name" }], { query: "A" }), [1]));
}
{
	const big = Array.from({ length: 100000 }, (_, i) => [String((i * 7919) % 100000), "x"]);
	const t0 = performance.now();
	const v = computeView(big, [{ index: 0 }, { index: 1 }], { sort: { col: 0, dir: "asc" } });
	const ms = performance.now() - t0;
	ok("computeView：10 万行の数値の並べ替え", v.length === 100000 && big[v[0]][0] === "0" && big[v[99999]][0] === "99999" && ms < 2000, `${ms.toFixed(0)}ms`);
}

// ── CSV のセル ──
ok("csvCell", csvCell("a") === "a" && csvCell('x"y') === '"x""y"' && csvCell("a,b") === '"a,b"' && csvCell("a\nb") === '"a\nb"' && csvCell(null) === "" && csvCell(3) === "3");

// ── スクロールの換算 ──
{
	ok("換算：上限より低ければそのまま", scrollToContent(500, 10000, 10000, 600) === 500 && contentToScroll(500, 10000, 10000, 600) === 500);
	const full = 450000 * 28, sp = MAX_SCROLL_PX, vh = 600;
	ok("換算：上端と末尾が合う（末尾の行まで届く）", scrollToContent(0, full, sp, vh) === 0 && scrollToContent(sp - vh, full, sp, vh) === full - vh);
	const t = 5_000_000;
	ok("換算：往復で戻る", Math.abs(scrollToContent(contentToScroll(t, full, sp, vh), full, sp, vh) - t) < 1e-6);
	ok("換算：範囲の外は丸める", contentToScroll(full * 2, full, sp, vh) === sp - vh && scrollToContent(-5, full, sp, vh) === 0);
}

console.log(fail ? `\n${fail} FAIL` : "\nall PASS");
process.exit(fail ? 1 : 0);
