/* exec-sign-ui.js — 실행 · 출하 · 시험 · MBR 화면 공통 화면 스크립트 (읽기 · 표시 · 입력 전달만, 판정 · 저장은 assets 스토어)
 *  ① QualSign  : 서명 창 자격 표시 (EbrQual 결과만)
 *  ② P0Ui      : 상단 현재 사용자 선택 · 역할 판정 표시 · onUserChange
 *  ③ RecSign   : 공통 서명 창 #dlgRecSign 어댑터 (signUser 표시 · 서명 슬롯 그리기)
 *  포함 위치: assets/*.js 다음, 화면 본문 스크립트 앞 (<script src="./exec-sign-ui.js"></script>) */
/* ==== UI-06 서명 창 ⑦ 자격 표시 (교육 · 자격) — 판정은 verifySigner(⑦), 화면은 결과만 그린다 ====
 *  .qual-req  : 요구 자격 이름만 (Q7 — 서명자 자격 상태 미리보기 금지). 출처 EbrQual.listRequirements · listQualDefs (읽기만)
 *  .qual-msg  : ⑦ block 사유 배지(.badge.error) — res.items[] (code, qualId, expiresAt, message)
 *  warn       : 서명 성공 뒤 토스트만 (res.qualWarn[]) — 창 안 표시 없음 (J5) */
var QualSign = (function () {
  var BLOCK = { qual_missing: 1, qual_expired: 1, training_outdated_sop: 1, qual_req_unset: 1, qual_store_error: 1, unknown_user: 1, training_overdue: 1 };
  var MSG = {
    qual_missing: '자격 없음 — 부여 이력이 없습니다. 교육 · 자격 담당(QA)에게 요청하세요.',
    qual_expired: '자격 만료 — 재자격 후 서명하세요.',
    training_outdated_sop: 'SOP 재교육 필요 — 현재 효력 버전 이수 기록이 없습니다.',
    qual_req_unset: '자격 요구 미설정 — 교육 · 자격 [요구 매핑]에 설정을 요청하세요.',
    qual_store_error: '자격 정보를 읽지 못해 서명할 수 없습니다 — 관리자에게 문의하세요.'
  };
  function e(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function Q() { return window.EbrQual || null; }
  function names(targets) {
    var q = Q(); if (!q || typeof q.listRequirements !== 'function') return null;
    var reqs = [], defs = [];
    try { reqs = q.listRequirements() || []; defs = typeof q.listQualDefs === 'function' ? (q.listQualDefs() || []) : []; } catch (x) { return null; }
    var ids = [], seen = {};
    (targets || []).forEach(function (t) { var r = reqs.filter(function (x) { return x.target === t; })[0]; ((r && r.qualIds) || []).forEach(function (id) { if (!seen[id]) { seen[id] = 1; ids.push(id); } }); });
    return ids.map(function (id) { var d = defs.filter(function (x) { return x.qualId === id; })[0]; return id + (d && d.name ? ' ' + d.name : ''); });
  }
  function isQual(res) { return !!(res && (BLOCK[res.why] || BLOCK[res.code])); }
  function badge(it) {
    var md = String(it.expiresAt || '').slice(5);
    var t = it.code === 'qual_expired' ? '만료 ' + md : it.code === 'training_outdated_sop' ? 'SOP v' + (it.requiredVer || '?') : it.code === 'qual_req_unset' ? '미설정' : it.code === 'qual_store_error' ? '저장소 오류' : '자격 없음';
    return '<span class="badge error" title="' + e(it.message || '') + '">' + e((it.qualId || it.target || '') + ' ' + t) + '</span>';
  }
  return {
    /* el = .qual-req 요소, targets = ['SIGN:SM-…', 'ISSUE', 'BALCLASS:…'] */
    renderReq: function (el, targets) {
      if (!el) return;
      var n = names(targets);
      var txt = n === null ? '요구 자격 — (자격 저장소 미연결)' : n.length ? '요구 자격 ' + n.join(' · ') : '요구 자격 — 없음(명시) 또는 미설정';
      el.textContent = txt; el.title = txt;
    },
    clear: function (el) { if (el) { el.innerHTML = ''; el.title = ''; } },
    isQual: isQual,
    message: function (res) { var w = res.why || res.code; return res.message || MSG[w] || ('서명할 수 없습니다 (' + w + ')'); },
    renderBlock: function (el, res) {
      if (!el) return;
      var items = (res.items || res.qualItems || []).filter(function (i) { return BLOCK[i.code]; });
      if (!items.length) items = [{ code: res.why || res.code, message: res.message }];
      var seen = {}; items = items.filter(function (i) { var k = i.code + '|' + (i.qualId || i.target || ''); if (seen[k]) return false; seen[k] = 1; return true; });   /* 같은 자격이 대상 키 여러 개(ISSUE · SIGN:…)에 걸리면 배지 1개 */
      el.innerHTML = items.map(badge).join('');
      el.title = items.map(function (i) { return i.message || i.code; }).join(' · ');
    },
    toastWarn: function (res) {
      var w = (res && res.qualWarn) || [];
      if (!w.length || !window.MesUI) return;
      MesUI.toast('서명 완료 · ' + w.map(function (i) { return i.message || ('자격 만료 임박: ' + i.qualId + ' ' + (i.expiresAt || '') + (i.daysLeft != null ? ' (D-' + i.daysLeft + ')' : '')); }).join(' · '), 'warn', 4000);
    }
  };
})();
/* ==== P0 UI-04 현재 사용자 선택기 · 역할 배지 — EbrUserSession(UI-09) 어댑터 (공통 블록, 기준정보 · 배치 발행 · 칭량 화면과 동일) ==== */
/* 공개 API (UI-09 ebr-user-session.js, window.EbrUserSession) — 화면 → 헬퍼 호출은 이 블록 + 화면별 어댑터 구역만.
 *   listUsers({q,role,status}) · getCurrentUser() · setCurrentUser(id|null) → {ok,user}|{ok:false,code} · rolesOf(id)
 *   hasSodConflict(roles) · onChange(fn) → unsub
 * 헬퍼는 마크업을 만들지 않는다 → 선택기 · 배지는 이 블록이 그린다 (ui-items UI-04).
 * 헬퍼가 없으면(파일 미배포) 선택기는 「사용자 API 미연결」로 비활성 표시만 하고 화면 기존 동작은 그대로 둔다(게이트 미적용, 오류 없음). */
(function (global) {
  'use strict';
  var WATCH_KEYS = ['ebmr.currentUser.v1', 'ebmr.userRole.v1'];   /* onChange 가 없을 때만: 다른 탭 변경 감지용 키 이름 (값은 헬퍼로만 읽음) */
  var ROLE = { QP: ['QP', 'role-qp'], QA: ['QA', 'role-qa'], SV: ['감독자', 'ok'], OP: ['작업자', 'info'], ADMIN: ['관리자', ''] };
  var ROLE_ORDER = ['QP', 'QA', 'SV', 'OP', 'ADMIN'];   /* 배지 우선순위 QP>QA>SV>OP>ADMIN (기획 마스터 §3.1) */
  var GATE_SEL = '[data-p0-edit]';   /* 편집 · 서명 버튼 — 사용자 선택 없음이면 막음 */
  var GATE_TIP = '사용자를 선택하세요';
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var listeners = [], readyQ = [], isReady = false;

  function api() { return global.EbrUserSession || null; }
  function call(fn) {
    var a = api(); if (!a || typeof a[fn] !== 'function') return undefined;
    try { return a[fn].apply(a, Array.prototype.slice.call(arguments, 1)); } catch (e) { if (global.console) console.error('[EbrUserSession] ' + fn, e); return undefined; }
  }
  function sortRoles(roles) { return (roles || []).slice().sort(function (a, b) { return ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b); }); }
  function roleBadge(code) { var r = ROLE[code] || [code, 'muted']; return '<span class="badge' + (r[1] ? ' ' + r[1] : '') + '" title="' + esc(code) + '">' + esc(r[0]) + '</span>'; }
  function roleBadges(roles) { return sortRoles(roles).map(roleBadge).join(''); }
  function statusBadge(st) { return st === 'locked' ? '<span class="badge error">잠김</span>' : st === 'inactive' ? '<span class="badge muted">비활성</span>' : ''; }
  function rolesOfUser(u) { return !u ? [] : (Array.isArray(u.roles) ? u.roles : (call('rolesOf', u.userId) || [])); }
  function users(filter) { var l = call('listUsers', filter || {}); return Array.isArray(l) ? l : []; }
  function current() { return call('getCurrentUser') || null; }
  function connected() { var a = api(); return !!(a && typeof a.getCurrentUser === 'function' && typeof a.listUsers === 'function'); }
  function hasRole(u, code) { return rolesOfUser(u).indexOf(code) >= 0; }
  function sod(roles) { var v = call('hasSodConflict', roles || []); return typeof v === 'boolean' ? v : false; }
  function gateOn() { return connected() && !current(); }
  function userLabel(u) { return u ? u.name + ' (' + u.userId + ')' : '—'; }

  function render() {
    var host = document.getElementById('userSwitch');
    if (host) {
      if (!connected()) {
        host.innerHTML = '<span class="tip" title="사용자 · 서명 헬퍼(ebr-user-session.js)가 로드되면 선택할 수 있습니다"><select class="input w-200" disabled aria-label="현재 사용자"><option>사용자 API 미연결</option></select></span>';
      } else {
        var cur = current(), list = users();
        var opts = '<option value="">사용자 선택</option>' + list.map(function (u) {
          var bad = u.status === 'locked' ? ' — 잠김' : u.status === 'inactive' ? ' — 비활성' : '';
          return '<option value="' + esc(u.userId) + '"' + (bad ? ' disabled' : '') + (cur && cur.userId === u.userId ? ' selected' : '') + '>' + esc(userLabel(u) + bad) + '</option>';
        }).join('');
        host.innerHTML = '<select class="input w-200" id="userSwitchSel" aria-label="현재 사용자" title="현재 사용자 (인증 아님 — 서명 시 ID · 비밀번호 재입력)">' + opts + '</select>' +
          '<span class="us-roles">' + (cur ? roleBadges(rolesOfUser(cur)) + statusBadge(cur.status) : '<span class="badge warn">' + GATE_TIP + '</span>') + '</span>';
        var sel = document.getElementById('userSwitchSel');
        sel.addEventListener('change', function () {
          var r = call('setCurrentUser', sel.value || null);
          if (r && r.ok === false && global.MesUI) {
            MesUI.toast(r.message || (r.code === 'LOCKED' ? '잠긴 계정은 선택할 수 없습니다 — 관리자(ADMIN)에게 해제를 요청하세요.'
              : r.code === 'INACTIVE' ? '비활성 계정은 선택할 수 없습니다.' : r.code === 'SAVE_ERROR' ? '감사 기록을 저장하지 못해 사용자를 전환하지 못했습니다.' : '사용자를 찾을 수 없습니다.'),
              r.code === 'SAVE_ERROR' ? 'error' : 'warn', 2600);   /* SAVE_ERROR: 헬퍼가 변경을 되돌림 → 선택값도 아래 refresh 로 되돌림 */
          }
          if (!hasOnChange || (r && r.ok === false)) refresh();   /* onChange 는 성공 시 헬퍼가 발생 — 거부(LOCKED 등)면 선택 되돌림 */
        });
      }
    }
    applyGate();
  }
  function applyGate() {
    var on = gateOn();
    document.body.classList.toggle('p0-no-user', on);
    Array.prototype.forEach.call(document.querySelectorAll(GATE_SEL), function (b) { b.classList.toggle('p0-gated', on); });
  }
  function refresh() { render(); listeners.forEach(function (fn) { try { fn(current()); } catch (e) { if (global.console) console.error(e); } }); }

  /* 선택 없음 게이트: 편집 버튼 클릭 차단 + 툴팁 (동적으로 그려지는 T-02 버튼 포함) */
  document.addEventListener('click', function (e) {
    if (!gateOn()) return;
    var b = e.target.closest && e.target.closest(GATE_SEL);
    if (!b) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    if (global.MesUI) MesUI.toast(GATE_TIP + ' — 상단 사용자 선택기에서 현재 사용자를 고른 뒤 다시 시도하세요.', 'warn', 2200);
  }, true);
  document.addEventListener('mouseover', function (e) {
    var b = e.target.closest && e.target.closest(GATE_SEL);
    if (!b) return;
    if (gateOn()) { if (!b.hasAttribute('data-p0-tip')) b.setAttribute('data-p0-tip', b.getAttribute('title') || ''); b.setAttribute('title', GATE_TIP); b.classList.add('p0-gated'); }
    else if (b.hasAttribute('data-p0-tip')) { b.setAttribute('title', b.getAttribute('data-p0-tip')); b.removeAttribute('data-p0-tip'); b.classList.remove('p0-gated'); }
  }, true);

  var hasOnChange = false;
  function start() {
    isReady = true;
    var a = api();
    if (a && typeof a.onChange === 'function') { hasOnChange = true; call('onChange', function () { refresh(); }); }
    else global.addEventListener('storage', function (e) { if (WATCH_KEYS.indexOf(e.key) >= 0) refresh(); });
    render();
    readyQ.splice(0).forEach(function (fn) { try { fn(); } catch (e) { if (global.console) console.error(e); } });
  }

  global.P0Ui = {
    api: api, call: call, connected: connected, users: users, current: current, hasRole: hasRole, rolesOf: rolesOfUser, sod: sod, userLabel: userLabel,
    roleBadge: roleBadge, roleBadges: roleBadges, statusBadge: statusBadge, sortRoles: sortRoles, ROLE: ROLE, ROLE_ORDER: ROLE_ORDER,
    gateOn: gateOn, refresh: refresh, applyGate: applyGate, esc: esc, GATE_TIP: GATE_TIP,
    onUserChange: function (fn) { listeners.push(fn); },
    ready: function (fn) { if (isReady) fn(); else readyQ.push(fn); }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})(window);

/* ==== 공통 서명 창 #dlgRecSign 어댑터 — 판정 · 저장 · 문장 조립 = EbrExecSign(→ EbrUserSession), 화면은 표시 · 입력 전달만 ====
 *  RecSign.open({ meaning, title, begin(api) → {ok, ticket, target}, l1?, f1, f2 ([값, title]), f6, rows?, valTitle?, note, reason?, okText?, onDone(res) })
 *  - begin 실패(why) → 창을 열지 않고 토스트 (fail-closed — not_implemented 포함)
 *  - [서명] 활성 = ID · 비밀번호 입력만 (자격 · 역할 미리 막지 않음)
 *  - ⑦ 차단 → 창 유지 · 비밀번호 비움 · #signErr + .qual-msg .badge.error / ⑦ warn → 성공 뒤 토스트 warn
 *  - 저장 실패(롤백) → 창 닫고 토스트 error / 잠금 → 창 닫고 alert
 *  - 문장 = target.statement 그대로 표시 → input.statement 로 되돌려 대조 (o.stmt(target, 사유) — 사유가 들어가는 문장만 다시 생성) */
var RecSign = (function () {
  'use strict';
  var MEAN = {
    performed: ['수행', 'Performed by'], verified: ['확인', 'Verified by'],
    approved: ['승인', 'Approved by'], reviewed: ['검토', 'Reviewed by'], read_understood: ['읽고 이해함', 'Read & understood']
  };
  var WHY = {
    not_implemented: '서명 저장소 기능이 아직 준비되지 않았습니다 (not_implemented) — 서명할 수 없습니다.',
    no_store: '서명 저장소(ebr-exec-sign-store.js)를 읽지 못했습니다 — 서명할 수 없습니다.',
    no_batch: '배치를 찾을 수 없습니다.', no_step: '단계를 찾을 수 없습니다.', bad_slot: '서명 슬롯이 올바르지 않습니다.',
    prev_slot_missing: '앞 슬롯 서명이 먼저 필요합니다.', already_signed: '이미 서명된 슬롯입니다.',
    role_restricted: '이 슬롯은 허용 역할이 제한되어 있습니다.', no_lot: 'LOT를 찾을 수 없습니다.', bad_state: '현재 LOT 상태에서는 이 판정을 할 수 없습니다.',
    bad_to: '판정 값이 올바르지 않습니다.', bad_kind: '검토 종류가 올바르지 않습니다.', no_exception: '예외를 찾을 수 없습니다.',
    gate_blocked: '출하 조건 차단 — 출하 승인할 수 없습니다.', already_released: '이미 출하된 배치입니다.',
    no_order: '오더를 찾을 수 없습니다.', no_issued: '발행 기록이 없습니다.', precheck_changed: '서명 창을 연 뒤 조건이 바뀌었습니다 — 창을 닫고 다시 여세요.'
  };
  var ROLLBACK = { RECORD_ROLLBACK: 1, REL_ROLLBACK: 1, save_error: 1, rollback: 1 };
  var st = null;
  function $(id) { return document.getElementById(id); }
  function e(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function api() { return window.EbrExecSign || null; }
  function toast(m, k, ms) { if (window.MesUI) MesUI.toast(m, k, ms || 3200); }
  function whyMsg(r) { r = r || {}; return r.message && r.why !== 'not_implemented' ? r.message : (WHY[r.why] || r.message || ('서명할 수 없습니다 (' + (r.why || 'unknown') + ')')); }
  function setText(id, v) { var el = $(id); if (!el) return; var a = Array.isArray(v) ? v : [v, v]; el.textContent = a[0] == null ? '—' : String(a[0]); el.title = a[1] == null ? '' : String(a[1]); }
  function ruleLine(rule) {
    if (!rule) return '규칙 정보 없음';
    return (rule.id || '?') + ' v' + (rule.ver == null ? '?' : rule.ver) + ' · 허용 ' + ((rule.roles || []).join(' · ') || '—') + (rule.note ? ' · ' + rule.note : '');
  }
  function curUser() { return window.P0Ui ? P0Ui.current() : null; }
  function userCard() {
    var u = curUser();
    $('signUser').innerHTML = u ? '<span class="name">' + e(u.name) + '</span><span class="sub-info">' + e(u.userId) + '</span><span class="badges">' + P0Ui.roleBadges(P0Ui.rolesOf(u)) + '</span>'
      : '<span class="sub-info">현재 사용자 없음 — ID · 비밀번호로 서명자를 확인합니다</span>';
  }
  function valRows(rows) {
    rows = rows || [];
    var shown = rows, more = 0;
    if (rows.length > 9) { shown = rows.slice(0, 8); more = rows.length - 8; }
    var h = shown.map(function (r, i) {
      return '<tr><td class="col-no">' + (i + 1) + '</td><td title="' + e(r.k) + '">' + e(r.k) + '</td><td title="' + e(r.t || r.v) + '">' + e(r.v) + '</td></tr>';
    }).join('');
    if (more) h += '<tr class="rs-more"><td class="col-no">…</td><td colspan="2" class="sub-info">… 외 ' + more + '건 (전체 값은 서명 해시에 묶임)</td></tr>';
    if (!rows.length) h = '<tr><td class="col-no">—</td><td colspan="2" class="sub-info">표시할 값 없음</td></tr>';
    $('grdRecSignValBody').innerHTML = h;
    $('rsValTotal').textContent = '(' + rows.length + '건)';
  }
  function valuesToRows(vals) {
    return (vals || []).map(function (v) {
      var val = v.value == null ? '' : String(v.value) + (v.uom ? ' ' + v.uom : '');
      if (v.judge) val += ' · ' + v.judge;
      return { k: v.label || v.key || '', v: val };
    });
  }
  function input() {
    var ok = !!($('signId').value.trim() && $('signPw').value);
    $('btnRecSign').disabled = !ok || !!(st && st.busy);
    $('btnRecSignWrap').title = ok ? '' : 'ID · 비밀번호를 입력하세요';
  }
  function clearErr() { $('signErr').textContent = ''; $('signErr').title = ''; if (window.QualSign) QualSign.clear($('signQualMsg')); else $('signQualMsg').innerHTML = ''; }
  function showErr(msg) { $('signErr').textContent = msg; $('signErr').title = msg; }

  function open(o) {
    var a = api() || (o.commit ? {} : null);   /* o.commit · o.cancel = 서명 저장소가 아닌 커밋 경로(인터록 감독자 승인 — ilr-ui-wire.js) */
    if (!a) { toast(WHY.no_store, 'error'); return { ok: false, why: 'no_store' }; }
    var r;
    try { r = o.begin(a); } catch (x) { if (window.console) console.error('[EbrExecSign] begin', x); r = { ok: false, why: 'exception', message: '서명을 시작하지 못했습니다 — ' + (x && x.message || x) }; }
    if (!r || !r.ok || !r.ticket) { toast(whyMsg(r), r && r.why === 'not_implemented' ? 'warn' : 'error', 3600); return r || { ok: false }; }
    var t = r.target || {};
    var mk = o.meaning || 'performed', m = MEAN[mk] || MEAN.performed;
    st = { ticket: r.ticket, target: t, o: o, done: false, busy: false };
    $('rsDot').className = 'sign-meaning ' + mk; $('rsDot').title = '서명 의미: ' + m[0] + ' (' + mk + ')';
    $('rsTitle').textContent = '전자서명 — ' + (o.title || m[0]) + ' (' + m[1] + ')';
    $('rsProxy').hidden = !t.qaProxy;
    var u = curUser();
    var fv = function (x) { return typeof x === 'function' ? x(t) : x; };
    setText('rsF1', fv(o.f1) || '—'); setText('rsF2', fv(o.f2) || '—');
    $('rsL1').textContent = o.l1 || '배치';
    if (o.l2) $('rsL2').textContent = o.l2; else $('rsL2').textContent = '대상';
    setText('rsF3', t.rule ? [t.rule.id + ' v' + t.rule.ver, ruleLine(t.rule)] : '—');
    setText('rsF4', u ? u.name + ' (' + u.userId + ')' : '— (ID 입력으로 확인)');
    $('rsL5').textContent = o.l5 || '요구 인증';
    setText('rsF5', fv(o.f5) || t.authText || 'ID + 비밀번호');
    $('rsL6').textContent = o.l6 || '레코드 타입';
    setText('rsF6', fv(o.f6) || t.recordType || '—');
    $('rsValTitle').textContent = o.valTitle || '서명 값';
    var rr = fv(o.rows); valRows(rr && rr.length ? rr : valuesToRows(t.values));
    userCard();
    var rl = ruleLine(t.rule); $('signRule').textContent = rl; $('signRule').title = rl;
    $('signId').value = u ? u.userId : ''; $('signPw').value = ''; $('signCmt').value = '';
    var rcEl = $('signReasonCode'), rcs = (rcEl && o.reasonCodes) || null;   /* opt-in: o.reasonCodes 를 준 호출만 · 콤보 마크업 없는 화면은 무시 */
    if (rcEl) { rcEl.hidden = !rcs; rcEl.value = ''; }
    if (rcEl) rcEl.innerHTML = rcs ? '<option value="">사유 코드 선택</option>' + rcs.map(function (c) { return '<option value="' + e(c.key) + '">' + e(c.key + ' ' + c.text) + '</option>'; }).join('') : '';
    $('signCmtLabel').textContent = rcs ? '사유' : o.reason ? '사유' : '코멘트';
    $('signCmtLabel').classList.toggle('required', !!(o.reason || rcs));
    $('signCmt').placeholder = rcs ? '기타(OTHER)면 필수 1–60자' : o.reason ? '1–60자 필수' : '선택 입력';
    clearErr();
    var q = (t.qualReq || []).map(function (x) { return (x.qualId || '') + (x.name ? ' ' + x.name : ''); });
    var qt = q.length ? '요구 자격: ' + q.join(' · ') : '요구 자격: 없음';
    $('signQualReq').textContent = qt; $('signQualReq').title = qt;
    liveStmt();
    var note = o.note || t.note || '';
    $('signNote').textContent = note; $('signNote').title = note;
    $('btnRecSign').textContent = mk === 'approved' ? '승인' : '서명';
    input();
    MesUI.openDialog('dlgRecSign');
    setTimeout(function () { ($('signId').value ? $('signPw') : $('signId')).focus(); }, 0);
    return r;
  }

  /* 문장 = target.statement. 사유가 문장에 들어가는 서명(o.stmt)은 입력한 사유로 같은 문장을 다시 만들어 보여 준다 (헬퍼 signStatement) */
  function liveStmt() {
    if (!st) return;
    var stmt = st.target.statement || '';
    if (typeof st.o.stmt === 'function') { try { var rcO = st.o.reasonCodes && $('signReasonCode') ? $('signReasonCode').selectedOptions[0] : null; stmt = st.o.stmt(st.target, $('signCmt').value, rcO && rcO.value ? rcO.textContent.replace(/^\S+ /, '') : '') || stmt; } catch (x) { if (window.console) console.error(x); } }
    $('signStatementText').textContent = stmt; $('signStatement').title = stmt;
  }
  function sign() {
    if (!st || st.busy) return;
    var a = api(); if (!a && !st.o.commit) return;
    var inp = { userId: $('signId').value.trim(), password: $('signPw').value, statement: $('signStatementText').textContent };
    var c = $('signCmt').value.trim();
    if (st.o.reasonCodes && $('signReasonCode')) { var rco = $('signReasonCode').selectedOptions[0]; inp.reasonCode = $('signReasonCode').value; inp.reasonCodeText = rco && rco.value ? rco.textContent.replace(/^\S+ /, '') : ''; inp.reason = c; }
    else if (st.o.reason) inp.reason = c; else if (c) inp.comment = c;
    st.busy = true; input();
    var r;
    try { r = st.o.commit ? st.o.commit(st.ticket, inp) : a.signAndCommit(st.ticket, inp); } catch (x) { if (window.console) console.error('[EbrExecSign] signAndCommit', x); r = { ok: false, why: 'RECORD_ROLLBACK', message: '저장 중 오류 — 되돌렸습니다 (' + (x && x.message || x) + ')' }; }
    st.busy = false;
    $('signPw').value = '';
    if (r && r.ok) {
      var o = st.o; st.done = true;
      MesUI.closeDialog('dlgRecSign');
      toast((o.okText || '서명 완료') + ' — ' + (r.signatureId || ''), 'ok', 2600);
      if (window.QualSign) QualSign.toastWarn(r);
      if (o.onDone) try { o.onDone(r); } catch (x) { if (window.console) console.error(x); }
      return r;
    }
    r = r || { ok: false, why: 'unknown' };
    var w = r.why || r.code;
    if (ROLLBACK[w] || ROLLBACK[r.code]) {
      var of = st.o; st.done = true; MesUI.closeDialog('dlgRecSign');   /* 닫힘에서 st 가 비워지므로 먼저 잡아 둠 */
      toast('저장 실패 — 모두 되돌렸습니다. ' + (r.message || w), 'error', 4000);
      if (of.onFail) of.onFail(r);
      return r;
    }
    if (w === 'read_only' || r.closeDialog) {   /* 읽기 전용 거부 (복원 탐지 등) — 창 닫고 메시지 원문 그대로 */
      st.done = true; MesUI.closeDialog('dlgRecSign');
      toast(r.message || WHY[w] || w, 'error', 4000);
      return r;
    }
    if (w === 'locked' || w === 'LOCKED' || r.locked) {
      MesUI.closeDialog('dlgRecSign');
      MesUI.alert(r.message || '계정이 잠겼습니다 — 관리자(ADMIN)에게 해제를 요청하세요.', 'Error');
      return r;
    }
    clearErr();
    if (window.QualSign && QualSign.isQual(r)) { showErr(QualSign.message(r)); QualSign.renderBlock($('signQualMsg'), r); }
    else showErr((r.message || WHY[w] || ('서명 거부 (' + w + ')')) + (r.failCount != null && !/실패 \d/.test(r.message || '') ? ' · 실패 ' + r.failCount + '/5' : ''));
    input();
    if (st && st.o.onReject) st.o.onReject(r);
    return r;
  }

  function init() {
    var b = $('dlgRecSign'); if (!b) return;
    ['signId', 'signPw', 'signCmt'].forEach(function (id) { $(id).addEventListener('input', input); });
    $('signCmt').addEventListener('input', liveStmt);
    if ($('signReasonCode')) $('signReasonCode').addEventListener('change', liveStmt);
    $('signPw').addEventListener('keydown', function (ev) { if (ev.key === 'Enter' && !$('btnRecSign').disabled) sign(); });
    $('btnRecSign').addEventListener('click', sign);
    b.addEventListener('dialogclose', function () {
      if (!st) return;
      var s = st; st = null;
      if (!s.done) { var a = api(); try { if (s.o.cancel) s.o.cancel(s.ticket); else if (a) a.cancel(s.ticket, { reason: 'user_cancel' }); } catch (x) { if (window.console) console.error('[EbrExecSign] cancel', x); } if (s.o.onCancel) s.o.onCancel(); }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  return { open: open, sign: sign, whyMsg: whyMsg, ruleLine: ruleLine, MEAN: MEAN, isOpen: function () { return !!st; } };
})();

/* ==== 서명 슬롯 · 상태 표시 (§2 색 대응표) — 원천 EbrSignStatus (읽기 전용) ==== */
var SignView = (function () {
  'use strict';
  function e(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  var SLOT_MEAN = { perform: 'performed', verify: 'verified', qa: 'verified', review: 'reviewed', approve: 'approved' };
  function api() { return window.EbrSignStatus || null; }
  function call(fn) {
    var a = api(); if (!a || typeof a[fn] !== 'function') return { ok: false, why: 'no_store' };
    try { return a[fn].apply(a, Array.prototype.slice.call(arguments, 1)); } catch (x) { if (window.console) console.error('[EbrSignStatus] ' + fn, x); return { ok: false, why: 'exception', message: String(x && x.message || x) }; }
  }
  function hm(ts) { var m = /T(\d\d:\d\d)/.exec(String(ts || '')); return m ? m[1] : String(ts || '').slice(11, 16); }
  /* it = getSignStatus 항목 → 셀 html (signed: 의미 점 + ID · 시각 / pending: muted / invalid: error / na: badge) */
  function slotHtml(it, pendingText) {
    if (!it) return '<span class="badge muted">대기</span>';
    var mean = SLOT_MEAN[it.slot] || 'performed';
    if (it.status === 'signed') {
      var t = (it.signerId || '') + ' ' + hm(it.signedAt);
      return '<span class="sign-slot" title="' + e((it.label || '') + ' · ' + (it.signerName || '') + ' ' + (it.signerId || '') + ' · ' + (it.signedAt || '') + ' · ' + (it.signatureId || '')) + '"><span class="sign-dot ' + mean + '"></span>' + e(t) + '</span>';
    }
    if (it.status === 'invalid') return '<span class="badge error" title="' + e(it.signatureId || '') + '">무효</span>';
    if (it.status === 'na') return '<span class="badge" title="' + e(it.reason || '') + '">N/A</span>';
    return '<span class="badge muted" title="' + e(it.reason || it.label || '') + '">' + e(pendingText || '대기') + '</span>';
  }
  return { api: api, call: call, slotHtml: slotHtml, hm: hm, SLOT_MEAN: SLOT_MEAN };
})();
