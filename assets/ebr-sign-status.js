/* =====================================================================
   ebr-sign-status.js — 실행 · 검토 · 출하 서명 상태 읽기 API (전역 EbrSignStatus)
   - 설계: poc-exec-release-esign-design.md 개정 1.1 §3.1 · §3.2 · §3.3 (D1-08 · D1-09), UI 항목 UI-13
   - 원천 = ebr.esign.v1 (서명 레코드 — status 'valid' 이고 signatureHash 검증 통과만 유효) × ebr.execRecord.v1 (슬롯 → signatureId) × ebr.release.v1
     보조: EbrDispense(칭량 줄) · MatQC(ebr.materialLot.v1 judgeSignatureId) · Dev(ebr.deviation.v1) · ebr.batch.issued.v1(발행 스냅샷 OP · 예약 LOT)
   - 부작용 없음: 이 파일의 어떤 함수도 setItem 을 부르지 않는다. 화면은 이 결과만 읽는다.
   - 정의(단계 · 슬롯 · 데모 RBE 예외)도 여기 둔다 — EbrExecSign(쓰기)이 같은 정의를 읽는다.
   - EbrSignStatus.create({ session?, matqc?, dev?, dispense?, weigh?, snapshot?, exceptions? }) 로 노드 시험 주입. 모듈은 호출 시점에 찾는다(로드 순서 무관).
   ===================================================================== */
(function (global) {
  'use strict';

  var KEYS = { ESIGN: 'ebr.esign.v1', EXEC: 'ebr.execRecord.v1', RELEASE: 'ebr.release.v1', MAT: 'ebr.materialLot.v1', DEV: 'ebr.deviation.v1', ISSUED: 'ebr.batch.issued.v1', AUDIT: 'ebr.audit.v1' };
  var GATE_NOS = [1, 3, 4, 8, 9];
  var SIGN_STATES = ['signed', 'pending', 'invalid', 'na'];
  var R = { PERF: 'SM-PERF-STEP', VERI: 'SM-VERI-STEP', PKLAB: 'SM-VERI-PKLAB', PACKREV: 'SM-REV-PACK', MATQC: 'SM-APPR-MATQC', RBE: 'SM-REV-RBE', BATCH: 'SM-REV-BATCH', AUDIT: 'SM-REV-AUDIT', REL: 'SM-APPR-REL' };

  /* 생산 데모 OP (발행 스냅샷 phaseList 가 없을 때 — 생산 실행 화면 데모 템플릿과 같은 순서). 칭량 OP(OP1-1) · 포장 이관(OP4-1)은 OP 서명 없음 */
  var PROD_FALLBACK = [['OP1-2', '키트 봉인 · 투입'], ['OP2-1', '습식 혼합'], ['OP2-2', '조립 · 정립'], ['OP3-1', '타정 준비'], ['OP3-2', '타정 · IPC']];
  /* 포장 단계 · 슬롯 (포장 실행 화면 STEPS 를 store 로 이동, D1-05). roles = 규칙 허용 역할 안에서 슬롯이 더 좁히는 역할 */
  function slot(s, rule, roles, kind, lineQual) { return { slot: s, signRuleId: rule, roles: roles, statementKind: kind, lineQual: !!lineQual }; }
  var PDO = function () { return slot('perform', R.PERF, ['OP', 'SV'], 'pack_step', true); };
  var PCHK = function (roles) { return slot('verify', R.VERI, roles || ['OP', 'SV'], 'pack_step_verify', false); };   /* LINE:PK-L02 는 작업자(수행) 슬롯만 — UI 항목 UI-03 */
  var PACK_STEPS = [
    ['line', '포장 라인 셋업', '설비 상태 · 포맷 부품 · 파라미터', [PDO(), PCHK()]],
    ['clrS', '시작 라인 클리어런스', '이전 제품 · 자재 · 라벨 잔류 확인', [PDO(), PCHK()]],
    ['mat', '포장 자재 확인', '불출 자재 스캔 · 아트워크 버전', [PDO(), PCHK()]],
    ['lab', '라벨 · 코딩 첫 시료', '가변 데이터 대조 · 비전 챌린지', [PDO(), slot('qa', R.PKLAB, ['QA'], 'pack_label_qa', false)]],   /* 라벨 QA 슬롯은 LINE 요구 없음 (X12) */
    ['exe', '포장 실행 · IPC', '카운트 · 공정 중 검사 · 이벤트', [PDO(), PCHK()]],
    ['rec', '수량 정산 · 수율', '정제 수지 · 인쇄 자재 정산', [PDO(), PCHK(['SV'])]],
    ['clrE', '종료 라인 클리어런스', '잔여 자재 회수 · 데이터 삭제 · 이송', [PDO(), PCHK()]],
    ['rev', '포장 기록 검토', '서명 · 감사추적 · 예외 검토', [slot('review', R.PACKREV, ['SV'], 'pack_review', false)]]
  ];
  /* 데모 RBE 예외 (출하 게이트 화면 EXCEPTIONS 와 같은 내용 · 데모 배치 전용 — 동적 수집은 다음 작업). open = 미결(서명 필요) */
  var DEMO_BATCH = 'BR-DEMO-0001';
  var DEMO_RBE = [
    { id: 'RBE-DEMO-01', cat: 'WARNING_ACK', step: 'OP3-2', item: 'IPC #3', value: '103.4 mg / 경고 97~103', src: 'AUTO', open: false, status: '검토 완료', critical: true, correctorId: null, verifierId: null },
    { id: 'RBE-DEMO-02', cat: '규격 이탈(IPC)', step: 'OP3-2', item: 'IPC #5 시도1', value: '106.1 mg / 95~105 (재측정 99.8)', src: 'AUTO', open: true, status: '미결', critical: true, correctorId: 'OP-0101', verifierId: 'SV-0003' },
    { id: 'RBE-DEMO-03', cat: 'MANUAL_BY_DESIGN + 정정', step: 'OP3-2', item: '경도', value: '85 → 83 N / ≥ 60', src: 'MANUAL + 사진', open: false, status: '검토 완료(부분 대체)', critical: true, correctorId: 'OP-0101', verifierId: 'SV-0003' }
  ];

  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function str(v) { return v == null ? '' : String(v).trim(); }
  function readJson(key, fb) { try { var s = global.localStorage.getItem(key); return s ? JSON.parse(s) : fb; } catch (e) { return fb; } }
  function readItems(key) { var o = readJson(key, null); return o && Array.isArray(o.items) ? o.items : (Array.isArray(o) ? o : []); }
  function fail(why, message) { return { ok: false, why: why, message: message }; }

  function create(opts) {
    opts = opts || {};
    function S() { return opts.session || global.EbrUserSession || null; }
    function MQ() { return opts.matqc || (global.EbrP0 && global.EbrP0.MatQC) || global.MatQC || null; }
    function DV() { return opts.dev || (global.EbrP0 && global.EbrP0.Dev) || global.Dev || null; }
    function WG() { return opts.weigh || (global.EbrP0 && global.EbrP0.Weigh) || null; }
    function DS() { var d = opts.dispense || global.EbrDispense || null; return d && typeof d.summary === 'function' ? d : null; }
    function SN() { return opts.snapshot || global.EbrExecSnapshot || null; }

    function issuedOf(batchId) {
      var list = readItems(KEYS.ISSUED); if (!list.length) { var o = readJson(KEYS.ISSUED, null); if (o && Array.isArray(o.batches)) list = o.batches; }
      for (var i = 0; i < list.length; i++) if (str(list[i].batchId || list[i].batchNo || list[i].id) === str(batchId)) return list[i];
      return null;
    }
    function rbeExceptions(batchId) {
      if (typeof opts.exceptions === 'function') return clone(opts.exceptions(batchId) || []);
      return str(batchId) === DEMO_BATCH ? clone(DEMO_RBE) : [];
    }

    /**
     * 단계 · 슬롯 정의.
     * @param {'prod'|'pack'} scope
     * @param {string=} batchId  prod: 발행 스냅샷 phaseList(칭량 · 이관 제외), 없으면 데모 템플릿 OP
     * @returns {Array<{stepKey, stepNo, name, desc, slots:[{slot, signRuleId, roles[], statementKind, lineQual}]}>}
     */
    function stepsFor(scope, batchId) {
      if (scope === 'pack') return PACK_STEPS.map(function (s, i) { return { stepKey: s[0], stepNo: i + 1, name: s[1], desc: s[2], slots: clone(s[3]) }; });
      if (scope !== 'prod') return [];
      var ops = null, sn = SN(), iss = batchId ? issuedOf(batchId) : null;
      if (sn && iss && typeof sn.buildPhasesFromSnapshot === 'function') {
        try {
          var ups = sn.buildPhasesFromSnapshot(iss);
          if (ups) { ops = []; ups.forEach(function (u) { (u.steps || []).forEach(function (st) { if (!st.isWeigh) ops.push([st.id, st.name || st.id]); }); }); }
        } catch (e) { ops = null; }
      }
      if (!ops || !ops.length) ops = PROD_FALLBACK;
      return ops.map(function (o, i) {
        return { stepKey: o[0], stepNo: i + 1, name: o[1], desc: '', slots: [slot('perform', R.PERF, ['OP', 'SV'], 'exec_step', false), slot('verify', R.VERI, ['OP', 'SV', 'QA'], 'exec_step_verify', false)] };
      });
    }
    function reservedLots(batchId) {
      var iss = issuedOf(batchId), w = WG();
      if (w && typeof w.resolveReservedLots === 'function') return w.resolveReservedLots(iss, { allowDemo: true }) || [];
      return (iss && iss.reservedLots) || [];
    }
    function batchLots(batchId, lots) {
      var mq = MQ(); if (!mq) return null;
      if (Array.isArray(lots)) return lots.map(function (n) { var l = mq.get(n && (n.lotNo || n)); return l || { lotNo: str(n && (n.lotNo || n)), status: 'missing', materialId: '' }; });
      return mq.lotsForBatch(batchId, reservedLots(batchId));
    }

    /**
     * 배치에 필요한 서명 체크리스트.
     * @returns {{ok:true, batchId, items:[{key, scope:'prod'|'pack'|'review'|'matqc', stepKey, stepNo, slot, signRuleId, label, required, reason, gateNo, roles, statementKind}]} | {ok:false, why, message}}
     *   gateNo: 3 = 실행 슬롯(생산 · 포장), 8 = 그 밖 검토(포장 1차 검토 · 2차 검토), 1 = RBE 예외, 4 = 감사추적 검토, 9 = 자재 판정 — 한 서명은 한 조건에만
     */
    function requiredSigns(batchId) {
      batchId = str(batchId); if (!batchId) return fail('no_batch', '배치 ID가 없습니다.');
      var items = [];
      function add(scope, step, sl, label, gateNo, reason) {
        items.push({ key: scope + ':' + step.stepKey + ':' + sl.slot, scope: scope, stepKey: step.stepKey, stepNo: step.stepNo || null, slot: sl.slot, signRuleId: sl.signRuleId,
                     label: label, required: true, reason: reason || '', gateNo: gateNo, roles: (sl.roles || []).slice(), statementKind: sl.statementKind || '' });
      }
      var SL = { perform: '수행', verify: '확인', qa: 'QA 확인', review: '검토' };
      stepsFor('prod', batchId).forEach(function (st) { st.slots.forEach(function (sl) { add('prod', st, sl, st.stepKey + ' ' + st.name + ' ' + SL[sl.slot], 3, '생산 실행 슬롯'); }); });
      stepsFor('pack', batchId).forEach(function (st) {
        st.slots.forEach(function (sl) { add('pack', st, sl, '포장 ' + st.stepNo + ' ' + st.name + ' ' + SL[sl.slot], sl.slot === 'review' ? 8 : 3, sl.slot === 'review' ? '포장 기록 1차 검토' : '포장 실행 슬롯'); });
      });
      rbeExceptions(batchId).filter(function (e) { return e.open; }).forEach(function (e) {
        add('review', { stepKey: e.id }, { slot: 'rbe', signRuleId: R.RBE, roles: ['QA', 'QP'], statementKind: 'rbe_review' }, 'RBE 예외 ' + e.id + ' 승인', 1, '미결 RBE 예외');
      });
      add('review', { stepKey: 'batch' }, { slot: 'batch', signRuleId: R.BATCH, roles: ['QA'], statementKind: 'batch_review' }, '2차 검토 (critical 전수)', 8, '출하 전 QC 검토 (21 CFR 211.192)');
      add('review', { stepKey: 'audit' }, { slot: 'audit', signRuleId: R.AUDIT, roles: ['QA', 'QP'], statementKind: 'audit_review' }, '감사추적 검토', 4, '출하 게이트 4');
      var lots = batchLots(batchId);
      (lots || []).forEach(function (l) {
        var leg = l.status === 'released' && !l.judgeSignatureId;
        add('matqc', { stepKey: l.lotNo }, { slot: 'judge', signRuleId: R.MATQC, roles: ['QA'], statementKind: leg ? 'matqc_legacy_confirm' : (l.status === 'rejected' ? 'matqc_reject' : 'matqc_release') },
            '자재 ' + l.lotNo + (leg ? ' 레거시' : '') + ' 판정', 9, leg ? '판정 서명 없음(레거시)' : '자재 QC 판정');
      });
      return { ok: true, batchId: batchId, items: items };
    }

    /* 서명 레코드 → 유효 여부 (ESign.validity — signatureHash + 무효화 기록 ↔ 감사 대조, 불일치는 fail-closed)
       why: 'missing' | 'void'(정상 무효화) | 'tampered:<첫 불일치>' */
    function sigState(id) {
      if (!id) return { status: 'pending', sig: null };
      var s = S(), sig = s && s.ESign ? s.ESign.get(id) : null;
      if (!sig) return { status: 'invalid', sig: null, why: 'missing' };
      var v = s.ESign.validity ? s.ESign.validity(sig) : { state: 'tampered', mismatches: ['no_validity'] };
      if (v.state === 'valid') return { status: 'signed', sig: sig };
      return { status: 'invalid', sig: sig, why: v.state === 'void' ? 'void' : 'tampered:' + (v.mismatches[0] || 'unknown'), mismatches: v.mismatches };
    }
    function slotRecord(batchId, scope, stepKey, sl) {
      var rec = null;
      readItems(KEYS.EXEC).forEach(function (r) { if (r && r.batchId === batchId && r.scope === scope && r.stepKey === stepKey && r.slot === sl) rec = r; });   /* 마지막(최신) */
      return rec;
    }

    /**
     * requiredSigns × ebr.execRecord.v1 × ebr.esign.v1 (자재 판정은 MatQC judgeSignatureId).
     * @param {{batchId:string, scope?:'prod'|'pack'|'review'|'matqc'}} q
     * @returns {{ok, batchId, items:[…+ status, signatureId, signerId, signerName, signerRole, signedAt, invalidWhy?], counts:{signed, pending, invalid, na}, signers:[{userId, label}]}}
     */
    function getSignStatus(q) {
      q = q || {};
      var rs = requiredSigns(q.batchId); if (!rs.ok) return rs;
      var batchId = rs.batchId, mq = MQ(), counts = { signed: 0, pending: 0, invalid: 0, na: 0 }, signers = [], seen = {};
      var items = rs.items.filter(function (it) { return !q.scope || it.scope === q.scope; }).map(function (it) {
        var sid = null;
        if (it.scope === 'matqc') { var l = mq ? mq.get(it.stepKey) : null; sid = l && l.judgeSignatureId ? l.judgeSignatureId : null; }
        else { var r = slotRecord(batchId, it.scope, it.stepKey, it.slot); sid = r ? r.signatureId : null; }
        var st = sigState(sid), o = clone(it);
        o.status = st.status; o.signatureId = sid; o.signerId = st.sig ? st.sig.signerId : null; o.signerName = st.sig ? st.sig.signerName : null;
        o.signerRole = st.sig ? st.sig.signerRole : null; o.signedAt = st.sig ? st.sig.signedAt : null;
        if (st.why) o.invalidWhy = st.why;
        counts[o.status]++;
        if (o.signerId && o.status === 'signed' && !seen[o.signerId + '|' + o.label]) { seen[o.signerId + '|' + o.label] = 1; signers.push({ userId: o.signerId, label: o.label, scope: o.scope, slot: o.slot, signRuleId: o.signRuleId }); }
        return o;
      });
      return { ok: true, batchId: batchId, items: items, counts: counts, signers: signers };
    }

    /** 칭량 줄 서명 집계 (EbrDispense.summary 위임). 계획 없음 → lines 0 · noPlan true (게이트 3 은 칭량 대상 없음으로 본다) */
    function weighSignSummary(batchId) {
      var d = DS(); if (!d) return { ok: true, lines: 0, verified: 0, pending: 0, invalid: 0, noPlan: true, why: 'no_dispense' };
      var s = null; try { s = d.summary(batchId); } catch (e) { s = null; }
      if (!s || !s.ok) return { ok: true, lines: 0, verified: 0, pending: 0, invalid: 0, noPlan: true, why: (s && s.why) || 'no_plan' };
      return { ok: true, lines: s.total, verified: s.verified, pending: s.total - s.verified, invalid: 0, noPlan: false };
    }

    /** LOT 별 판정 서명 상태. sign: signed | legacy(released/rejected 인데 판정 서명 없음) | invalid | pending(testing · quarantine) */
    function matqcSignStatus(batchId, lots) {
      var ls = batchLots(batchId, lots); if (ls == null) return fail('matqc_missing', 'MatQC 미로드 — 판정 서명 상태를 알 수 없습니다.');
      return { ok: true, items: ls.map(function (l) {
        var sign = 'pending', st = null;
        if (l.judgeSignatureId) { st = sigState(l.judgeSignatureId); sign = st.status === 'signed' ? 'signed' : 'invalid'; }
        else if (l.status === 'released' || l.status === 'rejected') sign = 'legacy';
        return { lotNo: l.lotNo, materialId: l.materialId || '', status: l.status, signatureId: l.judgeSignatureId || null, judgedBy: l.judgedBy || null, judgedAt: l.judgedAt || null, sign: sign };
      }) };
    }

    /**
     * 게이트 1 · 3 · 4 · 8 · 9 판정 묶음 (+ 참고 2: Dev.openCount).
     * @returns {{ok, batchId, items:{'1'|'2'|'3'|'4'|'8'|'9': {no, st:'pass'|'block', basis, refs[]}}, blocked:number[]}}
     */
    function gateSignItems(batchId) {
      var gs = getSignStatus({ batchId: batchId }); if (!gs.ok) return gs;
      var items = {}, sorted = function (a) { return a.filter(Boolean).slice().sort(); };
      function put(no, pass, basis, refs) { items[no] = { no: no, st: pass ? 'pass' : 'block', basis: basis, refs: sorted(refs || []) }; }
      var byGate = function (n) { return gs.items.filter(function (i) { return i.gateNo === n; }); };
      var ids = function (a) { return a.filter(function (i) { return i.status === 'signed'; }).map(function (i) { return i.signatureId; }); };
      /* 1 */
      var g1 = byGate(1), g1bad = g1.filter(function (i) { return i.status !== 'signed'; });
      put(1, !g1bad.length, g1.length ? (g1bad.length ? '서명 없는 미결 예외 ' + g1bad.length + '건 — ' + g1bad.map(function (i) { return i.stepKey; }).join(', ') : '미결 예외 ' + g1.length + '건 모두 승인 (SM-REV-RBE ' + g1.map(function (i) { return i.signerId; }).join(', ') + ')') : '미결 예외 0건', ids(g1));
      /* 2 (참고 — 화면 기존 판정과 같은 원천) */
      var dv = DV(), openDev = dv ? dv.listOpen(gs.batchId) : null;
      put(2, openDev ? !openDev.length : false, openDev ? (openDev.length ? '미종결 일탈 ' + openDev.length + '건' : '미종결 일탈 0건') : 'Dev 미로드 — 차단(fail-closed)', (openDev || []).map(function (d) { return d.id; }));
      /* 3 = 생산 · 포장 실행 슬롯 + 칭량 줄 */
      var g3 = byGate(3), w = weighSignSummary(gs.batchId);
      var p3 = g3.filter(function (i) { return i.status === 'pending'; }).length, inv3 = g3.filter(function (i) { return i.status === 'invalid'; }).length;
      var parts = [];
      if (p3) parts.push('실행 슬롯 대기 ' + p3); if (inv3) parts.push('무효 ' + inv3); if (w.pending) parts.push('칭량 줄 미검증 ' + w.pending + '/' + w.lines); if (w.invalid) parts.push('칭량 무효 ' + w.invalid);
      put(3, !p3 && !inv3 && !w.pending && !w.invalid, parts.length ? parts.join(' · ') : '실행 슬롯 ' + g3.length + '건 유효' + (w.noPlan ? ' · 칭량 계획 없음' : ' · 칭량 ' + w.verified + '/' + w.lines), ids(g3));
      /* 4 = 감사추적 검토 + 규칙 효력 */
      var g4 = byGate(4)[0], s = S(), rule = s ? s.getSignRule(R.AUDIT) : null, eff = !!(rule && rule.effective && rule.allowedRoles && rule.allowedRoles.length);
      put(4, eff && g4 && g4.status === 'signed', !eff ? '규칙 SM-REV-AUDIT 효력 없음 (S-39)' : (g4.status === 'signed' ? 'SM-REV-AUDIT v' + rule.ver + ' ' + g4.signerId : (g4.status === 'invalid' ? '감사추적 검토 서명 무효' : '감사추적 검토 서명 대기')), g4 ? ids([g4]) : []);
      /* 8 = 그 밖 검토(포장 1차 · 2차) */
      var g8 = byGate(8), b8 = g8.filter(function (i) { return i.status !== 'signed'; });
      put(8, !b8.length, b8.length ? b8.map(function (i) { return i.label + (i.status === 'invalid' ? ' 무효' : ' 대기'); }).join(' · ') : '필요 검토 서명 ' + g8.length + '건 유효', ids(g8));
      /* 9 = 자재 QC (released) + 판정 서명 */
      var mq = MQ(), g9 = byGate(9), rel = mq ? mq.assertAllReleasedForBatch(gs.batchId, reservedLots(gs.batchId)) : { ok: false, reason: 'MatQC 미로드 — 출하 차단(fail-closed)' };
      var ms = matqcSignStatus(gs.batchId), msi = ms.ok ? ms.items : [], nSig = msi.filter(function (x) { return x.sign === 'signed'; }).length, nLeg = msi.filter(function (x) { return x.sign === 'legacy'; }).length;
      var nRel = msi.filter(function (x) { return x.status === 'released'; }).length;
      put(9, rel.ok && msi.length && nSig === msi.length, !rel.ok ? (rel.reason || '자재 QC 미적합') : 'released ' + nRel + '/' + msi.length + ' · 판정 서명 ' + nSig + '/' + msi.length + (nLeg ? ' (레거시 ' + nLeg + ' — 판정 서명 필요)' : ''),
          ids(g9).concat(msi.map(function (x) { return x.lotNo; })));
      /* 무효화 기록 대조 — 저장소 손상(사슬 · 해시) 또는 기록 ↔ 감사 불일치가 하나라도 있으면 모든 항목 차단 (fail-closed) */
      var ss = S(), vs = ss && ss.ESign && ss.ESign.voidState ? ss.ESign.voidState() : null, vmm = [];
      if (!vs) vmm.push('void_check_unavailable');
      else {
        vmm = vs.mismatches.slice();
        Object.keys(vs.bySig).forEach(function (sid) { vs.bySig[sid].mismatches.forEach(function (m) { vmm.push(m + ':' + sid); }); });
      }
      var voidIntegrity = { intact: !vmm.length, mismatches: vmm };
      if (vmm.length) Object.keys(items).forEach(function (n) { items[n].st = 'block'; items[n].basis = '무효화 기록 대조 불일치 — 차단(fail-closed) · ' + items[n].basis; });
      var blocked = Object.keys(items).map(Number).filter(function (n) { return items[n].st === 'block'; }).sort(function (a, b) { return a - b; });
      return { ok: true, batchId: gs.batchId, items: items, blocked: blocked, counts: gs.counts, voidIntegrity: voidIntegrity };
    }

    /** 출하 여부 → {released:true, batchId, releasedAt, signatureId, manifestHash} | null */
    function releaseState(batchId) {
      var r = null; readItems(KEYS.RELEASE).forEach(function (x) { if (x && x.batchId === str(batchId)) r = x; });
      return r ? { released: true, batchId: r.batchId, releasedAt: r.releasedAt, signatureId: r.signatureId, manifestHash: r.manifestHash } : null;
    }

    return {
      VERSION: 1, KEYS: clone(KEYS), GATE_NOS: GATE_NOS.slice(), SIGN_STATES: SIGN_STATES.slice(), DEMO_BATCH: DEMO_BATCH, RULES: clone(R),
      stepsFor: stepsFor, rbeExceptions: rbeExceptions, issuedOf: issuedOf, reservedLots: reservedLots,
      requiredSigns: requiredSigns, getSignStatus: getSignStatus, weighSignSummary: weighSignSummary,
      matqcSignStatus: matqcSignStatus, gateSignItems: gateSignItems, releaseState: releaseState,
      create: create
    };
  }

  var API = create({});
  global.EbrSignStatus = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
