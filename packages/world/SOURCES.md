# 出所と条件（SOURCES）

| 項目 | 出所 | 取得 | 条件 |
|---|---|---|---|
| 国の基本項目（ISO 3166 / IOC コード / 首都 / 公用語 / 通貨 / 面積 / 座標 / 国旗ファイル名 / 国歌） | Wikidata | `build/index.js`（wbgetentities） | CC0 1.0 |
| 各言語の名前・記事名（i18n/） | Wikidata（ラベル・サイトリンク） | 同上 | CC0 1.0 |
| 都市（座標・人口・標高） | Wikidata | 同上 | CC0 1.0 |
| 地形（座標・面積・標高・記事名・26 言語名） | Wikidata | 同上 | CC0 1.0 |
| 人口 / GNI / GDP / PPP / 殺人率 | World Bank Open Data API | `build/stats.js` | CC BY 4.0（人口の原典は UN WPP＝CC BY 3.0 IGO） |
| GDP 系の穴埋め | IMF World Economic Outlook（DBnomics ミラー） | 同上 | IMF の利用条件（出典表記） |
| 人間開発指数 HDI | UNDP Human Development Report（CSV） | 同上 | CC BY 3.0 IGO |
| 世界平和度指数 GPI | Institute for Economics & Peace（英語版 Wikipedia の順位表経由） | 同上 | IEP のデータ＝出典表記。数値は事実 |
| 国連加盟日 | 英語版 Wikipedia「Member states of the United Nations」 | 同上 | CC BY-SA 4.0 |
| 国歌の音源（Wikidata に無い国） | 英語版 Wikipedia の記事の infobox（Commons のファイル） | 同上 | 各ファイルの Commons 記載 |
| 係争地（seed/conflicts.json）・地域分け・帰属・例外（seed/） | 手作業（Natural Earth の disputed areas の B コード体系を基礎） | — | CC BY-SA 4.0（本リポジトリ） |
| 国旗 SVG（flags/） | Wikimedia Commons（NationDB.flag にファイル名） | uploader | 各ファイルの Commons 記載（多くはパブリックドメイン） |
| 地形 PNG（geoms/） | Natural Earth 10m/50m | `apps/uploader/src/world/createGeometryPNG.js` | パブリックドメイン |
| 効果音（音源.zip） | OtoLogic | — | CC BY 4.0（クレジット必須） |

`NationDB` の各項目の出所は `_src`（wikidata / wb / imf / hdr / wikipedia-en / override / territory）に残る。
