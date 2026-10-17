// 鳥獣の捕獲記録（捕獲報告アプリの書き出し 2024-12〜・約 1.6 万件）を日本の 3D 地図に。獣種で色分け・利用区分（ジビエ／廃棄）・捕獲日・市区町村で絞る。
// このページは器だけ：@ortho-earth/regions/app（orthoJapan＝本番は共有エンジンの入口 regions/app.js）でエンジンを起こし、描画と案内板は ./choju.ts（遅延 chunk）。www のデモ一覧には載せない単独の頁。
// データ＝GitHub Pages の ortho-data/japan/choju/ の captures.csv・munis.csv（dev は手元の正本・vite.config の __DATA_JAPAN__）。?data=URL（CSV 2 本の置き場・末尾 /）で差し替え。
// UI は日本語のみ（日本の自治体の捕獲記録）。head は英語（共有カードと検索が読む）
import { startPage } from "@ortho-earth/globe/page.js";
startPage("choju", async () => {
	const [{ default: orthoJapan }, { mountChoju }] = await Promise.all([import("@ortho-earth/regions/app"), import("./choju.ts")]);
	// 初期視点＝日本列島を少し傾けて眺める（共有 URL の hash があればそちら）。建物 3D・施設・鉄道・道路は出さない（捕獲の点が主役）
	const map = await orthoJapan({ target: "#map", view: location.hash || "#4.6/36.0/137.5/25t", chips: false, mesh: false, lang: "ja",
		layers: { terrain: false, facility: false, rail: false, road: false }, instruments: ["pos", "scale", "attr"], urlHash: true });
	map.gadget.zoom(); map.gadget.compass(); map.gadget.full(); map.gadget.shot(); map.gadget.hint();
	const choju = await mountChoju(map, { base: new URLSearchParams(location.search).get("data") || __DATA_JAPAN__ + "choju/" });
	window.__map = map; window.__choju = choju;   // console 検証用
	return map;
}, { lang: "ja" });
