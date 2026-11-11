// 模型の素の束の速い道（wgsl.ts MESH_TEX_FAST_WGSL・2026-11-11）の形の見張り。node packages/ortho-core/tests/wgsl-meshfast.mjs
// 守るもの：①PB の並びが MESH_WGSL と同じ（renderer は同じ per-batch UBO を両方に結ぶ）＋末尾の fc が float 268 ②FS に discard・テクスチャ標本が無い（速い道の意味）
// ③深度を画素で書く変換（fragDepthWgsl・#62）と軽い標高の特化（elevCheapWgsl）が掛かる書式 ④固定光・法線の向きの式が MESH_WGSL と同文（絵が同じ）
import { MESH_WGSL, MESH_TEX_WGSL, MESH_TEX_FAST_WGSL, fragDepthWgsl, elevCheapWgsl, elevCheapWgslN } from "../src/gpu/wgsl.ts";

let fail = 0;
const ok = (name, cond) => { if (!cond) fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); };
const pbOf = src => /struct PB \{([^}]*)\}/.exec(src)[1].trim();
const SZ = { vec4f: 4, "array<vec4f, 9>": 36, "array<vec4f, 32>": 128, mat3x3f: 12 };
const fields = body => body.split(/,\s*(?![^<]*>)/).map(f => f.split(":").map(x => x.trim()));

const base = pbOf(MESH_WGSL), fast = pbOf(MESH_TEX_FAST_WGSL);
ok("PB＝MESH_WGSL の PB＋fc", fast === base + ", fc: vec4f");
let off = 0; for (const [, t] of fields(base)) { if (!SZ[t]) { ok(`PB の型 ${t}`, false); break; } off += SZ[t]; }
ok(`fc は float 268（renderer の plBatchCPU[o + 268]）: ${off}`, off === 268);
const fs = MESH_TEX_FAST_WGSL.slice(MESH_TEX_FAST_WGSL.indexOf("@fragment fn fs("));
ok("FS に discard が無い", !/\bdiscard\b/.test(fs));
ok("テクスチャを標本化しない・group(3) を宣言しない", !/textureSample\(/.test(fs) && !/@group\(3\)/.test(MESH_TEX_FAST_WGSL));
ok("頂点は pos・法線・頂点色（uv 無し）", /fn vs\(@location\(0\) a_pos: vec3f, @location\(1\) a_normal: vec4f, @location\(3\) a_col: vec4f\)/.test(MESH_TEX_FAST_WGSL));
let fd = ""; try { fd = fragDepthWgsl(MESH_TEX_FAST_WGSL, "meshTexFast"); } catch (e) { fd = ""; console.log(String(e)); }
ok("fragDepthWgsl が掛かる（frag_depth・cw）", /@builtin\(frag_depth\)/.test(fd) && /o\.cw = p\.w/.test(fd));
ok("elevCheapWgsl が持ち上げの枝を拾う", elevCheapWgslN(MESH_TEX_FAST_WGSL) === 1 && !elevCheapWgsl(MESH_TEX_FAST_WGSL).includes("F.ellP.z > 0.5"));
for (const line of [
	"let gnRaw = cross(dpdx(in.toEye), dpdy(in.toEye));",
	"select(dot(n, normalize(in.toEye)), dot(normalize(gnRaw * sign(dot(gnRaw, n))), normalize(in.toEye)), g2 > 1e-18)",
	"let L = normalize(north * 0.44 + up * 0.90);",
	"clamp(dot(n, L) * 0.28 + 0.76, 0.72, 1.0)",
	"let inX = smoothstep(0.0, 0.05, min(lon - lb.x, lb.x + lb.z - lon));",
]) ok(`MESH_WGSL と同文：${line.slice(0, 48)}…`, MESH_WGSL.includes(line) && MESH_TEX_FAST_WGSL.includes(line));
ok("色の式は MESH_TEX_WGSL の枝と同じ（リニア → 表示空間）", MESH_TEX_WGSL.includes("select(in.col.rgb, srgbDecode(in.col.rgb), B.cs.x > 0.5)") && MESH_TEX_FAST_WGSL.includes("srgbEncode(select(in.col.rgb, srgbDecode(in.col.rgb), B.cs.x > 0.5))"));

if (fail) { console.error(`${fail} FAIL`); process.exit(1); }
console.log("wgsl-meshfast OK");
