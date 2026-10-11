// UI 文言の多言語化（英語キー・26 言語）。作法は ortho-japan の i18n.js と同じ（キー＝英語＝既定値・訳が無ければ英語のまま）。
//   const t = ...; t("Rivers") / t("Loading $1 …", name) / t("S ##size")（" ##" は文脈＝表示では捨てる）
// 辞書は 2 段：
//   ① 共有＝ortho-japan の i18n/lang/<code>.json（「Layers & themes」「Zoom in」「Roads」「Rail」「Opacity」「Lon」「Lat」
//      「Sources: 」「None」「Legend」…＝地図アプリ共通の語彙。同じ語を二度訳さない＝語彙を割らない）
//   ② equal 固有＝apps/equal/i18n/lang/<code>.json（Rivers/Graticule/Choropleth/Year/Disputed…）。同じキーは②が勝つ
// どちらも言語ごとに 1 本だけ遅延 import（英語の人に他言語の辞書を運ばせない）。将来 globe が増えたら
// ①を共有パッケージへ引き上げる（その時に 3 者で分ける）。
import LANGS from "@ortho-earth/globe/i18n/langs.js";   // 言語一覧は world が正本（japan が写しを持つ）＝ここは写しの写しを作らない
import { createI18n } from "@ortho-earth/globe/i18n/core.js";

const SHARED = import.meta.glob("../../../packages/globe/src/i18n/lang/*.json");
const OWN = import.meta.glob("../i18n/lang/*.json");
const grab = async (mods, code) => { const k = Object.keys(mods).find(p => p.endsWith(`/${code}.json`)); if (!k) return {}; try { return (await mods[k]()).default || {}; } catch { return {}; } };
const i18n = createI18n({ langs: LANGS, load: async c => { const [shared, own] = await Promise.all([grab(SHARED, c), grab(OWN, c)]); return { ...shared, ...own }; } });   // equal 固有が共有を上書き
export const { getLang, setLang, isRTL, LANGUAGES, norm, t } = i18n;
