# fallback ladder — バックエンド選択・端末ティア・jetsam 防衛の台帳

「どの環境で・何が・どう落ちて・どこへ着地するか」の正典。**ノブの値や判定を変えたらこの台帳も更新する**。
姉妹編：`webgpu port.md`（WebGPU 移植の設計・轍）。最終更新 2026-08-19（§3.5 追加）。

## 1. バックエンド選択（app.js `gpuBackend`）

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
| 同時デコード `bldCap` | 1 | 1 | 2 | デモ先読み中は−1。16GB 機 renderer 12.3GB 実測の半減策 |
| worker内RAMキャッシュ `CACHE_MAX` | 0 | 0 | **1区**（8/3 に 2→1） | OPFS 二層化以前の遺物＝三重化（RAM cache×GPU常駐×OPFS）の解消。⚠cache を持つ構成はロード中 `keep[]` が区全量を積む＝コールドピークの主因 |
| バッチ/並行fetch | 8枚/4本 | 32/8 | 32/8 | lowMem＝IDB commit バースト・送信粒度も半減 |
| タイル予算 `?tbudget` | 24MB | auto | auto | |

過渡の防波堤（ティア共通）：
- **クレジット制**（`CREDIT_MAX=2`）＝render worker の消化 ack 待ち＝mesh 送出の滞留を数十MBで頭打ち
- **OPFS 二層＋streaming 復元**＝読む→送る→手放す（温読了時ピーク根治・iPhone XS「読み終えた瞬間に落ちる」対策）
- QuotaExceeded → 最古区を緊急退避して1回だけ再試行 → 駄目なら以後書かず**表示は継続**（idbFail）
- fast枠 60秒ローテーション（巨大区×低速APIの飢餓対策・LOW_MEM は無し＝in-flight 在庫を増やさない）
- 遠方離脱 0.5deg で本削除・視界外は非表示常駐（LOW_MEM は常駐なし）

## 6. PLATEAU 以外の jetsam 装備（iOS 三部作の現在形）

- **md（multi_draw タイル常駐プール）＝LOW_MEM 既定 OFF**（`?md=1` 戻し口）。iOS は WebGL バッファが
  WebContent プロセス＝タブ予算に直乗りする会計の教訓（iPhone 16 Pro 実機 A/B で確定）。
  WebGPU バックエンドは md 自体が無い（classic merge 恒常）＝構造的メモリ優位
- R10 タイルキャッシュ 256MB LRU（LOW_MEM 64MB）・R90 先読みスキップ・pagehide→destroy（reload 二重居住半減）
- 標高：R16F アトラス（GPU半減）・単位格子メッシュ（窓替え 75MB 再確保の根絶）・混成R01 全端末ON（`?nor01=1` 逃げ道）
- 動的解像度＋GPU格付け＝gpuEmaRaw（30Hz モニタの壁時計の罠回避）。WebGPU も timestamp-query で同じ給餌口（tqFeed）
- **遷移時AA（WebGPU 既定・2026-08-19）**：カメラ遷移・アニメ継続中は 1x 直描き（MSAA の store/load/resolve を
  フレームから消す）、静止 500ms（RES_SETTLE_MS と同時計）で 4x 品質フレームを1枚。1x 遷移で busyMs が下がる＝
  動的解像度の降段も実測で消える（ぼやけ対策を兼ねる）。パイプラインは sampleCount 焼き込み＝1x/4x セット取替
  （renderer/gint とも遅延生成キャッシュ）。ノブ＝`?msaa=0` 常時1x／`?msaa=1` 常時4x固定（旧挙動・A/B用）。
  GL2 は context 生成時 antialias 固定＝対象外。LOW_MEM は従来どおり既定 1x（変化なし）

## 7. 計器（全部 URL フラグ・本番搭載）

| フラグ | 見えるもの |
|---|---|
| `?mem=1` | 常駐台帳＋**過渡行**（plateau worker の cache／読込中＝常駐台帳に乗らない実ピークの主役）＋peak＋4GB予算残 |
| `?drawhud=1` | 描画実績（塗り枚数・退場フラグ・fade・PLバッチ）＝**USB 不要の実機計器**。塗り0=赤字＝CPU側、枚数ありで黒=GPU側の二分 |
| `?stay=1` | 起動診断 HUD（frame1・配達カウンタ・boot 里程標。フォールバックせず留まる閲覧モード） |
| `?perf=1` | フレーム内訳（ema・gpuMap/gpuGint・aa=直近フレームの段数 1/4）＋GPU 識別。⚠ema は 60fps 機で 16.7ms 飽和＝差が出ない |
| 層別切り | `?nomd` `?nogint` `?noterr` `?nofade` `?msaa=0/1` `?ell=1` `?notq` `?noopfs` `?nor01` `?relay` `?mid=0/1` `?maxact=N` `?tbudget=N` |

## 8. 残リスク（監視項目）

1. **8GB Android×GL2 は md が有効**（deviceMemory=8 → LOW_MEM 素通り。MID_TIER は PLATEAU のみで noMultiDraw 非連動）
   ＝iOS jetsam と同族のリスクが理論上残る。入門機実機は完走＝実害未観測。実害が出たら noMultiDraw を MID_TIER に連動
2. Windows 実機での MID_TIER の効き・WebGPU device lost の実発火が未検証
3. Android WebGPU 封印の再評価（§1）＝`?gpu=1&msaa=0` 実機確認・crbug 報告・Dawn 成熟
