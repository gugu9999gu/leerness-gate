// leerness Gate — PR claim verification core (Worker-safe, pure; no fs / no network).
// leerness 의 검증 철학(증거-게이트 완료, 주장 파일 -> 변경 파일 일치)을 PR 데이터에 적용.
// verify-claim 의 휴리스틱(파일 경로 추출 / 테스트 실행 증거 / 주장-변경 일치)을 CF Worker 환경에 포팅.
//   leerness npm 패키지는 fs/child_process 의존이라 Worker 에서 직접 import 불가 -> 순수 코어만 이식.

const FILE_EXTS = 'webmanifest|dockerfile|properties|tscn|tres|godot|json5|java|jsx|tsx|yaml|html|scss|sass|less|gltf|conf|json|toml|lock|mdx|xml|css|svg|yml|cfg|ini|env|php|mjs|cjs|md|js|ts|gd|cs|py|rb|go|rs|kt|sh|h';
// 파일 경로 추출: 선택적 디렉토리 prefix + 확장자 화이트리스트 (verify-claim FILE_RE 포팅).
const FILE_RE = new RegExp('(?:[A-Za-z0-9][A-Za-z0-9_-]*\\/)?[A-Za-z0-9][\\w./-]*\\.(?:' + FILE_EXTS + ')\\b', 'g');
// 주: 확장자 없는 파일(Dockerfile/Makefile)은 의도적으로 추출 안 함 — 그 단어들이 산문에 흔히 등장해 FP 유발 (적대적 FP-hunt 확인).

// 테스트/검증 실행 증거 신호 (verify-claim evidence 휴리스틱 포팅): X/Y 통과, jest/mocha, 러너 이름, 체크표시.
//   한국어는 양쪽 어순 모두 인식: "12개 테스트"(숫자->테스트) + "테스트 12개"(테스트->숫자, 자연어순).
const TEST_EVIDENCE_RE = /(\d+\s*\/\s*\d+\s*(?:pass|passed|passing|통과))|(Tests?:\s*\d+\s*passed)|(\d+\s+(?:tests?\s+)?pass(?:ed|ing)\b)|(\d+\s*개?\s*테스트)|(테스트\s*\d+\s*개?)|(\b(?:npm|pnpm|yarn)\s+test\b)|(\b(?:pytest|jest|vitest|mocha|tap|playwright|cypress|go\s+test|cargo\s+test|tsc|eslint)\b)|✅|✔/i;
// 명시적 증거/검증 섹션: 진짜 마크다운 헤더(# 1개 이상) + 헤더 아래 실질 내용 요구.
//   (이전 #{0,6} 는 헤더 없이도/빈 헤더만으로도 통과 -> "## Evidence\n"(빈), "tested manually"(헤더X) 가 증거로 인정되던 FN.
//    이제 헤더 + 비어있지 않은 비-부정 내용을 요구해 거짓완료 우회를 차단.)
const _EVIDENCE_HEADER_RE = /(?:^|\n)[ \t]*#{1,6}[ \t]*(?:evidence|verification|test results?|tests?|증거|검증|테스트)\b[^\n]*\n([\s\S]{0,500})/i;
const _EVIDENCE_NEGATIVE_RE = /^(?:n\/?a|none|not\s*run|not\s*tested|todo|tbd|pending|없음|미실행|안\s*함|해당\s*없음)/i;
// 비공식 증거: 사소/문서/스타일 PR 은 테스트 러너 출력이 없을 수 있음 -> 수동/검토 확인도 증거로 인정 (적대적 FP-hunt 반영).
const _INFORMAL_EVIDENCE_RE = /\b(?:tested|verified|reviewed|checked|confirmed|validated|smoke[\s-]?tested)\b|확인했|검증(?:했|함|완료)|테스트(?:했|함|완료)|동작\s*확인|수동\s*(?:테스트|확인)/i;
function _hasEvidenceSection(body) {
  const m = String(body).match(_EVIDENCE_HEADER_RE);
  if (!m) return false;
  const after = (m[1] || '').replace(/^[\s>*\-]+/, '').trim();
  if (after.replace(/\s/g, '').length < 3) return false; // 빈/공백뿐 섹션은 증거 아님
  if (_EVIDENCE_NEGATIVE_RE.test(after)) return false;    // "Not run" / "없음" 등 부정 마커
  return true;
}
const REMEDIATION_BY_RULE = {
  'no-evidence': 'Add an Evidence/Verification section with your test command and its output.',
  'claim-not-in-diff': 'Reference only files this PR actually changes, or include the missing file(s) in the diff.',
  'stub-impl': 'The claimed file adds only comments/blank lines - add the real implementation.',
  'test-count-inflated': 'Match the declared test count to the tests actually added in this PR, or drop the number.',
  'no-files': 'Push your changes - this PR has an empty diff.',
};

function _basename(p) { const s = String(p).split(/[\\/]/); return s[s.length - 1]; }

function _finding(rule, severity, message, extra = {}) {
  return { rule, severity, message, remediation: REMEDIATION_BY_RULE[rule], ...extra };
}

// 느슨한 경로 매칭: PR 파일은 full path, 본문 주장은 부분 경로일 수 있음 -> 정확/suffix/basename 일치 허용.
function _claimInChanged(claim, changedSet) {
  const c = String(claim).replace(/^\.\//, '');
  if (changedSet.has(c)) return true;
  const hasDir = c.includes('/');
  for (const p of changedSet) {
    if (p === c) return true;
    if (p.endsWith('/' + c)) return true;
    // 디렉토리 prefix 가 있는 주장은 basename 만으로 매칭하지 않음 (src/auth.js != tests/auth.js basename 충돌 FN 방지).
    if (!hasDir && _basename(p) === _basename(c)) return true;
  }
  return false;
}

function _ignorePaths(config) {
  if (!Array.isArray(config && config.ignorePaths)) return [];
  if (!config.ignorePaths.every((p) => typeof p === 'string')) return [];
  return config.ignorePaths.filter((p) => p.length > 0);
}

function _isIgnoredPath(path, ignorePaths) {
  const p = String(path || '');
  // 정확 일치 또는 디렉토리 prefix 만 (이전 includes 는 "." 같은 토큰이 거의 모든 경로를 무력화하던 footgun).
  return ignorePaths.some((ignore) => {
    if (!ignore) return false;
    if (p === ignore) return true;
    const dir = ignore.endsWith('/') ? ignore : ignore + '/';
    return p.startsWith(dir);
  });
}

export function extractClaimedFiles(text) {
  return Array.from(new Set(String(text || '').match(FILE_RE) || []));
}

// --- Gate 1: PR diff(patch) 기반 정밀 검증 (verify-claim 의 스텁/카운트 휴리스틱 포팅) ---
const _CODE_EXT = /\.(?:js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|cs|php|kt|swift)$/i;
const _TEST_PATH = /(?:^|[\\/])(?:test_[^\\/]+\.[a-z]+|[^\\/]+[._-]test\.[a-z]+|[^\\/]+\.spec\.[a-z]+)$|(?:^|[\\/])tests?[\\/]/i;

// unified diff patch 에서 추가된(+) 라인만 (+++ 헤더 제외).
export function addedLines(patch) {
  if (!patch) return [];
  return String(patch).split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1));
}

// 본문에서 주장된 테스트 개수 파싱 (verify-claim declaredTestCount 포팅, 한/영 어순).
export function declaredTestCount(text) {
  const t = String(text || '');
  let m = t.match(/(\d+)\s*\/\s*\d+\s*(?:pass|passed|passing|통과)/i); if (m) return parseInt(m[1], 10);
  m = t.match(/Tests?:\s*(?:\d+\s*failed,\s*)?(\d+)\s*passed/i); if (m) return parseInt(m[1], 10);
  m = t.match(/(\d+)\s+passing\b/i); if (m) return parseInt(m[1], 10);
  m = t.match(/(\d+)\s*개?\s*테스트/); if (m) return parseInt(m[1], 10);
  m = t.match(/테스트\s*(\d+)\s*개?/); if (m) return parseInt(m[1], 10);
  m = t.match(/(\d+)\s*tests?\b/i); if (m) return parseInt(m[1], 10);
  return null;
}

// 추가된 라인에서 테스트 케이스 수 (py: def test_/assert · 그 외: it()/test()/check()).
function _countAddedTests(filename, added) {
  const text = added.join('\n');
  if (/\.py$/i.test(filename)) {
    const d = (text.match(/^\s*def\s+test_/gm) || []).length;
    return d || (text.match(/^\s*assert\b/gm) || []).length;
  }
  return (text.match(/\bcheck\s*\(/g) || []).length + (text.match(/\b(?:it|test)\s*\(/g) || []).length;
}

// 추가 라인에 실제 코드(비주석/비공백)가 있는가. 간이 주석 스트립: 블록(/* */, 인라인/멀티라인) + 라인(// #).
export function hasRealCode(added) {
  let inBlock = false;
  for (const raw of added) {
    let line = String(raw);
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end === -1) continue;
      line = line.slice(end + 2);
      inBlock = false;
    }
    // 인라인 /* ... */ 제거 (반복). 닫히지 않으면 inBlock 진입.
    let idx;
    while ((idx = line.indexOf('/*')) !== -1) {
      const end = line.indexOf('*/', idx + 2);
      if (end === -1) { line = line.slice(0, idx); inBlock = true; break; }
      line = line.slice(0, idx) + ' ' + line.slice(end + 2);
    }
    line = line.trim();
    if (!line) continue;
    if (line.startsWith('//') || line.startsWith('#') || line.startsWith('*')) continue;
    return true;
  }
  return false;
}

// 핵심: PR 의 완료 주장이 증거와 일치하는지 평가.
//   pr: { title, body, draft, files: [{ filename, status }] }
//   반환: { conclusion: 'success'|'failure'|'neutral', title, summary(markdown), findings: [{ rule, severity, message, remediation, files? }] }
export function evaluatePr(pr, config = {}) {
  const gateConfig = config && typeof config === 'object' ? config : {};
  if (gateConfig.enabled === false) {
    return {
      conclusion: 'neutral',
      title: 'leerness gate: disabled',
      summary: 'leerness gate is disabled for this repo via .leerness-gate.json.',
      findings: [],
    };
  }

  // 길이 캡: 정규식(FILE_RE/declaredTestCount)은 superlinear -> 공격자제어 본문으로 Worker CPU DoS 가능. 주장/증거는 통상 상단.
  const title = String(pr && pr.title || '').slice(0, 2000);
  const body = String(pr && pr.body || '').slice(0, 16384);
  const draft = pr && pr.draft === true;
  const files = Array.isArray(pr && pr.files) ? pr.files : [];
  const changedSet = new Set(files.map((f) => String((f && f.filename) || '')).filter(Boolean));
  const ignorePaths = _ignorePaths(gateConfig);
  const findings = [];

  // R0: 변경 파일 0 -> 검증할 것 없음(빈 PR).
  if (files.length === 0) {
    findings.push(_finding('no-files', 'fail', 'PR changes no files; nothing to verify.'));
  }

  // R1: 검증 증거(테스트 실행/결과/검증 섹션) 부재 -> 거짓완료 위험.
  const hasEvidence = TEST_EVIDENCE_RE.test(title + '\n' + body) || _INFORMAL_EVIDENCE_RE.test(title + '\n' + body) || _hasEvidenceSection(body);
  if (!hasEvidence) {
    findings.push(_finding('no-evidence', gateConfig.requireEvidence === false ? 'warn' : 'fail', 'No verification evidence in the PR description (no test run, results, or Evidence / Verification section).'));
  }

  // R2: 본문이 주장한 파일이 실제 diff 에 있는가 -> 주장-변경 불일치(거짓완료 신호).
  //   제목은 claim 추출 제외: 제목은 맥락("from legacy.js" 등)을 자주 언급해 FP 유발 (적대적 FP-hunt 확인). 제목-only 우회 FN 은 용인.
  const claimed = extractClaimedFiles(body);
  // 테스트-경로 파일은 본문에서 대개 "실행 증거"(예: "utils.test.js: 8 passed")로 언급됨 → 변경-주장으로 오인 차단(false-fail).
  //   실제로 변경한 테스트 파일은 어차피 diff(changedSet)에 있어 영향 0 — 오직 '증거로만 언급된 미변경 테스트 파일' 만 R2 제외.
  const claimedNotChanged = claimed.filter((f) => !_isIgnoredPath(f, ignorePaths) && !_TEST_PATH.test(f) && !_claimInChanged(f, changedSet));
  if (claimed.length && claimedNotChanged.length) {
    findings.push(_finding('claim-not-in-diff', 'fail', 'Claimed file(s) absent from the PR diff: ' + claimedNotChanged.slice(0, 10).join(', '), { files: claimedNotChanged.slice(0, 10) }));
  }

  // --- Gate 1: diff(patch) 기반 정밀 검증 ---
  const claimedBase = new Set(claimed.filter((c) => !_isIgnoredPath(c, ignorePaths)).map((c) => _basename(c)));

  // R3: 부풀린 테스트 카운트 (본문 주장 N vs diff 가 추가한 테스트 케이스). advisory(warn) -
  //   PR 이 기존 테스트를 참조만 할 수도 있어(추가 0) 하드 차단은 FP 위험 -> 표면화만, conclusion 영향 X.
  const declaredN = declaredTestCount(title + '\n' + body);
  const testFilesWithPatch = files.filter((f) => f.patch && _CODE_EXT.test(String(f.filename || '')) && _TEST_PATH.test(String(f.filename || '')));
  // patch 가 있는 테스트 파일이 있을 때만 측정(없으면 GitHub 가 patch 미반환 등 측정 불가 -> skip, 과탐 방지).
  if (declaredN != null && declaredN > 0 && testFilesWithPatch.length) {
    const addedTests = testFilesWithPatch.reduce((a, f) => a + _countAddedTests(f.filename, addedLines(f.patch)), 0);
    if (addedTests < declaredN) {
      findings.push(_finding('test-count-inflated', 'warn', 'Description claims ' + declaredN + ' test(s) but the diff adds only ' + addedTests + ' test case(s) (existing tests are not counted here).'));
    }
  }

  // R4: 스텁 구현 (본문이 주장한 impl 파일이 diff 에서 주석/빈줄만 추가). hard fail (verify-claim 과 동일, 고신뢰).
  const stubFiles = files
    .filter((f) => f.patch && !_isIgnoredPath(f.filename, ignorePaths) && _CODE_EXT.test(String(f.filename || '')) && !_TEST_PATH.test(String(f.filename || '')) && claimedBase.has(_basename(f.filename)))
    .filter((f) => !hasRealCode(addedLines(f.patch)))
    .map((f) => f.filename);
  if (stubFiles.length) {
    findings.push(_finding('stub-impl', 'fail', 'Claimed implementation file(s) add only comments/blank lines (stub): ' + stubFiles.slice(0, 5).join(', '), { files: stubFiles.slice(0, 5) }));
  }

  const failed = findings.filter((f) => f.severity === 'fail');
  let conclusion = failed.length ? 'failure' : 'success';
  let checkTitle = conclusion === 'success' ? 'leerness gate: claims verified' : ('leerness gate: ' + failed.length + ' issue(s) found');
  if (draft && conclusion === 'failure') {
    conclusion = 'neutral';
    checkTitle = 'leerness gate: ' + failed.length + ' issue(s) - advisory (draft PR)';
  }
  return {
    conclusion,
    title: checkTitle,
    summary: _renderSummary(conclusion, findings, { claimed: claimed.length, changed: files.length, hasEvidence }),
    findings,
  };
}

function _renderSummary(conclusion, findings, stats) {
  const lines = [];
  if (conclusion === 'success') lines.push('### leerness gate passed');
  else if (conclusion === 'neutral') lines.push('### leerness gate - advisory (draft PR)');
  else lines.push('### leerness gate failed');
  lines.push('');
  lines.push('- changed files: ' + stats.changed);
  lines.push('- files claimed in description: ' + stats.claimed);
  lines.push('- verification evidence present: ' + (stats.hasEvidence ? 'yes' : 'no'));
  lines.push('');
  if (findings.length) {
    lines.push('Findings:');
    for (const f of findings) {
      lines.push('- [' + f.severity + '] ' + f.rule + ': ' + f.message);
      lines.push('  fix: ' + f.remediation);
    }
  } else {
    lines.push('All checks passed: the description carries verification evidence and every claimed file is in the diff.');
  }
  lines.push('');
  lines.push('Powered by leerness - "done" must match reality.');
  return lines.join('\n');
}
