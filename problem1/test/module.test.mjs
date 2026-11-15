// 모듈 통합: 임시 루트에 problem1(src, 도출 자료, 테스트 고정 회신)만 두고 앱을 띄운다. 문제 2~4는 없다(연결 안 됨).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../app/main.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const P1 = path.resolve(HERE, '..');
const quiet = { log() {}, error() {} };

async function makeApp(opts = {}, stubs = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'w01-p1-'));
  for (const [n, code] of Object.entries(stubs)) {
    mkdirSync(path.join(root, `problem${n}`, 'src'), { recursive: true });
    writeFileSync(path.join(root, `problem${n}`, 'src', 'index.mjs'), code);
  }
  cpSync(path.join(P1, 'src'), path.join(root, 'problem1', 'src'), { recursive: true });
  cpSync(path.join(P1, 'data', 'derived'), path.join(root, 'problem1', 'data', 'derived'), { recursive: true });
  cpSync(path.join(HERE, 'fixtures'), path.join(root, 'problem1', 'data', 'synthetic'), { recursive: true });
  const app = await createApp({ rootDir: root, dbPath: ':memory:', env: {}, log: quiet, ...opts });
  const done = async () => { await app.close(); rmSync(root, { recursive: true, force: true }); };
  return { app, p1: app.module('p1'), done };
}
const types = (app, planId) => app.events.query({ plan_id: planId }).map((e) => e.event_type);

test('등록·초기화: 모듈 로드, BASELINE_DEMAND_SET, 공개 함수의 원본 도출 값', async () => {
  const { app, p1, done } = await makeApp();
  try {
    assert.equal(app.modules[0].loaded, true, app.modules[0].error);
    const init = app.events.query({ event_type: 'BASELINE_DEMAND_SET' });
    assert.equal(init.length, 1);
    assert.equal(init[0].payload.baseline_demand_version, 'BD-2026-06-29');
    assert.equal(p1.planSkuMap().length, 69);
    assert.equal(p1.planSkuMap({ sku_id: 'SKU-3003' }).length, 10); // 색조 기안 10건
    assert.equal(p1.baselineDemand('SKU-3001').baseline_weekly_qty, 882.5);
    assert.equal(p1.baselineDemand().length, 14);
    assert.equal(p1.demandInput('PLAN-002'), null);
    assert.equal(p1.demandStatusByPlan('PLAN-002').demand_status, '미입력');
    assert.equal(p1.demandStatusByPlan().length, 25);
    const prev = p1.previewAddedQty({ plan_id: 'PLAN-002', sale_start_week: '2026-07-20', sale_weeks: 4, uplift_pct: 20 });
    assert.equal(prev.length, 12);
    assert.equal(prev.reduce((a, r) => a + r.added_qty_ea, 0), 4 * (177 + 174 + 856));
    assert.throws(() => p1.previewAddedQty({ plan_id: 'PLAN-002', sale_start_week: '2026-07-22', sale_weeks: 4, uplift_pct: 20 }), /월요일/);
  } finally { await done(); }
});

test('정상: PLAN-002 모의 회신 → 확인대기 → 확인 → 유효 v1, EA 12행(4,828)', async () => {
  const { app, p1, done } = await makeApp();
  try {
    const r = await p1.deliverMockRecord('T-S1-001');
    assert.equal(r.request_linked, false); // 문제 4 없음
    assert.equal(r.confirm.version_status, '유효');
    assert.deepEqual(types(app, 'PLAN-002'), ['INFO_REPLIED', 'DEMAND_INPUT_REGISTERED']);
    const reg = app.events.query({ event_type: 'DEMAND_INPUT_REGISTERED' })[0];
    assert.equal(reg.source_type, '사람입력');
    assert.equal(reg.is_synthetic, true);
    assert.equal(reg.is_simulation, true);
    assert.deepEqual(reg.payload, { demand_input_id: 'DI-PLAN-002', version: 1 });
    assert.deepEqual(reg.premise_refs, [{ baseline_demand_version: 'BD-2026-06-29' }]);
    const di = p1.demandInput('PLAN-002');
    assert.equal(di.version_status, '유효');
    assert.equal(di.uplift_pct, 20);
    assert.equal(di.sale_start_week, '2026-07-20');
    const w = p1.campaignDemandWeekly({ plan_id: 'PLAN-002' });
    assert.equal(w.length, 12);
    assert.equal(w.reduce((a, x) => a + x.added_qty_ea, 0), 4828);
    assert.ok(w.every((x) => x.is_simulation === true));
    assert.equal(p1.campaignDemandWeekly({ sku_id: 'SKU-3003' }).length, 4);
    assert.equal(p1.demandStatusByPlan('PLAN-002').demand_status, '등록됨');
    // 같은 행은 한 번만 전달
    assert.equal((await p1.deliverMockRecord('T-S1-001')).already_delivered, true);
    assert.equal(app.events.query({ event_type: 'INFO_REPLIED' }).length, 1);
  } finally { await done(); }
});

test('변경: PLAN-014 정정 회신 → 확인 중에도 v1 유효 유지 → v2 REVISED, v1 대체됨, SKU-3003 5%', async () => {
  const { app, p1, done } = await makeApp();
  try {
    await p1.deliverMockRecord('T-S1-002');
    const r = await p1.deliverMockRecord('T-S1-003', { auto_confirm: false });
    assert.equal(p1.demandStatusByPlan('PLAN-014').demand_status, '확인대기');
    assert.equal(p1.demandInput('PLAN-014').version, 1); // 정정 확인 중에도 판정은 v1로(사전 3.1)
    const c = await p1.confirmDemandInput({ demand_input_id: r.demand_input_id, version: r.version,
      fields: { uplift_pct: 25, sale_start_week: '2026-07-27', sale_weeks: 3, overrides: [{ sku_id: 'SKU-3003', override_uplift_pct: 5 }], basis_as_of: '2026-07-01' } });
    assert.equal(c.event_type, 'DEMAND_INPUT_REVISED');
    const rev = app.events.get(c.event_id);
    assert.deepEqual(rev.payload.changed_fields, ['uplift_pct', 'sku_overrides']);
    assert.equal(rev.payload.origin, 'reply');
    assert.deepEqual(p1.demandInputVersions('PLAN-014').map((v) => v.version_status), ['대체됨', '유효']);
    assert.equal(p1.demandStatusByPlan('PLAN-014').demand_status, '정정됨');
    assert.deepEqual(p1.skuOverrides('DI-PLAN-014', 2).map((o) => [o.sku_id, o.override_uplift_pct]), [['SKU-3003', 5]]);
    const w = p1.campaignDemandWeekly({ plan_id: 'PLAN-014' });
    assert.equal(w.length, 9);
    assert.ok(w.every((x) => x.version === 2));
    assert.equal(w.find((x) => x.sku_id === 'SKU-3001').added_qty_ea, 221);
    assert.equal(w.find((x) => x.sku_id === 'SKU-3003').added_qty_ea, 214);
    assert.equal(p1.campaignDemandWeekly({ demand_input_id: 'DI-PLAN-014', version: 1 }).find((x) => x.sku_id === 'SKU-3001').added_qty_ea, 88); // 88.25
  } finally { await done(); }
});

test('정보 부족·반려: 수요일 시작은 검증 반려, 담당 거부도 반려. 기본값을 넣지 않는다', async () => {
  const { app, p1, done } = await makeApp();
  try {
    await app.clock.advance({ to: '2026-08-05' });
    const r = await p1.deliverMockRecord('T-S1-004');
    assert.equal(r.confirm.version_status, '반려');
    assert.match(r.confirm.reject_reason, /월요일/);
    const rej = app.events.query({ event_type: 'DEMAND_INPUT_REJECTED' })[0];
    assert.equal(rej.source_type, '계산');
    assert.equal(rej.plan_id, 'PLAN-011');
    assert.equal(p1.demandStatusByPlan('PLAN-011').demand_status, '미입력');
    assert.equal(p1.demandInput('PLAN-011'), null);
    const g = await p1.deliverMockRecord('T-S1-005');
    assert.equal(g.confirm.reject_reason, '담당자 확인 거부');
    assert.equal(app.events.get(g.confirm.event_id).source_type, '사람입력');
    assert.equal(p1.campaignDemandWeekly({ plan_id: 'PLAN-001' }).length, 0);
    // 미등록 기안(PLAN-005)은 아무 버전도 없다
    assert.deepEqual(p1.demandInputVersions('PLAN-005'), []);
  } finally { await done(); }
});

test('대안 선택(문제 2 사건): 물량상한 → 새 버전 origin=alternative, 보충발주는 무시', async () => {
  const { app, p1, done } = await makeApp();
  try {
    await p1.deliverMockRecord('T-S1-001');
    const sel = await app.events.emit({ event_type: 'ALTERNATIVE_SELECTED', source_type: '사람입력', is_synthetic: true, plan_id: 'PLAN-002', actor_dept: 'MKT',
      payload: { alternative_id: 'ALT-1', plan_id: 'PLAN-002', alternative_type: '물량상한',
        alternative_selection: { plan_id: 'PLAN-002', alternative_id: 'ALT-1', alternative_type: '물량상한', new_uplift_pct: 12.5, selected_by: 'MKT-LINE-OWNER' } } }, 'p2');
    const rev = app.events.query({ event_type: 'DEMAND_INPUT_REVISED' })[0];
    assert.equal(rev.caused_by, sel.event_id);
    assert.equal(rev.payload.origin, 'alternative');
    assert.deepEqual(rev.payload.changed_fields, ['uplift_pct']);
    const di = p1.demandInput('PLAN-002');
    assert.equal(di.version, 2);
    assert.equal(di.uplift_pct, 12.5);
    assert.equal(di.sale_start_week, '2026-07-20'); // 이어받음
    assert.equal(p1.campaignDemandWeekly({ plan_id: 'PLAN-002', sku_id: 'SKU-3003' })[0].added_qty_ea, 535);
    await app.events.emit({ event_type: 'ALTERNATIVE_SELECTED', source_type: '사람입력', plan_id: 'PLAN-002',
      payload: { alternative_id: 'ALT-2', plan_id: 'PLAN-002', alternative_type: '보충발주' } }, 'p2');
    // PLAN-003 거절 뒤 대안은 집행일 이동(조정자 확정 2). 수요 입력은 바뀌지 않는다
    await app.events.emit({ event_type: 'ALTERNATIVE_SELECTED', source_type: '사람입력', plan_id: 'PLAN-002',
      payload: { alternative_id: 'ALT-3', plan_id: 'PLAN-002', alternative_type: '집행일이동', plan_change: { plan_id: 'PLAN-002', plan_version: 2, settlement_date: '2026-08-24' } } }, 'p2');
    assert.equal(p1.demandInputVersions('PLAN-002').length, 2);
  } finally { await done(); }
});

test('AI 연결: 구조화 → DEMAND_INPUT_STRUCTURED(누락 표시) → 확인 시 수정 후 확인 기록', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ model: 'anthropic/claude-opus-5.5', choices: [{ message: { content: JSON.stringify({
      fields: { uplift_pct: 20, sale_start_week: '2026-07-20', sale_weeks: null, sku_overrides: [], rationale_text: null },
      unclear_reasons: ['판매 주수가 회신에 없음'] }) } }] }) };
  };
  const { app, p1, done } = await makeApp({ env: { OPENROUTER_API_KEY: 'test' }, fetchImpl });
  try {
    // AI 구조화는 화면에서 사람이 넣을 때만 부른다
    const t = await p1.receiveReply({ plan_id: 'PLAN-002', reply_text: '판매는 2026-07-20 주부터, 기준 수요 대비 20% 증가로 봅니다.',
      source_type: '사람입력', source_ref: ['ui:p1-entry'] });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, 'anthropic/claude-opus-5.5');
    assert.deepEqual(calls[0].response_format, { type: 'json_object' });
    // 가상 일자와 기준 연도를 주어 '08-17 주' 같은 표현을 날짜로 바꾸게 한다
    assert.match(calls[0].messages[0].content, /오늘\(가상 일자\)은 2026-07-01/);
    assert.match(calls[0].messages[0].content, /기준 연도는 2026년/);
    assert.match(calls[0].messages[1].content, /SKU-3003=색조 아이팔레트/);
    const st = app.events.query({ event_type: 'DEMAND_INPUT_STRUCTURED' })[0];
    assert.deepEqual(st.payload.missing_fields, ['sale_weeks']);
    const c = await p1.confirmDemandInput({ demand_input_id: t.demand_input_id, version: t.version,
      fields: { uplift_pct: 20, sale_start_week: '2026-07-20', sale_weeks: 4 } });
    assert.equal(c.version_status, '유효');
    assert.equal(st.payload.extracted_fields.uplift_pct, 20);
    const rv = app.events.query({ event_type: 'AI_OUTPUT_REVIEWED' })[0];
    assert.equal(rv.payload.review_result, '수정 후 확인');
    assert.deepEqual(rv.payload.edited_fields, ['sale_weeks']);
    assert.deepEqual(types(app, 'PLAN-002'), ['INFO_REPLIED', 'AI_CALL_RECORDED', 'DEMAND_INPUT_STRUCTURED', 'AI_OUTPUT_REVIEWED', 'DEMAND_INPUT_REGISTERED']);
  } finally { await done(); }
});

test('AI 실패: HTTP 오류여도 확인대기로 남고 담당자 입력으로 진행', async () => {
  const fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}) });
  const { app, p1, done } = await makeApp({ env: { OPENROUTER_API_KEY: 'test' }, fetchImpl });
  try {
    const r = await p1.receiveReply({ plan_id: 'PLAN-002', reply_text: '7/20 주부터 4주, 20%', source_type: '사람입력', source_ref: ['ui:p1-entry'] });
    const v = p1.demandInput('PLAN-002', { version: r.version });
    assert.equal(v.version_status, '확인대기');
    assert.equal(app.events.query({ event_type: 'DEMAND_INPUT_STRUCTURED' }).length, 0);
    const c = await p1.confirmDemandInput({ demand_input_id: r.demand_input_id, version: r.version,
      fields: { uplift_pct: '20', sale_start_week: '2026-07-20', sale_weeks: '4' } });
    assert.equal(c.version_status, '유효');
  } finally { await done(); }
});

test('HTTP: PLAN-002 화면 내용, 연결 안 됨 표시, 회신 입력·확인 경로, 초기화', async () => {
  const { app, done } = await makeApp();
  const port = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  const post = async (p, body) => { const res = await fetch(`${base}${p}`, { method: 'POST', body: JSON.stringify(body) }); return { status: res.status, body: await res.json() }; };
  try {
    const v = await (await fetch(`${base}/api/p1/plans/PLAN-002`)).json();
    assert.equal(v.baseline_demand.length, 3);
    assert.equal(v.reference_metrics.nominal_roas, 1.58);
    assert.equal(v.external.supply_summary.connected, false);
    assert.equal(v.external.deadline.connected, false);
    assert.equal(v.external.grid.projection_end_week, '2026-12-28');
    const rep = await post('/api/p1/plans/PLAN-002/replies', { reply_text: '7/20 주부터 4주, 20%' });
    assert.equal(rep.status, 200);
    const bad = await post(`/api/p1/demand-inputs/DI-PLAN-002/versions/${rep.body.version}/confirm`, { fields: { uplift_pct: '20', sale_start_week: '2026-07-20', sale_weeks: '60' } });
    assert.equal(bad.body.version_status, '반려');
    assert.equal((await post(`/api/p1/demand-inputs/DI-PLAN-002/versions/${rep.body.version}/confirm`, {})).status, 409);
    assert.equal((await post('/api/p1/preview', { plan_id: 'PLAN-002', sale_start_week: '2026-07-21', sale_weeks: 1, uplift_pct: 1 })).status, 400);
    const plans = await (await fetch(`${base}/api/plans`)).json();
    assert.equal(plans.plans.find((p) => p.plan_id === 'PLAN-002').summaries[0].value, '미입력');
    assert.equal((await fetch(`${base}/panels/p1.js`)).status, 200);
    const mock = await (await fetch(`${base}/api/p1/mock`)).json();
    assert.equal(mock.rows.length, 5);
    assert.equal(mock.schedule.connected, false);
    await post('/api/reset', {});
    assert.deepEqual((await (await fetch(`${base}/api/p1/plans/PLAN-002`)).json()).versions, []);
    assert.equal(app.events.query({ event_type: 'BASELINE_DEMAND_SET' }).length, 1);
  } finally { await done(); }
});

// 문제 2·4 대역(stub): 잔여 여지 요약과 재검토의 rejudge 처리를 본다.
const P2_STUB = `export function register(ctx) {
  const W = ['2026-07-06', '2026-07-13', '2026-07-20', '2026-07-27'];
  const qty = { on_schedule: [500, 300, 400, 900], not_arrived: [500, 0, 0, 900] };
  ctx.expose({
    residualHeadroom: ({ plan_id }) => plan_id === 'PLAN-003'
      ? ['on_schedule', 'not_arrived'].flatMap((sc) => W.map((w, i) => {
        const R = sc === 'on_schedule' ? 0 : 2; // on_schedule: 전 구간 보충 가능, not_arrived: 07-20 주부터 보충 가능
        return { plan_id, sku_id: 'SKU-3001', week_start: w, inbound_scenario: sc, supply_window: i < R ? 'unpreventable' : 'reorder',
          residual_headroom_qty: i < R ? [150, 120][i] : null };
      }))
      : ['on_schedule', 'not_arrived'].flatMap((sc) => W.map((w, i) => ({ plan_id, sku_id: 'SKU-3001', week_start: w,
        inbound_scenario: sc, residual_headroom_qty: qty[sc][i], reorder_reach_week: '2026-07-27' }))),
    baselineReplenishment: () => [{ sku_id: 'SKU-3001', plan_status: 'SCM 확인·Corevia 미확약', scm_confirmed: '확인', corevia_committed: '미확약', plan_qty_total: 5000,
      plan_rows: [{ source_ref: 'SCM-BR:SKU-3001:1', qty: 5000, planned_order_date: '2026-07-10', eta_date: '2026-09-02', supply_status: '예상' }] }],
    baseOnlyShortfall: ({ sku_id }) => sku_id === 'SKU-3001' ? [{ sku_id, inbound_scenario: 'on_schedule', first_stockout_week: null, recovery_week: null, stockout_weeks: [] },
      { sku_id, inbound_scenario: 'not_arrived', first_stockout_week: '2026-07-13', recovery_week: '2026-08-03', stockout_weeks: ['2026-07-13', '2026-07-20'] }] : [],
  });
}`;
const P4_STUB = `export function register(ctx) {
  const calls = [];
  ctx.expose({ calls, requestInfo: async (r) => { calls.push(r); return { request_id: 'REQ-T', ...r }; } });
}`;

test('잔여 여지 요약: 막을 수 없는 구간(reorder_reach_week 전)의 최소와 품절 첫 주만 보인다', async () => {
  const { app, done } = await makeApp({}, { 2: P2_STUB });
  const port = await app.listen(0, '127.0.0.1');
  try {
    const v = await (await fetch(`http://127.0.0.1:${port}/api/p1/plans/PLAN-002`)).json();
    const s = v.external.supply_summary.value;
    assert.equal(s.length, 2);
    const on = s.find((x) => x.inbound_scenario === 'on_schedule');
    assert.deepEqual([on.min_residual_headroom_qty, on.min_week_start, on.first_stockout_week], [300, '2026-07-13', null]); // 07-27 주(900) 이후는 제외
    const na = s.find((x) => x.inbound_scenario === 'not_arrived');
    assert.deepEqual([na.min_residual_headroom_qty, na.first_stockout_week, na.headroom_state], [0, '2026-07-13', 'zero']);
    assert.equal(on.headroom_state, 'room');
    // 문제 2 형식: 보충 가능 구간은 residual_headroom_qty=null, supply_window='reorder'. null을 0과 섞지 않는다
    const v2 = await (await fetch(`http://127.0.0.1:${port}/api/p1/plans/PLAN-003`)).json();
    const s2 = v2.external.supply_summary.value;
    assert.deepEqual(s2.map((x) => [x.inbound_scenario, x.headroom_state, x.min_residual_headroom_qty, x.reorder_reach_week]),
      [['on_schedule', 'none', null, '2026-07-06'], ['not_arrived', 'room', 120, '2026-07-20']]);
  } finally { await done(); }
});

test('REVIEW_OPENED: target_type=demand_input이면 정정 요청, rejudge=false면 내지 않는다', async () => {
  const { app, done } = await makeApp({}, { 4: P4_STUB });
  try {
    const p4 = app.module('p4');
    const open = (rejudge) => app.events.emit({ event_type: 'REVIEW_OPENED', source_type: '계산', plan_id: 'PLAN-014',
      payload: { review_id: `RV-${rejudge}`, review_kind: '전제 변경', target_type: 'demand_input', target_id: 'DI-PLAN-014', rejudge } }, 'p4');
    await open(false);
    assert.equal(p4.calls.length, 0);
    await open(true);
    assert.equal(p4.calls.length, 1);
    assert.equal(p4.calls[0].request_kind, 'correction');
    await app.events.emit({ event_type: 'REVIEW_OPENED', source_type: '계산', plan_id: 'PLAN-014',
      payload: { review_id: 'RV-x', target_type: 'supply_judgment', target_id: 'SJ-PLAN-014', rejudge: true } }, 'p4');
    assert.equal(p4.calls.length, 1);
  } finally { await done(); }
});

test('시기 이동(모의 입력): 문제 2 형식의 ALTERNATIVE_SELECTED → 새 버전, 판매 주 이동, 가상 입력 표시 유지', async () => {
  const { app, p1, done } = await makeApp();
  try {
    await p1.deliverMockRecord('T-S1-001'); // PLAN-002 v1: 07-20부터 4주, 20%
    await app.clock.advance({ to: '2026-07-13' });
    // 문제 2 selectAlternative와 같은 모양: 사람입력·is_synthetic, alternative_selection은 바뀌는 필드만, override는 빈 배열
    const sel = await app.events.emit({ event_type: 'ALTERNATIVE_SELECTED', source_type: '사람입력', is_synthetic: true, plan_id: 'PLAN-002',
      actor_dept: 'MKT', actor_role: 'MKT-LINE-OWNER', subject_type: 'alternative', subject_id: 'ALT-SHIFT', generation_reason: '기본 모의 입력',
      payload: { alternative_id: 'ALT-SHIFT', plan_id: 'PLAN-002', alternative_type: '시기이동',
        alternative_selection: { plan_id: 'PLAN-002', alternative_id: 'ALT-SHIFT', alternative_type: '시기이동', new_sale_start_week: '2026-09-07',
          new_sale_weeks: 4, new_uplift_pct: null, new_override_uplift_pct: [], selected_by: 'MKT-LINE-OWNER', event_id: null } } }, 'p2');
    const rev = app.events.query({ event_type: 'DEMAND_INPUT_REVISED', plan_id: 'PLAN-002' }).at(-1);
    assert.equal(rev.caused_by, sel.event_id);
    assert.equal(rev.is_synthetic, true);
    assert.equal(rev.occurred_at, '2026-07-13');
    assert.deepEqual(rev.payload.changed_fields, ['sale_start_week']);
    const di = p1.demandInput('PLAN-002');
    assert.deepEqual([di.version, di.origin, di.uplift_pct, di.sale_start_week, di.sale_weeks], [2, 'alternative', 20, '2026-09-07', 4]);
    assert.equal(di.is_synthetic, true);
    assert.deepEqual(p1.skuOverrides('DI-PLAN-002', 2), []);
    const w = p1.campaignDemandWeekly({ plan_id: 'PLAN-002' });
    assert.deepEqual([...new Set(w.map((x) => x.week_start))], ['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28']);
    assert.equal(w.reduce((a, x) => a + x.added_qty_ea, 0), 4828); // 증가율이 같으면 합계도 같다
    assert.deepEqual(p1.demandInputVersions('PLAN-002').map((v) => v.version_status), ['대체됨', '유효']);
    assert.equal(p1.demandStatusByPlan('PLAN-002').demand_status, '정정됨');
  } finally { await done(); }
});

// 패널(브라우저 모듈)을 가짜 요소로 그려 화면 지침을 확인한다: 결론 먼저, 긴 표는 접기, 코드는 한국어 이름.
test('패널: 진행 요약·확인 양식·추가 수량 요약은 펼쳐 두고, 주차별 표·참고 지표·기준 수요는 접는다', async () => {
  const { app, p1, done } = await makeApp({}, { 2: P2_STUB });
  const port = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  try {
    await p1.deliverMockRecord('T-S1-002');
    await p1.deliverMockRecord('T-S1-003', { auto_confirm: false }); // PLAN-014 정정 확인 대기
    const { default: panel } = await import(`${path.join(P1, 'src', 'panel.js')}?t=${Date.now()}`);
    const { ui } = await import('../../app/public/common.js');
    const api = { get: async (p) => (await fetch(base + p)).json(), post: async () => ({}) };
    const el = { innerHTML: '', querySelector: () => ({ textContent: '' }), querySelectorAll: () => [] };
    await panel.renderPlan(el, { plan: { plan_id: 'PLAN-014' }, api, ui });
    const html = el.innerHTML;
    assert.match(html, /수요 입력 <b>확인대기 v1<\/b>/);       // 진행 요약: 정정 확인 중에도 유효 v1
    assert.match(html, /class="p1-confirm"[^>]*data-version="2"/); // 확인 양식은 펼쳐 둔다
    assert.match(html, /<summary>주차별 표 \(3주\)<\/summary>/);
    assert.match(html, /<summary>참고 지표/);
    assert.match(html, /<summary>기준 수요/);
    assert.match(html, /예상 입고 포함/);
    assert.match(html, /확약 입고만/);
    assert.match(html, /색조 벨벳 립/);
    assert.doesNotMatch(html, />on_schedule<|>not_arrived<|>GRP_CEO</);
    assert.equal((html.match(/<td>[^<]*<span class="tag/g) ?? []).length, 0); // 칸마다 자료 구분 표시를 반복하지 않는다
  } finally { await done(); }
});

// 평가자 화면용 설명 카드(describeEvent)
const cardOf = (app, type, planId) => app.module('p1').describeEvent(app.events.query({ event_type: type, ...(planId ? { plan_id: planId } : {}) }).at(-1));

test('describeEvent: 기준 수요·회신·등록(실제 수치)·정정·반려 카드, 모르는 사건은 null', async () => {
  const { app, p1, done } = await makeApp();
  try {
    const bd = cardOf(app, 'BASELINE_DEMAND_SET');
    assert.equal(bd.actor_kind, '규칙·계산');
    assert.equal(bd.inputs.length, 14);
    assert.ok(bd.inputs.some((i) => i.value === '882.5 EA/주' && i.source === '원본' && /sku_weekly_sales_ms\.csv#SKU-3001/.test(i.ref)));
    await p1.deliverMockRecord('T-S1-001');
    const rep = cardOf(app, 'INFO_REPLIED', 'PLAN-002');
    assert.equal(rep.actor_kind, '모의 입력');
    assert.equal(rep.inputs[0].source, '모의회신');
    assert.match(rep.result, /v1을 확인 대기/);
    const reg = cardOf(app, 'DEMAND_INPUT_REGISTERED', 'PLAN-002');
    assert.equal(reg.title, '수요 입력 등록 v1: 증가율 20.0%, 07-20 주부터 4주');
    assert.equal(reg.actor_kind, '모의 입력');
    assert.match(reg.result, /색조 벨벳 립 882\.5 × 20\.0% = 176\.5 → 177 EA\/주 × 4주 = 708 EA/);
    assert.match(reg.result, /합계 4,828 EA/);
    assert.ok(reg.inputs.some((i) => i.label === '기준 수요 · 색조 아이팔레트' && i.source === '계산'));
    await p1.deliverMockRecord('T-S1-002');
    await app.clock.advance({ to: '2026-07-13' }); // 정정 회신의 기준 시점(07-13)이 확인일보다 늦지 않게
    await p1.deliverMockRecord('T-S1-003');
    const rev = cardOf(app, 'DEMAND_INPUT_REVISED', 'PLAN-014');
    assert.match(rev.title, /^수요 입력 정정 v2: 증가율 25\.0%/);
    assert.ok(rev.inputs.some((i) => i.label === '품목별 증가율 · 색조 아이팔레트' && i.value === '5.0%'));
    assert.ok(rev.inputs.some((i) => i.label === '바뀐 항목' && i.value === '증가율, 품목별 증가율'));
    assert.match(rev.result, /이전 v1 대체/);
    await app.clock.advance({ to: '2026-08-05' });
    await p1.deliverMockRecord('T-S1-004'); // 수요일 시작 → 검증 반려
    const rej = cardOf(app, 'DEMAND_INPUT_REJECTED', 'PLAN-011');
    assert.equal(rej.actor_kind, '규칙·계산');
    assert.match(rej.result, /유효 버전이 없어 공급 판정은 판정불가/);
    assert.equal(p1.describeEvent({ event_type: 'SUPPLY_JUDGED', payload: {} }), null);
    assert.equal(p1.describeEvent(null), null);
  } finally { await done(); }
});

test('describeEvent: AI 구조화 카드는 원문·뽑은 값·비운 값과 사유를 보여주고, 담당자 확인은 고친 칸을 적는다', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ model: 'anthropic/claude-opus-5.5', choices: [{ message: { content: JSON.stringify({
    fields: { uplift_pct: 20, sale_start_week: '2026-07-20', sale_weeks: null, sku_overrides: [], rationale_text: null },
    unclear_reasons: ['판매 주수가 회신에 없음'] }) } }] }) });
  const { app, p1, done } = await makeApp({ env: { OPENROUTER_API_KEY: 'test' }, fetchImpl });
  try {
    const t = await p1.receiveReply({ plan_id: 'PLAN-002', reply_text: '판매는 2026-07-20 주부터, 기준 수요 대비 20% 증가', source_type: '사람입력', source_ref: ['ui:p1-entry'] });
    await p1.confirmDemandInput({ demand_input_id: t.demand_input_id, version: t.version, fields: { uplift_pct: 20, sale_start_week: '2026-07-20', sale_weeks: 4 } });
    const st = cardOf(app, 'DEMAND_INPUT_STRUCTURED', 'PLAN-002');
    assert.equal(st.actor_kind, 'AI');
    assert.equal(st.actor_label, 'anthropic/claude-opus-5.5');
    assert.match(st.inputs[0].value, /2026-07-20 주부터/);
    assert.match(st.result, /뽑은 값: 증가율 20\.0%, 시작 주 07-20, 주수 비움/);
    assert.match(st.result, /비운 값: 판매 주수\(사유: 판매 주수가 회신에 없음\)/);
    const rv = cardOf(app, 'AI_OUTPUT_REVIEWED', 'PLAN-002');
    assert.equal(rv.title, '담당자 확인: AI 결과를 고쳐서 확인(판매 주수 고침)');
    assert.equal(rv.actor_kind, '사람');
    assert.equal(cardOf(app, 'AI_CALL_RECORDED', 'PLAN-002').actor_kind, 'AI');
  } finally { await done(); }
});

test('기안 담당자 화면 API: 참고 정보 → 자유 서술 → 확인, 값 직접 입력·정정, 종결 기안은 409', async () => {
  const P4_PLAN = `export function register(ctx) {
    ctx.expose({ getPlanState: (id) => ({ plan_id: id, plan_status: id === 'PLAN-020' ? '확정' : '검토 중' }),
      getDeadlineSchedule: ({ plan_id }) => ({ plan_id, demand_input_due: '2026-07-07' }), listInfoRequests: () => [] });
  }`;
  const { app, done } = await makeApp({}, { 2: P2_STUB, 4: P4_PLAN });
  const port = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}/api/p1`;
  const get = async (p) => (await fetch(base + p)).json();
  const post = async (p, b) => { const r = await fetch(base + p, { method: 'POST', body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
  try {
    let e = await get('/entry/PLAN-002');
    assert.equal(e.actions.mode, '최초 입력');
    assert.equal(e.actions.can_submit_text, true);
    assert.equal(e.deadline.demand_input_due, '2026-07-07');
    assert.match(e.example_text, /기준 수요 대비 20% 증가/); // 시연용 예시 문장(모의 수요 회신 원문)
    assert.equal((await get('/entry/PLAN-005')).example_text, null); // 모의 회신이 없는 기안
    const ref = e.reference.skus.find((s) => s.sku_id === 'SKU-3001');
    // 문제 2 v2.0: 확약 입고만(not_arrived)이 기준, 예상 입고 포함(on_schedule)은 참고. 품절 예상 주도 확약 기준
    assert.deepEqual([ref.sku_name, ref.baseline_weekly_qty, ref.headroom_expected.min_residual_headroom_qty, ref.headroom_committed.headroom_state],
      ['색조 벨벳 립', 882.5, 300, 'zero']);
    assert.deepEqual([ref.first_stockout_week, ref.first_stockout_week_committed, ref.first_stockout_week_expected], ['2026-07-13', '2026-07-13', null]);
    assert.equal(ref.unpreventable_headroom.not_arrived.headroom_state, 'zero');
    assert.equal(ref.covered_from_week, undefined); // 없어진 정기 보충 가정을 더 쓰지 않는다
    assert.deepEqual(ref.baseline_plan, { status: 'SCM 확인·Corevia 미확약', scm_confirmed: '확인', corevia_committed: '미확약', plan_qty_total: 5000,
      plan_rows: [{ qty: 5000, eta_date: '2026-09-02', supply_status: '예상' }] });
    assert.equal(e.reference.skus.find((x) => x.sku_id === 'SKU-3002').baseline_plan, null);
    assert.match(e.reference.notice, /확약한 입고만으로 본 값이 기준/);
    assert.deepEqual(e.input_rules.override_skus, ['SKU-3001', 'SKU-3002', 'SKU-3003']);
    // 자유 서술 → (AI 미연결) 확인 대기 → 확인
    const t = await post('/entry/PLAN-002/text', { reply_text: '7/20 주부터 4주, 20% 증가' });
    assert.equal(t.body.entry.pending.version, 1);
    assert.equal(t.body.entry.pending.ai_status, 'AI 미연결');
    assert.equal(t.body.entry.actions.can_submit_text, false);
    const c = await post('/entry/PLAN-002/confirm', { version: 1, fields: { uplift_pct: '20', sale_start_week: '2026-07-20', sale_weeks: '4' } });
    assert.equal(c.body.result.event_type, 'DEMAND_INPUT_REGISTERED');
    assert.equal(c.body.entry.current.total_added_qty_ea, 4828);
    assert.equal(c.body.entry.current.added_qty_by_sku.find((x) => x.sku_id === 'SKU-3001').added_qty_ea_per_week, 177);
    assert.equal(c.body.entry.actions.mode, '정정');
    // 화면 입력은 '사람'으로 설명된다
    const card = app.module('p1').describeEvent(app.events.query({ event_type: 'DEMAND_INPUT_REGISTERED', plan_id: 'PLAN-002' })[0]);
    assert.deepEqual([card.actor_kind, card.actor_label], ['사람', '마케팅 기안 담당자']);
    // 값 직접 입력으로 정정 → REVISED, AI 거치지 않음
    const d = await post('/entry/PLAN-002/direct', { fields: { uplift_pct: 10, sale_start_week: '2026-07-27', sale_weeks: 3, overrides: [{ sku_id: 'SKU-3003', override_uplift_pct: 0 }] } });
    assert.equal(d.body.result.event_type, 'DEMAND_INPUT_REVISED');
    assert.deepEqual(d.body.entry.current.overrides, [{ sku_id: 'SKU-3003', override_uplift_pct: 0 }]);
    assert.equal(d.body.entry.history.at(-1).origin, 'reply');
    // 직접 입력 검증 실패는 반려로 돌려준다
    const bad = await post('/entry/PLAN-002/direct', { fields: { uplift_pct: 10, sale_start_week: '2026-07-29', sale_weeks: 3 } });
    assert.equal(bad.body.result.version_status, '반려');
    assert.match(bad.body.result.reject_reason, /월요일/);
    assert.equal(bad.body.entry.current.version, 2);
    // 종결된 기안은 바꿀 수 없다
    const closed = await post('/entry/PLAN-020/direct', { fields: { uplift_pct: 10, sale_start_week: '2026-09-14', sale_weeks: 3 } });
    assert.equal(closed.status, 409);
    assert.equal((await get('/entry/PLAN-020')).actions.can_enter_direct, false);
    const ev = app.events.query({ event_type: 'DEMAND_INPUT_REVISED', plan_id: 'PLAN-002' })[0];
    assert.match((await get(`/describe/${ev.event_id}`)).card.title, /^수요 입력 정정 v2/);
  } finally { await done(); }
});

test('자동 처리(모의 자료) 회신은 AI를 부르지 않고 확인된 값으로 등록한다. 화면 응답의 AI 정리 문장은 업무 용어로', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(1);
    return { ok: true, json: async () => ({ model: 'anthropic/claude-opus-5.5', choices: [{ message: { content: JSON.stringify({
      fields: { uplift_pct: 20, sale_start_week: '2026-07-20', sale_weeks: null, sku_overrides: [{ sku_id: 'SKU-3003', override_uplift_pct: 0 }], rationale_text: 'SKU-3003은 제외' },
      unclear_reasons: ['sale_weeks가 없음, SKU별 값은 SKU-3003만'] }) } }] }) };
  };
  const { app, p1, done } = await makeApp({ env: { OPENROUTER_API_KEY: 'test' }, fetchImpl });
  try {
    const r = await p1.deliverMockRecord('T-S1-001');
    assert.equal(calls.length, 0);
    assert.equal(r.confirm.version_status, '유효');
    assert.equal(app.events.query({ event_type: ['AI_CALL_RECORDED', 'DEMAND_INPUT_STRUCTURED', 'AI_OUTPUT_REVIEWED'] }).length, 0);
    assert.match(app.events.query({ event_type: 'INFO_REPLIED' })[0].generation_reason, /AI 호출 없음\(자동 처리\)/);
    const v = app.module('p1').entryView('PLAN-002').history[0];
    assert.equal(v.version_status, '유효');
    assert.match(app.module('p1').describeEvent(app.events.query({ event_type: 'INFO_REPLIED' })[0]).next, /AI 호출 없음\(자동 처리\)/);
    // 화면에서 넣은 자유 서술은 AI를 부르고, 화면 응답의 문장에는 코드가 없다
    await p1.receiveReply({ plan_id: 'PLAN-003', reply_text: '7/20 주부터, 립·쿠션 20%, 아이팔레트 제외', source_type: '사람입력', source_ref: ['ui:p1-entry'] });
    assert.equal(calls.length, 1);
    const pend = app.module('p1').entryView('PLAN-003').pending;
    assert.deepEqual(pend.missing_fields, ['판매 주수']);
    assert.deepEqual(pend.missing_field_keys, ['sale_weeks']);
    assert.deepEqual(pend.unclear_reasons, ['판매 주수가 없음, 품목별 값은 색조 아이팔레트만']);
    assert.equal(pend.extracted_fields.rationale_text, '색조 아이팔레트은 제외');
    assert.equal(pend.summary, '증가율 20.0%, 판매 시작 주 07-20 주, 판매 주수 비어 있음, 색조 아이팔레트 0.0%');
    assert.doesNotMatch(JSON.stringify([pend.missing_fields, pend.unclear_reasons, pend.summary, pend.extracted_fields.rationale_text]), /uplift_pct|sale_|SKU-\d|SKU별/);
  } finally { await done(); }
});

test('describeEvent 문장: 제목·규칙·결과·다음 처리와 입력 이름에 영문 식별자가 없다(자료 출처 경로는 예외)', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ model: 'anthropic/claude-opus-5.5', choices: [{ message: { content: JSON.stringify({
    fields: { uplift_pct: 20, sale_start_week: '2026-07-20', sale_weeks: null, sku_overrides: [], rationale_text: null }, unclear_reasons: ['판매 주수가 회신에 없음'] }) } }] }) });
  const P4_REQ = `export function register(ctx) {
    ctx.expose({ requestInfo: async (r) => { const e = await ctx.events.emit({ event_type: 'INFO_REQUESTED', source_type: '계산', plan_id: r.plan_id,
      payload: { request_id: 'REQ-0001', request_topic: 'demand_input', request_kind: 'initial', request_due_date: '2026-07-07', plan_id: r.plan_id } }); return e; } });
  }`;
  const { app, p1, done } = await makeApp({ env: { OPENROUTER_API_KEY: 'test' }, fetchImpl }, { 4: P4_REQ });
  try {
    await app.module('p4').requestInfo({ plan_id: 'PLAN-002' });
    const t = await p1.receiveReply({ plan_id: 'PLAN-002', reply_text: '7/20 주부터, 20% 증가', source_type: '사람입력', source_ref: ['ui:p1-entry'] });
    await p1.confirmDemandInput({ demand_input_id: t.demand_input_id, version: t.version, fields: { uplift_pct: 20, sale_start_week: '2026-07-20', sale_weeks: 4 } });
    await p1.deliverMockRecord('T-S1-002');
    await app.clock.advance({ to: '2026-07-13' });
    await p1.deliverMockRecord('T-S1-003');
    await app.clock.advance({ to: '2026-08-05' });
    await p1.deliverMockRecord('T-S1-004');
    await p1.deliverMockRecord('T-S1-005');
    const cards = app.events.query({ limit: 10000 }).map((e) => p1.describeEvent(e)).filter(Boolean);
    const kinds = new Set(cards.map((c) => c.title.split(/[:(]/)[0]));
    for (const k of ['기준 수요 설정', '수요 입력 요청', '수요 회신 도착', 'AI 호출', 'AI 구조화', '담당자 확인', '수요 입력 등록 v1', '수요 입력 정정 v2', '수요 입력 반려 v1']) assert.ok(kinds.has(k), k);
    // 허용: 기안·요청 번호, AI, EA(단위), 버전 v숫자
    const clean = (x) => String(x ?? '').replace(/PLAN-\d{3}|REQ-[\w-]+|\bAI\b|\bEA\b|\bv\d+\b/g, '');
    for (const c of cards) {
      for (const f of ['title', 'rule', 'result', 'next']) assert.doesNotMatch(clean(c[f]), /[A-Za-z]{2,}|_/, `${c.title} · ${f}: ${c[f]}`);
      for (const i of c.inputs) assert.doesNotMatch(clean(i.label), /[A-Za-z]{2,}|_/, `${c.title} · 입력 ${i.label}`);
    }
  } finally { await done(); }
});
