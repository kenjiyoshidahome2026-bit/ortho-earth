// 範囲の保存（M3）の書き手＝module worker。OPFS の SyncAccessHandle は worker でしか開けない（Safari も同じ）。
// 1 本ずつ：元（planet / GEL）のヘッダと索引を Range で読む → 計画 → タイルを近い物どうしまとめて読み <名>.part へ → 索引・ヘッダ → 読み直して確かめる → 正式名へ。
// 覚え（<名>.json）＝仕事の中身＋元の etag＋書き終えたチャンクの数。チャンクごとに書き直す＝電波が切れても・タブを閉じても続きから。
// 元が更新された（etag が違う）時は最初から書き直す（古い索引と新しい中身を混ぜない）。
import { openExtractSource, planExtract, writeExtract, idRanges, worldRanges } from "@ortho-earth/core/pmtiles-extract";
import type { ExtractSink, Z8Rect } from "@ortho-earth/core/pmtiles-extract";

/** 1 本の仕事（main と同じ形・覚えの JSON にもそのまま入る） */
export interface SaveJob {
	dir: string; name: string; url: string;
	/** 矩形（日付変更線を跨がない）か、全球（世界の土台） */
	rect: Z8Rect | null;
	minZoom: number; maxZoom: number;
	bbox: [number, number, number, number];
	/** metadata に足す印（範囲の名・保存した日・元の版） */
	tag: Record<string, unknown>;
}
interface SaveState { job: SaveJob; etag: string | null; chunk: number }
export type WorkerIn = { type: "run"; jobs: SaveJob[] } | { type: "cancel" };
export type WorkerOut =
	| { type: "progress"; index: number; count: number; name: string; phase: "plan" | "data" | "finish"; bytes: number; total: number }
	| { type: "done"; index: number; size: number }
	| { type: "finished" }
	| { type: "error"; message: string; cancelled?: boolean };

const post = (m: WorkerOut) => (self as unknown as Worker).postMessage(m);
let ac: AbortController | null = null;

async function dirOf(path: string): Promise<FileSystemDirectoryHandle> {
	let d = await navigator.storage.getDirectory();
	for (const p of path.split("/").filter(Boolean)) d = await d.getDirectoryHandle(p, { create: true });
	return d;
}
type SyncHandle = { read(b: Uint8Array, o: { at: number }): number; write(b: Uint8Array, o: { at: number }): number; truncate(n: number): void; flush(): void; close(): void; getSize(): number };
const openSync = async (d: FileSystemDirectoryHandle, name: string): Promise<SyncHandle> => (await d.getFileHandle(name, { create: true }) as unknown as { createSyncAccessHandle(): Promise<SyncHandle> }).createSyncAccessHandle();

async function readState(d: FileSystemDirectoryHandle, name: string): Promise<SaveState | null> {
	try { return JSON.parse(await (await (await d.getFileHandle(name + ".json")).getFile()).text()) as SaveState; } catch { return null; }
}
async function writeState(d: FileSystemDirectoryHandle, name: string, s: SaveState): Promise<void> {
	const h = await openSync(d, name + ".json");
	try { const b = new TextEncoder().encode(JSON.stringify(s)); h.truncate(0); h.write(b, { at: 0 }); h.flush(); } finally { h.close(); }
}
const sameJob = (a: SaveJob, b: SaveJob) => JSON.stringify([a.url, a.rect, a.minZoom, a.maxZoom]) === JSON.stringify([b.url, b.rect, b.minZoom, b.maxZoom]);

async function runOne(job: SaveJob, index: number, count: number, signal: AbortSignal): Promise<number> {
	const d = await dirOf(job.dir), part = job.name + ".part";
	const progress = (phase: "plan" | "data" | "finish", bytes = 0, total = 0) => post({ type: "progress", index, count, name: job.name, phase, bytes, total });
	progress("plan");
	const src = await openExtractSource(job.url);
	const ranges = job.rect ? idRanges(job.rect, job.minZoom, job.maxZoom) : worldRanges(job.minZoom, job.maxZoom);
	const plan = await planExtract(src, ranges, { minZoom: job.minZoom, maxZoom: job.maxZoom, bbox: job.bbox, signal });
	// 再開：同じ仕事・同じ版（etag）で .part がある時だけ
	const prev = await readState(d, job.name);
	let start = prev && sameJob(prev.job, job) && prev.etag === src.etag && src.etag ? prev.chunk : 0;
	const h = await openSync(d, part);
	try {
		if (start > 0 && h.getSize() === 0) start = 0;
		if (start === 0) h.truncate(0);
		const state: SaveState = { job, etag: src.etag, chunk: start };
		await writeState(d, job.name, state);
		const sink: ExtractSink = {
			write: (b, at) => { let w = 0; while (w < b.byteLength) w += h.write(b.subarray(w), { at: at + w }); },
			read: (at, n) => { const b = new Uint8Array(n); const got = h.read(b, { at }); return got === n ? b : b.subarray(0, got); },
			truncate: n => h.truncate(n), flush: () => h.flush(),
		};
		let last = 0;
		const size = await writeExtract(src, plan, sink, {
			startChunk: start, signal, metadata: { ...src.metadata, unmap: job.tag },
			onProgress: async p => {
				progress(p.chunk === p.chunks ? "finish" : "data", p.bytes, p.total);
				state.chunk = p.chunk;
				const now = Date.now(); if (now - last > 1000 || p.chunk === p.chunks) { last = now; h.flush(); await writeState(d, job.name, state); }   // 覚えは 1 秒に 1 回（書いた中身を先に flush）
			},
		});
		h.close();
		await finalize(d, part, job.name + ".pmtiles");
		await d.removeEntry(job.name + ".json").catch(() => {});
		return size;
	} catch (e) { try { h.flush(); h.close(); } catch { /* 閉じ済み */ } throw e; }
}
// .part → 正式名（move の無い版は写して消す）
async function finalize(d: FileSystemDirectoryHandle, part: string, name: string): Promise<void> {
	await d.removeEntry(name).catch(() => {});
	const fh = await d.getFileHandle(part) as FileSystemFileHandle & { move?: (n: string) => Promise<void> };
	if (typeof fh.move === "function") { await fh.move(name); return; }
	const src = await openSync(d, part), dst = await openSync(d, name);
	try {
		const n = src.getSize(), CH = 8 << 20, b = new Uint8Array(CH);
		dst.truncate(0);
		for (let at = 0; at < n; at += CH) { const got = src.read(b, { at }); dst.write(b.subarray(0, got), { at }); }
		dst.flush();
	} finally { src.close(); dst.close(); }
	await d.removeEntry(part);
}

self.onmessage = async (e: MessageEvent<WorkerIn>) => {
	const m = e.data;
	if (m.type === "cancel") { ac?.abort(); return; }
	if (m.type !== "run" || ac) return;
	ac = new AbortController();
	try {
		for (let i = 0; i < m.jobs.length; i++) post({ type: "done", index: i, size: await runOne(m.jobs[i], i, m.jobs.length, ac.signal) });
		post({ type: "finished" });
	} catch (err) {
		const cancelled = ac.signal.aborted;
		post({ type: "error", message: cancelled ? "cancelled" : String((err as Error)?.message || err), cancelled });
	} finally { ac = null; }
};
