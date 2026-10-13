/* =====================================================================
   ebr-exec-sign-store.js — 생산 · 포장 실행 · 자재 QC · 검토 · 출하 서명 래퍼 (전역 EbrExecSign)
   - 설계: poc-exec-release-esign-design.md 개정 1.1 §3.1 · §3.4 · §5.2 · §5.3 (D1-04 ~ D1-07 · D1-10), UI 항목 UI-12
   - 모든 서명은 EbrUserSession.beginRecordSign / signAndCommitRecord / cancelRecordSign 한 경로 (판정 ①–⑦ · ebr.esign.v1 · ebr.audit.v1).
     칭량 EbrDispense.beginSign 과 같은 구조 — spec = { signRuleId, recordType, fields, statementKind, statementCtx, distinctFrom, qualTargets, requireInput, precheck, apply, keys, openAct }.
   - 저장 키 (이 파일 소유): ebr.execRecord.v1 { v, items:[{batchId, scope, stepKey, slot, signatureId, at, by, valueHash, valueCount, values(값 사본 — 정정 대상 조회용)}] }
                            ebr.release.v1    { v, items:[{batchId, releasedAt, signatureId, manifestHash(64), gateSnapshot:[{no, st, refs}], orderNo}] }
                            ebr.mbrSign.v1    { v, items:[{mbrId, ver, contentHash, kind, signatureId, at, by}] }  (P1 MBR 검토 · 승인)
     함께 쓰기(커밋 안에서만, 실패 시 헬퍼가 원본 복원): ebr.materialLot.v1 (judgeSignatureId · judgedAt · judgedBy · judgeReason · status), ebr.order.v1 (출하 시 오더 완료)
   - 화면이 넘긴 기록 값(values)은 저장하지 않고 valueHash(sha256 · stableStringify)와 건수만 서명 레코드 · 실행 기록에 묶는다.
   - 비밀번호는 받지도 저장하지도 않는다(헬퍼가 판정). 정의(단계 · 슬롯 · 데모 RBE 예외)는 EbrSignStatus 와 공유.
   - EbrExecSign.create({ session?, signStatus?, matqc?, dev?, qual? }) 로 노드 시험 주입. 모듈은 호출 시점에 찾는다(로드 순서 무관).
   ===================================================================== */
(function (global) {
  'use strict';

  var KEYS = { EXEC: 'ebr.execRecord.v1', RELEASE: 'ebr.release.v1', MAT: 'ebr.materialLot.v1', ORDER: 'ebr.order.v1', ISSUED: 'ebr.batch.issued.v1', MBR: 'ebr.mbrSign.v1', ESIGN: 'ebr.esign.v1', DOWNTIME: 'ebr.downtime.v1', INTEGRITY: 'ebr.integrity.v1' };
  var COND_ACT = { 7: 'DOWNTIME_REVIEWED', 10: 'CHANGE_IMPACT_REVIEWED', 11: 'CONTROL_EVAL_REVIEWED', 12: 'RESTORE_ACKED' };
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
    bad_briefing: '배치 · 단계 · 변경 번호가 필요합니다.',
    no_gate_eval: '출하 게이트 판정 모듈(EbrGateEval)을 찾을 수 없습니다 — 차단(fail-closed).', read_only: '복원 탐지로 읽기 전용입니다 — QA 복원 확인 서명 필요(데모 초기화는 QA·관리자만)',
    cond_changed: '서명 창을 연 뒤 조건 판정이 바뀌었습니다 — 창을 닫고 다시 여세요.'
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
    function GE() { return opts.gateEval || global.EbrGateEval || null; }
    /* 조건 12 읽기 전용 (개정 1.2 G1-04 · J4): 서명 시작 · 커밋 · 저장 모두 거부. 해소 서명(조건 12 SM-REV-RESTORE)만 예외 — 설계 §3 · G1-04 '(SM-REV-RESTORE 제외)'.
       배치가 없는 서명(MBR 등)은 전역 무결성(배치 '')으로 판정. 판정 모듈이 없으면 검사 생략(출하 승인은 manifestOf 에서 별도 fail-closed) */
    function roCheck(batchId, isRestoreAck) {
      var ge = GE(); if (!ge || isRestoreAck) return null;
      var ro = ge.readOnly(str(batchId)); return ro.readOnly ? fail('read_only', MSG.read_only, { readOnlyWhy: ro.why, closeDialog: true }) : null;
    }
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
      /* 조건 12 (복원 탐지 · 무결성 불일치) 동안 배치 서명 금지 — 해소 서명(조건 12 QA 확인)만 허용. 판정 모듈이 없으면 검사 생략(출하 승인은 별도로 fail-closed) */
      var ro = roCheck(extra.batchId, kind === 'cond' && extra.condNo === 12); if (ro) return ro;
      var ri = ruleInfo(spec.signRuleId);
      spec.target = Object.assign({ rule: ri, ruleLine: ruleLine(ri), qualReq: qualReq(spec.signRuleId, spec.qualTargets), note: extra.note || '' }, spec.target || {});
      var r = s.beginRecordSign(spec);
      if (!r.ok) return r;
      tickets[r.ticket] = { kind: kind, batchId: extra.batchId || null, condNo: extra.condNo || null };
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
          execAppend({ batchId: batchId, scope: scope, stepKey: step.stepKey, slot: sd.slot, signatureId: sig.signatureId, at: c.at, by: sig.signerId, valueHash: valueHash, valueCount: values.length, values: JSON.parse(JSON.stringify(values)) });
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
      /* S2: 데모 시드 판정 서명(서명 demoSeedBatch · LOT judgeDemoBatch)은 데모 배치에서만 인정 → 실배치 사용자는 같은 LOT 를 다시 판정(재확인)할 수 있어야 함 */
      var demoB = req.demoSeedBatch ? str(req.demoSeedBatch) : '';
      var okState = to === 'legacy_confirm' ? (lot.status === 'released' && (!lot.judgeSignatureId || (!demoB && !!lot.judgeDemoBatch))) : lot.status === 'testing';
      if (!okState) return fail('bad_state', MSG.bad_state + ' (현재 ' + lot.status + (lot.judgeSignatureId ? ' · 판정 서명 있음' : '') + ')');
      var kind = to === 'rejected' ? 'matqc_reject' : (to === 'legacy_confirm' ? 'matqc_legacy_confirm' : 'matqc_release');
      var before = lot.status, after = to === 'legacy_confirm' ? 'released' : to, lotNo = lot.lotNo, tgt = 'LOT ' + lotNo + ' (' + (lot.materialId || '') + ')';
      return open('matqc', {
        signRuleId: RULES.MATQC, recordType: 'material_qc', tgt: tgt, val: before + ' → ' + after, screen: req.screen,
        statementKind: kind, statementCtx: { lotNo: lotNo, matCode: lot.materialId || '', reason: '' }, statementInputKeys: to === 'rejected' ? ['reason'] : [],
        fields: demoB ? { batchId: lot.batchId || null, lotNo: lotNo, materialId: lot.materialId || '', matqcTo: to, statementKind: kind, beforeStatus: before, demoSeedBatch: demoB }
                      : { batchId: lot.batchId || null, lotNo: lotNo, materialId: lot.materialId || '', matqcTo: to, statementKind: kind, beforeStatus: before },
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
          var patch = { lotNo: lotNo, status: after, judgeSignatureId: sig.signatureId, judgedAt: c.at, judgedBy: sig.signerId, judgeDemoBatch: demoB || null };   /* 실판정은 데모 표지 지움 */
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

    /* 출하 manifest (§3.4-3 · 게이트 동적 판정 G1-07): EbrGateEval.manifestInput — {v:1, batchId, gate:[{no, st:'pass'|'block'|'na', refs}] 12건, signs:[정렬]}.
       시각 · basis · 화면 상태 · 현재 사용자 제외. 판정 모듈이 없으면 fail-closed */
    function manifestOf(batchId) {
      var ge = GE(); if (!ge) return { ok: false, why: 'no_gate_eval', message: MSG.no_gate_eval };
      var mi = ge.manifestInput(batchId); if (!mi.ok) return { ok: false, why: mi.why, message: mi.message };
      var m = mi.manifest, s = S(), items = {};
      mi.items.forEach(function (x) { items[x.no] = x; });
      return { ok: true, manifest: m, hash: s.sha256Hex(s.stableStringify(m)), blocked: mi.blocked, naNos: mi.naNos, items: items, signers: mi.signers };
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
      if (mf.blocked.length) {
        /* 결정 7: gate_blocked 가 먼저여도 읽기 전용이면 사유를 함께 싣는다 */
        var roG = mf.items[12] && mf.items[12].st === 'block';
        return fail('gate_blocked', MSG.gate_blocked + ' (게이트 ' + mf.blocked.join(' · ') + ')' + (roG ? ' ' + MSG.read_only : ''),
          roG ? { blocked: mf.blocked, readOnly: true, readOnlyWhy: mf.items[12].why || 'restore_detected' } : { blocked: mf.blocked });
      }
      var me = curId(), qaProxy = !!me && rolesOf(me).indexOf('QP') < 0;
      var distinct = mf.signers.map(function (x) { return { userId: x.userId, label: x.label }; });
      /* ⑥ (P-a1): 조건 10 변경 영향 검토 서명자 추가 (7 · 11 · 12 서명자는 넣지 않음) */
      (mf.items[10] && mf.items[10].st === 'pass' ? mf.items[10].refs : []).forEach(function (id) { var g = s.ESign.get(id); if (g && g.signRuleId === 'SM-REV-CHG') distinct.push({ userId: g.signerId, label: '변경 영향 검토자 (조건 10)' }); });
      var hash = mf.hash, tgt = batchId + ' · 출하 승인';
      return open('release', {
        signRuleId: RULES.RELEASE, recordType: 'release', tgt: tgt, val: 'manifest ' + hash.slice(0, 8), orderNo: orderNo, screen: req.screen,
        statementKind: 'batch_release', statementCtx: { batchId: batchId, manifestHash: hash, qaProxy: qaProxy, naCount: mf.naNos.length, naNos: mf.naNos.slice() }, distinctFrom: uniqDistinct(distinct), qualTargets: [],
        fields: { batchId: batchId, manifestHash: hash, statementKind: 'batch_release', qaProxy: qaProxy, naNos: mf.naNos.slice() },
        target: { manifestHash: hash, manifestHash8: hash.slice(0, 8), gate: clone(mf.manifest.gate), gateItems: clone(mf.items), naNos: mf.naNos.slice(), qaProxy: qaProxy, qaProxyBadge: qaProxy ? 'PoC 전용 — QA 대행 · QP 인증 아님' : '' },
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

    /* ------------------------------------------------------------ 출하 게이트 조건 서명 (게이트 동적 판정 G1-06 — 조건 7 · 10 · 11 · 12, 허용 QA · 자격 QD-REVBATCH)
       spec 은 EbrGateEval.condSignSpec 이 만든다(판정과 같은 근거). 커밋 시 precheck 로 다시 판정해 바뀌었으면 cond_changed. */
    /**
     * @param {{batchId, no:7|10|11|12, dtId?:string, screen?}} req  dtId = 조건 7 대상 다운타임(없으면 첫 미검토)
     */
    function beginCondSign(req) {
      req = req || {};
      var ge = GE(); if (!S()) return fail('no_session'); if (!ge) return fail('no_gate_eval');
      var batchId = str(req.batchId); if (!batchId) return fail('no_batch');
      var no = Number(req.no), sp = ge.condSignSpec(batchId, no, { dtId: req.dtId });
      if (!sp.ok) return fail(sp.why, sp.message);
      var ri = ruleInfo(sp.signRuleId);
      if (!ri.effective || !ri.roles.length) return fail('rule_not_effective', MSG.rule_not_effective + ' (' + sp.signRuleId + ')');
      var keys = no === 7 ? [KEYS.DOWNTIME] : no === 12 ? [KEYS.INTEGRITY] : [];
      return open('cond', {
        signRuleId: sp.signRuleId, recordType: sp.recordType, tgt: sp.tgt, val: sp.val, screen: req.screen,
        statementKind: sp.statementKind, statementCtx: sp.statementCtx, distinctFrom: uniqDistinct(sp.distinctFrom || []), qualTargets: [],
        fields: sp.fields, target: { cond: { no: no, label: sp.label, key: sp.key } }, openAct: 'GATE_COND_SIGN_OPEN',
        precheck: function () {
          var p2 = ge.condSignSpec(batchId, no, { dtId: req.dtId });
          if (!p2.ok || p2.key !== sp.key) return { detail: p2.ok ? 'cond_changed' : p2.why, message: MSG.cond_changed };
          return null;
        },
        apply: function (sig, c) {
          if (no === 7) {
            var o = readJson(KEYS.DOWNTIME, null); if (!o || !Array.isArray(o.items)) throw codeErr('no_downtime');
            var d = o.items.filter(function (x) { return x && x.dtId === sp.fields.dtId; })[0]; if (!d || d.reviewSignatureId) throw codeErr('cond_changed');
            d.reviewSignatureId = sig.signatureId; d.reviewedAt = c.at; d.reviewedBy = sig.signerId;
            writeJson(KEYS.DOWNTIME, o);
          }
          if (no === 12) S().Integrity.reset(sig.signatureId);
          return { audits: [{ act: COND_ACT[no], tgt: sp.tgt, val: sig.signatureId + ' · ' + sp.val, batchId: batchId, signRuleId: sp.signRuleId, recordType: sp.recordType }],
                   result: { batchId: batchId, no: no, signatureId: sig.signatureId, key: sp.key } };
        },
        keys: keys
      }, { batchId: batchId, condNo: no, note: '서명 뒤 출하 게이트 조건 ' + no + ' 재평가' });
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
      var g0 = req && req.signatureId && s.ESign.get(str(req.signatureId)); var ro = roCheck(g0 ? g0.batchId : '', false); if (ro) return ro;
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
      var tk = tickets[ticket];
      if (tk) { var ro = roCheck(tk.batchId, tk.kind === 'cond' && tk.condNo === 12); if (ro) { delete tickets[ticket]; s.cancelRecordSign(ticket, { why: 'error', message: 'read_only' }); return ro; } }
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

    /** 데모 초기화 (QA · ADMIN, 현재 사용자 필수): ebr.execRecord.v1 · ebr.release.v1 비우기 + SEED_RESET 감사.
     *  o.wipeSignatures:true → 서명(ebr.esign.v1) · 무효 사슬(ebr.esignVoid.v1)도 비움. 복원 탐지(읽기 전용) 해제는 이렇게 서명 0건이 된 경우만 —
     *  탐지 중인데 서명을 남기는 초기화는 아무것도 바꾸지 않고 restore_ack_required (조건 12 SM-REV-RESTORE 확인 서명 필요). */
    function resetDemo(o) {
      o = o || {};
      var s = S(); if (!s) return fail('no_session');
      var actor = curId(); if (!actor) return fail('no_current_user', '현재 사용자를 선택하세요.');
      if (o.actorId && str(o.actorId) !== actor) return fail('actor_mismatch', '현재 사용자만 데모 초기화를 할 수 있습니다.');
      var rs = s.rolesOf(actor) || []; if (rs.indexOf('QA') < 0 && rs.indexOf('ADMIN') < 0) return fail('role_restricted', '데모 초기화는 QA · ADMIN 만 할 수 있습니다.');
      var st = s.Integrity.state(), detected = !!(st.restored || st.unreadable), wipe = !!o.wipeSignatures;
      /* 서명까지 비우는 초기화(복원 탐지 해제 포함)는 비밀번호 재입력 (verifyPassword, 저장하지 않음) */
      /* 틀린 비밀번호는 실패 카운트 +1 · 5회째 잠금 (reauthCurrent, 21 CFR 11.300(d)) */
      if (wipe) {
        var ra = s.reauthCurrent(actor, o.password, { screen: o.screen, act: '데모 초기화(서명 비움) 재인증' });
        if (!ra.ok) return fail(ra.why, ra.why === 'reauth_required' ? '서명까지 비우는 데모 초기화는 현재 사용자 비밀번호를 다시 입력해야 합니다.' + (ra.failCount ? ' (인증 실패 ' + ra.failCount + '/' + s.MAX_FAIL + ')' : '') : ra.why === 'locked' ? '계정이 잠겼습니다 — 관리자 잠금 해제가 필요합니다.' : '비활성 계정입니다.', { failCount: ra.failCount, locked: !!ra.locked, maxFail: s.MAX_FAIL });
      }
      if (detected && !wipe) return fail('restore_ack_required', '복원 탐지 상태입니다 — 서명 기록을 남기는 데모 초기화로는 해제할 수 없습니다. 조건 12 QA 복원 확인 서명(SM-REV-RESTORE) 또는 서명까지 비우는 데모 초기화(wipeSignatures)를 쓰세요.');
      var KE = s.KEYS.ESIGN, KV = s.KEYS.ESIGN_VOID, ls = global.localStorage;
      var KM = 'ebr.materialLot.v1', KD = DEMO_SEED_KEY;
      var keys = [KEYS.EXEC, KEYS.RELEASE, s.Integrity.KEY, 'ebr.interlockDemo.v1', KM].concat(wipe ? [KE, KV, KD] : []), raw = {}, cleared = false;   /* 인터록 데모 · 자재 LOT 도 되돌림 대상 (seedDemo 가 쓰므로) */
      keys.forEach(function (k) { raw[k] = ls.getItem(k); });
      try {
        writeJson(KEYS.EXEC, { v: 1, items: [] }); writeJson(KEYS.RELEASE, { v: 1, items: [] });
        if (wipe) {
          ls.setItem(KE, '[]'); ls.removeItem(KV); ls.removeItem(KD);   /* 데모 시드 표지도 지움 → 다음 시드에서 판정 서명 다시 생성 */
          /* 자재 LOT 판정 서명 참조(…SignatureId)를 비움 — 서명 원장이 비었으니 참조만 남기지 않는다 (판정 상태는 그대로 = 레거시 LOT) */
          var mr = ls.getItem(KM); if (mr) { var mo = JSON.parse(mr); (mo.lots || []).forEach(function (l) { Object.keys(l || {}).forEach(function (f) { if (/[sS]ignatureId$/.test(f)) delete l[f]; }); }); ls.setItem(KM, JSON.stringify(mo)); }
        }
        if (global.EbrInterlock && typeof global.EbrInterlock.seedDemo === 'function') global.EbrInterlock.seedDemo({ force: true });   /* 인터록 데모 데이터(정상 프리셋) — ILR-DEMO 병합 (인터록 I1-11) */
        s.Audit.append({ uid: actor, act: 'SEED_RESET', tgt: KEYS.EXEC + ' · ' + KEYS.RELEASE + (wipe ? ' · ' + KE + ' · ' + KV : ''), val: wipe ? '실행 · 출하 · 서명 · 무효 사슬 데모 초기화' : '실행 · 출하 서명 데모 초기화 (서명 레코드는 보존)', screen: o.screen || '' });
        if (detected) {
          var dr = s.Integrity.demoReset(actor, o.screen || '', o.password);
          if (!dr.ok) throw { why: dr.why, message: dr.message, refs: dr.refs };
          cleared = dr.cleared;
        }
      } catch (e) {
        keys.forEach(function (k) { try { if (raw[k] == null) ls.removeItem(k); else ls.setItem(k, raw[k]); } catch (e2) { /* 무시 */ } });
        if (e && e.why) { var fr = fail(e.why, e.message); if (e.refs) fr.refs = e.refs; return fr; }
        return fail('save_error', '데모 초기화 저장에 실패했습니다 — 바뀌지 않았습니다.');
      }
      return { ok: true, integrityCleared: cleared, wiped: wipe };
    }

    /* 스모크용: 데모 체인(설계 §5.4)으로 생산 · 포장 · 검토 서명을 실제 헬퍼 경로로 만든다 (데모 비밀번호, 날짜 = 실행 시각). 현재 사용자는 끝나면 원래대로 */
    /**
     * 데모 기본 시드 — 데모 배치(EbrSignStatus.DEMO_BATCH) LOT 중 released 이고 판정 서명이 없는(레거시) LOT 를 QA-0011 legacy_confirm 으로 서명.
     * 실제 서명 경로(beginMatQcSign → signAndCommit, 헬퍼 ⑤⑥⑦ · 읽기 전용 판정 그대로). 표지 ebr.demoSeed.v1.matqcSign 로 1회만(서명을 무효화해도 다시 만들지 않음).
     * MatQC.seedIfEmpty 가 부른다 → 화면은 따로 부르지 않는다. → { ok, signed, skipped? }
     */
    var DEMO_SEED_KEY = 'ebr.demoSeed.v1';
    /* S2: 외부(export) 호출은 demoGuard(데모 배치 · 데모 표지 · ADMIN) — 거부 시 감사만. seedDemoReleaseReady 는 가드를 통과한 뒤 core 를 부름 */
    function seedDemoMatQc(o) {
      o = o || {};
      var g = demoGuard('seedDemoMatQc', str(o.batchId) || (SS() && SS().DEMO_BATCH), true); if (g) return g;
      return seedDemoMatQcCore(o);
    }
    /* 판정 서명은 LOT 단위 → 서명(demoSeedBatch) · LOT(judgeDemoBatch)에 데모 배치 표지. EbrSignStatus 는 다른 배치에서 이 서명을 판정 서명으로 보지 않음(조건 9 차단 유지) */
    function seedDemoMatQcCore(o) {
      o = o || {};
      var s = S(), ss = SS(); if (!s || !ss) return fail('no_session');
      var mark = readJson(DEMO_SEED_KEY, null) || {};
      if (mark.matqcSign && !o.force) return { ok: true, signed: 0, skipped: 'done' };
      var batchId = str(o.batchId) || ss.DEMO_BATCH, ms = ss.matqcSignStatus(batchId);
      if (!ms.ok) return fail(ms.why, ms.message);
      var prev = curId(), done = [], failed = [];
      ms.items.filter(function (x) { return x.sign === 'legacy' && x.status === 'released'; }).forEach(function (x) {
        try { s.setCurrentUser('QA-0011'); } catch (e) { /* 무시 */ }
        var b = beginMatQcSign({ lotNo: x.lotNo, to: 'legacy_confirm', screen: 'demoSeed', demoSeedBatch: batchId }); if (!b.ok) { failed.push({ lotNo: x.lotNo, why: b.why }); return; }
        var r = signAndCommit(b.ticket, { userId: 'QA-0011', password: s.DEMO_PASSWORD });
        if (r.ok) done.push(r.signatureId); else failed.push({ lotNo: x.lotNo, why: r.why });
      });
      try { s.setCurrentUser(prev || null); } catch (e) { /* 무시 */ }
      if (!failed.length && done.length) { mark.matqcSign = { at: s.nowIsoLocal(), batchId: batchId, signatureIds: done }; try { writeJson(DEMO_SEED_KEY, mark); } catch (e) { /* 표지 실패 — 다음에 다시 시도 */ } }
      return { ok: !failed.length, signed: done.length, signatureIds: done, failed: failed };
    }
    /** 데모: 출하 승인 창이 열리도록 서명으로 해소할 차단을 모두 서명 (seedDemoMatQc + seedSignedBatch 전 범위). 판정 자체는 바꾸지 않음 → { ok, signed, failed, blocked } */
    /* 데모 배치 발행 기록 — 데모 배치에 발행 기록이 아예 없을 때만 만든다 (있으면 절대 덮어쓰지 않음: 불완전한 기록은 그대로 조건 7 · 10 차단).
       효력 데모 MBR PT-TAB-A v3 · EF 0매 · 예약 LOT = 데모 LOT. 오더가 없으면 데모 오더(in_progress). 감사 DEMO_ISSUE_SEED */
    var DEMO_ISSUE = { orderNo: 'WO-DEMO-0001', processTreeId: 'PT-TAB-A', ver: '3', line: 'L-01' };
    function seedDemoIssue(batchId) {
      var s = S(), ss = SS(); if (!s || !ss) return { ok: false, why: 'no_session' };
      if (batchId !== ss.DEMO_BATCH) return { ok: true, created: false };
      if (ss.issuedOf(batchId)) return { ok: true, created: false };
      var rows = readJson(KEYS.ISSUED, []); if (!Array.isArray(rows)) return { ok: false, why: 'issued_unreadable' };
      var lots = (ss.reservedLots(batchId) || []).map(function (l) { return { lotNo: l.lotNo, materialId: l.materialId, qty: l.qty }; });
      if (!lots.length) return { ok: false, why: 'no_demo_lots' };
      var rec = { batchId: batchId, orderNo: DEMO_ISSUE.orderNo, processTreeId: DEMO_ISSUE.processTreeId, ver: DEMO_ISSUE.ver, line: DEMO_ISSUE.line, issuedAt: s.nowIsoLocal(),
                  efCount: 0, efRange: [], reservedLots: lots, demoSeed: true };
      var ords = readJson(KEYS.ORDER, []); if (!Array.isArray(ords)) ords = [];
      var addOrd = !ords.some(function (x) { return x && x.orderNo === DEMO_ISSUE.orderNo; });
      var raw0 = global.localStorage.getItem(KEYS.ISSUED), rawO = global.localStorage.getItem(KEYS.ORDER);
      try {
        writeJson(KEYS.ISSUED, rows.concat([rec]));
        if (addOrd) writeJson(KEYS.ORDER, ords.concat([{ orderNo: DEMO_ISSUE.orderNo, status: 'in_progress', batchNo: batchId }]));
        s.Audit.append({ uid: curId() || 'SYSTEM', act: 'DEMO_ISSUE_SEED', tgt: batchId, val: '데모 발행 기록 ' + rec.processTreeId + ' v' + rec.ver + ' · EF 0 · LOT ' + lots.length + (addOrd ? ' · 오더 ' + rec.orderNo : ''), screen: 'seedDemoReleaseReady' });
      } catch (e) {
        try { if (raw0 == null) global.localStorage.removeItem(KEYS.ISSUED); else global.localStorage.setItem(KEYS.ISSUED, raw0);
              if (rawO == null) global.localStorage.removeItem(KEYS.ORDER); else global.localStorage.setItem(KEYS.ORDER, rawO); } catch (e2) { /* 무시 */ }
        return { ok: false, why: 'save_error' };
      }
      return { ok: true, created: true };
    }
    /* 데모 시드 가드 (실데이터 서명 위조 차단): 데모 배치(DEMO_BATCH)만 · 데모 표지(발행 기록 없음 → 데모 발행 기록을 만들 경우, 또는 발행 기록 demoSeed:true · 데모 오더 번호)
       · requireAdmin 이면 현재 사용자 ADMIN 만. 거부 시 감사 DEMO_SEED_REFUSED (데이터는 바꾸지 않음) */
    function demoGuard(fn, batchId, requireAdmin) {
      var s = S(), ss = SS(); if (!s || !ss) return fail('no_session');
      var why = null, actor = curId(), iss = null;
      if (batchId !== ss.DEMO_BATCH) why = 'not_demo_batch';
      else {
        iss = ss.issuedOf(batchId);
        if (iss && !(iss.demoSeed === true || /^(WO|ORD)-DEMO-/.test(str(iss.orderNo)))) why = 'no_demo_marker';
        else if (requireAdmin && (!actor || (s.rolesOf(actor) || []).indexOf('ADMIN') < 0)) why = actor ? 'role_restricted' : 'no_current_user';
      }
      if (!why) return null;
      try { s.Audit.append({ uid: actor || 'SYSTEM', act: 'DEMO_SEED_REFUSED', tgt: str(batchId) || '—', val: fn + ' 거부 — ' + why, why: why, screen: fn }); } catch (e) { /* 감사 실패해도 거부 유지 */ }
      return fail(why, why === 'not_demo_batch' ? '데모 배치(' + ss.DEMO_BATCH + ')에서만 쓸 수 있습니다.' : why === 'no_demo_marker' ? '데모 표지가 없는 발행 기록입니다 — 실데이터에는 데모 시드를 쓸 수 없습니다.'
        : why === 'role_restricted' ? '데모 출하 준비 시드는 관리자(ADMIN)만 실행할 수 있습니다.' : '현재 사용자를 선택하세요.', { signed: 0, failed: [], blocked: null, blockedDetail: null });
    }
    function seedDemoReleaseReady(batchId, o) {
      batchId = str(batchId) || SS().DEMO_BATCH; o = o || {};
      var g = demoGuard('seedDemoReleaseReady', batchId, true); if (g) return g;
      var di = o.issue === false ? { ok: true, created: false } : seedDemoIssue(batchId);
      if (!di.ok) return { ok: false, why: di.why, signed: 0, failed: [], blocked: null, blockedDetail: null };
      var m = seedDemoMatQcCore({ batchId: batchId, force: true }), r = seedSignedBatchCore(batchId, o);
      var mf = manifestOf(batchId), GE = global.EbrGateEval, ev = null;
      try { ev = GE && GE.evaluate ? GE.evaluate(batchId) : null; } catch (e) { ev = null; }
      /* 막힌 조건마다 이유 (데모 배치는 발행 기록이 없을 때만 데모 발행 기록을 만든다 — 이미 있는 불완전한 기록은 그대로 조건 7 · 10 차단) */
      var blockedDetail = mf.ok ? mf.blocked.map(function (no) {
        var it = ev && ev.items ? ev.items[no - 1] : null;
        return { no: no, why: it ? it.why || 'blocked' : 'blocked', basis: it ? it.basis || '' : '', message: it ? it.msg || it.basis || '' : '' };
      }) : null;
      var ok = m.ok && r.ok && mf.ok && !mf.blocked.length;
      return { ok: ok, issueCreated: !!di.created, signed: (m.signed || 0) + r.signed, failed: (m.failed || []).concat(r.failed || []), blocked: mf.ok ? mf.blocked : null, blockedDetail: blockedDetail,
               why: !mf.ok ? mf.why : ok ? undefined : (mf.blocked.length ? 'gate_blocked' : 'sign_failed') };
    }
    /* 시험 · 스모크 훅(_test): 데모 배치 + 데모 표지만 (역할 제한 없음 — 스모크가 QP 화면에서 부름) */
    function seedSignedBatch(batchId, o) {
      batchId = str(batchId) || 'BR-DEMO-0001';
      var g = demoGuard('seedSignedBatch', batchId, false); if (g) return g;
      return seedSignedBatchCore(batchId, o);
    }
    function seedSignedBatchCore(batchId, o) {
      o = o || {};
      var s = S(); if (!s) return fail('no_session');
      var pw = s.DEMO_PASSWORD, prev = curId(), done = [], failed = [];
      function sign(user, begin, input) {
        try { s.setCurrentUser(user); } catch (e) { /* 무시 */ }
        var b = begin(); if (!b.ok) { if (b.why !== 'already_signed') failed.push({ user: user, why: b.why, message: b.message }); return; }
        var r = signAndCommit(b.ticket, Object.assign({ userId: user, password: pw }, input || {}));
        if (r.ok) done.push(r.signatureId); else failed.push({ user: user, why: r.why, message: r.message });
      }
      var C = Object.assign({ prodPerform: 'OP-0101', prodVerify: 'SV-0003', packPerform: 'OP-0102', packVerify: 'SV-0003', packLabelQa: 'QA-0007', packReview: 'SV-0011', rbe: 'QA-0011', review: 'QA-0013', cond: 'QA-0011' }, o.chain || {});
      var scopes = o.scopes || ['prod', 'pack', 'review', 'cond'];
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
      /* 출하 게이트 조건 서명 (7 미검토 다운타임 · 10 · 11) — 서명으로 해소할 차단만. scopes 에 'cond' 를 넣을 때만 */
      if (scopes.indexOf('cond') >= 0 && GE()) [7, 10, 11].forEach(function (no) {
        for (var guardN = 0; guardN < 20; guardN++) {
          var sp = GE().condSignSpec(batchId, no); if (!sp.ok) break;
          var before = done.length; sign(C.cond, function () { return beginCondSign({ batchId: batchId, no: no, screen: 'seedSignedBatch' }); });
          if (done.length === before) break;
        }
      });
      try { s.setCurrentUser(prev || null); } catch (e) { /* 무시 */ }
      return { ok: !failed.length, signed: done.length, signatureIds: done, failed: failed };
    }

    return {
      VERSION: 1, KEYS: clone(KEYS), RULES: clone(RULES), SCOPES: SCOPES.slice(), SLOTS: SLOTS.slice(), REVIEW_KINDS: REVIEW_KINDS.slice(), MATQC_TO: MATQC_TO.slice(),
      REASON_MAX: REASON_MAX, MSG: clone(MSG), NOTE: clone(NOTE),
      seedDemoMatQc: seedDemoMatQc, seedDemoReleaseReady: seedDemoReleaseReady,
      stepsFor: stepsFor, beginStepSign: beginStepSign, beginMatQcSign: beginMatQcSign, beginReviewSign: beginReviewSign, beginReleaseSign: beginReleaseSign,
      beginMbrSign: beginMbrSign, mbrSignState: mbrSignState, invalidateSignature: invalidateSignature, beginBriefingSign: beginBriefingSign, briefingStatus: briefingStatus, beginCondSign: beginCondSign, INVALIDATE_REASON_MAX: INVALIDATE_REASON_MAX,
      signAndCommit: signAndCommit, cancel: cancel, markOrderCompleted: markOrderCompleted, resetDemo: resetDemo, manifestOf: function (b) { var m = manifestOf(str(b)); return m.ok ? { ok: true, manifest: m.manifest, hash: m.hash, blocked: m.blocked, naNos: m.naNos } : m; },
      create: create,
      _test: { seedSignedBatch: seedSignedBatch }
    };
  }

  var API = create({});
  global.EbrExecSign = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
