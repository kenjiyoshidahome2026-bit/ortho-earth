// t-plateaufs の実体：OPFS ストア（plateaufs.js）を dedicated worker で実往復する
// （createSyncAccessHandle は worker 専用＝ページ側では検証できない）。結果は文字列配列で postMessage。
import { opfsStore, packBatch, unpackBatch } from "../plateaufs.js";

const t = [], ok = (n, c) => t.push((c ? "ok:" : "NG:") + n);
const mesh = (n, seed) => {
	const pos = new Float32Array(n * 3), nrm = new Int8Array(n * 4), idx = new Uint32Array(n * 3);
	for (let i = 0; i < pos.length; i++) pos[i] = Math.sin(seed + i) * 1000;
	for (let i = 0; i < nrm.length; i++) nrm[i] = (seed * 31 + i * 7) % 255 - 127;
	for (let i = 0; i < idx.length; i++) idx[i] = (seed * 131 + i * 17) >>> 0;
	return { pos, nrm, idx, origin: [seed, -seed, 1], bbox: [139, 35, 140, 36], lodH: [0, 3, 6, 12, 24, 48], lodCounts: [9, 9, 6, 3, 0, 0], twoSided: 0, tiles: [`u${seed}/a.b3dm`, `u${seed}/b.b3dm`] };
};
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

try {
	const ofs = await opfsStore();
	ok("store", !!ofs);
	if (ofs) {
		const base = "https://example.com/13101-bldg/";   // 実物同様の base URL（"/" が encode されることの確認込み）
		await ofs.purge();   // 前回残骸の掃除（テストの冪等性）
		const m0 = mesh(64, 1), m1 = mesh(48, 2);
		await ofs.put(base, 0, m0);
		await ofs.put(base, 1, m1);
		const r0 = await ofs.read(base, 0);
		ok("roundtrip", !!r0 && same([...r0.pos], [...m0.pos]) && same([...r0.nrm], [...m0.nrm]) && same([...r0.idx], [...m0.idx]) && JSON.stringify(r0.tiles) === JSON.stringify(m0.tiles));
		const h1 = await ofs.read(base, 1, true);   // headerOnly＝本体を読まず tiles と容量だけ
		ok("headerOnly", !!h1 && !h1.pos && JSON.stringify(h1.tiles) === JSON.stringify(m1.tiles) && h1.bytes > m1.pos.byteLength);
		await ofs.put(base, 0, m1);   // 上書き（大→小）＝truncate が効いて古い尻尾が残らない
		const r0b = await ofs.read(base, 0);
		ok("overwrite", !!r0b && same([...r0b.pos], [...m1.pos]));
		ok("has", await ofs.has(base, 1) && !(await ofs.has(base, 9)));
		ok("bases", (await ofs.bases()).has(base));
		ok("delBase", (await ofs.delBase(base)) === 2 && !(await ofs.has(base, 0)));
		await ofs.put(base, 0, m0);
		ok("purge", (await ofs.purge()) >= 1 && !(await ofs.has(base, 0)));
	}
	// pack/unpack の純粋部（worker 内でも同一結果＝node テストと二重化）
	const u8 = packBatch(mesh(8, 3));
	const back = unpackBatch((view, at) => { const d = new Uint8Array(view.buffer, view.byteOffset, view.byteLength); const n = Math.min(d.length, u8.length - at); d.set(u8.subarray(at, at + n)); return n; });
	ok("pack", !!back && back.pos.length === 24);
} catch (e) { ok("boot:" + (e && e.message || e), false); }
postMessage(t);
