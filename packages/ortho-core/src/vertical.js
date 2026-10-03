// 縦書き（MapLibre の text-writing-mode "vertical"・2026-10-03 互換の段）＝字の向きと句読点の縦の形。
// MapLibre の util/script_detection（charHasUprightVerticalOrientation）と util/verticalize_punctuation の写し（要点）：
//   upright＝縦書きで正立のまま並ぶ字（漢字・かな・ハングル・全角・CJK の記号）。それ以外（ラテン・数字・空白）は 90° 回して並ぶ。
//   縦書きにできる文字列＝正立の字を 1 つでも含む（allowsVerticalWritingMode）。
export function charUpright(cp) {
	if (cp < 0x1100) return false;
	return (cp >= 0x1100 && cp <= 0x11FF)     // ハングル字母
		|| (cp >= 0x2E80 && cp <= 0x2FDF)     // CJK 部首・康熙部首
		|| (cp >= 0x2FF0 && cp <= 0x303F)     // 漢字構成・CJK の記号と句読点
		|| (cp >= 0x3040 && cp <= 0x30FF && cp !== 0x30FC)     // ひらがな・カタカナ（長音「ー」は回す＝縦の長音）
		|| (cp >= 0x3100 && cp <= 0x31BF)     // 注音・ハングル互換字母・漢文・かな拡張
		|| (cp >= 0x31C0 && cp <= 0x33FF)     // CJK 筆画・片仮名拡張・囲み CJK・CJK 互換
		|| (cp >= 0x3400 && cp <= 0x4DBF)     // 漢字拡張 A
		|| (cp >= 0x4E00 && cp <= 0x9FFF)     // 漢字
		|| (cp >= 0xA000 && cp <= 0xA4CF)     // 彝
		|| (cp >= 0xA960 && cp <= 0xA97F)     // ハングル字母拡張 A
		|| (cp >= 0xAC00 && cp <= 0xD7FF)     // ハングル音節・字母拡張 B
		|| (cp >= 0xF900 && cp <= 0xFAFF)     // CJK 互換漢字
		|| (cp >= 0xFE10 && cp <= 0xFE1F)     // 縦書き形
		|| (cp >= 0xFE30 && cp <= 0xFE4F)     // CJK 互換形
		|| (cp >= 0xFF01 && cp <= 0xFF60)     // 全角（英数・記号）
		|| (cp >= 0xFFE0 && cp <= 0xFFE6)     // 全角の通貨
		|| (cp >= 0x20000 && cp <= 0x3134F);  // 漢字拡張 B〜G
}
export const allowsVertical = text => { for (const ch of String(text)) if (charUpright(ch.codePointAt(0))) return true; return false; };
// 句読点の縦の形（MapLibre の verticalizedCharacterMap）＋長音「ー」→「｜」
const VMAP = { "!": "︕", "#": "＃", "$": "＄", "%": "％", "&": "＆", "(": "︵", ")": "︶", "*": "＊", "+": "＋", ",": "︐", "-": "︲", ".": "・", "/": "／", ":": "︓", ";": "︔", "<": "︿", "=": "＝", ">": "﹀", "?": "︖", "@": "＠", "[": "﹇", "\\": "＼", "]": "﹈", "^": "＾", "_": "︳", "`": "｀", "{": "︷", "|": "―", "}": "︸", "~": "～",
	"¢": "￠", "£": "￡", "¥": "￥", "¦": "￤", "¬": "￢", "¯": "￣", "–": "︲", "—": "︱", "‘": "﹃", "’": "﹄", "“": "﹁", "”": "﹂", "…": "︙", "‧": "・", "₩": "￦", "、": "︑", "。": "︒", "〈": "︿", "〉": "﹀", "《": "︽", "》": "︾", "「": "﹁", "」": "﹂", "『": "﹃", "』": "﹄", "【": "︻", "】": "︼", "〔": "︹", "〕": "︺", "〖": "︗", "〗": "︘",
	"！": "︕", "（": "︵", "）": "︶", "，": "︐", "－": "︲", "．": "・", "：": "︓", "；": "︔", "＜": "︿", "＞": "﹀", "？": "︖", "［": "﹇", "］": "﹈", "＿": "︳", "｛": "︷", "｜": "―", "｝": "︸", "｟": "︵", "｠": "︶", "｡": "︒", "｢": "﹁", "｣": "﹂", "ー": "｜", "〜": "｜" };
export const verticalize = ch => VMAP[ch] ?? ch;
// 縦書きで字が回るか（正立でない＝90° 回して並ぶ）。縦の形へ写した句読点は正立
export const charRotated = ch => !charUpright(verticalize(ch).codePointAt(0));
