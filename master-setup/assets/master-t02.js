/* =====================================================================
   master-t02.js — 기준정보 PoC v2 공용 셸 · T-02 엔진 (전역 MT)
     - 공용 셸 : 링크 복사 · 샘플 복원(#btnRestore 있을 때) · 저장소 변경 재렌더 (화면별 좌측 내비 없음 — 카탈로그 메뉴가 담당)
     - T-02 마스터 수명주기 관리 : search-box → title-row → toolbar → grid → paging → 사용 GCM 배너
     - T-10 New/Detail 팝업 (700 · 900 · 1100) : form 정의 + extra(render/collect/bind) 훅
   의존: mesui.js(MesUI), shared-store.js(MS)
   ===================================================================== */
(function (global) {
  'use strict';
  var MT = {};
  var $ = MS.$, $$ = MS.$$, esc = MS.esc, clone = MS.clone;
  var ROOT = (document.body && document.body.dataset.root) || './';
  MT.ROOT = ROOT;
  MT.href = function (file) { return ROOT + file; };
  MT.gcmHref = function (table) { return ROOT + 'adm/s-adm-gcm-code-ui.html' + (table ? '#' + table : ''); };

  /* ================================================================== 셸 (좌측 내비 없음 — 콘텐츠만) */
  MT.shell = function (key) {
    var br = $('#btnRestore');
    if (br) br.addEventListener('click', function () {
      MesUI.confirm('편집 내용을 버리고 샘플 데이터로 복원합니다.\n(localStorage \'' + MS.LS_KEY + '\' 삭제 — 모든 모듈 화면 공통)', function () {
        MS.reset(); MT.rerenderAll(); MesUI.toast('샘플 데이터로 복원했습니다.', 'ok');
      }, { okText: '복원', cancelText: '취소' });
    });
    var cp = $('#btnCopyLink');
    if (cp) cp.addEventListener('click', function () {
      var url = location.href;
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(function () { MesUI.toast('화면 링크를 복사했습니다.', 'ok', 1500); }, function () { MesUI.toast(url, 'info'); });
      else MesUI.toast(url, 'info');
    });
    MS.onExternal(function () { MT.rerenderAll(); MesUI.toast('다른 화면에서 저장된 기준정보를 다시 불러왔습니다.', 'info', 1800); });
  };
  var rerenders = [];
  MT.onRerender = function (fn) { rerenders.push(fn); };
  MT.rerenderAll = function () { mounted.forEach(function (c) { MT.refresh(c); }); rerenders.forEach(function (fn) { fn(); }); };

  /* ================================================================== T-02 엔진 */
  var PAGING_HTML = MT.PAGING_HTML = '<button class="pg-btn pg-first" type="button" disabled title="처음"></button><button class="pg-btn pg-prev" type="button" disabled title="이전"></button>' +
    '<button class="pg-no current" type="button">1</button><button class="pg-btn pg-next" type="button" disabled title="다음"></button><button class="pg-btn pg-last" type="button" disabled title="마지막"></button>' +
    '<input class="input pg-input" type="text" value="1" aria-label="페이지"><button class="btn pg-go" type="button" data-pg-go>GO</button>';
  var PAGESIZE_HTML = '<select class="input page-size" data-pagesize><option>Views 20</option><option>Views 50</option><option>Views 100</option></select>';
  /* 수명주기 전이 (GCM EBR_MBR_STATUS 코드 기준). sign: 전자서명(T-11) 필요 — PoC 는 confirm 으로 대체 */
  var TRANS = MT.TRANS = {
    reject:   { label: '반려', from: ['review'], to: 'draft' },
    retire:   { label: '폐기', from: ['effective', 'superseded'], to: 'retired', sign: true },
    submit:   { label: '검토요청', from: ['draft'], to: 'review' },
    approve:  { label: '승인', from: ['review'], to: 'approved', sign: true },
    activate: { label: '효력전환', from: ['approved', 'pending'], to: 'effective', sign: true }
  };
  var uid = MT.uid = function (r) { return r.id + '@' + r.ver; };
  var rowsOf = MT.rowsOf = function (cfg) { return MS.DB[cfg.store]; };
  var findRow = MT.findRow = function (cfg, u) { return rowsOf(cfg).filter(function (r) { return uid(r) === u; })[0]; };
  var mounted = [];

  MT.mountT02 = function (cfg, host) {
    injectDialog();
    var gid = 'grd-' + cfg.key;
    var search = cfg.search.map(function (f, i) {
      return f.t === 'text'
        ? '<div class="search-control"><span class="label">' + esc(f.label) + '</span><span class="input-clear"><input class="input" type="text" data-s="' + i + '" aria-label="' + esc(f.label) + '"><button class="clear" type="button" data-clear-s="' + i + '" title="지우기"></button></span></div>'
        : '<div class="search-control"><span class="label">' + esc(f.label) + '</span><select class="input" data-s="' + i + '" aria-label="' + esc(f.label) + '"></select></div>';
    }).join('');
    var th = cfg.cols.map(function (c) { return '<th' + (c.cls ? ' class="' + c.cls + '"' : '') + (c.title ? ' title="' + esc(c.title) + '"' : '') + '>' + esc(c.h) + '</th>'; }).join('');
    var colg = cfg.cols.map(function (c) { return '<col' + (c.w ? ' style="width:' + c.w + 'px"' : '') + '>'; }).join('');
    var life = Object.keys(TRANS).map(function (a) { var t = TRANS[a]; return '<button class="btn search' + (a === 'reject' || a === 'retire' ? '' : ' secondary') + '" type="button" data-act="' + a + '" disabled>' + t.label + '</button>'; }).join('');
    host.innerHTML = (cfg.callout || '') +
      '<div class="search-box cols-3">' + search + '<div class="search-actions"><button class="btn search" type="button" data-act="reset">Reset</button><button class="btn search secondary" type="button" data-act="search">Search</button></div></div>' +
      '<div class="grid-block">' +
        '<div class="grid-title-area"><div class="title-row"><span class="group-title">' + esc(cfg.group) + ' <span class="sub-info">' + cfg.sid + ' · ' + cfg.clazz + '</span></span><span class="lc-legend" data-legend></span></div>' +
        '<div class="grid-toolbar"><span class="total-text" data-total-for="' + gid + '"></span><span class="vbar"></span>' + PAGESIZE_HTML + '<span class="sub-info sel-info" data-sel></span><span class="spacer"></span>' +
          '<button class="btn search" type="button" data-act="delete">Delete</button><button class="btn search" type="button" data-act="excel">Excel</button>' + life +
          '<button class="btn search primary" type="button" data-act="new">New</button></div></div>' +
        '<div class="grid-wrap"><table class="grid selectable" id="' + gid + '"><colgroup><col class="col-check"><col class="col-no"><col class="col-icon">' + colg + '</colgroup>' +
          '<thead><tr><th class="col-check"><input type="checkbox" aria-label="전체 선택"></th><th class="col-no">No.</th><th class="col-icon">Detail</th>' + th + '</tr></thead><tbody></tbody></table>' +
          '<div class="nodata hidden" data-nodata>조회 결과가 없습니다</div></div>' +
        '<div class="paging">' + PAGING_HTML + '</div>' +
      '</div>' +
      '<div class="plan-banner bc-plan"><span class="status-dot navy"></span><span>사용 GCM <span class="sub-info">(ADM)</span></span>' +
        cfg.gcm.map(function (g) { return '<a class="gcm-chip" href="' + esc(MT.gcmHref(g[0])) + '" data-gcm="' + g[0] + '" title="ADM GCM 화면에서 조회 (조회 전용)">' + g[0] + '<small>' + esc(g[1]) + '</small></a>'; }).join('') +
        '<span class="sub-info">' + esc(cfg.note) + '</span></div>';
    cfg.host = host; cfg.q = {};
    mounted.push(cfg);

    host.addEventListener('click', function (e) {
      var t;
      if ((t = e.target.closest('[data-clear-s]'))) { $('[data-s="' + t.dataset.clearS + '"]', host).value = ''; return; }
      if ((t = e.target.closest('[data-kind]'))) { var ks = cfg.search.map(function (f) { return f.k; }).indexOf('kind'); $('[data-s="' + ks + '"]', host).value = t.dataset.kind; applySearch(cfg); return; }
      if (e.target.closest('.ic-detail')) { MT.openForm(cfg, findRow(cfg, e.target.closest('tr').dataset.uid)); return; }
      if (e.target.closest('[data-pg-go]')) { MesUI.toast('1 / 1 페이지', 'info', 1200); return; }
      if (!(t = e.target.closest('[data-act]'))) return;
      var act = t.dataset.act;
      if (act === 'search') applySearch(cfg, true);
      else if (act === 'reset') { $$('[data-s]', host).forEach(function (el) { el.value = ''; }); applySearch(cfg); MesUI.toast('조회 조건을 초기화했습니다.', 'info', 1500); }
      else if (act === 'new') MT.openForm(cfg, null);
      else if (act === 'delete') deleteRows(cfg);
      else if (act === 'excel') MesUI.toast('(데모) ' + cfg.title + ' 목록 Excel 다운로드는 PoC 범위 밖입니다.', 'info');
      else if (TRANS[act]) transition(cfg, act);
    });
    host.addEventListener('dblclick', function (e) { var tr = e.target.closest('tbody tr[data-uid]'); if (tr && !e.target.closest('input,button,a')) MT.openForm(cfg, findRow(cfg, tr.dataset.uid)); });
    host.addEventListener('change', function (e) {
      if (e.target.closest('.col-check')) updateSel(cfg);
      if (e.target.matches('[data-pagesize]')) MesUI.toast(e.target.value + ' — 페이지 크기 변경 (데모: 단일 페이지)', 'info', 1500);
    });
    host.addEventListener('click', function (e) { if (e.target.closest('th.col-check input')) setTimeout(function () { updateSel(cfg); }, 0); });
    host.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target.matches('[data-s]')) applySearch(cfg, true); });
    MT.refresh(cfg);
  };
  MT.refresh = function (cfg) { refreshSearchOpts(cfg); renderT02(cfg); };

  function refreshSearchOpts(cfg) {
    cfg.search.forEach(function (f, i) {
      if (f.t !== 'select') return;
      var el = $('[data-s="' + i + '"]', cfg.host), v = el.value;
      el.innerHTML = MS.optionsHtml(f.src, '', '전체');
      el.value = MS.opts(f.src).some(function (o) { return o.v === v; }) ? v : '';
    });
    var lg = $('[data-legend]', cfg.host);
    if (cfg.legend) lg.innerHTML = cfg.legend(cfg);
    else lg.innerHTML = '<span>수명주기</span>' + MS.gRows('EBR_MBR_STATUS', true).map(function (r) { return MS.lcBadge(r.key1); }).join('');
  }
  function applySearch(cfg, notify) {
    cfg.q = {};
    cfg.search.forEach(function (f, i) { var v = $('[data-s="' + i + '"]', cfg.host).value.trim(); if (v) cfg.q[i] = v; });
    var n = renderT02(cfg);
    if (notify) MesUI.toast('조회 완료 — ' + n + '건', 'info', 1500);
  }
  MT.applySearch = applySearch;
  function matchRow(cfg, r) {
    return Object.keys(cfg.q).every(function (i) {
      var f = cfg.search[i], v = cfg.q[i];
      if (f.t === 'text') {
        var u = v.toUpperCase();
        if (f.fn) return f.fn(r, u);
        return f.keys.some(function (k) { return String(r[k] || '').toUpperCase().indexOf(u) >= 0; });
      }
      if (f.match) return f.match(r, v);
      var x = r[f.k]; return Array.isArray(x) ? x.indexOf(v) >= 0 : x === v;
    });
  }
  function cellHtml(c, r) {
    if (c.r) return c.r(r);
    var v = r[c.k];
    if (c.k === 'status') return MS.lcBadge(v);
    if (c.k === 'hash') return MS.hashCell(v);
    if (c.k === 'ver') return 'v' + esc(v);
    if (c.badge) return MS.optBadge(c.src, v);
    if (c.src) return esc(MS.label(c.src, v));
    return v == null || v === '' ? '<span class="muted">—</span>' : esc(v);
  }
  function renderT02(cfg) {
    var sk = cfg.sortKey || function () { return 0; };
    var rows = rowsOf(cfg).slice().sort(function (a, b) { return sk(a) - sk(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : b.ver - a.ver); }).filter(function (r) { return matchRow(cfg, r); });
    var tb = $('tbody', cfg.host);
    tb.innerHTML = rows.map(function (r, i) {
      var dim = r.status === 'superseded' || r.status === 'retired';
      return '<tr data-uid="' + esc(uid(r)) + '"' + (dim ? ' class="disabled"' : '') + '><td class="col-check"><input type="checkbox" aria-label="선택"></td><td class="col-no">' + (i + 1) + '</td>' +
        '<td class="center"><button class="ic-detail" type="button" title="Detail"></button></td>' +
        cfg.cols.map(function (c) { var h = cellHtml(c, r); return '<td' + (c.cls ? ' class="' + c.cls + '"' : '') + ' title="' + esc(String(h).replace(/<[^>]+>/g, '')) + '">' + h + '</td>'; }).join('') + '</tr>';
    }).join('');
    $('[data-nodata]', cfg.host).classList.toggle('hidden', rows.length > 0);
    $('thead .col-check input', cfg.host).checked = false;
    MesUI.setTotal('grd-' + cfg.key, rows.length);
    updateSel(cfg);
    return rows.length;
  }
  MT.renderT02 = renderT02;
  function checked(cfg) { return $$('tbody tr.checked', cfg.host).map(function (tr) { return findRow(cfg, tr.dataset.uid); }).filter(Boolean); }
  function updateSel(cfg) {
    var rs = checked(cfg);
    Object.keys(TRANS).forEach(function (a) {
      var ok = rs.length > 0 && rs.every(function (r) { return TRANS[a].from.indexOf(r.status) >= 0; });
      var b = $('[data-act="' + a + '"]', cfg.host); b.disabled = !ok;
      b.title = ok ? '' : rs.length ? TRANS[a].label + ' 가능 상태: ' + TRANS[a].from.map(function (s) { return MS.label('gcm:EBR_MBR_STATUS', s); }).join(' · ') : '행을 체크하세요';
    });
    $('[data-sel]', cfg.host).textContent = rs.length ? '선택 ' + rs.length + '건' : '';
  }

  /* ------------------------------------------------------------------ 수명주기 전이 · 삭제 */
  function transition(cfg, act) {
    var t = TRANS[act], rs = checked(cfg);
    if (!rs.length) return;
    var names = rs.map(function (r) { return r.id + ' v' + r.ver; });
    if (act === 'activate') {
      var mm = rs.filter(function (r) { return r.pkg === 'mismatch'; });
      if (mm.length) { MesUI.alert('이관 패키지 해시가 운영 객체와 불일치하여 효력전환할 수 없습니다 — 재이관 후 다시 시도하세요 (MBR-05).\n대상: ' + mm.map(function (r) { return r.id + ' v' + r.ver; }).join(', '), 'Warning'); return; }
      var ids = rs.map(function (r) { return r.id; });
      if (ids.some(function (x, i) { return ids.indexOf(x) !== i; })) { MesUI.alert('같은 ID 의 여러 버전을 동시에 효력전환할 수 없습니다.', 'Warning'); return; }
    }
    var err = cfg.beforeTransition && cfg.beforeTransition(act, rs);
    if (err) { MesUI.alert(err, 'Warning'); return; }
    var fromTxt = rs.map(function (r) { return MS.label('gcm:EBR_MBR_STATUS', r.status); }).filter(function (x, i, a) { return a.indexOf(x) === i; }).join(' · ');
    var msg = names.slice(0, 3).join(', ') + (names.length > 3 ? ' 외 ' + (names.length - 3) + '건' : '') + '\n\'' + fromTxt + '\' → \'' + MS.label('gcm:EBR_MBR_STATUS', t.to) + '\' 전이합니다.' +
      (t.sign ? '\n\n전자서명(T-11 · ' + (act === 'retire' ? '승인' : t.label) + ' · 전 요소)이 필요합니다 — PoC 에서는 확인으로 대체합니다.' : '') +
      (act === 'activate' ? '\n같은 ID 의 기존 효력 버전은 \'대체\'로 전환됩니다.' : '') +
      (cfg.transitionNote ? cfg.transitionNote(act, rs) : '');
    MesUI.confirm(msg, function () {
      rs.forEach(function (r) {
        if (act === 'activate') {
          rowsOf(cfg).forEach(function (o) { if (o.id === r.id && o !== r && o.status === 'effective') { o.status = 'superseded'; o.upd = MS.TODAY; } });
          r.effDate = MS.TODAY;
        }
        if (act === 'submit' && r.scope === 'transfer_required' && r.pkg === 'wait') r.pkg = 'match';   /* 이관 패키지 생성 · 해시 대조 (데모) */
        r.status = t.to; r.upd = MS.TODAY;
        if (cfg.afterTransition) cfg.afterTransition(act, r);
      });
      MS.persist(); renderT02(cfg);
      MesUI.toast(t.label + ' 완료 — ' + rs.length + '건 (' + MS.label('gcm:EBR_MBR_STATUS', t.to) + ')', 'ok');
    }, { title: t.sign ? 'Confirm · 전자서명' : 'Confirm', okText: t.label, cancelText: '취소' });
  }
  function deleteRows(cfg) {
    var rs = checked(cfg);
    if (!rs.length) { MesUI.alert('삭제할 행을 선택하세요.', 'Warning'); return; }
    var bad = rs.filter(function (r) { return r.status !== 'draft'; });
    if (bad.length) {
      MesUI.alert('초안 상태만 삭제할 수 있습니다 — 승인 · 효력 이후 객체는 \'폐기\' 전이를 사용하세요 (감사추적 보존).\n대상: ' + bad.map(function (r) { return r.id + ' v' + r.ver + ' (' + MS.label('gcm:EBR_MBR_STATUS', r.status) + ')'; }).join(', '), 'Warning');
      return;
    }
    MesUI.confirm('선택한 ' + rs.length + '건을 삭제하시겠습니까?\n' + rs.map(function (r) { return r.id + ' v' + r.ver; }).join(', '), function () {
      MS.DB[cfg.store] = rowsOf(cfg).filter(function (r) { return rs.indexOf(r) < 0; });
      MS.persist(); renderT02(cfg); MesUI.toast(rs.length + '건 삭제했습니다.', 'ok');
    }, { title: 'Delete', okText: 'Delete', cancelText: 'Cancel' });
  }

  /* ------------------------------------------------------------------ New / Detail 팝업 (T-10) */
  var injected = false;
  function injectDialog() {
    if (injected) return; injected = true;
    document.body.insertAdjacentHTML('beforeend',
      '<div class="dialog-backdrop" id="dlgMaster"><div class="dialog" id="dmBox">' +
      '<div class="popup-title"><span class="text" id="dmTitle">상세</span><button class="popup-close" type="button" data-dialog-close aria-label="Close"></button></div>' +
      '<div class="dlg-meta" id="dmMeta"></div>' +
      '<div class="dlg-scroll"><div class="form-grid cols-2" id="dmForm"></div><div class="col" id="dmExtra"></div></div>' +
      '<div class="dialog-footer"><button class="btn search hidden" type="button" id="dmNewVer">새 버전 작성</button><span class="spacer"></span>' +
      '<button class="btn search secondary" type="button" data-dialog-close>닫기</button><button class="btn search primary" type="button" id="dmSave">저장</button></div></div></div>');
    $('#dmSave').addEventListener('click', save);
    $('#dmNewVer').addEventListener('click', function () {
      var cfg = F.cfg, row = F.orig;
      var open = rowsOf(cfg).filter(function (r) { return r.id === row.id && (r.status === 'draft' || r.status === 'review'); })[0];
      if (open) { MesUI.alert(row.id + ' 에 진행 중인 ' + MS.label('gcm:EBR_MBR_STATUS', open.status) + ' 버전(v' + open.ver + ')이 있습니다.', 'Warning'); return; }
      MesUI.closeDialog('dlgMaster');
      MT.openForm(cfg, row, true);
    });
  }
  var F = null;   /* { cfg, orig, data, isNew, ro, newVer } */
  MT.form = function () { return F; };
  function fieldHtml(f, d, dis) {
    var v = d[f.k], ro = dis ? ' disabled' : '', rd = dis ? ' readonly' : '';
    var lab = '<span class="label' + (f.req ? ' required' : '') + '">' + esc(f.label) + '</span>';
    var inner;
    switch (f.type) {
      case 'select': inner = '<select class="input" data-f="' + f.k + '"' + ro + '>' + MS.optionsHtml(typeof f.src === 'function' ? f.src(d) : f.src, f.get ? f.get(d) : v, '선택') + '</select>'; break;
      case 'checks': inner = '<span class="checkbox-group" data-f="' + f.k + '">' + MS.opts(f.src).map(function (o) {
          return '<label class="checkbox"><input type="checkbox" value="' + esc(o.v) + '"' + ((v || []).indexOf(o.v) >= 0 ? ' checked' : '') + ro + '> ' + esc(o.t) + '</label>'; }).join('') + '</span>'; break;
      case 'bool': inner = '<label class="checkbox"><input type="checkbox" data-f="' + f.k + '"' + (v ? ' checked' : '') + ro + '> ' + esc(f.text || '') + '</label>'; break;
      case 'number': inner = '<input class="input num w-80" type="text" inputmode="numeric" data-f="' + f.k + '" value="' + esc(v) + '"' + rd + '><span class="unit">' + esc(f.unit || '') + '</span>'; break;
      case 'textarea': inner = '<textarea class="input" rows="2" data-f="' + f.k + '"' + rd + (f.ph ? ' placeholder="' + esc(f.ph) + '"' : '') + '>' + esc(v) + '</textarea>'; break;
      case 'display': inner = '<span class="text" data-disp="' + f.k + '">' + f.render(d) + '</span>'; break;
      default: inner = '<input class="input" type="text" data-f="' + f.k + '" value="' + esc(v) + '"' + rd + (f.ph ? ' placeholder="' + esc(f.ph) + '"' : '') + '>';
    }
    return lab + '<span class="field' + (f.span ? ' span-2' : '') + '">' + inner + '</span>';
  }
  MT.openForm = function (cfg, row, asNewVersion) {
    var isNew = !row || !!asNewVersion;
    var data = row ? clone(row) : cfg.blank();
    if (asNewVersion) {
      data.ver = Math.max.apply(null, rowsOf(cfg).filter(function (r) { return r.id === row.id; }).map(function (r) { return r.ver; })) + 1;
      data.status = 'draft'; data.effDate = ''; data.wu = 0; data.author = MS.USER; data.hash = '';
      if ('reviewer' in data) data.reviewer = '';
      if ('pkg' in data) data.pkg = data.scope === 'transfer_required' ? 'wait' : 'na';
      if (cfg.onNewVersion) cfg.onNewVersion(data);
    }
    var ro = !isNew && data.status !== 'draft';
    F = { cfg: cfg, orig: asNewVersion ? null : row, data: data, isNew: isNew, ro: ro, newVer: !!asNewVersion };
    var box = $('#dmBox');
    box.style.setProperty('--dialog-w', cfg.dialogW + 'px');
    box.style.setProperty('--dialog-h', (cfg.dialogH || (cfg.dialogW <= 700 ? 620 : 700)) + 'px');
    $('#dmTitle').textContent = cfg.title + (asNewVersion ? ' 새 버전' : isNew ? ' 신규' : ' 상세') + (row ? ' — ' + data.id + ' v' + data.ver : '') + (cfg.dialogSuffix || '');
    $('#dmMeta').innerHTML = (isNew ? MS.lcBadge('draft') + '<span>신규 v' + data.ver + ' · 작성자 <b>' + MS.USER + '</b></span>'
        : MS.lcBadge(data.status) + '<span>v' + data.ver + '</span><span>콘텐츠 해시 <b class="hash">' + esc(data.hash) + '</b></span><span>작성 ' + esc(data.author || '') + ' · 수정 ' + esc(data.upd || '') + '</span>' +
          (data.pkg ? '<span>이관 패키지 ' + MS.optBadge(MS.OPTS.PKG, data.pkg) + '</span>' : '') + (data.online ? '<span>운영 상태 ' + MS.optBadge(MS.OPTS.ONLINE, data.online) + ' 최종 수신 ' + esc(data.beat) + '</span>' : '') +
          (cfg.metaExtra ? cfg.metaExtra(data) : '')) +
      (ro ? '<span class="sub-info"><i class="ic-lock"></i>' + esc(MS.label('gcm:EBR_MBR_STATUS', data.status)) + ' 상태는 수정할 수 없습니다 — [새 버전 작성]으로 초안을 만드세요</span>' : '') +
      '<span class="spacer"></span><span class="sub-info">' + cfg.sid + ' · ' + cfg.clazz + '</span>';
    var form = $('#dmForm');
    form.className = 'form-grid' + (cfg.formCols === 3 ? ' cols-3' : cfg.formCols === 2 ? ' cols-2' : '');
    form.innerHTML = cfg.form.map(function (f) { return fieldHtml(f, data, ro || (f.lockOnEdit && (!isNew || F.newVer))); }).join('');
    $$('[data-f]', form).forEach(function (el) {
      var k = el.dataset.f;
      el.addEventListener('change', function () { if (cfg.onChange) cfg.onChange(k, form); });
    });
    MT.renderExtra();
    $('#dmNewVer').classList.toggle('hidden', isNew || data.status === 'draft' || data.status === 'retired');
    $('#dmSave').disabled = ro;
    MesUI.openDialog('dlgMaster');
  };
  MT.renderExtra = function () {
    var host = $('#dmExtra'), cfg = F.cfg;
    host.innerHTML = cfg.extra ? cfg.extra.render(F.data, F.ro) : '';
    host.classList.toggle('hidden', !cfg.extra);
    if (cfg.extra && cfg.extra.bind) cfg.extra.bind(host, F.data, F.ro);
  };
  MT.refreshDisplay = function () {
    F.cfg.form.forEach(function (f) { if (f.type === 'display') { var el = $('[data-disp="' + f.k + '"]', $('#dmForm')); if (el) el.innerHTML = f.render(F.data); } });
  };
  function collectForm() {
    var d = clone(F.data), form = $('#dmForm');
    F.cfg.form.forEach(function (f) {
      var el = $('[data-f="' + f.k + '"]', form); if (!el || f.type === 'display') return;
      if (f.set) { f.set(d, el.value); return; }
      if (f.type === 'checks') d[f.k] = $$('input:checked', el).map(function (c) { return c.value; });
      else if (f.type === 'bool') d[f.k] = el.checked;
      else if (f.type === 'number') d[f.k] = el.value.trim() === '' ? null : Number(el.value);
      else d[f.k] = el.value.trim();
    });
    if (F.cfg.extra) F.cfg.extra.collect($('#dmExtra'), d);
    return d;
  }
  function save() {
    if (!F || F.ro) return;
    var cfg = F.cfg, d = collectForm();
    for (var i = 0; i < cfg.form.length; i++) {
      var f = cfg.form[i], v = f.get ? f.get(d) : d[f.k];
      if (f.req && (v == null || v === '' || (Array.isArray(v) && !v.length))) {
        MesUI.alert('필수 입력 항목입니다: ' + f.label, 'Warning');
        var el = $('[data-f="' + f.k + '"]', $('#dmForm')); if (el && el.focus) el.focus();
        return;
      }
    }
    if ('id' in d) d.id = String(d.id).toUpperCase();
    if (!d.author) d.author = MS.USER;
    var err = cfg.validate && cfg.validate(d);
    if (err) { MesUI.alert(err, 'Warning'); return; }
    if (F.isNew) {
      var same = rowsOf(cfg).filter(function (r) { return r.id === d.id; });
      if (!F.newVer && same.length) { MesUI.alert('이미 존재하는 ID 입니다: ' + d.id + '\n기존 객체의 Detail → [새 버전 작성]을 사용하세요.', 'Warning'); return; }
      var open = same.filter(function (r) { return r.status === 'draft' || r.status === 'review'; })[0];
      if (open) { MesUI.alert(d.id + ' 에 진행 중인 ' + MS.label('gcm:EBR_MBR_STATUS', open.status) + ' 버전(v' + open.ver + ')이 있습니다 — 한 번에 하나의 개정만 가능합니다.', 'Warning'); return; }
      d.status = 'draft';
      if ('pkg' in d) d.pkg = d.scope === 'transfer_required' ? 'wait' : 'na';
    }
    d.upd = MS.TODAY; d.hash = MS.calcHash(d);
    if (F.isNew) rowsOf(cfg).push(d);
    else { var idx = rowsOf(cfg).indexOf(F.orig); rowsOf(cfg)[idx] = d; }
    MS.persist(); MesUI.closeDialog('dlgMaster');
    MT.refresh(cfg);
    var tr = $('tbody tr[data-uid="' + uid(d) + '"]', cfg.host); if (tr) { MesUI.selectRow(tr); tr.scrollIntoView({ block: 'nearest' }); }
    MesUI.toast((F.isNew ? '신규 저장' : '저장') + ' 완료 — ' + d.id + ' v' + d.ver + ' (해시 ' + d.hash.slice(0, 8) + ')', 'ok');
  }

  global.MT = MT;
})(window);
