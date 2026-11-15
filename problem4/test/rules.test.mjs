import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cal from '../../app/core/calendar.mjs';
import { computeDeadlines, decideConfirmability, supplyReviewOutcome, salePeriodsOverlap } from '../src/rules.mjs';

const OFF = { judgment: -1, demand_input: -2 };
const dl = (anchor, std = 2, type = '기안', today = '2026-07-01') =>
  computeDeadlines(cal, { approval_anchor_date: anchor, std_approval_bd: std, commitment_type: type }, OFF, today);

test('마감 산식: 명세 3.2 표의 13개 기준일을 그대로 재현한다', () => {
  // [기준일, 수요 입력, 판정, 상신, 1차 회신, 대안 선택, 최종 회신] — problem4/명세.md 3.2
  const table = [
    ['2026-07-17', '07-07', '07-08', '07-09', '07-13', '07-14', '07-16'],
    ['2026-07-20', '07-08', '07-09', '07-10', '07-14', '07-15', '07-17'],
    ['2026-07-21', '07-09', '07-10', '07-13', '07-15', '07-16', '07-20'],
    ['2026-07-28', '07-16', '07-17', '07-20', '07-22', '07-23', '07-27'],
    ['2026-07-30', '07-20', '07-21', '07-22', '07-24', '07-27', '07-29'],
    ['2026-08-03', '07-22', '07-23', '07-24', '07-28', '07-29', '07-31'],
    ['2026-08-10', '07-29', '07-30', '07-31', '08-04', '08-05', '08-07'],
    ['2026-08-12', '07-31', '08-03', '08-04', '08-06', '08-07', '08-11'],
    ['2026-08-14', '08-04', '08-05', '08-06', '08-10', '08-11', '08-13'],
    ['2026-08-24', '08-12', '08-13', '08-14', '08-18', '08-19', '08-21'],
    ['2026-09-01', '08-20', '08-21', '08-24', '08-26', '08-27', '08-31'],
    ['2026-09-03', '08-24', '08-25', '08-26', '08-28', '08-31', '09-02'],
    ['2026-09-11', '09-01', '09-02', '09-03', '09-07', '09-08', '09-10'],
  ];
  for (const [anchor, ...exp] of table) {
    const d = dl(anchor);
    const got = [d.demand_input_due, d.judgment_due, d.submission_due, d.first_reply_due, d.alt_selection_due, d.final_reply_due].map((x) => x.slice(5));
    assert.deepEqual(got, exp, anchor);
    assert.equal(d.computed_status, '정상');
  }
});

test('발주안 마감: 선택 07-13 → 발주 예정일 07-22(GRP_CEO), 수요 입력 마감 없음', () => {
  const d = dl('2026-07-22', 2, '발주안', '2026-07-13');
  assert.equal(d.demand_input_due, null);
  assert.deepEqual([d.judgment_due, d.submission_due, d.first_reply_due, d.alt_selection_due, d.final_reply_due],
    ['2026-07-13', '2026-07-14', '2026-07-16', '2026-07-17', '2026-07-21']);
  assert.equal(d.computed_status, '정상');
  assert.equal(dl('2026-07-22', 1, '발주안').submission_due, '2026-07-16'); // SCM
});

test('마감 경과 상태로 산출: 07-10에 기준일 07-17을 다시 산출하면 상신 마감 07-09가 이미 지났다', () => {
  assert.equal(dl('2026-07-17', 2, '기안', '2026-07-10').computed_status, '마감 경과 상태로 산출');
  assert.equal(dl(null), null);
});

const S = (v, ver = 1) => ({ supply_judgment_id: 'SJ-1', supply_judgment_version: ver, supply_verdict: v });
const base = { plan_status: '검토 중', connected: { p2: true, p3: true } };

test('확정 가능 규칙(4.5)', () => {
  const st = (x) => decideConfirmability({ ...base, ...x }).plan_confirmability;
  assert.equal(st({ supply: S('가능'), approval: { approval_status: '승인' } }), '확정 가능');
  assert.equal(st({ supply: S('판정불가'), approval: { approval_status: '승인' } }), '미확인');
  assert.equal(st({ supply: S('가능'), approval: { approval_status: '결재 대기' } }), '미확인');
  assert.equal(st({ supply: S('부족'), approval: { approval_status: '승인' } }), '불가');
  assert.equal(st({ supply: S('가능'), approval: { approval_status: '거절' } }), '불가');
  assert.equal(st({ supply: S('가능'), approval: { approval_status: '승인' }, openReviewIds: ['RV-1'] }), '미확인');
  assert.equal(st({ supply: S('가능'), approval: { approval_status: '승인' }, holdIds: ['HD-1'] }), '미확인');
  assert.equal(st({ plan_status: '확정' }), '확정');
  assert.equal(st({ supply: S('가능'), approval: { approval_status: '승인' }, connected: { p2: false, p3: true } }), '미확인');
  // 조건부 판정(사용자 요청 2026-11-15 다·마): 승인·조건 수용으로는 확정 가능이 되지 않는다. 승인권자의 '공급 위험 수용'이면 따로 표시
  assert.equal(st({ supply: S('조건부'), approval: { approval_status: '승인' } }), '조건부 대기');
  const oldAccept = { conditions: [{ condition_type: '공급조건부수용', ref_id: 'SJ-1' }], supply_judgment_version_at_reply: 1 };
  assert.equal(st({ supply: S('조건부'), approval: { approval_status: '조건부' }, reply: oldAccept }), '조건부 대기'); // 예전 조건 수용만으로는 안 된다
  assert.equal(st({ supply: S('조건부'), approval: { approval_status: '승인' }, risk: { accepted_condition_types: ['inbound_unconfirmed'] } }), '위험 수용 확정 가능');
  // 조건부 승인: 수요·공급 확인 후(PLAN-005)
  const r005 = { conditions: [{ condition_type: '수요·공급 확인 후', ref_id: 'PLAN-005' }] };
  assert.equal(st({ supply: S('판정불가'), approval: { approval_status: '조건부' }, reply: r005 }), '미확인');
  assert.equal(st({ supply: S('가능'), approval: { approval_status: '조건부' }, reply: r005 }), '확정 가능');
  const other = { conditions: [{ condition_type: '기타', text: '…' }] };
  assert.equal(st({ supply: S('가능'), approval: { approval_status: '조건부' }, reply: other }), '조건부 대기');
  assert.equal(st({ supply: S('가능'), approval: { approval_status: '조건부' }, reply: other, humanConditionOk: true }), '확정 가능');
});

test('재검토 종결과 판매 기간 겹침', () => {
  assert.equal(supplyReviewOutcome({ supply_verdict: '가능' }, { supply_verdict: '가능' }), '유지');
  assert.equal(supplyReviewOutcome({ supply_verdict: '가능' }, { supply_verdict: '부족', first_shortage_week: '2026-08-03' }), '변경');
  assert.equal(supplyReviewOutcome({ supply_verdict: '부족', first_shortage_week: '2026-08-03' }, { supply_verdict: '부족', first_shortage_week: '2026-08-10' }), '변경');
  assert.equal(salePeriodsOverlap(cal, { sale_start_week: '2026-07-20', sale_weeks: 2 }, { sale_start_week: '2026-07-27', sale_weeks: 1 }), true);
  assert.equal(salePeriodsOverlap(cal, { sale_start_week: '2026-07-20', sale_weeks: 1 }, { sale_start_week: '2026-07-27', sale_weeks: 1 }), false);
});

test('조건부(사용자 요청 2026-11-15): 보충 발주안 승인 ≠ 공급 확약. 공급 미확약 조건은 Corevia·SCM 회신으로만 풀리고, 위험 수용은 따로 표시', () => {
  const sup = { ...S('조건부'), condition_basis: [{ condition_type: 'reorder_required', po_draft_id: 'PO-1', sku_id: 'SKU-2001', required_qty: 16000 }] };
  const st = (x) => decideConfirmability({ ...base, supply: sup, approval: { approval_status: '승인' }, ...x });
  assert.match(st({ reorder: { pendingPoIds: ['PO-1'] } }).confirmability_basis.reason, /reorder_required.*PO-1/);
  assert.equal(st({ reorder: { pendingPoIds: ['PO-1'] } }).plan_confirmability, '조건부 대기');
  // (a) 발주안이 내부 승인돼도 Corevia 확약 전이면 확정 가능이 아니다
  const approved = st({ reorder: { pendingPoIds: [] } });
  assert.equal(approved.plan_confirmability, '조건부 대기');
  assert.match(approved.confirmability_basis.reason, /공급 확약 대기: Corevia 공급 확약 대기/);
  // 보충 발주안이 거절되면 문제 2 재판정 전에도 불가
  const rej = st({ reorder: { pendingPoIds: [], rejectedPoIds: ['PO-1'] } });
  assert.equal(rej.plan_confirmability, '불가');
  assert.match(rej.confirmability_basis.reason, /보충 발주안 거절: PO-1/);
  // 공급 확약 대기·기준 수요 보충 미확인: 위험 수용이 그 조건을 모두 덮어야 '위험 수용 확정 가능'
  const pend = { ...S('조건부'), condition_basis: [{ condition_type: 'supply_commitment_pending', sku_id: 'SKU-2001' }, { condition_type: 'baseline_replenishment_unconfirmed', sku_id: 'SKU-4002' }] };
  const st2 = (x) => decideConfirmability({ ...base, supply: pend, approval: { approval_status: '승인' }, ...x });
  assert.equal(st2({}).plan_confirmability, '조건부 대기');
  assert.match(st2({}).confirmability_basis.reason, /Corevia 공급 확약 대기, SCM 기준 수요 보충 미확인/);
  assert.equal(st2({ risk: { accepted_condition_types: ['supply_commitment_pending'] } }).plan_confirmability, '조건부 대기'); // 일부만 수용
  const ok = st2({ risk: { accepted_condition_types: ['supply_commitment_pending', 'baseline_replenishment_unconfirmed'] } });
  assert.equal(ok.plan_confirmability, '위험 수용 확정 가능');
  assert.match(ok.confirmability_basis.reason, /공급 판정은 조건부로 남는다/);
});
