/* =====================================================================
   ebr-dispense-store.js — 칭량 · 디스펜싱 저장소 · 게이트 · 계획 (전역 EbrDispense, EbrP0.Dispense 별칭)
   - 칭량 P0 L1~L3 · L6(저울 시뮬레이터) · L7(큐 · 요약) · E6(계획) · E16(OP 완료 판정) · E17(자동 완료 기록).
     기획: poc-weighing-design.md §2 · §3 · §4 · §6 · §7 · §11 (개정 3), 결정 W1~W13 + 결정(2026-10-09) Q1~Q8
   - P0 칭량 값 출처는 SIM 만(수기 입력 거부), 서명자 = 서명 창 입력 ID(헬퍼 signerMode 'entered'), 현재 사용자 없으면 기록 · 서명 차단(C3)
   - 화면과 묶지 않는다: DOM · 화면 전역을 읽지 않는다. batchId · lineId (· dispenseId) 로만 조회 · 기록하므로
     생산 실행 화면과 칭량 전용 화면이 같은 API 를 쓴다.
   - 저장 키: ebr.dispense.v1 (이 파일 소유)
     읽기: ebr.batch.issued.v1 (snapshot.dispensePlan) · ebmr.masterSetup.v2 (장비 클래스 적격 목록, 없으면 내장본)
     함께 쓰기: ebr.materialLot.v1 (확인 완료 시 잔량 차감) · ebr.equipmentState.v1 (시드 · 일상 점검) · ebr.deviation.v1 (재이탈 일탈)
   - 서명 · 감사는 ebr-user-session.js (EbrUserSession) 를 쓴다 — 같은 Storage 를 써야 한다(브라우저: window.localStorage).
     계획 계산(buildDispensePlan) · 게이트 판정 · 상태표는 순수 함수라 헬퍼 없이도 동작한다.
   - 노드 테스트: CommonJS export 또는 EbrDispense.create({ storage, session, today }) 로 저장소 주입.
   - 비밀번호 값은 어디에도 남기지 않는다(헬퍼가 판정, 이 파일은 받지도 저장하지도 않는다).
   ===================================================================== */
(function (global) {
  'use strict';

  var KEYS = {
    DISPENSE: 'ebr.dispense.v1',
    ISSUED: 'ebr.batch.issued.v1',
    MAT: 'ebr.materialLot.v1',
    EQ: 'ebr.equipmentState.v1',
    DEV: 'ebr.deviation.v1',
    MASTER: 'ebmr.masterSetup.v2'
  };
  var MAX_ATTEMPTS = 2;               /* 결정 W8: 재칭량 1회 후 일탈 */
  var NEAR_LOT_DAYS = 30;             /* G7 (shared-store dueState 기본값) */
  var NEAR_CAL_DAYS = 7;              /* G11 */
  /* 칭량 값 출처 — P0 는 저울 시뮬레이터(L6) 값만 (설계 §11 Q2: 수기 입력 없음, GMP상 수기 입력은 일탈 경로) */
  var SOURCES = ['SIM'];
  var VOID_REASON_MAX = 60;   /* 폐기 · 취소 사유 최대 글자 수 (앞뒤 공백 제거 뒤 코드 포인트 기준) — 재칭량 승인 · 용기 취소 공통 */
  var RULES = { PERFORM: 'SM-PERF-WEIGH', VERIFY: 'SM-VERI-WEIGH', REWEIGH: 'SM-APPR-REWEIGH', VOID_REASON_MAX: VOID_REASON_MAX };

  /* 칭량 기록 조회(S-45) 상태 체크 묶음 — 화면이 상태 이름을 갖지 않게 store 상수로 (UI 아이템 J7) */
  var RECORD_STATE_GROUPS = { done: ['VERIFIED'], doing: ['TARED', 'WEIGHED', 'JUDGED', 'PERFORMED', 'REDO'], void: ['VOID'], wait: ['PLANNED', 'READY', 'BLOCKED', 'DEVIATION'] };
  /* 줄 상태 (기획 §4.4) · 전이표 — 표 밖 전이는 거부 */
  var STATES = ['PLANNED', 'BLOCKED', 'READY', 'TARED', 'WEIGHED', 'JUDGED', 'REDO', 'PERFORMED', 'VERIFIED', 'DEVIATION', 'VOID'];
  var STATE_LABEL = { PLANNED: '대기', BLOCKED: '차단', READY: '준비', TARED: '용기 전운', WEIGHED: '칭량', JUDGED: '판정', REDO: '재칭량',
                      PERFORMED: '확인 대기', VERIFIED: '완료', DEVIATION: '일탈', VOID: '취소' };
  var TRANSITIONS = {
    PLANNED: ['READY', 'BLOCKED'],
    BLOCKED: ['PLANNED'],
    READY: ['TARED', 'VOID'],
    TARED: ['WEIGHED', 'VOID'],
    WEIGHED: ['WEIGHED', 'JUDGED', 'VOID'],
    JUDGED: ['PERFORMED', 'VOID', 'DEVIATION'],
    REDO: ['TARED', 'VOID'],
    PERFORMED: ['VERIFIED'],
    VERIFIED: [],
    DEVIATION: [],
    VOID: []
  };
  var LABEL_STATES = { TARED: 1, WEIGHED: 1, JUDGED: 1, PERFORMED: 1, VERIFIED: 1 };
  var VOIDABLE = { READY: 1, TARED: 1, WEIGHED: 1, JUDGED: 1, REDO: 1 };

  /* 사전 게이트 G1~G16 (기획 §3) — G17 은 P1 */
  var GATES = [
    ['G1', 'WG_NO_SNAPSHOT', '발행 스냅샷 · 칭량 계획'], ['G2', 'WG_LOT_NOT_RESERVED', '예약 LOT'], ['G3', 'WG_MAT_MISMATCH', '자재 일치'],
    ['G4', 'WG_LOT_NOT_RELEASED', 'LOT 적합'], ['G5', 'WG_LOT_RETEST_PASSED', '재시험일'], ['G6', 'WG_LOT_EXPIRED', '유효기간'],
    ['G7', 'WG_LOT_DATE_NEAR', '날짜 임박'], ['G8', 'WG_LOT_SHORT', 'LOT 잔량'], ['G9', 'WG_BAL_STATE', '저울 상태'],
    ['G10', 'WG_BAL_CAL_EXPIRED', '저울 교정'], ['G11', 'WG_BAL_CAL_DUE_SOON', '교정 임박'], ['G12', 'WG_BAL_DAILY_CHECK', '일상 점검'],
    ['G13', 'WG_BAL_RANGE', '저울 용량'], ['G14', 'WG_BAL_NOT_QUALIFIED', '저울 적격'], ['G15', 'WG_ROOM_NOT_CLEAN', '칭량실'],
    ['G16', 'WG_DEV_OPEN', '열린 칭량 일탈']
  ];
  var GATE_CODE = {}; GATES.forEach(function (g) { GATE_CODE[g[0]] = g[1]; });
  var WARN_GATES = { G7: 1, G11: 1 };

  /* 장비 클래스 적격 목록 내장본 (shared-store.js EC-BAL-01 v3 · EC-BAL-02 v2 members) — 마스터 키가 없을 때만 */
  var BUILTIN_QUALIFIED = { 'EC-BAL-01': ['BAL-101', 'BAL-102', 'BAL-205'], 'EC-BAL-02': ['BAL-301', 'BAL-302'] };
  /* 저울 클래스 용량 (결정 W12 용량 규칙 — 줄 balanceClass 가 없을 때 지시량에 맞는 가장 작은 클래스) · 시뮬레이터 표시 단위 */
  var CLASS_CAPACITY = [
    { eqClass: 'EC-BAL-01', capMin: 0.01, capMax: 6, readability: 0.001 },
    { eqClass: 'EC-BAL-02', capMin: 1, capMax: 300, readability: 0.01 }
  ];

  /* 설비 런타임 시드 (기획 §6 · 결정 W9 · W12 · W13). 구역 = RAS 시드.
     교정일(2026-10-09 후속): 고정 날짜 대신 시드하는 날(store today) + calDays — calDue = today + calDays (equipSeedFor 가 계산)
       BAL-101 · BAL-102 · BAL-301 +134일(경고 없음), BAL-205 +3일(G11 교정 임박 경고 데모 W13, 7일 이내), BAL-302 -9일(G10 교정 만료 차단 데모 W12, 상태 READY)
     오래 둔 시드의 날짜가 지나면 저장소를 비워 다시 시드할 것 (기존 행은 calDue 키가 없을 때만 채움)
     배정 역할 assignRole (설계 C12 나눠 칭량, 디자인 리뷰): BAL-101 · BAL-102 = 'standby'(예비 — 다른 칭량실에 쓸 수 있는 주 저울이 있으면 기본 배정하지 않음),
       나머지 = 'primary'. 키 없으면 primary. 기존 행은 seedEquipment 의 빈 칸 채움 규칙 그대로 보충 → API · LAC = R-201 BAL-301, MGS = R-202 BAL-205 */
  var EQUIP_SEED = [
    { equipmentId: 'BAL-101', kind: 'balance', eqClass: 'EC-BAL-01', status: 'READY', calDays: 134, assignRole: 'standby', capMin: 0.01, capMax: 6, roomId: 'R-201', note: '정밀 저울 #101' },
    { equipmentId: 'BAL-102', kind: 'balance', eqClass: 'EC-BAL-01', status: 'READY', calDays: 134, assignRole: 'standby', capMin: 0.01, capMax: 6, roomId: 'R-202', note: '정밀 저울 #102' },
    { equipmentId: 'BAL-205', kind: 'balance', eqClass: 'EC-BAL-01', status: 'CLEANED', calDays: 3, assignRole: 'primary', capMin: 0.01, capMax: 6, roomId: 'R-202', note: '정밀 저울 #205 (교정 임박 데모 W13)' },
    { equipmentId: 'BAL-301', kind: 'balance', eqClass: 'EC-BAL-02', status: 'READY', calDays: 134, assignRole: 'primary', capMin: 1, capMax: 300, roomId: 'R-201', note: '플로어 저울 #301' },
    { equipmentId: 'BAL-302', kind: 'balance', eqClass: 'EC-BAL-02', status: 'READY', calDays: -9, assignRole: 'primary', capMin: 1, capMax: 300, roomId: 'R-202', note: '플로어 저울 #302 (교정 만료 데모 W12)' },
    { equipmentId: 'R-201', kind: 'room', status: 'READY', note: '칭량실 1' },
    { equipmentId: 'R-202', kind: 'room', status: 'READY', note: '칭량실 2' },
    { equipmentId: 'MX-01', status: 'READY', note: '습식혼합기' },
    { equipmentId: 'ML-03', status: 'READY', note: '정립기' },
    { equipmentId: 'TP-02', status: 'READY', note: '로터리 타정기 02' },
    { equipmentId: 'PK-01', status: 'READY', note: 'PTP 포장기 #1' }
  ];
  function addDaysYmd(ymd, n) { var a = ymdToUtc(ymd); if (isNaN(a)) return null; var d = new Date(a + n * 86400000); return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()); }
  /* 시드 행(calDays → calDue, 키 순서 유지) */
  function equipSeedFor(t) {
    return EQUIP_SEED.map(function (s) {
      var o = {};
      Object.keys(s).forEach(function (k) { if (k === 'calDays') o.calDue = addDaysYmd(t, s.calDays); else o[k] = s[k]; });
      return o;
    });
  }
  var USABLE = { READY: 1, CLEANED: 1 };
  /* 칭량실 단말 시드 — S-40 단말 레지스트리 시드(master-setup/assets/shared-store.js 의 T-WB-01 · T-WB-02)와 같은 값.
     ebr.equipmentState.v1 의 terminals[] 에 둔다(items[] 는 설비 사용 게이트 · 설비 화면 목록 대상이라 섞지 않음).
     S-40 저장소(ebmr.masterSetup.v2 의 terminal[])가 있으면 terminalsInRoom 은 그쪽을 먼저 읽는다 */
  var TERMINAL_SEED = [
    { terminalId: 'T-WB-01', roomId: 'R-201', line: 'L-01', type: 'fixed_panel', model: 'Advantech PPC-321', online: 'online', status: 'effective', authMethod: 'AM-RFID-BAND', reader: 'RFID-WB01', note: '칭량실 1 고정 패널' },
    { terminalId: 'T-WB-02', roomId: 'R-202', line: 'L-02', type: 'fixed_panel', model: 'Advantech PPC-321', online: 'online', status: 'effective', authMethod: 'AM-RFID-BAND', reader: 'RFID-WB02', note: '칭량실 2 고정 패널' }
  ];
  var MASTER_KEY = 'ebmr.masterSetup.v2';
  /* 생산 실행 세션 키는 공용 P0 저장소 상수 EbrP0.PROD_SESS_KEY 를 쓴다(이 파일에 화면 키를 박지 않음) — 세션은 한 번에 배치 1건 */
  var PROD_TEMPLATE_STEPS = ['OP1-1', 'OP1-2', 'OP2-1', 'OP2-2', 'OP3-1', 'OP3-2', 'OP4-1'];   /* 생산 화면 데모 템플릿 OP_ORDER_FALLBACK, 칭량 = OP1-1 */
  var WEIGH_PHASE_REF = /^PH-WEIGH(-|$)/i;   /* ebr-exec-snapshot.js isWeighPhase 와 같은 규칙 */

  /* 데모 배치 (MBR-TAB-A 3.2 트리) — 발행 경로와 같은 applyPlanToBatch 로 계획을 만든다.
     ID 는 발행 순번(BR-YYYY-NNNN)과 겹치지 않는 BR-DEMO-0001 (결정 (가): 실제 첫 발행 번호와의 충돌 · 칭량 기록 이월 방지).
     ebr.batch.issued.v1 에는 쓰지 않고 ebr.dispense.v1 의 demoBatch 에 1회 고정. 같은 ID 의 실제 발행 레코드가 있으면 그쪽이 우선 */
  var DEMO_BATCH_ID = 'BR-DEMO-0001';
  var DEMO_BATCH = {
    batchId: DEMO_BATCH_ID, size: 100, uom: 'kg', orderNo: null, product: '정제 A 10 mg', processTreeId: 'MBR-TAB-A', ver: '3.2',
    contentHash: '9f3a7c1e4d2b8a0f6e1c9d7b5a3f2e1d', source: 'demo-seed', demoSeed: true,
    snapshot: {
      kind: 'demo-seed', processTreeId: 'MBR-TAB-A', ver: '3.2',
      nodes: [
        { nodeId: 'N-010', type: 'phase', label: '원료 칭량', phaseRef: 'PH-WEIGH-01', equipmentClassRef: 'EC-BAL-02',
          materials: [{ materialId: 'MAT-API', tolPct: 0.5, balanceClass: 'EC-BAL-02' }, { materialId: 'MAT-LAC', tolPct: 0.5, balanceClass: 'EC-BAL-02' }, { materialId: 'MAT-MGS', tolPct: 1.0, balanceClass: 'EC-BAL-01' }] },
        { nodeId: 'N-020', type: 'phase', label: '혼합', phaseRef: 'PH-MIX-01', equipmentClassRef: 'EC-MIX-01' },
        { nodeId: 'N-030', type: 'phase', label: '타정 · IPC', phaseRef: 'PH-TAB-01', equipmentClassRef: 'EC-TAB-01' },
        { nodeId: 'N-040', type: 'phase', label: 'PTP 포장', phaseRef: 'PH-PKG-01', equipmentClassRef: 'EC-PKG-01' }
      ],
      phaseList: [
        { id: 'N-010', name: '원료 칭량', op: 'OP-10', seq: 1, kind: 'weigh' }, { id: 'N-020', name: '혼합', op: 'OP-20', seq: 2 },
        { id: 'N-030', name: '타정 · IPC', op: 'OP-30', seq: 3 }, { id: 'N-040', name: 'PTP 포장', op: 'OP-40', seq: 4 }
      ]
    }
  };
  var DEMO_BOM = [
    { name: '주성분 API', materialId: 'MAT-API', lot: 'API-2409', reserved: true, pct: 20, tolPct: 0.5 },
    { name: '유당', materialId: 'MAT-LAC', lot: 'LAC-2411', reserved: true, pct: 79, tolPct: 0.5 },
    { name: '스테아르산Mg', materialId: 'MAT-MGS', lot: 'MGS-2403', reserved: true, pct: 1, tolPct: 1.0 }
  ];

  var MSG = {
    no_plan: '칭량 계획 없음, 재발행 필요',
    no_batch: '발행 배치를 찾을 수 없습니다 — 배치 발행 후 다시 진입하세요.',
    demo_batch: '데모 배치에서는 칭량 기록을 남길 수 없습니다 — 발행 스냅샷으로 진입하세요.',
    no_line: '칭량 계획에 없는 줄입니다.',
    no_session: '사용자 · 서명 헬퍼(ebr-user-session.js)가 로드되지 않았습니다.',
    no_current_user: '사용자를 선택하세요 — 상단 사용자 선택기에서 현재 사용자를 고른 뒤 다시 시도하세요.',
    manual_not_allowed: '수기 입력은 P0 에서 받지 않습니다 — 저울(시뮬레이터) 값만 기록합니다.',
    unstable: '저울 값이 안정되지 않았습니다 — 안정 표시 뒤 기록하세요.',
    save_error: '저장하지 못했습니다 — 상태는 바뀌지 않았습니다. 저장 공간을 확인한 뒤 다시 시도하세요.',
    label_required: '판정 적합 뒤 라벨을 출력(또는 재출력)한 다음 확인 서명하세요.',
    reprint_why: '라벨 재출력 사유를 입력하세요.',
    void_why: '용기 취소 사유를 입력하세요.',
    void_reason_required: '폐기 사유를 입력하세요 — 재칭량 승인은 폐기 사유와 승인 서명을 함께 받습니다.',
    reason_too_long: '사유는 ' + VOID_REASON_MAX + '자 이내로 입력하세요.',
    oot_requires_reweigh: '허용 범위 밖 판정은 취소할 수 없습니다 — 재칭량 승인(또는 일탈)으로 처리하세요.',
    record_changed: '칭량 기록이 서명 창을 연 뒤 바뀌었습니다 — 서명 창을 닫고 다시 여세요.',
    lot_short_verify: 'LOT 잔량이 순중량보다 적어 확인할 수 없습니다 — 자재 QC 잔량을 확인하세요.',
    regate_required: '재칭량은 게이트(LOT · 저울 · 칭량실)를 다시 통과해야 전운을 기록할 수 있습니다 — 게이트 평가를 먼저 하세요.',
    balance_check_sign_required: '일상 점검 합격은 저울 일상 점검 화면에서 서명으로만 기록합니다 — 서명 없는 합격 표시는 받지 않습니다.'
  };

  /* ------------------------------------------------------------------ 순수 유틸 */
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function p2(n) { return (n < 10 ? '0' : '') + n; }
  function pad(n, w) { var s = String(n); while (s.length < w) s = '0' + s; return s; }
  function round(n, d) { var f = Math.pow(10, d); return Math.round((Number(n) + (Number(n) >= 0 ? 1e-9 : -1e-9)) * f) / f; }
  function round3(n) { return round(n, 3); }
  function num(v) { if (v === '' || v == null || typeof v === 'boolean') return NaN; var x = Number(v); return isFinite(x) ? x : NaN; }
  function str(v) { return String(v == null ? '' : v).trim(); }
  /* 글자 수 = 코드 포인트 수 (서로게이트 쌍 이모지 · 확장 한자 1자) */
  function charLen(s) { return Array.from(String(s == null ? '' : s)).length; }
  function localYmd(d) { d = d || new Date(); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); }
  function nowIsoLocal(d) {
    d = d || new Date();
    var off = -d.getTimezoneOffset(), sg = off >= 0 ? '+' : '-', a = Math.abs(off);
    return localYmd(d) + 'T' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()) + sg + p2(Math.floor(a / 60)) + ':' + p2(a % 60);
  }
  function ymdToUtc(s) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN; }
  /* 날짜(YYYY-MM-DD…) 까지 남은 일수 (오늘 = 0, 지남 = 음수). 날짜 없음/형식 오류 = null */
  function daysUntil(dateStr, today) {
    var a = ymdToUtc(today), b = ymdToUtc(dateStr);
    return isNaN(a) || isNaN(b) ? null : Math.round((b - a) / 86400000);
  }
  /* 화면 배지용: { days, state: 'none'|'ok'|'near'|'passed' } */
  function dateDue(dateStr, today, nearDays) {
    var d = daysUntil(dateStr, today);
    if (d == null) return { days: null, state: 'none' };
    return { days: d, state: d < 0 ? 'passed' : d <= (nearDays == null ? NEAR_LOT_DAYS : nearDays) ? 'near' : 'ok' };
  }
  function lotDateState(lot, today) {
    lot = lot || {};
    return { retest: dateDue(lot.retestDate, today, NEAR_LOT_DAYS), expiry: dateDue(lot.expiryDate, today, NEAR_LOT_DAYS) };
  }
  function canTransition(from, to) { return !!(TRANSITIONS[from] && TRANSITIONS[from].indexOf(to) >= 0); }
  function gateRow(g, ok, reason, gradeIfFail) {
    var def = GATES.filter(function (x) { return x[0] === g; })[0];
    return { gate: g, code: def[1], title: def[2], ok: !!ok, grade: ok ? 'ok' : (gradeIfFail || (WARN_GATES[g] ? 'Warning' : 'Absolute')), reason: ok ? '' : reason };
  }
  function summarizeGates(rows) {
    var blocked = rows.filter(function (r) { return !r.ok && r.grade === 'Absolute'; });
    var warnings = rows.filter(function (r) { return !r.ok && r.grade === 'Warning'; });
    return { total: rows.length, passed: rows.filter(function (r) { return r.ok; }).length, blocked: blocked, warnings: warnings };
  }
  function lotNoOf(x) { return x && typeof x === 'object' ? str(x.lotNo || x.lot) : str(x); }

  /* ------------------------------------------------------------------ 칭량 계획 (E6 · 결정: BOM 줄 = 계획 줄, 노드는 materialId 로 연결) */
  function isWeighNode(n) {
    if (!n) return false;
    var kind = str(n.kind || n.phaseKind).toLowerCase();
    if (kind) return kind === 'weigh';
    return /^PH-WEIGH(-|$)/i.test(str(n.phaseRef));
  }
  function nodeIdOf(n) { return str(n && (n.nodeId || n.id)); }
  /* 노드 자재 연결 (개정 3): materials:[{materialId, tolPct, balanceClass?}] 우선, 예전 스칼라 materialId · material.id 는 대체 */
  function nodeMaterialId(n) { return str(n && (n.materialId || (n.material && (n.material.id || n.material.materialId)))); }
  function nodeMaterialEntry(n, materialId) {
    if (!n) return null;
    var list = Array.isArray(n.materials) ? n.materials : [];
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      if (m && str(m.materialId || m.id) === materialId) return { materialId: materialId, tolPct: num(m.tolPct), balanceClass: str(m.balanceClass), via: 'materials' };
    }
    if (nodeMaterialId(n) === materialId) return { materialId: materialId, tolPct: nodeTolPct(n), balanceClass: str(n.balanceClass), via: 'scalar' };
    return null;
  }
  /* 결정 W12 용량 규칙: 지시량이 들어가는 클래스 중 최대 용량이 가장 작은 클래스 */
  function capacityClass(theoQty) {
    var q = num(theoQty);
    var fit = CLASS_CAPACITY.filter(function (c) { return q >= c.capMin && q <= c.capMax; }).sort(function (a, b) { return a.capMax - b.capMax; });
    return fit.length ? fit[0].eqClass : '';
  }
  /* 예전 스칼라 연결 노드의 tolPct (입력 항목 actual_kg.tolPct 는 쓰지 않음 — 개정 3) */
  function nodeTolPct(n) { return n ? num(n.tolPct) : NaN; }
  /* input = { batchId, size, uom?='kg', bom: [{ materialId?, materialName?|name, lot?|lots?, reserved?, pct, tolPct? }],
               nodes: [...] | snapshot: { nodes, phaseList }, matLots?: [MatQC lot…] (materialId 가 없는 BOM 줄 보충용) }
     → { ok, plan: [line], reservedLots: [{lotNo, materialId, qty, lineId}], errors: [{code, index, materialId, message}], warnings: [...] } */
  function buildDispensePlan(input) {
    input = input || {};
    var errors = [], warnings = [], plan = [];
    var snap = input.snapshot || {};
    var nodes = Array.isArray(input.nodes) ? input.nodes : (Array.isArray(snap.nodes) ? snap.nodes : []);
    var order = {};
    (Array.isArray(snap.phaseList) ? snap.phaseList : []).forEach(function (p, i) { order[str(p.id || p.nodeId)] = p.seq != null ? p.seq : i + 1; });
    var weighNodes = nodes.filter(isWeighNode)   /* 재칭량은 같은 줄의 새 시도(REDO 상태) — 별도 노드 없음 (E18) */
      .map(function (n, i) { return { n: n, o: order[nodeIdOf(n)] != null ? order[nodeIdOf(n)] : 1000 + i }; })
      .sort(function (a, b) { return a.o - b.o; }).map(function (x) { return x.n; });
    var size = num(input.size), uom = str(input.uom) || 'kg';
    var matLots = Array.isArray(input.matLots) ? input.matLots : [];
    var bom = Array.isArray(input.bom) ? input.bom : [];
    if (!(size > 0)) errors.push({ code: 'BAD_SIZE', index: null, materialId: '', message: '배치 크기가 없습니다.' });
    if (!bom.length) errors.push({ code: 'NO_BOM', index: null, materialId: '', message: 'BOM 줄이 없습니다.' });
    var opOf = {};
    (Array.isArray(snap.phaseList) ? snap.phaseList : []).forEach(function (p) { opOf[str(p.id || p.nodeId)] = str(p.op || p.opId); });
    bom.forEach(function (b, i) {
      b = b || {};
      var lotList = Array.isArray(b.lots) ? b.lots : (b.lot ? [{ lotNo: b.lot, reserved: b.reserved }] : []);
      var firstLot = lotList.length ? lotNoOf(lotList[0]) : '';
      var ml = matLots.filter(function (l) { return l && l.lotNo === firstLot; })[0] || null;
      var materialId = str(b.materialId) || (ml ? str(ml.materialId) : '');
      var materialName = str(b.materialName || b.name) || (ml ? str(ml.materialName) : '');
      function err(code, message) { errors.push({ code: code, index: i, materialId: materialId, message: message }); }
      if (!materialId) { err('NO_MATERIAL_ID', 'BOM ' + (i + 1) + '행 자재 ID 없음'); return; }
      var cand = weighNodes.map(function (n) { return { n: n, m: nodeMaterialEntry(n, materialId) }; }).filter(function (x) { return !!x.m; });
      if (!cand.length) { err('NO_WEIGH_NODE', materialId + ' 를 칭량하는 MBR 노드(materials[].materialId)가 없습니다.'); return; }
      if (cand.length > 1) warnings.push({ code: 'MULTI_NODE', index: i, materialId: materialId, message: materialId + ' 칭량 노드 ' + cand.length + '개 — 첫 노드 ' + nodeIdOf(cand[0].n) + ' 사용' });
      var node = cand[0].n, me = cand[0].m;          /* 한 노드를 여러 BOM 줄이 같이 쓰는 것은 정상 (N-010 = 3줄) */
      var pct = num(b.pct), theoQty = round3(size * pct / 100);
      if (!(theoQty > 0)) { err('BAD_QTY', materialId + ' 이론량이 0 이하입니다.'); return; }
      var tol = me.tolPct, tolSource = 'node';
      if (isNaN(tol)) { tol = num(b.tolPct); tolSource = 'bom'; }
      if (isNaN(tol) || tol < 0) { err('NO_TOLERANCE', materialId + ' 허용오차(tolPct)가 노드에도 BOM 에도 없습니다.'); return; }
      /* 줄 저울 클래스: ① materials[].balanceClass → ② 용량 규칙(W12) → ③ 노드 equipmentClassRef */
      var balanceClass = me.balanceClass, classSource = 'material';
      if (!balanceClass) { balanceClass = capacityClass(theoQty); classSource = 'capacity'; }
      if (!balanceClass) { balanceClass = str(node.equipmentClassRef); classSource = 'node'; }
      if (!balanceClass) { err('NO_BALANCE_CLASS', materialId + ' 저울 클래스를 정할 수 없습니다 (materials[].balanceClass · 용량 규칙 · 노드 equipmentClassRef 모두 없음).'); return; }
      var opId = opOf[nodeIdOf(node)] || '';
      var lots = lotList.filter(function (l) { return (l && typeof l === 'object') ? l.reserved === true : b.reserved === true; }).map(lotNoOf).filter(Boolean);
      if (!lots.length) warnings.push({ code: 'NO_RESERVED_LOT', index: i, materialId: materialId, message: materialId + ' 예약 LOT 없음 — 칭량 시 G2 차단' });
      plan.push({
        lineId: 'DL-' + pad(plan.length + 1, 2), nodeId: nodeIdOf(node), opId: opId, materialId: materialId, materialName: materialName,
        theoQty: theoQty, uom: uom, tolPct: tol, tolSource: tolSource,
        lo: round3(theoQty * (1 - tol / 100)), hi: round3(theoQty * (1 + tol / 100)),
        balanceClass: balanceClass, classSource: classSource, lots: lots, potency: null
      });
    });
    if (errors.length) plan = [];
    var reservedLots = [];
    plan.forEach(function (l) { l.lots.forEach(function (lot) { reservedLots.push({ lotNo: lot, materialId: l.materialId, qty: l.theoQty, lineId: l.lineId }); }); });
    return { ok: !errors.length, plan: plan, reservedLots: reservedLots, errors: errors, warnings: warnings };
  }
  /* 발행 화면 한 줄 연결용: batchRec(스냅샷 고정 직후) 에 snapshot.dispensePlan · reservedLots 를 넣은 복사본을 돌려준다.
     opts = { bom, size?, matLots? } → { ok, batchRec, plan, reservedLots, errors, warnings } (ok=false 면 batchRec 원본 복사본, 계획 없음) */
  function applyPlanToBatch(batchRec, opts) {
    opts = opts || {};
    var rec = clone(batchRec || {});
    var r = buildDispensePlan({ batchId: rec.batchId, size: opts.size != null ? opts.size : rec.size, uom: opts.uom, bom: opts.bom,
                                snapshot: rec.snapshot || {}, matLots: opts.matLots });
    if (r.ok) {
      rec.snapshot = rec.snapshot || {};
      rec.snapshot.dispensePlan = clone(r.plan);
      rec.reservedLots = clone(r.reservedLots);
    }
    return { ok: r.ok, batchRec: rec, plan: r.plan, reservedLots: r.reservedLots, errors: r.errors, warnings: r.warnings };
  }

  /* ------------------------------------------------------------------ 저울 시뮬레이터 (L6, P0 · 설계 §11 Q2) — 순수 함수, DOM 없음
     simulate(theoQty, mode, opts) → { ok, source:'SIM', mode, stable, tare, gross, net, value(=gross), uom, readability, devPct }
       mode: 'ok'(허용 범위 안) | 'oot'(밖) | 'unstable'(범위 안 값이지만 stable:false — 기록 불가)
       opts: { tolPct=0.5, tare?(없으면 0.5–2.0 kg), rand?: () => [0,1) (테스트 고정용), readability?, uom='kg' } */
  var SIM_MODES = ['ok', 'oot', 'unstable'];
  function simulate(theoQty, mode, opts) {
    opts = opts || {};
    var q = num(theoQty), m = str(mode || 'ok').toLowerCase();
    if (!(q > 0)) return { ok: false, why: 'bad_value', message: '지시량이 없습니다.' };
    if (SIM_MODES.indexOf(m) < 0) return { ok: false, why: 'bad_value', message: '시뮬레이터 모드는 ok · oot · unstable 입니다.' };
    var rnd = typeof opts.rand === 'function' ? opts.rand : Math.random;
    var tol = num(opts.tolPct); if (isNaN(tol) || tol <= 0) tol = 0.5;
    var cls = capacityClass(q), cap = CLASS_CAPACITY.filter(function (c) { return c.eqClass === cls; })[0];
    var rd = num(opts.readability); if (!(rd > 0)) rd = cap ? cap.readability : 0.001;
    function snap(v) { return round3(Math.round(v / rd) * rd); }
    var tare = num(opts.tare); if (isNaN(tare) || tare < 0) tare = snap(0.5 + rnd() * 1.5);
    var span = q * tol / 100, net;
    if (m === 'oot') { var sign = rnd() < 0.5 ? -1 : 1; net = q + sign * span * (1.5 + rnd()); }
    else net = q + (rnd() * 2 - 1) * span * 0.5;
    net = snap(net);
    if (m !== 'oot' && (net < round3(q - span) || net > round3(q + span))) net = snap(q);     /* 반올림으로 범위 밖에 걸치지 않게 */
    var gross = round3(tare + net);
    return { ok: true, source: 'SIM', mode: m, stable: m !== 'unstable', tare: round3(tare), gross: gross, net: round3(gross - tare), value: gross,
             uom: str(opts.uom) || 'kg', readability: rd, devPct: round((net - q) / q * 100, 2) };
  }

  /* ================================================================== 저장소 인스턴스 */
  function create(opts) {
    opts = opts || {};
    var failNextStage = null;
    function storage() { return opts.storage || global.localStorage; }
    function session() { return opts.session || global.EbrUserSession || null; }
    function today() { return typeof opts.today === 'function' ? opts.today() : (opts.today || localYmd()); }
    function nowIso() { return typeof opts.now === 'function' ? opts.now() : nowIsoLocal(); }
    function readRaw(k) { try { return storage().getItem(k); } catch (e) { return null; } }
    function readJson(k, fb) { var raw = readRaw(k); if (raw == null || raw === '') return fb; try { var o = JSON.parse(raw); return o == null ? fb : o; } catch (e) { return fb; } }
    function writeJson(k, obj, stage) {
      if (stage && failNextStage === stage) { failNextStage = null; throw new Error('저장 실패 주입 (' + stage + ')'); }
      storage().setItem(k, JSON.stringify(obj));
    }
    function restoreRaw(k, raw) { try { if (raw == null) storage().removeItem(k); else storage().setItem(k, raw); return true; } catch (e) { return false; } }
    function hashOf(o) { var S = session(); return S && S.computeValueHash ? S.computeValueHash(o) : ''; }
    /* 저울 일상 점검 store (EbrBalanceCheck) — 있으면 G12 문구 · 시드 · setDailyCheck 규칙에 쓴다. 없으면 지금과 같음(하위 호환).
       opts.balanceCheck: 인스턴스 또는 인스턴스를 돌려주는 함수(노드 시험 주입) */
    function balanceCheck() {
      var B = typeof opts.balanceCheck === 'function' ? opts.balanceCheck() : (opts.balanceCheck || global.EbrBalanceCheck);
      return B && typeof B.statusOf === 'function' ? B : null;
    }
    /* 저울 점검 사용 중 = store 로드됨 또는 그 저장 키(ebr.balanceCheck.v1)가 있음 — store 를 안 싣는 화면(설비 상태 등)에서도 G12 · 시드 규칙을 같게 */
    var BC_KEY = 'ebr.balanceCheck.v1';
    function balanceCheckActive() { return !!balanceCheck() || readRaw(BC_KEY) != null; }
    function bcGetCheck(id) {
      var B = balanceCheck(); if (B && typeof B.getCheck === 'function') return B.getCheck(id);
      var o = readJson(BC_KEY, null); return o && Array.isArray(o.checks) ? (o.checks.filter(function (c) { return c && c.checkId === id; })[0] || null) : null;
    }

    /* ---- 저장 형태 */
    function dsLoad() {
      var o = readJson(KEYS.DISPENSE, null);
      if (!o || typeof o !== 'object' || !Array.isArray(o.items)) o = { v: 1, items: [], seq: {} };
      if (!o.seq || typeof o.seq !== 'object') o.seq = {};
      o.v = 1;
      return o;
    }
    function matLoad() { var o = readJson(KEYS.MAT, null); if (!o || !Array.isArray(o.lots)) o = { v: 1, lots: [] }; return o; }
    function eqLoad() {
      var o = readJson(KEYS.EQ, null);
      if (!o) o = { v: 1, items: [] };
      if (Array.isArray(o)) o = { v: 1, items: o };
      if (!Array.isArray(o.items) && Array.isArray(o.equipment)) o.items = o.equipment;
      if (!Array.isArray(o.items)) o.items = [];
      return o;
    }
    function devLoad() { var o = readJson(KEYS.DEV, null); if (!o || !Array.isArray(o.items)) o = { v: 1, items: [] }; if (o.v == null) o.v = 1; return o; }
    function eqFind(items, id) { id = str(id); for (var i = 0; i < items.length; i++) { var it = items[i]; if (str(it.equipmentId || it.id || it.eqId) === id) return it; } return null; }
    function matGet(lotNo) { var n = str(lotNo); return matLoad().lots.filter(function (l) { return l && l.lotNo === n; })[0] || null; }

    /* ---- 발행 · 계획 */
    function getBatch(batchId) {
      var s = readJson(KEYS.ISSUED, null), list = Array.isArray(s) ? s : (s && Array.isArray(s.items) ? s.items : []);
      var bid = str(batchId);
      for (var i = 0; i < list.length; i++) { var b = list[i]; if (b && str(b.batchId || b.batchNo || b.id) === bid) return clone(b); }
      if (bid === DEMO_BATCH_ID) { var d = dsLoad().demoBatch; if (d) return clone(d); }
      return null;
    }
    /* 데모 배치 시드 (멱등): 없을 때만 applyPlanToBatch 로 계획을 만들어 ebr.dispense.v1.demoBatch 에 고정 */
    function seedDemoBatch() {
      var o = dsLoad();
      if (o.demoBatch && o.demoBatch.snapshot && Array.isArray(o.demoBatch.snapshot.dispensePlan) && o.demoBatch.snapshot.dispensePlan.length) return { ok: true, changed: false, batchId: DEMO_BATCH_ID };
      var r = applyPlanToBatch(clone(DEMO_BATCH), { bom: DEMO_BOM, matLots: matLoad().lots });
      if (!r.ok) return { ok: false, changed: false, why: 'plan_error', errors: r.errors, batchId: DEMO_BATCH_ID };
      r.batchRec.issuedAt = nowIso();
      o.demoBatch = r.batchRec;
      writeJson(KEYS.DISPENSE, o, 'dispense');
      return { ok: true, changed: true, batchId: DEMO_BATCH_ID, lines: r.plan.length, warnings: r.warnings };
    }
    /* 효력 프로세스 트리 시드 (멱등): TreeDesigner 가 로드된 화면(배치 발행 등)에서, 저장된 트리가 하나도 없을 때만
       TreeDesigner.seedTree() 를 효력(effective)으로 저장한다. 이미 있는 트리(초안 포함)는 건드리지 않음.
       contentHash 는 TreeDesigner.saveLocal 이 기존 방식대로 계산 */
    function seedEffectiveTree() {
      var TD = global.TreeDesigner;
      if (!TD || typeof TD.seedTree !== 'function' || typeof TD.saveLocal !== 'function' || typeof TD.loadLocal !== 'function') return { ok: true, changed: false, why: 'no_tree_designer' };
      if (TD.loadLocal()) return { ok: true, changed: false, why: 'exists' };
      var t = TD.seedTree();
      t.status = 'effective';
      /* 데모 시드 표지 (데모 설정: 승인 절차 생략). demoSeed · meta 는 contentHash 대상(canonicalContent) 밖이라 해시에 영향 없음 */
      t.demoSeed = true;
      t.meta = t.meta || {}; t.meta.seededBy = 'ensureSeeds'; t.meta.seededAt = nowIso(); t.meta.demoSeed = true;
      t.meta.note = '데모 시드 — 승인 절차(초안→검토→승인→효력 대기→효력) 생략 (데모 설정)';
      TD.saveLocal(t);
      var audited = false, S = session();
      if (S && S.Audit && typeof S.Audit.append === 'function') {
        try {
          S.Audit.append({ uid: 'SYSTEM', userName: '시스템 (데모 시드)', act: 'TREE_DEMO_SEED', why: 'demo_seed', tgt: t.id + ' v' + t.ver,
                           val: '효력 트리 데모 시드 · 승인 절차 생략 (데모 설정) · contentHash ' + String(t.contentHash || '').slice(0, 8),
                           before: null, after: { status: 'effective', demoSeed: true }, screen: 'ensureSeeds' });
          audited = true;
        } catch (eA) { /* 감사 저장 실패 — 트리 표지는 남음 */ }
      }
      return { ok: true, changed: true, treeId: t.id, ver: t.ver, contentHash: t.contentHash || null, demoSeed: true, audited: audited };
    }
    /* 공용 기본 시드 (멱등, 브라우저에서 저장소 로드 시 자동): 자재 QC LOT(MatQC.seedIfEmpty) → 설비 · 저울 · 칭량실(seedEquipment) → 효력 트리 → 데모 배치 */
    function ensureSeeds(o6) {
      o6 = o6 || {};
      var out = { ok: true, mat: false, equipment: null, tree: null, demoBatch: null };
      try {
        if (global.MatQC && typeof global.MatQC.seedIfEmpty === 'function' && !(matLoad().lots || []).length) { global.MatQC.seedIfEmpty({ today: today() }); out.mat = true; }
        else if (global.MatQC && typeof global.MatQC.backfillSeed === 'function') out.matBackfill = global.MatQC.backfillSeed({ today: today() });   /* 예전 시드 저장소: 없는 날짜 키만 보충 */
      } catch (e) { out.ok = false; out.matError = String(e && e.message || e); }
      var BC = balanceCheck();
      /* 저울 점검 store 가 있으면 기존 'SEED' 자동 합격을 끄고(dailyCheck:false) 점검 시드(seedDemo)가 dailyCheck 를 미러 — 시드 진입점은 여기 하나 */
      try { out.equipment = seedEquipment({ dailyCheck: o6.dailyCheck !== undefined ? o6.dailyCheck : (BC ? false : undefined) }); } catch (e2) { out.ok = false; out.equipmentError = String(e2 && e2.message || e2); }
      if (BC && typeof BC.seedDemo === 'function') { try { out.balanceCheck = BC.seedDemo({ today: today() }); if (!out.balanceCheck.ok) out.ok = false; } catch (e6) { out.ok = false; out.balanceCheckError = String(e6 && e6.message || e6); } }
      try { out.terminals = seedTerminals(); } catch (e5) { out.ok = false; out.terminalsError = String(e5 && e5.message || e5); }
      try { out.tree = seedEffectiveTree(); } catch (e4) { out.ok = false; out.treeError = String(e4 && e4.message || e4); }
      try { out.demoBatch = seedDemoBatch(); if (!out.demoBatch.ok) out.ok = false; } catch (e3) { out.ok = false; out.demoBatchError = String(e3 && e3.message || e3); }
      return out;
    }
    /* 계획 없는 발행(기존 발행 · 데모)은 fail-closed — 두 화면이 같은 판정을 쓴다 */
    function planOf(batchId) {
      var rec = getBatch(batchId);
      if (!rec) return { ok: false, why: 'no_batch', message: MSG.no_batch, batchId: str(batchId) };
      if (rec.demo === true || rec.demoMode === true) return { ok: false, why: 'demo_batch', message: MSG.demo_batch, batchId: str(batchId) };
      var plan = rec.snapshot && Array.isArray(rec.snapshot.dispensePlan) ? rec.snapshot.dispensePlan : null;
      if (!plan || !plan.length) return { ok: false, why: 'no_plan', message: MSG.no_plan, batchId: str(batchId) };
      var lines = clone(plan), opOf = {};
      ((rec.snapshot && rec.snapshot.phaseList) || []).forEach(function (ph) { opOf[str(ph.id || ph.nodeId)] = str(ph.op || ph.opId); });
      lines.forEach(function (l) { if (!l.opId) l.opId = opOf[str(l.nodeId)] || ''; });       /* 개정 전 계획: phaseList 로 보충 */
      return { ok: true, batchId: str(batchId), orderNo: rec.orderNo || null, batchRec: rec, lines: lines };
    }
    function planLine(p, lineId) { return p.lines.filter(function (l) { return l.lineId === lineId; })[0] || null; }

    /* ---- 게이트 판정 (L2 · L3) — 부작용 없음 */
    function qualifiedBalances(balanceClass) {
      var db = readJson(KEYS.MASTER, null), rows = db && (Array.isArray(db.eqclass) ? db.eqclass : Array.isArray(db.eqClass) ? db.eqClass : null);
      if (rows) {
        var eff = rows.filter(function (r) { return r && r.id === balanceClass && r.status === 'effective'; }).sort(function (a, b) { return (b.ver || 0) - (a.ver || 0); })[0];
        if (eff) return { source: 'master', ids: (eff.members || []).map(function (m) { return str(m.equipId || m.equipmentId); }).filter(Boolean) };
        if (rows.some(function (r) { return r && r.id === balanceClass; })) return { source: 'master', ids: [] };
      }
      return { source: 'builtin', ids: (BUILTIN_QUALIFIED[balanceClass] || []).slice() };
    }
    function usableState(rec, id, label) {
      if (!rec) return label + ' ' + id + ' 상태 없음 — 설비 상태를 등록하세요.';
      var st = str(rec.status || rec.state).toUpperCase();
      if (!USABLE[st]) return label + ' ' + id + ' 상태=' + (st || '—') + ' (READY/CLEANED 만 사용 가능)';
      if (rec.cleanHoldUntil) {
        var until = new Date(rec.cleanHoldUntil);
        if (!isNaN(until.getTime()) && until.getTime() < Date.now()) return label + ' ' + id + ' clean hold 만료 (' + rec.cleanHoldUntil + ')';
      }
      return '';
    }
    /* G2~G8 */
    function judgeLot(lotNo, line, o) {
      o = o || {}; line = line || {};
      var t = o.today || today(), n = str(lotNo), lot = matGet(n), rows = [];
      var lots = (line.lots || []).map(lotNoOf);
      rows.push(gateRow('G2', !!n && lots.indexOf(n) >= 0, n ? 'LOT ' + n + ' 는 계획 예약 LOT(' + (lots.join(', ') || '없음') + ')이 아닙니다.' : 'LOT 번호를 입력하세요.'));
      if (!lot) {
        var miss = 'LOT ' + (n || '—') + ' 자재 QC 미등록';
        ['G3', 'G4', 'G5', 'G6'].forEach(function (g) { rows.push(gateRow(g, false, miss)); });
        rows.push(gateRow('G7', true, ''));
        rows.push(gateRow('G8', false, miss));
        return rows;
      }
      rows.push(gateRow('G3', str(lot.materialId) === str(line.materialId), '자재 불일치 — LOT ' + n + ' = ' + (lot.materialId || '—') + ', 계획 = ' + (line.materialId || '—')));
      rows.push(gateRow('G4', str(lot.status) === 'released', '자재 QC 상태=' + (lot.status || '—') + ' (released 만 칭량 가능)'));
      var rd = daysUntil(lot.retestDate, t), ed = daysUntil(lot.expiryDate, t);
      rows.push(gateRow('G5', !(rd != null && rd < 0), '재시험일 경과 (' + lot.retestDate + ')'));
      rows.push(gateRow('G6', !(ed != null && ed < 0), '유효기간 경과 (' + lot.expiryDate + ')'));
      var near = [];
      if (rd != null && rd >= 0 && rd <= NEAR_LOT_DAYS) near.push('재시험일 ' + lot.retestDate + ' (' + rd + '일 남음)');
      if (ed != null && ed >= 0 && ed <= NEAR_LOT_DAYS) near.push('유효기간 ' + lot.expiryDate + ' (' + ed + '일 남음)');
      rows.push(gateRow('G7', !near.length, near.join(' · ')));
      var need = num(o.remainingQty != null ? o.remainingQty : line.theoQty), qty = num(lot.qty);
      rows.push(gateRow('G8', !isNaN(qty) && !isNaN(need) && qty >= need, 'LOT 잔량 ' + (isNaN(qty) ? '—' : qty) + ' ' + (line.uom || 'kg') + ' < 지시량 ' + (isNaN(need) ? '—' : need)));
      return rows;
    }
    /* G9~G14 */
    function judgeBalance(balanceId, o) {
      o = o || {};
      var t = o.today || today(), id = str(balanceId), rec = eqFind(eqLoad().items, id), rows = [];
      if (!id) {
        ['G9', 'G10', 'G12', 'G13', 'G14'].forEach(function (g) { rows.push(gateRow(g, false, '저울을 선택하세요.')); });
        rows.splice(2, 0, gateRow('G11', true, ''));
        return rows;
      }
      var isRoom = rec && str(rec.kind) === 'room';
      rows.push(gateRow('G9', !isRoom && !usableState(rec, id, '저울'), isRoom ? id + ' 는 칭량실입니다 — 저울을 고르세요.' : usableState(rec, id, '저울')));
      var cd = rec ? daysUntil(rec.calDue, t) : null;
      rows.push(gateRow('G10', cd != null && cd >= 0, cd == null ? '저울 ' + id + ' 교정일 정보 없음' : '저울 ' + id + ' 교정 만료 ' + rec.calDue + ' — 다른 저울을 고르세요.'));
      rows.push(gateRow('G11', !(cd != null && cd >= 0 && cd <= NEAR_CAL_DAYS), cd != null ? '저울 ' + id + ' 교정일 ' + rec.calDue + ' (' + cd + '일 남음)' : ''));
      var dc = rec && rec.dailyCheck;
      /* G12 판정 조건은 그대로(dailyCheck 오늘 · pass). 저울 점검 store 가 있으면 실패 문구만 '불합격 · 사용 금지' / '미점검'으로 나눔 (B1-3) */
      var g12ok = !!(dc && str(dc.date).slice(0, 10) === t && str(dc.result).toLowerCase() === 'pass');
      var g12why = '저울 ' + id + ' 오늘(' + t + ') 일상 점검 합격 기록 없음' + (dc && dc.date ? ' (마지막 ' + dc.date + ' ' + (dc.result || '') + ')' : ''), bst = null, BC = balanceCheck();
      /* 저울 점검 store 가 있으면 합격 표시만으로는 부족: 서명(signatureId) 또는 store 의 같은 저울 · 같은 날 합격 점검 기록(checkId — 시드 점검 포함)이 있어야 통과.
         store 가 없을 때만 예전 규칙(dailyCheck 오늘 · pass)으로 판정 — 하위 호환 */
      if (balanceCheckActive() && g12ok) {
        var ck = dc.checkId ? bcGetCheck(dc.checkId) : null;
        var backed = !!(ck && ck.balanceId === id && ck.date === t && ck.result === 'pass' && (!dc.signatureId || ck.signatureId === dc.signatureId));
        if (!backed) { g12ok = false; var unsignedPass = true; g12why = '저울 ' + id + ' 오늘(' + t + ') 합격 표시가 서명된 점검 기록과 맞지 않습니다(서명 없는 합격) — 저울 일상 점검(S-44)에서 점검하세요'; }
      }
      if (BC && !g12ok) {
        try { bst = BC.statusOf(id, t); } catch (eB) { bst = null; }
        if (unsignedPass) { /* 위 '서명 없는 합격' 문구 유지 */ } else if (bst && (bst.blocked || bst.state === 'fail')) {
          var la = bst.last || {};
          g12why = '저울 ' + id + ' 오늘(' + t + ') 일상 점검 불합격 · 사용 금지' + (bst.deviationId ? ' ' + bst.deviationId : '') +
                   (la.at ? ' (' + str(la.at).slice(11, 16) + (la.by ? ' ' + la.by : '') + ')' : '') + ' — 다른 저울 선택 또는 감독자 재점검';
        } else if (bst && bst.state === 'none') {
          g12why = '저울 ' + id + ' 오늘(' + t + ') 일상 점검 미점검' + (bst.lastPass ? ' (마지막 합격 ' + bst.lastPass.date + ')' : ' (합격 기록 없음)');
        }
      }
      var g12 = gateRow('G12', g12ok, g12why);
      if (bst) g12.detail = { state: bst.state, blocked: !!bst.blocked, deviationId: bst.deviationId || null, checkId: bst.checkId || null };
      rows.push(g12);
      var q = num(o.theoQty), mn = rec ? num(rec.capMin) : NaN, mx = rec ? num(rec.capMax) : NaN;
      rows.push(gateRow('G13', !isNaN(q) && !isNaN(mn) && !isNaN(mx) && q >= mn && q <= mx,
        isNaN(mn) || isNaN(mx) ? '저울 ' + id + ' 용량(capMin/capMax) 정보 없음' : '지시량 ' + (isNaN(q) ? '—' : q) + ' kg 이 저울 ' + id + ' 범위 ' + mn + ' – ' + mx + ' kg 밖'));
      var ql = qualifiedBalances(str(o.balanceClass));
      rows.push(gateRow('G14', !!o.balanceClass && ql.ids.indexOf(id) >= 0,
        '저울 ' + id + ' 은(는) ' + (o.balanceClass || '—') + ' 적격 목록(' + (ql.ids.join(', ') || '없음') + ')에 없습니다.'));
      return rows;
    }
    /* G15 */
    function judgeRoom(roomId) {
      var id = str(roomId);
      if (!id) return [gateRow('G15', false, '칭량실을 선택하세요.')];
      var rec = eqFind(eqLoad().items, id);
      var bad = rec && str(rec.kind) !== 'room' ? id + ' 는 칭량실(kind room)이 아닙니다.' : usableState(rec, id, '칭량실');
      return [gateRow('G15', !bad, bad)];
    }
    function openWeighDevs(batchId, line) {
      return devLoad().items.filter(function (d) {
        var st = str(d.status);
        return str(d.batchId) === str(batchId) && (st === 'draft' || st === 'open') && (d.source === 'weighing' || d.refType === 'dispense') &&
          /* 한 노드(N-010)를 여러 줄이 같이 쓰므로 일탈에 lineId 가 있으면 줄로만 맞춘다. lineId 없는 일탈만 노드로 */
          (d.lineId ? (!!line.lineId && d.lineId === line.lineId) : (!!line.nodeId && d.nodeId === line.nodeId));
      });
    }
    /* Weigh.gateCheck(planLine, lotNo, balanceId, roomId, opts{batchId, today}) → [{gate, code, title, ok, grade, reason}] × 16 */
    function gateCheck(line, lotNo, balanceId, roomId, o) {
      o = o || {}; line = line || {};
      var p = o.batchId ? planOf(o.batchId) : null;
      var rows = [gateRow('G1', !!(p && p.ok), p ? p.message : MSG.no_plan)];
      rows = rows.concat(judgeLot(lotNo, line, o), judgeBalance(balanceId, { today: o.today, theoQty: line.theoQty, balanceClass: line.balanceClass }), judgeRoom(roomId));
      var devs = o.batchId ? openWeighDevs(o.batchId, line) : [];
      rows.push(gateRow('G16', !devs.length, '열린 칭량 일탈 ' + devs.map(function (d) { return d.id; }).join(', ') + ' — QA 처분 대기'));
      return rows;
    }

    /* ---- 기록 · 줄 보기 */
    function lineRecords(o, batchId, lineId) { return o.items.filter(function (r) { return r.batchId === batchId && r.lineId === lineId; }); }
    function activeRec(recs) { var last = recs[recs.length - 1]; return last && last.state !== 'VOID' ? last : null; }
    function attemptNo(recs) { return 1 + recs.filter(function (r) { return r.state === 'VOID' && r.voidKind === 'reweigh'; }).length; }
    function labelAfterPass(rec) { return !!(rec && (rec.labels || []).some(function (l) { return l.afterPass; })); }
    function lineView(p, line, o) {
      var recs = lineRecords(o, p.batchId, line.lineId), cur = activeRec(recs);
      var v = clone(line);
      v.batchId = p.batchId;
      v.status = cur ? cur.state : 'PLANNED';
      v.statusLabel = STATE_LABEL[v.status];
      v.attempt = cur ? cur.attempt : attemptNo(recs);
      v.maxAttempts = MAX_ATTEMPTS;
      v.dispenseId = cur ? cur.dispenseId : null;
      v.current = cur ? clone(cur) : null;
      v.records = clone(recs);
      v.labelAfterPass = labelAfterPass(cur);
      v.labelCount = cur ? (cur.labels || []).length : 0;
      return v;
    }
    function listLines(batchId) {
      var p = planOf(batchId);
      if (!p.ok) return p;
      var o = dsLoad();
      return { ok: true, batchId: p.batchId, orderNo: p.orderNo, lines: p.lines.map(function (l) { return lineView(p, l, o); }) };
    }
    function getLine(batchId, lineId) {
      var p = planOf(batchId);
      if (!p.ok) return p;
      var line = planLine(p, lineId);
      if (!line) return { ok: false, why: 'no_line', message: MSG.no_line };
      return { ok: true, line: lineView(p, line, dsLoad()) };
    }
    function get(dispenseId) { var id = str(dispenseId); var r = dsLoad().items.filter(function (x) { return x.dispenseId === id; })[0]; return r ? clone(r) : null; }
    function getRecord(recId) { var r = dsLoad().items.filter(function (x) { return x.recId === recId; })[0]; return r ? clone(r) : null; }
    function listByBatch(batchId) { return dsLoad().items.filter(function (x) { return x.batchId === str(batchId); }).map(clone); }
    /* 배치 요약 (출하 게이트 #9 · KPI 용) */
    function summary(batchId) {
      var r = listLines(batchId);
      if (!r.ok) return { ok: false, why: r.why, message: r.message, total: 0, verified: 0, performed: 0, allVerified: false, openDeviations: 0 };
      var devs = devLoad().items.filter(function (d) { return str(d.batchId) === str(batchId) && (d.source === 'weighing' || d.refType === 'dispense') && (d.status === 'draft' || d.status === 'open'); });
      var ver = r.lines.filter(function (l) { return l.status === 'VERIFIED'; }).length;
      return { ok: true, total: r.lines.length, verified: ver, performed: r.lines.filter(function (l) { return l.status === 'PERFORMED'; }).length,
               allVerified: ver === r.lines.length, openDeviations: devs.length, byStatus: r.lines.map(function (l) { return { lineId: l.lineId, status: l.status }; }) };
    }

    /* ---- 칭량 기록 조회 (S-45 · 설계 §2.6, 읽기 전용 — setItem 없음) */
    function recOperators(r) {
      var ids = [];
      [r.tareBy, r.weighedBy, r.performed && r.performed.userId, r.verified && r.verified.userId, r.reweigh && r.reweigh.userId]
        .concat((r.grossHistory || []).map(function (h) { return h && h.by; }))
        .forEach(function (u) { u = str(u); if (u && ids.indexOf(u) < 0) ids.push(u); });
      return ids;
    }
    function recIntegrity(r) {
      if (!r || !r.recordHash) return 'n/a';
      var b = clone(r); delete b.recordHash;
      return hashOf(b) === r.recordHash ? 'match' : 'mismatch';
    }
    function recAt(r) { return str(r.updatedAt || r.createdAt); }
    function expandStates(st) {
      if (st == null || st === '') return null;
      var out = [];
      (Array.isArray(st) ? st : [st]).forEach(function (x) { x = str(x); (RECORD_STATE_GROUPS[x] || [x]).forEach(function (y) { if (out.indexOf(y) < 0) out.push(y); }); });
      return out.length ? out : null;
    }
    /* 시도 하나가 필터(상태 제외)에 맞는가 */
    function recMatch(r, f) {
      if (f.batchId && r.batchId !== str(f.batchId)) return false;
      if (f.lineId && r.lineId !== str(f.lineId)) return false;
      if (f.materialId && str(r.materialId).toUpperCase() !== str(f.materialId).toUpperCase()) return false;
      if (f.lotNo && str(r.lotNo).toUpperCase().indexOf(str(f.lotNo).toUpperCase()) < 0) return false;
      if (f.balanceId && str(r.balanceId).toUpperCase() !== str(f.balanceId).toUpperCase()) return false;
      if (f.dispenseId && str(r.dispenseId).toUpperCase() !== str(f.dispenseId).toUpperCase()) return false;
      if (f.operatorId) { var op = str(f.operatorId).toUpperCase(); if (!recOperators(r).some(function (u) { return u.toUpperCase() === op; })) return false; }
      var d = str(r.createdAt).slice(0, 10);
      if (f.from && d < str(f.from).slice(0, 10)) return false;
      if (f.to && d > str(f.to).slice(0, 10)) return false;
      if (f.fromTs) { var a = Date.parse(recAt(r)), b = Date.parse(str(f.fromTs)); if (!isNaN(b) && (isNaN(a) || a < b)) return false; }
      return true;
    }
    function recordRow(r) {
      var ops = recOperators(r);
      return { recId: r.recId, dispenseId: r.dispenseId || null, batchId: r.batchId, lineId: r.lineId, attempt: r.attempt, materialId: r.materialId, materialName: r.materialName || '',
               lotNo: r.lotNo || '', balanceId: r.balanceId || '', roomId: r.roomId || '', net: r.net, uom: r.uom || 'kg', judge: r.judge || null, state: r.state, stateLabel: STATE_LABEL[r.state] || r.state,
               voidKind: r.voidKind || null, createdAt: r.createdAt || '', updatedAt: r.updatedAt || '', at: recAt(r), operatorId: str(r.weighedBy || r.tareBy) || ops[0] || null, operatorIds: ops,
               integrity: recIntegrity(r) };
    }
    /* listRecords(filter) → { ok, total, rows }
       filter: batchId · lineId · materialId · lotNo(부분) · balanceId · dispenseId · operatorId(tareBy · weighedBy · grossHistory · performed · verified · reweigh, 대소문자 무시)
               · from · to (시도 createdAt 의 로컬 날짜 YYYY-MM-DD, 양 끝 포함) · fromTs (ISO — updatedAt(없으면 createdAt) ≥ fromTs, 영향 범위용)
               · state (상태 | 묶음 이름 RECORD_STATE_GROUPS | 배열) · includeVoid (record 단위: 기본 false = VOID 시도 제외, state 에 VOID 가 있으면 포함)
               · groupBy 'line'(기본 — 줄의 시도 중 하나라도 조건에 맞으면 그 줄, 값은 최신 시도) | 'record' · order 'desc'(기본) | 'asc' · offset · limit */
    function listRecords(filter) {
      var f = filter || {}, states = expandStates(f.state), byLine = f.groupBy !== 'record', asc = f.order === 'asc';
      var items = dsLoad().items, rows;
      if (byLine) {
        var groups = {}, keys = [];
        items.forEach(function (r) { var k = r.batchId + '\u0000' + r.lineId; if (!groups[k]) { groups[k] = []; keys.push(k); } groups[k].push(r); });
        rows = [];
        keys.forEach(function (k) {
          var chain = groups[k], last = chain[chain.length - 1];
          if (!chain.some(function (r) { return recMatch(r, f); })) return;
          if (states && states.indexOf(last.state) < 0) return;
          var ops = [], integ = 'n/a', upd = '';
          chain.forEach(function (r) {
            recOperators(r).forEach(function (u) { if (ops.indexOf(u) < 0) ops.push(u); });
            var g = recIntegrity(r); if (g === 'mismatch') integ = 'mismatch'; else if (g === 'match' && integ === 'n/a') integ = 'match';
            if (recAt(r) > upd) upd = recAt(r);
          });
          var withVal = chain.filter(function (r) { return r.lotNo || r.balanceId; }).slice(-1)[0] || last;
          rows.push({ batchId: last.batchId, lineId: last.lineId, materialId: last.materialId, materialName: last.materialName || '', lotNo: withVal.lotNo || '', balanceId: withVal.balanceId || '',
                      roomId: withVal.roomId || '', state: last.state, stateLabel: STATE_LABEL[last.state] || last.state, attempts: chain.length,
                      reweighed: chain.some(function (r) { return r.voidKind === 'reweigh'; }), voided: last.state === 'VOID', latestRecId: last.recId, dispenseId: last.dispenseId || null,
                      net: last.net, uom: last.uom || 'kg', judge: last.judge || null, operatorIds: ops, updatedAt: upd, integrity: integ });
        });
      } else {
        var wantVoid = f.includeVoid === true || (states && states.indexOf('VOID') >= 0);
        rows = items.filter(function (r) { return recMatch(r, f) && (wantVoid || r.state !== 'VOID') && (!states || states.indexOf(r.state) >= 0); }).map(recordRow);
      }
      var tk = function (r) { return byLine ? r.updatedAt : r.at; }, ik = function (r) { return byLine ? r.batchId + ' ' + r.lineId : r.recId; };
      rows.sort(function (a, b) { var x = tk(a), y = tk(b); if (x !== y) return (x < y ? -1 : 1) * (asc ? 1 : -1); return (ik(a) < ik(b) ? -1 : ik(a) > ik(b) ? 1 : 0) * (asc ? 1 : -1); });
      var total = rows.length, off = Math.max(0, parseInt(f.offset, 10) || 0), lim = parseInt(f.limit, 10);
      return { ok: true, total: total, rows: lim > 0 ? rows.slice(off, off + lim) : rows.slice(off) };
    }
    /* recordDetail(batchId, lineId) → { ok, line, attempts, chain, signatures, audits, rollbacks, balanceCheck, integrity } (읽기 전용)
       audits = 감사 중 tgt 가 '{dispenseId} · {batchId}' 또는 '{lineId} · {batchId}' 인 것(시각 순), rollbacks = 그중 *_ROLLBACK
       balanceCheck = 최신 시도 저울의 칭량 날짜 점검 상태(EbrBalanceCheck.statusOf, 없으면 null)
       integrity = 최신 시도 recordHash 재계산 · 수행 서명 레코드 valueHash ↔ 현재 값 해시 */
    function recordDetail(batchId, lineId) {
      var bid = str(batchId), lid = str(lineId);
      var chain = dsLoad().items.filter(function (r) { return r.batchId === bid && r.lineId === lid; });
      var p = planOf(bid), pl = p.ok ? planLine(p, lid) : null;
      if (!chain.length && !pl) return p.ok ? fail('no_line', MSG.no_line) : p;
      var last = chain[chain.length - 1] || null, S = session();
      var line = pl ? lineView(p, pl, dsLoad()) : { batchId: bid, lineId: lid, materialId: last.materialId, materialName: last.materialName || '', theoQty: last.theoQty, tolPct: last.tolPct, lo: last.lo, hi: last.hi,
                                                   uom: last.uom, balanceClass: last.balanceClass, status: last.state, statusLabel: STATE_LABEL[last.state] };
      var sigs = [];
      chain.forEach(function (r) {
        ['performed', 'verified', 'reweigh'].forEach(function (k) {
          var w = r[k]; if (!w || !w.signatureId) return;
          var e = { kind: k, recId: r.recId, attempt: r.attempt, signatureId: w.signatureId, userId: w.userId, name: w.name || '', at: w.at || '' };
          if (k === 'reweigh') e.reason = w.reason || r.voidReason || '';
          sigs.push(e);
        });
      });
      var tg = {}; tg[lid + ' · ' + bid] = true; chain.forEach(function (r) { if (r.dispenseId) tg[r.dispenseId + ' · ' + bid] = true; });
      var audits = S && S.Audit && S.Audit.list ? S.Audit.list().filter(function (a) { return a && tg[str(a.tgt)]; }) : [];
      var rollbacks = audits.filter(function (a) { return /_ROLLBACK$/.test(str(a.act)); });
      var bc = null, BC = balanceCheck(), bRec = chain.filter(function (r) { return r.balanceId; }).slice(-1)[0];
      if (BC && bRec) {
        var wd = str((bRec.grossHistory && bRec.grossHistory.length ? bRec.grossHistory[bRec.grossHistory.length - 1].at : '') || bRec.tareAt || bRec.createdAt).slice(0, 10);
        try { var st = BC.statusOf(bRec.balanceId, wd); bc = { balanceId: bRec.balanceId, date: wd, checkId: st.checkId || null, result: st.state, blocked: !!st.blocked, deviationId: st.deviationId || null }; } catch (eS) { bc = null; }
      }
      var integ = { recordHash: last ? recIntegrity(last) : 'n/a', valueHash: 'n/a', fields: [] };
      if (last && last.performed && last.performed.signatureId && S && S.ESign && S.ESign.get) {
        var sg = S.ESign.get(last.performed.signatureId);
        if (sg && sg.valueHash) integ.valueHash = sg.valueHash === valueHashOf(last) ? 'match' : 'mismatch';
      }
      if (integ.recordHash === 'mismatch') integ.fields.push('recordHash');
      if (integ.valueHash === 'mismatch') integ.fields.push('valueHash');
      return { ok: true, line: line, attempts: clone(chain),
               chain: chain.map(function (r) { var h = (r.history || []).filter(function (x) { return x && x.ref; }).slice(-1)[0]; return { recId: r.recId, attempt: r.attempt, state: r.state, voidKind: r.voidKind || null, ref: h ? h.ref : null }; }),
               signatures: sigs, audits: audits, rollbacks: rollbacks, balanceCheck: bc, integrity: integ };
    }

    /* ---- 공통 가드 · 트랜잭션 */
    function fail(why, message, extra) { var r = { ok: false, why: why, message: message }; if (extra) Object.keys(extra).forEach(function (k) { r[k] = extra[k]; }); return r; }
    function ctxFor(batchId, lineId) {
      var S = session();
      if (!S) return { err: fail('no_session', MSG.no_session) };
      /* C3: 현재 사용자가 없으면 칭량 기록 · 서명 모두 차단. 서명자는 서명 창 입력 ID (Q4), 서명 아닌 기록은 현재 사용자로 남긴다 */
      var cur = S.getCurrentUser && S.getCurrentUser();
      if (!cur) return { err: fail('no_current_user', MSG.no_current_user) };
      var p = planOf(batchId);
      if (!p.ok) return { err: p };
      var line = planLine(p, lineId);
      if (!line) return { err: fail('no_line', MSG.no_line) };
      var o = dsLoad(), recs = lineRecords(o, p.batchId, line.lineId);
      return { S: S, user: cur, p: p, line: line, o: o, recs: recs, rec: activeRec(recs) };
    }
    /* 출처 검사: P0 는 SIM 만 (MANUAL → manual_not_allowed), 불안정 값(stable:false) 거부 */
    function checkSource(source, input) {
      if (source === 'MANUAL') return fail('manual_not_allowed', MSG.manual_not_allowed, { field: 'source' });
      if (SOURCES.indexOf(source) < 0) return fail('bad_value', '출처는 ' + SOURCES.join(' · ') + ' 만 받습니다.', { field: 'source' });
      if (input && input.stable === false) return fail('unstable', MSG.unstable, { field: 'stable' });
      return null;
    }
    function move(rec, to, by, act, at) {
      if (!canTransition(rec.state, to)) throw new Error('전이 불가 ' + rec.state + ' → ' + to);
      rec.history = rec.history || [];
      rec.history.push({ at: at, from: rec.state, to: to, by: by, act: act || '' });
      rec.state = to;
      rec.updatedAt = at;
    }
    function seal(rec) { var b = clone(rec); delete b.recordHash; rec.recordHash = hashOf(b); return rec; }
    function badState(rec, need) {
      return fail('bad_state', '지금 상태(' + (rec ? STATE_LABEL[rec.state] + ' ' + rec.state : '대기 PLANNED') + ')에서는 할 수 없습니다' + (need ? ' — ' + need : '') + '.',
                  { state: rec ? rec.state : 'PLANNED' });
    }
    function tgtOf(rec, p) { return (rec && rec.dispenseId ? rec.dispenseId : (rec ? rec.lineId : '')) + ' · ' + p.batchId; }
    /* keys 원본 보관 → writer() (저장) → 감사 1회 쓰기. 실패 시 원본 복원 + DISPENSE_ROLLBACK (상태 불변, W3) */
    function txn(c, keys, writer) {
      var orig = {}; keys.forEach(function (k) { orig[k] = readRaw(k); });
      var stage = 'write';
      try {
        var w = writer();
        stage = 'audit';
        c.S.Audit.appendMany(w.audits || []);
        var out = { ok: true }; Object.keys(w.result || {}).forEach(function (k) { out[k] = w.result[k]; });
        return out;
      } catch (e) {
        var restored = keys.map(function (k) { return restoreRaw(k, orig[k]); }).every(Boolean);
        try { c.S.Audit.append({ uid: c.user.userId, act: 'DISPENSE_ROLLBACK', why: 'save_error', detail: stage, tgt: c.line.lineId + ' · ' + c.p.batchId,
                                 val: stage + ' 저장 실패 → ' + keys.length + '키 복원' + (restored ? '' : ' 실패'), orderNo: c.p.orderNo }); } catch (e2) { /* ignore */ }
        return fail('save_error', MSG.save_error, { stage: stage, restored: restored, error: String((e && e.message) || e) });
      }
    }
    function newRec(c, at, attempt, from) {
      var l = c.line, b = c.p.batchRec;
      var seq = c.recs.length + 1;
      return {
        recId: 'DR-' + c.p.batchId + '-' + l.lineId + '-' + pad(seq, 2), dispenseId: null,
        batchId: c.p.batchId, orderNo: c.p.orderNo, processTreeId: b.processTreeId || '', ver: b.ver != null ? b.ver : '', contentHash: b.contentHash || '',
        lineId: l.lineId, nodeId: l.nodeId || '', materialId: l.materialId, materialName: l.materialName || '',
        theoQty: l.theoQty, tolPct: l.tolPct, lo: l.lo, hi: l.hi, uom: l.uom || 'kg', balanceClass: l.balanceClass || '',
        lotNo: from ? from.lotNo : '', balanceId: from ? from.balanceId : '', roomId: from ? from.roomId : '',
        tare: null, tareBy: null, tareAt: null, gross: null, net: null, devPct: null, source: null, grossHistory: [], weighedBy: null,
        attempt: attempt, judge: null, state: 'PLANNED',
        gateResults: from ? clone(from.gateResults) : [], gateAck: from ? clone(from.gateAck) : null,
        labels: [], performed: null, verified: null, reweigh: null, deviationId: null, voidReason: null, voidKind: null,
        history: [], createdAt: at, updatedAt: at, recordHash: ''
      };
    }
    function containerId(o, batchId) {
      var n = (o.seq[batchId] || 0) + 1;
      o.items.forEach(function (r) {                    /* seq 가 지워졌어도 번호 재사용 없음 */
        var m = r.batchId === batchId && /-(\d+)$/.exec(r.dispenseId || '');
        if (m && +m[1] >= n) n = +m[1] + 1;
      });
      o.seq[batchId] = n;
      return 'DC-' + batchId + '-' + pad(n, 3);
    }
    function valueHashOf(rec) { return hashOf({ dispenseId: rec.dispenseId, lotNo: rec.lotNo, tare: rec.tare, gross: rec.gross, net: rec.net, balanceId: rec.balanceId }); }

    /* ---- 게이트 평가 → READY / BLOCKED (경고는 사유 입력 후 READY) */
    function evaluateGates(batchId, lineId, input) {
      input = input || {};
      var c = ctxFor(batchId, lineId); if (c.err) return c.err;
      var rec = c.rec;
      /* 재칭량(REDO) 새 시도도 게이트 G1–G16 을 다시 통과해야 전운 기록 가능 — 상태는 REDO 유지(전이표 불변), 결과는 regate 에 */
      if (rec && rec.state !== 'PLANNED' && rec.state !== 'BLOCKED' && rec.state !== 'REDO') return badState(rec, '게이트 평가는 대기 · 차단 · 재칭량 상태에서만');
      var lotNo = str(input.lotNo), balanceId = str(input.balanceId), roomId = str(input.roomId);
      var gates = gateCheck(c.line, lotNo, balanceId, roomId, { batchId: c.p.batchId, today: input.today });
      var sm = summarizeGates(gates);
      var reason = str(input.warnReason);
      if (!sm.blocked.length && sm.warnings.length && !reason) {
        return fail('needs_ack', '경고 ' + sm.warnings.length + '건 — 사유를 입력하면 진행합니다.', { needsAck: true, state: rec ? rec.state : 'PLANNED', gates: gates, blocked: [], warnings: sm.warnings, passed: sm.passed, total: sm.total });
      }
      var at = nowIso(), uid = c.user.userId;
      return txn(c, [KEYS.DISPENSE], function () {
        var o = dsLoad(), recs = lineRecords(o, c.p.batchId, c.line.lineId), r = activeRec(recs), audits = [];
        if (!r) { c.recs = recs; r = newRec(c, at, attemptNo(recs), null); o.items.push(r); }
        var redo = r.state === 'REDO';
        if (r.state === 'BLOCKED') move(r, 'PLANNED', uid, 'gate_reeval', at);
        r.lotNo = lotNo; r.balanceId = balanceId; r.roomId = roomId; r.gateResults = clone(gates);
        var tgt = r.lineId + ' · ' + c.p.batchId, base = c.line.materialId + ' · LOT ' + (lotNo || '—') + ' · 저울 ' + (balanceId || '—') + ' · 칭량실 ' + (roomId || '—');
        if (redo) r.regate = { ok: !sm.blocked.length, at: at, by: uid, balanceId: balanceId };
        if (redo) r.updatedAt = at;
        if (sm.blocked.length) {
          if (!redo) move(r, 'BLOCKED', uid, 'gate_block', at);
          audits.push({ act: 'DISPENSE_GATE_BLOCK', why: sm.blocked[0].code, tgt: tgt, val: base + ' · ' + sm.blocked.map(function (g) { return g.gate + ' ' + g.code; }).join(', '),
                        orderNo: c.p.orderNo, detail: { gates: sm.blocked.map(function (g) { return { gate: g.gate, code: g.code, reason: g.reason }; }) } });
        } else {
          if (sm.warnings.length) {
            r.gateAck = { reason: reason, codes: sm.warnings.map(function (g) { return g.code; }), at: at, by: uid };
            audits.push({ act: 'DISPENSE_GATE_WARN_ACK', why: sm.warnings.map(function (g) { return g.code; }).join(','), tgt: tgt, val: reason, orderNo: c.p.orderNo,
                          detail: { gates: sm.warnings.map(function (g) { return { gate: g.gate, code: g.code, reason: g.reason }; }) } });
          } else r.gateAck = null;
          if (!redo) move(r, 'READY', uid, 'gate_pass', at);
          audits.push({ act: 'DISPENSE_START', tgt: tgt, val: (redo ? '재칭량 시도 ' + r.attempt + ' · ' : '') + base, orderNo: c.p.orderNo });
        }
        seal(r);
        writeJson(KEYS.DISPENSE, o, 'dispense');
        return { audits: audits, result: { state: r.state, gates: gates, blocked: sm.blocked, warnings: sm.warnings, passed: sm.passed, total: sm.total, line: lineView(c.p, c.line, o) } };
      });
    }
    /* ---- 전운 기록 → TARED · 용기 ID 부여 (결정) */
    function recordTare(batchId, lineId, input) {
      input = input || {};
      var c = ctxFor(batchId, lineId); if (c.err) return c.err;
      if (!c.rec || (c.rec.state !== 'READY' && c.rec.state !== 'REDO')) return badState(c.rec, '전운은 준비 · 재칭량 상태에서');
      if (c.rec.state === 'REDO' && !(c.rec.regate && c.rec.regate.ok)) return fail('regate_required', MSG.regate_required, { state: 'REDO' });
      var tare = num(input.tare), source = str(input.source || 'SIM').toUpperCase();
      var sv = checkSource(source, input); if (sv) return sv;
      if (isNaN(tare) || tare < 0) return fail('bad_value', '전운은 0 이상의 숫자여야 합니다.', { field: 'tare' });
      var at = nowIso(), uid = c.user.userId;
      return txn(c, [KEYS.DISPENSE], function () {
        var o = dsLoad(), r = activeRec(lineRecords(o, c.p.batchId, c.line.lineId));
        r.tare = round3(tare); r.tareBy = uid; r.tareByName = c.user.name || ''; r.tareAt = at; r.source = source;
        r.dispenseId = containerId(o, c.p.batchId);
        move(r, 'TARED', uid, 'tare', at);
        seal(r);
        writeJson(KEYS.DISPENSE, o, 'dispense');
        return { audits: [{ act: 'DISPENSE_TARE', tgt: r.dispenseId + ' · ' + c.p.batchId, val: '전운 ' + r.tare.toFixed(3) + ' ' + r.uom + ' · ' + source + ' · 시도 ' + r.attempt + '/' + MAX_ATTEMPTS, orderNo: c.p.orderNo }],
                 result: { dispenseId: r.dispenseId, state: r.state, line: lineView(c.p, c.line, o) } };
      });
    }
    /* ---- 총중량 기록 (재기록 가능) → WEIGHED. 기록 직전 저울 · LOT 게이트 재평가 — 차단이면 값 저장 없음 */
    function recordGross(batchId, lineId, input) {
      input = input || {};
      var c = ctxFor(batchId, lineId); if (c.err) return c.err;
      var rec = c.rec;
      if (!rec || (rec.state !== 'TARED' && rec.state !== 'WEIGHED')) return badState(rec, '총중량은 전운 뒤 · 판정 전에만');
      var gross = num(input.gross), source = str(input.source || 'SIM').toUpperCase();
      var sv = checkSource(source, input); if (sv) return sv;
      if (isNaN(gross) || gross < 0) return fail('bad_value', '총중량은 0 이상의 숫자여야 합니다.', { field: 'gross' });
      if (gross <= rec.tare) return fail('bad_value', '총중량은 전운(' + rec.tare.toFixed(3) + ')보다 커야 합니다.', { field: 'gross' });
      var re = judgeLot(rec.lotNo, c.line, { today: input.today }).concat(judgeBalance(rec.balanceId, { today: input.today, theoQty: c.line.theoQty, balanceClass: c.line.balanceClass }));
      var bl = summarizeGates(re).blocked;
      if (bl.length) {
        try {
          c.S.Audit.append({ uid: c.user.userId, act: 'DISPENSE_GATE_BLOCK', why: bl[0].code, tgt: tgtOf(rec, c.p), orderNo: c.p.orderNo,
                             val: '총중량 기록 직전 재평가 · ' + bl.map(function (g) { return g.gate + ' ' + g.code; }).join(', '),
                             detail: { stage: 'before_gross', gates: bl.map(function (g) { return { gate: g.gate, code: g.code, reason: g.reason }; }) } });
        } catch (e) { return fail('save_error', MSG.save_error, { stage: 'audit' }); }
        return fail('gate_blocked', bl[0].reason, { gates: re, blocked: bl, state: rec.state });
      }
      var at = nowIso(), uid = c.user.userId;
      return txn(c, [KEYS.DISPENSE], function () {
        var o = dsLoad(), r = activeRec(lineRecords(o, c.p.batchId, c.line.lineId)), prev = r.gross;
        r.gross = round3(gross); r.net = round3(r.gross - r.tare); r.source = source; r.weighedBy = uid; r.weighedByName = c.user.name || '';
        r.grossHistory = r.grossHistory || [];
        r.grossHistory.push({ gross: r.gross, net: r.net, source: source, at: at, by: uid, byName: c.user.name || '' });
        move(r, 'WEIGHED', uid, prev == null ? 'gross' : 'gross_rerecord', at);
        seal(r);
        writeJson(KEYS.DISPENSE, o, 'dispense');
        return { audits: [{ act: 'DISPENSE_WEIGHED', tgt: r.dispenseId + ' · ' + c.p.batchId, val: '총중량 ' + r.gross.toFixed(3) + ' · 순중량 ' + r.net.toFixed(3) + ' ' + r.uom + ' · ' + source,
                             before: { gross: prev }, after: { gross: r.gross, net: r.net }, orderNo: c.p.orderNo }],
                 result: { gross: r.gross, net: r.net, rerecordCount: r.grossHistory.length - 1, state: r.state, line: lineView(c.p, c.line, o) } };
      });
    }
    /* ---- 판정 → JUDGED (PASS/OOT). 시도 2회째 OOT 는 자동 일탈 → DEVIATION */
    function judge(batchId, lineId) {
      var c = ctxFor(batchId, lineId); if (c.err) return c.err;
      if (!c.rec || c.rec.state !== 'WEIGHED') return badState(c.rec, '판정은 총중량 기록 뒤');
      var at = nowIso(), uid = c.user.userId;
      return txn(c, [KEYS.DISPENSE, KEYS.DEV], function () {
        var o = dsLoad(), r = activeRec(lineRecords(o, c.p.batchId, c.line.lineId)), audits = [];
        var pass = r.net >= r.lo && r.net <= r.hi;
        r.judge = pass ? 'PASS' : 'OOT';
        r.devPct = round((r.net - r.theoQty) / r.theoQty * 100, 2);
        move(r, 'JUDGED', uid, 'judge', at);
        var tgt = r.dispenseId + ' · ' + c.p.batchId;
        audits.push({ act: 'DISPENSE_JUDGED', tgt: tgt, orderNo: c.p.orderNo,
                      val: '순중량 ' + r.net.toFixed(3) + ' ' + r.uom + ' · ' + r.lo.toFixed(3) + ' – ' + r.hi.toFixed(3) + ' · 편차 ' + (r.devPct >= 0 ? '+' : '') + r.devPct.toFixed(2) + ' % · ' + r.judge });
        var devId = null;
        if (!pass && r.attempt >= MAX_ATTEMPTS) {
          var d = devLoad(), seq = d.items.length + 1;
          devId = 'DEV-' + String(c.p.batchId).replace(/^BR-/, '').replace(/[^A-Za-z0-9-]/g, '') + '-' + pad(seq, 2);
          while (d.items.some(function (x) { return x.id === devId; })) { seq++; devId = devId.replace(/-\d+$/, '-' + pad(seq, 2)); }
          d.items.push({ id: devId, orderNo: c.p.orderNo || null, batchId: c.p.batchId, source: 'weighing', title: '칭량 허용오차 재이탈 — ' + r.lineId + ' ' + (r.materialName || r.materialId),
                         grade: 'Hard-QA', status: 'open', capaLink: null, createdAt: at, closedAt: null,
                         refType: 'dispense', refId: r.dispenseId, nodeId: r.nodeId || '', lineId: r.lineId });
          d.v = 1;
          writeJson(KEYS.DEV, d, 'dev');
          r.deviationId = devId;
          move(r, 'DEVIATION', uid, 'auto_deviation', at);
          audits.push({ act: 'DISPENSE_DEVIATION', tgt: tgt, val: '재칭량 후 다시 허용 범위 밖 · ' + devId + ' (Hard-QA)', orderNo: c.p.orderNo, detail: { deviationId: devId } });
        }
        seal(r);
        writeJson(KEYS.DISPENSE, o, 'dispense');
        return { audits: audits, result: { judge: r.judge, net: r.net, devPct: r.devPct, lo: r.lo, hi: r.hi, state: r.state, deviationId: devId,
                                           canReweigh: !pass && r.attempt < MAX_ATTEMPTS, line: lineView(c.p, c.line, o) } };
      });
    }
    /* ---- 라벨 (결정: 전운 뒤부터 출력 가능. 확인 서명 조건 = 판정 PASS 뒤 출력 · 재출력 1회 이상) */
    function labelData(batchId, lineId) {
      var g = getLine(batchId, lineId); if (!g.ok) return g;
      var r = g.line.current, p = planOf(batchId);
      if (!r || !r.dispenseId) return fail('no_container', '용기 ID 가 없습니다 — 전운을 먼저 기록하세요.');
      var lot = matGet(r.lotNo) || {};
      var counted = r.judge === 'PASS' && (r.state === 'JUDGED' || r.state === 'PERFORMED' || r.state === 'VERIFIED');
      return { ok: true, label: {
        dispenseId: r.dispenseId, materialId: r.materialId, materialName: r.materialName, lotNo: r.lotNo,
        net: counted ? r.net : null, uom: r.uom, batchId: r.batchId, orderNo: r.orderNo,
        tare: r.tare, gross: r.gross, balanceId: r.balanceId, roomId: r.roomId, weighedAt: r.grossHistory && r.grossHistory.length ? r.grossHistory[r.grossHistory.length - 1].at : null,
        performedBy: r.performed ? r.performed.userId : null, verifiedBy: r.verified ? r.verified.userId : null,
        processTreeId: r.processTreeId, ver: r.ver, nodeId: r.nodeId, retestDate: lot.retestDate || null, expiryDate: lot.expiryDate || null,
        judge: r.judge, state: r.state, countsForVerify: counted, orderNoOfBatch: p.ok ? p.orderNo : null
      } };
    }
    function printLabel(batchId, lineId, input) {
      input = input || {};
      var c = ctxFor(batchId, lineId); if (c.err) return c.err;
      var rec = c.rec;
      if (!rec || !rec.dispenseId || !LABEL_STATES[rec.state]) return badState(rec, '라벨은 전운 기록 뒤(용기 ID 부여 뒤)에');
      var reprint = (rec.labels || []).length > 0, why = str(input.why);
      if (reprint && !why) return fail('why_required', MSG.reprint_why);
      var at = nowIso(), uid = c.user.userId;
      return txn(c, [KEYS.DISPENSE], function () {
        var o = dsLoad(), r = activeRec(lineRecords(o, c.p.batchId, c.line.lineId));
        var afterPass = r.judge === 'PASS' && (r.state === 'JUDGED' || r.state === 'PERFORMED' || r.state === 'VERIFIED');
        var lb = { seq: (r.labels || []).length + 1, kind: reprint ? 'reprint' : 'print', at: at, by: uid, why: reprint ? why : '', state: r.state, judge: r.judge, afterPass: afterPass };
        r.labels = r.labels || []; r.labels.push(lb); r.updatedAt = at;
        seal(r);
        writeJson(KEYS.DISPENSE, o, 'dispense');
        var a = { act: reprint ? 'LABEL_REPRINT' : 'LABEL_PRINTED', tgt: r.dispenseId + ' · ' + c.p.batchId, orderNo: c.p.orderNo,
                  val: '라벨 ' + lb.seq + '회 · ' + r.state + (afterPass ? ' · 판정 적합 뒤(확인 조건 충족)' : ' · 판정 전(확인 조건 아님)') };
        if (reprint) a.why = why;
        return { audits: [a], result: { label: clone(lb), countsForVerify: afterPass, labelAfterPass: labelAfterPass(r), line: lineView(c.p, c.line, o) } };
      });
    }
    /* ---- 용기 취소 (수행 서명 전, 사유 필수) → VOID, 줄은 다음 평가에서 새 시도(PLANNED) */
    function voidContainer(batchId, lineId, input) {
      input = input || {};
      var c = ctxFor(batchId, lineId); if (c.err) return c.err;
      var rec = c.rec;
      if (!rec || !VOIDABLE[rec.state]) return badState(rec, '취소는 수행 서명 전에만');
      if (rec.state === 'JUDGED' && rec.judge === 'OOT') return fail('oot_requires_reweigh', MSG.oot_requires_reweigh, { state: rec.state });
      var reason = str(input.reason);
      if (!reason) return fail('why_required', MSG.void_why);
      if (charLen(reason) > VOID_REASON_MAX) return fail('reason_too_long', MSG.reason_too_long, { max: VOID_REASON_MAX, length: charLen(reason) });   /* 저장 · 감사 없음 */
      var at = nowIso(), uid = c.user.userId;
      return txn(c, [KEYS.DISPENSE], function () {
        var o = dsLoad(), r = activeRec(lineRecords(o, c.p.batchId, c.line.lineId));
        r.voidReason = reason; r.voidKind = 'cancel';
        move(r, 'VOID', uid, 'void', at);
        seal(r);
        writeJson(KEYS.DISPENSE, o, 'dispense');
        return { audits: [{ act: 'DISPENSE_VOID', why: reason, tgt: tgtOf(r, c.p), val: (r.dispenseId || '(용기 없음)') + ' 취소 · 시도 ' + r.attempt, orderNo: c.p.orderNo }],
                 result: { state: 'PLANNED', voided: r.recId, dispenseId: r.dispenseId, line: lineView(c.p, c.line, o) } };
      });
    }

    /* ---- 서명: 수행(SM-PERF-WEIGH) · 확인(SM-VERI-WEIGH, ⑥ 수행자 ≠) · 재칭량 승인(SM-APPR-REWEIGH, ⑥ 칭량자 ≠, 폐기 사유 같은 요청) */
    var SIGN_KIND = {
      perform: { rule: RULES.PERFORM, recordType: 'weigh_value', text: '칭량 수행', en: 'Performed by', statement: 'weigh_perform' },
      verify: { rule: RULES.VERIFY, recordType: 'weigh_value', text: '칭량 확인', en: 'Verified by', statement: 'weigh_verify' },
      reweigh: { rule: RULES.REWEIGH, recordType: 'weigh_reweigh', text: '재칭량 승인', en: 'Approved by', statement: 'reweigh_approve' }
    };
    function signValues(r) {
      return [
        { key: 'material', label: '자재', value: r.materialId + ' · ' + r.materialName }, { key: 'lotNo', label: 'LOT', value: r.lotNo },
        { key: 'dispenseId', label: '용기 ID', value: r.dispenseId }, { key: 'tare', label: '전운', value: r.tare == null ? '—' : r.tare.toFixed(3) + ' ' + r.uom },
        { key: 'gross', label: '총중량', value: r.gross == null ? '—' : r.gross.toFixed(3) + ' ' + r.uom }, { key: 'net', label: '순중량', value: r.net == null ? '—' : r.net.toFixed(3) + ' ' + r.uom },
        { key: 'range', label: '지시량', value: r.theoQty.toFixed(3) + ' (' + r.lo.toFixed(3) + ' – ' + r.hi.toFixed(3) + ')' },
        { key: 'judge', label: '판정', value: (r.judge || '—') + (r.devPct == null ? '' : ' · ' + (r.devPct >= 0 ? '+' : '') + r.devPct.toFixed(2) + ' %') },
        { key: 'balanceId', label: '저울', value: r.balanceId }, { key: 'roomId', label: '칭량실', value: r.roomId },
        { key: 'weighedAt', label: '칭량 일시', value: r.grossHistory && r.grossHistory.length ? r.grossHistory[r.grossHistory.length - 1].at : '' }
      ];
    }
    function beginSign(batchId, lineId, kind, o2) {
      o2 = o2 || {};
      var K = SIGN_KIND[kind];
      if (!K) return fail('bad_input', '서명 종류는 perform · verify · reweigh 중 하나입니다.');
      var c = ctxFor(batchId, lineId); if (c.err) return c.err;
      var rec = c.rec, distinct = [];
      if (kind === 'perform' && !(rec && rec.state === 'JUDGED' && rec.judge === 'PASS')) return badState(rec, '수행 서명은 판정 적합(PASS) 뒤');
      if (kind === 'verify') {
        if (!(rec && rec.state === 'PERFORMED')) return badState(rec, '확인 서명은 수행 서명 뒤');
        if (!labelAfterPass(rec)) return fail('label_required', MSG.label_required, { state: rec.state });
        distinct.push({ userId: rec.performed.userId, label: '수행자' });   /* PERFORMED 서명 기록의 signerId = 입력 ID (현재 사용자 아님) */
      }
      if (kind === 'reweigh') {
        if (!(rec && rec.state === 'JUDGED' && rec.judge === 'OOT')) return badState(rec, '재칭량 승인은 허용 범위 밖 판정 뒤');
        if (rec.attempt >= MAX_ATTEMPTS) return fail('max_attempts', '재칭량은 1회까지입니다 — 일탈로 처리됩니다.', { state: rec.state });
        /* ⑥ (결정 · 코드 리뷰): 승인자(입력 ID)는 폐기할 시도의 PERFORMED 서명자(있으면)와도, 그 시도에 값을 기록한 모든 스테이션 사용자
           (tareBy · 총중량 기록 이력 grossHistory[].by 전부 · 마지막 weighedBy)와도 달라야 한다 — 재기록 전 총중량 기록자도 포함 (승인 우회 방지).
           역할 ⑤(SV · QA)가 먼저, 그다음 ⑥ — 헬퍼 판정 순서 그대로 */
        var addDistinct = function (u, label) { if (u && !distinct.some(function (x) { return str(x.userId).toUpperCase() === str(u).toUpperCase(); })) distinct.push({ userId: u, label: label }); };
        addDistinct(rec.performed && rec.performed.userId, '수행자');
        addDistinct(rec.tareBy, '칭량자');
        (rec.grossHistory || []).forEach(function (h) { addDistinct(h && h.by, '칭량자'); });
        addDistinct(rec.weighedBy, '칭량자');
      }
      var recId = rec.recId, snapJson = JSON.stringify(rec), vh = valueHashOf(rec), p = c.p, line = c.line;
      var tgt = rec.dispenseId + ' · ' + p.batchId;
      var val = rec.lineId + ' ' + rec.materialId + ' · LOT ' + rec.lotNo + ' · 순중량 ' + rec.net.toFixed(3) + ' ' + rec.uom + ' (' + rec.lo.toFixed(3) + ' – ' + rec.hi.toFixed(3) + ') ' + rec.judge +
                ' · valueHash ' + vh.slice(0, 8);
      var stCtx = { batchId: p.batchId, lineId: rec.lineId, materialId: rec.materialId, lotNo: rec.lotNo, dispenseId: rec.dispenseId, net: rec.net, uom: rec.uom, judge: rec.judge };
      if (kind === 'verify') { stCtx.performerName = rec.performed.name || ''; stCtx.performerId = rec.performed.userId; }
      if (kind === 'reweigh') stCtx.voidReason = '';
      function current() { var oo = dsLoad(); return { o: oo, r: oo.items.filter(function (x) { return x.recId === recId; })[0] }; }
      var spec = {
        signRuleId: K.rule, recordType: K.recordType, meaningText: K.text, tgt: tgt, val: val, orderNo: p.orderNo, screen: o2.screen,
        /* 서명 문장: 헬퍼 builder 한 곳에서 조립 → ticket target.statement 로 서명 창에 그대로 표시, 커밋 때 같은 문장을 서명 레코드 statement 로 저장(signatureHash 대상).
           재칭량은 폐기 사유가 서명 창 입력이라 statementInputKeys ['voidReason'] — 커밋 때 입력 사유를 넣어 같은 builder 로 다시 조립 */
        statementKind: K.statement, statementCtx: stCtx, statement: c.S.signStatement ? c.S.signStatement(K.statement, stCtx) : '',
        statementInputKeys: kind === 'reweigh' ? ['voidReason'] : [],
        fields: { batchId: p.batchId, lineId: rec.lineId, nodeId: rec.nodeId, dispenseId: rec.dispenseId, recId: recId, attempt: rec.attempt, valueHash: vh },
        distinctFrom: distinct,
        target: { values: signValues(rec), valueHash: vh, dispenseId: rec.dispenseId, lineId: rec.lineId, kind: kind, attempt: rec.attempt, maxAttempts: MAX_ATTEMPTS },
        keys: kind === 'verify' ? [KEYS.DISPENSE, KEYS.MAT] : [KEYS.DISPENSE],
        openAct: 'DISPENSE_SIGN_OPEN', cancelAct: 'DISPENSE_SIGN_CANCEL', rollbackAct: 'DISPENSE_ROLLBACK',
        qualTargets: kind === 'perform' ? ['BALCLASS:' + str(line.balanceClass || rec.balanceClass)] : [],   /* ⑦ 저울 클래스 자격은 수행만 (교육 · 자격 규칙 ④) */
        signerMode: 'entered',                          /* Q4: 서명자 = 서명 창 입력 ID, ⑥ · 실패 카운트도 입력 ID */
        /* 폐기 사유: 필수 · 공백 제거 뒤 VOID_REASON_MAX 자 이내 — 헬퍼가 비밀번호 판정 전에 부르므로 실패 카운트 · 인증 감사 없음 */
        requireInput: kind === 'reweigh' ? function (inp) {
          var vr = str(inp && inp.voidReason);
          if (!vr) return { why: 'void_reason_required', message: MSG.void_reason_required };
          return charLen(vr) > VOID_REASON_MAX ? { why: 'reason_too_long', message: MSG.reason_too_long } : null;
        } : null,
        precheck: function () {
          var S2 = session(); if (!S2 || !S2.getCurrentUser || !S2.getCurrentUser()) return { detail: 'no_current_user', message: MSG.no_current_user };
          var cr = current().r;
          /* 서명 창을 연 뒤 기록이 한 글자라도 바뀌면(라벨 출력 포함) 거부 — 타임스탬프 해상도에 기대지 않음 */
          if (!cr || JSON.stringify(cr) !== snapJson || valueHashOf(cr) !== vh) return { detail: 'record_changed', message: MSG.record_changed };
          if (kind === 'verify') { var lot = matGet(cr.lotNo); if (!lot || !(num(lot.qty) >= cr.net)) return { detail: 'lot_short', message: MSG.lot_short_verify }; }
          return null;
        },
        apply: function (sig, ctx) {
          var cu = current(), oo = cu.o, r = cu.r, at = ctx.at, uid = sig.signerId, audits = [], tg = r.dispenseId + ' · ' + p.batchId;
          var who = { userId: uid, name: sig.signerName, role: sig.signerRole, signatureId: sig.signatureId, at: at };
          if (kind === 'perform') {
            r.performed = who; move(r, 'PERFORMED', uid, 'sign_perform', at);
          } else if (kind === 'verify') {
            r.verified = who; move(r, 'VERIFIED', uid, 'sign_verify', at);
            var m = matLoad(), lot = m.lots.filter(function (l) { return l && l.lotNo === r.lotNo; })[0];
            var before = num(lot.qty), after = Math.max(0, round3(before - r.net));
            lot.qty = after; lot.updatedAt = at; m.v = 1;
            writeJson(KEYS.MAT, m, 'mat');
            audits.push({ act: 'DISPENSE_VERIFIED', tgt: tg, val: '수행 ' + r.performed.signatureId + ' · 확인 ' + sig.signatureId, orderNo: p.orderNo });
            audits.push({ act: 'LOT_CONSUMED', tgt: r.lotNo + ' · ' + tg, val: r.net.toFixed(3) + ' ' + r.uom + ' 차감', before: { qty: before }, after: { qty: after }, orderNo: p.orderNo });
          } else {
            var reason = str(ctx.input.voidReason);
            r.voidReason = reason; r.voidKind = 'reweigh'; r.reweigh = { userId: uid, name: sig.signerName, signatureId: sig.signatureId, at: at, reason: reason };
            move(r, 'VOID', uid, 'reweigh_void', at);
            seal(r);
            var cc = { p: p, line: line, recs: lineRecords(oo, p.batchId, line.lineId) };
            var nr = newRec(cc, at, r.attempt + 1, r);
            nr.state = 'REDO';
            nr.history.push({ at: at, from: null, to: 'REDO', by: uid, act: 'reweigh_approved', ref: r.recId });
            seal(nr);
            oo.items.push(nr);
            audits.push({ act: 'DISPENSE_REDO', why: reason, tgt: tg, val: sig.signatureId + ' (' + RULES.REWEIGH + ') · 시도 ' + nr.attempt + '/' + MAX_ATTEMPTS, orderNo: p.orderNo });
          }
          if (kind !== 'reweigh') seal(r);
          writeJson(KEYS.DISPENSE, oo, 'dispense');
          return { audits: audits, result: { kind: kind, state: kind === 'reweigh' ? 'REDO' : r.state, line: lineView(p, line, oo) } };
        }
      };
      return c.S.beginRecordSign(spec);
    }
    function signAndCommit(ticket, input) { var S = session(); return S ? S.signAndCommitRecord(ticket, input) : fail('no_session', MSG.no_session); }
    function cancelSign(ticket, o3) { var S = session(); return S ? S.cancelRecordSign(ticket, o3) : fail('no_session', MSG.no_session); }

    /* ---- 설비 시드 · 일상 점검 (L3, 결정: 멱등 시드 함수) */
    function seedEquipment(o4) {
      o4 = o4 || {};
      var o = eqLoad(), added = [], filled = [], t = today();
      /* 저울 점검 store 가 있으면 dailyCheck 를 채우지 않는다(서명 없는 'SEED' 합격 = G12 우회). 일상 점검은 seedDemo 미러 · S-44 서명으로만 */
      var fillDc = o4.dailyCheck !== false && !balanceCheckActive();
      equipSeedFor(t).forEach(function (s) {
        var cur = eqFind(o.items, s.equipmentId);
        if (!cur) {
          var n = clone(s);
          if (n.kind === 'balance' && fillDc) n.dailyCheck = { date: t, result: 'pass', by: 'SEED' };
          n.cleanHoldUntil = null;
          o.items.push(n); added.push(s.equipmentId);
          return;
        }
        var f = [];
        Object.keys(s).forEach(function (k) {
          if (k === 'status' || k === 'note') return;
          /* 교정일은 키가 아예 없을 때만 (값 null · '' 은 사용자 편집으로 보고 유지 — MatQC.backfillSeed 와 같은 규칙), 나머지는 빈 칸 채움 */
          var miss = k === 'calDue' ? !Object.prototype.hasOwnProperty.call(cur, k) : (cur[k] === undefined || cur[k] === null || cur[k] === '');
          if (miss) { cur[k] = s[k]; f.push(k); }
        });
        if (s.kind === 'balance' && fillDc && !cur.dailyCheck) { cur.dailyCheck = { date: t, result: 'pass', by: 'SEED' }; f.push('dailyCheck'); }
        if (f.length) filled.push({ equipmentId: s.equipmentId, fields: f });
      });
      if (added.length || filled.length) writeJson(KEYS.EQ, o, 'eq');
      return { ok: true, added: added, filled: filled, changed: !!(added.length || filled.length) };
    }
    /* 칭량실 단말 시드 (멱등): terminals[] 에 없는 단말만 추가, 기존 행은 빈 필드만 채움(roomId 등 덮어쓰지 않음) */
    function seedTerminals() {
      var o = eqLoad(), added = [], filled = [];
      if (!Array.isArray(o.terminals)) o.terminals = [];
      TERMINAL_SEED.forEach(function (s) {
        var cur = o.terminals.filter(function (t) { return t && str(t.terminalId) === s.terminalId; })[0];
        if (!cur) { o.terminals.push(clone(s)); added.push(s.terminalId); return; }
        var f = [];
        Object.keys(s).forEach(function (k) { if (cur[k] === undefined || cur[k] === null || cur[k] === '') { cur[k] = s[k]; f.push(k); } });
        if (f.length) filled.push({ terminalId: s.terminalId, fields: f });
      });
      if (added.length || filled.length) writeJson(KEYS.EQ, o, 'eq');
      return { ok: true, added: added, filled: filled, changed: !!(added.length || filled.length) };
    }
    function masterTerminals() {
      var m = readJson(MASTER_KEY, null);
      return m && typeof m === 'object' && Array.isArray(m.terminal) ? m.terminal : null;
    }
    /* terminalsInRoom(roomId) → { ok, roomId, source:'master'|'equipmentSeed'|'none', terminals:[{terminalId, roomId, line, type, model, online, status, authMethod, reader, note}], primary }
       출처: S-40 단말 레지스트리 저장소(ebmr.masterSetup.v2 terminal[], room = 작업실) → 없으면 설비 시드 terminals[].
       primary = 바인딩 effective 이면서 online 인 첫 단말 → 없으면 effective 첫 단말 → 없으면 null (읽기 전용) */
    function terminalsInRoom(roomId) {
      var rid = str(roomId), m = masterTerminals(), src, list;
      if (m) { src = 'master'; list = m.map(function (t) { return { terminalId: str(t.id), roomId: str(t.room), line: str(t.line), type: str(t.type), model: str(t.model), online: str(t.online), status: str(t.status), authMethod: str(t.authMethod), reader: str(t.reader), note: str(t.note) }; }); }
      else { var e = eqLoad().terminals; src = Array.isArray(e) && e.length ? 'equipmentSeed' : 'none'; list = (Array.isArray(e) ? e : []).map(function (t) { return { terminalId: str(t.terminalId), roomId: str(t.roomId), line: str(t.line), type: str(t.type), model: str(t.model), online: str(t.online), status: str(t.status), authMethod: str(t.authMethod), reader: str(t.reader), note: str(t.note) }; }); }
      var ts = list.filter(function (t) { return t.terminalId && (!rid || t.roomId === rid); }).sort(function (a, b) { return a.terminalId < b.terminalId ? -1 : a.terminalId > b.terminalId ? 1 : 0; });
      var eff = ts.filter(function (t) { return t.status === 'effective'; });
      var pick = eff.filter(function (t) { return t.online === 'online'; })[0] || eff[0] || null;
      return { ok: true, roomId: rid, source: src, terminals: ts, primary: pick ? pick.terminalId : null };
    }
    /* weighRooms() → [{ roomId, name, status, terminals:[terminalId…], primaryTerminal, balances:[balanceId…] }] — 설비 시드의 칭량실(kind room) */
    function weighRooms() {
      return eqLoad().items.filter(function (it) { return it && str(it.kind) === 'room'; }).map(function (r) {
        var id = str(r.equipmentId), t = terminalsInRoom(id);
        return { roomId: id, name: str(r.note), status: str(r.status), terminals: t.terminals.map(function (x) { return x.terminalId; }), primaryTerminal: t.primary, balances: balancesInRoom(id).slice().sort() };
      }).sort(function (a, b) { return a.roomId < b.roomId ? -1 : 1; });
    }
    function setDailyCheck(balanceId, input) {
      input = input || {};
      var S = session(); if (!S) return fail('no_session', MSG.no_session);
      var cur = S.getCurrentUser && S.getCurrentUser(); if (!cur) return fail('no_current_user', MSG.no_current_user);
      var result = str(input.result || 'pass').toLowerCase();
      if (result !== 'pass' && result !== 'fail') return fail('bad_value', '결과는 pass 또는 fail 입니다.');
      /* B1-7 (P0): 저울 점검 store 가 있으면 서명 없는 합격(pass)은 거부 — G12 우회 차단. 불합격(사용 금지 방향)은 데모용으로 허용 */
      var BC = balanceCheck();
      if (BC && result === 'pass') return fail('balance_check_sign_required', MSG.balance_check_sign_required);
      var orig = readRaw(KEYS.EQ), o = eqLoad(), rec = eqFind(o.items, balanceId);
      if (!rec || str(rec.kind) !== 'balance') return fail('not_balance', '저울 ' + balanceId + ' 런타임 레코드가 없습니다 — 설비 시드 또는 등록 후 다시 시도하세요.');
      var before = rec.dailyCheck ? clone(rec.dailyCheck) : null, at = nowIso();
      rec.dailyCheck = { date: str(input.date) || today(), result: result, by: cur.userId, at: at };
      try {
        writeJson(KEYS.EQ, o, 'eq');
        var ae = { uid: cur.userId, act: 'BALANCE_DAILY_CHECK', tgt: rec.equipmentId, val: rec.dailyCheck.date + ' · ' + result, before: before, after: clone(rec.dailyCheck) };
        if (BC) ae.detail = { demo: true };
        S.Audit.appendMany([ae]);
      } catch (e) { restoreRaw(KEYS.EQ, orig); return fail('save_error', MSG.save_error); }
      return { ok: true, dailyCheck: clone(rec.dailyCheck) };
    }

    /* ---- 저울 배정 (B · Q6): 칭량실(roomId, 설비 상태 시드 구역) 저울 중 줄 balanceClass 적격 → 없으면 용량 규칙 */
    function balancesInRoom(roomId) {
      var rid = str(roomId);
      return eqLoad().items.filter(function (it) { return it && str(it.kind) === 'balance' && (!rid || str(it.roomId) === rid); })
        .map(function (it) { return str(it.equipmentId || it.id); });
    }
    function roomOf(equipmentId) { var r = eqFind(eqLoad().items, equipmentId); return r ? str(r.roomId) : ''; }
    /* 저울 배정 제안 (B · Q6 · C12). 후보 = 칭량실 저울 중 줄 클래스 적격. 기본 배정(assigned) 규칙:
         ① 이 칭량실의 주(primary) 저울 중 사용 가능 · 경고 없음 → ② 주 저울 사용 가능(경고 있음, 예: BAL-205 G11)
         → ③ 예비(standby) 저울 — 단, 다른 칭량실에 사용 가능한 주 저울이 있으면 배정하지 않고 elsewhere 로 안내(나눠 칭량)
       candidates 는 같은 순서(사용 가능 → 주 → 경고 없음 → 원래 순서)로 정렬, 예비 저울도 후보에는 남아 수동 선택 가능.
       → { ok, batchId, lineId, theoQty, balanceClass, classSource, roomId, candidates[{…, assignRole}], assigned, elsewhere: {roomId, balanceId} | null } */
    function suggestBalances(batchId, lineId, o6) {
      o6 = o6 || {};
      var p = planOf(batchId); if (!p.ok) return p;
      var line = planLine(p, lineId); if (!line) return fail('no_line', MSG.no_line);
      var cls = str(line.balanceClass), classSource = cls ? (line.classSource || 'line') : 'capacity';
      if (!cls) cls = capacityClass(line.theoQty);
      var q = qualifiedBalances(cls).ids, items = eqLoad().items;
      var cand = function (id) {
        var rows = judgeBalance(id, { today: o6.today, theoQty: line.theoQty, balanceClass: cls }), sm = summarizeGates(rows), rec = eqFind(items, id) || {};
        return { balanceId: id, roomId: str(rec.roomId), eqClass: str(rec.eqClass), capMin: rec.capMin, capMax: rec.capMax, calDue: rec.calDue || null,
                 assignRole: str(rec.assignRole) === 'standby' ? 'standby' : 'primary',
                 gates: rows, blocked: sm.blocked.map(function (g) { return g.code; }), warnings: sm.warnings.map(function (g) { return g.code; }), usable: !sm.blocked.length };
      };
      var rank = function (c) { return (c.usable ? 0 : 4) + (c.assignRole === 'primary' ? 0 : 2) + (c.warnings.length ? 1 : 0); };
      var cands = balancesInRoom(o6.roomId).filter(function (id) { return q.indexOf(id) >= 0; }).map(cand)
        .map(function (c, i) { return { c: c, i: i }; }).sort(function (a, b) { return rank(a.c) - rank(b.c) || a.i - b.i; }).map(function (x) { return x.c; });
      var primary = cands.filter(function (c) { return c.usable && c.assignRole === 'primary'; })[0] || null, pick = primary, elsewhere = null;
      if (!pick) {
        var rid = str(o6.roomId);
        if (rid) {
          var other = balancesInRoom('').filter(function (id) { return q.indexOf(id) >= 0 && roomOf(id) !== rid; }).map(cand)
            .filter(function (c) { return c.usable && c.assignRole === 'primary'; })
            .sort(function (a, b) { return rank(a) - rank(b); })[0];
          if (other) elsewhere = { roomId: other.roomId, balanceId: other.balanceId };
        }
        if (!elsewhere) pick = cands.filter(function (c) { return c.usable; })[0] || null;   /* 주 저울이 어디에도 없을 때만 예비 저울 */
      }
      return { ok: true, batchId: p.batchId, lineId: line.lineId, theoQty: line.theoQty, balanceClass: cls, classSource: classSource, roomId: str(o6.roomId),
               candidates: cands, assigned: pick ? pick.balanceId : null, elsewhere: elsewhere };
    }
    /* 줄 단위 시뮬레이터 값 (L6): 준비 · 재칭량 상태 → 전운 값, 전운 뒤 → 총중량 값(기록된 전운 + 순중량) */
    function simulateReading(batchId, lineId, mode, o7) {
      o7 = o7 || {};
      var g = getLine(batchId, lineId); if (!g.ok) return g;
      var l = g.line, r = l.current, st = l.status;
      var phase = (st === 'READY' || st === 'REDO') ? 'tare' : (st === 'TARED' || st === 'WEIGHED') ? 'gross' : null;
      if (!phase) return fail('bad_state', '지금 상태(' + STATE_LABEL[st] + ' ' + st + ')에서는 저울 값을 읽지 않습니다.', { state: st });
      var cap = CLASS_CAPACITY.filter(function (c) { return c.eqClass === l.balanceClass; })[0];
      var sim = simulate(l.theoQty, mode, { tolPct: l.tolPct, tare: phase === 'gross' ? r.tare : o7.tare, rand: o7.rand, readability: cap ? cap.readability : undefined, uom: l.uom });
      if (!sim.ok) return sim;
      return { ok: true, phase: phase, value: phase === 'tare' ? sim.tare : sim.gross, stable: sim.stable, source: 'SIM', mode: sim.mode, net: phase === 'gross' ? sim.net : null,
               tare: sim.tare, uom: sim.uom, lo: l.lo, hi: l.hi, theoQty: l.theoQty, inRange: phase === 'gross' ? (sim.net >= l.lo && sim.net <= l.hi) : null };
    }

    /* ---- 큐 · OP 요약 · 완료 판정 (L7 · E16 · E17) */
    function issuedList() {
      var s0 = readJson(KEYS.ISSUED, null), l = Array.isArray(s0) ? s0 : (s0 && Array.isArray(s0.items) ? s0.items : []);
      var d = dsLoad().demoBatch;   /* 데모 배치는 같은 ID 의 실제 발행이 없을 때만 큐에 */
      if (d && !l.some(function (b) { return b && str(b.batchId || b.batchNo || b.id) === DEMO_BATCH_ID; })) l = l.concat([d]);
      return l;
    }
    function lineFilter(f) {
      f = f || {};
      if (typeof f === 'string') f = { opId: f };
      return function (l) { return (!f.opId || l.opId === f.opId) && (!f.nodeId || l.nodeId === f.nodeId); };
    }
    /* 선칭량 허용 (Q7): 발행 + 계획이 있으면 생산 단계와 무관하게 큐에 나온다 */
    function queue(roomId, o8) {
      o8 = o8 || {};
      var rid = str(roomId), roomBals = balancesInRoom(rid), items = [], skipped = [];
      issuedList().forEach(function (b) {
        var bid = str(b && (b.batchId || b.batchNo || b.id)); if (!bid) return;
        var sm = summary(bid);
        if (!sm.ok) { skipped.push({ batchId: bid, why: sm.why, message: sm.message }); return; }
        var p = planOf(bid);
        var classes = {}; p.lines.forEach(function (l) { classes[l.balanceClass || capacityClass(l.theoQty)] = 1; });
        var roomFit = Object.keys(classes).every(function (c) { var q = qualifiedBalances(c).ids; return roomBals.some(function (id) { return q.indexOf(id) >= 0; }); });
        var badges = [];
        if (sm.openDeviations) badges.push('DEVIATION');
        if (sm.allVerified && !sm.openDeviations) badges.push('DONE');
        else if (sm.byStatus.some(function (x) { return x.status !== 'PLANNED'; })) badges.push('IN_PROGRESS');
        if (rid && !roomFit) badges.push('NO_BALANCE_IN_ROOM');
        items.push({ batchId: bid, orderNo: p.orderNo, product: b.product || '', issuedAt: b.issuedAt || null, total: sm.total, verified: sm.verified,
                     performed: sm.performed, openDeviations: sm.openDeviations, done: sm.allVerified && !sm.openDeviations, roomFit: rid ? roomFit : null, badges: badges });
      });
      if (o8.includeDone === false) items = items.filter(function (x) { return !x.done; });
      return { ok: true, roomId: rid, balances: roomBals, items: items, skipped: skipped };
    }
    /* E16: 칭량 OP 완료 판정 = 저장소 기준 (화면 세션 값 아님). 계획에 나열된 그 OP(또는 노드) 줄이 모두 VERIFIED + 열린 칭량 일탈 0 */
    function weighingGate(batchId, filter) {
      var r = listLines(batchId);
      if (!r.ok) return { ok: false, why: r.why, message: r.message, total: 0, verified: 0, pending: [], openDeviations: 0 };
      var lines = r.lines.filter(lineFilter(filter));
      var devs = devLoad().items.filter(function (d) {
        return str(d.batchId) === str(batchId) && (d.source === 'weighing' || d.refType === 'dispense') && (d.status === 'draft' || d.status === 'open') &&
          (!lines.length || lines.some(function (l) { return d.lineId ? d.lineId === l.lineId : d.nodeId === l.nodeId; }));
      });
      var pending = lines.filter(function (l) { return l.status !== 'VERIFIED'; }).map(function (l) { return { lineId: l.lineId, materialId: l.materialId, status: l.status }; });
      var ver = lines.length - pending.length, why = '', msg = '';
      if (!lines.length) { why = 'no_lines'; msg = '이 단계에 해당하는 칭량 계획 줄이 없습니다.'; }
      else if (devs.length) { why = 'open_deviation'; msg = '열린 칭량 일탈 ' + devs.map(function (d) { return d.id; }).join(', ') + ' — QA 처분 대기'; }
      else if (pending.length) { why = 'pending'; msg = '칭량 미완료 ' + ver + '/' + lines.length + ' — ' + pending.map(function (x) { return x.lineId + ' ' + STATE_LABEL[x.status]; }).join(', '); }
      return { ok: !why, why: why, message: msg, batchId: str(batchId), total: lines.length, verified: ver, pending: pending,
               openDeviations: devs.length, lineIds: lines.map(function (l) { return l.lineId; }) };
    }
    function opSummary(batchId, filter) {
      var r = listLines(batchId); if (!r.ok) return r;
      var lines = r.lines.filter(lineFilter(filter)), g = weighingGate(batchId, filter);
      return { ok: true, batchId: r.batchId, total: lines.length, verified: g.verified, complete: g.ok, gate: g,
               lines: lines.map(function (l) { return { lineId: l.lineId, nodeId: l.nodeId, opId: l.opId, materialId: l.materialId, materialName: l.materialName, theoQty: l.theoQty, uom: l.uom,
                                                       status: l.status, statusLabel: l.statusLabel, attempt: l.attempt, dispenseId: l.dispenseId,
                                                       performedBy: l.current && l.current.performed ? l.current.performed.userId : null,
                                                       verifiedBy: l.current && l.current.verified ? l.current.verified.userId : null }; }) };
    }
    /* E17: 판정이 참이면 자동 완료를 1회만 기록 (ebr.dispense.v1 opAuto + 감사 DISPENSE_OP_AUTO_COMPLETE). 생산 화면 opDone 반영은 화면 몫 */
    function opAutoKey(filter) { var f = typeof filter === 'string' ? { opId: filter } : (filter || {}); return (f.opId || '') + '|' + (f.nodeId || ''); }
    /* productionStage(batchId, o?) → 생산 진행 단계 (읽기 전용) — 생산 실행 화면과 같은 규칙:
         단계 목록 = 생산 세션(EbrP0.PROD_SESS_KEY)이 이 배치면 그 opDone 순서(= 화면 OP_ORDER),
                     없으면 데모 배치 · 실행 Phase 없는 발행 → 데모 템플릿(OP1-1…), 그 밖 → 발행 스냅샷 phaseList 순서
         현재 단계 = opDone 이 false 인 첫 단계(화면 activeOpIndex). 칭량 단계 = 스냅샷 phaseList kind 'weigh' 또는 노드 phaseRef PH-WEIGH-*, 템플릿은 OP1-1.
         weighOpStarted = 칭량 단계가 현재 단계이거나 이미 완료(세션 opDone 또는 칭량 자동 완료 기록). preWeigh = 칭량 단계 시작 전(이때의 칭량 = 선칭량, Q7 허용)
       → { ok, batchId, source:'session'|'none', mode:'snapshot'|'template', productionStarted, currentNodeId, currentIndex, allDone,
           steps:[{nodeId, name, weigh, done}], weighNodeIds, weighNodeId, weighOpStarted, weighOpDone, preWeigh, weighActivity, preWeighActive, sessionIgnored }
       o.nodeId 를 주면 그 칭량 단계 기준 */
    function productionStage(batchId, o10) {
      o10 = o10 || {};
      var bid = str(batchId), rec = getBatch(bid);
      if (!rec) return { ok: false, why: 'no_batch', message: MSG.no_batch, batchId: bid };
      var snap = rec.snapshot || {}, pl = Array.isArray(snap.phaseList) ? snap.phaseList : [], nodes = Array.isArray(snap.nodes) ? snap.nodes : [];
      var nodeById = {}; nodes.forEach(function (n) { if (n && n.nodeId) nodeById[n.nodeId] = n; });
      var sesKey = opts.prodSessionKey || (global.EbrP0 && global.EbrP0.PROD_SESS_KEY) || null;
      var ses = sesKey ? readJson(sesKey, null) : null, sessionIgnored = sesKey ? null : 'no_session_key';
      if (ses && str(ses.batchId) === bid && ses.opDone && typeof ses.opDone === 'object') {
        if (ses.contentHash && rec.contentHash && !ses.demoMode && str(ses.contentHash) !== str(rec.contentHash)) { sessionIgnored = 'content_hash_mismatch'; ses = null; }
      } else { if (ses && ses.batchId) sessionIgnored = 'other_batch'; ses = null; }
      var template = ses ? Object.prototype.hasOwnProperty.call(ses.opDone, 'OP1-1') : (!!rec.demoSeed || !pl.length);
      var ids = ses ? Object.keys(ses.opDone) : (template ? PROD_TEMPLATE_STEPS.slice() : pl.map(function (p) { return str(p.id); }));
      var plById = {}; pl.forEach(function (p) { plById[str(p.id)] = p; });
      var isWeigh = function (id) {
        if (template) return id === 'OP1-1';
        var p = plById[id] || {}, n = nodeById[id] || {}, kind = p.kind || n.kind || n.phaseKind || '';
        return kind ? String(kind).toLowerCase() === 'weigh' : WEIGH_PHASE_REF.test(str(n.phaseRef));
      };
      var steps = ids.map(function (id) {
        var p = plById[id] || {};
        var done = ses ? !!ses.opDone[id] : false;
        return { nodeId: id, name: str(p.name || (nodeById[id] || {}).label || id), weigh: isWeigh(id), done: done };
      });
      var cur = -1; for (var i = 0; i < steps.length; i++) if (!steps[i].done) { cur = i; break; }
      var allDone = steps.length > 0 && cur < 0;
      var weighIds = steps.filter(function (x) { return x.weigh; }).map(function (x) { return x.nodeId; });
      var wid = o10.nodeId ? str(o10.nodeId) : (weighIds[0] || null);
      var widx = wid ? ids.indexOf(wid) : -1;
      var filter = template ? {} : (wid ? { nodeId: wid } : null);
      var autoDone = !!(filter && isOpAutoCompleted(bid, filter));
      var weighOpDone = widx >= 0 && (steps[widx].done || autoDone);
      var weighOpStarted = widx >= 0 && (weighOpDone || (ses ? (allDone || cur >= widx) : false));
      var sm = summary(bid), activity = !!(sm.ok && sm.byStatus && sm.byStatus.some(function (x) { return x.status && x.status !== 'PLANNED'; }));
      return { ok: true, batchId: bid, source: ses ? 'session' : 'none', mode: template ? 'template' : 'snapshot', productionStarted: !!ses,
               currentNodeId: allDone ? null : (steps[cur < 0 ? 0 : cur] || {}).nodeId || null, currentIndex: allDone ? steps.length : (cur < 0 ? 0 : cur), allDone: allDone,
               steps: steps, weighNodeIds: weighIds, weighNodeId: wid, weighFilter: filter, weighOpStarted: weighOpStarted, weighOpDone: weighOpDone,
               preWeigh: !weighOpStarted, weighActivity: activity, preWeighActive: activity && !weighOpStarted, sessionIgnored: sessionIgnored };
    }
    function isOpAutoCompleted(batchId, filter) { var o = dsLoad(), m = o.opAuto && o.opAuto[str(batchId)]; return m && m[opAutoKey(filter)] ? clone(m[opAutoKey(filter)]) : null; }
    function markOpAutoComplete(batchId, filter, o9) {
      o9 = o9 || {};
      var g = weighingGate(batchId, filter);
      if (!g.ok) return fail(g.why || 'pending', g.message || '칭량 미완료', { gate: g });
      var prev = isOpAutoCompleted(batchId, filter);
      if (prev) return { ok: true, already: true, at: prev.at, gate: g };
      var S = session(); if (!S) return fail('no_session', MSG.no_session);
      /* 자동 완료는 시스템 판정 — 감사 uid = 'SYSTEM' (명시). 그때 화면의 현재 사용자가 있으면 observedBy 로만 남긴다 (행위자 아님) */
      var cur = S.getCurrentUser && S.getCurrentUser(), observedBy = cur && cur.userId ? cur.userId : null;
      var at = nowIso(), orig = readRaw(KEYS.DISPENSE), o = dsLoad(), p = planOf(batchId), key = opAutoKey(filter);
      o.opAuto = o.opAuto || {}; o.opAuto[str(batchId)] = o.opAuto[str(batchId)] || {};
      o.opAuto[str(batchId)][key] = { at: at, by: 'SYSTEM', observedBy: observedBy, lineIds: g.lineIds };
      try {
        writeJson(KEYS.DISPENSE, o, 'dispense');
        var ae = { uid: 'SYSTEM', userName: '시스템', act: 'DISPENSE_OP_AUTO_COMPLETE', tgt: key.replace(/\|$/, '').replace(/^\|/, '') + ' · ' + str(batchId),
                   val: '칭량 ' + g.verified + '/' + g.total + ' VERIFIED · 열린 일탈 0 · ' + g.lineIds.join(', '), orderNo: p.ok ? p.orderNo : null, screen: o9.screen };
        if (observedBy) ae.observedBy = observedBy;
        S.Audit.appendMany([ae]);
      } catch (e) { restoreRaw(KEYS.DISPENSE, orig); return fail('save_error', MSG.save_error); }
      return { ok: true, already: false, at: at, gate: g };
    }

    return {
      VERSION: 1, KEYS: clone(KEYS), STATES: STATES.slice(), STATE_LABEL: clone(STATE_LABEL), TRANSITIONS: clone(TRANSITIONS), GATES: GATES.map(function (g) { return { gate: g[0], code: g[1], title: g[2], grade: WARN_GATES[g[0]] ? 'Warning' : 'Absolute' }; }),
      MAX_ATTEMPTS: MAX_ATTEMPTS, VOID_REASON_MAX: VOID_REASON_MAX, NEAR_LOT_DAYS: NEAR_LOT_DAYS, NEAR_CAL_DAYS: NEAR_CAL_DAYS, RULES: clone(RULES), MSG: clone(MSG), EQUIP_SEED: equipSeedFor(today()), equipSeed: function (t) { return equipSeedFor(t || today()); },
      /* 순수 */
      canTransition: canTransition, buildDispensePlan: function (input) {
        input = input || {};
        if (!Array.isArray(input.matLots)) { var cp = {}; Object.keys(input).forEach(function (k) { cp[k] = input[k]; }); cp.matLots = matLoad().lots; input = cp; }
        return buildDispensePlan(input);
      },
      applyPlanToBatch: function (batchRec, o5) {
        o5 = o5 || {};
        if (!Array.isArray(o5.matLots)) { var cp = {}; Object.keys(o5).forEach(function (k) { cp[k] = o5[k]; }); cp.matLots = matLoad().lots; o5 = cp; }
        return applyPlanToBatch(batchRec, o5);
      },
      dateDue: dateDue, lotDateState: lotDateState, summarizeGates: summarizeGates, simulate: simulate, capacityClass: capacityClass,
      CLASS_CAPACITY: clone(CLASS_CAPACITY), SOURCES: SOURCES.slice(),
      /* 조회 */
      getBatch: getBatch, planOf: planOf, listLines: listLines, getLine: getLine, get: get, getRecord: getRecord, listByBatch: listByBatch, summary: summary, labelData: labelData,
      /* 칭량 기록 조회 (S-45, 읽기 전용) */
      listRecords: listRecords, recordDetail: recordDetail, RECORD_STATE_GROUPS: clone(RECORD_STATE_GROUPS),
      /* 게이트 (L2 · L3) */
      gateCheck: gateCheck, judgeLot: judgeLot, judgeBalance: judgeBalance, judgeRoom: judgeRoom, qualifiedBalances: qualifiedBalances,
      /* 기록 (L1) */
      evaluateGates: evaluateGates, recordTare: recordTare, recordGross: recordGross, judge: judge, printLabel: printLabel, voidContainer: voidContainer,
      /* 서명 (L4 연결) */
      beginSign: beginSign, signAndCommit: signAndCommit, cancelSign: cancelSign,
      /* 설비 · 저울 배정 (L3 · B) · 시뮬레이터 (L6) */
      seedEquipment: seedEquipment, seedDemoBatch: seedDemoBatch, seedEffectiveTree: seedEffectiveTree, ensureSeeds: ensureSeeds, DEMO_BATCH_ID: DEMO_BATCH_ID, setDailyCheck: setDailyCheck, balancesInRoom: balancesInRoom, roomOf: roomOf, seedTerminals: seedTerminals, terminalsInRoom: terminalsInRoom, weighRooms: weighRooms, productionStage: productionStage, suggestBalances: suggestBalances, simulateReading: simulateReading,
      /* 큐 · OP 요약 · 완료 판정 · 자동 완료 (L7 · E16 · E17) */
      queue: queue, opSummary: opSummary, weighingGate: weighingGate, markOpAutoComplete: markOpAutoComplete, isOpAutoCompleted: isOpAutoCompleted,
      /* 인스턴스 */
      create: create,
      _test: { failNext: function (stage) { /* 'dispense'|'mat'|'dev'|'eq' */ failNextStage = stage || null; return failNextStage; }, daysUntil: daysUntil, round3: round3 }
    };
  }

  var API = create({});
  /* 순수 함수는 저장소 없이 바로 쓴다 (MatQC 보충 없이) */
  API.buildDispensePlanPure = buildDispensePlan;
  API.isWeighNode = isWeighNode;

  global.EbrDispense = API;
  /* 이 파일을 로드하면(브라우저 · localStorage 있음) 공용 기본 시드를 자동으로 저장소에 쓴다 — 로드 = 쓰기 (데모에 필요한 의도된 동작).
     설비 화면을 먼저 열지 않아도 생산 · 칭량이 같은 시드를 보게 하려는 것. 비어 있는 키 · 빠진 필드만 채우고(멱등) 사용자 값은 덮어쓰지 않는다.
     끄려면 로드 전에 window.EBR_DISPENSE_NO_AUTOSEED = true. node 시험(vm, navigator 없음)은 실행 안 함 */
  if (global.navigator && global.localStorage && !global.EBR_DISPENSE_NO_AUTOSEED) { try { API.ensureSeeds(); } catch (eSeed) { /* 저장 불가(file:// 정책 등) — 화면은 판정에서 fail-closed */ } }
  /* 기획 §9 L1 · L2 제안 이름 별칭 (ebr-p0-stores.js Weigh 는 그대로, gateCheck 만 추가) */
  if (global.EbrP0 && typeof global.EbrP0 === 'object') {
    global.EbrP0.Dispense = API;
    global.EbrP0.DISPENSE_KEY = KEYS.DISPENSE;
    if (global.EbrP0.Weigh && !global.EbrP0.Weigh.gateCheck) global.EbrP0.Weigh.gateCheck = API.gateCheck;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
