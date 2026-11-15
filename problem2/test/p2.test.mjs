import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, pick } from './helpers.mjs';
import * as C from '../src/calc.mjs';
import { createApp } from '../../app/main.mjs';

// SCM 기준 수요 보충 계획 회신(S2-SCM-BR, 07-03 자료)을 넣은 뒤의 상태. 이 회신이 없으면 판매 기간 뒤 부족은 '기준 수요 보충 미확인' 조건이 된다(명세 0절 5)
const applyBR = (p2) => p2.applyBaselinePlan({ date: '2026-07-03' });
// 07-02 회신: 운송 중 입고(S2-ETA-IT v1)와 기발주 Corevia 공급 회신(S2-CVC po, 07-02분)
const applyV1 = async (app, p2) => {
  const ids = (await app.router.match('GET', '/api/p2/mock').handler({})).inbound_replies.filter((r) => r.data_version === 'v1').map((r) => r.record_id);
  await p2.applyInboundReply({ record_ids: ids });
  await p2.applySupplyReplies({ date: '2026-07-02' });
};

test('원본 고정값: 기발주·운송 중·단가·목표 재고 주수 (명세 3.1·3.2)', async () => {
  const { app, p2, close } = await makeApp();
  try {
    const raw = app.raw.load('02_masil/inventory/sc_purchase_orders_ms.csv');
    assert.equal(raw.length, 14);
    assert.equal(raw.reduce((s, r) => s + Number(r.amount_krw), 0), 3_749_760_000);
    const v0 = p2.inboundSchedule({ inbound_schedule_version: 'IS-v0' });
    assert.equal(v0.rows.length, 28);
    const spo1 = pick(v0.rows, { source_ref: 'SPO-0001' });
    assert.equal(spo1.eta_date, '2026-09-18'); // 06-26 + 12주
    assert.equal(spo1.qty, 24000);
    assert.equal(spo1.eta_status, '미회신');
    assert.equal(spo1.source_type, '원본도출');
    assert.equal(pick(v0.rows, { source_ref: 'SPO-0011' }).eta_date, '2026-08-19');
    assert.equal(pick(v0.rows, { source_ref: 'IN_TRANSIT:SKU-1001' }).qty, 15821);
    assert.equal(v0.rows.filter((r) => r.source_ref.startsWith('SPO-')).reduce((s, r) => s + r.qty, 0), 226_000);
    const res = await app.router.match('GET', '/api/p2/plan/PLAN-011').handler({ params: { plan_id: 'PLAN-011' } });
    const sku1001 = res.skus.find((s) => s.sku_id === 'SKU-1001');
    assert.equal(sku1001.moq, 24000);
    assert.equal(sku1001.target_stock_weeks, 16);
    assert.equal(sku1001.lead_time_weeks, 12);
    assert.equal(sku1001.baseline_weekly_qty, 7910.5);
    assert.deepEqual(p2.grid().weeks.length, 26);
    assert.equal(p2.grid().projection_end_week, '2026-12-28');
  } finally { await close(); }
});

test('추가분 0 전개: SKU-1001 07-06 주 31,033.5 EA, 08-03 주 품절, 09-14 주 회복 (v0)', async () => {
  const { p2, close } = await makeApp();
  try {
    const rows = p2.supplyProjectionBase({ sku_id: 'SKU-1001', inbound_scenario: 'on_schedule' });
    assert.equal(rows.length, 26);
    assert.equal(rows[0].projected_on_hand_qty, 31033.5); // 23,123 + 15,821 − 7,910.5
    assert.equal(rows[0].projected_cover_weeks, 3.92);     // 문제 정의 문서 3.9주
    const bos = p2.baseOnlyShortfall({ sku_id: 'SKU-1001' });
    assert.equal(pick(bos, { inbound_scenario: 'on_schedule' }).first_stockout_week, '2026-08-03');
    assert.equal(pick(bos, { inbound_scenario: 'on_schedule' }).recovery_week, '2026-09-14');
    // 확정 입고만: 운송 중도 미회신이라 빼면 현재고 2.9주 → 07-20 주 품절
    assert.equal(pick(bos, { inbound_scenario: 'not_arrived' }).first_stockout_week, '2026-07-20');
    // 잔여 여지는 두 입고 경우 모두
    const room = p2.residualHeadroom({ plan_id: 'PLAN-011', sku_id: 'SKU-1001' });
    assert.equal(room.length, 52);
    assert.equal(pick(room, { week_start: '2026-07-06', inbound_scenario: 'on_schedule' }).residual_headroom_qty, 0); // 뒤에 품절이 있어 여지 0
    // 더마는 07-01 기준 막을 수 없는 구간이 09-21 주까지(07-10 발주 + 12주 = 10-02 → 09-28 주부터 보충 가능)
    // 09-14 주: SPO-0001 24,000 입고 뒤 09-14 주말 16,089.5, 09-21 주말 8,179 → 구간 안 최소 8,179
    assert.equal(pick(room, { week_start: '2026-09-14', inbound_scenario: 'on_schedule' }).residual_headroom_qty, 8179);
    assert.equal(pick(room, { week_start: '2026-09-28', inbound_scenario: 'on_schedule' }).residual_headroom_qty, null);
    assert.equal(pick(room, { week_start: '2026-09-28', inbound_scenario: 'on_schedule' }).supply_window, 'reorder');
    // SKU-3001(색조, 리드타임 6주): 막을 수 없는 구간 07-06~08-10 주. 07-27 주말 14,032 − 4 × 882.5 = 10,502가 구간 안 최소
    const lip = p2.residualHeadroom({ plan_id: 'PLAN-002', sku_id: 'SKU-3001', inbound_scenario: 'on_schedule' });
    assert.equal(pick(lip, { week_start: '2026-07-06' }).residual_headroom_qty, 10502);
    assert.equal(pick(lip, { week_start: '2026-08-17' }).residual_headroom_qty, null);
    const b1001 = pick(p2.baseOnlyShortfall({ sku_id: 'SKU-1001' }), { inbound_scenario: 'on_schedule' });
    assert.equal(b1001.reorder_reach_week, '2026-09-28');
    assert.equal(b1001.unpreventable_end_week, '2026-09-21');
    assert.equal(b1001.first_unpreventable_stockout_week, '2026-08-03');
  } finally { await close(); }
});

test('수요 입력이 없으면 판정불가 + 방향 판단, 문제 1이 없어도 죽지 않는다', async () => {
  const { app, p2, close } = await makeApp();
  try {
    const j = p2.latestSupplyJudgment('PLAN-011');
    assert.equal(j.plan.supply_verdict, '판정불가');
    assert.match(j.plan.direction_note, /막을 수 없는 기존 수요 품절: SKU-1001 2026-08-03~2026-09-07/);
    assert.equal(j.skus.length, 4);
    assert.equal(app.events.query({ event_type: 'SUPPLY_JUDGED' }).length, 25);
    assert.equal(app.events.query({ event_type: 'SUPPLY_PROJECTED' }).length, 1);
  } finally { await close(); }
  const bare = await makeApp({ withP1: false });
  try {
    assert.equal(bare.app.modules.find((m) => m.id === 'p2').error, null);
    assert.equal(bare.p2.supplyProjectionBase().length, 0);
    const j = bare.p2.latestSupplyJudgment('PLAN-002');
    assert.equal(j.plan.supply_verdict, '판정불가');
    assert.match(j.plan.direction_note, /연결 안 됨/);
  } finally { await bare.close(); }
});

test('07-02 회신: 운송 중 입고 회신과 기발주 Corevia 공급 회신을 한 번씩만 반영하고, 모순 회신은 확인 필요로 예상 그대로 (A1, v2.1)', async () => {
  const { app, p2, close } = await makeApp();
  try {
    const ids = (await app.router.match('GET', '/api/p2/mock').handler({})).inbound_replies.filter((r) => r.data_version === 'v1').map((r) => r.record_id);
    assert.equal(ids.length, 14); // 운송 중 14. 기발주 입고 회신은 Corevia 공급 회신(S2-CVC)으로 합쳤다
    const r = await p2.applyInboundReply({ record_ids: ids });
    assert.equal(r.inbound_schedule_version, 'IS-v1');
    assert.equal((await p2.applyInboundReply({ record_ids: ids })).already_applied, true);
    const sc = await p2.applySupplyReplies({ date: '2026-07-02' });
    assert.equal(sc.length, 13); // SPO-0002~0014(0001은 07-08 미확인)
    assert.equal((await p2.applySupplyReplies({ date: '2026-07-02' })).length, 0); // 다시 넣어도 없음
    const v1 = p2.inboundSchedule();
    assert.deepEqual(['eta_date', 'eta_status', 'supply_status'].map((k) => pick(v1.rows, { source_ref: 'SPO-0004' })[k]), ['2026-09-22', '지연', '확약']);
    assert.equal(pick(v1.rows, { source_ref: 'SPO-0001' }).supply_status, '예상'); // 회신 전
    assert.equal(pick(v1.rows, { source_ref: 'SPO-0012' }).supply_status, '예상'); // 모순 회신 → 확인 필요
    assert.equal(p2.supplyCommitments({ target_id: 'SPO-0012' })[0].validation_status, '확인 필요');
    assert.equal(pick(v1.rows, { source_ref: 'IN_TRANSIT:SKU-1004' }).eta_date, '2026-07-20');
    // SKU-1004: 운송 중 07-20 주 입고여도 첫 품절은 08-03 주 그대로, 회복은 기발주 지연으로 09-21 주
    const b = pick(p2.baseOnlyShortfall({ sku_id: 'SKU-1004' }), { inbound_scenario: 'on_schedule' });
    assert.equal(b.first_stockout_week, '2026-08-03');
    assert.equal(b.recovery_week, '2026-09-21');
    // 리드타임보다 이른 회신은 거부(조기 공급은 시나리오)
    await assert.rejects(() => app.router.match('POST', '/api/p2/inbound/confirm').handler({
      body: { rows: [{ source_ref: 'SPO-0005', eta_date: '2026-08-10', eta_status: '확정', eta_qty: 16000 }] } }), /조기 공급/);
  } finally { await close(); }
});

test('공급 판정: PLAN-011 더마 10% 2주 → SKU-1001 캠페인 부족 1,582 EA, 08-03 주부터 (명세 4.4)', async () => {
  const { app, p1, p2, close } = await makeApp();
  try {
    await applyBR(p2); // SCM 보충 계획 회신 뒤: 08-03 주 부족은 기존 수요 보충과 무관한 캠페인 몫으로 가린다
    await p1.__register('PLAN-011', { uplift_pct: 10, sale_start_week: '2026-07-06', sale_weeks: 2 });
    const j = p2.latestSupplyJudgment('PLAN-011');
    assert.equal(j.plan.supply_judgment_version, 2);
    assert.equal(j.plan.supply_verdict, '부족');
    const s = pick(j.skus, { sku_id: 'SKU-1001' });
    assert.equal(s.shortage_qty_campaign_ea, 1582); // round(7,910.5 × 10%) = 791 × 2주
    assert.equal(s.first_shortage_week, '2026-08-03');
    assert.equal(s.preventable_by_reorder, false);   // 오늘 발주해도 09-28 주 도착
    assert.equal(s.shortage_qty_base_ea > 0, true);    // 기존 수요만으로도 공백
    assert.equal(j.plan.is_simulation, true);
    assert.deepEqual(j.plan.premise_refs, { demand_input_id: 'DI-PLAN-011', demand_input_version: 1, baseline_demand_version: 'BD-stub-v1',
      inbound_schedule_version: 'IS-v1', ordering_rule_version: C.ORDERING_RULE_VERSION });
    // 같은 입력 → 같은 결과(강제 재판정해도 내용 동일)
    await app.router.match('POST', '/api/p2/rejudge').handler({ body: { plan_id: 'PLAN-011', force: true } });
    const again = p2.latestSupplyJudgment('PLAN-011');
    const strip = ({ supply_judgment_version, ...r }) => r;
    assert.deepEqual(strip(again.plan), strip(j.plan));
    // 대안
    const alts = p2.alternatives({ plan_id: 'PLAN-011' });
    assert.equal(app.events.query({ event_type: 'ALTERNATIVES_COMPUTED', plan_id: 'PLAN-011' }).length >= 1, true);
    const cap = alts.find((a) => a.alternative_type === '물량상한');
    assert.equal(cap.feasible, false); // 기존 수요만으로 공백 → 증가율 0 말고는 부족
    // F (1): 캠페인 부족이 모두 막을 수 없는 구간에 있어 보충 가능 구간의 캠페인 추가 필요량이 없다 → 캠페인 발주안 없음
    const reorder = alts.find((a) => a.alternative_type === '보충발주' && a.sku_id === 'SKU-1001');
    assert.equal(reorder.feasible, false);
    assert.match(reorder.remaining_checks, /기준 수요 보충은 범위 밖/);
    await assert.rejects(p2.selectAlternative({ alternative_id: reorder.alternative_id, selected_by: 'SCM-PLANNER' }));
    assert.equal(app.events.query({ event_type: 'PO_DRAFT_CREATED' }).length, 0);
    // 기준 수요 보충은 SCM 회신(S2-SCM-BR)으로만 들어간다. 더마는 SCM 확인·Corevia 미확약(L-02 97%)이라 예상 입고
    const br = p2.baselineReplenishment({ sku_id: 'SKU-1001' })[0];
    assert.equal(br.plan_status, 'SCM 확인·Corevia 미확약');
    assert.ok(br.plan_rows.length > 0 && br.plan_rows.every((r) => r.supply_status === '예상'));
    assert.equal('amount_krw' in br, false); // 금액·지급일은 만들지 않는다
    assert.match(br.cash_note, /재전망에 들어가지 않는다/);
    const brReq = app.events.query({ event_type: 'INFO_REQUESTED', limit: 1e6 }).filter((e) => e.payload.request_topic === 'baseline_replenishment');
    assert.equal(brReq.length, 14); // SKU별
    assert.match(brReq.find((e) => e.subject_id === 'SKU-1001').payload.questions[0], /발주 예정일·수량·Masil 도착 예정일과 Corevia 확약 여부/);
    assert.ok(alts.some((a) => a.alternative_type === '조기분할요청' && a.po_id === 'SPO-0001'));
    // 조기 요청 → Corevia 불가 회신(S-SUP-REPLY) → 그 SKU의 조기 요청 대안이 빠진다
    const early = p2.alternatives({ plan_id: 'PLAN-011' }).find((a) => a.alternative_type === '조기분할요청' && a.sku_id === 'SKU-1001');
    const r = await p2.selectAlternative({ alternative_id: early.alternative_id, selected_by: 'SCM-PLANNER' });
    assert.equal(app.events.query({ event_type: 'INFO_REQUESTED' }).some((e) => e.payload.request_topic === 'supply_request'), true);
    const reply = await p2.applySupplierReply({ supply_request_id: r.supply_request.supply_request_id });
    assert.equal(reply.supply_request.reply_result, '불가');
    assert.equal(reply.supply_request.supply_request_status, '제외');
    assert.equal(app.events.get(reply.event_id).scenario_id, 'BASE'); // 원본 제약을 바꾸지 않는 '불가'라 BASE (조정자 확정 (5))
    assert.equal(p2.alternatives({ plan_id: 'PLAN-011' }).some((a) => a.alternative_type === '조기분할요청' && a.sku_id === 'SKU-1001'), false);
  } finally { await close(); }
});

test('누적 순서: 같은 SKU 앞 순번의 추가분이 뒤 기안의 잔여 여지를 줄인다 (C5)', async () => {
  const { p1, p2, close } = await makeApp();
  try {
    // PLAN-002(기한 07-17)가 PLAN-006(기한 08-14)보다 앞 순번. 둘 다 색조.
    const before = pick(p2.residualHeadroom({ plan_id: 'PLAN-006', sku_id: 'SKU-3001', inbound_scenario: 'on_schedule' }), { week_start: '2026-07-06' }).residual_headroom_qty;
    await p1.__register('PLAN-002', { uplift_pct: 30, sale_start_week: '2026-07-20', sale_weeks: 4 });
    const after = pick(p2.residualHeadroom({ plan_id: 'PLAN-006', sku_id: 'SKU-3001', inbound_scenario: 'on_schedule' }), { week_start: '2026-07-06' }).residual_headroom_qty;
    // round(882.5 × 30%) = 265. 구간 안 최소는 07-27 주말이고 PLAN-002의 07-20·07-27 두 주분이 먼저 빠진다 → 530
    assert.equal(Math.round((before - after) * 100) / 100, 265 * 2);
    const order = p2.planOrder({ sku_id: 'SKU-3001' });
    assert.ok(pick(order, { plan_id: 'PLAN-002' }).plan_order_rank < pick(order, { plan_id: 'PLAN-006' }).plan_order_rank);
    const j = p2.latestSupplyJudgment('PLAN-002');
    assert.ok(['가능', '조건부', '부족'].includes(j.plan.supply_verdict));
    for (const s of j.skus) assert.ok(s.shortage_qty_campaign_ea >= 0);
  } finally { await close(); }
});

test('원료 지연 정정 회신(07-13): SPO-0005~0007 2주 지연 → 새 입고 버전과 기초 판정 갱신 (v2.1)', async () => {
  const { app, p1, p2, close } = await makeApp();
  try {
    await p1.__register('PLAN-001', { uplift_pct: 20, sale_start_week: '2026-07-27', sale_weeks: 3 });
    await applyV1(app, p2);
    const prev = p2.latestSupplyJudgment('PLAN-001').plan;
    await app.clock.advance({ days: 1 }); // 같은 날이면 결론이 같은 전제 변경은 그날 버전에 흡수된다(F)
    const before = p2.inboundSchedule().inbound_schedule_version;
    const r = await p2.applySupplyReplies({ date: '2026-07-13' }); // 07-13분: 기초 정정 3건(+ 그 전 날짜분)
    const c5 = p2.supplyCommitments({ target_id: 'SPO-0005' })[0];
    assert.deepEqual([c5.reply_version, c5.reply_status, c5.offered_eta_date, c5.material_id, c5.material_status], [2, '가능', '2026-09-01', 'M-A', '확보 예정']);
    assert.match(c5.material_evidence, /원료 M-A.*확인 불가/);
    const cur = p2.inboundSchedule();
    assert.notEqual(cur.inbound_schedule_version, before);
    assert.deepEqual([pick(cur.rows, { source_ref: 'SPO-0005' }).eta_date, pick(cur.rows, { source_ref: 'SPO-0005' }).eta_status], ['2026-09-01', '지연']);
    const now = p2.latestSupplyJudgment('PLAN-001').plan;
    assert.ok(now.supply_judgment_version > prev.supply_judgment_version); // 회신 → 입고 일정 → 다시 판정
    const last = r.filter((x) => x.inbound_event_id).at(-1);
    assert.equal(p2.judgmentCheck({ plan_id: 'PLAN-001', trigger_event_id: last.inbound_event_id }).checked, true);
  } finally { await close(); }
});

test('AI 구조화: 확인 전에는 반영하지 않고, 확인 뒤 사람입력으로 반영 / 키 없으면 미연결', async () => {
  const output = { rows: [{ source_ref: 'SPO-0013', eta_date: '2026-08-24', eta_status: '지연', eta_qty: 16000 }], unclear_reasons: [] };
  const fetchImpl = async () => ({ ok: true, json: async () => ({ model: 'anthropic/claude-opus-5.5', choices: [{ message: { content: JSON.stringify(output) } }] }) });
  const { app, p2, close } = await makeApp({ env: { OPENROUTER_API_KEY: 'x' }, fetchImpl });
  try {
    const s = await app.router.match('POST', '/api/p2/inbound/structure').handler({ body: { text: 'SPO-0013은 08-24에 들어갑니다' } });
    assert.equal(s.status, '연결');
    assert.equal(p2.inboundSchedule().inbound_schedule_version, 'IS-v0'); // 아직 반영 안 됨
    const c = await app.router.match('POST', '/api/p2/inbound/confirm').handler({ body: { ai_call_id: s.ai_call_id } });
    assert.equal(c.inbound_schedule_version, 'IS-v1');
    assert.equal(pick(p2.inboundSchedule().rows, { source_ref: 'SPO-0013' }).source_type, '사람입력');
    assert.equal(app.events.query({ event_type: 'AI_OUTPUT_REVIEWED' }).length, 1);
  } finally { await close(); }
  const off = await makeApp();
  try {
    const s = await off.app.router.match('POST', '/api/p2/inbound/structure').handler({ body: { text: 'x' } });
    assert.equal(s.status, '미연결');
  } finally { await off.close(); }
});

test('실제 저장소 루트에서도 문제 2 모듈이 붙는다(다른 모듈 유무와 무관)', async () => {
  const app = await createApp({ dbPath: ':memory:', env: {}, log: { log() {}, error() {} } });
  try {
    const m = app.modules.find((x) => x.id === 'p2');
    assert.equal(m.loaded, true);
    assert.equal(m.error, null);
    assert.ok(app.module('p2').latestSupplyJudgment('PLAN-002') !== undefined);
  } finally { await app.close(); }
});

test('막을 수 없는 구간 기준과 SCM 보충 계획: PLAN-002 색조 07-20 35% → 보충 계획 회신 전 조건부(기준 수요 보충 미확인)·뒤 가능, 60% → 부족, 08-31 100% → 조건부(보충 발주 필요)', async () => {
  const run = async (u, w, br = true) => {
    const { app, p1, p2, close } = await makeApp();
    try {
      // 입고 회신 v1(07-02 도착) 뒤: SKU-3003의 운송 중·SPO-0010이 확약이라 미확정 입고 조건은 붙지 않는다
      await applyV1(app, p2);
      if (br) await applyBR(p2);
      await p1.__register('PLAN-002', { uplift_pct: u, sale_start_week: w, sale_weeks: 4 });
      return p2.latestSupplyJudgment('PLAN-002');
    } finally { await close(); }
  };
  // 보충 계획 회신 전: 판매 기간 뒤 부족(캠페인이 앞당긴 기존 수요 품절)은 캠페인 몫인지 가릴 수 없어 조건으로 남는다
  const j0 = await run(35, '2026-07-20', false);
  assert.equal(j0.plan.supply_verdict, '조건부');
  assert.deepEqual(j0.plan.condition_basis.map((c) => [c.condition_type, c.sku_id, c.reason]), [['baseline_replenishment_unconfirmed', 'SKU-3003', '보충 계획 미확인']]);
  assert.equal((await run(35, '2026-07-20')).plan.supply_verdict, '가능'); // SCM 확인·Corevia 확약 보충 계획이 들어오면 풀린다
  const j100 = await run(100, '2026-08-31');
  assert.equal(j100.plan.supply_verdict, '조건부');
  const c = j100.plan.condition_basis.find((x) => x.condition_type === 'reorder_required');
  assert.deepEqual([c.sku_id, c.needed_by_week, c.reorder_reach_week, c.additional_reorder_qty_ea, c.covered_by_approved_qty_ea], ['SKU-3003', '2026-09-28', '2026-08-17', 8144.5, 0]);
  assert.equal(c.po_draft_preview.planned_order_date, '2026-07-10');
  assert.equal(j100.plan.preventable_by_reorder, true);
  const j60 = await run(60, '2026-07-20');
  assert.equal(j60.plan.supply_verdict, '부족'); // 2,568 EA × 4주 → 08-10 주(막을 수 없는 구간)에 품절
  assert.equal(pick(j60.skus, { sku_id: 'SKU-3003' }).first_shortage_week, '2026-08-10');
});

test('REVIEW_OPENED: rejudge=false면 재계산하지 않고, true면 새 버전을 caused_by로 낸다 (조정자 확정 (5))', async () => {
  const { app, p2, close } = await makeApp();
  try {
    const v = p2.latestSupplyJudgment('PLAN-002').plan.supply_judgment_version;
    const open = (rejudge) => app.events.emit({ event_type: 'REVIEW_OPENED', source_type: '계산', plan_id: 'PLAN-002',
      payload: { review_id: 'RV-T', target_type: 'supply_judgment', target_id: 'SJ-PLAN-002', rejudge } }, 'p4');
    await open(false);
    assert.equal(p2.latestSupplyJudgment('PLAN-002').plan.supply_judgment_version, v);
    const ev = await open(true);
    assert.equal(p2.latestSupplyJudgment('PLAN-002').plan.supply_judgment_version, v + 1);
    assert.equal(app.events.query({ event_type: 'SUPPLY_JUDGED', plan_id: 'PLAN-002', order: 'desc', limit: 1 })[0].caused_by, ev.event_id);
  } finally { await close(); }
});

test('전제 변경에는 바로 다시 판정하고 caused_by에 트리거를 남긴다', async () => {
  const { app, p1, close } = await makeApp();
  try {
    await p1.__register('PLAN-011', { uplift_pct: 10, sale_start_week: '2026-07-06', sale_weeks: 2 });
    const trig = app.events.query({ event_type: 'DEMAND_INPUT_REGISTERED', plan_id: 'PLAN-011' })[0];
    assert.ok(app.events.query({ event_type: 'SUPPLY_JUDGED', plan_id: 'PLAN-011' }).some((e) => e.caused_by === trig.event_id));
  } finally { await close(); }
});

const P4_STUB = `
export function register(ctx) {
  const states = new Map();
  ctx.expose({
    getPlanState: (id) => ({ plan_id: id, plan_status: states.get(id) ?? '검토 중' }),
    listPlanStates: () => ctx.plans().map((p) => ({ plan_id: p.plan_id, plan_status: states.get(p.plan_id) ?? '검토 중' })),
    __set: (id, st) => states.set(id, st),
  });
}`;

test('조건부(보충 발주 필요)면 SKU별 조건 발주안을 바로 만들고 조건에 po_draft_id·발주 시한을 붙인다 (D (1))', async () => {
  const { app, p1, p2, close } = await makeApp();
  try {
    await applyV1(app, p2);
    await applyBR(p2);
    await p1.__register('PLAN-002', { uplift_pct: 100, sale_start_week: '2026-08-31', sale_weeks: 4 });
    const j = p2.latestSupplyJudgment('PLAN-002');
    const c = j.plan.condition_basis.find((x) => x.condition_type === 'reorder_required');
    assert.ok(c.po_draft_id);
    assert.equal(c.order_deadline, '2026-08-21'); // 09-28 주 금요일 10-02 − 6주
    const drafts = p2.poDrafts({ plan_id: 'PLAN-002' });
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].po_draft_id, c.po_draft_id);
    assert.equal(drafts[0].sku_id, 'SKU-3003');
    const created = app.events.query({ event_type: 'PO_DRAFT_CREATED', plan_id: 'PLAN-002' });
    assert.equal(created.length, 1);
    // 다시 판정해도 같은 조건 발주안을 다시 쓴다
    await app.router.match('POST', '/api/p2/rejudge').handler({ body: { plan_id: 'PLAN-002', force: true } });
    assert.equal(app.events.query({ event_type: 'PO_DRAFT_CREATED', plan_id: 'PLAN-002' }).length, 1);
    assert.equal(p2.planAlternatives('PLAN-002').condition_po_drafts.length, 1);
  } finally { await close(); }
});

test('새 버전은 전제나 결론이 바뀔 때만: 같은 전제의 재판정·날짜 경과는 사건을 내지 않는다 (D (2))', async () => {
  const { app, p1, p2, close } = await makeApp();
  try {
    await applyV1(app, p2); // 07-02·07-03 회신을 미리 넣어 둔다(날짜 경과로 들어오는 회신과 섞이지 않게)
    await applyBR(p2);
    await p1.__register('PLAN-011', { uplift_pct: 10, sale_start_week: '2026-07-06', sale_weeks: 2 });
    const n0 = app.events.query({ event_type: 'SUPPLY_JUDGED' }).length;
    await app.router.match('POST', '/api/p2/rejudge').handler({ body: {} }); // 강제 아님 → 바뀐 기안 없음
    assert.equal(app.events.query({ event_type: 'SUPPLY_JUDGED' }).length, n0);
    await app.clock.advance({ to: '2026-07-03' }); // 같은 주 안: 막을 수 없는 구간이 그대로
    assert.equal(app.events.query({ event_type: 'SUPPLY_JUDGED' }).length, n0);
  } finally { await close(); }
});

test('종결된 기안은 판정을 동결한다 (D (2))', async () => {
  const { app, p1, p2, close } = await makeApp({ extra: { 'problem4/src/index.mjs': P4_STUB } });
  try {
    const p4 = app.module('p4');
    // 문제 4 대역에는 PLAN_RECEIVED가 없으므로 첫 판정을 직접 만든다
    await app.router.match('POST', '/api/p2/rejudge').handler({ body: { force: true } });
    const v = p2.latestSupplyJudgment('PLAN-011').plan.supply_judgment_version;
    p4.__set('PLAN-011', '기한 경과 확정');
    await p1.__register('PLAN-011', { uplift_pct: 10, sale_start_week: '2026-07-06', sale_weeks: 2 });
    assert.equal(p2.latestSupplyJudgment('PLAN-011').plan.supply_judgment_version, v);
    await app.events.emit({ event_type: 'REVIEW_OPENED', source_type: '계산', plan_id: 'PLAN-011',
      payload: { review_id: 'RV-X', target_type: 'supply_judgment', target_id: 'SJ-PLAN-011', rejudge: true } }, 'p4');
    assert.equal(p2.latestSupplyJudgment('PLAN-011').plan.supply_judgment_version, v);
  } finally { await close(); }
});

test('부족 기안의 대안: 권장 시기이동 = 보충 가능 시작 주, 조기 요청 → Corevia 불가 → 대안 재계산 (D (3)(5))', async () => {
  const { app, p1, p2, close } = await makeApp();
  try {
    await applyBR(p2);
    await p1.__register('PLAN-011', { uplift_pct: 10, sale_start_week: '2026-07-06', sale_weeks: 2 });
    const pa = p2.planAlternatives('PLAN-011');
    assert.equal(pa.supply_verdict, '부족');
    assert.equal(pa.recommended.alternative_type, '시기이동');
    assert.equal(pa.recommended.new_sale_start_week, '2026-09-28'); // 더마 07-01 기준 보충 가능 시작
    const shift = pa.alternatives.find((a) => a.alternative_type === '시기이동');
    assert.equal(shift.feasible, true);
    assert.ok(shift.earliest_feasible_sale_start_week <= shift.recommended_sale_start_week);
    const reqs = await p2.requestEarlySupply('PLAN-011');
    assert.equal(reqs.length, 4);
    assert.equal((await p2.requestEarlySupply('PLAN-011')).length, 0); // 두 번 요청하지 않는다
    const replies = await p2.applySupplierReplies('PLAN-011');
    assert.equal(replies.length, 4);
    assert.ok(replies.every((r) => r.supply_request.reply_result === '불가' && r.supply_request.scenario_id === 'BASE'));
    const after = p2.planAlternatives('PLAN-011');
    assert.equal(after.alternatives.some((a) => a.alternative_type === '조기분할요청'), false);
    assert.equal(after.recommended.alternative_type, '시기이동');
    // 모의 입력으로 시기이동 선택 → alternative_selection
    const sel = await p2.selectAlternative({ alternative_id: after.recommended.alternative_id, selected_by: 'MKT-LINE-OWNER', is_mock: true, generation_reason: '기본 모의 입력' });
    assert.equal(sel.alternative_selection.new_sale_start_week, '2026-09-28');
    const ev = app.events.get(sel.event_id);
    assert.equal(ev.is_synthetic, true);
    assert.equal(ev.generation_reason, '기본 모의 입력');
  } finally { await close(); }
});

test('judgmentCheck: 트리거로 확인했지만 바뀌지 않은 기안은 changed=false로 알려준다', async () => {
  const { app, p1, p2, close } = await makeApp();
  try {
    await p1.__register('PLAN-011', { uplift_pct: 10, sale_start_week: '2026-07-06', sale_weeks: 2 });
    const trig = app.events.query({ event_type: 'DEMAND_INPUT_REGISTERED', plan_id: 'PLAN-011' })[0].event_id;
    assert.equal(p2.judgmentCheck({ plan_id: 'PLAN-011', trigger_event_id: trig }).changed, true);
    const other = p2.judgmentCheck({ plan_id: 'PLAN-002', trigger_event_id: trig });
    assert.equal(other.checked, true);
    assert.equal(other.changed, false); // 색조 기안은 더마 수요와 무관
    assert.equal(p2.judgmentCheck({ plan_id: 'PLAN-002', trigger_event_id: 'EV-999999' }).checked, false);
  } finally { await close(); }
});

// ── (D) 두 번째 수정의 재현 테스트 ──
const P3_STUB = `
export function register(ctx) {
  ctx.expose({ commitment: (id) => ({ commitment_id: id, source_id: String(id).replace(/^CMT-/, '') }) });
}`;
const approve = (app, poId) => app.events.emit({ event_type: 'APPROVAL_REPLIED', source_type: '모의회신', is_synthetic: true, plan_id: 'NONE',
  payload: { commitment_id: `CMT-${poId}`, decision: '승인', conditions: [] } }, 'p4');

test('(a) 내부 발주 승인만으로는 입고가 확약되지 않는다: 예상 입고로만 들어가 조건부(공급 확약 대기)로 남고, 취소되지도 않는다', async () => {
  const { app, p1, p2, close } = await makeApp({ extra: { 'problem3/src/index.mjs': P3_STUB } });
  try {
    await applyV1(app, p2);
    await applyBR(p2);
    await p1.__register('PLAN-002', { uplift_pct: 100, sale_start_week: '2026-08-31', sale_weeks: 4 });
    const poId = reorderOf(p2, 'PLAN-002')[0].po_draft_id;
    await approve(app, poId);
    const row = p2.inboundSchedule().rows.find((r) => r.source_ref === poId);
    assert.deepEqual([row.supply_status, row.eta_status, row.eta_date], ['예상', '미회신', '2026-08-21']); // 07-10 발주 + 6주는 예상일 뿐
    const ev = app.events.query({ event_type: 'INBOUND_SCHEDULE_REVISED', order: 'desc', limit: 1 })[0];
    assert.equal(ev.payload.changed_rows[0].supply_status, '예상');
    const j = p2.latestSupplyJudgment('PLAN-002');
    assert.equal(j.plan.supply_verdict, '조건부');
    const pend = j.plan.condition_basis.find((c) => c.condition_type === 'supply_commitment_pending');
    assert.deepEqual([pend.sku_id, pend.inbound_rows.map((x) => x.source_ref)], ['SKU-3003', [poId]]);
    assert.ok(p2.planDecision('PLAN-002').waiting_replies.some((w) => w.from === 'Corevia 공급 담당자' && w.status === '회신 대기' && w.expected_by === '2026-07-06'));
    await app.clock.advance({ to: '2026-07-03' }); // Corevia 회신 도착 전(승인 + 3영업일 = 07-06)
    assert.equal(p2.latestSupplyJudgment('PLAN-002').plan.supply_verdict, '조건부');
    assert.equal(p2.inboundSchedule().rows.find((r) => r.source_ref === poId).supply_status, '예상');
    assert.equal(app.events.query({ event_type: 'PO_DRAFT_CANCELLED', limit: 1e6 }).length, 0);
  } finally { await close(); }
});

test('(b) 원료·생산 조건이 충족된 Corevia 가능 회신을 받으면 확약 수량·납기로 판정하고, 도착일이 지나면 입고 실적(모의)으로 입고 완료가 된다', async () => {
  const { app, p1, p2, close } = await makeApp({ extra: { 'problem3/src/index.mjs': P3_STUB } });
  try {
    await applyV1(app, p2);
    await applyBR(p2);
    await p1.__register('PLAN-001', { uplift_pct: 100, sale_start_week: '2026-09-07', sale_weeks: 4 });
    const poId = p2.poDrafts().find((d) => d.sku_id === 'SKU-2001').po_draft_id;
    await approve(app, poId);
    await app.clock.advance({ to: '2026-07-06' }); // 승인 + 3영업일: S2-CVC-SKU-2001-1 가능(원료 M-A LOT-A-2606-1 확보, L-01 배정)
    const c = p2.supplyCommitments({ target_id: poId })[0];
    assert.deepEqual([c.reply_status, c.validation_status, c.committed_qty, c.offered_eta_date, c.material_id, c.material_status, c.production_line, c.production_status],
      ['가능', '정상', 16000, '2026-09-04', 'M-A', '확보', 'L-01', '배정']);
    assert.match(c.material_evidence, /LOT-A-2606-1/);
    const row = () => p2.inboundSchedule().rows.find((r) => r.source_ref === poId);
    assert.deepEqual([row().supply_status, row().qty, row().eta_date], ['확약', 16000, '2026-09-04']);
    const s1 = pick(p2.latestSupplyJudgment('PLAN-001').skus, { sku_id: 'SKU-2001' });
    assert.equal(s1.condition_basis.some((x) => x.condition_type === 'supply_commitment_pending'), false);
    const judged = app.events.query({ event_type: 'SUPPLY_JUDGED', plan_id: 'PLAN-001', limit: 1e6 }).find((e) => app.events.get(app.events.get(e.caused_by ?? '')?.caused_by ?? '')?.event_type === 'SUPPLIER_REPLIED');
    assert.ok(judged, '판정 ← 입고 일정 ← Corevia 회신');
    await app.clock.advance({ to: '2026-09-07' }); // 도착일(09-04) 경과 → 입고 실적(모의, 확약 수량 그대로)
    assert.deepEqual([row().supply_status, row().received_qty, row().received_on, row().receipt_is_synthetic], ['입고 완료', 16000, '2026-09-04', true]);
  } finally { await close(); }
});

test('L1 철회: 그 기안에만 걸린 승인 발주안은 발주 전달 전이면 취소하고 예상 입고를 지운다', async () => {
  const { app, p1, p2, close } = await makeApp({ extra: { 'problem3/src/index.mjs': P3_STUB } });
  try {
    await applyV1(app, p2);
    await applyBR(p2);
    await p1.__register('PLAN-002', { uplift_pct: 100, sale_start_week: '2026-08-31', sale_weeks: 4 });
    const poId = reorderOf(p2, 'PLAN-002')[0].po_draft_id;
    await approve(app, poId);
    assert.ok(p2.inboundSchedule().rows.some((r) => r.source_ref === poId));
    const w = await app.events.emit({ event_type: 'PLAN_WITHDRAWN', source_type: '사람입력', is_synthetic: true, plan_id: 'PLAN-002', payload: { plan_id: 'PLAN-002' } }, 'p4');
    assert.equal(p2.poDrafts({ po_draft_id: poId })[0].po_draft_status, '취소'); // 07-01 < 발주 예정일 07-10
    const ev = app.events.query({ event_type: 'PO_DRAFT_CANCELLED', limit: 1e6 }).find((e) => e.payload.po_draft_id === poId);
    assert.deepEqual([ev.caused_by, ev.payload.cancel_reason], [w.event_id, '연결 기안 철회(발주 전달 전, 승인 발주안 취소)']);
    assert.equal(p2.inboundSchedule().rows.some((r) => r.source_ref === poId), false);
  } finally { await close(); }
});

test('L1 철회: 이미 발주가 전달된 발주안은 취소하지 않고 기안 철회 뒤 남은 발주로 표시해 SCM에 취소·조정 가능 여부를 묻는다', async () => {
  const { app, p1, p2, close } = await makeApp({ extra: { 'problem3/src/index.mjs': P3_STUB } });
  try {
    await applyV1(app, p2);
    await applyBR(p2);
    await p1.__register('PLAN-002', { uplift_pct: 100, sale_start_week: '2026-08-31', sale_weeks: 4 });
    const poId = reorderOf(p2, 'PLAN-002')[0].po_draft_id;
    await approve(app, poId);
    await app.clock.advance({ to: '2026-07-10' }); // 발주 예정일: 발주 전달
    assert.equal(p2.poDrafts({ po_draft_id: poId })[0].po_draft_status, '발주');
    await app.events.emit({ event_type: 'PLAN_WITHDRAWN', source_type: '사람입력', is_synthetic: true, plan_id: 'PLAN-002', payload: { plan_id: 'PLAN-002' } }, 'p4');
    const d = p2.poDrafts({ po_draft_id: poId })[0];
    assert.deepEqual([d.po_draft_status, d.orphan_status, d.linked_plan_ids], ['발주', '기안 철회 뒤 남은 발주', []]);
    const req = app.events.query({ event_type: 'INFO_REQUESTED', limit: 1e6 }).find((e) => e.payload.request_topic === 'po_draft_orphaned');
    assert.deepEqual([req.payload.requested_to, req.payload.subject_id], ['SCM', poId]);
    assert.equal(app.events.query({ event_type: 'PO_DRAFT_CANCELLED', limit: 1e6 }).some((e) => e.payload.po_draft_id === poId), false);
  } finally { await close(); }
});

test('L1 철회: 다른 기안도 걸린 승인 발주안은 그 기안만 떼고 수량을 다시 계산한다(바뀌면 새 버전, 다시 승인)', async () => {
  const { app, p1, p2, close } = await makeApp({ extra: { 'problem3/src/index.mjs': P3_STUB } });
  try {
    await applyV1(app, p2);
    await applyBR(p2);
    await p1.__register('PLAN-001', { uplift_pct: 100, sale_start_week: '2026-09-07', sale_weeks: 4 });
    await p1.__register('PLAN-012', { uplift_pct: 150, sale_start_week: '2026-09-14', sale_weeks: 4 });
    const d0 = p2.poDrafts().find((d) => d.sku_id === 'SKU-2001');
    assert.deepEqual(d0.linked_plan_ids, ['PLAN-001', 'PLAN-012']);
    await approve(app, d0.po_draft_id);
    await app.events.emit({ event_type: 'PLAN_WITHDRAWN', source_type: '사람입력', is_synthetic: true, plan_id: 'PLAN-012', payload: { plan_id: 'PLAN-012' } }, 'p4');
    const d1 = p2.poDrafts({ po_draft_id: d0.po_draft_id })[0];
    const share = d0.qty_breakdown.campaign_by_plan.find((x) => x.plan_id === 'PLAN-001').qty_ea;
    assert.deepEqual(d1.linked_plan_ids, ['PLAN-001']);
    assert.equal(d1.order_qty, Math.max(Math.ceil(share), d1.moq));
    assert.ok(d1.order_qty < d0.order_qty && d1.draft_version === d0.draft_version + 1);
    assert.equal(p2.inboundSchedule().rows.some((r) => r.source_ref === d0.po_draft_id), false); // 다시 승인받기 전에는 예상 입고 없음
    assert.ok(p2.planDecision('PLAN-001').waiting_replies.some((w) => w.what.includes(d0.po_draft_id) && w.status === '승인 대기'));
  } finally { await close(); }
});

test('D2 (나) 보충이 필요한 SKU마다 발주안이 있다: 앞 기안의 승인 발주가 Target을 채워도 남은 필요량으로 만든다', async () => {
  const { app, p1, p2, close } = await makeApp({ extra: { 'problem3/src/index.mjs': P3_STUB } });
  try {
    await applyV1(app, p2);
    await applyBR(p2);
    // 앞 순번 PLAN-001(기초)의 조건 발주안을 승인해 입고에 넣고, 뒤 순번 PLAN-012(기초)는 전개 뒤쪽에 판매
    await p1.__register('PLAN-001', { uplift_pct: 100, sale_start_week: '2026-09-07', sale_weeks: 4 });
    for (const c of p2.latestSupplyJudgment('PLAN-001').plan.condition_basis.filter((x) => x.po_draft_id)) await approve(app, c.po_draft_id);
    // 승인 발주안의 MOQ 올림분으로 못 덮을 만큼 크게(F: 덮이면 조건이 없어지므로)
    await p1.__register('PLAN-012', { uplift_pct: 120, sale_start_week: '2026-11-02', sale_weeks: 4 });
    const j = p2.latestSupplyJudgment('PLAN-012');
    const reorder = j.plan.condition_basis.filter((x) => x.condition_type === 'reorder_required');
    assert.ok(reorder.length > 0);
    for (const c of reorder) {
      assert.ok(c.po_draft_id, `${c.sku_id} 발주안 없음`);
      const d = p2.poDrafts({ po_draft_id: c.po_draft_id })[0];
      const share = d.qty_breakdown.campaign_by_plan.find((x) => x.plan_id === 'PLAN-012');
      assert.equal(share.qty_ea, c.uncovered_qty_ea); // 이 기안 몫 = 남은 필요량
      assert.equal(d.order_qty, Math.max(Math.ceil(d.qty_breakdown.campaign_by_plan.reduce((t, x) => t + x.qty_ea, 0) - 1e-6), d.moq));
    }
  } finally { await close(); }
});

test('D2 (나) 미확정 입고 조건은 SKU당 하나로 묶는다', async () => {
  const { p1, p2, close } = await makeApp();
  try {
    // v1 전: SKU-3003의 운송 중 물량과 SPO-0010이 모두 미회신
    await p1.__register('PLAN-002', { uplift_pct: 35, sale_start_week: '2026-07-20', sale_weeks: 4 });
    const inb = p2.latestSupplyJudgment('PLAN-002').plan.condition_basis.filter((x) => x.condition_type === 'inbound_unconfirmed');
    const per = {}; for (const c of inb) per[c.sku_id] = (per[c.sku_id] ?? 0) + 1;
    assert.ok(Object.values(per).every((n) => n === 1));
    const c3003 = inb.find((c) => c.sku_id === 'SKU-3003');
    assert.deepEqual(c3003.inbound_rows.map((r) => r.source_ref).sort(), ['IN_TRANSIT:SKU-3003', 'SPO-0010']);
  } finally { await close(); }
});

test('D2 (다)(라) SUPPLY_JUDGED payload에 condition_basis가 있고 발주 시한 이름은 order_deadline', async () => {
  const { app, p1, p2, close } = await makeApp();
  try {
    await applyV1(app, p2);
    await applyBR(p2);
    await p1.__register('PLAN-002', { uplift_pct: 100, sale_start_week: '2026-08-31', sale_weeks: 4 });
    const ev = app.events.query({ event_type: 'SUPPLY_JUDGED', plan_id: 'PLAN-002', order: 'desc', limit: 1 })[0];
    assert.deepEqual(ev.payload.condition_basis, p2.latestSupplyJudgment('PLAN-002').plan.condition_basis);
    const c = ev.payload.condition_basis.find((x) => x.condition_type === 'reorder_required');
    assert.equal(c.order_deadline, '2026-08-21');
    assert.equal('order_by_date' in c, false);
  } finally { await close(); }
});

// ── (E) SKU 단위 발주안·거절 처리 ──
const reply = (app, poId, decision) => app.events.emit({ event_type: 'APPROVAL_REPLIED', source_type: '모의회신', is_synthetic: true, plan_id: 'NONE',
  payload: { commitment_id: `CMT-${poId}`, decision, conditions: [] } }, 'p4');
const reorderOf = (p2, planId) => p2.latestSupplyJudgment(planId).plan.condition_basis.filter((x) => x.condition_type === 'reorder_required');

test('E (1) 발주안은 SKU 단위: 두 기안의 보충 조건이 같은 SKU 발주안 하나를 가리키고 수량 내역을 남긴다', async () => {
  const { app, p1, p2, close } = await makeApp({ extra: { 'problem3/src/index.mjs': P3_STUB } });
  try {
    await applyV1(app, p2);
    await p1.__register('PLAN-001', { uplift_pct: 100, sale_start_week: '2026-09-07', sale_weeks: 4 });
    await p1.__register('PLAN-012', { uplift_pct: 50, sale_start_week: '2026-09-14', sale_weeks: 4 });
    const a = reorderOf(p2, 'PLAN-001');
    const b = reorderOf(p2, 'PLAN-012');
    assert.deepEqual(a.map((c) => c.sku_id), ['SKU-2001', 'SKU-2002', 'SKU-2003']);
    assert.deepEqual(a.map((c) => c.po_draft_id), b.map((c) => c.po_draft_id)); // 같은 SKU → 같은 발주안
    const drafts = p2.poDrafts();
    assert.equal(drafts.length, 3); // 기안 2건 × SKU 3개인데 발주안은 SKU당 하나
    for (const d of drafts) {
      assert.deepEqual(d.linked_plan_ids, ['PLAN-001', 'PLAN-012']);
      const q = d.qty_breakdown;
      assert.ok(Math.abs(q.baseline_demand_ea + q.campaign_added_ea + q.rounding_ea - d.order_qty) < 0.01);
      assert.equal(d.order_qty_base_ea, q.baseline_demand_ea); // 문제 3이 읽는 이름
      assert.equal(d.order_qty_campaign_ea, q.campaign_added_ea);
      for (const x of q.campaign_by_plan) assert.equal(x.qty_ea, reorderOf(p2, x.plan_id).find((c) => c.sku_id === d.sku_id).additional_reorder_qty_ea);
      // F (1): 수량 = 캠페인 추가 필요량 합을 MOQ로 올린 값. 기준 수요분은 넣지 않는다
      assert.equal(q.baseline_demand_ea, 0);
      assert.equal(d.order_qty, Math.max(Math.ceil(q.campaign_added_ea - 1e-6), d.moq));
      assert.equal(q.rounding_ea, Math.round((d.order_qty - q.campaign_added_ea) * 100) / 100);
      assert.equal(q.campaign_share_pct, Math.round((q.campaign_added_ea / d.order_qty) * 10000) / 100);
    }
  } finally { await close(); }
});

test('E (1) 승인 전 초안은 등록 수요가 늘면 같은 발주안의 새 버전으로 수량을 갱신한다', async () => {
  const { app, p1, p2, close } = await makeApp({ extra: { 'problem3/src/index.mjs': P3_STUB } });
  try {
    await applyV1(app, p2);
    await p1.__register('PLAN-001', { uplift_pct: 100, sale_start_week: '2026-09-07', sale_weeks: 4 });
    await p1.__register('PLAN-012', { uplift_pct: 50, sale_start_week: '2026-09-14', sale_weeks: 4 });
    const before = new Map(p2.poDrafts().map((d) => [d.po_draft_id, d]));
    // 필요량 합이 MOQ(16,000)를 넘도록 크게 올린다(MOQ 안이면 수량이 그대로라 버전을 올리지 않는다)
    await p1.__register('PLAN-012', { uplift_pct: 150, sale_start_week: '2026-09-14', sale_weeks: 4 });
    const after = p2.poDrafts();
    assert.deepEqual(after.map((d) => d.po_draft_id).sort(), [...before.keys()].sort()); // 새 발주안 없이
    for (const d of after) {
      assert.ok(d.order_qty > before.get(d.po_draft_id).order_qty);
      assert.equal(d.draft_version, before.get(d.po_draft_id).draft_version + 1);
      assert.ok(app.events.query({ event_type: 'PO_DRAFT_CREATED', limit: 1e6 })
        .some((e) => e.payload.po_draft_id === d.po_draft_id && e.payload.draft_version === d.draft_version && e.payload.order_qty === d.order_qty));
    }
  } finally { await close(); }
});

test('G (3) 보충 필요량은 SKU 단위 누적: 앞 기안 승인 발주안의 MOQ 올림분이 뒤 기안 캠페인 추가분을 채우고(확약 전이면 공급 확약 대기), 모자란 만큼만 새 초안', async () => {
  const { app, p1, p2, close } = await makeApp({ extra: { 'problem3/src/index.mjs': P3_STUB } });
  try {
    await applyV1(app, p2);
    await applyBR(p2);
    await p1.__register('PLAN-001', { uplift_pct: 100, sale_start_week: '2026-09-07', sale_weeks: 4 });
    const first = p2.poDrafts();
    assert.deepEqual(first.map((d) => [d.sku_id, d.order_qty]), [['SKU-2001', 16000], ['SKU-2002', 16000], ['SKU-2003', 16000]]); // 필요 10,379 / 6,992 / 3,598 → MOQ
    for (const d of first) await reply(app, d.po_draft_id, '승인');
    await p1.__register('PLAN-012', { uplift_pct: 50, sale_start_week: '2026-09-14', sale_weeks: 4 });
    const j = p2.latestSupplyJudgment('PLAN-012');
    // SKU-2002·2003: 남는 물량이 PLAN-012 필요를 채우지만 그 발주안이 아직 예상 입고라 공급 확약 대기
    for (const sku of ['SKU-2002', 'SKU-2003']) {
      assert.ok(pick(j.skus, { sku_id: sku }).condition_basis.some((c) => c.condition_type === 'supply_commitment_pending'));
      if (sku !== 'SKU-2002') continue; // 2003은 SCM 보충 미확인(07-03)이라 판매 기간 뒤 몫으로 보충 발주가 더 붙는다
      assert.equal(pick(j.skus, { sku_id: sku }).condition_basis.some((c) => c.condition_type === 'reorder_required'), false);
      assert.equal(p2.poDrafts().filter((d) => d.sku_id === sku).length, 1);
    }
    // SKU-2001: 필요 8,896 중 남는 물량 5,621만 채워지고 3,275가 남는다 → 그만큼만 새 초안(MOQ 16,000)
    const c1 = reorderOf(p2, 'PLAN-012').find((c) => c.sku_id === 'SKU-2001');
    assert.deepEqual([c1.campaign_need_ea, c1.covered_by_approved_qty_ea, c1.additional_reorder_qty_ea], [8896, 5621, 3275]);
    const d1 = p2.poDrafts({ po_draft_id: c1.po_draft_id })[0];
    assert.ok(!first.some((d) => d.po_draft_id === d1.po_draft_id));
    assert.deepEqual(d1.qty_breakdown.campaign_by_plan.map((x) => [x.plan_id, x.qty_ea]), [['PLAN-012', 3275]]);
    assert.equal(d1.order_qty, 16000);
  } finally { await close(); }
});

test('E (2) 발주안이 거절되면 기대던 기안은 그 SKU를 보충 없이 다시 판정(부족)하고 대안을 다시 계산한다', async () => {
  const { app, p1, p2, close } = await makeApp({ extra: { 'problem3/src/index.mjs': P3_STUB } });
  try {
    await applyV1(app, p2);
    await p1.__register('PLAN-001', { uplift_pct: 100, sale_start_week: '2026-09-07', sale_weeks: 4 });
    await p1.__register('PLAN-012', { uplift_pct: 50, sale_start_week: '2026-09-14', sale_weeks: 4 });
    const pod = reorderOf(p2, 'PLAN-001').find((c) => c.sku_id === 'SKU-2001').po_draft_id;
    const ev = await reply(app, pod, '거절');
    assert.equal(p2.poDrafts({ po_draft_id: pod })[0].po_draft_status, '반려');
    for (const pid of ['PLAN-001', 'PLAN-012']) {
      const j = p2.latestSupplyJudgment(pid);
      assert.equal(j.plan.supply_verdict, '부족');
      assert.deepEqual(j.plan.reorder_blocked.map((b) => [b.sku_id, b.po_draft_id]), [['SKU-2001', pod]]);
      const s1 = j.skus.find((s) => s.sku_id === 'SKU-2001');
      assert.equal(s1.supply_verdict, '부족');
      assert.equal(s1.condition_basis.some((c) => c.condition_type === 'reorder_required'), false);
      const judged = app.events.query({ event_type: 'SUPPLY_JUDGED', plan_id: pid, order: 'desc', limit: 1 })[0];
      assert.equal(judged.caused_by, ev.event_id);
      assert.ok(app.events.query({ event_type: 'ALTERNATIVES_COMPUTED', plan_id: pid, limit: 1e6 }).some((e) => e.caused_by === judged.event_id));
      const pa = p2.planAlternatives(pid);
      assert.equal(pa.alternatives.some((a) => a.alternative_type === '보충발주' && a.sku_id === 'SKU-2001'), false); // 거절된 SKU는 보충발주 대안 없음
      assert.ok(['시기이동', '물량상한', '구성이동'].includes(pa.recommended?.alternative_type));
    }
    // 거절된 발주안을 다시 쓰거나 같은 기안 몫으로 새로 만들지 않는다
    assert.equal(p2.poDrafts().filter((d) => d.sku_id === 'SKU-2001' && d.po_draft_status !== '반려').length, 0);
  } finally { await close(); }
});

test('E (1) 철회: 승인 전 SKU 발주안에서 그 기안만 빼고, 남은 연결 기안이 없으면 취소한다', async () => {
  const { app, p1, p2, close } = await makeApp({ extra: { 'problem3/src/index.mjs': P3_STUB } });
  try {
    await applyV1(app, p2);
    await p1.__register('PLAN-001', { uplift_pct: 100, sale_start_week: '2026-09-07', sale_weeks: 4 });
    await p1.__register('PLAN-012', { uplift_pct: 50, sale_start_week: '2026-09-14', sale_weeks: 4 });
    const withdraw = (pid) => app.events.emit({ event_type: 'PLAN_WITHDRAWN', source_type: '사람입력', is_synthetic: true, plan_id: pid, payload: { plan_id: pid } }, 'p4');
    await withdraw('PLAN-012');
    for (const d of p2.poDrafts()) { assert.notEqual(d.po_draft_status, '취소'); assert.deepEqual(d.linked_plan_ids, ['PLAN-001']); }
    await withdraw('PLAN-001');
    assert.ok(p2.poDrafts().every((d) => d.po_draft_status === '취소'));
  } finally { await close(); }
});

// ── (F) 같은 날 묶기 ──
test('F 같은 날 결론·보충 필요량이 같은 전제 변경은 그날 버전에 흡수하고, 다음 날의 전제 변경은 새 버전을 낸다', async () => {
  const { app, p1, p2, close } = await makeApp();
  try {
    // 07-02·07-03 회신은 미리 넣는다(운송 중 SKU-3001·3002 회신만 남긴다)
    const ids = (await app.router.match('GET', '/api/p2/mock').handler({})).inbound_replies.filter((r) => r.data_version === 'v1' && !/SKU-300[12]$/.test(r.record_id)).map((r) => r.record_id);
    await p2.applyInboundReply({ record_ids: ids });
    await p2.applySupplyReplies({ date: '2026-07-02' });
    await applyBR(p2);
    await p1.__register('PLAN-002', { uplift_pct: 35, sale_start_week: '2026-07-20', sale_weeks: 4 });
    const n = () => app.events.query({ event_type: 'SUPPLY_JUDGED', plan_id: 'PLAN-002', limit: 1e6 }).length;
    const before = n();
    const v = p2.latestSupplyJudgment('PLAN-002').plan.supply_judgment_version;
    const r = await p2.applyInboundReply({ record_ids: ['S2-ETA-IT-v1-SKU-3002'] }); // SKU-3002 운송 중 확약: 결론 그대로
    assert.equal(n(), before);
    const chk = p2.judgmentCheck({ plan_id: 'PLAN-002', trigger_event_id: r.event_id });
    assert.deepEqual([chk.checked, chk.changed, chk.supply_judgment_version], [true, false, v]);
    await app.clock.advance({ days: 1 });
    await p2.applyInboundReply({ record_ids: ['S2-ETA-IT-v1-SKU-3001'] }); // 다음 날: 전제만 바뀌어도 새 버전(조정자 D (2))
    assert.equal(n(), before + 1);
  } finally { await close(); }
});

test('F 조건 발주안에 이어진 기안이 날짜 경과로 부족이 되어도 승인 전 발주안을 취소하지 않는다(D2 (가) 유지)', async () => {
  const { app, p1, p2, close } = await makeApp({ extra: { 'problem3/src/index.mjs': P3_STUB } });
  try {
    // PLAN-002 색조 08-31 시작: 07-01에는 보충 가능 구간(조건부, 보충 발주 필요) → 발주안. 발주 시한(08-21)이 지나면 막을 수 없는 구간이 밀려 부족
    await applyV1(app, p2);
    await applyBR(p2);
    await p1.__register('PLAN-002', { uplift_pct: 100, sale_start_week: '2026-08-31', sale_weeks: 4 });
    const pod = reorderOf(p2, 'PLAN-002')[0].po_draft_id;
    assert.ok(pod);
    await app.clock.advance({ to: '2026-08-31' });
    assert.equal(p2.latestSupplyJudgment('PLAN-002').plan.supply_verdict, '부족');
    assert.notEqual(p2.poDrafts({ po_draft_id: pod })[0].po_draft_status, '취소');
    assert.equal(app.events.query({ event_type: 'PO_DRAFT_CANCELLED', limit: 1e6 }).length, 0);
  } finally { await close(); }
});

test('G 이어진 승인 전 발주안의 발주 예정일 전이면, 날짜가 지나도 그 발주안 도착 주부터는 막을 수 있는 구간이다', async () => {
  const { app, p1, p2, close } = await makeApp({ extra: { 'problem3/src/index.mjs': P3_STUB } });
  try {
    await applyV1(app, p2);
    await p1.__register('PLAN-001', { uplift_pct: 200, sale_start_week: '2026-08-31', sale_weeks: 4 });
    const c = reorderOf(p2, 'PLAN-001').find((x) => x.sku_id === 'SKU-2001');
    assert.deepEqual([c.needed_by_week, c.reorder_reach_week], ['2026-08-31', '2026-08-31']);
    const d = p2.poDrafts({ po_draft_id: c.po_draft_id })[0];
    assert.equal(d.planned_order_date, '2026-07-10');
    await app.clock.advance({ to: '2026-07-06' }); // 오늘 + 7영업일 = 07-15 → 보충 가능 시작이 09-07 주로 밀리지만 발주안은 07-10 발주로 08-31 주 도착
    assert.equal(p2.latestSupplyJudgment('PLAN-001').plan.supply_verdict, '조건부');
    assert.equal(reorderOf(p2, 'PLAN-001').find((x) => x.sku_id === 'SKU-2001').po_draft_id, d.po_draft_id);
  } finally { await close(); }
});

test('G 모든 판정 버전은 원인 사건(caused_by)과 사유(generation_reason)를 가진다(날짜 경과·수동 재판정 포함)', async () => {
  const { app, p1, p2, close } = await makeApp({ extra: { 'problem3/src/index.mjs': P3_STUB } });
  try {
    await applyV1(app, p2);
    await applyBR(p2);
    await p1.__register('PLAN-002', { uplift_pct: 100, sale_start_week: '2026-08-31', sale_weeks: 4 });
    await app.clock.advance({ to: '2026-08-31' }); // 발주 시한 08-21이 지나 결론이 바뀌는 버전
    await app.router.match('POST', '/api/p2/rejudge').handler({ body: { plan_id: 'PLAN-002', force: true } }); // 원인 사건 없는 호출
    const evs = app.events.query({ event_type: 'SUPPLY_JUDGED', limit: 1e6 });
    assert.ok(evs.some((e) => /발주 시한 경과/.test(e.generation_reason ?? '')));
    assert.ok(evs.some((e) => /^수동 재판정/.test(e.generation_reason ?? '')));
    for (const e of evs.filter((x) => x.payload.supply_judgment_version > 1)) {
      assert.ok(e.caused_by, `${e.event_id} caused_by 없음`);
      assert.ok(e.generation_reason, `${e.event_id} 사유 없음`);
    }
    const dated = evs.find((e) => /발주 시한 경과/.test(e.generation_reason ?? ''));
    assert.match(dated.generation_reason, /SKU-3003 조건부\(조건 보충 발주 필요\) → 부족/); // 어떤 SKU의 판정·조건이 어떻게 바뀌었는지
  } finally { await close(); }
});

test('(e) 기준 수요 보충 계획이 미확인이면 날짜가 지나도 조건이 자동으로 풀리지 않고, SCM 후속 회신(08-07)으로만 풀린다', async () => {
  const { app, p1, p2, close } = await makeApp();
  try {
    assert.equal(p2.baselineReplenishment({ sku_id: 'SKU-3001' })[0].plan_status, '미회신');
    assert.equal('covered_from_week' in p2.baselineReplenishment({ sku_id: 'SKU-3001' })[0], false);
    const rows = p2.supplyProjectionBase({ sku_id: 'SKU-3001', inbound_scenario: 'on_schedule' });
    const at = (w) => rows.find((r) => r.week_start === w).projected_on_hand_qty;
    assert.ok(at('2026-08-24') < at('2026-08-17')); // 예전 정기 보충 가정 시작 주 뒤에도 기준 수요가 재고를 깎는다
    await app.clock.advance({ to: '2026-07-06' }); // 07-03 SCM 회신(onDay)
    assert.deepEqual(['SKU-2001', 'SKU-1001', 'SKU-2003', 'SKU-5001'].map((s) => p2.baselineReplenishment({ sku_id: s })[0].plan_status),
      ['SCM 확인·Corevia 확약', 'SCM 확인·Corevia 미확약', 'SCM 미확인', '미회신']);
    assert.equal(p2.inboundSchedule({ sku_id: 'SKU-2003' }).rows.some((r) => r.inbound_kind === '정기 보충'), false); // 미확인은 입고에 넣지 않는다
    await p1.__register('PLAN-001', { uplift_pct: 100, sale_start_week: '2026-07-13', sale_weeks: 2 });
    const cond = () => pick(p2.latestSupplyJudgment('PLAN-001').skus, { sku_id: 'SKU-2003' }).condition_basis.find((c) => c.condition_type === 'baseline_replenishment_unconfirmed');
    assert.equal(cond()?.reason, '보충 계획 미확인');
    await app.clock.advance({ to: '2026-08-06' });
    assert.equal(cond()?.reason, '보충 계획 미확인'); // 회신 전에는 그대로
    assert.deepEqual(['from', 'status'].map((k) => p2.planDecision('PLAN-001').waiting_replies.find((x) => x.what === 'SKU-2003 기준 수요 보충 계획')[k]), ['SCM', 'SCM 미확인']);
    await app.clock.advance({ to: '2026-08-07' }); // SCM 후속 회신: 확인·확약
    assert.equal(p2.baselineReplenishment({ sku_id: 'SKU-2003' })[0].plan_status, 'SCM 확인·Corevia 확약');
    assert.equal(cond(), undefined);
    const judged = app.events.query({ event_type: 'SUPPLY_JUDGED', plan_id: 'PLAN-001', order: 'desc', limit: 1 })[0];
    assert.ok(app.events.get(judged.caused_by).payload.baseline_replenishment.some((x) => x.sku_id === 'SKU-2003' && x.scm_confirmed === '확인'));
  } finally { await close(); }
});

test('(c) 원료 지연 정정 회신으로 도착일이 늦어지면 회신을 원인으로 관련 기안을 다시 판정하고 대안을 갱신한다', async () => {
  const { app, p1, p2, close } = await makeApp({ extra: { 'problem3/src/index.mjs': P3_STUB } });
  try {
    await applyV1(app, p2);
    await applyBR(p2);
    await p1.__register('PLAN-011', { uplift_pct: 50, sale_start_week: '2026-10-05', sale_weeks: 3 });
    const pod = p2.poDrafts().find((d) => d.sku_id === 'SKU-1002').po_draft_id;
    for (const d of p2.poDrafts()) await reply(app, d.po_draft_id, '승인');
    await app.clock.advance({ to: '2026-07-06' }); // v1: 가능, 10-02 도착
    assert.equal(p2.inboundSchedule().rows.find((r) => r.source_ref === pod).eta_date, '2026-10-02');
    await app.clock.advance({ to: '2026-07-13' }); // v2 정정: 원료 M-B(PO-00095) 입고 4주 지연 → 10-30
    const c = p2.supplyCommitments({ target_id: pod })[0];
    assert.deepEqual([c.reply_version, c.reply_status, c.offered_eta_date, c.delay_weeks, c.material_id, c.material_status], [2, '가능', '2026-10-30', 4, 'M-B', '확보 예정']);
    assert.equal(p2.supplyCommitments({ target_id: pod, latest_only: false }).length, 2); // v1을 덮어쓰지 않고 버전으로 남긴다
    const row = p2.inboundSchedule().rows.find((r) => r.source_ref === pod);
    assert.deepEqual([row.eta_date, row.supply_status, row.eta_status], ['2026-10-30', '확약', '지연']);
    const sr = app.events.query({ event_type: 'SUPPLIER_REPLIED', limit: 1e6 }).find((e) => e.subject_id === `SC-${pod}-v2`);
    const inb = app.events.query({ event_type: 'INBOUND_SCHEDULE_REVISED', limit: 1e6 }).find((e) => e.caused_by === sr.event_id);
    const judged = app.events.query({ event_type: 'SUPPLY_JUDGED', plan_id: 'PLAN-011', limit: 1e6 }).find((e) => e.caused_by === inb.event_id);
    assert.ok(judged, '정정 회신 → 입고 일정 → 다시 판정');
    assert.match(judged.generation_reason, /SKU-1002/);
    // 10-30 도착 전 판매 주(10-05~)는 다시 보충이 필요하다
    assert.ok(pick(p2.latestSupplyJudgment('PLAN-011').skus, { sku_id: 'SKU-1002' }).condition_basis.some((x) => x.condition_type === 'reorder_required'));
    assert.ok(app.events.query({ event_type: 'ALTERNATIVES_COMPUTED', plan_id: 'PLAN-011', limit: 1e6 }).some((e) => e.caused_by === judged.event_id));
  } finally { await close(); }
});

test('(d) 부분 가능 회신은 확약 수량만 반영하고 미확약 잔량·부족을 남기며 원래 발주 수량을 덮어쓰지 않는다', async () => {
  const { app, p1, p2, close } = await makeApp({ extra: { 'problem3/src/index.mjs': P3_STUB } });
  try {
    await applyV1(app, p2);
    await applyBR(p2);
    await p1.__register('PLAN-011', { uplift_pct: 100, sale_start_week: '2026-10-05', sale_weeks: 3 });
    const d0 = p2.poDrafts().find((d) => d.sku_id === 'SKU-1001');
    for (const d of p2.poDrafts()) await reply(app, d.po_draft_id, '승인');
    await app.clock.advance({ to: '2026-07-06' }); // S2-CVC-SKU-1001-1: L-02 97%로 절반만 배정
    const c = p2.supplyCommitments({ target_id: d0.po_draft_id })[0];
    assert.deepEqual([c.reply_status, c.validation_status, c.requested_qty, c.committed_qty, c.uncommitted_qty], ['부분 가능', '정상', 24000, 12000, 12000]);
    const rows = p2.inboundSchedule().rows.filter((r) => r.source_ref === d0.po_draft_id);
    assert.deepEqual(rows.map((r) => [r.qty, r.supply_status]).sort(), [[12000, '미확약 잔량'], [12000, '확약']]);
    assert.equal(p2.poDrafts({ po_draft_id: d0.po_draft_id })[0].order_qty, 24000); // 원래 발주 수량 유지
    const s1 = pick(p2.latestSupplyJudgment('PLAN-011').skus, { sku_id: 'SKU-1001' });
    assert.equal(s1.supply_verdict, '부족'); // 확약 12,000만으로는 판매 기간 안 캠페인 추가분이 모자란다
    assert.equal(s1.reorder_blocked.po_draft_id, d0.po_draft_id); // 같은 공급처 추가 보충으로 막지 않고 대안으로
    const pa = p2.planAlternatives('PLAN-011');
    assert.ok(pa.alternatives.some((a) => ['시기이동', '물량상한'].includes(a.alternative_type) && a.feasible));
    assert.equal(pa.alternatives.some((a) => a.alternative_type === '보충발주' && a.sku_id === 'SKU-1001'), false);
    assert.equal(p2.poDrafts().filter((d) => d.sku_id === 'SKU-1001').length, 1);
  } finally { await close(); }
});

test('(f) 같은 회신을 다시 처리해도 입고 행·발주안·사건(현금 유출 근거)이 늘지 않는다', async () => {
  const { app, p1, p2, close } = await makeApp({ extra: { 'problem3/src/index.mjs': P3_STUB } });
  try {
    await applyV1(app, p2);
    await applyBR(p2);
    await p1.__register('PLAN-002', { uplift_pct: 100, sale_start_week: '2026-08-31', sale_weeks: 4 });
    const pod = reorderOf(p2, 'PLAN-002')[0].po_draft_id;
    await approve(app, pod);
    await app.clock.advance({ to: '2026-07-06' });
    const snap = () => JSON.stringify({
      ev: ['SUPPLIER_REPLIED', 'INBOUND_SCHEDULE_REVISED', 'PO_DRAFT_CREATED', 'PO_DRAFT_CANCELLED', 'SUPPLY_JUDGED'].map((t) => app.events.query({ event_type: t, limit: 1e6 }).length),
      rows: p2.inboundSchedule().rows.map((r) => [r.inbound_row_id, r.qty, r.eta_date, r.supply_status]),
      drafts: p2.poDrafts().map((d) => [d.po_draft_id, d.draft_version, d.order_qty, d.amount_krw]),
      commitments: p2.supplyCommitments({ latest_only: false }).length,
    });
    const before = snap();
    const again = await p2.applySupplyCommitment({ record_id: 'S2-CVC-SKU-3003-N1', po_draft_id: pod }); // 첫 SKU-3003 발주안 회신(불가)
    assert.equal(again.already_applied, true);
    assert.equal((await p2.applyBaselinePlan({ date: '2026-07-03' })).skipped, true);
    assert.equal(await p2.processArrivals('2026-07-06'), null); // 같은 날 입고 처리도 다시 해도 없음
    await p2.applySupplyCommitment({ record_id: 'S2-CVC-SPO-0009-1' }); // 같은 기발주 회신(applyV1에서 이미 반영)
    assert.equal(snap(), before);
  } finally { await close(); }
});

test('모순 회신(생산 완료 > 도착)은 확인 필요로 입고를 바꾸지 않고 Corevia에 확인을 요청하며, 정정 회신으로 확약된다', async () => {
  const { app, p1, p2, close } = await makeApp({ extra: { 'problem3/src/index.mjs': P3_STUB } });
  try {
    await applyV1(app, p2);
    await applyBR(p2);
    await p1.__register('PLAN-001', { uplift_pct: 100, sale_start_week: '2026-09-07', sale_weeks: 4 });
    const pod = p2.poDrafts().find((d) => d.sku_id === 'SKU-2003').po_draft_id;
    for (const d of p2.poDrafts()) await reply(app, d.po_draft_id, '승인');
    await app.clock.advance({ to: '2026-07-06' });
    const c = p2.supplyCommitments({ target_id: pod })[0];
    assert.equal(c.validation_status, '확인 필요');
    assert.match(c.validation_issues[0], /생산 완료 예정일 2026-09-18이 도착 예정일 2026-09-04보다 늦음/);
    assert.equal(p2.inboundSchedule().rows.find((r) => r.source_ref === pod).supply_status, '예상');
    assert.ok(app.events.query({ event_type: 'INFO_REQUESTED', limit: 1e6 }).some((e) => e.payload.request_topic === 'supply_request' && e.payload.requested_to === 'COREVIA' && e.subject_id === c.supply_commitment_id));
    assert.ok(pick(p2.latestSupplyJudgment('PLAN-001').skus, { sku_id: 'SKU-2003' }).condition_basis.some((x) => x.condition_type === 'supply_commitment_pending'));
    await app.clock.advance({ to: '2026-07-09' }); // 정정 v2(승인 + 6영업일)
    assert.equal(p2.inboundSchedule().rows.find((r) => r.source_ref === pod).supply_status, '확약');
    // 2003은 SCM 보충 미확인(07-03)이라 그 조건은 남지만 공급 확약 대기는 풀린다
    assert.equal(pick(p2.latestSupplyJudgment('PLAN-001').skus, { sku_id: 'SKU-2003' }).condition_basis.some((x) => x.condition_type === 'supply_commitment_pending'), false);
  } finally { await close(); }
});

test('describeEvent: 문제 2가 낸 사건마다 한국어 카드(누가·어떤 자료·어떤 규칙·무엇이 바뀜)를 주고, 다른 모듈 사건은 null', async () => {
  const { app, p1, p2, close } = await makeApp({ extra: { 'problem3/src/index.mjs': P3_STUB } });
  try {
    await applyV1(app, p2);
    await applyBR(p2);
    await p2.applySupplyCommitment({ record_id: 'S2-CVC-SPO-0001-1' }); // 기발주 SPO-0001 미확인 회신
    await p1.__register('PLAN-002', { uplift_pct: 100, sale_start_week: '2026-08-31', sale_weeks: 4 });
    await p1.__register('PLAN-011', { uplift_pct: 10, sale_start_week: '2026-07-06', sale_weeks: 2 });
    const early = p2.alternatives({ plan_id: 'PLAN-011' }).find((a) => a.alternative_type === '조기분할요청');
    await p2.selectAlternative({ alternative_id: early.alternative_id, selected_by: 'SCM-PLANNER' });
    await p2.applySupplierReplies('PLAN-011');
    await app.events.emit({ event_type: 'PLAN_WITHDRAWN', source_type: '사람입력', is_synthetic: true, plan_id: 'PLAN-002', payload: { plan_id: 'PLAN-002' } }, 'p4');
    const mine = app.events.query({ limit: 1e6 }).filter((e) => e.emitted_by === 'p2');
    const types = new Set(mine.map((e) => e.event_type));
    for (const t of ['SUPPLY_PROJECTED', 'SUPPLY_JUDGED', 'INBOUND_SCHEDULE_REVISED', 'ALTERNATIVES_COMPUTED', 'ALTERNATIVE_SELECTED', 'PO_DRAFT_CREATED', 'PO_DRAFT_CANCELLED', 'SUPPLIER_REPLIED', 'INFO_REQUESTED']) assert.ok(types.has(t), t);
    for (const e of mine) {
      const c = p2.describeEvent(e);
      assert.ok(c, `${e.event_type} 카드 없음`);
      assert.ok(c.title && c.rule && c.result && ['사람', 'AI', '규칙·계산', '모의 입력'].includes(c.actor_kind) && c.actor_label, `${e.event_type} 필드`);
      for (const i of c.inputs) assert.ok(['원본', '합성', '계산', '사람입력', '모의회신', '가정'].includes(i.source), `${e.event_type} ${i.label} ${i.source}`);
      assert.doesNotMatch(`${c.title} ${c.result}`, /[A-Z]{3,}_[A-Z_]+/, `${e.event_type} 코드 이름이 남음`);
    }
    assert.equal(p2.describeEvent(app.events.query({ event_type: 'PLAN_WITHDRAWN' })[0]), null);
    // 판정 카드: 계기와 전후 결론, SKU·주·수량
    const j = app.events.query({ event_type: 'SUPPLY_JUDGED', plan_id: 'PLAN-011', order: 'desc', limit: 1 })[0];
    const c = p2.describeEvent(j);
    assert.match(c.title, /^공급 판정 v\d+ · PLAN-011: 부족$/);
    assert.equal(c.inputs[0].label, '다시 판정한 계기');
    assert.match(c.result, /^판정불가 → 부족\. SKU-1001 부족, 2026-08-03 주에 캠페인 추가분 1,582 EA가 모자람, 지금 발주해도 2026-09-28 주 전에는 도착하지 않음/);
    // 발주안 카드: 수량 내역과 실제 값
    const pc = p2.describeEvent(app.events.query({ event_type: 'PO_DRAFT_CREATED', plan_id: 'PLAN-002' })[0]);
    assert.match(pc.result, /^10,000 EA = 캠페인 추가분 8,144\.5 \+ MOQ 올림분 1,855\.5, 1\.68억 원\. 2026-07-10 발주 → 2026-08-17 주 도착/);
    const cc = p2.describeEvent(app.events.query({ event_type: 'SUPPLIER_REPLIED', limit: 1e6 }).find((e) => e.subject_id === 'SC-SPO-0001-v1'));
    assert.match(cc.title, /^Corevia 공급 회신 · 기발주 SPO-0001 SKU-1001: 미확인/);
    assert.ok(cc.inputs.some((i) => i.label === '원료 M-B' && /미확인/.test(i.value)));
    assert.equal(p2.describeEvent(app.events.query({ event_type: 'SUPPLIER_REPLIED' })[0]).actor_kind, '모의 입력');
  } finally { await close(); }
});

test('기안 담당자 API: 판정 한 문장·이유·조건과 대안 비교(바꾸는 것, 고르면 예상 판정, 실행 가능, 권장)', async () => {
  const { app, p1, p2, close } = await makeApp();
  try {
    await applyBR(p2);
    await p1.__register('PLAN-011', { uplift_pct: 10, sale_start_week: '2026-07-06', sale_weeks: 2 });
    const d = await app.router.match('GET', '/api/p2/plan/PLAN-011/decision').handler({ params: { plan_id: 'PLAN-011' } });
    assert.equal(d.verdict, '부족');
    assert.match(d.headline, /^지금 수요 입력으로는 SKU-1001 2026-08-03 주.*판매 시기·물량·구성을 바꾸거나 기안을 접어야 합니다\.$/);
    assert.equal(d.reasons.length, 4);
    const first = d.alternatives[0];
    assert.deepEqual([first.alternative_type, first.recommended, first.feasible, first.what_changes], ['시기이동', true, true, '2026-09-28부터 2주']);
    // 고르면 예상 판정(미리보기로 같은 규칙): 더마는 기발주 SPO-0001 미회신·SCM 보충 Corevia 미확약이라 조건이 남는다
    assert.equal(first.expected_verdict, '조건부(미확정 입고·기준 수요 보충 미확인)');
    assert.equal(first.select.path, `/api/p2/alternatives/${first.alternative_id}/select`);
    const cap = d.alternatives.find((a) => a.alternative_type === '물량상한');
    assert.deepEqual([cap.feasible, cap.expected_verdict, cap.select], [false, null, null]);
    assert.ok(cap.why_not);
    assert.ok(d.alternatives.findIndex((a) => !a.feasible) > d.alternatives.findLastIndex((a) => a.feasible)); // 실행 가능 먼저
    // 조건부 기안: 조건과 기다리는 쪽
    await p1.__register('PLAN-002', { uplift_pct: 100, sale_start_week: '2026-08-31', sale_weeks: 4 });
    const c = p2.planDecision('PLAN-002');
    assert.equal(c.verdict, '조건부');
    assert.match(c.headline, /^조건이 채워지면 공급할 수 있습니다\. SKU-3003 /);
    const rc = c.conditions.find((x) => x.type === '보충 발주 필요');
    assert.deepEqual([rc.sku_id, rc.waiting_on, rc.due], ['SKU-3003', '발주안 승인(문제 3 경로) 뒤 Corevia 공급 확약', '2026-08-21']);
    assert.ok(c.waiting_replies.some((w) => w.from === '승인권자(문제 3 경로)'));
    assert.ok(c.next_actions.length > 0);
  } finally { await close(); }
});

test('v2.1 기발주 Corevia 회신이 날짜대로 도착한다: 미확인(07-08)·원료 지연 정정(07-13, 한 번에 묶음)·모순→정정(07-15)·더마 부분·불가(08-06)', async () => {
  const { app, p2, close } = await makeApp();
  try {
    await app.clock.advance({ to: '2026-08-07' });
    const cm = (id) => p2.supplyCommitments({ target_id: id })[0];
    const row = (ref) => p2.inboundSchedule().rows.filter((r) => r.source_ref === ref).map((r) => [r.qty, r.supply_status]).sort();
    assert.deepEqual([cm('SPO-0001').reply_status, cm('SPO-0001').reply_as_of], ['미확인', '2026-07-08']);
    assert.deepEqual(row('SPO-0001'), [[24000, '예상']]);
    assert.deepEqual([cm('SPO-0005').reply_version, cm('SPO-0005').offered_eta_date, cm('SPO-0005').material_status, cm('SPO-0005').reply_as_of], [2, '2026-09-01', '확보 예정', '2026-07-13']);
    const d13 = app.events.query({ event_type: 'INBOUND_SCHEDULE_REVISED', limit: 1e6 }).filter((e) => e.occurred_at === '2026-07-13' && e.payload.supply_commitment_ids);
    assert.equal(d13.length, 1); // 같은 날 정정 3건은 입고 버전 하나로
    assert.deepEqual(d13[0].payload.supply_commitment_ids, ['SC-SPO-0005-v2', 'SC-SPO-0006-v2', 'SC-SPO-0007-v2']);
    assert.deepEqual(p2.supplyCommitments({ target_id: 'SPO-0012', latest_only: false }).map((c) => [c.reply_version, c.validation_status]), [[1, '확인 필요'], [2, '정상']]);
    assert.deepEqual(row('SPO-0012'), [[12000, '확약']]);
    assert.deepEqual([cm('SPO-0002').reply_status, cm('SPO-0002').committed_qty, cm('SPO-0002').uncommitted_qty], ['부분 가능', 12000, 12000]);
    assert.deepEqual(row('SPO-0002'), [[12000, '미확약 잔량'], [12000, '확약']]);
    assert.deepEqual([cm('SPO-0003').reply_status, cm('SPO-0003').production_status], ['불가', '미배정']);
    assert.deepEqual(row('SPO-0003'), [[20000, '공급 불가']]);
    assert.equal(p2.pendingSupplyCommitments().filter((x) => x.po_draft_id === null).length, 0); // 기발주 회신은 모두 도착
  } finally { await close(); }
});

test('v2.1 모순 회신의 정정은 확인 요청을 원인(caused_by)으로 남긴다', async () => {
  const { app, p2, close } = await makeApp();
  try {
    await app.clock.advance({ to: '2026-07-16' });
    const req = app.events.query({ event_type: 'INFO_REQUESTED', limit: 1e6 }).find((e) => [e.subject_id, e.payload?.subject_id].includes('SC-SPO-0012-v1'));
    const fix = app.events.query({ event_type: 'SUPPLIER_REPLIED', limit: 1e6 }).find((e) => e.subject_id === 'SC-SPO-0012-v2');
    assert.equal(fix.caused_by, req.event_id);
  } finally { await close(); }
});

test('L4 권장 대안은 고르면 예상되는 판정이 가장 좋은 것, 같으면 계획을 덜 바꾸는 쪽(구성 < 물량 < 시기)이고 이유를 싣는다', async () => {
  const { app, p1, p2, close } = await makeApp();
  try {
    await applyV1(app, p2);
    await applyBR(p2);
    await p1.__register('PLAN-002', { uplift_pct: 25, sale_start_week: '2026-07-27', sale_weeks: 7 });
    assert.equal(p2.latestSupplyJudgment('PLAN-002').plan.supply_verdict, '가능');
    await p2.applySupplyCommitment({ record_id: 'S2-CVC-SPO-0010-2' }); // SKU-3003 기발주 원료 지연 정정: 08-06 → 08-27
    const pa = p2.planAlternatives('PLAN-002');
    assert.equal(pa.supply_verdict, '부족');
    assert.deepEqual([pa.recommended.alternative_type, pa.recommended.expected_verdict, pa.recommended.score_label], ['구성이동', '가능', '가능']);
    assert.ok(pa.recommended.compared.some((x) => x.alternative_type === '시기이동' && x.expected_verdict === '가능')); // 같은 판정이면 덜 바꾸는 쪽
    assert.match(pa.recommended.reason, /지금 판정\(부족\)보다 낫고/);
    const dec = p2.planDecision('PLAN-002');
    const rec = dec.alternatives.find((a) => a.recommended);
    assert.deepEqual([rec.alternative_type, rec.score_label, rec.resolvable_before_deadline], ['구성이동', '가능', true]);
    assert.ok(rec.recommend_reason);
  } finally { await close(); }
});

test('L7 확약 입고는 도착일이 지나면 입고 완료, 확약 안 된 예상 입고는 예정일 경과·미확약으로 다음 주에 온다고 보고 조건에 남는다(중복 없음)', async () => {
  const { app, p1, p2, close } = await makeApp();
  try {
    await app.clock.advance({ to: '2026-09-01' });
    const rows = () => p2.inboundSchedule().rows;
    const done = rows().filter((r) => r.supply_status === '입고 완료');
    assert.ok(done.some((r) => r.source_ref === 'SPO-0008' && r.received_qty === 12000 && r.received_on === '2026-08-03'));
    assert.ok(done.every((r) => r.receipt_source === '모의 입력(확약 수량 그대로)' && r.receipt_is_synthetic));
    // SCM-BR:SKU-5002:1(미확약 정기 보충, 08-31 예정)은 입고 완료가 아니라 예정일 경과·미확약
    const od = rows().find((r) => r.source_ref === 'SCM-BR:SKU-5002:1');
    assert.deepEqual([od.supply_status, od.original_eta_date, od.expected_now_week], ['예정일 경과·미확약', '2026-08-31', '2026-09-07']);
    assert.equal(rows().find((r) => r.source_ref === 'SPO-0003').supply_status, '공급 불가'); // 불가는 바뀌지 않음
    const ev = app.events.query({ event_type: 'INBOUND_SCHEDULE_REVISED', limit: 1e6 }).filter((e) => e.payload.receipts?.length);
    assert.equal(ev[0].source_type, '사람입력');
    assert.equal(ev[0].is_synthetic, true);
    const before = rows().length;
    assert.equal(await p2.processArrivals('2026-09-01'), null); // 같은 날 다시 돌려도 바뀌는 것 없음
    assert.equal(rows().length, before);
    // 예정일 경과 행은 오는 경우(on_schedule)에는 다음 주(09-07)에 들어오고, 확약만 보는 경우에서는 빠진다
    const proj = (sc) => p2.supplyProjectionBase({ sku_id: 'SKU-5002', inbound_scenario: sc });
    const wk = (sc, w) => proj(sc).find((r) => r.week_start === w).projected_on_hand_qty;
    assert.ok(wk('on_schedule', '2026-09-07') - wk('on_schedule', '2026-08-31') > 0); // 09-07 주에 들어옴
    assert.ok(wk('not_arrived', '2026-09-07') < wk('not_arrived', '2026-08-31')); // 확약만 보면 들어오지 않음
    void p1;
  } finally { await close(); }
});

test('v2.2 불리한 공급 회신 배치: 실제 흐름의 보충 발주안(SKU-3003 첫 발주안 불가)과 SKU-3003 기발주 원료 지연 정정(07-17), SKU-2003 보충 계획 후속 확인(08-07)', async () => {
  const { app, p2, close } = await makeApp();
  try {
    await app.clock.advance({ to: '2026-08-07' });
    const c = p2.supplyCommitments({ target_id: 'SPO-0010' })[0];
    assert.deepEqual([c.reply_version, c.offered_eta_date, c.material_id, c.material_status, c.reply_as_of], [2, '2026-08-27', 'M-D', '확보 예정', '2026-07-17']);
    assert.match(c.eta_basis, /스팟 선적 지연/);
    assert.equal(p2.baselineReplenishment({ sku_id: 'SKU-2003' })[0].plan_status, 'SCM 확인·Corevia 확약'); // 07-03 미확인 → 08-07 후속 회신
  } finally { await close(); }
  // 보충 발주안 대상: SKU-3003 첫 승인 발주안은 불가 회신을 받는다(SKU-4002 첫 발주안 부분 가능은 BASE 흐름에서 확인)
  const b = await makeApp({ extra: { 'problem3/src/index.mjs': P3_STUB } });
  try {
    await applyV1(b.app, b.p2);
    await applyBR(b.p2);
    await b.p1.__register('PLAN-002', { uplift_pct: 100, sale_start_week: '2026-08-31', sale_weeks: 4 });
    const pod = reorderOf(b.p2, 'PLAN-002')[0].po_draft_id;
    await approve(b.app, pod);
    assert.equal(b.p2.pendingSupplyCommitments().find((x) => x.po_draft_id === pod).record_id, 'S2-CVC-SKU-3003-N1');
    await b.app.clock.advance({ to: '2026-07-06' });
    const c3 = b.p2.supplyCommitments({ target_id: pod })[0];
    assert.deepEqual([c3.reply_status, c3.material_id, c3.production_status], ['불가', 'M-D', '미배정']);
    assert.equal(b.p2.inboundSchedule().rows.find((r) => r.source_ref === pod).supply_status, '공급 불가');
    assert.equal(pick(b.p2.latestSupplyJudgment('PLAN-002').skus, { sku_id: 'SKU-3003' }).reorder_blocked.po_draft_id, pod);
  } finally { await b.close(); }
});

// ── 2026-11-15 남은 결함 마무리 ──
const P3_WIN = `
export function register(ctx) {
  let win = { next_outside_date: '2026-09-07', window_version: 'CW-T1' };
  ctx.expose({ commitment: (id) => ({ commitment_id: id, source_id: String(id).replace(/^CMT-/, '') }), cashWindow: () => win, __setWindow: (w) => { win = w; } });
}`;
test('(1) 집행일이동의 새 집행일은 고르는 시점의 하회 구간 밖 첫 영업일 + 여유 1주이고, 기안 담당자 카드도 같은 날을 제안한다', async () => {
  const { app, p1, p2, close } = await makeApp({ extra: { 'problem3/src/index.mjs': P3_WIN } });
  try {
    await p1.__register('PLAN-003', { uplift_pct: 10, sale_start_week: '2026-08-03', sale_weeks: 2 });
    await app.events.emit({ event_type: 'APPROVAL_REPLIED', source_type: '모의회신', is_synthetic: true, plan_id: 'PLAN-003', payload: { commitment_id: 'CMT-PLAN-003', decision: '거절', conditions: [] } }, 'p4');
    app.module('p3').__setWindow({ next_outside_date: '2026-09-04', window_version: 'CW-T2' }); // 회수일 지연으로 구간이 09-04까지(고를 때 다시 읽는다)
    const card = p2.planDecision('PLAN-003').alternatives.find((a) => a.alternative_type === '집행일이동');
    assert.equal(card.proposed_settlement_date, '2026-09-11'); // 09-04 + 7일(금)
    assert.match(card.what_changes, /2026-09-11.*2026-09-04 \+ 여유 1주/);
    const alt = p2.alternatives({ plan_id: 'PLAN-003' }).find((a) => a.alternative_type === '집행일이동');
    const r = await p2.selectAlternative({ alternative_id: alt.alternative_id, selected_by: 'MKT-LINE-OWNER' });
    assert.deepEqual([r.plan_change.settlement_date, r.plan_change.next_outside_date, r.plan_change.cash_window_version], ['2026-09-11', '2026-09-04', 'CW-T2']);
    await assert.rejects(p2.selectAlternative({ alternative_id: alt.alternative_id, selected_by: 'MKT-LINE-OWNER', settlement_date: '2026-08-31' }), /하회 구간 밖 첫날/);
  } finally { await close(); }
});

test('(2) 조건이 특정 품목의 미확인 보충에서 오면 그 품목을 빼는 구성이동이 후보에 나오고 예상 가능으로 권장된다(판매 기간 뒤 부족도 실행 가능 판단에 넣음)', async () => {
  const { app, p1, p2, close } = await makeApp({ extra: { 'problem3/src/index.mjs': P3_STUB } });
  try {
    await applyV1(app, p2);
    await applyBR(p2);
    await p1.__register('PLAN-001', { uplift_pct: 10, sale_start_week: '2026-09-21', sale_weeks: 4 });
    for (const d of p2.poDrafts()) await reply(app, d.po_draft_id, '승인');
    await app.clock.advance({ to: '2026-07-13' });
    const pa = p2.planAlternatives('PLAN-001');
    assert.deepEqual(pa.condition_basis.map((c) => [c.condition_type, c.sku_id, c.reason]), [['baseline_replenishment_unconfirmed', 'SKU-2003', '보충 계획 미확인']]);
    const comp = pa.alternatives.find((a) => a.alternative_type === '구성이동');
    assert.equal(comp.feasible, true);
    assert.equal(comp.new_override_uplift_pct.find((o) => o.sku_id === 'SKU-2003').override_uplift_pct, 0); // 미확인 보충 품목을 뺀다
    assert.deepEqual([pa.recommended.alternative_type, pa.recommended.expected_verdict], ['구성이동', '가능']);
    // 같은 증가율로 미루는 시기이동은 그 품목이 그대로라 '실행 가능'이어도 권장되지 않는다
    assert.notEqual(pa.recommended.alternative_type, '시기이동');
  } finally { await close(); }
});

test('(3) 연결 기안이 바뀌면 같은 판으로 PO_DRAFT_CREATED(change_kind)를 내고, 철회 처리 구분(취소 / 기안만 뗌 / 발주 전달 뒤 남음)을 사건에 싣는다', async () => {
  const { app, p1, p2, close } = await makeApp({ extra: { 'problem3/src/index.mjs': P3_STUB } });
  try {
    await applyV1(app, p2);
    await applyBR(p2);
    await p1.__register('PLAN-001', { uplift_pct: 100, sale_start_week: '2026-09-07', sale_weeks: 4 });
    const d0 = p2.poDrafts().find((d) => d.sku_id === 'SKU-2002');
    await p1.__register('PLAN-012', { uplift_pct: 10, sale_start_week: '2026-09-14', sale_weeks: 4 }); // MOQ 안이라 수량은 그대로, 연결만 늘어남
    const relink = app.events.query({ event_type: 'PO_DRAFT_CREATED', limit: 1e6 }).filter((e) => e.payload.po_draft_id === d0.po_draft_id && e.payload.change_kind === 'linked_plans_changed');
    assert.ok(relink.length >= 1);
    assert.deepEqual([relink.at(-1).payload.draft_version, relink.at(-1).payload.linked_plan_ids], [d0.draft_version, ['PLAN-001', 'PLAN-012']]);
    // 승인 뒤 PLAN-012 철회(발주 전달 전, 수량 그대로) → 기안만 뗌
    await approve(app, d0.po_draft_id);
    await app.events.emit({ event_type: 'PLAN_WITHDRAWN', source_type: '사람입력', is_synthetic: true, plan_id: 'PLAN-012', payload: { plan_id: 'PLAN-012' } }, 'p4');
    const e1 = app.events.query({ event_type: 'PO_DRAFT_CREATED', limit: 1e6 }).filter((e) => e.payload.po_draft_id === d0.po_draft_id && e.payload.withdrawal).at(-1);
    assert.deepEqual([e1.payload.withdrawal.disposition, e1.payload.linked_plan_ids, e1.payload.linked_plan_ids_before], ['기안만 뗌', ['PLAN-001'], ['PLAN-001', 'PLAN-012']]);
    // 발주 전달 뒤 PLAN-001 철회 → 발주 전달 뒤 남음
    await app.clock.advance({ to: '2026-07-10' });
    await app.events.emit({ event_type: 'PLAN_WITHDRAWN', source_type: '사람입력', is_synthetic: true, plan_id: 'PLAN-001', payload: { plan_id: 'PLAN-001' } }, 'p4');
    const e2 = app.events.query({ event_type: 'PO_DRAFT_CREATED', limit: 1e6 }).filter((e) => e.payload.po_draft_id === d0.po_draft_id && e.payload.withdrawal).at(-1);
    assert.deepEqual([e2.payload.withdrawal.disposition, e2.payload.linked_plan_ids, e2.payload.orphan_status], ['발주 전달 뒤 남음', [], '기안 철회 뒤 남은 발주']);
    assert.equal(p2.describeEvent(e2).title.startsWith('발주안 연결 기안 변경'), true);
  } finally { await close(); }
  // 발주 전달 전·한 기안만 → 취소 사건에 처리 구분
  const b = await makeApp({ extra: { 'problem3/src/index.mjs': P3_STUB } });
  try {
    await applyV1(b.app, b.p2);
    await applyBR(b.p2);
    await b.p1.__register('PLAN-002', { uplift_pct: 100, sale_start_week: '2026-08-31', sale_weeks: 4 });
    const pod = reorderOf(b.p2, 'PLAN-002')[0].po_draft_id;
    await approve(b.app, pod);
    await b.app.events.emit({ event_type: 'PLAN_WITHDRAWN', source_type: '사람입력', is_synthetic: true, plan_id: 'PLAN-002', payload: { plan_id: 'PLAN-002' } }, 'p4');
    const c = b.app.events.query({ event_type: 'PO_DRAFT_CANCELLED', limit: 1e6 }).find((e) => e.payload.po_draft_id === pod);
    assert.deepEqual([c.payload.withdrawal.disposition, c.payload.linked_plan_ids, c.payload.linked_plan_ids_before], ['취소', [], ['PLAN-002']]);
  } finally { await b.close(); }
});

test('(4) 평가자 카드에 IN_TRANSIT·SCM-BR 같은 코드 이름이 남지 않는다(운송 중 물량·SCM 정기 보충)', async () => {
  const { app, p1, p2, close } = await makeApp();
  try {
    await p1.__register('PLAN-002', { uplift_pct: 35, sale_start_week: '2026-07-20', sale_weeks: 4 }); // 07-01: SKU-3003 운송 중 물량·SPO-0010 미확정
    await app.clock.advance({ to: '2026-07-06' });
    const texts = app.events.query({ limit: 1e6 }).filter((e) => e.emitted_by === 'p2').map((e) => p2.describeEvent(e)).filter(Boolean)
      .map((c) => JSON.stringify([c.title, c.result, c.inputs.map((i) => [i.label, i.value])]));
    assert.ok(texts.some((t) => t.includes('운송 중 물량(')));
    assert.equal(texts.some((t) => /IN_TRANSIT|SCM-BR:/.test(t)), false);
  } finally { await close(); }
});
