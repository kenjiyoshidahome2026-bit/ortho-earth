// 注記の集合を main → render worker へ差分で運ぶ（2026-10-03）。
// 旧＝作り直すたびに全注記を structured clone（z16 の市街で数千・OpenFreeMap の層で 1 万超＝1 件 3µs 級）。
// タイルの注記は main のタイルキャッシュに常駐する同じ物（identity）が毎回並ぶ＝worker が既に持っている物は番号だけ送る。
// 送り手：物 → 番号（WeakMap）。集合 = { ids: Uint32Array（並び）, add: [id, L, id, L, …]（worker がまだ持たない物） }。
// 受け手：番号 → 物を持ち、並びを復元。並びに無い物は捨てる（送り手の sent と鏡）。
// 持っていない番号が来たら（worker が作り直された等）null を埋めて missing を数える＝呼び手が送り手に reset を頼んで全部送り直す。
import { labelKey } from "./labelkey.js";
export { labelKey };

export function createLabelSender() {
	const ids = new WeakMap();
	let next = 1, sent = new Set();
	function encode(list) {
		const n = list.length, out = new Uint32Array(n), add = [], now = new Set();
		for (let i = 0; i < n; i++) {
			const L = list[i];
			let id = ids.get(L);
			if (id === undefined) { id = next++; ids.set(L, id); }
			out[i] = id;
			if (!sent.has(id) && !now.has(id)) add.push(id, L);
			now.add(id);
		}
		sent = now;
		return { ids: out, add };
	}
	encode.reset = () => { sent = new Set(); };   // worker が集合を失った（作り直し・同期ずれ）＝次は全部送る
	encode.size = () => sent.size;
	return encode;
}

export function createLabelReceiver() {
	let held = new Map();
	function decode(msg) {
		if (Array.isArray(msg)) { held = new Map(); return { list: msg, missing: 0 }; }   // 旧形（配列そのまま）
		const { ids, add } = msg;
		for (let i = 0; i < add.length; i += 2) held.set(add[i], add[i + 1]);
		const n = ids.length, list = [], keep = new Map();
		let missing = 0;
		for (let i = 0; i < n; i++) {
			const id = ids[i], L = held.get(id);
			if (L === undefined) { missing++; continue; }   // 欠け＝詰める（並びは保つ）。呼び手が送り直しを頼む
			list.push(L); keep.set(id, L);
		}
		held = keep;
		return { list, missing };
	}
	decode.reset = () => { held = new Map(); };
	return decode;
}
