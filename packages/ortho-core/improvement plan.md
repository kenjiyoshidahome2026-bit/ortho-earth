# 2.2 以後の改善計画（高速化・重複の削除）（2026-10-31 起案）

位置づけ：2.2.0 公開（2026-10-31）の後に、このリポジトリのコード全体を俯瞰して立てた計画。速さの細目は既存の計画書
（`perf plan.md`・`vt perf plan.md`・`render roadmap.md`・`text gpu plan.md`）が正本で、ここはその上の順番と、2.2 で増えた層（Cesium の facade・3D Tiles）の分。
本人裁定（2026-10-31）＝**重複の削除 → 段階 0・1 の順**。その後に本書を repo に置く。
掟（全項目共通）：①どの PR も「段が下がらない」が門（Sandcastle 190/107/0/0、MapLibre の公式例、verify:ui・verify:webgpu）
②速さの PR は、絵が同じで計器の数字が良くなった時だけマージ③URL の逃げ道を付ける（perf plan の掟①と同じ）④効果は測ってから書く（読んだだけの見立ては「見立て」と書く）。

## 0. 俯瞰（main 8011c197・テストを除く src の行数）

| パッケージ | 行数 | 2.1 時点 | npm（2.2） |
|---|---|---|---|
| @ortho-earth/globe | 43,000 | 39,400 | 5.4 MB（520 ファイル） |
| @ortho-earth/core | 33,700 | 28,500 | 3.9 MB（230） |
| geopbf | 19,600 | — | — |
| @ortho-earth/cesium | 5,600 | 新規 | 0.47 MB |
| equal | 3,800 | — | — |
| @ortho-earth/leaflet | 2,400 | 新規 | 0.21 MB |
| sdk/voxel | 2,400 | 新規 | — |
| @ortho-earth/gmaps | 1,700 | 新規 | 0.17 MB |

- 大きいファイル：globe.ts 3,913 行・gpu/renderer.ts 3,810・gl/renderer.ts 2,828・gpu/wgsl.ts 2,180・gl/glsl.ts 2,179。
- どこからも読まれていないファイルは無い。
- 結論：大きな作り直しは要らない。写しの重複は少なく、本当の重複は WebGL2 と WebGPU の二重実装。速さの無駄は 2.2 で増えた Cesium の層と 3D Tiles の毎フレームの処理に集まっている。

## 1. 重複

物差し：6 行以上続く同じ行（空白と数字を正規化・自前のスクリプト）。packages＋sdk で 2.1%（97,000 行中 2,000）、apps で 12.8%。

| 重複 | 大きさ | 扱い | 状態 |
|---|---|---|---|
| 殻アプリの scripts/verify-i18n.mjs・i18n-build.mjs | 23＋21 個の写し | globe の `scripts/lib/i18n-shell.mjs`（verifyShellI18n・buildShellI18n）を呼ぶだけに | **#813 済**（門の出力は前後で byte 一致） |
| gadgets の GL 描き手 7 つ（arcs・points・trips・sprites・copc・customgl・columnar）の program 作成と pick 窓の読み | 各 10〜20 行 | `gadgets/glprog.ts`（glProgram・readPickWindow・decodeId・nearestId） | **#814 済**（Mac 実 GPU で main と同じ。t-copc の backend 待ちも直した） |
| apps/census2020 と apps/gishub-jp の census/ui.ts・small-area.ts | 1,193 と 1,132 行 | census2020 を正とし、gishub-jp の画面は census2020 への案内に（本人裁定 2026-10-31「消す方向」。経緯＝8/12 に census2020 を 1 日で出した時の写しが残り、7/16 の方針で gishub-jp の描画は消える側） | **#816** |
| sdk の voxel・splat・scene の -gl/-gpu の定型 | voxel 547/570・splat 275/426 行 | globe の glprog を export して使う | 後回し（sdk は globe を型だけで読む＝globe のリリースが要る） |
| core の gl/ と gpu/（renderer・シェーダ・gint・poststage・classify・depthout） | GL 9,000・GPU 10,500 行。10 月に renderer を触った 55 コミットのうち 43 が両方 | 一つのソースにはしない。カリング・バッチの選び・影の範囲などの純関数だけ terrainlod.ts の形で抜く | 段階 3 |
| 各アプリの vite.config、physical と terrain、parks と parks-us | 小 | 共通の設定関数へ | 急がない |

## 2. 高速化の候補

「読んだ」＝コードを読んで確かめた・「計画」＝既存の計画書の残り。数字は段階 0 の計器で埋める（§5）。

| 候補 | 根拠 | 扱い | 状態 |
|---|---|---|---|
| facade の線：全 Polyline の弧（generateArc）を毎 tick 作り直してから比べる（sdk/cesium/src/collections.ts） | 読んだ | 線ごとに鍵で弧を写して持つ | **#815 済** |
| 3D Tiles の選び：辿る全ノードで worldOf（ecef2geo）と obbAxes（worldOf 6 回）を毎フレーム（gadgets/tiles3d.ts の visible） | 読んだ | ノードに写しを持ち、sphere か lift が変わった時だけ | **#815 済** |
| 3D Tiles の点群スタイル：点ごとに JSON.stringify の鍵（stylePoints） | 読んだ | 値そのものを鍵に・POSITION を引く式は覚えない | **#815 済** |
| facade の変更検出：線・面を毎 tick JSON.stringify で比べる（display.ts 7 か所） | 読んだ | 変更カウンタへ | 見送り（[csperf] の display が 0.1 ms 以下・§5） |
| 1 フレームの模型バッチ上限 512（gpu/renderer.ts MAX_PL_BATCH・超過は log して打ち切り） | 読んだ | 速さより絵の問題 | 大きな tileset で log が出るか見る |
| 起動：hillshade・colorrelief・customgl・sky を globe.ts が静的に読む | 読んだ | 使う時だけ import() | 初期バンドルを測ってから |
| 3D Tiles のピック用の形を main に複写（タイルの約 7 割） | 読んだ | メモリが減るが pick は同期 API＝設計の判断 | 保留 |
| 最初の 4x 静止フレームで同期のパイプライン作成 | 推測 | 非同期で先に温める | 引っ掛かりの計器で確かめてから |
| WebGPU の paint 表 | 計画（render roadmap 14） | GL2 と揃える | 段階 2 |
| 文字の GPU 化 T-P1 の実機の門・T-P2 | 計画（text gpu plan） | 門を通して既定に | 段階 2 |
| render bundle（step B） | 計画（vt perf plan §4・棚） | Mac の bench で go/no-go | 段階 2 |
| geopbf の topology（BigInt Map の dedup が 55%・12.3 s） | 計画（perf plan P5） | uint32 の hash（出力 byte 一致が門） | 段階 2 |

## 3. 段階と門

| 段階 | 中身 | 門 | 状態 |
|---|---|---|---|
| 0 | 計器：`?perf=1` の `[csperf]`（sdk/cesium/src/perf.ts の timed＝display・prims・colls・voxels・particles・clouds・timePoints の平均/最大 ms と回数を 2 秒ごと）と `[t3perf]`（選びの ms・1 フレームに見たノード数）。初期バンドルの大きさの関門。Mac で perf plan の 3 シーン＋Cesium の重い例 5 本、iPhone は本人に一度 | 表が §5 に埋まる | #815・Mac の計測は §5（iPhone・Windows・動かした時は未） |
| 1 | §2 の「#815」の 3 件。静的 import の遅延は段階 0 の数字で選ぶ | Sandcastle を撮り直して段が下がらない・3D Tiles の頁が main と同じ | **#815 済**（§5） |
| 2 | 既存の速さの計画の残り（paint 表・T-P1 の門・render bundle・topology） | MapLibre の門・verify:webgpu・verify:ui 緑、perf plan の表に数字 | 未着手 |
| 3 | 重複の残り（sdk の定型・gl/gpu の純関数） | 門の出力が前後で同じ | #813・#814・#816（census）済、残りは未着手 |
| 4 | 構造：globe.ts と gpu/renderer.ts の分割、facade の any（cesium 約 700・leaflet 約 570・gmaps 約 200）を公開 API の型から | 機能追加の邪魔になった時 | 後回し |

## 4. やらないこと・決めてほしいこと

- やらない（既存の計画でも見送り）：描画ループやタイル結合の WASM 化、multi-draw-indirect、GL と GPU のシェーダを一つのソースから生成する作り直し、3D Tiles の選びの worker 化（段階 1 の数字を見てから）。
- 決めてほしいこと：
  1. ~~census の写し~~＝2026-10-31 裁定済み（gishub-jp 側を消す）。
  2. ~~WebGL2 をいつまで維持するか~~＝2026-10-31 裁定「GL2 は 2.x では動かす」。gl/ と gpu/ は 2.x の間は両方を保守し、一つのソースにはしない（純関数の抜き出しだけ・段階 3）。3.0 での扱いは GitHub Discussions で使う人の環境を聞いてから決める。

## 5. 計測（段階 0）

2026-10-31・Mac M5 Pro 実 GPU・`?perf=1`・#815 の head（d7dfa06e）・Sandcastle の例を開いて 30 秒置いた最後の 3 回（カメラ静止）。

| 例 | [csperf] display（平均/最大 ms） | [t3perf] 選び（平均/最大 ms・節点/フレーム） | [perf] map / gpuMap（ms） |
|---|---|---|---|
| google-photorealistic-3d-tiles | 0.00〜0.01 / ≤0.1 | 0.34〜0.97 / 0.6〜11.6・393〜541 | 0.36〜1.42 / 1.06〜**14.73** |
| 3d-tiles-photogrammetry | 0.03〜0.05 / 0.1 | （静止で行なし） | 0.70〜0.89 / 2.00〜4.36 |
| aerometrex-san-francisco | 0.00〜0.01 / 0.0 | 0.24 / 3.0・255 | 0.71〜1.45 / 1.64〜**12.32** |
| polyline | 0.08〜0.09 / 0.1 | （行なし） | 0.37 / 1.96（gpuGint 0.97） |
| 3d-tiles-point-cloud-styling | 0.00 / 0.0 | （行なし） | （測定行なし） |

- [csperf] の他の項目（prims・colls・voxels・particles・clouds・timePoints）は全部 0.00 ms。
- 読み：静止時の CPU（Cesium の層・3D Tiles の選び）は既に 1 ms 前後以下＝**残りは GPU**（写実タイルと aerometrex の gpuMap の山 12〜15 ms）。
  段階 2 は CPU の発行より GPU 側（模型の描き・影・後段）を先に測る。display の JSON 比較（§2）は直さない（0.1 ms 以下）。
- 未計測：カメラを動かした時（[t3perf] は動いた時に出る）・#815 前の値（main に計器が無かった）・iPhone・Windows。
- 門：#815 は verify:ui の 3D Tiles 10 頁・verify:webgpu t-tiles3d が main と同じ。Sandcastle 46 本（3d-tiles-*・polyline*・point-cloud*）は PR 17/27/1/0・main 18/27/0/0。
  差の 1 本 3d-tiles-1.1-photogrammetry は起動時のカメラが 2 通り（高さ 586 m＝L1／277 m＝L3）に分かれる揺れで main でも出る（7 回中 L3 は 2 回）＝v220 の L3 は良い方に当たった可能性。別件で追う。

## 6. 履歴

- 2026-10-31：起案（Claude Doc「ortho-earth 2.2 以後の改善計画」）。本人裁定＝重複の削除 → 段階 0・1。
- 2026-10-31：#813（i18n の門の共通化）・#814（GL 描き手の program と pick 窓の共通化）・#815（段階 0・1）マージ。§5 に Mac の計測。#816 で census の写しを消す。
