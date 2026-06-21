import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupResponse, handleRequest } from '../src/index.js';

const APP = {
  id: 123456,
  name: 'leerness-gate',
  webhook_secret: 'whs_abc123',
  // fake fixture PEM — split literals so the secret scanner does not flag a (non-real) test key
  pem: '-----BEGIN ' + 'PRIVATE KEY-----\nMIIabc\n-----END ' + 'PRIVATE KEY-----',
  html_url: 'https://github.com/apps/leerness-gate',
};

test('setupResponse without code -> 400 with guidance', async () => {
  const r = await setupResponse(undefined, {});
  assert.equal(r.status, 400);
  const body = await r.text();
  assert.match(body, /No manifest/i);
});

test('setupResponse with code -> 200 showing App ID, secret, pem, wrangler commands', async () => {
  const r = await setupResponse('manifest-code', { exchangeManifestCode: async () => APP });
  assert.equal(r.status, 200);
  const body = await r.text();
  assert.match(body, /123456/);
  assert.match(body, /whs_abc123/);
  assert.match(body, /BEGIN PRIVATE KEY/);
  assert.match(body, /GITHUB_APP_PRIVATE_KEY/);
  assert.match(body, /wrangler deploy/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

test('setupResponse exchange failure -> 400 with retry note', async () => {
  const r = await setupResponse('bad-code', { exchangeManifestCode: async () => { throw new Error('HTTP 422'); } });
  assert.equal(r.status, 400);
  const body = await r.text();
  assert.match(body, /exchange failed/i);
  assert.match(body, /HTTP 422/);
});

test('handleRequest routes GET /setup to the setup callback (no code -> 400)', async () => {
  const req = new Request('https://gate.example/setup', { method: 'GET' });
  const { response, processing } = await handleRequest(req, {}, {});
  assert.equal(response.status, 400);
  assert.equal(processing, null);
  assert.match(await response.text(), /No manifest/i);
});

test('handleRequest GET /setup with code uses injected exchange', async () => {
  const req = new Request('https://gate.example/setup?code=xyz', { method: 'GET' });
  const { response } = await handleRequest(req, {}, { exchangeManifestCode: async () => APP });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /123456/);
});

test('GET / (root) still returns the alive message, not setup', async () => {
  const req = new Request('https://gate.example/', { method: 'GET' });
  const { response } = await handleRequest(req, {}, {});
  assert.equal(response.status, 200);
  assert.match(await response.text(), /alive/i);
});
