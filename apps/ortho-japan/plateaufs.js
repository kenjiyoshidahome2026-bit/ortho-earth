// PLATEAU バッチ本体の OPFS ストア（2026-08-02）。狙いはただ一点＝「読みでメモリピークを積まない」：
// IDB の get() は値全体（バッチ 3〜20MB）を構造化クローンで一括実体化するが、OPFS の同期ハンドルは
// 配列ごとに確保した器へ read(view,{at}) で流し込む＝ヘッダ・pos・nrm・idx が別バッファで立ち、
// そのまま transfer できる（コピーもクローンも無い）。台帳（meta）は IDB のまま＝二層構成。
// 1ファイル=1バッチ・開いたら必ず即 close（Safari のファイルロックは「初書込→close まで全体」と粗い＝窓を最小化）。
// ファイル名は encodeURIComponent(base)+"#"+i（OPFS が禁じる文字は "/" のみ＝encode で消える）。
// 同期ハンドルは dedicated worker 専用＝この store は plateauworker からのみ使う。
// base→worker はハッシュ固定ルーティング＝同一ファイルを複数 worker が同時に触ることは無い。

const MAGIC = 0x35424c50;   // "PLB5"（リトルエンディアン）＝形式印。meta.ver とは独立の破損検知

// バッチ→単一バッファ（書き込みは1回の write で済ませる＝ロック窓最短）。
// レイアウト: [u32 MAGIC][u32 jsonLen][json utf8][pad→4B整列][pos f32][nrm i8][idx u32]
// json＝軽量メタ（origin/bbox/lodH/lodCounts/twoSided/tiles＋各配列の要素数）。tiles＝部分再開の差分計算用。
export function packBatch(mesh) {
	const head = {
		origin: mesh.origin, bbox: mesh.bbox, lodH: mesh.lodH, lodCounts: mesh.lodCounts,
		twoSided: mesh.twoSided || 0, tiles: mesh.tiles ?? null,
		pos: mesh.pos.length, nrm: mesh.nrm.length, idx: mesh.idx.length,
	};
	const json = new TextEncoder().encode(JSON.stringify(head));
	const start = dataStart(json.length);
	const u8 = new Uint8Array(start + mesh.pos.byteLength + mesh.nrm.byteLength + mesh.idx.byteLength);
	const dv = new DataView(u8.buffer);
	dv.setUint32(0, MAGIC, true);
	dv.setUint32(4, json.length, true);
	u8.set(json, 8);
	let o = start;
	u8.set(new Uint8Array(mesh.pos.buffer, mesh.pos.byteOffset, mesh.pos.byteLength), o); o += mesh.pos.byteLength;
	u8.set(new Uint8Array(mesh.nrm.buffer, mesh.nrm.byteOffset, mesh.nrm.byteLength), o); o += mesh.nrm.byteLength;
	u8.set(new Uint8Array(mesh.idx.buffer, mesh.idx.byteOffset, mesh.idx.byteLength), o);
	return u8;
}
const dataStart = jsonLen => { const h = 8 + jsonLen; return h + ((4 - h % 4) % 4); };   // pos(f32) を 4B 整列

// 読み＝readAt(view, at) コールバック（worker では ah.read(view,{at})、テストでは配列コピー）。
// headerOnly＝tiles だけ欲しい部分再開の走査用（本体3配列を読まない）。壊れていれば null。
export function unpackBatch(readAt, headerOnly = false) {
	const pre = new Uint8Array(8);
	if (readAt(pre, 0) < 8) return null;
	const dv = new DataView(pre.buffer);
	if (dv.getUint32(0, true) !== MAGIC) return null;
	const jl = dv.getUint32(4, true);
	const jb = new Uint8Array(jl);
	if (readAt(jb, 8) < jl) return null;
	let h;
	try { h = JSON.parse(new TextDecoder().decode(jb)); } catch { return null; }
	const base = { origin: h.origin, bbox: h.bbox, lodH: h.lodH, lodCounts: h.lodCounts, twoSided: h.twoSided, tiles: h.tiles ?? undefined };
	if (headerOnly) return base;
	const start = dataStart(jl);
	const pos = new Float32Array(h.pos), nrm = new Int8Array(h.nrm), idx = new Uint32Array(h.idx);
	if (readAt(pos, start) < pos.byteLength) return null;
	if (readAt(nrm, start + pos.byteLength) < nrm.byteLength) return null;
	if (readAt(idx, start + pos.byteLength + nrm.byteLength) < idx.byteLength) return null;
	return { pos, nrm, idx, ...base };
}

// ストア本体。使えない環境（OPFS非対応・プライベートブラウズの沈黙失敗）は null＝呼び出し側が従来IDB経路へ。
// probe で実際に同期ハンドルを1回開く＝「APIは在るが開けない」系をここで確定させる。
export async function opfsStore() {
	if (!navigator.storage?.getDirectory) return null;
	const root = await navigator.storage.getDirectory();
	const dir = await root.getDirectoryHandle("plateau", { create: true });
	// probe 名は worker ごとに一意：PLATEAU_NW 本が同時に initFs する＝同名だと同期ハンドルのロック競合で
	// 後着が InvalidStateError＝そのworkerだけ silent に IDB フォールバックへ落ちる（E2E実測 2026-08-02＝4本中1本しか有効にならない）。
	const probeName = "#probe-" + Math.random().toString(36).slice(2);
	const probe = await dir.getFileHandle(probeName, { create: true });
	if (!probe.createSyncAccessHandle) { dir.removeEntry(probeName).catch(() => {}); return null; }
	(await probe.createSyncAccessHandle()).close();
	dir.removeEntry(probeName).catch(() => {});
	const nameOf = (base, i) => encodeURIComponent(base) + "#" + i;
	return {
		async put(base, i, mesh) {   // 失敗（quota等）は throw＝呼び出し側の QuotaExceeded 退避/idbFail が受ける
			const fh = await dir.getFileHandle(nameOf(base, i), { create: true });
			const ah = await fh.createSyncAccessHandle();
			try { const u8 = packBatch(mesh); ah.truncate(0); ah.write(u8, { at: 0 }); ah.flush(); }
			finally { ah.close(); }
		},
		async read(base, i, headerOnly = false) {
			try {
				const fh = await dir.getFileHandle(nameOf(base, i));
				const ah = await fh.createSyncAccessHandle();
				try {
					const out = unpackBatch((view, at) => ah.read(view, { at }), headerOnly);
					if (out && headerOnly) out.bytes = ah.getSize();   // 本体を読まない時の容量台帳用（ファイルサイズ≒メッシュ実バイト）
					return out;
				} finally { ah.close(); }
			} catch { return null; }   // 無い/開けない/壊れ＝null（呼び出し側が焼き直しへ）
		},
		async has(base, i) { try { await dir.getFileHandle(nameOf(base, i)); return true; } catch { return false; } },
		async delBase(base) {   // 区の全バッチファイル（プレフィックス一致）。冪等＝purge広播との競合も無害
			const prefix = encodeURIComponent(base) + "#";
			const names = [];
			for await (const k of dir.keys()) if (k.startsWith(prefix)) names.push(k);
			for (const k of names) await dir.removeEntry(k).catch(() => {});
			return names.length;
		},
		async bases() {   // 孤児掃除用＝ファイルが存在する base 一覧（decode 済み）
			const s = new Set();
			for await (const k of dir.keys()) { const h = k.lastIndexOf("#"); if (h > 0) s.add(decodeURIComponent(k.slice(0, h))); }
			return s;
		},
		async purge() {
			const names = [];
			for await (const k of dir.keys()) names.push(k);
			for (const k of names) await dir.removeEntry(k).catch(() => {});
			return names.length;
		},
	};
}
