// 生のタイルの控え（main・C7 2026-10-12）＝vector source の querySourceFeatures（MapLibre 同名・同期）のため。
// vtdraw／vtextrude が取ったタイルの写し（worker へ transfer する前に slice）を sid|key で覚え、問い合わせの時だけ decodeTile で解く（同期＝MVT。MLT は
// 読み口が WASM＝put の時に loadTileFormat を起こしておく＝済んでいれば同期）。持ち主（owner＝"vtdraw"／"vtextrude"）ごとに数え、両方が捨てたら消える。
// 予算を超えたら古い順に捨てる（捨てた分は答えに出ない＝maplibre-compat.md §4）。
import { decodeTile, loadTileFormat } from "@ortho-earth/core/decode";

export const RAW_Q_BUDGET = 24 << 20;   // 24 MiB（vtdraw の RAW_BUDGET と同じ桁＝渋谷 z14 の建物タイルで約 200 枚）

export function createRawStore(budget = RAW_Q_BUDGET) {
	const tiles = new Map();   // "sid|key" → { sid, key, ab, enc, bytes, used, data, owners: Set }
	let total = 0, clock = 0;
	const kOf = (sid, key) => `${sid}|${key}`;
	const del = (k, e) => { tiles.delete(k); total -= e.bytes; };
	const evict = () => {
		if (total <= budget) return;
		const cand = [...tiles].sort((a, b) => a[1].used - b[1].used);
		for (const [k, e] of cand) { if (total <= budget) break; del(k, e); }
	};
	return {
		put(owner, sid, key, ab, enc = "mvt") {
			const k = kOf(sid, key), old = tiles.get(k);
			if (old) { old.owners.add(owner); old.used = ++clock; return; }   // 同じタイル＝写しは 1 つ（持ち主だけ足す）
			tiles.set(k, { sid, key, ab, enc, bytes: ab.byteLength, used: ++clock, data: null, owners: new Set([owner]) });
			total += ab.byteLength;
			if (enc !== "mvt") loadTileFormat(enc).catch(() => {});
			evict();
		},
		drop(owner, sid, key) { const k = kOf(sid, key), e = tiles.get(k); if (!e) return; e.owners.delete(owner); if (!e.owners.size) del(k, e); },
		dropSource(owner, sid) { for (const [k, e] of [...tiles]) if (e.sid === sid) { e.owners.delete(owner); if (!e.owners.size) del(k, e); } },
		has: (sid, key) => tiles.has(kOf(sid, key)),
		keys(sid) { const o = []; for (const e of tiles.values()) if (e.sid === sid) o.push(e.key); return o; },
		// 解読済み（全 source-layer・遅延＝最初の問い合わせで解く）。解けない（形式の読み口が未着・壊れたバイト）は {}
		decoded(sid, key) {
			const e = tiles.get(kOf(sid, key)); if (!e) return null;
			e.used = ++clock;
			if (!e.data) { try { e.data = decodeTile(new Uint8Array(e.ab), null, e.enc) || {}; } catch (err) { console.warn("[vtraw] decode", sid, key, err?.message || err); e.data = {}; } }
			return e.data;
		},
		stats: () => ({ tiles: tiles.size, bytes: total, decoded: [...tiles.values()].filter(e => e.data).length }),
		clear() { tiles.clear(); total = 0; },
	};
}
