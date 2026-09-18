# space — 宇宙（天球）の名前データ

星座 88 とメシエ天体の通称を 26 言語で持つ、データだけのパッケージ（コードを配らない）。
読む側（ortho-solar・将来 ortho-japan）は **bucket の JSON を読むだけ**＝このパッケージの import で繋がない
（2026-09-19 本人裁定「japan がデータを読む形に」＝コード依存でなくデータ共有）。

## 置き場所

| もの | 場所 |
|---|---|
| 正本 | `names.json`＝`{ constellations: { <IAU 略号>: { <lang>: 名前 } }, messier: { "M42": { <lang>: 通称 } } }` |
| 配信 | bucket `GIS/space/i18n/<lang>.json`＝`{ updated, c: { <IAU 略号>: 名前 }, m: { "M42": 通称 } }`（その言語に在るものだけ・1 本 ~3KB） |
| 焼く | uploader の「space names」ボタン（`build/packs.js` で 26 本に割って put）＝書き込みキーは uploader の `.env.local` |

URL＝`https://api.ortho-earth.com/bucket/GIS/space/i18n/<lang>.json`（言語は `packages/world/i18n/langs.json` の 26）。
**gzip のまま置かれる**（native-bucket の put は .json を圧縮し、Content-Type は application/gzip）＝読む側は `nativeBucket(api).Bucket("GIS/space", { lazy: true }).get("i18n/ja.json", "json")`（展開込み）で読む。素の `fetch().json()` では読めない。

## 読む側の約束

- その言語の 1 本と `en.json` を取り、**欠けは英語で補う**（星座＝IAU 名・メシエ＝英語の通称）。UI 文言の既定と同じ。
- 星座のキーは IAU 略号（bucket の `constellation_lines` の `properties.name` と同じ）。ラテン名で引きたい時は `en` の値（IAU 名）から逆引きする。
- メシエは通称のある 27 天体だけ（オリオン大星雲・アンドロメダ銀河など）。通称の無いものは番号だけ（"M13" など）で出す。
- メシエの種別（bucket `messier` の `properties.type`）は d3-celestial の記号で、銀河は `s`/`e`/`i`（渦巻・楕円・不規則）。

## 出典と手当て

- ja＝日本天文学会の標準和名（ortho-japan skynames.js の表から写した）・en＝IAU 名
- zh（簡体字）・pl（主格）＝標準名を手で当てた（Wikidata は zh が繁体字混じり・pl が「Gwiazdozbiór 〜a」の属格）
- メシエの en/ja/zh＝手で当てた
- 他言語＝Wikidata の見出し（2026-09-19 取得）から百科事典の曖昧さ回避（「(…)」・hu の「csillagkép」）とカタログ番号型（Messier 13 など）を除去。
  同じ言語の星座名と同じメシエの見出しは捨てる（星座の項目を指している）。抜き取り検査で見つけた取り違えは手で当て直した（bn おおいぬ座・ar/pt アンドロメダ銀河・es オリオン大星雲）
- 組み直し＝`scripts/names-from-wikidata.py`（Wikidata への問い合わせ文は先頭のコメント）

## 検定

`npm test`＝88 星座の網羅・en/ja の必須・同言語内の重複（取り違えの疑い）・26 言語の一致・パックの形と大きさ。
