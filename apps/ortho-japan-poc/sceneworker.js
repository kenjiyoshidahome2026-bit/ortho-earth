// scene worker：タイルの geometry(ops/buildings) を保持し、merge 要求で結合。
// 結合結果は render worker へ直結ポートで送る（main を経由しない＝main は geometry を知らない）。
import { mergeTiles } from "ortho-japan";

const geom = new Map();   // key → { ops, buildings }
const CAP = 512;
const geomOf = k => geom.get(k) || null;
let renderPort = null;    // render worker への直結ポート（MessageChannel の片端）

self.onmessage = (e) => {
	const m = e.data;
	if (m.type === "connect") { renderPort = m.port; return; }   // main が繋ぐ render worker への直結
	if (m.type === "tile") {
		geom.set(m.key, { ops: m.ops, buildings: m.buildings });
		if (geom.size > CAP) { const it = geom.keys().next(); if (!it.done) geom.delete(it.value); }   // 古い順に退避
		return;
	}
	if (m.type === "evict") { for (const k of m.keys) geom.delete(k); return; }
	if (m.type === "debugFailNext") { failNext = true; return; }   // テスト用：次の merge を故意に失敗させる（自己修復の実地検証）
	if (m.type === "merge") {
		// 失敗したら ack を返さない＝main が readySig を確定せず、タイムアウト後に同じ要求を出し直す（自己修復）。
		// 投げっぱなし＋楽観 sig 確定だと、一度の失敗（結合バッファ確保失敗等）が「静止中は永遠に欠けたタイル」になる。
		try {
			if (failNext) { failNext = false; throw new Error("debug-fail"); }
			// LRU touch：この merge で使うタイルを最近使用へ移す（古い順退避で現用タイルの geometry が消えるのを防ぐ）
			for (const o of m.order) { const g = geom.get(o.key); if (g) { geom.delete(o.key); geom.set(o.key, g); } }
			// 診断：main が ready と言うタイルの geometry が無い＝そのタイルは黙って穴になる（原因調査の手掛かり）
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
