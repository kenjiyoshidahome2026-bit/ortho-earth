// splat の受け口（F8）＝契約の検め。描く段は plugin
import { normSplat, isSplatUrl, SPLAT_FORMATS } from "../src/splat.ts";
let fail = 0; const ok = (k, c, extra = "") => { console.log((c ? "ok  " : "FAIL ") + k + (extra ? " " + extra : "")); if (!c) fail++; };
const th = f => { try { f(); return false; } catch (e) { return e.message; } };
const mk = (n, over = {}) => ({ n, positions: new Float32Array(n * 3), scales: new Float32Array(n * 3), rotations: new Float32Array(n * 4), colors: new Uint8Array(n * 4), ...over });
ok("formats", SPLAT_FORMATS.join() === "ply,splat,spz");
ok("url", isSplatUrl("a/b.spz") && isSplatUrl("x.PLY?v=1") && isSplatUrl("x.splat#f") && !isSplatUrl("x.glb") && !isSplatUrl(42));
ok("urlPass", normSplat("scene.spz") === "scene.spz");
const s = normSplat(mk(3)); ok("shape", s.n === 3 && s.crs === "lnglat" && s.positions.length === 9 && s.rotations.length === 12 && s.colors.length === 12 && !("sh" in s));
ok("nInferred", normSplat({ ...mk(2), n: undefined }).n === 2);
ok("ecef", normSplat(mk(1, { crs: "ecef" })).crs === "ecef");
ok("badCrs", /crs/.test(th(() => normSplat(mk(1, { crs: "utm" })))));
ok("badLen", /positions length 3 != 6/.test(th(() => normSplat(mk(2, { positions: new Float32Array(3) })))));
ok("badType", /Float32Array/.test(th(() => normSplat(mk(1, { scales: [0, 0, 0] })))));
ok("badColors", /colors/.test(th(() => normSplat(mk(1, { colors: new Float32Array(4) })))));
ok("sh", normSplat(mk(2, { sh: new Float32Array(2 * 9) })).sh.length === 18 && /sh/.test(th(() => normSplat(mk(2, { sh: new Float32Array(5) })))));
ok("empty", normSplat(mk(0)).n === 0);
ok("notObj", /SplatData/.test(th(() => normSplat(null))) && /SplatData/.test(th(() => normSplat("x.glb"))));
console.log(fail ? `splat: ${fail} FAIL` : "splat: all ok"); process.exit(fail ? 1 : 0);
