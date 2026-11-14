// 保存の worker（save-worker.ts）を動かす口と、書きかけ（覚えの .json）の一覧・続き・破棄（M3）。
import type { SaveJob, WorkerIn, WorkerOut } from "./save-worker.ts";
import { LOCAL_DIRS } from "./sources.ts";

export interface SaveProgress { index: number; count: number; name: string; dir: string; phase: "plan" | "data" | "finish"; bytes: number; total: number }
export type SaveResult = { ok: true } | { ok: false; cancelled: boolean; message: string };

/** 仕事の列を worker で順に書く。onStop＝止める関数を受け取る（「止める」釦に結ぶ） */
export function runSave(jobs: SaveJob[], onProgress: (p: SaveProgress) => void, onStop?: (stop: () => void) => void): Promise<SaveResult> {
	return new Promise(resolve => {
		const w = new Worker(new URL("./save-worker.ts", import.meta.url), { type: "module" });
		const end = (r: SaveResult) => { w.terminate(); resolve(r); };
		w.onmessage = (e: MessageEvent<WorkerOut>) => {
			const m = e.data;
			if (m.type === "progress") onProgress({ ...m, dir: jobs[m.index].dir });
			else if (m.type === "finished") end({ ok: true });
			else if (m.type === "error") end({ ok: false, cancelled: !!m.cancelled, message: m.message });
		};
		w.onerror = e => end({ ok: false, cancelled: false, message: e.message || "save worker failed" });
		onStop?.(() => w.postMessage({ type: "cancel" } satisfies WorkerIn));
		w.postMessage({ type: "run", jobs } satisfies WorkerIn);
	});
}

async function dirOf(path: string): Promise<FileSystemDirectoryHandle | null> {
	try { let d = await navigator.storage.getDirectory(); for (const p of path.split("/").filter(Boolean)) d = await d.getDirectoryHandle(p); return d; } catch { return null; }
}
/** 書きかけの仕事（覚えの .json）。世界の土台 → 地図 → 地形の順 */
export async function pendingSaves(): Promise<SaveJob[]> {
	if (!navigator.storage?.getDirectory) return [];
	const out: SaveJob[] = [];
	for (const dir of [LOCAL_DIRS.map, LOCAL_DIRS.terrain]) {
		const d = await dirOf(dir); if (!d) continue;
		for await (const [name, h] of (d as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
			if (h.kind !== "file" || !name.endsWith(".json")) continue;
			try { const s = JSON.parse(await (await (h as FileSystemFileHandle).getFile()).text()); if (s?.job?.url && s.job.name) out.push(s.job as SaveJob); } catch { /* 壊れた覚え＝無視 */ }
		}
	}
	const rank = (j: SaveJob) => (j.rect ? 1 : 0) + (j.dir === LOCAL_DIRS.terrain ? 2 : 0);
	return out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}
/** 書きかけを捨てる（.json と .part） */
export async function discardSaves(jobs: SaveJob[]): Promise<void> {
	for (const j of jobs) { const d = await dirOf(j.dir); if (!d) continue; await d.removeEntry(j.name + ".json").catch(() => {}); await d.removeEntry(j.name + ".part").catch(() => {}); }
}
