// convert/tagtable.js ── 属性を worker へ渡すための typed array 表。
//
// 100 万 feature の [[key, value], …] を構造化クローンや JSON で worker 毎に送ると、複製・parse だけで数秒掛かる
//（1M 点で pool 初期化 4.5 秒）。ここでは feature 毎の属性を「キー辞書の添字 ＋ 型 ＋ 値（数値/真偽はそのまま・文字列は
// UTF-8 辞書の添字）」の平坦な typed array に畳み、文字列は 1 本の Uint8Array（＋区切り）で持つ。worker 側は必要な
// feature の分だけ [[key, value]] を組み立て、文字列は UTF-8 のバイト列のまま MVT へ書く（TextEncoder を通さない）。
//
// 表: { n, keys: string[], featOff: Uint32Array(n+1), entKey: Uint32Array(E), entType: Uint8Array(E) (0 文字列 / 1 数値 / 2 真偽),
//       entNum: Float64Array(E) (文字列添字・数値・真偽 0/1), strBytes: Uint8Array, strOff: Uint32Array(nStr+1) }

// pbf の属性行（keys に揃った疎配列）から表を作る。keep(key)→bool で選別。fields（Map）に MVT 用の型を集める。
export function buildTagTable(pbf, keep = null, fields = null) {
	const n = pbf.length, keys = pbf.keys ?? [], props = pbf.props;
	const keyUse = new Int32Array(keys.length).fill(-1), outKeys = [];
	for (let ki = 0; ki < keys.length; ki++) if (!keep || keep(keys[ki])) { keyUse[ki] = outKeys.length; outKeys.push(keys[ki]); }
	const strIdx = new Map(), strList = [];
	let cap = Math.max(1024, n * 2), E = 0;
	let entKey = new Uint32Array(cap), entType = new Uint8Array(cap), entNum = new Float64Array(cap);
	const featOff = new Uint32Array(n + 1);
	const grow = () => { cap *= 2; const k = new Uint32Array(cap); k.set(entKey); entKey = k; const t = new Uint8Array(cap); t.set(entType); entType = t; const v = new Float64Array(cap); v.set(entNum); entNum = v; };
	const field = (k, ty) => { if (!fields) return; const cur = fields.get(k); if (!cur) fields.set(k, ty); else if (cur !== ty) fields.set(k, "String"); };
	const strOf = (s) => { let i = strIdx.get(s); if (i === undefined) { i = strList.length; strIdx.set(s, i); strList.push(s); } return i; };
	const put = (ko, k, v) => {
		let ty, num;
		if (typeof v === "string") { ty = 0; num = strOf(v); field(k, "String"); }
		else if (typeof v === "number") { if (!Number.isFinite(v)) return; ty = 1; num = v; field(k, "Number"); }
		else if (typeof v === "boolean") { ty = 2; num = v ? 1 : 0; field(k, "Boolean"); }
		else if (v instanceof Date) { ty = 0; num = strOf(v.toISOString()); field(k, "String"); }
		else if (ArrayBuffer.isView(v)) { ty = 0; num = strOf(JSON.stringify(Array.from(v))); field(k, "String"); }
		else if (typeof v === "object") { if (typeof Blob !== "undefined" && v instanceof Blob) return; if (typeof ImageData !== "undefined" && v instanceof ImageData) return; ty = 0; num = strOf(JSON.stringify(v)); field(k, "String"); }
		else return;
		if (E === cap) grow();
		entKey[E] = ko; entType[E] = ty; entNum[E] = num; E++;
	};
	for (let i = 0; i < n; i++) {
		featOff[i] = E;
		const row = props?.[i];
		if (row) { for (let ki = 0; ki < row.length; ki++) { const v = row[ki]; if (v === undefined || v === null || keyUse[ki] < 0) continue; put(keyUse[ki], keys[ki], v); } }
		else if (pbf.getProperties) {   // 行が無い（外部実装）: オブジェクトから平坦化して拾う
			const q = pbf.getProperties(i);
			for (const k in q) { const v = q[k]; if (v && typeof v === "object" && !(v instanceof Date) && !ArrayBuffer.isView(v) && Object.getPrototypeOf(v) === Object.prototype) { for (const kk in v) putKey(k + "." + kk, v[kk]); } else putKey(k, v); }
		}
	}
	function putKey(k, v) { if (v === null || v === undefined || (keep && !keep(k))) return; let ko = outKeys.indexOf(k); if (ko < 0) { ko = outKeys.length; outKeys.push(k); } put(ko, k, v); }
	featOff[n] = E;
	const enc = new TextEncoder();
	const strOff = new Uint32Array(strList.length + 1);
	const parts = new Array(strList.length);
	let total = 0;
	for (let i = 0; i < strList.length; i++) { const b = enc.encode(strList[i]); parts[i] = b; strOff[i] = total; total += b.length; }
	strOff[strList.length] = total;
	const strBytes = new Uint8Array(total);
	for (let i = 0; i < parts.length; i++) strBytes.set(parts[i], strOff[i]);
	return { n, keys: outKeys, featOff, entKey: entKey.slice(0, E), entType: entType.slice(0, E), entNum: entNum.slice(0, E), strBytes, strOff };
}

// 表 → tagsOf(fid) → [[key, value], …]。文字列は UTF-8 の Uint8Array（同じ文字列は同じオブジェクト＝タイル内の値表で 1 回に畳まれる）
export function tagReader(T) {
	const strCache = new Array(T.strOff.length - 1);
	const strOf = (i) => strCache[i] ??= T.strBytes.subarray(T.strOff[i], T.strOff[i + 1]);
	return (fid) => {
		const out = [], e1 = T.featOff[fid + 1];
		for (let e = T.featOff[fid]; e < e1; e++) { const t = T.entType[e], v = T.entNum[e]; out.push([T.keys[T.entKey[e]], t === 0 ? strOf(v) : t === 1 ? v : v !== 0]); }
		return out;
	};
}

// [[key, value]] 配列（既存 API・検定用）から同じ表を作る
export function tagTableFromArrays(tagsArr, fields = null) {
	const n = tagsArr.length, keys = [], keyIdx = new Map();
	const pbf = { length: n, keys: [], props: null, getProperties: (i) => Object.fromEntries(tagsArr[i]) };
	return buildTagTable(pbf, null, fields);
}
