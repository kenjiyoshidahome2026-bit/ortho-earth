// 町丁名の二系統(210/800)の畳み込み（src/chome.ts の mergeChome）をネット無しで確かめる。実タイルでの検査は tests/t-chome.mjs（npm run test:net）。
import { mergeChome, chomeCanon, chomeShort } from "../src/chome.ts";
import { CHOME800_MINZOOM } from "../src/themes.ts";

let fail = 0;
const ok = (name, cond, note = "") => { if (!cond) fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${note ? "  " + note : ""}`); };
const L = (code, text, lon, lat) => ({ code, text, anchor: [lon, lat], size: 12, color: [0, 0, 0, 1] });
const z = CHOME800_MINZOOM + 0.5, M = 1 / 111320;   // 1 m ≒ M 度（緯度方向）

ok("chomeCanon（N）→N丁目", chomeCanon("下落合（三）") === "下落合三丁目" && chomeCanon("下落合(三)") === "下落合三丁目" && chomeCanon("本町") === "本町");
ok("chomeShort N丁目→（N）", chomeShort("下落合三丁目") === "下落合（三）" && chomeShort("本町十二丁目") === "本町（十二）" && chomeShort("本町") === "本町");

const a210 = L(210, "下落合（三）", 139.7, 35.7), a800 = L(800, "下落合三丁目", 139.7, 35.7 + 300 * M);
const lone800 = L(800, "西新宿二丁目", 139.69, 35.69), dup800 = L(800, "西新宿二丁目", 139.69, 35.69 + 5 * M), far800 = L(800, "西新宿二丁目", 139.69, 35.69 + 500 * M);
const other = L(140, "東京都", 139.7, 35.68);
const all = [a210, a800, lone800, dup800, far800, other];
const out = mergeChome(all, z);
ok("210 と 1km 以内の同じ町丁の 800 は捨てる", !out.includes(a800) && out.includes(a210));
ok("800 は残らない（210 の（N）表記に化ける）", !out.some(x => x.code === 800));
const conv = out.filter(x => x.text === "西新宿（二）");
ok("30m 以内の同じ注記は 1 つ・数百 m 離れた物は残る", conv.length === 2, String(conv.length));
ok("写しは鍵を付け直す・元は書き換えない", conv.every(x => typeof x.key === "string" && x.key.startsWith("西新宿（二）@")) && lone800.code === 800 && lone800.text === "西新宿二丁目" && lone800.key === undefined);
ok("同じ元には同じ写し（worker へ送り直さない）", mergeChome(all, z).find(x => x.text === "西新宿（二）") === conv[0]);
ok("他の注記はそのまま・順も保つ", out[0] === a210 && out.includes(other));
ok("800 の門より手前のズーム＝800 は捨てるだけ", mergeChome(all, CHOME800_MINZOOM - 0.1).every(x => x.code !== 800) && mergeChome(all, CHOME800_MINZOOM - 0.1).includes(a210));
const no800 = [a210, other];
ok("800 が無い＝同じ配列をそのまま返す", mergeChome(no800, z) === no800);

console.log(fail ? `\n✗ ${fail} 件失敗` : "\n✓ t-chome-merge 全 PASS");
process.exit(fail ? 1 : 0);
