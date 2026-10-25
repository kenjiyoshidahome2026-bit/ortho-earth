#!/usr/bin/env node
// CZML の model・polyline・polygon（P0 #5・src/gadgets/czml-scene.ts の純関数）。試料 fixtures/czml/scene.czml を geopbf で読み（GeoPBF の書き込みまで通す）、
//   ・面＝押し出し（height〜extrudedHeight・色）・地面の線（clampToGround）・高さのある線（大円で刻む・高さ 1500m）・模型 2 体（静止＝四元数・動く＝進む向き）
//   ・heading＝模型の +X の方位 − 90（静止＝南向き＝90°・東へ動く＝0°）・出ている区間・相対 URI の解決
// 使い方：node packages/globe/tests/czml-scene.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { czmlToFeatures } from "geopbf/czml";
import { GeoPBFBase } from "geopbf/pbf-base";
import { trackOf, ecefToLlh, positionAt, colorOf } from "../src/czml-time.ts";
import { czmlSceneOf, modelHeadingAt, quaternionAt, shownAt } from "../src/gadgets/czml-scene.ts";
globalThis.ImageData ??= class ImageData {};

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/czml");
let fails = 0;
const ok = (c, m) => { if (c) console.log("  ✓ " + m); else { fails++; console.error("  ✗ " + m); } };
const T = s => Date.parse("2026-01-01T00:00:00Z") + s * 1000;
const packets = JSON.parse(fs.readFileSync(path.join(DIR, "scene.czml"), "utf8"));
const fs_ = (await new GeoPBFBase({ name: "t" }).set({ type: "FeatureCollection", features: czmlToFeatures(packets).features })).features;
const sc = czmlSceneOf(fs_, { baseUrl: "https://example.com/data/scene.czml", trackOf });

ok(sc.shapes.length === 2, `地面の層は 2 つ（押し出しの面・地面の線）＝${sc.shapes.map(s => s.properties._k)}`);
const ext = sc.shapes.find(s => s.properties._k === "ext"), road = sc.shapes.find(s => s.properties._k === "line");
ok(ext && ext.properties._b === 0 && ext.properties._h === 200 && ext.properties._fc === "rgb(40,80,220)" && ext.properties._fo === 1, `押し出し 0〜200m・色 ${ext?.properties._fc}`);
ok(road && road.properties._lw === 8 && road.properties._lc === "rgb(255,220,0)", `地面の線（幅 8・黄）`);
ok(sc.lines.length === 1 && colorOf({ polylineOutline: { color: { rgba: [0, 230, 80, 255] } } }) === sc.lines[0].color, `高さのある線 1 本（色＝polylineOutline の color）`);
const L = sc.lines[0], n = L.p.length / 3, hs = Array.from({ length: n }, (_, i) => ecefToLlh(L.p[i * 3], L.p[i * 3 + 1], L.p[i * 3 + 2])[2]);
ok(n >= 2 && hs.every(h => Math.abs(h - 1500) < 0.5), `高さ 1500m のまま（${n} 点・${Math.min(...hs).toFixed(2)}〜${Math.max(...hs).toFixed(2)}）`);
// 大円で刻む：1000 km の線は 100 km ごと
const far = czmlSceneOf([{ type: "Feature", geometry: { type: "LineString", coordinates: [[130, 35], [141, 35]] }, properties: { ele: [5000, 5000], czml: { polyline: { width: 2 } } } }]).lines[0];
const mid = ecefToLlh(...far.p.slice(Math.floor(far.p.length / 6) * 3, Math.floor(far.p.length / 6) * 3 + 3));
ok(far.p.length / 3 >= 11 && mid[1] > 35.05, `大円で刻む（${far.p.length / 3} 点・途中の緯度 ${mid[1].toFixed(3)} は 35 より北＝大円の膨らみ）`);
const flat = czmlSceneOf([{ type: "Feature", geometry: { type: "LineString", coordinates: [[130, 35], [141, 35]] }, properties: { ele: [5000, 5000], czml: { polyline: { arcType: "NONE" } } } }]).lines[0];
ok(flat.p.length === 6, `arcType NONE は刻まない`);
ok(sc.models.length === 2, `模型 2 体＝${sc.models.map(m => m.id)}`);
const st = sc.models.find(m => m.id === "statue"), car = sc.models.find(m => m.id === "car");
ok(st.uri === "https://example.com/data/box.glb" && st.heightRef === "CLAMP_TO_GROUND" && !st.track && st.at[0] === 139.7, `静止の模型＝相対 URI を引く（${st.uri}）`);
const hS = modelHeadingAt(st, T(0), 139.7, 35.68);
ok(Math.abs(hS - 90) < 0.01, `静止の模型の heading＝四元数から 90°（${hS.toFixed(4)}）`);
ok(!!car.track, `動く模型は軌跡を持つ`);
const q = positionAt(car.track, T(1800)), ll = ecefToLlh(...q), hC = modelHeadingAt(car, T(1800), ll[0], ll[1]);
ok(Math.abs(ll[0] - 139.70) < 1e-6 && Math.abs(hC) < 0.05, `動く模型＝東へ進む＝heading 0（${hC.toFixed(4)}・経度 ${ll[0].toFixed(5)}）`);
// 使った番号＝面・線・静止の模型は本道へ回さない・動く模型（軌跡）は czml.ts にも残す
const ids = [...sc.used].map(i => fs_[i].properties.id).sort();
ok(JSON.stringify(ids) === JSON.stringify(["air", "block", "road", "statue"]), `used＝${ids}`);
// 出ている区間
ok(shownAt(sc.shapeAvail[sc.shapes.indexOf(ext)], T(600)) && !shownAt(sc.shapeAvail[sc.shapes.indexOf(ext)], T(2400)), `面は 30 分まで`);
// 四元数の標本（線形に寄せて正規化）
const qs = quaternionAt({ epoch: "2026-01-01T00:00:00Z", unitQuaternion: [0, 0, 0, 0, 1, 10, 0, 0, 1, 0] }, T(5));
ok(Math.abs(Math.hypot(...qs) - 1) < 1e-9 && Math.abs(qs[2] - Math.SQRT1_2) < 1e-9, `四元数の標本の間＝正規化（${qs.map(v => v.toFixed(3))}）`);
// 外形線
const ol = czmlSceneOf([{ type: "Feature", geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }, properties: { czml: { polygon: { fill: false, outline: true, outlineColor: { rgba: [255, 0, 0, 128] } } } } }]).shapes;
ok(ol.length === 1 && ol[0].geometry.type === "MultiLineString" && ol[0].properties._lc === "rgb(255,0,0)" && Math.abs(ol[0].properties._lo - 0.502) < 0.01, `fill:false・outline＝外形の線だけ`);
// 模型だけの軌跡は点・尾を足さない（styleOf）
const { styleOf } = await import("../src/czml-time.ts");
const carF = fs_.find(f => f.properties.id === "car"), sty = styleOf(carF);
ok(!sty.point && !sty.path && !sty.label && !sty.image, `模型だけの軌跡＝点・尾・札を描かない`);
console.log(fails ? `czml-scene: ${fails} 件 NG` : "czml-scene: OK");
process.exit(fails ? 1 : 0);
