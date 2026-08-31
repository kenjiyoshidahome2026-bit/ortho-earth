// 海面下の陸地（below_sea_land）焼き＝ortho-japan ?world=1 の「海面下の塗り」用ポリゴン。
// 定義：admin0 陸マスク（NE 10m admin_0_countries・非ゼロ巻き数）∧ GEBCO 標高 ≤ THRESH_M の 0m 等値線ポリゴン。
// 設計（2026-09-01 本人）：描画順が精度を代替する＝アプリ側は globe(ハイプソ)→この塗り→湖/タイルの順に敷くので、
//   ・海側の境界だけ正確（admin0 の海岸線でクリップ＝描かれる海岸線 gint と自己整合）
//   ・湖側（死海・カスピ沿岸・バイカル等）は上に乗る湖の塗りが誤差を隠す＝湖の引き算工程は不要
//   ・内陸側（0m 等値線）は同系の低地色が誤差を隠す＝R90 格子（細分 1/60°）で十分
//   カスピ海本体は NE admin_0 が最初から刳り抜いている（陸マスク外）＝何もしなくて正しい。
// アルゴリズム本体は belowsea-core.js（純関数＝node 検定可能）。ここは I/O（admin0/R90 取得と geopbf 保存）だけ。
import { geopbf } from "geopbf";
import { createTileLoader } from "altpbf/loader";
import { bakeTile } from "./belowsea-core.js";

const THRESH_M = -1;     // これ以下を「海面下」とする(m)。0 だと R90 の量子化ゆらぎで海抜0の大平野を拾う
const F = 2;             // R90(1/30°) に対する細分率＝作業格子 1/60°（海岸線ラスタライズの精度。z6.5 で約1px）
const ERODE = 2;         // 陸マスクの侵食セル数＝「内陸帯」判定（海跨ぎ平均の偽帯除去。1セル≈1.85km）
const MIN_CELLS = 8;     // 成分の最小セル数（約 15-25km²）＝ノイズ粒の除去。デスバレー(数百セル)は余裕で残る
const TILES = [[-180, -90], [-90, -90], [0, -90], [90, -90], [-180, 0], [-90, 0], [0, 0], [90, 0]];   // R90 の8枚（[west, south]）

export async function belowSeaLand(q, opts = {}) {
	q.clear();
	q.title("below-sea land (GEBCO × admin0)");
	// 陸マスクの正典＝NE 10m admin_0_countries（bucket 収録済みの GeoPBF。無ければ S3 生 zip へフォールバック）
	const NAME = "ne_10m_admin_0_countries";
	q.log(`[land] loading ${NAME} …`);
	let admin = await geopbf(NAME, { gint: false }).catch(() => null);
	if (!admin?.length) admin = await geopbf(`https://naturalearth.s3.amazonaws.com/10m_cultural/${NAME}.zip`, { name: NAME }).catch(e => { q.error(`admin0: ${e.message}`); return null; });
	if (!admin?.length) return;
	// 全リングを平たく（タイル毎の間引き用 bbox 付き）。穴も含め全部＝非ゼロ巻き数が向きを吸収
	const rings = [];
	for (const f of admin.geojson.features) {
		const g = f.geometry; if (!g) continue;
		const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
		for (const rs of polys) for (const r of rs) {
			let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
			for (const p of r) { if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0]; if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; }
			rings.push({ pts: r, bbox: [minX, minY, maxX, maxY] });
		}
	}
	q.log(`[land] ${admin.length} countries / ${rings.length} rings`);
	const loadTile = await createTileLoader({ apiUrl: opts.apiUrl });
	const features = [];
	for (const [west, south] of TILES) {
		const dt = performance.now();
		q.log(`[tile] ${west},${south} … loading R90`);
		const tile = await loadTile(west, south, 90);
		if (!tile?.data) { q.error(`[tile] ${west},${south}: R90 が取得できない（GEBCO 焼きが先）`); continue; }
		const { features: fs, compKept, verts } = bakeTile({ west, south, tile, rings, F, threshM: THRESH_M, erode: ERODE, minCells: MIN_CELLS });
		features.push(...fs);
		q.success(`[tile] ${west},${south}: ${compKept} comps → ${fs.length} polys / ${verts} verts (${((performance.now() - dt) / 1000).toFixed(1)}s)`);
		await new Promise(r => setTimeout(r));   // ログを画面に流す
	}
	if (!features.length) { q.error("no features — 閾値/マスクを確認"); return; }
	q.log(`[save] ${features.length} features → below_sea_land`);
	const pbf = await geopbf({ type: "FeatureCollection", features, name: "below_sea_land" }, { name: "below_sea_land", precision: 4, gint: false, nocache: true });
	if (!pbf?.length) { q.error("geopbf encode failed"); return; }
	pbf.updateHeader({
		description: `海面下の陸地（GEBCO×NE admin_0 から焼成・標高≤${THRESH_M}m の陸＝ポルダー/カスピ沿岸低地/カッタラ/死海周辺/トルファン/デスバレー等）`,
		license: "GEBCO / Natural Earth (public domain)",
		attribution: "GEBCO Compilation Group / Natural Earth" });
	await pbf.save();   // ← VITE_API_KEY 未設定だと 403（admin0 ボタンと同じ）
	q.success(`below_sea_land: saved (${features.length} features)`);
	q.log(await pbf.profile());
}
