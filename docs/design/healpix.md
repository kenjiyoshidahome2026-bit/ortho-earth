# HEALPix タイル ── 規約と段取り（2026-11-26 起案）

位置づけ：メルカトルの XYZ（`tile.ts`）を**置き換えず**、全球の自前データを載せる「もう 1 つのタイル行列」として HEALPix を**足す**（本人 2026-11-26「置き換えるというより追加」）。
`docs/notes/raster-tiles.md` の残「非メルカトルのタイル行列」の答え。外来の物（地理院・PMTiles・MapLibre／Cesium の顔）はメルカトルのまま。

- 純関数：`packages/ortho-core/src/healpix.ts`（検定 `tests/healpix.mjs`＝healpy 1.20 の値と突き合わせ）
- 標高を読む：`packages/ortho-core/src/elevation/healpixread.ts`（経緯度の窓を HEALPix タイルから埋める・検定 `tests/healpix-read.mjs`）
- 標高の焼き：`packages/ortho-core/src/elevation/healpixbake.ts`（検定 `tests/healpix-bake.mjs`）・`packages/ortho-core/scripts/bake-healpix-elev.mjs`
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

### 未照合：公式 HiPS の画素の向き

タイルの中の画素の向き（上の「列＝ix・行＝iy」）は**自前の規約**で、公式 HiPS（hipsgen・Aladin Lite）と合うかは確かめていない
（クラウドの器から CDS のサーバーに届かない＝実物のタイルと比べられなかった・2026-11-26）。
標高タイルは中身が altpbf＝HiPS の読み手は元々読めないので実害は無い。画像（jpg・png）のタイルを HiPS の道具に読ませたくなった時に、
実物と突き合わせて転置・反転を決める（番地と置き場は同じ＝直すのは画素の並べ方だけ）。

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

1. 規約 ── この文書（公式 HiPS との照合は未了）。
2. 純関数と検定 ── 済。
3. 焼き手 ── 済（合成の大元で検定・試作の Python 版 `make_tiles.py` と同じ入力で画素が一致＝差は丸めの 1）。本物の R90 は Mac で焼けた（252 枚・14 秒・2026-11-27）。R10 も焼けた（16,128 枚・990 秒・無いセル 0）＝ Norder 0〜5 の 16,380 枚が揃った。
4. 読む側 ── 未着手。ラスタ層の源 `scheme: "healpix"`（`raster-src.ts`／`raster.ts`）と選抜（`selectLOD` の兄弟）。描画は先に地面アトラスへ焼く方式、画素ごとに引く方式（試作）は全球帯だけ後から。フラグの裏で入れる。
5. 継ぎ目と極の目視 → 広げるか（全球標高アトラス `WORLD1024_1`・極の蓋／扇の乗り換え）の判断。既定を切り替えるならそこが 3.0。

## 4. 轍

- 面の縁・隅ちょうどの点（例：経度 90°・緯度 0°）は、どちらのセルに入るかが丸めで決まる＝healpy と 1 つ隣になる事がある（どちらも正しい）。検定の基準値からは外してある。
- 番号は order 13 から 32 bit を超える＝ビット演算は 13 bit ずつ（`interleave`）。上限は order 24（2^53 未満）。
- 冠の面の東西の角・赤道の面の南北の角は 3 面しか集まらない＝その向きの隣は無い（`hpxWrap` が null・`hpxNeighbors` が −1）。
