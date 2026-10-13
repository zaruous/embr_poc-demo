/* =====================================================================
   ebr-gate-cond-store.js — 출하 게이트 조건 7 원천 쓰기 (전역 EbrGateCond)
   - 설계: poc-release-gate-dynamic-design.md 개정 1 §2.3 (G4-04 발행 EF 저장 · G1-05 다운타임 · EF 회수) · §2.1/2.2 (G1-08 조건 5 · 6 저장소 골격)
   - 저장 키: ebr.batch.issued.v1 행에 efCount · efRange(EF 번호 배열) 추가 (발행 화면이 발행 직후 recordIssueEf 호출 — 한 번만)
              ebr.downtime.v1 { v:1, items:[{dtId, line, from, to, reason, efUsed[], efReturned[], transcribedBy[], reviewSignatureId, reviewedAt, reviewedBy, at, by}],
                                returns:[{retId, batchId, efNos[], at, by, note}] }   — 미사용 EF 회수(다운타임 없음)는 returns
              ebr.ifaceMsg.v1 · ebr.historianSnap.v1 { v:1, enabled:false, items:[] } (P0 골격 — 조건 5 · 6 N/A)
   - 모든 쓰기 = 현재 사용자 필요 · 감사(ebr.audit.v1) 함께, 감사 실패 시 원복. 다운타임 QA 검토 서명은 EbrExecSign.beginCondSign({no:7}).
   - EbrGateCond.create({ session?, signStatus? }) 로 노드 시험 주입.
   ===================================================================== */
(function (global) {
  'use strict';

  var KEYS = { ISSUED: 'ebr.batch.issued.v1', DOWNTIME: 'ebr.downtime.v1', IFACE: 'ebr.ifaceMsg.v1', HISTORIAN: 'ebr.historianSnap.v1' };
  var EF_MAX = 99;
  var MSG = {
    no_session: '사용자 세션 헬퍼(EbrUserSession)를 찾을 수 없습니다.', no_current_user: '현재 사용자를 선택하세요.', no_batch: '배치 ID가 없습니다.',
    no_issued: '발행 기록을 찾을 수 없습니다.', ef_already_set: '이 배치의 비상 양식(EF) 정보는 이미 저장되어 있습니다 (발행 기록 — 한 번만).',
    bad_ef_count: '비상 양식 매수는 0–' + EF_MAX + ' 정수여야 합니다.', bad_ef_nos: '비상 양식 번호가 올바르지 않습니다 (중복 · 빈 값 · 매수 불일치).', ef_prefix_required: '비상 양식 번호 접두(efPrefix) 또는 번호 목록(efNos)이 필요합니다.',
    bad_line: '라인이 필요합니다.', bad_time: '다운타임 시작 · 종료 시각이 올바르지 않습니다.', reason_required: '다운타임 사유를 입력하세요.',
    no_downtime: '다운타임을 찾을 수 없습니다.', already_closed: '이미 종료된 다운타임입니다.', ef_not_in_batch: '이 배치에 발행된 비상 양식이 아닙니다',
    ef_already_settled: '이미 사용 또는 회수로 기록된 비상 양식입니다', ef_unknown: '발행 기록에 비상 양식 정보가 없습니다 (이전 발행 기록).', bad_efnos_empty: '회수할 비상 양식 번호를 입력하세요.',
    already_reviewed: 'QA 검토가 끝난 다운타임은 바꿀 수 없습니다.', save_error: '저장에 실패했습니다 — 바뀌지 않았습니다.', src_unreadable: '저장소를 읽을 수 없습니다 — 바뀌지 않았습니다.'
  };

  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function str(v) { return v == null ? '' : String(v).trim(); }
  function fail(why, message, extra) { var r = { ok: false, why: why, message: message || MSG[why] || why }; if (extra) Object.keys(extra).forEach(function (k) { r[k] = extra[k]; }); return r; }
  function pad(n, w) { var s = String(n); while (s.length < w) s = '0' + s; return s; }
  function strList(a) { return (Array.isArray(a) ? a : (a == null || a === '' ? [] : [a])).map(str).filter(Boolean); }

  function create(opts) {
    opts = opts || {};
    function S() { return opts.session || global.EbrUserSession || null; }
    function ls() { return global.localStorage; }
    function raw(k) { return ls().getItem(k); }
    function restore(k, r) { try { if (r == null) ls().removeItem(k); else ls().setItem(k, r); } catch (e) { /* 무시 */ } }
    /* 쓰기 + 감사, 감사 실패 시 원복 */
    function commit(writes, audits) {
      var orig = writes.map(function (w) { return raw(w[0]); });
      try {
        writes.forEach(function (w) { ls().setItem(w[0], JSON.stringify(w[1])); });
        S().Audit.appendMany(audits);
      } catch (e) {
        writes.forEach(function (w, i) { restore(w[0], orig[i]); });
        return false;
      }
      return true;
    }
    function guard(batchId) {
      var s = S(); if (!s) return fail('no_session'); var me = s.getCurrentUserId(); if (!me) return fail('no_current_user');
      /* 조건 12 읽기 전용 (G1-04 · J4) — 저장도 거부. 배치 없는 다운타임 기록은 전역 무결성으로 판정 */
      var ge = opts.gateEval || global.EbrGateEval;
      if (ge) { var ro = ge.readOnly(str(batchId)); if (ro.readOnly) return fail('read_only', ge.MSG_READ_ONLY, { readOnlyWhy: ro.why }); }
      return { ok: true, me: me, s: s };
    }
    function readIssued() {
      var r = raw(KEYS.ISSUED); if (r == null) return { list: [], shape: 'array' };
      var v; try { v = JSON.parse(r); } catch (e) { return null; }
      if (Array.isArray(v)) return { list: v, shape: 'array', root: v };
      if (v && Array.isArray(v.batches)) return { list: v.batches, shape: 'batches', root: v };
      if (v && Array.isArray(v.items)) return { list: v.items, shape: 'items', root: v };
      return null;
    }
    function readDowntime() {
      var r = raw(KEYS.DOWNTIME); if (r == null) return { v: 1, items: [], returns: [] };
      var v; try { v = JSON.parse(r); } catch (e) { return null; }
      if (!v || !Array.isArray(v.items)) return null;
      if (!Array.isArray(v.returns)) v.returns = [];
      return v;
    }
    function findIssued(ir, batchId) { return ir.list.filter(function (b) { return b && str(b.batchId || b.batchNo || b.id) === batchId; })[0] || null; }
    function nextId(list, prefix, key) { var n = 0; list.forEach(function (x) { var m = x && String(x[key] || '').indexOf(prefix) === 0 ? parseInt(String(x[key]).slice(prefix.length), 10) : NaN; if (isFinite(m) && m > n) n = m; }); return prefix + pad(n + 1, 4); }
    function efRangeText(list) { return global.EbrGateEval && global.EbrGateEval.efText ? global.EbrGateEval.efText(list) : list.join(', '); }

    /**
     * G4-04 발행 기록에 비상 양식 정보 저장 (발행 화면이 발행 직후 1회). 이미 있으면 거부.
     * @param {{batchId, efCount:number, efPrefix?:string, efNos?:string[], screen?}} req  efNos 가 없으면 efPrefix + '-01' … '-NN'
     * @returns {{ok:true, batchId, efCount, efRange:string[], efRangeText}|{ok:false, why, message}}
     */
    function recordIssueEf(req) {
      req = req || {}; var g = guard(req.batchId); if (!g.ok) return g;
      var B = str(req.batchId); if (!B) return fail('no_batch');
      var n = Number(req.efCount);
      if (req.efCount == null || req.efCount === '' || !isFinite(n) || Math.floor(n) !== n || n < 0 || n > EF_MAX) return fail('bad_ef_count');
      var nos;
      if (req.efNos != null) {
        nos = strList(req.efNos);
        var seen = {}; if (nos.length !== n || nos.some(function (x) { if (seen[x]) return true; seen[x] = 1; return false; })) return fail('bad_ef_nos');
      } else {
        var px = str(req.efPrefix); if (!px && n > 0) return fail('ef_prefix_required');
        nos = []; for (var i = 1; i <= n; i++) nos.push(px + '-' + pad(i, 2));
      }
      var ir = readIssued(); if (!ir) return fail('src_unreadable');
      var rec = findIssued(ir, B); if (!rec) return fail('no_issued');
      if (rec.efCount != null || rec.efRange != null) return fail('ef_already_set', null, { efCount: rec.efCount, efRange: clone(rec.efRange) });
      rec.efCount = n; rec.efRange = nos.slice();
      var txt = efRangeText(nos);
      var ok = commit([[KEYS.ISSUED, ir.root || ir.list]], [{ uid: g.me, act: 'ISSUE_EF_RECORDED', tgt: B, val: n ? txt + ' · ' + n + '매' : '비상 양식 0매', batchId: B,
        before: { efCount: null }, after: { efCount: n, efRange: nos.slice() }, screen: req.screen }]);
      if (!ok) return fail('save_error');
      return { ok: true, batchId: B, efCount: n, efRange: nos.slice(), efRangeText: txt };
    }

    /**
     * 다운타임 기록 (시스템 정지 구간). to 없음 = 진행 중.
     * @param {{line, from, to?, reason, efUsed?:string[], transcribedBy?:string|string[], screen?}} req
     */
    function addDowntime(req) {
      req = req || {}; var g = guard(); if (!g.ok) return g;
      var line = str(req.line); if (!line) return fail('bad_line');
      var f = Date.parse(req.from), t = req.to ? Date.parse(req.to) : null;
      if (!isFinite(f) || (t !== null && (!isFinite(t) || t < f))) return fail('bad_time');
      var reason = str(req.reason); if (!reason) return fail('reason_required');
      var o = readDowntime(); if (!o) return fail('src_unreadable');
      var at = g.s.nowIsoLocal();
      var d = { dtId: nextId(o.items, 'DT-', 'dtId'), line: line, from: str(req.from), to: req.to ? str(req.to) : null, reason: reason,
                efUsed: strList(req.efUsed), efReturned: [], transcribedBy: strList(req.transcribedBy).map(function (x) { return x.toUpperCase(); }),
                reviewSignatureId: null, at: at, by: g.me };
      o.items.push(d);
      if (!commit([[KEYS.DOWNTIME, o]], [{ uid: g.me, act: 'DOWNTIME_RECORDED', tgt: d.dtId, val: line + ' · ' + d.from + ' ~ ' + (d.to || '진행 중') + ' · EF ' + d.efUsed.length + '매 · ' + reason, after: clone(d), screen: req.screen }])) return fail('save_error');
      return { ok: true, downtime: clone(d) };
    }
    /** 다운타임 종료 · 사용 EF · 전사자 보완 (QA 검토 전만). @param {{dtId, to?, efUsed?, transcribedBy?, screen?}} req */
    function updateDowntime(req) {
      req = req || {}; var g = guard(); if (!g.ok) return g;
      var o = readDowntime(); if (!o) return fail('src_unreadable');
      var d = o.items.filter(function (x) { return x && x.dtId === str(req.dtId); })[0]; if (!d) return fail('no_downtime');
      if (d.reviewSignatureId) return fail('already_reviewed');
      var before = clone(d);
      if (req.to != null) { var t = Date.parse(req.to); if (!isFinite(t) || t < Date.parse(d.from)) return fail('bad_time'); if (d.to) return fail('already_closed'); d.to = str(req.to); }
      if (req.efUsed != null) d.efUsed = strList(req.efUsed);
      if (req.transcribedBy != null) d.transcribedBy = strList(req.transcribedBy).map(function (x) { return x.toUpperCase(); });
      if (!commit([[KEYS.DOWNTIME, o]], [{ uid: g.me, act: 'DOWNTIME_UPDATED', tgt: d.dtId, val: d.line + ' · ' + d.from + ' ~ ' + (d.to || '진행 중') + ' · EF ' + d.efUsed.length + '매', before: before, after: clone(d), screen: req.screen }])) return fail('save_error');
      return { ok: true, downtime: clone(d) };
    }

    /**
     * 비상 양식 회수 기록 (서명 없음, 감사 EF_RETURNED). dtId 가 있으면 그 다운타임의 efReturned, 없으면 배치 returns(미사용 회수).
     * @param {{batchId, efNos:string[], dtId?, note?, screen?}} req
     */
    function recordEfReturn(req) {
      req = req || {}; var g = guard(req.batchId); if (!g.ok) return g;
      var B = str(req.batchId); if (!B) return fail('no_batch');
      var nos = strList(req.efNos); if (!nos.length) return fail('bad_efnos_empty');
      var ir = readIssued(); if (!ir) return fail('src_unreadable');
      var iss = findIssued(ir, B); if (!iss) return fail('no_issued');
      if (!Array.isArray(iss.efRange)) return fail('ef_unknown');
      var bad = nos.filter(function (x) { return iss.efRange.indexOf(x) < 0; });
      if (bad.length) return fail('ef_not_in_batch', MSG.ef_not_in_batch + ' (' + bad.join(', ') + ')', { efNos: bad });
      var o = readDowntime(); if (!o) return fail('src_unreadable');
      var settled = {};
      o.items.forEach(function (d) { (d.efUsed || []).concat(d.efReturned || []).forEach(function (x) { settled[x] = 1; }); });
      o.returns.forEach(function (r) { (r.efNos || []).forEach(function (x) { settled[x] = 1; }); });
      var dup = nos.filter(function (x, i) { return settled[x] || nos.indexOf(x) !== i; });
      if (dup.length) return fail('ef_already_settled', MSG.ef_already_settled + ' (' + dup.join(', ') + ')', { efNos: dup });
      var at = g.s.nowIsoLocal(), target;
      if (req.dtId) {
        var d = o.items.filter(function (x) { return x && x.dtId === str(req.dtId); })[0]; if (!d) return fail('no_downtime');
        d.efReturned = (d.efReturned || []).concat(nos); target = d.dtId;
      } else {
        var r = { retId: nextId(o.returns, 'EFR-', 'retId'), batchId: B, efNos: nos.slice(), at: at, by: g.me, note: str(req.note) };
        o.returns.push(r); target = r.retId;
      }
      if (!commit([[KEYS.DOWNTIME, o]], [{ uid: g.me, act: 'EF_RETURNED', tgt: B + ' · ' + target, val: efRangeText(nos) + ' · ' + nos.length + '매', batchId: B, after: { efNos: nos.slice(), dtId: req.dtId || null }, screen: req.screen }])) return fail('save_error');
      return { ok: true, batchId: B, efNos: nos.slice(), target: target };
    }

    function listDowntime(f) {
      f = f || {}; var o = readDowntime(); if (!o) return { ok: false, why: 'src_unreadable', items: [], returns: [] };
      return { ok: true, items: o.items.filter(function (d) { return !f.line || d.line === f.line; }).map(clone), returns: o.returns.filter(function (r) { return !f.batchId || r.batchId === f.batchId; }).map(clone) };
    }

    /** G1-08 조건 5 · 6 원천 저장소 골격 (없을 때만, P0 enabled:false) → { ok, created:[key] } */
    function ensureSkeleton() {
      var created = [];
      [KEYS.IFACE, KEYS.HISTORIAN].forEach(function (k) { if (raw(k) == null) { ls().setItem(k, JSON.stringify({ v: 1, enabled: false, items: [] })); created.push(k); } });
      return { ok: true, created: created };
    }

    return { VERSION: 1, KEYS: clone(KEYS), MSG: clone(MSG), EF_MAX: EF_MAX,
             recordIssueEf: recordIssueEf, addDowntime: addDowntime, updateDowntime: updateDowntime, recordEfReturn: recordEfReturn, listDowntime: listDowntime,
             ensureSkeleton: ensureSkeleton, create: create };
  }

  var API = create({});
  global.EbrGateCond = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
