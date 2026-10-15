// @ortho-earth/regions/app（packages/regions/src/app.js・private・JS のまま）の型＝公開面は @ortho-earth/globe の globe.d.ts と同じ。
// regions が .ts になったらこの宣言は外す（実体の型が勝つ）。
declare module "@ortho-earth/regions/app" {
	import type { OrthoJapanMap, OrthoJapanOptions } from "@ortho-earth/globe";
	export { createGlobe, geopbf, Marker, Popup, addProtocol, removeProtocol } from "@ortho-earth/globe";
	/** 1行で地球儀が立ち上がる入口（globe＋日本の申告）。await 必須 */
	export default function orthoJapan(opts?: OrthoJapanOptions): Promise<OrthoJapanMap>;
}
