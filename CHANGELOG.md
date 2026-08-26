# Changelog

All notable changes to leerness Gate.

## 0.0.3 - 2026-08-26

### Fixed
- The installed-package concurrency probe now isolates its handoff children from GitHub Actions' intentional session-presence suppression, so CI measures per-session records instead of inheriting `CI`/`GITHUB_ACTIONS` runner markers.
- Failed handoff-isolation probes include the observed session records, making missing or conflicting session files diagnosable without reproducing the runner locally.

## 0.0.2 - 2026-08-26

### Added
- Token-backed GitHub REST mode for the local CLI (`GITHUB_TOKEN` / `GH_TOKEN`), including paginated PR files and base-branch configuration.
- Successful `--help` and `--version` CLI surfaces.
- Wrangler 4 deployment validation/startup scripts and a current Workers compatibility date.
- A packed-artifact cleanroom that installs `leerness` and `leerness-gate` together, exercises both CLIs and the Gate core, checks concurrent handoff isolation, and audits runtime dependencies.

### Fixed
- Dot-prefixed paths such as `.leerness/current-state.md`, legacy workspace paths, and `.leerness-gate.json` retain their leading dot during claim-to-diff matching.
- Neutral/disabled verdicts render as `NEUTRAL` instead of `FAIL`.
- Package repository, homepage, and issue metadata now point to the canonical GitHub repository.
- Wrangler's vulnerable v3 transitive dependency chain is replaced by the current v4 line; source deployment now requires Node.js 22+ while the published CLI remains Node.js 18+ compatible.
- Repository slugs are validated and URL-encoded before GitHub API access, preventing query/path injection through CLI arguments.

## 0.0.1 - 2026-08-24

### Added
- Repo-level config `.leerness-gate.json` (`enabled` / `requireEvidence` / `ignorePaths`), read from the **base** branch so a PR cannot weaken its own gate.
- Draft PRs receive a non-blocking **neutral** "advisory" verdict instead of a failure.
- Every finding now carries an actionable `fix:` remediation line.
- `SECURITY.md` responsible-disclosure policy.
- CI workflow (`node --test`) and a zero-runtime-dependency test suite.
- Local CLI honors `.leerness-gate.json`, matching the hosted gate.

### Fixed
- GitHub App **PKCS#1** private keys are wrapped to PKCS#8 for Web Crypto; PEM parsing tolerates padding and literal `\n` (mangled secrets).
- Verdict core hardened: input length caps (regex DoS), directory-aware claim matching, leading-digit filenames, evidence sections require real content, `ignorePaths` matches on path boundaries.
- Verdict core false-fail fix: test files cited only as **evidence** in the PR body (e.g. "utils.test.js: 8 passed") no longer count as claimed-changed files, so a legitimate refactor PR whose verification section lists existing tests is not wrongly blocked. Non-test claimed files absent from the diff are still flagged (no new bypass). (18th bug hunt; reproduced before/after via `evaluatePr`.)
- Portable test discovery (works on Node 18+).
- CLI silences the expected `404` when a repo has no config file.
