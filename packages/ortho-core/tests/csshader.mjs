// Cesium の CustomShader（csshader.ts）：公式例の GLSL（tests/fixtures/csshaders.json＝Sandcastle の 22 本）を WGSL に訳せるか・GL の前置きが組めるか・
// uniform の並びと詰め方・目の座標の回転・property texture の読み方。node packages/ortho-core/tests/csshader.mjs
// naga があれば（NAGA＝実行ファイル、既定 ~/.cargo/bin/naga）訳した WGSL を検証する（無ければ飛ばす）
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { csLayout, csPackUniforms, csViewMat, csGlslPrelude, csGlslUser, csWgsl, csMetaTexN, CS_CU_HEAD } from "../src/csshader.ts";
import { meshCustomGLSL } from "../src/gl/glsl.ts";
import { meshCustomWGSL } from "../src/gpu/wgsl.ts";

const L = JSON.parse(fs.readFileSync(new URL("./fixtures/csshaders.json", import.meta.url), "utf8"));
const naga = process.env.NAGA || path.join(os.homedir(), ".cargo/bin/naga");
const hasNaga = fs.existsSync(naga);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "csshader-"));
// テンプレートの穴（${propertyName} など）は例の UI が埋める＝ここでは固定の名と値
const fill = s => s?.replace(/\$\{(\w+)\}/g, (_, n) => /propertyName/.test(n) ? "prop_" + n.slice(-1) : "1.0");
const specOf = o => { const fsT = fill(o.fs), md = {}; for (const m of (fsT || "").matchAll(/metadata\.(\w+)/g)) md[m[1]] = o.metadata[m[1]] || "float"; return { vs: o.vs, fs: fsT, uniforms: o.uniforms, metadata: md }; };
const UNSUPPORTED = new Set([18]);   // gl_PointCoord（点群の波）＝WGSL に無い

let ok = 0, validated = 0;
L.forEach((o, k) => {
	const spec = specOf(o);
	const g = meshCustomGLSL(spec);   // GL＝そのまま差し込む（字句の書き戻し）
	if (spec.fs) assert.match(g.fs, /fragmentMain\(csFi, csM\)/, `${k} ${o.ex}: GL FS calls fragmentMain`);
	if (spec.vs) assert.match(g.vs, /vertexMain\(csVi, csVo\)/, `${k} ${o.ex}: GL VS calls vertexMain`);
	for (const n of Object.keys(spec.uniforms)) assert.ok(!new RegExp(`\\b${n}\\b`).test(csGlslUser(spec.fs || spec.vs, spec)), `${k}: uniform ${n} renamed to cu_${n}`);
	if (UNSUPPORTED.has(k)) { assert.throws(() => meshCustomWGSL(spec), /gl_PointCoord|unknown|unsupported/i, `${k}: gl_PointCoord is reported`); return; }
	const w = meshCustomWGSL(spec);
	assert.equal(w.textures.length, Object.values(spec.uniforms).filter(t => t === "sampler2D").length, `${k}: textures`);
	if (spec.fs) assert.match(w.code, /fragmentMain\(\);/, `${k}: WGSL FS calls fragmentMain`);
	ok++;
	if (hasNaga) {
		const f = path.join(tmp, `m${k}.wgsl`);
		fs.writeFileSync(f, w.code);
		try { execFileSync(naga, [f], { stdio: "pipe" }); validated++; }
		catch (e) { assert.fail(`${k} ${o.ex}: naga rejected the WGSL\n${String(e.stderr || e.message).slice(0, 1200)}`); }
	}
});
assert.equal(ok, L.length - UNSUPPORTED.size, "every gallery shader but gl_PointCoord translates");

// uniform の並び：先頭 7 本の vec4（J・V・misc）の後ろに 16 B ずつ（行列は列ごと）・sampler は別
const spec = { fs: "void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) { material.diffuse = u_c * u_k + vec3(u_m[0][0]); }", uniforms: { u_k: "float", u_c: "vec3", u_m: "mat3", u_t: "sampler2D", u_b: "bool" } };
const lay = csLayout(spec);
assert.deepEqual(lay.fields.map(f => [f.name, f.off]), [["u_k", CS_CU_HEAD * 16], ["u_c", CS_CU_HEAD * 16 + 16], ["u_m", CS_CU_HEAD * 16 + 32], ["u_b", CS_CU_HEAD * 16 + 80]]);
assert.deepEqual(lay.textures, ["u_t"]);
const buf = new ArrayBuffer(lay.size);
csPackUniforms(spec, { u_k: 2.5, u_c: [1, 2, 3], u_m: [1, 2, 3, 4, 5, 6, 7, 8, 9], u_b: true }, buf);
const F = new Float32Array(buf), U = new Uint32Array(buf), o = CS_CU_HEAD * 4;
assert.equal(F[o], 2.5);
assert.deepEqual([...F.slice(o + 4, o + 7)], [1, 2, 3]);
assert.deepEqual([...F.slice(o + 8, o + 11)], [1, 2, 3]); assert.deepEqual([...F.slice(o + 12, o + 15)], [4, 5, 6]); assert.deepEqual([...F.slice(o + 16, o + 19)], [7, 8, 9]);   // mat3＝列 16 B
assert.equal(U[o + 20], 1);
const wd = csWgsl(spec, 3, 6).decl;
assert.match(wd, /@align\(16\) u_m: mat3x3f/);
assert.match(wd, /@group\(3\) @binding\(7\) var css_u_t: sampler;/);
assert.match(wd, /@group\(3\) @binding\(8\) var cst_u_t: texture_2d<f32>;/);

// 目の座標（Cesium の EC：x 右・y 上・z 後ろ）＝行は直交・前は −z
const V = csViewMat([0, 0, -2], [0.3, 0, 0], [0, 0.5, 0.1]);
const row = r => [V[r], V[3 + r], V[6 + r]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
for (let r = 0; r < 3; r++) { assert.ok(Math.abs(dot(row(r), row(r)) - 1) < 1e-6); for (let q = r + 1; q < 3; q++) assert.ok(Math.abs(dot(row(r), row(q))) < 1e-6); }
assert.deepEqual(row(2).map(x => Math.round(x * 1e6) / 1e6 + 0), [0, 0, 1]);   // 前（0,0,−1）→ EC の −z
assert.deepEqual(row(0).map(x => Math.round(x * 1e6) / 1e6 + 0), [1, 0, 0]);

// property texture（EXT_structural_metadata）：UINT8 の 1 チャンネル・UINT16 の 2 チャンネル・正規化
const meta = { fs: "void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) { uint a = fsInput.metadata.ce90 + fsInput.metadata.le90; material.diffuse = vec3(float(a) / 255.0 + fsInput.metadata.n); }",
	uniforms: {}, metadata: { ce90: { type: "uint", tex: 0, ch: [0], bytes: 1 }, le90: { type: "uint", tex: 1, ch: [0, 1], bytes: 2 }, n: { type: "float", tex: 1, ch: [2], bytes: 1, norm: true } } };
assert.equal(csMetaTexN(meta), 2);
const gp = csGlslPrelude(meta, "fs");
assert.match(gp, /uniform sampler2D csmt_0;\nuniform sampler2D csmt_1;/);
assert.match(gp, /m\.ce90 = uint\(px\[0\] \* 255\.0 \+ 0\.5\);/);
assert.match(gp, /m\.le90 = \(uint\(px\[0\] \* 255\.0 \+ 0\.5\) \| uint\(px\[1\] \* 255\.0 \+ 0\.5\) << 8u\);/);
assert.match(gp, /m\.n = float\(uint\(px\[2\] \* 255\.0 \+ 0\.5\)\) \/ 255\.0;/);
assert.doesNotMatch(csGlslPrelude(meta, "vs"), /csmt_/, "the vertex stage reads zeros");
const mw = meshCustomWGSL(meta);
assert.match(mw.code, /@group\(3\) @binding\(7\) var css_csmt_0: sampler;/);
assert.match(mw.code, /@group\(3\) @binding\(10\) var cst_csmt_1: texture_2d<f32>;/);
assert.match(mw.code, /csFi\.metadata = csMetaOf\(in\.uvm\);/);
if (hasNaga) { const f = path.join(tmp, "meta.wgsl"); fs.writeFileSync(f, mw.code); execFileSync(naga, [f], { stdio: "pipe" }); validated++; }

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`csshader: ${ok}/${L.length} gallery shaders translated${hasNaga ? `, ${validated} validated by naga` : " (naga not found: WGSL not validated)"}`);
