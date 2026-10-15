// @ortho-earth/core/color — CSS 色の解釈。
/** [r, g, b, a]（0..1）。parseRGBA の戻りは覚え書き（memo）の凍った配列＝書き換えない。 */
export type RGBA = readonly [number, number, number, number];
/** 解釈済みの色（配列）はそのまま返す（式の評価器が色を二度通す時の素通し）。 */
export function parseRGBA<T extends readonly number[]>(s: T): T;
/** CSS 色文字列 → [r, g, b, a]（0..1）。読めない色・文字列でない物は黒 [0, 0, 0, 1]（null は返さない）。 */
export function parseRGBA(s: unknown): RGBA;
export function isColor(s: unknown): boolean;
