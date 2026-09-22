// 地図パネル＝カードの地図ボタン（world の on("map") 合図）の受け口。**殻の持ち物**であって部品の中身ではない
// （world.js は「地図の実体は持たない＝外へ合図だけ」＝相手が地図でなくても成り立つ設計・2026-09-12 の裁定）。
// ここが ortho-earth のエンジン（ortho-japan の SDK 配布物）を遅延 import して、その国を **スポットライト**で指す
// ＝周りを薄い黒で覆い、国の形だけ素の地図を残す（本人 2026-09-23）。
// エンジンは一度だけ起動して使い回す＝2 か国目からは spotlight を差し替えるだけ（起動のやり直しをしない）。
// dev＝../../ortho-japan/app.js をソース直／本番＝/japan/lib/ortho-japan.js（japan 本体と同じ URL＝ブラウザキャッシュを共有）。
import { countryLayers } from "./worldlayers.js";
const LIB = "/japan/lib/ortho-japan.js";
const ZMAX = 8;   // この地図のズーム上限＝世界データ（NE 10m・ハイプソ）が持つ所まで（本人裁定 2026-09-23）
// 二股は import.meta.env.PROD を直に書く＝ビルドで true/false に畳まれて片方が消える（変数に受けると両方が束に残る）
const engineP = () => import.meta.env.PROD ? import(/* @vite-ignore */ LIB) : import("../../ortho-japan/app.js");

let paneP = null;

/** 地図パネルを開いてその国を指す。初回だけエンジンを起動する（枠は先に見せる＝待ち時間が黒画面にならない） */
export function showMap(sign = {}, { lang = "en" } = {}) {
	return (paneP ||= build({ lang })).then(p => p.show(sign));
}

async function build({ lang }) {
	if (import.meta.env.PROD) document.head.appendChild(Object.assign(document.createElement("link"), { rel: "stylesheet", href: "/japan/lib/ortho-japan.css" }));
	const pane = document.body.appendChild(Object.assign(document.createElement("div"), { id: "world-map" }));
	pane.innerHTML = `<div class="bar"><span class="title"></span><button type="button" class="close" aria-label="Close">✕</button></div><div class="host"></div>`;
	const title = pane.querySelector(".title"), host = pane.querySelector(".host");
	let open = true, spot = null, inside = null;   // 起動中も開いている扱い＝閉じられたら片付ける（inside は起動後に入る＝早い close でも TDZ にしない）
	const hide = () => { open = false; pane.classList.add("hidden"); spot?.clear(); spot = null; inside?.clear(); };
	pane.querySelector(".close").addEventListener("click", hide);
	window.addEventListener("keydown", e => { if (e.key === "Escape" && open) { e.stopPropagation(); hide(); } }, true);

	const engine = await engineP();
	const map = await engine.default({
		target: host,
		lang,                      // 一覧と同じ言語で（エンジンの言語は起動時に決まる＝map.lang は読み取り専用）
		view: "#1.6/20/0",         // 世界ビューから始めて、指された国へ飛ぶ＝「どこの国か」が動きで分かる
		region: [],                // 地域の申告なし＝globe 仕様（日本の基図・標高・出典・POI・鉄道が来ない。本人裁定 2026-09-23）
		zoomMax: ZMAX,             // 世界データが在る所まで＝ここまでハイプソ（陸の段彩）と湖と罫線で描く
		mesh: false,               // 建物3D＝国の形を見る用には要らない（カタログも worker も起こさない）
		chips: false,              // 層チップは出さない
		instruments: ["attr", "scale"],   // 出典（Natural Earth・GEBCO・Beck et al.）は残す＝データの礼儀
		countryTip: false,         // 一覧側の tip と混ぜない
		persistView: false,        // /japan/ の「前回の視点」を上書きしない（localStorage はオリジン単位）
		keyboard: () => open,      // 矢印キーは地図を開いている間だけ（一覧の操作を奪わない）
		assetBase: __JAPAN_ASSETS__,   // 実行時アセットは ortho-japan の public が正本（本番 /japan/・dev は /@fs で直読み）
	});
	map.gadget.zoom(); map.gadget.compass(); map.gadget.shot();
	inside = countryLayers(map, engine.geopbf);   // その国の州境・道路・鉄道・市街地（ne-cultural＝equal と同じ 2 本）

	const show = async (sign = {}) => {
		open = true; pane.classList.remove("hidden");
		title.textContent = sign.name || sign.iso2 || sign.key || "";
		// 合図をそのまま渡す＝ISO2/ISO3/鍵/QID/名前の順にエンジンが当てる。寄りは z6 まで＝世界の陸の色（ハイプソ）と
		// 湖が出ている帯の内側。これを超えると日本の外は海岸線だけの白い紙になる（シンガポール/クリッパートンの轍・2026-09-23）＝
		// 小さな国は小さく見えるが、地図としては正しい絵のまま（スポットライトが在り処を示す）。
		spot = await map.gadget.spotlight(sign);   // 寄りは器のズーム上限（z8）に従う＝その国いっぱいに FIT する
		if (spot?.name && !sign.name) title.textContent = spot.name;
		if (!spot) console.warn("[world] 世界の行政界に形が無い", sign.key || sign.iso2);   // NE に無い下位地域＝地図は世界のまま（名前だけ出す）
		if (sign.key) inside.show(sign.key).catch(e => console.warn("[world] 国の中身", e));   // 形を出した後＝待たせない（届いた順に現れる）
	};
	return { show, hide };
}
