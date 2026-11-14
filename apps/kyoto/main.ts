// 京都市デジタルツイン（/kyoto/・2026-11-14）。3D 都市モデル（PLATEAU）の京都に、暮らし（地区・公共施設・わが家のまわり）・交通（地下鉄・市バス・鉄道）・観光（名所・歴史の物語）・防災（ハザード・避難場所）・解析を重ねる。
// このページは器だけ：@ortho-earth/regions/app（orthoJapan＝本番は共有エンジンの入口 regions/app.js）でエンジンを起こし、案内板と機能は共有モジュール @ortho-earth/citytwin（横浜市と同じ芯・共有エンジンの入口 citytwin/index.js・遅延）に京都の設定（./data.ts の CITY）を渡す。
// 建物は PLATEAU の配信・ハザードは地理院タイル・避難場所は census2020 と同じ焼き（bucket bousai/hinan/26）をブラウザが直に取る。
// 区の境界・鉄道・バス停・公共施設・名所の写真＝GitHub Pages の ortho-data/japan/kyoto/（dev は手元の正本・vite.config の __DATA_JAPAN__）。?data=URL（末尾 /）で差し替え。
// UI は 26 言語（英語キー・共通の辞書 packages/citytwin/i18n/pages/citytwin.json＋京都の辞書 i18n/pages/kyoto.json・地図の言語ボタン）。head は英語（共有カードと検索が読む）
import { startPage } from "@ortho-earth/globe/page.js";
import { CITY_VIEW, CITY } from "./data.ts";
import type { CarmenFeature } from "@ortho-earth/globe";
import { bootWorkersFromPack } from "@ortho-earth/citytwin/boot";
bootWorkersFromPack();   // 通信なしの起動＝エンジンの worker を SW 経由（端末の束）で起こす。エンジンを読む前に（2026-11-13）
startPage("kyoto", async () => {
	const [{ default: orthoJapan }, { mountTwin }] = await Promise.all([import("@ortho-earth/regions/app"), import("@ortho-earth/citytwin")]);
	// 初期視点＝京都市の全景（twin が続けて「市全体」＝市を画面の 9 割に収める平面の地区図にする・本人 2026-10-26）。共有 URL の hash があればそちら
	const v = CITY_VIEW;
	const map = await orthoJapan({ target: "#map", view: location.hash || `#${v.zoom}/${v.lat}/${v.lon}`,
		instruments: ["pos", "scale", "attr"], urlHash: true,
		layers: { facility: false } });   // 基図の施設名は封印＝公共施設の点と名が被る（本人 2026-10-26「基図の施設名は被るから外しましょう」）
	// 地名検索＝地理院（通信が要る）＋京都の台帳（名所・駅・施設・町丁目＝通信なしでも引ける・英語名でも当たる・完全オフライン 2026-11-12）。
	// 台帳は通信のある時も並べる（地理院は英語で引けず、「綱島」の 1 件目が長崎県だった・Mac 本番 2026-11-12）
	let twinRef: { offlineSearch(q: string): Promise<CarmenFeature[]> } | null = null;
	map.gadget.search({ localGeocoder: q => twinRef ? twinRef.offlineSearch(q) : [] });
	map.gadget.zoom(); map.gadget.compass(); map.gadget.full(); map.gadget.shot(); map.gadget.qr(); map.gadget.sunshadow(); map.gadget.hint(); map.gadget.lang();
	const twin = await mountTwin(map, CITY, { base: new URLSearchParams(location.search).get("data") || __DATA_JAPAN__ + "kyoto/", appBase: import.meta.env.BASE_URL });
	twinRef = twin;
	window.__map = map; window.__twin = twin;   // console 検証用
	return map;
}, { page: c => import(`./i18n/lang/kyoto/${c}.json`) });   // 26 言語＝言語は URL の ?lang= かブラウザ。頁の辞書＝i18n/pages/kyoto.json
// サービスワーカー（public/sw.js→packages/globe/scripts/lib/sw.js＝各アプリ共通）：ビルド資産を Cache API で握る＋端末に保存した束（oj-pack-kyoto）を
// 通信なしで配る（完全オフライン・本人 2026-11-12）。?nosw=1 で外す
if ((location.protocol === "https:" || location.hostname === "localhost") && !/[?&]nosw=1/.test(location.search) && "serviceWorker" in navigator)
	addEventListener("load", () => navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).catch(e => console.warn("[sw] register failed", e)));
