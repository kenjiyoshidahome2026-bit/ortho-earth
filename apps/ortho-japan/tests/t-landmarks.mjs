// ランドマーク名札の掟を実ソース・実データで確かめる Node ハーネス（ネットワーク不要）。
//   node tests/t-landmarks.mjs
// 高さの梯子（landmarkMinH）は app.js から切り出して評価する＝写経した複製を試験しない（t-chome.mjs と同じ方式）。
// 台帳（public/plateau-landmarks.json）は突合結果（plateau-names-out/merged/）と突き合わせて、
// 「タイル注記に同名がある棟(d2)を名札に混ぜていない」ことを確認する＝二重表示の再発を焼いた時点で捕まえる。
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(HERE, "../app.js"), "utf8");
const from = src.indexOf("const LANDMARK_CODE"), to = src.indexOf("let landmarks = null");
if (from < 0 || to < 0 || to < from) { console.error("app.js から梯子を切り出せない（実装が移動した？）"); process.exit(1); }
const { landmarkMinH, LANDMARK_LADDER, LANDMARK_CODE } =
	new Function(src.slice(from, to) + "\nreturn { landmarkMinH, LANDMARK_LADDER, LANDMARK_CODE };")();

let fail = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? "ok" : "NG"} ${msg}`); if (!cond) fail++; };

// ① 梯子：低ズームでは出さない／寄るほど低い建物まで降りる（単調非増加）
ok(landmarkMinH(10.9) === Infinity, "z10.9 では出さない（梯子の下限より手前）");
ok(landmarkMinH(11) === 150, "z11 で 150m 以上");
ok(landmarkMinH(12.5) === 100, "z12.5 で 100m 以上");
ok(landmarkMinH(14) === 60, "z14 で 60m 以上");
ok(landmarkMinH(19) === 60, "深ズームでも下限は 60m（際限なく増やさない）");
let mono = true;
for (let z = 10; z <= 19; z += 0.1) if (landmarkMinH(z) > landmarkMinH(z - 0.1)) mono = false;
ok(mono, "梯子は単調（寄って条件が厳しくなる段が無い）");
// ② 合成コードが optbv の実コード帯とぶつからない（themes.js の施設判定に落ちる＝施設チップの傘下）
ok(LANDMARK_CODE > 8999, `合成コード ${LANDMARK_CODE} は optbv 実コード(〜8105)の外`);

// ③ 台帳そのもの
const LM = join(HERE, "../public/plateau-landmarks.json");
if (!existsSync(LM)) { console.log("  -- 台帳が未生成（scripts/plateau-names-merge.mjs --emit-landmarks）＝③④は省略"); }
else {
	const j = JSON.parse(readFileSync(LM, "utf8"));
	ok(Array.isArray(j.f) && j.f.length > 0, `台帳 ${j.f?.length}棟`);
	ok(j.f.every(r => r[3] >= j.h), `全棟が h>=${j.h}m`);
	ok(j.f.every((r, i) => i === 0 || j.f[i - 1][3] >= r[3]), "高さの降順に並んでいる（ズーム段階で先頭から使える）");
	ok(j.f.every(r => typeof r[0] === "string" && r[0].trim() && Number.isFinite(r[1]) && Number.isFinite(r[2])), "名前と経緯度が全棟そろっている");
	ok(j.f.every(r => Math.abs(r[1]) <= 180 && r[2] > 20 && r[2] < 46), "経緯度が日本の範囲");
	// 梯子の各段で何棟出るか（見せすぎの早期検知）
	for (const [z, h] of LANDMARK_LADDER) console.log(`  -- z${z}以上で ${j.f.filter(r => r[3] >= h).length}棟（h>=${h}m）`);

	// ④ 二重表示：タイル注記に同名がある棟(d2)が台帳に混ざっていないか（突合結果と突き合わせ）
	const MG = join(HERE, "../plateau-names-out/merged");
	if (!existsSync(MG)) console.log("  -- 突合結果が無い＝④は省略");
	else {
		// 例外は 300m級だけ（塔そのものが目印＝テナント名ではない。実測で該当は東京スカイツリーのみ）。
		// 88x帯の施設名は z16タイルにしか無く z11〜15 では地図に名前が出ないため、ここだけは通して実行時の同名スキップに任せる。
		// 突合は棟ごと＝キーは名前だけでなく位置も含める。同名の別棟が同じ市内に居て d が割れることがある
		// （実測：前橋市の「東京電力パワーグリッド群馬総支社」は 68.6m の棟が d0・1km離れた 23.7m の棟が d2）。
		const key = (n, x, y) => `${n}@${x.toFixed(4)},${y.toFixed(4)}`;
		const d2 = new Map();   // 棟キー → 突合したタイル注記のコード（会社名888かどうかで通し口が変わる）
		for (const f of readdirSync(MG).filter(f => f.endsWith(".json")))
			for (const r of JSON.parse(readFileSync(join(MG, f), "utf8")).named) if (r.d === 2) d2.set(key(r.n, r.x, r.y), r.c);
		// d2 が通ってよいのは「300m級」か「タイル側が会社名(888)の150m以上」だけ。それ以外＝テナント名の混入。
		const leaked = j.f.filter(r => { const c = d2.get(key(r[0], r[1], r[2])); return c !== undefined && !(r[3] >= 300 || (r[3] >= 150 && c === 888)); });
		ok(leaked.length === 0, `テナント名らしき d2 が台帳に ${leaked.length}件（例 ${leaked.slice(0, 3).map(r => r[0]).join("/")}）`);
		ok(j.f.some(r => d2.get(key(r[0], r[1], r[2])) !== undefined && r[3] >= 300), "300m級は d2 でも通る（東京スカイツリーが遠景で無名にならない）");
		ok(j.f.some(r => d2.get(key(r[0], r[1], r[2])) === 888), "会社名(888)の超高層は d2 でも通る（大阪・名古屋の本社ビルが全滅しない）");
	}
}
console.log(fail ? `\n✗ ${fail}件 NG` : "\n✓ 全て OK");
process.exit(fail ? 1 : 0);
