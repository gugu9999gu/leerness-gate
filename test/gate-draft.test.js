import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePr } from '../src/gate-check.js';

test('findings include remediation and summary renders fix lines', () => {
  const r = evaluatePr({ title: 'draft work', body: 'Implemented missing.js', files: [] });

  assert.ok(r.findings.length > 0);
  assert.ok(r.findings.every((f) => typeof f.remediation === 'string' && f.remediation.length > 0));
  assert.match(r.summary, /\n  fix:/);
});

test('draft failing PR returns neutral advisory verdict', () => {
  const r = evaluatePr({
    title: 'Implement payment API',
    body: 'Implemented payment.js',
    draft: true,
    files: [{ filename: 'README.md', status: 'modified' }],
  });

  assert.equal(r.conclusion, 'neutral');
  assert.match(r.title, /advisory/);
});

test('non-draft failing PR remains failure', () => {
  const r = evaluatePr({
    title: 'Implement payment API',
    body: 'Implemented payment.js',
    draft: false,
    files: [{ filename: 'README.md', status: 'modified' }],
  });

  assert.equal(r.conclusion, 'failure');
});

test('draft passing PR remains success', () => {
  const r = evaluatePr({
    title: 'Implement payment API',
    body: 'Implemented payment.js. Tests: 1 passed.',
    draft: true,
    files: [{ filename: 'payment.js', status: 'added' }],
  });

  assert.equal(r.conclusion, 'success');
});
