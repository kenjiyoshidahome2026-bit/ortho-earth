// style の light（src/light.js・B3 2026-10-12）＝既定の補完・方位の意味（0＝北・90＝東・時計回り）・viewport の錨は bearing で回る・色
import { normLight, lightENU, lightPayload, LIGHT_DEFAULT } from "../src/light.js";
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
console.log(fail ? `✗ light: ${fail} failed` : "✓ light PASS");
process.exit(fail ? 1 : 0);
