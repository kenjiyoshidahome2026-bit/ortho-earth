// 日本の地形（山・川・湖・平野・島・海…約 1,500 件）を日本の 3D 地図に。物理量（標高・長さ・面積・深さ…）で記号の大きさを変え、
// 一覧（並べ替え）と比較図（高さ比べ・長さ比べ）を地図と連動させる＝/globe/physical（世界の地形）の日本版。
// このページは器だけ：./app.js（本番のエンジンは共有エンジン）でエンジンを起こし、描画と案内板は ./terrain.js（遅延 chunk）。
// データ＝GitHub Pages の ortho-data/japan/（dev は手元の正本・vite.config の __DATA_JAPAN__）：terrain.json（台帳）・terrain.i18n/<lang>.json（名前表）・terrain.geopbf（形状台帳）＝scripts/terrain-ledger が組む。
(async () => {
	const { setLang, getLang, isRTL } = await import("@ortho-earth/globe/i18n.js");
	await setLang();
	document.documentElement.lang = getLang(); document.documentElement.dir = isRTL() ? "rtl" : "ltr";
	const engineP = import("./app.js");
	const dismissBoot = () => requestAnimationFrame(() => requestAnimationFrame(() => { const b = document.getElementById("boot"); if (b) { b.classList.add("gone"); setTimeout(() => b.remove(), 250); } }));
	try {
		const [{ default: orthoJapan, geopbf }, { mountTerrain }] = await Promise.all([engineP, import("./terrain.js")]);
		// 初期視点＝日本列島を少し傾けて眺める（共有 URL の hash があればそちら）。z5.2＝陸の起伏と山の記号が出る寄り（共有カードの絵と同じ視点・z4.6 だと淡青の球に島名だけ）。建物 3D は出さない（地形が主役・起動も軽い）。
		// 基図の地形チップ（地理院の地形名・等高線・水系）は固定で消す＝地形名はこの頁の台帳が描く（二重に出さない）・地名（都市名）は残す
		const map = await orthoJapan({ target: "#map", view: location.hash || "#5.2/36.5/138/30t", chips: false, mesh: false,
			layers: { terrain: false, facility: false, rail: false, road: false }, instruments: ["pos", "scale", "attr"], urlHash: true, assetBase: import.meta.env.BASE_URL });
		dismissBoot();
		map.gadget.zoom(); map.gadget.compass(); map.gadget.full(); map.gadget.shot(); map.gadget.hint();
		const terrain = await mountTerrain(map, { geopbf, base: new URLSearchParams(location.search).get("data") || __DATA_JAPAN__ } as Parameters<typeof mountTerrain>[1]);   // ?data=URL で台帳を差し替え
		window.__map = map; window.__terrain = terrain;   // console 検証用
	} catch (e) { console.error("[terrain] startup failed", e); dismissBoot(); }
})();
