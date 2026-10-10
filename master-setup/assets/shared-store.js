/* =====================================================================
   shared-store.js — eMBR 기준정보 PoC v2 공용 저장소 (전역 MS)
   - 한 개의 localStorage 키(ebmr.masterSetup.v2)를 ADM(GCM) · EBR(도메인 마스터) 모든 화면이 공유
   - GCM 코드 = 각 도메인 마스터 콤보 · 뱃지 소스 (시드 제공. adm 화면은 조회 전용 — 실제 관리는 제품 AdmSetupCode*)
   - 외부 연계 mock (읽기전용, 저장 안 함): RAS 설비 마스터 · CMMS 계측기 교정 · CFMS 설비 적격성
     → 장비 클래스는 설비 '개체 ID'만 RAS 에서 재사용. RAS Type/Group · CFMS Group 은 장비 클래스가 아님.
   외부 의존 없음. mesui.js 보다 뒤, 화면 스크립트보다 앞에 로드.
   ===================================================================== */
(function (global) {
  'use strict';
  var MS = {};
  var LS_KEY = MS.LS_KEY = 'ebmr.masterSetup.v2';
  var VERSION = 3;
  /* 현재 사용자 이름 — ebr-user-session.js(EbrUserSession)의 ebmr.currentUser.v1 기준 (UI-09).
     헬퍼 미로드 · 선택 없음이면 기본값. 대입(MS.USER = …)은 기본값을 바꾼다 */
  var DEFAULT_USER = '김민수';
  Object.defineProperty(MS, 'USER', {
    enumerable: true, configurable: true,
    get: function () {
      var S = global.EbrUserSession;
      try { return S && typeof S.currentUserName === 'function' ? S.currentUserName(DEFAULT_USER) : DEFAULT_USER; } catch (e) { return DEFAULT_USER; }
    },
    set: function (v) { DEFAULT_USER = v; }
  });
  function pad(v) { return (v < 10 ? '0' : '') + v; }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  MS.TODAY = ymd(new Date());
  MS.ymd = ymd;
  MS.daysTo = function (date) { if (!date) return null; return Math.round((new Date(date + 'T00:00:00') - new Date(MS.TODAY + 'T00:00:00')) / 86400000); };

  /* ------------------------------------------------------------------ 유틸 */
  var esc = MS.esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var clone = MS.clone = function (o) { return JSON.parse(JSON.stringify(o)); };
  MS.$ = function (s, r) { return (r || document).querySelector(s); };
  MS.$$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  /* 콘텐츠 해시 흉내 (FNV-1a 4회 → 32 hex). 운영 · 표시 전용 필드는 제외 */
  function fnv(s, seed) { var h = seed >>> 0; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return ('0000000' + h.toString(16)).slice(-8); }
  var HASH_SKIP = ['hash', 'status', 'upd', 'effDate', 'wu', 'online', 'beat', 'pkg', 'frozen', 'members', 'eqRefHashNow'];
  MS.calcHash = function (row) {
    var o = {};
    Object.keys(row).sort().forEach(function (k) { if (HASH_SKIP.indexOf(k) < 0) o[k] = row[k]; });
    /* 장비 클래스: 적격 설비는 '개체 ID 목록'만 해시 대상 (이름 · 작업실 · 교정은 RAS/CMMS 런타임 값이라 제외) */
    if (row.members) o.memberIds = row.members.map(function (m) { return m.equipId; }).sort();
    var s = JSON.stringify(o);
    return fnv(s, 0x811c9dc5) + fnv(s, 0x01000193) + fnv(s, 0x2c59d9) + fnv(s, 0x37b284);
  };

  /* ================================================================== 외부 연계 mock (RAS · CMMS · CFMS) — 읽기전용 */
  var AREAS = [['R-201', '칭량실 1'], ['R-202', '칭량실 2'], ['R-210', '과립실'], ['R-215', '혼합실'], ['R-220', '타정실 1'], ['R-221', '타정실 2'], ['R-230', '코팅실'],
    ['R-240', '캡슐 충전실'], ['R-250', '액제 조제실'], ['R-260', '포장실 1'], ['R-261', '포장실 2'], ['QC-101', 'QC 기기실']].map(function (a) { return { areaCode: a[0], areaDesc: a[1] }; });
  /* RAS 설비 마스터 (equipCode · equipDesc · areaCode · equipStatus + 참조용 RAS Type/Group, CFMS Group) */
  function RE(code, desc, model, area, st, type, group, cfmsGroup, measuring) {
    return { equipCode: code, equipDesc: desc, model: model, areaCode: area, equipStatus: st, rasType: type, rasGroup: group, cfmsGroup: cfmsGroup, measuring: !!measuring };
  }
  var RAS = [
    RE('BAL-101', '정밀 저울 #101', 'Mettler XPR6002', 'R-201', 'RUN', 'BALANCE', 'WEIGHING', 'CFMS-WGT', true),
    RE('BAL-102', '정밀 저울 #102', 'Mettler XPR6002', 'R-202', 'RUN', 'BALANCE', 'WEIGHING', 'CFMS-WGT', true),
    RE('BAL-205', '정밀 저울 #205', 'Sartorius Cubis II', 'R-202', 'IDLE', 'BALANCE', 'WEIGHING', 'CFMS-WGT', true),
    RE('BAL-206', '정밀 저울 #206', 'Sartorius Cubis II', 'R-201', 'RUN', 'BALANCE', 'WEIGHING', 'CFMS-WGT', true),
    RE('BAL-301', '플로어 저울 #301', 'Mettler PFK9', 'R-201', 'RUN', 'BALANCE', 'WEIGHING', 'CFMS-WGT', true),
    RE('BAL-302', '플로어 저울 #302', 'Mettler PFK9', 'R-202', 'RUN', 'BALANCE', 'WEIGHING', 'CFMS-WGT', true),
    RE('BAL-303', '플로어 저울 #303', 'Mettler PFK9', 'R-260', 'RUN', 'BALANCE', 'WEIGHING', 'CFMS-WGT', true),
    RE('GR-01', '고속 혼합 과립기 #1', 'Glatt VG 300', 'R-210', 'RUN', 'GRANULATOR', 'SOLID_PROC', 'CFMS-SOLID'),
    RE('GR-02', '고속 혼합 과립기 #2', 'Glatt VG 600', 'R-210', 'PM', 'GRANULATOR', 'SOLID_PROC', 'CFMS-SOLID'),
    RE('FBD-01', '유동층 건조기 #1', 'Glatt GPCG 120', 'R-210', 'RUN', 'DRYER', 'SOLID_PROC', 'CFMS-SOLID'),
    RE('MX-01', '빈 혼합기 #1', 'Bohle PM 600', 'R-215', 'RUN', 'MIXER', 'SOLID_PROC', 'CFMS-SOLID'),
    RE('MX-02', '빈 혼합기 #2', 'Bohle PM 600', 'R-215', 'IDLE', 'MIXER', 'SOLID_PROC', 'CFMS-SOLID'),
    RE('TP-01', '로터리 타정기 #1', 'Fette 2090i', 'R-220', 'RUN', 'TABLET_PRESS', 'SOLID_PROC', 'CFMS-SOLID'),
    RE('TP-02', '로터리 타정기 #2', 'Fette 2090i', 'R-221', 'RUN', 'TABLET_PRESS', 'SOLID_PROC', 'CFMS-SOLID'),
    RE('TP-03', '로터리 타정기 #3', 'Korsch XL 400', 'R-221', 'IDLE', 'TABLET_PRESS', 'SOLID_PROC', 'CFMS-SOLID'),
    RE('TP-09', '로터리 타정기 #9 (구형)', 'Fette 1200', 'R-220', 'SCRAP', 'TABLET_PRESS', 'SOLID_PROC', 'CFMS-SOLID'),
    RE('CT-01', '팬 코팅기 #1', 'O\'Hara Labcoat', 'R-230', 'RUN', 'COATER', 'SOLID_PROC', 'CFMS-SOLID'),
    RE('CF-01', '자동 캡슐 충전기 #1', 'Bosch GKF 2600', 'R-240', 'RUN', 'CAPSULE_FILLER', 'SOLID_PROC', 'CFMS-SOLID'),
    RE('LF-01', '액상 충전 · 캡핑기 #1', 'Groninger DFV', 'R-250', 'RUN', 'LIQUID_FILLER', 'LIQUID_PROC', 'CFMS-LIQ'),
    RE('PK-01', 'PTP 포장기 #1', 'Uhlmann B 1440', 'R-260', 'RUN', 'BLISTER', 'PACKAGING', 'CFMS-PKG'),
    RE('PK-02', '카토너 #2', 'CAM M90', 'R-260', 'RUN', 'CARTONER', 'PACKAGING', 'CFMS-PKG'),
    RE('PK-03', 'PTP 포장기 #3', 'Uhlmann B 1440', 'R-261', 'DOWN', 'BLISTER', 'PACKAGING', 'CFMS-PKG'),
    RE('HT-01', '정제 경도계 #1', 'Sotax ST50', 'R-220', 'RUN', 'IPC_TESTER', 'INSTRUMENT', 'CFMS-INST', true),
    RE('HT-02', '정제 경도계 #2', 'Sotax ST50', 'R-221', 'RUN', 'IPC_TESTER', 'INSTRUMENT', 'CFMS-INST', true),
    RE('PH-01', 'pH 미터 #1', 'Mettler SevenExcellence', 'R-250', 'RUN', 'ANALYZER', 'INSTRUMENT', 'CFMS-INST', true),
    RE('TT-01', '온도 기록계 #1', 'Yokogawa GX20', 'R-210', 'RUN', 'RECORDER', 'INSTRUMENT', 'CFMS-INST', true),
    RE('MD-01', '금속 검출기 #1', 'Mettler Safeline', 'R-260', 'RUN', 'DETECTOR', 'INSTRUMENT', 'CFMS-INST', true),
    RE('KF-01', '수분 측정기 (QC)', 'Metrohm 917', 'QC-101', 'RUN', 'ANALYZER', 'INSTRUMENT', 'CFMS-QC', true)
  ];
  /* CMMS 계측기 교정 (측정 설비만) — equipCode → instId · calDue */
  var CMMS = {
    'BAL-101': ['CI-0101', '2027-01-15'], 'BAL-102': ['CI-0102', '2026-12-03'], 'BAL-205': ['CI-0205', '2026-10-12'], 'BAL-206': ['CI-0206', '2027-03-10'],
    'BAL-301': ['CI-0301', '2027-02-20'], 'BAL-302': ['CI-0302', '2026-09-30'], 'BAL-303': ['CI-0303', '2027-04-11'],
    'HT-01': ['CI-1101', '2026-11-02'], 'HT-02': ['CI-1102', '2026-10-20'], 'PH-01': ['CI-1201', '2027-01-30'], 'TT-01': ['CI-1301', '2026-08-31'],
    'MD-01': ['CI-1401', '2027-02-02'], 'KF-01': ['CI-9001', '2027-05-01']
  };
  /* CFMS 설비 적격성 (IQ/OQ/PQ · 재적격성 기한). pending = 적격성 진행 중 */
  var CFMS = {
    'GR-01': ['PQ', '2027-03-01'], 'GR-02': ['IQ', '', 'pending'], 'FBD-01': ['PQ', '2027-01-10'], 'MX-01': ['PQ', '2026-11-28'], 'MX-02': ['PQ', '2027-04-02'],
    'TP-01': ['PQ', '2027-02-14'], 'TP-02': ['PQ', '2026-12-19'], 'TP-03': ['PQ', '2027-05-30'], 'TP-09': ['PQ', '2024-06-30'], 'CT-01': ['PQ', '2026-10-20'],
    'CF-01': ['PQ', '2027-01-08'], 'LF-01': ['PQ', '2027-02-02'], 'PK-01': ['PQ', '2026-12-12'], 'PK-02': ['PQ', '2027-03-21'], 'PK-03': ['PQ', '2027-01-15']
  };
  var RAS_STATUS = { RUN: ['가동', 'ok'], IDLE: ['대기', 'info'], PM: ['예방정비', 'warn'], DOWN: ['고장', 'error'], SCRAP: ['폐기', 'muted'] };
  function dueState(date, warnDays) {
    var d = MS.daysTo(date);
    if (d == null) return 'na';
    return d < 0 ? 'expired' : d <= (warnDays || 30) ? 'due' : 'ok';
  }
  MS.ext = {
    areas: AREAS, ras: RAS, rasStatus: RAS_STATUS,
    area: function (code) { return AREAS.filter(function (a) { return a.areaCode === code; })[0]; },
    rasEq: function (code) { return RAS.filter(function (e) { return e.equipCode === code; })[0]; },
    cmms: function (code) { var c = CMMS[code]; return c ? { instId: c[0], calDue: c[1], calState: dueState(c[1]) } : null; },
    cfms: function (code) {
      var q = CFMS[code]; var e = MS.ext.rasEq(code);
      if (!q && e && e.measuring) return { qualType: '교정 기반', qualDue: '', qualState: 'na' };   /* 계측기는 교정으로 적격 판단 */
      if (!q) return null;
      return { qualType: q[0], qualDue: q[1], qualState: q[2] || dueState(q[1]) };
    },
    /* 런타임 파생 값: 표시명 · 작업실 · 상태(RAS) + 교정(CMMS) + 적격성(CFMS) */
    runtime: function (code) {
      var e = MS.ext.rasEq(code);
      if (!e) return { exists: false, equipId: code };
      var a = MS.ext.area(e.areaCode) || {}, c = MS.ext.cmms(code), q = MS.ext.cfms(code);
      return { exists: true, equipId: code, name: e.equipDesc, model: e.model, area: e.areaCode, areaDesc: a.areaDesc || '', status: e.equipStatus,
               measuring: e.measuring, cmmsId: c ? c.instId : '', calDue: c ? c.calDue : '', calState: c ? c.calState : 'na',
               qualType: q ? q.qualType : '', qualDue: q ? q.qualDue : '', qualState: q ? q.qualState : 'na' };
    },
    /* 적격 설비로 '추가 가능' 판정 — 폐기 · 적격성 미확보는 불가, 교정 만료는 경고(실행 시 Absolute 차단) */
    pickable: function (code) {
      var r = MS.ext.runtime(code);
      if (!r.exists) return { ok: false, why: 'RAS 설비 마스터에 없음' };
      if (r.status === 'SCRAP') return { ok: false, why: 'RAS 폐기 설비' };
      if (r.qualState === 'pending') return { ok: false, why: 'CFMS 적격성 진행 중 (IQ/OQ 미완)' };
      if (r.qualState === 'expired') return { ok: false, why: 'CFMS 재적격성 기한 경과' };
      if (r.calState === 'expired') return { ok: true, warn: 'CMMS 교정 만료 — 실행 시 Absolute 차단' };
      return { ok: true };
    }
  };
  MS.snapOf = function (code, by) {
    var r = MS.ext.runtime(code);
    return { name: r.name || '', area: r.area || '', status: r.status || '', calDue: r.calDue || '', qualState: r.qualState || '', at: MS.TODAY, by: by || MS.USER };
  };

  /* ================================================================== 시드: GCM (ADM 패턴, 11개 EBR_* 신규 시드) */
  function C(colKey, colName, colDesc, colType) { return { colKey: colKey, colName: colName, colDesc: colDesc, colType: colType || 'STRING' }; }
  function R(key1, keyDesc, data, disable) { var r = { key1: key1, keyDesc: keyDesc, disableFlag: !!disable }; (data || []).forEach(function (d, i) { r['data' + (i + 1)] = d; }); return r; }
  function seedGcm() {
    var KEY = C('key1', 'CODE', '코드');
    var defs = [
      { tableName: 'EBR_DOSAGE_FORM', tableDesc: '제형', cols: [KEY, C('data1', 'NAME_EN', '영문명'), C('data2', 'BATCH_UNIT', '배치 단위'), C('data3', 'COUNT_UNIT', '수량 단위'), C('data4', 'MES_PROD_TYPE', 'MES 제품 유형')],
        use: { phase: '적용 제형', eqclass: '적용 제형', etc: 'S-01 MBR 제품 제형 · S-11 이론 수량 단위' },
        rows: [R('tablet', '정제', ['Tablet', 'kg', '정', 'FG-TAB']), R('capsule', '캡슐', ['Capsule', 'kg', '캡슐', 'FG-CAP']), R('liquid', '액제', ['Liquid', 'L', 'mL', 'FG-LIQ']), R('powder', '산제 (2차)', ['Powder', 'kg', '포', 'FG-PWD'], true)] },
      { tableName: 'EBR_MBR_STATUS', tableDesc: '수명주기 상태 (MBR · 도메인 마스터 공용)', cols: [KEY, C('data1', 'BADGE_CLASS', '뱃지'), C('data2', 'BG_COLOR', '배경색'), C('data3', 'NEXT_STATUS', '다음 상태'), C('data4', 'EDITABLE', '편집 가능', 'CHECKBOX')],
        use: { phase: '상태 뱃지 · 전이', config: '상태 뱃지 · 전이', sign: '상태 뱃지 · 전이', terminal: '바인딩 상태', eqclass: '상태 뱃지 · 전이', etc: 'S-01 MBR 수명주기 · S-11 발행 가능 판정' },
        rows: [R('draft', '초안', ['lc-draft', '#e6e6e7', 'review', true]), R('review', '검토', ['lc-review', '#CCEBFF', 'approved', false]), R('approved', '승인', ['lc-approved', '#EBE0F7', 'pending', false]),
               R('pending', '효력 대기', ['lc-pending', '#CCEBFF', 'effective', false]), R('effective', '효력', ['lc-effective', '#E2F8CC', 'superseded', false]),
               R('superseded', '대체', ['lc-superseded', '#e6e6e7', 'retired', false]), R('retired', '폐기', ['lc-retired', '#F9D5D1', '', false])] },
      { tableName: 'EBR_ORDER_STATUS', tableDesc: 'eBR 오더 상태', cols: [KEY, C('data1', 'BADGE_CLASS', '뱃지'), C('data2', 'BG_COLOR', '배경색'), C('data3', 'NEXT_STATUS', '다음 상태'), C('data4', 'EDITABLE', '편집 가능', 'CHECKBOX')],
        use: { order: '오더 상태 필터 · 뱃지', etc: 's-ebr-order-ui · 배치 발행 전 오더' },
        rows: [R('draft', '초안', ['os-draft', '#e6e6e7', 'planned', true]), R('planned', '계획', ['os-planned', '#CCEBFF', 'released', true]),
               R('released', '릴리즈', ['os-released', '#CCEBFF', 'in_progress', false]), R('in_progress', '진행', ['os-in_progress', '#FFF6D6', 'completed', false]),
               R('completed', '완료', ['os-completed', '#E2F8CC', '', false]), R('on_hold', '보류', ['os-on_hold', '#ffedd5', 'in_progress', true]),
               R('cancelled', '취소', ['os-cancelled', '#F9D5D1', '', false])] },
      { tableName: 'EBR_AUTHORING_SCOPE', tableDesc: '저작 범위', cols: [KEY, C('data1', 'TRANSFER_PKG', '이관 패키지', 'CHECKBOX'), C('data2', 'RULE_TEXT', '규칙')],
        use: { phase: '저작 범위', config: '저작 범위', etc: 'S-02 디자이너 조합/로직 경계 (R-L1-1)' },
        rows: [R('runtime_ok', '운영 허용', [false, '검증된 객체의 조합 + 값 입력만 — 운영 환경 저작 가능']), R('transfer_required', '이관 필수', [true, '로직성 객체 — 개발 → 검증 → 운영 이관, 콘텐츠 해시 대조'])] },
      { tableName: 'EBR_INTERLOCK_GRADE', tableDesc: '인터록 등급 (4단계)', cols: [KEY, C('data1', 'OI_DISPLAY', '화면 표시'), C('data2', 'DOT_COLOR', '등급 색'), C('data3', 'OVERRIDE', 'override', 'CHECKBOX'), C('data4', 'PRIORITY', '우선순위', 'NUMBER')],
        use: { config: 'S-08 등급 동작 정의표', etc: 'S-17 인터록 배너 · S-19 사유 코드 · S-20 현장 예외' },
        rows: [R('Absolute', '절대 차단', ['멈춤', 'red', false, 1]), R('Hard-QA', 'QA 승인 필수', ['QA 호출', 'red', true, 2]), R('Controlled', '감독자 승인', ['감독자 승인', 'amber', true, 3]), R('Warning', '경고', ['확인 후 진행', 'navy', true, 4])] },
      { tableName: 'EBR_CONFIG_KIND', tableDesc: '설정 객체 kind', cols: [KEY, C('data1', 'ID_PREFIX', 'ID 접두'), C('data2', 'DEFAULT_SCOPE', '기본 저작 범위'), C('data3', 'RELEASE', '릴리즈'), C('data4', 'IN_MANIFEST', '매니페스트', 'CHECKBOX')],
        use: { config: 'kind 필터 · 본문 스키마', etc: 'S-11 · S-12 매니페스트 kind' },
        rows: [R('interlock', '인터록 룰', ['ILR', 'runtime_ok', '1차', true]), R('criticality', '중요도 사전', ['CD', 'runtime_ok', '1차', true]), R('rbe', 'RBE 규칙', ['RBE', 'transfer_required', '1차', true]),
               R('formula', '계산식', ['FX', 'runtime_ok', '1차', true]), R('parser', '파서 규칙', ['PR', 'transfer_required', '1차', true]), R('historian', '히스토리안 기준선', ['HB', 'runtime_ok', '1차', true]),
               R('lint', '설계 린트 규칙', ['LR', 'transfer_required', '2차', false], true), R('changeover', '전환 매트릭스', ['CM', 'runtime_ok', '2차', false], true), R('scale_baseline', '저울 기준선', ['SB', 'runtime_ok', '2차', false], true)] },
      { tableName: 'EBR_SIGN_MEANING', tableDesc: '서명 의미 (Part 11 §11.50)', cols: [KEY, C('data1', 'COLOR', '색상'), C('data2', 'MEANING_EN', '영문 의미'), C('data3', 'DEFAULT_AUTH', '기본 인증 강도'), C('data4', 'BATCH_ALLOWED', '일괄 허용', 'CHECKBOX')],
        use: { sign: '서명 의미 · 색', etc: 'S-27 전자서명 팝업 제목 · 색 · 문장' },
        rows: [R('performed', '수행', ['#2C59D9', 'Performed by', 'pin_session', false]), R('verified', '확인', ['#37b284', 'Verified by', 'full_factor', false]), R('approved', '승인', ['#0b043e', 'Approved by', 'full_factor', false]),
               R('read_understood', '읽고 이해함', ['#0091eb', 'Read & Understood', 'pin_session', true]), R('reviewed', '검토', ['#6952db', 'Reviewed by', 'full_factor', true])] },
      { tableName: 'EBR_AUTH_STRENGTH', tableDesc: '인증 강도', cols: [KEY, C('data1', 'FACTORS', '요소 수', 'NUMBER'), C('data2', 'SESSION_REUSE', '세션 재사용', 'CHECKBOX'), C('data3', 'RULE_TEXT', '설명')],
        use: { config: 'S-08 인증 강도', sign: '요구 인증 강도', terminal: '기본 인증 수단', etc: 'S-27 전자서명 · S-28 세션 전환' },
        rows: [R('pin_session', '연속 세션 PIN', [1, true, '세션 유효 중 PIN만 — 수행 서명 전용']), R('full_factor', '전 요소', [2, false, '사원증/RFID + PIN 또는 ID + 비밀번호 — 확인 · 승인 고정']), R('biometric_opt', '생체 옵션', [2, false, '지정맥 · 지문 (장갑 탈의 구역 옵션)'])] },
      { tableName: 'EBR_TERMINAL_TYPE', tableDesc: '단말 유형', cols: [KEY, C('data1', 'SCREEN', '화면'), C('data2', 'LOCK_MIN', '기본 잠금(분)', 'NUMBER'), C('data3', 'PROX_READER', '근접 리더', 'CHECKBOX'), C('data4', 'ZONE', '설치 구역')],
        use: { terminal: '단말 유형', etc: 'S-16 · S-28 OI 세션 정책' },
        rows: [R('fixed_panel', '고정 패널', ['21.5" 터치', 5, true, 'Grade C/D']), R('cart', '이동 카트', ['15.6" 터치', 3, true, 'Grade C/D']), R('explosion_proof', '방폭', ['15" 방폭 터치', 3, false, 'Zone 1 (과립 · 코팅)'])] },
      { tableName: 'EBR_EVIDENCE_TYPE', tableDesc: '증거 유형 (항목 속성 ⑤)', cols: [KEY, C('data1', 'ORIGIN', '출처 origin'), C('data2', 'PHOTO_POPUP', '사진 팝업', 'CHECKBOX'), C('data3', 'RULE_TEXT', '설명')],
        use: { phase: '증거 유형 기본값', etc: 'S-17 출처 플래그 · S-22 사진 증거' },
        rows: [R('auto', '연동', ['AUTO', false, '설비 · 계측 직접 연동']), R('scan', '스캔', ['MANUAL+SCAN', false, '바코드 · 라벨 스캔']), R('photo', '사진', ['MANUAL+PHOTO', true, '앱 내 카메라 · 해시 · 서버 시각 (S-22)']), R('none', '없음', ['MANUAL', false, '수기 입력 — 확인 서명으로 보증'])] },
      { tableName: 'EBR_PHASE_KIND', tableDesc: 'Phase 유형', cols: [KEY, C('data1', 'DEFAULT_EC_PREFIX', '기본 장비 클래스 접두 (제안)'), C('data2', 'DOSAGE_FORMS', '적용 제형'), C('data3', 'OI_TEMPLATE', 'OI 템플릿')],
        use: { phase: 'Phase 유형', eqclass: '적용 Phase 유형', etc: 'S-02 디자이너 라이브러리 패널' },
        rows: [R('weigh', '칭량', ['EC-BAL', 'tablet,capsule,liquid', 'T-07']), R('granulate', '과립 · 건조', ['EC-GRN', 'tablet,capsule', 'T-06']), R('mix', '혼합', ['EC-MIX', 'tablet,capsule,liquid', 'T-06']),
               R('compress', '타정', ['EC-TAB', 'tablet', 'T-06']), R('coat', '코팅', ['EC-COT', 'tablet', 'T-06']), R('fill', '캡슐 충전', ['EC-CAP', 'capsule', 'T-06']),
               R('liquidFill', '액상 충전', ['EC-LFL', 'liquid', 'T-06']), R('pack', '포장', ['EC-PKG', 'tablet,capsule,liquid', 'T-06'])] }
    ];
    var tables = [], data = {};
    defs.forEach(function (d, i) {
      /* 제품 CodeTable 에는 module 컬럼이 없음 → EBR_ 접두 + ADM 폴더로 구분. newSeed: 제품에 아직 없는 신규 시드 */
      tables.push({ tableName: d.tableName, tableDesc: d.tableDesc, seqNoFlag: true, sys: true, newSeed: true, cols: d.cols, use: d.use, upd: '2026-09-' + (10 + i) });
      data[d.tableName] = d.rows.map(function (r, j) { r.seqNo = j + 1; return r; });
    });
    return { tables: tables, data: data };
  }

  /* ================================================================== 시드: EBR 도메인 마스터 */
  MS.USERS = [['이수진', 'QA'], ['박정훈', 'QA'], ['정다은', 'QA'], ['최민아', '생산 감독자'], ['한승우', '공정 엔지니어'], ['김민수', 'MES 관리자']];
  function seedDomain() {
    /* --- 장비 클래스 (MBR-02): 요구 능력 + 버전별 적격 설비(RAS 개체 ID) + GMP 수명주기 + 해시 */
    function M(equipId, at, over) { var s = MS.snapOf(equipId, '한승우'); s.at = at; if (over) Object.keys(over).forEach(function (k) { s[k] = over[k]; }); return { equipId: equipId, src: 'RAS', snap: s }; }
    function CAP(item, op, val, unit) { return { item: item, op: op, val: val, unit: unit }; }
    function EC(id, ver, name, kind, dosage, caps, capNote, members, status, wu, upd, frozenAt) {
      var r = { id: id, ver: ver, name: name, kind: kind, dosage: dosage, caps: caps, capability: capNote, members: members, status: status, wu: wu, upd: upd, author: '한승우' };
      if (frozenAt) r.frozen = { at: frozenAt, by: '이수진' };
      members.forEach(function (m) { m.snap.kind = frozenAt ? 'approve' : 'add'; });
      return r;
    }
    var eqclass = [
      EC('EC-BAL-01', 3, '정밀 저울 (≤ 6 kg)', 'weigh', ['tablet', 'capsule', 'liquid'],
        [CAP('최대 용량', '≥', '6', 'kg'), CAP('판독 한계', '≤', '0.01', 'g'), CAP('인터페이스', '=', 'SICS', ''), CAP('교정', '=', '유효', 'CMMS')], '일일 점검 수행 · 수평계 확인',
        [M('BAL-101', '2026-07-02'), M('BAL-102', '2026-07-02'), M('BAL-205', '2026-07-02', { area: 'R-201', status: 'RUN' })], 'effective', 7, '2026-07-02', '2026-07-02'),
      EC('EC-BAL-02', 2, '플로어 저울 (≤ 300 kg)', 'weigh', ['tablet', 'capsule', 'liquid'],
        [CAP('최대 용량', '≥', '300', 'kg'), CAP('판독 한계', '≤', '10', 'g'), CAP('교정', '=', '유효', 'CMMS')], '',
        [M('BAL-301', '2026-07-02'), M('BAL-302', '2026-07-02', { calDue: '2026-09-30' })], 'effective', 3, '2026-07-02', '2026-07-02'),
      EC('EC-GRN-01', 2, '고속 혼합 과립기 (300 L)', 'granulate', ['tablet', 'capsule'],
        [CAP('용기 용량', '=', '300', 'L'), CAP('임펠러 · 초퍼 속도 기록', '=', '자동', ''), CAP('전류 종점 감지', '=', '지원', '')], '', [M('GR-01', '2026-05-20')], 'effective', 3, '2026-05-20', '2026-05-20'),
      EC('EC-FBD-01', 1, '유동층 건조기', 'granulate', ['tablet', 'capsule'],
        [CAP('급기 · 배기 온도', '=', '히스토리안 연동', ''), CAP('방폭', '=', 'Zone 1', '')], '', [M('FBD-01', '2026-05-20')], 'effective', 3, '2026-05-20', '2026-05-20'),
      EC('EC-MIX-01', 2, 'V형 · 빈 혼합기 (600 L)', 'mix', ['tablet', 'capsule'],
        [CAP('용기 용량', '≥', '600', 'L'), CAP('회전수 · 시간 기록', '=', '자동', '')], '', [M('MX-01', '2026-08-20'), M('MX-02', '2026-08-20')], 'effective', 5, '2026-08-20', '2026-08-20'),
      EC('EC-TAB-01', 3, '로터리 타정기', 'compress', ['tablet'],
        [CAP('타정압 피드백', '=', '지원', ''), CAP('IPC 연동', '=', '중량 · 경도', '')], '', [M('TP-01', '2026-04-02'), M('TP-02', '2026-04-02')], 'effective', 3, '2026-04-02', '2026-04-02'),
      EC('EC-TAB-01', 4, '로터리 타정기 (두께 IPC 추가)', 'compress', ['tablet'],
        [CAP('타정압 피드백', '=', '지원', ''), CAP('IPC 연동', '=', '중량 · 경도 · 두께 자동', '')], 'TP-03 신규 설치 (CFMS PQ 완료)', [M('TP-01', '2026-10-02'), M('TP-02', '2026-10-02'), M('TP-03', '2026-10-02')], 'draft', 0, '2026-10-02'),
      EC('EC-IPC-01', 1, '정제 경도계 (IPC)', 'compress', ['tablet'],
        [CAP('측정 범위', '≥', '400', 'N'), CAP('교정', '=', '유효', 'CMMS')], '타정 Phase IPC 단계용 계측기 클래스', [M('HT-01', '2026-09-28'), M('HT-02', '2026-09-28')], 'review', 0, '2026-09-28'),
      EC('EC-COT-01', 1, '팬 코팅기', 'coat', ['tablet'],
        [CAP('분무 속도 · 배기 온도', '=', '기록', ''), CAP('방폭', '=', 'Zone 1', '')], '', [M('CT-01', '2026-03-11')], 'effective', 1, '2026-03-11', '2026-03-11'),
      EC('EC-CAP-01', 1, '자동 캡슐 충전기', 'fill', ['capsule'],
        [CAP('충전 중량 선별', '=', '100 %', ''), CAP('캡슐 크기', '=', '0~4호', '')], '', [M('CF-01', '2026-03-11')], 'effective', 1, '2026-03-11', '2026-03-11'),
      EC('EC-LFL-01', 1, '액상 충전 · 캡핑기', 'liquidFill', ['liquid'],
        [CAP('충전량 IPC', '=', '지원', ''), CAP('캡핑 토크 기록', '=', '자동', '')], '', [M('LF-01', '2026-03-11')], 'effective', 1, '2026-03-11', '2026-03-11'),
      EC('EC-PKG-01', 2, 'PTP 포장기', 'pack', ['tablet', 'capsule'],
        [CAP('비전 검사', '=', '지원', ''), CAP('라벨 · 바코드 대조', '=', '지원', '')], '', [M('PK-01', '2026-06-10'), M('PK-02', '2026-06-10')], 'effective', 4, '2026-06-10', '2026-06-10')
    ];
    eqclass.forEach(function (r) { r.hash = MS.calcHash(r); });
    function ecRef(id) {   /* Phase → 장비 클래스 참조: 효력 버전의 (ID, 버전, 해시) */
      var e = eqclass.filter(function (x) { return x.id === id && x.status === 'effective'; })[0];
      return e ? { id: e.id, ver: e.ver, hash: e.hash } : { id: id, ver: 0, hash: '' };
    }

    /* --- S-03 Phase */
    function P(id, ver, name, kind, dosage, eq, ev, scope, valid, status, wu, upd, author) {
      return { id: id, ver: ver, name: name, kind: kind, dosage: dosage, eqRef: ecRef(eq), evidence: ev, scope: scope, valid: valid, status: status, wu: wu, upd: upd, author: author || '한승우', desc: '' };
    }
    var phase = [
      P('PH-WEIGH-01', 4, '원료 칭량 (단일 LOT)', 'weigh', ['tablet', 'capsule', 'liquid'], 'EC-BAL-01', 'auto', 'transfer_required', 'validated', 'effective', 7, '2026-07-15'),
      P('PH-WEIGH-02', 2, '다중 LOT 칭량 · 역가 보정', 'weigh', ['tablet', 'capsule'], 'EC-BAL-01', 'auto', 'transfer_required', 'validated', 'effective', 4, '2026-06-02'),
      P('PH-WEIGH-02', 3, '다중 LOT 칭량 · 역가 보정 (보정 그룹)', 'weigh', ['tablet', 'capsule'], 'EC-BAL-01', 'auto', 'transfer_required', 'not_validated', 'draft', 0, '2026-10-02'),
      P('PH-WEIGH-03', 1, '대용량 칭량 (부형제)', 'weigh', ['tablet', 'capsule', 'liquid'], 'EC-BAL-02', 'auto', 'transfer_required', 'validated', 'effective', 3, '2026-07-10'),
      P('PH-GRAN-01', 3, '고속 습식 과립', 'granulate', ['tablet', 'capsule'], 'EC-GRN-01', 'auto', 'transfer_required', 'validated', 'effective', 3, '2026-05-21'),
      P('PH-DRY-01', 2, '유동층 건조 (LOD 판정)', 'granulate', ['tablet', 'capsule'], 'EC-FBD-01', 'auto', 'transfer_required', 'validated', 'effective', 3, '2026-05-21'),
      P('PH-MIX-01', 5, '최종 혼합 (활택제 · 회전수 IPC)', 'mix', ['tablet', 'capsule'], 'EC-MIX-01', 'auto', 'transfer_required', 'validated', 'effective', 5, '2026-08-28'),
      P('PH-COMP-01', 3, '타정 · IPC (중량 · 경도)', 'compress', ['tablet'], 'EC-TAB-01', 'auto', 'transfer_required', 'validated', 'effective', 3, '2026-04-09'),
      P('PH-COMP-01', 4, '타정 · IPC (중량 · 경도 · 두께)', 'compress', ['tablet'], 'EC-TAB-01', 'auto', 'transfer_required', 'validating', 'review', 0, '2026-09-29'),
      P('PH-COAT-01', 2, '필름 코팅 (분무 · 건조)', 'coat', ['tablet'], 'EC-COT-01', 'auto', 'transfer_required', 'validated', 'approved', 0, '2026-09-18'),
      P('PH-FILL-01', 1, '캡슐 충전 · 중량 선별', 'fill', ['capsule'], 'EC-CAP-01', 'auto', 'transfer_required', 'validated', 'effective', 1, '2026-03-30'),
      P('PH-LFILL-01', 1, '액상 충전 · 밀봉', 'liquidFill', ['liquid'], 'EC-LFL-01', 'auto', 'transfer_required', 'validated', 'effective', 1, '2026-03-30'),
      P('PH-PACK-01', 2, 'PTP 포장 · 라벨 대조', 'pack', ['tablet', 'capsule'], 'EC-PKG-01', 'scan', 'runtime_ok', 'validated', 'effective', 4, '2026-06-17'),
      P('PH-CLR-01', 1, '라인 클리어런스 체크리스트', 'pack', ['tablet', 'capsule', 'liquid'], 'EC-PKG-01', 'photo', 'runtime_ok', 'not_validated', 'draft', 0, '2026-10-04', '김민수')
    ];

    /* --- S-07 설정 객체 */
    function G(grade, override, role, auth, dev, block, scope, limit, locked) { return { grade: grade, override: override, role: role, auth: auth, dev: dev, block: block, scope: scope, limit: limit, locked: !!locked }; }
    var ILR_BODY = { grades: [
      G('Absolute', false, 'none', '', false, 'none', 'product_floor', 'override 불가 · P-52 대체 경로', true),
      G('Hard-QA', true, 'qa', 'full_factor', true, 'deviation', 'product_floor', '배치당 1회', true),
      G('Controlled', true, 'supervisor', 'full_factor', false, 'rbe', 'site', 'RBE 예외 자동 생성', false),
      G('Warning', true, 'self', 'pin_session', false, 'none', 'site', '사유 입력 후 진행', false)
    ], absolute: ['칭량 원료 ID · LOT 불일치', '설비 교정 만료 · 미적격 설비 (장비 클래스 적격 목록 밖)', '자격 미보유 수행자 서명', '유효기간 경과 · 부적합 판정 LOT 투입'] };
    var ILR_V8 = clone(ILR_BODY); ILR_V8.grades[3].auth = 'full_factor'; ILR_V8.grades[3].limit = '사유 입력 + 전 요소 (CC-2026-041 검토 중)';
    var ILR_WEIGH = clone(ILR_BODY); ILR_WEIGH.grades[2].scope = 'line'; ILR_WEIGH.grades[2].limit = '칭량 허용오차 ±0.5 % 초과 시';
    var BODY = {
      criticality: 'category: critical\n  - weigh.actual_qty        # 칭량 실측량\n  - weigh.lot_id            # 원료 LOT\n  - compress.hardness_mean  # 타정 경도 평균\n  - coat.weight_gain_pct    # 코팅 증량률\nextension (고객):\n  - mix.blend_time_min\naudit_filter: critical_only',
      rbe: 'rule_set: RBE-STD\ncategories:\n  UNSIGNED            -> 미서명 값 (출하 차단)\n  OVERRIDE_HARDQA     -> Hard-QA override (일탈 링크 필수)\n  OVERRIDE_CONTROLLED -> 감독자 승인 진행\n  WARNING_ACK         -> 경고 확인 진행\n  RECON_DIFF          -> 물질수지 대사 차이\n  BASELINE_VIOLATION  -> 히스토리안 기준선 이탈\n  DOWNTIME            -> 다운타임 구간 전수 검토',
      formula: 'id: FX-YIELD\ntype: parameterized   # 운영 허용 (검증 계산식 선택)\nexpr: yield_pct = actual_output / theoretical_output * 100\nround: 판정용 반올림 0.1 %\ninputs: [actual_output(정), theoretical_output(정)]\nlimits: { alert: 97.0, action: 95.0 }',
      parser: 'id: PR-BAL-MT\ndevice: Mettler XPR / SICS\nframe: "S S <value> <unit>\\r\\n"\nstable_only: true\nunit_map: { g: g, kg: kg }\nquality: { "S D": dynamic -> reject }',
      historian: 'id: HB-GRAN-DRY\ntags: [FBD01.INLET_TEMP, FBD01.OUTLET_TEMP, FBD01.AIRFLOW]\nbaseline: 최근 효력 20배치 ±3σ\nsnapshot: 단계 종료 시 반입 (DI-04)\nviolation -> RBE BASELINE_VIOLATION'
    };
    function CO(kind, id, ver, name, status, scope, pkg, apply, reviewer, effDate, upd, body, author) {
      return { kind: kind, id: id, ver: ver, name: name, status: status, scope: scope, pkg: pkg, apply: apply, reviewer: reviewer, effDate: effDate, upd: upd, author: author || '한승우', body: body };
    }
    var config = [
      CO('interlock', 'ILR-STD', 7, '표준 인터록 룰 세트', 'effective', 'runtime_ok', 'na', 'site', '이수진', '2026-07-15', '2026-07-10', clone(ILR_BODY)),
      CO('interlock', 'ILR-STD', 8, '표준 인터록 룰 세트 (Warning 전 요소)', 'draft', 'runtime_ok', 'na', 'site', '', '', '2026-10-03', ILR_V8, '김민수'),
      CO('interlock', 'ILR-WEIGH', 3, '칭량 인터록 룰 (L-01/L-02)', 'effective', 'runtime_ok', 'na', 'line', '박정훈', '2026-06-20', '2026-06-14', ILR_WEIGH),
      CO('criticality', 'CD-CORE', 12, '중요도 사전 (제품 고정 + 고객 확장)', 'effective', 'runtime_ok', 'na', 'site', '정다은', '2026-09-01', '2026-08-25', BODY.criticality),
      CO('criticality', 'CD-CORE', 13, '중요도 사전 (코팅 증량률 추가)', 'review', 'runtime_ok', 'na', 'site', '이수진', '', '2026-09-30', BODY.criticality + '\n  - coat.spray_rate'),
      CO('rbe', 'RBE-STD', 5, 'RBE 규칙 세트 · 표준 예외 카테고리', 'effective', 'transfer_required', 'match', 'site', '박정훈', '2026-08-10', '2026-08-01', BODY.rbe),
      CO('rbe', 'RBE-STD', 6, 'RBE 규칙 세트 (대사 차이 임계 조정)', 'approved', 'transfer_required', 'mismatch', 'site', '정다은', '', '2026-09-27', BODY.rbe + '\n  RECON_DIFF.threshold: 0.3 %'),
      CO('formula', 'FX-YIELD', 4, '수율 계산식 (파라미터형)', 'effective', 'runtime_ok', 'na', 'site', '이수진', '2026-06-30', '2026-06-22', BODY.formula),
      CO('formula', 'FX-POTENCY', 2, '역가 보정 칭량량 계산식', 'effective', 'transfer_required', 'match', 'site', '박정훈', '2026-05-12', '2026-05-02', 'id: FX-POTENCY\nexpr: req_qty = theo_qty * 100 / (assay_pct * (100 - lod_pct) / 100)\ninputs: [theo_qty, assay_pct(LIMS), lod_pct(LIMS)]'),
      CO('formula', 'FX-MB-FREE', 1, '물질수지 자유 계산식 (코팅)', 'review', 'transfer_required', 'match', 'product', '정다은', '', '2026-10-01', 'id: FX-MB-FREE\ntype: free   # 이관 필수\nexpr: mb_pct = (core_wt + coat_solid - loss) / input_total * 100'),
      CO('parser', 'PR-BAL-MT', 3, 'Mettler 저울 파서 (SICS)', 'effective', 'transfer_required', 'match', 'site', '박정훈', '2026-05-20', '2026-05-11', BODY.parser),
      CO('parser', 'PR-PH-01', 1, 'pH 미터 파서', 'draft', 'transfer_required', 'wait', 'line', '', '', '2026-10-04', 'id: PR-PH-01\ndevice: SevenExcellence\nframe: CSV\nfields: [ts, ph, temp_c]', '김민수'),
      CO('historian', 'HB-GRAN-DRY', 2, '유동층 건조 기준선', 'effective', 'runtime_ok', 'na', 'line', '정다은', '2026-03-02', '2026-02-24', BODY.historian),
      CO('historian', 'HB-COAT-01', 1, '코팅 팬 기준선 (구)', 'retired', 'runtime_ok', 'na', 'line', '이수진', '2025-11-03', '2026-08-30', 'id: HB-COAT-01\ntags: [COT01.EXHAUST_TEMP]\nbaseline: 고정 범위 38~45 ℃')
    ];

    /* --- S-39 서명 의미 · 인증 수단
       allowedRoles: 서명 허용 역할 (기획 마스터 §4.2). 콘텐츠 해시 대상. 표에 없는 행은 [] (= 미설정 → 이 열을 읽는 서명은 fail-closed) */
    var SIGN_ALLOWED = {
      'SM-PERF-STEP': ['OP', 'SV'], 'SM-PERF-WEIGH': ['OP', 'SV'], 'SM-VERI-STEP': ['OP', 'SV', 'QA'], 'SM-VERI-WEIGH': ['OP', 'SV', 'QA'],
      'SM-VERI-CORR': ['SV', 'QA'], 'SM-APPR-MBR': ['QA'], 'SM-APPR-REL': ['QP', 'QA'], 'SM-APPR-OVR': ['QA'], 'SM-APPR-EQC': ['QA'],
      'SM-APPR-ISSUE': ['SV', 'QA'], 'SM-APPR-REWEIGH': ['SV', 'QA'], 'SM-PERF-BALCHK': ['OP', 'SV'], 'SM-READ-BRIEF': ['OP', 'SV', 'QA', 'QP'], 'SM-REV-RBE': ['QA', 'QP'], 'SM-REV-AUDIT': ['QA', 'QP']
    };
    function S(id, ver, meaning, rec, auth, batch, status, upd, note) { return { id: id, ver: ver, meaning: meaning, recType: rec, auth: auth, batch: batch, samePerson: meaning !== 'performed' && meaning !== 'read_understood', status: status, upd: upd, note: note || '', author: '이수진', allowedRoles: (SIGN_ALLOWED[id] || []).slice() }; }
    var sign = [
      S('SM-PERF-STEP', 3, 'performed', 'step_value', 'pin_session', false, 'effective', '2026-07-01', 'Operation 종료 시 수행 서명'),
      S('SM-PERF-WEIGH', 2, 'performed', 'weigh_value', 'pin_session', false, 'effective', '2026-07-01'),
      S('SM-VERI-STEP', 3, 'verified', 'step_value', 'full_factor', false, 'effective', '2026-07-01', '동일인 차단 · 랜덤 키패드'),
      S('SM-VERI-WEIGH', 2, 'verified', 'weigh_value', 'full_factor', false, 'effective', '2026-07-01'),
      S('SM-VERI-CORR', 1, 'verified', 'correction', 'full_factor', false, 'effective', '2026-08-12', '정정자 ≠ 확인자'),
      S('SM-APPR-MBR', 2, 'approved', 'mbr_approval', 'full_factor', false, 'effective', '2026-06-05'),
      S('SM-APPR-REL', 2, 'approved', 'release', 'full_factor', false, 'effective', '2026-06-05', '개별 · 일괄 불가'),
      S('SM-APPR-OVR', 1, 'approved', 'interlock_override', 'full_factor', false, 'effective', '2026-07-15', 'Hard-QA override'),
      S('SM-APPR-EQC', 1, 'approved', 'eqclass_approval', 'full_factor', false, 'effective', '2026-07-02', '장비 클래스 승인 · 적격 목록 스냅샷 고정'),
      S('SM-APPR-ISSUE', 1, 'approved', 'batch_issue', 'full_factor', false, 'effective', '2026-10-09', '배치 발행 승인 (P0 1인 · 감독자/QA)'),
      S('SM-APPR-REWEIGH', 1, 'approved', 'weigh_reweigh', 'full_factor', false, 'effective', '2026-10-09', '재칭량 승인 (허용오차 이탈 1회차 · 감독자/QA)'),
      S('SM-PERF-BALCHK', 1, 'performed', 'balance_check', 'pin_session', false, 'effective', '2026-10-09', 'P1 예약 — 저울 일일점검 (흐름 없음)'),
      S('SM-READ-BRIEF', 2, 'read_understood', 'briefing', 'pin_session', true, 'effective', '2026-08-20'),
      S('SM-REV-RBE', 1, 'reviewed', 'rbe_exception', 'full_factor', true, 'effective', '2026-08-10'),
      S('SM-REV-AUDIT', 1, 'reviewed', 'audit_trail', 'full_factor', true, 'review', '2026-09-30'),
      S('SM-APPR-CC', 1, 'approved', 'cc_approval', 'biometric_opt', false, 'draft', '2026-10-03', '생체 옵션 시범')
    ];
    function AM(id, ver, name, auth, zone, temp, plugin, status, upd) { return { id: id, ver: ver, name: name, auth: auth, zone: zone, temp: temp, plugin: plugin, status: status, upd: upd, author: '김민수', note: '' }; }
    var auth = [
      AM('AM-CARD-PIN', 2, '사원증 + PIN', 'full_factor', '전 구역', false, 'HID iCLASS v3.2', 'effective', '2026-06-01'),
      AM('AM-RFID-BAND', 1, 'RFID 손목 밴드 + PIN', 'full_factor', 'Grade C (장갑 착용)', false, 'RFID-13.56 v1.4', 'effective', '2026-06-01'),
      AM('AM-PIN-SESSION', 1, '연속 세션 PIN', 'pin_session', '전 구역 (수행만)', false, '내장', 'effective', '2026-06-01'),
      AM('AM-IDPW', 1, 'ID + 비밀번호', 'full_factor', '사무 구역 · UI', false, 'LDAP', 'effective', '2026-06-01'),
      AM('AM-TEMP-CARD', 1, '임시 카드 (TEMP)', 'full_factor', '전 구역 — 당일 만료', true, 'HID iCLASS v3.2', 'effective', '2026-06-01'),
      AM('AM-BIO-VEIN', 1, '지정맥 (옵션)', 'biometric_opt', '칭량실 (장갑 탈의 구역)', false, 'PalmSecure v2.0', 'review', '2026-09-24')
    ];

    /* --- S-40 단말 (작업실 = RAS areaCode) */
    function TM(id, type, model, room, line, online, lock, sess, shift, reader, am, status, beat) {
      return { id: id, ver: 1, type: type, model: model, room: room, line: line, online: online, lock: lock, sess: sess, shift: shift, reader: reader, authMethod: am, status: status, beat: beat, upd: '2026-09-15', author: '김민수', note: '' };
    }
    var terminal = [
      TM('T-WB-01', 'fixed_panel', 'Advantech PPC-321', 'R-201', 'L-01', 'online', 3, 15, 12, 'RFID-WB01', 'AM-RFID-BAND', 'effective', '16:05:12'),
      TM('T-WB-02', 'fixed_panel', 'Advantech PPC-321', 'R-202', 'L-02', 'online', 3, 15, 12, 'RFID-WB02', 'AM-RFID-BAND', 'effective', '16:05:08'),
      TM('T-GR-01', 'explosion_proof', 'Pepperl+Fuchs VisuNet', 'R-210', 'L-01', 'online', 3, 15, 12, '', 'AM-CARD-PIN', 'effective', '16:04:57'),
      TM('T-MX-01', 'fixed_panel', 'Advantech PPC-321', 'R-215', 'L-01', 'offline', 5, 15, 12, 'RFID-MX01', 'AM-RFID-BAND', 'effective', '13:41:20'),
      TM('T-TB-01', 'fixed_panel', 'Advantech PPC-321', 'R-220', 'L-01', 'online', 5, 15, 12, 'RFID-TB01', 'AM-RFID-BAND', 'effective', '16:05:10'),
      TM('T-TB-02', 'fixed_panel', 'Advantech PPC-321', 'R-221', 'L-02', 'online', 5, 15, 12, 'RFID-TB02', 'AM-RFID-BAND', 'effective', '16:05:02'),
      TM('T-CT-01', 'explosion_proof', 'Pepperl+Fuchs VisuNet', 'R-230', 'L-01', 'maint', 3, 15, 12, '', 'AM-CARD-PIN', 'effective', '09:12:44'),
      TM('T-CP-01', 'fixed_panel', 'Advantech PPC-321', 'R-240', 'L-03', 'online', 5, 15, 12, 'RFID-CP01', 'AM-RFID-BAND', 'effective', '16:05:11'),
      TM('T-LQ-01', 'fixed_panel', 'Advantech PPC-321', 'R-250', 'L-04', 'online', 5, 15, 12, 'RFID-LQ01', 'AM-CARD-PIN', 'effective', '16:04:49'),
      TM('T-PK-01', 'fixed_panel', 'Advantech PPC-321', 'R-260', 'L-02', 'online', 5, 15, 12, 'RFID-PK01', 'AM-CARD-PIN', 'effective', '16:05:06'),
      TM('T-CART-01', 'cart', 'Panasonic FZ-G2 카트', 'R-215', 'L-01', 'online', 3, 15, 10, 'RFID-CART01', 'AM-RFID-BAND', 'review', '16:03:30'),
      TM('T-CART-02', 'cart', 'Panasonic FZ-G2 카트', '', '', 'offline', 3, 15, 10, 'RFID-CART02', 'AM-RFID-BAND', 'draft', '—')
    ];
    var all = { phase: phase, config: config, sign: sign, auth: auth, terminal: terminal, eqclass: eqclass };
    ['phase', 'config', 'sign', 'auth', 'terminal'].forEach(function (k) { all[k].forEach(function (r) { r.hash = MS.calcHash(r); }); });
    return all;
  }
  function seedAll() { var g = seedGcm(), d = seedDomain(); d.gcmTables = g.tables; d.gcmData = g.data; d.v = VERSION; return d; }
  MS.seedAll = seedAll;

  /* ================================================================== 저장소 (메모리 + localStorage, 화면 간 공유) */
  MS.DB = null; MS.persisted = false;
  /* 시드 보충 (병합만): 저장된 S-39 sign 에 해당 id 행이 하나도 없을 때만 시드 행을 추가한다.
     기존 행(사용자 편집 포함)은 읽기만 하고 고치지 않는다 — 예: allowedRoles 를 비운 행은 그대로 둔다(서명은 fail-closed) */
  var BACKFILL_SIGN_IDS = ['SM-APPR-ISSUE', 'SM-APPR-REWEIGH', 'SM-PERF-BALCHK'];
  MS.backfillSign = function (db) {
    if (!db || !Array.isArray(db.sign)) return 0;
    var seedSign = null, n = 0;
    BACKFILL_SIGN_IDS.forEach(function (id) {
      if (db.sign.some(function (r) { return r && r.id === id; })) return;
      if (!seedSign) seedSign = seedDomain().sign;
      seedSign.filter(function (r) { return r.id === id; }).forEach(function (r) { db.sign.push(clone(r)); n++; });
    });
    return n;
  };
  MS.load = function () {
    try {
      var s = global.localStorage && localStorage.getItem(LS_KEY);
      if (s) {
        var o = JSON.parse(s);
        if (o && o.v === VERSION && o.gcmTables) {
          MS.DB = o; MS.persisted = true;
          if (MS.backfillSign(o)) { try { localStorage.setItem(LS_KEY, JSON.stringify(o)); } catch (e1) { MS.persisted = false; } }
          return MS.DB;
        }
      }
    } catch (e) { /* file:// 정책 등으로 localStorage 불가 → 메모리 */ }
    MS.DB = seedAll(); MS.persisted = false;
    return MS.DB;
  };
  MS.persist = function () {
    try { localStorage.setItem(LS_KEY, JSON.stringify(MS.DB)); MS.persisted = true; } catch (e) { MS.persisted = false; }
    MS.lastSaved = new Date();
    MS.emit();
  };
  MS.reset = function () {
    try { localStorage.removeItem(LS_KEY); } catch (e) { /* noop */ }
    MS.DB = seedAll(); MS.persisted = false; MS.emit();
  };
  var listeners = [];
  MS.on = function (fn) { listeners.push(fn); };
  MS.emit = function () { listeners.forEach(function (fn) { try { fn(); } catch (e) { if (global.console) console.error(e); } }); };
  /* 다른 탭(다른 모듈 화면)에서 저장 → 현재 화면 재로딩 */
  MS.onExternal = function (fn) {
    if (!global.addEventListener) return;
    global.addEventListener('storage', function (e) { if (e.key === LS_KEY) { MS.load(); fn(); } });
  };
  MS.storeText = function () {
    return MS.persisted ? '저장: localStorage (' + LS_KEY + ')' + (MS.lastSaved ? ' · ' + pad(MS.lastSaved.getHours()) + ':' + pad(MS.lastSaved.getMinutes()) + ':' + pad(MS.lastSaved.getSeconds()) : '')
                        : '저장: 샘플 데이터 (편집 시 localStorage 저장)';
  };

  /* ================================================================== 화면 레지스트리 (허브 · 좌측 내비 · GCM 소비처 매핑) */
  MS.SCREENS = [
    { key: 'gcm', mod: 'ADM', file: 'adm/s-adm-gcm-code-ui.html', nm: 'GCM 공통 코드', sid: 'AdmSetupCodeTable · CodeData (조회)', stores: [],
      purpose: '조회 전용 — EBR_* 코드 테이블 11종 (신규 시드) · 코드 데이터 · 소비처 매핑을 보여 줌. 등록 · 수정은 제품 AdmSetupCode* 화면.' },
    { key: 'user', mod: 'ADM', file: 'adm/s-adm-user-role-ui.html', nm: '사용자 · 역할', sid: 'S-41 · CAdmSetupUserRoleMain', stores: [],
      purpose: '사용자 마스터(ebmr.userRole.v1) · 역할(OP/SV/QA/QP/ADMIN) 매핑 · 계정 잠금 해제(ADMIN). PoC 비밀번호는 해시만 저장 — 실서비스는 LDAP(AM-IDPW).' },
    { key: 'phase', mod: 'EBR', file: 'ebr/s-ebr-phase-library-ui.html', nm: 'Phase 라이브러리', sid: 'S-03 · CEbrSetupPhaseLibraryMain', stores: ['phase'],
      purpose: 'Phase 블록 수명주기 · 해시. 장비 클래스를 (ID · 버전 · 해시)로 참조.' },
    { key: 'config', mod: 'EBR', file: 'ebr/s-ebr-config-object-ui.html', nm: '설정 객체', sid: 'S-07 · S-08 편집 팝업', stores: ['config'],
      purpose: '인터록 · 중요도 · RBE · 계산식 · 파서 · 히스토리안 6종. S-08 인터록 등급 동작 정의표.' },
    { key: 'sign', mod: 'EBR', file: 'ebr/s-ebr-signature-setup-ui.html', nm: '서명 의미 · 인증 수단', sid: 'S-39 · CEbrSetupSignatureMeaningMain', stores: ['sign', 'auth'],
      purpose: '서명 의미 × 레코드 타입 · 요구 인증 강도, 인증 수단 플러그인.' },
    { key: 'terminal', mod: 'EBR', file: 'ebr/s-ebr-terminal-registry-ui.html', nm: '단말 레지스트리', sid: 'S-40 · CEbrSetupTerminalMain', stores: ['terminal'],
      purpose: '단말 · 작업실 바인딩(GMP 설정) · 잠금/세션 정책. 온라인 상태는 운영 데이터.' },
    { key: 'eqclass', mod: 'EBR', file: 'ebr/s-ebr-equipment-class-ui.html', nm: '장비 클래스', sid: 'MBR-02 · CEbrSetupEquipmentClassMain', stores: ['eqclass'],
      purpose: '요구 능력 + 버전별 적격 설비 목록(RAS 개체 피커) + 수명주기 · 해시 · 승인 시 스냅샷 고정.' }
  ];
  MS.screen = function (key) { return MS.SCREENS.filter(function (s) { return s.key === key; })[0]; };
  MS.count = function (key) {
    if (!MS.DB) return 0;
    if (key === 'gcm') return MS.DB.gcmTables.length;
    if (key === 'user') { var U = global.EbrUserSession; try { return U && U.listUsers ? U.listUsers().length : 0; } catch (e) { return 0; } }
    var s = MS.screen(key); return s.stores.reduce(function (n, k) { return n + (MS.DB[k] || []).length; }, 0);
  };
  /* GCM 코드 사용처 선언 (도메인 마스터 필드 → GCM 테이블). 코드 삭제 차단 · 사용처 카운트용 */
  MS.USAGE = [
    ['phase', 'kind', 'EBR_PHASE_KIND'], ['phase', 'dosage', 'EBR_DOSAGE_FORM'], ['phase', 'evidence', 'EBR_EVIDENCE_TYPE'], ['phase', 'scope', 'EBR_AUTHORING_SCOPE'],
    ['config', 'kind', 'EBR_CONFIG_KIND'], ['config', 'scope', 'EBR_AUTHORING_SCOPE'],
    ['sign', 'meaning', 'EBR_SIGN_MEANING'], ['sign', 'auth', 'EBR_AUTH_STRENGTH'], ['auth', 'auth', 'EBR_AUTH_STRENGTH'],
    ['terminal', 'type', 'EBR_TERMINAL_TYPE'], ['eqclass', 'kind', 'EBR_PHASE_KIND'], ['eqclass', 'dosage', 'EBR_DOSAGE_FORM']
  ];
  var STORE_LABEL = { phase: 'S-03 Phase', config: 'S-07 설정 객체', sign: 'S-39 서명 의미', auth: 'S-39 인증 수단', terminal: 'S-40 단말', eqclass: 'MBR-02 장비 클래스' };
  MS.refCount = function (table, code) {
    var by = [], total = 0;
    Object.keys(STORE_LABEL).forEach(function (store) {
      var n = (MS.DB[store] || []).filter(function (r) {
        var hit = MS.USAGE.some(function (u) { if (u[0] !== store || u[2] !== table) return false; var v = r[u[1]]; return Array.isArray(v) ? v.indexOf(code) >= 0 : v === code; });
        if (table === 'EBR_MBR_STATUS' && r.status === code) hit = true;
        if (store === 'config' && r.body && r.body.grades && r.body.grades.some(function (g) { return (table === 'EBR_INTERLOCK_GRADE' && g.grade === code) || (table === 'EBR_AUTH_STRENGTH' && g.auth === code); })) hit = true;
        return hit;
      }).length;
      if (n) { by.push(STORE_LABEL[store] + ' ' + n + '건'); total += n; }
    });
    return { total: total, by: by };
  };

  /* ================================================================== GCM 조회 헬퍼 (콤보 · 뱃지 소스) */
  MS.gTable = function (name) { return MS.DB.gcmTables.filter(function (t) { return t.tableName === name; })[0]; };
  MS.gRows = function (name, activeOnly) {
    return (MS.DB.gcmData[name] || []).filter(function (r) { return !activeOnly || !r.disableFlag; }).slice().sort(function (a, b) { return (a.seqNo || 0) - (b.seqNo || 0); });
  };
  MS.gRow = function (name, code) { return (MS.DB.gcmData[name] || []).filter(function (r) { return r.key1 === code; })[0]; };

  /* 정적 옵션 (GCM 대상이 아닌 운영 · 화면 값) */
  var O = MS.OPTS = {
    VALID: [{ v: 'validated', t: '검증 완료', b: 'ok' }, { v: 'validating', t: '검증 중', b: 'info' }, { v: 'not_validated', t: '미검증', b: 'muted' }, { v: 'revalidate', t: '재검증 필요', b: 'warn' }],
    PKG: [{ v: 'match', t: '일치', b: 'ok' }, { v: 'mismatch', t: '불일치', b: 'error' }, { v: 'wait', t: '패키지 대기', b: 'warn' }, { v: 'na', t: '해당 없음', b: 'muted' }],
    APPLY: [{ v: 'site', t: '사이트 (오송)' }, { v: 'line', t: '라인' }, { v: 'product', t: '제품' }],
    REC: [{ v: 'step_value', t: '단계 실행 값' }, { v: 'weigh_value', t: '칭량 값' }, { v: 'correction', t: '정정' }, { v: 'mbr_approval', t: 'MBR 승인' }, { v: 'release', t: '출하 승인' },
      { v: 'interlock_override', t: '인터록 override' }, { v: 'eqclass_approval', t: '장비 클래스 승인' }, { v: 'briefing', t: '변경점 브리핑' }, { v: 'rbe_exception', t: 'RBE 예외 검토' },
      { v: 'audit_trail', t: '감사추적 검토' }, { v: 'cc_approval', t: 'CC 승인' }, { v: 'batch_issue', t: '배치 발행' },
      { v: 'weigh_reweigh', t: '재칭량 승인' }, { v: 'balance_check', t: '저울 일일점검' }],
    LINE: [{ v: 'L-01', t: 'L-01 정제 1라인' }, { v: 'L-02', t: 'L-02 정제 2라인' }, { v: 'L-03', t: 'L-03 캡슐 라인' }, { v: 'L-04', t: 'L-04 액제 라인' }],
    ONLINE: [{ v: 'online', t: '온라인', b: 'ok' }, { v: 'offline', t: '오프라인', b: 'error' }, { v: 'maint', t: '점검', b: 'warn' }],
    ROLE: [{ v: 'none', t: '— 없음' }, { v: 'self', t: '작업자 본인' }, { v: 'supervisor', t: '감독자' }, { v: 'qa', t: 'QA' }],
    /* 사용자 역할 코드 (S-41 · S-39 허용 역할 체크박스). ROLE(override 승인 수준)과 다름 */
    USER_ROLE: [{ v: 'OP', t: '작업자' }, { v: 'SV', t: '감독자' }, { v: 'QA', t: 'QA' }, { v: 'QP', t: 'QP' }, { v: 'ADMIN', t: '관리자' }],
    BLOCK: [{ v: 'none', t: '없음' }, { v: 'rbe', t: 'RBE 예외 검토 전' }, { v: 'deviation', t: '일탈 종결 전' }],
    SCOPE: [{ v: 'product_floor', t: '제품 하한 (고정)' }, { v: 'site', t: '사이트' }, { v: 'line', t: '라인' }, { v: 'product', t: '제품' }],
    CAP_OP: ['≥', '≤', '=', '범위'].map(function (x) { return { v: x, t: x }; }),
    REVIEWER: [{ v: '', t: '(지정 안 함)' }].concat(MS.USERS.map(function (u) { return { v: u[0], t: u[0] + ' · ' + u[1] }; }))
  };
  /* 작업실 = RAS 작업장(area) 마스터 */
  O.ROOM = AREAS.map(function (a) { return { v: a.areaCode, t: a.areaCode + ' ' + a.areaDesc }; });

  /* src: 배열 | 'gcm:TABLE' | 'ref:store' → [{v,t,b?}] */
  MS.opts = function (src, includeDisabled) {
    if (!src) return [];
    if (Array.isArray(src)) return src;
    if (src.indexOf('gcm:') === 0) return MS.gRows(src.slice(4), !includeDisabled).map(function (r) { return { v: r.key1, t: r.keyDesc, r: r }; });
    if (src.indexOf('ref:') === 0) {
      var seen = {}, out = [];
      MS.DB[src.slice(4)].slice().sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : b.ver - a.ver; }).forEach(function (r) {
        if (seen[r.id] || r.status === 'retired') return; seen[r.id] = 1; out.push({ v: r.id, t: r.id + ' ' + r.name });
      });
      return out;
    }
    return [];
  };
  MS.optOf = function (src, v) { return MS.opts(src, true).filter(function (o) { return o.v === v; })[0]; };
  MS.label = function (src, v) {
    if (Array.isArray(v)) return v.map(function (x) { return MS.label(src, x); }).join(' · ');
    if (v == null || v === '') return '—';
    var o = MS.optOf(src, v); return o ? o.t : v;
  };
  MS.optionsHtml = function (src, sel, blank) {
    var list = MS.opts(src);
    if (sel && !list.some(function (o) { return o.v === sel; })) { var d = MS.optOf(src, sel); list = list.concat([{ v: sel, t: (d ? d.t : sel) + ' (사용안함)' }]); }
    return (blank != null ? '<option value="">' + esc(blank) + '</option>' : '') +
      list.map(function (o) { return '<option value="' + esc(o.v) + '"' + (o.v === sel ? ' selected' : '') + '>' + esc(o.t) + '</option>'; }).join('');
  };
  MS.lcBadge = function (st) { var r = MS.gRow('EBR_MBR_STATUS', st); return '<span class="badge ' + esc(r ? r.data1 : 'muted') + '">' + esc(r ? r.keyDesc : st) + '</span>'; };
  MS.optBadge = function (src, v) { var o = MS.optOf(src, v); return o ? '<span class="badge ' + (o.b || 'muted') + '">' + esc(o.t) + '</span>' : '—'; };
  MS.hashCell = function (h) { return h ? '<span class="hash" title="' + esc(h) + '">' + esc(h.slice(0, 8)) + '…</span>' : '—'; };
  MS.yn = function (b) { return b ? 'Y' : '<span class="muted">N</span>'; };

  /* 연계 상태 뱃지 */
  MS.calBadge = function (r) {
    if (!r.measuring || r.calState === 'na') return '<span class="muted">—</span>';
    var t = { ok: '교정 유효', due: '교정 임박', expired: '교정 만료' }[r.calState], b = { ok: 'ok', due: 'warn', expired: 'error' }[r.calState];
    return '<span class="badge ' + b + '" title="CMMS ' + esc(r.cmmsId) + ' · 만료 ' + esc(r.calDue) + '">' + t + '</span>';
  };
  MS.qualBadge = function (r) {
    var s = r.qualState;
    if (s === 'na') return r.measuring ? '<span class="muted" title="계측기는 CMMS 교정으로 판단">교정 기반</span>' : '<span class="muted">—</span>';
    var t = { ok: '적격', due: '재적격 임박', expired: '적격 만료', pending: '적격성 진행' }[s], b = { ok: 'ok', due: 'warn', expired: 'error', pending: 'info' }[s];
    return '<span class="badge ' + b + '" title="CFMS ' + esc(r.qualType) + (r.qualDue ? ' · 기한 ' + esc(r.qualDue) : '') + '">' + t + '</span>';
  };
  MS.rasBadge = function (st) { var s = RAS_STATUS[st]; return s ? '<span class="badge ' + s[1] + '">' + s[0] + '</span>' : '<span class="badge error">미존재</span>'; };

  global.MS = MS;
  if (typeof module !== 'undefined' && module.exports) module.exports = MS;
})(typeof window !== 'undefined' ? window : globalThis);
