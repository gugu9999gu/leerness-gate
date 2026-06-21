// GitHub webhook 서명 검증 (X-Hub-Signature-256: "sha256=<hex hmac>").
// Web Crypto (globalThis.crypto.subtle) 사용 - CF Workers 와 Node 18+ 양쪽 지원, 추가 의존 0.

const _enc = new TextEncoder();

// 상수시간 hex 비교 (타이밍 공격 완화). 길이 다르면 즉시 false.
function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function _toHex(buf) {
  const v = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < v.length; i++) s += v[i].toString(16).padStart(2, '0');
  return s;
}

// rawBody: webhook 원문 문자열(파싱 전!), signatureHeader: X-Hub-Signature-256 값, secret: App webhook secret.
// 반환: Promise<boolean>. secret/header 없으면 false(거부).
export async function verifyWebhookSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret || typeof rawBody !== 'string') return false;
  const expected = signatureHeader.startsWith('sha256=') ? signatureHeader.slice(7) : signatureHeader;
  if (!/^[0-9a-f]{64}$/i.test(expected)) return false;
  const key = await crypto.subtle.importKey('raw', _enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, _enc.encode(rawBody));
  return timingSafeEqualHex(_toHex(sig), expected.toLowerCase());
}

// 테스트/디버그용: 주어진 secret 으로 payload 의 서명 헤더 값을 생성.
export async function signWebhook(rawBody, secret) {
  const key = await crypto.subtle.importKey('raw', _enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, _enc.encode(rawBody));
  return 'sha256=' + _toHex(sig);
}

export { timingSafeEqualHex };
