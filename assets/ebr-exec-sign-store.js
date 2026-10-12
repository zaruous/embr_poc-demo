/* =====================================================================
   ebr-exec-sign-store.js — 생산 · 포장 실행 · 자재 QC · 검토 · 출하 서명 래퍼 (전역 EbrExecSign)
   - 설계: poc-exec-release-esign-design.md 개정 1.1 §3.1 · §3.4 · §5.2 · §5.3 (D1-04 ~ D1-07 · D1-10), UI 항목 UI-12
   - 모든 서명은 EbrUserSession.beginRecordSign / signAndCommitRecord / cancelRecordSign 한 경로 (판정 ①–⑦ · ebr.esign.v1 · ebr.audit.v1).
     칭량 EbrDispense.beginSign 과 같은 구조 — spec = { signRuleId, recordType, fields, statementKind, statementCtx, distinctFrom, qualTargets, requireInput, precheck, apply, keys, openAct }.
   - 저장 키 (이 파일 소유): ebr.execRecord.v1 { v, items:[{batchId, scope, stepKey, slot, signatureId, at, by, valueHash, valueCount}] }
                            ebr.release.v1    { v, items:[{batchId, releasedAt, signatureId, manifestHash(64), gateSnapshot:[{no, st, refs}], orderNo}] }
                            ebr.mbrSign.v1    { v, items:[{mbrId, ver, contentHash, kind, signatureId, at, by}] }  (P1 MBR 검토 · 승인)
     함께 쓰기(커밋 안에서만, 실패 시 헬퍼가 원본 복원): ebr.materialLot.v1 (judgeSignatureId · judgedAt · judgedBy · judgeReason · status), ebr.order.v1 (출하 시 오더 완료)
   - 화면이 넘긴 기록 값(values)은 저장하지 않고 valueHash(sha256 · stableStringify)와 건수만 서명 레코드 · 실행 기록에 묶는다.
   - 비밀번호는 받지도 저장하지도 않는다(헬퍼가 판정). 정의(단계 · 슬롯 · 데모 RBE 예외)는 EbrSignStatus 와 공유.
   - EbrExecSign.create({ session?, signStatus?, matqc?, dev?, qual? }) 로 노드 시험 주입. 모듈은 호출 시점에 찾는다(로드 순서 무관).
   ===================================================================== */
(function (global) {
  'use strict';

  var KEYS = { EXEC: 'ebr.execRecord.v1', RELEASE: 'ebr.release.v1', MAT: 'ebr.materialLot.v1', ORDER: 'ebr.order.v1', ISSUED: 'ebr.batch.issued.v1', MBR: 'ebr.mbrSign.v1', ESIGN: 'ebr.esign.v1' };
  var RULES = {
    STEP_PERFORM: 'SM-PERF-STEP', STEP_VERIFY: 'SM-VERI-STEP', PACK_LABEL_QA: 'SM-VERI-PKLAB', PACK_REVIEW: 'SM-REV-PACK',
    MATQC: 'SM-APPR-MATQC', RBE: 'SM-REV-RBE', BATCH_REVIEW: 'SM-REV-BATCH', AUDIT_REVIEW: 'SM-REV-AUDIT', RELEASE: 'SM-APPR-REL',
    MBR_REVIEW: 'SM-REV-MBR', MBR_APPROVE: 'SM-APPR-MBR', BRIEFING: 'SM-READ-BRIEF'
  };
  var INVALIDATE_REASON_MAX = 200;
  var SCOPES = ['prod', 'pack'];
  var SLOTS = ['perform', 'verify', 'qa', 'review'];
  var REVIEW_KINDS = ['rbe', 'batch', 'audit'];
  var MATQC_TO = ['released', 'rejected', 'legacy_confirm'];
  var REASON_MAX = 60;
  var SLOT_LABEL = { perform: '수행자', verify: '확인자', qa: 'QA 확인자', review: '검토자', rbe: 'RBE 승인자', batch: '2차 검토자', audit: '감사추적 검토자' };
  var NOTE = {
    exec: '서명 뒤 실행 기록 저장 · 출하 게이트 3 반영', review: '서명 뒤 검토 기록 저장 · 출하 게이트 반영',
    matqc: '서명 뒤 LOT 상태 변경 · 게이트 9 반영', release: '서명 뒤 출하 기록 저장 · 오더 완료 (실패 시 전부 되돌림)'
  };
  var MSG = {
    no_session: '사용자 세션 헬퍼(EbrUserSession)를 찾을 수 없습니다.',
    no_batch: '배치 ID가 없습니다.', bad_scope: '알 수 없는 영역입니다 (prod | pack).', no_step: '알 수 없는 단계입니다.', bad_slot: '이 단계에 없는 서명 슬롯입니다.',
    prev_slot_missing: '앞 슬롯 서명이 먼저 필요합니다.', already_signed: '이미 유효한 서명이 있습니다.',
    role_restricted: '이 슬롯은 허용 역할이 더 좁습니다.', bad_values: '기록 값(values)은 배열이어야 합니다.',
    no_lot: 'LOT 을 찾을 수 없습니다.', bad_to: '판정 값이 올바르지 않습니다 (released | rejected | legacy_confirm).', bad_state: '이 상태에서는 판정 서명을 할 수 없습니다.',
    reason_required: '부적합 사유를 입력하세요.', reason_too_long: '부적합 사유는 ' + REASON_MAX + '자 이내로 입력하세요.', matqc_missing: 'MatQC 미로드 — 판정할 수 없습니다.',
    bad_kind: '알 수 없는 검토 종류입니다 (rbe | batch | audit).', no_exception: '미결 RBE 예외를 찾을 수 없습니다.', open_deviation: '미종결 일탈이 있어 2차 검토 서명을 할 수 없습니다.',
    rule_not_effective: '서명 규칙(S-39)이 효력 상태가 아닙니다 — 기준정보 담당자에게 요청하세요.',
    gate_blocked: '출하 게이트 차단 조건이 있어 출하 승인할 수 없습니다.', already_released: '이미 출하된 배치입니다.',
    no_issued: '발행 기록이 없는 배치는 출하 승인할 수 없습니다.', no_order: '오더 연결이 없는 배치는 출하 승인할 수 없습니다.',
    order_not_found: '오더를 찾을 수 없어 출하를 되돌렸습니다.', save_error: '오더 저장에 실패해 출하를 되돌렸습니다.',
    precheck_changed: '서명 창을 연 뒤 게이트 평가가 바뀌었습니다 — 창을 닫고 다시 여세요.', ticket_unknown: '서명 창이 닫혔습니다 — 다시 여세요.',
    bad_mbr: 'MBR ID · 버전 · 내용 해시 · 작성자가 필요합니다.', review_missing: '같은 내용(해시)의 독립 검토 서명이 먼저 필요합니다.', bad_mbr_kind: '알 수 없는 MBR 서명 종류입니다 (review | approve).',
    no_signature: '서명 레코드를 찾을 수 없습니다.', already_invalid: '이미 무효인 서명입니다.', not_qa: '서명 무효화는 QA만 할 수 있습니다.', unknown_actor: '행위자(현재 사용자)를 확인할 수 없습니다 — 사용자를 선택하세요.',
    invalidate_reason_required: '무효화 사유(QA 조사 내용)를 입력하세요.', invalidate_reason_too_long: '무효화 사유는 ' + INVALIDATE_REASON_MAX + '자 이내로 입력하세요.',
    bad_briefing: '배치 · 단계 · 변경 번호가 필요합니다.'
  };

  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function str(v) { return v == null ? '' : String(v).trim(); }
  function fail(why, message, extra) { var r = { ok: false, why: why, message: message || MSG[why] || why }; if (extra) Object.keys(extra).forEach(function (k) { r[k] = extra[k]; }); return r; }
  function readJson(key, fb) { try { var s = global.localStorage.getItem(key); return s ? JSON.parse(s) : fb; } catch (e) { return fb; } }
  function readStore(key) { var o = readJson(key, null); return o && Array.isArray(o.items) ? o : { v: 1, items: [] }; }
  function writeJson(key, o) { global.localStorage.setItem(key, JSON.stringify(o)); }
  function cpLen(s) { return Array.from(String(s)).length; }
  function codeErr(code) { var e = new Error(code); e.code = code; return e; }

  function create(opts) {
    opts = opts || {};
    function S() { return opts.session || global.EbrUserSession || null; }
    function SS() { return opts.signStatus || global.EbrSignStatus || null; }
    function MQ() { return opts.matqc || (global.EbrP0 && global.EbrP0.MatQC) || global.MatQC || null; }
    function DV() { return opts.dev || (global.EbrP0 && global.EbrP0.Dev) || global.Dev || null; }
    function QS() { return opts.qual || global.EbrQual || null; }
    var tickets = {};

    function ruleInfo(ruleId) {
      var s = S(), r = s ? s.getSignRule(ruleId) : null;
      return r ? { id: r.id, ver: r.ver, roles: (r.allowedRoles || []).slice(), note: r.note || '', effective: !!r.effective, meaning: r.meaning } : { id: ruleId, ver: null, roles: [], note: '', effective: false };
    }
    function ruleLine(ri) { return ri.id + ' v' + (ri.ver == null ? '?' : ri.ver) + ' · 허용 ' + (ri.roles.length ? ri.roles.join(' · ') : '없음') + (ri.note ? ' · ' + ri.note : ''); }
    /* 요구 자격 이름만 (서명자 자격 상태 미리 보기 금지 — UI-01) */
    function qualReq(ruleId, targets) {
      var q = QS(); if (!q || typeof q.listRequirements !== 'function') return [];
      var reqs = q.listRequirements() || [], defs = {}, out = [], seen = {};
      (q.listQualDefs() || []).forEach(function (d) { defs[d.qualId] = d; });
      ['SIGN:' + ruleId].concat(targets || []).forEach(function (t) {
        reqs.filter(function (r) { return r.target === t; }).forEach(function (r) { (r.qualIds || []).forEach(function (id) { if (!seen[id]) { seen[id] = 1; out.push({ qualId: id, name: defs[id] ? defs[id].name : id }); } }); });
      });
      return out;
    }
    function slotSigner(batchId, scope, stepKey, sl) {
      var gs = SS().getSignStatus({ batchId: batchId }); if (!gs.ok) return null;
      return gs.items.filter(function (i) { return i.scope === scope && i.stepKey === stepKey && i.slot === sl; })[0] || null;
    }
    function rolesOf(id) { var s = S(); try { return (s && s.rolesOf ? s.rolesOf(id) : []) || []; } catch (e) { return []; } }
    function curId() { var s = S(); return s && s.getCurrentUserId ? s.getCurrentUserId() : null; }
    function uniqDistinct(list) { var seen = {}, out = []; list.forEach(function (d) { if (d && d.userId && !seen[d.userId]) { seen[d.userId] = 1; out.push({ userId: d.userId, label: d.label }); } }); return out; }

    /* 공통: 헬퍼 beginRecordSign 호출 + 화면용 target 보강 */
    function open(kind, spec, extra) {
      var s = S(); if (!s) return fail('no_session');
      var ri = ruleInfo(spec.signRuleId);
      spec.target = Object.assign({ rule: ri, ruleLine: ruleLine(ri), qualReq: qualReq(spec.signRuleId, spec.qualTargets), note: extra.note || '' }, spec.target || {});
      var r = s.beginRecordSign(spec);
      if (!r.ok) return r;
      tickets[r.ticket] = { kind: kind, batchId: extra.batchId || null };
      return r;
    }
    function execAppend(item) { var o = readStore(KEYS.EXEC); o.v = 1; o.items.push(item); writeJson(KEYS.EXEC, o); return item; }

    /** 단계 · 슬롯 정의 (EbrSignStatus.stepsFor 위임) */
    function stepsFor(scope, batchId) { var ss = SS(); return ss ? ss.stepsFor(scope, batchId) : []; }

    /**
     * 생산 · 포장 단계 서명 시작 (수행 · 확인 · 라벨 QA · 포장 기록 검토).
     * @param {{batchId, scope:'prod'|'pack', stepKey, slot:'perform'|'verify'|'qa'|'review', values?:Array, screen?}} req
     */
    function beginStepSign(req) {
      req = req || {};
      var ss = SS(), s = S(); if (!s || !ss) return fail('no_session');
      var batchId = str(req.batchId), scope = req.scope;
      if (!batchId) return fail('no_batch');
      if (SCOPES.indexOf(scope) < 0) return fail('bad_scope');
      if (req.values != null && !Array.isArray(req.values)) return fail('bad_values');
      var steps = stepsFor(scope, batchId), step = steps.filter(function (x) { return x.stepKey === req.stepKey; })[0];
      if (!step) return fail('no_step');
      var sd = step.slots.filter(function (x) { return x.slot === req.slot; })[0];
      if (!sd) return fail('bad_slot');
      var me = slotSigner(batchId, scope, step.stepKey, sd.slot);
      if (me && me.status === 'signed') return fail('already_signed', MSG.already_signed, { signatureId: me.signatureId });
      /* 앞 슬롯 · ⑥ */
      var distinct = [], prevMissing = [], packSigs = 0;
      if (sd.slot === 'review') {
        steps.forEach(function (st) { st.slots.forEach(function (x) {
          if (x.slot === 'review') return;
          var it = slotSigner(batchId, scope, st.stepKey, x.slot);
          if (!it || it.status !== 'signed') prevMissing.push(st.stepKey + ':' + x.slot);
          else { packSigs++; distinct.push({ userId: it.signerId, label: '포장 ' + st.stepNo + ' ' + SLOT_LABEL[x.slot] }); }
        }); });
      } else if (sd.slot !== 'perform') {
        var pf = slotSigner(batchId, scope, step.stepKey, 'perform');
        if (!pf || pf.status !== 'signed') prevMissing.push(step.stepKey + ':perform');
        else distinct.push({ userId: pf.signerId, label: SLOT_LABEL.perform });
      }
      if (prevMissing.length) return fail('prev_slot_missing', MSG.prev_slot_missing + ' (' + prevMissing.join(', ') + ')', { missing: prevMissing });
      var values = (req.values || []).map(clone), sess = s;
      var valueHash = sess.computeValueHash({ batchId: batchId, scope: scope, stepKey: step.stepKey, values: values });
      var kind = sd.statementKind, ctx;
      if (scope === 'prod') ctx = { batchId: batchId, opId: step.stepKey, opName: step.name, n: values.length };
      else if (kind === 'pack_review') ctx = { batchId: batchId, n: packSigs };
      else ctx = { batchId: batchId, stepNo: step.stepNo, stepName: step.name };
      var isPack = scope === 'pack', tgt = batchId + ' · ' + (isPack ? '포장 ' + step.stepNo : step.stepKey) + ' ' + step.name + ' · ' + sd.slot;
      var narrow = sd.roles.slice();
      var recType = sd.signRuleId === RULES.PACK_REVIEW ? 'batch_review' : 'step_value';
      return open('step', {
        signRuleId: sd.signRuleId, recordType: recType, tgt: tgt, val: (values.length ? '값 ' + values.length + '건 · ' : '') + 'valueHash ' + valueHash.slice(0, 8), screen: req.screen,
        signerMode: isPack ? 'entered' : 'current',
        statementKind: kind, statementCtx: ctx, distinctFrom: uniqDistinct(distinct),
        qualTargets: isPack && sd.lineQual ? ['LINE:PK-L02'] : [],
        fields: { batchId: batchId, scope: scope, stepKey: step.stepKey, slot: sd.slot, statementKind: kind, valueHash: valueHash, valueCount: values.length },
        target: { values: values, step: { stepKey: step.stepKey, stepNo: step.stepNo, name: step.name }, slot: sd.slot, slotRoles: narrow },
        openAct: isPack ? 'PACK_SIGN_OPEN' : 'EXEC_SIGN_OPEN',
        /* 슬롯 역할 추가 제한 (예: 수량 정산 확인 = SV 만) — 비밀번호 판정 전, 카운트 · 감사 없음 */
        requireInput: function (input) {
          var id = isPack ? str(input.userId) : (curId() || str(input.userId));
          var rs = rolesOf(id);
          if (id && !narrow.some(function (r) { return rs.indexOf(r) >= 0; })) return { why: 'role_restricted', message: '이 슬롯은 ' + narrow.join(' · ') + '만 서명할 수 있습니다.' };
          return null;
        },
        precheck: function () {
          var m2 = slotSigner(batchId, scope, step.stepKey, sd.slot);
          if (m2 && m2.status === 'signed') return { detail: 'already_signed', message: MSG.already_signed };
          if (sd.slot !== 'perform' && sd.slot !== 'review') { var p2 = slotSigner(batchId, scope, step.stepKey, 'perform'); if (!p2 || p2.status !== 'signed') return { detail: 'prev_slot_changed', message: MSG.prev_slot_missing }; }
          return null;
        },
        apply: function (sig, c) {
          execAppend({ batchId: batchId, scope: scope, stepKey: step.stepKey, slot: sd.slot, signatureId: sig.signatureId, at: c.at, by: sig.signerId, valueHash: valueHash, valueCount: values.length });
          var act = isPack ? (sd.slot === 'review' ? 'PACK_REVIEWED' : 'PACK_STEP_SIGNED') : (sd.slot === 'perform' ? 'EXEC_STEP_PERFORMED' : 'EXEC_STEP_VERIFIED');
          return { audits: [{ act: act, tgt: tgt, val: sig.signatureId + ' · ' + sd.slot, batchId: batchId, signRuleId: sd.signRuleId, recordType: recType }],
                   result: { batchId: batchId, scope: scope, stepKey: step.stepKey, slot: sd.slot, signatureId: sig.signatureId } };
        },
        keys: [KEYS.EXEC]
      }, { batchId: batchId, note: isPack && sd.slot === 'review' ? NOTE.review : NOTE.exec });
    }

    /**
     * 자재 QC 판정 서명 시작. testing → released | rejected, released(판정 서명 없음 = 레거시) → 'legacy_confirm'(재확인, 상태 그대로).
     * 부적합 사유 = signAndCommit input.reason (trim 후 1–60자, 문장에 들어감).
     */
    function beginMatQcSign(req) {
      req = req || {};
      var mq = MQ(); if (!mq) return fail('matqc_missing');
      var to = req.to, lot = mq.get(str(req.lotNo));
      if (MATQC_TO.indexOf(to) < 0) return fail('bad_to');
      if (!lot) return fail('no_lot');
      var okState = to === 'legacy_confirm' ? (lot.status === 'released' && !lot.judgeSignatureId) : lot.status === 'testing';
      if (!okState) return fail('bad_state', MSG.bad_state + ' (현재 ' + lot.status + (lot.judgeSignatureId ? ' · 판정 서명 있음' : '') + ')');
      var kind = to === 'rejected' ? 'matqc_reject' : (to === 'legacy_confirm' ? 'matqc_legacy_confirm' : 'matqc_release');
      var before = lot.status, after = to === 'legacy_confirm' ? 'released' : to, lotNo = lot.lotNo, tgt = 'LOT ' + lotNo + ' (' + (lot.materialId || '') + ')';
      return open('matqc', {
        signRuleId: RULES.MATQC, recordType: 'material_qc', tgt: tgt, val: before + ' → ' + after, screen: req.screen,
        statementKind: kind, statementCtx: { lotNo: lotNo, matCode: lot.materialId || '', reason: '' }, statementInputKeys: to === 'rejected' ? ['reason'] : [],
        fields: { batchId: lot.batchId || null, lotNo: lotNo, materialId: lot.materialId || '', matqcTo: to, statementKind: kind, beforeStatus: before },
        target: { lot: { lotNo: lotNo, materialId: lot.materialId || '', materialName: lot.materialName || '', status: before }, to: to, after: after, requireReason: to === 'rejected', reasonMax: REASON_MAX },
        openAct: 'MATQC_SIGN_OPEN',
        requireInput: function (input) {
          if (to !== 'rejected') return null;
          var rs = str(input.reason);
          if (!rs) return { why: 'reason_required', message: MSG.reason_required };
          if (cpLen(rs) > REASON_MAX) return { why: 'reason_too_long', message: MSG.reason_too_long };
          return null;
        },
        precheck: function () {
          var l2 = mq.get(lotNo);
          if (!l2 || l2.status !== before || (l2.judgeSignatureId || null) !== (lot.judgeSignatureId || null)) return { detail: 'lot_changed', message: 'LOT 상태가 서명 창을 연 뒤 바뀌었습니다 — 창을 닫고 다시 여세요.' };
          return null;
        },
        apply: function (sig, c) {
          var patch = { lotNo: lotNo, status: after, judgeSignatureId: sig.signatureId, judgedAt: c.at, judgedBy: sig.signerId };
          if (to === 'rejected') patch.judgeReason = str(c.input.reason);
          var next = mq.upsert(patch);
          return { audits: [{ act: 'MATQC_JUDGED', tgt: tgt, val: before + ' → ' + after + ' · ' + sig.signatureId, why: patch.judgeReason || undefined, before: { status: before, judgeSignatureId: lot.judgeSignatureId || null },
                              after: { status: after, judgeSignatureId: sig.signatureId }, signRuleId: RULES.MATQC, recordType: 'material_qc', batchId: lot.batchId || null }],
                   result: { lot: clone(next) } };
        },
        keys: [KEYS.MAT]
      }, { batchId: lot.batchId || null, note: NOTE.matqc });
    }

    function execSigners(batchId) {
      var gs = SS().getSignStatus({ batchId: batchId }); if (!gs.ok) return [];
      return gs.items.filter(function (i) { return (i.scope === 'prod' || i.scope === 'pack') && i.status === 'signed'; })
        .map(function (i) { return { userId: i.signerId, label: (i.scope === 'prod' ? '생산 ' : '') + i.label }; });
    }
    function auditCount(batchId) {
      var s = S(); if (!s || !s.Audit) return 0;
      return s.Audit.list({}).filter(function (a) { return a.batchId === batchId || (a.tgt && String(a.tgt).indexOf(batchId) >= 0); }).length;
    }

    /**
     * 출하 게이트 검토 서명 시작: rbe(미결 예외 1건 = 서명 1건) · batch(2차 검토, 미종결 일탈 0 필요) · audit(감사추적 검토, SM-REV-AUDIT 효력 필요).
     */
    function beginReviewSign(req) {
      req = req || {};
      var ss = SS(); if (!S() || !ss) return fail('no_session');
      var batchId = str(req.batchId); if (!batchId) return fail('no_batch');
      if (REVIEW_KINDS.indexOf(req.kind) < 0) return fail('bad_kind');
      var kind = req.kind, stepKey, ruleId, recType, stKind, ctx, distinct = [], label, act;
      if (kind === 'rbe') {
        var ex = ss.rbeExceptions(batchId).filter(function (e) { return e.open && e.id === str(req.exceptionId); })[0];
        if (!ex) return fail('no_exception');
        stepKey = ex.id; ruleId = RULES.RBE; recType = 'rbe_exception'; stKind = 'rbe_review'; ctx = { batchId: batchId, exceptionId: ex.id }; act = 'RBE_REVIEWED';
        if (ex.correctorId) distinct.push({ userId: ex.correctorId, label: '예외 정정자' });
        if (ex.verifierId) distinct.push({ userId: ex.verifierId, label: '예외 확인자' });
        label = 'RBE 예외 ' + ex.id;
      } else {
        stepKey = kind; ruleId = kind === 'batch' ? RULES.BATCH_REVIEW : RULES.AUDIT_REVIEW; recType = kind === 'batch' ? 'batch_review' : 'audit_trail';
        stKind = kind === 'batch' ? 'batch_review' : 'audit_review'; act = kind === 'batch' ? 'BATCH_REVIEWED' : 'AUDIT_REVIEWED';
        ctx = kind === 'batch' ? { batchId: batchId, n: ss.rbeExceptions(batchId).length } : { batchId: batchId, n: auditCount(batchId) };
        var pr = slotSigner(batchId, 'pack', 'rev', 'review');
        if (pr && pr.status === 'signed') distinct.push({ userId: pr.signerId, label: '1차 검토자 (포장 기록)' });
        distinct = distinct.concat(execSigners(batchId));
        label = kind === 'batch' ? '2차 검토' : '감사추적 검토';
        if (kind === 'batch') { var dv = DV(), od = dv ? dv.openCount(batchId) : 1; if (od > 0) return fail('open_deviation', MSG.open_deviation + ' (' + od + '건)'); }
      }
      var ri = ruleInfo(ruleId);
      if (!ri.effective || !ri.roles.length) return fail('rule_not_effective', MSG.rule_not_effective + ' (' + ruleId + ')');
      var me = slotSigner(batchId, 'review', stepKey, kind);
      if (me && me.status === 'signed') return fail('already_signed', MSG.already_signed, { signatureId: me.signatureId });
      var tgt = batchId + ' · ' + label;
      return open('review', {
        signRuleId: ruleId, recordType: recType, tgt: tgt, val: label, screen: req.screen,
        statementKind: stKind, statementCtx: ctx, distinctFrom: uniqDistinct(distinct), qualTargets: [],
        fields: { batchId: batchId, scope: 'review', stepKey: stepKey, slot: kind, statementKind: stKind },
        target: { review: { kind: kind, stepKey: stepKey, label: label } },
        precheck: function () {
          var m2 = slotSigner(batchId, 'review', stepKey, kind);
          if (m2 && m2.status === 'signed') return { detail: 'already_signed', message: MSG.already_signed };
          if (kind === 'batch') { var dv2 = DV(); if (!dv2 || dv2.openCount(batchId) > 0) return { detail: 'open_deviation', message: MSG.open_deviation }; }
          return null;
        },
        apply: function (sig, c) {
          execAppend({ batchId: batchId, scope: 'review', stepKey: stepKey, slot: kind, signatureId: sig.signatureId, at: c.at, by: sig.signerId });
          return { audits: [{ act: act, tgt: tgt, val: sig.signatureId, batchId: batchId, signRuleId: ruleId, recordType: recType }], result: { batchId: batchId, kind: kind, stepKey: stepKey, signatureId: sig.signatureId } };
        },
        keys: [KEYS.EXEC]
      }, { batchId: batchId, note: NOTE.review });
    }

    /* 출하 manifest (§3.4-3): {v:1, batchId, gate:[{no, st, refs}] no 오름차순, signs:[정렬]} — 시각 · basis · 화면 상태 · 현재 사용자 제외 */
    function manifestOf(batchId) {
      var ss = SS(), g = ss.gateSignItems(batchId); if (!g.ok) return { ok: false, why: g.why, message: g.message };
      var gate = Object.keys(g.items).map(Number).sort(function (a, b) { return a - b; }).map(function (n) { var it = g.items[n]; return { no: it.no, st: it.st, refs: it.refs.slice().sort() }; });
      var gs = ss.getSignStatus({ batchId: batchId }), signs = gs.items.filter(function (i) { return i.status === 'signed'; }).map(function (i) { return i.signatureId; }).sort();
      var m = { v: 1, batchId: batchId, gate: gate, signs: signs }, s = S();
      return { ok: true, manifest: m, hash: s.sha256Hex(s.stableStringify(m)), blocked: g.blocked, items: g.items, signers: gs.signers };
    }

    /**
     * 출하 승인 안의 오더 완료 (출하 게이트 화면 markOrderCompleted 의 엄격판). 성공이 아니면(skipped 포함) throw — 출하 커밋이 되돌려진다.
     * @throws {Error} code: 'no_order_no' | 'no_issued' | 'order_not_found' | 'save_error'
     */
    function markOrderCompleted(orderNo, batchId) {
      orderNo = str(orderNo).toUpperCase(); batchId = str(batchId);
      if (!orderNo) throw codeErr('no_order_no');
      var ss = SS(), iss = ss ? ss.issuedOf(batchId) : null;
      if (!iss || str(iss.orderNo).toUpperCase() !== orderNo) throw codeErr('no_issued');
      var rows = readJson(KEYS.ORDER, []); if (!Array.isArray(rows)) rows = [];
      var found = rows.filter(function (r) { return str(r.orderNo).toUpperCase() === orderNo; })[0];
      if (!found) throw codeErr('order_not_found');
      found.status = 'completed'; found.completedAt = (S() && S().nowIsoLocal) ? S().nowIsoLocal() : new Date().toISOString(); found.batchNo = batchId;
      try { writeJson(KEYS.ORDER, rows); } catch (e) { throw codeErr('save_error'); }
      return { ok: true, order: clone(found) };
    }

    /**
     * 출하 승인(QP) 서명 시작. 활성 조건: 게이트 1 · 2 · 3 · 4 · 8 · 9 통과 · 미출하 · 발행 + 오더 연결.
     * 문장의 QA 대행 꼬리는 현재 사용자 역할로 정한다 (QP 없음 → "(PoC: QA 대행, QP 인증 아님)" — signatureHash 대상).
     */
    function beginReleaseSign(req) {
      req = req || {};
      var ss = SS(), s = S(); if (!s || !ss) return fail('no_session');
      var batchId = str(req.batchId); if (!batchId) return fail('no_batch');
      if (ss.releaseState(batchId)) return fail('already_released');
      var iss = ss.issuedOf(batchId); if (!iss) return fail('no_issued');
      var orderNo = str(iss.orderNo); if (!orderNo) return fail('no_order');
      var mf = manifestOf(batchId); if (!mf.ok) return fail(mf.why, mf.message);
      if (mf.blocked.length) return fail('gate_blocked', MSG.gate_blocked + ' (게이트 ' + mf.blocked.join(' · ') + ')', { blocked: mf.blocked });
      var me = curId(), qaProxy = !!me && rolesOf(me).indexOf('QP') < 0;
      var distinct = mf.signers.map(function (x) { return { userId: x.userId, label: x.label }; });
      var hash = mf.hash, tgt = batchId + ' · 출하 승인';
      return open('release', {
        signRuleId: RULES.RELEASE, recordType: 'release', tgt: tgt, val: 'manifest ' + hash.slice(0, 8), orderNo: orderNo, screen: req.screen,
        statementKind: 'batch_release', statementCtx: { batchId: batchId, manifestHash: hash, qaProxy: qaProxy }, distinctFrom: uniqDistinct(distinct), qualTargets: [],
        fields: { batchId: batchId, manifestHash: hash, statementKind: 'batch_release', qaProxy: qaProxy },
        target: { manifestHash: hash, manifestHash8: hash.slice(0, 8), gate: clone(mf.manifest.gate), gateItems: clone(mf.items), qaProxy: qaProxy, qaProxyBadge: qaProxy ? 'PoC 전용 — QA 대행 · QP 인증 아님' : '' },
        openAct: 'REL_SIGN_OPEN', rollbackAct: 'REL_ROLLBACK',
        precheck: function () {
          if (ss.releaseState(batchId)) return { detail: 'already_released', message: MSG.already_released };
          var m2 = manifestOf(batchId);
          if (!m2.ok || m2.blocked.length || m2.hash !== hash) return { detail: 'manifest_changed', message: MSG.precheck_changed };
          var cur = curId(); if ((!!cur && rolesOf(cur).indexOf('QP') < 0) !== qaProxy) return { detail: 'signer_role_changed', message: MSG.precheck_changed };
          return null;
        },
        apply: function (sig, c) {
          if (ss.releaseState(batchId)) throw codeErr('already_released');
          var o = readStore(KEYS.RELEASE); o.v = 1;
          o.items.push({ batchId: batchId, releasedAt: c.at, signatureId: sig.signatureId, manifestHash: hash, gateSnapshot: clone(mf.manifest.gate), orderNo: orderNo, by: sig.signerId, qaProxy: qaProxy });
          writeJson(KEYS.RELEASE, o);
          var mc = markOrderCompleted(orderNo, batchId);
          return { audits: [{ act: 'BATCH_RELEASED', tgt: tgt, val: sig.signatureId + ' · manifest ' + hash.slice(0, 8) + ' · 오더 ' + orderNo + ' completed' + (qaProxy ? ' · QA 대행' : ''), batchId: batchId, orderNo: orderNo,
                                signRuleId: RULES.RELEASE, recordType: 'release' }],
                   result: { batchId: batchId, signatureId: sig.signatureId, manifestHash: hash, order: mc.order, qaProxy: qaProxy } };
        },
        saveErrorMessage: '출하 기록 저장 또는 오더 완료에 실패해 전부 되돌렸습니다.',
        keys: [KEYS.RELEASE, KEYS.ORDER]
      }, { batchId: batchId, note: NOTE.release });
    }

    /* ------------------------------------------------------------ P1 D1-12 · MBR 독립 검토 · QA 승인
       MBR 작성 화면 상태는 메모리(화면 몫) — 서명 결과는 ebr.mbrSign.v1 { v, items:[{mbrId, ver, contentHash, kind:'review'|'approve', signatureId, at, by}] } 에 내용 해시와 묶는다.
       내용이 바뀌면(contentHash 다름) 앞 검토는 이 버전에 해당하지 않는다. */
    function mbrKey(q) { return str(q.mbrId) + '|' + str(q.ver) + '|' + str(q.contentHash); }
    /** → { review: {signatureId, by, at, status} | null, approve: … | null } — 유효(서명 레코드 valid · hash 통과)만 */
    function mbrSignState(q) {
      q = q || {}; var k = mbrKey(q), out = { review: null, approve: null }, s = S();
      readStore(KEYS.MBR).items.forEach(function (r) {
        if (mbrKey(r) !== k) return;
        var sig = s && s.ESign ? s.ESign.get(r.signatureId) : null, ok = !!(sig && s.ESign.validity(sig).state === 'valid');
        out[r.kind] = { signatureId: r.signatureId, by: r.by, at: r.at, status: ok ? 'signed' : 'invalid' };
      });
      return out;
    }
    /**
     * MBR 서명 시작. review = SM-REV-MBR(reviewed, QA · SV, 작성자 ⑥), approve = SM-APPR-MBR(approved, QA, 작성자 · 검토자 ⑥, 유효한 검토 필요).
     * @param {{kind:'review'|'approve', mbrId, ver, contentHash, authorId, screen?}} req
     */
    function beginMbrSign(req) {
      req = req || {};
      if (!S()) return fail('no_session');
      if (['review', 'approve'].indexOf(req.kind) < 0) return fail('bad_mbr_kind');
      if (!str(req.mbrId) || !str(req.ver) || !str(req.contentHash) || !str(req.authorId)) return fail('bad_mbr');
      var q = { mbrId: str(req.mbrId), ver: str(req.ver), contentHash: str(req.contentHash) }, st = mbrSignState(q), kind = req.kind;
      if (st[kind] && st[kind].status === 'signed') return fail('already_signed', MSG.already_signed, { signatureId: st[kind].signatureId });
      var distinct = [{ userId: str(req.authorId), label: 'MBR 작성자' }];
      if (kind === 'approve') {
        if (!st.review || st.review.status !== 'signed') return fail('review_missing');
        distinct.push({ userId: st.review.by, label: 'MBR 검토자' });
      }
      var ruleId = kind === 'review' ? RULES.MBR_REVIEW : RULES.MBR_APPROVE, ri = ruleInfo(ruleId);
      if (!ri.effective || !ri.roles.length) return fail('rule_not_effective', MSG.rule_not_effective + ' (' + ruleId + ')');
      var tgt = q.mbrId + ' v' + q.ver + ' · ' + (kind === 'review' ? 'MBR 독립 검토' : 'MBR QA 승인'), stKind = kind === 'review' ? 'mbr_review' : 'mbr_approve';
      return open('mbr', {
        signRuleId: ruleId, recordType: 'mbr_approval', tgt: tgt, val: 'contentHash ' + q.contentHash.slice(0, 8), screen: req.screen,
        statementKind: stKind, statementCtx: { mbrId: q.mbrId, ver: q.ver, contentHash: q.contentHash }, distinctFrom: uniqDistinct(distinct), qualTargets: [],
        fields: { mbrId: q.mbrId, mbrVer: q.ver, contentHash: q.contentHash, mbrSignKind: kind, statementKind: stKind },
        target: { mbr: clone(q), kind: kind },
        openAct: 'MBR_SIGN_OPEN',
        precheck: function () {
          var s2 = mbrSignState(q);
          if (s2[kind] && s2[kind].status === 'signed') return { detail: 'already_signed', message: MSG.already_signed };
          if (kind === 'approve' && (!s2.review || s2.review.status !== 'signed' || s2.review.by !== st.review.by)) return { detail: 'review_changed', message: MSG.review_missing };
          return null;
        },
        apply: function (sig, c) {
          var o = readStore(KEYS.MBR); o.v = 1;
          o.items.push({ mbrId: q.mbrId, ver: q.ver, contentHash: q.contentHash, kind: kind, signatureId: sig.signatureId, at: c.at, by: sig.signerId });
          writeJson(KEYS.MBR, o);
          return { audits: [{ act: kind === 'review' ? 'MBR_REVIEWED' : 'MBR_APPROVED', tgt: tgt, val: sig.signatureId + ' · contentHash ' + q.contentHash.slice(0, 8), signRuleId: ruleId, recordType: 'mbr_approval' }],
                   result: { mbrId: q.mbrId, ver: q.ver, kind: kind, signatureId: sig.signatureId } };
        },
        keys: [KEYS.MBR]
      }, { note: kind === 'review' ? '서명 뒤 검토 기록 저장 (내용 해시 고정)' : '서명 뒤 승인 기록 저장 (내용 해시 고정)' });
    }

    /* ------------------------------------------------------------ P1 D1-13 · 서명 무효화 (QA 조사) · 변경 브리핑 */
    /**
     * 서명 무효화 (D1-13 개정) — EbrUserSession.voidSignature 에 위임.
     * @param {{signatureId:string, reason:string, password:string, screen?:string}} req  행위자 = 현재 사용자(QA), 비밀번호 재입력(저장 안 함), 사유 1–200자
     * @returns {{ok:true, voidRecord, signature} | {ok:false, why, message, failCount?, locked?}}
     * 무효 기록은 ebr.esignVoid.v1 (추가 전용 · 해시 사슬), 감사 ESIGN_INVALIDATED 와 대조 — 불일치는 모두 fail-closed (ESign.validity).
     */
    function invalidateSignature(req) {
      var s = S(); if (!s || !s.voidSignature) return fail('no_session');
      return s.voidSignature(req || {});
    }

    function briefKey(batchId, opId, ccId) { return str(opId) + '|' + str(ccId); }
    /** 변경 브리핑 서명 현황 → { ok, signers:[{userId, name, signatureId, at, status}] } (서명자마다 1건) */
    function briefingStatus(q) {
      q = q || {}; var s = S(), batchId = str(q.batchId), k = briefKey(batchId, q.opId, q.ccId), seen = {}, out = [];
      readStore(KEYS.EXEC).items.forEach(function (r) { if (r.batchId === batchId && r.scope === 'brief' && r.stepKey === k) seen[r.slot] = r; });
      Object.keys(seen).forEach(function (uid) {
        var r = seen[uid], sig = s && s.ESign ? s.ESign.get(r.signatureId) : null, ok = !!(sig && s.ESign.validity(sig).state === 'valid');
        out.push({ userId: uid, name: sig ? sig.signerName : '', signatureId: r.signatureId, at: r.at, status: ok ? 'signed' : 'invalid' });
      });
      return { ok: true, batchId: batchId, opId: str(q.opId), ccId: str(q.ccId), signers: out };
    }
    /**
     * 변경 브리핑 '읽고 이해함' 서명 시작 (SM-READ-BRIEF, pin_session, 현재 사용자 본인 — 사람마다 1건, 자격 요구 없음).
     * @param {{batchId, opId, ccId, screen?}} req
     */
    function beginBriefingSign(req) {
      req = req || {};
      if (!S()) return fail('no_session');
      var batchId = str(req.batchId), opId = str(req.opId), ccId = str(req.ccId);
      if (!batchId || !opId || !ccId) return fail('bad_briefing');
      var me = curId(), k = briefKey(batchId, opId, ccId);
      var mine = me ? briefingStatus({ batchId: batchId, opId: opId, ccId: ccId }).signers.filter(function (x) { return x.userId === me && x.status === 'signed'; })[0] : null;
      if (mine) return fail('already_signed', MSG.already_signed, { signatureId: mine.signatureId });
      var tgt = batchId + ' · ' + opId + ' 변경 브리핑 ' + ccId;
      return open('brief', {
        signRuleId: RULES.BRIEFING, recordType: 'briefing', tgt: tgt, val: ccId, screen: req.screen,
        statementKind: 'briefing_read', statementCtx: { batchId: batchId, opId: opId, ccId: ccId }, distinctFrom: [], qualTargets: [],
        fields: { batchId: batchId, scope: 'brief', stepKey: k, opId: opId, ccId: ccId, statementKind: 'briefing_read' },
        target: { briefing: { opId: opId, ccId: ccId } },
        openAct: 'BRIEF_SIGN_OPEN',
        precheck: function () {
          var cur = curId(); if (cur && briefingStatus({ batchId: batchId, opId: opId, ccId: ccId }).signers.some(function (x) { return x.userId === cur && x.status === 'signed'; })) return { detail: 'already_signed', message: MSG.already_signed };
          return null;
        },
        apply: function (sig, c) {
          execAppend({ batchId: batchId, scope: 'brief', stepKey: k, slot: sig.signerId, signatureId: sig.signatureId, at: c.at, by: sig.signerId });
          return { audits: [{ act: 'BRIEFING_READ', tgt: tgt, val: sig.signatureId, batchId: batchId, signRuleId: RULES.BRIEFING, recordType: 'briefing' }], result: { batchId: batchId, opId: opId, ccId: ccId, signatureId: sig.signatureId } };
        },
        keys: [KEYS.EXEC]
      }, { batchId: batchId, note: '서명 뒤 브리핑 서명 현황 반영' });
    }

    /** 공통 커밋 (헬퍼 signAndCommitRecord 위임) → 헬퍼 결과 + signatureId · (apply 실패) reason 코드 */
    function signAndCommit(ticket, input) {
      var s = S(); if (!s) return fail('no_session');
      var r = s.signAndCommitRecord(ticket, input || {});
      if (r && r.ok) { r.signatureId = r.signature.signatureId; delete tickets[ticket]; return r; }
      if (r && r.why === 'save_error' && r.detail === 'apply') {
        var code = /^(already_released|no_order_no|no_issued|order_not_found|save_error)$/.exec(str(r.error));
        if (code) { r.reason = code[1]; r.message = (MSG[code[1]] || r.message) + ' (' + code[1] + ')'; }
      }
      if (r && r.closeDialog) delete tickets[ticket];
      return r;
    }
    /** 서명 창 닫기 (헬퍼 cancelRecordSign 위임, 감사 RECORD_SIGN_CANCEL) */
    function cancel(ticket, o) { var s = S(); if (!s) return fail('no_session'); delete tickets[ticket]; return s.cancelRecordSign(ticket, o || {}); }

    /** 데모 초기화: ebr.execRecord.v1 · ebr.release.v1 비우기 + SEED_RESET 감사 (ebr.esign.v1 은 지우지 않음 — 남은 서명은 고아 서명, 게이트 영향 없음) */
    function resetDemo(o) {
      o = o || {};
      var s = S(); if (!s) return fail('no_session');
      var actor = str(o.actorId) || curId() || 'SYSTEM';
      var raw = { e: global.localStorage.getItem(KEYS.EXEC), r: global.localStorage.getItem(KEYS.RELEASE) };
      try {
        writeJson(KEYS.EXEC, { v: 1, items: [] }); writeJson(KEYS.RELEASE, { v: 1, items: [] });
        s.Audit.append({ uid: actor, act: 'SEED_RESET', tgt: KEYS.EXEC + ' · ' + KEYS.RELEASE, val: '실행 · 출하 서명 데모 초기화 (서명 레코드는 보존)', screen: o.screen || '' });
      } catch (e) {
        [[KEYS.EXEC, raw.e], [KEYS.RELEASE, raw.r]].forEach(function (p) { try { if (p[1] == null) global.localStorage.removeItem(p[0]); else global.localStorage.setItem(p[0], p[1]); } catch (e2) { /* 무시 */ } });
        return fail('save_error', '데모 초기화 저장에 실패했습니다 — 바뀌지 않았습니다.');
      }
      return { ok: true };
    }

    /* 스모크용: 데모 체인(설계 §5.4)으로 생산 · 포장 · 검토 서명을 실제 헬퍼 경로로 만든다 (데모 비밀번호, 날짜 = 실행 시각). 현재 사용자는 끝나면 원래대로 */
    function seedSignedBatch(batchId, o) {
      o = o || {};
      var s = S(); if (!s) return fail('no_session');
      batchId = str(batchId) || 'BR-DEMO-0001';
      var pw = s.DEMO_PASSWORD, prev = curId(), done = [], failed = [];
      function sign(user, begin, input) {
        try { s.setCurrentUser(user); } catch (e) { /* 무시 */ }
        var b = begin(); if (!b.ok) { if (b.why !== 'already_signed') failed.push({ user: user, why: b.why, message: b.message }); return; }
        var r = signAndCommit(b.ticket, Object.assign({ userId: user, password: pw }, input || {}));
        if (r.ok) done.push(r.signatureId); else failed.push({ user: user, why: r.why, message: r.message });
      }
      var C = Object.assign({ prodPerform: 'OP-0101', prodVerify: 'SV-0003', packPerform: 'OP-0102', packVerify: 'SV-0003', packLabelQa: 'QA-0007', packReview: 'SV-0011', rbe: 'QA-0011', review: 'QA-0013' }, o.chain || {});
      var scopes = o.scopes || ['prod', 'pack', 'review'];
      if (scopes.indexOf('prod') >= 0) stepsFor('prod', batchId).forEach(function (st) {
        sign(C.prodPerform, function () { return beginStepSign({ batchId: batchId, scope: 'prod', stepKey: st.stepKey, slot: 'perform', values: [], screen: 'seedSignedBatch' }); });
        sign(C.prodVerify, function () { return beginStepSign({ batchId: batchId, scope: 'prod', stepKey: st.stepKey, slot: 'verify', values: [], screen: 'seedSignedBatch' }); });
      });
      if (scopes.indexOf('pack') >= 0) stepsFor('pack', batchId).forEach(function (st) {
        st.slots.forEach(function (sl) {
          var u = sl.slot === 'perform' ? C.packPerform : sl.slot === 'qa' ? C.packLabelQa : sl.slot === 'review' ? C.packReview : C.packVerify;
          sign(u, function () { return beginStepSign({ batchId: batchId, scope: 'pack', stepKey: st.stepKey, slot: sl.slot, values: [], screen: 'seedSignedBatch' }); });
        });
      });
      if (scopes.indexOf('review') >= 0) {
        SS().rbeExceptions(batchId).filter(function (e) { return e.open; }).forEach(function (e) { sign(C.rbe, function () { return beginReviewSign({ batchId: batchId, kind: 'rbe', exceptionId: e.id, screen: 'seedSignedBatch' }); }); });
        sign(C.review, function () { return beginReviewSign({ batchId: batchId, kind: 'batch', screen: 'seedSignedBatch' }); });
        sign(C.review, function () { return beginReviewSign({ batchId: batchId, kind: 'audit', screen: 'seedSignedBatch' }); });
      }
      try { s.setCurrentUser(prev || null); } catch (e) { /* 무시 */ }
      return { ok: !failed.length, signed: done.length, signatureIds: done, failed: failed };
    }

    return {
      VERSION: 1, KEYS: clone(KEYS), RULES: clone(RULES), SCOPES: SCOPES.slice(), SLOTS: SLOTS.slice(), REVIEW_KINDS: REVIEW_KINDS.slice(), MATQC_TO: MATQC_TO.slice(),
      REASON_MAX: REASON_MAX, MSG: clone(MSG), NOTE: clone(NOTE),
      stepsFor: stepsFor, beginStepSign: beginStepSign, beginMatQcSign: beginMatQcSign, beginReviewSign: beginReviewSign, beginReleaseSign: beginReleaseSign,
      beginMbrSign: beginMbrSign, mbrSignState: mbrSignState, invalidateSignature: invalidateSignature, beginBriefingSign: beginBriefingSign, briefingStatus: briefingStatus, INVALIDATE_REASON_MAX: INVALIDATE_REASON_MAX,
      signAndCommit: signAndCommit, cancel: cancel, markOrderCompleted: markOrderCompleted, resetDemo: resetDemo, manifestOf: function (b) { var m = manifestOf(str(b)); return m.ok ? { ok: true, manifest: m.manifest, hash: m.hash, blocked: m.blocked } : m; },
      create: create,
      _test: { seedSignedBatch: seedSignedBatch }
    };
  }

  var API = create({});
  global.EbrExecSign = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
