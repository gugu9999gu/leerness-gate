// leerness Gate - Cloudflare Worker entry (GitHub App webhook).
// 흐름: POST webhook -> 서명검증 -> pull_request 이벤트만 처리 -> PR files 조회 -> evaluatePr -> Check Run 게시.
// 시크릿은 env(wrangler secret) 로만: GITHUB_WEBHOOK_SECRET / GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY.

import { verifyWebhookSignature } from './verify-signature.js';
import { evaluatePr } from './gate-check.js';
import { GitHubApp } from './github.js';

const HANDLED_ACTIONS = new Set(['opened', 'synchronize', 'reopened', 'ready_for_review']);

// 순수 라우팅 결정 (단위 테스트 가능): 무엇을 처리/무시할지.
export function routeWebhook({ method, event, action }) {
  if (method !== 'POST') return { handle: false, status: 200, reason: 'leerness gate is alive (POST webhooks only)' };
  if (event === 'ping') return { handle: false, status: 200, reason: 'pong' };
  if (event !== 'pull_request') return { handle: false, status: 200, reason: 'ignored event: ' + event };
  if (!HANDLED_ACTIONS.has(action)) return { handle: false, status: 200, reason: 'ignored action: ' + action };
  return { handle: true, status: 202, reason: 'accepted' };
}

// PR 처리 오케스트레이션 (app 주입 가능 -> 통합 테스트에서 GitHub 호출 mock).
export async function processPullRequest(payload, app) {
  const installationId = payload.installation && payload.installation.id;
  const repo = payload.repository.full_name;
  const pr = { base: {}, ...payload.pull_request };
  const token = await app.installationToken(installationId);
  const files = await app.listPrFiles(token, repo, pr.number);
  // Read config from the base branch, not the PR head, so untrusted PRs cannot weaken gate rules.
  const config = typeof app.getRepoConfig === 'function' ? await app.getRepoConfig(token, repo, pr.base.ref) : {};
  const verdict = evaluatePr({ title: pr.title, body: pr.body, draft: pr.draft, files }, config);
  await app.createCheckRun(token, repo, pr.head.sha, verdict);
  return verdict;
}

// 코어 핸들러 (단위/통합 테스트 가능): Response + 비동기 처리 promise 분리 반환.
//   deps.makeApp(id, key) -> GitHubApp (기본: 실 클라이언트, 테스트: mock).
export async function handleRequest(request, env, deps = {}) {
  const makeApp = deps.makeApp || ((id, key) => new GitHubApp(id, key));
  const method = request.method;
  const event = request.headers.get('x-github-event') || '';

  // GitHub App manifest 콜백: /setup?code= -> code 교환 -> 자격증명 + wrangler 명령 자동 표시 (등록 자동화).
  if (method === 'GET' && new URL(request.url).pathname === '/setup') {
    const code = new URL(request.url).searchParams.get('code');
    return { response: await setupResponse(code, deps), processing: null };
  }
  if (method !== 'POST') {
    return { response: new Response(routeWebhook({ method, event, action: '' }).reason, { status: 200 }), processing: null };
  }

  const raw = await request.text();
  const ok = await verifyWebhookSignature(raw, request.headers.get('x-hub-signature-256'), env.GITHUB_WEBHOOK_SECRET);
  if (!ok) return { response: new Response('invalid signature', { status: 401 }), processing: null };

  let payload;
  try { payload = JSON.parse(raw); } catch { return { response: new Response('invalid json', { status: 400 }), processing: null }; }

  const decision = routeWebhook({ method, event, action: payload.action });
  if (!decision.handle) return { response: new Response(decision.reason, { status: decision.status }), processing: null };

  const app = makeApp(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
  const processing = processPullRequest(payload, app);
  return { response: new Response(decision.reason, { status: decision.status }), processing };
}

// GitHub manifest code -> App 자격증명 교환 (인증 불필요, code 자체가 단일사용·1시간 자격).
async function _exchangeManifestCode(code) {
  const res = await fetch('https://api.github.com/app-manifests/' + encodeURIComponent(code) + '/conversions', {
    method: 'POST',
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'leerness-gate', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

function _esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// /setup 응답 HTML (성공: 자격증명 + wrangler 명령 / 실패: 안내). deps.exchangeManifestCode 주입 가능(테스트).
export async function setupResponse(code, deps = {}) {
  const head = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>leerness gate setup</title>'
    + '<style>body{font:15px/1.6 ui-monospace,monospace;max-width:760px;margin:6vh auto;padding:0 20px;background:#0d1117;color:#e6edf3}'
    + 'h1{font-size:1.4rem}code,pre{background:#161b22;border:1px solid #30363d;border-radius:6px}'
    + 'pre{padding:14px;overflow:auto;white-space:pre-wrap;word-break:break-all}code{padding:2px 6px}'
    + '.k{color:#3fb950}.warn{color:#d29922;border:1px solid #4d3a10;background:#1a1505;padding:10px 14px;border-radius:8px}'
    + '.err{color:#f85149;border:1px solid #4d1310;background:#1a0808;padding:10px 14px;border-radius:8px}a{color:#58a6ff}</style>';
  if (!code) {
    return new Response(head + '<h1>leerness gate setup</h1><p class="err">No manifest <code>code</code> in the URL. Start from <code>deploy/register.html</code>.</p>',
      { status: 400, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  const exchange = deps.exchangeManifestCode || _exchangeManifestCode;
  let app;
  try { app = await exchange(code); } catch (e) {
    return new Response(head + '<h1>leerness gate setup</h1><p class="err">Manifest exchange failed (' + _esc(e && e.message) + '). The code is single-use and expires in 1 hour — re-open <code>deploy/register.html</code> and create the App again.</p>',
      { status: 400, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  const body = head
    + '<h1>App created: ' + _esc(app.name || 'leerness-gate') + ' &#10003;</h1>'
    + '<p class="warn">Shown once. Copy these into your Worker now, then close this tab. Do not share this URL.</p>'
    + '<p><b>App ID:</b> <code>' + _esc(app.id) + '</code></p>'
    + '<p><b>Webhook secret:</b> <code>' + _esc(app.webhook_secret) + '</code></p>'
    + '<p><b>Private key (.pem):</b></p><pre>' + _esc(app.pem) + '</pre>'
    + '<p>Set the Worker secrets (run in the leerness-gate folder). The two single-line values can be pasted interactively:</p>'
    + '<pre><span class="k">npx</span> wrangler secret put GITHUB_WEBHOOK_SECRET   <span style="color:#6e7681"># paste the webhook secret above</span>\n'
    + '<span class="k">npx</span> wrangler secret put GITHUB_APP_ID            <span style="color:#6e7681"># paste the App ID above</span></pre>'
    + '<p class="warn">The private key is multi-line. Pasting it into the interactive prompt silently truncates it on Windows (the App JWT then fails). Save the .pem above to a file (e.g. <code>key.pem</code>) and pipe it in instead:</p>'
    + '<pre><span style="color:#6e7681"># PowerShell (Windows)</span>\n'
    + 'Get-Content -Raw key.pem | <span class="k">npx</span> wrangler secret put GITHUB_APP_PRIVATE_KEY\n\n'
    + '<span style="color:#6e7681"># bash / macOS / Linux</span>\n'
    + '<span class="k">npx</span> wrangler secret put GITHUB_APP_PRIVATE_KEY &lt; key.pem\n\n'
    + '<span class="k">npx</span> wrangler deploy</pre>'
    + '<p>Then <a href="' + _esc(/^https:\/\//.test(String(app.html_url || '')) ? app.html_url : 'https://github.com/settings/installations') + '">install the App on a repo</a> and open a PR.</p>';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

export default {
  async fetch(request, env, ctx) {
    const { response, processing } = await handleRequest(request, env);
    // webhook 은 빠르게 ACK, 검증은 비동기 (GitHub 10s 타임아웃 가드).
    if (processing) ctx.waitUntil(processing.catch((e) => console.error('leerness gate error:', e && e.message)));
    return response;
  },
};
