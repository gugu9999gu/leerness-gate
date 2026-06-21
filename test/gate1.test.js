import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePr, addedLines, declaredTestCount, hasRealCode } from '../src/gate-check.js';

test('addedLines extracts + lines, skips +++ header', () => {
  const patch = '@@ -0,0 +1,2 @@\n+function f(){}\n+// note\n-removed\n+++ b/x.js';
  assert.deepEqual(addedLines(patch), ['function f(){}', '// note']);
  assert.deepEqual(addedLines(null), []);
});

test('declaredTestCount parses en/ko forms', () => {
  assert.equal(declaredTestCount('5 tests passed'), 5);
  assert.equal(declaredTestCount('3/3 passing'), 3);
  assert.equal(declaredTestCount('테스트 12개 통과'), 12);
  assert.equal(declaredTestCount('12개 테스트'), 12);
  assert.equal(declaredTestCount('no number here'), null);
});

test('hasRealCode: comment-only -> false, real code -> true', () => {
  assert.equal(hasRealCode(['// TODO', '#  later', '   ']), false);
  assert.equal(hasRealCode(['/* block', 'still comment', '*/']), false);
  assert.equal(hasRealCode(['/* c */ const x = 1;']), true);
  assert.equal(hasRealCode(['function f(){ return 1; }']), true);
});

test('R4 stub-impl: claimed impl file adds only comments -> failure', () => {
  const r = evaluatePr({
    title: 'feat',
    body: 'implemented payment.js, npm test passed',
    files: [{ filename: 'payment.js', status: 'added', patch: '@@ -0,0 +1,2 @@\n+// TODO: implement payment\n+// later' }],
  });
  assert.equal(r.conclusion, 'failure');
  assert.ok(r.findings.some((f) => f.rule === 'stub-impl'));
});

test('R4 not triggered when claimed impl file has real code added', () => {
  const r = evaluatePr({
    title: 'feat',
    body: 'implemented payment.js, npm test passed',
    files: [{ filename: 'payment.js', status: 'added', patch: '@@ -0,0 +1,2 @@\n+export function pay(){ return 1; }\n+// done' }],
  });
  assert.equal(r.conclusion, 'success');
  assert.ok(!r.findings.some((f) => f.rule === 'stub-impl'));
});

test('R4 only applies to CLAIMED files (unclaimed comment file is fine)', () => {
  const r = evaluatePr({
    title: 'docs',
    body: 'updated notes; npm test passed',
    files: [{ filename: 'NOTES.md', status: 'modified', patch: '@@ +1 @@\n+# just notes' }, { filename: 'real.js', status: 'added', patch: '@@ +1 @@\n+const x = 1;' }],
  });
  assert.ok(!r.findings.some((f) => f.rule === 'stub-impl'));
});

test('R3 inflated test count -> warn (does NOT fail the gate by itself)', () => {
  const r = evaluatePr({
    title: 'feat',
    body: 'implemented calc.js, 10 tests passed.',
    files: [
      { filename: 'calc.js', status: 'added', patch: '@@ +1,2 @@\n+export function add(a,b){return a+b;}' },
      { filename: 'tests/calc.test.js', status: 'added', patch: '@@ +1,2 @@\n+test("add", () => {});' },
    ],
  });
  // claimed file in diff + evidence present + real code -> no hard fail; inflated is a warn
  assert.equal(r.conclusion, 'success');
  assert.ok(r.findings.some((f) => f.rule === 'test-count-inflated' && f.severity === 'warn'));
});

test('R3 not flagged when added test count meets claim', () => {
  const r = evaluatePr({
    title: 'feat',
    body: 'calc.js, 1 test passed',
    files: [
      { filename: 'calc.js', status: 'added', patch: '@@ +1 @@\n+export const add = (a,b)=>a+b;' },
      { filename: 'tests/calc.test.js', status: 'added', patch: '@@ +1 @@\n+test("add", () => {});' },
    ],
  });
  assert.ok(!r.findings.some((f) => f.rule === 'test-count-inflated'));
});
