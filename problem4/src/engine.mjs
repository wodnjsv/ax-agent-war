// 문제 4 실행 엔진: 마감, 확인 요청, 기한 경고, 재검토, 보류, 확정 가능, 미결, 모의 입력 실행기.
import {
  computeDeadlines, decideConfirmability, salePeriodsOverlap, supplyReviewOutcome, conditionTypes, reorderPoIds, CONFIRMABLE, RISK_ACCEPTED, SUPPLY_COND_KO,
  CASE_PLANS, TERMINAL_PLAN_STATUS,
} from './rules.mjs';

const SIM_START = '2026-07-01';
const ROUTE_RANK = { SCM: 1, MKT_TEAM: 1, MS_CEO: 2, GRP_CEO: 3 }; // 경로가 올라갈 때만 재상신(조정자 확정 (C)-3)
const APPROVER_DEPT = { GRP_CEO: 'GROUP', MS_CEO: 'MS_MGMT', MKT_TEAM: 'MKT', SCM: 'SCM' };
const DEMAND_QUESTIONS = [ // 문제 1 명세 7절의 확인 불가 항목을 수요 요청의 부속 질문으로 싣는다(문제 4 명세 9.1)
  '증가율의 근거 자료가 있는지, 있다면 작성 시점',
  '기안 배수(예상 GMV ÷ 요청액)의 산정 방법',
  '집행 예정일(settlement_date)의 의미와 판매 시작 예정일',
  'SKU별로 증가율을 달리 볼 근거가 있는지',
];
const REQUEST_TOPICS = ['demand_input', 'inbound_eta', 'supply_request', 'po_draft_overdue', 'finance_confirmation',
  'group_report', 'group_allocation', 'settlement_unapproved', 'source_unknown', 'baseline_replenishment',
  // 조정자 확정 L1: 기안 철회 뒤 발주가 이미 전달된 발주안 → SCM에 취소·조정 가능 여부 확인(문제 2가 낸다. 회신 기한 없음)
  'po_draft_orphaned'];
// caused_by로 확인 요청을 닫을 수 있는 회신 성격의 사건
const REPLY_EVENTS = new Set(['INFO_REPLIED', 'INBOUND_SCHEDULE_REVISED', 'SUPPLIER_REPLIED', 'FINANCE_CONFIRMED', 'AR_DATE_REVISED',
  'DEMAND_INPUT_REGISTERED', 'DEMAND_INPUT_REVISED']);
const ACTION_EVENT = {
  applyInboundReply: 'INBOUND_SCHEDULE_REVISED', applyFinanceReply: 'FINANCE_CONFIRMED',
  demandReply: 'INFO_REPLIED', submitApproval: 'APPROVAL_SUBMITTED', approvalReply: 'APPROVAL_REPLIED',
  selectAlternative: 'ALTERNATIVE_SELECTED', planConfirm: 'PLAN_CONFIRMED', groupAllocationReply: 'INFO_REPLIED',
  applySupplierReply: 'SUPPLIER_REPLIED', requestEarlySupply: 'INFO_REQUESTED', selectRecommended: 'ALTERNATIVE_SELECTED',
  defaultRules: 'ALTERNATIVE_SELECTED / PLAN_WITHDRAWN', conditionAccept: 'APPROVAL_REPLIED',
  applyBaselinePlan: 'INBOUND_SCHEDULE_REVISED', coreviaReply: 'SUPPLIER_REPLIED', riskAccept: 'APPROVAL_REPLIED',
  // 기발주 대상 Corevia 회신(날짜 고정): 문제 2가 그날 회신을 입고 일정 새 버전 하나로 묶는다(problem2/명세.md 9.6 권장 꼴)
  coreviaPoReply: 'INBOUND_SCHEDULE_REVISED',
  // 입고 처리(문제 2 v2.2 L7): 입고 실적(모의 입력)·도착 예정일 경과. 문제 2 onDay가 처리하고 순서표는 결과와 예정을 보인다
  processArrivals: 'INBOUND_SCHEDULE_REVISED',
};
const DEFAULT_TAG = '기본 모의 입력';

// 행이 내는 사건 이름(문제 3은 이 값으로 재무 확인과 회수일 지연을 가른다)
const eventTypeOf = (row) => {
  if (row.action === 'applyFinanceReply') return JSON.parse(row.params || '{}').scenario_id === 'BASE' ? 'FINANCE_CONFIRMED' : 'AR_DATE_REVISED';
  return ACTION_EVENT[row.action];
};

const ALL = 1e9; // 사건 조회 기본 상한(1000)을 넘지 않게
const PO_CANCELLED = '취소(발주안 취소)';
// 사용자 결정(2026-11-15): 기안마다 '내가 직접 처리'를 켜면 마케팅 기안 담당자의 모의 입력을 건너뛰고 화면에서 사용자가 직접 한다.
// 다른 부서(SCM·재무·승인권자·Corevia·그룹)의 회신은 계속 모의로 온다. 기본값은 PLAN-001~003 직접 처리.
export const DEFAULT_DIRECT_PLANS = ['PLAN-001', 'PLAN-002', 'PLAN-003'];
// 사건 순서표에서 마케팅 기안 담당자가 하는 행동(직접 처리 기안이면 건너뛴다)
const MARKETING_ACTIONS = new Set(['demandReply', 'requestEarlySupply', 'selectRecommended']);
export const isMarketingRow = (row) => MARKETING_ACTIONS.has(row.action)
  || (row.action === 'selectAlternative' && /^MKT/.test(JSON.parse(row.params || '{}').selected_by ?? 'MKT')); // 마감 행 computed_status: 문제 2가 발주안을 취소함

export function createEngine(ctx, store, data) {
  const { cal } = ctx;
  const today = () => ctx.clock.today();
  const emit = (e) => ctx.events.emit(e);
  const offsets = {
    judgment: Number(data.offsets.judgment_due_offset_bd),
    demand_input: Number(data.offsets.demand_input_due_offset_bd),
  };
  let scenarios = store.setting('scenarios') ?? [];
  let directPlans = store.setting('direct_plans') ?? [...DEFAULT_DIRECT_PLANS];
  const isDirect = (planId) => directPlans.includes(planId);
  const activeScenario = (s) => s === 'BASE' || scenarios.includes(s);
  const rankCache = new Map(); // `${sku}|${plan}` -> rank

  // ── 다른 모듈 읽기(없으면 null) ──
  const m = (id) => ctx.module(id);
  const safe = (fn, fallback = null) => {
    try { return fn() ?? fallback; } catch (err) { ctx.log(`다른 모듈 호출 오류: ${err.message}`); return fallback; }
  };
  const connected = () => ({ p1: Boolean(m('p1')), p2: Boolean(m('p2')), p3: Boolean(m('p3')) });
  const commitmentOfPlan = (planId) => (m('p3') ? safe(() => m('p3').commitmentBySource(planId)) : null);
  const commitmentById = (cid) => (m('p3') ? safe(() => m('p3').commitment(cid)) : null);
  const latestJudgment = (planId) => (m('p2') ? safe(() => m('p2').latestSupplyJudgment(planId)?.plan) : null);
  const judgmentHistory = (sjId) => (m('p2') ? safe(() => m('p2').supplyJudgments({ supply_judgment_id: sjId, latest_only: false }), []) : []);
  const hasValidDemand = (planId) => {
    if (m('p1')) return Boolean(safe(() => m('p1').demandInput(planId)));
    return store.requestsRaw("plan_id = ? AND request_topic = 'demand_input' AND request_status = '회신됨'", planId).length > 0;
  };
  const skusOfPlan = (planId) => (m('p1') ? safe(() => m('p1').planSkuMap({ plan_id: planId }), []).map((r) => r.sku_id) : []);
  const planOrder = (skuId) => {
    const rows = m('p2') ? safe(() => m('p2').planOrder({ sku_id: skuId }), []) : [];
    for (const r of rows) rankCache.set(`${skuId}|${r.plan_id}`, r.plan_order_rank);
    return rows;
  };
  const basePlans = () => new Map(ctx.plans().map((p) => [p.plan_id, p]));

  const nextBd = (d) => cal.nextBusinessDay(d);
  const isTerminal = (planId) => TERMINAL_PLAN_STATUS.has(store.planStateRaw(planId)?.plan_status);

  // ── 확인 요청 ──
  function defaultDue(req) {
    switch (req.request_topic) {
      case 'demand_input': return store.deadlineByPlan(req.plan_id)?.demand_input_due ?? null;
      case 'finance_confirmation': return store.deadlines().map((d) => d.judgment_due).filter(Boolean).sort()[0] ?? null;
      case 'group_allocation': return data.groupAllocation.request?.request_due_date ?? null;
      case 'group_report': case 'settlement_unapproved': return nextBd(today());
      default: return null;
    }
  }
  // 기준 수요 정기 보충 가정(범위 밖 배경 제약, 조정자 확정 (F)-1·G)은 SKU 단위로 한 번씩 SCM에 묻는다.
  // 문제 2가 SKU별로 나눠 보내면(split: true) 같은 SKU는 다시 내지 않고, 묶어 보내면 문제 2 baselineReplenishment(정기 보충 가정 행)로 SKU별로 나눈다.
  // 회신 기한은 두지 않는다(캠페인 판정·확정을 막지 않음).
  async function requestBaselineReplenishment(req) {
    if (req.split && req.subject_id) {
      const have = store.requestsRaw("request_topic = 'baseline_replenishment' AND subject_id = ?", req.subject_id)[0];
      return have ? store.request(have.request_id) : null;
    }
    const rows = (m('p2')?.baselineReplenishment ? safe(() => m('p2').baselineReplenishment({}), []) : [])
      .filter((r) => (req.sku_id ? r.sku_id === req.sku_id : true));
    const out = [];
    for (const r of rows) {
      const have = store.requestsRaw("request_topic = 'baseline_replenishment' AND subject_id = ?", r.sku_id)[0];
      if (have) { out.push(store.request(have.request_id)); continue; }
      out.push(await requestInfo({
        request_topic: 'baseline_replenishment', requested_to: 'SCM', plan_id: 'NONE', subject_type: 'baseline_replenishment', subject_id: r.sku_id,
        request_kind: 'initial', request_due_date: null, caused_by: req.caused_by ?? null, split: true,
        questions: [`${r.sku_id}: 기준 수요 보충 계획(수량·발주 예정일·도착 예정일·Corevia 확약 여부)을 확인해 주세요(현재 ${r.plan_status ?? '미회신'}). 범위 밖(SCM 정기 발주 소관)이며 캠페인 발주안·현금 재전망에는 넣지 않는다`],
      }, '기준 수요 정기 보충 가정(범위 밖) SKU별 확인'));
    }
    if (!out.length) return null;
    return { ...out[0], split_request_ids: out.map((x) => x.request_id) };
  }
  async function requestInfo(req, emittedNote = null) {
    if (!REQUEST_TOPICS.includes(req.request_topic)) throw new Error(`request_topic 값이 아닙니다: ${req.request_topic}`);
    if (req.request_topic === 'baseline_replenishment') {
      const r = await requestBaselineReplenishment(req);
      if (r || !req.split) return r; // 나눠 온 SKU는 처음 한 번만 아래에서 낸다
    }
    const row = {
      request_id: store.nextRequestId(), request_topic: req.request_topic, requested_to: req.requested_to ?? 'SYSTEM',
      plan_id: req.plan_id ?? 'NONE', subject_type: req.subject_type ?? null, subject_id: req.subject_id ?? null,
      request_kind: req.request_kind ?? 'initial', request_due_date: req.request_due_date ?? defaultDue(req),
      request_status: '회신 대기', questions: store.J(req.questions ?? null), caused_by: req.caused_by ?? null,
      emitted_by: 'p4', created_at: today(), event_id: null, replied_event_id: null, replied_at: null,
    };
    store.saveRequest(row);
    if (row.request_kind === 'rerequest' || row.request_kind === 'correction') {
      for (const old of store.requestsRaw("plan_id = ? AND request_topic = ? AND request_status IN ('기한 경과','회신 대기') AND request_id <> ?",
        row.plan_id, row.request_topic, row.request_id)) {
        store.saveRequest({ ...old, request_status: '이관' });
      }
    }
    const ev = await emit({
      event_type: 'INFO_REQUESTED', source_type: '계산', plan_id: row.plan_id, subject_type: 'info_request', subject_id: row.request_id,
      caused_by: row.caused_by, generation_reason: emittedNote,
      payload: { ...store.request(row.request_id), questions: req.questions ?? [] },
    });
    store.saveRequest({ ...store.requestRaw(row.request_id), event_id: ev.event_id });
    return store.request(row.request_id);
  }
  function registerForeignRequest(e) { // 다른 모듈이 INFO_REQUESTED를 직접 낸 경우 표에 올린다
    if (e.emitted_by === 'p4') return;
    const p = e.payload ?? {};
    const id = p.request_id ?? `REQ-${e.event_id}`;
    if (store.requestRaw(id)) return;
    store.saveRequest({
      request_id: id, request_topic: p.request_topic ?? 'source_unknown', requested_to: p.requested_to ?? null,
      plan_id: e.plan_id, subject_type: p.subject_type ?? e.subject_type, subject_id: p.subject_id ?? e.subject_id,
      request_kind: p.request_kind ?? 'initial', request_due_date: p.request_due_date ?? null, request_status: '회신 대기',
      questions: store.J(p.questions ?? null), event_id: e.event_id, caused_by: e.caused_by, emitted_by: e.emitted_by,
      created_at: e.occurred_at, replied_event_id: null, replied_at: null,
    });
  }
  async function closeRequest(requestId, e) {
    const r = store.requestRaw(requestId);
    if (!r || !['회신 대기', '기한 경과', '보류'].includes(r.request_status)) return;
    store.saveRequest({ ...r, request_status: '회신됨', replied_event_id: e.event_id, replied_at: e.occurred_at });
    for (const rv of store.reviewsRaw("target_type = 'info_request' AND target_id = ? AND review_status = '열림'", requestId)) {
      await closeReview(rv, { outcome: null, after: { request_status: '회신됨', replied_at: e.occurred_at }, rationale: `회신 도착(${e.event_id})` });
    }
    // 재요청·정정 요청에 회신이 오면, 그 요청으로 이관된 원 요청의 후속 재검토도 닫는다
    if (r.plan_id === 'NONE') return;
    for (const old of store.requestsRaw("plan_id = ? AND request_topic = ? AND request_status = '이관'", r.plan_id, r.request_topic)) {
      for (const rv of store.reviewsRaw("target_type = 'info_request' AND target_id = ? AND review_status = '열림'", old.request_id)) {
        await closeReview(rv, { outcome: null, after: { request_status: '이관', replied_request_id: requestId, replied_at: e.occurred_at }, rationale: `이관된 요청 ${requestId}에 회신 도착(${e.event_id})` });
      }
    }
  }

  // ── 재검토 ──
  async function openReview({ review_kind, trigger, target_type, target_id, plan_id, commitment_id = null, before = null, due_date = null, rejudge = true }) {
    const row = {
      review_id: store.nextReviewId(), review_kind, trigger_event_id: trigger?.event_id ?? null, target_type, target_id,
      plan_id: plan_id ?? 'NONE', commitment_id, due_date: due_date ?? nextBd(today()), review_status: '열림', outcome: null,
      before: store.J(before), after: null, rationale: null, opened_event_id: null, closed_event_id: null,
    };
    store.saveReview(row);
    const ev = await emit({
      event_type: 'REVIEW_OPENED', source_type: review_kind === '사람 판단' ? '사람입력' : '계산', is_synthetic: review_kind === '사람 판단',
      plan_id: row.plan_id, subject_type: 'review', subject_id: row.review_id, caused_by: row.trigger_event_id,
      payload: { review_id: row.review_id, review_kind, trigger_event_id: row.trigger_event_id, target_type, target_id, due_date: row.due_date, rejudge },
    });
    store.saveReview({ ...store.reviewRaw(row.review_id), opened_event_id: ev.event_id });
    return store.reviewRaw(row.review_id);
  }
  async function closeReview(raw, { outcome, after, rationale, source_type = '계산', caused_by = null }) {
    const r = store.reviewRaw(raw.review_id);
    if (!r || r.review_status !== '열림') return;
    store.saveReview({ ...r, review_status: '종결', outcome, after: store.J(after), rationale });
    const ev = await emit({
      event_type: 'REVIEW_CLOSED', source_type, is_synthetic: source_type === '사람입력', plan_id: r.plan_id,
      subject_type: 'review', subject_id: r.review_id, caused_by: caused_by ?? r.opened_event_id, // 기안이 끝나 닫으면 그 종결 사건이 원인
      payload: { review_id: r.review_id, outcome, before: store.P(r.before), after, rationale },
    });
    store.saveReview({ ...store.reviewRaw(r.review_id), closed_event_id: ev.event_id });
  }

  const judgmentSnapshot = (j) => j && ({
    supply_judgment_id: j.supply_judgment_id, supply_judgment_version: j.supply_judgment_version,
    supply_verdict: j.supply_verdict, first_shortage_week: j.first_shortage_week ?? null,
  });

  async function openSupplyReview(planId, trigger) {
    if (isTerminal(planId)) return; // 종결된 기안의 판정은 다시 열지 않는다
    const j = latestJudgment(planId);
    if (!j?.supply_judgment_id) return;
    if (store.reviewsRaw("target_type = 'supply_judgment' AND plan_id = ? AND review_status = '열림'", planId).length) return;
    // 문제 2가 이 트리거로 이미 확인했고 결론이 그대로면 재판정을 요청하지 않고 '유지'로 닫는다(사건 없이 재검토 표에 기록)
    const chk = m('p2')?.judgmentCheck ? safe(() => m('p2').judgmentCheck({ plan_id: planId, trigger_event_id: trigger.event_id })) : null;
    if (chk?.checked && chk.changed === false) {
      const snap = judgmentSnapshot(j);
      store.saveReview({ review_id: store.nextReviewId(), review_kind: '전제 변경', trigger_event_id: trigger.event_id, target_type: 'supply_judgment',
        target_id: j.supply_judgment_id, plan_id: planId, commitment_id: null, due_date: today(), review_status: '종결', outcome: '유지',
        before: store.J(snap), after: store.J(snap), rationale: `문제 2 확인(judgmentCheck): ${trigger.event_type}에도 전제·결론 그대로(v${chk.supply_judgment_version ?? j.supply_judgment_version}). 재판정 요청 없음`,
        opened_event_id: null, closed_event_id: null });
      return;
    }
    // 문제 2가 트리거에 반응해 이미 다시 판정했으면 직전 버전을 before로 두고 바로 닫는다.
    const alreadyRejudged = ctx.events.query({ plan_id: planId, event_type: 'SUPPLY_JUDGED', limit: ALL }).some((e) => e.caused_by === trigger.event_id);
    const prev = alreadyRejudged
      ? judgmentHistory(j.supply_judgment_id).filter((h) => h.supply_judgment_version < j.supply_judgment_version).at(-1) ?? null
      : j;
    const due = store.deadlineByPlan(planId)?.judgment_due;
    const review = await openReview({
      review_kind: '전제 변경', trigger, target_type: 'supply_judgment', target_id: j.supply_judgment_id, plan_id: planId,
      before: judgmentSnapshot(prev), due_date: due && due >= today() ? due : nextBd(today()), rejudge: !alreadyRejudged,
    });
    if (alreadyRejudged) {
      const outcome = prev ? supplyReviewOutcome(prev, j) : '변경';
      // 유지 근거: 직전·새 판정 버전의 결론을 함께 적는다(조정자 확정 (F)-3)
      const verdicts = `v${prev?.supply_judgment_version ?? '-'} ${prev?.supply_verdict ?? '-'} → v${j.supply_judgment_version} ${j.supply_verdict}`;
      await closeReview(review, {
        outcome, after: judgmentSnapshot(j),
        rationale: `문제 2가 ${trigger.event_type}에 반응해 다시 판정(${verdicts})` + (outcome === '유지'
          ? `. 결론 같음${j.first_shortage_week ? `(첫 부족 주 ${j.first_shortage_week})` : ''}`
          : `. 결론 바뀜`),
      });
    }
  }
  async function closeSupplyReviews(e) {
    for (const r of store.reviewsRaw("target_type = 'supply_judgment' AND plan_id = ? AND review_status = '열림'", e.plan_id)) {
      if (e.caused_by !== r.opened_event_id && e.caused_by !== r.trigger_event_id) continue;
      const after = { ...judgmentSnapshot(e.payload ?? {}), supply_judgment_id: e.payload?.supply_judgment_id ?? r.target_id };
      const before = store.P(r.before);
      const outcome = supplyReviewOutcome(before, after);
      await closeReview(r, {
        outcome, after,
        rationale: `다시 판정(v${before?.supply_judgment_version ?? '-'} ${before?.supply_verdict ?? '-'} → v${after.supply_judgment_version ?? '-'} ${after.supply_verdict ?? '-'})` + (outcome === '유지'
          ? `. 결론 같음${after.first_shortage_week ? `(첫 부족 주 ${after.first_shortage_week})` : ''}`
          : '. 결론 바뀜'),
      });
    }
  }
  function laterPlans(planId, { useCacheForSelf = false } = {}) {
    const self = m('p1') ? safe(() => m('p1').demandInput(planId)) : null;
    const out = new Set();
    for (const sku of skusOfPlan(planId)) {
      const rows = planOrder(sku);
      const mine = rows.find((r) => r.plan_id === planId);
      const myRank = mine?.plan_order_rank ?? (useCacheForSelf ? rankCache.get(`${sku}|${planId}`) : undefined);
      for (const r of rows) {
        if (r.plan_id === planId) continue;
        if (myRank !== undefined && !(r.plan_order_rank > myRank)) continue;
        if (myRank === undefined && !useCacheForSelf) continue;
        if (self && !salePeriodsOverlap(cal, self, r)) continue;
        out.add(r.plan_id);
      }
    }
    return [...out];
  }

  async function windowKeptReview(e, cause, old, p, sid) {
    const inWin = (dt) => dt && dt >= p.shortfall_window_start && dt <= p.shortfall_window_end;
    const approvers = (m('p3') ? safe(() => m('p3').listCommitments({ commitment_type: '기안' }), []) : [])
      .filter((c) => inWin(c.cash_outflow_date) || ['PLAN-004', 'PLAN-024'].includes(c.plan_id))
      .map((c) => ({ plan_id: c.plan_id, commitment_id: c.commitment_id, cash_outflow_date: c.cash_outflow_date, approver: c.approver, in_window: Boolean(inWin(c.cash_outflow_date)) }));
    const before = { window_version: old.window_version, shortfall_window_start: old.start, shortfall_window_end: old.end, scenario_id: sid };
    const after = { window_version: p.window_version, shortfall_window_start: p.shortfall_window_start, shortfall_window_end: p.shortfall_window_end, scenario_id: sid, approvers };
    const review = await openReview({ review_kind: '전제 변경', trigger: cause, target_type: 'cash_window', target_id: p.window_version, plan_id: 'NONE', before, rejudge: false });
    await closeReview(review, { outcome: '유지', after,
      rationale: `${cause.event_type}에도 하회 구간 ${old.start}~${old.end} → ${p.shortfall_window_start}~${p.shortfall_window_end} 그대로. 경로 변경 없음(승인권자 유지: ${approvers.filter((a) => a.in_window).length}건 구간 안 ${[...new Set(approvers.map((a) => a.approver))].join('·')})` });
  }

  // 구간이 바뀌었지만 문제 3 재대조(recheck_summary)에서 결론이 같은 약정: ROUTE_JUDGED가 없으므로 구간 재검토 하나로 열고 바로 '유지'로 닫는다
  async function windowRecheckReview(e, old, p, sid) {
    const rs = p.recheck_summary;
    const before = { window_version: old.window_version, shortfall_window_start: old.start, shortfall_window_end: old.end, scenario_id: sid };
    const after = { window_version: p.window_version, shortfall_window_start: p.shortfall_window_start, shortfall_window_end: p.shortfall_window_end, scenario_id: sid,
      kept_commitment_ids: rs.kept_commitment_ids, changed_commitment_ids: (rs.changed_commitments ?? []).map((x) => x.commitment_id) };
    const review = await openReview({ review_kind: '전제 변경', trigger: e, target_type: 'cash_window', target_id: p.window_version, plan_id: 'NONE', before, rejudge: false });
    await closeReview(review, { outcome: '유지', after,
      rationale: `문제 3 재대조(recheck_summary): 구간 ${old.start}~${old.end} → ${p.shortfall_window_start}~${p.shortfall_window_end}. 결론 같은 약정 ${rs.kept_commitment_ids.length}건 유지(${rs.kept_rationale ?? '-'}), 바뀐 약정 ${after.changed_commitment_ids.length}건은 경로 재검토` });
  }

  async function openRouteReview(commitmentId, trigger, { review_kind = '전제 변경' } = {}) {
    const d = store.deadlineRaw(commitmentId);
    if (d?.commitment_type === '기안' && isTerminal(d.plan_id)) return; // 종결된 기안의 약정은 다시 열지 않는다
    if (d?.commitment_type === '발주안' && ['승인', '거절'].includes(commitmentById(commitmentId)?.approval_status)) return; // 결정이 끝난 발주안
    if (d?.computed_status === PO_CANCELLED) return; // 취소된 발주안
    if (!d || store.reviewsRaw("target_type = 'route_judgment' AND commitment_id = ? AND review_status = '열림'", commitmentId).length) return;
    const before = { route_judgment_id: d.route_judgment_id, approver: d.approver, submission_due: d.submission_due };
    const already = ctx.events.query({ event_type: 'ROUTE_JUDGED', limit: ALL })
      .find((e) => e.caused_by === trigger.event_id && e.payload?.commitment_id === commitmentId);
    const review = await openReview({
      review_kind, trigger, target_type: 'route_judgment', target_id: d.route_judgment_id, plan_id: d.plan_id,
      commitment_id: commitmentId, before, rejudge: !already,
    });
    if (already) await closeRouteReviews(already, { force: review.review_id });
  }
  // 하루가 지나도 ROUTE_JUDGED가 오지 않은 경로 재검토: 문제 3 약정의 경로 판정이 그대로면 결론이 같아 재판정하지 않은 것이므로 '유지'로 닫는다
  async function closeStaleRouteReviews(D) {
    for (const r of store.reviewsRaw("target_type = 'route_judgment' AND review_status = '열림'")) {
      const opened = r.opened_event_id ? ctx.events.get(r.opened_event_id)?.occurred_at : null;
      if (!opened || opened >= D) continue;
      const c = commitmentById(r.commitment_id);
      const before = store.P(r.before) ?? {};
      if (!c || c.route_judgment_id !== before.route_judgment_id || c.approver !== before.approver) continue;
      const d = store.deadlineRaw(r.commitment_id);
      await closeReview(r, { outcome: '유지', after: { route_judgment_id: c.route_judgment_id, approver: c.approver, submission_due: d?.submission_due ?? null },
        rationale: `문제 3 재판정 없음(경로 판정 ${c.route_judgment_id} 그대로): 경로 ${c.approver}·상신 마감 ${d?.submission_due ?? '-'} 유지` });
    }
  }
  async function closeRouteReviews(e, { force = null } = {}) {
    const cid = e.payload?.commitment_id;
    const d = store.deadlineRaw(cid);
    for (const r of store.reviewsRaw("target_type = 'route_judgment' AND commitment_id = ? AND review_status = '열림'", cid)) {
      if (force && r.review_id !== force) continue;
      const before = store.P(r.before);
      const after = { route_judgment_id: e.payload?.route_judgment_id, approver: e.payload?.approver ?? d?.approver, submission_due: d?.submission_due };
      const same = before?.approver === after.approver && before?.submission_due === after.submission_due;
      await closeReview(r, {
        outcome: same ? '유지' : '변경', after,
        rationale: same ? `경로 ${after.approver}·상신 마감 ${after.submission_due} 유지` : `경로 ${before?.approver} → ${after.approver}`,
      });
    }
  }

  // ── 경고 ──
  async function warn(rule, { plan_id = 'NONE', commitment_id = null, request_id = null, missed_field, due_date, recipients }) {
    const key = `${rule}|${commitment_id ?? request_id}|${missed_field}|${due_date}`;
    if (store.warningExists(key)) return null;
    const def = data.warningRules[rule];
    const ev = await emit({
      event_type: 'DEADLINE_WARNED', source_type: '계산', is_simulation: true, plan_id,
      subject_type: commitment_id ? 'commitment' : 'info_request', subject_id: commitment_id ?? request_id,
      effective_at: due_date, premise_refs: ['S4-02', data.warningRules[rule]?.record_id].filter(Boolean),
      payload: { warning_rule: rule, plan_id, commitment_id, request_id, missed_field, due_date, recipients, message: def?.message ?? null },
    });
    store.saveWarning({
      warn_key: key, event_id: ev.event_id, warning_rule: rule, plan_id, commitment_id, request_id, missed_field, due_date,
      recipients: store.J(recipients), message: def?.message ?? null, occurred_at: ev.occurred_at,
    });
    return ev;
  }

  // 마감이 지난 항목 점검(D 이전 마감). 같은 경고는 한 번만 낸다.
  async function checkPastDue(d, D) {
    if (d.computed_status === PO_CANCELLED) return; // 취소된 발주안에는 경고를 내지 않는다
    const isPlan = d.commitment_type === '기안';
    if (isPlan && isTerminal(d.plan_id)) return;
    const c = commitmentById(d.commitment_id);
    const status = c?.approval_status;
    if (isPlan && d.demand_input_due && d.demand_input_due < D && !hasValidDemand(d.plan_id)) {
      const ev = await warn('W1', { plan_id: d.plan_id, commitment_id: d.commitment_id, missed_field: 'demand_input_due', due_date: d.demand_input_due, recipients: ['MKT'] });
      if (ev) {
        const initial = store.requestsRaw("plan_id = ? AND request_topic = 'demand_input' AND request_status = '회신 대기'", d.plan_id).at(-1);
        if (initial) {
          store.saveRequest({ ...initial, request_status: '기한 경과' });
          await openReview({ review_kind: '기한 경과 후속', trigger: ev, target_type: 'info_request', target_id: initial.request_id, plan_id: d.plan_id, due_date: d.submission_due >= D ? d.submission_due : nextBd(D) });
        }
        await requestInfo({ request_topic: 'demand_input', requested_to: 'MKT', plan_id: d.plan_id, subject_type: 'plan', subject_id: d.plan_id,
          request_kind: 'rerequest', request_due_date: d.submission_due >= D ? d.submission_due : nextBd(D), caused_by: ev.event_id, questions: DEMAND_QUESTIONS }, 'W1 뒤 재요청');
      }
    }
    if (isPlan && d.judgment_due && d.judgment_due < D) {
      const j = latestJudgment(d.plan_id);
      const supplyMissing = m('p2') ? (!j || j.supply_verdict === '판정불가') : false;
      const financeMissing = c ? c.finance_confirmation_status !== '확인됨' : false;
      if (supplyMissing || financeMissing) {
        await warn('W2', { plan_id: d.plan_id, commitment_id: d.commitment_id, missed_field: 'judgment_due', due_date: d.judgment_due,
          recipients: [supplyMissing && 'SCM', financeMissing && 'FIN'].filter(Boolean) });
      }
    }
    if (!c) return;
    if (d.submission_due && d.submission_due < D && status === '미상신') {
      await warn('W3', { plan_id: d.plan_id, commitment_id: d.commitment_id, missed_field: 'submission_due', due_date: d.submission_due, recipients: [isPlan ? 'MKT' : 'SCM', 'FIN'] });
    }
    if (d.first_reply_due && d.first_reply_due < D && status === '결재 대기') {
      await warn('W4', { plan_id: d.plan_id, commitment_id: d.commitment_id, missed_field: 'first_reply_due', due_date: d.first_reply_due, recipients: [d.approver] });
    }
    if (['settlement_date', 'planned_order_date'].includes(d.anchor_basis) && d.approval_anchor_date < D && !['승인', '거절'].includes(status)) {
      const ev = await warn('W6', { plan_id: d.plan_id, commitment_id: d.commitment_id, missed_field: 'approval_anchor_date', due_date: d.approval_anchor_date, recipients: [d.approver, isPlan ? 'MKT' : 'SCM', 'FIN'] });
      if (ev && isPlan) {
        await requestInfo({ request_topic: 'settlement_unapproved', requested_to: 'FIN', plan_id: d.plan_id, subject_type: 'commitment', subject_id: d.commitment_id,
          caused_by: ev.event_id, questions: ['미승인 상태로 집행 예정일이 지났을 때 실제로 집행되는지(원본에 규칙 없음)'] }, 'W6 확인 요청');
      }
    }
  }
  async function checkFinalReply(d, D) {
    if (d.final_reply_due !== D || d.computed_status === PO_CANCELLED) return;
    if (d.commitment_type === '기안' && isTerminal(d.plan_id)) return;
    const status = commitmentById(d.commitment_id)?.approval_status;
    if (status === undefined || ['승인', '거절'].includes(status)) return;
    await warn('W5', { plan_id: d.plan_id, commitment_id: d.commitment_id, missed_field: 'final_reply_due', due_date: d.final_reply_due,
      recipients: [d.approver, d.commitment_type === '기안' ? 'MKT' : 'SCM'] });
  }
  async function checkRequests(D) {
    for (const r of store.requestsRaw("request_status = '회신 대기' AND request_due_date IS NOT NULL AND request_due_date < ?", D)) {
      if (r.request_topic === 'demand_input' && r.request_kind === 'initial') continue; // W1이 맡는다
      const ev = await warn('W7', { plan_id: r.plan_id, request_id: r.request_id, missed_field: 'request_due_date', due_date: r.request_due_date, recipients: [r.requested_to] });
      store.saveRequest({ ...store.requestRaw(r.request_id), request_status: '기한 경과' });
      if (ev) await openReview({ review_kind: '기한 경과 후속', trigger: ev, target_type: 'info_request', target_id: r.request_id, plan_id: r.plan_id });
    }
  }

  // ── 보류 ──
  async function resumeHold(h, reason, trigger = null) {
    store.saveHold({ ...h, hold_status: reason === '조건 충족' ? '재개(조건 충족)' : '재개(기한 경과)' });
    await emit({ event_type: 'HOLD_RESUMED', source_type: '계산', plan_id: h.plan_id, subject_type: 'hold', subject_id: h.hold_id,
      caused_by: trigger?.event_id ?? h.event_id, payload: { hold_id: h.hold_id, resume_reason: reason } });
  }
  async function placeHold(input) {
    for (const k of ['target_type', 'target_id', 'hold_owner_dept', 'hold_due_date', 'resume_condition', 'hold_reason']) {
      if (!input[k]) throw ctx.httpError(400, `보류에는 ${k}가 필요합니다(S4-03)`);
    }
    if (!input.resume_condition.event_type) throw ctx.httpError(400, 'resume_condition.event_type이 필요합니다');
    const planId = input.plan_id ?? 'NONE';
    const d = planId !== 'NONE' ? store.deadlineByPlan(planId) : null;
    if (d?.submission_due) {
      if (d.submission_due < today()) throw ctx.httpError(409, `상신 마감(${d.submission_due})이 지나 보류할 수 없습니다. 상신·결정 경로로 갑니다(S4-03)`);
      if (input.hold_due_date > d.submission_due) throw ctx.httpError(400, `재개 기한은 상신 마감(${d.submission_due}) 이하여야 합니다(S4-03)`);
    }
    const row = {
      hold_id: store.nextHoldId(), target_type: input.target_type, target_id: input.target_id, plan_id: planId,
      hold_owner_dept: input.hold_owner_dept, hold_due_date: input.hold_due_date, resume_condition: store.J(input.resume_condition),
      hold_reason: input.hold_reason, hold_status: '보류 중', event_id: null,
    };
    store.saveHold(row);
    const ev = await emit({ event_type: 'HOLD_PLACED', source_type: '사람입력', is_synthetic: true, plan_id: planId, actor_dept: input.hold_owner_dept,
      subject_type: 'hold', subject_id: row.hold_id, payload: { ...store.holds({}).find((h) => h.hold_id === row.hold_id) } });
    store.saveHold({ ...store.holdRaw(row.hold_id), event_id: ev.event_id });
    await recompute(planId);
    return store.holds({}).find((h) => h.hold_id === row.hold_id);
  }
  async function cancelHold(holdId) {
    const h = store.holdRaw(holdId);
    if (!h || h.hold_status !== '보류 중') throw ctx.httpError(409, '보류 중인 건이 아닙니다');
    store.saveHold({ ...h, hold_status: '해제' });
    await emit({ event_type: 'HOLD_CANCELLED', source_type: '사람입력', is_synthetic: true, plan_id: h.plan_id, subject_type: 'hold', subject_id: holdId, payload: { hold_id: holdId } });
    await recompute(h.plan_id);
  }

  // ── 확정 가능 ──
  // 승인권자의 '공급 위험 수용' 회신(가장 최근). 승인 상태의 속성이고 공급 판정·입고 상태는 바꾸지 않는다
  function riskAcceptanceOf(commitmentId) {
    const r = store.replies({ commitment_id: commitmentId }).filter((x) => (x.conditions ?? []).some((c) => c.acceptance_type === '공급 위험 수용')).at(-1);
    if (!r) return null;
    const c = r.conditions.find((x) => x.acceptance_type === '공급 위험 수용');
    return { accepted_condition_types: c.accepted_condition_types ?? [], approver: r.approver, replied_at: r.replied_at, approval_reply_id: r.approval_reply_id, supply_judgment_id: c.ref_id ?? null };
  }
  async function recompute(planId) {
    const st = store.planStateRaw(planId);
    if (!st) return;
    const c = commitmentOfPlan(planId);
    const supply = latestJudgment(planId);
    const reply = c ? store.latestReply(c.commitment_id) : null;
    // 확정을 막는 것은 전제 변경·사람 판단 재검토다. 기한 경과 후속(회신 독촉)은 막지 않는다(그룹 보고 미회신 등).
    const openReviewIds = store.reviewsRaw("plan_id = ? AND review_status = '열림' AND review_kind <> '기한 경과 후속'", planId).map((r) => r.review_id);
    const holdIds = store.holdsRaw("plan_id = ? AND hold_status = '보류 중'", planId).map((h) => h.hold_id);
    const humanConditionOk = c ? store.reviewsRaw("commitment_id = ? AND review_kind = '사람 판단' AND review_status = '종결' AND outcome = '유지'", c.commitment_id).length > 0 : false;
    const drafts = m('p2') && reorderPoIds(supply).some((id) => !id) ? safe(() => m('p2').poDrafts({ plan_id: planId }), []) : [];
    const poIds = (supply?.condition_basis ?? []).filter((x) => x.condition_type === 'reorder_required')
      .map((x) => x.po_draft_id ?? drafts.filter((d) => !x.sku_id || d.sku_id === x.sku_id).at(-1)?.po_draft_id ?? null);
    const rejectedPoIds = poIds.filter((id) => id && commitmentOfPlan(id)?.approval_status === '거절');
    const pendingPoIds = poIds.filter((id) => !id || !['승인', '거절'].includes(commitmentOfPlan(id)?.approval_status)).map((id) => id ?? '(발주안 미생성)');
    const risk = c ? riskAcceptanceOf(c.commitment_id) : null;
    const res = decideConfirmability({ plan_status: st.plan_status, supply, approval: c, reply, openReviewIds, holdIds, humanConditionOk,
      connected: { p2: Boolean(m('p2')), p3: Boolean(m('p3')) }, reorder: { pendingPoIds, rejectedPoIds }, risk });
    const changed = res.plan_confirmability !== st.plan_confirmability;
    store.savePlanState({
      ...st, plan_confirmability: res.plan_confirmability, confirmability_basis: store.J(res.confirmability_basis),
      confirmable_since: CONFIRMABLE.has(res.plan_confirmability) ? (changed ? today() : st.confirmable_since) : null,
    });
    if (changed) {
      await emit({
        event_type: 'PLAN_CONFIRMABILITY_CHANGED', source_type: '계산', is_simulation: true, plan_id: planId, subject_type: 'plan_state', subject_id: planId,
        premise_refs: [supply && `supply_judgment:${supply.supply_judgment_id}@v${supply.supply_judgment_version}`, c && `commitment:${c.commitment_id}`].filter(Boolean),
        payload: { plan_id: planId, previous: st.plan_confirmability, current: res.plan_confirmability, confirmability_basis: res.confirmability_basis },
      });
    }
  }
  const recomputeAll = async () => { for (const st of store.planStatesRaw()) await recompute(st.plan_id); };

  async function setPlanStatus(planId, status, event) {
    const st = store.planStateRaw(planId);
    const sj = latestJudgment(planId);
    const snapshot = TERMINAL_PLAN_STATUS.has(status) ? {
      decided_at: today(), plan_status: status, supply_judgment_id: sj?.supply_judgment_id ?? null, supply_judgment_version: sj?.supply_judgment_version ?? null,
      supply_verdict: sj?.supply_verdict ?? null, condition_types: conditionTypes(sj), approval_status: commitmentOfPlan(planId)?.approval_status ?? null,
      // 위험 수용 상태로 확정하면 그 사실을 남긴다(공급 판정·입고 상태는 그대로 조건부)
      ...(status === '확정' && st.plan_confirmability === RISK_ACCEPTED ? {
        confirmed_under_risk: true, supply_note: '공급 미확약 상태로 확정(위험 수용)',
        unconfirmed_condition_types: conditionTypes(sj), risk_acceptance: (() => { const c = commitmentOfPlan(planId); return c ? riskAcceptanceOf(c.commitment_id) : null; })(),
      } : {}),
    } : null;
    store.savePlanState({ ...st, plan_status: status, plan_confirmability: TERMINAL_PLAN_STATUS.has(status) ? status : st.plan_confirmability,
      decision_snapshot: store.J(snapshot) });
    const ev = await emit({ ...event, payload: { ...event.payload, ...(snapshot ? { decision_snapshot: snapshot } : {}) } });
    if (snapshot) await closeNoReplyFollowUps(planId, ev.event_id);
    return ev;
  }
  // 기안이 끝나면 열린 채 남은 기한 경과 후속 재검토를 '종결(회신 없음)'으로 닫는다(조정자 확정 (E)-다). 종결 뒤에 열린 것도 같은 날 닫는다.
  async function closeNoReplyFollowUps(planId, causedBy = null) {
    const status = store.planStateRaw(planId)?.plan_status;
    if (!TERMINAL_PLAN_STATUS.has(status)) return;
    for (const rv of store.reviewsRaw("plan_id = ? AND review_kind = '기한 경과 후속' AND review_status = '열림'", planId)) {
      const req = rv.target_type === 'info_request' ? store.requestRaw(rv.target_id) : null;
      await closeReview(rv, { outcome: null, after: { closed_reason: '회신 없음', plan_status: status, request_status: req?.request_status ?? null },
        rationale: `종결(회신 없음): 기안 ${status} 뒤에도 ${req ? `${req.request_topic} 요청 ${req.request_id}` : rv.target_id}에 회신 없음`, caused_by: causedBy });
    }
    // 그 밖의 열린 재검토(전제 변경·사람 판단)도 기안이 끝나면 더 판단할 대상이 없으므로 닫는다
    for (const rv of store.reviewsRaw("plan_id = ? AND review_kind <> '기한 경과 후속' AND review_status = '열림'", planId)) {
      await closeReview(rv, { outcome: null, after: { closed_reason: '기안 종결', plan_status: status },
        rationale: `종결(기안 ${status}): ${rv.review_kind} 재검토 대상(${rv.target_type} ${rv.target_id ?? ''})을 더 판단하지 않음`, caused_by: causedBy });
    }
  }
  async function confirmPlan(planId, { mock = false } = {}) {
    const st = store.planStateRaw(planId);
    if (!st) throw ctx.httpError(404, `기안이 없습니다: ${planId}`);
    if (st.plan_status !== '검토 중' || !CONFIRMABLE.has(st.plan_confirmability)) throw ctx.httpError(409, `확정 가능 상태가 아닙니다(${st.plan_status}/${st.plan_confirmability})`);
    if (st.contract_deadline < today()) throw ctx.httpError(409, '확정기한이 지났습니다');
    return setPlanStatus(planId, '확정', {
      event_type: 'PLAN_CONFIRMED', source_type: '사람입력', is_synthetic: true, plan_id: planId, actor_dept: 'MKT', actor_role: 'MKT-LINE-OWNER',
      subject_type: 'plan_state', subject_id: planId,
      generation_reason: mock ? `${store.planStateRaw(planId).mock_input_absent ? `${DEFAULT_TAG}(가)` : '시연 모의 입력'}: 확정 가능 다음 영업일 확정(A5)` : '화면 입력',
      payload: { plan_id: planId },
    });
  }
  async function withdrawPlan(planId, reason, { mock = false } = {}) {
    const st = store.planStateRaw(planId);
    if (!st || st.plan_status !== '검토 중') throw ctx.httpError(409, '검토 중인 기안만 철회할 수 있습니다');
    if (st.contract_deadline < today()) throw ctx.httpError(409, '확정기한이 지나 철회할 수 없습니다(정책 38~39행)');
    return setPlanStatus(planId, '철회', {
      event_type: 'PLAN_WITHDRAWN', source_type: '사람입력', is_synthetic: true, plan_id: planId, actor_dept: 'MKT', actor_role: 'MKT-LINE-OWNER',
      subject_type: 'plan_state', subject_id: planId, generation_reason: mock ? `${DEFAULT_TAG}(라): ${reason}` : '화면 입력',
      payload: { plan_id: planId, reason: reason ?? null },
    });
  }

  // ── 마감 산출 (ROUTE_JUDGED) ──
  async function onRouteJudged(e) {
    const p = e.payload ?? {};
    const cid = p.commitment_id;
    if (!cid) return;
    const c = commitmentById(cid) ?? {};
    const approver = p.approver ?? c.approver;
    const type = p.commitment_type ?? c.commitment_type;
    const std = p.std_approval_bd ?? c.std_approval_bd ?? (m('p3') ? safe(() => m('p3').approverRole(approver)?.std_approval_bd) : null);
    const anchor = p.approval_anchor_date ?? c.approval_anchor_date;
    const planId = type === '기안' ? (p.plan_id ?? c.plan_id ?? e.plan_id) : 'NONE';
    const prev = store.deadlineRaw(cid);
    if (prev && type === '기안' && isTerminal(planId)) { // 종결된 기안은 마감을 다시 내지 않는다(판정 동결과 같은 원칙)
      store.saveDeadline({ ...prev, route_judgment_id: p.route_judgment_id ?? prev.route_judgment_id });
      await closeRouteReviews(e);
      return;
    }
    const calc = computeDeadlines(cal, { approval_anchor_date: anchor, std_approval_bd: std, commitment_type: type }, offsets, today());
    if (calc) {
      const changed = !prev || prev.approver !== approver || prev.approval_anchor_date !== anchor || prev.std_approval_bd !== Number(std);
      const linked = type === '발주안' && m('p2') ? safe(() => m('p2').poDrafts({ po_draft_id: c.source_id })?.[0]?.linked_plan_ids, []) : [];
      const row = {
        commitment_id: cid, plan_id: planId, commitment_type: type, linked_plan_ids: store.J(linked), approval_anchor_date: anchor,
        anchor_basis: p.anchor_basis ?? c.anchor_basis ?? null, approver, std_approval_bd: Number(std), ...calc,
        route_judgment_id: p.route_judgment_id ?? null, event_id: prev?.event_id ?? null,
      };
      if (!changed) row.computed_status = prev.computed_status;
      store.saveDeadline(row);
      if (changed) {
        const ev = await emit({
          event_type: prev ? 'DEADLINES_RECOMPUTED' : 'DEADLINES_SET', source_type: '계산', is_simulation: true, plan_id: planId,
          subject_type: 'commitment', subject_id: cid, caused_by: e.event_id,
          premise_refs: [p.route_judgment_id && `route_judgment:${p.route_judgment_id}`, 'S3-03 std_approval_bd', 'S4-01'].filter(Boolean),
          payload: { ...store.deadlineById(cid), ...(prev ? { previous_values: { approver: prev.approver, approval_anchor_date: prev.approval_anchor_date, submission_due: prev.submission_due } } : {}) },
        });
        store.saveDeadline({ ...store.deadlineRaw(cid), event_id: ev.event_id });
        if (row.computed_status === '마감 경과 상태로 산출') await checkPastDue(store.deadlineRaw(cid), today()); // 4.2 예외: 즉시 경고
        // 경로가 바뀐 약정에 이전 상신이 있으면 재상신으로 넘긴다(4.4 commitment)
        const submitted = ctx.events.query({ event_type: 'APPROVAL_SUBMITTED', limit: ALL }).some((s) => (s.payload?.commitment_ids ?? []).includes(cid));
        // 경로가 올라가고 이전 상신이 있으면 재상신으로 넘긴다. 내려가면 승인을 유지하고 재상신하지 않는다(조정자 확정 (C)-3).
        if (prev && (ROUTE_RANK[approver] ?? 0) > (ROUTE_RANK[prev.approver] ?? 0) && submitted) {
          await openReview({ review_kind: '전제 변경', trigger: e, target_type: 'commitment', target_id: cid, plan_id: planId, commitment_id: cid,
            before: { approver: prev.approver, approval_status_before: '상신됨' }, rejudge: false });
        }
      } else {
        store.saveDeadline({ ...store.deadlineRaw(cid), route_judgment_id: p.route_judgment_id ?? prev.route_judgment_id });
      }
    }
    await closeRouteReviews(e);
    // 미결 OI-1·OI-2: 기안 단위 종결(표에 기록), 25건이 모두 닫히면 사건 1건
    if (type === '기안' && planId !== 'NONE') {
      for (const issueId of ['OI-1', 'OI-2']) {
        const r = store.issueRaw(issueId);
        if (!r || r.issue_status === '종결') continue;
        const closed = store.P(r.closed_plans) ?? {};
        closed[planId] = { route_judgment_id: p.route_judgment_id ?? null, finance_confirmation_status: c.finance_confirmation_status ?? null, in_window: p.in_window ?? null };
        const total = store.planStatesRaw().length;
        const done = Object.keys(closed).length >= total;
        store.saveIssue({ ...r, closed_plans: store.J(closed), issue_status: done ? '종결' : '열림', closing_ref: store.J(done ? Object.values(closed).map((x) => x.route_judgment_id) : null) });
        if (done) {
          await emit({ event_type: 'OPEN_ISSUE_CLOSED', source_type: '계산', plan_id: 'NONE', subject_type: 'open_issue', subject_id: issueId, caused_by: e.event_id,
            payload: { issue_id: issueId, plan_id: 'NONE', closing_ref: `route_judgment ${total}건(기안별 기록은 p4_open_issue.closed_plans)` } });
        }
      }
    }
  }

  // ── 모의 입력 실행기 ──
  const findReplyRow = (target, round) => {
    const rows = data.approvalReplies.filter((r) => r.target === target && Number(r.round) === round && activeScenario(r.scenario_id));
    return rows.find((r) => r.scenario_id !== 'BASE') ?? rows[0] ?? null;
  };
  // 발주안 모의 승인 규칙(조정자 확정 (E)-(2), S4-08-97): 승인 가정 재전망 최저 잔액 < 0원이면 거절, 아니면 승인.
  // 문제 3 approvalImpact가 없으면(연결 안 됨) 규칙을 쓰지 않고 S4-08 행으로 돌아간다.
  // 최저 잔액 기준(S4-10): 기본 0원. 켜진 시나리오에 그 승인권자의 기준이 있으면 그 값(예: S-CEO-FLOOR 그룹 CEO 15억, 가정)
  const baseFloor = () => data.cashFloors.find((r) => r.scenario_id === 'BASE') ?? { record_id: null, floor_krw: 0, scenario_id: 'BASE' };
  function cashFloorFor(approver) {
    const rows = data.cashFloors.filter((r) => r.scenario_id !== 'BASE' && activeScenario(r.scenario_id) && (r.approver === '*' || r.approver === approver));
    return rows.sort((a, b) => Number(b.floor_krw) - Number(a.floor_krw))[0] ?? baseFloor();
  }
  function poCashDecision(cid) {
    const row = data.approvalReplies.find((r) => r.target === 'PO_CASH_RULE');
    const imp = row && m('p3')?.approvalImpact ? safe(() => m('p3').approvalImpact({ commitment_id: cid })) : null;
    if (!imp) return null;
    const approver = commitmentById(cid)?.approver ?? null;
    const floor = cashFloorFor(approver);
    const floorKrw = Number(floor.floor_krw);
    const after = imp.after.min_balance_krw;
    const below = after < floorKrw;
    const baseDecision = after < Number(baseFloor().floor_krw) ? '거절' : '승인';
    const won = (v) => `${Math.round(v).toLocaleString('ko-KR')}원`;
    const isScenario = floor.scenario_id !== 'BASE';
    const reason = below
      ? (isScenario
        ? `거절: 승인 가정 재전망 최저 잔액 ${won(after)}(${imp.after.min_date}) < ${won(floorKrw)}. ${floor.condition_text}(가정 시나리오 ${floor.scenario_id}, ${floor.record_id})`
        : `거절: 승인 가정 재전망 최저 잔액 ${won(after)}(${imp.after.min_date}) < 0원. Masil 단독 기준 지급 재원 없음(그룹 지원은 판정에 넣지 않음, covenant_terms stand-alone)`)
      : `승인: 승인 가정 재전망 최저 잔액 ${won(after)}(${imp.after.min_date}) ≥ ${won(floorKrw)}${isScenario ? `(가정 시나리오 ${floor.scenario_id} 기준)` : ''}`;
    const basis = {
      rule: 'S4-08-97', window_version: imp.window_version, scenario_id: imp.scenario_id, threshold: imp.threshold,
      floor_krw: floorKrw, floor_record_id: floor.record_id, floor_scenario_id: floor.scenario_id,
      base_floor_krw: Number(baseFloor().floor_krw), base_decision: baseDecision, differs_from_base: baseDecision !== (below ? '거절' : '승인'),
      before: imp.before, after: imp.after, min_balance_delta_krw: imp.min_balance_delta_krw, added_outflows: imp.added_outflows, notes: imp.notes,
      reason, source_type: '가정',
    };
    return { row, decision: below ? '거절' : '승인', basis, scenario_id: isScenario ? floor.scenario_id : null };
  }
  async function deliverApprovalReplies(D) {
    if (!m('p3')) return;
    const submissions = ctx.events.query({ event_type: 'APPROVAL_SUBMITTED', limit: ALL });
    for (const s of submissions) {
      const reqId = s.payload?.approval_request_id;
      const ar = safe(() => m('p3').approvalRequest(reqId));
      const approver = s.payload?.approver ?? ar?.approver;
      const std = safe(() => m('p3').approverRole(approver)?.std_approval_bd) ?? 2;
      const replyDate = cal.addBusinessDays(s.occurred_at, std);
      if (replyDate > D) continue;
      for (const cid of s.payload?.commitment_ids ?? []) {
        const key = `M06:${reqId}:${cid}`;
        if (store.delivery(key)) continue;
        if ((ar?.superseded_commitment_ids ?? []).includes(cid)) { // 건별로 본다(조정자 확정 (D)-다)
          store.saveDelivery({ mock_key: key, mock_id: 'M06', sim_date: D, plan_id: null, status: '건너뜀: 대체된 상신', event_id: null, note: reqId });
          continue;
        }
        const c = commitmentById(cid);
        if (!c || c.approval_status !== '결재 대기') continue;
        if (c.commitment_type === '기안' && isTerminal(c.plan_id)) {
          store.saveDelivery({ mock_key: key, mock_id: 'M06', sim_date: D, plan_id: c.plan_id, status: '건너뜀: 기안 종결(확정기한 경과) 뒤 회신', event_id: null, note: reqId });
          continue;
        }
        const round = submissions.filter((x) => x.event_id <= s.event_id && (x.payload?.commitment_ids ?? []).includes(cid)).length;
        const planLink = c.commitment_type === '발주안'
          ? (safe(() => m('p2').poDrafts({ po_draft_id: c.source_id })?.[0]?.linked_plan_ids?.[0]) ?? null) : c.plan_id;
        const target = c.commitment_type === '발주안' ? `PO:${planLink}` : c.plan_id;
        // 발주안은 현금 규칙으로 회신한다(조정자 확정 (E)-(2)). 상신 순서대로 회신하므로 앞서 승인된 발주안은 이미 재전망에 들어 있다.
        const cash = c.commitment_type === '발주안' ? poCashDecision(cid) : null;
        const row = cash?.row ?? findReplyRow(target, round) ?? data.approvalReplies.find((r) => r.target === 'DEFAULT');
        const decision = cash?.decision ?? row.decision;
        const conditions = JSON.parse(row.conditions || '[]');
        const planId = c.commitment_type === '기안' ? c.plan_id : 'NONE';
        // 승인은 공급 조건을 받아들이지 않는다(사용자 요청 2026-11-15 마). 공급 위험 수용은 지정 사례의 별도 회신으로만 넣는다(riskAcceptIfDesignated).
        const reply = {
          approval_reply_id: store.nextReplyId(), approval_request_id: reqId, commitment_id: cid, plan_id: planId, decision,
          conditions: store.J(conditions), approver, replied_at: D,
          supply_judgment_version_at_reply: planId !== 'NONE' ? latestJudgment(planId)?.supply_judgment_version ?? null : null,
          record_id: row.record_id, event_id: null, cash_basis: store.J(cash?.basis ?? null),
        };
        store.saveReply(reply);
        const ev = await emit({
          event_type: 'APPROVAL_REPLIED', source_type: '모의회신', is_synthetic: true, plan_id: planId, actor_dept: APPROVER_DEPT[approver] ?? 'SYSTEM',
          actor_role: approver, subject_type: 'commitment', subject_id: cid, caused_by: s.event_id, source_ref: [`problem4/data/s4_08_approval_replies.csv#${row.record_id}`],
          generation_reason: cash ? cash.basis.reason : row.note, scenario_id: cash ? (cash.scenario_id ?? cash.basis.scenario_id ?? 'BASE') : row.scenario_id,
          premise_refs: cash ? [`approval_impact:${cid}`, `cash_window:${cash.basis.window_version}`, cash.basis.floor_record_id && `s4_10_po_cash_floor.csv#${cash.basis.floor_record_id}`].filter(Boolean) : undefined,
          payload: { approval_reply_id: reply.approval_reply_id, approval_request_id: reqId, commitment_id: cid, decision, conditions, approver, replied_at: D,
            ...(cash ? { reason: cash.basis.reason, cash_basis: cash.basis } : {}) },
        });
        store.saveReply({ ...reply, event_id: ev.event_id });
        store.saveDelivery({ mock_key: key, mock_id: 'M06', sim_date: D, plan_id: planId, status: '완료', event_id: ev.event_id, note: `${row.record_id} ${decision}` });
      }
    }
  }
  async function deliverDemandReply(planId, pattern, D, key, mockId) {
    if (store.delivery(key)) return;
    if (!m('p1')) return store.saveDelivery({ mock_key: key, mock_id: mockId, sim_date: D, plan_id: planId, status: '건너뜀: 문제 1 연결 안 됨', event_id: null, note: null });
    const row = safe(() => m('p1').mockDemandReplies({ plan_id: planId }), []).find((r) => r.reply_pattern === pattern);
    if (!row) return store.saveDelivery({ mock_key: key, mock_id: mockId, sim_date: D, plan_id: planId, status: `건너뜀: 문제 1 ${pattern} 회신 자료 없음`, event_id: null, note: null });
    if (m('p1').deliverMock) { // 값의 소유자(문제 1)가 사건을 낸다(명세 9.2)
      const r = await m('p1').deliverMock(key);
      return store.saveDelivery({ mock_key: key, mock_id: mockId, sim_date: D, plan_id: planId, status: r?.delivered === false ? `건너뜀: ${r.reason}` : '완료',
        event_id: r?.event_id ?? null, note: row.record_id });
    }
    const req = store.requestsRaw("plan_id = ? AND request_topic = 'demand_input' AND request_status IN ('회신 대기','기한 경과')", planId).at(-1);
    const ev = await emit({
      event_type: 'INFO_REPLIED', source_type: '모의회신', is_synthetic: true, plan_id: planId, actor_dept: 'MKT', actor_role: 'MKT-LINE-OWNER',
      subject_type: 'info_request', subject_id: req?.request_id ?? null, caused_by: req?.event_id ?? null, scenario_id: row.scenario_id ?? 'BASE',
      source_ref: [`problem1:${row.record_id}`], generation_reason: `사건 순서표 ${mockId}`,
      payload: { request_id: req?.request_id ?? null, record_id: row.record_id, reply_text: row.reply_text, reply_pattern: row.reply_pattern },
    });
    store.saveDelivery({ mock_key: key, mock_id: mockId, sim_date: D, plan_id: planId, status: '완료', event_id: ev.event_id, note: row.record_id });
  }
  // 정시 수요 회신(M02)은 문제 1 자료에 on_time 행이 있는 기안만. PLAN-005(미등록)·PLAN-011(지연)은 없다.
  const hasOnTime = (planId) => (m('p1') ? safe(() => m('p1').mockDemandReplies({ plan_id: planId }), []).some((r) => r.reply_pattern === 'on_time') : true);
  async function deliverOnTimeDemand(D) {
    for (const d of store.deadlinesRaw()) {
      if (d.commitment_type !== '기안' || !d.demand_input_due || d.demand_input_due > D || !hasOnTime(d.plan_id)) continue;
      if (isDirect(d.plan_id)) continue; // 직접 처리: 사용자가 화면에서 수요를 입력한다
      await deliverDemandReply(d.plan_id, 'on_time', D, `M02:${d.plan_id}`, 'M02');
    }
  }
  const resultStatus = (r) => {
    if (r?.skipped) return `건너뜀: ${typeof r.skipped === 'string' ? r.skipped : r.reason ?? ''}`;
    if (r?.delivered === false) return `건너뜀: ${r.reason ?? ''}`;
    return '완료';
  };
  function financeReplyId(params) {
    const p3 = m('p3');
    const listed = p3?.financeReplies ? safe(() => p3.financeReplies({ scenario_id: params.scenario_id }), []) : [];
    if (listed[0]?.finance_reply_id) return listed[0].finance_reply_id;
    const rows = ctx.data.loadFrom(3, 's3_04_finance_reply.csv', { optional: true });
    return rows.find((r) => (r.scenario_id ?? 'BASE') === params.scenario_id && r.finance_reply_id)?.finance_reply_id ?? params.fallback_id;
  }
  // 순서표 행이 가리키는 문제 2 회신이 그날 반영된 사건(입고·SCM 보충 계획·기발주 Corevia 회신)
  function p2Landed(row, params, D) {
    const on = (type) => ctx.events.query({ event_type: type, limit: ALL }).filter((e) => e.occurred_at === D);
    const ids = new Set(params.record_ids ?? []);
    const cvc = on('SUPPLIER_REPLIED').filter((e) => e.payload?.supply_commitment?.target_type === '기발주' && (!ids.size || ids.has(e.payload.supply_commitment.record_id)))
      .map((e) => { const s = e.payload.supply_commitment; return { event_id: e.event_id, note: `${s.target_id} ${s.reply_status}${s.validation_status === '확인 필요' ? '(확인 필요)' : ''}` }; });
    if (row.action === 'coreviaPoReply') return ids.size && cvc.length < ids.size ? [] : cvc;
    if (row.action === 'applyBaselinePlan') {
      return on('INBOUND_SCHEDULE_REVISED').filter((e) => e.payload?.baseline_replenishment).map((e) => ({ event_id: e.event_id, note: `SCM 보충 계획 ${e.payload.inbound_schedule_version}` }));
    }
    if (row.action === 'applyInboundReply') {
      const it = on('INBOUND_SCHEDULE_REVISED').filter((e) => [].concat(e.source_ref ?? []).some((x) => String(x).startsWith('S2-ETA-')));
      return it.length ? [...it.map((e) => ({ event_id: e.event_id, note: `운송 중 입고 ${e.payload?.inbound_schedule_version ?? ''}` })), ...cvc] : [];
    }
    return [];
  }
  async function deliverExplicit(row, D) {
    const key = row.mock_id;
    if (store.delivery(key)) return;
    if (isMarketingRow(row) && isDirect(row.plan_id)) return; // 직접 처리 기안의 마케팅 행동은 사용자가 한다(전달 기록을 남기지 않아 끄면 다시 전달된다)
    const params = JSON.parse(row.params || '{}');
    const save = (status, eventId = null, note = null) => store.saveDelivery({ mock_key: key, mock_id: row.mock_id, sim_date: D, plan_id: row.plan_id, status, event_id: eventId, note });
    const owner = row.owner === 'p4' ? true : m(row.owner);
    if (!owner) return save(`건너뜀: ${row.owner} 연결 안 됨`);
    try {
      // 값의 소유 모듈이 deliverMock을 내놓았으면 그것으로 전달한다(명세 9.2). 수요 회신은 deliverDemandReply가 같은 길을 쓴다.
      if (row.owner !== 'p4' && row.action !== 'demandReply' && typeof owner.deliverMock === 'function') {
        const r = await owner.deliverMock(row.mock_id);
        // 문제 2 onDay가 같은 날 회신을 먼저 넣었으면 deliverMock은 재처리라 아무것도 내지 않는다. 그날 실제로 반영된 사건으로 상태를 남긴다
        const landed = row.owner === 'p2' ? p2Landed(row, params, D) : [];
        if (landed.length) return save('완료', landed[0].event_id, landed.map((e) => e.note).join(' / '));
        return save(resultStatus(r), r?.event_id ?? null, r?.reason ?? null);
      }
      switch (row.action) {
        case 'applyInboundReply': {
          const ids = m('p2').mockInboundRecordIds ? safe(() => m('p2').mockInboundRecordIds({ version: params.version })) : undefined;
          const r = await m('p2').applyInboundReply({ version: params.version, record_ids: ids });
          return save('완료', r?.event_id ?? null, r?.inbound_schedule_version ?? null);
        }
        case 'coreviaPoReply': {
          if (!m('p2').applySupplyReplies) return save('건너뜀: 문제 2 applySupplyReplies 없음');
          const r = await m('p2').applySupplyReplies({ date: D });
          return save(r?.length ? '완료' : '건너뜀: 이 날짜의 Corevia 회신이 없음', r?.[0]?.event_id ?? null);
        }
        case 'applyFinanceReply': {
          const id = financeReplyId(params);
          const r = await m('p3').applyFinanceReply(id);
          return save('완료', null, `${id} → ${r?.window_version ?? '-'}`);
        }
        case 'demandReply':
          await deliverDemandReply(row.plan_id, params.reply_pattern, D, key, row.mock_id);
          return undefined;
        case 'selectAlternative': {
          const alts = safe(() => m('p2').alternatives({ plan_id: row.plan_id }), []).filter((a) => a.alternative_type === params.alternative_type);
          const alt = alts.at(-1);
          if (!alt) return save(`건너뜀: ${params.alternative_type} 대안 없음(판정이 부족·조건부가 아니거나 거절 대안 미계산)`);
          const r = await m('p2').selectAlternative({ alternative_id: alt.alternative_id, selected_by: params.selected_by });
          return save('완료', r?.event_id ?? null, alt.alternative_id);
        }
        case 'groupAllocationReply': {
          const rec = data.groupAllocation.reply;
          const req = store.requestsRaw("request_topic = 'group_allocation'").at(-1);
          const ev = await emit({
            event_type: 'INFO_REPLIED', source_type: '모의회신', is_synthetic: true, plan_id: 'NONE', actor_dept: 'GROUP', scenario_id: row.scenario_id,
            subject_type: 'info_request', subject_id: req?.request_id ?? null, caused_by: req?.event_id ?? null,
            source_ref: [`problem4/data/s4_06_group_allocation.csv#${rec.record_id}`],
            payload: { request_id: req?.request_id ?? null, record_id: rec.record_id, reply_text: rec.reply_text, decision: rec.decision },
          });
          return save('완료', ev.event_id, rec.decision);
        }
        case 'requestEarlySupply': { // PLAN-011: 부족 → 조기 공급 요청(조정자 확정 (D)-5)
          if (!m('p2')?.requestEarlySupply) return save('건너뜀: 문제 2 requestEarlySupply 없음');
          const r = await m('p2').requestEarlySupply(row.plan_id, { selected_by: 'MKT-LINE-OWNER', generation_reason: `사건 순서표 ${row.mock_id}: ${row.description}` });
          return save(r?.length ? '완료' : '건너뜀: 실행 가능한 조기분할요청 대안 없음', null, (r ?? []).map((x) => x.supply_request_id).join(','));
        }
        case 'selectRecommended': { // 문제 2가 권장한 실행 가능 대안(부족이면 시기이동)
          const pa = m('p2')?.planAlternatives ? safe(() => m('p2').planAlternatives(row.plan_id)) : null;
          const rec = pa?.recommended;
          if (!rec) return save('건너뜀: 권장 대안 없음');
          if (params.alternative_type && rec.alternative_type !== params.alternative_type) return save(`건너뜀: 권장 대안이 ${rec.alternative_type}`);
          const r = await m('p2').selectAlternative({ alternative_id: rec.alternative_id, selected_by: 'MKT-LINE-OWNER', actor_dept: 'MKT', is_mock: true,
            generation_reason: `사건 순서표 ${row.mock_id}: ${row.description}` });
          return save('완료', r?.event_id ?? null, `${rec.alternative_type} ${rec.new_sale_start_week ?? ''}`);
        }
        default:
          return save(`건너뜀: 알 수 없는 동작 ${row.action}`);
      }
    } catch (err) {
      ctx.log(`모의 입력 ${row.mock_id} 오류: ${err.message}`);
      return save(`오류: ${err.message}`);
    }
  }
  // ── 기본 모의 입력(조정자 확정 (D)-3, 사용자 요청 2026-11-15로 (나) 변경) ──
  // (나) 공급 위험 수용: 일괄 적용하지 않는다. 사건 순서표(S4-08 round=RISK)로 지정한 기안만, 승인된 뒤 공급 미확약 조건이
  //     확정기한 2영업일 전까지 남으면 승인권자가 그 조건의 공급 위험을 수용하는 회신을 보낸다. 공급 판정·입고 상태는 바꾸지 않는다.
  // 위험 수용 지정 행: 켜진 시나리오 전용 행이 있으면 그것이 기본 행보다 앞선다. 결정이 '미수용'이면 위험 수용 회신이 오지 않고 기본 규칙(대안·철회)으로 간다
  // (조정자 마지막 조정 2026-11-15: S-CEO-FLOOR는 그룹 CEO가 보수적이라 PLAN-011의 공급 위험 수용 회신이 없다)
  const riskRowFor = (planId) => {
    const rows = data.approvalReplies.filter((r) => r.target === planId && r.round === 'RISK' && activeScenario(r.scenario_id));
    const row = rows.find((r) => r.scenario_id !== 'BASE') ?? rows[0] ?? null;
    return row && row.decision !== '미수용' ? row : null;
  };
  async function riskAcceptIfDesignated(planId, sj, D) {
    const row = riskRowFor(planId);
    const c = commitmentOfPlan(planId);
    const st = store.planStateRaw(planId);
    if (!row || !c || c.approval_status !== '승인' || sj.supply_verdict !== '조건부' || st.plan_confirmability !== '조건부 대기') return;
    if (D < cal.addBusinessDays(st.contract_deadline, -2) || D > st.contract_deadline) return;
    const types = conditionTypes(sj).map((t) => (t === 'reorder_required' ? 'supply_commitment_pending' : t));
    if (reorderPoIds(sj).some((id) => !id || commitmentOfPlan(id)?.approval_status !== '승인')) return; // 발주안 승인 전이면 위험을 수용할 대상이 아직 없다
    const prev = riskAcceptanceOf(c.commitment_id);
    if (prev && types.every((t) => prev.accepted_condition_types.includes(t))) return;
    const last = store.latestReply(c.commitment_id);
    const label = [...new Set(types)].map((t) => SUPPLY_COND_KO[t] ?? t).join(', ');
    const conditions = [{ condition_type: '공급조건부수용', acceptance_type: '공급 위험 수용', ref_id: sj.supply_judgment_id, accepted_condition_types: [...new Set(types)],
      text: `공급 판정 v${sj.supply_judgment_version}의 미확약 조건(${label})을 확인하지 못한 채 공급 위험을 수용한다. 공급 확약으로 보지 않는다` }];
    const reply = { approval_reply_id: store.nextReplyId(), approval_request_id: last?.approval_request_id ?? c.approval_request_id ?? null, commitment_id: c.commitment_id, plan_id: planId,
      decision: '승인', conditions: store.J(conditions), approver: c.approver, replied_at: D, supply_judgment_version_at_reply: sj.supply_judgment_version, record_id: row.record_id, event_id: null };
    store.saveReply(reply);
    const ev = await emit({ event_type: 'APPROVAL_REPLIED', source_type: '모의회신', is_synthetic: true, plan_id: planId, actor_dept: APPROVER_DEPT[c.approver] ?? 'SYSTEM',
      actor_role: c.approver, subject_type: 'commitment', subject_id: c.commitment_id, source_ref: [`problem4/data/s4_08_approval_replies.csv#${row.record_id}`],
      generation_reason: `${row.note}(지정 사례): 확정기한 2영업일 전까지 공급 확약이 오지 않아 승인권자가 공급 위험을 수용`,
      payload: { approval_reply_id: reply.approval_reply_id, approval_request_id: reply.approval_request_id, commitment_id: c.commitment_id, decision: '승인', conditions,
        approver: c.approver, replied_at: D, supply_risk_accepted: true, accepted_condition_types: [...new Set(types)], supply_judgment_id: sj.supply_judgment_id } });
    store.saveReply({ ...reply, event_id: ev.event_id });
    store.saveDelivery({ mock_key: `RISK:${planId}:${sj.supply_judgment_version}`, mock_id: 'MR', sim_date: D, plan_id: planId, status: '완료', event_id: ev.event_id, note: label });
  }
  // 공급 미확약으로 확정기한 전 영업일까지 확정 가능이 되지 않은 자동 처리 기안: 철회(대안이 있으면 확정기한 2영업일 전에 먼저 고른다)
  async function defaultUnconfirmedSupply(st, sj, D) {
    if (st.plan_confirmability !== '조건부 대기' || riskRowFor(st.plan_id)) return;
    if (D > st.contract_deadline) return;
    const pa = m('p2')?.planAlternatives ? safe(() => m('p2').planAlternatives(st.plan_id)) : null;
    const rec = pa?.recommended;
    const key = `MU:${st.plan_id}`;
    // 권장 대안은 확정기한 2영업일 전에 고른다. 그날 재검토 중(미확인)이라 놓쳤으면 전 영업일에 먼저 고르고, 그래도 조건이 남으면 확정기한 당일 철회한다
    if (rec && D >= cal.addBusinessDays(st.contract_deadline, -2) && !store.delivery(key)) {
      try {
        const r = await m('p2').selectAlternative({ alternative_id: rec.alternative_id, selected_by: 'MKT-LINE-OWNER', actor_dept: 'MKT', is_mock: true,
          generation_reason: `${DEFAULT_TAG}(다): 공급 확약이 오지 않음 → 권장 대안 ${rec.alternative_type}${rec.reason ? ` — ${rec.reason}` : ''}` });
        store.saveDelivery({ mock_key: key, mock_id: 'MU', sim_date: D, plan_id: st.plan_id, status: '완료', event_id: r?.event_id ?? null, note: rec.alternative_type });
      } catch (err) { store.saveDelivery({ mock_key: key, mock_id: 'MU', sim_date: D, plan_id: st.plan_id, status: `오류: ${err.message}`, event_id: null, note: null }); }
      return;
    }
    if (D >= cal.addBusinessDays(st.contract_deadline, -1)) {
      const reason = JSON.parse(st.confirmability_basis || '{}').reason ?? '공급 미확약';
      await withdrawPlan(st.plan_id, `확정기한까지 공급이 확인되지 않음 — ${reason}`, { mock: true });
    }
  }
  // (다) 부족 → 실행 가능한 시기 이동, (라) 대안이 없으면 확정기한 전 영업일에 철회. 시연 대상 기안은 지정 입력을 따른다.
  async function defaultShortage(st, sj, D) {
    const tries = store.deliveries().filter((x) => x.mock_id === 'MD' && x.plan_id === st.plan_id && x.status === '완료').length;
    const pa = m('p2')?.planAlternatives ? safe(() => m('p2').planAlternatives(st.plan_id)) : null;
    const rec = pa?.recommended;
    // (라) 확정기한 전 영업일부터는 다시 고를 시간이 없으므로, 여전히 부족이면 철회한다
    if (D >= cal.addBusinessDays(st.contract_deadline, -1)) {
      if (D > st.contract_deadline) return;
      await withdrawPlan(st.plan_id, rec ? (tries ? '권장 대안을 고른 뒤에도 부족' : '확정기한 전까지 부족') : '실행 가능한 대안 없음', { mock: true });
      store.saveDelivery({ mock_key: `MW:${st.plan_id}`, mock_id: 'MW', sim_date: D, plan_id: st.plan_id, status: '완료', event_id: null, note: `대안 선택 ${tries}회` });
      return;
    }
    const judgedOn = ctx.events.query({ plan_id: st.plan_id, event_type: 'SUPPLY_JUDGED', order: 'desc', limit: 1 })[0]?.occurred_at ?? D;
    if (judgedOn >= D) return; // (다) 판정 다음 영업일에 고른다
    const key = `MD:${st.plan_id}:${sj.supply_judgment_version}`;
    if (rec && tries < 2 && !store.delivery(key)) {
      try {
        const r = await m('p2').selectAlternative({ alternative_id: rec.alternative_id, selected_by: 'MKT-LINE-OWNER', actor_dept: 'MKT', is_mock: true,
          generation_reason: `${DEFAULT_TAG}(다): 부족 → 권장 대안 ${rec.alternative_type}${rec.new_sale_start_week ? `(${rec.new_sale_start_week})` : ''}${rec.reason ? ` — ${rec.reason}` : ''}` });
        store.saveDelivery({ mock_key: key, mock_id: 'MD', sim_date: D, plan_id: st.plan_id, status: '완료', event_id: r?.event_id ?? null, note: `${rec.alternative_type} ${rec.new_sale_start_week ?? ''}` });
      } catch (err) {
        store.saveDelivery({ mock_key: key, mock_id: 'MD', sim_date: D, plan_id: st.plan_id, status: `오류: ${err.message}`, event_id: null, note: null });
      }
    }
  }
  // 시연 기안의 지정 입력(사건 순서표의 그 기안 행)이 아직 남았는가. 다 쓰면 기본 규칙을 따른다(조정자 (D) 2차-나).
  function caseInputsPending(planId, D) {
    return data.schedule.some((r) => r.plan_id === planId && /^\d{4}-/.test(r.sim_date) && activeScenario(r.scenario_id)
      && r.sim_date >= D && !store.delivery(r.mock_id));
  }
  async function defaultMockInputs(D) {
    for (const st of store.planStatesRaw()) {
      if (st.plan_status !== '검토 중') continue;
      const sj = latestJudgment(st.plan_id);
      if (!sj) continue;
      await riskAcceptIfDesignated(st.plan_id, sj, D);
      if (isDirect(st.plan_id)) continue; // 직접 처리: 대안 선택·철회는 사용자가 한다(기한 경과는 규칙대로 일어난다)
      if (sj.supply_verdict === '부족' && (st.mock_input_absent || !caseInputsPending(st.plan_id, D))) await defaultShortage(store.planStateRaw(st.plan_id), sj, D);
      else if (sj.supply_verdict === '조건부' && (st.mock_input_absent || !caseInputsPending(st.plan_id, D))) {
        await recompute(st.plan_id);
        const fresh = store.planStateRaw(st.plan_id);
        if (fresh.plan_status === '검토 중') await defaultUnconfirmedSupply(fresh, sj, D);
      }
    }
  }

  async function mockConfirm(D) {
    for (const { plan_id: planId } of store.planStatesRaw()) {
      const st = store.planStateRaw(planId); // 앞 기안의 확정이 이 기안의 상태를 바꿨을 수 있어 다시 읽는다
      if (st.plan_status !== '검토 중' || !CONFIRMABLE.has(st.plan_confirmability) || !st.confirmable_since) continue;
      if (st.contract_deadline < D || isDirect(planId)) continue; // 직접 처리: 확정은 사용자가 한다
      // 확정 가능이 된 다음 영업일에 확정한다. 확정기한 당일에 확정 가능이 되면 그날 확정한다.
      if (st.confirmable_since >= D && D !== st.contract_deadline) continue;
      await confirmPlan(st.plan_id, { mock: true });
      store.saveDelivery({ mock_key: `M12:${st.plan_id}`, mock_id: 'M12', sim_date: D, plan_id: st.plan_id, status: '완료', event_id: null, note: null });
    }
  }
  // 상신(M04): 미상신이고 상신 마감이 된 약정. 순서표 행은 약정·회차별(M04:<기안|PO:발주안>:<회차>)이고 문제 3 deliverMock이 행을 읽어 상신한다.
  function submissionRows() {
    if (!m('p3')) return [];
    const submitted = ctx.events.query({ event_type: 'APPROVAL_SUBMITTED', limit: ALL });
    const lastRoute = new Map(ctx.events.query({ event_type: 'ROUTE_JUDGED', limit: ALL }).map((e) => [e.payload?.commitment_id, e]));
    const rows = [];
    for (const d of store.deadlinesRaw()) {
      const c = commitmentById(d.commitment_id);
      if (!c || c.approval_status !== '미상신' || !d.submission_due || d.computed_status === PO_CANCELLED) continue;
      if (d.commitment_type === '기안' && isTerminal(d.plan_id)) continue;
      if (d.commitment_type === '기안' && isDirect(d.plan_id)) continue; // 직접 처리: 승인 요청은 사용자가 화면에서 올린다(발주안 상신은 SCM 모의)
      const isPo = d.commitment_type === '발주안';
      const round = submitted.filter((x) => (x.payload?.commitment_ids ?? []).includes(d.commitment_id)).length + 1;
      rows.push({
        mock_id: `M04:${isPo ? `PO:${c.source_id}` : d.plan_id}:${round}`, sim_date: d.submission_due, seq: 9, owner: 'p3',
        event_type: 'APPROVAL_SUBMITTED', plan_id: isPo ? (store.P(d.linked_plan_ids)?.[0] ?? 'NONE') : d.plan_id,
        // 발주안 행의 target은 po_draft_id 그대로다. 문제 3 deliverMock이 `CMT-${target}`으로 약정을 찾는다
        target: isPo ? c.source_id : `기안 ${d.plan_id}`, scenario_id: lastRoute.get(d.commitment_id)?.scenario_id ?? 'BASE',
        active: true, status: '대기', delivered_event_id: null, commitment_id: d.commitment_id, approver: d.approver, commitment_type: d.commitment_type,
      });
    }
    return rows;
  }
  async function submitDue(D) {
    const p3 = m('p3');
    if (!p3) return;
    for (let guard = 0; guard < 200; guard += 1) {
      const due = submissionRows().filter((r) => r.sim_date <= D && !store.delivery(r.mock_id));
      const row = due[0];
      if (!row) return;
      let status;
      try {
        if (typeof p3.deliverMock === 'function') {
          status = resultStatus(await p3.deliverMock(row.mock_id));
        } else { // deliverMock이 없으면 같은 승인권자·같은 상신 마감끼리 묶어 직접 상신
          const ids = due.filter((r) => r.approver === row.approver && r.sim_date === row.sim_date && r.commitment_type === row.commitment_type).map((r) => r.commitment_id);
          await p3.submitApproval({ commitment_ids: ids, actor_dept: row.commitment_type === '기안' ? 'MKT' : 'SCM', actor_role: '상신 담당(모의)', effective_at: D });
          status = '완료';
        }
      } catch (err) {
        status = `오류: ${err.message}`;
      }
      // 같은 상신에 묶여 함께 나간 약정도 전달 기록을 남긴다
      const still = new Set(submissionRows().map((r) => r.mock_id));
      for (const r of due) {
        if (r !== row && (still.has(r.mock_id) || store.delivery(r.mock_id))) continue;
        store.saveDelivery({ mock_key: r.mock_id, mock_id: 'M04', sim_date: D, plan_id: r.plan_id, status: r === row ? status : '완료(같은 묶음 상신)', event_id: null,
          note: store.J({ commitment_id: r.commitment_id, target: r.target, scenario_id: r.scenario_id }) });
      }
    }
  }
  // 직접 처리 기안이 기한을 넘길 때 담당자가 하지 않은 행동(수요 입력·대안 선택·승인 요청·확정). 다른 부서 회신을 기다리던 중이면 그것도 적는다
  function directNoInput(st, c) {
    const sj = latestJudgment(st.plan_id);
    const awaited = [];
    if (!(m('p1')?.demandInput ? safe(() => m('p1').demandInput(st.plan_id)) : null)) awaited.push('수요 입력');
    if (sj?.supply_verdict === '부족' || c?.approval_status === '거절') awaited.push('대안 선택 또는 철회');
    if (['가능', '조건부'].includes(sj?.supply_verdict) && (c?.approval_status ?? '미상신') === '미상신') awaited.push('승인 요청 올리기');
    if (CONFIRMABLE.has(st.plan_confirmability)) awaited.push('확정');
    return { direct: true, awaited, note: `직접 처리 기안: 담당자 입력 없음${awaited.length ? `(${awaited.join(', ')})` : '(다른 부서 회신 대기 중 확정기한 경과)'}` };
  }
  async function autoConfirmByDeadline(D) {
    for (const st of store.planStatesRaw()) {
      if (st.plan_status !== '검토 중' || !(st.contract_deadline < D)) continue;
      const c = commitmentOfPlan(st.plan_id);
      // L8: 직접 처리 기안이면 담당자가 하지 않은 행동을 경위에 남긴다(처음 보는 사람이 원인을 알 수 있게)
      const noInput = isDirect(st.plan_id) ? directNoInput(st, c) : null;
      await setPlanStatus(st.plan_id, '기한 경과 확정', {
        event_type: 'PLAN_AUTO_CONFIRMED_BY_DEADLINE', source_type: '계산', plan_id: st.plan_id, effective_at: st.contract_deadline,
        subject_type: 'plan_state', subject_id: st.plan_id,
        generation_reason: `미결정으로 확정기한 경과: 묵시적 승인과 같은 효과(정책 38~39행). 승인자 없음${noInput ? `. ${noInput.note}` : ''}`,
        payload: { plan_id: st.plan_id, contract_deadline: st.contract_deadline, last_approval_status: c?.approval_status ?? null, ...(noInput ? { direct_no_input: noInput } : {}) },
      });
    }
  }

  // 하루 처리 순서: 지난 마감 점검 → 그날 모의 입력 → 확정 입력 → 상신 → 당일 최종 회신 경고
  async function onDay(D) {
    await closeStaleRouteReviews(D);
    for (const d of store.deadlinesRaw()) await checkPastDue(d, D);
    await checkRequests(D);
    for (const h of store.holdsRaw("hold_status = '보류 중' AND hold_due_date < ?", D)) await resumeHold(h, '기한 경과');
    await autoConfirmByDeadline(D);
    await deliverApprovalReplies(D);
    await deliverOnTimeDemand(D);
    const rows = data.schedule.filter((r) => r.sim_date === D && activeScenario(r.scenario_id)).sort((a, b) => Number(a.seq) - Number(b.seq));
    for (const row of rows) await deliverExplicit(row, D);
    await deliverCoreviaReplies(D);
    await defaultMockInputs(D);
    await mockConfirm(D);
    await submitDue(D);
    await recomputeAll();
    for (const d of store.deadlinesRaw()) await checkFinalReply(d, D);
    for (const id of new Set(store.reviewsRaw("review_status = '열림' AND plan_id <> 'NONE'").map((r) => r.plan_id))) await closeNoReplyFollowUps(id);
  }

  // ── 초기 사건 ──
  async function init() {
    store.setSetting('scenarios', scenarios);
    store.setSetting('direct_plans', directPlans);
    const plans = ctx.plans();
    for (const p of plans) {
      store.savePlanState({ plan_id: p.plan_id, plan_status: '검토 중', plan_confirmability: '미확인', confirmability_basis: store.J({ reason: '초기' }),
        mock_input_absent: CASE_PLANS.has(p.plan_id) ? 0 : 1, confirmable_since: null, contract_deadline: p.contract_deadline });
    }
    for (const oi of data.openIssues) {
      store.saveIssue({ issue_id: oi.issue_id, quote: oi.quote, source_ref: `${oi.source_ref} ${oi.source_line}행`, closing_rule: oi.closing_rule, closing_ref: null, issue_status: '열림', closed_plans: store.J({}) });
      await emit({ event_type: 'OPEN_ISSUE_RAISED', source_type: '원본도출', occurred_at: '미상', effective_at: SIM_START, subject_type: 'open_issue', subject_id: oi.issue_id,
        source_ref: [`${oi.source_ref}#L${oi.source_line}`], generation_reason: oi.generation_reason,
        payload: { issue_id: oi.issue_id, quote: oi.quote, source_ref: `${oi.source_ref} ${oi.source_line}행`, closing_rule: oi.closing_rule } });
    }
    for (const p of plans) {
      await emit({
        event_type: 'PLAN_RECEIVED', source_type: '원본도출', occurred_at: '미상', effective_at: SIM_START, plan_id: p.plan_id,
        subject_type: 'plan', subject_id: p.plan_id, source_ref: [p.source_ref], generation_reason: '원본 기안 접수(접수일은 원본에 없어 미상)',
        payload: { plan_id: p.plan_id, campaign_id: p.campaign_id, requested_budget_krw: p.requested_budget_krw, expected_gmv_krw: p.expected_gmv_krw,
          expected_gmv_note: '승인 근거 아님(쿠폰·반품·비용 차감 전). 실질 공헌이익: 미산정', settlement_date: p.settlement_date, contract_deadline: p.contract_deadline },
      });
    }
    for (const p of plans) {
      if (store.requestsRaw("plan_id = ? AND request_topic = 'demand_input'", p.plan_id).length) continue;
      await requestInfo({ request_topic: 'demand_input', requested_to: 'MKT', plan_id: p.plan_id, subject_type: 'plan', subject_id: p.plan_id, questions: DEMAND_QUESTIONS }, '수요 입력 요청(초기)');
    }
    await requestInfo({ request_topic: 'finance_confirmation', requested_to: 'FIN', subject_type: 'cash_window', subject_id: 'BASE' }, '재무 재전망 확인 요청');
    await requestInfo({ request_topic: 'group_allocation', requested_to: 'GROUP', subject_type: 'open_issue', subject_id: 'OI-3',
      questions: ['본 기안 묶음이 그룹 300억 배분 검토 대상인지'] }, 'OI-3 확인 요청(문제 4만 낸다, K7)');
    await recomputeAll();
  }

  // ── 구독 ──
  function subscribe() {
    const on = (types, fn) => ctx.events.on(types, fn);
    on('INFO_REQUESTED', async (e) => registerForeignRequest(e));
    on(['DEMAND_INPUT_REGISTERED', 'DEMAND_INPUT_REVISED'], async (e) => {
      for (const r of store.requestsRaw("plan_id = ? AND request_topic = 'demand_input' AND request_status IN ('회신 대기','기한 경과','보류')", e.plan_id)) await closeRequest(r.request_id, e);
      if (e.event_type === 'DEMAND_INPUT_REVISED') await openSupplyReview(e.plan_id, e);
      for (const pid of laterPlans(e.plan_id)) await openSupplyReview(pid, e);
    });
    on('DEMAND_INPUT_REJECTED', async (e) => {
      const due = store.deadlineByPlan(e.plan_id)?.demand_input_due;
      await requestInfo({ request_topic: 'demand_input', requested_to: 'MKT', plan_id: e.plan_id, subject_type: 'plan', subject_id: e.plan_id, request_kind: 'rerequest',
        request_due_date: due && due >= today() ? due : nextBd(today()), caused_by: e.event_id, questions: DEMAND_QUESTIONS }, '반려 뒤 재요청(사전 v1.1)');
    });
    on('BASELINE_DEMAND_SET', async (e) => {
      if (!ctx.events.query({ event_type: 'SUPPLY_JUDGED', limit: 1 }).length) return; // 초기 계산은 재검토가 아니다
      for (const st of store.planStatesRaw()) await openSupplyReview(st.plan_id, e);
    });
    // 재검토 대응표(사용자 요청 2026-11-15 다): 입고 일정 변경(기존 입고 회신·발주안 예상 입고·Corevia 공급 회신 반영·SCM 기준 수요 보충 계획)과
    // Corevia 공급 회신(확약·부분·지연·불가·미확인·확인 필요·정정) → 그 SKU·연결 기안의 공급 판정 재검토. 문제 2가 회신 사건을 원인으로 다시 판정하면 바로 닫히고,
    // 결론이 부족으로 바뀌면 대안 선택(직접 처리: 담당자, 자동: 기본 모의 입력)으로 이어진다.
    on(['INBOUND_SCHEDULE_REVISED', 'SUPPLIER_REPLIED'], async (e) => {
      const p2 = m('p2');
      if (!p2) return;
      const p = e.payload ?? {};
      let skus = [];
      const direct = new Set();
      if (e.event_type === 'INBOUND_SCHEDULE_REVISED' && (p.receipts || p.overdue_expected)) {
        // 입고 처리(문제 2 v2.2 L7): 입고 완료는 판정에서 확약과 같아 재검토하지 않는다.
        // 도착 예정일이 지났는데 확약이 없는 입고(예정일 경과·미확약)만 전개를 바꾸므로 그 SKU를 쓰는 기안을 다시 본다.
        skus = (p.overdue_expected ?? []).map((r) => r.sku_id).filter(Boolean);
      } else if (e.event_type === 'INBOUND_SCHEDULE_REVISED') {
        const ids = new Set((p.changed_rows ?? []).map((r) => r.inbound_row_id));
        const rows = safe(() => p2.inboundSchedule({ inbound_schedule_version: p.inbound_schedule_version })?.rows, []);
        skus = [...rows.filter((r) => ids.has(r.inbound_row_id)).map((r) => r.sku_id), ...(p.changed_rows ?? []).map((r) => r.sku_id).filter(Boolean),
          ...(p.baseline_replenishment ?? []).map((r) => r.sku_id).filter(Boolean)];
        // SCM 기준 수요 보충 계획 회신이 온 SKU의 확인 요청을 닫는다(미회신 SKU는 열린 채 남는다 — 자동 해소 없음)
        for (const br of p.baseline_replenishment ?? []) {
          for (const r of store.requestsRaw("request_topic = 'baseline_replenishment' AND subject_id = ? AND request_status IN ('회신 대기','기한 경과')", br.sku_id)) await closeRequest(r.request_id, e);
        }
      } else if (p.supply_commitment) {
        skus = [p.supply_commitment.sku_id];
        for (const id of p.supply_commitment.linked_plan_ids ?? []) direct.add(id);
      } else {
        skus = safe(() => p2.supplyRequests({ supply_request_id: p.supply_request_id }), []).map((r) => r.sku_id);
      }
      const plans = new Set([...direct, ...[...new Set(skus)].flatMap((sku) => (m('p1') ? safe(() => m('p1').planSkuMap({ sku_id: sku }), []) : []).map((r) => r.plan_id))]);
      for (const pid of plans) await openSupplyReview(pid, e);
    });
    on('SUPPLY_JUDGED', async (e) => closeSupplyReviews(e));
    on('ALTERNATIVE_SELECTED', async (e) => {
      for (const pid of laterPlans(e.plan_id)) await openSupplyReview(pid, e);
      if (e.payload?.plan_change) {
        const c = commitmentOfPlan(e.plan_id);
        if (c) await openRouteReview(c.commitment_id, e);
      }
    });
    on('PO_DRAFT_CANCELLED', (e) => { // 문제 3 약정에는 취소 표시가 없어 마감 행에 남긴다
      const c = m('p3') ? safe(() => m('p3').commitmentBySource(e.payload?.po_draft_id)) : null;
      const d = c && store.deadlineRaw(c.commitment_id);
      if (d) store.saveDeadline({ ...d, computed_status: PO_CANCELLED });
    });
    on('PAYMENT_DATE_SET', async (e) => {
      const c = m('p3') ? safe(() => m('p3').commitmentBySource(e.payload?.po_draft_id)) : null;
      if (!c || !store.deadlineRaw(c.commitment_id)) return; // 최초 판정은 재검토가 아니다
      // 지급일이 그대로인 재산정(수량 갱신 등)은 경로 전제가 바뀌지 않았으므로 재검토를 열지 않는다
      const prev = ctx.events.query({ event_type: 'PAYMENT_DATE_SET', limit: ALL })
        .filter((x) => x.event_id !== e.event_id && x.payload?.po_draft_id === e.payload?.po_draft_id).at(-1);
      if (prev && prev.payload?.payment_due_date === e.payload?.payment_due_date) return;
      await openRouteReview(c.commitment_id, e);
    });
    on('CASH_WINDOW_REVISED', async (e) => {
      const p = e.payload ?? {};
      const sid = p.scenario_id ?? e.scenario_id ?? 'BASE';
      const old = store.window(sid) ?? (sid !== 'BASE' ? store.window('BASE') : null);
      store.saveWindow({ scenario_id: sid, window_version: p.window_version, start: p.shortfall_window_start, end: p.shortfall_window_end });
      if (!old) return;
      if (old.start === p.shortfall_window_start && old.end === p.shortfall_window_end) {
        // 변경 입력(재무 확인·회수일 변경)에도 구간이 그대로면 결론 유지 사례로 남긴다(조정자 (D) 2차-다)
        const cause = e.caused_by ? ctx.events.get(e.caused_by) : null;
        if (['AR_DATE_REVISED', 'FINANCE_CONFIRMED'].includes(cause?.event_type)) await windowKeptReview(e, cause, old, p, sid);
        return;
      }
      const rs = p.recheck_summary;
      if (rs) { // 문제 3이 이미 재대조했다: 바뀐 약정만 경로 재검토(ROUTE_JUDGED로 닫힘), 결론이 같은 약정은 구간 재검토 하나로 '유지'
        for (const x of rs.changed_commitments ?? []) await openRouteReview(x.commitment_id, e);
        if ((rs.kept_commitment_ids ?? []).length) await windowRecheckReview(e, old, p, sid);
        return;
      }
      const inAny = (dt) => dt && ((dt >= old.start && dt <= old.end) || (dt >= p.shortfall_window_start && dt <= p.shortfall_window_end));
      for (const c of m('p3') ? safe(() => m('p3').listCommitments({}), []) : []) {
        if (c.commitment_type === '기발주' || !inAny(c.cash_outflow_date)) continue;
        await openRouteReview(c.commitment_id, e);
      }
    });
    on('ROUTE_JUDGED', onRouteJudged);
    on('APPROVAL_SUBMITTED', async (e) => {
      for (const cid of e.payload?.commitment_ids ?? []) {
        for (const r of store.reviewsRaw("target_type = 'commitment' AND commitment_id = ? AND review_status = '열림' AND review_kind = '전제 변경'", cid)) {
          await closeReview(r, { outcome: '변경', after: { approval_request_id: e.payload?.approval_request_id, approver: e.payload?.approver }, rationale: '경로 변경으로 재상신' });
        }
      }
    });
    on('APPROVAL_REPLIED', async (e) => {
      const p = e.payload ?? {};
      const c = commitmentById(p.commitment_id);
      if (p.decision === '승인' && c?.group_report_required) {
        await requestInfo({ request_topic: 'group_report', requested_to: 'GROUP', plan_id: e.plan_id, subject_type: 'commitment', subject_id: p.commitment_id, caused_by: e.event_id }, '그룹 보고(정책 9행, R9)');
      }
      if ((p.conditions ?? []).some((x) => x.condition_type === '기타')) {
        await openReview({ review_kind: '사람 판단', trigger: e, target_type: 'commitment', target_id: p.commitment_id, plan_id: e.plan_id, commitment_id: p.commitment_id, rejudge: false });
      }
    });
    on('FINANCE_CONFIRMED', async (e) => {
      for (const r of store.requestsRaw("request_topic = 'finance_confirmation' AND request_status IN ('회신 대기','기한 경과')")) await closeRequest(r.request_id, e);
    });
    on('INFO_REPLIED', async (e) => {
      const req = e.payload?.request_id ? store.requestRaw(e.payload.request_id) : null;
      if (req?.request_topic !== 'group_allocation') return;
      const r = store.issueRaw('OI-3');
      if (r && r.issue_status !== '종결') {
        store.saveIssue({ ...r, issue_status: '종결', closing_ref: store.J([e.event_id]) });
        await emit({ event_type: 'OPEN_ISSUE_CLOSED', source_type: '계산', plan_id: 'NONE', subject_type: 'open_issue', subject_id: 'OI-3', caused_by: e.event_id,
          payload: { issue_id: 'OI-3', plan_id: 'NONE', closing_ref: e.event_id } });
      }
      if (e.payload?.decision === '대상') {
        await openReview({ review_kind: '사람 판단', trigger: e, target_type: 'plan_bundle', target_id: 'PB-001', plan_id: 'NONE', rejudge: false });
      }
    });
    on(['PLAN_CONFIRMED', 'PLAN_WITHDRAWN', 'PLAN_AUTO_CONFIRMED_BY_DEADLINE'], async (e) => {
      for (const pid of laterPlans(e.plan_id, { useCacheForSelf: true })) await openSupplyReview(pid, e);
    });
    // 모든 사건: 회신 연결, 보류 재개 조건, 확정 가능 재계산
    on('*', async (e) => {
      if (e.caused_by && REPLY_EVENTS.has(e.event_type)) {
        const r = store.requestByEvent(e.caused_by);
        if (r) await closeRequest(r.request_id, e);
      }
      if (e.event_type === 'INFO_REPLIED' && e.payload?.request_id) await closeRequest(e.payload.request_id, e);
      for (const h of store.holdsRaw("hold_status = '보류 중'")) {
        const rc = store.P(h.resume_condition) ?? {};
        if (rc.event_type === e.event_type && (!rc.subject_id || [e.subject_id, e.plan_id].includes(rc.subject_id))) await resumeHold(h, '조건 충족', e);
      }
      if (['PLAN_CONFIRMABILITY_CHANGED', 'DEADLINE_WARNED', 'INFO_REQUESTED', 'AI_CALL_RECORDED', 'AI_OUTPUT_REVIEWED', 'OPEN_ISSUE_RAISED', 'PLAN_RECEIVED'].includes(e.event_type)) return;
      if (e.plan_id && e.plan_id !== 'NONE') await recompute(e.plan_id);
      else if (['CASH_WINDOW_REVISED', 'ROUTE_JUDGED', 'APPROVAL_REPLIED', 'INBOUND_SCHEDULE_REVISED', 'FINANCE_CONFIRMED'].includes(e.event_type)) await recomputeAll();
    });
  }

  // ── 화면용 사건 순서표 ──
  function schedule(filter = {}) {
    const deliveries = store.deliveries();
    const rows = [];
    for (const r of data.schedule) {
      if (filter.owner && r.owner !== filter.owner) continue;
      if (filter.scenario_id && r.scenario_id !== filter.scenario_id) continue;
      if (r.mock_id === 'M02') {
        for (const d of store.deadlinesRaw().filter((x) => x.commitment_type === '기안' && x.demand_input_due && hasOnTime(x.plan_id))) {
          const del = store.delivery(`M02:${d.plan_id}`);
          rows.push({ mock_id: `M02:${d.plan_id}`, sim_date: d.demand_input_due, seq: Number(r.seq), owner: r.owner, event_type: eventTypeOf(r), plan_id: d.plan_id,
            target: r.description, scenario_id: r.scenario_id, active: true, status: del?.status ?? (isDirect(d.plan_id) ? '직접 처리(사용자가 입력)' : '대기'), delivered_event_id: del?.event_id ?? null });
        }
        continue;
      }
      if (r.mock_id === 'M20') { rows.push(...coreviaRows(r)); continue; }
      if (r.mock_id === 'M25') { rows.push(...arrivalRows(r)); continue; }
      if (r.mock_id === 'M04') {
        for (const x of deliveries.filter((y) => y.mock_id === 'M04')) {
          const n = store.P(x.note) ?? {};
          rows.push({ mock_id: x.mock_key, sim_date: x.sim_date, seq: 9, owner: 'p3', event_type: 'APPROVAL_SUBMITTED', plan_id: x.plan_id,
            target: n.target ?? null, scenario_id: n.scenario_id ?? 'BASE', active: true, status: x.status, delivered_event_id: x.event_id });
        }
        for (const x of submissionRows()) {
          const { commitment_id, approver, commitment_type, ...row } = x;
          rows.push(row);
        }
        continue;
      }
      const dynamic = r.sim_date.startsWith('@');
      const del = dynamic ? null : store.delivery(r.mock_id);
      const alias = { M17: ['MD', 'MW', 'MU'], M18: ['MR'] }[r.mock_id] ?? [r.mock_id]; // 규칙 행이 남기는 실행 기록 ID
      const instances = dynamic ? deliveries.filter((x) => alias.includes(x.mock_id)) : [];
      rows.push({ mock_id: r.mock_id, sim_date: r.sim_date, seq: Number(r.seq), owner: r.owner, event_type: eventTypeOf(r), plan_id: r.plan_id,
        target: r.description, scenario_id: r.scenario_id, active: activeScenario(r.scenario_id),
        status: dynamic ? `규칙(실행 ${instances.length}건)` : (del?.status ?? (!activeScenario(r.scenario_id) ? '시나리오 꺼짐' : isMarketingRow(r) && isDirect(r.plan_id) ? '직접 처리(사용자가 함)' : '대기')),
        delivered_event_id: del?.event_id ?? null });
    }
    const f = rows.filter((r) => (!filter.from || r.sim_date >= filter.from || r.sim_date.startsWith('@')) && (!filter.to || r.sim_date <= filter.to));
    return f.sort((a, b) => (a.sim_date === b.sim_date ? a.seq - b.seq : a.sim_date < b.sim_date ? -1 : 1));
  }
  // Corevia 공급 회신(사용자 요청 2026-11-15 라): 발주안이 내부 승인되면 문제 2 회신 자료(S2-CVC)가 승인일 + n영업일에 도착한다.
  // 값과 도착일은 문제 2 소유(pendingSupplyCommitments). 문제 4는 순서표에 보이고 그날 deliverMock으로 전달한다(재처리 무해).
  // 기발주 대상 회신은 날짜가 정해져 있어 명시 행(M01·M07·M21~M23)으로 보이므로 여기서는 발주안 대상만 펼친다.
  function coreviaRows(r) {
    const pending = (m('p2')?.pendingSupplyCommitments ? safe(() => m('p2').pendingSupplyCommitments(), []) : []).filter((x) => x.po_draft_id);
    const done = ctx.events.query({ event_type: 'SUPPLIER_REPLIED', limit: ALL }).filter((e) => e.payload?.supply_commitment && e.payload.supply_commitment.target_type !== '기발주');
    const row = (x, extra) => ({ seq: Number(r.seq), owner: 'p2', event_type: 'SUPPLIER_REPLIED', scenario_id: r.scenario_id, active: true, ...x, ...extra });
    return [
      ...done.map((e) => { const sc = e.payload.supply_commitment;
        return row({ mock_id: `M20:${sc.record_id}:${sc.target_id}`, sim_date: e.occurred_at, plan_id: (sc.linked_plan_ids ?? [])[0] ?? 'NONE', record_id: sc.record_id, po_draft_id: sc.target_type === '발주안' ? sc.target_id : null,
          target: `${sc.target_type} ${sc.target_id} · ${sc.reply_status}${sc.validation_status === '확인 필요' ? '(확인 필요)' : ''}` }, { status: '완료', delivered_event_id: e.event_id }); }),
      ...pending.map((x) => row({ mock_id: `M20:${x.record_id}:${x.po_draft_id ?? 'PO'}`, sim_date: x.due_date, plan_id: 'NONE', record_id: x.record_id, po_draft_id: x.po_draft_id,
        target: `${x.po_draft_id ? `발주안 ${x.po_draft_id}` : '기발주'} · Corevia 회신 ${x.record_id}` }, { status: '대기', delivered_event_id: null })),
    ];
  }
  // 입고 처리 행(M25): 처리된 날은 사건으로, 앞으로 도착할 확약 입고는 도착일별 '대기'로 보인다(문제 2 onDay가 그날 처리)
  function arrivalRows(r) {
    const row = (x) => ({ seq: Number(r.seq), owner: 'p2', event_type: 'INBOUND_SCHEDULE_REVISED', scenario_id: r.scenario_id, active: true, plan_id: 'NONE', ...x });
    const done = ctx.events.query({ event_type: 'INBOUND_SCHEDULE_REVISED', limit: ALL }).filter((e) => e.payload?.receipts || e.payload?.overdue_expected);
    const t = today();
    const rowsNow = m('p2')?.inboundSchedule ? safe(() => m('p2').inboundSchedule({})?.rows, []) : [];
    const upcoming = new Map();
    for (const x of rowsNow.filter((y) => y.supply_status === '확약' && y.eta_date > t)) {
      const day = cal.isBusinessDay(x.eta_date) ? x.eta_date : nextBd(x.eta_date); // 주말 도착은 다음 영업일에 처리된다
      upcoming.set(day, (upcoming.get(day) ?? 0) + 1);
    }
    return [
      ...done.map((e) => row({ mock_id: `M25:${e.occurred_at}`, sim_date: e.occurred_at, status: '완료', delivered_event_id: e.event_id,
        target: `입고 실적 ${(e.payload.receipts ?? []).length}행(모의 입력) · 도착 예정일 경과·미확약 ${(e.payload.overdue_expected ?? []).length}행` })),
      // 앞으로 도착할 확약 입고는 가까운 3개 날짜만 보인다(그 뒤는 날짜가 오면 같은 방식으로 처리된다)
      ...[...upcoming].sort(([x], [y]) => x.localeCompare(y)).slice(0, 3).map(([date, n]) => row({ mock_id: `M25:${date}`, sim_date: date, status: '대기', delivered_event_id: null,
        target: `확약 입고 ${n}행 도착 예정(그날 입고 실적으로 처리)` })),
    ];
  }
  async function deliverCoreviaReplies(D) {
    const p2 = m('p2');
    if (!p2?.deliverMock || !p2.pendingSupplyCommitments) return;
    for (const x of safe(() => p2.pendingSupplyCommitments(), []).filter((y) => y.po_draft_id && y.due_date <= D)) {
      try { await p2.deliverMock(`M20:${x.record_id}:${x.po_draft_id ?? 'PO'}`); } catch (err) { ctx.log(`Corevia 회신 ${x.record_id} 전달 오류: ${err.message}`); }
    }
  }
  function nextEventDate() {
    const t = today();
    const cands = [
      ...(m('p2')?.pendingSupplyCommitments ? safe(() => m('p2').pendingSupplyCommitments(), []).map((x) => x.due_date) : []),
      ...data.schedule.filter((r) => /^\d{4}-/.test(r.sim_date) && activeScenario(r.scenario_id) && !store.delivery(r.mock_id)
        && !(isMarketingRow(r) && isDirect(r.plan_id))).map((r) => r.sim_date),
      ...store.deadlinesRaw().flatMap((d) => [d.demand_input_due, d.judgment_due, d.submission_due, d.first_reply_due, d.final_reply_due]),
      ...store.planStatesRaw().filter((s) => s.plan_status === '검토 중').map((s) => nextBd(s.contract_deadline)),
    ].filter((x) => x && x > t);
    const next = cands.sort()[0] ?? null;
    return next && !cal.isBusinessDay(next) ? nextBd(next) : next;
  }

  return {
    init, onDay, subscribe, requestInfo, placeHold, cancelHold, confirmPlan, withdrawPlan, recompute, recomputeAll,
    closeReview, schedule, nextEventDate, connected,
    getScenarios: () => scenarios,
    getDirectPlans: () => directPlans,
    isDirect,
    // 직접 처리 켜기·끄기: 언제든 바꿀 수 있다(시연 조작). 시나리오처럼 초기화해도 유지한다.
    setDirect(planId, on) {
      if (!store.planStateRaw(planId)) throw ctx.httpError(404, `기안이 없습니다: ${planId}`);
      directPlans = on ? [...new Set([...directPlans, planId])] : directPlans.filter((x) => x !== planId);
      store.setSetting('direct_plans', directPlans);
      return directPlans;
    },
    setScenarios(list) {
      const allowed = ['S-AR-DELAY', 'S4-OI3-A', 'S-SUP-REPLY', ...data.cashFloors.map((r) => r.scenario_id).filter((x) => x !== 'BASE')];
      for (const s of list) if (!allowed.includes(s)) throw ctx.httpError(400, `시나리오 값이 아닙니다: ${s}`);
      if (today() !== SIM_START) throw ctx.httpError(409, '시나리오는 가상 일자 2026-07-01에서만 바꿀 수 있습니다. 초기화 뒤 선택하세요');
      scenarios = [...new Set(list)];
      store.setSetting('scenarios', scenarios);
      return scenarios;
    },
    // L8: 직접 처리 기안을 모두 자동 처리로(날짜를 넘기기 전 시연 조작에서 고른다)
    setAllAuto() {
      directPlans = [];
      store.setSetting('direct_plans', directPlans);
      return directPlans;
    },
    restoreScenarios: () => { store.setSetting('scenarios', scenarios); store.setSetting('direct_plans', directPlans); },
  };
}
