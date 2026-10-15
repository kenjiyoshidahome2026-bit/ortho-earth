// orthoJapan＝「globe（地球儀のホスト）＋日本の申告」の薄い包み（LAYERS.md 段階 2・2026-09-23）。
// 置き場＝packages/jp（2026-10-14・旧 apps/ortho-japan/app.js＝census2020・choju・ortho-nl・gishub-jp が japan アプリの中を読んでいた）。
// 本番は共有エンジンの入口（/globe/engine/<版>/jp/app.js）＝5 アプリが同じ 1 つを読む（各アプリに焼かない・本人 2026-10-14）。
// 地域の選び方（URL：/nl/・?nl=1・既定は日本）はここだけが知る。ホスト（@ortho-earth/globe の createGlobe）は opts.region しか見ない＝地域名を知らない。
// SDK の公開面はこのファイル＝default orthoJapan・createGlobe・geopbf・Marker・Popup・addProtocol・removeProtocol（型は packages/globe/globe.d.ts＋SDK の入口＝scripts/build-dts.mjs）。
import { createGlobe, geopbf, Marker, Popup, addProtocol, removeProtocol } from "@ortho-earth/globe";   // 地球儀のホスト（packages/globe・S4 2026-09-23）
import { JP_REGION } from "@ortho-earth/jp/region";   // 日本の地域パック＝その国の知識の正本。入口（index）でなく region 直＝POI・N02 の実装を起動のバンドルに載せない
import { NL_REGION, NL_TERRAIN, nlEntry, nlStyle } from "@ortho-earth/nl";   // オランダの地域宣言（packages/nl）
export { createGlobe, geopbf, Marker, Popup, addProtocol, removeProtocol };
const ASSETS_DIR = "../assets/";   // 変数で渡す＝vite の new URL(リテラル) 解析（実体を探して束に入れる）を通さない
const JP_ASSETS = new URL(ASSETS_DIR, import.meta.url).href;
export default function orthoJapan(opts = {}) {
	// 実行時アセット（plateau-sets.json・airports.json 等＝packages/jp/assets）の既定＝この包みの隣の assets/（2026-10-14・旧＝束ねたアプリの BASE_URL）。
	// 共有エンジンでは jp/app.js（か共有チャンク assets/*.js）の 1 つ上の assets/＝/globe/engine/<版>/assets/（エンジンの build が複写）・dev は packages/jp/assets/。
	// SDK（apps/ortho-japan/app.js）は従来どおり自分の BASE_URL を渡す。
	opts = { ...opts, assetBase: opts.assetBase ?? JP_ASSETS };
	if (opts.region !== undefined) return createGlobe(opts);   // 申告を持参＝そのまま
	const nlMode = nlEntry();                                    // "only"=/nl/（独立）／"with-jp"=?nl=1（重ね）／null=日本
	if (nlMode === "only") {
		// /nl/＝基図は外来 style（OpenFreeMap）・標高は外来の標高タイル（Mapterhorn）＝どちらも地域の申告（nl/region.js）から。
		// 呼び手の opts と URL（?style= ?pm= ?dem=）が先＝持ち込みを上書きしない。style の取得だけ起動の前に待つ（落ちていれば基図なしで起動）
		const q = new URLSearchParams(location.search);
		const own = opts.style === undefined && !q.has("style") && !q.has("pm");
		return (own ? nlStyle() : Promise.resolve(null)).then(style => createGlobe({
			...opts, region: [NL_REGION],
			...(style ? { style } : {}),
			...(opts.terrain === undefined && !q.has("dem") ? { terrain: NL_TERRAIN } : {}),
		}));
	}
	return createGlobe({ ...opts, region: nlMode === "with-jp" ? [JP_REGION, NL_REGION] : [JP_REGION] });
}
