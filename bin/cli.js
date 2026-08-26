#!/usr/bin/env node
// leerness-gate CLI — 배포 없이 로컬에서 PR 게이트 판정 미리보기.
//   기존 `gh` 인증으로 실제 PR(title/body/files+patch)을 가져와 evaluatePr 로 검증, Worker 와 동일 코어 재사용.
//   사용: leerness-gate <owner/repo> <pr-number>   (또는 GITHUB_TOKEN 으로 REST 직접 — gh 미설치 시)
//   exit: 0 = pass, 1 = fail (로컬 pre-push 체크로 사용 가능).

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluatePr } from '../src/gate-check.js';

export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const USAGE = 'usage: leerness-gate <owner/repo> <pr-number>';

export function isValidRepoSlug(repo) {
  if (typeof repo !== 'string') return false;
  const parts = repo.split('/');
  if (parts.length !== 2) return false;
  const [owner, name] = parts;
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)
    && /^[A-Za-z0-9._-]+$/.test(name)
    && name !== '.' && name !== '..';
}

function apiRepoPath(repo) {
  if (!isValidRepoSlug(repo)) throw new Error('invalid GitHub repository slug');
  return repo.split('/').map(encodeURIComponent).join('/');
}

function apiPrNumber(num) {
  const value = String(num || '');
  if (!/^\d+$/.test(value)) throw new Error('invalid GitHub pull request number');
  return value;
}

// gh CLI 로 PR 데이터 조회 (사용자 기존 인증 재사용, 새 App/토큰 불필요).
export function fetchPrViaGh(repo, num, execImpl = execFileSync) {
  const safeRepo = apiRepoPath(repo);
  const safeNumber = apiPrNumber(num);
  const pr = JSON.parse(execImpl('gh', ['api', 'repos/' + safeRepo + '/pulls/' + safeNumber], { encoding: 'utf8' }));
  // `gh api --paginate` writes one JSON array per page; concatenated arrays are
  // not valid JSON. `--slurp` wraps the pages so they can be parsed and flattened.
  const pages = JSON.parse(execImpl('gh', [
    'api', 'repos/' + safeRepo + '/pulls/' + safeNumber + '/files', '--paginate', '--slurp',
  ], { encoding: 'utf8' }));
  const files = Array.isArray(pages) && pages.every(Array.isArray) ? pages.flat() : pages;
  return {
    title: pr.title || '',
    body: pr.body || '',
    files: (Array.isArray(files) ? files : []).map((f) => ({ filename: f.filename, status: f.status, patch: f.patch })),
  };
}

function fetchRepoConfigViaGh(repo) {
  try {
    // stderr 무시: config 파일 부재(흔한 케이스)는 gh 가 404 를 stderr 로 내는데, 여기선 정상(설정 없음)이라 노이즈만 됨. fail-soft 로 {} 반환.
    const ghOpts = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
    const safeRepo = apiRepoPath(repo);
    const repoInfo = JSON.parse(execFileSync('gh', ['api', 'repos/' + safeRepo], ghOpts));
    const defaultBranch = repoInfo && repoInfo.default_branch;
    if (!defaultBranch) return {};
    const body = JSON.parse(execFileSync('gh', ['api', 'repos/' + safeRepo + '/contents/.leerness-gate.json?ref=' + encodeURIComponent(defaultBranch)], ghOpts));
    if (!body || typeof body.content !== 'string') return {};
    const decoded = Buffer.from(body.content.replace(/\s/g, ''), 'base64').toString('utf8');
    const parsed = JSON.parse(decoded);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

function restHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: 'Bearer ' + token,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'leerness-gate/' + VERSION,
  };
}

async function restJson(url, token, fetchImpl) {
  const response = await fetchImpl(url, { headers: restHeaders(token) });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error('GitHub REST ' + response.status + ' for ' + url + (detail ? ': ' + detail.slice(0, 200) : ''));
  }
  return response.json();
}

// gh가 없는 CI/클린룸에서도 토큰만으로 동일 데이터를 읽는다.
export async function fetchPrViaRest(repo, num, token, fetchImpl = globalThis.fetch) {
  if (!token) throw new Error('GITHUB_TOKEN (or GH_TOKEN) is required for REST mode');
  if (typeof fetchImpl !== 'function') throw new Error('global fetch is unavailable (Node.js 18+ required)');
  const base = 'https://api.github.com/repos/' + apiRepoPath(repo);
  const safeNumber = apiPrNumber(num);
  const pr = await restJson(base + '/pulls/' + safeNumber, token, fetchImpl);
  const files = [];
  for (let page = 1; page <= 30; page += 1) {
    const batch = await restJson(base + '/pulls/' + safeNumber + '/files?per_page=100&page=' + page, token, fetchImpl);
    if (!Array.isArray(batch)) throw new Error('GitHub REST files response is not an array');
    files.push(...batch);
    if (batch.length < 100) break;
  }
  return {
    title: pr.title || '',
    body: pr.body || '',
    files: files.map((f) => ({ filename: f.filename, status: f.status, patch: f.patch })),
  };
}

export async function fetchRepoConfigViaRest(repo, token, fetchImpl = globalThis.fetch) {
  if (!token) return {};
  try {
    const base = 'https://api.github.com/repos/' + apiRepoPath(repo);
    const repoInfo = await restJson(base, token, fetchImpl);
    if (!repoInfo || !repoInfo.default_branch) return {};
    const url = base + '/contents/.leerness-gate.json?ref=' + encodeURIComponent(repoInfo.default_branch);
    const body = await restJson(url, token, fetchImpl);
    if (!body || typeof body.content !== 'string') return {};
    const parsed = JSON.parse(Buffer.from(body.content.replace(/\s/g, ''), 'base64').toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // 설정 파일 404와 잘못된 설정 모두 기존 gh 경로처럼 fail-soft 처리한다.
    return {};
  }
}

// 순수 오케스트레이션 (fetchPr/fetchConfig 주입 가능 -> 테스트는 gh 없이 mock).
export async function runGate(repo, prNumber, deps = {}) {
  const usingDefaultFetchPr = !deps.fetchPr;
  const token = deps.token !== undefined ? deps.token : (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '');
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const useRest = usingDefaultFetchPr && Boolean(token);
  const fetchPr = deps.fetchPr || (useRest
    ? (r, n) => fetchPrViaRest(r, n, token, fetchImpl)
    : fetchPrViaGh);
  const fetchConfig = deps.fetchConfig || (usingDefaultFetchPr
    ? (useRest
      ? (r) => fetchRepoConfigViaRest(r, token, fetchImpl)
      : fetchRepoConfigViaGh)
    : async () => ({}));
  const pr = await fetchPr(repo, prNumber);
  const config = await fetchConfig(repo);
  return evaluatePr(pr, config);
}

// 콘솔 렌더 (verdict.summary 는 markdown — 그대로 출력).
export function renderVerdict(verdict, repo, prNumber) {
  const lines = [];
  lines.push('# leerness gate preview — ' + repo + ' #' + prNumber);
  const label = verdict.conclusion === 'success' ? 'PASS' : verdict.conclusion === 'failure' ? 'FAIL' : 'NEUTRAL';
  lines.push(label + ' — ' + verdict.title);
  lines.push('');
  lines.push(verdict.summary);
  return lines.join('\n');
}

export function parseArgs(argv) {
  const a = argv.filter((x) => !x.startsWith('-'));
  return { repo: a[0], prNumber: a[1] };
}

export async function main(argv = process.argv.slice(2), io = console) {
  if (argv.includes('--help') || argv.includes('-h')) {
    io.log(USAGE + '\n\nOptions:\n  -h, --help       Show help\n  -v, --version    Show version');
    return 0;
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    io.log(VERSION);
    return 0;
  }
  const { repo, prNumber } = parseArgs(argv);
  if (!repo || !prNumber || !isValidRepoSlug(repo) || !/^\d+$/.test(prNumber)) {
    io.error(USAGE);
    return 2;
  }
  let verdict;
  try {
    verdict = await runGate(repo, prNumber);
  } catch (e) {
    io.error('leerness-gate error: ' + (e && e.message) + '\n(requires authenticated `gh`, or GITHUB_TOKEN/GH_TOKEN for REST mode)');
    return 2;
  }
  io.log(renderVerdict(verdict, repo, prNumber));
  return verdict.conclusion === 'failure' ? 1 : 0;
}

// CLI 직접 실행 시에만 main. npm's POSIX launcher is a symlink, so compare
// real paths; comparing import.meta.url with argv[1] made `npx leerness-gate`
// exit 0 without executing anything on Linux/macOS.
let invokedAsCli = false;
try {
  invokedAsCli = Boolean(process.argv[1])
    && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
} catch {
  invokedAsCli = false;
}
if (invokedAsCli) {
  process.exitCode = await main();
}
