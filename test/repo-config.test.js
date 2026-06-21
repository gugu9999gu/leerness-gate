import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubApp } from '../src/github.js';

test('getRepoConfig returns empty object on 404 response', async () => {
  const app = new GitHubApp('1', 'unused');
  app._ghFetch = async (url, token, init) => {
    assert.equal(url, 'https://api.github.com/repos/owner/repo/contents/.leerness-gate.json?ref=main');
    assert.equal(token, 'token');
    assert.equal(init.method, 'GET');
    return { ok: false, status: 404 };
  };

  assert.deepEqual(await app.getRepoConfig('token', 'owner/repo', 'main'), {});
});

test('getRepoConfig decodes base64 JSON content', async () => {
  const app = new GitHubApp('1', 'unused');
  const content = Buffer.from(JSON.stringify({ enabled: false })).toString('base64');
  app._ghFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ content }),
  });

  assert.deepEqual(await app.getRepoConfig('token', 'owner/repo', 'main'), { enabled: false });
});
