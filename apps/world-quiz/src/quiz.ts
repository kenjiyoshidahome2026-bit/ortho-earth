// クイズの芯（DOM なし＝Node の検定で回る）。国の台帳は World（apps/world の NationDB）＝ここでは「平らにした 1 件」を受け取る：
//   { key, iso2, name, nameEn, capital, capitalEn, region("1".."6"), population, area, un(加盟日|null), territory(key|null), conflict(key|null), flagKey, coord }
// 難易度＝国の知名度（人口・面積・国連加盟）で 3 層に分ける。範囲＝世界か地域（World の REGIONS と同じ番号）。
// 出題＝1 セット 10 問。間違えた国を優先して混ぜる（間隔反復）・最近出た国は避ける＝飽きずに全部を回る。

/** 平らにした国の 1 件（data.ts の loadCountries が作る・検定は一部の欄だけ渡す） */
export interface QuizCountry {
	key: string; iso2: string; qid?: string; name: string; nameEn: string; capital: string; capitalEn: string; capitalCoord?: number[] | null;
	region: string; population: number; area: number; un: unknown; territory: string | null; conflict: string | null; flagKey: string | null; coord: number[] | null; wiki?: string[] | null;
}
/** 間違いの台帳の 1 件（間隔反復） */
export interface Mistake { wrong: number; streak: number; due: number; last: number }
/** 1 問（kind＝見せ方・choices＝選択肢・tap は空） */
export interface Question { kind: string; answer: QuizCountry; choices: QuizCountry[] }
export interface SetOpts { mode: string; level: number; region?: string }
export interface PickState { mistakes?: Record<string, Partial<Mistake>>; recent?: string[]; now?: number; rnd?: () => number; size?: number }

export const SET_SIZE = 10;
export const CHOICES = 4;
export const LEVELS = [1, 2, 3];
export const REGIONS = ["0", "3", "1", "2", "4", "5", "6"];   // World の並び＝世界・アジア・ヨーロッパ・アフリカ・北米・南米・オセアニア
export const REGION_EN: Record<string, string> = { "0": "Whole World", "3": "Asia", "1": "Europe", "2": "Africa", "4": "North America", "5": "South America", "6": "Oceania/Antarctica" };
export const MODES = ["capital", "flag", "map"];   // 国名+国旗 → 首都／国旗 ⇄ 国名／地図 → 国名（Lv.3 は国名 → 地図を押す）

// 層分け（知名度）：Lv.1＝国連加盟国のうち人口 1,500 万以上か面積 100 万 km² 以上（約 80）／Lv.2＝国連加盟国で人口 100 万以上（約 160）／Lv.3＝全部（領土・小国・係争地も）
export function tierOf(c: QuizCountry): number {
	const pop = c.population || 0, area = c.area || 0;
	if (c.un && (pop >= 15e6 || area >= 1e6)) return 1;
	if (c.un && pop >= 1e6) return 2;
	return 3;
}
export const inLevel = (c: QuizCountry, level: number): boolean => tierOf(c) <= level;

// 出題できる国＝そのモードに要る物が揃っている国だけ
export function eligible(c: QuizCountry | null | undefined, mode: string): boolean {
	if (!c || !c.name) return false;
	if (mode === "capital") return !!c.capital;
	if (mode === "flag") return !!c.flagKey && c.flagKey === c.key;   // 領有国の旗で代替している領土は旗のクイズに出さない（同じ旗が 2 枚並ぶ）
	if (mode === "map") return Array.isArray(c.coord) && c.coord.length >= 2;
	return true;
}

export function pool(countries: QuizCountry[], { mode, level, region = "0" }: SetOpts): QuizCountry[] {
	return countries.filter(c => eligible(c, mode) && inLevel(c, level) && (region === "0" || c.region === region));
}

// 乱数＝差し替え可（検定は固定の列を渡す）
export const shuffle = <T>(arr: T[], rnd: () => number = Math.random): T[] => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// 10 問を選ぶ：① 期限の来た「間違えた国」を最大 4 問 ② 最近出た国を避けつつ残りを乱数で（足りなければ最近の国も使う）
export function pickSet(p: QuizCountry[], { mistakes = {}, recent = [], now = Date.now(), rnd = Math.random, size = SET_SIZE }: PickState = {}): QuizCountry[] {
	const n = Math.min(size, p.length);
	if (!n) return [];
	const byKey = new Map(p.map(c => [c.key, c]));
	const due = Object.entries(mistakes).filter(([k, m]) => byKey.has(k) && (m.due ?? 0) <= now).sort((a, b) => (b[1].wrong || 0) - (a[1].wrong || 0) || (a[1].due || 0) - (b[1].due || 0)).map(([k]) => byKey.get(k)!);
	const out = shuffle(due, rnd).slice(0, Math.min(4, n));
	const used = new Set(out.map(c => c.key)), rec = new Set(recent);
	const fresh = shuffle(p.filter(c => !used.has(c.key) && !rec.has(c.key)), rnd);
	for (const c of fresh) { if (out.length >= n) break; out.push(c); used.add(c.key); }
	if (out.length < n) for (const c of shuffle(p.filter(c => !used.has(c.key)), rnd)) { if (out.length >= n) break; out.push(c); used.add(c.key); }
	return shuffle(out, rnd);
}

// 選択肢（正解＋3）：Lv.1＝範囲の中から乱数／Lv.2 以上＝同じ地域を優先（似た国で迷わせる）。同じ答えの文字列は避ける（首都が同名・旗が同じ）
export function choicesFor(answer: QuizCountry, p: QuizCountry[], { level, mode, rnd = Math.random, count = CHOICES, all = p }: { level: number; mode: string; rnd?: () => number; count?: number; all?: QuizCountry[] }): QuizCountry[] {
	const label = (c: QuizCountry): string | null => mode === "capital" ? c.capital : mode === "flag" ? c.flagKey : c.name;
	const seen = new Set([label(answer)]), out = [answer];
	const take = (list: QuizCountry[]): void => { for (const c of shuffle(list, rnd)) { if (out.length >= count) return; const l = label(c); if (!l || seen.has(l) || c.key === answer.key) continue; seen.add(l); out.push(c); } };
	const others = p.filter(c => c.key !== answer.key);
	if (level >= 2) take(others.filter(c => c.region === answer.region));
	take(others);
	if (out.length < count) take(all.filter(c => eligible(c, mode) && c.key !== answer.key && !out.includes(c)));   // 範囲が狭い（例：南米 Lv.1）時は外からも
	return shuffle(out, rnd);
}

// 1 問の形。kind＝画面の見せ方（capital: 国名+旗 → 首都の文字／flag: 旗 → 国名の文字／name: 国名 → 旗の絵／map: 地図 → 国名の文字／tap: 国名 → 地図を押す）
export function makeQuestion(answer: QuizCountry, p: QuizCountry[], { mode, level, rnd = Math.random, all = p, index = 0 }: { mode: string; level: number; rnd?: () => number; all?: QuizCountry[]; index?: number }): Question {
	let kind = mode;
	if (mode === "flag") kind = index % 2 ? "name" : "flag";           // 旗 → 国名と国名 → 旗を交互に
	if (mode === "map" && level >= 3) kind = "tap";
	const choices = kind === "tap" ? [] : choicesFor(answer, p, { level, mode, rnd, all });
	return { kind, answer, choices };
}

export function buildSet(countries: QuizCountry[], opts: SetOpts, state: PickState = {}): Question[] {
	const p = pool(countries, opts);
	const picked = pickSet(p, state);
	return picked.map((c, i) => makeQuestion(c, p, { ...opts, rnd: state.rnd, all: countries, index: i }));
}

// 採点：星＝正答率（10 問中 10→3・8 以上→2・5 以上→1・それ未満→0）
export function stars(correct: number, total: number): number {
	if (!total) return 0;
	const r = correct / total;
	return r >= 1 ? 3 : r >= 0.8 ? 2 : r >= 0.5 ? 1 : 0;
}

// 間隔反復の更新：間違い＝すぐ次のセットから出る（due=今）・正解＝次に出るまでの間を倍々に伸ばす（1 日→2 日→4 日…）、3 回続けて正解なら忘れる
export function updateMistake(m: Partial<Mistake> | null | undefined, correct: boolean, now = Date.now()): Mistake | null {
	const DAY = 86400e3;
	if (!correct) return { wrong: (m?.wrong || 0) + 1, streak: 0, due: now, last: now };
	const streak = (m?.streak || 0) + 1;
	if (streak >= 3) return null;
	return { wrong: m?.wrong || 0, streak, due: now + DAY * 2 ** (streak - 1), last: now };
}


// 人口を「約 1 億 2,500 万人」のように子供向けに丸める（言語に依らない数値部分だけ。単位は呼び手が t() で付ける）
export function roundPopulation(n: number): number | null {
	if (!n) return null;
	const digits = Math.floor(Math.log10(n));
	const unit = 10 ** Math.max(0, digits - 2);   // 上 3 桁
	return Math.round(n / unit) * unit;
}

// 「地図を押して当てる」の押し損ねを救う（Kenji 2026-10-12「シンガポール、マカオみたいな小さい国がクリックしづらい」）。
//   reachOf＝押した点から国の形までの画面上の最短距離（px）と、国の画面上の大きさ（外接箱の長辺 px）。project(lon,lat)→[x,y,front]（front≤0＝裏半球で数えない）。
//   tapHits＝面の中なら正解。外れても形から TAP_SLOP px 以内なら正解＝海を押した時は国の大小を問わず、隣の国を押した時は画面で小さい国（SMALL_PX 未満）だけ。
export const TAP_SLOP = 24, SMALL_PX = 40;
export function reachOf(geometry: unknown, project: (lon: number, lat: number) => number[] | null | undefined, [tx, ty]: number[], coord: number[] | null = null): { px: number; size: number } {
	let px = Infinity, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	const at = (lon: number, lat: number): number[] | null => { const p = project(lon, lat); if (!p || !(p[2] > 0)) return null; x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); px = Math.min(px, Math.hypot(p[0] - tx, p[1] - ty)); return p; };
	const seg = (a: number[], b: number[]): void => { const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy, u = L ? Math.max(0, Math.min(1, ((tx - a[0]) * dx + (ty - a[1]) * dy) / L)) : 0; px = Math.min(px, Math.hypot(a[0] + u * dx - tx, a[1] + u * dy - ty)); };
	const ring = (r: number[][]): void => { let prev: number[] | null = null; for (const [lon, lat] of r) { const p = at(lon, lat); if (p && prev) seg(prev, p); prev = p; } };
	const walk = (g: any): void => {   // GeoJSON の何か（Geometry／Feature／FeatureCollection）
		if (!g) return;
		if (g.type === "FeatureCollection") g.features.forEach((f: any) => walk(f.geometry));
		else if (g.type === "Feature") walk(g.geometry);
		else if (g.type === "GeometryCollection") g.geometries.forEach(walk);
		else if (g.type === "Point") at(...(g.coordinates as [number, number]));
		else if (g.type === "MultiPoint" || g.type === "LineString") ring(g.coordinates);
		else if (g.type === "Polygon" || g.type === "MultiLineString") g.coordinates.forEach(ring);
		else if (g.type === "MultiPolygon") g.coordinates.forEach((p: number[][][]) => p.forEach(ring));
	};
	walk(geometry); if (coord) at(coord[0], coord[1]);
	return { px, size: x1 >= x0 ? Math.max(x1 - x0, y1 - y0) : 0 };
}
export const tapHits = ({ inside, hitOther, px, size }: { inside: boolean; hitOther: boolean; px: number; size: number }): boolean => inside || (px <= TAP_SLOP && (!hitOther || size < SMALL_PX));
