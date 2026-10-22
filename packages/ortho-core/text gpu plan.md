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
| geojson の symbol | `globe/src/symbols-2d.ts` | 別の 2D オーバーレイ（箱・候補の式を二重に持つ） |
| 集約の件数 | `globe/src/cluster-2d.ts` | 別の 2D オーバーレイ |
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
| **P1** 線沿いの注記を GPU へ（中） | SDF アトラス（Canvas2D→EDT）・字のパイプライン。今の字形アトラスの経路を置き換える。描く先は注記の OffscreenCanvas に同じ GPUDevice で据えた webgpu（最前面の足場） | デルフト 60fps・注記の CPU 1ms 未満・字の質を実機の **dpr 2（Mac）と dpr 1（外部モニタ等）** で本人が目視（「鬱・龍・護」を Canvas2D と並べる） | `?text=2d` |
| **P2** すべての文字を GPU へ・層の位置で描く（大） | 点の注記・複数行・format・縦書き。部分文字列の幅で字の x・繋げる文字は run sprite。描く場所を地図のパスへ移し層ごとの範囲で draw。足場の canvas を外し既定を GPU に | t-mlcompat?g=vector の symbol-* が同じ答え・層順の場面（注記の後に線が来る style）が MapLibre と同じ絵・東京 z15 の Canvas2D との差分画像を本人が確認 | `?text=2d` |
| **P3** 記号・標識・geojson の symbol・星空（中） | sprite を RGBA の記号アトラスへ・標識は番号ごとに焼いて同じアトラス・星空と月も TextSink 経由。symbols-2d を labels2d に合流（同じ衝突判定・層順）・cluster-2d も同じ口 | WebGPU で注記に Canvas2D を使う箇所が「字を焼く」だけ | `?text=2d` |
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
