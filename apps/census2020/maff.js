// 筆ポリゴン（農林水産省 筆ポリゴンオープンデータ）＝moj.js と同格の読み込み口。
// gishub-jp maff と同一資産＝焼き済み GeoPBF（bucket GIS/pbf・maff_{6桁}.geopbf・1869市区町村・2026年度）を
// レガシー geopbf の server.load 規約で直読み＝自動IDBキャッシュ（2回目はネットワーク0・焼きゼロ）。
// moj の3段ラダーと違い経路は1本：在庫は data/maff-codes.json（gen-maff-codes.mjs が gishub-jp 正本から
// 焼き出す網羅表）で in-memory 判定＝network probe 不要・404を撒かない（農地の無い都心区は表に無い）。
import { geopbf } from "geopbf";
import MAFF_CODES from "./data/maff-codes.json" with { type: "json" };

// 5桁市区町村コード → 6桁（検査数字付き・MAFF/全国地方公共団体コード）。null＝未整備（農地なし含む）
const BY5 = new Map(MAFF_CODES.map(c => [c.slice(0, 5), c]));
export const maffCode = code => BY5.get(code) ?? null;

// 筆ポリゴンのロード → GeoPBF（unPackGint 済み）。onStatus は進捗の一行表示用
export async function loadMaff(code, { onStatus } = {}) {
	const c6 = BY5.get(code);
	if (!c6) return null;
	onStatus?.("筆ポリゴン取得中…（初回のみ）");
	const pbf = await geopbf(`maff_${c6}.geopbf`, { gint: true, name: `maff/${code}` }).catch(e => { console.warn("[maff]", e); return null; });
	return pbf?.unPackGint ? pbf : null;
}
