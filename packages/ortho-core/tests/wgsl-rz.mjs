// 逆向きの浮動小数深度（wgsl.ts rzWgsl／rzReadWgsl・?depth=rz・2026-11-11）の置換の見張り。node packages/ortho-core/tests/wgsl-rz.mjs
// 守るもの：①深度を書くシェーダ全部で対数深度の式が残らない（残ると rzWgsl が投げる）②clip z は定数（near×K）＝頂点で書くだけで正確（frag_depth を足さない）
// ③球の床・地形の蓋・gint の線・面の貼り付けの「画素で書く深度」は near／w ④読む側は textureLoad を包むだけ＝後ろの式は原本のまま ⑤原本（対数深度）は不変
import * as W from "../src/gpu/wgsl.ts";
import { GINT_LINE_WGSL } from "../src/gpu/gintwgsl.ts";

let fail = 0;
const ok = (name, cond) => { if (!cond) fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); };
const { rzWgsl, rzReadWgsl, RZ_NEAR } = W;
const N = RZ_NEAR.toExponential();
const all = Object.entries(W).filter(([k, v]) => k.endsWith("_WGSL") && typeof v === "string");
let threw = "";
for (const [k, v] of all) { try { rzWgsl(v, k); } catch (e) { threw += ` ${k}:${e.message}`; } }
ok(`rzWgsl：${all.length} 本のシェーダに対数深度の式が残らない${threw}`, !threw && all.length > 40);
const mesh = rzWgsl(W.MESH_WGSL, "mesh");
ok("logDepthZ＝clip z は定数（near×K）", mesh.includes(`return select(${N}, ${N} / F.nearP.w, F.nearP.w > 0.0) * 1.0;`) || mesh.includes(`return select(${N}, ${N} / F.nearP.w, F.nearP.w > 0.0);`));
ok("fragDepthOf＝near／w（本当の w）", mesh.includes(`fn fragDepthOf(w: f32) -> f32 { return clamp(${N} / max(wTrue(w), 1e-30), 0.0, 1.0); }`));
ok("本パスに frag_depth を足さない（頂点だけ＝early-Z）", !mesh.includes("@builtin(frag_depth)") && !rzWgsl(W.MESH_TEX_FAST_WGSL).includes("@builtin(frag_depth)") && !rzWgsl(W.TERRAIN_WGSL).includes("@builtin(frag_depth)"));
ok("原本は対数深度のまま", W.MESH_WGSL.includes("1.4426950 * F.params.z * 0.5 * w") && !W.MESH_WGSL.includes(N));
const globe = rzWgsl(W.GLOBE_WGSL, "globe");
ok("球の床の深度＝消した値 0・交点は near／t", globe.includes("o.d = 0.0;\n\tlet h = sphereRay(") && globe.includes(`o.d = clamp(${N} / max(h.t, 1e-30), 0.0, 1.0);`) && !globe.includes("log2(1.0 + h.t)"));
ok("線（画面座標で置く）＝near／w", rzWgsl(W.LINE_WGSL, "line").includes(`o.pos = vec4f(ndc, clamp(${N} / max(wTrue(wz), 1e-30), 0.0, 1.0), 1.0);`));
ok("地形の蓋＝画素で near／w", rzWgsl(W.CLIP_CAP_WGSL, "cap").includes("out.d = fragDepthOf(pc.w);"));
const gl = rzWgsl(GINT_LINE_WGSL, "gint");
ok("gint の線＝near／w・深度オフは最前面（1）", gl.includes(`let zc = select(1.0, clamp(${N} / max(wS, 1e-30), 0.0, 1.0), F.depthP.x > 0.0);`));
const cls = rzWgsl("\tp.z = log1pS(max(p.w, 1e-30)) * 1.4426950 * u.p.x * 0.5 * p.w;\n\tf.d = clamp(log1pS(max(i.w, 1e-30)) * 1.4426950 * u.p.x * 0.5, 0.0, 1.0);", "classify");
ok("面の貼り付け＝clip z 定数・画素は near／w", cls === `\tp.z = ${N};\n\tf.d = clamp(clamp(${N} / max(i.w, 1e-30), 0.0, 1.0), 0.0, 1.0);`);
let t = false; try { rzWgsl("let z = log(1.0 + w) * 1.4426950 * k;", "x"); } catch { t = true; }
ok("知らない形の対数深度は投げる", t);
// 読む側
const rd = rzReadWgsl("@group(0) @binding(1) var dep: texture_depth_2d;\nfn a(q: vec2i) -> f32 { let z = textureLoad(dep, clamp(q, vec2i(0), dim(q)), 0); if (z >= 1.0) { return -1.0; } return expm1s(z * A.rY.w); }", "dep", "A.rY.w");
ok("rzReadWgsl：textureLoad を包む（括弧の入れ子）", rd.includes("let z = rzLog_dep(textureLoad(dep, clamp(q, vec2i(0), dim(q)), 0));") && rd.includes("if (z >= 1.0) { return -1.0; } return expm1s(z * A.rY.w);"));
ok("rzReadWgsl：0（消した値）→ 1・near／d → ln(1+w)／k", rd.includes("if (d <= 0.0) { return 1.0; }") && rd.includes(`let w = ${N} / d;`) && rd.includes("return min(l / (A.rY.w), 0.99999994);"));
ok("rzReadWgsl：tex を結ばないシェーダは素通し", rzReadWgsl("fn f() {}", "dep", "k") === "fn f() {}");
// 値の往復：w → near／w → rzLog（f64 で同じ式）→ expm1 → w
const k = 2 * Math.LN2 / 0.05;
for (const w of [1e-7, 3e-5, 0.02, 1, 30]) { const d = Math.fround(RZ_NEAR / w), l = Math.log1p(RZ_NEAR / d) / k, back = Math.expm1(l * k); ok(`往復 w=${w}（相対誤差 ${Math.abs(back / w - 1).toExponential(1)}）`, Math.abs(back / w - 1) < 2e-7); }
if (fail) { console.error(`wgsl-rz: ${fail} FAIL`); process.exit(1); }
console.log("wgsl-rz OK");
