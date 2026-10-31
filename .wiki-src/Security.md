> **English** · [日本語](Security-ja)

# Security

The full policy is [SECURITY.md](https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/SECURITY.md) ([日本語](https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/SECURITY.ja.md)). In short:

## Reporting a vulnerability

**Do not report security problems in public issues, pull requests or discussions.** Use GitHub's private reporting: [Security tab](https://github.com/kenjiyoshidahome2026-bit/ortho-earth/security) → **Report a vulnerability** ([direct link](https://github.com/kenjiyoshidahome2026-bit/ortho-earth/security/advisories/new)). English or Japanese is fine. A contact is also listed at `https://www.ortho-earth.com/.well-known/security.txt`.

- Acknowledgement within 7 days; fix and a GitHub Security Advisory with credit; please allow up to 90 days before public disclosure.
- In scope: code in this repository (engine, SDKs, file-format readers and writers, apps, site, the Cloudflare Workers). Out of scope: third-party services and data the apps only display, traffic floods, scanner output without a demonstrated impact.

## Supported versions

Fixes land on `main` and ship in the latest published version of each package (`@ortho-earth/globe`, `core`, `geopbf`, `japan`: latest 2.x; others: latest release). The site at www.ortho-earth.com is always the current deployment. No backports.

## What protects the project today

- **Code scanning:** CodeQL on every pull request (JavaScript/TypeScript, Rust, Actions). On 2026-10-31 all 26 open alerts were triaged: 7 fixed in #821, 19 dismissed with a reason.
- **Dependencies:** Dependabot alerts and monthly grouped update PRs with a 7-day cooldown (new versions wait a week; security updates come at once). `npm audit` is at 0 (#822). Audit findings are fixed properly, never with `npm audit fix --force`.
- **CI:** no `pull_request_target`; the test workflow has `contents: read`; pull requests from outside need approval before Actions run. Deploy keys stay on the Mac (`wrangler` login), not in GitHub secrets.
- **Site:** HSTS, `nosniff`, `Referrer-Policy`, `X-Frame-Options` / `frame-ancestors` on www; `ortho-earth.com` redirects to `www` with 301. Write endpoints need a key, the proxy only allows listed hosts, and rate limits are on. The sign-in cookie is `__Host-`, `HttpOnly`, `Secure`, `SameSite=Lax`.
- **Not done on purpose:** a site-wide Content-Security-Policy, because the many apps make a wrong CSP likely to break pages.
