import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fetchPrViaGh, fetchPrViaRest, isValidRepoSlug, main, runGate, renderVerdict, parseArgs, VERSION } from '../bin/cli.js';
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

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

test('renderVerdict labels disabled gate as NEUTRAL, never FAIL', async () => {
  const v = await runGate('o/r', '8', {
    fetchPr: async () => FAIL_PR,
    fetchConfig: async () => ({ enabled: false }),
  });
  const out = renderVerdict(v, 'o/r', '8');
  assert.match(out, /NEUTRAL/);
  assert.doesNotMatch(out, /FAIL/);
});

test('parseArgs extracts repo and pr number, ignoring flags', () => {
  assert.deepEqual(parseArgs(['octo/repo', '12', '--verbose']), { repo: 'octo/repo', prNumber: '12' });
  assert.deepEqual(parseArgs(['--x', 'a/b', '3']), { repo: 'a/b', prNumber: '3' });
});

test('repository slug validation blocks URL/query injection', () => {
  assert.equal(isValidRepoSlug('octo/repo.name'), true);
  assert.equal(isValidRepoSlug('octo/repo?per_page=1'), false);
  assert.equal(isValidRepoSlug('octo/repo#fragment'), false);
  assert.equal(isValidRepoSlug('octo/../repo'), false);
  assert.equal(isValidRepoSlug('-octo/repo'), false);
});

test('REST mode fetches PR and paginated files with token auth', async () => {
  const calls = [];
  const firstPage = Array.from({ length: 100 }, (_, i) => ({ filename: 'f' + i + '.js', status: 'modified' }));
  const responses = [
    { title: 'rest', body: 'npm test passed' },
    firstPage,
    [{ filename: '.leerness/current-state.md', status: 'modified', patch: '@@' }],
  ];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => responses.shift(), text: async () => '' };
  };
  const pr = await fetchPrViaRest('o/r', '9', 'token-value', fetchImpl);
  assert.equal(pr.files.length, 101);
  assert.equal(pr.files.at(-1).filename, '.leerness/current-state.md');
  assert.equal(calls.length, 3);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer token-value');
});

test('gh mode slurps and flattens paginated file arrays', () => {
  const calls = [];
  const execImpl = (_command, args) => {
    calls.push(args);
    if (args[1].endsWith('/pulls/9')) return JSON.stringify({ title: 'gh', body: 'npm test passed' });
    return JSON.stringify([
      [{ filename: 'a.js', status: 'modified' }],
      [{ filename: '.leerness/current-state.md', status: 'modified' }],
    ]);
  };
  const pr = fetchPrViaGh('o/r', '9', execImpl);
  assert.deepEqual(pr.files.map((file) => file.filename), ['a.js', '.leerness/current-state.md']);
  assert.ok(calls[1].includes('--paginate'));
  assert.ok(calls[1].includes('--slurp'));
});

test('REST and gh modes reject unsafe PR-number path injection', async () => {
  await assert.rejects(() => fetchPrViaRest('o/r', '9/files?x=1', 'token', async () => {
    throw new Error('network must not be reached');
  }), /invalid GitHub pull request number/);
  assert.throws(() => fetchPrViaGh('o/r', '../9', () => {
    throw new Error('gh must not be reached');
  }), /invalid GitHub pull request number/);
});

test('CLI version is sourced from the package manifest', () => {
  assert.equal(VERSION, packageJson.version);
});

test('main help/version are successful and invalid args remain usage errors', async () => {
  const out = [];
  const io = { log: (s) => out.push(s), error: (s) => out.push(s) };
  assert.equal(await main(['--help'], io), 0);
  assert.match(out.pop(), /usage: leerness-gate/);
  assert.equal(await main(['--version'], io), 0);
  assert.equal(out.pop(), packageJson.version);
  assert.equal(await main([], io), 2);
});

test('packaged CLI process exits 0 for --help and --version', () => {
  const cli = fileURLToPath(new URL('../bin/cli.js', import.meta.url));
  for (const flag of ['--help', '--version']) {
    const result = spawnSync(process.execPath, [cli, flag], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.trim());
  }
});
