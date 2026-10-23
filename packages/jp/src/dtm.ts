// 日本の裸地標高（DTM）の申告＝**この知識の正本はここ 1 か所**（複製禁止・jp/codes.ts と同じ掟）。
//
// 何を言っているか：「この経緯度域の R01（1°刻みの最精細段）は、裸地標高に焼き直して bucket に置いてある」。
// 焼くのは scripts/bake-dem10b.mjs（地理院 DEM10B → altpbf）。焼いたタイルは source が brand で始まる。
//
// なぜ申告が要るか：段（R90/R10/R01）は世界共通の刻みだが、**その段が何を意味するかは地域で変わる**。
// 日本の R01 は裸地（DTM）だが、国外の R01 は JAXA AW3D30＝表層（DSM・ビル天端と樹冠込み）。
// エンジンと altpbf は段しか知らないので、両者にこの申告を渡す：
//   ① 失効判定（createGetHeight の staleDSM）… 域内で brand 銘の無いタイルは旧 DSM＝捨てて bucket を見直す。
//   ② 接地リフト（ortho-core terrain の liftBounds）… 建物を地面に載せてよいのは裸地が保証される域だけ。
//      表層標高でリフトすると屋根が斜面に裂ける（東新橋/汐留で実測）。
//
// bbox は焼き対象と同一＝本土＋離島（南鳥島 154E / 沖ノ鳥島 20.4N / 与那国 123E / 宗谷 45.5N）を余裕で内包。
// 域内でも bucket 未収録の外国陸地（韓国・台湾等）はある＝そこは JAXA が正（load 側の noBake の印で扱う）。
/** 裸地標高の申告（地域宣言 dtm の形） */
export interface DtmDecl {
	/** [西, 南, 東, 北] */
	bbox: [number, number, number, number];
	/** 焼いてある段（R01＝1） */
	range: number;
	/** 焼き直し済みタイルの source 接頭辞 */
	brand: string;
	/** 個別に焼き直したタイル＝名前 → 新しい焼きの source が含む印（焼いた日 "@YYYY-MM-DD"）。印の無い IDB の写しを失効させる */
	rebaked?: Record<string, string>;
}
export const JP_DTM: DtmDecl = {
	bbox: [122, 20, 154, 46],   // [西, 南, 東, 北]
	range: 1,                   // 焼いてある段（R01）
	brand: "GSI",               // 焼き直し済みタイルの source 接頭辞（"GSI DEM10B"）
	// 焼き直した物（bucket を差し替えても IDB の旧い写しが名前を鍵に勝ち続ける＝ここに足して失効させる）。
	// 2026-10-23：孀婦岩のセルの海が 0 にならず 1°四方が陸（bake-dem10b の海判定）＝R01 と、それを転写した R10
	rebaked: { R01N029E140: "@2026-10-23", R10N020E140: "@2026-10-23" },
};

// 焼き script（bake-dem10b / bake-r10-jp）が使う形。bbox と同じ数字を二度書かないための派生。
export const JP_BOX: { lngMin: number; latMin: number; lngMax: number; latMax: number } = { lngMin: JP_DTM.bbox[0], latMin: JP_DTM.bbox[1], lngMax: JP_DTM.bbox[2], latMax: JP_DTM.bbox[3] };
