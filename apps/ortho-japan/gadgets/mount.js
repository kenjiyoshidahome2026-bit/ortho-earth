// ガジェット搭載（DOM自給化）：index.html のベタ書きを廃し、UIは全てここから #map へ生える。
// 順序が重なり（z-index全廃＝DOM順の裁き）：ヒント→検索（候補がヒントの上）→コンパス→チップ→計器盤。
import { mountHint } from "./hint.js";
import { mountSearchBox } from "./searchbox.js";
import { mountCompass } from "./compass.js";
import { mountChips } from "./chips.js";
import { mountInstruments } from "./instruments.js";
export function mountGadgets(mapEl) {
	mountHint(mapEl);
	mountSearchBox(mapEl);
	mountCompass(mapEl);
	mountChips(mapEl);
	mountInstruments(mapEl);
}
