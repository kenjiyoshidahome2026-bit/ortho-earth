# 描画の速さ・実施計画（2026-09-26 起案）

位置づけ：`perf survey.md`（俯瞰＝何がどこで重いか）の実施計画。本人裁定＝**着手は他の件が片付き次第**。
掟（全項目共通）：①URL の逃げ道を必ず付ける（A/B と切り分け）②門＝既存の関門を緑のまま＋絵の一致③計測は timestamp-query（gpuMap/gpuGint）と
引っ掛かりログ＝`ema` の 16.7ms 飽和を物差しにしない④両バックエンド 1:1 を崩す時は理由を書く⑤危険な修正（機械的置換・暗黙契約依存）は成果でなく危険として先に申告。

## 0. 順番と門（全体）

| Phase | 中身 | 見立て | 出口の門 |
|---|---|---|---|
| 0 | **計器とベースライン**（§1） | 1〜2 日 | 3 端末×3 シーンの表が §8 に埋まる |
| 1 | 速攻 3 件＝P6 gndMix 早期 return（§4）・P1 step0 標高ループの融合＋Float16Array（§2）・P3 線 6→4 頂点（§3）＝**2026-09-27 全て実施済**（数字は §8） | 各半日〜1 日 | 関門緑・絵一致・gpuMap/gpuGint が改善または不変 |
| 2 | P1 step1 GPU 再標本化（§2） | 2〜3 日 | セル一致検定（CPU 参照との差 ≤ f16 ulp）・着地の引っ掛かりログがゼロ |
| 3 | P4 地形 LOD（§5）＝`?gmax=` の天井測定で go/no-go | 3〜5 日 | 低チルトで絵一致・高チルトで差分予算内・割れ無し検定 |
| 4 | P2 プール＋render bundle（§6）＝Phase 0 の数字で go/no-go | 1〜2 週 | classic と md の絵一致・fadede8b の轍の回帰・`?mem=1` にプール行 |
| 5 | P7 パス統合（§7）＝iPhone の計測で継ぎ目が見える時だけ | 2〜3 日 | 絵一致・?perf=1 で分離が保たれる |
| 別線 | P5 topology の uint32 化（§9・geopbf パッケージ） | 1 週 | 出力の byte 一致・既存 t-* 緑・A〜D の内訳が半減 |

順番の理由：Phase 1 は確度が高く安い＝先に取って Phase 0 の計器を実戦で磨く。P2 は最大だが最も重く、計測で「本当に merge が犯人か」を確かめてから。
P4 は `?gmax=` 1 本で上限が分かるので、その数字で規模を決める。P5 は geopbf の別線＝描画と独立に進められる。

## 1. Phase 0 計器（着手前）

- **計器 a（標高）**：`?perf=1` で点く標高計器の旗 `self.__perfElev` に、セル 1 枚あたり「N・再標本化 ms・f16 ms・writeTexture 発行 ms」の行を足す。4ms 超はフレーム番号つきで console。
- **計器 b（シーン）**：render worker の `setScene` に「ms・bytes・層数・fade 有無」の `[scene] apply` 行（perfOn 時）。scene worker の merge に `console.time`（perf 旗は `connect` の mode 通知に相乗り）。
- **計器 c（地形の天井）**：`?gmax=N` ノブ＝`terrain.js` が渡す `gMax` を URL で上書き（既定 1536／lowMem 1024）。G=768 は三角形 1/4＝**P4 が取り得る上限**の代理測定。
- **計器 d（逃げ道）**：P3 後 `?quad4=0`／P6 後 `?gndfast=0`／P2 後は既存の `?nomd=1` の名を流用。
- **ベースライン**：端末＝Mac（Apple silicon）・iPhone（Air3/XS 級の LOW_MEM 機）・Windows iGPU（MID_TIER）。シーン＝2D 東京 z13 平面／富士 z13 60°／東京駅 z16.5 55°（PLATEAU 込み）／t-demo 飛行。
  記録＝gpuMap・gpuGint・res 段・aa・引っ掛かり（計器 a/b の 4ms 超回数）。§8 の表に埋める。
- 物差しの轍：`ema` は vsync 量子化＝差が出ない。**gpuMap/gpuGint と引っ掛かり回数で見る**。3 回取って中央値（worker 揺れ）。

## 2. P1 標高セルの再標本化と f16 変換（順位 1）

**現状**：`terrain.js`（render worker）が elevation worker から Int16 タイルを受け → `downsampleFlipped`（N² バイリニア・閉包 `H()`）→ `renderer.set("elevCell")` →
`gpu/renderer.js writeCell` の `f32ToF16`（N² ビット演算）→ `writeTexture`。混成 R01 は `cropResample`、世界帯は `cell90` が同じ場所で回る。GL 経路は f16 変換が無い（ドライバ）。

**step 0（Phase 1・半日）**
- `f32ToF16` を `typeof Float16Array !== "undefined"` なら `new Uint16Array(new Float16Array(src).buffer)` に（native 変換・モダンブラウザは 2025 で揃った）。無い環境は現行ループ。
- `downsampleFlipped` の `H()` 閉包を展開し、行ごとの `gy/y0/fy` と異常値判定を外へ。出力を直接 `Float16Array` に書けるなら 1 ループに融合（`renderer.set("elevCell")` が Uint16 も受ける）。
- 門：既存の標高検定（`tests/elevation-worldatlas.mjs` の規約＝texel 中心・M=2・異常値 0）に CPU 参照との一致を足す。計器 a で 1 セルの ms を前後比較。
- 期待：1 セル 15〜20ms → 5〜8ms（見立て）。まだ描画スレッドに居る＝step 1 の前段。
- → **実装済（2026-09-27）**：`downsampleFlipped` は列の x0/fx を先に 1 回・内側は配列の直読み（閉包と毎 texel の clamp を消した・算術は同式同順＝bit 一致）。f16 は `gpu/f16.js`（Float16Array の native＋JS ループのフォールバック）。
  Node（Mac）実測＝3600²→1024² の再標本化 6.0→2.6ms（×2.3）・f16 1.40→0.90ms（×1.6）・**セル合計 7.4→3.5ms**（ブラウザの見立て 15〜20ms は過大だった＝Mac の実測は 7ms 級）。
  副産物＝旧 f16 ループは「半 ULP 足して切り捨て」＝タイを上へ丸めていた（3377→3378）。native は IEEE 偶数丸め（3376）＝ループも偶数丸めへ揃えた（両経路 bit 一致・GL のドライバ変換と同じ）。門＝`tests/elevation-resample.mjs`（規約の写しと bit 一致・両 f16 経路・タイ 4 例）。
  出力を直接 Float16 に書く融合は見送り（GL 経路が Float32 を要る・step 1 の GPU 再標本化で丸ごと消える）。
- → **浮世の前後（Mac・bench-perf・3 回中央値・変更前は stash で同じ手順）**：`cropResample` も同じ手で速くして elevation.js へ移設（bit 一致の門つき）。
  | シーン | セル | 変更前 avg ms（res+up） | 変更後 | 最大 res/up 前→後 | 着地の引っ掛かり |
  |---|---|---|---|---|---|
  | 富士 z13 60°（混成＝R10 切り出し中心） | 145 | 1.30（0.90+0.40） | **0.98（0.68+0.31）＝−25%** | 11.9/4.9 → 10.1/3.9 | 5 → 3 |
  | 東京駅 z16.5 55°（純 R01・1024²） | 4 | 15.92（12.35+3.58） | 14.68（12.15+2.53）＝−8% | 23.3/5.4 → 22.3/3.9 | 5 → 5 |
  読み＝f16（upload）は 25〜30% 落ちた。再標本化は小さなセル（R10 切り出し）では −25% だが、**大きな R01 セルは 12ms のまま**＝Node の 6.0→2.6ms が出ない
  ＝算術でなく**メモリ律速**（届いた直後の 3600² 級 Int16 を 2 行ずつ飛び飛びに読む＝キャッシュミス）。ここは JS のループを磨いても取れない＝**step 1（GPU 再標本化＝生タイルを writeTexture で上げて GPU に標本化させる）の根拠が立った**。

**step 1（Phase 2・2〜3 日）＝GPU 再標本化**
- 生 Int16 タイルを `r16sint` テクスチャで上げる（`writeTexture`＝JS ループ無し。bytesPerRow は `setCogTex` と同じ流儀で 256 の倍数に pad）。
  タイル→セルは 1:1（R01/R10）か 1:N（混成の 1° 切り出し・R90 の全球アトラス）＝生タイルの GPU 側 LRU（64MB／lowMem 16MB・バイト予算）を 1 本。
- アトラス（`mkAtlasTex`）に `RENDER_ATTACHMENT` を足し（r16float は renderable・費用なし）、セル矩形へ viewport を切って fullscreen 三角形 1 発。
  FS＝`downsampleFlipped` と同式：`gx=clamp((i+0.5)/N*(w-1), M, w-1-M)`・`x0=min(floor,w-2)`・4 texel `textureLoad`（sint）・異常値（<-420 / >9000）→0・バイリニア・負値→0・行反転（row0=南）。
  `cropResample` は同じシェーダに源の部分窓（uniform）を渡す。stage/commit のダブルバッファは的が stage テクスチャになるだけ。
- GL2：R16F の FBO に同じ絵（`EXT_color_buffer_float`）。取れない環境は CPU 経路のまま（逃げ道＝`?cpuelev=1` は両バックエンド共通）。
- 門：**セル一致検定**（新設 t-elevcell）＝合成タイル（斜面・段差・異常値・縁）を CPU 参照と GPU 経路で作り `copyTextureToBuffer` で読み戻し、|Δ| ≤ f16 ulp（4000m で 2m・500m で 0.25m）。
  t-extrude-drape／t-gintdepth（japan）＝ドレープが動いていないこと。実機の着地で計器 a がゼロ行。
- 轍：`writeCell` の `castRev++`（影の深度の失効）は GPU 経路でも同じ場所で立てる。アトラスの `TEXTURE_BINDING|COPY_DST|RENDER_ATTACHMENT` 同居は WebGPU で合法（同一パスで読み書きしなければよい）。
- **裁定**：step 1 を GPU で行くか、標高 worker へ再標本化を寄せる（生タイル LRU も worker へ移す・memcpy 往復無し）か。推奨＝GPU（ループが両バックエンドから消える・worker 案は LRU の引っ越しが大工事）。

## 3. P3 線の 6 頂点を index で 4 頂点に（順位 3）

**現状**：gint `vsRender/vsPickLine`（`gpu/gintwgsl.js`）は `vi/6` で辺・`vi%6` で角＝辺 1 本に VS 6 回、各回が両端点の復号＋投影＋ドレープ。基図の LINE は corner 6 頂点×instance。点（`vsPoint`）も 6。

**設計**
- 固定パターン index buffer：長さ 6×K の u32＝`[4k+0, 4k+1, 4k+2, 4k+0, 4k+2, 4k+3]`。K＝262144（6.3MB）。run が K を超える時だけ draw を割る（run は 16384 辺チャンクの連結＝割る場所に困らない）。
- gint 線：`pass.draw(cnt*6, n, est*6, n<<16)` → `setIndexBuffer(pattern); drawIndexed(cnt*6, n, 0, est*4, n<<16)`。VS＝`edgeId=vi/4`・`sub=vi%4`・頂点の順は A−,A+,B+,B−（現行 6 列 (A−)(A+)(B+)(A−)(B+)(B−) の一意集合）＝`useA = sub<2`・`side = (sub==1||sub==2) ? +1 : -1`。
  instance の意味（N<<16 | s）は不変。pick 線・ハイライト・隠線も同じ draw に載る。
- gint 点：同じパターンで `vi/4`・角は 4 隅。
- 基図 LINE（`gpu/renderer.js`）：`cornerBuf` を 4 隅（A−,A+,B−,B+）＋6 index `[0,1,2,2,1,3]`（現行 CORNERS の三角形 (A−,A+,B−)(B−,A+,B+) と同一）で `drawIndexed(6, count)`。overlay の `ovLine` も同じ。
- GL：`passes.js` の `drawArrays(TRIANGLES, est*6, cnt*6)` → `drawElements(..., pattern)`＋`drawElementsInstanced`、renderer の LINE も `drawElementsInstanced`＝両バックエンド 1:1。
- 逃げ道：`?quad4=0` で旧 6 頂点経路（gint.js/renderer.js の分岐 1 箇所ずつ）。

**門**：t-gintgpu（9 画素検定＝小データ塗り／pick 両経路／チルト stencil／tier／overlay／readback／idfill／gintBld ドレープ線）・t-gintlod・t-gintdepth・t-linedeco（基図 line-offset）・t-gintswap。
**計測**：`bench-gintsb.mjs` に `?quad4=0` の列を足して z14/z8/z3 の 3 的で A/B（同一タスク連続 submit＝vsync 量子化を避ける既存の流儀）。
**期待**：VS 律速の的で −20〜33%（フラグメント律速の太線では小）。
**轍**：post-transform cache は「同一 instance 内の同一 index」だけ再利用＝instance 数 n の細分でも辺内の 4 頂点は 1 回ずつ。`cullMode:"none"` なので巻き向きは絵に出ないが、index の三角形順は現行と同一に保つ（検定の画素一致）。
**次段（本計画の外）**：可視 run の arc 頂点を compute で 1 回だけ投影（12 回→1 回）。snap は VS に残し、細分のサブ端点だけ VS で投影。層あたり 12B×頂点の中間バッファ＝可視 run に限る。

**実施（2026-09-27）**
- 実装＝設計どおり両バックエンド。WebGPU：gint＝`drawIndexed(cnt*6, n, 0, est*4, n<<16)`（固定パターン u32・K=131072・run が K を超えたら割る）・基図 LINE＝4 隅＋u16 index `[0,1,2,2,1,3]`。
  GL：`drawElements`（baseVertex が無い＝run の先頭辺は `u_vbase` uniform で運ぶ・QK 超は割る）・基図 LINE＝`drawElementsInstanced`（u8 index・各 line VAO に ELEMENT を bind）。
  シェーダの原本は 4 頂点形＝旧 6 頂点は機械変換（`quad6WGSL`／`quad6GLSL`・変換漏れは例外）＝二重管理をしない。逃げ道 `?quad4=0`。
- 門＝globe verify:webgpu 22/22・verify:ui 全頁・japan verify:webgpu 14/14・node test 3 系（core／globe／japan）緑。
- **轍**：GL の `u_vbase` を DEPTH_UNIFORM_NAMES に足していた＝pick 線プログラムは SHARED しか読まない＝location undefined＝run の先頭が 0 に化けて **hover が死ぬ**（描画は uRender が DEPTH も読むので無事＝絵の門は通り、pick の門 t-gintlayers?gl2=1／t-gintmultigl だけが落ちた）。SHARED へ移して根治。
  教訓＝uniform 名の台帳が複数ある時は「どのプログラムがどの台帳を読むか」を先に確かめる。pick の門が絵の門と独立に在るのが効いた。
- **計測①** `bench-gintsb.mjs`（合成 2.1M 辺・同一タスク連続 submit・gint 差分 ms/フレーム・Mac apple metal-3）：

  | 的 | storage（4 頂点） | quad6（旧 6 頂点） | sb/quad6 |
  |---|---|---|---|
  | z14 | 1.37 | 1.24 | 1.11（雑音・線は少数＝VS 律速でない） |
  | z8 | 1.29 | 1.31 | 0.98（同上） |
  | z3 | **16.46** | **20.49** | **0.80＝−20%**（60 万辺の VS 律速＝期待 −20〜33% の下端） |

  読み＝VS 律速の的でだけ効く（見立てどおり）。フラグメント律速・少数辺の的は不変。
- **計測②** `bench-perf.mjs --runs 3`（基図の線・gpuMap の中央値・Mac）＝A/B を順序入れ替えで 2 組（cache の順序効果を潰す）：

  | シーン | 旧 6 頂点 `?quad4=0` | 4 頂点（既定） | 差 |
  |---|---|---|---|
  | 2D 東京 z13 | 0.70／0.70 | 0.33／0.33 | **−53%**（2 組とも同値＝基図の線が 2D の費用の半分） |
  | 富士 z13 60° | 7.77／7.92 | 6.34／6.39 | **−19%**（3D の線 VS は両端点の elevQ 引きが重い＝6→4 がそのまま効く） |
  | 東京駅 z16.5 55° | 9.85（cells 3）／11.12（cells 76） | 7.56（cells 3）／9.80（cells 76） | **−23%／−12%**（同じ cells 同士で比べる＝載った地形セル数で絶対値が動く） |

  ⚠計測の轍＝bench-perf は「その回に載った物」（cells 列）で絶対値が揺れる＝A/B は同じ cells 同士で読む・順序を入れ替えて 2 組採る。1 回だけベンチが 36 分固まった（runRealtime の limitS 300 が効かない経路がある＝再実行で完走・原因未調査＝ベンチ台の整備項目）。
- **結論**：P3 完了。線が費用の主役の的（2D・ドレープ線）で −20〜50%、地形支配の的で −10〜20%。gint は VS 律速の大データで −20%。次の伸びしろは「投影を辺ごとに 12 回→頂点ごとに 1 回」（上記の次段）＝本計画の外。

## 4. P6 gndMix0 の早期 return（順位 6・GL と対等化）

**現状**：`wgsl.js` `gndMix0` は 4 本 `textureSample` の後で `GD0.p.x<0.5` を見る。GL の `gndMix` は先頭で return。
**設計**：`if (GD0.p.x < 0.5) { return col; }` を 4 本の前へ。`var<uniform>` の値は WGSL の一様性解析で一様＝以後の `textureSample` は合法。`discard`（terrain FS の front/t 判定）は demote 意味論＝一様性に影響しない。
**門**：t-wgsl（全モジュールのコンパイル＝Tint が一様性を検札する・ソフトウェア WebGPU でも回る）・2D 東京 z13 の readback 一致（t-gintgpu の readback 基図）。
**逃げ道**：`?gndfast=0`＝旧順序のモジュール文字列（deriveWgsl で 1 箇所）。Tint が万一「一様でない」と言う環境が出たら、代替＝地面アトラス有無でパイプライン変種を持つ（`pipesFor` の鍵に 1 bit）。
**期待**：2D 平面の塗りで画素あたり 4 標本減＝iPhone の 2D パンで gpuMap が下がる（見立て 5〜15%）。
→ **実装済（2026-09-27）**。Mac（apple metal-3）の A/B＝2D 東京 z13 で 0.70／0.70ms＝差なし（1×1 ダミー 4 本の標本化は timestamp の 100µs 量子化の下）。門＝t-wgsl 33/33・t-gintgpu 両経路 緑。効きの確認は iPhone（fill 律速）で再測。

## 5. P4 地形メッシュの距離適応 LOD とチャンク刈り（順位 4）

**step A（Phase 0）**：`?gmax=768` と既定を同じシーンで比べる。gpuMap の差＝地形の三角形密度が持つ費用の上限。差が 1ms 未満なら P4 は棚上げ。
→ **実測（2026-09-27・Mac apple metal-3・§8）：富士 z13 60° で 9.59→5.22ms（−4.4ms・−46%）・東京駅 z16.5 55° で 8.45→6.43ms（−2.0ms）＝go。**
　一律 1/4 の密度でこれだけ落ちる＝視野の遠方が微小三角形の海になっている読み（survey §3.4）が数字で裏付いた。LOD は近景の密度を保ちながら遠方を粗くする＝天井に近い所まで取れる見込み。

**step B（刈りだけ・1〜2 日）**
- index buffer をチャンク主導（16×16 チャンク・各 96×96 quad）に並べ直す＝総量は同じ 14.1M。
- 毎フレーム CPU が 256 チャンクの AABB（標高は保守的に 0〜4000m）を投影し、視錐台の外を描かない。遠景パスは近窓に完全に含まれるチャンクを丸ごと飛ばす（FS の discard より前で消える）。
- draw は可視チャンク数（≤256）の `drawIndexed`＝CPU 0.3ms 級。GL も同じ index 並びで `drawElements` の範囲指定。

**step C（段・2〜3 日）**
- チャンクごとに段 L∈{0,1,2}（頂点の間引き 1/1・1/2・1/4）を投影セル寸で選ぶ（目安＝1 セル ≥ 2px）。段ごとの index 列をチャンク主導で持つ＝+33% の index メモリ。
- 縫い目＝CDLOD 流：per-chunk uniform（PLATEAU バッチと同じ dynamic offset UBO）に (L, 隣接 4 方の L) を運び、VS が境界頂点の uv を粗い側の格子へスナップして
  同じ texel の標高を引く＝割れ無し・縫い index 変種を持たない。`elev()` の量子化（案 A の `elevQ`）が線・塗りにも同じ面を配っているので、スナップ後の面と整合するか検定で見る。
- 逃げ道：`?terrlod=0`。
**門**：低チルト（段が全部 0）で絵一致・高チルトで遠方の画素差分が予算内（新設 t-terrainlod＝下に単色を敷いて割れ画素を数える）・t-extrude-drape・t-gintdepth・t-ao（AO は深度を読む）。
**期待**：60° チルトで三角形 −60〜80%・地形の GPU 時間 −2〜4 倍（step A の数字が決める）。
**裁定**：B だけで止めるか C まで行くか＝step A と B 後の数字で。

## 6. P2 タイル GPU 常駐プール＋render bundle（順位 2・性能パス B）

**go/no-go**：Phase 0 の計器 b で、z14 都心のパンにおいて「setScene apply ≥ 4ms が頻発」または「merge ≥ 20ms」または「fade 二重描きが gpuMap に見える」のいずれか。無ければ棚上げ（メモリ優位を崩す理由が無い）。

**設計（WebGPU 側）**
- プール＝GPUBuffer 4 本：fillV（12B interleave：f32x2＋unorm8x4）・fillI（u32・**プール絶対頂点番号**＝scene worker が既に再ベース）・bldV（24B）・**line は storage buffer**（32B/線分＝scene worker の `ensureUploaded` が既に作る 8×u32 レコード・GL の RGBA32UI テクスチャの代わり。binding 上限 128MB＝4M 線分・超えたらテクスチャへ落とす gint と同じ逃げ）。
- `mdGrow`＝新バッファ確保＋`copyBufferToBuffer` で GPU 内コピー→旧は submit 後に destroy。`mdUp`＝`writeBuffer` を base オフセットへ。`mdScene`＝dl（層ごとの counts/offsets/origins）を保持し bundle を失効。
- シェーダ＝`deriveWgsl` で FILL/LINE/BUILDING の MD 版：`@group(2) var<storage,read> origins: array<vec2f>`＋`@builtin(instance_index) ii`＝`dLL = origins[ii] + a_delta`（GL の `mdize` と同順の加算）。LINE_MD は頂点属性なし・`vi` から線分レコードを storage で引く（P3 後は `vi/4`）。ATLAS_FILL の MD 版も（地面アトラス合成が md の塗りを焼く＝GL の `ATLAS_FILL_MD_VS` と対）。
- 発行＝層 li ごと・タイルごとに `drawIndexed(count, 1, firstIndex, 0, firstInstance=j)`（j＝dl 内の draw 番号＝origins の添字）。これを **render bundle** に記録（`createRenderBundleEncoder({colorFormats:[format], depthStencilFormat: DEPTH, sampleCount: S})`）。
  鍵＝(slot, S, terrainDepth, ゲート署名＝sea ゲート・hideBldFill・rasterHide・mainLinesOn)。dl 差し替えか鍵の変化で再記録（〜1000 draw＝1ms 級・merge と同じ頻度）。main パスでは `executeBundles([b])`。
- bundle の制約：`setStencilReference`／viewport／scissor は使えない（fill/line は不要）・実行後にパス状態がリセット＝後続の overlay/建物は bind group を張り直す（現行コードは毎回張るので影響なし）。
- fade：GL md と同じ**即差し替え**から始める（タイル常駐なら差し替えの粒が小さく「ポンッ」が元々小さい）。要るなら origins に α を添えてタイル単位フェードを後段で。
- メモリ：プール高水位＝タイル予算（24〜96MB）×約 1.3 で有界。縮まないのは GL md と同じ。**LOW_MEM は classic のまま**（GL の既定 OFF と同じ線）＝裁定。`?mem=1` にプール行（capMB/usedMB/frag＝scene worker の stats を render 側でも）。
- 逃げ道：`?nomd=1`（GL と同名・renderer の md:false で scene worker が classic へ）。

**門**：classic と md の絵一致（`webgpu port.md` の標準 8 ビュー＋東京駅 PLATEAU）・fadede8b の轍（起動直後の古い fallback scene が dl を上書きする順序）＝t-* に再現を 1 本・`dlApplied` ack の順序（renderworker の `drainMD`）・skipMain/skipBase の等価性（`webgpu port.md` skipMain の轍）・t-gintgpu の readback 基図・japan の verify:ui 全頁。
**期待**：シーン差し替え＝up ≤3MB/フレーム（既存 `MD_BYTES_PER_FRAME`）＋dl 適用（微小）・全量再アップロード消滅・二重描き消滅・merge の CPU 消滅。
**裁定**：①LOW_MEM の扱い（classic 維持を推奨）②プールを縮める機構を持つか（初版は持たない・予算で有界）③fade を落としてよいか。

## 7. P7 main と gint のパス統合（順位 7・任意）

**判定**：iPhone で「gint 層が空の時の gpuGint」＝継ぎ目（store/load）だけの費用を測る。1ms 未満なら棚上げ。
**設計**：renderer.draw が main パスを開いたまま返し（`frameInfo().pass`）、gint は `fr.pass` があれば自分の `beginRenderPass` を省いて描き、`flush()` が閉じる。idfill は main の**前**に別エンコーダ（`frameInfo().preEnc`）へ積み、submit を `[pre, main]` の順に。AO on の時は現行の分離のまま（AO が main の深度を読む）。
`?perf=1` の時は分離を維持（timestamp の map/gint 分離を守る）。
**門**：t-gintgpu 全項・t-ao・t-overlaydepth（#47 の深度書き出しは main 終了後の深度を読む＝flush 後なら不変）。
**裁定**：計測時以外の map/gint 分離を失ってよいか。

## 8. ベースライン記録欄（Phase 0 で埋める）

採り方＝`apps/ortho-japan` で `node scripts/bench-perf.mjs`（頁＝`tests/t-perfbench.html`・実 GPU・実時間・着地 18 秒→計測窓 9 秒はカメラを毎フレーム動かして連続描画・
計測窓の後半で mem テレメトリの gpuMap/gpuGint（EMA・現解像度）を 3 回読んで中央値）。引っ掛かり＝計器 a/b の 4ms 超の回数（着地 18 秒／移動 9 秒）。
gpuGint が 0＝そのシーンに gint の層が無い（japan の 3 シーン）＝gint の物差しは `bench-gintsb.mjs`（合成 2.1M 辺）で別に採る。frameMs は 16.7 に飽和（vsync）＝見ない。

| 端末 | シーン | backend | gpuMap ms | gpuGint ms | res | aa | 計器 a 4ms 超（着地/移動） | 計器 b 4ms 超（着地/移動） | 備考 |
|---|---|---|---|---|---|---|---|---|---|
| Mac（apple metal-3） | 2D 東京 z13 | webgpu | 0.72 | 0（層なし） | 1 | 1 | 1 / 0 | 0 / 0 | 2026-09-27 基準線 |
| Mac（apple metal-3） | 富士 z13 60° | webgpu | 9.59 | 0（層なし） | 1 | 1 | 5 / 0 | 0 / 0 | 地形が支配（P4 の主戦場） |
| Mac（apple metal-3） | 東京駅 z16.5 55° | webgpu | 8.45 | 0（層なし） | 1 | 1 | 0 / 0 | 0 / 0 | PLATEAU＋押し出し＋地形 |
| Mac | t-demo 飛行 | webgpu | | | | | | | 未（scene player の組み込みは後段） |
| Mac（apple metal-3） | 富士 z13 60°（P1 step0 後） | webgpu | 8.41 | 0 | 1 | 1 | 3 / 0 | 0 / 0 | セル avg 1.30→0.98ms（§2） |
| Mac（apple metal-3） | 東京駅 z16.5 55°（P1 step0 後） | webgpu | 9.37 | 0 | 1 | 1 | 5 / 0 | 0 / 9 | セル avg 15.9→14.7ms・**移動中のシーン適用の引っ掛かり 9〜11 回**（変更前も 11）＝P2 の go 材料（§6） |
| iPhone | （同 4 行） | webgpu | | | | | | | |
| Windows iGPU | （同 4 行） | webgpu | | | | | | | |
| Mac（apple metal-3） | 富士 z13 60° `?gmax=768` | webgpu | 5.22 | 0 | 1 | 1 | 4 / 0 | 0 / 0 | **P4 の天井＝−4.4ms（−46%）**。三角形 1/4 でこれだけ落ちる＝地形の密度が 3D の費用の半分近く |
| Mac（apple metal-3） | 東京駅 z16.5 55° `?gmax=768` | webgpu | 6.43 | 0 | 1 | 1 | 1 / 0 | 0 / 0 | −2.0ms（−24%）。PLATEAU の街でも地形が 1/4 を占める |
| Mac（apple metal-3） | 2D 東京 z13 `?gmax=768` | webgpu | 0.70 | 0 | 1 | 1 | 2 / 0 | 0 / 0 | 不変（地形なし）＝計器の再現性の目安 |
| Mac（apple metal-3） | 2D 東京 z13（P3 後） | webgpu | 0.33 | 0 | 1 | 1 | 0 / 0 | 0 / 0 | **−53%**（旧 0.70・2 組一致・§3） |
| Mac（apple metal-3） | 富士 z13 60°（P3 後） | webgpu | 6.34〜6.39 | 0 | 1 | 1 | 3 / 0 | 0 / 0 | **−19%**（旧 7.77〜7.92・§3） |
| Mac（apple metal-3） | 東京駅 z16.5 55°（P3 後） | webgpu | 7.56（cells 3）／9.80（cells 76） | 0 | 1 | 1 | 0 / 0 | 0 / 0 | **−23%／−12%**（旧 9.85／11.12・同 cells 比較・§3） |

## 9. 別線 P5 topology の uint32 化＋dedup の typed hash／WASM（順位 5・geopbf）

**現状（2026-07 実測・筆ポリゴン 15.67M 頂点・出力 105.8MB）**：TOTAL 12.3s＝A read+pack 0.44s／**B1 cutPolygon dedup 6.7s（55%・BigInt Map）**／B2 metaArc unpack 2.4s（20%・BigInt）／B3 0.13s／B4 buildArcs simplify（WASM）2.5s＝床／C+D 0.05s。削れる側 75%。
**手順**
1. `topology.js` の A〜D・B1〜B4 に `console.time` を戻し（測定後に撤去した物）、手元の筆データで基準線を再取得。出力 GeoPBF を fixture として保存（**byte 一致**の門）。
2. B1：dedup の `Map<BigInt>` を uint32 ペアの typed-array 開番地 hash（`meshq.js uniqueVerts` の写し・容量 2 の冪・線形探索）に。素朴な文字列キー `"gx,gy"` は文字列ハッシュで得しない罠＝使わない。
3. B2：中盤を uint32 のまま回す（キャリアを割る＝u64 一本→uint32 座標＋別チャネルの weight/terminal）。Morton pack は出口の `XYtoL1_wasm` 1 回。`XY2L1` の push は既に WASM メモリの Int32Array ビュー直書き＝理想形の写し。
4. 2〜3 で足りなければ dedup を Rust（i64 hash）へ＝`gint_wasm` に `dedup_wasm(ptr,len)` を足す。
**門**：`geopbf` の t-clean／t-anchors／t-encoders／t-purifier／verify-convert-gpu 緑＋fixture との byte 一致＋census2020 の aggregate と maff 読み込みが同じ絵。
**期待**：12.3s → 5〜6s（2 倍前後）・上振れで半分超。
**時期**：本人裁定「バグ収束後」＝この計画の Phase とは独立。

## 10. やらない事（再提案しない）

- WASM でフレームループ／`mergeTiles`／タイル worker の earcut（理由は `perf survey.md` §5）。
- 鯖焼き（サーバーレス規律）・multi-draw-indirect（Chrome の実験機能＝標準でない）・動的解像度の中間ターゲット化（白抜けは既に無害）。
- GL2 バックエンドの性能投資（恒久フォールバック＝挙動同一が第一・WebGPU の変更を 1:1 で写すだけ）。

## 11. 裁定待ち一覧

| # | 項目 | 選択肢 | 推奨 |
|---|---|---|---|
| 1 | P1 step1 | GPU 再標本化／標高 worker へ寄せる | GPU |
| 2 | P2 | LOW_MEM を classic のまま／全端末プール | classic のまま |
| 3 | P2 | 初版で fade を落とす／タイル単位 α を最初から | 落とす |
| 4 | P4 | 刈りだけ／段まで | step A の数字で |
| 5 | P7 | 計測時以外の map/gint 分離を失う | 継ぎ目 1ms 未満なら棚上げ |
| 6 | P5 | 着手時期・JS typed hash で止めるか Rust まで | バグ収束後・JS で測ってから |
