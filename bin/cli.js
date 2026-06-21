#!/usr/bin/env node
// leerness-gate CLI — 배포 없이 로컬에서 PR 게이트 판정 미리보기.
//   기존 `gh` 인증으로 실제 PR(title/body/files+patch)을 가져와 evaluatePr 로 검증, Worker 와 동일 코어 재사용.
//   사용: leerness-gate <owner/repo> <pr-number>   (또는 GITHUB_TOKEN 으로 REST 직접 — gh 미설치 시)
//   exit: 0 = pass, 1 = fail (로컬 pre-push 체크로 사용 가능).

import { execFileSync } from 'node:child_process';
import { evaluatePr } from '../src/gate-check.js';

// gh CLI 로 PR 데이터 조회 (사용자 기존 인증 재사용, 새 App/토큰 불필요).
function fetchPrViaGh(repo, num) {
  const pr = JSON.parse(execFileSync('gh', ['api', 'repos/' + repo + '/pulls/' + num], { encoding: 'utf8' }));
  const files = JSON.parse(execFileSync('gh', ['api', 'repos/' + repo + '/pulls/' + num + '/files', '--paginate'], { encoding: 'utf8' }));
  return {
    title: pr.title || '',
    body: pr.body || '',
    files: (Array.isArray(files) ? files : []).map((f) => ({ filename: f.filename, status: f.status, patch: f.patch })),
  };
}

function fetchRepoConfigViaGh(repo) {
  try {
    const repoInfo = JSON.parse(execFileSync('gh', ['api', 'repos/' + repo], { encoding: 'utf8' }));
    const defaultBranch = repoInfo && repoInfo.default_branch;
    if (!defaultBranch) return {};
    const body = JSON.parse(execFileSync('gh', ['api', 'repos/' + repo + '/contents/.leerness-gate.json?ref=' + encodeURIComponent(defaultBranch)], { encoding: 'utf8' }));
    if (!body || typeof body.content !== 'string') return {};
    const decoded = Buffer.from(body.content.replace(/\s/g, ''), 'base64').toString('utf8');
    const parsed = JSON.parse(decoded);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

// 순수 오케스트레이션 (fetchPr/fetchConfig 주입 가능 -> 테스트는 gh 없이 mock).
export async function runGate(repo, prNumber, deps = {}) {
  const usingDefaultFetchPr = !deps.fetchPr;
  const fetchPr = deps.fetchPr || fetchPrViaGh;
  const fetchConfig = deps.fetchConfig || (usingDefaultFetchPr ? fetchRepoConfigViaGh : async () => ({}));
  const pr = await fetchPr(repo, prNumber);
  const config = await fetchConfig(repo);
  return evaluatePr(pr, config);
}

// 콘솔 렌더 (verdict.summary 는 markdown — 그대로 출력).
export function renderVerdict(verdict, repo, prNumber) {
  const lines = [];
  lines.push('# leerness gate preview — ' + repo + ' #' + prNumber);
  lines.push((verdict.conclusion === 'success' ? 'PASS' : 'FAIL') + ' — ' + verdict.title);
  lines.push('');
  lines.push(verdict.summary);
  return lines.join('\n');
}

export function parseArgs(argv) {
  const a = argv.filter((x) => !x.startsWith('-'));
  return { repo: a[0], prNumber: a[1] };
}

async function main() {
  const { repo, prNumber } = parseArgs(process.argv.slice(2));
  if (!repo || !prNumber || !/^[^/]+\/[^/]+$/.test(repo) || !/^\d+$/.test(prNumber)) {
    console.error('usage: leerness-gate <owner/repo> <pr-number>');
    process.exit(2);
  }
  let verdict;
  try {
    verdict = await runGate(repo, prNumber);
  } catch (e) {
    console.error('leerness-gate error: ' + (e && e.message) + '\n(requires the `gh` CLI, authenticated with repo access)');
    process.exit(2);
  }
  console.log(renderVerdict(verdict, repo, prNumber));
  process.exit(verdict.conclusion === 'failure' ? 1 : 0);
}

// CLI 직접 실행 시에만 main (import 시엔 테스트 가능 — require.main 가드 패턴, ESM).
if (import.meta.url === ('file://' + process.argv[1]) || (process.argv[1] && process.argv[1].endsWith('cli.js'))) {
  main();
}
