/* =====================================================================
   ebr-qual-store.js — eBR · eMBR PoC 교육 · 자격 저장소 · 판정 (전역 EbrQual)
   - 설계: poc-training-qualification-design.md 개정 4 (D1-01 ~ D1-06 · D1-13). 공개 API: training-qual-api-signatures.md
   - 원칙: 역할 = 권한(authority), 자격 = 역량(competence) — 둘 다 충족해야 진행. 매핑 없는 대상은 fail-closed(qual_req_unset)
   - 저장 키: ebr.qual.v1 (단일 키, 한 번의 setItem) · 감사는 EbrUserSession.Audit (ebr.audit.v1)
   - 화면 독립: HTML 을 만들지 않는다. EbrUserSession 은 호출 시점에 찾는다(스크립트 로드 순서 무관)
   ===================================================================== */
(function (global) {
  'use strict';

  var KEY = 'ebr.qual.v1';
  var STORE_VERSION = 1;
  var DEFAULT_WARN_DAYS = 30;
  var CODES = ['qual_store_error', 'unknown_user', 'qual_req_unset', 'qual_missing', 'qual_expired', 'training_outdated_sop', 'training_overdue', 'qual_expiring'];
  var BLOCKING = { qual_store_error: 1, unknown_user: 1, qual_req_unset: 1, qual_missing: 1, qual_expired: 1, training_outdated_sop: 1, training_overdue: 1 };
  var MODE_SOFT = { qual_missing: 1, qual_expired: 1, training_outdated_sop: 1 };   /* 요구 mode:'warn' 이면 warn (규칙 ①) */
  var TARGET_RE = /^(ISSUE|SIGN:[A-Z0-9-]+|BALCLASS:[A-Z0-9-]+|OP:[A-Za-z0-9-]+|LINE:[A-Z0-9-]+)$/;
  var BAL_CLASSES = ['EC-BAL-01', 'EC-BAL-02'];

  var MSG = {
    qual_store_error: '자격 정보를 읽지 못해 서명할 수 없습니다 — 관리자에게 문의하세요.',
    unknown_user: '등록되지 않은 사용자이거나 시스템 계정이라 자격을 판정할 수 없습니다.',
    not_qa: '교육 · 자격 편집은 QA만 할 수 있습니다.',
    not_qa_reset: '교육 · 자격 시드 복원은 QA · 관리자만 할 수 있습니다.',
    session_missing: '사용자 세션 헬퍼(EbrUserSession)를 찾을 수 없습니다.',
    unknown_actor: '행위자(현재 사용자)를 확인할 수 없습니다 — 사용자를 선택하세요.',
    reason_required: '사유를 입력하세요.',
    self_grant: '자기 자신에게는 부여할 수 없습니다 (self_grant)',
    trainer_is_trainee: '이수자와 교육자가 같습니다 (trainer_is_trainee)',
    audit_error: '감사 기록을 저장하지 못해 진행할 수 없습니다 — 저장 공간을 확인한 뒤 다시 시도하세요.',
    save_error: '저장에 실패했습니다 — 변경되지 않았습니다.'
  };

  /* ------------------------------------------------------------------ 유틸 */
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function str(v) { return v == null ? '' : String(v).trim(); }
  function normId(s) { return str(s).toUpperCase(); }
  function p2(n) { return (n < 10 ? '0' : '') + n; }
  function uniq(a) { var s = {}, out = []; (a || []).forEach(function (x) { if (!s[x]) { s[x] = 1; out.push(x); } }); return out; }
  function session() { var S = global.EbrUserSession; return S && typeof S === 'object' ? S : null; }
  function ymdLocal(d) { return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); }
  function nowIso() {
    var S = session(); if (S && S.nowIsoLocal) return S.nowIsoLocal();
    var d = new Date(), off = -d.getTimezoneOffset(), a = Math.abs(off);
    return ymdLocal(d) + 'T' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()) + (off >= 0 ? '+' : '-') + p2(Math.floor(a / 60)) + ':' + p2(a % 60);
  }
  /* 'YYYY-MM-DD' 그대로 · ISO/Date → 로컬 날짜 · 생략 → 오늘. 해석 불가 → null */
  function toYmd(v) {
    if (v == null || v === '') return ymdLocal(new Date());
    if (v instanceof Date || (v && typeof v.getTime === 'function')) return isNaN(v.getTime()) ? null : ymdLocal(v);
    var s = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    var t = Date.parse(s);
    return isNaN(t) ? null : ymdLocal(new Date(t));
  }
  function dayNum(ymd) { var p = ymd.split('-'); return Math.round(Date.UTC(+p[0], +p[1] - 1, +p[2]) / 86400000); }
  function addDays(ymd, n) { var d = new Date((dayNum(ymd) + n) * 86400000); return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()); }
  function nextId(list, prefix, field, width) {
    var max = 0;
    list.forEach(function (r) { var v = String(r[field] || ''); if (v.indexOf(prefix) === 0) { var n = parseInt(v.slice(prefix.length), 10); if (n > max) max = n; } });
    var s = String(max + 1); while (s.length < width) s = '0' + s;
    return prefix + s;
  }

  /* ------------------------------------------------------------------ 저장소 */
  var failNextStage = null;
  function readRaw() { try { return global.localStorage.getItem(KEY); } catch (e) { return undefined; } }
  function validStore(o) {
    return !!(o && typeof o === 'object' && o.version === STORE_VERSION &&
      ['courses', 'sopVersions', 'trainingRecords', 'qualDefs', 'userQuals', 'requirements'].every(function (k) { return Array.isArray(o[k]); }));
  }
  /* → {ok:true, store} | {ok:false} (읽기 실패 · JSON 오류 · 버전 불일치). 키가 없으면 자동 시드 */
  function load() {
    var raw = readRaw();
    if (raw === undefined) return { ok: false };
    if (raw == null) { var s = ensureSeed(); if (!s.ok) return { ok: false }; raw = readRaw(); }
    try { var o = JSON.parse(raw); if (!validStore(o)) return { ok: false }; backfillSeed(o); return { ok: true, store: o }; } catch (e) { return { ok: false }; }
  }
  /* 시드 보충 (멱등 · 1회): 예전 저장소에 빠진 데모 부여만 추가. 표지(o.backfills)에 id 를 남겨, 사용자가 뒤에 회수 · 수정해도 다시 넣지 않는다.
     그 사용자 · 자격 행이 이미 있으면(상태 무관 — 사용자 편집 포함) 추가 없이 표지만. 자격 정의가 없거나 비활성이면 건너뜀(표지 없음).
     저장 실패는 무시(판정은 메모리 사본으로 진행, 다음 로드에 재시도) */
  /* 보충 항목 종류: grant(자격 부여, 선행 교육 기록이 없으면 함께 보충) · defs(자격 정의, 같은 qualId 없을 때만) · reqs(요구 매핑, 같은 target 없을 때만)
     실행 · 출하 서명 설계 §2.3 · §5.3 (D1-03): 신규 자격 6 · 요구 매핑 · 데모 부여(기간 = 시드 기준일 T + 일수) */
  var EXEC_QUAL_DEFS = [
    ['QD-EXEC', '공정 실행 (수행)', ['CRS-GMP-BASIC', 'CRS-EBR-USE']], ['QD-EXEC-VERI', '공정 실행 확인 · 포장 검토', ['CRS-GMP-BASIC', 'CRS-EBR-USE']],
    ['QD-PKLAB', '포장 라벨 QA 확인', ['CRS-EBR-USE']], ['QD-MATQC', '자재 QC 판정', ['CRS-GMP-BASIC']],
    ['QD-REVBATCH', '배치 기록 검토', ['CRS-EBR-USE']], ['QD-REL', '출하 승인', ['CRS-EBR-USE']]
  ];
  var EXEC_REQS = [
    ['SIGN:SM-PERF-STEP', ['QD-EXEC'], '공정 실행 수행 (생산 · 포장)'], ['SIGN:SM-VERI-STEP', ['QD-EXEC-VERI'], '공정 실행 확인 (생산 · 포장)'],
    ['SIGN:SM-REV-PACK', ['QD-EXEC-VERI'], '포장 기록 검토 (1차)'], ['SIGN:SM-VERI-PKLAB', ['QD-PKLAB'], '포장 라벨 QA 확인'],
    ['SIGN:SM-APPR-MATQC', ['QD-MATQC'], '자재 QC 판정'], ['SIGN:SM-REV-RBE', ['QD-REVBATCH'], 'RBE 예외 검토'],
    ['SIGN:SM-REV-BATCH', ['QD-REVBATCH'], '배치 기록 2차 검토'], ['SIGN:SM-REV-AUDIT', ['QD-REVBATCH'], '감사추적 검토 (게이트 4)'],
    ['SIGN:SM-APPR-REL', ['QD-REL'], '출하 승인'], ['SIGN:SM-REV-MBR', ['QD-REVBATCH'], 'MBR 독립 검토'], ['SIGN:SM-APPR-MBR', ['QD-REVBATCH'], 'MBR QA 승인'],
    ['SIGN:SM-READ-BRIEF', [], '변경 브리핑 (자격 불요)'], ['LINE:PK-L02', ['QD-PK-L02'], '포장 라인 PK-L02 (작업자 슬롯)']
  ];
  /* 출하 게이트 조건 서명 4종 (출하 게이트 동적 판정 §2.3–2.6) → QD-REVBATCH */
  var GATE_REQS = [
    ['SIGN:SM-REV-DOWN', ['QD-REVBATCH'], '다운타임 QA 전수 검토 (게이트 7)'], ['SIGN:SM-REV-CHG', ['QD-REVBATCH'], '개정 첫 배치 변경 영향 검토 (게이트 10)'],
    ['SIGN:SM-REV-CTRL', ['QD-REVBATCH'], '통제 강화 후 기존 값 평가 (게이트 11)'], ['SIGN:SM-REV-RESTORE', ['QD-REVBATCH'], '복원 탐지 QA 확인 (게이트 12)']
  ];
  /* 정정 서명 2종 (정정 흐름 C1-6): 수행 → QD-EXEC, QA 확인 → QD-REVBATCH */
  var CORR_REQS = [['SIGN:SM-PERF-CORR', ['QD-EXEC'], '값 정정 수행'], ['SIGN:SM-VERI-CORR', ['QD-REVBATCH'], '정정 QA 확인']];
  /* 인터록 서명 3종 (인터록 설계 §4 · K-9): 세트 검토 · 승인 → QD-REVBATCH, Controlled 감독자 승인 → QD-EXEC-VERI */
  var ILR_REQS = [['SIGN:SM-REV-ILR', ['QD-REVBATCH'], '인터록 룰 세트 검토'], ['SIGN:SM-APPR-ILR', ['QD-REVBATCH'], '인터록 룰 세트 승인'], ['SIGN:SM-APPR-CTRL', ['QD-EXEC-VERI'], 'Controlled 인터록 감독자 승인']];
  var SEED_BACKFILLS = [
    { id: 'BF-SV0003-REWEIGH', userId: 'SV-0003', qualId: 'QD-REWEIGH', expiresOffset: 200 },
    { id: 'BF-EXEC-DEFS', defs: EXEC_QUAL_DEFS },
    { id: 'BF-EXEC-REQS', reqs: EXEC_REQS },
    { id: 'BF-GATE-REQS', reqs: GATE_REQS },
    { id: 'BF-CORR-REQS', reqs: CORR_REQS },
    { id: 'BF-ILR-REQS', reqs: ILR_REQS },
    { id: 'BF-EXEC-OP0101', userId: 'OP-0101', qualId: 'QD-EXEC', expiresOffset: 200, train: true },
    { id: 'BF-EXEC-SV0003', userId: 'SV-0003', qualId: 'QD-EXEC-VERI', expiresOffset: 200, train: true },
    { id: 'BF-EXEC-OP0102', userId: 'OP-0102', qualId: 'QD-EXEC', expiresOffset: 12, train: true },
    { id: 'BF-EXEC-QA0007', userId: 'QA-0007', qualId: 'QD-PKLAB', expiresOffset: 200, train: true },
    { id: 'BF-EXEC-SV0011', userId: 'SV-0011', qualId: 'QD-EXEC-VERI', expiresOffset: 200, train: true },
    { id: 'BF-EXEC-QA0011-MATQC', userId: 'QA-0011', qualId: 'QD-MATQC', expiresOffset: 200, train: true },
    { id: 'BF-EXEC-QA0011-REV', userId: 'QA-0011', qualId: 'QD-REVBATCH', expiresOffset: 200, train: true },
    { id: 'BF-EXEC-QA0013-REV', userId: 'QA-0013', qualId: 'QD-REVBATCH', expiresOffset: 200, train: true },
    { id: 'BF-EXEC-QP0001-REL', userId: 'QP-0001', qualId: 'QD-REL', expiresOffset: 200, train: true },
    { id: 'BF-EXEC-QA0012-REL', userId: 'QA-0012', qualId: 'QD-REL', expiresOffset: -2, train: true },
    /* 정정 흐름: SV 도 정정 수행(SM-PERF-CORR → QD-EXEC) 가능하도록 부여 + 교육 기록 */
    { id: 'BF-CORR-SV0011-EXEC', userId: 'SV-0011', qualId: 'QD-EXEC', expiresOffset: 200, train: true },
    { id: 'BF-CORR-SV0003-EXEC', userId: 'SV-0003', qualId: 'QD-EXEC', expiresOffset: 200, train: true }
  ];
  /* 보충 본체 (메모리만). → { grants:[uq…], trainings:[tr…], changed } */
  function applyBackfills(o) {
    if (!Array.isArray(o.backfills)) o.backfills = [];
    var out = { grants: [], trainings: [], changed: false }, at = nowIso(), T = toYmd(o.seedBase) || toYmd();
    SEED_BACKFILLS.forEach(function (b) {
      if (o.backfills.indexOf(b.id) >= 0) return;
      if (b.defs) {
        b.defs.forEach(function (x) {
          if (o.qualDefs.some(function (d) { return d.qualId === x[0]; })) return;
          o.qualDefs.push({ qualId: x[0], name: x[1], kind: 'task', scope: {}, requiredCourses: x[2].slice(), validDays: 365, warnDays: DEFAULT_WARN_DAYS, status: 'active' });
        });
        o.backfills.push(b.id); out.changed = true; return;
      }
      if (b.reqs) {
        b.reqs.forEach(function (x) {
          if (o.requirements.some(function (r) { return r.target === x[0]; })) return;
          o.requirements.push({ reqId: nextId(o.requirements, 'RQ-', 'reqId', 2), target: x[0], qualIds: x[1].slice(), mode: 'block', note: x[2], updatedAt: at, updatedBy: 'SYSTEM' });
        });
        o.backfills.push(b.id); out.changed = true; return;
      }
      var d = o.qualDefs.filter(function (x) { return x.qualId === b.qualId && x.status === 'active'; })[0];
      if (!d) return;
      var has = o.userQuals.some(function (u) { return normId(u.userId) === b.userId && u.qualId === b.qualId; });
      if (!has) {
        var exp = addDays(T, b.expiresOffset), basis = [];
        d.requiredCourses.forEach(function (c) {
          var pick = function () {
            return o.trainingRecords.filter(function (x) { return normId(x.userId) === b.userId && x.courseId === c && x.result === 'pass' && !x.voidOf; })
              .sort(function (a, z) { return (z.sopVer - a.sopVer) || (z.completedAt < a.completedAt ? -1 : 1); })[0];
          };
          var r = pick(), crs = o.courses.filter(function (x) { return x.courseId === c; })[0], cs = crs ? currentSop(o, crs.sopId) : null;
          if (b.train && crs && cs && (!r || r.sopVer < cs.ver)) {
            r = { trId: nextId(o.trainingRecords, 'TR-', 'trId', 4), userId: b.userId, courseId: c, sopId: crs.sopId, sopVer: cs.ver, completedAt: addDays(T, -30),
                  method: '강의', result: 'pass', trainerId: 'QA-0011', recordedBy: 'SYSTEM', recordedAt: at, note: '데모 시드 보충 (' + b.id + ')' };
            o.trainingRecords.push(r); out.trainings.push(r);
          }
          if (r) basis.push(r.trId);
        });
        var uq = { uqId: nextId(o.userQuals, 'UQ-', 'uqId', 4), userId: b.userId, qualId: b.qualId, grantedAt: addDays(exp, -d.validDays), expiresAt: exp, status: 'active',
                   basisTrIds: basis, grantedBy: 'SYSTEM', reason: '데모 시드 보충 (' + b.id + ')', revokedAt: null, revokedBy: null, revokeReason: null };
        o.userQuals.push(uq); out.grants.push(uq);
      }
      o.backfills.push(b.id); out.changed = true;
    });
    return out;
  }
  function backfillSeed(o) {
    var r = applyBackfills(o), added = r.grants.map(function (u) { return /\(([^)]+)\)$/.exec(u.reason)[1]; });
    if (r.changed) {
      var raw0 = readRaw();
      try {
        writeStore(o);
        /* 부여 · 교육 기록 감사 (SYSTEM, 보충 1회 — 표지로 반복 안 됨). 감사 실패 시 저장도 되돌려 다음 로드에 함께 재시도 */
        if (r.grants.length || r.trainings.length) {
          var S = session();
          if (S && S.Audit && typeof S.Audit.appendMany === 'function') {
            S.Audit.appendMany(r.trainings.map(function (t) {
              return { uid: 'SYSTEM', userName: '시스템 (데모 시드 보충)', act: 'TRAINING_RECORDED', tgt: t.trId, val: t.courseId + ' · ' + t.sopId + ' v' + t.sopVer + ' · ' + t.userId + ' · pass', why: t.note, before: null, after: clone(t), screen: 'seedBackfill' };
            }).concat(r.grants.map(function (u) {
              return { uid: 'SYSTEM', userName: '시스템 (데모 시드 보충)', act: 'QUAL_GRANT', tgt: u.uqId, val: u.userId + ' · ' + u.qualId + ' · ~' + u.expiresAt, why: u.reason, before: null, after: clone(u), screen: 'seedBackfill' };
            })));
          }
        }
      } catch (e) { restoreRaw(raw0); added = []; }
    }
    return added;
  }
  function writeStore(o) {
    if (failNextStage === 'store') { failNextStage = null; throw new Error('저장 실패 주입 (store)'); }
    global.localStorage.setItem(KEY, JSON.stringify(o));
  }
  function restoreRaw(raw) { try { if (raw == null) global.localStorage.removeItem(KEY); else global.localStorage.setItem(KEY, raw); return true; } catch (e) { return false; } }
  function fail(why, message, extra) { var r = { ok: false, why: why, message: message || MSG[why] || why }; if (extra) Object.keys(extra).forEach(function (k) { r[k] = extra[k]; }); return r; }
  /* 저장 1회 + 감사 1회 (commitStore 패턴). 감사 실패 시 저장소 원복 */
  function commit(o, rawBefore, entries) {
    var S = session();
    if (!S || !S.Audit || typeof S.Audit.appendMany !== 'function') return fail('session_missing');
    try { writeStore(o); } catch (e) { restoreRaw(rawBefore); return fail('save_error'); }
    try { S.Audit.appendMany(entries); } catch (e2) { restoreRaw(rawBefore); return fail('audit_error'); }
    return null;
  }
  function getUser(id) { var S = session(); try { return S && S.getUser ? S.getUser(id) : null; } catch (e) { return null; } }
  function rolesOf(id) { var S = session(); try { return (S && S.rolesOf ? S.rolesOf(id) : []) || []; } catch (e) { return []; } }
  /* 쓰기 권한: actorId(생략 = 현재 사용자) 가 등록 사용자이고 roles 중 하나 보유 */
  function actorCheck(actorId, roles, msgKey) {
    var S = session(); if (!S) return { err: fail('session_missing') };
    var id = normId(actorId || (S.getCurrentUserId ? S.getCurrentUserId() : ''));
    if (!id || !getUser(id)) return { err: fail('unknown_actor') };
    var rs = rolesOf(id);
    if (!roles.some(function (r) { return rs.indexOf(r) >= 0; })) return { err: fail('not_qa', MSG[msgKey || 'not_qa']) };
    return { id: id };
  }

  /* ------------------------------------------------------------------ 시드 (설계 §3.4, T = 시드 시점 오늘) */
  function buildSeed(T) {
    var at = nowIso();
    var o = { version: STORE_VERSION, seededAt: at, seedBase: T, courses: [], sopVersions: [], trainingRecords: [], qualDefs: [], userQuals: [], requirements: [] };
    o.backfills = ['BF-SV0003-REWEIGH'];   /* 새 시드는 이 보충 내용을 이미 포함 — 나머지(실행 · 출하 서명)는 아래 applyBackfills 로 같은 규칙 적용 */
    o.courses = [
      { courseId: 'CRS-WEIGH-01', name: '칭량 SOP 교육', sopId: 'SOP-WEIGH-01', retrainDays: null, status: 'active' },
      { courseId: 'CRS-GMP-BASIC', name: 'GMP 기초', sopId: 'SOP-GMP-00', retrainDays: null, status: 'active' },
      { courseId: 'CRS-EBR-USE', name: 'eBR 시스템 사용', sopId: 'SOP-EBR-USE', retrainDays: null, status: 'active' }
    ];
    o.sopVersions = [
      { sopId: 'SOP-WEIGH-01', ver: 1, effectiveFrom: addDays(T, -400), status: 'superseded' },
      { sopId: 'SOP-WEIGH-01', ver: 2, effectiveFrom: addDays(T, -10), status: 'effective' },
      { sopId: 'SOP-GMP-00', ver: 3, effectiveFrom: addDays(T, -500), status: 'effective' },
      { sopId: 'SOP-EBR-USE', ver: 1, effectiveFrom: addDays(T, -500), status: 'effective' }
    ];
    function qd(id, name, kind, scope, req) { return { qualId: id, name: name, kind: kind, scope: scope, requiredCourses: req, validDays: 365, warnDays: DEFAULT_WARN_DAYS, status: 'active' }; }
    o.qualDefs = [
      qd('QD-WEIGH', '칭량 수행', 'task', {}, ['CRS-WEIGH-01', 'CRS-GMP-BASIC']),
      qd('QD-BAL-01', '저울 클래스 01 운용', 'equipment', { balanceClass: 'EC-BAL-01' }, ['CRS-WEIGH-01']),
      qd('QD-BAL-02', '저울 클래스 02 운용', 'equipment', { balanceClass: 'EC-BAL-02' }, ['CRS-WEIGH-01']),
      qd('QD-BALCHK', '저울 일상 점검', 'task', {}, ['CRS-WEIGH-01']),
      qd('QD-WVERI', '칭량 확인', 'task', {}, ['CRS-WEIGH-01']),
      qd('QD-ISSUE', '배치 발행 승인', 'task', {}, ['CRS-EBR-USE']),
      qd('QD-REWEIGH', '재칭량 승인', 'task', {}, ['CRS-WEIGH-01']),
      qd('QD-PK-L02', '포장 라인 PK-L02', 'line', { lineId: 'PK-L02' }, [])
    ];
    function rq(target, ids, note) { return { reqId: 'RQ-' + p2(o.requirements.length + 1), target: target, qualIds: ids, mode: 'block', note: note || '', updatedAt: at, updatedBy: 'SYSTEM' }; }
    o.requirements = [
      rq('ISSUE', ['QD-ISSUE'], '배치 발행'), rq('SIGN:SM-APPR-ISSUE', ['QD-ISSUE'], '발행 승인 서명'),
      rq('SIGN:SM-PERF-WEIGH', ['QD-WEIGH'], '칭량 수행 (+ 줄 BALCLASS)'), rq('SIGN:SM-VERI-WEIGH', ['QD-WVERI'], '칭량 확인'),
      rq('SIGN:SM-APPR-REWEIGH', ['QD-REWEIGH'], '재칭량 승인'), rq('SIGN:SM-PERF-BALCHK', ['QD-BALCHK'], '저울 일상 점검 (OP · SV)'),
      rq('SIGN:SM-PERF-BALRECHK', ['QD-BALCHK'], '저울 재점검 (SV)'),
      rq('BALCLASS:EC-BAL-01', ['QD-BAL-01'], '저울 클래스 01'), rq('BALCLASS:EC-BAL-02', ['QD-BAL-02'], '저울 클래스 02')
    ];
    var defs = {}; o.qualDefs.forEach(function (d) { defs[d.qualId] = d; });
    var S = session(), cur = S && S.getCurrentUserId ? S.getCurrentUserId() : null;
    function tr(userId, courseId, ver, completedAt) {
      var c = o.courses.filter(function (x) { return x.courseId === courseId; })[0];
      var r = { trId: nextId(o.trainingRecords, 'TR-', 'trId', 4), userId: userId, courseId: courseId, sopId: c.sopId, sopVer: ver, completedAt: completedAt,
                method: '강의', result: 'pass', trainerId: 'QA-0011', recordedBy: 'SYSTEM', recordedAt: at, note: '데모 시드' };
      if (cur) r.observedBy = cur;
      o.trainingRecords.push(r); return r.trId;
    }
    /* [userId, [[qualId, expiresOffset]], weighVersions] — weighVersions: CRS-WEIGH-01 이수 버전 */
    var plan = [
      ['OP-0101', [['QD-WEIGH', 200], ['QD-BAL-01', 200], ['QD-BAL-02', 200], ['QD-BALCHK', 200], ['QD-PK-L02', 200]], [1, 2]],
      ['OP-0102', [['QD-WEIGH', 10], ['QD-BAL-01', 200], ['QD-PK-L02', 200]], [1, 2]],
      ['SV-0003', [['QD-WEIGH', 200], ['QD-WVERI', 200], ['QD-BALCHK', 200], ['QD-REWEIGH', 200]], [1, 2]],   /* 재칭량 승인 데모 승인자 (BF-SV0003-REWEIGH) */
      ['SV-0011', [['QD-WVERI', 200], ['QD-ISSUE', 200], ['QD-REWEIGH', 200]], [1, 2]],
      ['QA-0011', [['QD-WVERI', 200], ['QD-ISSUE', 200]], [1, 2]],
      ['QA-0012', [['QD-ISSUE', -5]], [1, 2]],
      ['QA-0013', [['QD-WVERI', 200], ['QD-ISSUE', 200]], [1]],
      ['QA-0007', [['QD-WVERI', 200]], [1, 2]]
    ];
    plan.forEach(function (p) {
      var uid = p[0], courses = {};
      p[1].forEach(function (q) { defs[q[0]].requiredCourses.forEach(function (c) { courses[c] = 1; }); });
      var ids = {};
      Object.keys(courses).forEach(function (c) {
        if (c === 'CRS-WEIGH-01') p[2].forEach(function (v) { ids[c] = tr(uid, c, v, v === 1 ? addDays(T, -380) : addDays(T, -8)); });
        else ids[c] = tr(uid, c, c === 'CRS-GMP-BASIC' ? 3 : 1, addDays(T, -390));
      });
      p[1].forEach(function (q) {
        var exp = addDays(T, q[1]), d = defs[q[0]];
        var uq = { uqId: nextId(o.userQuals, 'UQ-', 'uqId', 4), userId: uid, qualId: q[0], grantedAt: addDays(exp, -d.validDays), expiresAt: exp, status: 'active',
                   basisTrIds: d.requiredCourses.map(function (c) { return ids[c]; }).filter(Boolean), grantedBy: 'SYSTEM', reason: '데모 시드',
                   revokedAt: null, revokedBy: null, revokeReason: null };
        if (cur) uq.observedBy = cur;
        o.userQuals.push(uq);
      });
    });
    applyBackfills(o);   /* 실행 · 출하 서명 자격 · 요구 · 부여 (예전 저장소 보충과 같은 결과) */
    return o;
  }
  function ensureSeed(opts) {
    opts = opts || {};
    var raw = readRaw();
    if (raw === undefined) return fail('qual_store_error');
    if (raw != null) {
      try { var ex = JSON.parse(raw); if (validStore(ex)) { var bf = backfillSeed(ex); return { ok: true, seeded: false, seedBase: ex.seedBase, backfilled: bf }; } } catch (e) { /* 아래 */ }
      return fail('qual_store_error');   /* 깨진 기록 위에 시드를 덮어쓰지 않는다 */
    }
    var T = toYmd(opts.today); if (!T) return fail('bad_input', 'today 형식 오류');
    try { writeStore(buildSeed(T)); } catch (e2) { return fail('save_error'); }
    return { ok: true, seeded: true, seedBase: T };
  }
  function resetSeed(opts) {
    opts = opts || {};
    var ac = actorCheck(opts.actorId, ['QA', 'ADMIN'], 'not_qa_reset'); if (ac.err) return ac.err;
    var T = toYmd(opts.today); if (!T) return fail('bad_input', 'today 형식 오류');
    var raw = readRaw(), prev = null;
    try { prev = JSON.parse(raw || 'null'); } catch (e) { prev = null; }
    var o = buildSeed(T);
    var err = commit(o, raw, [{ uid: ac.id, act: 'SEED_RESET', tgt: KEY, val: '교육 · 자격 시드 복원 · 기준일 ' + T,
      before: validStore(prev) ? { seedBase: prev.seedBase, userQuals: prev.userQuals.length, trainingRecords: prev.trainingRecords.length, requirements: prev.requirements.length } : null,
      after: { seedBase: T, userQuals: o.userQuals.length, trainingRecords: o.trainingRecords.length, requirements: o.requirements.length }, screen: opts.screen }]);
    return err || { ok: true, seedBase: T };
  }

  /* ------------------------------------------------------------------ 판정 */
  function defOf(o, id) { return o.qualDefs.filter(function (d) { return d.qualId === id; })[0] || null; }
  function courseOf(o, id) { return o.courses.filter(function (c) { return c.courseId === id; })[0] || null; }
  function currentSop(o, sopId) {
    return o.sopVersions.filter(function (v) { return v.sopId === sopId && v.status === 'effective'; }).sort(function (a, b) { return b.ver - a.ver; })[0] || null;
  }
  function voidedIds(o) { var s = {}; o.trainingRecords.forEach(function (r) { if (r.voidOf) s[r.voidOf] = 1; }); return s; }
  /* 과정 이수 상태: 현재 효력 버전의 pass 기록이 있는가 */
  function courseState(o, userId, courseId, voided) {
    var c = courseOf(o, courseId), cs = c ? currentSop(o, c.sopId) : null;
    var recs = o.trainingRecords.filter(function (r) { return normId(r.userId) === userId && r.courseId === courseId && r.result === 'pass' && !voided[r.trId] && !r.voidOf; })
      .sort(function (a, b) { return (b.sopVer - a.sopVer) || (b.completedAt < a.completedAt ? -1 : 1); });
    var best = recs[0] || null;
    var okRec = cs ? recs.filter(function (r) { return r.sopVer === cs.ver; })[0] : null;
    return { courseId: courseId, name: c ? c.name : '', sopId: c ? c.sopId : '', currentVer: cs ? cs.ver : null, effectiveFrom: cs ? cs.effectiveFrom : null,
             completedVer: okRec ? okRec.sopVer : (best ? best.sopVer : null), completedAt: okRec ? okRec.completedAt : (best ? best.completedAt : null), ok: !!(cs && okRec) };
  }
  function activeUq(o, userId, qualId) {
    return o.userQuals.filter(function (u) { return normId(u.userId) === userId && u.qualId === qualId && u.status === 'active'; })
      .sort(function (a, b) { return a.expiresAt < b.expiresAt ? 1 : -1; })[0] || null;
  }
  /* 사용자 × 자격 평가 → {uq, def, expired, daysLeft, outdated:[courseState], expiring} */
  function evalQual(o, userId, qualId, atYmd, voided) {
    var def = defOf(o, qualId), uq = activeUq(o, userId, qualId);
    if (!uq) return { uq: null, def: def };
    var dl = dayNum(uq.expiresAt) - dayNum(atYmd);
    var outdated = (def ? def.requiredCourses : []).map(function (c) { return courseState(o, userId, c, voided); }).filter(function (s) { return !s.ok; });
    var warnDays = def && def.warnDays != null ? def.warnDays : DEFAULT_WARN_DAYS;
    return { uq: uq, def: def, daysLeft: dl, expired: dl < 0, outdated: outdated, expiring: dl >= 0 && dl <= warnDays };
  }
  function qName(def, id) { return id + (def && def.name ? ' ' + def.name : ''); }
  function itemMessage(code, it, def) {
    switch (code) {
      case 'qual_missing': return '자격 없음 — ' + qName(def, it.qualId) + ' 부여 이력이 없습니다. 교육 · 자격 담당(QA)에게 요청하세요.';
      case 'qual_expired': return '자격 만료 — ' + it.qualId + ' ' + it.expiresAt + ' 만료. 재자격 후 서명하세요.';
      case 'training_outdated_sop': return 'SOP 재교육 필요 — ' + it.sopId + ' v' + it.requiredVer + ' 이수 기록이 없습니다 (' + it.qualId + ').';
      case 'qual_expiring': return '자격 만료 임박 — ' + it.qualId + ' ' + it.expiresAt + ' (D-' + it.daysLeft + ')';
      case 'qual_req_unset': return '자격 요구 미설정 — 교육 · 자격 [요구 매핑]에 ' + (it.target || '대상') + ' 설정을 요청하세요.';
      default: return MSG[code] || code;
    }
  }
  function mkItem(code, target, mode, extra, def) {
    var it = { target: target, qualId: null, code: code, expiresAt: null, daysLeft: null, mode: mode };
    if (extra) Object.keys(extra).forEach(function (k) { it[k] = extra[k]; });
    it.message = itemMessage(code, it, def);
    return it;
  }
  function verdict(items) {
    items.sort(function (a, b) { return CODES.indexOf(a.code) - CODES.indexOf(b.code); });
    var blocked = items.some(function (i) { return BLOCKING[i.code] && !(i.mode === 'warn' && MODE_SOFT[i.code]); });
    return blocked ? 'blocked' : (items.length ? 'warn' : 'ok');
  }
  function checkQualification(q) {
    q = q || {};
    var lo = load();
    if (!lo.ok) return { result: 'blocked', items: [mkItem('qual_store_error', null, 'block')], reqMissing: [] };
    var o = lo.store, uid = normId(q.userId);
    if (!uid || uid === 'SYSTEM' || (session() && !getUser(uid))) return { result: 'blocked', items: [mkItem('unknown_user', null, 'block', { userId: uid })], reqMissing: [] };
    var targets = uniq((Array.isArray(q.targets) ? q.targets : []).map(str).filter(Boolean));
    if (!targets.length) return { result: 'blocked', items: [mkItem('qual_req_unset', null, 'block')], reqMissing: [] };
    var atYmd = toYmd(q.at); if (!atYmd) atYmd = toYmd();
    var voided = voidedIds(o), items = [], reqMissing = [];
    targets.forEach(function (t) {
      var req = o.requirements.filter(function (r) { return r.target === t; })[0];
      if (!req) { reqMissing.push(t); items.push(mkItem('qual_req_unset', t, 'block')); return; }
      var mode = req.mode === 'warn' ? 'warn' : 'block';
      (req.qualIds || []).forEach(function (qid) {
        var e = evalQual(o, uid, qid, atYmd, voided), def = e.def;
        if (!e.uq) { items.push(mkItem('qual_missing', t, mode, { qualId: qid }, def)); return; }
        var base = { qualId: qid, expiresAt: e.uq.expiresAt, daysLeft: e.daysLeft };
        if (e.expired) items.push(mkItem('qual_expired', t, mode, base, def));
        e.outdated.forEach(function (s) {
          items.push(mkItem('training_outdated_sop', t, mode, { qualId: qid, expiresAt: e.uq.expiresAt, daysLeft: e.daysLeft, courseId: s.courseId, sopId: s.sopId, requiredVer: s.currentVer, completedVer: s.completedVer }, def));
        });
        if (!e.expired && e.expiring) items.push(mkItem('qual_expiring', t, 'warn', base, def));
      });
    });
    return { result: verdict(items), items: items, reqMissing: reqMissing };
  }

  /* ------------------------------------------------------------------ 조회 */
  function cellOf(o, uid, qid, atYmd, voided) {
    var e = evalQual(o, uid, qid, atYmd, voided);
    if (!e.uq) return { state: 'none', expiresAt: null, daysLeft: null, uqId: null };
    var c = { state: 'valid', expiresAt: e.uq.expiresAt, daysLeft: e.daysLeft, uqId: e.uq.uqId };
    if (e.expired) c.state = 'expired';
    else if (e.outdated.length) { c.state = 'outdated'; c.sopId = e.outdated[0].sopId; c.requiredVer = e.outdated[0].currentVer; }
    else if (e.expiring) c.state = 'expiring';
    return c;
  }
  function userList(o) {
    var S = session(), list = [];
    try { list = S && S.listUsers ? S.listUsers() : []; } catch (e) { list = []; }
    if (!list.length) list = uniq(o.userQuals.map(function (u) { return u.userId; })).map(function (id) { return { userId: id, name: '', dept: '', roles: [] }; });
    return list;
  }
  function matrix(q) {
    q = q || {};
    var lo = load(); if (!lo.ok) return fail('qual_store_error');
    var o = lo.store, atYmd = toYmd(q.at) || toYmd(), voided = voidedIds(o);
    var filter = Array.isArray(q.userIds) ? q.userIds.map(normId) : null;
    var qids = o.qualDefs.map(function (d) { return d.qualId; });
    var rows = userList(o).filter(function (u) { return !filter || filter.indexOf(normId(u.userId)) >= 0; }).map(function (u) {
      var cells = {}; qids.forEach(function (qid) { cells[qid] = cellOf(o, normId(u.userId), qid, atYmd, voided); });
      return { userId: u.userId, name: u.name || '', dept: u.dept || '', roles: (u.roles || []).slice(), cells: cells };
    });
    return { ok: true, at: atYmd, qualIds: qids, rows: rows };
  }
  function userStatus(userId, at) {
    var uid = normId(userId); if (!uid) return fail('bad_input', '사용자 ID가 필요합니다.');
    var lo = load(); if (!lo.ok) return fail('qual_store_error');
    var o = lo.store, atYmd = toYmd(at) || toYmd(), voided = voidedIds(o), u = getUser(uid);
    var quals = o.userQuals.filter(function (x) { return normId(x.userId) === uid; }).map(function (x) {
      var def = defOf(o, x.qualId), r = clone(x);
      r.name = def ? def.name : '';
      r.daysLeft = dayNum(x.expiresAt) - dayNum(atYmd);
      if (x.status !== 'active') r.state = x.status;
      else { var act = activeUq(o, uid, x.qualId); r.state = act && act.uqId === x.uqId ? cellOf(o, uid, x.qualId, atYmd, voided).state : 'valid'; }
      return r;
    }).sort(function (a, b) { return ((a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1)) || (a.qualId < b.qualId ? -1 : a.qualId > b.qualId ? 1 : 0); });
    var courseStatus = o.courses.map(function (c) { return courseState(o, uid, c.courseId, voided); });
    var need = {};
    quals.filter(function (x) { return x.status === 'active'; }).forEach(function (x) { var d = defOf(o, x.qualId); (d ? d.requiredCourses : []).forEach(function (c) { need[c] = 1; }); });
    var retrain = courseStatus.filter(function (s) { return need[s.courseId] && !s.ok; }).map(function (s) { return s.courseId; });
    var training = o.trainingRecords.filter(function (r) { return normId(r.userId) === uid; }).map(clone)
      .sort(function (a, b) { return a.completedAt < b.completedAt ? 1 : a.completedAt > b.completedAt ? -1 : (a.trId < b.trId ? 1 : -1); });
    return { ok: true, userId: uid, at: atYmd, user: u ? { userId: u.userId, name: u.name, dept: u.dept, roles: (u.roles || []).slice(), status: u.status } : null,
             quals: quals, training: training, courseStatus: courseStatus, retrainCourses: retrain };
  }
  function listRequirements() {
    var lo = load(); if (!lo.ok) return [];
    return clone(lo.store.requirements).sort(function (a, b) { return a.target < b.target ? -1 : a.target > b.target ? 1 : 0; });
  }
  function kindOf(t) { return t === 'ISSUE' ? 'ISSUE' : t.split(':')[0]; }
  function gateTargets() {
    var lo = load(), reqs = lo.ok ? lo.store.requirements : [], S = session(), out = [], seen = {};
    var mapped = {}; reqs.forEach(function (r) { mapped[r.target] = 1; });
    function add(t, label, source) { if (seen[t]) return; seen[t] = 1; out.push({ target: t, kind: kindOf(t), label: label, mapped: !!mapped[t], source: source }); }
    add('ISSUE', '배치 발행', 'builtin');
    var rules = S && S.BUILTIN_RULES ? S.BUILTIN_RULES : {};
    Object.keys(rules).forEach(function (id) { var r = rules[id] || {}; add('SIGN:' + id, '서명 ' + id + (r.note ? ' — ' + r.note : ''), 'rule'); });
    BAL_CLASSES.forEach(function (c) { add('BALCLASS:' + c, '저울 클래스 ' + c, 'balanceClass'); });
    reqs.forEach(function (r) { add(r.target, r.note || r.target, 'requirement'); });
    return out.sort(function (a, b) { return (a.mapped ? 1 : 0) - (b.mapped ? 1 : 0); });
  }
  function listQualDefs() { var lo = load(); return lo.ok ? clone(lo.store.qualDefs) : []; }
  function listCourses() {
    var lo = load(); if (!lo.ok) return [];
    return lo.store.courses.map(function (c) { var r = clone(c), cs = currentSop(lo.store, c.sopId); r.currentSopVer = cs ? cs.ver : null; r.currentEffectiveFrom = cs ? cs.effectiveFrom : null; return r; });
  }
  function listSopVersions(sopId) {
    var lo = load(); if (!lo.ok) return [];
    return clone(lo.store.sopVersions).filter(function (v) { return !sopId || v.sopId === sopId; })
      .sort(function (a, b) { return a.sopId === b.sopId ? b.ver - a.ver : (a.sopId < b.sopId ? -1 : 1); });
  }

  /* ------------------------------------------------------------------ 쓰기 (QA, 사유 + 감사 — P0 전자서명 없음, Q2) */
  function grant(p) {
    p = p || {};
    var ac = actorCheck(p.actorId, ['QA']); if (ac.err) return ac.err;
    var uid = normId(p.userId), qid = str(p.qualId), reason = str(p.reason);
    if (!uid || !qid) return fail('bad_input', '대상 사용자와 자격은 필수입니다.');
    if (!reason) return fail('reason_required');
    if (!getUser(uid)) return fail('unknown_user', '등록되지 않은 사용자입니다: ' + uid);
    if (uid === ac.id) return fail('self_grant');
    var lo = load(), raw = readRaw(); if (!lo.ok) return fail('qual_store_error');
    var o = lo.store, def = defOf(o, qid);
    if (!def || def.status !== 'active') return fail('unknown_qual', '알 수 없는 자격입니다: ' + qid);
    var voided = voidedIds(o);
    var missing = def.requiredCourses.map(function (c) { return courseState(o, uid, c, voided); }).filter(function (s) { return !s.ok; })
      .map(function (s) { return { courseId: s.courseId, sopId: s.sopId, requiredVer: s.currentVer, completedVer: s.completedVer }; });
    if (missing.length) return fail('training_outdated_sop', '선행 교육 미충족: 부여 불가 (training_outdated_sop) — ' + missing.map(function (m) { return m.courseId + ' ' + m.sopId + ' v' + m.requiredVer; }).join(' · '), { missing: missing });
    var g = toYmd(p.grantedAt); if (!g) return fail('bad_date', '부여일 형식 오류');
    var e = p.expiresAt ? toYmd(p.expiresAt) : addDays(g, def.validDays);
    if (!e || dayNum(e) < dayNum(g)) return fail('bad_date', '만료일은 부여일 이후여야 합니다.');
    raw = readRaw();
    var at = nowIso(), prev = activeUq(o, uid, qid), entries = [], prevBefore = prev ? clone(prev) : null;
    var basis = def.requiredCourses.map(function (c) {
      var cs = courseState(o, uid, c, voided);
      var r = o.trainingRecords.filter(function (t) { return normId(t.userId) === uid && t.courseId === c && t.sopVer === cs.currentVer && t.result === 'pass' && !voided[t.trId]; })
        .sort(function (a, b) { return a.completedAt < b.completedAt ? 1 : -1; })[0];
      return r ? r.trId : null;
    }).filter(Boolean);
    var uq = { uqId: nextId(o.userQuals, 'UQ-', 'uqId', 4), userId: uid, qualId: qid, grantedAt: g, expiresAt: e, status: 'active', basisTrIds: basis,
               grantedBy: ac.id, reason: reason, revokedAt: null, revokedBy: null, revokeReason: null, recordedAt: at };
    if (prev) { prev.status = 'superseded'; prev.supersededBy = uq.uqId; prev.supersededAt = at; }
    o.userQuals.push(uq);
    if (prev) entries.push({ uid: ac.id, act: 'QUAL_SUPERSEDE', tgt: prev.uqId, val: uid + ' · ' + qid + ' → ' + uq.uqId, why: reason, before: { status: 'active' }, after: { status: 'superseded', supersededBy: uq.uqId }, screen: p.screen });
    entries.push({ uid: ac.id, act: 'QUAL_GRANT', tgt: uq.uqId, val: uid + ' · ' + qid + ' · ~' + e, why: reason, before: prevBefore, after: clone(uq), screen: p.screen });
    var err = commit(o, raw, entries); if (err) return err;
    return { ok: true, uq: clone(uq), superseded: prev ? clone(prev) : null };
  }
  function revoke(p) {
    p = p || {};
    var ac = actorCheck(p.actorId, ['QA']); if (ac.err) return ac.err;
    var reason = str(p.reason); if (!reason) return fail('reason_required');
    var lo = load(), raw = readRaw(); if (!lo.ok) return fail('qual_store_error');
    var o = lo.store, uq = o.userQuals.filter(function (x) { return x.uqId === str(p.uqId); })[0];
    if (!uq) return fail('not_found', '자격 부여 기록이 없습니다: ' + str(p.uqId));
    if (uq.status !== 'active') return fail('not_active', '유효(active) 부여만 회수할 수 있습니다.');
    var at = nowIso();
    uq.status = 'revoked'; uq.revokedAt = at; uq.revokedBy = ac.id; uq.revokeReason = reason;
    var err = commit(o, raw, [{ uid: ac.id, act: 'QUAL_REVOKE', tgt: uq.uqId, val: uq.userId + ' · ' + uq.qualId + ' · ' + reason, why: reason,
      before: { status: 'active' }, after: { status: 'revoked', revokedAt: at, revokedBy: ac.id }, screen: p.screen }]);
    return err || { ok: true, uq: clone(uq) };
  }
  function recordTraining(p) {
    p = p || {};
    var ac = actorCheck(p.actorId, ['QA']); if (ac.err) return ac.err;
    var ids = uniq((Array.isArray(p.userIds) ? p.userIds : []).map(normId).filter(Boolean));
    var trainer = normId(p.trainerId), result = p.result == null || p.result === '' ? 'pass' : String(p.result);
    if (!str(p.courseId) || !ids.length || !trainer) return fail('bad_input', '교육 과정 · 이수자 · 교육자는 필수입니다.');
    if (result !== 'pass' && result !== 'fail') return fail('bad_result', '평가 결과는 pass / fail 중 하나입니다.');
    var unknown = ids.concat([trainer]).filter(function (id) { return !getUser(id); });
    if (unknown.length) return fail('unknown_user', '등록되지 않은 사용자입니다: ' + uniq(unknown).join(', '));
    if (ids.indexOf(trainer) >= 0) return fail('trainer_is_trainee');
    var completedAt = toYmd(p.completedAt); if (!completedAt) return fail('bad_date', '이수일 형식 오류');
    var lo = load(), raw = readRaw(); if (!lo.ok) return fail('qual_store_error');
    var o = lo.store, c = courseOf(o, str(p.courseId));
    if (!c) return fail('unknown_course', '알 수 없는 교육 과정입니다: ' + str(p.courseId));
    var cs = currentSop(o, c.sopId); if (!cs) return fail('unknown_course', '과정의 효력 SOP 버전이 없습니다: ' + c.sopId);
    var at = nowIso(), trIds = [], entries = [];
    ids.forEach(function (uid) {
      var r = { trId: nextId(o.trainingRecords, 'TR-', 'trId', 4), userId: uid, courseId: c.courseId, sopId: c.sopId, sopVer: cs.ver, completedAt: completedAt,
                method: str(p.method), result: result, trainerId: trainer, recordedBy: ac.id, recordedAt: at, note: str(p.note) };
      o.trainingRecords.push(r); trIds.push(r.trId);
      entries.push({ uid: ac.id, act: 'TRAINING_RECORDED', tgt: r.trId, val: c.courseId + ' · ' + c.sopId + ' v' + cs.ver + ' · ' + uid + ' · ' + result, before: null, after: clone(r), screen: p.screen });
    });
    var err = commit(o, raw, entries);
    return err || { ok: true, trIds: trIds };
  }
  function saveRequirement(p) {
    p = p || {};
    var ac = actorCheck(p.actorId, ['QA']); if (ac.err) return ac.err;
    var target = str(p.target), mode = p.mode == null || p.mode === '' ? 'block' : String(p.mode), reason = str(p.reason);
    if (!TARGET_RE.test(target)) return fail('bad_target', '대상 키 형식이 아닙니다 (ISSUE · SIGN: · BALCLASS: · OP: · LINE:): ' + target);
    if (!Array.isArray(p.qualIds)) return fail('bad_input', 'qualIds 는 배열이어야 합니다 (자격 불요 = []).');
    if (mode !== 'block' && mode !== 'warn') return fail('bad_mode', '모드는 block / warn 중 하나입니다.');
    if (!reason) return fail('reason_required');
    var lo = load(), raw = readRaw(); if (!lo.ok) return fail('qual_store_error');
    var o = lo.store, qids = uniq(p.qualIds.map(str).filter(Boolean));
    var bad = qids.filter(function (q) { return !defOf(o, q); });
    if (bad.length) return fail('unknown_qual', '알 수 없는 자격입니다: ' + bad.join(', '));
    var at = nowIso(), row = o.requirements.filter(function (r) { return r.target === target; })[0], created = !row;
    var before = row ? { qualIds: row.qualIds.slice(), mode: row.mode } : null;
    if (!row) { row = { reqId: nextId(o.requirements, 'RQ-', 'reqId', 2), target: target }; o.requirements.push(row); }
    row.qualIds = qids; row.mode = mode; if (p.note !== undefined) row.note = str(p.note); else if (row.note == null) row.note = '';
    row.updatedAt = at; row.updatedBy = ac.id;
    var err = commit(o, raw, [{ uid: ac.id, act: 'QUAL_REQ_UPDATE', tgt: target, val: (qids.length ? qids.join('+') : '자격 불요') + ' · ' + mode, why: reason,
      before: before, after: { qualIds: qids.slice(), mode: mode }, screen: p.screen }]);
    return err || { ok: true, requirement: clone(row), created: created };
  }

  /* ------------------------------------------------------------------ 공개 */
  var API = {
    VERSION: 1, KEY: KEY, STORE_VERSION: STORE_VERSION, CODES: CODES.slice(), DEFAULT_WARN_DAYS: DEFAULT_WARN_DAYS,
    ensureSeed: ensureSeed, resetSeed: resetSeed,
    checkQualification: checkQualification, matrix: matrix, userStatus: userStatus,
    grant: grant, revoke: revoke, recordTraining: recordTraining, saveRequirement: saveRequirement, listRequirements: listRequirements,
    gateTargets: gateTargets, listQualDefs: listQualDefs, listCourses: listCourses, listSopVersions: listSopVersions,
    _test: {
      seedSmokeFixtures: function () { return []; },   /* 픽스처 SV-0004 는 자격 없음이 의도 (qual_missing 스모크) */
      removeRequirement: function (target) {
        var lo = load(); if (!lo.ok) return false;
        var n = lo.store.requirements.length;
        lo.store.requirements = lo.store.requirements.filter(function (r) { return r.target !== target; });
        if (lo.store.requirements.length === n) return false;
        writeStore(lo.store); return true;
      },
      failNext: function (stage) { failNextStage = stage || null; return failNextStage; }
    }
  };
  global.EbrQual = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
