// 破線をシェーダで描く検定（互換の計画 S-P1-3・2026-10-22）。node packages/ortho-core/tests/linedash.mjs
// 守るもの：①外来 MapLibre の層（ずらさない・模様 8 個まで）は刻まない＝線分に始点までの線に沿う距離（dist・z24 の px）と模様（dash）を添える
// ②距離は環の始点から・余白で落とした線分の分も進む・細分の小片は按分＝隣の線分の頭と尻がつながる（segLen24 と一致）
// ③地物ごとにずらす層・模様 9 個以上・内蔵の層は従来どおり CPU で刻む（ずらしが層で 1 つの値の層はシェーダ＝lineoffset.mjs）（外来の奇数個は MapLibre と同じ「最後と最初がつながる」）
// ④模様 → 線の区間（dashIntervals）＝MapLibre の LineAtlas と同じ（butt は長さ 0 を捨て接する線をつなぐ・round は点を残す・奇数個）
// ⑤結合で dist を写す・WebGPU の逃げ道（chopDash＝classic は renderer・md は scene worker が常駐の前に）は区間どおりに刻む ⑥シェーダ（GL classic・multi_draw）が距離を読む＝線分レコードは 8 語のまま
import assert from "node:assert/strict";
import { buildTileDrawList, dashPattern } from "../src/build.ts";
import { mergeTiles, dashIntervals, chopDash, segLen24 } from "../src/scene.ts";
import { normalizeMLLayer } from "../src/mlstyle.ts";
import { LINE_VS, LINE_MD_VS, LINE_FS } from "../src/gl/glsl.ts";
import { readFileSync } from "node:fs";
let n = 0;
const t = (name, fn) => { fn(); n++; console.log("  ✔", name); };

const line = (coords, ends = [coords.length]) => ({ type: "LineString", props: {}, geom: { coords, ends } });
const tileOf = (feats, z = 14) => ({ z, x: 14552 >> (14 - z), y: 6451 >> (14 - z), layers: { road: { extent: 4096, features: feats } } });
const opOf = (feats, layer, { ml = true, z = 14 } = {}) => buildTileDrawList(tileOf(feats, z), { layers: [ml ? normalizeMLLayer({ id: "r", type: "line", "source-layer": "road", ...layer }) : { id: "r", type: "line", "source-layer": "road", ...layer }] }, [0, 0]).ops[0];
const L3 = [line([100, 100, 1000, 100, 1000, 900])];   // 直角に折れる 3 点＝線分 2 本（z14＝細分しない長さ）
const D = { paint: { "line-width": 2, "line-dasharray": [2, 1] } };
const near = (a, b, e = 1e-4) => Math.abs(a - b) <= e * Math.max(1, Math.abs(b));

t("外来の破線は刻まない＝線分 2 本・dist（z24 の px）・模様はそのまま・dz", () => {
	const op = opOf(L3, D);
	assert.equal(op.half.length, 2);
	assert.deepEqual(op.dash, [2, 1]); assert.equal(op.dz, 14);
	assert.equal(op.dist[0], 0); assert.equal(op.dist[1], 900 * 2 ** 18 / 4096);   // タイル単位 × 2^(32−z)/extent
	assert.ok(op.jf);   // 端と継ぎ（既定の butt／miter）と両立
});
t("丸い端・丸い継ぎの外来の破線も刻まない（jf は持たない）", () => {
	const op = opOf(L3, { ...D, layout: { "line-cap": "round", "line-join": "round" } });
	assert.equal(op.half.length, 2); assert.equal(op.jf, undefined); assert.ok(op.dist);
});
t("距離：細分の小片は按分・余白だけの線分の分も進む・環ごとに 0 から（segLen24 と一致）", () => {
	// z8 のタイル＝4096 単位が約 156 km＝細分（700 m）で 24 片まで割る。2 本目の環は余白（x＜0）を通ってから戻る
	const op = opOf([line([100, 2000, 3000, 2000, 3000, 2600, -300, 2600, -300, 3000, 2000, 3000], [6, 12])], D, { z: 8 });
	const o = [0, 0], dK = 2 ** 24 / 4096;
	let breaks = 0;
	for (let j = 0; j + 1 < op.half.length; j++) {
		const L = segLen24(o, op.P1[j * 2], op.P1[j * 2 + 1], op.P2[j * 2], op.P2[j * 2 + 1]);
		const joined = op.P2[j * 2] === op.P1[j * 2 + 2] && op.P2[j * 2 + 1] === op.P1[j * 2 + 3];
		if (joined) assert.ok(near(op.dist[j] + L, op.dist[j + 1], 1e-3), `${j}: ${op.dist[j]} + ${L} ≠ ${op.dist[j + 1]}`);
		else breaks++;
	}
	assert.ok(op.half.length > 20); assert.equal(breaks, 1);   // 切れ目は環の境だけ（余白の線分は書かないが、その先は同じ環の続き＝つながっていない所は無い）
	// 1 本目の環＝2900＋600 単位で終わる・2 本目は余白の線分（400）を含んで始まり 400＋2300 で終わる
	const end = j => op.dist[j] + segLen24(o, op.P1[j * 2], op.P1[j * 2 + 1], op.P2[j * 2], op.P2[j * 2 + 1]);
	const k = [...op.P1].findIndex((v, i) => !(i & 1) && i > 0 && !(op.P2[i - 2] === v && op.P2[i - 1] === op.P1[i + 1])) / 2;   // 2 本目の環の頭
	assert.ok(near(end(k - 1), 3500 * dK, 2e-3)); assert.ok(near(op.dist[k], 400 * dK, 2e-3)); assert.ok(near(end(op.half.length - 1), 2700 * dK, 2e-3));
});
t("地物ごとにずらす層・模様 9 個以上・内蔵の層は CPU で刻む（dist を持たない）", () => {
	assert.equal(opOf(L3, { paint: { ...D.paint, "line-offset": ["coalesce", ["get", "o"], 2] } }).dist, undefined);
	assert.equal(opOf(L3, { paint: { ...D.paint, "line-offset": 2, "line-gap-width": 1 } }).dist, undefined);   // 隙間つき＝両脇の 2 本のずらしは線幅から焼く
	assert.ok(opOf(L3, { paint: { ...D.paint, "line-offset": 2 } }).dist);   // 層で 1 つの値＝シェーダ
	assert.equal(opOf(L3, { paint: { "line-width": 2, "line-dasharray": [1, 1, 1, 1, 1, 1, 1, 1, 1, 1] } }).dist, undefined);
	const b = opOf(L3, { paint: { "line-width": 2, "line-dasharray": [2, 1] } }, { ml: false });
	assert.equal(b.dist, undefined); assert.ok(b.half.length > 2);
});
t("外来の奇数個を CPU で刻む＝最後と最初がつながる（[2,1,3]＝線 5・間 1・刻み始めは線の残り 2）", () => {
	// 地物ごとにずらす層＝CPU。線幅 2・z14＝模様の 1 単位 2×16＝32 タイル単位。線 0..900 の最初の片は 2 単位＝64
	const op = opOf([line([0, 100, 900, 100])], { paint: { "line-width": 2, "line-dasharray": [2, 1, 3], "line-offset": ["coalesce", ["get", "o"], 0.001] } });
	const xs = []; for (let i = 0; i < op.half.length; i++) xs.push([op.P1[i * 2], op.P2[i * 2]]);
	const w = xs.map(([a, b]) => (b - a) / (xs[1][1] - xs[1][0]) * 5);   // 2 本目（線 5）を 5 とした長さ（経緯度は原点 0 の Float32＝数 % の誤差）
	assert.ok(Math.abs(w[0] - 2) < 0.1, String(w[0])); assert.ok(Math.abs(w[2] - 5) < 0.1, String(w[2]));
	assert.equal(dashPattern([2, 1, 3], true).length, 3); assert.equal(dashPattern([2], true), null); assert.deepEqual(dashPattern([2]), [2, 2]);
});
t("dashIntervals：MapLibre の LineAtlas と同じ区間", () => {
	assert.deepEqual(dashIntervals([2, 1], false), { P: 3, iv: [0, 2] });
	assert.deepEqual(dashIntervals([2, 1, 3], false), { P: 6, iv: [3, 8] });          // 奇数＝最後の線と最初の線がつながる
	assert.deepEqual(dashIntervals([0, 2], true), { P: 2, iv: [0, 0] });              // 丸い点
	assert.deepEqual(dashIntervals([0, 2], false), { P: 2, iv: [] });                 // butt の長さ 0＝描かない
	assert.deepEqual(dashIntervals([2, 0, 1, 1], false), { P: 4, iv: [0, 3] });       // 間 0＝接する線をつなぐ
	assert.deepEqual(dashIntervals([2, 1, 1, 0], false), { P: 4, iv: [3, 6] });       // 周期の境で接する
	assert.deepEqual(dashIntervals([1, 0], false), { P: 1, iv: [-1, 2] });            // 全部が線＝実線
	assert.deepEqual(dashIntervals([3, 1, 0, 1, 2, 1], true), { P: 8, iv: [0, 3, 4, 4, 5, 7] });
});
t("結合：dist・模様・dz を写す（持たないタイルの分は 0）", () => {
	const a = opOf(L3, D), b = opOf(L3, { paint: { "line-width": 2 } });
	b.li = a.li;
	const s = mergeTiles([{ key: "a", origin: [0, 0] }, { key: "b", origin: [1, 2] }], k => ({ ops: [k === "a" ? a : b] }), { origin: [0, 0] });
	const m = s.layers[0];
	assert.deepEqual(m.dash, [2, 1]); assert.equal(m.dz, 14);
	assert.deepEqual([...m.dist], [0, a.dist[1], 0, 0]);
});
t("chopDash（WebGPU の逃げ道）：区間どおりに刻む・丸い点は 1 度ずつ", () => {
	// 線幅 2（半幅 1）・z14＝尺 2^(14−24)・模様 [2,1]＝線 4px・間 2px（z14 の px）。線分 0..900 タイル単位＝900/16＝56.25 px
	const op = opOf([line([0, 100, 900, 100])], D);
	const c = chopDash(op, [0, 0]);
	assert.equal(c.half.length, 10);   // 0–4, 6–10, …, 54–56.25（6px 周期で 10 片）
	assert.equal(c.dist, undefined);
	const r = chopDash(opOf([line([0, 100, 900, 100])], { paint: { "line-width": 2, "line-dasharray": [0, 2] }, layout: { "line-cap": "round" } }), [0, 0]);
	assert.equal(r.half.length, 15);   // 点は 4px ごと＝0, 4, …, 56（56.25 未満）
});
t("シェーダ：classic は a_dist・multi_draw は破線の列だけ語 6 を距離と読む（ずらしの px は u_pzO・語 7 は角の継ぎ）・FS は区間で切る", () => {
	assert.match(LINE_VS, /in float a_dist;/);
	assert.match(LINE_MD_VS, /if \(u_dashP\.y > 0\.5\) \{ dist0 = uintBitsToFloat\(B\.z\); off0\.x = 0\.0; \}/);
	for (const s of [LINE_VS, LINE_MD_VS, LINE_FS]) { assert.match(s, /uniform vec4 u_dashP;/); assert.match(s, /uniform vec4 u_dashI\[2\];/); }
	assert.match(LINE_FS, /flat in vec2 v_dd;/);
});
t("md の能力表明：GL2 と WebGPU は語 6 の距離を読む（mdDash）・読まない描き手（WebGPU の ?nolx=1）＝scene worker が常駐の前に刻む", () => {
	const src = f => readFileSync(new URL(f, import.meta.url), "utf8");
	assert.match(src("../src/gl/renderer.ts"), /md: !!md, mdMax: MD_MAX_DRAWS, mdDash: true,/);
	assert.match(src("../src/gpu/renderer.ts"), /mdDash: !NO_LX,/);   // 2026-10-22＝WebGPU もシェーダの破線（?nolx=1 の時だけ名乗らない＝旧の刻む道）
	const sw = src("../src/workers/sceneworker.ts");
	assert.match(sw, /mdDash = !!d\.mdDash;/);
	assert.match(sw, /if \(!mdDash && g\.ops\.some\(op => op\.kind === "line" && op\.dist\)\) g\.ops = g\.ops\.map\(op => op\.kind === "line" \? chopDash\(op, origin\) : op\);/);
	assert.match(src("../../globe/src/renderworker.ts"), /mdDash: !!renderer!\.mdDash/);
	const c = chopDash(opOf(L3, D), [139.7, 35.7]);   // 刻んだ片は dist も dash も持たない＝プールの語 6 は 0（ずらし 0）・描く列に dash は付かない
	assert.ok(c.half.length > 2 && !c.dist && !c.dash);
});
t("線幅 0（MapLibre は描かない）：外来の層は半幅 0（シェーダが透明に）・CPU で刻む破線は線分を作らない（片の長さ 0＝刻めない）・内蔵の層は従来どおり 1", () => {
	assert.deepEqual([...opOf(L3, { paint: { "line-width": 0 } }).half], [0, 0]);
	assert.deepEqual([...opOf(L3, { paint: { "line-width": -2, "line-dasharray": [2, 1] } }).half], [0, 0]);   // シェーダの破線＝線分は残す
	assert.equal(opOf(L3, { paint: { "line-width": 0, "line-dasharray": [1, 1, 1, 1, 1, 1, 1, 1, 1, 1] } }), undefined);   // CPU で刻む破線
	assert.deepEqual([...opOf(L3, { paint: { "line-width": 0 } }, { ml: false }).half], [0.5, 0.5]);
	assert.ok(/min\(v_half \* 2\.0, 1\.0\)/.test(LINE_FS));   // 半幅 0＝不透明度 0
});
console.log(`linedash: ${n} PASS`);
