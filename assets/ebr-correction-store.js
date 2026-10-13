/* =====================================================================
   ebr-correction-store.js — 정정(부분 대체) 흐름 store (전역 EbrCorrection)
   - 설계: poc-correction-flow-design.md 확정본 §3 · §4 · §5 (C1-1 · C1-4)
   - 저장 키 (이 파일 소유): ebr.correction.v1 { version:1, items:[정정] } · ebr.rbeException.v1 { v:1, items:[RBE 예외] }
   - 원본 보존: 원 값 · 원 서명은 지우지 않는다. 정정은 추가 레코드, QA 확인 커밋에서 원 서명 무효 기록(헬퍼 내부 경로) + RBE 예외를 원자적으로 추가.
   - 모든 서명은 EbrUserSession.beginRecordSign / signAndCommitRecord / cancelRecordSign 경유. 비밀번호는 받지도 저장하지도 않는다(헬퍼만 판정).
   - 화면과 무관 (DOM 접근 없음). EbrCorrection.create({ storage?, session?, execSign?, signStatus?, dispense?, today? }) 로 노드 시험 주입.
   - 실패 모양 { ok:false, why, message }.
   ===================================================================== */
(function (global) {
  'use strict';

  var KEYS = { CORR: 'ebr.correction.v1', RBE: 'ebr.rbeException.v1', EXEC: 'ebr.execRecord.v1', MASTER: 'ebmr.masterSetup.v2' };
  var RULES = { PERFORM: 'SM-PERF-CORR', VERIFY: 'SM-VERI-CORR' };
  var INTERNAL_KEY_RE = /^h[0-9a-f]{4,}$/i;   /* 화면 공정 로그 행 해시 키 (h0000011) — 표시하지 않음 */
  var STATES = ['DRAFT', 'PERFORMED', 'VERIFIED', 'REJECTED', 'CANCELLED'];
  var REASON_TABLE = 'EBR_CORR_REASON';
  var REASON_MAX = 60;

  var MSG = {
    no_session: '사용자 · 서명 헬퍼(EbrUserSession)가 없습니다.', no_current_user: '현재 사용자가 없습니다.', no_batch: '배치 ID가 없습니다.', no_target: '정정 대상이 올바르지 않습니다.',
    role_restricted: '정정 요청 · 수행 서명은 작업자 · 감독자만 할 수 있습니다.', orig_unsigned: '원 값에 수행 서명이 없어 정정할 수 없습니다 — 아직 서명 전이면 화면에서 바로 고치세요.',
    orig_sig_invalid: '원 서명이 이미 무효(또는 대조 불일치)입니다 — 대상 슬롯을 먼저 다시 서명하세요.', orig_hash_mismatch: '원본 대조 불일치 — 화면 값의 valueHash 가 원 서명 valueHash 와 다릅니다. 정정 불가, QA 에 알리세요.',
    correction_open: '이 대상에 열린 정정(작성 · QA 확인 대기)이 있습니다.', already_released: '출하 승인된 배치라 정정할 수 없습니다 (일탈 · CAPA 경로).', bad_value: '정정 값이 올바르지 않습니다 (빈 값 · 원래 값과 같음 · 인덱스 범위 밖).',
    reason_code_required: '사유 코드를 고르세요.', bad_reason_code: '사유 코드가 GCM EBR_CORR_REASON 에 없거나 비활성입니다.', reason_code_unavailable: '사유 코드표(GCM)를 읽을 수 없습니다 — 정정 불가(fail-closed).',
    reason_required_other: '사유 코드 OTHER(기타)는 자유 사유 입력이 필수입니다.', reason_too_long: '사유는 60자 이하로 입력하세요.', evidence_required: '이 사유 코드는 증빙(첨부 이름)이 필수입니다.',
    weigh_field_locked: '칭량 값(gross · tare · net)은 정정할 수 없습니다 — 재칭량 경로를 쓰세요.', weigh_p1: '칭량 기록 정정(표시 필드)은 P1 입니다.',
    not_found: '정정을 찾을 수 없습니다.', not_draft: '작성 중(DRAFT) 정정이 아닙니다.', not_owner: '작성자 또는 감독자만 바꿀 수 있습니다.', not_performed: 'QA 확인 대기(PERFORMED) 정정이 아닙니다.',
    not_qa: '반려는 QA 만 할 수 있습니다.', reason_required: '반려 사유를 입력하세요 (1–60자).', record_tampered: '정정 레코드 대조(recordHash)가 맞지 않습니다 — 처리 불가.',
    step_unknown: '단계 정의에서 포장 단계를 찾을 수 없습니다 — 정정할 수 없습니다 (화면이 넘긴 단계 이름은 쓰지 않음).',
    save_error: '저장에 실패했습니다 — 바뀌지 않았습니다.', precheck_changed: '서명 창을 연 뒤 정정 · 원 서명 상태가 바뀌었습니다. 다시 여세요.'
  };
  var TARGET_KINDS = ['exec_value', 'weigh_record'];
  var WEIGH_FIELDS = ['containerLabel', 'note'];
  var SCOPE_LABEL = { prod: '생산', pack: '포장' };

  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function str(v) { return v == null ? '' : String(v).trim(); }
  function len(v) { return Array.from(str(v)).length; }
  function fail(why, extra) { var r = { ok: false, why: why, message: MSG[why] || why }; if (extra) Object.keys(extra).forEach(function (k) { r[k] = extra[k]; }); return r; }

  /* GCM 행의 체크박스 값 (true · 'Y' · 'true' · 1) */
  function yes(v) { return v === true || v === 1 || /^(y|yes|true|1)$/i.test(str(v)); }
  /* 내장 사유 코드 (shared-store GCM 시드와 같은 값 — 마스터 키가 아직 없을 때만) */
  var BUILTIN_REASONS = [['TRANSCRIPTION', '전기 오류', false, true], ['MEASURE_ERR', '측정 오류', false, false], ['UNIT', '단위 오류', false, false], ['OTHER', '기타', true, false]];

  function create(opts) {
    opts = opts || {};
    var failNextStage = null;
    function LS() { return opts.storage || global.localStorage; }
    function S() { return opts.session || global.EbrUserSession || null; }
    function SS() { return opts.signStatus || global.EbrSignStatus || null; }
    function readRaw(k) { try { return LS().getItem(k); } catch (e) { return null; } }
    function readObj(k) { var r = readRaw(k); if (r == null) return null; try { return JSON.parse(r); } catch (e) { return undefined; } }
    function items(k) { var o = readObj(k); return o && Array.isArray(o.items) ? o.items : []; }
    function write(k, o, stage) { if (stage && failNextStage === stage) { failNextStage = null; throw new Error('저장 실패 주입 (' + stage + ')'); } LS().setItem(k, JSON.stringify(o)); }
    function nowIso() { var s = S(); return s && s.nowIsoLocal ? s.nowIsoLocal() : new Date().toISOString(); }
    function ymd(at) { return str(at).slice(0, 10).replace(/-/g, ''); }
    function sealOf(c) { var s = S(), b = clone(c); delete b.recordHash; return s.sha256Hex(s.stableStringify(b)); }
    function seal(c) { c.recordHash = sealOf(c); return c; }
    function released(batchId) { var ss = SS(); return !!(ss && ss.releaseState && ss.releaseState(batchId)); }
    function curUser() { var s = S(); return s && s.getCurrentUser ? s.getCurrentUser() : null; }
    function rolesOf(uid) { var s = S(); return s && s.rolesOf ? s.rolesOf(uid) || [] : []; }
    function ruleRoles(id) { var r = S().getSignRule(id); return r && r.effective && Array.isArray(r.allowedRoles) ? r.allowedRoles : []; }
    function canRule(uid, id) { var rr = ruleRoles(id); return rolesOf(uid).some(function (x) { return rr.indexOf(x) >= 0; }); }
    function audit(entries) { S().Audit.appendMany(entries); }

    /** 사유 코드 (GCM EBR_CORR_REASON) */
    function reasonCodes() {
      var m = readObj(KEYS.MASTER);
      if (m === undefined) return fail('reason_code_unavailable');
      var rows = null;
      if (m && m.gcmData && Array.isArray(m.gcmData[REASON_TABLE])) rows = m.gcmData[REASON_TABLE];
      else if (m && m.gcmData && m.gcmData[REASON_TABLE] != null) return fail('reason_code_unavailable');
      if (!rows) return { ok: true, source: 'builtin', items: BUILTIN_REASONS.map(function (r) { return { code: r[0], text: r[1], freeRequired: r[2], evidenceRequired: r[3], active: true }; }) };
      return { ok: true, source: 'gcm', items: rows.slice().sort(function (a, b) { return (a.seqNo || 0) - (b.seqNo || 0); })
        .map(function (r) { return { code: str(r.key1), text: str(r.keyDesc), freeRequired: yes(r.data1), evidenceRequired: yes(r.data2), active: !r.disableFlag }; }) };
    }
    /* 사유 검증 → null(통과) | fail */
    function checkReason(code, reason, evidence) {
      code = str(code); if (!code) return fail('reason_code_required');
      var rc = reasonCodes(); if (!rc.ok) return rc;
      var row = rc.items.filter(function (x) { return x.code === code && x.active; })[0];
      if (!row) return fail('bad_reason_code');
      if (len(reason) > REASON_MAX) return fail('reason_too_long');
      if (row.freeRequired && !len(reason)) return fail('reason_required_other');
      if (row.evidenceRequired && !(evidence || []).filter(function (e) { return str(e); }).length) return fail('evidence_required');
      return { ok: true, row: row };
    }

    /* ---- 실행 값 원천: 슬롯 기록(마지막) → 서명 */
    function slotRec(batchId, scope, stepKey, slot) {
      var r = null; items(KEYS.EXEC).forEach(function (x) { if (x && x.batchId === batchId && x.scope === scope && x.stepKey === stepKey && x.slot === slot) r = x; }); return r;
    }
    function sigInfo(rec, slot) {
      if (!rec) return null;
      var s = S(), g = s.ESign.get(rec.signatureId), v = g ? s.ESign.validity(g).state : 'missing';
      return { signatureId: rec.signatureId, slot: slot, signerId: g ? g.signerId : null, validity: v, valueHash: g ? g.valueHash || null : null, signedAt: g ? g.signedAt : null };
    }
    function stepSigs(batchId, scope, stepKey) {
      var verSlot = scope === 'pack' ? ['verify', 'qa'] : ['verify'];
      var out = [sigInfo(slotRec(batchId, scope, stepKey, 'perform'), 'perform')];
      verSlot.forEach(function (sl) { out.push(sigInfo(slotRec(batchId, scope, stepKey, sl), sl)); });
      return out.filter(Boolean);
    }
    function SAFE(f) { try { return f(); } catch (e) { return null; } }
    function valOf(x) { return x != null && typeof x === 'object' && 'value' in x ? x.value : x; }
    function withVal(x, v) { if (x != null && typeof x === 'object' && 'value' in x) { var c = clone(x); c.value = v; return c; } return v; }
    function targetKey(t) { return t.kind === 'exec_value' ? ['exec', t.scope, t.stepKey, t.valueIndex].join('|') : ['weigh', t.recId, t.field].join('|'); }
    /* 단계 표시 이름: 생산 = stepKey(OP3-2 가 표시 코드), 포장 = 단계 이름(내부 키 mat 등은 표시하지 않음). stepName 없는 옛 기록은 단계 정의에서 찾고, 못 찾으면 stepKey */
    function stepNameOf(scope, stepKey, batchId) {
      var ss = SS(); if (!ss) return '';
      var st = SAFE(function () { return ss.stepsFor(scope, batchId || '').filter(function (x) { return x.stepKey === stepKey; })[0]; });
      return st ? str(st.name) : '';
    }
    function stepDisp(scope, stepKey, stepName, batchId) {
      if (scope !== 'pack') return str(stepKey);
      return str(stepName) || stepNameOf(scope, str(stepKey), batchId) || str(stepKey);
    }
    /* 구분 접두(생산 · 포장): 단계 이름이 이미 그 말로 시작하면(포장 자재 확인) 겹쳐 붙이지 않음 */
    function withScope(scope, disp, noScope) { var sl = SCOPE_LABEL[scope] || scope; return noScope || disp.indexOf(sl + ' ') === 0 ? disp : sl + ' ' + disp; }
    function targetLabel(t, batchId, noScope) {   /* noScope = 서명 문장용(구분 접두 없이) */
      if (t.kind === 'exec_value') { var dn = str(t.valueLabel) || (INTERNAL_KEY_RE.test(str(t.valueKey)) ? '' : str(t.valueKey)); return withScope(t.scope, stepDisp(t.scope, t.stepKey, t.stepName, batchId), noScope) + ' 값 #' + (Number(t.valueIndex) + 1) + (dn ? ' ' + dn : ''); }
      return '칭량 ' + str(t.recId) + ' ' + str(t.field);
    }
    function isOpen(c) { return c.state === 'DRAFT' || c.state === 'PERFORMED'; }

    /** 정정 가능 대상 (실행 단계 단위 — 값 배열은 화면이 가지므로 current = 값 건수 · 정정된 인덱스) */
    function targetsFor(batchId, o) {
      o = o || {}; batchId = str(batchId); if (!batchId) return fail('no_batch');
      var ss = SS(); if (!ss) return fail('no_session');
      if (o.kind && o.kind !== 'exec_value') return { ok: true, items: [] };   /* 칭량 기록 대상은 P1 */
      var rel = released(batchId), list = [];
      ['prod', 'pack'].forEach(function (scope) {
        ss.stepsFor(scope, batchId).forEach(function (st) {
          var sigs = stepSigs(batchId, scope, st.stepKey); if (!sigs.length) return;
          var perf = sigs.filter(function (x) { return x.slot === 'perform'; })[0];
          var why = rel ? 'already_released' : !perf ? 'orig_unsigned' : sigs.some(function (x) { return x.validity !== 'valid'; }) ? 'orig_sig_invalid' : null;
          var rec = slotRec(batchId, scope, st.stepKey, 'perform');
          var vals = rec && Array.isArray(rec.values) ? rec.values : null;
          var eff = effectiveValues(batchId, scope, st.stepKey, vals || undefined);
          var sigOut = sigs.map(function (x) { return { signatureId: x.signatureId, slot: x.slot, signerId: x.signerId, validity: x.validity }; });
          var stepLabel = scope === 'pack' ? withScope(scope, str(st.name)) : (SCOPE_LABEL[scope]) + ' ' + st.stepKey + ' ' + st.name;
          var stepName = scope === 'pack' ? str(st.name) : undefined;
          if (o.scope && o.scope !== scope) return; if (o.stepKey && str(o.stepKey) !== st.stepKey) return;
          if (!vals || !vals.length) {   /* 값 사본 없는 옛 기록 · 값 없는 단계: 단계 단위 1행 (값 선택 불가) */
            list.push({ target: { kind: 'exec_value', scope: scope, stepKey: st.stepKey, stepName: stepName }, label: stepLabel, stepLabel: stepLabel,
                        current: { valueCount: rec ? rec.valueCount || 0 : 0, recordedAt: perf ? perf.signedAt : '', valuesHash: perf ? perf.valueHash : '' }, critical: true,
                        signatures: sigOut, correctable: false, why: why || 'values_unavailable' });
            return;
          }
          var origOk = !!perf && SAFE(function () { return S().computeValueHash({ batchId: batchId, scope: scope, stepKey: st.stepKey, values: vals }); }) === perf.valueHash;
          vals.forEach(function (x, i) {
            var key = x != null && typeof x === 'object' ? str(x.key || x.name || x.label) : '';
            /* 표시 이름 = 항목 정의의 label · name (내부 키는 target.valueKey 에만). 키가 내부 해시 꼴(h + 숫자/16진)이면 표시하지 않음 */
            var disp = x != null && typeof x === 'object' ? str(x.label || x.name || (INTERNAL_KEY_RE.test(str(x.key)) ? '' : x.key)) : '';
            var e = eff.values[i] || {};
            var w = why || (!origOk ? 'orig_hash_mismatch' : null);
            list.push({ target: { kind: 'exec_value', scope: scope, stepKey: st.stepKey, stepName: stepName, valueIndex: i, valueKey: key, valueLabel: disp },
                        label: stepLabel + ' 값 #' + (i + 1) + (disp ? ' ' + disp : ''), valueLabel: disp, stepLabel: stepLabel,
                        current: { value: str(e.value), uom: x != null && typeof x === 'object' ? str(x.uom) : '', recordedAt: perf ? perf.signedAt : '', valuesHash: perf ? perf.valueHash : '',
                                   source: e.source || 'original', correctionId: e.correctionId },
                        spec: x != null && typeof x === 'object' ? (x.spec != null ? x.spec : undefined) : undefined,
                        critical: true, signatures: sigOut, values: clone(vals), origHashOk: origOk, correctable: !w, why: w || undefined });
          });
        });
      });
      return { ok: true, items: list };
    }

    /* 열기 · 편집 공통 검증 → { ok, target, before, after, origIds, origPerformerId } */
    function validateOpen(req) {
      var B = str(req.batchId); if (!B) return fail('no_batch');
      var t = req.target || {};
      if (TARGET_KINDS.indexOf(t.kind) < 0) return fail('no_target');
      if (t.kind === 'weigh_record') return WEIGH_FIELDS.indexOf(str(t.field)) < 0 ? fail('weigh_field_locked') : fail('weigh_p1');
      if ((t.scope !== 'prod' && t.scope !== 'pack') || !str(t.stepKey) || !(Number(t.valueIndex) >= 0) || Math.floor(Number(t.valueIndex)) !== Number(t.valueIndex)) return fail('no_target');
      if (released(B)) return fail('already_released');
      var sigs = stepSigs(B, t.scope, str(t.stepKey)), perf = sigs.filter(function (x) { return x.slot === 'perform'; })[0];
      if (!perf) return fail('orig_unsigned');
      var badSig = sigs.filter(function (x) { return x.validity !== 'valid'; })[0];
      if (badSig) return fail('orig_sig_invalid', { signatureId: badSig.signatureId, validity: badSig.validity });
      var values = Array.isArray(req.values) ? req.values : null;
      if (!values) { var pr = slotRec(B, t.scope, str(t.stepKey), 'perform'); values = pr && Array.isArray(pr.values) ? pr.values : null; }   /* 화면이 값을 못 넘기면 실행 기록 사본 */
      if (!values) return fail('orig_hash_mismatch');
      var s = S(), h = s.computeValueHash({ batchId: B, scope: t.scope, stepKey: str(t.stepKey), values: values });
      if (h !== perf.valueHash) return fail('orig_hash_mismatch', { expected: perf.valueHash, actual: h });
      var i = Number(t.valueIndex); if (i >= values.length) return fail('bad_value');
      var a = req.after || {}, av = str(a.value), bv = valOf(values[i]);
      if (!av || av === str(bv)) return fail('bad_value');
      var after = values.map(function (x, k) { return k === i ? withVal(x, av) : x; });
      var target = { kind: 'exec_value', scope: t.scope, stepKey: str(t.stepKey), valueIndex: i, valueKey: str(t.valueKey) || (values[i] && values[i].key) || '' };
      var vi = values[i] && typeof values[i] === 'object' ? values[i] : {}; target.valueLabel = str(vi.label || vi.name) || (INTERNAL_KEY_RE.test(str(target.valueKey)) ? '' : target.valueKey);   /* 표시 이름 (값 사본에서) */
      if (t.scope === 'pack') {   /* 포장 단계 표시 이름 = 단계 정의에서만 (호출자 stepName 무시 · 못 찾으면 fail-closed) */
        var sn = stepNameOf('pack', target.stepKey, B); if (!sn) return fail('step_unknown', { stepKey: target.stepKey });
        target.stepName = sn;
      }
      return { ok: true, B: B, target: target, sigs: sigs, perf: perf,
               before: { value: str(bv), uom: str(t.uom || (values[i] && values[i].uom)), recordedAt: perf.signedAt, valuesHash: h },
               after: { value: av, uom: str(a.uom || t.uom || (values[i] && values[i].uom)), judge: str(a.judge), valuesHash: s.computeValueHash({ batchId: B, scope: t.scope, stepKey: str(t.stepKey), values: after }) } };
    }

    function openCorrection(req) {
      req = req || {};
      var s = S(); if (!s) return fail('no_session');
      var u = curUser(); if (!u) return fail('no_current_user');
      if (!canRule(u.userId, RULES.PERFORM)) return fail('role_restricted');
      var v = validateOpen(req); if (!v.ok) return v;
      var tk = targetKey(v.target);
      var dup = items(KEYS.CORR).filter(function (c) { return c && c.batchId === v.B && isOpen(c) && targetKey(c.target) === tk; })[0];
      if (dup) return fail('correction_open', { correctionId: dup.correctionId });
      var evidence = (req.evidence || []).map(str).filter(Boolean);
      var rc = checkReason(req.reasonCode, req.reason, evidence); if (!rc.ok) return rc;
      var raw = readRaw(KEYS.CORR), o = readObj(KEYS.CORR); if (o === undefined) return fail('save_error');
      var list = o && Array.isArray(o.items) ? o.items.slice() : [], at = nowIso();
      var pre = 'COR-' + ymd(at) + '-', seq = list.filter(function (c) { return str(c.correctionId).indexOf(pre) === 0; }).length + 1;
      var id = pre + ('000' + seq).slice(-4);
      while (list.some(function (c) { return c.correctionId === id; })) { seq++; id = pre + ('000' + seq).slice(-4); }
      var c = seal({ correctionId: id, batchId: v.B, target: v.target, critical: req.critical !== false, before: v.before, after: v.after,
                     reasonCode: rc.row.code, reasonCodeText: rc.row.text, reason: str(req.reason), evidence: evidence,
                     origSignatureIds: v.sigs.map(function (x) { return x.signatureId; }), origPerformerId: v.perf.signerId,
                     state: 'DRAFT', requesterId: u.userId, createdAt: at, performed: null, verified: null, rejected: null, voidIds: [], rbeExceptionId: null,
                     history: [{ at: at, from: null, to: 'DRAFT', by: u.userId, act: 'COR_DRAFT' }] });
      list.push(c);
      try {
        write(KEYS.CORR, { version: 1, items: list }, 'corr');
        audit([{ act: 'COR_DRAFT', tgt: id, val: targetLabel(v.target, v.B) + ' · ' + v.before.value + ' → ' + v.after.value + (v.after.uom ? ' ' + v.after.uom : ''), why: rc.row.code,
                 before: null, after: { state: 'DRAFT' }, batchId: v.B, recordType: 'correction', screen: req.screen,
                 detail: u.userId !== v.perf.signerId ? { notOriginalPerformer: true } : undefined }]);
      } catch (e) { restore(KEYS.CORR, raw); return fail('save_error'); }
      return { ok: true, correction: clone(c) };
    }
    function restore(k, raw) { try { if (raw == null) LS().removeItem(k); else LS().setItem(k, raw); } catch (e) { /* 무시 */ } }
    function findC(id) { return items(KEYS.CORR).filter(function (c) { return c && c.correctionId === str(id); })[0] || null; }
    /* 한 정정 바꾸기 (원자: 정정 저장 + 감사, 실패 시 복원) */
    function mutate(id, fn, auditFn) {
      var raw = readRaw(KEYS.CORR), o = readObj(KEYS.CORR); if (!o || !Array.isArray(o.items)) return fail('not_found');
      var list = o.items.slice(), k = -1; list.forEach(function (c, i) { if (c && c.correctionId === str(id)) k = i; });
      if (k < 0) return fail('not_found');
      if (sealOf(list[k]) !== list[k].recordHash) return fail('record_tampered');
      var c = clone(list[k]), r = fn(c); if (r && !r.ok) return r;
      seal(c); list[k] = c;
      try { write(KEYS.CORR, { version: 1, items: list }, 'corr'); audit(auditFn(c)); } catch (e) { restore(KEYS.CORR, raw); return fail('save_error'); }
      return { ok: true, correction: clone(c) };
    }
    function ownerOk(c, u) { return c.requesterId === u.userId || rolesOf(u.userId).indexOf('SV') >= 0; }

    function updateDraft(correctionId, patch) {
      patch = patch || {};
      var u = curUser(); if (!u) return fail('no_current_user');
      var c0 = findC(correctionId); if (!c0) return fail('not_found');
      if (c0.state !== 'DRAFT') return fail('not_draft');
      if (!ownerOk(c0, u)) return fail('not_owner');
      var code = patch.reasonCode != null ? patch.reasonCode : c0.reasonCode, reason = patch.reason != null ? patch.reason : c0.reason;
      var ev = patch.evidence != null ? (patch.evidence || []).map(str).filter(Boolean) : c0.evidence;
      var rc = checkReason(code, reason, ev); if (!rc.ok) return rc;
      var nv = null;
      if (patch.after != null) {
        if (!Array.isArray(patch.values)) return fail('orig_hash_mismatch');
        nv = validateOpen({ batchId: c0.batchId, target: c0.target, values: patch.values, after: patch.after }); if (!nv.ok) return nv;
      }
      var before = { reasonCode: c0.reasonCode, reason: c0.reason, after: c0.after.value };
      return mutate(correctionId, function (c) {
        c.reasonCode = rc.row.code; c.reasonCodeText = rc.row.text; c.reason = str(reason); c.evidence = ev;
        if (nv) c.after = nv.after;
        c.history.push({ at: nowIso(), from: 'DRAFT', to: 'DRAFT', by: u.userId, act: 'COR_DRAFT_UPDATE' });
      }, function (c) { return [{ act: 'COR_DRAFT_UPDATE', tgt: c.correctionId, val: targetLabel(c.target, c.batchId) + ' · ' + c.before.value + ' → ' + c.after.value, why: c.reasonCode, before: before, after: { reasonCode: c.reasonCode, reason: c.reason, after: c.after.value }, batchId: c.batchId, recordType: 'correction', screen: patch.screen }]; });
    }
    function cancelCorrection(correctionId, o) {
      o = o || {};
      var u = curUser(); if (!u) return fail('no_current_user');
      var c0 = findC(correctionId); if (!c0) return fail('not_found');
      if (c0.state !== 'DRAFT') return fail('not_draft');
      if (!ownerOk(c0, u)) return fail('not_owner');
      if (len(o.reason) > REASON_MAX) return fail('reason_too_long');
      return mutate(correctionId, function (c) { c.state = 'CANCELLED'; c.history.push({ at: nowIso(), from: 'DRAFT', to: 'CANCELLED', by: u.userId, act: 'COR_CANCELLED' }); },
        function (c) { return [{ act: 'COR_CANCELLED', tgt: c.correctionId, val: targetLabel(c.target, c.batchId) + (str(o.reason) ? ' · ' + str(o.reason) : ''), why: str(o.reason), before: { state: 'DRAFT' }, after: { state: 'CANCELLED' }, batchId: c.batchId, recordType: 'correction', screen: o.screen }]; });
    }

    /* 원 서명이 모두 아직 유효한지 */
    function origValid(c) { var s = S(); return c.origSignatureIds.every(function (id) { var g = s.ESign.get(id); return g && s.ESign.validity(g).state === 'valid'; }); }
    /* 서명 문장 대상 이름: 수행 서명 때 c.performed.targetLabel 로 고정 → 확인 서명은 그 값을 씀 (단계 정의가 바뀌어도 수행 · 확인 문장 대상 같음). 고정 전(옛 기록)은 현재 계산 */
    function stmtCtx(c) {
      return { batchId: c.batchId, targetLabel: (c.performed && c.performed.targetLabel) || targetLabel(c.target, c.batchId, true), before: c.before.value, after: c.after.value, uom: c.after.uom || c.before.uom,
               reasonCode: c.reasonCodeText || c.reasonCode, reason: c.reason };   /* 문장 사유 = 표시 이름 */
    }
    var tickets = {};
    function beginSign(kind, correctionId, o) {
      o = o || {};
      var s = S(); if (!s) return fail('no_session');
      var c = findC(correctionId); if (!c) return fail('not_found');
      if (sealOf(c) !== c.recordHash) return fail('record_tampered');
      if (kind === 'perform' && c.state !== 'DRAFT') return fail('not_draft');
      if (kind === 'verify' && c.state !== 'PERFORMED') return fail('not_performed');
      if (released(c.batchId)) return fail('already_released');
      if (!origValid(c)) return fail('orig_sig_invalid');
      var u = curUser();
      if (kind === 'perform' && u && !canRule(u.userId, RULES.PERFORM)) return fail('role_restricted');
      var ruleId = kind === 'perform' ? RULES.PERFORM : RULES.VERIFY, h0 = c.recordHash, id = c.correctionId;
      var ctx = stmtCtx(c);
      if (kind === 'perform' && c.target && c.target.kind === 'exec_value' && c.target.scope === 'pack' && !str(c.target.stepName) && !stepNameOf('pack', str(c.target.stepKey), c.batchId)) return fail('step_unknown', { stepKey: c.target.stepKey });
      var perfLabel = kind === 'perform' ? ctx.targetLabel : null, perfStep = kind === 'perform' && c.target && c.target.scope === 'pack' ? (str(c.target.stepName) || stepNameOf('pack', str(c.target.stepKey), c.batchId)) : null;
      if (kind === 'verify') { ctx.performerName = (c.performed.userName || '') + '(' + c.performed.userId + ')'; ctx.voidN = c.origSignatureIds.length; }
      var tk = targetKey(c.target);
      var spec = {
        signRuleId: ruleId, recordType: 'correction', tgt: id, val: targetLabel(c.target, c.batchId) + ' · ' + c.before.value + ' → ' + c.after.value, screen: o.screen,
        statementKind: kind === 'perform' ? 'correction_perform' : 'correction_verify', statementCtx: ctx, openAct: 'COR_SIGN_OPEN',
        qualTargets: [], keys: [KEYS.CORR].concat(kind === 'verify' ? [KEYS.RBE] : []),
        fields: { correctionId: id, batchId: c.batchId, targetKey: tk, beforeHash: c.before.valuesHash, afterHash: c.after.valuesHash, statementKind: kind === 'perform' ? 'correction_perform' : 'correction_verify' },
        distinctFrom: kind === 'verify' ? [{ userId: c.performed.userId, label: '정정 수행자' }] : undefined,
        precheck: function () {
          var n = findC(id);
          if (!n || n.recordHash !== h0 || sealOf(n) !== n.recordHash) return { detail: 'correction_changed', message: MSG.precheck_changed };
          if (released(n.batchId)) return { detail: 'released', message: MSG.already_released };
          if (!origValid(n)) return { detail: 'orig_sig_invalid', message: MSG.orig_sig_invalid };
          return null;
        },
        apply: function (sig, actx) { return kind === 'perform' ? applyPerform(id, sig, actx, perfLabel, perfStep) : applyVerify(id, sig, actx); }
      };
      var r = s.beginRecordSign(spec);
      if (!r || !r.ok) return r;
      tickets[r.ticket] = { kind: kind, correctionId: id };
      r.target = Object.assign({}, r.target, { statementKind: spec.statementKind, before: clone(c.before), after: clone(c.after), correctionId: id,
        voidPreview: kind === 'verify' ? c.origSignatureIds.slice() : undefined, rbePreview: kind === 'verify' ? rbeIdOf(id) : undefined, rbePreviewId: kind === 'verify' ? rbeIdOf(id) : undefined,
        performer: kind === 'verify' ? { userId: c.performed.userId, name: c.performed.userName || '' } : undefined,
        uom: c.after.uom || c.before.uom, beforeHash: c.before.valuesHash, afterHash: c.after.valuesHash });
      return r;
    }
    function rbeIdOf(id) { return 'RBE-' + id; }
    function saveCorr(id, fn) {
      var o = readObj(KEYS.CORR), list = o.items.slice(), k = -1; list.forEach(function (c, i) { if (c.correctionId === id) k = i; });
      var c = clone(list[k]); fn(c); seal(c); list[k] = c; write(KEYS.CORR, { version: 1, items: list }, 'corr'); return c;
    }
    function applyPerform(id, sig, actx, perfLabel, perfStep) {
      var c = saveCorr(id, function (c) {
        c.state = 'PERFORMED'; c.performed = { signatureId: sig.signatureId, userId: sig.signerId, userName: sig.signerName, at: actx.at, targetLabel: perfLabel || undefined, stepName: perfStep || undefined };   /* 수행 시점 대상 · 단계 이름 고정 (봉인 대상) */
        c.history.push({ at: actx.at, from: 'DRAFT', to: 'PERFORMED', by: sig.signerId, act: 'COR_PERFORMED' });
      });
      return { result: { correction: clone(c) }, audits: [{ act: 'COR_PERFORMED', tgt: id, val: sig.signatureId, before: { state: 'DRAFT' }, after: { state: 'PERFORMED' }, batchId: c.batchId, signRuleId: RULES.PERFORM, recordType: 'correction',
        detail: sig.signerId !== c.origPerformerId ? { notOriginalPerformer: true } : undefined }] };
    }
    function applyVerify(id, sig, actx) {
      if (typeof actx.appendVoidRecords !== 'function') throw new Error('no_void_path');
      var c0 = findC(id);
      var vr = actx.appendVoidRecords(c0.origSignatureIds.map(function (sid) { return { signatureId: sid, reason: id + ' 정정 (' + c0.reasonCode + ')' }; }), { correctionId: id });
      if (failNextStage === 'void') { failNextStage = null; throw new Error('저장 실패 주입 (void)'); }
      var rbeId = rbeIdOf(id), t = c0.target;
      var rbe = { id: rbeId, batchId: c0.batchId, cat: 'MANUAL_BY_DESIGN + 정정', step: t.stepKey, item: (str(t.valueLabel) || (INTERNAL_KEY_RE.test(str(t.valueKey)) ? '' : str(t.valueKey)) || ('값 #' + (t.valueIndex + 1))),
                  value: c0.before.value + ' → ' + c0.after.value + (c0.after.uom ? ' ' + c0.after.uom : ''), src: 'CORRECTION', open: true, status: '미결', critical: !!c0.critical,
                  correctorId: c0.performed.userId, verifierId: sig.signerId, correctionId: id, createdAt: actx.at };
      var ro = readObj(KEYS.RBE), rl = ro && Array.isArray(ro.items) ? ro.items.slice() : [];
      rl.push(rbe); write(KEYS.RBE, { v: 1, items: rl }, 'rbe');
      var c = saveCorr(id, function (c) {
        c.state = 'VERIFIED'; c.verified = { signatureId: sig.signatureId, userId: sig.signerId, userName: sig.signerName, at: actx.at };
        c.voidIds = vr.voidIds.slice(); c.rbeExceptionId = rbeId;
        c.history.push({ at: actx.at, from: 'PERFORMED', to: 'VERIFIED', by: sig.signerId, act: 'COR_VERIFIED' });
      });
      return { result: { correction: clone(c), voidIds: vr.voidIds.slice(), rbeExceptionId: rbeId },
               audits: vr.audits.map(function (a) { a.val = a.val + ' · ' + id + ' 정정'; return a; }).concat([
                 { act: 'COR_VERIFIED', tgt: id, val: 'void ' + vr.voidIds.length + ' · ' + rbeId, before: { state: 'PERFORMED' }, after: { state: 'VERIFIED', voidIds: vr.voidIds.slice() }, batchId: c.batchId, signRuleId: RULES.VERIFY, recordType: 'correction' },
                 { act: 'RBE_EXCEPTION_CREATED', tgt: rbeId, val: rbe.value + ' · ' + id, after: clone(rbe), batchId: c.batchId, recordType: 'correction' }]) };
    }
    function beginPerformSign(correctionId, o) { return beginSign('perform', correctionId, o); }
    function beginVerifySign(correctionId, o) { return beginSign('verify', correctionId, o); }
    function signAndCommit(ticket, input) {
      var s = S(); if (!s) return fail('no_session');
      var r = s.signAndCommitRecord(ticket, input || {});
      if (r && r.ok) {
        delete tickets[ticket];
        var res = r.result || {};
        var out = { ok: true, signatureId: r.signature.signatureId, signature: r.signature, correction: res.correction };
        if (res.voidIds) { out.voidIds = res.voidIds; out.rbeExceptionId = res.rbeExceptionId; }
        if (r.qualWarn) out.qualWarn = r.qualWarn;
        return out;
      }
      if (r && r.closeDialog) delete tickets[ticket];
      return r;
    }
    function cancel(ticket, o) { var s = S(); if (!s) return fail('no_session'); delete tickets[ticket]; return s.cancelRecordSign(ticket, o || {}); }

    function rejectCorrection(correctionId, o) {
      o = o || {};
      var u = curUser(); if (!u) return fail('no_current_user');
      if (rolesOf(u.userId).indexOf('QA') < 0) return fail('not_qa');
      var c0 = findC(correctionId); if (!c0) return fail('not_found');
      if (c0.state !== 'PERFORMED') return fail('not_performed');
      var reason = str(o.reason); if (!reason || len(reason) > REASON_MAX) return fail('reason_required');
      return mutate(correctionId, function (c) { var at = nowIso(); c.state = 'REJECTED'; c.rejected = { userId: u.userId, at: at, reason: reason }; c.history.push({ at: at, from: 'PERFORMED', to: 'REJECTED', by: u.userId, act: 'COR_REJECTED' }); },
        function (c) { return [{ act: 'COR_REJECTED', tgt: c.correctionId, val: reason, why: reason, before: { state: 'PERFORMED' }, after: { state: 'REJECTED' }, batchId: c.batchId, recordType: 'correction', screen: o.screen }]; });
    }

    function dayBound(v, end) { if (!v) return null; var s = String(v); if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += end ? 'T23:59:59.999+09:00' : 'T00:00:00+09:00'; var t = Date.parse(s); return isNaN(t) ? null : t; }
    function listCorrections(f) {
      f = f || {};
      var from = dayBound(f.from, false), to = dayBound(f.to, true);
      var rows = items(KEYS.CORR).filter(function (c) {
        if (!c) return false;
        if (f.batchId && c.batchId !== str(f.batchId)) return false;
        if (f.kind && c.target.kind !== f.kind) return false;
        if (f.state && (Array.isArray(f.state) ? f.state.indexOf(c.state) < 0 : c.state !== f.state)) return false;
        if (f.requesterId && c.requesterId !== str(f.requesterId)) return false;
        var t = Date.parse(c.createdAt); if (from != null && t < from) return false; if (to != null && t > to) return false;
        return true;
      }).sort(function (a, b) { return Date.parse(b.createdAt) - Date.parse(a.createdAt) || (b.correctionId > a.correctionId ? 1 : -1); })
        .map(function (c) { var r = clone(c); r.targetLabel = targetLabel(c.target, c.batchId); r.integrity = sealOf(c) === c.recordHash ? 'ok' : 'mismatch'; return r; });
      return { ok: true, total: rows.length, rows: rows };
    }
    function getCorrection(id) {
      var c = findC(id); if (!c) return fail('not_found');
      var s = S();
      var voids = (c.voidIds || []).map(function (vid, i) {
        var sid = c.origSignatureIds[i], vr = s.ESign.voidOf(sid), g = s.ESign.get(sid);
        return { voidId: vid, signatureId: sid, state: vr && vr.voidId === vid && vr.correctionId === c.correctionId ? (g ? s.ESign.validity(g).state : 'missing') : 'mismatch' };
      });
      var out = clone(c); out.targetLabel = targetLabel(c.target, c.batchId);
      return { ok: true, correction: out, integrity: { recordHash: sealOf(c) === c.recordHash ? 'ok' : 'mismatch', voids: voids } };
    }
    function effectiveValues(batchId, scope, stepKey, values) {
      var last = {};
      items(KEYS.CORR).filter(function (c) { return c && c.state === 'VERIFIED' && c.batchId === str(batchId) && c.target.kind === 'exec_value' && c.target.scope === scope && c.target.stepKey === str(stepKey); })
        .sort(function (a, b) { return Date.parse(a.verified.at) - Date.parse(b.verified.at); })
        .forEach(function (c) { last[c.target.valueIndex] = c; });
      if (Array.isArray(values)) return { ok: true, values: values.map(function (x, i) { var c = last[i]; return c ? { index: i, value: c.after.value, source: 'correction', correctionId: c.correctionId, original: valOf(x) } : { index: i, value: valOf(x), source: 'original' }; }) };
      return { ok: true, values: Object.keys(last).map(Number).sort(function (a, b) { return a - b; }).map(function (i) { return { index: i, value: last[i].after.value, source: 'correction', correctionId: last[i].correctionId, original: last[i].before.value }; }) };
    }
    /* openCount(batchId[, {scope, stepKey}]) → {draft, performed} · 단계 필터 선택 */
    function openCount(batchId, f) {
      var n = { draft: 0, performed: 0 }; f = f || {};
      items(KEYS.CORR).forEach(function (c) { if (c && c.batchId === str(batchId) && (!f.scope || (c.target && c.target.scope === f.scope)) && (!f.stepKey || (c.target && c.target.stepKey === str(f.stepKey)))) { if (c.state === 'DRAFT') n.draft++; if (c.state === 'PERFORMED') n.performed++; } });
      return n;
    }

    return {
      VERSION: 1, KEYS: clone(KEYS), RULES: clone(RULES), STATES: STATES.slice(), REASON_TABLE: REASON_TABLE, REASON_MAX: REASON_MAX, MSG: clone(MSG),
      reasonCodes: reasonCodes, targetsFor: targetsFor, openCorrection: openCorrection, updateDraft: updateDraft, cancelCorrection: cancelCorrection,
      beginPerformSign: beginPerformSign, beginVerifySign: beginVerifySign, signAndCommit: signAndCommit, cancel: cancel, rejectCorrection: rejectCorrection,
      listCorrections: listCorrections, getCorrection: getCorrection, effectiveValues: effectiveValues, openCount: openCount, targetLabel: targetLabel,
      create: create,
      _test: { failNext: function (stage) { /* 'corr' | 'rbe' | 'void' */ failNextStage = stage || null; return failNextStage; } }
    };
  }

  var API = create({});
  global.EbrCorrection = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
