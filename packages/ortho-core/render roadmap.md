# 描画の統合ロードマップ（2026-10-22 起案）

位置づけ：同じ日に起案した 3 本の計画を **1 本の優先順位** に並べ直したもの。個々の設計・門・逃げ道は各計画が正本で、ここは「どの順で・何を待って・何を一緒にやるか」だけを書く。
実装は本計画の外＝**着手は本人裁定**（`perf plan.md` と同じ）。

| 略号 | 計画 | 所在 | 段 |
|---|---|---|---|
| **S** | MapLibre style 互換の向上 | Claude Doc「MapLibre スタイル互換性の向上計画」（台帳の正典は `packages/globe/maplibre-compat.md`） | P0 物差し／P1 基図の絵／P2 層順と文字／P3 細目 |
| **T** | テキスト描画の WebGPU 化 | Claude Doc「テキスト描画のWebGPU化計画」 | P0 TextSink 切り出し／P1 線沿い GPU／P2 全文字 GPU・層の位置で描く／P3 記号・標識・symbols-2d／P4 glyph PBF／P5 投影 GPU／P6 WebGL2 |
| **V** | ベクタータイル描画の高速化 | `packages/ortho-core/vt perf plan.md`（PR #525） | Ph0 計器／Ph1 tile worker 速攻／Ph2 GPU 常駐プール（旧 perf plan P2）／Ph3 paint 表／Ph4 結合頻度 |

以下、項目は「S-P1-2」（S の P1 の 2 番）・「T-P2」・「V-Ph2」のように指す。

## 0. 結論（要約）

1. **最初の 1〜2 週はクラウドで完結する物だけ**：3 本の計器・物差し（S-P0・V-Ph0・T-P0 の計測場面）と、絵を変えない安い高速化（V-Ph1）、TextSink の切り出し（T-P0）。GPU 実機を待たずに進み、後の優先度の根拠が数字で出る。
2. **線の頂点形式を 1 回で決める**：S-P1-1（cap/join）・S-P1-3（線幅の上限・破線）・V-Ph1 §3.2（2D の細分停止）・V-Ph2（line を storage レコード化）は全部 `build.ts` の線と scene worker の 8×u32 レコードを触る。**V-Ph2 の step A より前に線レコードの形を確定**させ、2 度作り直さない。
3. **「ズーム連続」は 1 回だけ作る**：S-P1-2（z と z+1 を頂点に焼きシェーダで補間）と V-Ph3（paint 表＝zoom だけの式は毎フレーム表を書く）は同じ問題を別の方法で解いている。**V-Ph3 の paint 表に一本化**し、S-P1-2 の z/z+1 焼きは paint 表の (c) 類（zoom×データの混合）の受け皿に使う。式の分類（a/b/c）は S 側の `expr.ts` に `kind` を足す小物として **S-P0 に前倒し**する＝V-Ph3 の待ちが消える。
4. **層順の本工事は T-P2 → S-P2 の順**（既に両計画で合意済み）。T-P2 は「地図パスの中で層ごとの範囲を draw」なので、**V-Ph2 の render bundle（step B）を層の境で割れる形**にしておく。
5. **WebGPU の検定は本人の Mac でしかできない**＝実機の日を束ねる（§4）。クラウドの器で進む物（node の検定・GL2・SwiftShader）を先に、実機確認が要る物は 1 回の実機日にまとめて見る。

## 1. 依存の図

```
                         ┌──────────── S-P0 物差し（＋式の分類 kind を前倒し）
                         │                     │
 V-Ph0 計器 ─→ V-Ph1 速攻 ┤                     ├──→ V-Ph3 paint 表 ＝ S-P1-2 ズーム連続（一本化）
                         │                     │         └→ S-P1-3 線幅 u8 上限は表の f32 で自然に解ける
 S-P1-1 cap/join ────────┼─→ 線レコード確定 ──→ V-Ph2 GPU 常駐プール（step A→B→C→D）
 S-P1-3 破線アトラス ────┘                                   │ bundle を層の境で割れる形に
                                                             ▼
 T-P0 TextSink ─→ T-P1 線沿い GPU ─────────────────→ T-P2 全文字 GPU・層の位置で描く
                                                             │
                                                             ├──→ S-P2-1/2 層順の一本化・基図の moveLayer
                                                             ├──→ T-P3 記号・標識・symbols-2d ＝ S-P2-4
                                                             └──→ T-P4 glyph PBF ＝ S-P2-3（既定は裁定済み）
                                                                       → T-P5 投影 GPU → T-P6 WebGL2 移植
```

## 2. 優先順位付きの段（波）

各波の中の項目は互いに独立で、並走してよい。波の出口の門を通ったら次の波へ。見立ての日数は各計画の数字の和。

### 波 1 計器と物差し（クラウドで完結・1〜1.5 週）

| 順 | 項目 | 中身 | 出口の門 |
|---|---|---|---|
| 1 | **V-Ph0** | 計器 e（要求→画面の中央値／p90）・計器 f（結合の量）・bench-tile に都心 z16 と富士 z13 の見本 | `vt perf plan.md` §8 の表が Mac の 3 行埋まる |
| 2 | **S-P0-1・2・4** | MapLibre expression-tests の node の門・v8.json の網羅表の自動生成・公式例の爪車を o1014 に揃える | 外の分母が npm test に乗る・known.json の未反映 11 件が解消 |
| 3 | **S-P0 追加：式の分類** | `expr.ts` の compile に `kind`（constant／zoom／data／zoom×data）を足す。網羅表と同じ走査で実在 style 14 本の層を分類し件数を出す | expression-tests 緑・分類の件数表（V-Ph3 の設計材料） |
| 4 | **T-P0** | labels2d の描画呼び出しを TextSink に、字の寸法を口に切り出す（Canvas2D 版で同じ絵）。計測場面（デルフト・東京 z15・世界 z3）と `?perf=1` の注記の行 | `labels2d.mjs` 全通過・t-mlcompat 不変・画素一致 |
| 5 | S-P0-3・5 | 実在 style コーパスの集計スクリプト・入口の validate 警告 | 「出現×未対応」の順位が毎回同じ式で出る |

取り決め（T 計画から引き継ぎ）：T-P0 の間は labels2d.ts の描画部分が大きく動く＝S 側は labels.ts（焼き込み）と配置の関数だけを触る。

### 波 2 絵を変えない速攻と線の形（1〜1.5 週・実機日 1 回）

| 順 | 項目 | 中身 | 出口の門 |
|---|---|---|---|
| 6 | **V-Ph1 §3.1** 優先付き共有キュー | 主層→下地→毛布・画面中心の距離順で空いた worker に渡す | 主層の要求→画面 中央値が下がる・`?tileq=0` |
| 7 | **V-Ph1 §3.3** fill の clip 省略 | extent 内のポリゴンは clip を飛ばす | `bench-tile --hash` 同値 |
| 8 | **S-P1-1** line-cap・line-join | butt/square/miter/bevel・miter-limit・round-limit を基図・vtdraw・gint で。**GL2 を先に入れる**（S 計画 P1-5 と同じ理由） | 互換の爪車・14 本で「端・継ぎ」の未対応 0 |
| 9 | **V-Ph1 §3.2** 2D の線細分停止 | `drape:false` の時は細分しない（低 z は粗く残す） | t-linedeco・2D 東京 z13 の readback 一致・`?linesub=1` |
| 10 | **S-P1-3（破線）** | dasharray を破線アトラス（LineAtlas 相当）で任意長に。今の CPU で刻む破線（`build.ts`）を置き換える | 地理院 3 本の 32 層が同じ絵に近づく |
| — | **線レコードの確定** | 8・9・10 を通した後の線の頂点／レコードの形（端・継ぎの旗、破線の距離、幅の精度）を文書に固定 | V-Ph2 step A の入力が決まる |

8〜10 の順の理由：3 つとも `build.ts` の線の吐き出しを触る。cap/join が一番レコードを変えるので先、細分停止は cap/join の継ぎ目の扱い（細分点は join 不要の「内側の点」）を前提に、破線はその上に乗る。
実機日 ①：8 と 10 の WebGPU 版をまとめて Mac で確かめる。

### 波 3 本線の大物 2 本を並走（2〜3 週・実機日 2 回）

| 順 | 項目 | 中身 | 出口の門 |
|---|---|---|---|
| 11 | **V-Ph2** GPU 常駐プール＋タイル単位 draw | step A プールと転送 → B render bundle → C フェードと LOW_MEM → D 結合側の後始末 | classic と md の絵一致・`[scene] apply` 4ms 超が 3 シーンでゼロ・`?nomd=1` |
| 12 | **T-P1** 線沿いの注記を GPU へ | SDF アトラス（Canvas2D→EDT）・字のパイプライン。足場の最前面 webgpu canvas | デルフト 60fps・注記 CPU 1ms 未満・字の質を実機で目視 |
| 13 | S-P1-4・5 | 模様（fill/line/background-pattern）・`*-translate`・line-blur・circle-blur（GL2 先） | 互換の爪車・basemap looks different の減少 |

V-Ph2 への追加の求め（T-P2 のため）：**render bundle は層の添字 `li` の境で割れる単位で記録**する（`executeBundles` に層ごとの bundle 列を渡し、その間に注記の draw を挟めるように）。プールのアロケータは名前付きで汎用にしておく（V 計画 §7）が、注記は毎フレームの `writeBuffer`（5,000 字で 240KB）なので、**glyph をプールに載せるのは必要が出てから**でよい（T-P5 で経緯度を常駐させる時が候補）。
V-Ph2 と T-P1 は触るファイルが別（`gpu/renderer.ts` の地図側と、新しい字のパイプライン）＝並走できる。共有するのは GPUDevice とデバイス喪失の後始末だけ。
実機日 ②：V-Ph2 step A の絵一致。実機日 ③：V-Ph2 step B＋T-P1 の字の質。

### 波 4 互換の構造を変える 2 本（3〜4 週）

| 順 | 項目 | 中身 | 出口の門 |
|---|---|---|---|
| 14 | **V-Ph3 ＝ S-P1-2** paint 表とズーム連続（一本化） | 頂点に paint slot（u16）・層ごとの表を storage に。(a) constant／zoom → 毎フレーム現在 zoom で表を書く＝連続補間 (b) data → タイル z で焼いた行 (c) zoom×data → **S-P1-2 の z と z+1 を頂点に焼きシェーダで補間**。線幅は表の f32 で持つ＝**S-P1-3 の u8 上限もここで解ける** | テーマ切替で tile worker が働かない・ズーム連続の線幅が MapLibre の例と一致・`?paintbake=1` |
| 15 | **T-P2** すべての文字を GPU・層の位置で描く | 点の注記・複数行・format・縦書き・run sprite。地図パスの中で層ごとの範囲を draw。既定を GPU に | t-mlcompat?g=vector の symbol-* 同じ答え・層順の場面が MapLibre と同じ絵 |
| 16 | V-Ph4 結合頻度 | md で要求の間引きを詰める | 引っ掛かり 0 のままパン中の白抜きが縮む |

14 と 15 の順：14 は V-Ph2 の後でないと表を読むシェーダの置き場が二重になる（classic と md の両方に書くことになる）。15 は V-Ph2 の bundle の割り方を前提にする。両者は独立＝並走可。
14 の (c) 類の件数が 14 本の実在 style で少なければ（波 1 の分類の件数表で判る）、z/z+1 焼きは後回しにして (c) は従来どおりタイル z で焼く＝14 の見立てを縮められる。

### 波 5 層順の一本化と字形（3〜4 週）

| 順 | 項目 | 中身 | 出口の門 |
|---|---|---|---|
| 17 | **S-P2-1・2** 層順の一本化・基図の moveLayer | 描く段の固定順を style の層順 1 本の列に。#123 のアンカー表を基図へ | 地理院標準地図を MapLibre と並べて重なり順の違い 0 |
| 18 | **T-P3 ＝ S-P2-4** 記号・標識・symbols-2d の合流 | sprite を記号アトラスへ・標識を焼いて同じアトラスへ・geojson の点置き symbol を labels2d に | WebGPU で Canvas2D を使うのが「字を焼く」だけに |
| 19 | **T-P4 ＝ S-P2-3** glyph PBF | style に glyphs があれば PBF を既定、漢字・かな・ハングルは端末フォント（**裁定済み 2026-10-22**） | 公式例の字形の差が減る・CJK の質が今と同じ |
| 20 | S-P2-5 小口 | symbol-avoid-edges・icon-keep-upright・symbol-z-elevate・distance-from-center | 互換の爪車 |

19 は T 計画のとおり T-P1 の後ならいつでも並行できる（アトラスの形が同じ）。ここに置くのは、17・18 で注記の経路が 1 本に揃った後の方が PBF の字送りを入れる箇所が 1 か所で済むから。

### 波 6 仕上げ（各 1 週前後・必要が出た順）

- **T-P5** 点の注記の投影を GPU へ（移動中の CPU と転送を減らす）。
- **T-P6** WebGL2 版の字のパイプライン。これが入るまで WebGL2 だけ注記は最前面＝層順が MapLibre と違う（台帳 §4 に記録）。
- **S-P3** 細目（line-gradient・lineMetrics・circle-pitch-*・fill-extrusion-pattern/-translate・hillshade-illumination-anchor・clusterMinPoints・`*-layer-opacity`・fadeDuration・calculateAnchoredCameraOptions・qRF の近似）。
- 棚（V 計画 §9）：earcut の凸の早道・pre-tessellated MLT・WASM は扱わない。

## 3. 計画間の重なりと取り決め

| 重なる所 | 関わる項目 | 取り決め |
|---|---|---|
| 線の頂点／レコード形式 | S-P1-1・S-P1-3・V-Ph1 §3.2・V-Ph2 step A・V-Ph3 | 波 2 の最後に形を確定してから V-Ph2 step A。V-Ph3 の paint slot（u16）の置き場も同時に予約しておく |
| ズーム連続 | S-P1-2・V-Ph3 | V-Ph3 に一本化。S-P1-2 は (c) 類の受け皿として V-Ph3 の中で実装 |
| 式の分類 | S（`expr.ts`・`mlstyle.ts`）・V-Ph3 | 分類は S の領分のまま、S-P0 に前倒しして件数表まで出す。V-Ph3 はその `kind` を読むだけ |
| 線幅の上限 | S-P1-3・V-Ph3 | u8 の表を広げる作業は V-Ph3 の f32 の表で兼ねる。V-Ph3 より前に急ぐなら u16 に広げるだけの小修正 |
| 層順と描画パス | T-P2・S-P2・V-Ph2 step B | bundle は層の境で割れる単位。注記は層ごとの範囲 `[始点, 件数]` を同じ境で差し込む |
| 注記の配送 | V-Ph1 §3.4・T-P0〜P2 | V 計画の推奨どおり T 側に委ねる。§3.4 は波 2 から外し、T-P2 で注記の通り道を決める時に一緒に扱う |
| GPU のアロケータ | V-Ph2・T（glyph／インスタンス） | V-Ph2 で名前付きの汎用アロケータに。注記が使うのは T-P5 で常駐が要る時 |
| labels2d.ts の編集 | T-P0・S（配置・焼き込み） | T-P0 の間は S は labels.ts と配置の関数だけ |
| デバイス喪失・readback | V-Ph2・T-P1 | 地図の復帰と同じ後でアトラスとプールを作り直す。T-P1 の足場の間は readback の口を地図に揃える |
| 実機検定 | S-P1（WebGPU 版）・V-Ph2・T-P1〜P2 | §4 の実機日に束ねる |

## 4. 実機日の束ね方

WebGPU の絵はクラウドの器（SwiftShader の GL だけ）で検定できない。各波で「クラウドで緑になった物」を溜めて、本人の Mac で 1 回にまとめて見る。

| 実機日 | 見る物 | 物差し |
|---|---|---|
| ① 波 2 の後 | S-P1-1 cap/join・S-P1-3 破線の WebGPU 版・V-Ph1 の効き | verify:examples・`bench-perf.mjs` 3 シーン（計器 e） |
| ② 波 3 前半 | V-Ph2 step A の classic と md の絵一致 | `webgpu port.md` の標準 8 ビュー＋東京駅 PLATEAU の readback |
| ③ 波 3 後半 | V-Ph2 step B・T-P1 の字の質（dpr 2 と dpr 1） | `[scene] apply` 4ms 超・gpuMap・デルフト 60fps |
| ④ 波 4 の後 | V-Ph3 の線幅の連続・T-P2 の層順の場面・既定を GPU に切り替えてよいか | 地理院標準・liberty を MapLibre と並べる |
| ⑤ 波 5 の後 | S-P2 の重なり順の違い 0・PBF の字形・iPhone（LOW_MEM） | 同上＋iPhone の 3 行 |

## 5. 裁定待ち一覧（3 計画を統合・重複を除いた版）

決まった物：**glyph の既定**＝style に glyphs があれば PBF、漢字・かな・ハングルは端末フォント（MapLibre と同じ形）。2026-10-22 に本人が T 計画のカードで選択。9/28 の裁定 (b) はこの範囲で置き換わる。
「建物の陰の道の名は隠さない」（2026-10-13）は引き続き有効。

| # | 項目 | 元 | 選択肢 | 推奨 |
|---|---|---|---|---|
| 1 | 全体の着手順 | 本計画 | 本計画の波 1→6／各計画を別々に進める | **波 1 から**（クラウドで完結する計器と物差しを先に） |
| 2 | S-P1-2 と V-Ph3 の一本化 | 本計画（新） | V-Ph3 の paint 表に一本化／S-P1-2 を先に単独で入れる | **一本化**（同じ問題を 2 回解かない。代わりに S-P1-2 は波 4 まで待つ） |
| 3 | 式の分類の前倒し | S・V §10 #4 | S-P0 で分類まで出す／V-Ph3 の時に決める | **S-P0 に前倒し**（小物で、V-Ph3 の待ちが消える） |
| 4 | 線レコードを V-Ph2 の前に確定 | 本計画（新） | cap/join・破線を V-Ph2 より先／V-Ph2 を先にして後で形を変える | **先に確定**（storage レコードの作り直しを避ける。V-Ph2 の着手は 1 週ほど遅れる） |
| 5 | V の Phase 1→2 の順 | V §10 #1 | Ph1→Ph2／Ph2 を先に | **Ph1→Ph2** |
| 6 | V-Ph2 の LOW_MEM | V §10 #2 | classic 維持／全端末 md | **classic 維持** |
| 7 | V-Ph2 のフェード | V §10 #3 | 落とす／タイル α | **落とす** |
| 8 | 2D の線細分の判定 | V §10 #5 | 地形の有無で再ビルド／線を 2 系統 | **再ビルド** |
| 9 | 注記の別メッセージ化（V §3.4） | V §10 #6 | V-Ph1 で先に／T に委ねる | **T に委ねる**（T-P2 で一緒に） |
| 10 | 層順の一本化に踏み込むか | S | T-P2 の後にやる／意図した違いのまま | **T-P2 の後にやる**（地理院 444 層・14 本中 10 本に効く） |
| 11 | WebGL2 の注記 | T | 当面 Canvas2D（最前面）・T-P6 で移植／移植しない | **当面 Canvas2D・T-P6 で移植**（それまで台帳 §4 に記録） |
| 12 | T-P1 の字の質を見る端末 | T | dpr 2 だけ／dpr 1 と 2 | **Mac の dpr 2 と外部モニタ等の dpr 1 の両方**（SDF の潰れは dpr 1 で出やすい） |
| 13 | 優先する style | S | — | **OpenFreeMap liberty と地理院標準地図** |
| 14 | render-tests を物差しに | S | 加える／今は加えない | **今は加えない**（平面メルカトル前提の画像） |
| 15 | 目標値 | S | — | 波 2 の後に basemap looks different を 29→半分、波 5 の後に地理院標準の重なり順の違い 0 |

## 6. やらない事

- 各計画の「やらない事」をそのまま引き継ぐ（衝突判定の GPU 化・MSDF・WASM の earcut／merge・GL2 への性能投資・multi-draw-indirect・本人裁定の「意図した違い」の変更）。
- 本計画は順番と取り決めだけ。各項目の設計を変える時は各計画の正本を直し、ここは参照の行だけ直す。
