# 申し送り（閉じた）→ 落とし穴の控え

2026-09-17（家 → オフィス）の申し送りは片付いた（建物のロード順の切り出し・契約の導入・本番 deploy まで済）。
書かれていた構成（app.js の本体・`plateau/manager.js`・`gint/layers.js` など）は、その後の段階 2〜4 で
**地球儀のホスト `packages/globe`（@ortho-earth/globe）へ移った**。今の構成と層の掟は **[LAYERS.md](../../LAYERS.md)** を読む。
`apps/ortho-japan/app.js` は「globe＋日本の申告」を包むだけの薄い入口（十数行）。

ここに残すのは、その日に踏んで今も効く落とし穴だけ（2026-09-25 に整理）。

---

## 1. スクリーンショットを門にする前に「地図が写っているか」を確かめる

「東京 z16 の実描画が変更前後で 1 画素も違わない」と報告して、**誤りだった**（訂正コミット c34f438）。
撮れていたのは起動待ちカードと WebGL2 起動失敗カード。両方が同じ失敗画面だったから一致して見えただけ。

- `--virtual-time-budget` ＋ `--screenshot` … worker の rAF が回らず**地図が描かれる前に**撮る。
- CDP 実時間でも `/japan/` 本体は swiftshader で WebGL2 が立たない（`tests/*.html` は同じ flags で描ける）。
- **正解は `tests/t-bld.html`**＝ページ内で shot の snapshot を撮って画素を数える。これは **`verify:webgpu`（実時間）側**に載せる
  （虚時間では snapshot の往復が返らない）。
- 疑い方：中央部の紙色が 9 割超なら地図が写っていない。2 枚が完全一致したらまず両方失敗を疑う。

## 2. Vite で動く ≠ Node で動く（JSON の静的 import）

`i18n.js` が `langs.json` を静的 import していたため Node が import 属性を要求し、`npm test` だけが落ちた。
生成物を `i18n/langs.js`（ES モジュール）に変えて解消。**JSON を静的 import したくなったら .js を生成する。**

## 3. 使う所より前で決める（TDZ）

地域宣言の合成を宣言の近くに置いたら、最初の利用者である render worker の init から見えず
`Cannot access '…' before initialization` で落ちた。**`packages/globe/src/globe.js`（createGlobe の本体）は上から下へ
実行される長い一本道**＝定数は使う所より前に置く。`verify:prod` が「boot の要求件数」「UI 不在」で捕まえる。

## 4. DOM から要素を取るなら全文正規表現（grep は行単位）

複数行のテンプレート literal は行単位の grep に掛からず、**空文字どうしを比べて一致**に見える。全文正規表現＋空白正規化で測る。

## 5. 実時間の頁が単独では通るのに連続実行で落ちる

一度は単独で回してから疑う。そのうえで次を確かめる（2026-09-25 追記）：
- **置き去りの headless Chrome**（`pgrep -fl headless=new`）。runner は CDP の port を Chrome に選ばせるようにした（ui-runner）が、
  他のスクリプトは決め打ちの port を使うものがある。
- **外部の揺れのせいにしない**：外部を手元の資料に替えて回数を取る。globe の t-request の「揺れ」は、起動直後に古い fallback scene が
  multi_draw の draw list を上書きする実バグだった（fadede8b）。

---

検定の入口はルートの `npm test`（Node のみ・約 30 秒）と、各パッケージの `verify:*`（ブラウザ）。一覧はルートの README。
