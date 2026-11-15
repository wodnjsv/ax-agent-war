// 문제 4 모듈: 요청·회신·결정 이력과 재검토. 명세: problem4/명세.md, 이름: problem4/공통_접점.md
import { createStore } from './store.mjs';
import { createEngine } from './engine.mjs';
import { createDescriber } from './describe.mjs';
import { createUserViews } from './user.mjs';

function loadData(ctx) {
  const offsetsRows = ctx.data.load('s4_01_deadline_offsets.csv');
  const ga = ctx.data.load('s4_06_group_allocation.csv');
  return {
    offsets: Object.fromEntries(offsetsRows.map((r) => [r.param, r.value_bd])),
    warningRules: Object.fromEntries(ctx.data.load('s4_02_warning_rules.csv').map((r) => [r.warning_rule, r])),
    groupAllocation: { request: ga.find((r) => r.kind === 'request'), reply: ga.find((r) => r.kind === 'reply') },
    approvalReplies: ctx.data.load('s4_08_approval_replies.csv'),
    schedule: ctx.data.load('s4_09_mock_schedule.csv'),
    openIssues: ctx.data.load('d4_open_issues.csv'),
    cashFloors: ctx.data.load('s4_10_po_cash_floor.csv'),
  };
}

const IMPACT_SYSTEM_PROMPT = [
  '너는 W01 운영 시스템의 작성 보조다. 새 사건이 어느 기안에 영향을 주는지 담당자가 읽을 요약을 한국어 3~5문장으로 쓴다.',
  '입력 JSON에 있는 값(날짜, 판정, 경로, 상태)만 인용한다. 새 수치를 계산하거나 판정·결론을 내리지 않는다.',
  '원인을 단정하지 않는다. 가상 입력(모의회신·사람입력)에 기댄 값이면 그렇다고 밝힌다.',
].join(' ');

export async function register(ctx) {
  const store = createStore(ctx);
  const data = loadData(ctx);
  const engine = createEngine(ctx, store, data);

  engine.subscribe();
  ctx.clock.onDay((date) => engine.onDay(date));
  ctx.onReset(() => engine.restoreScenarios());
  ctx.onInit(() => engine.init());

  const plansById = () => new Map(ctx.plans().map((p) => [p.plan_id, p]));

  // ── 9.1 공개 함수(12개 + 직접 처리 2개 + describeEvent) ──
  ctx.expose({
    getDeadlineSchedule: (key = {}) => (key.commitment_id ? store.deadlineById(key.commitment_id) : key.plan_id ? store.deadlineByPlan(key.plan_id) : null),
    listDeadlineSchedules: (filter = {}) => store.deadlines(filter),
    getPlanState: (planId) => store.planState(planId),
    listPlanStates: () => store.planStates(),
    requestInfo: (req) => engine.requestInfo(req),
    getInfoRequest: (id) => store.request(id),
    listInfoRequests: (filter = {}) => store.requests(filter),
    listReviews: (filter = {}) => store.reviews(filter),
    listHolds: (filter = {}) => store.holds(filter),
    listOpenIssues: () => store.issues(),
    listWarnings: (filter = {}) => store.warnings(filter),
    getMockSchedule: (filter = {}) => engine.schedule(filter),
    // 사용자 결정(2026-11-15): 기안별 '내가 직접 처리'
    // 직접 처리 기안(사용자가 왼쪽 화면에서 처리). 다른 모듈의 자동(모의) 입력·묶음 상신은 이 기안을 빼야 한다(조정자 지시 2026-11-15 나)
    listDirectPlans: () => [...engine.getDirectPlans()],
    isDirectPlan: (planId) => engine.isDirect(planId),
    setDirectPlan: (planId, on) => engine.setDirect(planId, on),
    // 평가자 화면 설명 카드(app/모듈_계약.md 8절)
    describeEvent: (e) => describeEvent(e),
  });
  const describeEvent = createDescriber({ ctx, store, data });
  const views = createUserViews({ ctx, store, engine, describeOwn: describeEvent, lapseStory: (id) => lapseStory(id),
    poRepliesFor: (id) => poReplies().filter((r) => r.linked_plan_ids.includes(id)) });

  // ── 기안 목록 요약 ──
  ctx.addPlanSummary((planId) => {
    const st = store.planState(planId);
    const d = store.deadlineByPlan(planId);
    if (!st) return [];
    const t = ctx.clock.today();
    const next = d && [['수요 입력', d.demand_input_due], ['판정', d.judgment_due], ['상신', d.submission_due], ['최종 회신', d.final_reply_due]]
      .find(([, v]) => v && v >= t);
    return [
      { label: '확정', value: st.plan_status === '검토 중' ? st.plan_confirmability : st.plan_status, source_type: '계산', is_simulation: true },
      ...(next ? [{ label: `다음 마감(${next[0]})`, value: next[1], source_type: '계산', is_simulation: true }] : []),
      ...(st.decision_snapshot ? [{ label: '결정 시점 판정', value: `${st.decision_snapshot.supply_verdict ?? '-'} v${st.decision_snapshot.supply_judgment_version ?? '-'}`, source_type: '계산', is_simulation: true }] : []),
      ...(st.default_mock_input ? [{ label: '모의 입력', value: '기본 규칙', source_type: '가정', is_synthetic: true }] : []),
      // 진행 요약(기안 상세 맨 위)의 단계별 마감. step = 그 단계를 맡은 문제
      ...(d ? [['p1', '수요 입력 마감', d.demand_input_due], ['p2', '판정 마감', d.judgment_due], ['p3', '상신 마감', d.submission_due]]
        .filter(([, , v]) => v).map(([step, label, value]) => ({ step, label, value, source_type: '계산', is_simulation: true })) : []),
      { step: 'p4', label: '확정기한', value: store.planStateRaw(planId)?.contract_deadline ?? null, source_type: '원본도출' },
    ];
  });

  // ── API ──
  // 기한 경과 확정 경위(조정자 마지막 조정 (나)): 사건 원인 사슬로 '구간 확대 → 경로 상향 → 재상신 → 회신이 기한 뒤'를 읽어 낸다.
  // 경로 상향이 없으면 결정 시점 판정·확정 가능 근거로 한 줄 경위를 만든다(예: 수요 미등록 → 판정불가).
  const RANK = { GRP_CEO: 3, MS_CEO: 2, MKT_TEAM: 1, SCM: 1 };
  const APPROVER_KO = { GRP_CEO: '그룹 CEO', MS_CEO: 'Masil 대표', MKT_TEAM: '마케팅팀', SCM: 'SCM' };
  function lapseStory(planId) {
    const auto = ctx.events.query({ plan_id: planId, event_type: 'PLAN_AUTO_CONFIRMED_BY_DEADLINE', limit: 1e9 }).at(-1);
    if (!auto) return null;
    const raw = store.planStateRaw(planId);
    const deadline = raw?.contract_deadline ?? null;
    const d = store.deadlineByPlan(planId);
    const cid = d?.commitment_id;
    const routes = cid ? ctx.events.query({ event_type: 'ROUTE_JUDGED', limit: 1e9 }).filter((e) => e.payload?.commitment_id === cid) : [];
    let upgrade = null;
    for (let i = 1; i < routes.length; i += 1) {
      if ((RANK[routes[i].payload?.approver] ?? 0) > (RANK[routes[i - 1].payload?.approver] ?? 0) && routes[i].occurred_at <= auto.occurred_at) upgrade = { ev: routes[i], from: routes[i - 1].payload?.approver };
    }
    const steps = [];
    if (upgrade) {
      const chain = [];
      for (let c = upgrade.ev.caused_by, n = 0; c && n < 6; n += 1) { const e = ctx.events.get(c); if (!e) break; chain.push(e); c = e.caused_by; }
      const win = chain.find((e) => e.event_type === 'CASH_WINDOW_REVISED');
      const cause = win ? chain[chain.indexOf(win) + 1] : null;
      const prevWin = win ? ctx.events.query({ event_type: 'CASH_WINDOW_REVISED', limit: 1e9 })
        .filter((e) => e.event_id < win.event_id && (e.payload?.scenario_id ?? 'BASE') === (win.payload?.scenario_id ?? 'BASE')).at(-1) : null;
      const approvedBefore = ctx.events.query({ event_type: 'APPROVAL_REPLIED', limit: 1e9 })
        .filter((e) => e.payload?.commitment_id === cid && e.event_id < upgrade.ev.event_id && e.payload?.decision === '승인')[0];
      if (approvedBefore) steps.push({ step: '1차 승인', date: approvedBefore.occurred_at, text: `${APPROVER_KO[upgrade.from] ?? upgrade.from} 승인` });
      if (win) {
        const causeText = cause?.event_type === 'APPROVAL_REPLIED' ? '보충 발주안 승인으로'
          : cause?.event_type === 'AR_DATE_REVISED' ? '회수일 변경으로' : cause ? `${cause.event_type}로` : '';
        steps.push({ step: '구간 확대', date: win.occurred_at, event_id: win.event_id,
          text: `${causeText} 하회 구간 ${prevWin?.payload?.shortfall_window_start ?? '-'}~${prevWin?.payload?.shortfall_window_end ?? '-'} → ${win.payload?.shortfall_window_start}~${win.payload?.shortfall_window_end}. 유출일 ${upgrade.ev.payload?.cash_outflow_date ?? '-'}이 구간 안에 듦` });
      }
      steps.push({ step: '경로 상향', date: upgrade.ev.occurred_at, event_id: upgrade.ev.event_id, text: `${APPROVER_KO[upgrade.from] ?? upgrade.from} → ${APPROVER_KO[upgrade.ev.payload?.approver] ?? upgrade.ev.payload?.approver}, 다시 승인 요청 필요` });
      const resub = ctx.events.query({ event_type: 'APPROVAL_SUBMITTED', limit: 1e9 })
        .filter((e) => (e.payload?.commitment_ids ?? []).includes(cid) && e.event_id > upgrade.ev.event_id)[0];
      if (resub) {
        const std = ctx.module('p3')?.approverRole?.(resub.payload?.approver)?.std_approval_bd ?? d?.std_approval_bd ?? 2;
        const replyDue = ctx.cal.addBusinessDays(resub.occurred_at, std);
        steps.push({ step: '재상신', date: resub.occurred_at, event_id: resub.event_id, text: `${APPROVER_KO[resub.payload?.approver] ?? resub.payload?.approver}에 다시 승인 요청(결재 ${std}영업일)` });
        steps.push({ step: '회신 예정', date: replyDue, text: replyDue > deadline ? `확정기한 ${deadline} 뒤라 기한 안에 회신이 오지 않음` : `확정기한 ${deadline} 안` });
      }
    } else {
      const sn = raw?.decision_snapshot ? JSON.parse(raw.decision_snapshot) : null;
      steps.push({ step: '결정 시점 상태', date: auto.occurred_at, text: `공급 판정 ${sn?.supply_verdict ?? '-'}, 승인 ${sn?.approval_status ?? '-'}` });
    }
    // L8: 직접 처리 기안이면 담당자가 하지 않은 일을 경위에 적는다
    const noInput = auto.payload?.direct_no_input;
    if (noInput) steps.push({ step: '담당자 입력 없음', date: deadline, text: `직접 처리 기안이라 자동 모의 입력이 들어가지 않는다. ${noInput.awaited.length ? `담당자가 하지 않은 일: ${noInput.awaited.join(', ')}` : '다른 부서 회신을 기다리던 중 확정기한이 지남'}` });
    steps.push({ step: '기한 경과 확정', date: auto.occurred_at, event_id: auto.event_id, text: `확정기한 ${deadline}까지 결정 없음 → 묵시적 승인과 같은 효과(정책 38~39행)` });
    return { plan_id: planId, kind: noInput ? '직접 처리 기안 담당자 입력 없음' : upgrade ? '경로 상향 뒤 재승인 미도착' : '결정 미완료', contract_deadline: deadline, steps,
      summary: steps.map((x) => `${x.step}(${x.date?.slice(5) ?? '-'})`).join(' → ') };
  }

  // 발주안 승인 회신(현금 규칙)과 발주안 내역: 연결 기안·캠페인 추가분 비중(조정자 확정 (E)-3)
  const poReplies = () => store.replies({}).filter((r) => r.cash_basis).map((r) => {
    const c = ctx.module('p3')?.commitment?.(r.commitment_id) ?? null;
    const pd = c ? (ctx.module('p2')?.poDrafts?.({ po_draft_id: c.source_id }) ?? [])[0] ?? null : null;
    return { ...r, po_draft_id: c?.source_id ?? null, amount_krw: c?.amount_krw ?? null, sku_id: pd?.sku_id ?? null, order_qty: pd?.order_qty ?? null,
      linked_plan_ids: pd?.linked_plan_ids ?? [], campaign_share_pct: pd?.qty_breakdown?.campaign_share_pct ?? null,
      campaign_amount_krw: pd?.qty_breakdown?.campaign_amount_krw ?? null, approval_status: c?.approval_status ?? null };
  });
  ctx.route('GET', '/po-replies', () => ({ po_replies: poReplies() }));
  // 시나리오 요약: 켜진 최저 잔액 기준, 발주안 승인·거절, 기본 기준(0원)이면 승인됐을 거절(= 기본 시나리오와 다른 결정)과 그 영향 기안
  ctx.route('GET', '/scenario-summary', () => {
    const active = engine.getScenarios();
    const replies = poReplies();
    const amt = (rows) => rows.reduce((a, r) => a + (r.amount_krw ?? 0), 0);
    const pick = (d) => replies.filter((r) => r.decision === d);
    const byFloor = replies.filter((r) => r.cash_basis?.differs_from_base);
    const events = ctx.events.query({ limit: 1e9 });
    const affected = [...new Set(byFloor.flatMap((r) => r.linked_plan_ids))].map((planId) => {
      const st = store.planState(planId);
      const firstRejected = byFloor.filter((r) => r.linked_plan_ids.includes(planId)).map((r) => r.replied_at).sort()[0];
      const after = events.filter((e) => e.plan_id === planId && e.occurred_at >= firstRejected
        && ['ALTERNATIVE_SELECTED', 'PLAN_WITHDRAWN', 'PLAN_CONFIRMED', 'PLAN_AUTO_CONFIRMED_BY_DEADLINE', 'SUPPLY_JUDGED'].includes(e.event_type));
      return {
        plan_id: planId, plan_status: st?.plan_status ?? null, plan_confirmability: st?.plan_confirmability ?? null, decision_snapshot: st?.decision_snapshot ?? null,
        rejected_po_draft_ids: byFloor.filter((r) => r.linked_plan_ids.includes(planId)).map((r) => r.po_draft_id),
        flow: after.filter((e, i, arr) => e.event_type !== 'SUPPLY_JUDGED' || arr[i - 1]?.payload?.supply_verdict !== e.payload?.supply_verdict)
          .map((e) => ({ occurred_at: e.occurred_at, event_type: e.event_type, supply_verdict: e.payload?.supply_verdict ?? null,
            alternative_type: e.payload?.alternative_type ?? null, reason: e.payload?.reason ?? e.generation_reason ?? null })),
      };
    });
    const w = ctx.module('p3')?.cashWindow?.({}) ?? null;
    return {
      scenarios: active,
      floors: data.cashFloors.map((r) => ({ ...r, floor_krw: Number(r.floor_krw), active: r.scenario_id === 'BASE' || active.includes(r.scenario_id) })),
      po: { count: replies.length, amount_krw: amt(replies), approved: { count: pick('승인').length, amount_krw: amt(pick('승인')) },
        rejected: { count: pick('거절').length, amount_krw: amt(pick('거절')) },
        rejected_by_floor: byFloor.map((r) => ({ po_draft_id: r.po_draft_id, amount_krw: r.amount_krw, replied_at: r.replied_at, linked_plan_ids: r.linked_plan_ids,
          after_min_balance_krw: r.cash_basis.after?.min_balance_krw, min_date: r.cash_basis.after?.min_date, floor_krw: r.cash_basis.floor_krw, reason: r.cash_basis.reason })) },
      affected_plans: affected,
      deadline_lapses: ctx.plans().map((p) => lapseStory(p.plan_id)).filter(Boolean),
      cash_window: w ? { window_version: w.window_version, scenario_id: w.scenario_id, shortfall_window_start: w.shortfall_window_start, shortfall_window_end: w.shortfall_window_end,
        min_balance_krw: w.min_balance_krw ?? null, min_date: w.min_date ?? null, segments: w.segments ?? [] } : null,
    };
  });
  ctx.route('GET', '/plans/:plan_id', ({ params }) => {
    const planId = params.plan_id;
    if (!store.planStateRaw(planId)) throw ctx.httpError(404, `기안이 없습니다: ${planId}`);
    const cid = store.deadlineByPlan(planId)?.commitment_id;
    const inWindowReview = (r) => (r.after?.approvers ?? []).some((a) => a.plan_id === planId) || (cid && [...(r.after?.kept_commitment_ids ?? []), ...(r.after?.changed_commitment_ids ?? [])].includes(cid));
    return {
      sim_clock: ctx.clock.today(), connected: engine.connected(), plan: plansById().get(planId) ?? null,
      plan_state: store.planState(planId), deadline_schedule: store.deadlineByPlan(planId),
      info_requests: store.requests({ plan_id: planId }),
      // 이 기안이 근거에 든 구간 재검토(plan_id=NONE)도 함께 보여준다
      reviews: [...store.reviews({ plan_id: planId }), ...store.reviews({ target_type: 'cash_window' }).filter(inWindowReview)],
      holds: store.holds({ plan_id: planId }),
      warnings: store.warnings({ plan_id: planId }), approval_replies: store.replies({ plan_id: planId }),
      mock: store.deliveries().filter((x) => x.plan_id === planId),
      po_replies: poReplies().filter((r) => r.linked_plan_ids.includes(planId)),
      lapse_story: lapseStory(planId),
    };
  });
  ctx.route('GET', '/deadlines', ({ query }) => ({ deadlines: store.deadlines({ approver: query.get('approver') || undefined }) }));
  ctx.route('GET', '/requests', ({ query }) => ({ info_requests: store.requests(Object.fromEntries(query)) }));
  ctx.route('GET', '/reviews', ({ query }) => ({ reviews: store.reviews(Object.fromEntries(query)) }));
  ctx.route('GET', '/holds', ({ query }) => ({ holds: store.holds(Object.fromEntries(query)) }));
  ctx.route('GET', '/open-issues', () => ({ open_issues: store.issues() }));
  ctx.route('GET', '/warnings', ({ query }) => ({ warnings: store.warnings(Object.fromEntries(query)) }));
  ctx.route('GET', '/schedule', () => ({
    sim_clock: ctx.clock.today(), scenarios: engine.getScenarios(), next_date: engine.nextEventDate(), rows: engine.schedule(), connected: engine.connected(),
  }));
  ctx.route('GET', '/scenarios', () => ({ scenarios: engine.getScenarios() }));
  // L8: 직접 처리 기안과, 그중 지금 사용자의 행동을 기다리는 것(pending)
  ctx.route('GET', '/direct', () => ({ direct_plans: engine.getDirectPlans(), pending: views.directPending() }));
  ctx.route('POST', '/direct/all-auto', () => ({ direct_plans: engine.setAllAuto(), pending: [] }));
  // 사용자 결정(2026-11-15) 화면: 왼쪽 기안 담당자 묶음, 오른쪽 행동 단위 사건 사슬
  ctx.route('GET', '/user/home', () => views.home());
  ctx.route('GET', '/user/plans/:plan_id', ({ params }) => views.planView(params.plan_id));
  ctx.route('GET', '/flow', ({ query }) => views.flow({ plan_id: query.get('plan_id') || null, limit: Number(query.get('limit') || 8) }));
  ctx.route('GET', '/describe/:event_id', ({ params }) => {
    const e = ctx.events.get(params.event_id);
    if (!e) throw ctx.httpError(404, `사건이 없습니다: ${params.event_id}`);
    return { card: views.describeAny(e) };
  });
  ctx.route('POST', '/plans/:plan_id/direct', ({ params, body }) => ({ direct_plans: engine.setDirect(params.plan_id, body.on !== false) }));
  ctx.route('POST', '/scenarios', ({ body }) => ({ scenarios: engine.setScenarios(body.scenarios ?? []) }));
  ctx.route('POST', '/holds', ({ body }) => engine.placeHold(body));
  ctx.route('POST', '/holds/:hold_id/cancel', async ({ params }) => { await engine.cancelHold(params.hold_id); return { ok: true }; });
  ctx.route('POST', '/reviews/:review_id/close', async ({ params, body }) => {
    const r = store.reviewRaw(params.review_id);
    if (!r || r.review_status !== '열림') throw ctx.httpError(409, '열린 재검토가 아닙니다');
    if (r.review_kind !== '사람 판단') throw ctx.httpError(409, '사람 판단 재검토만 화면에서 닫는다. 나머지는 소유 문제의 재계산으로 닫힌다');
    if (!['유지', '변경'].includes(body.outcome) || !body.rationale) throw ctx.httpError(400, 'outcome(유지/변경)과 rationale이 필요합니다');
    await engine.closeReview(r, { outcome: body.outcome, after: { decided_by: body.reviewer_role ?? null }, rationale: body.rationale, source_type: '사람입력' });
    await engine.recompute(r.plan_id);
    return { ok: true };
  });
  ctx.route('POST', '/plans/:plan_id/confirm', async ({ params }) => { await engine.confirmPlan(params.plan_id); return store.planState(params.plan_id); });
  ctx.route('POST', '/plans/:plan_id/withdraw', async ({ params, body }) => { await engine.withdrawPlan(params.plan_id, body.reason); return store.planState(params.plan_id); });

  // AI 작성 작업: 새 사건의 영향 요약(event_impact_summary). 규칙이 고른 대상만 넘기고, AI는 계산·판정하지 않는다.
  ctx.route('POST', '/impact-summary', async ({ body }) => {
    const event = ctx.events.get(body.event_id);
    if (!event) throw ctx.httpError(404, `사건이 없습니다: ${body.event_id}`);
    const reviews = store.reviews({}).filter((r) => r.trigger_event_id === event.event_id);
    const items = {
      event: { event_id: event.event_id, event_type: event.event_type, plan_id: event.plan_id, occurred_at: event.occurred_at, source_type: event.source_type, is_simulation: event.is_simulation, payload: event.payload },
      reviews: reviews.map((r) => ({ review_id: r.review_id, target_type: r.target_type, target_id: r.target_id, review_status: r.review_status, outcome: r.outcome, before: r.before, after: r.after })),
      plan_states: [...new Set([event.plan_id, ...store.reviewsRaw('trigger_event_id = ?', event.event_id).map((r) => r.plan_id)])]
        .map((id) => store.planState(id)).filter(Boolean),
    };
    const result = await ctx.ai.call({
      ai_task_type: 'write', ai_task_name: 'event_impact_summary', plan_id: event.plan_id,
      input_refs: [event.event_id, ...reviews.map((r) => r.review_id)],
      messages: [{ role: 'system', content: IMPACT_SYSTEM_PROMPT }, { role: 'user', content: JSON.stringify(items) }],
    });
    return { ...result, items };
  });
  ctx.route('POST', '/ai/:ai_call_id/review', async ({ params, body }) => ctx.ai.review({
    ai_call_id: params.ai_call_id, review_result: body.review_result, reviewer_role: body.reviewer_role ?? '운영 담당', plan_id: body.plan_id ?? 'NONE',
  }));
}
