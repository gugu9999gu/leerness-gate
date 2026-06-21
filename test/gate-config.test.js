import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePr } from '../src/gate-check.js';

test('enabled:false gives neutral disabled verdict', () => {
  const r = evaluatePr({
    title: 'feat: payment',
    body: 'implemented payment.js, npm test passed',
    files: [{ filename: 'payment.js', status: 'modified' }],
  }, { enabled: false });

  assert.equal(r.conclusion, 'neutral');
  assert.equal(r.title, 'leerness gate: disabled');
  assert.deepEqual(r.findings, []);
});

test('requireEvidence:false downgrades missing evidence to warning success', () => {
  const r = evaluatePr({
    title: 'feat: payment',
    body: 'implemented payment.js',
    files: [{ filename: 'payment.js', status: 'modified' }],
  }, { requireEvidence: false });

  assert.equal(r.conclusion, 'success');
  assert.ok(r.findings.some((f) => f.rule === 'no-evidence' && f.severity === 'warn'));
});

test('ignorePaths generated prefix suppresses absent generated claim failure', () => {
  const r = evaluatePr({
    title: 'feat: generated output',
    body: 'generated generated/foo.js, npm test passed',
    files: [{ filename: 'README.md', status: 'modified' }],
  }, { ignorePaths: ['generated/'] });

  assert.equal(r.conclusion, 'success');
  assert.ok(!r.findings.some((f) => f.rule === 'claim-not-in-diff'));
});

test('default config still fails a false done PR', () => {
  const r = evaluatePr({
    title: 'feat: payment',
    body: 'implemented payment.js, npm test passed',
    files: [{ filename: 'README.md', status: 'modified' }],
  });

  assert.equal(r.conclusion, 'failure');
  assert.ok(r.findings.some((f) => f.rule === 'claim-not-in-diff'));
});
