/* embr-mock.js — 목업 화면(S-49 ~ S-57, DC-03) 공용 로더 · 시뮬 (MK-01 · MK-03)
   - 실구현 없음: 오프라인 · 아카이브 · 연동 영역의 '있을 법한 화면'만 보여 준다.
   - 저장은 'embrMock.' 로 시작하는 키만. 그 밖의 키(ebr.* · ebmr.* 등 출하 게이트 · 서명 원장 · 무결성 워터마크가 읽는 키)는
     읽지도 쓰지도 않으며, setState 에 다른 키를 주면 { ok:false, why:'mock_key_forbidden' } 로 거부한다.
   - 공통 서명 창 · 감사 기록 · 세션 헬퍼(ebr-*.js)를 부르지 않는다. 이 파일 + embr-mock-fixtures.js + mesui.js 만 로드.
   API: EmbrMock.fixture(area) · state(area) · setState(area|key, v) · reset() · sha256(text) · isMock === true
        시뮬: offlineView() · setScenario(name) · addBuffer(row) · verifyPackage(pkgId) · reprocess(msgId) · reconcile(batchId, target)
        화면: EmbrMock.ui.{esc, badge, applyDisabled, fit, tabs, keepUi} */
(function (global) {
  'use strict';
  var PREFIX = 'embrMock.';
  var KEYS = { ui: 'embrMock.ui.v1', offline: 'embrMock.offline.v1', archive: 'embrMock.archive.v1', iface: 'embrMock.iface.v1' };
  var DEFAULTS = {
    ui: function () { return {}; },
    offline: function () { return { scenario: 'offline', bufferAdds: [] }; },
    archive: function () { return { checks: [] }; },
    iface: function () { return { msgState: {}, reconRunAt: null }; }
  };
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function ls() { try { return global.localStorage || null; } catch (e) { return null; } }
  function keyOf(areaOrKey) { return KEYS[areaOrKey] || String(areaOrKey); }

  function fixture(area) {
    var F = global.EmbrMockFixtures || {};
    return clone(F[area] || null);
  }
  function state(area) {
    var d = DEFAULTS[area] ? DEFAULTS[area]() : {};
    var s = ls(); if (!s) return d;
    var raw = null; try { raw = s.getItem(keyOf(area)); } catch (e) { raw = null; }
    if (raw == null) return d;
    try { var v = JSON.parse(raw); return (v && typeof v === 'object') ? Object.assign(d, v) : d; } catch (e) { return d; }
  }
  function setState(areaOrKey, v) {
    var k = keyOf(areaOrKey);
    if (k.indexOf(PREFIX) !== 0) return { ok: false, why: 'mock_key_forbidden', key: k };
    var s = ls(); if (!s) return { ok: false, why: 'no_storage' };
    try { s.setItem(k, JSON.stringify(v)); return { ok: true, key: k }; } catch (e) { return { ok: false, why: 'save_error' }; }
  }
  function reset() {
    var s = ls(); if (!s) return { ok: false, removed: [] };
    var ks = [];
    for (var i = 0; i < s.length; i++) { var k = s.key(i); if (k && k.indexOf(PREFIX) === 0) ks.push(k); }
    ks.forEach(function (k) { s.removeItem(k); });
    return { ok: true, removed: ks };
  }
  function sha256(text) {
    var c = global.crypto && global.crypto.subtle;
    if (!c || typeof TextEncoder === 'undefined') return Promise.reject(new Error('subtle_unavailable'));
    return c.digest('SHA-256', new TextEncoder().encode(String(text))).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (b) { return (b < 16 ? '0' : '') + b.toString(16); }).join('');
    });
  }

  /* ---- 오프라인 (S-49 · S-50 · S-51) ---- */
  var SCENARIOS = ['offline', 'reconnect', 'normal'];
  function offlineView() {
    var F = fixture('offline'), st = state('offline');
    var name = SCENARIOS.indexOf(st.scenario) >= 0 ? st.scenario : 'offline';
    var sc = F.scenarios[name];
    var adds = (st.bufferAdds || []).filter(function (r) { return r && r.termId; });
    if (name !== 'normal' && adds.length) {
      adds.forEach(function (r) {
        var list = sc.buffer[r.termId] || (sc.buffer[r.termId] = []);
        list.push({ seq: list.length + 1, batchId: r.batchId, step: r.step, item: r.item, value: r.value, unit: r.unit, at: r.at, src: 'OFFLINE', proc: '동기화 대기 (시뮬 추가)' });
        sc.terminals.forEach(function (t) { if (t.termId === r.termId) t.buffer += 1; });
      });
    }
    return { scenario: name, label: sc.label, data: sc, currentUser: F.currentUser, scenarios: SCENARIOS.map(function (k) { return { key: k, label: F.scenarios[k].label }; }) };
  }
  function setScenario(name) {
    if (SCENARIOS.indexOf(name) < 0) return { ok: false, why: 'bad_scenario' };
    var st = state('offline'); st.scenario = name; return setState('offline', st);
  }
  function addBuffer(row) {
    if (!row || !row.termId || !row.item) return { ok: false, why: 'bad_row' };
    var st = state('offline'); st.bufferAdds = (st.bufferAdds || []).concat([clone(row)]); return setState('offline', st);
  }

  /* ---- 아카이브 (S-52 · S-53) — fixture 내용 SHA-256 실제 재계산 · 비교 ---- */
  function pkgOf(id) { return (fixture('archive').packages || []).filter(function (p) { return p.pkgId === id; })[0] || null; }
  function verifyPackage(pkgId, nowText) {
    var p = pkgOf(pkgId);
    if (!p) return Promise.resolve({ ok: false, why: 'no_package' });
    if (!p.files.length) return Promise.resolve({ ok: false, why: 'not_finalized', pkgId: pkgId });
    return Promise.all(p.files.map(function (f) { return sha256(f.content); })).then(function (hs) {
      var computed = {}, bad = [];
      p.files.forEach(function (f, i) { computed[f.name] = hs[i]; if (hs[i] !== f.recordedHash) bad.push(f.name); });
      var rec = { pkgId: pkgId, at: nowText || '', result: bad.length ? 'fail' : 'pass', computed: computed, mismatch: bad };
      var st = state('archive'); st.checks = (st.checks || []).filter(function (c) { return c.pkgId !== pkgId; }).concat([rec]);
      var w = setState('archive', st);
      return Object.assign({ ok: true, saved: w.ok }, rec);
    });
  }
  function lastCheck(pkgId) { return (state('archive').checks || []).filter(function (c) { return c.pkgId === pkgId; })[0] || null; }

  /* ---- 연동 (S-55 · S-56 · S-57) ---- */
  function msgView(msgId) {
    var m = (fixture('iface').messages || []).filter(function (x) { return x.msgId === msgId; })[0];
    if (!m) return null;
    var s = state('iface').msgState || {};
    if (s[msgId]) m.simState = s[msgId];
    return m;
  }
  function reprocess(msgId) {
    var m = msgView(msgId); if (!m) return { ok: false, why: 'no_message' };
    var failed = m.checks.filter(function (c) { return !c.ok; });
    var next = failed.length ? 'dead_kept' : 'applied';
    var st = state('iface'); st.msgState = st.msgState || {}; st.msgState[msgId] = next;
    var w = setState('iface', st);
    return { ok: w.ok, msgId: msgId, state: next, failed: failed.map(function (c) { return c.key; }),
      msg: failed.length ? '재처리 대기 → 데드레터 유지: ' + failed.map(function (c) { return c.key + ' (' + c.expected + ' ≠ ' + c.actual + ')'; }).join(', ') + ' — 값 자동 환산 금지, 원 시스템에서 재전송 필요 (목업)'
                         : '재처리 시뮬 완료 — 반영 (목업 상태만 바뀜, eBR 기록 변경 없음)' };
  }
  /* 순수 비교: fixture 두 값 집합(eBR · 외부)을 행 단위로 비교 — 저장 없음(대사 시각만 목업 키) */
  function diffOf(a, b, unit) {
    if (typeof a === 'number' && typeof b === 'number') { var d = a - b; return d === 0 ? '0' : (d > 0 ? '+' : '') + d.toLocaleString('en-US') + (unit ? ' ' + unit : ''); }
    return a === b ? '-' : '값 다름';
  }
  function reconcile(batchId, target, nowText) {
    var r = (fixture('iface').recon || []).filter(function (x) { return x.batchId === batchId && x.target === target; })[0];
    if (!r) return { ok: false, why: 'no_recon' };
    var rows = r.rows.map(function (x) { return { item: x.item, ebr: x.ebr, ext: x.ext, unit: x.unit, diff: diffOf(x.ebr, x.ext, x.unit), match: x.ebr === x.ext }; });
    if (nowText) { var st = state('iface'); st.reconRunAt = nowText; setState('iface', st); }
    return { ok: true, batchId: batchId, target: target, label: r.label, rows: rows, mismatch: rows.filter(function (x) { return !x.match; }).length };
  }

  /* ---- 화면 공통 ---- */
  var ui = {
    esc: function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); },
    badge: function (cls, text) { return '<span class="badge' + (cls ? ' ' + cls : '') + '">' + ui.esc(text) + '</span>'; },
    /* 주격 조사 이/가 — 끝 괄호 설명·문장부호를 뺀 마지막 글자의 읽기 받침으로 고름
       한글은 받침, 숫자는 읽기(0영 1일 2이 3삼 4사 5오 6육 7칠 8팔 9구, 끝 0은 십·백·천·만·억·조), 영문은 글자 이름(L·M·N·R만 받침) */
    josa: function (text) {
      var t = ui.whySplit(text).base.replace(/[^0-9A-Za-z\uAC00-\uD7A3]+$/, ''), ch = t.charAt(t.length - 1), c = t.charCodeAt(t.length - 1), m;
      if (c >= 44032 && c <= 55203) return (c - 44032) % 28 ? '이' : '가';
      if (/[0-9]/.test(ch)) {
        var r = t.match(/[0-9]+$/)[0], unit = '영';
        if (/[1-9]/.test(r)) { m = /([1-9])(0*)$/.exec(r); var z = m[2].length;
          unit = !z ? '영일이삼사오육칠팔구'.charAt(+m[1]) : z < 4 ? '십백천'.charAt(z - 1) : '만억조'.charAt(Math.min(Math.floor(z / 4), 3) - 1); }
        return (unit.charCodeAt(0) - 44032) % 28 ? '이' : '가';
      }
      if (/[A-Za-z]/.test(ch)) return /[LMNR]/i.test(ch) ? '이' : '가';
      return '이(가)';
    },
    /* 끝 괄호 설명(여러 겹·중첩 포함)을 떼어 냄 → { base, note } */
    whySplit: function (text) {
      var t = String(text == null ? '' : text).trim(), notes = [], i, d;
      while (/\)[\s.,·:;!?]*$/.test(t)) {
        var e = t.lastIndexOf(')'); d = 0;
        for (i = e; i >= 0; i--) { if (t.charAt(i) === ')') d++; else if (t.charAt(i) === '(' && !--d) break; }
        if (i < 0) break;
        notes.unshift(t.slice(i, e + 1)); t = t.slice(0, i).trim();
      }
      return { base: t, note: notes.join(' ') };
    },
    /* [data-mock-why] 버튼 = disabled + title "목업 - PoC 범위 밖 (DC-03). 운영에서는 {통제}이/가 필요한 동작 (괄호 설명)" (괄호 설명은 문장 끝으로) */
    whyTitle: function (why) {
      var w = ui.whySplit(why);
      return '목업 - PoC 범위 밖 (DC-03). 운영에서는 ' + w.base + ui.josa(w.base) + ' 필요한 동작' + (w.note ? ' ' + w.note : '');
    },
    applyDisabled: function (root) {
      Array.prototype.forEach.call((root || document).querySelectorAll('[data-mock-why]'), function (b) {
        b.disabled = true; b.setAttribute('aria-disabled', 'true');
        b.title = ui.whyTitle(b.getAttribute('data-mock-why')) + (b.getAttribute('data-mock-sign') ? ' — 예: ' + b.getAttribute('data-mock-sign') : '');
      });
    },
    fit: function () {
      var wrap = document.getElementById('shellScale'); if (!wrap) return;
      var sw = 1920, sh = 1080, w = global.innerWidth || sw, h = global.innerHeight || sh;
      try { if (global.frameElement) { var fr = global.frameElement.getBoundingClientRect(); if (fr.width > 40) w = fr.width; if (fr.height > 40) h = fr.height; } } catch (e) { /* cross-origin */ }
      var s = Math.min(w / sw, h / sh, 1); if (!(s > 0) || !isFinite(s)) s = 1;
      wrap.style.setProperty('--scale', String(s));   /* 폭 · 높이는 mesui .shell-scale 이 --scale 로 계산 */
      document.body.classList.add('fit-host');
    },
    bindFit: function () { global.addEventListener('resize', ui.fit); global.addEventListener('load', ui.fit); ui.fit(); },
    /* 탭 = .grid-toolbar 안 버튼 그룹 (별도 탭 클래스 없음). [data-tab] 버튼 ↔ [data-tab-pane] */
    tabs: function (screen, onChange) {
      var btns = document.querySelectorAll('[data-tab]');
      function go(t) {
        Array.prototype.forEach.call(btns, function (b) { var on = b.getAttribute('data-tab') === t; b.setAttribute('aria-selected', on ? 'true' : 'false');   /* 활성 탭도 secondary — primary 는 영역 주 버튼 1개만 */ });
        Array.prototype.forEach.call(document.querySelectorAll('[data-tab-pane]'), function (p) { p.classList.toggle('hidden', p.getAttribute('data-tab-pane') !== t); });
        ui.keepUi(screen, { tab: t }); if (onChange) onChange(t);
      }
      Array.prototype.forEach.call(btns, function (b) { b.addEventListener('click', function () { go(b.getAttribute('data-tab')); }); });
      return go;
    },
    keepUi: function (screen, patch) { var s = state('ui'); s[screen] = Object.assign(s[screen] || {}, patch); return setState('ui', s); },
    uiOf: function (screen) { return state('ui')[screen] || {}; },
    param: function (k) { try { return new URLSearchParams(global.location.search).get(k); } catch (e) { return null; } },
    now: function () { var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; }; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); }
  };

  global.EmbrMock = { VERSION: 1, isMock: true, PREFIX: PREFIX, KEYS: clone(KEYS),
    fixture: fixture, state: state, setState: setState, reset: reset, sha256: sha256,
    offlineView: offlineView, setScenario: setScenario, addBuffer: addBuffer,
    verifyPackage: verifyPackage, lastCheck: lastCheck, msgView: msgView, reprocess: reprocess, reconcile: reconcile, ui: ui };
})(typeof window !== 'undefined' ? window : globalThis);
