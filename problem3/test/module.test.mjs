// 문제 3 모듈 통합 검증. 다른 문제 모듈의 진행 상태와 무관하게 돌도록 문제 3만 붙인 임시 루트를 쓴다.
// 문제 4 역할(기안 접수, 마감, 모의 순서표, 승인 회신)은 가짜 모듈 또는 직접 낸 사건으로 대신한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApp } from '../../app/main.mjs';

const P3_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const quiet = { log() {}, error() {} };

async function makeApp({ fakeP4 = null } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'w01-p3-'));
  symlinkSync(P3_DIR, path.join(root, 'problem3'), 'dir');
  if (fakeP4) {
    mkdirSync(path.join(root, 'problem4', 'src'), { recursive: true });
    writeFileSync(path.join(root, 'problem4', 'src', 'index.mjs'), fakeP4);
  }
  const app = await createApp({ rootDir: root, dbPath: ':memory:', env: {}, log: quiet });
  return { app, p3: app.module('p3'), cleanup: async () => { await app.close(); rmSync(root, { recursive: true, force: true }); } };
}
const asP4 = (app, e) => app.events.emit({ source_type: '계산', ...e }, 'p4');
const DRAFT_A = { po_draft_id: 'PD-A', draft_version: 1, sku_id: 'SKU-2001', supplier_id: 'Corevia', order_qty: 16000, moq: 16000, planned_order_date: '2026-07-22', expected_arrival_week: '2026-09-14', unit_cost_krw: 12600, amount_krw: 201_600_000, linked_plan_ids: ['PLAN-001'], po_draft_status: '초안', scenario_id: 'BASE' };
const reply = (app, req, cid, decision, approver) => asP4(app, { event_type: 'APPROVAL_REPLIED', source_type: '모의회신', is_synthetic: true, payload: { approval_request_id: req.approval_request_id, commitment_id: cid, decision, conditions: [], approver, replied_at: '2026-07-14' } });

test('초기화: 기본 구간 CW-001, 기안 25건 경로(GRP_CEO 12건 99,550,557원 / MS_CEO 13건), 기발주 14건은 판정 대상 아님', async () => {
  const { app, p3, cleanup } = await makeApp();
  try {
    const w = p3.cashWindow();
    assert.equal(w.window_version, 'CW-001');
    assert.equal(w.window_basis, 'policy_recalc');
    assert.deepEqual([w.shortfall_window_start, w.shortfall_window_end, w.min_balance_krw, w.next_outside_date], ['2026-07-21', '2026-08-21', 1_785_991_965, '2026-08-24']);
    assert.equal(w.is_simulation, false);
    const plans = p3.listCommitments({ commitment_type: '기안' });
    assert.equal(plans.length, 25);
    const grp = plans.filter((c) => c.approver === 'GRP_CEO');
    assert.deepEqual(grp.map((c) => c.plan_id), ['PLAN-001', 'PLAN-002', 'PLAN-003', 'PLAN-008', 'PLAN-009', 'PLAN-010', 'PLAN-015', 'PLAN-016', 'PLAN-017', 'PLAN-021', 'PLAN-022', 'PLAN-023']);
    assert.equal(grp.reduce((s, c) => s + c.amount_krw, 0), 99_550_557);
    assert.equal(plans.filter((c) => c.approver === 'MS_CEO').length, 13);
    assert.ok(plans.every((c) => c.group_report_required === (c.approver === 'MS_CEO')));
    const p002 = p3.commitmentBySource('PLAN-002');
    assert.deepEqual([p002.route_rule_id, p002.approval_anchor_date, p002.anchor_basis, p002.approval_status, p002.amount_scale], ['R-01', '2026-07-17', 'contract_deadline', '미상신', 'sample']);
    assert.deepEqual([p3.commitmentBySource('PLAN-021').approval_anchor_date, p3.commitmentBySource('PLAN-021').anchor_basis], ['2026-07-21', 'settlement_date']);
    // R-02 중 1천만원 이하 건은 묶음 합성 속성에 기대므로 시뮬레이션, 1천만원 초과 건은 아님
    assert.equal(p3.commitmentBySource('PLAN-024').is_simulation, true);
    assert.equal(p3.commitmentBySource('PLAN-005').is_simulation, false);
    const old = p3.listCommitments({ commitment_type: '기발주' });
    assert.equal(old.length, 14);
    assert.ok(old.every((c) => c.approval_status === '판정대상아님' && c.cash_outflow_date === '2026-07-21' && c.route_rule_id === 'R-00'));
    assert.equal(app.events.query({ event_type: 'ROUTE_JUDGED' }).length, 25);
    assert.equal(p3.approverRole('GRP_CEO').std_approval_bd, 2);
  } finally { await cleanup(); }
});

test('같은 입력이면 같은 판정이 나온다(두 번 초기화)', async () => {
  const a = await makeApp();
  const b = await makeApp();
  try {
    const pick = (p3) => p3.listCommitments().map((c) => [c.commitment_id, c.approver, c.route_rule_id, c.approval_anchor_date, c.route_judgment_id]);
    assert.deepEqual(pick(a.p3), pick(b.p3));
  } finally { await a.cleanup(); await b.cleanup(); }
});

test('재무 확인(FR-001) → 회수일 지연(FR-002, MAR-0004·0005 각 14일): 구간 09-04까지, PLAN-004·011·018·024·025가 GRP_CEO로 바뀌고 상신된 PLAN-004는 재상신 대상', async () => {
  const { app, p3, cleanup } = await makeApp();
  try {
    const w1 = await p3.applyFinanceReply('FR-001');
    assert.equal(w1.window_basis, 'finance_confirmed');
    assert.equal(w1.shortfall_window_end, '2026-08-21');
    assert.equal(w1.is_simulation, true);
    assert.ok(p3.listCommitments({ commitment_type: '기안' }).every((c) => c.finance_confirmation_status === '확인됨'));
    assert.equal(app.events.query({ event_type: 'FINANCE_CONFIRMED' }).length, 1);
    // 같은 회신을 두 번 반영하지 않는다
    await p3.applyFinanceReply('FR-001');
    assert.equal(app.events.query({ event_type: 'FINANCE_CONFIRMED' }).length, 1);

    const req = await p3.submitApproval({ commitment_ids: ['CMT-PLAN-004'] });
    assert.equal(req.approver, 'MS_CEO');
    assert.equal(p3.commitment('CMT-PLAN-004').approval_status, '결재 대기');

    const before = Object.fromEntries(p3.listCommitments({ commitment_type: '기안' }).map((c) => [c.plan_id, c.approver]));
    const w2 = await p3.applyFinanceReply('FR-002');
    assert.deepEqual([w2.scenario_id, w2.shortfall_window_end, w2.shortfall_bd_count, w2.next_outside_date], ['S-AR-DELAY', '2026-09-04', 34, '2026-09-07']);
    const after = Object.fromEntries(p3.listCommitments({ commitment_type: '기안' }).map((c) => [c.plan_id, c.approver]));
    const changed = Object.keys(after).filter((k) => after[k] !== before[k]);
    assert.deepEqual(changed, ['PLAN-004', 'PLAN-011', 'PLAN-018', 'PLAN-024', 'PLAN-025']);
    const c4 = p3.commitment('CMT-PLAN-004');
    assert.deepEqual([c4.approver, c4.approval_status], ['GRP_CEO', '미상신']);
    const hist = p3.routeJudgmentHistory('CMT-PLAN-004');
    assert.equal(hist.at(-1).route_changed, true);
    assert.equal(hist.at(-1).previous_route_judgment_id, hist.at(-2).route_judgment_id);
    // 재상신하면 이전 MS_CEO 상신은 대체되고, 대체된 상신에 온 회신은 반영하지 않는다
    const req2 = await p3.submitApproval({ commitment_ids: ['CMT-PLAN-004'] });
    assert.equal(p3.approvalRequest(req.approval_request_id).superseded, true);
    await asP4(app, { event_type: 'APPROVAL_REPLIED', source_type: '모의회신', is_synthetic: true, plan_id: 'PLAN-004', payload: { approval_request_id: req.approval_request_id, commitment_id: 'CMT-PLAN-004', decision: '승인', conditions: [], approver: 'MS_CEO', replied_at: '2026-07-13' } });
    assert.equal(p3.commitment('CMT-PLAN-004').approval_status, '결재 대기');
    await asP4(app, { event_type: 'APPROVAL_REPLIED', source_type: '모의회신', is_synthetic: true, plan_id: 'PLAN-004', payload: { approval_request_id: req2.approval_request_id, commitment_id: 'CMT-PLAN-004', decision: '승인', conditions: [], approver: 'GRP_CEO', replied_at: '2026-07-14' } });
    assert.equal(p3.commitment('CMT-PLAN-004').approval_status, '승인');
  } finally { await cleanup(); }
});

test('PLAN-003: 거절 → 집행일이동(08-31) → MS_CEO 재상신 → 승인. PLAN-001 발주안 승인으로 구간이 08-28까지 늘어도 08-31은 구간 밖', async () => {
  const { app, p3, cleanup } = await makeApp();
  try {
    await app.events.emit({ event_type: 'PO_DRAFT_CREATED', source_type: '계산', payload: { ...DRAFT_A } }, 'p2');
    const pd = p3.commitmentBySource('PD-A');
    await reply(app, await p3.submitApproval({ commitment_ids: [pd.commitment_id] }), pd.commitment_id, '승인', 'GRP_CEO');
    assert.equal(p3.cashWindow().shortfall_window_end, '2026-08-28');
    const req = await p3.submitApproval({ commitment_ids: ['CMT-PLAN-003'] });
    assert.equal(req.approver, 'GRP_CEO');
    await reply(app, req, 'CMT-PLAN-003', '거절', 'GRP_CEO');
    assert.equal(p3.commitment('CMT-PLAN-003').approval_status, '거절');
    assert.equal(p3.cashWindow().next_outside_date, '2026-08-31'); // 08-24는 늘어난 구간 안이라 이동 후보가 될 수 없다
    await app.events.emit({ event_type: 'ALTERNATIVE_SELECTED', source_type: '사람입력', is_synthetic: true, plan_id: 'PLAN-003', payload: { alternative_id: 'ALT-T1', plan_id: 'PLAN-003', alternative_type: '집행일이동', plan_change: { plan_id: 'PLAN-003', plan_version: 2, settlement_date: '2026-08-31', requested_budget_krw: null, change_reason: '집행일이동', effective_at: '2026-07-14' } } }, 'p2');
    const c = p3.commitment('CMT-PLAN-003');
    assert.deepEqual([c.cash_outflow_date, c.approver, c.route_rule_id, c.approval_status, c.approval_anchor_date, c.amount_krw], ['2026-08-31', 'MS_CEO', 'R-02', '미상신', '2026-07-17', 14_926_612]);
    assert.equal(p3.routeJudgmentHistory('CMT-PLAN-003').at(-1).in_window, false);
    const req2 = await p3.submitApproval({ commitment_ids: ['CMT-PLAN-003'] });
    assert.equal(req2.approver, 'MS_CEO');
    assert.equal(p3.approvalRequest(req.approval_request_id).superseded, true);
    await reply(app, req2, 'CMT-PLAN-003', '승인', 'MS_CEO');
    assert.deepEqual([p3.commitment('CMT-PLAN-003').approval_status, p3.commitment('CMT-PLAN-003').group_report_required], ['승인', true]);
    // PLAN-004는 같은 발주안 승인으로 구간이 늘어 GRP_CEO로 올라간다(경로 상향 효과)
    assert.equal(p3.commitmentBySource('PLAN-004').approver, 'GRP_CEO');
  } finally { await cleanup(); }
});

test('발주안 여러 건: 기안 하나에 SKU별 2건, 다른 기안 1건이 동시에 와도 지급일·경로·상신·회신이 건별로 동작한다', async () => {
  const { app, p3, cleanup } = await makeApp({ fakeP4: FAKE_P4 });
  try {
    const drafts = [
      { ...DRAFT_A },
      { ...DRAFT_A, po_draft_id: 'PD-B', sku_id: 'SKU-2002', planned_order_date: '2026-08-05', amount_krw: 50_000_000 },
      { ...DRAFT_A, po_draft_id: 'PD-C', sku_id: 'SKU-2003', linked_plan_ids: ['PLAN-008'], amount_krw: 30_000_000 },
    ];
    for (const d of drafts) await app.events.emit({ event_type: 'PO_DRAFT_CREATED', source_type: '계산', payload: d }, 'p2');
    const [a, bb, cc] = ['PD-A', 'PD-B', 'PD-C'].map((id) => p3.commitmentBySource(id));
    assert.deepEqual([a.payment_due_date, a.approver, a.route_rule_id], ['2026-08-21', 'GRP_CEO', 'R-01']); // 지급일이 구간 안 → 그룹 CEO
    assert.deepEqual([bb.payment_due_date, bb.approver, bb.route_rule_id], ['2026-09-21', 'SCM', 'R-04']); // 평시 재고 발주 → SCM
    assert.deepEqual([cc.payment_due_date, cc.approver], ['2026-08-21', 'GRP_CEO']);
    assert.equal(app.events.query({ event_type: 'PAYMENT_DATE_SET' }).length, 3);
    // 같은 발주안 사건이 다시 와도 판정 버전을 늘리지 않는다
    await app.events.emit({ event_type: 'PO_DRAFT_CREATED', source_type: '계산', payload: drafts[0] }, 'p2');
    assert.equal(p3.routeJudgmentHistory(a.commitment_id).length, 1);
    // 순서표 행의 target 발주안만 상신한다. 같은 기안의 다른 발주안과 다른 기안 발주안은 건드리지 않는다((D)-2 다)
    const ra = await p3.deliverMock('M-SUB-PD');
    assert.deepEqual([ra.approval_request.approver, ra.approval_request.commitment_ids], ['GRP_CEO', [a.commitment_id]]);
    assert.equal(p3.commitment(bb.commitment_id).approval_status, '미상신');
    assert.equal(p3.commitment(cc.commitment_id).approval_status, '미상신');
    const rb = await p3.deliverMock('M-SUB-PDB');
    assert.deepEqual([rb.approval_request.approver, rb.approval_request.commitment_ids], ['SCM', [bb.commitment_id]]);
    assert.match((await p3.deliverMock('M-SUB-PDX')).skipped, /target의 발주안이 없음/);
    await reply(app, ra.approval_request, a.commitment_id, '승인', 'GRP_CEO');
    await reply(app, rb.approval_request, bb.commitment_id, '거절', 'SCM');
    assert.deepEqual([p3.commitment(a.commitment_id).approval_status, p3.commitment(bb.commitment_id).approval_status], ['승인', '거절']);
    const w = p3.cashWindow();
    assert.ok(w.included_sources.includes('po_draft:PD-A'));
    assert.ok(!w.included_sources.includes('po_draft:PD-B') && !w.included_sources.includes('po_draft:PD-C'));
  } finally { await cleanup(); }
});

test('발주안: 07-22 발주 → 지급 08-21(S3-01) → GRP_CEO. 승인되면 구간이 08-28까지 늘어 PLAN-004·024가 GRP_CEO로 바뀐다', async () => {
  const { app, p3, cleanup } = await makeApp();
  try {
    const draft = { po_draft_id: 'PD-0001', draft_version: 1, sku_id: 'SKU-2001', supplier_id: 'Corevia', order_qty: 16000, moq: 16000, planned_order_date: '2026-07-22', expected_arrival_week: '2026-09-14', unit_cost_krw: 12600, amount_krw: 201_600_000, linked_plan_ids: ['PLAN-001'], po_draft_status: '초안', scenario_id: 'BASE' };
    await app.events.emit({ event_type: 'PO_DRAFT_CREATED', source_type: '계산', payload: draft }, 'p2');
    const c = p3.commitmentBySource('PD-0001');
    assert.deepEqual([c.commitment_type, c.payment_due_date, c.payment_rule_id, c.approval_anchor_date, c.anchor_basis, c.approver, c.is_simulation], ['발주안', '2026-08-21', 'S3-01-001', '2026-07-22', 'planned_order_date', 'GRP_CEO', true]);
    assert.equal(app.events.query({ event_type: 'PAYMENT_DATE_SET' })[0].payload.payment_due_date, '2026-08-21');
    const req = await p3.submitApproval({ commitment_ids: [c.commitment_id] });
    await asP4(app, { event_type: 'APPROVAL_REPLIED', source_type: '모의회신', is_synthetic: true, payload: { approval_request_id: req.approval_request_id, commitment_id: c.commitment_id, decision: '승인', conditions: [], approver: 'GRP_CEO', replied_at: '2026-07-16' } });
    const w = p3.cashWindow();
    assert.equal(w.shortfall_window_end, '2026-08-28');
    assert.ok(w.included_sources.includes('po_draft:PD-0001'));
    assert.equal(p3.commitmentBySource('PLAN-004').approver, 'GRP_CEO');
    assert.equal(p3.commitmentBySource('PLAN-024').approver, 'GRP_CEO');
  } finally { await cleanup(); }
});

const FAKE_P4 = `
import { addBusinessDays } from '${pathToFileURL(path.join(path.resolve(P3_DIR, '..'), 'app', 'core', 'calendar.mjs')).href}';
export function register(ctx) {
  const rows = [
    { mock_id: 'M-FC', sim_date: '2026-07-07', seq: 1, owner: 'p3', event_type: 'FINANCE_CONFIRMED', plan_id: 'NONE', target: '구간', scenario_id: 'BASE' },
    { mock_id: 'M-SUB-002', sim_date: '2026-07-09', seq: 1, owner: 'p3', event_type: 'APPROVAL_SUBMITTED', plan_id: 'PLAN-002', target: '기안', scenario_id: 'BASE' },
    { mock_id: 'M-AR', sim_date: '2026-07-10', seq: 1, owner: 'p3', event_type: 'AR_DATE_REVISED', plan_id: 'NONE', target: 'MAR-0004', scenario_id: 'S-AR-DELAY' },
    { mock_id: 'M-SUB-PD', sim_date: '2026-07-14', seq: 1, owner: 'p3', event_type: 'APPROVAL_SUBMITTED', plan_id: 'PLAN-001', target: 'PD-A', scenario_id: 'BASE' },
    { mock_id: 'M-SUB-PDB', sim_date: '2026-07-14', seq: 2, owner: 'p3', event_type: 'APPROVAL_SUBMITTED', plan_id: 'PLAN-001', target: 'PD-B', scenario_id: 'BASE' },
    { mock_id: 'M-SUB-PDX', sim_date: '2026-07-14', seq: 3, owner: 'p3', event_type: 'APPROVAL_SUBMITTED', plan_id: 'PLAN-001', target: 'PD-NONE', scenario_id: 'BASE' },
  ];
  ctx.expose({
    getMockSchedule: ({ owner } = {}) => rows.filter((r) => !owner || r.owner === owner),
    getDeadlineSchedule: ({ commitment_id }) => {
      const c = ctx.module('p3')?.commitment(commitment_id);
      if (!c?.approver) return null;
      const bd = ctx.module('p3').approverRole(c.approver).std_approval_bd;
      const final = addBusinessDays(c.approval_anchor_date, -1);
      const sub = addBusinessDays(final, -(2 * bd + 1));
      return { commitment_id, plan_id: c.plan_id, submission_due: sub, judgment_due: addBusinessDays(sub, -1), final_reply_due: final };
    },
    getPlanState: () => null,
  });
  ctx.onInit(async () => { for (const p of ctx.plans()) await ctx.events.emit({ event_type: 'PLAN_RECEIVED', source_type: '원본도출', plan_id: p.plan_id }); });
}`;

test('문제 4 연결: PLAN_RECEIVED로 등록, deliverMock으로 재무 확인·상신 묶음·회수일 지연, 무회신 표시', async () => {
  const { app, p3, cleanup } = await makeApp({ fakeP4: FAKE_P4 });
  try {
    assert.equal(p3.listCommitments({ commitment_type: '기안' }).length, 25);
    assert.ok(app.events.query({ event_type: 'ROUTE_JUDGED' }).every((e) => e.caused_by));
    await p3.deliverMock('M-FC');
    assert.equal(p3.cashWindow().window_basis, 'finance_confirmed');
    // 같은 승인권자(GRP_CEO)·같은 상신 마감(07-09): PLAN-001·002·003이 한 상신으로 묶인다
    const { approval_request: req } = await p3.deliverMock('M-SUB-002');
    assert.deepEqual(req.commitment_ids, ['CMT-PLAN-001', 'CMT-PLAN-002', 'CMT-PLAN-003']);
    assert.equal(req.submission_due, '2026-07-09');
    const again = await p3.deliverMock('M-SUB-002');
    assert.match(again.skipped, /상신할 상태 아님/);
    const pkg = p3.submissionPackage(req.approval_request_id);
    assert.equal(pkg.rows.length, 3);
    assert.equal(pkg.rows[0].contribution_margin_status, '미산정');
    assert.equal(pkg.rows[0].deadline_schedule.final_reply_due, '2026-07-16');
    await p3.deliverMock('M-AR');
    assert.equal(p3.cashWindow().shortfall_window_end, '2026-09-04');
    assert.equal(p3.commitmentBySource('PLAN-004').approver, 'GRP_CEO');
  } finally { await cleanup(); }
});

test('재무 회신이 없으면 판정·재무 확인 마감 다음 영업일에 무회신으로 표시한다(상신은 계속)', async () => {
  const { app, p3, cleanup } = await makeApp({ fakeP4: FAKE_P4 });
  try {
    await app.clock.advance({ to: '2026-07-09' });
    assert.equal(p3.commitmentBySource('PLAN-002').finance_confirmation_status, '무회신');
    assert.equal(p3.commitmentBySource('PLAN-006').finance_confirmation_status, '재무확인대기');
  } finally { await cleanup(); }
});

test('HTTP: PLAN-002 화면 자료, 구간·민감도, 상신, 양식 초안(AI 미연결), 패널 파일', async () => {
  const { app, cleanup } = await makeApp();
  const port = await app.listen(0, '127.0.0.1');
  try {
    const base = `http://127.0.0.1:${port}`;
    const get = async (p) => (await fetch(base + p)).json();
    const post = async (p, body) => (await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
    const d = await get('/api/p3/plan/PLAN-002');
    assert.equal(d.commitment.approver, 'GRP_CEO');
    assert.equal(d.detail.bundle_total_krw, 180_803_272);
    const w = await get('/api/p3/window');
    assert.deepEqual(w.sensitivity.map((s) => s.min_balance_krw), [1_785_991_965, 1_921_839_555, 1_647_835_595]);
    const sub = await post('/api/p3/submit', { commitment_id: 'CMT-PLAN-002' });
    assert.equal(sub.approval_request.approver, 'GRP_CEO');
    const dr = await post('/api/p3/draft', { commitment_id: 'CMT-PLAN-002' });
    assert.equal(dr.draft.mode, '양식');
    assert.match(dr.draft.text, /실질 공헌이익: 미산정/);
    const { plans } = await get('/api/plans');
    // (E) 화면 지침: 승인권자는 코드(GRP_CEO) 대신 한국어 이름으로 보인다
    assert.equal(plans.find((p) => p.plan_id === 'PLAN-002').summaries.find((s) => s.label === '승인권자').value, '그룹 CEO');
    assert.equal(d.labels.approver.GRP_CEO, '그룹 CEO');
    assert.equal(d.labels.condition_type.reorder_required, '보충 발주 필요');
    const panel = await fetch(`${base}/panels/p3.js`);
    assert.equal(panel.status, 200);
  } finally { await cleanup(); }
});

test('AI 연결 시 초안은 확인 대기로 남고, 확인 뒤에만 확인 상태가 된다', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'w01-p3ai-'));
  symlinkSync(P3_DIR, path.join(root, 'problem3'), 'dir');
  const fetchImpl = async () => ({ ok: true, json: async () => ({ model: 'anthropic/claude-fable-5.2', choices: [{ message: { content: '상신 초안 문장' } }] }) });
  const app = await createApp({ rootDir: root, dbPath: ':memory:', env: { OPENROUTER_API_KEY: 'x' }, fetchImpl, log: quiet });
  const port = await app.listen(0, '127.0.0.1');
  try {
    const base = `http://127.0.0.1:${port}`;
    const post = async (p, body) => (await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
    const { draft } = await post('/api/p3/draft', { commitment_id: 'CMT-PLAN-002' });
    assert.deepEqual([draft.mode, draft.review_status, draft.text], ['AI', '확인 대기', '상신 초안 문장']);
    assert.equal(app.events.query({ event_type: 'AI_CALL_RECORDED' }).length, 1);
    assert.equal(app.events.query({ event_type: 'AI_CALL_RECORDED' })[0].payload.ai_task_name, 'submission_draft');
    const r = await post(`/api/p3/draft/${draft.draft_id}/review`, { review_result: '확인' });
    assert.equal(r.draft.review_status, '확인');
    assert.equal(app.events.query({ event_type: 'AI_OUTPUT_REVIEWED' }).length, 1);
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});

const DRAFT = { po_draft_id: 'PD-0009', draft_version: 1, sku_id: 'SKU-2001', supplier_id: 'Corevia', order_qty: 16000, moq: 16000, planned_order_date: '2026-07-22', expected_arrival_week: '2026-09-14', unit_cost_krw: 12600, amount_krw: 201_600_000, linked_plan_ids: ['PLAN-001'], po_draft_status: '초안', scenario_id: 'BASE' };
test('C(3)·C(7): 발주안 승인으로 구간이 늘면 PLAN-004는 GRP_CEO로 올라가 재상신, 발주안 취소로 구간이 줄면 그룹 CEO 승인은 유지하고 재상신하지 않는다', async () => {
  const { app, p3, cleanup } = await makeApp();
  try {
    const r4 = await p3.submitApproval({ commitment_ids: ['CMT-PLAN-004'] });
    assert.equal(r4.approver, 'MS_CEO');
    await app.events.emit({ event_type: 'PO_DRAFT_CREATED', source_type: '계산', payload: DRAFT }, 'p2');
    const pd = p3.commitmentBySource('PD-0009');
    await reply(app, await p3.submitApproval({ commitment_ids: [pd.commitment_id] }), pd.commitment_id, '승인', 'GRP_CEO');
    assert.equal(p3.cashWindow().shortfall_window_end, '2026-08-28'); // 숨기지 않고 재판정에 반영
    assert.deepEqual([p3.commitmentBySource('PLAN-004').approver, p3.commitmentBySource('PLAN-004').approval_status], ['GRP_CEO', '미상신']); // 상향 → 재상신
    const r4b = await p3.submitApproval({ commitment_ids: ['CMT-PLAN-004'] });
    await reply(app, r4b, 'CMT-PLAN-004', '승인', 'GRP_CEO');
    assert.equal(p3.commitmentBySource('PLAN-024').approver, 'GRP_CEO');
    await app.events.emit({ event_type: 'PO_DRAFT_CANCELLED', source_type: '계산', payload: { po_draft_id: 'PD-0009', draft_version: 1, cancel_reason: '시험' } }, 'p2');
    assert.equal(p3.cashWindow().shortfall_window_end, '2026-08-21');
    const c4 = p3.commitmentBySource('PLAN-004');
    assert.deepEqual([c4.approver, c4.approval_status, c4.approval_request_id], ['GRP_CEO', '승인', r4b.approval_request_id]); // 하향 → 유지
    assert.equal(p3.routeJudgmentHistory('CMT-PLAN-004').at(-1).approver, 'MS_CEO'); // 판정은 평시 경로로 기록
    assert.deepEqual([p3.commitmentBySource('PLAN-024').approver, p3.commitmentBySource('PLAN-024').approval_status], ['MS_CEO', '미상신']); // 미상신 건은 새 경로를 따른다
  } finally { await cleanup(); }
});

test('C(4): 묶음 상신에서 한 건만 재상신하면 그 건만 대체되고 같은 묶음의 다른 건은 유지된다', async () => {
  const { app, p3, cleanup } = await makeApp({ fakeP4: FAKE_P4 });
  try {
    const { approval_request: req } = await p3.deliverMock('M-SUB-002');
    assert.deepEqual(req.commitment_ids, ['CMT-PLAN-001', 'CMT-PLAN-002', 'CMT-PLAN-003']);
    await app.events.emit({ event_type: 'ALTERNATIVE_SELECTED', source_type: '사람입력', is_synthetic: true, plan_id: 'PLAN-003', payload: { alternative_id: 'ALT-T2', plan_id: 'PLAN-003', alternative_type: '집행일이동', plan_change: { plan_id: 'PLAN-003', plan_version: 2, settlement_date: '2026-08-24', change_reason: '집행일이동', effective_at: '2026-07-10' } } }, 'p2');
    const req2 = await p3.submitApproval({ commitment_ids: ['CMT-PLAN-003'] });
    const old = p3.approvalRequest(req.approval_request_id);
    assert.deepEqual([old.superseded, old.superseded_commitment_ids], [false, ['CMT-PLAN-003']]);
    await reply(app, req, 'CMT-PLAN-001', '승인', 'GRP_CEO');
    await reply(app, req, 'CMT-PLAN-003', '승인', 'GRP_CEO'); // 대체된 건의 회신은 반영하지 않는다
    assert.equal(p3.commitment('CMT-PLAN-001').approval_status, '승인');
    assert.equal(p3.commitment('CMT-PLAN-002').approval_status, '결재 대기');
    assert.deepEqual([p3.commitment('CMT-PLAN-003').approval_status, p3.commitment('CMT-PLAN-003').approver, p3.commitment('CMT-PLAN-003').approval_request_id], ['결재 대기', 'MS_CEO', req2.approval_request_id]);
  } finally { await cleanup(); }
});

test('C(5): REVIEW_OPENED rejudge=false면 재계산하지 않고, 같은 전제의 재검토는 판정 버전을 중복으로 만들지 않는다', async () => {
  const { app, p3, cleanup } = await makeApp();
  try {
    const n0 = p3.routeJudgmentHistory('CMT-PLAN-002').length;
    const rj = p3.commitment('CMT-PLAN-002').route_judgment_id;
    await asP4(app, { event_type: 'REVIEW_OPENED', plan_id: 'PLAN-002', payload: { review_id: 'RV-T1', review_kind: '전제 변경', trigger_event_id: 'EV-000001', target_type: 'route_judgment', target_id: rj, due_date: '2026-07-02', rejudge: false } });
    await asP4(app, { event_type: 'REVIEW_OPENED', plan_id: 'PLAN-002', payload: { review_id: 'RV-T2', review_kind: '전제 변경', trigger_event_id: 'EV-000001', target_type: 'route_judgment', target_id: rj, due_date: '2026-07-02', rejudge: true } });
    assert.equal(p3.routeJudgmentHistory('CMT-PLAN-002').length, n0);
    await p3.applyFinanceReply('FR-001'); // 구간 버전이 바뀌어도 결론이 같으면 새 판정 버전을 만들지 않는다
    assert.equal(p3.routeJudgmentHistory('CMT-PLAN-002').length, n0);
    assert.equal(p3.commitment('CMT-PLAN-002').window_version, 'CW-002');
  } finally { await cleanup(); }
});

test('상신 첨부: 조건부 판정의 조건 종류(inbound_unconfirmed / reorder_required)를 함께 싣는다', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'w01-p3c-'));
  symlinkSync(P3_DIR, path.join(root, 'problem3'), 'dir');
  mkdirSync(path.join(root, 'problem2', 'src'), { recursive: true });
  writeFileSync(path.join(root, 'problem2', 'src', 'index.mjs'), `export function register(ctx) { ctx.expose({ latestSupplyJudgment: (planId) => planId === 'PLAN-002' ? { plan: { supply_judgment_id: 'SJ-T', supply_judgment_version: 1, plan_id: 'PLAN-002', supply_verdict: '조건부', source_type: '계산', is_simulation: true, condition_basis: [{ condition_type: 'inbound_unconfirmed', inbound_row_id: 'IN-1', source_ref: 'SPO-0008', eta_date: '2026-08-03' }, { condition_type: 'reorder_required', po_draft_id: 'PD-1', sku_id: 'SKU-3001', required_qty: 1200 }] }, skus: [] } : null, poDrafts: ({ po_draft_id }) => po_draft_id === 'PD-1' ? [{ po_draft_id: 'PD-1', sku_id: 'SKU-3001', order_qty: 12000, planned_order_date: '2026-07-22', order_deadline: '2026-07-24' }] : [] }); }`);
  const app = await createApp({ rootDir: root, dbPath: ':memory:', env: {}, log: quiet });
  try {
    await app.events.emit({ event_type: 'PO_DRAFT_CREATED', source_type: '계산', payload: { ...DRAFT_A, po_draft_id: 'PD-1', sku_id: 'SKU-3001', linked_plan_ids: ['PLAN-002'] } }, 'p2');
    const row = app.module('p3').submissionPackage('CMT-PLAN-002').rows[0];
    assert.deepEqual(row.condition_types, ['inbound_unconfirmed', 'reorder_required']);
    assert.equal(row.supply_conditions.length, 2);
    assert.equal(row.po_draft_conditions.length, 1);
    assert.deepEqual(Object.fromEntries(['po_draft_id', 'sku_id', 'required_qty', 'order_deadline', 'order_deadline_basis', 'payment_due_date', 'approver', 'approval_status'].map((k) => [k, row.po_draft_conditions[0][k]])),
      { po_draft_id: 'PD-1', sku_id: 'SKU-3001', required_qty: 1200, order_deadline: '2026-07-24', order_deadline_basis: 'order_deadline', payment_due_date: '2026-08-21', approver: 'GRP_CEO', approval_status: '미상신' });
    const { draft } = await (await fetch(`http://127.0.0.1:${await app.listen(0, '127.0.0.1')}/api/p3/draft`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ commitment_id: 'CMT-PLAN-002' }) })).json();
    assert.match(draft.text, /보충 발주\(색조 벨벳 립\): 발주 시한 2026-07-24/); // 품목은 이름으로
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});

// ── (D) 두 번째 수정: 결함 재현 ──
test('(D)-2 가: 구간이 바뀌면 결론이 바뀐 약정만 ROUTE_JUDGED를 내고, 나머지는 구간 사건 하나에 유지 요약으로 남긴다', async () => {
  const { app, p3, cleanup } = await makeApp();
  try {
    const n0 = app.events.query({ event_type: 'ROUTE_JUDGED', limit: 100000 }).length;
    await p3.applyFinanceReply('FR-001'); // 구간 그대로 → 판정 사건 0건
    assert.equal(app.events.query({ event_type: 'ROUTE_JUDGED', limit: 100000 }).length, n0);
    const w2 = app.events.query({ event_type: 'CASH_WINDOW_REVISED', order: 'desc', limit: 1 })[0].payload.recheck_summary;
    assert.deepEqual([w2.rechecked, w2.kept, w2.changed], [25, 25, 0]);
    await p3.applyFinanceReply('FR-002'); // 구간 09-04 → PLAN-004·011·018·024·025만 결론이 바뀐다
    const judged = app.events.query({ event_type: 'ROUTE_JUDGED', limit: 100000 }).slice(n0);
    assert.deepEqual(judged.map((e) => e.plan_id), ['PLAN-004', 'PLAN-011', 'PLAN-018', 'PLAN-024', 'PLAN-025']);
    const w3 = app.events.query({ event_type: 'CASH_WINDOW_REVISED', order: 'desc', limit: 1 })[0];
    assert.deepEqual([w3.payload.recheck_summary.rechecked, w3.payload.recheck_summary.kept, w3.payload.recheck_summary.changed], [25, 20, 5]);
    assert.match(w3.payload.recheck_summary.kept_rationale, /승인권자·승인 기준일·구간 안팎/);
    assert.ok(judged.every((e) => e.caused_by === w3.event_id));
  } finally { await cleanup(); }
});

test('(D)-2 가: 종결된 기안과 결정이 끝난 발주안은 재판정하지 않고, 같은 날 같은 약정을 두 번 판정하지 않는다', async () => {
  const { app, p3, cleanup } = await makeApp();
  try {
    await asP4(app, { event_type: 'PLAN_CONFIRMED', source_type: '사람입력', is_synthetic: true, plan_id: 'PLAN-004' });
    await app.events.emit({ event_type: 'PO_DRAFT_CREATED', source_type: '계산', payload: { ...DRAFT_A, po_draft_id: 'PD-S', amount_krw: 10_000_000 } }, 'p2');
    const pd = p3.commitmentBySource('PD-S');
    await reply(app, await p3.submitApproval({ commitment_ids: [pd.commitment_id] }), pd.commitment_id, '승인', 'GRP_CEO');
    const before = p3.routeJudgmentHistory('CMT-PLAN-004').length;
    const pdBefore = p3.routeJudgmentHistory(pd.commitment_id).length;
    await p3.applyFinanceReply('FR-002');
    assert.equal(p3.routeJudgmentHistory('CMT-PLAN-004').length, before); // 확정된 기안은 동결
    assert.equal(p3.commitment('CMT-PLAN-004').approver, 'MS_CEO');
    assert.equal(p3.routeJudgmentHistory(pd.commitment_id).length, pdBefore); // 승인된 발주안은 동결
    const sum = app.events.query({ event_type: 'CASH_WINDOW_REVISED', order: 'desc', limit: 1 })[0].payload.recheck_summary;
    assert.ok(sum.skipped_terminal >= 2);
    // 문제 4가 같은 날 재검토(rejudge=true)를 열어도 결론이 같으면 판정 버전을 늘리지 않는다
    const rj = p3.commitment('CMT-PLAN-024').route_judgment_id;
    const n24 = p3.routeJudgmentHistory('CMT-PLAN-024').length;
    await asP4(app, { event_type: 'REVIEW_OPENED', plan_id: 'PLAN-024', payload: { review_id: 'RV-T3', review_kind: '전제 변경', trigger_event_id: 'EV-000001', target_type: 'route_judgment', target_id: rj, due_date: '2026-07-02', rejudge: true } });
    assert.equal(p3.routeJudgmentHistory('CMT-PLAN-024').length, n24);
    const judged = app.events.query({ event_type: 'ROUTE_JUDGED', limit: 100000 });
    const keys = judged.map((e) => `${e.occurred_at}|${e.payload.commitment_id}|${e.payload.approver}|${e.payload.in_window}`);
    assert.equal(new Set(keys).size, keys.length);
  } finally { await cleanup(); }
});

test('(D)-2 나: 이미 승인된 약정에 조건 수용 회신이 오면 상태는 두고 조건을 기록한다', async () => {
  const { app, p3, cleanup } = await makeApp();
  try {
    const req = await p3.submitApproval({ commitment_ids: ['CMT-PLAN-002'] });
    await reply(app, req, 'CMT-PLAN-002', '승인', 'GRP_CEO');
    const cond = [{ condition_type: '공급조건부수용', ref_id: 'SJ-T9', text: '보충 발주 승인 조건으로 수용' }];
    await asP4(app, { event_type: 'APPROVAL_REPLIED', source_type: '모의회신', is_synthetic: true, plan_id: 'PLAN-002', payload: { approval_request_id: req.approval_request_id, commitment_id: 'CMT-PLAN-002', decision: '조건부', conditions: cond, approver: 'GRP_CEO', replied_at: '2026-07-15' } });
    const c = p3.commitment('CMT-PLAN-002');
    assert.equal(c.approval_status, '승인');
    assert.deepEqual(c.conditions, cond);
    // 같은 조건이 다시 와도 중복으로 쌓지 않는다
    await asP4(app, { event_type: 'APPROVAL_REPLIED', source_type: '모의회신', is_synthetic: true, plan_id: 'PLAN-002', payload: { approval_request_id: req.approval_request_id, commitment_id: 'CMT-PLAN-002', decision: '조건부', conditions: cond, approver: 'GRP_CEO', replied_at: '2026-07-16' } });
    assert.equal(p3.commitment('CMT-PLAN-002').conditions.length, 1);
  } finally { await cleanup(); }
});

// ── (E): 승인 가정 재전망·최저 잔액·캠페인 추가분 비중 ──
test('(E) 가: approvalImpact는 발주안 승인을 가정한 구간·최저 잔액을 돌려주고 상태는 바꾸지 않는다', async () => {
  const { app, p3, cleanup } = await makeApp();
  try {
    await app.events.emit({ event_type: 'PO_DRAFT_CREATED', source_type: '계산', payload: { ...DRAFT_A } }, 'p2');
    await app.events.emit({ event_type: 'PO_DRAFT_CREATED', source_type: '계산', payload: { ...DRAFT_A, po_draft_id: 'PD-BIG', amount_krw: 7_000_000_000, order_qty: 555_556 } }, 'p2');
    const nEvents = app.events.query({ limit: 100000 }).length;
    const nWin = p3.cashWindow().window_version;
    const imp = p3.approvalImpact({ commitment_id: 'CMT-PD-A' });
    assert.deepEqual([imp.before.shortfall_window_end, imp.before.min_balance_krw, imp.before.min_date], ['2026-08-21', 1_785_991_965, '2026-07-27']);
    assert.equal(imp.after.shortfall_window_end, '2026-08-28');
    assert.equal(imp.min_balance_delta_krw, imp.after.min_balance_krw - imp.before.min_balance_krw);
    assert.equal(imp.after_below_zero, false);
    assert.deepEqual(imp.added_outflows, [{ po_draft_id: 'PD-A', payment_due_date: '2026-08-21', amount_krw: 201_600_000 }]);
    // 70억 발주안은 승인 후 최저 잔액이 0원 미만 → 문제 4 모의 승인 규칙(2)의 거절 근거
    const big = p3.approvalImpact({ commitment_id: 'CMT-PD-BIG' });
    assert.equal(big.after_below_zero, true);
    assert.ok(big.after.min_balance_krw < 0);
    // 상태는 그대로: 사건·구간 버전·약정 상태가 늘거나 바뀌지 않는다
    assert.equal(app.events.query({ limit: 100000 }).length, nEvents);
    assert.equal(p3.cashWindow().window_version, nWin);
    assert.equal(p3.commitment('CMT-PD-A').approval_status, '미상신');
    // 이미 승인된 발주안과 기안은 유출을 더하지 않는다(전후 같음)
    await reply(app, await p3.submitApproval({ commitment_ids: ['CMT-PD-A'] }), 'CMT-PD-A', '승인', 'GRP_CEO');
    const again = p3.approvalImpact({ commitment_id: 'CMT-PD-A' });
    assert.deepEqual(again.after, again.before);
    assert.equal(again.before.shortfall_window_end, '2026-08-28');
    assert.match(again.notes[0], /이미 승인/);
    const plan = p3.approvalImpact({ commitment_id: 'CMT-PLAN-002' });
    assert.equal(plan.min_balance_delta_krw, 0);
    assert.match(plan.notes[0], /표본 스케일/);
  } finally { await cleanup(); }
});

test('(E) 나: 구간 버전마다 최저 잔액이 채워지고 CASH_WINDOW_REVISED 사건에도 실린다', async () => {
  const { app, p3, cleanup } = await makeApp();
  const port = await app.listen(0, '127.0.0.1');
  try {
    await p3.applyFinanceReply('FR-002');
    const { windows } = await (await fetch(`http://127.0.0.1:${port}/api/p3/windows`)).json();
    assert.equal(windows.length, 2);
    assert.ok(windows.every((w) => Number.isFinite(w.min_balance_krw) && w.min_date));
    for (const e of app.events.query({ event_type: 'CASH_WINDOW_REVISED', limit: 100 })) {
      const w = windows.find((x) => x.window_version === e.payload.window_version);
      assert.deepEqual([e.payload.min_balance_krw, e.payload.min_date], [w.min_balance_krw, w.min_date]);
    }
  } finally { await cleanup(); }
});

test('(E) 다: 상신 문서에 승인 전후 최저 잔액·하회 구간과 발주액 중 캠페인 추가분 비중을 싣는다(SKU 발주안이 여러 기안에 걸림)', async () => {
  const { app, p3, cleanup } = await makeApp();
  const port = await app.listen(0, '127.0.0.1');
  try {
    // SKU 단위 발주안 하나가 PLAN-001·PLAN-002에 걸림: 16,000EA = 캠페인 추가분 4,000 + MOQ 올림 12,000((F): 기준 수요분은 넣지 않음)
    await app.events.emit({ event_type: 'PO_DRAFT_CREATED', source_type: '계산', payload: { ...DRAFT_A, linked_plan_ids: ['PLAN-001', 'PLAN-002'], qty_breakdown: { campaign_added_ea: 4000, rounding_ea: 12000, campaign_by_plan: [{ plan_id: 'PLAN-001', qty_ea: 2500 }, { plan_id: 'PLAN-002', qty_ea: 1500 }] } } }, 'p2');
    for (const planId of ['PLAN-001', 'PLAN-002']) {
      const row = p3.submissionPackage(`CMT-${planId}`).rows[0];
      assert.equal(row.po_draft_conditions.length, 1);
      const d = row.po_draft_conditions[0];
      assert.deepEqual(d.linked_plan_ids, ['PLAN-001', 'PLAN-002']);
      assert.deepEqual([d.cash_impact.before.min_balance_krw, d.cash_impact.after.shortfall_window_end], [1_785_991_965, '2026-08-28']);
      assert.deepEqual([d.campaign_share.campaign_share_pct, d.campaign_share.campaign_amount_krw, d.campaign_share.campaign_added_ea, d.campaign_share.rounding_ea], [25, 50_400_000, 4000, 12000]);
      assert.deepEqual([row.cash_impact.before.shortfall_window_end, row.cash_impact.after.shortfall_window_end], ['2026-08-21', '2026-08-28']);
      assert.deepEqual([row.campaign_share.amount_krw, row.campaign_share.campaign_share_pct, row.campaign_share.missing_breakdown_count], [201_600_000, 25, 0]);
    }
    const { draft } = await (await fetch(`http://127.0.0.1:${port}/api/p3/draft`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ commitment_id: 'CMT-PLAN-001' }) })).json();
    assert.match(draft.text, /현금 영향\(관련 발주안 모두 승인 가정\): 최저 잔액 1,785,991,965원\(2026-07-27\) → /);
    assert.match(draft.text, /하회 구간 2026-07-21~2026-08-21\(24영업일\) → 2026-07-21~2026-08-28/);
    assert.match(draft.text, /캠페인 추가분 50,400,000원\(25%\)/);
    assert.match(draft.text, /발주 16,000EA = 캠페인 추가분 4,000EA\(25%\) \+ MOQ·올림분 12,000EA/);
    // 수량 내역이 없는 발주안은 비중을 만들지 않고 '내역 없음'으로 둔다
    await app.events.emit({ event_type: 'PO_DRAFT_CREATED', source_type: '계산', payload: { ...DRAFT_A, po_draft_id: 'PD-N', linked_plan_ids: ['PLAN-003'] } }, 'p2');
    const r3 = p3.submissionPackage('CMT-PLAN-003').rows[0];
    assert.equal(r3.po_draft_conditions[0].campaign_share.provided, false);
    assert.deepEqual([r3.campaign_share.campaign_share_pct, r3.campaign_share.missing_breakdown_count], [null, 1]);
  } finally { await cleanup(); }
});

// ── (F): 발주안 취소 반영, 수량 내역(qty_breakdown) ──
test('(F) 가: 문제 2가 취소한 발주안은 상태가 취소가 되고 상신·판정·묶음·순서표 상신에서 빠진다', async () => {
  const FAKE = `export function register(ctx) { ctx.expose({ getMockSchedule: () => [{ mock_id: 'M-PD', owner: 'p3', event_type: 'APPROVAL_SUBMITTED', target: 'PD-C', plan_id: 'PLAN-001', sim_date: '2026-07-15' }], getDeadlineSchedule: () => null, getPlanState: () => null }); }`;
  const { app, p3, cleanup } = await makeApp({ fakeP4: FAKE });
  try {
    await asP4(app, { event_type: 'PLAN_RECEIVED', source_type: '원본도출', plan_id: 'PLAN-001' }); // 가짜 문제 4가 있으면 기안은 접수 사건으로 등록된다
    await app.events.emit({ event_type: 'PO_DRAFT_CREATED', source_type: '계산', payload: { ...DRAFT_A, po_draft_id: 'PD-C' } }, 'p2');
    assert.equal(p3.commitment('CMT-PD-C').approval_status, '미상신');
    await app.events.emit({ event_type: 'PO_DRAFT_CANCELLED', source_type: '계산', payload: { po_draft_id: 'PD-C', draft_version: 1, cancel_reason: '보충 발주 필요 조건 해소' } }, 'p2');
    const c = p3.commitment('CMT-PD-C');
    assert.deepEqual([c.approval_status, c.active], ['취소', false]);
    assert.equal(p3.listCommitments({ commitment_type: '발주안', approval_status: '미상신' }).length, 0);
    await assert.rejects(p3.submitApproval({ commitment_ids: ['CMT-PD-C'] }), /취소된 발주안/);
    assert.match((await p3.deliverMock('M-PD')).skipped, /취소된 발주안/);
    // 기안 상신 문서의 발주안 조건·현금 영향에도 넣지 않는다
    const row = p3.submissionPackage('CMT-PLAN-001').rows[0];
    assert.equal(row.po_draft_conditions.length, 0);
    assert.equal(row.cash_impact.min_balance_delta_krw, 0);
    // 구간이 바뀌어도 재판정하지 않는다
    const n = p3.routeJudgmentHistory('CMT-PD-C').length;
    await p3.applyFinanceReply('FR-002');
    assert.equal(p3.routeJudgmentHistory('CMT-PD-C').length, n);
  } finally { await cleanup(); }
});

test('(F) 나: 수량 내역은 사전 qty_breakdown(캠페인 추가분·MOQ 올림분)을 읽고, 같은 버전에서 연결 기안·내역만 바뀌면 판정 없이 갱신한다', async () => {
  const { app, p3, cleanup } = await makeApp();
  try {
    // PLAN-011형: 캠페인 추가분 2,373EA, MOQ 16,000으로 올림 → 올림분 13,627EA. 비중·금액은 문제 2 값을 그대로 쓴다
    const qb = { campaign_added_ea: 2373, rounding_ea: 13627, campaign_share_pct: 14.83, campaign_amount_krw: 2373 * 12600, campaign_by_plan: [{ plan_id: 'PLAN-011', qty_ea: 2373, needed_by_week: '2026-08-03' }] };
    await app.events.emit({ event_type: 'PO_DRAFT_CREATED', source_type: '계산', payload: { ...DRAFT_A, po_draft_id: 'PD-Q', linked_plan_ids: ['PLAN-011'], qty_breakdown: qb } }, 'p2');
    const s = p3.submissionPackage('CMT-PD-Q').rows[0].po_draft_conditions[0].campaign_share;
    assert.deepEqual([s.provided, s.order_qty, s.campaign_added_ea, s.rounding_ea, s.campaign_share_pct, s.campaign_amount_krw], [true, 16000, 2373, 13627, 14.83, 29_899_800]);
    assert.equal(s.campaign_by_plan[0].plan_id, 'PLAN-011');
    const nJudged = app.events.query({ event_type: 'ROUTE_JUDGED', limit: 100000 }).length;
    await app.events.emit({ event_type: 'PO_DRAFT_CREATED', source_type: '계산', payload: { ...DRAFT_A, po_draft_id: 'PD-Q', linked_plan_ids: ['PLAN-011', 'PLAN-012'], qty_breakdown: { ...qb, campaign_added_ea: 3000, rounding_ea: 13000, campaign_share_pct: 18.75, campaign_amount_krw: 3000 * 12600 } } }, 'p2');
    assert.equal(app.events.query({ event_type: 'ROUTE_JUDGED', limit: 100000 }).length, nJudged);
    const row = p3.submissionPackage('CMT-PLAN-012').rows[0];
    assert.deepEqual([row.po_draft_conditions[0].po_draft_id, row.campaign_share.campaign_share_pct], ['PD-Q', 18.75]);
  } finally { await cleanup(); }
});

// ── S-CEO-FLOOR 확인: 하회 구간이 여러 조각일 때의 판정 근거·표시 ──
test('조각 구간: 현행 구간 밖 09-21 유출 발주안이 자기 유출로 9월 하순 둘째 조각을 만들면 GRP_CEO이고, 근거에 조각 2/2를 적는다', async () => {
  const { app, p3, cleanup } = await makeApp();
  try {
    const SEP = { ...DRAFT_A, planned_order_date: '2026-08-03', linked_plan_ids: ['PLAN-011'] }; // 지급 09-21
    // 3억: 09-21 잔액이 30억 위 → 조각 밖, SCM
    await app.events.emit({ event_type: 'PO_DRAFT_CREATED', source_type: '계산', payload: { ...SEP, po_draft_id: 'PD-SM', amount_krw: 300_000_000 } }, 'p2');
    const small = p3.routeJudgment(p3.commitment('CMT-PD-SM').route_judgment_id);
    assert.deepEqual([small.approver, small.in_window, small.matched_segment], ['SCM', false, null]);
    assert.equal(small.scenario_window.segments.length, 1);
    // 33억: 자기 유출을 더하면 09-21~09-30에 둘째 조각 → R-01 GRP_CEO. 현행 구간(07-21~08-21) 자체는 그대로
    await app.events.emit({ event_type: 'PO_DRAFT_CREATED', source_type: '계산', payload: { ...SEP, po_draft_id: 'PD-BG', amount_krw: 3_300_000_000 } }, 'p2');
    assert.deepEqual(p3.cashWindow().segments.map((s) => [s.start, s.end]), [['2026-07-21', '2026-08-21']]);
    const rj = p3.routeJudgment(p3.commitment('CMT-PD-BG').route_judgment_id);
    assert.deepEqual([rj.approver, rj.in_window], ['GRP_CEO', true]);
    assert.deepEqual(rj.scenario_window.segments.map((s) => [s.start, s.end]), [['2026-07-21', '2026-08-21'], ['2026-09-21', '2026-09-30']]);
    const m = rj.matched_segment;
    assert.deepEqual([m.segment_no, m.segment_count, m.start, m.end, m.end_at_horizon, m.basis], [2, 2, '2026-09-21', '2026-09-30', true, 'scenario_with_own_outflow']);
    assert.ok(Number.isFinite(m.min_balance_krw) && m.min_balance_krw < 3_000_000_000 && m.min_date >= '2026-09-21');
    const ev = app.events.query({ event_type: 'ROUTE_JUDGED', order: 'desc', limit: 1 })[0];
    assert.equal(ev.payload.matched_segment.segment_no, 2);
    assert.match(ev.payload.rationale, /이 발주안 유출을 더한 시나리오 재전망의 하회 조각 2\/2\(2026-09-21~2026-09-30, 재전망 끝까지/);
    assert.match(ev.payload.rationale, /조각: 1\) 2026-07-21~2026-08-21, 2\) 2026-09-21~2026-09-30/);
    // 승인되면 현행 구간도 두 조각이 되고, 구간 사건·조회에 조각마다 시작·끝·최저 잔액이 실린다
    await reply(app, await p3.submitApproval({ commitment_ids: ['CMT-PD-BG'] }), 'CMT-PD-BG', '승인', 'GRP_CEO');
    const w = p3.cashWindow();
    assert.deepEqual(w.segments.map((s) => [s.segment_no, s.start, s.end, s.end_at_horizon]), [[1, '2026-07-21', '2026-08-21', false], [2, '2026-09-21', '2026-09-30', true]]);
    assert.equal(w.segments[0].min_balance_krw, 1_785_991_965);
    const cw = app.events.query({ event_type: 'CASH_WINDOW_REVISED', order: 'desc', limit: 1 })[0];
    assert.deepEqual(cw.payload.segments, w.segments);
  } finally { await cleanup(); }
});

// ── 사용자 결정(2026-11-15): 오른쪽 평가자 화면의 사건 설명 카드, 왼쪽 사용자 화면의 승인 요청 흐름 ──
const CARD_KEYS = ['title', 'actor_kind', 'actor_label', 'inputs', 'rule', 'result'];
const SOURCES = ['원본', '합성', '계산', '사람입력', '모의회신', '가정'];
const checkCard = (card) => {
  for (const k of CARD_KEYS) assert.ok(card[k] != null && card[k] !== '', `카드 ${k}`);
  assert.ok(['사람', 'AI', '규칙·계산', '모의 입력'].includes(card.actor_kind));
  for (const i of card.inputs) { assert.ok(i.label && i.value != null && i.ref, JSON.stringify(i)); assert.ok(SOURCES.includes(i.source), i.source); }
  assert.doesNotMatch(`${card.title} ${card.result}`, /GRP_CEO|MS_CEO|MKT_TEAM|\bR-0\d\b/); // 코드 이름 대신 업무 용어
};

test('describeEvent: 구간 산출·변경, 재무 회신, 지급일, 경로 판정(약정 등록), 상신, 승인 회신을 실제 값으로 설명하고 모르는 사건은 null', async () => {
  const { app, p3, cleanup } = await makeApp();
  try {
    const card = (e) => { const c = p3.describeEvent(e); checkCard(c); return c; };
    const cw1 = card(app.events.query({ event_type: 'CASH_WINDOW_REVISED' })[0]);
    assert.match(cw1.title, /현금 하회 구간 산출: 2026-07-21~2026-08-21\(24영업일\)/);
    assert.ok(cw1.inputs.some((i) => i.value === '5,148,063,540원' && i.source === '원본'));
    assert.match(cw1.result, /최저 17\.86억 원\(2026-07-27\)/);
    const rj2 = card(app.events.query({ event_type: 'ROUTE_JUDGED', plan_id: 'PLAN-002' })[0]);
    assert.match(rj2.title, /승인 경로 판정: 그룹 CEO\(유출일이 하회 구간 안\) · 약정 등록/);
    assert.match(rj2.result, /하회 구간\(2026-07-21~2026-08-21\) 안 → 승인권자 그룹 CEO/);
    assert.match(rj2.rule, /그룹 CEO 결재/);
    const rj24 = card(app.events.query({ event_type: 'ROUTE_JUDGED', plan_id: 'PLAN-024' })[0]);
    assert.ok(rj24.inputs.some((i) => i.value === '180,803,272원' && i.source === '합성'));
    assert.match(rj24.title, /Masil 대표/);
    // 회수일 지연 회신 → 구간 변경 → PLAN-004 경로 변경
    await p3.applyFinanceReply('FR-002');
    const ar = card(app.events.query({ event_type: 'AR_DATE_REVISED' })[0]);
    assert.match(ar.title, /MAR-0004 → 2026-09-06, MAR-0005 → 2026-09-13/);
    assert.equal(ar.actor_kind, '모의 입력');
    const cw2 = card(app.events.query({ event_type: 'CASH_WINDOW_REVISED', order: 'desc', limit: 1 })[0]);
    assert.match(cw2.title, /변경: 2026-07-21~2026-09-04\(34영업일\)/);
    assert.ok(cw2.inputs.some((i) => i.label === '회수 예정일 변경(MAR-0004)' && i.source === '모의회신'));
    assert.match(cw2.next, /PLAN-004 Masil 대표 → 그룹 CEO/);
    // 발주안: 지급일 산출 → 경로 판정 → 상신 → 승인 회신(구간 새 버전)
    await app.events.emit({ event_type: 'PO_DRAFT_CREATED', source_type: '계산', payload: { ...DRAFT_A } }, 'p2');
    const pd = card(app.events.query({ event_type: 'PAYMENT_DATE_SET' })[0]);
    assert.match(pd.title, /발주안 PD-A 지급일 산출: 2026-08-21/);
    assert.ok(pd.inputs.some((i) => i.source === '합성' && /청구월 마감, 1개월 뒤 21일/.test(i.value)));
    const req = await p3.submitApproval({ commitment_ids: ['CMT-PD-A'], actor_role: 'SCM 발주 검토(기본 모의 입력)' });
    const sub = card(app.events.query({ event_type: 'APPROVAL_SUBMITTED', order: 'desc', limit: 1 })[0]);
    assert.deepEqual([sub.actor_kind, sub.actor_label], ['모의 입력', 'SCM']);
    await reply(app, req, 'CMT-PD-A', '승인', 'GRP_CEO');
    const rp = card(app.events.query({ event_type: 'APPROVAL_REPLIED', order: 'desc', limit: 1 })[0]);
    assert.match(rp.title, /승인 회신: 그룹 CEO 승인 · 발주안 PD-A/);
    assert.match(rp.result, /하회 구간 새 버전 CW-\d+/);
    assert.equal(p3.describeEvent({ event_type: 'SUPPLY_JUDGED', payload: {} }), null);
  } finally { await cleanup(); }
});

test('사용자 화면 API: 승인권자·이유 확인 → AI 초안 → 수정 후 확인 → 상신 → 회신을 한 번에 본다. 확인 전 AI 초안으로는 상신할 수 없다', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'w01-p3ui-'));
  symlinkSync(P3_DIR, path.join(root, 'problem3'), 'dir');
  const fetchImpl = async () => ({ ok: true, json: async () => ({ model: 'anthropic/claude-fable-5.2', choices: [{ message: { content: 'AI 상신 초안' } }] }) });
  const app = await createApp({ rootDir: root, dbPath: ':memory:', env: { OPENROUTER_API_KEY: 'x' }, fetchImpl, log: quiet });
  const port = await app.listen(0, '127.0.0.1');
  try {
    const base = `http://127.0.0.1:${port}`;
    const get = async (p) => (await fetch(base + p)).json();
    const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, ...(await r.json()) }; };
    const v0 = await get('/api/p3/plan/PLAN-002/approval');
    assert.deepEqual([v0.approver.name, v0.approval_status, v0.can_submit, v0.reason.in_window, v0.reason.cash_outflow_date], ['그룹 CEO', '미상신', true, true, '2026-08-06']);
    assert.match(v0.reason.rule_text, /그룹 CEO 결재/);
    assert.deepEqual(v0.submit_group.map((x) => x.plan_id), ['PLAN-002']); // 사용자 상신은 이 기안 한 건
    const { draft } = await post('/api/p3/draft', { commitment_id: 'CMT-PLAN-002' });
    assert.equal((await post('/api/p3/plan/PLAN-002/approval/submit', { draft_id: draft.draft_id })).status, 409); // 확인 전 AI 초안
    const ed = await post(`/api/p3/draft/${draft.draft_id}/review`, { review_result: '수정 후 확인', text: '담당자가 고친 상신 문서' });
    assert.deepEqual([ed.draft.review_status, ed.draft.text, ed.draft.original_text], ['수정 후 확인', '담당자가 고친 상신 문서', 'AI 상신 초안']);
    assert.deepEqual(app.events.query({ event_type: 'AI_OUTPUT_REVIEWED' })[0].payload.edited_fields, ['text']);
    const s = await post('/api/p3/plan/PLAN-002/approval/submit', { draft_id: draft.draft_id });
    assert.equal(s.status, 200);
    assert.deepEqual([s.approval.approval_status, s.approval.can_submit, s.approval.requests[0].draft_id], ['결재 대기', false, draft.draft_id]);
    const ev = app.events.query({ event_type: 'APPROVAL_SUBMITTED' })[0];
    assert.deepEqual([ev.actor_role, ev.payload.draft_id], ['마케팅 기안 담당자', draft.draft_id]);
    const card = app.module('p3').describeEvent(ev);
    assert.deepEqual([card.actor_kind, card.actor_label], ['사람', '마케팅 기안 담당자']);
    assert.ok(card.inputs.some((i) => /AI 초안, 수정 후 확인/.test(i.value)));
    await app.events.emit({ event_type: 'APPROVAL_REPLIED', source_type: '모의회신', is_synthetic: true, plan_id: 'PLAN-002', subject_type: 'commitment', subject_id: 'CMT-PLAN-002', payload: { approval_request_id: s.approval_request.approval_request_id, commitment_id: 'CMT-PLAN-002', decision: '조건부', conditions: [{ condition_type: '보충발주', text: '보충 발주 승인 조건' }], approver: 'GRP_CEO', replied_at: '2026-07-14' } }, 'p4');
    const v1 = await get('/api/p3/plan/PLAN-002/approval');
    assert.deepEqual([v1.approval_status, v1.latest_reply.decision, v1.latest_reply.approver_name, v1.latest_reply.conditions[0].text], ['조건부', '조건부', '그룹 CEO', '보충 발주 승인 조건']);
    assert.match(v1.submit_blockers[0], /조건부/);
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});

// ── 다듬기: 사용자 상신은 한 건, AI 상신 초안 입력에는 코드가 없다 ──
test('사용자 화면 상신은 그 기안 한 건만 올리고, 함께 올릴 기안은 사용자가 고른 것만(같은 승인권자·같은 마감 후보 안에서) 받는다', async () => {
  const FAKE = `export function register(ctx) { ctx.expose({ getMockSchedule: () => [], getDeadlineSchedule: () => ({ submission_due: '2026-07-09', final_reply_due: '2026-07-16', judgment_due: '2026-07-08' }), getPlanState: () => null }); }`;
  const { app, p3, cleanup } = await makeApp({ fakeP4: FAKE });
  const port = await app.listen(0, '127.0.0.1');
  try {
    for (const id of ['PLAN-001', 'PLAN-002', 'PLAN-003', 'PLAN-004']) await asP4(app, { event_type: 'PLAN_RECEIVED', source_type: '원본도출', plan_id: id });
    const base = `http://127.0.0.1:${port}`;
    const get = async (p) => (await fetch(base + p)).json();
    const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, ...(await r.json()) }; };
    const v = await get('/api/p3/plan/PLAN-002/approval');
    assert.deepEqual(v.submit_group.map((x) => x.plan_id), ['PLAN-002']);
    assert.deepEqual(v.bundle_candidates.map((x) => x.plan_id), ['PLAN-001', 'PLAN-003']); // 같은 그룹 CEO·같은 마감. PLAN-004(Masil 대표)는 후보 아님
    assert.ok(v.bundle_candidates[0].campaign_name);
    // 고르지 않으면 한 건만
    const one = await post('/api/p3/plan/PLAN-002/approval/submit', {});
    assert.deepEqual(one.approval_request.commitment_ids, ['CMT-PLAN-002']);
    assert.equal(p3.commitment('CMT-PLAN-001').approval_status, '미상신');
    // 후보 밖 기안은 거부, 고른 후보만 함께
    assert.equal((await post('/api/p3/plan/PLAN-001/approval/submit', { with_plan_ids: ['PLAN-004'] })).status, 400);
    const two = await post('/api/p3/plan/PLAN-001/approval/submit', { with_plan_ids: ['PLAN-003'] });
    assert.deepEqual(two.approval_request.commitment_ids, ['CMT-PLAN-001', 'CMT-PLAN-003']);
    // 자동 처리(모의 입력)의 묶음 상신은 그대로: 같은 승인권자·같은 마감의 미상신 건을 묶는다
    assert.deepEqual(p3.approvalRequestsFor('CMT-PLAN-001').length, 1);
  } finally { await cleanup(); }
});

test('AI 상신 초안: 입력 자료와 지시문에 시스템 코드 대신 캠페인 이름·업무 용어를 쓰고, 수치는 시스템 값을 그대로 준다', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'w01-p3pr-'));
  symlinkSync(P3_DIR, path.join(root, 'problem3'), 'dir');
  let sent = null;
  const fetchImpl = async (_url, init) => { sent = JSON.parse(init.body); return { ok: true, json: async () => ({ model: 'anthropic/claude-fable-5.2', choices: [{ message: { content: '초안' } }] }) }; };
  const app = await createApp({ rootDir: root, dbPath: ':memory:', env: { OPENROUTER_API_KEY: 'x' }, fetchImpl, log: quiet });
  try {
    await app.events.emit({ event_type: 'PO_DRAFT_CREATED', source_type: '계산', payload: { ...DRAFT_A, linked_plan_ids: ['PLAN-002'], qty_breakdown: { campaign_added_ea: 4000, rounding_ea: 12000 } } }, 'p2');
    const port = await app.listen(0, '127.0.0.1');
    await fetch(`http://127.0.0.1:${port}/api/p3/draft`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ commitment_id: 'CMT-PLAN-002' }) });
    const [sys, user] = sent.messages;
    assert.match(sys.content, /캠페인 이름과 업무 용어로만 쓴다/);
    assert.match(sys.content, /그대로 인용한다/);
    assert.doesNotMatch(user.content, /CMT-|PLAN-\d|RJ-|CW-\d|APR-|PD-A|GRP_CEO|MS_CEO|contract_deadline|settlement_date|cash_outflow|\bR-0\d\b|SKU-\d/);
    const doc = JSON.parse(user.content.replace(/^상신 자료:\n/, ''))[0];
    const plan = (await (await fetch(`http://127.0.0.1:${port}/api/plans`)).json()).plans.find((x) => x.plan_id === 'PLAN-002');
    assert.equal(doc.캠페인, `${plan.campaign_name}(${plan.product_line})`);
    assert.deepEqual([doc.승인권자, doc.유출일과_하회_구간, doc.승인_기준일, doc.현재_최저_잔액], ['그룹 CEO', '하회 구간 안', '2026-07-17(확정기한)', '1,785,991,965원(2026-07-27)']);
    assert.match(doc.요청액, /원\(표본 스케일 금액\)$/);
    assert.equal(doc.보충_발주[0].품목.includes('SKU'), false);
    assert.match(doc.발주액_중_캠페인_추가분, /50,400,000원\(25%\)/);
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});

// ── 공급 확약 분리(사용자 요청 2026-11-15, 문제 2 v2.0) ──
const FAKE_P2_SC = `export function register(ctx) { ctx.expose({
  supplyCommitments: ({ target_id } = {}) => (globalThis.__P3T_SC ?? []).filter((x) => !target_id || x.target_id === target_id),
  poDrafts: () => [],
  latestSupplyJudgment: (pid) => pid === 'PLAN-001' ? { plan: { supply_verdict: '조건부', source_type: '계산', is_simulation: true, condition_basis: [
    { condition_type: 'supply_commitment_pending', sku_id: 'SKU-2001', inbound_row_id: 'IB-PD-A', eta_date: '2026-09-14' },
    { condition_type: 'baseline_replenishment_unconfirmed', sku_id: 'SKU-2002', reason: '보충 계획 미확인', after_sale_shortage_ea: 1200 }] }, skus: [] } : null,
}); }`;
async function makeAppWithP2() {
  const root = mkdtempSync(path.join(tmpdir(), 'w01-p3sc-'));
  symlinkSync(P3_DIR, path.join(root, 'problem3'), 'dir');
  mkdirSync(path.join(root, 'problem2', 'src'), { recursive: true });
  writeFileSync(path.join(root, 'problem2', 'src', 'index.mjs'), FAKE_P2_SC);
  globalThis.__P3T_SC = [];
  const app = await createApp({ rootDir: root, dbPath: ':memory:', env: {}, log: quiet });
  return { app, p3: app.module('p3'), cleanup: async () => { await app.close(); rmSync(root, { recursive: true, force: true }); globalThis.__P3T_SC = []; } };
}
const SC = (o) => ({ supply_commitment_id: `SC-PD-A-v${o.reply_version ?? 1}`, record_id: `S2-CVC-T-${o.reply_version ?? 1}`, target_type: '발주안', target_id: 'PD-A', sku_id: 'SKU-2001', linked_plan_ids: ['PLAN-001'], requested_qty: 16000, expected_eta_date: '2026-09-14', validation_status: '정상', validation_issues: [], material_status: '확보', production_status: '배정', remaining_conditions: '검사 1일, 운송 3일', reply_version: 1, ...o });
const supplierReplied = (app, sc) => app.events.emit({ event_type: 'SUPPLIER_REPLIED', source_type: '모의회신', is_synthetic: true, plan_id: 'PLAN-001', subject_type: 'supply_commitment', subject_id: sc.supply_commitment_id, payload: { supply_commitment: sc } }, 'p2');

test('공급 확약 (가)·(라): 발주안마다 내부 승인과 Corevia 공급 확약을 나눠 싣고, 상신 문서에 미확인 공급 조건과 현금 재전망 한계가 그대로 실린다', async () => {
  const { app, p3, cleanup } = await makeAppWithP2();
  try {
    await app.events.emit({ event_type: 'PO_DRAFT_CREATED', source_type: '계산', payload: { ...DRAFT_A } }, 'p2');
    await reply(app, await p3.submitApproval({ commitment_ids: ['CMT-PD-A'] }), 'CMT-PD-A', '승인', 'GRP_CEO');
    // (a) 내부 승인만으로는 공급 확약이 아니다
    let d = p3.submissionPackage('CMT-PLAN-001').rows[0].po_draft_conditions[0];
    assert.deepEqual([d.internal_approval_status, d.internal_approval_label, d.supply_commitment.supply_commitment_status], ['승인', '내부 승인됨(구매·지출 허용, 공급 확약 아님)', '확인 대기']);
    assert.match(d.supply_commitment.label, /Corevia 공급 회신 전/);
    // 부분 공급 회신: 확약 수량과 미확약 잔량을 나눠 싣는다
    globalThis.__P3T_SC = [SC({ reply_status: '부분 가능', offered_qty: 8000, committed_qty: 8000, uncommitted_qty: 8000, offered_eta_date: '2026-09-14' })];
    const row = p3.submissionPackage('CMT-PLAN-001').rows[0];
    d = row.po_draft_conditions[0];
    assert.deepEqual([d.supply_commitment.supply_commitment_status, d.supply_commitment.committed_qty, d.supply_commitment.uncommitted_qty], ['부분 확약', 8000, 8000]);
    assert.deepEqual(row.unconfirmed_supply_conditions.map((x) => x.label), ['공급 확약 대기', '기준 수요 보충 미확인']);
    assert.match(row.cash_limitations[0], /SCM 기준 수요 정기 보충 발주의 지급은 기준선 재전망에 들어 있지 않다/);
    assert.match(row.cash_limitations[1], /원래 발주 금액 그대로/);
    assert.match(p3.approvalImpact({ commitment_id: 'CMT-PLAN-001' }).limitations[0], /SCM 기준 수요/);
    const port = await app.listen(0, '127.0.0.1');
    const { draft } = await (await fetch(`http://127.0.0.1:${port}/api/p3/draft`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ commitment_id: 'CMT-PLAN-001' }) })).json();
    assert.match(draft.text, /내부 승인됨\(구매·지출 허용, 공급 확약 아님\)/);
    assert.match(draft.text, /Corevia 공급 확약: 부분 확약: 8000EA\(도착 2026-09-14\), 미확약 잔량 8000EA\(남은 조건: 검사 1일, 운송 3일\)/);
    assert.match(draft.text, /미확인 공급 조건\(승인으로 풀리지 않고 Corevia·SCM 회신으로만 풀림\): 기초 토너 대용량 공급 확약 대기/);
    assert.match(draft.text, /현금 재전망 한계: SCM 기준 수요 정기 보충/);
    const v = await (await fetch(`http://127.0.0.1:${port}/api/p3/plan/PLAN-001/approval`)).json();
    assert.deepEqual([v.po_drafts[0].internal_approval_status, v.po_drafts[0].supply_commitment.supply_commitment_status], ['승인', '부분 확약']);
    assert.equal(v.unconfirmed_supply_conditions.length, 2);
    assert.equal(v.cash_impact.limitations.length, 2);
    // 승인 회신 카드: 내부 승인은 공급 확약이 아니라고 적는다
    const card = p3.describeEvent(app.events.query({ event_type: 'APPROVAL_REPLIED', order: 'desc', limit: 1 })[0]);
    assert.match(card.title, /^내부 승인 회신: 그룹 CEO 승인 · 발주안 PD-A/);
    assert.match(card.result, /Corevia 공급 확약이 아니다\. 현재 공급 확약 상태: 부분 확약/);
  } finally { await cleanup(); }
});

test('공급 확약 (나): 승인 회신의 공급 위험 수용은 승인 상태의 속성으로만 기록하고 공급 상태는 바꾸지 않는다', async () => {
  const { app, p3, cleanup } = await makeAppWithP2();
  try {
    await app.events.emit({ event_type: 'PO_DRAFT_CREATED', source_type: '계산', payload: { ...DRAFT_A } }, 'p2');
    const req = await p3.submitApproval({ commitment_ids: ['CMT-PLAN-001'] });
    const cond = [{ condition_type: 'supply_commitment_pending', acceptance_type: '공급 위험 수용', text: 'Corevia 확약 전 공급 위험을 알고 승인' }];
    await asP4(app, { event_type: 'APPROVAL_REPLIED', source_type: '모의회신', is_synthetic: true, plan_id: 'PLAN-001', subject_type: 'commitment', subject_id: 'CMT-PLAN-001', payload: { approval_request_id: req.approval_request_id, commitment_id: 'CMT-PLAN-001', decision: '조건부', conditions: cond, approver: 'GRP_CEO', replied_at: '2026-07-14', supply_risk_accepted: true } });
    const c = p3.commitment('CMT-PLAN-001');
    assert.equal(c.approval_status, '조건부');
    assert.deepEqual([c.supply_risk_acceptance.accepted, c.supply_risk_acceptance.accepted_condition_types], [true, ['supply_commitment_pending']]);
    assert.match(c.supply_risk_acceptance.note, /Corevia 공급 확약이 아니다/);
    // 공급 상태(발주안의 Corevia 확약)·미확인 조건은 그대로
    const row = p3.submissionPackage('CMT-PLAN-001').rows[0];
    assert.equal(row.po_draft_conditions[0].supply_commitment.supply_commitment_status, '확인 대기');
    assert.equal(row.unconfirmed_supply_conditions.length, 2);
    const card = p3.describeEvent(app.events.query({ event_type: 'APPROVAL_REPLIED', order: 'desc', limit: 1 })[0]);
    assert.match(card.title, /공급 위험 수용/);
    assert.match(card.result, /공급 판정·입고 상태는 바꾸지 않는다/);
  } finally { await cleanup(); }
});

test('공급 확약 (다): 같은 회신 재처리·부분 공급은 약정·유출을 늘리거나 바꾸지 않고, 공급 불가면 약정을 취소해 유출을 빼며, 공급 가능 정정이면 되살린다', async () => {
  const { app, p3, cleanup } = await makeAppWithP2();
  try {
    await app.events.emit({ event_type: 'PO_DRAFT_CREATED', source_type: '계산', payload: { ...DRAFT_A } }, 'p2');
    await reply(app, await p3.submitApproval({ commitment_ids: ['CMT-PD-A'] }), 'CMT-PD-A', '승인', 'GRP_CEO');
    const w0 = p3.cashWindow();
    assert.equal(w0.shortfall_window_end, '2026-08-28'); // 내부 승인 = 지출 허용 → 유출 한 번 편입
    const nCommit = p3.listCommitments({ commitment_type: '발주안' }).length;
    const partial = SC({ reply_status: '부분 가능', offered_qty: 8000, committed_qty: 8000, uncommitted_qty: 8000, offered_eta_date: '2026-09-14' });
    for (let i = 0; i < 2; i++) await supplierReplied(app, partial); // 같은 회신 두 번
    await app.events.emit({ event_type: 'PO_DRAFT_CREATED', source_type: '계산', payload: { ...DRAFT_A } }, 'p2'); // 같은 발주안 사건 재수신
    assert.equal(p3.cashWindow().window_version, w0.window_version);
    assert.equal(p3.listCommitments({ commitment_type: '발주안' }).length, nCommit);
    assert.deepEqual([p3.commitment('CMT-PD-A').amount_krw, p3.commitment('CMT-PD-A').approval_status], [201_600_000, '승인']); // 부분 공급이어도 발주 금액 그대로(한계)
    // 공급 불가(검증 정상) → 약정 취소, 유출 제외 → 구간이 08-21로 돌아온다
    const no = SC({ reply_version: 2, reply_status: '불가', offered_qty: 0, committed_qty: 0, uncommitted_qty: 16000 });
    await supplierReplied(app, no);
    const c = p3.commitment('CMT-PD-A');
    assert.deepEqual([c.approval_status, c.active, c.supply_cancel.reason], ['취소', false, 'Corevia 공급 불가']);
    const w1 = p3.cashWindow();
    assert.deepEqual([w1.shortfall_window_end, w1.min_balance_krw], ['2026-08-21', 1_785_991_965]);
    const cw = app.events.query({ event_type: 'CASH_WINDOW_REVISED', order: 'desc', limit: 1 })[0];
    assert.equal(app.events.get(cw.caused_by).event_type, 'SUPPLIER_REPLIED');
    // 같은 불가 회신·같은 발주안 사건이 다시 와도 유출을 두 번 빼거나 되살리지 않는다
    await supplierReplied(app, no);
    await app.events.emit({ event_type: 'PO_DRAFT_CREATED', source_type: '계산', payload: { ...DRAFT_A } }, 'p2');
    await app.events.emit({ event_type: 'PO_DRAFT_CANCELLED', source_type: '계산', payload: { po_draft_id: 'PD-A', draft_version: 1, cancel_reason: '시험' } }, 'p2');
    assert.equal(p3.cashWindow().window_version, w1.window_version);
    assert.equal(p3.commitment('CMT-PD-A').approval_status, '취소');
    // 모순 회신(확인 필요)은 아무것도 바꾸지 않는다
    await supplierReplied(app, SC({ reply_version: 3, reply_status: '가능', validation_status: '확인 필요', validation_issues: ['원료 가용일이 생산 완료보다 늦음'] }));
    assert.equal(p3.commitment('CMT-PD-A').approval_status, '취소');
    // 뒤 버전이 공급 가능으로 정정하면 승인·유출을 되살린다(한 번만)
    await supplierReplied(app, SC({ reply_version: 4, reply_status: '가능', offered_qty: 16000, committed_qty: 16000, uncommitted_qty: 0, offered_eta_date: '2026-09-28' }));
    assert.deepEqual([p3.commitment('CMT-PD-A').approval_status, p3.commitment('CMT-PD-A').active, p3.cashWindow().shortfall_window_end], ['승인', true, '2026-08-28']);
    assert.deepEqual(p3.cashWindow().included_sources.filter((x) => x.startsWith('po_draft:')), ['po_draft:PD-A']); // 유출은 발주안당 한 번
  } finally { await cleanup(); }
});

// ── 남은 한계 보강(2026-11-15): L1 철회 기안의 발주안, L6 정기 보충 민감도, L9 카드 한국어 ──
test('L1: 발주안의 연결 기안과 철회 처리 구분은 문제 2 사건 그대로 따른다(취소 / 기안만 뗌 / 발주 전달 뒤 남음). 스스로 추정하지 않고, 같은 취소가 다시 와도 유출을 두 번 빼지 않는다', async () => {
  const { app, p3, cleanup } = await makeApp();
  const port = await app.listen(0, '127.0.0.1');
  try {
    // (1) 취소: withdrawal.disposition='취소' → 기안 철회로 취소, 연결 기안은 문제 2의 linked_plan_ids_before
    await app.events.emit({ event_type: 'PO_DRAFT_CREATED', source_type: '계산', payload: { ...DRAFT_A, po_draft_id: 'PD-W', linked_plan_ids: ['PLAN-002'] } }, 'p2');
    await reply(app, await p3.submitApproval({ commitment_ids: ['CMT-PD-W'] }), 'CMT-PD-W', '승인', 'GRP_CEO');
    assert.equal(p3.cashWindow().shortfall_window_end, '2026-08-28');
    const cancel = { po_draft_id: 'PD-W', draft_version: 1, cancel_reason: '연결 기안 철회(발주 전달 전, 승인 발주안 취소)', linked_plan_ids: [], linked_plan_ids_before: ['PLAN-002'], withdrawal: { plan_id: 'PLAN-002', withdrawn_event_id: 'EV-T', disposition: '취소' } };
    for (let i = 0; i < 2; i++) await app.events.emit({ event_type: 'PO_DRAFT_CANCELLED', source_type: '계산', payload: cancel }, 'p2');
    const w = p3.commitment('CMT-PD-W');
    assert.deepEqual([w.approval_status, w.active, w.cancel_info.kind, w.cancel_info.plan_ids, w.cancel_info.withdrawal.disposition, w.cancel_info.outflow_removed], ['취소', false, '기안 철회로 취소', ['PLAN-002'], '취소', true]);
    assert.equal(p3.cashWindow().shortfall_window_end, '2026-08-21');
    assert.equal(app.events.query({ event_type: 'CASH_WINDOW_REVISED', limit: 100 }).filter((e) => e.caused_by && app.events.get(e.caused_by)?.event_type === 'PO_DRAFT_CANCELLED').length, 1);
    // 문제 2 사건 없이 다른 사유로 취소되면 '발주안 취소'(철회로 추정하지 않음)
    await app.events.emit({ event_type: 'PO_DRAFT_CREATED', source_type: '계산', payload: { ...DRAFT_A, po_draft_id: 'PD-X', linked_plan_ids: ['PLAN-003'] } }, 'p2');
    await asP4(app, { event_type: 'PLAN_WITHDRAWN', source_type: '사람입력', is_synthetic: true, plan_id: 'PLAN-003' });
    assert.equal(p3.commitment('CMT-PD-X').residual_after_withdrawal, null); // 철회만으로는 아무것도 표시하지 않는다
    await app.events.emit({ event_type: 'PO_DRAFT_CANCELLED', source_type: '계산', payload: { po_draft_id: 'PD-X', draft_version: 1, cancel_reason: '보충 발주 필요 조건 해소' } }, 'p2');
    assert.equal(p3.commitment('CMT-PD-X').cancel_info.kind, '발주안 취소');
    // (2) 발주 전달 뒤 남음: 문제 2가 orphan_status와 연결 기안 변경(PO_DRAFT_CREATED, 같은 판)을 내면 그대로 표시하고 유출은 유지
    const R = { ...DRAFT_A, po_draft_id: 'PD-R', linked_plan_ids: ['PLAN-001'] };
    await app.events.emit({ event_type: 'PO_DRAFT_CREATED', source_type: '계산', payload: R }, 'p2');
    await reply(app, await p3.submitApproval({ commitment_ids: ['CMT-PD-R'] }), 'CMT-PD-R', '승인', 'GRP_CEO');
    await fetch(`http://127.0.0.1:${port}/api/clock/advance`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: '2026-07-23' }) });
    const wv = p3.cashWindow().window_version;
    await asP4(app, { event_type: 'PLAN_WITHDRAWN', source_type: '사람입력', is_synthetic: true, plan_id: 'PLAN-001' });
    assert.equal(p3.commitment('CMT-PD-R').residual_after_withdrawal, null); // 문제 2 표시 전에는 추정하지 않는다
    const nJudged = app.events.query({ event_type: 'ROUTE_JUDGED', limit: 10000 }).length;
    await app.events.emit({ event_type: 'PO_DRAFT_CREATED', source_type: '계산', payload: { ...R, linked_plan_ids: [], change_kind: 'linked_plans_changed', linked_plan_ids_before: ['PLAN-001'], orphan_status: '기안 철회 뒤 남은 발주', withdrawal: { plan_id: 'PLAN-001', withdrawn_event_id: 'EV-W1', disposition: '발주 전달 뒤 남음' } } }, 'p2');
    const r = p3.commitment('CMT-PD-R');
    assert.deepEqual([r.approval_status, r.active, r.residual_after_withdrawal.plan_ids, r.residual_after_withdrawal.disposition, r.withdrawal_info.disposition], ['승인', true, ['PLAN-001'], '발주 전달 뒤 남음', '발주 전달 뒤 남음']);
    assert.deepEqual(p3.submissionPackage('CMT-PD-R').rows[0].po_draft_conditions[0].linked_plan_ids, []); // 연결 기안은 문제 2 값
    assert.equal(p3.cashWindow().window_version, wv); // 유출 유지
    assert.equal(app.events.query({ event_type: 'ROUTE_JUDGED', limit: 10000 }).length, nJudged); // 같은 판의 연결 변경은 재판정 없음
    // (3) 기안만 뗌: 연결 기안만 바뀌고 남은 발주 표시는 없다
    await app.events.emit({ event_type: 'PO_DRAFT_CREATED', source_type: '계산', payload: { ...DRAFT_A, po_draft_id: 'PD-M', linked_plan_ids: ['PLAN-004', 'PLAN-005'] } }, 'p2');
    await app.events.emit({ event_type: 'PO_DRAFT_CREATED', source_type: '계산', payload: { ...DRAFT_A, po_draft_id: 'PD-M', linked_plan_ids: ['PLAN-005'], change_kind: 'linked_plans_changed', linked_plan_ids_before: ['PLAN-004', 'PLAN-005'], withdrawal: { plan_id: 'PLAN-004', withdrawn_event_id: 'EV-W2', disposition: '기안만 뗌' } } }, 'p2');
    const m = p3.commitment('CMT-PD-M');
    assert.deepEqual([m.residual_after_withdrawal, m.withdrawal_info.disposition, m.withdrawal_info.plan_id], [null, '기안만 뗌', 'PLAN-004']);
    assert.deepEqual(p3.submissionPackage('CMT-PLAN-005').rows[0].po_draft_conditions.map((x) => x.po_draft_id), ['PD-M']);
    assert.deepEqual(p3.submissionPackage('CMT-PLAN-004').rows[0].po_draft_conditions.map((x) => x.po_draft_id), []);
  } finally { await cleanup(); }
});

test('자동(모의) 묶음 상신은 문제 4의 직접 처리 기안을 함께 올리지 않고, 직접 처리 기안 자체의 순서표 상신은 건너뛴다', async () => {
  const FAKE = `export function register(ctx) { ctx.expose({
    listDirectPlans: () => ['PLAN-001', 'PLAN-002', 'PLAN-003'],
    getMockSchedule: () => [
      { mock_id: 'M-S8', owner: 'p3', event_type: 'APPROVAL_SUBMITTED', plan_id: 'PLAN-008', sim_date: '2026-07-09' },
      { mock_id: 'M-S2', owner: 'p3', event_type: 'APPROVAL_SUBMITTED', plan_id: 'PLAN-002', sim_date: '2026-07-09' }],
    getDeadlineSchedule: () => ({ submission_due: '2026-07-09', final_reply_due: '2026-07-16', judgment_due: '2026-07-08' }), getPlanState: () => null }); }`;
  const { app, p3, cleanup } = await makeApp({ fakeP4: FAKE });
  const port = await app.listen(0, '127.0.0.1');
  try {
    for (const id of ['PLAN-001', 'PLAN-002', 'PLAN-003', 'PLAN-008', 'PLAN-009', 'PLAN-010']) await asP4(app, { event_type: 'PLAN_RECEIVED', source_type: '원본도출', plan_id: id });
    const r = await p3.deliverMock('M-S8');
    assert.deepEqual(r.approval_request.commitment_ids, ['CMT-PLAN-008', 'CMT-PLAN-009', 'CMT-PLAN-010']); // 같은 그룹 CEO·같은 마감이어도 PLAN-001~003 제외
    for (const id of ['PLAN-001', 'PLAN-002', 'PLAN-003']) assert.equal(p3.commitment(`CMT-${id}`).approval_status, '미상신');
    assert.match((await p3.deliverMock('M-S2')).skipped, /직접 처리 기안/);
    // 사용자가 기안 상세에서 올리면 그 기안만, 함께 올릴 후보로는 고를 수 있다
    const v = await (await fetch(`http://127.0.0.1:${port}/api/p3/plan/PLAN-002/approval`)).json();
    assert.deepEqual(v.bundle_candidates.map((x) => x.plan_id), ['PLAN-001', 'PLAN-003']);
  } finally { await cleanup(); }
});

const FAKE_P2_BR = `export function register(ctx) { ctx.expose({
  supplyCommitments: () => [], poDrafts: () => [], latestSupplyJudgment: () => null,
  baselineReplenishment: () => [
    { sku_id: 'SKU-2001', scm_confirmed: '확인', corevia_committed: '확약', record_ids: ['S2-SCM-BR-SKU-2001-1'], plan_rows: [
      { source_ref: 'SCM-BR:SKU-2001:1', qty: 17800, planned_order_date: '2026-07-06', eta_date: '2026-08-31', supply_status: '확약' },
      { source_ref: 'SCM-BR:SKU-2001:2', qty: 17800, planned_order_date: '2026-08-03', eta_date: '2026-09-28', supply_status: '확약' },
      { source_ref: 'SCM-BR:SKU-2001:3', qty: 17800, planned_order_date: '2026-08-31', eta_date: '2026-10-26', supply_status: '확약' },
      { source_ref: 'POD-0001', qty: 16000, planned_order_date: '2026-07-22', eta_date: '2026-09-14', supply_status: '예상' }] },
    { sku_id: 'SKU-1001', scm_confirmed: '미회신', corevia_committed: null, record_ids: [], plan_rows: [] },
  ],
}); }`;
test('L6: SCM이 확인한 정기 보충 계획을 원본 단가·결제 조건으로 금액·지급일을 도출해 민감도로 따로 계산하고, 경로 판정은 기준선으로 둔다', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'w01-p3br-'));
  symlinkSync(P3_DIR, path.join(root, 'problem3'), 'dir');
  mkdirSync(path.join(root, 'problem2', 'src'), { recursive: true });
  writeFileSync(path.join(root, 'problem2', 'src', 'index.mjs'), FAKE_P2_BR);
  const app = await createApp({ rootDir: root, dbPath: ':memory:', env: {}, log: quiet });
  const port = await app.listen(0, '127.0.0.1');
  const p3 = app.module('p3');
  try {
    const s = await (await fetch(`http://127.0.0.1:${port}/api/p3/sensitivity/scm-replenishment`)).json();
    // 확인된 SKU-2001 3건(캠페인 발주안 POD-·미회신 SKU 제외). 단가 = 201,600,000 ÷ 16,000 = 12,600원(원본 SPO-0005)
    assert.deepEqual(s.rows.map((r) => [r.source_ref, r.unit_price_krw, r.amount_krw, r.payment_due_date, r.in_horizon]), [
      ['SCM-BR:SKU-2001:1', 12600, 224_280_000, '2026-08-21', true],
      ['SCM-BR:SKU-2001:2', 12600, 224_280_000, '2026-09-21', true],
      ['SCM-BR:SKU-2001:3', 12600, 224_280_000, '2026-09-21', true]]); // 08-31 발주 → 8월 마감 → 09-21
    assert.deepEqual([s.confirmed_row_count, s.amount_total_krw, s.in_horizon_row_count, s.in_horizon_amount_krw], [3, 672_840_000, 3, 672_840_000]);
    assert.deepEqual([s.baseline.shortfall_window_end, s.baseline.min_balance_krw], ['2026-08-21', 1_785_991_965]);
    assert.equal(s.with_scm_replenishment.shortfall_window_end, '2026-08-28');
    assert.match(s.why_not_in_baseline, /판매 대금 유입이 없어/);
    // 경로 판정은 기준선: PLAN-004는 Masil 대표 그대로, 민감도에서만 그룹 CEO
    assert.equal(p3.commitment('CMT-PLAN-004').approver, 'MS_CEO');
    const d4 = s.route_differences.find((x) => x.plan_id === 'PLAN-004');
    assert.equal(d4.label, '정기 보충 발주를 넣으면 그룹 CEO 경로(기준선은 Masil 대표)');
    assert.deepEqual(s.route_differences.map((x) => x.plan_id).sort(), ['PLAN-004', 'PLAN-024']);
    assert.equal(p3.cashWindow().shortfall_window_end, '2026-08-21'); // 기준선 구간은 그대로
    // 상신 문서·승인 화면에 싣는다
    const row = p3.submissionPackage('CMT-PLAN-004').rows[0];
    assert.equal(row.scm_sensitivity.route_difference.sensitivity_approver, 'GRP_CEO');
    const { draft } = await (await fetch(`http://127.0.0.1:${port}/api/p3/draft`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ commitment_id: 'CMT-PLAN-004' }) })).json();
    assert.match(draft.text, /SCM 정기 보충 발주 민감도: 확인된 보충 발주 3건\(재전망 기간 지급 3건 672,840,000원\)을 넣으면 최저 잔액 1,785,991,965원 → /);
    assert.match(draft.text, /정기 보충 발주를 넣으면 그룹 CEO 경로\(기준선은 Masil 대표\)\. 승인 경로는 기준선으로 정한다/);
    const v = await (await fetch(`http://127.0.0.1:${port}/api/p3/plan/PLAN-004/approval`)).json();
    assert.equal(v.cash_impact.scm_sensitivity.with_scm_replenishment.shortfall_window_end, '2026-08-28');
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});

test('L9: 문제 3이 부른 AI 초안의 호출·확인 카드와 회수일 변경 카드에 영문 작업 이름·코드 대신 한국어 업무 용어를 쓴다', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'w01-p3l9-'));
  symlinkSync(P3_DIR, path.join(root, 'problem3'), 'dir');
  const fetchImpl = async () => ({ ok: true, json: async () => ({ model: 'anthropic/claude-fable-5.2', choices: [{ message: { content: '초안' } }] }) });
  const app = await createApp({ rootDir: root, dbPath: ':memory:', env: { OPENROUTER_API_KEY: 'x' }, fetchImpl, log: quiet });
  const port = await app.listen(0, '127.0.0.1');
  const p3 = app.module('p3');
  try {
    const post = (p, b) => fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
    const { draft } = await post('/api/p3/draft', { commitment_id: 'CMT-PLAN-002' });
    await post(`/api/p3/draft/${draft.draft_id}/review`, { review_result: '수정 후 확인', text: '고친 문서' });
    await p3.applyFinanceReply('FR-002');
    const cards = ['AI_CALL_RECORDED', 'AI_OUTPUT_REVIEWED', 'AR_DATE_REVISED', 'CASH_WINDOW_REVISED', 'ROUTE_JUDGED'].flatMap((t) => app.events.query({ event_type: t, limit: 1000 })).map((e) => p3.describeEvent(e));
    assert.ok(cards.every(Boolean));
    for (const c of cards) assert.doesNotMatch(`${c.title} ${c.rule} ${c.result} ${c.next ?? ''}`, /[a-z]+_[a-z_]+|covenant|GRP_CEO|MS_CEO/);
    assert.equal(cards[0].title, 'AI 작성: 승인 요청 문서 초안 작성 · PLAN-002');
    assert.equal(cards[1].title, '담당자 확인: 승인 요청 문서 초안을 고친 뒤 확인');
    // 다른 모듈의 AI 호출에는 카드를 주지 않는다
    assert.equal(p3.describeEvent({ event_type: 'AI_CALL_RECORDED', emitted_by: 'p1', payload: { ai_task_name: 'demand_reply_structure' } }), null);
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});

test('L5: 회수일 지연(MAR-0004·0005 각 14일)에서는 PLAN-003을 08-31로 옮겨도 구간(~09-04) 안이라 그룹 CEO로 다시 판정되고, 판정 근거에 구간 안이 드러난다', async () => {
  const { app, p3, cleanup } = await makeApp();
  try {
    await p3.applyFinanceReply('FR-002');
    assert.equal(p3.cashWindow().next_outside_date, '2026-09-07');
    const req = await p3.submitApproval({ commitment_ids: ['CMT-PLAN-003'] });
    await reply(app, req, 'CMT-PLAN-003', '거절', 'GRP_CEO');
    await app.events.emit({ event_type: 'ALTERNATIVE_SELECTED', source_type: '사람입력', is_synthetic: true, plan_id: 'PLAN-003', payload: { alternative_id: 'ALT-T5', plan_id: 'PLAN-003', alternative_type: '집행일이동', plan_change: { plan_id: 'PLAN-003', plan_version: 2, settlement_date: '2026-08-31', requested_budget_krw: null, change_reason: '집행일이동', effective_at: '2026-07-14' } } }, 'p2');
    const c = p3.commitment('CMT-PLAN-003');
    assert.deepEqual([c.cash_outflow_date, c.approver, c.approval_status], ['2026-08-31', 'GRP_CEO', '미상신']);
    const h = p3.routeJudgmentHistory('CMT-PLAN-003').at(-1);
    assert.equal(h.in_window, true);
    const ev = app.events.query({ event_type: 'ROUTE_JUDGED', plan_id: 'PLAN-003', order: 'desc', limit: 1 })[0];
    assert.match(ev.payload.rationale, /유출일 2026-08-31는 현행 재전망의 하회 조각 1\/1\(2026-07-21~2026-09-04/);
    assert.match(p3.describeEvent(ev).result, /유출일 2026-08-31이 하회 구간\(2026-07-21~2026-09-04\) 안 → 승인권자 그룹 CEO/);
  } finally { await cleanup(); }
});

// ── 마무리: 승인 요청 초안에 코드가 남지 않는다(양식·AI 입력·AI 출력) ──
const CODE_RE = /SKU-\d|PLAN-\d|POD-\d|\bPD-|CMT-|\bRJ-\d|\bCW-\d|APR-\d|GRP_CEO|MS_CEO|MKT_TEAM|\bR-0\d\b|\b[a-z]+_[a-z_]+\b/;
test('승인 요청 초안: 양식 문장은 캠페인·품목 이름과 한국어 조건 이름만 쓰고, AI 출력에 섞인 코드는 화면에 보이기 전에 바꾼다(수치는 그대로)', async () => {
  // 양식(AI 미연결): 발주안·조건부 공급 판정이 있는 기안
  const root = mkdtempSync(path.join(tmpdir(), 'w01-p3cd-'));
  symlinkSync(P3_DIR, path.join(root, 'problem3'), 'dir');
  mkdirSync(path.join(root, 'problem2', 'src'), { recursive: true });
  writeFileSync(path.join(root, 'problem2', 'src', 'index.mjs'), FAKE_P2_SC);
  let aiOut = null;
  const fetchImpl = async () => ({ ok: true, json: async () => ({ model: 'anthropic/claude-fable-5.2', choices: [{ message: { content: aiOut } }] }) });
  const mk = (env) => createApp({ rootDir: root, dbPath: ':memory:', env, fetchImpl, log: quiet });
  globalThis.__P3T_SC = [];
  const app = await mk({});
  try {
    await app.events.emit({ event_type: 'PO_DRAFT_CREATED', source_type: '계산', payload: { ...DRAFT_A, sku_id: 'SKU-2001' } }, 'p2');
    const port = await app.listen(0, '127.0.0.1');
    const { draft } = await (await fetch(`http://127.0.0.1:${port}/api/p3/draft`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ commitment_id: 'CMT-PLAN-001' }) })).json();
    assert.equal(draft.mode, '양식');
    assert.doesNotMatch(draft.text, CODE_RE);
    const plan = (await (await fetch(`http://127.0.0.1:${port}/api/plans`)).json()).plans.find((x) => x.plan_id === 'PLAN-001');
    assert.ok(draft.text.includes(`캠페인 ${plan.campaign_name}(${plan.product_line})`));
    assert.match(draft.text, /승인권자 그룹 CEO: 현금 잔액이 재무 약정상 최소 잔액/);
    assert.match(draft.text, /조건: 공급 확약 대기, 기준 수요 보충 미확인/);
    assert.match(draft.text, /보충 발주\([^)A-Z]+\): 발주 시한/);
  } finally { await app.close(); }
  // AI 연결: 입력에 코드가 없고, 출력에 섞인 코드는 업무 용어·이름으로 바뀐다
  const app2 = await mk({ OPENROUTER_API_KEY: 'x' });
  try {
    await app2.events.emit({ event_type: 'PO_DRAFT_CREATED', source_type: '계산', payload: { ...DRAFT_A, sku_id: 'SKU-2001' } }, 'p2');
    aiOut = 'CMT-PLAN-001의 contract_deadline은 2026-07-17이다. PD-A(SKU-2001)는 supply_commitment_pending이고 GRP_CEO 결재(R-01, RJ-000003, CW-001) 대상이다. 금액 201,600,000원.';
    const port = await app2.listen(0, '127.0.0.1');
    const { draft } = await (await fetch(`http://127.0.0.1:${port}/api/p3/draft`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ commitment_id: 'CMT-PLAN-001' }) })).json();
    assert.equal(draft.mode, 'AI');
    assert.doesNotMatch(draft.text, CODE_RE);
    const plan = (await (await fetch(`http://127.0.0.1:${port}/api/plans`)).json()).plans.find((x) => x.plan_id === 'PLAN-001');
    assert.ok(draft.text.startsWith(`${plan.campaign_name} 캠페인의 확정기한은 2026-07-17이다.`), draft.text);
    assert.match(draft.text, /공급 확약 대기이고 그룹 CEO 결재\('하회 예상 구간 안 유출' 기준\) 대상이다\. 금액 201,600,000원\./); // 수치는 그대로
    const ai = app2.events.query({ event_type: 'AI_CALL_RECORDED' }).at(-1);
    assert.match(ai.payload.output, /CMT-PLAN-001/); // 원문은 AI 호출 기록에 남는다
  } finally { await app2.close(); rmSync(root, { recursive: true, force: true }); globalThis.__P3T_SC = []; }
});
