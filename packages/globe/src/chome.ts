// 町丁名の二系統を畳む＝Anno の 210「下落合（三）」と 800「下落合三丁目」は同じ町丁の別表記（globe.ts の rebuildLabels が使う）。
// 表記は（N）へ統一し、210 と重なる 800 は捨てる。残った 800 は code を 210 に化かす（説明の続きは globe.ts の mergeChome の上）。
// 旧＝globe.ts の中にあり、実タイルの検査（apps/ortho-japan の t-chome.mjs）は globe.ts の文字列を切り出して評価していた＝周りが動くたびに壊れた（2026-10-17 に別モジュールへ）。
import { labelKey } from "@ortho-earth/core/labelsync";
import { CHOME800_MINZOOM } from "./themes.ts";

/** 畳み込みに要る注記の項（globe.ts の HostLabel はこれを含む） */
export interface MergeLabel { code: number; text: string; anchor: readonly number[]; key?: string | null }

export const chomeCanon = (t: string) => t.replace(/[（(]([一二三四五六七八九十百]+)[)）]$/, "$1丁目");   // 突合キー＝正式表記へ寄せる
// 表示＝（N）へ（丁目の無い町名はそのまま）。旧＝t.replace(/([一二三四五六七八九十百]+)丁目$/, "（$1）")＝漢数字の長い並びで多項式（CodeQL）＝末尾から数えるのと同じ
export const chomeShort = (t: string) => { if (!t.endsWith("丁目")) return t; const e = t.length - 2; let i = e; while (i > 0 && "一二三四五六七八九十百".includes(t[i - 1])) i--; return i < e ? t.slice(0, i) + "（" + t.slice(i, e) + "）" : t; };
const nearAnchor = (list: (readonly number[])[] | undefined, a: readonly number[], m: number) => {   // list（経緯度の列）に a から m メートル以内の点があるか
	if (!list) return false;
	const cos = Math.cos(a[1] * Math.PI / 180);
	return list.some(p => Math.hypot((p[0] - a[0]) * 111320 * cos, (p[1] - a[1]) * 111320) < m);
};
const chomeCopies = new WeakMap<MergeLabel, MergeLabel>();   // 800 の元 → （N）表記の写し（文字が変わる＝鍵も付け直す）
function chomeCopy<L extends MergeLabel>(L: L): L { let c = chomeCopies.get(L) as L | undefined; if (!c) { c = { ...L, text: chomeShort(L.text), code: 210 }; c.key = labelKey({ ...c, key: undefined }); chomeCopies.set(L, c); } return c; }
export function mergeChome<L extends MergeLabel>(all: L[], zoom: number): L[] {
	if (!all.some(L => L.code === 800)) return all;   // 800 が来ないズーム/地域＝素通り（配列コピーもしない）
	if (zoom < CHOME800_MINZOOM) return all.filter(L => L.code !== 800);
	const by = new Map<string, (readonly number[])[]>();   // 210 の正規化名 → アンカー列（同名の町丁が全国に居るので位置でも裁く）
	for (const L of all) if (L.code === 210) {
		const k = chomeCanon(L.text);
		let a = by.get(k); if (!a) by.set(k, a = []);
		a.push(L.anchor);
	}
	const seen = new Map<string, (readonly number[])[]>();   // 出した町丁名 → アンカー列（同じ注記が隣タイルにも入っている分の重複よけ）
	const out: L[] = [];
	for (const L of all) {
		if (L.code !== 800 && L.code !== 210) { out.push(L); continue; }
		const k = chomeCanon(L.text);
		// 1km＝同じ町丁の 210/800 のアンカーずれ（実測で最大300m級）は確実に拾い、
		// 同名の別の町（「本町一丁目」等は全国にある）は拾わない距離。
		if (L.code === 800 && nearAnchor(by.get(k), L.anchor, 1000)) continue;   // 210 が既に出す町丁＝そちらに任せる
		// 30m＝「同じ注記が二度来た」だけを消す距離。GSI は境界の注記を隣タイルにも入れており、
		// 800 は件数が桁違いなので実害が出る（実測 z16 市中心5km四方の同名30m以内ペア：札幌104・京都230。
		// うち大半は距離5m未満＝完全な同一点）。長い町丁を両端に打った正規の二つ（数百m離れ）は残る。
		if (nearAnchor(seen.get(k), L.anchor, 30)) continue;
		let a = seen.get(k); if (!a) seen.set(k, a = []);
		a.push(L.anchor);
		out.push(L.code === 800 ? chomeCopy(L) : L);   // コピー＝タイル側のラベルキャッシュを壊さない（同じ元には同じ写し＝worker へ送り直さない）
	}
	return out;
}
