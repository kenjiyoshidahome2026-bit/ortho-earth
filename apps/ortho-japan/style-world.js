// 全球ベクタ基図（?world=1 試作）：Protomaps basemaps v4 スキーマの style 層。
// ソースは PMTiles（app.js の TILE_URL がタイル z≤WORLD_TILE_MAXZ で pmtiles:// を返す）＝
// 層名（boundaries/earth/water/…）は bvmap と重ならないので既存 style へ前置するだけで混在できる。
// 方針＝mono の静かな色域に収める：海は z9+ の sea（#e2e6ea）と同色＝ズーム間で海の色が連続。
// 陸は紙のまま（earth は塗らない＝標高の塗りを潰さない）、landcover の淡彩だけ紙に重ねる。
// disputed（係争境界）の破線描き分けは紙の遺物＝実線のまま（設計原則）。
import { WORLD_PAL_DEFAULT } from "ortho-core";   // 湖の色＝全球ハイプソの海（u_seaC）と単一の出所（worldpal.js）
const hexOf = rgb => "#" + rgb.map(v => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
export const worldLayers = (seaRGB = WORLD_PAL_DEFAULT.sea) => [
	// landcover 淡彩は試して撤去（2026-08-30 本人裁定「NEラスタの方が綺麗」）：z0-3 は1タイル数ポリゴンの
	// 粗い塗り絵＝絵はラスタ/陰影の領分。絵の本命は標高ハイプソ（GEBCO からシェーダで計算・GLOBE_FS/TERRAIN_FS）。
	// 国境線もタイルから撤去（本人裁定 同日「gintの方が綺麗」→「admin0_countriesで国の認識」）＝
	// NE admin_0_countries の gint 束（旧・海岸線スロット）がポリゴン辺として海岸線+国境線を一本描き。
	// PMTiles 世界層に残るのは湖の面だけ（gint 側は線の器・湖面はタイルの方が安い）。
	{
		// 水域は湖だけ（z9+ の sea と同色）。ocean は塗らない：(1)海底地形（GEBCO陰影）が全球ビューの
		// 持ち味＝塗ると潰れる (2)z0-3 の ocean は1タイル1巨大ポリゴン＝球面上の巨大三角形の辺が
		// 筋状アーティファクトになる（低zタイルの塗りの長辺細分＝将来のエンジン課題。線側の subLen と同族）
		id: "world-water", type: "fill", "source-layer": "water",
		filter: ["all", ["==", ["geometry-type"], "Polygon"], ["==", ["get", "kind"], "lake"]],
		paint: { "fill-color": hexOf(seaRGB) },   // 全球ハイプソの海（u_seaC）と同色＝湖と海の水が同じ顔（テーマの worldHypso.sea が両方へ届く）
	},
];
