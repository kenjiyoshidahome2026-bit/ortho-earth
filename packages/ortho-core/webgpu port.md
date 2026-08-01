# WebGPU バックエンド移植（src/gpu/）

位置づけ：アプリ化ラダー③（実機計測→PWA→**WebGPU**→薄い殻）。フル書き直しではなく**臓器移植**＝
`createRenderer`（WebGL2）と同じ公開面 `{ set, draw, dispose, md, mdMax, gintCtx }` を持つ
`createRendererGPU` を並走させ、renderworker が起動時に選ぶ。**WebGL2 は恒久フォールバック**（旧iOS/Android）。

## 現在地（Phase 2・2026-08-01）

動く：globe（大気・リム）＋基図シーン（fill/line・**classic merge 経路**）＋**標高アトラス（r16float・
stage/commit ダブルバッファ）・地形サーフェス（hillshade/hypso/遠山ブルー）・深度（対数・尾根の遮蔽・
水面リフト＋厳密深度）・基図ドレープ（fill/line の標高変位＋距離フェード）・建物押し出し（anchor標高・
フットプリント伏せ）・等高線**。terrain モジュール（視野→セル選定・altpbf fetch・ダウンサンプル）は
renderer.set 契約のみ＝無改造で両バックエンド共通（renderworker finishInit で生成）。
検証（スクリーンショット比較＝WebGL2 と目視同一）：z13 東京平面 / 富士 z13 60°チルト（地形+ドレープ+湖）/
東京駅 z16.5 55°（建物+深度）/ 富士山頂 z13.5 真俯瞰（等高線+地形名）。

未搭載（set は握り潰し・初回のみ console 告知）：PLATEAU・overlay(stencil)・星空/夜面
（gl_PointSize が WebGPU に無い＝インスタンス四角形化が必要）・**gint**（canvas は1コンテキスト制＝
webgl2 と同居不可。gint の WGSL 移植は Phase 3）・snapshot の基図読み出し（labels のみ返す）。

## 使い方・検証

- `?gpu=1` … WebGPU バックエンド。非対応/失敗は worker 内で WebGL2 へ自動フォールバック（挙動同一）。
  既定経路には dynamic import すら発生しない＝バンドル分離（build で `backend-*.js` 約14KB が別チャンク、
  renderworker 本体には入らない）。
- `npm run verify:webgpu` … 実時間 CDP スモーク（t-webgpu.html）。frame1 到達＋backend 確認。
- **轍：`--virtual-time-budget`（verify:ui の headless 流儀）と WebGPU は両立しない**。
  requestAdapter/requestDevice は実時間の GPU IPC＝ページの仮想時計が先に燃え尽き、worker の
  rAF/タイマーが凍った後に device が届く→「実機は健全なのに CI だけ frame1 が来ない」偽陽性。
  だから t-webgpu は verify-ui.mjs の PAGES に載せず、実時間の verify-webgpu.mjs で回す。

## 設計メモ（GL との差分）

- **クリップ z**：GL [-1,1] → WebGPU [0,1]。対数深度は `z01 = 0.5·log2(1+w)·coef` を直接書く
  （GL の window 深度と同値＝深度互換）。wgsl.js `logDepthZ`。
- **smoothstep 逆順引数**：GLSL は黙認・WGSL は未定義動作明記＝`1-smoothstep(正順)` へ等価書換（globe）。
- **uniform**：per-draw の gl.uniform* → 1フレーム1回の UBO 書込。Frame は 512B×4スロット
  （base/main/terrain/bld＝origin と fog の違いをスロットで表現＝GL の setCommonUniforms＋per-program
  上書きの写し）。per-draw の小物（seaGate/lift/exactDepth/色ノブ）は DrawP＝役割別6スロットの静的
  bind group（dynamic offset 不要）。詰め順は renderer.js `packFrame`/`packParams` と wgsl.js が対。
- **深度**：depth24plus 常設＋パイプライン変種で GL の enable/disable/depthMask を表現
  （fill/line: off/test-only・terrain: write+depthBias(4,1)≒polygonOffset(1,4)・building: test+write）。
  水域の厳密対数深度は `fsExact` エントリポイント（@builtin(frag_depth)）＝GL の u_exactDepth と同じ棲み分け。
- **標高アトラス**：r16float（コアで filterable＝GL が R16F を選んだ理由がそのまま活きる）。
  GL は texImage2D がドライバで f32→f16 変換、WebGPU は生バイト渡し＝**CPU で f32→f16**（renderer.js
  `f32ToF16`・最近接丸め）。VS のサンプルは textureSampleLevel（頂点ステージは暗黙 LOD 不可）。
- **MSAA**：canvas 属性でなく明示 4x テクスチャ→resolveTarget。動的解像度のリサイズは
  getCurrentTexture が canvas 寸法に自動追随＝再 configure 不要。
- **数学は 1:1**：sinP テイラー・deltaToRel（桁落ち回避 RTE）・capsule SDF・フォグ・海のズームゲート・
  下地線の伏せ（mainLinesOn）・hillshade（texel歩幅前方差分）・等高線（fwidth AA）まで GL 版と同式・同分岐。

## 次の道順

1. **Phase 3**：gint（RGBA32UI テクスチャ群→storage buffer が自然。頂点プル前提の設計はそのまま乗る）。
2. **PLATEAU**：LOD2 メッシュ（RTE-lite 重心相対＋u_clipMesh 錨）＋被覆マスク（BUILDING_FS のスロット4本）＋
   バッチカリング。星空/夜面＝gl_PointSize が WebGPU に無い＝星をインスタンス四角形へ。
   snapshot（shot）＝copyTextureToBuffer＋mapAsync の非同期読み出し。
3. **multi_draw の後継**：WebGPU に multiDraw は無いが、(a) `drawIndexed` に **baseVertex がある**＝
   index 再ベース（sceneworker ensureUploaded の絶対頂点番号化）ごと不要にできる、
   (b) **render bundle** で composition を1回記録→毎フレーム再生＝md の狙い（CPU発行ゼロ）を
   タイルプール常駐のまま置換できる。md プロトコル（grow/up/dl）は流用可能な見立て。
4. **動的解像度の将来形**：canvas リサイズでなく**中間ターゲットの解像度スケール＋blit**（リサイズ由来の
   白フラッシュを構造から消す。現在は renderworker の「リサイズは描画フレーム先頭で適用」で既に無害化済み）。
5. timestamp-query（GPU 実時間）を tqSpan 相当へ＝動的解像度・GPU格付けの物差しを WebGPU でも回復。
