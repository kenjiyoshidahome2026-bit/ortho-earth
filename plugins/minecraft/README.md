# Minecraft（Java 版・統合版）

ortho-earth のデータ（地形・PLATEAU 建物）を Minecraft のワールドに焼き、Minecraft で建てた物を錨つきの GLB にして地球儀へ戻す。
Unity・Unreal と違って**ゲームに入れるプラグインは無い**：`sdk/ortho-export` の `ortho-minecraft` がワールドのファイルを直接書く・読む。設計は [docs/notes/minecraft.md](../../docs/notes/minecraft.md)。

| 出る物 | 版 | 使い方 |
| --- | --- | --- |
| `<名前>/`（ワールドのフォルダ） | Java 版 1.21.1 の形（新しい版は開く時に上げる） | `.minecraft/saves/` に置く → シングルプレイの一覧に出る |
| `<名前>.schem` | WorldEdit 7（Java 版） | `plugins/WorldEdit/schematics/`（か `config/worldedit/schematics/`）に置き、錨にしたい所で `//schem load <名前>` → `//paste` |
| `<名前>.mcworld` | 統合版 1.20 以降（Windows・iPad・スマホ・Switch 以外） | ダブルクリック（か共有メニューで「Minecraft で開く」）＝読み込まれてワールドの一覧に出る |
| `ortho-earth.json` | 共通 | 錨とブロックの対応（取り込みが使う）。ワールドの中にも入っている |

## 丸の内（Tokyo Station）

```sh
# 1) 範囲を GLB に焼く（網＝地理院・PLATEAU。Unity・Unreal と同じ出力フォルダ）
node sdk/ortho-export/src/cli.mjs --bbox 139.7625,35.6785,139.7700,35.6840 --out out/marunouchi
#    建物の壁の色も欲しい時は --textured（PLATEAU のテクスチャ付き・重い）

# 2) Minecraft に焼く（手元だけ・数十秒）
node sdk/ortho-export/src/minecraft-cli.mjs out/marunouchi --out out/marunouchi-mc
#    → out/marunouchi-mc/marunouchi/ ・ marunouchi.schem ・ marunouchi.mcworld ・ ortho-earth.json

# macOS の Java 版：
cp -R out/marunouchi-mc/marunouchi ~/Library/Application\ Support/minecraft/saves/
```

- 1 ブロック＝1 m・+X 東・+Z 南・Y 上。錨（bbox の中心の地面）＝ブロック (0, 0, 0)＝出現点。F3 の XYZ がそのまま錨からの m。
- クリエイティブ・コマンド可・昼で止まる・外は空（void）。
- オプション：`--edition java|bedrock|schem`・`--scale 2`（広い範囲）・`--floors 0`（床なし）・`--no-roof-imagery`・`--y-origin 64`。

## 建てた物を ortho-earth へ戻す

```sh
# 範囲を指定（F3 の XYZ・両端を含む）
node sdk/ortho-export/src/minecraft-cli.mjs import ~/Library/Application\ Support/minecraft/saves/marunouchi --out out/house.glb --box -20,0,-20,20,40,20
# 建てた物だけ（書き出した時のワールドと比べる）
node sdk/ortho-export/src/minecraft-cli.mjs import ~/Library/Application\ Support/minecraft/saves/marunouchi --out out/house.glb --diff out/marunouchi-mc/marunouchi
# 統合版（.mcworld で書き出した物・フォルダも可）・WorldEdit の .schem（//schem save した物は --at で貼った点を渡す）
node sdk/ortho-export/src/minecraft-cli.mjs import house.mcworld --out out/house.glb --box …
```

出る GLB は錨つき（`asset.extras.orthoEarth`）＝`/japan/models` にそのまま置ける（Unity・Unreal の戻りと同じ口）。

## 確かめたこと・まだのこと

- 検定 `npm test -w ortho-export`（`tests/t-minecraft.mjs`）と、Amulet（別の読み手）で Java・統合版の両方を開いて全ブロックが一致。
- **まだ**：本物のゲームで開く・丸の内の実データ（クラウドからは地理院・Mojang に届かない＝Mac で）。
