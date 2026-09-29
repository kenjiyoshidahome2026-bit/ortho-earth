// quantized-mesh の標高ソース（#110 段 3・2026-09-29）＝dem-src.js（raster-dem）と同じ 4 つの口（spec・covers・height・cell）＝terrain.js と render worker は手付かず。
//   spec＝{ type:"quantized-mesh", url:"…/layer.json" | ion:{ assetId, accessToken }, heights:"ellipsoidal"（既定＝仕様どおり）|"orthometric"（swisstopo のように標高で配る物）,
//           heightOffset:0（m・足す）, cellZoom?（R01 のセルを焼く段）, maxzoom?（1 点の標本の上限の段）, bounds?, dtm:false, headers?, credentials:"omit" }
//   ion＝利用者の Cesium ion の鍵（本人裁定＝同梱しない）：api.cesium.com の端点で一時の鍵と layer.json の場所を受け取る（CORS 可を段 0 で確認）。
//   楕円体高＝ジオイド高（EGM96 30 分・geoid.js）を引いて標高へ＝この地図の DEM と同じ基準（データの縁に段差を作らない）。
//   セル＝その段のタイル（EPSG:4326 の TMS）を取り、三角形を格子点へ焼く（qmesh.js qmBake）。タイルの無い所・空のタイル（高さ 0..0）は NaN＝既定の標高が残る。
import { parseLayerJson, qmAvailable, qmTileAt, qmTileBounds, qmTileSpan, decodeQuantizedMesh, qmGunzip, qmBake, qmSample } from "./qmesh.js";
import { loadGeoid, geoidHeight } from "./geoid.js";

const ACCEPT = "application/vnd.quantized-mesh,application/octet-stream;q=0.9,*/*;q=0.01";
const MAX_TILES = 400;          // 1 セルで取るタイルの上限（dem-src と同じ）
const CACHE_BYTES = 96 << 20;   // 解いたタイルの在庫（バイトで区切る＝1 枚が数 MB になる配信がある）

export function normalizeQmeshSpec(s) {
	if (!s?.url && !s?.ion?.assetId) throw new Error("quantized-mesh: spec needs url (layer.json) or ion { assetId, accessToken }");
	return { type: "quantized-mesh", url: s.url || null, ion: s.ion ? { assetId: s.ion.assetId, accessToken: s.ion.accessToken || "" } : null,
		heights: s.heights === "orthometric" ? "orthometric" : "ellipsoidal", heightOffset: +s.heightOffset || 0, cellZoom: s.cellZoom ?? null, maxzoom: s.maxzoom ?? null,
		bounds: Array.isArray(s.bounds) && s.bounds.length === 4 ? s.bounds.slice() : null, dtm: !!s.dtm, headers: s.headers || null, credentials: s.credentials || "omit" };
}

export function createQmeshSource(spec0) {
	const spec = normalizeQmeshSpec(spec0);
	const hdr = { Accept: ACCEPT, ...(spec.headers || {}) };
	// layer.json（ion は端点から）＝一度だけ・失敗は null（呼び手は既定の標高のまま）
	const layerP = (async () => {
		let url = spec.url;
		if (spec.ion) {
			const e = await (await fetch(`https://api.cesium.com/v1/assets/${encodeURIComponent(spec.ion.assetId)}/endpoint?access_token=${encodeURIComponent(spec.ion.accessToken)}`)).json();
			if (!e?.url) throw new Error("quantized-mesh: ion endpoint returned no url" + (e?.message ? ` (${e.message})` : ""));
			const u = new URL("layer.json", e.url.endsWith("/") ? e.url : e.url + "/");
			if (e.accessToken) u.searchParams.set("access_token", e.accessToken);
			url = u.toString();
		}
		const r = await fetch(url, { credentials: spec.credentials, headers: spec.headers || undefined });
		if (!r.ok) throw new Error(`quantized-mesh: layer.json ${r.status}`);
		const L = parseLayerJson(await r.json(), url);
		if (spec.heights === "ellipsoidal") await loadGeoid();   // 楕円体高＝ジオイドの格子を読む（一度だけ）
		return L;
	})().catch(err => { console.warn("[qmesh]", err?.message || err); return null; });
	const tiles = new Map(); let bytes = 0;   // "z/x/y" → Promise<mesh|null>（LRU・バイトで区切る）
	const meshBytes = m => m ? m.n * 20 + m.tri.length * 4 : 0;
	async function tile(L, z, x, y) {
		const k = `${z}/${x}/${y}`;
		if (tiles.has(k)) { const p = tiles.get(k); tiles.delete(k); tiles.set(k, p); return p; }
		if (!qmAvailable(L, z, x, y)) return null;
		const p = (async () => {
			const u = L.tiles[(x + y) % L.tiles.length].replace("{z}", z).replace("{x}", x).replace("{y}", y).replace("{version}", L.version);
			const r = await fetch(u, { credentials: spec.credentials, headers: hdr });
			if (!r.ok) return null;   // 404／403＝そこに無い（範囲外）
			const m = decodeQuantizedMesh(await qmGunzip(await r.arrayBuffer()));
			if (m.empty) return null;   // 高さ 0..0 の置き物（PDOK の粗い段）＝無いものとして既定の標高へ譲る
			bytes += meshBytes(m);
			return m;
		})().catch(() => null);
		tiles.set(k, p);
		while (bytes > CACHE_BYTES && tiles.size > 1) { const [k0, p0] = tiles.entries().next().value; tiles.delete(k0); p0.then(m => { bytes -= meshBytes(m); }); }
		return p;
	}
	// 楕円体高 → 標高・利用者の足し算
	const fix = (h, lon, lat) => h === h ? h - (spec.heights === "ellipsoidal" ? geoidHeight(lon, lat) : 0) + spec.heightOffset : NaN;
	const bnd = L => spec.bounds || L?.bounds || null;
	const inB = (b, w, s, e, n) => !b || !(e < b[0] || w > b[2] || n < b[1] || s > b[3]);
	return {
		spec, ready: layerP,
		covers: (lng0, lat0, range = 1) => inB(spec.bounds, lng0, lat0, lng0 + range, lat0 + range),
		// 1 点＝最大の段から（無ければ粗い段へ 6 段まで）
		async height(lon, lat) {
			const L = await layerP; if (!L || !inB(bnd(L), lon, lat, lon, lat)) return NaN;
			const zMax = Math.min(L.maxzoom, spec.maxzoom ?? 16);
			for (let z = zMax; z >= Math.max(L.minzoom, zMax - 6); z--) {
				const [x, y] = qmTileAt(z, lon, lat), m = await tile(L, z, x, y);
				if (m) { const h = qmSample(m, qmTileBounds(z, x, y), lon, lat); if (h === h) return fix(h, lon, lat); }
			}
			return NaN;
		},
		// セル（R01＝1°・R10＝10°）＝N×N の格子点（row0＝北）。段＝タイルの幅がセルの約 1/4（R01＝z10・R10＝z7）・cellZoom で固定可
		async cell(lng0, lat0, range = 1, N = 1025) {
			const L = await layerP; if (!L) return null;
			const b = bnd(L); if (!inB(b, lng0, lat0, lng0 + range, lat0 + range)) return null;
			const z = Math.max(L.minzoom, Math.min(L.maxzoom, range === 1 && spec.cellZoom != null ? spec.cellZoom : Math.round(Math.log2(180 / (range / 4)))));
			const w = Math.max(lng0, b ? b[0] : -180), e = Math.min(lng0 + range, b ? b[2] : 180), s = Math.max(lat0, b ? b[1] : -90), n = Math.min(lat0 + range, b ? b[3] : 90);
			const [x0, y0] = qmTileAt(z, w, s), [x1, y1] = qmTileAt(z, e - 1e-9, n - 1e-9);
			const need = []; for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) need.push([x, y]);
			if (need.length > MAX_TILES) return null;
			const grid = { data: new Float32Array(N * N).fill(NaN), N, lng: lng0, lat: lat0, range };
			let i = 0, got = 0;
			await Promise.all(Array.from({ length: 6 }, async () => { while (i < need.length) { const [x, y] = need[i++]; const m = await tile(L, z, x, y); if (m) { qmBake(m, qmTileBounds(z, x, y), grid); got++; } } }));
			if (!got) return null;
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
