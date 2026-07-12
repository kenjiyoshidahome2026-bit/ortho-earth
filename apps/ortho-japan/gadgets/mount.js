// ガジェット搭載（DOM自給化）：標準装備のUIをここから #map へ生やす。
// 順序が重なり（z-index全廃＝DOM順の裁き）：チップ→計器盤。
// 検索・操作説明・コンパスは標準装備から外れオプトイン＝orthoJapan() の戻り値から
// map.gadget.search() / map.gadget.hint() / map.gadget.compass()（v1 ortho-map の gadget 作法）。
// オプトイン勢の置き場所は左上の #gadgets スタック（stack.js）＝搭載順に縦積み・非表示は上詰め。
// 標準装備も起動パラメータで表示/非表示を選べる（既定＝全部表示）。どちらも同じ文法＝
// true=全部／配列=選択的／false=出さない：
//   chips＝テーマ・チップ（例: ["chimei","rail"]。キーは chips.js の CHIPS 台帳）
//   instruments＝下部の計器盤（例: ["scale","attr"]。キー="pos","scale","attr","log"）
import { mountChips } from "./chips.js";
import { mountInstruments } from "./instruments.js";
export function mountGadgets(mapEl, { chips = true, instruments = true } = {}) {
	if (chips) mountChips(mapEl, chips);
	if (instruments) mountInstruments(mapEl, instruments);
}
