// 静岡県の点群（VIRTUAL SHIZUOKA）の案内板と配線（pointcloud.html から遅延 import・2026-10-18・熱海の点群の見本を広げた物）。
// 「データの組（年・計測の種類）を選ぶ → 4 km × 3 km の区画が地図に出る → 区画をクリック → 400 m × 300 m の図郭が出る → 図郭をクリックで点群」。
// データ＝静岡県が AWS（Open Data on AWS・s3://virtual-shizuoka・CORS 可・範囲読み可）に置く図郭ごとの .zip（中に .las が 1 つ・座標系の書き込み無し＝平面直角 VIII 系・標高）。
//   一覧は S3 の ListObjectsV2 を頁が直に引く（台帳を焼かない＝県が足した物もそのまま出る）。.zip はエンジン（copc-worker の ZIP の口）が範囲読みで解く。
//   熱海の見本（COPC・ortho-data の gh-pages）も残す＝節だけ範囲読みの速さを見せる方。
// 図郭の番号と VIII 系の換算＝pointcloud-sheets.ts（"08MC4919"＝VIII 系・M 行 C 列・5000 の 4 行 9 列・500 の 1 行 9 列）。
// 見せ方＝点の大きさ・色・細かさ・不透明度・距離で縮む、高さ＝足し込み（読み直さずに効く）と「地形に合わせる」（地面の点と描いている地形の差の中央値）。
import { tr, getLang, LANGUAGES } from "@ortho-earth/globe/i18n.js";
import { toPlane, toLonLat, sheetBox, sheetAt, sheetRing } from "./pointcloud-sheets.ts";
import type { GlobeMap, COPCHandle, COPCOptions, LayerMouseEvent, GeoJSONFeature, Bbox } from "@ortho-earth/globe";

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

// 案内板の長文（英語キー）＝訳は頁の辞書 i18n/pages/pointcloud.json
const HOW = [
	"Shizuoka Prefecture publishes its laser surveys on AWS as one ZIP file per 400 m × 300 m map sheet (a LAS file inside, CC BY 4.0). The page lists the bucket directly — no index is baked here, so new data shows up as soon as the prefecture adds it.",
	"Clicking a sheet reads just that file's entry in the ZIP by HTTP Range, unpacks it in a worker as it arrives, and builds an octree on the spot. Only the decoded points are kept — the ZIP itself is never held in memory.",
	"The files carry no coordinate system, so the page passes Japan Plane Rectangular CS VIII (EPSG:6676) and treats heights as orthometric (above the geoid), like the map's terrain.",
	"The Atami sample is the same survey converted to COPC: only the octree nodes in view are fetched, which is why it opens at once.",
	"Fit to terrain compares the ground points (class 2) with the terrain that is drawn and moves the cloud by the median difference. The map's terrain comes from different source data, so a few metres of difference are normal.",
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
#side .bar { margin: 8px 16px 0; height: 6px; background: rgba(255,255,255,.1); border-radius: 3px; overflow: hidden; }
#side .bar[hidden] { display: none; }
#side .bar i { display: block; height: 100%; width: 0; background: #7fb2ff; transition: width .15s; }
#side .status { padding: 6px 16px 0; color: rgba(255,255,255,.75); font-size: 12px; min-height: 1.4em; }
#side .status.err, #side .hint.err { color: #ff9b8a; }
#side .info { padding: 2px 16px 0; color: rgba(255,255,255,.55); font: 11px ui-monospace, Menlo, monospace; white-space: pre-line; }
#side .check { display: flex; gap: 6px; align-items: center; padding: 6px 16px 0; color: rgba(255,255,255,.78); font-size: 12px; }
#side details { border-top: 1px solid rgba(255,255,255,.12); margin-top: 12px; padding: 6px 16px; font-size: 12px; }
#side details summary { cursor: pointer; font-weight: 600; color: #fff; padding: 4px 0; }
#side details ul { margin: 4px 0 6px; padding-inline-start: 18px; color: rgba(255,255,255,.78); }
#side details li { margin: 3px 0; }
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

export async function mountPointcloud(map: GlobeMap, side: HTMLElement) {
	const lang = getLang();
	document.head.insertAdjacentHTML("beforeend", `<style>${CSS}</style>`);

	side.insertAdjacentHTML("beforeend", `
		<div class="head"><h1>${t("Point clouds of Shizuoka")}<small>${t("Laser surveys of Shizuoka Prefecture (VIRTUAL SHIZUOKA), read straight from the open data")}</small></h1><select class="lang" aria-label="Language">${LANGUAGES.map(l => `<option value="${l.code}"${l.code === lang ? " selected" : ""}>${l.name}</option>`).join("")}</select></div>
		<h2>${t("Data")}</h2>
		<div class="row"><button class="btn" id="pc-atami">${t("Atami sample (COPC)")}</button></div>
		<div class="row"><label for="pc-set">${t("Survey")}</label><select id="pc-set">${SETS.map(s => `<option value="${s.id}"${s.id === DEFAULT_SET ? " selected" : ""}>${s.year} · ${t(KIND[s.kind])} · ${t(PART[s.part])}</option>`).join("")}</select></div>
		<div class="hint" id="pc-hint"></div>
		<div class="sheets" id="pc-sheets"></div>
		<div class="bar" id="pc-bar" hidden><i></i></div>
		<div class="status" id="pc-status"></div>
		<div class="info" id="pc-info"></div>
		<h2>${t("Display")}</h2>
		<div class="row"><label for="pc-size">${t("Point size")}</label><input type="range" id="pc-size" min="0.5" max="8" step="0.5" value="2"><output id="pc-size-v"></output></div>
		<div class="row"><label for="pc-color">${t("Colour")}</label><select id="pc-color">${["auto", "rgb", "elevation", "intensity", "classification"].map(c => `<option value="${c}">${t({ auto: "Automatic", rgb: "True colour (RGB)", elevation: "Height", intensity: "Intensity", classification: "Classification" }[c]!)}</option>`).join("")}</select></div>
		<div class="row"><label for="pc-density">${t("Detail")}</label><input type="range" id="pc-density" min="1" max="8" step="0.5" value="2"><output id="pc-density-v"></output></div>
		<div class="row"><label for="pc-opacity">${t("Opacity")}</label><input type="range" id="pc-opacity" min="0.1" max="1" step="0.05" value="1"><output id="pc-opacity-v"></output></div>
		<label class="check"><input type="checkbox" id="pc-atten" checked>${t("Shrink points with distance")}</label>
		<label class="check"><input type="checkbox" id="pc-cover" checked>${t("Show map sheets")}</label>
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

	// ── 見せ方（手綱に setOptions・次に開く物にも同じ値） ──
	const style = (): Partial<COPCOptions> => ({
		pointSize: +$<HTMLInputElement>("#pc-size").value, color: $<HTMLSelectElement>("#pc-color").value as COPCOptions["color"], density: +$<HTMLInputElement>("#pc-density").value,
		opacity: +$<HTMLInputElement>("#pc-opacity").value, attenuation: $<HTMLInputElement>("#pc-atten").checked, heightOffset: +$<HTMLInputElement>("#pc-lift").value,
	});
	const outs = () => {
		$("#pc-size-v").textContent = `${$<HTMLInputElement>("#pc-size").value} px`;
		$("#pc-density-v").textContent = `${$<HTMLInputElement>("#pc-density").value} px`;
		$("#pc-opacity-v").textContent = `${Math.round(+$<HTMLInputElement>("#pc-opacity").value * 100)}%`;
		const v = +$<HTMLInputElement>("#pc-lift").value; $("#pc-lift-v").textContent = `${v > 0 ? "+" : ""}${v.toFixed(1)} m`;
	};
	let cur: COPCHandle | null = null, curKey: string | null = null, loading: AbortController | null = null;
	const restyle = () => { outs(); cur?.setOptions(style()); };
	for (const id of ["#pc-size", "#pc-density", "#pc-opacity", "#pc-lift"]) $(id).addEventListener("input", restyle);
	for (const id of ["#pc-color", "#pc-atten"]) $(id).addEventListener("change", restyle);
	const setLift = (v: number) => { $<HTMLInputElement>("#pc-lift").value = String(Math.max(-30, Math.min(30, v))); restyle(); };
	outs();

	// ── 地形に合わせる（地面の点と描いている地形の差） ──
	const gapText = (r: { offset: number | null; samples: number }) => r.offset == null ? t("No ground points loaded yet — try again in a moment.") : tf(t("Terrain minus points: $1 m (median of $2 ground points)"), `${r.offset > 0 ? "+" : ""}${r.offset.toFixed(2)}`, fmtN(r.samples));
	// 地形の標高は着荷を待つ＝来なければ 12 秒で諦める（null＝読めなかった）
	const measure = (h: COPCHandle) => Promise.race([h.fitTerrain({ apply: false }), new Promise<null>(r => setTimeout(() => r(null), 12000))]).catch(() => null);
	const fit = async (h: COPCHandle) => {
		$("#pc-gap").textContent = t("Reading the terrain…");
		const r = await measure(h);
		if (h !== cur) return;
		if (!r) { $("#pc-gap").textContent = t("Could not read the terrain height here."); return; }
		$("#pc-gap").textContent = gapText(r);
		if (r.offset != null) setLift(r.offset);
	};
	$("#pc-fit").onclick = () => { if (cur) fit(cur).catch(e => console.warn("[pointcloud] fit", e)); };
	$("#pc-zero").onclick = () => setLift(0);
	// 読んだ後に一度測る＝節が地面の見本を持ってくるのを少し待つ（見本が無ければもう一度）
	const autoFit = (h: COPCHandle, tries = 4) => setTimeout(async () => {
		if (h !== cur) return;
		const r = await measure(h);
		if (h !== cur) return;
		if (!r) { $("#pc-gap").textContent = t("Could not read the terrain height here."); return; }
		if ((r.offset == null || r.samples < 40) && tries > 1) return autoFit(h, tries - 1);
		$("#pc-gap").textContent = gapText(r);
		if (r.offset != null && $<HTMLInputElement>("#pc-autofit").checked) setLift(r.offset);
	}, 1500);

	// ── 読む ──
	const open = async (src: string, key: string, label: string, extra: Partial<COPCOptions> = {}) => {
		loading?.abort(); const ac = loading = new AbortController();
		if (cur) { cur.remove(); cur = null; }
		curKey = key; highlight();
		$("#pc-info").textContent = ""; $("#pc-gap").textContent = "";
		if ($<HTMLInputElement>("#pc-autofit").checked) setLift(0);
		status(tf(t("Opening $1…"), label)); bar(0);
		const t0 = performance.now();
		try {
			const h = await map.addPointCloud(src, { id: "pc", attribution: ATTR, ...style(), ...extra,
				onProgress: (a, b) => { if (ac.signal.aborted) return; bar(a / b); status(a < b ? tf(t("Downloading $1 — $2 / $3"), label, mb(a), mb(b)) : t("Building the octree…")); } });
			if (ac.signal.aborted) { h.remove(); return; }
			cur = h; bar(null);
			const i = h.info;
			status(`${label} — ${tf(t("$1 points"), fmtN(i.count))} · ${((performance.now() - t0) / 1000).toFixed(1)} s`);
			$("#pc-info").textContent = `${i.copc ? "COPC" : i.inMemory ? "LAS → octree" : "LAS"} · ${i.crs}\n${t("Height")}: ${i.zRange.map(v => v.toFixed(1)).join(" – ")} m (${i.vertical})`;
			autoFit(h);
			const u = new URL(location.href); if (key.startsWith("s3:")) u.searchParams.set("sheet", key.slice(3)); else u.searchParams.delete("sheet"); history.replaceState(null, "", u.href);
		} catch (e) {
			if (ac.signal.aborted) return;
			bar(null); curKey = null; highlight();
			status(`${label}: ${String((e as Error)?.message || e)}`, true);
		}
	};
	const openSheet = (f: { key: string; size: number }) => open(S3 + f.key, "s3:" + f.key, last(f.key).replace(/\.zip$/i, ""), { crs: "EPSG:6676", vertical: "orthometric" });
	$("#pc-atami").onclick = () => { open(ATAMI, "atami", t("Atami sample (COPC)")); };

	// ── 区画（5000）と図郭（500）を地図に ──
	const FC = (features: GeoJSONFeature[]) => ({ type: "FeatureCollection" as const, features });
	map.addSource("pc-cover", { type: "geojson", data: FC([]) });
	map.addSource("pc-sheet", { type: "geojson", data: FC([]) });
	await map.addLayer({ id: "pc-cover-fill", type: "fill", source: "pc-cover", paint: { "fill-color": "#7fb2ff", "fill-opacity": 0.06 } });
	await map.addLayer({ id: "pc-cover-line", type: "line", source: "pc-cover", paint: { "line-color": "#7fb2ff", "line-width": 1.2, "line-opacity": 0.8 } });
	await map.addLayer({ id: "pc-sheet-fill", type: "fill", source: "pc-sheet", paint: { "fill-color": ["case", ["==", ["get", "on"], 1], "#ffd34d", ["==", ["get", "big"], 1], "#ff9a4d", "#9fe3a0"], "fill-opacity": ["case", ["==", ["get", "on"], 1], 0.28, 0.12] } });
	await map.addLayer({ id: "pc-sheet-line", type: "line", source: "pc-sheet", paint: { "line-color": ["case", ["==", ["get", "on"], 1], "#ffd34d", "#9fe3a0"], "line-width": ["case", ["==", ["get", "on"], 1], 2.4, 1] } });
	const COVER_LAYERS = ["pc-cover-fill", "pc-cover-line", "pc-sheet-fill", "pc-sheet-line"];
	$("#pc-cover").addEventListener("change", () => { const on = $<HTMLInputElement>("#pc-cover").checked; for (const id of COVER_LAYERS) map.setLayoutProperty(id, "visibility", on ? "visible" : "none"); });

	let set = DEFAULT_SET, top: string[] = [], blocks: string[] = [], sheets: Array<{ key: string; size: number; code: string }> = [], block: string | null = null, listAc: AbortController | null = null;
	const sheetFeats = () => FC(sheets.map(f => { const b = sheetBox(f.code)!; return { type: "Feature", geometry: { type: "Polygon", coordinates: [sheetRing(b)] }, properties: { key: f.key, code: f.code, on: curKey === "s3:" + f.key ? 1 : 0, big: f.size > BIG_MB << 20 ? 1 : 0 } } as GeoJSONFeature; }));
	function highlight() {
		map.getSource("pc-sheet")?.setData(sheetFeats());
		side.querySelectorAll<HTMLElement>(".sheet").forEach(el => el.classList.toggle("on", curKey === "s3:" + el.dataset.key));
		$("#pc-atami").classList.toggle("on", curKey === "atami");
	}
	// 一覧の知らせは hint の欄（status は読みの知らせ＝並んで走っても上書きし合わない）
	const listMsg = (s: string, err = false) => { const el = $("#pc-hint"); el.textContent = s; el.classList.toggle("err", err); };
	const hint = (pre = "") => { $("#pc-hint").classList.remove("err"); $("#pc-hint").textContent = pre + (block ? t("Click a sheet (400 m × 300 m) on the map or in the list. Orange ones are large downloads.") : blocks.length ? t("Click a blue block (4 km × 3 km) on the map to list its sheets.") : ""); };
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
				const b = document.createElement("button"); b.className = "sheet" + (f.size > BIG_MB << 20 ? " big" : ""); b.dataset.key = f.key;
				b.innerHTML = `${f.code}<span>${mb(f.size)}</span>`; b.onclick = () => openSheet(f); return b;
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

	// ── 起動：?sheet=<S3 の鍵> ならその図郭・無ければ熱海の見本 ──
	await chooseSet(DEFAULT_SET);
	await new Promise<void>(r => { const off = map.onFrame(() => { off(); r(); }); });   // 最初の絵が出てから＝起動の視点合わせが寄り（fitBounds）を上書きしない（エンジンの ?copc= と同じ待ち）
	const q = new URLSearchParams(location.search).get("sheet");
	if (q && /^[\w/.-]+\.zip$/i.test(q) && !q.includes("..")) {
		const code = last(q).replace(/\.zip$/i, "").replace(/^08/, "").toUpperCase(), b = sheetBox(code);
		const s = SETS.find(x => q.startsWith(x.id + "/")); if (s && s.id !== set) { $<HTMLSelectElement>("#pc-set").value = s.id; await chooseSet(s.id); }
		if (b) chooseBlock(code.slice(0, 4));
		openSheet({ key: q, size: 0 });
	} else open(ATAMI, "atami", t("Atami sample (COPC)"), { fit: false });   // 視点は頁の既定（ATAMI_VIEW）か共有 URL の hash
	return { open, chooseSet, chooseBlock, get handle() { return cur; } };
}
