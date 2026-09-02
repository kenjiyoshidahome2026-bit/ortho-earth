// スタンドアロン /japan/ サイトの配線（index.html のインライン script から移設 2026-08-20）。
// ★二重構成の分岐点＝ここ1か所：
//   dev（vite dev）        … ./app.js（ソース直＝HMR・編集即反映＝従来どおり）
//   本番（vite build）     … /japan/lib/ortho-japan.js（SDK配布物そのもの＝pack:sdk が配る物と同一バイト列）
// 仕組み＝import.meta.env.PROD は build 時に定数化 → 死んだ側の分岐は rollup が丸ごと落とす
//   （＝本番バンドルに app.js は入らない・dev は lib を見ない）。verify:prod がこの確約を毎回検査する。
// lib のURLは**変数経由**で import＝vite の import 解析（devでもリテラルは解決を試みて 404 で落ちる）を
// 素通りさせ、実行時にブラウザが /japan/lib/ から取る。@vite-ignore は「解析しない」警告の抑止。
let engineP;
if (import.meta.env.PROD) {
	// CSS は lib 側で抽出されている＝ページが自分で貼る（dev は app.js の import が面倒を見る）。
	// #boot（不透明カバー）が初回フレームまで全面を覆う＝CSS到着の遅速は見えない。
	document.head.appendChild(Object.assign(document.createElement("link"), { rel: "stylesheet", href: "lib/ortho-japan.css" }));
	const LIB = "/japan/lib/ortho-japan.js";
	engineP = import(/* @vite-ignore */ LIB);
} else {
	engineP = import("./app.js");
}
// 台本（demo/scenes.js）は起動バンドルに載せない＝下で動的 import()。編集はあのファイル1枚・site.jsは触らない。
const dismissBoot = () => {   // 地図の初回フレームが描かれてから起動画面を退場（空canvasのちらつきを避ける＝2フレーム待ち）
	requestAnimationFrame(() => requestAnimationFrame(() => {
		const boot = document.getElementById("boot");
		if (boot) { boot.classList.add("gone"); setTimeout(() => boot.remove(), 250); }
	}));
};
// assetBase＝自分の配信ベース（dev/本番とも /japan/）。lib は base:"/" で焼かれている＝ここで指し直すのが埋め込み作法どおり。
// top-level await は使わない＝既定ビルドターゲット(es2020)の掟。then連鎖で同じ流れ。
engineP.then(m => m.default({ assetBase: import.meta.env.BASE_URL })).then(map => {   // 1行＝日本が立ち上がる（divも自作。埋め込みは orthoJapan({ target: "#…" })）
	dismissBoot();
	// ガジェット搭載＝この並びが左上からのアイコン配列（全zで一本＝2026-09-03 シンプル化）。
	// 表示宣言はガジェット毎に搭載時 opts で：zoom:[zmin,zmax)＝ズーム域・narrow:false＝狭画面(480px)では
	// 出さない（左上溢れ対策）。プラットフォームが裁き、圏外は display:none で上詰め（並び順不変）。
	// ズーム域の物差しは2つ（2026-09-03 本人裁定「太陽系=低ズームのみ・現在地/測定系/PLATEAU/印刷=高ズームのみ」）：
	//   5   ＝星空圏の境界（STARSKY_Z＝星・星座・太陽系の劇場はここから下）
	//   6.5 ＝基図の門（BASEMAP_MINZOOM＝GSI基図・日本の道具はここから上。z5-6.5は全球ハイプソの世界帯）
	map.gadget.search();      // 地名・住所検索（オプトインガジェット＝欲しい画面だけが載せる。搭載順＝左上からの並び）
	// palette ガジェットは非搭載へ（2026-09-02 本人裁定「アイコン煩雑＝表示系を一つに」）：テーマ切替は
	// 右上の表示パネル（chips のテーマ列）に集約。ライブ見本つきのガジェット自体は健在＝map.gadget.palette() で復帰可
	map.gadget.zoom({ narrow: false });   // ズーム＋/−（縦2連の一体ボタン）。狭画面＝出さない（ピンチが担う・左上溢れ対策）
	map.gadget.full({ narrow: false });   // 全画面トグル（非対応端末では出ない）。狭画面＝出さない（同上）
	map.gadget.japan();       // 日本全体へ（真俯瞰・北向きに戻る）
	map.gadget.solar({ zoom: [-99, 5] });      // 太陽系へ＝星空圏(z<5)のみ（低ズームの扉。34px土星アイコン）
	map.gadget.compass();     // コンパス兼リセット（3Dの時だけ現れる＝自前の display 裁き）
	map.gadget.cpos({ zoom: [6.5, 99] });      // 現在地（GPS。押すと寄って点滅マーカー）＝基図の門から
	map.gadget.measure({ zoom: [6.5, 99] });   // 距離・面積の計測（クリックで頂点・ダブルクリックで確定）＝同上
	map.gadget.profile({ zoom: [6.5, 99] });   // 断面図（クリックで経路指定→標高プロファイル）＝同上（日本のDEMが前提）
	map.gadget.shot();        // 画面を画像で保存（3層+計測を合成・出典焼き込み）
	map.gadget.qr();          // この視点をQRで共有（押すと中央に現在の共有URLのQR＝スクリーン投影→スキャンで拡散）
	map.gadget.print({ zoom: [6.5, 99] });     // 平面図を印刷（縮尺・A4/A3・経緯線・外枠＝紙仕様）＝GSI基図が前提
	map.gadget.plateau({ zoom: [6.5, 99] });   // 建物3D（PLATEAU）データ管理（公式ロゴマークのボタン）＝日本の道具
	map.gadget.contextmenu(); // 右クリックメニュー（既定＝この地点へ寄る／座標をコピー）
	map.gadget.dropFile();    // GISファイルのD&D取り込み（geopbfが食う全形式→GeoPBF化→gintへ描画・識別）
	import("./demo/scenes.js").then(m => map.gadget.demo({ ...m.default, lang: new URLSearchParams(location.search).get("lang") }));   // デモ上演（▶→Space=次・BS=戻る・クリッカー(PageUp/Down)対応・Esc終了）。台本もエンジンも起動バンドル外＝▶は僅かに遅れて出るが起動を汚さない。作法は demo/scenes.js 冒頭。?lang=jp＝タイトル日本語（既定＝title英語・en基準）
	// map.gadget.ai();       // AIと会話して地図に描く（PC専用＝画面2分割）。1canvas化を優先するため一時休止＝実装・テストは残置（t-ai.html は自前搭載で緑のまま）
	map.gadget.hint();        // 操作説明カード（最下段＝カードが開いても上の段を動かさない）
});
// サービスワーカー登録（public/sw.js＝ビルド資産を Cache API で版管理＝再訪の無通信起動/オフライン）。
// 本番httpsのみ＝localhost/headless(http)は掛けない（計測とテストを汚さない）。app.js でなくページ側に置く＝埋め込みを汚さない。
// updateViaCache:none＝SWスクリプト自体は毎回検証（版番号を上げたら確実に更新される）。load 後＝起動描画を邪魔しない。
if (location.protocol === "https:" && "serviceWorker" in navigator)
	addEventListener("load", () => navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).catch(e => console.warn("[sw] register failed", e)));
