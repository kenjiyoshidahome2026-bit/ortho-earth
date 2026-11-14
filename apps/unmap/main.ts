// UNMAP オフライン版（実験・国連職員だけ）M1＝地球儀に OSM planet（PMTiles）と GEL の地形をオンラインで重ねる。
// 計画：M2 で OPFS の源と合成の源（packages/ortho-core/src/pmtiles-src.ts）・M3 で矩形の選択と切り出し。
// 視点の hash（#z/lat/lon）は URL に書く。?osm=・?gel=＝データの置き場の差し替え（sources.ts）。?status=0＝確認の札を出さない。
import { dismissBoot } from "@ortho-earth/globe/boot/screen.js";
import { gelTerrain, sourcesFrom } from "./sources.ts";
import { osmStyle } from "./style.ts";
import { probe } from "./probe.ts";
import type { ProbeResult } from "./probe.ts";

const SRC = sourcesFrom(location.href);
const SHOW_STATUS = !/[?&]status=0/.test(location.search);

// 確認の札（M0 を端末の上で見る）：OSM と GEL の Range・ヘッダの申告・描き手（WebGPU か WebGL2）
const card = SHOW_STATUS ? document.getElementById("status") : null;
const rows: Record<string, string> = { osm: "OSM planet: …", gel: "GEL terrain: …", gpu: "Renderer: …" };
const paint = () => { if (card) card.querySelector("ul")!.innerHTML = Object.values(rows).map(t => `<li>${t}</li>`).join(""); };
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const line = (name: string, r: ProbeResult) => r.ok
	? `${name}: <b class="ok">OK</b> · Range 206 · z${r.minZoom}–${r.maxZoom} · ${r.tileType} · ${r.ms} ms`
	: `${name}: <b class="ng">NG</b> · ${esc(r.reason || "")}`;
if (card) {
	card.hidden = false;
	card.querySelector("button")!.addEventListener("click", () => { card.hidden = true; });
	paint();
	probe(SRC.osm).then(r => { rows.osm = line("OSM planet", r); paint(); });
	probe(SRC.gel).then(r => { rows.gel = line("GEL terrain", r); paint(); });
}

(async () => {
	const { setLang, getLang, isRTL } = await import("@ortho-earth/globe/i18n.js");
	await setLang();
	document.documentElement.lang = getLang(); document.documentElement.dir = isRTL() ? "rtl" : "ltr";
	try {
		const { createGlobe } = await import("@ortho-earth/globe");
		const map = await createGlobe({
			target: "#map", view: location.hash || "#2/10/20",
			region: null,                    // 日本の申告なし＝基図は下の style だけ
			style: osmStyle(SRC.osm),        // OSM planet（Protomaps v4）
			terrain: gelTerrain(SRC.gel),    // GEL（z2–12・mapbox の画素詰め）
			zoomMax: 18, chips: false, mesh: false, worldContent: false,
			// 世界帯の自前の中身（Natural Earth の海岸線・国境・河川・湖）と星空は持たない＝OSM の境界と二重にしない・オフラインで取りに行く物を減らす
			coastline: false, worldLines: false, worldFill: false, countryTip: false, sky: false,
			instruments: ["pos", "attr", "scale"], urlHash: true, persistView: false,
			debugGlobals: /[?&]debug=1/.test(location.search),
		});
		dismissBoot();
		map.gadget.cpos();     // 現在地（GPS）へ＝M3 の「現在地周辺を選ぶ」の入口にもなる（本人 2026-11-14「現在地周辺は絶対入れて」）
		map.gadget.compass();
		window.__map = map;   // console 検証用
		const showGpu = () => { rows.gpu = `Renderer: <b>${map.backend ?? "…"}</b>`; paint(); };
		showGpu(); setTimeout(showGpu, 3000);   // backend は最初の描画の後に決まる
	} catch (e) { console.error("[unmap] startup failed", e); dismissBoot(); rows.gpu = `Renderer: <b class="ng">startup failed</b>`; paint(); }
})();
