// 二層キャッシュの席（本計画 §5-7）。
//   一層目: メモリ LRU（デコード済み RGBA・byte 予算・挿入順 Map＝terrain.js:27 と同じ流儀）
//   二層目: 注入式 {get,set}（IDB 等・既定 no-op）。geopbf は native-bucket を import しない＝
//           アプリが opts.cache に Cache("GIS/cog") 等を渡す（pbf-io の provider 注入と同型）。
export function makeLRU(budgetBytes) {
	const m = new Map();   // key → {v, bytes}
	let bytes = 0;
	return {
		get(k) {
			const e = m.get(k);
			if (!e) return null;
			m.delete(k); m.set(k, e);   // touch＝末尾へ
			return e.v;
		},
		set(k, v, b) {
			const old = m.get(k);
			if (old) { bytes -= old.bytes; m.delete(k); }
			m.set(k, { v, bytes: b }); bytes += b;
			for (const [kk, ee] of m) {
				if (bytes <= budgetBytes) break;
				m.delete(kk); bytes -= ee.bytes;
				ee.v?.close?.();   // ImageBitmap は close 規律（iOS メモリ）
			}
		},
		clear() { for (const [, e] of m) e.v?.close?.(); m.clear(); bytes = 0; },
		get bytes() { return bytes; },
	};
}

export const noopCache = { get: async () => null, set: async () => {} };
