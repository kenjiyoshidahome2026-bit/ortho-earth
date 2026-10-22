// scene worker：タイルの geometry(ops/buildings) を保持し、シーンを組む。
// 結果は render worker へ直結ポートで送る（main を経由しない＝main は geometry を知らない）。
//
// 2モード（renderer が起動時に mode メッセージで通知）：
// - multi_draw（本命）：タイル geometry を GPU プールに常駐させ、merge 要求は「プール内レンジの列(draw list)」
//   を組むだけ＝CPU memcpy もフルシーンの GPU 再アップロードも無い。プール配置（アロケータ）の権限はここ：
//   renderer には grow（成長）/ up（タイルブロック転送）/ dl（draw list）を順に流すだけ（FIFO＝dl が up を追い越さない）。
// - fallback（WEBGL_multi_draw 非対応 or ?nomd=1）：従来どおり mergeTiles で結合した scene を送る。
import { mergeTiles, coveredTiles, seaFbReal, opBuffers, chopDash } from "../scene.ts";   // index直引きはworker循環になる（tileworker側コメント参照）
import type { MergedScene, TileGeom } from "../scene.ts";
import type { RenderModeMessage, SceneDrawBld, SceneDrawLayer, ScenePoolName, ScenePortMessage, SceneRequest, SceneResponse } from "../worker-msg.ts";

/** プール内ブロック（要素数の範囲） */
interface Block { off: number; n: number }
interface Pool { name: ScenePoolName; cap: number; used: number; free: Block[] }
/** li 毎の描画レンジ（fill＝index のレンジ・line＝線分のレンジ） */
type Sub = { li: number; kind: "fill"; idxOff: number; idxN: number; fx?: number[]; pat?: string } | { li: number; kind: "line"; segOff: number; segN: number; cj: number; dash?: number[]; fx?: number[] };
/** GPU 常駐タイルのレコード */
interface Rec { key: string; fv: Block; fi: Block; ls: Block; bv: Block; subs: Sub[] }
interface MD { maxDraws: number; pools: Record<ScenePoolName, Pool>; res: Map<string, Rec>; lastRef: Record<string, Set<Rec>>; pendingFree: Rec[] }
type MergeRequest = Extract<SceneRequest, { type: "merge" }>;
type UpMessage = Extract<ScenePortMessage, { type: "up" }>;
/** 計器 b の量の数え（op の typed array を名で引く） */
type OpArrays = Partial<Record<"pos" | "col" | "idx" | "P1" | "P2" | "half" | "off" | "jf" | "dist", ArrayBufferView | null>>;
/** pack の 1 束（fill/line＝li 付き・bld＝li 無し） */
interface Packed { kind: "fill" | "line" | "bld"; li?: number; cj?: number; dash?: number[]; fx?: number[]; pat?: string; offsets?: Int32Array<ArrayBuffer>; firsts?: Int32Array<ArrayBuffer>; counts: Int32Array<ArrayBuffer>; origins: Float32Array<ArrayBuffer> }

// geometry は main のタイルキャッシュのバイト予算の鏡：追加＝tile メッセージ／削除＝evict メッセージ（tilemanager の
// onEvict と同期）。独自の上限退避は持たない——mainが ready と思っているタイルをこちらだけ捨てると、
// merge が黙って穴になる（CAP=512 の insertion-order 退避で実際に起きた：「描き残しタイル」の根因）。
// md モードでは鏡＝「geom（未常駐） ∪ md.res（GPU常駐）」：常駐が確定した時点で CPU 側は解放する（ensureUploaded）。
const geom = new Map<string, TileGeom>();   // key → { ops, buildings }
const geomOf = (k: string): TileGeom | null => geom.get(k) || null;
let renderPort: MessagePort | null = null;    // render worker への直結ポート（MessageChannel の片端）
let mdDash = false;       // renderer が md の破線を読める（S-P1-3・GL2）。WebGPU の md は読めない＝常駐の前に CPU で刻む
let perfOn = false;       // 計器 b（?perf=1・renderworker の mode 通知に相乗り）
let relayCtlN = 0;   // iOS診断：page からの relayCtl 受信数
let failNext = false;

// --- multi_draw モードの状態 ---
// res: key → レコード { fv/fi/ls/bv: {off,n}（プール内ブロック）, subs: [{li,kind,…}]（li毎の描画レンジ）, }
// lastRef: slot → 直近 composition が参照したレコード集合。evict されたタイルのブロックは、表示中の
// draw list がまだ参照し得る間は pendingFree に留め、次の composition 後に解放する
// ＝「表示中シーンの足元を掘る」ゴミ描画を構造的に防ぐ（merge ack 設計と同族の教訓）。
let md: MD | null = null;
const POOL_FLOOR: Record<ScenePoolName, number> = { fillV: 1 << 17, fillI: 1 << 18, line: 1 << 16, bldV: 1 << 15 };   // 初期成長の下限（頂点/index/線分/建物頂点）
function createMD(maxDraws: number): MD {
	return {
		maxDraws,
		pools: { fillV: mkPool("fillV"), fillI: mkPool("fillI"), line: mkPool("line"), bldV: mkPool("bldV") },
		res: new Map(), lastRef: {}, pendingFree: [],
	};
}
const mkPool = (name: ScenePoolName): Pool => ({ name, cap: 0, used: 0, free: [] });   // 単位は「要素数」（バイトでない。renderer 側が unit→byte/texel を知る）
// first-fit の free-list（offset昇順・解放時に隣接合体）。タイル1枚=プール毎に1ブロックなので断片化は緩やか。
function palloc(p: Pool, n: number): number {
	for (let i = 0; i < p.free.length; i++) {
		const f = p.free[i];
		if (f.n >= n) {
			const off = f.off;
			if (f.n === n) p.free.splice(i, 1); else { f.off += n; f.n -= n; }
			p.used += n;
			return off;
		}
	}
	return -1;
}
function prelease(p: Pool, off: number, n: number): void {
	if (!n) return;
	p.used -= n;
	let i = 0;
	while (i < p.free.length && p.free[i].off < off) i++;
	p.free.splice(i, 0, { off, n });
	if (i + 1 < p.free.length && p.free[i].off + p.free[i].n === p.free[i + 1].off) { p.free[i].n += p.free[i + 1].n; p.free.splice(i + 1, 1); }
	if (i > 0 && p.free[i - 1].off + p.free[i - 1].n === p.free[i].off) { p.free[i - 1].n += p.free[i].n; p.free.splice(i, 1); }
}
// 割当（不足時は×1.5成長）。成長は renderer へ grow を先に流す＝後続の up/dl より必ず先に適用される（FIFO）。
function alloc2(p: Pool, n: number): Block {
	if (!n) return { off: 0, n: 0 };
	let off = palloc(p, n);
	if (off < 0) {
		const newCap = Math.max(Math.ceil(p.cap * 1.5), p.cap + n, POOL_FLOOR[p.name]);
		const add = newCap - p.cap, last = p.free.length ? p.free[p.free.length - 1] : null;
		if (last && last.off + last.n === p.cap) last.n += add; else p.free.push({ off: p.cap, n: add });
		p.cap = newCap;
		renderPort!.postMessage({ type: "grow", pool: p.name, units: newCap } satisfies ScenePortMessage);
		off = palloc(p, n);
	}
	return { off, n };
}
function freeRec(rec: Rec): void {
	const md_ = md!;
	prelease(md_.pools.fillV, rec.fv.off, rec.fv.n);
	prelease(md_.pools.fillI, rec.fi.off, rec.fi.n);
	prelease(md_.pools.line, rec.ls.off, rec.ls.n);
	prelease(md_.pools.bldV, rec.bv.off, rec.bv.n);
}
const recReferenced = (rec: Rec): boolean => Object.values(md!.lastRef).some(s => s.has(rec));
function sweepPendingFree(): void {
	if (md!.pendingFree.length) md!.pendingFree = md!.pendingFree.filter(rec => recReferenced(rec) ? true : (freeRec(rec), false));
}
function dropRec(key: string): void {   // res からの除去（evict / 同キー再着）。参照中なら解放は composition 後へ繰り延べ
	const rec = md!.res.get(key);
	if (!rec) return;
	md!.res.delete(key);
	if (recReferenced(rec)) md!.pendingFree.push(rec); else freeRec(rec);
}

// タイルを GPU プールへ常駐させる（未常駐なら payload を整形して renderer へ）。ここが唯一の「タイル1回きり」の
// CPU 変換：fill は pos+col を 12B interleave・index をプール絶対値へ再ベース、line は RGBA32UI 2texel/線分
// （float は bit をそのまま uint 格納＝RGBA32F の NaN 正規化を回避）、建物は 24B interleave。
// 型付き配列の 32bit 語の見方（同じバッファ・写さない）。byteOffset が 4 の倍数でない時（ふつうは無い＝各 op は自分のバッファ）は写してから
const u32of = (a: Float32Array | Uint8Array): Uint32Array => a.byteOffset % 4 === 0 && a.byteLength % 4 === 0 ? new Uint32Array(a.buffer, a.byteOffset, a.byteLength >> 2) : new Uint32Array(new Uint8Array(a).buffer);
const snorm16 = (v: number): number => Math.round(Math.max(-1, Math.min(1, v)) * 32767) & 0xffff;   // GLSL unpackSnorm2x16 の対（下位 16bit＝x）
function ensureUploaded(key: string, origin: ArrayLike<number>): Rec | null {
	const md_ = md!;
	let rec = md_.res.get(key);
	if (rec) return rec;
	const g = geom.get(key);
	if (!g || !g.ops) return null;
	if (!mdDash && g.ops.some(op => op.kind === "line" && op.dist)) g.ops = g.ops.map(op => op.kind === "line" ? chopDash(op, origin) : op);   // 破線を読めない md（WebGPU）＝刻んだ片で常駐（origin は緯度の尺だけ＝タイル原点で足りる）
	let fv = 0, fi = 0, ls = 0;
	for (const op of g.ops) { if (op.kind === "fill") { fv += op.pos.length >> 1; fi += op.idx.length; } else ls += op.half.length; }
	const bv = g.buildings ? g.buildings.pos.length / 3 : 0;
	rec = { key, fv: alloc2(md_.pools.fillV, fv), fi: alloc2(md_.pools.fillI, fi), ls: alloc2(md_.pools.line, ls), bv: alloc2(md_.pools.bldV, bv), subs: [] };
	const up: UpMessage = { type: "up", key }, transfer: Transferable[] = [];   // key は診断用（renderer は使わない）
	if (fv) {
		const ab = new ArrayBuffer(fv * 12), w32 = new Uint32Array(ab);   // 12B＝[x, y（float の bit）, RGBA8]＝語ごとに写す（旧＝色をバイトずつ）
		const idx = new Uint32Array(fi);
		let vc = 0, ic = 0;
		for (const op of g.ops) {
			if (op.kind !== "fill") continue;
			const n = op.pos.length >> 1, p32 = u32of(op.pos), c32 = u32of(op.col);
			for (let i = 0, o = vc * 3; i < n; i++, o += 3) { w32[o] = p32[i * 2]; w32[o + 1] = p32[i * 2 + 1]; w32[o + 2] = c32[i]; }
			const base = rec.fv.off + vc;   // index はプール絶対頂点番号へ（WEBGL_multi_draw に baseVertex は無い）
			for (let i = 0; i < op.idx.length; i++) idx[ic + i] = op.idx[i] + base;
			rec.subs.push({ li: op.li, kind: "fill", idxOff: rec.fi.off + ic, idxN: op.idx.length, ...(op.fx ? { fx: op.fx } : {}), ...(op.pat ? { pat: op.pat } : {}) });
			vc += n; ic += op.idx.length;
		}
		up.fill = { base: rec.fv.off, buf: ab };
		up.idx = { base: rec.fi.off, arr: idx };
		transfer.push(ab, idx.buffer);
	}
	if (ls) {
		const seg = new Uint32Array(ls * 8);
		let sc = 0;
		for (const op of g.ops) {
			if (op.kind !== "line") continue;
			const n = op.half.length, a1 = u32of(op.P1), a2 = u32of(op.P2), c32 = u32of(op.col), h32 = u32of(op.half), f32 = op.off ? u32of(op.off) : null, jf = op.jf, d32 = op.dist ? u32of(op.dist) : null;   // float は bit のまま語で写す（旧＝1 値ずつ F1 経由）
			for (let i = 0; i < n; i++) {
				const o = (sc + i) * 8;
				seg[o] = a1[i * 2]; seg[o + 1] = a1[i * 2 + 1];
				seg[o + 2] = a2[i * 2]; seg[o + 3] = a2[i * 2 + 1];
				seg[o + 4] = c32[i];   // RGBA8（リトルエンディアン＝旧の r | g<<8 | b<<16 | a<<24 と同じ語）
				seg[o + 5] = jf ? (h32[i] & ~15 | jf[i]) >>> 0 : h32[i];   // 端と継ぎ（S-P1-1）の旗は半幅の下位 4 bit（相対 2e-6＝見分けられない・シェーダが外す）
				if (f32) {   // line-offset（#49）＝空いていた 2 語：[bits(off px), snorm16×2(tS/2, tE/2)]（角の継ぎ・|t|≤2）
					seg[o + 6] = f32[i * 3];
					seg[o + 7] = (snorm16(op.off![i * 3 + 1] * 0.5) | (snorm16(op.off![i * 3 + 2] * 0.5) << 16)) >>> 0;
				} else if (d32) seg[o + 6] = d32[i];   // 破線（S-P1-3）＝ずらさない層だけ語 6 に始点までの線に沿う距離（bits(f32)・z24 の px）＝描く列の dash が読み方を決める（統合ロードマップの 8 語）
			}
			rec.subs.push({ li: op.li, kind: "line", segOff: rec.ls.off + sc, segN: n, cj: op.jf ? op.cj ?? 0 : 0, ...(op.dist ? { dash: op.dash } : {}), ...(op.fx ? { fx: op.fx } : {}) });
			sc += n;
		}
		up.line = { base: rec.ls.off, arr: seg };
		transfer.push(seg.buffer);
	}
	if (bv) {
		const b = g.buildings!, arr = new Float32Array(bv * 6);
		for (let i = 0; i < bv; i++) {
			const o = i * 6;
			arr[o] = b.pos[i * 3]; arr[o + 1] = b.pos[i * 3 + 1]; arr[o + 2] = b.pos[i * 3 + 2];
			arr[o + 3] = b.shade[i];
			arr[o + 4] = b.anchor[i * 2]; arr[o + 5] = b.anchor[i * 2 + 1];
		}
		up.bld = { base: rec.bv.off, arr };
		transfer.push(arr.buffer);
	}
	if (transfer.length) renderPort!.postMessage(up satisfies ScenePortMessage, transfer);
	md_.res.set(key, rec);
	// GPU常駐が確定したらCPU側の元geometryは捨てる＝mainのタイル予算(24-96MB)を CPU と GPU で二重に
	// 持たない（スマホは GPU も同じ RAM＝実質倍増でタブ落ちする。建物メッシュの百MB級が乗ると顕在化）。
	// プール成長は GPU 内コピー・再結合は res のレンジだけで済む＝CPU コピーの用途はもう無い。
	// context lost は main が自動リロード＝ゼロから再取得（従来と同じ）。
	geom.delete(key);
	return rec;
}

// composition：order のタイル群から li 毎の multi_draw 引数列（counts/offsets|firsts/origins）を組む。
// 頂点はタイル原点相対のまま常駐＝再ベースは origins（タイル原点−シーン原点）を頂点シェーダが
// gl_DrawID で引いて足す。mergeTiles と同じ「order順・li昇順」＝painter順は厳密に一致する。
function composeMD(m: MergeRequest): { origin: number[]; layers: SceneDrawLayer[]; bld: SceneDrawBld[] | null; refs: Set<Rec> } {
	const origin = m.origin || (m.order.length ? m.order[0].origin : [0, 0]);
	const hidden = m.hidden ? new Set(m.hidden) : null;
	const lineOff = coveredTiles(m.order);   // 下敷きタイル（blanket/祖先fallback）＝線を伏せる（mergeTiles と同じゲート）
	const byLi = new Map<number, { kind: "fill" | "line"; items: number[][]; cj?: number; dash?: number[]; fx?: number[]; pat?: string }>(), bldItems: number[][] = [], refs = new Set<Rec>();
	for (const o of m.order) {
		const rec = ensureUploaded(o.key, o.origin);
		if (!rec) continue;
		refs.add(rec);
		const noLine = lineOff.has(o.key);
		const ox = o.origin[0] - origin[0], oy = o.origin[1] - origin[1];
		for (const s of rec.subs) {
			if (hidden && hidden.has(seaFbReal(s.li) ?? s.li)) continue;   // フォールバック水域は実liでチップ消灯判定
			if (s.kind === "line" && noLine) continue;
			let e = byLi.get(s.li); if (!e) byLi.set(s.li, e = { kind: s.kind, items: [] });
			if (s.kind === "line" && s.cj) e.cj ??= s.cj;   // 端と継ぎ（S-P1-1）＝層の種類（最初に持つタイルの値・mergeTiles と同じ）
			if (s.kind === "line" && s.dash) e.dash ??= s.dash;   // 破線（S-P1-3）の模様（同上）
			if (s.fx) e.fx ??= s.fx;   // 層の画面効果（S-P1-4/5・同上）
			if (s.kind === "fill" && s.pat) e.pat ??= s.pat;   // fill-pattern の名前（同上）
			e.items.push(s.kind === "fill" ? [s.idxOff * 4, s.idxN, ox, oy] : [s.segOff * 6, s.segN * 6, ox, oy]);   // fill=byteオフセット / line=先頭頂点番号(6頂点/線分)
		}
		if (rec.bv.n) bldItems.push([rec.bv.off, rec.bv.n, ox, oy]);
	}
	const pack = (items: number[][], kind: Packed["kind"], li?: number, cj?: number, dash?: number[], fx?: number[], pat?: string): Packed[] => {
		const out: Packed[] = [];
		for (let c = 0; c < items.length; c += md!.maxDraws) {   // u_tileOff[] の配列長でチャンク分割
			const n = Math.min(md!.maxDraws, items.length - c);
			const counts = new Int32Array(n), offs = new Int32Array(n), origins = new Float32Array(n * 2);
			for (let j = 0; j < n; j++) { const it = items[c + j]; offs[j] = it[0]; counts[j] = it[1]; origins[j * 2] = it[2]; origins[j * 2 + 1] = it[3]; }
			out.push(kind === "line" ? { kind, li, firsts: offs, counts, origins, ...(cj ? { cj } : {}), ...(dash ? { dash } : {}), ...(fx ? { fx } : {}) } : { kind, li, offsets: offs, counts, origins, ...(fx ? { fx } : {}), ...(pat ? { pat } : {}) });
		}
		return out;
	};
	const layers: SceneDrawLayer[] = [];
	for (const li of [...byLi.keys()].sort((a, b) => a - b)) { const e = byLi.get(li)!; layers.push(...pack(e.items, e.kind, li, e.cj, e.dash, e.fx, e.pat) as SceneDrawLayer[]); }
	const bld = bldItems.length ? pack(bldItems, "bld").map(({ firsts, offsets, counts, origins }) => ({ firsts: (firsts || offsets)!, counts, origins })) : null;
	return { origin, layers, bld, refs };
}
function collectDlBuffers(dl: { layers: SceneDrawLayer[]; bld: SceneDrawBld[] | null }): ArrayBuffer[] {
	const bufs: ArrayBuffer[] = [];
	for (const L of dl.layers) bufs.push(L.counts.buffer, (L.offsets || L.firsts)!.buffer, L.origins.buffer);
	if (dl.bld) for (const e of dl.bld) bufs.push(e.counts.buffer, e.firsts.buffer, e.origins.buffer);
	return bufs;
}

self.onmessage = (e: MessageEvent<SceneRequest>) => {
	const m = e.data;
	if (m.type === "relayCtl") {   // iOS轍の中継：page→ここ→renderPort→render worker（WebGPU worker はページ受信が死ぬ）
		relayCtlN++;
		self.postMessage({ type: "relayCtlN", n: relayCtlN } satisfies SceneResponse);   // hop1 生死の自己申告（診断）
		const msg = m.msg as { port?: MessagePort } | null | undefined;   // 中継の荷（port があれば転送）
		const tr = msg && msg.port ? [msg.port] : [];
		if (renderPort) renderPort.postMessage({ type: "relayCtl", msg: m.msg } satisfies ScenePortMessage, tr);
		return;
	}
	if (m.type === "connect") {   // main が繋ぐ render worker への直結。逆方向は renderer の能力表明（mode）
		renderPort = m.port;
		renderPort.onmessage = (ev: MessageEvent<RenderModeMessage>) => {
			const d = ev.data;
			if (d.type === "mode") {
				perfOn = !!d.perf;   // 計器 b（perf plan §1）＝merge の時間と量を console へ（renderworker の ?perf=1 に相乗り）
				md = d.md ? createMD(d.maxDraws || 128) : null; mdDash = !!d.mdDash;
				console.log(`[scene] multi_draw ${md ? `enabled (tiles resident on GPU, max ${md.maxDraws} draw/call)` : "none (CPU merge fallback)"}`);
			}
		};
		return;
	}
	if (m.type === "tile") {
		geom.set(m.key, { ops: m.ops, buildings: m.buildings });   // 削除は main からの evict のみ（上のコメント参照）
		if (md) dropRec(m.key);   // 同キー再着（evict→再fetch の追い越し等）＝旧ブロックを繰り延べ解放し、次の composition で新規常駐
		return;
	}
	if (m.type === "evict") {
		for (const k of m.keys) { geom.delete(k); if (md) dropRec(k); }
		return;
	}
	if (m.type === "debugFailNext") { failNext = true; return; }   // テスト用：次の merge を故意に失敗させる（自己修復の実地検証）
	if (m.type === "stats") {   // 観測用：プール占有と常駐タイル数（main から postMessage で叩く）
		// バイト換算＝renderer 側の unit→byte（fillV×12/fillI×4/bldV×24/line=2texel×16B=32B）。cap=高水位（縮まない）。
		const U2B: Record<string, number> = { fillV: 12, fillI: 4, bldV: 24, line: 32 };
		const ps = md ? Object.fromEntries(Object.values(md.pools).map(p => [p.name, { capMB: (p.cap * (U2B[p.name] || 1) / 1048576).toFixed(1), usedMB: (p.used * (U2B[p.name] || 1) / 1048576).toFixed(1), frag: p.free.length }])) : null;
		console.log(`[scene] geom ${geom.size} tiles / md ${md ? `resident ${md.res.size} pending ${md.pendingFree.length}` : "off"} ${ps ? JSON.stringify(ps) : ""}`);
		return;
	}
	if (m.type === "merge") {
		// 失敗したら ack を返さない＝main が readySig を確定せず、タイムアウト後に同じ要求を出し直す（自己修復）。
		// 投げっぱなし＋楽観 sig 確定だと、一度の失敗（結合バッファ確保失敗等）が「静止中は永遠に欠けたタイル」になる。
		try {
			if (failNext) { failNext = false; throw new Error("debug-fail"); }
			// 診断：main が ready と言うタイルの geometry が無い＝そのタイルは黙って穴になる（evict同期後は出ないはず）。
			// md モードでは常駐後に CPU 側を解放している＝「geom または res に居る」が正常。
			const missing = m.order.filter(o => !geom.has(o.key) && !(md && md.res.has(o.key)));
			if (missing.length) console.warn("[scene] merge", `${m.slot}: geometry missing ${missing.length}/${m.order.length} e.g.:`, missing.slice(0, 6).map(o => o.key).join(" "), `(held ${geom.size})`);
			if (md) {
				// multi_draw：draw list を組むだけ（新規タイルのみ up が先行）。up/dl は同一ポートの FIFO＝追い越しなし。
				// ack はここで返さない：dl はアップロード渋滞の数フレーム後に適用され得るので、「ackされた＝画面に
				// 載っている」前提の main の状態機械（mainFresh/skipMain/mainSceneZoom）が先走ると古いズームの線が
				// 混ざる。sig を dl に載せ、renderer が適用した瞬間に render worker が main へ dlApplied を返す。
				const dl = composeMD(m);
				if (renderPort) renderPort.postMessage({ type: "dl", slot: m.slot, sig: m.sig, origin: dl.origin, layers: dl.layers, bld: dl.bld } satisfies ScenePortMessage, collectDlBuffers(dl));
				md.lastRef[m.slot] = dl.refs;
				sweepPendingFree();   // 旧 composition だけが参照していた evict 済みブロックをここで実解放
			} else {
				const pT0 = perfOn ? performance.now() : 0;
				const scene = mergeTiles(m.order, geomOf, { origin: m.origin, hidden: m.hidden ? new Set(m.hidden) : null });
				if (pT0) {   // 計器 b：結合の CPU 時間（scene worker＝見えないが到着を遅らせる）と結果の量
					let b = 0; for (const L of scene.layers) for (const k of ["pos", "col", "idx", "P1", "P2", "half", "off", "jf", "dist"] as const) if ((L as OpArrays)[k]) b += (L as OpArrays)[k]!.byteLength;
					if (scene.buildings) b += scene.buildings.pos.byteLength + scene.buildings.shade.byteLength + scene.buildings.anchor.byteLength;
					console.log(`[scene] merge ${m.slot} ${(performance.now() - pT0).toFixed(1)}ms tiles=${m.order.length} layers=${scene.layers.length} ${(b / 1024) | 0}KB`);
				}
				// merge は同期＝結果は要求順に届く＝最後が最新（latest-wins は不要）。transfer で無コピー。
				if (renderPort) renderPort.postMessage({ type: "scene", slot: m.slot, scene } satisfies ScenePortMessage, collectSceneBuffers(scene));
				self.postMessage({ type: "merged", slot: m.slot, sig: m.sig } satisfies SceneResponse);   // ack＝main が sig を確定（fallback＝適用は次フレーム）
			}
		} catch (err) {
			console.error("[scene] merge", `${m.slot} failed (no ack -> main will re-request):`, err && ((err as Error).message || err));
		}
	}
};

const collectSceneBuffers = (scene: MergedScene): ArrayBuffer[] => opBuffers(scene.layers, scene.buildings) as ArrayBuffer[];
