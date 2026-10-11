// 進捗の保存（localStorage）：星・最高記録・連続正解・間違えた国（間隔反復）・最近出た国・集めた国（図鑑）・バッジ。
// storage は差し替え可（Node の検定は Map もどきを渡す）。壊れていれば空から始める＝子供の端末で止まらない。
import { updateMistake } from "./quiz.js";

export const STORE_KEY = "world-quiz.v1";
export const BADGES = ["first-set", "perfect", "streak-10", "sets-10", "sets-50", "all-modes", "collector-50", "collector-100", "region-master"];

const empty = () => ({ sets: 0, totalCorrect: 0, totalAnswered: 0, streak: 0, bestStreak: 0, best: {}, mistakes: {}, recent: [], seen: {}, modes: {}, badges: [], regionsMastered: [], sound: true });

export function createProgress(storage = globalThis.localStorage) {
	const read = () => { try { const v = JSON.parse(storage?.getItem(STORE_KEY) || "null"); return v && typeof v === "object" ? { ...empty(), ...v } : empty(); } catch { return empty(); } };
	const S = read();
	const save = () => { try { storage?.setItem(STORE_KEY, JSON.stringify(S)); } catch { /* private mode＝持たないだけ */ } };
	const bestKey = (mode, level, region) => `${mode}/${level}/${region}`;
	return {
		state: S, save,
		bestFor: (mode, level, region) => S.best[bestKey(mode, level, region)] || null,
		isDue: key => !!S.mistakes[key] && (S.mistakes[key].due ?? 0) <= Date.now(),
		mistakeKeys: () => Object.keys(S.mistakes),
		seenCount: () => Object.keys(S.seen).length,
		/** 1 問の結果を記す（連続正解・間違いの台帳・図鑑） */
		answer(key, correct, now = Date.now()) {
			S.totalAnswered++; if (correct) S.totalCorrect++;
			S.streak = correct ? S.streak + 1 : 0; S.bestStreak = Math.max(S.bestStreak, S.streak);
			const m = updateMistake(S.mistakes[key], correct, now);
			if (m) S.mistakes[key] = m; else delete S.mistakes[key];
			const s = S.seen[key] || (S.seen[key] = { ok: 0, ng: 0 }); correct ? s.ok++ : s.ng++;
			S.recent = [key, ...S.recent.filter(k => k !== key)].slice(0, 40);
			save();
			return S.streak;
		},
		/** セット終了：最高記録と回数・バッジ。戻り＝新しく得たバッジの一覧。poolKeys＝この範囲（モード/レベル/地域）の全国＝地域マスターの判定に使う */
		finish({ mode, level, region, correct, total, ms, poolKeys = [] }) {
			S.sets++; (S.modes[mode] = (S.modes[mode] || 0) + 1);
			const k = bestKey(mode, level, region), prev = S.best[k];
			const better = !prev || correct > prev.correct || (correct === prev.correct && ms < prev.ms);
			if (better) S.best[k] = { correct, total, ms, at: Date.now() };
			const got = [];
			const give = b => { if (!S.badges.includes(b)) { S.badges.push(b); got.push(b); } };
			give("first-set");
			if (correct === total && total >= 10) give("perfect");
			if (S.bestStreak >= 10) give("streak-10");
			if (S.sets >= 10) give("sets-10");
			if (S.sets >= 50) give("sets-50");
			if (["capital", "flag", "map"].every(m => S.modes[m])) give("all-modes");
			const collected = Object.values(S.seen).filter(s => s.ok > 0).length;
			if (collected >= 50) give("collector-50");
			if (collected >= 100) give("collector-100");
			if (region !== "0" && poolKeys.length && poolKeys.every(k => S.seen[k]?.ok > 0)) { const rk = `${region}/${level}`; if (!S.regionsMastered.includes(rk)) S.regionsMastered.push(rk); give("region-master"); }
			save();
			return { got, best: S.best[k], isBest: better };
		},
		setSound(on) { S.sound = !!on; save(); },
		reset() { Object.assign(S, empty()); save(); },
	};
}
