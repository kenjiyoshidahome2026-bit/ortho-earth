// gint の共通の状態の形（既定の style 表・スロット束の面）＝GL2 と WebGPU の両方が使う。GL のシングルトン s は gl/gint/state.js（2026-10-15 に分けた）。
export const DEF_STYLE = new Float32Array(256 * 4);
DEF_STYLE.set([1.0, 0.420, 0.208, 1.0]);      // style 0: polygon  #FF6B35
DEF_STYLE.set([0.0, 0.706, 0.847, 1.0],  4);  // style 1: polyline #00B4D8
export const DEF_DASH = new Float32Array(256 * 2);
export const DEF_FILL = new Float32Array([0, 0, 0, 0]);
export const DEF_MASK = new Float32Array([0, 0, 0, 0.4]);

export const MOVE_THROTTLE_MS = 32;

// スロット束（"coast"/"user" 等＝ベイク済み GPU/台帳資産のキャッシュ）が退避/復元する層のデータ・スタイル面。GL（embed.js）と WebGPU（gpu/gint.js）で共通。
// 旧＝両方に写しがあり、GL は subB、WebGPU は span/spanB/subB を欠いた＝交替の後も前の層の境界の複製行区間・最長辺スパンが残った
export const SLOT_FIELDS = [
	"gintData", "arcTex", "metaTex", "metaTexB", "ptTex", "ptMetaTex", "pivotTex", "pivotW",
	"totalEdges", "totalPoints", "polyEdges", "totalEdgesB", "polyEdgesB",
	"fillOff", "lowFill", "tiersDone", "lodTiers", "metaChunks", "span", "spanB", "subB",   // span/spanB＝最長辺スパン（地形適応細分の上限）・subB＝境界メタの複製行区間
	"polyEdgeByFid", "polyBboxByFid", "outlineZoom", "minZoom", "maxZoom",
	"fidStyleTex", "fidStyleW", "_fidStyleH", "fidStyleCount", "_fidStyleData",   // paint（コロプレス表）も層の属性
];
// 空束は毎回新品（lodTiers 等の配列参照を共有すると空スロット中の構築が全スロットを汚す）。span 等の既定＝アップロードの初期化と同じ（-1＝未知）
export const emptySlot = () => ({ gintData: null, arcTex: null, metaTex: null, metaTexB: null, ptTex: null, ptMetaTex: null,
	pivotTex: null, pivotW: 0, totalEdges: 0, totalPoints: 0, polyEdges: 0, totalEdgesB: 0, polyEdgesB: 0,
	fillOff: false, lowFill: false, tiersDone: false, lodTiers: [], metaChunks: null, span: [-1, -1], spanB: [-1, -1], subB: null,
	polyEdgeByFid: null, polyBboxByFid: null, outlineZoom: null, minZoom: null, maxZoom: null,
	fidStyleTex: null, fidStyleW: 0, _fidStyleH: 0, fidStyleCount: 0, _fidStyleData: null });
