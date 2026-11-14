// UNMAP オフライン版（実験・国連職員だけ）。M1＝地球儀に OSM planet（PMTiles）と GEL の地形をオンラインで重ねる。
// M2＝端末（OPFS）に取り込んだ .pmtiles を先に読み、オンラインの planet を最後に束ねる（core の複合 Source）＝回線なしでも端末の分は描ける。
// M4＝アプリ自体も端末へ（app-pack.ts・共有の Service Worker）・回線なしの地名検索（places.ts・search.ts）・ホーム画面に追加（manifest.webmanifest）。
// M3＝範囲（z8 に揃った四角）を選んで planet と GEL から切り出して端末に保存（area-picker.ts・save-worker.ts）。入口の第一は「現在地周辺を保存」（本人 2026-11-14）。
// 視点の hash（#z/lat/lon）は URL に書く。?osm=・?gel=＝データの置き場の差し替え（sources.ts）。?online=0＝オンラインを読まない（端末の物だけ）。?status=0＝札を出さない。
// ?names=local|en|fr|es|ru|zh|ar＝地名の言語（無ければ前回の選択 → UI の言語が UN の 6 公用語ならそれ → 現地語）。
import { dismissBoot } from "@ortho-earth/globe/boot/screen.js";
import { archiveUrl, gelTerrain, sourcesFrom } from "./sources.ts";
import { listLocal, mountLocalPanel, savedBounds } from "./local-data.ts";
import { requestPersist as requestPersistNow } from "@ortho-earth/core/opfs-store";
import type { LocalFiles } from "./local-data.ts";
import { LABEL_LAYERS, NAME_LANGS, NAME_LANG_LABEL, isNameLang, nameExpr, osmStyle } from "./style.ts";
import type { NameLang } from "./style.ts";
import { probe } from "./probe.ts";
import type { ProbeResult } from "./probe.ts";

const SRC = sourcesFrom(location.href);
const SHOW_STATUS = !/[?&]status=0/.test(location.search);

// 確認の札（M0 を端末の上で見る）：OSM と GEL の Range・ヘッダの申告・描き手（WebGPU か WebGL2）
const card = document.getElementById("status");
const rows: Record<string, string> = { osm: "OSM planet: …", gel: "GEL terrain: …", local: "On this device: …", app: "App offline: …", gpu: "Renderer: …" };
const paint = () => { if (card) card.querySelector(".rows")!.innerHTML = Object.values(rows).map(t => `<li>${t}</li>`).join(""); };
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const line = (name: string, r: ProbeResult) => r.ok
	? `${name}: <b class="ok">OK</b> · Range 206 · z${r.minZoom}–${r.maxZoom} · ${r.tileType} · ${r.ms} ms`
	: `${name}: <b class="ng">NG</b> · ${esc(r.reason || "")}`;
const dataBtn = document.getElementById("data-btn") as HTMLButtonElement | null;
// 元の頭の確かめ（札の表示・版の比べ M5 に使う）。札が無い頁・?online=0 では null
const probes: { osm: Promise<ProbeResult | null>; gel: Promise<ProbeResult | null> } = { osm: Promise.resolve(null), gel: Promise.resolve(null) };
if (card) {
	card.querySelector(".close")!.addEventListener("click", () => { card.hidden = true; if (dataBtn) dataBtn.hidden = false; });
	dataBtn?.addEventListener("click", () => { card.hidden = false; dataBtn.hidden = true; });
	if (SHOW_STATUS) card.hidden = false; else if (dataBtn) dataBtn.hidden = false;
	paint();
	if (SRC.online) {
		probes.osm = probe(SRC.osm).then(r => { rows.osm = line("OSM planet", r); paint(); return r; });
		probes.gel = probe(SRC.gel).then(r => { rows.gel = line("GEL terrain", r); paint(); return r; });
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
	let update: { count: number; run(): void } | null = null;   // 元が新しくなった保存（M5）
	const mountPanel = () => panel && mountLocalPanel(panel, local, {
		saveHere: () => pick("here"), choose: () => pick("view"), pending, update,
		resume: () => {
			const m = panel.querySelector(".msg") as HTMLElement;
			void runSave(pending, p => { m.textContent = `Resuming ${p.name} (${p.index + 1}/${p.count})… ${Math.round(p.total ? p.bytes / p.total * 100 : 0)}%`; })
				.then(r => { if (r.ok) { m.textContent = "Saved. Reloading…"; location.reload(); } else m.textContent = `Failed: ${r.message}`; });
		},
		discard: () => { void discardSaves(pending).then(() => location.reload()); },
	});
	void mountPanel();
	// 版の確かめ（M5）：元の頭の印と保存の印を比べ、違えば「全部切り直す」を札に出す（全部の範囲を同じ版に揃える＝縁で道がずれない）
	if (SRC.online && (local.map.length || local.terrain.length) && !pending.length) void (async () => {
		const [{ readSaved, staleOf, recutJobs }, osmP, gelP] = await Promise.all([import("./versions.ts"), probes.osm, probes.gel]);
		const stale = staleOf(await readSaved(), { map: osmP?.version, terrain: gelP?.version });
		if (!stale.length) return;
		update = { count: stale.length, run: () => {
			const m = panel?.querySelector(".msg") as HTMLElement | null;
			void requestPersistNow();
			void runSave(recutJobs(stale, { map: SRC.osm, terrain: SRC.gel }), p => { if (m) m.textContent = p.phase === "index" ? "Indexing place names…" : `Updating ${p.name} (${p.index + 1}/${p.count})… ${Math.round(p.total ? p.bytes / p.total * 100 : 0)}%`; })
				.then(r => { if (r.ok) location.reload(); else if (m) m.textContent = `Update stopped: ${r.message}. It continues from the Data card.`; });
		} };
		void mountPanel();
	})().catch(e => console.warn("[unmap] version check failed", e));
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
		// 地名の検索（M4）：端末の地図の索引だけを引く。索引の無い地図ファイル（M3 で保存した物）には worker で作って読み直す
		const searchEl = document.getElementById("place-search");
		if (searchEl) {
			const { loadPlaces, mountSearch } = await import("./search.ts");
			let places = await loadPlaces();
			const namesSel = document.getElementById("names") as HTMLSelectElement | null;
			mountSearch(searchEl, () => places, (lon, lat, z) => map.flyTo(lon, lat, z), () => namesSel?.value || names);
			searchEl.hidden = false;
			if (local.map.length) void runSave("index", () => {}).then(async r => { if (r.ok) places = await loadPlaces(); });
		}
		// アプリ自体を端末へ（M4）
		void import("./app-pack.ts").then(({ setupAppPack }) => setupAppPack(s => {
			rows.app = s.state === "saved" ? `App offline: <b class="ok">saved</b> · ${s.build}` : s.state === "saving" ? `App offline: saving… ${s.done}/${s.total}`
				: s.state === "unsupported" ? "App offline: not on this page (needs https)" : s.state === "error" ? `App offline: <b class="ng">failed</b> · ${esc(s.message || "")}` : `App offline: not saved${s.message ? " · " + esc(s.message) : ""}`;
			paint();
		}));
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
