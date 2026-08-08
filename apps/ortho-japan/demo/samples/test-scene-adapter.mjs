// 単体テスト（素のESM）：v2 書式＝行そのまま受け渡し（parseScenes）＋via 畳み込み（compileVias）＋先頭jump＋秒の素通し＋嗅ぎ分け。
//   実行＝ node demo/samples/test-scene-adapter.mjs
import { readFileSync } from "node:fs";
import { parseScenes, compileVias } from "../scene-adapter.js";
import { sniffScene } from "../../gadgets/dropfile.js";

let fail = 0;
const ok = (name, cond) => { console.log((cond ? "✓" : "✗") + " " + name); if (!cond) fail++; };
const load = f => JSON.parse(readFileSync(new URL(f, import.meta.url), "utf8"));

// ── sumida-dolly.scenes（via 4連続＝1本のスプライン・travel の緩急）──
{
	const p = parseScenes(load("./sumida-dolly.scenes"));
	ok("sumida: waitLoading / 行6（via は生のまま）", p.waitLoading === true && p.scenes.length === 6);
	ok("sumida: 先頭は jump 付き視点行", p.scenes[0].jump === true && p.scenes[0].view?.startsWith("#17.61"));
	const c = compileVias(p.scenes);
	ok("sumida: compile 後は 2 シーン（via は行から消える）", c.length === 2);
	ok("sumida: path＝5点（via4＋着点自身）", c[1].path?.length === 5 && c[1].path[4].view === c[1].view);
	ok("sumida: travel が各点に乗る", JSON.stringify(c[1].path.map(x => x.travel)) === "[4,4,3,8,5]");
	ok("sumida: hold は秒のまま素通し", c[0].hold === 1 && c[1].hold === 4);
	ok("sumida: 着点の title（既定言語）＋en 兄弟が残る", c[1].title === "隅田川を遡り、スカイツリーへ" && c[1].en === "Up the Sumida to Skytree");
}

// ── tokyo-landmarks.scenes（via 無し＝恒等・最上位 hold・title=既定言語+en 兄弟）──
{
	const p = parseScenes(load("./tokyo-landmarks.scenes"));
	ok("landmarks: 5行・台本既定 hold=4（秒）", p.scenes.length === 5 && p.hold === 4);
	ok("landmarks: title/en は行にそのまま（翻訳しない・台本側に言語指定なし）", p.scenes[0].title === "東京駅" && p.scenes[0].en === "Tokyo Station" && p.lang === undefined);
	ok("landmarks: via 無し＝compileVias は恒等（同一配列）", compileVias(p.scenes) === p.scenes);
	ok("landmarks: 行毎 hold 上書き", p.scenes[4].hold === 5);
}

// ── yokohama-fuji.scenes（glide キー・先頭 view jump）──
{
	const p = parseScenes(load("./yokohama-fuji.scenes"));
	ok("yokohama: glide キーが素通し", p.scenes[1].glide?.includes("75t/-91r") && !p.scenes[1].view);
	ok("yokohama: 先頭 jump / hold 2.5 秒", p.scenes[0].jump === true && p.scenes[0].hold === 2.5);
}

// ── compileVias エッジ ──
ok("edge: 末尾 via（着点無し）＝捨てる", compileVias([{ view: "#7/35/139" }, { via: "#7/36/139" }]).length === 1);
ok("edge: スライド行の前の via＝捨てる", (() => { const c = compileVias([{ view: "#7/35/139" }, { via: "#7/36/139" }, { slide: "x" }]); return c.length === 2 && !c[1].path; })());
ok("edge: glide 着点でも path になる", (() => { const c = compileVias([{ view: "#7/35/139" }, { via: "#7/36/139", travel: 2 }, { glide: "#8/37/140", travel: 3 }]); return c.length === 2 && c[1].path?.length === 2 && c[1].path[1].view === "#8/37/140" && c[1].path[1].travel === 3; })());
ok("edge: travel 省略＝undefined のまま（自動尺はエンジン側）", compileVias([{ view: "#7/35/139" }, { via: "#7/36/139" }, { view: "#8/37/140" }])[1].path[0].travel === undefined);

// ── parseScenes エッジ ──
ok("edge: 先頭 via（出発点無し）＝除去して view 行が先頭 jump", (() => { const p = parseScenes({ scenes: [{ via: "#6/35/139" }, { view: "#7/35/139" }] }); return p.scenes.length === 1 && p.scenes[0].jump === true; })());
ok("edge: 空行の除去", parseScenes({ scenes: [{}, { caption: "x" }, { view: "#7/35/139" }] }).scenes.length === 1);
ok("edge: 先頭スライド行＝jump 無し", (() => { const p = parseScenes({ scenes: [{ slide: "x" }, { view: "#7/35/139" }] }); return p.scenes.length === 2 && !p.scenes[0].jump && !p.scenes[1].jump; })());

// ── sniffScene（ドロップ嗅ぎ分け・mock File）──
const mockFile = (name, text) => ({ name, slice: (a, b) => ({ text: async () => text.slice(a, b) }), text: async () => text });
const t = readFileSync(new URL("./sumida-dolly.scenes", import.meta.url), "utf8");
ok("sniff .scenes → detected", !!(await sniffScene(mockFile("sumida-dolly.scenes", t))));
ok("sniff plain .json w/ type:scenes → detected", !!(await sniffScene(mockFile("tour.json", t))));
ok("sniff geojson FeatureCollection → null", (await sniffScene(mockFile("x.geojson", '{"type":"FeatureCollection","features":[]}'))) === null);
ok("sniff .zip (not json) → null", (await sniffScene(mockFile("x.shp.zip", "PK"))) === null);
ok("sniff 旧 v1 sceneCollection → null（クリーンブレーク）", (await sniffScene(mockFile("old.scene.json", '{"type":"sceneCollection","scenes":[]}'))) === null);
ok("sniff malformed .scenes → null (no throw)", (await sniffScene(mockFile("bad.scenes", "{ not json"))) === null);

console.log(fail ? `\n${fail} FAILED` : "\nALL PASS ✓");
process.exit(fail ? 1 : 0);
