// common/utility.ts（型の判定・文字列・数の整形・日付・非同期の列・配列）の検定。node で動く口だけ（DOM の入出力はブラウザ側）。
import * as U from "../src/utility.ts";

let fail = 0;
const ok = (name, cond, note = "") => { if (!cond) fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${note ? "  " + note : ""}`); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
globalThis.Element ??= class Element { constructor(h) { this.outerHTML = h; } };   // isDOM／tostr の instanceof 用（node に DOM は無い）

// ── 型の判定 ──
ok("isUndefined・isNull", U.isUndefined(undefined) && !U.isUndefined(null) && U.isNull(null) && !U.isNull(undefined));
ok("isBoolean", U.isBoolean(true) && U.isBoolean(false) && !U.isBoolean(0) && !U.isBoolean("true"));
ok("isNumber は有限だけ", U.isNumber(0) && U.isNumber(-1.5) && !U.isNumber(NaN) && !U.isNumber(Infinity) && !U.isNumber("1"));
ok("isFloat", U.isFloat(1.5) && !U.isFloat(2) && !U.isFloat(NaN));
ok("isString・isFunction・isArray", U.isString("") && !U.isString(1) && U.isFunction(() => 0) && !U.isFunction({}) && U.isArray([]) && !U.isArray("a"));
ok("isAsync", U.isAsync(async () => 0) && !U.isAsync(() => 0));
ok("isDate", U.isDate(new Date()) && !U.isDate(Date.now()));
ok("isObject は配列と null を除く", U.isObject({}) && !U.isObject([]) && !U.isObject(null) && U.isObject(new Map()));
ok("isSimpleObject＝素の object の鍵の数", U.isSimpleObject({ a: 1, b: 2 }) === 2 && U.isSimpleObject({}) === 0 && U.isSimpleObject(new Map()) === false && U.isSimpleObject([1]) === false);
ok("isBuffer", U.isBuffer(new ArrayBuffer(1)) && U.isBuffer(new Uint8Array(1)) && U.isBuffer(new DataView(new ArrayBuffer(1))) && !U.isBuffer([1]));
ok("isBlob・isFile", U.isBlob(new Blob([])) && !U.isFile(new Blob([])) && U.isFile(new File([], "a.txt")) && !U.isBlob("x"));
ok("isURL は http(s) だけ", !!U.isURL("https://a.b/c") && !!U.isURL("http://x") && !U.isURL("ftp://x") && !U.isURL("/a") && !U.isURL(1));
ok("isDOM", U.isDOM(new Element("<p/>")) && !U.isDOM({}));
ok("isBbox：順序と範囲", U.isBbox([-180, -90, 180, 90]) && U.isBbox([139, 35, 140, 36]) && !U.isBbox([140, 35, 139, 36]) && !U.isBbox([0, 0, 181, 1]) && !U.isBbox([0, 0, 1]) && !U.isBbox(null) && !U.isBbox([0, 0, NaN, 1]));

// ── 文字列 ──
ok("toArray", same(U.toArray(1), [1]) && same(U.toArray([1, 2]), [1, 2]) && same(U.toArray(null), []) && same(U.toArray(undefined), []) && same(U.toArray(0), [0]));
ok("trim：連続空白を 1 つに・前後を落とす", U.trim("  a \n\t b  ") === "a b" && U.trim(12) === "12" && U.trim("") === "");
ok("trim：長い空白でも線形（後戻りしない）", (() => { const t0 = performance.now(); U.trim(" ".repeat(200000) + "x"); return performance.now() - t0 < 200; })());
ok("strfix：NFKC（全角英数→半角）", U.strfix(" ＡＢＣ１２３ ") === "ABC123" && U.strfix("ｶﾞ") === "ガ");
ok("comma：数は toLocaleString・文字列は 3 桁区切り", U.comma(1234567) === (1234567).toLocaleString() && U.comma("1234567.891") === "1,234,567.891" && U.comma("1,234") === "1,234" && U.comma(null) === "" && U.comma("12") === "12");
ok("L2〜L5（0 埋め）", U.L2(5) === "05" && U.L3(5) === "005" && U.L4(12) === "0012" && U.L5(123456) === "123456");
ok("jsonSize（MB・小数 3 桁）", U.jsonSize({ a: 1 }) === "0.000 MB" && U.jsonSize("x".repeat(1048574)) === "1.000 MB");
{
	const o = { a: 1, b: 2 }; U.clearObject(o);
	ok("clearObject", Object.keys(o).length === 0);
}
ok("tostr：配列は trim して <br/> で結ぶ（空は捨てる）", await U.tostr([" a ", "", "b"]) === "a<br/>b");
ok("tostr：関数・async 関数は呼んだ値", await U.tostr(() => "x") === "x" && await U.tostr(async () => "y") === "y");
ok("tostr：DOM は outerHTML・偽は空・他は String", await U.tostr(new Element("<b>z</b>")) === "<b>z</b>" && await U.tostr(0) === "" && await U.tostr(null) === "" && await U.tostr(12) === "12");

// ── 日付 ──
{
	const d = new Date(2026, 0, 2, 3, 4, 5);
	ok("dateArray", same(U.dateArray(d), [2026, "01", "02"]));
	ok("timeArray", same(U.timeArray(d), ["03", "04", "05"]));
	ok("datimArray", same(U.datimArray(d), [2026, "01", "02", "03", "04", "05"]));
	ok("引数なし＝今", U.dateArray()[0] === new Date().getFullYear() && U.timeArray().length === 3);
	ok("数・文字列の日付", U.dateArray(d.getTime())[2] === "02" && U.dateArray("2026-12-31T00:00:00")[1] === "12");
}

// ── 非同期の列 ──
{
	const err = console.error; const errs = []; console.error = e => { errs.push(e); };
	const seen = [];
	await U.thenEach([1, 2, 3], async (v, i) => { seen.push(v * 10 + i); if (v === 2) throw new Error("x"); });
	ok("thenEach：順に・失敗しても続ける", same(seen, [10, 21, 32]) && errs.length === 1);
	const m = await U.thenMap([1, 2, 3], async v => { if (v === 2) throw new Error("y"); return v * 2; });
	ok("thenMap：順に・失敗は undefined", m[0] === 2 && m[1] === undefined && m[2] === 6 && errs.length === 2, `errs=${errs.length} m=${m}`);
	console.error = err;
	let live = 0, peak = 0;
	const r = await U.thread([1, 2, 3, 4, 5, 6, 7], async v => { live++; peak = Math.max(peak, live); await new Promise(f => setTimeout(f, 5)); live--; if (v === 4) throw 0; return v; }, 3);
	ok("thread：同時は n 本まで・失敗は飛ばす・全部終わってから返す", peak === 3 && r.length === 6 && same([...r].sort(), [1, 2, 3, 5, 6, 7]));
	ok("thread：空は即 []", same(await U.thread([], async v => v), []));
}

// ── 配列 ──
ok("max・min・sum（空・null）", U.max([1, 5, 3]) === 5 && U.min([4, -1]) === -1 && U.sum([1, 2, 3]) === 6 && U.sum(null) === 0 && U.max([]) === -Infinity && U.min(undefined) === Infinity);
ok("unique・concat", same(U.unique([1, 1, 2, "a", "a"]), [1, 2, "a"]) && same(U.concat([[1], [2, 3], []]), [1, 2, 3]));
ok("slice（n 個ずつ）", same(U.slice([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]) && same(U.slice([], 3), []));
{
	const a = Array.from({ length: 50 }, (_, i) => i), r = U.random(a);
	ok("random：同じ配列をその場で並べ替え・要素は同じ", r === a && same([...r].sort((x, y) => x - y), Array.from({ length: 50 }, (_, i) => i)));
}
ok("xy2yx（転置）", same(U.xy2yx([[1, 2, 3], [4, 5, 6]]), [[1, 4], [2, 5], [3, 6]]) && same(U.xy2yx([]), []));
ok("escape：document が無ければ何もしない", U.escape(() => {}) === undefined);

console.log(fail ? `\n✗ ${fail} 件失敗` : "\n✓ t-utility 全 PASS");
process.exit(fail ? 1 : 0);
