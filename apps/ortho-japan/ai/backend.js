// スペック生成バックエンドの抽象。契約は toSpec(text) => Promise<object|string|null> のみ —
// 戻り値の解釈・検証はすべて interpret.js の領分（バックエンドは信用しない）。throw もしない。
//   json : JSON 直入力（手書きスペック＝AIなしでE2Eが回る開発・検証の一丁目）
//   rule : キーワード規則（AIなし縮退経路。LLM不在・失敗時でも「てつどうをあおで」程度は通す）
//   http : OpenAI互換 chat/completions（自宅Mac Ollama+Tunnel での実測用。WebLLM も同じ口で後から差す）

import { COLORS, WIDTHS, readyDatasets } from "./catalog.js";
import { buildSpecSchema, buildPromptCatalog } from "./schema.js";

export function jsonBackend() {
	return { name: "json", toSpec: async text => (text.trim().startsWith("{") ? text : null) };
}

export function ruleBackend({ datasets = readyDatasets() } = {}) {
	return {
		name: "rule",
		toSpec: async text => {
			const t = String(text);
			const dsId = Object.keys(datasets).find(id =>
				[datasets[id].label, ...(datasets[id].kw || [])].some(k => t.includes(k)));
			if (!dsId) return null;
			const spec = { dataset: dsId, style: {} };
			for (const [key, c] of Object.entries(COLORS))
				if ([c.ja, ...(c.alt || [])].some(w => t.includes(w)) || t.toLowerCase().includes(key)) { spec.style.color = key; break; }
			if (/ふと|太/.test(t)) spec.style.width = "thick";
			else if (/ほそ|細/.test(t)) spec.style.width = "thin";
			const area = t.match(/([一-龠ぁ-んァ-ヶA-Za-z]{1,8}?[市区町村])/);
			if (area) spec.area = area[1];
			return spec;
		},
	};
}

export function systemPrompt(datasets = readyDatasets()) {
	return [
		"あなたは地図アプリの通訳です。ユーザーの言葉を、地図に描くためのJSONに変換します。",
		"JSON以外は一切出力しないこと。説明もあいさつも不要。",
		"", "使えるデータセット（dataset に入れる値）:", buildPromptCatalog(datasets),
		"", `色(style.color): ${Object.entries(COLORS).map(([k, c]) => `${k}=${c.ja}`).join(" ")}`,
		`線の太さ(style.width): ${Object.keys(WIDTHS).join("/")}`,
		"市区町村名が言われたら area に入れる。",
		"", "例: 「よこはまの町丁目をオレンジで」→",
		'{"dataset":"smallarea","area":"横浜市","style":{"color":"orange"}}',
	].join("\n");
}

// OpenAI互換API。format は Ollama の json_schema 拘束（response_format）を使う。
export function httpBackend({ url, model, datasets = readyDatasets(), timeout = 30000 } = {}) {
	return {
		name: "http",
		toSpec: async text => {
			try {
				const res = await fetch(`${url.replace(/\/$/, "")}/v1/chat/completions`, {
					method: "POST", headers: { "content-type": "application/json" },
					signal: AbortSignal.timeout(timeout),
					body: JSON.stringify({
						model, temperature: 0,
						response_format: { type: "json_schema", json_schema: { name: "mapspec", schema: buildSpecSchema(datasets) } },
						messages: [{ role: "system", content: systemPrompt(datasets) }, { role: "user", content: String(text) }],
					}),
				});
				if (!res.ok) { console.warn("[ai] http backend", res.status); return null; }
				return (await res.json())?.choices?.[0]?.message?.content ?? null;
			} catch (err) { console.warn("[ai] http backend", err); return null; }
		},
	};
}

// 直列フォールバック合成：先頭から順に試し、最初に spec を出した backend が勝つ。
// LLM が死んでいても rule が拾う＝会話が無応答にならない（失敗の不在）。
export function composeBackends(backends) {
	return {
		name: backends.map(b => b.name).join(">"),
		toSpec: async text => {
			for (const b of backends) {
				const spec = await b.toSpec(text);
				if (spec != null) return spec;
			}
			return null;
		},
	};
}
