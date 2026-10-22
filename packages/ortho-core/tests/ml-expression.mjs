// MapLibre の式の適合試験を評価器（expr.ts・ML の出自）に流す爪車（互換の計画 P0・2026-10-22）。
// 分母は外から来た物＝maplibre-style-spec の test/integration/expression/tests（tests/fixtures/ml-expression/tests.json・取り直しは scripts/ml-expression-fixtures.mjs）。
// 入口は style の層と同じ（convertValue＝旧式の関数の読み替え → evalExpr の ML の出自）。答えの比べ方は本物の検定と同じ（有効数字 6 桁・色は premultiplied の [r,g,b,a]）。
// 既知の失敗＝tests/ml-expression-known.json（名前 → 分類）。一覧に無い失敗＝落ちる（退行）／一覧にあるのに通った＝落ちる（直ったので外す）。
// --update で一覧を今の結果に書き換える・--list で失敗の中身を出す
import fs from "node:fs";
import { evalExpr, formatSections } from "../src/expr.ts";
import { convertValue } from "../src/mlstyle.ts";
import { parseRGBA, isColor } from "../src/color.ts";

const { source, tests } = JSON.parse(fs.readFileSync(new URL("./fixtures/ml-expression/tests.json", import.meta.url), "utf8"));
const KNOWN_URL = new URL("./ml-expression-known.json", import.meta.url);
const known = fs.existsSync(KNOWN_URL) ? JSON.parse(fs.readFileSync(KNOWN_URL, "utf8")).known : {};
const UPDATE = process.argv.includes("--update"), LIST = process.argv.includes("--list");

const ERR = Symbol("error");
// 本物の test/lib/json-diff.ts の stripPrecision と deepEqual の写し（有効数字 6 桁で切り捨て・小数点で止める）
const SIG = 6;
function strip(x) {
	if (x === 0) return x;
	const m = Math.pow(10, Math.max(0, SIG - Math.ceil(Math.log10(Math.abs(x)))));
	return Math.floor(Math.floor(x * m) / m * m) / m;
}
function same(a, b) {
	if (typeof a !== typeof b) return false;
	if (typeof a === "number") return strip(a) === strip(b) || (Number.isNaN(a) && Number.isNaN(b));
	if (a === null || typeof a !== "object") return a === b;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
	return ka.length === kb.length && ka.every((k, i) => k === kb[i] && same(a[k], b[k]));
}
// 色は 8 bit の目で比べる（評価器は色を CSS の rgba 文字列＝8 bit で返す・描く色も 8 bit。MapLibre は float のまま補間する）
const near = (x, y) => typeof x === "number" && typeof y === "number" && Math.abs(x - y) <= 1 / 255 + 1e-9;
const sameColor = (a, b) => Array.isArray(a) && Array.isArray(b) ? a.length === 4 && b.length === 4 && a.every((x, i) => near(x, b[i]))
	: !!a?.values && !!b?.values && a.values.length === b.values.length && a.values.every((c, i) => ["r", "g", "b", "a"].every(k => near(c[k], b.values[i][k])));
// 層の性質の名前（旧式の関数の読み替えは「補間できる性質か」を名前で決める＝convertFunction）
const propOf = spec => spec?.tokens ? "text-field" : spec?.expression?.interpolated === false || !/^(number|color|array)$/.test(spec?.type || "number") ? "fixture-mode" : "fixture-value";
// 色＝MapLibre の Color（premultiplied）の [r,g,b,a]
function colorOut(v) {
	if (typeof v !== "string" && !Array.isArray(v)) return ERR;
	if (typeof v === "string" && !isColor(v)) return ERR;
	const [r, g, b, a] = parseRGBA(v);
	return [r * a, g * a, b * a, a];
}
function formattedOut(e, ctx) {
	const secs = formatSections(e, ctx);
	if (!secs) { const v = evalExpr(e, ctx); return v === undefined ? ERR : { sections: [{ text: String(v ?? ""), image: null, scale: null, fontStack: null, textColor: null, verticalAlign: null }] }; }
	return { sections: secs.map(s => {
		let textColor = null;
		if (s.col != null) { const c = colorOut(s.col); textColor = c === ERR ? null : { r: c[0], g: c[1], b: c[2], a: c[3] }; }
		return { text: s.t, image: s.img ? { name: s.img, available: (ctx.images || []).includes(s.img) } : null, scale: s.fs, fontStack: s.fnt ? s.fnt.join(",") : null, textColor, verticalAlign: s.va };
	}) };
}
function evaluate(t) {
	const type = t.expected.compiled.type, e = convertValue(t.expression, propOf(t.propertySpec));
	return (t.inputs || []).map(([g, f]) => {
		const ctx = { origin: "ml", zoom: g.zoom, props: f.properties ?? {}, id: f.id ?? null, state: f.featureState ?? {}, geom: f.geometry?.type ?? null, geojson: f.geometry ?? null, gs: t.globalState ?? {}, images: g.availableImages,
			vars: { "heatmap-density": g.heatmapDensity, "line-progress": g.lineProgress, elevation: g.elevation, accumulated: g.accumulated } };
		try {
			if (type === "formatted") return formattedOut(e, ctx);
			const v = evalExpr(e, ctx);
			if (v === undefined) return ERR;
			if (type === "color") return colorOut(v);
			// 型つきの値の写し方（本物の toJSON と同じ形）＝数の配列・色の配列は { values }・記号は { name, available }
			if (type === "numberArray" && (typeof v === "number" || Array.isArray(v))) return { values: [v].flat() };
			if (type === "colorArray" && (typeof v === "string" || Array.isArray(v))) { const cs = [v].flat().map(colorOut); return cs.includes(ERR) ? ERR : { values: cs.map(([r, g, b, a]) => ({ r, g, b, a })) }; }
			if (type === "resolvedImage" && typeof v === "string") return { name: v, available: (g.availableImages || []).includes(v) };
			return v;
		} catch { return ERR; }
	});
}
// 分類：pass／no-typecheck（本物は層を拒む式＝評価器は静的な型検査をしない）／wrong-value／missed-error（本物は評価エラー）／false-error（本物は値）
function judge(t) {
	if (t.expected.compiled.result === "error") return "no-typecheck";
	const got = evaluate(t), want = t.expected.outputs || [];
	let cls = "pass";
	want.forEach((w, i) => {
		const isErr = w && typeof w === "object" && !Array.isArray(w) && "error" in w && Object.keys(w).length === 1;
		const g = got[i];
		if (isErr) { if (g !== ERR && cls === "pass") cls = "missed-error"; }
		else if (g === ERR) cls = cls === "pass" || cls === "missed-error" ? "false-error" : cls;
		else if (!(same(g, w) || (/^color/.test(t.expected.compiled.type) && sameColor(g, w)))) cls = "wrong-value";
	});
	return cls;
}

const results = {}, detail = {};
for (const [name, t] of Object.entries(tests)) {
	try { results[name] = judge(t); } catch (err) { results[name] = "crash"; detail[name] = String(err?.message || err); }
}
const count = {};
for (const c of Object.values(results)) count[c] = (count[c] || 0) + 1;
const total = Object.keys(results).length;
console.log(`MapLibre expression tests (${source.repo} ${source.version} ${source.commit.slice(0, 8)}): ${count.pass || 0}/${total} pass  ` + Object.entries(count).filter(([k]) => k !== "pass").map(([k, v]) => `${k} ${v}`).join("  "));

if (UPDATE) {
	const out = Object.fromEntries(Object.entries(results).filter(([, c]) => c !== "pass").sort());
	fs.writeFileSync(KNOWN_URL, JSON.stringify({ _: "MapLibre の式の適合試験の既知の失敗（名前 → 分類）。tests/ml-expression.mjs の爪車＝ここに無い失敗と、ここにあるのに通った物は落ちる。直したら node tests/ml-expression.mjs --update", source, known: out }, null, "\t") + "\n");
	console.log(`known list updated: ${Object.keys(out).length} entries`);
	process.exit(0);
}
let fails = 0;
for (const [name, c] of Object.entries(results)) {
	const k = known[name];
	if (c === "pass" && k) { console.log(`FIXED  ${name}（一覧は ${k}）＝--update で外す`); fails++; }
	else if (c !== "pass" && k !== c) { console.log(`FAIL   ${name}: ${c}${k ? `（一覧は ${k}）` : ""}${detail[name] ? "  " + detail[name] : ""}`); fails++; }
	if (LIST && c !== "pass") { const t = tests[name]; console.log(`--- ${name} [${c}]\n  expr ${JSON.stringify(t.expression)}\n  want ${JSON.stringify(t.expected.outputs ?? t.expected.compiled.errors)}\n  got  ${t.expected.compiled.result === "error" ? "(accepted)" : JSON.stringify(evaluate(t).map(v => v === ERR ? { error: true } : v))}`); }
}
for (const name of Object.keys(known)) if (!(name in results)) { console.log(`STALE  ${name}（取り置きに無い）`); fails++; }
if (fails) { console.log(`\n${fails} unexpected result(s)`); process.exit(1); }
console.log("ml-expression: OK");
