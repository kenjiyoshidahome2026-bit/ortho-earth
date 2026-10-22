// 描画結果への問い合わせ（map.queryRenderedFeatures）と層ごとのイベント（map.on/off/once の層 id 付き）＝createGlobe から切り出した（globe.js の分割 ②・2026-10-15）。
// 中身は切り出す前と同じ。createGlobe の他の所が使う物（押し出し・模型・3D Tiles の当たりの環境・vector source の問い合わせの控え）は戻り値で返す。
//   live＝createGlobe が後から差し替える変数（let）を読む口（getter）。その他＝createGlobe の中の定数・関数（中身は createGlobe と共有）
import { ML_CEZ_KEY, WORLD_PX, cameraState, ellNormal3D, evalExpr, lonlatTo3D, normalizeMLLayer, queryTiles, truthy, unproject } from "@ortho-earth/core";
import { hitExtrusion } from "../extrude-ml.ts";
import type { MLLayer } from "@ortho-earth/core";
import type { LayerMouseEvent, LayerPressEvent, LonLat, QueryOptions, RenderedFeature, StyleExpression } from "../../globe.d.ts";
import type { ExtEnv, ExtViewNow, Installing, MeshPickEnv, QueryDeps, QueryLive, QueryReturn } from "../types/install.ts";
import type { GlobeMap, QueryApi } from "../types/map.ts";
import type { MeshHit, ModelCtl, QueryGeometry } from "../types/scope.ts";

// 集約の丸の当たり＝ばらける段（エンジンの z・顔が公開の目盛りへ直す）を地物に添える（cluster as data の隠しの属性から）
const ezOf = (p: Record<string, unknown> | null | undefined) => p?.[ML_CEZ_KEY] != null ? { expansionZoom: p[ML_CEZ_KEY] as number } : {};

/** 問い合わせの形＝点 [x, y]（CSS px）か箱 [[x0, y0], [x1, y1]]。中では typeof g[0] で読み分ける（TS は組の要素の typeof で組の型を絞れない＝
 *  両方の読み方を許す形で持つ・公開の口から入る所で付け替える） */
type QGeom = [number, number] & [[number, number], [number, number]];
/** 式の評価の文脈（core の evalExpr） */
type ExprCtx = Parameters<typeof evalExpr>[1];
/** 押し出しの 1 棟（model.js の extrudeSets の used の要素） */
type ExtUsed = NonNullable<ModelCtl["extrudeSets"]>[number]["used"][number];
/** 押し出しの 1 棟の幾何の控え（外接球の材料） */
interface ExtGeom { polys: number[][][][]; clon: number; clat: number; cu: ArrayLike<number>; cm: ArrayLike<number> | null; chord: number }
/** 問い合わせの答えの 1 件（state＝feature-state・height＝押し出しの高さ・propertyTable＝模型の表・tile＝vector の写しの鍵） */
type HitFeature = RenderedFeature & { state?: Record<string, unknown>; height?: number; propertyTable?: unknown; tile?: string };
/** 立体の当たりの 1 件（d＝奥行き） */
type DepthHit = { d: number; f: HitFeature };
/** 層ごとのイベントの購読（key＝on に渡した層 id の形＝off で当てる） */
interface LayerEv { ev: string; ids: Set<string>; cb: (e: LayerMouseEvent) => void; inside: boolean; key: string | string[] }
/** map.on／off を重ね書きを通さずに呼ぶ形（名前と関数・名前と層 id と関数） */
type OnOff = (ev: string, a: unknown, b?: (e: never) => void) => GlobeMap;

export function installQuery(map: Installing<QueryApi>, live: QueryLive, {
	BASE_SOURCE, D2R, EARTH_M, ELL_ON, IMAGE_KEY, PUBLIC_DZ, R2D, REGION_DTM, TERR_EXAG, ac, baseSidNow, cam, canvas, clipAllCut, clipCutXY, clipFor,
	drawLayerOf, evXY, gint, hiddenAll, inZoomML, input, isOv, mlIdOf, mlLayers, mlPasses, mlVisible, noMixedR01, overlayFeature, patItems, requester,
	size, srcId, stripMl, unprojectXY, vtdDesc, vtdOrder, vtxGround, vtxStateOf
}: QueryDeps): QueryReturn {
	// ── 描画結果への問い合わせ（MapLibre の queryRenderedFeatures 相当・2026-09-21）──────────────────────────
	// geometry＝省略（画面全体）｜[x,y]（CSS px）｜[[x0,y0],[x1,y1]]（箱）。opts＝{ layers:[id…], filter: 式, tolerance: px（既定 0＝MapLibre と同じ＝線は線幅の半分・円は半径＋縁・面は内側。拡張＝足す px） }。
	// 返り値＝Promise<Feature[]>（上に描かれたものから）。基図は ortho-core の queryTiles（描いているタイルを取り直して今のスタイルで当てる）。
	// その上に載せたもの＝集約（"clusters"/"unclustered-point"・点の問い合わせだけ）・画像（id "img:<n>"・raster）・押し出し（"extrude"・fill-extrusion）・利用者の図形（"user"・gint の識別＝許容は m 換算）。
	// MapLibre と違う点＝非同期（タイルを取り直すため）。基図の層 id はスタイルの id（地域パックの style）。
	// 基図の解読の控え＝読む source-layer の組と置き場ごと（#174 段 5・旧＝"z/x/y" だけが鍵＝style を替えて読む層が増えても、別の置き場へ替えても古い解読を返した）。
	// 鍵が変われば前の控えは捨てる（組は 1 つずつしか使わない）。中身は "z/x/y" → 解読済みタイル（直近 32 枚）
	const queryCache: QueryReturn["vtdQueryCache"] = new Map();
	const baseQueryCache = () => {
		const k = baseSidNow() + "|" + (BASE_SOURCE.url ?? BASE_SOURCE.kind) + "|" + [...new Set((live.style.layers || []).map(L => L["source-layer"]).filter(Boolean))].sort().join(",");
		let c = queryCache.get(k); if (!c) { queryCache.clear(); queryCache.set(k, c = new Map()); }
		if (c.size > 32) c.clear();
		return c;
	};
	const vtdQueryCache: QueryReturn["vtdQueryCache"] = new Map();   // "sid|source-layer の組" → Map<"z/x/y", 解読済みタイル>（vector source の描く層・段 8⑤）
	// 押し出しの当たり＝立体（MapLibre の fill-extrusion と同じく屋根と壁・台帳 R23・幾何は extrude-ml.js の hitExtrusion＝vector の押し出しと共用）。点が空（球の外）でも高い屋根には当たる。
	// 地面＝描いている地面と同じ所で当てる（model.js の mode）：plane＝床の平面（地形へ持ち上げない）・drape＝どこでも地表の標高へ・
	// ground（建物らしい面）＝renderer の接地リフトが効く所だけ（u_liftBounds の規則の写し＝ortho-core terrain.js：申告された DTM の域 ∩ R01 の窓。
	// R01＝z≥13（急チルト pitch>0.9 は z≥14）・混成窓＝急チルト×z11.5〜14 のカメラの 1° セル ±1）。標高は負を 0 に切る（海は海面＝renderer と同じ）×傾きのフェード。
	// 下ごしらえ＝地物ごとの外接球（中心＋半径）を画面へ投影して点/箱から遠い物を捨てる（数万棟でも毎回全頂点を投影しない）。近い順に並べるのは問い合わせ（vector の押し出しと一つの列＝MapLibre の 3D の並べ方）
	const extGeomOf = new WeakMap<ExtUsed, ExtGeom>();   // used の要素 → { polys, clon, clat, cu, cm, chord }（地物の幾何は変わらない＝一度だけ）
	const extGeom = (u: ExtUsed) => {
		let s = extGeomOf.get(u); if (s) return s;
		const g = u.f?.geometry, polys = (g?.type === "Polygon" ? [g.coordinates] : g?.type === "MultiPolygon" ? g.coordinates : []).filter(p => p?.[0]?.length >= 3);
		let w = Infinity, so = Infinity, e = -Infinity, no = -Infinity;
		for (const p of polys) for (const [lon, lat] of p[0]) { if (lon < w) w = lon; if (lon > e) e = lon; if (lat < so) so = lat; if (lat > no) no = lat; }
		const clon = (w + e) / 2, clat = (so + no) / 2, cu = polys.length ? lonlatTo3D(clon, clat) : [0, 0, 0];
		let chord = 0;
		for (const p of polys) for (const [lon, lat] of p[0]) { const v = lonlatTo3D(lon, lat); chord = Math.max(chord, Math.hypot(v[0] - cu[0], v[1] - cu[1], v[2] - cu[2])); }
		s = { polys, clon, clat, cu, cm: ELL_ON ? ellNormal3D(clon, clat) : null, chord };
		extGeomOf.set(u, s);
		return s;
	};
	// 今の視点の当たりの口（extrude-ml.js の env）＝geojson の押し出し（下の extrudeHits）と vector の押し出し（vtextrude の query）で共用。
	// envOf(gnd)＝地面の半径 gnd(lon, lat)（1＋持ち上げ）の上で { vtx, roof }。奥行き＝clip の w（二つの押し出しを同じ物差しで近い順に並べる）
	const extView = (): ExtViewNow => {
		const st = cameraState(cam, size.w, size.h), M = st.mvp, E = st.eye, eyeR = Math.hypot(E[0], E[1], E[2]);
		const W = size.w / live.dpr, H = size.h / live.dpr, k = TERR_EXAG / EARTH_M;
		const pos = (u: ArrayLike<number>, m: ArrayLike<number> | null, R: number): ArrayLike<number> => R === 1 ? u : m ? [u[0] + (R - 1) * m[0], u[1] + (R - 1) * m[1], u[2] + (R - 1) * m[2]] : [u[0] * R, u[1] * R, u[2] * R];   // core camera.js の liftedPos と同じ（楕円体は測地法線）
		const clipOf = (p: ArrayLike<number>): [number, number, number] => [M[0] * p[0] + M[4] * p[1] + M[8] * p[2] + M[12], M[1] * p[0] + M[5] * p[1] + M[9] * p[2] + M[13], M[3] * p[0] + M[7] * p[1] + M[11] * p[2] + M[15]];
		const screenAt = (lon: number, lat: number, R: number): [number, number, number] | null => {   // → [x, y, w]（CSS px・w＝奥行き）｜null（目の後ろ・球の陰）
			const p = pos(lonlatTo3D(lon, lat), ELL_ON ? ellNormal3D(lon, lat) : null, R), [cxp, cyp, w] = clipOf(p);
			if (!(w > 1e-9)) return null;
			const d0 = p[0] - E[0], d1 = p[1] - E[1], d2 = p[2] - E[2], t = -(E[0] * d0 + E[1] * d1 + E[2] * d2) / (d0 * d0 + d1 * d1 + d2 * d2);
			if (t > 0 && t < 1 && (E[0] + t * d0) ** 2 + (E[1] + t * d1) ** 2 + (E[2] + t * d2) ** 2 < 1 - 1e-9) return null;   // 目→点が海面の球をくぐる＝裏
			return [(cxp / w * 0.5 + 0.5) * W, (1 - (cyp / w * 0.5 + 0.5)) * H, w];
		};
		const envOf = (gnd: (lon: number, lat: number) => number): ExtEnv => ({
			vtx: (lon, lat, hM) => screenAt(lon, lat, gnd(lon, lat) + hM * k),
			roof: (x, y, hM, lon0, lat0) => {   // 光線を屋根の高さの球で受ける（起伏＝当たった所の地面で 1 回受け直す）。目が屋根より低い＝屋根は見えない
				let R = gnd(lon0, lat0) + hM * k;
				for (let it = 0; it < 2; it++) {
					if (eyeR <= R) return null;
					const ll = unproject(st, x * live.dpr, y * live.dpr, R); if (!ll) return null;
					const R2 = gnd(ll[0], ll[1]) + hM * k;
					if (it === 0 && Math.abs(R2 - R) > 1e-12) { R = R2; continue; }
					const v = screenAt(ll[0], ll[1], R);
					return v && Math.abs(v[0] - x) < 1 && Math.abs(v[1] - y) < 1 ? { ll, w: v[2] } : null;   // 光線の上の点か（近平面が球を割った時の起点を弾く）
				}
				return null;
			},
		});
		return { st, W, H, k, f: st.focal / live.dpr, pos, clipOf, envOf };
	};
	// 今の視点で、メッシュが描かれる地面の半径（単位球＝1）＝renderer の接地リフトと同じ域の判定（押し出しの当たり・模型の当たり W7 が共用）。
	// mode＝"plane"（持ち上げない）｜"drape"（全域で地形へ）｜その他（DTM 保証域の中だけ）
	const groundNow = () => {
		const pt0 = Math.max(0, Math.min(1, ((cam.pitch || 0) - 0.06) / 0.14)), pf = live.noTerr ? 0 : pt0 * pt0 * (3 - 2 * pt0);   // 地形のフェード（dispRadius・vtxGround と同じ）
		const dtm = REGION_DTM?.bbox || (live.demSpec?.dtm ? live.demSpec.bounds : null), z = cam.zoom, pitch = cam.pitch || 0;
		const mixed = !noMixedR01 && pitch > 0.9 && z >= 11.5 && z < 14, r01 = z >= 13 && !(pitch > 0.9 && z < 14);
		const cx = Math.floor(cam.center[0]), cy = Math.floor(cam.center[1]);
		const liftHere = (lon: number, lat: number) => !!dtm && lon >= dtm[0] && lon <= dtm[2] && lat >= dtm[1] && lat <= dtm[3] && (mixed ? lon >= cx - 1 && lon < cx + 2 && lat >= cy - 1 && lat < cy + 2 : r01);
		const groundOf = (mode: string | undefined): ((lon: number, lat: number) => number) => mode === "plane" || pf === 0 ? () => 1 : mode === "drape" ? vtxGround : (lon, lat) => liftHere(lon, lat) ? vtxGround(lon, lat) : 1;
		return { pf, groundOf };
	};
	// 模型・3D Tiles の当たり（W7）の環境＝{ view: { mvp, W, H, eye }（CSS px）, show3d, lift(origin, mode) → 持ち上げ（世界単位・束の中心で 1 回） }
	const meshPickEnv = (): MeshPickEnv => {
		const st = cameraState(cam, size.w, size.h), { groundOf } = groundNow();
		return { view: { mvp: st.mvp, W: size.w / live.dpr, H: size.h / live.dpr, eye: st.eye }, show3d: (cam.pitch || 0) >= 0.02,   // show3d＝renderer と同じ（真俯瞰は keep2d の束しか描かない＝模型は当てない）
			lift: (o, mode) => { const l = Math.hypot(o[0], o[1], o[2]) || 1, lon = Math.atan2(o[2], o[0]) * 180 / Math.PI, lat = Math.asin(o[1] / l) * 180 / Math.PI; return groundOf(mode)(lon, lat) - 1; } };
	};
	// 問い合わせの形 → extrude-ml.js の q（点＝{ pt }・箱＝{ box: [x0,y0,x1,y1] } に正規化）
	const extQ = (g: QGeom) => typeof g[0] === "number" ? { pt: g } : { box: [Math.min(g[0][0], g[1][0]), Math.min(g[0][1], g[1][1]), Math.max(g[0][0], g[1][0]), Math.max(g[0][1], g[1][1])] };
	// 模型・3D Tiles の当たり（W7）＝点の問い合わせだけ（箱は当てない）。層 id＝模型 "model"・tileset はその id（type "model"／"3d-tiles"）
	const meshHits = (geometry: QGeom | undefined, take: (id: string) => boolean) => {
		if (!Array.isArray(geometry) || typeof geometry[0] !== "number") return [];
		const [x, y] = geometry, out: DepthHit[] = [];
		const feat = (h: MeshHit, lid: string, type: string): DepthHit => ({ d: h.distance, f: { type: "Feature", ...(h.featureId != null ? { id: h.featureId } : {}), properties: h.properties || {}, geometry: { type: "Point", coordinates: h.lngLat }, layer: { id: lid, type }, source: lid, state: h.state || {}, ...(h.table ? { propertyTable: h.table } : {}) } });
		if (live.modelCtl?.name && take("model")) { const h = live.modelCtl.pick(x, y); if (h) out.push(feat(h, "model", "model")); }
		if (live.t3dCtl) for (const h of live.t3dCtl.pickAll(x, y)) if (take(h.id)) out.push(feat(h, h.id, "3d-tiles"));
		return out;
	};
	const extrudeHits = (geometry: QGeom, take: (id: string) => boolean) => {   // → [{ d: 奥行き, f: 地物 }]（並べるのは問い合わせ＝vector の押し出しと一緒に）
		const sets = live.modelCtl?.extrudeSets;
		if (!sets?.length || !sets.some(s => take(s.slot === "default" ? "extrude" : s.slot))) return [];
		const { W, H, k, f, pos, clipOf, envOf } = extView();
		const { pf, groundOf } = groundNow();
		const q = extQ(geometry), box = q.box;
		const hits: DepthHit[] = [];
		for (const { slot, used, mode, lift } of [...sets].reverse()) {   // 新しいスロットから（奥行きが同じ時の順＝従来どおり）
			const lid = slot === "default" ? "extrude" : slot;
			if (!take(lid)) continue;
			const gnd = groundOf(mode), env = envOf(gnd);
			for (let i = used.length - 1; i >= 0; i--) {
				const u = used[i], g = extGeom(u);
				if (!g.polys.length) continue;
				if (clipFor("models") && clipAllCut(u.f.geometry, u.base, clipFor("models"))) continue;   // 断面で足元が全部切られた押し出しは当てない（#111・models の面・半分切られた物は当たる）
				const zb = u.base + lift, zt = u.h + lift;
				// 外接球：中心＝面の中心の上下の中ほど・半径＝弦＋高さの半分＋起伏の遊び（地形に沿う面だけ・広い面ほど大きく）
				const Rm = gnd(g.clon, g.clat) + (zb + zt) / 2 * k;
				const rho = g.chord * Rm + ((zt - zb) / 2 + (mode === "plane" ? 0 : Math.min(9000, 150 + g.chord * EARTH_M) * pf)) * k;
				const [cxp, cyp, w] = clipOf(pos(g.cu, g.cm, Rm));
				if (w > rho) {   // 目の前＝画面の上の広がりは ρ(f+r)/(w−ρ) 以内（r＝中心の画面中央からの距離）
					const sx = (cxp / w * 0.5 + 0.5) * W, sy = (1 - (cyp / w * 0.5 + 0.5)) * H, reach = rho * (f + Math.hypot(sx - W / 2, sy - H / 2)) / (w - rho) + 1;
					const dx = box ? Math.max(box[0] - sx, 0, sx - box[2]) : sx - geometry[0], dy = box ? Math.max(box[1] - sy, 0, sy - box[3]) : sy - geometry[1];
					if (dx * dx + dy * dy > reach * reach) continue;
				}
				const d = hitExtrusion(g.polys, zb, zt, q, env);
				if (d != null) hits.push({ d, f: { type: "Feature", properties: u.f.properties || {}, geometry: u.f.geometry, layer: { id: lid, type: "fill-extrusion" }, source: slot === "default" ? "extrude" : srcId(mlLayers.get(slot)?.layer ?? { id: slot }), height: u.h } });
			}
		}
		return hits;
	};
	// 同期の当たり（C8・2026-10-12）＝利用者の図形（模様・記号・集約の丸・四隅の画像・gint の pass・単一スロットの user 層）だけを、その場で当てる。基図と vector のタイル（非同期）と
	// 押し出し（立体）は見ない。queryRenderedFeatures の同じ部分の実体（hook＝押し出しの答えを差し込む所）。層の mousedown／touchstart（押した瞬間に答えが要る＝preventDefault でパンを止める）もこれを使う。
	// 戻り＝Feature の列・点が球の外なら null
	const queryArea = (geometry: QGeom | undefined) => {   // 問い合わせの範囲（点＝{ ll }・箱＝{ bbox }）。球の外なら null
		const W = size.w / live.dpr, H = size.h / live.dpr;
		if (geometry && typeof geometry[0] === "number") { const ll = unprojectXY(geometry[0], geometry[1]); return ll ? { ll } : null; }
		const [[x0, y0], [x1, y1]] = geometry || [[0, 0], [W, H]];
		const cs = [[x0, y0], [x1, y0], [x0, y1], [x1, y1], [(x0 + x1) / 2, (y0 + y1) / 2]].map(([x, y]) => unprojectXY(x, y)).filter(Boolean) as LonLat[];
		if (!cs.length) return null;
		return { bbox: [Math.min(...cs.map(c => c[0])), Math.min(...cs.map(c => c[1])), Math.max(...cs.map(c => c[0])), Math.max(...cs.map(c => c[1]))] };
	};
	const queryUserSync = (geometry: QGeom | undefined, qo: QueryOptions = {}, hook: ((out: HitFeature[]) => void) | null = null) => {
		const W = size.w / live.dpr, H = size.h / live.dpr, tolPx = qo.tolerance ?? 0, tolUser = qo.tolerance ?? 3;
		const want = qo.layers ? new Set(qo.layers) : null, take = (id: string) => !want || want.has(id);
		const area = queryArea(geometry); if (!area) return null;
		const inBox = (lon: number, lat: number) => area.bbox ? lon >= area.bbox[0] && lon <= area.bbox[2] && lat >= area.bbox[1] && lat <= area.bbox[3] : false;
		const pt = area.ll || [(area.bbox[0] + area.bbox[2]) / 2, (area.bbox[1] + area.bbox[3]) / 2];
		const inRing = (r: number[][], x: number, y: number) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) if ((r[i][1] > y) !== (r[j][1] > y) && x < (r[j][0] - r[i][0]) * (y - r[i][1]) / (r[j][1] - r[i][1]) + r[i][0]) c = !c; return c; };
		const inPolyGeom = (g: QueryGeometry, x: number, y: number) => (g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : []).some(p => inRing(p[0], x, y) && !p.slice(1).some(h => inRing(h, x, y)));
		// 箱の当たり＝MapLibre と同じく「箱と交わる」地物（面は箱が丸ごと中に入っても当たる・線は箱を横切れば当たる）。旧＝頂点が箱に入る物だけ
		//（#174・検査表示の札＝selectThreshold の箱が geojson の面の中で何も返さなかった）
		const segInBox = (a: number[], b: number[]) => {   // 線分と箱（Liang–Barsky）
			const bb = area.bbox!, dx = b[0] - a[0], dy = b[1] - a[1]; let t0 = 0, t1 = 1;
			for (const [p, q] of [[-dx, a[0] - bb[0]], [dx, bb[2] - a[0]], [-dy, a[1] - bb[1]], [dy, bb[3] - a[1]]]) {
				if (p === 0) { if (q < 0) return false; continue; }
				const r = q / p; if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
			}
			return true;
		};
		const lineHits = (cs: number[][]) => cs.length === 1 ? inBox(cs[0][0], cs[0][1]) : cs.some((c, i) => i > 0 && segInBox(cs[i - 1], c));
		const boxTouches = (g: QueryGeometry | null | undefined): boolean => {
			switch (g?.type) {
				case "Point": return inBox(g.coordinates[0], g.coordinates[1]);
				case "MultiPoint": return g.coordinates.some(c => inBox(c[0], c[1]));
				case "LineString": return lineHits(g.coordinates);
				case "MultiLineString": return g.coordinates.some(lineHits);
				case "Polygon": case "MultiPolygon": return (g.type === "Polygon" ? [g.coordinates] : g.coordinates).some(p => p.some(lineHits)) || inPolyGeom(g, pt[0], pt[1]);   // 輪が箱を横切る｜箱の中心が面の中（箱が面に丸ごと入る）
				case "GeometryCollection": return (g.geometries || []).some(boxTouches);
				default: return false;
			}
		};
		const touches = (g: QueryGeometry) => area.ll ? inPolyGeom(g, pt[0], pt[1]) : boxTouches(g);
		const out: HitFeature[] = [];
		// 模様・線の飾り（canvas2D の口＝描画の段の一番上・段 5）＝点は画面の px で当てる（面＝内側・線＝線分からの距離 ≤ 幅/2＋|ずらし|＋許し）・箱は外接の重なり
		const segDist = (x: number, y: number, a: ArrayLike<number>, b: ArrayLike<number>) => { const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy, t = L2 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L2)) : 0; return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy); };
		for (const [id, P] of [...patItems].reverse()) {
			const pv = mlLayers.get(id);
			if (!take(id) || (pv && (!mlVisible(pv) || !inZoomML(drawLayerOf(pv), cam.zoom)))) continue;   // vtdraw で描く模様の層（G-2）は隠しても・域の外でも地物が残る
			for (const it of P.feats) {
				let hit = false;
				if (!area.ll) hit = touches(it.f.geometry);
				else if (P.fill) hit = inPolyGeom(it.f.geometry, pt[0], pt[1]);
				else {
					const lim = it.width / 2 + Math.abs(it.offset) + tolPx, [qx, qy] = geometry!;
					hit = it.lines.some(line => { let prev: ArrayLike<number> | null = null; for (const c of line) { const p = map.projectLL(c[0], c[1]); if (p[2] < 0) { prev = null; continue; } if (prev && segDist(qx, qy, prev, p) <= lim) return true; prev = p; } return false; });
				}
				if (hit) out.push({ type: "Feature", properties: it.f.properties || {}, geometry: it.f.geometry, layer: { id, type: P.fill ? "fill" : "line" }, source: P.sid });
			}
		}
		// 上から：集約の丸 → 画像（最後に貼ったものが上）→ 押し出し → 利用者の図形 → 基図
		if (geometry && typeof geometry[0] === "number" && live.symCtl) for (const h of live.symCtl.symbolsAt(geometry[0], geometry[1])) if (take(h.layer.id)) out.push({ ...h, properties: stripMl(h.properties), ...ezOf(h.properties) } as HitFeature);
		if (geometry && typeof geometry[0] === "number" && live.aggCtl) { const h = live.aggCtl.clusterAt(geometry[0], geometry[1]); if (h && take(h.layer.id)) out.push(h); }
		for (const q of [...live.imageQuads].reverse()) {
			if (!take(q.id)) continue;
			const g: QueryGeometry = { type: "Polygon", coordinates: [[...q.corners!, q.corners![0]]] };
			if (touches(g)) { const { [IMAGE_KEY]: _img, ...props } = q.properties || {}; out.push({ type: "Feature", properties: props, geometry: g, layer: { id: q.id, type: "raster" }, source: "image" }); }
		}
		if (hook) hook(out);
		// addLayer の fill/line/circle（gint の pass）＝上の pass から・pass の中は上の層（circle→line→fill）から。点は識別（gint の identifyAt）・箱は地物ごとに当てる。
		// MapLibre と同じく「その層が描いている地物」を層ごとに 1 件（表を組んだ時の drawn＝層の filter・zoom 域・ジオメトリの型・描く色/幅があるか・台帳 R20）
		for (const e of [...mlPasses.values()].sort((a, b) => b.order - a.order)) {
			const drawn = e.holder.drawn, ls = [...e.holder.pass.layers].reverse().filter(L => take(L.id));
			if (!ls.length || !drawn || !e.h._shown?.(cam.zoom)) continue;
			const acc = e.h._accept?.() ?? null;
			// この地図の m/px は緯度に依らない（同じ z＝同じ倍率）。identifyAt は許しの半径 m を「1 度＝111.32km」の等方で度へ直す＝度の空間の円＝
			// 画面では東西が cos(緯度) だけ縮む（北緯 37° で 9px が 7.2px・旧来の +6px と許し 3px で隠れていた）。cos で割った半径を渡して東西を取りこぼさず
			//（南北は 1/cos だけ広い）、点は画面の距離で締め直す（下）＝MapLibre と同じ円
			const mPerPx = 40075016.686 / (WORLD_PX * 2 ** cam.zoom) / Math.max(0.05, Math.cos(pt[1] * D2R));
			// 当たりの幅＝その pass の層が描いている幅（MapLibre と同じ＝線は線幅の半分＋|ずらし|・円は半径＋縁）＋許し（旧＝許しと点の +6px だけ＝線幅を見ていなかった）
			const pz: ExprCtx = { zoom: cam.zoom, props: {}, geom: null, vars: {}, gs: live.MAP_GS, origin: "ml" }, num = (x: unknown, d: number) => { const v = x == null ? d : typeof x === "number" ? x : +(evalExpr<number>(x, pz) ?? d); return Number.isFinite(v) ? v : d; };
			let lineHalf = 0, ptR = 0;
			for (const L of ls) {
				const pp = L.paint || {};
				if (L.type === "line") lineHalf = Math.max(lineHalf, num(pp["line-width"], 1) / 2 + Math.abs(num(pp["line-offset"], 0)));
				else if (L.type === "circle") ptR = Math.max(ptR, num(pp["circle-radius"], 5) + num(pp["circle-stroke-width"], 0));
			}
			const near = (i: number) => {   // 点の候補は画面の距離で（半径＋縁＋許し）
				const g = e.pbf.getFeature(i)?.geometry;
				if (g?.type !== "Point" || !geometry || typeof geometry[0] !== "number") return true;
				const [px, py, pf] = map.projectLL(g.coordinates[0], g.coordinates[1]);
				return pf > 0 && Math.hypot(px - geometry[0], py - geometry[1]) <= ptR + tolPx + 0.5;
			};
			const fids = area.ll ? [e.pbf.identifyAt(pt[0], pt[1], { point: (ptR + tolPx + 1) * mPerPx, polyline: (lineHalf + tolPx) * mPerPx, ...(acc ? { accept: acc } : {}) })].filter((v): v is number => v != null && near(v)) : null;   // 点は 1px の余裕（gint の格子）→画面の距離で締める
			const feats = fids ? fids.map(i => [i, e.pbf.getFeature(i)] as const) : e.pbf.features.map((f, i) => [i, f] as const).filter(([i, f]) => f?.geometry && (!acc || acc(i)) && touches(f.geometry));
			for (const [i, f] of feats) if (f) for (const L of ls) if (drawn[L.id]?.[i]) out.push({ type: "Feature", id: mlIdOf(e.sid, i) ?? i, properties: stripMl(f.properties), ...ezOf(f.properties), geometry: f.geometry, layer: { id: L.id, type: L.type }, source: e.sid });   // id＝MapLibre の id
		}
		const upbf = gint.userGint?.pbf;
		if (upbf && take("user")) {
			const mPerPx = 40075016.686 * Math.cos(pt[1] * D2R) / (WORLD_PX * 2 ** cam.zoom);
			const uacc = gint.userAccept();   // 単一スロットの paint 表の visible ビット＝filter
			const fids = area.ll ? [upbf.identifyAt(pt[0], pt[1], { point: (tolUser + 6) * mPerPx, polyline: tolUser * mPerPx, ...(uacc ? { accept: uacc } : {}) })].filter((v): v is number => v != null) : null;
			const feats = fids ? fids.map(i => [i, upbf.getFeature(i)] as const) : upbf.features.map((f, i) => [i, f] as const).filter(([i, f]) => f?.geometry && (!uacc || uacc(i)) && touches(f.geometry));
			for (const [i, f] of feats) if (f) out.push({ type: "Feature", id: i, properties: f.properties || {}, geometry: f.geometry, layer: { id: "user", type: "gint" }, source: "user" });
		}
		return out;
	};
	map.queryRenderedFeatures = async (geometry, qo: QueryOptions = {}) => {
		if (!Array.isArray(geometry) && geometry && typeof geometry === "object") { qo = geometry; geometry = undefined; }   // MapLibre と同じ＝第 1 引数に opts だけも可
		if (qo.filter != null) qo = { ...qo, filter: normalizeMLLayer({ filter: qo.filter } as MLLayer, PUBLIC_DZ).filter as StyleExpression };   // 問い合わせの filter も ML の入口 1 本（旧式フィルタ・目盛り）
		// 許し（公式例の門 §8 B・2026-09-27）＝既定 0（MapLibre と同じ・旧 3px は線に余計に当たっていた＝83 例）。単一スロットの user 層（内製・線幅を持たない）だけ従来の 3px
		const W = size.w / live.dpr, H = size.h / live.dpr, tolPx = qo.tolerance ?? 0, tolUser = qo.tolerance ?? 3;
		const want = qo.layers ? new Set(qo.layers) : null, take = (id: string) => !want || want.has(id);
		const qf = (fs: HitFeature[]) => qo.filter ? fs.filter(f => truthy(evalExpr(qo.filter, { zoom: cam.zoom, props: f.properties, geom: f.geometry?.type?.replace("Multi", ""), vars: {}, gs: live.MAP_GS, geojson: f.geometry as ExprCtx["geojson"], pitch: cam.pitch * R2D, origin: "ml" }))) : fs;
		const extHits = [...extrudeHits((geometry || [[0, 0], [W, H]]) as QGeom, take), ...meshHits(geometry as QGeom | undefined, take)];   // 模型・3D Tiles（W7）も立体の当たりの列へ   // geojson の押し出し＝立体で当てる（空を指しても高い屋根には当たる＝地面の問い合わせより先に）
		const vtxHits = live.vtxCtl ? live.vtxCtl.query((geometry || [[0, 0], [W, H]]) as QGeom, take).catch(err => { console.warn("[query] vector extrusion", err); return []; }) : null;   // ベクタタイルの押し出し（段 8①）＝同じ当たり（extView）
		const ext3d = async () => [...extHits, ...(vtxHits ? await vtxHits : [])].sort((a, b) => a.d - b.d).map(h => h.f);   // 押し出しは二つの経路を一つの列に・近い順（MapLibre は 3D の地物を奥行きで並べる）
		// 上から：模様・記号・集約の丸・画像（queryUserSync の前半）→ 押し出し（hook で差し込む）→ gint の pass と user 層（後半）。点が球の外（null）＝高い屋根だけ
		const ext = await ext3d(), area = queryArea(geometry as QGeom | undefined), out = area ? queryUserSync(geometry as QGeom | undefined, qo, o => o.push(...ext)) : null;
		if (!out) return qf(ext);
		if (live.vtdCtl) {   // vector source の描く層（段 8⑤）＝基図と同じ queryTiles を source ごとに（出しているタイルを取り直す）。上の層から＝層の順の鍵の大きい方から
			const bySid = new Map<string, MLLayer[]>();
			for (const v of mlLayers.values()) {
				if (v.kind !== "vtdraw" || !mlVisible(v) || !live.vtdCtl.has(v.layer.id) || v.layer.type === "heatmap") continue;   // heatmap は問い合わせに出ない（MapLibre と同じ）。層の絞り込みは queryTiles の layers（解読する source-layer を問い合わせごとに変えない）
				const L = drawLayerOf(v), sid = srcId(L); if (!inZoomML(L, cam.zoom)) continue;
				if (!bySid.has(sid)) bySid.set(sid, []); bySid.get(sid)!.push(L);
			}
			const hitsV: Array<[number, HitFeature]> = [];
			await Promise.all([...bySid].map(async ([sid, ls]) => {
				const d = vtdDesc.get(sid); if (!d || (want && !ls.some(L => want.has(L.id)))) return;
				const order = live.vtdCtl!.shownTiles(sid); if (!order.length) return;
				const ck = sid + "|" + [...new Set(ls.map(L => L["source-layer"]))].sort().join(",");   // 解読した source-layer の組ごと（queryTiles は要る層だけ解いて覚える）
				let cache = vtdQueryCache.get(ck); if (!cache) vtdQueryCache.set(ck, cache = new Map()); if (cache.size > 32) cache.clear();
				const fs = await queryTiles({ gs: live.MAP_GS, style: { layers: ls }, order, tileUrl: d.pmtiles ? () => d.pmtiles : d.tileUrl!, zoom: cam.zoom, area: area!, tolPx, layers: qo.layers || null, filter: qo.filter || null, cache, request: requester.forTiles(), source: sid, promoteId: d.promoteId ?? null, encoding: d.encoding || "mvt" })
					.catch(err => { console.warn("[query] vector source", sid, err); return []; });
				const rank = new Map(vtdOrder().map((id, i) => [id, i]));
				for (const f of fs as HitFeature[]) { f.state = vtxStateOf(sid, f.sourceLayer, f.id); hitsV.push([rank.get(f.layer.id) ?? 0, f]); }   // state＝押し出しと同じ置き場（#109 段 3）
			}));
			hitsV.sort((a, b) => b[0] - a[0]);   // 安定＝同じ層の中は queryTiles の順
			for (const [, f] of hitsV) { delete f.tile; out.push(f); }
		}
		const baseIds = want && new Set((live.style.layers || []).map(L => L.id));
		if (want && ![...want].some(id => baseIds!.has(id))) return qf(out);   // 基図の層を頼んでいない＝タイルを取り直さない（層ごとのイベントの hover を軽く）
		const base = await queryTiles({ gs: live.MAP_GS, style: live.style, hidden: hiddenAll(), order: live.lastTileOrder, tileUrl: BASE_SOURCE.tileUrl, zoom: cam.zoom, area: area!, tolPx,
			layers: qo.layers || null, filter: qo.filter || null, cache: baseQueryCache(), request: requester.forTiles(), encoding: BASE_SOURCE.encoding || "mvt", source: baseSidNow() }).catch(err => { console.warn("[query] basemap", err); return []; }) as HitFeature[];   // source＝外来 style ならその source 名（MapLibre と同じ答え）・地域の基図＝"basemap"
		for (const f of base) f.state = vtxStateOf(f.source, f.sourceLayer, f.id);   // 基図の地物にも state（絵には効かない＝基図の配管は状態を読まない・MapLibre と同じ形の答え・#109 段 3）
		return qf(out).concat(base);
	};
	// 断面（#111）＝問い合わせも切った側を外す：点の問い合わせで地面が切られていれば立体の地物（押し出し）だけ・それ以外は形が全部切られた地物を外す
	{
		const qRF0 = map.queryRenderedFeatures;
		map.queryRenderedFeatures = async (geometry, qo) => {
			// layers にオーバーレイの名前（map.overlay の name）があれば統一 picking（PR-1）の答えを先頭に混ぜる（点の問い合わせだけ・箱は当てない）
			const ovNames = Array.isArray(qo?.layers) ? qo.layers.filter(isOv) : [];
			const ovHits = ovNames.length && Array.isArray(geometry) && typeof geometry[0] === "number" ? map.pickOverlays((geometry as QGeom)[0], (geometry as QGeom)[1], { names: ovNames }) : null;
			const r0 = ovNames.length ? (qo!.layers!.length === ovNames.length ? [] : await qRF0(geometry, { ...qo, layers: qo!.layers!.filter(n => !isOv(n)) })) : await qRF0(geometry, qo);
			const r = ovHits ? [...(await ovHits).map(overlayFeature), ...r0] : r0;
			if (!live.clipMain) return r;   // 地面の地物＝vector の面（押し出しは extrudeHits が models の面で外す）
			const ptCut = Array.isArray(geometry) && typeof geometry[0] === "number" && clipCutXY((geometry as QGeom)[0], (geometry as QGeom)[1]);
			return r.filter(f => f.layer?.type === "fill-extrusion" || f.layer?.type === "model" || f.layer?.type === "3d-tiles" || (!ptCut && !clipAllCut(f.geometry)));   // 模型・3D Tiles（W7）は描いた三角形に当てた＝切られた側は描かれない＝そのまま
		};
	}
	// 層ごとのイベント（MapLibre 同名・#34）：map.on("click"|"mousemove"|"mouseenter"|"mouseleave", layerId | layerId[], cb)。
	// e＝{ type, point:{x,y}, lngLat:{lng,lat}, features, originalEvent, target: map }。当たりは queryRenderedFeatures（層を絞る＝基図の層でなければタイルを取り直さない）。
	// click はドラッグ（押して 5px 以上動いた）を除く。mousemove は rAF に畳み、最新の問い合わせだけを採る。
	const layerEvs: LayerEv[] = [];   // { ev, ids:Set, cb, inside }
	const onPlain = map.on as OnOff, offPlain = map.off as OnOff;
	const lngLatObj = (ll: LonLat | null) => ll ? { lng: ll[0], lat: ll[1] } : null;
	const hitsFor = async (x: number, y: number, ids: Set<string>) => {   // 層 id のうちオーバーレイの名前は統一 picking（PR-1）へ・それ以外は queryRenderedFeatures へ＝一つの列（オーバーレイは手前＝先）
		const ov = [...ids].filter(isOv), rest = [...ids].filter(i => !isOv(i));
		const [fs, hits] = await Promise.all([rest.length ? map.queryRenderedFeatures([x, y], { layers: rest }) : [], ov.length ? map.pickOverlays(x, y, { names: ov }) : []]);
		return [...hits.map(overlayFeature), ...fs];
	};
	let downAt: [number, number] | null = null, hovSeq = 0, hovRaf = 0, hovLast: PointerEvent | null = null;
	// 押し系（C8・MapLibre 同名）＝mousedown/mouseup/touchstart/touchend/dblclick/contextmenu。同期の当たり（queryUserSync＝利用者の層だけ・基図の層は click/mousemove のみ）で
	// その場で呼ぶ＝e.preventDefault() が間に合う。mousedown で preventDefault すると地図のドラッグを捨てる（MapLibre の create-a-draggable-point と同じ手触り）。touch は points/lngLats（配列）も付ける
	const fireLayerPress = (type: string, e: MouseEvent, x: number, y: number) => {
		const ls = layerEvs.filter(L => L.ev === type); if (!ls.length) return false;
		const ids = new Set(ls.flatMap(L => [...L.ids]));
		const fs = queryUserSync([x, y] as QGeom, { layers: [...ids].filter(i => !isOv(i)) }) || [];
		let prevented = false;
		for (const L of ls) {
			const mine = fs.filter(f => L.ids.has(f.layer?.id)); if (!mine.length) continue;
			const ll = lngLatObj(unprojectXY(x, y)), pt = { x, y };
			const evo: LayerPressEvent = { type, point: pt, lngLat: ll, features: mine, originalEvent: e, target: map, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; prevented = true; } };
			if (type.startsWith("touch")) { evo.points = [pt]; evo.lngLats = [ll]; }
			try { L.cb(evo); } catch (err) { console.error("[map.on %s]", type, err); }
		}
		return prevented;
	};
	canvas.addEventListener("pointerdown", e => {
		downAt = evXY(e);
		const [x, y] = downAt, touch = e.pointerType === "touch";
		if (fireLayerPress(touch ? "touchstart" : "mousedown", e, x, y)) input.cancelDrag();
	}, { signal: ac.signal });
	canvas.addEventListener("pointerup", e => { const [x, y] = evXY(e); fireLayerPress(e.pointerType === "touch" ? "touchend" : "mouseup", e, x, y); }, { signal: ac.signal });
	canvas.addEventListener("dblclick", e => { const [x, y] = evXY(e); fireLayerPress("dblclick", e, x, y); }, { signal: ac.signal });
	canvas.addEventListener("contextmenu", e => { const [x, y] = evXY(e); fireLayerPress("contextmenu", e, x, y); }, { signal: ac.signal });
	canvas.addEventListener("click", async e => {
		const ls = layerEvs.filter(L => L.ev === "click"); if (!ls.length) return;
		const [x, y] = evXY(e);
		if (downAt && Math.hypot(x - downAt[0], y - downAt[1]) > 5) return;   // ドラッグの終わり＝クリックではない
		const ids = new Set(ls.flatMap(L => [...L.ids]));
		const fs = await hitsFor(x, y, ids);
		for (const L of ls) { const mine = fs.filter(f => L.ids.has(f.layer?.id)); if (mine.length) try { L.cb({ type: "click", point: { x, y }, lngLat: lngLatObj(unprojectXY(x, y)), features: mine, originalEvent: e, target: map }); } catch (err) { console.error("[map.on click layer]", err); } }
	}, { signal: ac.signal });
	const hoverLs = () => layerEvs.filter(L => L.ev === "mousemove" || L.ev === "mouseenter" || L.ev === "mouseleave");
	const fireLeave = (L: LayerEv, x: number, y: number, e: PointerEvent) => { if (!L.inside) return; L.inside = false; if (L.ev === "mouseleave") try { L.cb({ type: "mouseleave", point: { x, y }, lngLat: lngLatObj(unprojectXY(x, y)), features: [], originalEvent: e, target: map }); } catch (err) { console.error("[map.on mouseleave]", err); } };
	canvas.addEventListener("pointermove", e => {
		if (!hoverLs().length || e.buttons) return;   // ドラッグ中は当てない（パンの邪魔をしない）
		hovLast = e;
		if (hovRaf) return;
		hovRaf = requestAnimationFrame(async () => {
			hovRaf = 0;
			const ev0 = hovLast!, [x, y] = evXY(ev0), seq = ++hovSeq, ls = hoverLs();
			if (!ls.length) return;
			const fs = await hitsFor(x, y, new Set(ls.flatMap(L => [...L.ids])));
			if (seq !== hovSeq) return;   // 追い越された
			for (const L of ls) {
				const mine = fs.filter(f => L.ids.has(f.layer?.id));
				const evo = (type: string): LayerMouseEvent => ({ type, point: { x, y }, lngLat: lngLatObj(unprojectXY(x, y)), features: mine, originalEvent: ev0, target: map });
				if (!mine.length) { fireLeave(L, x, y, ev0); continue; }
				try {
					if (L.ev === "mousemove") L.cb(evo("mousemove"));
					else if (L.ev === "mouseenter" && !L.inside) L.cb(evo("mouseenter"));
				} catch (err) { console.error("[map.on %s]", L.ev, err); }
				L.inside = true;
			}
		});
	}, { signal: ac.signal });
	canvas.addEventListener("pointerleave", e => { hovSeq++; const [x, y] = evXY(e); for (const L of hoverLs()) fireLeave(L, x, y, e); }, { signal: ac.signal });
	map.on = ((ev: string, a: ((e: never) => void) | string | string[], b?: (e: LayerMouseEvent) => void) => {
		if (typeof a === "function" || b == null) return onPlain(ev, a);
		layerEvs.push({ ev, ids: new Set(Array.isArray(a) ? a : [a]), cb: b, inside: false, key: a });
		return map;
	}) as QueryApi["on"];
	map.off = ((ev: string, a: ((e: never) => void) | string | string[], b?: (e: LayerMouseEvent) => void) => {
		if (typeof a === "function" || b == null) return offPlain(ev, a);
		const k = JSON.stringify(a), i = layerEvs.findIndex(L => L.ev === ev && L.cb === b && JSON.stringify(L.key) === k);
		if (i >= 0) layerEvs.splice(i, 1);
		return map;
	}) as QueryApi["off"];
	map.once = ((ev: string, a?: ((e: unknown) => void) | string | string[], b?: (e: unknown) => void) => {
		if (typeof a === "function" || (a == null && b == null)) { if (!a) return new Promise(res => { const f = (e: unknown) => { (map.off as OnOff)(ev, f); res(e); }; (map.on as OnOff)(ev, f); }); const f = (e: unknown) => { (map.off as OnOff)(ev, f); a(e); }; return (map.on as OnOff)(ev, f); }
		if (!b) return new Promise(res => { const f = (e: unknown) => { (map.off as OnOff)(ev, a, f); res(e); }; (map.on as OnOff)(ev, a, f); });
		const f = (e: unknown) => { (map.off as OnOff)(ev, a, f); b(e); }; return (map.on as OnOff)(ev, a, f);
	}) as QueryApi["once"];
	return { extView, meshPickEnv, vtdQueryCache };
}
