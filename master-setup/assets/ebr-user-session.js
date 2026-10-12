/* =====================================================================
   ebr-user-session.js — eBR · eMBR PoC 사용자 · 역할 · 전자서명 · 감사추적 공용 헬퍼 (전역 EbrUserSession)
   - UI-09. 공개 API 명세: ui-09-ebr-user-session-api.md (승인 2026-10-09)
   - 같은 파일 2벌 (바이트 동일, tests/check-user-session.cjs 가 검사):
       docs/design/poc/assets/ebr-user-session.js              (eBR 화면: ./assets/)
       docs/design/poc/master-setup/assets/ebr-user-session.js (기준정보 화면: ../assets/)
   - 외부 의존 없음 (Elephant UX 셸 MesUI · TreeDesigner 불필요, sha256 · stableStringify 내장). HTML 을 만들지 않는다.
   - 저장 키: ebmr.userRole.v1 · ebmr.currentUser.v1 · ebr.esign.v1 · ebr.audit.v1
     읽기 전용: ebmr.masterSetup.v2 (S-39 sign) — 이 파일은 기준정보 키에 쓰지 않는다
     발행 커밋: ebr.batch.issued.v1 · ebr.order.v1 (오더 연동 발행만)
     레코드 서명(칭량 등): ebr.esign.v1 + 호출자가 넘긴 키(spec.keys)를 한 트랜잭션으로 커밋 · 실패 시 복원
   - PoC 전용: 비밀번호 해시(pwHash)를 localStorage 에 둔다. 보안 통제가 아니라 흐름 시연용이며
     실서비스는 인증 수단 AM-IDPW(LDAP 플러그인)가 검증하고 비밀번호를 저장하지 않는다.
   - 비밀번호 값은 저장 · 감사 · 콘솔 어디에도 남기지 않는다.
   ===================================================================== */
(function (global) {
  'use strict';

  /* ------------------------------------------------------------------ 상수 */
  var KEYS = {
    USER_ROLE: 'ebmr.userRole.v1',
    CURRENT_USER: 'ebmr.currentUser.v1',
    ESIGN: 'ebr.esign.v1',
    AUDIT: 'ebr.audit.v1',
    ESIGN_VOID: 'ebr.esignVoid.v1',   /* 서명 무효화 기록 (추가 전용 · 해시 사슬) — ESIGN_INVALIDATED 감사와 대조 */
    MASTER: 'ebmr.masterSetup.v2',
    ISSUED: 'ebr.batch.issued.v1',
    ORDER: 'ebr.order.v1',
    PROCESS_TREE: 'ebmr.processTree.v1'   /* 읽기 전용 — 커밋 직전 재검사(snapshot_changed) */
  };
  var MASTER_VERSION = 3;              /* shared-store.js VERSION 과 같아야 S-39 행을 읽는다 */
  var ROLES = ['OP', 'SV', 'QA', 'QP', 'ADMIN'];
  var ROLE_PRIORITY = ['QP', 'QA', 'SV', 'OP', 'ADMIN'];
  var ROLE_LABEL = { OP: '작업자', SV: '감독자', QA: 'QA', QP: 'QP', ADMIN: '관리자' };
  var GMP_ROLES = ['OP', 'SV', 'QA', 'QP'];
  var MAX_FAIL = 5;                    /* 결정 D2 */
  var ISSUE_RULE_ID = 'SM-APPR-ISSUE';
  var DEMO_PASSWORD = 'poc1234';       /* PoC 전용 데모 비밀번호 */
  var DEMO_PASSWORD_HINT = 'PoC 데모 비밀번호: ' + DEMO_PASSWORD + ' (PoC 전용 — 실서비스는 LDAP AM-IDPW)';
  var FALLBACK_TZ = 'Asia/Seoul';
  var MEANING_COLOR = 'var(--c-sign-approved)', MEANING_EN = 'Approved by';   /* 색은 mesui.css 토큰 --c-sign-* (GCM data1 값이 있으면 그 값) */
  /* 서명 의미 기본값 (S-39 GCM EBR_SIGN_MEANING 시드와 같은 값, LS 에 GCM 이 있으면 그 값을 쓴다) */
  var MEANING_DEFAULT = {
    performed: { color: 'var(--c-sign-performed)', en: 'Performed by', ko: '수행' },
    verified: { color: 'var(--c-sign-verified)', en: 'Verified by', ko: '확인' },
    approved: { color: MEANING_COLOR, en: MEANING_EN, ko: '승인' },
    reviewed: { color: 'var(--c-sign-reviewed)', en: 'Reviewed by', ko: '검토' },
    read_understood: { color: 'var(--c-sign-read-understood)', en: 'Read and understood', ko: '읽고 이해함' }
  };
  /* 칭량 서명 규칙 (기획 칭량 §4.3, 결정 W6 · W8) · 저울 일상 점검(BALCHK) · 불합격 후 재점검(BALRECHK, 감독자) — 저울 점검 설계 개정 2 B1-11 */
  var WEIGH_RULES = { PERFORM: 'SM-PERF-WEIGH', VERIFY: 'SM-VERI-WEIGH', REWEIGH: 'SM-APPR-REWEIGH', BALCHK: 'SM-PERF-BALCHK', BALRECHK: 'SM-PERF-BALRECHK' };

  /* S-39 발행 승인 규칙 내장본 — shared-store.js 시드 행과 같은 값 (해시 제외, 테스트가 대조) */
  var SEED_ISSUE_RULE = {
    id: ISSUE_RULE_ID, ver: 1, meaning: 'approved', recType: 'batch_issue', auth: 'full_factor', batch: false,
    samePerson: true, status: 'effective', upd: '2026-10-09', note: '배치 발행 승인 (P0 1인 · 감독자/QA)', author: '이수진',
    allowedRoles: ['SV', 'QA']
  };
  /* 내장 규칙 — shared-store.js S-39 시드 행과 같은 값 (해시 제외, 테스트가 대조).
     마스터 키가 없거나(builtin) 해당 id 행이 없으면(backfill) 이 값을 쓴다. 행이 있으면 마스터 값 그대로(allowedRoles 비면 fail-closed) */
  function seedRule(id, ver, meaning, recType, auth, upd, note, roles) {
    return { id: id, ver: ver, meaning: meaning, recType: recType, auth: auth, batch: false,
             samePerson: meaning !== 'performed' && meaning !== 'read_understood', status: 'effective', upd: upd, note: note, author: '이수진', allowedRoles: roles };
  }
  var BUILTIN_RULES = {};
  BUILTIN_RULES[ISSUE_RULE_ID] = SEED_ISSUE_RULE;
  BUILTIN_RULES[WEIGH_RULES.PERFORM] = seedRule(WEIGH_RULES.PERFORM, 2, 'performed', 'weigh_value', 'pin_session', '2026-07-01', '', ['OP', 'SV']);
  BUILTIN_RULES[WEIGH_RULES.VERIFY] = seedRule(WEIGH_RULES.VERIFY, 2, 'verified', 'weigh_value', 'full_factor', '2026-07-01', '', ['OP', 'SV', 'QA']);
  BUILTIN_RULES[WEIGH_RULES.REWEIGH] = seedRule(WEIGH_RULES.REWEIGH, 1, 'approved', 'weigh_reweigh', 'full_factor', '2026-10-09', '재칭량 승인 (허용오차 이탈 1회차 · 감독자/QA)', ['SV', 'QA']);
  BUILTIN_RULES[WEIGH_RULES.BALCHK] = seedRule(WEIGH_RULES.BALCHK, 1, 'performed', 'balance_check', 'pin_session', '2026-10-09', '저울 일상 점검 (분동 점검 · 작업자/감독자)', ['OP', 'SV']);
  BUILTIN_RULES[WEIGH_RULES.BALRECHK] = seedRule(WEIGH_RULES.BALRECHK, 1, 'performed', 'balance_check', 'pin_session', '2026-10-11', '저울 재점검 (불합격 후 사용 금지 해제 · 감독자)', ['SV']);
  /* 실행 · 출하 서명 규칙 (실행 · 출하 서명 설계 §2.2 · D1-02) — 재사용 7 + 신규 4 + MBR 검토(P1). shared-store.js S-39 시드 행(effective 최고 버전)과 같은 값 */
  var EXEC_RULES = {
    STEP_PERFORM: 'SM-PERF-STEP', STEP_VERIFY: 'SM-VERI-STEP', PACK_LABEL_QA: 'SM-VERI-PKLAB', PACK_REVIEW: 'SM-REV-PACK', MATQC: 'SM-APPR-MATQC',
    RBE: 'SM-REV-RBE', BATCH_REVIEW: 'SM-REV-BATCH', AUDIT_REVIEW: 'SM-REV-AUDIT', RELEASE: 'SM-APPR-REL', MBR_REVIEW: 'SM-REV-MBR', MBR_APPROVE: 'SM-APPR-MBR', BRIEFING: 'SM-READ-BRIEF'
  };
  function seedRuleB(id, ver, meaning, recType, auth, batch, upd, note, roles) { var r = seedRule(id, ver, meaning, recType, auth, upd, note, roles); r.batch = batch; return r; }
  BUILTIN_RULES['SM-PERF-STEP'] = seedRuleB('SM-PERF-STEP', 3, 'performed', 'step_value', 'pin_session', false, '2026-07-01', 'Operation 종료 시 수행 서명', ['OP', 'SV']);
  BUILTIN_RULES['SM-VERI-STEP'] = seedRuleB('SM-VERI-STEP', 3, 'verified', 'step_value', 'full_factor', false, '2026-07-01', '동일인 차단 · 랜덤 키패드', ['OP', 'SV', 'QA']);
  BUILTIN_RULES['SM-APPR-MBR'] = seedRuleB('SM-APPR-MBR', 2, 'approved', 'mbr_approval', 'full_factor', false, '2026-06-05', '', ['QA']);
  BUILTIN_RULES['SM-APPR-REL'] = seedRuleB('SM-APPR-REL', 2, 'approved', 'release', 'full_factor', false, '2026-06-05', '개별 · 일괄 불가', ['QP', 'QA']);
  BUILTIN_RULES['SM-READ-BRIEF'] = seedRuleB('SM-READ-BRIEF', 2, 'read_understood', 'briefing', 'pin_session', true, '2026-08-20', '', ['OP', 'SV', 'QA', 'QP']);
  BUILTIN_RULES['SM-REV-RBE'] = seedRuleB('SM-REV-RBE', 1, 'reviewed', 'rbe_exception', 'full_factor', true, '2026-08-10', '', ['QA', 'QP']);
  BUILTIN_RULES['SM-REV-AUDIT'] = seedRuleB('SM-REV-AUDIT', 2, 'reviewed', 'audit_trail', 'full_factor', false, '2026-10-12', '감사추적 검토 (출하 게이트 4 · 배치별)', ['QA', 'QP']);
  BUILTIN_RULES['SM-VERI-PKLAB'] = seedRuleB('SM-VERI-PKLAB', 1, 'verified', 'step_value', 'full_factor', false, '2026-10-12', '포장 라벨 · 코딩 첫 시료 QA 확인', ['QA']);
  BUILTIN_RULES['SM-REV-PACK'] = seedRuleB('SM-REV-PACK', 1, 'reviewed', 'batch_review', 'full_factor', false, '2026-10-12', '포장 기록 검토 (1차 · 감독자)', ['SV']);
  BUILTIN_RULES['SM-APPR-MATQC'] = seedRuleB('SM-APPR-MATQC', 1, 'approved', 'material_qc', 'full_factor', false, '2026-10-12', '자재 QC 판정 (적합 해제 · 부적합 · QA)', ['QA']);
  BUILTIN_RULES['SM-REV-BATCH'] = seedRuleB('SM-REV-BATCH', 1, 'reviewed', 'batch_review', 'full_factor', false, '2026-10-12', '배치 기록 2차 검토 (critical 전수 · QA)', ['QA']);
  BUILTIN_RULES['SM-REV-MBR'] = seedRuleB('SM-REV-MBR', 1, 'reviewed', 'mbr_approval', 'full_factor', false, '2026-10-12', 'MBR 독립 검토 (작성자와 다른 사람)', ['QA', 'SV']);

  var ROLE_DEFS = [
    { code: 'OP', name: '작업자', gmpSign: true }, { code: 'SV', name: '감독자', gmpSign: true },
    { code: 'QA', name: 'QA', gmpSign: true }, { code: 'QP', name: 'QP (출하 책임자)', gmpSign: true },
    { code: 'ADMIN', name: '관리자', gmpSign: false }
  ];
  /* 시드 11명 = MS.USERS 6명 + 포장 화면 4명 + QP 1명(출하 승인 데모, 실행 · 출하 서명 설계 X3 · X13). [userId, name, dept, roles, note] */
  var SEED_USERS = [
    ['QA-0011', '이수진', 'QA팀', ['QA'], ''],
    ['QA-0012', '박정훈', 'QA팀', ['QA'], ''],
    ['QA-0013', '정다은', 'QA팀', ['QA'], ''],
    ['SV-0011', '최민아', '생산1팀', ['SV'], '생산 감독자'],
    ['PE-0011', '한승우', '공정기술팀', [], '공정 엔지니어 — GMP 서명 역할 없음(저작자)'],
    ['AD-0001', '김민수', 'IT', ['ADMIN'], 'MES 관리자'],
    ['OP-0101', '작업자 A', '포장팀', ['OP'], '자격 PK-L02 유효(2027-04)'],
    ['OP-0102', '작업자 B', '포장팀', ['OP'], '자격 PK-L02 유효(2027-01)'],
    ['SV-0003', '감독자 C', '포장팀', ['SV'], '자격 유효(2027-06)'],
    ['QA-0007', 'QA D', 'QA팀', ['QA'], '현장 QA · 자격 유효(2027-03)'],
    ['QP-0001', 'QP E', 'QA팀', ['QP'], '출하 승인 (QP 인증)']
  ];
  /* 예전 저장소 보충 (1회 · 추가만): 표지 o.backfills 에 id 를 남겨, 사용자가 뒤에 삭제 · 수정해도 다시 넣지 않는다. 그 ID 가 이미 있으면 표지만 */
  var USER_BACKFILLS = [{ id: 'BF-USER-QP0001', userId: 'QP-0001' }];
  /* 스모크 픽스처 (시드와 별도, _test.seedSmokeFixtures() 로만 추가). [userId, name, dept, roles, status] */
  var FIXTURE_USERS = [
    ['OP-0103', '작업자 L', '포장팀', ['OP'], 'locked'],
    ['OP-0104', '작업자 Z', '포장팀', ['OP'], 'inactive'],
    ['SV-0004', '감독자 F', '생산1팀', ['SV', 'OP'], 'active']
  ];

  var MSG = {
    no_current_user: '사용자를 선택하세요 — 상단 사용자 선택기에서 현재 사용자를 고른 뒤 다시 시도하세요.',
    not_current_user: '현재 사용자와 다른 ID로는 서명할 수 없습니다 — 상단에서 사용자를 전환한 뒤 다시 서명하세요.',
    locked: '계정이 잠겼습니다 — 관리자(ADMIN)에게 해제를 요청하세요.',
    locked_now: '계정이 잠겼습니다. 관리자에게 해제를 요청하세요.',
    inactive: '비활성 계정입니다 — 관리자에게 문의하세요.',
    allowed_roles_unset_issue: '허용 역할 미설정 — 발행 승인 규칙(S-39 SM-APPR-ISSUE)에 허용 역할이 없어 서명할 수 없습니다. 기준정보 담당자에게 S-39 설정을 요청하세요.',
    role_denied_issue: '권한 없음 — 발행 승인은 감독자/QA만 서명할 수 있습니다.',
    precheck_order: '오더 상태가 바뀌어 발행할 수 없습니다 — 화면을 새로 고쳐 다시 확인하세요.',
    precheck_batch: '같은 배치 ID가 이미 발행되어 있습니다 — 화면을 새로 고쳐 다시 확인하세요.',
    precheck_snapshot: '서명 대상 스냅샷이 바뀌었습니다 — [발행]을 다시 눌러 주세요.',
    /* 서명 창 열기 전 불일치: 화면이 들고 있는 트리가 낡은 것이라 [발행] 재시도만으로는 해소되지 않음 */
    precheck_snapshot_begin: '발행 기준 프로세스 트리가 화면을 연 뒤 바뀌었습니다 — 화면을 새로 고친 뒤 다시 발행하세요.',
    save_error: '발행이 취소되었습니다(저장 실패)',
    audit_error: '감사 기록을 저장하지 못해 진행할 수 없습니다 — 저장 공간을 확인한 뒤 다시 시도하세요.',
    ticket_closed: '서명 창이 이미 닫혔습니다 — [발행]을 다시 눌러 주세요.',
    ticket_closed_record: '서명 창이 이미 닫혔습니다 — 서명을 다시 시작하세요.',
    statement_mismatch: '서명 문장이 바뀌었습니다 — 서명 창의 문장을 다시 확인하세요.',
    record_save_error: '서명이 취소되었습니다(저장 실패) — 상태는 바뀌지 않았습니다.',
    record_precheck: '서명 대상 기록이 서명 창을 연 뒤 바뀌었습니다 — 서명 창을 닫고 다시 여세요.',
    unknown_user: '등록되지 않은 사용자 ID 입니다 — 본인 ID 를 확인하세요.'
  };
  /* ⑥ 동일인 차단 메시지 (label: '수행자' · '칭량자' 등) */
  function samePersonMessage(label, id, mode) {
    return '동일인 서명 불가 — ' + (label || '앞 서명자') + '(' + id + ')와 다른 사람이 서명해야 합니다. ' +
      (mode === 'entered' ? '다른 사람이 자기 ID 와 비밀번호로 서명하세요.' : '상단에서 사용자를 전환한 뒤 다시 서명하세요.');
  }

  /* ------------------------------------------------------------------ 유틸 */
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function normId(s) { return String(s == null ? '' : s).trim().toUpperCase(); }
  function p2(n) { return (n < 10 ? '0' : '') + n; }
  function uniq(a) { var s = {}, out = []; (a || []).forEach(function (x) { if (!s[x]) { s[x] = 1; out.push(x); } }); return out; }
  function sortRoles(a) { return uniq(a).filter(function (r) { return ROLES.indexOf(r) >= 0; }).sort(function (x, y) { return ROLE_PRIORITY.indexOf(x) - ROLE_PRIORITY.indexOf(y); }); }

  /* ISO 8601 로컬 오프셋 포함: 2026-10-09T08:12:03+09:00 */
  function nowIsoLocal(d) {
    d = d || new Date();
    var off = -d.getTimezoneOffset(), sg = off >= 0 ? '+' : '-', a = Math.abs(off);
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + 'T' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()) +
      sg + p2(Math.floor(a / 60)) + ':' + p2(a % 60);
  }
  function tzName() { try { return (global.Intl && Intl.DateTimeFormat().resolvedOptions().timeZone) || FALLBACK_TZ; } catch (e) { return FALLBACK_TZ; } }
  /* '2026-10-09T08:12:03+09:00' → '2026-10-09 08:12:03 KST' (다른 오프셋은 '(UTC±hh:mm)', Z/무오프셋은 로컬 변환) */
  function fmtKst(iso) {
    if (!iso) return '';
    var m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?([+-]\d{2}:\d{2})$/.exec(String(iso));
    if (m) return m[1] + ' ' + m[2] + (m[3] === '+09:00' ? ' KST' : ' (UTC' + m[3] + ')');
    var d = new Date(iso);
    return isNaN(d.getTime()) ? String(iso) : fmtKst(nowIsoLocal(d));
  }
  function ymdOf(iso) { return String(iso).slice(0, 10).replace(/-/g, ''); }
  function fmtNum(n) { var x = Number(n); return isNaN(x) ? String(n == null ? '' : n) : x.toLocaleString('en-US', { maximumFractionDigits: 6 }); }
  function screenName() {
    try { var p = (global.location && global.location.pathname) || ''; return p.split('/').pop().replace(/\.html?$/i, ''); } catch (e) { return ''; }
  }

  /* 정렬 직렬화 · SHA-256 — tree-designer.js stableStringify · sha256Hex 와 같은 결과 (테스트가 대조) */
  function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    var keys = Object.keys(value).sort();
    return '{' + keys.map(function (k) { return JSON.stringify(k) + ':' + stableStringify(value[k]); }).join(',') + '}';
  }
  function sha256Hex(str) {
    function rotr(n, x) { return (x >>> n) | (x << (32 - n)); }
    function utf8Bytes(s) {
      var out = [];
      for (var i = 0; i < s.length; i++) {
        var c = s.charCodeAt(i);
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
        else if (c >= 0xd800 && c <= 0xdbff) {
          var c2 = s.charCodeAt(++i);
          var cp = 0x10000 + (((c & 0x3ff) << 10) | (c2 & 0x3ff));
          out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
      return out;
    }
    var K = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327da, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var bytes = utf8Bytes(String(str));
    var l = bytes.length;
    var bitLenHi = Math.floor(l / 0x20000000);
    var bitLenLo = (l << 3) >>> 0;
    bytes.push(0x80);
    while ((bytes.length % 64) !== 56) bytes.push(0);
    bytes.push((bitLenHi >>> 24) & 0xff, (bitLenHi >>> 16) & 0xff, (bitLenHi >>> 8) & 0xff, bitLenHi & 0xff);
    bytes.push((bitLenLo >>> 24) & 0xff, (bitLenLo >>> 16) & 0xff, (bitLenLo >>> 8) & 0xff, bitLenLo & 0xff);
    for (var i = 0; i < bytes.length; i += 64) {
      var w = new Array(64);
      for (var j = 0; j < 16; j++) {
        var o = i + j * 4;
        w[j] = ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
      }
      for (var j2 = 16; j2 < 64; j2++) {
        var s0 = rotr(7, w[j2 - 15]) ^ rotr(18, w[j2 - 15]) ^ (w[j2 - 15] >>> 3);
        var s1 = rotr(17, w[j2 - 2]) ^ rotr(19, w[j2 - 2]) ^ (w[j2 - 2] >>> 10);
        w[j2] = (w[j2 - 16] + s0 + w[j2 - 7] + s1) >>> 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (var j3 = 0; j3 < 64; j3++) {
        var S1 = rotr(6, e) ^ rotr(11, e) ^ rotr(25, e);
        var ch = (e & f) ^ (~e & g);
        var t1 = (h + S1 + ch + K[j3] + w[j3]) >>> 0;
        var S0 = rotr(2, a) ^ rotr(13, a) ^ rotr(22, a);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }
    return H.map(function (x) { var s = (x >>> 0).toString(16); while (s.length < 8) s = '0' + s; return s; }).join('');
  }
  function hashPw(userId, pw) { return sha256Hex(normId(userId) + ':' + String(pw == null ? '' : pw)); }
  function computeSnapshotHash(snap) { return sha256Hex(stableStringify(snap === undefined ? null : snap)); }

  /* ------------------------------------------------------------------ localStorage */
  var failNextStage = null;            /* _test.failNext — 다음 해당 단계 저장 1회 실패 주입 */
  function ls() { return global.localStorage; }
  function readRaw(key) { try { return ls().getItem(key); } catch (e) { return null; } }
  function readJson(key, fb) {
    var raw = readRaw(key);
    if (raw == null || raw === '') return fb;
    try { var o = JSON.parse(raw); return o == null ? fb : o; } catch (e) { return fb; }
  }
  function readArr(key) { var v = readJson(key, []); return Array.isArray(v) ? v : (v && Array.isArray(v.items) ? v.items : []); }
  function writeJson(key, obj, stage) {
    if (stage && failNextStage === stage) { failNextStage = null; throw new Error('저장 실패 주입 (' + stage + ')'); }
    ls().setItem(key, JSON.stringify(obj));
  }
  function restoreRaw(key, raw) {
    try { if (raw == null) ls().removeItem(key); else ls().setItem(key, raw); return true; } catch (e) { return false; }
  }

  /* ------------------------------------------------------------------ 변경 알림 */
  var listeners = [];
  function emit(type, external) { listeners.slice().forEach(function (fn) { try { fn({ type: type, external: !!external }); } catch (e) { if (global.console) console.error(e); } }); }
  if (global.addEventListener) {
    global.addEventListener('storage', function (e) {
      if (!e) return;
      if (e.key === KEYS.CURRENT_USER) emit('currentUser', true);
      else if (e.key === KEYS.USER_ROLE) emit('users', true);
      else if (e.key === null) emit('users', true);   /* localStorage.clear() */
    });
  }
  function onChange(fn) {
    if (typeof fn !== 'function') return function () {};
    listeners.push(fn);
    return function () { var i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
  }

  /* ------------------------------------------------------------------ 감사추적 ebr.audit.v1 (append-only) */
  var SECRET_KEY = /^(password|passwd|pwd|pw)$/i;
  function scrub(o) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return o;
    var c = {}; Object.keys(o).forEach(function (k) { if (!SECRET_KEY.test(k)) c[k] = o[k]; }); return c;
  }
  function nextSeq(list, prefix, idKey, width) {
    var max = 0;
    list.forEach(function (r) { var id = r && r[idKey]; if (id && id.indexOf(prefix) === 0) { var n = parseInt(id.slice(prefix.length), 10); if (n > max) max = n; } });
    var s = String(max + 1); while (s.length < width) s = '0' + s;
    return prefix + s;
  }
  /* D1-8: 서명 관련 감사 항목에 붙는 구조화 필드. batchId · signRuleId · recordType 은 설계 필수, lineId · dispenseId 는 칭량 줄 조회용, signerMode 는 입력 ID 서명 표시 */
  var STRUCT_KEYS = ['batchId', 'signRuleId', 'recordType', 'lineId', 'dispenseId', 'signerMode'];
  function withStruct(e, st) {
    if (st) ['batchId', 'signRuleId', 'recordType', 'lineId', 'dispenseId'].forEach(function (k) { if (st[k] != null && st[k] !== '' && e[k] == null) e[k] = st[k]; });
    return e;
  }
  /* entries 를 한 번의 setItem 으로 append (원자적). 저장 실패 시 throw */
  function appendAudit(entries, stage) {
    var list = readArr(KEYS.AUDIT).slice(), out = [], curId = getCurrentUserId();
    entries.forEach(function (e0) {
      var e = scrub(e0 || {}), at = e.at || nowIsoLocal();
      var uid = e.uid == null ? (curId || '') : String(e.uid);
      var u = getUserRaw(normId(uid));
      var rec = {
        auditId: nextSeq(list, 'AU-' + ymdOf(at) + '-', 'auditId', 5), at: at,
        uid: uid, userName: e.userName != null ? e.userName : (u ? u.name : ''),
        currentUserId: e.currentUserId !== undefined ? e.currentUserId : curId,
        act: String(e.act || ''), tgt: e.tgt || '', val: e.val || '', why: e.why || '',
        before: e.before === undefined ? null : scrub(e.before), after: e.after === undefined ? null : scrub(e.after),
        screen: e.screen || screenName()
      };
      if (Object.prototype.hasOwnProperty.call(e, 'orderNo')) rec.orderNo = e.orderNo ? String(e.orderNo) : null;
      ['detail', 'sodWarning', 'observedBy'].forEach(function (k) { if (e[k] !== undefined) rec[k] = e[k]; });   /* observedBy: 시스템 행위(uid SYSTEM) 때 화면 현재 사용자 */
      /* D1-8 감사 구조화 필드 (추가만, 값이 있을 때만 — 기존 tgt · val 문자열 불변) */
      STRUCT_KEYS.forEach(function (k) { if (e[k] != null && e[k] !== '') rec[k] = String(e[k]); });
      list.push(rec); out.push(rec);
    });
    writeJson(KEYS.AUDIT, list, stage || 'audit');
    return out;
  }
  var Audit = {
    KEY: KEYS.AUDIT,
    append: function (entry) { return clone(appendAudit([entry])[0]); },
    /* 여러 건을 한 번의 setItem 으로 (원자적). 저장 실패 시 throw — 호출자가 상태를 되돌린다 */
    appendMany: function (entries) { return clone(appendAudit(Array.isArray(entries) ? entries : [])); },
    list: function (f) {
      f = f || {};
      return readArr(KEYS.AUDIT).filter(function (r) {
        return (!f.act || r.act === f.act) && (!f.uid || r.uid === f.uid) && (!f.tgt || String(r.tgt).indexOf(f.tgt) >= 0) && (!f.why || r.why === f.why);
      }).map(clone);
    }
  };
  function tryAudit(entries) { try { appendAudit(entries); return true; } catch (e) { return false; } }

  /* ------------------------------------------------------------------ 사용자 store ebmr.userRole.v1 */
  function mkUser(id, name, dept, status, note, at, updBy) {
    var st = status || 'active';
    return { userId: id, name: name, dept: dept, status: st, failCount: st === 'locked' ? MAX_FAIL : 0, lockedAt: st === 'locked' ? at : null,
             authMethod: 'AM-IDPW', pwHash: hashPw(id, DEMO_PASSWORD), note: note || '', upd: at, updBy: updBy || 'SEED' };
  }
  function seedStore() {
    var at = nowIsoLocal(), o = { v: 1, seededAt: at, users: [], roles: clone(ROLE_DEFS), userRoles: [], backfills: USER_BACKFILLS.map(function (b) { return b.id; }) };
    SEED_USERS.forEach(function (r) {
      o.users.push(mkUser(r[0], r[1], r[2], 'active', r[4], at, 'SEED'));
      r[3].forEach(function (code) { o.userRoles.push({ userId: r[0], roleCode: code, validFrom: '', validTo: '' }); });
    });
    return o;
  }
  function validStore(o) { return o && typeof o === 'object' && Array.isArray(o.users) && Array.isArray(o.userRoles); }
  function loadStore() {
    var o = readJson(KEYS.USER_ROLE, null);
    if (validStore(o)) { backfillUsers(o); return o; }
    o = seedStore();
    try { writeJson(KEYS.USER_ROLE, o); } catch (e) { /* 저장 불가(file:// 정책 등) → 메모리 시드 */ }
    return o;
  }
  function backfillUsers(o) {
    if (!Array.isArray(o.backfills)) o.backfills = [];
    var changed = false;
    USER_BACKFILLS.forEach(function (b) {
      if (o.backfills.indexOf(b.id) >= 0) return;
      var r = SEED_USERS.filter(function (x) { return x[0] === b.userId; })[0];
      if (r && !findUser(o, b.userId)) {
        o.users.push(mkUser(r[0], r[1], r[2], 'active', r[4], nowIsoLocal(), 'SEED'));
        r[3].forEach(function (code) { o.userRoles.push({ userId: r[0], roleCode: code, validFrom: '', validTo: '' }); });
      }
      o.backfills.push(b.id); changed = true;
    });
    if (changed) { try { writeJson(KEYS.USER_ROLE, o); } catch (e) { /* 저장 불가 → 메모리 사본으로 진행, 다음 로드에 재시도 */ } }
  }
  function saveStore(o) { writeJson(KEYS.USER_ROLE, o, 'users'); emit('users', false); }
  function findUser(o, id) { id = normId(id); for (var i = 0; i < o.users.length; i++) if (normId(o.users[i].userId) === id) return o.users[i]; return null; }
  function rolesIn(o, id) { id = normId(id); return sortRoles(o.userRoles.filter(function (r) { return normId(r.userId) === id; }).map(function (r) { return r.roleCode; })); }
  function getUserRaw(id) { if (!id) return null; var o = loadStore(); return findUser(o, id); }
  function pub(u, o) {
    if (!u) return null;
    return { userId: u.userId, name: u.name, dept: u.dept || '', status: u.status, failCount: u.failCount || 0, lockedAt: u.lockedAt || null,
             lastUnlockAt: u.lastUnlockAt || null, lastUnlockBy: u.lastUnlockBy || null,
             authMethod: u.authMethod || 'AM-IDPW', note: u.note || '', upd: u.upd || '', updBy: u.updBy || '', roles: rolesIn(o, u.userId) };
  }

  function ensureSeed() {
    var o = readJson(KEYS.USER_ROLE, null);
    if (validStore(o)) return { seeded: false };
    loadStore(); emit('users', false);
    return { seeded: true };
  }
  function listUsers(f) {
    f = f || {};
    var o = loadStore(), q = String(f.q || '').trim().toLowerCase();
    return o.users.map(function (u) { return pub(u, o); }).filter(function (u) {
      if (q && (u.userId + ' ' + u.name + ' ' + u.dept).toLowerCase().indexOf(q) < 0) return false;
      if (f.role && u.roles.indexOf(f.role) < 0) return false;
      if (f.status && u.status !== f.status) return false;
      return true;
    });
  }
  function getUser(id) { var o = loadStore(); return pub(findUser(o, id), o); }
  function rolesOf(id) { return rolesIn(loadStore(), id); }
  function hasSodConflict(roles) { var r = sortRoles(roles); return r.indexOf('ADMIN') >= 0 && r.some(function (x) { return GMP_ROLES.indexOf(x) >= 0; }); }

  /* ------------------------------------------------------------------ 현재 사용자 ebmr.currentUser.v1 */
  function getCurrentUserId() { var c = readJson(KEYS.CURRENT_USER, null); return c && c.userId ? normId(c.userId) : null; }
  function getCurrentUser() { var id = getCurrentUserId(); return id ? getUser(id) : null; }
  function currentUserName(fallback) { var u = getCurrentUser(); return u ? u.name : fallback; }
  function isCurrentAdmin() { var u = getCurrentUser(); return !!(u && u.status === 'active' && u.roles.indexOf('ADMIN') >= 0); }
  function setCurrentUser(id, opts) {
    opts = opts || {};
    var to = id ? normId(id) : null, from = getCurrentUserId();
    var u = null;
    if (to) {
      u = getUser(to);
      if (!u) return { ok: false, code: 'NOT_FOUND', message: '등록되지 않은 사용자입니다: ' + to };
      if (u.status === 'locked') return { ok: false, code: 'LOCKED', message: MSG.locked };
      if (u.status === 'inactive') return { ok: false, code: 'INACTIVE', message: MSG.inactive };
    }
    if (to === from) return { ok: true, user: u, changed: false };
    var raw = readRaw(KEYS.CURRENT_USER);
    try {
      writeJson(KEYS.CURRENT_USER, { userId: to, since: nowIsoLocal() });
      appendAudit([{ uid: to || from || '', currentUserId: to, act: 'USER_SWITCH', tgt: to || '', val: (from || '(없음)') + ' → ' + (to || '(없음)'),
                     before: { userId: from }, after: { userId: to }, screen: opts.screen }]);
    } catch (e) {
      restoreRaw(KEYS.CURRENT_USER, raw);
      return { ok: false, code: 'SAVE_ERROR', message: MSG.audit_error };
    }
    emit('currentUser', false);
    return { ok: true, user: u, changed: true };
  }
  function switchOptions() {
    return listUsers().map(function (u) {
      var reason = u.status === 'locked' ? '잠김' : u.status === 'inactive' ? '비활성' : '';
      return { value: u.userId, label: u.name + ' (' + u.userId + ')' + (reason ? ' — ' + reason : ''), disabled: !!reason, reason: reason, roles: u.roles, status: u.status };
    });
  }

  /* ------------------------------------------------------------------ 사용자 편집 (S-41) — 현재 사용자 ADMIN 만 */
  function userSnap(u, roles) { return u ? { name: u.name, dept: u.dept || '', status: u.status, roles: roles } : null; }
  function commitStore(o, rawBefore, auditEntry) {
    try { saveStore(o); appendAudit([auditEntry]); return null; }
    catch (e) { restoreRaw(KEYS.USER_ROLE, rawBefore); emit('users', false); return { ok: false, code: 'SAVE_ERROR', message: MSG.audit_error }; }
  }
  function saveUser(input, opts) {
    input = input || {}; opts = opts || {};
    if (!isCurrentAdmin()) return { ok: false, code: 'NOT_ADMIN', message: '관리자(ADMIN)만 편집할 수 있습니다.' };
    var actor = getCurrentUserId();
    var id = normId(input.userId), name = String(input.name == null ? '' : input.name).trim();
    if (!id || !name) return { ok: false, code: 'REQUIRED', message: '사용자 ID와 이름은 필수입니다.' };
    var roles = sortRoles(input.roles);
    if (!roles.length) return { ok: false, code: 'NO_ROLE', message: '역할을 1개 이상 선택하세요.' };
    var raw = readRaw(KEYS.USER_ROLE), o = loadStore(), ex = findUser(o, id);
    /* mode: 'create' | 'update' (DEV4 S-41). 생략 시 isNew → 없으면 존재 여부로 추정 */
    var mode = input.mode === 'create' || input.mode === 'update' ? input.mode : (input.isNew === true ? 'create' : input.isNew === false ? 'update' : (ex ? 'update' : 'create'));
    var isNew = mode === 'create';
    if (isNew && ex) return { ok: false, code: 'DUP_ID', message: 'ID는 재사용할 수 없습니다' + (ex.status === 'inactive' ? ' (비활성 사용자 ID)' : '') + ': ' + id };
    if (!isNew && !ex) return { ok: false, code: 'NOT_FOUND', message: '등록되지 않은 사용자입니다: ' + id };
    var st = input.status || (ex ? ex.status : 'active');
    if (ex && st === ex.status) { /* 상태 변경 없음 (locked 유지 포함) */ }
    else if (st !== 'active' && st !== 'inactive') return { ok: false, code: 'BAD_STATUS', message: '상태는 active / inactive 만 저장할 수 있습니다.' };
    else if (ex && ex.status === 'locked' && st === 'active') return { ok: false, code: 'BAD_STATUS', message: '잠긴 계정은 [잠금 해제]로만 활성화할 수 있습니다.' };
    if (isNew && !String(input.password || '')) return { ok: false, code: 'REQUIRED', message: '초기 비밀번호를 입력하세요.' };
    var at = nowIsoLocal(), before = ex ? userSnap(ex, rolesIn(o, id)) : null, u;
    if (isNew) {
      u = { userId: id, name: name, dept: String(input.dept || '').trim(), status: st, failCount: 0, lockedAt: null, authMethod: 'AM-IDPW',
            pwHash: hashPw(id, input.password), note: String(input.note || ''), upd: at, updBy: actor };
      o.users.push(u);
    } else {
      u = ex; u.name = name; u.dept = String(input.dept == null ? (u.dept || '') : input.dept).trim(); u.status = st;
      if (input.note !== undefined) u.note = String(input.note || '');
      u.upd = at; u.updBy = actor;
    }
    o.userRoles = o.userRoles.filter(function (r) { return normId(r.userId) !== id; })
      .concat(roles.map(function (code) { return { userId: id, roleCode: code, validFrom: '', validTo: '' }; }));
    var sod = hasSodConflict(roles);
    var err = commitStore(o, raw, { uid: actor, act: 'USER_UPDATE', tgt: id, val: (isNew ? 'create' : 'update') + ' · 역할 ' + roles.join(',') + (sod ? ' · 직무 분리 경고(ADMIN+GMP)' : ''),
                                    before: before, after: userSnap(u, roles), sodWarning: sod, screen: opts.screen });
    if (err) return err;
    return { ok: true, user: pub(u, o), isNew: isNew, sodWarning: sod };
  }
  function unlockUser(id, opts) {
    opts = opts || {};
    if (!isCurrentAdmin()) return { ok: false, code: 'NOT_ADMIN', message: '관리자(ADMIN)만 해제할 수 있습니다.' };
    var raw = readRaw(KEYS.USER_ROLE), o = loadStore(), u = findUser(o, id);
    if (!u) return { ok: false, code: 'NOT_FOUND', message: '등록되지 않은 사용자입니다: ' + normId(id) };
    if (u.status !== 'locked') return { ok: false, code: 'NOT_LOCKED', message: '잠긴 계정이 아닙니다.' };
    var before = { status: 'locked', failCount: u.failCount || 0, lockedAt: u.lockedAt || null };
    var at = nowIsoLocal(), admin = getCurrentUserId();
    u.status = 'active'; u.failCount = 0; u.lockedAt = null; u.lastUnlockAt = at; u.lastUnlockBy = admin; u.upd = at; u.updBy = admin;
    var err = commitStore(o, raw, { uid: getCurrentUserId(), act: 'USER_UNLOCK', tgt: u.userId, val: '잠금 해제 · 실패 ' + before.failCount + '/' + MAX_FAIL + ' → 0/' + MAX_FAIL,
                                    before: before, after: { status: 'active', failCount: 0, lockedAt: null }, screen: opts.screen });
    if (err) return err;
    return { ok: true, user: pub(u, o) };
  }
  /* 시드 복원 — 현재 사용자 ADMIN 만 (콘솔 호출로 D2 잠금을 우회하지 못하게). 잠김·실패 카운트가 있던 계정은 감사 SEED_RESET 에 남긴다 */
  function resetSeed(opts) {
    opts = opts || {};
    if (!isCurrentAdmin()) return { ok: false, code: 'NOT_ADMIN', message: '관리자(ADMIN)만 시드를 복원할 수 있습니다.' };
    var raw = readRaw(KEYS.USER_ROLE), prev = loadStore(), actor = getCurrentUserId(), actorRec = findUser(prev, actor);
    var beforeUsers = prev.users.map(function (u) { return { userId: u.userId, status: u.status, failCount: u.failCount || 0, lockedAt: u.lockedAt || null, roles: rolesIn(prev, u.userId) }; });
    var o = seedStore(), seedIds = o.users.map(function (u) { return u.userId; });
    var unlocked = beforeUsers.filter(function (u) { return u.status === 'locked' || u.failCount > 0; }).map(function (u) { return u.userId; });
    var removed = beforeUsers.filter(function (u) { return seedIds.indexOf(u.userId) < 0; }).map(function (u) { return u.userId; });
    var err = commitStore(o, raw, {
      uid: actor, userName: actorRec ? actorRec.name : '', act: 'SEED_RESET', tgt: KEYS.USER_ROLE,
      val: '시드 복원 · ' + beforeUsers.length + '명 → ' + o.users.length + '명' + (unlocked.length ? ' · 잠금/실패 초기화 ' + unlocked.join(', ') : '') + (removed.length ? ' · 삭제 ' + removed.join(', ') : ''),
      before: { users: beforeUsers }, after: { userCount: o.users.length },
      detail: { unlocked: unlocked, removed: removed }, screen: opts.screen
    });
    if (err) return err;
    return { ok: true, count: o.users.length, unlocked: unlocked, removed: removed };
  }
  function seedSmokeFixtures() {
    var o = loadStore(), at = nowIsoLocal(), added = [];
    FIXTURE_USERS.forEach(function (r) {
      if (findUser(o, r[0])) return;
      o.users.push(mkUser(r[0], r[1], r[2], r[4], '스모크 픽스처', at, 'FIXTURE'));
      r[3].forEach(function (code) { o.userRoles.push({ userId: r[0], roleCode: code, validFrom: '', validTo: '' }); });
      added.push(r[0]);
    });
    if (added.length) saveStore(o);
    return added;
  }

  /* ------------------------------------------------------------------ 인증 · 실패 카운트 */
  function verifyPassword(id, pw) { var u = getUserRaw(id); return !!(u && u.pwHash && u.pwHash === hashPw(id, pw)); }
  /* 현재 사용자 본인에게만 호출 (아니면 무시). 5회째 잠금 + 감사 USER_LOCKED */
  function recordFail(id, ctx) {
    var rf = recordFailCore(id, ctx);
    if (rf.lockAudit) tryAudit([rf.lockAudit]);
    delete rf.lockAudit;
    return rf;
  }
  /* 실패 카운트 저장만 하고 USER_LOCKED 감사 항목은 돌려준다 (verifySigner 가 ESIGN_AUTH_FAIL 뒤에 한 번에 기록) */
  /* opts.anyUser — 칭량 서명 모드(입력 ID 기준, 칭량 설계 §11 Q4 · C2): 현재 사용자가 아니어도 입력 ID 계정에 +1 */
  function recordFailCore(id, ctx, opts) {
    ctx = ctx || {};
    id = normId(id);
    if (!id || (!(opts && opts.anyUser) && id !== getCurrentUserId())) return { failCount: null, locked: false, ignored: true };
    var o = loadStore(), u = findUser(o, id);
    if (!u) return { failCount: null, locked: false, ignored: true };
    u.failCount = (u.failCount || 0) + 1;
    var lockedNow = false;
    if (u.failCount >= MAX_FAIL && u.status !== 'locked') { u.status = 'locked'; u.lockedAt = nowIsoLocal(); lockedNow = true; }
    /* 잠금 상태가 실제로 저장된 뒤에만 USER_LOCKED 감사. 저장 실패 시 카운트·잠금 모두 미반영 (판정은 거부 유지) */
    try { saveStore(o); } catch (e) { return { failCount: u.failCount - 1, locked: false, saveError: true }; }
    var en = null;
    if (lockedNow) {
      en = { uid: u.userId, act: 'USER_LOCKED', tgt: u.userId, val: '인증 실패 ' + u.failCount + '/' + MAX_FAIL + ' — 계정 잠금', why: 'bad_password',
             before: { status: 'active' }, after: { status: 'locked', lockedAt: u.lockedAt }, screen: ctx.screen };
      if (ctx.hasOrder) en.orderNo = ctx.orderNo || null;
    }
    return { failCount: u.failCount, locked: lockedNow, lockAudit: en };
  }
  function resetFail(id) {
    var o = loadStore(), u = findUser(o, id);
    if (!u || !u.failCount) return false;
    u.failCount = 0;
    try { saveStore(o); } catch (e) { return false; }
    return true;
  }

  /* ------------------------------------------------------------------ S-39 서명 규칙 (ebmr.masterSetup.v2 읽기 전용) */
  function readMasterDb() {
    var raw = readRaw(KEYS.MASTER);
    if (!raw) return null;
    try { var o = JSON.parse(raw); return (o && o.v === MASTER_VERSION && Array.isArray(o.sign)) ? o : null; } catch (e) { return null; }
  }
  function builtinRule(ruleId) { return Object.prototype.hasOwnProperty.call(BUILTIN_RULES, ruleId) ? clone(BUILTIN_RULES[ruleId]) : null; }
  /* 키 없음 · 파싱 실패 · v≠3 → 내장본(builtin) / 해당 id 행이 전혀 없음 → 시드 행 보충(backfill, 메모리만) /
     행 있음 → effective 최고 버전 그대로(master). allowedRoles 는 손대지 않는다(없거나 빈 배열이면 canSign 이 fail-closed) */
  function getSignRule(ruleId) {
    ruleId = ruleId || ISSUE_RULE_ID;
    var db = readMasterDb(), r;
    if (!db) { r = builtinRule(ruleId); if (r) { r.source = 'builtin'; r.effective = true; } return r; }
    var rows = db.sign.filter(function (x) { return x && x.id === ruleId; });
    if (!rows.length) { r = builtinRule(ruleId); if (r) { r.source = 'backfill'; r.effective = true; } return r; }
    var eff = rows.filter(function (x) { return x.status === 'effective'; }).sort(function (a, b) { return (b.ver || 0) - (a.ver || 0); })[0];
    var base = eff || rows.slice().sort(function (a, b) { return (b.ver || 0) - (a.ver || 0); })[0];
    r = clone(base);
    r.allowedRoles = eff && Array.isArray(base.allowedRoles) ? base.allowedRoles.slice() : null;
    r.source = 'master'; r.effective = !!eff;
    return r;
  }
  function ruleText(rule, kind) {
    var issue = rule && rule.id === ISSUE_RULE_ID;
    if (kind === 'unset') return issue ? MSG.allowed_roles_unset_issue
      : '허용 역할 미설정 — 서명 규칙(S-39 ' + (rule ? rule.id : '?') + ')에 허용 역할이 없어 서명할 수 없습니다. 기준정보 담당자에게 S-39 설정을 요청하세요.';
    if (issue) return MSG.role_denied_issue;
    var al = (rule.allowedRoles || []).filter(function (x) { return x !== 'ADMIN'; }).map(function (x) { return ROLE_LABEL[x] || x; });
    return '권한 없음 — 이 서명은 ' + al.join('/') + '만 할 수 있습니다.';
  }
  /* ④ 허용 역할 설정 → ⑤ 역할. 부작용 없음 */
  function canSign(id, ruleId) {
    var rule = getSignRule(ruleId || ISSUE_RULE_ID);
    var allowed = rule && rule.effective && Array.isArray(rule.allowedRoles)
      ? rule.allowedRoles.filter(function (x) { return GMP_ROLES.indexOf(x) >= 0; }) : [];
    if (!allowed.length) return { ok: false, why: 'allowed_roles_unset', rule: rule, message: ruleText(rule || { id: ruleId }, 'unset') };
    var mine = rolesOf(id);
    var inter = ROLE_PRIORITY.filter(function (x) { return x !== 'ADMIN' && mine.indexOf(x) >= 0 && allowed.indexOf(x) >= 0; });
    if (!inter.length) return { ok: false, why: 'role_denied', rule: rule, message: ruleText(rule, 'denied') };
    return { ok: true, signerRole: inter[0], rule: rule };
  }
  function validateAllowedRoles(arr) {
    if (Array.isArray(arr) && arr.indexOf('ADMIN') >= 0) return '관리자(ADMIN)는 GMP 서명 역할이 아닙니다 — 허용 역할에서 빼세요.';
    if (!Array.isArray(arr) || !arr.length) return '허용 역할을 1개 이상 선택하세요.';
    var bad = arr.filter(function (x) { return GMP_ROLES.indexOf(x) < 0; });
    if (bad.length) return '알 수 없는 역할 코드입니다: ' + bad.join(', ');
    return null;
  }

  /* ------------------------------------------------------------------ 서명 판정 ① 본인 일치 → ② 계정 상태 → ③ 비밀번호 → ④ 허용 역할 설정 → ⑤ 역할 → ⑥ 동일인 → ⑦ 자격
     ⑥ 은 req.distinctFrom (userId 문자열 또는 {userId, label} 배열)이 있을 때만: 현재 사용자가 그중 하나면 거부 'same_person'
     (감사 ESIGN_ROLE_DENIED why same_person, 실패 카운트 불변). 발행 서명은 distinctFrom 을 넘기지 않으므로 기존과 같다 */
  function normDistinct(list) {
    return (Array.isArray(list) ? list : []).map(function (x) {
      return x && typeof x === 'object' ? { userId: normId(x.userId), label: x.label || '' } : { userId: normId(x), label: '' };
    }).filter(function (x) { return !!x.userId; });
  }
  function verifySigner(req) {
    req = req || {};
    var ctx = req.ctx || {}, ruleId = req.signRuleId || ISSUE_RULE_ID;
    var inputRaw = String(req.userId == null ? '' : req.userId).trim(), inputId = normId(inputRaw);
    var pw = req.password == null ? '' : String(req.password);
    if (!inputId || !pw) {
      var miss = [!inputId ? 'ID' : '', !pw ? '비밀번호' : ''].filter(Boolean).join(' · ');
      return { ok: false, stage: 'guard', why: 'empty_input', message: '남은 요소: ' + miss, clearPassword: false, closeDialog: false, locked: false, maxFail: MAX_FAIL };
    }
    /* signerMode 'entered' (칭량 서명, 설계 §11 Q4): 서명자 = 서명 창에 입력한 ID. 현재 사용자 선택과 무관하고(없어도 됨),
       ① 은 '등록된 ID 인가', ③ 실패 카운트는 입력 ID 계정, ⑥ 동일인도 입력 ID 로 판정. 기본('current')은 발행 서명 기존 규칙 그대로 */
    var entered = req.signerMode === 'entered';
    var browserId = getCurrentUserId();
    var curId = entered ? inputId : browserId, cur = curId ? getUserRaw(curId) : null;
    function entry(act, why, val) {
      var e = { uid: inputRaw, act: act, why: why, tgt: ctx.tgt || '', val: val || ctx.val || '', screen: ctx.screen };
      if (ctx.hasOrder !== undefined) e.orderNo = ctx.orderNo || null;
      if (entered) { e.signerMode = 'entered'; e.currentUserId = browserId || ''; }
      return withStruct(e, ctx.struct);
    }
    function audit(act, why, val) { return tryAudit([entry(act, why, val)]); }
    function reject(why, message, extra) {
      var r = { ok: false, stage: 'verify', why: why, message: message, failCount: cur ? (cur.failCount || 0) : null, maxFail: MAX_FAIL,
                locked: false, clearPassword: true, closeDialog: false };
      if (extra) Object.keys(extra).forEach(function (k) { r[k] = extra[k]; });
      return r;
    }
    /* ① 본인 일치 — 다른 사람 ID · 미등록 ID · 현재 사용자 없음. 비밀번호 미검사, 카운트 불변 */
    if (entered && !cur) {
      var a0 = audit('ESIGN_ROLE_DENIED', 'unknown_user');
      return reject('unknown_user', MSG.unknown_user, a0 ? null : { auditError: true });
    }
    if (!cur || inputId !== curId) {
      var a1 = audit('ESIGN_ROLE_DENIED', 'not_current_user');
      return reject('not_current_user', MSG.not_current_user, a1 ? null : { auditError: true });
    }
    /* ② 계정 상태 — 카운트 불변 */
    if (cur.status !== 'active') {
      var w2 = cur.status === 'locked' ? 'locked' : 'inactive';
      var a2 = audit('ESIGN_AUTH_FAIL', w2);
      return reject(w2, w2 === 'locked' ? MSG.locked : MSG.inactive, a2 ? null : { auditError: true });
    }
    /* ③ 비밀번호 — 현재 사용자 본인만 +1, 5회째 잠금 */
    if (!verifyPassword(curId, pw)) {
      var n = (cur.failCount || 0) + 1;
      /* 카운트를 먼저 저장해 감사에는 실제 저장된 횟수를 쓴다. 저장 실패면 횟수 대신 '실패 횟수 저장 실패'.
         감사 순서는 ESIGN_AUTH_FAIL → USER_LOCKED (잠금 저장 성공 시에만, 한 번의 setItem) */
      var rf = recordFailCore(curId, ctx, { anyUser: entered });
      var fc = rf.failCount == null ? n : rf.failCount;
      var cntText = rf.saveError ? '실패 횟수 저장 실패' : '실패 ' + Math.min(fc, MAX_FAIL) + '/' + MAX_FAIL;
      var authEntries = [entry('ESIGN_AUTH_FAIL', 'bad_password', (ctx.val ? ctx.val + ' · ' : '') + cntText)];
      if (rf.lockAudit) authEntries.push(withStruct(rf.lockAudit, ctx.struct));
      var a3 = tryAudit(authEntries);
      /* 실패 횟수 저장 실패 시 "실패 0/5" 같은 잘못된 횟수 대신 저장 실패를 알린다 */
      var msg3 = rf.locked ? MSG.locked_now
        : rf.saveError ? '인증 실패 — 실패 횟수를 저장하지 못했습니다. 잠시 후 다시 시도하거나 관리자에게 문의하세요.'
        : '인증 실패 — 실패 ' + fc + '/' + MAX_FAIL + ' (5회 시 계정 잠금)';
      return reject('bad_password', msg3,
        { failCount: fc, locked: !!rf.locked, closeDialog: !!rf.locked, auditError: a3 ? undefined : true, saveError: rf.saveError ? true : undefined });
    }
    resetFail(curId);
    /* ④ 허용 역할 설정 → ⑤ 역할 — 카운트 불변 */
    var cs = canSign(curId, ruleId);
    if (!cs.ok) {
      var a4 = audit('ESIGN_ROLE_DENIED', cs.why);
      var rj = reject(cs.why, cs.message, a4 ? null : { auditError: true });
      rj.failCount = 0;
      return rj;
    }
    /* ⑥ 동일인 — 카운트 불변 */
    var dup = normDistinct(req.distinctFrom).filter(function (x) { return x.userId === curId; })[0];
    if (dup) {
      var a6 = audit('ESIGN_ROLE_DENIED', 'same_person');
      var r6 = reject('same_person', samePersonMessage(dup.label, dup.userId, entered ? 'entered' : ''), a6 ? { sameAs: dup.userId } : { sameAs: dup.userId, auditError: true });
      r6.failCount = 0;
      return r6;
    }
    /* ⑦ 자격 (교육 · 자격 설계 §5.2) — targets = 'SIGN:'+규칙 + ctx.qualTargets (AND · 중복 제거), at = 지금 고정.
       EbrQual 미로드 · 예외 = qual_store_error 차단. 차단은 카운트 불변 · ESIGN_QUAL_DENIED, 경고는 qualWarn (감사 QUAL_GATE_WARN 은 커밋 묶음) */
    var at7 = nowIsoLocal();   /* ⑦ 판정 시각 = 커밋 단계 at (호출자 commit 이 v.at 을 그대로 씀) */
    var q7 = qualGate(curId, ruleId, ctx.qualTargets, at7);
    if (q7.result === 'blocked') {
      var it7 = q7.items[0] || { code: 'qual_store_error', message: '' };
      var a7 = audit('ESIGN_QUAL_DENIED', it7.code, (ctx.val ? ctx.val + ' · ' : '') + (it7.target || '') + (it7.qualId ? ' ' + it7.qualId : ''));
      var r7 = reject(it7.code, it7.message || it7.code, { qualItems: q7.items });
      if (!a7) r7.auditError = true;
      r7.failCount = 0;
      return r7;
    }
    var okRes = { ok: true, user: getUser(curId), signerRole: cs.signerRole, rule: cs.rule, at: at7 };
    if (q7.result === 'warn') okRes.qualWarn = q7.items;
    return okRes;
  }
  function qualGate(userId, ruleId, extra, at) {
    var Q = global.EbrQual, targets = uniq(['SIGN:' + ruleId].concat(Array.isArray(extra) ? extra : []));
    var storeErr = { result: 'blocked', items: [{ target: null, qualId: null, code: 'qual_store_error', expiresAt: null, daysLeft: null, mode: 'block',
                                                  message: '자격 정보를 읽지 못해 서명할 수 없습니다 — 관리자에게 문의하세요.' }] };
    if (!Q || typeof Q.checkQualification !== 'function') return storeErr;
    try {
      var r = Q.checkQualification({ userId: userId, targets: targets, at: at });
      return r && (r.result === 'ok' || r.result === 'warn' || r.result === 'blocked') && Array.isArray(r.items) ? r : storeErr;
    } catch (e) { return storeErr; }
  }
  /* ⑦ 경고 → 커밋 단계 감사 묶음에 넣을 QUAL_GATE_WARN 항목 */
  function qualWarnAudits(v, base, struct) {
    return (v.qualWarn || []).map(function (it) {
      var e = { uid: base.uid, act: 'QUAL_GATE_WARN', tgt: it.target || '', why: it.code, val: (it.qualId || '') + ' · ' + it.code + (it.daysLeft != null ? ' D-' + it.daysLeft : ''),
                orderNo: base.orderNo, screen: base.screen, at: base.at };
      return withStruct(e, struct);
    });
  }

  /* ------------------------------------------------------------------ 서명 레코드 ebr.esign.v1 */
  /* ------------------------------------------------------------------ 서명 무효화 기록 ebr.esignVoid.v1 (실행 · 출하 서명 D1-13 개정)
     { v:1, items:[{ seq, voidId, signatureId, signRuleId, signerId, batchId, at, by, byName, reason, prevHash, hash }] } — 추가만, hash = sha256(stableStringify(항목 − hash)), prevHash = 앞 항목 hash (사슬).
     대조(voidState): 사슬 · 순번 · 해시가 깨지면 intact false → 모든 서명 tampered (전체 fail-closed).
     서명별: 기록 있음 · 감사(ESIGN_INVALIDATED, tgt = signatureId) 없음 / 감사 있음 · 기록 없음 / 기록 ≠ 감사(after.voidId · after.hash) / 중복 기록 → 그 서명 tampered.
     서명 레코드: 무효 기록이 있는데 status 'valid' → tampered, 무효 기록 없이 status ≠ 'valid' → tampered. */
  function voidHash(r) { var b = clone(r); delete b.hash; return sha256Hex(stableStringify(b)); }
  function voidState() {
    var raw = readRaw(KEYS.ESIGN_VOID), items = [], intact = true, mm = [], bySig = {};
    if (raw != null) {
      var o = null; try { o = JSON.parse(raw); } catch (e) { o = null; }
      if (o && Array.isArray(o.items)) items = o.items; else { intact = false; mm.push('void_store_unreadable'); }
    }
    var prev = '';
    items.forEach(function (r, i) {
      if (!r || typeof r !== 'object' || r.seq !== i + 1 || (r.prevHash || '') !== prev || r.hash !== voidHash(r)) { intact = false; mm.push('void_chain:' + (r && r.voidId ? r.voidId : '#' + (i + 1))); }
      prev = r && r.hash ? r.hash : '';
    });
    function ent(sid) { return bySig[sid] || (bySig[sid] = { record: null, audit: null, mismatches: [] }); }
    items.forEach(function (r) { if (!r || !r.signatureId) return; var e = ent(r.signatureId); if (e.record) e.mismatches.push('void_duplicate'); else e.record = r; });
    readArr(KEYS.AUDIT).forEach(function (a) {
      if (!a || a.act !== 'ESIGN_INVALIDATED') return;
      if (!a.tgt) { intact = false; mm.push('audit_without_target'); return; }
      var e = ent(a.tgt); if (e.audit) e.mismatches.push('audit_duplicate'); else e.audit = a;
    });
    Object.keys(bySig).forEach(function (sid) {
      var e = bySig[sid];
      if (e.record && !e.audit) e.mismatches.push('void_without_audit');
      if (e.audit && !e.record) e.mismatches.push('audit_without_void');
      if (e.record && e.audit) { var af = e.audit.after || {}; if (af.voidId !== e.record.voidId || af.hash !== e.record.hash) e.mismatches.push('void_audit_mismatch'); }
    });
    return { intact: intact, mismatches: mm, bySig: bySig, count: items.length };
  }
  function validity(sig) {
    if (!sig) return { state: 'missing', mismatches: ['no_signature'], voidRecord: null };
    var mm = [], body = clone(sig); delete body.signatureHash;
    if (sig.status !== 'valid') { body.status = 'valid'; delete body.voidId; delete body.invalidation; }   /* 서명 당시 본문 */
    if (sha256Hex(stableStringify(body)) !== sig.signatureHash) mm.push('signatureHash');
    var vs = voidState(), e = vs.bySig[sig.signatureId];
    if (!vs.intact) mm.push('void_store_integrity');
    if (e) { mm = mm.concat(e.mismatches); if (sig.status === 'valid') mm.push('valid_while_voided'); if (e.record && sig.voidId && sig.voidId !== e.record.voidId) mm.push('void_ref_mismatch'); }
    else if (sig.status !== 'valid') mm.push('invalid_without_void');
    return { state: mm.length ? 'tampered' : (e ? 'void' : 'valid'), mismatches: mm, voidRecord: e && e.record ? clone(e.record) : null };
  }

  var ESign = {
    KEY: KEYS.ESIGN,
    list: function (f) {
      f = f || {};
      return readArr(KEYS.ESIGN).filter(function (s) { return (!f.batchId || s.batchId === f.batchId) && (!f.signerId || s.signerId === f.signerId); }).map(clone);
    },
    /* 서명 레코드 무결성 + 무효화 대조 + (선택) 발행 레코드와의 연결(§11.70) 확인.
       → { ok, mismatches[], voided? } — ok = 변조 없음. 정상 무효화된 서명은 ok true + voided true (유효 서명 아님 — 유효 판정은 validity) */
    verify: function (sig, batchRec) {
      if (!sig) return { ok: false, mismatches: ['no_signature'] };
      var vd = validity(sig), mm = vd.mismatches.slice();
      if (batchRec) {
        if (computeSnapshotHash(batchRec.snapshot) !== sig.snapshotHash) mm.push('snapshotHash');
        ['batchId', 'contentHash', 'processTreeId'].forEach(function (k) { if (String(batchRec[k]) !== String(sig[k])) mm.push(k); });
        if (String(batchRec.manifestId || batchRec.mf || '') !== String(sig.manifestId || '')) mm.push('manifestId');
      }
      var out = { ok: !mm.length, mismatches: mm };
      if (vd.state === 'void') out.voided = true;
      return out;
    },
    /* 유효 판정 (게이트 · 체크리스트 · 조회가 함께 쓰는 한 곳): state 'valid' | 'void'(정상 무효화) | 'tampered'(대조 불일치 — fail-closed) | 'missing' */
    validity: function (sigOrId) { return validity(typeof sigOrId === 'string' ? ESign.get(sigOrId) : sigOrId); },
    /* 무효화 기록 대조 결과 { intact, mismatches[], bySig:{sigId:{record, audit, mismatches[]}} } */
    voidState: function () { return clone(voidState()); },
    voidOf: function (sigId) { var e = voidState().bySig[sigId]; return e && e.record ? clone(e.record) : null; },
    get: function (id) { var s = readArr(KEYS.ESIGN).filter(function (x) { return x.signatureId === id; })[0]; return s ? clone(s) : null; }
  };

  /* ------------------------------------------------------------------ 서명 무효화 (실행 · 출하 서명 D1-13 개정)
     voidSignature({ signatureId, reason, password, screen? }) — 현재 사용자 본인 · QA · 활성 계정 · 비밀번호 재입력(verifyPassword, 저장 안 함) · 사유 1–200자.
     비밀번호 틀림 → recordFail(본인) · 감사 ESIGN_VOID_AUTH_FAIL · 5회째 잠금. 성공 → resetFail.
     무효 기록 추가 + 서명 레코드 status 'invalid'(+ voidId) + 감사 ESIGN_INVALIDATED(after.voidId · after.hash) — 하나라도 저장 실패하면 셋 다 원복.
     → { ok:true, voidRecord, signature } | { ok:false, why, message, failCount?, locked? } */
  var VOID_REASON_MAX = 200;
  var VOID_MSG = {
    no_current_user: '로그인한 사용자가 없습니다.', not_qa: '서명 무효화는 QA 만 할 수 있습니다.', account_inactive: '계정이 활성 상태가 아닙니다.',
    reason_required: '무효화 사유를 입력하세요.', reason_too_long: '무효화 사유는 200자 이하로 입력하세요.', password_required: '비밀번호를 다시 입력하세요.',
    bad_password: '비밀번호가 올바르지 않습니다.', locked: '인증 실패가 반복되어 계정이 잠겼습니다.', no_signature: '서명을 찾을 수 없습니다.',
    already_void: '이미 무효화된 서명입니다.', sig_tampered: '서명 또는 무효화 기록의 대조가 맞지 않아 처리할 수 없습니다.',
    void_store_integrity: '무효화 기록이 손상되어 처리할 수 없습니다.', save_error: '무효화 저장에 실패했습니다 — 바뀌지 않았습니다.'
  };
  function voidFail(why, extra) { var r = { ok: false, why: why, message: VOID_MSG[why] || why }; if (extra) Object.keys(extra).forEach(function (k) { r[k] = extra[k]; }); return r; }
  function voidSignature(req) {
    req = req || {};
    var uid = getCurrentUserId(), u = uid ? getUser(uid) : null;
    if (!u) return voidFail('no_current_user');
    if (rolesOf(uid).indexOf('QA') < 0) return voidFail('not_qa');
    if (u.status && u.status !== 'active') return voidFail(u.status === 'locked' ? 'locked' : 'account_inactive');
    var reason = String(req.reason == null ? '' : req.reason).trim();
    if (!reason) return voidFail('reason_required');
    if (Array.from(reason).length > VOID_REASON_MAX) return voidFail('reason_too_long');
    var sid = String(req.signatureId || ''), sig = ESign.get(sid);
    if (!sig) return voidFail('no_signature');
    var vd = validity(sig);
    if (vd.state === 'void') return voidFail('already_void');
    if (vd.state !== 'valid') return voidFail(vd.mismatches.indexOf('void_store_integrity') >= 0 ? 'void_store_integrity' : 'sig_tampered', { mismatches: vd.mismatches });
    var pw = req.password == null ? '' : String(req.password);
    if (!pw) return voidFail('password_required');
    if (!verifyPassword(uid, pw)) {
      var rf = recordFailCore(uid, { screen: req.screen });
      var en = [{ uid: uid, act: 'ESIGN_VOID_AUTH_FAIL', tgt: sid, val: '무효화 재인증 실패 ' + (rf.failCount || 0) + '/' + MAX_FAIL, why: 'bad_password', screen: req.screen }];
      if (rf.lockAudit) en.push(rf.lockAudit);
      tryAudit(en);
      return voidFail(rf.locked ? 'locked' : 'bad_password', { failCount: rf.failCount, locked: !!rf.locked, maxFail: MAX_FAIL });
    }
    resetFail(uid);
    var vs = voidState(), items = [];
    if (!vs.intact) return voidFail('void_store_integrity');
    var vraw = readRaw(KEYS.ESIGN_VOID), eraw = readRaw(KEYS.ESIGN), araw = readRaw(KEYS.AUDIT);
    if (vraw != null) items = JSON.parse(vraw).items.slice();
    var at = nowIsoLocal(), prev = items.length ? items[items.length - 1].hash : '';
    var rec = { seq: items.length + 1, voidId: nextSeq(items, 'EV-' + ymdOf(at) + '-', 'voidId', 4), signatureId: sid, signRuleId: sig.signRuleId || null,
                signerId: sig.signerId || null, batchId: sig.batchId || null, at: at, by: uid, byName: u.name || '', reason: reason, prevHash: prev };
    rec.hash = voidHash(rec);
    items.push(rec);
    var list = readArr(KEYS.ESIGN).slice(), out = null;
    list = list.map(function (x) { if (x && x.signatureId === sid) { x = clone(x); x.status = 'invalid'; x.voidId = rec.voidId; out = x; } return x; });
    try {
      writeJson(KEYS.ESIGN_VOID, { v: 1, items: items }, 'void');
      writeJson(KEYS.ESIGN, list, 'esign');
      appendAudit([{ uid: uid, act: 'ESIGN_INVALIDATED', tgt: sid, val: (sig.signRuleId || '') + ' · ' + (sig.signerId || '') + ' · ' + reason, why: reason,
                     before: { status: 'valid' }, after: { status: 'invalid', voidId: rec.voidId, hash: rec.hash },
                     batchId: sig.batchId || null, signRuleId: sig.signRuleId || null, recordType: sig.recordType || null, screen: req.screen }], 'audit');
    } catch (e) {
      restoreRaw(KEYS.ESIGN_VOID, vraw); restoreRaw(KEYS.ESIGN, eraw); restoreRaw(KEYS.AUDIT, araw);
      return voidFail('save_error');
    }
    return { ok: true, voidRecord: clone(rec), signature: clone(out) };
  }

  /* ------------------------------------------------------------------ 발행 서명 트랜잭션 (UI-03) */
  var tickets = {}, ticketSeq = 0;
  function guard(why, message, extra) {
    var r = { ok: false, stage: 'guard', why: why, message: message, closeDialog: false, clearPassword: false, locked: false, maxFail: MAX_FAIL };
    if (extra) Object.keys(extra).forEach(function (k) { r[k] = extra[k]; });
    return r;
  }
  function gcmMeaning() {
    try {
      var o = JSON.parse(readRaw(KEYS.MASTER) || 'null');
      var rows = o && o.gcmData && o.gcmData.EBR_SIGN_MEANING, r = rows && rows.filter(function (x) { return x.key1 === 'approved'; })[0];
      return r ? { color: r.data1 || MEANING_COLOR, en: r.data2 || MEANING_EN } : { color: MEANING_COLOR, en: MEANING_EN };
    } catch (e) { return { color: MEANING_COLOR, en: MEANING_EN }; }
  }
  function gcmMeaningOf(meaning) {
    var d = MEANING_DEFAULT[meaning] || { color: null, en: '', ko: meaning || '' };
    try {
      var o = JSON.parse(readRaw(KEYS.MASTER) || 'null');
      var rows = o && o.gcmData && o.gcmData.EBR_SIGN_MEANING, r = rows && rows.filter(function (x) { return x.key1 === meaning; })[0];
      return r ? { color: r.data1 || d.color, en: r.data2 || d.en, ko: d.ko } : d;
    } catch (e) { return d; }
  }
  function orderPinOf(order) {
    if (!order) return null;
    var id = order.processTreeId || order.mbrId || '', ver = order.ver || order.mbrVer || '', hash = order.contentHash || '';
    if (!id || !ver || !hash) return null;
    return { processTreeId: String(id), ver: String(ver), contentHash: String(hash) };
  }
  function findOrderIn(rows, orderNo) {
    var key = normId(orderNo);
    for (var i = 0; i < rows.length; i++) if (rows[i] && normId(rows[i].orderNo) === key) return rows[i];
    return null;
  }
  function beginIssueSign(batchRec, opts) {
    opts = opts || {};
    var cur = getCurrentUser();
    if (!cur) return guard('no_current_user', MSG.no_current_user);
    var miss = [];
    if (!batchRec || typeof batchRec !== 'object') miss.push('batchRec');
    else {
      if (!batchRec.batchId) miss.push('batchId');
      if (!batchRec.processTreeId) miss.push('processTreeId');
      if (batchRec.ver == null || batchRec.ver === '') miss.push('ver');
      if (!batchRec.contentHash) miss.push('contentHash');
      if (!batchRec.snapshot || typeof batchRec.snapshot !== 'object') miss.push('snapshot');
    }
    if (miss.length) return guard('bad_input', '발행 레코드 필수 항목 누락: ' + miss.join(', '), { missing: miss });
    var rec = clone(batchRec), snapshotHash = computeSnapshotHash(rec.snapshot);
    var orderNo = rec.orderNo ? String(rec.orderNo) : null, rule = getSignRule(ISSUE_RULE_ID), gm = gcmMeaning();
    var tgt = rec.batchId + (orderNo ? ' · ' + orderNo : '');
    var val = rec.processTreeId + ' v' + rec.ver + ' · contentHash ' + rec.contentHash + ' · snapshotHash ' + snapshotHash;
    var sc = canSign(cur.userId, ISSUE_RULE_ID);
    var target = {
      batchId: rec.batchId, orderNo: orderNo, size: rec.size == null ? null : rec.size, line: rec.line || '', manifestId: rec.manifestId || rec.mf || '',
      processTreeId: rec.processTreeId, ver: rec.ver, contentHash: rec.contentHash, snapshotHash: snapshotHash,
      manifestObjectCount: opts.manifestObjectCount == null ? null : opts.manifestObjectCount,
      meaning: 'approved', meaningText: '발행 승인', meaningTextEn: gm.en, meaningColor: gm.color,
      recordType: 'batch_issue', recordTypeText: '배치 발행', authStrength: 'full_factor', authText: '전 요소(ID + 비밀번호)',
      meaningLabel: '발행 승인', recordTypeLabel: '배치 발행', authLabel: '전 요소(ID + 비밀번호)',   /* DEV4 표시용 별칭 */
      statement: signStatement('batch_issue', rec),   /* 서명 창 문장 = 서명 레코드 statement (커밋 때 그대로 저장) */
      rule: rule ? { id: rule.id, ver: rule.ver, allowedRoles: rule.allowedRoles, source: rule.source } : null,
      signer: cur, signerCheck: { ok: sc.ok, why: sc.why || '', signerRole: sc.signerRole || '', message: sc.message || '' }
    };
    var screen = opts.screen || screenName();
    var struct = { batchId: rec.batchId, signRuleId: ISSUE_RULE_ID, recordType: 'batch_issue' };   /* D1-8 */
    /* 서명 창 열기 전 대조: 발행 기준 트리(ebmr.processTree.v1 같은 id·ver)의 현재 contentHash 가 서명할 해시와 다르면
       (화면을 연 뒤 다른 탭에서 트리 변경 등) 창을 열지 않는다. 커밋 직전 snapshot_changed 와 같은 결과·감사 형태.
       LS 에 원본 트리가 없는 발행(데모 폴백 · 미저장 시드)은 livePin=null → 지금처럼 통과 */
    var livePin = livePinOf(rec);
    if (livePin && livePin.contentHash !== String(rec.contentHash)) {
      var ok0 = tryAudit([withStruct({ uid: cur.userId, act: 'ISSUE_ROLLBACK', why: 'precheck_changed', detail: 'snapshot_changed', tgt: tgt,
                            val: val + ' · snapshot_changed (content_changed) · 서명 창 열기 전', orderNo: orderNo, screen: screen }, struct)]);
      var r0 = { ok: false, stage: 'precheck', why: 'precheck_changed', detail: 'snapshot_changed', reason: 'content_changed', message: MSG.precheck_snapshot_begin,
                 closeDialog: true, clearPassword: true, locked: false, maxFail: MAX_FAIL };
      if (!ok0) r0.auditError = true;
      return r0;
    }
    var id = 'IST-' + Date.now().toString(36) + '-' + (++ticketSeq);
    var en = withStruct({ uid: cur.userId, act: 'ISSUE_SIGN_OPEN', tgt: tgt, val: val, orderNo: orderNo, screen: screen }, struct);
    if (!tryAudit([en])) return guard('save_error', MSG.audit_error);
    tickets[id] = { id: id, kind: 'issue', open: true, rec: rec, snapshotHash: snapshotHash, orderNo: orderNo, tgt: tgt, val: val, screen: screen, openedBy: cur.userId, meaningEn: gm.en,
                    livePin: livePin, struct: struct, statement: target.statement };
    return { ok: true, ticket: id, target: clone(target) };
  }
  /* 발행 기준 프로세스 트리의 현재 상태 (ebmr.processTree.v1, 읽기 전용).
     process-tree 발행이고 LS 에 같은 id·ver 트리가 있을 때만 값이 있다. 데모 폴백 행 · LS 미저장 시드 트리는 null (재검사 대상 아님) */
  function findLiveTree(id, ver) {
    var o = readJson(KEYS.PROCESS_TREE, null);
    if (!o || typeof o !== 'object') return null;
    var list = Array.isArray(o.trees) ? o.trees : [o];
    for (var i = 0; i < list.length; i++) {
      var tr = list[i];
      if (tr && String(tr.id) === String(id) && String(tr.ver) === String(ver)) return tr;
    }
    return null;
  }
  function treeHashOf(tr) {
    if (tr.contentHash) return String(tr.contentHash);
    var TD = global.TreeDesigner;
    try { return TD && TD.computeContentHash ? String(TD.computeContentHash(tr)) : ''; } catch (e) { return ''; }
  }
  function livePinOf(rec) {
    var kind = (rec.snapshot && rec.snapshot.kind) || rec.source || '';
    if (kind !== 'process-tree') return null;
    var tr = findLiveTree(rec.processTreeId, rec.ver);
    return tr ? { processTreeId: String(tr.id), ver: String(tr.ver), contentHash: treeHashOf(tr), status: String(tr.status || '').toLowerCase() } : null;
  }
  function closeTicket(t) { if (t) { t.open = false; delete tickets[t.id]; } }
  /* opts.why: 'cancel'(기본 · 취소/X/Esc) | 'error'(화면 오류로 닫힘, opts.message → detail.message). 그 외 값은 'cancel' */
  var CANCEL_MSG_MAX = 200;
  function safeCancelMessage(m) {
    var s = String(m == null ? '' : m).replace(/((?:password|passwd|pw|비밀번호)\s*[:=]\s*)\S+/gi, '$1***');
    return s.length > CANCEL_MSG_MAX ? s.slice(0, CANCEL_MSG_MAX - 1) + '…' : s;
  }
  function cancelIssueSign(ticket, opts) {
    opts = opts || {};
    var t = tickets[ticket];
    if (!t || !t.open || t.kind === 'record') return { ok: true, logged: false };
    closeTicket(t);
    var why = opts.why === 'error' ? 'error' : 'cancel';
    var en = withStruct({ uid: getCurrentUserId() || t.openedBy, act: 'ISSUE_SIGN_CANCEL', why: why, tgt: t.tgt, val: t.val, orderNo: t.orderNo, screen: t.screen }, t.struct);
    if (why === 'error') en.detail = { message: safeCancelMessage(opts.message) };
    var ok = tryAudit([en]);
    return ok ? { ok: true, logged: true, why: why } : { ok: false, logged: false, why: why, auditError: true, message: MSG.audit_error };
  }
  /* 커밋 직전 재검사 (기획 §5-5).
     snapshot_changed: 서명 창을 연 뒤 발행 기준 프로세스 트리(ebmr.processTree.v1 의 같은 id·ver)가 사라졌거나 effective 가 아니거나
     contentHash 가 바뀌면 거부. ticket 의 rec 은 begin 시점 깊은 복사본이라 그 자체 해시 재계산은 의미가 없어 쓰지 않는다.
     LS 에 트리가 없던 발행(데모 폴백 · 미저장 시드)은 살아 있는 원본이 없으므로 이 검사를 건너뛴다 — 오더 연동은 pin_changed, 중복은 batch_exists 가 막는다 */
  function precheck(t) {
    if (t.livePin) {
      var tr = findLiveTree(t.livePin.processTreeId, t.livePin.ver);
      var reason = !tr ? 'tree_missing' : String(tr.status || '').toLowerCase() !== 'effective' ? 'not_effective' : treeHashOf(tr) !== t.livePin.contentHash ? 'content_changed' : '';
      if (reason) return { detail: 'snapshot_changed', reason: reason, message: MSG.precheck_snapshot };
    }
    if (t.orderNo) {
      var rows = readArr(KEYS.ORDER), o = findOrderIn(rows, t.orderNo);
      if (!o) return { detail: 'order_missing', message: MSG.precheck_order };
      if (o.batchNo) return { detail: 'order_has_batch', message: MSG.precheck_order };
      if (o.status !== 'released') return { detail: 'order_status', message: MSG.precheck_order };
      var pin = orderPinOf(o);
      if (!pin || pin.processTreeId !== String(t.rec.processTreeId) || pin.ver !== String(t.rec.ver) || pin.contentHash !== String(t.rec.contentHash)) {
        return { detail: 'pin_changed', message: MSG.precheck_order };
      }
    }
    var issued = readJson(KEYS.ISSUED, []);
    if (Array.isArray(issued) && issued.some(function (b) { return b && String(b.batchId) === String(t.rec.batchId); })) return { detail: 'batch_exists', message: MSG.precheck_batch };
    return null;
  }
  function signAndCommitIssue(ticket, input) {
    input = input || {};
    var t = tickets[ticket];
    if (!t || !t.open || t.kind === 'record') return guard('ticket_closed', MSG.ticket_closed);
    var ctx = { tgt: t.tgt, val: t.val, orderNo: t.orderNo, hasOrder: true, screen: t.screen, struct: t.struct, qualTargets: ['ISSUE'] };
    var v = verifySigner({ userId: input.userId, password: input.password, signRuleId: ISSUE_RULE_ID, ctx: ctx });
    if (!v.ok) { if (v.locked) closeTicket(t); return v; }
    var pc = precheck(t);
    if (pc) {
      closeTicket(t);
      tryAudit([withStruct({ uid: v.user.userId, act: 'ISSUE_ROLLBACK', why: 'precheck_changed', detail: pc.detail, tgt: t.tgt, val: t.val + ' · ' + pc.detail + (pc.reason ? ' (' + pc.reason + ')' : ''), orderNo: t.orderNo, screen: t.screen }, t.struct)]);
      var pr = { ok: false, stage: 'precheck', why: 'precheck_changed', detail: pc.detail, message: pc.message, closeDialog: true, clearPassword: true, locked: false, maxFail: MAX_FAIL };
      if (pc.reason) pr.reason = pc.reason;
      return pr;
    }
    return commit(t, v, input.comment);
  }
  /* 커밋 (기획 §5-6). 오더 연동: issued · esign · order 3키 / 오더 없음: issued · esign 2키 (오더 키 미접근).
     감사(ESIGN_SIGNED + BATCH_ISSUED)는 마지막 단계에서 한 번의 setItem → 원자적이라 복원 대상 아님 */
  function commit(t, v, comment) {
    var hasOrder = !!t.orderNo;
    var keys = hasOrder ? [KEYS.ISSUED, KEYS.ESIGN, KEYS.ORDER] : [KEYS.ISSUED, KEYS.ESIGN];
    var orig = {}; keys.forEach(function (k) { orig[k] = readRaw(k); });
    var stage = 'issued', sig, rec, orderAfter = null, before = null, after = null, signer = v.user;
    try {
      var at = v.at || nowIsoLocal(), esignList = readArr(KEYS.ESIGN).slice();
      sig = {
        signatureId: nextSeq(esignList, 'ES-' + ymdOf(at) + '-', 'signatureId', 4),
        signerId: signer.userId, signerName: signer.name, signerRole: v.signerRole,
        meaning: 'approved', meaningText: '발행 승인', meaningTextEn: t.meaningEn,
        signRuleId: v.rule.id, signRuleVer: v.rule.ver, authStrength: v.rule.auth || 'full_factor', authMethod: signer.authMethod || 'AM-IDPW',
        signedAt: at, tz: tzName(), recordType: 'batch_issue',
        batchId: t.rec.batchId, orderNo: t.orderNo, manifestId: t.rec.manifestId || t.rec.mf || '',
        processTreeId: t.rec.processTreeId, ver: t.rec.ver, contentHash: t.rec.contentHash, snapshotHash: t.snapshotHash,
        comment: String(comment == null ? '' : comment).trim(), status: 'valid'
      };
      if (t.screen) sig.screen = String(t.screen);   /* 서명한 화면 (서명 내역 조회 표시용, signatureHash 대상) */
      if (t.statement) sig.statement = String(t.statement);   /* 서명 창에 보인 문장 원문 (signatureHash 대상) */
      sig.signatureHash = sha256Hex(stableStringify(sig));
      rec = clone(t.rec); rec.issueSignature = clone(sig);
      /* b. 발행 레코드 — TreeDesigner.saveIssuedBatch 와 같은 의미(배열 맨 앞) */
      stage = 'issued';
      var issued = readJson(KEYS.ISSUED, []); if (!Array.isArray(issued)) issued = [];
      issued.unshift(rec);
      writeJson(KEYS.ISSUED, issued, 'issued');
      /* c. 서명 레코드 */
      stage = 'esign';
      esignList.push(clone(sig));
      writeJson(KEYS.ESIGN, esignList, 'esign');
      /* d. 오더 (오더 연동만) */
      if (hasOrder) {
        stage = 'order';
        var rows = readJson(KEYS.ORDER, []);
        if (!Array.isArray(rows)) throw new Error('ebr.order.v1 형식 오류');
        var o = findOrderIn(rows, t.orderNo);
        if (!o) throw new Error('오더 없음: ' + t.orderNo);
        before = { status: o.status, batchNo: o.batchNo || '' };
        o.batchNo = t.rec.batchId;
        if (o.status === 'released') o.status = 'in_progress';
        o.upd = at.slice(0, 10);
        after = { status: o.status, batchNo: o.batchNo };
        writeJson(KEYS.ORDER, rows, 'order');
        orderAfter = clone(o);
      }
      /* e. 감사 2건 (원자적 1회 쓰기) */
      stage = 'audit';
      appendAudit([
        withStruct({ uid: signer.userId, act: 'ESIGN_SIGNED', tgt: t.tgt, val: t.val + ' · ' + sig.signatureId + ' · ' + v.signerRole, orderNo: t.orderNo, screen: t.screen, at: at }, t.struct),
        { uid: signer.userId, act: 'BATCH_ISSUED', tgt: t.tgt, val: t.val + ' · ' + sig.signatureId, orderNo: t.orderNo, before: before, after: after, screen: t.screen, at: at }
      ].concat(qualWarnAudits(v, { uid: signer.userId, orderNo: t.orderNo, screen: t.screen, at: at }, t.struct)), 'audit');
    } catch (e) {
      var restored = keys.map(function (k) { return restoreRaw(k, orig[k]); }).every(Boolean);
      closeTicket(t);
      tryAudit([withStruct({ uid: signer.userId, act: 'ISSUE_ROLLBACK', why: 'save_error', detail: stage, tgt: t.tgt, val: t.val + ' · ' + stage + ' 저장 실패 → ' + keys.length + '키 복원' + (restored ? '' : ' 실패'),
                  orderNo: t.orderNo, screen: t.screen }, t.struct)]);
      return { ok: false, stage: 'commit', why: 'save_error', detail: stage, restored: restored, error: String((e && e.message) || e),
               message: MSG.save_error, closeDialog: true, clearPassword: true, locked: false, maxFail: MAX_FAIL };
    }
    closeTicket(t);
    var okIssue = { ok: true, batchRec: rec, signature: clone(sig), order: orderAfter, closeDialog: true, clearPassword: true };
    if (v.qualWarn) okIssue.qualWarn = clone(v.qualWarn);   /* ⑦ 경고 → 화면은 성공 토스트만 (J5) */
    return okIssue;
  }
  function issueSignatureOf(batchRec) {
    if (!batchRec) return null;
    if (batchRec.issueSignature) return clone(batchRec.issueSignature);
    var l = ESign.list({ batchId: batchRec.batchId });
    return l.length ? l[l.length - 1] : null;
  }
  function formatSignLine(sig) { return sig ? '발행 승인 — ' + sig.signerName + '(' + sig.signerId + ') · ' + fmtKst(sig.signedAt) : ''; }

  /* ------------------------------------------------------------------ 레코드 서명 트랜잭션 (칭량 수행 · 확인 · 재칭량 승인 등, 발행 서명과 별개)
     beginRecordSign(spec) → { ok, ticket, target } | guard
       spec = { signRuleId*, recordType*, tgt*, val, orderNo, screen, meaningText,
                statement (서명 창 문장 원문 — 없으면 statementKind + statementCtx 로 signStatement 조립),
                statementKind, statementCtx, statementInputKeys: [서명 창 입력 중 문장에 들어가는 키 — 예: 재칭량 'voidReason'],
                fields: {서명 레코드에 그대로 넣을 연결 필드 — batchId · dispenseId · lineId · valueHash …},
                distinctFrom: [userId | {userId, label}]  (⑥ 동일인),
                signerMode: 'current'(기본, 입력 ID = 현재 사용자) | 'entered'(칭량: 서명자 = 입력 ID, 현재 사용자 없어도 됨, 실패 카운트 · ⑥ 도 입력 ID),
                target: {화면 표시용 추가 값}, keys: [커밋 때 함께 쓰는 저장 키 — 실패 시 원본 복원],
                openAct, cancelAct (기본 'RECORD_SIGN_CANCEL'), rollbackAct (기본 'RECORD_ROLLBACK'),
                requireInput(input) → null | {why, message}   (예: 폐기 사유 — 비밀번호 판정 전, 카운트·감사 없음)
                precheck() → null | {detail, message}          (커밋 직전 재검사)
                apply(sig, ctx) → { audits: [감사 항목…], result }  (spec.keys 에 직접 쓴다, 실패 시 throw) }
     signAndCommitRecord(ticket, {userId, password, comment, …}) → 판정 ①–⑥ → precheck → esign 저장 → apply → 감사(ESIGN_SIGNED + apply 감사, 1회 쓰기)
       실패 시 esign + spec.keys 원본 복원, rollbackAct 감사(why save_error, detail 단계) — 상태는 바뀌지 않는다 (칭량 결정 W3)
     cancelRecordSign(ticket, {why, message}) → cancelAct 감사 (발행 cancelIssueSign 과 같은 규칙) */
  function beginRecordSign(spec) {
    spec = spec || {};
    var entered = spec.signerMode === 'entered';
    var cur = getCurrentUser();
    if (!cur && !entered) return guard('no_current_user', MSG.no_current_user);
    var miss = ['signRuleId', 'recordType', 'tgt'].filter(function (k) { return !spec[k]; });
    if (typeof spec.apply !== 'function') miss.push('apply');
    if (miss.length) return guard('bad_input', '서명 요청 필수 항목 누락: ' + miss.join(', '), { missing: miss });
    if (spec.qualTargets != null && !Array.isArray(spec.qualTargets)) return guard('bad_input', '서명 요청 qualTargets 는 배열이어야 합니다.', { missing: ['qualTargets'] });
    var rule = getSignRule(spec.signRuleId), meaning = (rule && rule.meaning) || spec.meaning || '', gm = gcmMeaningOf(meaning);
    var sc = cur ? canSign(cur.userId, spec.signRuleId) : { ok: false, why: 'no_current_user', message: '' }, distinct = normDistinct(spec.distinctFrom);
    var screen = spec.screen || screenName(), orderNo = spec.orderNo ? String(spec.orderNo) : null;
    var authStrength = (rule && rule.auth) || 'full_factor';
    var stmt0 = spec.statement ? String(spec.statement) : (spec.statementKind ? signStatement(spec.statementKind, spec.statementCtx) : '');
    var target = {
      signRuleId: spec.signRuleId, recordType: spec.recordType, meaning: meaning, meaningText: spec.meaningText || gm.ko, meaningTextEn: gm.en, meaningColor: gm.color,
      authStrength: authStrength, authText: 'ID + 비밀번호', statement: stmt0,
      statementKind: spec.statementKind ? (STATEMENT_ALIAS[spec.statementKind] || spec.statementKind) : '', statementCtx: clone(spec.statementCtx || null),
      statementInputKeys: (spec.statementInputKeys || []).slice(),
      rule: rule ? { id: rule.id, ver: rule.ver, allowedRoles: rule.allowedRoles, source: rule.source, samePerson: rule.samePerson } : null,
      signer: cur, signerCheck: { ok: sc.ok, why: sc.why || '', signerRole: sc.signerRole || '', message: sc.message || '' },
      distinctFrom: distinct, tgt: spec.tgt, val: spec.val || '', orderNo: orderNo, fields: clone(spec.fields || {}),
      signerMode: entered ? 'entered' : 'current'
    };
    if (spec.target) Object.keys(spec.target).forEach(function (k) { target[k] = clone(spec.target[k]); });
    var sf = spec.fields || {};
    var struct = { batchId: sf.batchId || null, signRuleId: spec.signRuleId, recordType: spec.recordType, lineId: sf.lineId || null, dispenseId: sf.dispenseId || null };   /* D1-8 */
    if (spec.openAct && !tryAudit([withStruct({ uid: cur ? cur.userId : '', act: spec.openAct, tgt: spec.tgt, val: spec.val || '', orderNo: orderNo, screen: screen }, struct)])) return guard('save_error', MSG.audit_error);
    var id = 'RST-' + Date.now().toString(36) + '-' + (++ticketSeq);
    tickets[id] = { id: id, kind: 'record', open: true, spec: spec, rule: rule, meaning: meaning, meaningEn: gm.en, distinct: distinct, screen: screen, orderNo: orderNo,
                    tgt: spec.tgt, val: spec.val || '', openedBy: cur ? cur.userId : '', authStrength: authStrength, signerMode: entered ? 'entered' : 'current', struct: struct,
                    statement: stmt0, statementKind: target.statementKind, statementCtx: clone(spec.statementCtx || null), statementInputKeys: target.statementInputKeys };
    return { ok: true, ticket: id, target: clone(target) };
  }
  function cancelRecordSign(ticket, opts) {
    opts = opts || {};
    var t = tickets[ticket];
    if (!t || !t.open || t.kind !== 'record') return { ok: true, logged: false };
    closeTicket(t);
    var why = opts.why === 'error' ? 'error' : 'cancel';
    var en = withStruct({ uid: getCurrentUserId() || t.openedBy, act: t.spec.cancelAct || 'RECORD_SIGN_CANCEL', why: why, tgt: t.tgt, val: t.val, orderNo: t.orderNo, screen: t.screen }, t.struct);
    if (why === 'error') en.detail = { message: safeCancelMessage(opts.message) };
    var ok = tryAudit([en]);
    return ok ? { ok: true, logged: true, why: why } : { ok: false, logged: false, why: why, auditError: true, message: MSG.audit_error };
  }
  /* 레코드 서명 문장: begin 문장 그대로, statementInputKeys 가 있으면 서명 창 입력(예: 폐기 사유)을 넣어 같은 builder 로 다시 조립 */
  function recordStatement(t, input) {
    if (!t.statementKind || !t.statementInputKeys || !t.statementInputKeys.length) return t.statement || '';
    var c = clone(t.statementCtx || {}) || {};
    t.statementInputKeys.forEach(function (k) { if (!SECRET_KEY.test(k)) c[k] = input[k] == null ? '' : String(input[k]).trim(); });
    return signStatement(t.statementKind, c);
  }
  function signAndCommitRecord(ticket, input) {
    input = input || {};
    var t = tickets[ticket];
    if (!t || !t.open || t.kind !== 'record') return guard('ticket_closed', MSG.ticket_closed_record);
    var spec = t.spec, rbAct = spec.rollbackAct || 'RECORD_ROLLBACK';
    if (typeof spec.requireInput === 'function') {
      var ri = spec.requireInput(scrub(input));
      if (ri) return guard(ri.why || 'bad_input', ri.message || '입력을 확인하세요.');
    }
    var stmt = recordStatement(t, input);
    /* 화면이 보여 준 문장(input.statement, 선택)을 넘기면 저장할 문장과 같아야 한다 — 다르면 비밀번호 판정 전 거부(카운트 · 감사 없음) */
    if (input.statement != null && String(input.statement) !== stmt) return guard('statement_mismatch', MSG.statement_mismatch, { statement: stmt });
    var ctx = { tgt: t.tgt, val: t.val, orderNo: t.orderNo, hasOrder: true, screen: t.screen, struct: t.struct, qualTargets: (spec.qualTargets || []).slice() };
    var v = verifySigner({ userId: input.userId, password: input.password, signRuleId: spec.signRuleId, ctx: ctx, distinctFrom: t.distinct, signerMode: t.signerMode });
    if (!v.ok) { if (v.locked) closeTicket(t); return v; }
    var pc = typeof spec.precheck === 'function' ? spec.precheck() : null;
    if (pc) {
      closeTicket(t);
      tryAudit([withStruct({ uid: v.user.userId, act: rbAct, why: 'precheck_changed', detail: pc.detail || 'changed', tgt: t.tgt, val: t.val + ' · ' + (pc.detail || 'changed'), orderNo: t.orderNo, screen: t.screen }, t.struct)]);
      return { ok: false, stage: 'precheck', why: 'precheck_changed', detail: pc.detail || 'changed', message: pc.message || MSG.record_precheck,
               closeDialog: true, clearPassword: true, locked: false, maxFail: MAX_FAIL };
    }
    var keys = [KEYS.ESIGN].concat((spec.keys || []).filter(function (k) { return k && k !== KEYS.ESIGN && k !== KEYS.AUDIT; }));
    var orig = {}; keys.forEach(function (k) { orig[k] = readRaw(k); });
    var stage = 'esign', sig, applied = null, signer = v.user;
    try {
      var at = v.at || nowIsoLocal(), esignList = readArr(KEYS.ESIGN).slice();
      sig = {
        signatureId: nextSeq(esignList, 'ES-' + ymdOf(at) + '-', 'signatureId', 4),
        signerId: signer.userId, signerName: signer.name, signerRole: v.signerRole,
        meaning: t.meaning, meaningText: spec.meaningText || (MEANING_DEFAULT[t.meaning] || {}).ko || t.meaning, meaningTextEn: t.meaningEn,
        signRuleId: v.rule.id, signRuleVer: v.rule.ver, authStrength: v.rule.auth || t.authStrength, authMethod: signer.authMethod || 'AM-IDPW',
        signedAt: at, tz: tzName(), recordType: spec.recordType, orderNo: t.orderNo,
        comment: String(input.comment == null ? '' : input.comment).trim(), status: 'valid'
      };
      if (t.screen) sig.screen = String(t.screen);   /* 서명한 화면 (서명 내역 조회 표시용, signatureHash 대상) */
      if (stmt) sig.statement = stmt;   /* 서명 창에 보인 문장 원문 (signatureHash 대상) */
      if (t.signerMode === 'entered') { sig.signerMode = 'entered'; sig.currentUserId = getCurrentUserId() || ''; }
      var f = spec.fields || {};
      Object.keys(f).forEach(function (k) { if (!(k in sig) && !SECRET_KEY.test(k)) sig[k] = clone(f[k]); });
      sig.signatureHash = sha256Hex(stableStringify(sig));
      esignList.push(clone(sig));
      writeJson(KEYS.ESIGN, esignList, 'esign');
      stage = 'apply';
      applied = spec.apply(clone(sig), { input: scrub(input), at: at, signer: clone(signer), signerRole: v.signerRole }) || {};
      stage = 'audit';
      appendAudit([withStruct({ uid: signer.userId, act: 'ESIGN_SIGNED', tgt: t.tgt, val: t.val + ' · ' + sig.signatureId + ' · ' + v.signerRole, orderNo: t.orderNo, screen: t.screen, at: at,
                                signerMode: t.signerMode === 'entered' ? 'entered' : undefined }, t.struct)]
        .concat((applied.audits || []).map(function (e) { var c = clone(e); if (!c.at) c.at = at; if (c.uid == null) c.uid = signer.userId; if (!c.screen) c.screen = t.screen; return c; }))
        .concat(qualWarnAudits(v, { uid: signer.userId, orderNo: t.orderNo, screen: t.screen, at: at }, t.struct)), 'audit');
    } catch (e) {
      var restored = keys.map(function (k) { return restoreRaw(k, orig[k]); }).every(Boolean);
      closeTicket(t);
      tryAudit([withStruct({ uid: signer.userId, act: rbAct, why: 'save_error', detail: stage, tgt: t.tgt, val: t.val + ' · ' + stage + ' 저장 실패 → ' + keys.length + '키 복원' + (restored ? '' : ' 실패'),
                  orderNo: t.orderNo, screen: t.screen }, t.struct)]);
      return { ok: false, stage: 'commit', why: 'save_error', detail: stage, restored: restored, error: String((e && e.message) || e),
               message: spec.saveErrorMessage || MSG.record_save_error, closeDialog: true, clearPassword: true, locked: false, maxFail: MAX_FAIL };
    }
    closeTicket(t);
    var okRec = { ok: true, signature: clone(sig), result: applied.result === undefined ? null : clone(applied.result), closeDialog: true, clearPassword: true };
    if (v.qualWarn) okRec.qualWarn = clone(v.qualWarn);   /* ⑦ 경고 → 화면은 성공 토스트만 (J5) */
    return okRec;
  }
  /* ------------------------------------------------------------------ 서명 문장 (서명 창에 보이는 문장 = 서명 레코드 statement · signatureHash 대상)
     조립은 여기 한 곳 — 칭량 store · 발행 서명 · 서명 내역 조회(재구성)가 같이 쓴다. 문체: '본인은 …' 한글 문장 + 영문 의미 괄호
     signStatement(kind, ctx) → string ('' = 알 수 없는 kind)
       kind: 'weigh_perform' | 'weigh_verify' | 'reweigh_approve' | 'batch_issue'  (별칭 perform · verify · reweigh · issue)
       ctx : weigh_perform   { batchId, lineId, materialId, lotNo(또는 lot), dispenseId, net, uom, judge }
             weigh_verify    { batchId, lineId, dispenseId, net, uom, judge, performerName, performerId }
             reweigh_approve { batchId, lineId, dispenseId, net, uom, judge, voidReason }
             batch_issue     { processTreeId, ver, contentHash(앞 8자), batchId, size(kg) }
             balance_check   { balanceId, eqClass, date, planId, planVer, sopRef, tolPct, n, recheckOf? }
             balance_check_fail { balanceId, eqClass, date, planId, planVer, sopRef, n, failed, maxDevPct, maxDevWeightId, reason, recheckOf? }
             exec_step · exec_step_verify { batchId, opId, opName, n }      pack_step · pack_step_verify { batchId, stepNo, stepName }
             pack_label_qa { batchId }   pack_review { batchId, n }   matqc_release · matqc_legacy_confirm { lotNo, matCode }   matqc_reject { lotNo, matCode, reason }
             rbe_review { batchId, exceptionId }   batch_review { batchId, n }   audit_review { batchId, n }
             batch_release { batchId, manifestHash(앞 8자만 표시), qaProxy(true = QA 대행 꼬리) }
             mbr_review · mbr_approve { mbrId, ver, contentHash(앞 8자) }   briefing_read { batchId, opId, ccId }   (P1)
       숫자: net 은 소수 3자리(0.000), size 는 천 단위 구분 · 소수 최대 6자리. 빈 값은 '—' */
  var STATEMENT_KINDS = ['weigh_perform', 'weigh_verify', 'reweigh_approve', 'batch_issue', 'balance_check', 'balance_check_fail',
    'exec_step', 'exec_step_verify', 'pack_step', 'pack_step_verify', 'pack_label_qa', 'pack_review', 'matqc_release', 'matqc_reject', 'matqc_legacy_confirm',
    'rbe_review', 'batch_review', 'batch_release', 'audit_review', 'mbr_review', 'mbr_approve', 'briefing_read'];
  var STATEMENT_ALIAS = { perform: 'weigh_perform', verify: 'weigh_verify', reweigh: 'reweigh_approve', issue: 'batch_issue', balchk: 'balance_check', balchk_fail: 'balance_check_fail' };
  function stPct(v, signed) { var x = Number(v); if (v == null || v === '' || !isFinite(x)) return '—'; var t = Math.abs(x).toFixed(2); return signed ? (x < 0 ? '-' : '+') + t : (x < 0 ? '-' : '') + t; }
  function stTxt(v) { var s = String(v == null ? '' : v).trim(); return s || '—'; }
  function stQty(v) { var x = Number(v); return v == null || v === '' || !isFinite(x) ? '—' : x.toFixed(3); }
  function signStatement(kind, ctx) {
    var k = STATEMENT_ALIAS[kind] || kind, c = ctx || {}, uom = stTxt(c.uom);
    var head = '본인은 배치 ' + stTxt(c.batchId) + ' ' + stTxt(c.lineId);
    if (k === 'weigh_perform') {
      return head + ' ' + stTxt(c.materialId) + ' LOT ' + stTxt(c.lotNo != null ? c.lotNo : c.lot) + ' 용기 ' + stTxt(c.dispenseId) + '의 순중량 ' + stQty(c.net) + ' ' + uom +
        '(판정 ' + stTxt(c.judge) + ') 칭량을 수행했습니다. (Performed by)';
    }
    if (k === 'weigh_verify') {
      return head + ' 용기 ' + stTxt(c.dispenseId) + '의 순중량 ' + stQty(c.net) + ' ' + uom + '(판정 ' + stTxt(c.judge) + ', 수행 ' + stTxt(c.performerName) + '(' + stTxt(c.performerId) + '))을 확인했습니다. (Verified by)';
    }
    if (k === 'reweigh_approve') {
      return head + ' 용기 ' + stTxt(c.dispenseId) + '(순중량 ' + stQty(c.net) + ' ' + uom + ', 판정 ' + stTxt(c.judge) + ')를 폐기하고 같은 줄 재칭량을 승인합니다. 사유: ' + stTxt(c.voidReason) + ' (Approved by)';
    }
    if (k === 'batch_issue') {
      return '본인은 ' + stTxt(c.processTreeId) + ' v' + stTxt(c.ver) + ' (hash ' + stTxt(String(c.contentHash == null ? '' : c.contentHash).slice(0, 8)) + ') 기준으로 배치 ' + stTxt(c.batchId) +
        '(' + (c.size == null || c.size === '' ? '—' : fmtNum(c.size)) + ' kg) 발행을 승인합니다. (Approved by)';
    }
    if (k === 'balance_check' || k === 'balance_check_fail') {
      var bh = '본인은 저울 ' + stTxt(c.balanceId) + '(' + stTxt(c.eqClass) + ') ' + stTxt(c.date) + ' 일상 점검' + (c.recheckOf ? ' 재점검(원 ' + stTxt(c.recheckOf) + ')' : '') +
               '(계획 ' + stTxt(c.planId) + ' v' + stTxt(c.planVer) + ' · ' + stTxt(c.sopRef);
      if (k === 'balance_check') return bh + ' · 허용 ±' + stPct(c.tolPct, false) + ' %)을 분동 ' + stTxt(c.n) + '점 모두 합격으로 수행했습니다. (Performed by)';
      return bh + ')을 분동 ' + stTxt(c.failed) + '/' + stTxt(c.n) + '점 불합격(최대 편차 ' + stPct(c.maxDevPct, true) + ' % · ' + stTxt(c.maxDevWeightId) + ')으로 확정했습니다. 사유: ' + stTxt(c.reason) + ' (Performed by)';
    }
    var bb = '본인은 배치 ' + stTxt(c.batchId);
    if (k === 'exec_step') return bb + ' ' + stTxt(c.opId) + ' ' + stTxt(c.opName) + '의 기록 값 ' + stTxt(c.n) + '건을 수행했습니다. (Performed by)';
    if (k === 'exec_step_verify') return bb + ' ' + stTxt(c.opId) + ' ' + stTxt(c.opName) + '의 기록 값 ' + stTxt(c.n) + '건과 수행 서명을 확인했습니다. (Verified by)';
    if (k === 'pack_step') return bb + ' 포장 ' + stTxt(c.stepNo) + ' ' + stTxt(c.stepName) + '을(를) 수행했습니다. (Performed by)';
    if (k === 'pack_step_verify') return bb + ' 포장 ' + stTxt(c.stepNo) + ' ' + stTxt(c.stepName) + '을(를) 확인했습니다. (Verified by)';
    if (k === 'pack_label_qa') return bb + ' 포장 라벨 · 코딩 첫 시료를 QA로 확인했습니다. (Verified by)';
    if (k === 'pack_review') return bb + ' 포장 기록(서명 ' + stTxt(c.n) + '건)을 검토했습니다. (Reviewed by)';
    var lh = '본인은 자재 LOT ' + stTxt(c.lotNo) + ' (' + stTxt(c.matCode) + ')의 ';
    if (k === 'matqc_release') return lh + 'QC 판정 적합(released)을 승인합니다. (Approved by)';
    if (k === 'matqc_reject') return lh + 'QC 판정 부적합(rejected)을 승인합니다. 사유: ' + stTxt(c.reason) + ' (Approved by)';
    if (k === 'matqc_legacy_confirm') return lh + '기존 적합(released) 판정을 재확인하여 승인합니다. (Approved by)';
    if (k === 'rbe_review') return bb + ' RBE 예외 ' + stTxt(c.exceptionId) + '를 검토했습니다. (Reviewed by)';
    if (k === 'batch_review') return bb + '의 critical 기록 전수를 검토했습니다(미종결 일탈 0건 · 예외 ' + stTxt(c.n) + '건 검토 포함). (Reviewed by)';
    if (k === 'audit_review') return bb + '의 감사추적 ' + stTxt(c.n) + '건을 검토했습니다. (Reviewed by)';
    if (k === 'batch_release') {
      return bb + '의 출하 전제 조건 12건 평가(manifest ' + stTxt(String(c.manifestHash == null ? '' : c.manifestHash).slice(0, 8)) + ')를 확인하고 QP 인증 및 출하를 승인합니다. (Approved by)' +
        (c.qaProxy ? ' (PoC: QA 대행, QP 인증 아님)' : '');
    }
    var mh = '본인은 MBR ' + stTxt(c.mbrId) + ' v' + stTxt(c.ver) + ' (hash ' + stTxt(String(c.contentHash == null ? '' : c.contentHash).slice(0, 8)) + ')';
    if (k === 'mbr_review') return mh + '을(를) 작성자와 독립적으로 검토했습니다. (Reviewed by)';
    if (k === 'mbr_approve') return mh + '을(를) 승인합니다. (Approved by)';
    if (k === 'briefing_read') return bb + ' ' + stTxt(c.opId) + ' 변경 브리핑 ' + stTxt(c.ccId) + '을(를) 읽고 이해했습니다. (Read and understood)';
    return '';
  }
  /* 서명 레코드(또는 signRuleId) → 문장 kind ('' = 해당 없음) — 서명 내역 재구성용 */
  function statementKindOf(sigOrRule) {
    var o = typeof sigOrRule === 'string' ? { signRuleId: sigOrRule } : (sigOrRule || {});
    if (o.recordType === 'batch_issue' || o.signRuleId === ISSUE_RULE_ID) return 'batch_issue';
    if (o.signRuleId === WEIGH_RULES.PERFORM) return 'weigh_perform';
    if (o.signRuleId === WEIGH_RULES.VERIFY) return 'weigh_verify';
    if (o.signRuleId === WEIGH_RULES.REWEIGH) return 'reweigh_approve';
    if (o.signRuleId === WEIGH_RULES.BALCHK || o.signRuleId === WEIGH_RULES.BALRECHK) return o.checkResult === 'fail' ? 'balance_check_fail' : 'balance_check';
    /* 실행 · 출하 서명: 레코드에 statementKind 가 있으면 그 값(같은 규칙을 여러 지점이 씀 — 예 SM-PERF-STEP = 생산 · 포장) */
    if (o.statementKind && STATEMENT_KINDS.indexOf(o.statementKind) >= 0) return o.statementKind;
    if (o.signRuleId === EXEC_RULES.STEP_PERFORM) return o.scope === 'pack' ? 'pack_step' : 'exec_step';
    if (o.signRuleId === EXEC_RULES.STEP_VERIFY) return o.scope === 'pack' ? 'pack_step_verify' : 'exec_step_verify';
    if (o.signRuleId === EXEC_RULES.PACK_LABEL_QA) return 'pack_label_qa';
    if (o.signRuleId === EXEC_RULES.PACK_REVIEW) return 'pack_review';
    if (o.signRuleId === EXEC_RULES.MATQC) return o.matqcTo === 'rejected' ? 'matqc_reject' : (o.matqcTo === 'legacy_confirm' ? 'matqc_legacy_confirm' : 'matqc_release');
    if (o.signRuleId === EXEC_RULES.RBE) return 'rbe_review';
    if (o.signRuleId === EXEC_RULES.BATCH_REVIEW) return 'batch_review';
    if (o.signRuleId === EXEC_RULES.AUDIT_REVIEW) return 'audit_review';
    if (o.signRuleId === EXEC_RULES.RELEASE) return 'batch_release';
    if (o.signRuleId === EXEC_RULES.MBR_REVIEW) return 'mbr_review';
    if (o.signRuleId === EXEC_RULES.MBR_APPROVE) return 'mbr_approve';
    if (o.signRuleId === EXEC_RULES.BRIEFING) return 'briefing_read';
    return '';
  }
  /* 칭량 값 해시 (기획 칭량 §6) — sha256Hex(stableStringify(obj)) */
  function computeValueHash(obj) { return sha256Hex(stableStringify(obj === undefined ? null : obj)); }

  /* ------------------------------------------------------------------ 서명 내역 조회 (D1-8 · 읽기 전용, setItem 호출 없음)
     signHistory(filter) → { ok, total, rows, legacy }
       filter = { batchId, lineId, recordType, signerId, signRuleId, orderNo, result('signed'|'failed'|'locked'|'cancelled'|'rolledback' 또는 배열),
                  from, to ('YYYY-MM-DD' 은 KST 하루 단위 포함, ISO 는 그 시각), order ('desc' 기본 | 'asc'), offset, limit }
       행 = 서명 시도의 결과 1건: 성공은 ebr.esign.v1 레코드, 실패 · 잠금 · 취소 · 롤백은 감사 1건 (서명 내역 설계 §3.4 결과 분류).
       감사 행은 D1-8 구조화 필드를 먼저 쓰고, 없으면(기존 레코드) R1 · R2 · R3 추정 + estimated:[필드 이름…] */
  var HISTORY_RESULT = {
    ESIGN_AUTH_FAIL: 'failed', ESIGN_ROLE_DENIED: 'failed', USER_LOCKED: 'locked',
    ISSUE_SIGN_CANCEL: 'cancelled', DISPENSE_SIGN_CANCEL: 'cancelled', RECORD_SIGN_CANCEL: 'cancelled',
    ISSUE_ROLLBACK: 'rolledback', DISPENSE_ROLLBACK: 'rolledback', RECORD_ROLLBACK: 'rolledback', REL_ROLLBACK: 'rolledback'
  };
  function historyBound(v, end) {
    if (!v) return null;
    var str = String(v);
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) str += end ? 'T23:59:59.999+09:00' : 'T00:00:00+09:00';
    var t = Date.parse(str);
    return isNaN(t) ? null : t;
  }
  function signHistory(filter) {
    var f = filter || {};
    var uo = readJson(KEYS.USER_ROLE, null), users = uo && Array.isArray(uo.users) ? uo.users : [];
    var nameOf = function (id) { var k = normId(id); for (var i = 0; i < users.length; i++) if (normId(users[i].userId) === k) return users[i].name || ''; return ''; };
    var registered = function (id) { var k = normId(id); return users.some(function (u) { return normId(u.userId) === k; }); };
    var issued = readJson(KEYS.ISSUED, []), issuedIds = {};
    (Array.isArray(issued) ? issued : []).forEach(function (b) { if (b && b.batchId) issuedIds[String(b.batchId)] = true; });
    var rows = [], legacy = 0, auditList = readArr(KEYS.AUDIT), sigAudit = {};
    /* 같은 초 안의 순서: 서명 레코드는 짝 ESIGN_SIGNED 감사 번호로 감사 행과 같은 순번 축에 놓는다 */
    auditList.forEach(function (a) { var m = a && a.act === 'ESIGN_SIGNED' && /ES-\d{8}-\d+/.exec(String(a.val || '')); if (m && !sigAudit[m[0]]) sigAudit[m[0]] = a.auditId || ''; });
    readArr(KEYS.ESIGN).forEach(function (sg) {
      if (!sg || !sg.signatureId) return;
      rows.push({ rowId: 'S:' + sg.signatureId, source: 'esign', result: 'signed', act: null, at: sg.signedAt || '', signerId: sg.signerId || '', signerName: sg.signerName || '',
                  signerRole: sg.signerRole || '', registered: true, meaning: sg.meaning || '', meaningText: sg.meaningText || '', recordType: sg.recordType || '',
                  signRuleId: sg.signRuleId || '', signRuleVer: sg.signRuleVer == null ? null : sg.signRuleVer, batchId: sg.batchId || null, lineId: sg.lineId || null,
                  dispenseId: sg.dispenseId || null, orderNo: sg.orderNo || null, signatureId: sg.signatureId, why: '', screen: sg.screen || '', auditId: null,
                  tgt: '', val: '', signerMode: sg.signerMode || '', estimated: [], seq: sigAudit[sg.signatureId] || '' });
    });
    auditList.forEach(function (a) {
      var res = a && HISTORY_RESULT[a.act];
      if (!res) return;
      /* 코드 리뷰: DISPENSE_ROLLBACK · RECORD_ROLLBACK 은 서명 아닌 저장(전운 · 총중량 기록 등)의 실패에도 쓰인다 — signRuleId 가 있는 것(서명 커밋 롤백)만 서명 내역.
         ISSUE_ROLLBACK 은 발행 서명에서만 생기므로(R1) 기존 레코드도 그대로 */
      if ((a.act === 'DISPENSE_ROLLBACK' || a.act === 'RECORD_ROLLBACK') && !a.signRuleId) return;
      if (a.act === 'ESIGN_AUTH_FAIL' && a.why === 'locked') res = 'locked';
      var est = [], batchId = a.batchId || null, recordType = a.recordType || '', ruleId = a.signRuleId || '', batchHint = null;
      var scr = String(a.screen || '');
      if (!recordType) {
        if (/^ISSUE_/.test(a.act) || scr === 's-ebr-batch-issue-ui') { recordType = 'batch_issue'; if (!ruleId) { ruleId = ISSUE_RULE_ID; est.push('signRuleId'); } }   /* R1 */
        else if (/^DISPENSE_/.test(a.act) || /^s-ebr-dispense/.test(scr)) recordType = 'weigh_*';                                                               /* R2 (의미 구분 불가) */
        if (recordType) est.push('recordType');
      }
      if (!batchId) {                                                                                                                                         /* R3 */
        var parts = String(a.tgt || '').split(' · ').map(function (x) { return x.trim(); });
        for (var i = 0; i < parts.length; i++) if (issuedIds[parts[i]]) { batchId = parts[i]; break; }
        if (batchId) est.push('batchId'); else if (recordType === 'batch_issue' && parts[0]) batchHint = parts[0];   /* 발행 기록에 없는 배치(롤백된 발행) */
      }
      var structured = !!(a.batchId || a.recordType || a.signRuleId);
      if (!structured) legacy++;
      var rule = ruleId ? getSignRule(ruleId) : null;
      rows.push({ rowId: 'A:' + a.auditId, source: 'audit', result: res, act: a.act, at: a.at || '', signerId: a.uid || '', signerName: a.userName || nameOf(a.uid),
                  signerRole: '', registered: registered(a.uid), meaning: rule && rule.meaning ? rule.meaning : '', meaningText: '', recordType: recordType || '',
                  signRuleId: ruleId, signRuleVer: null, batchId: batchId, batchHint: batchHint, lineId: a.lineId || null, dispenseId: a.dispenseId || null,
                  orderNo: a.orderNo || null, signatureId: null, why: a.why || '', screen: scr, auditId: a.auditId || null, tgt: a.tgt || '', val: a.val || '',
                  signerMode: a.signerMode || '', structured: structured, estimated: est, seq: a.auditId || '' });
    });
    var resF = f.result == null ? null : (Array.isArray(f.result) ? f.result : [f.result]);
    var lo = historyBound(f.from, false), hi = historyBound(f.to, true);
    var out = rows.filter(function (r) {
      if (f.batchId && r.batchId !== String(f.batchId)) return false;
      if (f.lineId && r.lineId !== String(f.lineId)) return false;
      if (f.recordType && r.recordType !== String(f.recordType)) return false;
      if (f.signerId && normId(r.signerId) !== normId(f.signerId)) return false;
      if (f.signRuleId && r.signRuleId !== String(f.signRuleId)) return false;
      if (f.orderNo && r.orderNo !== String(f.orderNo)) return false;
      if (resF && resF.indexOf(r.result) < 0) return false;
      if (lo != null || hi != null) { var t = Date.parse(r.at); if (isNaN(t) || (lo != null && t < lo) || (hi != null && t > hi)) return false; }
      return true;
    });
    var asc = f.order === 'asc';
    out.sort(function (x, y) {
      var tx = Date.parse(x.at) || 0, ty = Date.parse(y.at) || 0;
      if (tx !== ty) return asc ? tx - ty : ty - tx;
      if (x.seq !== y.seq && x.seq && y.seq) return (x.seq < y.seq ? -1 : 1) * (asc ? 1 : -1);
      return asc ? (x.rowId < y.rowId ? -1 : x.rowId > y.rowId ? 1 : 0) : (x.rowId < y.rowId ? 1 : x.rowId > y.rowId ? -1 : 0);
    });
    var total = out.length, off = Math.max(0, parseInt(f.offset, 10) || 0), lim = parseInt(f.limit, 10);
    out = lim > 0 ? out.slice(off, off + lim) : out.slice(off);
    return { ok: true, total: total, rows: out.map(clone), legacy: legacy };
  }

  /* ------------------------------------------------------------------ 공개 */
  var API = {
    VERSION: 1,
    KEYS: KEYS, ROLES: ROLES.slice(), ROLE_PRIORITY: ROLE_PRIORITY.slice(), ROLE_LABEL: ROLE_LABEL, GMP_ROLES: GMP_ROLES.slice(),
    MAX_FAIL: MAX_FAIL, ISSUE_RULE_ID: ISSUE_RULE_ID, DEMO_PASSWORD: DEMO_PASSWORD, DEMO_PASSWORD_HINT: DEMO_PASSWORD_HINT, SEED_ISSUE_RULE: clone(SEED_ISSUE_RULE),
    WEIGH_RULES: clone(WEIGH_RULES), EXEC_RULES: clone(EXEC_RULES), BUILTIN_RULES: clone(BUILTIN_RULES), MEANING_DEFAULT: clone(MEANING_DEFAULT),
    /* 사용자 · 현재 사용자 */
    ensureSeed: ensureSeed, listUsers: listUsers, getUser: getUser, rolesOf: rolesOf, hasSodConflict: hasSodConflict,
    saveUser: saveUser, unlockUser: unlockUser, resetSeed: resetSeed,
    getCurrentUser: getCurrentUser, setCurrentUser: setCurrentUser, currentUserName: currentUserName, onChange: onChange, switchOptions: switchOptions,
    /* 인증 · 역할 · S-39 */
    verifyPassword: verifyPassword, recordFail: recordFail, resetFail: resetFail,
    getSignRule: getSignRule, canSign: canSign, validateAllowedRoles: validateAllowedRoles, verifySigner: verifySigner,
    /* 발행 서명 */
    beginIssueSign: beginIssueSign, signAndCommitIssue: signAndCommitIssue, cancelIssueSign: cancelIssueSign,
    computeSnapshotHash: computeSnapshotHash, issueSignatureOf: issueSignatureOf, formatSignLine: formatSignLine, fmtKst: fmtKst,
    /* 레코드 서명 (칭량 등) */
    beginRecordSign: beginRecordSign, signAndCommitRecord: signAndCommitRecord, cancelRecordSign: cancelRecordSign, computeValueHash: computeValueHash,
    signStatement: signStatement, statementKindOf: statementKindOf, STATEMENT_KINDS: STATEMENT_KINDS.slice(),
    sha256Hex: sha256Hex, stableStringify: stableStringify, getCurrentUserId: getCurrentUserId,
    /* 저장소 */
    ESign: ESign, Audit: Audit, nowIsoLocal: nowIsoLocal, voidSignature: voidSignature, VOID_REASON_MAX: VOID_REASON_MAX,
    /* 서명 내역 조회 (D1-8, 읽기 전용) */
    signHistory: signHistory, AUDIT_STRUCT_KEYS: STRUCT_KEYS.slice(),
    /* 스모크 · 테스트 전용 */
    _test: {
      failNext: function (stage) { /* 'issued'|'esign'|'order'|'audit'|'users' (레코드 서명: 'esign'|'audit') */ failNextStage = stage || null; return failNextStage; },
      seedSmokeFixtures: seedSmokeFixtures,
      openTickets: function () { return Object.keys(tickets).length; },
      sha256Hex: sha256Hex, stableStringify: stableStringify
    }
  };

  global.EbrUserSession = API;
  /* 기획 §6 제안 이름 별칭 (ebr-p0-stores.js 는 수정하지 않음) */
  if (global.EbrP0 && typeof global.EbrP0 === 'object') {
    global.EbrP0.ESign = ESign; global.EbrP0.Audit = Audit;
    global.EbrP0.ESIGN_KEY = KEYS.ESIGN; global.EbrP0.AUDIT_KEY = KEYS.AUDIT;
    global.EbrP0.UserSession = API;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
