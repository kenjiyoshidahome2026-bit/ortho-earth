// scene worker：タイルの geometry(ops/buildings) を保持し、merge 要求で結合。
// 結合結果は render worker へ直結ポートで送る（main を経由しない＝main は geometry を知らない）。
import { mergeTiles } from "../scene.js";   // index直引きはworker循環になる（tileworker側コメント参照）

// geometry は main のタイルキャッシュ(cap=256)の鏡：追加＝tile メッセージ／削除＝evict メッセージ（tilemanager の
// onEvict と同期）。独自の上限退避は持たない——mainが ready と思っているタイルをこちらだけ捨てると、
// merge が黙って穴になる（CAP=512 の insertion-order 退避で実際に起きた：「描き残しタイル」の根因）。
const geom = new Map();   // key → { ops, buildings }
const geomOf = k => geom.get(k) || null;
let renderPort = null;    // render worker への直結ポート（MessageChannel の片端）

self.onmessage = (e) => {
	const m = e.data;
	if (m.type === "connect") { renderPort = m.port; return; }   // main が繋ぐ render worker への直結
	if (m.type === "tile") {
		geom.set(m.key, { ops: m.ops, buildings: m.buildings });   // 削除は main からの evict のみ（上のコメント参照）
		return;
	}
	if (m.type === "evict") { for (const k of m.keys) geom.delete(k); return; }
	if (m.type === "debugFailNext") { failNext = true; return; }   // テスト用：次の merge を故意に失敗させる（自己修復の実地検証）
	if (m.type === "merge") {
		// 失敗したら ack を返さない＝main が readySig を確定せず、タイムアウト後に同じ要求を出し直す（自己修復）。
		// 投げっぱなし＋楽観 sig 確定だと、一度の失敗（結合バッファ確保失敗等）が「静止中は永遠に欠けたタイル」になる。
		try {
			if (failNext) { failNext = false; throw new Error("debug-fail"); }
			// 診断：main が ready と言うタイルの geometry が無い＝そのタイルは黙って穴になる（evict同期後は出ないはず）
			const missing = m.order.filter(o => !geom.has(o.key));
			if (missing.length) console.warn(`[scene] merge ${m.slot}: geometry欠落 ${missing.length}/${m.order.length} 例:`, missing.slice(0, 6).map(o => o.key).join(" "), `(保持${geom.size})`);
			const scene = mergeTiles(m.order, geomOf, { origin: m.origin, hidden: m.hidden ? new Set(m.hidden) : null });
			// merge は同期＝結果は要求順に届く＝最後が最新（latest-wins は不要）。transfer で無コピー。
			if (renderPort) renderPort.postMessage({ type: "scene", slot: m.slot, scene }, collectSceneBuffers(scene));
			self.postMessage({ type: "merged", slot: m.slot, sig: m.sig });   // ack＝main が sig を確定
		} catch (err) {
			console.error(`[scene] merge ${m.slot} 失敗（ackなし→mainが再要求）:`, err && (err.message || err));
		}
	}
};
let failNext = false;

function collectSceneBuffers(scene) {
	const bufs = [];
	for (const L of scene.layers) {
		if (L.kind === "fill") bufs.push(L.pos.buffer, L.col.buffer);
		else bufs.push(L.P1.buffer, L.P2.buffer, L.col.buffer, L.half.buffer);
	}
	if (scene.buildings) bufs.push(scene.buildings.pos.buffer, scene.buildings.shade.buffer, scene.buildings.anchor.buffer);
	return bufs;
}
