# HEALPix タイル ── 規約と段取り（2026-11-26 起案）

位置づけ：メルカトルの XYZ（`tile.ts`）を**置き換えず**、全球の自前データを載せる「もう 1 つのタイル行列」として HEALPix を**足す**（本人 2026-11-26「置き換えるというより追加」）。
`docs/notes/raster-tiles.md` の残「非メルカトルのタイル行列」の答え。外来の物（地理院・PMTiles・MapLibre／Cesium の顔）はメルカトルのまま。

- 純関数：`packages/ortho-core/src/healpix.ts`（検定 `tests/healpix.mjs`＝healpy 1.20 の値と突き合わせ）
- 標高を読む：`packages/ortho-core/src/elevation/healpixread.ts`（経緯度の窓を HEALPix タイルから埋める・検定 `tests/healpix-read.mjs`）・`healpixsrc.ts`（地形のセルとして出す源・`?hpx=1`・検定 `tests/terrain-hpx.mjs`）
- 標高の焼き：`packages/ortho-core/src/elevation/healpixbake.ts`（検定 `tests/healpix-bake.mjs`）・`packages/ortho-core/scripts/bake-healpix-elev.mjs`
- ベクタを切る：`packages/ortho-core/src/healpixvt.ts`（§5・検定 `tests/healpix-vt.mjs`）
- 本人向けの設計案＝Claude Doc「HEALPixタイルをV3の中核に据える設計案」

## 1. 規約

| 物 | 決め |
|---|---|
| 並び | NESTED。タイル（order k・番号 npix）＝ `face·4^k + interleave(ix, iy)`（ix が偶数位・iy が奇数位） |
| 角度 | φ＝東経・z＝sin(緯度)。**緯度は測地緯度のまま**（等積緯度へは直さない＝表示用。面積を数える用途は呼び手が直す） |
| 面内の座標 | 面は単位正方形・x＝ix の軸（北東へ）・y＝iy の軸（北西へ）。セルの隅＝南 (0,0)・東 (1,0)・西 (0,1)・北 (1,1) |
| タイルの画素 | 幅 W（2 の冪）・行優先・**列＝ix・行＝iy**。画素 (col,row) の中心＝ `x=(ix+(col+0.5)/W)/2^k`・`y=(iy+(row+0.5)/W)/2^k` ＝ちょうど order k+log2(W) のセル |
| 親子 | 子 i（0..3）は列 `(i&1)·W/2`・行 `(i>>1)·W/2` の象限。親＝子 4 枚の 2×2 平均 |
| 鍵 | `hpxId`＝HEALPix の UNIQ（`4·4^k + npix`）＝ order を跨いで一意（メルカトルの `tileId` に当たる） |
| 置き場 | HiPS と同じ `Norder{k}/Dir{⌊npix/10000⌋·10000}/Npix{npix}.{ext}` ＋ `properties` |
| 縁 | ファイルには重なりを焼かない（画素＝セルの 1 対 1 を保つ）。継ぎ目は読む側が隣の 1 画素を借りる（`hpxWrap`・`hpxNeighbors`） |

タイルの大きさの目安（幅 512）：1 画素＝58.6°/(512·2^k)。Norder k はメルカトルの z ≒ k+2.6（赤道・同じ画素数のタイル）。

### タイルの中の座標＝V3 の方式（仮決め・本人 2026-11-27）

タイルの中の座標は、HEALPix の平面（Calabretta & Roukema）を 45° 回して、基底の面と子のセルが軸に平行な正方形になる**面ごとの (x, y)** に統一する
（＝上の表の「面内の座標」「タイルの画素」そのもの＝列が x・行が y・行 0 が南の隅の側）。階層と置き場は HEALPix NESTED・HiPS のまま。
画素の向きは公式 HiPS（hipsgen・Aladin Lite）には**そろえない**（照合もしない）＝標高も、先々の画像・ベクタ（OSM を同じ座標で切る）も、この向きで揃える。
今の標高タイル（2026-11-27 の焼き）は最初からこの向き＝作り直しは要らない。縁の重ね（隣の 1 画素を焼き込む等）は必要になった時に足してよい（今は無し）。

## 2. 標高タイル（大元＝R90〜R10）

本人裁定（2026-11-26）：**大元は R90〜R10 をベースにする**＝今の地形（`terrain.ts`）と同じ値の系列から焼く。

| 段 | 大元 | 1 画素 | 枚数 |
|---|---|---|---|
| Norder 0〜2 | R90（8 枚・2700²＝0.033°） | 0.115°〜0.029° | 12＋48＋192 |
| Norder 3〜5 | R10（648 枚・2400²＝0.0042°・日本域は GEBCO＋DEM10B） | 0.014°〜0.0036° | 768＋3,072＋12,288 |

- 各系列の最も細かい order（2 と 5）を大元からバイリニアで標本化し、その上の order は 2×2 平均で積む。
- 標本化は全球の画素格子で行う（画素中心の規約＝`elevation.ts` と同じ `gx = u·w − 0.5`・経度は 180° で巻く・緯度は極でクランプ）＝大元のセルの境で継ぎ目が出ない。
- GEBCO の R10 は高緯度で経度方向を間引いてある（南端の緯度が ±80° 以遠＝400×2400・±70°＝800・±60°＝1200・±50°＝1600・`apps/uploader/src/terrain/gebco.ts` の shrink）。
  画素 i は間引く前の画素 i·k の位置の値（左寄せ）＝焼き手は帯ごとの幅と位置で引く（`gebcoR10Width`・2026-11-27 に Mac の本焼きで判明）。
- 値は大元のまま（海底の負値も通す・0 へ寄せない）。丸めて捨てるのは消費側。
- 中身は altpbf（Int16・行優先）。名前＝`H{order 2 桁}P{npix}`・`lng`/`lat`/`range` は 0（経緯度のセルでない印）。
- Norder 2（R90 由来）と Norder 3（R10 由来）の間は値の系列が変わる＝今の R90／R10 の切り替え（z5.5）と同じ性質。

```
node packages/ortho-core/scripts/bake-healpix-elev.mjs --src R90 --order 2 --min-order 0
node packages/ortho-core/scripts/bake-healpix-elev.mjs --src R10 --order 5 --min-order 3    # --resume で続きから
```

目で確かめる＝`node packages/ortho-core/scripts/hpx-elev-preview.mjs --order 5 --bbox 128,30,146,46 --width 2400`（正距円筒の段彩 PNG・`--grid` でタイルの境）。

出力は `bake-out/hpx/elev/`（gitignore）。置き場＝bucket の `GIS/hpx/elev/`（焼きの出力と同じパス＝`Norder{k}/Dir{d}/Npix{n}.altpbf`・`properties`・`index.json`）。
上げるのは uploader のボタン「HEALPix の標高タイル（bake-out/hpx/elev）→ GIS/hpx/elev」（24 本並べる・途中で閉じても続きから・`index.json` は最後）。

## 3. 段取り

1. 規約 ── この文書（タイルの中の座標は V3 の方式として仮決め・HiPS の画素の向きにはそろえない）。
2. 純関数と検定 ── 済。
3. 焼き手 ── 済（合成の大元で検定・試作の Python 版 `make_tiles.py` と同じ入力で画素が一致＝差は丸めの 1）。本物の R90 は Mac で焼けた（252 枚・14 秒・2026-11-27）。R10 も焼けた（16,128 枚・990 秒・無いセル 0）＝ Norder 0〜5 の 16,380 枚が揃った。
4. 読む側 ── 最初の読み手＝地形（本人裁定 2026-11-27「地形の大元として読む」）。`?hpx=1` の時、地形の R10 のセル（近窓・遠景層）を HEALPix タイルから埋める
   （`src/elevation/healpixsrc.ts`・`terrain.ts` の `cell10`・検定 `tests/terrain-hpx.mjs`）。描く側（アトラス・シェーダ）は経緯度の窓のまま＝GL2／WebGPU とも無変更。
   - セルの密度に合う order を選ぶ（`hpxOrderFor`）。10° のセル 1 枚の取り寄せ＝Norder 3：タイル 4〜5 枚（1.3 Mpx）・Norder 4：12 枚（3.1 Mpx）・Norder 5：36 枚（9.4 Mpx）。R10 の生タイルは 1 枚 5.76 Mpx。
   - `?hpx=1`＝HEALPix の方が軽い密度（Norder 3・4＝1 セル約 1,400 texel まで）だけ HEALPix・それより細かい窓は従来の R10。`?hpx=2`＝R10 のセル全部を HEALPix から（Norder 5 まで＝継ぎ目の目視用）。
   - 落ちる先：HEALPix に届かない（未アップロード・通信断）・外来の DEM が掛かるセル＝従来の R10。R90（全球アトラス 1 本）・R01・混成窓の R10 切り出し・近景層は従来のまま。
   - 標本化は CPU（描画ワーカー・行の束ごとに手を放す）＝1 セル 512² で約 80 ms・1024² で約 180 ms（クラウドの器の Node で計測）。実機の体感と、GPU へ移すかは目視の後に決める。
   - 画像のラスタ層の源 `scheme: "healpix"`・画素ごとに引く方式（試作）は未着手。
5. 継ぎ目と極の目視 → 広げるか（全球標高アトラス `WORLD1024_1`・極の蓋／扇の乗り換え）の判断。既定を切り替えるならそこが 3.0。

## 5. ベクタのタイル（2026-11-27 起案・切る側の純関数まで）

本人（2026-11-27）「OSM のベクタを同じ座標で切ることをまず考えましょう」→「切る純関数だけ先に作る」。設計案＝Claude Doc「OSMベクタをHEALPixの面座標で切る設計案」。
大元は OSM の生データ・日本域（本人裁定 2026-11-27）。読む側（選抜と組み立ての入口）は未着手。

- 純関数：`packages/ortho-core/src/healpixvt.ts`（検定 `tests/healpix-vt.mjs`）
- 器＝MVT（Mapbox Vector Tile 2.1）をそのまま借りる。違うのは座標の意味だけ：タイルの中の (x, y)＝面ごとの座標（x＝ix の向き・y＝iy の向き＝標高タイルの列と行）を 0..extent（既定 4096）の整数にした物。
  **y は上向き**（MVT の慣習と逆）＝多角形の外周は反時計回りが正の面積。番地は標高と同じ NESTED の (order, npix)。
- 辺は「経緯度でまっすぐ」と読む（GeoJSON・MVT と同じ）。面の座標では曲がる＝曲がりが刻みの 1/4 を超える辺だけ途中に点を足す。
- 切り方：面 1 つは経緯度の矩形の窓に収まり（冠の面＝経度 90° 幅×緯度 0..±90°・赤道の面＝経度 ±45°×緯度 ±41.81°）、窓の中では面の座標が途切れなく伸びる。
  ① 経度を巻き戻す（180° 線をまたぐ輪を連続に・極を一周する輪は極の点を足して閉じる）② 面ごとに窓で切る → 面の座標へ写す → 面の正方形で切る ③ 四分木で order まで刻んで整数へ丸める。
  窓で切った切り口は面の外か角に在る＝面の中に余計な継ぎ目を残さない。切るのは軸に平行な直線だけ＝メルカトルの XYZ と同じ算法。
- 縁：タイルの縁ちょうどで切る（重なり無し）。線の切り口は隣のタイルと同じ点になる（検定で対を数える）。点は切らずに、その点を含むタイルへ。
- 検定の物差し＝等積：経緯度の矩形の立体角 (Δ経度)·(Δsin 緯度) と、面の座標の面積の合計（面 1 枚＝全球の 1/12）が合う（面の境・3 面の角・4 面の角・冠どうしの境・極・180° 線）。
- 読み方の約束：経度の進みが 180° を超え 360° 未満の辺は「180° 線をまたいだ書き方」・ちょうど 360°（−180→180）は全周の辺。極を一周する輪がどちらの極を囲むかは輪の緯度の平均で決める。
  元から経度 ±180° で切ってある多角形（南極大陸など）は、その切り口が面 6 の中に継ぎ目として残る（面積は合う）。
- 速さの目安（クラウドの器の Node）：2 万点の輪を order 11 の 95,565 枚へ＝約 0.4 秒。

### 日本域の試し焼き（OSM の生データ・本人裁定 2026-11-27「OSM の生データ＋日本域で行きましょう」）

- 焼き手：`packages/ortho-core/scripts/bake-healpix-osm.mjs`（Geofabrik の日本の PBF を GDAL の ogr2ogr で読む＝歩ける道の網と同じ読み方）→ `bake-out/hpx/osm/Norder{k}/Dir{d}/Npix{n}.mvt`＋`index.json`。
- 置き場＝bucket の `GIS/hpx/osm/`・上げるのは uploader のボタン「HEALPix の OSM ベクタ（bake-out/hpx/osm）→ GIS/hpx/osm」（標高と同じ置き方）。
- 層と kind は Protomaps の流儀に寄せる（今の style が効きやすい）。出し始める段（Norder k ≒ メルカトルの z k+2.6）：

| 層 | 中身 | 出し始める段 |
|---|---|---|
| `roads` | 道：kind＝`highway`（motorway・trunk＝4〜）／`major_road`（primary 6・secondary 7・tertiary 8）／`minor_road`（residential ほか 10・service 11）／`path`（11）。`kind_detail`＝highway の値・`name`／`ref` は 9〜・`is_tunnel`／`is_bridge` | 4〜12 |
| `roads` | 鉄道：kind＝`rail`・`kind_detail`＝railway の値（rail 6・subway ほか 9・tram 10） | 6〜10 |
| `water` | 水面（多角形・kind＝`water`）5〜・水路（線・`river` 7・`canal` 9・`stream` 11） | 5〜12 |
| `buildings` | 建物（多角形・属性なし） | 最も細かい段だけ（既定 12） |

- 試し焼き（本人の Mac・2026-11-27・`--box=139.5,35.5,140,35.9`・Norder 4〜11）：線 60 万・面 316 万（ほぼ建物）→ 379 枚・100 MB・1,584 秒（ほぼ GDAL が日本全体の PBF を読む時間＝範囲を絞っても変わらない）。プレビュー（Norder 9・11）は形も境の継ぎも合っていた。都心の Norder 11 は 1 枚 約 710 KB（建物 約 2 万 4 千棟・道 約 7 千本）＝重すぎる → **既定の最も細かい段を 12 に**（建物は 12 だけ・1 枚 約 1.6 km 角）。
- Norder 12 の焼き直し（同じ範囲・221 秒＝先の 1,584 秒は PBF を取った直後の初回読み）：1,253 枚・118.5 MB（N12 が 874 枚・92.8 MB・1 枚の中央値 90 KB・最大 342 KB＝gzip 205 KB）。粗い段が重かった：Norder 7・8 の 1 枚が 588 KB・625 KB。中身（Norder 7）＝地物 27,607・点 69,492＝線 1 本の点の中央値 2＝重さは座標ではなく地物の数（鉄道 9,322 本が最多）。
  → 焼き手は、タイルごと・層ごとに属性が同じ線を 1 つの地物にまとめて端点でつなぐ（`hpxMergeLines`＝2 本だけ出会う所で・枝分かれと縁ではつながない）。粗い段はつないだ後にもう 1 度間引き、縁に触れない 4 刻み未満の線を捨てる。側線・車庫の鉄道（`service` 付き）は Norder 10 から。
- 東京の焼き直し（#1230 の後）：94.1 MB・500 KB 超 0 枚・Norder 7 の最大 588 → 111 KB・Norder 8 の最大 625 → 138 KB。絵に途切れ・誤ったつなぎは無し。
- 並列（本人 2026-11-27「可能ならば並列化しませんか？」）：Mac（18 コア）で焼き手が使っていたのは 1 コア＝詰まりは node 側（JSON を解いて切る処理）で、ogr2ogr には余裕があった。→ 切る・詰めるを働き手（worker_threads・既定＝コア数−1・最大 12・`--jobs=N`）へ配る。働き手ごとに別の仮のファイル。地物と部品は並べ直す＝働き手の数によらずタイルは同じバイト列（合成データで 1・2・3 人を突き合わせた）。仮の束は Norder 8 の祖先ごと（詰める時の記憶を抑える）。
- 記憶（Mac で実測・全国）：面（multipolygons）を読む ogr2ogr が 128 GB（うち圧縮済み 120 GB・物理 64 GB の機械でスワップ 0）・線の時は約 15 GB・node は 1 GB。→ 線と面の同時読みは既定で切った（`--readers=2` で入る）。詰める段は、行を文字列のままタイルごとに分けてから 1 タイルずつ座標に開く（束ごと開かない）。
- 全国の試し焼き（並列化の前・2026-11-27）：読む・切るは 921 秒で 4,536 万件（線 1,170 万・面 3,365 万）・切れ 6,998 万。ogr2ogr の記憶は件数に比例して増え続け、最後は 204 GB（終わり際にスワップ 10 GB）。詰める段は node の heap 上限（約 4.5 GB）で落ちた（東京を含む束が 938 MB）＝束を Norder 8 に細かくし 1 タイルずつ開く形に直した・`--pack-only` で仮の束から詰め直せる。
- GDAL の記憶の出どころ（Mac で切り分け・GDAL 3.13.3）：環境変数（`OGR_INTERLEAVED_READING`・`OSM_MAX_TMPFILE_SIZE`・`OSM_COMPRESS_NODES`）・`-where`・`-select`・出力先（`/vsistdout/`／`/dev/stdout`）はどれも無関係。**出力の形式が GeoJSONSeq の時だけ増える**（1 件あたり約 6 KB）。CSV（`-lco GEOMETRY=AS_WKT`）だと 0.3 GB のまま。→ 焼き手は ogr2ogr の出力を CSV にし、働き手が CSV の行と WKT を読む（引用符の中の改行で割れた行は親がつなぐ）。出る速さは GeoJSONSeq より 2〜3 割遅い。
- **全国の焼きが通った**（Mac・18 コア・働き手 12・2026-11-27）：549 秒（読む・切る 508・詰める 41）・記憶は ogr2ogr 4.7 GB・node 10 GB 以内・スワップの増え 0。208,825 枚・1,472 MB（gzip で約 1.08 GB）＝N4 14・N5 39・N6 102・N7 297・N8 903・N9 3,004・N10 10,695・N11 40,258・N12 153,513 枚（N12 だけで 1,080 MB・1 枚の中央値 1.8 KB・最大 416 KB）。500 KB 超 0 枚。日本は沖縄まで全部が面 1。

### 置き方＝面ごとの PMTiles（本人 2026-11-27「12個に分けてpmタイル化というのはどうですか？」）

- HEALPix の面 1 つは段 k で 2^k × 2^k の四分木＝PMTiles の z/x/y と同じ形。**z ＝ Norder・x ＝ 面の中の ix・y ＝ 面の中の iy**（北西向きに増える＝メルカトルの「上から下」に直さない）と読み替えて、PMTiles v3 をそのまま借りる（Hilbert の番号・索引・Range 読み・同じ中身の畳み込み・gzip）。
- ファイルは `face{f}.pmtiles`（f＝0〜11・在る面だけ）＋目録 `index.json { made, source, layers, minOrder, maxOrder, extent, faces: [{ face, file, tiles, bytes }], tiles, bytes }`。メタデータの `healpix` 節（`scheme: "healpix-face"`・`face`・`tileY: "up"`）に約束を書く。**メルカトルではない**＝既製のビューアで開くと位置はでたらめ。
- 束ねる：`node packages/ortho-core/scripts/pack-healpix-pmtiles.mjs --in=bake-out/hpx/osm-japan`（→ `bake-out/hpx/osm-pm/`・束ねた後に無作為の枚数を読み戻して元と突き合わせる）。上げる：uploader の「HEALPix の OSM ベクタ（bake-out/hpx/osm-pm の PMTiles）」→ `GIS/hpx/osm/`。
- 読む側（未着手）：今の PMTiles の読み手（`pmtiles-src.ts`）で、面を選んで (Norder, ix, iy) を引く。面をまたぐ隣は `hpxNeighbors`。
- 逃げ道：全球で面 1 つが重すぎたら、その面だけ下の段（例：Norder 2 の 16 分割）で割る＝四分木なので同じ読み替えで済む。今の書き手は全部を記憶に載せて組む＝面 1 つが数 GB まで。

- 間引き：最も細かい段は丸めるだけ。粗い段は Douglas–Peucker（1.5 刻み）と小さい多角形（8 刻み² 未満）の切り捨て。線の両端とタイルの縁の点は動かさない＝隣のタイルとの継ぎを保つ（`hpxSimplify`）。
- 多角形の輪は外周＝反時計回り・穴＝時計回りにそろえて焼く（y が上向きの約束）。
- 入れていない物：海岸線（陸の多角形＝PBF からは出ない・osmcoastline の仕事）・地名や施設の点・土地利用・行政界。
- 目で確かめる＝`node packages/ortho-core/scripts/hpx-vt-preview.mjs --order 9 --bbox 139.4,35.4,140.1,35.95 --width 2400`（`--grid` でタイルの境）。
- 未確認（クラウドの器に GDAL と PBF が無い）：本物の PBF での通し・所要時間・タイルの大きさ。合成の GeoJSONSeq（道の格子・鉄道・川・穴あきの池・建物）では焼きと描画が通っている。

## 6. 読む側＝HEALPix のまま描く（本人 2026-11-27「HEALPixのまま描く(本筋)」・設計案）

メルカトルのタイルへ切り直す仮の経路は作らない。タイル選びも頂点の位置も HEALPix で行う。既存のメルカトルの経路は既定のまま残す（HEALPix は足し算・旗 `?hpxvt=1` の時だけ）。

### 今の描画がメルカトルを前提にしている所（2026-11-27 に読んだ分）

| 所 | 何をしているか | HEALPix では |
|---|---|---|
| `build.ts` の `llInto`／`latOf` | タイルの中の点 → 経緯度（原点からの差）。**頂点の位置はここ 1 か所** | `hpxTilePointLonLat` に差し替える |
| `build.ts` の `extendToPole`・`fillSub`（128/2^z の格子）・`dK = 2^(32−z)/extent` | 極への延長・面の細分・破線の物差し | 極の延長は要らない（面が極まで覆う）。細分と破線は「相当する z」で |
| `tilepayload.ts` | `origin = tileBounds の北西`・線の細分の長さ（緯度の cos） | origin＝タイルの中心の経緯度・長さは等積なので緯度に依らない |
| `labels.ts`（4 か所）・`buildings.ts`（1 か所）・`query.ts`・`expr-geo.ts` | `tileLocalToLonLat` を直に呼ぶ | 同じ差し替え口を通す |
| `tilecover.ts` `selectLOD` | 画面の標本点 → `lonLatToTile` → 四分木を割る（`tileBoundsInto` で画面上の大きさ） | 標本点 → `lonLatToNest`・四分木は `hpxChildren`・大きさは `hpxCorners` |
| `tilemanager.ts` | 鍵 `z/x/y`・親子は `x >> d`・距離は中心の経緯度 | 鍵 `h{order}/{npix}`・親子は `npix >> 2d`・中心は `nestToLonLat` |
| `overzoom.ts`・`pmtiles-src.ts` の範囲の門 | 祖先の引き伸ばし・ヘッダの bbox | 祖先は `npix` の下位 2 ビットが子の位置（Z 字）＝同じ引き伸ばしが使える・門は通さない（`fetchPMTilesAt`） |

build より下流（scene・drape・シェーダ）は経緯度を受け取る＝投影に依らない。**直す所は「番地の計算」に集まっている。**

### 形＝番地の計算を 1 つの口（格子）に寄せる

```ts
interface TileGrid<T> {                       // T＝番地（メルカトル {z,x,y}／HEALPix {order,npix}）
  key(t: T): string;                          // キャッシュの鍵
  styleZoom(t: T): number;                    // style を評価する zoom
  origin(t: T): [lon, lat];                   // 頂点の差の基準
  toLonLat(t: T, extent: number): (px, py, out, oi) => void;   // タイルの中の点 → 経緯度（タイルごとに 1 回作る＝今の llInto と同じ流儀）
  bounds(t: T): [w, s, e, n];  center(t: T): [lon, lat];
  rootsAt(lon, lat, level): T;  children(t: T): T[];  parent(t: T): T;  under(t: T, b: T): boolean;
}
```

メルカトルの実装は今の式をそのまま移すだけ（結果が 1 ビットも変わらない事を検定で縛る）。HEALPix の実装は `healpix.ts`／`healpixvt.ts` の関数を並べるだけ。

### 段取り（各段で止まれる）

1. **格子の口を足す**（新しいファイルだけ・配線しない）〔済＝`src/tilegrid.ts`・`tests/tilegrid.mjs`〕：`tilegrid.ts`＝メルカトルと HEALPix の 2 実装＋検定（メルカトルは `tile.ts` と同じ値・HEALPix は往復と隣の継ぎ）。既存のファイルは触らない。
2. **組み立てを格子越しに**：`build.ts`・`labels.ts`・`buildings.ts`・`tilepayload.ts` の番地の計算を口越しに替える。既定はメルカトル＝絵は変わらない（既存の検定＋描画の突き合わせで確かめる）。**ここが既存のファイルに触る最初の段＝本人に見せてから。**
3. **HEALPix のタイル 1 枚を地球に置く**：`?hpxvt=1` で、決め打ちの数枚（東京の N9）を今の style で組み立てて描く。位置と継ぎ目を目で確かめる。
4. **タイル選び**：`selectLOD`／`tilemanager` を格子越しに。HEALPix で視野を覆う・段の切り替え・祖先の引き伸ばし。
5. **style の合わせ**：焼いた層（roads・water・buildings）と属性に合う style。今の基図の style は別のスキーマ＝そのままでは色が付かない。

### 決める事

- **style の zoom**：段 k の 1 枚の辺は赤道でメルカトル z = k + 2.62 と同じ長さ。段 k を zoom k + 3 として評価する案（N12＝z15＝建物が立つ段と合う）。メルカトルと違い緯度で縮まないので、日本（北緯 35°）では同じ z のメルカトルより 1 枚が 2 割ほど大きい。
- **海と陸**：焼いたのは道・水・建物だけ＝陸の面が無い。下地は今の地形の色のまま、その上に線と建物を載せる形で始める。
- **メルカトルの基図との同居**：`?hpxvt=1` の間は基図のベクタを止めるか、重ねるか。始めは「止める」（二重に描かない）。

## 4. 轍

- 面の縁・隅ちょうどの点（例：経度 90°・緯度 0°）は、どちらのセルに入るかが丸めで決まる＝healpy と 1 つ隣になる事がある（どちらも正しい）。検定の基準値からは外してある。
- 番号は order 13 から 32 bit を超える＝ビット演算は 13 bit ずつ（`interleave`）。上限は order 24（2^53 未満）。
- 冠の面の東西の角・赤道の面の南北の角は 3 面しか集まらない＝その向きの隣は無い（`hpxWrap` が null・`hpxNeighbors` が −1）。
