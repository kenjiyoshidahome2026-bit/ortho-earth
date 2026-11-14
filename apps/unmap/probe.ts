// M0 の確認を端末の上で：PMTiles の頭（127 バイト）を Range で読み、206（Range が効く）・CORS・ヘッダの申告を返す。
// 読めなければ理由を返す（CORS で落ちた・200＝Range を無視・形式が違う）。地図は待たない（並行）。
export interface ProbeResult { ok: boolean; status: number | null; range: boolean; reason?: string; minZoom?: number; maxZoom?: number; tileType?: string; bounds?: [number, number, number, number]; ms: number }

const TILE_TYPE: Record<number, string> = { 0: "unknown", 1: "mvt", 2: "png", 3: "jpeg", 4: "webp", 5: "avif", 6: "mlt" };

/** PMTiles v3 のヘッダ（127 バイト）を読む（仕様：https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md） */
export function parseHeader(buf: ArrayBuffer): { minZoom: number; maxZoom: number; tileType: string; bounds: [number, number, number, number] } | null {
	if (buf.byteLength < 127) return null;
	const v = new DataView(buf), magic = String.fromCharCode(...new Uint8Array(buf, 0, 7));
	if (magic !== "PMTiles" || v.getUint8(7) !== 3) return null;
	const e7 = (o: number) => v.getInt32(o, true) / 1e7;
	return { tileType: TILE_TYPE[v.getUint8(99)] ?? "unknown", minZoom: v.getUint8(100), maxZoom: v.getUint8(101), bounds: [e7(102), e7(106), e7(110), e7(114)] };
}

export async function probe(url: string, fetchFn: typeof fetch = fetch): Promise<ProbeResult> {
	const t0 = performance.now(), ms = () => Math.round(performance.now() - t0);
	let r: Response;
	try { r = await fetchFn(url, { headers: { Range: "bytes=0-126" }, credentials: "omit", signal: AbortSignal.timeout(15000) }); }
	catch (e) { return { ok: false, status: null, range: false, reason: `network or CORS (${(e as Error).name})`, ms: ms() }; }
	if (r.status !== 206) { r.body?.cancel().catch(() => {}); return { ok: false, status: r.status, range: false, reason: r.ok ? "Range ignored (200)" : `HTTP ${r.status}`, ms: ms() }; }
	const h = parseHeader(await r.arrayBuffer());
	if (!h) return { ok: false, status: 206, range: true, reason: "not a PMTiles v3 archive", ms: ms() };
	return { ok: true, status: 206, range: true, ...h, ms: ms() };
}
