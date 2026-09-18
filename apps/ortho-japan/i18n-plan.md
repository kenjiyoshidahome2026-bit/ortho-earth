# ortho-japan i18n — 英語中心・ortho-world に合わせる（2026-09-16）

**状況：Phase 0 / Phase 1 / Phase 2 完了。26 言語が本番組立まで通った。** 下は計画と、やった結果の記録。

## 0. やったこと（2026-09-16）

| | 結果 |
|---|---|
| 道具 | `scripts/lib/i18n-scan.mjs`（両時代を同じ目で読む走査器）・`i18n-extract`（正本と置換表）・`i18n-apply`（機械置換）・`i18n-build`（実行時の表を焼く）・`verify-i18n`（常設検定）。npm: `i18n:extract` / `i18n:build` / `verify:i18n` |
| キー | **506**（うち文脈つき 16）。正本 `i18n/ui.json`・実行時 `i18n/lang/<code>.json` |
| 置換 | 49 ファイル・593 リテラル・辞書 50 本を `tr()` へ畳んだ |
| 門 | 日本語表示は置換前後で **byte 一致**（t-gadgets/t-scene/t-input/t-print/t-measure）。英語表示の差は意図した修正 4 件のみ |
| 直った穴 | 出典の単語連結（"出典："＋名前＝語順が壊れる型）を `t("Source: $1", …)` へ・テーマ名 4 つ（白地図/黒地図/地理院/セピア）が英語 UI でも日本語だったのを英語キー化。どちらも**以前から英語で日本語が出ていた**箇所 |
| 訳 | **26 言語**（ja＋en＋24）。各言語 485〜506 件が訳・残りは `""`＝意図して英語（固有名詞・書式・S/M/L 等）。欠落 0（`verify:i18n --strict` PASS） |
| 配布物 | 主チャンクの日本語 **0 文字**（英語キーのみ）。言語は 1 本ずつの遅延チャンク（25 本・計 936 KB raw＝1 人が取るのは 1 本だけ・ja は 14.5 KB gzip）。lib 合計 1.72→1.65 MB raw |
| RTL | `#map` に `dir` を付け、quiet-mono 23 箇所＋style.scss 4 箇所を論理プロパティへ。LTR の座標は不変・ar/he は鏡像（`t-rtl`） |
| 検定 | `verify:i18n --strict` / `verify:lib` / `verify:prod` PASS・`verify:ui` 22 頁中 21 頁（t-anno は既存の環境フレーク＝下記） |

**t-anno の既存フレーク（今回の変更とは無関係）**：連続実行でだけ落ちる。失敗した回の console を見ると、テスト自身の
データ `test/anno`（251 B・bucket）の取得が起きていない＝虚時間が進まず 90 秒で打ち切り。単独実行は 3/3 PASS、
`gadgets/anno.js` と `tests/t-anno.html` は今回 1 文字も触っていない。6 連続で 3 回落ちた＝環境依存の再現手順は取れている。

**罠として残す**：表/配列に置かれたキー（`THEME_META`・チップ一覧・`PRINT_ATTR` 等＝`t(x)` の間接参照）は英語キー期には
ただの文字列と見分けが付かない＝**新設時だけ `i18n/ui.json` に手で足す**（既存キーは literals 照合で生き残る）。

本人の指示（9/16）：「英語中心」「world に合わせて」。
ロードマップ #11（globe で i18n+RTL・英語ベース）と #7（japan → globe）の前段として、**globe 未着手のうちに japan を直接整える**（9/14 再裁定）。

## 1. 到達点（world と同じ形にする）

| 観点 | ortho-world（基準） | ortho-japan 今 | 到達点 |
|---|---|---|---|
| 基底言語 | 英語（キー＝既定値・en はテーブル不要） | 日本語（ja キー・en は辞書引き） | **英語キー**。ja は翻訳の一つ |
| 翻訳関数 | `trans(key, $1, $2)` | `t(key, {0}, {1})` | world の `trans` と同じ契約（`$1/$2`） |
| 言語一覧 | `packages/world/i18n/langs.json`（26 言語・rtl フラグ） | ja/en のみ・別名 jp | **同じ langs.json を共有**。jp 別名は受け続ける |
| 言語解決 | `?lang=` ＞ 保存値 ＞ navigator ＞ en | `orthoJapan({lang})` ＞ `?lang=` ＞ navigator | world 順＋`orthoJapan({lang})` を最優先に残す |
| テーブル | `i18n/<lang>.json` の `ui`（英語キー→訳）をバケットから・IDB 先・裏で更新 | 各ガジェット持参の ja→en 辞書 | **同じ JSON 形**。`ui` に japan の語を足す |
| 訳の正本 | `packages/world/i18n/ui.json`（英語キー→25 言語） | ガジェットの辞書 52 本 | **ui.json 一本**（world 53 キー＋japan ≈513 キー） |
| lang/dir | `el.lang` / `el.dir` を言語から | `<html lang="ja">` 固定 | 言語から設定（RTL 4 言語） |
| 切替 | `.lang(code)`＝再描画なしで文言差替 | reload | まず reload 可。再描画なし切替は後段 |

「英語をピボットにしない」（かなピボット）は**地名の翻訳**の方針。UI の基底を英語にすることとは矛盾しない（#11 と同じ整理）。

## 2. 実測（9/16）

- 辞書 52 本・554 項目・ja ユニーク 519・en ユニーク 513。全辞書がリテラルとして機械解析できた（未解析 0）。
- 反転（ja キー→英語キー）の衝突 5 件。実害は 1 件だけ＝`"S"`（南緯 / 小）。残り 4 件は同義（Title / Close (Esc) / Text / Fill color）で統合してよい。
- 反転後に ja の語が 1 対多になる箇所は 0＝ja 訳は反転そのもので確定する。
- t() が無い日本語リテラルが残る面：`gadgets/poiedit.js`（本人道具・対象外）・`demo/scenes.js`（台本＝scene[lang]・対象外）・`planets.js`（地図の中身）・`style-mono.js`（基図スタイル）・各 `*.html` の殻（index / geoedit / tellus）。
- 物理方向の CSS（left/right/margin-left 等）はガジェット全体で 11 箇所＝RTL の鏡像化は小工事。
- ラベル描画は canvas2D `fillText`＝bidi/アラビア字形連結はブラウザ任せで通る（GPU テキスト無し）。RTL で自前 shaping は不要。

## 3. 段階

### Phase 0 — 計量と道具（半日）
- `scripts/i18n-extract.mjs`：全 `tr({…})` を集めて反転し、`packages/world/i18n/ui.json` の `ui` へ**追記候補**を出す（既存 world キーとの重複は world 側の訳を採る）。
- 衝突 5 件の手当て：`"S"` は `"S (south)"` / `"S (small)"` のように英語キーを分ける。同義 4 件は 1 キーに統合。
- 検定：`scripts/verify-i18n.mjs`＝①コード中の全 `t("…")` キーが ui.json に存在 ②各言語で欠けたキーは英語で埋まる（欠落は警告・26 言語すべて）③`$1/$2` の数がキーと訳で一致。**機械検証できる正解定義**をここで置く（縛り＝AI の檻）。

### Phase 1 — 英語キー化（互換維持・本命）
1. `i18n.js` を world の契約に置換：`t(key, a, b)` は `trans` と同じ（`$1/$2`）。`langs.json` を共有。言語解決は world 順（`orthoJapan({lang})` 最優先を維持・`jp`→`ja` 正規化維持）。
2. 各ガジェットの `const t = tr({ja: en})` → `const t = tr()`（辞書を持たない。キー＝英語＝既定値）。呼び出し `t("計測開始")` → `t("Start measuring")`。
   - **⚠ 機械的置換**：本人が「危険」と見る型。手当て＝(a) 置換表は Phase 0 の抽出物そのもの（暗黙の契約に依存しない）(b) 置換後に `verify:ui` を **lang=ja のまま**回して日本語表示が byte で変わらないことを確認（表示が変われば置換漏れ）(c) その後 `verify:ui` の既定を en へ・ja は別パスで一周。
   - `{0}` → `$1` の書換は同じ表で機械化・verify-i18n ③で検算。
3. テーブルの置き場：world と同じ `i18n/<lang>.json` 形。**japan の ja は同一オリジンの静的ファイル**（`public/i18n/ja.json`・ビルドで ui.json から生成）＋解決済み言語を `<link rel=preload>`。理由＝日本語は japan の母語で、英語で一瞬出てから ja に差し替わる「英語のちらつき」を出さない・Lighthouse mobile 100 を守る。他 25 言語は world と同じバケット（`api.ortho-earth.com` の `i18n/<lang>.json`・IDB 先）でよい。
   - **裁定 A（9/16）**：ja は静的同梱。他言語はバケット。
4. ~~殻の文言を `data-i18n` で~~ → **不要と判明**（9/16）：見える出典は instruments ガジェットが起動後に英語込みで組み直す（静的な `#attr[data-boot]` は LCP 用の約 2 秒の下敷き）。残る殻は `<title>`/`meta description`/`og:*` ＝検索向けの静的文言で、日本語のまま置く（言語別 HTML を配らない）。`dir`/`lang` は Phase 2（RTL）で `#map` に付ける。
5. 互換：`?lang=ja` / `?lang=en` / `?lang=jp` は今のまま動く。URL パラメータの追加なし。既定は今と同じ（ブラウザ言語）。
6. 訳の生成：追記した ≈500 キー × 24 言語（ja は反転で確定・en はキー）は LLM で**一度に全部**埋め、`i18n:classes`（Wikidata）と同じく ui.json に載せる（**裁定 9/16「24言語を一度に入れる」**）。出典表記（GSI 公式名）は英語固定のまま訳さない（正確性義務）。
   - 実測 9/16：japan の英語文言 501 件と world ui.json 53 キーの重なりは 1 件（name）＝流用はほぼ無し。Phase 1 直後は ja/en 以外 100% 英語フォールバック→生成で 0% へ。
   - 掟：langs.json に載せる言語は訳が揃ったものだけ（英語だらけの UI を公開しない）。verify-i18n は ja と en を**エラー**、他 24 言語を**警告**（後日エラーへ昇格）。
   - **裁定 9/16「訳せないものは `""` にして英語表記を残す」**：ui.json で値が空文字＝「意図して英語のまま」（固有名詞・GSI 出典・技術語・記号）。**欠落（キー無し）＝未訳**と区別する。verify-i18n は `""` を揃った扱い（警告なし）・欠落だけを警告。world の build/i18n.js は空値を落として配るので、実行時は trans のキー（英語）フォールバックにそのまま乗る＝改修不要。LLM 生成時も「訳さない判断」を `""` で明示させ、空欄を出させない。
   - 言語別の見立て：ラテン圏・de・zh・ko は LLM 訳ほぼそのまま／ar・fa・ur・he は RTL 表示検定（Phase 2）が要／th・bn・hi は字幅でボタン溢れの目視。

### Phase 2 — RTL（**実施済 9/16**）
- `#map` に `lang` と `dir` を言語から付ける（html/body には触れない＝埋め込み先の領分・destroy で返す）。
- 物理プロパティ → 論理プロパティ：`packages/quiet-mono/components.scss` 23 箇所＋`style.scss` 4 箇所。
  中央寄せ（`left: 50%` + `translateX(-50%)`）と左右対称の飾り（縮尺バーの両端）は方向に依らない＝触らない。
- 掟を quiet-mono の頭書きへ（「端に寄せる指定は論理プロパティで書く」）＝四戒＋一を japan で先に施行。
- 検定：`tests/t-rtl.html` 新設＝**LTR は座標が 1 ピクセルも動かない**・**RTL は #gadgets と #attr が入れ替わる**・横溢れなし。
  `verify:ui` に `t-rtl` と `t-rtl?lang=ar` を常設（runner が "頁?クエリ" を受けるよう改修）。ar/he とも PASS。

### Phase 3 — 地図の中身（別戦線・かなピボット）
- UI 言語とラベル言語を分ける：`?labels=<lang>`（#11 の骨子）。既定＝UI 言語に追従。
- 日本の地名＝かなピボット（読みテーブル 1 本＋字訳規則＋外名表＋種別語表）。差し替え点は `style-mono.js` の `text-field` 一枚。
- 星座名・メシエ名は済（2026-09-19）＝bucket GIS/space/i18n（正本 packages/space・Wikidata の見出し＋手当て・26 言語・solar と同じ JSON）。`planets.js` の惑星名は未。
- 国名・他国の地名は world の名前テーブル（既に 26 言語）を使う＝japan で新しく焼かない。
- ここは #11 本体に残る。japan では枠（`?labels=`・切替点）だけ先に用意する。

### 対象外（据え置き）
- poiedit / scene editor（本人道具）・`.scenes` 台本（scene[lang] 既存）・console/HUD（英語固定の裁定）。AI ガジェットは 9/16 に開発中止で削除済。

## 4. #11 との関係

japan で Phase 1–2 を済ませると #11 の「ja→en の逆転」と RTL の UI 側が消え、#11 は「ラベル言語（かなピボット）＋globe の芯への搭載」だけになる。#7 の芯切り出し時に `i18n.js` は world の `trans` と同一契約なので、globe は **japan の i18n をそのまま持ち上げられる**（フォーク不要の部品）。

**裁定 B（9/16）**：world との共有モジュール化は**不要**。形（契約・JSON・langs.json）だけ合わせ、コードは japan の `i18n.js` が自前で持つ。

## 5. 順序と規模

| Phase | 規模 | 前提 |
|---|---|---|
| 0 計量と道具 | 半日 | なし |
| 1 英語キー化 | 2–3 日（置換 1 日・訳生成 24 言語 半日・検定 1 日） | 0 |
| 2 RTL | 半日 | 1 |
| 3 ラベル言語 | かなピボット戦線（別栞） | 1 |

ロードマップ登録：Issue「ortho-japan の i18n を world に合わせる（英語キー・26 言語・RTL）」＝#7 の子・Area ortho-japan・互換維持・P1。#11 の本文は Phase 3 だけに縮める。
