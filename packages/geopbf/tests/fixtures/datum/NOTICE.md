# tests/fixtures/datum

国土地理院の座標補正パラメータから、検定に要る数メッシュだけを抜き出したもの（説明行はそのまま）。

| ファイル | 出典 | 抜粋 |
| :-- | :-- | :-- |
| `tky2jgd-tokyo.par` | TKY2JGD.par Ver.2.1.2（日本測地系 → JGD2000） | 東京付近の 2 次メッシュ 4 枚（533945/533946/533955/533956）＝400 セル |
| `patchjgd-tohoku.par` | touhokutaiheiyouoki2011.par Ver.4.0.0（JGD2000 → JGD2011） | 気仙沼付近の 2 次メッシュ 4 枚（574152/574153/574162/574163）＝400 セル |

出典: 国土地理院（https://www.gsi.go.jp/sokuchikijun/sokuchikijun41012.html ）。
全国版は配布物に含めない（約 1〜2 MB）。`scripts/bake-datum-grid.mjs` で焼いて native-bucket 等に置き、URL を `tky2jgd` / `patchjgd` に渡す。
