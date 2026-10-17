// 雲ビューア＝いまの雲（静止気象衛星 3 機の赤外画像・NASA GIBS 直読み）を地球儀の高度 10 km の殻に貼る（試作 2026-09-29）。
// このページは器だけ（sats.html と同型）：地球儀のホスト（@ortho-earth/globe・地域なし）を自分の束に焼いてエンジンを起こし、
// 読み込みと案内板は ./clouds.js（遅延 chunk・GPU 描画は clouds-gl.js＝レンダーワーカー内の同一フレーム）。
// ?lv=2..5（GIBS の段＝細かさ・既定 3／非力機 2）・?vol=0（高さなし＝殻 1 枚）・?alt=<km>（殻の高度・既定 10）・?perf=1（描画時間を console へ）
// 言語（html の lang/dir）・起動画面・起動失敗の表示＝共通の器（@ortho-earth/globe/page.js）。文言は clouds.js が t() で組む
import { startPage, dismissBoot } from "@ortho-earth/globe/page.js";
startPage("clouds", async () => {
	const [{ createGlobe }, { mountClouds }] = await Promise.all([import("@ortho-earth/globe"), import("./clouds.js")]);
	// 初期視点＝Himawari の直下（日本と西太平洋）を少し引いて眺める（共有 URL の hash があればそちら）
	const map = await createGlobe({ target: "#map", view: location.hash || "#2.3/28/140", chips: false, zoomMax: 8,
		mesh: false, glOverlay: true, countryTip: false, instruments: ["pos", "scale", "attr"], urlHash: true, persistView: false });
	dismissBoot();
	map.gadget.zoom(); map.gadget.compass(); map.gadget.full(); map.gadget.shot(); map.gadget.hint(); map.gadget.clock(); map.gadget.lang();   // clock＝共通の時計（#42）＝雲の昼夜も同じ時刻
	const q = new URLSearchParams(location.search);
	const clouds = await mountClouds(map, { level: q.has("lv") ? +q.get("lv")! : undefined, alt: q.has("alt") ? +q.get("alt")! * 1000 : 10000, vol: q.get("vol") !== "0", perf: q.get("perf") === "1" } as Parameters<typeof mountClouds>[1]);   // 引数の型＝JS 本体の既定値からの推論（既定値の無い欄・null 既定は狭く出る）＝呼び口で JS の口に合わせる
	window.__map = map; window.__clouds = clouds;   // console 検証用
});
