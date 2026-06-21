import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyWebhookSignature, signWebhook, timingSafeEqualHex } from '../src/verify-signature.js';

const SECRET = 'test-webhook-secret-123';
const BODY = JSON.stringify({ action: 'opened', number: 7 });

test('valid signature -> true', async () => {
  const sig = await signWebhook(BODY, SECRET);
  assert.equal(await verifyWebhookSignature(BODY, sig, SECRET), true);
});

test('tampered body -> false', async () => {
  const sig = await signWebhook(BODY, SECRET);
  assert.equal(await verifyWebhookSignature(BODY + ' ', sig, SECRET), false);
});

test('wrong secret -> false', async () => {
  const sig = await signWebhook(BODY, SECRET);
  assert.equal(await verifyWebhookSignature(BODY, sig, 'other-secret'), false);
});

test('missing signature / secret -> false (reject, no throw)', async () => {
  assert.equal(await verifyWebhookSignature(BODY, '', SECRET), false);
  assert.equal(await verifyWebhookSignature(BODY, 'sha256=abc', ''), false);
  assert.equal(await verifyWebhookSignature(null, 'sha256=abc', SECRET), false);
});

test('malformed signature header (not 64 hex) -> false', async () => {
  assert.equal(await verifyWebhookSignature(BODY, 'sha256=nothex', SECRET), false);
  assert.equal(await verifyWebhookSignature(BODY, 'sha256=' + 'a'.repeat(63), SECRET), false);
});

test('accepts header without sha256= prefix (raw hex)', async () => {
  const sig = await signWebhook(BODY, SECRET);
  const rawHex = sig.slice('sha256='.length);
  assert.equal(await verifyWebhookSignature(BODY, rawHex, SECRET), true);
});

test('timingSafeEqualHex basic correctness', () => {
  assert.equal(timingSafeEqualHex('abcd', 'abcd'), true);
  assert.equal(timingSafeEqualHex('abcd', 'abce'), false);
  assert.equal(timingSafeEqualHex('abc', 'abcd'), false);
});
