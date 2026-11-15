// 문제 4 모듈 통합 테스트. 문제 1~3은 각 명세 9절 expose 시그니처를 따르는 가짜 모듈로 대신한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../../app/main.mjs';
import { ROOT_DIR } from '../../app/core/paths.mjs';
import { addBusinessDays } from '../../app/core/calendar.mjs';

const quiet = { log() {}, error() {} };

const P1 = `
export function register(ctx) {
  const plans = ctx.plans();
  const skus = ctx.raw.load('02_masil/master/m_sku_ms.csv');
  const map = plans.flatMap((p) => skus.filter((s) => s.category === p.product_line).map((s) => ({ plan_id: p.plan_id, campaign_id: p.campaign_id, product_line: p.product_line, sku_id: s.sku_id, source_type: '원본도출' })));
  const valid = new Map();
  const replies = plans.filter((p) => p.plan_id !== 'PLAN-005').flatMap((p) => {
    const base = { plan_id: p.plan_id, reply_text: '증가율 20%, 07-20 주부터 4주', source_type: '모의회신', is_synthetic: true, scenario_id: 'BASE' };
    if (p.plan_id === 'PLAN-011') return [{ ...base, record_id: 'S1-' + p.plan_id + '-L', reply_pattern: 'late' }];
    const rows = [{ ...base, record_id: 'S1-' + p.plan_id, reply_pattern: 'on_time' }];
    if (p.plan_id === 'PLAN-014') rows.push({ ...base, record_id: 'S1-PLAN-014-R', reply_pattern: 'revised', reply_text: '증가율 40%로 정정' });
    return rows;
  });
  ctx.expose({
    planSkuMap: ({ plan_id, sku_id } = {}) => map.filter((r) => (!plan_id || r.plan_id === plan_id) && (!sku_id || r.sku_id === sku_id)),
    demandInput: (plan_id) => valid.get(plan_id) ?? null,
    mockDemandReplies: ({ plan_id } = {}) => replies.filter((r) => !plan_id || r.plan_id === plan_id),
  });
  ctx.events.on('INFO_REPLIED', async (e) => {
    if (!e.payload?.reply_pattern) return;
    const version = (valid.get(e.plan_id)?.version ?? 0) + 1;
    valid.set(e.plan_id, { demand_input_id: 'DI-' + e.plan_id, plan_id: e.plan_id, version, version_status: '유효', sale_start_week: '2026-07-20', sale_weeks: 4, uplift_pct: version === 1 ? 20 : 40 });
    await ctx.events.emit({ event_type: version === 1 ? 'DEMAND_INPUT_REGISTERED' : 'DEMAND_INPUT_REVISED', source_type: '사람입력', is_synthetic: true, plan_id: e.plan_id, caused_by: e.event_id, payload: { demand_input_id: 'DI-' + e.plan_id, version } });
  });
}`;

const P2 = `
export function register(ctx) {
  const hist = new Map();
  const committed = new Set();
  const p1 = () => ctx.module('p1');
  const judge = async (plan_id, caused_by) => {
    const h = hist.get(plan_id) ?? [];
    const has = Boolean(p1()?.demandInput(plan_id));
    const j = { supply_judgment_id: 'SJ-' + plan_id, supply_judgment_version: h.length + 1, plan_id, supply_verdict: has ? (['PLAN-011', 'PLAN-008', 'PLAN-009'].includes(plan_id) || (globalThis.P14_SHORT && plan_id === 'PLAN-014' && p1().demandInput(plan_id).version === 2) ? '부족' : '가능') : '판정불가', first_shortage_week: plan_id === 'PLAN-011' && has ? '2026-08-03' : null };
    // 공급 확약 변형(사용자 요청 2026-11-15): 지정 기안은 Corevia·SCM 회신이 올 때까지 조건부(공급 미확약)
    const sup = globalThis.P4_SUPPLY?.[plan_id];
    if (has && sup && !committed.has(plan_id)) Object.assign(j, { supply_verdict: '조건부', condition_basis: [{ condition_type: sup, sku_id: 'SKU-T' }] });
    hist.set(plan_id, [...h, j]);
    await ctx.events.emit({ event_type: 'SUPPLY_JUDGED', source_type: '계산', is_simulation: has, plan_id, caused_by, payload: { ...j, previous_supply_judgment_version: h.length || null } });
  };
  ctx.expose({
    latestSupplyJudgment: (plan_id) => (hist.get(plan_id)?.length ? { plan: hist.get(plan_id).at(-1), skus: [] } : null),
    supplyJudgments: ({ supply_judgment_id }) => [...hist.values()].flat().filter((j) => j.supply_judgment_id === supply_judgment_id),
    planOrder: ({ sku_id }) => {
      const plans = new Map(ctx.plans().map((p) => [p.plan_id, p]));
      return p1().planSkuMap({ sku_id }).map((r) => plans.get(r.plan_id))
        .sort((a, b) => (a.contract_deadline + a.settlement_date + a.plan_id).localeCompare(b.contract_deadline + b.settlement_date + b.plan_id))
        .map((p, i) => ({ plan_id: p.plan_id, sku_id, plan_order_rank: i + 1, ...(p1().demandInput(p.plan_id) ?? {}) }));
    },
    alternatives: () => [],
    judgmentCheck: ({ plan_id, trigger_event_id }) => ({ plan_id, trigger_event_id, checked: ctx.events.get(trigger_event_id)?.event_type === 'PLAN_CONFIRMED', changed: false,
      supply_judgment_id: 'SJ-' + plan_id, supply_judgment_version: (hist.get(plan_id) ?? []).length }),
    planAlternatives: (plan_id) => ({ plan_id, recommended: plan_id === 'PLAN-009' ? { alternative_id: 'ALT-009', alternative_type: '시기이동', new_sale_start_week: '2026-09-07' } : null }),
    selectAlternative: async ({ alternative_id, generation_reason, is_mock }) => {
      const e = await ctx.events.emit({ event_type: 'ALTERNATIVE_SELECTED', source_type: '사람입력', is_synthetic: is_mock, plan_id: 'PLAN-009', generation_reason, payload: { alternative_id, alternative_type: '시기이동' } });
      return { event_id: e.event_id };
    },
    poDrafts: () => [],
    // 테스트용: Corevia 공급 확약 회신(가능)과 SCM 보충 계획 회신
    deliverCommitment: async (plan_id) => {
      committed.add(plan_id);
      const e = await ctx.events.emit({ event_type: 'SUPPLIER_REPLIED', source_type: '모의회신', is_synthetic: true, plan_id, actor_dept: 'COREVIA',
        payload: { supply_commitment: { supply_commitment_id: 'SC-T-' + plan_id, sku_id: 'SKU-T', linked_plan_ids: [plan_id], reply_status: '가능', validation_status: '정상', committed_qty: 100, uncommitted_qty: 0 } } });
      await judge(plan_id, e.event_id);
      return e;
    },
    deliverBaseline: async (skus) => ctx.events.emit({ event_type: 'INBOUND_SCHEDULE_REVISED', source_type: '모의회신', is_synthetic: true, actor_dept: 'SCM',
      payload: { inbound_schedule_version: 'IS-BR', changed_rows: [], baseline_replenishment: skus.map((sku_id) => ({ sku_id, plan_status: 'SCM 확인' })) } }),
    applyInboundReply: async ({ version }) => {
      const e = await ctx.events.emit({ event_type: 'INBOUND_SCHEDULE_REVISED', source_type: '모의회신', is_synthetic: true, payload: { inbound_schedule_version: version, changed_rows: [] } });
      return { event_id: e.event_id, inbound_schedule_version: version };
    },
  });
  ctx.events.on('PLAN_RECEIVED', (e) => judge(e.plan_id, e.event_id));
  ctx.events.on(['DEMAND_INPUT_REGISTERED', 'DEMAND_INPUT_REVISED'], (e) => judge(e.plan_id, e.event_id));
  ctx.events.on('REVIEW_OPENED', (e) => (e.payload?.target_type === 'supply_judgment' && e.payload.rejudge !== false ? judge(e.plan_id, e.event_id) : null));
}`;

const P3 = `
const GRP = new Set(['PLAN-001','PLAN-002','PLAN-003','PLAN-008','PLAN-009','PLAN-010','PLAN-015','PLAN-016','PLAN-017','PLAN-021','PLAN-022','PLAN-023']);
export function register(ctx) {
  const cs = new Map();
  const reqs = [];
  ctx.expose({
    commitment: (id) => cs.get(id) ?? null,
    commitmentBySource: (src) => [...cs.values()].find((c) => c.source_id === src) ?? null,
    listCommitments: (f = {}) => [...cs.values()].filter((c) => (!f.approval_status || c.approval_status === f.approval_status) && (!f.commitment_type || c.commitment_type === f.commitment_type)),
    approverRole: (a) => ({ approver: a, std_approval_bd: globalThis.P4_LATE_UP && a === 'GRP_CEO' ? 4 : a === 'GRP_CEO' || a === 'MS_CEO' ? 2 : 1 }),
    approvalRequest: (id) => reqs.find((r) => r.approval_request_id === id) ?? null,
    approvalRequestsFor: (cid) => reqs.filter((r) => r.commitment_ids.includes(cid)),
    submitApproval: async ({ commitment_ids }) => {
      if (globalThis.P4_NO_RESUB && commitment_ids.includes('C-PLAN-004') && cs.get('C-PLAN-004').approver === 'GRP_CEO') throw new Error('재상신 불가(테스트)');
      for (const r of reqs) { // 건별 대체(조정자 확정 (C)-4)
        const hit = r.commitment_ids.filter((c) => commitment_ids.includes(c));
        if (!hit.length) continue;
        r.superseded_commitment_ids = [...new Set([...(r.superseded_commitment_ids ?? []), ...hit])];
        r.superseded = r.superseded_commitment_ids.length === r.commitment_ids.length;
      }
      const c0 = cs.get(commitment_ids[0]);
      const r = { approval_request_id: 'AR-' + (reqs.length + 1), commitment_ids, approver: c0.approver, superseded: false };
      reqs.push(r);
      for (const id of commitment_ids) cs.get(id).approval_status = '결재 대기';
      await ctx.events.emit({ event_type: 'APPROVAL_SUBMITTED', source_type: '사람입력', is_synthetic: true, plan_id: commitment_ids.length === 1 ? cs.get(commitment_ids[0]).plan_id : 'NONE', payload: r });
      return r;
    },
    applyFinanceReply: async (id) => {
      if (id === 'S3-05') {
        const ar = await ctx.events.emit({ event_type: 'AR_DATE_REVISED', source_type: '모의회신', is_synthetic: true, scenario_id: 'S-AR-DELAY', payload: { ar_id: 'MAR-0004', ar_expected_receipt_date: '2026-08-30' } });
        const w = await ctx.events.emit({ event_type: 'CASH_WINDOW_REVISED', source_type: '계산', is_simulation: true, scenario_id: 'S-AR-DELAY', caused_by: ar.event_id,
          payload: { window_version: 'W-AR', scenario_id: 'S-AR-DELAY', shortfall_window_start: '2026-07-21', shortfall_window_end: '2026-08-28',
            ...(globalThis.P4_RECHECK ? { recheck_summary: { rechecked: cs.size, kept: cs.size - 2, changed: 2, kept_rationale: '승인권자·승인 기준일·구간 안팎이 같아 새 판정을 내지 않음',
              changed_commitments: [{ commitment_id: 'C-PLAN-004', plan_id: 'PLAN-004' }, { commitment_id: 'C-PLAN-024', plan_id: 'PLAN-024' }],
              kept_commitment_ids: [...cs.keys()].filter((k) => !['C-PLAN-004', 'C-PLAN-024'].includes(k)) } } : {}) } });
        for (const pid of ['PLAN-004', 'PLAN-024']) {
          const c = cs.get('C-' + pid);
          c.approver = 'GRP_CEO';
          if (c.approval_status === '결재 대기') c.approval_status = '미상신';
          await ctx.events.emit({ event_type: 'ROUTE_JUDGED', source_type: '계산', plan_id: pid, caused_by: w.event_id,
            payload: { route_judgment_id: 'RJ-' + pid + '-AR', commitment_id: c.commitment_id, commitment_type: '기안', plan_id: pid, approver: 'GRP_CEO', std_approval_bd: 2, approval_anchor_date: c.approval_anchor_date, anchor_basis: c.anchor_basis, route_changed: true } });
        }
        return { window_version: 'W-AR' };
      }
      for (const c of cs.values()) c.finance_confirmation_status = '확인됨';
      const f = await ctx.events.emit({ event_type: 'FINANCE_CONFIRMED', source_type: '모의회신', is_synthetic: true, payload: { finance_reply_id: id } });
      await ctx.events.emit({ event_type: 'CASH_WINDOW_REVISED', source_type: '계산', is_simulation: true, caused_by: f.event_id,
        payload: { window_version: 'W-2', scenario_id: 'BASE', shortfall_window_start: '2026-07-21', shortfall_window_end: '2026-08-21' } });
      return { window_version: 'W-2' };
    },
  });
  ctx.onInit(() => ctx.events.emit({ event_type: 'CASH_WINDOW_REVISED', source_type: '계산',
    payload: { window_version: 'W-1', scenario_id: 'BASE', shortfall_window_start: '2026-07-21', shortfall_window_end: '2026-08-21' } }));
  // 승인 뒤 구간이 늘어 경로가 오르고, 재승인이 확정기한 뒤에 오는 경우(조정자 마지막 조정 (나)의 PLAN-004 경위)
  if (globalThis.P4_LATE_UP) ctx.clock.onDay(async (D) => {
    if (D !== '2026-07-14') return;
    const c = cs.get('C-PLAN-004');
    c.approver = 'GRP_CEO';
    c.approval_status = '미상신';
    await ctx.events.emit({ event_type: 'CASH_WINDOW_REVISED', source_type: '계산', is_simulation: true,
      payload: { window_version: 'W-UP', scenario_id: 'BASE', shortfall_window_start: '2026-07-21', shortfall_window_end: '2026-08-28' } });
  });
  if (globalThis.P4_PO) {
    // 실제 문제 3처럼 순서표 행의 target으로 발주안 약정(CMT-<po_draft_id>)을 찾아 상신한다
    // 승인 가정 최저 잔액: globalThis.P4_IMPACT[commitment_id] (없으면 1억)
    Object.assign(ctx.module('p3'), { approvalImpact: ({ commitment_id }) => {
      const after = (globalThis.P4_IMPACT ?? {})[commitment_id] ?? 1e8;
      return { commitment_ids: [commitment_id], window_version: 'W-1', scenario_id: 'BASE', threshold: 3e9,
        before: { shortfall_window_start: '2026-07-21', shortfall_window_end: '2026-08-21', min_balance_krw: after + 2e8, min_date: '2026-09-21' },
        after: { shortfall_window_start: '2026-07-21', shortfall_window_end: '2026-08-28', min_balance_krw: after, min_date: '2026-09-21' },
        min_balance_delta_krw: -2e8, after_below_zero: after < 0, added_outflows: [{ po_draft_id: 'POD-T1', payment_due_date: '2026-08-21', amount_krw: 2e8 }], notes: [] };
    } });
    Object.assign(ctx.module('p3'), { deliverMock: async (mockId) => {
      const row = ctx.module('p4').getMockSchedule({ owner: 'p3' }).find((x) => x.mock_id === mockId);
      if (row.event_type !== 'APPROVAL_SUBMITTED') return { skipped: '재무 행' };
      const c = String(mockId).startsWith('M04:PO:') ? cs.get('CMT-' + row.target) : cs.get('C-' + row.plan_id);
      if (!c) return { skipped: '순서표 target의 발주안이 없음(' + row.target + ')' };
      return { approval_request: await ctx.module('p3').submitApproval({ commitment_ids: [c.commitment_id] }) };
    } });
    ctx.onInit(async () => {
      const c = { commitment_id: 'CMT-POD-T1', commitment_type: '발주안', source_id: 'POD-T1', plan_id: 'NONE', approver: globalThis.P4_PO_APPROVER ?? 'GRP_CEO', std_approval_bd: 2,
        approval_anchor_date: '2026-07-16', anchor_basis: 'planned_order_date', approval_status: '미상신', finance_confirmation_status: '재무확인대기', cash_outflow_date: '2026-08-21' };
      cs.set(c.commitment_id, c);
      if (globalThis.P4_PO_PAY) await ctx.events.emit({ event_type: 'PAYMENT_DATE_SET', source_type: '계산', plan_id: 'NONE', payload: { po_draft_id: 'POD-T1', payment_due_date: '2026-08-21' } }); // 최초(경로 판정 전)
      await ctx.events.emit({ event_type: 'ROUTE_JUDGED', source_type: '계산', plan_id: 'NONE',
        payload: { route_judgment_id: 'RJ-POD-T1', commitment_id: c.commitment_id, commitment_type: '발주안', plan_id: 'NONE', approver: c.approver, std_approval_bd: 2, approval_anchor_date: c.approval_anchor_date, anchor_basis: c.anchor_basis } });
      if (globalThis.P4_PO_PAY) { // 실제 문제 3처럼: 지급일을 다시 내도 결론이 같으면 ROUTE_JUDGED를 내지 않는다
        c.route_judgment_id = 'RJ-POD-T1';
        await ctx.events.emit({ event_type: 'PAYMENT_DATE_SET', source_type: '계산', plan_id: 'NONE', payload: { po_draft_id: 'POD-T1', payment_due_date: '2026-08-21' } });
        await ctx.events.emit({ event_type: 'PAYMENT_DATE_SET', source_type: '계산', plan_id: 'NONE', payload: { po_draft_id: 'POD-T1', payment_due_date: '2026-09-21' } });
      }
      if (globalThis.P4_PO_CANCEL) await ctx.events.emit({ event_type: 'PO_DRAFT_CANCELLED', source_type: '계산', plan_id: 'NONE', payload: { po_draft_id: 'POD-T1', draft_version: 1, cancel_reason: '보충 발주 필요 조건 해소' } });
    });
  }
  ctx.events.on('REVIEW_OPENED', async (e) => {
    if (e.payload?.target_type !== 'route_judgment' || e.payload.rejudge === false || globalThis.P4_RECHECK || globalThis.P4_PO_PAY) return; // 실제 문제 3은 재대조 요약만 내고 결론 같은 약정엔 ROUTE_JUDGED를 내지 않는다
    const c = [...cs.values()].find((x) => x.plan_id === e.plan_id);
    if (c) await ctx.events.emit({ event_type: 'ROUTE_JUDGED', source_type: '계산', plan_id: c.plan_id, caused_by: e.event_id,
      payload: { route_judgment_id: 'RJ-' + c.plan_id + '-' + e.event_id, commitment_id: c.commitment_id, commitment_type: '기안', plan_id: c.plan_id, approver: c.approver, std_approval_bd: 2, approval_anchor_date: c.approval_anchor_date, anchor_basis: c.anchor_basis, route_changed: false } });
  });
  ctx.events.on('PLAN_RECEIVED', async (e) => {
    const p = ctx.plans().find((x) => x.plan_id === e.plan_id);
    const anchor = p.settlement_date < p.contract_deadline ? p.settlement_date : p.contract_deadline;
    const approver = GRP.has(p.plan_id) ? 'GRP_CEO' : 'MS_CEO';
    const c = { commitment_id: 'C-' + p.plan_id, commitment_type: '기안', source_id: p.plan_id, plan_id: p.plan_id, approver, std_approval_bd: 2, approval_anchor_date: anchor,
      anchor_basis: p.settlement_date < p.contract_deadline ? 'settlement_date' : 'contract_deadline', approval_status: '미상신', finance_confirmation_status: '재무확인대기',
      group_report_required: approver === 'MS_CEO', cash_outflow_date: p.settlement_date };
    cs.set(c.commitment_id, c);
    await ctx.events.emit({ event_type: 'ROUTE_JUDGED', source_type: '계산', plan_id: p.plan_id, caused_by: e.event_id,
      payload: { route_judgment_id: 'RJ-' + p.plan_id, commitment_id: c.commitment_id, commitment_type: '기안', plan_id: p.plan_id, approver, std_approval_bd: 2, approval_anchor_date: anchor, anchor_basis: c.anchor_basis } });
  });
  ctx.events.on('APPROVAL_REPLIED', (e) => { const c = cs.get(e.payload.commitment_id); if (c) c.approval_status = e.payload.decision; });
}`;

// 이 파일의 흐름 테스트는 사건 순서표의 모의 입력으로 도는 기존 시연을 검증한다. 기본 '직접 처리'(PLAN-001~003)를 끄고 모두 자동으로 둔다.
function allAuto(app) {
  const p4 = app.module('p4');
  for (const id of p4.listDirectPlans()) p4.setDirectPlan(id, false);
  return app;
}

function makeRoot({ withOthers }) {
  const root = mkdtempSync(path.join(tmpdir(), 'w01-p4-'));
  cpSync(path.join(ROOT_DIR, 'problem4', 'src'), path.join(root, 'problem4', 'src'), { recursive: true });
  cpSync(path.join(ROOT_DIR, 'problem4', 'data'), path.join(root, 'problem4', 'data'), { recursive: true });
  if (withOthers) {
    for (const [n, src] of [[1, P1], [2, P2], [3, P3]]) {
      mkdirSync(path.join(root, `problem${n}`, 'src'), { recursive: true });
      writeFileSync(path.join(root, `problem${n}`, 'src', 'index.mjs'), src);
    }
  }
  return root;
}

test('다른 모듈이 없어도 초기 사건을 내고 죽지 않는다', async () => {
  const root = makeRoot({ withOthers: false });
  const app = allAuto(await createApp({ rootDir: root, dbPath: ':memory:', env: {}, log: quiet }));
  try {
    const count = (t) => app.events.query({ event_type: t }).length;
    assert.equal(count('PLAN_RECEIVED'), 25);
    assert.equal(count('OPEN_ISSUE_RAISED'), 3);
    assert.equal(count('DEADLINES_SET'), 0);
    const p4 = app.module('p4');
    assert.equal(p4.getPlanState('PLAN-002').plan_confirmability, '미확인');
    assert.match(p4.getPlanState('PLAN-002').confirmability_basis.reason, /연결 안 됨/);
    assert.equal(p4.listInfoRequests({ request_topic: 'demand_input' }).length, 25);
    await app.clock.advance({ to: '2026-07-20' });
    assert.equal(p4.getPlanState('PLAN-005').plan_status, '기한 경과 확정');
    assert.equal(app.events.errors.length, 0);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('07-01~07-20: 마감·요청·경고·승인 회신·확정·기한 경과 확정·미결', async () => {
  const root = makeRoot({ withOthers: true });
  const app = allAuto(await createApp({ rootDir: root, dbPath: ':memory:', env: {}, log: quiet }));
  const p4 = app.module('p4');
  const ev = (t, f = {}) => app.events.query({ event_type: t, ...f });
  try {
    // 07-01 초기
    assert.equal(ev('PLAN_RECEIVED').length, 25);
    assert.equal(ev('PLAN_RECEIVED')[0].occurred_at, '미상');
    assert.equal(ev('DEADLINES_SET').length, 25);
    assert.deepEqual(p4.getDeadlineSchedule({ plan_id: 'PLAN-002' }), {
      commitment_id: 'C-PLAN-002', plan_id: 'PLAN-002', approval_anchor_date: '2026-07-17', anchor_basis: 'contract_deadline', approver: 'GRP_CEO',
      std_approval_bd: 2, demand_input_due: '2026-07-07', judgment_due: '2026-07-08', submission_due: '2026-07-09', first_reply_due: '2026-07-13',
      alt_selection_due: '2026-07-14', final_reply_due: '2026-07-16', deadline_rule_version: 'S4-01/v1+C10', computed_status: '정상' });
    assert.equal(p4.getDeadlineSchedule({ plan_id: 'PLAN-014' }).submission_due, '2026-07-10');
    assert.equal(p4.getInfoRequest(p4.listInfoRequests({ plan_id: 'PLAN-002', request_topic: 'demand_input' })[0].request_id).request_due_date, '2026-07-07');
    assert.equal(p4.listInfoRequests({ request_topic: 'finance_confirmation' })[0].request_due_date, '2026-07-08');
    assert.equal(p4.listOpenIssues().filter((i) => i.issue_status === '종결').map((i) => i.issue_id).join(), 'OI-1,OI-2');
    assert.equal(p4.listPlanStates().filter((s) => s.default_mock_input).length, 18);

    await app.clock.advance({ to: '2026-07-20' });
    assert.equal(app.events.errors.length, 0, JSON.stringify(app.events.errors));

    // 재무 확인(07-07)으로 요청 회신됨
    assert.equal(p4.listInfoRequests({ request_topic: 'finance_confirmation' })[0].request_status, '회신됨');
    // PLAN-005: W1(07-08, 효력 07-07) → 재요청, 조건부 회신, W5(07-16), 07-17 경과 확정(07-20 발생)
    const w1 = p4.listWarnings({ plan_id: 'PLAN-005', warning_rule: 'W1' })[0];
    assert.equal(w1.occurred_at, '2026-07-08');
    assert.equal(w1.due_date, '2026-07-07');
    assert.equal(p4.listInfoRequests({ plan_id: 'PLAN-005', request_topic: 'demand_input' }).map((r) => `${r.request_kind}:${r.request_status}`).join(), 'initial:이관,rerequest:기한 경과');
    assert.equal(p4.listWarnings({ plan_id: 'PLAN-005', warning_rule: 'W5' })[0].occurred_at, '2026-07-16');
    const auto = ev('PLAN_AUTO_CONFIRMED_BY_DEADLINE', { plan_id: 'PLAN-005' })[0];
    assert.equal(auto.occurred_at, '2026-07-20');
    assert.equal(auto.effective_at, '2026-07-17');
    assert.equal(auto.payload.last_approval_status, '조건부');
    // 07-13 1차 승인 회신: 기준일 07-17 그룹 6건(PLAN-001~005, 007), PLAN-003 거절·PLAN-005 조건부
    const replies13 = ev('APPROVAL_REPLIED').filter((e) => e.occurred_at === '2026-07-13');
    assert.deepEqual(replies13.map((e) => e.plan_id).sort(), ['PLAN-001', 'PLAN-002', 'PLAN-003', 'PLAN-004', 'PLAN-005', 'PLAN-007']);
    assert.equal(replies13.find((e) => e.plan_id === 'PLAN-003').payload.decision, '거절');
    assert.equal(replies13.find((e) => e.plan_id === 'PLAN-005').payload.decision, '조건부');
    assert.equal(replies13[0].source_type, '모의회신');
    // PLAN-002: 확정 가능(07-13) → 다음 영업일 확정(07-14)
    assert.equal(ev('PLAN_CONFIRMED', { plan_id: 'PLAN-002' })[0].occurred_at, '2026-07-14');
    assert.equal(p4.getPlanState('PLAN-002').plan_status, '확정');
    // PLAN-003: 거절 → 불가 → 대안 없음(가짜 문제 2) → W5 → 기한 경과 확정
    assert.ok(ev('PLAN_CONFIRMABILITY_CHANGED', { plan_id: 'PLAN-003' }).some((e) => e.payload.current === '불가'));
    assert.equal(p4.getPlanState('PLAN-003').plan_status, '기한 경과 확정');
    // MS_CEO 승인 → 그룹 보고 요청
    assert.ok(p4.listInfoRequests({ request_topic: 'group_report', plan_id: 'PLAN-004' }).length >= 1);
    // OI-3: 회신 없음 → 07-08 기한 경과(W7, 07-09) → 후속 재검토
    const oi3 = p4.listInfoRequests({ request_topic: 'group_allocation' })[0];
    assert.equal(oi3.request_status, '기한 경과');
    assert.equal(p4.listWarnings({ request_id: oi3.request_id })[0].occurred_at, '2026-07-09');
    assert.equal(p4.listReviews({ target_type: 'info_request', target_id: oi3.request_id })[0].review_kind, '기한 경과 후속');
    // PLAN-014 정정(07-13): 자기 판정 재검토(유지)와 같은 SKU 뒤 순서 기안 재검토
    const rv14 = p4.listReviews({ plan_id: 'PLAN-014', target_type: 'supply_judgment' });
    assert.equal(rv14[0].review_status, '종결');
    assert.equal(rv14[0].outcome, '유지');
    // (F)-3: 유지 근거에 직전·새 판정 버전의 결론을 함께 남긴다
    assert.match(rv14[0].rationale, /다시 판정\(v\d+ (\S+) → v\d+ \1\)\. 결론 같음$/);
    const trig = ev('DEMAND_INPUT_REVISED', { plan_id: 'PLAN-014' })[0].event_id;
    assert.ok(p4.listReviews({}).filter((r) => r.trigger_event_id === trig).length > 1);
    // 사건 순서표: M03(07-07) 완료, M05(S-AR-DELAY)는 꺼짐
    const sched = Object.fromEntries(p4.getMockSchedule().map((r) => [r.mock_id, r]));
    assert.equal(sched.M03.status, '완료');
    assert.equal(sched.M05.status, '시나리오 꺼짐');
    assert.equal(sched['M02:PLAN-002'].sim_date, '2026-07-07');
    // (D) 2차-가: judgmentCheck가 '확인함·변경 없음'이면 REVIEW_OPENED 없이 '유지'로 기록
    const conf2 = ev('PLAN_CONFIRMED', { plan_id: 'PLAN-002' })[0].event_id;
    const byConf = p4.listReviews({}).filter((r) => r.trigger_event_id === conf2);
    assert.ok(byConf.length > 0);
    assert.ok(byConf.every((r) => r.review_status === '종결' && r.outcome === '유지' && /judgmentCheck/.test(r.rationale)));
    assert.equal(ev('REVIEW_OPENED').filter((e) => e.caused_by === conf2).length, 0);
    // (D) 2차-다: 재무 확인(변경 입력)에도 구간이 그대로면 cash_window 재검토를 '유지'로 닫고 근거를 남긴다
    const kept = p4.listReviews({ target_type: 'cash_window' })[0];
    assert.equal(kept.outcome, '유지');
    assert.deepEqual([kept.before.shortfall_window_start, kept.before.shortfall_window_end], [kept.after.shortfall_window_start, kept.after.shortfall_window_end]);
    assert.ok(kept.after.approvers.some((a) => a.plan_id === 'PLAN-002' && a.approver === 'GRP_CEO'));
    assert.match(kept.rationale, /FINANCE_CONFIRMED에도 하회 구간 2026-07-21~2026-08-21/);
    assert.equal(ev('REVIEW_CLOSED').filter((e) => e.payload.review_id === kept.review_id).length, 1);
    // 문제 3 행: 재무 확인·회수일 지연·상신(약정별·회차별)에 event_type·scenario_id·target (조정자 확정 (C)-라)
    const p3rows = p4.getMockSchedule({ owner: 'p3' });
    assert.equal(p3rows.find((r) => r.mock_id === 'M03').event_type, 'FINANCE_CONFIRMED');
    assert.equal(p3rows.find((r) => r.mock_id === 'M05').event_type, 'AR_DATE_REVISED');
    assert.equal(p3rows.find((r) => r.mock_id === 'M05').scenario_id, 'S-AR-DELAY');
    const sub2 = p3rows.find((r) => r.mock_id === 'M04:PLAN-002:1');
    assert.deepEqual([sub2.event_type, sub2.sim_date, sub2.target, sub2.scenario_id], ['APPROVAL_SUBMITTED', '2026-07-09', '기안 PLAN-002', 'BASE']);
    assert.match(sub2.status, /^완료/); // PLAN-001과 같은 승인권자·같은 상신 마감이라 한 묶음으로 나간다
    // 수요 요청 INFO_REQUESTED payload에 request_id (조정자 확정 (C)-다)
    const dreq = ev('INFO_REQUESTED', { plan_id: 'PLAN-002' })[0];
    assert.equal(dreq.payload.request_id, dreq.subject_id);
    assert.equal(dreq.payload.request_topic, 'demand_input');
    // 경로 하향(GRP_CEO → MS_CEO)이면 승인을 유지하고 재상신하지 않는다(조정자 확정 (C)-3)
    await app.clock.advance({ to: '2026-07-22' });
    const c8 = app.module('p3').commitment('C-PLAN-008');
    assert.equal(c8.approval_status, '승인');
    c8.approver = 'MS_CEO';
    await app.events.emit({ event_type: 'ROUTE_JUDGED', source_type: '계산', plan_id: 'PLAN-008',
      payload: { route_judgment_id: 'RJ-PLAN-008-DOWN', commitment_id: 'C-PLAN-008', commitment_type: '기안', plan_id: 'PLAN-008', approver: 'MS_CEO', std_approval_bd: 2, approval_anchor_date: '2026-07-28', anchor_basis: 'settlement_date' } }, 'p3');
    assert.equal(ev('DEADLINES_RECOMPUTED', { plan_id: 'PLAN-008' }).length, 1);
    assert.equal(p4.listReviews({ plan_id: 'PLAN-008', target_type: 'commitment' }).length, 0);
    await app.clock.advance({ days: 1 });
    assert.equal(ev('APPROVAL_SUBMITTED').filter((e) => e.payload.commitment_ids.includes('C-PLAN-008')).length, 1);
    assert.equal(app.events.errors.length, 0, JSON.stringify(app.events.errors));
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('S-AR-DELAY: 07-10 회수일 지연 → PLAN-004 경로 상향, W3, 재상신, 대체된 상신에는 회신 없음, 07-14 재상신 승인', async () => {
  const root = makeRoot({ withOthers: true });
  const app = allAuto(await createApp({ rootDir: root, dbPath: ':memory:', env: {}, log: quiet }));
  const port = await app.listen(0, '127.0.0.1');
  const p4 = app.module('p4');
  const ev = (t, f = {}) => app.events.query({ event_type: t, ...f });
  try {
    const set = await fetch(`http://127.0.0.1:${port}/api/p4/scenarios`, { method: 'POST', body: JSON.stringify({ scenarios: ['S-AR-DELAY'] }) });
    assert.deepEqual((await set.json()).scenarios, ['S-AR-DELAY']);
    await app.clock.advance({ to: '2026-07-20' });
    assert.equal(app.events.errors.length, 0, JSON.stringify(app.events.errors));
    const re = ev('DEADLINES_RECOMPUTED', { plan_id: 'PLAN-004' })[0];
    assert.equal(re.occurred_at, '2026-07-10');
    assert.equal(re.payload.approver, 'GRP_CEO');
    assert.equal(re.payload.computed_status, '마감 경과 상태로 산출');
    assert.equal(re.payload.submission_due, '2026-07-09'); // 둘 다 2영업일이라 값은 같다
    assert.equal(p4.listWarnings({ plan_id: 'PLAN-004', warning_rule: 'W3' })[0].occurred_at, '2026-07-10');
    const subs = ev('APPROVAL_SUBMITTED').filter((e) => e.payload.commitment_ids.includes('C-PLAN-004'));
    assert.deepEqual(subs.map((e) => e.occurred_at), ['2026-07-09', '2026-07-10']);
    const replies = ev('APPROVAL_REPLIED', { plan_id: 'PLAN-004' });
    assert.equal(replies.length, 1);
    assert.equal(replies[0].occurred_at, '2026-07-14');
    assert.equal(replies[0].scenario_id, 'S-AR-DELAY');
    assert.equal(p4.listReviews({ plan_id: 'PLAN-004', target_type: 'commitment' })[0].outcome, '변경');
    assert.equal(ev('PLAN_CONFIRMED', { plan_id: 'PLAN-004' })[0].occurred_at, '2026-07-15');
    // 구간 변경으로 열린 경로 재검토는 모두 닫힌다(재판정 유지)
    assert.equal(p4.listReviews({ target_type: 'route_judgment', review_status: '열림' }).length, 0);
    assert.ok(p4.listReviews({ target_type: 'route_judgment' }).length > 0);
    // 시나리오는 07-01이 지나면 바꿀 수 없다
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/p4/scenarios`, { method: 'POST', body: '{"scenarios":[]}' })).status, 409);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('기본 모의 입력(조정자 확정 (D)-3): 부족 → 시기 이동(판정 다음 영업일), 대안 없음·여전히 부족 → 확정기한 전 영업일 철회, 결정 시점 판정 보존', async () => {
  const root = makeRoot({ withOthers: true });
  const app = allAuto(await createApp({ rootDir: root, dbPath: ':memory:', env: {}, log: quiet }));
  const p4 = app.module('p4');
  const ev = (t, f = {}) => app.events.query({ event_type: t, ...f });
  try {
    await app.clock.advance({ to: '2026-08-17' });
    assert.equal(app.events.errors.length, 0, JSON.stringify(app.events.errors));
    // PLAN-009(부족, 권장 시기이동): 수요 등록 07-29 → 07-30 시기 이동 선택, 한 판정 버전에 한 번
    const sel = ev('ALTERNATIVE_SELECTED', { plan_id: 'PLAN-009' });
    assert.equal(sel.length, 1);
    assert.equal(sel[0].occurred_at, '2026-07-30');
    assert.match(sel[0].generation_reason, /^기본 모의 입력\(다\)/);
    assert.equal(sel[0].is_synthetic, true);
    // 시기 이동 뒤에도 부족 → 08-13(확정기한 08-14 전 영업일) 철회
    const w9 = ev('PLAN_WITHDRAWN', { plan_id: 'PLAN-009' })[0];
    assert.equal(w9.occurred_at, '2026-08-13');
    assert.match(w9.generation_reason, /^기본 모의 입력\(라\)/);
    // PLAN-008(부족, 대안 없음) → 08-13 철회. 결정 시점 판정이 남는다
    assert.equal(ev('PLAN_WITHDRAWN', { plan_id: 'PLAN-008' })[0].occurred_at, '2026-08-13');
    const st8 = p4.getPlanState('PLAN-008');
    assert.equal(st8.plan_status, '철회');
    assert.equal(st8.decision_snapshot.supply_verdict, '부족');
    assert.equal(st8.decision_snapshot.decided_at, '2026-08-13');
    // 시연 기안(PLAN-011)도 지정 입력(08-05~08-07)을 다 쓴 뒤 여전히 부족이면 기본 규칙으로 철회한다((D) 2차-나)
    assert.equal(ev('PLAN_WITHDRAWN', { plan_id: 'PLAN-011' })[0].occurred_at, '2026-08-13');
    assert.equal(p4.getPlanState('PLAN-011').plan_status, '철회');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('(D) 2차-나: 시연 기안도 지정 입력을 다 쓰면 기본 규칙을 따른다(PLAN-014 정정 → 부족 → 철회), 기한 경과는 PLAN-005 같은 미등록뿐', async () => {
  globalThis.P14_SHORT = true;
  const root = makeRoot({ withOthers: true });
  const app = allAuto(await createApp({ rootDir: root, dbPath: ':memory:', env: {}, log: quiet }));
  const ev = (t, f = {}) => app.events.query({ event_type: t, ...f });
  try {
    await app.clock.advance({ to: '2026-08-17' });
    assert.equal(app.events.errors.length, 0, JSON.stringify(app.events.errors));
    const w14 = ev('PLAN_WITHDRAWN', { plan_id: 'PLAN-014' })[0];
    assert.equal(w14.occurred_at, '2026-08-13'); // 확정기한 08-14 전 영업일
    assert.match(w14.generation_reason, /^기본 모의 입력\(라\)/);
    assert.equal(app.module('p4').getPlanState('PLAN-005').plan_status, '기한 경과 확정');
    // (D) 2차-마 재현: 늦은 회신은 재요청에 붙지만, 이관된 원 요청의 기한 경과 후속 재검토도 닫힌다
    const p4 = app.module('p4');
    const first = p4.listInfoRequests({ plan_id: 'PLAN-011', request_topic: 'demand_input' })[0];
    assert.equal(first.request_status, '이관');
    const follow = p4.listReviews({ target_type: 'info_request', target_id: first.request_id })[0];
    assert.equal(follow.review_status, '종결');
    assert.match(follow.rationale, /^이관된 요청 REQ-\d+에 회신 도착/);
    assert.equal(p4.listReviews({ target_type: 'info_request', review_status: '열림' }).filter((r) => r.target_id === first.request_id).length, 0);
    // (E)-다: 기안이 끝나면 열린 기한 경과 후속 재검토는 '종결(회신 없음)'으로 닫힌다(PLAN-005 미등록 07-20)
    const f005 = p4.listReviews({ plan_id: 'PLAN-005', target_type: 'info_request' });
    assert.ok(f005.length > 0);
    for (const r of f005) {
      assert.equal(r.review_status, '종결');
      assert.match(r.rationale, /^종결\(회신 없음\): 기안 기한 경과 확정 뒤에도 demand_input 요청 REQ-\d+에 회신 없음/);
      assert.equal(r.after.closed_reason, '회신 없음');
    }
  } finally {
    delete globalThis.P14_SHORT;
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('(D) 2차-마 재현: 발주안 상신 행의 target은 po_draft_id라서 문제 3 deliverMock이 찾아 상신한다', async () => {
  globalThis.P4_PO = true;
  const root = makeRoot({ withOthers: true });
  const app = allAuto(await createApp({ rootDir: root, dbPath: ':memory:', env: {}, log: quiet }));
  try {
    const p4 = app.module('p4');
    const row = p4.getMockSchedule({ owner: 'p3' }).find((r) => r.mock_id === 'M04:PO:POD-T1:1');
    assert.equal(row.target, 'POD-T1');
    assert.equal(row.sim_date, '2026-07-08'); // 발주 예정일 07-16 기준 상신 마감
    await app.clock.advance({ to: '2026-07-09' });
    assert.equal(app.events.errors.length, 0, JSON.stringify(app.events.errors));
    assert.match(p4.getMockSchedule({}).find((r) => r.mock_id === 'M04:PO:POD-T1:1').status, /^완료/);
    assert.notEqual(app.module('p3').commitment('CMT-POD-T1').approval_status, '미상신');
  } finally {
    delete globalThis.P4_PO;
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('(D) 2차-마 재현: 구간이 바뀌어도 문제 3 재대조(recheck_summary)에서 결론이 같은 약정은 경로 재검토를 열어 두지 않는다', async () => {
  globalThis.P4_RECHECK = true;
  const root = makeRoot({ withOthers: true });
  const app = allAuto(await createApp({ rootDir: root, dbPath: ':memory:', env: {}, log: quiet }));
  const port = await app.listen(0, '127.0.0.1');
  const p4 = app.module('p4');
  try {
    await fetch(`http://127.0.0.1:${port}/api/p4/scenarios`, { method: 'POST', body: JSON.stringify({ scenarios: ['S-AR-DELAY'] }) });
    await app.clock.advance({ to: '2026-07-20' });
    assert.equal(app.events.errors.length, 0, JSON.stringify(app.events.errors));
    assert.equal(p4.listReviews({ target_type: 'route_judgment', review_status: '열림' }).length, 0);
    assert.equal(p4.listReviews({ target_type: 'route_judgment' }).length, 2); // 바뀐 약정(PLAN-004·024)만
    assert.equal(p4.listReviews({ plan_id: 'PLAN-004', target_type: 'route_judgment' }).length, 1);
    const kept = p4.listReviews({ target_type: 'cash_window', target_id: 'W-AR' })[0];
    assert.equal(kept.outcome, '유지');
    assert.match(kept.rationale, /^문제 3 재대조\(recheck_summary\): 구간 2026-07-21~2026-08-21 → 2026-07-21~2026-08-28/);
    assert.ok(kept.after.kept_commitment_ids.includes('C-PLAN-002'));
    assert.deepEqual(kept.after.changed_commitment_ids, ['C-PLAN-004', 'C-PLAN-024']);
    const plan2 = await (await fetch(`http://127.0.0.1:${port}/api/p4/plans/PLAN-002`)).json();
    assert.ok(plan2.reviews.some((r) => r.review_id === kept.review_id)); // 기안 화면에도 보인다
    assert.equal(p4.getPlanState('PLAN-002').plan_status, '확정');
  } finally {
    delete globalThis.P4_RECHECK;
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('(E)-가: 발주안 모의 승인 규칙 — 승인 가정 최저 잔액 0원 미만이면 거절, 근거(전후 최저 잔액·구간)를 회신에 싣는다', async () => {
  for (const [after, decision] of [[-6186000000, '거절'], [0, '승인']]) {
    globalThis.P4_PO = true;
    globalThis.P4_IMPACT = { 'CMT-POD-T1': after };
    const root = makeRoot({ withOthers: true });
    const app = allAuto(await createApp({ rootDir: root, dbPath: ':memory:', env: {}, log: quiet }));
    try {
      await app.clock.advance({ to: '2026-07-13' }); // 07-08 상신 + 2영업일
      assert.equal(app.events.errors.length, 0, JSON.stringify(app.events.errors));
      const ev = app.events.query({ event_type: 'APPROVAL_REPLIED', subject_id: 'CMT-POD-T1' });
      assert.equal(ev.length, 1);
      assert.equal(ev[0].payload.decision, decision);
      assert.equal(ev[0].source_ref[0], 'problem4/data/s4_08_approval_replies.csv#S4-08-97');
      assert.equal(ev[0].payload.cash_basis.after.min_balance_krw, after);
      assert.equal(ev[0].payload.cash_basis.before.shortfall_window_end, '2026-08-21');
      assert.equal(ev[0].payload.cash_basis.after.shortfall_window_end, '2026-08-28');
      if (decision === '거절') assert.match(ev[0].payload.reason, /^거절: 승인 가정 재전망 최저 잔액 -6,186,000,000원\(2026-09-21\) < 0원\. Masil 단독 기준 지급 재원 없음/);
      const rep = app.events.query({ event_type: 'APPROVAL_REPLIED', limit: 1e9 }).filter((e) => e.payload.cash_basis);
      assert.equal(rep.length, 1); // 기안 회신에는 현금 규칙을 쓰지 않는다
      // 화면: 발주안 회신 목록에 근거가 실린다
      const port = await app.listen(0, '127.0.0.1');
      const { po_replies } = await (await fetch(`http://127.0.0.1:${port}/api/p4/po-replies`)).json();
      assert.deepEqual(po_replies.map((r) => [r.po_draft_id, r.decision, r.cash_basis.after.min_balance_krw]), [['POD-T1', decision, after]]);
      // 기안 목록 요약: 진행 요약의 단계별 마감(step)
      const { plans } = await (await fetch(`http://127.0.0.1:${port}/api/plans`)).json();
      const steps = plans.find((p) => p.plan_id === 'PLAN-002').summaries.filter((x) => x.step).map((x) => [x.step, x.label, x.value]);
      assert.deepEqual(steps, [['p1', '수요 입력 마감', '2026-07-07'], ['p2', '판정 마감', '2026-07-08'], ['p3', '상신 마감', '2026-07-09'], ['p4', '확정기한', '2026-07-17']]);
    } finally {
      delete globalThis.P4_PO; delete globalThis.P4_IMPACT;
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('(E) 재현: 취소된 발주안(PO_DRAFT_CANCELLED)에는 상신 행·마감 경고(W3·W5·W6)를 내지 않는다', async () => {
  globalThis.P4_PO = true; globalThis.P4_PO_CANCEL = true;
  const root = makeRoot({ withOthers: true });
  const app = allAuto(await createApp({ rootDir: root, dbPath: ':memory:', env: {}, log: quiet }));
  try {
    const p4 = app.module('p4');
    assert.equal(p4.getDeadlineSchedule({ commitment_id: 'CMT-POD-T1' }).computed_status, '취소(발주안 취소)');
    await app.clock.advance({ to: '2026-07-27' }); // 상신 마감 07-08, 최종 회신 07-15, 발주 예정일 07-16을 모두 지남
    assert.equal(app.events.errors.length, 0, JSON.stringify(app.events.errors));
    assert.equal(p4.getMockSchedule({ owner: 'p3' }).filter((r) => r.mock_id.startsWith('M04:PO:POD-T1')).length, 0);
    assert.equal(p4.listWarnings({}).filter((w) => w.commitment_id === 'CMT-POD-T1').length, 0);
    assert.equal(app.module('p3').commitment('CMT-POD-T1').approval_status, '미상신');
  } finally {
    delete globalThis.P4_PO; delete globalThis.P4_PO_CANCEL;
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('(E) 재현: 지급일이 그대로인 재산정에는 경로 재검토를 열지 않고, 문제 3이 재판정하지 않은 경로 재검토는 다음 날 유지로 닫는다', async () => {
  globalThis.P4_PO = true; globalThis.P4_PO_PAY = true;
  const root = makeRoot({ withOthers: true });
  const app = allAuto(await createApp({ rootDir: root, dbPath: ':memory:', env: {}, log: quiet }));
  try {
    const p4 = app.module('p4');
    const rv = () => p4.listReviews({ target_type: 'route_judgment' }).filter((r) => r.target_id === 'RJ-POD-T1');
    assert.equal(rv().length, 1); // 08-21 → 08-21은 열지 않고, 08-21 → 09-21만 연다
    assert.equal(rv()[0].review_status, '열림');
    await app.clock.advance({ to: '2026-07-02' });
    assert.equal(app.events.errors.length, 0, JSON.stringify(app.events.errors));
    assert.equal(rv()[0].review_status, '종결');
    assert.equal(rv()[0].outcome, '유지');
    assert.match(rv()[0].rationale, /^문제 3 재판정 없음\(경로 판정 RJ-POD-T1 그대로\)/);
  } finally {
    delete globalThis.P4_PO; delete globalThis.P4_PO_PAY;
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('(F)-가·G: 기준 수요 정기 보충 가정(범위 밖) 확인 요청은 SKU마다 한 번씩, 기한 경고 없이(묶음·나눔 입력 모두)', async () => {
  const root = makeRoot({ withOthers: true });
  const app = allAuto(await createApp({ rootDir: root, dbPath: ':memory:', env: {}, log: quiet }));
  try {
    const p4 = app.module('p4');
    Object.assign(app.module('p2'), { baselineReplenishment: () => [
      // 문제 2 v2.0: 정기 보충 가정(covered_from_week)을 없애고 SCM 보충 계획 상태(plan_status)를 준다
      { sku_id: 'SKU-1001', plan_status: 'SCM 확인·Corevia 미확약', plan_qty_total: 126800 },
      { sku_id: 'SKU-3003', plan_status: '미회신', plan_qty_total: 0 },
    ] });
    const bundled = { request_topic: 'baseline_replenishment', requested_to: 'SCM', subject_type: 'baseline_replenishment', subject_id: 'BR-2026-07-01', questions: ['묶음'] };
    const r = await p4.requestInfo(bundled);
    assert.equal(r.split_request_ids.length, 2);
    // 문제 2가 SKU별로 나눠 보내도(split: true) 같은 SKU는 한 번만, 새 SKU는 새로
    const again = await p4.requestInfo({ ...bundled, subject_id: 'SKU-1001', split: true, questions: ['나눔'] });
    assert.equal(again.request_id, r.split_request_ids[0]);
    await p4.requestInfo({ ...bundled, subject_id: 'SKU-2001', split: true, questions: ['SKU-2001: 08-31 주부터 정기 발주로 충족하는지'] });
    await p4.requestInfo(bundled);
    const reqs = p4.listInfoRequests({ request_topic: 'baseline_replenishment' });
    assert.deepEqual(reqs.map((x) => [x.subject_id, x.requested_to, x.request_due_date]), [['SKU-1001', 'SCM', null], ['SKU-3003', 'SCM', null], ['SKU-2001', 'SCM', null]]);
    assert.match(app.events.query({ event_type: 'INFO_REQUESTED', subject_id: reqs[0].request_id })[0].payload.questions[0], /^SKU-1001: 기준 수요 보충 계획\(수량·발주 예정일·도착 예정일·Corevia 확약 여부\)을 확인해 주세요\(현재 SCM 확인·Corevia 미확약\).*범위 밖\(SCM 정기 발주 소관\)/);
    await app.clock.advance({ to: '2026-07-20' });
    assert.equal(p4.listWarnings({}).filter((w) => reqs.some((x) => x.request_id === w.request_id)).length, 0);
    assert.equal(p4.getPlanState('PLAN-002').plan_status, '확정'); // 캠페인 판정·확정을 막지 않는다
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('기발주 Corevia 회신 행(문제 2 v2.1): 문제 2 onDay가 먼저 반영해 deliverMock이 건너뛰어도 그날 회신 사건으로 완료를 남기고, 발주안 대상만 M20으로 펼친다', async () => {
  const root = makeRoot({ withOthers: true });
  const app = allAuto(await createApp({ rootDir: root, dbPath: ':memory:', env: {}, log: quiet }));
  try {
    const p4 = app.module('p4');
    const landed = {};
    Object.assign(app.module('p2'), {
      // 실제 문제 2처럼: 07-13 원료 지연 정정 회신은 이미 그날 onDay에서 반영됐고(사건 있음), 순서표 전달은 재처리라 건너뛴다
      deliverMock: async (mockId) => {
        if (mockId === 'M07') {
          for (const id of ['S2-CVC-SPO-0005-2', 'S2-CVC-SPO-0006-2', 'S2-CVC-SPO-0007-2']) {
            landed[id] = (await app.events.emit({ event_type: 'SUPPLIER_REPLIED', source_type: '모의회신', is_synthetic: true, actor_dept: 'COREVIA',
              payload: { supply_commitment: { record_id: id, target_type: '기발주', target_id: id.slice(8, 16), sku_id: 'SKU-2001', linked_plan_ids: [], reply_status: '가능', validation_status: '정상' } } })).event_id;
          }
        }
        return { skipped: true, reason: '이 날짜의 입고 회신 자료가 없습니다' };
      },
      pendingSupplyCommitments: () => [
        { record_id: 'S2-CVC-SPO-0002-2', po_draft_id: null, due_date: '2026-08-06', applied: false },
        { record_id: 'S2-CVC-SKU-4002-1', po_draft_id: 'POD-T', due_date: '2026-07-20', applied: false },
      ],
    });
    await app.clock.advance({ to: '2026-07-13' });
    const rows = p4.getMockSchedule({});
    const m07 = rows.find((r) => r.mock_id === 'M07');
    assert.equal(m07.status, '완료');
    assert.equal(m07.delivered_event_id, landed['S2-CVC-SPO-0005-2']);
    assert.match(rows.find((r) => r.mock_id === 'M21').status, /^건너뜀/); // 그날 회신 사건이 없으면 건너뜀 그대로
    // 기발주 대상 회신은 명시 행(M01·M07·M21~M23)으로만, M20은 발주안 대상만
    assert.deepEqual(rows.filter((r) => r.mock_id.startsWith('M20:')).map((r) => r.mock_id), ['M20:S2-CVC-SKU-4002-1:POD-T']);
    assert.ok(rows.some((r) => r.mock_id === 'M23' && r.sim_date === '2026-08-06'));
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('S-CEO-FLOOR(가정): 그룹 CEO 결재 발주안은 승인 후 최저 잔액 15억 미만이면 거절, 기본 기준이면 승인이었음을 남긴다. SCM 결재·시나리오 꺼짐은 0원 기준', async () => {
  const cases = [
    { scen: ['S-CEO-FLOOR'], approver: 'GRP_CEO', decision: '거절', scenario_id: 'S-CEO-FLOOR', differs: true },
    { scen: [], approver: 'GRP_CEO', decision: '승인', scenario_id: 'BASE', differs: false },
    { scen: ['S-CEO-FLOOR'], approver: 'SCM', decision: '승인', scenario_id: 'BASE', differs: false },
  ];
  for (const k of cases) {
    globalThis.P4_PO = true; globalThis.P4_PO_APPROVER = k.approver;
    globalThis.P4_IMPACT = { 'CMT-POD-T1': 500_000_000 }; // 승인 후 최저 잔액 5억: 0원 기준이면 승인, 15억 기준이면 거절
    const root = makeRoot({ withOthers: true });
    const app = allAuto(await createApp({ rootDir: root, dbPath: ':memory:', env: {}, log: quiet }));
    const port = await app.listen(0, '127.0.0.1');
    try {
      const set = await fetch(`http://127.0.0.1:${port}/api/p4/scenarios`, { method: 'POST', body: JSON.stringify({ scenarios: k.scen }) });
      assert.equal(set.status, 200);
      await app.clock.advance({ to: '2026-07-14' });
      assert.equal(app.events.errors.length, 0, JSON.stringify(app.events.errors));
      const ev = app.events.query({ event_type: 'APPROVAL_REPLIED', subject_id: 'CMT-POD-T1' })[0];
      assert.equal(ev.payload.decision, k.decision, JSON.stringify(k));
      assert.equal(ev.scenario_id, k.scenario_id);
      assert.equal(ev.payload.cash_basis.differs_from_base, k.differs);
      assert.equal(ev.payload.cash_basis.base_decision, '승인');
      const sum = await (await fetch(`http://127.0.0.1:${port}/api/p4/scenario-summary`)).json();
      assert.equal(sum.po.rejected_by_floor.length, k.differs ? 1 : 0);
      if (k.differs) {
        assert.match(ev.payload.reason, /^거절: 승인 가정 재전망 최저 잔액 500,000,000원\(2026-09-21\) < 1,500,000,000원\. 그룹 CEO 승인 조건: 발주안 승인 후 재전망 최저 잔액 15억원 이상\(가정 시나리오 S-CEO-FLOOR, S4-10-01\)$/);
        assert.equal(ev.payload.cash_basis.floor_krw, 1_500_000_000);
        assert.ok(ev.premise_refs.includes('s4_10_po_cash_floor.csv#S4-10-01'));
        assert.equal(sum.floors.find((f) => f.scenario_id === 'S-CEO-FLOOR').active, true);
      }
    } finally {
      delete globalThis.P4_PO; delete globalThis.P4_PO_APPROVER; delete globalThis.P4_IMPACT;
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('마지막 조정 (나): 구간 확대 → 경로 상향 → 재상신 → 회신이 확정기한 뒤 → 기한 경과 확정 경위를 기안 상세·요약에 싣는다', async () => {
  globalThis.P4_LATE_UP = true;
  const root = makeRoot({ withOthers: true });
  const app = allAuto(await createApp({ rootDir: root, dbPath: ':memory:', env: {}, log: quiet }));
  const port = await app.listen(0, '127.0.0.1');
  try {
    await app.clock.advance({ to: '2026-07-21' });
    assert.equal(app.events.errors.length, 0, JSON.stringify(app.events.errors));
    const p4 = app.module('p4');
    assert.equal(p4.getPlanState('PLAN-004').plan_status, '기한 경과 확정');
    const d = await (await fetch(`http://127.0.0.1:${port}/api/p4/plans/PLAN-004`)).json();
    const st = d.lapse_story;
    assert.equal(st.kind, '경로 상향 뒤 재승인 미도착');
    assert.deepEqual(st.steps.map((x) => x.step), ['1차 승인', '구간 확대', '경로 상향', '재상신', '회신 예정', '기한 경과 확정']);
    assert.match(st.steps[1].text, /하회 구간 2026-07-21~2026-08-21 → 2026-07-21~2026-08-28/);
    assert.match(st.steps[2].text, /^Masil 대표 → 그룹 CEO/); // 왼쪽 화면에 쓰이므로 코드 대신 이름
    for (const x of st.steps) assert.doesNotMatch(x.text, /GRP_CEO|MS_CEO|POD-|CMT-/);
    assert.equal(st.steps[4].date, '2026-07-20');
    assert.match(st.steps[4].text, /확정기한 2026-07-17 뒤라 기한 안에 회신이 오지 않음/);
    assert.equal(st.steps[5].date, '2026-07-20');
    const sum = await (await fetch(`http://127.0.0.1:${port}/api/p4/scenario-summary`)).json();
    const ids = sum.deadline_lapses.map((x) => x.plan_id);
    assert.ok(ids.includes('PLAN-004') && ids.includes('PLAN-005'));
    assert.equal(sum.deadline_lapses.find((x) => x.plan_id === 'PLAN-005').kind, '결정 미완료'); // 수요 미등록은 경로 상향 없음
  } finally {
    delete globalThis.P4_LATE_UP;
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('마지막 조정 재현: 기안이 끝나면(철회) 남은 전제 변경 재검토(경로 상향 뒤 재상신 전)도 닫는다', async () => {
  globalThis.P4_LATE_UP = true; globalThis.P4_NO_RESUB = true;
  const root = makeRoot({ withOthers: true });
  const app = allAuto(await createApp({ rootDir: root, dbPath: ':memory:', env: {}, log: quiet }));
  const port = await app.listen(0, '127.0.0.1');
  try {
    await app.clock.advance({ to: '2026-07-15' });
    const p4 = app.module('p4');
    const open = () => p4.listReviews({ plan_id: 'PLAN-004', review_status: '열림' });
    assert.ok(open().some((r) => r.target_type === 'commitment'), JSON.stringify(p4.listReviews({ plan_id: 'PLAN-004' })));
    const w = await fetch(`http://127.0.0.1:${port}/api/p4/plans/PLAN-004/withdraw`, { method: 'POST', body: JSON.stringify({ reason: '테스트 철회' }) });
    assert.equal(w.status, 200);
    assert.equal(open().length, 0);
    const closed = p4.listReviews({ plan_id: 'PLAN-004', target_type: 'commitment' }).at(-1);
    assert.match(closed.rationale, /^종결\(기안 철회\): 전제 변경 재검토 대상\(commitment C-PLAN-004\)을 더 판단하지 않음$/);
  } finally {
    delete globalThis.P4_LATE_UP; delete globalThis.P4_NO_RESUB;
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('직접 처리(사용자 결정): 기본 PLAN-001~003은 마케팅 모의 입력을 건너뛰고, 아무것도 안 하면 마감 경고·기한 경과가 규칙대로 난다. 끄면 모의 입력이 다시 온다', async () => {
  const root = makeRoot({ withOthers: true });
  const app = await createApp({ rootDir: root, dbPath: ':memory:', env: {}, log: quiet });
  const port = await app.listen(0, '127.0.0.1');
  try {
    const p4 = app.module('p4');
    assert.deepEqual(p4.listDirectPlans(), ['PLAN-001', 'PLAN-002', 'PLAN-003']);
    // PLAN-003은 끈다(HTTP 시연 조작)
    const off = await (await fetch(`http://127.0.0.1:${port}/api/p4/plans/PLAN-003/direct`, { method: 'POST', body: JSON.stringify({ on: false }) })).json();
    assert.deepEqual(off.direct_plans, ['PLAN-001', 'PLAN-002']);
    await app.clock.advance({ to: '2026-07-21' });
    assert.equal(app.events.errors.length, 0, JSON.stringify(app.events.errors));
    const sched = Object.fromEntries(p4.getMockSchedule({}).map((r) => [r.mock_id, r]));
    assert.match(sched['M02:PLAN-002'].status, /^직접 처리/);
    assert.equal(sched['M02:PLAN-003'].status, '완료');
    // 직접 처리 기안: 수요 회신·상신·확정이 모의로 오지 않는다
    assert.equal(app.events.query({ event_type: 'INFO_REPLIED', plan_id: 'PLAN-002' }).length, 0);
    assert.equal(app.events.query({ event_type: 'APPROVAL_SUBMITTED', limit: 1e9 }).filter((e) => e.payload.commitment_ids.includes('C-PLAN-002')).length, 0);
    assert.equal(p4.listWarnings({ plan_id: 'PLAN-002', warning_rule: 'W1' })[0].occurred_at, '2026-07-08');
    assert.ok(p4.listWarnings({ plan_id: 'PLAN-002', warning_rule: 'W3' }).length >= 1);
    assert.equal(p4.getPlanState('PLAN-002').plan_status, '기한 경과 확정');
    // L8: 직접 처리 기안이 기한 경과로 끝나면 '담당자 입력 없음'과 하지 않은 일을 남긴다(경위·카드)
    const lapse = app.events.query({ event_type: 'PLAN_AUTO_CONFIRMED_BY_DEADLINE', plan_id: 'PLAN-002' })[0];
    assert.deepEqual(lapse.payload.direct_no_input.awaited, ['수요 입력']);
    assert.match(lapse.generation_reason, /직접 처리 기안: 담당자 입력 없음\(수요 입력\)/);
    const story = (await (await fetch(`http://127.0.0.1:${port}/api/p4/plans/PLAN-002`)).json()).lapse_story;
    assert.equal(story.kind, '직접 처리 기안 담당자 입력 없음');
    assert.ok(story.steps.some((x) => x.step === '담당자 입력 없음' && /수요 입력/.test(x.text)));
    assert.match(p4.describeEvent(lapse).title, /담당자 입력 없음$/);
    // 자동 처리 기안의 기한 경과에는 붙지 않는다
    for (const e of app.events.query({ event_type: 'PLAN_AUTO_CONFIRMED_BY_DEADLINE', limit: 1e9 }).filter((x) => x.plan_id !== 'PLAN-001' && x.plan_id !== 'PLAN-002')) assert.equal(e.payload.direct_no_input, undefined);
    // 자동 기안은 그대로 모의로 돈다
    assert.equal(p4.getPlanState('PLAN-003').plan_status !== '검토 중', true);
    assert.equal(app.events.query({ event_type: 'INFO_REPLIED', plan_id: 'PLAN-003' }).length, 1);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('화면 API(사용자 결정): 내 기안 세 묶음·기안 한 건 묶음·설명 카드·행동 단위 흐름', async () => {
  const root = makeRoot({ withOthers: true });
  const app = await createApp({ rootDir: root, dbPath: ':memory:', env: {}, log: quiet });
  const port = await app.listen(0, '127.0.0.1');
  const get = async (p) => (await fetch(`http://127.0.0.1:${port}${p}`)).json();
  try {
    // 07-01: 직접 처리 3건이 '지금 내가 할 일'(수요 입력), 나머지는 자동 처리로 '기다리는 중'
    let h = await get('/api/p4/user/home');
    assert.deepEqual(h.todo.map((x) => [x.plan_id, x.action, x.due]), [['PLAN-001', 'demand', '2026-07-07'], ['PLAN-002', 'demand', '2026-07-07'], ['PLAN-003', 'demand', '2026-07-07']]);
    assert.equal(h.todo[0].days_left, 4);
    assert.ok(h.waiting.length === 22 && h.waiting.every((x) => x.auto));
    assert.equal(h.done.length, 0);
    const v = await get('/api/p4/user/plans/PLAN-002');
    assert.match(v.sentence, /지금 할 일: 수요 입력\(7월 7일까지, 4영업일 남음\)/);
    assert.deepEqual(v.steps.map((s) => s.name), ['수요 입력', '공급 확인', '승인', '확정']);
    assert.equal(v.actions.find((a) => a.kind === 'demand').primary, true);
    assert.equal(v.direct, true);
    // 문제 4 사건 카드: 실제 값과 한국어 업무 용어
    const rec = app.events.query({ event_type: 'PLAN_RECEIVED', plan_id: 'PLAN-002' })[0];
    const card = app.module('p4').describeEvent(rec);
    assert.match(card.title, /^기안 접수 · PLAN-002\(/);
    assert.equal(card.actor_kind, '규칙·계산');
    assert.equal(card.inputs[2].value, '2026-07-17');
    const dl = app.module('p4').describeEvent(app.events.query({ event_type: 'DEADLINES_SET', plan_id: 'PLAN-002' })[0]);
    assert.match(dl.result, /수요 입력 마감 2026-07-07, 판정·재무 확인 마감 2026-07-08, 승인 요청\(상신\) 마감 2026-07-09/);
    assert.equal(app.module('p4').describeEvent({ ...rec, emitted_by: 'p1' }), null); // 남의 사건은 null
    // 기한이 지나면 맨 위 경고
    await app.clock.advance({ to: '2026-07-08' });
    h = await get('/api/p4/user/home');
    assert.ok(h.alerts.some((a) => a.plan_id === 'PLAN-002' && a.direct && /수요 입력 마감 경과/.test(a.text)));
    assert.match(h.todo.find((x) => x.plan_id === 'PLAN-002').sentence, /7월 7일 마감 지남/);
    // 사람이 화면에서 한 행동(철회)이 흐름의 시작점이 되고, 이어진 사건이 카드로 붙는다
    await fetch(`http://127.0.0.1:${port}/api/p4/plans/PLAN-001/withdraw`, { method: 'POST', body: JSON.stringify({ reason: '시즌 취소' }) });
    const f = await get('/api/p4/flow?plan_id=PLAN-001&limit=3');
    assert.equal(f.groups[0].trigger.actor_kind, '사람');
    assert.match(f.groups[0].trigger.title, /^기안 철회 · PLAN-001/);
    assert.equal(f.latest_user_action, f.groups[0].root_event_id);
    assert.ok(f.groups[0].cards.some((c) => c.event.event_type === 'REVIEW_CLOSED' || c.event.event_type === 'PLAN_WITHDRAWN'));
    // 설명 카드가 없는 모듈의 사건은 사건 이름과 payload 요약으로 대신한다(스텁 문제 2)
    const sj = app.events.query({ event_type: 'SUPPLY_JUDGED', plan_id: 'PLAN-004' })[0];
    const fb = (await get(`/api/p4/describe/${sj.event_id}`)).card;
    assert.equal(fb.fallback, true);
    assert.match(fb.title, /^공급 판정 · PLAN-004/);
    assert.equal((await get('/api/p4/user/home')).done.find((x) => x.plan_id === 'PLAN-001').status, '철회');
    // 재검토 종결 카드의 전후 값은 JSON이 아니라 읽는 문장
    for (const e of app.events.query({ event_type: 'REVIEW_CLOSED', limit: 1e9 })) {
      for (const i of app.module('p4').describeEvent(e).inputs) assert.doesNotMatch(String(i.value), /^[{[]/);
    }
    assert.deepEqual((await get('/api/p4/user/plans/PLAN-002')).why.po, []); // 연결된 보충 발주안이 없으면 빈 목록
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('공급 확약(사용자 요청 2026-11-15 나·다): 승인돼도 공급 확약 대기면 확정 가능이 아니고, Corevia 확약 회신 → 재검토 → 확정 가능. 지정 사례만 위험 수용, 나머지는 기한 전 철회', async () => {
  globalThis.P4_SUPPLY = { 'PLAN-007': 'supply_commitment_pending', 'PLAN-011': 'baseline_replenishment_unconfirmed', 'PLAN-013': 'supply_commitment_pending' };
  const root = makeRoot({ withOthers: true });
  const app = allAuto(await createApp({ rootDir: root, dbPath: ':memory:', env: {}, log: quiet }));
  const p4 = app.module('p4');
  const ev = (t, f = {}) => app.events.query({ event_type: t, limit: 1e9, ...f });
  const deadline = (id) => ctx0.plans().find((p) => p.plan_id === id).contract_deadline;
  const ctx0 = { plans: () => ev('PLAN_RECEIVED').map((e) => ({ plan_id: e.plan_id, contract_deadline: e.payload.contract_deadline })) };
  try {
    await app.clock.advance({ to: '2026-07-14' });
    assert.equal(app.events.errors.length, 0, JSON.stringify(app.events.errors));
    // (a)·(다) PLAN-007: 승인 회신(07-13) 뒤에도 공급 확약 대기 → 조건부 대기, 예전처럼 조건 수용 회신을 자동으로 넣지 않는다
    let st = p4.getPlanState('PLAN-007');
    assert.equal(st.plan_confirmability, '조건부 대기');
    assert.match(st.confirmability_basis.reason, /공급 확약 대기: Corevia 공급 확약 대기/);
    assert.equal(ev('APPROVAL_REPLIED', { plan_id: 'PLAN-007' }).filter((e) => (e.payload.conditions ?? []).length).length, 0);
    // (나) Corevia 확약 회신 → 그 기안의 공급 판정 재검토(회신 사건이 원인) → 가능 → 확정 가능
    const reply = await app.module('p2').deliverCommitment('PLAN-007');
    const rv = p4.listReviews({ plan_id: 'PLAN-007', target_type: 'supply_judgment' }).find((r) => r.trigger_event_id === reply.event_id);
    assert.ok(rv, '확약 회신으로 재검토가 열려야 한다');
    assert.equal(rv.review_status, '종결');
    assert.equal(rv.outcome, '변경');
    assert.equal(p4.getPlanState('PLAN-007').plan_confirmability, '확정 가능');
    // SCM 보충 계획 회신: 회신이 온 SKU의 확인 요청만 닫고, 미회신 SKU는 열린 채(자동 해소 없음)
    const a = await p4.requestInfo({ request_topic: 'baseline_replenishment', requested_to: 'SCM', subject_type: 'baseline_replenishment', subject_id: 'SKU-A', split: true });
    const b = await p4.requestInfo({ request_topic: 'baseline_replenishment', requested_to: 'SCM', subject_type: 'baseline_replenishment', subject_id: 'SKU-B', split: true });
    await app.module('p2').deliverBaseline(['SKU-A']);
    assert.equal(p4.getInfoRequest(a.request_id).request_status, '회신됨');
    assert.equal(p4.getInfoRequest(b.request_id).request_status, '회신 대기');
    // 지정 사례 PLAN-011: 확정기한 2영업일 전 위험 수용 회신 → 위험 수용 확정 가능 → 확정(공급 미확약 상태로 확정)
    // 지정되지 않은 PLAN-013: 회신이 끝내 없어 확정기한 전 영업일 철회
    const last = [deadline('PLAN-011'), deadline('PLAN-013')].sort().at(-1);
    await app.clock.advance({ to: last });
    assert.equal(app.events.errors.length, 0, JSON.stringify(app.events.errors));
    const risk = ev('APPROVAL_REPLIED', { plan_id: 'PLAN-011' }).find((e) => e.payload.supply_risk_accepted);
    assert.ok(risk, '지정 사례에는 위험 수용 회신이 와야 한다');
    assert.deepEqual(risk.payload.accepted_condition_types, ['baseline_replenishment_unconfirmed']);
    assert.equal(risk.source_ref[0], 'problem4/data/s4_08_approval_replies.csv#S4-08-10');
    const s21 = p4.getPlanState('PLAN-011');
    assert.equal(s21.plan_status, '확정');
    assert.equal(s21.decision_snapshot.confirmed_under_risk, true);
    assert.equal(s21.decision_snapshot.supply_note, '공급 미확약 상태로 확정(위험 수용)');
    assert.equal(s21.decision_snapshot.supply_verdict, '조건부'); // 공급 판정은 그대로
    assert.equal(ev('APPROVAL_REPLIED', { plan_id: 'PLAN-013' }).filter((e) => e.payload.supply_risk_accepted).length, 0);
    const w13 = ev('PLAN_WITHDRAWN', { plan_id: 'PLAN-013' })[0];
    assert.match(w13.payload.reason, /^확정기한까지 공급이 확인되지 않음/);
  } finally {
    delete globalThis.P4_SUPPLY;
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('L8 시연 조작: 직접 처리 기안이 사용자 행동을 기다리면 GET /direct pending에 보이고, 모두 자동 처리로 바꿀 수 있다', async () => {
  const root = makeRoot({ withOthers: true });
  const app = await createApp({ rootDir: root, dbPath: ':memory:', env: {}, log: quiet });
  const port = await app.listen(0, '127.0.0.1');
  const call = async (m, p, body) => (await fetch(`http://127.0.0.1:${port}${p}`, { method: m, ...(body ? { body: JSON.stringify(body) } : {}) })).json();
  try {
    const d = await call('GET', '/api/p4/direct');
    assert.deepEqual(d.pending.map((x) => [x.plan_id, x.label, x.due]), [['PLAN-001', '수요 입력', '2026-07-07'], ['PLAN-002', '수요 입력', '2026-07-07'], ['PLAN-003', '수요 입력', '2026-07-07']]);
    const h = await call('GET', '/api/p4/user/home');
    assert.deepEqual(h.direct.map((x) => [x.plan_id, x.state, x.mine]), [['PLAN-001', '내 차례: 수요 입력', true], ['PLAN-002', '내 차례: 수요 입력', true], ['PLAN-003', '내 차례: 수요 입력', true]]);
    // (나) 다른 모듈이 자동 상신·모의 입력에서 직접 처리 기안을 빼도록 주는 공개 함수: 지금 값, 복사본
    const p4 = app.module('p4');
    assert.equal(p4.isDirectPlan('PLAN-002'), true);
    assert.equal(p4.isDirectPlan('PLAN-004'), false);
    const listed = p4.listDirectPlans();
    listed.push('PLAN-009');
    assert.deepEqual(p4.listDirectPlans(), ['PLAN-001', 'PLAN-002', 'PLAN-003']); // 받은 쪽이 고쳐도 설정은 그대로
    await call('POST', '/api/p4/plans/PLAN-002/direct', { on: false });
    assert.equal(p4.isDirectPlan('PLAN-002'), false);
    assert.deepEqual(p4.listDirectPlans(), ['PLAN-001', 'PLAN-003']);
    await call('POST', '/api/p4/plans/PLAN-002/direct', { on: true });
    const r = await call('POST', '/api/p4/direct/all-auto', {});
    assert.deepEqual(r.direct_plans, []);
    assert.deepEqual((await call('GET', '/api/p4/direct')).pending, []);
    assert.deepEqual((await call('GET', '/api/p4/user/home')).direct, []);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('L1·L4·L6·L7·L9: 철회 뒤 발주안 표시, 놓친 권장 대안, 정기 보충 민감도(참고), 입고 처리 재검토, 카드의 영문 이름', async () => {
  globalThis.P4_SUPPLY = { 'PLAN-013': 'supply_commitment_pending', 'PLAN-016': 'supply_commitment_pending' };
  const root = makeRoot({ withOthers: true });
  const app = allAuto(await createApp({ rootDir: root, dbPath: ':memory:', env: {}, log: quiet }));
  const port = await app.listen(0, '127.0.0.1');
  const get = async (p) => (await fetch(`http://127.0.0.1:${port}${p}`)).json();
  const p4 = app.module('p4');
  const ev = (t, f = {}) => app.events.query({ event_type: t, limit: 1e9, ...f });
  const deadlineOf = (id) => ev('PLAN_RECEIVED', { plan_id: id })[0].payload.contract_deadline;
  try {
    // L1 요청 주제: 문제 2가 내는 '기안 철회 뒤 남은 발주' 확인 요청을 받는다(회신 기한 없음), 카드는 한국어
    const orphan = await p4.requestInfo({ request_topic: 'po_draft_orphaned', requested_to: 'SCM', plan_id: 'PLAN-013', subject_type: 'po_draft', subject_id: 'POD-T1', questions: ['취소·조정 가능?'] });
    assert.equal(orphan.request_due_date, null);
    const oc = p4.describeEvent(ev('INFO_REQUESTED', { plan_id: 'PLAN-013' }).find((e) => e.payload.request_topic === 'po_draft_orphaned'));
    assert.match(oc.title, /^확인 요청 · 기안 철회 뒤 남은 발주 → SCM/);
    assert.match(oc.rule, /발주가 이미 전달된 발주안은 취소하지 않고/);

    // L7: 입고 실적(입고 완료)만 있는 입고 처리는 재검토를 열지 않고, 도착 예정일 경과·미확약은 그 SKU 기안의 공급 판정을 다시 본다
    await app.clock.advance({ to: '2026-07-20' });
    const openPlan = ['PLAN-016', 'PLAN-012', 'PLAN-008', 'PLAN-017', 'PLAN-022'].find((id) => p4.getPlanState(id).plan_status === '검토 중'
      && !p4.listReviews({ plan_id: id, target_type: 'supply_judgment' }).some((r) => r.review_status === '열림'));
    const sku = app.module('p1').planSkuMap({ plan_id: openPlan })[0].sku_id;
    const rcv = await app.events.emit({ event_type: 'INBOUND_SCHEDULE_REVISED', source_type: '사람입력', is_synthetic: true, plan_id: 'NONE',
      payload: { inbound_schedule_version: 'IS-R', receipts: [{ inbound_row_id: 'IB-X', source_ref: 'SPO-0099', sku_id: sku, received_qty: 10, received_on: app.clock.today() }], overdue_expected: [], changed_rows: [{ inbound_row_id: 'IB-X', supply_status: '입고 완료' }] } });
    assert.equal(ev('REVIEW_OPENED').filter((e) => e.payload.trigger_event_id === rcv.event_id).length, 0);
    const od = await app.events.emit({ event_type: 'INBOUND_SCHEDULE_REVISED', source_type: '계산', plan_id: 'NONE',
      payload: { inbound_schedule_version: 'IS-O', receipts: [], overdue_expected: [{ inbound_row_id: 'IB-Y', source_ref: 'POD-T9', sku_id: sku, original_eta_date: '2026-07-01', expected_now_week: '2026-07-06' }], changed_rows: [] } });
    const opened = ev('REVIEW_OPENED').filter((e) => e.payload.trigger_event_id === od.event_id).map((e) => e.plan_id);
    assert.ok(opened.includes(openPlan), `예정일 경과 SKU ${sku}의 기안(${openPlan}) 재검토: ${opened}`);

    // L4: 확정기한 2영업일 전에 권장 대안이 없다가(또는 재검토 중이라 놓쳐) 전 영업일에 생기면, 철회 전에 먼저 고른다
    const dl13 = deadlineOf('PLAN-013');
    const dMinus1 = addBusinessDays(dl13, -1);
    const p2 = app.module('p2');
    const basePa = p2.planAlternatives;
    Object.assign(p2, {
      planAlternatives: (id) => (id === 'PLAN-013' && app.clock.today() === dMinus1
        ? { plan_id: id, recommended: { alternative_id: 'ALT-013', alternative_type: '물량상한', reason: '고르면 예상 판정 가능' } } : basePa(id)),
      selectAlternative: async ({ alternative_id, generation_reason, is_mock }) => {
        const pid = alternative_id === 'ALT-013' ? 'PLAN-013' : 'PLAN-009';
        const e = await app.events.emit({ event_type: 'ALTERNATIVE_SELECTED', source_type: '사람입력', is_synthetic: is_mock, plan_id: pid, generation_reason, payload: { alternative_id, alternative_type: pid === 'PLAN-013' ? '물량상한' : '시기이동' } });
        return { event_id: e.event_id };
      },
    });
    await app.clock.advance({ to: dMinus1 });
    assert.equal(app.events.errors.length, 0, JSON.stringify(app.events.errors));
    const sel = ev('ALTERNATIVE_SELECTED', { plan_id: 'PLAN-013' });
    assert.equal(sel.length, 1);
    assert.equal(sel[0].occurred_at, dMinus1);
    assert.match(sel[0].generation_reason, /권장 대안 물량상한 — 고르면 예상 판정 가능/);
    assert.equal(p4.getPlanState('PLAN-013').plan_status, '검토 중'); // 전 영업일에 고른 날은 철회하지 않는다
    await app.clock.advance({ to: dl13 });
    assert.equal(ev('PLAN_WITHDRAWN', { plan_id: 'PLAN-013' })[0].occurred_at, dl13); // 여전히 조건부면 확정기한 당일 철회

    // L1·L6·L7 화면: 철회한 기안의 발주안 처리는 문제 2 사건의 withdrawal.disposition을 따른다(문제 2 v2.3),
    // 금액은 문제 3 약정, SCM 확인 요청은 po_draft_orphaned. 입고 완료·예정일 경과 문장, 정기 보충 민감도
    const w13 = ev('PLAN_WITHDRAWN', { plan_id: 'PLAN-013' })[0];
    const W = (d) => ({ plan_id: 'PLAN-013', withdrawn_event_id: w13.event_id, disposition: d });
    const mark = (type, payload) => app.events.emit({ event_type: type, source_type: '계산', plan_id: 'PLAN-013', caused_by: w13.event_id, payload });
    await mark('PO_DRAFT_CANCELLED', { po_draft_id: 'POD-A', draft_version: 1, cancel_reason: '연결 기안 철회(발주 전달 전, 승인 발주안 취소)', linked_plan_ids: [], linked_plan_ids_before: ['PLAN-013'], withdrawal: W('취소') });
    await mark('PO_DRAFT_CREATED', { po_draft_id: 'POD-B', draft_version: 1, sku_id: 'SKU-2003', order_qty: 16000, change_kind: 'linked_plans_changed', linked_plan_ids: [], linked_plan_ids_before: ['PLAN-013'], withdrawal: W('발주 전달 뒤 남음') });
    await p4.requestInfo({ request_topic: 'po_draft_orphaned', requested_to: 'SCM', plan_id: 'PLAN-013', subject_type: 'po_draft', subject_id: 'POD-B', questions: ['취소·조정 가능?'] });
    await mark('PO_DRAFT_CREATED', { po_draft_id: 'POD-C', draft_version: 1, sku_id: 'SKU-2003', order_qty: 16000, change_kind: 'linked_plans_changed', linked_plan_ids: ['PLAN-007'], linked_plan_ids_before: ['PLAN-007', 'PLAN-013'], withdrawal: W('기안만 뗌(발주 전달 뒤)') });
    await mark('PO_DRAFT_CREATED', { po_draft_id: 'POD-D', draft_version: 2, sku_id: 'SKU-3003', order_qty: 10000, linked_plan_ids: ['PLAN-014'], linked_plan_ids_before: ['PLAN-013', 'PLAN-014'], withdrawal: W('기안만 뗌(수량 재계산, 다시 승인)') });
    await mark('PO_DRAFT_CREATED', { po_draft_id: 'POD-E', draft_version: 1, sku_id: 'SKU-4002', order_qty: 12000, change_kind: 'linked_plans_changed', linked_plan_ids: ['PLAN-009'], linked_plan_ids_before: ['PLAN-009', 'PLAN-013'], withdrawal: W('기안만 뗌') });
    const p3 = app.module('p3');
    Object.assign(p3, {
      listCommitments: () => [
        { commitment_id: 'CMT-POD-A', source_id: 'POD-A', amount_krw: 5.24e8 },
        { commitment_id: 'CMT-POD-B', source_id: 'POD-B', amount_krw: 2.02e8 },
      ],
      approvalView: () => ({ cash_impact: { before: { min_balance_krw: 1.383e9, min_date: '2026-08-21', shortfall_window_start: '2026-07-21', shortfall_window_end: '2026-08-28' },
        after: { min_balance_krw: 1.2e9, min_date: '2026-08-21', shortfall_window_start: '2026-07-21', shortfall_window_end: '2026-08-28' },
        scm_sensitivity: { connected: true, confirmed_row_count: 53, in_horizon_row_count: 32, in_horizon_amount_krw: 1.1113e10,
          baseline: { min_balance_krw: 1.383e9, min_date: '2026-08-21', shortfall_window_start: '2026-07-21', shortfall_window_end: '2026-08-28' },
          with_scm_replenishment: { min_balance_krw: -5.5e9, min_date: '2026-09-21', shortfall_window_start: '2026-07-21', shortfall_window_end: '2026-09-30' },
          route_difference: { label: '정기 보충 발주를 넣으면 그룹 CEO 경로(기준선은 Masil 대표)' } } } }),
    });
    Object.assign(p2, {
      poDrafts: ({ po_draft_id } = {}) => [{ po_draft_id, sku_id: 'SKU-1002', order_qty: 24000, linked_plan_ids: [] }], // 취소 사건에는 품목·수량이 없어 발주안에서 읽는다
      inboundSchedule: () => ({ rows: [
        { inbound_row_id: 'IB-1', sku_id: 'SKU-T', source_ref: 'SPO-0005', qty: 16000, eta_date: '2026-08-18', supply_status: '입고 완료', received_qty: 16000, received_on: '2026-08-18' },
        { inbound_row_id: 'IB-2', sku_id: 'SKU-T', source_ref: 'SCM-BR:SKU-T:1', qty: 500, eta_date: '2026-09-01', supply_status: '예정일 경과·미확약', original_eta_date: '2026-09-01', expected_now_week: '2026-09-07' },
      ] }),
    });
    Object.assign(app.module('p1'), { entryView: () => ({ reference: { skus: [{ sku_id: 'SKU-T', sku_name: '테스트 크림' }] } }) });
    const v13 = await get('/api/p4/user/plans/PLAN-013');
    assert.deepEqual(v13.why.po_fate.map((x) => [x.po_draft_id, x.disposition, x.kind]), [['POD-A', '취소', 'cancelled'], ['POD-B', '발주 전달 뒤 남음', 'residual'],
      ['POD-C', '기안만 뗌(발주 전달 뒤)', 'shared'], ['POD-D', '기안만 뗌(수량 재계산, 다시 승인)', 'requantified'], ['POD-E', '기안만 뗌', 'detached']]);
    const fate = Object.fromEntries(v13.why.po_fate.map((x) => [x.po_draft_id, x]));
    assert.match(fate['POD-A'].text, /보충 발주\(SKU-1002 24,000개\)는 발주 전이라 취소했습니다. 약정과 현금 유출\(5\.24억 원\)에서 뺐습니다/);
    assert.match(fate['POD-B'].text, /발주가 이미 나가 취소하지 않고 남았습니다\(기안 철회 뒤 남은 발주\). 현금 유출 2\.02억 원은 그대로입니다. SCM에 Corevia 취소·수량 조정이 가능한지 물었습니다/);
    assert.ok(fate['POD-B'].request_id);
    assert.match(fate['POD-C'].text, /발주가 이미 나갔고 다른 기안\(기안 007\)도 쓰고 있어 그대로 둡니다/);
    assert.match(fate['POD-D'].text, /수량을 다시 계산했습니다\(SKU-3003 10,000개, 다시 승인 필요\)/);
    assert.match(fate['POD-E'].text, /다른 기안\(기안 009\)도 쓰고 있어 그대로 두고 이 기안 몫만 뺐습니다/);
    assert.match(v13.why.cash.sensitivity.text, /정기 보충 발주 53건\(재전망 기간 지급 32건, 111\.13억 원\)을 넣으면 최저 잔액 13\.83억 원\(8월 21일\) → -55\.00억 원\(9월 21일\).*그룹 CEO 경로/);
    assert.match(v13.why.cash.sensitivity.basis, /원본 발주 단가.*SCM 모의 회신.*기준선에는 넣지 않고 참고로만/);
    const v16 = await get('/api/p4/user/plans/PLAN-016');
    const kinds = v16.why.supply_commit.map((x) => x.kind);
    assert.ok(kinds.includes('arrived') && kinds.includes('overdue'), kinds.join(','));
    assert.match(v16.why.supply_commit.find((x) => x.kind === 'overdue').text, /테스트 크림 SCM 보충 1차: 도착 예정일 9월 1일이 지났는데 공급 확약이 없습니다. 지금은 9월 7일 주 도착으로 보고/);
    assert.match(v16.why.supply_commit.find((x) => x.kind === 'arrived').text, /입고 완료 — 기존 발주분 16,000개\(8월 18일\).*모의 입력/);

    // L9: 문제 4 카드의 제목·규칙·결과·사용한 데이터에 사건 이름·코드·영문 필드 이름이 없다
    const RX = /\b[a-z]+(?:_[a-z0-9]+)+\b|\b[A-Z]{2,}(?:_[A-Z0-9]+)+\b/;
    for (const e of app.events.query({ limit: 1e9 }).filter((x) => x.emitted_by === 'p4')) {
      const c = p4.describeEvent(e);
      if (!c) continue;
      for (const t of [c.title, c.rule, c.result, c.next, ...(c.inputs ?? []).map((i) => `${i.label} ${i.value}`)]) assert.doesNotMatch(String(t ?? ''), RX, `${e.event_type} ${e.event_id}: ${t}`);
    }
  } finally {
    delete globalThis.P4_SUPPLY;
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('조정자 마지막 조정: S-CEO-FLOOR에서는 지정 사례 PLAN-011에 공급 위험 수용 회신이 없고(S4-08-12 미수용), 확정기한까지 조건부로 남아 기본 규칙대로 철회된다', async () => {
  globalThis.P4_SUPPLY = { 'PLAN-011': 'baseline_replenishment_unconfirmed' };
  const root = makeRoot({ withOthers: true });
  const app = allAuto(await createApp({ rootDir: root, dbPath: ':memory:', env: {}, log: quiet }));
  const port = await app.listen(0, '127.0.0.1');
  const p4 = app.module('p4');
  const ev = (t, f = {}) => app.events.query({ event_type: t, limit: 1e9, ...f });
  try {
    const set = await (await fetch(`http://127.0.0.1:${port}/api/p4/scenarios`, { method: 'POST', body: JSON.stringify({ scenarios: ['S-CEO-FLOOR'] }) })).json();
    assert.deepEqual(set.scenarios, ['S-CEO-FLOOR']);
    const deadline = ev('PLAN_RECEIVED', { plan_id: 'PLAN-011' })[0].payload.contract_deadline;
    await app.clock.advance({ to: deadline });
    assert.equal(app.events.errors.length, 0, JSON.stringify(app.events.errors));
    assert.equal(ev('APPROVAL_REPLIED', { plan_id: 'PLAN-011' }).filter((e) => e.payload.supply_risk_accepted).length, 0);
    const st = p4.getPlanState('PLAN-011');
    assert.equal(st.plan_status, '철회');
    assert.notEqual(st.decision_snapshot.confirmed_under_risk, true);
    assert.match(ev('PLAN_WITHDRAWN', { plan_id: 'PLAN-011' })[0].payload.reason, /^확정기한까지 공급이 확인되지 않음/);
  } finally {
    delete globalThis.P4_SUPPLY;
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('화면 다듬기: 근거 > 공급은 결론 한 문장 + 조건 종류별 묶음(상세는 접음), 같은 내용을 공급 확약 구역에 두 번 싣지 않고, 조건이 하나면 한 문장', async () => {
  const root = makeRoot({ withOthers: true });
  const app = allAuto(await createApp({ rootDir: root, dbPath: ':memory:', env: {}, log: quiet }));
  const port = await app.listen(0, '127.0.0.1');
  const get = async (p) => (await fetch(`http://127.0.0.1:${port}${p}`)).json();
  try {
    const rows = (sku, n, first) => Array.from({ length: n }, (_, i) => ({ source_ref: `SCM-BR:${sku}:${i + 1}`, eta_date: i ? '2026-10-26' : first, qty: 30000 }));
    const many = [
      { condition_type: 'inbound_unconfirmed', sku_id: 'SKU-1001', inbound_rows: [{ source_ref: 'SPO-0001', eta_date: '2026-09-18', qty: 24000 }] },
      { condition_type: 'baseline_replenishment_unconfirmed', reason: '보충 계획 미확약', sku_id: 'SKU-1001', inbound_rows: rows('SKU-1001', 3, '2026-09-28') },
      { condition_type: 'baseline_replenishment_unconfirmed', reason: '보충 계획 미확약', sku_id: 'SKU-1002', inbound_rows: rows('SKU-1002', 3, '2026-09-28') },
      { condition_type: 'baseline_replenishment_unconfirmed', reason: '보충 계획 미확약', sku_id: 'SKU-1003', inbound_rows: rows('SKU-1003', 2, '2026-09-28') },
      { condition_type: 'baseline_replenishment_unconfirmed', reason: '보충 계획 미확약', sku_id: 'SKU-1004', inbound_rows: rows('SKU-1004', 3, '2026-09-28') },
      { condition_type: 'reorder_required', sku_id: 'SKU-1002', po_draft_id: 'POD-0007', order_deadline: '2026-08-28', needed_by_week: '2026-11-16', additional_reorder_qty_ea: 2130, po_draft_preview: { order_qty: 24000 } },
    ];
    const one = [{ condition_type: 'supply_commitment_pending', sku_id: 'SKU-3003', po_draft_id: 'POD-0003', qty: 10000 }];
    // SCM이 보충 계획을 아직 확인하지 않은 품목은 입고 행이 없다('정기 보충 0건'이 아니라 확인 대기로 말한다)
    const none = [{ condition_type: 'baseline_replenishment_unconfirmed', reason: 'SCM 미확인', sku_id: 'SKU-3003', inbound_rows: [] },
      { condition_type: 'inbound_unconfirmed', sku_id: 'SKU-3003', inbound_rows: [{ source_ref: 'SPO-0010', eta_date: '2026-08-27', qty: 10000 }] }];
    const cbOf = { 'PLAN-011': many, 'PLAN-014': one, 'PLAN-002': none };
    const longText = '조건이 채워지면 공급할 수 있습니다. SKU-1001 SCM 기준 수요 보충 입고 SCM 정기 보충(SKU-1001 1회차)(2026-09-28)…';
    const p2 = app.module('p2');
    const baseLatest = p2.latestSupplyJudgment;
    Object.assign(p2, {
      latestSupplyJudgment: (id) => (cbOf[id] ? { plan: { supply_judgment_id: `SJ-${id}`, supply_verdict: '조건부', condition_basis: cbOf[id] }, skus: [] } : baseLatest(id)),
      planDecision: (id) => (cbOf[id] ? { headline: longText, reasons: [], conditions: cbOf[id].map((c) => ({ ...c, text: longText })), alternatives: [], next_actions: [] } : null),
      pendingSupplyCommitments: () => [{ record_id: 'S2-CVC-SKU-3003-1', po_draft_id: 'POD-0003', due_date: '2026-07-21', applied: false }],
      baselineReplenishment: () => [{ plan_status: 'SCM 확인·Corevia 미확약' }],
    });
    Object.assign(app.module('p3'), { commitmentBySource: (src) => (src === 'POD-0003' ? { approval_status: '승인' } : src === 'POD-0007' ? { approval_status: '결재 대기' } : null) });
    Object.assign(app.module('p1'), { entryView: (id) => ({ reference: { skus: id === 'PLAN-011'
      ? [['SKU-1001', '더마 리페어 세럼'], ['SKU-1002', '더마 카밍 크림'], ['SKU-1003', '더마 배리어 로션'], ['SKU-1004', '더마 시카 앰플']].map(([sku_id, sku_name]) => ({ sku_id, sku_name }))
      : [{ sku_id: 'SKU-3003', sku_name: '색조 아이팔레트' }] } }) }); // PLAN-002·014는 색조
    const s11 = (await get('/api/p4/user/plans/PLAN-011')).why;
    assert.equal(s11.supply.summary, '조건이 채워지면 공급할 수 있습니다. 남은 조건 3가지:');
    assert.deepEqual(s11.supply.groups, [
      'Corevia 확약을 기다리는 입고: 더마 4개 품목의 정기 보충 11건, 가장 빠른 도착 9월 28일',
      '확정되지 않은 기존 발주: 더마 리페어 세럼 1건',
      '승인 전 보충 발주: 더마 카밍 크림 24,000개, 8월 28일까지 승인·발주',
    ]);
    assert.equal(s11.supply.details.length, 6); // 품목·회차별 상세는 접어 둔다(화면)
    assert.match(s11.supply.details[0], /^더마 리페어 세럼 정기 보충: 1회차 9월 28일 30,000개, 2회차 10월 26일/);
    // 조건에서 나온 줄(정기 보충 확약 전·기존 발주 미확약)은 공급 확약 구역에 다시 싣지 않는다
    assert.equal(s11.supply_commit.filter((l) => /SCM 기준 수요 보충 계획|기존 발주분 입고가 아직/.test(l.text)).length, 0);
    for (const t of [s11.supply.summary, ...s11.supply.groups]) assert.doesNotMatch(t, /SKU-|SCM-BR|\d{4}-\d{2}-\d{2}/);
    const s14 = (await get('/api/p4/user/plans/PLAN-014')).why;
    assert.equal(s14.supply.summary, '조건이 채워지면 공급할 수 있습니다 — 내부 승인만 난 보충 발주: 색조 아이팔레트 10,000개, 회신 예정 7월 21일.');
    assert.deepEqual(s14.supply.groups, []);
    assert.equal(s14.supply_commit.filter((l) => /내부 승인됐지만 Corevia 공급 확약을 기다리는/.test(l.text)).length, 0);
    const s02 = (await get('/api/p4/user/plans/PLAN-002')).why.supply;
    assert.equal(s02.groups[0], 'SCM 보충 계획 확인을 기다리는 품목: 색조 아이팔레트(판매 기간 뒤 기존 판매분이 모자랄 수 있음)');
    assert.doesNotMatch(s02.groups.join(' '), /0건/);
    // 철회한 기안: 결론은 철회 때 상태로, 취소된 보충 발주는 '취소된 보충 발주'로(회신 대기로 보이지 않게)
    await fetch(`http://127.0.0.1:${port}/api/p4/plans/PLAN-011/withdraw`, { method: 'POST', body: JSON.stringify({ reason: '시험' }) });
    Object.assign(app.module('p3'), { commitmentBySource: (src) => (src === 'POD-0007' ? { approval_status: '취소', cancel_info: { kind: '기안 철회로 취소' } } : null) });
    const w11 = (await get('/api/p4/user/plans/PLAN-011')).why.supply;
    assert.equal(w11.summary, '철회 때 공급은 조건부였습니다. 남아 있던 조건 3가지:');
    assert.equal(w11.groups[2], '취소된 보충 발주: 더마 카밍 크림 24,000개(기안 철회로 취소)');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
