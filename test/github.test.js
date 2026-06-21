import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, webcrypto } from 'node:crypto';
import { GitHubApp } from '../src/github.js';

// 런타임 키 생성 (하드코딩 개인키 0 -> 시크릿 스캐너 FP 없음).
function makePair(type) {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type, format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
}

// SPKI 공개키로 RS256 JWT 서명을 암호학적으로 검증 (래핑이 단지 import 가능한 게 아니라 올바른 서명을 내는지 증명).
async function verifyJwt(jwt, spkiPem) {
  const b64 = spkiPem.replace(/-----(?:BEGIN|END)[A-Z ]*-----/g, '').replace(/\s+/g, '');
  const key = await webcrypto.subtle.importKey('spki', Buffer.from(b64, 'base64'), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const [h, p, s] = jwt.split('.');
  const sig = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return webcrypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, Buffer.from(h + '.' + p));
}

test('appJwt: PKCS#8 key -> 검증가능한 RS256 서명', async () => {
  const { privateKey, publicKey } = makePair('pkcs8');
  const jwt = await new GitHubApp('123', privateKey).appJwt(1000);
  assert.equal(jwt.split('.').length, 3);
  assert.equal(await verifyJwt(jwt, publicKey), true);
});

test('appJwt: PKCS#1 key (GitHub App 포맷) -> PKCS#8 래핑 후 검증가능한 서명', async () => {
  const { privateKey, publicKey } = makePair('pkcs1');
  assert.match(privateKey, /RSA PRIVATE KEY/); // 진짜 PKCS#1 인지 확인
  const jwt = await new GitHubApp('123', privateKey).appJwt(1000);
  assert.equal(await verifyJwt(jwt, publicKey), true);
});

test('appJwt: 리터럴 \\n 으로 변형된 secret (대화형 입력 모사) 도 복구', async () => {
  const { privateKey, publicKey } = makePair('pkcs1');
  const mangled = privateKey.replace(/\r?\n/g, '\\n'); // 실제 개행 -> 리터럴 backslash-n
  assert.ok(!mangled.includes('\n')); // 실제 개행 없음 확인
  const jwt = await new GitHubApp('123', mangled).appJwt(1000);
  assert.equal(await verifyJwt(jwt, publicKey), true);
});

test('appJwt: 단일 payload claim 구조 (iss/iat/exp)', async () => {
  const { privateKey } = makePair('pkcs8');
  const jwt = await new GitHubApp('456', privateKey).appJwt(2000);
  const claims = JSON.parse(Buffer.from(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  assert.equal(claims.iss, '456');
  assert.equal(claims.iat, 1940);
  assert.equal(claims.exp, 2540);
});
