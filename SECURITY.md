# Security Policy

leerness Gate handles GitHub App credentials (a private key + webhook secret) and runs as a Cloudflare Worker on incoming webhooks, so we take reports about its trust boundaries seriously.

> Maturity: this is an early, solo-maintained project. There is no formal SLA — reports are handled on a best-effort basis, but security reports are prioritized over feature work.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.** Instead:

- Open a private **GitHub Security Advisory** on this repository (Security → Report a vulnerability), or
- Contact the maintainer privately.

Include enough detail to reproduce: the affected component, the request/payload, and the observed vs expected behavior. A minimal proof of concept helps a lot.

## In scope

- Webhook signature verification (`src/verify-signature.js`) — any bypass of the HMAC-SHA256 check.
- App JWT / installation-token handling and the PEM parser (`src/github.js`) — credential leakage or signing flaws.
- The `/setup` registration callback (`src/index.js`) — reflected content, open redirects, or secret exposure.
- Repo config trust (`getRepoConfig`) — any way a pull request could weaken or disable the gate on itself.
- The verdict core (`src/gate-check.js`) — input that crashes evaluation (a thrown error means no check is posted) or a denial-of-service via crafted PR text.

## Out of scope

- The verdict being "wrong" on a legitimately ambiguous PR (tune via `.leerness-gate.json`, or open a normal issue).
- Vulnerabilities in third parties (GitHub, Cloudflare) — report those to the respective vendor.

## Handling

Credentials live only in Worker secrets (`wrangler secret`), never in the repository. If you believe a secret was exposed, rotate it immediately (generate a new App private key, reset the webhook secret) and re-run the setup flow.
