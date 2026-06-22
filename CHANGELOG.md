# Changelog

All notable changes to leerness Gate. This project is early; versions are not yet published to npm.

## Unreleased

### Added
- Repo-level config `.leerness-gate.json` (`enabled` / `requireEvidence` / `ignorePaths`), read from the **base** branch so a PR cannot weaken its own gate.
- Draft PRs receive a non-blocking **neutral** "advisory" verdict instead of a failure.
- Every finding now carries an actionable `fix:` remediation line.
- `SECURITY.md` responsible-disclosure policy.
- CI workflow (`node --test`) and a zero-dependency test suite (80 tests).
- Local CLI honors `.leerness-gate.json`, matching the hosted gate.

### Fixed
- GitHub App **PKCS#1** private keys are wrapped to PKCS#8 for Web Crypto; PEM parsing tolerates padding and literal `\n` (mangled secrets).
- Verdict core hardened: input length caps (regex DoS), directory-aware claim matching, leading-digit filenames, evidence sections require real content, `ignorePaths` matches on path boundaries.
- Portable test discovery (works on Node 18+).
- CLI silences the expected `404` when a repo has no config file.
