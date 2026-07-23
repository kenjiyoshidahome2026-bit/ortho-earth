// 台帳(catalog.js)から JSON Schema とプロンプト用カタログを機械生成する。
// この Schema は WebLLM/Ollama の文法拘束デコード(XGrammar)にそのまま渡す想定 —
// LLM は文法レベルでこの語彙の外に出られない（堀の一段目）。

import { COLORS, WIDTHS, FILTER_OPS, readyDatasets } from "./catalog.js";

export function buildSpecSchema(datasets = readyDatasets()) {
	const attrKeys = [...new Set(Object.values(datasets).flatMap(d => Object.keys(d.attrs || {})))];
	const filterItem = {
		type: "object", additionalProperties: false,
		required: ["attr", "op", "value"],
		properties: {
			attr:  attrKeys.length ? { enum: attrKeys } : { type: "string", maxLength: 20 },
			op:    { enum: FILTER_OPS },
			value: { anyOf: [{ type: "string", maxLength: 40 }, { type: "number" }] },
		},
	};
	return {
		type: "object", additionalProperties: false,
		required: ["dataset"],
		properties: {
			dataset: { enum: Object.keys(datasets) },
			area:    { type: "string", maxLength: 20 },
			filter:  { type: "array", maxItems: 3, items: filterItem },
			style: {
				type: "object", additionalProperties: false,
				properties: {
					color: { enum: Object.keys(COLORS) },
					width: { enum: Object.keys(WIDTHS) },
				},
			},
			title:  { type: "string", maxLength: 24 },
			camera: { enum: ["fit", "keep"] },
		},
	};
}

// システムプロンプトに埋める圧縮カタログ（id＋一行説明）。全文カタログは絶対に埋めない。
export function buildPromptCatalog(datasets = readyDatasets()) {
	return Object.entries(datasets).map(([id, d]) => {
		const attrs = Object.entries(d.attrs || {})
			.map(([k, a]) => `${k}=${a.label}(${a.type})`).join(" ");
		return `${id}: ${d.label}${d.needsArea ? "（area必須＝市区町村名）" : ""}${attrs ? ` 属性: ${attrs}` : ""}`;
	}).join("\n");
}
