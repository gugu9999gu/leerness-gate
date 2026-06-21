import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest, processPullRequest } from '../src/index.js';
import { signWebhook } from '../src/verify-signature.js';

const SECRET = 'webhook-secret-for-tests';

// GitHub App 클라이언트 mock: 네트워크 없이 호출 기록 + verdict 캡처.
function mockApp(files = []) {
  const calls = [];
  const app = {
    calls,
    verdict: null,
    async installationToken(id) { calls.push(['token', id]); return 'mock-token'; },
    async listPrFiles(token, repo, num) { calls.push(['files', repo, num]); return files; },
    async createCheckRun(token, repo, sha, verdict) { calls.push(['check', sha, verdict.conclusion]); app.verdict = verdict; return { id: 1 }; },
  };
  return app;
}

function ghPayload(over = {}) {
  return {
    action: 'opened',
    installation: { id: 42 },
    repository: { full_name: 'owner/repo' },
    pull_request: { number: 7, title: 'feat: payment', body: 'implemented a.js; npm test passed', head: { sha: 'headsha' } },
    ...over,
  };
}

async function signedRequest(bodyObj, { secret = SECRET, event = 'pull_request' } = {}) {
  const body = JSON.stringify(bodyObj);
  const sig = await signWebhook(body, secret);
  return new Request('https://gate.example/', {
    method: 'POST',
    headers: { 'x-github-event': event, 'x-hub-signature-256': sig, 'content-type': 'application/json' },
    body,
  });
}

const ENV = { GITHUB_WEBHOOK_SECRET: SECRET, GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: 'pem' };

test('valid PR webhook -> 202 and a check run is posted', async () => {
  const app = mockApp([{ filename: 'a.js', status: 'modified' }]);
  const req = await signedRequest(ghPayload());
  const { response, processing } = await handleRequest(req, ENV, { makeApp: () => app });
  assert.equal(response.status, 202);
  await processing;
  assert.ok(app.calls.some((c) => c[0] === 'check'));
  assert.equal(app.verdict.conclusion, 'success'); // a.js claimed + in diff + evidence present
});

test('false-done PR (claimed file not in diff) -> check conclusion failure', async () => {
  const app = mockApp([{ filename: 'README.md', status: 'modified' }]);
  const req = await signedRequest(ghPayload({ pull_request: { number: 8, title: 'x', body: 'implemented payment.js, 3/3 passed', head: { sha: 's2' } } }));
  const { processing } = await handleRequest(req, ENV, { makeApp: () => app });
  await processing;
  assert.equal(app.verdict.conclusion, 'failure');
  assert.ok(app.verdict.findings.some((f) => f.rule === 'claim-not-in-diff'));
});

test('invalid signature -> 401, no GitHub calls', async () => {
  const app = mockApp();
  const req = await signedRequest(ghPayload(), { secret: SECRET + '-tampered' });
  const { response, processing } = await handleRequest(req, ENV, { makeApp: () => app });
  assert.equal(response.status, 401);
  assert.equal(processing, null);
  assert.equal(app.calls.length, 0);
});

test('non-pull_request event -> 200 ignored, no processing', async () => {
  const app = mockApp();
  const req = await signedRequest({ action: 'whatever' }, { event: 'push' });
  const { response, processing } = await handleRequest(req, ENV, { makeApp: () => app });
  assert.equal(response.status, 200);
  assert.equal(processing, null);
  assert.equal(app.calls.length, 0);
});

test('ignored action (closed) -> 200, no processing', async () => {
  const app = mockApp();
  const req = await signedRequest(ghPayload({ action: 'closed' }));
  const { response, processing } = await handleRequest(req, ENV, { makeApp: () => app });
  assert.equal(response.status, 200);
  assert.equal(processing, null);
});

test('GET (non-POST) -> 200 alive message', async () => {
  const req = new Request('https://gate.example/', { method: 'GET' });
  const { response, processing } = await handleRequest(req, ENV, { makeApp: () => mockApp() });
  assert.equal(response.status, 200);
  assert.equal(processing, null);
});

test('processPullRequest wires PR fields into evaluatePr and posts head sha', async () => {
  const app = mockApp([{ filename: 'a.js' }]);
  const verdict = await processPullRequest(ghPayload(), app);
  assert.ok(verdict.conclusion);
  assert.deepEqual(app.calls.find((c) => c[0] === 'check'), ['check', 'headsha', verdict.conclusion]);
});
