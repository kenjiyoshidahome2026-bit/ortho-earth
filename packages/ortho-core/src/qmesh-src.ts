// quantized-mesh の標高ソース（#110 段 3・2026-09-29）＝dem-src.js（raster-dem）と同じ 4 つの口（spec・covers・height・cell）＝terrain.js と render worker は手付かず。
//   spec＝{ type:"quantized-mesh", url:"…/layer.json" | ion:{ assetId, accessToken }, heights:"ellipsoidal"（既定＝仕様どおり）|"orthometric"（swisstopo のように標高で配る物）,
//           heightOffset:0（m・足す）, cellZoom?（R01 のセルを焼く段）, maxzoom?（1 点の標本の上限の段）, bounds?, dtm:false, headers?, credentials:"omit" }
//   ion＝利用者の Cesium ion の鍵（本人裁定＝同梱しない）：api.cesium.com の端点で一時の鍵と layer.json の場所を受け取る（CORS 可を段 0 で確認）。
//   楕円体高＝ジオイド高（EGM96 30 分・geoid.js）を引いて標高へ＝この地図の DEM と同じ基準（データの縁に段差を作らない）。
//   セル＝その段のタイル（EPSG:4326 の TMS）を取り、三角形を格子点へ焼く（qmesh.js qmBake）。タイルの無い所・空のタイル（高さ 0..0）は NaN＝既定の標高が残る。
import { parseLayerJson, qmAvailable, qmTileAt, qmTileBounds, qmTileSpan, decodeQuantizedMesh, qmGunzip, qmBake, qmSample } from "./qmesh.ts";
import { loadGeoid, geoidHeight } from "./geoid.ts";
import type { QMesh, QMLayer, QMGrid } from "./qmesh.ts";
import type { DemCell, DemSource } from "./dem-src.ts";

/** 利用者が書く spec（quantized-mesh） */
export interface QmeshSpecInput { type?: "quantized-mesh"; url?: string | null; ion?: { assetId: string | number; accessToken?: string } | null; heights?: "ellipsoidal" | "orthometric"; heightOffset?: number; cellZoom?: number | null; maxzoom?: number | null; bounds?: number[] | null; dtm?: boolean; headers?: Record<string, string> | null; credentials?: RequestCredentials; [k: string]: unknown }
/** 整えた spec */
export interface QmeshSpec { type: "quantized-mesh"; url: string | null; ion: { assetId: string | number; accessToken: string } | null; heights: "ellipsoidal" | "orthometric"; heightOffset: number; cellZoom: number | null; seafloor: boolean; maxzoom: number | null; bounds: number[] | null; dtm: boolean; headers: Record<string, string> | null; credentials: RequestCredentials }
export interface QmeshSource extends DemSource { spec: QmeshSpec; ready: Promise<QMLayer | null>; tileSpan: (z: number) => number }
interface IonEndpoint { url?: string; accessToken?: string; message?: string }

const ACCEPT = "application/vnd.quantized-mesh,application/octet-stream;q=0.9,*/*;q=0.01";
const MAX_TILES = 400;          // 1 セルで取るタイルの上限（dem-src と同じ）
const CACHE_BYTES = 96 << 20;   // 解いたタイルの在庫（バイトで区切る＝1 枚が数 MB になる配信がある）

function normalizeQmeshSpec(s: QmeshSpecInput | null | undefined): QmeshSpec {
	if (!s?.url && !s?.ion?.assetId) throw new Error("quantized-mesh: spec needs url (layer.json) or ion { assetId, accessToken }");
	return { type: "quantized-mesh", url: s.url || null, ion: s.ion ? { assetId: s.ion.assetId, accessToken: s.ion.accessToken || "" } : null,
		heights: s.heights === "orthometric" ? "orthometric" : "ellipsoidal", heightOffset: +(s.heightOffset ?? 0) || 0, cellZoom: s.cellZoom ?? null, seafloor: !!s.seafloor, maxzoom: s.maxzoom ?? null,
		bounds: Array.isArray(s.bounds) && s.bounds.length === 4 ? s.bounds.slice() : null, dtm: !!s.dtm, headers: s.headers || null, credentials: s.credentials || "omit" };
}

export function createQmeshSource(spec0: QmeshSpecInput): QmeshSource {
	const spec = normalizeQmeshSpec(spec0);
	const hdr = { Accept: ACCEPT, ...(spec.headers || {}) };
	// layer.json（ion は端点から）＝一度だけ・失敗は null（呼び手は既定の標高のまま）
	const layerP = (async (): Promise<QMLayer> => {
		let url = spec.url;
		if (spec.ion) {
			const e = await (await fetch(`https://api.cesium.com/v1/assets/${encodeURIComponent(spec.ion.assetId)}/endpoint?access_token=${encodeURIComponent(spec.ion.accessToken)}`)).json() as IonEndpoint | null;
			if (!e?.url) throw new Error("quantized-mesh: ion endpoint returned no url" + (e?.message ? ` (${e.message})` : ""));
			const u = new URL("layer.json", e.url.endsWith("/") ? e.url : e.url + "/");
			if (e.accessToken) u.searchParams.set("access_token", e.accessToken);
			url = u.toString();
		}
		const r = await fetch(url!, { credentials: spec.credentials, headers: spec.headers || undefined });
		if (!r.ok) throw new Error(`quantized-mesh: layer.json ${r.status}`);
		const L = parseLayerJson(await r.json(), url!);
		if (spec.heights === "ellipsoidal") await loadGeoid();   // 楕円体高＝ジオイドの格子を読む（一度だけ）
		return L;
	})().catch((err: unknown) => { console.warn("[qmesh]", (err as Error)?.message || err); return null; });
	const tiles = new Map<string, Promise<QMesh | null>>(); let bytes = 0;   // "z/x/y" → Promise<mesh|null>（LRU・バイトで区切る）
	const meshBytes = (m: QMesh | null): number => m ? m.n * 20 + m.tri.length * 4 : 0;
	async function tile(L: QMLayer, z: number, x: number, y: number): Promise<QMesh | null> {
		const k = `${z}/${x}/${y}`;
		if (tiles.has(k)) { const p = tiles.get(k)!; tiles.delete(k); tiles.set(k, p); return p; }
		if (!qmAvailable(L, z, x, y)) return null;
		const p = (async (): Promise<QMesh | null> => {
			const u = L.tiles[(x + y) % L.tiles.length].replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y)).replace("{version}", L.version);
			const r = await fetch(u, { credentials: spec.credentials, headers: hdr });
			if (!r.ok) return null;   // 404／403＝そこに無い（範囲外）
			const m = decodeQuantizedMesh(await qmGunzip(await r.arrayBuffer()));
			if (m.empty) return null;   // 高さ 0..0 の置き物（PDOK の粗い段）＝無いものとして既定の標高へ譲る
			bytes += meshBytes(m);
			return m;
		})().catch(() => null);
		tiles.set(k, p);
		while (bytes > CACHE_BYTES && tiles.size > 1) { const [k0, p0] = tiles.entries().next().value!; tiles.delete(k0); p0.then(m => { bytes -= meshBytes(m); }); }
		return p;
	}
	// 楕円体高 → 標高・利用者の足し算
	const fix = (h: number, lon: number, lat: number): number => h === h ? h - (spec.heights === "ellipsoidal" ? geoidHeight(lon, lat) : 0) + spec.heightOffset : NaN;
	const bnd = (L: QMLayer | null): number[] | null => spec.bounds || L?.bounds || null;
	const inB = (b: number[] | null, w: number, s: number, e: number, n: number): boolean => !b || !(e < b[0] || w > b[2] || n < b[1] || s > b[3]);
	return {
		spec, ready: layerP,
		covers: (lng0: number, lat0: number, range = 1): boolean => inB(spec.bounds, lng0, lat0, lng0 + range, lat0 + range),
		// 1 点＝最大の段から（無ければ粗い段へ 6 段まで・海底は z0 まで）
		async height(lon: number, lat: number): Promise<number> {
			const L = await layerP; if (!L || !inB(bnd(L), lon, lat, lon, lat)) return NaN;
			const zMax = Math.min(L.maxzoom, spec.maxzoom ?? 16);
			for (let z = zMax; z >= Math.max(L.minzoom, spec.seafloor ? 0 : zMax - 6); z--) {   // 海底＝深い段の無い所が広い（z16 の 404 から z0 まで下りる）
				const [x, y] = qmTileAt(z, lon, lat), m = await tile(L, z, x, y);
				if (m) { const h = qmSample(m, qmTileBounds(z, x, y), lon, lat); if (h === h) return fix(h, lon, lat); }
			}
			return NaN;
		},
		// セル（R01＝1°・R10＝10°）＝N×N の格子点（row0＝北）。段＝タイルの幅がセルの約 1/4（R01＝z10・R10＝z6）・cellZoom で固定可。
		//   海底（seafloor）の R10＝約 1/16（z8）：海の配信は浅い段で三角形がとても粗い（World Bathymetry の z6＝数百 km の面）＝Cesium が見せる段まで下りる
		//   海底は、タイルの無い所（404・layer.json の在庫外）を親の段（4 段まで）で埋める＝在庫を metadata で配る配信（ion）は深い段の有無を先に知れない。
//   陸（CWT など）の R01・R10 は埋めない＝NaN のまま既定の標高（R01・R10）が入る（親の粗い三角形はヒマラヤで角ばった面になる）。
//   近景層の窓（range < 1）は埋める＝CWT はフランスなどで z14 止まり、z15 の窓が丸ごと空で近景層が焼けず目の足元の地面が落ちた（2026-10-29）
		async cell(lng0: number, lat0: number, range = 1, N = 1025): Promise<DemCell | null> {
			const L = await layerP; if (!L) return null;
			const b = bnd(L); if (!inB(b, lng0, lat0, lng0 + range, lat0 + range)) return null;
			const div = spec.seafloor && range !== 1 ? 16 : 4;
			const z = Math.max(L.minzoom, Math.min(L.maxzoom, range === 1 && spec.cellZoom != null ? spec.cellZoom : Math.round(Math.log2(180 / (range / div)))));
			const w = Math.max(lng0, b ? b[0] : -180), e = Math.min(lng0 + range, b ? b[2] : 180), s = Math.max(lat0, b ? b[1] : -90), n = Math.min(lat0 + range, b ? b[3] : 90);
			const [x0, y0] = qmTileAt(z, w, s), [x1, y1] = qmTileAt(z, e - 1e-9, n - 1e-9);
			const need: [number, number][] = []; for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) need.push([x, y]);
			if (need.length > MAX_TILES) return null;
			const grid: QMGrid = { data: new Float32Array(N * N).fill(NaN), N, lng: lng0, lat: lat0, range };
			const found: [QMesh, number, number, number][] = [], miss: [number, number][] = [];
			let i = 0;
			await Promise.all(Array.from({ length: 6 }, async () => { while (i < need.length) { const [x, y] = need[i++]; const m = await tile(L, z, x, y); if (m) found.push([m, z, x, y]); else miss.push([x, y]); } }));
			// 無いタイルは親の段で（海底だけ・粗い段を先に焼き、細かい段で上書き）
			const par = new Map<string, Promise<[QMesh, number, number, number] | null>>();
			const up = (x: number, y: number): Promise<[QMesh, number, number, number] | null> => (async () => {
				for (let pz = z - 1, px = x >> 1, py = y >> 1; pz >= Math.max(L.minzoom, z - 4); pz--, px >>= 1, py >>= 1) {
					const k = pz + "/" + px + "/" + py; if (!par.has(k)) par.set(k, tile(L, pz, px, py).then(m => m ? [m, pz, px, py] as [QMesh, number, number, number] : null));
					const r = await par.get(k)!; if (r) return r;
				}
				return null;
			})();
			const fills = new Set((await Promise.all((spec.seafloor || range < 1 ? miss : []).map(([x, y]) => up(x, y)))).filter(r => r) as [QMesh, number, number, number][]);
			const bake = [...fills].sort((a, b2) => a[1] - b2[1]).concat(found.sort((a, b2) => (a[2] - b2[2]) || (a[3] - b2[3])));
			if (!bake.length) return null;
			for (const [m, tz, x, y] of bake) qmBake(m, qmTileBounds(tz, x, y), grid);
			// ジオイド高は 33×33 の粗い格子で引いて双一次（元の格子は 30 分＝1° のセルで 2×2 の升＝粗く引いても形は保つ・1025² を 1 点ずつ引くと約 12ms）
			const G = 33, ng = new Float32Array(G * G), ell = spec.heights === "ellipsoidal", sc = (G - 1) / (N - 1);
			if (ell) for (let r = 0; r < G; r++) for (let c = 0; c < G; c++) ng[r * G + c] = geoidHeight(lng0 + c / (G - 1) * range, lat0 + range - r / (G - 1) * range);
			let valid = 0;
			for (let r = 0; r < N; r++) {
				const gr = r * sc, r0 = Math.min(G - 2, gr | 0), fr = gr - r0;
				for (let c = 0; c < N; c++) {
					const k = r * N + c, v = grid.data[k]; if (v !== v) continue;
					let n0 = 0;
					if (ell) { const gc = c * sc, c0 = Math.min(G - 2, gc | 0), fc = gc - c0, j = r0 * G + c0; n0 = (ng[j] * (1 - fc) + ng[j + 1] * fc) * (1 - fr) + (ng[j + G] * (1 - fc) + ng[j + G + 1] * fc) * fr; }
					grid.data[k] = v - n0 + spec.heightOffset; valid++;
				}
			}
			return valid ? { data: grid.data, width: N, height: N, lng: lng0, lat: lat0, range, source: "qmesh", valid: valid / (N * N) } : null;
		},
		tileSpan: qmTileSpan,
	};
}
