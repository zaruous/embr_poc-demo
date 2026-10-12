/* exec-sign-invalidate.js — 출하 판정 · 서명 이력 화면 공통 서명 무효화 창 #dlgInvalidate 동작 (마크업은 각 화면 #dlgInvalidate) */
/* ==== 서명 무효화 (EbrExecSign.invalidateSignature — 현재 사용자 QA · 사유 1–200자 · 비밀번호 재입력) ====
 *  Invalidate.open({ signatureId, target, screen?, onDone(res) }) · Invalidate.canUse() → QA 역할 현재 사용자
 *  실패: why · message 그대로 + failCount / maxFail, 잠금(locked) 이면 창 닫고 안내. 시도마다 비밀번호 칸 비움 */
window.Invalidate = (function () {
  'use strict';
  var cur = null;
  function $(id) { return document.getElementById(id); }
  function user() { return window.P0Ui && P0Ui.current ? P0Ui.current() : null; }
  function canUse() { var u = user(); return !!(u && P0Ui.hasRole(u, 'QA') && window.EbrExecSign && EbrExecSign.invalidateSignature); }
  var WHY = { no_current_user: '상단에서 사용자를 선택하세요.', not_qa: '무효화는 QA 역할만 할 수 있습니다.', account_inactive: '사용할 수 없는 계정입니다.',
              locked: '계정이 잠겼습니다 — 관리자(ADMIN)에게 해제를 요청하세요.', reason_required: '무효화 사유를 입력하세요.', reason_too_long: '사유는 200자 이하로 입력하세요.',
              no_signature: '서명 레코드를 찾지 못했습니다.', already_void: '이미 무효인 서명입니다.', sig_tampered: '서명 레코드 대조 불일치 — 무효화할 수 없습니다.',
              void_store_integrity: '무효화 기록 대조 불일치 — 무효화할 수 없습니다 (fail-closed).', password_required: '비밀번호를 입력하세요.',
              bad_password: '비밀번호가 맞지 않습니다.', save_error: '무효화 저장에 실패했습니다 — 바뀌지 않았습니다.' };
  function sync() { $('btnInvalidate').disabled = !cur || !$('invReason').value.trim() || !$('invPw').value; }
  function open(o) {
    if (!$('dlgInvalidate')) return;
    var u = user();
    cur = o; $('invId').textContent = o.signatureId; $('invTgt').textContent = o.target || '—'; $('invTgt').title = o.target || '';
    $('invActor').textContent = u ? u.name + ' (' + u.userId + ')' : '사용자 미선택';
    $('invReason').value = ''; $('invPw').value = ''; $('invErr').textContent = ''; sync();
    MesUI.openDialog('dlgInvalidate'); setTimeout(function () { $('invReason').focus(); }, 0);
  }
  function run() {
    if (!cur) return;
    var pw = $('invPw').value, r;
    $('invPw').value = '';   /* 시도마다 비움 (성공 · 실패 모두) */
    try { r = EbrExecSign.invalidateSignature({ signatureId: cur.signatureId, reason: $('invReason').value, password: pw, screen: cur.screen || '' }); }
    catch (e) { r = { ok: false, why: 'save_error' }; if (window.console) console.error(e); }
    pw = null;
    if (!r || !r.ok) {
      r = r || { why: 'save_error' };
      var msg = r.message || WHY[r.why] || ('무효화 실패 (' + r.why + ')');
      if (r.failCount != null && !/실패 \d/.test(msg)) msg += ' · 실패 ' + r.failCount + '/' + (r.maxFail || 5) + (r.maxFail ? ' (' + r.maxFail + '회 시 계정 잠금)' : '');
      if (r.locked || r.why === 'locked') {
        cur = null; MesUI.closeDialog('dlgInvalidate');
        MesUI.alert(msg.indexOf('잠') >= 0 ? msg : msg + ' — 계정이 잠겼습니다. 관리자(ADMIN)에게 해제를 요청하세요.', 'Error');
        return r;
      }
      $('invErr').textContent = msg; sync(); $('invPw').focus();
      return r;
    }
    var o = cur; cur = null; MesUI.closeDialog('dlgInvalidate');
    MesUI.toast('서명 무효화 — ' + o.signatureId, 'warn', 2600);
    if (o.onDone) try { o.onDone(r); } catch (e) { if (window.console) console.error(e); }
    return r;
  }
  function init() {
    if (!$('dlgInvalidate')) return;
    ['invReason', 'invPw'].forEach(function (id) { $(id).addEventListener('input', sync); });
    $('invPw').addEventListener('keydown', function (e) { if (e.key === 'Enter' && !$('btnInvalidate').disabled) run(); });
    $('btnInvalidate').addEventListener('click', run);
    $('dlgInvalidate').addEventListener('dialogclose', function () { cur = null; $('invPw').value = ''; });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  return { open: open, canUse: canUse };
})();
