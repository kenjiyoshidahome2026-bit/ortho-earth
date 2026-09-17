# 申し送り — 2026-09-17（家 → オフィス）

書いた相手：**オフィスで続きをやる自分**。読む順は「① いまどこにいるか → ② 次の一手 → ③ 踏むと痛い落とし穴」。
この文書は使い捨て。再開して片付いたら消すか、次の申し送りで上書きする。

---

## ① いまどこにいるか

**本番は両方とも今日の版が出ている。作業ツリーは空（全部 push 済み・main = 4e2dfec＋この文書）。**

| 面 | 版 | 状態 |
|---|---|---|
| www.ortho-earth.com/japan/ | 77eee6fd | 26 言語・RTL・地域宣言（第一段＋第二段）＋建物 3D の plateau/manager.js（契約つき）が稼働 |
| www.ortho-earth.com/nl/ | 704467fa | 独立の地域として稼働（台帳 3 件・出典 3DBAG のみ・app.js 直束ね＝japan と同版） |

今日やったのは大きく三つ。

1. **UI の 26 言語化＋RTL**（4c33000 / 139012e / 8500806）
   日本語キーの辞書をやめ、英語キー＋言語ごとの遅延チャンクへ。主チャンクの日本語は 0 文字。
   右横書き 4 言語は `#map` に `dir` を付け、quiet-mono の端寄せを論理プロパティへ。
2. **AI ガジェット撤去と edit.html 撤去**（4c33000 / c260d63）
   どちらも本人裁定。AI は復活提案をしない。任意座標系の手合わせツールは geoedit 側へ寄せる前提で撤去。
3. **日本固有機能の切り出し（三段）**（f8a8c16 / a0f968d / 5517f7e / d77dd65）
   **エンジン（ortho-core）と altpbf に残る日本固有の語彙は、コード実体で 0 行になった。**
   国名・層名・コード・bbox は全部アプリ側の宣言（`jp/`・`nl/`）に移った。

### 切り出しの形（この筋を続ける）

地域の知識は **「データの記述子」** にしてアプリから注入する。クラスや継承は作らない。

```
jp/dtm.js      裸地標高の申告 { bbox, range, brand }        …… altpbf と terrain が受け取る
jp/region.js   dtm ＋ 建物台帳の在り処 ＋ 基図 ＋ 出典 ＋ 初期視点
nl/region.js   同じ形（dtm=null・建物 3 件・基図 null・出典 3DBAG）
style-mono.js  schema ＝ ソースの語彙（建物層名・種別→高さ・注記の分類属性・合成水域の名乗り）
```

app.js は宣言を**合成するだけ**。入口の裁きは 3 通り。

- 既定 … `[JP]`
- `?nl=1` … `[JP, NL]`＝日本に足す（開発の重ね確認。日本へ飛べば日本の建物も出る）
- `/nl/` … `[NL]` だけ＝独立の入口（日本の台帳も基図も持ち込まない）

**基図を宣言しない地域の既定**＝タイルを一枚も要求しない空ソース（coverage = `[0,0,0,0]`）＝図郭外と同じ
「標高ゲート付き全面水域」。オランダは日本の配信圏の外なので、これは移設前と同じ見え方。

---

## ② 次の一手（優先順）

### A. 建物のロード順・予算の API 化 ＝ 最後の山

**（オフィス 2026-09-17）第一歩＝「動作を変えない移動」は完了。** 690 行は `plateau/manager.js`（`createPlateauManager(env)`）へ。
app.js に残るのは配線 15 行＝app の状態（cam・moving・flying・printHold・elevBusy・登録簿・除外マップ）を getter で覗かせ、
生成後に定義される関数（unprojectXY／playingNow／flyTo）はラップして渡し、戻り値を移設前と同じ名前に分割代入（以降の参照は無改造）。
`flying` の宣言だけ app.js に残した（flyTo の onFlying が代入する app の状態）。
機械置換の diff 検分で 1 件捕まえた＝`\bcam\b` が worker への `type: "cam"` 文字列にも掛かっていた（直済み・文字列の守りを生成器に追加）。
**第二歩＝契約の導入も完了（同日）。** env は 3 束（機能スイッチ・装置の旗 `device`・登録簿 `catalog`／描画側の口 `renderer`
`attachMeshPort`／app の状態の覗き窓 getter＋`footPoint()`・`viewBbox()`・`playingNow()`・`flyTo()`）。戻り値は
`update / standUp / prefetch / trimForScript / firstRevealSets / setExcludeMap / setProgressTap / terminate / sets / progress /
isActive / isDead / visibleLoading / memStats / openDb`。登録簿と除外マップは manager が持つ（app は catalog の Promise を渡すだけ）。
分割代入は消え、app.js は `plateau.update()` 等の呼び口だけ。`firstRevealSets` と HUD の常駐バイト集計も manager へ。
**踏んだ罠**＝`const foot = foot()`（env の関数と局所変数の同名＝自己シャドウ TDZ）。catalog の `.catch` が例外を「catalog fetch failed」の
皮で飲んで見えなかった＝t-plateau が「start が来ない」で捕まえ、門に console 採取を足して原因を出した。一突きは `.catch` の外へ出した。
`terminate()` は見張りタイマーも止める（destroy 後に worker を起こし直さない＝第二歩で足した唯一の挙動追加）。
**次＝A は完了。** B（スタイルの置き場）は二国目待ち、C は次の大版まで触らない、D は小物。#8 の本文は「japan で直接やった（再裁定 9/14）」に直した＝(1) 専用 5 ファイルの `plateau/` 寄せと (3) 建物枠の契約は #8 側の次の段。

`app.js` の連続 690 行（表示判定・ヒステリシス・ロード順・取り消し・降格・常駐予算・追い出し・遠景の星座・
先読み）が一塊のまま。切り出し三領域のうち、ここだけ手つかず。

- **まず動作を変えない移動から。** 契約の導入は別コミットに分ける（#8 の「凍結の尊重」と同じ作法）。
- **永続化の鍵には触れない。** 版番号 3 つ（DECODE_VER=5 / PLQ_VER=2 / FAR_VER=3）が利用者の IndexedDB・
  OPFS・R2 の鍵に焼き込まれている。動かすと全国のキャッシュが一斉に飛ぶ（Air3 で実機が落ちた型）。
- 参考：ロードマップ #8 が設計の骨子を持っている。**ただし #8 は「globe へフォークして切る」前提で書かれている。**
  9/14 の再裁定（globe 未着手のうちは japan を直接整えてよい）に沿って、今日はすべて japan で直接やった。
  同じ判断を続けるなら #8 の本文もその旨に直す。

### A′. app.js の見通し（オフィス 9/17 午後・本人「app.js がまだ巨大」→「動作を変えない移動」）

3,552 行 → **2,389 行**。plateau と同じ作法（動作を変えない移動・env の getter・元ブロックとの diff 検分・全門緑）で 4 段：

| 移設先 | 行 | 中身 | 門が捕まえた事 |
|---|---|---|---|
| `gint/layers.js` | 667 | 単一スロット・多層 addGint・admin0・bake-ahead・ドレープ・fid 塗り・queryAll。外が読み書きしていた let は `gint.*` のアクセサ | — |
| `sky/theater.js`／`jp/n02.js` | 251 | 星空劇場（render() の太陽系圏 8 行は `solarFrame`）／N02 新幹線（**日本の知識＝jp/ の下**・本人裁定） | `let a=…, b=…` の複数宣言を xref が先頭しか拾わず `constelVisible` が外に残った（ui 4 頁・webgpu 4 頁・prod が赤）。xref を直した |
| `scenes/player.js` | 207 | 上映・停止・タイムライン・黒幕・フェード・待ちパネル。?scene=/?g= の起点と remoteUrl は app に残す | — |
| `boot/tier.js` | 115→純関数 | lowMem / classifyTier / probeGL / fatalOverlay / deadMap。**`tests/t-tier.mjs`（25 件・npm test に登録）** | — |

残る app.js＝芯（render worker 配線・層状態・onMove/render・フライト・入力）＋公開面（map.*）＋配線＋印刷 33 行。
**次の段（契約）の候補**：jp/n02.js を地域宣言（jp/region.js）から注入して /nl/ では作らない／gint.* の 14 個のアクセサを意味のある口に／
scenes の demoHandle 預けを mount の戻り値に。**t-print・t-anno は連続実行でだけ落ちる環境フレーク＝単独で回してから疑う。**

### B. スタイルの置き場（基図を持つ二国目が現れた時）

第二段で移したのは基図の**ソース**と**出典**まで。スタイル（style-mono 206 行＋テーマ変換 3 本＋分類表＋
路線記号＝600 行規模）はアプリに残した。これは宣言ではなく設計資産なので、二国目が自分の基図を持つまで
決める材料がない。**今は決めなくてよい。**

### C. 公開面（次の大版まで触らない）

表示項目の 5 語（place / terrain / rail / road / facility）とテーマ名は、SDK の型・チップの識別子・共有 URL・
内部の状態キーの 4 つに同時に出ている。触ると破壊的。GeoPBF v2.0.0 と同じ列で扱う。

### D. 小物

- `scripts/bake-arbitrary.mjs`（焼く側）は残してあるが、**焼いた図郭 JSON を読む側が居ない**
  （edit.html を撤去したため）。任意座標系を再開する時は geoedit 側の経路に載せ替える。
  なお `public/moj-local/`（123 MB・git 管理外）は**この機体には無い**。必要なら bucket から取り直す。
- i18n の未訳ゼロは `verify:i18n --strict` で担保している。新しい文言を足したら
  `npm run i18n:extract` → ja を埋める → 24 言語を埋める → `npm run i18n:build`。
  **表/配列に置くキー（`THEME_META` 等の間接参照）は自動発見できない＝新設時だけ ui.json に手で足す。**

---

## ③ 踏むと痛い落とし穴（今日ぜんぶ踏んだ）

### 1. スクリーンショットを門にする前に「地図が写っているか」を確かめる

「東京 z16 の実描画が変更前後で 1 画素も違わない」と報告して、**誤りだった**（訂正コミット c34f438）。
撮れていたのは起動待ちカードと WebGL2 起動失敗カード。両方が同じ失敗画面だったから一致して見えただけ。

- `--virtual-time-budget` ＋ `--screenshot` … worker の rAF が回らず**地図が描かれる前に**撮る。
- CDP 実時間でも `/japan/` 本体は swiftshader で WebGL2 が立たない（`tests/*.html` は同じ flags で描ける）。
- **正解は `tests/t-bld.html`**（今日新設）＝ページ内で shot の snapshot を撮って画素を数える。
  これは **`verify:webgpu`（実時間）側**に載せる。虚時間では snapshot の往復が返らない（composite timeout を実測）。
- 疑い方：中央部の紙色が 9 割超なら地図が写っていない。2 枚が完全一致したらまず両方失敗を疑う。

### 2. Vite で動く ≠ Node で動く（JSON の静的 import）

`i18n.js` が `langs.json` を静的 import していたため Node が import 属性を要求し、`npm test` だけが落ちた。
生成物を `i18n/langs.js`（ES モジュール）に変えて解消。**JSON を静的 import したくなったら .js を生成する。**

### 3. 使う所より前で決める（TDZ）

地域宣言の合成を宣言の近く（700 行台）に置いたら、最初の利用者である render worker の init（500 行）から
見えず `Cannot access 'REGION_DTM' before initialization` で落ちた。`verify:prod` が「boot の要求 11 件」
「scene UI 不在」で捕まえた。**app.js は上から下へ実行される長い一本道**＝定数は使う所より前に置く。

### 4. DOM から要素を取るなら全文正規表現（grep は行単位）

出典の変更前後を比べようとして 2 回空振りした。旧コードのテンプレート literal が複数行だったため、
行単位の grep に掛からず**空文字どうしを比べていた**。全文正規表現＋空白正規化で測り直して完全一致を確認。

### 5. t-anno は環境フレーク（今日の変更とは無関係）

連続実行でだけ落ちる。失敗した回はテスト自身の fixture `test/anno`（251 B・bucket）の取得が起きていない。
単独実行は 3/3 PASS。`gadgets/anno.js` と `tests/t-anno.html` は今日 1 文字も触っていない。
**赤くなっても一度は単独で回してから疑うこと。**

---

## 検定の一覧（今日増えた分）

| 門 | 内容 |
|---|---|
| `npm test` | 4 本 67 件：scene アダプタ／`t-dtm`（標高の申告 20 件）／`t-vocab`（ソースの語彙 18 件）／`t-region`（地域宣言 29 件） |
| `npm run verify:i18n [-- --strict]` | キー存在・ja 必須・`$1` 整合・文脈標識の混入・未訳件数（26 言語） |
| `npm run verify:ui` | 22 頁（`t-rtl` と `t-rtl?lang=ar` を追加） |
| `npm run verify:webgpu` | `t-bld?gl2=1` を追加＝**建物が実際に立つ絵**（東京駅前 z16 チルト 55°・bld=42,523 px） |
| `npm test` | `t-tier`（起動時の裁き＝ティア判定・deadMap 25 件・オフィス 9/17 午後）を追加＝5 本 92 件 |
| `npm run verify:webgpu` | `t-plateau?gl2=1&loadmax=1` を追加（オフィス 9/17）＝**PLATEAU が実際に立つ**（東京駅前 z16 チルト 55°・登録簿→start→done→活性化を map.on("plateau") で見届ける・R2 焼きで約 11 秒） |
| `npm run verify:prod` / `deploy` | 従来どおり。deploy は verify:editor → verify:prod → wrangler → verify-live |

---

## 再開の一行

~~「app.js の建物 690 行を、動作を変えずに `plateau/` へ寄せる」~~ ＝ 済。~~「env と戻り値を契約の形に整える」~~ ＝ 済（どちらもオフィス 9/17）。
**A は完了＝切り出し三領域は全部片付いた。push・本番 deploy（japan 2e48128d／nl 0c283533・verify-live 134 本 200）も済。** ロードマップ #8（GitHub Issue）の本文も更新済（現状・段階の進捗・前提の再裁定・未決の当面の答え）＝**A に残件なし**。
以後 PLATEAU 周りを触る時は `verify:webgpu t-bld t-plateau` と `verify:prod` を先に緑にしてから。
