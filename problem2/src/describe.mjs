// 문제 2 사건 설명 카드(describeEvent). 평가자 화면(오른쪽)이 카드만 읽고 '어떤 데이터로, 어떤 규칙으로, 무엇이 바뀌었는지' 알 수 있게 한다.
// 형식: { title, actor_kind, actor_label, inputs: [{ label, value, source, ref }], rule, result, next }
// 계산·판정은 하지 않는다. 저장된 판정·발주안·대안 행과 사건 payload만 읽는다.

// 입고 행 출처 코드를 업무 이름으로(IN_TRANSIT → 운송 중 물량, SCM-BR → SCM 정기 보충)
export const refName = (ref) => {
  const t = String(ref ?? '');
  let m = t.match(/^IN_TRANSIT:(SKU-\d+)$/);
  if (m) return `운송 중 물량(${m[1]})`;
  m = t.match(/^SCM-BR:(SKU-\d+):(\d+)$/);
  if (m) return `SCM 정기 보충(${m[1]} ${m[2]}회차)`;
  return t;
};
const n = (x) => (x == null ? '-' : Number(x).toLocaleString('ko-KR'));
const eok = (krw) => (krw == null ? '-' : `${(Number(krw) / 1e8).toLocaleString('ko-KR', { maximumFractionDigits: 2 })}억 원`);
const SRC = { 원본도출: '원본', 계산: '계산', 가정: '가정', 모의회신: '모의회신', 사람입력: '사람입력' };
const DEPT = { MKT: '마케팅 기안 담당자', SCM: 'SCM', COREVIA: 'Corevia', FIN: '재무', SYSTEM: '시스템', GROUP: '그룹' };
export const EVENT_NAME = {
  DEMAND_INPUT_REGISTERED: '수요 입력 등록', DEMAND_INPUT_REVISED: '수요 입력 정정', INBOUND_SCHEDULE_REVISED: '입고 일정 변경',
  BASELINE_DEMAND_SET: '기준 수요 설정', PLAN_RECEIVED: '기안 접수', REVIEW_OPENED: '재검토', APPROVAL_REPLIED: '승인 회신',
  PLAN_WITHDRAWN: '기안 철회', PLAN_CONFIRMED: '기안 확정', PLAN_AUTO_CONFIRMED_BY_DEADLINE: '기한 경과 확정', ALTERNATIVE_SELECTED: '대안 선택',
  SUPPLY_JUDGED: '앞 공급 판정', PO_DRAFT_CREATED: '발주안 생성', SUPPLIER_REPLIED: 'Corevia 회신', PAYMENT_DATE_SET: '지급일 산정',
};
export const ALT_NAME = { 시기이동: '판매 시기 늦추기', 물량상한: '증가율 낮추기', 구성이동: 'SKU 구성 바꾸기', 보충발주: '보충 발주', 조기분할요청: 'Corevia 조기·분할 공급 요청', 집행일이동: '집행일 옮기기' };
const TOPIC = { inbound_eta: '입고 예정일 확인', supply_request: 'Corevia 공급 확인', po_draft_overdue: '발주 예정일 지난 미승인 발주안', baseline_replenishment: '기준 수요 보충 계획 확인',
  po_draft_orphaned: '기안 철회 뒤 남은 발주의 취소·조정 가능 여부' };

const actorOf = (e, fallback = '시스템') => {
  if (e.source_type === '계산') return { actor_kind: '규칙·계산', actor_label: '시스템(문제 2 공급 판정)' };
  const label = e.actor_role === 'MKT-LINE-OWNER' ? '마케팅 기안 담당자' : DEPT[e.actor_dept] ?? e.actor_role ?? fallback;
  if (e.source_type === '모의회신' || (e.source_type === '사람입력' && e.is_synthetic)) return { actor_kind: '모의 입력', actor_label: label };
  return { actor_kind: '사람', actor_label: label };
};

// 조건부를 종류까지 붙여 부른다
export const COND_LABEL = { reorder_required: '보충 발주 필요', inbound_unconfirmed: '미확정 입고', supply_commitment_pending: '공급 확약 대기', baseline_replenishment_unconfirmed: '기준 수요 보충 미확인' };
export function verdictLabel(verdict, conditions = []) {
  if (verdict !== '조건부') return verdict;
  const kinds = [...new Set(conditions.map((c) => COND_LABEL[c.condition_type] ?? c.condition_type))];
  return `조건부(${kinds.join('·') || '조건'})`;
}

// SKU 한 줄 근거: 판정, 부족 주·수량, 막을 수 없는 구간, 조건
export function skuReason(r) {
  const parts = [`${r.sku_id} ${verdictLabel(r.supply_verdict, r.condition_basis)}`];
  if (r.supply_verdict === '부족') {
    parts.push(`${r.shortage_weeks?.join('·') || r.first_shortage_week} 주에 캠페인 추가분 ${n(r.shortage_qty_campaign_ea)} EA가 모자람`);
    if (r.reorder_reach_week) parts.push(`지금 발주해도 ${r.reorder_reach_week} 주 전에는 도착하지 않음`);
    if (r.reorder_blocked) parts.push(`발주안 ${r.reorder_blocked.po_draft_id}가 거절돼 보충 발주가 없음`);
  }
  for (const c of r.condition_basis ?? []) {
    if (c.condition_type === 'reorder_required') {
      parts.push(`${c.needed_by_week} 주까지 ${n(c.additional_reorder_qty_ea)} EA 보충 발주 필요(발주 시한 ${c.order_deadline}${c.po_draft_id ? `, 발주안 ${c.po_draft_id}` : ''})`
        + (c.covered_by_approved_qty_ea ? `. 필요 ${n(c.campaign_need_ea)} EA 중 승인 발주안이 ${n(c.covered_by_approved_qty_ea)} EA를 채움` : ''));
    } else if (c.condition_type === 'supply_commitment_pending') {
      parts.push(`승인된 발주안 입고 ${(c.inbound_rows ?? []).map((x) => `${refName(x.source_ref)}(${x.eta_date} 예상)`).join(', ')}에 기댐: Corevia 공급 확약 전`);
    } else if (c.condition_type === 'baseline_replenishment_unconfirmed') {
      parts.push(c.reason === '보충 계획 미확약' ? `SCM 기준 수요 보충 입고 ${(c.inbound_rows ?? []).map((x) => `${refName(x.source_ref)}(${x.eta_date} 예상)`).join(', ')}가 Corevia 확약 전`
        : `판매 기간 뒤 ${c.first_week} 주부터 기존 수요 몫 ${n(c.after_sale_shortage_ea)} EA가 모자랄 수 있으나 SCM 기준 수요 보충 계획 미확인`);
    } else {
      parts.push(`미확정 입고 ${(c.inbound_rows ?? [c]).map((x) => `${refName(x.source_ref)}(${x.eta_date})`).join(', ')}가 확정돼야 버팀`);
    }
  }
  return parts.join(', ');
}

export function makeDescribe(q) {
  const cards = {
    SUPPLY_PROJECTED(e) {
      const p = e.payload ?? {};
      return {
        title: '재고 전개: 캠페인 추가분 없이 SKU별 26주 재고를 다시 계산',
        ...actorOf(e),
        inputs: [
          { label: '현재고(06-30 스냅숏)', value: '14개 SKU 현재고·운송 중 물량', source: '원본', ref: '02_masil/inventory/sku_inventory_ms.csv' },
          { label: '입고 일정', value: p.inbound_schedule_version, source: '계산', ref: p.inbound_schedule_version },
          { label: '기준 수요', value: p.baseline_demand_version, source: '계산', ref: p.baseline_demand_version },
          { label: 'SCM 기준 수요 보충 계획', value: q.coverSummary(), source: '모의회신', ref: 'problem2/data/s2_scm_replenishment.csv' },
        ],
        rule: '매주 기초 재고 + 그 주 입고에서 수요를 빼고, 모자라면 그 주 판매를 잃는다(이월 없음). 기준 수요는 전 구간에서 재고를 깎고, SCM이 확인한 보충 계획만 입고로 들어간다. 확약 입고만 보는 경우와 예상 입고까지 보는 경우를 나눠 계산한다.',
        result: `잔여 여지와 기존 수요 품절(배경)을 새 입고 일정 ${p.inbound_schedule_version}·기준 수요 ${p.baseline_demand_version}으로 갱신했다.`,
        next: '각 기안의 공급 판정이 이 전개를 쓴다.',
      };
    },

    SUPPLY_JUDGED(e) {
      const p = e.payload ?? {};
      const { plan, skus } = q.judgmentAt(p.plan_id, p.supply_judgment_version);
      if (!plan) return null;
      const prev = p.previous_supply_judgment_version ? q.judgmentAt(p.plan_id, p.previous_supply_judgment_version).plan : null;
      const cause = e.caused_by ? q.event(e.caused_by) : null;
      const pr = plan.premise_refs ?? {};
      const now = verdictLabel(plan.supply_verdict, plan.condition_basis);
      const before = prev ? verdictLabel(prev.supply_verdict, prev.condition_basis) : null;
      const inputs = [];
      if (cause) inputs.push({ label: '다시 판정한 계기', value: `${EVENT_NAME[cause.event_type] ?? cause.event_type}${cause.subject_id ? ` ${cause.subject_id}` : ''} (${cause.occurred_at})`, source: SRC[cause.source_type] ?? '계산', ref: cause.event_id });
      inputs.push(
        { label: '수요 입력', value: pr.demand_input_id ? `${pr.demand_input_id} v${pr.demand_input_version}` : '유효한 수요 입력 없음', source: '사람입력', ref: pr.demand_input_id ? `${pr.demand_input_id}#${pr.demand_input_version}` : null },
        { label: '기준 수요', value: pr.baseline_demand_version ?? '-', source: '계산', ref: pr.baseline_demand_version },
        { label: '입고 일정', value: pr.inbound_schedule_version ?? '-', source: '계산', ref: pr.inbound_schedule_version },
        { label: '앞 순번 기안', value: plan.plan_order_rank ? `${plan.plan_order_rank}번째(앞 순번 기안의 추가분을 먼저 반영)` : '-', source: '계산', ref: pr.ordering_rule_version },
      );
      for (const r of skus) {
        inputs.push({ label: `${r.sku_id} 재고`, value: `현재고 ${n(q.inventory(r.sku_id)?.on_hand_qty)} EA · 기준 수요 주 ${n(q.baselineOf(r.sku_id))} EA`, source: '원본', ref: `02_masil/inventory/sku_inventory_ms.csv#${r.sku_id}` });
        if (r.baseline_plan_status) inputs.push({ label: `${r.sku_id} 기준 수요 보충 계획`, value: r.baseline_plan_status, source: '모의회신', ref: `problem2/data/s2_scm_replenishment.csv#${r.sku_id}` });
      }
      const changed = prev ? (before === now ? `결론 유지(${now})` : `${before} → ${now}`) : `첫 판정 ${now}`;
      return {
        title: `공급 판정 v${plan.supply_judgment_version} · ${plan.plan_id}: ${now}`,
        ...actorOf(e),
        inputs,
        rule: '지금 발주해도 도착 전인 주(판정일 + 7영업일 발주 + 리드타임 이전)에 캠페인 추가분이 품절을 늘리면 부족, 그 뒤 주에서만 늘리면 조건부(보충 발주 필요)다. Corevia가 확약한 입고만으로 버티면 가능이고, 예상 입고(승인된 발주안·미회신 기발주·미확약 정기 보충)에 기대야 버티면 조건부(공급 확약 대기 등)다. 내부 승인만으로는 조건이 풀리지 않는다. 기안 판정은 SKU 중 가장 나쁜 값이다.',
        result: `${changed}. ${skus.map(skuReason).join(' / ')}${e.generation_reason ? ` (사유: ${e.generation_reason})` : ''}`,
        next: plan.supply_verdict === '부족' ? '대안 계산 → 마케팅 기안 담당자가 시기·물량·구성 변경을 고르거나 철회'
          : plan.supply_verdict === '조건부' ? (plan.condition_basis.some((c) => c.po_draft_id) ? `SKU 발주안 ${[...new Set(plan.condition_basis.filter((c) => c.po_draft_id).map((c) => c.po_draft_id))].join(', ')} 상신·승인(문제 3) → 승인되면 입고에 반영되어 다시 판정` : '입고 확정 회신을 기다림')
          : plan.supply_verdict === '판정불가' ? '마케팅 기안 담당자의 수요 입력(증가율·판매 기간)을 기다림' : '확정 가능 여부 판단(문제 4)',
      };
    },

    ALTERNATIVES_COMPUTED(e) {
      const p = e.payload ?? {};
      const alts = q.alternatives(p.alternative_ids ?? []);
      const ok = alts.filter((a) => a.feasible);
      const jv = alts[0]?.supply_judgment_version;
      return {
        title: `대안 계산 · ${e.plan_id}: 실행 가능 ${ok.length}개 / ${alts.length}개`,
        ...actorOf(e),
        inputs: [
          { label: '근거 판정', value: `${p.supply_judgment_id}${jv ? ` v${jv}` : ''}`, source: '계산', ref: e.caused_by },
          { label: '대안별 추가 수량', value: '문제 1 미리보기(같은 증가율 규칙으로 바뀐 기간·증가율의 EA)', source: '계산', ref: 'problem1 previewAddedQty' },
        ],
        rule: '시기·물량·구성 대안은 막을 수 없는 구간의 캠페인 부족이 0이 되는지로 실행 가능 여부를 본다. 보충 발주는 그 SKU 발주안에 잇고, 조기 공급은 Corevia 회신 전에는 가능하다고 보지 않는다.',
        result: alts.map((a) => `${ALT_NAME[a.alternative_type] ?? a.alternative_type} ${a.feasible ? '가능' : '불가'}${altBrief(a) ? `(${altBrief(a)})` : ''}`).join(', ') || '대안 없음',
        next: '마케팅 기안 담당자가 대안을 고르거나 철회한다(보충 발주·조기 공급 요청은 SCM).',
      };
    },

    ALTERNATIVE_SELECTED(e) {
      const p = e.payload ?? {};
      const a = q.alternatives([p.alternative_id])[0] ?? {};
      const sel = p.alternative_selection;
      const what = {
        시기이동: sel && `판매 시작 주 → ${sel.new_sale_start_week}(${sel.new_sale_weeks}주 유지)`,
        물량상한: sel && `증가율 → ${sel.new_uplift_pct}%`,
        구성이동: sel && `SKU별 증가율 → ${(sel.new_override_uplift_pct ?? []).map((o) => `${o.sku_id} ${o.override_uplift_pct}%`).join(', ')}`,
        집행일이동: p.plan_change && `집행 예정일 → ${p.plan_change.settlement_date}`,
        보충발주: `${a.sku_id} SKU 발주안에 이 기안을 연결`,
        조기분할요청: `${a.po_id} ${n(a.requested_qty)} EA를 ${a.needed_week} 주까지 조기·분할 공급 요청`,
      }[p.alternative_type] ?? '';
      return {
        title: `대안 선택 · ${e.plan_id}: ${ALT_NAME[p.alternative_type] ?? p.alternative_type}`,
        ...actorOf(e),
        inputs: [
          { label: '고른 대안', value: `${p.alternative_id} ${what}`, source: SRC[e.source_type] ?? '사람입력', ref: p.alternative_id },
          ...(e.source_ref ?? []).map((r) => ({ label: '모의 입력 자료', value: r, source: '모의회신', ref: r })),
        ],
        rule: '시기·물량·구성 변경은 문제 1이 새 수요 입력 버전으로 받아 다시 계산한다. 집행일 이동은 문제 3이 승인 경로를 다시 판정한다. 보충 발주·조기 공급은 SCM 몫이다.',
        result: `${what}.${e.generation_reason ? ` (${e.generation_reason})` : ''}`,
        next: ['시기이동', '물량상한', '구성이동'].includes(p.alternative_type) ? '문제 1 수요 입력 정정 → 공급 판정 다시'
          : p.alternative_type === '집행일이동' ? '문제 3 승인 경로 재판정 → 재상신' : p.alternative_type === '보충발주' ? '발주안 상신·승인(문제 3)' : 'Corevia 회신 대기',
      };
    },

    PO_DRAFT_CREATED(e) {
      const d = e.payload ?? {};
      if (d.change_kind === 'linked_plans_changed') {
        const w = d.withdrawal;
        return {
          title: `발주안 연결 기안 변경: ${d.po_draft_id} ${d.sku_id} (${(d.linked_plan_ids_before ?? []).join(', ') || '-'} → ${(d.linked_plan_ids ?? []).join(', ') || '없음'})`,
          ...actorOf(e),
          inputs: [
            { label: '발주안', value: `${d.po_draft_id} v${d.draft_version} ${n(d.order_qty)} EA, ${d.po_draft_status}${d.orphan_status ? ` · ${d.orphan_status}` : ''}`, source: '계산', ref: d.po_draft_id },
            ...(w ? [{ label: '철회된 기안', value: `${w.plan_id}(${w.disposition})`, source: '사람입력', ref: w.withdrawn_event_id }] : []),
          ],
          rule: '발주안의 연결 기안은 문제 2가 발주안에 기록한 연결 기안 목록이 기준이다. 수량·판이 그대로면 같은 판으로 다시 알리고 승인 상태는 그대로 둔다. 철회는 발주 전달 전이면 그 기안만 떼거나 취소, 전달 뒤면 남은 발주로 표시한다.',
          result: `연결 기안 ${(d.linked_plan_ids ?? []).join(', ') || '없음'}.${w ? ` 처리: ${w.disposition}.` : ''}${d.orphan_status ? ' SCM에 취소·조정 가능 여부를 묻는다.' : ''}`,
          next: '문제 3이 약정의 연결 기안을 이 값으로 맞춘다',
        };
      }
      const prev = d.draft_version > 1 ? q.draftAt(d.po_draft_id, d.draft_version - 1) : null;
      const s = q.sku(d.sku_id) ?? {};
      const qb = d.qty_breakdown ?? {};
      return {
        title: prev ? `발주안 수량 갱신: ${d.po_draft_id} ${d.sku_id} v${prev.draft_version} ${n(prev.order_qty)} → v${d.draft_version} ${n(d.order_qty)} EA`
          : `발주안 생성: ${d.po_draft_id} ${d.sku_id} ${n(d.order_qty)} EA`,
        ...actorOf(e),
        inputs: [
          ...(qb.campaign_by_plan ?? []).map((x) => ({ label: `${x.plan_id} 남은 캠페인 추가 필요량`, value: `${n(x.qty_ea)} EA(${x.needed_by_week} 주까지)`, source: '계산', ref: `SJ-${x.plan_id}-${d.sku_id}` })),
          { label: 'MOQ', value: `${n(d.moq)} EA`, source: '원본', ref: `02_masil/master/m_sku_ms.csv#${d.sku_id}` },
          { label: '리드타임', value: `${s.lead_time_weeks}주`, source: '원본', ref: `02_masil/master/m_sku_ms.csv#${d.sku_id}` },
          { label: '단가', value: `${n(d.unit_cost_krw)}원`, source: '원본', ref: `02_masil/marketing/mkt_cost_master_ms.csv#${d.sku_id}` },
        ],
        rule: '수량 = 그 SKU에 걸린 기안들의 캠페인 추가분 중 기존 재고·미입고·승인된 발주안으로 채워지지 않는 양의 합. MOQ보다 작으면 MOQ로 올린다. 기준 수요분은 넣지 않는다(SCM 정기 발주 소관). 발주 예정일 = 처음 만든 날 + 7영업일.',
        result: `${n(d.order_qty)} EA = 캠페인 추가분 ${n(qb.campaign_added_ea)} + MOQ 올림분 ${n(qb.rounding_ea)}, ${eok(d.amount_krw)}. ${d.planned_order_date} 발주 → ${d.expected_arrival_week} 주 도착. 연결 기안 ${d.linked_plan_ids?.join(', ')}.${e.generation_reason ? ` (${e.generation_reason})` : ''}`,
        next: '문제 3이 지급일·승인 경로를 정해 상신 → 승인권자 회신(승인이면 예상 입고로 반영하고 Corevia 공급 확약을 기다림, 거절이면 연결 기안 다시 판정)',
      };
    },

    PO_DRAFT_CANCELLED(e) {
      const p = e.payload ?? {};
      const d = q.draftAt(p.po_draft_id, p.draft_version) ?? {};
      const cause = e.caused_by ? q.event(e.caused_by) : null;
      return {
        title: `발주안 취소: ${p.po_draft_id} ${d.sku_id ?? ''} ${n(d.order_qty)} EA`,
        ...actorOf(e),
        inputs: [
          { label: '취소 계기', value: cause ? `${EVENT_NAME[cause.event_type] ?? cause.event_type} ${cause.plan_id ?? ''} (${cause.occurred_at})` : '-', source: cause ? SRC[cause.source_type] ?? '계산' : '계산', ref: e.caused_by },
          { label: '연결 기안', value: (d.linked_plan_ids ?? []).join(', ') || '-', source: '계산', ref: p.po_draft_id },
        ],
        rule: '승인 전 발주안만 취소한다. 연결 기안이 모두 빠졌을 때(보충 조건 해소 또는 철회)만 취소하고, 승인된 발주안은 취소하지 않는다.',
        result: `${p.cancel_reason}${p.withdrawal ? `(처리: ${p.withdrawal.disposition}, 철회 기안 ${p.withdrawal.plan_id})` : ''}. ${eok(d.amount_krw)} 발주안이 승인 대상에서 빠진다.`,
        next: '문제 3이 약정을 비활성으로 바꾼다.',
      };
    },

    INBOUND_SCHEDULE_REVISED(e) {
      const p = e.payload ?? {};
      if (p.receipts || p.overdue_expected) {
        return {
          title: `입고 처리 ${p.inbound_schedule_version}: 입고 완료 ${p.receipts?.length ?? 0}행 · 도착 예정일 경과·미확약 ${p.overdue_expected?.length ?? 0}행`,
          actor_kind: p.receipts?.length ? '모의 입력' : '규칙·계산', actor_label: p.receipts?.length ? '물류 입고 담당(모의 입력)' : '시스템(문제 2 공급 판정)',
          inputs: [
            ...(p.receipts ?? []).slice(0, 8).map((r) => ({ label: `${refName(r.source_ref)} 입고 실적`, value: `${n(r.received_qty)} EA, ${r.received_on}(확약 수량 그대로)`, source: '사람입력', ref: r.inbound_row_id })),
            ...(p.overdue_expected ?? []).slice(0, 8).map((r) => ({ label: `${refName(r.source_ref)} 미확약 예상 입고`, value: `도착 예정일 ${r.original_eta_date} 경과, 오는 경우 ${r.expected_now_week} 주로 봄`, source: '계산', ref: r.inbound_row_id })),
          ],
          rule: '확약된 입고는 도착일이 지나면 입고 실적(모의 입력, 기본은 확약 수량 그대로)으로 입고 완료가 된다. 확약 안 된 예상 입고는 도착 예정일이 지나도 입고 완료가 되지 않고 예정일 경과·미확약이 되어, 확약만 보는 경우에서 빠지고 오는 경우에도 다음 주에 온다고 본다. 같은 날 다시 처리해도 바뀌지 않는다.',
          result: `입고 완료 ${p.receipts?.length ?? 0}행, 예정일 경과·미확약 ${p.overdue_expected?.length ?? 0}행. 예정일 경과 행에 기대는 기안은 조건 또는 부족으로 다시 판정한다.`,
          next: '예정일 경과 행은 Corevia·SCM 회신을 기다린다',
        };
      }
      const rows = p.changed_rows ?? [];
      const fromDraft = e.source_type === '계산';
      return {
        title: `입고 일정 변경: ${p.inbound_schedule_version} (${rows.length}행)`,
        ...(fromDraft ? { actor_kind: '규칙·계산', actor_label: '시스템(승인된 발주안 반영)' } : actorOf(e, 'SCM')),
        inputs: rows.slice(0, 12).map((r, i) => ({ label: refName(r.source_ref), value: `${r.qty != null ? `${n(r.qty)} EA ` : ''}${r.eta_date} ${r.supply_status ?? r.eta_status}`, source: fromDraft ? '계산' : SRC[e.source_type] ?? '모의회신', ref: e.source_ref?.[i] ?? e.source_ref?.[0] ?? r.inbound_row_id })),
        rule: fromDraft ? '내부 승인은 지출 허용일 뿐 공급 확약이 아니다. 승인된 발주안은 발주 예정일 + 리드타임의 예상 입고로만 넣고 Corevia 확약 회신을 기다린다.'
          : p.supply_commitment_id ? 'Corevia 회신이 정상이면 가능은 확약, 부분 가능은 확약 수량과 미확약 잔량으로 나누고, 불가는 공급 불가로 둔다. 원래 발주 수량은 덮어쓰지 않는다.'
          : p.baseline_replenishment ? 'SCM이 확인한 기준 수요 보충 계획만 입고에 넣는다(Corevia 확약이면 확약, 아니면 예상). 미확인 SKU는 넣지 않는다.'
          : '회신의 확정·지연 날짜로 입고 행을 바꾼다(확약). 미회신 입고는 예상으로 두고 확약 입고만 보는 경우에서 오지 않는 것으로 둔다. 리드타임보다 이른 날짜와 수량 변경은 받지 않는다.',
        result: `${rows.slice(0, 8).map((r) => `${refName(r.source_ref)} → ${r.eta_date}(${r.supply_status ?? r.eta_status})`).join(', ')}${rows.length > 8 ? ` 외 ${rows.length - 8}행` : ''}${p.baseline_replenishment ? `. 보충 계획: ${p.baseline_replenishment.map((x) => `${x.sku_id} ${x.scm_confirmed}${x.scm_confirmed === '확인' ? `·${x.corevia_committed}` : ''}`).join(', ')}` : ''}. 이 SKU를 쓰는 기안을 다시 판정한다.`,
        next: '재고 전개·공급 판정 다시(결론이 바뀐 기안만 새 판정 버전)',
      };
    },

    SUPPLIER_REPLIED(e) {
      const p = e.payload ?? {};
      const c = p.supply_commitment;
      if (c) {
        return {
          title: `Corevia 공급 회신 · ${c.target_type} ${c.target_id} ${c.sku_id}: ${c.reply_status}${c.delay_weeks ? ` (${c.delay_weeks}주 지연)` : ''}${c.validation_status === '확인 필요' ? ' — 확인 필요' : ''}${c.reply_version > 1 ? ` (정정 v${c.reply_version})` : ''}`,
          actor_kind: '모의 입력', actor_label: c.replied_by ?? 'Corevia',
          inputs: [
            { label: '요청 수량·예상 도착', value: `${n(c.requested_qty)} EA, ${c.expected_eta_date}(발주 예정일 + 리드타임 예상)${c.needed_by_week ? `, 필요 주 ${c.needed_by_week}` : ''}`, source: '계산', ref: c.target_id },
            { label: '공급 가능 수량·도착 예정일', value: `${c.offered_qty == null ? '회신 없음' : `${n(c.offered_qty)} EA`}, ${c.offered_eta_date ?? '회신 없음'}`, source: '모의회신', ref: c.record_id },
            { label: `원료 ${c.material_id ?? ''}`, value: `${c.material_status ?? '-'}${c.material_available_date ? ` · 가용일 ${c.material_available_date}` : ''}`, source: c.material_evidence?.includes('로트 입고 기록 없음') ? '모의회신' : '원본', ref: c.material_evidence },
            { label: `생산 ${c.production_line ?? ''}`, value: `${c.production_status ?? '-'}${c.production_complete_date ? ` · 완료 예정 ${c.production_complete_date}` : ''}`, source: '모의회신', ref: c.evidence_refs?.[0] },
            { label: '남은 조건·산정 근거', value: `${c.remaining_conditions ?? '-'} / ${c.eta_basis ?? '-'}`, source: '모의회신', ref: c.record_id },
          ],
          rule: '회신 값을 검증한다(필수 값, 수량·상태 모순, 생산 완료 > 도착, 원료 가용 > 생산 완료). 모순이면 확인 필요로 입고를 바꾸지 않는다. 가능은 확약, 부분 가능은 확약 수량만, 불가는 공급 불가. 같은 회신을 다시 받아도 바뀌지 않는다.',
          result: c.validation_status === '확인 필요' ? `확인 필요: ${c.validation_issues.join('; ')}. 입고는 예상 그대로, Corevia에 확인 요청.`
            : c.reply_status === '미확인' ? '미확인 회신: 입고는 예상 그대로이고 공급 확약 대기 조건이 남는다.'
              : `${c.reply_status}: 확약 ${n(c.committed_qty)} EA${c.uncommitted_qty ? `, 미확약 잔량 ${n(c.uncommitted_qty)} EA` : ''}${c.offered_eta_date ? `, ${c.offered_eta_date} 도착` : ''}.${['불가', '부분 가능'].includes(c.reply_status) && c.target_type === '발주안' ? ' 이 발주안에 기대던 기안은 이 SKU를 더 보충 발주로 막을 수 없다.' : ''}`,
          next: c.validation_status === '확인 필요' ? 'Corevia 정정 회신 대기' : '입고 일정 새 버전 → 영향 기안 다시 판정 → 필요하면 대안 재계산·재검토',
        };
      }
      return {
        title: `Corevia 회신 · ${e.plan_id}: ${p.supply_reply_type} 공급 ${p.reply_result}`,
        ...actorOf(e, 'Corevia'),
        inputs: [
          { label: '공급 요청', value: p.supply_request_id, source: '계산', ref: p.supply_request_id },
          { label: '회신 자료', value: `${p.reply_result}${p.offered_qty ? ` ${n(p.offered_qty)} EA` : ''}${p.offered_eta_date ? ` ${p.offered_eta_date}` : ''}`, source: '모의회신', ref: (e.source_ref ?? [])[0] },
        ],
        rule: '회신이 가능·조건부면 그 시나리오 안에서 입고 행을 바꿔 다시 판정하고, 불가면 그 SKU의 조기 공급 대안을 뺀다.',
        result: p.reply_result === '불가' ? `조기 공급 불가(${p.required_checks ?? '-'}). 그 SKU의 조기 공급 대안을 빼고 대안을 다시 계산했다.` : `회신 ${p.reply_result}: ${p.required_checks ?? ''}`,
        next: '남은 대안 중 마케팅 기안 담당자가 선택',
      };
    },

    INFO_REQUESTED(e) {
      const p = e.payload ?? {};
      return {
        title: `확인 요청: ${TOPIC[p.request_topic] ?? p.request_topic}`,
        ...actorOf(e),
        inputs: (p.questions ?? []).slice(0, 5).map((x, i) => ({ label: `질문 ${i + 1}`, value: x, source: '계산', ref: p.request_id })),
        rule: '판정에 필요한데 원본에 없는 값은 담당 부서에 확인을 요청하고, 회신 전에는 가정하지 않는다.',
        result: `${DEPT[p.requested_to] ?? p.requested_to}에 요청 ${p.request_id}.`,
        next: '회신이 오면 입고 일정·판정에 반영',
      };
    },
  };

  return function describeEvent(event) {
    if (!event || event.emitted_by !== q.id) return null;
    const fn = cards[event.event_type];
    if (!fn) return null;
    try { return fn(event); } catch { return null; }
  };
}

// 대안 한 줄 요약(카드·사용자 화면 공용)
export function altBrief(a) {
  switch (a.alternative_type) {
    case '시기이동': return a.new_sale_start_week ? `${a.new_sale_start_week}부터 ${a.new_sale_weeks}주` : '가능한 시작 주 없음';
    case '물량상한': return a.new_uplift_pct != null ? `증가율 ${a.new_uplift_pct}%까지` : '';
    case '구성이동': return (a.new_override_uplift_pct ?? []).map((o) => `${o.sku_id} ${o.override_uplift_pct}%`).join(', ');
    case '보충발주': return a.po_draft_preview ? `${a.sku_id} ${n(a.po_draft_preview.order_qty)} EA` : a.sku_id ?? '';
    case '조기분할요청': return `${a.po_id} ${n(a.requested_qty)} EA`;
    case '집행일이동': return a.next_outside_date ? `집행 ${a.next_outside_date}` : '';
    default: return '';
  }
}
