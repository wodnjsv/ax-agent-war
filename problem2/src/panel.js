// 문제 2 패널: 서버 계산을 보여주고 선택·회신 입력만 받는다(판정·계산은 서버).
// 화면 지침(조정자 E): 결론을 먼저, 자료 구분 표시는 구역 제목에 한 번만(줄바꿈 없음), 긴 목록은 접어 두고, 코드는 한국어 이름으로.
const VERDICT_CLASS = { 가능: 'ok', 조건부: 'warn', 부족: 'warn', 판정불가: 'muted' };
const SCENARIO_NAME = { on_schedule: '예정대로 입고', not_arrived: '미확정 입고 제외' };
const CAUSE_NAME = {
  DEMAND_INPUT_REGISTERED: '수요 입력 등록', DEMAND_INPUT_REVISED: '수요 입력 정정', INBOUND_SCHEDULE_REVISED: '입고 일정 변경',
  BASELINE_DEMAND_SET: '기준 수요 설정', PLAN_RECEIVED: '기안 접수', REVIEW_OPENED: '재검토', APPROVAL_REPLIED: '승인 회신',
  PLAN_WITHDRAWN: '기안 철회', PLAN_CONFIRMED: '기안 확정', PLAN_AUTO_CONFIRMED_BY_DEADLINE: '기한 경과 확정', ALTERNATIVE_SELECTED: '대안 선택',
};
const STYLE = `<style>
  .p2 .tag, .p2 th, .p2 .nw { white-space: nowrap; }
  .p2 h3 { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; margin: 14px 0 6px; }
  .p2 .lead { font-size: 15px; margin: 4px 0 8px; }
  .p2 ul.cond { margin: 4px 0 8px; padding-left: 18px; }
  .p2 details { margin: 10px 0; }
  .p2 details > summary { cursor: pointer; font-weight: 600; }
  .p2 td { vertical-align: top; }
  .p2 .card2 { border: 1px solid #dde2ea; border-radius: 6px; padding: 6px 8px; margin: 6px 0; line-height: 1.5; }
</style>`;

// 입고 행 출처 코드를 업무 이름으로(describe.mjs refName과 같은 규칙)
const refName = (ref) => {
  const t = String(ref ?? '');
  let m = t.match(/^IN_TRANSIT:(SKU-\d+)$/);
  if (m) return `운송 중 물량(${m[1]})`;
  m = t.match(/^SCM-BR:(SKU-\d+):(\d+)$/);
  if (m) return `SCM 정기 보충(${m[1]} ${m[2]}회차)`;
  return t;
};
const verdictBadge = (ui, v) => `<b class="${VERDICT_CLASS[v] ?? ''}">${ui.esc(v)}</b>`;
const list = (ui, arr) => (arr?.length ? ui.esc(arr.join(', ')) : '-');
const head = (ui, title, tagHtml = '') => `<h3><span>${ui.esc(title)}</span><span class="nw">${tagHtml}</span></h3>`;

function conditionItem(ui, c) {
  const refs = (c.inbound_rows ?? []).map((r) => `${refName(r.source_ref)}(${r.eta_date})`).join(', ');
  if (c.condition_type === 'supply_commitment_pending') return `<b>공급 확약 대기</b> ${ui.esc(c.sku_id)}: 승인된 발주안 입고 ${ui.esc(refs)}는 예상일 뿐, Corevia 공급 확약 회신이 와야 함(승인만으로 풀리지 않음)`;
  if (c.condition_type === 'baseline_replenishment_unconfirmed') {
    return c.reason === '보충 계획 미확약' ? `<b>기준 수요 보충 미확약</b> ${ui.esc(c.sku_id)}: SCM 보충 입고 ${ui.esc(refs)}가 Corevia 확약 전`
      : `<b>기준 수요 보충 미확인</b> ${ui.esc(c.sku_id)}: 판매 기간 뒤 ${ui.esc(c.first_week)} 주부터 기존 수요 몫 ${ui.num(c.after_sale_shortage_ea)} EA가 모자랄 수 있음(SCM 보충 계획 회신 전)`;
  }
  if (c.condition_type === 'inbound_unconfirmed') {
    const refs = (c.inbound_rows ?? [c]).map((r) => `${refName(r.source_ref)}(${r.eta_date})`).join(', ');
    return `<b>미확정 입고</b> ${ui.esc(c.sku_id)}: ${ui.esc(refs)} 도착이 확정돼야 함`;
  }
  const pv = c.po_draft_preview;
  return `<b>보충 발주 필요</b> ${ui.esc(c.sku_id)}: ${ui.esc(c.needed_by_week)} 주까지 ${ui.num(c.uncovered_qty_ea ?? c.additional_reorder_qty_ea)} EA`
    + `${c.covered_by_approved_qty_ea ? ` <span class="muted">(필요 ${ui.num(c.additional_reorder_qty_ea)} 중 승인 발주안이 ${ui.num(c.covered_by_approved_qty_ea)} 덮음)</span>` : ''}`
    + ` · 발주 시한 <span class="${c.order_deadline_passed ? 'warn' : ''}">${ui.esc(c.order_deadline)}${c.order_deadline_passed ? ' 지남' : ''}</span>`
    + (c.po_draft_id ? ` · SKU 발주안 ${ui.esc(c.po_draft_id)}${pv ? ` ${ui.num(pv.order_qty)} EA, ${ui.esc(pv.planned_order_date)} 발주 → ${ui.esc(pv.expected_arrival_week)} 주 도착` : ''} (${ui.esc(c.po_draft_status ?? '')})` : '');
}

// ① 결론: 판정, 조건, 거절로 막힌 SKU, 판정 마감
function summarySection(ui, d) {
  const j = d.judgment?.plan;
  if (!j) return `<p class="muted">판정 전 ${d.ready ? '' : '(문제 1 연결 안 됨: 기준 수요 없음)'}</p>`;
  const blocked = j.reorder_blocked ?? [];
  const reason = {
    가능: '판매 기간의 추가 수요를 지금 재고·입고로 감당합니다.',
    조건부: '아래 조건이 채워지면 공급할 수 있습니다.',
    부족: blocked.length ? '기대던 발주안이 거절돼 보충 발주가 없습니다. 판매 기간 안의 캠페인 부족을 막을 수 없습니다.'
      : '지금 발주해도 도착 전인 구간에서 캠페인 추가분이 부족을 늘립니다.',
    판정불가: '유효한 수요 입력이 없어 판정하지 않았습니다.',
  }[j.supply_verdict] ?? '';
  return `${head(ui, '① 공급 판정', ui.tag(j.source_type, false, j.is_simulation))}
    <p class="lead">${verdictBadge(ui, j.supply_verdict)} <span class="muted">v${j.supply_judgment_version} · 판정 마감 ${ui.esc(j.judgment_due ?? d.judgment_due ?? '-')}</span><br>${ui.esc(reason)}</p>
    ${j.first_shortage_week ? `<p>첫 부족 주 <b>${ui.esc(j.first_shortage_week)}</b> · 캠페인 추가로 늘어난 부족 <b>${ui.num(j.shortage_qty_campaign_ea)} EA</b></p>` : ''}
    ${j.condition_basis?.length ? `<ul class="cond">${j.condition_basis.map((c) => `<li>${conditionItem(ui, c)}</li>`).join('')}</ul>` : ''}
    ${blocked.length ? `<p class="warn">발주안 거절로 보충이 막힌 SKU: ${blocked.map((b) => `${ui.esc(b.sku_id)}(${ui.esc(b.po_draft_id)})`).join(', ')}. 대안(시기 이동·물량 상한·구성 이동)이나 철회로 갑니다.</p>` : ''}`;
}

// ② SKU별 판정(간단히)
function skuSection(ui, d) {
  const rows = d.judgment?.skus ?? [];
  if (!rows.length) return '';
  const condText = (r) => [
    ...(r.condition_basis ?? []).map((c) => (c.condition_type === 'reorder_required' ? `보충 발주 필요${c.po_draft_id ? ` → ${c.po_draft_id}` : ''}`
      : { inbound_unconfirmed: '미확정 입고', supply_commitment_pending: '공급 확약 대기', baseline_replenishment_unconfirmed: '기준 수요 보충 미확인' }[c.condition_type] ?? c.condition_type)),
    ...(r.reorder_blocked ? [`보충 막힘(${r.reorder_blocked.po_draft_id} 거절·공급 불가)`] : []),
  ].join(', ') || '-';
  // 좁은 칸에서도 잘리지 않게 3열로 줄인다(부족 주·수량·조건을 한 칸에)
  const detail = (r) => [r.first_shortage_week ? `${r.first_shortage_week}~ 캠페인 부족 ${ui.num(r.shortage_qty_campaign_ea)} EA` : '', condText(r) === '-' ? '' : condText(r)]
    .filter(Boolean).map((x) => ui.esc(x)).join('<br>') || '-';
  return `${head(ui, '② SKU별 판정', ui.tag('계산', false, true))}${ui.table([
    { label: 'SKU', render: (r) => `<span class="nw">${ui.esc(r.sku_id)}</span>` },
    { label: '판정', render: (r) => `<span class="nw">${verdictBadge(ui, r.supply_verdict)}</span>` },
    { label: '부족 · 조건', render: detail },
  ], rows)}`;
}

// ③ SKU 발주안(이 기안이 연결된 것)
function draftSection(ui, d) {
  if (!d.po_drafts.length) return '';
  const breakdown = (p) => {
    const q = p.qty_breakdown;
    if (!q) return '-';
    const mine = q.campaign_by_plan?.find((x) => x.plan_id === d.plan_id);
    return `캠페인 추가분 <b>${ui.num(q.campaign_added_ea)}</b> + MOQ 올림분 ${ui.num(q.rounding_ea)} EA`
      + ` <span class="muted">· 캠페인 비중 ${ui.esc(q.campaign_share_pct)}%${mine ? ` · 이 기안 몫 ${ui.num(mine.qty_ea)}` : ''}</span>`;
  };
  const cm = (p) => (d.supply_commitments ?? []).find((x) => x.target_id === p.po_draft_id);
  const supply = (p) => {
    const c = cm(p);
    if (!p.approved && p.po_draft_status !== '발주') return '공급: 승인 전';
    if (!c) return '<span class="warn">공급: Corevia 회신 대기(입고는 예상)</span>';
    if (c.validation_status !== '정상') return `<span class="warn">공급: 회신 확인 필요 — ${ui.esc(c.validation_issues.join('; '))}</span>`;
    return `공급: <b>${ui.esc(c.reply_status)}</b>${c.committed_qty ? ` 확약 ${ui.num(c.committed_qty)} EA ${ui.esc(c.offered_eta_date)}` : ''}${c.uncommitted_qty && c.reply_status !== '미확인' ? ` · 미확약 ${ui.num(c.uncommitted_qty)} EA` : ''}`
      + ` <span class="muted">(원료 ${ui.esc(c.material_id ?? '')} ${ui.esc(c.material_status ?? '-')}, 생산 ${ui.esc(c.production_line ?? '')} ${ui.esc(c.production_status ?? '-')})</span>`;
  };
  const status = (p) => `${ui.esc(p.po_draft_status)}${p.approved && p.po_draft_status !== '발주' ? ' · 승인(지출 허용)' : ''}${p.orphan_status ? ` · <span class="warn">${ui.esc(p.orphan_status)}(SCM 취소·조정 확인 요청)</span>` : ''}`;
  return `${head(ui, '③ SKU 발주안', ui.tag('계산', false, true))}
    <p class="muted">발주안은 SKU 단위입니다. 수량 = 그 SKU에 걸린 캠페인 추가분 중 기존 재고·미입고·승인된 발주안으로 채워지지 않는 양. MOQ보다 작으면 MOQ로 올리고 올림분을 따로 적습니다. 기준 수요 보충은 SCM 정기 발주 소관입니다(아래 ⑤). 승인은 지출 허용이고, 공급은 Corevia 확약 회신으로만 확정됩니다.</p>
    ${d.po_drafts.map((p) => `<div class="card2">
      <div><b class="nw">${ui.esc(p.po_draft_id)} v${p.draft_version}</b> <span class="nw">${ui.esc(p.sku_id)}</span> · <b>${ui.num(p.order_qty)} EA</b> · <span class="nw">${ui.krw(p.amount_krw)}</span> · ${status(p)}</div>
      <div>${breakdown(p)}</div>
      <div>${supply(p)}</div>
      <div class="muted">발주 <span class="nw">${ui.esc(p.planned_order_date)}</span> → 도착 <span class="nw">${ui.esc(p.expected_arrival_week)} 주</span> · 지급 ${ui.esc(p.payment_due_date ?? '문제 3 산출 전')} · 연결 ${ui.esc(p.linked_plan_ids.join(', ') || '-')}</div>
    </div>`).join('')}`;
}

function altSection(ui, d) {
  const desc = (a) => {
    switch (a.alternative_type) {
      case '시기이동': return a.new_sale_start_week ? `${a.new_sale_start_week}부터 ${a.new_sale_weeks}주` : '가능한 시작 주 없음';
      case '물량상한': return a.new_uplift_pct != null ? `증가율 ${a.new_uplift_pct}%까지` : '-';
      case '구성이동': return `${(a.new_override_uplift_pct ?? []).map((o) => `${o.sku_id} ${o.override_uplift_pct}%`).join(', ')} · 미배치 ${a.unplaced_ea ?? 0} EA`;
      case '보충발주': { const p = a.po_draft_preview; return p ? `${a.sku_id} ${p.po_draft_id ? `발주안 ${p.po_draft_id}에 연결 · ` : ''}${p.order_qty.toLocaleString('ko-KR')} EA · ${p.amount_krw.toLocaleString('ko-KR')}원` : '-'; }
      case '조기분할요청': return `${a.po_id} ${a.requested_qty.toLocaleString('ko-KR')} EA를 ${a.needed_week} 주까지`;
      case '집행일이동': return `집행 예정일 → ${a.next_outside_date ?? '-'}`;
      default: return '';
    }
  };
  const chosen = new Set(d.selections.map((s) => s.alternative_id));
  const feasible = d.alternatives.filter((a) => a.feasible || chosen.has(a.alternative_id));
  const infeasible = d.alternatives.filter((a) => !feasible.includes(a));
  const cols = (withBtn) => [
    { label: '대안', render: (a) => `<span class="nw">${ui.esc(a.alternative_type)}</span>` },
    { label: '내용', render: (a) => ui.esc(desc(a)) },
    { label: '남은 확인', render: (a) => `<span class="muted">${ui.esc(a.remaining_checks)}</span>` },
    ...(withBtn ? [{ label: '', render: (a) => (chosen.has(a.alternative_id) ? '선택됨' : `<button data-alt="${ui.esc(a.alternative_id)}" data-type="${ui.esc(a.alternative_type)}">선택</button>`) }] : []),
  ];
  if (!d.alternatives.length && !d.plan_changes.length && !d.supply_requests.length) return '';
  return `${head(ui, '④ 대안', ui.tag('계산', false, true))}
    ${ui.table(cols(true), feasible, { empty: '실행 가능한 대안 없음' })}
    ${infeasible.length ? `<details><summary>실행 불가 대안 ${infeasible.length}건</summary>${ui.table(cols(false), infeasible)}</details>` : ''}
    ${d.plan_changes.length ? `<p>기안 계획 변경: ${d.plan_changes.map((c) => `v${c.plan_version} 집행 ${ui.esc(c.settlement_date)}`).join(', ')}</p>` : ''}
    ${d.supply_requests.length ? `<p>공급 요청 <span class="nw">${ui.tag('모의회신', true)}</span>: ${d.supply_requests.map((q) => `${ui.esc(q.sku_id)} ${ui.esc(q.supply_request_status)}${q.reply_result ? `(${ui.esc(q.reply_result)})` : ''}`).join(', ')}</p>` : ''}`;
}

// ⑤ 기준 수요 정기 보충 가정(S2-BLC): 범위 밖 배경 제약(SCM 정기 발주 소관). 수량·금액은 만들지 않는다
function baselineSection(ui, d) {
  const rows = d.baseline_replenishment ?? [];
  if (!rows.length) return '';
  return `${head(ui, '⑤ 기준 수요 보충 계획(SCM 회신)', ui.tag('모의회신', true))}
    <p class="muted">SCM이 확인한 보충 계획만 재고 전개에 넣습니다(Corevia 확약이면 확약, 아니면 예상). 회신이 없거나 미확인이면 판매 기간 뒤 부족이 조건으로 남고, 날짜가 지나도 저절로 풀리지 않습니다.
      <b>SCM 정기 발주의 금액·지급일은 자료에 없어 문제 3 현금 재전망에 들어가지 않습니다(한계).</b></p>
    ${ui.table([
      { label: 'SKU', render: (r) => `<span class="nw">${ui.esc(r.sku_id)}</span>` },
      { label: '상태', render: (r) => (r.plan_status === 'SCM 확인·Corevia 확약' ? ui.esc(r.plan_status) : `<span class="warn">${ui.esc(r.plan_status)}</span>`) },
      { label: '계획 입고', render: (r) => (r.plan_rows.length ? `${r.plan_rows.length}회 ${ui.num(r.plan_qty_total)} EA<br><span class="muted">첫 도착 ${ui.esc(r.plan_rows[0].eta_date)}</span>` : '-') },
      { label: '기준 수요 품절(확약 입고만)', render: (r) => (r.base_stockout_weeks_committed.length ? `${ui.esc(r.base_stockout_weeks_committed[0])}~ ${r.base_stockout_weeks_committed.length}주` : '없음') },
    ], rows)}`;
}

// 기다리는 회신과 다음 조치(기안 담당자용)
function waitingSection(ui, dec) {
  if (!dec?.verdict) return '';
  const w = dec.waiting_replies ?? [];
  return `${head(ui, '기다리는 회신 · 다음 조치', ui.tag('계산', false, true))}
    ${w.length ? ui.table([
      { label: '누구', render: (x) => `<span class="nw">${ui.esc(x.from)}</span>` },
      { label: '무엇', render: (x) => ui.esc(x.what) },
      { label: '상태', render: (x) => ui.esc(x.status) },
      { label: '예정', render: (x) => `<span class="nw">${ui.esc(x.expected_by ?? '-')}</span>` },
    ], w) : '<p class="muted">기다리는 회신 없음</p>'}
    <ul class="cond">${(dec.next_actions ?? []).map((x) => `<li>${ui.esc(x)}</li>`).join('')}</ul>
    ${(() => { const r = (dec.alternatives ?? []).find((a) => a.recommended); return r ? `<p><b>권장 대안: ${ui.esc(r.title)}</b> ${ui.esc(r.what_changes ?? '')} → 예상 ${ui.esc(r.expected_verdict ?? '-')}<br><span class="muted">${ui.esc(r.recommend_reason ?? '')}</span></p>` : ''; })()}`;
}

// 접힌 구역: 판정 근거
function basisSection(ui, d) {
  const j = d.judgment?.plan;
  if (!j) return '';
  const di = d.demand_input;
  const bos = (sku) => d.base_only_shortfall.find((b) => b.sku_id === sku && b.inbound_scenario === 'on_schedule') ?? {};
  const rows = d.skus.map((k) => ({ ...k, bos: bos(k.sku_id) }));
  return `<details><summary>판정 근거(수요 입력·전제·SKU별 재고)</summary>
    <dl class="kv">
      <dt>수요 입력</dt><dd>${di ? `${ui.esc(di.uplift_pct)}% · ${ui.esc(di.sale_start_week)}부터 ${ui.esc(di.sale_weeks)}주 (v${ui.esc(di.version)}) <span class="nw">${ui.tag(di.source_type, di.is_synthetic)}</span>` : '<span class="muted">유효 수요 입력 없음</span>'}</dd>
      <dt>방향 판단</dt><dd>${ui.esc(j.direction_note)}</dd>
      <dt>안전재고 경고</dt><dd>${j.stock_warning ? `<span class="warn">4주 미달 ${list(ui, j.safety_breach_weeks)}</span>` : '없음'} <span class="muted">(판정에 쓰지 않음)</span></dd>
      <dt>전제</dt><dd class="muted">${ui.esc(Object.entries(j.premise_refs).map(([k, v]) => `${k}=${v ?? '-'}`).join(' · '))}</dd>
    </dl>
    ${ui.table([
      { label: 'SKU', render: (r) => `<span class="nw">${ui.esc(r.sku_id)}</span><br><span class="muted">${ui.esc(r.sku_name)}</span>` },
      { label: '기준 수요/주', render: (r) => ui.num(r.baseline_weekly_qty) },
      { label: '현재고 · 운송 중', render: (r) => `${ui.num(r.on_hand_qty)} · ${ui.num(r.in_transit_qty)}` },
      { label: '막을 수 없는 구간', render: (r) => `<span class="nw">~${ui.esc(r.bos.unpreventable_end_week ?? '-')}</span><br><span class="muted nw">보충 가능 ${ui.esc(r.bos.reorder_reach_week ?? '전개 끝 뒤')}~</span>` },
      { label: '기존 수요 품절(막을 수 없음)', render: (r) => (r.bos.unpreventable_stockout_weeks?.length
        ? `<span class="warn">${ui.esc(r.bos.unpreventable_stockout_weeks[0])}~ ${r.bos.unpreventable_stockout_weeks.length}주, ${ui.num(r.bos.unpreventable_shortfall_ea)} EA</span>` : '없음') },
    ], rows)}
    <p class="muted">기준 수요는 계산, 현재고·운송 중은 원본입니다. 판정 기준: 지금 발주해도 도착 전인 구간(발주 예정일 + 리드타임 이전)의 부족만 '부족', 그 뒤 구간의 부족은 '조건부(보충 발주 필요)'. 발주안이 거절된 SKU는 판매 기간 끝까지를 막을 수 없는 구간으로 봅니다.</p>
  </details>`;
}

// 접힌 구역: 주차별 잔여 여지
function roomSection(ui, d) {
  const weeks = d.grid.weeks.filter((w) => w <= d.grid.horizon_end_week);
  const skus = [...new Set(d.residual_headroom.map((r) => r.sku_id))];
  if (!skus.length) return '';
  const cellOf = (sku, w, sc) => d.residual_headroom.find((r) => r.sku_id === sku && r.week_start === w && r.inbound_scenario === sc);
  const rows = skus.flatMap((sku) => ['on_schedule', 'not_arrived'].map((sc) => ({ sku, sc })));
  const show = (c) => {
    if (!c) return '-';
    if (c.supply_window === 'reorder') return '<span class="muted" title="보충 발주로 막을 수 있는 구간">보충</span>';
    return c.residual_headroom_qty > 0 ? ui.num(c.residual_headroom_qty) : '<span class="warn">0</span>';
  };
  return `<details><summary>주차별 잔여 여지(EA) <span class="nw">${ui.tag('계산', false, true)}</span></summary>
    <p class="muted">숫자 = 지금 발주해도 막을 수 없는 구간에서 더 받을 수 있는 양(앞 순번 기안 반영). 보충 = 보충 발주로 막을 수 있는 구간. 입고 일정 ${ui.esc(d.inbound.inbound_schedule_version)}, ${ui.esc(d.grid.horizon_end_week)} 주까지.</p>
    ${ui.table([
      { label: 'SKU · 입고 가정', render: (r) => `<span class="nw">${ui.esc(r.sku)}</span><br><span class="muted nw">${ui.esc(SCENARIO_NAME[r.sc])}</span>` },
      ...weeks.map((w) => ({ label: w.slice(5), render: (r) => show(cellOf(r.sku, w, r.sc)) })),
    ], rows)}
  </details>`;
}

// 접힌 구역: 판정 버전 이력(결론이 바뀐 버전만 먼저)
function historySection(ui, d) {
  const all = d.judgment_history ?? [];
  if (all.length < 2) return '';
  const changed = all.filter((h) => h.conclusion_changed).reverse();
  const cols = [
    { label: '버전', render: (h) => `v${h.supply_judgment_version}` },
    { label: '날짜', render: (h) => `<span class="nw">${ui.esc(h.occurred_at ?? '-')}</span>` },
    { label: '판정', render: (h) => verdictBadge(ui, h.supply_verdict) },
    { label: '조건·막힌 SKU', render: (h) => ui.esc([...h.conditions, ...h.reorder_blocked.map((s) => `보충 막힘 ${s}`)].join(', ') || '-') },
    { label: '계기', render: (h) => `<span class="muted">${ui.esc(CAUSE_NAME[h.cause_event_type] ?? h.generation_reason ?? '-')}</span>` },
  ];
  return `<details><summary>판정 버전 이력: 결론이 바뀐 ${changed.length}건 / 전체 ${all.length}건</summary>
    ${ui.table(cols, changed)}
    ${all.length > changed.length ? `<details><summary>전체 ${all.length}건 보기</summary>${ui.table(cols, [...all].reverse())}</details>` : ''}
  </details>`;
}

export default {
  async renderPlan(el, { plan, api, ui }) {
    const d = await api.get(`/api/p2/plan/${encodeURIComponent(plan.plan_id)}`);
    const dec = await api.get(`/api/p2/plan/${encodeURIComponent(plan.plan_id)}/decision`).catch(() => null);
    const links = Object.entries(d.links).filter(([, v]) => !v).map(([k]) => k);
    d.plan_id = plan.plan_id;
    el.innerHTML = `${STYLE}<div class="p2">${links.length ? `<p class="warn">연결 안 됨: ${links.join(', ')}</p>` : ''}
      ${summarySection(ui, d)}${waitingSection(ui, dec)}${skuSection(ui, d)}${draftSection(ui, d)}${altSection(ui, d)}${baselineSection(ui, d)}
      ${basisSection(ui, d)}${roomSection(ui, d)}${historySection(ui, d)}<p class="msg muted"></p></div>`;
    const msg = el.querySelector('.msg');
    el.querySelectorAll('button[data-alt]').forEach((b) => {
      b.onclick = async () => {
        const scm = ['보충발주', '조기분할요청'].includes(b.dataset.type);
        try {
          await api.post(`/api/p2/alternatives/${encodeURIComponent(b.dataset.alt)}/select`, { selected_by: scm ? 'SCM-PLANNER' : 'MKT-LINE-OWNER' });
          await this.renderPlan(el, { plan, api, ui });
        } catch (err) { msg.textContent = `오류: ${err.message}`; }
      };
    });
  },

  async renderMock(el, { api, ui }) {
    const d = await api.get('/api/p2/mock');
    const groups = [...new Set(d.inbound_replies.map((r) => r.data_version))].map((v) => ({ v, rows: d.inbound_replies.filter((r) => r.data_version === v) }));
    const versions = d.inbound_versions.map((v) => `${ui.esc(v.inbound_schedule_version)}(${ui.esc(v.reason)})`);
    el.innerHTML = `${STYLE}<div class="p2"><p class="muted">문제 4 사건 순서표가 날짜에 맞춰 전달합니다. 여기서는 직접 적용할 수 있습니다(같은 행은 한 번만).</p>
      ${head(ui, 'Corevia 공급 회신(기발주·발주안)', ui.tag('모의회신', true))}
      ${ui.table([
        { label: '회신', render: (x) => `<span class="nw">${ui.esc(x.record_id)}</span>` },
        { label: '대상', render: (x) => ui.esc(x.po_draft_id ?? x.record_id.replace(/^S2-CVC-|-\d+$/g, '')) },
        { label: '결과', render: (x) => ui.esc(x.reply_status ?? '-') },
        { label: '도착일', render: (x) => `<span class="nw">${ui.esc(x.due_date)}</span>` },
        { label: '상태', render: (x) => (x.applied ? '반영됨' : '<span class="muted">도착 전</span>') },
      ], d.supply_replies_corevia ?? [], { empty: '받을 회신 없음' })}
      ${head(ui, '운송 중 입고 회신', ui.tag('모의회신', true))}
      ${ui.table([
        { label: '회신 묶음', render: (g) => `${g.v} (${g.rows.length}행)` },
        { label: '도착일', render: (g) => `<span class="nw">${ui.esc(g.rows[0]?.occurred_at)}</span>` },
        { label: '', render: (g) => (g.rows.every((r) => r.applied) ? '적용됨' : `<button data-v="${g.v}">적용</button>`) },
      ], groups)}
      ${head(ui, '대안 선택 모의 입력', ui.tag('사람입력', true))}
      ${ui.table([
        { label: '기안 · 대안', render: (s) => `${ui.esc(s.plan_id)} ${ui.esc(s.alternative_type)}` },
        { label: '날짜', render: (s) => `<span class="nw">${ui.esc(s.occurred_at)}</span>` },
        { label: '상태', render: (s) => (s.applied ? '적용됨' : '<span class="muted">문제 4 순서표가 전달</span>') },
      ], d.selections)}
      <details><summary>입고 일정 버전 ${versions.length}개</summary><p>${versions.join(' → ')}</p></details>
      <p class="msg muted"></p></div>`;
    const msg = el.querySelector('.msg');
    el.querySelectorAll('button[data-v]').forEach((b) => {
      b.onclick = async () => {
        try { const r = await api.post('/api/p2/inbound/apply', { data_version: b.dataset.v }); msg.textContent = `${r.inbound_schedule_version} 반영`; await this.renderMock(el, { api, ui }); }
        catch (err) { msg.textContent = `오류: ${err.message}`; }
      };
    });
  },
};
