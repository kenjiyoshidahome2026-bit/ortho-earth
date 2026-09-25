// t-sjis: Shift_JIS の書き手（src/modules/sjis.js・B8・2026-09-25）。
// 守るもの：依存ゼロ（旧＝実行時に esm.sh から encoding-japanese）で、encoding-japanese が書ける字は全部書ける／
// 書いた符号を TextDecoder("shift_jis") で読むと元の字に戻る／Shapefile の sjis 書き出しが往復する。
// encoding-japanese は突き合わせ専用の devDependency（src からは import しない）。
globalThis.ImageData ??= class ImageData {};
import Encoding from "encoding-japanese";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { encodeSJIS } from "../src/modules/sjis.js";
import { GeoPBF } from "../src/pbf.js";
let fails = 0;
const ok = (c, m) => { if (!c) { console.error("✗", m); fails++; } else console.log("✓", m); };
const hex = a => [...a].map(x => x.toString(16).padStart(2, "0")).join(" ");
const dec = new TextDecoder("shift_jis");

// (A) 見本
ok(hex(encodeSJIS("日本")) === "93 fa 96 7b", "日本 → 93 FA 96 7B");
ok(hex(encodeSJIS("Aｱ")) === "41 b1", "ASCII と半角カナは 1 バイト");
ok(hex(encodeSJIS("😀x")) === "3f 78", "表に無い字（サロゲート対）は ? 1 つ");
ok(hex(encodeSJIS("〜")) === hex(encodeSJIS("～")) && hex(encodeSJIS("−")) === hex(encodeSJIS("－")), "〜／～・−／－ は同じ符号（JIS 系／MS 系）");
ok(!/esm\.sh|https?:\/\//.test(readFileSync(new URL("../src/encoder/shape.js", import.meta.url), "utf8").split("\n").filter(l => /import\s*\(/.test(l)).join("\n")),
	"encoder/shape.js に実行時のネット import が無い");

// (B) BMP 全域を encoding-japanese と突き合わせる
let lost = [], mismatch = [], rtBad = [];
const ALIAS = new Set([0xA2, 0xA3, 0xA5, 0xA6, 0xAC, 0x2014, 0x2016, 0x203E, 0x2212, 0x301C, 0xFF5E, 0xFF0D, 0x2015, 0x2225, 0xFFE0, 0xFFE1, 0xFFE2, 0xFFE4]);
for (let c = 0x20; c < 0x10000; c++) {
	if ((c >= 0xD800 && c <= 0xDFFF) || c === 0x7F || c === 0x80) continue;
	const s = String.fromCharCode(c), a = encodeSJIS(s);
	const b = Encoding.convert(Encoding.stringToCode(s), { from: "UNICODE", to: "SJIS" });
	const aQ = a.length === 1 && a[0] === 0x3F && c !== 0x3F, bQ = b.length === 1 && b[0] === 0x3F && c !== 0x3F;
	if (aQ && !bQ) lost.push(c.toString(16));
	// 符号が違っても（IBM 拡張 FA–FC 行 vs NEC 選定 ED/EE 行）読めば同じ字なら同じ扱い
	if (!aQ && !bQ && hex(a) !== hex(b) && dec.decode(a) !== dec.decode(new Uint8Array(b))) mismatch.push(c.toString(16));
	if (!aQ && !ALIAS.has(c) && dec.decode(a) !== s) rtBad.push(c.toString(16));
}
ok(lost.length === 0, `encoding-japanese が書ける字で ? になるものが無い（${lost.length}${lost.length ? "：" + lost.slice(0, 10) : ""}）`);
ok(mismatch.length === 0, `encoding-japanese と読み戻しの字が一致（違い ${mismatch.length}${mismatch.length ? "：" + mismatch.slice(0, 10) : ""}）`);
ok(rtBad.length === 0, `TextDecoder("shift_jis") で読み戻すと元の字（崩れ ${rtBad.length}${rtBad.length ? "：" + rtBad.slice(0, 10) : ""}）`);

// (C) Shapefile の sjis 書き出し → 読み戻し（.cpg と LDID 0x13）
let seq = 0;
async function runWorker(path, data) {
	globalThis.onmessage = null;
	const got = new Promise(r => { globalThis.postMessage = m => r(m); });
	await import(path + "?v=" + (++seq));
	globalThis.onmessage({ data });
	return got;
}
const S = fileURLToPath(new URL("../src", import.meta.url));
const quiet = async (f) => { const l = console.log; console.log = () => {}; try { return await f(); } finally { console.log = l; } };
const names = ["東京都千代田区", "ｶﾀｶﾅ", "①髙﨑", "abc"];
const fc = { type: "FeatureCollection", features: names.map((n, i) => ({ type: "Feature", properties: { 名前: n }, geometry: { type: "Point", coordinates: [139 + i, 35] } })) };
const src = await new GeoPBF().set(structuredClone(fc));
const f = await quiet(() => runWorker(S + "/encoder/shape.js", { buf: src.arrayBuffer.slice(0), name: "s", opts: { encoding: "sjis" } }));
ok(f instanceof File, "sjis 指定の Shapefile 書き出しが返る（旧＝Node では esm.sh の import で落ちて null）");
if (f instanceof File) {
	const { decodeZIP } = await import(S + "/modules/decodeZIP.js");
	const ents = await decodeZIP(f);
	const db = new Uint8Array(await ents.find(e => /\.dbf$/.test(e.name)).arrayBuffer());
	ok(db[29] === 0x13, "DBF の LDID は 0x13（Shift_JIS）");
	const back = await quiet(() => runWorker(S + "/decoder/shape.js", { file: f, name: "s", precision: 6 }));
	const bp = await new GeoPBF().set(back.data);
	const got = names.map((_, i) => bp.getProperties(i)["名前"]);
	ok(JSON.stringify(got) === JSON.stringify(names), `欄名・値が往復（${JSON.stringify(got)}）`);
}

if (fails) { console.error(`t-sjis: ${fails} 件失敗`); process.exit(1); }
console.log("t-sjis: all ok");
