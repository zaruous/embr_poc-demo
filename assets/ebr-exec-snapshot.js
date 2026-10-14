/**
 * ebr-exec-snapshot.js — Process Design → Execution P0 (D1)
 * Spec: docs/design/poc/docs/poc-process-design-to-execution.md
 *       docs/design/poc/docs/poc-process-design-to-execution-ui-items.md (UI-01~04)
 *
 * Exports window.EbrExecSnapshot:
 *   normalizePhaseList(nodes, procedure, edges) → phaseList[]
 *   buildExecSnapshot(tree) → { nodes, edges, phaseList, … }
 *   enrichFreezeSnapshot(freeze, tree) → freeze with snapshot.phaseList/nodes/edges
 *   buildPhasesFromSnapshot(rec) → PHASES_TMPL-shaped array or null
 *     (step += nodeId, phaseRef, eqClass, isWeigh — 칭량 E4 게이트용)
 *   isWeighPhase(phase, node) → boolean
 *   formatPhaseListSummary(phaseList, maxLen)
 *   getPhaseList(rec)
 *   sessionMatchesOpOrder(saved, opOrder)
 *
 * Does NOT recompute contentHash or touch STATUS_TRANSITIONS.
 * tree-designer.js freezeForIssue left unchanged (D4 file); enrich at issue call-site.
 */
(function (global) {
  'use strict';

  function clone(o) {
    try { return JSON.parse(JSON.stringify(o)); } catch (e) { return o; }
  }

  function nodeIdOf(n) {
    return n && (n.nodeId || n.id) || '';
  }

  /**
   * Build ordered phaseList from tree nodes + procedure (preferred) or seq edges.
   * Each entry: { id, name, kind, up, upName, op, opName, seq }
   */
  function normalizePhaseList(nodes, procedure, edges) {
    nodes = Array.isArray(nodes) ? nodes : [];
    edges = Array.isArray(edges) ? edges : [];
    var byId = {};
    nodes.forEach(function (n) {
      var id = nodeIdOf(n);
      if (id) byId[id] = n;
    });
    var list = [];
    var seq = 0;
    var seen = {};

    function pushPhase(pid, up, op) {
      if (!pid || seen[pid]) return;
      var n = byId[pid];
      if (!n) return;
      if (n.type && n.type !== 'phase') return;
      seen[pid] = true;
      seq += 1;
      list.push({
        id: pid,
        name: n.label || n.name || pid,
        kind: n.kind || '',
        up: (up && up.id) || '',
        upName: (up && up.name) || '',
        op: (op && op.id) || '',
        opName: (op && op.name) || '',
        seq: seq
      });
    }

    var ups = procedure && Array.isArray(procedure.unitProcedures) ? procedure.unitProcedures : null;
    if (ups && ups.length) {
      ups.forEach(function (up) {
        (up.operations || []).forEach(function (op) {
          (op.phases || []).forEach(function (pid) { pushPhase(pid, up, op); });
        });
      });
      if (list.length) return list;
    }

    /* Fallback: walk seq edges from roots, then leftover phase nodes by id */
    var seqEdges = edges.filter(function (e) {
      return !e.type || e.type === 'seq';
    });
    var targets = {};
    seqEdges.forEach(function (e) { if (e.to) targets[e.to] = true; });
    var roots = nodes.filter(function (n) {
      var id = nodeIdOf(n);
      return id && (!n.type || n.type === 'phase') && !targets[id];
    }).map(nodeIdOf);
    if (!roots.length) {
      roots = nodes.filter(function (n) { return !n.type || n.type === 'phase'; }).map(nodeIdOf);
      roots.sort();
    }
    var nextMap = {};
    seqEdges.forEach(function (e) {
      if (e.from && e.to && !nextMap[e.from]) nextMap[e.from] = e.to;
    });
    roots.forEach(function (start) {
      var cur = start;
      var guard = 0;
      while (cur && !seen[cur] && guard++ < 200) {
        pushPhase(cur, null, null);
        cur = nextMap[cur] || (byId[cur] && byId[cur].nextStep) || '';
      }
    });
    nodes.forEach(function (n) {
      if (!n.type || n.type === 'phase') pushPhase(nodeIdOf(n), null, null);
    });
    return list;
  }

  /** Full exec snapshot blob for freeze / batchRec.snapshot */
  function buildExecSnapshot(tree) {
    tree = tree || {};
    var nodes = clone(tree.nodes || []);
    var allEdges = clone(tree.edges || []);
    var edges = allEdges.filter(function (e) { return !e.type || e.type === 'seq'; });
    /* 프로세스 트리 실행 T1-01: 예외 간선을 버리지 않고 별도 배열로 (seq 배열 · 트리 contentHash 그대로). 이 필드가 없는 발행 기록 = 레거시 */
    var exceptionEdges = allEdges.filter(function (e) { return e && e.type === 'exception'; });
    var phaseList = normalizePhaseList(nodes, tree.procedure, allEdges);
    return sealExec({
      processTreeId: tree.id || tree.processTreeId || '',
      ver: tree.ver != null ? tree.ver : '',
      contentHash: tree.contentHash || tree.hashFull || '',
      nodes: nodes,
      edges: edges,
      exceptionEdges: exceptionEdges,
      phaseList: phaseList
    });
  }

  /**
   * UI-01 equivalent without editing tree-designer.js:
   * attach nodes/edges/phaseList onto freeze.snapshot (pin fields preserved).
   */
  function enrichFreezeSnapshot(freeze, tree) {
    if (!freeze || !freeze.ok || !freeze.snapshot) return freeze;
    var exec = buildExecSnapshot(tree || {});
    /* Keep freeze pin fields authoritative; only fill exec payload */
    freeze.snapshot.nodes = exec.nodes;
    freeze.snapshot.edges = exec.edges;
    freeze.snapshot.exceptionEdges = exec.exceptionEdges;
    freeze.snapshot.phaseList = exec.phaseList;
    /* 인터록 룰 세트 고정 (인터록 설계 §4 · I1-6): 정적 문자열 대신 실제 ruleSetFor 결과(id · ver · hash, 데모 모드면 ILR-DEMO 포함) */
    var IL = global.EbrInterlock;
    if (IL && typeof IL.freezeManifest === 'function') {
      var fm = IL.freezeManifest({});
      freeze.snapshot.manifest = Object.assign({}, freeze.snapshot.manifest || {}, { ILR: fm.ok ? fm.ILR : { error: fm.why } });
      if (!fm.ok) { freeze.ok = false; freeze.why = fm.why; freeze.message = fm.message; }   /* 규칙 세트를 못 읽으면 발행 불가 (fail-closed) */
    }
    sealExec(freeze.snapshot);   /* 봉인은 pin(트리 id · ver · contentHash) 반영 뒤 */
    return freeze;
  }

  /* 실행 봉인 (리뷰 X2): 실행에 쓰는 필드 전부(노드 · execRule · 간선 · 예외 간선 · phaseList · 트리 id/ver/contentHash)의 sha256.
     exceptionEdges 는 배열일 때만 포함(옛 봉인 = 레거시). 해시 모듈(EbrUserSession)이 없으면 '' → 실행 시 미검증으로 차단 */
  function execHashOf(sn) {
    var U = global.EbrUserSession; if (!sn || !U || typeof U.sha256Hex !== 'function' || typeof U.stableStringify !== 'function') return '';
    var o = { processTreeId: sn.processTreeId || '', ver: sn.ver != null ? String(sn.ver) : '', contentHash: sn.contentHash || '',
              nodes: sn.nodes || [], edges: sn.edges || [], phaseList: sn.phaseList || [] };
    if (Array.isArray(sn.exceptionEdges)) o.exceptionEdges = sn.exceptionEdges;
    return U.sha256Hex(U.stableStringify(o));
  }
  function sealExec(sn) { if (sn) sn.execHash = execHashOf(sn); return sn; }
  /** 'ok' | 'unverified'(봉인 없음) | 'mismatch' */
  function verifyExec(rec) {
    var sn = rec && (rec.snapshot || rec); if (!sn || !sn.execHash) return 'unverified';
    var h = execHashOf(sn); return h && h === sn.execHash ? 'ok' : 'mismatch';
  }

  function getPhaseList(rec) {
    if (!rec) return [];
    if (rec.snapshot && Array.isArray(rec.snapshot.phaseList)) return rec.snapshot.phaseList;
    if (Array.isArray(rec.phaseList)) return rec.phaseList;
    return [];
  }

  function getSnapshotNodes(rec) {
    if (!rec) return [];
    if (rec.snapshot && Array.isArray(rec.snapshot.nodes)) return rec.snapshot.nodes;
    if (Array.isArray(rec.nodes)) return rec.nodes;
    return [];
  }

  /*
   * 칭량 Phase 판정 (weighing E4).
   * 1) phaseList.kind / node.kind / node.phaseKind 가 있으면 그 값 === 'weigh'
   * 2) 없으면 node.phaseRef 가 'PH-WEIGH' 계열 (Phase 라이브러리 PH-WEIGH-01 kind=weigh,
   *    MBR 시드 노드에는 kind 가 없음 — phaseRef 만 있음)
   */
  var WEIGH_PHASE_REF = /^PH-WEIGH(-|$)/i;
  function isWeighPhase(p, node) {
    p = p || {};
    node = node || {};
    var kind = p.kind || node.kind || node.phaseKind || '';
    if (kind) return String(kind).toLowerCase() === 'weigh';
    return WEIGH_PHASE_REF.test(String(node.phaseRef || ''));
  }

  /**
   * PHASES_TMPL-isomorphic structure for production board.
   * Each UP: { up: 'UP-10 Seed Train', steps: [{ id, name, kind:'op', opIdx, meta, phaseKind, eq, eqName,
   *   nodeId, phaseRef, eqClass, isWeigh }] }
   * eq/eqName 은 보드 칩 표시용이라 비워 둔다(화면 표시 변경 없음).
   * 설비 게이트는 eqClass(= node.equipmentClassRef), 칭량 완료 게이트는 isWeigh 를 쓴다.
   */
  function buildPhasesFromSnapshot(rec) {
    var pl = getPhaseList(rec);
    if (!pl.length) return null;
    var nodeById = {};
    getSnapshotNodes(rec).forEach(function (n) {
      var nid = nodeIdOf(n);
      if (nid) nodeById[nid] = n;
    });
    var ups = [];
    var upMap = {};
    pl.forEach(function (p, i) {
      var node = nodeById[p.id] || {};
      var upKey = p.up || ('UP-' + String(i + 1));
      var upLabel = (p.up || upKey) + (p.upName ? ' ' + p.upName : '');
      if (!upMap[upKey]) {
        upMap[upKey] = { up: upLabel, steps: [] };
        ups.push(upMap[upKey]);
      }
      upMap[upKey].steps.push({
        id: p.id,
        name: p.name || p.id,
        kind: 'op',
        opIdx: (p.seq != null ? p.seq : (i + 1)) - 1,
        meta: p.kind ? ('kind=' + p.kind) : '대기',
        phaseKind: p.kind || '',
        eq: '',
        eqName: '',
        op: p.op || '',
        opName: p.opName || '',
        nodeId: p.id,
        phaseRef: node.phaseRef || '',
        eqClass: node.equipmentClassRef || node.eqClass || '',
        isWeigh: isWeighPhase(p, node)
      });
    });
    return ups.length ? ups : null;
  }

  function formatPhaseListSummary(phaseList, maxLen) {
    maxLen = maxLen == null ? 96 : maxLen;
    phaseList = Array.isArray(phaseList) ? phaseList : [];
    if (!phaseList.length) return '';
    var parts = phaseList.map(function (p) {
      return (p.id || '') + (p.name ? ' ' + p.name : '');
    });
    var s = parts.join(' → ');
    if (s.length > maxLen) s = s.slice(0, maxLen - 1) + '…';
    return s;
  }

  function sessionMatchesOpOrder(saved, opOrder) {
    if (!saved || !saved.opDone || !Array.isArray(opOrder) || !opOrder.length) return false;
    var keys = Object.keys(saved.opDone);
    if (keys.length !== opOrder.length) return false;
    for (var i = 0; i < opOrder.length; i++) {
      if (!(opOrder[i] in saved.opDone)) return false;
    }
    return true;
  }

  /** 레거시 판별 (T1-01): 발행 스냅샷에 exceptionEdges 배열이 없으면 true — 예외 경로 사용 불가(재발행 필요) */
  function isLegacySnapshot(rec) {
    var sn = rec && (rec.snapshot || rec);
    return !(sn && Array.isArray(sn.exceptionEdges));
  }

  global.EbrExecSnapshot = {
    isLegacySnapshot: isLegacySnapshot, execHashOf: execHashOf, sealExec: sealExec, verifyExec: verifyExec,
    normalizePhaseList: normalizePhaseList,
    buildExecSnapshot: buildExecSnapshot,
    enrichFreezeSnapshot: enrichFreezeSnapshot,
    buildPhasesFromSnapshot: buildPhasesFromSnapshot,
    isWeighPhase: isWeighPhase,
    formatPhaseListSummary: formatPhaseListSummary,
    getPhaseList: getPhaseList,
    sessionMatchesOpOrder: sessionMatchesOpOrder
  };
})(typeof window !== 'undefined' ? window : this);
