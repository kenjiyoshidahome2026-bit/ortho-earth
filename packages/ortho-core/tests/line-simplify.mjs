// 線の間引き（build.ts simplifyRings・?linesimp・2026-11-17）。node packages/ortho-core/tests/line-simplify.mjs
// 守るもの：①環の両端は残る ②弦から許容以内の頂点だけ落ちる ③落とす点が無ければ元の配列をそのまま返す ④環の境（ends）は詰めた後の添字 ⑤2 点の環は触らない
import { simplifyRings } from "../src/build.ts";

let fail = 0;
const ok = (name, cond) => { if (!cond) fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); };

// 環 1＝ほぼ直線（真ん中が 1 だけ外れる）＋はっきりした角・環 2＝2 点・環 3＝閉じた四角（始点＝終点）
const coords = [0, 0, 10, 1, 20, 0, 20, 30,   100, 100, 110, 100,   0, 0, 50, 0, 50, 50, 0, 50, 0, 0];
const ends = [8, 12, 22];
const a = simplifyRings(coords, ends, 2);
ok("near-collinear vertex dropped, corner kept", Array.from(a.coords.slice(0, 6)).join() === "0,0,20,0,20,30");
ok("ring ends are indices into the packed coords", Array.from(a.ends).join() === "6,10,20");
ok("two-point ring untouched", Array.from(a.coords.slice(6, 10)).join() === "100,100,110,100");
ok("closed ring keeps its corners and both ends", Array.from(a.coords.slice(10)).join() === "0,0,50,0,50,50,0,50,0,0");
const b = simplifyRings(coords, ends, 0.5);
ok("nothing within tolerance = same arrays returned", b.coords === coords && b.ends === ends);
const c = simplifyRings(coords, ends, 1000);
ok("huge tolerance keeps ring end points", Array.from(c.coords).join() === "0,0,20,30,100,100,110,100,0,0,0,0" && Array.from(c.ends).join() === "4,8,12");

if (fail) { console.error(`line-simplify: ${fail} FAIL`); process.exit(1); }
console.log("line-simplify OK");
