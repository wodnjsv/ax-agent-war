// 문제 3 순수 계산을 원본 수치로 고정해 검증한다(명세 3.2 D3-01·S3-01).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRawLoader, parsePipeCsv } from '../../app/core/csv.mjs';
import { RAW_DIR } from '../../app/core/paths.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as C from '../src/calc.mjs';

const raw = createRawLoader(RAW_DIR);
const ar = raw.load('02_masil/financials/fin_ar_aging_ms.csv');
const ap = raw.load('02_masil/financials/fin_ap_aging_ms.csv');
const po = raw.load('02_masil/inventory/sc_purchase_orders_ms.csv');
const last = raw.load('02_masil/financials/fin_cash_daily_ms.csv').at(-1);
const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const data = (f) => parsePipeCsv(readFileSync(path.join(dataDir, f), 'utf8'));
const opening = Number(last.closing_balance);
const threshold = Number(last.covenant_min_krw);
const run = (variant, arOverrides = {}, extraOutflows = []) => C.findWindow(C.projectCash({
  opening_krw: opening, threshold_krw: threshold, variant, items: C.buildCashItems({ ar, ap, po, arOverrides, extraOutflows }),
}));

test('원본 기초 값: 06-30 종가, 30억 기준, 기발주 14건 37.5억, 기안 25건 180,803,272원', () => {
  assert.equal(last.date, '2026-06-30');
  assert.equal(opening, 5_148_063_540);
  assert.equal(threshold, 3_000_000_000);
  assert.equal(po.length, 14);
  assert.equal(C.sumKrw(po, 'amount_krw'), 3_749_760_000);
  assert.ok(po.every((r) => r.payment_due_date === '2026-07-21'));
  assert.equal(C.sumKrw(raw.load('02_masil/marketing/mkt_budget_plan_ms.csv'), 'requested_budget_krw'), 180_803_272);
});

test('기본 재전망(07-01 만기 제외): 07-21~08-21, 24영업일, 최저 1,785,991,965원(07-27)', () => {
  const w = run('base');
  assert.equal(w.shortfall_window_start, '2026-07-21');
  assert.equal(w.shortfall_window_end, '2026-08-21');
  assert.equal(w.shortfall_bd_count, 24);
  assert.equal(w.min_balance_krw, 1_785_991_965);
  assert.equal(w.min_date, '2026-07-27');
  assert.equal(w.next_outside_date, '2026-08-24');
});

test('민감도: 07-01 만기 포함 19.22억, 기준일 전 미결분 반영 16.48억, 구간은 같다', () => {
  const inc = run('incl_asof');
  const od = run('overdue_now');
  assert.equal(inc.min_balance_krw, 1_921_839_555);
  assert.equal(od.min_balance_krw, 1_647_835_595);
  for (const w of [inc, od]) assert.deepEqual([w.shortfall_window_start, w.shortfall_window_end, w.shortfall_bd_count], ['2026-07-21', '2026-08-21', 24]);
});

test('S-AR-DELAY: MAR-0004 회수 예정 08-30이면 구간이 08-28까지(29영업일), 구간 밖 첫날 08-31', () => {
  const w = run('base', { 'MAR-0004': '2026-08-30' });
  assert.equal(w.shortfall_window_end, '2026-08-28');
  assert.equal(w.shortfall_bd_count, 29);
  assert.equal(w.next_outside_date, '2026-08-31');
});

test('승인된 발주안 2.016억이 08-21에 나가면 08-24 잔액이 30억 아래로 남아 구간이 08-28까지 늘어난다', () => {
  const w = run('base', {}, [{ ref: 'PD-TEST', date: '2026-08-21', amount_krw: 201_600_000 }]);
  assert.equal(w.shortfall_window_end, '2026-08-28');
});

test('S3-01 결제 조건(월 마감 익월 21일)이 원본 AP 14건의 지급일을 모두 재현한다', () => {
  const [term] = data('s3_01_supplier_payment_terms.csv');
  const rows = ap.filter((r) => r.po_id !== 'NONE');
  assert.equal(rows.length, 14);
  for (const r of rows) assert.equal(C.paymentDueDate(r.invoice_date, term), r.payment_due_date);
  assert.equal(C.paymentDueDate('2026-07-22', term), '2026-08-21');
  assert.equal(C.paymentDueDate('2026-08-03', term), '2026-09-21');
  assert.equal(C.paymentDueDate('2026-10-05', term), '2026-11-23'); // 11-21(토) → 다음 영업일
});

test('합성 자료: 행마다 필수 메타 필드, 묶음 25건 PB-001, 결재 소요일 GRP 2·MS 2·MKT 1·SCM 1', () => {
  const files = ['s3_01_supplier_payment_terms.csv', 's3_02_plan_bundle.csv', 's3_03_approver_roles.csv', 's3_04_finance_reply.csv'];
  for (const f of files) {
    for (const r of data(f)) {
      for (const k of ['record_id', 'source_ref', 'effective_at', 'source_type', 'is_synthetic', 'generation_reason']) assert.ok(r[k], `${f} ${r.record_id} ${k}`);
      assert.equal(r.is_synthetic, 'true');
    }
  }
  const bundles = data('s3_02_plan_bundle.csv');
  assert.equal(bundles.length, 25);
  assert.ok(bundles.every((r) => r.plan_bundle_id === 'PB-001'));
  assert.deepEqual(Object.fromEntries(data('s3_03_approver_roles.csv').map((r) => [r.approver, Number(r.std_approval_bd)])), { GRP_CEO: 2, MS_CEO: 2, MKT_TEAM: 1, SCM: 1 });
  // 재무 회신의 회수 예정일은 원본 due_date와 어긋나지 않는다(기본) / 지연 회신은 7일 뒤
  const due = Object.fromEntries(ar.map((r) => [r.ar_id, r.due_date]));
  const fr = data('s3_04_finance_reply.csv');
  for (const r of fr.filter((x) => x.finance_reply_id === 'FR-001')) assert.equal(r.ar_expected_receipt_date, due[r.ar_id]);
  // 회수일 지연(재설계 L5): LC-0001(CH-03) 8월 회수분 MAR-0004·0005가 각 14일 늦게 들어온다
  const delay = fr.filter((x) => x.finance_reply_id === 'FR-002');
  assert.deepEqual(delay.map((x) => x.ar_id), ['MAR-0004', 'MAR-0005']);
  for (const r of delay) assert.equal(r.ar_expected_receipt_date, C.addDays(due[r.ar_id], 14));
  assert.equal(Number(fr[0].min_balance_ack_krw), run('base').min_balance_krw);
});

test('회수일 지연 재설계(L5): MAR-0004·0005 각 14일 지연이면 구간이 09-04까지(34영업일) 늘고 PLAN-003의 이동 집행일 08-31도 구간 안', () => {
  const w = run('base', { 'MAR-0004': '2026-09-06', 'MAR-0005': '2026-09-13' });
  assert.deepEqual([w.shortfall_window_start, w.shortfall_window_end, w.shortfall_bd_count, w.next_outside_date], ['2026-07-21', '2026-09-04', 34, '2026-09-07']);
  assert.equal(C.inWindow('2026-08-31', w.segments), true);
  // 종전 설계(MAR-0004만 7일)는 기본과 같은 결과가 되기 쉬웠다: 발주안 지급이 있으면 기본도 08-28까지라 차이가 없다
  const draft = [{ ref: 'PD', date: '2026-08-21', amount_krw: 201_600_000 }];
  assert.equal(run('base', { 'MAR-0004': '2026-08-30' }, draft).shortfall_window_end, run('base', {}, draft).shortfall_window_end);
  assert.equal(run('base', { 'MAR-0004': '2026-09-06', 'MAR-0005': '2026-09-13' }, draft).shortfall_window_end, '2026-09-04');
});

test('승인 기준일과 경로 규칙', () => {
  assert.deepEqual(C.anchorFor({ commitment_type: '기안', settlement_date: '2026-08-06', contract_deadline: '2026-07-17' }), { approval_anchor_date: '2026-07-17', anchor_basis: 'contract_deadline' });
  assert.deepEqual(C.anchorFor({ commitment_type: '기안', settlement_date: '2026-07-21', contract_deadline: '2026-09-11' }), { approval_anchor_date: '2026-07-21', anchor_basis: 'settlement_date' });
  assert.deepEqual(C.anchorFor({ commitment_type: '발주안', planned_order_date: '2026-07-22' }), { approval_anchor_date: '2026-07-22', anchor_basis: 'planned_order_date' });
  const seg = [{ start: '2026-07-21', end: '2026-08-21' }];
  assert.equal(C.judgeRoute({ commitment_type: '기안', is_new_commitment: true, cash_outflow_date: '2026-08-06', amount_krw: 16_801_646 }, seg, 180_803_272).approver, 'GRP_CEO');
  assert.equal(C.judgeRoute({ commitment_type: '기안', is_new_commitment: true, cash_outflow_date: '2026-08-24', amount_krw: 2_476_699 }, seg, 180_803_272).route_rule_id, 'R-02');
  assert.equal(C.judgeRoute({ commitment_type: '기안', is_new_commitment: true, cash_outflow_date: '2026-08-24', amount_krw: 2_476_699 }, seg, 90_000_000).route_rule_id, 'R-03');
  assert.equal(C.judgeRoute({ commitment_type: '발주안', is_new_commitment: true, cash_outflow_date: '2026-09-21', amount_krw: 1 }, seg, 0).approver, 'SCM');
  assert.equal(C.judgeRoute({ commitment_type: '기발주', is_new_commitment: false, cash_outflow_date: '2026-07-21', amount_krw: 1 }, seg, 0).route_rule_id, 'R-00');
  // 주말 유출일은 다음 영업일로 대조한다: 08-23(일) → 08-24, 구간 밖
  assert.equal(C.inWindow('2026-08-23', seg), false);
});

test('조각마다 시작·끝·영업일·최저 잔액을 남기고, 재전망 마지막 날에 끝나면 end_at_horizon', () => {
  const w = run('base', {}, [{ ref: 'PD-SEP', date: '2026-09-21', amount_krw: 3_300_000_000 }]);
  assert.equal(w.segments.length, 2);
  assert.deepEqual([w.segments[0].start, w.segments[0].end, w.segments[0].bd, w.segments[0].min_balance_krw, w.segments[0].min_date, w.segments[0].end_at_horizon], ['2026-07-21', '2026-08-21', 24, 1_785_991_965, '2026-07-27', false]);
  assert.deepEqual([w.segments[1].start, w.segments[1].end, w.segments[1].end_at_horizon], ['2026-09-21', '2026-09-30', true]);
  assert.equal(C.segmentOf('2026-09-20', w.segments).start, '2026-09-21'); // 일요일 → 다음 영업일 09-21
  assert.equal(C.segmentOf('2026-09-01', w.segments), null);
  assert.deepEqual(C.segmentView(w.segments[1], 1).segment_no, 2);
});
