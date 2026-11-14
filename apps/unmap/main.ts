// UNMAP オフライン版（実験・国連職員だけ）。M1＝地球儀に OSM planet（PMTiles）と GEL の地形をオンラインで重ねる。
// M2＝端末（OPFS）に取り込んだ .pmtiles を先に読み、オンラインの planet を最後に束ねる（core の複合 Source）＝回線なしでも端末の分は描ける。
// M3＝範囲（z8 に揃った四角）を選んで planet と GEL から切り出して端末に保存（area-picker.ts・save-worker.ts）。入口の第一は「現在地周辺を保存」（本人 2026-11-14）。
// 視点の hash（#z/lat/lon）は URL に書く。?osm=・?gel=＝データの置き場の差し替え（sources.ts）。?online=0＝オンラインを読まない（端末の物だけ）。?status=0＝札を出さない。
// ?names=local|en|fr|es|ru|zh|ar＝地名の言語（無ければ前回の選択 → UI の言語が UN の 6 公用語ならそれ → 現地語）。
import { dismissBoot } from "@ortho-earth/globe/boot/screen.js";
import { archiveUrl, gelTerrain, sourcesFrom } from "./sources.ts";
import { listLocal, mountLocalPanel, savedBounds } from "./local-data.ts";
import type { LocalFiles } from "./local-data.ts";
import { LABEL_LAYERS, NAME_LANGS, NAME_LANG_LABEL, isNameLang, nameExpr, osmStyle } from "./style.ts";
import type { NameLang } from "./style.ts";
import { probe } from "./probe.ts";
import type { ProbeResult } from "./probe.ts";

const SRC = sourcesFrom(location.href);
const SHOW_STATUS = !/[?&]status=0/.test(location.search);

// 確認の札（M0 を端末の上で見る）：OSM と GEL の Range・ヘッダの申告・描き手（WebGPU か WebGL2）
const card = document.getElementById("status");
const rows: Record<string, string> = { osm: "OSM planet: …", gel: "GEL terrain: …", local: "On this device: …", gpu: "Renderer: …" };
const paint = () => { if (card) card.querySelector(".rows")!.innerHTML = Object.values(rows).map(t => `<li>${t}</li>`).join(""); };
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const line = (name: string, r: ProbeResult) => r.ok
	? `${name}: <b class="ok">OK</b> · Range 206 · z${r.minZoom}–${r.maxZoom} · ${r.tileType} · ${r.ms} ms`
	: `${name}: <b class="ng">NG</b> · ${esc(r.reason || "")}`;
const dataBtn = document.getElementById("data-btn") as HTMLButtonElement | null;
if (card) {
	card.querySelector(".close")!.addEventListener("click", () => { card.hidden = true; if (dataBtn) dataBtn.hidden = false; });
	dataBtn?.addEventListener("click", () => { card.hidden = false; dataBtn.hidden = true; });
	if (SHOW_STATUS) card.hidden = false; else if (dataBtn) dataBtn.hidden = false;
	paint();
	if (SRC.online) {
		probe(SRC.osm).then(r => { rows.osm = line("OSM planet", r); paint(); });
		probe(SRC.gel).then(r => { rows.gel = line("GEL terrain", r); paint(); });
	} else { rows.osm = "OSM planet: off (?online=0)"; rows.gel = "GEL terrain: off (?online=0)"; }
}

// 地名の言語：?names= → 前回の選択（localStorage）→ UI の言語（UN の 6 公用語なら）→ 現地語
const NAMES_KEY = "unmap.names";
const savedNames = (): string | null => { try { return localStorage.getItem(NAMES_KEY); } catch { return null; } };
const initialNames = (uiLang: string): NameLang => {
	const q = new URLSearchParams(location.search).get("names"), ui = uiLang.slice(0, 2).toLowerCase();
	return isNameLang(q) ? q : isNameLang(savedNames()) ? savedNames() as NameLang : isNameLang(ui) && ui !== "local" ? ui : "local";
};
/** 地名の言語の切替（左下の select）。変えたら地名の層の text-field を差し替え・選択を覚える */
function mountNamePicker(map: { setLayoutProperty(id: string, name: string, value: unknown): unknown }, cur: NameLang): void {
	const sel = document.getElementById("names") as HTMLSelectElement | null;
	if (!sel) return;
	sel.innerHTML = NAME_LANGS.map(l => `<option value="${l}"${l === cur ? " selected" : ""}>${NAME_LANG_LABEL[l]}</option>`).join("");
	sel.hidden = false;
	sel.addEventListener("change", () => {
		const l = sel.value; if (!isNameLang(l)) return;
		for (const id of LABEL_LAYERS) map.setLayoutProperty(id, "text-field", nameExpr(l));
		try { localStorage.setItem(NAMES_KEY, l); } catch { /* 覚えられないだけ */ }
	});
}

(async () => {
	const { setLang, getLang, isRTL } = await import("@ortho-earth/globe/i18n.js");
	await setLang();
	document.documentElement.lang = getLang(); document.documentElement.dir = isRTL() ? "rtl" : "ltr";
	const names = initialNames(getLang());
	// 端末に置いた PMTiles（M2）＝先に読む。オンラインの planet は最後（?online=0 なら束ねない）
	const local: LocalFiles = await listLocal().catch(e => { console.warn("[unmap] cannot list local files", e); return { map: [], terrain: [] }; });
	const { compositePMTilesUrl } = await import("@ortho-earth/core");
	const osmUrl = archiveUrl(local.map.map(f => f.path), SRC.online ? SRC.osm : null, compositePMTilesUrl);
	const gelUrl = archiveUrl(local.terrain.map(f => f.path), SRC.online ? SRC.gel : null, compositePMTilesUrl);
	// 保存の直後（area-picker が印を置いて読み直した）＝成功を札に出す。読み直すだけだと「戻ってきた」としか見えない（本人 2026-11-14）
	let justSaved: string | null = null;
	try { justSaved = sessionStorage.getItem("unmap.saved"); sessionStorage.removeItem("unmap.saved"); } catch { /* 出ないだけ */ }
	rows.local = `On this device: ${local.map.length} map · ${local.terrain.length} terrain file(s)` + (justSaved ? ` · <b class="ok">✓ Area saved (${esc(justSaved)} file(s))</b>` : "");
	if (justSaved && card) { card.hidden = false; if (dataBtn) dataBtn.hidden = true; }
	paint();
	const panel = card?.querySelector(".local") as HTMLElement | null;
	let openPicker: ((start: "here" | "view") => void) | null = null;   // 地球儀ができてから結ぶ
	const pick = (start: "here" | "view") => { if (openPicker) openPicker(start); };
	const { pendingSaves, discardSaves, runSave } = await import("./save-run.ts");
	const pending = await pendingSaves().catch(() => []);
	const mountPanel = () => panel && mountLocalPanel(panel, local, {
		saveHere: () => pick("here"), choose: () => pick("view"), pending,
		resume: () => {
			const m = panel.querySelector(".msg") as HTMLElement;
			void runSave(pending, p => { m.textContent = `Resuming ${p.name} (${p.index + 1}/${p.count})… ${Math.round(p.total ? p.bytes / p.total * 100 : 0)}%`; })
				.then(r => { if (r.ok) { m.textContent = "Saved. Reloading…"; location.reload(); } else m.textContent = `Failed: ${r.message}`; });
		},
		discard: () => { void discardSaves(pending).then(() => location.reload()); },
	});
	void mountPanel();
	const saveHereBtn = document.getElementById("save-here") as HTMLButtonElement | null;
	saveHereBtn?.addEventListener("click", () => pick("here"));
	try {
		const { createGlobe } = await import("@ortho-earth/globe");
		const map = await createGlobe({
			target: "#map", view: location.hash || "#2/10/20",
			region: null,                    // 日本の申告なし＝基図は下の style だけ
			...(osmUrl ? { style: osmStyle(osmUrl, names) } : {}),   // OSM planet（Protomaps v4）・端末の物が先・地名の言語
			terrain: gelUrl ? gelTerrain(gelUrl) : false,             // GEL（z2–12・mapbox の画素詰め）・端末の物が先
			zoomMax: 18, chips: false, mesh: false, worldContent: false,
			// 世界帯の自前の中身（Natural Earth の海岸線・国境・河川・湖）と星空・夜面は持たない＝OSM の境界と二重にしない・オフラインで取りに行く物を減らす
			coastline: false, worldLines: false, worldFill: false, countryTip: false, sky: false, night: false,
			instruments: ["pos", "attr", "scale"], urlHash: true, persistView: false,
			debugGlobals: /[?&]debug=1/.test(location.search),
		});
		dismissBoot();
		mountNamePicker(map as never, names);
		map.gadget.cpos();     // 現在地（GPS）へ＝M3 の「現在地周辺を選ぶ」の入口にもなる（本人 2026-11-14「現在地周辺は絶対入れて」）
		map.gadget.compass();
		// 範囲の保存（M3）：地球儀の上に Equal Earth を重ねて選ぶ
		const bounds = await savedBounds(local).catch(() => []);
		openPicker = start => {
			void import("./area-picker.ts").then(({ openAreaPicker }) => openAreaPicker({
				host: map.mapEl as HTMLElement, lang: getLang(), saved: bounds,
				sources: SRC.online ? { osm: SRC.osm, gel: SRC.gel } : null,
				needWorld: !local.map.some(f => f.name === "world.pmtiles"),
				view: () => ({ lon: map.cam.center[0], lat: map.cam.center[1], zoom: map.cam.zoom }),
			}, start)).catch(e => console.error("[unmap] area picker failed", e));
		};
		if (saveHereBtn) saveHereBtn.hidden = false;
		window.__map = map;   // console 検証用
		const showGpu = () => { rows.gpu = `Renderer: <b>${map.backend ?? "…"}</b>`; paint(); };
		showGpu(); setTimeout(showGpu, 3000);   // backend は最初の描画の後に決まる
	} catch (e) { console.error("[unmap] startup failed", e); dismissBoot(); rows.gpu = `Renderer: <b class="ng">startup failed</b>`; paint(); }
})();
