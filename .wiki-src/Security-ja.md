> [English](Security) · **日本語**

# セキュリティ

方針の全文は [SECURITY.ja.md](https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/SECURITY.ja.md)（[English](https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/SECURITY.md)）にあります。要点は次のとおりです。

## 脆弱性の報告

**公開の issue・PR・discussion には書かないでください。** GitHub の非公開の報告を使います：[Security タブ](https://github.com/kenjiyoshidahome2026-bit/ortho-earth/security) → **Report a vulnerability**（[直接のリンク](https://github.com/kenjiyoshidahome2026-bit/ortho-earth/security/advisories/new)）。英語でも日本語でも構いません。連絡先は `https://www.ortho-earth.com/.well-known/security.txt` にもあります。

- 7 日以内に受け付けの返事、修正後に GitHub Security Advisory で報告者の名前を載せて公開。公表までは最長 90 日ほど待ってください。
- 対象：このリポジトリのコード（エンジン・SDK・ファイル形式の読み書き・アプリ・サイト・Cloudflare Workers）。対象外：アプリが表示するだけの外部のサービスとデータ、大量のアクセス、影響を示していない自動スキャンの結果。

## サポートする版

修正は `main` に入り、各パッケージの最新の公開版で出ます（`@ortho-earth/globe`・`core`・`geopbf`・`japan` は最新の 2.x、その他は最新版）。www.ortho-earth.com は常に今の配布です。古い版への移植はしません。

## 今の守り

- **コードスキャン：** PR ごとに CodeQL（JavaScript/TypeScript・Rust・Actions）。2026-10-31 に開いていた警告 26 件をすべて仕分け、7 件を #821 で修正、19 件は理由を付けて却下。
- **依存：** Dependabot の警告と、月 1 回まとめた更新 PR（出てから 7 日たった版だけ・セキュリティ修正は待たない）。`npm audit` は 0 件（#822）。直す時は正しく直し、`npm audit fix --force` は使いません。
- **CI：** `pull_request_target` は使わず、test は `contents: read`。外部からの PR は承認しないと Actions が走りません。配布の鍵は GitHub の secrets ではなく Mac（`wrangler` のログイン）にあります。
- **サイト：** www に HSTS・`nosniff`・`Referrer-Policy`・`X-Frame-Options`／`frame-ancestors`。`ortho-earth.com` は `www` へ 301。書き込み口は鍵が要り、中継は許可した先だけ、回数制限あり。ログインの Cookie は `__Host-`・`HttpOnly`・`Secure`・`SameSite=Lax`。
- **意図して見送り：** サイト全体の Content-Security-Policy。アプリが多く、設定を誤ると頁が壊れる危険のほうが大きいためです。
