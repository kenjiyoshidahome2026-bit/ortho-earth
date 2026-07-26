# ortho-japan における z（ズーム）制御の全体像

この地図（ortho-japan / ortho-core / ortho-map）の「z」に対する制御を、①定義と数学 → ②ユーザー入力と状態 → ③z駆動のLOD・タイル・データ読み込み の順に全部まとめる。

engine（`packages/ortho-core`）＝純粋なカメラ/入力/飛行/URLの数学、renderer（`packages/ortho-map`）＝WebGL描画、app（`apps/ortho-japan/app.js`）＝配線、という3層構成。zは単一の可変オブジェクト `cam` の `cam.zoom`（float）に載る。getter/setterは無く、各所が直接 `cam.zoom` を読み書きして `onMove()` / `renderer.draw()` で再描画する。

---

## 0. 大前提：256px世界という目盛りの統一（2026-07-26）

すべての土台。zの目盛りは「256px世界」＝**赤道一周 = 2^z × 256 CSSpx**。v1(d3-geo)・地理院地図・OSM と同一目盛り。

- `WORLD_PX = 256` — [camera.js:9](../../packages/ortho-core/src/camera.js#L9)
- 旧実装は 512px世界（MapLibre流）で、同じ視野でもzが1小さく、gint式（256前提）やDEM段閾値と1段ズレていた。commit `1bdb053` / `f3c7694` の「256統一」でここへ寄せた。
- スケール⇄zの相互変換は**必ずこの定数を通す**。`scale = 40.74·2^z`（`40.74 = 256/2π`）、逆に `z = log2(scale/40.74)`。
  - [gintUtility.js:48](../../packages/ortho-map/src/workers/shared/gintUtility.js#L48)、workers各所
- localStorageのキーも `ortho-japan.cam256`（[app.js:670](../app.js#L670)）へ変更＝旧512世界の保存ビュー（zが1ズレ）を読まないため。

---

## 1. zの数学的定義：z → 解像度 → カメラ距離 → mat4

中枢は [camera.js](../../packages/ortho-core/src/camera.js) の `cameraState()`。

### z → カメラ距離
```
radPerDevPx = 2π / (2^z · 256 · dpr)          // camera.js:31 単位球の「1デバイスpxあたりラジアン」
camDist      = radPerDevPx · (H/2) / tan(fovy/2)  // camera.js:32 カメラ高さ（単位球ラジアン≈弧長）
```
- 単位球の赤道弧長 2π を `2^z·256` CSSpx（×dpr）で割ったのが角解像度。メートル毎ピクセルの球版。
- 透視投影の逆算：距離 `camDist`・半画角 `fovy/2` のとき画面高の半分 `H/2` px がちょうど狙いのラジアンを張るようにカメラを置く。**zが大きい＝camDistが小さい＝地表に近い**。

### camDist → view/proj行列（mat4）
[camera.js:35-61](../../packages/ortho-core/src/camera.js#L35-L61)
- eye = `T + back·camDist`（T＝単位球上の注視点）。lookAt + perspective で MVP を生成。
- **near/far が camDist にスケール**：`near = max(camDist·(0.3 − 0.27·pf), 1e-7)`（`pf = min(1, pitch/60°)`）、`far = limb·1.15 + camDist + push`（`limb`＝地平線距離）。極端なオーバーズームでも深度精度を保つため範囲をタイトに保つ。
- `mvp[0],[4],[8],[12]` を符号反転＝真上から見て東＝画面右。

### fovy（視野角）はzと分離
- `fovy = 50°` 固定（[camera.js:19](../../packages/ortho-core/src/camera.js#L19)）。camDistをfovyから逆算するので、どのfovyでも画面上の目盛りは `2^z·256` px/赤道に保たれる。
- fovyスライダーは「暴れる」ため撤回済み（[app.js:568](../app.js#L568) の教訓メモ）。動的な遠近の揺れ > 静的歪み。

### z は緯度に依存しない（cos(lat)を掛けない）★重要な設計判断
[camera.js:27-31](../../packages/ortho-core/src/camera.js#L27-L31)
- **z は正射スケールそのもの。同一zは緯度によらず同一倍率**（v1 d3-geoと同一定義）。
- 旧実装は ×cos(lat) のwebメルカトル互換で、北へパンするほど膨らんだ（那覇→札幌で約26%）＝違和感の元。
- `radPerDevPx` に cos(lat) は入らない。緯度は注視点位置 `T = lonlatTo3D(lon,lat)` にだけ効く。
- メルカトルタイルの緯度分の細かさ補正は**タイル選択（tilecover.selectLOD）の仕事**で、カメラには漏らさない。

---

## 2. zのユーザー入力と状態

### 状態の在り処
- `cam = { center, zoom, pitch, bearing, dpr }`（[app.js:657](../app.js#L657)）。
- 既定ビュー `JAPAN_VIEW = [137.628, 37.783, 5.86]`＝**z=5.86** の島俯瞰（[app.js:656](../app.js#L656)）。

### zのクランプ（3か所で独立に強制）
| 場所 | 範囲 | 位置 |
|---|---|---|
| engine `createInput` 既定 | 2..20 | [input.js:31](../../packages/ortho-core/src/input.js#L31) |
| app が createInput へ渡す | 2..21 | [app.js:1239](../app.js#L1239) |
| `applyCamView`（URL/復元/飛行先） | 2..21 | [app.js:663](../app.js#L663) |
| zoom gadget | 2..21 | [zoom.js:7](../gadgets/zoom.js#L7) |
| flight巡航フロア | `min(2, targetZoom)` | [flight.js:67](../../packages/ortho-core/src/flight.js#L67) |

実効レンジは **z ∈ [2, 21]**（z21 ≈ 7.5cm/px、精度は原点相対RTEが担保）。

### 入力ハンドラ（[input.js](../../packages/ortho-core/src/input.js)）
- **ホイール**：`cam.zoom -= e.deltaY * 0.002`（[input.js:180](../../packages/ortho-core/src/input.js#L180)）。⌘(Mac)/Ctrl(他)+ホイールは回転に切替。カーソル位置を `anchoredAt` で固定してズーム。
- **ピンチ**：`dz = log2(currentDist / prevDist)`（[input.js:153](../../packages/ortho-core/src/input.js#L153)）、ピンチ中心にアンカー。12px超で tilt/free モード確定。
- **キーボード**：Shift+↑↓でズーム、`KB_ZOOM = 0.028`/frame（[input.js:188](../../packages/ortho-core/src/input.js#L188)）。押下中はrAFループ。
- **ダブルクリックズームは無し**。
- **ズームボタン（gadget）**：`glide(delta)` が整数段へアニメ＝in `floor(z+1)`/out `ceil(z-1)`、260msスムーズステップ（[zoom.js:18-32](../gadgets/zoom.js#L18-L32)）。押下時に飛行をキャンセル。

### アニメ・イージング・慣性
- `flyTo`：van Wijk & Nuij 最適経路ズーム（ρ=√2、d3.interpolateZoomと同型）。巡航は線形（[flight.js](../../packages/ortho-core/src/flight.js)）。
- `glideTo`：近距離スムーズステップ（`e = k·k·(3−2k)`）。
- **慣性（inertia）は無し**。zは入力がアクティブな間だけ動く。ジェスチャーで飛行は即キャンセル（[app.js:1241](../app.js#L1241)）。

### 「静止時の手前詳細化」（commit `a44c7c8`）
`moving` フラグ（[app.js:249](../app.js#L249)）で駆動。`onMove()` で `moving=true` にし、150msの settle タイマーで `moving=false` に戻す（[app.js:606](../app.js#L606)）。
- **(a) タイル分割閾値の引き下げ**：静止時だけ `IDLE_TILE_PX = 256`（既定は560）を渡す（[app.js:248,1547](../app.js#L1547)）。手前（チルト下側）のタイルは画面上で大きいので先に閾値を超え、**手前だけ1段細かくなる**。
- **(b) terrainGate**：地形の標高アトラス再構築は静止時のみ（`terrainGate: !moving`、[app.js:582,1529](../app.js#L582)）。入力中は密な32×22グリッドの逆投影を走らせない。
- 巻き戻し防止：`STALE_ZOOMOUT = 0.5`（[app.js:241](../app.js#L241)）＝ロード済みシーンより0.5以上引くと古い詳細シーンを隠す。

### URL / 永続化
コーデックは [viewurl.js](../../packages/ortho-core/src/viewurl.js)。書式 `#zoom/lat/lon[/45t][/-30r][/l=…][/c=dark]`（GSI/OSMと同順）。
- zは第0セグメント、`toFixed(2)`（lat/lonは5桁≈1m）。
- 起動優先度：URL hash > localStorage(`ortho-japan.cam256`) > 既定。
- `saveView` は settle毎に `history.replaceState`（hashchangeは飛ばない）。手編集/貼り付けは `hashchange` で再適用。

### tilt/pitch と z の結合
- **自動チルト**：`flyTo` でチルト未指定なら **z≥15 で 45°**、未満は水平着地（[flight.js:25](../../packages/ortho-core/src/flight.js#L25)）。
- `MAXPITCH = 75°`（[app.js:651](../app.js#L651)）。
- フリーズーム中にpitchをzから連続導出はしない（自動チルトは `flyTo` 経由のみ）。

### カメラ地形クランプ（commit `89339d9`「Cesium流押し上げ」）
- engine側：eyeが地表に沈むと半径方向へ押し上げ（`cam.minEyeAlt`、[camera.js:38-56](../../packages/ortho-core/src/camera.js#L38-L56)）。注視点は保持＝実効pitchが滑らかに浅くなる。
- app側 `updateCamClamp()`（[app.js:564-594](../app.js#L564-L594)）：`getHeight(lon,lat, cam.zoom)` に**zを渡してDEM段（R90/R10/R01）を選ばせる**。マージン40m、10Hz制限、上げは即・下げは遅い非対称平滑、`pitch < 0.06`（ほぼ真俯瞰）では無効化。

---

## 3. z駆動のLOD・タイル・データ読み込み

### タイル座標とLOD選択
- `lonLatToTile(lon,lat,z)`＝標準Webメルカトル（[tile.js:4-9](../../packages/ortho-core/src/tile.js#L4-L9)）。
- 距離ベースのクアッドツリー選択 `selectLOD(cam,W,H,{...})`（[tilecover.js:14](../../packages/ortho-core/src/tilecover.js#L14)）：既定 `minZ=4, maxZ=16, tilePx=560`。画面上サイズ > 閾値なら分割。`sticky`/`stickyRatio=0.8` で親子振動を防ぐ。
- **3層ピラミッド**（[tilemanager.js:76](../../packages/ortho-core/src/tilemanager.js#L76)）：main（selectLOD）＋coarse下地（`maxZ≈round(zoom)-4`）＋blanket（固定z4の保証床）。
- **lodFloor**：`{ minViewZoom: 9, z: 8 }`（[app.js:621](../app.js#L621)）＝view z≥9でタイルLOD床をtile z8に強制（海のゲートに合わせる。optbvは海の全面WAをz8から供給）。

### z別のデータ層発火閾値（一覧）
| 層 | 閾値 | 位置 |
|---|---|---|
| ベースマップ（地理院タイル・地形・ラベル基盤） | view z≥5（`BASEMAP_MINZOOM`） | [app.js:244](../app.js#L244) |
| gintスロット切替（世界海岸線⇄ユーザー層） | `GINT_SWAP_Z = 7`、海岸線は z<9 のみ・maxZoom9 | [app.js:885,932](../app.js#L885) |
| 海/水域(WA) | view z≥9（`minzoom:9`）、z<9は「紙の海」 | [app.js:707](../app.js#L707) |
| 等高線 | z≥9 で描画、z17.5→19 でフェードアウト、間隔 15/30/60m(z≥15/≥12/他) | [renderer.js:644-652](../../packages/ortho-core/src/gl/renderer.js#L644-L652) |
| 駅ビーズ（在来） | z≥11.5 | [app.js:1158](../app.js#L1158) |
| 駅ビーズ（新幹線） | z≥7.5 | [app.js:1164](../app.js#L1164) |
| N02鉄道線 | z≥5（BASEMAP_MINZOOM） | [app.js:1139](../app.js#L1139) |
| 行政界（border GL） | z2..7 | [createLayers.js:68](../../packages/ortho-map/src/createLayers.js#L68) |
| PLATEAU 3D建物 | **z≥15 かつ pitch≥0.02** | [app.js:272,478](../app.js#L272) |
| 星空・夜・惑星 | z<5（`ensureStars`）、惑星等の動的importは z<4 | [app.js:958,950](../app.js#L958) |

### DEM/地形の段（gint切替点）
`selectRange(cam)`（[terrain.js:47](../../packages/ortho-core/src/terrain.js#L47)）：
```
z < 6.5              → R90（GEBCO 3.7km 全球）
z < 13（tilt>0.9なら<14）→ R10（中間）
それ以上              → R01（地理院DEM10B 10m DTM・都市）
```
- 混合アトラス：`pitch>0.9 && 11.5≤z<14` で手前3×3をR01・遠方をR10（[terrain.js:238](../../packages/ortho-core/src/terrain.js#L238)）。
- 地形は**チルト時のみ**有効化。標高はzでなくpitchでフェードイン（`pt=clamp((pitch-0.06)/0.14)`）。

### PLATEAU（autoPlateau）の詳細
- マスターゲート `PLATEAU_AUTO_Z = 15`（[app.js:272](../app.js#L272)）。`z<15` または `pitch<0.02` で全非表示・解放。
- 選抜は**bbox交差**（重心でない）＝`bboxIntersects(s.bbox, view)`（[app.js:495](../app.js#L495)）。チルト時は画面下端中央の「足元」点を主ソートキーに＝手前の区から読む。
- スロット `PLATEAU_MAX_ACTIVE = 4`（低メモリ1）。遠方退避は `PLATEAU_FAR_DEG = 0.5°`＝ズームアウトだけでは常駐区をevictしない。
- 区画着地は z15.5/tilt45°（[app.js:418](../app.js#L418)）または z16/45°。

### GPU頂点シェーダの動的LOD（gintの心臓）
[gintPrograms.js](../../packages/ortho-map/src/workers/shared/gintPrograms.js)
- 閾値uniform `u_lod_rank` を毎フレーム scale から算出：`dynamicLodRank(scale) = clamp(floor(3·log2(pxDeg)+61.524), 0, 63)`（[gintUtility.js:44-46](../../packages/ortho-map/src/workers/shared/gintUtility.js#L44-L46)）。
- 各頂点にVWランク（0-63）を格納。`lodSnap()` が `fetchRank(A) < u_lod_rank` の辺を**頂点シェーダでdiscard**（`gl_Position` をクリップ外へ）、次の残す頂点へ前方スナップ（arc末尾で停止＝gap無し）。
- **低ズーム＝生き残る頂点が減る＝CPUゼロで桁違いに軽い**。オーバーズーム側はランクが63で頭打ち＝全頂点保持でベクタは鮮明のまま（オーバーズーム罰則なし）。
- CPU側も `pickLineTier` で同じランド階段を先読み（同一可視ジオメトリを安く）。
- 塗り⇄アウトライン切替 `OUTLINE_ZOOM`＝データ由来（中央値ポリゴンbbox対角が4pxを跨ぐz、clamp 2-16、既定12）。

### z別のデータ解放（unload）
- PLATEAU：z<15 or near-flatで非表示・`plateauActive`クリア（VRAMは残し、0.5°超で真の削除）。
- タイル：LRU＋バイト予算（`memBudgetMB` 低メモリ24）、画面外の途中DLはabort。
- gint：単一スロットswap（海岸線とユーザー層は共存しない）。
- 標高：R10タイルLRU、アトラス再構築はsettle時のみ。
- 星空・ベースマップ：z<5で読み込み/停止を切替。

### オーバーズーム挙動（z16→21）
- ラスタ/ベクタタイルは `maxZ=16` で分割停止＝view z16-21はz16タイルの拡大表示。
- 等高線はz17.5→19でフェードアウト（DEM過拡大のボケ隠し）、間隔はz≥15で15mに詰める。
- DEMはR01（10m）が最細＝z13以上はR01の拡大。
- gint GPU-LODはオーバーズーム罰則なし（ランク63頭打ちで全頂点保持）。

---

## クイックリファレンス（主要定数）
| 量 | 値 / 式 | 位置 |
|---|---|---|
| 世界px | `WORLD_PX = 256` | camera.js:9 |
| 角解像度 | `2π / (2^z·256·dpr)` | camera.js:31 |
| カメラ距離 | `radPerDevPx·(H/2)/tan(fovy/2)` | camera.js:32 |
| 既定fovy | `50°` 固定 | camera.js:19 |
| scale↔z | `scale = 40.74·2^z` | gintUtility.js:48 |
| 既定ビューz | `5.86` | app.js:656 |
| 実効zレンジ | `[2, 21]`（z21≈7.5cm/px） | app.js:663 |
| ホイール | `zoom -= deltaY·0.002` | input.js:180 |
| キー | `KB_ZOOM = 0.028`/frame | input.js:188 |
| ピンチ | `dz = log2(d/prevD)` | input.js:153 |
| ボタングライド | 260msスムーズステップ→整数段 | zoom.js:23 |
| 自動チルト | z≥15→45°（flyTo着地） | flight.js:25 |
| 静止詳細化 | `IDLE_TILE_PX=256`(既定560)・settle150ms | app.js:248,606 |
| 地形クランプ | margin40m・pitch<0.06で無効 | app.js:571,586 |
| BASEMAP_MINZOOM | 5 | app.js:244 |
| GINT_SWAP_Z | 7 | app.js:885 |
| lodFloor | view z≥9→tile z8 | app.js:621 |
| 海 minzoom | 9 | app.js:707 |
| DEM段 | R90→R10=z6.5、R10→R01=z13(tilt>0.9で14) | terrain.js:49 |
| 等高線 | z≥9描画・z17.5-19フェード・間隔15/30/60m | renderer.js:644-652 |
| selectLOD | minZ4/maxZ16/560px | tilecover.js:14 |
| GPU LODランク | `clamp(3·log2(pxDeg)+61.524,0,63)` | gintUtility.js:46 |
| PLATEAU_AUTO_Z | 15（かつpitch≥0.02） | app.js:272 |
| 駅ビーズ | 在来11.5 / 新幹線7.5 | app.js:1158,1164 |
| 行政界GL | z2-7 | createLayers.js:68 |

---

## 一枚で言うと

**zは `cam.zoom`（float, [2,21]）ただ一つ**。256px世界の目盛りで、緯度に依存しない正射スケール。zは①`camera.js`でカメラ距離とmat4を決め、②`input.js`/`flight.js`/`zoom.js`でユーザー入力・飛行・ボタンが動かし、③`tilecover`/`terrain`/`app.js`の多数の閾値（BASEMAP5・GINT_SWAP7・lodFloor9・PLATEAU15…）とGPU頂点シェーダの`u_lod_rank`が、どのタイル・地形段・3D建物・等高線・ラベルを出すかを段階的に切り替える。「静止時の手前詳細化」と「カメラ地形クランプ」はzに直接ぶら下がる最近の2大挙動。
