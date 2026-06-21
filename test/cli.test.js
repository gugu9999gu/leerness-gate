import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGate, renderVerdict, parseArgs } from '../bin/cli.js';

const PASS_PR = {
  title: 'feat: calc',
  body: 'implemented calc.js, 1 test passed',
  files: [
    { filename: 'calc.js', status: 'added', patch: '@@ +1 @@\n+export const add = (a,b)=>a+b;' },
    { filename: 'tests/calc.test.js', status: 'added', patch: '@@ +1 @@\n+test("add", () => {});' },
  ],
};

const FAIL_PR = {
  title: 'feat: payment',
  body: 'implemented payment.js, all green',
  files: [{ filename: 'README.md', status: 'modified', patch: '@@ +1 @@\n+notes' }],
};

test('runGate uses injected fetchPr and returns evaluatePr verdict (pass)', async () => {
  const v = await runGate('o/r', '7', { fetchPr: async () => PASS_PR });
  assert.equal(v.conclusion, 'success');
});

test('runGate returns failure verdict for false-done PR', async () => {
  const v = await runGate('o/r', '8', { fetchPr: async () => FAIL_PR });
  assert.equal(v.conclusion, 'failure');
  assert.ok(v.findings.some((f) => f.rule === 'claim-not-in-diff'));
});

test('runGate returns neutral when repo config disables the gate', async () => {
  const v = await runGate('o/r', '8', {
    fetchPr: async () => FAIL_PR,
    fetchConfig: async () => ({ enabled: false }),
  });
  assert.equal(v.conclusion, 'neutral');
});

test('runGate returns failure when repo config is empty', async () => {
  const v = await runGate('o/r', '8', {
    fetchPr: async () => FAIL_PR,
    fetchConfig: async () => ({}),
  });
  assert.equal(v.conclusion, 'failure');
  assert.ok(v.findings.some((f) => f.rule === 'claim-not-in-diff'));
});

test('runGate does not crash when only fetchPr is injected', async () => {
  const v = await runGate('o/r', '8', { fetchPr: async () => FAIL_PR });
  assert.equal(v.conclusion, 'failure');
});

test('runGate passes repo and prNumber to fetchPr', async () => {
  let got = null;
  await runGate('owner/name', '42', { fetchPr: async (r, n) => { got = [r, n]; return PASS_PR; } });
  assert.deepEqual(got, ['owner/name', '42']);
});

test('renderVerdict produces a readable PASS/FAIL header + summary', async () => {
  const v = await runGate('o/r', '7', { fetchPr: async () => PASS_PR });
  const out = renderVerdict(v, 'o/r', '7');
  assert.match(out, /leerness gate preview — o\/r #7/);
  assert.match(out, /PASS/);
  assert.match(out, /leerness/);
});

test('parseArgs extracts repo and pr number, ignoring flags', () => {
  assert.deepEqual(parseArgs(['octo/repo', '12', '--verbose']), { repo: 'octo/repo', prNumber: '12' });
  assert.deepEqual(parseArgs(['--x', 'a/b', '3']), { repo: 'a/b', prNumber: '3' });
});
