// 문제 2 모듈: 입고 일정 · 재고 전개 · 잔여 여지 · 공급 판정 · 대안 · 발주안.
// 이름은 problem4/공통_접점.md 3.2, 규칙은 problem2/명세.md 4절, 붙이는 방법은 app/모듈_계약.md.
import * as C from './calc.mjs';
import { addDays, addBusinessDays, weekStart } from '../../app/core/calendar.mjs';
import { makeDescribe, skuReason, verdictLabel, altBrief, ALT_NAME, EVENT_NAME, refName } from './describe.mjs';

const SPEC = 'problem2/명세.md';
const CONFIRMED = new Set(['확정', '기한 경과 확정']);
const SEVERITY = { 가능: 0, 조건부: 1, 부족: 2 };
const NOT_CONNECTED = '연결 안 됨';

export async function register(ctx) {
  const { db } = ctx;
  const T = (name, ddl) => ctx.defineTable(name, ddl);
  T('p2_inbound_version', 'inbound_schedule_version TEXT PRIMARY KEY, n INTEGER, event_id TEXT, reason TEXT, created_on TEXT');
  T('p2_inbound_row', 'inbound_schedule_version TEXT, inbound_row_id TEXT, row_json TEXT, PRIMARY KEY(inbound_schedule_version, inbound_row_id)');
  T('p2_judgment', 'supply_judgment_id TEXT, supply_judgment_version INTEGER, plan_id TEXT, sku_id TEXT, row_json TEXT, event_id TEXT, PRIMARY KEY(supply_judgment_id, supply_judgment_version)');
  T('p2_alternative', 'alternative_id TEXT PRIMARY KEY, plan_id TEXT, n INTEGER, row_json TEXT');
  T('p2_selection', 'alternative_id TEXT PRIMARY KEY, plan_id TEXT, event_id TEXT, row_json TEXT');
  T('p2_plan_change', 'plan_id TEXT, plan_version INTEGER, row_json TEXT, PRIMARY KEY(plan_id, plan_version)');
  T('p2_po_draft', 'po_draft_id TEXT, draft_version INTEGER, row_json TEXT, state_json TEXT, PRIMARY KEY(po_draft_id, draft_version)');
  T('p2_supply_request', 'supply_request_id TEXT PRIMARY KEY, plan_id TEXT, row_json TEXT');
  T('p2_applied', 'record_id TEXT PRIMARY KEY, event_id TEXT, result_json TEXT');
  T('p2_rejection', 'plan_id TEXT PRIMARY KEY, event_id TEXT');
  T('p2_ai_pending', 'ai_call_id TEXT PRIMARY KEY, request_id TEXT, row_json TEXT, status TEXT');
  T('p2_request', 'request_id TEXT PRIMARY KEY, request_topic TEXT, subject_id TEXT, event_id TEXT');
  T('p2_judgment_key', 'plan_id TEXT PRIMARY KEY, premise_key TEXT, conclusion_key TEXT');
  T('p2_judge_check', 'trigger_event_id TEXT, plan_id TEXT, changed INTEGER, supply_judgment_version INTEGER, PRIMARY KEY(trigger_event_id, plan_id)');
  // 거절된 발주안에 기대던 기안·SKU: 보충 발주로 막을 수 없으므로 전 구간을 막을 수 없는 구간으로 본다(조정자 E (2))
  T('p2_reorder_block', 'plan_id TEXT, sku_id TEXT, po_draft_id TEXT, event_id TEXT, PRIMARY KEY(plan_id, sku_id)');
  // Corevia 공급 회신(supply_commitment): 대상(발주안·기발주)별 버전. record_id 단위로 한 번만 반영한다
  T('p2_commitment', 'target_id TEXT, record_id TEXT, reply_version INTEGER, row_json TEXT, event_id TEXT, PRIMARY KEY(target_id, record_id)');
  // SCM 기준 수요 보충 계획 회신 반영 상태(SKU별)
  T('p2_br_status', 'sku_id TEXT PRIMARY KEY, row_json TEXT, event_id TEXT');

  // ── 원본·합성 자료 (읽기 전용) ──
  const num = ctx.toNum;
  const skus = ctx.raw.load('02_masil/master/m_sku_ms.csv').map((s) => ({
    sku_id: s.sku_id, sku_name: s.sku_name, category: s.category, product_id: s.product_id,
    safety_stock_weeks_min: num(s.safety_stock_weeks_min), safety_stock_weeks_max: num(s.safety_stock_weeks_max),
    moq: num(s.moq), lead_time_weeks: num(s.lead_time_weeks),
  }));
  const skuById = new Map(skus.map((s) => [s.sku_id, s]));
  const inventory = new Map(ctx.raw.load('02_masil/inventory/sku_inventory_ms.csv').map((r) => [r.sku_id, {
    on_hand_qty: num(r.on_hand_qty), in_transit_qty: num(r.in_transit_qty), stock_cover_weeks: num(r.stock_cover_weeks), snapshot_date: r.snapshot_date,
  }]));
  const pos = ctx.raw.load('02_masil/inventory/sc_purchase_orders_ms.csv').map((p) => ({
    po_id: p.po_id, sku_id: p.sku_id, supplier_id: p.supplier_id, order_date: p.order_date, order_qty: num(p.order_qty),
    moq: num(p.moq), lead_time_weeks: num(p.lead_time_weeks), amount_krw: num(p.amount_krw), payment_due_date: p.payment_due_date,
    derived_eta_date: addDays(p.order_date, num(p.lead_time_weeks) * 7),
  }));
  const poBySku = new Map(pos.map((p) => [p.sku_id, p]));
  const unitCost = new Map();
  for (const r of ctx.raw.load('02_masil/marketing/mkt_cost_master_ms.csv')) unitCost.set(r.sku_id, num(r.product_cost_krw));
  const targetWeeks = new Map(ctx.data.load('s2_target_stock_weeks.csv').map((r) => [r.sku_id, num(r.target_stock_weeks)]));
  // 기발주 입고 회신은 Corevia 공급 회신(S2-CVC, target_type=po)으로 합쳤다(이중 반영 방지). S2-ETA는 운송 중 물량만 남는다
  const etaIt = ctx.data.load('s2_eta_it.csv');
  const supplyReplies = ctx.data.load('s2_supply_reply.csv');
  const mockSelections = ctx.data.load('s2_mock_selection.csv');
  const replyRecords = new Map(etaIt.map((r) => [r.record_id, r]));
  // SCM 기준 수요 보충 계획 회신(S2-SCM-BR)과 Corevia 공급 회신(S2-CVC) — 명세 0절, 3.3
  const brPlan = ctx.data.load('s2_scm_replenishment.csv');
  const cvcRecords = ctx.data.load('s2_corevia_commitment.csv');

  // ── 공통 도구 ──
  const J = (v) => JSON.stringify(v);
  const P = (s) => (s == null ? null : JSON.parse(s));
  const p1 = () => ctx.module('p1');
  const p3 = () => ctx.module('p3');
  const p4 = () => ctx.module('p4');
  const safe = (fn, fallback = null) => { try { return fn(); } catch (err) { ctx.log('다른 모듈 호출 오류:', err.message); return fallback; } };
  const emit = (e) => ctx.events.emit({ spec_ref: SPEC, ...e });
  let dirty = 0;
  const touch = () => { dirty += 1; };

  // ── 입고 일정 ──
  const latestInbound = () => db.prepare('SELECT * FROM p2_inbound_version ORDER BY n DESC LIMIT 1').get() ?? null;
  const inboundRowsOf = (version) => db.prepare('SELECT row_json FROM p2_inbound_row WHERE inbound_schedule_version = ? ORDER BY inbound_row_id')
    .all(version).map((r) => P(r.row_json));

  function v0Rows() {
    const rows = pos.map((p) => ({
      inbound_row_id: `IB-${p.po_id}`, sku_id: p.sku_id, source_ref: p.po_id, qty: p.order_qty,
      eta_date: p.derived_eta_date, eta_status: '미회신', supply_status: '예상', source_type: '원본도출', is_synthetic: false,
      scenario_id: 'BASE', effective_at: ctx.clock.today(), record_id: null,
    }));
    for (const s of skus) {
      rows.push({
        inbound_row_id: `IB-IT-${s.sku_id}`, sku_id: s.sku_id, source_ref: `IN_TRANSIT:${s.sku_id}`,
        qty: inventory.get(s.sku_id).in_transit_qty, eta_date: C.FIRST_WEEK, eta_status: '미회신', supply_status: '예상', source_type: '가정',
        is_synthetic: false, scenario_id: 'BASE', effective_at: ctx.clock.today(), record_id: null,
      });
    }
    return rows;
  }
  function saveInboundVersion(rows, reason) {
    const last = latestInbound();
    const n = last ? last.n + 1 : 0;
    const version = `IS-v${n}`;
    const full = rows.map((r) => ({ ...r, inbound_schedule_version: version, arrival_week_start: weekStart(r.eta_date) }));
    db.prepare('INSERT INTO p2_inbound_version VALUES (?, ?, ?, ?, ?)').run(version, n, null, reason, ctx.clock.today());
    const ins = db.prepare('INSERT INTO p2_inbound_row VALUES (?, ?, ?)');
    for (const r of full) ins.run(version, r.inbound_row_id, J(r));
    touch();
    return { version, rows: full };
  }
  function ensureInbound() {
    if (!latestInbound()) saveInboundVersion(v0Rows(), '원본 도출(발주일 + 리드타임), 운송 중 07-06 주 가정');
  }
  const currentInbound = () => { ensureInbound(); const v = latestInbound(); return { version: v.inbound_schedule_version, rows: inboundRowsOf(v.inbound_schedule_version) }; };

  // ── 계획 변경(집행일이동) ──
  const planChangesOf = (planId) => db.prepare('SELECT row_json FROM p2_plan_change WHERE plan_id = ? ORDER BY plan_version').all(planId).map((r) => P(r.row_json));

  // ── 모델: 현재 전제(입고·기준 수요·수요 입력·순서)를 한 번에 모은다 ──
  let cache = null;
  let cacheKey = null;
  function model() {
    const today = ctx.clock.today();
    const key = `${today}|${dirty}`;
    if (cache && cacheKey === key) return cache;
    const m1 = p1();
    const m4 = p4();
    const inbound = currentInbound();
    const baseline = new Map();
    let baselineVersion = null;
    if (m1?.baselineDemand) {
      for (const b of [].concat(safe(() => m1.baselineDemand(), []) ?? [])) {
        baseline.set(b.sku_id, Number(b.baseline_weekly_qty));
        baselineVersion = b.baseline_demand_version;
      }
    }
    const planSku = new Map();
    for (const r of (m1?.planSkuMap ? safe(() => m1.planSkuMap({}), []) : []) ?? []) {
      if (!planSku.has(r.plan_id)) planSku.set(r.plan_id, []);
      planSku.get(r.plan_id).push(r.sku_id);
    }
    const states = new Map(((m4?.listPlanStates ? safe(() => m4.listPlanStates(), []) : []) ?? []).map((s) => [s.plan_id, s.plan_status]));
    const withdrawn = new Set(ctx.events.query({ event_type: 'PLAN_WITHDRAWN', limit: 1e6 }).map((e) => e.plan_id));
    const plans = ctx.plans().map((p) => {
      const changes = planChangesOf(p.plan_id);
      const last = changes[changes.length - 1];
      return { ...p, settlement_date: last?.settlement_date ?? p.settlement_date,
        plan_status: states.get(p.plan_id) ?? (withdrawn.has(p.plan_id) ? '철회' : '검토 중') };
    });
    const active = plans.filter((p) => p.plan_status !== '철회').sort((a, b) =>
      (CONFIRMED.has(b.plan_status) - CONFIRMED.has(a.plan_status))
      || a.contract_deadline.localeCompare(b.contract_deadline)
      || a.settlement_date.localeCompare(b.settlement_date)
      || a.plan_id.localeCompare(b.plan_id));
    const rank = new Map(active.map((p, i) => [p.plan_id, i + 1]));
    const demand = new Map(); // plan_id -> { input, added: Map(sku -> array) }
    if (m1?.demandInput) {
      for (const p of plans) {
        const input = safe(() => m1.demandInput(p.plan_id));
        if (!input) continue;
        const rows = (m1.campaignDemandWeekly ? safe(() => m1.campaignDemandWeekly({ plan_id: p.plan_id }), []) : []) ?? [];
        const added = new Map();
        for (const sku of planSku.get(p.plan_id) ?? []) added.set(sku, C.addedToArray(rows.filter((r) => r.sku_id === sku)));
        demand.set(p.plan_id, { input, added });
      }
    }
    const blocks = new Map(db.prepare('SELECT * FROM p2_reorder_block').all().map((b) => [`${b.plan_id}|${b.sku_id}`, b]));
    const openDrafts = new Map(latestDrafts().filter(isOpenDraft).map((d) => [d.sku_id, d]));
    const brStatus = new Map(db.prepare('SELECT * FROM p2_br_status').all().map((r) => [r.sku_id, P(r.row_json)]));
    cache = {
      today, links: { p1: Boolean(m1), p3: Boolean(p3()), p4: Boolean(m4) },
      inbound, baseline, baselineVersion, planSku, plans, planById: new Map(plans.map((p) => [p.plan_id, p])), rank, demand, blocks, openDrafts, brStatus,
      ready: skus.every((s) => Number.isFinite(baseline.get(s.sku_id))),
    };
    cacheKey = key;
    return cache;
  }
  const inboundOfSku = (m, sku) => m.inbound.rows.filter((r) => r.sku_id === sku);

  // 앞 순번(rank 작은) 기안들의 추가분 합
  function priorAdded(m, planId, sku) {
    const arr = C.zeros();
    const myRank = m.rank.get(planId) ?? Infinity;
    for (const [pid, d] of m.demand) {
      if (pid === planId || !(m.rank.get(pid) < myRank)) continue;
      const a = d.added.get(sku);
      if (a) a.forEach((v, i) => { arr[i] += v; });
    }
    return arr;
  }
  // 막을 수 없는 구간의 끝: 이 인덱스부터 보충 발주로 막을 수 있다(조정자 확정 (1)).
  // 이 기안·SKU가 기대던 발주안이 거절됐으면 보충 발주가 없다(조정자 E (2)). 판매 기간 끝 주까지를 막을 수 없는 구간으로 늘린다.
  // 판매 기간 뒤의 부족(캠페인이 앞당긴 기존 수요 품절)은 정상 보충 주기의 몫으로 보고 이 기안의 판정에 넣지 않는다.
  const blockOf = (m, planId, sku) => (planId ? m.blocks.get(`${planId}|${sku}`) ?? null : null);
  const saleEndOf = (m, planId) => {
    const d = m.demand.get(planId);
    return d ? C.idxOfWeek(d.input.sale_start_week) + Number(d.input.sale_weeks) - 1 : -1;
  };
  const reachOf = (m, sku, planId = null, saleEndIdx = null) => {
    let R = C.reachIndex(m.today, skuById.get(sku).lead_time_weeks);
    if (!blockOf(m, planId, sku)) {
      // 이 기안이 이어진 승인 전 SKU 발주안이 있고 그 발주 예정일이 아직 안 지났으면, 그 발주안이 도착하는 주부터는 아직 막을 수 있다.
      // (오늘 + 7영업일로만 보면 이미 만든 발주안이 제때 도착하는데도 날짜 경과만으로 부족이 된다)
      const d = planId ? m.openDrafts.get(sku) : null;
      if (d && d.linked_plan_ids.includes(planId) && m.today <= d.planned_order_date) {
        const i = C.arrivalIndex(addDays(d.planned_order_date, skuById.get(sku).lead_time_weeks * 7));
        if (i >= 0) R = Math.min(R, i);
      }
      return R;
    }
    return Math.min(C.N, Math.max(R, (saleEndIdx ?? saleEndOf(m, planId)) + 1));
  };
  // 전개: 기준 수요는 전 구간에서 재고를 깎는다(명세 0절 5). SCM이 확인한 기준 수요 보충 계획 행만 입고에 들어 있다.
  const baseProjection = (m, sku, scenario, added = C.zeros()) => C.project(
    inventory.get(sku).on_hand_qty, C.inboundArray(inboundOfSku(m, sku), scenario), added.map((a) => m.baseline.get(sku) + a));
  // SCM이 확인한 기준 수요 보충 계획이 있는 SKU
  const brCovered = (m, sku) => m.brStatus.get(sku)?.scm_confirmed === '확인';

  // ── 잔여 여지·추가분 0 전개 ──
  function projectionBaseRows(m, { sku_id, inbound_scenario } = {}) {
    if (!m.ready) return [];
    const out = [];
    for (const s of skus) {
      if (sku_id && s.sku_id !== sku_id) continue;
      for (const sc of C.SCENARIOS) {
        if (inbound_scenario && sc !== inbound_scenario) continue;
        const { poh, unmet } = baseProjection(m, s.sku_id, sc);
        const b = m.baseline.get(s.sku_id);
        const R = reachOf(m, s.sku_id);
        C.WEEKS.forEach((w, i) => out.push({
          sku_id: s.sku_id, week_start: w, inbound_scenario: sc, supply_window: C.supplyWindow(i, R),
          projected_on_hand_qty: C.r2(poh[i]), unmet_qty: C.r2(unmet[i]),
          projected_cover_weeks: b > 0 ? C.r2(poh[i] / b) : null, beyond_horizon: w > C.HORIZON_END,
          inbound_schedule_version: m.inbound.version, baseline_demand_version: m.baselineVersion,
        }));
      }
    }
    return out;
  }
  function baseOnlyRows(m, { sku_id, inbound_scenario } = {}) {
    if (!m.ready) return [];
    const out = [];
    for (const s of skus) {
      if (sku_id && s.sku_id !== sku_id) continue;
      for (const sc of C.SCENARIOS) {
        if (inbound_scenario && sc !== inbound_scenario) continue;
        const unmet = baseProjection(m, s.sku_id, sc).unmet;
        const R = reachOf(m, s.sku_id);
        const up = C.stockoutInfo(unmet.map((u, i) => (i < R ? u : 0)));
        out.push({ sku_id: s.sku_id, inbound_scenario: sc, ...C.stockoutInfo(unmet),
          reorder_reach_week: R < C.N ? C.WEEKS[R] : null, unpreventable_end_week: R > 0 ? C.WEEKS[Math.min(R, C.N) - 1] : null,
          first_unpreventable_stockout_week: up.first_stockout_week, unpreventable_stockout_weeks: up.stockout_weeks,
          unpreventable_shortfall_ea: C.r2(C.sum(unmet, 0, R - 1)) });
      }
    }
    return out;
  }
  function headroomRows(m, { plan_id, sku_id, inbound_scenario }) {
    if (!m.ready || !plan_id) return [];
    const out = [];
    for (const sku of m.planSku.get(plan_id) ?? []) {
      if (sku_id && sku !== sku_id) continue;
      for (const sc of C.SCENARIOS) {
        if (inbound_scenario && sc !== inbound_scenario) continue;
        const R = reachOf(m, sku, plan_id);
        const room = C.unpreventableRoom(baseProjection(m, sku, sc, priorAdded(m, plan_id, sku)).poh, R);
        C.WEEKS.forEach((w, i) => out.push({
          plan_id, sku_id: sku, week_start: w, inbound_scenario: sc, supply_window: C.supplyWindow(i, R),
          residual_headroom_qty: room[i] == null ? null : C.r2(room[i]),
          plan_order_rank: m.rank.get(plan_id) ?? null, ordering_rule_version: C.ORDERING_RULE_VERSION,
        }));
      }
    }
    return out;
  }

  // ── 공급 판정 ──
  const judgmentIdOf = (planId, sku) => (sku ? `SJ-${planId}-${sku}` : `SJ-${planId}`);
  // withPrior=false: 수요 입력이 없는 기안은 기존 수요만(앞 순번 추가분 없이)으로 방향을 낸다(base_only_shortfall과 같은 기준)
  function directionNote(m, planId, sku, withPrior = true) {
    if (!m.ready) return `문제 1 ${NOT_CONNECTED}: 기준 수요·기안-SKU 대응이 없어 전개하지 못했습니다`;
    const list = sku ? [sku] : (m.planSku.get(planId) ?? []);
    const hard = [];
    const soft = [];
    for (const s of list) {
      const R = reachOf(m, s, planId);
      const unmet = baseProjection(m, s, 'on_schedule', withPrior ? priorAdded(m, planId, s) : C.zeros()).unmet;
      const endW = R > 0 ? C.WEEKS[Math.min(R, C.N) - 1] : null;
      const upW = C.WEEKS.filter((_, i) => i < R && unmet[i] > C.EPS);
      if (upW.length) hard.push(`${s} ${upW[0]}~${upW[upW.length - 1]} (막을 수 없는 구간 ~${endW})`);
      else if (unmet.some((u, i) => i >= R && u > C.EPS)) soft.push(`${s} ${C.WEEKS[R]} 이후`);
    }
    const parts = [];
    if (hard.length) parts.push(`지금 발주해도 막을 수 없는 기존 수요 품절: ${hard.join('; ')}. 판매 기간이 그 주를 포함하거나 그보다 앞서면 증가율과 무관하게 부족입니다`);
    else parts.push('막을 수 없는 구간에는 기존 수요 품절이 없습니다. 그 구간의 잔여 여지 안이면 부족이 아닙니다');
    if (soft.length) parts.push(`보충 발주로 막을 수 있는 품절: ${soft.join('; ')}. 추가분이 이 구간의 부족을 늘리면 조건부(보충 발주 필요)입니다`);
    const blocked = list.map((s) => [s, blockOf(m, planId, s)]).filter(([, b]) => b);
    if (blocked.length) parts.push(`발주안 거절로 보충 발주가 없는 SKU: ${blocked.map(([s, b]) => `${s}(${b.po_draft_id})`).join(', ')}. 이 SKU는 전개 끝까지 막을 수 없는 구간으로 봅니다`);
    return parts.join('. ');
  }

  function computeJudgment(m, planId) {
    const plan = m.planById.get(planId);
    const skuList = m.planSku.get(planId) ?? [];
    const d = m.demand.get(planId);
    const synthInbound = m.inbound.rows.some((r) => r.is_synthetic);
    const premise = {
      demand_input_id: d?.input.demand_input_id ?? null, demand_input_version: d?.input.version ?? null,
      baseline_demand_version: m.baselineVersion, inbound_schedule_version: m.inbound.version,
      ordering_rule_version: C.ORDERING_RULE_VERSION,
    };
    const common = {
      plan_id: planId, plan_order_rank: m.rank.get(planId) ?? null, premise_refs: premise, source_type: '계산', scenario_id: 'BASE',
    };
    const empty = {
      first_shortage_week: null, shortage_weeks: [], shortage_qty_base_ea: null, shortage_qty_campaign_ea: null,
      preventable_by_reorder: false, condition_basis: [], stock_warning: false, safety_breach_weeks: [],
    };
    if (!d || !m.ready || !plan || !m.rank.has(planId)) {
      const isSim = synthInbound;
      const skuRows = skuList.map((s) => ({
        supply_judgment_id: judgmentIdOf(planId, s), ...common, sku_id: s, supply_verdict: '판정불가', ...empty,
        direction_note: directionNote(m, planId, s, false), beyond_horizon: false, is_simulation: isSim,
      }));
      return {
        plan: { supply_judgment_id: judgmentIdOf(planId), ...common, sku_id: null, supply_verdict: '판정불가', ...empty,
          direction_note: directionNote(m, planId, null, false), beyond_horizon: false, is_simulation: isSim },
        skus: skuRows,
      };
    }
    const startIdx = C.idxOfWeek(d.input.sale_start_week);
    const endIdx = startIdx + Number(d.input.sale_weeks) - 1;
    const beyond = startIdx < 0 || endIdx >= C.N || C.WEEKS[Math.min(endIdx, C.N - 1)] > C.HORIZON_END || endIdx >= C.N;
    const skuRows = [];
    for (const s of skuList) {
      const sku = skuById.get(s);
      const args = {
        onHand: inventory.get(s).on_hand_qty, inboundRows: inboundOfSku(m, s), baseline: m.baseline.get(s),
        prevAdded: priorAdded(m, planId, s), ownAdded: d.added.get(s) ?? C.zeros(), saleStartIdx: Math.max(0, startIdx), saleEndIdx: endIdx,
        safetyMin: sku.safety_stock_weeks_min, R: reachOf(m, s, planId), noReorder: Boolean(blockOf(m, planId, s)), baselineCovered: brCovered(m, s),
      };
      const r = C.judgeSku(args);
      // 보충 발주 필요량은 SKU 단위 누적으로 센다(조정자 G (3)): 승인된 캠페인 발주안(MOQ 올림분 포함)은 입고 일정에 들어가 있고,
      // covered_from_week 뒤에는 기준 수요가 재고를 깎지 않으므로, 앞 순번 기안의 캠페인 추가분을 채우고 남은 물량이 그대로 이 기안 몫을 채운다.
      // 남은 필요량(additional_reorder_qty_ea) = 승인 발주안까지 반영한 전개의 캠페인 부족. 승인 발주안이 덮은 양 = 그것들을 뺀 전개의 필요량 − 남은 필요량.
      const r0 = C.judgeSku({ ...args, inboundRows: args.inboundRows.filter((x) => !C.isCampaignDraftRow(x)) });
      const remain = r.reorder_need?.additional_reorder_qty_ea ?? 0;
      const need0 = Math.max(r0.reorder_need?.additional_reorder_qty_ea ?? 0, remain);
      const covered = C.r2(need0 - remain);
      const conditions = r.condition_basis.map((c) => {
        if (c.condition_type !== 'reorder_required') return { ...c, sku_id: s };
        // 발주 시한: 이 날까지 발주해야 needed_by_week 주까지 도착한다(그 주 금요일 − 리드타임)
        const orderBy = addDays(c.needed_by_week, 4 - sku.lead_time_weeks * 7);
        return { ...c, sku_id: s, campaign_need_ea: C.r2(need0), covered_by_approved_qty_ea: covered, uncovered_qty_ea: c.additional_reorder_qty_ea,
          order_deadline: orderBy, order_deadline_passed: orderBy < m.today, po_draft_preview: null };
      });
      const need = r.condition_basis.find((c) => c.condition_type === 'reorder_required');
      const block = blockOf(m, planId, s);
      skuRows.push({
        // 판정에 쓴 구간(설명용): 이 주 이전은 지금 발주해도 막을 수 없음. 정기 보충 가정 시작 주
        reorder_reach_week: args.R < C.N ? C.WEEKS[args.R] : null, baseline_plan_status: brStatusLabel(m, s),
        reorder_blocked: block ? { po_draft_id: block.po_draft_id, approval_event_id: block.event_id } : null,
        // 보충 가능 구간의 남은 캠페인 추가 필요량(승인 발주안 반영 뒤). campaign_need_ea는 승인 발주안 없이 본 필요량.
        // kind=condition: 보충 발주 필요 조건에서 나옴. kind=shortage: 부족 SKU의 보충 가능 구간 몫(보충발주 대안을 고르면 발주안에 들어감)
        reorder_need: r.reorder_need ? { kind: need ? 'condition' : 'shortage', ...r.reorder_need, campaign_need_ea: C.r2(need0), covered_by_approved_qty_ea: covered } : null,
        supply_judgment_id: judgmentIdOf(planId, s), ...common, sku_id: s, supply_verdict: r.verdict,
        first_shortage_week: r.first_shortage_week, shortage_weeks: r.shortage_weeks,
        shortage_qty_base_ea: r.shortage_qty_base_ea, shortage_qty_campaign_ea: r.shortage_qty_campaign_ea,
        preventable_by_reorder: r.preventable_by_reorder, condition_basis: conditions,
        stock_warning: r.stock_warning, safety_breach_weeks: r.safety_breach_weeks,
        direction_note: directionNote(m, planId, s), beyond_horizon: beyond, is_simulation: true,
      });
    }
    const worst = skuRows.reduce((w, r) => (SEVERITY[r.supply_verdict] > SEVERITY[w] ? r.supply_verdict : w), '가능');
    const short = skuRows.filter((r) => r.supply_verdict === worst && worst !== '가능');
    const weeks = [...new Set(short.flatMap((r) => r.shortage_weeks))].sort();
    const total = (f) => C.r2(skuRows.reduce((s, r) => s + (r[f] ?? 0), 0));
    return {
      plan: {
        supply_judgment_id: judgmentIdOf(planId), ...common, sku_id: null, supply_verdict: worst,
        first_shortage_week: weeks[0] ?? null, shortage_weeks: weeks,
        shortage_qty_base_ea: total('shortage_qty_base_ea'),
        shortage_qty_campaign_ea: C.r2(short.reduce((s, r) => s + r.shortage_qty_campaign_ea, 0)),
        preventable_by_reorder: short.length > 0 && short.every((r) => r.preventable_by_reorder),
        condition_basis: worst === '조건부' ? skuRows.flatMap((r) => r.condition_basis) : [],
        stock_warning: skuRows.some((r) => r.stock_warning),
        safety_breach_weeks: [...new Set(skuRows.flatMap((r) => r.safety_breach_weeks))].sort(),
        direction_note: directionNote(m, planId), beyond_horizon: beyond, is_simulation: true,
        reorder_blocked: skuRows.filter((r) => r.reorder_blocked).map((r) => ({ sku_id: r.sku_id, ...r.reorder_blocked })),
      },
      skus: skuRows,
    };
  }

  const latestJudgmentRow = (id) => P(db.prepare('SELECT row_json FROM p2_judgment WHERE supply_judgment_id = ? ORDER BY supply_judgment_version DESC LIMIT 1').get(id)?.row_json);
  // ── 판정 새 버전의 조건(조정자 확정 (2)) ──
  const CLOSED = new Set(['확정', '기한 경과 확정', '철회']);
  const planStatusOf = (planId) => (p4()?.getPlanState ? safe(() => p4().getPlanState(planId)?.plan_status ?? null) : null);
  // 결론 = 판정값·조건·부족 주
  const conclusionKey = (rows, withDraft = true) => J(rows.map((r) => [r.sku_id, r.supply_verdict, r.shortage_weeks,
    (r.condition_basis ?? []).map((c) => [c.condition_type, c.sku_id, c.source_ref ?? null, withDraft ? (c.po_draft_id ?? null) : null])]));
  // 전제 = 이 기안에 영향을 주는 것만(수요 버전, 기준 수요, 이 기안 SKU의 입고 행, 앞 순번 추가분, 순번)
  function premiseKey(m, planId) {
    const skuList = m.planSku.get(planId) ?? [];
    const d = m.demand.get(planId);
    // 순번 숫자는 넣지 않는다(효과는 앞 순번 추가분으로 반영). 수요 입력이 없으면 앞 순번 추가분도 판정에 쓰지 않는다.
    return J({ dv: d?.input.version ?? null, bv: m.baselineVersion,
      // 입고 완료는 판정에서 확약과 같으므로 전제로는 같게 본다(입고 실적만으로 새 판정 버전을 내지 않음)
      inbound: skuList.map((s) => inboundOfSku(m, s).map((r) => [r.inbound_row_id, C.effectiveEta(r), C.supplyStatusOf(r) === '입고 완료' ? '확약' : C.supplyStatusOf(r), r.qty])),
      br: skuList.map((s) => brStatusLabel(m, s)),
      prior: d ? skuList.map((s) => priorAdded(m, planId, s).join(',')) : null,
      blocked: skuList.filter((s) => blockOf(m, planId, s)) });
  }
  const storedKeys = (planId) => db.prepare('SELECT * FROM p2_judgment_key WHERE plan_id = ?').get(planId) ?? null;

  // 판정 행 저장을 사건 전파보다 먼저 하기 위한 emit 래퍼
  async function emitWithRows(e, rows) {
    const ins = db.prepare('INSERT INTO p2_judgment VALUES (?, ?, ?, ?, ?, ?)');
    for (const r of rows) ins.run(r.supply_judgment_id, r.supply_judgment_version, r.plan_id, r.sku_id, J(r), null);
    touch();
    const ev = await ctx.events.emit({ spec_ref: SPEC, ...e });
    db.prepare('UPDATE p2_judgment SET event_id = ? WHERE supply_judgment_id = ? AND supply_judgment_version = ?')
      .run(ev.event_id, rows[0].supply_judgment_id, rows[0].supply_judgment_version);
    const plan = rows[0];
    // 공급 조건(미확정 입고·공급 확약 대기·기준 수요 보충 미확인)에 기대거나 부족이면 대안을 다시 계산한다(명세 0절 4)
    const needsAlts = plan.supply_verdict === '부족' || (plan.condition_basis ?? []).some((c) => c.condition_type !== 'reorder_required');
    if (needsAlts || hasRejection(plan.plan_id)) await computeAlternatives(plan.plan_id, ev.event_id);
    return ev;
  }

  // ── SKU 단위 발주안(조정자 E (1)) ──
  // 한 SKU에 열린(승인 전) 발주안은 하나다. 수량은 원본 산식 max(Target − 현재고 − 미입고, 0)을 그 SKU의 모든 등록 수요
  // (기준 수요 + 철회되지 않은 기안의 캠페인 추가분 전체)로 계산하고, 연결 기안의 남은 필요량 합보다 작으면 그 합으로 올린 뒤 MOQ를 반영한다.
  // 기안의 보충 조건은 그 SKU의 발주안을 가리킨다. 승인된 발주안이 이 기안 몫을 덮으면 조건 충족, 모자라면 모자란 만큼만 새 초안을 만든다.
  const isApproved = (d) => Boolean(d._state?.approved) || d.po_draft_status === '발주';
  const isOpenDraft = (d) => ['초안', '승인대기'].includes(d.po_draft_status) && !isApproved(d);
  const openDraftOf = (sku) => latestDrafts().find((x) => x.sku_id === sku && isOpenDraft(x)) ?? null;
  // 보충발주 대안으로 SKU 발주안에 이은 기안(부족 SKU의 보충 가능 구간 몫을 발주안에 넣는다)
  // 조건이 부족으로 바뀐 기안도 이미 이어진 열린 발주안에서는 빼지 않는다(조정자 D2 (가): 부족이 되어도 보충은 여전히 필요)
  const manualSet = (sku) => new Set(latestDrafts().filter((x) => x.sku_id === sku && !['취소', '반려'].includes(x.po_draft_status))
    .flatMap((x) => [...(x._state?.manual_links ?? []), ...(isOpenDraft(x) ? x.linked_plan_ids : [])]));
  function rawNeeds(m, sku, override = null) {
    const out = [];
    const manual = manualSet(sku);
    for (const pid of m.rank.keys()) {
      if (blockOf(m, pid, sku)) continue;
      if (override && pid === override.planId) { if (override.need > C.EPS) out.push({ pid, need: override.need, week: override.week ?? null }); continue; }
      const row = latestJudgmentRow(judgmentIdOf(pid, sku));
      const rn = row?.reorder_need ?? (row?.condition_basis ?? []).find((x) => x.condition_type === 'reorder_required');
      if (rn?.kind === 'shortage' && !manual.has(pid)) continue;
      if (rn?.additional_reorder_qty_ea > C.EPS) { out.push({ pid, need: rn.additional_reorder_qty_ea, week: rn.needed_by_week }); continue; }
      // 이어진 열린 발주안이 있는데 SKU가 부족으로 바뀌어 보충 가능 구간 몫이 없어졌으면, 그 발주안의 이 기안 몫을 그대로 둔다(D2 (가))
      if (row?.supply_verdict === '부족' && manual.has(pid)) {
        const share = openDraftOf(sku)?.qty_breakdown?.campaign_by_plan?.find((x) => x.plan_id === pid);
        if (share?.qty_ea > C.EPS) out.push({ pid, need: share.qty_ea, week: share.needed_by_week });
      }
    }
    return out.sort((x, y) => m.rank.get(x.pid) - m.rank.get(y.pid));
  }
  // SKU의 연결 기안별 남은 필요량(승인 발주안까지 반영한 전개의 캠페인 부족, 순번 순)
  function skuNeeds(m, sku, override = null) {
    const needs = new Map();
    for (const x of rawNeeds(m, sku, override)) if (x.need > C.EPS) needs.set(x.pid, { need: C.r2(x.need), week: x.week });
    return needs;
  }
  function skuDraftFor(m, skuId, plannedOrderDate, needs, manual = [], manualWeek = null) {
    const s = skuById.get(skuId);
    const unit = unitCost.get(skuId);
    const rankOf = (pid) => m.rank.get(pid) ?? Infinity;
    const byPlan = [...needs].sort((x, y) => rankOf(x[0]) - rankOf(y[0])).map(([plan_id, v]) => ({ plan_id, qty_ea: v.need, needed_by_week: v.week }));
    const needSum = byPlan.reduce((t, x) => t + x.qty_ea, 0);
    if (needSum <= C.EPS) return null;
    const orderQty = Math.max(Math.ceil(needSum - C.EPS), s.moq);
    const arrival = weekStart(addDays(plannedOrderDate, s.lead_time_weeks * 7));
    // 도착이 공백 전에 오는지: 조건 기안은 needed_by_week, 보충발주 대안으로 이은 기안은 그 SKU의 첫 부족 주와 비교한다
    const manualWeeks = manual.filter((pid) => !needs.has(pid)).map((pid) => manualWeek?.[pid] ?? latestJudgmentRow(judgmentIdOf(pid, skuId))?.first_shortage_week);
    const firstWeek = [...byPlan.map((x) => x.needed_by_week), ...manualWeeks].filter(Boolean).sort()[0] ?? null;
    const campaign = C.r2(needSum);
    return {
      sku_id: skuId, supplier_id: poBySku.get(skuId)?.supplier_id ?? 'Corevia', order_qty: orderQty, moq: s.moq,
      planned_order_date: plannedOrderDate, expected_arrival_week: arrival, unit_cost_krw: unit, amount_krw: orderQty * unit,
      linked_plan_ids: [...byPlan.map((x) => x.plan_id), ...manual.filter((pid) => !needs.has(pid))],
      // 문제 3이 읽는 이름. 기준 수요분은 0이다(범위 밖)
      order_qty_base_ea: 0, order_qty_campaign_ea: campaign,
      qty_basis: { campaign_need_ea: campaign, moq: s.moq, moq_roundup_ea: C.r2(orderQty - needSum) },
      qty_breakdown: {
        baseline_demand_ea: 0, campaign_added_ea: campaign, rounding_ea: C.r2(orderQty - needSum),
        campaign_share_pct: C.r2((needSum / orderQty) * 100), campaign_amount_krw: Math.round(needSum * unit), campaign_by_plan: byPlan,
      },
      order_deadline: null,
      arrives_before_gap: firstWeek ? arrival <= firstWeek : true, scenario_id: 'BASE',
    };
  }

  // ── SCM 기준 수요 보충 계획(S2-SCM-BR, 명세 0절 5) ──
  // SCM이 확인한 행만 입고에 넣는다(Corevia 확약이면 확약, 아니면 예상). 이 시스템은 기준 수요용 발주를 만들지 않고 금액·지급일도 없다.
  const brStatusLabel = (m, sku) => {
    const st = m.brStatus.get(sku);
    if (!st) return '미회신';
    if (st.scm_confirmed !== '확인') return 'SCM 미확인';
    return st.corevia_committed === '확약' ? 'SCM 확인·Corevia 확약' : 'SCM 확인·Corevia 미확약';
  };
  function baselinePlanRow(m, skuId) {
    const st = m.brStatus.get(skuId) ?? null;
    const rows = inboundOfSku(m, skuId).filter(C.isBaselinePlanRow);
    const out = (sc) => (m.ready ? C.stockoutInfo(baseProjection(m, skuId, sc).unmet).stockout_weeks : []);
    return {
      sku_id: skuId, plan_status: brStatusLabel(m, skuId), scm_confirmed: st?.scm_confirmed ?? '미회신', corevia_committed: st?.corevia_committed ?? null,
      basis_note: st?.basis_note ?? null, record_ids: st?.record_ids ?? [], replied_on: st?.replied_on ?? null,
      // 문제 3 현금 민감도(L6)용: SCM 확인 행의 수량·발주 예정일(모의 회신). 금액은 문제 3이 원본 단가(amount_krw ÷ order_qty)로 도출한다
      plan_rows: rows.map((r) => ({ record_id: r.record_id ?? null, source_ref: r.source_ref, qty: r.qty, planned_order_date: r.planned_order_date ?? null, eta_date: r.eta_date, supply_status: C.supplyStatusOf(r) })),
      plan_qty_total: rows.reduce((t, r) => t + r.qty, 0),
      // 추가분 없이 본 기준 수요 품절 주: 확약 입고만 / 예상 입고까지
      base_stockout_weeks_committed: out('not_arrived'), base_stockout_weeks_expected: out('on_schedule'),
      scope: 'SCM 정기 발주 소관. 이 시스템은 기준 수요용 발주를 만들지 않는다',
      cash_note: 'SCM 정기 발주의 금액·지급일은 회신 자료에 없어(지어내지 않음) 문제 3 현금 재전망에 들어가지 않는다(한계)',
      source_type: '모의회신', is_synthetic: true,
    };
  }
  const baselinePlanRows = ({ sku_id } = {}) => {
    const m = model();
    return skus.filter((s) => !sku_id || s.sku_id === sku_id).map((s) => baselinePlanRow(m, s.sku_id));
  };
  async function applyBaselinePlan({ date = null, record_ids = null } = {}) {
    const recs = brPlan.filter((r) => (record_ids ? record_ids.includes(r.record_id) : r.occurred_at === date) && !applied(r.record_id));
    if (!recs.length) return { skipped: true, reason: '반영할 SCM 보충 계획 회신이 없습니다' };
    const cur = currentInbound();
    const rows = [...cur.rows];
    const changed = [];
    const bySku = new Map();
    for (const r of recs) { if (!bySku.has(r.sku_id)) bySku.set(r.sku_id, []); bySku.get(r.sku_id).push(r); }
    for (const [sku, list] of bySku) {
      const first = list[0];
      db.prepare('INSERT OR REPLACE INTO p2_br_status VALUES (?, ?, ?)').run(sku, J({ scm_confirmed: first.scm_confirmed, corevia_committed: first.corevia_committed,
        basis_note: first.basis_note, record_ids: list.map((x) => x.record_id), replied_on: first.occurred_at }), null);
      if (first.scm_confirmed !== '확인') continue; // 미확인: 입고에 넣지 않는다(수량·날짜 없음)
      for (const r of list) {
        const committed = r.corevia_committed === '확약';
        const row = { inbound_row_id: `IB-${r.record_id}`, sku_id: sku, source_ref: `SCM-BR:${sku}:${r.plan_seq}`, qty: num(r.plan_qty), eta_date: r.eta_date,
          planned_order_date: r.planned_order_date, eta_status: committed ? '확정' : '미회신', supply_status: committed ? '확약' : '예상',
          source_type: '모의회신', is_synthetic: true, scenario_id: r.scenario_id || 'BASE', effective_at: ctx.clock.today(), record_id: r.record_id };
        const i = rows.findIndex((x) => x.inbound_row_id === row.inbound_row_id);
        if (i >= 0) rows[i] = row; else rows.push(row);
        changed.push({ inbound_row_id: row.inbound_row_id, source_ref: row.source_ref, eta_date: row.eta_date, eta_status: row.eta_status, supply_status: row.supply_status, qty: row.qty });
      }
    }
    touch();
    const req = db.prepare("SELECT event_id FROM p2_request WHERE request_topic = 'baseline_replenishment' AND event_id IS NOT NULL ORDER BY rowid DESC LIMIT 1").get();
    const saved = saveInboundVersion(rows, `SCM 기준 수요 보충 계획 회신 ${recs.length}행`);
    const ev = await emit({
      event_type: 'INBOUND_SCHEDULE_REVISED', source_type: '모의회신', is_synthetic: true, actor_dept: 'SCM', subject_type: 'inbound_schedule', subject_id: saved.version,
      caused_by: req?.event_id ?? null, source_ref: recs.map((r) => r.record_id), generation_reason: 'SCM 기준 수요 보충 계획 회신(S2-SCM-BR)',
      payload: { inbound_schedule_version: saved.version, changed_rows: changed,
        baseline_replenishment: [...bySku].map(([sku, list]) => ({ sku_id: sku, scm_confirmed: list[0].scm_confirmed, corevia_committed: list[0].corevia_committed, rows: list.length })) },
    });
    db.prepare('UPDATE p2_inbound_version SET event_id = ? WHERE inbound_schedule_version = ?').run(ev.event_id, saved.version);
    db.prepare('UPDATE p2_br_status SET event_id = ? WHERE event_id IS NULL').run(ev.event_id);
    markApplied(recs.map((r) => r.record_id), ev.event_id, { event_id: ev.event_id, inbound_schedule_version: saved.version });
    return { event_id: ev.event_id, inbound_schedule_version: saved.version, changed_rows: changed };
  }

  // ── Corevia 공급 회신 supply_commitment(S2-CVC, 명세 0절 3) ──
  // 회신 값을 받아 검증하고 입고 일정에 잇는다. 원료·생산 일정을 이 시스템이 계산하지 않는다.
  const commitmentsOf = (targetId) => db.prepare('SELECT row_json FROM p2_commitment WHERE target_id = ? ORDER BY reply_version, rowid').all(targetId).map((r) => P(r.row_json));
  const latestCommitment = (targetId) => commitmentsOf(targetId).at(-1) ?? null;
  const nn = (v) => (v == null || v === '' || v === 'NONE' ? null : v);
  function validateCommitment(c) {
    const issues = [];
    if (['가능', '부분 가능'].includes(c.reply_status)) {
      for (const [k, label] of [['offered_qty', '공급 가능 수량'], ['offered_eta_date', 'Masil 도착 예정일'], ['material_status', '원료 확보 여부'], ['production_status', '생산 배정 여부']]) {
        if (c[k] == null) issues.push(`${label} 없음`);
      }
      if (['미확인'].includes(c.material_status)) issues.push('공급 가능이라면서 원료 확보가 미확인');
      if (['미확인', '미배정'].includes(c.production_status)) issues.push(`공급 가능이라면서 생산 배정이 ${c.production_status}`);
    }
    if (c.reply_status === '가능' && c.offered_qty != null && c.offered_qty < c.requested_qty) issues.push(`가능인데 공급 수량 ${c.offered_qty}이 요청 ${c.requested_qty}보다 적음(부분 가능이어야 함)`);
    if (c.reply_status === '부분 가능' && c.offered_qty != null && (c.offered_qty <= 0 || c.offered_qty >= c.requested_qty)) issues.push(`부분 가능인데 공급 수량 ${c.offered_qty}이 0이거나 요청 이상`);
    if (c.reply_status === '불가' && (c.offered_qty ?? 0) > 0) issues.push(`불가인데 공급 수량 ${c.offered_qty}`);
    if (c.production_complete_date && c.offered_eta_date && c.production_complete_date > c.offered_eta_date) issues.push(`생산 완료 예정일 ${c.production_complete_date}이 도착 예정일 ${c.offered_eta_date}보다 늦음`);
    if (c.material_available_date && c.production_complete_date && c.material_available_date > c.production_complete_date) issues.push(`원료 가용일 ${c.material_available_date}이 생산 완료 예정일 ${c.production_complete_date}보다 늦음`);
    return issues;
  }
  // 대상 입고 행(기준 = 첫 회신 전 모습)에 회신을 반영한 행들. 원래 발주 수량은 덮어쓰지 않는다.
  function commitmentRows(baseIn, c) {
    const { expected_now_week, original_eta_date, ...base } = baseIn; // 예정일 경과 표시는 회신으로 다시 정한다
    void expected_now_week; void original_eta_date;
    const meta = { supply_commitment_id: c.supply_commitment_id, record_id: c.record_id, source_type: '모의회신', is_synthetic: true, effective_at: ctx.clock.today() };
    if (c.validation_status !== '정상' || c.reply_status === '미확인') return [{ ...base, supply_status: '예상', eta_status: '미회신', ...meta }];
    if (c.reply_status === '불가') return [{ ...base, supply_status: '공급 불가', eta_status: '미회신', ...meta }];
    const committed = { ...base, qty: c.committed_qty, eta_date: c.offered_eta_date, supply_status: '확약', eta_status: c.offered_eta_date > base.eta_date ? '지연' : '확정', ...meta };
    if (c.reply_status === '가능') return [committed];
    return [committed, { ...base, inbound_row_id: `${base.inbound_row_id}-R`, qty: c.uncommitted_qty, supply_status: '미확약 잔량', eta_status: '미회신', ...meta }];
  }
  // 회신 하나를 받는다: 검증·저장·SUPPLIER_REPLIED·보충 막기까지. 입고 일정 반영은 applyCommitments가 같은 날 회신을 묶어 한 번에 한다.
  async function receiveCommitment({ record_id, po_draft_id = null }) {
    const rec = cvcRecords.find((r) => r.record_id === record_id);
    if (!rec) throw ctx.httpError(404, `Corevia 공급 회신 자료가 없습니다: ${record_id}`);
    const targetId = rec.target_type === 'po' ? rec.target_ref : po_draft_id;
    if (!targetId) throw ctx.httpError(400, `발주안 대상 회신에는 po_draft_id가 필요합니다: ${record_id}`);
    const key = `${record_id}|${targetId}`;
    if (applied(key)) return { result: { ...applied(key), already_applied: true } }; // 같은 회신 재처리는 아무것도 바꾸지 않는다(검증 f)
    const prior = commitmentsOf(targetId);
    if (prior.some((x) => x.reply_version > num(rec.reply_version))) return { result: { skipped: true, reason: `더 새 버전 회신이 이미 있습니다(${targetId})` } };
    const cur = currentInbound();
    const rowId = `IB-${targetId}`;
    const base = prior[0]?.base_row ?? cur.rows.find((r) => r.inbound_row_id === rowId);
    if (!base) return { result: { skipped: true, reason: `입고 행이 아직 없습니다(${rowId}). 승인된 발주안만 회신 대상입니다` } };
    const draft = rec.target_type === 'po_draft' ? latestDrafts().find((x) => x.po_draft_id === targetId) : null;
    const ratio = nn(rec.offered_qty_ratio);
    const shift = nn(rec.eta_shift_weeks);
    const offeredQty = ratio == null ? null : Math.round(num(ratio) * base.qty);
    const offeredEta = nn(rec.offered_eta_date) ?? (shift == null ? null : addDays(base.eta_date, num(shift) * 7));
    const prodDone = nn(rec.production_complete_shift_days) != null && offeredEta ? addDays(offeredEta, num(rec.production_complete_shift_days)) : null;
    const matDate = nn(rec.material_available_date) ?? (nn(rec.material_shift_days) != null && prodDone ? addDays(prodDone, num(rec.material_shift_days)) : null);
    const needed = draft?.qty_breakdown?.campaign_by_plan?.map((x) => x.needed_by_week).filter(Boolean).sort()[0] ?? null;
    const c = {
      supply_commitment_id: `SC-${targetId}-v${rec.reply_version}`, record_id, reply_version: num(rec.reply_version), supersedes_record_id: nn(rec.supersedes_record_id),
      target_type: rec.target_type === 'po' ? '기발주' : '발주안', target_id: targetId, sku_id: base.sku_id, linked_plan_ids: draft?.linked_plan_ids ?? [],
      requested_qty: base.qty, needed_by_week: needed, expected_eta_date: base.eta_date,
      reply_status: rec.reply_status, offered_qty: offeredQty, offered_eta_date: offeredEta,
      committed_qty: ['가능', '부분 가능'].includes(rec.reply_status) ? offeredQty : 0,
      uncommitted_qty: ['가능', '부분 가능'].includes(rec.reply_status) && offeredQty != null ? Math.max(0, base.qty - offeredQty) : base.qty,
      delay_weeks: offeredEta && offeredEta > base.eta_date ? Math.round((new Date(offeredEta) - new Date(base.eta_date)) / 864e5 / 7 * 10) / 10 : (offeredEta ? 0 : null), arrives_by_needed_week: needed && offeredEta ? weekStart(offeredEta) <= needed : null,
      material_id: nn(rec.material_id), material_status: nn(rec.material_status), material_available_date: matDate, material_evidence: nn(rec.material_evidence),
      production_line: nn(rec.production_line), production_status: nn(rec.production_status), production_complete_date: prodDone,
      remaining_conditions: nn(rec.remaining_conditions), eta_basis: nn(rec.eta_basis), replied_by: rec.replied_by, reply_as_of: ctx.clock.today(),
      evidence_refs: String(rec.source_ref ?? '').split(';').filter(Boolean), source_type: '모의회신', is_synthetic: true, scenario_id: rec.scenario_id || 'BASE',
    };
    const issues = validateCommitment(c);
    c.validation_status = issues.length ? '확인 필요' : '정상';
    c.validation_issues = issues;
    c.base_row = prior[0]?.base_row ?? { ...base };
    const ev = await emit({
      event_type: 'SUPPLIER_REPLIED', source_type: '모의회신', is_synthetic: true, plan_id: c.linked_plan_ids[0] ?? 'NONE', actor_dept: 'COREVIA', actor_role: c.replied_by,
      subject_type: 'supply_commitment', subject_id: c.supply_commitment_id, scenario_id: c.scenario_id, source_ref: [record_id],
      // 정정 회신이면 앞 회신의 확인 요청(INFO_REQUESTED)을, 아니면 발주안 승인 회신을 원인으로 둔다(문제 4가 caused_by로 요청을 닫는다)
      caused_by: (c.supersedes_record_id && ctx.events.query({ event_type: 'INFO_REQUESTED', limit: 1e6 })
        .filter((e) => [e.subject_id, e.payload?.subject_id].includes(prior.find((x) => x.record_id === c.supersedes_record_id)?.supply_commitment_id)).at(-1)?.event_id)
        || (draft?._state?.approval_event_id ?? null), generation_reason: rec.generation_reason,
      payload: { supply_commitment: (({ base_row, ...x }) => x)(c) },
    });
    db.prepare('INSERT INTO p2_commitment VALUES (?, ?, ?, ?, ?)').run(targetId, record_id, c.reply_version, J(c), ev.event_id);
    if (draft) { const d = latestDrafts().find((x) => x.po_draft_id === targetId); d._state = { ...d._state, commitment: { record_id, reply_status: c.reply_status, validation_status: c.validation_status } }; saveDraftState(d); }
    touch();
    let result = { event_id: ev.event_id, supply_commitment: (({ base_row, ...x }) => x)(c) };
    if (c.validation_status === '확인 필요') {
      // 모순 회신은 입고를 바꾸지 않고 Corevia에 확인을 요청한다
      const r = await requestInfo({ request_topic: 'supply_request', requested_to: 'COREVIA', plan_id: c.linked_plan_ids[0] ?? 'NONE', subject_type: 'supply_commitment',
        subject_id: c.supply_commitment_id, request_kind: 'correction', questions: issues.map((x) => `${c.target_id} ${c.sku_id}: ${x}`) }, ev.event_id);
      result = { ...result, info_request_id: r?.request_id ?? null };
      return { result, key, ev };
    }
    // 불가·부분 가능: 그 발주안에 기대던 기안·SKU의 보충 발주를 막는다(남은 부족은 대안으로)
    if (draft && ['불가', '부분 가능'].includes(c.reply_status)) {
      const ins = db.prepare('INSERT OR IGNORE INTO p2_reorder_block VALUES (?, ?, ?, ?)');
      for (const pid of c.linked_plan_ids) ins.run(pid, c.sku_id, targetId, ev.event_id);
    }
    return { result, key, ev, change: { rowId, newRows: commitmentRows(c.base_row, c), c } };
  }
  // 회신 묶음 반영: 같은 날 도착한 회신은 입고 일정 새 버전 하나와 INBOUND_SCHEDULE_REVISED 하나로 묶는다(재판정 한 번)
  async function applyCommitments(items) {
    const done = [];
    for (const it of items) done.push(await receiveCommitment(it));
    const changes = done.filter((d) => d.change).map((d) => ({ ...d.change, ev: d.ev, done: d }));
    if (changes.length) {
      let rows = currentInbound().rows;
      for (const ch of changes) rows = rows.filter((r) => r.inbound_row_id !== ch.rowId && r.inbound_row_id !== `${ch.rowId}-R`).concat(ch.newRows);
      const ids = changes.map((ch) => ch.c.supply_commitment_id);
      const saved = saveInboundVersion(rows, `Corevia 공급 회신 ${ids.join(', ')}`);
      const changed = rows.filter((r) => changes.some((ch) => r.inbound_row_id.startsWith(ch.rowId)))
        .map((r) => ({ inbound_row_id: r.inbound_row_id, source_ref: r.source_ref, qty: r.qty, eta_date: r.eta_date, eta_status: r.eta_status, supply_status: r.supply_status }));
      const plans = [...new Set(changes.flatMap((ch) => ch.c.linked_plan_ids))];
      const iev = await emit({
        event_type: 'INBOUND_SCHEDULE_REVISED', source_type: '모의회신', is_synthetic: true, plan_id: plans[0] ?? 'NONE', actor_dept: 'COREVIA',
        subject_type: 'inbound_schedule', subject_id: saved.version, caused_by: changes[0].ev.event_id, source_ref: changes.map((ch) => ch.c.record_id),
        generation_reason: `Corevia 공급 회신 반영: ${changes.map((ch) => `${ch.c.target_id} ${ch.c.reply_status}`).join(', ')}`,
        payload: { inbound_schedule_version: saved.version, changed_rows: changed, supply_commitment_id: ids[0], supply_commitment_ids: ids,
          supplier_replied_event_ids: changes.map((ch) => ch.ev.event_id) },
      });
      db.prepare('UPDATE p2_inbound_version SET event_id = ? WHERE inbound_schedule_version = ?').run(iev.event_id, saved.version);
      for (const ch of changes) Object.assign(ch.done.result, { inbound_schedule_version: saved.version, inbound_event_id: iev.event_id });
    }
    for (const d of done.filter((x) => x.key && x.ev)) markApplied([d.key], d.ev.event_id, d.result);
    return done.map((d) => d.result);
  }
  const applySupplyCommitment = async (args) => (await applyCommitments([args]))[0];
  // ── 입고 실적과 예정일 경과(L7) ──
  // 확약 입고의 도착일이 지나면 입고 실적(모의 입력, 기본 = 확약 수량 그대로)으로 '입고 완료'가 된다.
  // 확약 안 된 예상 입고는 도착 예정일이 지나도 입고 완료가 되지 않고 '예정일 경과·미확약'이 되어, 오는 경우에도 다음 주에 온다고 본다.
  // 같은 날 다시 돌려도 바뀌는 것이 없다.
  async function processArrivals(date = ctx.clock.today()) {
    const cur = currentInbound();
    const nextWeek = weekStart(addDays(date, 7));
    const receipts = [];
    const overdue = [];
    const rows = cur.rows.map((r) => {
      const st = C.supplyStatusOf(r);
      if (st === '확약' && r.eta_date <= date) {
        receipts.push(r);
        return { ...r, supply_status: '입고 완료', received_qty: r.qty, received_on: date, receipt_source: '모의 입력(확약 수량 그대로)', receipt_is_synthetic: true };
      }
      if (C.isExpectedStatus(st) && (r.original_eta_date ?? r.eta_date) < date && r.expected_now_week !== nextWeek) {
        overdue.push(r);
        return { ...r, supply_status: '예정일 경과·미확약', original_eta_date: r.original_eta_date ?? r.eta_date, expected_now_week: nextWeek };
      }
      return r;
    });
    if (!receipts.length && !overdue.length) return null;
    const saved = saveInboundVersion(rows, `입고 실적 ${receipts.length}행(모의), 도착 예정일 경과·미확약 ${overdue.length}행`);
    const ev = await emit({
      event_type: 'INBOUND_SCHEDULE_REVISED', source_type: receipts.length ? '사람입력' : '계산', is_synthetic: receipts.length > 0, actor_dept: 'SCM',
      actor_role: receipts.length ? '물류 입고 담당(모의 입력)' : null, subject_type: 'inbound_schedule', subject_id: saved.version,
      generation_reason: `입고 실적(모의 입력, 확약 수량 그대로) ${receipts.length}행 · 도착 예정일 경과·미확약 ${overdue.length}행`,
      payload: { inbound_schedule_version: saved.version,
        receipts: receipts.map((r) => ({ inbound_row_id: r.inbound_row_id, source_ref: r.source_ref, sku_id: r.sku_id, received_qty: r.qty, received_on: date })),
        overdue_expected: overdue.map((r) => ({ inbound_row_id: r.inbound_row_id, source_ref: r.source_ref, sku_id: r.sku_id, original_eta_date: r.original_eta_date ?? r.eta_date, expected_now_week: nextWeek })),
        changed_rows: [...receipts.map((r) => ({ inbound_row_id: r.inbound_row_id, source_ref: r.source_ref, qty: r.qty, eta_date: r.eta_date, supply_status: '입고 완료' })),
          ...overdue.map((r) => ({ inbound_row_id: r.inbound_row_id, source_ref: r.source_ref, qty: r.qty, eta_date: r.original_eta_date ?? r.eta_date, expected_now_week: nextWeek, supply_status: '예정일 경과·미확약' }))] },
    });
    db.prepare('UPDATE p2_inbound_version SET event_id = ? WHERE inbound_schedule_version = ?').run(ev.event_id, saved.version);
    return { event_id: ev.event_id, inbound_schedule_version: saved.version, receipts: receipts.length, overdue: overdue.length };
  }
  // 그 날짜까지 도착한 Corevia 회신을 넣는다(기발주는 occurred_at, 발주안은 승인일 + n영업일). 같은 회신 재처리 무해
  async function applySupplyReplies({ date = ctx.clock.today() } = {}) {
    const due = dueCommitments(date).filter((y) => !y.applied && y.due_date <= date);
    const out = [];
    for (const d of [...new Set(due.map((x) => x.due_date))]) {
      out.push(...await applyCommitments(due.filter((x) => x.due_date === d).map((x) => ({ record_id: x.record_id, po_draft_id: x.po_draft_id }))));
    }
    return out;
  }
  // 승인된 발주안마다 이번에 받을 Corevia 회신(자료 행, 도착 예정일). 같은 SKU의 n번째 승인 발주안에 target_seq=n 행, 없으면 '*' 행.
  function dueCommitments(today = ctx.clock.today()) {
    const out = [];
    const approvedDrafts = latestDrafts().filter((d) => isApproved(d) && !['취소', '반려'].includes(d.po_draft_status) && d._state?.approval_event_id)
      .map((d) => ({ d, on: ctx.events.get(d._state.approval_event_id)?.occurred_at ?? today }))
      .sort((a, b) => a.on.localeCompare(b.on) || a.d.po_draft_id.localeCompare(b.d.po_draft_id));
    const seqOf = new Map();
    for (const { d, on } of approvedDrafts) {
      const seq = (seqOf.get(d.sku_id) ?? 0) + 1;
      seqOf.set(d.sku_id, seq);
      const forSku = cvcRecords.filter((r) => r.target_type === 'po_draft' && r.sku_id === d.sku_id);
      const specific = forSku.filter((r) => String(r.target_seq) === String(seq));
      for (const r of (specific.length ? specific : forSku.filter((x) => x.target_seq === '*')).sort((a, b) => num(a.reply_version) - num(b.reply_version))) {
        out.push({ record_id: r.record_id, po_draft_id: d.po_draft_id, due_date: addBusinessDays(on, num(r.delay_bd_after_approval)), applied: Boolean(applied(`${r.record_id}|${d.po_draft_id}`)) });
      }
    }
    for (const r of cvcRecords.filter((x) => x.target_type === 'po')) out.push({ record_id: r.record_id, po_draft_id: null, due_date: r.occurred_at, applied: Boolean(applied(`${r.record_id}|${r.target_ref}`)) });
    const ver = (id) => num(cvcRecords.find((r) => r.record_id === id)?.reply_version ?? 1);
    return out.filter((x) => x.due_date).sort((a, b) => a.due_date.localeCompare(b.due_date) || ver(a.record_id) - ver(b.record_id));
  }

  async function cancelDraft(d, causedBy, reason, extra = {}) {
    const before = [...d.linked_plan_ids];
    d.po_draft_status = '취소';
    saveDraftState(d);
    await emit({ event_type: 'PO_DRAFT_CANCELLED', source_type: '계산', plan_id: before[0] ?? extra.withdrawal?.plan_id ?? 'NONE', actor_dept: 'SCM', subject_type: 'po_draft',
      subject_id: d.po_draft_id, caused_by: causedBy,
      payload: { po_draft_id: d.po_draft_id, draft_version: d.draft_version, cancel_reason: reason, linked_plan_ids: [], linked_plan_ids_before: before, ...extra } });
  }
  // 연결 기안만 바뀌고 수량·판(draft_version)이 그대로일 때: 같은 판으로 PO_DRAFT_CREATED를 다시 내 바뀐 linked_plan_ids를 알린다(2026-11-15 결함 (3)).
  // payload.change_kind='linked_plans_changed'. 문제 3은 이 사건으로 연결 기안만 갱신하고 승인 상태는 되돌리지 않는다.
  async function emitRelink(d, before, causedBy, extra = {}) {
    const { _state, ...row } = d;
    void _state;
    await emit({ event_type: 'PO_DRAFT_CREATED', source_type: '계산', plan_id: row.linked_plan_ids[0] ?? extra.withdrawal?.plan_id ?? 'NONE', actor_dept: 'SCM', is_simulation: true,
      subject_type: 'po_draft', subject_id: row.po_draft_id, caused_by: causedBy,
      generation_reason: `발주안 연결 기안 변경(${before.join(', ') || '-'} → ${row.linked_plan_ids.join(', ') || '-'})${extra.withdrawal ? `: ${extra.withdrawal.disposition}` : ''}`,
      payload: { ...row, change_kind: 'linked_plans_changed', linked_plan_ids_before: before, ...extra } });
  }
  // SKU의 열린 발주안을 지금 필요량에 맞춘다: 없으면 만들고, 수량이 바뀌면 새 버전, 연결만 바뀌면 그 버전을 고치고, 필요가 없어지면 취소한다.
  async function syncSkuDraft(m, sku, causedBy, override = null, { cancelReason = '보충 발주 필요 조건 해소', extra = {} } = {}) {
    const needs = skuNeeds(m, sku, override);
    const open = openDraftOf(sku);
    const manual = (open?._state.manual_links ?? []).filter((pid) => m.rank.has(pid) && !blockOf(m, pid, sku));
    if (override?.manual && m.rank.has(override.planId) && !manual.includes(override.planId)) manual.push(override.planId);
    if (!needs.size && !manual.length) {
      if (open) await cancelDraft(open, causedBy, cancelReason, extra);
      return null;
    }
    const pv = skuDraftFor(m, sku, open?.planned_order_date ?? addBusinessDays(m.today, C.PLANNED_ORDER_LAG_BD), needs, manual);
    if (!pv?.order_qty) {
      if (open) await cancelDraft(open, causedBy, cancelReason, extra);
      return null;
    }
    const firstNeed = [...needs.values()].map((v) => v.week).filter(Boolean).sort()[0];
    const skuInfo = skuById.get(sku);
    pv.order_deadline = firstNeed ? addDays(firstNeed, 4 - skuInfo.lead_time_weeks * 7) : null;
    if (!open) return createDraft(pv, { causedBy, effectiveAt: m.today, origin: 'condition', manual });
    if (pv.order_qty !== open.order_qty) return reviseDraft(open, pv, causedBy, manual, extra);
    if (J([pv.linked_plan_ids, pv.qty_breakdown, pv.order_deadline]) !== J([open.linked_plan_ids, open.qty_breakdown, open.order_deadline ?? null])) {
      // 수량이 같으면 버전을 올리지 않는다(문제 3 약정의 상신 상태를 되돌리지 않기 위해). 연결 기안·내역만 고친다.
      const before = [...open.linked_plan_ids];
      Object.assign(open, { linked_plan_ids: pv.linked_plan_ids, qty_breakdown: pv.qty_breakdown, order_deadline: pv.order_deadline,
        arrives_before_gap: pv.arrives_before_gap, qty_basis: pv.qty_basis, order_qty_base_ea: pv.order_qty_base_ea, order_qty_campaign_ea: pv.order_qty_campaign_ea });
      open._state = { ...open._state, manual_links: manual };
      saveDraftState(open);
      if (J(before) !== J(open.linked_plan_ids)) await emitRelink(open, before, causedBy, extra);
    }
    return open;
  }
  // 승인 전 발주안의 수량 갱신: 새 버전을 만들고 PO_DRAFT_CREATED(새 버전)를 낸다. 발주 예정일은 처음 그대로 둔다.
  async function reviseDraft(open, pv, causedBy, manual, extra = {}) {
    const { _state, ...prevRow } = open;
    const row = { ...prevRow, ...pv, po_draft_id: open.po_draft_id, draft_version: open.draft_version + 1, po_draft_status: open.po_draft_status };
    db.prepare('INSERT INTO p2_po_draft VALUES (?, ?, ?, ?)').run(row.po_draft_id, row.draft_version, J(row), J({ ..._state, manual_links: manual }));
    touch();
    const ev = await emit({
      event_type: 'PO_DRAFT_CREATED', source_type: '계산', plan_id: row.linked_plan_ids[0] ?? 'NONE', actor_dept: 'SCM', is_simulation: true,
      subject_type: 'po_draft', subject_id: row.po_draft_id, caused_by: causedBy, payload: { ...row, linked_plan_ids_before: open.linked_plan_ids, ...extra },
      generation_reason: `${extra.withdrawal ? `연결 기안 ${extra.withdrawal.plan_id} 철회로 ` : '등록 수요·입고 변경으로 '}발주안 수량 갱신(v${open.draft_version} ${open.order_qty} → v${row.draft_version} ${row.order_qty} EA)`,
    });
    db.prepare("UPDATE p2_po_draft SET state_json = json_set(state_json, '$.revised_event_id', ?) WHERE po_draft_id = ? AND draft_version = ?").run(ev.event_id, row.po_draft_id, row.draft_version);
    touch();
    return row;
  }
  // 이 기안의 SKU 판정 결과로 SKU 발주안을 맞추고 조건에 발주안을 붙인다
  async function attachConditionDrafts(m, planId, res, causedBy) {
    for (const row of res.skus) {
      const c = (row.condition_basis ?? []).find((x) => x.condition_type === 'reorder_required');
      if (!c) continue;
      const d = await syncSkuDraft(m, row.sku_id, causedBy, { planId, need: c.additional_reorder_qty_ea, week: c.needed_by_week });
      if (!d) continue;
      c.po_draft_id = d.po_draft_id;
      c.po_draft_status = d.po_draft_status;
      c.po_draft_preview = { order_qty: d.order_qty, draft_version: d.draft_version, planned_order_date: d.planned_order_date,
        expected_arrival_week: d.expected_arrival_week, amount_krw: d.amount_krw, arrives_before_gap: d.arrives_before_gap };
    }
  }
  // 보충 조건이 사라진 SKU: 열린 발주안에서 이 기안을 빼고, 남은 필요가 없으면 취소한다. 승인된 발주안은 건드리지 않는다.
  async function releaseDrafts(planId, res, causedBy) {
    for (const row of res.skus) {
      if ((row.condition_basis ?? []).some((c) => c.condition_type === 'reorder_required')) continue;
      const open = openDraftOf(row.sku_id);
      if (open?.linked_plan_ids.includes(planId)) await syncSkuDraft(model(), row.sku_id, causedBy);
    }
  }
  // 전제 변경 뒤 모든 열린 발주안을 등록 수요에 맞춘다(판정이 바뀌지 않은 기안의 수요 변경도 수량에 반영)
  async function syncOpenDrafts(causedBy) {
    for (const sku of [...new Set(latestDrafts().filter(isOpenDraft).map((d) => d.sku_id))]) await syncSkuDraft(model(), sku, causedBy);
  }

  // mode: 'premise'(전제 변경 사건) | 'date'(날짜 경과). force: 재검토(rejudge=true)는 결론이 같아도 낸다.
  async function judge(planId, { causedBy = null, force = false, mode = 'premise' } = {}) {
    if (CLOSED.has(planStatusOf(planId) ?? '')) return null; // 종결된 기안은 판정을 동결한다
    const m = model();
    const res = computeJudgment(m, planId);
    const prev = latestJudgmentRow(judgmentIdOf(planId));
    const keys = storedKeys(planId);
    const prem = premiseKey(m, planId);
    const check = (changed, v) => { if (causedBy) db.prepare('INSERT OR REPLACE INTO p2_judge_check VALUES (?, ?, ?, ?)').run(causedBy, planId, changed ? 1 : 0, v); };
    if (prev && keys && !force) {
      const prevRows = [prev, ...res.skus.map((x) => latestJudgmentRow(x.supply_judgment_id)).filter(Boolean)];
      const same = conclusionKey([res.plan, ...res.skus], false) === conclusionKey(prevRows, false);
      if ((mode === 'date' && same) || (mode === 'premise' && same && keys.premise_key === prem)) {
        check(false, prev.supply_judgment_version); // 이 트리거로 확인했지만 전제·결론이 그대로라 새 버전을 내지 않음
        return null;
      }
      // 같은 날 묶기(조정자 F): 오늘 이미 이 기안의 판정 버전을 냈고 결론과 SKU별 보충 필요량이 같으면, 전제만 바뀐 것은 그날 버전에 흡수한다.
      // 전제 키는 지금 것으로 갱신해 다음 트리거가 같은 변경으로 버전을 내지 않게 한다.
      const prevEv = db.prepare('SELECT event_id FROM p2_judgment WHERE supply_judgment_id = ? AND supply_judgment_version = ?').get(prev.supply_judgment_id, prev.supply_judgment_version)?.event_id;
      const sameNeeds = J(res.skus.map((x) => x.reorder_need?.additional_reorder_qty_ea ?? null))
        === J(res.skus.map((x) => latestJudgmentRow(x.supply_judgment_id)?.reorder_need?.additional_reorder_qty_ea ?? null));
      // 공급 회신(Corevia·SCM)이 바꾼 입고는 묶지 않는다: 공급 조건 변경은 재판정·대안 갱신·재검토까지 남아야 한다(v2.1)
      const trig = causedBy ? ctx.events.get(causedBy) : null;
      // 수요 입력이 없는 기안(판정불가)은 공급 회신이 와도 결론이 없으므로 묶는다
      const fromSupplyReply = res.plan.supply_verdict !== '판정불가' && trig?.event_type === 'INBOUND_SCHEDULE_REVISED'
        && (Boolean(trig.payload?.baseline_replenishment) || ctx.events.get(trig.caused_by ?? '')?.event_type === 'SUPPLIER_REPLIED');
      if (mode === 'premise' && same && sameNeeds && !fromSupplyReply && prevEv && ctx.events.get(prevEv)?.occurred_at === m.today) {
        db.prepare('UPDATE p2_judgment_key SET premise_key = ? WHERE plan_id = ?').run(prem, planId);
        check(false, prev.supply_judgment_version);
        return null;
      }
    }
    await attachConditionDrafts(m, planId, res, causedBy);
    // 모든 판정 버전은 원인 사건(caused_by)과 사유(generation_reason)를 가진다
    let cause = causedBy;
    const prevEventId = prev ? db.prepare('SELECT event_id FROM p2_judgment WHERE supply_judgment_id = ? AND supply_judgment_version = ?')
      .get(prev.supply_judgment_id, prev.supply_judgment_version)?.event_id ?? null : null;
    let reason = changeReason(m, prev, res, causedBy ? ctx.events.get(causedBy)?.event_type : null, force);
    if (mode === 'date' && !force) {
      // 날짜가 지나 막을 수 없는 구간이 밀려 결론이 바뀌었다. 발주 시한이 지난 조건 발주안이 있으면 그 생성 사건을,
      // 없으면 바뀌기 전 판정 사건을 원인으로 남긴다(그 판정의 조건·필요량이 날짜 경과로 더는 지켜지지 않음).
      const late = (prev?.condition_basis ?? []).find((c) => c.po_draft_id && c.order_deadline && c.order_deadline < m.today);
      cause = (late && latestDrafts().find((x) => x.po_draft_id === late.po_draft_id)?._state.created_event_id) || prevEventId;
      reason = `발주 시한 경과(${m.today}): 막을 수 없는 구간이 밀려 결론이 바뀜. ${reason}`;
    } else if (!cause) {
      cause = prevEventId; // 수동 재판정 등 원인 사건이 없는 호출: 앞 판정을 원인으로 둔다
      reason = prev ? `수동 재판정. ${reason}` : `시작일 초기 판정. ${reason}`;
    }
    const version = (prev?.supply_judgment_version ?? 0) + 1;
    const due = p4()?.getDeadlineSchedule ? safe(() => p4().getDeadlineSchedule({ plan_id: planId })?.judgment_due ?? null) : null;
    const rows = [res.plan, ...res.skus].map((r) => ({ ...r, supply_judgment_version: version, judgment_due: due }));
    const premiseList = Object.entries(res.plan.premise_refs).filter(([, v]) => v != null).map(([k, v]) => `${k}:${v}`);
    const ev = await emitWithRows({
      event_type: 'SUPPLY_JUDGED', source_type: '계산', plan_id: planId, actor_dept: 'SCM',
      subject_type: 'supply_judgment', subject_id: res.plan.supply_judgment_id, is_simulation: res.plan.is_simulation,
      premise_refs: premiseList, caused_by: cause, generation_reason: reason,
      payload: {
        supply_judgment_id: res.plan.supply_judgment_id, supply_judgment_version: version, plan_id: planId,
        supply_verdict: res.plan.supply_verdict, first_shortage_week: res.plan.first_shortage_week,
        condition_basis: res.plan.condition_basis, // 사건 기록만으로 조건을 추적한다(조정자 D2 (다))
        premise_refs: res.plan.premise_refs, previous_supply_judgment_version: prev?.supply_judgment_version ?? null,
      },
    }, rows);
    db.prepare('INSERT OR REPLACE INTO p2_judgment_key VALUES (?, ?, ?)').run(planId, prem, conclusionKey(rows));
    check(true, version);
    await releaseDrafts(planId, res, ev.event_id);
    return ev;
  }
  // 판정 변화의 사유: 무엇이 어떻게 바뀌었는지(판정값, SKU별 판정·조건, 막을 수 없는 구간에 새로 들어온 부족 주)
  function changeReason(m, prev, res, causeType, force) {
    const head = force ? '재검토 요청(다시 판정)' : (causeType ? `${EVENT_NAME[causeType] ?? causeType} 반영` : '전제 변경');
    if (!prev) return `${head}: 첫 판정 ${res.plan.supply_verdict}`;
    const parts = [];
    if (prev.supply_verdict !== res.plan.supply_verdict) parts.push(`판정 ${prev.supply_verdict} → ${res.plan.supply_verdict}`);
    for (const r of res.skus) {
      const old = latestJudgmentRow(r.supply_judgment_id);
      const kinds = (x) => (x?.condition_basis ?? []).map((c) => (c.condition_type === 'reorder_required' ? '보충 발주 필요' : '미확정 입고')).join('+') || '없음';
      if (old?.supply_verdict !== r.supply_verdict || kinds(old) !== kinds(r)) {
        const R = reachOf(m, r.sku_id, res.plan.plan_id);
        const newly = (r.shortage_weeks ?? []).filter((w) => !(old?.shortage_weeks ?? []).includes(w));
        parts.push(`${r.sku_id} ${old?.supply_verdict ?? '-'}(조건 ${kinds(old)}) → ${r.supply_verdict}(조건 ${kinds(r)})`
          + (r.supply_verdict === '부족' && newly.length ? `, ${newly.join('·')} 주 캠페인 부족이 막을 수 없는 구간(보충 가능 ${R < C.N ? C.WEEKS[R] : '전개 끝 뒤'}~ 이전)에 있음` : '')
          + (r.reorder_blocked ? `, 발주안 ${r.reorder_blocked.po_draft_id} 거절로 보충 막힘` : ''));
      }
    }
    return `${head}: ${parts.length ? parts.join('; ') : '결론 같음, 전제만 바뀜'}`;
  }
  async function judgeChanged(causedBy = null, planIds = null, mode = 'premise') {
    for (const pid of planIds ?? ctx.plans().map((p) => p.plan_id)) await judge(pid, { causedBy, mode });
  }
  const hasRejection = (planId) => Boolean(db.prepare('SELECT 1 FROM p2_rejection WHERE plan_id = ?').get(planId));

  // ── 대안 (명세 4.5) ──
  function evalPlan(m, planId, addedBySku, scenario = 'not_arrived', saleEndIdx = null) {
    // 이 기안의 추가분을 addedBySku로 바꿨을 때, 막을 수 없는 구간에서 늘어나는 부족(SKU별 합).
    // 미리보기가 없으면(null) 불가로 본다.
    const out = {};
    if (!addedBySku) { for (const s of m.planSku.get(planId) ?? []) out[s] = Infinity; return out; }
    for (const s of m.planSku.get(planId) ?? []) {
      const R = reachOf(m, s, planId, saleEndIdx);
      const prev = priorAdded(m, planId, s);
      const inb = C.inboundArray(inboundOfSku(m, s), scenario);
      const b = m.baseline.get(s);
      const pPrev = C.project(inventory.get(s).on_hand_qty, inb, prev.map((a) => b + a));
      const own = addedBySku.get(s) ?? C.zeros();
      const pWith = C.project(inventory.get(s).on_hand_qty, inb, prev.map((a, i) => b + a + own[i]));
      out[s] = C.sum(pWith.unmet.map((u, i) => (i < R ? Math.max(0, u - pPrev.unmet[i]) : 0)));
      // SCM 보충 계획이 확인되지 않은 품목은 판매 기간 뒤 부족이 '기준 수요 보충 미확인' 조건(풀릴 근거 없음)이 되므로 그것도 없애야 실행 가능하다.
      // 이게 없으면 그 품목을 빼는 구성이동·물량상한이 후보로 나오지 않는다(PLAN-001·004, 2026-11-15 결함)
      if (!brCovered(m, s)) {
        const end = saleEndIdx ?? saleEndOf(m, planId);
        const inbOn = C.inboundArray(inboundOfSku(m, s), 'on_schedule');
        const qPrev = C.project(inventory.get(s).on_hand_qty, inbOn, prev.map((a) => b + a));
        const qWith = C.project(inventory.get(s).on_hand_qty, inbOn, prev.map((a, i) => b + a + own[i]));
        out[s] += C.sum(qWith.unmet.map((u, i) => (i > end ? Math.max(0, u - qPrev.unmet[i]) : 0)));
      }
    }
    return out;
  }
  const feasible = (res) => Object.values(res).every((v) => v <= C.EPS);
  // 대안 후보의 임시 추가 수량은 문제 1 previewAddedQty로만 계산한다(조정자 확정 (6))
  function preview(m, planId, input) {
    const m1 = p1();
    if (!m1?.previewAddedQty) return null;
    const rows = safe(() => m1.previewAddedQty({ plan_id: planId, ...input }), null);
    if (!rows) return null;
    const map = new Map();
    for (const s of m.planSku.get(planId) ?? []) map.set(s, C.addedToArray(rows.filter((r) => r.sku_id === s)));
    return map;
  }

  function alternativeCandidates(m, planId, judgmentRow) {
    const d = m.demand.get(planId);
    const out = [];
    const base = { plan_id: planId, supply_judgment_id: judgmentRow.supply_judgment_id, supply_judgment_version: judgmentRow.supply_judgment_version,
      source_type: '계산', is_simulation: true, premise_refs: judgmentRow.premise_refs };
    const skuRowsNow = latestSkuRows(planId);
    const hasCond = (r, t) => (r.condition_basis ?? []).some((c) => c.condition_type === t);
    // 막을 수 없는 구간의 부족(부족) 또는 미확정 입고 조건 → 시기·물량·구성·조기 요청 대상
    const short = skuRowsNow.filter((r) => r.supply_verdict === '부족' || (r.condition_basis ?? []).some((c) => c.condition_type !== 'reorder_required'));
    const reorderNeeded = skuRowsNow.filter((r) => r.supply_verdict === '부족' || hasCond(r, 'reorder_required'));
    const evalSc = skuRowsNow.some((r) => r.supply_verdict === '부족') ? 'on_schedule' : 'not_arrived';
    if (d && short.length) {
      const startIdx = C.idxOfWeek(d.input.sale_start_week);
      const weeks = Number(d.input.sale_weeks);
      const overrides = (p1()?.skuOverrides ? safe(() => p1().skuOverrides(d.input.demand_input_id, d.input.version), []) : []) ?? [];
      // 시기이동: 같은 증가율로 시작 주만 미룬다(EA는 문제 1 미리보기).
      // 권장 시작 주 = 부족 SKU들의 보충 가능 시작 주(reorder_reach_week) 중 가장 늦은 주(조정자 확정 (3)(다)). 그 뒤의 부족은 보충 발주로 막는다.
      const tryStart = (k) => {
        if (k < 1 || startIdx + k + weeks - 1 >= C.N) return false;
        const moved = preview(m, planId, { sale_start_week: C.WEEKS[startIdx + k], sale_weeks: weeks, uplift_pct: Number(d.input.uplift_pct),
          override_uplift_pct: overrides.map((o) => ({ sku_id: o.sku_id, override_uplift_pct: Number(o.override_uplift_pct) })) });
        return Boolean(moved && feasible(evalPlan(m, planId, moved, evalSc, startIdx + k + weeks - 1)));
      };
      let earliest = null;
      for (let k = 1; startIdx + k + weeks - 1 < C.N; k++) if (tryStart(k)) { earliest = C.WEEKS[startIdx + k]; break; }
      // 보충이 막힌 SKU는 늦춰도 보충 가능 구간이 생기지 않으므로 권장 시작 주 계산에서 뺀다
      const reachMax = Math.max(...short.filter((r) => !blockOf(m, planId, r.sku_id)).map((r) => reachOf(m, r.sku_id)), -1);
      const recK = Math.max(1, reachMax - startIdx);
      const recommended = reachMax >= 0 && reachMax < C.N && tryStart(recK) ? C.WEEKS[startIdx + recK] : earliest;
      out.push({ ...base, alternative_type: '시기이동', new_sale_start_week: recommended, new_sale_weeks: weeks,
        recommended_sale_start_week: recommended, earliest_feasible_sale_start_week: earliest, feasible: recommended != null,
        remaining_checks: recommended ? '마케팅 선택. 계약상 판매 시기 이동이 되는지 마케팅 확인. 이동 뒤 보충 가능 구간의 부족은 보충 발주 조건으로 붙는다'
          : '전개 기간 안에 가능한 시작 주가 없음' });
      // 물량상한: 0.1%p 단위 이분 탐색
      const cur10 = Math.round(Number(d.input.uplift_pct) * 10);
      const at = (u10) => preview(m, planId, { sale_start_week: d.input.sale_start_week, sale_weeks: weeks, uplift_pct: u10 / 10,
        override_uplift_pct: overrides.map((o) => ({ sku_id: o.sku_id, override_uplift_pct: Math.min(Number(o.override_uplift_pct), u10 / 10) })) });
      if (at(0)) {
        let lo = 0; let hi = cur10;
        if (!feasible(evalPlan(m, planId, at(0), evalSc))) hi = -1;
        while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (feasible(evalPlan(m, planId, at(mid), evalSc))) lo = mid; else hi = mid - 1; }
        const ok = hi >= 0 && lo > 0;
        out.push({ ...base, alternative_type: '물량상한', new_uplift_pct: ok ? lo / 10 : null, new_sale_start_week: d.input.sale_start_week,
          new_sale_weeks: weeks, feasible: ok, remaining_checks: ok ? '마케팅 선택' : '이 판매 기간에는 증가율 0 말고는 막을 수 없는 부족이 생김(기존 수요만으로 공백)' });
        // 구성이동: SKU별 상한까지 낮추고 줄어든 EA를 여지 있는 SKU로 옮긴다
        const skuMax = (sku) => {
          const atSku = (u10) => preview(m, planId, { sale_start_week: d.input.sale_start_week, sale_weeks: weeks, uplift_pct: Number(d.input.uplift_pct),
            override_uplift_pct: [{ sku_id: sku, override_uplift_pct: u10 / 10 }] });
          let l = 0; let h = 10000;
          if ((evalPlan(m, planId, atSku(0), evalSc)[sku] ?? 0) > C.EPS) return { u10: null, atSku };
          while (l < h) { const mid = Math.ceil((l + h) / 2); if ((evalPlan(m, planId, atSku(mid), evalSc)[sku] ?? 0) <= C.EPS) l = mid; else h = mid - 1; }
          return { u10: l, atSku };
        };
        const skuList = m.planSku.get(planId) ?? [];
        if (skuList.length > 1) {
          const applied = new Map(skuList.map((s) => [s, overrides.find((o) => o.sku_id === s)?.override_uplift_pct ?? Number(d.input.uplift_pct)]));
          const newOv = new Map();
          let freed = 0;
          for (const r of short) {
            const { u10 } = skuMax(r.sku_id);
            const nu = u10 == null ? 0 : u10 / 10;
            newOv.set(r.sku_id, nu);
            freed += C.sum(d.added.get(r.sku_id) ?? C.zeros()) - C.sum(at(Math.round(nu * 10))?.get(r.sku_id) ?? C.zeros());
          }
          for (const s of skuList.filter((x) => !newOv.has(x))) {
            if (freed <= C.EPS) break;
            const { u10, atSku } = skuMax(s);
            if (u10 == null || u10 / 10 <= Number(applied.get(s))) continue;
            const curEa = C.sum(d.added.get(s) ?? C.zeros());
            let l = Math.round(Number(applied.get(s)) * 10); let h = u10;
            const eaAt = (u) => { const mp = atSku(u); return mp ? C.sum(mp.get(s)) : Infinity; };
            while (l < h) { const mid = Math.ceil((l + h) / 2); if (eaAt(mid) - curEa <= freed) l = mid; else h = mid - 1; }
            const gain = eaAt(l) === Infinity ? 0 : eaAt(l) - curEa;
            if (gain > 0) { newOv.set(s, l / 10); freed -= gain; }
          }
          out.push({ ...base, alternative_type: '구성이동', new_sale_start_week: d.input.sale_start_week, new_sale_weeks: weeks,
            new_uplift_pct: Number(d.input.uplift_pct),
            new_override_uplift_pct: [...newOv].map(([sku_id, v]) => ({ sku_id, override_uplift_pct: v })), unplaced_ea: C.r2(Math.max(0, freed)),
            feasible: [...newOv.values()].some((v) => v > 0), remaining_checks: '마케팅 선택. 제품라인을 넘는 대체는 하지 않음' });
        }
      } else {
        out.push({ ...base, alternative_type: '물량상한', feasible: false, remaining_checks: `문제 1 미리보기 함수 ${NOT_CONNECTED}` });
      }
      // 조기분할요청: 막을 수 없는 구간의 부족 SKU별
      for (const r of short) {
        if (r.supply_verdict !== '부족') continue;
        const po = poBySku.get(r.sku_id);
        const poRow = inboundOfSku(m, r.sku_id).find((x) => x.source_ref === po?.po_id);
        const refused = db.prepare("SELECT row_json FROM p2_supply_request WHERE plan_id = ?").all(planId).map((x) => P(x.row_json))
          .some((q) => q.sku_id === r.sku_id && q.supply_request_status === '제외');
        if (po && poRow && r.first_shortage_week && !refused) {
          const until = C.arrivalIndex(poRow.eta_date);
          const proj = baseProjection(m, r.sku_id, 'on_schedule', priorAdded(m, planId, r.sku_id).map((a, i) => a + (d.added.get(r.sku_id)?.[i] ?? 0)));
          const fromIdx = C.idxOfWeek(r.first_shortage_week);
          const req = C.sum(proj.unmet, fromIdx, (until < 0 ? C.N : until) - 1);
          if (req > C.EPS) out.push({ ...base, alternative_type: '조기분할요청', sku_id: r.sku_id, po_id: po.po_id, requested_qty: Math.ceil(req),
            needed_week: r.first_shortage_week, feasible: true, remaining_checks: 'Corevia 회신 필요(S-SUP-REPLY). 회신 전에는 가능하다고 가정하지 않음' });
        }
      }
    }
    // 보충발주: 막을 수 없는 부족 SKU(효과는 reach 이후) 또는 보충 발주 필요 조건 SKU. 발주안은 SKU 단위라 그 SKU의 발주안에 이 기안을 잇는다.
    // 발주안이 거절된 SKU는 보충발주 대안을 내지 않는다(조정자 E (2): 거절 → 물량 상한·시기 이동·철회).
    if (d) {
      for (const r of reorderNeeded) {
        if (blockOf(m, planId, r.sku_id)) continue;
        const draft = reorderPreview(m, planId, r);
        out.push({ ...base, alternative_type: '보충발주', sku_id: r.sku_id, po_draft_preview: draft, feasible: Boolean(draft?.order_qty),
          remaining_checks: !draft ? '보충 가능 구간에 채워지지 않은 캠페인 추가 필요량이 없음(기준 수요 보충은 범위 밖, SCM 정기 발주)'
            : `문제 3 지급일·경로 → 승인. ${draft.po_draft_id ? `SKU 발주안 ${draft.po_draft_id}에 연결. ` : ''}${(r.condition_basis ?? []).some((c) => c.condition_type === 'reorder_required') ? '보충 발주 필요 조건을 닫는다' : '막을 수 없는 구간 뒤에만 효과'}` });
      }
    }
    if (hasRejection(planId)) {
      const win = p3()?.cashWindow ? safe(() => p3().cashWindow({})) : null;
      out.push({ ...base, alternative_type: '집행일이동', next_outside_date: win?.next_outside_date ?? null, feasible: Boolean(win?.next_outside_date),
        remaining_checks: win ? '마케팅 선택 → 문제 3 재판정. 판매 기간은 바꾸지 않음' : `문제 3 ${NOT_CONNECTED}` });
    }
    return out;
  }

  // 이 기안을 SKU 발주안에 이었을 때의 모습(열린 발주안이 있으면 그 발주안 기준)
  function reorderPreview(m, planId, skuRow) {
    const c = (skuRow.condition_basis ?? []).find((x) => x.condition_type === 'reorder_required');
    const open = openDraftOf(skuRow.sku_id);
    const rn = skuRow.reorder_need ?? c;
    const needs = skuNeeds(m, skuRow.sku_id, { planId, need: rn?.additional_reorder_qty_ea ?? 0, week: rn?.needed_by_week ?? null });
    const manual = [...(open?._state.manual_links ?? []), ...(needs.has(planId) ? [] : [planId])];
    const pv = skuDraftFor(m, skuRow.sku_id, open?.planned_order_date ?? addBusinessDays(m.today, C.PLANNED_ORDER_LAG_BD), needs, manual,
      { [planId]: skuRow.first_shortage_week });
    return pv && { ...pv, po_draft_id: open?.po_draft_id ?? null };
  }

  const latestSkuRows = (planId) => (model().planSku.get(planId) ?? []).map((s) => latestJudgmentRow(judgmentIdOf(planId, s))).filter(Boolean);

  async function computeAlternatives(planId, causedBy) {
    const m = model();
    const jr = latestJudgmentRow(judgmentIdOf(planId));
    if (!jr) return [];
    const list = alternativeCandidates(m, planId, jr);
    const n = (db.prepare('SELECT MAX(n) AS n FROM p2_alternative WHERE plan_id = ?').get(planId)?.n ?? 0) + 1;
    const ids = [];
    list.forEach((a, i) => {
      const id = `ALT-${planId}-v${jr.supply_judgment_version}-${n}-${i + 1}`;
      db.prepare('INSERT INTO p2_alternative VALUES (?, ?, ?, ?)').run(id, planId, n, J({ alternative_id: id, ...a }));
      ids.push(id);
    });
    touch();
    if (!ids.length) return [];
    await emit({
      event_type: 'ALTERNATIVES_COMPUTED', source_type: '계산', plan_id: planId, actor_dept: 'SCM', is_simulation: true,
      subject_type: 'supply_judgment', subject_id: jr.supply_judgment_id, caused_by: causedBy,
      payload: { supply_judgment_id: jr.supply_judgment_id, alternative_ids: ids },
    });
    return ids;
  }
  const alternativesOf = ({ plan_id, supply_judgment_id, alternative_id, latest_only = true } = {}) => {
    let rows = db.prepare('SELECT plan_id, n, row_json FROM p2_alternative ORDER BY plan_id, n, alternative_id').all();
    if (plan_id) rows = rows.filter((r) => r.plan_id === plan_id);
    if (latest_only && !alternative_id) {
      const maxN = new Map();
      for (const r of rows) maxN.set(r.plan_id, Math.max(maxN.get(r.plan_id) ?? 0, r.n));
      rows = rows.filter((r) => r.n === maxN.get(r.plan_id));
    }
    let out = rows.map((r) => P(r.row_json));
    if (supply_judgment_id) out = out.filter((a) => a.supply_judgment_id === supply_judgment_id);
    if (alternative_id) out = out.filter((a) => a.alternative_id === alternative_id);
    return out;
  };

  // ── 발주안 ──
  const draftRows = () => db.prepare('SELECT * FROM p2_po_draft ORDER BY po_draft_id, draft_version').all()
    .map((r) => ({ ...P(r.row_json), _state: P(r.state_json) }));
  const latestDrafts = () => {
    const by = new Map();
    for (const r of draftRows()) by.set(r.po_draft_id, r);
    return [...by.values()];
  };
  function saveDraftState(d) {
    const { _state, ...row } = d;
    db.prepare('UPDATE p2_po_draft SET row_json = ?, state_json = ? WHERE po_draft_id = ? AND draft_version = ?')
      .run(J(row), J(_state), row.po_draft_id, row.draft_version);
    touch();
  }
  async function createDraft(preview, { causedBy, effectiveAt, origin = 'alternative', manual = [] }) {
    const count = db.prepare('SELECT COUNT(DISTINCT po_draft_id) AS n FROM p2_po_draft').get().n;
    const id = `POD-${String(count + 1).padStart(4, '0')}`;
    const row = { po_draft_id: id, draft_version: 1, ...preview, po_draft_status: '초안' };
    db.prepare('INSERT INTO p2_po_draft VALUES (?, ?, ?, ?)').run(id, 1, J(row),
      J({ origin, approved: false, approval_event_id: null, ordered_event_id: null, overdue_request_id: null, payment_due_date: null, payment_rule_id: null, manual_links: manual }));
    touch();
    const ev = await emit({
      event_type: 'PO_DRAFT_CREATED', source_type: '계산', plan_id: row.linked_plan_ids[0] ?? 'NONE', actor_dept: 'SCM', is_simulation: true,
      subject_type: 'po_draft', subject_id: id, caused_by: causedBy, effective_at: effectiveAt, payload: row,
      generation_reason: origin === 'condition' ? 'SKU 발주안: 공급 판정의 보충 발주 필요 조건' : '보충발주 대안 선택',
    });
    db.prepare("UPDATE p2_po_draft SET state_json = json_set(state_json, '$.created_event_id', ?) WHERE po_draft_id = ? AND draft_version = 1").run(ev.event_id, id);
    touch();
    return row;
  }

  // ── 확인 요청(문제 4 경유, 없으면 직접) ──
  async function requestInfo(req, causedBy) {
    const m4 = p4();
    if (m4?.requestInfo) {
      try {
        const r = await m4.requestInfo({ ...req, caused_by: causedBy });
        if (r?.request_id) db.prepare('INSERT OR REPLACE INTO p2_request VALUES (?, ?, ?, ?)').run(r.request_id, req.request_topic, req.subject_id ?? null, null);
        return r;
      } catch (err) { ctx.log('requestInfo 실패, 직접 냅니다:', err.message); }
    }
    const n = db.prepare('SELECT COUNT(*) AS n FROM p2_request').get().n + 1;
    const request = { request_id: `REQ-P2-${String(n).padStart(4, '0')}`, request_kind: 'initial', request_status: '회신 대기',
      request_due_date: req.request_due_date ?? null, ...req };
    const ev = await emit({ event_type: 'INFO_REQUESTED', source_type: '계산', plan_id: req.plan_id ?? 'NONE', actor_dept: 'SCM',
      subject_type: req.subject_type ?? null, subject_id: req.subject_id ?? null, caused_by: causedBy, payload: request });
    db.prepare('INSERT INTO p2_request VALUES (?, ?, ?, ?)').run(request.request_id, req.request_topic, req.subject_id ?? null, ev.event_id);
    return request;
  }

  // ── 입력 적용 ──
  const applied = (recordId) => P(db.prepare('SELECT result_json FROM p2_applied WHERE record_id = ?').get(recordId)?.result_json);
  const markApplied = (ids, eventId, result) => { for (const id of ids) db.prepare('INSERT OR IGNORE INTO p2_applied VALUES (?, ?, ?)').run(id, eventId, J(result)); };

  async function applyReplyRows(replies, { sourceType = '모의회신', isSynthetic = true, causedBy = null, actor = 'COREVIA' } = {}) {
    const cur = currentInbound();
    const byRef = new Map(cur.rows.map((r) => [r.source_ref, r]));
    const changed = [];
    for (const rp of replies) {
      const row = byRef.get(rp.source_ref);
      if (!row) throw ctx.httpError(400, `입고 행이 없습니다: ${rp.source_ref}`);
      const qty = num(rp.eta_qty);
      if (qty !== row.qty) throw ctx.httpError(400, `수량을 바꿀 수 없습니다(원본 ${row.qty}): ${rp.source_ref}`);
      const po = pos.find((p) => p.po_id === rp.source_ref);
      if (po && rp.eta_date < po.derived_eta_date) throw ctx.httpError(400, `리드타임보다 이른 입고는 조기 공급 시나리오입니다: ${rp.source_ref}`);
      if (!['확정', '지연', '미회신'].includes(rp.eta_status)) throw ctx.httpError(400, `eta_status 값이 아닙니다: ${rp.eta_status}`);
      // 기존 입고 회신(S2-ETA): 확정·지연은 확약, 미회신은 예상(명세 0절 1)
      const next = { ...row, eta_date: rp.eta_date, eta_status: rp.eta_status, supply_status: rp.eta_status === '미회신' ? '예상' : '확약', source_type: sourceType, is_synthetic: isSynthetic,
        effective_at: ctx.clock.today(), record_id: rp.record_id ?? null };
      byRef.set(rp.source_ref, next);
      changed.push({ inbound_row_id: next.inbound_row_id, source_ref: next.source_ref, eta_date: next.eta_date, eta_status: next.eta_status, supply_status: next.supply_status });
    }
    const saved = saveInboundVersion([...byRef.values()], `회신 반영 ${changed.length}행`);
    const ev = await emit({
      event_type: 'INBOUND_SCHEDULE_REVISED', source_type: sourceType, is_synthetic: isSynthetic, actor_dept: actor,
      subject_type: 'inbound_schedule', subject_id: saved.version, caused_by: causedBy,
      source_ref: replies.map((r) => r.record_id).filter(Boolean),
      payload: { inbound_schedule_version: saved.version, changed_rows: changed },
    });
    db.prepare('UPDATE p2_inbound_version SET event_id = ? WHERE inbound_schedule_version = ?').run(ev.event_id, saved.version);
    // 재판정은 INBOUND_SCHEDULE_REVISED 구독에서 한다(문제 4보다 먼저 돌아 rejudge=false가 되게)
    return { event_id: ev.event_id, inbound_schedule_version: saved.version, changed_rows: changed };
  }

  async function applyInboundReply({ record_ids }) {
    const ids = [].concat(record_ids ?? []);
    if (!ids.length) throw ctx.httpError(400, 'record_ids가 필요합니다');
    const done = applied(ids[0]);
    if (done) return { ...done, already_applied: true };
    const rows = ids.map((id) => { const r = replyRecords.get(id); if (!r) throw ctx.httpError(404, `회신 행이 없습니다: ${id}`); return r; });
    const req = db.prepare("SELECT event_id FROM p2_request WHERE request_topic = 'inbound_eta' ORDER BY rowid DESC LIMIT 1").get();
    const result = await applyReplyRows(rows, { causedBy: req?.event_id ?? null });
    markApplied(ids, result.event_id, result);
    return result;
  }

  // 집행일이동의 새 집행일(2026-11-15 결함 (1)): 고정값이 아니라 고르는 시점의 하회 구간 밖 첫 영업일(문제 3 cashWindow)에 여유 1주를 둔 날(주말이면 다음 영업일).
  // 기안 담당자 화면의 대안 카드도 같은 함수로 제안한다.
  function settlementProposal(alt) {
    const win = p3()?.cashWindow ? safe(() => p3().cashWindow({})) : null;
    const next = win?.next_outside_date ?? alt?.next_outside_date ?? null;
    if (!next) return { next_outside_date: null, proposed_settlement_date: null };
    let d = addDays(next, 7);
    while ([0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay())) d = addDays(d, 1);
    return { next_outside_date: next, proposed_settlement_date: d, window_version: win?.window_version ?? null };
  }
  // 모의 입력으로도 부른다: { is_mock: true, generation_reason: '기본 모의 입력' }. settlement_date: 집행일이동의 새 집행일(없으면 settlementProposal)
  async function selectAlternative({ alternative_id, selected_by, actor_dept, requested_budget_krw, new_override_uplift_pct, record_id,
    settlement_date, is_mock = true, generation_reason = null } = {}) {
    if (record_id && applied(record_id)) return { ...applied(record_id), already_applied: true };
    const alt = alternativesOf({ alternative_id })[0];
    if (!alt) throw ctx.httpError(404, `대안이 없습니다: ${alternative_id}`);
    if (!alt.feasible) throw ctx.httpError(400, `실행할 수 없는 대안입니다: ${alt.remaining_checks}`);
    const today = ctx.clock.today();
    const planId = alt.plan_id;
    const payload = { alternative_id, plan_id: planId, alternative_type: alt.alternative_type };
    let planChange = null;
    if (alt.alternative_type === '집행일이동') {
      const prevV = db.prepare('SELECT MAX(plan_version) AS v FROM p2_plan_change WHERE plan_id = ?').get(planId)?.v ?? 0;
      const orig = ctx.plans().find((p) => p.plan_id === planId);
      const prop = settlementProposal(alt);
      if (settlement_date && prop.next_outside_date && settlement_date < prop.next_outside_date) {
        throw ctx.httpError(400, `새 집행일 ${settlement_date}이 지금 하회 구간 밖 첫날(${prop.next_outside_date})보다 이릅니다`);
      }
      planChange = { plan_id: planId, plan_version: prevV + 1, settlement_date: settlement_date ?? prop.proposed_settlement_date,
        requested_budget_krw: requested_budget_krw ?? orig.requested_budget_krw, effective_at: today,
        next_outside_date: prop.next_outside_date, cash_window_version: prop.window_version,
        change_reason: settlement_date ? '승인 거절 뒤 집행일을 하회 구간 밖으로 이동(지정일)' : `승인 거절 뒤 집행일을 하회 구간 밖 첫 영업일(${prop.next_outside_date}) + 여유 1주로 이동` };
      payload.plan_change = planChange;
    } else if (['시기이동', '물량상한', '구성이동'].includes(alt.alternative_type)) {
      payload.alternative_selection = {
        plan_id: planId, alternative_id, alternative_type: alt.alternative_type,
        new_sale_start_week: alt.new_sale_start_week ?? null, new_sale_weeks: alt.new_sale_weeks ?? null, new_uplift_pct: alt.new_uplift_pct ?? null,
        new_override_uplift_pct: new_override_uplift_pct ?? alt.new_override_uplift_pct ?? [], selected_by, event_id: null,
      };
    }
    const dept = actor_dept ?? (['보충발주', '조기분할요청'].includes(alt.alternative_type) ? 'SCM' : 'MKT');
    const ev = await ctx.events.emit({
      spec_ref: SPEC, event_type: 'ALTERNATIVE_SELECTED', source_type: '사람입력', is_synthetic: Boolean(is_mock), plan_id: planId, actor_dept: dept,
      generation_reason: generation_reason ?? (is_mock ? '모의 사람 입력' : null),
      actor_role: selected_by ?? null, subject_type: 'alternative', subject_id: alternative_id, source_ref: record_id ? [record_id] : null, payload,
    });
    if (payload.alternative_selection) payload.alternative_selection.event_id = ev.event_id;
    db.prepare('INSERT OR REPLACE INTO p2_selection VALUES (?, ?, ?, ?)').run(alternative_id, planId, ev.event_id, J({ ...payload, event_id: ev.event_id, selected_by }));
    if (planChange) db.prepare('INSERT INTO p2_plan_change VALUES (?, ?, ?)').run(planId, planChange.plan_version, J(planChange));
    touch();
    let draft = null;
    if (alt.alternative_type === '보충발주') {
      // 발주안은 SKU 단위다. 그 SKU의 열린 발주안에 이 기안을 잇고(없으면 만든다), 수량은 등록 수요 전체로 다시 맞춘다.
      const jr = latestJudgmentRow(judgmentIdOf(planId, alt.sku_id));
      const c = jr?.reorder_need ?? (jr?.condition_basis ?? []).find((x) => x.condition_type === 'reorder_required');
      const before = openDraftOf(alt.sku_id);
      const synced = await syncSkuDraft(model(), alt.sku_id, ev.event_id, { planId, need: c?.additional_reorder_qty_ea ?? 0, week: c?.needed_by_week ?? null, manual: true });
      if (synced) { const { _state, ...row } = synced; draft = { ...row, reused: Boolean(before && before.po_draft_id === row.po_draft_id) }; }
    }
    let supplyRequest = null;
    if (alt.alternative_type === '조기분할요청') {
      const id = `SR-${planId}-${alt.sku_id}`;
      const info = await requestInfo({ request_topic: 'supply_request', requested_to: 'COREVIA', plan_id: planId, subject_type: 'supply_request',
        subject_id: id, request_kind: 'initial', questions: [`${alt.po_id} ${alt.requested_qty} EA를 ${alt.needed_week} 주까지 조기·분할 공급할 수 있는지`] }, ev.event_id);
      supplyRequest = { supply_request_id: id, request_id: info?.request_id ?? null, plan_id: planId, supply_judgment_id: alt.supply_judgment_id,
        po_id: alt.po_id ?? 'NONE', sku_id: alt.sku_id, requested_qty: alt.requested_qty, needed_week: alt.needed_week, supply_request_status: '요청',
        scenario_id: 'BASE', supply_reply_type: '조기', reply_result: null, offered_qty: null, offered_eta_date: null, required_checks: null };
      db.prepare('INSERT OR REPLACE INTO p2_supply_request VALUES (?, ?, ?)').run(id, planId, J(supplyRequest));
      touch();
    }
    const result = { event_id: ev.event_id, alternative_selection: payload.alternative_selection ?? null, plan_change: planChange, po_draft: draft, supply_request: supplyRequest };
    if (record_id) markApplied([record_id], ev.event_id, result);
    return result;
  }

  // 문제 4 기본 모의 입력용: 기안의 대안과 권장 대안(조정자 확정 (3))
  function planAlternatives(planId) {
    const j = latestJudgmentRow(judgmentIdOf(planId));
    if (!j) return null;
    const alts = alternativesOf({ plan_id: planId }).filter((a) => a.supply_judgment_version === j.supply_judgment_version || a.alternative_type === '집행일이동');
    // 권장 대안(L4): 고르면 예상되는 판정이 가장 좋은 것(가능 > 조건부(확정기한 전 풀림) > 조건부(근거 없음) > 부족), 같으면 덜 바꾸는 쪽
    const recommended = ['부족', '조건부'].includes(j.supply_verdict) ? recommendAlternative(model(), planId, alts, j) : null;
    const drafts = latestDrafts().filter((x) => x.linked_plan_ids.includes(planId)).map(({ _state, ...x }) => ({ ...x, origin: _state.origin ?? 'alternative', approved: Boolean(_state.approved) }));
    return {
      plan_id: planId, supply_judgment_id: j.supply_judgment_id, supply_judgment_version: j.supply_judgment_version, supply_verdict: j.supply_verdict,
      condition_basis: j.condition_basis, alternatives: alts, recommended,
      has_feasible: alts.some((a) => a.feasible), condition_po_drafts: drafts.filter((x) => x.origin === 'condition'), po_drafts: drafts,
    };
  }
  // 조기 공급 요청: 그 기안의 실행 가능한 조기분할요청 대안을 모두 고른다(SCM)
  async function requestEarlySupply(planId, { selected_by = 'SCM-PLANNER', generation_reason = null } = {}) {
    const out = [];
    for (const a of alternativesOf({ plan_id: planId }).filter((x) => x.alternative_type === '조기분할요청' && x.feasible)) {
      const done = db.prepare('SELECT row_json FROM p2_supply_request WHERE supply_request_id = ?').get(`SR-${planId}-${a.sku_id}`);
      if (done) continue;
      out.push((await selectAlternative({ alternative_id: a.alternative_id, selected_by, actor_dept: 'SCM', generation_reason })).supply_request);
    }
    return out;
  }
  // Corevia 회신: 그 기안의 열린 공급 요청에 자료의 회신을 넣는다
  async function applySupplierReplies(planId) {
    const open = db.prepare('SELECT row_json FROM p2_supply_request WHERE plan_id = ?').all(planId).map((r) => P(r.row_json)).filter((q) => q.supply_request_status === '요청');
    const out = [];
    for (const q of open) out.push(await applySupplierReply({ supply_request_id: q.supply_request_id }));
    return out;
  }

  async function applySupplierReply({ supply_request_id, record_id }) {
    if (record_id && applied(record_id)) return { ...applied(record_id), already_applied: true };
    const row = db.prepare('SELECT row_json FROM p2_supply_request WHERE supply_request_id = ?').get(supply_request_id);
    if (!row) throw ctx.httpError(404, `공급 요청이 없습니다: ${supply_request_id}`);
    const sr = P(row.row_json);
    const rec = supplyReplies.find((r) => r.record_id === record_id) ?? supplyReplies.find((r) => r.plan_id === sr.plan_id && r.sku_id === sr.sku_id);
    if (!rec) throw ctx.httpError(404, `회신 자료가 없습니다: ${supply_request_id}`);
    const next = { ...sr, supply_reply_type: rec.supply_reply_type, reply_result: rec.reply_result, offered_qty: num(rec.offered_qty),
      offered_eta_date: rec.offered_eta_date === 'NONE' ? null : rec.offered_eta_date, required_checks: rec.required_checks,
      supply_request_status: rec.reply_result === '불가' ? '제외' : '회신됨' };
    db.prepare('UPDATE p2_supply_request SET row_json = ? WHERE supply_request_id = ?').run(J(next), supply_request_id);
    touch();
    const reqEv = next.request_id ? db.prepare('SELECT event_id FROM p2_request WHERE request_id = ?').get(next.request_id)?.event_id : null;
    const ev = await emit({
      event_type: 'SUPPLIER_REPLIED', source_type: '모의회신', is_synthetic: true, plan_id: sr.plan_id, actor_dept: 'COREVIA',
      subject_type: 'supply_request', subject_id: supply_request_id, scenario_id: rec.scenario_id || 'BASE', caused_by: reqEv ?? null, source_ref: [rec.record_id],
      payload: { supply_request_id, supply_reply_type: next.supply_reply_type, reply_result: next.reply_result, offered_qty: next.offered_qty,
        offered_eta_date: next.offered_eta_date, required_checks: next.required_checks },
    });
    await computeAlternatives(sr.plan_id, ev.event_id);
    const result = { event_id: ev.event_id, supply_request: next };
    markApplied([rec.record_id], ev.event_id, result);
    return result;
  }

  // 문제 4 사건 순서표(S4-09)의 행을 전달받는다
  async function deliverMock(mockId) {
    const row = p4()?.getMockSchedule ? safe(() => p4().getMockSchedule({ owner: 'p2' }), [])?.find((r) => r.mock_id === mockId) : null;
    if (!row) throw new Error(`문제 4 사건 순서표에 없는 모의 입력입니다(또는 문제 4 ${NOT_CONNECTED}): ${mockId}`);
    const date = row.sim_date;
    if (row.event_type === 'INBOUND_SCHEDULE_REVISED') {
      // 그 날짜의 기발주 입고 회신(S2-ETA)과 SCM 기준 수요 보충 계획 회신(S2-SCM-BR)
      // 그 날짜의 운송 중 입고 회신(S2-ETA-IT), SCM 기준 수요 보충 계획(S2-SCM-BR), 기발주 Corevia 공급 회신(S2-CVC po)
      const ids = etaIt.filter((r) => r.occurred_at === date).map((r) => r.record_id);
      const out = {};
      if (ids.length) out.in_transit = await applyInboundReply({ record_ids: ids });
      if (brPlan.some((r) => r.occurred_at === date)) out.baseline_plan = await applyBaselinePlan({ date });
      const sc = await applySupplyReplies({ date });
      if (sc.length) out.supply_commitments = sc;
      return Object.keys(out).length ? out : { skipped: true, reason: '이 날짜의 입고 회신 자료가 없습니다(발주안 발주는 문제 2가 onDay에서 처리)' };
    }
    if (row.event_type === 'ALTERNATIVE_SELECTED') {
      const sel = mockSelections.find((s) => s.plan_id === row.plan_id && s.occurred_at === date);
      if (!sel) return { skipped: true, reason: `선택 자료가 없습니다: ${row.plan_id}` };
      const alt = alternativesOf({ plan_id: sel.plan_id }).find((a) => a.alternative_type === sel.alternative_type && a.feasible);
      if (!alt) return { skipped: true, reason: `${sel.plan_id}에 실행 가능한 ${sel.alternative_type} 대안이 없습니다(재판정이 부족·조건부가 아님)` };
      return selectAlternative({ alternative_id: alt.alternative_id, selected_by: sel.selected_by, actor_dept: sel.actor_dept,
        requested_budget_krw: num(sel.requested_budget_krw) ?? undefined, record_id: sel.record_id,
        settlement_date: sel.settlement_date && sel.settlement_date !== 'NONE' ? sel.settlement_date : undefined, generation_reason: sel.generation_reason });
    }
    if (row.event_type === 'SUPPLIER_REPLIED' && /^S2-CVC-/.test(String(row.record_id ?? row.target ?? ''))) {
      // Corevia 공급 회신(S2-CVC): record_id(또는 target)와 발주안 대상이면 po_draft_id. 없으면 그 회신을 받을 승인 발주안을 찾는다
      const rid = row.record_id ?? row.target;
      const poId = row.po_draft_id ?? dueCommitments().find((x) => x.record_id === rid && !x.applied)?.po_draft_id ?? null;
      return applySupplyCommitment({ record_id: rid, po_draft_id: poId });
    }
    if (row.event_type === 'SUPPLIER_REPLIED') {
      const open = db.prepare('SELECT row_json FROM p2_supply_request WHERE plan_id = ?').all(row.plan_id).map((r) => P(r.row_json))
        .filter((q) => q.supply_request_status === '요청');
      const out = [];
      for (const q of open) out.push(await applySupplierReply({ supply_request_id: q.supply_request_id }));
      return out.length ? out : { skipped: true, reason: '열린 공급 요청이 없습니다' };
    }
    return { skipped: true, reason: `문제 2가 내는 모의 입력이 아닙니다: ${row.event_type}` };
  }

  // ── AI: 공급자 납기 회신 구조화(확인 뒤 반영) ──
  async function structureInboundText({ text, request_id = null, plan_id = 'NONE' }) {
    const r = await ctx.ai.call({
      ai_task_type: 'structure', ai_task_name: 'supplier_eta_structure', plan_id, input_refs: request_id ? [request_id] : [],
      messages: [
        { role: 'system', content: '공급자 납기 회신을 JSON으로 바꾼다. 형식: {"rows":[{"source_ref":"SPO-nnnn 또는 IN_TRANSIT:SKU-nnnn","eta_date":"YYYY-MM-DD","eta_status":"확정|지연|미회신","eta_qty":정수}],"unclear_reasons":[]}. 회신에 없는 값은 추측하지 말고 null로 두고 사유를 unclear_reasons에 적는다.' },
        { role: 'user', content: String(text ?? '') },
      ],
    });
    if (r.status === '미연결') return { status: '미연결', message: 'AI 미연결: 담당자가 입고 행을 직접 입력합니다' };
    db.prepare('INSERT INTO p2_ai_pending VALUES (?, ?, ?, ?)').run(r.ai_call_id, request_id, J(r.output), '확인 대기');
    return { status: '연결', ai_call_id: r.ai_call_id, output: r.output, review_status: '확인 대기' };
  }
  async function confirmInbound({ ai_call_id = null, rows, reviewer_role = 'SCM-PLANNER', review_result = '확인' }) {
    if (ai_call_id) {
      const pend = db.prepare('SELECT * FROM p2_ai_pending WHERE ai_call_id = ?').get(ai_call_id);
      if (!pend) throw ctx.httpError(404, `확인 대기 중인 AI 결과가 없습니다: ${ai_call_id}`);
      await ctx.ai.review({ ai_call_id, review_result, reviewer_role, edited_fields: review_result === '수정 후 확인' ? ['rows'] : [] });
      db.prepare('UPDATE p2_ai_pending SET status = ? WHERE ai_call_id = ?').run(review_result, ai_call_id);
      if (review_result === '거부') return { status: '거부' };
      rows = rows ?? P(pend.row_json).rows;
    }
    if (!rows?.length) throw ctx.httpError(400, 'rows가 필요합니다');
    if (rows.some((r) => Object.values(r).some((v) => v == null))) throw ctx.httpError(400, '빈 값이 있는 행은 반영하지 않습니다');
    return applyReplyRows(rows, { sourceType: '사람입력', isSynthetic: true, actor: 'SCM' });
  }

  // ── 전제 변경 뒤 처리 ──
  async function emitProjected(causedBy = null) {
    const m = model();
    if (!m.ready) return null;
    const subject = `${m.inbound.version}|${m.baselineVersion}`;
    const last = ctx.events.query({ event_type: 'SUPPLY_PROJECTED', emitted_by: ctx.id, order: 'desc', limit: 1 })[0];
    if (last?.subject_id === subject) return null;
    return emit({
      event_type: 'SUPPLY_PROJECTED', source_type: '계산', actor_dept: 'SCM', caused_by: causedBy,
      is_simulation: m.inbound.rows.some((r) => r.is_synthetic),
      subject_type: 'supply_projection_base', subject_id: subject,
      payload: { inbound_schedule_version: m.inbound.version, baseline_demand_version: m.baselineVersion, ordering_rule_version: C.ORDERING_RULE_VERSION },
    });
  }
  // 전제가 바뀌면 바뀐 기안을 바로 다시 판정한다(caused_by = 트리거). 문제 4는 이를 보고 rejudge=false로 재검토를 연다.
  async function afterPremiseChange(ev, { projected = true } = {}) {
    touch();
    if (projected) await emitProjected(ev?.event_id ?? null);
    await judgeChanged(ev?.event_id ?? null);
    await syncOpenDrafts(ev?.event_id ?? null);
  }

  // ── 구독 ──
  ctx.events.on('*', () => touch());
  ctx.events.on('BASELINE_DEMAND_SET', (e) => afterPremiseChange(e));
  // 문제 2 자신이 낸 입고 사건도 구독한다. 구독자는 등록 순서(p1→p4)로 불리므로 문제 4의 재검토보다 먼저 다시 판정한다.
  ctx.events.on('INBOUND_SCHEDULE_REVISED', (e) => afterPremiseChange(e));
  ctx.events.on(['DEMAND_INPUT_REGISTERED', 'DEMAND_INPUT_REVISED'], (e) => afterPremiseChange(e, { projected: false }));
  ctx.events.on(['PLAN_CONFIRMED', 'PLAN_AUTO_CONFIRMED_BY_DEADLINE'], (e) => afterPremiseChange(e, { projected: false }));
  // 철회: 승인 전 SKU 발주안에서 그 기안을 빼고 수량을 다시 맞춘다. 남은 연결 기안이 없으면 취소. 승인된 발주안은 그대로 둔다.
  // 철회(L1, 조정자 확정): 승인 전 발주안은 그 기안을 빼고 다시 맞춘다(남은 연결 기안이 없으면 취소).
  // 승인된 발주안은 발주 전달 전(오늘 < 발주 예정일)이면 그 기안에만 걸린 것은 취소해 약정·현금 유출을 빼고, 다른 기안도 걸려 있으면 그 기안만 떼고 수량을 다시 계산한다.
  // 이미 발주가 전달됐으면 취소하지 않고 '기안 철회 뒤 남은 발주'로 표시해 SCM에 취소·조정 가능 여부를 묻는다.
  ctx.events.on('PLAN_WITHDRAWN', async (e) => {
    touch();
    for (const d of latestDrafts().filter((x) => isOpenDraft(x) && x.linked_plan_ids.includes(e.plan_id))) {
      const others = d.linked_plan_ids.filter((pid) => pid !== e.plan_id);
      await syncSkuDraft(model(), d.sku_id, e.event_id, null, { cancelReason: '연결 기안 철회',
        extra: { withdrawal: { plan_id: e.plan_id, withdrawn_event_id: e.event_id, disposition: others.length ? '기안만 뗌' : '취소' } } });
    }
    for (const d of latestDrafts().filter((x) => isApproved(x) && !['취소', '반려'].includes(x.po_draft_status) && x.linked_plan_ids.includes(e.plan_id))) {
      await releaseApprovedDraft(d, e);
    }
    await afterPremiseChange(e, { projected: false });
  });
  async function removeDraftInbound(d, causedBy, reason) {
    const cur = currentInbound();
    const rowId = `IB-${d.po_draft_id}`;
    const rows = cur.rows.filter((r) => r.inbound_row_id !== rowId && r.inbound_row_id !== `${rowId}-R`);
    if (rows.length === cur.rows.length) return null;
    const saved = saveInboundVersion(rows, reason);
    const ev = await emit({ event_type: 'INBOUND_SCHEDULE_REVISED', source_type: '계산', is_simulation: true, plan_id: d.linked_plan_ids[0] ?? 'NONE', actor_dept: 'SCM',
      subject_type: 'inbound_schedule', subject_id: saved.version, caused_by: causedBy, source_ref: [d.po_draft_id], generation_reason: reason,
      payload: { inbound_schedule_version: saved.version, changed_rows: cur.rows.filter((r) => r.inbound_row_id.startsWith(rowId)).map((r) => ({ inbound_row_id: r.inbound_row_id, source_ref: r.source_ref, qty: r.qty, eta_date: r.eta_date, supply_status: '삭제(발주안 취소·재승인 대기)' })) } });
    db.prepare('UPDATE p2_inbound_version SET event_id = ? WHERE inbound_schedule_version = ?').run(ev.event_id, saved.version);
    return ev;
  }
  async function releaseApprovedDraft(d, e) {
    const planId = e.plan_id;
    const m = model();
    const others = d.linked_plan_ids.filter((pid) => pid !== planId && m.rank.has(pid));
    const ordered = d.po_draft_status === '발주' || ctx.clock.today() >= d.planned_order_date;
    const before = [...d.linked_plan_ids];
    const W = (disposition) => ({ withdrawal: { plan_id: planId, withdrawn_event_id: e.event_id, disposition } });
    if (ordered) {
      // 이미 발주 전달: 취소하지 않는다. 다른 기안이 없으면 '기안 철회 뒤 남은 발주'로 표시하고 SCM에 묻는다
      d.linked_plan_ids = d.linked_plan_ids.filter((pid) => pid !== planId);
      if (d.qty_breakdown) d.qty_breakdown = { ...d.qty_breakdown, campaign_by_plan: (d.qty_breakdown.campaign_by_plan ?? []).filter((x) => x.plan_id !== planId) };
      if (!others.length) {
        d.orphan_status = '기안 철회 뒤 남은 발주';
        const r = await requestInfo({ request_topic: 'po_draft_orphaned', requested_to: 'SCM', plan_id: planId, subject_type: 'po_draft', subject_id: d.po_draft_id, request_kind: 'initial',
          questions: [`발주안 ${d.po_draft_id}(${d.sku_id} ${d.order_qty.toLocaleString('ko-KR')} EA, ${d.amount_krw.toLocaleString('ko-KR')}원)는 연결 기안 ${planId} 철회 뒤 남은 발주입니다. 발주가 이미 전달돼 Corevia에 취소·수량 조정이 가능한지 확인해 주세요`] }, e.event_id);
        d._state = { ...d._state, orphaned: { plan_id: planId, event_id: e.event_id, request_id: r?.request_id ?? null } };
      }
      saveDraftState(d);
      await emitRelink(d, before, e.event_id, W(others.length ? '기안만 뗌(발주 전달 뒤)' : '발주 전달 뒤 남음'));
      return;
    }
    if (!others.length) {
      // 발주 전달 전, 이 기안에만 걸림: 취소(문제 3이 약정·현금 유출을 뺀다)하고 예상 입고를 지운다
      await cancelDraft(d, e.event_id, '연결 기안 철회(발주 전달 전, 승인 발주안 취소)', W('취소'));
      await removeDraftInbound(d, e.event_id, `연결 기안 ${planId} 철회로 발주안 ${d.po_draft_id} 취소(발주 전달 전)`);
      return;
    }
    // 발주 전달 전, 다른 기안도 걸림: 그 기안만 떼고 남은 기안 몫으로 수량을 다시 계산한다(MOQ). 수량이 바뀌면 새 버전이라 다시 승인받는다
    const share = (d.qty_breakdown?.campaign_by_plan ?? []).filter((x) => x.plan_id !== planId);
    const need = share.reduce((t, x) => t + x.qty_ea, 0);
    const qty = Math.max(Math.ceil(need - C.EPS), d.moq);
    const pv = { ...d, linked_plan_ids: others, order_qty: qty, amount_krw: qty * d.unit_cost_krw, order_qty_campaign_ea: C.r2(need),
      qty_basis: { ...(d.qty_basis ?? {}), campaign_need_ea: C.r2(need), moq_roundup_ea: C.r2(qty - need) },
      qty_breakdown: { ...(d.qty_breakdown ?? {}), campaign_added_ea: C.r2(need), rounding_ea: C.r2(qty - need), campaign_share_pct: C.r2((need / qty) * 100),
        campaign_amount_krw: Math.round(need * d.unit_cost_krw), campaign_by_plan: share } };
    delete pv._state;
    if (qty === d.order_qty) {
      Object.assign(d, { linked_plan_ids: others, qty_breakdown: pv.qty_breakdown, qty_basis: pv.qty_basis, order_qty_campaign_ea: pv.order_qty_campaign_ea });
      saveDraftState(d);
      await emitRelink(d, before, e.event_id, W('기안만 뗌'));
      return;
    }
    await reviseDraft({ ...d, _state: { ...d._state, approved: false, approval_event_id: null, commitment: null } }, pv, e.event_id, d._state?.manual_links ?? [], W('기안만 뗌(수량 재계산, 다시 승인)'));
    await removeDraftInbound(d, e.event_id, `연결 기안 ${planId} 철회로 발주안 ${d.po_draft_id} 수량 재계산(${d.order_qty} → ${qty} EA, 다시 승인 필요)`);
  }
  ctx.events.on('PLAN_RECEIVED', (e) => judge(e.plan_id, { force: !latestJudgmentRow(judgmentIdOf(e.plan_id)), causedBy: e.event_id }));
  ctx.events.on('REVIEW_OPENED', (e) => {
    const p = e.payload ?? {};
    if (p.target_type !== 'supply_judgment') return null;
    if (p.rejudge === false) return null; // 이미 다시 계산했다(조정자 확정 (5)). 같은 판정 버전을 또 만들지 않는다
    if (CLOSED.has(planStatusOf(e.plan_id) ?? '')) return null; // 종결된 기안은 동결
    const row = db.prepare('SELECT plan_id FROM p2_judgment WHERE supply_judgment_id = ? LIMIT 1').get(p.target_id);
    const planId = row?.plan_id ?? (e.plan_id !== 'NONE' ? e.plan_id : null);
    return planId ? judge(planId, { force: true, causedBy: e.event_id }) : null;
  });
  ctx.events.on('PAYMENT_DATE_SET', (e) => {
    const p = e.payload ?? {};
    const d = latestDrafts().find((x) => x.po_draft_id === p.po_draft_id);
    if (!d) return;
    if (d.po_draft_status === '초안') d.po_draft_status = '승인대기';
    d._state = { ...d._state, payment_due_date: p.payment_due_date ?? null, payment_rule_id: p.payment_rule_id ?? null };
    saveDraftState(d);
  });
  ctx.events.on('APPROVAL_REPLIED', async (e) => {
    const p = e.payload ?? {};
    const c = p3()?.commitment ? safe(() => p3().commitment(p.commitment_id)) : null;
    const sourceId = c?.source_id ?? null;
    if (!sourceId) return;
    if (sourceId.startsWith('POD-')) {
      const d = latestDrafts().find((x) => x.po_draft_id === sourceId);
      if (!d || ['발주', '취소'].includes(d.po_draft_status)) return;
      if (p.decision === '승인') {
        d._state = { ...d._state, approved: true, approval_event_id: e.event_id };
        if (d.po_draft_status === '초안') d.po_draft_status = '승인대기';
        // 내부 승인은 지출 허용일 뿐 공급 확약이 아니다(명세 0절 1). 발주 예정일 + 리드타임의 '예상' 입고로만 넣고, Corevia 확약 회신을 기다린다.
        if (ctx.clock.today() <= d.planned_order_date && !currentInbound().rows.some((r) => r.source_ref === d.po_draft_id)) {
          const row = { inbound_row_id: `IB-${d.po_draft_id}`, sku_id: d.sku_id, source_ref: d.po_draft_id, qty: d.order_qty,
            eta_date: addDays(d.planned_order_date, skuById.get(d.sku_id).lead_time_weeks * 7), eta_status: '미회신', supply_status: '예상', source_type: '계산',
            is_synthetic: false, scenario_id: 'BASE', effective_at: ctx.clock.today(), record_id: null };
          const saved = saveInboundVersion([...currentInbound().rows, row], `승인 발주안 ${d.po_draft_id} 입고 반영`);
          saveDraftState(d);
          const iev = await emit({ event_type: 'INBOUND_SCHEDULE_REVISED', source_type: '계산', is_simulation: true, plan_id: d.linked_plan_ids[0] ?? 'NONE',
            actor_dept: 'SCM', subject_type: 'inbound_schedule', subject_id: saved.version, caused_by: e.event_id, source_ref: [d.po_draft_id],
            payload: { inbound_schedule_version: saved.version, changed_rows: [{ inbound_row_id: row.inbound_row_id, source_ref: row.source_ref, qty: row.qty, eta_date: row.eta_date, eta_status: row.eta_status, supply_status: row.supply_status }] } });
          db.prepare('UPDATE p2_inbound_version SET event_id = ? WHERE inbound_schedule_version = ?').run(iev.event_id, saved.version);
        }
      }
      if (p.decision === '거절') d.po_draft_status = '반려';
      if (p.decision === '조건부') d._state = { ...d._state, conditions: p.conditions ?? [] };
      saveDraftState(d);
      if (p.decision === '거절') {
        // 거절된 발주안에 기대던 기안은 그 SKU의 보충 조건을 채울 수 없다(조정자 E (2)). 그 SKU를 보충 발주 없이 다시 판정하고
        // (보충 가능 구간도 막을 수 없는 구간으로 봄 → 부족), 부족이면 물량 상한·시기 이동 대안을 다시 계산한다.
        const ins = db.prepare('INSERT OR IGNORE INTO p2_reorder_block VALUES (?, ?, ?, ?)');
        for (const pid of d.linked_plan_ids) ins.run(pid, d.sku_id, d.po_draft_id, e.event_id);
        touch();
        for (const pid of d.linked_plan_ids) await judge(pid, { causedBy: e.event_id });
        await syncOpenDrafts(e.event_id);
      }
    } else if (sourceId.startsWith('PLAN-') && p.decision === '거절') {
      db.prepare('INSERT OR REPLACE INTO p2_rejection VALUES (?, ?)').run(sourceId, e.event_id);
      touch();
      await computeAlternatives(sourceId, e.event_id);
    }
  });
  ctx.events.on('INFO_REPLIED', async (e) => {
    const p = e.payload ?? {};
    const mine = p.request_id && db.prepare("SELECT 1 FROM p2_request WHERE request_id = ? AND request_topic = 'inbound_eta'").get(p.request_id);
    if (mine && p.reply_text) await structureInboundText({ text: p.reply_text, request_id: p.request_id });
  });
  ctx.events.on('ALTERNATIVE_SELECTED', () => touch());

  ctx.clock.onDay(async (date) => {
    // 승인된 발주안은 발주 예정일에 발주한다. 같은 날 발주는 입고 버전 하나로 묶어 재판정을 한 번만 일으킨다.
    for (const d of latestDrafts().filter((x) => x.po_draft_status === '승인대기' && x._state.approved && x.planned_order_date === date
      && currentInbound().rows.some((r) => r.source_ref === x.po_draft_id))) { d.po_draft_status = '발주'; saveDraftState(d); }
    const due = latestDrafts().filter((d) => d.po_draft_status === '승인대기' && d._state.approved && d.planned_order_date === date);
    if (due.length) {
      const added = due.map((d) => ({
        inbound_row_id: `IB-${d.po_draft_id}`, sku_id: d.sku_id, source_ref: d.po_draft_id, qty: d.order_qty,
        eta_date: addDays(d.planned_order_date, skuById.get(d.sku_id).lead_time_weeks * 7), eta_status: '미회신', supply_status: '예상', source_type: '계산',
        is_synthetic: false, scenario_id: 'BASE', effective_at: date, record_id: null,
      }));
      const saved = saveInboundVersion([...currentInbound().rows, ...added], `발주안 ${due.map((d) => d.po_draft_id).join(', ')} 발주(모의 전달)`);
      for (const d of due) { d.po_draft_status = '발주'; saveDraftState(d); }
      const ev = await emit({
        event_type: 'INBOUND_SCHEDULE_REVISED', source_type: '계산', is_simulation: true, plan_id: due[0].linked_plan_ids[0] ?? 'NONE', actor_dept: 'SCM',
        subject_type: 'inbound_schedule', subject_id: saved.version, caused_by: due[0]._state.approval_event_id ?? null,
        source_ref: due.map((d) => d.po_draft_id),
        payload: { inbound_schedule_version: saved.version, changed_rows: added.map((r) => ({ inbound_row_id: r.inbound_row_id, source_ref: r.source_ref,
          qty: r.qty, eta_date: r.eta_date, eta_status: r.eta_status, supply_status: r.supply_status })) },
      });
      db.prepare('UPDATE p2_inbound_version SET event_id = ? WHERE inbound_schedule_version = ?').run(ev.event_id, saved.version);
      for (const d of due) { d._state = { ...d._state, ordered_event_id: ev.event_id }; saveDraftState(d); }
    }
    for (const d of latestDrafts()) {
      if (d.po_draft_status === '승인대기' && !d._state.approved && date > d.planned_order_date && !d._state.overdue_request_id) {
        const r = await requestInfo({ request_topic: 'po_draft_overdue', requested_to: 'SCM', plan_id: d.linked_plan_ids[0] ?? 'NONE',
          subject_type: 'po_draft', subject_id: d.po_draft_id, request_kind: 'initial' }, null);
        d._state = { ...d._state, overdue_request_id: r?.request_id ?? 'requested' };
        saveDraftState(d);
      }
    }
    // 그날 도착하는 모의 회신: SCM 기준 수요 보충 계획(S2-SCM-BR, 날짜 고정)과 Corevia 공급 회신(S2-CVC, 승인 + n영업일).
    // 문제 4 순서표가 deliverMock으로 먼저 넣었으면 같은 회신 재처리라 아무것도 바뀌지 않는다.
    await applyBaselinePlan({ date });
    await applySupplyReplies({ date });
    await processArrivals(date);
    // 날짜가 바뀌면 막을 수 없는 구간(발주 예정일 + 리드타임)이 밀린다. 결론이 바뀐 기안만 새 버전으로 낸다(조정자 확정 (2)).
    await judgeChanged(null, null, 'date');
  });

  // ── 초기화 ──
  ctx.onInit(async () => {
    ensureInbound();
    await emitProjected();
    const req = await requestInfo({ request_topic: 'inbound_eta', requested_to: 'SCM', subject_type: 'inbound_schedule',
      subject_id: latestInbound().inbound_schedule_version, request_kind: 'initial',
      questions: ['기발주 14건과 운송 중 14 SKU의 입고 예정일과 확정 여부'] }, null);
    void req;
    // 기준 수요 보충 계획을 SKU별 SCM 확인 요청으로 넘긴다(명세 0절 5). split: 문제 4가 SKU별로 다시 나누지 않게 한다.
    // 회신 전에는 보충 계획이 없는 것으로 보고, 판매 기간 뒤 부족을 조건으로 남긴다(자동으로 풀리지 않음).
    for (const s of skus) {
      const r = await requestInfo({ request_topic: 'baseline_replenishment', requested_to: 'SCM', plan_id: 'NONE', subject_type: 'baseline_replenishment',
        subject_id: s.sku_id, request_kind: 'initial', request_due_date: null, split: true,
        questions: [`${s.sku_id} 기준 수요 보충 계획: 발주 예정일·수량·Masil 도착 예정일과 Corevia 확약 여부. 회신 전에는 이 SKU를 쓰는 기안의 판매 기간 뒤 부족이 '기준 수요 보충 미확인' 조건으로 남는다. 금액·지급일은 묻지 않는다(이 시스템이 만든 발주가 아님)`] }, null);
      void r;
    }
    if (!p4()) await judgeChanged(null);
  });
  ctx.onReset(() => { cache = null; touch(); });

  // ── 조회(expose) ──
  const latestJudgments = ({ plan_id, sku_id, supply_judgment_id, latest_only = true } = {}) => {
    let rows = db.prepare('SELECT row_json FROM p2_judgment ORDER BY plan_id, supply_judgment_id, supply_judgment_version').all().map((r) => P(r.row_json));
    if (plan_id) rows = rows.filter((r) => r.plan_id === plan_id);
    if (sku_id) rows = rows.filter((r) => r.sku_id === sku_id);
    if (supply_judgment_id) rows = rows.filter((r) => r.supply_judgment_id === supply_judgment_id);
    if (latest_only) {
      const by = new Map();
      for (const r of rows) by.set(r.supply_judgment_id, r);
      rows = [...by.values()];
    }
    return rows;
  };
  const api = {
    grid: () => ({ first_week_start: C.FIRST_WEEK, horizon_end_week: C.HORIZON_END, projection_end_week: C.PROJECTION_END, weeks: [...C.WEEKS] }),
    inboundSchedule: ({ sku_id, inbound_schedule_version } = {}) => {
      const v = inbound_schedule_version ?? currentInbound().version;
      let rows = inboundRowsOf(v);
      if (sku_id) rows = rows.filter((r) => r.sku_id === sku_id);
      // 입고 완료·예정일 경과는 onDay의 processArrivals가 행에 기록한다
      return { inbound_schedule_version: v, rows: rows.map(({ record_id, ...r }) => ({ ...r, supply_status: C.supplyStatusOf(r), inbound_kind: C.rowKind(r) })) };
    },
    supplyProjectionBase: (f = {}) => projectionBaseRows(model(), f),
    residualHeadroom: (f = {}) => headroomRows(model(), f),
    baseOnlyShortfall: (f = {}) => baseOnlyRows(model(), f),
    latestSupplyJudgment: (planId) => {
      const plan = latestJudgmentRow(judgmentIdOf(planId));
      if (!plan) return null;
      return { plan, skus: latestJudgments({ plan_id: planId }).filter((r) => r.sku_id) };
    },
    supplyJudgments: (f = {}) => latestJudgments(f),
    planOrder: ({ sku_id } = {}) => {
      const m = model();
      return [...m.rank].filter(([pid]) => !sku_id || (m.planSku.get(pid) ?? []).includes(sku_id)).map(([pid, rank]) => {
        const d = m.demand.get(pid);
        return { plan_id: pid, sku_id: sku_id ?? null, plan_order_rank: rank, demand_input_version: d?.input.version ?? null,
          sale_start_week: d?.input.sale_start_week ?? null, sale_weeks: d?.input.sale_weeks ?? null, ordering_rule_version: C.ORDERING_RULE_VERSION };
      });
    },
    alternatives: (f = {}) => alternativesOf(f),
    alternativeSelections: ({ plan_id } = {}) => db.prepare('SELECT row_json FROM p2_selection ORDER BY rowid').all().map((r) => P(r.row_json))
      .filter((s) => s.alternative_selection && (!plan_id || s.plan_id === plan_id)).map((s) => s.alternative_selection),
    planChanges: ({ plan_id } = {}) => (plan_id ? planChangesOf(plan_id) : db.prepare('SELECT row_json FROM p2_plan_change ORDER BY plan_id, plan_version').all().map((r) => P(r.row_json))),
    poDrafts: ({ po_draft_id, plan_id, po_draft_status, latest_only = true } = {}) => (latest_only ? latestDrafts() : draftRows())
      .filter((d) => (!po_draft_id || d.po_draft_id === po_draft_id) && (!plan_id || d.linked_plan_ids.includes(plan_id)) && (!po_draft_status || d.po_draft_status === po_draft_status))
      .map(({ _state, ...d }) => d),
    supplyRequests: ({ plan_id, supply_request_id } = {}) => db.prepare('SELECT row_json FROM p2_supply_request ORDER BY supply_request_id').all().map((r) => P(r.row_json))
      .filter((q) => (!plan_id || q.plan_id === plan_id) && (!supply_request_id || q.supply_request_id === supply_request_id)),
    // 기준 수요 정기 보충 가정(S2-BLC). 이름은 (F) 때의 것을 그대로 두고 내용만 가정 행으로 바꿨다(수량 없음)
    // SCM 기준 수요 보충 계획 상태(SKU별). 수량은 SCM 회신 값, 금액·지급일 없음
    baselineReplenishment: (f = {}) => baselinePlanRows(f),
    applyBaselinePlan, applySupplyCommitment, applySupplyReplies, processArrivals,
    supplyCommitments: ({ target_id, sku_id, latest_only = true } = {}) => {
      let rows = db.prepare('SELECT target_id, row_json FROM p2_commitment ORDER BY target_id, reply_version, rowid').all().map((r) => (({ base_row, ...x }) => x)(P(r.row_json)));
      if (target_id) rows = rows.filter((r) => r.target_id === target_id);
      if (sku_id) rows = rows.filter((r) => r.sku_id === sku_id);
      if (latest_only) { const by = new Map(); for (const r of rows) by.set(r.target_id, r); rows = [...by.values()]; }
      return rows;
    },
    // 문제 4 순서표용: 승인된 발주안마다 받을 Corevia 회신과 도착 예정일
    pendingSupplyCommitments: () => dueCommitments().filter((x) => !x.applied),
    applyInboundReply, selectAlternative, applySupplierReply, deliverMock,
    planAlternatives, requestEarlySupply, applySupplierReplies,
    // 트리거 사건에 대해 문제 2가 이 기안을 이미 확인했는지. changed=false면 전제·결론이 그대로라 새 버전을 내지 않았다.
    judgmentCheck: ({ plan_id, trigger_event_id }) => {
      const r = db.prepare('SELECT * FROM p2_judge_check WHERE trigger_event_id = ? AND plan_id = ?').get(trigger_event_id, plan_id);
      return r ? { plan_id, trigger_event_id, checked: true, changed: r.changed === 1, supply_judgment_id: judgmentIdOf(plan_id), supply_judgment_version: r.supply_judgment_version }
        : { plan_id, trigger_event_id, checked: false, changed: null, supply_judgment_id: judgmentIdOf(plan_id), supply_judgment_version: null };
    },
  };
  // ── 평가자 화면용 사건 설명 카드(사용자 결정 2026-11-15) ──
  const judgmentAt = (planId, version) => {
    const rows = db.prepare('SELECT row_json FROM p2_judgment WHERE plan_id = ? AND supply_judgment_version = ?').all(planId, version).map((r) => P(r.row_json));
    return { plan: rows.find((r) => !r.sku_id) ?? null, skus: rows.filter((r) => r.sku_id) };
  };
  const draftAt = (id, v) => {
    const r = db.prepare('SELECT row_json FROM p2_po_draft WHERE po_draft_id = ? AND draft_version = ?').get(id, v);
    return r ? P(r.row_json) : null;
  };
  api.describeEvent = makeDescribe({
    id: ctx.id, event: (id) => ctx.events.get(id), judgmentAt, draftAt,
    alternatives: (ids) => ids.map((id) => alternativesOf({ alternative_id: id })[0]).filter(Boolean),
    sku: (id) => skuById.get(id), inventory: (id) => inventory.get(id), baselineOf: (id) => model().baseline.get(id),
    coverSummary: () => { const m = model(); const g = {}; for (const s of skus) (g[brStatusLabel(m, s.sku_id)] ??= []).push(s.sku_id.slice(4)); return Object.entries(g).map(([k, v]) => `${k} ${v.join('·')}`).join(', '); },
    commitment: (targetId) => latestCommitment(targetId),
  });

  // ── 기안 담당자 화면용: 판정 한 문장·이유와 대안 비교(사용자 결정 2026-11-15) ──
  // 대안을 골랐을 때의 예상 판정: 문제 1 미리보기 EA로 같은 판정 규칙을 돌린다(저장·사건 없음)
  function previewVerdict(m, planId, input) {
    const added = preview(m, planId, input);
    if (!added) return null;
    const startIdx = C.idxOfWeek(input.sale_start_week);
    const endIdx = startIdx + Number(input.sale_weeks) - 1;
    if (startIdx < 0) return null;
    const rows = (m.planSku.get(planId) ?? []).map((s) => {
      const sku = skuById.get(s);
      const r = C.judgeSku({ onHand: inventory.get(s).on_hand_qty, inboundRows: inboundOfSku(m, s), baseline: m.baseline.get(s),
        prevAdded: priorAdded(m, planId, s), ownAdded: added.get(s) ?? C.zeros(), saleStartIdx: startIdx, saleEndIdx: endIdx,
        safetyMin: sku.safety_stock_weeks_min, R: reachOf(m, s, planId, endIdx), noReorder: Boolean(blockOf(m, planId, s)), baselineCovered: brCovered(m, s) });
      return { sku_id: s, supply_verdict: r.verdict, condition_basis: r.condition_basis };
    });
    const worst = rows.reduce((w, r) => (SEVERITY[r.supply_verdict] > SEVERITY[w] ? r.supply_verdict : w), '가능');
    return { verdict: worst, label: verdictLabel(worst, rows.flatMap((r) => r.condition_basis)), conditions: worst === '조건부' ? rows.flatMap((r) => r.condition_basis.map((c) => ({ ...c, sku_id: r.sku_id }))) : [] };
  }
  // ── 권장 대안 순위(L4, 조정자 확정) ──
  // 점수: 가능 0 < 조건부(확정기한 전 풀릴 수 있음) 1 < 조건부(풀릴 근거 없음) 2 < 부족 3. 같으면 계획을 덜 바꾸는 쪽(구성이동 < 물량상한 < 시기이동).
  // 조건이 확정기한 전에 풀릴 수 있는가: 공급 확약 대기·보충 발주 필요는 회신·승인 일정이 확정기한 안이면, 미확정 입고는 그 기발주 회신이 확정기한 전에 올 예정이면.
  // 기준 수요 보충 미확인은 받을 회신이 없어 풀릴 근거가 없다.
  const CHANGE_RANK = { 구성이동: 1, 물량상한: 2, 시기이동: 3 };
  function outlookScore(m, planId, verdict, conditions) {
    if (verdict === '가능') return { score: 0, resolvable: true, why: '고르면 공급 쪽 조건이 없습니다' };
    if (verdict === '부족') return { score: 3, resolvable: false, why: '고르더라도 막을 수 없는 부족이 남습니다' };
    if (verdict !== '조건부') return { score: 4, resolvable: false, why: '판정할 수 없습니다' };
    const deadline = m.planById.get(planId)?.contract_deadline ?? null;
    const due = dueCommitments().filter((x) => !x.applied);
    const reasons = [];
    let worst = 1;
    for (const c of conditions) {
      let ok;
      let note;
      if (c.condition_type === 'baseline_replenishment_unconfirmed') { ok = false; note = `${c.sku_id} 기준 수요 보충 미확인(받을 회신 없음)`; }
      else if (c.condition_type === 'inbound_unconfirmed') {
        const next = due.filter((x) => (c.inbound_rows ?? []).some((r) => r.source_ref === x.record_id.replace(/^S2-CVC-|-\d+$/g, ''))).map((x) => x.due_date).sort()[0];
        ok = Boolean(next && deadline && next <= deadline); note = `${c.sku_id} 기발주 입고 회신 ${next ? `${next} 예정` : '예정 없음'}`;
      } else {
        // 공급 확약 대기·보충 발주 필요: 승인(약 7영업일)과 Corevia 회신(승인 + 3영업일)이 확정기한 안에 들어오는가
        const by = addBusinessDays(m.today, c.condition_type === 'reorder_required' ? 10 : 3);
        ok = Boolean(deadline && by <= deadline); note = `${c.sku_id} ${COND_NAME[c.condition_type]}(회신 예상 ${by})`;
      }
      if (!ok) worst = 2;
      reasons.push(`${note} → 확정기한 ${deadline ?? '-'} ${ok ? '전에 풀릴 수 있음' : '전에 풀릴 근거 없음'}`);
    }
    return { score: worst, resolvable: worst === 1, why: reasons.join('; ') };
  }
  const SCORE_LABEL = ['가능', '조건부(확정기한 전 풀릴 수 있음)', '조건부(풀릴 근거 없음)', '부족', '판정불가'];
  // 대안 하나를 골랐을 때의 예상 판정과 점수
  function alternativeOutlook(m, planId, a, j, skuRows) {
    const d = m.demand.get(planId);
    if (!a.feasible) return { expected_verdict: null, expected_note: null, score: null };
    if (d && CHANGE_RANK[a.alternative_type]) {
      const overrides = (p1()?.skuOverrides ? safe(() => p1().skuOverrides(d.input.demand_input_id, d.input.version), []) : []) ?? [];
      const ov = (cap = null) => overrides.map((o) => ({ sku_id: o.sku_id, override_uplift_pct: cap == null ? Number(o.override_uplift_pct) : Math.min(Number(o.override_uplift_pct), cap) }));
      const input = { sale_start_week: a.new_sale_start_week ?? d.input.sale_start_week, sale_weeks: a.new_sale_weeks ?? Number(d.input.sale_weeks),
        uplift_pct: a.alternative_type === '물량상한' ? a.new_uplift_pct : Number(d.input.uplift_pct),
        override_uplift_pct: a.alternative_type === '구성이동' ? a.new_override_uplift_pct : ov(a.alternative_type === '물량상한' ? a.new_uplift_pct : null) };
      const pv = previewVerdict(m, planId, input);
      if (!pv) return { expected_verdict: null, expected_note: '문제 1 미리보기를 얻지 못함', score: null };
      const o = outlookScore(m, planId, pv.verdict, pv.conditions);
      return { expected_verdict: pv.label, expected_note: pv.verdict === '조건부' ? '조건이 남습니다' : null, score: o.score, score_label: SCORE_LABEL[o.score], resolvable_before_deadline: o.resolvable, outlook_reason: o.why };
    }
    if (a.alternative_type === '보충발주') {
      const after = skuRows.map((r) => (r.sku_id === a.sku_id && r.supply_verdict === '조건부'
        && (r.condition_basis ?? []).every((c) => c.condition_type === 'reorder_required') ? { ...r, supply_verdict: '가능', condition_basis: [] } : r));
      const worst = after.reduce((w, r) => (SEVERITY[r.supply_verdict] > SEVERITY[w] ? r.supply_verdict : w), '가능');
      return { expected_verdict: verdictLabel(worst, after.flatMap((r) => r.condition_basis ?? [])), expected_note: '발주안이 승인되고 Corevia가 확약한다는 전제', score: null };
    }
    if (a.alternative_type === '조기분할요청') return { expected_verdict: null, expected_note: 'Corevia 회신 전에는 알 수 없습니다', score: null };
    if (a.alternative_type === '집행일이동') return { expected_verdict: verdictLabel(j.supply_verdict, j.condition_basis ?? []), expected_note: '공급 판정은 그대로이고 승인 경로가 바뀝니다(문제 3)', score: null };
    return { expected_verdict: null, expected_note: null, score: null };
  }
  // 권장: 마케팅이 고르는 계획 변경(시기·물량·구성) 가운데 점수가 가장 낮고, 지금 판정보다 나아지는 것. 같으면 덜 바꾸는 쪽.
  function recommendAlternative(m, planId, alts, j) {
    const skuRows = latestSkuRows(planId);
    const cur = outlookScore(m, planId, j.supply_verdict, j.condition_basis ?? []).score;
    const scored = alts.filter((a) => a.feasible && CHANGE_RANK[a.alternative_type]).map((a) => ({ a, o: alternativeOutlook(m, planId, a, j, skuRows) }))
      .filter((x) => x.o.score != null && x.o.score < cur)
      .sort((x, y) => x.o.score - y.o.score || CHANGE_RANK[x.a.alternative_type] - CHANGE_RANK[y.a.alternative_type]);
    const best = scored[0];
    if (!best) return null;
    return { alternative_id: best.a.alternative_id, alternative_type: best.a.alternative_type, new_sale_start_week: best.a.new_sale_start_week ?? null,
      new_uplift_pct: best.a.new_uplift_pct ?? null, expected_verdict: best.o.expected_verdict, score_label: best.o.score_label,
      resolvable_before_deadline: best.o.resolvable_before_deadline,
      reason: `고르면 예상 판정 ${best.o.expected_verdict}(${best.o.score_label}). ${best.o.outlook_reason}. 지금 판정(${SCORE_LABEL[cur]})보다 낫고, 같은 점수면 계획을 덜 바꾸는 쪽(구성 < 물량 < 시기)`,
      compared: scored.map((x) => ({ alternative_id: x.a.alternative_id, alternative_type: x.a.alternative_type, expected_verdict: x.o.expected_verdict, score_label: x.o.score_label })) };
  }
  const COND_NAME = { reorder_required: '보충 발주 필요', inbound_unconfirmed: '미확정 입고', supply_commitment_pending: '공급 확약 대기', baseline_replenishment_unconfirmed: '기준 수요 보충 미확인' };
  function conditionSentence(c) {
    const rows = (c.inbound_rows ?? []).map((x) => `${refName(x.source_ref)}(${x.eta_date}${x.overdue ? ' 예정일 경과·미확약' : ''})`).join(', ');
    switch (c.condition_type) {
      case 'reorder_required': return `${c.sku_id} ${c.needed_by_week} 주까지 ${Number(c.additional_reorder_qty_ea).toLocaleString('ko-KR')} EA 보충 발주(${c.po_draft_id ?? '발주안 준비 중'})가 ${c.order_deadline}까지 승인·발주되고 Corevia가 확약해야 합니다`;
      case 'supply_commitment_pending': return `${c.sku_id} 승인된 발주안 입고 ${rows}는 아직 예상일 뿐이라 Corevia 공급 확약(수량·납기) 회신이 와야 합니다`;
      case 'baseline_replenishment_unconfirmed': return c.reason === '보충 계획 미확약'
        ? `${c.sku_id} SCM 기준 수요 보충 입고 ${rows}가 Corevia 확약 전이라 예상일 뿐입니다`
        : `${c.sku_id} 판매 기간 뒤 ${c.first_week} 주부터 기존 수요 몫이 모자랄 수 있는데 SCM 기준 수요 보충 계획이 확인되지 않았습니다`;
      default: return `${c.sku_id} 입고 ${rows}가 확정돼야 합니다`;
    }
  }
  // 이 기안이 기다리는 회신(누가, 무엇을, 상태, 언제쯤)
  function waitingReplies(m, planId) {
    const out = [];
    const skuList = m.planSku.get(planId) ?? [];
    const due = dueCommitments();
    for (const d of latestDrafts().filter((x) => x.linked_plan_ids.includes(planId) && x.po_draft_status !== '취소')) {
      if (!isApproved(d)) {
        if (d.po_draft_status !== '반려') out.push({ from: '승인권자(문제 3 경로)', what: `발주안 ${d.po_draft_id} ${d.sku_id} ${d.order_qty.toLocaleString('ko-KR')} EA 승인`, status: '승인 대기', expected_by: d.planned_order_date });
        continue;
      }
      const c = latestCommitment(d.po_draft_id);
      if (c && c.validation_status === '정상' && c.reply_status !== '미확인') continue;
      const next = due.find((x) => x.po_draft_id === d.po_draft_id && !x.applied);
      out.push({ from: 'Corevia 공급 담당자', what: `발주안 ${d.po_draft_id} ${d.sku_id} 공급 확약(수량·납기·원료·생산)`,
        status: !c ? '회신 대기' : c.validation_status !== '정상' ? `회신 확인 필요(${c.validation_issues.join('; ')})` : '미확인 회신(원료·생산 확인 중)', expected_by: next?.due_date ?? null });
    }
    const j = latestJudgmentRow(judgmentIdOf(planId));
    for (const c of j?.condition_basis ?? []) {
      if (c.condition_type === 'inbound_unconfirmed') out.push({ from: 'SCM·Corevia', what: `${c.sku_id} 기존 입고 ${(c.inbound_rows ?? []).map((x) => refName(x.source_ref)).join(', ')} 확정`, status: '회신 대기', expected_by: null });
    }
    for (const s of skuList) {
      const st = brStatusLabel(m, s);
      if (st !== 'SCM 확인·Corevia 확약') out.push({ from: st === '미회신' || st === 'SCM 미확인' ? 'SCM' : 'Corevia(SCM 경유)', what: `${s} 기준 수요 보충 계획`, status: st, expected_by: null });
    }
    return out;
  }
  function nextActions(j, conds) {
    switch (j.supply_verdict) {
      case '가능': return ['공급 쪽 걸림돌은 없습니다. 승인 경로·확정기한을 확인하고 확정하세요.'];
      case '부족': return ['대안 비교에서 판매 시기·물량·구성 변경을 고르세요.', '실행할 대안이 없으면 확정기한 전에 철회를 검토하세요.'];
      case '판정불가': return ['증가율·판매 기간을 입력하세요.'];
      default: return [
        `기다리는 회신: ${[...new Set(conds.map((c) => COND_NAME[c.condition_type]))].join(', ')}.`,
        '확정기한 전에 확약이 오지 않으면 공급 위험을 안고 확정할지(승인권자 위험 수용, 문제 4) 대안으로 바꿀지 정하세요. 위험을 수용해도 공급 판정은 조건부로 남습니다.',
      ];
    }
  }
  function planDecision(planId) {
    const m = model();
    if (!m.planById.has(planId)) throw ctx.httpError(404, `기안이 없습니다: ${planId}`);
    const j = latestJudgmentRow(judgmentIdOf(planId));
    const d = m.demand.get(planId);
    if (!j) return { plan_id: planId, as_of: m.today, verdict: null, headline: '아직 공급 판정 전입니다.', reasons: [], conditions: [], alternatives: [] };
    const skuRows = latestSkuRows(planId);
    const ev = db.prepare('SELECT event_id FROM p2_judgment WHERE supply_judgment_id = ? AND supply_judgment_version = ?').get(j.supply_judgment_id, j.supply_judgment_version)?.event_id;
    const e = ev ? ctx.events.get(ev) : null;
    const cause = e?.caused_by ? ctx.events.get(e.caused_by) : null;
    const short = skuRows.filter((r) => r.supply_verdict === '부족');
    const conds = j.condition_basis ?? [];
    const headline = {
      가능: '공급 문제는 없습니다. 지금 수요 입력대로 진행해도 공급 쪽 걸림돌은 없습니다.',
      조건부: `조건이 채워지면 공급할 수 있습니다. ${conds.map(conditionSentence).join('. ')}.`,
      부족: `지금 수요 입력으로는 ${short.map((r) => `${r.sku_id} ${r.first_shortage_week} 주`).join(', ')}에 캠페인 물량이 모자라고, 지금 발주해도 제때 오지 않습니다. 판매 시기·물량·구성을 바꾸거나 기안을 접어야 합니다.`,
      판정불가: '수요 입력(증가율·판매 기간)이 없어 공급을 판단하지 못했습니다. 수요를 먼저 입력하세요.',
    }[j.supply_verdict];
    const pa = planAlternatives(planId);
    const chosen = new Set(db.prepare('SELECT alternative_id FROM p2_selection WHERE plan_id = ?').all(planId).map((r) => r.alternative_id));
    const alternatives = (pa?.alternatives ?? []).map((a) => {
      const o = alternativeOutlook(m, planId, a, j, skuRows);
      const prop = a.alternative_type === '집행일이동' ? settlementProposal(a) : null; // 고를 때와 같은 날짜를 제안
      const expected = o.expected_verdict;
      const note = o.expected_note;
      const byMkt = ['시기이동', '물량상한', '구성이동', '집행일이동'].includes(a.alternative_type);
      return {
        alternative_id: a.alternative_id, alternative_type: a.alternative_type, title: ALT_NAME[a.alternative_type] ?? a.alternative_type,
        what_changes: prop ? (prop.proposed_settlement_date ? `집행 예정일 → ${prop.proposed_settlement_date}(하회 구간 밖 첫 영업일 ${prop.next_outside_date} + 여유 1주)` : null) : (altBrief(a) || null),
        proposed_settlement_date: prop?.proposed_settlement_date ?? null, expected_verdict: expected, expected_note: note,
        score_label: o.score_label ?? null, resolvable_before_deadline: o.resolvable_before_deadline ?? null, outlook_reason: o.outlook_reason ?? null,
        recommend_reason: pa?.recommended?.alternative_id === a.alternative_id ? pa.recommended.reason : null,
        feasible: Boolean(a.feasible),
        why_not: a.feasible ? null : (a.alternative_type === '구성이동' ? '부족한 SKU를 낮춰도 같은 기안의 다른 SKU에 옮길 여유가 없습니다' : a.remaining_checks),
        remaining_checks: a.feasible ? a.remaining_checks : null,
        recommended: pa?.recommended?.alternative_id === a.alternative_id, selected: chosen.has(a.alternative_id),
        decided_by: byMkt ? '마케팅 기안 담당자' : 'SCM',
        select: a.feasible && !chosen.has(a.alternative_id) ? { method: 'POST', path: `/api/p2/alternatives/${a.alternative_id}/select`, body: { selected_by: byMkt ? 'MKT-LINE-OWNER' : 'SCM-PLANNER' } } : null,
      };
    });
    // 권장 → 실행 가능 → 나머지 순(같은 무리 안에서는 계산 순서)
    const order = (x) => (x.recommended ? 0 : x.feasible ? 1 : 2);
    const seq = (x) => Number(x.alternative_id.split('-').pop());
    alternatives.sort((x, y) => order(x) - order(y) || seq(x) - seq(y));
    return {
      plan_id: planId, as_of: m.today, supply_judgment_id: j.supply_judgment_id, supply_judgment_version: j.supply_judgment_version,
      judged_at: e?.occurred_at ?? null, judgment_due: j.judgment_due ?? null,
      verdict: j.supply_verdict, verdict_label: verdictLabel(j.supply_verdict, conds), headline,
      reasons: skuRows.map(skuReason),
      conditions: conds.map((c) => ({
        sku_id: c.sku_id, condition_type: c.condition_type, type: COND_NAME[c.condition_type] ?? c.condition_type, text: conditionSentence(c),
        waiting_on: { reorder_required: '발주안 승인(문제 3 경로) 뒤 Corevia 공급 확약', inbound_unconfirmed: 'SCM·Corevia 입고 확정 회신',
          supply_commitment_pending: 'Corevia 공급 회신(수량·납기 확약)', baseline_replenishment_unconfirmed: 'SCM 기준 수요 보충 계획 회신과 Corevia 확약' }[c.condition_type] ?? null,
        due: c.order_deadline ?? null, po_draft_id: c.po_draft_id ?? null, po_draft_status: c.po_draft_status ?? null,
      })),
      last_change: cause ? `${EVENT_NAME[cause.event_type] ?? cause.event_type} 반영(${cause.occurred_at})` : null,
      change_reason: e?.generation_reason ?? null,
      demand_input: d ? { version: d.input.version, uplift_pct: Number(d.input.uplift_pct), sale_start_week: d.input.sale_start_week, sale_weeks: Number(d.input.sale_weeks) } : null,
      alternatives, recommended_alternative_id: pa?.recommended?.alternative_id ?? null,
      waiting_replies: waitingReplies(m, planId),
      next_actions: nextActions(j, conds),
      background: {
        note: 'SCM 기준 수요 보충 계획은 회신으로 확인된 것만 재고 전개에 넣습니다. 그 정기 발주의 금액·지급일은 자료에 없어 현금 재전망에 들어가지 않습니다(한계).',
        baseline_plan: (m.planSku.get(planId) ?? []).map((s) => baselinePlanRow(m, s))
          .map((r) => ({ sku_id: r.sku_id, plan_status: r.plan_status, plan_qty_total: r.plan_qty_total, base_stockout_weeks_committed: r.base_stockout_weeks_committed })),
      },
    };
  }
  api.planDecision = planDecision;
  ctx.expose(api);

  // ── 요약·경로 ──
  ctx.addPlanSummary((planId) => {
    const j = latestJudgmentRow(judgmentIdOf(planId));
    if (!j) return { label: '공급 판정', value: model().ready ? '판정 전' : `문제 1 ${NOT_CONNECTED}`, source_type: '계산' };
    return { label: '공급 판정', value: `${j.supply_verdict} (v${j.supply_judgment_version})`, source_type: '계산', is_synthetic: false, is_simulation: j.is_simulation };
  });

  // 판정 버전 이력: 버전마다 결론(판정값·조건 종류·막힌 SKU)이 앞 버전과 달라졌는지 표시한다(화면은 바뀐 것만 먼저 보여준다)
  function judgmentHistory(planId) {
    const rows = db.prepare('SELECT row_json, event_id FROM p2_judgment WHERE supply_judgment_id = ? ORDER BY supply_judgment_version')
      .all(judgmentIdOf(planId)).map((r) => ({ ...P(r.row_json), event_id: r.event_id }));
    let prevKey = null;
    return rows.map((r) => {
      const conds = (r.condition_basis ?? []).map((c) => `${c.condition_type === 'reorder_required' ? '보충 발주 필요' : '미확정 입고'} ${c.sku_id}`);
      const key = J([r.supply_verdict, conds, (r.reorder_blocked ?? []).map((b) => b.sku_id)]);
      const ev = r.event_id ? ctx.events.get(r.event_id) : null;
      const cause = ev?.caused_by ? ctx.events.get(ev.caused_by) : null;
      const out = { supply_judgment_version: r.supply_judgment_version, supply_verdict: r.supply_verdict, conditions: conds,
        reorder_blocked: (r.reorder_blocked ?? []).map((b) => b.sku_id), occurred_at: ev?.occurred_at ?? null,
        cause_event_type: cause?.event_type ?? null, generation_reason: ev?.generation_reason ?? null, conclusion_changed: key !== prevKey };
      prevKey = key;
      return out;
    });
  }

  ctx.route('GET', '/grid', () => api.grid());
  ctx.route('GET', '/inbound', ({ query }) => api.inboundSchedule({ sku_id: query.get('sku_id') || undefined, inbound_schedule_version: query.get('version') || undefined }));
  ctx.route('GET', '/projection', ({ query }) => ({ rows: api.supplyProjectionBase({ sku_id: query.get('sku_id') || undefined, inbound_scenario: query.get('inbound_scenario') || undefined }) }));
  ctx.route('GET', '/plan/:plan_id', ({ params }) => {
    const planId = params.plan_id;
    const m = model();
    if (!m.planById.has(planId)) throw ctx.httpError(404, `기안이 없습니다: ${planId}`);
    const skuList = m.planSku.get(planId) ?? [];
    const d = m.demand.get(planId);
    const deadlines = p4()?.getDeadlineSchedule ? safe(() => p4().getDeadlineSchedule({ plan_id: planId })) : null;
    const commitment = p3()?.commitmentBySource ? safe(() => p3().commitmentBySource(planId)) : null;
    return {
      sim_clock: m.today, links: m.links, ready: m.ready, grid: api.grid(),
      demand_input: d ? { demand_input_id: d.input.demand_input_id, version: d.input.version, uplift_pct: d.input.uplift_pct,
        sale_start_week: d.input.sale_start_week, sale_weeks: d.input.sale_weeks, source_type: d.input.source_type, is_synthetic: d.input.is_synthetic } : null,
      judgment: api.latestSupplyJudgment(planId),
      skus: skuList.map((s) => ({ ...skuById.get(s), on_hand_qty: inventory.get(s).on_hand_qty, in_transit_qty: inventory.get(s).in_transit_qty,
        stock_cover_weeks: inventory.get(s).stock_cover_weeks, baseline_weekly_qty: m.baseline.get(s) ?? null, target_stock_weeks: targetWeeks.get(s) })),
      residual_headroom: api.residualHeadroom({ plan_id: planId }),
      base_only_shortfall: skuList.flatMap((s) => api.baseOnlyShortfall({ sku_id: s })),
      inbound: { inbound_schedule_version: m.inbound.version, rows: m.inbound.rows.filter((r) => skuList.includes(r.sku_id)) },
      // 지금 판정 버전의 대안만 보인다(집행일이동은 승인 거절에 걸린 것이라 판정 버전과 무관)
      alternatives: api.alternatives({ plan_id: planId }).filter((a) => a.alternative_type === '집행일이동'
        || a.supply_judgment_version === api.latestSupplyJudgment(planId)?.plan.supply_judgment_version), selections: db.prepare('SELECT row_json FROM p2_selection WHERE plan_id = ?').all(planId).map((r) => P(r.row_json)),
      plan_changes: planChangesOf(planId), po_drafts: latestDrafts().filter((x) => x.linked_plan_ids.includes(planId)
        || (api.latestSupplyJudgment(planId)?.plan.reorder_blocked ?? []).some((b) => b.po_draft_id === x.po_draft_id))
        .map(({ _state, ...x }) => ({ ...x, payment_due_date: _state.payment_due_date, approved: _state.approved })),
      supply_requests: api.supplyRequests({ plan_id: planId }),
      judgment_due: deadlines?.judgment_due ?? null, approval_status: commitment?.approval_status ?? null,
      judgment_history: judgmentHistory(planId),
      baseline_replenishment: skuList.map((s) => baselinePlanRow(m, s)),
      supply_commitments: skuList.flatMap((s) => api.supplyCommitments({ sku_id: s })),
      baseline_replenishment_request: db.prepare("SELECT request_id FROM p2_request WHERE request_topic = 'baseline_replenishment' ORDER BY rowid DESC LIMIT 1").get()?.request_id ?? null,
    };
  });
  ctx.route('POST', '/rejudge', async ({ body }) => {
    const ids = body.plan_id ? [body.plan_id] : ctx.plans().map((p) => p.plan_id);
    const out = [];
    for (const id of ids) { const ev = await judge(id, { force: Boolean(body.force) }); if (ev) out.push(ev.event_id); }
    return { emitted: out };
  });
  ctx.route('POST', '/inbound/apply', async ({ body }) => applyInboundReply({ record_ids: body.record_ids
    ?? etaIt.filter((r) => r.data_version === body.data_version).map((r) => r.record_id) }));
  ctx.route('POST', '/inbound/structure', async ({ body }) => structureInboundText(body));
  ctx.route('POST', '/inbound/confirm', async ({ body }) => confirmInbound(body));
  ctx.route('POST', '/alternatives/:alternative_id/select', async ({ params, body }) => selectAlternative({ ...body, alternative_id: params.alternative_id }));
  ctx.route('POST', '/supply-requests/:id/reply', async ({ params, body }) => applySupplierReply({ supply_request_id: params.id, record_id: body.record_id }));
  ctx.route('GET', '/plan/:plan_id/alternatives', ({ params }) => planAlternatives(params.plan_id));
  ctx.route('GET', '/plan/:plan_id/decision', ({ params }) => planDecision(params.plan_id));
  ctx.route('GET', '/supply-commitments', ({ query }) => ({ commitments: api.supplyCommitments({ target_id: query.get('target_id') || undefined, sku_id: query.get('sku_id') || undefined, latest_only: query.get('all') !== '1' }),
    pending: api.pendingSupplyCommitments() }));
  ctx.route('POST', '/supply-commitments/apply', async ({ body }) => applySupplyCommitment({ record_id: body.record_id, po_draft_id: body.po_draft_id ?? null }));
  ctx.route('GET', '/baseline-plan', () => ({ rows: baselinePlanRows() }));
  ctx.route('POST', '/baseline-plan/apply', async ({ body }) => applyBaselinePlan({ date: body.date ?? null, record_ids: body.record_ids ?? null }));
  ctx.route('GET', '/events/:event_id/describe', ({ params }) => {
    const e = ctx.events.get(params.event_id);
    if (!e) throw ctx.httpError(404, `사건이 없습니다: ${params.event_id}`);
    return { card: api.describeEvent(e) };
  });
  ctx.route('POST', '/plan/:plan_id/early-supply', async ({ params, body }) => ({ requests: await requestEarlySupply(params.plan_id, body) }));
  ctx.route('POST', '/plan/:plan_id/supplier-replies', async ({ params }) => ({ replies: await applySupplierReplies(params.plan_id) }));
  ctx.route('GET', '/mock', () => ({
    inbound_replies: etaIt.map((r) => ({ ...r, applied: Boolean(applied(r.record_id)) })),
    supply_replies_corevia: dueCommitments().map((x) => ({ ...x, reply_status: cvcRecords.find((r) => r.record_id === x.record_id)?.reply_status ?? null })),
    selections: mockSelections.map((r) => ({ ...r, applied: Boolean(applied(r.record_id)) })),
    supply_replies: supplyReplies.map((r) => ({ ...r, applied: Boolean(applied(r.record_id)) })),
    inbound_versions: db.prepare('SELECT * FROM p2_inbound_version ORDER BY n').all(),
  }));
}
