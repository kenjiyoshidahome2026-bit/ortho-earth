# WebGPU バックエンド移植（src/gpu/）

位置づけ：アプリ化ラダー③（実機計測→PWA→**WebGPU**→薄い殻）。フル書き直しではなく**臓器移植**＝
`createRenderer`（WebGL2）と同じ公開面 `{ set, draw, dispose, md, mdMax, gintCtx }` を持つ
`createRendererGPU` を並走させ、renderworker が起動時に選ぶ。**WebGL2 は恒久フォールバック**（旧iOS/Android）。

## 現在地（Phase 4・2026-08-01）

動く：globe（大気・リム）＋基図シーン（fill/line・**classic merge 経路**）＋**標高アトラス（r16float・
stage/commit ダブルバッファ）・地形サーフェス（hillshade/hypso/遠山ブルー）・深度（対数・尾根の遮蔽・
水面リフト＋厳密深度）・基図ドレープ（fill/line の標高変位＋距離フェード）・建物押し出し（anchor標高・
フットプリント伏せ）・等高線**＋**gint（知性の層）**＝`src/gpu/gint.js`+`gintwgsl.js`：
線（capsule SDF・GPU Dynamic LOD＝rank discard＋前方スナップ・tier 梯子・可視チャンク run・境界メタ）・
stencil winding 塗り（低ズームベタ塗り/ヒステリシス/pivot 扇要/bbox カリング）・点・ハイライト＋マスク・
標高ドレープ＋隠線淡破線（terrainDepth 統合）・**非同期 pick 識別**（copyTextureToBuffer+mapAsync＝
GL の PBO+fence と同族）＋JS フォールバック（findPolygon）・スロット束（coast⇄user 交替）。
＋**PLATEAU LOD2 建物（Phase 4）**＝`PLATEAU_WGSL`：重心相対 RTE（meshOrigin+clipMesh 錨）・int8量子化法線
（snorm8x4）・面法線フラット陰影・両面（cullBack は FS 判定）・接地リフト（DTM 保証域 liftBounds 内）・
バッチフラスタムカリング・高さ LOD 打ち切り（lodH/lodCounts）・**被覆マスク**（区単位 r8unorm で基図建物の
footprint を伏せる＝二重建物 z-fight 断ち）。共有する純CPU臓器（無改造）：state.js の s・drawdata.js・
bake.js・checkZoomRange・findPolygon。terrain・plateau ワーカーも renderer.set 契約のみ＝無改造で両バックエンド共通。

検証：スクリーンショット比較（WebGL2 と目視同一）＝z13 東京平面 / 富士 z13 60°（地形+ドレープ+湖）/
東京駅 z16.5 55°（建物+深度）/ 山頂等高線 / z5.5・z8.5 60° 海岸線（gint）/ **東京駅 z16.5 55° PLATEAU
（LOD2 建物+footprint マスク）**。＋ **tests/t-gintgpu.html**（実時間・ピクセル検定）。

未搭載（set は握り潰し・初回のみ console 告知）：overlay(stencil・geopbf/e-Stat/N02)・星空/夜面
（gl_PointSize が WebGPU に無い＝インスタンス四角形化が必要）・idfill（コロプレスIDバッファ塗り＝
paint は fid 線スタイルのみ効き、塗りは単色 stencil へフォールバック）・snapshot の基図読み出し。

## 懸念点・既知の穴（要レビュー・後日）

移植は速度優先で進めているので、以下は「?gpu=1 実験フラグの範囲では許容・本採用前に潰す」もの。
既定（WebGL2）には一切影響しない（?gpu=1 を付けた時だけの話）。

**A. 未搭載機能（set は無視＝?gpu=1 でその層が出ない）**
- overlay(stencil)：geopbf/e-Stat の identify overlay・N02 交通（新幹線/駅）が WebGPU では非表示。
- 星空/夜面：z<4 の世界ビューが素の globe（星なし）。※次フェーズで着手。
- idfill：コロプレス（fid 重み ID 塗り）＝paint は fid 線スタイルのみ効き、面のコロプレスは単色 stencil へ縮退。
- snapshot 基図：shot ガジェットは WebGPU では labels のみ（GL の readPixels 相当未実装）＝画面保存が基図抜け。

**B. 性能パスの差**
- タイル描画は classic CPU merge 固定（md=false）＝multi_draw のタイル GPU 常駐を使わない。密タイル
  （z14+ 都心）で merge のアップロードが WebGL の multi_draw 経路より重い可能性（未計測）。
- 動的解像度/GPU格付け：WebGPU に timestamp-query（EXT_disjoint_timer_query 相当）を未配線＝renderworker の
  tqSpan は WebGPU では無計測。動的解像度は壁時計 EMA へフォールバック（動くが粗い）、GPU格付け（静止時の
  手前詳細化）は WebGPU では立たない。

**C. キャップ/打ち切り**
- PLATEAU 可視バッチ MAX_PL_BATCH=512 超過＝console.warn を出して打ち切り（超密都心で発生し得る）。
- PLATEAU マスク 4区上限（GL と同じ＝新規懸念でない）。

**D. 未検証（headless Metal でのみ確認）**
- 実機 Windows Chrome / モバイルの WebGPU 動作（フォールバックは効くが WebGPU 本体は Mac Metal のみ検証）。
- device lost からの復旧（renderer.lost→contextlost は配線済みだが発火は未検証）。
- 実機での動的解像度の滑らかさ（B の壁時計フォールバックが実機で十分か）。

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
  ゼロ初期化は WebGPU が createTexture で保証＝GL の `allocZeroR16F`（67MB Float32 一時確保回避）は不要。
- **地形メッシュ＝単位格子＋uniform**（GL 版 295c1e5 と同処置・移植済）：頂点は unit uv [0,1]²（G だけに依存）、
  窓の原点/幅は `Frame.mesh`（vec4f）で渡す＝標高アトラスの窓替え（パンのたび）でメッシュを作り直さない。
  旧・絶対 lon/lat 格子は G=1536 で頂点18MB+index56.5MB=**75MB を窓替えごとに GPU 再確保**していた
  （実測: 広域パン8ホップで BUILD 1回＋SKIP 7回＝525MB 分の再確保を uniform 更新へ置換）。
  G が変わる時だけ再構築＝実質「起動時に一度」。
- **MSAA**：canvas 属性でなく明示 4x テクスチャ→resolveTarget。動的解像度のリサイズは
  getCurrentTexture が canvas 寸法に自動追随＝再 configure 不要。
- **数学は 1:1**：sinP テイラー・deltaToRel（桁落ち回避 RTE）・capsule SDF・フォグ・海のズームゲート・
  下地線の伏せ（mainLinesOn）・hillshade（texel歩幅前方差分）・等高線（fwidth AA）まで GL 版と同式・同分岐。
- **gint の 1canvas統合＝frame/flush**：renderer.draw() はエンコーダを開いたまま返し（frameInfo()）、
  gint が自分の render pass（同じ MSAA color＋depth-stencil に loadOp:"load"）を足し、flush() が
  resolve→submit。blend/stencil はパイプライン焼き込み＝GL の状態切替・退避復元の踊りが構造ごと消える。
  stencil の mid-pass clear は「フルスクリーン replace(0) 描き」で代替（gint パス先頭は stencilLoadOp:"clear"）。
- **WGSL 移植の轍**（gint で実際に踏んだもの）：`meta` は予約語／`fwidth` は uniformity 規則で
  分岐内から呼べない＝FS 冒頭へ巻き上げ（discard は demote＝微分は健在）／BSD sed に `\b` は無い。
- **テストの轍**：WebGPU canvas は present 後に current texture が空の新品＝`drawImage` 読み戻しは
  **flush と同一タスク**で行う（rAF 跨ぎの読みは常に px0 の偽陰性）。
- **PLATEAU の per-batch uniform（Phase 4）**：GL は gl.uniform* を draw 毎に叩くが WebGPU はパス内で
  UBO を書けない＝**dynamic offset UBO**（1 bind group＋バッチ毎 256B スロット）に切替。フレーム冒頭で
  可視バッチをカリング→per-batch uniform（meshOrigin+cullBack, clipMesh）を一括 writeBuffer→パス内は
  `setBindGroup(2, bg, [slot*256])` で切替。フレーム共通（mvp/eye/fog/elev）は建物 bld スロットの Frame を流用。
- **PLATEAU 被覆マスクの visibility 轍**：per-batch UBO の `cullBack`(meshOrigin.w) は **FS が読む**＝
  bind group layout の visibility は VERTEX|FRAGMENT 両方（VERTEX だけだと「Fragment stage not in binding
  visibility」で pipeline 作成が落ちる）。マスクは r8unorm・区単位・active 集合が変わった時だけ bind group 再構築。

## 次の道順

1. **overlay(stencil)**：geopbf/e-Stat/N02 の外部ベクタ＝stencil-then-cover 塗り＋境界線。gint の
   stencil パイプライン（GINT_STENCIL_WGSL）が流用の下地。星空/夜面＝gl_PointSize が WebGPU に無い＝
   星をインスタンス四角形へ。snapshot（shot）＝copyTextureToBuffer＋mapAsync。idfill（コロプレスID塗り）。
3. **multi_draw の後継**：WebGPU に multiDraw は無いが、(a) `drawIndexed` に **baseVertex がある**＝
   index 再ベース（sceneworker ensureUploaded の絶対頂点番号化）ごと不要にできる、
   (b) **render bundle** で composition を1回記録→毎フレーム再生＝md の狙い（CPU発行ゼロ）を
   タイルプール常駐のまま置換できる。md プロトコル（grow/up/dl）は流用可能な見立て。
4. **動的解像度の将来形**：canvas リサイズでなく**中間ターゲットの解像度スケール＋blit**（リサイズ由来の
   白フラッシュを構造から消す。現在は renderworker の「リサイズは描画フレーム先頭で適用」で既に無害化済み）。
5. timestamp-query（GPU 実時間）を tqSpan 相当へ＝動的解像度・GPU格付けの物差しを WebGPU でも回復。
