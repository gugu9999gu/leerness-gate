# Deploy leerness Gate

Turning the (already-tested) Worker into a live GitHub App. ~10 minutes. You need a **Cloudflare account** (free tier is fine) and a **GitHub account**.

> The verification core + Worker are already unit-tested (`npm test`, 77 tests). This guide only wires up *your* credentials — none are stored in the repo.

## 0. Prerequisites

```bash
npm install                 # installs wrangler (dev dependency)
npx wrangler login          # authenticate Cloudflare (opens browser)
```

## 1. Deploy the Worker (get its URL)

```bash
npm run deploy              # = wrangler deploy
```

Note the deployed URL, e.g. `https://leerness-gate.<your-subdomain>.workers.dev`. This is your **webhook URL**.

## 2. Register the GitHub App (one click)

Open **`deploy/register.html`** in a browser, paste the webhook URL from step 1, and click **Create leerness Gate App**. GitHub opens pre-filled with the correct settings:

- Permissions: **Checks: read & write**, **Pull requests: read**, **Contents: read**
- Events: **Pull request**
- Webhook URL: (your Worker URL)

Finish creation, then on the App page:
1. Copy the **App ID**.
2. Click **Generate a private key** → downloads a `.pem`.
3. Set a **Webhook secret** (any random string) and save.

<details><summary>Prefer manual registration? Use this manifest</summary>

GitHub → Settings → Developer settings → GitHub Apps → New, and match:

```json
{
  "name": "leerness-gate",
  "hook_attributes": { "url": "https://leerness-gate.YOUR-SUBDOMAIN.workers.dev", "active": true },
  "public": false,
  "default_permissions": { "checks": "write", "pull_requests": "read", "contents": "read" },
  "default_events": ["pull_request"]
}
```
</details>

## 3. Set the Worker secrets (never committed)

The two single-line values can be pasted at the interactive prompt:

```bash
npx wrangler secret put GITHUB_WEBHOOK_SECRET     # the webhook secret from step 2
npx wrangler secret put GITHUB_APP_ID             # the App ID from step 2
```

The private key is **multi-line**. Pasting it into the interactive prompt silently truncates it on Windows (the App JWT then fails with an `atob` / `Invalid keyData` error). Save the downloaded `.pem` to a file and **pipe it in** instead:

```powershell
# PowerShell (Windows) — < redirection is not supported, use the pipe
Get-Content -Raw key.pem | npx wrangler secret put GITHUB_APP_PRIVATE_KEY
```

```bash
# bash / macOS / Linux
npx wrangler secret put GITHUB_APP_PRIVATE_KEY < key.pem
```

```bash
npm run deploy                                     # redeploy so the Worker picks up the secrets
```

## 4. Install + verify

1. On the App page → **Install App** → choose a repo.
2. Open a PR in that repo. A **leerness gate** check appears within seconds.
3. (Recommended) In the repo's branch protection, mark `leerness gate` as a **required** status check — now a PR whose claims fail cannot merge.

Try a failing case: open a PR whose description claims a file it does not change, or has no test evidence — the check goes red.

## Troubleshooting

- **No check appears**: confirm the webhook URL matches the deployed Worker, and that step 3 secrets are set (`npx wrangler secret list`). Check `npx wrangler tail` for live logs.
- **401 invalid signature**: the `GITHUB_WEBHOOK_SECRET` does not match the App's webhook secret.
- **`atob` / `Invalid keyData` in `wrangler tail`**: the `GITHUB_APP_PRIVATE_KEY` secret is truncated or malformed — re-set it with the pipe method in step 3 (do not paste a multi-line key at the interactive prompt). The parser accepts both PKCS#1 (`BEGIN RSA PRIVATE KEY`, GitHub's default) and PKCS#8.
- **Want to preview without deploying?** `npx leerness-gate <owner/repo> <pr>` runs the same verdict locally via your `gh` auth (see README).
