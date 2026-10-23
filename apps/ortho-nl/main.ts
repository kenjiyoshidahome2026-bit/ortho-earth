// 中身は ortho-japan と同じエンジン（app.js）＝1行で立ち上がる。違うのは入口URL(/nl/)と既定の視点だけ。
// 日本固有のガジェット（地名検索・日本ボタン・デモ台本・太陽系への口）は載せない＝この画面はオランダ一本。
import { dismissBoot } from "@ortho-earth/globe/boot/screen.js";   // 起動画面を畳む＝正本（packages/globe/src/boot/screen.ts・全頁で 1 つ・2026-10-23）
import orthoJapan from "@ortho-earth/regions/app";   // 本番は共有エンジンの入口（regions/app.js・2026-10-14）
import { NL_PLACES, type NlPlace } from "@ortho-earth/nl";   // 街の一覧（建物の枠と同じ表＝街を足すのは region.js だけ）
orthoJapan().then(map => {
	dismissBoot();
	map.gadget.zoom();        // ズーム＋/−
	map.gadget.full();        // 全画面トグル
	map.gadget.compass();     // コンパス兼リセット（3Dの時だけ現れる）
	map.gadget.cpos();        // 現在地
	map.gadget.measure();     // 距離・面積の計測
	map.gadget.shot();        // 画面を画像で保存
	map.gadget.qr();          // この視点をQRで共有
	map.gadget.mesh();     // 建物3Dデータ管理（オランダの街もここに並ぶ）
	map.gadget.contextmenu(); // 右クリックメニュー
	map.gadget.dropFile();    // GISファイルのD&D取り込み
	map.gadget.hint();        // 操作説明カード
	// 配色テーマ切替（palette）は載せない＝基図が外来 style（OpenFreeMap）＝テーマは背景と建物色にしか効かない
	// 街のボタン＝建物を切ってある街へ飛ぶ。今いる街（画面中心が枠の中）を点す
	const nav = document.createElement("nav");
	nav.id = "nl-places"; nav.setAttribute("aria-label", "Cities");
	const inside = (p: NlPlace, c: { lng: number; lat: number }) => c.lng >= p.bbox[0] && c.lng <= p.bbox[2] && c.lat >= p.bbox[1] && c.lat <= p.bbox[3];
	const mark = () => { const c = map.getCenter(); NL_PLACES.forEach((p, i) => nav.children[i].setAttribute("aria-pressed", inside(p, c) as unknown as string)); };   // as＝setAttribute は真偽を "true"/"false" の字にして受ける
	for (const p of NL_PLACES) {
		const b = document.createElement("button");
		b.type = "button"; b.textContent = p.name;
		b.addEventListener("click", () => Promise.resolve(map.flyTo(...p.view)).then(mark, mark));
		nav.append(b);
	}
	(document.getElementById("map") || document.body).append(nav);
	mark(); map.on("settle", mark);   // 止まるたび＝今いる都市のボタンを押し込む（旧 "moveend" は GlobeMap に無い名で一度も呼ばれなかった）
}).catch(e => import("@ortho-earth/globe/page.js").then(m => m.startupFailed("nl", e), () => { console.error("[nl] startup failed", e); dismissBoot(); }));   // 起動失敗＝画面に言葉で（共通の器・2026-10-04）＝旧は catch 無し＝起動画面が永久に残った
if (location.protocol === "https:" && "serviceWorker" in navigator)
	addEventListener("load", () => navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).catch(e => console.warn("[sw] 登録失敗", e)));
