// ?bench=N＝端末の上の自動計測（2026-11-16「Android・Windows が遅すぎる。本質的な問題は？」）。
// 1 本の 30 秒ログは信用しない（timing でいくらでも変わる）＝同じ視点・同じ旋回を、診断ノブを 1 つずつ付けた読み直しで N 巡（既定 2）測り、
// 「何を外すと何コマ増えるか」を 1 枚の表にする。ノブは全部すでにある URL スイッチ＝描画の既定は何も変えない。
// 流れ（変種ごとに頁を読み直す・状態は localStorage）：idle を待つ → 3 秒で 1 周（視野に入るタイルを先に呼ぶ）→ idle を待つ → 10 秒で 1 周（後ろ 8 秒のコマ数を数える）→ 次の変種へ。
// 落ちた変種（読み直しても結果が残らない）は 2 回目で「failed」と記して先へ進む＝「落ちる」も表に出る。
// コマ数＝render worker の実描画枚数の累計（mem の frames・at＝worker の時計）の 2 点の差。

/** 変種＝表の見出しと、付ける URL ノブ（& つなぎ・空＝既定のまま） */
export const BENCH_VARIANTS: ReadonlyArray<readonly [string, string]> = [
	["default", ""],
	["no terrain", "noterr=1"],
	["terrain on, vertex heights flat", "flatvec=1"],
	["terrain always coarse (1/16)", "terrcoarse=4&terrcoarsealways=1"],
	["line heights 1 sample", "lineelev=2&elevcheap=1"],
	["no basemap 3D buildings", "nobld=1"],
	["no 3D city mesh", "paz=30"],
	["no labels", "nolab=1"],
	["no coast/border layer", "nogint=1"],
	["half resolution", "res=0.5"],
	["no MSAA", "msaa=0"],
];
/** 1 回の計測 */
export interface BenchRun { v: number; round: number; fps: number; frames: number; secs: number; gpuMap: number | null; res: number; shed: number; idleS: number; failed?: boolean }
/** 読み直しをまたぐ状態 */
export interface BenchState { base: string; rounds: number; i: number; tries: number; runs: BenchRun[]; t0: number; done?: boolean; head?: string }
/** 頁（globe.ts）が渡す口 */
export interface BenchHost {
	host: HTMLElement; jumpTo(o: { bearing: number }): void; bearing(): number; onIdle(cb: () => void): void;
	perf(): { frames: number; at: number; gpuMap: number; res: number; shed: number; backend: string; gpu: string };
	tier: string;
}

const KEY = "oj.bench", MAX_AGE_MS = 40 * 60000;
const PRE_S = 3, SPIN_S = 10, SKIP_S = 2, IDLE_MAX_MS = 45000, IDLE2_MAX_MS = 20000;

/** URL から計測のノブ（bench と変種のノブ）を外した素の URL。利用者が元から付けていたノブは残す */
export function benchBase(href: string): string {
	const u = new URL(href);
	u.searchParams.delete("bench");
	return u.toString();
}
/** 変種 v の URL：素の URL に変種のノブ（元の URL に同じ名があれば元を優先）と bench=N を足す */
export function benchUrl(base: string, v: number, rounds: number): string {
	const u = new URL(base);
	for (const kv of BENCH_VARIANTS[v][1].split("&")) { if (!kv) continue; const [k, val] = kv.split("="); if (!u.searchParams.has(k)) u.searchParams.set(k, val); }
	u.searchParams.set("bench", String(rounds));
	return u.toString();
}
/** 順番 i（0 から）の変種と巡：巡ごとに全変種を 1 回ずつ（A B C … A B C＝端末の温まりを変種に偏らせない） */
export function benchStep(i: number): { v: number; round: number } { const n = BENCH_VARIANTS.length; return { v: i % n, round: Math.floor(i / n) }; }
const median = (a: number[]): number => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
/** 結果の表（文字・チャットへ貼る用）。倍率＝既定（変種 0）の中央値に対する比 */
export function benchTable(st: BenchState): string {
	const out: string[] = [st.head || "bench", `view ${st.base}`, `spin 360° in ${SPIN_S} s, frames counted over the last ${SPIN_S - SKIP_S} s, ${st.rounds} round(s) per variant, order A B C … per round`, ""];
	const of = (v: number) => st.runs.filter(r => r.v === v);
	const base = median(of(0).filter(r => !r.failed).map(r => r.fps));
	out.push("variant | fps per round | median | vs default | gpuMap ms | res | shed m | idle s");
	BENCH_VARIANTS.forEach(([name, knobs], v) => {
		const rs = of(v); if (!rs.length) return;
		const ok = rs.filter(r => !r.failed), med = median(ok.map(r => r.fps));
		const g = ok.map(r => r.gpuMap).filter((x): x is number => x != null && x > 0);
		out.push([`${name}${knobs ? ` (${knobs})` : ""}`, rs.map(r => r.failed ? "failed" : r.fps.toFixed(1)).join(" / "), ok.length ? med.toFixed(1) : "-",
			ok.length && base > 0 ? `×${(med / base).toFixed(2)}` : "-", g.length ? median(g).toFixed(1) : "-", ok.map(r => r.res.toFixed(2)).join("/") || "-", ok.map(r => r.shed).join("/") || "-", ok.map(r => r.idleS.toFixed(0)).join("/") || "-"].join(" | "));
	});
	out.push("", "failed = the page did not finish that variant in two tries (crash, reload or no frames).", `total ${((Date.now() - st.t0) / 60000).toFixed(1)} min`);
	return out.join("\n");
}

function load(): BenchState | null {
	try { const s = JSON.parse(localStorage.getItem(KEY) || "null") as BenchState | null; return s && Date.now() - s.t0 < MAX_AGE_MS ? s : null; } catch { return null; }
}
function save(st: BenchState): void { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch { /* 保存できない＝この頁の分だけ */ } }

/** 計測を進める（頁の起動のたびに 1 変種）。globe.ts が ?bench= の時だけ遅延 import する */
export function runBench(h: BenchHost): void {
	const m = /[?&]bench=(\d+)/.exec(location.search), rounds = Math.max(1, Math.min(5, Number(m?.[1]) || 2));
	let st = load();
	const total = () => BENCH_VARIANTS.length * st!.rounds;
	const box = document.createElement("div");
	box.style.cssText = "position:absolute;left:8px;top:8px;z-index:99;max-width:calc(100% - 16px);max-height:calc(100% - 16px);overflow:auto;background:rgba(20,24,32,.88);color:#fff;font:12px/1.45 ui-monospace,Menlo,Consolas,monospace;padding:8px 10px;border-radius:8px;white-space:pre-wrap";
	h.host.append(box);
	const say = (t: string) => { box.textContent = t; };
	const btn = (label: string, fn: () => void): HTMLButtonElement => { const b = document.createElement("button"); b.type = "button"; b.textContent = label; b.style.cssText = "margin:8px 8px 0 0;padding:8px 14px;font:inherit;border-radius:6px;border:0;background:#fff;color:#111"; b.onclick = fn; return b; };
	// 同じ URL（# だけ違う）への replace は読み直しにならない＝その時は URL を置いてから reload
	const go = (url: string) => { const u = new URL(url); if (u.pathname === location.pathname && u.search === location.search) { history.replaceState(null, "", url); location.reload(); } else location.replace(url); };
	const start = () => { st = { base: benchBase(location.href), rounds, i: 0, tries: 0, runs: [], t0: Date.now() }; save(st); go(benchUrl(st.base, 0, rounds)); };
	const show = () => {
		const text = benchTable(st!);
		say(text);
		box.append(document.createElement("br"), btn("copy result", async () => {
			let ok = false;
			try { await navigator.clipboard.writeText(text); ok = true; } catch { /* 古い口へ */ }
			if (!ok) { const ta = document.createElement("textarea"); ta.value = text; ta.style.cssText = "position:fixed;opacity:0"; document.body.append(ta); ta.select(); try { ok = document.execCommand("copy"); } catch { ok = false; } ta.remove(); }
			(box.querySelector("button") as HTMLButtonElement).textContent = ok ? "copied ✓" : "copy failed";
		}), btn("run again", start), btn("close", () => { try { localStorage.removeItem(KEY); } catch { /* 無視 */ } go(st!.base); }));
	};
	if (!st) {   // 最初の頁＝押して始める（勝手に何分も読み直しを続けない）
		say(`bench: ${BENCH_VARIANTS.length} variants × ${rounds} round(s), about ${Math.ceil(BENCH_VARIANTS.length * rounds * 0.5)} min.\nThe page reloads by itself. Keep the screen on and do not touch the map.\nSet the view you want to measure first, then press start.`);
		box.append(document.createElement("br"), btn("start", start));
		return;
	}
	if (st.done) { show(); return; }
	const next = () => { st!.i++; st!.tries = 0; if (st!.i >= total()) { st!.done = true; save(st!); show(); return; } save(st!); go(benchUrl(st!.base, benchStep(st!.i).v, st!.rounds)); };
	const { v, round } = benchStep(st.i);
	if (st.tries >= 2) {   // 2 回始めて結果が無い＝落ちた／描けない＝記して次へ
		st.runs.push({ v, round, fps: 0, frames: 0, secs: 0, gpuMap: null, res: 0, shed: 0, idleS: 0, failed: true });
		next(); return;
	}
	st.tries++; save(st);
	const tag = `bench ${st.i + 1}/${total()} · ${BENCH_VARIANTS[v][0]}`;
	say(`${tag}\nloading…`);
	let idleAt = 0;
	h.onIdle(() => { idleAt = performance.now(); });
	const waitIdle = (maxMs: number): Promise<void> => new Promise(res => {   // 呼んだ後に来た idle（＋0.3 秒の静けさ）か、上限まで
		const t0 = performance.now(), since = idleAt;
		const tick = () => { const now = performance.now(); if ((idleAt > since && now - idleAt > 300) || now - t0 > maxMs) res(); else setTimeout(tick, 100); };
		tick();
	});
	const spin = (secs: number, onT?: (t: number) => void): Promise<void> => new Promise(res => {
		const b0 = h.bearing(), t0 = performance.now();
		const step = () => {
			const t = (performance.now() - t0) / 1000;
			if (t >= secs) { h.jumpTo({ bearing: b0 }); res(); return; }
			h.jumpTo({ bearing: b0 + 360 * t / secs }); onT?.(t);
			requestAnimationFrame(step);
		};
		requestAnimationFrame(step);
	});
	(async () => {
		await waitIdle(IDLE_MAX_MS);
		const idleS = performance.now() / 1000;   // 頁の起点から最初の idle まで（上限で打ち切った時はその時刻）
		say(`${tag}\nwarm-up spin…`);
		await spin(PRE_S);
		await waitIdle(IDLE2_MAX_MS);
		say(`${tag}\nmeasuring…`);
		// 後ろ 8 秒：mem は 0.5 秒おき＝窓の中に着いた最初と最後の標本の差（worker の時計）で割る
		let a: { frames: number; at: number } | null = null, b: { frames: number; at: number } | null = null;
		const gpu: number[] = [];
		let lastAt = -1, res = 1, shed = 0;
		await spin(SPIN_S, t => {
			if (t < SKIP_S) return;
			const p = h.perf(); if (!p.at || p.at === lastAt) return;
			lastAt = p.at; if (!a) a = { frames: p.frames, at: p.at }; b = { frames: p.frames, at: p.at };
			if (p.gpuMap > 0) gpu.push(p.gpuMap); res = p.res; shed = Math.max(shed, p.shed);
		});
		const p = h.perf();
		if (!st!.head) st!.head = `bench ${new Date().toISOString()} · ${navigator.userAgent.replace(/^Mozilla\/5\.0 /, "")} · RAM ${(navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? "?"} GB · cores ${navigator.hardwareConcurrency || "?"} · ${innerWidth}x${innerHeight}@${devicePixelRatio} · ${p.backend || "?"} · ${p.gpu || "?"} · tier ${h.tier}`;
		const A = a as { frames: number; at: number } | null, B = b as { frames: number; at: number } | null;
		const secs = A && B ? (B.at - A.at) / 1000 : 0, frames = A && B ? B.frames - A.frames : 0;
		if (secs < 2) { location.reload(); return; }   // 標本が着かない＝やり直し（2 回目で failed）
		st!.runs.push({ v, round, fps: frames / secs, frames, secs, gpuMap: gpu.length ? median(gpu) : null, res, shed, idleS });
		next();
	})().catch(e => { console.error("[bench]", e); say(`${tag}\nerror: ${String(e)}`); });
}
