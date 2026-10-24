// voxel の見本（/globe/voxel・voxel.html から遅延 import・2026-10-23）。
// @ortho-earth/voxel（予約された map.addData の kind "voxel"）を本物の場所で 4 つの場面に：
//   雲      … 富士山の上の 3D ノイズの場（64×64×24・24 km 角×5 km）＝体積（volume）
//   トーラス … 距離場（48×48×24）＝閾を跨ぐ面（iso）
//   富士山   … 地形（map.sampleTerrain＝既定の DTM）を 333 m ごとに標本して 100 m のブロックに（80×80×40）＝blocks
//   地震     … USGS の目録（/quakes/archive.geopbf＝apps/quakes-mirror・M2+・1967〜）を経度×緯度×深さの格子に数えて地下の密度の体積に（region・112×104×35）
//   つまみ   … 描き方（volume／blocks／iso）・不透明度・閾・断面（下・上）・色表・建物と地形で隠す＝どれも格子を上げ直さない（setProps の "style"）
//   描くのは全部エンジンの公開の口（map.use・addData・setProps・sampleTerrain・geopbf）だけ。
import { tr, getLang } from "@ortho-earth/globe/i18n.js";   // UI 文言＝英語キー・26 言語。モジュール評価時に t() を呼ばない
import { createPanel } from "common/panel";
import { voxelPlugin, COLORMAP_NAMES } from "@ortho-earth/voxel";
import type { VoxelHandle, VoxelOptions, RenderMode, ColormapSpec } from "@ortho-earth/voxel";
import type { GlobeMap, VoxelData } from "@ortho-earth/globe";
import type { GeoPBF } from "geopbf";

const t = tr();
export const SCENES = ["cloud", "torus", "fuji", "quakes"] as const;
export type Scene = typeof SCENES[number];
/** 富士山の山頂（見本の錨） */
export const FUJI: [number, number] = [138.7274, 35.3606];
const QUAKES_URL = import.meta.env.DEV ? "https://www.ortho-earth.com/quakes/archive.geopbf" : "/quakes/archive.geopbf";   // dev は本番のミラーを直読み（CORS *）
const USGS_URL = "https://earthquake.usgs.gov/data/comcat/";
const K = 111320;
const ll = (e: number, n: number, h = 0): [number, number, number] => [FUJI[0] + e / (K * Math.cos(FUJI[1] * Math.PI / 180)), FUJI[1] + n / K, h];
const fmt = (n: unknown, d = 0) => Number(n).toLocaleString(getLang(), { maximumFractionDigits: d });

interface SceneDef { data: () => Promise<VoxelData>; opts: VoxelOptions; view: { center: [number, number]; zoom: number; pitch: number; bearing: number }; note: () => string }
/** 場面の定義（データは初めて選んだ時に作り、以後は覚える） */
function sceneDefs(map: GlobeMap, status: (s: string) => void): Record<Scene, SceneDef> {
	// 値ノイズ（3 オクターブ・滑らかな補間）
	const hash = (x: number, y: number, z: number): number => { let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
	const sm = (v: number) => v * v * (3 - 2 * v);
	const noise = (x: number, y: number, z: number): number => {
		const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z), fx = sm(x - ix), fy = sm(y - iy), fz = sm(z - iz);
		const l = (a: number, b: number, f: number) => a + (b - a) * f;
		const c = (dx: number, dy: number, dz: number) => hash(ix + dx, iy + dy, iz + dz);
		return l(l(l(c(0, 0, 0), c(1, 0, 0), fx), l(c(0, 1, 0), c(1, 1, 0), fx), fy), l(l(c(0, 0, 1), c(1, 0, 1), fx), l(c(0, 1, 1), c(1, 1, 1), fx), fy), fz);
	};
	const fbm = (x: number, y: number, z: number): number => 0.55 * noise(x, y, z) + 0.3 * noise(x * 2.1, y * 2.1, z * 2.1) + 0.15 * noise(x * 4.3, y * 4.3, z * 4.3);
	return {
		cloud: {
			data: async () => {
				const dims: [number, number, number] = [64, 64, 24], v = new Float32Array(dims[0] * dims[1] * dims[2]);
				for (let k = 0; k < dims[2]; k++) for (let j = 0; j < dims[1]; j++) for (let i = 0; i < dims[0]; i++) {
					const zc = (k + 0.5) / dims[2], prof = Math.max(0, 1 - Math.abs(zc - 0.45) * 2.2);   // 中層ほど雲が濃い
					v[i + dims[0] * (j + dims[1] * k)] = Math.max(0, Math.min(1, (fbm(i / 9, j / 9, k / 6) - 0.42) * 2.6 * prof));
				}
				return { dims, box: { origin: ll(-12000, -12000, 4200), size: [24000, 24000, 5000] }, values: v, noData: 0, range: [0, 1] };
			},
			opts: { render: "volume", colormap: ["#8fa8c8", "#ffffff"], alphaRamp: [0, 0.9], threshold: 0.08, opacity: 0.7, step: 0.5, altitude: "absolute" },
			view: VIEWS.cloud,
			note: () => t("Cloud: a noise field above Mt. Fuji, drawn as a volume."),
		},
		torus: {
			data: async () => {
				const dims: [number, number, number] = [48, 48, 24], v = new Float32Array(dims[0] * dims[1] * dims[2]);
				for (let k = 0; k < dims[2]; k++) for (let j = 0; j < dims[1]; j++) for (let i = 0; i < dims[0]; i++) {
					const x = (i + 0.5) / dims[0] - 0.5, y = (j + 0.5) / dims[1] - 0.5, z = ((k + 0.5) / dims[2] - 0.5) * 0.5;   // 箱は高さが半分
					const d = Math.hypot(Math.hypot(x, y) - 0.3, z);
					v[i + dims[0] * (j + dims[1] * k)] = Math.max(0, Math.min(1, 1 - d / 0.13));
				}
				return { dims, box: { origin: ll(-4000, -4000, 5000), size: [8000, 8000, 4000] }, values: v, noData: 0, range: [0, 1] };   // 山頂の真上 5〜9 km
			},
			opts: { render: "iso", colormap: "plasma", threshold: 0.5, opacity: 1, step: 0.35, altitude: "absolute" },
			view: VIEWS.torus,
			note: () => t("Torus: a distance field, drawn as the surface where it crosses the threshold."),
		},
		fuji: {
			data: async () => {
				// 16 km 角を 48×48（333 m）・高さ 100 m 刻み。sampleTerrain は 1 点 5 ms ほど（2026-10-23 実測＝1600 点 8.5 s）＝8 回に分けて進みを見せる
				const SIDE = 16000, dims: [number, number, number] = [48, 48, 40], cell = SIDE / dims[0], hcell = 100, v = new Float32Array(dims[0] * dims[1] * dims[2]);
				const pts: { lng: number; lat: number }[] = [];
				for (let j = 0; j < dims[1]; j++) for (let i = 0; i < dims[0]; i++) { const p = ll(-SIDE / 2 + (i + 0.5) * cell, -SIDE / 2 + (j + 0.5) * cell); pts.push({ lng: p[0], lat: p[1] }); }
				const hs: number[] = [], CH = Math.ceil(pts.length / 8);
				for (let a = 0; a < pts.length; a += CH) {
					status(`${t("Sampling the terrain…")} ${Math.round(a / pts.length * 100)}%`);
					for (const s of await map.sampleTerrain(pts.slice(a, a + CH))) hs.push(s.height);
				}
				for (let j = 0; j < dims[1]; j++) for (let i = 0; i < dims[0]; i++) {
					const h = Math.max(0, hs[j * dims[0] + i] ?? 0), top = Math.min(dims[2], Math.ceil(h / hcell));
					for (let k = 0; k < top; k++) v[i + dims[0] * (j + dims[1] * k)] = Math.max(1, h);   // 柱の値＝その地点の標高（色表）
				}
				return { dims, box: { origin: ll(-SIDE / 2, -SIDE / 2, 0), size: [SIDE, SIDE, dims[2] * hcell] }, values: v, noData: 0, range: [0, 3800] };
			},
			opts: { render: "blocks", colormap: [[0, "#2f6b3a"], [0.3, "#7a9a4a"], [0.55, "#8a6b4a"], [0.8, "#b9b1a6"], [1, "#ffffff"]], opacity: 1, altitude: "absolute", depthTest: false },
			view: VIEWS.fuji,
			note: () => t("Mt. Fuji: the terrain sampled every 333 m into 100 m blocks."),
		},
		quakes: {
			data: async () => {
				const src = new URLSearchParams(location.search).get("src") || QUAKES_URL;
				const { geopbf } = await import("@ortho-earth/globe");
				status(t("Loading…"));
				const pbf = await geopbf(src) as unknown as GeoPBF;
				const W = 122, S = 24, E = 150, N = 50, D = 700, dims: [number, number, number] = [112, 104, 35];   // 0.25°×0.25°×20 km
				const cnt = new Float32Array(dims[0] * dims[1] * dims[2]);
				let events = 0;
				for (let i = 0; i < pbf.length; i++) {
					if (i % 50000 === 0) { status(t("Reading $1 earthquakes…", fmt(i))); await new Promise(r => setTimeout(r, 0)); }
					const g = pbf.getGeometry(i) as { type: string; coordinates: number[] } | null; if (!g || g.type !== "Point") continue;
					const [lon, lat] = g.coordinates; if (lon < W || lon >= E || lat < S || lat >= N) continue;
					const p = pbf.getProperties(i) as { depth?: number; mag?: number }, dep = Math.max(0, Math.min(D - 1e-6, Number(p.depth) || 0));
					const ci = Math.floor((lon - W) / (E - W) * dims[0]), cj = Math.floor((lat - S) / (N - S) * dims[1]), ck = Math.floor((D - dep) / D * dims[2]);   // z＝深い方が下（h0＝−700 km）
					cnt[ci + dims[0] * (cj + dims[1] * ck)]++; events++;
				}
				for (let i = 0; i < cnt.length; i++) cnt[i] = cnt[i] > 0 ? Math.log10(1 + cnt[i]) : 0;
				st.events = events;
				return { dims, region: [W, S, E, N, -D * 1000, 0], values: cnt, noData: 0 };
			},
			opts: { render: "volume", colormap: "magma", alphaRamp: [0.05, 1], threshold: 0.3, opacity: 0.55, step: 0.6 },
			view: VIEWS.quakes,
			note: () => t("Earthquakes: the USGS catalog (M2+, 1967–) binned by longitude, latitude and depth under Japan; brighter is denser. Slice by depth with the sliders."),
		},
	};
}
const st = { events: 0 };
/** 場面の定位置（起動時の view＝共有 URL の hash が無い時） */
const VIEWS: Record<Scene, { center: [number, number]; zoom: number; pitch: number; bearing: number }> = {
	cloud: { center: [138.73, 35.28], zoom: 10.3, pitch: 62, bearing: 0 },
	torus: { center: [138.73, 35.31], zoom: 10.6, pitch: 62, bearing: 0 },
	fuji: { center: [138.73, 35.26], zoom: 10.4, pitch: 64, bearing: -15 },
	quakes: { center: [139.5, 36.5], zoom: 4.7, pitch: 55, bearing: -20 },
};
export const viewHash = (s: Scene): string => { const v = VIEWS[s]; return `#${v.zoom}/${v.center[1]}/${v.center[0]}/${v.pitch}t${v.bearing ? `/${v.bearing}r` : ""}`; };

export async function mountVoxel(map: GlobeMap, { scene: scene0 = "cloud", fly = true }: { scene?: Scene; fly?: boolean } = {}) {
	document.title = t("Voxels on the globe — ortho-globe");
	document.querySelector('meta[name="description"]')?.setAttribute("content", t("3D grids drawn on a real place on the globe by ray marching: clouds as a volume, a torus as an isosurface, Mt. Fuji as blocks, and 1.5 million USGS earthquakes as a density volume under Japan. Switch between volume, blocks and surface, slice the grid, WebGPU or WebGL2."));
	const mapEl = map.mapEl;
	map.use(voxelPlugin());
	const P = createPanel({ host: mapEl, title: t("Voxels on the globe"), sub: t("volume · blocks · isosurface"), cls: "voxel-panel", labels: { fold: t("Collapse panel"), unfold: t("Expand panel") } });
	const panel = P.el;
	P.body.insertAdjacentHTML("beforebegin", `<style>
.voxel-panel .stat{font-variant-numeric:tabular-nums;color:#fff}
.voxel-panel .lvl{color:#b9c3d6;font-variant-numeric:tabular-nums;font-size:12px}
.voxel-panel .row{margin:9px 0}
.voxel-panel label{display:flex;justify-content:space-between;align-items:center;gap:8px;color:#b9c3d6}
.voxel-panel label b{color:#fff;font-weight:600;font-variant-numeric:tabular-nums}
.voxel-panel label.chk{justify-content:flex-start;gap:6px;cursor:pointer}
.voxel-panel input[type=range]{width:100%;margin:3px 0 0;accent-color:#f8a95c}
.voxel-panel select{font:inherit;font-size:12px;border-radius:7px;border:1px solid rgba(255,255,255,.2);background:#1a2238;color:#e7ecf5;padding:3px 6px;max-width:170px}
.voxel-panel button.b{border-radius:8px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:#e7ecf5;padding:4px 10px;cursor:pointer;font:inherit}
.voxel-panel button.b.on{background:#f8a95c;color:#1a0d00;font-weight:700;border-color:transparent}
.voxel-panel .btns{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0}
.voxel-panel .seg{display:flex;border-radius:8px;overflow:hidden;border:1px solid rgba(255,255,255,.2)}
.voxel-panel .seg button{flex:1;border:0;background:transparent;color:#b9c3d6;padding:5px 6px;cursor:pointer;font:inherit;font-size:12px}
.voxel-panel .seg button.on{background:#f8a95c;color:#1a0d00;font-weight:700}
.voxel-panel .note{color:#8793aa;font-size:10.5px;margin-top:8px;line-height:1.5}
.voxel-panel .note a{color:#b9c3d6}
.voxel-panel details{margin-top:8px;border-top:1px solid rgba(255,255,255,.1);padding-top:6px}
.voxel-panel details summary{cursor:pointer;color:#e7ecf5;font-weight:600}
.voxel-panel table{border-collapse:collapse;font-size:11px;margin-top:4px;width:100%}
.voxel-panel td{padding:2px 4px;border-bottom:1px solid rgba(255,255,255,.07);vertical-align:top;color:#b9c3d6}
.voxel-panel td code{color:#febb81;font-size:10.5px}
.voxel-panel .err{color:#ff8a7a}
</style>
<div class="stat" data-k="status">${t("Loading…")}</div>
<div class="lvl" data-k="level"></div>`);
	const sceneLabel: Record<Scene, string> = { cloud: t("Cloud"), torus: t("Torus"), fuji: t("Mt. Fuji"), quakes: t("Earthquakes") };
	P.body.innerHTML = `
 <div class="row"><div class="btns" data-k="scenes">${SCENES.map(s => `<button type="button" class="b" data-scene="${s}">${sceneLabel[s]}</button>`).join("")}</div>
  <div class="note" data-k="sceneNote" style="margin-top:2px"></div></div>
 <div class="row"><div class="seg"><button type="button" data-render="volume">${t("Volume")}</button><button type="button" data-render="blocks">${t("Blocks")}</button><button type="button" data-render="iso">${t("Surface")}</button></div></div>
 <div class="row"><label>${t("Opacity")} <b data-k="opV"></b></label><input type="range" data-k="op" min="0.05" max="1" step="0.05"></div>
 <div class="row"><label>${t("Threshold")} <b data-k="thV"></b></label><input type="range" data-k="th" min="0" max="1" step="0.01"></div>
 <div class="row"><label>${t("Slice (bottom)")} <b data-k="z0V"></b></label><input type="range" data-k="z0" min="0" max="0.98" step="0.02" value="0"></div>
 <div class="row"><label>${t("Slice (top)")} <b data-k="z1V"></b></label><input type="range" data-k="z1" min="0.02" max="1" step="0.02" value="1"></div>
 <div class="row"><label>${t("Colormap")} <select data-k="cmap"><option value="">${t("Scene's own")}</option>${COLORMAP_NAMES.map(n => `<option value="${n}">${n}</option>`).join("")}</select></label></div>
 <div class="row"><label class="chk"><input type="checkbox" data-k="depth"> ${t("Hidden by buildings and terrain")}</label></div>
 <details><summary>${t("How this page is drawn")}</summary>
  <table>
   <tr><td><code>map.use(voxelPlugin())</code></td><td>${t("the renderer: WebGPU with the globe's device and depth, or WebGL2")}</td></tr>
   <tr><td><code>map.addData({ dims, box, values }, { kind: "voxel" })</code></td><td>${t("a box grid: origin, size and values")}</td></tr>
   <tr><td><code>map.addData({ dims, region, values }, { kind: "voxel" })</code></td><td>${t("a longitude × latitude × depth grid")}</td></tr>
   <tr><td><code>handle.setProps({ render, opacity, threshold, clip, colormap })</code></td><td>${t("the options above (no re-upload)")}</td></tr>
   <tr><td><code>map.sampleTerrain(points)</code></td><td>${t("the heights for the blocks")}</td></tr>
  </table>
 </details>
 <div class="note">${t("Source: $1", `<a href="${USGS_URL}" target="_blank" rel="noopener">USGS ComCat</a>`)}</div>`;
	const $ = (k: string) => panel.querySelector<HTMLInputElement>(`[data-k="${k}"]`)!;
	const status = (s: string) => { $("status").textContent = s; };
	const defs = sceneDefs(map, status);
	const cache = new Map<Scene, VoxelData>();
	let scene: Scene = scene0, handle: VoxelHandle | null = null, seq = 0;
	const cur = { render: "volume" as RenderMode, opacity: 1, threshold: 0, z0: 0, z1: 1, cmap: "" as string, depth: true };
	const api = { ready: false, n: 0, events: 0, scene, get backend() { return handle?.backend ?? null; }, get handle() { return handle; }, setScene: (s: Scene) => show(s, true) };
	const paint = () => {
		for (const b of panel.querySelectorAll<HTMLButtonElement>("[data-scene]")) b.classList.toggle("on", b.dataset.scene === scene);
		for (const b of panel.querySelectorAll<HTMLButtonElement>("[data-render]")) b.classList.toggle("on", b.dataset.render === cur.render);
		$("op").value = String(cur.opacity); $("opV").textContent = `${Math.round(cur.opacity * 100)}%`;
		$("th").value = String(cur.threshold); $("thV").textContent = `${Math.round(cur.threshold * 100)}%`;
		$("z0").value = String(cur.z0); $("z1").value = String(cur.z1); $("z0V").textContent = `${Math.round(cur.z0 * 100)}%`; $("z1V").textContent = `${Math.round(cur.z1 * 100)}%`;
		$("cmap").value = cur.cmap; $("depth").checked = cur.depth;
		$("sceneNote").textContent = defs[scene].note();
	};
	// 閾＝場面の range の割合（UI）→ データの単位（plugin）
	const thrData = (h: VoxelHandle | null, f: number): number => { const r = h?.range ?? [0, 1]; return r[0] + (r[1] - r[0]) * f; };
	const colormapOf = (): ColormapSpec => cur.cmap || defs[scene].opts.colormap || "viridis";
	const restyle = (): void => { if (!handle) return; handle.setProps({ render: cur.render, opacity: cur.opacity, threshold: thrData(handle, cur.threshold), clip: cur.z0 > 0 || cur.z1 < 1 ? [0, 1, 0, 1, cur.z0, cur.z1] : null, colormap: colormapOf(), depthTest: cur.depth }); };
	async function show(s: Scene, go: boolean): Promise<void> {
		const my = ++seq; scene = s; api.scene = s; api.ready = false;
		const d = defs[s], o = d.opts;
		cur.render = o.render ?? "volume"; cur.opacity = o.opacity ?? 1; cur.z0 = 0; cur.z1 = 1; cur.cmap = ""; cur.depth = o.depthTest !== false;
		paint(); status(t("Loading…")); $("level").textContent = "";
		if (go) void map.easeTo({ center: d.view.center, zoom: d.view.zoom, pitch: d.view.pitch, bearing: d.view.bearing, duration: 1500 });   // 補間（flyTo の離陸は秒単位）
		handle?.remove(); handle = null;
		let data = cache.get(s);
		try {
			if (!data) { data = await d.data(); cache.set(s, data); }
			if (my !== seq) return;
			const t0 = performance.now();
			const h = map.addData(data, { kind: "voxel", id: `voxel:${s}`, ...o, clip: null, properties: { scene: s } }) as unknown as VoxelHandle;
			handle = h;
			await h.ready;
			if (my !== seq) return;
			const r = h.range ?? [0, 1];
			cur.threshold = o.threshold != null ? Math.min(1, Math.max(0, (o.threshold - r[0]) / (r[1] - r[0]))) : 0;
			api.n = h.n; api.events = st.events; api.ready = true; paint();
			status(t("$1 × $2 × $3 cells · $4", h.dims![0], h.dims![1], h.dims![2], h.shape === "region" ? t("longitude × latitude × depth") : t("box")));
			const lvl = () => { $("level").textContent = h.backend ? t("Drawn with $1 · prepared in $2 ms", h.backend === "webgpu" ? "WebGPU" : "WebGL2", fmt(performance.now() - t0)) : ""; };
			lvl(); if (!h.backend) setTimeout(lvl, 1500);
		} catch (e) {
			console.error("[voxel]", s, e);
			$("status").innerHTML = `<span class="err">${t("Could not load $1", sceneLabel[s])}</span>`;
		}
	}
	for (const b of panel.querySelectorAll<HTMLButtonElement>("[data-scene]")) b.addEventListener("click", () => { if (b.dataset.scene !== scene) void show(b.dataset.scene as Scene, true); });
	for (const b of panel.querySelectorAll<HTMLButtonElement>("[data-render]")) b.addEventListener("click", () => { cur.render = b.dataset.render as RenderMode; paint(); restyle(); });
	$("op").addEventListener("input", () => { cur.opacity = +$("op").value; paint(); restyle(); });
	$("th").addEventListener("input", () => { cur.threshold = +$("th").value; paint(); restyle(); });
	$("z0").addEventListener("input", () => { cur.z0 = Math.min(+$("z0").value, cur.z1 - 0.02); paint(); restyle(); });
	$("z1").addEventListener("input", () => { cur.z1 = Math.max(+$("z1").value, cur.z0 + 0.02); paint(); restyle(); });
	$("cmap").addEventListener("change", () => { cur.cmap = $("cmap").value; restyle(); });
	$("depth").addEventListener("change", () => { cur.depth = $("depth").checked; restyle(); });
	await show(scene0, fly);
	return api;
}
