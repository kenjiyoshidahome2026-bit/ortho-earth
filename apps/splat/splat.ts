// Gaussian splat の見本（/globe/splat・splat.html から遅延 import・2026-10-21）。
// @ortho-earth/plugin-splat（予約された map.addData の kind "splat"）を、本物の場所＝東京駅 丸の内駅前広場に 2 つの写実の 3D スキャン（Niantic の .spz の見本・MIT）を置いて見せる。
//   読み方 2 つ … 「3D Tiles」＝scripts/splat-tiles.mjs が焼いた八分木（glTF の KHR_gaussian_splatting＋SPZ 圧縮・refine REPLACE）を map.add3DTiles で流す（寄った所だけ細かく・遠くは見本）
//                 「1 本の .spz」＝掃除した .spz を map.addData(url, { kind: "splat", origin }) で丸ごと読む（WebGPU なら LoD＝画面で小さい時は重い順の先頭だけ）
//   つまみ      … 建物・地形で隠す（depthTest）・球面調和の次数（WebGPU）・LoD・不透明度
//   自分のファイル … .ply／.splat／.spz／.ksplat／.sog を落とす（か開く）と、今の画面の中心の地面に置く（尺のつまみつき）
//   描くのは全部エンジンの公開の口（map.use・add3DTiles・addData・setOptions・setProps）だけ。
import { tr, getLang } from "@ortho-earth/globe/i18n.js";   // UI 文言＝英語キー・26 言語。モジュール評価時に t() を呼ばない
import { createPanel } from "common/panel";   // 案内パネルの枠（共有エンジンの入口）
import { splatPlugin } from "@ortho-earth/plugin-splat";
import type { SplatHandle, SplatFormat, SplatOptions } from "@ortho-earth/plugin-splat";
import type { GlobeMap, Tiles3DHandle } from "@ortho-earth/globe";

const t = tr();
export const DATA = "https://kenjiyoshidahome2026-bit.github.io/ortho-data/globe/splat/";   // GitHub Pages（焼く＝scripts/splat-tiles.mjs・置く＝world の publish-pages.mjs）
const SOURCE_URL = "https://github.com/nianticlabs/spz";
/** 置き場＝東京駅 丸の内駅前広場（2 体の間）。tileset の root.transform は高さ 3.3 m（＝この地点の標高。engine の高さは標高基準＝楕円体高で焼くと 37 m 浮く・2026-10-21）で焼いてあり、
 *  実際の地形の高さ（map.getHeight）との差だけ heightOffset で持ち上げる */
export const SITE: [number, number] = [139.76560, 35.68110];
const BAKED_GROUND_M = 3.3;
/** 見本の題名（index.json の title と同じ文字列＝辞書の鍵。index.json に無い時の控え） */
const TITLES: Record<string, string> = { racoonfamily: "Raccoon family", hornedlizard: "Horned lizard" };
interface Scene { id: string; title: string; origin: [number, number, number]; heading: number; scale?: number; splats: number; tiles: number; bytesTiles: number; bytesSpz: number }
/** 見本の束が申告する地面の画像タイル（index.json の ground）。name＝辞書の鍵（globe の ui.json にある語） */
interface Ground { url: string; href: string; name: string; minZoom?: number; maxZoom?: number; bbox?: [number, number, number, number] | null }
type Mode = "tiles" | "file";
type Fmt = SplatFormat;
const FORMATS: readonly Fmt[] = ["ply", "splat", "spz", "ksplat", "sog"];
const fmt = (n: unknown, d = 0) => Number(n).toLocaleString(getLang(), { maximumFractionDigits: d });
const mb = (b: number) => `${(b / 1048576).toFixed(1)} MB`;
const formatOf = (name: string): Fmt | null => { const m = name.toLowerCase().match(/\.(ply|splat|spz|ksplat|sog)$/); return m ? m[1] as Fmt : null; };

export async function mountSplat(map: GlobeMap, { data, mode: modeIn, fly = true }: { data?: string | null; mode?: string | null; fly?: boolean } = {}) {
	document.title = t("Gaussian splats on the globe — ortho-globe");   // 器（splat.html）の題名と説明もここで＝i18n の走査器が読む頁の本体（.ts）に置く
	document.querySelector('meta[name="description"]')?.setAttribute("content", t("Two photoreal 3D scans drawn as Gaussian splats on a real place on the globe: streamed as 3D Tiles (KHR_gaussian_splatting, SPZ) or read from one .spz file, WebGPU with spherical harmonics. Drop your own .ply / .splat / .spz / .ksplat / .sog."));
	const base = ((data || (typeof __WORLD_OUT__ !== "undefined" && __WORLD_OUT__ && __WORLD_OUT__ + "splat/") || DATA) as string).replace(/\/?$/, "/");
	const mapEl = map.mapEl;
	map.use(splatPlugin());
	const st = { mode: (modeIn === "file" ? "file" : "tiles") as Mode, depthTest: true, shDegree: 3 as 0 | 1 | 2 | 3, lod: true, opacity: 1, ownScale: 1 };

	// ── 案内板 ──
	const P = createPanel({ host: mapEl, title: t("Gaussian splats on the globe"), sub: t("3D Tiles · .spz · WebGPU"), cls: "splat-panel", labels: { fold: t("Collapse panel"), unfold: t("Expand panel") } });
	const panel = P.el;
	P.body.insertAdjacentHTML("beforebegin", `<style>
.splat-panel .stat{font-variant-numeric:tabular-nums;color:#fff}
.splat-panel .lvl{color:#b9c3d6;font-variant-numeric:tabular-nums;font-size:12px}
.splat-panel .row{margin:9px 0}
.splat-panel label{display:flex;justify-content:space-between;align-items:center;gap:8px;color:#b9c3d6}
.splat-panel label b{color:#fff;font-weight:600;font-variant-numeric:tabular-nums}
.splat-panel label.chk{justify-content:flex-start;gap:6px;cursor:pointer}
.splat-panel input[type=range]{width:100%;margin:3px 0 0;accent-color:#f8a95c}
.splat-panel select{font:inherit;font-size:12px;border-radius:7px;border:1px solid rgba(255,255,255,.2);background:#1a2238;color:#e7ecf5;padding:3px 6px;max-width:170px}
.splat-panel button.b{border-radius:8px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:#e7ecf5;padding:4px 10px;cursor:pointer;font:inherit}
.splat-panel button.b.on{background:#f8a95c;color:#1a0d00;font-weight:700;border-color:transparent}
.splat-panel .btns{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0}
.splat-panel .seg{display:flex;border-radius:8px;overflow:hidden;border:1px solid rgba(255,255,255,.2)}
.splat-panel .seg button{flex:1;border:0;background:transparent;color:#b9c3d6;padding:5px 6px;cursor:pointer;font:inherit;font-size:12px}
.splat-panel .seg button.on{background:#f8a95c;color:#1a0d00;font-weight:700}
.splat-panel .note{color:#8793aa;font-size:10.5px;margin-top:8px;line-height:1.5}
.splat-panel .note a{color:#b9c3d6}
.splat-panel details{margin-top:8px;border-top:1px solid rgba(255,255,255,.1);padding-top:6px}
.splat-panel details summary{cursor:pointer;color:#e7ecf5;font-weight:600}
.splat-panel table{border-collapse:collapse;font-size:11px;margin-top:4px;width:100%}
.splat-panel td{padding:2px 4px;border-bottom:1px solid rgba(255,255,255,.07);vertical-align:top;color:#b9c3d6}
.splat-panel td code{color:#febb81;font-size:10.5px}
.splat-panel .err{color:#ff8a7a}
.splat-drop{position:absolute;inset:0;z-index:40;display:none;align-items:center;justify-content:center;background:rgba(20,28,40,.4);pointer-events:none}
.splat-drop div{padding:20px 28px;border-radius:12px;border:2.5px dashed rgba(255,255,255,.85);background:rgba(30,40,56,.6);color:#fff;font:600 15px/1.6 system-ui,sans-serif;text-align:center}
</style>
<div class="stat" data-k="status">${t("Loading…")}</div>
<div class="lvl" data-k="level"></div>`);
	P.body.innerHTML = `
 <div class="row"><div class="seg"><button type="button" data-k="modeTiles">${t("3D Tiles (streamed)")}</button><button type="button" data-k="modeFile">${t("One .spz file")}</button></div>
  <div class="note" data-k="modeNote" style="margin-top:4px"></div></div>
 <div class="row"><div class="btns" data-k="scenes"></div></div>
 <div class="note" data-k="scaleNote"></div>
 <div class="row"><label class="chk"><input type="checkbox" data-k="depth" checked> ${t("Hidden by buildings and terrain")}</label></div>
 <div class="row"><label>${t("Spherical harmonics")} <select data-k="sh"><option value="0">${t("Off (flat color)")}</option><option value="1">${t("Degree $1", "1")}</option><option value="2">${t("Degree $1", "2")}</option><option value="3" selected>${t("Degree $1", "3")}</option></select></label>
  <div class="note" data-k="shNote" style="margin-top:2px"></div></div>
 <div class="row"><label class="chk"><input type="checkbox" data-k="lod" checked> ${t("Level of detail (fewer splats when small on screen)")}</label></div>
 <div class="row"><label>${t("Opacity")} <b data-k="opV">100%</b></label><input type="range" data-k="op" min="0.05" max="1" step="0.05" value="1"></div>
 <details data-k="ownBox"><summary>${t("Your own scene")}</summary>
  <div class="note" style="margin-top:4px">${t("Drop a .ply, .splat, .spz, .ksplat or .sog file onto the globe, or:")}</div>
  <div class="btns"><button type="button" class="b" data-k="open">${t("Open a file…")}</button><input type="file" data-k="file" accept=".ply,.splat,.spz,.ksplat,.sog" hidden></div>
  <div class="stat" data-k="ownStatus"></div>
  <div data-k="ownCtl" hidden>
   <div class="row"><label>${t("Scale")} <b data-k="scaleV">×1</b></label><input type="range" data-k="scale" min="-2" max="2" step="0.1" value="0"></div>
   <div class="note">${t("Placed at the centre of the view, on the ground. The file's own axes are kept (.ply / .splat / .ksplat: y down; .spz / .sog: y up).")}</div>
   <div class="btns"><button type="button" class="b" data-k="ownGo">${t("Fly to it")}</button><button type="button" class="b" data-k="ownOff">${t("Remove")}</button></div>
  </div>
 </details>
 <details><summary>${t("How this page is drawn")}</summary>
  <table>
   <tr><td><code>map.use(splatPlugin())</code></td><td>${t("the renderer: WebGPU (spherical harmonics, GPU sort, LoD) or WebGL2")}</td></tr>
   <tr><td><code>map.add3DTiles(tileset.json)</code></td><td>${t("glTF with KHR_gaussian_splatting + SPZ, one layer per tile, REPLACE refinement")}</td></tr>
   <tr><td><code>map.addData(url, { kind: "splat", origin })</code></td><td>${t("one file placed on the ground")}</td></tr>
   <tr><td><code>depthTest · shDegree · lod · opacity</code></td><td>${t("the options above")}</td></tr>
   <tr><td><code>scripts/splat-tiles.mjs</code></td><td>${t("bakes an octree of SPZ tiles from a .spz")}</td></tr>
  </table>
 </details>
 <div class="note">${t("Sample scenes: $1 (MIT), cleaned and re-encoded for this page.", `<a href="${SOURCE_URL}" target="_blank" rel="noopener">Niantic Labs — spz samples</a>`)}</div>`;
	const $ = (k: string) => panel.querySelector<HTMLInputElement>(`[data-k="${k}"]`)!;
	const drop = document.createElement("div"); drop.className = "splat-drop"; drop.innerHTML = `<div>${t("Drop a splat file here")}</div>`; mapEl.append(drop);

	// ── データ（index.json＝シーンの一覧） ──
	let scenes: Scene[] = [];
	let ground: Ground | null = null;
	try { const r = await fetch(base + "index.json"); if (!r.ok) throw new Error(`${r.status}`); const idx = await r.json() as { scenes: Scene[]; ground?: Ground }; scenes = idx.scenes; ground = idx.ground || null; }
	catch (e) { console.error("[splat] index", e); $("status").innerHTML = `<span class="err">${t("Could not load the scene list from $1", base)}</span>`; }
	// ── 地面＝見本の束（index.json）が言う画像タイルを下に敷く（この地球儀の基図は z20 では無地＝広場も駅も出ない）。
	//    どの地域の何を敷くかはデータの側の申告＝この頁（/globe/）は地域を持たない（verify-prod の static の門・2026-10-21） ──
	if (ground?.url) map.raster.add("splat:ground", { url: ground.url, minZoom: ground.minZoom ?? 2, maxZoom: ground.maxZoom ?? 18, bbox: ground.bbox ?? null, name: t(ground.name), attribution: `<a href="${ground.href}" target="_blank" rel="noopener">${t(ground.name)}</a>` }, { order: "under", minZoom: 14 }).catch(e => console.warn("[splat] ground", e));
	{ const sc = scenes[0]?.scale || 1; $("scaleNote").textContent = sc > 1 ? t("Shown at $1× real size: the closest this globe gets is about 150 m, where the real animals would be a few pixels.", sc) : ""; }
	$("scenes").innerHTML = scenes.map(s => `<button type="button" class="b" data-scene="${s.id}">${t(s.title || TITLES[s.id] || s.id)}</button>`).join("");
	for (const b of panel.querySelectorAll<HTMLButtonElement>("[data-scene]")) b.addEventListener("click", () => { const s = scenes.find(x => x.id === b.dataset.scene); if (s) flyTo(s); });

	// 地面＝tileset は楕円体高 40 m（標高 3.3 m の見込み）で焼いてある＝この地図の地面との差を heightOffset で埋める
	let lift = 0;
	try { const h = await Promise.race([map.getHeight(SITE[0], SITE[1]), new Promise<number>(r => setTimeout(() => r(NaN), 8000))]); if (Number.isFinite(h)) lift = h - BAKED_GROUND_M; }
	catch { /* 地形が無ければ 0 */ }

	// ── 置く（モードごと） ──
	const tiles = new Map<string, Tiles3DHandle>(), files = new Map<string, SplatHandle>();
	let own: SplatHandle | null = null, ownName = "", loading = 0;
	const splatOpts = (): Partial<SplatOptions> => ({ depthTest: st.depthTest, shDegree: st.shDegree, lod: st.lod, opacity: st.opacity });
	const clearAll = () => { for (const h of tiles.values()) h.remove(); tiles.clear(); for (const h of files.values()) h.remove(); files.clear(); };
	const place = async () => {
		clearAll(); loading++;
		const my = loading;
		try {
			if (st.mode === "tiles") {
				await Promise.all(scenes.map(async s => {
					const h = await map.add3DTiles(`${base}${s.id}/tileset.json`, { id: `splat:${s.id}`, fit: false, heightOffset: lift, maxSSE: 16, splat: splatOpts(), attribution: "Niantic Labs (MIT)" });
					if (my !== loading) { h.remove(); return; } tiles.set(s.id, h);
				}));
			} else {
				await Promise.all(scenes.map(async s => {
					const h = map.addData(`${base}${s.id}/${s.id}.spz`, { kind: "splat", id: `splat:${s.id}`, origin: [s.origin[0], s.origin[1], 0], orientation: [s.heading, 0, 0], properties: { scene: s.id }, ...splatOpts() }) as SplatHandle;
					files.set(s.id, h); await h.ready.catch(e => { console.error("[splat]", s.id, e); $("status").innerHTML = `<span class="err">${t("Could not read $1", s.id)}</span>`; });
				}));
			}
		} finally { if (my === loading) refresh(); }
	};
	const flyTo = (s: Scene) => { map.lookAt([s.origin[0], s.origin[1], 2], { zoom: 20, pitch: 62, bearing: 150, duration: 1200 }); };   // 一番の寄り＝z20（この地球儀の上限＝約 150 m）

	// ── 表示 ──
	// 描き手の名（WebGPU／WebGL2）＝plugin の手綱から。3D Tiles の層は gadget の物で手綱が無い＝見えない 1 個の層（probe）を置いて聞く
	const probe = map.addData({ n: 1, positions: new Float32Array([SITE[0], SITE[1], 0]), scales: new Float32Array([0.01, 0.01, 0.01]), rotations: new Float32Array([0, 0, 0, 1]), colors: new Uint8Array([0, 0, 0, 0]) }, { kind: "splat", id: "splat:probe", opacity: 0, lod: false }) as SplatHandle;
	const backendOf = (): string | null => { for (const h of [...files.values(), own, probe]) if (h?.backend) return h.backend; return null; };
	const stats = { splats: 0, drawn: 0, shown: 0, loaded: 0, bytes: 0 };
	const refresh = () => {
		const back = backendOf();
		if (st.mode === "tiles") {
			let shown = 0, loaded = 0, bytes = 0; for (const h of tiles.values()) { shown += h.stats.shown; loaded += h.stats.loaded; bytes += h.stats.bytes; }
			Object.assign(stats, { shown, loaded, bytes, splats: 0, drawn: 0 });
			$("status").textContent = loaded ? t("$1 tiles in view · $2 loaded · $3", fmt(shown), fmt(loaded), mb(bytes)) : t("Loading…");
		} else {
			let n = 0, drawn = 0; for (const h of files.values()) { n += h.n; drawn += h.drawn; }
			Object.assign(stats, { splats: n, drawn, shown: 0, loaded: 0, bytes: 0 });
			$("status").textContent = n ? t("$1 splats · $2 drawn", fmt(n), fmt(drawn)) : t("Loading…");
		}
		const ownN = own ? t("Your scene: $1 splats", fmt(own.n)) : "";
		$("level").textContent = [back ? (back === "webgpu" ? t("WebGPU renderer") : t("WebGL2 renderer (flat color, no spherical harmonics)")) : "", ownN].filter(Boolean).join(" · ");
		$("shNote").textContent = back === "webgl2" ? t("WebGL2 draws the base color only; spherical harmonics need WebGPU.") : "";
		$("modeNote").textContent = st.mode === "tiles" ? t("An octree of tiles: the coarse sample loads first, finer tiles replace it as you get closer.") : t("The whole file is read in a worker and uploaded once; LoD trims it while it is small on screen.");
		$("modeTiles").classList.toggle("on", st.mode === "tiles"); $("modeFile").classList.toggle("on", st.mode === "file");
	};
	const tick = setInterval(refresh, 1000);

	// ── つまみ ──
	const applyOpts = () => { const o = splatOpts(); for (const h of tiles.values()) h.setOptions({ splat: o }); for (const h of files.values()) h.setProps(o); own?.setProps(o); };
	$("modeTiles").addEventListener("click", () => { if (st.mode !== "tiles") { st.mode = "tiles"; place(); } });
	$("modeFile").addEventListener("click", () => { if (st.mode !== "file") { st.mode = "file"; place(); } });
	$("depth").addEventListener("change", e => { st.depthTest = (e.target as HTMLInputElement).checked; applyOpts(); });
	$("sh").addEventListener("change", e => { st.shDegree = +(e.target as HTMLSelectElement).value as 0 | 1 | 2 | 3; applyOpts(); });
	$("lod").addEventListener("change", e => { st.lod = (e.target as HTMLInputElement).checked; applyOpts(); });
	$("op").addEventListener("input", e => { st.opacity = +(e.target as HTMLInputElement).value; $("opV").textContent = `${Math.round(st.opacity * 100)}%`; applyOpts(); });

	// ── 自分のファイル ──
	const ownOrigin = (): [number, number, number] => { const c = map.getCenter(); return [c.lng, c.lat, 0]; };
	const readFile = async (file: File) => {
		const format = formatOf(file.name);
		if (!format) { $("ownStatus").innerHTML = `<span class="err">${t("Not a splat file: $1 (use .ply, .splat, .spz, .ksplat or .sog)", file.name)}</span>`; return; }
		$("ownStatus").textContent = t("Reading $1…", file.name);
		own?.remove(); own = null;
		try {
			const bytes = await file.arrayBuffer();
			const h = map.addData(bytes, { kind: "splat", id: "splat:own", format, origin: ownOrigin(), scale: st.ownScale, properties: { name: file.name }, ...splatOpts() }) as SplatHandle;
			own = h; ownName = file.name;
			await h.ready;
			$("ownStatus").textContent = t("$1 splats from $2", fmt(h.n), file.name);
			$("ownCtl").hidden = false; ($("ownBox") as unknown as HTMLDetailsElement).open = true;
			refresh();
		} catch (e) { console.error("[splat] file", e); own = null; $("ownStatus").innerHTML = `<span class="err">${t("Could not read $1", file.name)}</span>`; }
	};
	$("open").addEventListener("click", () => $("file").click());
	$("file").addEventListener("change", e => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) readFile(f); (e.target as HTMLInputElement).value = ""; });
	$("scale").addEventListener("input", e => { st.ownScale = +(10 ** +(e.target as HTMLInputElement).value).toPrecision(2); $("scaleV").textContent = `×${st.ownScale}`; own?.setProps({ scale: st.ownScale }); });
	$("ownGo").addEventListener("click", () => { if (own?.anchor) map.lookAt([own.anchor[0], own.anchor[1], 2], { zoom: 20, pitch: 60, duration: 1000 }); });
	$("ownOff").addEventListener("click", () => { own?.remove(); own = null; ownName = ""; $("ownCtl").hidden = true; $("ownStatus").textContent = ""; refresh(); });
	let dragN = 0;
	mapEl.addEventListener("dragenter", e => { if (!e.dataTransfer?.types?.includes("Files")) return; e.preventDefault(); dragN++; drop.style.display = "flex"; });
	mapEl.addEventListener("dragover", e => { if (e.dataTransfer?.types?.includes("Files")) e.preventDefault(); });
	mapEl.addEventListener("dragleave", () => { if (--dragN <= 0) { dragN = 0; drop.style.display = "none"; } });
	mapEl.addEventListener("drop", e => { e.preventDefault(); dragN = 0; drop.style.display = "none"; const f = e.dataTransfer?.files?.[0]; if (f) readFile(f); });

	// ── 起動 ──
	const ready = place().then(() => true);
	if (fly && scenes.length) { const s0 = scenes[0], s1 = scenes[scenes.length - 1]; map.lookAt([(s0.origin[0] + s1.origin[0]) / 2, (s0.origin[1] + s1.origin[1]) / 2, 5], { zoom: 19.1, pitch: 62, bearing: 120 }); }
	await ready;
	refresh();

	return {
		get mode() { return st.mode; }, get scenes() { return scenes; }, get ready() { return scenes.length > 0 && (st.mode === "tiles" ? tiles.size === scenes.length : files.size === scenes.length); },
		get tiles() { return { ...stats }; }, get splats() { return stats.splats; }, get backend() { return backendOf(); }, get own() { return own ? { name: ownName, n: own.n } : null },
		get lift() { return lift; }, formats: FORMATS, setMode(m: Mode) { if (m !== st.mode) { st.mode = m; return place(); } return Promise.resolve(); }, flyTo, readFile, refresh,
		destroy() { clearInterval(tick); clearAll(); own?.remove(); probe.remove(); map.raster.remove("splat:ground"); P.destroy(); drop.remove(); },
	};
}
