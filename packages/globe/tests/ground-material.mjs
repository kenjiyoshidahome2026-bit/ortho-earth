// 地面の材質（setGroundMaterial・Cesium の globe.material・2026-10-28）：GroundMaterialSpec → render worker の形（api/camera.ts packGroundMaterial）。
// kind（0 なし／1 標高／2 傾斜／3 方位／4 等高線だけ）・ランプは n×RGBA の写し・等高線の既定の太さ 1 px・spacing 0 は等高線なし。
import { packGroundMaterial } from "../src/api/camera.ts";

let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.log("FAIL", m); } else console.log("ok", m); };
const colors = Uint8Array.from([0, 0, 0, 255, 255, 255, 255, 255, 9]);   // 2 色＋端数 1 byte
const e = packGroundMaterial({ ramp: { kind: "elevation", colors, min: -414, max: 8777 } });
ok(e.kind === 1 && e.min === -414 && e.max === 8777 && e.rampN === 2 && e.ramp.length === 8 && e.ramp[4] === 255 && e.ramp !== colors, "elevation ramp: kind 1, min/max, the ramp copied to whole pixels");
ok(packGroundMaterial({ ramp: { kind: "slope", colors } }).kind === 2 && packGroundMaterial({ ramp: { kind: "aspect", colors } }).kind === 3, "slope 2 / aspect 3");
const c = packGroundMaterial({ contour: { spacing: 150, color: [1, 0, 0, 1] } });
ok(c.kind === 4 && c.ramp === null && c.rampN === 0 && c.spacing === 150 && c.width === 1 && c.contour.join() === "1,0,0,1", "contour only: kind 4, width defaults to 1 px");
const both = packGroundMaterial({ ramp: { kind: "elevation", colors }, contour: { spacing: 500, width: 2, color: [0, 0, 1, 0.5] }, landOnly: true, opacity: 0.8 });
ok(both.kind === 1 && both.contour[3] === 0.5 && both.width === 2 && both.landOnly === 1 && both.opacity === 0.8, "ramp + contour + land only + opacity");
const none = packGroundMaterial({ ramp: { kind: "elevation", colors: new Uint8Array(0) }, contour: { spacing: 0, color: [1, 1, 1, 1] } });
ok(none.kind === 0 && none.contour === null && none.ramp === null, "an empty ramp and spacing 0 paint nothing");
if (fail) { console.log(`ground-material: ${fail} failed`); process.exit(1); }
console.log("ground-material: all ok");
