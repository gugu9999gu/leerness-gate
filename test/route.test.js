import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeWebhook } from '../src/index.js';

test('non-POST -> not handled, 200', () => {
  const r = routeWebhook({ method: 'GET', event: '', action: '' });
  assert.equal(r.handle, false);
  assert.equal(r.status, 200);
});

test('ping event -> pong, not handled', () => {
  const r = routeWebhook({ method: 'POST', event: 'ping', action: '' });
  assert.equal(r.handle, false);
  assert.equal(r.reason, 'pong');
});

test('non-pull_request event -> ignored, 200', () => {
  const r = routeWebhook({ method: 'POST', event: 'push', action: '' });
  assert.equal(r.handle, false);
  assert.match(r.reason, /ignored event/);
});

test('pull_request opened -> handled, 202', () => {
  const r = routeWebhook({ method: 'POST', event: 'pull_request', action: 'opened' });
  assert.equal(r.handle, true);
  assert.equal(r.status, 202);
});

test('pull_request synchronize -> handled', () => {
  assert.equal(routeWebhook({ method: 'POST', event: 'pull_request', action: 'synchronize' }).handle, true);
});

test('pull_request closed -> ignored action', () => {
  const r = routeWebhook({ method: 'POST', event: 'pull_request', action: 'closed' });
  assert.equal(r.handle, false);
  assert.match(r.reason, /ignored action/);
});
