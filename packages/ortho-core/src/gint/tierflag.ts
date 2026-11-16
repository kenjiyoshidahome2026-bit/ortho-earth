// tier（段階別 LOD メタ）を焼く層の下限。依存ゼロの 1 語＝render worker が bake 一式を引かずに書ける（rangecache-flag.ts と同じ流儀）。
/** 段階別 LOD（tier）を焼く層の下限（辺数）。既定 20 万＝それ未満の層は全辺を毎フレーム頂点シェーダへ流し、粗いズームでは大半を VS で捨てる。
 *  ?ginttier=N で下げると小さい層（NE 50m の国境＝約 10 万辺）にも粗い束が立ち、世界図の帯で流す頂点が減る（2026-11-16 Galaxy：
 *  UNMAP の既定の眺めで海岸線・国境の層が GPU 約 12 ms＝解像度に依らない＝頂点側）。render worker は init・bake worker は依頼ごとに書く */
export const tierFlag = { minEdges: 200_000 };
