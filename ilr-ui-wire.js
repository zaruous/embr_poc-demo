/* ilr-ui-wire.js — 인터록 규칙 화면(S-48 · S-23 · 생산 · 포장) 연결 지점 1곳
 *
 *  화면은 window.IlApi · window.IlUi 만 부른다. 판정 · 저장 · 서명은 모두 실제 store:
 *    window.EbrInterlock (assets/ebr-interlock.js — ruleSetFor · evaluate · explain · logHit · requestOverride · signAndCommit · overrideState · demoPreset · reasonCodes · COND_TYPES · POINTS · GRADE_CLASS)
 *    MS.ilrSets · ilrGet · ilrValidateRules · ilrNewVersion · ilrSaveDraft · ilrRequestReview · ilrBeginSign · ilrDiff (master-setup/assets/shared-store.js)
 *    EbrUserSession.signAndCommitRecord / cancelRecordSign (서명 커밋)
 *  store 가 없으면 목업 없이 fail-closed — 판정은 block(ilr_store_error), 저장 · 서명은 거부. IlApi.src() === 'none'.
 */
(function (g) {
  'use strict';
  var GRADES = ['Absolute', 'Hard-QA', 'Controlled', 'Warning'];
  var GRADE_CLASS = { Absolute: 'il-abs', 'Hard-QA': 'il-hardqa', Controlled: 'il-ctrl', Warning: 'il-warn' };
  var BANNER_CLASS = { Absolute: 'absolute', 'Hard-QA': 'hardqa', Controlled: 'controlled', Warning: 'warning' };
  var GRADE_TEXT = { Absolute: '멈춤', 'Hard-QA': 'QA 호출', Controlled: '감독자 승인', Warning: '확인 후 진행' };
  var POINTS = ['weigh.gate', 'weigh.tolerance', 'exec.step', 'exec.sign', 'pack.scan', 'pack.reconcile', 'pack.equipment', 'pack.step'];
  function P(key, label, type, o) { var p = { key: key, label: label, type: type, required: true }; for (var k in (o || {})) p[k] = o[k]; return p; }
  var NOPARAM = { 'snapshot.present': '발행 스냅샷', 'lot.reserved': '예약 LOT', 'lot.matMatch': '자재 일치', 'lot.released': 'LOT 적합', 'lot.retestPassed': '재시험일 경과',
    'lot.expired': '유효기간 경과', 'lot.short': 'LOT 잔량', 'bal.state': '저울 상태', 'bal.calExpired': '저울 교정 만료', 'bal.dailyCheck': '저울 일상 점검', 'bal.range': '저울 용량',
    'bal.qualified': '저울 적격', 'room.clean': '칭량실 청정', 'dev.openWeigh': '열린 칭량 일탈', 'il.activeAbsolute': '활성 Absolute', 'eq.calExpired': '설비 교정 만료', 'step.sequence': '단계 순서' };
  var COND_TYPES = {
    'lot.dateNear': { label: '날짜 임박', params: [P('days', 'days', 'int', { unit: '일', min: 1, max: 365, def: 30 })] },
    'bal.calDueSoon': { label: '교정 임박', params: [P('days', 'days', 'int', { unit: '일', min: 1, max: 90, def: 7 })] },
    'eq.calDueSoon': { label: '교정 임박', params: [P('days', 'days', 'int', { unit: '일', min: 1, max: 90, def: 14 })] },
    'tol.outOfRange': { label: '허용오차 반복 이탈', params: [P('maxAttempts', 'maxAttempts', 'int', { unit: '회', min: 1, max: 5, def: 2 })] },
    'range': { label: '범위 밖', params: [P('field', 'field', 'field'), P('lo', 'lo', 'number', { min: -1e6, max: 1e6 }), P('hi', 'hi', 'number', { min: -1e6, max: 1e6 }), P('unit', 'unit', 'string', { max: 8, required: false })] },
    'below': { label: '하한 미만', params: [P('field', 'field', 'field'), P('lo', 'lo', 'number', { min: -1e6, max: 1e6 }), P('unit', 'unit', 'string', { max: 8, required: false })] },
    'hold.exceeded': { label: '보류 시간 초과', params: [P('min', 'min', 'int', { unit: '분', min: 1, max: 10080 })] },
    'eq.qualified': { label: '장비 적격', params: [P('opIds', 'opIds', 'string[]')] },
    'scan.match': { label: '스캔 일치', params: [P('fields', 'fields', 'enum[]', { options: ['code', 'lot', 'ver', 'qc', 'exp'] })] }
  };
  Object.keys(NOPARAM).forEach(function (k) { COND_TYPES[k] = { label: NOPARAM[k], params: [] }; });
  var WHY = {
    override_p1: 'Hard-QA 승인은 다음 단계(P1)에서 제공합니다 — QA 호출.',
    floor_violation: 'Absolute 잠금 규칙은 등급을 낮출 수 없습니다.', bad_param: '파라미터가 올바르지 않습니다 — {key}: {range}.', unknown_cond: '알 수 없는 조건 유형입니다.',
    review_missing: '검토 서명이 없어 승인할 수 없습니다.', same_person: '작성자 · 검토자 · 승인자는 서로 달라야 합니다.', ilr_store_error: '인터록 규칙을 읽을 수 없어 진행할 수 없습니다.',
    floor_uncovered: "제품 하한 Absolute 항목 '{item}'을 덮는 잠금 규칙이 없습니다.", no_effective_set: '효력 중인 인터록 룰 세트가 없습니다 — 진행할 수 없습니다.',
    bad_rule_id: '규칙 ID 형식이 올바르지 않습니다 (예: IL-PK-YIELD).', dup_rule_id: '같은 규칙 ID가 이미 있습니다 — 규칙 ID는 재사용할 수 없습니다.', unknown_point: '알 수 없는 평가 지점입니다.',
    override_not_allowed: 'Absolute 인터록은 승인으로 진행할 수 없습니다.', override_used: '이 배치에서 이미 승인을 사용했습니다.',
    reason_code_unavailable: '사유 코드표(GCM)를 읽지 못했습니다 — 진행할 수 없습니다.', reason_code_required: '사유 코드를 고르세요.', bad_reason_code: '사용할 수 없는 사유 코드입니다.',
    reason_required_other: "사유 코드가 '기타'면 사유를 입력해야 합니다 (1–60자).", reason_too_long: '사유는 60자 이내로 입력하세요.', reason_required: '사유를 입력하세요 (1–60자).',
    role_restricted: '이 서명은 허용 역할이 제한되어 있습니다.', no_role: '역할 없음 — 보기만 가능합니다.', no_current_user: '사용자를 선택하세요.',
    not_current_user: '현재 사용자와 다른 ID로는 서명할 수 없습니다 — 상단에서 사용자를 전환한 뒤 다시 서명하세요.', bad_password: '비밀번호가 올바르지 않습니다.',
    draft_exists: '진행 중인 draft · 검토 버전이 이미 있습니다.', not_draft: 'draft 상태에서만 할 수 있습니다.', not_review: '검토 요청 상태에서만 서명할 수 있습니다.',
    no_session: '사용자 API(ebr-user-session.js)를 읽지 못했습니다.', ticket_closed: '서명 창이 닫혔습니다 — 다시 여세요.', author_only_qa: '편집 · 저장 · 검토 요청은 QA 만 할 수 있습니다.'
  };
  var REASONS = [];   /* EBR_OVR_REASON(GCM 4종)은 store reasonCodes() 에서만 — 없으면 빈 목록(승인 불가) */
  var SIGN_RULES = {   /* 설계 §4 표 그대로 (store 규칙이 없을 때 표시용) */
    'SM-REV-ILR': { id: 'SM-REV-ILR', ver: 1, meaning: 'reviewed', roles: ['SV', 'QA'], qual: 'QD-REVBATCH', kind: 'interlock_rule_review' },
    'SM-APPR-ILR': { id: 'SM-APPR-ILR', ver: 1, meaning: 'approved', roles: ['QA'], qual: 'QD-REVBATCH', kind: 'interlock_rule_approve' },
    'SM-APPR-CTRL': { id: 'SM-APPR-CTRL', ver: 1, meaning: 'approved', roles: ['SV'], qual: 'QD-EXEC-VERI', kind: 'interlock_override' }
  };
  var DEMO_PRESETS = ['재시험일 경과 LOT', 'IPC 이탈', '보류 초과', '교정 임박', '장비 적격 실패', '정상'];

  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function fill(t, v) { return String(t || '').replace(/\{(\w+)\}/g, function (m, k) { return v && v[k] != null ? v[k] : m; }); }
  function whyText(why, vars) { return fill(WHY[why] || ('처리할 수 없습니다 (' + why + ')'), vars) + (WHY[why] ? ' (' + why + ')' : ''); }
  function hash8(s) { var h = 2166136261; s = String(s); for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 16777619) >>> 0; } return ('0000000' + h.toString(16)).slice(-8); }
  function rank(gr) { var i = GRADES.indexOf(gr); return i < 0 ? 9 : i; }
  function sortHits(h) { return h.sort(function (a, b) { return rank(a.grade) - rank(b.grade) || (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0); }); }
  function sess() { return g.EbrUserSession || null; }
  function curUser() { var s = sess(); try { return s && s.getCurrentUser ? s.getCurrentUser() : null; } catch (x) { return null; } }
  function rolesOf(id) { var s = sess(); try { var r = s && s.rolesOf ? s.rolesOf(id) : []; return Array.isArray(r) ? r : (r && r.roles) || []; } catch (x) { return []; } }

  function overrideStmt(batchId, h, codeText, reason) {
    return '본인은 배치 ' + (batchId || '—') + ' 인터록 ' + h.ruleId + ' (' + (h.value == null ? '—' : h.value) + (h.cond && h.cond.unit ? ' ' + h.cond.unit : '') + ') 의 진행을 승인합니다. 사유: ' + (codeText || '—') + (reason ? ' — ' + reason : '') + ' (Approved by)';
  }
  function show(v) { return v == null ? '—' : typeof v === 'object' ? condText(v) : String(v); }
  function condText(c) { if (!c || !c.type) return '—'; var ct = COND_TYPES[c.type]; if (!ct || !ct.params.length) return c.type; return c.type + ' (' + ct.params.map(function (p) { var v = c[p.key]; return p.key + ' ' + (Array.isArray(v) ? v.join(',') : v == null ? '—' : v); }).join(' · ') + ')'; }
  function paramText(c) {
    if (!c) return '—'; var ct = COND_TYPES[c.type]; if (!ct || !ct.params.length) return '—';
    var n = function (v) { return typeof v === 'number' && v % 1 === 0 && c.unit === '%' ? v.toFixed(1) : v; };
    if (c.type === 'range') return n(c.lo) + ' ~ ' + n(c.hi) + (c.unit ? ' ' + c.unit : '');
    if (c.type === 'below') return '< ' + n(c.lo) + (c.unit ? ' ' + c.unit : '');
    return ct.params.map(function (p) { var v = c[p.key]; return p.key + ' ' + (Array.isArray(v) ? v.join(' · ') : v); }).join(' · ');
  }

  /* ================================================================ STORE 어댑터 */
  function store() { var E = g.EbrInterlock; return E && typeof E.evaluate === 'function' ? E : null; }
  function src() { return store() ? 'store' : 'none'; }
  function NA() { return { ok: false, why: 'ilr_store_error', message: whyText('ilr_store_error'), result: 'block', hits: [], open: [] }; }   /* store 없음 → fail-closed */
  function via(fn) {
    return function () {
      var E = store(), a = arguments;
      if (!E) return NA();
      if (typeof E[fn] !== 'function') return { ok: false, why: 'not_implemented', message: 'EbrInterlock.' + fn + ' 미구현' };
      try { return E[fn].apply(E, a); } catch (x) { if (g.console) console.error('[EbrInterlock] ' + fn, x); return NA(); }
    };
  }
  function ms(fn) { return g.MS && typeof g.MS[fn] === 'function' ? g.MS : null; }
  var IlApi = {
    src: src, GRADES: GRADES, GRADE_TEXT: GRADE_TEXT, POINTS: POINTS, WHY: WHY, REASONS: REASONS,   /* store 연결 시 POINTS(exec.order 포함) · WHY · REASONS 는 아래 sync() 가 store 값으로 맞춤 */ SIGN_RULES: SIGN_RULES, DEMO_PRESETS: DEMO_PRESETS,
    condTypes: function () { var E = store(); return (E && E.COND_TYPES) || COND_TYPES; },
    gradeClass: function (gr) { var E = store(); return ((E && E.GRADE_CLASS) || GRADE_CLASS)[gr] || ''; },
    ruleSetFor: via('ruleSetFor'),
    evaluate: function (point, ctx) {
      var r = via('evaluate')(point, ctx);
      if (!r || r.ok === false) return { ok: false, why: (r && r.why) || 'ilr_store_error', detail: r && r.detail, message: r && r.message, result: 'block', hits: [], open: [], set: r && r.set };   /* fail-closed */
      if (!r.open) r.open = (r.hits || []).filter(function (h) { return !(h.override && h.override.done); });
      sortHits(r.hits); return r;
    },
    logHit: via('logHit'),
    ackWarning: function (o) { var E = store(); if (E) { return E.logHit({ result: 'warn', hits: o.hits && o.hits.length ? o.hits : [o.hit] }, { screen: o.screen, batchId: o.batchId, reason: o.reason }); }   /* 감사 사용자 = store 가 현재 세션 사용자로 기록 */ return NA(); },
    requestOverride: via('requestOverride'),
    commitOverride: function (ticket, inp) { var E = store(), s = sess(); if (E) return typeof E.signAndCommit === 'function' ? E.signAndCommit(ticket, inp) : s.signAndCommitRecord(ticket, inp); return NA(); },   /* store 경로가 사유 코드 사전 검증(reason_code_required — 창 유지) */
    cancelSign: function (ticket) { var E = store(), s = sess(); if (E && s && s.cancelRecordSign) return s.cancelRecordSign(ticket, { why: 'cancel' }); return { ok: true }; },
    overrideState: via('overrideState'),
    demoPreset: via('demoPreset'),
    currentPreset: function () { var E = store(); return E && E.currentPreset ? (E.currentPreset() || '정상') : '—'; },
    /* S-48 — MS.ilr* (shared-store.js). 없으면 빈 목록 · 거부 (fail-closed) */
    sets: function () { return ms('ilrSets') ? MS.ilrSets() : []; },
    getSet: function (id, ver) { return ms('ilrGet') ? MS.ilrGet(id, ver) : null; },
    validate: function (rules, prev) { return ms('ilrValidateRules') ? MS.ilrValidateRules(rules, prev) : NA(); },
    newVersion: function (id) { return ms('ilrNewVersion') ? MS.ilrNewVersion(id) : NA(); },
    saveDraft: function (id, ver, rules) { return ms('ilrSaveDraft') ? MS.ilrSaveDraft(id, ver, rules) : NA(); },
    requestReview: function (id, ver) { return ms('ilrRequestReview') ? MS.ilrRequestReview({ setId: id, ver: ver }) : NA(); },
    beginSetSign: function (o) { return ms('ilrBeginSign') ? MS.ilrBeginSign(o) : NA(); },
    commitSetSign: function (ticket, inp) { return ms('ilrSignAndCommit') ? MS.ilrSignAndCommit(ticket, inp) : ms('ilrBeginSign') && sess() ? sess().signAndCommitRecord(ticket, inp) : NA(); },
    diff: function (a, b) { return ms('ilrDiff') ? MS.ilrDiff(a, b) : []; },
    condText: condText, paramText: paramText, whyText: whyText, overrideStmt: overrideStmt, hash8: hash8
  };

  /* ================================================================ IlUi — 실행 배너 · 감독자 승인 (생산 · 포장 공통) */
  var IlUi = {
    chip: function (gr) { return '<span class="badge ' + IlApi.gradeClass(gr) + '" title="등급 ' + esc(gr) + '">' + esc(gr) + '</span>'; },
    /* el = .il-banner, res = evaluate 결과. o = {s48: 규칙 화면 경로, batchId, screen, onChange()} — 승인 단계 · 수행자는 store 가 평가 기록에서 정함 */
    banner: function (el, res, o) {
      o = o || {}; if (!el) return;
      var hits = (res && res.hits) || [], open = (res && res.open) || [];
      el.__il = { res: res, o: o };
      if (!res || res.ok === false) {
        el.className = 'il-banner open absolute';
        var skew = res && res.detail === 'clock_skew';   /* clock_skew: 시계 정정 안내 */
        el.innerHTML = '<span class="il-dot"></span><span class="il-grade">진행 불가</span><span class="il-msg" title="' + esc(skew ? res.message || whyText('ilr_store_error') : whyText((res && res.why) || 'ilr_store_error')) + '">' +
          (skew ? '기기 시계가 서명 시각보다 이릅니다 — 날짜 · 시간 정정 후 QA 확인, [다시 읽기]' : '인터록 규칙을 읽을 수 없어 진행 불가 — ' + esc((res && res.set) ? res.set.id + ' v' + res.set.ver : '룰 세트')) + ' (' + esc(skew ? 'clock_skew' : (res && res.why) || 'ilr_store_error') + ')</span><span class="il-actions"><button class="btn inner" type="button" data-il="reload">다시 읽기</button></span>';
        return;
      }
      if (!hits.length) { el.className = 'il-banner'; el.innerHTML = ''; return; }
      open = open.slice().sort(function (x, y) { return GRADES.indexOf(x.grade) - GRADES.indexOf(y.grade); });   /* 가장 무거운 등급이 앞 (배너 색 · 등급 글자) */
      var top = open[0] || hits[0], done = !open.length, rest = hits.filter(function (h) { return h !== top; });
      var cnt = {}; rest.forEach(function (h) { cnt[h.grade] = (cnt[h.grade] || 0) + 1; });
      var more = rest.length ? ' · 외 ' + rest.length + '건 (' + Object.keys(cnt).map(function (k) { return k + ' ' + cnt[k]; }).join(' · ') + ')' : '';
      /* 동시 적중: 열린 적중을 모두 한 줄에 표시하고 등급별 조치를 같이 둔다 (예: 수율 Controlled + Warning — 한쪽만 보이면 진행 경로가 막힘) */
      var openBy = function (gr) { return open.filter(function (h) { return h.grade === gr; })[0] || null; };
      var msg = done ? (top.override.by || '') + ' · ' + (top.override.signatureId || ('사유: ' + (top.override.reason || ''))) + ' · ' + top.msg
        : open.length > 1 ? open.map(function (h) { return h.grade + ' ' + h.ruleId + ' — ' + h.msg; }).join(' ┃ ') : top.msg;
      if (!done && open.length > 1) { rest = hits.filter(function (h) { return open.indexOf(h) < 0; }); cnt = {}; rest.forEach(function (h) { cnt[h.grade] = (cnt[h.grade] || 0) + 1; });
        more = rest.length ? ' · 외 ' + rest.length + '건 (' + Object.keys(cnt).map(function (k) { return k + ' ' + cnt[k]; }).join(' · ') + ')' : ''; }
      var href = (o.s48 || '') + '?ruleId=' + encodeURIComponent(top.ruleId) + '&ro=1';
      var act = '';
      if (!done) {
        var cu = curUser(), roles = cu ? rolesOf(cu.userId) : [];
        var hc = openBy('Controlled'), hw = openBy('Warning'), hq = openBy('Hard-QA');
        if (hq) {
          act += '<span class="tip" title="Hard-QA 승인(S-19 연결)은 P1 — 지금은 진행할 수 없습니다"><button class="btn inner" type="button" disabled>QA 호출 ›</button></span>';
        }
        if (hw) {
          var nw = open.filter(function (h) { return h.grade === 'Warning'; }).length;   /* 열린 Warning 전부를 사유 1건으로 확인 */
          act += '<input class="input" type="text" maxlength="60" placeholder="Warning 사유 1–60자" data-il-reason aria-label="Warning 사유"><button class="btn inner' + (hc ? '' : ' primary') + '" type="button" data-il="ack">사유 저장 후 진행' + (nw > 1 ? ' (Warning ' + nw + ')' : '') + '</button>';
        }
        if (hc) {
          var E0 = store(), oi = E0 && E0.overrideInfo ? E0.overrideInfo(o.batchId, hc) : { performer: E0 && E0.overridePerformer ? E0.overridePerformer(o.batchId, hc) : '' }, pf = oi.performer;
          /* 새로고침 뒤 평가 기록 없음(step_unknown) → 다시 평가 안내 */
          var why = !cu ? '사용자를 선택하세요' : !roles.length ? whyText('no_role') : roles.indexOf('SV') < 0 ? '감독자 승인이 필요합니다 — 승인 서명은 SV 가 합니다' : !pf ? (oi.why === 'step_unknown' ? '평가 기록이 없습니다 — 다시 평가하세요' : whyText('performer_unknown')) : '';
          act += '<span class="tip" title="' + esc(why) + '"><button class="btn inner primary" type="button" data-il="override" data-il-rule="' + esc(hc.ruleId) + '"' + (why ? ' disabled' : '') + '>감독자 승인 ›</button></span>';
        }
      }
      if (rest.length) act += '<button class="btn inner" type="button" data-il="hits">적중 ' + hits.length + ' ▾</button>';
      el.className = 'il-banner open ' + (done ? 'passed' : BANNER_CLASS[top.grade]);
      el.innerHTML = '<span class="il-dot"></span><span class="il-grade">' + esc(done ? (top.override.signatureId ? '승인됨' : '사유 입력됨') : GRADE_TEXT[top.grade]) + '</span>' +
        '<span class="il-msg" title="' + esc(msg + more) + '">' + esc(msg + more) + '</span>' +
        '<a class="il-rule" href="' + esc(href) + '" target="_blank" rel="noopener" title="규칙 보기 (읽기 전용, 새 탭)">' + esc(top.ruleId) + '</a>' +
        '<span class="il-actions">' + act + '</span>' +
        '<div class="il-hits">' + hits.slice(0, 6).map(function (h) {
          return '<div class="ih-row">' + IlUi.chip(h.grade) + '<span class="ih-msg" title="' + esc(h.msg) + '">' + esc(h.msg) + '</span>' + (h.override && h.override.done ? '<span class="badge ok">승인됨</span>' : '') +
            '<a class="ih-id" href="' + esc((o.s48 || '') + '?ruleId=' + encodeURIComponent(h.ruleId) + '&ro=1') + '" target="_blank" rel="noopener">' + esc(h.ruleId) + '</a></div>';
        }).join('') + (hits.length > 6 ? '<div class="ih-row sub-info">… 외 ' + (hits.length - 6) + '건</div>' : '') + '</div>';
      if (!el.__ilBound) {
        el.__ilBound = true;
        el.addEventListener('click', function (e) {
          var b = e.target.closest('[data-il]'); if (!b || b.disabled) return;
          var st = el.__il || {}, r = st.res || {}, oo = st.o || {}, rid = b.getAttribute('data-il-rule');
          var t = (rid ? (r.open || []).filter(function (h) { return h.ruleId === rid; })[0] : null) || (r.open || [])[0] || (r.hits || [])[0];
          var k = b.getAttribute('data-il');
          if (k === 'hits') { el.querySelector('.il-hits').classList.toggle('open'); return; }
          if (k === 'reload') { if (oo.onChange) oo.onChange(); return; }
          if (k === 'ack') {
            var inp = el.querySelector('[data-il-reason]'), ws = (r.open || []).filter(function (h) { return h.grade === 'Warning'; }), rr = IlApi.ackWarning({ hit: ws[0] || t, hits: ws, batchId: oo.batchId, reason: inp ? inp.value : '', screen: oo.screen });
            if (!rr || !rr.ok) { if (g.MesUI) MesUI.toast(whyText((rr && rr.why) || 'reason_required'), 'error'); return; }
            if (g.MesUI) MesUI.toast('사유 저장 — ' + (ws.length ? ws.map(function (h) { return h.ruleId; }).join(', ') : t.ruleId) + ' 진행', 'ok'); if (oo.onChange) oo.onChange(); return;
          }
          if (k === 'override') IlUi.openOverride(t, oo);
        });
      }
    },
    openOverride: function (hit, o) {
      if (!g.RecSign) return;
      g.RecSign.open({
        meaning: 'approved', title: '인터록 감독자 승인 - 승인', l1: '대상', l2: '규칙 · 값', l6: '레코드 타입',
        f1: (o.batchId || '—') + ' · ' + (o.screenName || o.screen || ''), f2: hit.ruleId + ' (' + hit.grade + ') · ' + (hit.value == null ? '' : hit.value + (hit.cond && hit.cond.unit ? ' ' + hit.cond.unit : '')) + (hit.limit != null ? ' / 하한 ' + hit.limit + (hit.cond && hit.cond.unit ? ' ' + hit.cond.unit : '') : ''),
        f6: 'interlock_override (인터록 승인)', valTitle: '적중 규칙',
        rows: [{ k: '규칙', v: hit.ruleId + ' · ' + (hit.name || '') }, { k: '등급', v: hit.grade }, { k: '메시지', v: hit.msg }, { k: '조건', v: condText(hit.cond) }, { k: 'SOP', v: hit.sopRef || '—' }],
        note: '승인하면 RBE 예외가 생성되어 출하 게이트 1 에서 QA 검토 대상이 됩니다.',
        reasonCodes: IlApi.REASONS,
        stmt: function (t, cmt, codeText) { return overrideStmt(o.batchId, hit, codeText, String(cmt || '').trim()); },
        begin: function () { return IlApi.requestOverride({ hit: hit, batchId: o.batchId, screen: o.screen }); },   /* 단계 · 수행자는 store 가 평가 기록 · 수행 서명에서 정함 (N1) */
        commit: function (ticket, inp) { return IlApi.commitOverride(ticket, inp); },
        cancel: function (ticket) { return IlApi.cancelSign(ticket); },
        okText: '감독자 승인 완료',
        onDone: function (r) { if (g.MesUI && r.rbeExceptionId) MesUI.toast('RBE 예외 ' + r.rbeExceptionId + ' 생성 — 출하 게이트 1 QA 검토 대상', 'info', 3200); if (o.onChange) o.onChange(); }
      });
    },
    srcNote: function () { return src() === 'none' ? '인터록 store(EbrInterlock) 미연결 — 진행 불가' : ''; }
  };
  /* store 연결 시 상수 정렬 — POINTS(exec.order) · WHY_TEXT(override_p1 등) · 사유 GCM */
  (function sync() {
    var E = store(); if (!E) return;
    if (Array.isArray(E.POINTS)) { POINTS = E.POINTS.slice(); IlApi.POINTS = POINTS; }
    if (E.WHY_TEXT) Object.keys(E.WHY_TEXT).forEach(function (k) { WHY[k] = E.WHY_TEXT[k]; });
    if (Array.isArray(E.DEMO_PRESETS)) { DEMO_PRESETS = E.DEMO_PRESETS.filter(function (p) { return p.name !== 'normal'; }).map(function (p) { return p.label; }).concat(['정상']); IlApi.DEMO_PRESETS = DEMO_PRESETS; }
    try { var rc = E.reasonCodes && E.reasonCodes(); if (rc && rc.ok && rc.items) { REASONS = rc.items.filter(function (x) { return x.active !== false; }).map(function (x) { return { key: x.key, code: x.code, text: x.text, freeRequired: x.freeRequired }; }); IlApi.REASONS = REASONS; } } catch (x) { /* 빈 목록 유지 (fail-closed) */ }
  })();
  g.IlApi = IlApi; g.IlUi = IlUi;
})(window);
