# 描画の速さの俯瞰（WebGPU バックエンド・2026-09-26）

位置づけ：`webgpu port.md`（移植の設計・轍）と `fallback-ladder.md`（端末ティア・jetsam）の姉妹編。
「1 フレームの時間がどこに溶けているか」の地図と、伸びしろの序列。**実施の手順・門・計測は `perf plan.md`**。
読んだ版＝main 432042e4（PR #61 マージ直後・AO 桁落ち根治後）。数値は静的読解による**見立て**（桁の目安）で、
実測は plan の Phase 0 で置き換える。着手は本人裁定「他の件が片付き次第」。

## 0. 結論（3 行）

- **フレームは GPU 律速。** render worker の毎フレーム JS（cameraState・UBO 詰め・bind group 選択）は sub-ms。
  bind group／UBO／パイプラインはキャッシュ済み＝発行側に削る物は無い（?perf=1 の map/gint の CPU 発行時間がそれ）。
- **伸びしろは 4 つに集中**：①描画スレッドに残った CPU ループ（標高セルの再標本化と f16 変換）②classic merge の
  全量再アップロード＋180ms 二重描き③線の 6 頂点展開（index 無し）④地形メッシュの一律密度（チルトで微小三角形の海）。
- **WASM はフレームレートに効かない。** 効くのは「データを絵にする前の変換」で、実測で重いと分かっているのは
  GeoJSON→gint topology の 1 箇所。それも「配置（uint32＋typed-array hash）が先、WASM は次」。

## 1. フレームの解剖（WebGPU・1 フレームの順）

| 段 | パス | 中身 | 費用の性格 |
|---|---|---|---|
| 0 | 地面アトラス合成（鍵が変わった時だけ・別エンコーダ） | 3〜4 窓（2048²×2＋1024²×2）にラスタ→塗り→gint 面→ラスタ重ね→genMips | 鍵＝窓スナップ（半幅の 1/4 刻み）・rasterRev・**sceneRev**。3D では setScene ごとに sceneRev++＝シーン差し替えの都度 3〜4 窓を焼き直す。genMips は level ごとに bind group を作り直す（小物） |
| 1 | 影の深度（`shadow.on` の時だけ） | 2048² depth32float | 既定 off |
| 2 | **main** | 星空→globe（フルスクリーン raycast・大気は旗）→terrain（近＋遠の 2 回・各 (G−1)²×2 三角形）→等高線→wdepr/湖→base/main の fill/line（層ごと 1 draw・fade 中は旧＋新で 2 倍）→overlay→建物押し出し→gintBld→メッシュ（バッチごと dynamic offset）→夜面 | GPU の本体。3D は terrain と塗り/線のドレープ VS が重い |
| 3 | AO（`fx.ao` の時だけ） | 半解像度 4 パス | 既定 off |
| 4 | gint idfill（paint 時） | 別 attachment（rgba32float） | |
| 5 | **gint main** | loadOp:load で色と深度ステンシルを持ち込む→塗り扇（3 頂点/辺）→cover→線（6 頂点/辺・可視 run ごと draw）→隠線→点→ハイライト | **TBDR ではここが色＋深度ステンシルの store/load 1 往復**（main の end と gint の begin） |
| 6 | resolve（4x の時） | 静止の 1 枚だけ | 遷移時AA で解決済み（`fallback-ladder.md` §6） |

UBO の書き込みは frame 5 slot＋param＋globe＋sky＋plBatch＋overlay＋gint gf/gp＋AO ≈ 15 本/フレーム＝軽い。

**地形メッシュの実数（G=1536・desktop）**：頂点 2.36M・index 14.1M（u32・56MB）・三角形 4.7M。遠景パスは同じ格子を 2 度目に描く
（近窓の内側は FS で discard）＝チルト×深ズームでは頂点 4.7M・三角形 9.4M/フレーム。lowMem は G=1024（それぞれ 4/9）。

## 2. CPU 側の地図（どのスレッドで何が回るか）

| 処理 | スレッド | 頻度 | 規模 | 評価 |
|---|---|---|---|---|
| `mergeTiles`（scene.js） | scene worker | 可視タイル集合が変わるたび | 可視全タイルの typed array を結合（数 MB・座標に +ox） | 見えない代わりに**到着が遅れる**。40 枚中 1 枚変わっても全量やり直し。P2 で消える |
| `setScene`＝全層 makeBuf（gpu/renderer.js） | **render worker** | merge 到着ごと（1 件/フレーム） | 層数×（createBuffer＋writeBuffer）・数 MB | **描画スレッドの引っ掛かり**。uploadSkip=2 で EMA からは隠しているが目には見える |
| `downsampleFlipped`（elevation.js） | **render worker** | 標高セル到着ごと | N²（512²〜1024²）バイリニア・閉包呼び出し | 1 セル 10ms 級の見立て |
| `f32ToF16`（gpu/renderer.js） | **render worker** | 同上 | N² ビット演算 | 1 セル 3〜4ms 級。GL 経路には無い（texImage2D がドライバ変換） |
| `cropResample`／`cell90`（terrain.js） | **render worker** | 混成 R01・世界帯 | 同規模 | 同上 |
| gint `bakeBase`/`bakeTier` | gintbakeworker（bake-ahead） | 層の搭載時 | 辺数に線形 | **既に別スレッド**（同期経路 `set()` だけ render worker） |
| tile decode＋earcut＋線の細分（decode.js/build.js） | tile worker ×4 | タイルごと | 数十 ms | 並列で隠れる。`llInto` が頂点ごとに exp＋atan（行 LUT で置ける小物） |
| PLATEAU 復元（meshdecode.js/meshq.js） | mesh worker | 区の復元時 | 百万頂点 | Draco は WASM 済。面 dedup は Map＋BigInt キー、weld は typed hash。R2 焼き（PLQ）が主経路になり生経路は稀 |
| altpbf decode（altpbf/format.js） | elevation worker | タイルごと | R10 2400²＝21ms（実測済） | 直書き＋native inflate＝済 |
| **GeoJSON→gint topology**（geopbf/extension/topology.js） | geopbf worker | ファイル投入・census 集計 | 15.67M 頂点で 12.3s（2026-07 実測）・55% が BigInt Map の dedup・20% が BigInt unpack | **唯一の WASM／配置案件** |
| labels `collide`（labels2d.js） | render worker | 150ms ごと | ラベル数² 級 | 未計測・体感問題なし |

## 3. 伸びしろの序列（価値＝効き×場面の広さ÷リスク）

| 順 | 項目 | 効く場面 | 見立て | 手間 | 確度 |
|---|---|---|---|---|---|
| 1 | 標高セルの再標本化と f16 変換を描画スレッドから外す | 3D の着地・深ズームのパン（全端末） | セル到着ごとの引っ掛かり 10〜20ms が消える | 小→中 | 高 |
| 2 | タイル GPU 常駐プール＋render bundle（性能パス B） | z14+ のパン/ズーム全般 | シーン差し替えごとの MB 級再アップロードと 180ms 二重描きが消える・merge の CPU も消える | 大 | 中。**要計測** |
| 3 | 線の 6 頂点を index で 4 頂点に | gint 海岸線・基図の線が支配する全ビュー | 頂点シェーダ回数 1/3 減 | 小 | 高 |
| 4 | 地形メッシュの距離適応 LOD とチャンク刈り | チルト 3D 全般 | 頂点と微小三角形が数倍減 | 中 | 中〜高（`?gmax=` で天井を先に測る） |
| 5 | topology の uint32 化＋dedup の typed hash／WASM | ファイル投入・census 集計 | 変換 2 倍前後・上振れで半分超 | 中 | 高（実測済） |
| 6 | gndMix0 の早期 return（GL と対等化） | 2D の塗り全部 | 画素あたり標本 4 本減 | 極小 | 高 |
| 7 | main と gint のパス統合 | モバイル TBDR | 色＋深度ステンシルの store/load 1 往復減 | 中 | 中 |

### 3.1 標高セルのループが描画スレッドに居る
`terrain.js` の `downsampleFlipped(...)`→`renderer.set("elevCell")`→`writeCell` の `f32ToF16` は、どちらもセル 1 枚で百万回級の JS ループを
**render worker** で回す。標高 worker（`elevation/worker.js`）は Int16 の復号までしか担っていない。
処方の段：(0) `Float16Array` が使える環境は変換が native＝ループ 1 本消える／再標本化と半精度化を 1 ループに融合。
(1) 生 Int16 タイルを r16sint で上げ、GPU が atlas のセル矩形へ再標本化（downsampleFlipped と同じ規約：texel 中心・縁 M=2 の除外・異常値 0・負値 0・row0=南）
＝CPU ループ自体が無くなる。両バックエンド共通（GL は R16F FBO）。詳細は plan §2。

### 3.2 classic merge の費用は 3 段
①scene worker の全タイル再結合（`sceneworker.js` の mergeTiles 分岐）②render worker の `setScene`＝全層 createBuffer＋writeBuffer
③その後 `FADE_MS`=180ms のクロスフェード＝塗り・線を旧＋新で二重描き。40 枚中 1 枚変わっても全部やり直す。
WebGPU に multiDraw は無いが、タイルごとの `drawIndexed` に **firstInstance＝タイル番号**を運び、原点は storage buffer で引き、
その列を **render bundle** に 1 回記録して毎フレーム `executeBundles`＝CPU 発行ゼロ。scene worker のアロケータ（free-list・pendingFree・
grow/up/dl の FIFO）は GL md のまま流用できる（renderer 側の `mdGrow/mdUp/mdScene` が IGNORE 止まりなのを実装する）。
⚠「md 不在のメモリ優位」が WebGPU 既定の決め手だった（`webgpu port.md` A/B 計測）＝プールは eviction 前提・高水位を縮める設計が条件。
LOW_MEM は classic のまま（GL と同じ既定 OFF）が第一候補＝**本人裁定**。measure-first の掟（`webgpu port.md` 次の道順）どおり Phase 0 の数字で go/no-go。

### 3.3 線は index 無しの 6 頂点で描いている
gint の `pass.draw(cnt*6, …)`（`gpu/gint.js`）と基図の `pass.draw(6, count)`（`gpu/renderer.js` LINE）は、辺 1 本につき頂点シェーダを 6 回走らせる。
gint の VS は Morton 復号・RTE・投影・標高ドレープを**両端点ぶん毎回**やる重い本体で、ストレージ経路の実測（10.15→5.87ms・VS 律速）が示す通り
ここが海岸線ビューの支配項。固定パターン `[0,1,2,0,2,3]` の index で `drawIndexed` にすれば頂点は 4 個＝post-transform cache が残り 2 個を拾う。
GL も `drawElementsInstanced` で同型＝両バックエンド 1:1 を保てる。**次段**（本計画の外）＝可視 run の arc 頂点を compute で 1 回だけ投影し VS は 2 回読むだけ
（各 arc 頂点は今 2 辺×6＝12 回投影されている）。snap（前方スナップ）と細分（サブ端点は idx を持たない）の絡みで段を分ける。

### 3.4 地形メッシュは近窓の内側で一律
`terrain.drawIndexed(terrain.count)` は毎 3D フレームで 4.7M 三角形（遠景パスで 2 度目）。近窓は視野に合わせて決まる（108 回 unproject の投票）ので、
チルトでは視野の遠方が 1px 未満の三角形の海になり、ラスタライザとフラグメント（terrain FS＝elev 3 回＋gndMix 4 本＋気候）が無駄に回る。
処方：単位格子は据え置き、index buffer をチャンク別（16×16）に持ち、①視錐台の外のチャンクを描かない②遠景パスは近窓に含まれるチャンクを丸ごと飛ばす
③チャンクごとに段（1/1・1/2・1/4）を選び、境界の頂点は VS で粗い側の格子へスナップ（CDLOD 流＝縫い index 変種を持たない・gap 無しの掟を守る）。
天井は `?gmax=768` で先に測れる（三角形 1/4＝LOD が取り得る上限の目安）。

### 3.5 WASM が本当に効く唯一の箇所
ブラウザ内の GeoJSON→GeoPBF gint 変換（`geopbf/extension/topology.js`）。2026-07 の実測＝15.67M 頂点で 12.3s、55% が BigInt Map の頂点帳簿（dedup）、
20% が BigInt unpack、WASM の簡略化（Visvalingam）と交点検出は既に床。処方は引き出しの案どおり「中盤 uint32 化＋typed-array 開番地 hash
（`meshq.js` の `uniqueVerts` が社内の手本）→ 足りなければ i64 dedup を Rust へ」。census2020 の `aggregate.js`／maff 読み込み／ファイル投入／
geoedit の体感に直結する。着手は本人裁定「バグ収束後」（正しさの基準線があってはじめて表現差し替えの挙動不変を確認できる）。

### 3.6 地面アトラス無しでも 4 枚標本化している
`wgsl.js` の `gndMix0` は uniformity を理由に無条件で 4 本 `textureSample` してから `GD0.p.x<0.5` で捨てる。
**GL 側の `gndMix` は先頭で `if (u_gndN < 0.5) return col;`**＝WebGPU だけが払っている。WGSL の一様性解析は `var<uniform>` の値を一様と扱うので、
先頭の早期 return は合法（`discard` は demote 意味論＝影響なし）。2D 平面の塗りは重なりが多く、画素あたり 4 本が丸ごと消える。門＝t-wgsl のコンパイル。

### 3.7 パスの継ぎ目
main パスを閉じ（`gpu/renderer.js` の `pass.end()`）、gint が `loadOp:"load"` で開き直す（`gpu/gint.js`）。タイル型 GPU ではこの継ぎ目が
色＋深度ステンシルの store/load＝1x で W×H×8B 級を 2 回。AO off の既定なら 1 パスに畳めるが、timestamp の map/gint 分離を失う＝?perf=1 の時だけ分ける形。
idfill（別 attachment）は main の前に別エンコーダで積めば順序は queue が守る。

## 4. 調べて白だった所（無駄でない物）

- bind group／UBO／パイプライン：層・役割・sampleCount ごとにキャッシュ済み（`texBG`/`auxGroup`/`buildMaskBG`/`pipesFor`）。毎フレーム生成は無い。
- MSAA：遷移時AA（遷移 1x・静止 4x 1 枚）で固定費は既に消えている。
- AO／影／大気／PBR：既定 off。off の時の追加費用はゼロ（分岐は uniform・資源は点灯時だけ確保）。
- 標高アトラスの窓替え：単位格子＋uniform 窓＝再確保なし（済・75MB 再確保の根治）。
- overlay／PLATEAU の per-scene・per-batch uniform：dynamic offset＝pass 内の UBO 書換なし。
- メッシュの可視判定 CPU（`meshBboxVisible`）：500 バッチ×5 投影＝0.2ms 級。
- 動的解像度の canvas リサイズ：白抜けは「描画フレーム先頭で適用」で無害化済み。中間ターゲット化は今は不要。

## 5. WASM の判断（候補ごと）

原則（本人の cost model）：境界跨ぎはタダ・高いのは memcpy×頻度と BigInt で取り出すこと・データは WASM メモリに住ませ JS は uint32 の窓で見る。

| 候補 | 判断 | 理由 |
|---|---|---|
| フレームループ（render worker） | **入れない** | 毎フレーム JS は sub-ms。置き換える物が無い |
| 標高セルの再標本化／f16 | **WASM でなく置き場所**（→§3.1） | 描画スレッドに居るのが罪。3 倍速くしても引っ掛かりは残る。worker か GPU へ |
| `mergeTiles` | **やらない** | typed array の memcpy 級ループ＝WASM で 1.5 倍が上限。P2 が merge 自体を消す |
| tile worker の earcut／線の細分 | **やらない** | ポリゴン単位の小さな呼び出しは「頻度×小ペイロード」の罠。タイル全体の WASM 化は式エンジンの二重管理。安い JS 改善（`llInto` の行 LUT）はある |
| PLATEAU 生経路の面 dedup（`vkeyBig`/`triKey`） | **JS の typed hash で足りる** | `weldMesh` と同じ薬。R2 焼きが主経路の今は優先度低 |
| gint bake／altpbf decode | **済** | bake は別 worker、decode は native inflate＋直書き |
| **GeoJSON→gint topology** | **唯一の本命**（→§3.5） | 実測で 75% が BigInt／Map の税。配置（uint32＋typed hash）が先、i64 dedup の Rust 化が次 |
| GeoParquet の zstd 列 | 保留 | ブラウザに zstd が無く注入口のみ。WASM zstd は投入頻度が低く価値小 |

## 6. この俯瞰の限界

全て静的読解。「1 セル 10ms」「setScene 数 ms」は桁の目安であり、端末・ビュー・回線で動く。`ema` は 60fps 機で 16.7ms に飽和して差が出ない（`webgpu port.md` A/B 計測の轍）ので、
物差しは timestamp-query の gpuMap/gpuGint と、Phase 0 で足す引っ掛かりログ。数字が出たら §3 の表を更新する。
