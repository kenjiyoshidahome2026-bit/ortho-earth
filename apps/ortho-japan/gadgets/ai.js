// ガジェット：AIと会話して地図に描く（PC専用・画面2分割＝左:地図・右:会話）。
// 会話文→スペックは ai/backend.js（json直入力→LLM→キーワード規則の直列フォールバック＝LLM不在でも動く）、
// スペックの検証・修復・子ども向け narration は ai/interpret.js、描画は注入された runPlan（overlay.js の loadPlan）。
// 2分割は親のflex化＝地図側は app.js の ResizeObserver が自動追随（このガジェットはcanvasに触らない）。
import { interpret } from "../ai/interpret.js";
import { composeBackends, jsonBackend, ruleBackend, httpBackend } from "../ai/backend.js";
import { readyDatasets } from "../ai/catalog.js";
import { tr } from "../i18n.js";
const t = tr({
	"AIと地図を描く": "Draw the map with AI",
	"閉じる": "Close",
	"何を描く？（例：鉄道を青で）": "What shall we draw? (e.g. railways in blue)",
	"AIへの指示": "Instruction for the AI",
	"送る": "Send",
	"全部消しました。次は何を描きますか？": "All cleared. What shall we draw next?",
	"・{0}": "• {0}",
	"「{0}」という市区町村が見つかりませんでした。別の書き方で試してみてください。": "No municipality called \"{0}\" was found. Try writing it differently.",
	"データを取りよせています…（初回は時間がかかります。2回目からは速くなります）": "Fetching the data… (the first time takes a while; it will be faster next time)",
	"その絞り込みでは1つも見つかりませんでした。（全部で{0}件あります）": "Nothing matched that filter. (There are {0} items in total)",
	"データがうまく読み込めませんでした。": "The data could not be loaded.",
	"{0}件 描けました。地図をクリックすると属性が見られます。（出典: {1}）": "Drew {0} features. Click the map to see their attributes. (Source: {1})",
	"こんにちは。地図に何を描いてみますか？ 下のボタンから選ぶか、言葉で教えてください。": "Hi! What shall we draw on the map? Pick a button below or tell me in words.",
});

export function ai({ runPlan, clearPlan, fitBbox, assetBase = "/", llmUrl, llmModel, force, signal } = {}) {
	const mapEl = this.mapEl;
	if (document.getElementById("ai")) return;   // 二重搭載は無害
	if (!force && !matchMedia("(min-width: 900px) and (pointer: fine)").matches) { console.warn("[ai] desktop only (split-screen layout), not mounting on this screen"); return; }

	const host = mapEl.parentElement;
	const prev = { display: host.style.display, flex: mapEl.style.flex, width: mapEl.style.width };
	host.style.display = "flex";
	mapEl.style.flex = "1 1 auto"; mapEl.style.width = "auto";
	const panel = document.createElement("div");
	panel.id = "ai";
	panel.innerHTML = `
		<div id="ai-head">${t("AIと地図を描く")}<button id="ai-close" aria-label="${t("閉じる")}">×</button></div>
		<div id="ai-log" aria-live="polite"></div>
		<form id="ai-form">
			<input id="ai-in" type="text" placeholder="${t("何を描く？（例：鉄道を青で）")}" autocomplete="off" spellcheck="false" aria-label="${t("AIへの指示")}">
			<button id="ai-send" aria-label="${t("送る")}">→</button>
		</form>`;
	host.appendChild(panel);
	const logEl = panel.querySelector("#ai-log"), inEl = panel.querySelector("#ai-in"), formEl = panel.querySelector("#ai-form");

	function say(role, text) {
		const b = document.createElement("div");
		b.className = `ai-msg ${role}`; b.textContent = text;
		logEl.appendChild(b); logEl.scrollTop = logEl.scrollHeight;
	}
	function chipRow(items) {   // 候補ボタン＝タイプしなくても指で選べる（小学生の一番の入口）
		const row = document.createElement("div");
		row.className = "ai-chips";
		for (const it of items) {
			const c = document.createElement("button");
			c.type = "button"; c.className = "ai-chip"; c.textContent = it.label;
			c.onclick = () => handle(JSON.stringify({ dataset: it.id }));
			row.appendChild(c);
		}
		logEl.appendChild(row); logEl.scrollTop = logEl.scrollHeight;
	}

	const backend = composeBackends([
		jsonBackend(),
		...(llmUrl ? [httpBackend({ url: llmUrl, model: llmModel })] : []),
		ruleBackend(),
	]);

	// 地名→市区町村コード（e-Stat配信単位）。辞書は public/ai/citycodes.json＝[code, name] の配列、初回だけ取得
	let cityCodes = null;
	async function resolveCodes(area) {
		if (!cityCodes) cityCodes = await fetch(`${assetBase}ai/citycodes.json`).then(r => r.json()).catch(() => []);   // 置き場は app.js の ASSET_BASE（opts.assetBase）から注入
		const q = area.replace(/[のを ]/g, "");
		return cityCodes.filter(([, name]) => name.startsWith(q)).map(([code]) => code).slice(0, 40);
	}

	let pendingDataset = null;   // 「どこの市区町村？」と問い返した直後＝次の入力を地名として受ける
	let busy = false;
	async function handle(text) {
		if (busy || !text.trim()) return;
		say("user", text);
		if (/けして|消して|クリア|やり直し|やりなおし/.test(text)) { clearPlan?.(); pendingDataset = null; say("bot", t("全部消しました。次は何を描きますか？")); return; }
		busy = true; inEl.disabled = true;
		try {
			let spec = await backend.toSpec(text);
			if (pendingDataset && !(spec && typeof spec === "object" && spec.dataset)) spec = { dataset: pendingDataset, area: text.trim() };
			pendingDataset = null;
			const r = interpret(spec ?? {});
			if (!r.ok) {
				pendingDataset = r.needsArea ?? null;
				say("bot", r.narration);
				if (!pendingDataset && r.suggestions?.length) chipRow(r.suggestions);
				return;
			}
			say("bot", [r.narration, ...r.notes.map(n => t("・{0}", n))].join("\n"));
			let plan = r.plan;
			if (plan.route === "estat") {
				const codes = await resolveCodes(plan.area);
				if (!codes.length) { say("bot", t("「{0}」という市区町村が見つかりませんでした。別の書き方で試してみてください。", plan.area)); return; }
				plan = { ...plan, codes };
			}
			// 取り寄せ中の合図（大きいデータの初回DL＋変換は数秒〜数十秒。2回目以降はIDBキャッシュ直行＝出番なし）
			const wait = document.createElement("div");
			wait.className = "ai-msg bot wait";
			wait.textContent = t("データを取りよせています…（初回は時間がかかります。2回目からは速くなります）");
			logEl.appendChild(wait); logEl.scrollTop = logEl.scrollHeight;
			const res = await runPlan(plan).finally(() => wait.remove());
			if (!res?.ok) {
				say("bot", res?.reason === "empty" ? t("その絞り込みでは1つも見つかりませんでした。（全部で{0}件あります）", res.total) : t("データがうまく読み込めませんでした。"));
				return;
			}
			if (plan.camera === "fit" && res.bbox && fitBbox) fitBbox(res.bbox);
			say("bot", t("{0}件 描けました。地図をクリックすると属性が見られます。（出典: {1}）", res.count, plan.legend.attribution));
		} finally { busy = false; inEl.disabled = false; inEl.focus(); }
	}

	formEl.addEventListener("submit", e => { e.preventDefault(); const t = inEl.value; inEl.value = ""; handle(t); }, { signal });
	say("bot", t("こんにちは。地図に何を描いてみますか？ 下のボタンから選ぶか、言葉で教えてください。"));
	chipRow(Object.entries(readyDatasets()).map(([id, d]) => ({ id, label: d.label })));

	function close() {
		panel.remove();
		host.style.display = prev.display; mapEl.style.flex = prev.flex; mapEl.style.width = prev.width;
		clearPlan?.();
	}
	panel.querySelector("#ai-close").onclick = close;
	signal?.addEventListener("abort", close, { once: true });
	return { panel, ask: handle, close };   // ask＝プログラム駆動（テスト・デモ用）
}
