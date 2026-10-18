// 3D Tiles の Gaussian splat（glTF の KHR_gaussian_splatting・2026-10-18）の node 検定（網なし・fixtures/tiles3d-splat＝make.mjs）。
// worker の解き（decodeTile3D → decodeModel）が splat のプリミティブを「局所の座標＋transform（列優先 4×4・ECEF）」のまま返すか：
//   仕様の属性名・草案の名（_SCALE＝log・正規化した short の回転）・SH（DC → 色・1 次の係数の並び）・COLOR_0（線形 → sRGB）・SPZ 圧縮（bufferView の本体をそのまま）・
//   transform＝タイル変換 × Y-up→Z-up・heightOffset の持ち上げ・plugin が無い時（splats:false）＝点として返す（splatPoints）。
import { readFileSync } from "node:fs";
import { decodeTile3D } from "../src/tiles3d-decode.ts";

let fail = 0;
const ok = (name, cond, note = "") => { if (!cond) fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${note ? "  " + note : ""}`); };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const dir = new URL("./fixtures/tiles3d-splat/", import.meta.url);
const ts = JSON.parse(readFileSync(new URL("tileset.json", dir), "utf8"));
const T = ts.root.transform;
const load = f => { const b = readFileSync(new URL(f, dir)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const decode = (f, o = {}) => decodeTile3D(load(f), { transform: T, textures: false, baseUri: dir.href, splats: true, ...o });
const m4pt = (m, v) => [m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12], m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13], m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14]];
// 期待＝ECEF ＝ O ＋ E·x ＋ N·(−z) ＋ U·y（glTF の x＝東・y＝上・z＝南）
const enu = (x, y, z) => [0, 1, 2].map(k => T[12 + k] + T[k] * x + T[4 + k] * -z + T[8 + k] * y);

const c0 = await decode("child0.glb");
ok("child0.shape", c0 && c0.splats.length === 1 && c0.splats[0].n === 1600 && c0.points.length === 0 && c0.batches.length === 0 && c0.stats.splats === 1600 && c0.stats.points === 0, JSON.stringify(c0?.stats));
const s0 = c0.splats[0];
ok("child0.local", near(s0.positions[0], -98.75, 1e-4) && near(s0.positions[1], 6, 1e-4) && near(s0.positions[2], 1.25, 1e-4), `${[...s0.positions.slice(0, 3)]}`);
const e = enu(-98.75, 6, 1.25), g = m4pt(s0.transform, [-98.75, 6, 1.25]);
ok("child0.transform", s0.transform.length === 16 && g.every((v, k) => near(v, e[k], 1e-3)), `${g} vs ${e}`);
ok("child0.scale", near(s0.scales[0], 1.2, 1e-5) && near(s0.scales[1], 0.72, 1e-5) && near(s0.scales[2], 1.2, 1e-5), `${[...s0.scales.slice(0, 3)]}`);
ok("child0.rot", s0.rotations[3] === 1 && s0.rotations[0] === 0, `${[...s0.rotations.slice(0, 4)]}`);
ok("child0.color", s0.colors[0] === 255 && Math.abs(s0.colors[1] - 26) <= 1 && Math.abs(s0.colors[2] - 26) <= 1 && s0.colors[3] === 255, `${[...s0.colors.slice(0, 4)]}`);   // DC → 0.282×dc＋0.5＝(1, 0.1, 0.1)
ok("child0.noSh", s0.sh === null && s0.shDegree === 0 && s0.spz === null && s0.colorSpace === "srgb_rec709_display");

const c1 = await decode("child1.glb");
const s1 = c1.splats[0];
ok("child1.sh", s1.shDegree === 1 && s1.sh && s1.sh.length === 1600 * 9 && near(s1.sh[0], -1.5) && near(s1.sh[2], 2.5) && s1.sh[3] === 0 && near(s1.sh[9], -1.5), s1.sh ? `${[...s1.sh.slice(0, 10)]}` : "null");   // 係数が先（k*3+c）＝COEF_0 の RGB → COEF_1 の RGB …
ok("child1.color", Math.abs(s1.colors[0] - 26) <= 1 && Math.abs(s1.colors[1] - 230) <= 1, `${[...s1.colors.slice(0, 4)]}`);

const c2 = await decode("child2.glb");   // 草案＝_SCALE（log）・_ROTATION（short 正規化）・_OPACITY・COLOR_0（線形）
const s2 = c2.splats[0];
ok("child2.draftScale", near(s2.scales[0], 1.2, 1e-5) && near(s2.scales[1], 0.72, 1e-5), `${[...s2.scales.slice(0, 3)]}`);
ok("child2.draftRot", near(s2.rotations[3], 1, 1e-4) && near(s2.rotations[0], 0, 1e-4), `${[...s2.rotations.slice(0, 4)]}`);
ok("child2.color0", Math.abs(s2.colors[0] - 26) <= 2 && Math.abs(s2.colors[1] - 51) <= 2 && s2.colors[2] === 255 && s2.colors[3] === 255, `${[...s2.colors.slice(0, 4)]}`);   // 線形（c^2.2）→ sRGB で元の色に戻る
ok("child2.pos", near(s2.positions[0], -98.75, 1e-4) && near(s2.positions[2], -98.75, 1e-4), `${[...s2.positions.slice(0, 3)]}`);

const c3 = await decode("child3.glb");   // SPZ 圧縮＝本体をそのまま（gzip）・n＝0・transform は同じタイル変換
const s3 = c3.splats[0];
ok("child3.spz", c3.splats.length === 1 && s3.n === 0 && s3.spz instanceof Uint8Array && s3.spz[0] === 0x1f && s3.spz[1] === 0x8b && s3.positions.length === 0, `${s3?.spz?.length}`);
ok("child3.transform", s3.transform.every((v, k) => near(v, s0.transform[k], 1e-6)));
ok("child3.stats", c3.stats.splats === 0 && c3.stats.points === 0 && c3.points.length === 0);

const p = await decode("parent.glb");
ok("parent", p.splats.length === 1 && p.splats[0].n === 200 && near(p.splats[0].scales[0], 6, 1e-5));

// heightOffset（baseH＝−heightOffset）＝transform の平行移動が重心の上向きに 10m 動く
const up = await decode("child0.glb", { baseH: -10 });
const dt = [0, 1, 2].map(k => up.splats[0].transform[12 + k] - s0.transform[12 + k]);
ok("heightOffset", near(Math.hypot(...dt), 10, 1e-3) && dt.every((v, k) => near(v / 10, T[8 + k], 5e-3)), `${dt}`);   // 向き＝ENU の上（根の transform の 3 列目）に近い（地心の上向き＝測地の法線と 0.2° 違う）

// plugin が無い（splats:false）＝仕様の fallback＝点として（COLOR_0 の色）・splatPoints に数える
const fb = await decode("child0.glb", { splats: false });
ok("fallback.points", fb.splats.length === 0 && fb.points.length === 1 && fb.points[0].n === 1600 && fb.stats.points === 1600 && fb.stats.splatPoints === 1600 && fb.stats.splats === 0, JSON.stringify(fb.stats));
const fb3 = await decode("child3.glb", { splats: false });   // SPZ＝属性の本体が無い＝点にもならない（null）
ok("fallback.spz", fb3 === null || (fb3.points.length === 0 && fb3.splats.length === 0), JSON.stringify(fb3?.stats ?? null));

console.log(fail ? `tiles3d-splat: ${fail} FAIL` : "tiles3d-splat: all ok"); process.exit(fail ? 1 : 0);
