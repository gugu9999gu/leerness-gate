# leerness Gate

A GitHub App (Cloudflare Worker) that verifies completion claims on pull requests — **"done" must match reality** — as a hosted check run. Built for the era of AI-authored PRs.

When a PR is opened or updated, leerness Gate posts a `leerness gate` check that **fails** when the description's claims don't match the diff:

- **no-evidence** — no verification evidence (no test output, no Evidence/Verification section, no "tested/verified" note).
- **claim-not-in-diff** — the description claims a file the PR never changes (a classic false-done signal).
- **stub-impl** — a claimed implementation file adds only comments/blank lines.
- **test-count-inflated** *(warn)* — the description claims N tests but the diff adds fewer.

It is the hosted form of [leerness](https://www.npmjs.com/package/leerness)'s `verify-claim` — no CI YAML, just install the App. Zero dependencies, runs on Web Crypto.

## Try it now (no deploy)

Preview the verdict on **any PR** with your existing `gh` CLI auth — no GitHub App, no Cloudflare account. From a clone of this repo:

```bash
node bin/cli.js <owner/repo> <pr-number>
```

It fetches the PR via `gh`, runs the **same** core the hosted gate uses, prints a report, and **exits non-zero on failure** (usable as a local pre-push check). Real output:

```
# leerness gate preview — owner/repo #42
FAIL — leerness gate: 2 issue(s) found

Findings:
- [fail] no-evidence: No verification evidence in the PR description ...
  fix: Add an Evidence/Verification section with your test command and its output.
- [fail] claim-not-in-diff: Claimed file(s) absent from the PR diff: payment.js
  fix: Reference only files this PR actually changes, or include the missing file(s).
```

Every finding carries a `fix:` line so the author knows exactly how to turn the check green.

## How a verdict is decided

| Rule | Severity | Fires when |
|---|---|---|
| `no-files` | fail | the PR changes nothing |
| `no-evidence` | fail\* | no test output / Evidence section / "tested·verified·확인" note in the description |
| `claim-not-in-diff` | fail | the description names a file (`path/x.js`) absent from the diff |
| `stub-impl` | fail | a claimed code file adds only comments/blank lines |
| `test-count-inflated` | warn | declared test count > test cases actually added |

\* configurable to a non-blocking warning (see Configuration).

- **Draft PRs** are advisory: failures post as a **neutral** check, not a blocking one — work in progress isn't punished.
- **Evidence** is recognized from test output (`42 passing`, `npm test`, `pytest`, ✅), an `## Evidence` / `## Verification` / `## 검증` section with content, or an informal note (`tested locally`, `확인했음`). Empty or "not run" sections don't count.

## Configuration (optional)

Drop a `.leerness-gate.json` in the repo's **default branch** (read from the base branch, so a PR can't weaken its own gate):

```json
{
  "enabled": true,
  "requireEvidence": true,
  "ignorePaths": ["generated/", "vendor/"]
}
```

- `enabled: false` — the gate posts a neutral "disabled" check.
- `requireEvidence: false` — missing evidence becomes a non-blocking warning.
- `ignorePaths` — claimed paths under these prefixes aren't required to be in the diff.

## Deploy (your GitHub + Cloudflare accounts)

The turnkey path is in **[DEPLOY.md](DEPLOY.md)** (~10 min):

1. `npx wrangler login` → `npm run deploy` (note the Worker URL).
2. Open **[deploy/register.html](deploy/register.html)**, paste the Worker URL, click **Create leerness Gate App** — GitHub opens pre-filled with the right permissions/events. After creation GitHub redirects to the Worker's `/setup` page, which shows your App ID, webhook secret, private key, and the exact secret commands.
3. Set the three secrets. The private key is multi-line — **pipe it from a file** (pasting into the interactive prompt truncates it on Windows):
   ```bash
   # PowerShell
   Get-Content -Raw key.pem | npx wrangler secret put GITHUB_APP_PRIVATE_KEY
   # bash / macOS / Linux
   npx wrangler secret put GITHUB_APP_PRIVATE_KEY < key.pem
   ```
4. `npm run deploy`, then **Install the App** on a repo. Mark `leerness gate` a **required** check in branch protection to enforce it.

## What's built

| File | Role |
|---|---|
| `src/gate-check.js` | verification core: evidence + claim↔diff + stub + count, config-aware, Korean-aware, pure |
| `src/github.js` | GitHub App client: JWT (RS256, PKCS#1/#8) → installation token → PR files + check run + repo config |
| `src/verify-signature.js` | webhook HMAC-SHA256 verification (Web Crypto, timing-safe) |
| `src/index.js` | Worker entry: webhook → verify → route → check run; `/setup` registration callback |
| `bin/cli.js` | local CLI preview via `gh` (no deploy) |

```bash
npm test    # 77 unit tests, zero dependencies, no credentials needed
```

## Built with leerness (dogfood)

Developed using leerness itself as the harness — tasks, evidence-gated `verify-claim`, secret scanning, and the `gate`. The tool that verifies completion claims is built under its own verification.

MIT License.

---

<!-- leerness:project-readme:start -->
## Leerness Project Harness

이 프로젝트는 Leerness v1.34.1 하네스를 사용합니다. AI 에이전트는 작업 전 `leerness handoff`로 컨텍스트를 적재하고, 작업 후 `leerness check`/`leerness audit`/`leerness session close`를 수행해야 합니다.

### 정체성 — AI 에이전트 운영 레이어 (UR-0030)

Leerness 는 **실행기/코딩 에이전트가 아니라**, 어떤 AI 코딩 에이전트(Claude Code · Codex · Cursor · Goose 등) 위에도 얹는 **범용 운영 레이어**입니다. 5개 공통 계층을 제공합니다:

- **기억(Memory)** — 프로젝트 상태/결정/진행을 `.harness/` 에 영속화
- **정책(Policy)** — 8단계 권한 등급 + enforce (read-only→publish), MCP 호출 게이트
- **인수인계(Handoff)** — 에이전트 간 컨텍스트 표준 전달 + `get_project_context` 1콜 온보딩
- **검증(Verification)** — 근거 기반 완료 검증으로 허위 완료 차단
- **감사(Audit)** — drift/idempotency/secret/encoding 자동 감사 + self-heal

AGENTS.md(정적 지침)을 **대체하지 않고 보완**합니다 — 정적 규칙은 AGENTS.md, 동적 상태·검증·인수인계는 leerness. 정체성 조회: `leerness about` (MCP `leerness_about`).

### Core Commands

```bash
leerness handoff .            # 세션 시작 컨텍스트 자동 로드
leerness status .             # 설치 상태
leerness verify .             # 필수 파일 검증
leerness audit .              # 일관성·계획-진행 정렬 감사
leerness scan secrets .       # 시크릿 패턴 스캔
leerness encoding check .     # UTF-8 / BOM / NUL / .bat 인코딩 검사
leerness lazy detect .        # 게으름 방지 자동 평가
leerness memory search "키"   # 결정/이력 검색
leerness session close .      # 세션 종료 + handoff 자동 작성
leerness update .             # 자동 버전 감지 + 마이그레이션
```

### Memory Surface CRUD (5 surfaces × add/list/drop)

```bash
# Tasks
leerness task add "T-9999 작업 제목"
leerness task list --json
# Decisions
leerness decision add "결정 제목" --reason "이유"
leerness decision list --query "키워드"   # 1.9.139
# Rules (영구 자연어 룰)
leerness rule add "매 commit마다 changelog 갱신" --trigger every-commit
leerness rule list
# Plan (milestones)
leerness plan add "M-XXXX 계획" --next-action "다음 단계"
leerness plan list
# Lessons (영구 교훈)
leerness lesson save "교훈 본문" --tag perf
leerness lesson list --query "키워드"     # 1.9.139
# DELETE → RESTORE (1.9.126~128)
leerness memory archive list . --query "키워드"   # 1.9.138
leerness memory restore decision <date|title>
```

### MCP server (외부 AI 통합)

Leerness v1.34.1는 stdio JSON-RPC MCP server를 내장합니다 — Claude Code · Cursor · Codex CLI 등 외부 AI에 **86개 도구**를 노출:

```jsonc
// 카테고리별
// • Core: handoff / drift_check / audit / health / verify_claim / contract_verify
// • Memory READ:  task_list / decision_list / lesson_list / plan_list / rule_list / memory_status
// • Memory WRITE: task_add / decision_add / lesson_save / plan_add / rule_add
// • Memory DELETE: task_drop / decision_drop / lesson_drop / plan_remove / rule_remove
// • Skill: skill_match / skill_list / skill_search / skill_info / skill_suggest
// • Insight: lessons / lessons_auto / brainstorm / retro / benchmark / lazy_detect
// • Workflow: session_close / agents_list / task_export / env_check / usage_stats / reuse_map / whats_new

// MCP server 실행: leerness mcp serve
// tools/list 응답: 86 도구
```

### Autonomous mode (자율 모드)

`<<autonomous-loop-dynamic>>` 신호만 보내면 AI가:
1) 다음 라운드 후보 선정 → 2) 코드 변경 → 3) stress-v* 신규 작성 + 누적 회귀 → 4) e2e 219/219 → 5) npm pack + git tag + GitHub release → 6) main 자동 push (1.9.140+) → 7) session close → 8) 다음 라운드 예약.

현재 누적: **70 라운드 (1.9.40 → 1.34.1)** · 매 라운드 GitHub release/태그 생성 · _reports/는 비공개 보존.

### 성능 가이드 (1.9.140 측정)

- `leerness handoff .` — 평균 ~1.5s (캐시 워밍업 후 ~0.6s)
- `leerness memory status --json` — 평균 ~250ms
- `leerness task list --json` — 평균 ~200ms
- `leerness drift check --json` — 평균 ~400ms
- MCP `tools/list` 응답 — 평균 ~150ms
- usage-stats / lessons / listAllSkills 모두 메모리 캐싱 (1.9.65/66)

### 빠른 시작

```bash
# 1. 설치 (글로벌)
npm install -g leerness

# 2. 프로젝트에 하네스 설치
cd my-project && leerness init . --yes --skills recommended

# 3. AI 세션 시작 시
leerness handoff .            # 컨텍스트 자동 로드

# 4. 세션 종료 시
leerness session close .      # 9 카테고리 + 룰 검증 + 다음 라운드 추천

# 5. release 자동화 (1.9.140 main 자동 push 포함)
leerness release pack --close --auto-main-push
```

### Planning Files

- `.harness/plan.md`: 전체 목표, milestone, 제외/드랍 범위
- `.harness/progress-tracker.md`: 요청 단위 상태와 증거
- `.harness/current-state.md`: 지금 이어서 할 작업
- `.harness/session-handoff.md`: 다음 세션 인수인계 (자동 작성)
- `.harness/lessons.md` / `decisions.md` / `rules.md`: 영구 메모리 (5 surface)

Last synced by Leerness v1.34.1: 2026-06-20
<!-- leerness:project-readme:end -->
