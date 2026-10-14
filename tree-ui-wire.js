/* tree-ui-wire.js — 프로세스 트리 준수 화면(생산 · 포장 실행 · 정정) 연결 지점 1곳 (PT-01 ~ PT-06 화면 쪽)
 *
 *  화면은 window.TreeApi · window.TreeUi 만 부른다. 판정 · 저장 · 서명은 모두 window.EbrTreeExec (assets/ebr-tree-exec.js).
 *  화면은 ebr.treeExec.v1 을 직접 읽거나 쓰지 않고, 순서 판정 · 분기를 하지 않는다 — why · msg · nextDue 만 표시.
 *  - store 없음 → 'tree_store_error' (fail-closed: 트리 동작(시작 · 예외 경로 · 건너뛰기 · 반복) 거부)
 *  - not_implemented(골격) → 중립 '판정 불가' 표시. 통과로 보이지 않게 하고, 트리 전용 동작은 비활성.
 */
(function (g) {
  'use strict';
  var LOCAL = { tree_store_error: '트리 판정 모듈을 읽지 못했습니다 — 트리 동작을 할 수 없습니다.', not_implemented: '트리 판정 준비 전 — 판정 불가 (트리 판정 모듈 미구현)' };
  function T() { return g.EbrTreeExec || null; }
  function NA() { return { ok: false, why: 'tree_store_error', msg: LOCAL.tree_store_error }; }
  function call(fn, args) {
    var t = T(); if (!t || typeof t[fn] !== 'function') return NA();
    try { var r = t[fn].apply(t, args || []); return r && typeof r === 'object' ? r : NA(); } catch (e) { if (g.console) console.error('[tree ' + fn + ']', e); return NA(); }
  }
  function pending(r) { return !!r && r.ok === false && (r.why === 'not_implemented' || r.why === 'tree_store_error'); }
  function msgOf(r) {
    if (!r) return LOCAL.tree_store_error;
    if (r.why === 'not_implemented') return LOCAL.not_implemented;
    if (r.msg) return r.msg;
    if (r.message) return r.message;
    var t = T(); return t && t.msgFor ? t.msgFor(r.why, r) : (LOCAL[r.why] || String(r.why || ''));
  }
  var TreeApi = {
    available: function (batchId, scope) { var r = scope === 'pack' ? call('nextDue', [batchId, 'pack']) : call('route', [batchId]); return { ok: !!r.ok, pending: !r.ok && pending(r), blocked: !r.ok && !pending(r), res: r }; },   /* 포장 = 선형(트리 없음) → nextDue 로 가용성 */
    route: function (b) { return call('route', [b]); },
    canStart: function (b, s, n) { return call('canStart', [b, s, n]); },
    start: function (b, s, n, o) { return call('start', [b, s, n, o]); },
    complete: function (b, s, n, o) { return call('complete', [b, s, n, o]); },
    rowState: function (b, s, n) { return call('rowState', [b, s, n]); },
    nextDue: function (b, s) { return call('nextDue', [b, s]); },
    requiredNodes: function (b, s) { return call('requiredNodes', [b, s]); },
    enterException: function (b, f, to, r, ev) { return call('enterException', [b, f, to, r, ev]); },
    skip: function (b, n, r) { return call('skip', [b, n, r]); },
    repeat: function (b, n, o) { return call('repeat', [b, n, o]); },
    skipScoped: function (b, n, r, sc) { return call('skip', [b, n, r, sc]); },
    commitRoute: function (t, a) { return call('commitRoute', [t, a]); },
    commitSkip: function (t, a) { return call('commitSkip', [t, a]); },
    commitRepeat: function (t, a) { return call('commitRepeat', [t, a]); },
    migrateOpDone: function (b, d) { return call('migrateOpDone', [b, d]); },
    list: function (b, s) { return call('list', [b, s]); },
    REASON_MAX: 60,
    cancel: function (t) { return call('cancel', [t]); },
    stepKeyOf: function (n, i) { var t = T(); return t && t.stepKeyOf ? t.stepKeyOf(n, i) : String(n || ''); },
    parseStepKey: function (k) { var t = T(); if (t && t.parseStepKey) return t.parseStepKey(k); var m = /^(.+?)(?:#(\d+))?$/.exec(String(k || '')); return { nodeId: m ? m[1] : '', iter: m && m[2] ? +m[2] : 1 }; },
    pending: pending, msgOf: msgOf, LOCAL: LOCAL
  };

  /* 상태 표현 (UI 문서 §2) — 기호 · 배지 클래스 · 글자. 판정은 rowState 결과 그대로 */
  var STATE_VIEW = {
    locked: { sym: '○', badge: '', text: '', meta: '잠금', cls: 'ts-locked' },
    ready: { sym: '○', badge: 'badge muted', text: '대기', cls: 'ts-ready' },
    in_progress: { sym: '▶', badge: 'badge warn', text: '진행', cls: 'ts-prog' },
    done: { sym: '●', badge: 'badge ok', text: '완료', cls: 'ts-done' },
    skipped: { sym: '⊘', badge: 'badge', text: '건너뜀', cls: 'ts-skip' },
    superseded: { sym: '↻', badge: 'badge', text: '대체됨', cls: 'ts-super' },
    terminal: { sym: '■', badge: 'badge error', text: '예외 종료', cls: 'ts-term' }
  };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function badge(state) { var v = STATE_VIEW[state]; return v && v.badge ? '<span class="' + v.badge + '">' + v.text + '</span>' : ''; }
  /* 판정 불가 칩 — 중립 .badge (통과 · 차단 색 아님) */
  /* 트리 없음 (tree_snapshot_missing 등, 판정 결과) — 설계 §5.1: 실행 불가 → 차단 칩 (fail-closed) */
  function blockChip(r) { return '<span class="badge error" data-tree-block="1" title="' + esc(msgOf(r)) + '">트리 차단</span>'; }
  function pendingChip(r) { return '<span class="badge tree-na" data-tree-na="1" title="' + esc(msgOf(r)) + '">판정 불가</span>'; }

  /* PT-03 순서 차단 팝업 #dlgTreeBlock (.dialog.sm 600 × 480) — 생산 · 포장 공용. 문구는 store why 표(msg) 그대로 */
  function ensureBlock() {
    var b = document.getElementById('dlgTreeBlock'); if (b) return b;
    b = document.createElement('div'); b.className = 'dialog-backdrop'; b.id = 'dlgTreeBlock';
    b.innerHTML = '<div class="dialog sm" role="dialog" aria-labelledby="tbTitle">' +
      '<div class="popup-title"><span class="text" id="tbTitle">순서 차단</span><button class="popup-close" type="button" data-dialog-close aria-label="Close"></button></div>' +
      '<div class="shell-body tree-block-body">' +
        '<div class="tb-badges"><span class="badge error">차단</span> <span class="sub-info" id="tbWhy"></span></div>' +
        '<div class="blkmsg one-line" id="tbMsg"></div>' +
        '<div class="form-grid readonly" id="tbKv">' +
          '<span class="label">현재 진행 가능</span><span class="field"><span class="text" id="tbNext"></span></span>' +
          '<span class="label">트리 경로</span><span class="field"><span class="text" id="tbPath"></span></span>' +
          '<span class="label">선행 상태</span><span class="field"><span class="text" id="tbPred"></span></span>' +
          '<span class="label">건너뛰기</span><span class="field"><span class="text" id="tbSkip"></span></span>' +
        '</div>' +
      '</div>' +
      '<div class="dialog-footer"><a class="sub-info tb-link" id="tbS42" href="./s-ebr-esign-history-ui.html">S-42 서명 조회 ›</a><span class="spacer"></span>' +
        '<button class="btn search secondary" type="button" data-dialog-close>닫기</button>' +
        '<button class="btn search primary" type="button" id="tbGo">현재 단계로 이동</button></div>' +
    '</div>';
    document.body.appendChild(b);
    return b;
  }
  /* res = canStart 실패 shape · o = { node, nodeName, path, predText, skipText, onGo(nodeId), batchId } */
  function blockDialog(res, o) {
    o = o || {}; var b = ensureBlock(), $ = function (id) { return document.getElementById(id); };
    var L = o.labels || null, lab = function (t) {   /* 화면 표시 이름 (포장 등 내부 키 → 이름, 키가 없는 화면은 그대로) */
      t = String(t == null ? '' : t); if (!L) return t;
      return t.replace(/[A-Za-z][A-Za-z0-9_-]*/g, function (w) { return Object.prototype.hasOwnProperty.call(L, w) ? L[w] : w; });
    };
    var full = lab(msgOf(res)), first = String(full).split(/(?<=\.)\s/)[0];
    $('tbTitle').textContent = '순서 차단 — ' + (L ? ((res && res.nodeName) || o.nodeName || lab(o.node)) : [o.node, o.nodeName].filter(Boolean).join(' '));
    $('tbWhy').textContent = res && res.why ? res.why : (o.whyText || '');
    $('tbMsg').textContent = first; $('tbMsg').title = full;
    var nd = res && res.nextDue != null ? res.nextDue : o.nextDue;
    $('tbNext').textContent = nd ? (L && res && res.nextDueName ? res.nextDueName : lab(nd)) : '—';
    $('tbPath').textContent = o.path ? lab(o.path) : '—';
    $('tbPred').textContent = o.predText ? lab(o.predText) : res && res.predName ? res.predName : lab(res && res.pred ? res.pred : '—');   /* API 표시 이름 우선 · 없으면 화면 이름 표 */
    $('tbSkip').innerHTML = o.skipText ? esc(o.skipText) : '<span class="badge">N/A</span>';
    if (o.batchId) $('tbS42').href = './s-ebr-esign-history-ui.html?batchId=' + encodeURIComponent(o.batchId);
    var go = $('tbGo');
    if (o.actText && o.onAct) { go.textContent = o.actText; go.disabled = false; go.onclick = function () { g.MesUI.closeDialog('dlgTreeBlock'); o.onAct(res); }; }
    else { go.textContent = '현재 단계로 이동'; go.disabled = !nd || !o.onGo; go.onclick = function () { if (go.disabled) return; g.MesUI.closeDialog('dlgTreeBlock'); o.onGo(res && res.nextDueNode || nd); }; }
    g.MesUI.openDialog('dlgTreeBlock');
    return b;
  }
  /* PT-04 예외 경로 선택 #dlgTreeRoute (.dialog.md 900) — 간선 목록 = route().edges (from 기준), 판정 · 승인 역할 = store 결과 */
  function ensureRoute() {
    var b = document.getElementById('dlgTreeRoute'); if (b) return b;
    b = document.createElement('div'); b.className = 'dialog-backdrop'; b.id = 'dlgTreeRoute';
    b.innerHTML = '<div class="dialog md" role="dialog" aria-labelledby="trTitle">' +
      '<div class="popup-title"><span class="text" id="trTitle">예외 경로 선택</span><button class="popup-close" type="button" data-dialog-close aria-label="Close"></button></div>' +
      '<div class="shell-body tree-route-body">' +
        '<div class="grid-block tr-list"><div class="grid-toolbar"><span class="group-title" id="trFrom"></span><span class="total-text" id="trTotal"></span></div>' +
          '<div class="grid-wrap"><table class="grid"><colgroup><col class="col-no"><col style="width:var(--col-w-short)"><col style="width:var(--col-w-160)"><col><col style="width:var(--col-w-140)"></colgroup>' +
          '<thead><tr><th class="col-no"></th><th>유형</th><th>대상</th><th>라벨</th><th>승인 역할</th></tr></thead><tbody id="trBody"></tbody></table></div></div>' +
        '<div class="form-grid cols-2">' +
          '<span class="label required">사유</span><span class="field"><input class="input" type="text" id="trReason" maxlength="60" placeholder="1–60자 필수" autocomplete="off"></span>' +
          '<span class="label">근거</span><span class="field"><input class="input" type="text" id="trEvidence" maxlength="120" placeholder="선택 — 인터록 적중 감사 ID" autocomplete="off"></span>' +
        '</div>' +
        '<div class="infomsg sub-info">진입 후 주 경로 다음 단계는 합류 지점까지 순서 차단 (X9)</div>' +
        '<div class="sign-err sub-info fc-fail" id="trErr" role="alert"></div>' +
      '</div>' +
      '<div class="dialog-footer"><a class="sub-info tb-link" id="trS42" href="./s-ebr-esign-history-ui.html">S-42 서명 조회 ›</a><span class="spacer"></span>' +
        '<button class="btn search secondary" type="button" data-dialog-close>닫기</button>' +
        '<button class="btn search primary" type="button" id="trGo">경로 진입 승인 서명</button></div>' +
    '</div>';
    document.body.appendChild(b);
    return b;
  }
  function cpLen(t) { return Array.from(String(t || '')).length; }
  /* o = { batchId, from, fromName, route, onDone } — 서명은 RecSign(#dlgRecSign) + commit = EbrTreeExec.commitRoute, 문장 = target.statement */
  function routeDialog(o) {
    ensureRoute(); var $ = function (id) { return document.getElementById(id); }, R = o.route || {};
    var out = (R.edges || []).filter(function (e) { return e.from === o.from; });
    var lbl = function (id) { return id + ' ' + ((R.nodes && R.nodes[id] && R.nodes[id].label) || ''); };
    var toTerm = function (id) { var seen = {}, cur = id; while (cur && !seen[cur]) { seen[cur] = 1; if (R.terminal && R.terminal[cur]) return true; if (!(R.exceptionOf && R.exceptionOf[cur])) return false; var nx = (R.edges || []).filter(function (e) { return e.type === 'seq' && e.from === cur; })[0]; cur = nx ? nx.to : null; } return false; };
    $('trTitle').textContent = '예외 경로 선택 — ' + lbl(o.from);
    $('trFrom').textContent = lbl(o.from) + ' 에서 갈 수 있는 경로';
    $('trTotal').textContent = '(' + out.length + '건)';
    $('trBody').innerHTML = out.map(function (e, i) {
      var ex = e.type === 'exception', role = !ex ? '서명 없음' : toTerm(e.to) ? 'QA만 승인' : 'SV · QA 승인';
      return '<tr><td class="col-no">' + (ex ? '<input type="radio" name="trPick" value="' + esc(e.to) + '"' + (i === out.findIndex(function (x) { return x.type === 'exception'; }) ? ' checked' : '') + '>' : '') + '</td><td>' + esc(e.type) + '</td><td title="' + esc(lbl(e.to)) + '">→ ' + esc(lbl(e.to)) + '</td><td title="' + esc(e.label) + '">' + esc(e.label) + '</td><td>' + role + '</td></tr>';
    }).join('') || '<tr><td colspan="5" class="sub-info">갈 수 있는 경로 없음</td></tr>';
    $('trReason').value = ''; $('trEvidence').value = ''; $('trErr').textContent = '';
    if (o.batchId) $('trS42').href = './s-ebr-esign-history-ui.html?batchId=' + encodeURIComponent(o.batchId);
    $('trGo').onclick = function () {
      var pk = document.querySelector('#trBody input[name=trPick]:checked'), rs = $('trReason').value.trim();
      if (!pk) { $('trErr').textContent = '예외 경로를 고르세요.'; return; }
      if (!rs || cpLen(rs) > 60) { $('trErr').textContent = '사유를 입력하세요 (1–60자).'; return; }
      var to = pk.value, ev = $('trEvidence').value.trim(), first = null;
      first = TreeApi.enterException(o.batchId, o.from, to, rs, ev);
      if (!first || !first.ok) { $('trErr').textContent = msgOf(first); return; }
      g.MesUI.closeDialog('dlgTreeRoute');
      approveSign({ kind: 'route', first: first, title: '예외 경로 진입 승인', f1: o.batchId, f2: o.from + ' → ' + lbl(to),
        rows: [{ k: '경로', v: o.from + ' → ' + to }, { k: '간선', v: (out.filter(function (e) { return e.to === to; })[0] || {}).label || '' }, { k: '사유', v: rs }].concat(ev ? [{ k: '근거', v: ev }] : []),
        note: '예외 경로 진입 — 승인 역할 ' + ((first.target && first.target.approverRoles) || []).join(' · '), onDone: o.onDone });
    };
    g.MesUI.openDialog('dlgTreeRoute');
  }
  /* 사유 입력 (.dialog.sm) — 건너뛰기 · 반복 한도 초과: store 가 사유를 서명 시작 때 받으므로 먼저 입력 */
  function ensureReason() {
    var b = document.getElementById('dlgTreeReason'); if (b) return b;
    b = document.createElement('div'); b.className = 'dialog-backdrop'; b.id = 'dlgTreeReason';
    b.innerHTML = '<div class="dialog sm" role="dialog" aria-labelledby="tqTitle">' +
      '<div class="popup-title"><span class="text" id="tqTitle"></span><button class="popup-close" type="button" data-dialog-close aria-label="Close"></button></div>' +
      '<div class="shell-body tree-block-body">' +
        '<div class="form-grid readonly" id="tqKv"></div>' +
        '<div class="form-grid"><span class="label required">사유</span><span class="field"><input class="input" type="text" id="tqReason" maxlength="60" placeholder="1–60자 필수" autocomplete="off"></span></div>' +
        '<div class="sign-err sub-info fc-fail" id="tqErr" role="alert"></div>' +
      '</div>' +
      '<div class="dialog-footer"><span class="spacer"></span><button class="btn search secondary" type="button" data-dialog-close>닫기</button>' +
        '<button class="btn search primary" type="button" id="tqGo">승인 서명으로</button></div>' +
    '</div>';
    document.body.appendChild(b);
    return b;
  }
  /* o = { kind:'skip'|'repeat', batchId, scope, node, nodeName, kv:[[label,text]], onDone } */
  function reasonDialog(o) {
    ensureReason(); var $ = function (id) { return document.getElementById(id); };
    $('tqTitle').textContent = (o.kind === 'skip' ? '단계 건너뛰기 요청 — ' : '단계 반복 승인 요청 — ') + [o.node, o.nodeName].filter(Boolean).join(' ');
    $('tqKv').innerHTML = (o.kv || []).map(function (x) { return '<span class="label">' + esc(x[0]) + '</span><span class="field"><span class="text" title="' + esc(x[1]) + '">' + esc(x[1]) + '</span></span>'; }).join('');
    $('tqReason').value = ''; $('tqErr').textContent = '';
    $('tqGo').onclick = function () {
      var rs = $('tqReason').value.trim();
      if (!rs || cpLen(rs) > 60) { $('tqErr').textContent = '사유를 입력하세요 (1–60자).'; return; }
      var first = o.kind === 'skip' ? TreeApi.skipScoped(o.batchId, o.node, rs, o.scope || 'prod') : TreeApi.repeat(o.batchId, o.node, { reason: rs, scope: o.scope || 'prod' });
      if (first && first.ok && !first.ticket) { g.MesUI.closeDialog('dlgTreeReason'); if (o.onDone) o.onDone(first); return; }   /* 한도 이내 반복 = 서명 없음 */
      if (!first || !first.ok) { $('tqErr').textContent = msgOf(first); return; }
      g.MesUI.closeDialog('dlgTreeReason');
      var t = first.target || {}, rows;
      if (o.kind === 'repeat') rows = (t.prevIters || []).map(function (x) { return { k: '#' + x.iter + ' ' + x.stepKey, v: STATE_VIEW[x.state] ? STATE_VIEW[x.state].text : x.state }; }).concat([{ k: '#' + t.iter + ' ' + (t.stepKey || ''), v: '(요청) 한도 ' + t.max + '회 초과' }]);
      else rows = [{ k: '대상', v: (t.stepKey || o.node) + ' ' + (o.nodeName || '') }, { k: '근거', v: 'MBR 건너뛰기 허용 단계 (execRule.skippable)' }, { k: '사유', v: rs }];
      approveSign({ kind: o.kind, first: first, title: o.kind === 'skip' ? '단계 건너뛰기 승인' : '단계 반복 승인 · 한도 초과', f1: o.batchId, f2: (t.stepKey || o.node) + ' ' + (o.nodeName || ''), rows: rows,
        note: o.kind === 'skip' ? '건너뛰기 — QA 승인 (SM-APPR-SKIP)' : '반복 한도 초과 — QA 승인 (SM-APPR-REPEAT)', onDone: o.onDone });
    };
    g.MesUI.openDialog('dlgTreeReason');
    setTimeout(function () { $('tqReason').focus(); }, 0);
  }
  /* 승인 서명 — 공통 #dlgRecSign (RecSign). 표시 문장 = target.statement → input.statement (RecSign 이 넘김) */
  function approveSign(o) {
    var C = { route: TreeApi.commitRoute, skip: TreeApi.commitSkip, repeat: TreeApi.commitRepeat }[o.kind];
    if (!g.RecSign) { TreeApi.cancel(o.first.ticket); return; }
    g.RecSign.open({ meaning: 'approved', title: o.title, f1: o.f1, f2: o.f2, f6: 'tree_route (트리 경로 승인)', valTitle: '검토 대상', rows: o.rows, note: o.note,
      begin: function () { return o.first; }, commit: function (tk, inp) { return C(tk, inp); }, cancel: function (tk) { TreeApi.cancel(tk); },
      okText: o.title + ' 완료', onDone: function (r) { if (o.onDone) o.onDone(r); } });
    var ob = document.getElementById('btnRecSign'); if (ob) ob.textContent = '승인 서명';   /* 트리 승인 창 primary 문구 (공용 서명 창은 그대로) */
  }
  /* 행 꾸밈: rowState → { sym, badgeHtml, cls, metaPrefix } (판정 불가면 null) */
  function rowView(batchId, scope, nodeId) {
    var r = TreeApi.rowState(batchId, scope, nodeId);
    if (!r || r.ok === false || !STATE_VIEW[r.state]) return null;
    var v = STATE_VIEW[r.state];
    var sym = v.sym, cls = v.cls;
    if (r.exception && r.state === 'locked') { sym = r.terminalNode ? '■' : '◇'; cls = 'ts-exc-off'; }   /* 예외 미진입 = 흐림 (■ 빨강은 terminal 상태일 때만) */
    return { state: r.state, sym: sym, badge: badge(r.state), cls: cls + (r.exception ? ' ts-exc' : ''), iter: r.iter || 1, stepKey: r.stepKey || nodeId, entered: !!r.entered, exception: !!r.exception,
             terminalNode: !!r.terminalNode, skippable: !!r.skippable, maxRepeat: r.maxRepeat, instance: r.instance || null, canStart: r.canStart || { ok: false }, meta: v.meta || '', derived: !!r.derived, label: r.label || '', code: r.code || nodeId, name: r.name || '' };
  }
  /* 반복 회차 표시 (X4 'N-030#2' → 'N-030 (반복 #2)') — 정정 · S-42 공통 */
  function stepKeyText(k) { var p = TreeApi.parseStepKey(k); return p.iter > 1 ? p.nodeId + ' (반복 #' + p.iter + ')' : String(k || ''); }

  g.TreeApi = TreeApi;
  g.TreeUi = { STATE_VIEW: STATE_VIEW, badge: badge, pendingChip: pendingChip, blockChip: blockChip, routeDialog: routeDialog, reasonDialog: reasonDialog, approveSign: approveSign, blockDialog: blockDialog, rowView: rowView, stepKeyText: stepKeyText, esc: esc };
})(typeof window !== 'undefined' ? window : globalThis);
