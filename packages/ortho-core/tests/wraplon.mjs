// wrapLon（共有 URL・カメラの経度の正規化）＝[-180,180)。範囲内はそのまま（同値）・180 は -180 に畳む・周回の累積を戻す。
// geopbf/edit/sphere の wrapLon と同じ区間（2.0 で揃えた）。
import { wrapLon, parseViewHash, buildViewHash } from "../src/viewurl.ts";

let fail = 0;
const ok = (name, cond, note = "") => { if (!cond) fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${note ? "  " + note : ""}`); };
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;

ok("範囲内は同値", [0, 139.76, -179.999999, 179.999999, -180, 0.1 + 0.2].every(x => Object.is(wrapLon(x), x)));
ok("180 → -180", wrapLon(180) === -180);
ok("540 → -180・-540 → -180", wrapLon(540) === -180 && wrapLon(-540) === -180);
ok("190 → -170・-190 → 170", near(wrapLon(190), -170) && near(wrapLon(-190), 170));
ok("周回の累積（5539° → 139°）", near(wrapLon(5539), 139));
ok("非有限はそのまま", Number.isNaN(wrapLon(NaN)) && wrapLon(Infinity) === Infinity);
let inRange = true;
for (let i = 0; i < 20000; i++) { const x = (Math.random() - 0.5) * 4000, y = wrapLon(x); if (!(y >= -180 && y < 180) || !near(((y - x) % 360 + 540) % 360 - 180, 0, 1e-9)) { inRange = false; break; } }
ok("乱数 2 万点＝[-180,180) に入り・360° の差だけ動く", inRange);
const v = parseViewHash(buildViewHash({ zoom: 3, center: [wrapLon(180), 0], pitch: 0, bearing: 0 }));
ok("URL の往復（180 → -180 で同じ地点）", v != null && v.lon === -180, v && String(v.lon));

console.log(fail ? `\n✗ ${fail} 件失敗` : "\n✓ wraplon 全 PASS");
process.exit(fail ? 1 : 0);
