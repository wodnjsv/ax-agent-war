// 문제 3 순수 계산: 현금 재전망, 하회 구간, 지급일, 승인 기준일, 경로 판정.
// 같은 입력이면 같은 결과를 낸다(난수·현재 시각을 쓰지 않는다). 근거: problem3/명세.md 3.2·4절.
import { addDays, isBusinessDay, businessDaysAfter, nextBusinessDay } from '../../app/core/calendar.mjs';

export const AS_OF = '2026-07-01';
export const HORIZON_END = '2026-09-30';
export const ITEM_LIMIT_KRW = 10_000_000;     // 정책 9행: 건별 1천만원
export const BUNDLE_LIMIT_KRW = 100_000_000;  // 정책 9행: 기안 총액 1억원

const num = (v) => {
  if (v === undefined || v === null || v === '' || v === 'NONE') return null;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`숫자가 아닙니다: ${v}`);
  return n;
};

// 비영업일이면 다음 영업일 [가정, 명세 D3-01]
export const rollToBusinessDay = (d) => (isBusinessDay(d) ? d : nextBusinessDay(d));

// 원본 스케줄을 현금 항목으로 바꾼다 [원본 계산정의 1.2].
// arOverrides: { ar_id: 'YYYY-MM-DD' } (재무 회신의 회수 예정일), extraOutflows: [{ date, amount_krw, ref }]
export function buildCashItems({ ar, ap, po, arOverrides = {}, extraOutflows = [] }) {
  const items = [];
  for (const r of ar) {
    const due = arOverrides[r.ar_id] ?? r.due_date;
    items.push({ kind: 'AR', ref: r.ar_id, due_date: due, original_due_date: r.due_date, amount_krw: num(r.outstanding_krw) });
  }
  for (const r of ap) {
    if (r.po_id !== 'NONE') continue; // 이중 차감 금지: PO 연결분은 PO에서 뺀다
    items.push({ kind: 'AP', ref: r.ap_id, due_date: r.payment_due_date, original_due_date: r.payment_due_date, amount_krw: -num(r.amount_krw) });
  }
  for (const r of po) {
    items.push({ kind: 'PO', ref: r.po_id, due_date: r.payment_due_date, original_due_date: r.payment_due_date, amount_krw: -num(r.amount_krw) });
  }
  for (const x of extraOutflows) {
    items.push({ kind: 'PO_DRAFT', ref: x.ref, due_date: x.date, original_due_date: x.date, amount_krw: -Math.abs(x.amount_krw) });
  }
  return items;
}

// variant: 'base'(기준일 이전·당일 만기 제외, U11) | 'incl_asof'(당일 만기 포함) | 'overdue_now'(이전·당일 만기를 07-01에 반영)
export function projectCash({ opening_krw, items, threshold_krw, variant = 'base', asOf = AS_OF, end = HORIZON_END }) {
  const byDate = new Map();
  const add = (d, a) => byDate.set(d, (byDate.get(d) ?? 0) + a);
  for (const it of items) {
    if (it.due_date < asOf) { if (variant === 'overdue_now') add(asOf, it.amount_krw); continue; }
    if (it.due_date === asOf && variant === 'base') continue;
    const d = rollToBusinessDay(it.due_date);
    if (d > end) continue;
    add(d, it.amount_krw);
  }
  const days = [asOf, ...businessDaysAfter(asOf, end)].filter(isBusinessDay);
  let bal = opening_krw;
  return days.map((date) => {
    const opening = bal;
    const flow = byDate.get(date) ?? 0;
    bal += flow;
    return { date, opening_krw: opening, net_flow_krw: flow, closing_krw: bal, below_threshold: bal < threshold_krw };
  });
}

// 하회 구간: 연속된 하회 영업일 묶음. 대표 구간은 첫 하회일~마지막 하회일 [명세 4.1].
// 구간이 여러 조각으로 끊기면 조각마다 시작·끝·영업일·최저 잔액을 남긴다. 끝이 재전망 마지막 날이면 end_at_horizon=true
// (그 뒤 회복일은 재전망 밖이라 확인할 수 없다).
export function findWindow(daily) {
  const segments = [];
  let cur = null;
  const lastDate = daily.at(-1)?.date ?? null;
  for (const d of daily) {
    if (d.below_threshold) {
      if (!cur) { cur = { start: d.date, end: d.date, bd: 0, min_balance_krw: d.closing_krw, min_date: d.date }; segments.push(cur); }
      cur.end = d.date; cur.bd += 1;
      if (d.closing_krw < cur.min_balance_krw) { cur.min_balance_krw = d.closing_krw; cur.min_date = d.date; }
    } else cur = null;
  }
  for (const s of segments) { s.min_balance_krw = Math.round(s.min_balance_krw); s.end_at_horizon = s.end === lastDate; }
  const min = daily.reduce((m, d) => (m == null || d.closing_krw < m.closing_krw ? d : m), null);
  const start = segments[0]?.start ?? null;
  const end = segments.at(-1)?.end ?? null;
  return {
    shortfall_window_start: start,
    shortfall_window_end: end,
    shortfall_bd_count: segments.reduce((s, x) => s + x.bd, 0),
    segments,
    min_balance_krw: min ? Math.round(min.closing_krw) : null,
    min_date: min?.date ?? null,
    next_outside_date: end ? nextBusinessDay(end) : null,
  };
}

export const inWindow = (date, segments) => Boolean(segmentOf(date, segments));
// 유출일(주말이면 다음 영업일)이 드는 조각. 없으면 null
export function segmentOf(date, segments) {
  if (!date) return null;
  const d = rollToBusinessDay(date);
  return segments.find((s) => d >= s.start && d <= s.end) ?? null;
}
// 화면·사건용 조각 표현(저장된 이전 버전의 {start,end,bd}도 받는다)
export const segmentView = (s, i) => ({
  segment_no: i + 1, start: s.start, end: s.end, bd_count: s.bd_count ?? s.bd ?? null,
  min_balance_krw: s.min_balance_krw ?? null, min_date: s.min_date ?? null, end_at_horizon: s.end_at_horizon ?? false,
});

// 공급처 결제 조건 S3-01: 청구월 마감, offset개월 뒤 payment_day일, 비영업일이면 다음 영업일
export function paymentDueDate(invoiceDate, term) {
  const offset = Number(term.payment_month_offset);
  const day = Number(term.payment_day);
  if (term.payment_close_basis !== 'invoice_month') throw new Error(`지원하지 않는 결제 기준: ${term.payment_close_basis}`);
  const [y, m] = invoiceDate.split('-').map(Number);
  const total = (m - 1) + offset;
  const yy = y + Math.floor(total / 12);
  const mm = (total % 12) + 1;
  const raw = `${yy}-${String(mm).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (term.nonbusiness_day_rule !== 'next_business_day') throw new Error(`지원하지 않는 비영업일 규칙: ${term.nonbusiness_day_rule}`);
  return rollToBusinessDay(raw);
}

// 승인 기준일 [U4, C7]
export function anchorFor(c) {
  if (c.commitment_type === '발주안') return { approval_anchor_date: c.planned_order_date, anchor_basis: 'planned_order_date' };
  const s = c.settlement_date;
  const k = c.contract_deadline;
  if (s === k) return { approval_anchor_date: k, anchor_basis: 'same' };
  return s < k ? { approval_anchor_date: s, anchor_basis: 'settlement_date' } : { approval_anchor_date: k, anchor_basis: 'contract_deadline' };
}

export const ROUTE_TEXT = {
  'R-00': '판정 대상 아님(기발주, 신규 약정 아님)',
  'R-01': '하회 예상 구간 유출 → 그룹 CEO 결재(결재 방식은 운영 가정 U1)',
  'R-02': 'Masil 대표 승인 + 그룹 보고',
  'R-03': '마케팅팀 전결',
  'R-04': 'SCM 승인(평시 재고 발주)',
};

// 경로 판정 [명세 4.5]. 위에서부터 처음 맞는 규칙.
// c: { commitment_type, is_new_commitment, cash_outflow_date, amount_krw }, segments, bundle_total_krw
export function judgeRoute(c, segments, bundleTotalKrw) {
  let rule;
  let approver = null;
  let usesBundle = false;
  if (!c.is_new_commitment) rule = 'R-00';
  else if (inWindow(c.cash_outflow_date, segments)) { rule = 'R-01'; approver = 'GRP_CEO'; }
  else if (c.commitment_type === '기안') {
    const overItem = c.amount_krw > ITEM_LIMIT_KRW;
    usesBundle = !overItem;
    if (overItem || bundleTotalKrw > BUNDLE_LIMIT_KRW) { rule = 'R-02'; approver = 'MS_CEO'; }
    else { rule = 'R-03'; approver = 'MKT_TEAM'; }
  } else { rule = 'R-04'; approver = 'SCM'; }
  return {
    route_rule_id: rule,
    approver,
    approval_route: approver ? `${approver}: ${ROUTE_TEXT[rule]}` : ROUTE_TEXT[rule],
    in_window: rule === 'R-01',
    group_report_required: rule === 'R-02',
    uses_bundle: usesBundle,
  };
}

// 원본 행 → 계산에 필요한 숫자 요약(테스트·화면용)
export const sumKrw = (rows, field) => rows.reduce((s, r) => s + num(r[field]), 0);
export { addDays };
