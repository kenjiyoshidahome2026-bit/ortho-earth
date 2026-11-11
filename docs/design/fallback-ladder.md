# fallback ladder — バックエンド選択・端末ティア・jetsam 防衛の台帳

「どの環境で・何が・どう落ちて・どこへ着地するか」の正典。**ノブの値や判定を変えたらこの台帳も更新する**。
姉妹編：`docs/design/webgpu-port.md`（WebGPU 移植の設計・轍）。最終更新 2026-09-29（§6 リアルタイムの影）。

## 1. バックエンド選択（`packages/globe/src/globe.ts` の `gpuBackend`）

起動時の決定順序（上から先勝ち）：

| 条件 | 着地 | 意図 |
|---|---|---|
| `?gl2=1`（`forceGl2`） | WebGL2 強制 | 手動逃げ道。虚時間ハーネス（verify:ui）もこれ固定＝WebGPU の実時間 async init と `--virtual-time-budget` は両立しない |
| `?gpu=1` | WebGPU 強制 | **Android ゲートも nogpu 印も突破**＝診断・将来の再評価の入口 |
| `navigator.gpu` なし | WebGL2 直結 | iOS≤18（XS級）・旧ブラウザ。dynamic import もリレー迂回も発生しない＝従来と完全同一経路 |
| Android（`IS_ANDROID`＝UA or userAgentData） | WebGL2 | **2026-08-03 本人裁定＝高級機含め一律封印**。根拠：入門実機で「遷移中に基図だけ黒」（?gl2=1 正常＝WebGPU 経路確定・エラー無しの沈黙故障・Mac 再現せず）。外部調査＝Adreno/Mali Vulkan の黒画面バグ族・最有力の正しさバグ（Adreno 830 非決定化け）は**フラッグシップ報告**＝高級機なら安全は不成立。GL2 で失うものは Android では計測上ない。⚠デスクトップモード偽装 UA は素通り（稀・許容） |
| `oj.nogpu` 印（sessionStorage） | WebGL2 | 前回 present 検証に失敗した環境＝タブセッション固定（タブを閉じると再試行） |
| それ以外 | **WebGPU 既定** | 2026-08-02 裁定「デフォルト gpu・低級機は我慢」。決め手＝メモリ（md プール不在で 3GB 機の走行距離が伸びる実測）。iOS26+ は実機検証済み |

**封印は解決ではない（Android）**：再評価の入口＝`?gpu=1&msaa=0` の実機確認（マルチパス MSAA 根因説の白黒）→
白なら「Android は MSAA off で WebGPU 復帰」という一律 GL2 より軽い選択肢。crbug 報告・Dawn の Android 成熟が合図。
追記（2026-08-19）：デスクトップ `?perf=1` 実測でも MSAA の store/load/resolve が WebGPU フレーム最大の固定費と
確定＝既定を**遷移時AA**（下記 §6）へ。Android 復帰の第一候補も「遷移時AA のまま」＝MSAA パスを踏むのは静止の一枚だけ。

## 2. WebGPU の落ち網（3枚）

1. **worker 内 adapter/初期化失敗** → GL2 自動フォールバック（挙動同一・main へは透明）
2. **present 沈黙故障** → frame1 後に placeholder 画素を読み戻して検証、失敗なら `oj.nogpu`＋reload
   （「初期化成功なのに絵が出ない」環境＝iOS Safari で実在した系）
3. **frame1 20秒不達** → `oj.nogpu`＋GL2 で再起動（遅い回線のコールドブート実測から）

補助：WGSL compile 失敗・init/初回フレームの errorScope・worker error/unhandledrejection→main 転写（drawErr）。
GL2 フォールバック×LOW_MEM は maxact=1 の安全モード（旧 iOS XR級 3GB の常駐天井保護・`?maxact=2` が戻し口）。

## 3. WebGL2 の落ち網

- **`transferControlToOffscreen` 欠落** → 「表示できません」案内（非対応の唯一確実な判別器）
- **webgl2 probe null** → 「GPU の応答を待っています…」で 1秒×10回リトライ（GPU プロセス OOM 再起動直後の
  誤診対策＝M1 実機で実在）→ 復帰すればリロード無しで続行、駄目なら紙色 fatal＋再読み込みボタン
- **contextlost** → 1秒猶予 → 黙って1回だけ reload → 上の probe リトライが受ける（二段の保険）
- **WebGPU device lost** → contextlost と同経路（renderer.lost 配線済み・**実発火は未検証**）

iOS 特有：WebGPU 構成の worker への直結 postMessage が死ぬ轍 → 制御は ctrlPort（MessageChannel）常用＋
iOS 判定（iPadOS の Mac 偽装込み）×gpu 時は生存経路リレー（page→scene worker→scenePort→render worker）。`?relay=1`＝他環境検証用。

## 3.5 crossOriginIsolated（COOP/COEP）— **必須ではない**

`Cross-Origin-Opener-Policy: same-origin` ＋ `Cross-Origin-Embedder-Policy: credentialless` は
**SharedArrayBuffer の点火条件**であって、動作要件ではない。SAB の用途はただ一つ＝GintBUF を
render/gint worker へ**ゼロコピー**で渡すこと（`SharedArrayBuffer` の参照は全リポジトリで
`geopbf/src/pbf.js` の1箇所のみ）。

| | COI あり（自前配信） | COI なし（第三者ページへの埋め込み） |
|---|---|---|
| `SharedArrayBuffer` | 有 | 無（Chrome は未定義になる＝実測） |
| GintBUF の受け渡し | ゼロコピー | `buf.slice(0)`＋structured clone のコピー1回 |
| 機能 | — | **差は無い**（描画・LOD・識別・tier・swap・深度・ドレープ すべて同値） |

**実測**（2026-08-19・`apps/ortho-japan` で `npm run verify:nocoi`）：`NOCOI=1` で vite の COI ミドルウェアを
外し、CDP 実時間で 7 ページ。`coi=false SAB=false` を自分で検定した上で
t-nocoi（GeoJSON→GeoPBF→gint 復号→点in面）／t-gintembed／t-gintlod／t-gintswap／t-gintdepth／t-opts／t-gadgets が全て PASS。
器は `ArrayBuffer`（フォールバック側）であることも検定に含む＝「SAB が生きていて経路を踏んでいない」偽の緑を弾く。

裏付けは実測より前からある：**Safari は COEP:credentialless を認識せず crossOriginIsolated が立たない**＝
iPhone/Mac Safari は最初からこの世界で動いている（フォールバックはその事故対応で入った＝コミット 2697ac7）。

**なぜ台帳に載せるか**＝SDK 化（開発者向け埋め込み）の可否を決める一点だから。埋め込み先のページに COEP を
要求することは実質できない（COEP はホスト側の他の埋め込み——広告・動画・解析——を軒並み壊す）。
「COI があれば速い、無くても動く」が正しい言い方で、**自前配信では引き続き2ヘッダを刻む**（コピー1回が消える）。
旧コメント「この2ヘッダが無いと worker 全滅→黒画面」は誤り＝2026-08-19 に各 deploy-worker.js / vite.config.js を訂正済み。

## 4. 端末ティア（3段）

| ティア | 判定（app.js） | 実像 |
|---|---|---|
| **LOW_MEM** | `deviceMemory ≤ 4`、無い環境（iOS Safari）はタッチで代用 | スマホ帯・iPhone 全機。基準機 4GB 実機（タブ予算は 8GB 機の ~1.4GB より小） |
| **MID_TIER**（2026-08-03 新設） | 非 LOW_MEM かつ：モバイル（coarse×タッチ＝**deviceMemory=8 で LOW_MEM を素通りする 8GB スマホ層**）／4コア以下／内蔵GPU（`UNMASKED_RENDERER_WEBGL`＝Intel 非Arc・AMD APU/Vega・ソフトラスタ。probe の使い捨てコンテキストに相乗り）。`?mid=1`/`?mid=0` が戻し口 | 非力 Windows（i7/16GB/HD Graphics/HDD のコールド PLATEAU 落ちが起源）・8GB Android・旧ノート |
| デスクトップ | 上記以外（**判定不能は安全側＝ここ**＝回帰を出さない） | Apple 16GB ユニファイド機で調律した既定値 |

教訓：**Chrome の deviceMemory は 8 が上限＝16GB 機も 64GB 機も 8**＝RAM では非力機を見抜けない。
GPU の素性で見る（Apple 以外の内蔵GPU は VRAM がシステム RAM の取り分＝常駐・過渡と同じ財布）。

## 5. PLATEAU のメモリ天井（ティア別ノブ）

| ノブ | LOW_MEM | MID_TIER | デスクトップ | 備考 |
|---|---|---|---|---|
| 同時表示区 `PLATEAU_MAX_ACTIVE` | gpu:2 / gl2:1 | 2 | 4 | 4=被覆マスクのシェーダ上限。`?maxact=N` |
| 橋梁枠 `PLATEAU_EXTRA_ACTIVE` | 1 | 2 | 4 | noMask＝マスクスロット不使用の別勘定 |
| GPU常駐予算 `PLATEAU_RESIDENT_BYTES` | 0（即削除） | 0.5GB | 1.2GB | バイト LRU・ack 実測（`meshBytes`）で数える。表示中は守る |
| worker 本数 `PLATEAU_NW` | 1 | 2 | min(4, コア−1) | loaders.gl の起動ベースライン×人数分がコールドの山に直乗り |
| 同時ロード `PLATEAU_LOAD_MAX`（9/8・旧 bldCap） | 2 | 3 | 3 | 待ち行列制（本人指定「最大 3・後は待ち行列」）。視界離脱＝即キャンセル（部分は保存済＝再訪で続きから）・slow 在庫/fast ローテーション廃止。デモ先読み中は−1。`?loadmax=N` |
| worker内RAMキャッシュ `CACHE_MAX` | 0 | 0 | **1区**（8/3 に 2→1） | OPFS 二層化以前の遺物＝三重化（RAM cache×GPU常駐×OPFS）の解消。⚠cache を持つ構成はロード中 `keep[]` が区全量を積む＝コールドピークの主因 |
| バッチ/並行fetch | 8枚/4本 | 32/8 | 32/8 | lowMem＝IDB commit バースト・送信粒度も半減 |
| タイル予算 `?tbudget` | 24MB | auto | auto | |
| 表示の世界の形（#43・9/28 本人裁定 B） | 球 | 球 | **WGS84 楕円体** | boot/tier.js `ellipsoidMode`＝URL（`?ell=1`／`?ell=0`）› `opts.ellipsoid` › 自動。計測は全ティアで常に WGS84。楕円体は GPU 約1割の固定費・PLATEAU は `#ell` の別鍵（R2 に全区の楕円体の焼きあり） |
| 消灯線 `PLATEAU_OFF_Z` | 15（=AUTO_Z） | 14 | 14 | **z≤14 は実メッシュも遠景箱も出さない**（本人裁定 9/8「潔く」）。`?pazoff=N`。保持のヒステリシスは 14〜15 の 1 段だけ・常駐（VRAM）は触らない |

過渡の防波堤（ティア共通）：
- **クレジット制**（`CREDIT_MAX=2`）＝render worker の消化 ack 待ち＝mesh 送出の滞留を数十MBで頭打ち
- **OPFS 二層＋streaming 復元**＝読む→送る→手放す（温読了時ピーク根治・iPhone XS「読み終えた瞬間に落ちる」対策）
- QuotaExceeded → 最古区を緊急退避して1回だけ再試行 → 駄目なら以後書かず**表示は継続**（idbFail）
- fast枠 60秒ローテーション（巨大区×低速APIの飢餓対策・LOW_MEM は無し＝in-flight 在庫を増やさない）
- 遠方離脱 0.5deg で本削除・視界外は非表示常駐（LOW_MEM は常駐なし）

**R2 焼き＝第三の入口（2026-09-07）**：`scripts/bake-plateau.mjs` が全セットを Node で同じ decodeBatch に通し、量子化形式 PLQ1
（`plateauq.js`＝pos u16 差分 varint・nrm i8×3・idx 暗黙＝typed array の約 19%、gzip 後）を R2 `GIS/plateau/v{DECODE_VER}/{slug}/`
（球）と `…/ell/`（楕円体）へ置く。plateauworker は OPFS/IDB → **R2 焼き** → MLIT 生経路の順＝焼きがある区は **Draco もデコード過渡
（数百MB〜GB級）も無い**（港区級のコールド 40〜50秒→数秒）。無い/版違い/壊れ＝タイル粒度で生経路へ（焼きは加速器・生経路が正）。
ノブ：`?nobake=1`（封印・A/B）・`?bake=URL`（置き場差し替え＝ローカル焼きの検証）。ティア別の値は無い（全ティア共通）。
保存キーは球＝`{base}`・楕円体＝`{base}#ell`＝両モードの焼きが並存（?ell 切替で焼き直さない・LRU 予算は共通台帳）。
**頂点溶接**（`plateauq.weldMesh`・2026-09-07）＝位置+法線一致の頂点を束ねる（箱 36→24・実測 4〜5 割減）。焼き（packPLQ）と生経路（decodeBatch 末尾・1mm 格子）の両方＝GPU 常駐バイト・IDB/OPFS・PLQ（gzip 後 3 割減）が一緒に減る。描画結果は同一。
**PLQ2 角柱（底面＋高さ）**＝箱の建物を底面リング（1cm・頂点ごとの天高さ）＋高さで持ち復元時に押し出す（GPU 上は溶接メッシュと同じ・転送と OPFS/IDB が箱の区で 1/3〜1/4）。`bake-plateau --repack`（詰め直し）・`--stats`（角柱率＝plateau-bake-out/stats.json）。

## 6. PLATEAU 以外の jetsam 装備（iOS 三部作の現在形）

- **md（multi_draw タイル常駐プール）＝LOW_MEM 既定 OFF**（`?md=1` 戻し口）。iOS は WebGL バッファが
  WebContent プロセス＝タブ予算に直乗りする会計の教訓（iPhone 16 Pro 実機 A/B で確定）。
  WebGPU バックエンドは md 自体が無い（classic merge 恒常）＝構造的メモリ優位
- R10 タイルキャッシュ 256MB LRU（LOW_MEM 64MB）・R90 先読みスキップ（2026-09-18 から全球アトラス WORLD1024_1＝16MB 常駐は LOW_MEM でも先読み・アトラス不在時の R90 8 枚退避だけ見送り）・pagehide→destroy（reload 二重居住半減）
- 標高：R16F アトラス（GPU半減）・単位格子メッシュ（窓替え 75MB 再確保の根絶）・混成R01 全端末ON（`?nor01=1` 逃げ道）
- 動的解像度＋GPU格付け＝gpuEmaRaw（30Hz モニタの壁時計の罠回避）。WebGPU も timestamp-query で同じ給餌口（tqFeed）
- **遷移時AA（WebGPU 既定・2026-08-19）**：カメラ遷移・アニメ継続中は 1x 直描き（MSAA の store/load/resolve を
  フレームから消す）、静止 500ms（RES_SETTLE_MS と同時計）で 4x 品質フレームを1枚。**時計で動く間も 1x（#125・2026-09-29）**＝影の時刻の送り
  （set shadow）・時計の基準（set clock）・オーバーレイへの毎フレームの状態（overlayMsg＝地震の再生）が 500ms 以内に届いている間、
  およびオーバーレイの続き（衛星）・時計の早送り（星空）の自前継続は「動いている」＝カメラ移動と同じ 1x。タイル到着等の set は従来どおり静止扱い（4x）。
  影の時刻の再生で本体パスが 2 倍（gpuMap 10→21ms・38fps）になっていたのはこの穴。門＝japan t-aatime。1x 遷移で busyMs が下がる＝
  動的解像度の降段も実測で消える（ぼやけ対策を兼ねる）。パイプラインは sampleCount 焼き込み＝1x/4x セット取替
  （renderer/gint とも遅延生成キャッシュ）。ノブ＝`?msaa=0` 常時1x／`?msaa=1` 常時4x固定（旧挙動・A/B用）。
  GL2 は context 生成時 antialias 固定＝対象外。LOW_MEM は従来どおり既定 1x（変化なし）
- **描画の質の旗（#46・2026-09-26）**：大気散乱・PBR と環境光・AO＝**ell と同じ作法で既定は全端末で 0**（本人裁定 2026-09-26）。
  URL の `?atmosphere=1`／`?pbr=1`／`?ao=1` で点ける（`=0` で切る・opts より強い）。`opts.render { atmosphere, pbr, ao }: true` は組み込みの口。
  裁くのは `boot/tier.js renderFx`（純関数・t-tier）。WebGPU だけが読む（GL2 は実装を持たない＝旗が立っても絵は変わらない）。
  段 1（大気散乱）＝`GLOBE` パス・全球ハイプソの帯だけ・調律ノブ `view.atmScale`（帯の幅 k＝4）/`atmSun`/`atmExposure`/`atmGround`。段 2（PBR）＝模型（GGX＋法線/AO/発光テクスチャ）と
  素の建物メッシュ（拡散だけ）を太陽＋空の SH9 で照らす・夜は固定光・`view.pbrFill`（昼でも固定光を混ぜる割合＝0.35＝陰の壁の読みやすさ）。押し出し建物（法線なし）は対象外。
  段 3（AO）＝チルトした 3D の時だけ main パスの後に 4 パス（半解像度 AO・ぼかし縦横・深度を見て戻す乗算合成）。入口はチルト 0.02→0.10 rad でフェード。半解像度 rgba8 が 2 枚（R＝AO・GB＝深度・計 2·W·H B）。`view.aoStrength`（0.6＝#63 本人裁定 2026-09-29・見比べ帳＝東京駅 z16〜18 と山地 z11 の正午/夕方で 0.5/0.6/0.7 と半径 10/15% を実 GPU で並べた。0.7 は密集した低層街区が汚れて見え、半径 15% は差が小さい＝10% のまま）/`aoRadius`（視距離の 10%・20〜400m）/`aoBias`（接平面の sin の下駄 0.15）。地平線型（8 方向×4 歩・回しとジッタは 4×4 の Bayer 周期・縦横 7 点（(0.5,1,1,1,0.5)⊛(1,2,1)）の深度重みぼかしで周期の模様を消す）。
  **精度の掟（2026-09-26・実機の縦縞とまだら＝動くと泳ぐの根治）**：位置の復元に f32 の桁落ちを入れない。視線は invMvp から戻さず CPU（f64）の基底 `aoRays`（近平面が浅いと invMvp の要素は 7 万台＝視線が 1〜4 画素のノコギリ波）・対数深度の逆は expm1（exp2−1 は w を 0.76m 刻みに量子化）・球の床は c/(−b＋√h)。門＝t-ao（平らな板が暗くならない・位相とズーム 0.0005 の揺れ 0.015% 未満）。
  **全画面レイキャストも同じ掟（#65・2026-09-27）**：球の床（globe fs）・海面下（wdepr）・経緯線・等高線・夜面の視線は `camera.js viewRays`（＝`aoRays` の正本）の f64 基底を uniform（`rayF/rayX/rayY/eyeC`＝旧 invMvp の枠）で受け、交点は t＝2c/(−b＋√h)（c＝|E|²−1 は CPU f64）。
  さらに床の uv は**絶対の経緯度を経ない**：f32 の 139° は 1.5e-5°＝1.4 m 刻み＝z17.5 で 3〜4 画素の鋸歯（頂点パスは cogP/gnd の f64 前計算で既に回避していた・床だけ残っていた）。交点は原点相対 δ＝(E−O)＋t·d（f32 で mm 級）で持ち、
  δ → 経緯度の差は `deltaLL`（atan の差の恒等式＝O² の項が代数的に消える・ρ の差は s/(ρP+ρO)）、uv＝`anchorUV` の (原点の uv, 1/span)＋δll·inv。絶対の経緯度は粗い用途（ハイプソ・気候・罫線・夜面）だけ。
  門＝`tests/globe-rays.mjs`（旧式は z17.5 で 9 画素・新式 0.003 画素・deltaLL は 1 mm 以内）と t-globefloor（両バックエンド・市松の床がズーム 0.0005／bearing 1e-4 で 24 階調超の画素 1% 未満・旧 50%）。
  **深度は画素で書く（#62・2026-09-29）**：旧＝対数深度を頂点だけで書いていた＝大きな三角形の内側は深度が画面上で直線補間され（z_ndc＝log(w)/w・真は 1/w が直線）、z19 級の超近景で地形の格子（数十 m）の内側が撓み、斜めの薄い陰の帯が出た。
  今＝深度を書く本パス（地形・押し出し建物・メッシュ・模型＝main／影の受け手／断面の派生・`wgsl.js fragDepthWgsl`＝clip w を varying に運び FS で logDepthZ(w)/w を frag_depth に）全部で画素ごとに正確。
  **全パス揃えるのが条件**（地形だけ正確にすると他パスとの釣り合いが崩れて手前に別の帯が出た＝実験）。影を落とす側（CAST＝正射影）は対象外。費用＝early-Z を失う分（東京駅 z16.5・55° で gpuMap +0.4ms・山地は差なし）。逃げ道＝`?fd=0`。GL2 は従来どおり（AO を持たない）。
  **精度の掟（frag_depth 版）**：画素ごとの深度 0.5·logCoef·log2(1+w) の `1+w` を f32 で作ると w が 1.2e-7（≈0.76m）刻みに量子化され、画素ごとに書くと 0.76m の階段になる（AO が横縞の壁として見た＝実 GPU の東京駅前で手前が暗くなった）。頂点で書いていた時は頂点の間が滑らかに補間されて隠れていた。`fragDepthOf`＝log1p を級数で（AO の expm1s と対）。地形の蓋（CLIP_CAP）も同じ式に。

- **リアルタイムの影（`map.setShadows`・#112・2026-09-29）**：**WebGPU 専用**＝GL2 は持たない（9/24 裁定を 9/29 に維持・Android は全機 GL2＝影なし・WebGPU が来たら自然に出る）。
  点けている間だけ資源（深度 2048²＝16MB・LOW_MEM は 1024²＝4MB）・消すと返す（描画に一切関与しない）。窓は 1 枚（カスケードは入れない＝9/29 裁定・傾けた遠景の約 2 割は影なし・縁は丸く薄める）。
  落とす＝地形・押し出し・メッシュ・模型（MASK は α で抜く・BLEND と統計の柱は落とさない）／受ける＝gint の線・注記・オーバーレイ以外。影の間は地形の陰影の光を太陽の方位へ。
  費用（Apple M 系・60°・東京駅）＝深度パス z15 1.9〜2.3ms・z17 2.6〜3.4ms（パンと時刻の再生の時だけ・静止と回転は使い回し）。計器＝`?hud=1` の shadow 行・`?perf=1` の `gpuShadow`・`apps/ortho-japan/scripts/bench-shadow.mjs`
## 7. 計器（全部 URL フラグ・本番搭載）

| フラグ | 見えるもの |
|---|---|
| `?mem=1` | 常駐台帳＋**過渡行**（plateau worker の cache／読込中＝常駐台帳に乗らない実ピークの主役）＋peak＋4GB予算残 |
| `?drawhud=1` | 描画実績（塗り枚数・退場フラグ・fade・PLバッチ）＝**USB 不要の実機計器**。塗り0=赤字＝CPU側、枚数ありで黒=GPU側の二分 |
| `?stay=1` | 起動診断 HUD（frame1・配達カウンタ・boot 里程標。フォールバックせず留まる閲覧モード） |
| `?perf=1` | フレーム内訳（ema・gpuMap/gpuGint・aa=直近フレームの段数 1/4）＋GPU 識別。⚠ema は 60fps 機で 16.7ms 飽和＝差が出ない |
| `__perf().terr.sub` | フレームの外で GPU へ送る回数の累計（gndBake＝地面アトラスの合成・gndMip＝そのミップ生成・cellGpu＝標高セルの GPU 再標本化・cellCpu＝CPU 書き）。2026-11-07 Galaxy の滑走で地形ありだと 1 フレームあたり約 1.7 回の余分な Queue::Submit（地形なし≈1）＝何が送っているかを分ける物差し。滑走の前後で差を取る |
| 層別切り | `?nomd` `?nogint` `?noterr` `?nofade` `?msaa=0/1` `?ell=1/0` `?notq` `?noopfs` `?nor01` `?relay` `?mid=0/1` `?lowmem=0/1`（LOW_MEM の強制オフ／オン＝切り分け用・0 は 4GB 機で落ち得る） `?maxact=N` `?tbudget=N` `?atmosphere=1` `?pbr=1` `?ao=1`（#46・既定 0） |
| 建物の軽量化（LOW_MEM 既定・他は A/B ノブ） | `?bldz=N`＝基図建物の押し出し開始 z（LOW_MEM 15／他 14）・`?meshlod=N`＝画面 N px 未満の PLATEAU 建物を描かない（LOW_MEM 2／他 1・2026-11-05）・`?meshlodz=K`＝z15 より引いた分だけ PLATEAU の物差しを K 倍／段にする坂（既定 0＝坂なし。例 8＝z14.5 で √8 倍・z14 で 8 倍＝引くほど高層だけの星座へ）・`?meshrange=KM`＝注視点から KM km より遠い PLATEAU の束を描かない（LOW_MEM 2／他＝切らない・`0` で切らない）・`?bldrange=KM`＝注視点から KM km より遠い基図タイルの建物を立てない（足元の塗りは残る・tilemanager の bld:"no"・LOW_MEM 1.5／他 0＝従来・`0` で全枠立てる・2026-11-06 Galaxy 実測：z17.8・74° で 69 枚の押し出し建物 +112 MB の一括転送で main が 8〜10 秒固まった→2026-11-07 2v2 で 1.5 km が最長の GPU 待ち 4 s→0.5 s）・`?elevcheap=1/0`＝建物の頂点の標高を主アトラス 1 標本で引く（WebGPU・LOW_MEM 既定オン）・`?msplit=N`＝PLATEAU の束を高い建物から順に N 千三角形の片に小分けして送る（LOW_MEM 100／他 0＝束のまま）・`?meshshed=0`＝動的な間引きを切る（既定オン・全機種・本人裁定 2026-11-08：タブレット 2 回で動いている区間 4〜12 秒のコマ数 182/240→280/262＝約 3 割増・12 m 止めは差なし・MacBook は発動せず）：動いている間に 1 フレームが 40 ms 超（`?meshshedms=N`）なら解像度の梯子を待たず即（保持 250 ms）、 PLATEAU 建物を「高さ 6→12→24 m 未満は描かない」と段階的に強める（高い建物から残る・LOD_H の段）。`?meshshedmax=12`＝12 m の段で止める。止まると解像度と同じ時計で全部戻る＝静止の絵は不変。2026-11-08 実測：解像度の床を待つ版は発動 5.6 秒＝最重の 0〜5 秒が素通りで効かず（丸の内 236 万三角形/フレーム＝約 100 ms・24 m で 60〜97 万へ）。px の物差し（`?meshlod`）は z17.7 では ×10 でも 2〜3 m＝何も削れない（実測：meshlod=10 でコマ数不変）ので m で切る。速い端末では解像度が床に着かない＝発動しない（2026-11-08 Mali-G615 実測：丸の内→レインボーブリッジは PLATEAU の描画が 1 フレーム 86〜105 ms で解像度を落としても不変＝頂点・描画量が床）・HUD の frame 行と 30 秒ログに `shed ≥Hm`・30 秒ログに `mesh 描いた/総数 (cull 視野外 lod0) Mtri`（`__perf().meshDraw`）・`?meshlite=A`＝軽量 index（既定オフ・A/B）：面積 A m² 未満の三角形を worker の送出時に index から落とす（高さ順と lodCounts は保つ・橋梁は対象外・焼き/写し/生のどの経路でも）。実データ：0.25 m² 未満は枚数の 20〜60%・面積の 0.06〜0.2%（千代田 60%・中央 31%・港 20%）。2026-11-08 タブレット A/B：三角形 −21〜28%（0.25／0.5）でも止まった丸の内の fps は不変（10〜17）・見た目の損なし→既定にしない。切り分け（解像度 0.55 固定・各 2 回）：メッシュ非表示で 40 ms 消えるが、三角形 −56%（meshlite=4）で −20%・描画回数 −35%＋三角形 −23%（meshrange=1）で −15%＝重さは三角形数でも描画回数でもなく画素の塗り・`?meshcull=1`＝裏面をラスタライザで捨てる（既定オフ・A/B・2026-11-08）：PLATEAU の建物は巻き順が揃っていないので裏面は FS が属性法線と視線で判定して discard していた（cullMode none＝裏面の画素も毎フレームシェーダを走らせてから捨てる＝塗りの約半分が無駄・discard のある FS は Mali の早期深度/隠面除去の恩恵も薄い）。mesh worker が送出時に三角形ごとの幾何法線と頂点法線の向きを比べて逆なら 2 頂点を入れ替え（meshwind.ts・console `[mesh] wind`）、renderer は揃えた素の束だけ cullMode back の派生パイプライン（meshCull・影/断面の派生も同じ）で描く。橋梁（twoSided）・両面配信の区（noCull）・模型は従来のまま。2026-11-08 実機（タブレット・MacBook）：WebGPU の frontFace ccw はフレームバッファ座標（y 下向き）で数えるため、揃えた外向き＝"front" 側が裏面＝初版の back では建物の大半が消えた→`1`＝front に直し（`2`＝back＝逆向きの保険）。結果：見た目は無指定と同じで速さの得は無し（止めた丸の内 地図の描画 68〜70 ms＝不変）＝裏面はもう深度で先に捨てられていた。壊れた側（建物の大半が消えた）では描画 −21 ms＝残る重さは見える面の塗り（1 画素あたりのシェーダ費用と建物同士の重なり）。FS の判定は残す＝揃え漏れの保険・`?meshsort=1`＝素の建物メッシュの束を目に近い順（手前→奥）に描く（既定オフ・A/B・2026-11-08）：奥の束の画素を早期深度で捨てて重なりの塗りを減らす狙い。片は束の origin を共有するので bbox の中心と目の経緯度の距離で並べる・`?resmin=R`＝動的解像度の梯子に 0.7 より下の床の段を足す（既定 0＝足さない・2026-11-11 本人裁定「0.55 は結構汚く見える」で梯子を 1→0.85→0.7 に縮め、形を先に削る順へ組み替えた：0.7 は動いている間の建物の間引きを使い切った後だけ、解像度を下げても GPU 時間が見込み ×s² の 4 割も減らなければ一段戻して静止まで下げない（console `no help`）、0.85 に下げた後は間引きも 24 ms で進む、戻すのは 0.7→間引き→0.85 の順。`?resmin=0.55`＝旧の床・`?resmin=0.4`＝2026-11-08〜11-10 の既定。間引きの跡は `?shedfoot=0` で切れる足元の塗り（WebGPU の地面アトラス・PLATEAU の区の被覆マスクに掛かる基図の足形を建物の色 ×0.96 で焼く・間引いている間だけ）で埋める。以下は 2026-11-08 の記録：既定 0.4・全機種）：塗りが床なら画素数に比例して効くはず。`?res=0.4&resmin=0.4` で固定も可。2026-11-08 タブレット実測（解像度自動・各 2 回）：meshsort は差なし（地図の描画 68〜69 ms）、resmin=0.4 は 69→60 ms・滑走 4〜12 秒のコマ数 214→258（約 +20%・ばらつき ±20%）・滑走中はわずかに柔らかい程度・止まると 1.0 へ・MacBook は発動せず。同時試験：resmin=0.4＋meshlite=4 で 50 ms（止めた fps 13〜14→19）＝形の分と塗りの分は別々で足し算になる。ただし meshlite=4 は静止で拡大すると壊れる（丸い屋上の輪・小さな円筒が消える・低い建物に穴）、meshlite=1 は見分けがつかないが −2〜3 ms だけ・`?meshlitemove=A`＝動いている間だけの軽量 index（既定 4 m²・全機種・本人裁定 2026-11-08。`?meshlitemove=0` で切る。実測：resmin=0.4 と組で滑走 4〜12 秒のコマ数 208→295・滑走中の三角形 150〜230 万→43〜52 万・止まると形は完全に戻る・MacBook は発動せず。既定化後の無指定の実測 2026-11-08：タブレット 2 回で 4〜12 秒 301/292・滑走中 0.43〜0.46 Mtri・止まると 2.34〜2.36 Mtri の元の形、`?resmin=0&meshlitemove=0` で 176・床 0.55 止まり、MacBook は無指定で発動せず欠けなし）：mesh worker が送出時に index を「高さ段（lodCounts の区間）ごとに A m² 以上の三角形を先頭・未満を後ろ」に並べ替えて段ごとの残す数（liteCounts）を添える（GPU メモリは増えない・高さ段の prefix 意味は保つ）。renderer は間引き（meshshed）が点いている間だけ段ごとの先頭を drawIndexed（≤ 6 回/束）、止まって間引きが戻ると元の形。HUD の frame 行と 30 秒ログに `lite`・`__perf().lite`・console `[mesh] litemove`。狙い＝静止の形を壊さずに滑走中だけ meshlite=4 の −10 ms を取る・`?meshlitefs=1|2`＝動いている間だけの軽いピクセルシェーダ（既定 1・全機種・本人裁定 2026-11-08。`?meshlitefs=0` で切る。実測：タブレット交互 5 回ずつで滑走 4〜12 秒のコマ数 平均 236→294・0〜8 秒 112→142＝約 +25%・交互 3 組とも勝ち・2 は 1 と差なし・?fd=0 も 282〜285 で少し軽い・見た目は欠けも帯もなし・MacBook は発動せず）：間引き（meshshed）が点いている間だけ、巻き順を揃えた素の建物メッシュ（meshwind.ts＝このノブでも揃える）を MESH_LITE_WGSL（discard 無し・画面微分 無し・街明かり/PBR/style の光/局所光/輪郭線/Cesium の霧 無し・varying 7→2・裏面は cullMode front）で描く。`1`＝深度は画素で書く（他の層と同じ fragDepthWgsl）、`2`＝深度は頂点だけ（early-Z が戻る代わりに地形との境に帯が出うる＝#62 の掟の例外を滑走中だけ試す）。狙い＝残る重さの半分（見える面の塗り）が 1 画素あたりのシェーダ費用なら減る・画素数（タイル）が床なら減らない。橋梁（two）・両面配信の区（noCull）・模型・影/断面の派生の間と、街明かり（夜の上映＝setCityLights）が点いている間は従来＝滑走中に窓の灯りが消えない。fx.pbr／style の light の陰影は滑走中だけ固定光に戻る。パイプラインは起動の暖機（warmPipes）に含める＝最初の間引きで同期コンパイルの引っ掛かりを出さない。console `[gpu] meshlitefs=N`・HUD の frame 行と 30 秒ログに `fs`（`__perf().meshDraw.fs`）・`?meshchunk=1`＝GPU 転送を 1MB ずつ・`?bakelift=1`＝PLATEAU 建物の接地リフト（足元の地面の高さ×誇張）を転送時に CPU で頂点へ焼き、頂点シェーダの標高参照を無くす（焼いた後の誇張変更・真俯瞰の地形フェードには追従しない＝A/B 中・既定オフ）。2026-11-04 Mali-G615 実機：床は建物の頂点ごとの標高参照（elevQ 12 標本）だった |
| 模型の素の束の速い道（WebGPU・既定 ON） | `?meshfast=0`＝従来（模型は全部 MESH_TEX_WGSL）。3D Tiles・glb・I3S・押し出しの束は材質が何であれ模型用の全部入りシェーダ（テクスチャ 5 枚の標本・法線マップの接線・PBR／Cesium／style の光・街明かり・輪郭線・Cesium の霧・塗る絵・重ねる絵・頂点ごとの asin／atan2）で描いていた。束とフレームがその枝を一つも使わない時（テクスチャ無し・不透明・両面・tint／輪郭線／split／CustomShader／剛体変換／線のリボン無し・地平線の手前、影／断面／Cesium の照明／style の light／局所の光源／fx.pbr／Cesium の霧が無いフレーム）だけ、同じ式のうち使う物だけ残した MESH_TEX_FAST_WGSL（discard 無し・テクスチャ標本 0・varying 4 本・uv を結ばない）で描く＝絵は同じ。束が 1 色（PLATEAU の no_texture）なら色の sRGB 符号化も CPU で 1 回。パイプラインは要る束が初めて出た時に裏で作り、出来るまでは従来の道。`__perf().meshDraw.fast`＝速い道で描いた束の数。`?meshfastcull=1`（back）／`2`（front）＝実験ノブ（既定 0）：速い道の束のうち巻き順の決まった束（wind＝法線あり・doubleSided でない材質）の裏面をラスタライザで捨てる＝深度を画素で書く間は裏面の画素も FS を走るので、その分を減らせるかの A/B（Cesium の backFaceCulling 既定 true・three.js も同じ。巻き順の怪しいデータは穴が空くので既定にするかは実測と本人裁定の後）。動機：2026-11-11 Galaxy Tab A11+（Mali・800×1104・1x）で PLATEAU 千代田区 LOD2 の 3D Tiles の周回が 30 fps（Navara 60）。クラウドのソフトウェア WebGPU（SwiftShader・合成 3D Tiles 5.6 万三角形）では建物の描画 1 フレーム約 3.4 s → 0.1 s（SwiftShader は一様な分岐の両側を実行するので実機の比ではない＝実機は別途） |
| ズームアウトの保持（Mac・WebGPU） | `?keepfine=N`＝引いたとき常駐の細かいタイル（N 段下まで）を親に差し替えず描き続ける深さ。**2026-11-05 既定 0**（本人裁定「0 はかなりいい絵・すごく動きが軽く見える」）。旧既定 2 は保持中の頂点が重く、基図建物（z16 全棟／z14 抜粋）が保持した象限だけ全棟の絨毯で十字型に残った。N≥1 のときも建物だけは親タイル（本来の選抜段）の物を描く（tilemanager の bld 役 only／no） |
| 近景の切り取り（A/B ノブ・WebGPU） | `?nearclip=M`＝深度を FS で書くパイプライン（地形・建物・PLATEAU）の頂点 z を線形にし、カメラから M m の near 面で GPU に切らせる（既定 0＝従来＝対数深度を頂点で書く＝near 面が w≈0 まで働かない）。2026-11-05 Galaxy/Mali-G615 実機「手前の建物が手前に伸びる」（静止中・高ズーム・Mac では出ない）の対策候補＝カメラの後ろにかかる壁の切断点が無限遠に飛び、Mali の固定小数点の範囲を超えて壊れる読み。まず `?nearclip=1` で実機 A/B → 効けば既定へ。`?gl2=1` は対象外（深度を頂点で書く） |
| 飛行中の settle を先送り | 既定 ON。飛行（flightCtl.active）の間は 150 ms の settle タイマーが発火しても張り直すだけ＝URL 書き込み（replaceState）・identify・PLATEAU 確定・gintDrawn を着地まで出さない。2026-11-07 Galaxy 京都→日本列島の滑走トレース（RC・kyoto-tab-1..6）：8〜10 fps でフレーム間が 150 ms を超えると飛行中に settle が立ち、URL の書き換え→Android Chrome のアドレスバー再描画（398×37・24×24 の絵）が GPU プロセスを 0.1〜6 s 塞ぐ悪循環（20 s で 102 回・計 11.4 s、描画 worker の待ち 7.4 s）。URL を書かない比較＝待ち 0.19 s・コマ 167→227（+36%）。`?flysettle=1`＝従来（飛行中も settle） |
| 動いている間は地形メッシュを粗く | `?terrcoarse=2`／`4`（既定：LOW_MEM 4・それ以外 0。`?terrcoarse=0` で従来・2026-11-07 Kenji 決定）。同じ頂点配列（G×G）の上に S 頂点おきの粗い index を 1 本足し（G=1024・S=4 で 0.8MB）、カメラが動いている間（入力中・飛行中・静定前 500 ms＝raster の moving と同じ物差し）だけそれで地形の 4 パス（近・遠・近景・足元）と影の深度パスを描く＝頂点 1/S²。着地（静定）の品質フレームで本番の格子へ戻る。`?terrcoarsealways=1`＝常に粗い（間引きそのものの費用を測る A/B）。動機：2026-11-07 Galaxy 京都→日本列島の滑走（傾き 67°）の最初の 8 秒が 8〜10 fps＝地形メッシュが律速（`?noterr=1` で 60 fps・コマ数 4〜6 倍、建物・遠景・fd・MSAA は無関係、解像度を落としても速くならない＝GPU の頂点）。描画 worker の CPU は 15〜17 ms なのに地図の描画は 100〜140 ms。HUD／`__perf().terr.coarse`＝そのフレームの間引き幅（0＝本番） |
| 地形以外の頂点の標高を平らに（診断） | `?flatvec=1`。地形メッシュはそのまま描き、塗り・線・建物・user・gint の slot の elevP（標高スケール・has・G）だけ 0＝頂点ごとの標高テクスチャ読みを止める。絵は壊れる（線が地形に埋まる）＝計測専用。動機：2026-11-07 Galaxy の滑走で、地形の間引き 1/16＋遠景パス切り＋解像度半分でも地図の描画 66〜93 ms（`?noterr=1` は 40 ms）＝地形メッシュの頂点・パス数・塗りでは説明できない残り＝`?noterr=1` で一緒に止まる「他の層の頂点の標高読み」と「標高アトラスの転送・再標本化」のどちらかを分ける |
| 線・overlay 塗りの標高を軽く | `?lineelev=1`／`2`（既定：LOW_MEM 1・それ以外 0。`?lineelev=0` で従来・2026-11-07 Kenji 決定。Galaxy 各 2 回：最初の 8 秒のコマ数 通常 118 → 1：164 → 2：165 → 1＋terrcoarse=4：194 → 2＋terrcoarse=4＋farterr=0：249・地形なし 485。京都 z15 傾き 60°／比叡山 z13 傾き 70° の静止画で 1 は従来と見分けがつかない）・`?lineelevmove=1`／`2`（動いている間だけ）。線の VS は両端点で `elevQ`（描画メッシュの格子に量子化＝4 隅×elev＝近・遠・近景・足元で最大 16 標本）を引く。1＝格子量子化のまま 4 隅を主アトラス 1 標本（`elevQ1`・4 標本）＝近景・足元層の窓の中だけ数十 cm〜m ずれ得る。2＝`elev1`（1 標本・格子に乗らない＝三角形の間で線が浮き沈みし得る）。F.fineP.z で選ぶ（uniform）＝0 の時のシェーダの算術は従来と同一。動機：2026-11-07 Galaxy 京都→日本の滑走の `?flatvec=1` 切り分け＝線・塗りの頂点の標高読みを止めると最初の 8 秒のコマ数 63〜95 → 189〜220（約 2.5 倍）・地図の描画 125 → 78 ms。地形も軽くする（`?terrcoarse=4&farterr=0`）と 45 ms＝地形なしと同じ |
| 地面アトラスの焼き直しを間引く | `?gndhold=MS`（既定 0＝従来＝窓の鍵が変わるたび）。カメラが動いている間（draw(opts.moving)）は、前の焼きから MS 未満なら今のアトラスで描き続ける＝窓が 1/4 段ずれる分だけ粗い（FS は画素を含む一番細かい窓を選ぶ）。静定の品質フレームで必ず焼く。あわせてミップ生成を合成と同じエンコーダへ（submit 5 → 1・`?gndmipsep=1` で従来）。動機：2026-11-07 Galaxy 京都→日本の滑走で `__perf().terr.sub`＝最初の 8 秒に焼き直し 54〜71 回（7〜9 回/秒）＋ミップ 216〜284 回＝余分な Queue::Submit 288〜384 回とほぼ一致。標高セルは 0 |
| gint 線（国境線・海岸線）の地形適応細分を絞る | `?submove=K`（既定：4GB 機（LOW_MEM）-1＝運動中は細分しない（本人裁定 2026-11-08：国境線の描画 5〜6 ms・8〜12 秒のコマ数 3.6 倍。`?submove=1` で従来）・それ以外 1＝運動中は各バケットの N を半分。長辺が山を貫くのは運動中だけ＝静止で全密度）・`?subbudget=N`（1 層 1 フレームの区間予算・既定 1,500,000）・`?subbudgetmove=N`（運動中だけの予算。既定：4GB 機（LOW_MEM）200000・それ以外 0＝subbudget と同じ。本人裁定 2026-11-08：国境線の描画 65〜72→11 ms・8〜12 秒のコマ数 2.7 倍、静止画は同じ。`?subbudgetmove=0` で切る。運動＝gint のカメラ差 OR レンダラの draw(opts.moving)＝同じカメラの描き直しフレームでも偽にならない・隠線パスも同じ判定）・`?nosub=1`（常に細分しない）。`__gintStats().subs`＝直前フレームの区間数。動機：2026-11-08 Galaxy 京都→日本の滑走の 8〜12 秒（z15→z7.6）が通常 25 コマ／国境線なし 355 コマ／地形なし 161 コマ＝国境線×地形の組み合わせだけが重い |
| gint 線パイプラインの先行コンパイル | `?gintwarm=MS`（既定：4GB 機（LOW_MEM）3000・それ以外 0。`?gintwarm=0` で切る。本人裁定 2026-11-08）。lazy のとき、起動の MS 後に line / lineTest / lineHidden（品質段＋1x のセット）を createRenderPipelineAsync で先に作る。間に合わなければ従来どおり初回使用時の同期生成。動機：2026-11-08 Galaxy 京都→日本の滑走で z9 より引いて国境線が初めて描かれる時に gintSB1x.lineTest 768 ms＋lineHidden 638 ms＝合計 1.3 秒の止まり（シェーダキャッシュが冷えた時） |
| ミニ地球儀の描き直しを間引く | `?minithrottle=MS`（既定 0＝視点が変わるたび）。右下のミニ地球儀（z≤8・2D canvas）は滑走中に毎フレーム全描き直し（NE 110m の陸＋経緯線＋視野の枠の逆投影 120 点）。MS 未満なら後追いの 1 回だけ予約＝止まった後の最終形は必ず描く。動機：2026-11-08 Galaxy 京都→日本の滑走の z7 付近で GPU プロセスの 187×187 の画像作成 620 ms の止まり |
| パイプラインの遅延生成（WebGPU） | `?lazypipe=1`／`?lazypipe=0`＝WebGPU のパイプラインを初回使用時に作る／起動時に全部。既定：**全端末で遅延（2026-11-07）**。2026-11-06 Galaxy/Mali-G615 の adb トレース：起動時 59 本を GPU プロセスが 1 本ずつ 9.6 秒（Vulkan ドライバ・キャッシュ不発）＝起動後 10 秒の固まりの正体。全パイプラインに `セット.鍵` の label も付いた（トレースで読める）。#974 は renderer 本体の 25 本だけ遅延＝効果なし（遅延 44 本 11.6 s／即時 59 本 11.5 s）。直し②（#975）で gint・md・text・post も名前＋遅延化 → タブレット 3 回ずつ：生成 59→16 本・GPU 詰まり 7.3→4.2 s・worker 停止 8.7→6.0 s・frame1 1.6 s 安定（eager は 2 回に 1 回 4.2 s）＝LOW_MEM 既定 ON。2026-11-07 MacBook M5 Pro（Chrome for Testing・Metal キャッシュも消して冷えた状態 2 回ずつ）：eager は 95 本 6.9 s を描画スレッドで順に作り frame1 後 6.5〜6.9 s 固まる（MSAA 4x のものが 1 本 ≈0.3 s）／lazy＋warmpipe=3 は 22〜33 本 1.5 s・固まり 1.0〜2.1 s・idle 9.6〜10.0 → 6.7〜6.8 s・暖機は差なし → **全端末で既定 ON**（`?lazypipe=0` で従来） |
| R01 へ切り替えるズーム（A/B ノブ・標高） | `?r01z=N`＝R01（1°細密・1 窓 9 枚・1 枚数十 MB のデコード）へ切り替えるズーム。既定 13（高チルトは 14）、混成窓 11.5〜14 と近景層 13.5 も同じ幅でずれる。`?r01z=99`＝常に R10 まで。LOW_MEM の標高の軽量化候補＝タブレットで見栄えを見てから既定を決める |
| 建物メッシュの小片の消化（描画 worker） | `?meshdrain=MS`＝建物メッシュの小片（LOW_MEM の msplit=100 で 1 区 138 MB が 134 個）を 1 フレームに時間予算 MS ms ぶん続けて GPU へ当て、フレームの合間（GPU 待ち）にも timer で当てる。0＝従来の 1 フレーム 1 個。2026-11-06 Galaxy（#982 の mesh timeline・2 本）：IDB 復元は 0.1 s で見つかるのに 134 小片 × 4〜6 fps＝描画側の受け取りに 10.6 s、送る側は credit 待ち 8.7 s＝idle を塞ぐ最大の材料（6.8〜8.4 s）。2026-11-06 公開後の Galaxy 2v2：`?meshdrain=8` で 134 小片の受け取りが 2.2→9.0 s（無しは 7.4→13.8 s）・idle 13.9 → 9.0〜9.5 s・mesh の塞ぎ 7.7 → 2.8 s、frame1 は変わらず → **LOW_MEM の既定 8**（`?meshdrain=0` で戻す）。デスクトップは 0 のまま（60 fps では 1 フレーム 1 個で足りる）。残り：main stalled 4.4 s（GPU/compositor 待ち）と送る側の credit 待ち 4.3 s |
| 最初のフレームのパイプラインを先に作る（WebGPU） | `?warmpipe=0`／`1`／`2`＝lazy の束のうち最初のフレームに要る本体 10 本（globe/fill/line/terrain/bld/mesh 系）を起動時に先に作る。1＝同期、2＝createRenderPipelineAsync で並列。2026-11-06 Galaxy のトレース：同じ 10 本が eager（起動直後）は計 0.2 s、lazy（初回描画の最中・タイル復号と競合）は 4.2 s＝作る時機で 20 倍違う。Galaxy 各 2 回＋トレース（11/6 19:20 UTC・エンジン cae4300625）：無し＝mesh 系 3 本が 6.5 s に遅れ worker 0.67 s 停止／1＝停止ゼロ frame1 +0.1〜0.2 s／2＝停止ゼロ frame1 +0.2〜0.3 s → 既定：LOW_MEM＝1（11/6）→ **3（11/7）**、それ以外 0（lazy でないので無意味）。`3`＝進行描き（2026-11-07）：地球と地形だけ同期で先に作り、残り 8 本は createRenderPipelineAsync で待たずに作る＝描き手はコンパイル中の層（塗り・線・建物・メッシュ）を飛ばし、1 本できるごとに次のフレームを頼む。シェーダキャッシュが冷えた初回（deploy 直後・Galaxy 7 本のトレース：10 本の直列コンパイル 4.4〜9.5 s の間 frame1 の後の画面が止まる）に、最初の絵を 10 本ぶん待たせない狙い。Galaxy 冷えたキャッシュ 3v3（11/7 17:50 UTC・7dc94e8efb）：frame1 後の最長停止 5.7〜7.0 s → 1.6〜2.2 s。ただし 8 本一度に出すと 1 本ずつ 2〜3 倍遅く、線が 9.3〜9.8 s に最後・idle 3〜4 s 遅れ → `?warmpar=N`＝同時にコンパイルする本数（0＝全部一度に）、出す順は線→塗り→建物→メッシュ。Galaxy 3v3（11/7 18:30 UTC・48ac75d8b3）：2 本ずつは線 9.3〜9.8 → 6.9〜8.0 s の代わりに塗り・建物 +3 s・メッシュ +2〜3 s・idle 改善なし、暖機でもメッシュ 2.4 → 4.0〜4.7 s（1 組ごとの往復待ち）→ **既定：warmpar 0（全部一度に）・LOW_MEM の warmpipe 既定を 1 → 3**（`?warmpipe=1` で戻せる）。同日 Mac でも同じ固まりを確認し **全端末の既定を 3** に（lazypipe と組）。残る課題：冷えた初回の idle が 3〜4 s 遅い（並列コンパイルがタイル復号と CPU を取り合う） |
| clip 空間の倍率（既定 20） | `?clipk=N`＝frame の mvp／clipT（模型は clipMesh）を 2^N 倍して渡す。斉次座標なので x/w・z/w は不変＝絵は数学的に同じ（2 のべき＝ビット同値）。深度の式だけ本当の w に戻す（wgsl.ts／glsl.ts wTrue）。理由＝単位球の世界では近景の clip w が 1e-6 級と極端に小さく、Mali の固定機能（透視除算／クリッパ）が w≈0 と扱った（2026-11-05 Galaxy/Mali-G615「手前の建物が足元へ細長く伸びる」＝#954 の clipk=20 で根治・Mac は不変を確認）。WebGPU・`?gl2=1` とも既定 20（`?clipk=0` で戻す・GL2 は 2026-11-05 Galaxy 実機で確認） |

## 8. 残リスク（監視項目）

1. **8GB Android×GL2 は md が有効**（deviceMemory=8 → LOW_MEM 素通り。MID_TIER は PLATEAU のみで noMultiDraw 非連動）
   ＝iOS jetsam と同族のリスクが理論上残る。入門機実機は完走＝実害未観測。実害が出たら noMultiDraw を MID_TIER に連動
2. Windows 実機での MID_TIER の効き・WebGPU device lost の実発火が未検証
3. Android WebGPU 封印の再評価（§1）＝`?gpu=1&msaa=0` 実機確認・crbug 報告・Dawn 成熟
