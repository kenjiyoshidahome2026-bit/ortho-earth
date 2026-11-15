// UNMAP オフライン版（実験・国連職員だけ）。M1＝地球儀に OSM planet（PMTiles）と GEL の地形をオンラインで重ねる。
// M2＝端末（OPFS）に取り込んだ .pmtiles を先に読み、オンラインの planet を最後に束ねる（core の複合 Source）＝回線なしでも端末の分は描ける。
// M4＝アプリ自体も端末へ（app-pack.ts・共有の Service Worker）・回線なしの地名検索（places.ts・search.ts）・ホーム画面に追加（manifest.webmanifest）。
// M3＝範囲（z8 に揃った四角）を選んで planet と GEL から切り出して端末に保存（area-picker.ts・save-worker.ts）。入口の第一は「現在地周辺を保存」（本人 2026-11-14）。
// 視点の hash（#z/lat/lon）は URL に書く。?osm=・?gel=＝データの置き場の差し替え（sources.ts）。?online=0＝オンラインを読まない（端末の物だけ）。?status=0＝札を出さない。
// ?dpr=<数>＝描く解像度（無ければ画面の画素どおり＝エンジンの既定）。
// ?names=local|en|fr|es|ru|zh|ar＝地名の言語（無ければ前回の選択 → UI の言語が UN の 6 公用語ならそれ → 現地語）。
import { dismissBoot } from "@ortho-earth/globe/boot/screen.js";
import { archiveUrl, finalPaths, gelTerrain, sourcesFrom } from "./sources.ts";
import { listLocal, mountLocalPanel, savedBounds } from "./local-data.ts";
import { requestPersist as requestPersistNow } from "@ortho-earth/core/opfs-store";
import type { LocalFiles } from "./local-data.ts";
import { LABEL_LAYERS, NAME_LANGS, NAME_LANG_LABEL, OSM_MINZOOM, SHADE, SHADE_COLORS, isNameLang, nameExpr, osmStyle } from "./style.ts";
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

// 描く解像度：?dpr=<数> だけ（無ければ既定＝エンジンが devicePixelRatio を 2 までで使う＝画面の画素どおり）。
// 旧＝メモリ 4 GB 以下の端末は 1.25 倍に抑えていた（2026-11-14）→ 画面の画素（1.5 倍）へ引き伸ばされて線も文字もにじみ、本人「アンドロイドがあまりにも荒い」（2026-11-16）＝やめた。
// 遅さの元はメモリ（他のタブ）で、描画そのものは 60 fps 出ていた
const pixelRatio = (): number | null => {
	const q = +(new URLSearchParams(location.search).get("dpr") ?? "");
	return q > 0 ? q : null;
};

// 地名の言語：?names= → 前回の選択（localStorage）→ UI の言語（UN の 6 公用語なら）→ 現地語
const NAMES_KEY = "unmap.names";
const savedNames = (): string | null => { try { return localStorage.getItem(NAMES_KEY); } catch { return null; } };
const initialNames = (uiLang: string): NameLang => {
	const q = new URLSearchParams(location.search).get("names"), ui = uiLang.slice(0, 2).toLowerCase();
	return isNameLang(q) ? q : isNameLang(savedNames()) ? savedNames() as NameLang : isNameLang(ui) && ui !== "local" ? ui : "local";
};
/** 低倍率（エンジンの世界帯）の国名・都市名の言語＝地名の言語に揃える。現地語は世界帯に無い＝英語 */
const worldLang = (l: NameLang): string => l === "local" ? "en" : l;
/** 地名の言語の切替（左下の select）。変えたら地名の層の text-field を差し替え・世界帯の国名も・選択を覚える */
function mountNamePicker(map: { setLayoutProperty(id: string, name: string, value: unknown): unknown; setWorldLang?(lang: string): Promise<void> }, cur: NameLang): void {
	const sel = document.getElementById("names") as HTMLSelectElement | null;
	if (!sel) return;
	sel.innerHTML = NAME_LANGS.map(l => `<option value="${l}"${l === cur ? " selected" : ""}>${NAME_LANG_LABEL[l]}</option>`).join("");
	sel.hidden = false; if (sel.parentElement?.id === "names-btn") sel.parentElement.hidden = false;
	sel.addEventListener("change", () => {
		const l = sel.value; if (!isNameLang(l)) return;
		for (const id of LABEL_LAYERS) map.setLayoutProperty(id, "text-field", nameExpr(l));
		void map.setWorldLang?.(worldLang(l));
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
	const { compositePMTilesUrl, finalMember, pmtilesInfo, opfsPMTilesUrl } = await import("@ortho-earth/core");
	// 既定以上の細かさで保存した範囲は「決まり」＝回線があってもその中はネットへ行かない（速さ・通信量）。?final=0＝切る（比較用）
	const finalOf = async (kind: "map" | "terrain") => {
		if (!SRC.online || /[?&]final=0/.test(location.search)) return undefined;
		const heads = await Promise.all(local[kind].map(async f => { const i = await pmtilesInfo(opfsPMTilesUrl(f.path)).catch(() => null); return { path: f.path, maxZoom: i?.maxZoom ?? -1, bbox: i?.bbox ?? null }; }));
		return { paths: finalPaths(kind, heads), mark: finalMember };
	};
	const osmUrl = archiveUrl(local.map.map(f => f.path), SRC.online ? SRC.osm : null, compositePMTilesUrl, await finalOf("map"));
	const gelUrl = archiveUrl(local.terrain.map(f => f.path), SRC.online ? SRC.gel : null, compositePMTilesUrl, await finalOf("terrain"));
	// 保存の直後（area-picker が印を置いて読み直した）＝成功を札に出す。読み直すだけだと「戻ってきた」としか見えない（本人 2026-11-14）
	let justSaved: string | null = null;
	try { justSaved = sessionStorage.getItem("unmap.saved"); sessionStorage.removeItem("unmap.saved"); } catch { /* 出ないだけ */ }
	rows.local = `On this device: ${local.map.length} map · ${local.terrain.length} terrain file(s)`;
	if (justSaved && card) { card.hidden = false; if (dataBtn) dataBtn.hidden = true; }
	paint();
	const panel = card?.querySelector(".local") as HTMLElement | null;
	let openPicker: ((start: "here" | "view") => void) | null = null;   // 地球儀ができてから結ぶ
	const pick = (start: "here" | "view") => { if (openPicker) openPicker(start); };
	let showArea: ((b: [number, number, number, number]) => void) | null = null;   // 一覧の「Show on map」＝地球儀ができてから結ぶ
	const { pendingSaves, discardSaves, runSave } = await import("./save-run.ts");
	const pending = await pendingSaves().catch(() => []);
	let update: { count: number; run(): void } | null = null;   // 元が新しくなった保存（M5）
	const mountPanel = () => panel && mountLocalPanel(panel, local, {
		saveHere: () => pick("here"), choose: () => pick("view"), pending, update,
		show: b => showArea?.(b), lang: () => (document.getElementById("names") as HTMLSelectElement | null)?.value || names,
		notice: justSaved ? "Area saved. It now works without a connection." : null,
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
			zoomMax: 18, chips: false, mesh: false,
			worldContent: { lang: worldLang(names) },               // 低倍率に標準の地球と同じ中身（国境・国名・都市・州境…＝/globe と同じ・2026-11-14 タブレットで z2 の国境が無かった）
			worldBelow: OSM_MINZOOM,          // z5.5 より下＝エンジンの標準の地球（段彩・国境・湖）・上＝OSM
			...(pixelRatio() ? { pixelRatio: pixelRatio()! } : {}),   // ?dpr= の時だけ（比較・重い端末の逃げ道）
			// 低倍率（MapLibre z5.5 より下）はエンジンの標準の地球（段彩・Natural Earth の国境と湖・海岸線・星空・夜面）＝本人 2026-11-14。OSM はその上（style.ts OSM_MINZOOM）。
			// 標準の地球のデータは初回の起動でエンジンが IDB・HTTP キャッシュに置く＋星空は app-pack が束に詰める＝通信なしでも出る
			instruments: ["pos", "attr", "scale"], urlHash: true, persistView: false,
			debugGlobals: /[?&]debug=1/.test(location.search),
		});
		dismissBoot();
		// 標高の陰影（本人 2026-11-15「標高の影が全く描かれていません」）：エンジンの陰影は傾けた地形面だけ＝真俯瞰は平ら。GEL から MapLibre の hillshade 層を作り、基図の塗りの上・注記の下へ重ねる。
		// 低倍率は標準の地球が自分の陰影を持つ＝OSM の出る z から（addLayer の z はエンジンの目盛り＝MapLibre＋1）。?shade=0 で切る・?shade=<0..1> で強さ
		const shade = +(new URLSearchParams(location.search).get("shade") ?? SHADE);
		if (gelUrl && shade > 0) void Promise.resolve().then(() => { map.addSource("relief-dem", gelTerrain(gelUrl).source); return map.addLayer({ id: "relief-shade", type: "hillshade", source: "relief-dem", minzoom: OSM_MINZOOM + 1,
			paint: { "hillshade-exaggeration": Math.min(1, shade), "hillshade-shadow-color": SHADE_COLORS.shadow, "hillshade-highlight-color": SHADE_COLORS.highlight, "hillshade-accent-color": SHADE_COLORS.accent } }); })
			.catch(e => console.warn("[unmap] relief shading failed", e));
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
		// 下の大きな「Save my area」は、まだ何も保存していない時だけ（最初の 1 歩）。保存が 1 つでもあれば出さない＝札の中の同じボタンで足りる（本人 2026-11-16「いつも出てて邪魔」）
		if (saveHereBtn) saveHereBtn.hidden = local.map.some(f => f.name !== "world.pmtiles");
		showArea = ([w, s, e, n]) => {   // 範囲が画面の 7 割ほどに収まるズーム（エンジンの z＝256px の世界）
			const dlon = ((e - w) % 360 + 360) % 360 || 360, el = map.mapEl as HTMLElement;
			const z = Math.log2(0.7 * Math.min(el.clientWidth * 360 / dlon, el.clientHeight * 170 / Math.max(0.01, n - s)) / 256);
			map.flyTo(((w + dlon / 2 + 540) % 360) - 180, (s + n) / 2, Math.max(2, Math.min(15, z)));
			if (card) { card.hidden = true; if (dataBtn) dataBtn.hidden = false; }
		};
		window.__map = map;   // console 検証用
		const showGpu = () => { rows.gpu = `Renderer: <b>${map.backend ?? "…"}</b>`; paint(); };
		showGpu(); setTimeout(showGpu, 3000);   // backend は最初の描画の後に決まる
	} catch (e) { console.error("[unmap] startup failed", e); dismissBoot(); rows.gpu = `Renderer: <b class="ng">startup failed</b>`; paint(); }
})();
