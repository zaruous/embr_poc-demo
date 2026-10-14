/* =====================================================================
   tree-designer.js — eMBR 프로세스 트리 디자이너 PoC
   schemaVersion: layers-1-2-tree-poc-1  (nodes + edges seq|exception)
   노드 확장     : instruction{text(토큰 ![설명](IMG-id) · [📎 이름](ATT-id)), assets[{kind:image|file}]} · inputs[] (INPUT_TYPES) · esig{perform/verify/approve + Role/Auth, distinct}
                 이미지 바이트(dataUrl)는 contentHash 제외, 이미지 hash 만 포함
   내장 시나리오 : SCENARIOS (분기 · 다중 종료 층) — 디자이너 툴바 '시나리오' 선택으로 로드
   localStorage : ebmr.processTree.v1
   PoC link     : batch issue binds id · ver · contentHash; only status=effective may issue
   ===================================================================== */
(function (global) {
  'use strict';

  var LS_KEY = 'ebmr.processTree.v1';
  var ISSUED_LS_KEY = 'ebr.batch.issued.v1';
  var SCHEMA = 'layers-1-2-tree-poc-1';

  var NODE_TYPES = [
    { value: 'unitProcedure', label: 'Unit Procedure (UP)' },
    { value: 'operation', label: 'Operation (OP)' },
    { value: 'phase', label: 'Phase' },
    { value: 'custom', label: '사용자 정의' }
  ];

  var EDGE_TYPES = [
    { value: 'seq', label: '다음 단계 (seq)' },
    { value: 'exception', label: '예외 / 대체 (exception)' }
  ];

  /* 노드 입력 항목 유형 → 작업 화면(OI) 입력 컨트롤 */
  var INPUT_TYPES = [
    { value: 'label',    label: '라벨 (읽기 전용)' },
    { value: 'text',     label: '텍스트' },
    { value: 'number',   label: '숫자 (단위 · 범위)' },
    { value: 'date',     label: '날짜' },
    { value: 'datetime', label: '일시' },
    { value: 'combo',    label: '콤보 (선택)' },
    { value: 'check',    label: '체크' },
    { value: 'multi',    label: '다중 컨트롤 (한 행에 여러 입력)' }
  ];
  /* 서명 역할 (PoC 고정 목록 — 제품에서는 ADM 역할 마스터 참조) */
  var SIGN_ROLES = [
    { value: 'OPERATOR',    label: '작업자 (수행)' },
    { value: 'OPERATOR2',   label: '확인 작업자 (2인)' },
    { value: 'LINE_LEADER', label: '라인 리더' },
    { value: 'QA',          label: 'QA 담당' },
    { value: 'QA_MGR',      label: 'QA 관리자' },
    { value: 'PROD_MGR',    label: '생산 관리자' },
    { value: 'EQ_ENG',      label: '설비 담당' }
  ];
  /* 인증 강도 — master-setup GCM EBR_AUTH_STRENGTH 와 같은 코드 */
  var AUTH_STRENGTHS = [
    { value: 'pin_session',   label: '연속 세션 PIN' },
    { value: 'full_factor',   label: '전 요소 (ID+PW / 카드+PIN)' },
    { value: 'biometric_opt', label: '생체 옵션' }
  ];
  /* 서명 단계별 기본값 (EBR_SIGN_MEANING.DEFAULT_AUTH 와 정렬: performed→pin_session, verified/approved→full_factor) */
  var ESIG_STEPS = [
    { key: 'perform', label: '수행 (Perform)', role: 'OPERATOR',  auth: 'pin_session' },
    { key: 'verify',  label: '확인 (Verify)',  role: 'OPERATOR2', auth: 'full_factor' },
    { key: 'approve', label: '승인 (Approve)', role: 'QA',        auth: 'full_factor' }
  ];

  /* LC vocabulary aligned with batch UI (s-ebr-batch-issue-ui) */
  var STATUS_LABELS = {
    draft: '초안',
    review: '검토',
    approved: '승인',
    pending: '효력 대기',
    effective: '효력',
    superseded: '대체',
    retired: '폐기'
  };
  var STATUS_ORDER = ['draft', 'review', 'approved', 'pending', 'effective'];
  /* Allowed forward + reject-to-draft (PoC) */
  var STATUS_TRANSITIONS = {
    draft: ['review'],
    review: ['approved', 'draft'],
    approved: ['pending', 'draft'],
    pending: ['effective', 'draft'],
    effective: ['superseded', 'retired'],
    superseded: ['retired'],
    retired: []
  };

  /** Demo seed: 정제 MBR 칭량→혼합→타정→포장 (칭량 = N-010 BOM 3줄, 재칭량은 같은 줄 새 시도 · 서명은 줄 단위) */
  function seedTree() {
    return {
      schemaVersion: SCHEMA,
      objectType: 'mbr-process-tree',
      id: 'MBR-TAB-0420',
      ver: 1,
      status: 'draft',
      name: '에이정 10mg · 직접 타정',
      product: {
        productCode: 'TAB-0420',
        dosageForm: 'tablet',
        strength: '10 mg'
      },
      procedure: {
        unitProcedures: [
          {
            id: 'UP-10',
            name: '조제',
            operations: [
              { id: 'OP-10', name: '원료 칭량', phases: ['N-010'] },
              { id: 'OP-20', name: '혼합', phases: ['N-020'] }
            ]
          },
          {
            id: 'UP-20',
            name: '타정',
            operations: [
              { id: 'OP-30', name: '타정 · IPC', phases: ['N-030'] }
            ]
          },
          {
            id: 'UP-30',
            name: '포장',
            operations: [
              { id: 'OP-40', name: 'PTP 포장', phases: ['N-040'] }
            ]
          }
        ]
      },
      nodes: [
        {
          nodeId: 'N-010',
          type: 'phase',
          label: '원료 칭량',
          phaseRef: 'PH-WEIGH-01',
          materials: [
            { materialId: 'MAT-API', tolPct: 0.5, balanceClass: 'EC-BAL-02' },
            { materialId: 'MAT-LAC', tolPct: 0.5, balanceClass: 'EC-BAL-02' },
            { materialId: 'MAT-MGS', tolPct: 1.0, balanceClass: 'EC-BAL-01' }
          ],
          nextStep: 'N-020',
          esig: { required: false, meaning: '', perform: false, verify: false },
          instruction: {
            text: '1. 저울 BAL-205 영점 확인 후 교정 라벨 유효기간을 확인한다.\n![칭량 작업대 배치 · 교정 라벨 위치](IMG-weigh-layout)\n2. 원료 LOT 바코드를 스캔하고 지시량 ±0.5 % 안에서 칭량한다. 절차는 첨부를 따른다.\n[📎 SOP-WEIGH-01.txt](ATT-sop-weigh-01)\n3. 범위를 벗어나면 재칭량 승인 후 같은 줄에서 다시 칭량한다.',
            assets: [{"id": "IMG-weigh-layout","name": "weigh-layout.svg","caption": "칭량 작업대 배치 · 교정 라벨 위치","w": 480,"h": 300,"hash": "","dataUrl": "data:image/svg+xml;utf8,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20width=%27480%27%20height=%27300%27%3E%3Crect%20width=%27480%27%20height=%27300%27%20fill=%27%23f3f6fb%27/%3E%3Crect%20x=%2740%27%20y=%2760%27%20width=%27400%27%20height=%27180%27%20rx=%278%27%20fill=%27%23fff%27%20stroke=%27%232C59D9%27%20stroke-width=%273%27/%3E%3Crect%20x=%2770%27%20y=%2790%27%20width=%27120%27%20height=%27120%27%20fill=%27%23e8eefc%27%20stroke=%27%235c7cfa%27/%3E%3Ctext%20x=%27130%27%20y=%27160%27%20font-size=%2716%27%20text-anchor=%27middle%27%20fill=%27%232C59D9%27%20font-family=%27sans-serif%27%3E저울%20BAL-205%3C/text%3E%3Crect%20x=%27230%27%20y=%27110%27%20width=%27180%27%20height=%2740%27%20fill=%27%23fff8e1%27%20stroke=%27%23e6a817%27/%3E%3Ctext%20x=%27320%27%20y=%27136%27%20font-size=%2714%27%20text-anchor=%27middle%27%20fill=%27%238a6d00%27%20font-family=%27sans-serif%27%3E교정%20라벨%20확인%3C/text%3E%3Ctext%20x=%27240%27%20y=%27200%27%20font-size=%2713%27%20fill=%27%23333%27%20font-family=%27sans-serif%27%3E영점%20→%20LOT%20스캔%20→%20칭량%3C/text%3E%3C/svg%3E","kind": "image","size": 1065},{"id": "ATT-sop-weigh-01","kind": "file","name": "SOP-WEIGH-01.txt","mime": "text/plain","caption": "칭량 표준작업절차 발췌","size": 160,"hash": "","dataUrl": "data:text/plain;charset=utf-8,SOP-WEIGH-01%20%EC%B9%AD%EB%9F%89%20%ED%91%9C%EC%A4%80%EC%9E%91%EC%97%85%EC%A0%88%EC%B0%A8%20(PoC%20%EC%83%98%ED%94%8C)%0A1.%20%EC%98%81%EC%A0%90%20%ED%99%95%EC%9D%B8%0A2.%20LOT%20%EC%8A%A4%EC%BA%94%0A3.%20%EC%B9%AD%EB%9F%89%20%C2%B10.5%25"}]
          },
          inputs: [
            { key: 'lot', label: '원료 LOT', type: 'combo', required: true, critical: true, options: ['API-2409', 'API-2410'], evidence: 'barcode' },
            { key: 'target_kg', label: '지시량', type: 'label', unit: 'kg', value: '20.000' },
            { key: 'actual_kg', label: '칭량값', type: 'number', required: true, critical: true, unit: 'kg', min: 19.9, max: 20.1, decimals: 3, evidence: 'device_log' },
            { key: 'weighed_at', label: '칭량 일시', type: 'datetime', required: true },
            { key: 'balance', label: '저울 · 교정', type: 'multi', parts: [
              { label: '저울 ID', type: 'combo', options: ['BAL-205', 'BAL-206'] },
              { label: '교정 유효', type: 'check' },
              { label: '교정일', type: 'date' }
            ] },
            { key: 'remark', label: '비고', type: 'text' }
          ],
          interlockRef: 'ILR-WEIGH-LOT',
          equipmentClassRef: 'EC-BAL-02',
          note: '단일 LOT · 목표 20 kg'
        },
        {
          nodeId: 'N-020',
          type: 'phase',
          label: '혼합',
          phaseRef: 'PH-MIX-01',
          nextStep: 'N-030',
          esig: { required: false, meaning: '', perform: false, verify: false },
          interlockRef: '',
          equipmentClassRef: 'EC-MIX-01',
          note: ''
        },
        {
          nodeId: 'N-030',
          type: 'phase',
          label: '타정 · IPC',
          phaseRef: 'PH-COMP-01',
          nextStep: 'N-040',
          esig: { required: false, meaning: '', perform: false, verify: false },
          interlockRef: 'ILR-IPC-HARDNESS',
          equipmentClassRef: 'EC-TAB-01',
          note: ''
        },
        {
          nodeId: 'N-040',
          type: 'phase',
          label: 'PTP 포장',
          phaseRef: 'PH-PACK-01',
          nextStep: '',
          esig: { required: false, meaning: '', perform: false, verify: false },
          interlockRef: '',
          equipmentClassRef: 'EC-PKG-01',
          note: ''
        }
      ],
      edges: [
        { from: 'N-010', to: 'N-020', type: 'seq', label: '다음' },
        { from: 'N-020', to: 'N-030', type: 'seq', label: '다음' },
        { from: 'N-030', to: 'N-040', type: 'seq', label: '다음' }
      ],
      contentHash: '',
      meta: {
        updatedAt: null,
        author: 'PoC'
      }
    };
  }

  /**
   * Bio DS skeleton seed (P0 UI-05) — draft only; does not replace solid-dose seedTree().
   * UP/Phase labels (Seed Train…Aseptic Fill) are production-board names after issue freeze;
   * keep full labels (do not shorten). phaseList field mapping for D1 freeze:
   *   id←nodeId, name←label, kind←kind, up/upName/op/opName←procedure, seq←edge order.
   * Do not edit freezeForIssue / production-exec here (D1).
   */
  function seedBioTree() {
    return {
      schemaVersion: SCHEMA,
      objectType: 'mbr-process-tree',
      id: 'MBR-BIO-DS-01',
      ver: 1,
      status: 'draft',
      name: '바이오 DS 골격 · Seed→Bulk Hold (+Aseptic Fill)',
      product: {
        productCode: 'BIO-DS-01',
        dosageForm: 'biologic',
        strength: 'DS(바이오)'
      },
      procedure: {
        unitProcedures: [
          { id: 'UP-10', name: 'Seed Train', operations: [
            { id: 'OP-10', name: 'Seed', phases: ['N-010'] }
          ]},
          { id: 'UP-20', name: 'Production Culture', operations: [
            { id: 'OP-20', name: 'Culture', phases: ['N-020'] }
          ]},
          { id: 'UP-30', name: 'Harvest', operations: [
            { id: 'OP-30', name: 'Harvest', phases: ['N-030'] }
          ]},
          { id: 'UP-40', name: 'Capture (Chrom)', operations: [
            { id: 'OP-40', name: 'Capture', phases: ['N-040'] }
          ]},
          { id: 'UP-50', name: 'Polish', operations: [
            { id: 'OP-50', name: 'Polish', phases: ['N-050'] }
          ]},
          { id: 'UP-60', name: 'VF', operations: [
            { id: 'OP-60', name: 'Viral Filtration', phases: ['N-060'] }
          ]},
          { id: 'UP-70', name: 'Bulk Hold', operations: [
            { id: 'OP-70', name: 'Bulk Hold', phases: ['N-070'] }
          ]},
          { id: 'UP-80', name: 'Aseptic Fill (optional DP)', operations: [
            { id: 'OP-80', name: 'Aseptic Fill', phases: ['N-080'] }
          ]}
        ]
      },
      nodes: [
        { nodeId: 'N-010', type: 'phase', label: 'Seed Train', phaseRef: 'PH-BIO-SEED', kind: 'culture', nextStep: 'N-020',
          esig: { required: false, meaning: '', perform: false, verify: false },
          interlockRef: '', equipmentClassRef: 'EC-BRX-SEED', note: '표시용 kind=culture · 골격 시드 · 발행 freeze 후 생산 보드 Phase 라벨' },
        { nodeId: 'N-020', type: 'phase', label: 'Production Culture', phaseRef: 'PH-BIO-CULTURE', kind: 'culture', nextStep: 'N-030',
          esig: { required: false, meaning: '', perform: false, verify: false },
          interlockRef: '', equipmentClassRef: 'EC-BRX-PROD', note: '표시용 kind=culture' },
        { nodeId: 'N-030', type: 'phase', label: 'Harvest', phaseRef: 'PH-BIO-HARVEST', kind: 'culture', nextStep: 'N-040',
          esig: { required: false, meaning: '', perform: false, verify: false },
          interlockRef: '', equipmentClassRef: '', note: '표시용 kind=culture' },
        { nodeId: 'N-040', type: 'phase', label: 'Capture (Chrom)', phaseRef: 'PH-BIO-CAPTURE', kind: 'purify', nextStep: 'N-050',
          esig: { required: false, meaning: '', perform: false, verify: false },
          interlockRef: '', equipmentClassRef: 'EC-CHR-01', note: '표시용 kind=purify' },
        { nodeId: 'N-050', type: 'phase', label: 'Polish', phaseRef: 'PH-BIO-POLISH', kind: 'purify', nextStep: 'N-060',
          esig: { required: false, meaning: '', perform: false, verify: false },
          interlockRef: '', equipmentClassRef: 'EC-CHR-02', note: '표시용 kind=purify' },
        { nodeId: 'N-060', type: 'phase', label: 'VF', phaseRef: 'PH-BIO-VF', kind: 'purify', nextStep: 'N-070',
          esig: { required: false, meaning: '', perform: false, verify: false },
          interlockRef: '', equipmentClassRef: 'EC-VF-01', note: 'Viral Filtration · kind=purify' },
        { nodeId: 'N-070', type: 'phase', label: 'Bulk Hold', phaseRef: 'PH-BIO-HOLD', kind: 'bufferPrep', nextStep: 'N-080',
          esig: { required: false, meaning: '', perform: false, verify: false },
          interlockRef: '', equipmentClassRef: '', note: '표시용 kind=bufferPrep · DS bulk hold' },
        { nodeId: 'N-080', type: 'phase', label: 'Aseptic Fill', phaseRef: 'PH-BIO-FILL', kind: 'asepticFill', nextStep: '',
          esig: { required: false, meaning: '', perform: false, verify: false },
          interlockRef: '', equipmentClassRef: 'EC-FILL-01', note: 'optional DP · kind=asepticFill' }
      ],
      edges: [
        { from: 'N-010', to: 'N-020', type: 'seq', label: '다음' },
        { from: 'N-020', to: 'N-030', type: 'seq', label: '다음' },
        { from: 'N-030', to: 'N-040', type: 'seq', label: '다음' },
        { from: 'N-040', to: 'N-050', type: 'seq', label: '다음' },
        { from: 'N-050', to: 'N-060', type: 'seq', label: '다음' },
        { from: 'N-060', to: 'N-070', type: 'seq', label: '다음' },
        { from: 'N-070', to: 'N-080', type: 'seq', label: '다음 (optional DP)' }
      ],
      contentHash: '',
      meta: { updatedAt: null, author: 'PoC-BIO-P0' }
    };
  }

  /** 내장 시나리오 — assets/samples/*.sample.json 과 같은 내용 (file:// 에서도 열리도록 인라인) */
  var SCENARIOS = [
    { key: "branch", label: "분기 시나리오 (루프 · 체인 · OP 경계)", data: {"schemaVersion": "layers-1-2-tree-poc-1","objectType": "mbr-process-tree","id": "MBR-TAB-0421","ver": 1,"status": "draft","name": "에이정 10mg · 직접 타정 · 분기 시나리오","product": {"productCode": "TAB-0421","dosageForm": "tablet","strength": "10 mg"},"_scenario": {"purpose": "IF 분기 · 예외 종료 · 되돌아가기 · 예외 체인 · 공유 예외 대상 · OP 경계 넘는 예외를 한 트리에 담아 디자이너 렌더링과 흐름 표현을 점검","cases": ["C1 되돌아가기(루프): N-010 원료 칭량 → [LOT 만료] → N-012 LOT 교체 → seq → N-010","C2 예외 체인: N-010 → [재칭량 후 재편차] → N-016 칭량 일탈 → seq → N-019 배치 보류 (재칭량 = 같은 줄 새 시도, 개정 4)","C3 예외 종료(terminal): N-019 배치 보류는 nextStep 없음 · 다음 seq 없음","C4 공유 예외 대상: N-025 혼합 QA 판정과 N-036 IPC 재검이 모두 N-019 배치 보류로 감","C5 OP 경계 넘는 예외: N-036(OP-30 타정)이 OP-10 소속 N-016 칭량 일탈로 분기","C6 IF 분기 후 합류: N-030 타정 IPC → [경도 불합격] → N-035 재타정 → N-036 IPC 재검 → seq → N-040 코팅 (본류 합류)","C7 되돌아가기 2: N-050 PTP 포장 → [라벨 불일치] → N-055 라벨 폐기 · 재발행 → seq → N-050","C8 조건 2개 이상 한 노드: N-010에 예외 2개(LOT 만료 · 재편차), N-025에 예외 1개 + seq 합류","X1 N-010: 작업 지시(본문 안 이미지 1 · 첨부 1) · 입력 항목 6(콤보 · 라벨 · 숫자 범위 · 일시 · 다중 · 텍스트) · OP 서명 없음(칭량은 줄마다 2인 서명, Q8)","C9 건너뛰기 가능 노드: N-045 코팅 후 외관 사진 기록 (참고) — execRule.skippable true, QA 승인 시 skipped (프로세스 트리 실행 설계 §5.2)"]},"procedure": {"unitProcedures": [{"id": "UP-10","name": "조제","operations": [{"id": "OP-10","name": "원료 칭량","phases": ["N-010","N-012","N-016","N-019"]},{"id": "OP-20","name": "혼합","phases": ["N-020","N-025"]}]},{"id": "UP-20","name": "타정 · 코팅","operations": [{"id": "OP-30","name": "타정 · IPC","phases": ["N-030","N-035","N-036"]},{"id": "OP-35","name": "코팅","phases": ["N-040","N-045"]}]},{"id": "UP-30","name": "포장","operations": [{"id": "OP-40","name": "PTP 포장","phases": ["N-050","N-055"]}]}]},"nodes": [{"nodeId": "N-010","type": "phase","label": "원료 칭량","phaseRef": "PH-WEIGH-01","materials": [{"materialId": "MAT-API","tolPct": 0.5,"balanceClass": "EC-BAL-02"},{"materialId": "MAT-LAC","tolPct": 0.5,"balanceClass": "EC-BAL-02"},{"materialId": "MAT-MGS","tolPct": 1.0,"balanceClass": "EC-BAL-01"}],"nextStep": "N-020","esig": {"required": false,"meaning": "","perform": false,"verify": false},"interlockRef": "ILR-WEIGH-LOT","equipmentClassRef": "EC-BAL-02","note": "IF LOT 만료 → N-012 · IF 재칭량 후 재편차 → N-016","instruction": {"text": "1. 저울 BAL-205 영점 확인 후 교정 라벨 유효기간을 확인한다.\n![칭량 작업대 배치 · 교정 라벨 위치](IMG-weigh-layout)\n2. 원료 LOT 바코드를 스캔하고 지시량 ±0.5 % 안에서 칭량한다. 절차는 첨부를 따른다.\n[📎 SOP-WEIGH-01.txt](ATT-sop-weigh-01)\n3. 범위를 벗어나면 재칭량 승인 후 같은 줄에서 다시 칭량한다.","assets": [{"id": "IMG-weigh-layout","name": "weigh-layout.svg","caption": "칭량 작업대 배치 · 교정 라벨 위치","w": 480,"h": 300,"hash": "","dataUrl": "data:image/svg+xml;utf8,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20width=%27480%27%20height=%27300%27%3E%3Crect%20width=%27480%27%20height=%27300%27%20fill=%27%23f3f6fb%27/%3E%3Crect%20x=%2740%27%20y=%2760%27%20width=%27400%27%20height=%27180%27%20rx=%278%27%20fill=%27%23fff%27%20stroke=%27%232C59D9%27%20stroke-width=%273%27/%3E%3Crect%20x=%2770%27%20y=%2790%27%20width=%27120%27%20height=%27120%27%20fill=%27%23e8eefc%27%20stroke=%27%235c7cfa%27/%3E%3Ctext%20x=%27130%27%20y=%27160%27%20font-size=%2716%27%20text-anchor=%27middle%27%20fill=%27%232C59D9%27%20font-family=%27sans-serif%27%3E저울%20BAL-205%3C/text%3E%3Crect%20x=%27230%27%20y=%27110%27%20width=%27180%27%20height=%2740%27%20fill=%27%23fff8e1%27%20stroke=%27%23e6a817%27/%3E%3Ctext%20x=%27320%27%20y=%27136%27%20font-size=%2714%27%20text-anchor=%27middle%27%20fill=%27%238a6d00%27%20font-family=%27sans-serif%27%3E교정%20라벨%20확인%3C/text%3E%3Ctext%20x=%27240%27%20y=%27200%27%20font-size=%2713%27%20fill=%27%23333%27%20font-family=%27sans-serif%27%3E영점%20→%20LOT%20스캔%20→%20칭량%3C/text%3E%3C/svg%3E","kind": "image","size": 1065},{"id": "ATT-sop-weigh-01","kind": "file","name": "SOP-WEIGH-01.txt","mime": "text/plain","caption": "칭량 표준작업절차 발췌","size": 160,"hash": "","dataUrl": "data:text/plain;charset=utf-8,SOP-WEIGH-01%20%EC%B9%AD%EB%9F%89%20%ED%91%9C%EC%A4%80%EC%9E%91%EC%97%85%EC%A0%88%EC%B0%A8%20(PoC%20%EC%83%98%ED%94%8C)%0A1.%20%EC%98%81%EC%A0%90%20%ED%99%95%EC%9D%B8%0A2.%20LOT%20%EC%8A%A4%EC%BA%94%0A3.%20%EC%B9%AD%EB%9F%89%20%C2%B10.5%25"}]},"inputs": [{"key": "lot","label": "원료 LOT","type": "combo","required": true,"critical": true,"options": ["API-2409","API-2410"],"evidence": "barcode"},{"key": "target_kg","label": "지시량","type": "label","unit": "kg","value": "20.000"},{"key": "actual_kg","label": "칭량값","type": "number","required": true,"critical": true,"unit": "kg","min": 19.9,"max": 20.1,"decimals": 3,"evidence": "device_log"},{"key": "weighed_at","label": "칭량 일시","type": "datetime","required": true},{"key": "balance","label": "저울 · 교정","type": "multi","parts": [{"label": "저울 ID","type": "combo","options": ["BAL-205","BAL-206"]},{"label": "교정 유효","type": "check"},{"label": "교정일","type": "date"}]},{"key": "remark","label": "비고","type": "text"}]},{"nodeId": "N-012","type": "phase","label": "원료 LOT 교체","phaseRef": "PH-LOT-SWAP","nextStep": "N-010","esig": {"required": true,"meaning": "LOT 교체 확인","perform": true,"verify": false},"interlockRef": "","equipmentClassRef": "","note": "교체 후 칭량으로 되돌아감 (루프)"},{"nodeId": "N-016","type": "phase","label": "칭량 일탈 발행","phaseRef": "PH-DEV-OPEN","nextStep": "N-019","esig": {"required": true,"meaning": "일탈 발행 확인","perform": true,"verify": true},"interlockRef": "","equipmentClassRef": "","note": "QA 통보 · 배치 보류로 이어짐"},{"nodeId": "N-019","type": "phase","label": "배치 보류 (종료)","phaseRef": "PH-HOLD","nextStep": "","esig": {"required": true,"meaning": "보류 승인","perform": false,"verify": true},"interlockRef": "","equipmentClassRef": "","note": "다음 단계 없음 · 출하 게이트에서 미결로 차단"},{"nodeId": "N-020","type": "phase","label": "혼합","phaseRef": "PH-MIX-01","nextStep": "N-030","esig": {"required": false,"meaning": "","perform": false,"verify": false},"interlockRef": "","equipmentClassRef": "EC-MIX-01","note": "IF 혼합 시간 초과 → N-025"},{"nodeId": "N-025","type": "phase","label": "혼합 QA 판정","phaseRef": "PH-MIX-QA","nextStep": "N-030","esig": {"required": true,"meaning": "혼합 QA 판정","perform": false,"performRole": "OPERATOR","performAuth": "pin_session","verify": true,"verifyRole": "QA","verifyAuth": "full_factor","approve": true,"approveRole": "QA_MGR","approveAuth": "full_factor","distinct": true},"interlockRef": "","equipmentClassRef": "","note": "IF 합격 → N-030 합류 · IF 불합격 → N-019 보류","instruction": {"text": "일탈 내용과 재칭량 결과를 검토하고 처분(합격 · 보류 · 폐기)을 결정한다.\n결정 사유를 반드시 기록한다.","assets": []},"inputs": [{"key": "decision","label": "처분","type": "combo","required": true,"critical": true,"options": ["합격 → 혼합 합류","추가 조사 → 배치 보류","불합격 → 배치 폐기"]},{"key": "reason","label": "결정 사유","type": "text","required": true},{"key": "decided_at","label": "결정 일시","type": "datetime","required": true}]},{"nodeId": "N-030","type": "phase","label": "타정 · IPC","phaseRef": "PH-COMP-01","nextStep": "N-040","esig": {"required": false,"meaning": "","perform": false,"verify": false},"interlockRef": "ILR-IPC-HARDNESS","equipmentClassRef": "EC-TAB-01","note": "IF 경도 불합격 → N-035"},{"nodeId": "N-035","type": "phase","label": "재타정","phaseRef": "PH-COMP-REDO","nextStep": "N-036","esig": {"required": false,"meaning": "","perform": false,"verify": false},"interlockRef": "ILR-IPC-HARDNESS","equipmentClassRef": "EC-TAB-01","note": ""},{"nodeId": "N-036","type": "phase","label": "IPC 재검","phaseRef": "PH-IPC-RECHECK","nextStep": "N-040","esig": {"required": true,"meaning": "IPC 재검 확인","perform": true,"verify": true},"interlockRef": "","equipmentClassRef": "","note": "IF 2회 불합격 → N-016 (다른 OP의 일탈 노드)"},{"nodeId": "N-040","type": "phase","label": "코팅","phaseRef": "PH-COAT-01","nextStep": "N-045","esig": {"required": false,"meaning": "","perform": false,"verify": false},"interlockRef": "","equipmentClassRef": "EC-COT-01","note": ""},{"nodeId": "N-045","type": "phase","label": "코팅 후 외관 사진 기록 (참고)","phaseRef": "PH-PHOTO-REF","nextStep": "N-050","esig": {"required": false,"perform": false,"verify": false},"interlockRef": "","equipmentClassRef": "","note": "건너뛰기 가능 (QA 승인) — 품질 판정 값 아님","inputs": [{"key": "photo","label": "외관 사진","type": "photo","required": false},{"key": "memo","label": "메모","type": "text","required": false}],"execRule": {"skippable": true,"maxRepeat": 1}},{"nodeId": "N-050","type": "phase","label": "PTP 포장","phaseRef": "PH-PACK-01","nextStep": "","esig": {"required": false,"meaning": "","perform": false,"verify": false},"interlockRef": "","equipmentClassRef": "EC-PKG-01","note": "IF 라벨 불일치 → N-055"},{"nodeId": "N-055","type": "phase","label": "라벨 폐기 · 재발행","phaseRef": "PH-LABEL-REISSUE","nextStep": "N-050","esig": {"required": true,"meaning": "라벨 재발행 확인","perform": true,"verify": true},"interlockRef": "","equipmentClassRef": "","note": "재발행 후 포장으로 되돌아감 (루프)"}],"edges": [{"from": "N-010","to": "N-020","type": "seq","label": "다음"},{"from": "N-010","to": "N-012","type": "exception","label": "IF 원료 LOT 만료 → LOT 교체"},{"from": "N-010","to": "N-016","type": "exception","label": "IF 재칭량 후 재편차 → 일탈 발행"},{"from": "N-012","to": "N-010","type": "seq","label": "교체 완료 → 칭량 재시작"},{"from": "N-016","to": "N-019","type": "seq","label": "일탈 발행 → 배치 보류"},{"from": "N-020","to": "N-030","type": "seq","label": "다음"},{"from": "N-020","to": "N-025","type": "exception","label": "IF 혼합 시간 초과 → QA 판정"},{"from": "N-025","to": "N-030","type": "seq","label": "QA 합격 → 타정 합류"},{"from": "N-025","to": "N-019","type": "exception","label": "IF QA 불합격 → 배치 보류"},{"from": "N-030","to": "N-040","type": "seq","label": "다음"},{"from": "N-030","to": "N-035","type": "exception","label": "IF 경도 불합격 → 재타정"},{"from": "N-035","to": "N-036","type": "seq","label": "재타정 → IPC 재검"},{"from": "N-036","to": "N-040","type": "seq","label": "재검 합격 → 코팅 합류"},{"from": "N-036","to": "N-016","type": "exception","label": "IF 2회 불합격 → 칭량 일탈 노드 재사용"},{"from": "N-040","to": "N-045","type": "seq","label": "다음"},{"from": "N-045","to": "N-050","type": "seq","label": "다음"},{"from": "N-050","to": "N-055","type": "exception","label": "IF 라벨 불일치 → 라벨 폐기 · 재발행"},{"from": "N-055","to": "N-050","type": "seq","label": "재발행 → 포장 재시작"}],"contentHash": "","meta": {"updatedAt": null,"author": "PoC"}} },
    { key: "multi-end", label: "다중 종료 층 시나리오 (출구 2 · 예외 종료 4)", data: {"schemaVersion": "layers-1-2-tree-poc-1","objectType": "mbr-process-tree","id": "MBR-TAB-0422","ver": 1,"status": "draft","name": "에이정 10mg · 직접 타정 · 다중 종료 시나리오","product": {"productCode": "TAB-0422","dosageForm": "tablet","strength": "10 mg"},"_scenario": {"purpose": "한 OP 안에 정상 출구 여러 개와 예외 종료 여러 개가 같은 종료 층에 나란히 놓이는 경우 — 종료 층 · 분기 ◇ · 합류 ● 렌더링 점검","cases": ["E1 OP-10 종료 층: 출구 2개(N-010 · N-018 → N-020) + 예외 종료 4개(N-013 LOT 격리 · N-014 설비 사용 차단 · N-017 배치 보류 · N-019 배치 폐기)","E2 한 노드에서 예외 3개 분기: N-010 → LOT 부적합 / 저울 교정 만료 / 재칭량 후 재편차","E3 예외 노드에서 다시 2갈래 예외 종료: N-018 QA 판정 → 보류(N-017) / 폐기(N-019), 합격이면 N-020 합류","E4 OP-20: 예외 QA 판정 후 정상 합류(N-030)와 예외 종료(N-026 폐기)","E5 OP-30: 본류 정상 종료(■ 종료) + 재타정 되돌아가기 루프 — 정상 종료와 예외 종료를 같은 트리에서 구분","X1 N-010: 작업 지시(본문 안 이미지 1 · 첨부 1) · 입력 항목 6(콤보 · 라벨 · 숫자 범위 · 일시 · 다중 · 텍스트) · OP 서명 없음(칭량은 줄마다 2인 서명, Q8)"]},"procedure": {"unitProcedures": [{"id": "UP-10","name": "조제","operations": [{"id": "OP-10","name": "원료 칭량 · 확인","phases": ["N-010","N-013","N-014","N-016","N-018","N-017","N-019"]},{"id": "OP-20","name": "혼합","phases": ["N-020","N-025","N-026"]}]},{"id": "UP-20","name": "타정","operations": [{"id": "OP-30","name": "타정 · IPC","phases": ["N-030","N-035"]}]}]},"nodes": [{"nodeId": "N-010","type": "phase","label": "원료 칭량","phaseRef": "PH-WEIGH-01","materials": [{"materialId": "MAT-API","tolPct": 0.5,"balanceClass": "EC-BAL-02"},{"materialId": "MAT-LAC","tolPct": 0.5,"balanceClass": "EC-BAL-02"},{"materialId": "MAT-MGS","tolPct": 1.0,"balanceClass": "EC-BAL-01"}],"nextStep": "N-020","esig": {"required": false,"meaning": "","perform": false,"verify": false},"interlockRef": "ILR-WEIGH-LOT","equipmentClassRef": "EC-BAL-02","note": "예외 3갈래: LOT 부적합 · 교정 만료 · 재편차","instruction": {"text": "1. 저울 BAL-205 영점 확인 후 교정 라벨 유효기간을 확인한다.\n![칭량 작업대 배치 · 교정 라벨 위치](IMG-weigh-layout)\n2. 원료 LOT 바코드를 스캔하고 지시량 ±0.5 % 안에서 칭량한다. 절차는 첨부를 따른다.\n[📎 SOP-WEIGH-01.txt](ATT-sop-weigh-01)\n3. 범위를 벗어나면 재칭량 승인 후 같은 줄에서 다시 칭량한다.","assets": [{"id": "IMG-weigh-layout","name": "weigh-layout.svg","caption": "칭량 작업대 배치 · 교정 라벨 위치","w": 480,"h": 300,"hash": "","dataUrl": "data:image/svg+xml;utf8,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20width=%27480%27%20height=%27300%27%3E%3Crect%20width=%27480%27%20height=%27300%27%20fill=%27%23f3f6fb%27/%3E%3Crect%20x=%2740%27%20y=%2760%27%20width=%27400%27%20height=%27180%27%20rx=%278%27%20fill=%27%23fff%27%20stroke=%27%232C59D9%27%20stroke-width=%273%27/%3E%3Crect%20x=%2770%27%20y=%2790%27%20width=%27120%27%20height=%27120%27%20fill=%27%23e8eefc%27%20stroke=%27%235c7cfa%27/%3E%3Ctext%20x=%27130%27%20y=%27160%27%20font-size=%2716%27%20text-anchor=%27middle%27%20fill=%27%232C59D9%27%20font-family=%27sans-serif%27%3E저울%20BAL-205%3C/text%3E%3Crect%20x=%27230%27%20y=%27110%27%20width=%27180%27%20height=%2740%27%20fill=%27%23fff8e1%27%20stroke=%27%23e6a817%27/%3E%3Ctext%20x=%27320%27%20y=%27136%27%20font-size=%2714%27%20text-anchor=%27middle%27%20fill=%27%238a6d00%27%20font-family=%27sans-serif%27%3E교정%20라벨%20확인%3C/text%3E%3Ctext%20x=%27240%27%20y=%27200%27%20font-size=%2713%27%20fill=%27%23333%27%20font-family=%27sans-serif%27%3E영점%20→%20LOT%20스캔%20→%20칭량%3C/text%3E%3C/svg%3E","kind": "image","size": 1065},{"id": "ATT-sop-weigh-01","kind": "file","name": "SOP-WEIGH-01.txt","mime": "text/plain","caption": "칭량 표준작업절차 발췌","size": 160,"hash": "","dataUrl": "data:text/plain;charset=utf-8,SOP-WEIGH-01%20%EC%B9%AD%EB%9F%89%20%ED%91%9C%EC%A4%80%EC%9E%91%EC%97%85%EC%A0%88%EC%B0%A8%20(PoC%20%EC%83%98%ED%94%8C)%0A1.%20%EC%98%81%EC%A0%90%20%ED%99%95%EC%9D%B8%0A2.%20LOT%20%EC%8A%A4%EC%BA%94%0A3.%20%EC%B9%AD%EB%9F%89%20%C2%B10.5%25"}]},"inputs": [{"key": "lot","label": "원료 LOT","type": "combo","required": true,"critical": true,"options": ["API-2409","API-2410"],"evidence": "barcode"},{"key": "target_kg","label": "지시량","type": "label","unit": "kg","value": "20.000"},{"key": "actual_kg","label": "칭량값","type": "number","required": true,"critical": true,"unit": "kg","min": 19.9,"max": 20.1,"decimals": 3,"evidence": "device_log"},{"key": "weighed_at","label": "칭량 일시","type": "datetime","required": true},{"key": "balance","label": "저울 · 교정","type": "multi","parts": [{"label": "저울 ID","type": "combo","options": ["BAL-205","BAL-206"]},{"label": "교정 유효","type": "check"},{"label": "교정일","type": "date"}]},{"key": "remark","label": "비고","type": "text"}]},{"nodeId": "N-013","type": "phase","label": "원료 LOT 격리 (예외 종료)","phaseRef": "PH-LOT-QUARANTINE","nextStep": "","esig": {"required": true,"meaning": "격리 확인","perform": true,"verify": true},"interlockRef": "","equipmentClassRef": "","note": "자재 상태 격리 → 배치 진행 불가"},{"nodeId": "N-014","type": "phase","label": "설비 사용 차단 (예외 종료)","phaseRef": "PH-EQ-BLOCK","nextStep": "","esig": {"required": false,"meaning": "","perform": false,"verify": false},"interlockRef": "ILR-CAL-ABS","equipmentClassRef": "EC-BAL-01","note": "교정 만료 Absolute 인터록 · 대체 설비 없으면 보류"},{"nodeId": "N-016","type": "phase","label": "칭량 일탈 발행","phaseRef": "PH-DEV-OPEN","nextStep": "N-018","esig": {"required": true,"meaning": "일탈 발행 확인","perform": true,"verify": true},"interlockRef": "","equipmentClassRef": "","note": ""},{"nodeId": "N-018","type": "phase","label": "QA 판정","phaseRef": "PH-QA-DECIDE","nextStep": "N-020","esig": {"required": true,"meaning": "QA 판정","perform": false,"performRole": "OPERATOR","performAuth": "pin_session","verify": true,"verifyRole": "QA","verifyAuth": "full_factor","approve": true,"approveRole": "QA_MGR","approveAuth": "full_factor","distinct": true},"interlockRef": "","equipmentClassRef": "","note": "합격 → 혼합 합류 · 추가 조사 → 보류 · 불합격 → 폐기","instruction": {"text": "일탈 내용과 재칭량 결과를 검토하고 처분(합격 · 보류 · 폐기)을 결정한다.\n결정 사유를 반드시 기록한다.","assets": []},"inputs": [{"key": "decision","label": "처분","type": "combo","required": true,"critical": true,"options": ["합격 → 혼합 합류","추가 조사 → 배치 보류","불합격 → 배치 폐기"]},{"key": "reason","label": "결정 사유","type": "text","required": true},{"key": "decided_at","label": "결정 일시","type": "datetime","required": true}]},{"nodeId": "N-017","type": "phase","label": "배치 보류 (예외 종료)","phaseRef": "PH-HOLD","nextStep": "","esig": {"required": true,"meaning": "보류 승인","perform": false,"verify": true},"interlockRef": "","equipmentClassRef": "","note": "출하 게이트에서 미결로 차단"},{"nodeId": "N-019","type": "phase","label": "배치 폐기 (예외 종료)","phaseRef": "PH-REJECT","nextStep": "","esig": {"required": true,"meaning": "폐기 승인","perform": false,"verify": true},"interlockRef": "","equipmentClassRef": "","note": ""},{"nodeId": "N-020","type": "phase","label": "혼합","phaseRef": "PH-MIX-01","nextStep": "N-030","esig": {"required": false,"meaning": "","perform": false,"verify": false},"interlockRef": "","equipmentClassRef": "EC-MIX-01","note": ""},{"nodeId": "N-025","type": "phase","label": "혼합 QA 판정","phaseRef": "PH-MIX-QA","nextStep": "N-030","esig": {"required": true,"meaning": "혼합 QA 판정","perform": false,"performRole": "OPERATOR","performAuth": "pin_session","verify": true,"verifyRole": "QA","verifyAuth": "full_factor","approve": true,"approveRole": "QA_MGR","approveAuth": "full_factor","distinct": true},"interlockRef": "","equipmentClassRef": "","note": "","instruction": {"text": "일탈 내용과 재칭량 결과를 검토하고 처분(합격 · 보류 · 폐기)을 결정한다.\n결정 사유를 반드시 기록한다.","assets": []},"inputs": [{"key": "decision","label": "처분","type": "combo","required": true,"critical": true,"options": ["합격 → 혼합 합류","추가 조사 → 배치 보류","불합격 → 배치 폐기"]},{"key": "reason","label": "결정 사유","type": "text","required": true},{"key": "decided_at","label": "결정 일시","type": "datetime","required": true}]},{"nodeId": "N-026","type": "phase","label": "배치 폐기 (예외 종료)","phaseRef": "PH-REJECT","nextStep": "","esig": {"required": true,"meaning": "폐기 승인","perform": false,"verify": true},"interlockRef": "","equipmentClassRef": "","note": ""},{"nodeId": "N-030","type": "phase","label": "타정 · IPC","phaseRef": "PH-COMP-01","nextStep": "","esig": {"required": false,"meaning": "","perform": false,"verify": false},"interlockRef": "ILR-IPC-HARDNESS","equipmentClassRef": "EC-TAB-01","note": "본류 정상 종료 (다음 없음)"},{"nodeId": "N-035","type": "phase","label": "재타정","phaseRef": "PH-COMP-REDO","nextStep": "N-030","esig": {"required": false,"meaning": "","perform": false,"verify": false},"interlockRef": "ILR-IPC-HARDNESS","equipmentClassRef": "EC-TAB-01","note": "타정으로 되돌아감"}],"edges": [{"from": "N-010","to": "N-020","type": "seq","label": "다음"},{"from": "N-010","to": "N-013","type": "exception","label": "IF 원료 LOT 부적합 → 격리"},{"from": "N-010","to": "N-014","type": "exception","label": "IF 저울 교정 만료 → 설비 차단"},{"from": "N-010","to": "N-016","type": "exception","label": "IF 재칭량 후 재편차 → 일탈 발행"},{"from": "N-016","to": "N-018","type": "seq","label": "일탈 → QA 판정"},{"from": "N-018","to": "N-020","type": "seq","label": "QA 합격 → 혼합 합류"},{"from": "N-018","to": "N-017","type": "exception","label": "IF 추가 조사 → 배치 보류"},{"from": "N-018","to": "N-019","type": "exception","label": "IF 불합격 → 배치 폐기"},{"from": "N-020","to": "N-030","type": "seq","label": "다음"},{"from": "N-020","to": "N-025","type": "exception","label": "IF 혼합 시간 초과 → QA 판정"},{"from": "N-025","to": "N-030","type": "seq","label": "QA 합격 → 타정 합류"},{"from": "N-025","to": "N-026","type": "exception","label": "IF 불합격 → 배치 폐기"},{"from": "N-030","to": "N-035","type": "exception","label": "IF 경도 불합격 → 재타정"},{"from": "N-035","to": "N-030","type": "seq","label": "재타정 → IPC 재검"}],"contentHash": "","meta": {"updatedAt": null,"author": "PoC"}} }
  ];
  function scenarioTree(key) {
    for (var i = 0; i < SCENARIOS.length; i++) { if (SCENARIOS[i].key === key) return clone(SCENARIOS[i].data); }
    return null;
  }

  function emptyTree() {
    return {
      schemaVersion: SCHEMA,
      objectType: 'mbr-process-tree',
      id: '',
      ver: 1,
      status: 'draft',
      name: '새 프로세스 트리',
      product: { productCode: '', dosageForm: 'tablet', strength: '' },
      procedure: { unitProcedures: [] },
      nodes: [],
      edges: [],
      contentHash: '',
      meta: { updatedAt: null, author: 'PoC' }
    };
  }

  function clone(o) {
    return JSON.parse(JSON.stringify(o));
  }

  function findNode(model, id) {
    if (!model || !model.nodes) return null;
    for (var i = 0; i < model.nodes.length; i++) {
      if (model.nodes[i].nodeId === id) return model.nodes[i];
    }
    return null;
  }

  function nextNodeId(model) {
    var max = 0;
    (model.nodes || []).forEach(function (n) {
      var m = /^N-(\d+)$/.exec(n.nodeId || '');
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    return 'N-' + String(max + 10).padStart(3, '0');
  }

  function nextUpId(model) {
    var max = 0;
    ((model.procedure && model.procedure.unitProcedures) || []).forEach(function (u) {
      var m = /^UP-(\d+)$/.exec(u.id || '');
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    return 'UP-' + String(max + 10);
  }

  function nextOpId(model) {
    var max = 0;
    ((model.procedure && model.procedure.unitProcedures) || []).forEach(function (u) {
      (u.operations || []).forEach(function (o) {
        var m = /^OP-(\d+)$/.exec(o.id || '');
        if (m) max = Math.max(max, parseInt(m[1], 10));
      });
    });
    return 'OP-' + String(max + 10);
  }

  /** Flatten outline rows: UP / OP / Phase */
  function buildOutline(model) {
    var rows = [];
    var ups = (model.procedure && model.procedure.unitProcedures) || [];
    ups.forEach(function (up, ui) {
      rows.push({ kind: 'up', id: up.id, name: up.name, upIndex: ui, depth: 0 });
      (up.operations || []).forEach(function (op, oi) {
        rows.push({ kind: 'op', id: op.id, name: op.name, upIndex: ui, opIndex: oi, depth: 1 });
        (op.phases || []).forEach(function (pid, pi) {
          var n = findNode(model, pid);
          rows.push({
            kind: 'phase',
            id: pid,
            name: n ? n.label : pid,
            upIndex: ui,
            opIndex: oi,
            phaseIndex: pi,
            depth: 2,
            node: n
          });
        });
      });
    });
    /* orphan phases not in procedure */
    var linked = {};
    ups.forEach(function (up) {
      (up.operations || []).forEach(function (op) {
        (op.phases || []).forEach(function (pid) { linked[pid] = true; });
      });
    });
    (model.nodes || []).forEach(function (n) {
      if (!linked[n.nodeId]) {
        rows.push({ kind: 'phase', id: n.nodeId, name: n.label, depth: 0, orphan: true, node: n });
      }
    });
    return rows;
  }

  function syncNextFromEdges(model) {
    (model.nodes || []).forEach(function (n) {
      var seq = (model.edges || []).filter(function (e) {
        return e.from === n.nodeId && e.type === 'seq';
      });
      n.nextStep = seq.length ? seq[0].to : (n.nextStep || '');
    });
  }

  function ensureEdgeForNext(model, nodeId, nextId) {
    model.edges = (model.edges || []).filter(function (e) {
      return !(e.from === nodeId && e.type === 'seq');
    });
    if (nextId) {
      model.edges.push({ from: nodeId, to: nextId, type: 'seq', label: '다음' });
    }
  }

  function exceptionEdgesOf(model, nodeId) {
    return (model.edges || []).filter(function (e) {
      return e.from === nodeId && e.type === 'exception';
    });
  }

  /* ------------------------------------------------------------------ content hash (D-Q2)
     Canonical JSON of content fields only — exclude status, author, updatedAt/sync times.
     Sync SHA-256 (pure JS) so PoC save/issue paths stay synchronous. */
  function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) {
      return '[' + value.map(stableStringify).join(',') + ']';
    }
    var keys = Object.keys(value).sort();
    return '{' + keys.map(function (k) {
      return JSON.stringify(k) + ':' + stableStringify(value[k]);
    }).join(',') + '}';
  }

  function canonicalContent(model) {
    if (!model) return {};
    return {
      schemaVersion: model.schemaVersion || SCHEMA,
      objectType: model.objectType || 'mbr-process-tree',
      id: model.id || '',
      ver: model.ver == null ? 1 : model.ver,
      name: model.name || '',
      product: model.product || {},
      procedure: model.procedure || { unitProcedures: [] },
      nodes: (model.nodes || []).map(function (n) {
        var ins = n.instruction;
        if (!ins || (!(ins.assets || []).length && !(ins.images || []).length)) return n;
        var c = clone(n);
        /* 이미지·첨부 바이트(dataUrl)는 해시 제외, 파일 hash 만 포함 */
        var strip = function (a) { return { id: a.id, kind: a.kind || 'image', name: a.name, caption: a.caption || '', mime: a.mime || '', size: a.size || 0, w: a.w, h: a.h, hash: a.hash || '' }; };
        if (c.instruction.assets) c.instruction.assets = c.instruction.assets.map(strip);
        if (c.instruction.images) c.instruction.images = c.instruction.images.map(strip);
        return c;
      }),
      edges: model.edges || []
    };
  }

  /* Compact sync SHA-256 (UTF-8 bytes → hex) */
  function sha256Hex(str) {
    function rotr(n, x) { return (x >>> n) | (x << (32 - n)); }
    function utf8Bytes(s) {
      var out = [];
      for (var i = 0; i < s.length; i++) {
        var c = s.charCodeAt(i);
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
        else if (c >= 0xd800 && c <= 0xdbff) {
          var c2 = s.charCodeAt(++i);
          var cp = 0x10000 + (((c & 0x3ff) << 10) | (c2 & 0x3ff));
          out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
      return out;
    }
    var K = [
      0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
      0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
      0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
      0x983e5152,0xa831c66d,0xb00327da,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
      0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
      0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
      0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
      0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
    ];
    var H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    var bytes = utf8Bytes(String(str));
    var l = bytes.length;
    var bitLenHi = Math.floor(l / 0x20000000);
    var bitLenLo = (l << 3) >>> 0;
    bytes.push(0x80);
    while ((bytes.length % 64) !== 56) bytes.push(0);
    bytes.push((bitLenHi >>> 24) & 0xff, (bitLenHi >>> 16) & 0xff, (bitLenHi >>> 8) & 0xff, bitLenHi & 0xff);
    bytes.push((bitLenLo >>> 24) & 0xff, (bitLenLo >>> 16) & 0xff, (bitLenLo >>> 8) & 0xff, bitLenLo & 0xff);
    for (var i = 0; i < bytes.length; i += 64) {
      var w = new Array(64);
      for (var j = 0; j < 16; j++) {
        var o = i + j * 4;
        w[j] = ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
      }
      for (var j2 = 16; j2 < 64; j2++) {
        var s0 = rotr(7, w[j2 - 15]) ^ rotr(18, w[j2 - 15]) ^ (w[j2 - 15] >>> 3);
        var s1 = rotr(17, w[j2 - 2]) ^ rotr(19, w[j2 - 2]) ^ (w[j2 - 2] >>> 10);
        w[j2] = (w[j2 - 16] + s0 + w[j2 - 7] + s1) >>> 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (var j3 = 0; j3 < 64; j3++) {
        var S1 = rotr(6, e) ^ rotr(11, e) ^ rotr(25, e);
        var ch = (e & f) ^ (~e & g);
        var t1 = (h + S1 + ch + K[j3] + w[j3]) >>> 0;
        var S0 = rotr(2, a) ^ rotr(13, a) ^ rotr(22, a);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }
    return H.map(function (x) {
      var s = (x >>> 0).toString(16);
      while (s.length < 8) s = '0' + s;
      return s;
    }).join('');
  }

  function computeContentHash(model) {
    return sha256Hex(stableStringify(canonicalContent(model)));
  }

  function shortHash(full) {
    if (!full) return '';
    return String(full).slice(0, 8) + '…';
  }

  /** Recalculate and store contentHash on model. Returns { full, short, changed }. */
  function applyContentHash(model) {
    var full = computeContentHash(model);
    var changed = model.contentHash !== full;
    model.contentHash = full;
    return { full: full, short: shortHash(full), changed: changed };
  }

  /* ------------------------------------------------------------------ status helpers */
  function normalizeStatus(st) {
    st = String(st || 'draft').toLowerCase();
    return STATUS_LABELS[st] ? st : 'draft';
  }

  function statusLabel(st) {
    return STATUS_LABELS[normalizeStatus(st)] || st;
  }

  function canTransition(from, to) {
    from = normalizeStatus(from);
    to = String(to || '').toLowerCase();
    var allowed = STATUS_TRANSITIONS[from] || [];
    return allowed.indexOf(to) >= 0;
  }

  function nextForwardStatus(from) {
    from = normalizeStatus(from);
    var i = STATUS_ORDER.indexOf(from);
    if (i < 0 || i >= STATUS_ORDER.length - 1) return null;
    return STATUS_ORDER[i + 1];
  }

  /**
   * Apply status transition. Status-only change must NOT alter contentHash.
   * Returns { ok, model, error }.
   */
  function transitionStatus(model, toStatus, opts) {
    opts = opts || {};
    if (!model) return { ok: false, error: '모델 없음' };
    var from = normalizeStatus(model.status);
    var to = String(toStatus || '').toLowerCase();
    if (!canTransition(from, to)) {
      return { ok: false, error: '허용되지 않은 전이: ' + statusLabel(from) + ' → ' + (STATUS_LABELS[to] || to) };
    }
    model.status = to;
    model.meta = model.meta || {};
    model.meta.updatedAt = new Date().toISOString();
    if (to === 'effective' && !model.effDate && !opts.effDate) {
      model.effDate = new Date().toISOString().slice(0, 10);
    }
    if (opts.effDate) model.effDate = opts.effDate;
    model.meta.statusHistory = model.meta.statusHistory || {};
    model.meta.statusHistory[to] = model.meta.updatedAt;
    return { ok: true, model: model };
  }

  function isIssuable(modelOrStatus) {
    var st = typeof modelOrStatus === 'string'
      ? modelOrStatus
      : (modelOrStatus && modelOrStatus.status);
    return normalizeStatus(st) === 'effective';
  }

  /* ------------------------------------------------------------------ load / save */
  function saveLocal(model) {
    model.meta = model.meta || {};
    model.meta.updatedAt = new Date().toISOString();
    if (!model.status) model.status = 'draft';
    applyContentHash(model);
    localStorage.setItem(LS_KEY, JSON.stringify(model));
    return true;
  }

  function loadLocal() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      var data = JSON.parse(raw);
      if (!data || typeof data !== 'object') return null;
      if (!data.status) data.status = 'draft';
      if (!data.contentHash) applyContentHash(data);
      return data;
    } catch (e) {
      return null;
    }
  }

  /** Return array of trees from LS (single object → [tree]). Empty → []. */
  function listTrees() {
    var one = loadLocal();
    if (!one) return [];
    if (Array.isArray(one.trees)) return one.trees;
    return [one];
  }

  function exportJson(model) {
    return JSON.stringify(model, null, 2);
  }

  function importJson(text) {
    var data = JSON.parse(text);
    if (!data || typeof data !== 'object') throw new Error('JSON 객체가 아닙니다');
    if (!Array.isArray(data.nodes)) data.nodes = [];
    if (!Array.isArray(data.edges)) data.edges = [];
    if (!data.procedure) data.procedure = { unitProcedures: [] };
    if (!data.schemaVersion) data.schemaVersion = SCHEMA;
    if (!data.status) data.status = 'draft';
    applyContentHash(data);
    return data;
  }

  /* Map process tree → batch-issue grid row shape */
  function treeToIssueRow(tree, opts) {
    opts = opts || {};
    var hashFull = tree.contentHash || computeContentHash(tree);
    var prod = tree.product || {};
    var prodCode = prod.productCode || '';
    var productName = tree.name || prodCode || '(이름 없음)';
    var hist = (tree.meta && tree.meta.statusHistory) || {};
    var histShort = {};
    Object.keys(hist).forEach(function (k) {
      var v = hist[k];
      histShort[k] = typeof v === 'string' && v.length >= 10 ? v.slice(5, 10) : v;
    });
    return {
      id: tree.id || '(no-id)',
      ver: String(tree.ver == null ? 1 : tree.ver),
      prodCode: prodCode,
      product: productName,
      status: normalizeStatus(tree.status),
      eff: tree.effDate || null,
      cc: tree.cc || '—',
      grade: tree.grade || '—',
      lint: opts.lint || '트리 PoC',
      lintTip: opts.lintTip || '프로세스 트리(localStorage) — contentHash 바인딩',
      training: opts.training != null ? opts.training : null,
      running: opts.running != null ? opts.running : 0,
      runningTip: opts.runningTip || '',
      hash: shortHash(hashFull),
      hashFull: hashFull,
      lines: opts.lines || ['L-01', 'L-02'],
      history: histShort,
      cond: opts.cond || [
        ['프로세스 트리 저장', 'localStorage ' + LS_KEY, 'done'],
        ['콘텐츠 해시', hashFull.slice(0, 16) + '…', 'done'],
        ['상태 = 효력', normalizeStatus(tree.status) === 'effective' ? '충족' : '미충족 — 발행 불가', normalizeStatus(tree.status) === 'effective' ? 'done' : 'blocked']
      ],
      pendingReason: tree.pendingReason || '',
      source: 'process-tree',
      processTreeId: tree.id,
      contentHash: hashFull
    };
  }

  /* Issued batch persistence */
  function loadIssuedBatches() {
    try {
      var raw = localStorage.getItem(ISSUED_LS_KEY);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }

  function saveIssuedBatch(rec) {
    var list = loadIssuedBatches();
    list.unshift(rec);
    localStorage.setItem(ISSUED_LS_KEY, JSON.stringify(list));
    return list;
  }

  /**
   * Build frozen snapshot refs for an issued batch. Blocks if status ≠ effective.
   * Returns { ok, error, snapshot }.
   */
  function freezeForIssue(tree, extra) {
    extra = extra || {};
    if (!tree) return { ok: false, error: '프로세스 트리가 없습니다.' };
    if (!isIssuable(tree)) {
      return {
        ok: false,
        error: '효력(effective) 상태의 프로세스 트리만 발행할 수 있습니다. 현재: ' + statusLabel(tree.status)
      };
    }
    var hash = tree.contentHash || computeContentHash(tree);
    var snapshot = {
      processTreeId: tree.id,
      ver: tree.ver,
      contentHash: hash,
      status: 'effective',
      issuedAt: extra.issuedAt || new Date().toISOString(),
      batchId: extra.batchId || null,
      product: tree.name || (tree.product && tree.product.productCode) || '',
      kind: 'process-tree'
    };
    return { ok: true, snapshot: snapshot };
  }

  global.TreeDesigner = {
    LS_KEY: LS_KEY,
    ISSUED_LS_KEY: ISSUED_LS_KEY,
    SCHEMA: SCHEMA,
    NODE_TYPES: NODE_TYPES,
    EDGE_TYPES: EDGE_TYPES,
    INPUT_TYPES: INPUT_TYPES,
    SIGN_ROLES: SIGN_ROLES,
    AUTH_STRENGTHS: AUTH_STRENGTHS,
    ESIG_STEPS: ESIG_STEPS,
    sha256Hex: sha256Hex,
    STATUS_LABELS: STATUS_LABELS,
    STATUS_ORDER: STATUS_ORDER,
    STATUS_TRANSITIONS: STATUS_TRANSITIONS,
    seedTree: seedTree,
    seedBioTree: seedBioTree,
    SCENARIOS: SCENARIOS,
    scenarioTree: scenarioTree,
    emptyTree: emptyTree,
    clone: clone,
    findNode: findNode,
    nextNodeId: nextNodeId,
    nextUpId: nextUpId,
    nextOpId: nextOpId,
    buildOutline: buildOutline,
    syncNextFromEdges: syncNextFromEdges,
    ensureEdgeForNext: ensureEdgeForNext,
    exceptionEdgesOf: exceptionEdgesOf,
    saveLocal: saveLocal,
    loadLocal: loadLocal,
    listTrees: listTrees,
    exportJson: exportJson,
    importJson: importJson,
    stableStringify: stableStringify,
    canonicalContent: canonicalContent,
    computeContentHash: computeContentHash,
    applyContentHash: applyContentHash,
    shortHash: shortHash,
    normalizeStatus: normalizeStatus,
    statusLabel: statusLabel,
    canTransition: canTransition,
    nextForwardStatus: nextForwardStatus,
    transitionStatus: transitionStatus,
    isIssuable: isIssuable,
    treeToIssueRow: treeToIssueRow,
    loadIssuedBatches: loadIssuedBatches,
    saveIssuedBatch: saveIssuedBatch,
    freezeForIssue: freezeForIssue
  };
})(typeof window !== 'undefined' ? window : this);
