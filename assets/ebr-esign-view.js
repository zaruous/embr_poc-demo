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
    tree_route: '트리 경로 승인', deviation_close: '일탈 종결', correction: '정정' };
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
    /* D1-7e: 내보내기 동안만 서명 레코드 · 칭량 기록을 1회 읽어 재사용 (행마다 저장소 전체 JSON.parse 방지). 평소 조회는 기존대로 */
    var bulk = null;
    function sigGet(id) { return bulk ? (bulk.sigs[id] || null) : U().ESign.get(id); }
    function dispenseList() { return bulk ? bulk.dispense : readArr(K.DISPENSE); }
    function issuedList() { return bulk ? bulk.issued : readArr(K.ISSUED); }
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
      var r = clone(r0), sig = r.source === 'esign' && U() ? sigGet(r.signatureId) : null;
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
        var d = dispenseList().filter(function (x) { return x && ((sig.recId && x.recId === sig.recId) || (!sig.recId && sig.dispenseId && x.dispenseId === sig.dispenseId)); })[0] || {};
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

    /* ---- DC-08 서명 CSV 내보내기 (D1-7a ~ D1-7d, DOM 없음 · 파일 저장은 화면)
       exportRows(filter, o?) → { ok:true, total, columns, columnsKo, rows:[[27값]], applied, scope, unlinkedRefCount }
                              | { ok:false, why:'no_current_user'|'unknown_user'|'locked'|'inactive'|'no_role'|'scope_none'|'no_helper'|'not_current_user'|'export_denied'|'too_many_rows', message, total?, limit? }
       toCsv(rows, meta) → { text(BOM 포함), rowCount, guarded }
       exportCsv(filter, o?) → { ok:true, text, fileName, mimeType, rowCount, guarded, fileHash, bytes, columns, auditId, exportedAt, message }
                             | { ok:false, why(위 값 + 'no_rows'|'audit_failed'), message, alertType? } — 감사 실패면 파일 없음(fail-closed)
       권한: 매번 viewScope 재판정(scopeOrFail) + canExport(QP · QA). 내보내는 사람 = 현재 사용자 (o.userId 가 다르면 거부) */
    var CSV_COLUMNS = ['row_id', 'source', 'result', 'result_ko', 'signed_at', 'meaning', 'meaning_ko', 'meaning_en', 'signer_id', 'signer_name', 'signer_role',
      'record_type', 'record_type_ko', 'batch_id', 'order_no', 'target_ref', 'sign_rule', 'reason', 'statement', 'statement_source', 'signature_id', 'signature_hash',
      'verify_state', 'status', 'link', 'estimated', 'screen'];
    var CSV_COLUMNS_KO = ['행 ID', '원천', '결과 코드', '결과', '일시', '의미 코드', '의미', '의미(영문)', '서명자 ID', '서명자 이름', '서명 역할',
      '대상 유형 코드', '대상 유형', '배치 ID', '오더', '대상', '규칙', '사유', '서명 문장', '문장 출처', '서명 ID', '서명 해시', '검증', '상태', '연결', '추정 필드', '화면'];
    var CSV_ROW_LIMIT = 10000;
    var CSV_EXPORT_ACT = 'ESIGN_EXPORT';
    var CSV_SCREEN = 's-ebr-esign-history-ui';
    var CSV_MSG = {
      export_denied: 'CSV 내보내기는 QP · QA만 할 수 있습니다', no_rows: '내보낼 행이 없습니다', busy: 'CSV를 만드는 중입니다',
      not_current_user: '현재 사용자만 내보낼 수 있습니다', audit_failed: '내보내기 감사 기록에 실패해 파일을 만들지 않았습니다.', no_helper: '서명 헬퍼가 없어 내보낼 수 없습니다'
    };
    function tooManyMessage(n) { return '10,000행을 넘습니다 (' + Number(n).toLocaleString('en-US') + '행) — 조건을 좁히세요'; }
    function csvTime(v, est) {
      var s = v == null ? '' : String(v);
      if (!s || /[+-]\d{2}:\d{2}$/.test(s)) return s;
      var d = new Date(s); if (isNaN(d.getTime())) return s;
      if (est.indexOf('at') < 0) est.push('at');
      return U().nowIsoLocal(d);
    }
    /* D1-7d 연결 열 — 무효 기록(voidOf) · 정정(ebr.correction.v1 읽기 전용). 형식 키=값; (확정 D-7, void_reason 맨 끝) */
    function correctionIndex() {
      var perf = {}, ver = {};
      readArr('ebr.correction.v1').forEach(function (c) {
        if (!c || !c.correctionId) return;
        if (c.performed && c.performed.signatureId) perf[c.performed.signatureId] = c;
        if (c.verified && c.verified.signatureId) ver[c.verified.signatureId] = c;
      });
      return { perf: perf, ver: ver };
    }
    function linkOf(sid, vrec, ci) {
      var parts = [];
      if (vrec) {
        parts.push('void=' + vrec.voidId);
        if (vrec.correctionId) { parts.push('correction=' + vrec.correctionId); if (vrec.viaSignatureId) parts.push('via=' + vrec.viaSignatureId); }
        else parts.push('void_at=' + (vrec.at || ''), 'void_by=' + (vrec.by || ''), 'void_reason=' + (vrec.reason || ''));
      }
      var cp = ci.perf[sid], cv = ci.ver[sid];
      if (cp) parts.unshift('correction=' + cp.correctionId + ';role=perform;orig=' + (cp.origSignatureIds || []).join(','));
      if (cv) parts.unshift('correction=' + cv.correctionId + ';role=verify;voided=' + (cv.voidIds || []).join(','));
      return parts.join(';');
    }
    /* D1-7e 묶음 검증 — 행마다 voidState(감사 전체 읽기)를 다시 계산하지 않도록 1회 계산 결과를 재사용 (헬퍼 validity 와 같은 판정) */
    function bulkValidity(u) {
      var vs = u.ESign.voidState();
      return function (sig) {
        if (!sig) return { state: 'missing', mismatches: ['no_signature'], voidRecord: null };
        var mm = [], body = clone(sig); delete body.signatureHash;
        if (sig.status !== 'valid') { body.status = 'valid'; delete body.voidId; delete body.invalidation; }
        if (u.sha256Hex(u.stableStringify(body)) !== sig.signatureHash) mm.push('signatureHash');
        var e = vs.bySig[sig.signatureId];
        if (!vs.intact) mm.push('void_store_integrity');
        if (e) { mm = mm.concat(e.mismatches); if (sig.status === 'valid') mm.push('valid_while_voided'); if (e.record && sig.voidId && sig.voidId !== e.record.voidId) mm.push('void_ref_mismatch'); }
        else if (sig.status !== 'valid') mm.push('invalid_without_void');
        return { state: mm.length ? 'tampered' : (e ? 'void' : 'valid'), mismatches: mm, voidRecord: e && e.record ? clone(e.record) : null };
      };
    }
    /* verifyRow 와 같은 판정, 무효 대조는 묶음 결과 사용 */
    function verifyWith(r, sig, vd, u) {
      if (r.source !== 'esign') return 'n/a';
      if (!sig) return 'unverifiable';
      var mm = vd.mismatches.slice();
      if (sig.recordType === 'batch_issue') {
        var b = issuedRec(sig.batchId);
        if (!b) return mm.length ? 'mismatch' : 'unverifiable';
        if (u.computeSnapshotHash(b.snapshot) !== sig.snapshotHash) mm.push('snapshotHash');
        ['batchId', 'contentHash', 'processTreeId'].forEach(function (k) { if (String(b[k]) !== String(sig[k])) mm.push(k); });
        if (String(b.manifestId || b.mf || '') !== String(sig.manifestId || '')) mm.push('manifestId');
        var cp = b.issueSignature || null;
        if (cp) { if (cp.signatureId !== sig.signatureId) mm.push('copy.signatureId'); if (cp.signatureHash !== sig.signatureHash) mm.push('copy.signatureHash'); }
      }
      return mm.length ? 'mismatch' : 'match';
    }
    function csvRow(r, ctx) {
      var u = ctx.u, sig = r.source === 'esign' ? (ctx.sigs[r.signatureId] || null) : null, est = (r.estimated || []).slice();
      var at = csvTime(r.at, est), batch = r.batchId || '';
      if (!batch && r.batchHint) { batch = r.batchHint; if (est.indexOf('batchId') < 0) est.push('batchId'); }
      var tg = [], addT = function (v) { if (v && tg.indexOf(String(v)) < 0) tg.push(String(v)); };
      addT(r.targetRef); addT(r.lineId); addT(r.dispenseId);
      var reason = r.why ? (r.whyLabel && r.whyLabel !== r.why ? r.whyLabel + ' (' + r.why + ')' : r.why) : '';
      var vd = r.source === 'esign' ? ctx.validity(sig) : null;
      return [r.rowId, r.source, r.result, r.resultLabel, at, r.meaning, r.meaningText, r.meaningTextEn, r.signerId, r.signerDisplayName,
        r.source === 'esign' ? r.signerRole : '', r.recordType, r.recordTypeLabel, batch, r.orderNo, tg.join(' · '),
        r.signRuleId ? r.signRuleId + (r.signRuleVer != null && r.signRuleVer !== '' ? ' v' + r.signRuleVer : '') : '', reason,
        r.statement, r.statementSource, r.signatureId, sig ? sig.signatureHash : '', ctx.verify(r, sig, vd), vd ? vd.state : '',
        r.source === 'esign' ? linkOf(r.signatureId, vd && vd.voidRecord, ctx.ci) : '', est.join(';'), r.screen
      ].map(function (v) { return v == null ? '' : String(v); });
    }
    function exportScope(o) {
      var u = U(); if (!u || !u.ESign || !u.Audit) return { ok: false, why: 'no_helper', message: CSV_MSG.no_helper };
      var sc = scopeOrFail(o);
      if (!sc.ok) return { ok: false, why: sc.why, message: sc.message, scope: sc };
      var cur = readJson('ebmr.currentUser.v1', null);
      if (!cur || normId(cur.userId) !== normId(sc.userId)) return { ok: false, why: 'not_current_user', message: CSV_MSG.not_current_user, scope: sc };
      if (sc.canExport !== true) return { ok: false, why: 'export_denied', message: CSV_MSG.export_denied, scope: sc };
      return sc;
    }
    function exportRows(filter, o) {
      var sc = exportScope(o); if (!sc.ok) return sc;
      var u = U(), f = clone(filter || {}) || {}; delete f.offset; delete f.limit;
      var cnt = query(Object.assign(clone(f), { limit: 1 }), { userId: sc.userId, scope: sc });   /* 상한 검사 먼저 (행 꾸밈 없이 개수만) */
      if (!cnt.ok) return { ok: false, why: cnt.why, message: cnt.message };
      if (cnt.total > CSV_ROW_LIMIT) return { ok: false, why: 'too_many_rows', total: cnt.total, limit: CSV_ROW_LIMIT, message: tooManyMessage(cnt.total) };
      var sigs = {}; readArr(K.ESIGN).forEach(function (s) { if (s && s.signatureId && !sigs[s.signatureId]) sigs[s.signatureId] = s; });
      var q, rows;
      if (!opts.csvNoBulk) bulk = { sigs: sigs, dispense: readArr(K.DISPENSE), issued: readArr(K.ISSUED) };
      try {
        q = query(f, { userId: sc.userId, scope: sc });
        if (!q.ok) return { ok: false, why: q.why, message: q.message };
        var ctx = { u: u, sigs: sigs, ci: correctionIndex(), validity: opts.csvNoBulk ? function (s) { return u.ESign.validity(s); } : bulkValidity(u),
                    verify: opts.csvNoBulk ? function (r) { return verifyRow(r).state; } : function (r, s, vd) { return verifyWith(r, s, vd, u); } };
        rows = q.rows.map(function (r) { return csvRow(r, ctx); });
      } finally { bulk = null; }
      return { ok: true, total: q.total, columns: CSV_COLUMNS.slice(), columnsKo: CSV_COLUMNS_KO.slice(), rows: rows,
               applied: clone(q.applied), scope: sc, unlinkedRefCount: linkStatus({ batchId: q.applied.batchId }).unlinked.length };
    }
    /* D1-7b 직렬화 — UTF-8 BOM · CRLF · 모든 값 따옴표(D-4) · 수식 주입 방지(D-11) · # 머리말 14줄(D-9) */
    var GUARD_RE = /^[=+\-@\t\r]/;
    function hdrVal(v) { return String(v == null ? '' : v).replace(/[\r\n]+/g, ' '); }
    function condVal(v) { if (v == null || v === '' || (Array.isArray(v) && !v.length)) return '(전체)'; return Array.isArray(v) ? v.join(';') : String(v); }
    /* 머리말 · 파일 이름 · 감사 요약용 '실제로 조회에 쓰인 조건' — 조회가 무시하는 값(해석 안 되는 날짜, 모르는 결과 · 의미 코드, asc 밖 정렬)은 적지 않는다 */
    function okTime(v) { if (v == null || v === '') return null; var str = String(v); if (/^\d{4}-\d{2}-\d{2}$/.test(str)) str += 'T00:00:00+09:00'; return isNaN(Date.parse(str)) ? null : String(v); }
    function effectiveFilter(applied) {
      var a = applied || {}, list = function (v, ok) { if (v == null || v === '') return null; return (Array.isArray(v) ? v : [v]).map(String).filter(ok); };
      var res = list(a.result === 'all' ? RESULTS : a.result, function (x) { return RESULTS.indexOf(x) >= 0; });
      return { from: okTime(a.from), to: okTime(a.to), batchId: a.batchId == null || a.batchId === '' ? null : String(a.batchId),
               result: res, meaning: list(a.meaning, function (x) { return Object.prototype.hasOwnProperty.call(MEANING, x); }), order: a.order === 'asc' ? 'asc' : 'desc' };
    }
    function toCsv(rows, meta) {
      var m = meta || {}, f = m.filter || {}, guarded = 0, list = Array.isArray(rows) ? rows : [];
      var cell = function (v) { var s = v == null ? '' : String(v); if (GUARD_RE.test(s)) { s = "'" + s; cell.hit = true; } return '"' + s.replace(/"/g, '""') + '"'; };
      /* 머리말 값도 본문과 같은 주입 방지 · 따옴표 (줄 수 고정 위해 값 안 줄바꿈은 공백으로). 머리말 적중은 guarded(행 수)에 넣지 않음 */
      var hv = function (v) { var s = hdrVal(v); if (GUARD_RE.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
      var ef = effectiveFilter(f), kv = function (k, v) { return '# ' + k + ',' + hv(v); };
      var head = ['# eBR 서명 내역 (S-42) CSV 내보내기', kv('exported_at', m.exportedAt), kv('exported_by', hdrVal(m.exportedBy) + ' (' + hdrVal(m.role) + ')'),
        kv('scope', m.scope), kv('filter.from', condVal(ef.from)), kv('filter.to', condVal(ef.to)), kv('filter.batchId', condVal(ef.batchId)),
        kv('filter.result', condVal(ef.result)), kv('filter.meaning', condVal(ef.meaning)), kv('filter.order', ef.order),
        kv('row_count', list.length), kv('csv_injection_guard', 'prefix_apostrophe'), kv('unlinked_ref_count', m.unlinkedRefCount || 0), '# columns_ko,' + CSV_COLUMNS_KO.map(hv).join(',')];
      var body = [CSV_COLUMNS.join(',')];
      list.forEach(function (r) { cell.hit = false; body.push(r.map(cell).join(',')); if (cell.hit) guarded++; });
      return { text: '\uFEFF' + head.concat(body).join('\r\n') + '\r\n', rowCount: list.length, guarded: guarded };
    }
    /* T-1: 파일 해시는 표준 SHA-256 (FIPS 180-4) 을 UTF-8 바이트(BOM 포함)에 적용 — 외부 도구(sha256sum 등)와 같은 값.
       헬퍼 sha256Hex 는 상수 1개가 표준과 달라(K[26]) 외부 도구 값과 다르므로 파일 해시에는 쓰지 않는다 (서명 · 내용 해시는 헬퍼 그대로) */
    function utf8Bytes(s) {
      var out = [];
      for (var i = 0; i < s.length; i++) {
        var c = s.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) { var c2 = s.charCodeAt(i + 1); if (c2 >= 0xdc00 && c2 <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00); i++; } }
        if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;   /* 짝 없는 대리 문자 → U+FFFD (TextEncoder 와 같음) */
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
        else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
        else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
      return out;
    }
    var SHA_K = (function () {
      var k = [], n = 2;
      while (k.length < 64) {
        var pr = true; for (var d = 2; d * d <= n; d++) if (n % d === 0) { pr = false; break; }
        if (pr) { var x = Math.pow(n, 1 / 3); k.push(Math.floor((x - Math.floor(x)) * 4294967296) >>> 0); }
        n++;
      }
      return k;
    })();
    function fileSha256(bytes) {
      var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
      var b = bytes.slice(), l = bytes.length, hi = Math.floor(l / 0x20000000), lo = (l << 3) >>> 0, w = new Array(64);
      var rotr = function (n, x) { return (x >>> n) | (x << (32 - n)); };
      b.push(0x80); while (b.length % 64 !== 56) b.push(0);
      b.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255, (lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);
      for (var i = 0; i < b.length; i += 64) {
        for (var j = 0; j < 16; j++) w[j] = ((b[i + j * 4] << 24) | (b[i + j * 4 + 1] << 16) | (b[i + j * 4 + 2] << 8) | b[i + j * 4 + 3]) >>> 0;
        for (j = 16; j < 64; j++) {
          var s0 = rotr(7, w[j - 15]) ^ rotr(18, w[j - 15]) ^ (w[j - 15] >>> 3), s1 = rotr(17, w[j - 2]) ^ rotr(19, w[j - 2]) ^ (w[j - 2] >>> 10);
          w[j] = (w[j - 16] + s0 + w[j - 7] + s1) >>> 0;
        }
        var a = H[0], bb = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
        for (j = 0; j < 64; j++) {
          var t1 = (h + (rotr(6, e) ^ rotr(11, e) ^ rotr(25, e)) + ((e & f) ^ (~e & g)) + SHA_K[j] + w[j]) >>> 0;
          var t2 = ((rotr(2, a) ^ rotr(13, a) ^ rotr(22, a)) + ((a & bb) ^ (a & c) ^ (bb & c))) >>> 0;
          h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = bb; bb = a; a = (t1 + t2) >>> 0;
        }
        H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + bb) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
        H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
      }
      return H.map(function (x) { var t = x.toString(16); while (t.length < 8) t = '0' + t; return t; }).join('');
    }
    function fileNameOf(applied, userId, at) {
      var a = applied || {}, d = function (v) { return v ? String(v).slice(0, 10).replace(/-/g, '') : ''; };
      var range = a.from || a.to ? (d(a.from) || 'open') + '-' + (d(a.to) || 'open') : 'all';
      var ts = String(at || '').slice(0, 19).replace(/-/g, '').replace('T', '-').replace(/:/g, '');
      return ['esign-history', a.batchId || 'ALL', range, ts, userId || ''].join('_').replace(/[^A-Za-z0-9._-]/g, '-') + '.csv';
    }
    /* D1-7c 해시 · 파일 이름 · 감사(ESIGN_EXPORT, 공개 Audit.append) — 감사 성공 후에만 text 반환 */
    function exportCsv(filter, o) {
      var x = exportRows(filter, o); if (!x.ok) return x;
      if (!x.total) return { ok: false, why: 'no_rows', message: CSV_MSG.no_rows };
      var u = U(), sc = x.scope, at = u.nowIsoLocal(), ef = effectiveFilter(x.applied), fileName = fileNameOf(ef, sc.userId, at);
      var c = toCsv(x.rows, { exportedAt: at, exportedBy: sc.userId, role: sc.role, scope: sc.scope, filter: x.applied, unlinkedRefCount: x.unlinkedRefCount });
      var fb = utf8Bytes(c.text), hash = fileSha256(fb), bytes = fb.length, ap = x.applied;
      var range = ef.from || ef.to ? (ef.from || '') + '~' + (ef.to || '') : '';
      var ent = { act: CSV_EXPORT_ACT, uid: sc.userId, tgt: 'S-42', val: ['CSV ' + c.rowCount + '행', ef.batchId || '', range].filter(Boolean).join(' · '), why: '', at: at,
                  before: null, after: { format: 'csv', rowCount: c.rowCount, fileName: fileName, fileHash: hash, bytes: bytes, columns: CSV_COLUMNS.length },
                  detail: { filter: clone(ap), scope: sc.scope, role: sc.role, guarded: c.guarded, truncated: false }, screen: CSV_SCREEN };
      if (ap.batchId) ent.batchId = ap.batchId;
      var rec = null;
      try { rec = u.Audit.append(ent); } catch (e) { rec = null; }
      if (!rec || !rec.auditId || rec.act !== CSV_EXPORT_ACT) return { ok: false, why: 'audit_failed', message: CSV_MSG.audit_failed, alertType: 'Error' };
      return { ok: true, text: c.text, fileName: fileName, mimeType: 'text/csv;charset=utf-8', rowCount: c.rowCount, guarded: c.guarded, fileHash: hash, bytes: bytes,
               columns: CSV_COLUMNS.length, auditId: rec.auditId, exportedAt: at, message: 'CSV ' + c.rowCount + '행을 내보냈습니다.' };
    }

    return {
      VERSION: 1, KEYS: clone(K), RESULTS: RESULTS.slice(), DEFAULT_RESULTS: DEFAULT_RESULTS.slice(), RESULT_LABEL: clone(RESULT_LABEL),
      MEANING: clone(MEANING), WHY_LABEL: clone(WHY_LABEL), RECORD_TYPE_LABEL: clone(RECORD_TYPE_LABEL), UNKNOWN_RECORD_TYPE: UNKNOWN_RECORD_TYPE,
      ORPHAN_RECORD_TYPES: ORPHAN_RECORD_TYPES.slice(), ORPHAN_LABEL: ORPHAN_LABEL, signatureRefs: signatureRefs, isOrphan: isOrphan, orphans: orphans,
      UNLINKED_LABEL: UNLINKED_LABEL, UNLINKED_MESSAGE: UNLINKED_MESSAGE, UNLINKED_SCREENS: clone(UNLINKED_SCREENS), SCOPE_BY_ROLE: clone(SCOPE_BY_ROLE),
      viewScope: viewScope, query: query, get: get, timeline: timeline, verify: verify, batchSummary: batchSummary, linkStatus: linkStatus, batches: batches,
      whyLabel: whyLabel, create: create,
      CSV_COLUMNS: CSV_COLUMNS.slice(), CSV_COLUMNS_KO: CSV_COLUMNS_KO.slice(), CSV_ROW_LIMIT: CSV_ROW_LIMIT, CSV_EXPORT_ACT: CSV_EXPORT_ACT, CSV_MSG: clone(CSV_MSG),
      exportRows: exportRows, toCsv: toCsv, exportCsv: exportCsv, csvEffectiveFilter: function (a) { return effectiveFilter(a); }, fileSha256: function (text) { return fileSha256(utf8Bytes(String(text == null ? '' : text))); }, csvFileName: fileNameOf, csvTooManyMessage: tooManyMessage
    };
  }

  var API = create({});
  global.EbrSignView = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : this);
