// 문제 3 패널: 서버 계산(/api/p3/...)을 보여주고 상신·초안 확인·모의 재무 회신 입력만 받는다.
// 화면 지침(조정자 (E)): 맨 위 한 줄 요약 → 전체 폭 구역. 자료 구분 표시는 구역 제목에 한 번(줄바꿈 없이),
// 긴 목록은 접고 최신·결론이 바뀐 것만 먼저 보인다. 코드(GRP_CEO 등)는 한국어 이름으로 보인다.
const eok = (n) => (n == null ? '-' : `${(n / 1e8).toFixed(2)}억`);
const md = (s) => (s ? String(s).slice(5) : '-'); // 2026-07-21 → 07-21
const nowrap = (html) => `<span style="white-space:nowrap">${html}</span>`;

function section(ui, title, tags, inner) {
  return `<section style="border-top:1px solid var(--line);margin-top:10px;padding-top:8px">
    <h3 style="font-size:14px;margin:0 0 6px">${ui.esc(title)} ${nowrap(tags)}</h3>${inner}</section>`;
}
const fold = (ui, label, inner) => `<details><summary class="muted" style="cursor:pointer">${ui.esc(label)}</summary>${inner}</details>`;
// 하회 구간: 조각이 여럿이면 조각마다 시작~끝(영업일)·최저 잔액을 보인다. 끝이 재전망 마지막 날이면 그 뒤 회복일은 확인 불가
const segText = (s) => `${md(s.start)}~${md(s.end)}${s.end_at_horizon ? '+' : ''} (${s.bd_count}영업일${s.min_balance_krw != null ? `, 최저 ${eok(s.min_balance_krw)} ${md(s.min_date)}` : ''})`;
const span = (ui, x) => {
  if (!x?.shortfall_window_start) return '없음';
  const segs = x.segments ?? [];
  if (segs.length <= 1) return nowrap(`${md(x.shortfall_window_start)}~${md(x.shortfall_window_end)}${segs[0]?.end_at_horizon ? '+' : ''} (${x.shortfall_bd_count ?? segs[0]?.bd_count ?? '-'}영업일)`);
  return `<b>${segs.length}조각</b> ${segs.map((s) => nowrap(`${s.segment_no}) ${segText(s)}`)).join('<br>')}`;
};
const HORIZON_NOTE = '<span class="muted">+ = 재전망 마지막 날(09-30)까지 하회, 그 뒤 회복일은 재전망 밖이라 확인 불가</span>';
const minText = (ui, x) => (x ? nowrap(`<b>${eok(x.min_balance_krw)}</b> <span class="muted">${md(x.min_date)}</span>`) : '-');

export default {
  async renderPlan(el, { plan, api, ui }) {
    const d = await api.get(`/api/p3/plan/${encodeURIComponent(plan.plan_id)}`);
    if (!d.commitment) { el.innerHTML = '<p class="muted">이 기안의 약정이 아직 없습니다(기안 접수 사건 대기)</p>'; return; }
    const c = d.commitment;
    const w = d.cash_window;
    const L = d.labels;
    const name = (code) => ui.esc(L.approver[code] ?? code ?? '-');
    const label = (group, code) => ui.esc(L[group]?.[code] ?? code ?? '-');
    const latest = d.history.at(-1) ?? {};
    const row = d.package.rows[0] ?? {};
    const ds = row.deadline_schedule;
    const ci = row.cash_impact;
    const share = row.campaign_share;

    // 한 줄 요약: 승인권자 · 상태 · 다음 마감 · 유출일 구간 안팎
    const summary = `<p class="row" style="margin:0 0 4px">
      ${nowrap(`승인권자 <b>${name(c.approver)}</b>`)} · ${nowrap(`상태 <b>${ui.esc(c.approval_status)}</b>`)}
      · ${nowrap(ds ? `상신 마감 <b>${md(ds.submission_due)}</b> · 최종 회신 ${md(ds.final_reply_due)}` : '<span class="muted">마감: 연결 안 됨</span>')}
      · ${nowrap(`유출일 ${md(c.cash_outflow_date)} ${latest.in_window ? '<b class="warn">하회 구간 안</b>' : '구간 밖'}`)}</p>`;

    // 1. 승인 경로
    const changedOnly = [...d.history].reverse();
    const route = section(ui, '승인 경로 판정', ui.tag('계산', false, c.is_simulation), `
      <dl class="kv">
        <dt>승인권자</dt><dd><b>${name(c.approver)}</b>${c.group_report_required ? ' · 그룹 보고' : ''}</dd>
        <dt>근거</dt><dd>${label('route', c.route_rule_id)}</dd>
        <dt>현금 유출일</dt><dd>${ui.esc(c.cash_outflow_date)} (${latest.in_window ? '하회 구간 안' : '구간 밖'})</dd>
        <dt>판정 근거</dt><dd>${latest.matched_segment
          ? `${latest.matched_segment.basis === 'scenario_with_own_outflow' ? '이 발주안 유출을 더한 시나리오 재전망' : '현행 재전망'}의 하회 조각 ${latest.matched_segment.segment_no}/${latest.matched_segment.segment_count}: ${nowrap(segText(latest.matched_segment))}`
          : latest.scenario_window ? `이 발주안 유출을 더한 시나리오 재전망의 모든 조각 밖: ${span(ui, latest.scenario_window)}` : '현행 재전망의 모든 조각 밖'}
          ${latest.scenario_window?.segments?.length > 1 && latest.matched_segment ? `<br><span class="muted">시나리오 조각: ${span(ui, latest.scenario_window)}</span>` : ''}</dd>
        <dt>승인 기준일</dt><dd>${ui.esc(c.approval_anchor_date)} (${label('anchor_basis', c.anchor_basis)})</dd>
        <dt>요청액</dt><dd>${ui.krw(c.amount_krw)}${c.amount_scale === 'sample' ? ' <span class="muted">표본 스케일, 현금과 합산 안 함</span>' : ''}</dd>
        <dt>기안 묶음</dt><dd>${ui.esc(c.plan_bundle_id ?? '-')} 총액 ${ui.krw(d.detail.bundle_total_krw)} <span class="muted">(가정, 원 기안 기준 유지)</span></dd>
      </dl>
      ${fold(ui, `판정 이력 ${d.history.length}건 · 결론이 바뀐 때만 기록 · 최신: ${latest.rationale ?? '-'}`, ui.table([
        { label: '판정일', render: (h) => nowrap(ui.esc(h.judged_on)) },
        { label: '승인권자', render: (h) => `${name(h.approver)}${h.route_changed ? ' <b class="warn">변경</b>' : ''}${h.already_confirmed ? ' <span class="warn">이미 확정</span>' : ''}` },
        { label: '구간', render: (h) => `${h.in_window ? '안' : '밖'} <span class="muted">${ui.esc(h.window_version)}</span>` },
        { label: '사유', render: (h) => ui.esc(h.rationale) },
      ], changedOnly))}`);

    // 2. 현금 영향: 현재 / 관련 발주안 모두 승인 가정
    const adds = ci?.added_outflows.length ?? 0;
    const cash = section(ui, '현금 영향 (정책 방식 재전망)', ui.tag('계산', false, true), ci ? `
      <dl class="kv">
        <dt>현재</dt><dd>${span(ui, ci.before)} · 최저 ${minText(ui, ci.before)}<br><span class="muted">승인된 발주안 반영</span></dd>
        <dt>승인 시</dt><dd>${adds ? `${span(ui, ci.after)} · 최저 ${minText(ui, ci.after)}<br><span class="muted">미승인 발주안 ${adds}건(${eok(ci.added_outflows.reduce((s, x) => s + x.amount_krw, 0))}) 승인 가정</span>` : '<span class="muted">더할 현금 유출 없음(현재와 같음)</span>'}</dd>
      </dl>
      ${ci.before.min_balance_krw < 0 ? '<p class="warn">현재 재전망 최저 잔액이 이미 0원 미만입니다.</p>' : ''}
      ${adds && ci.after_below_zero ? '<p class="warn">승인 후 최저 잔액이 0원 미만: 모의 승인 규칙(가정)상 거절 대상. Masil 단독 기준 지급 재원 없음(그룹 지원은 판정에 넣지 않음).</p>' : ''}
      <p>${share.po_draft_count ? `관련 발주안 ${share.po_draft_count}건 발주액 ${eok(share.amount_krw)} 중 캠페인 추가분 <b>${share.campaign_share_pct == null ? '수량 내역 없음' : `${eok(share.campaign_amount_krw)} (${share.campaign_share_pct}%)`}</b>${share.missing_breakdown_count && share.campaign_share_pct != null ? ` <span class="muted">내역 없는 ${share.missing_breakdown_count}건 제외</span>` : ''}` : '<span class="muted">관련 발주안 없음</span>'}</p>
      ${[ci.before, ci.after].some((x) => x.segments?.some((g) => g.end_at_horizon)) ? `<p>${HORIZON_NOTE}</p>` : ''}
      <p class="muted">재전망 한계: ${(row.cash_limitations ?? []).map((t) => ui.esc(t)).join(' ')}</p>
      ${row.scm_sensitivity?.confirmed_row_count ? `<dl class="kv">
        <dt>정기 보충 발주 포함 시 <span class="muted">(민감도)</span></dt><dd>${span(ui, row.scm_sensitivity.with_scm_replenishment)} · 최저 ${minText(ui, row.scm_sensitivity.with_scm_replenishment)}
          <br><span class="muted">SCM 확인 보충 발주 ${row.scm_sensitivity.confirmed_row_count}건 중 재전망 기간 지급 ${row.scm_sensitivity.in_horizon_row_count}건 ${eok(row.scm_sensitivity.in_horizon_amount_krw)}. 금액은 원본 발주 단가로 도출, 수량·발주일은 SCM 모의 회신. ${ui.esc(row.scm_sensitivity.why_not_in_baseline)}</span>
          ${row.scm_sensitivity.route_difference ? `<br><b class="warn">${ui.esc(row.scm_sensitivity.route_difference.label)}</b>` : ''}</dd>
      </dl>` : ''}
      <p class="muted">구간 버전 ${ui.esc(w?.window_version)} · ${label('window_basis', w?.window_basis)} · ${label('scenario', w?.scenario_id)} · 재무 확인 ${ui.esc(c.finance_confirmation_status)} · 기준 ${eok(w?.threshold)}. 07-01 만기 미수금 2건 제외가 기본. 재무팀 공식 전망은 판정에 쓰지 않는다.</p>`
      : '<p class="muted">구간 없음</p>');

    // 3. 발주안 조건: 발주 시한, 승인 시 최저 잔액, 캠페인 추가분
    const pdc = row.po_draft_conditions ?? [];
    // 좁은 칸에서도 깨지지 않게 열은 셋으로 둔다
    const pdTable = (rows) => ui.table([
      { label: '발주안·발주 시한', render: (x) => `${nowrap(ui.esc(x.po_draft_id))} <span class="muted">${ui.esc(x.sku_id ?? '')}${x.linked_plan_ids?.length > 1 ? ` · 기안 ${x.linked_plan_ids.length}건 공유` : ''}</span><br>시한 ${nowrap(`<b>${md(x.order_deadline)}</b>`)}${x.order_deadline_basis === 'planned_order_date' ? ' <span class="muted">(발주 예정일)</span>' : ''}` },
      { label: '지급·내부 승인', render: (x) => `${nowrap(`지급 ${md(x.payment_due_date)}`)}<br>${nowrap(name(x.approver))}${x.matched_segment ? `<br><span class="muted">${nowrap(`조각 ${x.matched_segment.segment_no}/${x.matched_segment.segment_count} ${md(x.matched_segment.start)}~${md(x.matched_segment.end)}`)}</span>` : ''}<br>${ui.esc(x.internal_approval_label ?? x.approval_status)}${x.residual_after_withdrawal ? `<br><span class="warn">기안 철회 뒤 남은 발주(발주 전달됨, 유출 유지, SCM 확인 대상)</span>` : ''}` },
      // 내부 승인(구매·지출 허용)과 따로: Corevia 공급 확약(수량·납기 약속)
      { label: 'Corevia 공급 확약', render: (x) => {
        const sc = x.supply_commitment;
        if (!sc) return '-';
        const warn = ['확인 대기', '확인 필요', '공급 불가', '부분 확약'].includes(sc.supply_commitment_status);
        return `<b${warn ? ' class="warn"' : ''}>${ui.esc(sc.supply_commitment_status)}</b><br><span class="muted">${ui.esc(sc.label)}</span>${sc.remaining_conditions ? `<br><span class="muted">남은 조건: ${ui.esc(sc.remaining_conditions)}</span>` : ''}${sc.waiting_on ? `<br><span class="muted">기다리는 회신: ${ui.esc(sc.waiting_on)}</span>` : ''}`;
      } },
      { label: '최저 잔액', render: (x) => {
        const imp = x.cash_impact;
        const after = imp ? `<b${imp.after_below_zero ? ' class="warn"' : ''}>${eok(imp.after.min_balance_krw)}</b>` : '-';
        const moved = imp && imp.after.min_balance_krw !== imp.before.min_balance_krw;
        return `${moved ? `${nowrap(after)}<br><span class="muted">${nowrap(`현재 ${eok(imp.before.min_balance_krw)}`)}</span>` : `${nowrap(after)}<br><span class="muted">반영됨</span>`}`;
      } },
      // 발주 수량 = 캠페인 추가분 + MOQ·올림분(문제 2 qty_breakdown). 기준 수요 보충분은 발주안 밖(SCM 정기 발주)
      { label: '수량 내역', render: (x) => {
        const s = x.campaign_share;
        if (!s?.provided) return '<span class="muted">내역 없음</span>';
        const n = (v) => ui.num(Math.round(Number(v ?? 0)));
        return `${nowrap(`발주 ${n(s.order_qty)}EA`)}<br>${nowrap(`캠페인 ${n(s.campaign_added_ea)} (${s.campaign_share_pct}%)`)}<br><span class="muted">${nowrap(`MOQ·올림 ${n(s.rounding_ea)}`)}</span>${Number(s.baseline_demand_ea) > 0 ? `<br><span class="warn">${nowrap(`기준 수요분 ${n(s.baseline_demand_ea)}`)}</span>` : ''}`;
      } },
    ], rows);
    const drafts = pdc.length ? section(ui, `발주안 조건 ${pdc.length}건`, ui.tag('계산', false, true), `
      ${pdTable(pdc.slice(0, 3))}${pdc.length > 3 ? fold(ui, `나머지 ${pdc.length - 3}건`, pdTable(pdc.slice(3))) : ''}
      <p class="muted">발주 시한까지 발주해야 보충 발주 조건을 지킬 수 있다(문제 2 값).</p>`) : '';

    // 4. 승인 상태·상신
    const state = section(ui, '승인 상태·상신', ui.tag('사람입력', true), `
      <dl class="kv">
        <dt>승인 상태</dt><dd><b>${ui.esc(c.approval_status)}</b></dd>
        <dt>조건</dt><dd>${c.conditions?.length ? ui.esc(c.conditions.map((x) => x.text ?? L.condition_type[x.condition_type] ?? x.condition_type).join(' / ')) : '-'}</dd>
        ${c.supply_risk_acceptance?.accepted ? `<dt>공급 위험 수용</dt><dd>${name(c.supply_risk_acceptance.approver)}이 미확인 공급 조건을 받아들임(${ui.esc(c.supply_risk_acceptance.replied_at)}) <span class="muted">공급 확약 아님, 공급 상태는 그대로</span></dd>` : ''}
        <dt>상신 마감</dt><dd>${ds ? `${ui.esc(ds.submission_due)} · 최종 회신 ${ui.esc(ds.final_reply_due)}` : '<span class="muted">연결 안 됨</span>'}</dd>
        <dt>기안 상태</dt><dd>${ui.esc(d.detail.plan_status ?? (d.connections.p4 ? '-' : '연결 안 됨'))}</dd>
      </dl>
      ${d.requests.length ? fold(ui, `상신 기록 ${d.requests.length}건 · 최신 ${d.requests.at(-1).approval_request_id}`, ui.table([
        { key: 'approval_request_id', label: '상신' },
        { label: '승인권자', render: (r) => name(r.approver) },
        { label: '약정', render: (r) => ui.esc(r.commitment_ids.join(', ')) },
        { label: '상태', render: (r) => (r.superseded ? '<span class="muted">대체됨</span>' : r.superseded_commitment_ids?.length ? `유효(대체된 건: ${ui.esc(r.superseded_commitment_ids.join(', '))})` : '유효') },
      ], [...d.requests].reverse())) : '<p class="muted">상신 없음</p>'}
      ${c.approval_status === '미상신' ? '<div class="row"><button data-act="submit">상신(시연 입력)</button></div>' : ''}`);

    // 5. 상신 문서
    const sj = row.supply_judgment;
    const doc = section(ui, '상신 문서', ui.tag('계산', false, Boolean(sj?.is_simulation)), `
      <dl class="kv">
        <dt>공급 판정</dt><dd>${sj ? ui.esc(sj.supply_verdict) : (row.supply_connected ? '없음' : '<span class="muted">연결 안 됨</span>')}</dd>
        <dt>조건 종류</dt><dd>${(row.condition_types ?? []).length ? row.condition_types.map((t) => label('condition_type', t)).join(', ') : '-'}</dd>
        <dt>미확인 공급 조건</dt><dd>${(row.unconfirmed_supply_conditions ?? []).length ? row.unconfirmed_supply_conditions.map((x) => ui.esc(x.text)).join('<br>') + '<br><span class="muted">승인으로 풀리지 않고 Corevia·SCM 회신으로만 풀린다</span>' : '-'}</dd>
        <dt>수요 입력</dt><dd>${row.demand_status_by_plan ? ui.esc(row.demand_status_by_plan.demand_status) : (row.demand_connected ? '없음' : '<span class="muted">연결 안 됨</span>')}</dd>
        <dt>실질 공헌이익</dt><dd>미산정 <span class="warn">예상 GMV는 승인 근거 아님</span></dd>
      </dl>
      <div class="row"><button data-act="draft">초안 만들기</button><span class="muted">AI 미연결이면 양식 문장</span></div>
      ${d.drafts.slice(0, 1).map((x) => draftCard(ui, x)).join('')}
      ${d.drafts.length > 1 ? fold(ui, `이전 초안 ${d.drafts.length - 1}건`, d.drafts.slice(1).map((x) => draftCard(ui, x)).join('')) : ''}
      <p id="p3msg" class="muted"></p>`);

    el.innerHTML = summary + route + cash + drafts + state + doc;
    const msg = el.querySelector('#p3msg');
    const rerender = () => this.renderPlan(el, { plan, api, ui });
    el.querySelectorAll('button[data-act]').forEach((btn) => {
      btn.onclick = async () => {
        try {
          if (btn.dataset.act === 'submit') await api.post('/api/p3/submit', { commitment_id: c.commitment_id });
          if (btn.dataset.act === 'draft') await api.post('/api/p3/draft', { commitment_id: c.commitment_id });
          if (btn.dataset.act === 'review') await api.post(`/api/p3/draft/${encodeURIComponent(btn.dataset.id)}/review`, { review_result: btn.dataset.r });
          await rerender();
        } catch (err) { if (msg) msg.textContent = `오류: ${err.message}`; }
      };
    });
  },

  async renderMock(el, { api, ui }) {
    const [{ windows, labels: L }, attrs] = await Promise.all([api.get('/api/p3/windows'), api.get('/api/p3/attributes')]);
    const applied = new Set(attrs.applied_finance_replies.map((r) => r.finance_reply_id));
    const replies = [...new Map(attrs.finance_reply.map((r) => [r.finance_reply_id, r])).values()];
    const label = (group, code) => ui.esc(L[group]?.[code] ?? code ?? '-');
    const winTable = (rows) => ui.table([
      { label: '버전', render: (w) => ui.esc(w.window_version) },
      { label: '하회 구간', render: (w) => span(ui, w) },
      { label: '최저 잔액', render: (w) => minText(ui, w) },
      { label: '기준', render: (w) => `${label('window_basis', w.window_basis)} · ${label('scenario', w.scenario_id)}${w.mismatch ? ` <span class="warn">${ui.esc(w.mismatch)}</span>` : ''}` },
    ], rows);
    const recent = [...windows].reverse();
    el.innerHTML = `
      ${section(ui, '재무 회신(가상 입력)', ui.tag('모의회신', true), `
        <p class="muted">도착일은 문제 4 사건 순서표를 따른다(07-07 기본 확인, 07-10 회수일 지연).</p>
        ${ui.table([
          { key: 'finance_reply_id', label: '회신' },
          { label: '시나리오', render: (r) => label('scenario', r.scenario_id) },
          { label: '도착일', render: (r) => nowrap(ui.esc(r.occurred_at)) },
          { label: '내용', render: (r) => `${ui.esc(r.ar_id)} 회수 예정 ${nowrap(ui.esc(r.ar_expected_receipt_date))}` },
          { label: '', render: (r) => (applied.has(r.finance_reply_id) ? '반영됨' : `<button data-fr="${ui.esc(r.finance_reply_id)}">지금 반영</button>`) },
        ], replies)}`)}
      ${section(ui, `구간 버전 ${windows.length}개`, ui.tag('계산', false, true), `
        ${winTable(recent.slice(0, 3))}${recent.length > 3 ? fold(ui, `이전 버전 ${recent.length - 3}개`, winTable(recent.slice(3))) : ''}`)}
      <p id="p3mock" class="muted"></p>`;
    el.querySelectorAll('button[data-fr]').forEach((btn) => {
      btn.onclick = async () => {
        try { await api.post('/api/p3/finance-reply', { finance_reply_id: btn.dataset.fr }); await this.renderMock(el, { api, ui }); }
        catch (err) { el.querySelector('#p3mock').textContent = `오류: ${err.message}`; }
      };
    });
  },
};

function draftCard(ui, x) {
  return `<div class="card" style="margin:6px 0"><span class="muted">${ui.esc(x.draft_id)} · ${ui.esc(x.mode)} · ${ui.esc(x.review_status)}</span>
    ${nowrap(ui.tag('계산', false, x.mode === 'AI'))}
    <pre>${ui.esc(x.text)}</pre>
    ${x.mode === 'AI' && x.review_status === '확인 대기' ? `<div class="row"><button data-act="review" data-id="${ui.esc(x.draft_id)}" data-r="확인">확인</button><button data-act="review" data-id="${ui.esc(x.draft_id)}" data-r="거부">거부</button></div>` : ''}</div>`;
}
