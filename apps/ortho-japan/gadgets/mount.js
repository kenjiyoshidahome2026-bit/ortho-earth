// ガジェット搭載（DOM自給化）：標準装備のUIをここから #map へ生やす。
// 順序が重なり（z-index全廃＝DOM順の裁き）：チップ→計器盤。
// 検索・操作説明・コンパスは標準装備から外れオプトイン＝orthoJapan() の戻り値から
// map.gadget.search() / map.gadget.hint() / map.gadget.compass()（v1 ortho-map の gadget 作法）。
// オプトイン勢の置き場所は左上の #gadgets スタック（stack.js）＝搭載順に縦積み・非表示は上詰め。
// 標準装備も起動パラメータで表示/非表示を選べる（既定＝全部表示）：
//   chips＝テーマ・チップ帯（true=搭載[既定]／false=出さない。旧配列形式=選択的は後方互換・非推奨）
//   fixedLayers＝opts.layers で固定されたキー（true/false とも）＝該当ボタンを出さない
//   instruments＝下部の計器盤（true=全部／配列=選択的（例: ["scale","attr"]）／false=出さない）
import { mountChips } from "./chips.js";
import { mountInstruments } from "./instruments.js";
export function mountGadgets(mapEl, { chips = true, instruments = true, fixedLayers = {} } = {}) {
	if (chips) mountChips(mapEl, chips, fixedLayers);
	if (instruments) mountInstruments(mapEl, instruments);
}
