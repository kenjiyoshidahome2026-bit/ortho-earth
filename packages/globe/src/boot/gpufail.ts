// メモリ不足・GPU 喪失の裁き（2026-11-18・利用者報告「最初の 3 回は開けず後で開けた」「地震の頁で落ちた」＝タブを大量に開いた Windows 機）。
// 落ちる前に言葉で知らせ、落ちた後は次の起動を省メモリで立て直す。DOM に触らない純関数＝tests/t-gpufail.mjs が Node で回す。
//   isOomMessage(msg)     … 例外文・GPU のエラー文がメモリ不足の型か（JS の ArrayBuffer 確保失敗・WebGPU の GPUOutOfMemoryError・GL の OUT_OF_MEMORY）
//   lossStep(n, safe)     … GPU 喪失（contextlost／device lost）の n 回目に何をするか＝再読み込み → 省メモリで再読み込み → 案内
//   crashMarker(store, id)… 前の起動が畳まれずに終わった（タブの強制終了＝メモリ不足の典型）かを sessionStorage の印で見る
//   oomBurst(times, now)  … メモリ不足の知らせが短い間に続いた（描けていない）か

/** メモリ不足の型の文面。JS（V8／SpiderMonkey／JSC）の確保失敗・WebGPU・WebGL・ANGLE の言い回し */
const OOM_RE = /out of memory|outofmemory|out_of_memory|allocation failed|array buffer allocation|invalid array buffer length|invalid typed array length|cannot allocate|failed to allocate|not enough memory|insufficient memory|memory exhausted|\boom\b/i;
export function isOomMessage(msg: unknown): boolean {
	if (msg == null) return false;
	const e = msg as { name?: unknown; message?: unknown; constructor?: { name?: unknown } };
	if (typeof msg === "object") {
		if (e.name === "GPUOutOfMemoryError" || e.constructor?.name === "GPUOutOfMemoryError") return true;
		if (e.name === "RangeError" && /allocat|array buffer|typed array|buffer length/i.test(String(e.message ?? ""))) return true;
		return OOM_RE.test(String(e.message ?? ""));
	}
	return OOM_RE.test(String(msg));
}

/** GPU 喪失の n 回目（0 始まり・この窓での回数）にすること。safe＝今すでに省メモリで動いている */
export type LossAction = "reload" | "reload-safe" | "fatal";
export function lossStep(n: number, safe: boolean): LossAction {
	if (n < 1) return "reload";            // 1 回目：GPU プロセスの立ち直りを待ってそのまま読み直す（従来どおり）
	if (n < 2 && !safe) return "reload-safe";   // 2 回目：省メモリ（LOW_MEM 相当）で読み直す＝同じ重さでもう一度落ちない
	return "fatal";                         // それでも落ちる＝言葉で止まる（他のタブを閉じる案内＋再読み込みのボタン）
}

/** sessionStorage の分（Node の検定は Map で代用） */
export interface MiniStore { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }
export const ALIVE_KEY = "oj.alive", SAFE_KEY = "oj.safemem";
/** 起動の印。前の起動の印が残っていて自分の物でない＝前の頁は pagehide を通らずに消えた（タブの強制終了・「エラーコード: Out of Memory」）。
 *  同じ頁の 2 枚目の地図は同じ id（performance.timeOrigin）＝誤診しない。戻り値 crashed のあと印は自分の id に書き換える */
export function crashMarker(store: MiniStore | null, id: number): { crashed: boolean; prev: number | null } {
	if (!store) return { crashed: false, prev: null };
	let prev: number | null = null;
	try {
		const v = store.getItem(ALIVE_KEY);
		prev = v == null ? null : Number(v);
		store.setItem(ALIVE_KEY, String(id));
	} catch { return { crashed: false, prev: null }; }
	return { crashed: prev != null && Number.isFinite(prev) && prev !== id, prev };
}
/** 普通の離脱（pagehide）と destroy で印を下ろす */
export function clearMarker(store: MiniStore | null, id: number): void {
	try { if (store && store.getItem(ALIVE_KEY) === String(id)) store.removeItem(ALIVE_KEY); } catch {}
}

/** 省メモリの起動にするか：?lowmem=0 は手動の上書き＝従わない。印（SAFE_KEY）か今回の検出で真 */
export function safeMemBoot(o: { search: string; crashed: boolean; store: MiniStore | null }): boolean {
	if (/[?&]lowmem=0/.test(o.search)) return false;
	let mark = false;
	try { mark = o.store?.getItem(SAFE_KEY) === "1"; } catch {}
	if (o.crashed && !mark) { try { o.store?.setItem(SAFE_KEY, "1"); } catch {} }
	return mark || o.crashed;
}

/** メモリ不足の知らせが windowMs の間に limit 回＝描けていない（一度きりは様子見＝案内のチップだけ） */
export function oomBurst(times: number[], now: number, limit = 3, windowMs = 30000): boolean {
	while (times.length && now - times[0] > windowMs) times.shift();
	times.push(now);
	return times.length >= limit;
}
