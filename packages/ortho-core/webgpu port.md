# WebGPU バックエンド移植（src/gpu/）

位置づけ：アプリ化ラダー③（実機計測→PWA→**WebGPU**→薄い殻）。フル書き直しではなく**臓器移植**＝
`createRenderer`（WebGL2）と同じ公開面 `{ set, draw, dispose, md, mdMax, gintCtx }` を持つ
`createRendererGPU` を並走させ、renderworker が起動時に選ぶ。**WebGL2 は恒久フォールバック**（旧iOS/Android）。

## 現在地（Phase 6・完走・2026-08-01）

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
footprint を伏せる＝二重建物 z-fight 断ち）。＋**星空劇場（Phase 5）**＝`SKY_WGSL`：星/惑星（gl_PointSize が
WebGPU に無い＝**インスタンス四角形**＝6頂点/星・corner を size×device px で screen 展開・FS で soft disc）・
星座線/黄道/天の赤道（topology "line-list"・色は per-buffer UBO）・夜面（フルスクリーン単位球レイキャストで
夜半球を夜紺・GMST 回転＋太陽直下点は Date.now）。共有する純CPU臓器（無改造）：state.js の s・drawdata.js・
bake.js・checkZoomRange・findPolygon。terrain・plateau ワーカーも renderer.set 契約のみ＝無改造で両バックエンド共通。

＋**overlay/snapshot/idfill（Phase 6）**＝これで主要描画スタック完走。
- overlay(stencil-then-cover)＝geopbf/e-Stat/N02 外部ベクタ。per-scene origin は dynamic offset の Frame＋DrawP で切替、
  面=stencil fan(FRONT+1/BACK-1)→cover(NOTEQUAL 0→zero)・線=LINE_WGSL 流用。`OVERLAY_WGSL`。
- snapshot 基図読み出し＝COPY_SRC 付き canvas を flush 直後に copyTextureToBuffer+mapAsync（GL readPixels 相当）。
  top-down（compose flip:false）・Mac は BGRA→RGBA swizzle。shot/print ガジェットが両バックエンドで撮れる。
- idfill(コロプレス)＝winding 和 ID 蓄積（rg16float・加算 blend・R=Σ±(fid+1)/G=Σ±1）→解決(R/G で fid 復元→
  スタイル表→色)。`GINT_STENCIL_WGSL` vsId/fsId＋`GINT_IDRESOLVE_WGSL`。rg16float はコア blendable＝
  fidStyleCount≤2047(市区町村1919)で足りる（超過/paint 無し/fillOff は単色 stencil フォールバック）。

検証：スクリーンショット比較（WebGL2 と目視同一）＝z13 東京平面 / 富士 z13 60° / 東京駅 z16.5 55°（建物+深度）/
山頂等高線 / z5.5・z8.5 60° 海岸線 / 東京駅 PLATEAU / z2 世界ビュー / **z7 N02 新幹線オーバーレイ**。
＋ **tests/t-gintgpu.html**（実時間・9ピクセル検定＝小データ塗り/pick両経路/チルトstencil/tier/overlay塗り/readback基図/idfillコロプレス/**gintBldドレープ線**）。
＋**gintBld**（moj筆ドレープ線/点＝BUILDING_WGSL 流用・line-list/point-list・独自 origin は overlay の dynamic frame 機構に間借り）。

## 懸念点・既知の穴（要レビュー・後日）

移植は速度優先で進めているので、以下は「?gpu=1 実験フラグの範囲では許容・本採用前に潰す」もの。
既定（WebGL2）には一切影響しない（?gpu=1 を付けた時だけの話）。

**A. 未搭載機能** … 解消済（Phase 6＝overlay・idfill・snapshot 基図、＋gintBld ドレープ線/点）。
残る IGNORE は md 系（mdGrow/mdUp/mdScene＝classic merge 固定ゆえ無縁・下記 B）のみ。
※gintBld の点は line-list でなく **point-list（1px）**＝GL の gl_PointSize=7 より小さい（線が主・点は副＝許容）。

**B. 性能パスの差**
- タイル描画は classic CPU merge 固定（md=false）＝multi_draw のタイル GPU 常駐を使わない。密タイル
  （z14+ 都心）で merge のアップロードが WebGL の multi_draw 経路より重い可能性（未計測）。
- ~~動的解像度/GPU格付け：timestamp-query 未配線~~ → **解消（2026-08-02・19e82b5）**：pass 単位の
  timestampWrites＋flush で resolve→mapAsync 非同期回収。renderworker の tqFeed（GL と共通の給餌口）へ
  流し、gpuMap/gpuGint 実測・動的解像度 busyMs・GPU格付け(gpuFast＝静止時の手前詳細化)が WebGPU でも回る。
  非対応 GPU は従来の壁時計フォールバック。⚠Chrome は timestamp を ~100µs 量子化（ms級計測には十分）。

**C. キャップ/打ち切り**
- PLATEAU 可視バッチ MAX_PL_BATCH=512 超過＝console.warn を出して打ち切り（超密都心で発生し得る）。
- PLATEAU マスク 4区上限（GL と同じ＝新規懸念でない）。

**D. 未検証（headless Metal でのみ確認）**
- 実機 Windows Chrome / モバイルの WebGPU 動作（フォールバックは効くが WebGPU 本体は Mac Metal のみ検証）。
- device lost からの復旧（renderer.lost→contextlost は配線済みだが発火は未検証）。
- 実機での動的解像度の滑らかさ（B の壁時計フォールバックが実機で十分か）。

## 使い方・検証

- `?gpu=1` … WebGPU バックエンド。非対応/失敗は worker 内で WebGL2 へ自動フォールバック（挙動同一）。
  既定経路には dynamic import すら発生しない＝バンドル分離（build で `backend-*.js` が別チャンク、
  renderworker 本体には入らない。実測 2026-08-01 全スタック搭載後＝103KB / gzip 34KB）。
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
- **skipMain の等価性（滑走シーン抜けの轍・2026-08-01 修正済）**：skipMain（ズームアウト中の古い詳細シーン退場）が
  伏せてよいのは**タイル slots と建物 bld だけ**（GL 720/819 と同一）。移植時に PLATEAU/gintBld にも `!skipMain` を
  発明して掛けていた→ classic merge（WebGPU は恒常）は滑走中に merge が追いつかず skipMain が長く立つ＝**街ごと
  消える**（東京駅〜丸の内の glide で gpu 単独のシーン抜け・実機報告→CDP 温間三者比較で確定）。GL は PLATEAU を
  show3d のみ・gintBld を無条件で描く＝基図退場中も街は立ち続ける。教訓＝退場フラグの適用範囲は GL 本文と突き合わせる
  （「main の一部か、別ソースか」で線を引く。PLATEAU/gintBld は別ソース＝退場対象でない）。
- **星の gl_PointSize 代替（Phase 5）**：WebGPU に点サイズが無い＝**インスタンス四角形**（6頂点/星・
  vertex_index で corner・星データは instance-step 属性）。screen 空間サイズは `pos.xy*sky + corner*(size*2/viewport)*p.w`
  （×p.w で raster の /w を相殺＝画面 px 一定）。FS の soft disc は `r=length(uv)*2`（GL gl_PointCoord 相当）。
  星座線/黄道/天の赤道は topology "line-list"（GL の gl.LINES＝1px と等価）で自然移植。
- **overlay の per-scene frame（Phase 6）**：外部ベクタは scene 毎に origin が違う＝PLATEAU と同じ
  **dynamic offset**（Frame＋DrawP を per-scene スロットで切替）。塗り色は DrawP.p1（cover が読む）。
  境界線は LINE_WGSL を同じ dynamic frame レイアウトの別パイプラインで流用（シェーダ再利用）。
- **idfill の 2パス（Phase 6）**：ID 蓄積は fr.enc に **別 render pass**（idTex=rg16float・単一サンプル・
  加算 blend）→ main パスで解決を fullscreen 描画。解決は別 bind group layout＝**後続の線/点用に group3(aux) を
  張り直す**（pipeline layout 非互換で bind group がリセットされる轍）。rg16float はコア blendable（float32-blendable
  feature 不要）＝市区町村コロプレスに十分。
- **snapshot（Phase 6）**：canvas を `usage: RENDER_ATTACHMENT | COPY_SRC` で configure＝flush 直後（同一タスク・
  present 前）に current texture を copyTextureToBuffer→mapAsync。top-down（compose の flip:false）・BGRA→RGBA swizzle。

## A/B 計測（実機で ?gpu=1 が速いか）

`?perf=1`（WebGL2）と `?gpu=1&perf=1`（WebGPU）を実機で開き、**同じ飛行（t-demo 等）をして `[perf] ema=…ms` を並べる**。
ema＝壁時計フレーム時間＝両バックエンド共通の物差し（WebGPU は timestamp-query 未配線で gpuMap/gpuGint は "-"、
だが ema は両方出る）。init 行に `backend=… gpu="…"`（GPU 識別）も出る。これで「?gpu=1 が実機で本当に速いか」を数字で。
⚠**ema は 60fps 機では 16.7ms に飽和し差が出ない**（実測 2026-08-01 Mac＝両方16.7で同着。ema はフレーム間隔＝
3ms仕事+13.7ms待ちも16ms仕事+0.7ms待ちも同じ16.7。WebGL 側 gpuMap=4〜8ms の実仕事は vsync の下に隠れる）。
白黒は ①予算超え環境（モバイル高dpr/Windows iGPU）② timestamp-query 配線後の GPU 実時間、のどちらかで付ける。
**実機で確定した差（2026-08-01）＝メモリ**：WebGPU（classic merge）は md 常駐プール（高水位で縮まない）を
持たない＝メモリ消費が極端に軽い（本人実機観測）。モバイル jetsam 戦線への含意大。性能パスBで md 後継を積む際は
このメモリ優位を捨てない設計（eviction 前提）にすること。
※本人の規律（[[mobile-app-strategy]]）＝この計測で「壁は描画か IDB か」を確定してから性能パス（下の B）へ投資。

## 次の道順

1. **性能パス B（計測で速いと出たら）**：タイルの multi_draw 後継（render bundle / drawIndexed baseVertex）＋
   timestamp-query（動的解像度・GPU格付けの物差しを WebGPU でも回復）。計測前は着手しない（measure-first）。
3. **multi_draw の後継**：WebGPU に multiDraw は無いが、(a) `drawIndexed` に **baseVertex がある**＝
   index 再ベース（sceneworker ensureUploaded の絶対頂点番号化）ごと不要にできる、
   (b) **render bundle** で composition を1回記録→毎フレーム再生＝md の狙い（CPU発行ゼロ）を
   タイルプール常駐のまま置換できる。md プロトコル（grow/up/dl）は流用可能な見立て。
4. **動的解像度の将来形**：canvas リサイズでなく**中間ターゲットの解像度スケール＋blit**（リサイズ由来の
   白フラッシュを構造から消す。現在は renderworker の「リサイズは描画フレーム先頭で適用」で既に無害化済み）。
5. timestamp-query（GPU 実時間）を tqSpan 相当へ＝動的解像度・GPU格付けの物差しを WebGPU でも回復。
