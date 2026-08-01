# WebGPU バックエンド移植（src/gpu/）

位置づけ：アプリ化ラダー③（実機計測→PWA→**WebGPU**→薄い殻）。フル書き直しではなく**臓器移植**＝
`createRenderer`（WebGL2）と同じ公開面 `{ set, draw, dispose, md, mdMax, gintCtx }` を持つ
`createRendererGPU` を並走させ、renderworker が起動時に選ぶ。**WebGL2 は恒久フォールバック**（旧iOS/Android）。

## 現在地（Phase 1・2026-08-01）

動く：globe（大気・リム）＋基図シーン（fill/line・**classic merge 経路**＝scene worker の CPU merge、
`?nomd=1` と同じ実証済みパス）。z13 東京・z5.5 全国で WebGL2 と目視同一（スクリーンショット比較済）。
真俯瞰の平面地図と同等の絵＝2D 利用は今日から差が無い。

未搭載（set は握り潰し・初回のみ console 告知）：標高/地形・建物3D・PLATEAU・overlay(stencil)・
星空/夜面・**gint**（canvas は1コンテキスト制＝webgl2 と同居不可。gint の WGSL 移植は Phase 3）・
snapshot の基図読み出し（labels のみ返す＝compose は base 無し許容）。

## 使い方・検証

- `?gpu=1` … WebGPU バックエンド。非対応/失敗は worker 内で WebGL2 へ自動フォールバック（挙動同一）。
  既定経路には dynamic import すら発生しない＝バンドル分離（build で `backend-*.js` 約14KB が別チャンク、
  renderworker 本体には入らない）。
- `npm run verify:webgpu` … 実時間 CDP スモーク（t-webgpu.html）。frame1 到達＋backend 確認。
- **轍：`--virtual-time-budget`（verify:ui の headless 流儀）と WebGPU は両立しない**。
  requestAdapter/requestDevice は実時間の GPU IPC＝ページの仮想時計が先に燃え尽き、worker の
  rAF/タイマーが凍った後に device が届く→「実機は健全なのに CI だけ frame1 が来ない」偽陽性。
  だから t-webgpu は verify-ui.mjs の PAGES に載せず、実時間の verify-webgpu.mjs で回す。

## 設計メモ（GL との差分）

- **クリップ z**：GL [-1,1] → WebGPU [0,1]。対数深度は `z01 = 0.5·log2(1+w)·coef` を直接書く
  （GL の window 深度と同値＝深度互換）。wgsl.js `logDepthZ`。
- **smoothstep 逆順引数**：GLSL は黙認・WGSL は未定義動作明記＝`1-smoothstep(正順)` へ等価書換（globe）。
- **uniform**：per-draw の gl.uniform* → 1フレーム1回の UBO 書込。base/main の2スロットを 256B 境界で
  1バッファ同居（origin がスロット毎に違うため）。詰め順は renderer.js `packFrame` と wgsl.js `Frame` が対。
- **MSAA**：canvas 属性でなく明示 4x テクスチャ→resolveTarget。動的解像度のリサイズは
  getCurrentTexture が canvas 寸法に自動追随＝再 configure 不要。
- **数学は 1:1**：sinP テイラー・deltaToRel（桁落ち回避 RTE）・capsule SDF・フォグ・海のズームゲート・
  下地線の伏せ（mainLinesOn）まで GL 版と同式・同分岐。

## 次の道順

1. **Phase 2**：標高（R16F アトラス→texture_2d<f32>＋sampler）・地形サーフェス・深度バッファ・建物押し出し。
2. **Phase 3**：gint（RGBA32UI テクスチャ群→storage buffer が自然。頂点プル前提の設計はそのまま乗る）。
3. **multi_draw の後継**：WebGPU に multiDraw は無いが、(a) `drawIndexed` に **baseVertex がある**＝
   index 再ベース（sceneworker ensureUploaded の絶対頂点番号化）ごと不要にできる、
   (b) **render bundle** で composition を1回記録→毎フレーム再生＝md の狙い（CPU発行ゼロ）を
   タイルプール常駐のまま置換できる。md プロトコル（grow/up/dl）は流用可能な見立て。
4. **動的解像度の将来形**：canvas リサイズでなく**中間ターゲットの解像度スケール＋blit**（リサイズ由来の
   白フラッシュを構造から消す。現在は renderworker の「リサイズは描画フレーム先頭で適用」で既に無害化済み）。
5. timestamp-query（GPU 実時間）を tqSpan 相当へ＝動的解像度・GPU格付けの物差しを WebGPU でも回復。
