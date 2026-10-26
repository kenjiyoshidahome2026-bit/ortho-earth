// 横浜市デジタルツイン（/yokohama/）。3D 都市モデル（PLATEAU）の横浜に、観光（地区・名所・公共施設）・交通（地下鉄・市営バス・鉄道）・防災（ハザード・避難場所）・解析（可視域・断面・歩行・計測・影）を重ねる。
// このページは器だけ：@ortho-earth/regions/app（orthoJapan＝本番は共有エンジンの入口 regions/app.js）でエンジンを起こし、案内板と機能は ./twin.ts（遅延 chunk）。
// 建物は PLATEAU の配信・ハザードは地理院タイル・避難場所は census2020 と同じ焼き（bucket bousai/hinan）をブラウザが直に取る。
// 区の境界・鉄道・バス停・公共施設・名所の写真＝GitHub Pages の ortho-data/japan/yokohama/（dev は手元の正本・vite.config の __DATA_JAPAN__）。?data=URL（末尾 /）で差し替え。
// UI は 26 言語（英語キー・頁の辞書 i18n/pages/yokohama.json・地図の言語ボタン）。head は英語（共有カードと検索が読む）
import { startPage } from "@ortho-earth/globe/page.js";
import { CITY_VIEW } from "./data.ts";
startPage("yokohama", async () => {
	const [{ default: orthoJapan }, { mountTwin }] = await Promise.all([import("@ortho-earth/regions/app"), import("./twin.ts")]);
	// 初期視点＝横浜市の全景を真上から（twin.ts が続けて「市全体」＝市を画面の 9 割に収める平面の地区図にする・本人 2026-10-26）。共有 URL の hash があればそちら
	const v = CITY_VIEW;
	const map = await orthoJapan({ target: "#map", view: location.hash || `#${v.zoom}/${v.lat}/${v.lon}`,
		instruments: ["pos", "scale", "attr"], urlHash: true });
	map.gadget.search(); map.gadget.zoom(); map.gadget.compass(); map.gadget.full(); map.gadget.shot(); map.gadget.qr(); map.gadget.sunshadow(); map.gadget.hint(); map.gadget.lang();
	const twin = await mountTwin(map, { base: new URLSearchParams(location.search).get("data") || __DATA_JAPAN__ + "yokohama/" });
	window.__map = map; window.__twin = twin;   // console 検証用
	return map;
}, { page: c => import(`./i18n/lang/yokohama/${c}.json`) });   // 26 言語（本人 2026-10-21）＝言語は URL の ?lang= かブラウザ。頁の辞書＝i18n/pages/yokohama.json
