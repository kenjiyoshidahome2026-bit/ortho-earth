// ortho-japan の SDK の入口（/japan/lib/・npm）と japan のサイトの頁が読む口。中身は packages/regions/src/app.js（orthoJapan・2026-10-14 に移した）。
// SDK の公開面はこのファイル＝default orthoJapan・createGlobe・geopbf・Marker・Popup・addProtocol・removeProtocol（型は packages/globe/globe.d.ts＋SDK の入口＝scripts/build-dts.mjs）。
// 実行時アセット（plateau-sets.json 等）の既定は従来どおり自分の BASE_URL（SDK の利用者は assetBase で指し直す・japan のサイトは /japan/ の public）。
import orthoJapanCore, { createGlobe, geopbf, Marker, Popup, addProtocol, removeProtocol } from "@ortho-earth/regions/app";
export { createGlobe, geopbf, Marker, Popup, addProtocol, removeProtocol };
export default function orthoJapan(opts = {}) {
	return orthoJapanCore({ ...opts, assetBase: opts.assetBase ?? import.meta.env.BASE_URL });
}
