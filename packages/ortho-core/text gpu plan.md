# テキスト描画の WebGPU 化・実施計画（2026-10-22 起案）

位置づけ：注記（基図／vector／gint の文字・記号・標識）の「描く」部分を Canvas2D から WebGPU の SDF 字形アトラス＋インスタンス描画へ移す計画。
本人向けの説明は Claude Doc「テキスト描画のWebGPU化計画」（https://claude.ai/artifact/FZ4yB6uaSxzNNTYjV2KkdT）、順番は `render roadmap.md` の **T** が正本。ここは実装側の正本（現状・設計・門・逃げ道・実施記録）。

掟は `perf plan.md` と同じ：①URL の逃げ道（`?text=2d|gpu`）②既存の関門を緑のまま＋絵の一致 ③物差しは `?perf=1` の注記の行と `bench-perf.mjs --set labels` ④両バックエンド 1:1 を崩す時は理由を書く（WebGL2 は P6 まで Canvas2D）⑤危険は成果より先に申告。

## 0. 結論

- 配置と衝突判定は今の `labels2d.ts`（CPU・render worker）に残す。`placed()`・公式例の門（`__placed`）・`tests/labels2d.mjs` がこの結果を読むため。
- 「描く」部分だけを **TextSink**（描画命令の受け口）の向こうに出し、Canvas2D 版と WebGPU 版を差し替える。字の寸法も **GlyphMetrics**（寸法の口）に出し、`measureText` と glyph PBF のどちらでも配置できるようにする。
- 最終形（P2）は注記を地図の描画パスの中で style の層の位置に描く（衝突判定は全注記で 1 回・描く時に層ごとの範囲で分ける）。S 計画（MapLibre style 互換）の P2（層順）の前提。
- 字の元：既定は裁定 (b)＝Canvas2D で CSS／システムフォントを焼いて SDF 化。**2026-10-22 裁定：style に glyphs があれば PBF、漢字・かな・ハングルは端末フォント（MapLibre の `localIdeographFontFamily` と同じ形）**＝P4 で実装。

## 1. 現状（読んだ版＝main a5216d05・2026-10-22）

| 経路 | 所在 | 描き方 |
|---|---|---|
| 基図／vector／gint の注記 | `ortho-core/src/labels2d.ts` | 点の注記は行ごとに `strokeText`＋`fillText`、線沿いは字形アトラス（Canvas2D で焼いた 1024² の頁×最大 6・`drawImage`） |
| 注記の抽出 | `ortho-core/src/labels.ts` | tile worker で式を評価し `Label` を焼く（描画とは独立） |
| 書体 | `ortho-core/src/fontstack.ts` | `text-font` を CSS の family／weight／style に写す |
| geojson の symbol | `globe/src/symbols-2d.ts` | 別の 2D オーバーレイ（箱・候補の式を二重に持つ）＝§4g・§4i で注記層へ移し、今は描く層が無い（オーバーレイも作らない） |
| 集約の件数 | `globe/src/cluster-2d.ts` | 別の 2D オーバーレイ（MapLibre の集約の source は §4h で注記層へ・残るのは `map.gadget.cluster` の口だけ） |
| 道路標識 | `globe/src/shields.ts` | Path2D を注記 canvas に直接 |
| 星空・月 | labels2d の `setSky`／`setMoon` | `fillText` と図形 |

注記 canvas は render worker の 2D OffscreenCanvas（`globe.ts` の `#labels`）＝地図の canvas の上に DOM で重ね、動的解像度の外で常にフル解像度。
分かっている詰まり：デルフト z17.6・傾き 55°・字 600 で字ごと `fillText` は 60→20fps（JS 3ms・重いのは塗り）→字形アトラス（2026-10-13）で 60fps。点の注記と `text-halo-blur`（`shadowBlur`）は旧のまま。字形アトラスは書体×色×縁×ぼかし×大きさごとに焼くので、zoom 補間の `text-size` で組が増え、頁が尽きると全部焼き直し。衝突判定は 150ms ごと（`recollideMs`）・位置は毎フレーム CPU で投影。

## 2. 目標の形

```
labels.ts（Label を焼く）→ labels2d.ts（配置・衝突・フェード・placed()）
        │  GlyphMetrics（字送り）        │  TextSink（描画命令）
        ├─ measureText（今）            ├─ Canvas2D 版（今・WebGL2 は P6 まで）
        └─ glyph PBF（P4）              └─ WebGPU 版（P1 足場 → P2 地図のパスの中）
```

- **SDF 字形アトラス（R8）**：元の絵は今と同じ Canvas2D（worker の OffscreenCanvas・`addFontFace` の Web フォントも効く）で白黒に 1 字焼き、EDT（TinySDF と同じ）で SDF。鍵は「書体×字」だけ＝色・大きさ・縁・ぼかしはシェーダ。基準 32px・余白 4px から出発（MapLibre の PBF は 24px・余白 3）、2048² に約 2,600 字、尽きたらテクスチャ配列の層を足し LRU。MSDF は採らない（Canvas2D からは輪郭が取れない）。
- **shaping**：字送りは今と同じ `measureText`。点の注記の字の x は「頭からその字までの部分文字列の幅」でカーニングを保つ。アラビア文字・デーヴァナーガリー・合字を含む列は字に分けず run sprite（列ごと 1 枚の SDF）。縦書き・format・折り返しは今の `textLayout`／`vertLayout`／`lineLayout` のまま。
- **描画**：1 字 1 インスタンス（画面の位置・2×2 の行列・UV・色・縁の色と幅・ぼかし・不透明度＝約 48B）。縁は同じ quad で SDF のしきい値 2 つ（縁→本体）、`text-halo-blur` は smoothstep の幅。深度は読まない（2026-10-13 裁定：建物の陰の道の名は隠さない）。P2 ではインスタンスを層の添字 `li` 順に並べ「層 → [始点, 件数]」の表で、renderer が層を描く途中でその範囲だけ draw。

## 3. 段と門

各段は単独で main に入る大きさ。既定を GPU にするのは P2 の門を通ってから。

| 段 | 中身 | 門 | 逃げ道 |
|---|---|---|---|
| **P0** 測る・切り出す（小） | §4 | `labels2d.mjs` 全通過・t-mlcompat 不変・画素一致 | 無し（絵が変わらない） |
| **P1** 線沿いの注記を GPU へ（中・**実装済・実機の門待ち**＝§4b） | SDF アトラス（Canvas2D→EDT）・字のパイプライン。今の字形アトラスの経路を置き換える。描く先は注記の OffscreenCanvas に同じ GPUDevice で据えた webgpu（最前面の足場） | デルフト 60fps・注記の CPU 1ms 未満・字の質を実機の **dpr 2（Mac）と dpr 1（外部モニタ等）** で本人が目視（「鬱・龍・護」を Canvas2D と並べる） | `?text=2d` |
| **P2** すべての文字を GPU へ・層の位置で描く（大・**1 本目＝点の注記は実装済**＝§4c・**2 本目＝層の位置は実装済**＝§4d） | 点の注記・複数行・format・縦書き。部分文字列の幅で字の x・繋げる文字は run sprite。描く場所を地図のパスへ移し層ごとの範囲で draw。足場の canvas を外し既定を GPU に | t-mlcompat?g=vector の symbol-* が同じ答え・層順の場面（注記の後に線が来る style）が MapLibre と同じ絵・東京 z15 の Canvas2D との差分画像を本人が確認 | `?text=2d` |
| **P3** 記号・標識・geojson の symbol・星空（中・**1 本目＝記号と標識は実装済**＝§4e・**2 本目＝星空と月は実装済**＝§4f・**3 本目＝geojson の点の symbol 層は実装済**＝§4g・**4 本目＝集約の source は実装済**＝§4h・**5 本目＝ネイティブの記号の口は実装済**＝§4i） | sprite を RGBA の記号アトラスへ・標識は番号ごとに焼いて同じアトラス・星空と月も TextSink 経由。symbols-2d を labels2d に合流（同じ衝突判定・層順）・cluster-2d も同じ口 | WebGPU で注記に Canvas2D を使う箇所が「字を焼く」だけ | `?text=2d` |
| **P4** glyph PBF を字の出どころに足す（中・**裁定済み＝glyphs があれば既定**） | `style.glyphs` の SDF PBF（256 字ごと）を同じアトラスへ・配置は PBF の字送り（GlyphMetrics）。漢字・かな・ハングルは端末フォントで焼く。PBF が届くまでその字を含む注記は置かない | t-mlcompat の symbol-* が同じ答え・字送りが MapLibre と一致 | `?glyphs=css` |
| **P5** 投影を GPU へ（中） | 点の注記はインスタンスに経緯度・標高を持たせ頂点シェーダで投影と距離フェード。線沿いと衝突判定は CPU のまま（compute の衝突判定は `placed()` の後戻りと実機でしか測れない危うさに見合わない） | パン中の注記の CPU と転送が下がる・`placed()` 不変 | `?text=2d` |
| **P6** WebGL2 版（中） | 同じアトラス・同じ式を GLSL で。これが無い間は WebGL2 だけ注記が最前面＝層順が MapLibre と違う（記録） | GL2 で P2 と同じ層順の絵 | `?text=2d` |

危険：WebGPU はクラウドで検定できない（SwiftShader の GL だけ）＝配置と quad の生成は純粋な関数にして node で検定し、GPU の絵は実機で本人が見る。点の注記を字に分けると間合いが微妙にずれる（部分文字列の幅で詰める・合字は run sprite へ）。太い縁は SDF の余白で頭打ち（MapLibre と同じ・記録）。P1 の足場の間は印刷・撮影の `getImageData` が効かない＝地図と同じ `readback` の口に揃える。デバイス喪失はアトラスとプールを捨てて地図の復帰と同じ後で焼き直す。

## 4. P0 測る・切り出す（**実施済**・2026-10-22）

### 4.1 TextSink と GlyphMetrics（`src/textsink.ts`）

- `TextSink`：`begin(W,H,dpr)`／`end()`／`clear`／`fontsChanged()`／`shield`／`lineIcon`／`lineText(glyphs, font, paint, o, dpr)`／`pointIcon`／`pointText(layout, font, T, sx, sy, x0, y0, just, paint, o, img)`／`stats()`。`kind: "2d" | "webgpu"`、`ctx2d`（星空・月は当面 2D の文脈を直に使う＝WebGPU 版では `null` で描かない・P3 で移す）。
  Doc の案（`glyph`・`run`・`icon`・`shape`）より一段粗い「注記の種類ごと」の命令にした＝P0 で絵を 1 画素も変えずに切れる境目がここだったため。字に割るのは各 sink の中（Canvas2D 版は今の通り文字列ごと、WebGPU 版は P1・P2 で字のインスタンスに割る）。
- `GlyphMetrics`：`measurer(font, lsPx) => (text) => width`。今は `canvasMetrics`（`measureText`＋`letterSpacing`）だけ。P4 で PBF の字送りを同じ口に足す。
- `createCanvasSink`：今までの labels2d の描画（行ごと `strokeText`＋`fillText`・`shadowBlur`・字形アトラス 1024²×6・伸びる記号の 9 分割・標識）をそのまま移した物。書体の状態（`setFont` の memo）は寸法の口と共有＝描く時と測る時で同じ文脈。
- `createLabelLayer({ sink?, metrics? })`：渡さなければ Canvas2D 版。`stats()` に `drawMs`・`collideMs`・`labels`・`glyphs` を足した。

### 4.2 計器

- `?perf=1` の `[perf]` 行に `lab=<ms>(collide <ms>) labels=<件> glyphs=<字>`（EMA）。`__perf().lab` にも同じ値（mem の遠隔計測の `lab`）。
- 場面：`apps/ortho-japan/tests/t-perfbench.html?set=labels`（東京駅 z15・東京駅 z17.5 傾き 55° 回転・世界 z3 [135,30]）、`apps/ortho-nl/tests/t-labelbench.html`（デルフト z17.6 傾き 55° 回転・デルフト z15）。走らせ方：`node apps/ortho-japan/scripts/bench-perf.mjs --set labels`／`--app nl`＝注記の表（labMs・collideMs・labels・glyphs の中央値）が出る。計測の輪は `packages/globe/tests/perfbench-run.js` に共通化（アプリ同士で読み合わない＝`check-app-imports`）。

### 4.3 門の結果

- 画素一致：labels2d を偽の 2D 文脈（全呼び出し・全代入を記録する Proxy・`performance.now` 固定）で描き、**切り出し前後の呼び出し列 29,151 件が完全一致**（点の注記 アトラス有／無・線沿い アトラス有／無＋傾き・format・縦書き・記号・星空と月）。呼び出し列が同じ＝Canvas2D の絵が同じ。
- `packages/ortho-core` の `npm test`（`labels2d.mjs` 含む）全通過・root の `typecheck` 51 package 全 OK。
- t-mlcompat：`?g=vector`（symbol-* 40 余件＝点・線沿い・記号・icon-text-fit・format の画像・縦の揃え・halo）全 PASS。`?g=layers` は global-state-filter・hillshade-layer の 2 件が落ちるが、**main でも同じ 2 件が落ちる**（クラウドの SwiftShader・注記と無関係）。`packages/globe` の `npm test` 全通過。
- 計測の場面はクラウドの SwiftShader で動作だけ確認（タイルが来ないので labels 0）。**実数は実機で取る**＝§5 に記録。

## 4b. P1 線に沿う注記の字を GPU へ（**実装済・実機の門待ち**・2026-10-22）

- **逃げ道と既定**：`?text=gpu` の時だけ（既定は今までの Canvas2D＝既定を GPU にするのは P2 の門の後・§3）。WebGPU で起動できなかった時（GL2 へ落ちた・`createGpuText` が投げた）も Canvas2D のまま。
- **SDF**（`src/sdf.ts`・純関数）：基準 32px・余白 6px・R 8・CUTOFF 0.25（TinySDF と同じ符号化）。Doc の案（余白 4）から余白を 6 に＝縁の上限が 6 版 px（12px の字で 2.25px）。棚詰め・書体の大きさの基準化も同じファイル。
- **字の版と描画**（`src/gpu/text.ts`）：R8 の 2048²（尽きたら 4096² へ広げ、それも尽きたら次のフレームの頭で焼き直し）・CPU の写しを持ち書いた行だけ `writeTexture`。焼き場は `willReadFrequently` の 2D（getImageData が GPU から読み戻さない）。1 字 1 インスタンス 72B（位置・2×2・箱・UV・縁の幅とぼかし・本体と縁の色 unorm8x4＝不透明度込み）・4 頂点の strip・premultiplied。縁は SDF のしきい値 2 つ、`text-halo-blur` は縁の幅を広げる。焼く字の数の上限は置いていない（今の字形アトラスと同じ＝初めて出た字はそのフレームで焼く）。
- **受け口**：`createGpuLineSink(Canvas2D 版)`＝`lineText` だけ GPU、他は Canvas2D 版へそのまま。`createLabelLayer({ sinkWrap })` で包む（書体の覚えと寸法の口は Canvas2D 版と共有のまま）。
- **足場の canvas**：main が `#labelsgpu` を `#labels` の直後に作り worker へ渡す（同じ GPUDevice・フル解像度・注記と同じ大きさ）。線の記号（盾）は 2D の下・字は上＝記号の上に字が乗る。`above` のオーバーレイと debug の canvas は `#labelsgpu` のさらに上。
- **撮影**：`canvasOnly` で線の字も Canvas2D へ描いて注記の 1 枚で読み、読んだら GPU の字へ戻して描き直す（`labelsForShot`）＝撮影の絵は今までと同じ。GPU の `readPixels` は検定用（テクスチャ→buffer）。
- **デバイス喪失**：今までどおり main が立て直す（worker ごと）＝字の版も作り直し。

門の結果（クラウド）：
- `tests/sdf.mjs`＝円の SDF の距離の誤差 0.75px 未満・縁の位置 0.25px 以内・棚詰め・書体の基準化。
- **`packages/globe/tests/t-textgpu.html`（verify:webgpu に追加）**＝同じ字の列を Canvas2D の受け口（字形アトラス）と GPU で描いて比べる。直線・曲線＋縁・傾き（潰した行列）・ぼかし・format（色と書体）・CJK を dpr 1／2 で **IoU 0.87〜0.96・外接の箱のずれ 0.5px 以内・インクの比 0.92〜1.08**（SDF の方がわずかに太い）。format の色・消去・`canvasOnly`・版を 2048²→4096² へ広げた後も同じ絵（漢字 2,030 字で溢れる）・GPU の検証エラー 0。
- クラウドの Chromium でも `--enable-unsafe-webgpu --use-webgpu-adapter=swiftshader`（localhost の頁）で WebGPU が動く＝WGSL と絵はここで見られる。**ただし canvas への表示（present）で device が落ちる**＝検定はテクスチャに描いて読む（`createGpuText(device, null)`）。地図ごと `?gpu=1&text=gpu` で走らせる確認は実機で。
- `?text=gpu` を付けた GL2 の起動（デルフトの計測頁）で例外なし（GPU は据わらず Canvas2D）。

実機の門（本人）：デルフト z17.6・55° を `?gpu=1&text=gpu&perf=1` で 60fps・`lab=` 1ms 未満、字の質を Mac の dpr 2 と外部モニタの dpr 1 で（「鬱・龍・護」など画数の多い字を `?text=2d` と並べて）。潰れる時は基準を 48px へ上げるか小さい字だけ SDF でない絵に（§2）。

## 4c. P2 の 1 本目＝点の注記の字を GPU へ（**実装済・実機の門待ち**・2026-10-22）

P2 は 2 本に割る：**1 本目＝点の注記を字に割って GPU で塗る（足場の canvas のまま）**、2 本目＝描く場所を地図のパスの中（層の位置）へ移し、足場を外して既定を GPU に。
1 本目だけでも `?text=gpu` で字はすべて GPU（記号・標識・format の記号の区間・星空は Canvas2D＝P3）。

- **字に割る**（`textsink.ts` の `pointGlyphs`・純関数＝`tests/pointglyphs.mjs`）：Canvas2D 版 `pointText` の 3 つの分岐（縦書き・format の run・素の行）と同じ置き方。
  字の右端＝「行の頭からその字までの部分文字列の幅」（字詰めは前の字の送りに入る）、字の中央＝右端 − 字間 − その字の送りの半分。字間（letter-spacing）は Canvas2D と同じく字ごとの後ろ。
  寄せは Canvas2D の textAlign と同じく行を字間込みで測った幅で。縦書きは Canvas2D が行頭で据えた字間のまま 1 字ずつ中央揃えで描く＝字間の半分だけ前へずれる所まで写した。
- **繋げる字（P2 の run sprite）**：`needsShaping`（結合記号・アラビア／ヘブライ・インド系・タイ・ミャンマー・クメール・ZWJ・絵文字）を含む列は割らずに列ごと 1 枚の SDF（鍵は書体×列）。
  列の箱の中央に置く。字間は焼かない（MapLibre も繋げる字には字間を掛けない）。版の一辺より長い列は焼けない＝その注記は丸ごと Canvas2D。
- **受け口**：`createGpuTextSink`（旧 `createGpuLineSink`）＝`lineText` と `pointText` の字が GPU。割った字の列は行の束（`TextLayout`・labels2d がラベルごとに覚えている）ごとに `WeakMap` で覚える＝静止中の毎フレームは引くだけ。
  寸法は受け口が自前の 2D 文脈で `measureText`（labels2d の寸法の口と同じ書体の文字列・字間）。縁は `haloW`、ぼかし（`shadowBlur`）は縁が無くても縁の色で掛かる（Canvas2D と同じ）。
  format の記号の区間は Canvas2D の受け口の `pointIcon`（足場の間は記号が字の下）。

門の結果（クラウド・SwiftShader の WebGPU）：`t-textgpu` に点の注記 7 場面（複数行の中央寄せ＋縁・右寄せ＋字間・回して潰した箱・format の色と大きさ・縦書きの回す字・アラビア文字の run・縁のぼかし）を足し、
dpr 1／2 で **IoU 0.89〜0.97・箱のずれ 1px 以内・インクの比 0.94〜1.03**（線に沿う字の 7 場面も前と同じ）。`tests/pointglyphs.mjs`＝字詰め・寄せ・字間・format（記号・縦の揃え）・縦書き・割れない列の見分け。

実機の門（本人・2 本目と一緒に）：`?gpu=1&text=gpu` で東京 z15・東京駅 z17.5 55° の点の注記の質（dpr 2／1）・`lab=` の ms。

## 4d. P2 の 2 本目＝層の位置で描く（**実装済・実機の門待ち**・2026-10-22）

`?text=gpu` の時、後ろの層に塗りや線がある注記の字を地図の描画パスの中（style の層の位置）で描く。S 計画の P2（層順）の前提。

- **割り方（2 つの的の併用）**：足場の webgpu canvas（最前面）は外さずに残す。地図のパスの中へ回すのは「その注記の層より後ろに基図の塗り・線（base／main の draw・md の層）がある注記」だけ。
  renderer の `textSplit()`＝基図の draw の層の添字 li の最大（`sceneRev` ごとに覚える）・`li < textSplit` の注記がパスの中、それ以外は最前面。
  最前面の注記は MapLibre と同じ絵（後ろに何も描かない）で、しかも動的解像度に引かれず常に全解像度＝ほとんどの注記はこちら。
- **真俯瞰だけ**：傾き 0.02 未満の間だけパスの中へ。傾けた絵は今までどおり全部最前面（2026-10-13 裁定＝建物の陰の道の名を隠さない・字は深度を読まない＝`depthCompare: "always"`・深度を書かない）。
- **最前面に残すもの**：記号のある注記・format の記号・利用者の層（`L.k`）＝記号は T-P3 まで Canvas2D＝字だけ層の位置へ行くと記号と字の前後が割れる。labels2d の `drawOne` が `sink.layer(li, pinTop)` で知らせる。
- **頂点列**：パスの中の字は層の添字 li の印つきで積み、`end()` で li の順に安定に並べて 1 本の頂点列と「層 → [始点, 件数]」の表（`midAnchors`）。
  renderer は層を描く途中、利用者の層（#123）の切れ目と字の切れ目を合わせて最後のパスを切り、`drawMid(pass, lo, hi, 的)` で範囲だけ描く。的（色の形式・MSAA の標本数・深度の形式）ごとに pipeline を作って覚える。字の層より後ろの基図が無い＝的のパスが無い時は最後にまとめて描く。
- **動的解像度**：パスの中の字は地図の的の大きさで描く＝動いている間は少し柔らかい（静止で全解像度に戻る）。最前面の字は影響なし。
- **撮影（canvasOnly）**：パスの中の字は地図の絵の読み出しに写っている＝注記の canvas には描かない（二重にしない）。
- **既定**：既定は Canvas2D のまま（WebGL2 も）。本人の実機の門を通ったら、既定を GPU に替える小さな PR を別に出す（`?text=2d` で戻せる）。

門の結果（クラウド・SwiftShader の WebGPU）：`t-textgpu` に層の位置の場面を足した＝層 3・7・12 と pinTop の 4 注記で、表は「3,7」・最前面の canvas は層 12 と pinTop だけ（IoU で Canvas2D と一致）・
MSAA 4＋depth24plus-stencil8 の的に `drawMid(−∞, 5)` で層 3 だけ・`drawMid(5, ∞)` で層 7 だけ（字数と IoU）・撮影の時は注記の canvas に層の位置の字を描かない。前の 14 場面も同じ答え。
`t-textpass`（新）＝本物の renderer の描画パスが注記の層で切れるか（塗り 5・線 9 の間の層 7 と前の層 2 は字 5 つをパスの中で・後ろの層 12 は 0）・字の pipeline が本物のパスの形と合う（GPU の検証エラー 0）。全体を起こす絵の比べ（MapLibre との層順）はクラウドの SwiftShader では canvas を出すと device が落ちる＝実機の門 3。

実機の門（本人の Mac・1 本目とまとめて）：
1. `?gpu=1&text=gpu&perf=1` で東京 z15・東京駅 z17.5 55°：点の注記の字の質（dpr 2／1）・`lab=` の ms（`?text=2d` と比べる）。
2. Delft z17.6 55° が 60fps を保つか。
3. 層順の場面（注記の後に線や塗りが来る style・真俯瞰）が MapLibre と同じ前後か。
4. `t-textgpu` が PASS（packages/globe で `npm run verify:webgpu`）。

## 4e. P3 の 1 本目＝記号と標識を GPU へ（**実装済・実機の門待ち**・2026-10-22）

P3 は 2 本以上に割る：**1 本目＝labels2d が描く記号（記号帳の絵・SDF の記号を色で焼いた写し・伸びる記号）・線の記号・標識・format の記号の区間を GPU へ**、
2 本目以降＝symbols-2d（geojson の symbol）と cluster-2d を labels2d へ合流・星空の注記と月を受け口経由に。

- **記号の版**：RGBA（premultiplied）の 2048² を 1 枚。鍵は絵の物（`WeakMap`）＝記号帳の ImageBitmap・`sdfTint` の写し（色ごとに覚えてある）・標識を焼いた canvas。
  `copyExternalImageToTexture`（premultipliedAlpha）で 1 回だけ載せる。周りに透明の 1px。一辺 512 を超える絵は縮めて載せる。尽きたら次のフレームの頭で版を透明に戻して全部載せ直す（尽きたフレームの記号は Canvas2D の最前面）。
- **同じ列**：記号は字と同じインスタンス（72B）・同じパイプラインに `hp.y < 0` の印で混ぜる＝注記の描く順（記号の上に字）が 1 本の draw の中で保たれる。シェーダは両方の版を標本して選ぶ（標本は一様な制御の流れの中）。
- **標識**：ベクターの `draw` を倍率 3（dpr 1.5 以上）／2 で 1 回焼いて記号として貼る（標識の物は番号ごとに覚えてある＝焼きも物ごと）。周りに 4px の余白。
- **伸びる記号**：`drawStretched` と同じ区間ごとの quad（錨を原点に Ti）。
- **層の位置**：記号つきの注記・format の記号も層の位置へ（§4d の pinTop は利用者の層だけに）。

門の結果（クラウド・SwiftShader の WebGPU）：`t-textgpu` に記号 7 場面（素・Ti で潰す・icon-rotate・9 分割・線の記号・標識・format の記号の区間）を足し、dpr 1／2 で **IoU 0.93〜1.00・不透明な画素の RGB の差 0.0〜9.5**（標識は焼いた倍率の分だけ字の縁が違う）・
不透明度 0.6 の α が Canvas2D と同じ（153）・記号つきの注記が層の位置の列に入り最前面は空。`t-textpass` も同じ答え。GPU の検証エラー 0。

実機の門（本人・P1／P2 とまとめて）：§4d の 1〜4 に加えて、記号の多い style（OpenMapTiles 系の POI・国道の標識）で記号の滲み（dpr 2／1）を Canvas2D と並べる。

## 4f. P3 の 2 本目＝星空の注記と月を受け口へ（**実装済**・2026-10-22）

- GPU の受け口（kind "webgpu"）の時だけ、星座名・惑星名・メシエの名は `pointText`（SDF の字）、メシエの記号 4 種と月の満ち欠け（64 段）は焼いた絵（倍率 3）を `pointIcon` で貼る（月は太陽の向きへ箱の中心で回す）。
  Canvas2D の受け口は今までどおり `ctx2d` に直描き＝既定の絵は変えない。
- 星空は最前面（`layer(null, true)`）。描くのは `sink.end()` の前へ移した（GPU の受け口は end で列を送る）。
- これで `?text=gpu` の注記層が Canvas2D で描くのは、記号の版が尽きたフレームの記号と、焼けない長い run の注記だけ。残る Canvas2D は symbols-2d（geojson の点の symbol 層）と cluster-2d＝P3 の 3 本目（§4g＝geojson の層は済み）。

門：`tests/labels2d.mjs` 17（GPU の受け口へは字と記号の命令・2D の文脈には描かない・メシエの記号は 4 種だけ焼く・Canvas2D の受け口は直描きのまま）・
`t-textgpu` の星空の場面（本物の labels2d に GPU の受け口を据えて z1.5＝GPU の列に 364 件・注記の canvas は空）。

## 4g. P3 の 3 本目＝geojson の点の symbol 層を注記層へ（**実装済**・2026-10-22）

- MapLibre の書き方の geojson の symbol 層（点置き＝`symbol-placement` が point）は、symbols-2d（別の canvas・別の衝突）をやめ、線に沿う層（C9）と同じ `gadgets/gjlabels.ts` から注記層（labels2d）へ流す。
  錨は symbols-core と同じ（点・多点の各点・線の各部分の最初の頂点・面の到達不能極）。世界 1 枚の仮のタイル（z0・extent 2^28≒15cm）の点にして `buildLabels` で焼く。
  式の `["geometry-type"]` は元の型（`DecodedFeature.gt`）、`["zoom"]` は表示の z（`quantZoom`）を filter／layout／paint に差し込む（線と同じ近似）。["zoom"] を読む層だけ、止まるたびに z で焼き直す。
- これで基図・vector source の注記と**同じ衝突**になり（旧＝重なって描けた）、`?text=gpu` では字も記号も GPU の版へ行く。
  利用者の層は最前面のまま（`L.k`＝§4d）。
- 記号の gadget（symbols.ts）は `addLayer(…, draw=false)` で評価だけ続ける＝`queryRenderedFeatures` の当たり（symbolsAt）と `styleimagemissing` は今までどおり。記号帳の絵は前から labels2d にも届いている（`labelImage`）。
- **残す**：`map.gadget.symbols`／worldcontent（ネイティブの記号の口）と cluster-2d は、まだ symbols-2d／自前の canvas のまま（MapLibre の層ではない＝層の位置の約束が無い）。必要になったら同じ口へ。
- **層の順**：geojson の層と vector の描く層（vtdraw）が同じ点を取り合う時の勝ち負け。vtdraw の注記の順の鍵は自前の目盛り（`vtdraw.ts` の setOrder＝組み直さない鍵）、geojson の層は MapLibre の層の順の添字＝目盛りが違い、初めは常に vector が先に置いた。
  → main が利用者の組（"vt:<id>"）の順を MapLibre の層の順で別に送り（`vtLabelOrder`・層を載せた時と `reorderLayers`）、labels2d の `setUserOrder` が焼いた sort の代わりに −1e6 − 順位×1e3 + `usk`（焼く前の symbol-sort-key）で比べる＝後の層が先（MapLibre と同じ）。焼いた sort は作り直さない（vtdraw は組み直さない）。順の無い組は今までどおり焼いた sort。
- 待ち方：注記層は render worker の衝突の間引きで置く＝`global-state-filter` の場面は、届くまで待つ形にした（vector の `global-state-vector` と同じ）。

門：t-mlcompat の layers／style／vector がすべて通る（geojson の記号の場面＝stretch-fit・改行と折り返し・styleimagemissing・global-state-filter・symbol-minzoom）。
新しい場面 `symbol-geojson-shares-collision`：同じ点の vector の注記と geojson の注記は片方だけ（旧＝両方）・後から足した geojson が勝つ・moveLayer で下へ回すと vector が勝つ。`tests/labels2d.mjs` 18（setUserOrder）。

## 4h. P3 の 4 本目＝集約（cluster）をデータに（**実装済**・2026-10-22）

- MapLibre の書き方の集約の source（`cluster: true`）は、cluster-2d（丸と件数を別の canvas に描く・paint は丸の色／半径／縁だけ）をやめ、**集約した結果を source の地物**にする。
  `aggregate-core.ts` の `clusterFeatures` が `buildClusters` の全段の丸と単点を 1 つの FeatureCollection にする。
  段をまたいで変わらない項は 1 地物で、居る段 [z0, z1)（エンジンの z・端の段はその先も）を隠しの属性（`ML_CZ0_KEY`／`ML_CZ1_KEY`）に持つ。
  集約の地物は MapLibre と同じ属性（`cluster`・`cluster_id`・`point_count`・`point_count_abbreviated`・clusterProperties）と id＝cluster_id。単点は元の属性と id。
- 層は普通の経路へ：circle の層は gint（丸は GPU・paint／filter／feature-state も MapLibre の意味）、symbol の層は §4g の点置き（件数の字は注記層＝衝突と層の順も同じ・`?text=gpu` で GPU）。
  段は `drawLayerOf` が filter に `[z0 ≤ zoom < z1]` を足す。段の選び方は cluster-2d と同じ floor(zoom)：gint は zoomKey に floor を足して境で必ず表を作り直し、
  gjlabels は段を floor で先に選んでから焼く（quantZoom の 0.25 刻みで境の手前に次の段の字が出ない）。
- 集約は source ごとに 1 回（data・半径・最大段・clusterProperties が同じ間は使い回す＝`clusterOf`）。旧＝層を足すたびに組み直し。
- 問い合わせ：`queryRenderedFeatures` の丸は gint／記号の当たり（`expansionZoom` も添える）・`querySourceFeatures` は今の段の地物（画面＋余白 1/4）・`getClusterExpansionZoom` は `byCid`。隠しの属性は `stripMl` が外す。
- **残す**：`map.gadget.cluster`（ネイティブの口）は cluster-2d のまま。

門：t-mlcompat の cluster-layer-zoom-range・cluster-properties-and-id・query-source-features（layers）・cluster-without-circle-layer（live）・t-mlzoom の expansionZoom・`tests/t-aggregate.mjs` ⑤（どの段も件数の和＝点の数・段ごとの地物＝buildClusters の段）。

## 4i. P3 の 5 本目＝ネイティブの記号の口（`map.gadget.symbols`・worldcontent）を注記層へ（**実装済**・2026-10-22）

- `symbolsNative`（`map.gadget.symbols` と世界帯の中身＝国名・首都／都市・空港）も §4g と同じく gjlabels の点置きへ。記号の gadget は評価だけ（`queryRenderedFeatures`・`styleimagemissing`）。
  注記層の組は `"n:<id>"`（MapLibre の層の id と分ける）・順の鍵は −1（利用者の MapLibre の層の後・基図の前）。型の無い層（worldcontent）は symbol として焼く。
- `horizon`（MapLibre に無い拡張・球の縁の近くは出さない）は `Label.hz` に写し、labels2d の衝突判定で symbols-2d と同じ式（余弦＝front／|E−u|）で外す。
- 記号の gadget は symbols-2d のオーバーレイを描く層がある時だけ作る（作った時に記号帳を写し直す）＝今は作らない。
- 試し：格子 216 点を z2.2／z4.5 で描いて目で見た（記号と字が注記層・horizon 0.35 で縁の 12 件が消える）。worldcontent の実物は bucket を引くので本人の端末で見る。

## 5. ベースライン記録欄（実機で埋める）

| 場面 | lab ms | collide ms | labels | glyphs | fps |
|---|---|---|---|---|---|
| labels-delft-z17.6-55t | | | | | |
| labels-delft-z15 | | | | | |
| labels-tokyo-z15 | | | | | |
| labels-tokyo-sta-z17.5-55t | | | | | |
| labels-world-z3 | | | | | |

## 6. 並走との取り決め

- S 計画：T-P0 の間は labels2d.ts の描画部分が大きく動く＝S 側は labels.ts（焼き込み）と配置の関数だけを触る（P0 は本 PR で終わり＝以後は通常どおり）。S の 3 つの求め（層の位置で描く・glyphs と text-font を読む・geojson の symbol を同じ経路に）は P2・P4・P3 で受ける。`Label` に項目が増えても TextSink の下は「位置・行列・色」しか見ない。
- V 計画：V-Ph2 と T-P1 は触るファイルが別（`gpu/renderer.ts` の地図側と新しい字のパイプライン）＝並走できる。共有は GPUDevice とデバイス喪失の後始末だけ。

## 7. 裁定一覧

| # | 問い | 裁定 |
|---|---|---|
| 1 | 字の元の既定 | **2026-10-22 本人**：style に glyphs があれば PBF＋漢字・かな・ハングルは端末フォント（MapLibre と同じ）。glyphs が無ければ (b)＝端末フォントだけ |
| 2 | WebGL2 は Canvas2D のままでよいか | `render roadmap.md` §5 #11 の推奨＝当面 Canvas2D（最前面）・T-P6 で移植 |
| 3 | P1 の字の質を見る端末 | `render roadmap.md` §5 #12 の推奨＝Mac の dpr 2 と外部モニタ等の dpr 1 の両方 |
