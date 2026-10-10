/* 브라우저 메모리에서 동작하는 5단계 시뮬레이션. 운영 인증·서버 저장은 별도 구현 대상. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const all = selector => Array.from(document.querySelectorAll(selector));
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clone = value => JSON.parse(JSON.stringify(value));
  const stamp = () => MesUI.nowStamp();
  const fmt = value => MesUI.fmt(value, 2);
  const badge = (text, type = 'info') => '<span class="badge ' + type + '">' + esc(text) + '</span>';
  const today = () => MesUI.nowStamp(null, 'date');
  const titles = ['', '제품 · 요청 등록', 'MBR 초안 생성', '제조공정 설계', '검증 · 검토 · 승인', '배치 기록 생성'];
  const descriptions = ['', '고객 요청 · 제품 정보', '템플릿 · 원본 선택', '공정 · 기록 항목 편집', '독립 검토 · 효력 전환', '버전 고정 · BR 발행'];
  const states = { draft: '초안', review: '검토', approved: '승인', pending: '효력 대기', effective: '효력' };
  /** legacy read normalize once (submitted/reviewed); writes are canonical only */
  function normalizeMbrStatus(st) {
    if (st === 'submitted') return 'review';
    if (st === 'reviewed') return 'approved';
    /* old approved(=효력 대기) cannot be auto-mapped after switch; in-memory PoC has no LS mbr */
    return st || '';
  }
  function mbrStatus() { return state.mbr ? normalizeMbrStatus(state.mbr.status) : ''; }
  const state = { step: 1, registered: false, product: null, mbr: null, method: 'template', template: 0, selectedPhase: 0, selectedField: 0, serial: 0, dryRun: false, snapshot: null, mbrHash: '', dependencies: [], audit: [], batchSeq: 412, batch: null, busy: false };
  const equipment = {
    weigh: ['WB-CLASS-01 · 칭량 부스', 'WB-CLASS-02 · 밀폐 칭량 부스'],
    mix: ['MX-CLASS-01 · 혼합기', 'MX-CLASS-02 · 고속 혼합기'],
    compress: ['TP-CLASS-01 · 타정기', 'TP-CLASS-02 · 고속 타정기'],
    fill: ['CF-CLASS-01 · 캡슐 충전기'], liquidFill: ['LF-CLASS-01 · 액제 충전기'],
    pack: ['PK-CLASS-01 · 포장기'], coat: ['CT-CLASS-01 · 코팅기']
  };
  const library = {
    weigh: { name: '칭량 · 조제', id: 'PH-WEIGH', ver: '1.2', description: '원료 LOT 확인, 저울값 수집과 이중 확인', types: ['tablet', 'capsule', 'liquid'], instruction: '원료 LOT를 스캔하고 적합 상태를 확인합니다. 저울 안정값을 수집한 뒤 확인자와 대조합니다.', fields: [['원료 LOT', '', null, null, '스캔', '스캔', true], ['주성분 칭량량', 'kg', 19.9, 20.1, '장비 연동', '연동', true]] },
    mix: { name: '혼합', id: 'PH-MIX', ver: '2.0', description: '혼합 시간·회전 속도 수집', types: ['tablet', 'capsule', 'liquid'], instruction: '투입 원료를 확인하고 설정 속도로 혼합합니다. 혼합 시간과 회전 속도를 기록합니다.', fields: [['혼합 시간', 'min', 18, 22, '장비 연동', '연동', true], ['회전 속도', 'rpm', 80, 120, '장비 연동', '연동', true]] },
    compress: { name: '타정', id: 'PH-COMPRESS', ver: '1.4', description: '정제 중량·경도 IPC 기록', types: ['tablet'], instruction: '타정 조건을 확인하고 초기 제품의 중량과 경도를 측정합니다. IPC 적합 확인 후 생산합니다.', fields: [['정제 중량', 'mg', 95, 105, '장비 연동', '연동', true], ['정제 경도', 'N', 60, 90, '수기', '사진', true]] },
    fill: { name: '캡슐 충전', id: 'PH-CAPSULE-FILL', ver: '1.1', description: '충전 중량·충전 수량 확인', types: ['capsule'], instruction: '캡슐과 혼합물의 식별을 확인한 후 충전합니다. 초기 충전 중량과 수량을 기록합니다.', fields: [['충전 중량', 'mg', 240, 260, '장비 연동', '연동', true], ['충전 수량', '캡슐', 1, 1000000, '장비 연동', '연동', false]] },
    liquidFill: { name: '액제 충전', id: 'PH-LIQUID-FILL', ver: '1.3', description: '충전량·공정 온도 확인', types: ['liquid'], instruction: '용기 및 충전 설비의 상태를 확인합니다. 충전량과 공정 온도를 기록합니다.', fields: [['충전량', 'mL', 95, 105, '장비 연동', '연동', true], ['공정 온도', '℃', 18, 25, '장비 연동', '연동', true]] },
    pack: { name: '포장', id: 'PH-PACK', ver: '1.0', description: '표시 자재 식별·포장 수량 확인', types: ['tablet', 'capsule', 'liquid'], instruction: '표시 자재의 제품명과 LOT를 대조합니다. 사용량·잔량을 확인하고 포장 수량을 기록합니다.', fields: [['표시 자재 LOT', '', null, null, '스캔', '스캔', true], ['포장 수량', '개', 1, 1000000, '장비 연동', '연동', false]] },
    coat: { name: '코팅', id: 'PH-COAT', ver: '1.1', description: '코팅 온도·분사량 확인', types: ['tablet'], instruction: '코팅액과 설비 상태를 확인하고 코팅합니다. 급기 온도와 분사량을 기록합니다.', fields: [['급기 온도', '℃', 55, 65, '장비 연동', '연동', true], ['분사량', 'g/min', 40, 60, '장비 연동', '연동', true]] }
  };
  const catalog = {
    tablet: { name: '정제', templates: [{ id: 'TPL-TAB-01', name: '정제 표준 · 직접 타정', phases: ['weigh', 'mix', 'compress', 'pack'] }, { id: 'TPL-TAB-02', name: '정제 표준 · 코팅 정제', phases: ['weigh', 'mix', 'compress', 'coat', 'pack'] }], copy: { id: 'MBR-TAB-REF', version: '3.2', name: '유사 정제 제품 · 효력 MBR', phases: ['weigh', 'mix', 'compress', 'pack'] }, bom: [['API-001', '주성분 API', .20], ['LAC-001', '유당', .79], ['MGS-001', '스테아르산Mg', .01]], quantity: 10000, unit: '정', lines: ['L-01 · 정제 1라인', 'L-02 · 정제 2라인'] },
    capsule: { name: '캡슐', templates: [{ id: 'TPL-CAP-01', name: '캡슐 표준 · 경질 캡슐', phases: ['weigh', 'mix', 'fill', 'pack'] }], copy: { id: 'MBR-CAP-REF', version: '1.4', name: '유사 캡슐 제품 · 효력 MBR', phases: ['weigh', 'mix', 'fill', 'pack'] }, bom: [['API-001', '주성분 API', .20], ['MCC-001', '미결정셀룰로오스', .79], ['MGS-001', '스테아르산Mg', .01]], quantity: 4000, unit: '캡슐', lines: ['L-03 · 캡슐 라인'] },
    liquid: { name: '액제', templates: [{ id: 'TPL-LIQ-01', name: '액제 표준 · 혼합 충전', phases: ['weigh', 'mix', 'liquidFill', 'pack'] }], copy: { id: 'MBR-LIQ-REF', version: '2.1', name: '유사 액제 제품 · 효력 MBR', phases: ['weigh', 'mix', 'liquidFill', 'pack'] }, bom: [['API-001', '주성분 API', .20], ['WTR-001', '정제수', .79], ['EXC-001', '보조 원료', .01]], quantity: 1000, unit: '병', lines: ['L-04 · 액제 라인'] }
  };
  const dependencyDefinitions = [
    { kind: '인터록 룰 세트', id: 'ILR', version: '7', definition: { absoluteOverride: false, hardQA: 'QA 승인', controlled: '감독자 승인', warning: '사유 확인' } },
    { kind: '중요도 사전', id: 'CD', version: '12', definition: { categories: ['CPP', 'IPC', '원료 LOT', '수율'] } },
    { kind: 'RBE 규칙', id: 'RBE', version: '5', definition: { exceptions: ['SPEC_OUT', 'MANUAL_FALLBACK', 'CORRECTION', 'WARNING_ACK'] } },
    { kind: '계산식', id: 'FX', version: '4', definition: { scaling: 'batchSize / baseSize', potency: 'execution approved LOT value' } },
    { kind: '파서 규칙', id: 'PR', version: '3', definition: { stableOnly: true, acceptedQuality: 'Good' } },
    { kind: '히스토리안 기준선', id: 'HB', version: '2', definition: { criticalSnapshot: true, compression: false } }
  ];
  function productFromForm() {
    return { customer: $('customer').value.trim(), productCode: $('productCode').value.trim().toUpperCase(), product: $('product').value.trim(), dosage: $('dosage').value, strength: $('strength').value.trim(), baseSize: Number($('baseSize').value), site: $('site').value, dueDate: $('dueDate').value, requestType: $('requestType').value, note: $('requestNote').value.trim(), documents: Array.from($('sourceBody').rows).map(row => row.cells[0].textContent) };
  }
  function product() { return state.product || productFromForm(); }
  function definition() { return catalog[product().dosage]; }
  function selectedPhase() { return state.mbr && state.mbr.phases[state.selectedPhase]; }
  function editable() { return state.mbr && state.mbr.status === 'draft'; }
  function requireDraft() { if (!editable()) { MesUI.toast('검토 제출된 설계는 잠겨 있습니다. 반려 후 새 개정본에서 수정하세요.', 'warn'); return false; } state.dryRun = false; return true; }
  function log(action, who = '김작성') { state.audit.push({ at: stamp(), who, action }); }
  function binds() {
    const p = product();
    all('[data-bind]').forEach(el => { const key = el.dataset.bind; el.textContent = key === 'baseSize' ? fmt(p.baseSize) + ' kg' : p[key] || ''; });
    $('contextMbr').textContent = state.mbr ? state.mbr.id + ' v' + state.mbr.version : '미생성';
    MesUI.setBadge('overallStatus', state.mbr ? (state.mbr.status === 'effective' ? 'ok' : 'info') : state.registered ? 'info' : 'muted', state.batch ? 'BR 발행 완료' : state.mbr ? states[state.mbr.status] : state.registered ? '요청 등록됨' : '등록 전');
    $('contextHint').textContent = state.batch ? state.batch.id + ' 발행 완료' : state.mbr ? '설계 ' + state.mbr.phases.length + '개 공정 · ' + states[state.mbr.status] : state.registered ? 'MBR 초안을 생성하세요' : '제품 요청 정보를 확인하세요';
  }
  function completion(n) { return n === 1 ? state.registered : n === 2 ? !!state.mbr : n === 3 ? !!state.mbr && state.mbr.status !== 'draft' : n === 4 ? !!state.mbr && state.mbr.status === 'effective' : !!state.batch; }
  function navigation() {
    $('stepper').innerHTML = titles.slice(1).map((name, i) => '<button type="button" class="step-button ' + (state.step === i + 1 ? 'active ' : '') + (completion(i + 1) ? 'done' : '') + '" data-go="' + (i + 1) + '"' + (state.step === i + 1 ? ' aria-current="step"' : '') + '><span class="step-number">' + (completion(i + 1) ? '✓' : '0' + (i + 1)) + '</span><span class="step-copy"><b>' + name + '</b><small>' + descriptions[i + 1] + '</small></span></button>').join('');
    $('sideFlow').innerHTML = titles.slice(1).map((name, i) => '<button type="button" class="side-step ' + (state.step === i + 1 ? 'active' : '') + '" data-go="' + (i + 1) + '"><span>' + (completion(i + 1) ? '✓' : '0' + (i + 1)) + '</span>' + name + '</button>').join('');
    all('.stage').forEach(el => el.classList.toggle('hidden', Number(el.dataset.stage) !== state.step));
    $('previousStep').disabled = state.step === 1 || state.busy;
    const button = $('primaryAction');
    button.classList.remove('hidden'); $('nextStep').classList.add('hidden');
    let hint = '', text = '', disabled = state.busy;
    if (state.step === 1) { text = state.registered ? 'MBR 초안 생성으로 →' : '요청 등록 · 다음 →'; hint = state.registered ? '등록한 제품 정보가 MBR 초안에 전달됩니다.' : '고객과 제품 정보를 확인한 후 요청을 등록하세요.'; }
    if (state.step === 2) { text = state.mbr ? '공정 설계로 →' : 'MBR 초안 생성 →'; disabled ||= !state.registered; hint = state.mbr ? '초안 생성 방식은 고정되었습니다. 다음 단계에서 설계를 수정하세요.' : '템플릿의 수치와 조건은 샘플이며 제품 기준에 맞게 수정해야 합니다.'; }
    if (state.step === 3) { text = '설계 저장 · 검증으로 →'; disabled ||= !state.mbr; hint = editable() ? '입력한 설계값을 저장하고 전체 검증 결과를 확인합니다.' : '제출된 MBR을 읽기 전용으로 표시합니다.'; }
    if (state.step === 4) { text = '배치 발행 화면으로 →'; hint = 'QA 승인과 효력 준비 조건이 모두 충족되어야 발행할 수 있습니다.'; }
    if (state.step === 5) { text = state.batch ? '배치 발행 완료' : '배치 기록 생성 · 발행'; disabled ||= !canIssue(); hint = state.batch ? '생성된 배치의 입력값과 버전이 잠겼습니다. 데이터 패키지를 확인하세요.' : issueReason(); }
    button.textContent = text; button.disabled = disabled; $('footerHint').textContent = state.busy ? '콘텐츠 해시를 산출하는 중입니다…' : hint;
  }
  function go(step) {
    if (state.busy) return;
    state.step = step; binds();
    if (step === 1) renderRequest();
    if (step === 2) renderDraft();
    if (step === 3) renderDesigner();
    if (step === 4) renderReview();
    if (step === 5) renderIssue();
    navigation(); window.scrollTo({ top: 0, behavior: 'auto' });
  }
  function renderRequest() {
    $('requestFields').disabled = state.registered; $('sourceFiles').disabled = state.registered;
    const summaryBadge = document.querySelector('.request-summary .badge'); MesUI.setBadge(summaryBadge, state.registered ? 'ok' : 'warn', state.registered ? '등록 완료' : '접수 대기');
  }
  function registerRequest() {
    if (!$('requestForm').reportValidity()) return;
    ['customer', 'product', 'productCode', 'strength'].forEach(id => { $(id).value = $(id).value.trim(); });
    if (!$('requestForm').reportValidity()) return;
    state.product = productFromForm(); state.registered = true; log('제품 요청 등록 · ' + state.product.productCode); MesUI.toast('제품 요청이 등록되었습니다.', 'ok'); go(2);
  }
  function renderDraft() {
    const d = definition(), choices = state.method === 'copy' ? [d.copy] : d.templates;
    state.template = Math.min(state.template, choices.length - 1);
    $('draftPrerequisite').classList.toggle('hidden', state.registered);
    $('draftFields').disabled = !state.registered || !!state.mbr;
    $('templateHeading').textContent = state.method === 'copy' ? '복사할 효력 MBR' : '사용할 표준 템플릿';
    $('templateChoices').classList.toggle('hidden', state.method === 'blank'); $('blankHint').classList.toggle('hidden', state.method !== 'blank');
    $('templateChoices').innerHTML = choices.map((t, i) => '<label class="template-option"><input type="radio" name="template" value="' + i + '" ' + (i === state.template ? 'checked' : '') + '><span><b>' + esc(t.name) + '</b><p>' + esc(t.id) + ' · v' + (t.version || '1.0') + ' · ' + t.phases.length + '개 공정</p>' + badge(state.method === 'copy' ? '효력 원본 · 새 제품은 재검토 필요' : '검증된 샘플 템플릿', state.method === 'copy' ? 'info' : 'ok') + '</span></label>').join('');
    const t = choices[state.template];
    $('draftMbrPreview').textContent = 'MBR-' + product().productCode;
    $('originPreview').textContent = state.method === 'blank' ? '신규 조합 · 원본 없음' : t.id + ' v' + (t.version || '1.0');
    $('initialFlow').innerHTML = state.method === 'blank' ? '<span>Procedure · 빈 공정 구조</span>' : t.phases.map((kind, i) => (i ? '<i>→</i>' : '') + '<span>' + esc(library[kind].name) + '</span>').join('');
  }
  function createPhase(kind) {
    const lib = library[kind], factor = product().baseSize / 100;
    return { key: 'OP-' + (++state.serial), kind, reference: { id: lib.id, version: lib.ver }, name: lib.name, equipment: equipment[kind][0], instruction: lib.instruction,
      fields: lib.fields.map((f, i) => ({ key: 'F-' + state.serial + '-' + i, name: f[0], type: f[2] == null ? 'text' : 'number', unit: f[1], precision: 2, rounding: '표시 시 반올림', min: f[2] == null ? null : kind === 'weigh' ? Number((f[2] * factor).toFixed(4)) : f[2], max: f[3] == null ? null : kind === 'weigh' ? Number((f[3] * factor).toFixed(4)) : f[3], source: f[4], evidence: f[5], critical: f[6], criticalFloor: f[6], permit: '비대상', quality: 'Good만 수용', interlock: f[6] ? 'Hard-QA' : 'Warning', signature: f[6] ? '수행 · 확인' : '수행', verification: f[6] ? '동석' : '시스템', time: '시스템 시각 · 스냅샷', fallback: '장애 사유 기록 후 대체' })) };
  }
  function createDraft() {
    if (!state.registered || state.mbr) return;
    const d = definition(), t = state.method === 'copy' ? d.copy : d.templates[state.template];
    state.mbr = { id: 'MBR-' + product().productCode, version: '1.0', status: 'draft', origin: state.method === 'blank' ? null : { id: t.id, version: t.version || '1.0' }, author: '김작성', product: clone(product()), phases: (state.method === 'blank' ? [] : t.phases).map(createPhase), bom: d.bom.map(b => ({ code: b[0], name: b[1], amount: Number((b[2] * product().baseSize).toFixed(4)) })), quantityPerKg: d.quantity, quantityUnit: d.unit };
    $('batchSize').value = product().baseSize; $('batchLine').innerHTML = d.lines.map(line => '<option>' + esc(line) + '</option>').join('');
    log('MBR v1.0 초안 생성 · ' + (state.method === 'blank' ? '신규 설계' : t.id + ' 참조')); MesUI.toast('MBR 초안이 생성되었습니다.', 'ok'); go(3);
  }
  function renderDesigner() {
    $('designerEmpty').classList.toggle('hidden', !!state.mbr); $('designerContent').classList.toggle('hidden', !state.mbr); $('previewWork').disabled = !selectedPhase();
    MesUI.setBadge('designerStatus', editable() ? 'info' : 'muted', state.mbr ? states[state.mbr.status] + (editable() ? ' · 편집 가능' : ' · 읽기 전용') : '초안 미생성');
    if (!state.mbr) return;
    $('phaseCount').textContent = state.mbr.phases.length + '개 공정';
    $('phaseTree').innerHTML = state.mbr.phases.map((p, i) => '<button class="phase-node ' + (i === state.selectedPhase ? 'selected' : '') + '" type="button" data-phase="' + i + '"><span>' + String(i + 1).padStart(2, '0') + '</span><div><b>' + esc(p.name) + '</b><small>UP / ' + p.key + ' · ' + esc(p.reference.id) + ' v' + p.reference.version + '</small></div></button>').join('') || '<div class="empty-state"><h4>공정을 추가하세요</h4><p>아래 라이브러리의 + 버튼</p></div>';
    $('phaseLibrary').innerHTML = Object.keys(library).filter(kind => library[kind].types.includes(product().dosage)).map(kind => '<div class="library-item"><div><b>' + esc(library[kind].name) + '</b><small>' + library[kind].id + ' v' + library[kind].ver + '</small></div><button class="btn inner" type="button" data-add="' + kind + '" aria-label="' + esc(library[kind].name) + ' 공정 추가" ' + (editable() ? '' : 'disabled') + '>+</button></div>').join('');
    $('moveUp').disabled = !editable() || state.selectedPhase === 0; $('moveDown').disabled = !editable() || state.selectedPhase >= state.mbr.phases.length - 1; $('removePhase').disabled = !editable() || !selectedPhase();
    $('phaseFields').disabled = !editable() || !selectedPhase(); $('propertyFields').disabled = !editable() || !selectedPhase();
    renderPhase(); renderBom(); renderLint();
  }
  function renderPhase() {
    const p = selectedPhase();
    $('phaseTitle').textContent = p ? p.name + ' · 공정 설정' : '공정 미선택'; $('phaseVersion').textContent = p ? p.reference.id + ' v' + p.reference.version : '라이브러리에서 추가';
    $('phaseName').value = p ? p.name : ''; $('instruction').value = p ? p.instruction : '';
    $('equipment').innerHTML = p ? equipment[p.kind].map(e => '<option' + (e === p.equipment ? ' selected' : '') + '>' + esc(e) + '</option>').join('') : '';
    if (!p) { $('fieldBody').innerHTML = ''; $('properties').innerHTML = '<p class="panel-note">공정을 추가하면 기록 항목 속성이 표시됩니다.</p>'; return; }
    state.selectedField = Math.min(state.selectedField, p.fields.length - 1);
    renderFieldRows(); renderProperties();
  }
  function renderFieldRows() {
    const p = selectedPhase(); if (!p) return;
    $('fieldBody').innerHTML = p.fields.map((f, i) => '<tr tabindex="0" data-field="' + i + '" class="' + (state.selectedField === i ? 'selected' : '') + '" aria-label="' + esc(f.name) + ' 속성 편집"><td>' + esc(f.name) + '</td><td>' + esc(f.unit || '—') + '</td><td>' + (f.type === 'number' ? esc(f.min) + ' ~ ' + esc(f.max) : '식별 확인') + '</td><td>' + esc(f.source) + '</td><td>' + badge(f.critical ? 'critical' : '일반', f.critical ? 'warn' : 'muted') + '</td></tr>').join('');
  }
  function selectOptions(values, chosen) { return values.map(v => '<option' + (v === chosen ? ' selected' : '') + '>' + esc(v) + '</option>').join(''); }
  function propertySelect(label, key, values, f, disabled = false) { return '<label>' + label + '<select class="input" data-prop="' + key + '"' + (disabled ? ' disabled' : '') + '>' + selectOptions(values, f[key]) + '</select></label>'; }
  function renderProperties() {
    const f = selectedPhase().fields[state.selectedField];
    $('properties').innerHTML = '<div class="property-group">정의 · 규격</div><label>항목명<input class="input" data-prop="name" maxlength="60" value="' + esc(f.name) + '"></label><label>① 데이터 타입<input class="input" value="' + (f.type === 'number' ? '수치형' : '문자형 · 식별값') + '" readonly></label><label>단위<input class="input" data-prop="unit" maxlength="20" value="' + esc(f.unit) + '"' + (f.type === 'text' ? ' disabled' : '') + '></label>' + propertySelect('표시 유효 소수 자리', 'precision', ['0', '1', '2', '3', '4'], { precision: String(f.precision) }) + '<div class="property-range"><label>② 규격 하한<input class="input" type="number" step="any" data-prop="min" value="' + (f.min == null ? '' : f.min) + '"' + (f.type === 'text' ? ' disabled' : '') + '></label><label>규격 상한<input class="input" type="number" step="any" data-prop="max" value="' + (f.max == null ? '' : f.max) + '"' + (f.type === 'text' ? ' disabled' : '') + '></label></div>' + propertySelect('③ 허가 기재 사항 · RA 지정', 'permit', ['비대상', 'RA 검토 필요'], f) + propertySelect('④ 중요도' + (f.criticalFloor ? ' · 기본 중요 항목 고정' : ''), 'critical', ['일반', 'critical'], { critical: f.critical ? 'critical' : '일반' }, f.criticalFloor) + '<div class="property-group">증거 · 수집 정책</div>' + propertySelect('⑤ 증거 유형', 'evidence', ['연동', '스캔', '사진', '없음'], f) + propertySelect('⑥ 품질 코드 수용', 'quality', ['Good만 수용', '비중요 항목 플래그 수용'], f) + propertySelect('⑩ 데이터 원천', 'source', ['장비 연동', '스캔', '수기', '계산'], f) + propertySelect('연동 장애 대체 경로', 'fallback', ['장애 사유 기록 후 대체', '대체 불가 · QA 호출'], f) + '<div class="property-group">통제 · 서명</div>' + propertySelect('⑦ 인터록 등급', 'interlock', ['Absolute', 'Hard-QA', 'Controlled', 'Warning'], f) + propertySelect('⑧ 서명 요건', 'signature', ['수행 · 확인', '수행'], f) + propertySelect('⑨ 확인 방식', 'verification', ['동석', '원격', '시스템', '증거 기반 사후 대조'], f) + propertySelect('⑪ 시각 · 히스토리안', 'time', ['시스템 시각 · 스냅샷', '시스템 시각'], f) + '<p class="panel-note">라이브러리 기본값을 상속합니다. 반올림은 표시 시 적용하며 판정에는 원본 값을 사용합니다.</p>';
  }
  function renderBom() {
    $('bomBody').innerHTML = state.mbr.bom.map((b, i) => '<tr><td>' + esc(b.code) + '</td><td>' + esc(b.name) + '</td><td><input class="input num" type="number" min="0.0001" step="any" value="' + b.amount + '" data-bom="' + i + '" aria-label="' + esc(b.name) + ' 기준량" ' + (editable() ? '' : 'disabled') + '></td><td>' + (i === 0 ? '역가 보정 · FX v4' : '기준량 스케일링') + '</td></tr>').join(''); updateBomSum();
  }
  function updateBomSum() { const sum = state.mbr.bom.reduce((total, b) => total + b.amount, 0); $('bomSum').textContent = fmt(sum) + ' kg'; MesUI.setBadge('bomCheck', Number.isFinite(sum) && Math.abs(sum - product().baseSize) < 0.00001 ? 'ok' : 'error', Math.abs(sum - product().baseSize) < 0.00001 ? '기준 배치량 일치' : '기준 배치량 불일치'); }
  function lint() {
    const issues = [], m = state.mbr;
    const add = (message, phase = null, level = 'error') => issues.push({ message, phase, level });
    if (!m) { add('MBR 초안을 먼저 생성하세요.'); return issues; }
    if (!m.phases.length) add('제조공정이 없습니다. 라이브러리 블록을 추가하세요.');
    if (!m.bom.every(b => Number.isFinite(b.amount) && b.amount > 0) || Math.abs(m.bom.reduce((s, b) => s + b.amount, 0) - product().baseSize) >= 0.00001) add('원료 기준량은 양수여야 하며 합계가 기준 배치량과 일치해야 합니다.');
    m.phases.forEach((p, i) => {
      if (!p.name.trim() || !p.instruction.trim()) add('공정명과 작업 지시를 입력하세요.', i);
      p.fields.forEach(f => {
        if (!f.name.trim()) add('기록 항목명이 비어 있습니다.', i);
        if (f.type === 'number' && (!Number.isFinite(f.min) || !Number.isFinite(f.max) || f.min > f.max || !f.unit.trim())) add(f.name + ': 유효한 규격 하한·상한과 단위를 입력하세요.', i);
        if (f.critical && f.evidence === '없음') add(f.name + ': 중요 항목의 증거 유형을 지정하세요.', i);
        if (f.critical && f.quality !== 'Good만 수용') add(f.name + ': 중요 항목은 Good 품질 코드만 수용해야 합니다.', i);
        if (['원격', '증거 기반 사후 대조'].includes(f.verification) && !['연동', '사진'].includes(f.evidence)) add(f.name + ': 원격·사후 대조에는 연동 또는 사진 증거가 필요합니다.', i);
        if (f.critical && f.signature !== '수행 · 확인') add(f.name + ': 중요 항목은 수행자와 확인자를 식별해야 합니다.', i);
        if (f.critical && f.time !== '시스템 시각 · 스냅샷') add(f.name + ': 중요 항목의 스냅샷 반입을 설정하세요.', i);
        if (f.permit === 'RA 검토 필요') add(f.name + ': RA 검토 근거를 연결해야 합니다. 이 PoC는 RA 승인 경로 연결을 지원하지 않습니다.', i);
      });
    });
    return issues;
  }
  function renderLint() {
    const issues = lint(); $('lintCount').innerHTML = badge('오류 ' + issues.length, issues.length ? 'error' : 'ok');
    $('lintMessages').innerHTML = issues.length ? issues.map(issue => '<div class="lint-row">' + badge('오류', 'error') + '<span>' + esc(issue.message) + '</span>' + (issue.phase != null ? '<button type="button" data-lint-phase="' + issue.phase + '">' + esc(state.mbr.phases[issue.phase].name) + ' →</button>' : '') + '</div>').join('') : '<div class="lint-row">' + badge('통과', 'ok') + '<span>공정 구조 · 원료량 · 규격 · 중요 항목 증거 · 서명 요건에 오류가 없습니다.</span><span class="lint-location">샘플 점검 규칙 v1</span></div>';
  }
  function reviewChecks() {
    const issues = lint();
    const checks = [{ name: '제조공정 구조 · 필수 작업 지시', ok: !!state.mbr && !!state.mbr.phases.length && state.mbr.phases.every(p => p.name.trim() && p.instruction.trim()), detail: state.mbr ? state.mbr.phases.length + '개 공정' : '미생성' }, { name: '원료 기준량 · 합계 대조', ok: !!state.mbr && state.mbr.bom.every(b => b.amount > 0 && Number.isFinite(b.amount)) && Math.abs(state.mbr.bom.reduce((s, b) => s + b.amount, 0) - product().baseSize) < .00001, detail: '기준 ' + fmt(product().baseSize) + ' kg' }, { name: '규격 · 증거 · 서명 통합 점검', ok: !issues.length, detail: issues.length ? '오류 ' + issues.length + '건' : '샘플 규칙 통과' }, { name: '시험 실행 · 화면 입력 판정', ok: state.dryRun, detail: state.dryRun ? '시험 완료' : '미수행' }, { name: '변경관리 번호 연결', ok: /^CC-[A-Za-z0-9-]+$/.test($('ccNumber').value.trim()), detail: $('ccNumber').value.trim() || '미입력' }];
    return checks;
  }
  function readyForSubmit() { return editable() && reviewChecks().every(c => c.ok); }
  function renderReview() {
    const m = state.mbr, status = m ? normalizeMbrStatus(m.status) : '';
    const route = ['draft', 'review', 'approved', 'pending', 'effective'], pos = route.indexOf(status);
    $('reviewStrip').innerHTML = route.map((s, i) => '<span class="' + (pos > i ? 'done' : pos === i ? 'current' : '') + '">' + (pos > i ? '✓ ' : '') + states[s] + '</span>' + (i < route.length - 1 ? '<span>→</span>' : '')).join('');
    const checks = reviewChecks(); $('reviewChecks').innerHTML = checks.map(c => '<div class="check-row">' + badge(c.ok ? '통과' : '대기', c.ok ? 'ok' : 'warn') + '<b>' + c.name + '</b><span>' + esc(c.detail) + '</span></div>').join('');
    $('reviewLintCount').innerHTML = badge('오류 ' + lint().length, lint().length ? 'error' : 'ok');
    $('dryRun').disabled = !editable() || !!lint().length || state.busy;
    $('dryRunResult').textContent = state.dryRun ? '시험 실행 완료 · ' + (m ? m.phases.length : 0) + '개 공정의 규격 내부·외부 입력을 점검했습니다. 실제 설비 연동과 생산 밸리데이션은 별도입니다.' : '시험 실행에서 작업 화면 구성과 값의 규격 판정을 확인하세요.';
    $('dryRunResult').className = 'notice ' + (state.dryRun ? 'ok' : 'info');
    const people = [{ role: '작성 · 검토 제출', name: '김작성', key: 'submittedAt' }, { role: '독립 검토', name: '이검토', key: 'reviewedAt' }, { role: 'QA 승인', name: '박승인', key: 'approvedAt' }];
    $('approvalRoute').innerHTML = people.map(p => '<div class="approval-person ' + (m && m[p.key] ? 'done' : '') + '"><span class="role">' + p.role + '</span><b>' + p.name + '</b><small>' + esc(m && m[p.key] || '처리 대기') + '</small>' + badge(m && m[p.key] ? '완료' : '대기', m && m[p.key] ? 'ok' : 'muted') + '</div>').join('');
    MesUI.setBadge('reviewStatus', status === 'effective' ? 'ok' : 'info', states[status] || '미생성');
    $('reviewSummary').innerHTML = '<dt>MBR</dt><dd>' + (m ? esc(m.id) + ' v' + m.version : '미생성') + '</dd><dt>제품</dt><dd>' + esc(product().product) + '</dd><dt>공정 / 항목</dt><dd>' + (m ? m.phases.length + '개 / ' + fieldCount() + '건' : '—') + '</dd><dt>설계 해시</dt><dd class="hash-value">' + (state.mbrHash || '검토 제출 시 SHA-256 산출') + '</dd>';
    $('ccNumber').disabled = !editable();
    const user = $('actingUser').value, action = $('reviewAction');
    action.textContent = status === 'review' ? '독립 검토 완료' : status === 'approved' ? 'QA 승인' : status === 'pending' || status === 'effective' ? '승인 완료' : '검토 제출';
    action.disabled = state.busy || !m || (status === 'draft' ? user !== 'author' || !readyForSubmit() : status === 'review' ? user !== 'reviewer' : status === 'approved' ? user !== 'qa' : true);
    $('rejectAction').disabled = state.busy || !m || !['review', 'approved'].includes(status) || (status === 'review' ? user !== 'reviewer' : user !== 'qa');
    const gateIDs = ['gateTraining', 'gateEquipment', 'gateDocuments', 'gateValidation', 'effectiveDate'];
    gateIDs.forEach(id => { $(id).disabled = status !== 'pending' || user !== 'qa' || state.busy; });
    const reason = activationReason(); $('activateMbr').disabled = !!reason || state.busy; $('activationReason').textContent = reason || 'QA 승인자로 효력 전환할 수 있습니다.';
    $('auditList').innerHTML = state.audit.length ? state.audit.slice().reverse().map(e => '<div class="audit-row"><time>' + esc(e.at) + '</time><span>' + esc(e.who) + ' · ' + esc(e.action) + '</span></div>').join('') : '<p class="panel-note">요청 등록 후 처리 이력이 표시됩니다.</p>';
  }
  function activationReason() {
    if (!state.mbr) return 'MBR 초안을 생성하세요.';
    if (state.mbr.status === 'effective') return '효력 전환 완료 · 배치 발행 가능';
    if (normalizeMbrStatus(state.mbr.status) !== 'pending') return '독립 검토와 QA 승인을 먼저 완료하세요.';
    if ($('actingUser').value !== 'qa') return 'QA 승인자로 처리자를 전환하세요.';
    if (['gateTraining', 'gateEquipment', 'gateDocuments', 'gateValidation'].some(id => !$(id).checked)) return '효력 준비 조건 4개를 모두 확인하세요.';
    if (!$('effectiveDate').value || $('effectiveDate').value > today()) return '효력일이 도래하지 않았습니다. 도래한 날짜를 지정하세요.';
    return '';
  }
  async function digest(value) {
    if (!window.crypto || !window.crypto.subtle) throw new Error('이 브라우저에서 SHA-256을 사용할 수 없습니다. localhost 주소로 화면을 여세요.');
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
    return Array.from(new Uint8Array(bytes)).map(v => v.toString(16).padStart(2, '0')).join('');
  }
  async function reviewAction() {
    if (state.busy || !state.mbr || $('reviewAction').disabled) return;
    const m = state.mbr, user = $('actingUser').value;
    if (m.status === 'draft' && user === 'author' && readyForSubmit()) {
      state.busy = true; navigation(); renderReview();
      try {
        const snapshot = clone({ id: m.id, version: m.version, author: m.author, product: m.product, origin: m.origin, phases: m.phases, bom: m.bom, quantityPerKg: m.quantityPerKg, quantityUnit: m.quantityUnit, cc: $('ccNumber').value.trim() });
        const hash = await digest(snapshot);
        const deps = await Promise.all(dependencyDefinitions.map(async d => ({ ...clone(d), hash: await digest(d) })));
        state.snapshot = snapshot; state.mbrHash = hash; state.dependencies = deps;
        m.status = 'review'; m.cc = snapshot.cc; m.submittedAt = stamp(); log('MBR v' + m.version + ' 검토 제출 · 내용과 버전 고정'); $('actingUser').value = 'reviewer';
        MesUI.toast('검토 제출 완료 · 독립 검토자 역할로 전환했습니다.', 'ok');
      } catch (error) { MesUI.alert(error.message, 'Error'); }
      finally { state.busy = false; }
    } else if (normalizeMbrStatus(m.status) === 'review' && user === 'reviewer') { m.status = 'approved'; m.reviewedAt = stamp(); log('독립 검토 완료', '이검토'); $('actingUser').value = 'qa'; MesUI.toast('독립 검토 완료 · QA 승인자 역할로 전환했습니다.', 'ok'); }
    else if (normalizeMbrStatus(m.status) === 'approved' && user === 'qa') { m.status = 'pending'; m.approvedAt = stamp(); log('QA 승인 완료 · 효력 준비 대기', '박승인'); MesUI.toast('QA 승인 완료 · 효력 조건을 확인하세요.', 'ok'); }
    binds(); renderReview(); navigation();
  }
  function fieldCount() { return state.mbr ? state.mbr.phases.reduce((count, p) => count + p.fields.length, 0) : 0; }
  function issueReason() {
    if (!state.mbr || state.mbr.status !== 'effective') return '효력 MBR이 없습니다. 4단계에서 QA 승인과 효력 전환을 완료하세요.';
    if (state.batch) return '발행 완료 · 같은 MBR로 다음 배치를 만들 수 있습니다.';
    if (!Number.isFinite(Number($('batchSize').value)) || !$('batchSize').value || Number($('batchSize').value) < product().baseSize * .5 || Number($('batchSize').value) > product().baseSize * 2) return '배치 사이즈는 ' + fmt(product().baseSize * .5) + '~' + fmt(product().baseSize * 2) + ' kg 범위로 입력하세요.';
    if (!$('batchStart').value || !$('batchStart').validity.valid) return '계획 시작 시각을 입력하세요.';
    const ef = Number($('emergencyCount').value);
    if (!$('emergencyCount').value || !Number.isInteger(ef) || ef < 0 || ef > 20) return '비상 기록지 매수는 0~20 사이의 정수여야 합니다.';
    if (!$('batchLine').value) return '생산 라인을 선택하세요.';
    return '';
  }
  function canIssue() { return !state.busy && !issueReason(); }
  function manifestRows() { return state.mbr && state.mbrHash ? [{ kind: 'MBR', id: state.mbr.id, version: state.mbr.version, hash: state.mbrHash }].concat(state.dependencies) : []; }
  function efText(seq, count) { return count === 0 ? '발행 안 함 · 0매' : 'EF-' + String(seq).padStart(4, '0') + '-01' + (count > 1 ? '~' + String(count).padStart(2, '0') : '') + ' · ' + count + '매'; }
  function renderIssue() {
    const m = state.mbr;
    const locked = !m || m.status !== 'effective'; $('issueGate').classList.toggle('hidden', !locked); $('issueGate').textContent = locked ? issueReason() : '';
    $('issueFields').disabled = locked || !!state.batch;
    MesUI.setBadge('issueMbrStatus', !locked ? 'ok' : 'muted', m ? states[m.status] : '미생성');
    $('issueMbrSummary').innerHTML = '<dt>MBR</dt><dd>' + (m ? esc(m.id) + ' v' + m.version : '미생성') + '</dd><dt>제품</dt><dd>' + esc(product().product) + '</dd><dt>효력일</dt><dd>' + (m && m.effectiveAt ? esc(m.effectiveAt) : '효력 전환 전') + '</dd><dt>변경관리</dt><dd>' + (m && m.cc ? esc(m.cc) : '미연결') + '</dd>';
    $('batchId').value = state.batch ? state.batch.id : 'BR-' + today().slice(0, 4) + '-' + String(state.batchSeq).padStart(4, '0');
    $('batchSize').min = product().baseSize * .5; $('batchSize').max = product().baseSize * 2;
    $('batchRange').textContent = '샘플 발행 범위 ' + fmt(product().baseSize * .5) + '~' + fmt(product().baseSize * 2) + ' kg';
    $('manifestId').textContent = state.batch ? state.batch.manifest.id : '발행 시 채번'; MesUI.setBadge('manifestLock', state.batch ? 'ok' : 'info', state.batch ? '고정 완료' : '고정 예정');
    $('manifestBody').innerHTML = manifestRows().map(d => '<tr><td>' + esc(d.kind) + '</td><td>' + esc(d.id) + ' · v' + d.version + '</td><td title="' + d.hash + '">' + d.hash.slice(0, 12) + '…</td></tr>').join('') || '<tr><td colspan="3">검토 제출 시 버전별 콘텐츠 해시를 산출합니다.</td></tr>';
    $('batchSections').innerHTML = m ? m.phases.map((p, i) => '<div class="batch-section"><span>' + String(i + 1).padStart(2, '0') + '</span><b>' + esc(p.name) + '</b><small>' + p.fields.length + '개 항목 · 실행 대기</small></div>').join('') : '<p class="panel-note">설계한 공정 구조가 배치에 복제됩니다.</p>';
    $('recordCount').textContent = fieldCount() + '건'; $('downloadPackage').disabled = !state.batch; $('newBatch').classList.toggle('hidden', !state.batch);
    $('issueSuccess').classList.toggle('hidden', !state.batch);
    if (state.batch) $('issueSuccess').innerHTML = '<span class="success-icon">✓</span><div><h3>배치 기록이 생성되었습니다 · ' + esc(state.batch.id) + '</h3><p>' + esc(m.id) + ' v' + m.version + ' · ' + fmt(state.batch.size) + ' kg · ' + state.batch.manifest.id + ' · ' + esc(state.batch.issuedAt) + '</p></div>';
    updateScaling();
  }
  function updateScaling() {
    const size = Number($('batchSize').value), ratio = size / product().baseSize, valid = Number.isFinite(size) && size > 0;
    $('scalingRatio').textContent = valid ? '기준 대비 ×' + fmt(ratio) : '사이즈 미입력';
    $('theoryQuantity').textContent = state.mbr && valid ? MesUI.fmt(Math.round(size * state.mbr.quantityPerKg)) + ' ' + state.mbr.quantityUnit : '—';
    $('scaleBody').innerHTML = state.mbr ? state.mbr.bom.map(b => '<tr><td>' + esc(b.name) + '</td><td class="num">' + fmt(b.amount) + '</td><td class="num">' + (valid ? fmt(b.amount * ratio) : '—') + '</td></tr>').join('') : '';
    $('emergencyPreview').textContent = efText(state.batch ? state.batch.seq : state.batchSeq, Number($('emergencyCount').value));
  }
  function issueBatch() {
    if (!canIssue() || !$('issueForm').reportValidity()) return;
    MesUI.confirm($('batchId').value + ' · ' + fmt(Number($('batchSize').value)) + ' kg를 발행합니다.\n' + state.mbr.id + ' v' + state.mbr.version + '와 실행 컨텍스트를 이 배치에 고정합니다.', () => {
      if (!canIssue()) return;
      const seq = state.batchSeq;
      state.batch = { id: $('batchId').value, seq, status: '발행', size: Number($('batchSize').value), line: $('batchLine').value, plannedStart: $('batchStart').value, issuedAt: stamp(), product: clone(product()), masterRecipe: clone(state.snapshot), approval: { submittedAt: state.mbr.submittedAt, reviewedAt: state.mbr.reviewedAt, approvedAt: state.mbr.approvedAt, effectiveAt: state.mbr.effectiveAt }, manifest: { id: 'MF-' + String(seq).padStart(4, '0'), objects: clone(manifestRows()) }, theoreticalQuantity: Math.round(Number($('batchSize').value) * state.mbr.quantityPerKg), scaling: state.mbr.bom.map(b => ({ ...clone(b), theoreticalAmount: b.amount * Number($('batchSize').value) / product().baseSize })), emergencyForms: { count: Number($('emergencyCount').value), controlNumbers: efText(seq, Number($('emergencyCount').value)) }, sections: state.mbr.phases.map(p => ({ phaseKey: p.key, name: p.name, status: '실행 대기', records: p.fields.map(f => ({ fieldKey: f.key, name: f.name, value: null, status: '미입력' })) })), demo: true };
      Object.assign(state.batch.approval, { submittedBy: '김작성', reviewedBy: '이검토', approvedBy: '박승인', activatedBy: '박승인', simulation: true });
      log(state.batch.id + ' 발행 · ' + state.batch.manifest.id + ' 고정', '생산계획'); binds(); renderIssue(); navigation(); MesUI.toast(state.batch.id + ' 발행 완료', 'ok');
    }, { title: 'BR 발행 확인', okText: '발행', cancelText: '취소' });
  }
  function preview() {
    const p = selectedPhase(); if (!p) return;
    $('previewTitle').textContent = p.name + ' · 작업 화면 미리보기';
    $('previewContent').innerHTML = '<div class="preview-context">' + esc(product().product) + ' · ' + esc(state.mbr.id) + ' v' + state.mbr.version + ' · ' + esc(p.equipment) + '</div><div class="preview-instruction">' + esc(p.instruction) + '</div><div class="preview-measurements">' + p.fields.map((f, i) => '<label>' + esc(f.name) + (f.critical ? ' ' + badge('critical', 'warn') : '') + '<div class="input-unit"><input class="input preview-input" data-preview="' + i + '" type="' + (f.type === 'number' ? 'number' : 'text') + '" step="any" value="' + (f.type === 'number' ? Number(((f.min + f.max) / 2).toFixed(f.precision)) : 'LOT-DEMO-001') + '" aria-label="' + esc(f.name) + ' 시험값"><span>' + esc(f.unit || 'ID') + '</span></div><small>' + (f.type === 'number' ? '허용범위 ' + esc(f.min) + '~' + esc(f.max) + ' ' + esc(f.unit) : '스캔 식별값 확인') + ' · ' + esc(f.source) + '</small></label>').join('') + '</div><div class="preview-signatures">공정 서명: ' + esc(Array.from(new Set(p.fields.map(f => f.signature))).join(' / ')) + ' · 라이브러리 ' + esc(p.reference.id) + ' v' + p.reference.version + '</div>';
    $('previewValidation').innerHTML = ''; MesUI.openDialog('workPreview');
  }
  function validatePreview() {
    const p = selectedPhase(); if (!p) return;
    $('previewValidation').innerHTML = all('[data-preview]').map(input => { const f = p.fields[Number(input.dataset.preview)], v = f.type === 'number' ? Number(input.value) : input.value.trim(), ok = f.type === 'number' ? input.value !== '' && Number.isFinite(v) && v >= f.min && v <= f.max : !!v; return '<div class="lint-row">' + badge(ok ? '적합' : '이탈', ok ? 'ok' : 'error') + '<span>' + esc(f.name) + (ok ? ' · 범위 또는 식별값 확인' : ' · ' + esc(f.interlock) + ' 경로 안내') + '</span></div>'; }).join('');
  }
  document.addEventListener('click', event => {
    const target = event.target.closest('[data-go], [data-phase], [data-field], [data-add], [data-lint-phase]'); if (!target) return;
    if (target.dataset.go) { go(Number(target.dataset.go)); return; }
    if (target.dataset.phase != null) { state.selectedPhase = Number(target.dataset.phase); state.selectedField = 0; renderDesigner(); return; }
    if (target.dataset.field != null) { state.selectedField = Number(target.dataset.field); renderFieldRows(); renderProperties(); return; }
    if (target.dataset.add && requireDraft()) { state.mbr.phases.push(createPhase(target.dataset.add)); state.selectedPhase = state.mbr.phases.length - 1; state.selectedField = 0; renderDesigner(); }
    if (target.dataset.lintPhase != null) { state.selectedPhase = Number(target.dataset.lintPhase); state.selectedField = 0; renderDesigner(); }
  });
  $('fieldBody').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.target.closest('[data-field]').click(); } });
  $('requestForm').addEventListener('input', () => { if (!state.registered) binds(); });
  $('requestForm').addEventListener('submit', e => { e.preventDefault(); if (!state.registered) registerRequest(); });
  $('issueForm').addEventListener('submit', e => { e.preventDefault(); issueBatch(); });
  $('sourceFiles').addEventListener('change', e => { if (state.registered) return; Array.from(e.target.files).forEach(f => { const row = document.createElement('tr'); row.innerHTML = '<td>' + esc(f.name) + '</td><td>요청 첨부</td><td>' + badge('파일명 연결', 'info') + '</td>'; $('sourceBody').appendChild(row); }); e.target.value = ''; });
  $('draftFields').addEventListener('change', event => { if (!state.registered || state.mbr) return; if (event.target.name === 'method') { state.method = event.target.value; state.template = 0; } if (event.target.name === 'template') state.template = Number(event.target.value); renderDraft(); });
  $('phaseFields').addEventListener('input', event => { if (!requireDraft() || !selectedPhase()) return; const p = selectedPhase(); if (event.target.id === 'phaseName') p.name = event.target.value; if (event.target.id === 'instruction') p.instruction = event.target.value; if (event.target.id === 'equipment') p.equipment = event.target.value; renderLint(); });
  $('phaseName').addEventListener('change', () => { if (editable()) renderDesigner(); });
  $('properties').addEventListener('change', event => {
    const key = event.target.dataset.prop; if (!key || !requireDraft()) return;
    const f = selectedPhase().fields[state.selectedField], input = event.target;
    if (key === 'critical' && f.criticalFloor) return;
    f[key] = ['min', 'max', 'precision'].includes(key) ? input.value === '' ? null : Number(input.value) : key === 'critical' ? input.value === 'critical' : input.value;
    renderFieldRows(); renderLint();
  });
  $('bomBody').addEventListener('input', event => { if (event.target.dataset.bom == null || !requireDraft()) return; state.mbr.bom[Number(event.target.dataset.bom)].amount = event.target.value === '' ? NaN : Number(event.target.value); updateBomSum(); renderLint(); });
  function movePhase(offset) { if (!requireDraft()) return; const index = state.selectedPhase, next = index + offset; if (next < 0 || next >= state.mbr.phases.length) return; [state.mbr.phases[index], state.mbr.phases[next]] = [state.mbr.phases[next], state.mbr.phases[index]]; state.selectedPhase = next; renderDesigner(); }
  $('moveUp').onclick = () => movePhase(-1); $('moveDown').onclick = () => movePhase(1);
  $('removePhase').onclick = () => { if (!editable() || !selectedPhase()) return; MesUI.confirm(selectedPhase().name + ' 공정을 초안에서 삭제할까요?', () => { if (!requireDraft()) return; state.mbr.phases.splice(state.selectedPhase, 1); state.selectedPhase = Math.max(0, state.selectedPhase - 1); state.selectedField = 0; renderDesigner(); }, { okText: '삭제', cancelText: '취소' }); };
  $('runLint').onclick = () => { renderLint(); MesUI.toast('설계 점검 완료 · 오류 ' + lint().length + '건', lint().length ? 'warn' : 'ok'); };
  $('previewWork').onclick = preview; $('validatePreview').onclick = validatePreview;
  $('dryRun').onclick = () => { if (!editable() || lint().length) return; state.dryRun = state.mbr.phases.every(p => p.fields.every(f => f.type !== 'number' || (f.min <= (f.min + f.max) / 2 && (f.min + f.max) / 2 <= f.max && !(f.min <= f.min - 1 && f.min - 1 <= f.max)))); log('시험 실행 · 화면 항목 및 규격 내부·외부 값 판정 확인'); renderReview(); MesUI.toast('샘플 시험 실행 완료', 'ok'); };
  $('actingUser').onchange = renderReview; $('ccNumber').oninput = () => { if (editable()) renderReview(); };
  $('reviewAction').onclick = reviewAction;
  $('rejectAction').onclick = () => { if ($('rejectAction').disabled) return; MesUI.confirm('제출된 버전을 보존하고 수정용 새 개정본을 만듭니다.', () => { const m = state.mbr; if (!['review', 'approved'].includes(normalizeMbrStatus(m.status))) return; const oldVersion = m.version; m.previousSubmissions = (m.previousSubmissions || []).concat([{ snapshot: clone(state.snapshot), hash: state.mbrHash, submittedAt: m.submittedAt, reviewedAt: m.reviewedAt || null, rejectedAt: stamp() }]); m.version = '1.' + (Number(m.version.split('.')[1]) + 1); m.status = 'draft'; delete m.submittedAt; delete m.reviewedAt; delete m.approvedAt; state.snapshot = null; state.mbrHash = ''; state.dependencies = []; state.dryRun = false; log('v' + oldVersion + ' 반려 · v' + m.version + ' 새 개정본', $('actingUser').value === 'qa' ? '박승인' : '이검토'); $('actingUser').value = 'author'; go(3); }, { okText: '새 개정본', cancelText: '취소' }); };
  ['gateTraining', 'gateEquipment', 'gateDocuments', 'gateValidation', 'effectiveDate'].forEach(id => { $(id).onchange = renderReview; });
  $('activateMbr').onclick = () => { if (activationReason() || state.busy) return; state.mbr.status = 'effective'; state.mbr.effectiveAt = $('effectiveDate').value; log('MBR v' + state.mbr.version + ' 효력 전환', '박승인'); binds(); renderReview(); navigation(); MesUI.toast('효력 전환 완료 · 배치 발행 가능합니다.', 'ok'); };
  ['batchSize', 'batchStart', 'emergencyCount', 'batchLine'].forEach(id => { $(id).addEventListener('input', () => { if (state.batch) return; updateScaling(); navigation(); }); });
  $('newBatch').onclick = () => { if (!state.batch) return; state.batchSeq += 1; state.batch = null; binds(); renderIssue(); navigation(); };
  $('downloadPackage').onclick = () => { if (!state.batch) return; const url = URL.createObjectURL(new Blob([JSON.stringify(state.batch, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = state.batch.id + '-poc-package.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
  $('previousStep').onclick = () => go(Math.max(1, state.step - 1));
  $('primaryAction').onclick = () => { if ($('primaryAction').disabled) return; if (state.step === 1) state.registered ? go(2) : registerRequest(); else if (state.step === 2) state.mbr ? go(3) : createDraft(); else if (state.step === 3) { if (editable()) log('공정 설계 저장 · ' + state.mbr.phases.length + '개 공정'); go(4); } else if (state.step === 4) go(5); else issueBatch(); };
  const due = new Date(); due.setDate(due.getDate() + 14); $('dueDate').value = MesUI.nowStamp(due, 'date'); $('effectiveDate').value = today(); $('batchStart').value = today() + 'T09:00';
  binds(); renderRequest(); navigation();
})();
