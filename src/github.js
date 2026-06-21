// GitHub App 클라이언트 (CF Worker, Web Crypto 만 사용 - 추가 의존 0).
// App JWT(RS256) -> installation access token -> PR files 조회 + Check Run 생성.
// 시크릿(App private key / webhook secret)은 코드에 없음 - 런타임 env(wrangler secret)로만 주입.

const _enc = new TextEncoder();

function _b64url(buf) {
  const v = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < v.length; i++) s += String.fromCharCode(v[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// DER 길이 인코딩 (short form <128, long form 이상).
function _derLen(n) {
  if (n < 0x80) return [n];
  const out = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) out.unshift(v & 0xff);
  return [0x80 | out.length, ...out];
}

// PKCS#1 RSAPrivateKey -> PKCS#8 PrivateKeyInfo 로 래핑.
// GitHub App 개인키는 PKCS#1("BEGIN RSA PRIVATE KEY") 인데 Web Crypto importKey 는 PKCS#8 만 받음.
// PrivateKeyInfo = SEQ { INTEGER 0, AlgId(rsaEncryption,NULL), OCTET STRING { <pkcs1 DER> } }.
function _wrapPkcs1AsPkcs8(pkcs1) {
  const version = [0x02, 0x01, 0x00];
  const algId = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const pk = Array.from(pkcs1);
  const octet = [0x04, ..._derLen(pk.length), ...pk];
  const inner = [...version, ...algId, ...octet];
  return new Uint8Array([0x30, ..._derLen(inner.length), ...inner]);
}

// PEM(또는 변형된 secret 값) -> PKCS#8 DER ArrayBuffer (견고 파서).
//  - 대화형 `wrangler secret put` 으로 흔히 생기는 리터럴 \n/\r/\t escape 를 정규화
//  - base64 알파벳 외 문자는 전부 제거 (Workers 의 엄격한 atob 가 backslash 등에서 throw 하는 것 방지)
//  - PKCS#1("RSA PRIVATE KEY", GitHub App 포맷) 은 PKCS#8 로 래핑
function _pkcs8FromPem(pem) {
  const s = String(pem).replace(/\\r/g, '').replace(/\\n/g, '\n').replace(/\\t/g, '');
  const isPkcs1 = /RSA PRIVATE KEY/.test(s);
  let b64 = s.replace(/-----(?:BEGIN|END)[A-Z0-9 ]*-----/g, '').replace(/[^A-Za-z0-9+/=]/g, '');
  b64 += '='.repeat((4 - (b64.length % 4)) % 4); // 패딩 보정 (미padding base64 secret 대비; Workers atob 는 length%4==0 요구)
  const bin = atob(b64);
  const raw = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
  const der = isPkcs1 ? _wrapPkcs1AsPkcs8(raw) : raw;
  return der.buffer;
}

const GH_API = 'https://api.github.com';
const UA = 'leerness-gate';

export class GitHubApp {
  constructor(appId, privateKeyPem) {
    this.appId = String(appId);
    this.privateKeyPem = privateKeyPem;
  }

  // RS256 App JWT. nowSec: 현재 유닉스초(테스트 주입 가능; 미지정 시 Date.now()).
  async appJwt(nowSec) {
    const now = Number.isFinite(nowSec) ? nowSec : Math.floor(Date.now() / 1000);
    const header = _b64url(_enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
    const payload = _b64url(_enc.encode(JSON.stringify({ iat: now - 60, exp: now + 540, iss: this.appId })));
    const signingInput = header + '.' + payload;
    const key = await crypto.subtle.importKey('pkcs8', _pkcs8FromPem(this.privateKeyPem), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, _enc.encode(signingInput));
    return signingInput + '.' + _b64url(sig);
  }

  async _ghFetch(url, token, init) {
    const res = await fetch(url, {
      ...init,
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': UA,
        ...((init && init.headers) || {}),
      },
    });
    return res;
  }

  // installation access token (1시간 만료). JWT 로 교환.
  async installationToken(installationId, nowSec) {
    const jwt = await this.appJwt(nowSec);
    const res = await this._ghFetch(GH_API + '/app/installations/' + installationId + '/access_tokens', jwt, { method: 'POST' });
    if (!res.ok) throw new Error('installation token failed: ' + res.status);
    const j = await res.json();
    return j.token;
  }

  // PR 변경 파일 (페이지네이션: 최대 300, GitHub 제약 5000 req/hr 내 단순 가드).
  async listPrFiles(token, repoFullName, prNumber) {
    const files = [];
    for (let page = 1; page <= 10; page++) {
      const res = await this._ghFetch(GH_API + '/repos/' + repoFullName + '/pulls/' + prNumber + '/files?per_page=100&page=' + page, token, { method: 'GET' });
      if (!res.ok) throw new Error('list PR files failed: ' + res.status);
      const batch = await res.json();
      for (const f of batch) files.push({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch });
      if (batch.length < 100) break;
    }
    return files;
  }

  async getRepoConfig(token, repoFullName, ref) {
    try {
      if (!repoFullName || !ref) return {};
      const res = await this._ghFetch(GH_API + '/repos/' + repoFullName + '/contents/.leerness-gate.json?ref=' + encodeURIComponent(ref), token, { method: 'GET' });
      if (!res.ok) return {};
      const body = await res.json();
      if (!body || typeof body.content !== 'string') return {};
      const decoded = atob(body.content.replace(/\s/g, ''));
      const parsed = JSON.parse(decoded);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return parsed;
    } catch {
      return {};
    }
  }

  // Check Run 생성 (head SHA 에 conclusion 게시). verdict: evaluatePr 결과.
  async createCheckRun(token, repoFullName, headSha, verdict) {
    const body = {
      name: 'leerness gate',
      head_sha: headSha,
      status: 'completed',
      conclusion: verdict.conclusion,
      output: { title: verdict.title, summary: verdict.summary },
    };
    const res = await this._ghFetch(GH_API + '/repos/' + repoFullName + '/check-runs', token, { method: 'POST', body: JSON.stringify(body) });
    if (!res.ok) throw new Error('create check run failed: ' + res.status);
    return res.json();
  }
}

export { _b64url };
