// クイズの芯（DOM なし＝Node の検定で回る）。国の台帳は World（apps/world の NationDB）＝ここでは「平らにした 1 件」を受け取る：
//   { key, iso2, name, nameEn, yomi, capital, capitalEn, region("1".."6"), population, area, un(加盟日|null), territory(key|null), conflict(key|null), flagKey, coord }
// 難易度＝国の知名度（人口・面積・国連加盟）で 3 層に分ける。範囲＝世界か地域（World の REGIONS と同じ番号）。
// 出題＝1 セット 10 問。間違えた国を優先して混ぜる（間隔反復）・最近出た国は避ける＝飽きずに全部を回る。

export const SET_SIZE = 10;
export const CHOICES = 4;
export const LEVELS = [1, 2, 3];
export const REGIONS = ["0", "3", "1", "2", "4", "5", "6"];   // World の並び＝世界・アジア・ヨーロッパ・アフリカ・北米・南米・オセアニア
export const REGION_EN = { "0": "Whole World", "3": "Asia", "1": "Europe", "2": "Africa", "4": "North America", "5": "South America", "6": "Oceania/Antarctica" };
export const MODES = ["capital", "flag", "map"];   // 国名+国旗 → 首都／国旗 ⇄ 国名／地図 → 国名（Lv.3 は国名 → 地図を押す）

// 層分け（知名度）：Lv.1＝国連加盟国のうち人口 1,500 万以上か面積 100 万 km² 以上（約 80）／Lv.2＝国連加盟国で人口 100 万以上（約 160）／Lv.3＝全部（領土・小国・係争地も）
export function tierOf(c) {
	const pop = c.population || 0, area = c.area || 0;
	if (c.un && (pop >= 15e6 || area >= 1e6)) return 1;
	if (c.un && pop >= 1e6) return 2;
	return 3;
}
export const inLevel = (c, level) => tierOf(c) <= level;

// 出題できる国＝そのモードに要る物が揃っている国だけ
export function eligible(c, mode) {
	if (!c || !c.name) return false;
	if (mode === "capital") return !!c.capital;
	if (mode === "flag") return !!c.flagKey && c.flagKey === c.key;   // 領有国の旗で代替している領土は旗のクイズに出さない（同じ旗が 2 枚並ぶ）
	if (mode === "map") return Array.isArray(c.coord) && c.coord.length >= 2;
	return true;
}

export function pool(countries, { mode, level, region = "0" }) {
	return countries.filter(c => eligible(c, mode) && inLevel(c, level) && (region === "0" || c.region === region));
}

// 乱数＝差し替え可（検定は固定の列を渡す）
export const shuffle = (arr, rnd = Math.random) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// 10 問を選ぶ：① 期限の来た「間違えた国」を最大 4 問 ② 最近出た国を避けつつ残りを乱数で（足りなければ最近の国も使う）
export function pickSet(p, { mistakes = {}, recent = [], now = Date.now(), rnd = Math.random, size = SET_SIZE } = {}) {
	const n = Math.min(size, p.length);
	if (!n) return [];
	const byKey = new Map(p.map(c => [c.key, c]));
	const due = Object.entries(mistakes).filter(([k, m]) => byKey.has(k) && (m.due ?? 0) <= now).sort((a, b) => (b[1].wrong || 0) - (a[1].wrong || 0) || (a[1].due || 0) - (b[1].due || 0)).map(([k]) => byKey.get(k));
	const out = shuffle(due, rnd).slice(0, Math.min(4, n));
	const used = new Set(out.map(c => c.key)), rec = new Set(recent);
	const fresh = shuffle(p.filter(c => !used.has(c.key) && !rec.has(c.key)), rnd);
	for (const c of fresh) { if (out.length >= n) break; out.push(c); used.add(c.key); }
	if (out.length < n) for (const c of shuffle(p.filter(c => !used.has(c.key)), rnd)) { if (out.length >= n) break; out.push(c); used.add(c.key); }
	return shuffle(out, rnd);
}

// 選択肢（正解＋3）：Lv.1＝範囲の中から乱数／Lv.2 以上＝同じ地域を優先（似た国で迷わせる）。同じ答えの文字列は避ける（首都が同名・旗が同じ）
export function choicesFor(answer, p, { level, mode, rnd = Math.random, count = CHOICES, all = p }) {
	const label = c => mode === "capital" ? c.capital : mode === "flag" ? c.flagKey : c.name;
	const seen = new Set([label(answer)]), out = [answer];
	const take = list => { for (const c of shuffle(list, rnd)) { if (out.length >= count) return; const l = label(c); if (!l || seen.has(l) || c.key === answer.key) continue; seen.add(l); out.push(c); } };
	const others = p.filter(c => c.key !== answer.key);
	if (level >= 2) take(others.filter(c => c.region === answer.region));
	take(others);
	if (out.length < count) take(all.filter(c => eligible(c, mode) && c.key !== answer.key && !out.includes(c)));   // 範囲が狭い（例：南米 Lv.1）時は外からも
	return shuffle(out, rnd);
}

// 1 問の形。kind＝画面の見せ方（capital: 国名+旗 → 首都の文字／flag: 旗 → 国名の文字／name: 国名 → 旗の絵／map: 地図 → 国名の文字／tap: 国名 → 地図を押す）
export function makeQuestion(answer, p, { mode, level, rnd = Math.random, all = p, index = 0 }) {
	let kind = mode;
	if (mode === "flag") kind = index % 2 ? "name" : "flag";           // 旗 → 国名と国名 → 旗を交互に
	if (mode === "map" && level >= 3) kind = "tap";
	const choices = kind === "tap" ? [] : choicesFor(answer, p, { level, mode, rnd, all });
	return { kind, answer, choices };
}

export function buildSet(countries, opts, state = {}) {
	const p = pool(countries, opts);
	const picked = pickSet(p, state);
	return picked.map((c, i) => makeQuestion(c, p, { ...opts, rnd: state.rnd, all: countries, index: i }));
}

// 採点：星＝正答率（10 問中 10→3・8 以上→2・5 以上→1・それ未満→0）
export function stars(correct, total) {
	if (!total) return 0;
	const r = correct / total;
	return r >= 1 ? 3 : r >= 0.8 ? 2 : r >= 0.5 ? 1 : 0;
}

// 間隔反復の更新：間違い＝すぐ次のセットから出る（due=今）・正解＝次に出るまでの間を倍々に伸ばす（1 日→2 日→4 日…）、3 回続けて正解なら忘れる
export function updateMistake(m, correct, now = Date.now()) {
	const DAY = 86400e3;
	if (!correct) return { wrong: (m?.wrong || 0) + 1, streak: 0, due: now, last: now };
	const streak = (m?.streak || 0) + 1;
	if (streak >= 3) return null;
	return { wrong: m?.wrong || 0, streak, due: now + DAY * 2 ** (streak - 1), last: now };
}

// 読みの振り方（ja）：先頭が漢字の名前（日本・中国・南アフリカ…）だけ読みを添える。カナで始まる名前はそのまま
export const needsRuby = (name, yomi) => !!yomi && !!name && yomi !== name && !/^[ァ-ヶーぁ-ん]/.test(name) && /[一-鿿]/.test(name);

// 人口を「約 1 億 2,500 万人」のように子供向けに丸める（言語に依らない数値部分だけ。単位は呼び手が t() で付ける）
export function roundPopulation(n) {
	if (!n) return null;
	const digits = Math.floor(Math.log10(n));
	const unit = 10 ** Math.max(0, digits - 2);   // 上 3 桁
	return Math.round(n / unit) * unit;
}
