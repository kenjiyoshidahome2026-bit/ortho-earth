// style の sky（src/sky-spec.js・B4 2026-10-12）＝既定の補完・不正値・式の評価（zoom）・renderer へ渡す形
import { normSky, skyHasExpr, skyPayload, SKY_DEFAULT } from "../src/sky-spec.ts";
let fail = 0; const ok = (name, c, note = "") => { console.log(`${c ? "✓" : "✗"} ${name}${note ? `（${note}）` : ""}`); if (!c) fail++; };
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e, vnear = (a, b, e = 1e-9) => a.length === b.length && a.every((v, i) => near(v, b[i], e));
const J = JSON.stringify;

ok("default", J(normSky()) === J(SKY_DEFAULT), J(normSky()));
ok("default-frozen", Object.isFrozen(SKY_DEFAULT) && normSky() !== SKY_DEFAULT);
ok("partial", J(normSky({ "sky-color": "#000", "fog-ground-blend": 2, "sky-horizon-blend": -1, "atmosphere-blend": "x", "horizon-color": 12 })) === J({ ...SKY_DEFAULT, "sky-color": "#000", "fog-ground-blend": 1, "sky-horizon-blend": 0 }));
ok("unknown-keys-dropped", !("foo" in normSky({ foo: 1 })));
ok("no-expr", !skyHasExpr(normSky()) && !skyHasExpr(null));
const ex = { "sky-color": ["interpolate", ["linear"], ["zoom"], 5, "#000000", 7, "#ffffff"], "fog-ground-blend": ["interpolate", ["linear"], ["zoom"], 10, 0, 12, 1] };
ok("expr-kept", skyHasExpr(normSky(ex)) && Array.isArray(normSky(ex)["sky-color"]));
const p = skyPayload({ "sky-color": "#ff8000", "horizon-color": "rgb(0,255,0)", "fog-color": "#0000ff", "fog-ground-blend": 0.25, "horizon-fog-blend": 1, "sky-horizon-blend": 0, "atmosphere-blend": 0.5 });
ok("payload", vnear(p.sky, [1, 128 / 255, 0]) && vnear(p.horizon, [0, 1, 0]) && vnear(p.fog, [0, 0, 1]) && p.groundBlend === 0.25 && p.horizonFogBlend === 1 && p.skyHorizonBlend === 0 && p.atmosphereBlend === 0.5, J(p));
ok("payload-default", vnear(skyPayload(null).sky, [0x88 / 255, 0xc6 / 255, 0xfc / 255]) && skyPayload(null).groundBlend === 0.5);
ok("expr-zoom", vnear(skyPayload(ex, 6).sky, [0.5, 0.5, 0.5], 2 / 255) && near(skyPayload(ex, 11).groundBlend, 0.5, 1e-9) && near(skyPayload(ex, 20).groundBlend, 1), J(skyPayload(ex, 6)));
ok("bad-color-falls-back", vnear(skyPayload({ "sky-color": "nonsense" }).sky, [0x88 / 255, 0xc6 / 255, 0xfc / 255]));
console.log(fail ? `✗ sky-spec: ${fail} failed` : "✓ sky-spec PASS");
process.exit(fail ? 1 : 0);
