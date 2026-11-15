// 문제 2 계산 코어(순수 함수). 같은 입력에 같은 결과를 낸다. 명세 4.2~4.6.
import { addDays, addBusinessDays, weekStart } from '../../app/core/calendar.mjs';

// 주 격자 (명세 O1·O2)
export const FIRST_WEEK = '2026-07-06';
export const HORIZON_END = '2026-09-28';
export const PROJECTION_END = '2026-12-28';
export const WEEKS = (() => {
  const out = [];
  for (let w = FIRST_WEEK; w <= PROJECTION_END; w = addDays(w, 7)) out.push(w);
  return Object.freeze(out);
})();
export const N = WEEKS.length; // 26
export const ORDERING_RULE_VERSION = 'ORD-C5-v1';
export const PLANNED_ORDER_LAG_BD = 7; // K5
export const SCENARIOS = Object.freeze(['on_schedule', 'not_arrived']);
export const EPS = 1e-6;

export const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
export const sum = (arr, from = 0, to = arr.length - 1) => {
  let s = 0;
  for (let i = Math.max(0, from); i <= Math.min(to, arr.length - 1); i++) s += arr[i];
  return s;
};
export const zeros = () => new Array(N).fill(0);
export const idxOfWeek = (w) => WEEKS.indexOf(w);

// 입고일 → 주 번호. 첫 주 이전 도착은 첫 주에, 전개 끝 뒤는 -1(반영 안 함)
export function arrivalIndex(etaDate) {
  const ws = weekStart(etaDate);
  if (ws < FIRST_WEEK) return 0;
  if (ws > PROJECTION_END) return -1;
  return WEEKS.indexOf(ws);
}

// 입고 행 상태(명세 0절 1): 예상(공급 확인 대기) / 확약 / 입고 완료 / 미확약 잔량 / 공급 불가.
// supply_status가 없는 예전 행은 eta_status로 읽는다(확정·지연 → 확약, 미회신 → 예상).
export const supplyStatusOf = (r) => r.supply_status ?? (r.eta_status === '미회신' ? '예상' : '확약');
// 입고 행의 출처: 조건 종류를 나누는 데 쓴다
export const isCampaignDraftRow = (r) => String(r.source_ref ?? '').startsWith('POD-');
export const isBaselinePlanRow = (r) => String(r.source_ref ?? '').startsWith('SCM-BR:');
export const rowKind = (r) => (isCampaignDraftRow(r) ? '캠페인 발주안' : isBaselinePlanRow(r) ? '정기 보충'
  : String(r.source_ref ?? '').startsWith('IN_TRANSIT:') ? '운송 중' : '기발주');
// 예정일 경과·미확약: 도착 예정일이 지났는데 확약도 입고도 없는 예상 입고. 오는 경우(on_schedule)에는 다음 주(expected_now_week)에 온다고 보고,
// 확약만 보는 경우에는 넣지 않는다(명세 4.8, L7)
const COUNTED = { on_schedule: new Set(['예상', '예정일 경과·미확약', '확약', '입고 완료']), not_arrived: new Set(['확약', '입고 완료']) };
export const isExpectedStatus = (st) => st === '예상' || st === '예정일 경과·미확약';
export const effectiveEta = (r) => r.expected_now_week ?? r.eta_date;
// on_schedule: 예상 입고까지 모두 온다고 본 경우. not_arrived: 확약된 입고만 온다고 본 경우(예상 입고는 오지 않음).
// 미확약 잔량·공급 불가 행은 어느 경우에도 넣지 않는다.
export function inboundArray(rows, scenario) {
  const arr = zeros();
  for (const r of rows) {
    if (!COUNTED[scenario].has(supplyStatusOf(r))) continue;
    const i = arrivalIndex(effectiveEta(r));
    if (i >= 0) arr[i] += r.qty;
  }
  return arr;
}

// 재고 전개(판매 손실, 이월 없음)
export function project(onHand, inbound, demand) {
  const poh = new Array(N);
  const unmet = new Array(N);
  let opening = onHand;
  for (let i = 0; i < N; i++) {
    const avail = opening + inbound[i];
    const served = Math.min(avail, demand[i]);
    unmet[i] = demand[i] - served;
    poh[i] = avail - served;
    opening = poh[i];
  }
  return { poh, unmet };
}

export function suffixMin(arr) {
  const out = new Array(arr.length);
  let m = Infinity;
  for (let i = arr.length - 1; i >= 0; i--) { m = Math.min(m, arr[i]); out[i] = m; }
  return out;
}

export function stockoutInfo(unmet) {
  const idx = [];
  unmet.forEach((u, i) => { if (u > EPS) idx.push(i); });
  const first = idx.length ? idx[0] : null;
  let recovery = null;
  if (first != null) for (let i = first + 1; i < N; i++) if (unmet[i] <= EPS) { recovery = WEEKS[i]; break; }
  return {
    first_stockout_week: first == null ? null : WEEKS[first],
    recovery_week: recovery,
    stockout_weeks: idx.map((i) => WEEKS[i]),
  };
}

export const addedToArray = (rows) => {
  const arr = zeros();
  for (const r of rows) { const i = idxOfWeek(r.week_start); if (i >= 0) arr[i] += Number(r.added_qty_ea); }
  return arr;
};

// 판정일에 대안을 고를 때 새 발주안이 도착하는 주(명세 3.2 reorder_reach_week)
export const reorderReachWeek = (today, leadWeeks) =>
  weekStart(addDays(addBusinessDays(today, PLANNED_ORDER_LAG_BD), leadWeeks * 7));
// 막을 수 없는 구간 = reach 주 이전(인덱스 < R). reach가 전개 끝 뒤면 전 구간이 막을 수 없다.
export function reachIndex(today, leadWeeks) {
  const w = reorderReachWeek(today, leadWeeks);
  if (w > PROJECTION_END) return N;
  return Math.max(0, WEEKS.indexOf(w));
}
export const supplyWindow = (i, R) => (i < R ? 'unpreventable' : 'reorder');

// 막을 수 없는 구간 안의 잔여 여지: w < R이면 min(poh[w..R-1]), w ≥ R이면 null(보충 발주로 확보)
export function unpreventableRoom(poh, R) {
  const out = new Array(N).fill(null);
  let m = Infinity;
  for (let i = Math.min(R, N) - 1; i >= 0; i--) { m = Math.min(m, poh[i]); out[i] = Math.max(0, m); }
  return out;
}

const weeksWhere = (arr, pred) => arr.map((v, i) => (pred(v, i) ? i : -1)).filter((i) => i >= 0);

// SKU 하나의 판정(명세 0절, 4.4).
// prevAdded: 앞 순번 기안의 추가분 합, ownAdded: 이 기안의 추가분, R: 막을 수 없는 구간의 끝(이 인덱스부터 보충 가능)
// noReorder: 보충 발주가 막힘(발주안 거절·Corevia 불가·부분). 보충 발주 필요 조건을 만들지 않는다.
// baselineCovered: SCM이 확인한 기준 수요 보충 계획이 이 SKU에 있다. 없으면 판매 기간 뒤의 부족(캠페인이 앞당긴 기존 수요 품절)은
//   캠페인 몫인지 보충 계획 몫인지 가릴 수 없으므로 baseline_replenishment_unconfirmed 조건으로 남긴다.
export function judgeSku({ onHand, inboundRows, baseline, prevAdded, ownAdded, saleStartIdx, saleEndIdx, safetyMin, R, noReorder = false, baselineCovered = true }) {
  const per = {};
  for (const sc of SCENARIOS) {
    const inb = inboundArray(inboundRows, sc);
    const dPrev = prevAdded.map((a) => baseline + a);
    const dWith = dPrev.map((d, i) => d + ownAdded[i]);
    const prev = project(onHand, inb, dPrev);
    const withP = project(onHand, inb, dWith);
    const diff = withP.unmet.map((u, i) => (i >= saleStartIdx ? Math.max(0, u - prev.unmet[i]) : 0));
    per[sc] = { prev, withP, diff };
  }
  const on = per.on_schedule;
  const na = per.not_arrived;
  const inScope = (i) => baselineCovered || i <= saleEndIdx; // 보충 계획 미확인이면 판매 기간 뒤는 기준 수요 보충 몫
  const onU = weeksWhere(on.diff, (d, i) => i < R && d > EPS && inScope(i));
  const onP = noReorder ? [] : weeksWhere(on.diff, (d, i) => i >= R && d > EPS && inScope(i));
  const tail = weeksWhere(on.diff, (d, i) => d > EPS && !inScope(i));
  // 예상(미확약) 입고에 기대는 주: 확약 입고만 볼 때 캠페인 부족이 더 큰 주
  const rel = weeksWhere(na.diff, (d, i) => d > on.diff[i] + EPS && inScope(i));
  const conditions = [];
  let verdict = '가능';
  let basis = null; // { sc, idx, from, to }
  const rowRef = (r) => ({ inbound_row_id: r.inbound_row_id, source_ref: r.source_ref, eta_date: r.eta_date, qty: r.qty,
    ...(supplyStatusOf(r) === '예정일 경과·미확약' ? { overdue: true, expected_now_week: r.expected_now_week } : {}) });
  if (onU.length) { verdict = '부족'; basis = { sc: on, idx: onU, from: saleStartIdx, to: R - 1 }; }
  else {
    if (rel.length) {
      const last = rel[rel.length - 1];
      const rows = inboundRows.filter((r) => { const i = arrivalIndex(effectiveEta(r)); return isExpectedStatus(supplyStatusOf(r)) && i >= 0 && i <= last; })
        .sort((a, b) => effectiveEta(a).localeCompare(effectiveEta(b)) || a.inbound_row_id.localeCompare(b.inbound_row_id));
      // 행 출처별로 조건 하나씩. 대표 행은 가장 먼저 도착하는 예상 입고, 나머지는 inbound_rows[]
      const groups = [['inbound_unconfirmed', rows.filter((r) => !isCampaignDraftRow(r) && !isBaselinePlanRow(r))],
        ['supply_commitment_pending', rows.filter(isCampaignDraftRow)], ['baseline_replenishment_unconfirmed', rows.filter(isBaselinePlanRow)]];
      for (const [type, g] of groups) {
        if (!g.length) continue;
        conditions.push({ condition_type: type, ...(type === 'baseline_replenishment_unconfirmed' ? { reason: '보충 계획 미확약' } : {}),
          inbound_row_id: g[0].inbound_row_id, source_ref: g[0].source_ref, eta_date: g[0].eta_date, inbound_rows: g.map(rowRef),
          relied_weeks: rel.map((i) => WEEKS[i]) });
      }
      basis = { sc: na, idx: rel, from: saleStartIdx, to: R - 1 };
    }
    if (onP.length) {
      conditions.push({ condition_type: 'reorder_required', additional_reorder_qty_ea: r2(onP.reduce((s, i) => s + on.diff[i], 0)),
        needed_by_week: WEEKS[onP[0]], reorder_reach_week: R < N ? WEEKS[R] : null });
      basis ??= { sc: on, idx: onP, from: Math.max(saleStartIdx, R), to: N - 1 };
    }
    if (tail.length && !conditions.some((c) => c.condition_type === 'baseline_replenishment_unconfirmed')) {
      conditions.push({ condition_type: 'baseline_replenishment_unconfirmed', reason: '보충 계획 미확인', after_sale_shortage_ea: r2(sum(tail.map((i) => on.diff[i]))),
        first_week: WEEKS[tail[0]], relied_weeks: tail.map((i) => WEEKS[i]), inbound_rows: [] });
      basis ??= { sc: on, idx: tail, from: saleEndIdx + 1, to: N - 1 };
    }
    if (conditions.length) verdict = '조건부';
  }
  // 보충 가능 구간의 캠페인 추가 필요량(판정값과 무관하게 계산). 부족 SKU에 보충발주 대안을 고를 때 발주안 수량의 근거가 된다.
  const reorderNeed = onP.length ? { additional_reorder_qty_ea: r2(onP.reduce((t, i) => t + on.diff[i], 0)), needed_by_week: WEEKS[onP[0]] } : null;
  const shortIdx = basis ? basis.idx : [];
  const safetyBreach = [];
  for (let i = saleStartIdx; i <= Math.min(saleEndIdx, N - 1); i++) {
    if (on.withP.poh[i] < safetyMin * baseline - EPS) safetyBreach.push(WEEKS[i]);
  }
  const baseQty = basis ? sum(basis.sc.prev.unmet, basis.from, basis.to) : sum(on.prev.unmet, saleStartIdx, R - 1);
  return {
    verdict,
    first_shortage_week: shortIdx.length ? WEEKS[shortIdx[0]] : null,
    shortage_weeks: shortIdx.map((i) => WEEKS[i]),
    shortage_qty_base_ea: r2(baseQty),
    shortage_qty_campaign_ea: r2(basis ? sum(shortIdx.map((i) => basis.sc.diff[i])) : 0),
    preventable_by_reorder: shortIdx.length > 0 && shortIdx.every((i) => i >= R),
    condition_basis: conditions,
    stock_warning: safetyBreach.length > 0,
    safety_breach_weeks: safetyBreach,
    unpreventable_qty: { on_schedule: r2(sum(onU.map((i) => on.diff[i]))), not_arrived: r2(sum(rel.filter((i) => i < R).map((i) => na.diff[i]))) },
    reorder_need: reorderNeed,
    per,
  };
}

// 발주안 수량(명세 4.6). demandWith: 이 기안까지 얹은 주별 수요, pohOn: on_schedule 전개의 주말 재고
export function poDraftQty({ plannedOrderDate, targetWeeks, demandWith, baseline, pohOn, onHand, inboundRows, moq, unitCost, leadWeeks }) {
  const wo = idxOfWeek(weekStart(plannedOrderDate));
  if (wo < 0) return null;
  let target = 0;
  for (let k = 0; k < targetWeeks; k++) target += wo + k < N ? demandWith[wo + k] : baseline;
  const available = wo === 0 ? onHand : pohOn[wo - 1];
  const undelivered = inboundRows.filter((r) => { const i = arrivalIndex(r.eta_date); return i === -1 || i >= wo; })
    .reduce((s, r) => s + r.qty, 0);
  const suggested = Math.max(target - available - undelivered, 0);
  const orderQty = suggested > EPS ? Math.max(Math.ceil(suggested - EPS), moq) : 0;
  return {
    target_qty: r2(target), available_qty: r2(available), undelivered_qty: r2(undelivered), suggested_qty: r2(suggested),
    order_qty: orderQty, amount_krw: orderQty * unitCost,
    expected_arrival_week: weekStart(addDays(plannedOrderDate, leadWeeks * 7)),
  };
}
