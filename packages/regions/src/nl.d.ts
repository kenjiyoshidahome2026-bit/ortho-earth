// @ortho-earth/nl（packages/nl・まだ JS）の最小の型宣言＝この包みが使う 4 つだけ（2026-10-15・TS 化 段 3 batch B）。
// nl が TS になった時（batch A）はこのファイルを消して nl の exports の型に乗る。
declare module "@ortho-earth/nl" {
	import type { OrthoJapanOptions } from "@ortho-earth/globe";
	/** オランダの地域宣言（jp の JpRegion と同じ形・globe の opts.region に渡す） */
	export const NL_REGION: object;
	/** 外来の標高タイル（Mapterhorn・terrarium）＝globe の opts.terrain と同じ形 */
	export const NL_TERRAIN: Exclude<OrthoJapanOptions["terrain"], false | undefined>;
	/** 基図の MapLibre style（OpenFreeMap）。取れなければ null＝基図なしで起動 */
	export function nlStyle(): Promise<Record<string, unknown> | null>;
	/** "only"＝/nl/（独立）／"with-jp"＝?nl=1（重ね）／null＝日本 */
	export function nlEntry(): "only" | "with-jp" | null;
}
