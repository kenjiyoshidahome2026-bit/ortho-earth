// @ortho-earth/core/viewurl — 共有 URL の hash（エンジンの z の文字列 "#z/lat/lon[/45t][/-30r][/15roll][/l=a.b][/c=dark][/t=…Z][/s=n][/c]"）。
import type { CameraPose } from "./camera.js";
export const wrapLon: (lon: number) => number;
/** parseViewHash の戻り。角はラジアン。layers＝l= の集合（null＝未指定・[]＝全 OFF）。time＝t=（UTC 文字列）・speed＝s=。 */
export interface ParsedView {
	zoom: number; lat: number; lon: number;
	pitch: number; bearing: number; roll: number;
	layers: string[] | null; contour: boolean; theme: string | null; time: string | null; speed: number | null;
}
/** "#5/35.7/139.7/45t/60r" などを読む。3 項に満たない・数でなければ null。 */
export function parseViewHash(h: string): ParsedView | null;
/** 現在ビュー → hash。既定と同じ項（pitch 0・bearing 0・roll 0）は書かない。extras＝アプリ固有の後置トークン。 */
export function buildViewHash(cam: CameraPose, extras?: string[]): string;
