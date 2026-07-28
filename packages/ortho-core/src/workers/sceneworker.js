// scene worker：タイルの geometry(ops/buildings) を保持し、シーンを組む。
// 結果は render worker へ直結ポートで送る（main を経由しない＝main は geometry を知らない）。
//
// 2モード（renderer が起動時に mode メッセージで通知）：
// - multi_draw（本命）：タイル geometry を GPU プールに常駐させ、merge 要求は「プール内レンジの列(draw list)」
//   を組むだけ＝CPU memcpy もフルシーンの GPU 再アップロードも無い。プール配置（アロケータ）の権限はここ：
//   renderer には grow（成長）/ up（タイルブロック転送）/ dl（draw list）を順に流すだけ（FIFO＝dl が up を追い越さない）。
// - fallback（WEBGL_multi_draw 非対応 or ?nomd=1）：従来どおり mergeTiles で結合した scene を送る。
import { mergeTiles, coveredTiles, seaFbReal } from "../scene.js";   // index直引きはworker循環になる（tileworker側コメント参照）

// geometry は main のタイルキャッシュのバイト予算の鏡：追加＝tile メッセージ／削除＝evict メッセージ（tilemanager の
// onEvict と同期）。独自の上限退避は持たない——mainが ready と思っているタイルをこちらだけ捨てると、
// merge が黙って穴になる（CAP=512 の insertion-order 退避で実際に起きた：「描き残しタイル」の根因）。
// md モードでは鏡＝「geom（未常駐） ∪ md.res（GPU常駐）」：常駐が確定した時点で CPU 側は解放する（ensureUploaded）。
const geom = new Map();   // key → { ops, buildings }
const geomOf = k => geom.get(k) || null;
let renderPort = null;    // render worker への直結ポート（MessageChannel の片端）
let failNext = false;

// --- multi_draw モードの状態 ---
// res: key → レコード { fv/fi/ls/bv: {off,n}（プール内ブロック）, subs: [{li,kind,…}]（li毎の描画レンジ）, }
// lastRef: slot → 直近 composition が参照したレコード集合。evict されたタイルのブロックは、表示中の
// draw list がまだ参照し得る間は pendingFree に留め、次の composition 後に解放する
// ＝「表示中シーンの足元を掘る」ゴミ描画を構造的に防ぐ（merge ack 設計と同族の教訓）。
let md = null;
const POOL_FLOOR = { fillV: 1 << 17, fillI: 1 << 18, line: 1 << 16, bldV: 1 << 15 };   // 初期成長の下限（頂点/index/線分/建物頂点）
function createMD(maxDraws) {
	return {
		maxDraws,
		pools: { fillV: mkPool("fillV"), fillI: mkPool("fillI"), line: mkPool("line"), bldV: mkPool("bldV") },
		res: new Map(), lastRef: {}, pendingFree: [],
	};
}
const mkPool = name => ({ name, cap: 0, used: 0, free: [] });   // 単位は「要素数」（バイトでない。renderer 側が unit→byte/texel を知る）
// first-fit の free-list（offset昇順・解放時に隣接合体）。タイル1枚=プール毎に1ブロックなので断片化は緩やか。
function palloc(p, n) {
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
function prelease(p, off, n) {
	if (!n) return;
	p.used -= n;
	let i = 0;
	while (i < p.free.length && p.free[i].off < off) i++;
	p.free.splice(i, 0, { off, n });
	if (i + 1 < p.free.length && p.free[i].off + p.free[i].n === p.free[i + 1].off) { p.free[i].n += p.free[i + 1].n; p.free.splice(i + 1, 1); }
	if (i > 0 && p.free[i - 1].off + p.free[i - 1].n === p.free[i].off) { p.free[i - 1].n += p.free[i].n; p.free.splice(i, 1); }
}
// 割当（不足時は×1.5成長）。成長は renderer へ grow を先に流す＝後続の up/dl より必ず先に適用される（FIFO）。
function alloc2(p, n) {
	if (!n) return { off: 0, n: 0 };
	let off = palloc(p, n);
	if (off < 0) {
		const newCap = Math.max(Math.ceil(p.cap * 1.5), p.cap + n, POOL_FLOOR[p.name]);
		const add = newCap - p.cap, last = p.free.length ? p.free[p.free.length - 1] : null;
		if (last && last.off + last.n === p.cap) last.n += add; else p.free.push({ off: p.cap, n: add });
		p.cap = newCap;
		renderPort.postMessage({ type: "grow", pool: p.name, units: newCap });
		off = palloc(p, n);
	}
	return { off, n };
}
function freeRec(rec) {
	prelease(md.pools.fillV, rec.fv.off, rec.fv.n);
	prelease(md.pools.fillI, rec.fi.off, rec.fi.n);
	prelease(md.pools.line, rec.ls.off, rec.ls.n);
	prelease(md.pools.bldV, rec.bv.off, rec.bv.n);
}
const recReferenced = rec => Object.values(md.lastRef).some(s => s.has(rec));
function sweepPendingFree() {
	if (md.pendingFree.length) md.pendingFree = md.pendingFree.filter(rec => recReferenced(rec) ? true : (freeRec(rec), false));
}
function dropRec(key) {   // res からの除去（evict / 同キー再着）。参照中なら解放は composition 後へ繰り延べ
	const rec = md.res.get(key);
	if (!rec) return;
	md.res.delete(key);
	if (recReferenced(rec)) md.pendingFree.push(rec); else freeRec(rec);
}

// タイルを GPU プールへ常駐させる（未常駐なら payload を整形して renderer へ）。ここが唯一の「タイル1回きり」の
// CPU 変換：fill は pos+col を 12B interleave・index をプール絶対値へ再ベース、line は RGBA32UI 2texel/線分
// （float は bit をそのまま uint 格納＝RGBA32F の NaN 正規化を回避）、建物は 24B interleave。
const F1 = new Float32Array(1), U1 = new Uint32Array(F1.buffer);
const fbits = x => (F1[0] = x, U1[0]);
function ensureUploaded(key) {
	let rec = md.res.get(key);
	if (rec) return rec;
	const g = geom.get(key);
	if (!g || !g.ops) return null;
	let fv = 0, fi = 0, ls = 0;
	for (const op of g.ops) { if (op.kind === "fill") { fv += op.pos.length >> 1; fi += op.idx.length; } else ls += op.half.length; }
	const bv = g.buildings ? g.buildings.pos.length / 3 : 0;
	rec = { key, fv: alloc2(md.pools.fillV, fv), fi: alloc2(md.pools.fillI, fi), ls: alloc2(md.pools.line, ls), bv: alloc2(md.pools.bldV, bv), subs: [] };
	const up = { type: "up", key }, transfer = [];   // key は診断用（renderer は使わない）
	if (fv) {
		const ab = new ArrayBuffer(fv * 12), f32 = new Float32Array(ab), u8 = new Uint8Array(ab);
		const idx = new Uint32Array(fi);
		let vc = 0, ic = 0;
		for (const op of g.ops) {
			if (op.kind !== "fill") continue;
			const n = op.pos.length >> 1;
			for (let i = 0; i < n; i++) {
				const v = vc + i;
				f32[v * 3] = op.pos[i * 2]; f32[v * 3 + 1] = op.pos[i * 2 + 1];
				const o = v * 12 + 8, s = i * 4;
				u8[o] = op.col[s]; u8[o + 1] = op.col[s + 1]; u8[o + 2] = op.col[s + 2]; u8[o + 3] = op.col[s + 3];
			}
			const base = rec.fv.off + vc;   // index はプール絶対頂点番号へ（WEBGL_multi_draw に baseVertex は無い）
			for (let i = 0; i < op.idx.length; i++) idx[ic + i] = op.idx[i] + base;
			rec.subs.push({ li: op.li, kind: "fill", idxOff: rec.fi.off + ic, idxN: op.idx.length });
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
			const n = op.half.length;
			for (let i = 0; i < n; i++) {
				const o = (sc + i) * 8;
				seg[o] = fbits(op.P1[i * 2]); seg[o + 1] = fbits(op.P1[i * 2 + 1]);
				seg[o + 2] = fbits(op.P2[i * 2]); seg[o + 3] = fbits(op.P2[i * 2 + 1]);
				seg[o + 4] = (op.col[i * 4] | (op.col[i * 4 + 1] << 8) | (op.col[i * 4 + 2] << 16) | (op.col[i * 4 + 3] << 24)) >>> 0;
				seg[o + 5] = fbits(op.half[i]);
			}
			rec.subs.push({ li: op.li, kind: "line", segOff: rec.ls.off + sc, segN: n });
			sc += n;
		}
		up.line = { base: rec.ls.off, arr: seg };
		transfer.push(seg.buffer);
	}
	if (bv) {
		const b = g.buildings, arr = new Float32Array(bv * 6);
		for (let i = 0; i < bv; i++) {
			const o = i * 6;
			arr[o] = b.pos[i * 3]; arr[o + 1] = b.pos[i * 3 + 1]; arr[o + 2] = b.pos[i * 3 + 2];
			arr[o + 3] = b.shade[i];
			arr[o + 4] = b.anchor[i * 2]; arr[o + 5] = b.anchor[i * 2 + 1];
		}
		up.bld = { base: rec.bv.off, arr };
		transfer.push(arr.buffer);
	}
	if (transfer.length) renderPort.postMessage(up, transfer);
	md.res.set(key, rec);
	// GPU常駐が確定したらCPU側の元geometryは捨てる＝mainのタイル予算(24-96MB)を CPU と GPU で二重に
	// 持たない（スマホは GPU も同じ RAM＝実質倍増でタブ落ちする。PLATEAU の百MB級が乗ると顕在化）。
	// プール成長は GPU 内コピー・再結合は res のレンジだけで済む＝CPU コピーの用途はもう無い。
	// context lost は main が自動リロード＝ゼロから再取得（従来と同じ）。
	geom.delete(key);
	return rec;
}

// composition：order のタイル群から li 毎の multi_draw 引数列（counts/offsets|firsts/origins）を組む。
// 頂点はタイル原点相対のまま常駐＝再ベースは origins（タイル原点−シーン原点）を頂点シェーダが
// gl_DrawID で引いて足す。mergeTiles と同じ「order順・li昇順」＝painter順は厳密に一致する。
function composeMD(m) {
	const origin = m.origin || (m.order.length ? m.order[0].origin : [0, 0]);
	const hidden = m.hidden ? new Set(m.hidden) : null;
	const lineOff = coveredTiles(m.order);   // 下敷きタイル（blanket/祖先fallback）＝線を伏せる（mergeTiles と同じゲート）
	const byLi = new Map(), bldItems = [], refs = new Set();
	for (const o of m.order) {
		const rec = ensureUploaded(o.key);
		if (!rec) continue;
		refs.add(rec);
		const noLine = lineOff.has(o.key);
		const ox = o.origin[0] - origin[0], oy = o.origin[1] - origin[1];
		for (const s of rec.subs) {
			if (hidden && hidden.has(seaFbReal(s.li) ?? s.li)) continue;   // フォールバック水域は実liでチップ消灯判定
			if (s.kind === "line" && noLine) continue;
			let e = byLi.get(s.li); if (!e) byLi.set(s.li, e = { kind: s.kind, items: [] });
			e.items.push(s.kind === "fill" ? [s.idxOff * 4, s.idxN, ox, oy] : [s.segOff * 6, s.segN * 6, ox, oy]);   // fill=byteオフセット / line=先頭頂点番号(6頂点/線分)
		}
		if (rec.bv.n) bldItems.push([rec.bv.off, rec.bv.n, ox, oy]);
	}
	const pack = (items, kind, li) => {
		const out = [];
		for (let c = 0; c < items.length; c += md.maxDraws) {   // u_tileOff[] の配列長でチャンク分割
			const n = Math.min(md.maxDraws, items.length - c);
			const counts = new Int32Array(n), offs = new Int32Array(n), origins = new Float32Array(n * 2);
			for (let j = 0; j < n; j++) { const it = items[c + j]; offs[j] = it[0]; counts[j] = it[1]; origins[j * 2] = it[2]; origins[j * 2 + 1] = it[3]; }
			out.push(kind === "line" ? { kind, li, firsts: offs, counts, origins } : { kind, li, offsets: offs, counts, origins });
		}
		return out;
	};
	const layers = [];
	for (const li of [...byLi.keys()].sort((a, b) => a - b)) { const e = byLi.get(li); layers.push(...pack(e.items, e.kind, li)); }
	const bld = bldItems.length ? pack(bldItems, "bld").map(({ firsts, offsets, counts, origins }) => ({ firsts: firsts || offsets, counts, origins })) : null;
	return { origin, layers, bld, refs };
}
function collectDlBuffers(dl) {
	const bufs = [];
	for (const L of dl.layers) bufs.push(L.counts.buffer, (L.offsets || L.firsts).buffer, L.origins.buffer);
	if (dl.bld) for (const e of dl.bld) bufs.push(e.counts.buffer, e.firsts.buffer, e.origins.buffer);
	return bufs;
}

self.onmessage = (e) => {
	const m = e.data;
	if (m.type === "connect") {   // main が繋ぐ render worker への直結。逆方向は renderer の能力表明（mode）
		renderPort = m.port;
		renderPort.onmessage = ev => {
			const d = ev.data;
			if (d.type === "mode") {
				md = d.md ? createMD(d.maxDraws || 128) : null;
				console.log(`[scene] multi_draw ${md ? `有効（タイルGPU常駐・最大${md.maxDraws}draw/call）` : "なし（CPU mergeフォールバック）"}`);
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
		const U2B = { fillV: 12, fillI: 4, bldV: 24, line: 32 };
		const ps = md ? Object.fromEntries(Object.values(md.pools).map(p => [p.name, { capMB: (p.cap * (U2B[p.name] || 1) / 1048576).toFixed(1), usedMB: (p.used * (U2B[p.name] || 1) / 1048576).toFixed(1), frag: p.free.length }])) : null;
		console.log(`[scene] geom ${geom.size}枚 / md ${md ? `常駐${md.res.size}枚 保留${md.pendingFree.length}` : "off"} ${ps ? JSON.stringify(ps) : ""}`);
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
			if (missing.length) console.warn(`[scene] merge ${m.slot}: geometry欠落 ${missing.length}/${m.order.length} 例:`, missing.slice(0, 6).map(o => o.key).join(" "), `(保持${geom.size})`);
			if (md) {
				// multi_draw：draw list を組むだけ（新規タイルのみ up が先行）。up/dl は同一ポートの FIFO＝追い越しなし。
				// ack はここで返さない：dl はアップロード渋滞の数フレーム後に適用され得るので、「ackされた＝画面に
				// 載っている」前提の main の状態機械（mainFresh/skipMain/mainSceneZoom）が先走ると古いズームの線が
				// 混ざる。sig を dl に載せ、renderer が適用した瞬間に render worker が main へ dlApplied を返す。
				const dl = composeMD(m);
				if (renderPort) renderPort.postMessage({ type: "dl", slot: m.slot, sig: m.sig, origin: dl.origin, layers: dl.layers, bld: dl.bld }, collectDlBuffers(dl));
				md.lastRef[m.slot] = dl.refs;
				sweepPendingFree();   // 旧 composition だけが参照していた evict 済みブロックをここで実解放
			} else {
				const scene = mergeTiles(m.order, geomOf, { origin: m.origin, hidden: m.hidden ? new Set(m.hidden) : null });
				// merge は同期＝結果は要求順に届く＝最後が最新（latest-wins は不要）。transfer で無コピー。
				if (renderPort) renderPort.postMessage({ type: "scene", slot: m.slot, scene }, collectSceneBuffers(scene));
				self.postMessage({ type: "merged", slot: m.slot, sig: m.sig });   // ack＝main が sig を確定（fallback＝適用は次フレーム）
			}
		} catch (err) {
			console.error(`[scene] merge ${m.slot} 失敗（ackなし→mainが再要求）:`, err && (err.message || err));
		}
	}
};

function collectSceneBuffers(scene) {
	const bufs = [];
	for (const L of scene.layers) {
		if (L.kind === "fill") bufs.push(L.pos.buffer, L.col.buffer, L.idx.buffer);
		else bufs.push(L.P1.buffer, L.P2.buffer, L.col.buffer, L.half.buffer);
	}
	if (scene.buildings) bufs.push(scene.buildings.pos.buffer, scene.buildings.shade.buffer, scene.buildings.anchor.buffer);
	return bufs;
}
