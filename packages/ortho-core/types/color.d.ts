// @ortho-earth/core/color — CSS 色の解釈。
/** CSS 色文字列 → [r, g, b, a]（0..1）。解釈できなければ null。 */
export function parseRGBA(s: string): [number, number, number, number] | null;
export function isColor(s: unknown): boolean;
