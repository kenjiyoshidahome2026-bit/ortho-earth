// 日本の温泉（温泉一覧＋Wikipedia 日本語版の温泉地 約 5,200 件・温泉郷 100・日本秘湯を守る会の会員宿）を日本の 3D 地図に。泉質で色分け・推定の位置は白抜き・
// 温泉郷は面・源泉が温泉地から離れている物（岳温泉など）は源泉まで破線で結ぶ。
// このページは器だけ：./app.js（本番のエンジンは共有エンジン）でエンジンを起こし、描画と案内板は ./onsen.js（遅延 chunk）。
// データ＝GitHub Pages の ortho-data/japan/onsen.json（台帳・dev は手元の正本・vite.config の __DATA_JAPAN__）＝scripts/onsen-ledger が組む。
import { dismissBoot } from "@ortho-earth/globe/boot/screen.js";   // 起動画面を畳む＝正本（packages/globe/src/boot/screen.ts・全頁で 1 つ・2026-10-23）
(async () => {
	const { setLang, getLang, isRTL } = await import("@ortho-earth/globe/i18n.js");
	await setLang();
	document.documentElement.lang = getLang(); document.documentElement.dir = isRTL() ? "rtl" : "ltr";
	const engineP = import("./app.ts");
	try {
		const [{ default: orthoJapan }, { mountOnsen }] = await Promise.all([engineP, import("./onsen.ts")]);
		// 初期視点＝日本列島を少し傾けて眺める（共有 URL の hash があればそちら）。建物 3D・基図の施設・鉄道・道路は出さない（温泉の点が主役）
		const map = await orthoJapan({ target: "#map", view: location.hash || "#4.8/36.5/137.5/25t", chips: false, mesh: false,
			layers: { terrain: false, facility: false, rail: false, road: false }, instruments: ["pos", "scale", "attr"], urlHash: true, assetBase: import.meta.env.BASE_URL });
		dismissBoot();
		map.gadget.zoom(); map.gadget.compass(); map.gadget.full(); map.gadget.shot(); map.gadget.hint(); map.gadget.lang();
		const onsen = await mountOnsen(map, { base: new URLSearchParams(location.search).get("data") || __DATA_JAPAN__ });   // ?data=URL で台帳を差し替え
		window.__map = map; window.__onsen = onsen;   // console 検証用
	} catch (e) { console.error("[onsen] startup failed", e); dismissBoot(); }
})();
