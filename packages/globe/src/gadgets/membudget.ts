// GPU メモリの共有の台帳（2026-11-25・COG×点群の共通化の続き＝「予算の一本化」）。
//   旧＝描き手ごとに別々の予算（3D Tiles／splat の tileset 512 MB〜3 GB・点群 600 万点・地図の固定分は数えない）＝合計が端末を越え得た
//   （M5 では動くが M1 級で苦しい・本人 2026-11-25）。ここは「全部でいくら」を 1 つ持ち、各描き手が自分の上限をここへ問う。
// 仕組み（データの形は変えない）：
//   ・載せる＝register(name, { bytes(), poke?() })。bytes＝今持っている量・poke＝「上限が変わったので選び直して」（捨てられる描き手だけが持つ）
//   ・問う＝limit(name, ask)＝min(ask, 総予算 − 他の描き手が今持つ量)。ただし床（floor・総予算の 1/8）は必ず渡す＝どの描き手も 0 にはしない
//   ・押す＝他が増えて合計が総予算を越えたら、捨てられる描き手を poke（1 s に 1 回まで）
// 捨てる順そのもの（画面から遠い・古い物から）は各描き手が既に持つ規則のまま＝ここは「いくらまで」だけを決める。
// 総予算＝端末の格で決める（navigator.deviceMemory は 8 で頭打ち＝M1 8 GB と M5 を見分けられないので、コア数も見る）。?gpumem=MB と opts で上書き。

export interface MemConsumer { bytes(): number; poke?(): void }
export interface MemLedger {
	readonly total: number;
	register(name: string, c: MemConsumer): () => void;
	/** この描き手が今使ってよい量（ask＝自分の望み）。載っていない名前でも問える（他の全部を引く） */
	limit(name: string, ask?: number): number;
	/** 量が変わった合図（数え直して、越えていれば捨てられる描き手を押す） */
	touch(): void;
	/** 台帳の今（計器・検定） */
	snapshot(): { total: number; used: number; by: Record<string, number> };
}

const MB = 1024 * 1024;
/** 端末の格 → 総予算（byte）。lowMem＝600 MB・deviceMemory 4 GB 以下＝1 GB・12 コア以上＝4 GB・10 コア以上＝3 GB・他（M1 級の 8 コア）＝2 GB */
export function defaultGpuBudget({ lowMem = false, deviceMemory = 8, cores = 8 }: { lowMem?: boolean; deviceMemory?: number; cores?: number } = {}): number {
	if (lowMem) return 600 * MB;
	if (deviceMemory <= 4) return 1024 * MB;
	return (cores >= 12 ? 4096 : cores >= 10 ? 3072 : 2048) * MB;
}

export function createMemLedger(total: number, { now = () => performance.now() }: { now?: () => number } = {}): MemLedger {
	const cs = new Map<string, MemConsumer>(), floor = total / 8;
	let poked = -Infinity;
	const safe = (c: MemConsumer): number => { try { const b = c.bytes(); return b > 0 && Number.isFinite(b) ? b : 0; } catch { return 0; } };
	const others = (name: string): number => { let s = 0; for (const [k, c] of cs) if (k !== name) s += safe(c); return s; };
	const ledger: MemLedger = {
		total,
		register(name, c) { cs.set(name, c); return () => { if (cs.get(name) === c) cs.delete(name); }; },
		limit(name, ask = Infinity) { return Math.max(0, Math.min(ask, Math.max(floor, total - others(name)))); },
		touch() {
			let used = 0; for (const c of cs.values()) used += safe(c);
			if (used <= total || now() - poked < 1000) return;
			poked = now();
			for (const c of cs.values()) { try { c.poke?.(); } catch { /* 描き手の都合で落とさない */ } }
		},
		snapshot() { const by: Record<string, number> = {}; let used = 0; for (const [k, c] of cs) { by[k] = safe(c); used += by[k]; } return { total, used, by }; },
	};
	return ledger;
}
