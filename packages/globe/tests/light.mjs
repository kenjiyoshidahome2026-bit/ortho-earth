// style の light（src/light.js・B3 2026-10-12）＝既定の補完・方位の意味（0＝北・90＝東・時計回り）・viewport の錨は bearing で回る・色
import { normLight, lightENU, lightPayload, LIGHT_DEFAULT, normLightSpec, normLights, LIGHT_TYPES, localLightsPayload, LOCAL_LIGHT_MAX } from "../src/light.js";
let fail = 0; const ok = (name, c, note = "") => { console.log(`${c ? "✓" : "✗"} ${name}${note ? `（${note}）` : ""}`); if (!c) fail++; };
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e, vnear = (a, b, e = 1e-9) => a.length === b.length && a.every((v, i) => near(v, b[i], e));

ok("default", JSON.stringify(normLight()) === JSON.stringify({ anchor: "viewport", color: "#ffffff", intensity: 0.5, position: [1.15, 210, 30] }), JSON.stringify(normLight()));
ok("partial", JSON.stringify(normLight({ anchor: "map", intensity: 2, position: [1, 90, "x"] })) === JSON.stringify({ anchor: "map", color: "#ffffff", intensity: 1, position: [1.15, 210, 30] }));
ok("default-frozen", Object.isFrozen(LIGHT_DEFAULT) && normLight().position !== LIGHT_DEFAULT.position);
// 方位＝0 北・90 東・180 南・270 西（anchor map・天頂から 60°）
const s = Math.sin(60 * Math.PI / 180), c = Math.cos(60 * Math.PI / 180);
ok("north", vnear(lightENU({ anchor: "map", position: [1, 0, 60] }), [0, s, c]));
ok("east", vnear(lightENU({ anchor: "map", position: [1, 90, 60] }), [s, 0, c]));
ok("south", vnear(lightENU({ anchor: "map", position: [1, 180, 60] }), [0, -s, c]));
ok("west", vnear(lightENU({ anchor: "map", position: [1, 270, 60] }), [-s, 0, c]));
ok("zenith", vnear(lightENU({ anchor: "map", position: [1, 123, 0] }), [0, 0, 1]));
ok("unit", near(Math.hypot(...lightENU({ position: [9, 210, 30] })), 1));
// viewport の錨＝画面の上が bearing の方位＝方位に bearing を足す。map の錨は bearing を無視
ok("viewport-rotates", vnear(lightENU({ anchor: "viewport", position: [1, 0, 60] }, 90), [s, 0, c]) && vnear(lightENU({ anchor: "map", position: [1, 0, 60] }, 90), [0, s, c]));
ok("default-dir", vnear(lightENU(undefined, 0), [Math.sin(210 * Math.PI / 180) * Math.sin(30 * Math.PI / 180), Math.cos(210 * Math.PI / 180) * Math.sin(30 * Math.PI / 180), Math.cos(30 * Math.PI / 180)]));
const p = lightPayload({ color: "#ff8000", intensity: 0.25, anchor: "map", position: [1, 180, 60] });
ok("payload", vnear(p.dir, [0, -s, c]) && vnear(p.color, [1, 128 / 255, 0], 1e-9) && p.intensity === 0.25, JSON.stringify(p));
// ── 光源の口（F1）＝type ごとの既定・directional は setLight の形そのまま・知らない type は投げる・plugin の type は保つ ──
ok("spec.types", LIGHT_TYPES.join() === "directional,point,spot,ambient,hemisphere,ibl");
ok("spec.dirDefault", JSON.stringify(normLightSpec({})) === JSON.stringify({ type: "directional", anchor: "viewport", color: "#ffffff", intensity: 0.5, position: [1.15, 210, 30] }), JSON.stringify(normLightSpec({})));
ok("spec.point", JSON.stringify(normLightSpec({ id: "p", type: "point", position: [139.7, 35.6], intensity: -1, range: "x" })) === JSON.stringify({ id: "p", type: "point", position: [139.7, 35.6, 0], color: "#ffffff", intensity: 0, range: 0, decay: 2 }));
const sp = normLightSpec({ type: "spot", position: [1, 2, 3], target: [1, 2, 0], angle: 200 });
ok("spec.spotTarget", sp.target && sp.target[2] === 0 && sp.direction === undefined && sp.angle === 90);
ok("spec.spotDir", JSON.stringify(normLightSpec({ type: "spot", position: [1, 2] }).direction) === "[0,0,-1]");
ok("spec.ambient", normLightSpec({ type: "ambient" }).intensity === 0.2 && normLightSpec({ type: "hemisphere" }).skyColor === "#bfd4ff");
ok("spec.ibl", normLightSpec({ type: "ibl", url: "a.hdr", rotation: 45 }).rotation === 45 && normLightSpec({ type: "ibl" }).url === null);
ok("spec.unknownNull", normLightSpec({ type: "laser" }) === null);
let threw = false; try { normLights([{ type: "laser" }]); } catch { threw = true; } ok("list.unknownThrows", threw);
threw = false; try { normLights([{}, { type: "directional" }]); } catch { threw = true; } ok("list.twoDirThrows", threw);
ok("list.pluginKept", JSON.stringify(normLights([{ type: "laser", w: 1 }], t => t === "laser")) === JSON.stringify([{ type: "laser", w: 1 }]));
ok("list.single", normLights({ type: "ambient" }).length === 1 && normLights(null).length === 0);

// ── 局所の光源の renderer への形（W2）＝kind・位置（単位球）・range（m/R）・spot の向き（direction は局所系→世界・target は差）・8 灯で打ち切り・directional/ibl は飛ばす ──
const R = 6371000, L = normLights([{ type: "ambient", color: "#ff0000", intensity: 0.3 }, { type: "point", position: [0, 0, R], range: R, decay: 1 }, { type: "spot", position: [0, 0, 0], direction: [0, 0, -1], angle: 60, penumbra: 0.5 }, { type: "hemisphere" }, { type: "ibl" }, {}]);
const pl = localLightsPayload(L, R), d = pl.data;
ok("local.count", pl.n === 4 && d.length === LOCAL_LIGHT_MAX * 16 && d[4 * 16 + 3] === 0);
ok("local.ambient", d[3] === 3 && near(d[4], 1) && near(d[5], 0) && near(d[7], 0.3, 1e-6));
ok("local.point", d[16 + 3] === 1 && near(d[16], 2, 1e-6) && near(d[16 + 1], 0) && near(d[16 + 2], 0) && near(d[16 + 11], 1, 1e-6) && near(d[16 + 14], 1));   // (0,0) の alt=R＝x=2・range=R＝1
const s0 = 32; ok("local.spot", d[s0 + 3] === 2 && near(d[s0], 1, 1e-6) && near(d[s0 + 8], -1, 1e-6) && near(d[s0 + 9], 0, 1e-6) && near(d[s0 + 10], 0, 1e-6) && near(d[s0 + 12], 0.5, 1e-6) && near(d[s0 + 13], Math.cos(30 * Math.PI / 180), 1e-6), Array.from(d.subarray(s0, s0 + 16)).map(v => +v.toFixed(3)).join());   // 下向き＝−up＝(−1,0,0)
const tg = localLightsPayload(normLights([{ type: "spot", position: [0, 0, 1000], target: [0, 0, 0] }]), R).data; ok("local.spotTarget", near(tg[8], -1, 1e-6) && near(tg[9], 0, 1e-6));
ok("local.hemi", d[48 + 3] === 4 && near(d[48 + 7], 0.5) && near(d[48 + 8], 0x6b / 255, 1e-6));
ok("local.cap", localLightsPayload(Array.from({ length: 10 }, () => ({ type: "ambient", intensity: 1 })), R).n === LOCAL_LIGHT_MAX);
console.log(fail ? `✗ light: ${fail} failed` : "✓ light PASS");
process.exit(fail ? 1 : 0);
