// 描画スペック・インタープリタの敵対テスト（node tests/t-aispec.mjs）。
// 検証したいのは「どんな入力でも throw しない」「修復は notes に残る」「解釈不能でも白紙にならない」の3点。

import { strict as assert } from "node:assert";
import { interpret, matchesFilters } from "../ai/interpret.js";
import { buildSpecSchema, buildPromptCatalog } from "../ai/schema.js";
import { ruleBackend, jsonBackend, composeBackends } from "../ai/backend.js";
import { readyDatasets, COLORS } from "../ai/catalog.js";

let n = 0;
function t(name, fn) { n++; fn(); console.log(`ok ${n} - ${name}`); }

t("正常スペックがそのまま plan になる", () => {
	const r = interpret({ dataset: "rail", style: { color: "blue", width: "thick" }, filter: [{ attr: "N02_004", op: "eq", value: "東日本旅客鉄道" }] });
	assert.equal(r.ok, true);
	assert.equal(r.plan.target, "N02-25_RailroadSection");
	assert.equal(r.plan.style.css, COLORS.blue.css);
	assert.equal(r.plan.style.lineWidth, 3.0);
	assert.equal(r.plan.filters.length, 1);
	assert.equal(r.notes.length, 0);
	assert.match(r.narration, /鉄道路線/);
});

t("コードフェンス＋前後の駄弁り付きLLM出力を読める", () => {
	const raw = 'はい、かしこまりました！\n```json\n{"dataset": "coastline"}\n```\nいかがでしょうか。';
	const r = interpret(raw);
	assert.equal(r.ok, true);
	assert.equal(r.plan.dataset, "coastline");
});

t("大文字・空白ゆらぎを修復する", () => {
	const r = interpret({ dataset: " Rail " });
	assert.equal(r.ok, true);
	assert.equal(r.plan.dataset, "rail");
});

t("typo を編集距離で修復し notes に残す", () => {
	const r = interpret({ dataset: "raill" });
	assert.equal(r.ok, true);
	assert.equal(r.plan.dataset, "rail");
	assert.equal(r.notes.length, 1);
});

t("前方一致で修復する（coastlin）", () => {
	const r = interpret({ dataset: "coastlin" });
	assert.equal(r.ok, true);
	assert.equal(r.plan.dataset, "coastline");
});

t("日本語ラベルでも dataset を引ける", () => {
	const r = interpret({ dataset: "鉄道路線", style: { color: "あお" } });
	assert.equal(r.ok, true);
	assert.equal(r.plan.dataset, "rail");
	assert.equal(r.plan.style.color, "blue");
});

t("知らない色は既定色へ縮退し notes で伝える", () => {
	const r = interpret({ dataset: "rail", style: { color: "gold" } });
	assert.equal(r.ok, true);
	assert.equal(r.plan.style.color, "cyan");   // rail の既定
	assert.ok(r.notes.some(s => s.includes("gold")));
});

t("width のゆらぎ（thickest→thick）", () => {
	const r = interpret({ dataset: "rail", style: { width: "thickest" } });
	assert.equal(r.plan.style.width, "thick");
});

t("存在しない属性のフィルタだけ落ち、スペックは生きる", () => {
	const r = interpret({ dataset: "rail", filter: [{ attr: "人口", op: "gt", value: 100 }, { attr: "会社名", op: "eq", value: "JR" }] });
	assert.equal(r.ok, true);
	assert.equal(r.plan.filters.length, 1);
	assert.equal(r.plan.filters[0].attr, "N02_004");   // 日本語ラベル「会社名」から解決
	assert.ok(r.notes.some(s => s.includes("人口")));
});

t("文字列属性への大小比較は落とす", () => {
	const r = interpret({ dataset: "rail", filter: [{ attr: "N02_003", op: "gt", value: "山手" }] });
	assert.equal(r.plan.filters.length, 0);
	assert.equal(r.notes.length, 1);
});

t("演算子の別名（= → eq）を受ける", () => {
	const r = interpret({ dataset: "rail", filter: [{ attr: "N02_003", op: "=", value: "山手線" }] });
	assert.equal(r.plan.filters[0].op, "eq");
});

t("フィルタ4件以上は3件へ丸める", () => {
	const f = { attr: "N02_003", op: "eq", value: "x" };
	const r = interpret({ dataset: "rail", filter: [f, f, f, f, f] });
	assert.equal(r.plan.filters.length, 3);
	assert.ok(r.notes.some(s => s.includes("3つ")));
});

t("未知キーは捨てて notes に残す", () => {
	const r = interpret({ dataset: "rail", evil: "rm -rf /", zoom: 99 });
	assert.equal(r.ok, true);
	assert.equal(r.notes.length, 2);
});

t("dataset 不明は ok:false ＋候補一覧（throw しない）", () => {
	const r = interpret({ dataset: "きょうりゅうの化石" });
	assert.equal(r.ok, false);
	assert.ok(r.suggestions.length >= 4);
	assert.match(r.narration, /選んでください/);
});

t("area 必須データセットは地名がないと問い返す", () => {
	const r = interpret({ dataset: "smallarea" });
	assert.equal(r.ok, false);
	assert.equal(r.needsArea, "smallarea");
	assert.match(r.narration, /市区町村/);
});

t("area があれば smallarea は plan になる", () => {
	const r = interpret({ dataset: "smallarea", area: "横浜市" });
	assert.equal(r.ok, true);
	assert.equal(r.plan.route, "estat");
	assert.equal(r.plan.area, "横浜市");
});

t("ゴミ入力すべてで throw しない", () => {
	for (const junk of [null, undefined, 42, [], "こんにちは", "{broken json", { dataset: 42 }, { dataset: null }])
		assert.equal(interpret(junk).ok, false);
});

t("スキーマは台帳から生成され dataset enum が一致する", () => {
	const schema = buildSpecSchema();
	assert.deepEqual(schema.properties.dataset.enum, Object.keys(readyDatasets()));
	assert.equal(schema.additionalProperties, false);
});

t("プロンプト用圧縮カタログに ready:false が漏れない", () => {
	const cat = buildPromptCatalog();
	assert.ok(cat.includes("rail:"));
	assert.ok(!cat.includes("amedas"));
});

t("matchesFilters: eq/ne/lt/gt/contains と欠損値", () => {
	const p = { name: "山手線", op: "JR東日本", n: 34 };
	assert.equal(matchesFilters(p, [{ attr: "name", op: "eq", value: "山手線" }]), true);
	assert.equal(matchesFilters(p, [{ attr: "op", op: "contains", value: "JR" }]), true);
	assert.equal(matchesFilters(p, [{ attr: "n", op: "gt", value: 30 }, { attr: "n", op: "lt", value: 40 }]), true);
	assert.equal(matchesFilters(p, [{ attr: "n", op: "ne", value: 34 }]), false);
	assert.equal(matchesFilters(p, [{ attr: "missing", op: "eq", value: "x" }]), false);   // 欠損＝不一致
	assert.equal(matchesFilters(p, null), true);
	assert.equal(matchesFilters(null, [{ attr: "a", op: "eq", value: 1 }]), false);
});

// rule backend＝AIなし縮退経路。ここが通る限り「LLM全滅でも会話が成立」する
const ta = async (name, fn) => { n++; await fn(); console.log(`ok ${n} - ${name}`); };
const rule = ruleBackend();
await ta("ruleBackend: ひらがな指示から dataset/色/太さを拾う", async () => {
	const spec = await rule.toSpec("てつどうを あおで ふとく かいて");
	assert.equal(spec.dataset, "rail");
	assert.equal(spec.style.color, "blue");
	assert.equal(spec.style.width, "thick");
});

await ta("ruleBackend: 市区町村名を area に拾う", async () => {
	const spec = await rule.toSpec("横浜市の町丁目をオレンジで");
	assert.equal(spec.dataset, "smallarea");
	assert.equal(spec.area, "横浜市");
	assert.equal(spec.style.color, "orange");
});

await ta("ruleBackend: 該当なしは null（interpret が問い返しを作る）", async () => {
	assert.equal(await rule.toSpec("こんにちは"), null);
});

await ta("composeBackends: json直入力が rule より勝つ", async () => {
	const b = composeBackends([jsonBackend(), rule]);
	const spec = await b.toSpec('{"dataset":"park"}');
	assert.equal(typeof spec, "string");   // json はパススルー＝interpret が読む
	const r = interpret(spec);
	assert.equal(r.plan.dataset, "park");
});

console.log(`\n${n} tests passed`);
