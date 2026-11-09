# ortho-earth ⇄ Minecraft（Java 版・統合版） ── ブロックの往復の設計（2026-11-09 起案）

**目的**：Unity（[unity-roundtrip.md](unity-roundtrip.md)）・Unreal（[unreal-roundtrip.md](unreal-roundtrip.md)）と同じく、ortho-earth のデータ（地形・PLATEAU 建物）を Minecraft のワールドに焼き、
Minecraft で建てた物を錨つきの GLB にして地球儀へ戻す。
**本人の裁定（2026-11-09）**：Java 版と統合版の**両方**。Minecraft のボクセルを取り込む（逆方向）も作る。縮尺 1 m／ブロック・点群は v1 では入れない。

## 0. 結論（先に）

- **入口は ortho-export の出力フォルダ**（`anchor.json`・`terrain.glb`・`buildings.glb`）をそのまま使う。網に出るのは ortho-export だけ＝Minecraft の段は手元で完結。
- **CLI** `sdk/ortho-export/src/minecraft-cli.mjs`（`ortho-minecraft`）：1 回で **Java のワールドのフォルダ**・**WorldEdit の `.schem`**・**統合版の `.mcworld`** を書く。
  どれも同じ格子から書く＝同じ場所に同じブロック（Amulet で両方を開いて 62 種すべての名前が一致することを確かめた）。
- **取り込み** `ortho-minecraft import`：Java のワールド・統合版（フォルダか .mcworld）・.schem の範囲（か `--diff` で建てた物だけ）→ 見えている面だけの箱のメッシュ→ 錨つき GLB。
  ortho-earth 側（`decodeModel` が `extras.orthoEarth.anchor` を読む）は**直さない**。
- 依存ゼロ（node:zlib だけ）：NBT・Anvil・Sponge Schematic・LevelDB（書き＝ログだけ・読み＝ログと zlib の表）を自前で持つ。

## 1. 座標の約束

| 系 | X | Y | Z | 単位 |
| --- | --- | --- | --- | --- |
| glTF（ortho-export の GLB） | 東 | 上 | 南（−北） | m |
| Minecraft | 東 | 上 | 南 | 1 ブロック＝`scale` m（既定 1） |

- 軸の向きは glTF と Minecraft で**同じ**（どちらも右手系・Y 上・+Z 南）＝反転なし。
- 錨＝ブロック **(0, yOrigin, 0)** の北西下の角。glTF (E, U, −N) = (x·scale, (y − yOrigin)·scale, z·scale)。
- `yOrigin` は既定 0（錨の地面＝Y 0）。ワールドの高さは −64..319 の 384 段＝建物の天辺が 319 を超える時は下へずらし、地形の下端が −64 を割る時は上へずらす。
  それでも入らない（起伏＋高さ＞384 m）時は切って警告＝`--scale 2` を勧める。
- 書き出しの対応は **`ortho-earth.json`**（錨・ジオイド・bbox・scale・yOrigin・格子の範囲）。ワールドのフォルダの中・出力フォルダ・`.mcworld` の中に置く＝取り込みがこれで元の場所へ戻す。
  ゲームは知らないファイルを消さないので、遊んだ後のワールドにも残る。

## 2. 何を焼くか（§3 voxelize.mjs）

- **地形**：三角形に 0.4 ブロック間隔で点を打ち、柱ごとに一番高い点＝上面・写真の色の平均＝上面のブロック。その下 3 段は土、さらに下 4 段目以降は石（地形の最低点の 4 段下まで）。
  点の入らなかった柱は隣から埋める。外は空（void の平坦ワールド）。
- **建物**：面に点を打ち、点の入ったマス＝外殻（中は空洞）。色＝テクスチャ（`--textured` で書き出した時）か材質の色。
  屋根（柱の一番上）は**航空写真の色**（PLATEAU のテクスチャなしでも屋上の色が出る・`--no-roof-imagery` で切る）。
  **床**：柱の下端が地面から 2 段以内の柱に `floors` m（既定 4）ごと＝中を歩ける。ひさし・渡り廊下の下には張らない。
- 画像の解読：png はそのまま、jpeg・webp は手元の変換器（sharp・sips・ffmpeg・magick＝`textures.mjs` と同じ）で png にしてから。長辺 1024 px に縮めて読む。

## 3. 色 → ブロック（palette.mjs）

- 塗れるブロック 60 種（コンクリート 16・テラコッタ 17・石の仲間・土・苔・砂岩・レンガ・クォーツ・雪・粘土・泥レンガ・板 4・プリズマリン）の平均の色を持ち、
  **CIE Lab の距離**で一番近い物（5 bit/ch の表で覚える）。
- 使わない物：重力で落ちる物（砂・コンクリートパウダー・砂利）、バイオームで色の変わる物（草・葉＝地面の柱の色が無い所だけ grass_block）。
- 平原のバイオーム（`minecraft:plains`）で塗る。

## 4. 書き出しの形式

### 4.1 Java 版（anvil.mjs）

- `level.dat`（gzip の NBT）＋ `region/r.X.Z.mca`（4 KiB の区画・塊は zlib）＋ `icon.png`（上から見た 64×64）＋ `ortho-earth.json`。
- **1.21.1（DataVersion 3955）の形**で書く。新しい版（26.x など）で開くとゲームが DataFixer で上げる（「バックアップを作りますか」と聞かれる）。古い形で書くのが一番通る。
- 区画（16³）＝ palette＋long の列（1.16 以降＝値は long をまたがない・最小 4 bit・順は y,z,x）。光（`isLightOn=0`）と高さ図は書かない＝開く時にゲームが作る。
- ワールド：クリエイティブ・コマンド可・平坦（空気 1 段＝void）・昼で止める・天気なし・湧きなし。出現点＝錨の柱の上。

### 4.2 WorldEdit の .schem（schem.mjs）

- Sponge Schematic v2（gzip の NBT・`BlockData`＝varint）。`Offset`＝貼る点から見た格子の隅＝**錨の場所に立って `//paste` すれば錨がそこに来る**（`//paste -o` で Offset を使わない）。
- 既存のワールドに入れる時用（地面の高さは `yOrigin` に合わせて貼る Y を選ぶ）。

### 4.3 統合版（bedrock.mjs・leveldb.mjs）

- `.mcworld`＝zip（`db/`・`level.dat`・`levelname.txt`・`ortho-earth.json`）。開く＝ダブルクリック（Windows）か iPad・スマホで「Minecraft で開く」。
- `db/` は LevelDB を**ログだけ**で書く：`CURRENT`→`MANIFEST-000002`（比較器 `leveldb.BytewiseComparator`・ログ番号 3）＋ `000003.log`（WriteBatch の列・CRC32C）。
  LevelDB は開く時にログを読み直して表（.ldb）に焼く＝SSTable を自前で書かない。本物の LevelDB（Amulet）で開いて .ldb に焼かれることを確かめた。
- 塊の鍵＝x(i32 LE)・z(i32 LE)・種(1 バイト)・[区画 y(i8)]。書く種：Version（0x2C＝40）・SubChunkPrefix（0x2F・v9・1 層・パレットは LE の NBT）・Data3D（0x2B・高さ図＋平原）・FinalizedState（0x36＝2）。
- ブロックは **1.20.0 の名前と states**（`minecraft:concrete {color: "red"}`・version 1.20.0.1）で書く＝ゲームが開く時に今の名前（`minecraft:red_concrete`）へ上げる。
  `level.dat`＝i32 の版（10）＋i32 の長さ＋LE の NBT・平坦（`FlatWorldLayers`＝空気 1 段）・クリエイティブ・最低の版 1.20.0。

## 5. 取り込み（Minecraft → ortho-earth・import.mjs）

```
node sdk/ortho-export/src/minecraft-cli.mjs import <ワールド|.mcworld|.schem> --out house.glb [--box x0,y0,z0,x1,y1,z1] [--diff <書き出した時のワールド>]
```

- 読み手：Java（region・1.18 以降の塊）・統合版（フォルダか .mcworld・LevelDB のログと zlib の表・区画 v8/v9 の 1 層目）・.schem（v2・v3）。
- 範囲：`--box`（F3 の XYZ・両端を含む）か `--diff`（元のワールドと違うブロックだけ＝建てた物。壊した所は入らない）。.schem は全体（Offset で元の場所）。
- メッシュ：空気と飾り（松明・花・看板・ガラス板など）を除いたブロックを箱にし、隣が箱の面は省く。ブロックの種ごとに 1 つの prim・材質の色＝palette の色（無い物は名前から大まかに）。
- GLB：頂点＝錨の glTF 座標・`asset.extras.orthoEarth`＝ortho-earth.json の錨＝`/japan/models` や glbconv の 3D Tiles にそのまま載る（Unity・Unreal の戻りと同じ口）。

## 6. 検定・確かめたこと

- `npm test -w ortho-export`（`tests/t-minecraft.mjs`・15 件）：NBT の往復・CRC32C・色の選び方・区画の詰め方・合成の地形と箱の格子・
  Java の region／.schem／統合版のログを読み戻して同じブロック・取り込み 3 形式で箱が元の場所・`--diff`・本物の LevelDB が焼いた `.ldb`（`tests/fixtures/bedrock-db-world`）を読む。
- Amulet（amulet-core 1.9.51・Python 3.11）で Java と統合版の両方を開き、合成のワールド・全 62 ブロック・丸の内の大きさの合成（680×610×206）を突き合わせた：不一致 0。
- 丸の内の大きさ（680 m × 610 m・建物 170 棟）：10 秒・メモリ 760 MB・Java 7 MB・.schem 1.4 MB・.mcworld 25 MB。
- **まだ**：本物のゲーム（Java 版・統合版）で開くこと・丸の内の実データで焼くこと（クラウドからは地理院・Mojang に届かない＝Mac で）。

## 7. この先

- 水面（標準地図の水部→水ブロック）・道路の色・窓（ガラス）・点群の色つきボクセル・属性（用途）での塗り分け。
- 2 m／4 m の縮尺で広い範囲・ブロックの段差の滑らかさ（半ブロック）。
