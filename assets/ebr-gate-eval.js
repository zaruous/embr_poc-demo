/* =====================================================================
   ebr-gate-eval.js — 출하 게이트 12조건 동적 판정 (전역 EbrGateEval, DOM 없음 · 읽기 전용: setItem 없음)
   - 설계: poc-release-gate-dynamic-design.md 개정 1 (§2 조건별 판정 · §3 평가 결과 구조 · §8 결정 D-O1–D-O7)
   - 1 · 2 · 3 · 4 · 8 · 9 = EbrSignStatus.gateSignItems 그대로, 5 · 6 = P0 N/A(사유), 7 · 10 · 11 · 12 = 저장소 데이터로 판정.
   - fail-closed: 원천을 못 읽거나 판정 중 오류가 나면 그 조건은 block (why 'src_unreadable' | 'eval_error'). 헬퍼 · 서명 현황이 없으면 { ok:false }.
   - 상태: 'pass' | 'block' | 'na'. refs = 근거 ID 정렬 배열 (manifest 용, 시각 · 이름 제외).
   - 워터마크 갱신 · 조건 서명 · 다운타임/EF 기록은 쓰기 모듈 몫 (EbrUserSession.Integrity · EbrExecSign.beginCondSign · EbrGateCond).
   - EbrGateEval.create({ storage?, session?, signStatus?, now? }) 로 노드 시험 주입.
   ===================================================================== */
(function (global) {
  'use strict';

  var KEYS = { ISSUED: 'ebr.batch.issued.v1', ESIGN: 'ebr.esign.v1', EXEC: 'ebr.execRecord.v1', RELEASE: 'ebr.release.v1', DOWNTIME: 'ebr.downtime.v1',
               IFACE: 'ebr.ifaceMsg.v1', HISTORIAN: 'ebr.historianSnap.v1', INTEGRITY: 'ebr.integrity.v1', TREE: 'ebmr.processTree.v1', DEV: 'ebr.deviation.v1',
               MAT: 'ebr.materialLot.v1', AUDIT: 'ebr.audit.v1', VOID: 'ebr.esignVoid.v1', MBR: 'ebr.mbrSign.v1' };
  var COND_RULES = { 7: 'SM-REV-DOWN', 10: 'SM-REV-CHG', 11: 'SM-REV-CTRL', 12: 'SM-REV-RESTORE' };
  var COND_KIND = { 7: 'downtime_review', 10: 'change_impact_review', 11: 'control_eval_review', 12: 'restore_ack' };
  var COND_REC = { 7: 'downtime_review', 10: 'change_impact', 11: 'control_eval', 12: 'integrity_ack' };
  var COND = {
    1: '미결 RBE 예외', 2: '미종결 일탈(초안 포함)', 3: '실행 서명 대기 · 무효', 4: '감사추적 검토 서명', 5: '인터페이스 대사', 6: '히스토리안 기준선 · 샘플 밀도',
    7: '다운타임 검토 · 비상 양식 회수', 8: '그 밖 필요 서명 대기', 9: '자재 QC · 칭량물', 10: '개정 첫 배치 변경 영향 검토', 11: '통제 강화 후 기존 값 평가', 12: '복원 탐지 후 QA 확인'
  };
  var SIGN_SOURCE = { 1: [KEYS.ESIGN], 2: [KEYS.DEV], 3: [KEYS.ESIGN, KEYS.EXEC], 4: [KEYS.ESIGN, KEYS.EXEC], 8: [KEYS.ESIGN, KEYS.EXEC], 9: [KEYS.MAT, KEYS.ESIGN] };
  var NOS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  var COND_SIGN_LABEL = { 7: '다운타임 검토', 10: '변경 영향 검토', 11: '통제 강화 평가', 12: '복원 확인' };
  /* §2 공통 문구 (개정 1.1) */
  var MSG_READ_ONLY = '복원 탐지로 읽기 전용입니다 — QA 복원 확인 서명 필요(데모 초기화는 QA·관리자만)';
  function msgUnreadable(store) { return '판정 원천을 읽을 수 없습니다 (' + store + ') — 재평가하세요.'; }

  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function str(v) { return v == null ? '' : String(v).trim(); }
  function uniqSort(a) { var m = {}; (a || []).forEach(function (x) { if (x != null && x !== '') m[String(x)] = 1; }); return Object.keys(m).sort(); }
  function ms(iso) { var t = Date.parse(iso); return isFinite(t) ? t : NaN; }
  function efText(list) {
    if (!list || !list.length) return '—';
    if (list.length === 1) return list[0];
    var a = list[0], b = list[list.length - 1], i = 0; while (i < a.length && a[i] === b[i]) i++;
    var cut = a.lastIndexOf('-', i - 1) + 1;
    return a + '~' + (cut > 0 ? b.slice(cut) : b);
  }

  function create(opts) {
    opts = opts || {};
    function S() { return opts.session || global.EbrUserSession || null; }
    function SS() { return opts.signStatus || global.EbrSignStatus || null; }
    function storage() { return opts.storage || global.localStorage; }
    function raw(k) { var s = storage(); return s ? s.getItem(k) : null; }
    /* → { ok, v } — 키 없음 ok:true v:null, 파싱 실패 ok:false */
    function readKey(k) { var r = raw(k); if (r == null || r === '') return { ok: true, v: null }; try { return { ok: true, v: JSON.parse(r) }; } catch (e) { return { ok: false, v: null }; } }
    function itemsOf(v) { return Array.isArray(v) ? v : (v && Array.isArray(v.items) ? v.items : []); }
    function nowIso() { return opts.now || (S() && S().nowIsoLocal ? S().nowIsoLocal() : new Date().toISOString()); }

    function item(no, st, basis, extra) {
      var it = { no: no, cond: COND[no], st: st, basis: basis, source: [], refs: [], sign: null };
      if (extra) Object.keys(extra).forEach(function (k) { it[k] = extra[k]; });
      it.refs = uniqSort(it.refs);
      if (st !== 'block') delete it.msg;
      return it;
    }
    function signInfo(no, pending) {
      var s = S(), r = s && s.getSignRule ? s.getSignRule(COND_RULES[no]) : null;
      return { ruleId: COND_RULES[no], ver: r ? r.ver : null, meaning: 'reviewed', roles: r && Array.isArray(r.allowedRoles) ? r.allowedRoles.slice() : [],
               effective: !!(r && r.effective), statementKind: COND_KIND[no], recordType: COND_REC[no], pending: !!pending };
    }
    function validSigs(filter) {
      var s = S(), out = [];
      itemsOf(readKey(KEYS.ESIGN).v).forEach(function (g) {
        if (!g || (filter && !filter(g))) return;
        var v = s.ESign.validity(g); if (v.state === 'valid') out.push(g);
      });
      return out;
    }
    function issuedList() { var r = readKey(KEYS.ISSUED); if (!r.ok) return null; var v = r.v; return Array.isArray(v) ? v : (v && Array.isArray(v.batches) ? v.batches : itemsOf(v)); }
    function issuedOf(batchId) { var l = issuedList(); if (!l) return undefined; return l.filter(function (b) { return b && str(b.batchId || b.batchNo || b.id) === batchId; })[0] || null; }

    /* ---- 조건 5 인터페이스 대사 (P0: 원천 저장소 골격만 — 연계 없음 N/A) */
    function cond5(B) {
      var r = readKey(KEYS.IFACE), src = { source: [KEYS.IFACE] };
      if (!r.ok) return item(5, 'block', '원천 읽기 실패 (' + KEYS.IFACE + ')', Object.assign({ why: 'src_unreadable', msg: msgUnreadable(KEYS.IFACE) }, src));
      if (!r.v || !r.v.enabled) return item(5, 'na', '외부 연계 없음 (PoC)', Object.assign({ why: r.v ? 'iface_disabled' : 'iface_not_seeded' }, src));
      var m = itemsOf(r.v).filter(function (x) { return x && x.batchId === B; });
      var p = m.filter(function (x) { return x.status === 'pending'; }), d = m.filter(function (x) { return x.status === 'dead'; }), c = m.filter(function (x) { return x.critical && x.diff; });
      if (!p.length && !d.length && !c.length) return item(5, 'pass', '미전송 0 · 데드레터 0 · critical 차이 0', src);
      return item(5, 'block', '미전송 ' + p.length + ' · 데드레터 ' + d.length + ' · critical 차이 ' + c.length, Object.assign({
        refs: p.concat(d, c).map(function (x) { return x.msgId; }),
        msg: '인터페이스 대사 미완료 — 미전송 ' + p.length + '건 · 데드레터 ' + d.length + '건 · critical 차이 ' + c.length + '건. 재전송 또는 대사 처리 후 재평가하세요.' }, src));
    }
    /* ---- 조건 6 히스토리안 (P0: 발행 스냅샷에 기준선 의존 미저장 — 결정 D-O2) */
    function cond6() {
      return item(6, 'na', '기준선 의존 미저장 (P1에서 연결)', { why: 'p0_no_baseline_dependency', source: [KEYS.HISTORIAN] });
    }

    /* ---- 조건 7 다운타임 QA 전수 검토 · 비상 양식 회수 (결정 D-O3) */
    function execEnd(B, iss) {
      var rel = null; itemsOf(readKey(KEYS.RELEASE).v).forEach(function (x) { if (x && x.batchId === B) rel = x; });
      if (!rel) return ms(nowIso());
      var last = NaN; itemsOf(readKey(KEYS.EXEC).v).forEach(function (x) { if (x && x.batchId === B) { var t = ms(x.at); if (isFinite(t) && !(t <= last)) last = t; } });
      return isFinite(last) ? last : ms(rel.releasedAt);
    }
    function downtimeOf(B, iss) {
      var r = readKey(KEYS.DOWNTIME); if (!r.ok) return null;
      var v = r.v || {}, ef = Array.isArray(iss.efRange) ? iss.efRange : [];
      var ps = ms(iss.issuedAt), pe = execEnd(B, iss);
      var dts = itemsOf(v).filter(function (d) {
        if (!d) return false;
        var f = ms(d.from), t = d.to ? ms(d.to) : Infinity;
        var byTime = isFinite(ps) && isFinite(f) && str(d.line) && str(d.line) === str(iss.line) && f <= pe && t >= ps;
        var byEf = (d.efUsed || []).some(function (x) { return ef.indexOf(x) >= 0; });
        return byTime || byEf;
      });
      var returns = (Array.isArray(v.returns) ? v.returns : []).filter(function (x) { return x && x.batchId === B; });
      return { dts: dts, returns: returns };
    }
    function dtReviewed(d, B) {
      if (!d.reviewSignatureId) return null;
      var s = S(), g = s.ESign.get(d.reviewSignatureId);
      return g && g.signRuleId === COND_RULES[7] && g.dtId === d.dtId && s.ESign.validity(g).state === 'valid' ? g : null;
    }
    function cond7(B, iss) {
      var src = { source: [KEYS.DOWNTIME, KEYS.ISSUED] };
      if (iss.efCount == null || !Array.isArray(iss.efRange)) return item(7, 'block', 'EF 발행 정보 없음 (이전 발행 기록)', Object.assign({ why: 'ef_unknown', sign: signInfo(7, false),
        msg: '다운타임 검토 미완료 — 발행 기록에 비상 양식(EF) 정보가 없습니다 (이전 발행 기록). 재발행이 필요합니다.' }, src));
      var dt = downtimeOf(B, iss);
      if (!dt) return item(7, 'block', '원천 읽기 실패 (' + KEYS.DOWNTIME + ')', Object.assign({ why: 'src_unreadable', sign: signInfo(7, false), msg: msgUnreadable(KEYS.DOWNTIME) }, src));
      var used = {}, ret = {};
      dt.dts.forEach(function (d) { (d.efUsed || []).forEach(function (x) { used[x] = 1; }); (d.efReturned || []).forEach(function (x) { ret[x] = 1; }); });
      dt.returns.forEach(function (r) { (r.efNos || []).forEach(function (x) { ret[x] = 1; }); });
      var missing = iss.efRange.filter(function (x) { return !used[x] && !ret[x]; });
      var unrev = dt.dts.filter(function (d) { return !dtReviewed(d, B); }), rev = dt.dts.filter(function (d) { return !!dtReviewed(d, B); });
      var detail = { downtimes: dt.dts.map(function (d) { var g = dtReviewed(d, B); return { dtId: d.dtId, line: d.line || '', from: d.from || '', to: d.to || null, efUsed: (d.efUsed || []).slice(), reviewSignatureId: g ? g.signatureId : null }; }),
                     ef: { count: iss.efCount, range: iss.efRange.slice(), rangeText: efText(iss.efRange), used: Object.keys(used).sort(), returned: Object.keys(ret).sort(), missing: missing } };
      var basisEf = 'EF ' + iss.efCount + '매 중 사용 ' + Object.keys(used).length + ' · 회수 ' + Object.keys(ret).length + ' · 미회수 ' + missing.length;
      if (!dt.dts.length && !missing.length) return item(7, 'na', '다운타임 없음 · EF 전량 회수 (' + iss.efCount + '매)', Object.assign({ detail: detail, sign: signInfo(7, false) }, src));
      if (!unrev.length && !missing.length) return item(7, 'pass', '다운타임 ' + dt.dts.length + '건 QA 검토 완료 · ' + basisEf, Object.assign({ detail: detail, sign: signInfo(7, false),
        refs: rev.map(function (d) { return dtReviewed(d, B).signatureId; }).concat(dt.dts.map(function (d) { return d.dtId; })) }, src));
      return item(7, 'block', '다운타임 검토 대기 ' + unrev.length + ' · ' + basisEf, Object.assign({ detail: detail, sign: signInfo(7, unrev.length > 0),
        refs: unrev.map(function (d) { return d.dtId; }).concat(missing),
        msg: '다운타임 검토 미완료 — QA 검토 서명 대기 ' + unrev.length + '건 · 비상 양식 미회수 ' + missing.length + '매 (' + efText(missing) + ').' }, src));
    }

    /* ---- 조건 10 개정 첫 배치 변경 영향 검토 (결정 D-O4: v1 신규 MBR 포함) */
    function treeCc(id, ver) {
      var r = readKey(KEYS.TREE); if (!r.ok || !r.v) return null;
      var list = Array.isArray(r.v.trees) ? r.v.trees : [r.v];
      var t = list.filter(function (x) { return x && String(x.id) === String(id) && String(x.ver) === String(ver); })[0];
      return t && t.cc && t.cc !== '—' ? String(t.cc) : null;
    }
    function changeInfo(iss) {
      var cc = treeCc(iss.processTreeId, iss.ver);
      return { mbr: str(iss.mbrId) || str(iss.processTreeId), ver: str(iss.ver), cc: cc, ccText: cc || '신규 MBR' };   /* CC 가 없으면 '신규 MBR' ('CC 번호 없음' 문구 폐지) */
    }
    function cond10(B, iss) {
      var src = { source: [KEYS.ISSUED, KEYS.TREE, KEYS.ESIGN] };
      if (!str(iss.processTreeId) || !str(iss.ver)) return item(10, 'block', '발행 기록에 MBR · 버전 없음', Object.assign({ why: 'no_tree_ref', sign: signInfo(10, false), msg: '개정 첫 배치 판정 불가 — 발행 기록에 MBR · 버전이 없습니다 (fail-closed).' }, src));
      var peers = (issuedList() || []).filter(function (b) { return b && str(b.processTreeId) === str(iss.processTreeId) && str(b.ver) === str(iss.ver); });
      peers.sort(function (a, b) {
        var x = ms(a.issuedAt), y = ms(b.issuedAt); x = isFinite(x) ? x : Infinity; y = isFinite(y) ? y : Infinity;   /* 시각 없음 = 뒤로 */
        if (x !== y) return x < y ? -1 : 1;
        return str(a.batchId) < str(b.batchId) ? -1 : (str(a.batchId) > str(b.batchId) ? 1 : 0);
      });
      var first = peers[0], ci = changeInfo(iss);
      if (first && str(first.batchId) !== B) return item(10, 'na', '개정 첫 배치 아님 (첫 배치 ' + str(first.batchId) + ')', Object.assign({ refs: [str(first.batchId)], detail: ci }, src));
      var sig = validSigs(function (g) { return g.signRuleId === COND_RULES[10] && g.batchId === B && str(g.ver) === ci.ver; })[0];
      if (sig) return item(10, 'pass', ci.ccText + ' 영향 검토 ' + sig.signatureId, Object.assign({ refs: [sig.signatureId], detail: ci, sign: signInfo(10, false) }, src));
      return item(10, 'block', ci.mbr + ' v' + ci.ver + ' 첫 배치 · 영향 검토 서명 없음', Object.assign({ refs: [str(iss.processTreeId) + '@' + ci.ver], detail: ci, sign: signInfo(10, true),
        msg: '개정 첫 배치입니다 — ' + ci.mbr + ' v' + ci.ver + ' 변경 영향 검토 서명(' + ci.ccText + ')이 필요합니다.' }, src));
    }

    /* ---- 조건 11 통제 강화 후 기존 값 평가 (결정 D-O1 서명 뒤 규칙 버전 상승 · D-O5 자격 버전은 있을 때만 — P0 없음) */
    function staleOf(B) {
      var s = S(), out = [];
      validSigs(function (g) { return g.batchId === B && g.signRuleId !== COND_RULES[11]; }).forEach(function (g) {
        if (g.signRuleVer == null || !g.signRuleId) return;
        var r = s.getSignRule(g.signRuleId);
        if (r && r.effective && Number(r.ver) > Number(g.signRuleVer)) out.push({ signatureId: g.signatureId, ruleId: g.signRuleId, from: Number(g.signRuleVer), to: Number(r.ver) });
      });
      return out.sort(function (a, b) { return a.signatureId < b.signatureId ? -1 : 1; });
    }
    function cond11(B) {
      var src = { source: [KEYS.ESIGN, 'ebmr.masterSetup.v2'] };
      var stale = staleOf(B), qualNote = '자격 버전 없음 (자격 요구 강화 판정 N/A)';
      if (!stale.length) return item(11, 'na', '서명 후 규칙 변경 없음 · ' + qualNote, Object.assign({ detail: { stale: [], qual: 'na' }, sign: signInfo(11, false) }, src));
      var ids = stale.map(function (x) { return x.signatureId; }), cov = {}, evIds = [];
      validSigs(function (g) { return g.signRuleId === COND_RULES[11] && g.batchId === B; }).forEach(function (g) { evIds.push(g.signatureId); (g.staleIds || []).forEach(function (x) { cov[x] = 1; }); });
      var left = ids.filter(function (x) { return !cov[x]; });
      var grp = {}; stale.forEach(function (x) { var k = x.ruleId + ' v' + x.from + '→v' + x.to; grp[k] = (grp[k] || 0) + 1; });
      var gk = Object.keys(grp).sort(), gtxt = gk[0] + (gk.length > 1 ? ' 외 ' + (gk.length - 1) : '');   /* 첫 항목 + ' 외 k' (§2 문구 규칙) */
      if (!left.length) return item(11, 'pass', '규칙 변경 값 ' + ids.length + '건 평가 완료 (' + gtxt + ')', Object.assign({ refs: evIds, detail: { stale: stale, qual: 'na' }, sign: signInfo(11, false) }, src));
      return item(11, 'block', '서명 뒤 규칙 변경 ' + left.length + '건 미평가 (' + gtxt + ')', Object.assign({ refs: left, detail: { stale: stale, uncovered: left, qual: 'na' }, sign: signInfo(11, true),
        msg: '통제 강화 후 기존 값 평가 필요 — 서명 뒤 규칙이 바뀐 값 ' + left.length + '건 (' + gtxt + ').' }, src));
    }

    /* ---- 조건 12 복원 탐지 후 QA 확인 전 읽기 전용 */
    /* 복원 탐지 사유 표시 (조건 12 기준 · 근거 문구) */
    var DETECT_TEXT = { wm_missing: '워터마크 없음', wm_invalid: '워터마크 형식 오류', audit: '감사 건수 감소', esign: '서명 건수 감소', 'void': '무효 사슬 감소', lastAudit: '마지막 감사 해시 불일치' };
    function detectText(why) { return (why || []).map(function (w) { return (DETECT_TEXT[w] || w) + '(' + w + ')'; }).join(' · '); }
    function cond12(B) {
      var s = S(), src = { source: [KEYS.VOID, KEYS.ESIGN, KEYS.INTEGRITY, KEYS.AUDIT] };
      var vs = s.ESign.voidState();
      if (!vs.intact) return item(12, 'block', '무효 사슬 불일치', Object.assign({ why: 'void_chain', refs: vs.mismatches.slice(), sign: signInfo(12, false), readOnly: true,
        msg: '무효화 기록 대조가 맞지 않습니다 — QA 조사 전까지 이 배치는 읽기 전용입니다.' }, src));
      var bad = itemsOf(readKey(KEYS.ESIGN).v).filter(function (g) { return g && g.batchId === B && !s.ESign.verify(g).ok; }).map(function (g) { return g.signatureId; });
      var st = s.Integrity ? s.Integrity.state() : { ok: false };
      if (!st.ok) return item(12, 'block', '워터마크 읽기 실패', Object.assign({ why: 'src_unreadable', sign: signInfo(12, false), readOnly: true, msg: msgUnreadable(KEYS.INTEGRITY) }, src));
      var w = st.watermark || {}, c = st.current, detail = { watermark: st.watermark, current: c, why: st.why.slice(), bad: bad };
      if (st.restored) return item(12, 'block', '복원 탐지 — ' + detectText(st.why), Object.assign({ why: 'restore_detected', refs: bad.concat(['wm:' + (w.at || '')]), detail: detail, sign: signInfo(12, true), readOnly: true,
        msg: '저장 데이터 복원이 탐지되었습니다 — QA 확인 전까지 이 배치는 읽기 전용입니다. ' + (st.watermark ? '(감사 ' + w.auditCount + '→' + c.auditCount + '건 · 서명 ' + w.esignCount + '→' + c.esignCount + '건)' : '(워터마크 ' + (st.why.indexOf('wm_missing') >= 0 ? '없음' : '형식 오류') + ')') }, src));
      if (bad.length) return item(12, 'block', '서명 무결성 불일치 ' + bad.length + '건', Object.assign({ why: 'signature_mismatch', refs: bad, detail: detail, sign: signInfo(12, false), readOnly: true,
        msg: '서명 레코드 무결성 불일치 ' + bad.length + '건 — QA 조사 전까지 이 배치는 읽기 전용입니다.' }, src));
      var ack = w.ackSignatureId ? s.ESign.get(w.ackSignatureId) : null;
      var ackOk = !!(ack && ack.signRuleId === COND_RULES[12] && s.ESign.validity(ack).state === 'valid');
      return item(12, 'pass', ackOk ? '무결성 정상 (복원 확인 ' + ack.signatureId + ')' : '무결성 정상 (사슬 · 워터마크)', Object.assign({ refs: ackOk ? [ack.signatureId] : [], detail: detail, sign: signInfo(12, false), readOnly: false }, src));
    }

    function guarded(no, fn) {
      try { return fn(); } catch (e) {
        return item(no, 'block', '판정 오류 — 차단(fail-closed)', { why: 'eval_error', error: String((e && e.message) || e), msg: '조건 ' + no + ' 판정 중 오류가 났습니다 — 차단(fail-closed).' });
      }
    }

    /**
     * 12조건 평가 → { ok, batchId, evalAt, registry:'v2', items:[GateItem×12], blocked:[no], na:[no], counts:{pass, block, na} } | { ok:false, why, message }
     */
    function evaluate(batchId, o) {
      var B = str(batchId), s = S(), ss = SS();
      if (!B) return { ok: false, why: 'no_batch', message: '배치 ID가 없습니다.' };
      if (!s || !s.ESign || !s.ESign.validity || !ss) return { ok: false, why: 'no_session', message: '헬퍼 · 서명 현황(EbrUserSession · EbrSignStatus)을 찾을 수 없습니다.' };
      var g; try { g = ss.gateSignItems(B); } catch (e) { g = { ok: false, why: 'eval_error', message: String(e && e.message) }; }
      if (!g || !g.ok) return { ok: false, why: (g && g.why) || 'gate_sign_items', message: (g && g.message) || '서명 원천 판정 실패' };
      var iss = issuedOf(B), items = {};
      [1, 2, 3, 4, 8, 9].forEach(function (n) {
        var x = g.items[n];
        items[n] = x ? item(n, x.st === 'pass' ? 'pass' : 'block', x.basis, { refs: (x.refs || []).slice(), source: SIGN_SOURCE[n].slice(), msg: x.st === 'pass' ? undefined : x.basis })
                     : item(n, 'block', '서명 원천 항목 없음 — 차단(fail-closed)', { why: 'eval_error', source: SIGN_SOURCE[n].slice(), msg: '조건 ' + n + ' 원천 항목이 없습니다.' });
        if (g.voidIntegrity && !g.voidIntegrity.intact) items[n].why = 'void_integrity';
      });
      items[5] = guarded(5, function () { return cond5(B); });
      items[6] = guarded(6, function () { return cond6(B); });
      [7, 10].forEach(function (n) {
        items[n] = guarded(n, function () {
          if (iss === undefined) return item(n, 'block', '원천 읽기 실패 (' + KEYS.ISSUED + ')', { why: 'src_unreadable', source: [KEYS.ISSUED], msg: msgUnreadable(KEYS.ISSUED) });
          if (!iss) return item(n, 'block', '발행 기록 없음', { why: 'no_issued', source: [KEYS.ISSUED], msg: '발행 기록이 없는 배치입니다 — 차단.' });
          return n === 7 ? cond7(B, iss) : cond10(B, iss);
        });
      });
      items[11] = guarded(11, function () { return cond11(B); });
      items[12] = guarded(12, function () { return cond12(B); });
      var list = NOS.map(function (n) { return items[n]; });
      var counts = { pass: 0, block: 0, na: 0 }; list.forEach(function (x) { counts[x.st]++; });
      var out = { ok: true, batchId: B, evalAt: (o && o.now) || nowIso(), registry: 'v2', items: list,
               blocked: list.filter(function (x) { return x.st === 'block'; }).map(function (x) { return x.no; }),
               na: list.filter(function (x) { return x.st === 'na'; }).map(function (x) { return x.no; }), counts: counts };
      if (o && o.audit) out.audited = auditIfChanged(out, o);
      return out;
    }
    /* [재평가] 감사 GATE_EVALUATED — 같은 배치의 직전 GATE_EVALUATED 와 조건별 상태 요약(after.state)이 같으면 쓰지 않는다(렌더 · 반복 클릭 감사 금지).
       감사 쓰기는 헬퍼 Audit.append (이 옵션일 때만 — 기본 evaluate 는 읽기 전용) → true(기록) | false(변화 없음 · 실패) */
    function auditIfChanged(e, o) {
      var s = S(); if (!s || !s.Audit) return false;
      var state = e.items.map(function (x) { return x.no + ':' + x.st; }).join(',');
      var prev = null; (s.Audit.list({}) || []).forEach(function (a) { if (a && a.act === 'GATE_EVALUATED' && a.tgt === e.batchId) prev = a; });
      if (prev && prev.after && prev.after.state === state) return false;
      var val = e.batchId + ' · 차단 ' + (e.blocked.length ? e.blocked.join(',') : '0') + ' · N/A ' + (e.na.length ? e.na.join(',') : '0');
      try { s.Audit.append({ act: 'GATE_EVALUATED', tgt: e.batchId, val: val, batchId: e.batchId, before: prev && prev.after ? { state: prev.after.state } : null, after: { state: state, evalAt: e.evalAt }, screen: o.screen }); return true; }
      catch (err) { return false; }
    }
    function itemOf(batchId, no) { var e = evaluate(batchId); if (!e.ok) return null; return e.items.filter(function (x) { return x.no === Number(no); })[0] || null; }

    /** manifest 입력 (§3.4-3 규칙): { ok, manifest:{v:1, batchId, gate:[{no, st, refs}], signs:[…]}, blocked, naNos, items, signers } — evalAt · basis 제외 */
    function manifestInput(batchId) {
      var e = evaluate(batchId); if (!e.ok) return e;
      var gs = SS().getSignStatus({ batchId: e.batchId });
      var signs = gs && gs.ok ? gs.items.filter(function (i) { return i.status === 'signed'; }).map(function (i) { return i.signatureId; }).sort() : [];
      var gate = e.items.map(function (x) { return { no: x.no, st: x.st, refs: x.refs.slice() }; });
      return { ok: true, manifest: { v: 1, batchId: e.batchId, gate: gate, signs: signs }, blocked: e.blocked.slice(), naNos: e.na.slice(), items: e.items, signers: gs && gs.ok ? gs.signers : [] };
    }

    /**
     * 조건 서명 spec (7 · 10 · 11 · 12) — EbrExecSign.beginCondSign 이 beginRecordSign 으로 연다.
     * → { ok:true, no, signRuleId, recordType, statementKind, statementCtx, fields, distinctFrom, tgt, val, label, key } | { ok:false, why:'bad_no'|'no_sign_needed'|'no_downtime'|…, message }
     */
    /* 메뉴 항목 사유 (J7: 4항목 고정, 차단이 아닌 항목은 비활성 + 사유) */
    function menuReason(it, ro) {
      if (ro && it.no !== 12) return { active: false, reason: '읽기 전용', why: 'read_only' };
      if (it.st === 'pass') return { active: false, reason: it.no === 12 ? '복원 없음' : '통과', why: 'no_sign_needed' };
      if (it.st === 'na') return { active: false, reason: 'N/A', why: 'no_sign_needed' };
      if (!it.sign || !it.sign.pending) {
        var r = it.no === 7 && it.why !== 'ef_unknown' && it.why !== 'src_unreadable' ? '비상 양식 회수 기록 필요' : it.no === 12 ? '서명으로 해소 불가 (QA 조사)' : '서명으로 해소 불가';
        return { active: false, reason: r, why: 'no_sign_needed' };
      }
      if (!it.sign.effective || !it.sign.roles.length) return { active: false, reason: '규칙 효력 없음', why: 'rule_not_effective' };
      return { active: true, reason: '', why: null };
    }
    function condSignMenu(batchId) {
      var e = evaluate(batchId); if (!e.ok) return e;
      var ro = e.items[11].st === 'block';
      return { ok: true, batchId: e.batchId, readOnly: ro, items: [7, 10, 11, 12].map(function (n) {
        var it = e.items[n - 1], m = menuReason(it, ro);
        return { no: n, label: COND_SIGN_LABEL[n], ruleId: COND_RULES[n], st: it.st, active: m.active, reason: m.reason, why: m.why };
      }) };
    }
    function condSignSpec(batchId, no, o) {
      o = o || {};
      if (no == null || no === '') return condSignMenu(batchId);   /* 4항목 활성 · 사유 */
      no = Number(no);
      if (!COND_RULES[no]) return { ok: false, why: 'bad_no', message: '조건 서명이 없는 조건입니다 (7 · 10 · 11 · 12).' };
      var e = evaluate(batchId); if (!e.ok) return e;
      var it = e.items[no - 1], B = e.batchId, m0 = menuReason(it, e.items[11].st === 'block');
      if (m0.why === 'read_only') return { ok: false, why: 'read_only', message: MSG_READ_ONLY, active: false, reason: m0.reason };
      if (!m0.active && m0.why === 'no_sign_needed') return { ok: false, why: 'no_sign_needed', message: '이 조건은 서명으로 해소할 차단 상태가 아닙니다 (' + m0.reason + ').', active: false, reason: m0.reason, item: it };
      var base = { ok: true, no: no, signRuleId: COND_RULES[no], recordType: COND_REC[no], statementKind: COND_KIND[no], distinctFrom: [] };
      if (no === 7) {
        var cand = it.detail.downtimes.filter(function (d) { return !d.reviewSignatureId; });
        var d = o.dtId ? cand.filter(function (x) { return x.dtId === str(o.dtId); })[0] : cand[0];
        if (!d) return { ok: false, why: 'no_downtime', message: '검토할 다운타임을 찾을 수 없습니다.' };
        var dr = itemsOf(readKey(KEYS.DOWNTIME).v).filter(function (x) { return x && x.dtId === d.dtId; })[0] || {};
        var tb = Array.isArray(dr.transcribedBy) ? dr.transcribedBy : (dr.transcribedBy ? [dr.transcribedBy] : []);
        return Object.assign(base, { key: d.dtId, label: '다운타임 검토 ' + d.dtId, tgt: B + ' · 다운타임 ' + d.dtId, val: d.dtId + ' · EF ' + d.efUsed.length + '매',
          statementCtx: { batchId: B, dtId: d.dtId, n: d.efUsed.length },
          fields: { batchId: B, condNo: 7, dtId: d.dtId, statementKind: COND_KIND[7] },
          distinctFrom: tb.map(function (u) { return { userId: u, label: '다운타임 기록 · 전사자' }; }) });
      }
      if (no === 10) {
        var ci = it.detail;
        /* ⑥ (P-a2, P1): 같은 MBR · 버전의 MBR 승인(SM-APPR-MBR) 서명자 */
        var appr = itemsOf(readKey(KEYS.MBR).v).filter(function (x) { return x && x.kind === 'approve' && str(x.mbrId) === ci.mbr && str(x.ver) === ci.ver; })
          .filter(function (x) { var g = S().ESign.get(x.signatureId); return g && S().ESign.validity(g).state === 'valid'; })
          .map(function (x) { return { userId: x.by, label: 'MBR 승인자' }; });
        return Object.assign(base, { key: ci.mbr + '@' + ci.ver, label: '변경 영향 검토', distinctFrom: appr, tgt: B + ' · 개정 첫 배치 ' + ci.mbr + ' v' + ci.ver, val: ci.ccText,
          statementCtx: { batchId: B, mbr: ci.mbr, ver: ci.ver, cc: ci.cc || '' },
          fields: { batchId: B, condNo: 10, processTreeId: ci.mbr, ver: ci.ver, cc: ci.cc || null, statementKind: COND_KIND[10] } });
      }
      if (no === 11) {
        var ids = it.detail.stale.map(function (x) { return x.signatureId; });
        return Object.assign(base, { key: ids.join(','), label: '통제 강화 평가', tgt: B + ' · 통제 강화 후 기존 값 ' + ids.length + '건', val: ids.length + '건',
          statementCtx: { batchId: B, n: ids.length }, fields: { batchId: B, condNo: 11, staleIds: ids, statementKind: COND_KIND[11] },
          /* ⑥ (P-a2, P0): 바뀐 값의 서명자 본인 — 자기 값 평가 금지 */
          distinctFrom: ids.map(function (id) { var g = S().ESign.get(id); return g ? { userId: g.signerId, label: '바뀐 값 서명자 (' + id + ')' } : null; }).filter(Boolean) });
      }
      var wm = it.detail.watermark || {}, dt = detectText(it.detail.why), basis = (wm.at ? '기준 ' + wm.at + ' · ' : '') + '탐지 ' + (dt || '—');
      return Object.assign(base, { key: String(wm.at || (it.detail.why || []).join(',')), label: '복원 탐지 확인', tgt: B + ' · 복원 탐지 확인', val: basis, detectReason: (it.detail.why || []).slice(),
        statementCtx: { wmAt: wm.at || dt || '—' }, fields: { batchId: B, condNo: 12, wmAt: wm.at || null, statementKind: COND_KIND[12] } });
    }

    /** 화면 버튼 잠금용 (조건 12만 계산) → { readOnly, why:'restore_detected'|'void_chain'|'signature_mismatch'|'src_unreadable'|'eval_error'|null } */
    function readOnly(batchId) {
      var B = str(batchId), s = S();
      if (!s || !s.ESign || !s.ESign.voidState) return { readOnly: true, why: 'no_session' };
      var it = guarded(12, function () { return cond12(B); });
      return { readOnly: it.st === 'block', why: it.st === 'block' ? (it.why || 'eval_error') : null, message: it.st === 'block' ? MSG_READ_ONLY : '', item: it };
    }

    return {
      VERSION: 1, KEYS: clone(KEYS), COND: clone(COND), COND_RULES: clone(COND_RULES), COND_KIND: clone(COND_KIND), COND_REC: clone(COND_REC),
      evaluate: evaluate, item: itemOf, manifestInput: manifestInput, condSignSpec: condSignSpec, condSignMenu: condSignMenu, readOnly: readOnly, MSG_READ_ONLY: MSG_READ_ONLY, COND_SIGN_LABEL: clone(COND_SIGN_LABEL), efText: efText, create: create
    };
  }

  var API = create({});
  global.EbrGateEval = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
