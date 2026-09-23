// ortho-japan の UI 文言を「英語キーの集合」として読み出す唯一の走査器（i18n-extract と verify-i18n の共通の目）。
//
// 二つの時代のどちらでも同じ形を返すのが要点：
//   ja キー期（〜Phase 1）  … 各ガジェットが持参する tr({ "日本語": "English" }) を反転して英語キーを得る。
//   英語キー期（Phase 1 後）… tr() は辞書を持たない＝t("English") の引数がそのまま英語キー。
// これで「置換の前と後を同じ物差しで比べられる」＝機械置換の門（byte 一致）が成り立つ。
//
// 字句解析は自前の小さな状態機械。理由＝コメント中の日本語や、テンプレート地の中の "…" を文字列と
// 見誤ると置換表に嘘が混じる（置換表は Phase 1 の唯一の入力＝ここが正しくないと全部が崩れる）。
import fs from "node:fs";
import path from "node:path";

const SKIP_DIRS = new Set(["node_modules", "dist", "public", "scripts", "tests", "sdk", ".vite", ".git", "out"]);
const RE_KEYWORD = /\b(return|typeof|case|in|of|do|else|instanceof|new|delete|void|yield|await)$/;
const CTX_SEP = " ##";          // 衝突の手当て＝キーに文脈を足す（表示では捨てる）。gettext の msgctxt と同じ考え

// プレースホルダの正規化 {0}{1}… → $1$2…（world の trans と同じ書式）。キーと訳文の両方をこの形に揃える。
export const toDollar = str => String(str).replace(/\{(\d)\}/g, (_, d) => "$" + (Number(d) + 1));

const ESC = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0", "\n": "" };
const unescape_ = raw => raw.replace(/\\(u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|[\s\S])/g,
	(m, tail, uB, u4, x2) => uB ? String.fromCodePoint(parseInt(uB, 16))
		: u4 ? String.fromCharCode(parseInt(u4, 16))
		: x2 ? String.fromCharCode(parseInt(x2, 16))
		: (ESC[tail] ?? tail));

// 字句解析：isCode（その文字がコード＝文字列/コメント/テンプレ地の外か）と、見つけた文字列リテラルを返す。
export function lex(src) {
	const n = src.length, isCode = new Uint8Array(n), strings = [];
	const st = [{ m: "code", depth: 0 }];
	let i = 0, line = 1, prev = "", word = "";
	while (i < n) {
		const top = st[st.length - 1], c = src[i];
		if (top.m === "tpl") {                                   // テンプレート地（`…` の文字部分）＝コードでない
			if (c === "\\") { i += 2; continue; }
			if (c === "\n") { line++; i++; continue; }
			if (c === "`") { st.pop(); i++; continue; }
			if (c === "$" && src[i + 1] === "{") { st.push({ m: "code", depth: 0 }); i += 2; continue; }
			i++; continue;
		}
		if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
		if (c === "/" && src[i + 1] === "*") {
			const e = src.indexOf("*/", i + 2), stop = e < 0 ? n : e + 2;
			for (let k = i; k < stop; k++) if (src[k] === "\n") line++;
			i = stop; continue;
		}
		if (c === '"' || c === "'") {                            // 文字列リテラル＝位置つきで採る
			const start = i, q = c, sl = line;
			let raw = ""; i++;
			while (i < n) {
				const d = src[i];
				if (d === "\\") { raw += d + (src[i + 1] ?? ""); i += 2; continue; }
				if (d === q) { i++; break; }
				if (d === "\n") line++;
				raw += d; i++;
			}
			isCode[start] = 1;   // 開き引用符はコード（中身は非コード）＝strings は全て code 文脈で採れている印
			strings.push({ q, raw, value: unescape_(raw), start, end: i, line: sl });
			prev = q; word = ""; continue;
		}
		if (c === "`") { st.push({ m: "tpl" }); i++; prev = "`"; word = ""; continue; }
		if (c === "/" && (!/[\w$)\]]/.test(prev) || RE_KEYWORD.test(word))) {   // 正規表現リテラル（除算との判別）
			i++;
			let cls = false;
			while (i < n) {
				const d = src[i];
				if (d === "\\") { i += 2; continue; }
				if (d === "[") cls = true;
				else if (d === "]") cls = false;
				else if (d === "/" && !cls) { i++; break; }
				else if (d === "\n") break;
				i++;
			}
			prev = "/"; word = ""; continue;
		}
		if (c === "\n") line++;
		if (c === "{") top.depth++;
		else if (c === "}") {
			if (top.depth === 0 && st.length > 1) { st.pop(); i++; continue; }   // ${…} を閉じる
			top.depth--;
		}
		isCode[i] = 1;
		if (!/\s/.test(c)) { prev = c; word = /[\w$]/.test(c) ? word + c : ""; }
		i++;
	}
	return { isCode, strings };
}

const lineAt = (src, idx) => { let n = 1; for (let i = 0; i < idx; i++) if (src[i] === "\n") n++; return n; };

// ソース 1 本を読む → { dict, tCalls, strings }
export function scanSource(src, rel = "") {
	const { isCode, strings } = lex(src);
	const dict = new Map(), dictErrors = [];
	for (const m of src.matchAll(/(?<![\w$.])tr\(\s*\{/g)) {                  // tr({ … }) の持参辞書
		const open = m.index + m[0].length - 1;
		if (!isCode[open]) continue;                                            // 文字列/コメントの中の見かけ倒し
		let depth = 0, j = open;
		for (; j < src.length; j++) {
			if (!isCode[j]) continue;
			if (src[j] === "{") depth++;
			else if (src[j] === "}" && !--depth) break;
		}
		try {
			const obj = new Function("return " + src.slice(open, j + 1))();
			for (const [k, v] of Object.entries(obj)) {
				if (typeof v !== "string") { dictErrors.push({ rel, key: k, why: "value is not a string" }); continue; }
				dict.set(k, v);
			}
		} catch (e) { dictErrors.push({ rel, key: "(dict literal)", why: String(e.message || e) }); }
	}
	const tCalls = [];                                                        // t("…") の直接呼び（第一引数がリテラル）
	for (const m of src.matchAll(/(?<![\w$.])t\(\s*(["'])((?:[^\\]|\\[\s\S])*?)\1/g)) {
		if (!isCode[m.index]) continue;
		tCalls.push({ value: unescape_(m[2]), line: lineAt(src, m.index) });
	}
	return { dict, dictErrors, tCalls, strings };   // strings は lex が code 文脈でだけ積む＝濾過不要
}

export function listFiles(dir, out = [], root = dir, exclude = null) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) listFiles(path.join(dir, e.name), out, root, exclude); continue; }
		if (e.name.endsWith(".js") && !(exclude && exclude.has(path.relative(root, path.join(dir, e.name))))) out.push(path.join(dir, e.name));
	}
	return out;
}

// アプリ全体を走査 → 英語キーの台帳。ctx＝衝突の手当て表（scripts/i18n-contexts.json＝{ "<file>": {ja:key}, "*": {ja:key} }）。
//   keys: 英語キー → { ja, files:Set, uses:[{rel,line,indirect}] }
//   perFile: rel → Map(ja → 英語キー)＝Phase 1 の置換表そのもの
// opts.exclude＝走査から外す相対パスの集合（showcase ページの辞書は別＝i18n/pages.json）。opts.only＝この集合だけ走査
// LITERAL_ROOTS＝アプリの外にある地域パック（@ortho-earth/jp）＝t() は呼ばないが出典・画像タイルの key を英語キーのデータとして持つ
// ＝文字列だけを「在る」印に数える（無いと移設したキーが次の i18n:extract で退役する・2026-09-22）。opts.only（ページ別の走査）には足さない。
export const LITERAL_ROOTS = ["../../packages/jp/src", "../../packages/ortho-core/src"];   // ortho-core＝worldstyle のテーマ名札（"Blank map" 等・段階 3）
// HOST＝地球儀のホスト（packages/globe/src・S4 2026-09-23）＝本体の走査に「globe/」の接頭辞で混ぜる（scripts/i18n-contexts.json・pages.json の鍵も同じ表記）
export const HOST_REL = "../../packages/globe/src", HOST_PREFIX = "globe/";
export const hostDir = appDir => path.join(appDir, HOST_REL);
export const absOf = (appDir, rel) => rel.startsWith(HOST_PREFIX) ? path.join(hostDir(appDir), rel.slice(HOST_PREFIX.length)) : path.join(appDir, rel);
export function scanApp(appDir, ctx = {}, { exclude = null, only = null, extraRoots = [{ dir: hostDir(appDir), prefix: HOST_PREFIX }] } = {}) {
	const entries = listFiles(appDir, [], appDir, exclude).map(abs => ({ abs, rel: path.relative(appDir, abs) }));
	for (const x of extraRoots) if (fs.existsSync(x.dir)) for (const abs of listFiles(x.dir, [], x.dir, null)) entries.push({ abs, rel: x.prefix + path.relative(x.dir, abs) });
	const files = entries.filter(e => !only || only.has(e.rel)).sort((a, b) => a.rel < b.rel ? -1 : 1).map(e => ({ rel: e.rel, src: fs.readFileSync(e.abs, "utf8") }));

	// 一周目＝辞書を全部読む。t を引数で受け取る部品（tellus-api.js orbitLabel のような注入型）は辞書を持たない
	// ＝呼び手の辞書で訳される。だから解決は「自分の辞書 → 全体の辞書」の順に引く（file を跨ぐ ja→キーの一意性は検分する）。
	const dictErrors = [], perFile = new Map(), global_ = new Map();
	let jaEra = false;
	for (const f of files) {
		const s = scanSource(f.src, f.rel);
		dictErrors.push(...s.dictErrors);
		f.scan = s;
		if (!s.dict.size) continue;
		jaEra = true;
		const map = new Map();
		for (const [rawJa, en] of s.dict) {
			const key = toDollar(ctx[f.rel]?.[rawJa] ?? ctx["*"]?.[rawJa] ?? en);
			map.set(rawJa, key);
			if (!global_.has(rawJa)) global_.set(rawJa, new Set());
			global_.get(rawJa).add(key);
		}
		perFile.set(f.rel, map);
	}

	// 二周目＝使用箇所を数え、台帳を組む
	const keys = new Map(), collisions = new Map(), untranslated = [], rels = [], literals = new Set(), literalsByFile = new Map();
	const put = (key, ja, rawJa, rel) => {
		const rec = keys.get(key);
		if (!rec) { keys.set(key, { ja, rawJa, files: new Set([rel]), uses: [] }); return keys.get(key); }
		if (ja && rec.ja !== ja) {
			if (!collisions.has(key)) collisions.set(key, new Set([rec.ja]));
			collisions.get(key).add(ja);
		}
		rec.files.add(rel);
		return rec;
	};
	for (const f of files) {
		const s = f.scan, own = perFile.get(f.rel);
		for (const st of s.strings) literals.add(st.value);   // 表/配列に置かれたキー（t(x) の間接参照）も「在る」印
		literalsByFile.set(f.rel, new Set(s.strings.map(st => st.value)));
		if (!own && !s.tCalls.length) continue;
		// 自分の辞書を持たない file（注入型の部品）＝全体の辞書で引ける ja リテラルだけを自分の置換表にする
		const map = own ?? new Map();
		if (!own) for (const st of s.strings) {
			const cand = global_.get(st.value);
			if (!cand) continue;
			if (cand.size > 1) { untranslated.push({ rel: f.rel, line: st.line, value: st.value, why: "ambiguous across files" }); continue; }
			map.set(st.value, [...cand][0]);
		}
		if (!map.size && !s.tCalls.length) continue;
		rels.push(f.rel);
		if (!own && map.size) perFile.set(f.rel, map);
		for (const [rawJa, key] of map) put(key, toDollar(rawJa), rawJa, f.rel);
		for (const c of s.tCalls) {
			if (map.has(c.value)) { keys.get(map.get(c.value)).uses.push({ rel: f.rel, line: c.line }); continue; }
			if (!jaEra) { put(c.value, "", "", f.rel).uses.push({ rel: f.rel, line: c.line }); continue; }   // 英語キー期＝引数がキー
			untranslated.push({ rel: f.rel, line: c.line, value: c.value });   // 辞書にない＝英語 UI でも日本語のまま出る
		}
		for (const st of s.strings) if (map.has(st.value)) keys.get(map.get(st.value)).uses.push({ rel: f.rel, line: st.line, indirect: true });
	}
	if (!only) for (const rel of LITERAL_ROOTS) {
		const root = path.join(appDir, rel);
		if (fs.existsSync(root)) for (const abs of listFiles(root)) for (const st of scanSource(fs.readFileSync(abs, "utf8"), path.relative(appDir, abs)).strings) literals.add(st.value);
	}
	return { files: rels, keys, perFile, collisions, untranslated, dictErrors, jaEra, literals, literalsByFile };
}

export { CTX_SEP };
export const displayOf = key => { const i = key.indexOf(CTX_SEP); return i < 0 ? key : key.slice(0, i); };
export const placeholders = s => (String(s).match(/\$\d/g) ?? []).sort().join("");
