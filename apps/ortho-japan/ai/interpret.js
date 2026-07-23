// 描画スペックJSONのインタープリタ（堀の二段目）。
// 方針: 「拒否せず修復する」— どんな入力でも throw しない。
//   ・語彙のゆらぎ（大文字小文字・typo・日本語色名）は最近傍へ寄せ、notes に修復記録を残す
//   ・解釈不能な部分だけを落とし、スペック全体は生かす
//   ・dataset が特定できない時だけ ok:false（候補一覧と平易な問い返しを返す）
// 純関数・DOM非依存。描画は render adapter が plan を受けて行う。

import { DATASETS, COLORS, WIDTHS, WIDTH_JA, FILTER_OPS, readyDatasets } from "./catalog.js";

const OP_ALIASES = { "=": "eq", "==": "eq", "is": "eq", "!=": "ne", "<": "lt", ">": "gt", "in": "contains", "like": "contains", "has": "contains" };

function lev(a, b) {
	const m = a.length, n = b.length;
	if (!m || !n) return m || n;
	let prev = Array.from({ length: n + 1 }, (_, j) => j);
	for (let i = 1; i <= m; i++) {
		const cur = [i];
		for (let j = 1; j <= n; j++)
			cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
		prev = cur;
	}
	return prev[n];
}

// 候補集合への正規化マッチ。exact → 別名(日本語ラベル等) → 前方一致 → 編集距離2以内。
// 戻り値 { key, repaired } / null。repaired=true なら notes へ記録する。
function matchToken(input, keys, aliases = {}) {
	if (typeof input !== "string") return null;
	const s = input.trim().toLowerCase();
	if (!s) return null;
	if (keys.includes(s)) return { key: s, repaired: s !== input };
	for (const [key, names] of Object.entries(aliases))
		if (names.some(n => n.toLowerCase() === s)) return { key, repaired: true };
	const pre = keys.filter(k => k.startsWith(s) || s.startsWith(k));
	if (pre.length === 1) return { key: pre[0], repaired: true };
	let best = null, bestD = 3;
	for (const k of keys) {
		const d = lev(s, k);
		if (d < bestD) { best = k; bestD = d; }
		else if (d === bestD && best !== null) best = null;   // 同距離タイは曖昧＝採用しない
	}
	return best ? { key: best, repaired: true } : null;
}

// LLM出力の生テキストからJSONを取り出す。コードフェンス・前後の駄弁りを許容。
function parseSpec(raw) {
	if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
	if (typeof raw !== "string") return null;
	const text = raw.replace(/```(?:json)?/g, "");
	const start = text.indexOf("{"), end = text.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	try {
		const obj = JSON.parse(text.slice(start, end + 1));
		return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : null;
	} catch { return null; }
}

function hexToRgba(css) {
	const n = parseInt(css.slice(1), 16);
	return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1];
}

function fail(narration, datasets) {
	return {
		ok: false, plan: null, notes: [],
		suggestions: Object.entries(datasets).map(([id, d]) => ({ id, label: d.label })),
		narration,
	};
}

// plan.filters を feature.properties へ適用する述語（描画側 overlay.js が使う）。
// 値欠損は「不一致」扱い＝フィルタ指定時に属性のない地物は描かない。
export function matchesFilters(props, filters) {
	if (!filters || !filters.length) return true;
	const p = props || {};
	return filters.every(f => {
		const v = p[f.attr];
		if (v == null) return false;
		switch (f.op) {
			case "eq": return String(v) === String(f.value);
			case "ne": return String(v) !== String(f.value);
			case "lt": return Number(v) < f.value;
			case "gt": return Number(v) > f.value;
			case "contains": return String(v).includes(String(f.value));
		}
		return false;
	});
}

export function interpret(raw, { datasets = readyDatasets() } = {}) {
	const notes = [];
	const spec = parseSpec(raw);
	if (!spec) return fail("うまく読み取れませんでした。もう一度入力してみてください。", datasets);

	const known = new Set(["dataset", "area", "filter", "style", "title", "camera"]);
	for (const k of Object.keys(spec))
		if (!known.has(k)) notes.push(`知らない項目「${k}」は無視しました`);

	// dataset — ここだけは修復不能なら全体を諦める（何を描くかが決まらないため）
	const dsIds = Object.keys(datasets);
	const dsAliases = Object.fromEntries(Object.entries(datasets).map(([id, d]) => [id, [d.label]]));
	const dsHit = matchToken(spec.dataset, dsIds, dsAliases);
	if (!dsHit) return fail("何の地図を描くか分かりませんでした。この中から選んでください。", datasets);
	if (dsHit.repaired) notes.push(`「${spec.dataset}」は「${datasets[dsHit.key].label}」のことだと解釈しました`);
	const ds = datasets[dsHit.key];

	// area — 市区町村単位配信のデータセットは地名がないと取得先が決まらない
	const area = typeof spec.area === "string" ? spec.area.trim().slice(0, 20) : null;
	if (ds.needsArea && !area)
		return { ...fail(`「${ds.label}」は、どこの市区町村かを教えてもらえれば描けます。（例：横浜市）`, datasets), needsArea: dsHit.key };

	// style — 解釈できなければデータセット既定色へ寄せる（白紙にはしない）
	const st = (spec.style && typeof spec.style === "object") ? spec.style : {};
	const colorAliases = Object.fromEntries(Object.entries(COLORS).map(([k, c]) => [k, [c.ja, ...(c.alt || [])]]));
	const colorHit = matchToken(st.color, Object.keys(COLORS), colorAliases);
	if (st.color != null && !colorHit) notes.push(`「${st.color}」という色が分からなかったので、標準の色にしました`);
	else if (colorHit?.repaired) notes.push(`色は「${COLORS[colorHit.key].ja}」と解釈しました`);
	const color = colorHit?.key ?? ds.defaults.color;

	const widthHit = matchToken(st.width, Object.keys(WIDTHS));
	if (st.width != null && !widthHit) notes.push(`線の太さ「${st.width}」が分からなかったので、普通にしました`);
	const width = widthHit?.key ?? ds.defaults.width;

	// filter — 属性は台帳の allowlist 照合、値は型強制。不成立の条件だけ落とす
	const filters = [];
	const rawFilters = Array.isArray(spec.filter) ? spec.filter : (spec.filter ? [spec.filter] : []);
	if (rawFilters.length > 3) notes.push("絞り込みは3つまでにしました");
	for (const f of rawFilters.slice(0, 3)) {
		if (!f || typeof f !== "object") continue;
		const attrKeys = Object.keys(ds.attrs);
		const attrAliases = Object.fromEntries(Object.entries(ds.attrs).map(([k, a]) => [k, [a.label]]));
		const attrHit = matchToken(f.attr, attrKeys, attrAliases);
		if (!attrHit) { notes.push(`「${ds.label}」に「${f.attr}」という属性はないので、その絞り込みは外しました`); continue; }
		const attr = ds.attrs[attrHit.key];
		const opHit = matchToken(typeof f.op === "string" ? (OP_ALIASES[f.op.trim()] ?? f.op) : f.op, FILTER_OPS);
		if (!opHit) { notes.push(`比較方法「${f.op}」が分からなかったので、その絞り込みは外しました`); continue; }
		let value = f.value;
		if (attr.type === "number") {
			value = Number(value);
			if (!Number.isFinite(value)) { notes.push(`「${attr.label}」は数値で比較する属性なので、その絞り込みは外しました`); continue; }
		} else {
			if (opHit.key === "lt" || opHit.key === "gt") { notes.push(`「${attr.label}」は大小比較できない属性なので、その絞り込みは外しました`); continue; }
			value = String(value).slice(0, 40);
		}
		filters.push({ attr: attrHit.key, label: attr.label, op: opHit.key, value });
	}

	const cameraHit = matchToken(spec.camera, ["fit", "keep"]);
	const title = typeof spec.title === "string" ? spec.title.trim().slice(0, 24) : ds.label;

	const plan = {
		dataset: dsHit.key,
		label: ds.label,
		route: ds.route,
		target: ds.target ?? null,
		geometry: ds.geometry,
		area,
		filters,
		style: { color, css: COLORS[color].css, rgba: hexToRgba(COLORS[color].css), lineWidth: WIDTHS[width], width },
		camera: cameraHit?.key ?? "fit",
		legend: { title, color: COLORS[color].css, attribution: ds.attribution },
	};

	const filterJa = filters.map(f => ({
		eq: `${f.label}が「${f.value}」`, ne: `${f.label}が「${f.value}」以外`,
		lt: `${f.label}が${f.value}未満`, gt: `${f.label}が${f.value}より大きい`,
		contains: `${f.label}に「${f.value}」を含む`,
	}[f.op] + "もの")).join("、かつ ");
	const narration = `${area ? `${area}の` : ""}「${ds.label}」を${filterJa ? `、${filterJa}に絞って、` : ""}${COLORS[color].ja}で${WIDTH_JA[width]}描きます。`;

	return { ok: true, plan, notes, suggestions: [], narration };
}
