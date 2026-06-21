import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePr, extractClaimedFiles } from '../src/gate-check.js';
import { setupResponse } from '../src/index.js';

const EV = '\n\n## Evidence\n42 tests passed (npm test).';
const ruleset = (r) => r.findings.map((f) => f.rule);

// FP-guard (제목 맥락): 제목이 파일을 "맥락"으로 언급해도(예: from legacy.js) 정직한 PR 을 막지 않음.
test('title context mention does NOT fail a legit PR (claims read from body only)', () => {
  const r = evaluatePr({ title: 'Port logic from legacy.js into a new module', body: 'Refactored cleanly.' + EV, files: [{ filename: 'src/parser-new.js', status: 'added', patch: '+export function p(){ return 1; }' }] });
  assert.equal(r.conclusion, 'success');
});

// FN2: 디렉토리 prefix 가 다른 basename 충돌은 매칭되면 안 됨.
test('FN2: src/auth.js claim is NOT satisfied by tests/auth.js', () => {
  const r = evaluatePr({ body: 'updated src/auth.js' + EV, files: [{ filename: 'tests/auth.js', status: 'added', patch: '+function f(){ return 1; }' }] });
  assert.equal(r.conclusion, 'failure');
  assert.ok(ruleset(r).includes('claim-not-in-diff'));
});
test('FN2 keeps bare-basename matching (auth.js claim matches src/auth.js)', () => {
  const r = evaluatePr({ body: 'updated auth.js' + EV, files: [{ filename: 'src/auth.js', status: 'modified', patch: '+function f(){ return 1; }' }] });
  assert.equal(r.conclusion, 'success');
});

// FN3: 빈/부정 증거 섹션은 증거 아님. 내용 있는 섹션 + 비공식 증거는 인정 (FP 방지).
test('FN3: empty evidence header does NOT count as evidence', () => {
  const r = evaluatePr({ body: 'Did stuff.\n\n## Evidence\n', files: [{ filename: 'README.md', status: 'modified' }] });
  assert.ok(ruleset(r).includes('no-evidence'));
});
test('FN3: "Not run" under the header does NOT count', () => {
  const r = evaluatePr({ body: 'Did stuff.\n\n## Verification\nNot run yet.', files: [{ filename: 'README.md', status: 'modified' }] });
  assert.ok(ruleset(r).includes('no-evidence'));
});
test('FN3: a real evidence section with content DOES count', () => {
  const r = evaluatePr({ body: 'Did stuff.\n\n## Evidence\nRan the suite locally and everything is green.', files: [{ filename: 'README.md', status: 'modified' }] });
  assert.ok(!ruleset(r).includes('no-evidence'));
});
test('FP-guard: informal evidence (Tested locally / 확인) counts (trivial/docs PRs)', () => {
  const a = evaluatePr({ body: 'Typo fix. Tested locally, works.', files: [{ filename: 'README.md', status: 'modified' }] });
  assert.ok(!ruleset(a).includes('no-evidence'));
  const b = evaluatePr({ body: '오타 수정. 로컬에서 직접 확인했고 잘 동작합니다.', files: [{ filename: 'docs/guide.md', status: 'modified' }] });
  assert.ok(!ruleset(b).includes('no-evidence'));
});

// FP-guard (확장자 없는 단어): 산문에 등장하는 Makefile/Gemfile 은 주장으로 오인하지 않음.
test('extensionless words in prose (Makefile) do NOT trigger claim-not-in-diff', () => {
  const r = evaluatePr({ body: 'The old Makefile approach was slow, so I moved to a JS build.' + EV, files: [{ filename: 'build.js', status: 'added', patch: '+console.log(1);' }] });
  assert.ok(!ruleset(r).includes('claim-not-in-diff'));
});

// FP5: 선행 숫자 파일명 (2fa.js) 절단되지 않음.
test('FP5: leading-digit filename extracted intact', () => {
  assert.deepEqual(extractClaimedFiles('added 2fa.js'), ['2fa.js']);
});
test('FP5: 2fa.js claimed and present -> no false claim-not-in-diff', () => {
  const r = evaluatePr({ body: 'added 2fa.js' + EV, files: [{ filename: '2fa.js', status: 'added', patch: '+export const x = 1;' }] });
  assert.equal(r.conclusion, 'success');
});

// SEC: ignorePaths 는 정확/디렉토리 prefix 만, substring 과탐 없음.
test('SEC: ignorePaths "." does NOT suppress everything', () => {
  const r = evaluatePr({ body: 'implemented missing.js' + EV, files: [{ filename: 'README.md', status: 'modified' }] }, { ignorePaths: ['.'] });
  assert.equal(r.conclusion, 'failure');
});
test('SEC: ignorePaths "generated/" suppresses a generated/ claim (legit)', () => {
  const r = evaluatePr({ body: 'implemented generated/api.js' + EV, files: [{ filename: 'README.md', status: 'modified' }] }, { ignorePaths: ['generated/'] });
  assert.equal(r.conclusion, 'success');
});

// DoS: 길이 캡 -> 16384 바이트 뒤 내용 미분석(캡 증명) + 거대 입력 빠른 반환.
test('DoS: body is capped (content beyond 16384 not analyzed)', () => {
  const body = 'x'.repeat(20000) + '\n## Evidence\n42 tests passed';
  const r = evaluatePr({ body, files: [{ filename: 'README.md', status: 'modified' }] });
  assert.ok(ruleset(r).includes('no-evidence')); // 증거가 캡 뒤라 안 보임 = 캡 적용됨
});
test('DoS: huge body returns promptly (no superlinear hang)', () => {
  const start = process.hrtime.bigint();
  evaluatePr({ body: 'x'.repeat(200000), files: [{ filename: 'README.md', status: 'modified' }] });
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(ms < 1500, 'took ' + ms.toFixed(0) + 'ms');
});

// SEC2: /setup 의 install 링크는 https 만 허용 (javascript: 등 스킴 차단).
test('SEC2: setup page rejects non-https html_url in the install link', async () => {
  const app = { id: 1, name: 'x', webhook_secret: 's', pem: 'p', html_url: 'javascript:alert(document.cookie)' };
  const res = await setupResponse('code', { exchangeManifestCode: async () => app });
  const html = await res.text();
  assert.ok(!html.includes('javascript:alert'));
  assert.ok(html.includes('https://github.com/settings/installations'));
});
