// 문제 4의 순수 규칙. 같은 입력이면 같은 결과. 날짜 계산은 주입받은 cal(ctx.cal)로 한다.

export const DEADLINE_RULE_VERSION = 'S4-01/v1+C10';
export const CASE_PLANS = new Set(['PLAN-001', 'PLAN-002', 'PLAN-003', 'PLAN-004', 'PLAN-005', 'PLAN-011', 'PLAN-014']);
export const TERMINAL_PLAN_STATUS = new Set(['확정', '철회', '기한 경과 확정']);
// 공급 미확약 조건(문제 2 v2.0): 승인으로 풀리지 않고 Corevia·SCM 회신으로만 풀린다
export const UNCONFIRMED_SUPPLY = new Set(['inbound_unconfirmed', 'supply_commitment_pending', 'baseline_replenishment_unconfirmed']);
export const SUPPLY_COND_KO = { inbound_unconfirmed: '기존 입고 미확정', supply_commitment_pending: 'Corevia 공급 확약 대기',
  baseline_replenishment_unconfirmed: 'SCM 기준 수요 보충 미확인', reorder_required: '보충 발주 필요' };
export const RISK_ACCEPTED = '위험 수용 확정 가능';
// 확정 가능 상태로 볼 값(확정 버튼·모의 확정이 받는 상태)
export const CONFIRMABLE = new Set(['확정 가능', RISK_ACCEPTED]);

// 4.2 마감 산식. offsets: { judgment: -1, demand_input: -2 } (S4-01)
export function computeDeadlines(cal, { approval_anchor_date, std_approval_bd, commitment_type }, offsets, today) {
  const std = Number(std_approval_bd);
  if (!approval_anchor_date || !Number.isInteger(std)) return null;
  const final_reply_due = cal.addBusinessDays(approval_anchor_date, -1);
  const submission_due = cal.addBusinessDays(final_reply_due, -(2 * std + 1));
  const judgment_due = cal.addBusinessDays(submission_due, offsets.judgment);
  const demand_input_due = commitment_type === '기안' ? cal.addBusinessDays(submission_due, offsets.demand_input) : null;
  const first_reply_due = cal.addBusinessDays(submission_due, std);
  const alt_selection_due = cal.addBusinessDays(first_reply_due, 1);
  const earliest = [demand_input_due, judgment_due, submission_due].filter(Boolean).sort()[0];
  return {
    demand_input_due, judgment_due, submission_due, first_reply_due, alt_selection_due, final_reply_due,
    deadline_rule_version: DEADLINE_RULE_VERSION,
    computed_status: today && earliest < today ? '마감 경과 상태로 산출' : '정상',
  };
}

// 4.5 확정 가능 상태. 입력은 모두 다른 모듈·자기 테이블에서 읽은 값.
// supply: { supply_judgment_id, supply_judgment_version, supply_verdict } | null
// approval: { approval_status } | null, reply: { conditions[], supply_judgment_version_at_reply } | null
// reorder: { pendingPoIds: [], rejectedPoIds: [] } — supply.condition_basis[]의 reorder_required 발주안 중 아직 승인되지 않은 것 / 거절된 것
// risk: { accepted_condition_types[] } | null — 승인권자의 '공급 위험 수용' 회신(사용자 요청 2026-11-15 마). 공급 판정·입고 상태는 바꾸지 않는다
export function decideConfirmability({ plan_status, supply, approval, reply, openReviewIds = [], holdIds = [], humanConditionOk = false, connected = {}, reorder = { pendingPoIds: [], rejectedPoIds: [] }, risk = null }) {
  const basis = {
    supply_judgment_id: supply?.supply_judgment_id ?? null,
    supply_judgment_version: supply?.supply_judgment_version ?? null,
    approval_status: approval?.approval_status ?? null,
    open_review_ids: openReviewIds, hold_ids: holdIds,
  };
  const out = (state, reason) => ({ plan_confirmability: state, confirmability_basis: { ...basis, reason } });
  if (TERMINAL_PLAN_STATUS.has(plan_status)) return out(plan_status, '종결 상태');
  if (connected.p2 === false || connected.p3 === false) {
    return out('미확인', `연결 안 됨: ${[connected.p2 === false && '문제 2', connected.p3 === false && '문제 3'].filter(Boolean).join(', ')}`);
  }
  if (openReviewIds.length || holdIds.length) return out('미확인', openReviewIds.length ? '열린 재검토' : '보류 중');
  const verdict = supply?.supply_verdict ?? '판정불가';
  const status = approval?.approval_status ?? '미상신';
  if (verdict === '판정불가') return out('미확인', '유효 수요 입력 없음(판정불가)');
  if (status === '미상신' || status === '결재 대기') return out('미확인', `승인 ${status}`);
  if (verdict === '부족') return out('불가', '공급 부족');
  if (status === '거절') return out('불가', '승인 거절');
  // 보충 발주안이 거절되면 조건을 채울 수 없다(조정자 확정 (E)-(2)). 문제 2 재판정 전에도 불가로 본다
  if (verdict === '조건부' && (reorder.rejectedPoIds ?? []).length) return out('불가', `보충 발주안 거절: ${reorder.rejectedPoIds.join(', ')}`);
  const conditions = reply?.conditions ?? [];
  if (verdict === '조건부') {
    if (reorder.pendingPoIds.length) return out('조건부 대기', `보충 발주 필요(reorder_required): 발주안 ${reorder.pendingPoIds.join(', ')} 승인 전`);
    // 남은 조건은 공급 미확약이다. 보충 발주안이 내부 승인됐어도 Corevia 확약 전이면 공급 확약 대기로 본다(승인 ≠ 공급 확약)
    const types = conditionTypes(supply);
    const mapped = [...new Set(types.map((t) => (t === 'reorder_required' ? 'supply_commitment_pending' : t)))];
    const waiting = mapped.length ? mapped : ['inbound_unconfirmed']; // 조건 목록이 없는 조건부도 미확약으로 본다
    if (waiting.length) {
      const label = waiting.map((t) => SUPPLY_COND_KO[t] ?? t).join(', ');
      const covered = risk && waiting.every((t) => (risk.accepted_condition_types ?? []).includes(t));
      if (covered) return out(RISK_ACCEPTED, `공급 미확약(${label}) — 승인권자가 공급 위험을 수용함. 공급 판정은 조건부로 남는다`);
      return out('조건부 대기', `공급 확약 대기: ${label}. 승인으로 풀리지 않고 Corevia·SCM 회신으로만 풀린다`);
    }
  }
  if (status === '조건부') {
    const unmet = conditions.filter((c) => {
      if (c.condition_type === '공급조건부수용') return false; // 공급 조건은 위에서 본다(위험 수용 포함)
      if (c.condition_type === '수요·공급 확인 후') return verdict !== '가능';
      return !humanConditionOk; // 기타: 사람 판단 재검토가 유지로 닫혀야 충족
    });
    if (unmet.length) return out('조건부 대기', `승인 조건 미충족: ${unmet.map((c) => c.condition_type).join(', ')}`);
  }
  if (status === '승인' || status === '조건부') return out('확정 가능', '공급·승인 확인 완료');
  return out('미확인', `승인 상태 ${status}`);
}

// 조건부 판정의 조건 종류(사전 3.2). 종류가 없는 예전 행은 미확정 입고로 본다.
export const conditionTypes = (supply) => [...new Set((supply?.condition_basis ?? []).map((c) => c.condition_type ?? 'inbound_unconfirmed'))];
export const reorderPoIds = (supply) => (supply?.condition_basis ?? [])
  .filter((c) => c.condition_type === 'reorder_required').map((c) => c.po_draft_id ?? null);

// 판매 기간 겹침(주 단위, 월요일 시작)
export function salePeriodsOverlap(cal, a, b) {
  if (!a?.sale_start_week || !b?.sale_start_week) return true; // 모르면 보수적으로 겹친다고 본다
  const end = (p) => cal.addDays(p.sale_start_week, 7 * (Number(p.sale_weeks) - 1));
  return a.sale_start_week <= end(b) && b.sale_start_week <= end(a);
}

// 4.4 공급 판정 재검토 종결
export function supplyReviewOutcome(before, after) {
  const same = before?.supply_verdict === after?.supply_verdict
    && (after?.supply_verdict !== '부족' || before?.first_shortage_week === after?.first_shortage_week);
  return same ? '유지' : '변경';
}
