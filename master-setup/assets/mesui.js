/* =====================================================================
   mesui.js — Elephant UX 정적 PoC 헬퍼 (외부 의존 없음, 전역 객체 MesUI)
   mesui.css 와 짝으로 사용한다.
     - 다이얼로그 : openDialog / closeDialog / alert / confirm
     - 알림       : toast(우상단 카드) / notify(OI 상단 알림 바)
     - 그리드     : selectRow('rowselect' 이벤트) / filterGrid / checkAll / checkedRows / setTotal / renumber
     - 표시       : setBadge / pinpad / nowStamp / fmt
     - 마크업 위임: [data-dialog-open=id] [data-dialog-close] table.grid.selectable td.col-check [data-now]
   ===================================================================== */
(function (global) {
  'use strict';
  var MesUI = {};
  var BADGE_STATES = ['ok', 'warn', 'error', 'info', 'muted'];
  var TYPE_TITLE = { ok: 'Success', warn: 'Warning', error: 'Error', info: 'Information' };

  function byId(x) { return typeof x === 'string' ? document.getElementById(x) : x; }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function area(cls) {                       /* 토스트·알림 바 컨테이너(없으면 body 에 생성) */
    var a = document.querySelector('.' + cls);
    if (!a) { a = el('div', cls); document.body.appendChild(a); }
    return a;
  }

  /* ---------- 숫자 · 시각 ---------- */
  /* fmt(1234.5) → '1,234.5' / fmt(1234.567, 2) → '1,234.57' (그리드 numbereditor s#,### 대응) */
  MesUI.fmt = function (n, digits) {
    if (n === null || n === undefined || n === '' || isNaN(n)) return '';
    var opt = digits == null ? { maximumFractionDigits: 6 }
                             : { minimumFractionDigits: digits, maximumFractionDigits: digits };
    return Number(n).toLocaleString('en-US', opt);
  };
  /* nowStamp() → 'YYYY-MM-DD HH:mm:ss' / nowStamp(d,'date') → 'YYYY-MM-DD' / nowStamp(d,'time') → 'HH:mm:ss' */
  MesUI.nowStamp = function (d, mode) {
    d = d || new Date();
    var p = function (v) { return (v < 10 ? '0' : '') + v; };
    var date = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    var time = p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    return mode === 'date' ? date : mode === 'time' ? time : date + ' ' + time;
  };
  /* [data-now], [data-now="date|time"] 요소에 현재 시각 기록. [data-now-live] 는 1초마다 갱신 */
  MesUI.stampAll = function () {
    document.querySelectorAll('[data-now]').forEach(function (e) {
      e.textContent = MesUI.nowStamp(null, e.getAttribute('data-now'));
    });
  };

  /* ---------- 다이얼로그 ---------- */
  function backdropOf(x) {
    var e = byId(x);
    if (!e) return null;
    return e.classList.contains('dialog-backdrop') ? e : e.closest('.dialog-backdrop');
  }
  /* openDialog('dlgId') — id 는 .dialog-backdrop 또는 그 안의 .dialog */
  MesUI.openDialog = function (id) {
    var b = backdropOf(id);
    if (!b) return null;
    b.__opener = document.activeElement;
    b.classList.add('open');
    var f = b.querySelector('.dialog-footer .btn.primary, .dialog .input, .dialog .btn');
    if (f) f.focus();
    b.dispatchEvent(new CustomEvent('dialogopen', { bubbles: true }));
    return b;
  };
  MesUI.closeDialog = function (id) {
    var b = backdropOf(id);
    if (!b) return;
    b.classList.remove('open');
    b.dispatchEvent(new CustomEvent('dialogclose', { bubbles: true }));
    if (b.__opener && b.__opener.focus) b.__opener.focus();
    if (b.dataset.temp === '1') b.remove();
  };
  /* Common.alert / Common.confirm 대응 메시지 다이얼로그 생성 */
  function msgDialog(o) {
    var b = el('div', 'dialog-backdrop open'); b.dataset.temp = '1';
    var d = el('div', 'dialog msg');
    var t = el('div', 'popup-title');
    t.appendChild(el('span', 'text', o.title));
    var x = el('button', 'popup-close'); x.type = 'button'; x.setAttribute('aria-label', 'Close');
    x.onclick = function () { MesUI.closeDialog(b); if (o.onCancel) o.onCancel(); };
    t.appendChild(x);
    var f = el('div', 'dialog-footer');
    if (o.cancelText) {
      var c = el('button', 'btn search', o.cancelText); c.type = 'button';
      c.onclick = function () { MesUI.closeDialog(b); if (o.onCancel) o.onCancel(); };
      f.appendChild(c);
    }
    var ok = el('button', 'btn search primary', o.okText || 'OK'); ok.type = 'button';
    ok.onclick = function () { MesUI.closeDialog(b); if (o.onOk) o.onOk(); };
    f.appendChild(ok);
    d.appendChild(t); d.appendChild(el('div', 'msg-body', o.message)); d.appendChild(f);
    b.appendChild(d); document.body.appendChild(b); ok.focus();
    return b;
  }
  /* alert(msg, 'Warning'|'Information'|'Error'|'Confirm'…, onOk) */
  MesUI.alert = function (msg, type, onOk) {
    if (typeof type === 'function') { onOk = type; type = null; }
    return msgDialog({ title: type || 'Warning', message: msg, onOk: onOk });
  };
  /* confirm(msg, onOk, {title:'Confirm'|'Delete', okText, cancelText, onCancel}) */
  MesUI.confirm = function (msg, onOk, opts) {
    opts = opts || {};
    return msgDialog({ title: opts.title || 'Confirm', message: msg, onOk: onOk, onCancel: opts.onCancel,
                       okText: opts.okText || 'OK', cancelText: opts.cancelText || 'Cancel' });
  };

  /* ---------- 토스트 · 알림 바 ---------- */
  /* toast(msg, 'ok'|'warn'|'error'|'info', ms) — 우상단 카드 */
  MesUI.toast = function (msg, type, ms) {
    type = BADGE_STATES.indexOf(type) >= 0 ? type : 'info';
    var t = el('div', 'toast ' + type);
    t.appendChild(el('span', 't-title', TYPE_TITLE[type] || 'Information'));
    t.appendChild(el('span', 't-msg', msg));
    area('toast-area').appendChild(t);
    setTimeout(function () { t.remove(); }, ms || 2500);
    return t;
  };
  /* notify(msg, type, ms) — OI touch-index showMessage 상단 알림 바. ms=0 이면 수동 닫기 */
  MesUI.notify = function (msg, type, ms) {
    var a = area('notifier-area'); a.innerHTML = '';
    var n = el('div', 'notifier ' + (type || 'info'));
    n.appendChild(el('span', 'n-msg', msg));
    var x = el('button', 'n-close'); x.type = 'button'; x.onclick = function () { n.remove(); };
    n.appendChild(x); a.appendChild(n);
    if (ms !== 0) setTimeout(function () { n.remove(); }, ms || 3000);
    return n;
  };

  /* ---------- 그리드 ---------- */
  function rowData(tr) {                      /* th[data-key] 또는 헤더 텍스트를 키로 셀 값 수집 */
    var table = tr.closest('table'), head = table && table.tHead && table.tHead.rows[0], o = {};
    Array.prototype.forEach.call(tr.cells, function (td, i) {
      var th = head && head.cells[i];
      var key = td.dataset.key || (th && (th.dataset.key || th.textContent.trim())) || String(i);
      o[key] = td.dataset.value != null ? td.dataset.value : td.textContent.trim();
    });
    return o;
  }
  /* selectRow(tr) — 단일 선택(.selected) 후 tr 에서 'rowselect' 이벤트(detail: row,index,table,data) 발생 */
  MesUI.selectRow = function (tr) {
    tr = byId(tr);
    if (!tr) return null;
    var tb = tr.parentNode;
    Array.prototype.forEach.call(tb.querySelectorAll('tr.selected'), function (r) { r.classList.remove('selected'); });
    tr.classList.add('selected');
    tr.dispatchEvent(new CustomEvent('rowselect', { bubbles: true, detail: {
      row: tr, index: Array.prototype.indexOf.call(tb.rows, tr), table: tr.closest('table'), data: rowData(tr) } }));
    return tr;
  };
  MesUI.selectedRow = function (table) { table = byId(table); return table ? table.querySelector('tbody tr.selected') : null; };
  /* 체크박스 열(td.col-check) 전체 선택/해제 */
  MesUI.checkAll = function (table, on) {
    table = byId(table);
    Array.prototype.forEach.call(table.tBodies[0].rows, function (tr) {
      if (tr.classList.contains('hidden')) return;
      var cb = tr.querySelector('td.col-check input[type=checkbox]');
      if (cb && !cb.disabled) { cb.checked = !!on; tr.classList.toggle('checked', !!on); }
    });
  };
  MesUI.checkedRows = function (table) { table = byId(table); return Array.prototype.slice.call(table.querySelectorAll('tbody tr.checked')); };
  /* filterGrid('grdMain', function(tr, cells, data){ return bool }) → 표시 건수. predicate 생략 시 전체 표시 */
  MesUI.filterGrid = function (tableId, predicate) {
    var table = byId(tableId), n = 0;
    if (!table) return 0;
    Array.prototype.forEach.call(table.tBodies[0].rows, function (tr) {
      var cells = Array.prototype.map.call(tr.cells, function (td) { return td.textContent.trim(); });
      var show = !predicate || !!predicate(tr, cells, rowData(tr));
      tr.classList.toggle('hidden', !show);
      if (show) n++;
    });
    MesUI.renumber(table);
    MesUI.setTotal(table, n);
    return n;
  };
  /* setTotal(table, n) — [data-total-for="tableId"] 요소를 'Total <b>n</b>' 로 갱신 */
  MesUI.setTotal = function (table, n) {
    table = byId(table);
    if (n == null) n = table.tBodies[0].querySelectorAll('tr:not(.hidden)').length;
    document.querySelectorAll('[data-total-for="' + table.id + '"]').forEach(function (o) {
      o.textContent = 'Total '; var b = el('b', null, MesUI.fmt(n)); o.appendChild(b);
    });
    return n;
  };
  /* renumber(table) — td.col-no 를 표시 순서대로 1..n */
  MesUI.renumber = function (table) {
    table = byId(table); var i = 0;
    Array.prototype.forEach.call(table.tBodies[0].rows, function (tr) {
      var no = tr.querySelector('td.col-no');
      if (no && !tr.classList.contains('hidden')) no.textContent = ++i;
    });
  };

  /* ---------- 배지 ---------- */
  /* setBadge(el, 'ok'|'warn'|'error'|'info'|'muted', text?) */
  MesUI.setBadge = function (e, state, text) {
    e = byId(e);
    BADGE_STATES.forEach(function (s) { e.classList.remove(s); });
    e.classList.add('badge', BADGE_STATES.indexOf(state) >= 0 ? state : 'muted');
    if (text != null) e.textContent = text;
    return e;
  };

  /* ---------- PIN 패드 ---------- */
  /* pinpad(hostEl, {length:4, onComplete(pin, api), onChange(pin)}) → api {value, reset(), error()} */
  MesUI.pinpad = function (host, opts) {
    host = byId(host); opts = opts || {};
    var len = opts.length || 4, value = '';
    host.classList.add('pinpad'); host.innerHTML = '';
    var disp = el('div', 'pin-display'), masks = [];
    for (var i = 0; i < len; i++) { var m = el('span', 'mask'); masks.push(m); disp.appendChild(m); }
    host.appendChild(disp);
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'Clear', '0', 'Del'].forEach(function (k) {
      var b = el('button', 'key' + (isNaN(k) ? ' fn' : ''), k); b.type = 'button'; b.dataset.key = k; host.appendChild(b);
    });
    function render() { masks.forEach(function (m, i) { m.classList.toggle('on', i < value.length); }); }
    function press(k) {
      if (k === 'Clear') value = '';
      else if (k === 'Del') value = value.slice(0, -1);
      else if (/^\d$/.test(k) && value.length < len) value += k;
      else return;
      disp.classList.remove('error'); render();
      if (opts.onChange) opts.onChange(value);
      if (value.length === len && opts.onComplete) opts.onComplete(value, api);
    }
    host.addEventListener('click', function (e) { var b = e.target.closest('.key'); if (b) press(b.dataset.key); });
    host.tabIndex = 0;                         /* 물리 키보드 입력도 수용 */
    host.addEventListener('keydown', function (e) {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') press('Del');
      else if (e.key === 'Escape') press('Clear');
      else return;
      e.preventDefault();
    });
    var api = {
      get value() { return value; },
      reset: function () { value = ''; disp.classList.remove('error'); render(); },
      error: function () { disp.classList.add('error'); }
    };
    return api;
  };

  /* ---------- 마크업 위임 ---------- */
  document.addEventListener('click', function (e) {
    var o = e.target.closest('[data-dialog-open]');
    if (o) { MesUI.openDialog(o.getAttribute('data-dialog-open')); return; }
    var c = e.target.closest('[data-dialog-close]');
    if (c) { MesUI.closeDialog(c.closest('.dialog-backdrop')); return; }
    var hcb = e.target.closest('th.col-check input[type=checkbox]');
    if (hcb) { MesUI.checkAll(hcb.closest('table'), hcb.checked); return; }
    var cb = e.target.closest('td.col-check input[type=checkbox]');
    if (cb) { cb.closest('tr').classList.toggle('checked', cb.checked); return; }
    if (e.target.closest('button, a, input, select, textarea, label')) return;
    var tr = e.target.closest('table.grid.selectable tbody tr');
    if (tr) MesUI.selectRow(tr);
  });
  document.addEventListener('keydown', function (e) {   /* ESC 로 최상단 다이얼로그 닫기 */
    if (e.key !== 'Escape') return;
    var opened = document.querySelectorAll('.dialog-backdrop.open');
    var last = opened[opened.length - 1];
    if (last && !last.hasAttribute('data-no-esc')) MesUI.closeDialog(last);
  });
  document.addEventListener('DOMContentLoaded', function () {
    MesUI.stampAll();
    if (document.querySelector('[data-now-live]')) setInterval(MesUI.stampAll, 1000);
    document.querySelectorAll('[data-total-for]').forEach(function (o) {   /* 초기 Total 자동 계산 */
      var t = document.getElementById(o.getAttribute('data-total-for'));
      if (t && !o.textContent.trim()) MesUI.setTotal(t);
    });
  });

  global.MesUI = MesUI;
})(window);
