/* =====================================================================
   eq-state-event-store.js — 설비 상태 · 이벤트 마스터 PoC 공용 저장소
   localStorage:
     ebr.equipmentState.v1  { version, updatedAt, states[] }
     ebr.equipmentEvent.v1  { version, updatedAt, events[] }
   트리 디자이너 검사기가 동일 키로 바인딩한다.
   ===================================================================== */
(function (global) {
  'use strict';

  var STATE_KEY = 'ebr.equipmentState.v1';
  var EVENT_KEY = 'ebr.equipmentEvent.v1';
  var SCHEMA = 'eq-state-event-poc-1';

  /** Flag definitions shown in UI */
  var FLAG_DEFS = [
    { key: 'usable', label: '사용가능', hint: 'usable — 생산/사용 허용' },
    { key: 'cleaning', label: '세척중', hint: 'cleaning' },
    { key: 'quarantine', label: '격리', hint: 'quarantine' },
    { key: 'calDue', label: '교정임박', hint: 'calDue' },
    { key: 'down', label: '고장', hint: 'down' },
    { key: 'inUse', label: '사용중', hint: 'inUse' }
  ];

  var INTERLOCK_GRADES = [
    { value: '', label: '(없음)' },
    { value: 'Warning', label: 'Warning (4)' },
    { value: 'Controlled', label: 'Controlled (3)' },
    { value: 'Hard-QA', label: 'Hard-QA (2)' },
    { value: 'Absolute', label: 'Absolute (1)' }
  ];

  function seedStates() {
    return [
      { code: 'IDLE', name: '대기', flags: { usable: true, cleaning: false, quarantine: false, calDue: false, down: false, inUse: false }, enabled: true, color: '#64748b', sortOrder: 10, note: '사용 종료 후 기본 대기' },
      { code: 'READY', name: '사용가능', flags: { usable: true, cleaning: false, quarantine: false, calDue: false, down: false, inUse: false }, enabled: true, color: '#16a34a', sortOrder: 20, note: '세척 완료 · 사용 대기' },
      { code: 'IN_USE', name: '사용중', flags: { usable: true, cleaning: false, quarantine: false, calDue: false, down: false, inUse: true }, enabled: true, color: '#2563eb', sortOrder: 30, note: '배치 실행 중 점유' },
      { code: 'CLEANING', name: '세척중', flags: { usable: false, cleaning: true, quarantine: false, calDue: false, down: false, inUse: false }, enabled: true, color: '#0891b2', sortOrder: 40, note: 'CIP/수동 세척 진행' },
      { code: 'CLEANED', name: '세척완료', flags: { usable: true, cleaning: false, quarantine: false, calDue: false, down: false, inUse: false }, enabled: true, color: '#0d9488', sortOrder: 50, note: '세척 종료 · 사용 가능' },
      { code: 'QUARANTINE', name: '격리', flags: { usable: false, cleaning: false, quarantine: true, calDue: false, down: false, inUse: false }, enabled: true, color: '#ca8a04', sortOrder: 60, note: '품질 격리 · 사용 금지' },
      { code: 'CAL_DUE', name: '교정임박', flags: { usable: false, cleaning: false, quarantine: false, calDue: true, down: false, inUse: false }, enabled: true, color: '#ea580c', sortOrder: 70, note: 'CMMS 교정 도래 · Absolute 인터록' },
      { code: 'DOWN', name: '고장정지', flags: { usable: false, cleaning: false, quarantine: false, calDue: false, down: true, inUse: false }, enabled: true, color: '#dc2626', sortOrder: 80, note: 'RAS DOWN/SCRAP' }
    ];
  }

  function seedEvents() {
    return [
      {
        code: 'CLEAN_START', name: '세척 시작',
        fromStates: ['IDLE', 'READY', 'CLEANED'], toState: 'CLEANING',
        actions: { log: true, esig: true, esigPerform: true, esigVerify: false, esigMeaning: '세척 시작 확인', interlockGrade: 'Controlled' },
        enabled: true, sortOrder: 10, note: '세척 작업 착수'
      },
      {
        code: 'CLEAN_END', name: '세척 종료',
        fromStates: ['CLEANING'], toState: 'CLEANED',
        actions: { log: true, esig: true, esigPerform: true, esigVerify: true, esigMeaning: '세척 완료 검증', interlockGrade: 'Controlled' },
        enabled: true, sortOrder: 20, note: '세척 완료 → 사용가능'
      },
      {
        code: 'USE_START', name: '사용 시작',
        fromStates: ['READY', 'CLEANED', 'IDLE'], toState: 'IN_USE',
        actions: { log: true, esig: false, esigPerform: false, esigVerify: false, esigMeaning: '', interlockGrade: 'Absolute' },
        enabled: true, sortOrder: 30, note: 'usable 플래그 필수 · Absolute'
      },
      {
        code: 'USE_END', name: '사용 종료',
        fromStates: ['IN_USE'], toState: 'IDLE',
        actions: { log: true, esig: false, esigPerform: false, esigVerify: false, esigMeaning: '', interlockGrade: 'Warning' },
        enabled: true, sortOrder: 40, note: '배치 종료 후 대기'
      },
      {
        code: 'CAL_DUE', name: '교정 도래',
        fromStates: ['*'], toState: 'CAL_DUE',
        actions: { log: true, esig: true, esigPerform: true, esigVerify: true, esigMeaning: '교정 임박 인지', interlockGrade: 'Hard-QA' },
        enabled: true, sortOrder: 50, note: 'CMMS 교정 만료 임박 · 전 상태에서 전이'
      }
    ];
  }

  function nowStamp() {
    try {
      if (global.MesUI && MesUI.nowStamp) return MesUI.nowStamp();
    } catch (e) { /* ignore */ }
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function loadStates() {
    try {
      var raw = localStorage.getItem(STATE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.states) && parsed.states.length) return parsed.states;
      }
    } catch (e) { /* ignore */ }
    var s = seedStates();
    saveStates(s);
    return s;
  }

  function saveStates(states) {
    /* P0: preserve runtime Equip items[] (cleanHoldUntil) co-stored under same key */
    var prev = {};
    try { prev = JSON.parse(localStorage.getItem(STATE_KEY) || '{}') || {}; } catch (e) { prev = {}; }
    var out = {
      schemaVersion: SCHEMA,
      version: 1,
      updatedAt: nowStamp(),
      states: states
    };
    if (Array.isArray(prev.items)) out.items = prev.items;
    if (prev.v != null) out.v = prev.v;
    localStorage.setItem(STATE_KEY, JSON.stringify(out));
  }

  function loadEvents() {
    try {
      var raw = localStorage.getItem(EVENT_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.events) && parsed.events.length) return parsed.events;
      }
    } catch (e) { /* ignore */ }
    var e = seedEvents();
    saveEvents(e);
    return e;
  }

  function saveEvents(events) {
    localStorage.setItem(EVENT_KEY, JSON.stringify({
      schemaVersion: SCHEMA,
      version: 1,
      updatedAt: nowStamp(),
      events: events
    }));
  }

  function restoreSeeds() {
    var s = seedStates();
    var e = seedEvents();
    saveStates(s);
    saveEvents(e);
    return { states: s, events: e };
  }

  function activeStates() {
    return loadStates().filter(function (s) { return s.enabled !== false; })
      .slice().sort(function (a, b) { return (a.sortOrder || 0) - (b.sortOrder || 0); });
  }

  function activeEvents() {
    return loadEvents().filter(function (ev) { return ev.enabled !== false; })
      .slice().sort(function (a, b) { return (a.sortOrder || 0) - (b.sortOrder || 0); });
  }

  function stateByCode(code) {
    if (!code) return null;
    var list = loadStates();
    for (var i = 0; i < list.length; i++) if (list[i].code === code) return list[i];
    return null;
  }

  function eventByCode(code) {
    if (!code) return null;
    var list = loadEvents();
    for (var i = 0; i < list.length; i++) if (list[i].code === code) return list[i];
    return null;
  }

  /** Options for <select>: active states (+ optional ANY) */
  function stateOptionsHtml(selected, opts) {
    opts = opts || {};
    var html = '';
    if (opts.blank !== false) html += '<option value="">' + (opts.blankLabel || '(선택)') + '</option>';
    if (opts.any) html += '<option value="*"' + (selected === '*' ? ' selected' : '') + '>ANY (*)</option>';
    activeStates().forEach(function (s) {
      html += '<option value="' + esc(s.code) + '"' + (selected === s.code ? ' selected' : '') + '>' +
        esc(s.code) + ' — ' + esc(s.name) + '</option>';
    });
    return html;
  }

  function eventOptionsHtml(selected, opts) {
    opts = opts || {};
    var html = '';
    if (opts.blank !== false) html += '<option value="">' + (opts.blankLabel || '(이벤트 없음)') + '</option>';
    activeEvents().forEach(function (ev) {
      html += '<option value="' + esc(ev.code) + '"' + (selected === ev.code ? ' selected' : '') + '>' +
        esc(ev.code) + ' — ' + esc(ev.name) + '</option>';
    });
    return html;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function flagBadges(flags) {
    flags = flags || {};
    return FLAG_DEFS.filter(function (d) { return !!flags[d.key]; })
      .map(function (d) {
        return '<span class="flag-chip ' + d.key + '" title="' + esc(d.hint) + '">' + esc(d.label) + '</span>';
      }).join('');
  }

  global.EqStateEvent = {
    STATE_KEY: STATE_KEY,
    EVENT_KEY: EVENT_KEY,
    SCHEMA: SCHEMA,
    FLAG_DEFS: FLAG_DEFS,
    INTERLOCK_GRADES: INTERLOCK_GRADES,
    seedStates: seedStates,
    seedEvents: seedEvents,
    loadStates: loadStates,
    saveStates: saveStates,
    loadEvents: loadEvents,
    saveEvents: saveEvents,
    restoreSeeds: restoreSeeds,
    activeStates: activeStates,
    activeEvents: activeEvents,
    stateByCode: stateByCode,
    eventByCode: eventByCode,
    stateOptionsHtml: stateOptionsHtml,
    eventOptionsHtml: eventOptionsHtml,
    flagBadges: flagBadges,
    esc: esc
  };
})(typeof window !== 'undefined' ? window : this);
