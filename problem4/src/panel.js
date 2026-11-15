// 문제 4 패널: 기안 상세(결론 → 마감·발주안 회신·승인 회신·재검토·확인 요청·경고·보류)와 모의 입력(시나리오·순서표·현금 규칙 회신)
// 화면 지침(조정자 (E)): 결론 먼저, 전체 폭 구역, 자료 구분은 구역 제목에 한 번, 긴 목록은 접고 결론이 바뀐 것만 먼저, 코드는 한국어 이름.
const DUE_LABELS = ['demand_input_due', 'judgment_due', 'submission_due', 'first_reply_due', 'alt_selection_due', 'final_reply_due'];
const TONE = { '확정 가능': 'ok', 확정: 'ok', '조건부 대기': 'wait', 미확인: 'wait', '검토 중': 'wait', 불가: 'bad', 철회: 'bad', '기한 경과 확정': 'bad' };
const WARN_RULE = { W1: '수요 입력', W2: '판정·재무 확인', W3: '상신', W4: '1차 회신', W5: '최종 회신', W6: '발주 예정일', W7: '확인 요청 회신' };
const pill = (ui, v) => `<span class="pill ${TONE[v] ?? (/거절/.test(v) ? 'bad' : /승인/.test(v) ? 'ok' : 'wait')}">${ui.esc(v ?? '-')}</span>`;

// 화면 안 입력 창(브라우저 prompt 대신). 비워 두고 확인하면 다시 묻는다. 취소하면 null.
function ask({ title, body = '', placeholder = '', okLabel = '확인', danger = false }) {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'modal-back';
    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    el.innerHTML = `<div class="modal" role="dialog" aria-modal="true"><h3>${esc(title)}</h3>${body ? `<p>${esc(body)}</p>` : ''}
      <textarea rows="3" placeholder="${esc(placeholder)}"></textarea>
      <div class="row end"><button data-x="cancel">취소</button><button data-x="ok" class="${danger ? 'btn-danger' : 'btn-primary'}">${esc(okLabel)}</button></div></div>`;
    document.body.appendChild(el);
    const ta = el.querySelector('textarea');
    ta.focus();
    el.querySelector('[data-x=cancel]').onclick = () => { el.remove(); resolve(null); };
    el.querySelector('[data-x=ok]').onclick = () => { const v = ta.value.trim(); if (!v) { ta.focus(); return; } el.remove(); resolve(v); };
  });
}

async function post(api, path, body, el) {
  try {
    await api.post(path, body);
    location.reload();
  } catch (err) {
    el.querySelector('.p4-msg').textContent = `오류: ${err.message}`;
  }
}

// 발주안 승인 회신(현금 규칙 S4-08-97): 승인 전후 최저 잔액·하회 구간·캠페인 추가분 비중
// 하회 구간이 여러 조각으로 끊기면 조각별로 보인다(문제 3 segments[])
const win = (x) => (x?.segments?.length > 1 ? x.segments.map((g) => `${g.start.slice(5)}~${g.end.slice(5)}`).join(', ')
  : x?.shortfall_window_start ? `${x.shortfall_window_start.slice(5)}~${x.shortfall_window_end.slice(5)}` : '없음');

// 기한 경과 확정 경위: 단계 → 단계 (날짜) 한 줄과 단계별 설명
function lapseView(ui, story) {
  if (!story) return '';
  return `<div class="lapse"><p><b>기한 경과 확정 경위</b> <span class="muted small">${ui.esc(story.kind)}</span></p>
    <ol class="steps">${story.steps.map((x) => `<li class="step ${x.step === '기한 경과 확정' || /뒤라/.test(x.text) ? 'bad' : 'wait'}"><div class="st-title">${ui.esc(x.date ?? '-')}</div>
      <div class="st-val">${ui.esc(x.step)}</div><div class="st-due muted small">${ui.esc(x.text)}</div></li>`).join('<li class="arrow">→</li>')}</ol></div>`;
}

function poReplyTable(ui, rows) {
  return ui.table([
    { label: '회신일', key: 'replied_at', nowrap: true },
    { label: '발주안', nowrap: true, render: (r) => `<b>${ui.esc(r.po_draft_id)}</b><div class="muted small">${ui.esc(r.sku_id ?? '')} · ${ui.num(r.order_qty)}EA</div>` },
    { label: '금액', nowrap: true, render: (r) => ui.eok(r.amount_krw) },
    { label: '캠페인 추가분 비중', nowrap: true, render: (r) => (r.campaign_share_pct == null ? '<span class="muted">수량 내역 없음</span>' : `${r.campaign_share_pct}% <span class="muted small">${ui.eok(r.campaign_amount_krw)}</span>`) },
    { label: '연결 기안', render: (r) => ui.esc((r.linked_plan_ids ?? []).join(', ')) },
    { label: '결정', nowrap: true, render: (r) => pill(ui, r.decision) + (r.cash_basis.differs_from_base ? `<div class="warn small">기본 기준이면 ${ui.esc(r.cash_basis.base_decision)}</div>` : '') },
    { label: '기준', nowrap: true, render: (r) => `${ui.eok(r.cash_basis.floor_krw ?? 0)}${r.cash_basis.floor_scenario_id && r.cash_basis.floor_scenario_id !== 'BASE' ? `<div class="muted small">${ui.esc(ui.label(r.cash_basis.floor_scenario_id))}</div>` : ''}` },
    { label: '최저 잔액 승인 전 → 후', nowrap: true, render: (r) => `${ui.eok(r.cash_basis.before?.min_balance_krw)} → <b class="${r.cash_basis.after?.min_balance_krw < 0 ? 'warn' : ''}">${ui.eok(r.cash_basis.after?.min_balance_krw)}</b><div class="muted small">${ui.esc(r.cash_basis.after?.min_date ?? '')}</div>` },
    { label: '하회 구간 전 → 후', nowrap: true, render: (r) => `${win(r.cash_basis.before)} → ${win(r.cash_basis.after)}` },
  ], rows, { empty: '발주안 회신 없음' });
}

export default {
  async renderPlan(el, { plan, api, ui }) {
    const d = await api.get(`/api/p4/plans/${encodeURIComponent(plan.plan_id)}`);
    const t = d.sim_clock;
    const st = d.plan_state;
    const ds = d.deadline_schedule;
    const notConnected = Object.entries(d.connected).filter(([, v]) => !v).map(([k]) => ui.label(k));
    const sn = st.decision_snapshot;

    // 마감
    const deadlines = ds
      ? ui.table([
        { label: '단계', render: (r) => ui.esc(ui.label(r.key)) },
        { label: '마감', nowrap: true, render: (r) => `${ui.esc(r.date)}${r.date < t ? ' <span class="muted small">지남</span>' : r === DUE_LABELS.map((k) => ({ key: k, date: ds[k] })).find((x) => x.date >= t) ? ' <b>다음</b>' : ''}` },
      ], DUE_LABELS.map((key) => ({ key, date: ds[key] })).filter((r) => r.date))
        + `<p class="muted small">승인 기준일 ${ui.esc(ds.approval_anchor_date)}(${ui.esc(ui.label(ds.anchor_basis))}) · 승인권자 ${ui.esc(ui.label(ds.approver))} · 표준 결재 ${ds.std_approval_bd}영업일 · ${ui.esc(ds.computed_status)}</p>`
      : '<p class="muted">마감 미산출(문제 3 경로 판정 연결 안 됨)</p>';

    // 재검토: 열린 것·결론이 바뀐 것 먼저, 나머지는 접음
    const revCols = [
      { label: '재검토', nowrap: true, render: (r) => `${ui.esc(r.review_id)}<div class="muted small">${ui.esc(r.review_kind)}</div>` },
      { label: '대상', render: (r) => `${ui.esc(ui.label(r.target_type))} <span class="muted small">${ui.esc(r.target_id ?? '')}</span>` },
      { label: '결론', nowrap: true, render: (r) => (r.review_status === '열림' ? pill(ui, '열림') : `${ui.esc(r.outcome ?? '종결')}`) },
      { label: '근거', render: (r) => ui.esc(r.rationale ?? '') + (r.review_status === '열림' && r.review_kind === '사람 판단'
        ? ` <button data-close="${ui.esc(r.review_id)}" data-outcome="유지">유지</button><button data-close="${ui.esc(r.review_id)}" data-outcome="변경">변경</button>` : '') },
    ];
    const revFirst = d.reviews.filter((r) => r.review_status === '열림' || r.outcome === '변경');
    const revRest = d.reviews.filter((r) => !revFirst.includes(r));

    const reqCols = [
      { label: '요청', nowrap: true, render: (r) => `${ui.esc(r.request_id)}<div class="muted small">${ui.esc(ui.label(r.request_kind))}</div>` },
      { label: '항목', render: (r) => ui.esc(ui.label(r.request_topic)) }, { label: '대상', nowrap: true, render: (r) => ui.esc(ui.label(r.requested_to)) },
      { label: '회신 기한', key: 'request_due_date', nowrap: true },
      { label: '상태', nowrap: true, render: (r) => `${ui.esc(r.request_status)}${r.request_due_date && r.request_due_date < t && !['회신됨', '이관'].includes(r.request_status) ? ' <span class="warn">기한 경과</span>' : ''}` },
    ];
    const reqOpen = d.info_requests.filter((r) => !['회신됨', '이관'].includes(r.request_status));
    const reqDone = d.info_requests.filter((r) => !reqOpen.includes(r));

    const replies = ui.table([
      { key: 'replied_at', label: '회신일', nowrap: true }, { label: '결정', nowrap: true, render: (r) => pill(ui, r.decision) },
      { label: '승인권자', nowrap: true, render: (r) => ui.esc(ui.label(r.approver)) },
      { label: '조건', render: (r) => ui.esc((r.conditions ?? []).map((c) => `${c.condition_type}: ${c.text}`).join(' / ') || '-') },
    ], d.approval_replies, { empty: '승인 회신 없음' });

    const warnings = ui.table([
      { key: 'occurred_at', label: '발생', nowrap: true }, { label: '지난 마감', render: (w) => `${ui.esc(WARN_RULE[w.warning_rule] ?? w.warning_rule)} <span class="muted small">${ui.esc(w.warning_rule)}</span>` },
      { key: 'due_date', label: '마감일', nowrap: true }, { label: '수신', render: (w) => ui.esc((w.recipients ?? []).map(ui.label).join(', ')) },
      { key: 'message', label: '내용' },
    ], d.warnings, { empty: '경고 없음' });

    const holds = ui.table([
      { key: 'hold_id', label: '보류' }, { label: '담당', render: (h) => ui.esc(ui.label(h.hold_owner_dept)) }, { key: 'hold_due_date', label: '재개 기한' },
      { label: '재개 조건', render: (h) => ui.esc(`${ui.label(h.resume_condition?.event_type ?? '')} ${h.resume_condition?.subject_id ?? ''}`) },
      { key: 'hold_reason', label: '사유' },
      { label: '상태', render: (h) => `${ui.esc(h.hold_status)}${h.hold_status === '보류 중' ? ` <button data-cancel="${ui.esc(h.hold_id)}">해제</button>` : ''}` },
    ], d.holds, { empty: '보류 없음' });

    const sim = ui.tag('계산', false, true);
    el.innerHTML = `
      ${notConnected.length ? `<p class="warn">연결 안 됨: ${ui.esc(notConnected.join(', '))} — 해당 값 없이 표시합니다</p>` : ''}
      ${ui.section('결론', `<p class="conclusion">${st.plan_status === '검토 중'
          ? `${pill(ui, st.plan_status)} 확정 가능 ${pill(ui, st.plan_confirmability)} <span class="muted">${ui.esc(st.confirmability_basis?.reason ?? '')}</span>`
          : `${pill(ui, st.plan_status)}${sn ? ` <span class="muted">${ui.esc(sn.decided_at)}</span>` : ''}`}</p>
        ${sn ? `<p>결정 시점(${ui.esc(sn.decided_at)}) 공급 판정 <b>${ui.esc(sn.supply_verdict ?? '-')}</b>${sn.condition_types?.length ? `(${ui.esc(sn.condition_types.map(ui.label).join(', '))})` : ''} v${ui.esc(sn.supply_judgment_version ?? '-')} · 승인 ${ui.esc(sn.approval_status ?? '-')}</p>` : ''}
        ${st.default_mock_input ? `<p class="muted small">시연 대상 외 기안: 기본 모의 입력 규칙 적용 ${ui.tag('가정')}</p>` : ''}
        ${lapseView(ui, d.lapse_story)}
        ${(d.po_replies ?? []).some((r) => r.cash_basis.differs_from_base) ? `<p class="warn">기본 시나리오와 다름: ${ui.esc(d.po_replies.filter((r) => r.cash_basis.differs_from_base).map((r) => r.po_draft_id).join(', '))}이(가) ${ui.esc(ui.label(d.po_replies.find((r) => r.cash_basis.differs_from_base).cash_basis.floor_scenario_id))} 기준(${ui.eok(d.po_replies.find((r) => r.cash_basis.differs_from_base).cash_basis.floor_krw)})으로 거절됨. 기본 기준(0원)이면 승인 ${ui.tag('가정')}</p>` : ''}
        <div class="row">
          <button id="p4-confirm" ${st.plan_status === '검토 중' && st.plan_confirmability === '확정 가능' ? '' : 'disabled'}>확정(마케팅)</button>
          <button id="p4-withdraw" class="danger" ${st.plan_status === '검토 중' ? '' : 'disabled'}>철회</button>
        </div>`, { tag: sim })}
      ${ui.section('마감', deadlines, { tag: sim + ui.tag('가정') })}
      ${d.po_replies?.length ? ui.section(`이 기안이 기대는 발주안의 승인 회신 ${d.po_replies.length}건`, poReplyTable(ui, d.po_replies), {
        tag: ui.tag('모의회신', true, true), note: '규칙(가정): 승인했을 때의 재전망 최저 잔액이 기준 미만이면 거절. 기준은 기본 0원(Masil 단독 기준 지급 재원, 그룹 지원은 판정에 넣지 않음)이고, 켜진 시나리오에 그 승인권자의 기준이 있으면 그 값(예: 그룹 CEO 최저 잔액 조건 15억, 가정). 거절되면 보충 조건을 채우지 못한다' }) : ''}
      ${ui.section('승인 회신', replies, { tag: ui.tag('모의회신', true, true) })}
      ${ui.section(`재검토 ${d.reviews.length}건`, (revFirst.length ? ui.table(revCols, revFirst) : '<p class="muted">열린 재검토·결론이 바뀐 재검토 없음</p>')
        + (revRest.length ? ui.fold('유지·종결된 재검토', ui.table(revCols, revRest), { count: revRest.length }) : ''), { tag: sim })}
      ${ui.section(`확인 요청 ${d.info_requests.length}건`, (reqOpen.length ? ui.table(reqCols, reqOpen) : '<p class="muted">회신 대기 없음</p>')
        + (reqDone.length ? ui.fold('회신됨·이관', ui.table(reqCols, reqDone), { count: reqDone.length }) : ''), { tag: ui.tag('계산') })}
      ${ui.section('기한 경고', d.warnings.length ? ui.fold('경고 보기', warnings, { count: d.warnings.length }) : '<p class="muted">경고 없음</p>', { tag: sim })}
      ${ui.section('보류', holds + ui.fold('보류 걸기', `<form id="p4-hold" class="row">
          <select name="hold_owner_dept">${['MKT', 'SCM', 'FIN', 'MS_MGMT', 'GROUP', 'COREVIA'].map((x) => `<option value="${x}">${ui.esc(ui.label(x))}</option>`).join('')}</select>
          <input name="hold_due_date" type="date" required title="재개 기한(상신 마감 이하)">
          <input name="event_type" placeholder="재개 조건 사건(예: DEMAND_INPUT_REGISTERED)" required>
          <input name="hold_reason" placeholder="사유" required>
          <button>보류</button>
        </form>`), { tag: ui.tag('사람입력') })}
      <p class="p4-msg muted"></p>`;

    el.querySelector('#p4-confirm').onclick = () => post(api, `/api/p4/plans/${plan.plan_id}/confirm`, {}, el);
    el.querySelector('#p4-withdraw').onclick = async () => {
      const reason = await ask({ title: '이 기안을 철회할까요?', body: '철회하면 되돌릴 수 없습니다.', placeholder: '철회 사유(필수)', okLabel: '철회', danger: true });
      if (reason) post(api, `/api/p4/plans/${plan.plan_id}/withdraw`, { reason }, el);
    };
    el.querySelectorAll('[data-close]').forEach((b) => { b.onclick = async () => {
      const rationale = await ask({ title: `재검토를 '${b.dataset.outcome}'(으)로 닫을까요?`, placeholder: '판단 근거(필수)', okLabel: b.dataset.outcome });
      if (rationale) post(api, `/api/p4/reviews/${b.dataset.close}/close`, { outcome: b.dataset.outcome, rationale }, el);
    }; });
    el.querySelectorAll('[data-cancel]').forEach((b) => { b.onclick = () => post(api, `/api/p4/holds/${b.dataset.cancel}/cancel`, {}, el); });
    el.querySelector('#p4-hold').onsubmit = (ev) => {
      ev.preventDefault();
      const f = new FormData(ev.target);
      post(api, '/api/p4/holds', {
        target_type: 'plan', target_id: plan.plan_id, plan_id: plan.plan_id, hold_owner_dept: f.get('hold_owner_dept'),
        hold_due_date: f.get('hold_due_date'), resume_condition: { event_type: f.get('event_type'), subject_id: plan.plan_id }, hold_reason: f.get('hold_reason'),
      }, el);
    };
  },

  async renderMock(el, { api, ui }) {
    const [s, issues, kept, po, scn] = await Promise.all([api.get('/api/p4/schedule'), api.get('/api/p4/open-issues'),
      api.get('/api/p4/reviews?target_type=cash_window'), api.get('/api/p4/po-replies'), api.get('/api/p4/scenario-summary')]);
    const atStart = s.sim_clock === '2026-07-01';
    const scen = ['S-AR-DELAY', 'S4-OI3-A', ...scn.floors.filter((f) => f.scenario_id !== 'BASE').map((f) => f.scenario_id)];
    const floorTable = ui.table([
      { label: '시나리오', nowrap: true, render: (f) => `${ui.esc(ui.label(f.scenario_id))}${f.active ? ' <b>켜짐</b>' : ''}` },
      { label: '적용 승인권자', nowrap: true, render: (f) => ui.esc(f.approver === '*' ? '모두' : ui.label(f.approver)) },
      { label: '최저 잔액 기준', nowrap: true, render: (f) => ui.eok(f.floor_krw) }, { key: 'condition_text', label: '내용' }, { key: 'record_id', label: '자료', nowrap: true },
    ], scn.floors);
    const affected = ui.table([
      { label: '기안', nowrap: true, render: (a) => `<a href="#/plan/${ui.esc(a.plan_id)}?tab=p4">${ui.esc(a.plan_id)}</a>` },
      { label: '거절된 발주안', render: (a) => ui.esc(a.rejected_po_draft_ids.join(', ')) },
      { label: '이후 흐름', render: (a) => ui.esc(a.flow.map((f) => `${f.occurred_at.slice(5)} ${f.supply_verdict ?? f.alternative_type ?? ui.label(f.event_type)}`).join(' → ')) },
      { label: '결과', nowrap: true, render: (a) => pill(ui, a.plan_status) },
    ], scn.affected_plans, { empty: '기본 시나리오와 다른 결정 없음' });
    const summary = `<p>발주안 ${scn.po.count}건 ${ui.eok(scn.po.amount_krw)} · 승인 ${scn.po.approved.count}건 ${ui.eok(scn.po.approved.amount_krw)} · 거절 ${scn.po.rejected.count}건 ${ui.eok(scn.po.rejected.amount_krw)}
        ${scn.cash_window ? ` · 현행 최저 잔액 <b>${ui.eok(scn.cash_window.min_balance_krw)}</b>(${ui.esc(scn.cash_window.min_date ?? '-')}), 하회 구간 ${scn.cash_window.segments?.length > 1 ? ui.esc(scn.cash_window.segments.map((g) => `${g.segment_no}) ${g.start}~${g.end}${g.end_at_horizon ? '(재전망 끝까지)' : ''}`).join(', ')) : `${ui.esc(scn.cash_window.shortfall_window_start ?? '-')}~${ui.esc(scn.cash_window.shortfall_window_end ?? '-')}`}` : ''}</p>
      <p>기본 시나리오와 다른 결정: 기본 기준(0원)이면 승인됐을 발주안 <b>${scn.po.rejected_by_floor.length}건</b> ${ui.eok(scn.po.rejected_by_floor.reduce((a, r) => a + (r.amount_krw ?? 0), 0))}이 거절됨</p>
      ${affected}${ui.fold('발주안 최저 잔액 기준(S4-10)', floorTable, { count: scn.floors.length })}
      <p style="margin-top:10px"><b>기한 경과 확정 ${scn.deadline_lapses.length}건 경위</b></p>
      ${ui.table([
        { label: '기안', nowrap: true, render: (x) => `<a href="#/plan/${ui.esc(x.plan_id)}?tab=p4">${ui.esc(x.plan_id)}</a>` },
        { label: '종류', nowrap: true, render: (x) => ui.esc(x.kind) },
        { label: '경위', render: (x) => ui.esc(x.steps.map((y) => `${y.step}(${y.date?.slice(5) ?? '-'})${y.step === '구간 확대' || y.step === '회신 예정' || y.step === '결정 시점 상태' ? `: ${y.text}` : ''}`).join(' → ')) },
      ], scn.deadline_lapses, { empty: '기한 경과 확정 없음' })}`;
    const rowCols = [
      { key: 'sim_date', label: '가상 일자', nowrap: true },
      { label: '사건', render: (r) => `${ui.esc(ui.label(r.event_type))}<div class="muted small">${ui.esc(r.mock_id)} · ${ui.esc(ui.label(r.owner))}</div>` },
      { label: '기안', key: 'plan_id', nowrap: true }, { key: 'target', label: '내용' },
      { label: '시나리오', nowrap: true, render: (r) => `${ui.esc(ui.label(r.scenario_id))}${r.active ? '' : ' <span class="muted">(꺼짐)</span>'}` },
      { label: '상태', render: (r) => ui.esc(r.status) },
    ];
    const pending = s.rows.filter((r) => r.active && r.status === '대기');
    const done = s.rows.filter((r) => !pending.includes(r));
    const rows = po.po_replies;
    const sum = (f) => rows.filter(f).reduce((a, r) => a + (r.amount_krw ?? 0), 0);
    const last = rows.filter((r) => r.decision === '승인').at(-1)?.cash_basis?.after;
    el.innerHTML = `
      <div class="row">
        <span>시나리오</span>${scen.map((x) => `<label class="chip"><input type="checkbox" data-scen="${x}" ${s.scenarios.includes(x) ? 'checked' : ''} ${atStart ? '' : 'disabled'}> ${ui.esc(ui.label(x))}</label>`).join('')}
        <span class="muted small">${atStart ? '07-01에서만 바꿀 수 있음' : '바꾸려면 전체 초기화'}</span>
        <button id="p4-next" ${s.next_date ? '' : 'disabled'}><b>다음 일정(${ui.esc(s.next_date ?? '-')})까지 진행</b></button>
        ${['2026-07-17', '2026-07-22', '2026-08-14', '2026-09-14'].map((d) => `<button data-to="${d}" ${d > s.sim_clock ? '' : 'disabled'}>${d.slice(5)}까지</button>`).join('')}
      </div>
      <p class="p4-msg muted"></p>
      ${ui.section(`시나리오 요약 · ${s.scenarios.length ? s.scenarios.map(ui.label).join(', ') : '기본'}`, summary, { tag: ui.tag('가정') + ui.tag('계산', false, true),
        note: '그룹 CEO 최저 잔액 조건 등 시나리오 기준은 원본에 없는 승인권자 입장을 가정한 가상 입력이다(자료 s4_10_po_cash_floor.csv)' })}
      ${ui.section(`사건 순서표 · 남은 일정 ${pending.length}건`, (pending.length ? ui.table(rowCols, pending) : '<p class="muted">남은 일정 없음</p>')
        + ui.fold('지난 일정·건너뜀', ui.table(rowCols, done), { count: done.length }), { tag: ui.tag('모의회신', true, true), note: '값은 각 문제가 소유하고, 문제 4는 순서표 날짜에 전달만 한다(S4-09)' })}
      ${ui.section(`발주안 승인 회신(현금 규칙) ${rows.length}건`, `<p>승인 ${rows.filter((r) => r.decision === '승인').length}건 ${ui.eok(sum((r) => r.decision === '승인'))} ·
          거절 ${rows.filter((r) => r.decision === '거절').length}건 ${ui.eok(sum((r) => r.decision === '거절'))}
          ${last ? ` · 마지막 승인 뒤 최저 잔액 <b>${ui.eok(last.min_balance_krw)}</b>(${ui.esc(last.min_date)}), 하회 구간 ${ui.esc(win(last))}` : ''}</p>`
        + (rows.length ? ui.fold('회신별 근거', poReplyTable(ui, rows), { count: rows.length, open: rows.length <= 8 }) : ''),
      { tag: ui.tag('모의회신', true, true) + ui.tag('가정'), note: '규칙: 그 발주안을 승인했을 때의 재전망 최저 잔액(문제 3 approvalImpact)이 기준(기본 0원, 켜진 시나리오의 승인권자 기준) 미만이면 거절, 아니면 승인. 상신 순서대로 회신' })}
      ${ui.section('변경 입력 재검토(현금 구간)', ui.fold('구간 유지 기록', ui.table([
        { key: 'target_id', label: '구간 버전', nowrap: true }, { label: '결론', render: (r) => ui.esc(r.outcome ?? r.review_status) },
        { label: '전', nowrap: true, render: (r) => ui.esc(`${r.before?.shortfall_window_start ?? '-'}~${r.before?.shortfall_window_end ?? '-'}`) },
        { label: '후', nowrap: true, render: (r) => ui.esc(`${r.after?.shortfall_window_start ?? '-'}~${r.after?.shortfall_window_end ?? '-'}`) },
        { label: '바뀌지 않은 승인권자', render: (r) => ui.esc((r.after?.approvers ?? []).map((a) => `${a.plan_id} ${ui.label(a.approver)}`).join(', ') || (r.after?.kept_commitment_ids ? `결론 같은 약정 ${r.after.kept_commitment_ids.length}건` : '')) },
        { key: 'rationale', label: '유지 근거' },
      ], kept.reviews, { empty: '변경 입력 재검토 없음' }), { count: kept.reviews.length }), { tag: ui.tag('계산', false, true) })}
      ${ui.section('회의록 미결', ui.fold('미결 보기', ui.table([
        { key: 'issue_id', label: '미결', nowrap: true }, { key: 'quote', label: '원문' }, { key: 'source_ref', label: '출처' }, { key: 'issue_status', label: '상태', nowrap: true },
      ], issues.open_issues), { count: issues.open_issues.length }), { tag: ui.tag('원본도출') })}
      ${ui.section('AI 영향 요약(작성 작업)', `<form id="p4-ai" class="row"><input name="event_id" placeholder="EV-000123" required><button>요약</button></form><div id="p4-ai-out" class="muted"></div>`)}`;

    const advance = async (body) => {
      try { await api.post('/api/clock/advance', body); location.reload(); }
      catch (err) { el.querySelector('.p4-msg').textContent = `오류: ${err.message}`; }
    };
    el.querySelector('#p4-next').onclick = () => advance({ to: s.next_date });
    el.querySelectorAll('[data-to]').forEach((b) => { b.onclick = () => advance({ to: b.dataset.to }); });
    el.querySelectorAll('[data-scen]').forEach((c) => { c.onchange = () => {
      const list = [...el.querySelectorAll('[data-scen]:checked')].map((x) => x.dataset.scen);
      post(api, '/api/p4/scenarios', { scenarios: list }, el);
    }; });
    el.querySelector('#p4-ai').onsubmit = async (ev) => {
      ev.preventDefault();
      const out = el.querySelector('#p4-ai-out');
      try {
        const r = await api.post('/api/p4/impact-summary', { event_id: new FormData(ev.target).get('event_id') });
        out.innerHTML = r.status === '미연결'
          ? `AI 미연결: 규칙이 고른 재검토 ${r.items.reviews.length}건만 표시합니다. ${ui.esc(r.items.reviews.map((x) => `${x.review_id} ${ui.label(x.target_type)} ${x.review_status}`).join(' / '))}`
          : `<p>${ui.esc(r.output)}</p><p class="muted">${ui.esc(r.model)} · ${ui.esc(r.ai_call_id)} · 확인 대기 ${ui.tag('계산', false, true)}</p>
             <button data-ai="확인">확인</button><button data-ai="거부">거부</button>`;
        out.querySelectorAll('[data-ai]').forEach((b) => { b.onclick = async () => {
          await api.post(`/api/p4/ai/${r.ai_call_id}/review`, { review_result: b.dataset.ai, plan_id: r.items.event.plan_id });
          out.querySelector('.muted').textContent = `${r.model} · ${r.ai_call_id} · ${b.dataset.ai}`;
        }; });
      } catch (err) { out.textContent = `오류: ${err.message}`; }
    };
  },
};
