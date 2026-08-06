// 単体テスト（素のESM）：平ら sceneCollection の翻訳＋hold:0連続のspline束ね＋先頭jump＋flat i18n＋嗅ぎ分け。
//   実行＝ node demo/samples/test-scene-adapter.mjs
import { readFileSync } from "node:fs";
import { sceneCollectionToScenes } from "../scene-adapter.js";
import { sniffScene } from "../../gadgets/dropfile.js";

let fail = 0;
const ok = (name, cond) => { console.log((cond ? "✓" : "✗") + " " + name); if (!cond) fail++; };
const load = f => JSON.parse(readFileSync(new URL(f, import.meta.url), "utf8"));

// ── sample 1: yokohama-fuji（全 fly・先頭 jump・waitPlateau）──
{
	const { scenes, lang, waitPlateau } = sceneCollectionToScenes(load("./yokohama-fuji.scene.json"));
	ok("yokohama: 3 scenes, no path", scenes.length === 3 && scenes.every(s => !s.path));
	ok("yokohama: scene0 jump=true (start as-defined)", scenes[0].jump === true && scenes[0].view === "#5.2/36.3/138.4/0t/0r/l=terrain/c=mono");
	ok("yokohama: last hold 5000 / lang jp / waitPlateau", scenes[2].hold === 5000 && lang === "jp" && waitPlateau === true);
	ok("yokohama: caption jp", scenes[2].caption === "みなとみらい ― 富士を望む");
}

// ── sample 2: sumida-dolly（establishing + hold:0連続5 の spline 束ね）──
{
	const { scenes } = sceneCollectionToScenes(load("./sumida-dolly.scene.json"));
	ok("sumida: 2 scenes (establishing + path)", scenes.length === 2);
	ok("sumida: scene0 jump glide (河口) hold 2000", scenes[0].jump === true && scenes[0].glide === "#14.9/35.658/139.786/66t/10r/l=place.rail.road.facility/c=mono" && scenes[0].hold === 2000);
	ok("sumida: scene1 path of 5, hold 4000, no jump", scenes[1].path?.length === 5 && scenes[1].hold === 4000 && !scenes[1].jump);
	ok("sumida: path caption = first non-empty (遡上)", scenes[1].caption === "隅田川を遡る");
	ok("sumida: path secs summed (~13)", Math.abs(scenes[1].secs - 13) < 0.05);
}

// ── sample 3: tokyo-landmarks（flat i18n: caption=jp 既定, en 兄弟）──
{
	const jp = sceneCollectionToScenes(load("./tokyo-landmarks.scene.json"), "jp").scenes;
	const en = sceneCollectionToScenes(load("./tokyo-landmarks.scene.json"), "en").scenes;
	ok("landmarks: 5 scenes, no path, scene0 jump", en.length === 5 && en.every(s => !s.path) && en[0].jump === true);
	ok("landmarks: jp → caption 東京駅", jp[0].caption === "東京駅");
	ok("landmarks: en → sibling Tokyo Station", en[0].caption === "Tokyo Station");
	ok("landmarks: last hold override 5000", en[4].hold === 5000);
}

// ── grouping edge cases（合成・平ら defaults.transition glide）──
const G = keys => sceneCollectionToScenes({ defaults: { transition: "glide" }, scenes: keys }).scenes;
ok("edge: single glide hold>0 → normal glide (no path)", (() => { const s = G([{ view: "#7/35/139", hold: 2 }]); return s.length === 1 && s[0].glide === "#7/35/139" && !s[0].path; })());
ok("edge: two hold:0 glide → one path(2)", (() => { const s = G([{ view: "#7/35/139", hold: 0 }, { view: "#7/36/139", hold: 0 }]); return s.length === 1 && s[0].path?.length === 2 && s[0].hold === 0; })());
ok("edge: [glide h0, fly, glide h0] → [glide, view, glide]", (() => { const s = G([{ view: "#7/35/139", hold: 0 }, { view: "#8/35/139", transition: "fly", hold: 1 }, { view: "#7/36/139", hold: 0 }]); return s.length === 3 && s[0].glide && s[1].view && s[2].glide && !s.some(x => x.path); })());
ok("edge: back-compat camera.keys still works", (() => { const s = sceneCollectionToScenes({ camera: { defaults: { transition: "fly" }, keys: [{ view: "#6/40/140" }] } }).scenes; return s.length === 1 && s[0].view === "#6/40/140" && s[0].jump === true; })());

// ── sniffScene（ドロップ嗅ぎ分け・mock File）──
const mockFile = (name, text) => ({ name, slice: (a, b) => ({ text: async () => text.slice(a, b) }), text: async () => text });
const t = readFileSync(new URL("./sumida-dolly.scene.json", import.meta.url), "utf8");
ok("sniff .scene.json → detected", !!(await sniffScene(mockFile("sumida-dolly.scene.json", t))));
ok("sniff plain .json w/ type → detected", !!(await sniffScene(mockFile("tour.json", t))));
ok("sniff geojson FeatureCollection → null", (await sniffScene(mockFile("x.geojson", '{"type":"FeatureCollection","features":[]}'))) === null);
ok("sniff .zip (not json) → null", (await sniffScene(mockFile("x.shp.zip", "PK"))) === null);
ok("sniff malformed .scene.json → null (no throw)", (await sniffScene(mockFile("bad.scene.json", "{ not json"))) === null);

console.log(fail ? `\n${fail} FAILED` : "\nALL PASS ✓");
process.exit(fail ? 1 : 0);
