# jetsam（モバイルのメモリ強制終了）対策 まとめ

最終更新: 2026-07-30

iOS Safari はタブ1枚あたりのメモリ上限を超えると **WebContent プロセスを強制終了（jetsam）** し、
自動リロードする。ortho-japan は PLATEAU(LOD2建物)・標高アトラス・ベクタタイル・gint層を同一 GL に
積むため、密度の高いシーンでこの上限に触れやすい。本ドキュメントは対策の現況・実測・残課題の台帳。

---

## 1. 前提の物理：タブのメモリ予算

**常駐バイト（GPUバッファ・tess・標高テクスチャ）は端末非依存**（同じメッシュなら同じMB）。
変わるのは *予算* と OS の jetsam 閾値だけ。

| 端末 | 推定タブ予算 | 備考 |
|---|---|---|
| iPhone 16（8GB） | ~1.4GB | 実測: 全区表示シーンで peak 720MB／6区でも余裕（~400MB残） |
| 4GB 機 | ~900MB | HUD の予算基準。iOS はメモリ管理が優秀で 4GB でも完走実績あり |

> **iOS は WebGL バッファが WebContent プロセス＝タブ予算に直接乗る**（デスクトップは GPU プロセス別勘定）。
> この会計差がデスクトップ計測で jetsam が映らなかった理由。**iOS の問題はデスクトップ計測で否定できない。**

---

## 2. 端末判定：`LOW_MEM`

[app.js:121](../app.js#L121)
```js
const LOW_MEM = navigator.deviceMemory ? navigator.deviceMemory <= 4 : navigator.maxTouchPoints > 1;
```

- **Android / Chrome系**: `deviceMemory` が 4 or 8 を返す（2の冪・8で頭打ち）＝ **4GB↔8GB を判別できる**。
- **iOS / Safari**: `deviceMemory` 非対応（undefined）＝ **4GB↔8GB を判別できない**（UA も機種を隠す・
  `hardwareConcurrency` は RAM 無相関）。→ タッチ端末は **一律 LOW_MEM（最悪＝4GB想定）** に倒す。
- 起動コンソールに `[plateau] 低メモリ端末モード` が出れば LOW_MEM 有効。

---

## 3. 二つの敵：常駐 と 過渡

jetsam は **常駐（resident）** と **過渡スパイク（transient）** の合計がタブ予算を超えると発火する。

- **常駐** = GPU に載りっぱなしのバイト（PLATEAU VAO・タイル tess・標高アトラス）。`?mem=1` HUD で見える。
- **過渡** = デコード中だけ膨らむ一時メモリ（PLATEAU 密集区 ~0.3GB/区、R01 タイル9枚の一斉デコード等）。
  **HUD には出ない**＝別途コメント実測で補正する。**jetsam の主犯はたいてい過渡。**

判定式（4GB機を出す時の目安）:
```
peak(常駐) + 過渡(~0.3GB × 同時デコード数)  <  タブ予算(~900MB / 4GB)
```

---

## 4. `LOW_MEM` が絞っているもの（常駐＆過渡の両面）

| 対象 | 非LOW_MEM | LOW_MEM | 効く先 | 場所 |
|---|---|---|---|---|
| PLATEAU 同時表示区 `MAX_ACTIVE` | 4 | **2**（区境カタカタ根治／`?maxact=1`が逃げ道） | 常駐 | [app.js:341](../app.js#L341) |
| PLATEAU 橋等 `EXTRA_ACTIVE` | 4 | **1** | 常駐 | [app.js:344](../app.js#L344) |
| GPU常駐LRU `RESIDENT_BYTES` | 1.2GB | **0**（再訪は再ロード） | 常駐 | [app.js:353](../app.js#L353) |
| PLATEAU worker 数 `NW` | ~cores-1 | **1本固定** | 常駐(loaders.gl基盤) | [app.js:397](../app.js#L397) |
| 同時デコード `bldCap` | 2 | **1** | 過渡 | [app.js:691](../app.js#L691) |
| タイル tess 予算 `memBudgetMB` | auto | **24MB**（`?tbudget`可） | 常駐 | [app.js:802](../app.js#L802) |
| multi_draw 常駐プール | ON | **OFF**（`?md=1`で復活） | 常駐 | [app.js:213](../app.js#L213) |
| plateauworker `CACHE_MAX` | 2区 | **0** | 常駐 | [plateauworker.js:616](../plateauworker.js#L616) |
| plateauworker `BATCH_TILES` | 32 | **8** | 過渡+IDBバースト | 同上 |
| plateauworker `TILE_CONCURRENCY` | 8 | **4** | 過渡 | 同上 |
| 標高 R10 キャッシュ | 256MB | **64MB** | 常駐 | [terrain.js:22](../../../packages/ortho-core/src/terrain.js#L22) |
| 全球 R90 先読み | ON | **スキップ** | 過渡(起動) | [renderworker.js:101](../renderworker.js#L101) |
| 海岸線 gint | 10m(41万頂点) | **50m(数万)** | 常駐 | app.js loadWorldCoast |
| user/coast gint 束 | 常駐 | **退場時に破棄** | 常駐 | app.js |

---

## 5. 2026-07-30 セッションで入れた改善（すべて本番Live）

| # | 内容 | jetsam への効き | Version |
|---|---|---|---|
| A | **標高アトラスを R32F→R16F** | アトラス GPU **半減**（4B→2B/texel）＋全機で線形フィルタ可（拡張非対応でも滑らか） | `a924ea9d` |
| B | **混成R01近景を lowMem 既定ON** | 品質向上。iOS 4GB で **peak 84MB・完走**を実測＝安全確認。逃げ道 `?nor01=1` | `47b9e863` |
| C | **optbv 圏外タイルの fetch 抑制**（`JP_COVERAGE`） | 縦長スマホの無駄 fetch/tess を削減（404 も消滅） | `1f311233` |
| D | 海岸線 50m を bucket 収録 | S3 shape フォールバック回避（メモリでなく安定性・404） | bucket |

> **B の含意**: 「iOS 4GB は R01 デコード過渡を完走できる」＝ Kenji の読み（iOS のメモリ管理は優秀）が実証。
> **A の含意**: R16F 化は品質修正のはずが、副産物で **標高側の常駐を半減**＝jetsam にも効いた。

---

## 6. 計測ノブ（実機 A/B 用・すべて opt-in）

| クエリ | 効果 |
|---|---|
| `?mem=1` | 常駐メモリHUD（plateau+tiles+terrain・走行後peak・4GB予算残）。過渡は非表示 |
| `?maxact=N` | PLATEAU 同時表示区数の上書き（絞りを緩める） |
| `?tbudget=N` | タイル tess 予算(MB)の上書き（`?tbudget=48`で戻す・`0`で auto） |
| `?nomd=1` / `?md=1` | multi_draw 常駐プールの OFF/強制ON |
| `?nocov=1` | 圏外タイル抑制の無効化（旧挙動＝周縁404復活） |
| `?nor01=1` | 混成R01近景の無効化（全面R10へ＝R01過渡で落ちる端末の逃げ道） |
| `?nogint=1` | gint 層の無効化 |
| `?perf=1` | フレーム内訳（map/gint の CPU ms・EMA・JSヒープ）を2秒毎に console |

---

## 7. 検証手法（再利用可）

- **headless Chrome + deviceMemory 偽装**: `Page.addScriptToEvaluateOnNewDocument` で
  `Object.defineProperty(navigator,'deviceMemory',{value:4})`＝LOW_MEM を踏ませる（タッチ偽装では踏めない）。
- **footprint 合計**: `footprint <pid>`（macOS）。**必ず1PIDずつ・ヘッダ行 `Footprint: N MB` をパース**
  （複数PID渡しと単発で出力形式が揺れる。ps RSS は圧縮で崩れる＝偽値）。GPUプロセス込みで見る。
- **worker の network / console**: CDP `Target.setAutoAttach{waitForDebuggerOnStart}` で worker 起動前に
  アタッチ→各 session で `Network.enable`/`Runtime.enable`（タイル fetch は tileworker 内で起きる）。
- **⛰トースト**: 標高ローダは死因を画面トーストで自己申告（借り物端末＝インスペクタ不可でも読める）。
- **拡張チェック**: `document.createElement('canvas').getContext('webgl2').getExtension('OES_texture_float_linear')`
  （null=非対応）。

---

## 8. 残っている論点・ウォッチリスト

- **[未検証] Android 4GB の R01**: `deviceMemory=4` も LOW_MEM＝R01 既定ON になったが、Android は
  メモリ管理が緩く R01 デコード過渡で落ちる余地（iOS は実証済み）。報告が出たら:
  - 即時 = `?nor01=1`
  - 恒久 = R01 既定を **iOS系（deviceMemory 未定義）だけ** に絞る枝を入れる
- **[完了 2026-07-30] `MAX_ACTIVE` を LOW_MEM=2 化**（`e9d1471f`）: 区境の千代田⇄中央カタカタ根治。worker切離し
  済で増えるのは常駐のみ(+1区~100-140MB)・過渡は bldCap 据置で不変。逃げ道 `?maxact=1`（落ちたら戻す）。
  ※台本の全区表示(6区/720MB)はピン数が governor で maxact では動かない（別レバー）。Android 4GB は R01 と同じく様子見。
- **iOS の全区表示（ピン留め）を 4GB 安全にするなら**: iOS で 4/8GB を判別できない以上、
  反応的ダウングレード（jetsam→自動リロードを sessionStorage フラグで検知し次回絞る）が唯一の現実手。

---

## 9. 決着済みの経緯（履歴）

- **iOS jetsam 三部作**（iPhone 16 Pro 実機の墜落を段階根治・本番済み）: 先読み停止+バッチ縮小 →
  R10キャッシュ縮小 → 混成モード OFF+アトラス縮小 → pagehide destroy → **multi_draw 常駐プールが主犯確定
  （LOW_MEM 既定OFF）**。iPhone 16 Pro でデモ完走＝iOS 対応クローズ。
- **高チルト膨張の真犯人 = coast（世界海岸線 gint）**＝Kenji 解決済み（md は冤罪だった）。
- **worker 数の maxact 連動が過絞りの真犯人**（loaders.gl 起動ベースライン倍増）→ `NW` を LOW_MEM=1本固定に切離し。

> 詳細な実測ログは記憶ファイル `project_fatal_overlay_plateau_oom` / `project_tablet_perf` を参照。
