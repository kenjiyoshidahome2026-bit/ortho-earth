// tier（段階別 LOD メタ）を焼く層の下限。依存ゼロの 1 語＝render worker が bake 一式を引かずに書ける（rangecache-flag.ts と同じ流儀）。
/** 段階別 LOD（tier）を焼く層の下限（辺数）。既定 20 万＝それ未満の層は全辺を毎フレーム頂点シェーダへ流し、粗いズームでは大半を VS で捨てる。
 *  ?ginttier=N で下げると小さい層（NE 50m の国境＝約 10 万辺）にも粗い束が立ち、世界図の帯で流す頂点が減る（2026-11-16 Galaxy：
 *  UNMAP の既定の眺めで海岸線・国境の層が GPU 約 12 ms＝解像度に依らない＝頂点側）。render worker は init・bake worker は依頼ごとに書く */
export const tierFlag = { minEdges: 200_000 };
/** 診断（?gintdbg=nolines|nodepth・WebGPU の線の層だけ）：層の GPU 時間を分解する。nolines＝層の render pass は張るが線を描かない（pass そのものの値段）・
 *  nodepth＝線を地形の深度・標高に参加させない（頂点ごとの標高の値段）。2026-11-16 Galaxy：辺を 72% 減らしても層の GPU 時間は 33% しか減らなかった＝辺にも解像度にも依らない塊の正体を測る */
export const gintDbg = { noLines: false, noDepth: false };
