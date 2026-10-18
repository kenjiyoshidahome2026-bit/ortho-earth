// 横浜市デジタルツイン（/yokohama/）。3D 都市モデル（PLATEAU）の横浜に、防災（ハザード・避難場所）・時間（年代の航空写真・影・日影図）・解析（可視域・断面・歩行・計測）を重ねる。
// このページは器だけ：@ortho-earth/regions/app（orthoJapan＝本番は共有エンジンの入口 regions/app.js）でエンジンを起こし、案内板と機能は ./twin.ts（遅延 chunk）。
// データは焼かない＝建物は PLATEAU の配信・写真とハザードは地理院タイル・避難場所は census2020 と同じ焼き（bucket bousai/hinan）をブラウザが直に取る。
// UI は日本語のみ（横浜市の頁）。head は英語（共有カードと検索が読む）
import { startPage } from "@ortho-earth/globe/page.js";
import { CITY_VIEW } from "./data.ts";
startPage("yokohama", async () => {
	const [{ default: orthoJapan }, { mountTwin }] = await Promise.all([import("@ortho-earth/regions/app"), import("./twin.ts")]);
	// 初期視点＝横浜市の全景を少し傾けて（共有 URL の hash があればそちら）。建物 3D・施設・鉄道・道路は利用者がチップで選べるまま
	const v = CITY_VIEW;
	const map = await orthoJapan({ target: "#map", view: location.hash || `#${v.zoom}/${v.lat}/${v.lon}/${v.tilt}t`, lang: "ja",
		instruments: ["pos", "scale", "attr"], urlHash: true });
	map.gadget.search(); map.gadget.zoom(); map.gadget.compass(); map.gadget.full(); map.gadget.shot(); map.gadget.qr(); map.gadget.sunshadow(); map.gadget.hint();
	const twin = await mountTwin(map);
	window.__map = map; window.__twin = twin;   // console 検証用
	return map;
}, { lang: "ja" });
