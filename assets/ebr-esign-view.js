/* ebr-esign-view.js — S-42 서명 내역 조회 통합 뷰 (D1-1 · D1-2 · D1-3 · D1-4, DOM 없음 · 읽기 전용)
   전역 window.EbrSignView. 헬퍼 window.EbrUserSession (ebr-user-session.js) 를 먼저 로드할 것.
   - 행 원천은 헬퍼 signHistory (D1-8: 서명 레코드 + 서명 관련 감사, 구조화 필드 우선 · 기존 레코드 R1–R3 추정).
     이 모듈은 그 위에 의미 · 결과 · 사유 한글 라벨, R4(알 수 없음), 의미 조건, 기본 결과 3값, 권한 범위, 상세 · 타임라인 · 검증 · 배치 요약,
     공용 저장소 '미연결' 표시를 더한다.
   - localStorage.setItem 을 부르지 않는다 (조회는 감사하지 않음, P0).
   - 공용 저장소(ebr.esign.v1 · ebr.audit.v1)에 없는 서명은 '미연결'(linkState 'unlinked'):
       ① 공용 헬퍼를 쓰지 않는 화면 → UNLINKED_SCREENS (생산 실행 · 포장 실행 · 출하 게이트는 연결됨 — 현재 빈 목록)
       ② 다른 저장소가 가리키는 signatureId 가 ebr.esign.v1 에 없음(발행 레코드 issueSignature 사본 · 칭량 performed/verified/reweigh) → linkStatus() */
(function (global) {
  'use strict';

  var K = { ESIGN: 'ebr.esign.v1', AUDIT: 'ebr.audit.v1', ISSUED: 'ebr.batch.issued.v1', DISPENSE: 'ebr.dispense.v1',
            EXEC: 'ebr.execRecord.v1', RELEASE: 'ebr.release.v1', MBR: 'ebr.mbrSign.v1', MATLOT: 'ebr.materialLot.v1' };
  var RESULTS = ['signed', 'failed', 'locked', 'cancelled', 'rolledback'];
  var DEFAULT_RESULTS = ['signed', 'failed', 'locked'];   /* 확정 Q8 — 기본 체크 */
  var RESULT_LABEL = { signed: '성공', failed: '실패', locked: '잠금', cancelled: '취소', rolledback: '롤백' };
  var MEANING = {   /* GCM EBR_SIGN_MEANING 과 같은 값 (설계 §2.2). 색은 화면이 --c-sign-* 토큰으로 매핑 */
    performed: { ko: '수행', en: 'Performed by', token: '--c-sign-performed' },
    verified: { ko: '확인', en: 'Verified by', token: '--c-sign-verified' },
    approved: { ko: '승인', en: 'Approved by', token: '--c-sign-approved' },
    read_understood: { ko: '읽고 이해함', en: 'Read & Understood', token: '--c-sign-read-understood' },
    reviewed: { ko: '검토', en: 'Reviewed by', token: '--c-sign-reviewed' }
  };
  var WHY_LABEL = {   /* 헬퍼 MSG 와 같은 의미 (D1-2) */
    bad_password: '비밀번호 불일치', locked: '계정 잠김', inactive: '비활성 사용자', not_current_user: '현재 사용자와 다른 ID',
    allowed_roles_unset: '허용 역할 미설정', role_denied: '서명 권한 없는 역할', same_person: '동일인 서명 불가', unknown_user: '미등록 ID',
    cancel: '사용자 취소', error: '오류로 취소', precheck_changed: '사전 확인 값 변경', save_error: '저장 실패'
  };
  var RECORD_TYPE_LABEL = { batch_issue: '배치 발행', weigh_value: '칭량 값', weigh_reweigh: '재칭량 승인', 'weigh_*': '칭량 (구분 불가)',
    step_value: '단계 실행 값', batch_review: '배치 기록 검토', rbe_exception: 'RBE 예외 검토', audit_trail: '감사추적 검토',
    release: '출하 승인', briefing: '변경점 브리핑', mbr_approval: 'MBR 승인', material_qc: '자재 QC 판정',
    downtime_review: '다운타임 검토', change_impact: '변경 영향 검토', control_eval: '통제 강화 평가', integrity_ack: '복원 탐지 확인',
    tree_route: '트리 경로 승인', deviation_close: '일탈 종결' };
  /* 고아 서명 판정 대상 (실행 · 출하 서명) — 가리키는 기록(실행 · 출하 · MBR 서명 · LOT 판정)이 없으면 고아 */
  var ORPHAN_RECORD_TYPES = ['step_value', 'batch_review', 'rbe_exception', 'audit_trail', 'release', 'briefing', 'mbr_approval', 'material_qc'];
  var ORPHAN_LABEL = '실행 기록 없음(데모 초기화)';
  var UNKNOWN_RECORD_TYPE = '알 수 없음';   /* R4 */
  var UNLINKED_LABEL = '미연결';
  var UNLINKED_MESSAGE = '공용 저장소 미연결 — 이 화면의 서명은 공용 저장소(ebr.esign.v1 · ebr.audit.v1)에 기록되지 않아 조회 대상이 아닙니다 (P1 이관).';
  /* 생산 실행 · 포장 실행 · 출하 게이트는 공용 저장소로 연결됨 (EbrExecSign) — 남은 미연결 화면 없음. 구조는 유지 */
  var UNLINKED_SCREENS = [].map(function (s) { s.linkState = 'unlinked'; s.linkLabel = UNLINKED_LABEL; s.message = UNLINKED_MESSAGE; return s; });
  var SCOPE_BY_ROLE = {   /* 설계 §3.8 · 확정 Q6 (ADMIN 전체 읽기 · 인쇄 가능 · CSV 불가). canExport 는 P1 CSV 용 표시값 */
    QP: { scope: 'all', canPrint: true, canExport: true }, QA: { scope: 'all', canPrint: true, canExport: true },
    SV: { scope: 'all', canPrint: true, canExport: false }, OP: { scope: 'own', canPrint: true, canExport: false },
    ADMIN: { scope: 'all', canPrint: true, canExport: false }
  };
  var NO_SCOPE_MESSAGE = '조회 권한이 없습니다 — 상단에서 사용자를 선택하세요';

  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function normId(v) { return String(v == null ? '' : v).trim().toUpperCase(); }

  function create(opts) {
    opts = opts || {};
    function U() { return opts.session || global.EbrUserSession || null; }
    function storage() { return opts.storage || global.localStorage; }
    function readJson(k, dflt) { try { var s = storage(); var raw = s ? s.getItem(k) : null; if (raw == null) return dflt; var v = JSON.parse(raw); return v == null ? dflt : v; } catch (e) { return dflt; } }
    function readArr(k) { var v = readJson(k, []); return Array.isArray(v) ? v : (v && Array.isArray(v.items) ? v.items : []); }
    function issuedList() { return readArr(K.ISSUED); }
    function issuedRec(batchId) { var id = String(batchId || ''); return issuedList().filter(function (b) { return b && String(b.batchId) === id; })[0] || null; }

    /* ---- D1-4 권한 범위 */
    /* 사용자 · 역할은 ebmr.userRole.v1 을 직접 읽는다 (헬퍼 getUser 는 저장소가 비면 시드를 쓰므로 읽기 전용 보장 위해 쓰지 않음) */
    function userOf(id) {
      var o = readJson('ebmr.userRole.v1', null), k = normId(id);
      if (!o || !Array.isArray(o.users)) return null;
      var u = o.users.filter(function (x) { return x && normId(x.userId) === k; })[0];
      if (!u) return null;
      var roles = (Array.isArray(o.userRoles) ? o.userRoles : []).filter(function (r) { return r && normId(r.userId) === k; }).map(function (r) { return r.roleCode; });
      return { userId: u.userId, name: u.name || '', status: u.status || 'active', lockedAt: u.lockedAt || null, roles: roles };
    }
    function viewScope(userId) {
      var cur = readJson('ebmr.currentUser.v1', null);
      var id = userId != null ? String(userId) : (cur && cur.userId ? String(cur.userId) : '');
      var none = function (why) { return { ok: false, scope: 'none', userId: id || null, role: null, canPrint: false, canExport: false, why: why, message: NO_SCOPE_MESSAGE }; };
      if (!id) return none('no_current_user');
      var usr = userOf(id);
      if (!usr) return none('unknown_user');
      if (usr.status === 'locked' || usr.lockedAt) return none('locked');
      if (usr.status !== 'active') return none('inactive');
      var order = (U() && U().ROLE_PRIORITY) || ['QP', 'QA', 'SV', 'OP', 'ADMIN'];
      var pri = order.filter(function (r) { return usr.roles.indexOf(r) >= 0 && SCOPE_BY_ROLE[r]; })[0];
      if (!pri) return none('no_role');
      var s = SCOPE_BY_ROLE[pri];
      return { ok: true, scope: s.scope, userId: usr.userId, name: usr.name, role: pri, roles: usr.roles.slice(), canPrint: s.canPrint, canExport: s.canExport, signerLocked: s.scope === 'own' };
    }

    /* ---- D1-2 · D1-3 행 꾸밈 (signHistory 행 → 화면 행 모델) */
    function whyLabel(r) {
      if (!r.why) return '';
      var base = WHY_LABEL[r.why] || r.why;
      if (r.why === 'bad_password') { var m = /실패\s*(\d+)\s*\/\s*(\d+)/.exec(String(r.val || '')); if (m) base += ' ' + m[1] + '/' + m[2]; }
      return base;
    }
    function decorate(r0) {
      var r = clone(r0), sig = r.source === 'esign' && U() ? U().ESign.get(r.signatureId) : null;
      r.estimated = Array.isArray(r.estimated) ? r.estimated.slice() : [];
      if (r.source === 'audit' && !r.recordType) { r.r4 = true; if (r.estimated.indexOf('recordType') < 0) r.estimated.push('recordType'); }   /* R4 */
      var mm = MEANING[r.meaning] || null;
      r.meaningText = (sig && sig.meaningText) || r.meaningText || (mm ? mm.ko : '');
      r.meaningTextEn = (sig && sig.meaningTextEn) || (mm ? mm.en : '');
      r.meaningToken = mm ? mm.token : null;
      r.resultLabel = RESULT_LABEL[r.result] || r.result;
      r.recordTypeLabel = r.recordType ? (RECORD_TYPE_LABEL[r.recordType] || r.recordType) : UNKNOWN_RECORD_TYPE;
      r.signerDisplayName = r.registered === false ? '미등록 ID' : (r.signerName || '');   /* 확정 Q9: ID 는 원문 그대로 */
      if (sig && !r.signerRole) r.signerRole = sig.signerRole || '';
      r.whyLabel = whyLabel(r);
      r.status = r.source === 'esign' ? ((sig && sig.status) || 'valid') : '';   /* 확정 Q10 */
      r.orderLabel = r.orderNo || '오더 미연결';
      r.targetRef = r.recordType === 'batch_issue'
        ? (sig ? [sig.processTreeId ? sig.processTreeId + ' v' + sig.ver : '', sig.manifestId || ''].filter(Boolean).join(' · ') : (r.batchId || r.batchHint || ''))
        : (r.dispenseId || (sig && sig.dispenseId) || '');
      r.batchLabel = r.batchId || (r.batchHint ? r.batchHint + ' (미발행 배치)' : '');
      r.linkState = 'linked';   /* 공용 저장소에서 온 행 */
      r.estimatedLabel = r.estimated.length ? '(추정)' : '';
      var st = statementOf(sig); r.statement = st.statement; r.statementSource = st.statementSource;
      return r;
    }
    /* 서명 문장: 서명 레코드 statement(서명 창 원문)가 있으면 그대로 'original', 없으면(기존 레코드) 헬퍼 builder 로 다시 조립 'reconstructed'.
       재구성 근거: 발행 = 서명 레코드(processTreeId · ver · contentHash · batchId) + 발행 기록 size, 칭량 = 서명 레코드 recId 의 칭량 기록(자재 · LOT · 순중량 · 판정 · 수행자 · 폐기 사유).
       서명 레코드가 없는 행(감사만 — 실패 · 잠금 · 취소 · 롤백)과 문장 kind 가 없는 서명은 { statement: null, statementSource: null } */
    function statementOf(sig) {
      if (!sig) return { statement: null, statementSource: null };
      if (typeof sig.statement === 'string' && sig.statement) return { statement: sig.statement, statementSource: 'original' };
      var u = U(), kind = u && u.statementKindOf ? u.statementKindOf(sig) : '';
      if (!kind || /^balance_check/.test(kind)) return { statement: null, statementSource: null };   /* 저울 점검 서명: 원문만 (재구성 안 함) */
      var c;
      if (kind === 'batch_issue') {
        var b = issuedRec(sig.batchId);
        c = { processTreeId: sig.processTreeId, ver: sig.ver, contentHash: sig.contentHash, batchId: sig.batchId, size: b ? b.size : null };
      } else {
        var d = readArr(K.DISPENSE).filter(function (x) { return x && ((sig.recId && x.recId === sig.recId) || (!sig.recId && sig.dispenseId && x.dispenseId === sig.dispenseId)); })[0] || {};
        var pf = d.performed || {};
        c = { batchId: sig.batchId || d.batchId, lineId: sig.lineId || d.lineId, materialId: d.materialId, lotNo: d.lotNo, dispenseId: sig.dispenseId || d.dispenseId,
              net: d.net, uom: d.uom, judge: d.judge, performerName: pf.name, performerId: pf.userId, voidReason: d.voidReason };
      }
      return { statement: u.signStatement(kind, c), statementSource: 'reconstructed' };
    }

    /* 권한: 항상 viewScope(o.userId) 로 다시 판정한다. o.scope 는 좁히기만 허용(all → own) — 넓히기 · 다른 사용자로 바꾸기는 무시 (코드 리뷰) */
    function scopeOrFail(o) {
      var real = viewScope(o && o.userId), req = o && o.scope;
      if (!real.ok || !req) return real;
      var want = typeof req === 'string' ? req : req.scope;
      if (want === 'none') return { ok: false, scope: 'none', userId: real.userId, role: real.role, canPrint: false, canExport: false, why: 'scope_none', message: NO_SCOPE_MESSAGE };
      if (want === 'own' && real.scope === 'all') { var n = clone(real); n.scope = 'own'; n.signerLocked = true; n.narrowed = true; return n; }
      return real;
    }
    /* ---- D1-1 query(filter, o?) → { ok, total, rows, legacy, scope, applied, unlinked }
       filter: signHistory 조건(batchId · lineId · recordType · signerId · signRuleId · from · to · order · offset · limit) + orderNo (부분 일치 · 대소문자 무시)
               + meaning (문자열 | 배열) + result (생략 시 기본 3값, 'all' 이면 5값)
       o.userId: 권한 판정 사용자(기본 현재 사용자) — OP 는 signerId 를 본인으로 고정 */
    function query(filter, o) {
      var u = U(); var f = clone(filter || {}) || {};
      var sc = scopeOrFail(o);
      if (!u) return { ok: false, why: 'no_helper', total: 0, rows: [], scope: sc };
      if (!sc.ok) return { ok: false, why: sc.why, message: sc.message, total: 0, rows: [], legacy: 0, scope: sc, unlinked: clone(UNLINKED_SCREENS) };
      if (sc.scope === 'own') f.signerId = sc.userId;
      if (f.result === undefined || f.result === null || f.result === '') f.result = DEFAULT_RESULTS.slice();
      else if (f.result === 'all') f.result = RESULTS.slice();
      var off = Math.max(0, parseInt(f.offset, 10) || 0), lim = parseInt(f.limit, 10);
      var base = clone(f); delete base.offset; delete base.limit; delete base.meaning; delete base.orderNo;
      var h = u.signHistory(base);
      var mF = f.meaning == null || f.meaning === '' ? null : (Array.isArray(f.meaning) ? f.meaning : [f.meaning]);
      var oQ = f.orderNo == null ? '' : String(f.orderNo).trim().toUpperCase();   /* 오더: 부분 일치 · 대소문자 무시 (batches 와 같은 규칙) */
      var rows = h.rows.filter(function (r) { return (!mF || mF.indexOf(r.meaning) >= 0) && (!oQ || String(r.orderNo || '').toUpperCase().indexOf(oQ) >= 0); });
      var total = rows.length;
      rows = (lim > 0 ? rows.slice(off, off + lim) : rows.slice(off)).map(decorate);
      return { ok: true, total: total, rows: rows, legacy: h.legacy, scope: sc, applied: f, unlinked: clone(UNLINKED_SCREENS) };
    }

    function allRows(sc) { var q = query({ result: 'all' }, { userId: sc.userId, scope: sc }); return q.ok ? q.rows : []; }
    function findRow(rowId, sc) { return allRows(sc).filter(function (r) { return r.rowId === rowId; })[0] || null; }

    /* get(rowId, o?) → { ok, row, record, issue, statement, statementSource } — record 는 원본(서명 레코드 또는 감사 1건) 사본
       statement · statementSource: 행(row)과 같은 값 — 'original'(서명 레코드 원문) | 'reconstructed'(builder 재구성) | null(서명 레코드 없는 행)
       issue: 행 배치의 발행 기록 요약 { batchId, size, line } (발행 기록 값 그대로, 필드 없으면 null) · 발행 기록이 없으면(또는 배치 없는 행) null */
    function issueOf(batchId) {
      var b = batchId ? issuedRec(batchId) : null;
      if (!b) return null;
      return { batchId: String(b.batchId), size: b.size == null || b.size === '' ? null : b.size, line: b.line == null || b.line === '' ? null : String(b.line) };
    }
    function get(rowId, o) {
      var sc = scopeOrFail(o); if (!sc.ok) return { ok: false, why: sc.why, message: sc.message };
      var r = findRow(rowId, sc); if (!r) return { ok: false, why: 'not_found' };
      var rec = r.source === 'esign' ? U().ESign.get(r.signatureId) : clone(readArr(K.AUDIT).filter(function (a) { return a && a.auditId === r.auditId; })[0] || null);
      return { ok: true, row: r, record: rec, issue: issueOf(r.batchId), statement: r.statement, statementSource: r.statementSource };
    }

    /* timeline(rowId, o?) → { ok, approx:true, entries } — 같은 tgt 감사 중 가장 가까운 앞선 *_SIGN_OPEN 부터 이 행 이후 첫 업무 결과(BATCH_ISSUED · 취소 · 롤백 · 잠금 · 칭량 결과)까지,
       다음 *_SIGN_OPEN 전에서 끊음 (시도 ID 없음 → 근사, 설계 §3.5 ⑤) */
    function timeline(rowId, o) {
      var g = get(rowId, o); if (!g.ok) return g;
      var list = readArr(K.AUDIT), pos = -1, tgt = '';
      for (var i = 0; i < list.length; i++) {
        var a = list[i]; if (!a) continue;
        if (g.row.source === 'audit' ? a.auditId === g.row.auditId : (a.act === 'ESIGN_SIGNED' && String(a.val || '').indexOf(g.row.signatureId) >= 0)) { pos = i; tgt = a.tgt || ''; break; }
      }
      if (pos < 0) return { ok: true, approx: true, entries: [], note: '연결 감사 없음' };
      var cur = pos;
      /* USER_LOCKED 는 tgt 가 사용자라 시도와 문자열이 다름 — 바로 앞(같은 setItem)의 같은 사람 ESIGN_AUTH_FAIL 시도에 붙인다 */
      var lockAfter = function (i) { var n2 = list[i + 1]; return n2 && n2.act === 'USER_LOCKED' && list[i] && list[i].act === 'ESIGN_AUTH_FAIL' && normId(n2.uid) === normId(list[i].uid) ? i + 1 : -1; };
      if (list[pos].act === 'USER_LOCKED' && pos > 0 && lockAfter(pos - 1) === pos) { pos = pos - 1; tgt = list[pos].tgt || ''; }
      var same = function (a) { return a && (a.tgt || '') === tgt; };
      var terminal = function (a) { return /^(BATCH_ISSUED|USER_LOCKED)$|_SIGN_CANCEL$|_ROLLBACK$|^DISPENSE_(VERIFIED|REDO)$/.test(a.act); };
      var idx = [];
      for (var j = pos; j >= 0; j--) { if (!same(list[j])) continue; idx.unshift(j); if (/_SIGN_OPEN$/.test(list[j].act)) break; }
      if (!terminal(list[pos])) {
        for (var k = pos + 1; k < list.length; k++) { if (!same(list[k])) continue; if (/_SIGN_OPEN$/.test(list[k].act)) break; idx.push(k); if (terminal(list[k])) break; }
      }
      idx.slice().forEach(function (i) { var l2 = lockAfter(i); if (l2 >= 0 && idx.indexOf(l2) < 0) idx.push(l2); });
      idx.sort(function (x, y) { return x - y; });
      var entries = idx.map(function (i) {
        var a = list[i];
        return { auditId: a.auditId, at: a.at, uid: a.uid, userName: a.userName || '', act: a.act, why: a.why || '', whyLabel: whyLabel(a), val: a.val || '', before: clone(a.before), after: clone(a.after), current: i === cur };
      });
      return { ok: true, approx: true, entries: entries, note: '시도 ID 없음 — 시각 · tgt 로 묶은 근사값' };
    }

    /* verify(rowId, o?) → { ok, state:'match'|'mismatch'|'unverifiable'|'n/a', mismatches, copy } */
    function verifyRow(r) {
      if (r.source !== 'esign') return { ok: true, state: 'n/a', mismatches: [] };
      var sig = U().ESign.get(r.signatureId);
      if (!sig) return { ok: true, state: 'unverifiable', mismatches: [], message: '검증 불가 — 서명 레코드 없음' };
      if (sig.recordType === 'batch_issue') {
        var b = issuedRec(sig.batchId);
        if (!b) { var self = U().ESign.verify(sig); return { ok: true, state: self.ok ? 'unverifiable' : 'mismatch', mismatches: self.mismatches, message: '검증 불가 — 대상 레코드 없음' }; }
        var v = U().ESign.verify(sig, b), mm = v.mismatches.slice(), cp = b.issueSignature || null, copy = null;
        if (cp) { copy = { signatureId: cp.signatureId === sig.signatureId, signatureHash: cp.signatureHash === sig.signatureHash }; if (!copy.signatureId) mm.push('copy.signatureId'); if (!copy.signatureHash) mm.push('copy.signatureHash'); }
        return { ok: true, state: mm.length ? 'mismatch' : 'match', mismatches: mm, copy: copy };
      }
      var s2 = U().ESign.verify(sig);   /* 칭량 등: signatureHash 자기 검증만 (valueHash 재계산은 P1 D1-9) */
      return { ok: true, state: s2.ok ? 'match' : 'mismatch', mismatches: s2.mismatches, note: 'signatureHash 자기 검증 (값 재계산 P1)' };
    }
    function verify(rowId, o) { var g = get(rowId, o); if (!g.ok) return g; return verifyRow(g.row); }

    /* linkStatus(filter?) → { ok, linked, unlinked:[{source, ref, batchId, signatureId, linkState:'unlinked', linkLabel:'미연결'}], screens }
       다른 저장소가 가리키는 signatureId 가 ebr.esign.v1 에 없으면 미연결 */
    function linkStatus(filter) {
      var f = filter || {}, have = {}, linked = 0, out = [];
      readArr(K.ESIGN).forEach(function (s) { if (s && s.signatureId) have[s.signatureId] = true; });
      var check = function (source, ref, batchId, sid, extra) {
        if (!sid) return;
        if (f.batchId && String(batchId) !== String(f.batchId)) return;
        if (have[sid]) { linked++; return; }
        var e = { source: source, ref: ref, batchId: batchId || null, signatureId: sid, linkState: 'unlinked', linkLabel: UNLINKED_LABEL };
        if (extra) Object.keys(extra).forEach(function (k) { e[k] = extra[k]; });
        out.push(e);
      };
      issuedList().forEach(function (b) { if (b && b.issueSignature) check('issued', b.batchId, b.batchId, b.issueSignature.signatureId, { kind: 'issue' }); });
      readArr(K.DISPENSE).forEach(function (r) {
        if (!r) return;
        ['performed', 'verified', 'reweigh'].forEach(function (k) { if (r[k] && r[k].signatureId) check('dispense', r.dispenseId || r.recId, r.batchId, r[k].signatureId, { kind: k, lineId: r.lineId || null }); });
      });
      return { ok: true, linked: linked, unlinked: out, screens: clone(UNLINKED_SCREENS) };
    }

    /* batchSummary(batchId, o?) → 배치 서명 요약 (설계 §3.6, 칭량 카드는 P1 → weighing:null) */
    function batchSummary(batchId, o) {
      var sc = scopeOrFail(o); if (!sc.ok) return { ok: false, why: sc.why, message: sc.message, unlinkedScreens: clone(UNLINKED_SCREENS) };
      var bid = String(batchId || ''), rows = query({ batchId: bid, result: 'all' }, { userId: sc.userId, scope: sc }).rows;
      var byResult = {}; RESULTS.forEach(function (k) { byResult[k] = 0; });
      var byMeaning = {}, mismatch = 0;
      rows.forEach(function (r) {
        byResult[r.result] = (byResult[r.result] || 0) + 1;
        if (r.result === 'signed') { byMeaning[r.meaning || ''] = (byMeaning[r.meaning || ''] || 0) + 1; if (verifyRow(r).state === 'mismatch') mismatch++; }
      });
      var b = issuedRec(bid), issueSig = null, issueLink = null;
      if (b && b.issueSignature) {
        var real = U().ESign.get(b.issueSignature.signatureId);
        issueLink = real ? 'linked' : 'unlinked';
        issueSig = { signatureId: b.issueSignature.signatureId, linkState: issueLink, linkLabel: real ? '' : UNLINKED_LABEL,
                     line: U().formatSignLine ? U().formatSignLine(real || b.issueSignature) : '' };
      }
      var issueSigned = rows.filter(function (r) { return r.result === 'signed' && r.recordType === 'batch_issue'; }).length;
      return { ok: true, batchId: bid, issued: !!b,
               issueApproval: { done: issueSigned > 0 ? 1 : 0, total: 1, signature: issueSig },
               signedByMeaning: byMeaning, byResult: byResult, mismatches: mismatch,
               weighing: null, unlinkedRefs: linkStatus({ batchId: bid }).unlinked, unlinkedScreens: clone(UNLINKED_SCREENS), scope: sc };
    }

    /* ---- §7-1 J9 배치 선택 팝업 목록: batches(filter?, o?) → { ok, total, rows, scope, source:'issued', applied }
       출처: 발행 기록(읽기 전용). filter: batchId · orderNo (부분 일치, 대소문자 무시) · from · to (발행일 YYYY-MM-DD KST, 양끝 포함) · offset · limit
       행: { batchId, orderNo, processTreeId, ver, issuedAt, issuedAtText, issueSignature: { signatureId, line, linkState, linkLabel } | null }
       권한: 조회 불가(scope none)면 목록 없음(화면 검색 비활성과 같음). OP(own)도 배치 목록은 전부 — 본인 고정은 서명자 조건에만 적용 */
    function dayBound(v, end) {
      if (!v) return null;
      var str = String(v);
      if (/^\d{4}-\d{2}-\d{2}$/.test(str)) str += end ? 'T23:59:59.999+09:00' : 'T00:00:00+09:00';
      var t = Date.parse(str);
      return isNaN(t) ? null : t;
    }
    function batches(filter, o) {
      var f = clone(filter || {}) || {}, sc = scopeOrFail(o), u = U();
      if (!sc.ok) return { ok: false, why: sc.why, message: sc.message, total: 0, rows: [], scope: sc, source: 'issued' };
      var has = function (v, q) { return !q || String(v == null ? '' : v).toUpperCase().indexOf(String(q).trim().toUpperCase()) >= 0; };
      var lo = dayBound(f.from, false), hi = dayBound(f.to, true);
      var seen = {}, rows = issuedList().filter(function (b) {
        if (!b || !b.batchId || seen[b.batchId]) return false;
        seen[b.batchId] = true;
        if (!has(b.batchId, f.batchId) || !has(b.orderNo, f.orderNo)) return false;
        if (lo != null || hi != null) { var t = Date.parse(b.issuedAt || ''); if (isNaN(t) || (lo != null && t < lo) || (hi != null && t > hi)) return false; }
        return true;
      }).map(function (b) {
        var cp = b.issueSignature || null, sig = null;
        if (cp && cp.signatureId) {
          var real = u && u.ESign ? u.ESign.get(cp.signatureId) : null;
          sig = { signatureId: cp.signatureId, line: u && u.formatSignLine ? u.formatSignLine(real || cp) : '',
                  linkState: real ? 'linked' : 'unlinked', linkLabel: real ? '' : UNLINKED_LABEL };
        }
        return { batchId: String(b.batchId), orderNo: b.orderNo || '', processTreeId: b.processTreeId || '', ver: b.ver == null ? '' : String(b.ver),
                 issuedAt: b.issuedAt || '', issuedAtText: b.issuedAt && u && u.fmtKst ? u.fmtKst(b.issuedAt) : (b.issuedAt || ''), issueSignature: sig };
      });
      rows.sort(function (a, b) { var ta = Date.parse(a.issuedAt) || 0, tb = Date.parse(b.issuedAt) || 0; return tb - ta || (a.batchId < b.batchId ? 1 : a.batchId > b.batchId ? -1 : 0); });   /* 최근 발행 먼저 */
      var total = rows.length, off = Math.max(0, parseInt(f.offset, 10) || 0), lim = parseInt(f.limit, 10);
      return { ok: true, total: total, rows: lim > 0 ? rows.slice(off, off + lim) : rows.slice(off), scope: sc, source: 'issued', applied: f };
    }

    /* ---- S-42 고아 서명 (읽기 전용)
       signatureRefs() → { ok:true, count, refs:{ [signatureId]: [{ store, ref }] } }
         store: 'execRecord'(ref = batchId · scope · stepKey · slot) | 'release'(batchId) | 'mbrSign'(mbrId · ver · kind) | 'materialLot'(lotNo)
       isOrphan(sigIdOrRow, refs?) → boolean — ebr.esign.v1 에 있는 서명 중 recordType ∈ ORPHAN_RECORD_TYPES 이고 어느 기록도 가리키지 않으면 true.
         행(row)을 넘기면 source 'esign' 행만 대상. 없는 서명 · 다른 recordType(발행 · 칭량 등) → false. refs 를 넘기면 다시 읽지 않음(목록 렌더용).
       orphans(o?) → { ok, total, rows:[{ signatureId, recordType, recordTypeLabel, batchId, signerId, at, status }] } — 권한 범위(viewScope) 적용 */
    function signatureRefs() {
      var m = {}, n = 0;
      function add(sid, store, ref) { if (!sid) return; if (!m[sid]) { m[sid] = []; n++; } m[sid].push({ store: store, ref: ref }); }
      readArr(K.EXEC).forEach(function (x) { if (x) add(x.signatureId, 'execRecord', [x.batchId, x.scope, x.stepKey, x.slot].filter(function (v) { return v != null && v !== ''; }).join(' · ')); });
      readArr(K.RELEASE).forEach(function (x) { if (x) add(x.signatureId, 'release', String(x.batchId || '')); });
      readArr(K.MBR).forEach(function (x) { if (x) add(x.signatureId, 'mbrSign', [x.mbrId, x.ver, x.kind].filter(function (v) { return v != null && v !== ''; }).join(' · ')); });
      readArr(K.MATLOT).forEach(function (x) { if (x) add(x.judgeSignatureId, 'materialLot', String(x.lotNo || '')); });
      return { ok: true, count: n, refs: m };
    }
    function sigById(id) { return readArr(K.ESIGN).filter(function (x) { return x && x.signatureId === id; })[0] || null; }
    function isOrphan(x, refs) {
      var sid, rt;
      if (x && typeof x === 'object') { if (x.source !== 'esign' || !x.signatureId) return false; sid = x.signatureId; rt = x.recordType; if (!sigById(sid)) return false; }
      else { sid = String(x == null ? '' : x); var sg = sid ? sigById(sid) : null; if (!sg) return false; rt = sg.recordType; }
      if (ORPHAN_RECORD_TYPES.indexOf(rt) < 0) return false;
      var r = (refs && refs.refs) || refs || signatureRefs().refs;
      return !r[sid];
    }
    function orphans(o) {
      var sc = scopeOrFail(o); if (!sc.ok) return { ok: false, why: sc.why, message: sc.message, total: 0, rows: [] };
      var refs = signatureRefs().refs, rows = [];
      readArr(K.ESIGN).forEach(function (g) {
        if (!g || ORPHAN_RECORD_TYPES.indexOf(g.recordType) < 0 || refs[g.signatureId]) return;
        if (sc.scope === 'own' && normId(g.signerId) !== normId(sc.userId)) return;
        rows.push({ signatureId: g.signatureId, recordType: g.recordType, recordTypeLabel: RECORD_TYPE_LABEL[g.recordType], batchId: g.batchId || null, signerId: g.signerId || '', at: g.at || g.signedAt || '', status: g.status || '' });
      });
      return { ok: true, total: rows.length, rows: rows, label: ORPHAN_LABEL };
    }

    return {
      VERSION: 1, KEYS: clone(K), RESULTS: RESULTS.slice(), DEFAULT_RESULTS: DEFAULT_RESULTS.slice(), RESULT_LABEL: clone(RESULT_LABEL),
      MEANING: clone(MEANING), WHY_LABEL: clone(WHY_LABEL), RECORD_TYPE_LABEL: clone(RECORD_TYPE_LABEL), UNKNOWN_RECORD_TYPE: UNKNOWN_RECORD_TYPE,
      ORPHAN_RECORD_TYPES: ORPHAN_RECORD_TYPES.slice(), ORPHAN_LABEL: ORPHAN_LABEL, signatureRefs: signatureRefs, isOrphan: isOrphan, orphans: orphans,
      UNLINKED_LABEL: UNLINKED_LABEL, UNLINKED_MESSAGE: UNLINKED_MESSAGE, UNLINKED_SCREENS: clone(UNLINKED_SCREENS), SCOPE_BY_ROLE: clone(SCOPE_BY_ROLE),
      viewScope: viewScope, query: query, get: get, timeline: timeline, verify: verify, batchSummary: batchSummary, linkStatus: linkStatus, batches: batches,
      whyLabel: whyLabel, create: create
    };
  }

  var API = create({});
  global.EbrSignView = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : this);
