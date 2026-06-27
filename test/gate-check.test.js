import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePr, extractClaimedFiles } from '../src/gate-check.js';

test('truthful PR (evidence + claimed files in diff) -> success', () => {
  const r = evaluatePr({
    title: 'Implement payment API',
    body: 'Implemented payment.js and tests/payment.test.js. Tests: 5 passed.',
    files: [{ filename: 'payment.js', status: 'added' }, { filename: 'tests/payment.test.js', status: 'added' }],
  });
  assert.equal(r.conclusion, 'success');
  assert.equal(r.findings.length, 0);
});

test('false done: claimed file NOT in diff -> failure (claim-not-in-diff)', () => {
  const r = evaluatePr({
    title: 'Implement payment API',
    body: 'Implemented payment.js, all tests passing (3/3 passed).',
    files: [{ filename: 'README.md', status: 'modified' }],
  });
  assert.equal(r.conclusion, 'failure');
  assert.ok(r.findings.some((f) => f.rule === 'claim-not-in-diff'));
  assert.ok(r.findings.find((f) => f.rule === 'claim-not-in-diff').files.includes('payment.js'));
});

// 18th hunt (false-fail fix): test files referenced as evidence (not changed) must not trip claim-not-in-diff.
test('evidence-only test files (not in diff) do not trip claim-not-in-diff -> success', () => {
  const r = evaluatePr({
    title: 'Refactor utils module',
    body: 'Refactored src/utils.js.\n\n## Verification\nRan full test suite:\n- utils.test.js: 8 tests passed\n- auth.test.js: 12 tests passed\nTotal: 20 tests passing',
    files: [{ filename: 'src/utils.js', status: 'modified', patch: '+const cached = {};' }],
  });
  assert.equal(r.conclusion, 'success', 'test files cited as evidence must not be treated as claimed-not-in-diff');
  assert.equal(r.findings.length, 0);
});

// no-FN-regression: a non-test claimed file absent from the diff is still flagged.
test('non-test claimed file absent from diff still fails (no FN from the test-path exclusion)', () => {
  const r = evaluatePr({
    title: 'Add payment',
    body: 'Implemented src/payment.js. Tests: 5 passed.',
    files: [{ filename: 'README.md', status: 'modified' }],
  });
  assert.equal(r.conclusion, 'failure');
  assert.ok(r.findings.some((f) => f.rule === 'claim-not-in-diff'));
});

test('no verification evidence -> failure (no-evidence)', () => {
  const r = evaluatePr({
    title: 'add stuff',
    body: 'did the thing',
    files: [{ filename: 'a.js', status: 'modified' }],
  });
  assert.equal(r.conclusion, 'failure');
  assert.ok(r.findings.some((f) => f.rule === 'no-evidence'));
});

test('empty PR (no files) -> failure (no-files)', () => {
  const r = evaluatePr({ title: 't', body: 'npm test passed', files: [] });
  assert.equal(r.conclusion, 'failure');
  assert.ok(r.findings.some((f) => f.rule === 'no-files'));
});

test('evidence via explicit Verification section header -> evidence ok', () => {
  const r = evaluatePr({
    title: 'feat: x',
    body: 'Changed src/x.js.\n\n## Verification\n- ran the suite locally',
    files: [{ filename: 'src/x.js', status: 'modified' }],
  });
  assert.equal(r.conclusion, 'success');
});

test('evidence via Korean test signal + Korean section -> ok', () => {
  const r = evaluatePr({
    title: '결제 구현',
    body: 'src/pay.js 구현.\n\n## 검증\n테스트 12개 통과',
    files: [{ filename: 'src/pay.js', status: 'added' }],
  });
  assert.equal(r.conclusion, 'success');
});

test('loose path match: body claims pay.js, diff has src/pay.js (basename) -> ok', () => {
  const r = evaluatePr({
    title: 'x',
    body: 'implemented pay.js, jest green',
    files: [{ filename: 'src/pay.js', status: 'added' }],
  });
  assert.equal(r.conclusion, 'success');
});

test('extractClaimedFiles dedups and matches whitelisted extensions only', () => {
  const got = extractClaimedFiles('changed a.js, a.js again, b.ts, notafile.zzz, dir/c.py');
  assert.deepEqual(got.sort(), ['a.js', 'b.ts', 'dir/c.py'].sort());
});

test('summary is markdown and mentions leerness', () => {
  const r = evaluatePr({ title: 't', body: 'npm test', files: [{ filename: 'a.js' }] });
  assert.match(r.summary, /leerness/);
  assert.match(r.summary, /changed files: 1/);
});
