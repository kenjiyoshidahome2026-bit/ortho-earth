// ラベル層の検定：衝突・フェード（到達後に振動しない）・国名の上下ずらし
import assert from "node:assert/strict";
import { createLabels, countryLabels, cityLabels } from "../src/labels.js";
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const ctx = new Proxy({}, { get: (t, k) => k === "measureText" ? s => ({ width: s.length * 7 }) : (() => {}), set: () => true });
const L = createLabels({ width: 0, height: 0, getContext: () => ctx });
const pal = { country: "#000", city: "#000", halo: "#fff" };
const world = { items: [{ key: "FR", name: { en: "France" }, coord: [2, 47], area: 5.5e5 }, { key: "MC", name: { en: "Monaco" }, coord: [7.4, 43.7], area: 2 }] };
const cities = [{ properties: { NAME: "Paris", NAME_EN: "Paris", ADM0CAP: 1, SCALERANK: 0, MIN_ZOOM: 2.7 }, geometry: { type: "Point", coordinates: [2.35, 48.85] } }];
L.setLabels([...countryLabels(world, n => n.name.en, pal), ...cityLabels(cities, p => p.NAME_EN, pal)]);
const view = { lon: 2, lat: 47, zoom: 4 };
// 1) z4 で France と Paris が両方出る（国名は上下にずらして共存）・Monaco は小国＝まだ出ない
L.draw(view, 1280, 720, 1, 1000);
let w = L.debug().winners;
ok(w.includes("country:France") && w.includes("capital:Paris") && !w.includes("country:Monaco"), `z4 の当選: ${w.join(",")}`);
// 2) フェード：数フレームで 1 に達し、その後 animating=false で安定（振動しない）
let anim = true; for (let i = 1; i <= 6; i++) anim = L.draw(view, 1280, 720, 1, 1000 + i * 100);
ok(anim === false, "到達後は animating=false");
for (let i = 7; i <= 10; i++) ok(L.draw(view, 1280, 720, 1, 1000 + i * 100) === false, `安定 ${i}`);
// 3) ズームを上げると Monaco も出る
L.draw({ ...view, zoom: 6 }, 1280, 720, 1, 5000);
ok(L.debug().winners.includes("country:Monaco"), "z6 で Monaco");
console.log(`t-labels: ${n} ok`);
