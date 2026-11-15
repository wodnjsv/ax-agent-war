// 화면 공용 도구. 패널(problemN/src/panel.js)은 이 객체를 ui로 받는다.
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const SOURCE_LABEL = { 원본도출: '원본', 계산: '계산', 가정: '가정', 모의회신: '모의', 사람입력: '사람입력' };

// 자료 구분 표시. 예: tag('계산', false, true) → [계산][시뮬레이션]. 줄바꿈되지 않는다.
// 화면 지침(조정자 (E)): 표 칸마다 반복하지 말고 구역 제목이나 열 제목에 한 번만 붙인다.
export function tag(sourceType, isSynthetic = false, isSimulation = false) {
  const parts = [];
  if (sourceType) parts.push(`<span class="tag t-${esc(SOURCE_LABEL[sourceType] ?? sourceType)}">${esc(SOURCE_LABEL[sourceType] ?? sourceType)}</span>`);
  if (isSynthetic && sourceType !== '모의회신') parts.push('<span class="tag t-가상">가상 입력</span>');
  if (isSimulation) parts.push('<span class="tag t-시뮬">시뮬레이션</span>');
  return parts.length ? `<span class="tags">${parts.join('')}</span>` : '';
}

export const krw = (n) => (n == null ? '-' : `${Number(n).toLocaleString('ko-KR')}원`);
export const num = (n) => (n == null ? '-' : Number(n).toLocaleString('ko-KR'));
// 억 단위(소수 둘째 자리). 예: -618600000 → −6.19억
export const eok = (n) => (n == null ? '-' : `${n < 0 ? '−' : ''}${(Math.abs(n) / 1e8).toFixed(2)}억`);

// 전문 용어 코드 → 한국어 이름. 없는 코드는 그대로 둔다.
export const LABELS = {
  // 승인권자·부서
  GRP_CEO: '그룹 CEO', MS_CEO: 'Masil 대표', MKT_TEAM: '마케팅팀', SCM: 'SCM',
  MKT: '마케팅', FIN: '재무', MS_MGMT: 'Masil 경영', GROUP: '그룹', COREVIA: 'Corevia', SYSTEM: '시스템',
  // 시나리오
  BASE: '기본', 'S-AR-DELAY': '회수일 지연', 'S4-OI3-A': '그룹 배분 대상 회신', 'S-SUP-REPLY': '공급처 회신', 'S-CEO-FLOOR': '그룹 CEO 최저 잔액 조건(가정)',
  // 입고·조건
  on_schedule: '예정대로 입고', not_arrived: '미도착 가정', inbound_unconfirmed: '미확정 입고', reorder_required: '보충 발주 필요',
  // 재검토·요청 대상
  demand_input: '수요 입력', supply_judgment: '공급 판정', route_judgment: '승인 경로 판정', commitment: '약정', info_request: '확인 요청',
  plan_bundle: '기안 묶음', cash_window: '현금 구간', plan: '기안', po_draft: '발주안', plan_state: '기안 상태', review: '재검토', open_issue: '미결',
  group_report: '그룹 보고', group_allocation: '그룹 배분', finance_confirmation: '재무 확인', po_draft_overdue: '발주 예정일 경과',
  inbound_eta: '입고 예정일', supply_request: '공급 요청', settlement_unapproved: '미승인 집행', source_unknown: '출처 미상',
  baseline_replenishment: '기준 수요 보충(범위 밖)',
  initial: '최초', rerequest: '재요청', correction: '정정 요청',
  // 날짜 이름
  demand_input_due: '수요 입력 마감', judgment_due: '판정·재무 확인 마감', submission_due: '상신 마감', first_reply_due: '1차 회신 마감',
  alt_selection_due: '대안 선택 마감', final_reply_due: '최종 회신 마감', approval_anchor_date: '승인 기준일',
  planned_order_date: '발주 예정일', contract_deadline: '확정기한', settlement_date: '집행 예정일',
  // 문제
  p1: '문제 1', p2: '문제 2', p3: '문제 3', p4: '문제 4',
  // 사건(사전 5절)
  BASELINE_DEMAND_SET: '기준 수요 설정', DEMAND_INPUT_STRUCTURED: '수요 회신 구조화', DEMAND_INPUT_REJECTED: '수요 입력 반려',
  DEMAND_INPUT_REGISTERED: '수요 입력 등록', DEMAND_INPUT_REVISED: '수요 입력 정정',
  SUPPLY_PROJECTED: '공급 전개', INBOUND_SCHEDULE_REVISED: '입고 일정 변경', SUPPLIER_REPLIED: '공급처 회신', SUPPLY_JUDGED: '공급 판정',
  ALTERNATIVES_COMPUTED: '대안 계산', ALTERNATIVE_SELECTED: '대안 선택', PO_DRAFT_CREATED: '발주안 생성', PO_DRAFT_CANCELLED: '발주안 취소',
  CASH_WINDOW_REVISED: '현금 하회 구간 산출', FINANCE_CONFIRMED: '재무 확인', AR_DATE_REVISED: '회수일 변경', PAYMENT_DATE_SET: '지급일 산정',
  ROUTE_JUDGED: '승인 경로 판정', APPROVAL_SUBMITTED: '상신',
  PLAN_RECEIVED: '기안 접수', OPEN_ISSUE_RAISED: '미결 등록', OPEN_ISSUE_CLOSED: '미결 종결', INFO_REQUESTED: '확인 요청', INFO_REPLIED: '확인 회신',
  DEADLINES_SET: '마감 산출', DEADLINES_RECOMPUTED: '마감 재산출', APPROVAL_REPLIED: '승인 회신', HOLD_PLACED: '보류', HOLD_RESUMED: '보류 재개',
  HOLD_CANCELLED: '보류 해제', REVIEW_OPENED: '재검토 개시', REVIEW_CLOSED: '재검토 종결', DEADLINE_WARNED: '기한 경고',
  PLAN_CONFIRMABILITY_CHANGED: '확정 가능 상태 변경', PLAN_CONFIRMED: '기안 확정', PLAN_WITHDRAWN: '기안 철회',
  PLAN_AUTO_CONFIRMED_BY_DEADLINE: '기한 경과 확정', AI_CALL_RECORDED: 'AI 호출 기록', AI_OUTPUT_REVIEWED: 'AI 출력 확인',
};
export const label = (code) => (code == null ? '-' : LABELS[code] ?? code);

// cols: [{ key, label, render?(row), tag?(열 제목의 자료 구분 html), nowrap? }]
export function table(cols, rows, { empty = '없음' } = {}) {
  if (!rows.length) return `<p class="muted">${esc(empty)}</p>`;
  const head = cols.map((c) => `<th>${esc(c.label)}${c.tag ?? ''}</th>`).join('');
  const body = rows.map((r) => `<tr>${cols.map((c) => `<td${c.nowrap ? ' class="nowrap"' : ''}>${c.render ? c.render(r) : esc(r[c.key])}</td>`).join('')}</tr>`).join('');
  return `<div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

// 전체 폭 구역. 자료 구분은 제목에 한 번만 붙인다.
export const section = (title, body, { tag: t = '', note = '' } = {}) =>
  `<section class="sec"><h3>${esc(title)}${t}</h3>${note ? `<p class="muted">${note}</p>` : ''}${body}</section>`;

// 접는 목록. 긴 목록(재검토·판정 버전·주차별 표)은 기본으로 접는다.
export const fold = (title, body, { open = false, count = null } = {}) =>
  `<details class="fold"${open ? ' open' : ''}><summary>${esc(title)}${count == null ? '' : ` <span class="muted">(${count})</span>`}</summary>${body}</details>`;

export const api = {
  async get(path) {
    const res = await fetch(path, { cache: 'no-store' }); // 서버 상태(가상 일자 등)는 늘 최신 값으로
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data;
  },
  async post(path, body = {}) {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data;
  },
};

export const ui = { esc, tag, krw, num, eok, table, label, section, fold };
