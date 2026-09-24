#!/usr/bin/env node
// 門：硬い層（packages/globe/src・packages/ortho-core/src）のコードに地域の語が増えていないか（LAYERS.md 掟 1「globe と core に地域名を書かない」）。
// 2026-09-24 本人「ロバストにするにはエントロピーを下げる」＝下げた状態を機械で保つ＝**爪車（ラチェット）**：
//   ・語はファイルごとに数え、許可表（regionless-allow.json）の数を超えたら ERROR（新しく入った地域の語）
//   ・許可表より減っていたら ERROR（減った分の枠を残すと後で黙って戻せる）＝`--ratchet` で許可表を今の数へ下げる（上げはしない）
//   ・許可表に語を足すのは手で（理由 why を書く）＝地域の語を硬い層に置くのは例外＝凍結した名・過渡の負債だけ
// 見るのはコードと文字列（テンプレート・正規表現を含む）。コメントは見ない（経緯の記録は地域の語を含んでよい）。
// 語の切り方＝識別子は camelCase・_・$ で割る（styleGsi→style,gsi／BindingSize は gsi にならない）・文字列は英数字以外と camelCase で割る。漢字の語は部分一致。
// 使い方: node scripts/verify-regionless.mjs [--ratchet]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PKG = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO = path.join(PKG, "../..");
const ROOTS = ["packages/globe/src", "packages/ortho-core/src"];
const ALLOW_FILE = path.join(PKG, "scripts/regionless-allow.json");
// 地域の語：英字は語として（小文字で照合）・漢字は部分一致。地域パック（日本＝@ortho-earth/jp・オランダ＝ortho-nl）の固有名・データ名・機関名
const WORDS = ["japan", "jp", "tokyo", "sapporo", "arakawa", "gsi", "plateau", "n02", "estat", "mlit", "moj", "3dbag", "pdok"];
const KANJI = ["日本", "東京", "地理院", "国交省", "都道府県", "市区町村"];

// ── 字句：コメントを除き、コード・文字列・テンプレートの地・正規表現を切り出す（行番号つき）──
const KW = /^(return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/;
function segments(src) {
	const out = [], n = src.length, st = [{ m: "code", depth: 0 }];
	let i = 0, line = 1, prev = "", word = "", buf = "", bufLine = 1;
	const flush = kind => { if (buf) out.push({ kind, text: buf, line: bufLine }); buf = ""; };
	while (i < n) {
		const top = st[st.length - 1], c = src[i];
		if (top.m === "tpl") {                                         // テンプレートの地
			if (!buf) bufLine = line;
			if (c === "\\") { buf += src.slice(i, i + 2); i += 2; continue; }
			if (c === "`") { flush("template"); st.pop(); i++; prev = "`"; continue; }
			if (c === "$" && src[i + 1] === "{") { flush("template"); st.push({ m: "code", depth: 0 }); i += 2; prev = "{"; continue; }
			if (c === "\n") line++;
			buf += c; i++; continue;
		}
		if (c === "\n") { line++; i++; continue; }
		if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
		if (c === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2), stop = e < 0 ? n : e + 2; for (let k = i; k < stop; k++) if (src[k] === "\n") line++; i = stop; continue; }
		if (c === '"' || c === "'") {
			const q = c, sl = line; let s = ""; i++;
			while (i < n && src[i] !== q) { if (src[i] === "\\") { s += src.slice(i, i + 2); i += 2; continue; } if (src[i] === "\n") line++; s += src[i++]; }
			i++; out.push({ kind: "string", text: s, line: sl }); prev = q; word = ""; continue;
		}
		if (c === "`") { st.push({ m: "tpl" }); i++; buf = ""; bufLine = line; continue; }
		if (c === "/" && (!/[\w$)\]}]/.test(prev) || KW.test(word))) {   // 正規表現リテラル（除算との判別）
			const sl = line; let s = "", cls = false; i++;
			while (i < n) { const d = src[i]; if (d === "\\") { s += src.slice(i, i + 2); i += 2; continue; } if (d === "\n") break; if (d === "[") cls = true; else if (d === "]") cls = false; else if (d === "/" && !cls) break; s += d; i++; }
			i++; while (/[a-z]/i.test(src[i] || "")) i++;
			out.push({ kind: "regex", text: s, line: sl }); prev = "/"; word = ""; continue;
		}
		if (c === "{") { top.depth++; }
		if (c === "}") { if (top.depth === 0 && st.length > 1) { st.pop(); i++; prev = "}"; continue; } top.depth--; }
		if (/[A-Za-z_$]/.test(c)) {
			let j = i; while (j < n && /[\w$]/.test(src[j])) j++;
			word = src.slice(i, j); out.push({ kind: "code", text: word, line }); prev = src[j - 1]; i = j; continue;
		}
		if (!/\s/.test(c)) { prev = c; word = ""; }
		i++;
	}
	return out;
}
// テンプレートの中の GLSL／WGSL のコメント（行頭か空白の後の // と /* */）は見ない。URL の :// は残る＝地域の URL は拾う
const stripShaderComments = text => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[ \t])\/\/.*$/gm, "$1");
// 語へ割る（camelCase・数字の境目は割らない＝n02 は n02 のまま）
const splitWords = text => text.split(/[^A-Za-z0-9]+/).flatMap(w => w.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)).filter(Boolean).map(w => w.toLowerCase());

function scan() {
	const found = {};   // file → word → [line…]
	const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : /\.m?js$/.test(e.name) ? [path.join(d, e.name)] : []);
	for (const root of ROOTS) for (const abs of walk(path.join(REPO, root))) {
		const rel = path.relative(REPO, abs);
		for (const seg of segments(fs.readFileSync(abs, "utf8"))) {
			if (seg.kind === "template") seg.text = stripShaderComments(seg.text);
			const hits = splitWords(seg.text).filter(w => WORDS.includes(w));
			if (seg.kind !== "code" && /\be-stat\b/i.test(seg.text)) hits.push("estat");
			for (const k of KANJI) { let p = seg.text.indexOf(k); while (p >= 0) { hits.push(k); p = seg.text.indexOf(k, p + k.length); } }
			for (const w of hits) ((found[rel] ??= {})[w] ??= []).push(seg.line);
		}
	}
	return found;
}

const found = scan();
const allowDoc = JSON.parse(fs.readFileSync(ALLOW_FILE, "utf8"));
const allow = allowDoc.allow;
const over = [], under = [];
for (const [file, words] of Object.entries(found)) for (const [w, lines] of Object.entries(words)) {
	const a = allow[file]?.[w]?.n ?? 0;
	if (lines.length > a) over.push(`${file}: "${w}" ×${lines.length}（許可 ${a}）行 ${lines.join(",")}`);
}
for (const [file, words] of Object.entries(allow)) for (const [w, a] of Object.entries(words)) {
	const n = found[file]?.[w]?.length ?? 0;
	if (n < a.n) under.push([file, w, n, a.n]);
}
if (process.argv.includes("--ratchet") && under.length) {   // 減った分だけ下げる（0 になった語・ファイルは消す）＝上げはしない
	for (const [file, w, n] of under) { if (n) allow[file][w].n = n; else delete allow[file][w]; if (!Object.keys(allow[file]).length) delete allow[file]; }
	fs.writeFileSync(ALLOW_FILE, JSON.stringify(allowDoc, null, "\t") + "\n");
	console.log(`ratchet: ${under.length} 件の許可を今の数へ下げた`);
	under.length = 0;
}
const total = Object.values(found).flatMap(w => Object.values(w)).reduce((s, l) => s + l.length, 0);
const allowed = Object.values(allow).flatMap(w => Object.values(w)).reduce((s, a) => s + a.n, 0);
console.log(`regionless: 硬い層の地域の語 ${total} 件（許可 ${allowed}）・${ROOTS.join(" ＋ ")}`);
if (over.length) console.error("✗ 地域の語が増えた（硬い層に地域を書かない＝地域の申告かパックへ。凍結名なら理由を書いて regionless-allow.json へ）\n  " + over.join("\n  "));
if (under.length) console.error("✗ 地域の語が減った＝よい知らせ。許可の枠を下げる：node scripts/verify-regionless.mjs --ratchet\n  " + under.map(([f, w, n, a]) => `${f}: "${w}" ${a} → ${n}`).join("\n  "));
if (over.length || under.length) process.exit(1);
console.log("✓ regionless PASS");
