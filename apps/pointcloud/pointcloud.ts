// 静岡県の点群（VIRTUAL SHIZUOKA）の案内板と配線（pointcloud.html から遅延 import・2026-10-18・熱海の点群の見本を広げた物）。
// 「データの組（年・計測の種類）を選ぶ → 4 km × 3 km の区画が地図に出る → 区画をクリック → 400 m × 300 m の図郭が出る → 図郭をクリックで点群」。
// データ＝静岡県が AWS（Open Data on AWS・s3://virtual-shizuoka・CORS 可・範囲読み可）に置く図郭ごとの .zip（中に .las が 1 つ・座標系の書き込み無し＝平面直角 VIII 系・標高）。
//   一覧は S3 の ListObjectsV2 を頁が直に引く（台帳を焼かない＝県が足した物もそのまま出る）。.zip はエンジン（copc-worker の ZIP の口）が範囲読みで解く。
//   熱海の見本（COPC・ortho-data の gh-pages）も残す＝節だけ範囲読みの速さを見せる方。
// 図郭の番号と VIII 系の換算＝pointcloud-sheets.ts（"08MC4919"＝VIII 系・M 行 C 列・5000 の 4 行 9 列・500 の 1 行 9 列）。
// 描き方（2026-11-06・本人「Gaussian splat・ブラウザ内・WebGPU・CPU の fallback なし」）＝点をそのまま描かず、エンジンが読んだ点（map.readPointCloud）を @ortho-earth/splat の cloud（render worker の WebGPU compute）が
//   段つきの Gaussian splat にして描く。読んだ点（points）と変換した段（cloud）は端末に保管（pc-cache.ts＝OPFS → IndexedDB）＝二度目は回線も変換も要らない・色や粗さを変えるのは保管した点から変換し直す（回線なし）。
//   WebGPU の無い器は頁全体をエラー（pointcloud-page.ts・本人裁定「頁全体をエラーで大丈夫」）。
// 見せ方＝粗さ（detail）・色・不透明度、高さ＝足し込み（錨の高さ＝読み直さずに効く）と「地形に合わせる」（地面の点と描いている地形の差の中央値）。
import { tr, getLang, LANGUAGES } from "@ortho-earth/globe/i18n.js";
import { splatPlugin, cloudToSpz, spzPlacement, cloudTo3DTiles, zipStore, type SplatHandle, type SplatOptions, type CloudData, type CloudColor } from "@ortho-earth/splat";
import { toPlane, toLonLat, sheetBox, sheetAt, sheetRing } from "./pointcloud-sheets.ts";
import { openPcCache, type PcCache } from "./pc-cache.ts";
import { copcOf, loadCopcIndex, type CopcIndex } from "./pc-copc.ts";   // 前もって COPC に変えた図郭（Hugging Face）＝あればそちらを範囲読み
import { pack, unpack, cacheKey } from "./pc-pack.ts";
import { dumpToPly } from "./pc-ply.ts";   // Unity 向けの PLY（錨からの m・glTF の向き）
import { dumpToLas } from "./pc-las.ts";   // Unreal 向けの LAS（錨からの m・(E, N, U)・錨は VLR）
import { CLASS_GROUPS, classKeep, filterClasses, neighborCodes, edgeMargin, edgePoints, withGhosts, type SheetPoints, type EdgePoints } from "./pc-sheet.ts";
import type { GlobeMap, PointCloudDump, LayerMouseEvent, GeoJSONFeature, Bbox } from "@ortho-earth/globe";

const t = tr();
const S3 = "https://virtual-shizuoka.s3.ap-northeast-1.amazonaws.com/";
const ATTR = "VIRTUAL SHIZUOKA (Shizuoka Prefecture, CC BY 4.0)";
const ATAMI = "https://kenjiyoshidahome2026-bit.github.io/ortho-data/japan/pointcloud/atami-08NF2392.copc.laz";
export const ATAMI_VIEW = "#17.6/35.1082/139.0816/50t/-20r";   // 見本の視点（頁の既定の視点・www のカード）
/** データの組＝S3 の "年/計測/種類"。2019 と 2020 の航空レーザは同じ図郭に同じファイル（2020 が広い）＝2020 だけ出す */
const SETS: Array<{ id: string; year: number; kind: "LP" | "ALB" | "MMS"; part: "Original" | "Ground" }> = [
	{ id: "2025/LP/Original", year: 2025, kind: "LP", part: "Original" }, { id: "2025/LP/Ground", year: 2025, kind: "LP", part: "Ground" },
	{ id: "2025/ALB/Original", year: 2025, kind: "ALB", part: "Original" }, { id: "2025/ALB/Ground", year: 2025, kind: "ALB", part: "Ground" },
	{ id: "2022/LP/Ground", year: 2022, kind: "LP", part: "Ground" },
	{ id: "2021/LP/Original", year: 2021, kind: "LP", part: "Original" }, { id: "2021/LP/Ground", year: 2021, kind: "LP", part: "Ground" },
	{ id: "2021/ALB/Ground", year: 2021, kind: "ALB", part: "Ground" }, { id: "2021/MMS/Ground", year: 2021, kind: "MMS", part: "Ground" },
	{ id: "2020/LP/Ground", year: 2020, kind: "LP", part: "Ground" }, { id: "2020/ALB/Ground", year: 2020, kind: "ALB", part: "Ground" }, { id: "2020/MMS/Ground", year: 2020, kind: "MMS", part: "Ground" },
	{ id: "2019/ALB/Ground", year: 2019, kind: "ALB", part: "Ground" }, { id: "2019/MMS/Ground", year: 2019, kind: "MMS", part: "Ground" },
];
const DEFAULT_SET = "2020/LP/Ground";   // 熱海（NF）を含む＝見本の周りに区画がすぐ出る
const KIND: Record<string, string> = { LP: "Airborne laser", ALB: "Airborne bathymetric laser", MMS: "Mobile mapping (vehicle)" };
const PART: Record<string, string> = { Original: "Original data", Ground: "Ground data" };
const BIG_MB = 250;   // これより大きい .zip は印を付ける（取るのに時間が掛かる）
/** 同時に出す図郭の上限（2026-11-07）＝低メモリ端末（≤4GB・iOS）2 枚・他 6 枚（1 枚＝読む点 150 万／400 万・splat の段で GPU に 100 MB 前後）。?lowmem=1/0 はエンジンと同じ上書き */
const lowMem = (nav: Navigator & { deviceMemory?: number }) => nav.deviceMemory ? nav.deviceMemory <= 4 : nav.maxTouchPoints > 1;   // エンジンの boot/tier.ts の lowMem と同じ目（頁の束にエンジンの源を焼かない＝写し）
const LOW = /[?&]lowmem=1/.test(location.search) || (!/[?&]lowmem=0/.test(location.search) && lowMem(navigator));
const MAX_SHEETS = LOW ? 2 : 6;

// 案内板の長文（英語キー）＝訳は頁の辞書 i18n/pages/pointcloud.json
const HOW = [
	"Shizuoka Prefecture publishes its laser surveys on AWS as one ZIP file per 400 m × 300 m map sheet (a LAS file inside, CC BY 4.0). The page lists the bucket directly — no index is baked here, so new data shows up as soon as the prefecture adds it.",
	"Clicking a sheet reads just that file's entry in the ZIP by HTTP Range and unpacks it in a worker as it arrives. The points are then turned into Gaussian splats on the GPU (WebGPU compute): one splat per cell, shaped by its neighbours, in several levels of detail — a far view draws a few thousand splats, a close view the finest level.",
	"The files carry no coordinate system, so the page passes Japan Plane Rectangular CS VIII (EPSG:6676) and treats heights as orthometric (above the geoid), like the map's terrain.",
	"The points and the converted splats are saved on this device (OPFS, or IndexedDB where OPFS is missing). Opening the same sheet again needs no download and no conversion, and changing the colour or detail re-converts the saved points without downloading.",
	"The Atami sample is the same survey converted to COPC, read from its shallowest octree nodes first up to the point limit.",
	"Several sheets can be shown side by side (two on phones and other low-memory devices). Each sheet borrows a thin strip of points from the neighbouring sheets that are shown, so the splats meet at the sheet edges without a gap; splats made only of borrowed points are dropped.",
	"Reading keeps at most the point limit in memory: the ZIP is unpacked as it streams in and thinned on the way, so even a large sheet never holds the whole LAS file. Choosing classes (ground, buildings, vegetation…) re-converts the saved points without downloading.",
	"Fit to terrain compares the ground points (class 2) with the terrain that is drawn and moves the cloud by the median difference. The map's terrain comes from different source data, so a few metres of difference are normal.",
	"Sheets marked COPC were converted in advance to COPC (Cloud Optimized Point Cloud) and are read from Hugging Face: only the octree nodes up to the point limit are fetched, instead of the whole ZIP file.",
	"This page needs WebGPU (Chrome, Edge, Safari 26 or newer, Firefox 141 or newer). There is no WebGL2 fallback — the conversion runs on the GPU by design.",
];

const CSS = `
#side { font-size: 13px; color: #f1f3f6; background: #0b0d12; overflow-y: auto; overscroll-behavior: contain; color-scheme: dark; }
#side .head { display: flex; gap: 8px; align-items: flex-start; padding: 14px 16px 2px; }
#side .head .lang { flex: none; max-width: 110px; font-size: 12px; padding: 2px 4px; margin-top: 2px; background: #1b1f26; color: inherit; border: 1px solid rgba(255,255,255,.22); border-radius: 6px; }
#side h1 { flex: 1; min-width: 0; margin: 0; font-size: 17px; color: #fff; }
#side h1 small { display: block; font-size: 11.5px; font-weight: 400; color: rgba(255,255,255,.62); margin-top: 2px; }
#side h2 { margin: 0; padding: 12px 16px 2px; font-size: 12px; font-weight: 600; letter-spacing: .04em; color: rgba(255,255,255,.62); text-transform: uppercase; }
#side .row { display: flex; gap: 8px; align-items: center; padding: 6px 16px 0; flex-wrap: wrap; }
#side .row > label { flex: none; width: 92px; color: rgba(255,255,255,.62); font-size: 12px; }
#side .row input[type=range] { flex: 1; min-width: 80px; }
#side .row output { flex: none; min-width: 52px; text-align: end; font: 12px ui-monospace, Menlo, monospace; color: #fff; }
#side select, #side .btn { font: inherit; font-size: 12px; color: inherit; background: #151920; border: 1px solid rgba(255,255,255,.22); border-radius: 7px; padding: 4px 9px; }
#side select { flex: 1; min-width: 0; }
#side .btn { cursor: pointer; }
#side .btn:hover { border-color: rgba(255,255,255,.5); }
#side .btn.on { border-color: #fff; background: #2a303b; }
#side .btn:disabled { opacity: .4; cursor: default; }
#side .hint { padding: 6px 16px 0; color: rgba(255,255,255,.62); font-size: 12px; }
#side .sheets { max-height: 196px; overflow-y: auto; margin-top: 6px; display: grid; grid-template-columns: repeat(auto-fill, minmax(92px, 1fr)); gap: 4px; padding: 0 16px; }
#side .sheet { font: 11.5px ui-monospace, Menlo, monospace; color: inherit; background: #151920; border: 1px solid rgba(255,255,255,.18); border-radius: 6px; padding: 3px 5px; cursor: pointer; text-align: start; line-height: 1.3; }
#side .sheet span { display: block; color: rgba(255,255,255,.55); font-size: 10.5px; }
#side .sheet.on { border-color: #ffd34d; background: #2b2a1e; }
#side .sheet.big span { color: #ffb36b; }
#side .sheet.copc span { color: #7fe3ff; }
#side .bar { margin: 8px 16px 0; height: 6px; background: rgba(255,255,255,.1); border-radius: 3px; overflow: hidden; }
#side .bar[hidden] { display: none; }
#side .bar i { display: block; height: 100%; width: 0; background: #7fb2ff; transition: width .15s; }
#side .status { padding: 6px 16px 0; color: rgba(255,255,255,.75); font-size: 12px; min-height: 1.4em; }
#side .status.err, #side .hint.err { color: #ff9b8a; }
#side .info { padding: 2px 16px 0; color: rgba(255,255,255,.55); font: 11px ui-monospace, Menlo, monospace; white-space: pre-line; }
#side .classes { flex: 1; min-width: 0; display: flex; flex-wrap: wrap; gap: 0 10px; }
#side .classes .check { padding: 2px 0 0; }
#side .check { display: flex; gap: 6px; align-items: center; padding: 6px 16px 0; color: rgba(255,255,255,.78); font-size: 12px; }
#side details { border-top: 1px solid rgba(255,255,255,.12); margin-top: 12px; padding: 6px 16px; font-size: 12px; }
#side details summary { cursor: pointer; font-weight: 600; color: #fff; padding: 4px 0; }
#side details ul { margin: 4px 0 6px; padding-inline-start: 18px; color: rgba(255,255,255,.78); }
#side details li { margin: 3px 0; }
#side .cache { padding: 6px 16px 0; color: rgba(255,255,255,.62); font-size: 12px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
#side .foot { padding: 8px 16px 12px; border-top: 1px solid rgba(255,255,255,.12); color: rgba(255,255,255,.5); font-size: 11px; }
#side .foot a { color: inherit; }`;

// ── S3 の一覧（ListObjectsV2・delimiter で階層ごと） ──
async function listS3(prefix: string, signal?: AbortSignal): Promise<{ dirs: string[]; files: Array<{ key: string; size: number }> }> {
	const dirs: string[] = [], files: Array<{ key: string; size: number }> = [];
	let token: string | null = null;
	do {
		const u = `${S3}?list-type=2&delimiter=/&prefix=${encodeURIComponent(prefix)}${token ? `&continuation-token=${encodeURIComponent(token)}` : ""}`;
		const r = await fetch(u, { signal }); if (!r.ok) throw new Error(`S3 list ${r.status}`);
		const x = await r.text();
		for (const m of x.matchAll(/<CommonPrefixes><Prefix>([^<]*)<\/Prefix><\/CommonPrefixes>/g)) dirs.push(m[1]);
		for (const m of x.matchAll(/<Contents><Key>([^<]*)<\/Key>[\s\S]*?<Size>(\d+)<\/Size>[\s\S]*?<\/Contents>/g)) if (/\.zip$/i.test(m[1])) files.push({ key: m[1], size: +m[2] });
		token = /<IsTruncated>true<\/IsTruncated>/.test(x) ? (/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(x)?.[1] ?? null) : null;
	} while (token);
	return { dirs, files };
}
const last = (p: string) => p.replace(/\/$/, "").split("/").pop()!;

/** 頁全体のエラー（WebGPU が無い・startupFailed と同じ形・pointcloud-page.ts が本体を起こす前に呼ぶ） */
export function noWebGpu() {
	const t = tr();
	const d = document.createElement("div");
	d.id = "page-fatal"; d.setAttribute("role", "alert");
	d.style.cssText = "position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;padding:24px;background:#f4f1ea;color:#333;font:14px/1.9 system-ui,sans-serif";
	d.innerHTML = `<div style="max-width:540px"><div style="font-size:18px;font-weight:600;margin-bottom:10px"></div><div style="color:#555"></div></div>`;
	(d.firstElementChild!.children[0] as HTMLElement).textContent = t("This page needs WebGPU");
	(d.firstElementChild!.children[1] as HTMLElement).textContent = t("The point clouds are converted to Gaussian splats on the GPU, which needs WebGPU. Use Chrome or Edge, Safari 26 or newer, or Firefox 141 or newer, with hardware acceleration on.");
	document.body.append(d);
	console.error("[pointcloud] WebGPU is not available: the page shows an error (no WebGL2 fallback by design)");
}

export async function mountPointcloud(map: GlobeMap, side: HTMLElement) {
	const CLASS_LABEL: Record<string, string> = { ground: t("Ground"), vegetation: t("Vegetation"), building: t("Buildings"), water: t("Water"), road: t("Roads, rails and bridges"), other: t("Other classes") };   // 分類の組（pc-sheet.ts の CLASS_GROUPS）の名前
	const lang = getLang();
	document.head.insertAdjacentHTML("beforeend", `<style>${CSS}</style>`);

	side.insertAdjacentHTML("beforeend", `
		<div class="head"><h1>${t("Point clouds of Shizuoka")}<small>${t("Laser surveys of Shizuoka Prefecture (VIRTUAL SHIZUOKA), read straight from the open data")}</small></h1><select class="lang" aria-label="Language">${LANGUAGES.map(l => `<option value="${l.code}"${l.code === lang ? " selected" : ""}>${l.name}</option>`).join("")}</select></div>
		<h2>${t("Data")}</h2>
		<div class="row"><button class="btn" id="pc-atami">${t("Atami sample (COPC)")}</button></div>
		<div class="row"><label for="pc-set">${t("Survey")}</label><select id="pc-set">${SETS.map(s => `<option value="${s.id}"${s.id === DEFAULT_SET ? " selected" : ""}>${s.year} · ${t(KIND[s.kind])} · ${t(PART[s.part])}</option>`).join("")}</select></div>
		<div class="hint" id="pc-hint"></div>
		<div class="sheets" id="pc-sheets"></div>
		<div class="row"><span class="hint" id="pc-shown" style="padding:0;flex:1"></span><button class="btn" id="pc-clear-all" disabled>${t("Remove all")}</button></div>
		<div class="bar" id="pc-bar" hidden><i></i></div>
		<div class="status" id="pc-status"></div>
		<div class="info" id="pc-info"></div>
		<h2>${t("Display")}</h2>
		<div class="row"><label for="pc-color">${t("Colour")}</label><select id="pc-color">${["auto", "rgb", "elevation", "intensity", "classification"].map(c => `<option value="${c}">${t({ auto: "Automatic", rgb: "True colour (RGB)", elevation: "Height", intensity: "Intensity", classification: "Classification" }[c]!)}</option>`).join("")}</select></div>
		<div class="row"><label for="pc-detail">${t("Detail")}</label><input type="range" id="pc-detail" min="0.5" max="4" step="0.5" value="1"><output id="pc-detail-v"></output></div>
		<div class="row"><label for="pc-opacity">${t("Opacity")}</label><input type="range" id="pc-opacity" min="0.1" max="1" step="0.05" value="1"><output id="pc-opacity-v"></output></div>
		<div class="row"><label>${t("Classes")}</label><div class="classes">${CLASS_GROUPS.map(g => `<label class="check"><input type="checkbox" id="pc-cls-${g.id}" checked>${CLASS_LABEL[g.id] ?? g.label}</label>`).join("")}</div></div>
		<label class="check"><input type="checkbox" id="pc-cover" checked>${t("Show map sheets")}</label>
		<div class="cache"><span id="pc-cache"></span><button class="btn" id="pc-cache-clear">${t("Clear")}</button></div>
		<h2>${t("Export")}</h2>
		<div class="row"><button class="btn" id="pc-exp-spz" disabled>${t("SPZ (finest level)")}</button><button class="btn" id="pc-exp-tiles" disabled>${t("3D Tiles (all levels)")}</button><button class="btn" id="pc-exp-ply" disabled>${t("PLY (points, for Unity)")}</button><button class="btn" id="pc-exp-las" disabled>${t("LAS (points, for Unreal)")}</button></div>
		<div class="hint" id="pc-exp">${t("The SPZ comes zipped with placement.json (anchor and the ENU → ECEF matrix); the 3D Tiles zip holds tileset.json and one glb per level (KHR_gaussian_splatting + SPZ).")} ${t("The PLY holds the read points (metres from the anchor, colour, class) for Unity; the anchor is in its header.")} ${t("The LAS holds the read points (metres from the anchor, colour, class) for Unreal; the anchor is in its header.")}</div>
		<h2>${t("Height")}</h2>
		<div class="row"><label for="pc-lift">${t("Raise / lower")}</label><input type="range" id="pc-lift" min="-30" max="30" step="0.1" value="0"><output id="pc-lift-v"></output></div>
		<div class="row"><button class="btn" id="pc-fit">${t("Fit to terrain")}</button><button class="btn" id="pc-zero">${t("Reset")}</button></div>
		<label class="check"><input type="checkbox" id="pc-autofit" checked>${t("Fit to terrain after loading")}</label>
		<div class="hint" id="pc-gap"></div>
		<details><summary>${t("How this works")}</summary><ul>${HOW.map(x => `<li>${t(x)}</li>`).join("")}</ul></details>
		<div class="foot">${t("Data")}: <a href="https://registry.opendata.aws/virtual_shizuoka/" target="_blank" rel="noopener">VIRTUAL SHIZUOKA</a> (${t("Shizuoka Prefecture")}, CC BY 4.0)</div>`);
	const $ = <E extends HTMLElement = HTMLElement>(id: string) => side.querySelector(id) as E;
	const status = (s: string, err = false) => { const el = $("#pc-status"); el.textContent = s; el.classList.toggle("err", err); };
	const bar = (f: number | null) => { const el = $("#pc-bar"); el.hidden = f == null; ($("#pc-bar i")).style.width = `${Math.round((f || 0) * 100)}%`; };
	const mb = (b: number) => b >= 10 << 20 ? `${Math.round(b / 1048576)} MB` : `${(b / 1048576).toFixed(1)} MB`;
	const fmtN = (n: number) => n.toLocaleString(lang);
	const tf = (tr: string, ...v: Array<string | number>) => v.reduce<string>((s, x, i) => s.replace(`$${i + 1}`, String(x)), tr);   // 差し込み（$1 $2 …）＝tf(t("…"), …)
	$<HTMLSelectElement>(".lang").onchange = e => { const u = new URL(location.href); u.searchParams.set("lang", (e.target as HTMLSelectElement).value); location.href = u.href; };

	// ── 描き手＝@ortho-earth/splat（WebGPU の描き手を指名＝本体が ?gl2=1 で WebGL2 でも自前の device で） ──
	map.use(splatPlugin({ backend: "webgpu" }));
	const cache = await openPcCache();
	console.info(`[pointcloud] cache: ${cache.kind}`);
	const showCache = async () => { const { entries, total } = await cache.list(); const el = $("#pc-cache"); el.textContent = cache.kind === "none" ? t("Nothing is saved on this device (storage is unavailable).") : tf(t("Saved on this device: $1 items, $2"), fmtN(entries.length), mb(total)); $<HTMLButtonElement>("#pc-cache-clear").disabled = !entries.length; };
	$("#pc-cache-clear").onclick = async () => { await cache.clear(); showCache(); };
	showCache();

	// ── 見せ方（色・粗さ・不透明度・分類は splat に焼き込む＝変えたら保管した点から変換し直す・高さは錨＝読み直さずに効く） ──
	const classIds = () => CLASS_GROUPS.filter(g => side.querySelector<HTMLInputElement>(`#pc-cls-${g.id}`)!.checked).map(g => g.id);
	const style = () => ({ color: $<HTMLSelectElement>("#pc-color").value as CloudColor, detail: +$<HTMLInputElement>("#pc-detail").value, opacity: +$<HTMLInputElement>("#pc-opacity").value, classes: classIds() });
	const outs = () => {
		$("#pc-detail-v").textContent = `×${$<HTMLInputElement>("#pc-detail").value}`;
		$("#pc-opacity-v").textContent = `${Math.round(+$<HTMLInputElement>("#pc-opacity").value * 100)}%`;
		const v = +$<HTMLInputElement>("#pc-lift").value; $("#pc-lift-v").textContent = `${v > 0 ? "+" : ""}${v.toFixed(1)} m`;
	};
	/** 出している物（図郭ごと）＝手綱・元・地面の見本（fit 用）・錨の高さ・借りた隣（鍵の並び＝継ぎ目）。active＝最後に開いた物（書き出し・地形合わせ・知らせ） */
	/** ck＝保管の鍵の元（県の .zip＝key・COPC＝"hf:<置き場>"＝読んだ点の間引きが違うので混ぜない） */
	interface Item { key: string; ck: string; src: string; label: string; extra: Partial<SplatOptions>; code: string | null; h: SplatHandle | null; alt0: number; ground: Array<[number, number, number]>; edges: string; info: string }
	const items = new Map<string, Item>();
	let active: Item | null = null, queue: Promise<unknown> = Promise.resolve();
	const cur = () => active?.h ?? null;
	const lift = () => { outs(); const v = +$<HTMLInputElement>("#pc-lift").value; for (const it of items.values()) it.h?.setAltitude(it.alt0 + v); };
	$("#pc-lift").addEventListener("input", lift);
	const restyle = () => { outs(); const all = [...items.values()]; if (active) all.sort((a, b) => +(b === active) - +(a === active)); for (const it of all) enqueue(it, true); };
	for (const id of ["#pc-color", "#pc-detail", "#pc-opacity", ...CLASS_GROUPS.map(g => `#pc-cls-${g.id}`)]) $(id).addEventListener("change", restyle);
	const setLift = (v: number) => { $<HTMLInputElement>("#pc-lift").value = String(Math.max(-30, Math.min(30, v))); lift(); };
	outs();

	// ── 地形に合わせる（地面の点＝分類 2 の見本と、描いている地形の差の中央値） ──
	const R = 6371000, D2R = Math.PI / 180, GS_MAX = 1200;
	const groundOf = (d: PointCloudDump): Array<[number, number, number]> => {   // 東北上 → 経緯度（dumpEnu の逆）・高さは標高
		const out: Array<[number, number, number]> = [], lon0 = d.anchor[0], lat0 = d.anchor[1], ce = Math.cos(lat0 * D2R) * D2R * R, cn = D2R * R;
		let g = 0; for (let i = 0; i < d.n; i++) if (d.cls[i] === 2) g++;
		if (!g) return out;
		const stride = Math.max(1, Math.ceil(g / GS_MAX));
		for (let i = 0, k = 0; i < d.n; i++) if (d.cls[i] === 2 && k++ % stride === 0) out.push([lon0 + d.pts[i * 3] / ce, lat0 + d.pts[i * 3 + 1] / cn, d.elev[i]]);
		return out;
	};
	const gapText = (r: { offset: number | null; samples: number }) => r.offset == null ? t("No ground points (class 2) in this file.") : tf(t("Terrain minus points: $1 m (median of $2 ground points)"), `${r.offset > 0 ? "+" : ""}${r.offset.toFixed(2)}`, fmtN(r.samples));
	// 地形の標高は着荷を待つ＝来なければ 12 秒で諦める（null＝読めなかった）
	const measure = async (ground: Array<[number, number, number]>): Promise<{ offset: number | null; samples: number } | null> => {
		if (!ground.length) return { offset: null, samples: 0 };
		const hs = await Promise.race([map.sampleTerrain(ground.map(p => [p[0], p[1]] as [number, number])), new Promise<null>(r => setTimeout(() => r(null), 12000))]).catch(() => null);
		if (!hs) return null;
		const d = hs.map((h, i) => h.height - ground[i][2]).filter(Number.isFinite).sort((a, b) => a - b);
		return d.length ? { offset: Math.round(d[d.length >> 1] * 100) / 100, samples: d.length } : { offset: null, samples: 0 };
	};
	const fit = async (it: Item, auto = false) => {
		$("#pc-gap").textContent = t("Reading the terrain…");
		const r = await measure(it.ground);
		if (it !== active) return;
		if (!r) { $("#pc-gap").textContent = t("Could not read the terrain height here."); return; }
		$("#pc-gap").textContent = gapText(r);
		if (r.offset != null && (!auto || $<HTMLInputElement>("#pc-autofit").checked)) setLift(r.offset);
	};
	$("#pc-fit").onclick = () => { if (active) fit(active).catch(e => console.warn("[pointcloud] fit", e)); };
	$("#pc-zero").onclick = () => setLift(0);

	// ── 書き出し（SPZ＝最も細かい段＋置き場・3D Tiles＝段ごとの glb と tileset.json・どちらも無圧縮 zip で 1 本）＝最後に開いた図郭 ──
	const download = (name: string, bytes: Uint8Array, type = "application/zip") => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 60000); };
	const EXP_BTNS = ["#pc-exp-spz", "#pc-exp-tiles", "#pc-exp-ply", "#pc-exp-las"];
	const exportable = () => { const on = !!cur(); for (const id of EXP_BTNS) $<HTMLButtonElement>(id).disabled = !on; };
	const exportAs = async (kind: "spz" | "tiles" | "ply" | "las") => {
		const it = active, h = it?.h; if (!it || !h) return;
		for (const id of EXP_BTNS) $<HTMLButtonElement>(id).disabled = true;
		$("#pc-exp").textContent = t("Exporting…");
		try {
			const name = it.label.replace(/[^\w.-]+/g, "_");
			if (kind === "ply" || kind === "las") {   // Unity 向け PLY／Unreal 向け LAS＝読んだ点（保管した物）をそのまま（docs/notes/unity-roundtrip.md §3.3・unreal-roundtrip.md §4）
				const { d } = await pointsOf(it, false);
				const bytes = kind === "ply" ? dumpToPly(d, { source: it.src }) : dumpToLas(d, { source: it.src });
				download(`${name}.${kind}`, bytes, "application/octet-stream");
				$("#pc-exp").textContent = tf(t("Exported $1 ($2)"), `${name}.${kind}`, mb(bytes.length));
				return;
			}
			const c = await h.read();
			const files = kind === "spz" ? [{ name: `${name}.spz`, bytes: await cloudToSpz(c, 0) }, { name: "placement.json", bytes: new TextEncoder().encode(JSON.stringify(spzPlacement(c), null, "\t")) }] : await cloudTo3DTiles(c);
			const zip = zipStore(files);
			download(`${name}-${kind === "spz" ? "spz" : "3dtiles"}.zip`, zip);
			$("#pc-exp").textContent = tf(t("Exported $1 ($2)"), `${name}-${kind === "spz" ? "spz" : "3dtiles"}.zip`, mb(zip.length));
		} catch (e) { $("#pc-exp").textContent = String((e as Error)?.message || e); }
		finally { exportable(); }
	};
	$("#pc-exp-spz").onclick = () => exportAs("spz"); $("#pc-exp-tiles").onclick = () => exportAs("tiles"); $("#pc-exp-ply").onclick = () => exportAs("ply"); $("#pc-exp-las").onclick = () => exportAs("las");

	// ── 読む：保管した段 → 保管した点 → 回線（読んだ点と変換した段はその場で保管）・変換は 1 枚ずつ（GPU とメモリ） ──
	const ptsKey = (it: Item) => cacheKey("points", it.ck, "auto");
	/** 読んだ点（自分の点だけ・分類で落とす前）＝保管 → 回線 */
	const pointsOf = async (it: Item, show: boolean): Promise<{ d: PointCloudDump; from: string }> => {
		const saved = await cache.get(ptsKey(it));
		if (saved) return { d: unpack<PointCloudDump>(saved), from: t("from this device") };
		const d = await map.readPointCloud(it.src, { ...it.extra, onProgress: (a, b) => { if (!show || items.get(it.key) !== it) return; bar(a / b); status(a < b ? tf(t("Downloading $1 — $2 / $3"), it.label, mb(a), mb(b)) : t("Decoding…")); } });
		await cache.put(ptsKey(it), pack(d)).catch(e => console.warn("[pointcloud] cache points", e));
		return { d, from: "" };
	};
	/** 隣で出している図郭（保管に点がある物）の鍵 */
	const shownNeighbors = (it: Item) => it.code ? neighborCodes(it.code).map(c => [...items.values()].find(x => x.code === c && x.h)).filter((x): x is Item => !!x).map(x => x.key).sort() : [];
	/** 図郭を描く（restyling＝見せ方を変えた・隣が増えた＝絵が出るまで前の物を残す） */
	async function build(it: Item, quiet: boolean) {
		if (items.get(it.key) !== it) return;
		const show = !quiet || it === active, t0 = performance.now(), st = style(), keep = classKeep(st.classes);
		const nb = shownNeighbors(it), edges = nb.join(","), cls = keep ? st.classes.join("+") : "";
		const kCloud = cacheKey("cloud", it.ck, "auto", st) + (cls ? `:c=${cls}` : "") + (edges ? `:e=${encodeURIComponent(edges)}` : "");
		if (show) { status(tf(t("Opening $1…"), it.label)); bar(0); }
		let h: SplatHandle, from = "";
		const saved = await cache.get(kCloud);
		if (items.get(it.key) !== it) return;
		const opts = { kind: "splat" as const, id: `pc-${it.key}`, attribution: ATTR };
		if (saved) {   // ① 変換済みの段＝載せるだけ
			const c = unpack<CloudData & { points: number; info: unknown }>(saved);
			if (show) status(t("Loading the saved splats…"));
			h = map.addData({ anchor: c.anchor, levels: c.levels.map(l => ({ ...l, ctr: l.ctr.slice(), cov: l.cov.slice(), col: l.col.slice() })) } satisfies CloudData, opts) as SplatHandle;
			await h.ready; h.points = c.points; h.info = c.info; from = t("from this device");
			if (!it.ground.length) { const p = await cache.get(ptsKey(it)); if (p) it.ground = groundOf(unpack<PointCloudDump>(p)); }
		} else {   // ② 保管した点・③ 回線 → 隣の縁を借りる → 分類で落とす → 変換
			const r = await pointsOf(it, show); from = r.from;
			if (items.get(it.key) !== it) return;
			const own = r.d as PointCloudDump & SheetPoints;
			it.ground = groundOf(own);
			const ghosts: EdgePoints[] = [];
			if (nb.length) {
				if (show) status(t("Borrowing the edges of the neighbouring sheets…"));
				const margin = edgeMargin(own.bb);
				for (const k of nb) { const p = await cache.get(cacheKey("points", items.get(k)?.ck ?? k, "auto")); if (p) ghosts.push(edgePoints(own, unpack<PointCloudDump & SheetPoints>(p), margin)); }
			}
			let d = filterClasses(withGhosts({ ...own, ghost: 0 }, ghosts), keep);
			if (d.pts === own.pts) d = { ...d, pts: own.pts.slice() };   // pts は描き手へ transfer される＝保管の view を渡さない
			if (!(d.n - (d.ghost ?? 0))) throw new Error(t("No points of the chosen classes in this sheet."));
			if (show) { status(t("Converting to splats on the GPU…")); bar(null); }
			h = map.addData(d as PointCloudDump, { ...opts, color: st.color, opacity: st.opacity, cloud: { detail: st.detail } }) as SplatHandle;
			await h.ready;
			h.read().then(c => cache.put(kCloud, pack({ ...c, points: h.points, info: h.info }))).then(showCache).catch(e => console.warn("[pointcloud] cache cloud", e));   // 変換した段を保管（絵が出た後・読み戻しは GPU から）
		}
		if (items.get(it.key) !== it) { h.remove(); return; }
		const prev = it.h; it.h = h; it.edges = edges; prev?.remove();
		it.alt0 = h.anchor![2]; h.setAltitude(it.alt0 + +$<HTMLInputElement>("#pc-lift").value);
		const i = h.info as { copc?: boolean; crs?: string; vertical?: string; zRange?: number[] } | null;
		it.info = `${i?.copc ? "COPC" : "LAS"} · ${i?.crs ?? ""}${i?.zRange ? `\n${t("Height")}: ${i.zRange.map(v => v.toFixed(1)).join(" – ")} m (${i.vertical})` : ""}${h.ms ? `\n${t("Conversion")}: ${h.ms.build} ms` : ""}`;
		if (show) {
			bar(null);
			status(`${it.label} — ${tf(t("$1 points → $2 splats in $3 levels"), fmtN(h.points), fmtN(h.n), String(h.levels?.length ?? 0))} · ${((performance.now() - t0) / 1000).toFixed(1)} s${from ? ` · ${from}` : ""}${edges ? ` · ${tf(t("edges matched with $1 sheets"), String(nb.length))}` : ""}`);
			$("#pc-info").textContent = it.info;
		}
		exportable(); showCache();
		// 隣が今の自分を借りていない＝隣も縁を借り直す（後ろで・1 枚ずつ）
		if (it.code) for (const k of nb) { const x = items.get(k); if (x && !x.edges.split(",").includes(it.key)) enqueue(x, true); }
	}
	const pending = new Set<Item>();
	function enqueue(it: Item, quiet = false) {
		if (pending.has(it)) return;
		pending.add(it);
		queue = queue.then(async () => { pending.delete(it); try { await build(it, quiet); } catch (e) { fail(it, e); } });
	}
	const fail = (it: Item, e: unknown) => {
		console.warn("[pointcloud]", it.label, e);
		if (items.get(it.key) === it && !it.h) { items.delete(it.key); if (active === it) active = [...items.values()].pop() ?? null; updateShown(); }
		bar(null); status(`${it.label}: ${String((e as Error)?.message || e)}`, true);
	};
	/** 出している物の数・URL（?sheet=鍵,鍵）・地図の印 */
	function updateShown() {
		highlight(); exportable();
		$("#pc-shown").textContent = items.size ? tf(t("$1 of $2 sheets shown"), String(items.size), String(MAX_SHEETS)) : "";
		$<HTMLButtonElement>("#pc-clear-all").disabled = !items.size;
		const u = new URL(location.href), s3 = [...items.keys()].filter(k => k.startsWith("s3:")).map(k => k.slice(3));
		if (s3.length) u.searchParams.set("sheet", s3.join(",")); else u.searchParams.delete("sheet");
		history.replaceState(null, "", u.href);
	}
	const removeItem = (it: Item) => { items.delete(it.key); it.h?.remove(); it.h = null; if (active === it) { active = [...items.values()].pop() ?? null; $("#pc-info").textContent = active?.info ?? ""; $("#pc-gap").textContent = ""; } };
	/** 図郭を足す（出ている物をもう一度＝外す）。上限を超えたら一番古い物を外す */
	const toggle = (src: string, key: string, label: string, extra: Partial<SplatOptions> = {}, code: string | null = null, force = false, ck = key) => {
		const had = items.get(key);
		if (had) { if (force) return; removeItem(had); status(tf(t("Removed $1"), label)); updateShown(); return; }
		while (items.size >= MAX_SHEETS) { const old = [...items.values()][0]; removeItem(old); }
		const it: Item = { key, ck, src, label, extra, code, h: null, alt0: 0, ground: [], edges: "", info: "" };
		items.set(key, it); active = it; $("#pc-info").textContent = ""; $("#pc-gap").textContent = "";
		updateShown();
		const first = !cur() && items.size === 1;
		queue = queue.then(async () => { try { await build(it, false); if (it.h && it === active && first && $<HTMLInputElement>("#pc-autofit").checked) fit(it, true).catch(e => console.warn("[pointcloud] fit", e)); } catch (e) { fail(it, e); } });
	};
	$("#pc-clear-all").onclick = () => { for (const it of [...items.values()]) removeItem(it); status(""); updateShown(); };
	let copcIx: CopcIndex = { version: 1, sets: {} };
	/** 図郭を開く＝COPC があればそれ（Hugging Face・節だけ範囲読み）・無ければ県の .zip。key は S3 の鍵のまま（URL の ?sheet= と地図の印） */
	const openSheet = (f: { key: string; size: number }, force = false) => {
		const name = last(f.key).replace(/\.zip$/i, ""), c = copcOf(copcIx, f.key);
		toggle(c ? c.url : S3 + f.key, "s3:" + f.key, c ? `${name} (COPC)` : name, { crs: "EPSG:6676", vertical: "orthometric" }, name.replace(/^08/, "").toUpperCase(), force, c ? "hf:" + c.path : "s3:" + f.key);
	};
	$("#pc-atami").onclick = () => { toggle(ATAMI, "atami", t("Atami sample (COPC)")); };

	// ── 区画（5000）と図郭（500）を地図に ──
	const FC = (features: GeoJSONFeature[]) => ({ type: "FeatureCollection" as const, features });
	map.addSource("pc-cover", { type: "geojson", data: FC([]) });
	map.addSource("pc-sheet", { type: "geojson", data: FC([]) });
	await map.addLayer({ id: "pc-cover-fill", type: "fill", source: "pc-cover", paint: { "fill-color": "#7fb2ff", "fill-opacity": 0.06 } });
	await map.addLayer({ id: "pc-cover-line", type: "line", source: "pc-cover", paint: { "line-color": "#7fb2ff", "line-width": 1.2, "line-opacity": 0.8 } });
	await map.addLayer({ id: "pc-sheet-fill", type: "fill", source: "pc-sheet", paint: { "fill-color": ["case", ["==", ["get", "on"], 1], "#ffd34d", ["==", ["get", "copc"], 1], "#7fe3ff", ["==", ["get", "big"], 1], "#ff9a4d", "#9fe3a0"], "fill-opacity": ["case", ["==", ["get", "on"], 1], 0.28, 0.12] } });
	await map.addLayer({ id: "pc-sheet-line", type: "line", source: "pc-sheet", paint: { "line-color": ["case", ["==", ["get", "on"], 1], "#ffd34d", ["==", ["get", "copc"], 1], "#7fe3ff", "#9fe3a0"], "line-width": ["case", ["==", ["get", "on"], 1], 2.4, 1] } });
	const COVER_LAYERS = ["pc-cover-fill", "pc-cover-line", "pc-sheet-fill", "pc-sheet-line"];
	$("#pc-cover").addEventListener("change", () => { const on = $<HTMLInputElement>("#pc-cover").checked; for (const id of COVER_LAYERS) map.setLayoutProperty(id, "visibility", on ? "visible" : "none"); });

	let set = DEFAULT_SET, top: string[] = [], blocks: string[] = [], sheets: Array<{ key: string; size: number; code: string }> = [], block: string | null = null, listAc: AbortController | null = null;
	const copcIxP = loadCopcIndex().then(ix => { copcIx = ix; if (sheets.length) chooseBlock(block!); });   // 取れたら一覧を出し直す（COPC の印）
	const sheetFeats = () => FC(sheets.map(f => { const b = sheetBox(f.code)!; return { type: "Feature", geometry: { type: "Polygon", coordinates: [sheetRing(b)] }, properties: { key: f.key, code: f.code, on: items.has("s3:" + f.key) ? 1 : 0, big: !copcOf(copcIx, f.key) && f.size > BIG_MB << 20 ? 1 : 0, copc: copcOf(copcIx, f.key) ? 1 : 0 } } as GeoJSONFeature; }));
	function highlight() {
		map.getSource("pc-sheet")?.setData(sheetFeats());
		side.querySelectorAll<HTMLElement>(".sheet").forEach(el => el.classList.toggle("on", items.has("s3:" + el.dataset.key)));
		$("#pc-atami").classList.toggle("on", items.has("atami"));
	}
	// 一覧の知らせは hint の欄（status は読みの知らせ＝並んで走っても上書きし合わない）
	const listMsg = (s: string, err = false) => { const el = $("#pc-hint"); el.textContent = s; el.classList.toggle("err", err); };
	const hint = (pre = "") => { $("#pc-hint").classList.remove("err"); $("#pc-hint").textContent = pre + (block ? t("Click a sheet (400 m × 300 m) on the map or in the list. Orange ones are large downloads.") + " " + t("Click more sheets to show them side by side; click a shown sheet again to remove it.") : blocks.length ? t("Click a blue block (4 km × 3 km) on the map to list its sheets.") : ""); };
	// データの組 → 区画（50000 の図郭ごとに 5000 の一覧）
	async function chooseSet(id: string) {
		set = id; block = null; sheets = []; listAc?.abort(); const ac = listAc = new AbortController();
		$("#pc-sheets").replaceChildren(); highlight();
		map.getSource("pc-cover")?.setData(FC([])); listMsg(t("Listing the map sheets…"));
		try {
			top = (await listS3(`${id}/08/`, ac.signal)).dirs;
			const subs = await Promise.all(top.map(d => listS3(d, ac.signal)));
			if (ac.signal.aborted) return;
			blocks = [...new Set(subs.flatMap(s => s.dirs).map(d => d.split("/").slice(-3, -1).join("").toUpperCase()))].filter(c => sheetBox(c));
			map.getSource("pc-cover")?.setData(FC(blocks.map(c => ({ type: "Feature", geometry: { type: "Polygon", coordinates: [sheetRing(sheetBox(c)!)] }, properties: { code: c } } as GeoJSONFeature))));
			hint(tf(t("$1 blocks."), fmtN(blocks.length)) + " ");
		} catch (e) { if (!ac.signal.aborted) listMsg(tf(t("Could not list the data: $1"), String((e as Error)?.message || e)), true); }
	}
	// 区画 → 図郭の一覧（S3 の 1 頁）
	async function chooseBlock(code: string) {
		const ac = listAc = new AbortController();
		block = code; listMsg(t("Listing the map sheets…"));
		const want = code.toUpperCase(), up = (s: string) => s.toUpperCase();
		try {
			const d50 = top.filter(   // 50000 の図郭名は大文字・小文字が混ざる（"of"・"mc"）＝一覧から実の名を引く
				d => up(last(d)) === want.slice(0, 2));
			const d5 = (await Promise.all(d50.map(d => listS3(d, ac.signal)))).flatMap(s => s.dirs).filter(d => last(d) === want.slice(2));
			const files = (await Promise.all(d5.map(d => listS3(d, ac.signal)))).flatMap(s => s.files);
			if (ac.signal.aborted) return;
			const seen = new Set<string>();   // 大文字と小文字の両方の階層に同じ図郭がある組（2021 の "MC"・"mc"）＝先に出た方だけ
			sheets = files.map(f => ({ ...f, code: up(last(f.key).replace(/\.zip$/i, "").replace(/^08/, "")) })).filter(f => sheetBox(f.code) && !seen.has(f.code) && !!seen.add(f.code)).sort((a, b) => a.code < b.code ? -1 : 1);
			$("#pc-sheets").replaceChildren(...sheets.map(f => {
				const c = copcOf(copcIx, f.key);   // COPC＝取るのは節だけ（大きさは COPC の物・橙の印は付けない）
				const b = document.createElement("button"); b.className = "sheet" + (c ? " copc" : f.size > BIG_MB << 20 ? " big" : ""); b.dataset.key = f.key;
				b.innerHTML = `${f.code}<span>${c ? `COPC · ${mb(c.size)}` : mb(f.size)}</span>`; b.onclick = () => openSheet(f); return b;
			}));
			highlight(); hint(tf(t("$1: $2 sheets."), want, fmtN(sheets.length)) + " ");
		} catch (e) { if (!ac.signal.aborted) listMsg(tf(t("Could not list the data: $1"), String((e as Error)?.message || e)), true); }
	}
	$<HTMLSelectElement>("#pc-set").onchange = e => chooseSet((e.target as HTMLSelectElement).value);
	// 地図のクリック＝図郭が出ていればそれ・無ければ区画
	map.on("click", "pc-sheet-fill", (e: LayerMouseEvent) => { const k = e.features[0]?.properties.key; const f = sheets.find(s => s.key === k); if (f) openSheet(f); });
	map.on("click", "pc-cover-fill", (e: LayerMouseEvent) => {
		if (!e.lngLat) return;
		const [x, y] = toPlane(e.lngLat.lng, e.lngLat.lat), code = sheetAt(x, y, "5000");
		if (!code || !blocks.includes(code)) return;
		if (code !== block || !sheets.length) chooseBlock(code);
		if (code !== block) { const b = sheetBox(code)!, sw = toLonLat(b[0], b[1]), ne = toLonLat(b[2], b[3]); map.fitBounds([sw[0], sw[1], ne[0], ne[1]] as Bbox, { padding: 40 }); }
	});

	// ── 起動：?sheet=<S3 の鍵>（「,」で並べて複数）ならその図郭・無ければ熱海の見本 ──
	await chooseSet(DEFAULT_SET);
	await new Promise<void>(r => { const off = map.onFrame(() => { off(); r(); }); });   // 最初の絵が出てから＝起動の視点合わせが寄り（fitBounds）を上書きしない（エンジンの ?copc= と同じ待ち）
	const qs = (new URLSearchParams(location.search).get("sheet") ?? "").split(",").filter(q => /^[\w/.-]+\.zip$/i.test(q) && !q.includes("..")).slice(-MAX_SHEETS);
	if (qs.length) {
		await Promise.race([copcIxP, new Promise(r => setTimeout(r, 4000))]);   // 共有 URL の図郭も COPC があればそちら（台帳が遅ければ待たない）
		const q = qs[qs.length - 1], code = last(q).replace(/\.zip$/i, "").replace(/^08/, "").toUpperCase(), b = sheetBox(code);
		const s = SETS.find(x => q.startsWith(x.id + "/")); if (s && s.id !== set) { $<HTMLSelectElement>("#pc-set").value = s.id; await chooseSet(s.id); }
		if (b) chooseBlock(code.slice(0, 4));
		for (const k of qs) openSheet({ key: k, size: 0 }, true);
	} else toggle(ATAMI, "atami", t("Atami sample (COPC)"));   // 視点は頁の既定（ATAMI_VIEW）か共有 URL の hash
	return { open: toggle, openSheet, chooseSet, chooseBlock, cache, items, get idle() { return queue; }, get handle() { return cur(); } };
}
