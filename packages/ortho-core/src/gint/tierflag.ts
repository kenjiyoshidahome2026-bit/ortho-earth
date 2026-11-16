// tier（段階別 LOD メタ）を焼く層の下限。依存ゼロの 1 語＝render worker が bake 一式を引かずに書ける（rangecache-flag.ts と同じ流儀）。
/** 段階別 LOD（tier）を焼く層の下限（辺数）。既定 20 万＝それ未満の層は全辺を毎フレーム頂点シェーダへ流し、粗いズームでは大半を VS で捨てる。
 *  ?ginttier=N で下げると小さい層（NE 50m の国境＝約 10 万辺）にも粗い束が立ち、世界図の帯で流す頂点が減る（2026-11-16 Galaxy：
 *  UNMAP の既定の眺めで海岸線・国境の層が GPU 約 12 ms＝解像度に依らない＝頂点側）。render worker は init・bake worker は依頼ごとに書く */
export const TIER_MIN_DEFAULT = 20_000;   // 2026-11-16 から 2 万（旧 20 万）。Galaxy（4GB・Mali）の UNMAP 既定の眺め：国境の層 98,487 辺 → 27,364 辺・1 回の描画 8.6 → 4.9 ms・素の頁 42 → 60 コマ/秒（2 回の計測で再現・worker の CPU は変わらず）。?ginttier=200000 で旧来
export const tierFlag = { minEdges: TIER_MIN_DEFAULT };
/** 診断（?gintdbg=nolines|nodepth・WebGPU の線の層だけ）：層の GPU 時間を分解する。nolines＝層の render pass は張るが線を描かない（pass そのものの値段）・
 *  nodepth＝線を地形の深度・標高に参加させない（頂点ごとの標高の値段）。2026-11-16 Galaxy：辺を 72% 減らしても層の GPU 時間は 33% しか減らなかった＝辺にも解像度にも依らない塊の正体を測る */
export const gintDbg = { noLines: false, noDepth: false, noFrag: false };   // noFrag（?gintdbg=nofrag）＝頂点の計算は全部して、三角形を画面の外へ出す（画素の仕事を 0 に＝残る辺 1 本 約 150 ns が頂点か画素かを分ける）
/** 動かしている間だけ LOD の重みを N 段だけ粗くする（?gintlodmove=N・0＝しない・3 段で 1px の許容が 2px）。止まれば元の細かさへ描き直す。
 *  2026-11-16 Galaxy：層の重さ ≈ 35 ns×流した辺 + 150 ns×残った辺＝残る辺を減らすのが効く */
export const gintLod = { moveBias: 0 };
/** 地球の裏側の辺を頂点シェーダで捨てる（?gintback=1・既定は切）。両端とも地平線の向こう（zr < -0.02）の辺は、画素シェーダが必ず透明にする
 *  （地平線のぼかし窓は最大 0.02・その半分より奥は alpha 0）＝絵は 1 画素も変わらない。捨てなければ三角形は画面に乗り、画素ごとに計算してから捨てている。
 *  2026-11-16 Galaxy：線の層 約 3.3 ms のうち画素が約 2.3 ms＝世界図の眺めでは残る辺のおよそ半分が裏側 */
export const gintCull = { back: false };
