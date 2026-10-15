// @ortho-earth/japan（SDK）の入口（npm・zip・/japan/lib/）。中身は packages/regions/src/app.ts（orthoJapan）。
// 公開面はこのファイル＝default orthoJapan・createGlobe・geopbf・Marker・Popup・addProtocol・removeProtocol（型は packages/globe/globe.d.ts＋scripts/build-dts.mjs）。
// 実行時アセット（plateau-sets.json 等）の既定は BASE_URL＝"./"（ページ相対）。利用者は assetBase で指し直す。
// 2026-10-15：日本のサイト（apps/ortho-japan）から SDK を sdk/japan へ分けた＝サイトは自分の app.js を持つ。
import orthoJapanCore, { createGlobe, geopbf, Marker, Popup, addProtocol, removeProtocol } from "@ortho-earth/regions/app";
export { createGlobe, geopbf, Marker, Popup, addProtocol, removeProtocol };
export default function orthoJapan(opts = {}) {
	return orthoJapanCore({ ...opts, assetBase: opts.assetBase ?? import.meta.env.BASE_URL });
}
