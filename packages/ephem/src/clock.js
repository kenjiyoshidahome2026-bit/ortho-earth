// 共通の時計（#42・2026-09-23）＝ortho-solar の時刻機械を切り出したもの。solar も地図（globe・描画は ortho-core）も同じ部品を使う（時間に関わるものは ephem に集める＝本人裁定）。
//   time   … シミュレーションの時刻（ms・UTC エポック）。範囲 [min, max]（既定＝1800-01-01〜2049-12-31＝solar の JPL 要素の有効期間）
//   step   … 符号つき速度段 ∈ [−8, +8]：0＝停止・正＝順行・負＝逆行（◀◀ は停止を通り越して逆再生へ）。速さ＝SPEEDS[|step|].v（実 1 秒あたりのシミュレート秒）
//   実時間 … step 1 で「今」を見ている間（isLive）＝時刻は Date.now() に張り付く（積算の誤差でずれない）。URL には t を書かない＝後で開いても「今」
// URL の形（solar の hash と同じ）：t＝UTC（末尾 Z）・s＝段。t 無し＋s=1（または s 無し）＝実時間。
// worker への渡し方＝anchor()＝{ sim, wall, rate }（状態が変わった時だけ送る）。受け手は clockNow(anchor)＝sim + rate×(Date.now()−wall) で毎フレーム引く。
export const CLOCK_MIN = Date.UTC(1800, 0, 1), CLOCK_MAX = Date.UTC(2049, 11, 31);
// label/neg は英語＝辞書のキー。neg＝逆行時だけ言い方が変わる段（実時間→1秒/秒）
export const CLOCK_SPEEDS = [
	{ v: 0, label: "Paused" }, { v: 1, label: "Real time", neg: "1 sec/s" },
	{ v: 60, label: "1 min/s" }, { v: 3600, label: "1 hour/s" },
	{ v: 21600, label: "6 hours/s" }, { v: 86400, label: "1 day/s" },
	{ v: 864000, label: "10 days/s" }, { v: 2592000, label: "1 month/s" },
	{ v: 31557600, label: "1 year/s" },
];
const LIVE_MS = 60e3;   // 「今」との差がこれ未満で step 1 なら実時間扱い（solar と同じ）
export const fmtUTC = ms => { const iso = new Date(ms).toISOString(); return iso.slice(17, 19) === "00" ? iso.slice(0, 16) + "Z" : iso.slice(0, 19) + "Z"; };
export const clockNow = (a, w = Date.now()) => a ? a.sim + a.rate * (w - a.wall) : w;

export function createClock({ min = CLOCK_MIN, max = CLOCK_MAX, time = null, step = 1, now = () => Date.now() } = {}) {
	const N = CLOCK_SPEEDS.length - 1;
	let t = time ?? now(), st = 1, lastPlay = 5, follow = time == null;   // follow＝実時間に張り付いている（now() を読む）
	const fns = new Map();
	const emit = (ev, v) => { for (const f of fns.get(ev) || []) try { f(v); } catch (err) { console.error("[clock]", err); } };
	const clamp = v => Math.min(max, Math.max(min, v));
	const rate = () => Math.sign(st) * CLOCK_SPEEDS[Math.abs(st)].v;
	const self = {
		get time() { return follow ? now() : t; },
		get date() { return new Date(self.time); },
		get step() { return st; },
		get speed() { return rate(); },   // 実 1 秒あたりのシミュレート秒（符号つき）
		get playing() { return st !== 0; },
		get range() { return [min, max]; },
		isLive: () => follow || (st === 1 && Math.abs(t - now()) < LIVE_MS),
		label(tr = s => s) { const m = CLOCK_SPEEDS[Math.abs(st)], s = tr(st < 0 ? (m.neg || m.label) : m.label); return st < 0 ? "−" + s : s; },
		setTime(ms) { const v = +ms; if (!Number.isFinite(v)) return self; t = clamp(v); follow = false; emit("change", self); return self; },
		setStep(L) {
			if (follow) t = now();
			st = Math.max(-N, Math.min(N, Math.round(L) || 0));
			if (st !== 0) lastPlay = st;
			follow = st === 1 && Math.abs(t - now()) < LIVE_MS;
			emit("change", self); return self;
		},
		slower: () => self.setStep(st - 1),
		faster: () => self.setStep(st + 1),
		toggle: () => self.setStep(st === 0 ? lastPlay : 0),
		live() { follow = true; t = now(); st = 1; lastPlay = Math.max(lastPlay, 1); emit("change", self); return self; },   // 「今」ボタン
		// 実 dt 秒だけ進める（呼び手の rAF から）。範囲の端に着いたら止める。戻り値＝時刻が動いたか
		tick(dt) {
			if (follow) return st !== 0;
			const r = rate(); if (!r || !(dt > 0)) return false;
			const v = t + r * dt * 1000;
			t = clamp(v);
			if (t !== v) { st = 0; emit("change", self); }
			emit("tick", self);
			return true;
		},
		// worker へ渡す基準（受け手は clockNow）
		anchor() { const w = now(); return { sim: self.time, wall: w, rate: follow ? 1 : rate() }; },
		// URL（URLSearchParams か文字列）⇄ 状態。t＝UTC・s＝段
		toParams(p = new URLSearchParams()) {
			if (st !== 1) p.set("s", String(st)); else p.delete("s");
			if (!self.isLive()) p.set("t", fmtUTC(self.time)); else p.delete("t");
			return p;
		},
		fromParams(p) {
			if (typeof p === "string") p = new URLSearchParams(p.replace(/^[#?]/, ""));
			const tv = p.get("t"), sv = p.get("s");
			if (tv) { const v = new Date(tv).getTime(); if (Number.isFinite(v)) { t = clamp(v); follow = false; } }
			else if (sv == null || sv === "" || sv === "1") { follow = true; t = now(); }   // 生きたリンク（t 無し＋実時間）＝開いた瞬間の「今」
			if (sv != null && sv !== "") { st = Math.max(-N, Math.min(N, Math.round(+sv) || 0)); if (st !== 0) lastPlay = st; if (st !== 1) { if (follow) t = now(); follow = false; } }
			else st = 1;
			emit("change", self); return self;
		},
		on(ev, f) { if (!fns.has(ev)) fns.set(ev, new Set()); fns.get(ev).add(f); return self; },
		off(ev, f) { fns.get(ev)?.delete(f); return self; },
	};
	if (step !== 1) self.setStep(step);
	return self;
}
