// ラベル層の検定：衝突・フェード（到達後に振動しない）・国名の上下ずらし
import assert from "node:assert/strict";
import { createLabels, countryLabels, cityLabels, stripJaCitySuffix, LABEL_SCALE } from "../src/labels.js";
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

// ── 日本語の都市名の接尾辞（2026-09-18）──────────────────────────────────────────
// 落とすのは「市」の族だけ。実データ（ne-cultural-base の NAME_JA・489 件）から取った現物で固定する。
for (const [src, want] of [
	["北京市", "北京"], ["上海市", "上海"], ["ソウル特別市", "ソウル"], ["釜山広域市", "釜山"], ["平壌直轄市", "平壌"],
	["札幌市", "札幌"], ["横浜市", "横浜"], ["台北市", "台北"], ["新北市", "新北"],
	["呉市", "呉"], ["津市", "津"],                    // 語幹 1 文字でも正しい（Kure・Tsu）
	["津市市", "津市"], ["四日市市", "四日市"],          // 末尾 1 つだけ落とす＝「市」を含む地名が壊れない
	["東京都", "東京都"], ["クイーンズランド州", "クイーンズランド州"], ["路南区", "路南区"], ["岷県", "岷県"],   // 「市」以外の区分は残す
	["", ""], ["市", "市"],                            // 空・全部落ちる名前は元のまま
]) ok(stripJaCitySuffix(src) === want, `stripJaCitySuffix(${JSON.stringify(src)}) = ${JSON.stringify(stripJaCitySuffix(src))}（期待 ${JSON.stringify(want)}）`);

// ── 文字の大きさ（2026-09-18「少しだけ小さく」）────────────────────────────────
// 一つのノブで国名・都市をまとめて縮める。0.5px 刻み・大小の序列は保つ。
{
	ok(LABEL_SCALE > 0.8 && LABEL_SCALE < 1, `LABEL_SCALE=${LABEL_SCALE} は「少しだけ」の範囲`);
	const big = { key: "RU", name: { en: "Russia" }, coord: [100, 60], area: 1.7e7 };
	const small = { key: "MC", name: { en: "Monaco" }, coord: [7.4, 43.7], area: 2 };
	const [cBig, cSmall] = countryLabels({ items: [big, small] }, n => n.name.en, pal);
	ok(cBig.size === 12 && cSmall.size === 9, `国名の大きさ 大=${cBig.size} 小=${cSmall.size}（13/10 の 0.92 倍）`);
	ok(cBig.size > cSmall.size, "大国の方が大きい（序列は不変）");
	const caps = cityLabels(cities, p => p.NAME_EN, pal);
	ok(caps[0].size === 10.5, `首都の大きさ ${caps[0].size}（11.5 の 0.92 倍）`);
	ok(Number.isInteger(cBig.size * 2), "0.5px 刻みに丸まっている");
}

console.log(`t-labels: ${n} ok`);
