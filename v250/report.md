# Cesium / MapLibre 整合の再検定 — main dd42329f1（2026-11-09）

## 1. Cesium Sandcastle 門（ortho 側のみ・ref は v242 を流用）

条件：v242 と同じ＝`--side ortho --gpu --hide-ui --time-from v242 --wait 20000 --jobs 2`、Chrome for Testing 154.0.8037.92。
実行：`.cache/csexamples/runs/v250`（309 例・撮影約 70 分）。下がった例は `v250b` で 1 例だけ撮り直した。

### 段の数

| 段 | v242 | v250 |
|---|---|---|
| 3 | 221 | **225** |
| 2 | 76 | **73** |
| 1 | 1 | **0** |
| 0 | 0 | 0 |
| null（採点の外） | 11 | 11 |

### 段が変わった例（picture＝colour % / edges % / blob）

| 例 | v242 | v250 | v250b | v242 picture | v250 picture |
|---|---|---|---|---|---|
| 3d-tiles-1.1-photogrammetry | 1 | **3** | – | 35.5 / 43.4 / 404（camera Δ318 m） | 97.5 / 98.3 / 12 |
| 3d-tiles-formats | 2 | **3** | – | 93.8 / 97.5 / 27 | 98.7 / 99.9 / 4 |
| lensflare | 2 | **3** | – | 97.0 / 96.8 / 26 | 98.8 / 97.6 / 2 |
| multi-part-czml | 2 | **3** | – | 95.9 / 97.3 / 40 | 97.9 / 98.4 / 12 |
| resolution-scaling | 2 | **3** | – | 70.6 / 75.1 / 470 | 98.5 / 83.8 / 2 |
| bing-maps-labels-only | 3 | **2** ↓ | **2**（再現） | 90.8 / 88.1 / 15 | 89.4 / 87.9 / 25（v250b 89.4 / 87.9 / 25） |

- 下がったのは bing-maps-labels-only の 1 例だけ。撮り直しでも同じ数字＝揺れではない。ただし v242 の時点で閾値の際（colour 91%）にいて、差は 1.4 ポイント・塊 15→25 セル。目で見ると v242 と v250 の ortho はほぼ同じ絵で、本物（ref）とはラベル瓦の解像度がもともと違う（ref の方が字が大きい）。高速化で壊れたものではなく、境目の例がわずかに外へ出たもの。
- 「not ran」の 2 例（itwin-feature-service・multifrustum-snapping-dev）は v242 も v250 も null（採点の外）で、変化なし。

画像（`.claude-share/v250/`）：`<例>.ref.jpg`・`<例>.v242.jpg`・`<例>.v250.jpg`（bing-maps-labels-only は `.v250b.jpg` も）。

## 2. MapLibre 公式例の門（ref r7・ortho o1108）

実行：`verify-examples.mjs --side ortho --ref r7 --label o1108` → `--grade --ref r7 --ortho o1108`（--update なし）。結果：「known.json どおり（下がった例なし）」。
比較の元：o1102chk は 6 例だけの撮り直しなので、全体は o1102x（139 例）に o1102chk の 6 例を重ねたものと比べた。

| 段 | o1102x+chk | o1108 |
|---|---|---|
| 3 | 91 | 91 |
| 2 | 43 | 43 |
| 1 | 3 | 3 |
| null | 2 | 2 |

**段が変わった例：なし**（139 例すべて同じ段）。そのため `ml/` に画像はない。
撮影ログの「例外1」2 件（toggle-deckgl-layer＝style 401 で既定の基図へ・sync-movement-of-multiple-maps＝`module is not defined`）は o1102x でも同じ中身で、今回の変更とは関係しない。

見比べ帳：`.cache/mlexamples/report/o1108/index.html`
