// 地球儀 ⇄ Equal Earth の往復デモ（www の 2 番目のカード・2026-09-24）。
// 地球儀＝日本を持たない globe（z8 まで＝世界データの範囲）＋worldContent（Equal Earth と同じ中身：州境・湖・河川・道路・鉄道・都市・国名＝規則とデータは ortho-core の正本を共有）。
// アイコンは Equal Earth だけ（本人裁定）。?start=equal＝Equal Earth を上に重ねて始める（www のカードの入口）。右クリック＝その地点を中心に Equal Earth へ。
import type { ContextMenuItems } from "@ortho-earth/globe";   // 型だけ（エンジンは下の import() で後から読む）
(async () => {
	const { setLang, getLang, isRTL } = await import("@ortho-earth/globe/i18n.js");
	await setLang();
	document.documentElement.lang = getLang(); document.documentElement.dir = isRTL() ? "rtl" : "ltr";
	// エンジン＝地球儀のホスト @ortho-earth/globe をこの頁の束に焼く（地域の申告なし・CSS もこのチャンクに付いて来る）
	const engineP = import("@ortho-earth/globe");
	const dismissBoot = () => requestAnimationFrame(() => requestAnimationFrame(() => { const b = document.getElementById("boot"); if (b) { b.classList.add("gone"); setTimeout(() => b.remove(), 250); } }));
	// ?start=equal＝Equal Earth から始める入口：起動画面を Equal Earth の最初の 1 枚が重なるまで残す＝下の 3D を一瞬も見せない
	//（本人 2026-09-24「最初にチラッと見える 3D はどうにかならない？」）。合図＝equalStart の onFrame（重ね始め）＋重なり切る 0.3s。保険 15 秒
	const START_EQUAL = new URLSearchParams(location.search).get("start") === "equal";
	if (START_EQUAL) setTimeout(dismissBoot, 15000);
	try {
		const { createGlobe } = await engineP;
		const map = await createGlobe({ target: "#map", view: location.hash || "#1.6/20/138", chips: false, zoomMax: 8,   // 日本を持たない地球儀（z<8＝世界データの範囲）
			worldContent: /[?&]wc=0/.test(location.search) ? false : /[?&]wcg=([\w,]+)/.test(location.search) ? { groups: location.search.match(/[?&]wcg=([\w,]+)/)![1].split(",") } as unknown as boolean : true, mesh: false,   // ?wc=0＝世界帯の中身を切る（比較の切り分け）   // as boolean＝globe.d.ts の worldContent は boolean だけ（実行時は { groups } も受ける）
			persistView: false,   // /japan/ の「前回の視点」を上書きしない（localStorage はオリジン単位＝world の地図パネルと同じ作法）
			instruments: ["pos", "attr", "scale"], urlHash: true,   // pos＝緯度経度（左下＝Equal Earth と同じ置き場所）
			debugGlobals: /[?&]debug=1/.test(location.search) });   // ?debug=1＝検証窓（__cam・__worldContent…）
		if (!START_EQUAL) dismissBoot();
		map.gadget.equal({ load: () => import("@ortho-earth/equal") });   // 唯一のアイコン＝Equal Earth へ（球のフレームから開き、閉じると同じ視点の球へ戻る）。load＝部品をこの頁の div に組む（iframe でなく・2026-10-04）
		const setMenu = map.gadget.contextmenu() as (items: ContextMenuItems) => void;   // 初回の搭載＝項目の setter（二重搭載の { setItems } ではない）
		setMenu((c, defaults) => [...defaults, map.gadget.equalHere()]);   // 右クリック＝この地点を中心に Equal Earth へ
		if (START_EQUAL) map.gadget.equalStart({ view: { zoom: 1, lat: 0, lon: 138 }, onFrame: () => setTimeout(dismissBoot, 350) });
		window.__map = map;   // console 検証用
	} catch (e) { console.error("[earth] startup failed", e); dismissBoot(); }
})();
