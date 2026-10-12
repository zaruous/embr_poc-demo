/* =====================================================================
   ebr-balance-check-store.js — 저울 일상 점검 저장소 (전역 EbrBalanceCheck, EbrP0.BalanceCheck 별칭)
   - 설계: poc-balance-check-and-weigh-record-design.md 개정 2 §2 (B1-1 · B1-2 · B1-5), API: balchk-work/api-signatures.md
   - 화면과 묶지 않는다(DOM · 화면 전역 읽지 않음). EbrBalanceCheck.create({ storage, session, dispense, today, now }) 로 주입.
   - 저장 키: ebr.balanceCheck.v1 (이 파일 소유, 점검 이력은 추가만 — 수정 · 삭제 API 없음)
     함께 쓰기(서명 커밋 · 시드 안에서만): ebr.equipmentState.v1 저울 행 dailyCheck(요약 미러 — G12 조건 그대로) · ebr.deviation.v1(불합격 일탈)
   - 서명 · 감사는 EbrUserSession(beginRecordSign · signAndCommitRecord · cancelRecordSign). 인증 = ID + 비밀번호(헬퍼만 판정, 여기선 받지도 저장하지도 않음)
   - 허용 범위(tolPct) · 점검 점은 계획(plans)에 적힌 SOP 값 — store 상수가 아님. 시드 값(±0.10 %, 3점)은 데모 예시
   ===================================================================== */
(function (global) {
  'use strict';

  var KEY = 'ebr.balanceCheck.v1';
  var KEYS = { BC: KEY, EQ: 'ebr.equipmentState.v1', DEV: 'ebr.deviation.v1' };
  var RULES = { CHECK: 'SM-PERF-BALCHK', RECHECK: 'SM-PERF-BALRECHK' };
  var PRECHECKS = ['level', 'zero', 'clean'];
  var PRECHECK_LABEL = { level: '수평', zero: '영점', clean: '청결' };
  var SOURCES = ['SIM', 'MANUAL'];
  var MSG = {
    no_session: '사용자 · 서명 모듈(EbrUserSession)이 로드되지 않았습니다.',
    no_current_user: '현재 사용자를 선택하세요 — 점검 서명은 현재 사용자로만 합니다.',
    no_balance: '저울 런타임 기록이 없습니다 — 설비 상태에서 저울을 등록하세요.',
    no_plan: '이 저울 클래스의 점검 계획이 없습니다 — 기준정보 점검 계획을 확인하세요.',
    cal_expired: '교정이 만료된 저울은 일상 점검을 할 수 없습니다 — 교정 후 다시 시도하세요.',
    weight_cert_expired: '인증이 만료된 분동이 있어 판정할 수 없습니다 — 다른 분동으로 바꾸거나 재인증 후 다시 시도하세요.',
    incomplete: '측정하지 않은 분동이 있습니다 — 모든 점을 측정한 뒤 서명하세요.',
    reason_required: '불합격 사유를 입력하세요.',
    reason_too_long: '사유는 60자 이내로 입력하세요.',
    record_changed: '서명 창을 연 뒤 이 저울의 점검 기록이 바뀌었습니다 — 창을 닫고 다시 여세요.',
    save_error: '점검을 저장하지 못했습니다 — 변경을 되돌렸습니다. 다시 시도하세요.'
  };

  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function p2(n) { return (n < 10 ? '0' : '') + n; }
  function pad(n, w) { var s = String(n); while (s.length < w) s = '0' + s; return s; }
  function round(n, d) { var f = Math.pow(10, d); return Math.round((Number(n) + (Number(n) >= 0 ? 1e-9 : -1e-9)) * f) / f; }
  function num(v) { if (v === '' || v == null || typeof v === 'boolean') return NaN; var x = Number(v); return isFinite(x) ? x : NaN; }
  function str(v) { return String(v == null ? '' : v).trim(); }
  function charLen(s) { return Array.from(String(s == null ? '' : s)).length; }
  function localYmd(d) { d = d || new Date(); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); }
  function nowIsoLocal(d) {
    d = d || new Date();
    var off = -d.getTimezoneOffset(), sg = off >= 0 ? '+' : '-', a = Math.abs(off);
    return localYmd(d) + 'T' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()) + sg + p2(Math.floor(a / 60)) + ':' + p2(a % 60);
  }
  function ymdToUtc(s) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN; }
  function addDays(ymd, n) { var t = ymdToUtc(ymd); if (isNaN(t)) return ''; var d = new Date(t + n * 86400000); return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()); }
  function daysUntil(dateStr, today) { var a = ymdToUtc(today), b = ymdToUtc(dateStr); return isNaN(a) || isNaN(b) ? null : Math.round((b - a) / 86400000); }
  function tsOf(v) { var t = Date.parse(str(v)); return isNaN(t) ? 0 : t; }
  /* 시드 시각: 로컬 날짜 + 시:분:초 + 현재 시간대 오프셋 (KST +09:00) */
  function atOf(ymd, hms) { var off = -new Date().getTimezoneOffset(), sg = off >= 0 ? '+' : '-', a = Math.abs(off); return ymd + 'T' + hms + sg + p2(Math.floor(a / 60)) + ':' + p2(a % 60); }

  /* ---- 순수 판정 ---- */
  /* judgePoint(point, measured, tolPct?) → { ok, lo, hi, devPct } — lo/hi = nominal × (1 ∓ tolPct/100), 소수 6자리(0.020 kg 점의 ±0.1 % 를 잃지 않게), 경계 포함 */
  function judgePoint(point, measured, tolPct) {
    point = point || {};
    var nom = num(point.nominal), tol = num(tolPct != null ? tolPct : point.tolPct), m = num(measured);
    if (isNaN(nom) || nom <= 0 || isNaN(tol) || tol < 0) return { ok: false, lo: null, hi: null, devPct: null, why: 'bad_point' };
    var lo = round(nom * (1 - tol / 100), 6), hi = round(nom * (1 + tol / 100), 6);
    if (isNaN(m)) return { ok: false, lo: lo, hi: hi, devPct: null, why: 'not_measured' };
    return { ok: m >= lo - 1e-9 && m <= hi + 1e-9, lo: lo, hi: hi, devPct: round((m - nom) / nom * 100, 2) };
  }
  /* judgeCheck(draft, plan) → { result:'pass'|'fail'|'incomplete', failed, expired, missing, maxDev, n, points, prechecks, precheckFailed }
     plan = planFor().plan (점 · 분동 · tolPct). 우선순위: 분동 인증 만료 → incomplete > 미측정 → incomplete > 사전 확인 false · 범위 밖 → fail > pass */
  function judgeCheck(draft, plan) {
    draft = draft || {}; plan = plan || {};
    var given = {}; (draft.points || []).forEach(function (p) { if (p && p.weightId) given[str(p.weightId)] = p; });
    var pre = {}, prf = [];
    (plan.prechecks || PRECHECKS).forEach(function (k) { pre[k] = !!(draft.prechecks && draft.prechecks[k] === true); if (!pre[k]) prf.push(k); });
    var failed = [], expired = [], missing = [], maxDev = null;
    var pts = (plan.points || []).map(function (pt) {
      var g = given[pt.weightId] || {}, j = judgePoint(pt, g.measured, plan.tolPct);
      var row = { weightId: pt.weightId, nominal: pt.nominal, uom: pt.uom || 'kg', certDue: pt.certDue || null, weightExpired: !!pt.weightExpired,
                  lo: j.lo, hi: j.hi, measured: isNaN(num(g.measured)) ? null : num(g.measured), devPct: j.devPct, source: SOURCES.indexOf(str(g.source)) >= 0 ? str(g.source) : (isNaN(num(g.measured)) ? null : 'SIM'), ok: false };
      if (pt.weightExpired) { expired.push(pt.weightId); return row; }
      if (row.measured == null) { missing.push(pt.weightId); return row; }
      row.ok = j.ok;
      if (!j.ok) failed.push(pt.weightId);
      if (j.devPct != null && (!maxDev || Math.abs(j.devPct) > Math.abs(maxDev.devPct))) maxDev = { weightId: pt.weightId, devPct: j.devPct };
      return row;
    });
    var result = expired.length || missing.length || !pts.length ? 'incomplete' : (failed.length || prf.length ? 'fail' : 'pass');
    return { result: result, failed: failed, expired: expired, missing: missing, maxDev: maxDev, n: pts.length, points: pts, prechecks: pre, precheckFailed: prf };
  }

  /* ---- 시드 정의 (today 상대) ---- */
  var SOP_REF = 'SOP-QC-BAL-001 v3';
  function weightSeed(t) {
    var due = addDays(t, 170);
    return [
      { weightId: 'W-E2-002', nominal: 0.02, uom: 'kg', class: 'E2', certDue: due, status: 'active' },
      { weightId: 'W-E2-200', nominal: 2, uom: 'kg', class: 'E2', certDue: due, status: 'active' },
      { weightId: 'W-E2-500', nominal: 5, uom: 'kg', class: 'E2', certDue: due, status: 'active' },
      { weightId: 'W-F1-2K', nominal: 2, uom: 'kg', class: 'F1', certDue: due, status: 'active' },
      { weightId: 'W-F1-100K', nominal: 100, uom: 'kg', class: 'F1', certDue: due, status: 'active' },
      { weightId: 'W-F1-250K', nominal: 250, uom: 'kg', class: 'F1', certDue: due, status: 'active' }
    ];
  }
  var PLAN_SEED = [
    { planId: 'BCP-EC-BAL-01', ver: 1, eqClass: 'EC-BAL-01', sopRef: SOP_REF, tolPct: 0.10, status: 'effective', prechecks: PRECHECKS.slice(),
      points: [{ weightId: 'W-E2-002' }, { weightId: 'W-E2-200' }, { weightId: 'W-E2-500' }] },
    { planId: 'BCP-EC-BAL-02', ver: 1, eqClass: 'EC-BAL-02', sopRef: SOP_REF, tolPct: 0.10, status: 'effective', prechecks: PRECHECKS.slice(),
      points: [{ weightId: 'W-F1-2K' }, { weightId: 'W-F1-100K' }, { weightId: 'W-F1-250K' }] }
  ];
  /* 시드 점검: [balanceId, 날짜 오프셋, 시각, 결과, 서명자, 측정 편차(점별 %)] — BAL-101 · BAL-302 는 없음 */
  var CHECK_SEED = [
    ['BAL-301', 0, '08:12:00', 'pass', 'OP-0101', [0, 0.02, -0.01]],
    ['BAL-205', -1, '08:05:00', 'pass', 'OP-0101', [0, 0.05, -0.02]],
    ['BAL-102', -1, '08:03:41', 'pass', 'OP-0101', [0, 0.03, 0.01]],
    ['BAL-102', 0, '07:55:00', 'fail', 'OP-0101', [0, 0.30, 0.02]]
  ];
  var SEED_DEV = { id: 'DEV-BAL102-01', balanceId: 'BAL-102' };

  /* ================================================================== 인스턴스 */
  function create(opts) {
    opts = opts || {};
    var failNextStage = null;
    function storage() { return opts.storage || global.localStorage; }
    function session() { return opts.session || global.EbrUserSession || null; }
    function dispense() { var D = typeof opts.dispense === 'function' ? opts.dispense() : (opts.dispense || global.EbrDispense); return D && typeof D.listRecords === 'function' ? D : null; }
    function today() { return typeof opts.today === 'function' ? opts.today() : (opts.today || localYmd()); }
    function nowIso() { return typeof opts.now === 'function' ? opts.now() : nowIsoLocal(); }
    function readRaw(k) { try { return storage().getItem(k); } catch (e) { return null; } }
    function readJson(k, fb) { var raw = readRaw(k); if (raw == null || raw === '') return fb; try { var o = JSON.parse(raw); return o == null ? fb : o; } catch (e) { return fb; } }
    function writeJson(k, obj, stage) {
      if (stage && failNextStage === stage) { failNextStage = null; throw new Error('저장 실패 주입 (' + stage + ')'); }
      storage().setItem(k, JSON.stringify(obj));
    }
    function hashOf(o) { var S = session(); return S && S.computeValueHash ? S.computeValueHash(o) : ''; }
    function fail(why, message, extra) { var r = { ok: false, why: why, message: message || MSG[why] || why }; if (extra) Object.keys(extra).forEach(function (k) { r[k] = extra[k]; }); return r; }

    function bcLoad() {
      var o = readJson(KEY, null);
      if (!o || typeof o !== 'object') o = {};
      ['weights', 'plans', 'checks'].forEach(function (k) { if (!Array.isArray(o[k])) o[k] = []; });
      if (!o.seq || typeof o.seq !== 'object') o.seq = {};
      o.v = 1;
      return o;
    }
    function eqLoad() {
      var o = readJson(KEYS.EQ, null);
      if (!o) o = { v: 1, items: [] };
      if (Array.isArray(o)) o = { v: 1, items: o };
      if (!Array.isArray(o.items) && Array.isArray(o.equipment)) o.items = o.equipment;
      if (!Array.isArray(o.items)) o.items = [];
      return o;
    }
    function devLoad() { var o = readJson(KEYS.DEV, null); if (!o || !Array.isArray(o.items)) o = { v: 1, items: [] }; if (o.v == null) o.v = 1; return o; }
    function eqFind(items, id) { id = str(id); for (var i = 0; i < items.length; i++) { var it = items[i]; if (it && str(it.equipmentId || it.id || it.eqId) === id) return it; } return null; }
    function balanceRow(id) { var r = eqFind(eqLoad().items, id); return r && str(r.kind) === 'balance' ? r : null; }
    function seal(rec) { var b = clone(rec); delete b.recordHash; rec.recordHash = hashOf(b); return rec; }

    /* ---- 읽기 ---- */
    function weights() { return clone(bcLoad().weights); }
    function plans() { return clone(bcLoad().plans); }
    function planFor(balanceId) {
      var id = str(balanceId), b = balanceRow(id);
      if (!b) return fail('no_balance', MSG.no_balance, { balanceId: id });
      var o = bcLoad(), t = today(), cls = str(b.eqClass);
      var pl = o.plans.filter(function (p) { return p && str(p.eqClass) === cls && str(p.status || 'effective') === 'effective'; })
        .sort(function (a, c) { return (Number(c.ver) || 0) - (Number(a.ver) || 0); })[0];
      var bal = { balanceId: id, eqClass: cls, roomId: str(b.roomId), capMin: b.capMin, capMax: b.capMax, calDue: b.calDue || null, status: str(b.status) };
      if (!pl) return fail('no_plan', MSG.no_plan, { balance: bal });
      var wmap = {}; o.weights.forEach(function (w) { if (w && w.weightId) wmap[w.weightId] = w; });
      var plan = clone(pl);
      plan.points = (pl.points || []).map(function (pt) {
        var w = wmap[pt.weightId], d = w ? daysUntil(w.certDue, t) : null, nom = num(pt.nominal != null ? pt.nominal : (w && w.nominal));
        var j = judgePoint({ nominal: nom }, null, pl.tolPct);
        return { weightId: pt.weightId, nominal: nom, uom: (w && w.uom) || pt.uom || 'kg', class: w ? w.class : null, certDue: w ? w.certDue || null : null,
                 lo: j.lo, hi: j.hi, weightMissing: !w, weightExpired: !w || str(w.status || 'active') !== 'active' || d == null || d < 0 };
      });
      plan.prechecks = Array.isArray(pl.prechecks) && pl.prechecks.length ? pl.prechecks.slice() : PRECHECKS.slice();
      return { ok: true, plan: plan, balance: bal };
    }
    function checksOf(balanceId) {
      var id = str(balanceId);
      return bcLoad().checks.filter(function (c) { return c && c.balanceId === id; }).sort(function (a, b) { return tsOf(a.at) - tsOf(b.at) || (a.checkId < b.checkId ? -1 : 1); });
    }
    function lite(c) { return c ? { checkId: c.checkId, date: c.date, result: c.result, at: c.at, by: c.by, signatureId: c.signatureId || null, seed: !!c.seed } : null; }
    /* statusOf(balanceId, date?) — 그날 마지막(at 가장 늦은) 점검이 기준. blocked = 그날 마지막 점검이 불합격 */
    function statusOf(balanceId, date) {
      var d = str(date) || today(), all = checksOf(balanceId), day = all.filter(function (c) { return c.date === d; });
      var last = day[day.length - 1] || null, failDay = day.filter(function (c) { return c.result === 'fail'; }).slice(-1)[0] || null;
      var lp = all.filter(function (c) { return c.result === 'pass' && c.date <= d; }).slice(-1)[0] || null;
      return { balanceId: str(balanceId), date: d, state: last ? last.result : 'none', blocked: !!(last && last.result === 'fail'), checkId: last ? last.checkId : null,
               deviationId: failDay ? failDay.deviationId || null : null, last: lite(last), lastPass: lite(lp), seed: !!(last && last.seed) };
    }
    function listChecks(f) {
      f = f || {};
      var rows = bcLoad().checks.filter(function (c) {
        return c && (!f.balanceId || c.balanceId === str(f.balanceId)) && (!f.roomId || c.roomId === str(f.roomId)) && (!f.result || c.result === str(f.result)) &&
          (!f.from || c.date >= str(f.from).slice(0, 10)) && (!f.to || c.date <= str(f.to).slice(0, 10));
      }).sort(function (a, b) { return tsOf(b.at) - tsOf(a.at) || (a.checkId < b.checkId ? 1 : -1); });
      var total = rows.length, off = Math.max(0, parseInt(f.offset, 10) || 0), lim = parseInt(f.limit, 10);
      return { ok: true, total: total, rows: clone(lim > 0 ? rows.slice(off, off + lim) : rows.slice(off)) };
    }
    function getCheck(checkId) { var c = bcLoad().checks.filter(function (x) { return x && x.checkId === str(checkId); })[0]; return c ? clone(c) : null; }
    /* 영향 범위(설계 K-13 · 승인 권고 5): 그 저울의 마지막 합격(서명 · 시드) 시각 이후 수정된(updatedAt ≥) 모든 시도 — VOID · 용기 ID 없는 시도 포함. 합격 기록 없으면 그 저울 전체 */
    function impactSince(balanceId) {
      var id = str(balanceId), lp = checksOf(id).filter(function (c) { return c.result === 'pass'; }).slice(-1)[0] || null, D = dispense();
      var f = { balanceId: id, includeVoid: true, groupBy: 'record', order: 'asc' };
      if (lp) f.fromTs = lp.at;
      var rows = D ? D.listRecords(f).rows : [];
      return { ok: true, balanceId: id, lastPass: lp ? { checkId: lp.checkId, date: lp.date, at: lp.at, signedAt: lp.at, by: lp.by, signatureId: lp.signatureId || null } : null,
               records: rows.map(function (r) { return { recId: r.recId, dispenseId: r.dispenseId, batchId: r.batchId, lineId: r.lineId, attempt: r.attempt, net: r.net, uom: r.uom, state: r.state, voidKind: r.voidKind, at: r.at, operatorId: r.operatorId }; }) };
    }
    function nextCheckId(o, date) {
      var ymd = str(date).replace(/-/g, ''), n = Number(o.seq[ymd]) || 0, id;
      do { n++; id = 'BC-' + ymd + '-' + pad(n, 4); } while (o.checks.some(function (c) { return c && c.checkId === id; }));
      return { id: id, n: n, ymd: ymd };
    }
    function devIdFor(d, balanceId) {
      var base = 'DEV-' + str(balanceId).replace(/[^A-Za-z0-9]/g, '') + '-', n = 1;
      while (d.items.some(function (x) { return x && x.id === base + pad(n, 2); })) n++;
      return base + pad(n, 2);
    }
    function mirrorOf(c, extra) {
      var m = { date: c.date, result: c.result, by: c.by, at: c.at, checkId: c.checkId, signatureId: c.signatureId || null, blocked: c.result === 'fail', deviationId: c.deviationId || c.recheckDeviationId || null };
      if (c.seed) m.seed = true;
      if (extra) Object.keys(extra).forEach(function (k) { m[k] = extra[k]; });
      return m;
    }
    function valuesOf(j) {
      return j.points.map(function (p) { return { weightId: p.weightId, nominal: p.nominal, uom: p.uom, lo: p.lo, hi: p.hi, measured: p.measured, devPct: p.devPct, ok: p.ok, source: p.source, certDue: p.certDue }; });
    }

    /* ---- 서명 ---- */
    /* beginCheckSign(balanceId, draft, o?) → { ok, ticket, target } | { ok:false, why }
       draft = { prechecks:{level, zero, clean}, points:[{weightId, measured, source}], comment? } — 판정(result)은 store 가 judgeCheck 로 정함 */
    function beginCheckSign(balanceId, draft, o) {
      o = o || {}; draft = draft || {};
      var S = session(); if (!S || typeof S.beginRecordSign !== 'function') return fail('no_session');
      var cur = S.getCurrentUser && S.getCurrentUser(); if (!cur) return fail('no_current_user');
      var pf = planFor(balanceId); if (!pf.ok) return pf;
      var t = today(), bal = pf.balance, plan = pf.plan, id = bal.balanceId;
      var cd = daysUntil(bal.calDue, t);
      if (cd == null || cd < 0) return fail('cal_expired', MSG.cal_expired, { calDue: bal.calDue });
      var j = judgeCheck(draft, plan);
      if (j.expired.length) return fail('weight_cert_expired', MSG.weight_cert_expired, { expired: j.expired });
      if (j.result === 'incomplete') return fail('incomplete', MSG.incomplete, { missing: j.missing });
      var st = statusOf(id, t), recheck = !!st.blocked, rule = recheck ? RULES.RECHECK : RULES.CHECK;
      var o0 = bcLoad(), cid = nextCheckId(o0, t).id, snapCount = checksOf(id).length;
      var pts = valuesOf(j, plan), okN = pts.filter(function (p) { return p.ok; }).length;
      var vh = hashOf({ balanceId: id, date: t, planId: plan.planId, planVer: plan.ver, prechecks: j.prechecks, points: pts.map(function (p) { return { weightId: p.weightId, nominal: p.nominal, measured: p.measured, lo: p.lo, hi: p.hi }; }), result: j.result });
      var recheckOf = recheck ? st.checkId : null, recheckDev = recheck ? st.deviationId : null, kind = j.result === 'fail' ? 'balance_check_fail' : 'balance_check';
      var sctx = { balanceId: id, eqClass: bal.eqClass, date: t, planId: plan.planId, planVer: plan.ver, sopRef: plan.sopRef, tolPct: plan.tolPct, n: j.n, recheckOf: recheckOf };
      if (kind === 'balance_check_fail') { sctx.failed = j.failed.length; sctx.maxDevPct = j.maxDev ? j.maxDev.devPct : null; sctx.maxDevWeightId = j.maxDev ? j.maxDev.weightId : null; sctx.reason = ''; }
      var impact = j.result === 'fail' ? impactSince(id) : null;
      var spec = {
        /* ⑦ 자격 (B1-12 · K-15): 헬퍼가 'SIGN:'+규칙 을 늘 더하지만(→ QD-BALCHK) 점검 · 재점검 모두 명시. 저울 클래스(BALCLASS)는 칭량 수행만이라 넣지 않음(교육 · 자격 규칙 ④) */
        qualTargets: ['SIGN:' + rule],
        signRuleId: rule, recordType: 'balance_check', tgt: id + ' · ' + t, val: cid + ' · ' + j.result + ' · ' + okN + '/' + j.n + '점', screen: o.screen,
        fields: { balanceId: id, checkId: cid, date: t, checkResult: j.result, planId: plan.planId, planVer: plan.ver, sopRef: plan.sopRef, recheckOf: recheckOf, recheckDeviationId: recheckDev, valueHash: vh },
        statementKind: kind, statementCtx: sctx, statementInputKeys: kind === 'balance_check_fail' ? ['reason'] : [],
        openAct: 'BALANCE_CHECK_OPEN', keys: [KEYS.BC, KEYS.EQ, KEYS.DEV], saveErrorMessage: MSG.save_error,
        target: { balanceId: id, date: t, checkId: cid, result: j.result, ruleId: rule, recheck: recheck, recheckOf: recheckOf, recheckDeviationId: recheckDev,
                  values: pts, prechecks: j.prechecks, valueHash: vh, plan: { planId: plan.planId, ver: plan.ver, sopRef: plan.sopRef, tolPct: plan.tolPct }, impact: impact },
        /* 불합격 사유: 공백 제거 뒤 1–60자(코드 포인트) — 헬퍼가 비밀번호 판정 전에 부름(실패 카운트 · 감사 없음) */
        requireInput: kind === 'balance_check_fail' ? function (inp) {
          var r = str(inp && inp.reason);
          if (!r) return { why: 'reason_required', message: MSG.reason_required };
          return charLen(r) > REASON_MAX() ? { why: 'reason_too_long', message: MSG.reason_too_long } : null;
        } : null,
        precheck: function () {
          var S2 = session(); if (!S2 || !S2.getCurrentUser || !S2.getCurrentUser()) return { detail: 'no_current_user', message: MSG.no_current_user };
          if (checksOf(id).length !== snapCount || statusOf(id, t).blocked !== recheck) return { detail: 'record_changed', message: MSG.record_changed };
          return null;
        },
        apply: function (sig, ctx) {
          var at = ctx.at, o2 = bcLoad(), nx = nextCheckId(o2, t);
          var reason = kind === 'balance_check_fail' ? str(ctx.input && ctx.input.reason) : '';
          var chk = { checkId: nx.id, balanceId: id, eqClass: bal.eqClass, roomId: bal.roomId, date: t, prechecks: clone(j.prechecks), points: clone(pts),
                      planId: plan.planId, planVer: plan.ver, sopRef: plan.sopRef, tolPct: plan.tolPct, signRuleId: rule, result: j.result,
                      comment: sig.comment || '', reason: reason, recheckOf: recheckOf, recheckDeviationId: recheckDev, deviationId: null, impact: [],
                      signatureId: sig.signatureId, by: sig.signerId, byName: sig.signerName || '', at: at, valueHash: vh, seed: false };
          var audits = [], dev = null, struct = { signRuleId: rule, recordType: 'balance_check' };
          if (j.result === 'fail') {
            var imp = impactSince(id), d = devLoad(), devId = devIdFor(d, id);
            chk.impact = imp.records.map(function (r) { return r.dispenseId || r.recId; });
            chk.deviationId = devId;
            dev = { id: devId, orderNo: null, batchId: null, source: 'balance_check', title: '저울 일상 점검 불합격 — ' + id + ' ' + t, grade: 'Hard-QA', status: 'open', capaLink: null,
                    createdAt: at, closedAt: null, refType: 'balance', refId: id, checkId: nx.id, impact: chk.impact.slice() };
            d.items.push(dev); d.v = 1;
            writeJson(KEYS.DEV, d, 'dev');
          }
          seal(chk);
          o2.checks.push(chk); o2.seq[nx.ymd] = nx.n;
          writeJson(KEY, o2, 'balanceCheck');
          var eo = eqLoad(), row = eqFind(eo.items, id), before = row && row.dailyCheck ? clone(row.dailyCheck) : null;
          if (!row) throw new Error('저울 행 없음: ' + id);
          row.dailyCheck = mirrorOf(chk);
          writeJson(KEYS.EQ, eo, 'eq');
          var tg = id + ' · ' + t;
          audits.push(Object.assign({ act: 'BALANCE_CHECK_RECORDED', tgt: tg, val: chk.checkId + ' · ' + chk.result + ' · ' + okN + '/' + j.n + '점' + (recheckOf ? ' · 재점검(원 ' + recheckOf + ')' : ''),
                                      before: before, after: clone(row.dailyCheck) }, struct));
          if (dev) {
            audits.push(Object.assign({ act: 'BALANCE_USE_BLOCKED', tgt: tg, why: reason, val: '사용 금지 · ' + dev.id + ' · 영향 ' + chk.impact.length + '건', detail: { deviationId: dev.id, impactCount: chk.impact.length } }, struct));
            audits.push(Object.assign({ act: 'BALANCE_DEVIATION', tgt: tg, val: dev.id + ' (Hard-QA) · ' + chk.checkId, detail: { deviationId: dev.id } }, struct));
          }
          return { audits: audits, result: { check: clone(chk), dailyCheck: clone(row.dailyCheck), deviation: clone(dev) } };
        }
      };
      return S.beginRecordSign(spec);
    }
    function signAndCommitCheck(ticket, input) {
      var S = session(); if (!S) return fail('no_session');
      var r = S.signAndCommitRecord(ticket, input || {});
      if (!r || !r.ok) return r;
      var res = r.result || {};
      return { ok: true, check: res.check, dailyCheck: res.dailyCheck, deviation: res.deviation || null, signature: r.signature, closeDialog: r.closeDialog, clearPassword: r.clearPassword };
    }
    function cancelCheckSign(ticket, o) { var S = session(); return S ? S.cancelRecordSign(ticket, o) : fail('no_session'); }

    /* ---- 시드 (today 상대, 멱등) ----
       분동 · 계획 = 없는 id 만 추가. 점검 = 'BC-{날짜}-S{저울번호}' id 로 없을 때만 추가(서명 레코드 없음, seed:true).
       dailyCheck 미러: 저울 행 dailyCheck 가 없거나 예전 자동 합격(by 'SEED')이거나 더 오래된 경우 그 저울의 마지막 점검으로 갱신.
       점검 기록이 없는 저울의 예전 자동 합격(by 'SEED')은 지움 → G12 '미점검'. 시드 일탈 DEV-BAL102-01 은 batchId:null · seed:true */
    function seedDemo(o5) {
      o5 = o5 || {};
      var t = str(o5.today) || today(), o = bcLoad(), eo = eqLoad(), d = devLoad();
      var added = { weights: [], plans: [], checks: [], deviations: [] }, skipped = [], mirrored = [], changedBc = false, changedEq = false, changedDev = false;
      weightSeed(t).forEach(function (w) { if (o.weights.some(function (x) { return x && x.weightId === w.weightId; })) skipped.push(w.weightId); else { o.weights.push(w); added.weights.push(w.weightId); changedBc = true; } });
      PLAN_SEED.forEach(function (p) { if (o.plans.some(function (x) { return x && x.planId === p.planId; })) skipped.push(p.planId); else { o.plans.push(clone(p)); added.plans.push(p.planId); changedBc = true; } });
      var wmap = {}; o.weights.forEach(function (w) { wmap[w.weightId] = w; });
      CHECK_SEED.forEach(function (cs) {
        var bid = cs[0], date = addDays(t, cs[1]), cid = 'BC-' + date.replace(/-/g, '') + '-S' + bid.replace(/\D/g, '');
        if (o.checks.some(function (c) { return c && c.checkId === cid; })) { skipped.push(cid); return; }
        var b = eqFind(eo.items, bid); if (!b || str(b.kind) !== 'balance') { skipped.push(cid); return; }
        var pl = o.plans.filter(function (p) { return p && p.eqClass === str(b.eqClass); })[0]; if (!pl) { skipped.push(cid); return; }
        var plan = clone(pl); plan.points = pl.points.map(function (pt) { var w = wmap[pt.weightId] || {}; return { weightId: pt.weightId, nominal: w.nominal, uom: w.uom || 'kg', certDue: w.certDue, weightExpired: false }; });
        var draft = { prechecks: { level: true, zero: true, clean: true }, points: plan.points.map(function (pt, i) { return { weightId: pt.weightId, measured: round(pt.nominal * (1 + (cs[5][i] || 0) / 100), 6), source: 'SIM' }; }) };
        var j = judgeCheck(draft, plan), at = atOf(date, cs[2]);
        var chk = { checkId: cid, balanceId: bid, eqClass: str(b.eqClass), roomId: str(b.roomId), date: date, prechecks: j.prechecks, points: valuesOf(j, plan),
                    planId: pl.planId, planVer: pl.ver, sopRef: pl.sopRef, tolPct: pl.tolPct, signRuleId: RULES.CHECK, result: j.result, comment: '', reason: j.result === 'fail' ? '데모 시드 — 편차 초과(영점 재조정 필요)' : '',
                    recheckOf: null, recheckDeviationId: null, deviationId: null, impact: [], signatureId: null, by: cs[4], byName: '', at: at, valueHash: '', seed: true };
        if (j.result === 'fail' && bid === SEED_DEV.balanceId) {
          chk.deviationId = SEED_DEV.id;
          if (!d.items.some(function (x) { return x && x.id === SEED_DEV.id; })) {
            d.items.push({ id: SEED_DEV.id, orderNo: null, batchId: null, source: 'balance_check', title: '저울 일상 점검 불합격 — ' + bid + ' (데모 시드)', grade: 'Hard-QA', status: 'open', capaLink: null,
                           createdAt: at, closedAt: null, refType: 'balance', refId: bid, checkId: cid, impact: [], seed: true });
            d.v = 1; added.deviations.push(SEED_DEV.id); changedDev = true;
          }
        }
        chk.valueHash = hashOf({ balanceId: bid, date: date, planId: pl.planId, planVer: pl.ver, prechecks: j.prechecks, points: chk.points.map(function (p) { return { weightId: p.weightId, nominal: p.nominal, measured: p.measured, lo: p.lo, hi: p.hi }; }), result: j.result });
        seal(chk);
        o.checks.push(chk); added.checks.push(cid); changedBc = true;
      });
      eo.items.forEach(function (b) {
        if (!b || str(b.kind) !== 'balance') return;
        var id = str(b.equipmentId || b.id), list = o.checks.filter(function (c) { return c && c.balanceId === id; }).sort(function (a, c) { return tsOf(a.at) - tsOf(c.at); }), last = list[list.length - 1];
        var dc = b.dailyCheck;
        if (!last) { if (dc && dc.by === 'SEED') { b.dailyCheck = null; mirrored.push(id); changedEq = true; } return; }
        if (!dc || dc.by === 'SEED' || (dc.checkId !== last.checkId && tsOf(dc.at) < tsOf(last.at))) { b.dailyCheck = mirrorOf(last); mirrored.push(id); changedEq = true; }
      });
      if (changedDev) writeJson(KEYS.DEV, d, 'dev');
      if (changedBc) writeJson(KEY, o, 'balanceCheck');
      if (changedEq) writeJson(KEYS.EQ, eo, 'eq');
      return { ok: true, today: t, added: added, skipped: skipped, mirrored: mirrored, changed: changedBc || changedEq || changedDev };
    }
    function REASON_MAX() { var D = dispense(); return D && D.VOID_REASON_MAX ? D.VOID_REASON_MAX : 60; }

    return {
      VERSION: 1, KEY: KEY, KEYS: clone(KEYS), RULES: clone(RULES), PRECHECKS: PRECHECKS.slice(), PRECHECK_LABEL: clone(PRECHECK_LABEL), MSG: clone(MSG),
      get REASON_MAX() { return REASON_MAX(); },
      /* 순수 */
      judgePoint: judgePoint, judgeCheck: judgeCheck,
      /* 읽기 (setItem 없음) */
      weights: weights, plans: plans, planFor: planFor, statusOf: statusOf, listChecks: listChecks, getCheck: getCheck, impactSince: impactSince,
      /* 서명 */
      beginCheckSign: beginCheckSign, signAndCommitCheck: signAndCommitCheck, cancelCheckSign: cancelCheckSign,
      /* 시드 */
      seedDemo: seedDemo,
      create: create,
      _test: { failNext: function (stage) { /* 'balanceCheck'|'eq'|'dev' */ failNextStage = stage || null; return failNextStage; }, addDays: addDays }
    };
  }

  var API = create({});
  global.EbrBalanceCheck = API;
  /* 브라우저 로드 시: EbrDispense 가 먼저 로드돼 있으면 공용 시드 진입점(ensureSeeds)을 다시 불러 점검 시드 · dailyCheck 미러를 맞춘다(멱등).
     EbrDispense 가 나중에 로드되면 그쪽 자동 시드가 이 store 를 찾아 같은 일을 한다. 끄려면 window.EBR_DISPENSE_NO_AUTOSEED = true */
  if (global.navigator && global.localStorage && !global.EBR_DISPENSE_NO_AUTOSEED && global.EbrDispense && typeof global.EbrDispense.ensureSeeds === 'function') {
    try { global.EbrDispense.ensureSeeds(); } catch (eSeed) { /* 저장 불가 — 화면은 fail-closed */ }
  }
  if (global.EbrP0 && typeof global.EbrP0 === 'object') { global.EbrP0.BalanceCheck = API; global.EbrP0.BALANCE_CHECK_KEY = KEY; }
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
