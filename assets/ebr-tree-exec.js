/* =====================================================================
   ebr-tree-exec.js — 실행의 프로세스 트리 준수 판정 · store (전역 EbrTreeExec)
   - 설계: poc-process-tree-exec-design.md 개정 1 §3–§7 · §10 (T1-01 ~ T1-09), 결정 X1–X9 · UI 문서 J1–J5 (DC-09)
   - 저장 키: ebr.treeExec.v1 { v:1, items:[Instance], path:[{instId, at}] }   (path = 실행 순서, 추가만)
       Instance = { instId:'TX-<batch>-<seq>', batchId, scope:'prod'|'pack', nodeId, iter, stepKey:'N-030' | 'N-030#2',
                    state:'ready'|'in_progress'|'done'|'skipped'|'superseded'|'terminal',
                    enteredBy:{ edgeFrom, edgeType:'start'|'seq'|'exception'|'back'|'migrated', approvalSignatureId? },
                    startedAt, startedBy, doneAt, doneBy, reason?, evidence?, skipSignatureId?, repeatSignatureId?, devId? }
   - 화면은 이 store 를 직접 읽거나 쓰지 않는다(EbrTreeExec 경유). 화면은 why/msg/nextDue 만 표시.
   - 모든 쓰기 함수는 store 안에서 판정을 다시 한다(화면 판정 무시 — 콘솔 우회 차단). 쓰기 + 감사는 한 번에, 감사 실패 시 원복(fail-closed).
   - 승인 서명(SM-APPR-ROUTE · SKIP · REPEAT) = EbrUserSession.beginRecordSign / signAndCommitRecord (새 서명 경로 없음), 커밋 키 ebr.treeExec.v1 함께.
   - 포장(scope 'pack') = EbrSignStatus.stepsFor('pack') 8단계 선형 트리 (분기 없음).
   - EbrTreeExec.create({ session?, signStatus?, snapshot?, now? }) 로 노드 시험 주입. 모듈은 호출 시점에 찾는다(로드 순서 무관).
   ===================================================================== */
(function (global) {
  'use strict';

  var KEYS = { TREE: 'ebr.treeExec.v1', AUDIT: 'ebr.audit.v1', ESIGN: 'ebr.esign.v1', ISSUED: 'ebr.batch.issued.v1', DEV: 'ebr.deviation.v1' };
  var SCOPES = ['prod', 'pack'];
  var STATES = ['ready', 'in_progress', 'done', 'skipped', 'superseded', 'terminal'];
  var DEFAULT_MAX_REPEAT = 2;                       // X8: execRule.maxRepeat 없으면 2
  var REASON_MAX = 60;                              // 사유 1–60자
  var BLOCK_DEDUP_MS = 5 * 60 * 1000;               // TREE_ORDER_BLOCKED 같은 why · 노드 5분 내 1회

  var WHY = {                                        // 설계 §5.1 그대로 ({…} 자리표시) + 구현 추가 4 (뒤쪽)
    tree_order_blocked: '순서 차단 — 선행 단계 {pred} {predName}가 완료되지 않았습니다. 현재 진행 가능: {nextDue}.',
    tree_route_unapproved: '예외 경로 단계입니다 — {from}에서 경로 진입 승인 서명 후 시작할 수 있습니다.',
    tree_step_done: '이미 완료된 단계입니다 — 다시 하려면 MBR의 반복 경로로만 진행합니다.',
    tree_step_busy: '진행 중인 단계 {busy}를 먼저 완료하세요 (한 번에 한 단계).',
    tree_skip_not_allowed: 'MBR에서 건너뛰기를 허용하지 않은 단계입니다 — {node}.',
    tree_repeat_limit: '반복 한도 {max}회를 넘었습니다 — {node} {iter}회차는 QA 승인이 필요합니다.',
    tree_no_edge: 'MBR 트리에 없는 경로입니다 — {from} → {to}.',
    tree_batch_held: '예외 종료 단계({node}) 도달로 배치가 보류되었습니다 — 일탈 처리 전 진행 불가.',
    tree_terminal_no_dev: '예외 종료 단계는 일탈 연결이 필요합니다 — 일탈을 먼저 등록하세요.',
    tree_snapshot_missing: '발행 스냅샷의 트리를 읽을 수 없습니다 — 실행할 수 없습니다.',
    tree_snapshot_tampered: '발행 스냅샷의 실행 봉인(execHash)이 맞지 않습니다 — 변조 의심, 실행할 수 없습니다 (재발행 · QA 확인).',
    tree_snapshot_unverified: '발행 스냅샷에 실행 봉인(execHash)이 없습니다 — 검증할 수 없어 실행할 수 없습니다 (재발행 필요).',
    tree_role_denied: '단계 시작 · 완료는 작업자(OP) · 감독자(SV)만 할 수 있습니다 — 현재 사용자 역할: {roles}.',
    tree_dev_hold: '일탈 {dev}이(가) 열려 있어 배치가 보류되었습니다 — 일탈 종결 전에는 {node}을(를) 시작할 수 없습니다 (예외 경로만 가능).',
    tree_record_tampered: '트리 실행 기록의 건너뛰기({node})에 유효한 승인 서명(SM-APPR-SKIP)이 없습니다 — 변조 의심, 실행할 수 없습니다.',
    tree_not_started: '시작하지 않은 단계입니다 — {node} 단계를 먼저 시작하세요.',
    tree_signs_missing: '완료 조건이 충족되지 않았습니다 — 필요 서명 {missing}.',
    tree_route_qa_only: '예외 종료로 가는 경로는 QA만 승인할 수 있습니다 — {from} → {to}.',
    tree_store_unreadable: '트리 실행 기록을 읽을 수 없습니다 — 실행할 수 없습니다.'
  };
  var SLOT_NAME = { perform: '수행', verify: '확인', qa: '라벨 QA', review: '기록 검토' };
  var WHY_EXT = ['read_only', 'already_released'];   // 기존 잠금 문구 재사용(헬퍼 · 서명 상태 쪽 문구)
  var MSG = {
    not_implemented: '아직 구현되지 않은 API 입니다.', reason_required: '사유를 입력하세요 (1–60자).', no_batch: '배치 ID가 없습니다.',
    bad_scope: '범위(scope)는 prod 또는 pack 이어야 합니다.', no_session: '사용자 세션 헬퍼(EbrUserSession)를 찾을 수 없습니다.',
    no_current_user: '현재 사용자를 선택하세요.', bad_ticket: '서명 요청을 찾을 수 없습니다 (이미 처리 · 취소됨).', save_error: '저장에 실패했습니다 — 변경하지 않았습니다.',
    tree_orphan_sig: '원장의 {kindLabel}({rule}, {node})에 대응하는 트리 실행 기록이 없습니다 — 변조 의심, 실행할 수 없습니다.',   /* ledger_orphan 전용 — 서명 종류별 문구 */
    read_only: '복원 탐지로 읽기 전용입니다 — 실행할 수 없습니다.', already_released: '이미 출하된 배치입니다.'
  };

  var SIGN_RULES = {
    ROUTE: { ruleId: 'SM-APPR-ROUTE', meaning: 'approved', roles: ['SV', 'QA'], recordType: 'tree_route', statementKind: 'tree_route_enter', distinctFrom: 'from_performer' },
    SKIP: { ruleId: 'SM-APPR-SKIP', meaning: 'approved', roles: ['QA'], recordType: 'tree_route', statementKind: 'step_skip', distinctFrom: null },
    REPEAT: { ruleId: 'SM-APPR-REPEAT', meaning: 'approved', roles: ['QA'], recordType: 'tree_route', statementKind: 'step_repeat_over', distinctFrom: 'prev_iter_performer' }
  };
  var AUDIT_ACTS = ['TREE_STEP_STARTED', 'TREE_STEP_DONE', 'TREE_ORDER_BLOCKED', 'TREE_ROUTE_ENTERED', 'TREE_STEP_SKIPPED',
                    'TREE_STEP_REPEATED', 'TREE_TERMINAL_REACHED', 'TREE_SNAPSHOT_LEGACY'];

  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function str(v) { return v == null ? '' : String(v).trim(); }
  function fill(t, v) { v = v || {}; return String(t).replace(/\{(\w+)\}/g, function (m, k) { return v[k] == null || v[k] === '' ? '—' : String(v[k]); }); }
  function stepKeyOf(nodeId, iter) { return (iter && iter > 1) ? nodeId + '#' + iter : String(nodeId); }
  function parseStepKey(k) { var m = /^(.+?)(?:#(\d+))?$/.exec(String(k || '')); return { nodeId: m ? m[1] : '', iter: m && m[2] ? +m[2] : 1 }; }
  function msgFor(why, vars) { return WHY[why] ? fill(WHY[why], vars) : (MSG[why] || why); }
  function cpLen(s) { return Array.from(String(s)).length; }
  function seqOf(instId) { var m = /-(\d+)$/.exec(String(instId || '')); return m ? +m[1] : 0; }

  /* 리뷰 X6 ②: TREE_* 감사는 공개 Audit 로 쓸 수 없음 — 모듈 로드 시 내부 writer 를 한 번 받는다(없으면 쓰기 throw → 각 호출부 기존 실패 처리) */
  var treeWriter = null;
  (function () {
    function take(w) { treeWriter = w || null; }
    var U = global.EbrUserSession;
    if (U && typeof U.claimAuditWriter === 'function') take(U.claimAuditWriter('tree-exec'));
    else (global.__ebrAuditClaims = global.__ebrAuditClaims || []).push({ owner: 'tree-exec', take: take });
  })();
  function TW() { if (!treeWriter) throw new Error('tree_audit_writer_missing'); return treeWriter; }
  function create(deps) {
    deps = deps || {};
    function S() { return deps.session || global.EbrUserSession || null; }
    function SS() { return deps.signStatus || global.EbrSignStatus || null; }
    function SN() { return deps.snapshot || global.EbrExecSnapshot || null; }
    function nowMs() { return typeof deps.now === 'function' ? +deps.now() : Date.now(); }
    function nowIso() { var s = S(); return s && typeof s.nowIsoLocal === 'function' ? s.nowIsoLocal() : new Date(nowMs()).toISOString(); }
    function ls() { return global.localStorage; }
    function raw(k) { try { return ls().getItem(k); } catch (e) { return null; } }
    function readJson(k, fb) { var r = raw(k); if (r == null || r === '') return fb; try { return JSON.parse(r); } catch (e) { return undefined; } }
    function readItems(k) { var o = readJson(k, null); return o && Array.isArray(o.items) ? o.items : (Array.isArray(o) ? o : []); }
    function fail(why, vars, extra) {
      var r = { ok: false, why: why, msg: msgFor(why, vars) };
      if (vars) Object.keys(vars).forEach(function (k) { if (r[k] === undefined) r[k] = vars[k]; });
      if (extra) Object.keys(extra).forEach(function (k) { r[k] = extra[k]; });
      return r;
    }
    var tickets = {}, blockSeen = {};

    /* ---------------------------------------------------------------- store */
    function readTree() {
      var o = readJson(KEYS.TREE, null);
      if (o === undefined) return null;                                  // 판독 불가 → fail-closed
      if (o == null) return { v: 1, items: [], path: [] };
      if (typeof o !== 'object' || !Array.isArray(o.items)) return null;
      return { v: 1, items: o.items.slice(), path: Array.isArray(o.path) ? o.path.slice() : [], chain: Array.isArray(o.chain) ? o.chain.slice() : [] };
    }
    /* ---------------------------------------------------------------- 전이 사슬 (리뷰 X3)
       ebr.treeExec.v1.chain = [{ seq, instId, batchId, scope, nodeId, stepKey, state, at, itemHash, prevHash, hash }] — 추가만.
       모든 쓰기(start · complete · route · skip · repeat · cancel · migrate · 종료)는 writeTree 하나로: 바뀐(새) 인스턴스마다 1항목,
       itemHash = sha256(stableStringify(인스턴스)), hash = sha256(stableStringify(항목 − hash)), prevHash = 앞 항목 hash (esignVoid · interlockHitBind 와 같은 꼴) */
    function H(o) { var s = S(); return s && s.sha256Hex && s.stableStringify ? s.sha256Hex(s.stableStringify(o)) : ''; }
    function entryHash(e) { var c = {}; Object.keys(e).forEach(function (k) { if (k !== 'hash') c[k] = e[k]; }); return H(c); }
    /* 리뷰 X4 ②: 사슬 머리(seq · hash)를 같은 쓰기의 감사(사슬로 묶인 감사 기록)에 고정 → 꼬리 잘라내기 탐지 */
    /* 감사 기록이 보존하는 필드 = detail (헬퍼 appendAudit 허용 목록) → detail.chainSeq · chainHead */
    /* 리뷰 X5 ②: 고정 = tree-exec 가 쓰는 TREE_* 전이 감사만(act 허용 목록 + detail.writer + writeId = H(seq · head · act · tgt)).
       판정은 '가장 큰 chainSeq' 기준 길이 + 인정된 고정 전부가 사슬과 일치 — 더 작은 값으로 낮추는 고정 추가는 효과 없음 */
    var PIN_ACTS = ['TREE_STEP_STARTED', 'TREE_STEP_DONE', 'TREE_ROUTE_ENTERED', 'TREE_STEP_SKIPPED', 'TREE_STEP_REPEATED', 'TREE_TERMINAL_REACHED'];
    function pinId(seq, head, act, tgt) { return H({ w: 'tree-exec', seq: seq, head: head, act: str(act), tgt: str(tgt) }); }
    function pinHead(hd, r) {
      (r.audits || []).forEach(function (a) {
        if (!a || PIN_ACTS.indexOf(a.act) < 0) return;
        var d = a.detail && typeof a.detail === 'object' ? a.detail : (a.detail !== undefined ? { note: a.detail } : {});
        d.chainSeq = hd.seq; d.chainHead = hd.hash; d.writer = 'tree-exec'; d.writeId = pinId(hd.seq, hd.hash, a.act, a.tgt); a.detail = d;
      });
      return r;
    }
    function headPins() {
      return readItems(KEYS.AUDIT).filter(function (a) {
        var d = a && a.detail; return d && typeof d === 'object' && PIN_ACTS.indexOf(a.act) >= 0 && d.writer === 'tree-exec' && typeof d.chainSeq === 'number' && d.chainSeq > 0 && d.writeId === pinId(d.chainSeq, str(d.chainHead), a.act, a.tgt);
      }).map(function (a) { return { seq: a.detail.chainSeq, hash: str(a.detail.chainHead) }; });
    }
    function writeTree(tree) {
      var prev = readJson(KEYS.TREE, null), byId = {};
      ((prev && Array.isArray(prev.items)) ? prev.items : []).forEach(function (x) { if (x && x.instId) byId[x.instId] = H(x); });
      var chain = Array.isArray(tree.chain) ? tree.chain.slice() : [], at = nowIso();
      tree.items.forEach(function (x) {
        var ih = H(x); if (!ih) throw new Error('hash_unavailable');
        if (byId[x.instId] === ih) return;
        var last = chain[chain.length - 1];
        var refs = [(x.enteredBy || {}).approvalSignatureId, x.skipSignatureId, x.repeatSignatureId].concat(Array.isArray(x.signatureIds) ? x.signatureIds : []).filter(function (v) { return !!v; }).map(str);
        var e = { seq: chain.length + 1, v: 2, instId: x.instId, batchId: x.batchId, scope: x.scope, nodeId: x.nodeId, stepKey: x.stepKey, state: x.state, at: at, refs: refs, itemHash: ih, prevHash: last ? last.hash : '' };
        e.hash = entryHash(e); chain.push(e);
      });
      tree.chain = chain;
      ls().setItem(KEYS.TREE, JSON.stringify(tree));
      var hl = chain[chain.length - 1]; return { seq: chain.length, hash: hl ? hl.hash : '' };
    }
    /* 판정 시 대조: 사슬 무결 · 배치 인스턴스마다 최신 사슬 항목 itemHash = 현재 값 · in_progress/done 은 사슬 시작 항목 ·
       seq 진입은 선행 완료 항목이 시작 항목보다 앞 · done 은 슬롯 서명(원장 유효)이 시작 이후(초 단위) · 예외 진입은 유효 SM-APPR-ROUTE.
       → 어긋난 인스턴스 하나(없으면 null) */
    function chainBad(tree, B, R, scope) {
      curTree = tree;
      var ch = tree.chain || [], prevH = '';
      for (var i = 0; i < ch.length; i++) {
        var e = ch[i]; if (!e || e.seq !== i + 1 || str(e.prevHash) !== prevH || entryHash(e) !== e.hash) return { stepKey: 'chain#' + (i + 1), why: 'chain_broken' };
        prevH = e.hash;
      }
      var pins = headPins(), mx = 0; pins.forEach(function (q) { if (q.seq > mx) mx = q.seq; });
      if (ch.length < mx) return { stepKey: 'chain#' + mx, why: 'chain_truncated' };
      for (var pi = 0; pi < pins.length; pi++) if (ch[pins[pi].seq - 1].hash !== pins[pi].hash) return { stepKey: 'chain#' + pins[pi].seq, why: 'chain_truncated' };
      var rv = ledgerOrphan(ch, B, scope); if (rv) return rv;
      var items = itemsOf(tree, B, scope); if (!items.length) return null;
      var lastOf = {}, firstState = {};
      ch.forEach(function (e) { if (e.batchId !== B) return; lastOf[e.instId] = e; var k = e.instId + '|' + e.state; if (!firstState[k]) firstState[k] = e.seq; });
      for (var j = 0; j < items.length; j++) {
        var x = items[j], le = lastOf[x.instId];
        if (!le || le.itemHash !== H(x) || le.state !== x.state || le.scope !== x.scope) return { stepKey: x.stepKey, why: 'chain_mismatch' };
        var st = x.state, eb = x.enteredBy || {};
        if ((st === 'in_progress' || st === 'done') && eb.edgeType !== 'migrated') {
          var sSeq = firstState[x.instId + '|in_progress']; if (!sSeq) return { stepKey: x.stepKey, why: 'no_start_entry' };
          if (st === 'done' && !(firstState[x.instId + '|done'] > sSeq)) return { stepKey: x.stepKey, why: 'done_before_start' };
          if ((eb.edgeType || 'seq') === 'seq' && x.nodeId !== R.start && x.iter === 1) {
            var preds = (R.edges || []).filter(function (e2) { return e2.to === x.nodeId && e2.type === 'seq'; }).map(function (e2) { return e2.from; });
            if (preds.length && !items.some(function (y) { return preds.indexOf(y.nodeId) >= 0 && ((firstState[y.instId + '|done'] || 1e12) < sSeq || (firstState[y.instId + '|skipped'] || 1e12) < sSeq); })) return { stepKey: x.stepKey, why: 'pred_after_start' };
          }
          if (st === 'done' && !doneSignsOk(B, R, scope, x)) return { stepKey: x.stepKey, why: 'signs_before_start' };
        }
        if (eb.edgeType === 'exception' && !routeSigOk(B, x)) return { stepKey: x.stepKey, why: 'route_sig' };
      }
      return null;
    }
    /* 리뷰 X4 ①: 역대조 — 이 배치의 트리 관련 유효 원장 서명(SM-APPR-ROUTE/SKIP/REPEAT · 이 범위 단계 수행/확인)마다 사슬에 대응 항목
       (경로 → toNode 인스턴스 · 건너뛰기 → 그 stepKey skipped · 반복 → 그 노드 다음 회차 · 단계 서명 → 그 stepKey 항목). 없으면 사슬 밖 서명 = 잘라낸 흔적.
       예외: 데모 표지 발행 기록의 데모 시드 서명(screen seedSignedBatch — 트리 없이 서명하는 데모 경로, demoGuard 뒤에만) */
    /* 리뷰 X5 ①: 서명 ID 기준 역대조 — 사슬 항목 refs(approvalSignatureId · skipSignatureId · repeatSignatureId · 완료 시 단계 서명 ID)에 그 ID 가 있어야 함.
       단계 서명(수행 · 확인)은 refs 에 있거나, 그 stepKey 의 최신 사슬 항목이 in_progress(지금 수행 중)이고 서명이 그 시작 이후일 때만.
       데모 시드 제외(리뷰 X5 ③) = 데모 배치 ID + 시드 경로만 붙이는 서명 필드 seedOnly:true (호출자 screen 값 무시) */
    var DEMO_IDS = ['BR-DEMO-0001', 'BR-DEMO-0421'];
    function ledgerOrphan(ch, B, scope) {
      var s = S(), list = []; try { list = s && s.ESign ? s.ESign.list({ batchId: B }) : []; } catch (e) { return { stepKey: 'ledger', why: 'ledger_unreadable' }; }
      if (!list.length) return null;
      var mine = ch.filter(function (e) { return e.batchId === B; }), refs = {}, lastBy = {};
      mine.forEach(function (e) { (Array.isArray(e.refs) ? e.refs : []).forEach(function (r) { refs[r] = true; }); if (e.scope === scope) lastBy[e.stepKey] = e; });
      var demo = DEMO_IDS.indexOf(B) >= 0;
      for (var i = 0; i < list.length; i++) {
        var g = list[i], rid = g.signRuleId, id = str(g.signatureId);
        var tree = rid === 'SM-APPR-ROUTE' || rid === 'SM-APPR-SKIP' || rid === 'SM-APPR-REPEAT';
        var step = (g.slot === 'perform' || g.slot === 'verify') && g.scope === scope && g.stepKey && (rid === 'SM-PERF-STEP' || rid === 'SM-VERI-STEP');
        if (!tree && !step) continue;
        if (tree && scope !== 'prod' && rid !== 'SM-APPR-REPEAT') continue;
        if (step && demo && (s && typeof s.isDemoSeedSig === 'function' ? s.isDemoSeedSig(g) : false)) continue;   /* 리뷰 X15: 세션 공용 판정(유효 · 데모 배치 · seedOnly) */
        var vs; try { vs = s.ESign.validity(g).state; } catch (e) { vs = 'tampered'; } if (vs === 'void') continue;   /* 리뷰 X16: 변조 서명은 제외하지 않음(fail-closed) — 정상 무효화만 제외 */
        if (refs[id]) continue;
        if (step) {
          var le = lastBy[str(g.stepKey)], inst = le && itemsOfAll(B).filter(function (x) { return x.instId === le.instId; })[0];
          if (le && le.state === 'in_progress' && inst && isFinite(secOf(inst.startedAt)) && secOf(g.signedAt) >= secOf(inst.startedAt)) continue;
        }
        return { stepKey: str(g.stepKey || g.toNode || g.nodeId), why: 'ledger_orphan', sig: id, kind: step ? (g.slot === 'verify' ? 'verify' : 'perform') : rid };
      }
      return null;
    }
    /* 완료 · 종료 · 이관 시 그 단계의 유효 수행 · 확인 서명 ID (사슬 항목 refs — 서명 ID 기준 역대조 원천) */
    function stepSigIds(B, scope, stepKey) {
      var s = S(), list = []; try { list = s && s.ESign ? s.ESign.list({ batchId: B }) : []; } catch (e) { list = []; }
      return list.filter(function (g) { if (g.scope !== scope || g.stepKey !== stepKey || (g.slot !== 'perform' && g.slot !== 'verify')) return false; try { return s.ESign.validity(g).state === 'valid'; } catch (e) { return false; } })
        .map(function (g) { return str(g.signatureId); });
    }
    function sigOf(id) { var s = S(); try { var g = s && s.ESign ? s.ESign.get(id) : null; return g && s.ESign.validity(g).state === 'valid' ? g : null; } catch (e) { return null; } }
    function routeSigOk(B, x) { var g = sigOf((x.enteredBy || {}).approvalSignatureId); return !!(g && g.signRuleId === 'SM-APPR-ROUTE' && str(g.batchId) === B && str(g.toNode) === x.nodeId && str(g.fromNode) === str((x.enteredBy || {}).edgeFrom)); }
    function secOf(iso) { var t = Date.parse(iso); return isFinite(t) ? Math.floor(t / 1000) : NaN; }
    function doneSignsOk(B, R, scope, x) {
      var n = R.nodes[x.nodeId] || {};
      if (scope === 'prod' && (n.isWeigh || n.handoff || (n.execRule && n.execRule.skippable === true))) return true;   /* 슬롯 없는 노드 (칭량 = 칭량 store 판정) */
      /* 원장 직접 대조 (getSignStatus → stepsFor → requiredNodes 재귀 회피): 필요 슬롯(생산 = 수행 · 확인, 포장 = 정적 슬롯)마다 유효 서명이 시작 이후 */
      var need = ['perform', 'verify'];
      if (scope === 'pack') { var ss = SS(), ps = []; try { ps = ss && ss.stepsFor ? ss.stepsFor('pack') || [] : []; } catch (e) { ps = []; } var stp = ps.filter(function (q) { return q.stepKey === x.stepKey; })[0]; need = stp ? (stp.slots || []).map(function (q) { return q.slot; }) : need; }
      if (!need.length) return true;
      var s = S(), list = []; try { list = s && s.ESign ? s.ESign.list({ batchId: B }) : []; } catch (e) { return false; }
      var t0 = secOf(x.startedAt); if (!isFinite(t0)) return false;
      return need.every(function (sl) {
        return list.some(function (g) { return g.scope === scope && g.stepKey === x.stepKey && g.slot === sl && secOf(g.signedAt) >= t0 && (function () { try { return s.ESign.validity(g).state === 'valid'; } catch (e) { return false; } })(); });
      });
    }
    /* 쓰기 + 감사 (감사 실패 시 원복) */
    function commit(tree, audits) {
      var s = S(); if (!s || !s.Audit) return false;
      var orig = raw(KEYS.TREE);
      try { var hd = writeTree(tree); if (audits && audits.length) TW().appendMany(pinHead(hd, { audits: audits }).audits); }
      catch (e) { try { if (orig == null) ls().removeItem(KEYS.TREE); else ls().setItem(KEYS.TREE, orig); } catch (e2) { /* 무시 */ } return false; }
      return true;
    }
    var curTree = null;
    function itemsOfAll(B) { return curTree ? curTree.items.filter(function (x) { return x && x.batchId === B; }) : []; }
    function itemsOf(tree, batchId, scope) { return tree.items.filter(function (x) { return x && x.batchId === batchId && (!scope || x.scope === scope); }); }
    function latestOf(tree, batchId, scope, nodeId) {
      var best = null;
      itemsOf(tree, batchId, scope).forEach(function (x) { if (x.nodeId === nodeId && (!best || x.iter > best.iter || (x.iter === best.iter && seqOf(x.instId) > seqOf(best.instId)))) best = x; });
      return best;
    }
    function newInst(tree, batchId, scope, nodeId, iter, state, enteredBy) {
      var mx = 0; tree.items.forEach(function (x) { if (x && x.batchId === batchId) mx = Math.max(mx, seqOf(x.instId)); });
      var it = { instId: 'TX-' + batchId + '-' + ('00' + (mx + 1)).slice(-3), batchId: batchId, scope: scope, nodeId: nodeId, iter: iter, stepKey: stepKeyOf(nodeId, iter),
                 state: state, enteredBy: enteredBy, startedAt: null, startedBy: null, doneAt: null, doneBy: null };
      tree.items.push(it); return it;
    }
    /* 리뷰 X4 ③: 종료 도달 감사(TREE_TERMINAL_REACHED, 사슬로 묶인 감사)가 있으면 실행 기록이 지워져도 보류 */
    function terminalAudited(batchId) {
      var a = readItems(KEYS.AUDIT).filter(function (x) { return x && x.act === 'TREE_TERMINAL_REACHED' && str(x.batchId) === batchId; })[0];
      return a ? { nodeId: str(a.val).split(' · ')[0] || '—' } : null;
    }
    /* 리뷰 X6: 열린 일탈 = Dev.isClosedVerified(유효한 SM-DEV-CLOSE + 재개 없음)가 아닌 모든 일탈. Dev 없음 = 모두 열림(fail-closed) */
    function openDev(batchId) {
      /* 리뷰 X7: Dev.listOpen = 저장소 + 감사 DEVIATION_OPENED 역대조(삭제 · 배치 이동 = 원래 배치의 열린 일탈). Dev 없음 = 저장소 항목 모두 열림(fail-closed) */
      var D = (global.EbrP0 && global.EbrP0.Dev) || global.Dev || null, d = null;
      if (D && typeof D.listOpen === 'function') { try { d = D.listOpen(batchId)[0] || null; } catch (e) { d = { id: '—' }; } }
      else d = readItems(KEYS.DEV).filter(function (x) { return x && str(x.batchId) === batchId; })[0] || null;
      return d ? str(d.id) || '—' : null;
    }
    function heldOf(tree, batchId) { return tree.items.filter(function (x) { return x && x.batchId === batchId && x.state === 'terminal'; })[0] || null; }

    /* ---------------------------------------------------------------- 트리 (스냅샷) */
    function issuedOf(batchId) {
      var ss = SS(); if (ss && typeof ss.issuedOf === 'function') return ss.issuedOf(batchId);
      var l = readItems(KEYS.ISSUED); for (var i = 0; i < l.length; i++) if (str(l[i].batchId || l[i].batchNo || l[i].id) === batchId) return l[i];
      return null;
    }
    function isWeigh(p, n) { var sn = SN(); if (sn && typeof sn.isWeighPhase === 'function') return !!sn.isWeighPhase(p, n); return /^PH-WEIGH(-|$)/i.test(str(n && n.phaseRef)); }
    function buildPack() {
      var ss = SS(); if (!ss) return null;
      var steps = ss.stepsFor('pack') || []; if (!steps.length) return null;
      var nodes = {}, order = [], edges = [];
      steps.forEach(function (st, i) {
        nodes[st.stepKey] = { nodeId: st.stepKey, label: st.name, opId: '', opName: '', upId: '', upName: '', execRule: {}, isWeigh: false, slots: (st.slots || []).length };
        order.push(st.stepKey); if (i) edges.push({ from: steps[i - 1].stepKey, to: st.stepKey, type: 'seq', label: '다음' });
      });
      return { scope: 'pack', legacy: false, start: order[0], order: order, main: order.slice(), exceptionOf: {}, terminal: {}, back: {}, unreachable: [], nodes: nodes, edges: edges };
    }
    function buildProd(batchId) {
      var rec = issuedOf(batchId); if (!rec) return null;
      var sn = rec.snapshot && typeof rec.snapshot === 'object' ? rec.snapshot : rec;
      /* 리뷰 X2: 트리 계산 전 실행 봉인 검증 — execRule(skippable) · phaseList · 간선 변조 = 불일치 → 차단 (스냅샷 없음과 구별) */
      var snm = SN(); if (!snm || typeof snm.verifyExec !== 'function') return { integrity: 'tree_snapshot_unverified' };
      if (Array.isArray(sn.phaseList) && sn.phaseList.length) { var vx = snm.verifyExec(sn); if (vx !== 'ok') return { integrity: vx === 'mismatch' ? 'tree_snapshot_tampered' : 'tree_snapshot_unverified' }; }
      var pl = Array.isArray(sn.phaseList) ? sn.phaseList : [], tn = Array.isArray(sn.nodes) ? sn.nodes : [];
      if (!pl.length || !tn.length) return null;
      var legacy = !Array.isArray(sn.exceptionEdges), byId = {};
      tn.forEach(function (n) { var id = str(n && (n.nodeId || n.id)); if (id) byId[id] = n; });
      var nodes = {}, order = [];
      pl.forEach(function (p) {
        var id = str(p && p.id); if (!id || nodes[id]) return; var n = byId[id] || {};
        nodes[id] = { nodeId: id, label: p.name || n.label || id, opId: p.op || '', opName: p.opName || '', upId: p.up || '', upName: p.upName || '',
                      execRule: clone(n.execRule || {}) || {}, isWeigh: isWeigh(p, n), handoff: (p.kind || n.kind) === 'handoff', nextStep: n.nextStep || '' };
        order.push(id);
      });
      var known = function (e) { return e && nodes[str(e.from)] && nodes[str(e.to)]; };
      var seq = (Array.isArray(sn.edges) ? sn.edges : []).filter(function (e) { return known(e) && (!e.type || e.type === 'seq'); })
        .map(function (e) { return { from: str(e.from), to: str(e.to), type: 'seq', label: e.label || '' }; });
      var exc = (legacy ? [] : sn.exceptionEdges).filter(known).map(function (e) { return { from: str(e.from), to: str(e.to), type: 'exception', label: e.label || '' }; });
      var start = order[0], main = [], inMain = {}, cur = start;
      while (cur && !inMain[cur]) {
        main.push(cur); inMain[cur] = true;
        var nx = seq.filter(function (e) { return e.from === cur && !inMain[e.to]; })[0]; cur = nx ? nx.to : null;
      }
      var mIdx = {}; main.forEach(function (id, i) { mIdx[id] = i; });
      /* 예외 노드 = exception 간선으로만 닿는 노드와 그 뒤 seq (주 경로 제외). origin = 진입한 주 경로 노드 index 최소 */
      var exceptionOf = {}, origin = {}, q = [];
      exc.forEach(function (e) { if (inMain[e.from] && !inMain[e.to]) { (exceptionOf[e.to] = exceptionOf[e.to] || []).push(e.from); origin[e.to] = Math.min(origin[e.to] == null ? 1e9 : origin[e.to], mIdx[e.from]); q.push(e.to); } });
      while (q.length) {
        var x = q.shift();
        seq.concat(exc).forEach(function (e) {
          if (e.from !== x || inMain[e.to]) return;
          var list = exceptionOf[e.to] = exceptionOf[e.to] || [];
          var o2 = Math.min(origin[e.to] == null ? 1e9 : origin[e.to], origin[x]);
          var changed = list.indexOf(x) < 0 || o2 !== origin[e.to];
          if (list.indexOf(x) < 0) list.push(x);
          origin[e.to] = o2; if (changed) q.push(e.to);
        });
      }
      var terminal = {}, back = {};
      Object.keys(exceptionOf).forEach(function (id) { if (!seq.some(function (e) { return e.from === id; })) terminal[id] = true; });
      seq.forEach(function (e) { if (exceptionOf[e.from] && inMain[e.to] && mIdx[e.to] <= origin[e.from]) back[e.from + '>' + e.to] = true; });
      var unreachable = order.filter(function (id) { return !inMain[id] && !exceptionOf[id]; });
      return { scope: 'prod', legacy: legacy, start: start, order: order, main: main, exceptionOf: exceptionOf, terminal: terminal, back: back, unreachable: unreachable,
               nodes: nodes, edges: seq.concat(exc), contentHash: sn.contentHash || '' };
    }
    function routeFor(batchId, scope) {
      try { return scope === 'pack' ? buildPack() : buildProd(batchId); } catch (e) { return null; }
    }
    /* 리뷰 X1: 건너뜀(skipped/na) = 원장에 유효한 SM-APPR-SKIP 서명(무효화 안 됨 · 해시 정상 · 같은 배치 · 노드 · stepKey)이 있고
       봉인된 스냅샷에서 skippable 인 노드일 때만. 평문 skipped 하나라도 있으면 배치 전체 차단 (조건 3 은 stepsFor 차단 슬롯으로 block) */
    function skipValid(it, R) {
      var n = R.nodes[it.nodeId]; if (!n || !(n.execRule && n.execRule.skippable === true)) return false;
      var s = S(); if (!s || !s.ESign || !it.skipSignatureId) return false;
      var sg = null; try { sg = s.ESign.get(it.skipSignatureId); if (!sg || s.ESign.validity(sg).state !== 'valid') return false; } catch (e) { return false; }
      return sg.signRuleId === 'SM-APPR-SKIP' && str(sg.batchId) === it.batchId && str(sg.nodeId) === it.nodeId && (!sg.stepKey || str(sg.stepKey) === it.stepKey);
    }
    function badSkip(tree, batchId, R, scope) {
      return itemsOf(tree, batchId, scope).filter(function (x) { return x.state === 'skipped' && !skipValid(x, R); })[0] || null;
    }
    var integrityAudited = {};
    function integrityFail(batchId, why, vars) {
      var key = batchId + '|' + why + '|' + (vars.node || '');
      if (!integrityAudited[key]) {
        integrityAudited[key] = true; var s = S();
        try { if (s && s.Audit) TW().appendMany([{ act: 'TREE_INTEGRITY_BLOCK', tgt: batchId, val: why + (vars.node ? ' · ' + vars.node : ''), why: why, batchId: batchId }]); } catch (e) { /* 감사 실패해도 차단 유지 */ }
      }
      var r = fail(why, vars, { integrity: true });
      if (vars.detail === 'ledger_orphan' && vars.kind) {
        var K = { 'SM-APPR-ROUTE': ['예외 경로 승인 서명', 'SM-APPR-ROUTE'], 'SM-APPR-SKIP': ['건너뛰기 승인 서명', 'SM-APPR-SKIP'], 'SM-APPR-REPEAT': ['반복 한도 초과 승인 서명', 'SM-APPR-REPEAT'], perform: ['단계 수행 서명', 'SM-PERF-STEP'], verify: ['단계 확인 서명', 'SM-VERI-STEP'] }[vars.kind] || ['서명', vars.kind];
        r.msg = fill(MSG.tree_orphan_sig, { kindLabel: K[0], rule: K[1], node: vars.node || '—' });
      }
      return r;
    }
    function legacyAudit(batchId, R) {
      if (!R || !R.legacy) return;
      var s = S(); if (!s || !s.Audit) return;
      var seen = readItems(KEYS.AUDIT).some(function (a) { return a && a.act === 'TREE_SNAPSHOT_LEGACY' && a.batchId === batchId; });
      if (seen) return;
      try { TW().appendMany([{ act: 'TREE_SNAPSHOT_LEGACY', tgt: batchId, val: batchId + ' · unreachable ' + R.unreachable.length, batchId: batchId }]); } catch (e) { /* 표시용 감사 — 실패해도 판정은 레거시(예외 경로 불가)로 계속 */ }
    }
    function maxRepeatOf(R, nodeId) { var r = R.nodes[nodeId] && R.nodes[nodeId].execRule; var m = r && Number(r.maxRepeat); return m >= 1 ? Math.floor(m) : DEFAULT_MAX_REPEAT; }
    function skippable(R, nodeId) { var r = R.nodes[nodeId] && R.nodes[nodeId].execRule; return !!(r && r.skippable === true); }
    /* 표시 이름 (설계 리뷰 #15): 포장은 내부 키(line · clrS …) 대신 단계 번호, 생산은 노드 id. 이름 = 라벨 */
    function labelOf(R, id) { var k = parseStepKey(id).nodeId; return R && R.nodes[k] ? R.nodes[k].label : ''; }
    function codeOf(R, id) { if (!id || id === '—') return id; var k = parseStepKey(id); if (R && R.scope === 'pack') { var i = R.order.indexOf(k.nodeId); return i >= 0 ? String(i + 1) : id; } return id; }
    function nameOf(R, id) { return id && R.nodes[id] ? codeOf(R, id) + ' ' + R.nodes[id].label : (id || ''); }
    var NAME_KEYS = { node: 'nodeName', pred: 'predName', busy: 'busyName', from: 'fromName', to: 'toName', nextDueNode: 'nextDueName' };
    function failT(R, why, vars, extra) {
      vars = vars || {}; var d = {}; Object.keys(vars).forEach(function (k) { d[k] = vars[k]; });
      ['pred', 'node', 'busy', 'from', 'to'].forEach(function (k) { if (vars[k]) d[k] = codeOf(R, vars[k]); });
      var r = fail(why, vars, extra); r.msg = msgFor(why, d);
      Object.keys(NAME_KEYS).forEach(function (k) { if (r[k] && r[k] !== '—' && !r[NAME_KEYS[k]]) r[NAME_KEYS[k]] = labelOf(R, r[k]); });
      if (r.missingSlots) r.missingSlotNames = r.missingSlots.map(function (x) { return SLOT_NAME[x] || x; });
      return r;
    }
    function seqIn(R, id) { return R.edges.filter(function (e) { return e.type === 'seq' && e.to === id; }); }
    function seqOut(R, id) { return R.edges.filter(function (e) { return e.type === 'seq' && e.from === id; }); }
    /* 종료 노드로 가는 경로(X5 — QA만): to 에서 seq 로 따라가 주 경로 합류 없이 종료 노드에 닿으면 true */
    function leadsToTerminal(R, to) {
      var seen = {}, cur = to;
      while (cur && !seen[cur]) { seen[cur] = 1; if (R.terminal[cur]) return true; if (!R.exceptionOf[cur]) return false; var o = seqOut(R, cur)[0]; cur = o ? o.to : null; }
      return false;
    }
    /* 되돌아오는 seq 로 다시 도달했는가: P → node seq 에서 P 최신이 node 최신보다 뒤에 끝남 */
    function pendingRepeat(tree, R, batchId, scope, nodeId) {
      var L = latestOf(tree, batchId, scope, nodeId); if (!L || (L.state !== 'done' && L.state !== 'skipped')) return null;
      var hit = seqIn(R, nodeId).filter(function (e) { var P = latestOf(tree, batchId, scope, e.from); return P && P.state === 'done' && seqOf(P.instId) > seqOf(L.instId); })[0];
      return hit ? { from: hit.from, iter: L.iter + 1, max: maxRepeatOf(R, nodeId), prev: L } : null;
    }
    function openException(tree, R, batchId, scope, exceptId) {
      return itemsOf(tree, batchId, scope).filter(function (x) { return R.exceptionOf[x.nodeId] && x.nodeId !== exceptId && (x.state === 'ready' || x.state === 'in_progress') && latestOf(tree, batchId, scope, x.nodeId) === x; })[0] || null;
    }

    /* ---------------------------------------------------------------- 판정 */
    /* 공통 앞부분: 배치 · 범위 · 잠금 · 출하 · 스냅샷 · store · 보류 */
    function pre(batchId, scope, opt) {
      batchId = str(batchId); if (!batchId) return { r: fail('no_batch') };
      if (SCOPES.indexOf(scope) < 0) return { r: fail('bad_scope') };
      var s = S();
      if (!(opt && opt.read) && s && typeof s.readOnlyGuard === 'function') { var g = null; try { g = s.readOnlyGuard('SM-PERF-STEP'); } catch (e) { g = { message: MSG.read_only }; } if (g) return { r: fail('read_only', null, { msg: g.message || MSG.read_only }) }; }
      var ss = SS();
      if (!(opt && opt.read) && ss && typeof ss.releaseState === 'function' && ss.releaseState(batchId)) return { r: fail('already_released') };
      var R = routeFor(batchId, scope); if (!R) return { r: fail('tree_snapshot_missing') };
      if (R.integrity) return { r: integrityFail(batchId, R.integrity, {}) };
      if (!(opt && opt.noLegacyAudit)) legacyAudit(batchId, R);
      var tree = readTree(); if (!tree) return { r: fail('tree_store_unreadable') };
      var bad = badSkip(tree, batchId, R, scope) || chainBad(tree, batchId, R, scope); if (bad) return { r: integrityFail(batchId, 'tree_record_tampered', bad.why ? (bad.sig ? { node: bad.stepKey, detail: bad.why, sig: bad.sig, kind: bad.kind } : { node: bad.stepKey, detail: bad.why }) : { node: bad.stepKey }) };
      var h = heldOf(tree, batchId) || terminalAudited(batchId); if (h && !(opt && opt.allowHeld)) return { r: failT(R, 'tree_batch_held', { node: h.nodeId }), R: R, tree: tree };
      return { batchId: batchId, scope: scope, R: R, tree: tree };
    }
    function judge(P, nodeId, light) {
      var R = P.R, tree = P.tree, B = P.batchId, sc = P.scope;
      nodeId = str(nodeId);
      if (!R.nodes[nodeId] || R.unreachable.indexOf(nodeId) >= 0) return failT(R, 'tree_no_edge', { from: '—', to: nodeId });
      var cur = latestOf(tree, B, sc, nodeId);
      if (cur && cur.state === 'in_progress') return { ok: true, resume: true, iter: cur.iter, stepKey: cur.stepKey, instance: cur };
      /* 리뷰 X4 ③: 이 배치에 열린 일탈 기록이 하나라도 있으면 보류 — 주 경로 · 포장 새 단계 시작 불가 (예외 경로로 종료 노드까지 가는 것만 허용) */
      var dv = openDev(B); if (dv && !R.exceptionOf[nodeId]) return failT(R, 'tree_dev_hold', { dev: dv, node: nodeId }, { devId: dv });
      if (cur && (cur.state === 'done' || cur.state === 'skipped')) {
        var pr = pendingRepeat(tree, R, B, sc, nodeId);
        if (pr && pr.iter > pr.max) return failT(R, 'tree_repeat_limit', { max: pr.max, node: nodeId, iter: pr.iter });
        return failT(R, 'tree_step_done', { node: nodeId });
      }
      if (cur && cur.state === 'terminal') return failT(R, 'tree_batch_held', { node: nodeId });
      var predOk = !!cur, edgeFrom = cur ? cur.enteredBy && cur.enteredBy.edgeFrom : null, edgeType = cur ? cur.enteredBy && cur.enteredBy.edgeType : null;
      if (!cur) {
        if (nodeId === R.start && !itemsOf(tree, B, sc).length) { predOk = true; edgeType = 'start'; }
        else {
          var pe = seqIn(R, nodeId).filter(function (e) { var p = latestOf(tree, B, sc, e.from); return p && (p.state === 'done' || p.state === 'skipped'); })[0];
          if (pe) { predOk = true; edgeFrom = pe.from; edgeType = 'seq'; }
        }
      }
      if (!predOk) {
        if (R.exceptionOf[nodeId]) return failT(R, 'tree_route_unapproved', { from: R.exceptionOf[nodeId][0], node: nodeId });
        var pin = seqIn(R, nodeId).filter(function (e) { return R.main.indexOf(e.from) >= 0; })[0] || seqIn(R, nodeId)[0];
        var nd = light ? null : nextDue0(P);
        return failT(R, 'tree_order_blocked', { pred: pin ? pin.from : '—', predName: pin ? R.nodes[pin.from].label : '', nextDue: nd && nd.nodeId ? nameOf(R, nd.nodeId) + (nd.iter > 1 ? ' #' + nd.iter : '') : '', node: nodeId },
                    { nextDueNode: nd ? nd.nodeId : null });
      }
      /* X9: 예외 경로가 합류할 때까지 주 경로 다음 단계는 차단 */
      if (!R.exceptionOf[nodeId]) {
        /* 반복(되돌아오기)으로 앞선 주 경로 단계가 다시 ready/진행이면 그 단계부터 */
        var mi = R.main.indexOf(nodeId), redo = mi > 0 ? R.main.slice(0, mi).map(function (id) { return latestOf(tree, B, sc, id); }).filter(function (x) { return x && (x.state === 'ready' || x.state === 'in_progress'); })[0] : null;
        if (redo) return failT(R, 'tree_order_blocked', { pred: redo.nodeId, predName: R.nodes[redo.nodeId].label, nextDue: nameOf(R, redo.nodeId) + (redo.iter > 1 ? ' #' + redo.iter : ''), node: nodeId }, { nextDueNode: redo.nodeId });
        var oe = openException(tree, R, B, sc, nodeId);
        if (oe) return failT(R, 'tree_order_blocked', { pred: oe.nodeId, predName: R.nodes[oe.nodeId].label, nextDue: nameOf(R, oe.nodeId), node: nodeId }, { nextDueNode: oe.nodeId });
      }
      var busy = itemsOf(tree, B, sc).filter(function (x) { return x.state === 'in_progress' && x.nodeId !== nodeId; })[0];
      if (busy) return failT(R, 'tree_step_busy', { busy: busy.stepKey, node: nodeId });
      var iter = cur ? cur.iter : 1;
      return { ok: true, resume: false, iter: iter, stepKey: stepKeyOf(nodeId, iter), edgeFrom: edgeFrom || null, edgeType: edgeType || 'seq' };
    }
    function nextDue0(P) {
      var R = P.R, tree = P.tree, B = P.batchId, sc = P.scope, its = itemsOf(tree, B, sc);
      var ip = its.filter(function (x) { return x.state === 'in_progress'; })[0];
      if (ip) return { nodeId: ip.nodeId, stepKey: ip.stepKey, iter: ip.iter };
      if (!its.length) return { nodeId: R.start, stepKey: R.start, iter: 1 };
      var cands = R.order.filter(function (id) { return judge(P, id, true).ok; });
      var exc = cands.filter(function (id) { return R.exceptionOf[id]; })[0], id = exc || cands[0];
      if (!id) return { nodeId: null, stepKey: null, iter: null };
      var L = latestOf(tree, B, sc, id), it = L ? L.iter : 1;
      return { nodeId: id, stepKey: stepKeyOf(id, it), iter: it };
    }

    /** route(batchId) — 생산 트리 분류. 레거시(exceptionEdges 없음)면 legacy true · 감사 TREE_SNAPSHOT_LEGACY 1회 */
    function route(batchId) {
      batchId = str(batchId); if (!batchId) return fail('no_batch');
      var R = routeFor(batchId, 'prod'); if (!R) return fail('tree_snapshot_missing');
      if (R.integrity) return integrityFail(batchId, R.integrity, {});
      legacyAudit(batchId, R);
      var nodes = {}; Object.keys(R.nodes).forEach(function (id) { var n = R.nodes[id]; nodes[id] = { label: n.label, opId: n.opId, opName: n.opName, upId: n.upId, upName: n.upName, execRule: clone(n.execRule), isWeigh: n.isWeigh, handoff: !!n.handoff, skippable: n.execRule.skippable === true, maxRepeat: maxRepeatOf(R, id) }; });
      return { ok: true, legacy: R.legacy, start: R.start, order: R.order.slice(), main: R.main.slice(), exceptionOf: clone(R.exceptionOf), terminal: clone(R.terminal), back: clone(R.back),
               unreachable: R.unreachable.slice(), nodes: nodes, edges: clone(R.edges) };
    }
    function canStart(batchId, scope, nodeId) {
      var P = pre(batchId, scope); if (P.r) return P.r;
      var r = judge(P, nodeId, false); if (r.instance) r.instance = clone(r.instance); return r;
    }

    function curUser() { var s = S(); var u = s && s.getCurrentUser ? s.getCurrentUser() : null; return u && u.userId ? u : null; }
    function blockAudit(P, batchId, nodeId, r) {
      var s = S(); if (!s || !s.Audit) return;
      var key = str(batchId) + '|' + str(nodeId) + '|' + r.why, t = nowMs();
      if (blockSeen[key] && t - blockSeen[key] < BLOCK_DEDUP_MS) return;
      var val = str(nodeId) + ' · ' + r.why + (r.nextDueNode ? ' · nextDue ' + r.nextDueNode : '');
      var recent = readItems(KEYS.AUDIT).some(function (a) { var at = Date.parse(a && a.at); return a && a.act === 'TREE_ORDER_BLOCKED' && a.batchId === str(batchId) && a.val === val && isFinite(at) && t - at < BLOCK_DEDUP_MS && t - at >= 0; });
      blockSeen[key] = t; if (recent) return;
      try { TW().appendMany([{ act: 'TREE_ORDER_BLOCKED', tgt: str(batchId) + ' · ' + str(nodeId), val: val, why: r.msg, batchId: str(batchId) }]); } catch (e) { /* 차단은 그대로 */ }
    }

    /* 다음 단계 계산 (완료 · 건너뛰기 공통): seq 대상 ready, 이미 끝난 대상 = 반복(iter+1 ≤ 한도면 자동, 넘으면 repeatBlocked) */
    function advance(tree, R, B, sc, nodeId, at) {
      var next = [], repeatBlocked = [], audits = [];
      seqOut(R, nodeId).forEach(function (e) {
        var T = latestOf(tree, B, sc, e.to);
        if (T && (T.state === 'done' || T.state === 'skipped')) {
          var iter = T.iter + 1, max = maxRepeatOf(R, e.to);
          if (iter > max) { repeatBlocked.push({ nodeId: e.to, iter: iter, max: max }); return; }
          T.state = 'superseded';
          var n = newInst(tree, B, sc, e.to, iter, 'ready', { edgeFrom: nodeId, edgeType: 'back' });
          next.push(e.to);
          audits.push({ act: 'TREE_STEP_REPEATED', tgt: B + ' · ' + n.stepKey, val: e.to + ' · iter ' + iter, batchId: B });
        } else if (!T) { newInst(tree, B, sc, e.to, 1, 'ready', { edgeFrom: nodeId, edgeType: 'seq' }); next.push(e.to); }
      });
      return { next: next, repeatBlocked: repeatBlocked, audits: audits };
    }

    /** start — canStart ok 일 때만 인스턴스 생성/전이 + 감사 TREE_STEP_STARTED (차단 시도는 TREE_ORDER_BLOCKED, 5분 중복 제거) */
    /* 리뷰 A2: 단계 시작 · 완료 = 단계 수행 역할(OP · SV, 생산 · 포장 수행 슬롯과 같음). QA · ADMIN 등은 거부 + 감사 TREE_ROLE_DENIED */
    var STEP_ROLES = ['OP', 'SV'];
    function roleGate(u, fn, batchId, nodeId) {
      var s = S(), roles = []; try { roles = (s.rolesOf ? s.rolesOf(u.userId) : []) || []; } catch (e) { roles = []; }
      if (roles.some(function (r) { return STEP_ROLES.indexOf(r) >= 0; })) return null;
      try { TW().appendMany([{ act: 'TREE_ROLE_DENIED', tgt: str(batchId) + ' ' + str(nodeId), val: fn + ' · ' + (roles.join(',') || '역할 없음'), why: 'tree_role_denied', batchId: str(batchId) }]); } catch (e) { /* 감사 실패해도 거부 */ }
      return fail('tree_role_denied', { roles: roles.join(', ') || '없음', node: str(nodeId) });
    }
    function start(batchId, scope, nodeId, opts) {
      var u = curUser(); if (!S()) return fail('no_session'); if (!u) return fail('no_current_user');
      var rg = roleGate(u, 'start', batchId, nodeId); if (rg) return rg;
      var P = pre(batchId, scope); if (P.r) { if (P.R) blockAudit(P, batchId, nodeId, P.r); return P.r; }
      var c = judge(P, nodeId, false);
      if (!c.ok) { blockAudit(P, P.batchId, nodeId, c); return c; }
      if (c.resume) return { ok: true, resume: true, instance: clone(c.instance) };
      var tree = P.tree, B = P.batchId, at = nowIso(), it = latestOf(tree, B, scope, str(nodeId));
      if (!it || it.state !== 'ready') it = newInst(tree, B, scope, str(nodeId), c.iter, 'ready', { edgeFrom: c.edgeFrom, edgeType: c.edgeType });
      it.state = 'in_progress'; it.startedAt = at; it.startedBy = u.userId;
      tree.path.push({ instId: it.instId, at: at });
      var ok = commit(tree, [{ act: 'TREE_STEP_STARTED', tgt: B + ' · ' + it.stepKey, val: it.stepKey + (it.iter === 1 ? '#1' : '') + ' · 선행 ' + ((it.enteredBy && it.enteredBy.edgeFrom) || '—'), batchId: B }]);
      return ok ? { ok: true, resume: false, instance: clone(it) } : fail('save_error');
    }

    /* 완료 조건: 건너뛰기 가능 노드 = 서명 0 · 칭량 = EbrDispense 확인 완료 · 그 밖 = 필요 슬롯 서명 유효 (X3 perform · verify) */
    function signsMissing(R, B, sc, nodeId, stepKey) {
      if (skippable(R, nodeId) || R.nodes[nodeId].handoff) return [];   /* 건너뛰기 가능 · 포장 이관(handoff) 노드 = 서명 슬롯 0 */
      var ss = SS(); if (!ss) return ['서명 상태 모듈 없음'];
      if (sc === 'prod' && R.nodes[nodeId].isWeigh) {
        var w = ss.weighSignSummary(B); return (w && w.ok && !w.noPlan && w.lines > 0 && w.pending === 0) ? [] : ['칭량 줄 확인 서명'];
      }
      var gs = ss.getSignStatus({ batchId: B, scope: sc }); if (!gs || !gs.ok) return ['서명 상태 판독 불가'];
      var mine = gs.items.filter(function (i) { return i.scope === sc && i.stepKey === stepKey; });
      if (!mine.length) return ['서명 슬롯 정의 없음'];
      return mine.filter(function (i) { return i.status !== 'signed' && i.status !== 'replaced'; }).map(function (i) { return i.slot; });
    }
    function devOk(B, devId) {
      devId = str(devId); if (!devId) return false;
      return readItems(KEYS.DEV).some(function (d) { return d && str(d.id) === devId && str(d.batchId) === B; });
    }
    /** complete — in_progress 이고 완료 조건 충족 → done(다음 ready) · 종료 노드면 terminal + 일탈 연결 필수 */
    function complete(batchId, scope, nodeId, opts) {
      opts = opts || {};
      var u = curUser(); if (!S()) return fail('no_session'); if (!u) return fail('no_current_user');
      var rg = roleGate(u, 'complete', batchId, nodeId); if (rg) return rg;
      var P = pre(batchId, scope); if (P.r) return P.r;
      var R = P.R, tree = P.tree, B = P.batchId; nodeId = str(nodeId);
      if (!R.nodes[nodeId]) return failT(R, 'tree_no_edge', { from: '—', to: nodeId });
      var cur = latestOf(tree, B, scope, nodeId);
      if (!cur || cur.state !== 'in_progress') return cur && (cur.state === 'done' || cur.state === 'skipped') ? failT(R, 'tree_step_done', { node: nodeId }) : failT(R, 'tree_not_started', { node: nodeId });
      var miss = signsMissing(R, B, scope, nodeId, cur.stepKey);
      if (miss.length) return failT(R, 'tree_signs_missing', { missing: miss.map(function (x) { return SLOT_NAME[x] || x; }).join(', '), node: nodeId }, { missingSlots: miss });
      var at = nowIso();
      if (R.terminal[nodeId]) {
        if (!devOk(B, opts.devId)) return failT(R, 'tree_terminal_no_dev', { node: nodeId });
        cur.state = 'terminal'; cur.doneAt = at; cur.doneBy = u.userId; cur.devId = str(opts.devId); cur.signatureIds = stepSigIds(B, scope, cur.stepKey);
        var okT = commit(tree, [{ act: 'TREE_TERMINAL_REACHED', tgt: B + ' · ' + cur.stepKey, val: cur.stepKey + ' · ' + cur.devId, batchId: B }]);
        return okT ? { ok: true, instance: clone(cur), next: [], terminal: true } : fail('save_error');
      }
      cur.state = 'done'; cur.doneAt = at; cur.doneBy = u.userId; cur.signatureIds = stepSigIds(B, scope, cur.stepKey);
      var adv = advance(tree, R, B, scope, nodeId, at);
      var audits = [{ act: 'TREE_STEP_DONE', tgt: B + ' · ' + cur.stepKey, val: cur.stepKey + ' · 다음 ' + (adv.next.join(', ') || '—'), batchId: B }].concat(adv.audits);
      if (!commit(tree, audits)) return fail('save_error');
      var out = { ok: true, instance: clone(cur), next: adv.next, terminal: false };
      if (adv.repeatBlocked.length) out.repeatBlocked = adv.repeatBlocked;
      return out;
    }

    /* ---------------------------------------------------------------- 승인 서명 (ROUTE · SKIP · REPEAT) */
    function reasonOk(reason) { var r = str(reason); return r && cpLen(r) <= REASON_MAX ? r : null; }
    function performersOf(B, sc, inst) {
      var out = [], ss = SS();
      if (inst && inst.startedBy) out.push(inst.startedBy);
      if (ss && inst) { try { var gs = ss.getSignStatus({ batchId: B, scope: sc }); (gs && gs.items || []).forEach(function (i) { if (i.stepKey === inst.stepKey && i.slot === 'perform' && i.signerId) out.push(i.signerId); }); } catch (e) { /* 무시 */ } }
      return out.filter(function (x, i) { return x && out.indexOf(x) === i; });
    }
    function openSign(kind, spec, meta) {
      var s = S(); if (!s) return fail('no_session');
      var r = s.beginRecordSign(spec); if (!r || !r.ok) return r;
      tickets[r.ticket] = Object.assign({ kind: kind }, meta);
      r.target = Object.assign({}, r.target, meta.target || {});
      return r;
    }
    function commitSign(kind, ticket, auth) {
      var s = S(); if (!s) return fail('no_session');
      var t = tickets[ticket]; if (!t || t.kind !== kind) return fail('bad_ticket');
      var r = s.signAndCommitRecord(ticket, auth || {});
      if (!r || !r.ok) { if (r && r.closeDialog) delete tickets[ticket]; return r; }
      delete tickets[ticket];
      var tree = readTree() || { items: [] }, sid = r.signature ? r.signature.signatureId : r.signatureId;
      var inst = tree.items.filter(function (x) { return x && x.batchId === t.batchId && x.scope === t.scope && x.nodeId === t.nodeId; })
        .sort(function (a, b) { return seqOf(b.instId) - seqOf(a.instId); })[0];
      var out = { ok: true, signatureId: sid, instance: clone(inst || null) };
      if (r.result) Object.keys(r.result).forEach(function (k) { out[k] = r.result[k]; });
      return out;
    }

    /** enterException — 예외 간선(스냅샷) · from 진행 중 또는 완료 · 사유 1–60자 → SM-APPR-ROUTE 서명 시작. 커밋 시 to = ready */
    function enterException(batchId, fromNode, toNode, reason, evidence) {
      var u = curUser(); if (!S()) return fail('no_session'); if (!u) return fail('no_current_user');
      var P = pre(batchId, 'prod'); if (P.r) return P.r;
      var R = P.R, B = P.batchId, from = str(fromNode), to = str(toNode);
      var edge = R.edges.filter(function (e) { return e.type === 'exception' && e.from === from && e.to === to; })[0];
      if (!edge) return failT(R, 'tree_no_edge', { from: from || '—', to: to || '—' }, { legacy: R.legacy });
      var rs = reasonOk(reason); if (!rs) return fail('reason_required');
      var ev = str(evidence).slice(0, 120);
      function check(tree) {
        var F = latestOf(tree, B, 'prod', from);
        if (!F || (F.state !== 'in_progress' && F.state !== 'done')) return failT(R, 'tree_order_blocked', { pred: from, predName: R.nodes[from].label, nextDue: '', node: to });
        var T = latestOf(tree, B, 'prod', to);
        if (T && (T.state === 'ready' || T.state === 'in_progress')) return failT(R, 'tree_step_busy', { busy: T.stepKey, node: to });
        if (heldOf(tree, B)) return failT(R, 'tree_batch_held', { node: heldOf(tree, B).nodeId });
        return { ok: true, F: F, T: T };
      }
      var c = check(P.tree); if (!c.ok) return c;
      var qaOnly = leadsToTerminal(R, to), s = S();
      if (qaOnly) { var roles = (s.rolesOf ? s.rolesOf(u.userId) : []) || []; if (roles.indexOf('QA') < 0) return failT(R, 'tree_route_qa_only', { from: from, to: to }); }
      var distinct = performersOf(B, 'prod', c.F).map(function (id) { return { userId: id, label: 'from 단계 수행자' }; });
      var ctx = { batchId: B, from: from, label: edge.label, to: to, reason: rs };
      return openSign('route', {
        signRuleId: SIGN_RULES.ROUTE.ruleId, recordType: 'tree_route', tgt: B + ' · ' + from + ' → ' + to, val: edge.label || (from + ' → ' + to), screen: 'tree-exec',
        statementKind: 'tree_route_enter', statementCtx: ctx, keys: [KEYS.TREE], qualTargets: [],
        fields: { batchId: B, fromNode: from, toNode: to, edgeType: 'exception', reason: rs, statementKind: 'tree_route_enter' },
        distinctFrom: distinct,
        precheck: function () { var t = readTree(); if (!t) return { detail: 'store', message: WHY.tree_store_unreadable }; var k = check(t); return k.ok ? null : { detail: k.why, message: k.msg }; },
        apply: function (sig, actx) {
          if (qaOnly && sig.signerRole !== 'QA') throw new Error(msgFor('tree_route_qa_only', { from: from, to: to }));
          var tree = readTree(); if (!tree) throw new Error(WHY.tree_store_unreadable);
          var k = check(tree); if (!k.ok) throw new Error(k.msg);
          var iter = 1; if (k.T) { k.T.state = 'superseded'; iter = k.T.iter + 1; }
          var it = newInst(tree, B, 'prod', to, iter, 'ready', { edgeFrom: from, edgeType: 'exception', approvalSignatureId: sig.signatureId });
          it.reason = rs; if (ev) it.evidence = ev;
          var hd = writeTree(tree);
          return pinHead(hd, { result: { qaOnly: qaOnly }, audits: [{ act: 'TREE_ROUTE_ENTERED', tgt: B + ' · ' + from + ' → ' + to, val: from + ' → ' + to + ' · ' + sig.signatureId, why: rs, batchId: B, signRuleId: SIGN_RULES.ROUTE.ruleId, recordType: 'tree_route' }] });
        }
      }, { batchId: B, scope: 'prod', nodeId: to, target: { edge: clone(edge), qaOnly: qaOnly, evidence: ev, approverRoles: qaOnly ? ['QA'] : ['SV', 'QA'] } });
    }
    function commitRoute(ticket, auth) { return commitSign('route', ticket, auth); }

    /** skip — execRule.skippable === true 만 (X2) · canStart 와 같은 선행 조건 → SM-APPR-SKIP. 커밋 시 skipped + 다음 ready */
    function skip(batchId, nodeId, reason, scope) {
      scope = scope || 'prod';
      var u = curUser(); if (!S()) return fail('no_session'); if (!u) return fail('no_current_user');
      var P = pre(batchId, scope); if (P.r) return P.r;
      var R = P.R, B = P.batchId; nodeId = str(nodeId);
      if (!R.nodes[nodeId]) return failT(R, 'tree_no_edge', { from: '—', to: nodeId });
      if (!skippable(R, nodeId)) return failT(R, 'tree_skip_not_allowed', { node: nodeId });
      var rs = reasonOk(reason); if (!rs) return fail('reason_required');
      function check(tree) {
        var c = judge({ batchId: B, scope: scope, R: R, tree: tree }, nodeId, false); if (!c.ok) return c;
        if (c.resume) return failT(R, 'tree_step_busy', { busy: c.stepKey, node: nodeId });
        if (heldOf(tree, B)) return failT(R, 'tree_batch_held', { node: heldOf(tree, B).nodeId });
        return c;
      }
      var c = check(P.tree); if (!c.ok) return c;
      return openSign('skip', {
        signRuleId: SIGN_RULES.SKIP.ruleId, recordType: 'tree_route', tgt: B + ' · ' + c.stepKey, val: '건너뛰기 ' + c.stepKey, screen: 'tree-exec',
        statementKind: 'step_skip', statementCtx: { batchId: B, node: nodeId, reason: rs }, keys: [KEYS.TREE], qualTargets: [],
        fields: { batchId: B, nodeId: nodeId, stepKey: c.stepKey, reason: rs, statementKind: 'step_skip' }, distinctFrom: [],
        precheck: function () { var t = readTree(); if (!t) return { detail: 'store', message: WHY.tree_store_unreadable }; var k = check(t); return k.ok ? null : { detail: k.why, message: k.msg }; },
        apply: function (sig, actx) {
          var tree = readTree(); if (!tree) throw new Error(WHY.tree_store_unreadable);
          var k = check(tree); if (!k.ok) throw new Error(k.msg);
          var it = latestOf(tree, B, scope, nodeId);
          if (!it || it.state !== 'ready') it = newInst(tree, B, scope, nodeId, k.iter, 'ready', { edgeFrom: k.edgeFrom, edgeType: k.edgeType });
          it.state = 'skipped'; it.reason = rs; it.skipSignatureId = sig.signatureId; it.doneAt = actx.at || nowIso(); it.doneBy = sig.signerId;
          tree.path.push({ instId: it.instId, at: it.doneAt });
          var adv = advance(tree, R, B, scope, nodeId, it.doneAt);
          var hd = writeTree(tree);
          return pinHead(hd, { result: { next: adv.next }, audits: [{ act: 'TREE_STEP_SKIPPED', tgt: B + ' · ' + it.stepKey, val: it.stepKey + ' · ' + sig.signatureId, why: rs, batchId: B, signRuleId: SIGN_RULES.SKIP.ruleId, recordType: 'tree_route' }].concat(adv.audits) });
        }
      }, { batchId: B, scope: scope, nodeId: nodeId, target: { stepKey: c.stepKey, node: clone(R.nodes[nodeId]) } });
    }
    function commitSkip(ticket, auth) { return commitSign('skip', ticket, auth); }

    /** repeat — 되돌아오는 seq 로 다시 도달한 노드의 iter+1. 한도 이내 = 서명 없이 ready, 넘으면 SM-APPR-REPEAT(needApproval) */
    function repeat(batchId, nodeId, opts) {
      opts = opts || {};
      var scope = opts.scope || 'prod';
      var u = curUser(); if (!S()) return fail('no_session'); if (!u) return fail('no_current_user');
      var P = pre(batchId, scope); if (P.r) return P.r;
      var R = P.R, B = P.batchId; nodeId = str(nodeId);
      if (!R.nodes[nodeId]) return failT(R, 'tree_no_edge', { from: '—', to: nodeId });
      var pr = pendingRepeat(P.tree, R, B, scope, nodeId);
      if (!pr) { var j = judge(P, nodeId, false); return j.ok ? failT(R, 'tree_step_done', { node: nodeId }) : j; }
      if (pr.iter <= pr.max) {
        var tree = P.tree; pr.prev.state = 'superseded';
        var n = newInst(tree, B, scope, nodeId, pr.iter, 'ready', { edgeFrom: pr.from, edgeType: 'back' });
        return commit(tree, [{ act: 'TREE_STEP_REPEATED', tgt: B + ' · ' + n.stepKey, val: nodeId + ' · iter ' + pr.iter, batchId: B }]) ? { ok: true, instance: clone(n) } : fail('save_error');
      }
      var rs = reasonOk(opts.reason); if (!rs) return fail('reason_required', null, { needApproval: true, iter: pr.iter, max: pr.max });
      var prevIters = itemsOf(P.tree, B, scope).filter(function (x) { return x.nodeId === nodeId; });
      var distinct = []; prevIters.forEach(function (x) { performersOf(B, scope, x).forEach(function (id) { if (!distinct.some(function (d) { return d.userId === id; })) distinct.push({ userId: id, label: '이전 회차 수행자' }); }); });
      var key = stepKeyOf(nodeId, pr.iter);
      var r = openSign('repeat', {
        signRuleId: SIGN_RULES.REPEAT.ruleId, recordType: 'tree_route', tgt: B + ' · ' + key, val: '반복 ' + key + ' (한도 ' + pr.max + '회 초과)', screen: 'tree-exec',
        statementKind: 'step_repeat_over', statementCtx: { batchId: B, node: nodeId, iter: pr.iter, max: pr.max, reason: rs }, keys: [KEYS.TREE], qualTargets: [],
        fields: { batchId: B, nodeId: nodeId, stepKey: key, reason: rs, statementKind: 'step_repeat_over' }, distinctFrom: distinct,
        precheck: function () { var t = readTree(); if (!t) return { detail: 'store', message: WHY.tree_store_unreadable }; if (heldOf(t, B)) return { detail: 'tree_batch_held', message: msgFor('tree_batch_held', { node: heldOf(t, B).nodeId }) }; var p2 = pendingRepeat(t, R, B, scope, nodeId); return p2 && p2.iter === pr.iter ? null : { detail: 'changed', message: WHY.tree_step_done }; },
        apply: function (sig) {
          var tree = readTree(); if (!tree) throw new Error(WHY.tree_store_unreadable);
          var p2 = pendingRepeat(tree, R, B, scope, nodeId); if (!p2 || p2.iter !== pr.iter) throw new Error(WHY.tree_step_done);
          p2.prev.state = 'superseded';
          var n = newInst(tree, B, scope, nodeId, p2.iter, 'ready', { edgeFrom: p2.from, edgeType: 'back' }); n.repeatSignatureId = sig.signatureId; n.reason = rs;
          var hd = writeTree(tree);
          return pinHead(hd, { result: { superseded: p2.prev.instId }, audits: [{ act: 'TREE_STEP_REPEATED', tgt: B + ' · ' + n.stepKey, val: nodeId + ' · iter ' + p2.iter + ' · ' + sig.signatureId, why: rs, batchId: B, signRuleId: SIGN_RULES.REPEAT.ruleId, recordType: 'tree_route' }] });
        }
      }, { batchId: B, scope: scope, nodeId: nodeId, target: { stepKey: key, iter: pr.iter, max: pr.max, prevIters: prevIters.map(function (x) { return { stepKey: x.stepKey, iter: x.iter, state: x.state }; }) } });
      if (r && r.ok) r.needApproval = true;
      return r;
    }
    function commitRepeat(ticket, auth) { return commitSign('repeat', ticket, auth); }
    function cancel(ticket, o) { var s = S(); if (!s) return fail('no_session'); delete tickets[ticket]; return s.cancelRecordSign(ticket, o || {}); }

    /* ---------------------------------------------------------------- 읽기 */
    /** requiredNodes — 주 경로(건너뜀 = na) + 진입한 예외 노드, 반복은 최신 인스턴스만 (게이트 3 원천) */
    function requiredNodes(batchId, scope) {
      var P = pre(batchId, scope, { allowHeld: true, noLegacyAudit: true, read: true }); if (P.r) return P.r;
      var R = P.R, tree = P.tree, B = P.batchId, items = [];
      R.order.forEach(function (id) {
        var L = latestOf(tree, B, scope, id), main = R.main.indexOf(id) >= 0;
        if (!main && !(R.exceptionOf[id] && L)) return;
        var st0 = L ? L.state : (heldOf(tree, B) ? 'locked' : (judge(P, id, true).ok ? 'ready' : 'locked'));
        items.push({ nodeId: id, stepKey: L ? L.stepKey : id, iter: L ? L.iter : 1, state: st0, code: codeOf(R, id), name: nameOf(R, id), na: !!(L && L.state === 'skipped'),
                     exception: !main, skippable: skippable(R, id), isWeigh: !!R.nodes[id].isWeigh, handoff: !!R.nodes[id].handoff, label: R.nodes[id].label });
      });
      return { ok: true, legacy: R.legacy, items: items };
    }
    function list(batchId, scope) {
      batchId = str(batchId); if (!batchId) return fail('no_batch');
      var tree = readTree(); if (!tree) return fail('tree_store_unreadable');
      return { ok: true, items: clone(itemsOf(tree, batchId, scope || null)), path: clone(tree.path.filter(function (p) { return str(p.instId).indexOf('TX-' + batchId + '-') === 0; })) };
    }
    function rowState(batchId, scope, nodeId) {
      var P = pre(batchId, scope, { allowHeld: true, noLegacyAudit: true, read: true }); if (P.r) return P.r;
      var R = P.R, B = P.batchId; nodeId = str(nodeId);
      if (!R.nodes[nodeId]) return failT(R, 'tree_no_edge', { from: '—', to: nodeId });
      var L = latestOf(P.tree, B, scope, nodeId), exc = !!R.exceptionOf[nodeId];
      var j = canStart(B, scope, nodeId);
      /* 리뷰 #4: 인스턴스 없지만 지금 시작 가능 = 파생 'ready'(대기, derived:true) — 잠금(locked)은 시작 불가일 때만 */
      return { ok: true, state: L ? L.state : (j.ok ? 'ready' : 'locked'), derived: !L, label: R.nodes[nodeId].label, code: codeOf(R, nodeId), name: nameOf(R, nodeId), iter: L ? L.iter : 1, stepKey: L ? L.stepKey : nodeId, entered: !!(exc && L), exception: exc, terminalNode: !!R.terminal[nodeId],
               skippable: skippable(R, nodeId), maxRepeat: maxRepeatOf(R, nodeId), instance: clone(L), canStart: { ok: !!j.ok, why: j.ok ? '' : j.why, msg: j.ok ? '' : j.msg } };
    }
    function nextDue(batchId, scope) {
      var P = pre(batchId, scope, { allowHeld: true, noLegacyAudit: true, read: true }); if (P.r) return P.r;
      if (heldOf(P.tree, P.batchId)) return { ok: true, nodeId: null, stepKey: null };
      var n = nextDue0(P); return { ok: true, nodeId: n.nodeId, stepKey: n.stepKey, label: n.nodeId ? P.R.nodes[n.nodeId].label : null, name: n.nodeId ? nameOf(P.R, n.nodeId) + (n.iter > 1 ? ' #' + n.iter : '') : null };
    }
    /** interlockAdapter — IL-EX-SEQ · IL-PK-SEQ (step.sequence) 판정 위임 (X1). 판정 중 예외 = 적중(fail-closed) */
    function interlockAdapter(ctx) {
      ctx = ctx || {};
      if (!str(ctx.batchId) || !str(ctx.nodeId)) return { hit: false, na: true };
      var r; try { r = canStart(ctx.batchId, ctx.scope || 'prod', ctx.nodeId); } catch (e) { r = fail('tree_snapshot_missing'); }
      return r && r.ok ? { hit: false } : { hit: true, why: r ? r.why : 'tree_snapshot_missing', msg: r ? r.msg : WHY.tree_snapshot_missing };
    }
    /** migrateOpDone — 화면 키 ebr-prod-exec-v2 opDone 이관 (첫 진입 시 1회, 주 경로 앞에서부터 연속 완료분만) */
    function migrateOpDone(batchId, opDone) {
      var u = curUser(); if (!S()) return fail('no_session'); if (!u) return fail('no_current_user');
      var P = pre(batchId, 'prod', { noLegacyAudit: false }); if (P.r) return P.r;
      var tree = P.tree, R = P.R, B = P.batchId;
      if (itemsOf(tree, B, 'prod').length) return { ok: true, migrated: 0 };
      opDone = opDone || {}; var done = [], at = nowIso(), prev = null;
      for (var i = 0; i < R.main.length; i++) {
        var id = R.main[i]; if (opDone[id] !== true) break;
        var it = newInst(tree, B, 'prod', id, 1, 'done', { edgeFrom: prev, edgeType: 'migrated' }); it.doneAt = at; it.doneBy = u.userId; it.migrated = true; it.signatureIds = stepSigIds(B, 'prod', it.stepKey);
        done.push(id); prev = id;
      }
      if (!done.length) return { ok: true, migrated: 0 };
      if (R.main[done.length]) newInst(tree, B, 'prod', R.main[done.length], 1, 'ready', { edgeFrom: prev, edgeType: 'seq' });
      return commit(tree, [{ act: 'TREE_STEP_DONE', tgt: B + ' · 화면 키 이관', val: '이관 ' + done.length + '건 · ' + done.join(', '), batchId: B }]) ? { ok: true, migrated: done.length, nodes: done } : fail('save_error');
    }

    return { VERSION: 1, STUB: false, KEYS: clone(KEYS), SCOPES: SCOPES.slice(), STATES: STATES.slice(), WHY: clone(WHY), WHY_EXT: WHY_EXT.slice(),
             MSG: clone(MSG), SIGN_RULES: clone(SIGN_RULES), AUDIT_ACTS: AUDIT_ACTS.slice(),
             DEFAULT_MAX_REPEAT: DEFAULT_MAX_REPEAT, REASON_MAX: REASON_MAX, BLOCK_DEDUP_MS: BLOCK_DEDUP_MS,
             stepKeyOf: stepKeyOf, parseStepKey: parseStepKey, msgFor: msgFor,
             route: route, canStart: canStart, start: start, complete: complete,
             enterException: enterException, commitRoute: commitRoute, skip: skip, commitSkip: commitSkip,
             repeat: repeat, commitRepeat: commitRepeat, cancel: cancel,
             requiredNodes: requiredNodes, list: list, rowState: rowState, nextDue: nextDue, interlockAdapter: interlockAdapter,
             migrateOpDone: migrateOpDone, create: create };
  }

  var API = create({});
  global.EbrTreeExec = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
