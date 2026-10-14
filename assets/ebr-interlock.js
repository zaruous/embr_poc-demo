/**
 * ebr-interlock.js — 인터록 규칙 평가 API (poc-interlock-rule-design.md 확정본 P0 · I1-1 · I1-8 · I1-11 · I1-12)
 * 화면과 무관한 store. 규칙 = 기준정보 설정 객체 kind 'interlock' 본문 rules[] (ebmr.masterSetup.v2), 조건 = 코드(COND_TYPES).
 * 평가(evaluate · ruleSetFor · explain)는 setItem 0회. 저장은 logHit(감사) · 승인 커밋 · demoPreset · seedDemo 만.
 *
 * window.EbrInterlock (기본 인스턴스) · EbrInterlock.create({storage, session, today, now})
 *   COND_TYPES · POINTS · GRADES · GRADE_CLASS · WHY_TEXT · OVR_REASON_TABLE · DEMO_PRESETS · BUILTIN_SETS · DEMO_BATCHES
 *   ruleSetFor({batchId?, point, lineId?, demo?})            → {ok, set:{id, ver, hash, frozen}, sets:[…], rules:[…]} | {ok:false, why:'ilr_store_error'|'no_effective_set'}
 *   evaluate(point, ctx)                                       → {ok, result:'pass'|'warn'|'block', hits:[…], set}
 *   explain(ruleId, ctx)                                       → {ruleId, cond, value, pass, why}
 *   logHit(result, {screen, batchId, actorId})                 → {ok, logged}
 *   validateRules(body)                                        → {ok, errors:[{why, ruleId?, key?, message}]}
 *   requestOverride({hit, batchId, reasonCode?, reason?, screen, performerId?}) → {ok, ticket, target}
 *   signAndCommit(ticket, {userId, password, statement?, reasonCode?, reason?}) → {ok, signatureId, rbeExceptionId}
 *   cancel(ticket, {reason})                                   → {ok}
 *   overrideState(batchId, ruleId, valueHash?)                 → {approved, signatureId?, rbeExceptionId?}
 *   reasonCodes()                                              → {ok, items:[{key, code, text, freeRequired, active}]}
 *   freezeManifest({lineId?})                                  → {ok, ILR:{id, ver, hash, sets:[…]}}
 *   demoPreset(name, {screen})                                 → {ok, preset}
 *   demoState() · demoCtx(point, {batchId, opId})              → 데모 데이터 · 지점 ctx
 *   seedDemo({force})                                          → {ok, seeded}
 */
(function (global) {
  'use strict';
  var MASTER_KEY = 'ebmr.masterSetup.v2', MASTER_V = 3;
  var KEYS = { MASTER: MASTER_KEY, AUDIT: 'ebr.audit.v1', OVR: 'ebr.interlockOverride.v1', RBE: 'ebr.rbeException.v1', DEMO: 'ebr.interlockDemo.v1', ACK: 'ebr.interlockAck.v1', BIND: 'ebr.interlockHitBind.v1', MAT: 'ebr.materialLot.v1', ISSUED: 'ebr.batch.issued.v1' };
  var GRADES = ['Absolute', 'Hard-QA', 'Controlled', 'Warning'];
  var GRADE_RANK = { Absolute: 0, 'Hard-QA': 1, Controlled: 2, Warning: 3 };
  var GRADE_CLASS = { Absolute: 'il-abs', 'Hard-QA': 'il-hardqa', Controlled: 'il-ctrl', Warning: 'il-warn' };
  var OVERRIDE = {   /* ILR grades 정의 (role · 서명 규칙). Hard-QA 승인은 P1 */
    Absolute: { allowed: false, role: 'none', signRuleId: null, auth: '', dev: false, block: 'none' },
    'Hard-QA': { allowed: true, role: 'qa', signRuleId: 'SM-APPR-OVR', auth: 'full_factor', dev: true, block: 'deviation', p1: true },
    Controlled: { allowed: true, role: 'supervisor', signRuleId: 'SM-APPR-CTRL', auth: 'full_factor', dev: false, block: 'rbe' },
    Warning: { allowed: true, role: 'self', signRuleId: null, auth: 'reason', dev: false, block: 'none' }
  };
  var POINTS = ['weigh.gate', 'weigh.tolerance', 'exec.step', 'exec.sign', 'exec.order', 'pack.scan', 'pack.reconcile', 'pack.equipment', 'pack.step'];
  var WHY_TEXT = {
    locked_removed: '잠금 규칙은 삭제할 수 없습니다.', reason_required: '사유를 입력하세요.', no_current_user: '현재 사용자를 선택하세요.',
    floor_violation: 'Absolute 잠금 규칙은 등급을 낮출 수 없습니다.', bad_param: '파라미터가 올바르지 않습니다 — {key}: {range}.', unknown_cond: '알 수 없는 조건 유형입니다.',
    review_missing: '검토 서명이 없어 승인할 수 없습니다.', same_person: '작성자 · 검토자 · 승인자는 서로 달라야 합니다.', ilr_store_error: '인터록 규칙을 읽을 수 없어 진행할 수 없습니다.', clock_skew: '기기 시계가 승인 서명 시각보다 이릅니다 — 기기 날짜 · 시간을 표준 시각으로 정정한 뒤 QA 확인을 받고 [다시 읽기]를 누르세요.',
    floor_uncovered: "제품 하한 Absolute 항목 '{item}'을 덮는 잠금 규칙이 없습니다.", no_effective_set: '효력 중인 인터록 룰 세트가 없습니다 — 진행할 수 없습니다.',
    bad_rule_id: '규칙 ID 형식이 올바르지 않습니다 (예: IL-PK-YIELD).', dup_rule_id: '같은 규칙 ID가 이미 있습니다 — 규칙 ID는 재사용할 수 없습니다.', unknown_point: '알 수 없는 평가 지점입니다.',
    override_not_allowed: 'Absolute 인터록은 승인으로 진행할 수 없습니다.', override_used: '이 배치에서 이미 승인을 사용했습니다.',
    /* 사유 콤보 (정정 설계 §5.0 문구) */
    reason_code_required: '사유 코드를 고르세요.', bad_reason_code: '사유 코드가 올바르지 않습니다.', reason_code_unavailable: '사유 코드 목록을 읽을 수 없습니다 — 기준정보를 확인하세요.',
    reason_required_other: "'기타'는 사유를 입력해야 합니다.", reason_too_long: '사유는 60자 이내로 입력하세요.',
    performer_unknown: '수행 서명이 아직 없어 승인할 수 없습니다 — 적중 단계의 수행 서명 후 감독자 승인 (동일인 확인).', session_error: '사용자 · 서명 정보를 읽지 못했습니다 — 승인할 수 없습니다.',
    role_restricted: '감독자 승인이 필요합니다.', no_role: '역할이 없어 승인할 수 없습니다.', override_p1: 'Hard-QA 승인은 다음 단계(P1)에서 제공합니다 — QA 호출.',
    warning_reason_only: 'Warning 은 서명 없이 사유 입력 후 진행합니다.', already_approved: '이미 승인된 인터록입니다.', no_batch: '배치가 없습니다.', bad_hit: '승인할 인터록 적중 정보가 없습니다.',
    bad_ticket: '서명 창이 만료되었습니다 — 다시 여세요.', no_session: '사용자 세션 모듈을 찾을 수 없습니다.', bad_preset: '알 수 없는 데모 프리셋입니다.', not_demo: '데모 모드가 아닙니다.'
  };
  var REASON_TABLE = 'EBR_OVR_REASON', REASON_MAX = 60;
  var BUILTIN_REASONS = [['LOSS_CONFIRMED', '공정 손실 확인', false], ['SAMPLING', '시료 채취', false], ['EQUIP_ADJUST', '설비 조정', false], ['OTHER', '기타', true]];
  var DEMO_BATCHES = { exec: 'BR-DEMO-0001', tree: 'BR-DEMO-0003' };   /* tree = 공정 트리 준수 데모 배치 (예약, 이 단계에서는 시드 없음) */

  /* ---------------------------------------------------------------- 공통 */
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function str(v) { return String(v == null ? '' : v).trim(); }
  function num(v) { if (v === '' || v == null || typeof v === 'boolean') return NaN; var x = Number(v); return isFinite(x) ? x : NaN; }
  function p2(n) { return (n < 10 ? '0' : '') + n; }
  function localYmd(d) { d = d || new Date(); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); }
  function ymdToUtc(s) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN; }
  function daysUntil(d, today) { var a = ymdToUtc(d), b = ymdToUtc(today); return isNaN(a) || isNaN(b) ? null : Math.round((a - b) / 86400000); }
  function addDays(ymd, n) { var a = ymdToUtc(ymd); var d = new Date(a + n * 86400000); return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()); }
  function charLen(s) { return Array.from(String(s == null ? '' : s)).length; }
  function fnv(s, seed) { var h = seed >>> 0; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return ('0000000' + h.toString(16)).slice(-8); }
  /* 기준정보 MS.calcHash 와 같은 계산 (shared-store.js — 운영 · 표시 필드 제외) */
  var HASH_SKIP = ['hash', 'status', 'upd', 'effDate', 'wu', 'online', 'beat', 'pkg', 'frozen', 'members', 'eqRefHashNow'];
  /* S1: 정규화 — 중첩 객체까지 키 정렬 (MS.calcHash 와 같은 식) */
  function canon(v) { if (Array.isArray(v)) return v.map(canon); if (v && typeof v === 'object') { var o = {}; Object.keys(v).sort().forEach(function (k) { o[k] = canon(v[k]); }); return o; } return v; }
  function calcHash(row, algo) {
    var o = {}; Object.keys(row).sort().forEach(function (k) { if (HASH_SKIP.indexOf(k) < 0) o[k] = row[k]; });
    /* 인터록 룰 세트 행: status · effDate 도 행 무결성 범위 (B2 — 서명 없이 상태만 바꾸는 변조 탐지) */
    if (row.kind === 'interlock') { if (row.status != null) o.__status = row.status; if (row.effDate != null) o.__effDate = row.effDate; }
    /* C3: 행별 hashVer — 없음 · 1 = 옛 식(6f3accb: 최상위 키만 정렬), 2 = 중첩 키 정렬. 서명된 행은 서명 당시 형식 그대로 검증 */
    var s = JSON.stringify((algo || (Number(row.hashVer) === 2 ? 2 : 1)) === 2 ? canon(o) : o); return fnv(s, 0x811c9dc5) + fnv(s, 0x01000193) + fnv(s, 0x2c59d9) + fnv(s, 0x37b284);
  }
  /* 서명 대상 내용 hash (MS.ilrContentHash 와 같은 식) — 서명 기록 · 상태 · 효력일 제외 */
  function contentHash(row, algo) { var c = Object.assign({}, row); ['ilrReview', 'ilrApprove', 'reviewer', 'status', 'effDate'].forEach(function (k) { delete c[k]; }); return calcHash(c, algo); }
  /* 결정 3: hashVer 없는 행 = 옛 식, 안 맞으면 v2 식(b6baec8–5072ef2 저장본)으로 한 번 더 — 행 hash · 내용 hash 를 같은 식으로 봄. hashVer 가 적힌 행(1 · 2)은 폴백 없음 */
  function algosOf(row) { return row.hashVer == null ? [1, 2] : [Number(row.hashVer) === 2 ? 2 : 1]; }
  function hashOk(row, a) { if (calcHash(row, a) === row.hash) return true;
    /* 서명 행은 hash 를 다시 쓰지 않음 — 대체(superseded)는 서명 당시 상태(effective · approved)로 계산한 hash 와 같아야 함 */
    return !!(row.ilrApprove && row.ilrApprove.signatureId && row.status === 'superseded' && ['effective', 'approved'].some(function (st) { return calcHash(Object.assign({}, row, { status: st }), a) === row.hash; })); }
  function rowAlgo(row) { var c = algosOf(row); for (var i = 0; i < c.length; i++) if (hashOk(row, c[i])) return c[i]; return 0; }   /* 0 = 어느 식으로도 안 맞음 */
  /* 시드(서명 이전 이관본) 예외: 이 (세트, 버전)이고 본문이 시드 본문과 같을 때만 서명 없이 효력 인정 */
  /* N2: 시드 원본 전체(kind · id · ver · apply · name · body 전부)의 내용 hash 고정 상수 — 하나라도 바뀌면 예외 아님. 시드를 고치면 같이 갱신 (시험 check-interlock-review 'N2 상수') */
  /* hashVer 별: v1 = 6f3accb 이전 저장본(hashVer 없음), v2 = 현재 시드(hashVer 2) */
  var SEED_CONTENT_HASH = {
    v1: { 'ILR-STD|7': '05ad58b64f8e135c5c9062527d700cd9', 'ILR-WEIGH|3': '397f6fd7933e99491bda0193b2b82562', 'ILR-DEMO|1': '2e5e913ece04293c1220aeba7ea6cb99' },
    v2nover: { 'ILR-STD|7': '1092cd1c5f7245da3d11b0b87a62b027', 'ILR-WEIGH|3': '8be2398da35c9d57acfbd5c9ef3b0dc8', 'ILR-DEMO|1': '8450fca4c9f3413a9fb9df5004c4d567' },   /* b6baec8–5072ef2 저장본(hashVer 없음 · v2 식) */
    v2: { 'ILR-STD|7': '784e00e94fc1058b07b0ce3de319712a', 'ILR-WEIGH|3': '9166c1660b24a97cc2219dca1a88e8bf', 'ILR-DEMO|1': '9df4a7edf74c7a2786be7d81c33f0636' } };
  function tmpl(msg, vars) { return String(msg || '').replace(/\{(\w+(?:\.\w+)?)\}/g, function (m, k) { var v = vars[k]; return v == null || v === '' ? m : String(v); }); }
  function getPath(o, path) { return String(path).split('.').reduce(function (a, k) { return a == null ? undefined : a[k]; }, o); }

  /* ---------------------------------------------------------------- 조건 유형 (코드 · K-3) — I1-12 params 스키마
     ev(params, ctx) → { hit, value, vars } . weigh.gate 조건은 칭량 store 가 넘긴 사실(ctx.facts[G] = {ok, reason}, ctx.days)을 읽는다 (판정 본문 = gateCheck 그대로) */
  function factCond(g) { return function (p, c) { var f = (c.facts || {})[g] || {}; return { hit: f.ok === false, value: f.ok === false ? f.reason || '' : '', vars: { reason: f.reason || '' } }; }; }
  var P_DAYS = function (def, max) { return [{ key: 'days', label: '일수', type: 'int', unit: '일', min: 1, max: max, required: true, def: def }]; };
  var COND_TYPES = {
    'snapshot.present': { label: '발행 스냅샷 · 칭량 계획', points: ['weigh.gate'], params: [], ev: factCond('G1') },
    'lot.reserved': { label: '예약 LOT', points: ['weigh.gate'], params: [], ev: factCond('G2') },
    'lot.matMatch': { label: '자재 일치', points: ['weigh.gate'], params: [], ev: factCond('G3') },
    'lot.released': { label: 'LOT 적합', points: ['weigh.gate'], params: [], ev: factCond('G4') },
    'lot.retestPassed': { label: '재시험일', points: ['weigh.gate', 'exec.step'], params: [], ev: function (p, c) {
      if (c.facts) return factCond('G5')(p, c);
      var bad = (c.lots || []).filter(function (l) { var d = daysUntil(l.retestDate, c.today); return d != null && d < 0; })[0];
      return { hit: !!bad, value: bad ? bad.retestDate : '', vars: bad ? { lotNo: bad.lotNo, materialId: bad.materialId || '', retestDate: bad.retestDate } : {} }; } },
    'lot.expired': { label: '유효기간', points: ['weigh.gate', 'exec.step'], params: [], ev: function (p, c) {
      if (c.facts) return factCond('G6')(p, c);
      var bad = (c.lots || []).filter(function (l) { var d = daysUntil(l.expiryDate, c.today); return d != null && d < 0; })[0];
      return { hit: !!bad, value: bad ? bad.expiryDate : '', vars: bad ? { lotNo: bad.lotNo, expiryDate: bad.expiryDate } : {} }; } },
    'lot.dateNear': { label: '날짜 임박', points: ['weigh.gate'], params: P_DAYS(30, 365), ev: function (p, c) {
      var d = c.days || {}, n = Number(p.days), near = [];
      if (d.retest != null && d.retest >= 0 && d.retest <= n) near.push('재시험일 ' + d.retestDate + ' (' + d.retest + '일 남음)');
      if (d.expiry != null && d.expiry >= 0 && d.expiry <= n) near.push('유효기간 ' + d.expiryDate + ' (' + d.expiry + '일 남음)');
      return { hit: near.length > 0, value: near.join(' · '), vars: { reason: near.join(' · ') } }; } },
    'lot.short': { label: 'LOT 잔량', points: ['weigh.gate'], params: [], ev: factCond('G8') },
    'bal.state': { label: '저울 상태', points: ['weigh.gate'], params: [], ev: factCond('G9') },
    'bal.calExpired': { label: '저울 교정', points: ['weigh.gate'], params: [], ev: factCond('G10') },
    'bal.calDueSoon': { label: '교정 임박', points: ['weigh.gate'], params: P_DAYS(7, 90), ev: function (p, c) {
      var d = c.days || {}, cd = d.cal, hit = cd != null && cd >= 0 && cd <= Number(p.days);
      var r = hit ? '저울 ' + d.balanceId + ' 교정일 ' + d.calDue + ' (' + cd + '일 남음)' : '';
      return { hit: hit, value: r, vars: { reason: r } }; } },
    'bal.dailyCheck': { label: '일상 점검', points: ['weigh.gate'], params: [], ev: factCond('G12') },
    'bal.range': { label: '저울 용량', points: ['weigh.gate'], params: [], ev: factCond('G13') },
    'bal.qualified': { label: '저울 적격', points: ['weigh.gate'], params: [], ev: factCond('G14') },
    'room.clean': { label: '칭량실', points: ['weigh.gate'], params: [], ev: factCond('G15') },
    'dev.openWeigh': { label: '열린 칭량 일탈', points: ['weigh.gate'], params: [], ev: factCond('G16') },
    'tol.outOfRange': { label: '허용오차 반복 이탈', points: ['weigh.tolerance'], params: [{ key: 'maxAttempts', label: '최대 시도', type: 'int', unit: '회', min: 1, max: 5, required: true, def: 2 }], ev: function (p, c) {
      var net = num(c.net), lo = num(c.lo), hi = num(c.hi), out = !isNaN(net) && (net < lo || net > hi);
      return { hit: out && Number(c.attempt) >= Number(p.maxAttempts), value: c.net, vars: { attempt: c.attempt, net: c.net, lo: c.lo, hi: c.hi } }; } },
    'step.sequence': { label: '순서', points: ['exec.step', 'exec.order', 'pack.step'], params: [], ev: function (p, c) {
      /* 순서 판정은 공정 트리 실행 소관 (트리 준수 설계 X1 — 어댑터): EbrTreeExec.interlockAdapter 위임, 없으면 ctx.prevDone/prevSigned. 위임 중 예외 = 적중(fail-closed) */
      var T = global.EbrTreeExec, r = null;
      if (T && !T.STUB && typeof T.interlockAdapter === 'function' && c.batchId && c.nodeId) { try { r = T.interlockAdapter({ batchId: c.batchId, scope: c.scope || (c.point === 'pack.step' ? 'pack' : 'prod'), nodeId: c.nodeId }); } catch (e) { r = { hit: true, why: 'tree_snapshot_missing' }; } }
      if (r && r.na) r = null;
      var ok = r ? !r.hit : (c.prevDone !== false && c.prevSigned !== false);
      return { hit: !ok, value: ok ? '' : (r && r.msg ? r.msg : '선행 단계 미완료'), vars: r && r.why ? { treeWhy: r.why } : {} }; } },
    'eq.qualified': { label: '장비 적격', points: ['exec.step'], params: [{ key: 'opIds', label: '대상 OP', type: 'string[]', min: 1, max: 20, pattern: '^OP\\d-\\d$', required: true }], ev: function (p, c) {
      if ((p.opIds || []).indexOf(str(c.opId)) < 0) return { hit: false, value: '', vars: {} };
      var bad = (c.equipment || []).filter(function (e) { return e && e.ops && e.ops.indexOf(str(c.opId)) >= 0 && (e.qualified === false || (daysUntil(e.calDue, c.today) != null && daysUntil(e.calDue, c.today) < 0)); })[0];
      if (!bad && c.eqClassOk === false) return { hit: true, value: '장비 클래스 불일치', vars: {} };
      return { hit: !!bad, value: bad ? bad.eqId + ' 교정 ' + bad.calDue : '', vars: bad ? { eqId: bad.eqId, calDue: bad.calDue } : {} }; } },
    'eq.calDueSoon': { label: '교정 임박', points: ['exec.step', 'pack.equipment'], params: P_DAYS(14, 90), ev: function (p, c) {
      var list = c.equipment || (c.eqId ? [{ eqId: c.eqId, calDue: c.calDue }] : []);
      var bad = list.filter(function (e) { var d = daysUntil(e.calDue, c.today); return d != null && d >= 0 && d <= Number(p.days); })[0];
      return { hit: !!bad, value: bad ? 'D-' + daysUntil(bad.calDue, c.today) : '', vars: bad ? { eqId: bad.eqId, n: daysUntil(bad.calDue, c.today), calDue: bad.calDue } : {} }; } },
    'eq.calExpired': { label: '설비 교정 만료', points: ['pack.equipment'], params: [], ev: function (p, c) {
      var d = daysUntil(c.calDue, c.today); return { hit: d == null || d < 0, value: c.calDue || '', vars: { eqId: c.eqId, calDue: c.calDue } }; } },
    'hold.exceeded': { label: '보류 시간 초과', points: ['exec.step'], params: [{ key: 'min', label: '기준', type: 'int', unit: '분', min: 1, max: 10080, required: true }], ev: function (p, c) {
      var m = num(c.holdMin); return { hit: !isNaN(m) && m > Number(p.min), value: isNaN(m) ? '' : m, vars: { holdMin: isNaN(m) ? '' : m } }; } },
    'range': { label: '범위 밖', points: ['exec.step', 'pack.reconcile'], params: [{ key: 'field', label: '항목', type: 'field', required: true }, { key: 'lo', label: '하한', type: 'number', min: -1e6, max: 1e6, required: true },
      { key: 'hi', label: '상한', type: 'number', min: -1e6, max: 1e6, required: true }, { key: 'unit', label: '단위', type: 'string', max: 8, required: false }], ev: function (p, c) {
      var v = num(getPath(c, p.field)); if (isNaN(v)) return { hit: false, value: '', vars: {}, missing: true };
      var o = { hit: v < Number(p.lo) || v > Number(p.hi), value: v, vars: {} }; o.vars[p.field] = v; o.vars[String(p.field).split('.').pop()] = v; return o; } },
    'below': { label: '하한 미만', points: ['exec.step', 'pack.reconcile'], params: [{ key: 'field', label: '항목', type: 'field', required: true }, { key: 'lo', label: '하한', type: 'number', min: -1e6, max: 1e6, required: true },
      { key: 'unit', label: '단위', type: 'string', max: 8, required: false }], ev: function (p, c) {
      var v = num(getPath(c, p.field)); if (isNaN(v)) return { hit: false, value: '', vars: {}, missing: true };
      var o = { hit: v < Number(p.lo), value: v, vars: {} }; o.vars[p.field] = v; return o; } },
    'scan.match': { label: '스캔 일치', points: ['pack.scan'], params: [{ key: 'fields', label: '대조 항목', type: 'enum[]', options: ['code', 'lot', 'ver', 'qc', 'exp'], min: 1, required: true }], ev: function (p, c) {
      var e = c.expected || {}, s = c.scanned || {}, bad = (p.fields || []).filter(function (f) { return str(e[f]) !== str(s[f]); });
      return { hit: bad.length > 0, value: bad.join(','), vars: { fields: bad.join(', ') } }; } },
    'il.activeAbsolute': { label: '활성 Absolute', points: ['exec.sign'], params: [], ev: function (p, c) {
      return { hit: !!c.activeAbsolute, value: c.activeAbsolute ? str(c.activeAbsolute.ruleId || c.activeAbsolute) : '', vars: {} }; } },
    'sign.qualified': { label: '수행자 자격', points: ['exec.sign'], params: [], ev: function (p, c) {
      return { hit: c.qualOk === false, value: c.qualOk === false ? str(c.userId) : '', vars: { userId: c.userId || '' } }; } }
  };

  /* ---------------------------------------------------------------- 시드 규칙 (기준정보 shared-store.js ILR_RULES_V8 · ILR_DEMO 와 같은 내용 — 시험이 대조)
     ILR-STD rules (M1: 현재 숫자 그대로, legacyRef = 이관 출처). absolute[] 4항목 = floorRef 0..3 */
  function R(ruleId, name, point, cond, grade, msg, o) {
    o = o || {};
    return { ruleId: ruleId, name: name, point: point, cond: cond, grade: grade, msg: msg, actions: o.actions || [], sopRef: o.sopRef || '', floor: o.floorRef != null ? 'Absolute' : null,
             floorRef: o.floorRef != null ? o.floorRef : null, locked: o.floorRef != null || !!o.locked, enabled: true, legacyRef: o.legacyRef || '' };
  }
  var STD_RULES = [
    R('IL-WG-SNAPSHOT', '발행 스냅샷 · 칭량 계획', 'weigh.gate', { type: 'snapshot.present' }, 'Absolute', '{reason}', { legacyRef: 'G1' }),
    R('IL-WG-LOT-RESV', '예약 LOT', 'weigh.gate', { type: 'lot.reserved' }, 'Absolute', '{reason}', { legacyRef: 'G2' }),
    R('IL-WG-MAT-MATCH', '자재 일치', 'weigh.gate', { type: 'lot.matMatch' }, 'Absolute', '{reason}', { legacyRef: 'G3', floorRef: 0 }),
    R('IL-WG-LOT-REL', 'LOT 적합', 'weigh.gate', { type: 'lot.released' }, 'Absolute', '{reason}', { legacyRef: 'G4', floorRef: 3 }),
    R('IL-WG-LOT-RETEST', '재시험일', 'weigh.gate', { type: 'lot.retestPassed' }, 'Absolute', '{reason}', { legacyRef: 'G5', floorRef: 3 }),
    R('IL-WG-LOT-EXP', '유효기간', 'weigh.gate', { type: 'lot.expired' }, 'Absolute', '{reason}', { legacyRef: 'G6', floorRef: 3 }),
    R('IL-WG-LOT-NEAR', '날짜 임박', 'weigh.gate', { type: 'lot.dateNear', days: 30 }, 'Warning', '{reason}', { legacyRef: 'G7 (NEAR_LOT_DAYS 30)' }),
    R('IL-WG-LOT-SHORT', 'LOT 잔량', 'weigh.gate', { type: 'lot.short' }, 'Absolute', '{reason}', { legacyRef: 'G8' }),
    R('IL-WG-BAL-STATE', '저울 상태', 'weigh.gate', { type: 'bal.state' }, 'Absolute', '{reason}', { legacyRef: 'G9' }),
    R('IL-WG-BAL-CAL', '저울 교정', 'weigh.gate', { type: 'bal.calExpired' }, 'Absolute', '{reason}', { legacyRef: 'G10', floorRef: 1 }),
    R('IL-WG-BAL-CALDUE', '교정 임박', 'weigh.gate', { type: 'bal.calDueSoon', days: 7 }, 'Warning', '{reason}', { legacyRef: 'G11 (NEAR_CAL_DAYS 7)' }),
    R('IL-WG-BAL-DAILY', '일상 점검', 'weigh.gate', { type: 'bal.dailyCheck' }, 'Absolute', '{reason}', { legacyRef: 'G12' }),
    R('IL-WG-BAL-RANGE', '저울 용량', 'weigh.gate', { type: 'bal.range' }, 'Absolute', '{reason}', { legacyRef: 'G13' }),
    R('IL-WG-BAL-QUAL', '저울 적격', 'weigh.gate', { type: 'bal.qualified' }, 'Absolute', '{reason}', { legacyRef: 'G14', floorRef: 1 }),
    R('IL-WG-ROOM', '칭량실', 'weigh.gate', { type: 'room.clean' }, 'Absolute', '{reason}', { legacyRef: 'G15' }),
    R('IL-WG-DEV', '열린 칭량 일탈', 'weigh.gate', { type: 'dev.openWeigh' }, 'Absolute', '{reason}', { legacyRef: 'G16' }),
    R('IL-WG-TOL', '칭량 허용오차 반복 이탈', 'weigh.tolerance', { type: 'tol.outOfRange', maxAttempts: 2 }, 'Hard-QA', '{attempt}회째 허용오차 이탈 ({net}, 기준 {lo} ~ {hi}) — 일탈 · QA 호출', { legacyRef: 'MAX_ATTEMPTS 2 · DISPENSE_DEVIATION' }),
    R('IL-EX-SEQ', '실행 순서', 'exec.step', { type: 'step.sequence' }, 'Absolute', '순서 인터록: 선행 단계 완료 전 시작할 수 없습니다.', { legacyRef: 'stepStatus · completeCurrentOp' }),
    R('IL-EX-LOT-EXP', '투입 LOT 유효기간', 'exec.step', { type: 'lot.expired' }, 'Absolute', 'LOT {lotNo}: 유효기간 경과 ({expiryDate}) — 투입 불가', { floorRef: 3, legacyRef: 'MatQC.assertWeighable' }),
    R('IL-EX-SIGN-ABS', '활성 Absolute 서명 차단', 'exec.sign', { type: 'il.activeAbsolute' }, 'Absolute', '인터록 활성 — 서명할 수 없습니다.', { legacyRef: 'openSign' }),
    R('IL-EX-SIGN-QUAL', '자격 미보유 수행자 서명', 'exec.sign', { type: 'sign.qualified' }, 'Absolute', '{userId}: 자격 미보유 — 서명할 수 없습니다.', { floorRef: 2, legacyRef: '교육 · 자격 ⑦' }),
    R('IL-PK-SCAN', '포장 자재 스캔 대조', 'pack.scan', { type: 'scan.match', fields: ['code', 'lot', 'ver', 'qc', 'exp'] }, 'Absolute', 'Absolute 인터록 — 사용 불가 ({fields} 불일치)', { floorRef: 0, legacyRef: 'scan(val)' }),
    R('IL-PK-YIELD', '포장 수율 범위', 'pack.reconcile', { type: 'range', field: 'yieldPct', lo: 98.0, hi: 100.5, unit: '%' }, 'Warning', '수율 {yieldPct} % - 기준 {lo} ~ {hi} % 이탈 (사유 입력 후 진행)', { actions: [{ t: '사유 입력' }], sopRef: 'SOP-PK-010 v4', legacyRef: 'recCalc yieldOk' }),
    R('IL-PK-YIELD-LO', '포장 수율 하한 미만', 'pack.reconcile', { type: 'below', field: 'yieldPct', lo: 98.0, unit: '%' }, 'Controlled', '수율 {yieldPct} % - 하한 {lo} % 미만, 감독자 승인 필요', { actions: [{ t: '감독자 호출' }], sopRef: 'SOP-PK-010 v4', legacyRef: 'recCalc yieldOk (하한 쪽)' }),
    R('IL-PK-DIFF', '포장 미설명 차이', 'pack.reconcile', { type: 'range', field: 'diffPct', lo: -0.5, hi: 0.5, unit: '%' }, 'Warning', '미설명 차이 {diffPct} % - 기준 ±0.5 % 이탈 (사유 입력 후 진행)', { actions: [{ t: '사유 입력' }], sopRef: 'SOP-PK-010 v4', legacyRef: 'recCalc diffOk' }),
    R('IL-PK-CW-CALDUE', '체크웨이어 교정 임박', 'pack.equipment', { type: 'eq.calDueSoon', days: 14 }, 'Warning', '{eqId} 교정 D-{n} — 실행 허용(Warning). 만료되면 Absolute', { legacyRef: 'clrPane 배너' }),
    R('IL-PK-CW-CAL', '체크웨이어 교정 만료', 'pack.equipment', { type: 'eq.calExpired' }, 'Absolute', '{eqId} 교정 만료 ({calDue}) — 사용 불가', { floorRef: 1, legacyRef: 'clrPane 배너' }),
    R('IL-PK-SEQ', '포장 순서', 'pack.step', { type: 'step.sequence' }, 'Absolute', '순서 인터록: 이전 단계 서명 전 다음 단계 입력 불가', { legacyRef: '포장 단계 패널' })
  ];
  /* ILR-DEMO v1 (§6.1 데모 시드 규칙 5 — 생산 데모 토글 대체) */
  var DEMO_RULES = [
    R('IL-DEMO-LOT-RETEST', '데모 재시험일 경과 LOT', 'exec.step', { type: 'lot.retestPassed' }, 'Absolute', '{lotNo}: 재시험일 경과 자재 — override 불가, 대체 경로만', { locked: true, legacyRef: '#demoIlAbs' }),
    R('IL-DEMO-IPC-HARDNESS', '데모 IPC 경도', 'exec.step', { type: 'range', field: 'ipc.hardness', lo: 60, hi: 120, unit: 'N' }, 'Hard-QA', '경도 {hardness} N — 규격 {lo}~{hi} N 이탈, QA 호출', { legacyRef: '#demoIlHard' }),
    R('IL-DEMO-HOLD-TIME', '데모 과립 보류 시간', 'exec.step', { type: 'hold.exceeded', min: 240 }, 'Controlled', '과립 보류 {holdMin}분 — 기준 {min}분 초과, 감독자 승인', { actions: [{ t: '감독자 호출' }], legacyRef: '#demoIlCtrl' }),
    R('IL-DEMO-EQ-CALDUE', '데모 설비 교정 임박', 'exec.step', { type: 'eq.calDueSoon', days: 14 }, 'Warning', '{eqId} 교정 D-{n} — 사유 입력 후 진행', { legacyRef: '#demoIlWarn' }),
    R('IL-DEMO-EQ-QUAL', '데모 장비 적격', 'exec.step', { type: 'eq.qualified', opIds: ['OP2-1', 'OP2-2'] }, 'Absolute', '장비 적격 실패(교정 만료) — {eqId}', { locked: true, legacyRef: '#demoEqFail · state.eqFail' })
  ];
  var ABS_ITEMS = ['칭량 원료 ID · LOT 불일치', '설비 교정 만료 · 미적격 설비 (장비 클래스 적격 목록 밖)', '자격 미보유 수행자 서명', '유효기간 경과 · 부적합 판정 LOT 투입'];
  function G(grade, override, role, auth, dev, block, scope, limit, locked) { return { grade: grade, override: override, role: role, auth: auth, dev: dev, block: block, scope: scope, limit: limit, locked: !!locked }; }
  var GRADE_ROWS = [G('Absolute', false, 'none', '', false, 'none', 'product_floor', 'override 불가 · P-52 대체 경로', true), G('Hard-QA', true, 'qa', 'full_factor', true, 'deviation', 'product_floor', '배치당 1회', true),
    G('Controlled', true, 'supervisor', 'full_factor', false, 'rbe', 'site', 'RBE 예외 자동 생성', false), G('Warning', true, 'self', 'pin_session', false, 'none', 'site', '사유 입력 후 진행', false)];
  var BUILTIN_SETS = {
    'ILR-STD': { kind: 'interlock', id: 'ILR-STD', ver: 7, status: 'effective', apply: 'site', effDate: '2026-07-15', body: { grades: clone(GRADE_ROWS), absolute: ABS_ITEMS.slice(), rules: clone(STD_RULES) } },
    'ILR-DEMO': { kind: 'interlock', id: 'ILR-DEMO', ver: 1, status: 'effective', apply: 'demo', effDate: '2026-10-12', body: { grades: clone(GRADE_ROWS), absolute: [], rules: clone(DEMO_RULES), demo: true } }
  };

  /* ---------------------------------------------------------------- 규칙 검증 (저장 · 승인 전, §4) */
  var RULE_ID_RE = /^IL(-[A-Z0-9]+)+$/;
  function checkParam(def, v) {
    if (v == null || v === '') return def.required ? 'required' : null;
    if (def.type === 'int' || def.type === 'number') {
      var x = Number(v); if (!isFinite(x) || (def.type === 'int' && Math.floor(x) !== x)) return def.type;
      if ((def.min != null && x < def.min) || (def.max != null && x > def.max)) return def.min + '–' + def.max + (def.unit ? ' ' + def.unit : '');
      return null;
    }
    if (def.type === 'string') return typeof v === 'string' && charLen(v) <= (def.max || 64) ? null : '0–' + (def.max || 64) + '자';
    if (def.type === 'field') return typeof v === 'string' && /^[A-Za-z][\w.]*$/.test(v) ? null : 'field';
    if (def.type === 'string[]') {
      if (!Array.isArray(v) || v.length < (def.min || 0) || v.length > (def.max || 99)) return (def.min || 0) + '–' + (def.max || 99) + '개';
      var re = def.pattern ? new RegExp(def.pattern) : null; return re && v.some(function (s) { return !re.test(String(s)); }) ? def.pattern : null;
    }
    if (def.type === 'enum[]') return Array.isArray(v) && v.length >= (def.min || 1) && v.every(function (s) { return def.options.indexOf(s) >= 0; }) ? null : def.options.join(' · ') + ' 중 1개 이상';
    return null;
  }
  function validateRules(body, prev) {
    var errs = [], ids = {};
    function e(why, o) { var r = Object.assign({ why: why }, o || {}); r.message = tmpl(WHY_TEXT[why] || why, { key: r.key || '', range: r.range || '', item: r.item || '' }); errs.push(r); }
    if (!body || !Array.isArray(body.rules)) { e('bad_param', { key: 'rules', range: '배열' }); return { ok: false, errors: errs }; }
    body.rules.forEach(function (r) {
      var id = str(r && r.ruleId);
      if (!RULE_ID_RE.test(id)) e('bad_rule_id', { ruleId: id });
      if (ids[id]) e('dup_rule_id', { ruleId: id }); ids[id] = 1;
      if (POINTS.indexOf(r.point) < 0) e('unknown_point', { ruleId: id });
      var ct = r.cond && COND_TYPES[r.cond.type];
      if (!ct) e('unknown_cond', { ruleId: id });
      else {
        if (POINTS.indexOf(r.point) >= 0 && ct.points.indexOf(r.point) < 0) e('unknown_point', { ruleId: id, key: 'point' });
        ct.params.forEach(function (d) { var bad = checkParam(d, r.cond[d.key]); if (bad) e('bad_param', { ruleId: id, key: d.key, range: bad }); });
        if (r.cond.type === 'range' && Number(r.cond.lo) > Number(r.cond.hi)) e('bad_param', { ruleId: id, key: 'lo', range: 'lo ≤ hi' });
      }
      if (GRADES.indexOf(r.grade) < 0) e('bad_param', { ruleId: id, key: 'grade', range: GRADES.join(' · ') });
      if ((r.floor === 'Absolute' || r.locked) && (r.grade !== 'Absolute' || r.enabled === false)) e('floor_violation', { ruleId: id });
    });
    (body.absolute || []).forEach(function (item, i) {
      if (!body.rules.some(function (r) { return r && r.floorRef === i && r.locked && r.enabled !== false && r.grade === 'Absolute'; })) e('floor_uncovered', { item: item, index: i });
    });
    /* prev(효력 버전 규칙): 잠금 규칙은 삭제 · 등급 하향 · 비활성 불가 */
    (Array.isArray(prev) ? prev : prev && Array.isArray(prev.rules) ? prev.rules : []).forEach(function (o) {
      if (!o || !o.locked) return;
      var n = body.rules.filter(function (r) { return r && str(r.ruleId) === o.ruleId; })[0];
      if (!n) e('locked_removed', { ruleId: o.ruleId });
      else if (GRADE_RANK[n.grade] > GRADE_RANK[o.grade] || n.enabled === false) e('floor_violation', { ruleId: o.ruleId });
    });
    return { ok: !errs.length, errors: errs };
  }

  /* ================================================================ 인스턴스 */
  function create(opts) {
    opts = opts || {};
    var hitLogged = {}, tickets = {}, failNext = null, evalSeen = {};
    function storage() { return opts.storage || global.localStorage; }
    function S() { return opts.session || global.EbrUserSession || null; }
    function today() { return typeof opts.today === 'function' ? opts.today() : (opts.today || localYmd()); }
    function nowMs() { return typeof opts.now === 'function' ? Date.parse(opts.now()) : Date.now(); }
    function readRaw(k) { try { return storage().getItem(k); } catch (e) { return undefined; } }
    function readJson(k) { var r = readRaw(k); if (r === undefined) return undefined; if (r == null || r === '') return null; try { return JSON.parse(r); } catch (e) { return undefined; } }
    function items(k) { var o = readJson(k); return o && Array.isArray(o.items) ? o.items : []; }
    function writeJson(k, v) { storage().setItem(k, JSON.stringify(v)); }
    function fail(why, extra) { var r = { ok: false, why: why, message: WHY_TEXT[why] || why }; if (extra) Object.keys(extra).forEach(function (k) { r[k] = extra[k]; }); return r; }

    /* ---- 규칙 세트 읽기: 기준정보 키 없음 → 내장본(builtin) / 파싱 실패 · config 없음 · 해시 불일치 → ilr_store_error (fail-closed) */
    function master() {
      var raw = readRaw(KEYS.MASTER);
      if (raw === undefined) return { error: true };
      if (raw == null) return { builtin: true };
      try { var o = JSON.parse(raw); if (!o || o.v !== MASTER_V || !Array.isArray(o.config)) return { error: true }; return { db: o }; } catch (e) { return { error: true }; }
    }
    function builtinRow(id) { var b = BUILTIN_SETS[id]; if (!b) return null; var r = clone(b); r.hash = calcHash(r); Object.defineProperty(r, 'source', { value: 'builtin', enumerable: false }); return r; }
    function rowsOf(m, id) { return m.builtin ? [builtinRow(id)].filter(Boolean) : m.db.config.filter(function (r) { return r && r.kind === 'interlock' && r.id === id; }); }
    function esignAll() { var l = readJson('ebr.esign.v1'); return Array.isArray(l) ? l : (l && Array.isArray(l.items) ? l.items : []); }
    function ilrApprovals() {
      var t = today(), out = { list: [], skew: null };
      esignAll().forEach(function (x) {
        if (!x || x.status !== 'valid' || x.signRuleId !== 'SM-APPR-ILR' || !x.setId) return;
        var sd = str(x.signedAt).slice(0, 10), eff = str(x.effDate || sd);
        if (sd && sd > t && !out.skew) out.skew = x;
        out.list.push({ setId: x.setId, ver: Number(x.ver), effDay: eff < sd ? sd : eff, signatureId: x.signatureId, hash: x.hash, effDate: x.effDate || null });
      });
      return out;
    }
    function esignById(id) { var l = readJson('ebr.esign.v1'); var a = Array.isArray(l) ? l : (l && Array.isArray(l.items) ? l.items : []); return a.filter(function (x) { return x && x.signatureId === id; })[0] || null; }
    /* B2 · W1: 기준정보 저장 행 무결성 — hash 필수 · 행 hash(상태 · 효력일 포함) · 승인 서명(원장 대조) · 서명 내용 hash · 효력일. 실패 → detail */
    function verifyRow(r, signedVers) {
      if (!r || r.source === 'builtin') return null;
      if (!r.hash) return 'hash_missing';
      var ap = r.ilrApprove, signed = !!(ap && ap.signatureId);
      var algo = rowAlgo(r);
      if (!algo) {
        /* 서명 행은 hash 를 다시 쓰지 않음 — 대체(superseded)는 서명 당시 상태(effective · approved)로 계산한 hash 와 같아야 함 */
        return 'hash_mismatch';
      }
      var ch = contentHash(r, algo);
      if (signed) {
        if (ap.contentHash !== ch) return 'signed_content_mismatch';
        if (ap.effDate != null && str(ap.effDate) !== str(r.effDate)) return 'eff_date_mismatch';
        var sg = esignById(ap.signatureId);
        if (!sg || sg.status !== 'valid' || sg.signRuleId !== 'SM-APPR-ILR' || sg.setId !== r.id || Number(sg.ver) !== Number(r.ver) || sg.hash !== ch) return 'approval_signature_invalid';
        if (sg.effDate != null && str(sg.effDate) !== str(r.effDate)) return 'eff_date_mismatch';   /* C2: 효력일은 원장 기록과 대조 */
        return null;
      }
      /* 시드(서명 이전 이관본) 예외: 원본 전체 hash 일치 + 같은 세트에 서명된 버전이 하나도 없을 때만 (N2 · N3) */
      var chSeed = ch;
      if (r.body && !Array.isArray(r.body.rules) && BUILTIN_SETS[r.id]) { var rb = clone(r); rb.body.rules = clone(BUILTIN_SETS[r.id].body.rules); chSeed = contentHash(rb, algo); }   /* rules[] 없는 옛 저장본: 보충한 결과가 원본과 같아야 함 */
      if (SEED_CONTENT_HASH[Number(r.hashVer) === 2 ? 'v2' : algo === 2 ? 'v2nover' : 'v1'][r.id + '|' + r.ver] === chSeed) { if (signedVers && signedVers.length) return 'seed_after_signed'; return null; }
      return 'unsigned_set';
    }
    function isEff(r, t) { return r && (r.status === 'effective' || (r.status === 'approved' && r.effDate && r.effDate <= t)) && (!r.effDate || r.effDate <= t); }
    function pickEffective(rows, t) { return rows.filter(function (r) { return isEff(r, t); }).sort(function (a, b) { return (b.ver || 0) - (a.ver || 0); })[0] || null; }
    /* 저장 행 → 규칙 목록. rules[] 없는 옛 저장본(이관 전 v7 등)은 내장 규칙을 보충(backfill) */
    function rulesOfRow(r) {
      if (r.body && Array.isArray(r.body.rules)) return { rules: clone(r.body.rules), source: r.source || 'master' };
      var b = BUILTIN_SETS[r.id]; return { rules: b ? clone(b.body.rules) : [], source: 'backfill' };
    }
    function demoOn(o) { return !!(o && o.demo) || readRaw(KEYS.DEMO) != null; }
    function frozenOf(batchId) {
      var l = readJson(KEYS.ISSUED); if (l === undefined) return { error: true };
      var arr = Array.isArray(l) ? l : (l && Array.isArray(l.batches) ? l.batches : (l && Array.isArray(l.items) ? l.items : []));
      var b = arr.filter(function (x) { return x && str(x.batchId || x.batchNo || x.id) === str(batchId); })[0];
      if (!b) return null;
      var m = (b.snapshot && b.snapshot.manifest && b.snapshot.manifest.ILR) || (b.manifest && b.manifest.ILR) || b.ilr || null;
      return m && m.id ? m : null;
    }
    function ruleSetFor(o) {
      o = o || {};
      var point = str(o.point); if (point && POINTS.indexOf(point) < 0) return fail('unknown_point');
      var m = master(); if (m.error) return fail('ilr_store_error');
      var t = today(), picked = [], fr = o.batchId ? frozenOf(o.batchId) : null;
      if (fr && fr.error) return fail('ilr_store_error');
      if (fr) {
        var list = Array.isArray(fr.sets) && fr.sets.length ? fr.sets : [{ id: fr.id, ver: fr.ver, hash: fr.hash }];
        for (var i = 0; i < list.length; i++) {
          var f = list[i], rows = rowsOf(m, f.id);
          if (!rows.length && BUILTIN_SETS[f.id]) rows = [builtinRow(f.id)];
          var row = rows.filter(function (r) { return Number(r.ver) === Number(f.ver); })[0];
          if (!row || !algosOf(row).some(function (a) { return contentHash(row, a) === f.hash || calcHash(row, a) === f.hash; })) return fail('ilr_store_error', { detail: 'frozen_mismatch', setId: f.id, ver: f.ver });   /* 고정 hash = 내용 hash (상태가 superseded 로 바뀌어도 같음) · 옛 매니페스트(행 hash) 호환 */
          picked.push(row);
        }
      } else {
        var site = pickEffective(rowsOf(m, 'ILR-STD'), t);
        if (!site) return fail('no_effective_set');
        picked.push(site);
        if (!point || point.indexOf('weigh.') === 0) {
          var lineSets = m.builtin ? [] : m.db.config.filter(function (r) { return r && r.kind === 'interlock' && r.apply === 'line' && isEff(r, t); });
          var ids = {}; lineSets.forEach(function (r) { ids[r.id] = 1; }); Object.keys(ids).forEach(function (id) { var e = pickEffective(rowsOf(m, id), t); if (e) picked.push(e); });
        }
        if (demoOn(o)) { var dm = m.builtin ? null : pickEffective(rowsOf(m, 'ILR-DEMO'), t); picked.push(dm || builtinRow('ILR-DEMO')); }
      }
      /* C2: '서명된 버전' = 서명 원장(ebr.esign.v1)의 유효 SM-APPR-ILR 기록 기준 (기준정보 행이 지워지거나 승인 기록이 빠져도 원장이 기준) */
      var ledger = ilrApprovals();
      if (!fr && ledger.skew) return fail('ilr_store_error', { detail: 'clock_skew', setId: ledger.skew.setId, ver: ledger.skew.ver, message: WHY_TEXT.clock_skew });   /* 원장 서명 시각이 오늘보다 뒤 → 시계 되돌림 의심 */
      for (var j = 0; j < picked.length; j++) {
        var pj = picked[j], sv = fr ? [] : ledger.list.filter(function (x) { return x.setId === pj.id && x.effDay <= t; });   /* 오늘까지 효력이 된 서명 버전 (발행 고정 배치는 고정 내용 hash 로 묶여 제외) */
        /* N3 · C2: 원장상 더 높은 효력 버전이 있으면 낮은 버전 거부 (행 검증보다 먼저) */
        var vd = sv.some(function (x) { return Number(x.ver) > Number(pj.ver); }) ? 'rollback_detected' : verifyRow(pj, sv);
        if (vd) return fail('ilr_store_error', { detail: vd, setId: pj.id, ver: pj.ver });
      }
      var rules = [], sets = picked.map(function (r) {
        var rr = rulesOfRow(r);
        rr.rules.forEach(function (x) { if (x && x.enabled !== false && (!point || x.point === point)) { x.setId = r.id; x.setVer = r.ver; rules.push(x); } });
        return { id: r.id, ver: r.ver, hash: contentHash(r, rowAlgo(r) || undefined), source: rr.source };   /* 세트 hash = 서명 대상 내용 hash (S-48 효력 hash 와 같음) */
      });
      var p0 = sets[0];
      return { ok: true, set: { id: p0.id, ver: p0.ver, hash: p0.hash, frozen: !!fr, sets: clone(sets) }, sets: sets, rules: rules };
    }

    /* ---- 평가 (순수) */
    function valueHash(batchId, ruleId, value) { var s = S(); var o = { batchId: str(batchId), ruleId: ruleId, value: value == null ? '' : String(value) }; return s && s.computeValueHash ? s.computeValueHash(o) : fnv(JSON.stringify(o), 0x811c9dc5); }
    function runRule(r, ctx) {
      var ct = COND_TYPES[r.cond && r.cond.type]; if (!ct) return { error: 'unknown_cond' };
      try { return ct.ev(r.cond, ctx) || { hit: false }; } catch (e) { return { error: 'eval_error', message: String(e && e.message || e) }; }
    }
    function evaluate(point, ctx) {
      ctx = Object.assign({}, ctx || {});
      /* 화면이 최소 ctx 만 넘기는 실행 지점(exec.*): 데모 모드면 데모 데이터로 채운다 (넘긴 값이 우선) */
      if (String(point).indexOf('exec.') === 0 && readRaw(KEYS.DEMO) != null && !ctx.lots && !ctx.ipc && !ctx.equipment && point !== 'exec.sign') {
        var dc = demoCtx(point, { batchId: ctx.batchId, opId: ctx.opId, prevDone: ctx.prevDone });
        if (dc && dc.ok !== false) ctx = Object.assign(dc, ctx);
      }
      if (!ctx.today) ctx.today = today();
      var rs = ruleSetFor({ batchId: ctx.batchId, point: point, lineId: ctx.lineId, demo: ctx.demo });
      if (!rs.ok) return { ok: false, why: rs.why, detail: rs.detail, message: rs.message, result: 'block', hits: [], open: [], set: null };
      var hits = [];
      rs.rules.forEach(function (r) {
        var x = runRule(r, ctx);
        if (x.error) { hits.push({ ruleId: r.ruleId, grade: 'Absolute', msg: x.error === 'unknown_cond' ? WHY_TEXT.unknown_cond : '판정 오류 — 차단(fail-closed)', cond: clone(r.cond), value: '', error: x.error, legacyRef: r.legacyRef, setId: r.setId, override: clone(OVERRIDE.Absolute) }); return; }
        if (!x.hit) return;
        var vars = Object.assign({}, r.cond, ctx, x.vars || {}); vars.value = x.value;
        var ov = clone(OVERRIDE[r.grade]) || clone(OVERRIDE.Absolute), vh = valueHash(ctx.batchId, r.ruleId, x.value);
        var h = { ruleId: r.ruleId, name: r.name, grade: r.grade, gradeClass: GRADE_CLASS[r.grade], msg: tmpl(r.msg, vars), cond: clone(r.cond), value: x.value, valueHash: vh, actions: clone(r.actions || []),
                  legacyRef: r.legacyRef, setId: r.setId, setVer: r.setVer, locked: !!r.locked, override: ov, sopRef: r.sopRef || '', limit: limitOf(r.cond, x.value) };
        if (r.grade === 'Controlled' && ctx.batchId) { var st = overrideState(ctx.batchId, r.ruleId, vh); if (st.approved) { ov.done = true; h.signatureId = st.signatureId; h.rbeExceptionId = st.rbeExceptionId; ov.signatureId = st.signatureId; ov.rbeExceptionId = st.rbeExceptionId; ov.by = st.signerId; ov.reason = st.reason; } }
        if (r.grade === 'Warning' && ctx.batchId) { var ak = ackState(ctx.batchId, r.ruleId, vh); if (ak) { ov.done = true; ov.by = ak.by; ov.reason = ak.reason; ov.at = ak.at; } }
        if (r.grade === 'Controlled' && ctx.batchId) {
          /* C1: 적중 ↔ 단계 묶음은 store 상태로 정함(화면 ctx.opId 안 씀) · 미결 적중의 기록은 다시 평가해도 덮어쓰지 않음 */
          /* K1: 묶음은 저장소에 append-only 로 남김 → 새로고침 뒤에도 같은 적중은 같은 단계로 복원 */
          var bd = bindOf(str(ctx.batchId), r.ruleId, vh);
          if (bd && bd.tampered) { h.opId = ''; h.bindError = bd.why; hits.push(h); return; }
          if (!bd) { var pt = r.point || point; bd = { batchId: str(ctx.batchId), ruleId: r.ruleId, valueHash: vh, point: pt, opId: String(pt).indexOf('exec.') === 0 ? storeProdStep(str(ctx.batchId)) : '', at: new Date(nowMs()).toISOString() }; saveBind(bd); }
          h.opId = bd.opId;
        }
        hits.push(h);
      });
      hits.sort(function (a, b) { return (GRADE_RANK[a.grade] - GRADE_RANK[b.grade]) || (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0); });
      var live = hits.filter(function (h) { return !(h.override && h.override.done); });
      var result = live.some(function (h) { return h.grade !== 'Warning'; }) ? 'block' : live.length ? 'warn' : 'pass';
      var set = Object.assign({}, rs.set, { sets: rs.sets });
      return { ok: true, point: point, result: result, hits: hits, open: live, set: set, sets: rs.sets };
    }
    function limitOf(c, v) {
      if (!c) return null;
      if (c.type === 'range') { var x = num(v); return !isNaN(x) && c.hi != null && x > Number(c.hi) ? Number(c.hi) : c.lo != null ? Number(c.lo) : null; }
      var k = ['lo', 'hi', 'min', 'max', 'limit'].filter(function (n) { return c[n] != null && c[n] !== ''; })[0]; return k ? (isNaN(num(c[k])) ? c[k] : Number(c[k])) : null;
    }
    /* 결정 2: ack 는 같은 사용자 · 배치 · 규칙 · 사유의 INTERLOCK_WARN_ACK 감사 기록이 있어야 인정 */
    function ackState(batchId, ruleId, vh) {
      var aud = readJson(KEYS.AUDIT); aud = Array.isArray(aud) ? aud : (aud && Array.isArray(aud.items) ? aud.items : []);
      return items(KEYS.ACK).filter(function (x) {
        if (!x || x.batchId !== str(batchId) || x.ruleId !== ruleId || x.valueHash !== vh) return false;
        return aud.some(function (a) { return a && a.act === 'INTERLOCK_WARN_ACK' && str(a.batchId) === str(batchId) && a.uid === x.by && str(a.why) === str(x.reason) && String(a.tgt || '').split(', ').some(function (t) { return t.replace(str(batchId) + ' · ', '') === ruleId; }); });
      }).pop() || null;
    }
    function explain(ruleId, ctx) {
      ctx = Object.assign({}, ctx || {}); if (!ctx.today) ctx.today = today();
      var rs = ruleSetFor({ batchId: ctx.batchId, demo: ctx.demo }); if (!rs.ok) return { ruleId: ruleId, pass: false, why: rs.why };
      var r = rs.rules.filter(function (x) { return x.ruleId === ruleId; })[0]; if (!r) return { ruleId: ruleId, pass: false, why: 'no_rule' };
      var x = runRule(r, ctx);
      return { ruleId: ruleId, cond: clone(r.cond), value: x.value, pass: !x.error && !x.hit, why: x.error || (x.hit ? tmpl(r.msg, Object.assign({}, r.cond, ctx, x.vars || {})) : '') };
    }
    function logHit(result, o) {
      o = o || {};
      if (result && result.result === 'warn' && o.reason !== undefined) return ackWarning(result, o);
      if (!result || (result.result !== 'block' && result.result !== 'warn')) return { ok: true, logged: false };
      var key = JSON.stringify([o.batchId || '', result.point, result.result, (result.hits || []).map(function (h) { return [h.ruleId, h.valueHash, !!(h.override && h.override.done)]; })]);
      if (hitLogged[key]) return { ok: true, logged: false };
      var s = S(); if (!s || !s.Audit) return fail('no_session');
      var top = result.hits[0] || {};
      s.Audit.append({ uid: o.actorId || (s.getCurrentUserId && s.getCurrentUserId()) || '', act: 'INTERLOCK_HIT', tgt: (o.batchId || '') + ' · ' + (result.point || ''), batchId: o.batchId || null,
                       val: result.result + ' · ' + result.hits.map(function (h) { return h.ruleId + '(' + h.grade + ')'; }).join(', '), why: top.msg || '', screen: o.screen || '',
                       detail: { set: result.set, hits: result.hits.map(function (h) { return { ruleId: h.ruleId, grade: h.grade, value: h.value }; }) } });
      hitLogged[key] = 1;
      return { ok: true, logged: true };
    }

    /* ---- 승인 (Controlled 감독자 승인 SM-APPR-CTRL, P0) */
    function reasonCodes() {
      var m = master(); if (m.error) return fail('reason_code_unavailable');
      var rows = m.db && m.db.gcmData ? m.db.gcmData[REASON_TABLE] : null;
      if (m.db && m.db.gcmData && rows != null && !Array.isArray(rows)) return fail('reason_code_unavailable');
      if (!rows && m.db) return fail('reason_code_unavailable');   /* W4: 기준정보가 있는데 EBR_OVR_REASON 표가 없으면 내장 사유로 대체하지 않음 (fail-closed) */
      if (!rows) return { ok: true, source: 'builtin', items: BUILTIN_REASONS.map(function (r) { return { key: r[0], code: r[0], text: r[1], freeRequired: r[2], active: true }; }) };
      return { ok: true, source: 'gcm', items: rows.slice().sort(function (a, b) { return (a.seqNo || 0) - (b.seqNo || 0); }).map(function (r) {
        var fr = r.data1 === true || String(r.data1).toUpperCase() === 'Y' || r.data1 === 'true';
        return { key: str(r.key1), code: str(r.key1), text: str(r.keyDesc), freeRequired: fr, active: !r.disableFlag }; }) };
    }
    /* Warning 사유 확인 (ilr-ui-wire ackWarning → logHit(…, {reason})): 사유 저장 + 감사, 같은 값 해시의 Warning 은 평가 시 done */
    function ackWarning(result, o) {
      var reason = str(o.reason); if (!reason) return fail('reason_required'); if (charLen(reason) > REASON_MAX) return fail('reason_too_long');
      var s = S(); if (!s || !s.Audit) return fail('no_session');
      var u = s.getCurrentUser && s.getCurrentUser(); if (!u) return fail('no_current_user');
      var B = str(o.batchId); if (!B) return fail('no_batch');
      var hs = (result.hits || []).filter(function (h) { return h && h.grade === 'Warning'; }); if (!hs.length) return fail('bad_hit');
      var raw = readRaw(KEYS.ACK), list = items(KEYS.ACK).slice(), at = new Date(nowMs()).toISOString();
      try {
        hs.forEach(function (h) { list.push({ batchId: B, ruleId: h.ruleId, value: h.value, valueHash: valueHash(B, h.ruleId, h.value), reason: reason, by: u.userId, at: at, screen: o.screen || '' }); });
        writeJson(KEYS.ACK, { v: 1, items: list });
        s.Audit.append({ uid: u.userId, act: 'INTERLOCK_WARN_ACK', tgt: B + ' · ' + hs.map(function (h) { return h.ruleId; }).join(', '), batchId: B, val: hs.map(function (h) { return h.ruleId + '(' + h.value + ')'; }).join(', '), why: reason, screen: o.screen || '' });
      } catch (e) { try { if (raw == null) storage().removeItem(KEYS.ACK); else storage().setItem(KEYS.ACK, raw); } catch (e2) { /* 무시 */ } return fail('save_error'); }
      return { ok: true, logged: true, acked: hs.length };
    }
    function checkReason(code, reason) {
      code = str(code); if (!code) return fail('reason_code_required');
      var rc = reasonCodes(); if (!rc.ok) return rc;
      var row = rc.items.filter(function (x) { return x.code === code && x.active; })[0]; if (!row) return fail('bad_reason_code');
      if (row.freeRequired && !str(reason)) return fail('reason_required_other');
      if (charLen(str(reason)) > REASON_MAX) return fail('reason_too_long');
      return { ok: true, row: row };
    }
    function overrideState(batchId, ruleId, vh) {
      /* 자체 점검: 승인 기록은 서명 원장의 유효 SM-APPR-CTRL 서명(같은 배치 · 규칙 · 값 해시)이 있어야 인정 — 저장소에 기록만 넣은 위조 거부 */
      var r = items(KEYS.OVR).filter(function (x) {
        if (!x || x.batchId !== str(batchId) || x.ruleId !== ruleId || (vh && x.valueHash !== vh)) return false;
        var sg = esignById(x.signatureId);
        return !!(sg && sg.status === 'valid' && sg.signRuleId === 'SM-APPR-CTRL' && str(sg.batchId) === str(batchId) && sg.ruleId === ruleId && sg.valueHash === x.valueHash);
      }).pop();
      return r ? { approved: true, signatureId: r.signatureId, rbeExceptionId: r.rbeExceptionId, valueHash: r.valueHash, at: r.at, signerId: r.signerId, reason: r.reasonCodeText + (r.reason ? ' — ' + r.reason : '') } : { approved: false };
    }
    /* W6: 거부된 승인 시도 감사 (21 CFR 11.300(d) 시도 기록) */
    function auditReject(r, req, stage) {
      try { var s = S(); if (!s || !s.Audit || !r || r.ok !== false) return r;
        var h = (req && req.hit) || {}, uid = s.getCurrentUserId ? s.getCurrentUserId() : ((s.getCurrentUser && s.getCurrentUser()) || {}).userId;
        s.Audit.append({ uid: uid || '', act: 'INTERLOCK_OVR_REJECTED', tgt: str(req && req.batchId) + ' · ' + str(h.ruleId), batchId: str(req && req.batchId) || null, val: stage + ' · ' + r.why, why: r.message || r.why, screen: (req && req.screen) || '' });
      } catch (e) { /* 감사 실패는 거부 결과를 바꾸지 않음 */ }
      return r;
    }
    /* B3: 적중 단계의 수행자 = store 에 기록된 수행 서명(EbrSignStatus) — 화면이 넘긴 performerId 는 쓰지 않음 */
    /* N1: 적중 → 수행 단계 (store 가 평가 지점에서 정함 — 화면 값 안 씀). 포장 수지 = pack/rec, 생산 exec.* = 평가 ctx 의 opId(생산 단계 목록 대조). 그 밖 지점은 미정 → 거부 */
    var POINT_STEP = { 'pack.reconcile': ['pack', 'rec'] };
    /* C1: 생산 현재 단계 = 단계 순서상 수행 서명이 아직 없는 첫 단계 (EbrSignStatus) */
    function storeProdStep(B) {
      var SS = opts.signStatus || global.EbrSignStatus;
      try {
        var steps = SS.stepsFor('prod', B) || [], gs = SS.getSignStatus({ batchId: B }), its = gs && gs.ok && Array.isArray(gs.items) ? gs.items : [];
        for (var i = 0; i < steps.length; i++) { var k = steps[i].stepKey; if (!its.some(function (x) { return x && x.scope === 'prod' && x.stepKey === k && x.slot === 'perform' && x.status === 'signed'; })) return k; }
      } catch (e) { /* 모르면 '' → step_unknown */ }
      return '';
    }
    /* P3: 적중 ↔ 단계 묶음 봉인 — 추가 전용 해시 사슬 (서명 무효 사슬 ebr.esignVoid.v1 과 같은 식):
       항목 { seq, batchId, ruleId, valueHash, point, opId, at, prevHash, hash }, hash = sha256(stableStringify(항목 − hash)), prevHash = 앞 항목 hash ('' 부터).
       고침 · 중간 삭제 · 순서 바꿈 · 봉인 없는 항목 · 형식 오류 → 묶음 전체 tampered → 승인 거부(fail-closed, 감사 INTERLOCK_OVR_REJECTED) · 새 묶음도 만들지 않음 */
    function bindHash(x) { var s = S(), b = JSON.parse(JSON.stringify(x)); delete b.hash; return s && s.computeValueHash ? s.computeValueHash(b) : ''; }
    function bindChain() {
      var raw = null; try { raw = global.localStorage.getItem(KEYS.BIND); } catch (e) { raw = null; }
      if (raw == null) return { ok: true, list: [] };
      var o = null; try { o = JSON.parse(raw); } catch (e) { return { ok: false, why: 'bind_unreadable' }; }
      if (!o || !Array.isArray(o.items)) return { ok: false, why: 'bind_unreadable' };
      var prev = '';
      for (var i = 0; i < o.items.length; i++) {
        var x = o.items[i];
        if (!x || !x.hash || x.seq !== i + 1 || str(x.prevHash) !== prev || bindHash(x) !== x.hash) return { ok: false, why: 'bind_tampered', at: i + 1 };
        prev = x.hash;
      }
      return { ok: true, list: o.items };
    }
    function bindOf(B, ruleId, vh) {
      var k = str(B) + '|' + ruleId + '|' + vh; if (evalSeen[k]) return evalSeen[k];
      var ch = bindChain(); if (!ch.ok) return { tampered: true, why: ch.why };
      var x = ch.list.filter(function (y) { return y && y.batchId === str(B) && y.ruleId === ruleId && y.valueHash === vh; })[0];   /* 처음 기록이 기준 (append-only) */
      if (x) evalSeen[k] = x; return x || null;
    }
    function saveBind(bd) {
      var ch = bindChain(); if (!ch.ok) return false;   /* 봉인 깨짐 → 새 묶음 안 만듦 (다시 묶어 우회 차단) */
      var l = ch.list.slice(), last = l[l.length - 1];
      bd.seq = l.length + 1; bd.prevHash = last ? last.hash : ''; bd.hash = bindHash(bd);
      evalSeen[bd.batchId + '|' + bd.ruleId + '|' + bd.valueHash] = bd;
      try { l.push(bd); writeJson(KEYS.BIND, { v: 1, items: l }); } catch (e) { /* 저장 실패 → 메모리만 (새로고침 시 step_unknown, fail-closed) */ }
    }
    function stepOfHit(B, hit) {
      var vh = valueHash(B, hit.ruleId, hit.value), ev = bindOf(B, hit.ruleId, vh); if (!ev || ev.tampered) return null;
      if (POINT_STEP[ev.point]) return { scope: POINT_STEP[ev.point][0], step: POINT_STEP[ev.point][1] };
      if (String(ev.point).indexOf('exec.') === 0 && ev.opId) {
        var SS = opts.signStatus || global.EbrSignStatus, ok = false;
        try { ok = !!(SS && SS.stepsFor && SS.stepsFor('prod', B).some(function (x) { return x.stepKey === ev.opId; })); } catch (e) { ok = false; }
        return ok ? { scope: 'prod', step: ev.opId } : null;
      }
      return null;
    }
    /* 경고: 새로고침 뒤 평가 기록이 없으면(step_unknown) 화면이 '다시 평가하세요' 안내 */
    function overrideInfo(B, hit) { if (!bindChain().ok) return { performer: '', why: 'bind_tampered' }; var st = hit ? stepOfHit(str(B), hit) : null; return st ? { performer: performerOf(str(B), st.scope, st.step), step: st.step } : { performer: '', why: 'step_unknown' }; }
    function overridePerformer(B, hit) { var st = hit ? stepOfHit(str(B), hit) : null; return st ? performerOf(str(B), st.scope, st.step) : ''; }
    function performerOf(B, scope, step) {
      var SS = opts.signStatus || global.EbrSignStatus; if (!SS || !SS.getSignStatus || !scope || !step) return '';
      var gs = SS.getSignStatus({ batchId: B }); if (!gs || !gs.ok || !Array.isArray(gs.items)) return '';
      var it = gs.items.filter(function (i) { return i && i.scope === scope && i.stepKey === step && i.slot === 'perform' && i.status === 'signed'; })[0];
      return it ? str(it.signerId) : '';
    }
    /* P3': 묶음 봉인은 비밀키 없는 sha256 이라 재계산 위조 가능(PoC 한계) → 승인 때 서명 원장(ebr.esign.v1)과 대조.
       묶인 단계의 수행 서명: 유효 · scope/stepKey/서명자 = 수행자 · 적중 기록(bind.at) 이후. 생산이면 앞 단계는 모두 bind.at 이전에 수행 서명(= 묶을 때 첫 미수행 단계). 어긋나거나 없으면 거부 */
    function ledgerSig(B, scope, step) {
      var SS = opts.signStatus || global.EbrSignStatus; if (!SS || !SS.getSignStatus) return null;
      var gs = SS.getSignStatus({ batchId: B }); if (!gs || !gs.ok || !Array.isArray(gs.items)) return null;
      var it = gs.items.filter(function (i) { return i && i.scope === scope && i.stepKey === step && i.slot === 'perform' && i.status === 'signed'; })[0];
      if (!it || !it.signatureId) return null;
      var s = S(), sg = null, ok = false;   /* 헬퍼 원장 API(ESign.get · validity: 서명 해시 · 무효 사슬 대조) */
      try { sg = s && s.ESign ? s.ESign.get(it.signatureId) : null; ok = !!(sg && s.ESign.validity(sg).state === 'valid'); } catch (e) { ok = false; }
      return ok ? sg : null;
    }
    function bindLedgerCheck(B, hit, stp, performer) {
      var vh = valueHash(B, hit.ruleId, hit.value), ev = bindOf(B, hit.ruleId, vh); if (!ev || ev.tampered) return 'bind_missing';
      var at = Date.parse(ev.at); if (!isFinite(at)) return 'bind_at_invalid';
      at = Math.floor(at / 1000) * 1000;   /* 서명 signedAt 은 초 단위 → 같은 초는 적중 이후로 봄 */
      var sg = ledgerSig(B, stp.scope, stp.step);
      if (!sg) return 'ledger_missing';
      if (str(sg.batchId) !== B || (sg.scope && sg.scope !== stp.scope) || (sg.stepKey && sg.stepKey !== stp.step) || str(sg.signerId) !== str(performer)) return 'ledger_mismatch';
      var ts = Date.parse(sg.signedAt); if (!isFinite(ts) || ts < at) return 'ledger_before_hit';   /* 적중 전에 이미 수행된 단계로 묶였음 = 위조 */
      if (stp.scope === 'prod') {
        var SS = opts.signStatus || global.EbrSignStatus, steps = []; try { steps = SS.stepsFor('prod', B) || []; } catch (e) { steps = []; }
        var idx = -1; steps.forEach(function (x, i) { if (x.stepKey === stp.step) idx = i; }); if (idx < 0) return 'ledger_mismatch';
        for (var i = 0; i < idx; i++) { var p = ledgerSig(B, 'prod', steps[i].stepKey), pt = p ? Date.parse(p.signedAt) : NaN; if (!p || !isFinite(pt) || pt > at) return 'ledger_order'; }
      }
      return null;
    }
    function requestOverride(req) {
      var r;
      try { r = requestOverride0(req || {}); } catch (e) { r = fail('session_error', { detail: String(e && e.message || e) }); }   /* W3: 예외 → fail 결과 */
      return r && r.ok === false ? auditReject(r, req || {}, 'request') : r;
    }
    function requestOverride0(req) {
      req = req || {};
      var s = S(); if (!s) return fail('no_session');
      var hit = req.hit, B = str(req.batchId); if (!B) return fail('no_batch');
      if (!hit || !hit.ruleId || !hit.grade) return fail('bad_hit');
      if (hit.grade === 'Absolute') return fail('override_not_allowed');
      if (hit.grade === 'Hard-QA') return fail('override_p1');
      if (hit.grade === 'Warning') return fail('warning_reason_only');
      /* 적중 다시 확인: 같은 배치 · 규칙 · 값 해시 (화면이 넘긴 hit 를 그대로 믿지 않음) */
      var vh = valueHash(B, hit.ruleId, hit.value);
      if (hit.valueHash && hit.valueHash !== vh) return fail('bad_hit');
      if (overrideState(B, hit.ruleId, vh).approved) return fail('already_approved');
      var cu = s.getCurrentUser && s.getCurrentUser(); if (!cu) return fail('role_restricted');
      var roles = s.rolesOf(cu.userId) || []; if (!roles.length) return fail('no_role');
      var rule = s.getSignRule('SM-APPR-CTRL'); var allowed = rule && rule.effective !== false && Array.isArray(rule.allowedRoles) ? rule.allowedRoles : [];
      if (!roles.some(function (x) { return allowed.indexOf(x) >= 0; })) return fail('role_restricted');
      var pre = null;
      if (req.reasonCode != null && str(req.reasonCode)) { pre = checkReason(req.reasonCode, req.reason); if (!pre.ok) return pre; }
      var rc = reasonCodes(); if (!rc.ok) return rc;
      var limit = hit.cond ? (hit.cond.lo != null ? hit.cond.lo : hit.cond.min != null ? hit.cond.min : '') : '';
      var unit = hit.cond && hit.cond.unit ? ' ' + hit.cond.unit : '', vtxt = hit.value == null || hit.value === '' ? '—' : String(hit.value) + unit;
      var ctx = { batchId: B, ruleId: hit.ruleId, grade: hit.grade, value: vtxt, limit: limit, reasonCodeText: pre ? pre.row.text : '', reason: pre ? str(req.reason) : '' };
      var bc = bindChain(); if (!bc.ok) return fail('performer_unknown', { detail: bc.why });   /* P3: 묶음 봉인 깨짐 → 승인 거부 (감사) */
      var ev0 = bindOf(B, hit.ruleId, vh);
      if (ev0 && hit.opId != null && str(hit.opId) !== str(ev0.opId)) return fail('performer_unknown', { detail: 'op_mismatch' });   /* C1: 기록과 다른 단계로 온 승인 거부 */
      var stp = stepOfHit(B, hit); if (!stp) return fail('performer_unknown', { detail: 'step_unknown' });   /* N1: 단계 = store 평가 기록 · 화면 scope/step 무시 */
      var scope = stp.scope, step = stp.step;
      var performer = performerOf(B, scope, step); if (!performer) return fail('performer_unknown', { scope: scope, step: step });   /* B3: 수행자 모르면 거부 */
      var lc = bindLedgerCheck(B, hit, stp, performer); if (lc) return fail('performer_unknown', { detail: lc, scope: scope, step: step });   /* P3': 원장 대조 */
      var spec = {
        signRuleId: 'SM-APPR-CTRL', recordType: 'interlock_override', tgt: B + ' · ' + hit.ruleId, val: hit.ruleId + ' (' + hit.value + ')', screen: req.screen,
        statementKind: 'interlock_override', statementCtx: ctx, statementInputKeys: pre ? [] : ['reasonCodeText', 'reason'], openAct: 'INTERLOCK_OVR_OPEN', qualTargets: [],
        keys: [KEYS.OVR, KEYS.RBE], fields: { batchId: B, ruleId: hit.ruleId, grade: hit.grade, valueHash: vh, statementKind: 'interlock_override' },
        distinctFrom: [{ userId: performer, label: '적중 단계 수행자' }],
        precheck: function () { if (!bindChain().ok || bindLedgerCheck(B, hit, stp, performer)) return { detail: 'bind_ledger', message: '적중-단계 묶음이 서명 원장과 맞지 않습니다 — 승인할 수 없습니다.' }; if (!bindChain().ok) return { detail: 'bind_tampered', message: '적중-단계 묶음 기록이 변조되었습니다 — 승인할 수 없습니다.' }; return overrideState(B, hit.ruleId, vh).approved ? { detail: 'already_approved', message: WHY_TEXT.already_approved } : null; },
        apply: function (sig, actx) {
          var inp = actx.input || {};
          /* 화면이 signAndCommitRecord 를 직접 부르는 경로(ilr-ui-wire commitOverride)도 사유를 여기서 검증 — 실패 시 throw → 롤백 */
          if (!pre) { var cr = checkReason(inp.reasonCode, inp.reason); if (!cr.ok) throw new Error(cr.message); if (str(inp.reasonCodeText) !== cr.row.text) throw new Error('사유 코드 문구 불일치'); }
          var code = pre ? pre.row.code : str(inp.reasonCode), text = pre ? pre.row.text : str(inp.reasonCodeText), reason = pre ? str(req.reason) : str(inp.reason);
          var ov = readJson(KEYS.OVR) || { v: 1, items: [] }, list = Array.isArray(ov.items) ? ov.items.slice() : [];
          var rbes = readJson(KEYS.RBE) || { version: 1, items: [] }, rl = Array.isArray(rbes.items) ? rbes.items.slice() : [];
          var ymd = str(actx.at).slice(0, 10).replace(/-/g, ''), seq = rl.filter(function (x) { return str(x.id).indexOf('RBE-IL-' + ymd) === 0; }).length + 1, rbeId = 'RBE-IL-' + ymd + '-' + ('000' + seq).slice(-4);
          list.push({ batchId: B, ruleId: hit.ruleId, grade: hit.grade, value: hit.value, valueHash: vh, signatureId: sig.signatureId, signerId: sig.signerId, reasonCode: code, reasonCodeText: text, reason: reason, rbeExceptionId: rbeId, at: actx.at, setId: hit.setId || '', setVer: hit.setVer || '' });
          rl.push({ id: rbeId, batchId: B, cat: 'OVERRIDE_CONTROLLED', step: step, item: hit.ruleId, value: String(hit.value) + (limit !== '' ? ' / 기준 ' + limit : ''), src: 'INTERLOCK', open: true, status: '미결', critical: true,
                    correctorId: performer || null, verifierId: sig.signerId, ruleId: hit.ruleId, signatureId: sig.signatureId, reasonCode: code, createdAt: actx.at });
          writeJson(KEYS.OVR, { v: 1, items: list });
          if (failNext === 'rbe') { failNext = null; throw new Error('저장 실패 주입 (rbe)'); }
          writeJson(KEYS.RBE, { version: 1, items: rl });
          return { result: { rbeExceptionId: rbeId }, audits: [
            { act: 'INTERLOCK_OVERRIDDEN', tgt: B + ' · ' + hit.ruleId, val: sig.signatureId + ' · ' + code, batchId: B, signRuleId: 'SM-APPR-CTRL', recordType: 'interlock_override', why: text + (reason ? ' — ' + reason : '') },
            { act: 'RBE_EXCEPTION_CREATED', tgt: rbeId, val: hit.ruleId + ' · ' + hit.value, batchId: B, recordType: 'rbe_exception' }] };
        }
      };
      var r = s.beginRecordSign(spec); if (!r || !r.ok) return r;
      tickets[r.ticket] = { pre: pre, req: { batchId: B, hit: { ruleId: hit.ruleId }, screen: req.screen } };
      var rule0 = r.target.rule || {};
      r.target = Object.assign({}, r.target, { statementKind: 'interlock_override', rule: Object.assign({}, rule0, { id: rule0.id || rule0.ruleId || 'SM-APPR-CTRL', ver: rule0.ver, roles: rule0.allowedRoles || rule0.roles || ['SV'], note: rule0.note || rule0.desc || '' }),
                                                 qualReq: [{ qualId: 'QD-EXEC-VERI', name: '실행 확인', ref: 'SIGN:SM-APPR-CTRL' }], authText: 'ID + 비밀번호 (full_factor)',
                                                 reasonCodes: rc.items.filter(function (x) { return x.active; }).map(function (x) { return { key: x.key, code: x.code, text: x.text, freeRequired: x.freeRequired }; }),
                                                 hit: { ruleId: hit.ruleId, grade: hit.grade, value: hit.value, msg: hit.msg }, rbePreview: 'RBE-IL-…' });
      return r;
    }
    function signAndCommit(ticket, input) {
      input = Object.assign({}, input || {});
      var s = S(); if (!s) return fail('no_session');
      var t = tickets[ticket]; if (!t) return fail('bad_ticket');
      if (!t.pre) { var c = checkReason(input.reasonCode, input.reason); if (!c.ok) return auditReject(c, t.req || {}, 'sign'); input.reasonCode = c.row.code; input.reasonCodeText = c.row.text; input.reason = str(input.reason); }
      var r = s.signAndCommitRecord(ticket, input);
      if (r && r.ok === false && r.why !== 'bad_password' && r.why !== 'locked') auditReject(r, t.req || {}, 'sign');   /* 비밀번호 실패는 헬퍼가 ESIGN_AUTH_FAIL 로 기록 */
      if (r && r.ok) { delete tickets[ticket]; r.signatureId = r.signature ? r.signature.signatureId : r.signatureId; r.rbeExceptionId = r.result ? r.result.rbeExceptionId : undefined; }
      else if (r && r.closeDialog) delete tickets[ticket];
      return r;
    }
    function cancel(ticket, o) { var s = S(); if (!s) return fail('no_session'); delete tickets[ticket]; return s.cancelRecordSign(ticket, o || {}); }

    /* ---- 발행 매니페스트 고정 (I1-6) */
    function freezeManifest(o) {
      o = o || {};
      var rs = ruleSetFor({ lineId: o.lineId, demo: o.demo }); if (!rs.ok) return rs;
      return { ok: true, ILR: { kind: '인터록 룰 세트', id: rs.set.id, ver: rs.set.ver, hash: rs.set.hash, sets: rs.sets.map(function (x) { return { id: x.id, ver: x.ver, hash: x.hash }; }) } };
    }

    /* ---- 데모 (I1-11): 데이터 프리셋 — 데이터만 바꾼다 (규칙 · 판정 경로는 실제와 같음) */
    var DEMO_PRESETS = [
      { name: 'normal', label: '정상' }, { name: 'lot_retest', label: '재시험일 경과 LOT', ruleId: 'IL-DEMO-LOT-RETEST', grade: 'Absolute' },
      { name: 'ipc', label: 'IPC 이탈', ruleId: 'IL-DEMO-IPC-HARDNESS', grade: 'Hard-QA' }, { name: 'hold', label: '보류 초과', ruleId: 'IL-DEMO-HOLD-TIME', grade: 'Controlled' },
      { name: 'caldue', label: '교정 임박', ruleId: 'IL-DEMO-EQ-CALDUE', grade: 'Warning' }, { name: 'eq_qual', label: '장비 적격 실패', ruleId: 'IL-DEMO-EQ-QUAL', grade: 'Absolute' }
    ];
    var DEMO_LOT = 'LAC-2411';
    function demoData(name, prev, t) {
      var lotOrig = prev && prev.lotOrig ? prev.lotOrig : null;
      return { v: 1, preset: name, batchId: DEMO_BATCHES.exec, lotOrig: lotOrig,
               ipc: { hardness: name === 'ipc' ? 55 : 85 }, holdStartMs: nowMs() - (name === 'hold' ? 260 : 60) * 60000,
               equipment: [{ eqId: 'MX-01', ops: ['OP1-1', 'OP1-2', 'OP2-1', 'OP2-2', 'OP3-1', 'OP3-2'], calDue: addDays(t, name === 'caldue' ? 12 : 60) },
                           { eqId: 'GR-02', ops: ['OP2-1', 'OP2-2'], calDue: addDays(t, name === 'eq_qual' ? -3 : 60) }] };
    }
    function demoState() { var d = readJson(KEYS.DEMO); return d && d.v === 1 ? clone(d) : null; }
    function seedDemo(o) {
      o = o || {};
      if (readRaw(KEYS.DEMO) != null && !o.force) return { ok: true, seeded: false };
      var t = today(), prev = demoState();
      if (prev && prev.lotOrig) restoreLot(prev.lotOrig);
      writeJson(KEYS.DEMO, demoData('normal', null, t));
      return { ok: true, seeded: true };
    }
    function restoreLot(orig) {
      var m = readJson(KEYS.MAT); if (!m || !Array.isArray(m.lots)) return;
      m.lots.forEach(function (l) { if (l && l.lotNo === orig.lotNo) l.retestDate = orig.retestDate; }); writeJson(KEYS.MAT, m);
    }
    function demoPreset(name, o) {
      o = o || {};
      var p = DEMO_PRESETS.filter(function (x) { return x.name === name || x.label === name; })[0]; if (!p) return fail('bad_preset');
      name = p.name;
      var s = S(), t = today(), prev = demoState(), d = demoData(name, prev, t);
      var m = readJson(KEYS.MAT), raw = { demo: readRaw(KEYS.DEMO), mat: readRaw(KEYS.MAT) };
      try {
        if (m && Array.isArray(m.lots)) {
          var lot = m.lots.filter(function (l) { return l && l.lotNo === DEMO_LOT; })[0];
          if (lot) {
            if (!d.lotOrig) d.lotOrig = { lotNo: DEMO_LOT, retestDate: lot.retestDate };
            lot.retestDate = name === 'lot_retest' ? addDays(t, -1) : d.lotOrig.retestDate;
            writeJson(KEYS.MAT, m);
          }
        }
        writeJson(KEYS.DEMO, d);
        if (s && s.Audit) s.Audit.append({ act: 'DEMO_PRESET', tgt: KEYS.DEMO, val: name + ' · ' + p.label, batchId: d.batchId, screen: o.screen || '' });
      } catch (e) {
        [[KEYS.DEMO, raw.demo], [KEYS.MAT, raw.mat]].forEach(function (x) { try { if (x[1] == null) storage().removeItem(x[0]); else storage().setItem(x[0], x[1]); } catch (e2) { /* 무시 */ } });
        return fail('save_error');
      }
      return { ok: true, preset: p.label, presetName: p.name, presetInfo: clone(p), data: clone(d) };
    }
    function currentPreset() { var d = demoState(); if (!d) return null; var p = DEMO_PRESETS.filter(function (x) { return x.name === d.preset; })[0]; return p ? p.label : d.preset; }
    function demoCtx(point, o) {
      o = o || {};
      var d = demoState(), t = today(), batchId = str(o.batchId) || DEMO_BATCHES.exec;
      if (!d) return fail('not_demo');
      var m = readJson(KEYS.MAT), lots = m && Array.isArray(m.lots) ? m.lots.filter(function (l) { return l && l.lotNo === DEMO_LOT; }).map(clone) : [];
      var c = { batchId: batchId, opId: str(o.opId) || 'OP2-1', today: t, prevDone: o.prevDone !== false, lots: lots, ipc: clone(d.ipc), equipment: clone(d.equipment),
                holdMin: Math.round((nowMs() - d.holdStartMs) / 60000), demo: true };
      if (point === 'exec.sign') { var ev = evaluate('exec.step', c); c.activeAbsolute = ev.ok ? ev.hits.filter(function (h) { return h.grade === 'Absolute'; })[0] || null : { ruleId: ev.why }; }
      return c;
    }

    return {
      VERSION: 1, KEYS: clone(KEYS), COND_TYPES: (function () { var o = {}; Object.keys(COND_TYPES).forEach(function (k) { o[k] = { label: COND_TYPES[k].label, points: COND_TYPES[k].points.slice(), params: clone(COND_TYPES[k].params) }; }); return o; })(),
      POINTS: POINTS.slice(), GRADES: GRADES.slice(), GRADE_CLASS: clone(GRADE_CLASS), WHY_TEXT: clone(WHY_TEXT), OVR_REASON_TABLE: REASON_TABLE, DEMO_PRESETS: clone(DEMO_PRESETS),
      BUILTIN_SETS: clone(BUILTIN_SETS), DEMO_BATCHES: clone(DEMO_BATCHES), calcHash: calcHash,
      ruleSetFor: ruleSetFor, evaluate: evaluate, explain: explain, logHit: logHit, validateRules: validateRules, requestOverride: requestOverride, signAndCommit: signAndCommit, performerOf: performerOf, overrideInfo: overrideInfo, overridePerformer: overridePerformer, contentHash: contentHash, verifyRow: verifyRow, cancel: cancel,
      overrideState: overrideState, reasonCodes: reasonCodes, freezeManifest: freezeManifest, demoPreset: demoPreset, currentPreset: currentPreset, demoState: demoState, demoCtx: demoCtx, seedDemo: seedDemo,
      create: create,
      _test: { failNext: function (st) { failNext = st || null; return failNext; } }
    };
  }
  var API = create({});
  global.EbrInterlock = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
