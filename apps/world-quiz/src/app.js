// 世界クイズの頁の中身（2026-10-08・Kenji「World の国名・国旗・首都・地図データで教育用のクイズ」）。
//   始めの面＝モード（国名+国旗 → 首都／国旗 ⇄ 国名／地図 ⇄ 国名）・難易度 3 段・範囲（世界／6 地域）・これまでの記録。
//   問題の面＝10 問。選ぶ→その場で○×→正解の国へ地球儀が寄る→ひとこと（首都・人口）→次へ。Lv.3 の地図モードは地球儀を押して答える。
//   結果の面＝正答率・星・時間・最高記録・連続正解・バッジ・間違えた国（もう一度）。
//   覚える工夫＝間違えた国を次のセットに優先して混ぜる（間隔反復）・最近出た国は避ける・図鑑（正解した国の数）・星とバッジは localStorage。
import { tr, getLang, LANGUAGES } from "@ortho-earth/globe/i18n.js";
import { loadCountries, flagURL } from "./data.js";
import { buildSet, makeQuestion, pool, eligible, stars, needsRuby, roundPopulation, REGIONS, REGION_EN, LEVELS, MODES, SET_SIZE } from "./quiz.js";
import { createProgress, BADGES } from "./progress.js";
import { sfx } from "./sound.js";

const t = tr();
const el = (tag, attrs = {}, ...kids) => {
	const e = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) { if (v == null || v === false) continue; if (k === "class") e.className = v; else if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else if (k === "html") e.innerHTML = v; else if (k === "text") e.textContent = v; else e.setAttribute(k, v === true ? "" : v); }
	for (const k of kids.flat()) if (k != null) e.append(k);
	return e;
};
const MODE_ICON = { capital: "🏛️", flag: "🚩", map: "🌍" };
const LEVEL_ICON = { 1: "🌱", 2: "🌿", 3: "🌳" };
const BADGE_ICON = { "first-set": "🎒", perfect: "💯", "streak-10": "🔥", "sets-10": "🔟", "sets-50": "🏅", "all-modes": "🧭", "collector-50": "📗", "collector-100": "📘", "region-master": "👑" };
const fmtMs = ms => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const numLocale = lang => ({ zh: "zh-CN", pt: "pt-BR", ar: "ar-EG", bn: "bn-BD" })[lang] || lang;

export async function mountApp(root) {
	const lang = getLang();
	const q = new URLSearchParams(location.search);
	const P = createProgress();
	// 人口は「1.2億」「50M」のように短く（子供向け・Intl の compact）。数字はラテン＝言語をまたいで比べやすく
	const fmtInt = n => { try { return new Intl.NumberFormat(numLocale(lang), { numberingSystem: "latn", notation: "compact", maximumFractionDigits: 1 }).format(n); } catch { return String(n); } };
	const { countries, regionName } = await loadCountries(lang);
	const byKey = new Map(countries.map(c => [c.key, c]));
	const S = {
		mode: MODES.includes(q.get("mode")) ? q.get("mode") : "flag",
		level: LEVELS.includes(+q.get("level")) ? +q.get("level") : 1,
		region: REGIONS.includes(q.get("region")) ? q.get("region") : "0",
		set: null, i: 0, correct: 0, t0: 0, wrong: [], answered: false, mapView: null, mapWanted: !q.has("nomap"),
	};
	const modeName = m => m === "capital" ? t("Country & flag → capital") : m === "flag" ? t("Flag ⇄ country") : t("Map ⇄ country");
	const levelName = l => l === 1 ? t("Level 1 · Starter") : l === 2 ? t("Level 2 · Explorer") : t("Level 3 · Expert");
	const badgeName = b => ({ "first-set": t("First quiz"), perfect: t("Perfect 10"), "streak-10": t("10 in a row"), "sets-10": t("10 quizzes"), "sets-50": t("50 quizzes"), "all-modes": t("Tried every mode"), "collector-50": t("50 countries learned"), "collector-100": t("100 countries learned"), "region-master": t("Region master") })[b] || b;
	const nameOf = c => { const e = el("span", { class: "q-name" }); if (lang === "ja" && needsRuby(c.name, c.yomi)) e.append(el("ruby", {}, c.name, el("rt", { text: c.yomi }))); else e.textContent = c.name; return e; };
	const flagImg = (c, cls = "") => el("img", { class: `q-flag ${cls}`, src: flagURL(c.flagKey || c.key), alt: "", loading: "eager", draggable: "false" });
	const play = f => { if (P.state.sound) sfx[f]?.(); };

	// ---- 骨組み ----
	const header = el("header", { class: "q-bar" },
		el("h1", { class: "q-brand", onclick: () => showHome() }, "🌏 ", el("span", { text: t("World quiz") })),
		el("div", { class: "q-tools" },
			el("button", { type: "button", class: "q-icon", id: "sound", title: t("Sound"), "aria-label": t("Sound"), text: P.state.sound ? "🔊" : "🔇", onclick: e => { P.setSound(!P.state.sound); e.currentTarget.textContent = P.state.sound ? "🔊" : "🔇"; play("tap"); } }),
			(() => { const s = el("select", { id: "lang", "aria-label": t("Change language"), title: t("Change language") }, LANGUAGES.map(l => el("option", { value: l.code, text: l.name, selected: l.code === lang })));
				s.addEventListener("change", () => { const u = new URL(location.href); u.searchParams.set("lang", s.value); location.href = u.href; }); return s; })()));
	const home = el("main", { id: "view-home", class: "q-home" });
	const play_ = el("main", { id: "view-quiz", class: "q-quiz", hidden: true });
	const result = el("main", { id: "view-result", class: "q-result", hidden: true });
	const mapHost = el("div", { id: "map", class: "q-map" });
	const mapWrap = el("aside", { class: "q-map-wrap", hidden: true }, mapHost, el("div", { class: "q-map-hint", hidden: true }));
	root.replaceChildren(header, el("div", { class: "q-body" }, el("div", { class: "q-main" }, home, play_, result), mapWrap));

	// ---- 始めの面 ----
	function showHome() {
		clearInterval(timer); clearTimeout(advance);
		S.set = null; mapWrap.hidden = true; S.mapView?.clear();
		play_.hidden = result.hidden = true; home.hidden = false;
		const seg = (items, cur, set, render) => el("div", { class: "q-seg", role: "radiogroup" }, items.map(v => el("button", { type: "button", role: "radio", "aria-checked": String(v === cur), class: v === cur ? "on" : "", onclick: () => { set(v); play("tap"); showHome(); } }, render(v))));
		const poolN = pool(countries, { mode: S.mode, level: S.level, region: S.region }).length;
		const best = P.bestFor(S.mode, S.level, S.region);
		const due = P.mistakeKeys().filter(k => P.isDue(k) && byKey.has(k)).length;
		home.replaceChildren(
			el("section", { class: "q-card q-pick" },
				el("h2", { text: t("What do you want to practice?") }),
				el("div", { class: "q-modes" }, MODES.map(m => el("button", { type: "button", class: `q-mode ${m === S.mode ? "on" : ""}`, "aria-pressed": String(m === S.mode), onclick: () => { S.mode = m; play("tap"); showHome(); } },
					el("span", { class: "q-mode-icon", text: MODE_ICON[m] }), el("span", { class: "q-mode-name", text: modeName(m) }),
					el("small", { text: m === "capital" ? t("See a country and its flag, pick the capital.") : m === "flag" ? t("See a flag, pick the country — and the other way round.") : t("See a country lit up on the globe, pick its name. Level 3: find it on the globe yourself.") })))),
				el("h3", { text: t("Level") }),
				seg(LEVELS, S.level, v => S.level = v, v => [el("span", { text: LEVEL_ICON[v] + " " }), el("span", { text: levelName(v) })]),
				el("p", { class: "q-muted", text: S.level === 1 ? t("Big, well-known countries. Choices come from anywhere.") : S.level === 2 ? t("Most countries. Choices come from the same region.") : t("Every country and territory, small ones too.") }),
				el("h3", { text: t("Where?") }),
				seg(REGIONS, S.region, v => S.region = v, v => el("span", { text: regionName(REGION_EN[v]) })),
				el("p", { class: "q-muted", text: t("$1 countries in this set", poolN) }),
				el("button", { type: "button", class: "q-start", disabled: poolN < 2, onclick: () => startSet(), text: t("Start! ($1 questions)", Math.min(SET_SIZE, poolN)) }),
				due ? el("button", { type: "button", class: "q-start q-review", onclick: () => startSet({ review: true }), text: t("Review the $1 countries you missed", due) }) : null,
				best ? el("p", { class: "q-muted", text: t("Your best here: $1 / $2 in $3", best.correct, best.total, fmtMs(best.ms)) }) : null),
			el("section", { class: "q-card q-stats" },
				el("h2", { text: t("Your progress") }),
				el("div", { class: "q-tiles" },
					tile("📗", t("Countries learned"), `${Object.values(P.state.seen).filter(s => s.ok > 0).length} / ${countries.filter(c => c.name).length}`),
					tile("🧩", t("Quizzes played"), String(P.state.sets)),
					tile("🔥", t("Best streak"), String(P.state.bestStreak)),
					tile("✅", t("Correct answers"), P.state.totalAnswered ? `${Math.round(100 * P.state.totalCorrect / P.state.totalAnswered)}%` : "–")),
				el("h3", { text: t("Badges") }),
				el("div", { class: "q-badges" }, BADGES.map(b => el("span", { class: `q-badge ${P.state.badges.includes(b) ? "got" : ""}`, title: badgeName(b) }, el("span", { class: "q-badge-icon", text: BADGE_ICON[b] }), el("span", { class: "q-badge-name", text: badgeName(b) })))),
				el("p", { class: "q-muted q-small", text: t("Scores and badges are kept on this device only.") }),
				el("button", { type: "button", class: "q-link", onclick: () => { if (confirm(t("Erase all scores and badges on this device?"))) { P.reset(); showHome(); } }, text: t("Start over") })),
		);
		const u = new URL(location.href); u.searchParams.set("mode", S.mode); u.searchParams.set("level", String(S.level)); S.region === "0" ? u.searchParams.delete("region") : u.searchParams.set("region", S.region); history.replaceState(null, "", u);
	}
	const tile = (icon, label, value) => el("div", { class: "q-tile" }, el("span", { class: "q-tile-icon", text: icon }), el("strong", { text: value }), el("small", { text: label }));

	// ---- 問題の面 ----
	let timer = 0, advance = 0;
	async function startSet({ review = false, keys = null } = {}) {
		const opts = { mode: S.mode, level: S.level, region: S.region };
		let set;
		// 決まった国だけ出す（間違えた国のやり直し・期限の来た復習）：選択肢は Lv.2 以上の裁き（同じ地域から）・範囲は世界
		const fixed = list => { const lv = Math.max(S.level, 2), p = pool(countries, { mode: S.mode, level: 3, region: "0" });
			return list.map(k => byKey.get(k)).filter(c => c && eligible(c, S.mode)).slice(0, SET_SIZE).map((c, i) => makeQuestion(c, p, { mode: S.mode, level: lv, all: countries, index: i })); };
		if (keys) set = fixed(keys);
		else if (review) set = fixed(P.mistakeKeys().filter(k => P.isDue(k)).sort((a, b) => (P.state.mistakes[b].wrong || 0) - (P.state.mistakes[a].wrong || 0)));
		else set = buildSet(countries, opts, { mistakes: P.state.mistakes, recent: P.state.recent });
		if (!set.length) return;
		Object.assign(S, { set, i: 0, correct: 0, wrong: [], t0: performance.now(), review });
		home.hidden = result.hidden = true; play_.hidden = false;
		mapWrap.hidden = !S.mapWanted; if (S.mapWanted) ensureMap();
		clearInterval(timer); timer = setInterval(() => { const e = play_.querySelector(".q-time"); if (e) e.textContent = fmtMs(performance.now() - S.t0); }, 500);
		play("tap");
		renderQuestion();
	}
	function ensureMap() {
		if (S.mapView !== null) return Promise.resolve(S.mapView);
		return import("./mapview.js").then(m => m.createMapView(mapHost, { lang })).then(v => { S.mapView = v || false; if (!v) mapWrap.hidden = true; else v.resize?.(); return S.mapView; });
	}
	function renderQuestion() {
		clearTimeout(advance);
		const Q = S.set[S.i], c = Q.answer; S.answered = false;
		S.mapView?.clear?.();
		const hint = mapWrap.querySelector(".q-map-hint"); hint.hidden = true;
		const head = el("div", { class: "q-head" },
			el("span", { class: "q-count", text: t("Question $1 of $2", S.i + 1, S.set.length) }),
			el("span", { class: "q-dots" }, S.set.map((_, k) => el("i", { class: k < S.i ? (S.wrong.some(w => w.key === S.set[k].answer.key) ? "ng" : "ok") : k === S.i ? "now" : "" }))),
			el("span", { class: "q-time", text: fmtMs(performance.now() - S.t0) }),
			el("button", { type: "button", class: "q-quit", onclick: () => { clearInterval(timer); showHome(); }, text: t("Quit") }));
		const prompt = el("div", { class: `q-prompt q-${Q.kind}` });
		const choices = el("div", { class: `q-choices ${Q.kind === "name" ? "flags" : ""}`, role: "group" });
		if (Q.kind === "capital") prompt.append(flagImg(c, "big"), el("h2", {}, nameOf(c)), el("p", { class: "q-ask", text: t("What is the capital?") }));
		else if (Q.kind === "flag") prompt.append(flagImg(c, "big"), el("p", { class: "q-ask", text: t("Whose flag is this?") }));
		else if (Q.kind === "name") prompt.append(el("h2", {}, nameOf(c)), el("p", { class: "q-ask", text: t("Which flag is this country's?") }));
		else if (Q.kind === "map") prompt.append(el("p", { class: "q-ask q-ask-map", text: t("Which country is lit up on the globe?") }));
		else prompt.append(flagImg(c, "big"), el("h2", {}, nameOf(c)), el("p", { class: "q-ask", text: t("Tap this country on the globe.") }));
		Q.choices.forEach((o, k) => choices.append(el("button", { type: "button", class: "q-choice", "data-key": o.key, onclick: () => answer(o), "aria-keyshortcuts": String(k + 1) },
			el("kbd", { text: String(k + 1) }),
			Q.kind === "name" ? flagImg(o, "choice") : Q.kind === "capital" ? el("span", { class: "q-choice-text", text: o.capital }) : nameOf(o))));
		const fact = el("div", { class: "q-fact", hidden: true });
		const next = el("button", { type: "button", class: "q-next", hidden: true, onclick: () => nextQuestion(), text: S.i + 1 < S.set.length ? t("Next →") : t("See the result") });
		play_.replaceChildren(head, prompt, choices, fact, next);
		if (Q.kind === "map" || Q.kind === "tap") {
			mapWrap.hidden = false;
			ensureMap().then(async v => {
				if (!v || S.set[S.i] !== Q) return;
				if (Q.kind === "map") await v.focus(c, { pad: S.level === 1 ? 3 : 2 });   // Lv.1 は引いて見せる（周りの国で分かる）
				else {
					v.region(S.region === "0" ? regionOf(c) : S.region); hint.hidden = false; hint.textContent = t("Loading the map…");
					const armed = await v.arm((key, ll) => tapAnswer(key, ll));
					if (S.set[S.i] !== Q) return;
					if (armed) hint.textContent = t("Tap the country"); else { hint.hidden = true; fallbackTap(Q); }   // 国の形が読めない＝選択肢の問に落とす
				}
			}).catch(() => { if (S.set[S.i] === Q && Q.kind === "tap") fallbackTap(Q); });
			if (S.mapView === false && Q.kind === "tap") fallbackTap(Q);
		}
	}
	const regionOf = c => c.region;
	// 地図が無い環境で Lv.3 の地図モードに来た＝選択肢の問に落とす
	function fallbackTap(Q) { Object.assign(Q, makeQuestion(Q.answer, pool(countries, { mode: "map", level: 3, region: S.region }), { mode: "map", level: 2, all: countries })); renderQuestion(); }
	function tapAnswer(key, lngLat) {
		if (S.answered) return;
		const Q = S.set[S.i], a = Q.answer, hit = key ? byKey.get(key) : null;
		const ok = !!hit && (hit.key === a.key || hit.territory === a.key || a.territory === hit.key);
		S.mapView?.disarm(); S.mapView?.mark(key, lngLat);
		judge(ok, hit);
	}
	function answer(o) {
		if (S.answered) return;
		const Q = S.set[S.i], ok = o.key === Q.answer.key;
		for (const b of play_.querySelectorAll(".q-choice")) { b.disabled = true; if (b.dataset.key === Q.answer.key) b.classList.add("ok"); else if (b.dataset.key === o.key) b.classList.add("ng"); }
		judge(ok, o);
	}
	function judge(ok, picked) {
		const Q = S.set[S.i], c = Q.answer; S.answered = true;
		const streak = P.answer(c.key, ok);
		if (ok) S.correct++; else S.wrong.push(c);
		play(ok ? "correct" : "wrong");
		const fact = play_.querySelector(".q-fact"), next = play_.querySelector(".q-next");
		const verdict = el("div", { class: `q-verdict ${ok ? "ok" : "ng"}`, text: ok ? (streak >= 3 ? t("Correct! $1 in a row!", streak) : t("Correct!")) : t("Not quite. The answer is…") });
		const pop = roundPopulation(c.population);
		fact.replaceChildren(verdict,
			el("div", { class: "q-fact-card" }, flagImg(c, "small"), el("div", {},
				el("strong", {}, nameOf(c)),
				el("div", { class: "q-fact-row", text: c.capital ? t("Capital: $1", c.capital) : "" }),
				el("div", { class: "q-fact-row", text: [regionName(REGION_EN[c.region] || ""), pop ? t("Population: about $1", fmtInt(pop)) : null].filter(Boolean).join(" · ") }),
				!ok && picked && picked.key !== c.key ? el("div", { class: "q-fact-row q-muted", text: Q.kind === "capital" ? t("$1 is the capital of $2", picked.capital, picked.name) : t("You picked $1", picked.name) }) : null)));
		fact.hidden = false; next.hidden = false; next.focus();
		if (S.mapWanted && Q.kind !== "map") { mapWrap.hidden = false; ensureMap().then(v => v && S.set[S.i] === Q && v.focus(c, { pad: Q.kind === "tap" ? 2 : 1.8, keepMark: Q.kind === "tap" })); }   // 押した所の赤い印は残す＝正解と見比べる
		if (ok && Q.kind !== "tap") advance = setTimeout(() => S.set[S.i] === Q && S.answered && nextQuestion(), 1600);   // 正解はテンポよく次へ（間違いは見て覚える＝押すまで待つ）
	}
	function nextQuestion() {
		clearTimeout(advance);
		if (++S.i >= S.set.length) return showResult();
		renderQuestion();
	}
	addEventListener("keydown", e => {
		if (e.target.closest?.("button, select, input")) return;   // ボタンの上の Enter はボタン自身が受ける（二重に進めない）
		if (play_.hidden || S.answered) { if (!play_.hidden && S.answered && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); nextQuestion(); } return; }
		const n = +e.key; if (n >= 1 && n <= 4) { const b = play_.querySelectorAll(".q-choice")[n - 1]; b && !b.disabled && b.click(); }
	});

	// ---- 結果の面 ----
	function showResult() {
		clearInterval(timer);
		const ms = performance.now() - S.t0, total = S.set.length, n = S.correct, st = stars(n, total);
		const p = pool(countries, { mode: S.mode, level: S.level, region: S.region });
		const r = S.review ? { got: [], best: null, isBest: false } : P.finish({ mode: S.mode, level: S.level, region: S.region, correct: n, total, ms, poolKeys: p.map(c => c.key) });
		play(st === 3 ? "fanfare" : "correct"); if (r.got.length) setTimeout(() => play("badge"), 700);
		play_.hidden = true; result.hidden = false; mapWrap.hidden = !S.mapWanted || S.mapView === false;
		result.replaceChildren(
			el("section", { class: "q-card q-score" },
				el("div", { class: "q-stars", "aria-label": t("$1 of 3 stars", st) }, [1, 2, 3].map(k => el("span", { class: k <= st ? "lit" : "", text: "★" }))),
				el("h2", { text: st === 3 ? t("Perfect!") : st === 2 ? t("Great job!") : st === 1 ? t("Nice try!") : t("Keep going!") }),
				el("p", { class: "q-big", text: t("$1 / $2 correct", n, total) }),
				el("p", { class: "q-muted", text: t("Time: $1", fmtMs(ms)) + (r.isBest ? " · " + t("New best!") : r.best ? " · " + t("Best: $1 / $2 in $3", r.best.correct, r.best.total, fmtMs(r.best.ms)) : "") }),
				el("p", { class: "q-muted", text: `${modeName(S.mode)} · ${levelName(S.level)} · ${regionName(REGION_EN[S.region])}` }),
				r.got.length ? el("div", { class: "q-new-badges" }, el("h3", { text: t("New badge!") }), r.got.map(b => el("span", { class: "q-badge got" }, el("span", { class: "q-badge-icon", text: BADGE_ICON[b] }), el("span", { class: "q-badge-name", text: badgeName(b) })))) : null,
				el("div", { class: "q-actions" },
					el("button", { type: "button", class: "q-start", onclick: () => startSet(), text: t("Play again") }),
					S.wrong.length ? el("button", { type: "button", class: "q-start q-review", onclick: () => startSet({ keys: S.wrong.map(c => c.key) }), text: t("Retry the $1 you missed", S.wrong.length) }) : null,
					el("button", { type: "button", class: "q-link", onclick: () => showHome(), text: t("Back to start") }))),
			S.wrong.length ? el("section", { class: "q-card" }, el("h3", { text: t("Remember these") }), el("ul", { class: "q-missed" }, S.wrong.map(c => el("li", { onclick: () => S.mapView?.focus(c, { pad: 1.8 }) }, flagImg(c, "small"), el("span", {}, nameOf(c), c.capital ? el("small", { text: " · " + c.capital }) : null))))) : null,
			el("section", { class: "q-card q-muted q-small", text: t("Country data: ortho-earth World database (Natural Earth, Wikidata, UN). Flags: Wikimedia Commons.") }));
		if (S.wrong.length) S.mapView?.focus(S.wrong[0], { pad: 1.8 });
	}

	if (q.has("start")) startSet(); else showHome();
	return S;
}
