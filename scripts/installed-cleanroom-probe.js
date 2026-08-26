#!/usr/bin/env node

// Pack both products, install them into one disposable consumer, and exercise
// the exact files users receive from npm. This intentionally does not import
// Gate source from the checkout.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const leernessRoot = path.resolve(sourceRoot, '..', 'leerness-pkg');
const localLeernessAvailable = fs.existsSync(path.join(leernessRoot, 'package.json'));
const leernessSource = process.env.LEERNESS_PACKAGE_SOURCE
  || (localLeernessAvailable ? leernessRoot : 'leerness@latest');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'leerness-gate-installed-cleanroom-'));
const packDir = path.join(tempRoot, 'packs');
const consumer = path.join(tempRoot, 'consumer');
const project = path.join(tempRoot, 'project');
const expectedGateVersion = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8')).version;
const expectedLeernessVersion = localLeernessAvailable
  ? JSON.parse(fs.readFileSync(path.join(leernessRoot, 'package.json'), 'utf8')).version
  : null;
let total = 0;
let failed = 0;

function check(label, condition, detail = '') {
  total += 1;
  const ok = Boolean(condition);
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${label}${!ok && detail ? `: ${detail}` : ''}\n`);
  if (!ok) failed += 1;
  return ok;
}

function npmCliPath() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean);
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error(`npm CLI not found; checked: ${candidates.join(', ')}`);
  return found;
}

function runNode(script, args = [], options = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: options.cwd || consumer,
    encoding: 'utf8',
    timeout: options.timeout || 300000,
    env: {
      ...process.env,
      LEERNESS_OFFLINE: '1',
      LEERNESS_NO_PROMPT: '1',
      LEERNESS_NO_AUTOCHCP: '1',
      LEERNESS_NO_DRIFT_CHECK: '1',
      npm_config_update_notifier: 'false',
      ...options.env,
    },
  });
}

function runNpm(args, cwd = tempRoot) {
  return runNode(npmCliPath(), args, { cwd, timeout: 600000 });
}

function parsePack(result) {
  try {
    const value = JSON.parse(String(result.stdout || '').trim());
    return Array.isArray(value) && value[0] ? value[0].filename : null;
  } catch { return null; }
}

function pack(root) {
  const result = runNpm(['pack', root, '--ignore-scripts', '--json', '--pack-destination', packDir]);
  const filename = parsePack(result);
  return { result, tarball: filename ? path.join(packDir, filename) : null };
}

function spawnHandoff(cli, sessionId) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, 'handoff', project, '--quiet', '--no-drift-check'], {
      cwd: project,
      env: {
        ...process.env,
        LEERNESS_OFFLINE: '1',
        LEERNESS_NO_PROMPT: '1',
        LEERNESS_NO_AUTOCHCP: '1',
        LEERNESS_SESSION_ID: sessionId,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ sessionId, status, stdout, stderr }));
  });
}

async function main() {
  fs.mkdirSync(packDir, { recursive: true });
  fs.mkdirSync(consumer, { recursive: true });
  fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({
    name: 'leerness-products-cleanroom',
    private: true,
    version: '0.0.0',
  }, null, 2) + '\n', 'utf8');

  const gatePack = pack(sourceRoot);
  check('leerness-gate packs from release files',
    gatePack.result.status === 0 && gatePack.tarball && fs.existsSync(gatePack.tarball),
    gatePack.result.stderr || gatePack.result.stdout);
  const leernessPack = pack(leernessSource);
  check(localLeernessAvailable ? 'local leerness packs beside Gate' : 'published leerness packs for standalone Gate CI',
    leernessPack.result.status === 0 && leernessPack.tarball && fs.existsSync(leernessPack.tarball),
    leernessPack.result.stderr || leernessPack.result.stdout);
  if (!gatePack.tarball || !leernessPack.tarball) return;

  const install = runNpm([
    'install', gatePack.tarball, leernessPack.tarball,
    '--ignore-scripts', '--no-audit', '--no-fund',
  ], consumer);
  check('both tarballs install together in an empty consumer', install.status === 0,
    install.stderr || install.stdout);
  if (install.status !== 0) return;

  const installedGate = path.join(consumer, 'node_modules', 'leerness-gate');
  const installedLeerness = path.join(consumer, 'node_modules', 'leerness');
  const gatePackage = JSON.parse(fs.readFileSync(path.join(installedGate, 'package.json'), 'utf8'));
  const leernessPackage = JSON.parse(fs.readFileSync(path.join(installedLeerness, 'package.json'), 'utf8'));
  check('installed package versions match both release manifests',
    gatePackage.version === expectedGateVersion
      && (expectedLeernessVersion ? leernessPackage.version === expectedLeernessVersion : /^\d+\.\d+\.\d+/.test(leernessPackage.version)),
    `gate=${gatePackage.version}/${expectedGateVersion} leerness=${leernessPackage.version}/${expectedLeernessVersion || 'published'}`);

  const gateCli = path.join(installedGate, 'bin', 'cli.js');
  const help = runNode(gateCli, ['--help']);
  const version = runNode(gateCli, ['--version']);
  const invalid = runNode(gateCli, ['owner/repo?inject=1', '1']);
  check('packaged Gate CLI help/version use successful exit codes',
    help.status === 0 && /usage: leerness-gate/.test(help.stdout)
      && version.status === 0 && version.stdout.trim() === expectedGateVersion,
    `help=${help.status} version=${version.status} ${help.stderr || version.stderr}`);
  check('packaged Gate CLI rejects unsafe repository slugs before network access',
    invalid.status === 2 && /usage: leerness-gate/.test(invalid.stderr),
    `exit=${invalid.status} ${invalid.stdout || invalid.stderr}`);

  const shimHelp = runNpm(['exec', '--', 'leerness-gate', '--help'], consumer);
  const shimVersion = runNpm(['exec', '--', 'leerness-gate', '--version'], consumer);
  check('npm launcher executes the packaged Gate CLI on this platform',
    shimHelp.status === 0 && /usage: leerness-gate/.test(shimHelp.stdout)
      && shimVersion.status === 0 && shimVersion.stdout.trim() === expectedGateVersion,
    `help=${shimHelp.status} version=${shimVersion.status} ${shimHelp.stderr || shimVersion.stderr}`);

  const installedPackageTest = runNpm(['test'], installedGate);
  check('published Gate tarball keeps its advertised test surface runnable',
    installedPackageTest.status === 0 && /fail 0/.test(installedPackageTest.stdout),
    installedPackageTest.stderr || installedPackageTest.stdout);

  const gateCore = await import(pathToFileURL(path.join(installedGate, 'src', 'gate-check.js')).href);
  const claimed = gateCore.extractClaimedFiles([
    '.leerness/current-state.md', '.harness/plan.md', '.leerness-gate.json',
    './src/main.js', './.leerness/session-handoff.md',
  ].join(', '));
  const verdict = gateCore.evaluatePr({
    title: 'chore: workspace migration',
    body: 'npm test passed; changed .leerness/current-state.md, .harness/plan.md, .leerness-gate.json, ./src/main.js, and ./.leerness/session-handoff.md',
    files: claimed.map((filename) => ({ filename: filename.replace(/^\.\//, ''), status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' })),
  });
  check('installed Gate core preserves leading-dot paths and verifies their diff',
    claimed.length === 5 && claimed.every((file) => file.startsWith('.'))
      && verdict.conclusion === 'success'
      && !verdict.findings.some((finding) => finding.rule === 'claim-not-in-diff'),
    JSON.stringify({ claimed, verdict }));

  const leernessCli = path.join(installedLeerness, 'bin', 'leerness.js');
  fs.mkdirSync(project, { recursive: true });
  const init = runNode(leernessCli, [
    'init', project, '--yes', '--minimal', '--language', 'en', '--no-stale-check', '--json',
  ], { cwd: project });
  check('co-installed Leerness initializes the canonical workspace',
    init.status === 0 && fs.existsSync(path.join(project, '.leerness', 'HARNESS_VERSION'))
      && !fs.existsSync(path.join(project, '.harness')),
    init.stderr || init.stdout);

  const sessionIds = ['gate-codex-01', 'gate-claude-01', 'gate-cursor-01'];
  const handoffs = await Promise.all(sessionIds.map((id) => spawnHandoff(leernessCli, id)));
  const sessionDir = path.join(project, '.leerness', 'cache', 'sessions');
  const isolated = sessionIds.every((id) => {
    const file = path.join(sessionDir, `${id}.json`);
    if (!fs.existsSync(file)) return false;
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    return record.sessionKey === id && record.handoffCount === 1;
  });
  check('co-installed Leerness keeps parallel agent handoffs isolated',
    handoffs.every((result) => result.status === 0) && isolated,
    JSON.stringify(handoffs));

  const audit = runNpm(['audit', '--omit=dev', '--json'], consumer);
  let auditJson = null;
  try { auditJson = JSON.parse(audit.stdout); } catch {}
  check('combined runtime dependency audit is clean',
    audit.status === 0 && auditJson && auditJson.metadata?.vulnerabilities?.total === 0,
    audit.stderr || audit.stdout);
}

try {
  await main();
} catch (error) {
  check('combined installed cleanroom does not throw', false, error && error.stack ? error.stack : String(error));
} finally {
  const resolved = path.resolve(tempRoot);
  const temp = path.resolve(os.tmpdir());
  if (path.dirname(resolved) !== temp || !resolved.startsWith(temp + path.sep)) {
    throw new Error(`unsafe cleanup target: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

if (failed) {
  process.stderr.write(`GATE_INSTALLED_CLEANROOM_FAILED ${failed}/${total}\n`);
  process.exit(1);
}
process.stdout.write(`GATE_INSTALLED_CLEANROOM_OK ${total}/${total}\n`);
