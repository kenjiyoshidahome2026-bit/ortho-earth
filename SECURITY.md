# Security Policy

[日本語版はこちら (Japanese)](SECURITY.ja.md)

Ortho Earth is maintained by one person. Thank you for helping keep it and its users safe.

## Supported versions

Security fixes are made on `main` and released in the **latest published version** of each package. Older versions do not get backports.

| Package | Supported |
| --- | --- |
| `@ortho-earth/globe`, `@ortho-earth/core`, `geopbf` | latest 2.x release |
| `@ortho-earth/japan` | latest 2.x release |
| Other `@ortho-earth/*` packages, `altpbf`, `geoedit`, `glbconv`, `native-bucket`, `quiet-mono` | latest release |
| The website and apps at [www.ortho-earth.com](https://www.ortho-earth.com) | current deployment |

## Reporting a vulnerability

**Please do not report security problems in public issues, pull requests or discussions.**

Report them privately through GitHub:

1. Open the [Security tab](https://github.com/kenjiyoshidahome2026-bit/ortho-earth/security) of this repository.
2. Click **Report a vulnerability** ([direct link](https://github.com/kenjiyoshidahome2026-bit/ortho-earth/security/advisories/new)).
3. Describe the problem.

Helpful details:

- the affected package and version, or the page URL on www.ortho-earth.com
- what an attacker could do (impact)
- steps to reproduce, or a minimal proof of concept (a file, a URL or a few lines of code)
- the browser and OS, if it matters

Reports may be written in English or Japanese.

## What happens next

- We aim to acknowledge your report within **7 days**.
- We will confirm whether it is a vulnerability, and keep you updated while a fix is prepared.
- When the fix is released, we publish a GitHub Security Advisory and credit you, unless you prefer not to be named.
- Please give us a reasonable time to fix the problem (normally up to 90 days) before you disclose it publicly.

## Scope

In scope:

- code in this repository: the engine, the SDK packages, the file-format readers and writers (`geopbf` and others), the apps and the website
- for example: script injection (XSS) from map styles, data files or URL parameters; crashes or memory exhaustion triggered by a crafted file; problems in the Cloudflare Workers that serve the site

Out of scope:

- vulnerabilities in third-party services and data that the apps only display (for example map tiles, PLATEAU, GSI or other public data providers); please report those to their owners
- denial-of-service by sending large amounts of traffic, and spam
- findings from automated scanners without a demonstrated impact
- missing security headers or best-practice suggestions without a concrete attack

## Safe harbor

We will not take legal action against anyone who researches and reports in good faith under this policy: do not access or change other people's data, do not degrade the service for others, and give us time to fix the problem before disclosure.
