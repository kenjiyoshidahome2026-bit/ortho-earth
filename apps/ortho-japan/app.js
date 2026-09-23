// ortho-japan＝「globe（地球儀のホスト）＋日本の申告」の薄い包み（LAYERS.md 段階 2・2026-09-23）。
// 地域の選び方（URL：/nl/・?nl=1・既定は日本）はここだけが知る。ホスト（@ortho-earth/globe の createGlobe）は opts.region しか見ない＝地域名を知らない。
// SDK の公開面はこのファイル＝default orthoJapan・createGlobe・geopbf・Marker・Popup・addProtocol・removeProtocol（型は sdk/ortho-japan.d.ts）。
import { createGlobe, geopbf, Marker, Popup, addProtocol, removeProtocol } from "@ortho-earth/globe";   // 地球儀のホスト（packages/globe・S4 2026-09-23）
import { JP_REGION } from "@ortho-earth/jp/region";   // 日本の地域パック＝その国の知識の正本。入口（index）でなく region 直＝POI・N02 の実装を起動のバンドルに載せない
import { NL_REGION, nlEntry } from "./nl/region.js";
export { createGlobe, geopbf, Marker, Popup, addProtocol, removeProtocol };
export default function orthoJapan(opts = {}) {
	if (opts.region !== undefined) return createGlobe(opts);   // 申告を持参＝そのまま
	const nlMode = nlEntry();                                    // "only"=/nl/（独立）／"with-jp"=?nl=1（重ね）／null=日本
	return createGlobe({ ...opts, region: nlMode === "only" ? [NL_REGION] : nlMode === "with-jp" ? [JP_REGION, NL_REGION] : [JP_REGION] });
}
