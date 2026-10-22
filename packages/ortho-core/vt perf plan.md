# ベクタータイル描画の高速化・実施計画（2026-10-22 起案）

位置づけ：`perf plan.md`（2026-09-26・地形と線と標高セル＝P1/P3/P4/P6 実施済）の続き＝**ベクタータイルの道筋**（取得→復号→組み立て→結合→転送→描画→退避）に絞った計画。
`perf survey.md` §2・§3.2 の「classic merge の費用は 3 段」を主戦場にし、残っていた **P2（WebGPU の GPU 常駐プール）** を本線に据える。
並走する 2 本（MapLibre style 互換・注記の GPU 化）との重なりと依存は §7。実装は本計画の外＝**着手は本人裁定**。

掟は `perf plan.md` と同じ：①URL の逃げ道 ②既存の関門を緑のまま＋絵の一致 ③物差しは timestamp-query と引っ掛かりログ（`ema` は見ない）④両バックエンド 1:1 を崩す時は理由を書く ⑤危険は成果より先に申告。

## 0. 現状の道筋（読んだ版＝main 4f57521・2026-10-22）

| 段 | 所在 | 中身 | 費用の性格 |
|---|---|---|---|
| 選抜 | main `tilemanager.ts update` | 距離 LOD（`selectLOD`×3＝主層・下地・毛布）・keepFine・未着の代打（fillGaps）・LRU（バイト予算 24〜96MB） | memo 済（静止フレームは 0）。移動中はチルトで数 ms |
| 取得 | tile worker ×≤4（`pipeline.ts`） | `fetch`（HTTP 温間キャッシュのみ・IDB 無し）・coverage 外は 404 扱い・視野外 abort | 回線律速。**割り当ては round-robin（`wIdx`）＝遅いタイルの後ろに並ぶ** |
| 復号 | tile worker `decode.ts` | 自前 pbf（need 外の層は素通り・フラット coords） | 軽い（Node 実測＝0.37ms/枚・下表） |
| 組み立て | tile worker `build.ts` | 層ごと filter/sort → fill＝clip→**earcut**→（z≤6 細分）→経緯度 / line＝700m 細分の線分列→色・幅を頂点に焼く | **タイル CPU の主役**（3.6ms/枚・earcut が 1/4） |
| 結合 | scene worker `mergeTiles` | 可視全タイルの typed array を li ごとに連結（＋原点再ベース） | **WebGPU は毎回これ**（`gpu/renderer.ts` は `md:false`・`mdGrow/mdUp/mdScene` は IGNORE）。GL2 だけ multi_draw プール |
| 転送 | render worker `setScene` | 全層 `createBuffer`＋`writeBuffer`（数 MB）→ 180ms クロスフェード（旧＋新の二重描き） | **描画スレッドの引っ掛かり**（東京駅 z16.5 の移動中 9〜11 回／9 秒＝`perf plan.md` §8） |
| 描画 | render worker | li ごと 1 draw（fill＝drawIndexed・line＝4 頂点 instanced） | 塗りは FS 律速・線は VS（両端の elevQ 引き） |

**Node の計り（`scripts/bench-tile.mjs --runs 10`・Mac 相当の x86 コンテナ・見本＝optbv 35 枚（WA/Anno だけ・3,107 地物））**：decode 12.8ms・build 127ms・merge 33ms（全枚）。
`--cpu-prof` の内訳（self 時間）＝mergeTiles 12%・fillParts（経緯度化＋写し）10.5%・**earcut 合計 ≈ 25%**（isEarHashed 9.6＋earcutLinked 6.0＋earcut 5.6＋findHoleBridge 2.5…）・buildTileDrawList1 8.6%・GC 6.4%・readGeometry 3.1%・latOf 3.0%・buildLabels 2.9%・clip（ring＋clipToExtent）4.4%。
⚠ 見本が WA/Anno だけ＝都心 z16（道路・建物・街区が主）は線の細分と earcut の比率が変わる＝Phase 0 で見本を足す。

## 1. 順番と門（全体）

| Phase | 中身 | 見立て | 出口の門 |
|---|---|---|---|
| 0 | **計器と見本**（§2） | 1〜2 日 | 3 シーンの「要求→画面」の表（§8）が埋まる・bench-tile に都心 z16 の見本 |
| 1 | **タイル worker の速攻 4 件**（§3）＝優先付き共有キュー・2D の線細分を止める・fill の clip 省略・labels の切り出し | 各半日〜1 日 | bench-tile の `--hash` 同値（絵が変わらない件）・関門緑・要求→画面の中央値が下がる |
| 2 | **P2＝WebGPU の GPU 常駐プール＋タイル単位 draw**（§4・本線） | 1.5〜2 週 | classic と md の絵一致・`[scene] apply` の 4ms 超がゼロ・merge の CPU が消える・`?nomd=1` で旧経路 |
| 3 | **色・幅を頂点から剥がす（paint 表）**（§5）＝restyle／setPaintProperty／feature-state が再ビルド無しに | 1〜2 週・**MapLibre 互換の線と要調整** | テーマ切替で tile worker が働かない・ズーム連続の線幅が MapLibre と一致 |
| 4 | **結合頻度と常駐の見直し**（§6）＝P2 後に初めて意味を持つ小物 | 2〜3 日 | パン中の merge 間隔を詰めても引っ掛かり 0 |
| 棚 | pre-tessellated MLT（自前配信の源だけ）・earcut の代替 | — | §9 |

順番の理由：Phase 1 は確度が高く安く、**タイルが画面に出るまでの遅れ**（体感の主因）を縮める。Phase 2 が最大で、`perf plan.md` §6 の go 条件（移動中のシーン適用の引っ掛かり 9〜11 回）は**既に満たしている**＝計測で再確認したら着手。
Phase 3 は描画の速さというより「書き直しをしない」ための設計で、MapLibre 互換（式の分類）と不可分＝並走スレッドの裁定を待って着手。

## 2. Phase 0 計器と見本

- **計器 e（タイル 1 枚の道筋）**：tile worker が `TileOkResponse` に `t: { queued, fetch, decode, build }`（ms）を添える（`?perf=1` の時だけ）。main の `mergeLog`（要求→着地）と合わせ、**「選抜で必要になった → 画面に載った」の中央値／p90** を 3 シーンで出す（mem テレメトリに `vt.lat` 行）。
  これが本計画の**主物差し**＝gpuMap（1 フレームの GPU）と別物。パン中の「白抜き・ポン」はここの遅れ。
- **計器 f（結合の量）**：scene worker の merge 行（既存・perfOn）に「変わった枚数／全枚数」を足す＝P2 で消える仕事の大きさを数字に。
- **見本**：`globe/tests/fixtures/optbv` は WA/Anno だけ。`bake-optbv-fixture.mjs` で都心 z16（東京駅 3×3）と郊外 z13（富士）を足し、`bench-tile.mjs` の CASES に載せる（fixture は数百 KB・NOTICE に出典）。
  `--hash` 既存＝最適化の前後で ops の bit 同値を見る門。
- **ベースライン**：`apps/ortho-japan/scripts/bench-perf.mjs` の 3 シーン（2D 東京 z13／富士 z13 60°／東京駅 z16.5 55°）に「パン 9 秒」の窓があるのでそのまま。採るのは計器 e の中央値・p90、`[scene] apply` の 4ms 超回数、merge 回数／9 秒。§8 の表へ。

## 3. Phase 1 タイル worker の速攻 4 件

### 3.1 優先付き共有キュー（順位 1・確度 高・半日〜1 日）
**現状**：`pipeline.ts workerBuildTile` は `wIdx` の round-robin で worker に**即 post**＝worker 内の到着順。`tilemanager.update` の ensure 順は **毛布 → 下地 → 主層**＝画面中心の詳細タイルが、視野 3 倍の毛布や下地の後ろに並ぶ。abort は fetch を切るが、キューの順は変えられない。
**設計**：main に 1 本の優先キュー（鍵＝`(役: 主層 0 / 下地 1 / 毛布 2, 画面中心からの距離)`）を置き、**worker が空いた時に先頭を渡す**（各 worker の同時実行 2〜3 本＝fetch の待ちを重ねる）。優先度は update ごとに付け直す（キュー内の未発送分だけ・発送済みは従来どおり abort で切る）。
**門**：t-* の既存（タイルの絵は不変）・計器 e の「主層の要求→画面」中央値が下がる。逃げ道 `?tileq=0`（round-robin）。
**期待**：パン中の主層の遅れ −30〜50%（回線が同じでも順が変わる）。**P2 と独立**＝先に取れる。

### 3.2 2D（地形なし）では線の細分をしない（順位 2・確度 高・半日）
**現状**：`build.ts lineSegs`／`emit` は全線分を **700m ごと最大 24 分割**（地形ドレープで尾根が折れないため）。2D（`terrain` 無し・平面の地図・z≤6.5 の世界帯）でも同じ＝線分数が数倍（z8 で 1 線分 ≈ 600m÷…＝z10 以下で顕著）。線分は 32B×4 VS＝プール（P2）の line も膨らむ。
**設計**：`subLenM` を style／init で渡す（`TileInitRequest` に `drape: boolean`）。地形オフの地図（`createGlobe({ terrain: false })`・外来 style で terrain 無し）は `Infinity`＝細分なし。地形の有無が切り替わる時（`setTerrain`）は `setStyle` と同じ再ビルド（稀）。
球の弦の沈み（細分の無い長い線が球に潜る）は fill と同じ閾（z≤6 は `128>>z` 格子）を線にも適用＝低 z だけ粗い細分を残す。
**門**：t-linedeco・2D 東京 z13 の readback 一致（線の画素）・世界帯 z2 の海岸線で潜りが無い（新設 1 枚）。bench-tile の line 線分数が 2D 見本で減る。逃げ道 `?linesub=1`。
**期待**：2D の線の VS −50〜70%（z≤12）・タイルの実バイト −20〜40%（線が主の郊外）。

### 3.3 fill の clip を「はみ出す地物だけ」に（順位 3・確度 高・半日）
**現状**：`fillParts` は全ポリゴンに `clipToExtent`（4 辺の Sutherland–Hodgman・Float64 の作業配列）。都心の街区・建物は 9 割が extent 内＝切る物が無いのに走る（prof の ring＋clipToExtent 4.4%）。
**設計**：リングの bbox を先に取り（`polygons()` の signedArea と同じ 1 走査で済む）、`0≤x,y≤extent` に収まるポリゴンは clip を飛ばす。
**門**：`bench-tile --hash` の同値（clip が恒等な地物は bit 同値のはず・差が出たら clip の丸めが見える＝それも知見）。
**期待**：都心 z16 の build −5〜10%。小さいが安く、earcut の前段を軽くする。

### 3.4 注記の組み立てを tile 応答から切り離す（順位 4・確度 中・1 日）
**現状**：`buildTilePayload` は geometry と一緒に `buildLabels`（prof 2.9%・main へ構造化クローン＝typed array でない object の配列）を返す。main は geometry を知らないが、注記 object の配列は毎タイル main に届く（`labelsBytes` で予算にも乗る）。
**設計**：注記は geometry と**別メッセージ**（`{ type: "labels", key, labels }`）にし、geometry の `tile` メッセージを先に scene worker へ流す＝塗りと線が一拍早く結合に乗る。
⚠ **注記の GPU 化スレッド**が「注記も scene port 経由で render worker へ直送」に進むなら、この切り離しはその前段になる（§7）。先方の設計を見てから形を決める＝Phase 1 の最後に置く。
**門**：t-labels 系・ラベルの当選集合が不変（labelKey）。

## 4. Phase 2 P2＝WebGPU の GPU 常駐プール＋タイル単位 draw（本線）

設計の骨は `perf plan.md` §6 のまま（プール 4 本・scene worker のアロケータ流用・render bundle）。ここでは**段と門と残課題**だけ書く。

**go の根拠（既に手元にある数字）**：`perf plan.md` §8＝東京駅 z16.5 55° の移動中に `[scene] apply` 4ms 超が 9〜11 回／9 秒。Node の merge＝35 枚で 33ms（都心 z16 はもっと重い）。180ms フェードは塗り・線を**二重に描く**＝移動中の gpuMap を 1.3〜1.8 倍に押し上げている（計器 f で確かめる）。

**段**
- **step A（3〜4 日）プールと転送**：`gpu/renderer.ts` に `mdGrow`（新 buffer＋`copyBufferToBuffer`・旧は submit 後 destroy）／`mdUp`（`writeBuffer` を base へ）／`mdScene`（dl 保持）。fillV 12B（f32x2＋unorm8x4）・fillI u32（プール絶対頂点番号＝scene worker が既に再ベース）・bldV 24B・**line は storage buffer**（scene worker の 8×u32 レコードそのまま・binding 上限 128MB 超はテクスチャへ落とす）。
  発行＝li ごと・タイルごと `drawIndexed(count, 1, firstIndex, 0, firstInstance=j)`・`origins[j]` を storage で引く（`deriveWgsl` の FILL/LINE/BUILDING の MD 版・ATLAS_FILL の MD 版も）。**まず素朴なループで出す**（1,000〜2,500 draw/フレーム＝CPU 発行 1〜3ms 級の見立て・計測してから bundle へ）。
  `renderer.md=true, mdMax` を返し、`renderworker` の mode 通知で scene worker が md へ（`drainMD` の 3MB/フレーム予算・dlApplied ack は GL と同じ道＝**既にある**）。
- **step B（2〜3 日）render bundle**：dl 差し替えと鍵（slot・sampleCount・terrainDepth・ゲート署名）の変化で再記録・main パスは `executeBundles`。bundle 内は `setStencilReference`／viewport 不可＝fill/line は不要（建物は現行どおり外）。
- **step C（1〜2 日）フェードと LOW_MEM**：fade は落とす（タイル単位の差し替えは粒が小さい・`perf plan.md` 裁定 #3）。LOW_MEM は classic のまま（裁定 #2）＝`md` は `tier !== LOW_MEM` の時だけ。`?mem=1` にプール行（capMB/usedMB/frag）。
- **step D（半日）結合側の後始末**：md では `mergeTiles` が走らない＝scene worker の `geom` は常駐確定で解放（既存 `ensureUploaded`）。main の `MAIN_REQ_GAP_MS`／`MOVE_SWAP_MS` は Phase 4 で見直す。

**門**：classic（`?nomd=1`）と md の絵一致（`webgpu port.md` の標準 8 ビュー＋東京駅 PLATEAU・readback の画素差 0）・fadede8b の轍（起動直後の古い fallback scene が dl を上書きする順序）の回帰 1 本・`dlApplied` の順序（`drainMD` FIFO）・skipMain/skipBase の等価性・t-gintgpu の readback 基図・japan verify:ui 全頁・**`[scene] apply` の 4ms 超が 3 シーンでゼロ**・gpuMap が移動中に下がる（フェードの二重描き消滅）。
**危険（先に申告）**：①プール高水位は縮まない（GL md と同じ）＝タイル予算×1.3 で有界だが、PLATEAU の百 MB 級が同居するスマホは jetsam の縁＝LOW_MEM を外すのはそのため ②`copyBufferToBuffer` の成長中に up が来る順序＝FIFO で守られているが WebGPU は submit 単位＝grow と up を**同じ encoder に積む** ③storage の line は `maxStorageBufferBindingSize`（既定 128MB）＝超えたら gint と同じテクスチャ退避。
**期待**：シーン差し替え＝転送 ≤3MB/フレーム（既存予算）＋dl 適用（µs）・merge の CPU（33ms/35 枚級）消滅・二重描き消滅＝移動中 gpuMap −20〜40%（都心）・引っ掛かり 0。

## 5. Phase 3 色・幅を頂点から剥がす（paint 表）

**現状**：`build.ts` が `fill-color`／`line-color`／`line-width`／`line-opacity` を**タイルの z で評価して頂点に焼く**。結果＝①テーマ切替・`setPaintProperty`・`setFeatureState` は `tiles.reset()`＝**全タイル再ビルド**（生バイトは温間でも build 3.6ms/枚×可視 40〜80 枚＝数百 ms） ②ズーム依存の線幅・色は**タイル z で段になる**（MapLibre は毎フレーム連続補間）③頂点 12B のうち 4B が色（線は 32B 中 8B が色と半幅）。
**設計（案）**：頂点には **paint slot（u16）** だけを持たせ、層ごとに `{ color, opacity, width, offset }` の表を storage buffer（`PaintTable[li][slot]`）に置く。
- slot の割り当て＝式の**分類**で決める：(a) 定数／zoom だけの式 → slot 0（層ごと 1 行・main が毎フレーム現在 zoom で評価して表を書く＝連続補間がタダで手に入る） (b) データ駆動（`get`／`match`／`case` で props を読む）→ 地物ごとの評価値を**タイル z で焼いた行**（従来と同じ段・行数＝ユニーク値の数＝通常数十） (c) zoom × データの混合（`interpolate` の中に `get`）→ 従来どおり頂点に焼く（逃げ道・fallback）。feature-state は (b) の行を差し替える（再ビルド無し）。
- 表の書き換え＝`writeBuffer` 数 KB＝テーマ切替・setPaintProperty が **1 フレーム**に。
- GL2 は同じ表を RGBA32F テクスチャで（1:1）。
**MapLibre 互換スレッドとの境界**：**式の分類（a/b/c）と「どの paint が表に載るか」は先方の領分**（`mlstyle.ts`・`expr.ts` の compile に `kind` を足す形が自然）。本計画は「表に載る形」（頂点 u16＋storage 表＋WGSL の読み）を提供する。先方の `setPaintProperty` 差分適用（`restyleBase`＝今は組み直し 1 回）は、この表が入ると自動で軽くなる＝**先方の仕様が固まるまで着手しない**。
**門**：t-palette-live（添字ズレ）・テーマ切替の絵一致（表の行を焼いた値と bit 同値・`--hash` を paint 抜きの geometry 指紋に）・ズーム連続の線幅が MapLibre の例（`maplibre-compat.md` の線幅の例）と一致。逃げ道 `?paintbake=1`（従来の焼き込み）。
**期待**：テーマ切替 数百 ms → 1 フレーム・頂点バイト −10〜25%・ズーム中の線幅の段が消える。

## 6. Phase 4 結合頻度と常駐（P2 の後）

- `MAIN_REQ_GAP_MS`（60）／`MOVE_SWAP_MS`（125）／`MOVE_SWAP_ZOOM_MS`（60）は classic の重さに合わせた間引き。md では「新しいタイルが 1 枚増えた」＝up 1 件＋dl＝軽い＝**ズーム中は 1 フレーム 1 要求**まで詰める（dlApplied の FIFO が追い越しを防ぐ）。門＝引っ掛かり 0 のまま・パン中の白抜き時間（計器 e）が縮む。
- 下地（base）の merge も md のプールで＝同じタイルが main と base の両方に載る時、常駐は 1 回（`md.res` が key で共有）＝今でもそう＝確認だけ。
- LRU 予算＝tess 済みバイトで縛る現行のまま。md では geometry が GPU に居る＝**端末の GPU メモリ**（`deviceMemory` 代理）で天井を分ける（`fallback-ladder.md` のティア表に 1 行）。
- 生バイトの IDB キャッシュ（オフライン・再訪の即出し）＝`offline-pack.ts` の領分＝本計画の外。

## 7. 並走スレッドとの重なりと依存

| 相手 | 重なる所 | 本計画の立場 |
|---|---|---|
| **MapLibre style 互換** | 式の分類（zoom／data／混合）・`setPaintProperty`／`setFeatureState` の差分適用・`restyleBase` | §5 の paint 表は**先方の分類が決まってから**。本計画からは「頂点 slot＋storage 表」の口を提供。Phase 1・2 は先方と独立（絵が変わらない） |
| **注記（テキスト）の GPU 化** | tile worker の `buildLabels`・main に届く注記の配列・render worker の `labels2d` | §3.4 の「注記を別メッセージに」は先方の入口になる。**注記が scene port 経由で render worker へ直送**になるなら、P2 のプール割り当て（free-list・grow/up/dl の FIFO）を**glyph／注記の pool にも流用できる**＝アロケータは共有で設計（pool 名を増やすだけ）。注記のバイトを main の予算から外す時は `labelsBytes` の扱いを一緒に変える |
| `perf plan.md` | P2（§6）・P7（パス統合） | P2 はここで引き取る（`perf plan.md` §6 は本計画 §4 を指すよう 1 行足す）。P7 は手を付けない |

## 8. ベースライン記録欄（Phase 0 で埋める）

| 端末 | シーン | 主層 要求→画面 中央値／p90（ms） | `[scene] apply` 4ms 超／9 秒 | merge 回数／9 秒・変化枚数の平均 | gpuMap 移動中（ms） | 備考 |
|---|---|---|---|---|---|---|
| Mac | 2D 東京 z13 パン | | | | | |
| Mac | 富士 z13 60° パン | | | | | |
| Mac | 東京駅 z16.5 55° パン | | | | | 既知＝apply 4ms 超 9〜11 回（perf plan §8） |
| iPhone（LOW_MEM） | （同 3 行） | | | | | md は classic のまま＝Phase 1 の効きだけ |

## 9. やらない事・棚

- **WASM で earcut／mergeTiles**（`perf plan.md` §10 の判断のまま＝P2 が merge を消す・earcut は「頻度×小ペイロード」の罠）。
- **earcut の差し替え**（libtess／mapbox の新実装）＝prof で 25% だが、都心の見本で測ってから。候補は「穴の無い凸・矩形の早道（建物の 8 割）」＝earcut の前に 4〜6 頂点の凸判定で扇にする小物（Phase 1 の 5 件目候補・bench の見本待ち）。
- **pre-tessellated MLT**（`tile-formats` の `poly_*_tes` 見本＝三角形を持つ MLT）＝自前配信（ortho-data・PMTiles）の源だけ earcut を飛ばせる。GSI の MVT には効かない＝源を自前化する時の選択肢として棚。
- multi-draw-indirect（Chrome の実験機能）・GL2 への性能投資（1:1 の写しだけ）・サーバー側の焼き。

## 10. 裁定待ち一覧

| # | 項目 | 選択肢 | 推奨 |
|---|---|---|---|
| 1 | 着手順 | Phase 1 → 2 → 3／Phase 2 を先に | **1 → 2**（1 は 2〜3 日で体感に効き、2 の計器を磨く） |
| 2 | Phase 2 LOW_MEM | classic 維持／全端末 md | classic 維持（`perf plan.md` 裁定 #2 と同じ） |
| 3 | Phase 2 fade | 落とす／タイル α | 落とす |
| 4 | Phase 3 の着手 | 互換スレッドの式分類を待つ／本計画で分類も決める | **待つ**（二重設計を避ける） |
| 5 | §3.2 の 2D 判定 | 地形の有無で再ビルド／線を 2 系統持つ | 再ビルド（稀・setStyle と同じ道） |
| 6 | §3.4 注記の切り離し | Phase 1 で先に／注記 GPU 化スレッドに委ねる | **先方に委ねる**（入口の形は先方が決める・本計画は依存を明記するだけ） |
