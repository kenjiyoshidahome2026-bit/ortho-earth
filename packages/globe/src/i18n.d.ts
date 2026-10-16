// i18n.js（JS のまま）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 1）＝i18n.js が TS になれば消える。
// （equal は自分の ambient.d.ts で @ortho-earth/globe/i18n.js を宣言している＝そちらが勝つ。ここは globe の中から読む時の型）

/** t("Loading $1 …", name)＝英語キー・$n 置換・" ##" 以降は文脈（表示では捨てる） */
export type Translate = (key: string, ...args: Array<string | number>) => string;
/** 今の言語の訳す関数 */
export function tr(): Translate;
/** 今の UI 言語（"ja"・"en" …） */
export function getLang(): string;
