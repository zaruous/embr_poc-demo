/* =============================================================================
 * 정정(부분 대체) 공통 팝업 — window.CorrUI  (화면 전용 · C4-1 / CF-01 · CF-02 · CF-03 · CF-05)
 *  - #dlgCorrection  값 정정 요청 (T-10 1100 × 700)
 *  - #dlgCorrSign    정정 수행 서명 (공통 서명 창 #dlgRecSign 과 같은 마크업 · 공용 클래스)
 *  - #dlgCorrVerify  정정 QA 확인 · 반려
 *  판정 · 저장 · 문장 조립 = window.EbrCorrection (store). 이 파일은 표시 · 입력 전달만.
 *  저장소 키(ebr.correction.v1 · ebr.esignVoid.v1)를 직접 읽지 않는다.
 *  EbrCorrection 이 없거나 함수가 없으면 fail-closed — 안내 + 버튼 비활성, 오류 없음.
 *  스타일: Elephant CSS(mesui.css) 공용 클래스 + 토큰만 (hex · px 리터럴 없음).
 * ========================================================================== */
(function (global) {
  'use strict';
  var doc = global.document;
  var MAX_REASON = 60;
  var SCREEN_DEFAULT = 'S-EBR-CORR';

  /* ---------- API 가드 ---------- */
  var inst = null;
  function api() {
    var E = global.EbrCorrection;
    if (!E) return null;
    if (typeof E.listCorrections === 'function') return E;
    if (!inst && typeof E.create === 'function') { try { inst = E.create({}); } catch (x) { if (global.console) console.warn('[CorrUI] EbrCorrection.create', x); inst = null; } }
    return inst;
  }
  function has(fn) { var a = api(); return !!(a && typeof a[fn] === 'function'); }
  function call(fn) {
    var a = api();
    if (!a || typeof a[fn] !== 'function') return { ok: false, why: 'not_connected', fn: fn, message: '정정 API 미연결 (' + fn + ')' };
    try { return a[fn].apply(a, Array.prototype.slice.call(arguments, 1)) || { ok: false, why: 'empty' }; }
    catch (x) { if (global.console) console.warn('[CorrUI] ' + fn, x); return { ok: false, why: 'save_error', message: String(x && x.message || x) }; }
  }
  function US() { return global.EbrUserSession || null; }
  function curUser() { var u = US(); try { return u && typeof u.getCurrentUser === 'function' ? u.getCurrentUser() : null; } catch (x) { return null; } }
  function rolesOf(u) {
    if (!u) return [];
    if (Array.isArray(u.roles)) return u.roles;
    var s = US(); try { return s && typeof s.rolesOf === 'function' ? (s.rolesOf(u.userId) || []) : []; } catch (x) { return []; }
  }
  function rule(id) { var s = US(); try { return s && typeof s.getSignRule === 'function' ? s.getSignRule(id) : null; } catch (x) { return null; } }
  /** 규칙 allowedRoles 로만 판정 (하드코딩 없음). {ok, why, tip} */
  function roleGate(ruleId, what) {
    var u = curUser();
    if (!u) return { ok: false, why: 'no_current_user', tip: '사용자를 선택하세요' };
    if (u.status === 'locked') return { ok: false, why: 'locked', tip: '잠긴 계정입니다' };
    var r = rule(ruleId), allowed = r && Array.isArray(r.allowedRoles) ? r.allowedRoles : null;
    if (!allowed) return { ok: false, why: 'rule_missing', tip: '서명 규칙 ' + ruleId + ' 미등록 · 미발효 — ' + what + ' 불가' };
    var mine = rolesOf(u);
    if (!allowed.some(function (x) { return mine.indexOf(x) >= 0; })) return { ok: false, why: 'role_restricted', tip: what + '은(는) ' + allowed.join(' · ') + '만 할 수 있습니다' };
    return { ok: true, tip: '' };
  }
  function canRequest() { return roleGate('SM-PERF-CORR', '정정 요청'); }
  function canVerify() { return roleGate('SM-VERI-CORR', 'QA 확인'); }

  /* ---------- 표시 공통 ---------- */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function $(id) { return doc.getElementById(id); }
  function txt(id, v, title) { var e = $(id); if (!e) return; e.textContent = v == null || v === '' ? '—' : String(v); e.title = title != null ? String(title) : e.textContent; }
  function fmt(iso) { if (!iso) return ''; var s = US(); try { return s && typeof s.fmtKst === 'function' ? s.fmtKst(iso) : String(iso); } catch (x) { return String(iso); } }
  function vu(o) { return o ? String(o.value == null ? '' : o.value) + (o.uom ? ' ' + o.uom : '') : ''; }
  function short(h) { return h ? String(h).slice(0, 8) : '—'; }
  function toast(m, k, ms) { if (global.MesUI) MesUI.toast(m, k || 'info', ms || 3000); }

  /** CF-05 실패 문구 (설계 W5 7종 + ui-items §8-5 제안 문구) — 끝에 (why) */
  /* 설계 §5.0 표시 문구 17종 (원문 그대로) — 화면 WHY 우선, 없으면 store message */
  var WHY50 = {
    no_current_user: '현재 사용자가 없습니다 — 상단에서 사용자를 선택하세요.',
    role_restricted: '정정은 OP · SV 역할만 요청할 수 있습니다.',
    no_batch: '배치를 찾을 수 없습니다.',
    already_released: '출하 승인된 배치는 정정할 수 없습니다 — 일탈 · CAPA 경로를 쓰세요.',
    no_target: '정정 대상 값을 찾을 수 없습니다.',
    weigh_field_locked: '이 칭량 필드는 정정할 수 없습니다 — 잘못 잰 값은 재칭량으로 처리하세요.',
    orig_unsigned: '원 값이 아직 서명되지 않았습니다 — 정정 대신 그 단계에서 고치세요.',
    orig_sig_invalid: '원 서명이 이미 무효이거나 변조되었습니다 — 대상 슬롯을 먼저 다시 서명하세요.',
    orig_hash_mismatch: '화면 값이 원 서명 값과 다릅니다 — 정정할 수 없습니다. QA에 알리세요.',
    correction_open: '이 값에 열린 정정이 있습니다 ({correctionId}).',
    bad_value: '정정 값이 올바르지 않습니다 — 숫자 · 단위 · 자릿수를 확인하세요.',
    reason_code_unavailable: '사유 코드표(GCM)를 읽지 못했습니다 — 정정할 수 없습니다.',
    reason_code_required: '사유 코드를 고르세요.',
    bad_reason_code: '사용할 수 없는 사유 코드입니다.',
    reason_required_other: "사유 코드가 '기타'면 사유를 입력해야 합니다 (1–60자).",
    reason_too_long: '사유는 60자 이내로 입력하세요.',
    evidence_required: "이 사유 코드('전기 오류')는 증빙이 필요합니다."
  };
  /* 서명 단계 · 그 밖 (헬퍼 · RecSign 기존 문구 계열, §5.0 밖) */
  var WHY = {
    save_error: '저장 실패 — 정정 · 무효화 · RBE 모두 복원했습니다. 다시 시도하세요',
    RECORD_ROLLBACK: '저장 실패 — 정정 · 무효화 · RBE 모두 복원했습니다. 다시 시도하세요',
    same_person: '동일인 — {performer} 은 이 정정을 확인할 수 없습니다. 다른 QA 가 확인하세요',
    qual_missing: '자격 없음 — {qual} 없음 · 서명 불가',
    precheck_changed: '서명 창을 연 뒤 조건이 바뀌었습니다 — 창을 닫고 다시 여세요',
    not_draft: '작성 중 상태가 아닙니다', not_performed: 'QA 확인 대기 상태가 아닙니다', not_qa: '반려는 QA 만 할 수 있습니다',
    reason_required: '반려 사유를 입력하세요 (1–60자)',
    values_unavailable: '이 단계 서명 기록에 값 사본이 없습니다(이전 서명) — 생산 · 포장 실행 화면에서 정정하세요',
    role_denied: '역할 거부 — 이 서명 규칙의 허용 역할이 아닙니다',
    record_tampered: '정정 레코드 대조 불일치 — 처리할 수 없습니다',
    weigh_p1: '칭량 기록 정정은 P1 입니다',
    statement_mismatch: '서명 문장이 바뀌었습니다 — 창을 닫고 다시 여세요',
    locked: '계정이 잠겼습니다', rule_missing: '서명 규칙 미등록',
    not_connected: '정정 API 미연결 — 정정 저장소(ebr-correction-store.js)가 준비되지 않아 진행할 수 없습니다'
  };

  function whyMsg(r, ctx) {
    r = r || {}; ctx = ctx || {};
    var w = r.why || r.code || 'unknown';
    if (WHY50[w]) return WHY50[w].replace('{correctionId}', r.correctionId || ctx.cor || '—') + ' (' + w + ')';
    var base = WHY[w];
    if (!base) return (r.message || '처리할 수 없습니다') + ' (' + w + ')';
    var m = base.replace('{performer}', r.performerId ? '정정 수행자 ' + r.performerId : ctx.performer ? '정정 수행자 ' + ctx.performer : '정정 수행자').replace('{qual}', r.qualId || 'QD-REVBATCH');
    if (w === 'not_connected' && r.fn) m += ' · ' + r.fn;
    return m + ' (' + w + ')';
  }
  function setErr(id, msg) { var e = $(id); if (!e) return; e.textContent = msg || ''; e.title = msg || ''; }

  /** 상태 배지 (ui-items §2 · J3) */
  var STATE = { DRAFT: ['muted', '작성 중'], PERFORMED: ['muted', 'QA 확인 대기'], VERIFIED: ['ok', '적용됨'], REJECTED: ['warn', '반려'] };
  function stateBadge(s) {
    if (s === 'CANCELLED') return '<span class="sub-info">취소됨</span>';
    var b = STATE[s]; return b ? '<span class="badge ' + b[0] + '">' + b[1] + '</span>' : '<span class="sub-info">' + esc(s || '—') + '</span>';
  }
  function stateText(s) { return s === 'CANCELLED' ? '취소됨' : (STATE[s] ? STATE[s][1] : (s || '—')); }

  /* ---------- 스타일 (토큰만) ---------- */
  var CSS = [
    '.corr-dlg .shell-body { display: flex; flex-direction: column; gap: var(--title-gap); overflow: hidden; }',
    '.corr-dlg .popup-title .text { display: inline-flex; align-items: center; gap: var(--title-gap); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '.corr-dlg .form-grid .field .text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }',
    '.corr-dlg .form-grid .field > .input { height: var(--ctrl-h-form); }',
    '.corr-dlg .corr-sec { display: flex; flex-direction: column; gap: var(--badge-gap); min-width: 0; }',
    '.corr-dlg .corr-cap { display: flex; align-items: center; gap: var(--title-gap); min-width: 0; }',
    '.corr-dlg .corr-orig.form-grid { background: var(--bc-gray-light); }',
    '.corr-dlg .corr-cnt { flex: 0 0 auto; white-space: nowrap; }',
    '.corr-dlg .corr-info { display: flex; align-items: center; min-height: var(--form-row-h); padding: 0 var(--grid-cell-pad); border: thin solid var(--c-border-05); background: var(--bc-gray-light); min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }',
    '.corr-dlg .sign-err { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
    '.corr-dlg .dialog-footer .sign-note { margin-right: auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }',
    '.corr-dlg .split.sign-split { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: var(--split-gutter); flex: 1 1 auto; min-height: 0; }',
    '.corr-dlg .split.sign-split > .grid-block { min-height: 0; min-width: 0; }',
    '.corr-dlg .grid-wrap { overflow: hidden; }',
    '.corr-dlg .grid td { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
    '.corr-dlg .auth-panel { overflow: hidden; }',
    '.corr-dlg .auth-row > .input { height: var(--ctrl-h-form); }',
    '.corr-dlg .auth-panel .sign-rule, .corr-dlg .auth-panel .qual-req, .corr-dlg .auth-panel .one-line { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }',
    '.corr-dlg .sign-statement { flex: 0 0 var(--form-row-h); height: var(--form-row-h); font-size: var(--fs-grid); overflow: hidden; }',
    '.corr-dlg .sign-statement > .stmt { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; line-height: 1.35; }',
    '.corr-dlg .col-k { width: var(--col-w-short); } .corr-dlg .col-v { width: var(--col-w-qty); } .corr-dlg .col-ts { width: var(--col-w-ts); }',
    '.corr-dlg .corr-band { flex: 0 0 var(--form-row-h); height: var(--form-row-h); display: flex; align-items: center; gap: var(--title-gap); padding: 0 var(--grid-cell-pad);',
    '  background: var(--bc-faulty); border-left: calc(var(--radius) * 2.5) solid var(--c-error); font-weight: bold; min-width: 0; overflow: hidden; white-space: nowrap; }',
    '.corr-dlg .corr-band > span:first-child { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }',
    '.corr-dlg .user-card { border: thin solid var(--c-border-04); border-radius: var(--radius); padding: var(--title-gap) var(--fs-grid); display: flex; align-items: baseline; gap: var(--title-gap); background: var(--c-board-normal); flex-wrap: wrap; }',
    '.corr-dlg .user-card .name { font-size: var(--fs-group); font-weight: bold; }',
    '.corr-dlg [hidden] { display: none !important; }',
    '.corr-rej-input { width: 100%; height: var(--ctrl-h-form); margin-top: var(--title-gap); }'
  ].join('\n');

  /* ---------- 마크업 ---------- */
  function authPanel(p) {
    return '<div class="auth-panel">' +
      '<div class="user-card" id="' + p + 'User"></div>' +
      '<span class="sub-info sign-rule" id="' + p + 'Rule"></span>' +
      '<div class="auth-row"><span class="label required">사용자 ID</span><input class="input" type="text" id="' + p + 'Id" placeholder="ID 직접 입력" autocomplete="off"></div>' +
      '<div class="auth-row"><span class="label required">비밀번호</span><input class="input" type="password" id="' + p + 'Pw" autocomplete="new-password"></div>' +
      '<div class="auth-row"><span class="label">코멘트</span><input class="input" type="text" id="' + p + 'Cmt" placeholder="선택 입력" autocomplete="off" maxlength="60"></div>' +
      '<div class="sign-err sub-info fc-fail" id="' + p + 'Err" role="alert"></div>' +
      '<div class="qual-msg" id="' + p + 'Qual" aria-live="polite"></div>' +
      '<span class="sub-info one-line">PoC 전용 — 실서비스는 LDAP(AM-IDPW)</span>' +
      '<span class="sub-info qual-req" id="' + p + 'QualReq"></span>' +
    '</div>';
  }
  var HTML =
  /* W2 */
  '<div class="dialog-backdrop" id="dlgCorrection"><div class="dialog corr-dlg">' +
    '<div class="popup-title"><span class="text" id="crTitle">값 정정 요청</span><button class="popup-close" type="button" data-dialog-close aria-label="Close"></button></div>' +
    '<div class="shell-body">' +
      '<div class="corr-sec"><div class="corr-cap"><span class="group-title">대상</span><span class="sub-info" id="crTgtNote"></span></div>' +
        '<div class="form-grid cols-2">' +
          '<span class="label required">정정 대상</span><span class="field span-2"><select class="input" id="crTarget" aria-label="정정 대상"></select></span>' +
        '</div></div>' +
      '<div class="corr-sec"><div class="corr-cap"><span class="group-title">원래 값 (보존 — 수정 불가)</span></div>' +
        '<div class="form-grid cols-2 readonly corr-orig" id="crOrig">' +
          '<span class="label">원래 값</span><span class="field"><span class="text" id="crBefore"></span></span>' +
          '<span class="label">기록 시각</span><span class="field"><span class="text" id="crRecAt"></span></span>' +
          '<span class="label">원 서명</span><span class="field"><span class="text" id="crSigs"></span></span>' +
          '<span class="label">원본 대조</span><span class="field"><span class="text" id="crHash"></span></span>' +
        '</div></div>' +
      '<div class="corr-sec"><div class="corr-cap"><span class="group-title">정정 값</span></div>' +
        '<div class="form-grid cols-2">' +
          '<span class="label required">정정 값</span><span class="field"><input class="input" type="text" id="crAfter" autocomplete="off" aria-label="정정 값"><span class="sub-info corr-cnt" id="crUom"></span></span>' +
          '<span class="label required">사유 코드</span><span class="field"><select class="input" id="crCode" aria-label="사유 코드"></select></span>' +
          '<span class="label" id="crReasonLbl">사유</span><span class="field"><input class="input" type="text" id="crReason" maxlength="60" autocomplete="off" aria-label="사유"><span class="sub-info corr-cnt" id="crCnt">0/60</span></span>' +
          '<span class="label" id="crEvLbl">증빙</span><span class="field"><input class="input" type="text" id="crEvidence" placeholder="파일 이름 (예: IMG_0412.jpg)" autocomplete="off" aria-label="증빙 파일 이름"><span class="sub-info corr-cnt">P0 파일 이름 문자열</span></span>' +
        '</div></div>' +
      '<div class="corr-info sub-info" id="crInfo">(i) 원래 값과 원 서명은 지우지 않습니다. QA 확인 시 원 서명이 무효화(ebr.esignVoid.v1)되고 정정 값이 유효 값이 됩니다. 출하 게이트 1 · 3 이 다시 평가됩니다.</div>' +
      '<div class="sign-err sub-info fc-fail" id="crErr" role="alert"></div>' +
    '</div>' +
    '<div class="dialog-footer"><span class="sub-info sign-note">저장 = DRAFT (서명 아님) · 사유 코드 = GCM EBR_CORR_REASON</span>' +
      '<button class="btn search secondary" type="button" data-dialog-close>취소</button>' +
      '<span class="tip" id="crGoTip"><button class="btn search primary" type="button" id="crGo" disabled>수행 서명 ›</button></span></div>' +
  '</div></div>' +
  /* W3 */
  '<div class="dialog-backdrop" id="dlgCorrSign"><div class="dialog corr-dlg">' +
    '<div class="popup-title"><span class="text"><span class="sign-meaning performed" title="서명 의미: 수행 (performed)"></span><span>전자서명 — 정정 수행 (Performed by)</span></span><button class="popup-close" type="button" data-dialog-close aria-label="Close"></button></div>' +
    '<div class="shell-body">' +
      '<div class="form-grid cols-2 readonly">' +
        '<span class="label">배치</span><span class="field"><span class="text" id="csBatch"></span></span>' +
        '<span class="label">대상</span><span class="field"><span class="text" id="csTgt"></span></span>' +
        '<span class="label">규칙</span><span class="field"><span class="text" id="csRuleF"></span></span>' +
        '<span class="label">서명자 (현재 사용자)</span><span class="field"><span class="text" id="csSigner"></span></span>' +
        '<span class="label">요구 인증</span><span class="field"><span class="text" id="csAuth"></span></span>' +
        '<span class="label">레코드 타입</span><span class="field"><span class="text">correction (값 정정)</span></span>' +
      '</div>' +
      '<div class="split sign-split">' +
        '<div class="grid-block"><div class="grid-toolbar"><span class="group-title">정정 내용</span><span class="spacer"></span><span class="sub-info" id="csHash"></span></div>' +
          '<div class="grid-wrap"><table class="grid"><colgroup><col class="col-k"><col class="col-v"><col class="col-ts"><col></colgroup>' +
          '<thead><tr><th>구분</th><th>값</th><th>기록</th><th>사유 · 증빙</th></tr></thead><tbody id="csBody"></tbody></table></div></div>' +
        authPanel('cs') +
      '</div>' +
      '<div class="sign-statement" id="csStmtBox"><span class="stmt" id="csStmt"></span></div>' +
    '</div>' +
    '<div class="dialog-footer"><span class="sub-info sign-note">서명 뒤 QA 확인 대기 · 값 · 사유 잠금</span>' +
      '<button class="btn search secondary" type="button" data-dialog-close>취소</button>' +
      '<span class="tip" id="csGoTip" title="ID · 비밀번호를 입력하세요"><button class="btn search primary" type="button" id="csGo" disabled>서명</button></span></div>' +
  '</div></div>' +
  /* W4 */
  '<div class="dialog-backdrop" id="dlgCorrVerify"><div class="dialog corr-dlg">' +
    '<div class="popup-title"><span class="text"><span class="sign-meaning verified" title="서명 의미: 확인 (verified)"></span><span>전자서명 — 정정 QA 확인 (Verified by)</span></span><button class="popup-close" type="button" data-dialog-close aria-label="Close"></button></div>' +
    '<div class="shell-body">' +
      '<div class="form-grid cols-2 readonly">' +
        '<span class="label">정정</span><span class="field"><span class="text" id="cvCor"></span></span>' +
        '<span class="label">대상</span><span class="field"><span class="text" id="cvTgt"></span></span>' +
        '<span class="label">규칙</span><span class="field"><span class="text" id="cvRuleF"></span></span>' +
        '<span class="label">서명자 (현재 사용자)</span><span class="field"><span class="text" id="cvSigner"></span></span>' +
      '</div>' +
      '<div class="corr-band" id="cvBand"><span id="cvBandText"></span><span class="badge error" id="cvBandBadge"></span></div>' +
      '<div class="split sign-split">' +
        '<div class="grid-block"><div class="grid-toolbar"><span class="group-title">비교</span><span class="spacer"></span><span class="sub-info" id="cvHash"></span></div>' +
          '<div class="grid-wrap"><table class="grid"><colgroup><col class="col-k"><col class="col-v"><col class="col-ts"><col></colgroup>' +
          '<thead><tr><th>구분</th><th>값</th><th>기록</th><th>서명</th></tr></thead><tbody id="cvBody"></tbody></table></div></div>' +
        authPanel('cv') +
      '</div>' +
      '<div class="sign-statement"><span class="stmt" id="cvStmt"></span></div>' +
    '</div>' +
    '<div class="dialog-footer"><span class="sub-info sign-note">반려 = 사유 1–60자 · 서명 없음 · 원 값 유지</span>' +
      '<button class="btn search secondary" type="button" data-dialog-close>취소</button>' +
      '<span class="tip" id="cvRejTip"><button class="btn search secondary" type="button" id="cvRej">반려 …</button></span>' +
      '<span class="tip" id="cvGoTip" title="ID · 비밀번호를 입력하세요"><button class="btn search primary" type="button" id="cvGo" disabled>확인 서명</button></span></div>' +
  '</div></div>';

  var mounted = false;
  function mount() {
    if (mounted || !doc.body) return; mounted = true;
    var st = doc.createElement('style'); st.id = 'corrUiStyle'; st.textContent = CSS; doc.head.appendChild(st);
    var host = doc.createElement('div'); host.id = 'corrUiHost'; host.innerHTML = HTML;
    while (host.firstChild) doc.body.appendChild(host.firstChild);
    bind();
  }

  /* ---------- #dlgCorrection ---------- */
  var cr = null;   /* {o, targets, codes, codesOk} */
  function selTarget() { if (!cr) return null; var i = +$('crTarget').value; return cr.targets[i] || null; }
  function selCode() { if (!cr || !cr.codesOk) return null; var v = $('crCode').value, f = null; cr.codes.forEach(function (c) { if (c.code === v) f = c; }); return f; }
  function yes(v) { return v === true || v === 'Y' || v === 'y'; }

  function loadCodes() {
    var a = api(), r = null;
    if (a && typeof a.reasonCodes === 'function') r = call('reasonCodes');
    else { var s = US(); if (s && typeof s.reasonCodes === 'function') { try { r = s.reasonCodes(); } catch (x) { r = null; } } }
    if (!r) return { ok: false, why: a ? 'reason_code_unavailable' : 'not_connected', fn: 'reasonCodes' };
    if (!r.ok || !Array.isArray(r.items)) return { ok: false, why: r.why || 'reason_code_unavailable' };
    return { ok: true, items: r.items.filter(function (c) { return c && c.active !== false; }).map(function (c) {
      return { code: c.code || c.key1, text: c.text || c.name || c.key1, freeRequired: yes(c.freeRequired != null ? c.freeRequired : c.data1), evidenceRequired: yes(c.evidenceRequired != null ? c.evidenceRequired : c.data2) };
    }) };
  }
  /* 실 API(개정 2): targetsFor 는 값 단위 항목 {target{…,valueIndex,valueKey}, label, stepLabel, current{value,uom,recordedAt,valuesHash,source,correctionId}, values[], origHashOk, correctable, why}.
     값 사본이 없는 옛 기록은 단계 1행(why 'values_unavailable') → 화면이 값 배열을 가지면(o.valuesFor) 그것으로 값 옵션을 만들고, 대조는 openCorrection 이 판정.
     옵션 = { t(항목), i(값 인덱스), v(원 값), vals(원 값 배열), eff{value,source,correctionId,original}, why } */
  function loadTargets(o) {
    var q = { kind: 'exec_value' }; if (o.scope) q.scope = o.scope; if (o.stepKey) q.stepKey = o.stepKey;
    var r = call('targetsFor', o.batchId, q);
    if (!r.ok) return r;
    var opts = [];
    (r.items || []).forEach(function (it) {
      var t = it.target || {};
      if (o.scope && t.scope !== o.scope) return;
      if (o.stepKey && t.stepKey !== o.stepKey) return;
      if (o.rbe && o.rbe.step && t.stepKey !== o.rbe.step) return;
      if (t.valueIndex != null) {
        if (o.valueIndex != null && t.valueIndex !== o.valueIndex) return;
        var vals = it.values || [], v = vals[t.valueIndex], c = it.current || {};
        opts.push({ t: it, i: t.valueIndex, v: v, vals: vals, store: true,
          eff: { value: c.value, source: c.source, correctionId: c.correctionId, original: valText(v) }, why: it.correctable === false ? it.why || 'orig_sig_invalid' : null });
        return;
      }
      var sv = null;
      if (it.why === 'values_unavailable' && typeof o.valuesFor === 'function') { try { sv = o.valuesFor(t.scope, t.stepKey); } catch (x) { sv = null; } }
      if (!Array.isArray(sv) || !sv.length) { if (o.valueIndex == null) opts.push({ t: it, i: -1, v: null, vals: null, why: it.why || 'values_unavailable' }); return; }
      var eff = call('effectiveValues', o.batchId, t.scope, t.stepKey, sv);
      sv.forEach(function (v, i) {
        if (o.valueIndex != null && i !== o.valueIndex) return;
        opts.push({ t: it, i: i, v: v, vals: sv, eff: eff.ok && eff.values ? eff.values[i] : null, why: null });
      });
    });
    return { ok: true, items: opts };
  }
  function valText(v) { return v == null ? '' : (typeof v === 'object' ? String(v.value == null ? '' : v.value) + (v.uom ? ' ' + v.uom : '') : String(v)); }
  /* 단계 표시 이름: 생산 = stepKey(OP3-2 표시 코드), 포장 = target.stepName → 없으면(이전 기록) targetLabel → stepKey 폴백 (빈 이름 금지) */
  function stepDisp(t, label) { t = t || {}; return t.scope === 'pack' ? (t.stepName || label || t.stepKey || '') : (global.TreeUi ? global.TreeUi.stepKeyText(t.stepKey) : (t.stepKey || '')); }   /* 반복 회차 N-030#2 → 'N-030 (반복 #2)' (X4) */
  function valLabel(op) { var l = op.t.target.valueLabel; if (l != null) return l; var v = op.v; return v && typeof v === 'object' ? (v.label || v.name || '') : ''; }
  function optLabel(op) {
    var t = op.t.target, sdp = stepDisp(t, op.t.targetLabel || op.t.label), base = op.t.stepLabel || (t.scope === 'pack' && /^포장 /.test(sdp) ? sdp : (t.scope === 'pack' ? '포장 ' : '생산 ') + sdp);   /* store label 은 valueKey(화면 해시일 수 있음)를 붙이므로 단계 라벨 + 값 라벨로 조립 */
    if (op.i < 0) return base + ' — ' + whyMsg({ why: op.why || 'values_unavailable' });
    var cur = op.eff && op.eff.source === 'correction' ? op.eff.value + ' (정정됨 · 원 ' + valText(op.v) + ')' : valText(op.v);
    return base + ' · 값 #' + (op.i + 1) + ' ' + valLabel(op) + ' — ' + cur + (op.t.critical ? ' (critical)' : '') + (op.why ? ' · 정정 불가' : '');
  }

  function open(o) {
    mount(); o = o || {};
    var g = canRequest();
    cr = { o: o, targets: [], codes: [], codesOk: false, blockWhy: null };
    var t = loadTargets(o), c = loadCodes();
    cr.targets = t.ok ? t.items : [];
    cr.codesOk = c.ok; cr.codes = c.ok ? c.items : [];
    var sd = o.stepKey ? (o.scope === 'pack' ? stepDisp((cr.targets[0] && cr.targets[0].t.target) || {}, cr.targets[0] && (cr.targets[0].t.targetLabel || cr.targets[0].t.label)) : o.stepKey) : '';
    $('crTitle').textContent = '값 정정 요청 — ' + (o.batchId || '배치 미지정') + (sd ? ' ' + sd : '') + (o.rbe ? ' · ' + o.rbe.id : '');
    $('crTitle').title = $('crTitle').textContent;
    txt('crTgtNote', (o.rbe ? 'RBE 예외 ' + o.rbe.id + ' · ' : '') + (o.scope === 'pack' ? '포장 실행' : o.scope === 'prod' ? '생산 실행' : '') + ' 서명 완료 값만');
    var ts = $('crTarget');
    ts.innerHTML = cr.targets.length ? cr.targets.map(function (op, k) {
      return '<option value="' + k + '"' + (op.i < 0 || op.why ? ' disabled' : '') + '>' + esc(optLabel(op)) + '</option>';
    }).join('') : '<option value="">' + esc(t.ok ? '정정 가능한 서명 완료 값이 없습니다' : whyMsg(t)) + '</option>';
    var first = -1; cr.targets.some(function (op, k) { if (op.i >= 0 && !op.why) { first = k; return true; } return false; });
    if (first < 0 && cr.targets.length) first = 0;
    ts.value = first >= 0 ? String(first) : ''; ts.disabled = !cr.targets.length || o.valueIndex != null;   /* 값 행 [정정] = 대상 고정(읽기 전용), 출하 게이트 경로만 콤보 */
    $('crCode').innerHTML = cr.codesOk ? '<option value="">— 선택</option>' + cr.codes.map(function (x) { return '<option value="' + esc(x.code) + '">' + esc(x.text) + '</option>'; }).join('')
      : '<option value="">코드표 읽기 실패</option>';
    $('crCode').disabled = !cr.codesOk;
    $('crAfter').value = ''; $('crReason').value = ''; $('crEvidence').value = '';
    cr.blockWhy = !g.ok ? { why: g.why === 'rule_missing' ? 'not_connected' : g.why, message: g.tip, fn: g.why === 'rule_missing' ? 'getSignRule(SM-PERF-CORR)' : '' }
      : !t.ok ? t : !c.ok ? c : null;
    fillTarget(); sync();
    if (cr.blockWhy) setErr('crErr', WHY50[cr.blockWhy.why] || cr.blockWhy.why === 'not_connected' ? whyMsg(cr.blockWhy) : (cr.blockWhy.message || whyMsg(cr.blockWhy)) + ' (' + cr.blockWhy.why + ')');
    MesUI.openDialog('dlgCorrection');
    return { ok: !cr.blockWhy, why: cr.blockWhy && cr.blockWhy.why };
  }
  function fillTarget() {
    var op = selTarget(), it = op && op.t;
    setErr('crErr', cr && cr.blockWhy ? $('crErr').textContent : '');
    txt('crBefore', op && op.i >= 0 ? valText(op.v) + (op.eff && op.eff.source === 'correction' ? ' · 유효 값 ' + op.eff.value + ' (' + op.eff.correctionId + ')' : '') + (it.critical ? ' · critical' : '') : '');
    var perf = it && (it.signatures || []).filter(function (x) { return x.slot === 'perform'; })[0];
    txt('crRecAt', perf ? '수행 서명 ' + perf.signatureId : '');
    txt('crSigs', it && it.signatures ? it.signatures.map(function (x) { return x.slot + ' ' + (x.signerId || '') + ' ' + (x.signatureId || '') + (x.validity && x.validity !== 'valid' ? ' [' + x.validity + ']' : ''); }).join(' / ') : '');
    var hEl = $('crHash');
    if (!op || op.i < 0) hEl.textContent = '—';
    else if (op.store) {
      var c = it.current || {};
      hEl.innerHTML = '<span class="mono">' + esc(short(c.valuesHash || '')) + '…</span> ' + (it.origHashOk ? '<span class="badge ok">일치</span>' : '<span class="badge error">불일치</span>');
      hEl.title = '원 서명 valueHash ' + (c.valuesHash || '') + ' · 실행 기록 값 사본과 대조';
      if (c.recordedAt) txt('crRecAt', '수행 서명 ' + (perf ? perf.signatureId : '') + ' · ' + fmt(c.recordedAt));
    } else {
      var S = US(), h = '';
      try { h = S && typeof S.computeValueHash === 'function' ? S.computeValueHash({ batchId: cr.o.batchId, scope: it.target.scope, stepKey: it.target.stepKey, values: op.vals }) : ''; } catch (x) { h = ''; }
      hEl.innerHTML = '<span class="mono">' + esc(short(h)) + '…</span> <span class="badge muted">요청 시 store 대조</span>';
      hEl.title = '화면 값 valueHash ' + h + ' — 값 사본 없는 옛 기록: 원 서명 valueHash 대조는 openCorrection 이 판정';
    }
    txt('crUom', op && op.store && op.t.current && op.t.current.uom ? op.t.current.uom : op && op.v && op.v.uom ? op.v.uom : '');
    if (op && (op.i < 0 || op.why)) setErr('crErr', whyMsg({ why: op.why || 'values_unavailable' }, { batch: cr && cr.o.batchId }));
  }
  function sync() {
    if (!cr) return;
    var code = selCode(), freeReq = !!(code && code.freeRequired), evReq = !!(code && code.evidenceRequired);
    $('crReasonLbl').classList.toggle('required', freeReq);
    $('crReason').placeholder = freeReq ? '사유를 입력하세요 (1–60자)' : '선택 입력 (0–60자)';
    $('crEvLbl').classList.toggle('required', evReq);
    $('crCnt').textContent = $('crReason').value.length + '/' + MAX_REASON;
    var it = selTarget();
    var ready = !cr.blockWhy && it && it.i >= 0 && !it.why && $('crAfter').value.trim() && code;
    $('crGo').disabled = !ready;
    $('crGoTip').title = cr.blockWhy ? (cr.blockWhy.message || whyMsg(cr.blockWhy)) : !it ? '정정 대상을 고르세요' : !$('crAfter').value.trim() ? '정정 값을 입력하세요' : !code ? '사유 코드를 고르세요' : '';
  }
  function requireInput(el, ok) { el.classList.toggle('error', !ok); if (!ok) el.focus(); return ok; }
  function go() {
    if (!cr || $('crGo').disabled) return;
    var it = selTarget(), code = selCode(), reason = $('crReason').value.trim(), ev = $('crEvidence').value.trim();
    setErr('crErr', '');
    if (code.freeRequired && !requireInput($('crReason'), !!reason)) return setErr('crErr', whyMsg({ why: 'reason_required_other' }));
    if (code.evidenceRequired && !requireInput($('crEvidence'), !!ev)) return setErr('crErr', whyMsg({ why: 'evidence_required' }));
    var o = cr.o;
    var tg = it.t.target, uom = (it.store && it.t.current && it.t.current.uom) || (it.v && it.v.uom) || undefined;
    var r = call('openCorrection', { batchId: o.batchId, target: { kind: 'exec_value', scope: tg.scope, stepKey: tg.stepKey, stepName: tg.stepName, valueIndex: it.i, valueKey: it.store ? tg.valueKey : (it.v && it.v.key) || '', valueLabel: valLabel(it), uom: uom }, values: it.store ? undefined : it.vals,
      after: { value: $('crAfter').value.trim(), uom: uom }, reasonCode: code.code, reason: reason, evidence: ev ? [ev] : [], critical: it.t.critical !== false, screen: o.screen || SCREEN_DEFAULT });
    if (!r.ok) { setErr('crErr', whyMsg(r, { batch: o.batchId })); return; }
    var id = r.correction && r.correction.correctionId;
    MesUI.closeDialog('dlgCorrection');
    toast('정정 저장 (작성 중) — ' + (id || ''), 'info', 2400);
    if (o.onDraft) try { o.onDraft(r); } catch (x) { if (global.console) console.warn(x); }
    openPerform(id, { screen: o.screen, onDone: o.onDone, onCancel: o.onDone });
  }

  /* ---------- 서명 창 공통 ---------- */
  var sg = null;   /* {p:'cs'|'cv', ticket, target, o, done, busy, id} */
  function userCard(p) {
    var u = curUser(), host = $(p + 'User'); if (!host) return;
    host.innerHTML = u ? '<span class="name">' + esc(u.name) + '</span><span class="sub-info">' + esc(u.userId) + '</span><span class="sub-info">' + esc(rolesOf(u).join(' · ')) + '</span>' : '<span class="sub-info">현재 사용자 없음 — ID · 비밀번호로 서명자를 확인합니다</span>';
  }
  function ruleLine(rl, extra) { return rl ? (rl.id || '?') + ' v' + (rl.ver == null ? '?' : rl.ver) + ' · 허용 ' + ((rl.allowedRoles || rl.roles || []).join(' · ') || '—') + (extra ? ' · ' + extra : '') : '규칙 정보 없음'; }
  function signInput(p) { var ok = !!($(p + 'Id').value.trim() && $(p + 'Pw').value); $(p + 'Go').disabled = !ok || !!(sg && sg.busy); $(p + 'GoTip').title = ok ? '' : 'ID · 비밀번호를 입력하세요'; }
  function prepAuth(p, t) {
    var u = curUser();
    userCard(p);
    $(p + 'Id').value = u ? u.userId : ''; $(p + 'Pw').value = ''; $(p + 'Cmt').value = '';
    setErr(p + 'Err', ''); $(p + 'Qual').innerHTML = '';
    var q = (t.qualReq || []).map(function (x) { return (x.qualId || '') + (x.name ? ' ' + x.name : ''); });
    txt(p + 'QualReq', '요구 자격: ' + (q.length ? q.join(' · ') : '없음'));
    signInput(p);
  }
  function beginFail(r, id) { toast(whyMsg(r) + (id ? ' — ' + id : ''), r.why === 'not_connected' ? 'warn' : 'error', 3600); return r; }

  function openPerform(id, o) {
    mount(); o = o || {};
    var r = call('beginPerformSign', id, { screen: o.screen || SCREEN_DEFAULT });
    if (!r.ok || !r.ticket) return beginFail(r, id);
    var t = r.target || {}, gc = call('getCorrection', id), c = gc.ok ? gc.correction : {}, sc = t.statementCtx || {};
    t.batchId = c.batchId || sc.batchId; t.targetLabel = c.targetLabel || sc.targetLabel; t.reasonCode = c.reasonCode; t.reasonCodeText = c.reasonCodeText; t.reason = c.reason; t.evidence = c.evidence;
    t.beforeHash = t.beforeHash || (c.before && c.before.valuesHash); t.afterHash = t.afterHash || (c.after && c.after.valuesHash);
    sg = { p: 'cs', ticket: r.ticket, target: t, o: o, done: false, busy: false, id: id };
    txt('csBatch', t.batchId || (t.correction && t.correction.batchId) || '');
    txt('csTgt', (id || '') + ' · ' + (t.targetLabel || '') + ' ' + vu(t.before) + ' → ' + vu(t.after));
    txt('csRuleF', t.rule ? t.rule.id + ' v' + t.rule.ver : 'SM-PERF-CORR', ruleLine(t.rule));
    var u = curUser(); txt('csSigner', u ? u.name + ' (' + u.userId + ')' : '— (ID 입력으로 확인)');
    txt('csAuth', t.authText || 'ID + 비밀번호');
    txt('csRule', ruleLine(t.rule));
    txt('csHash', 'beforeHash ' + short(t.beforeHash) + ' · afterHash ' + short(t.afterHash));
    var rs = t.reasonCodeText || '';
    $('csBody').innerHTML = '<tr><td>원래</td><td title="' + esc(vu(t.before)) + '">' + esc(vu(t.before)) + '</td><td>' + esc(fmt(t.before && t.before.recordedAt) || '—') + '</td><td>원 서명 보존 · QA 확인 시 무효화</td></tr>' +
      '<tr><td>정정</td><td title="' + esc(vu(t.after)) + '">' + esc(vu(t.after)) + '</td><td>이 서명 시각</td><td title="' + esc(rs + ' ' + (t.reason || '')) + '">' + esc(rs + (t.reason ? ' — ' + t.reason : '') + (t.evidence && t.evidence.length ? ' · 증빙 ' + t.evidence.join(', ') : '')) + '</td></tr>';
    txt('csStmt', t.statement || ''); $('csStmtBox').title = t.statement || '';
    prepAuth('cs', t);
    MesUI.openDialog('dlgCorrSign');
    setTimeout(function () { ($('csId').value ? $('csPw') : $('csId')).focus(); }, 0);
    return r;
  }
  function openVerify(id, o) {
    mount(); o = o || {};
    var r = call('beginVerifySign', id, { screen: o.screen || SCREEN_DEFAULT });
    if (!r.ok || !r.ticket) return beginFail(r, id);
    var t = r.target || {}, gc = call('getCorrection', id), c = gc.ok ? gc.correction : {}, sc = t.statementCtx || {};
    var pf = t.performer || (c.performed ? { userId: c.performed.userId, name: c.performed.userName } : {}), vp = t.voidPreview || [];
    t.batchId = c.batchId || sc.batchId; t.targetLabel = c.targetLabel || sc.targetLabel; t.reasonCode = c.reasonCode; t.reasonCodeText = c.reasonCodeText; t.reason = c.reason; t.evidence = c.evidence;
    t.performedAt = c.performed && c.performed.at; t.performSignatureId = c.performed && c.performed.signatureId; t.beforeHash = c.before && c.before.valuesHash;
    t.rbePreviewId = t.rbePreviewId || t.rbePreview;
    sg = { p: 'cv', ticket: r.ticket, target: t, o: o, done: false, busy: false, id: id, pf: pf };
    txt('cvCor', (id || '') + ' · 수행 ' + (pf.userId || '') + (t.performedAt ? ' ' + fmt(t.performedAt).slice(11, 16) : ''), (id || '') + ' · 정정 수행 ' + (pf.userId || '') + ' ' + fmt(t.performedAt) + ' (원 수행자와 같을 필요 없음)');
    txt('cvTgt', (t.batchId || '') + ' ' + (t.targetLabel || ''));
    txt('cvRuleF', (t.rule ? t.rule.id + ' v' + t.rule.ver : 'SM-VERI-CORR') + ' · 동일인 차단: 정정 수행자 ' + (pf.userId || '—'), ruleLine(t.rule));
    var u = curUser(); txt('cvSigner', u ? u.name + ' (' + u.userId + ')' : '— (ID 입력으로 확인)');
    txt('cvBandText', '(!) 서명하면 원 서명 ' + vp.length + '건 무효화 + RBE 예외 ' + (t.rbePreviewId || '1건') + ' 생성 — 되돌릴 수 없음');
    $('cvBandBadge').textContent = '무효화 ' + vp.length;
    txt('cvRule', ruleLine(t.rule, '동일인 차단: ' + (pf.userId || '—')));
    txt('cvHash', '원 valueHash ' + short(t.beforeHash) + ' · ' + (t.origHashOk === false ? '불일치' : '대조 일치'));
    $('cvBody').innerHTML = '<tr><td>원래</td><td>' + esc(vu(t.before)) + '</td><td>' + esc(fmt(t.before && t.before.recordedAt) || '—') + '</td><td title="' + esc(vp.join(' / ')) + '">' + esc(vp.join(' / ') || '—') + ' → 무효화</td></tr>' +
      '<tr><td>정정</td><td>' + esc(vu(t.after)) + '</td><td>' + esc(fmt(t.performedAt) || '—') + '</td><td>' + esc((t.performSignatureId || '') + ' ' + (pf.userId || '') + ' (SM-PERF-CORR)') + '</td></tr>' +
      '<tr><td>사유</td><td colspan="3" title="' + esc((t.reasonCodeText || '') + ' ' + (t.reason || '')) + '">' + esc((t.reasonCodeText || '') + (t.reason ? ' — ' + t.reason : '') + ' · 증빙 ' + ((t.evidence || []).length)) + '</td></tr>';
    txt('cvStmt', t.statement || '');
    var qa = canVerify(); $('cvRej').disabled = !qa.ok; $('cvRejTip').title = qa.ok ? '' : qa.tip;
    prepAuth('cv', t);
    MesUI.openDialog('dlgCorrVerify');
    setTimeout(function () { ($('cvId').value ? $('cvPw') : $('cvId')).focus(); }, 0);
    return r;
  }
  function sign() {
    if (!sg || sg.busy) return;
    var p = sg.p;
    var inp = { userId: $(p + 'Id').value.trim(), password: $(p + 'Pw').value, statement: $(p + 'Stmt').textContent };
    var c = $(p + 'Cmt').value.trim(); if (c) inp.comment = c;
    sg.busy = true; signInput(p);
    var r = call('signAndCommit', sg.ticket, inp);
    sg.busy = false; $(p + 'Pw').value = '';
    var dlg = p === 'cs' ? 'dlgCorrSign' : 'dlgCorrVerify';
    if (r.ok) {
      var o = sg.o; sg.done = true; MesUI.closeDialog(dlg);
      toast((p === 'cs' ? '정정 수행 서명 — QA 확인 대기 ' : '정정 적용 — 원 서명 ' + ((r.voidIds || []).length) + '건 무효 · ' + (r.rbeExceptionId || '')) + ' ' + (r.signatureId || ''), 'ok', 3000);
      if (o.onDone) try { o.onDone(r); } catch (x) { if (global.console) console.warn(x); }
      return r;
    }
    var w = r.why || r.code;
    if (w === 'locked' || w === 'LOCKED' || r.locked) { MesUI.closeDialog(dlg); MesUI.alert(r.message || '계정이 잠겼습니다 — 관리자(ADMIN)에게 해제를 요청하세요.', 'Error'); return r; }
    var pf = (sg.pf || sg.target.performer || {}).userId;
    var m = w === 'same_person' || !r.message ? (WHY[w] ? whyMsg(r, { performer: pf }) : '서명 거부 (' + w + ')') : r.message + ' (' + w + ')';
    if (r.failCount != null && !/실패 \d/.test(m)) m += ' · 실패 ' + r.failCount + '/5';
    setErr(p + 'Err', m);   /* 저장 실패(save_error)도 창 유지 · 비밀번호 비움 (CF-05 #7) */
    if (w === 'qual_missing' || w === 'qual_expired') $(p + 'Qual').innerHTML = '<span class="badge error">자격 없음</span><span class="sub-info">' + esc(r.qualId || '') + '</span>';
    signInput(p);
    return r;
  }

  /* ---------- 반려 (MesUI.confirm + 입력 1칸, 1–60자, 서명 없음 — K-8) ---------- */
  function reject(id, o) {
    mount(); o = o || {};
    var qa = canVerify();
    if (!qa.ok) { toast(qa.tip, 'warn'); return { ok: false, why: qa.why }; }
    if (!has('rejectCorrection')) { toast(whyMsg({ why: 'not_connected', fn: 'rejectCorrection' }), 'warn'); return { ok: false, why: 'not_connected' }; }
    var b = MesUI.confirm('정정 ' + id + ' 을(를) 반려합니다. 원래 값이 그대로 유효합니다.\n반려 사유 (1–60자, 서명 없음)', function () {
      var v = (inp.value || '').trim();
      if (!v || v.length > MAX_REASON) { toast(whyMsg({ why: v ? 'reason_too_long' : 'reason_required' }), 'warn'); setTimeout(function () { reject(id, o); }, 0); return; }
      var r = call('rejectCorrection', id, { reason: v, screen: o.screen || SCREEN_DEFAULT });
      if (!r.ok) { toast(whyMsg(r), 'error', 3600); return; }
      if ($('dlgCorrVerify').classList.contains('open')) MesUI.closeDialog('dlgCorrVerify');
      toast('정정 반려 — ' + id, 'warn', 2600);
      if (o.onDone) try { o.onDone(r); } catch (x) { if (global.console) console.warn(x); }
    }, { title: '정정 반려', okText: '반려', cancelText: '취소' });
    var body = b && b.querySelector('.msg-body');
    var inp = doc.createElement('input'); inp.className = 'input corr-rej-input'; inp.maxLength = MAX_REASON; inp.placeholder = '반려 사유 (1–60자)'; inp.setAttribute('aria-label', '반려 사유');
    if (body) { body.appendChild(inp); setTimeout(function () { inp.focus(); }, 0); }
    return { ok: true, pending: true };
  }

  function bind() {
    $('crTarget').addEventListener('change', function () { setErr('crErr', cr && cr.blockWhy ? $('crErr').textContent : ''); fillTarget(); sync(); });
    ['crAfter', 'crReason', 'crEvidence'].forEach(function (id) { $(id).addEventListener('input', function () { $(id).classList.remove('error'); sync(); }); });
    $('crCode').addEventListener('change', sync);
    $('crGo').addEventListener('click', go);
    $('dlgCorrection').addEventListener('dialogclose', function () { cr = null; });
    ['cs', 'cv'].forEach(function (p) {
      [p + 'Id', p + 'Pw'].forEach(function (id) { $(id).addEventListener('input', function () { signInput(p); }); });
      $(p + 'Pw').addEventListener('keydown', function (ev) { if (ev.key === 'Enter' && !$(p + 'Go').disabled) sign(); });
      $(p + 'Go').addEventListener('click', sign);
    });
    $('cvRej').addEventListener('click', function () { if (sg && sg.p === 'cv') reject(sg.id, sg.o); });
    ['dlgCorrSign', 'dlgCorrVerify'].forEach(function (d) {
      $(d).addEventListener('dialogclose', function () {
        if (!sg) return; var s = sg; sg = null;
        if (!s.done) { if (has('cancel')) call('cancel', s.ticket, { reason: 'user_cancel' }); if (s.o.onCancel) try { s.o.onCancel(); } catch (x) { if (global.console) console.warn(x); } }
      });
    });
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', mount); else mount();

  global.CorrUI = {
    api: api, has: has, call: call, open: open, openPerform: openPerform, openVerify: openVerify, reject: reject,
    canRequest: canRequest, canVerify: canVerify, whyMsg: whyMsg, stateBadge: stateBadge, stateText: stateText, WHY: WHY,
    fmt: fmt, vu: vu, esc: esc
  };
})(window);
