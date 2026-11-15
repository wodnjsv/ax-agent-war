// 원본 도출·계산·검증 함수. 원본 수치는 명세 3.1·3.2에 인용한 값으로 고정한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRawLoader, parsePipeCsv } from '../../app/core/csv.mjs';
import { RAW_DIR } from '../../app/core/paths.mjs';
import {
  derivePlanSkuMap, deriveBaselineDemand, deriveReferenceMetrics, addedQtyEa, computeDemandWeekly,
  validateDemandFields, parseS1, parseS2, RAW, S1_COLUMNS, S2_COLUMNS,
} from '../src/demand.mjs';
import { derivedCsvTexts } from '../src/export-data.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const P1 = path.resolve(HERE, '..');
const raw = createRawLoader(RAW_DIR);

test('원본: 기안 25건, 요청 총액 180,803,272원, 확정기한별 건수', () => {
  const plans = raw.load(RAW.plans);
  assert.equal(plans.length, 25);
  assert.equal(plans.reduce((a, p) => a + Number(p.requested_budget_krw), 0), 180_803_272);
  const by = {};
  for (const p of plans) by[p.contract_deadline] = (by[p.contract_deadline] ?? 0) + 1;
  assert.deepEqual(by, { '2026-07-17': 5, '2026-08-14': 12, '2026-09-11': 8 });
});

test('plan_sku_map: 69행, 제품라인별 SKU 수, 표본 주문과 분류 불일치 0건', () => {
  const map = derivePlanSkuMap(raw);
  assert.equal(map.length, 69);
  const perPlan = (id) => map.filter((r) => r.plan_id === id).map((r) => r.sku_id);
  assert.deepEqual(perPlan('PLAN-002'), ['SKU-3001', 'SKU-3002', 'SKU-3003']);
  assert.deepEqual(perPlan('PLAN-011'), ['SKU-1001', 'SKU-1002', 'SKU-1003', 'SKU-1004']);
  assert.deepEqual(perPlan('PLAN-005'), ['SKU-4001', 'SKU-4002']);
  assert.ok(map.every((r) => r.source_type === '원본도출'));
  const campLine = new Map(raw.load(RAW.campaigns).map((c) => [c.campaign_id, c.product_line]));
  const skuCat = new Map(raw.load(RAW.skus).map((s) => [s.sku_id, s.category]));
  const orders = raw.load(RAW.orders);
  assert.equal(orders.length, 15_650);
  assert.equal(orders.filter((o) => campLine.get(o.campaign_id) !== skuCat.get(o.sku_id)).length, 0);
});

test('baseline_demand: 최근 4주(06-08~06-29) 평균, 명세 3.2 값', () => {
  const b = new Map(deriveBaselineDemand(raw).map((r) => [r.sku_id, r]));
  assert.equal(b.size, 14);
  assert.equal(b.get('SKU-1001').baseline_weekly_qty, 7910.5);
  assert.equal(b.get('SKU-3001').baseline_weekly_qty, 882.5);
  assert.equal(b.get('SKU-3002').baseline_weekly_qty, 869.25);
  assert.equal(b.get('SKU-3003').baseline_weekly_qty, 4279.75);
  assert.equal(b.get('SKU-5002').baseline_weekly_qty, 3503.75);
  assert.equal(b.get('SKU-1001').window_start, '2026-06-08');
  assert.equal(b.get('SKU-1001').window_end, '2026-06-29');
  assert.equal(b.get('SKU-1001').baseline_demand_version, 'BD-2026-06-29');
});

test('참고 지표: 기안 배수 3종, 명목 ROAS 1.22~7.65, PLAN-002 1.58·1,133건, 더마 표본 얇음 600건', () => {
  const m = deriveReferenceMetrics(raw);
  assert.deepEqual([...new Set([...m.values()].map((x) => x.plan_multiplier))].sort(), [10.42, 11.25, 9.17]);
  const roas = [...m.values()].map((x) => x.nominal_roas);
  assert.equal(Math.min(...roas), 1.22);
  assert.equal(Math.max(...roas), 7.65);
  assert.equal(m.get('PLAN-002').nominal_roas, 1.58);
  assert.equal(m.get('PLAN-002').sample_orders, 1133);
  assert.equal(m.get('PLAN-011').sample_orders, 600);
  assert.equal(m.get('PLAN-011').thin_sample, true);
  assert.equal(m.get('PLAN-002').thin_sample, false);
  const shape = Object.values(m.get('PLAN-002').sku_sales_max_over_median);
  assert.ok(shape.every((v) => v >= 1.18 && v <= 1.3));
});

test('추가 수량: 0.5 올림 정수, override 우선, 주차 전개', () => {
  assert.equal(addedQtyEa(882.5, 20), 177);      // 176.5
  assert.equal(addedQtyEa(869.25, 20), 174);     // 173.85
  assert.equal(addedQtyEa(4279.75, 20), 856);    // 855.95
  assert.equal(addedQtyEa(882.5, 35), 309);      // 308.875
  assert.equal(addedQtyEa(4279.75, 12.5), 535);  // 534.96875
  assert.equal(addedQtyEa(869.25, 25), 217);     // 217.3125
  assert.equal(addedQtyEa(7910.5, 0), 0);
  const baselineBySku = new Map(deriveBaselineDemand(raw).map((r) => [r.sku_id, r]));
  const rows = computeDemandWeekly({ plan_id: 'PLAN-014', sku_ids: ['SKU-3001', 'SKU-3002', 'SKU-3003'], baselineBySku,
    uplift_pct: 25, overrides: [{ sku_id: 'SKU-3003', override_uplift_pct: 5 }], sale_start_week: '2026-07-27', sale_weeks: 3 });
  assert.equal(rows.length, 9);
  assert.deepEqual([...new Set(rows.map((r) => r.week_start))], ['2026-07-27', '2026-08-03', '2026-08-10']);
  assert.equal(rows.find((r) => r.sku_id === 'SKU-3003').added_qty_ea, 214); // 213.9875
  assert.equal(rows.find((r) => r.sku_id === 'SKU-3003').applied_uplift_pct, 5);
  assert.ok(rows.every((r) => r.is_simulation === true && r.source_type === '계산'));
});

test('검증: 월요일·시작 주·종료 상한(12-28)·SKU 범위·소수 자리', () => {
  const ok = { uplift_pct: 20, sale_start_week: '2026-07-20', sale_weeks: 4, overrides: [], submitted_by: 'MKT-LINE-OWNER', basis_as_of: '2026-07-01' };
  const opt = { skuIds: ['SKU-3001', 'SKU-3002', 'SKU-3003'], today: '2026-07-07', names: new Map([['SKU-1001', '더마 리페어 세럼']]) };
  assert.deepEqual(validateDemandFields(ok, opt), []);
  const bad = (patch) => validateDemandFields({ ...ok, ...patch }, opt);
  assert.match(bad({ sale_start_week: '2026-08-05' }).join(), /월요일/);
  assert.match(bad({ sale_start_week: '2026-06-29' }).join(), /2026-07-06 주 이후/);
  assert.match(bad({ sale_start_week: '2026-12-21', sale_weeks: 3 }).join(), /전망 마지막 주 2026-12-28/);
  assert.deepEqual(bad({ sale_start_week: '2026-12-21', sale_weeks: 2 }), []); // 종료 주 12-28 = 상한
  assert.deepEqual(bad({ sale_start_week: '2026-12-28', sale_weeks: 1 }), []);
  assert.match(bad({ uplift_pct: -1 }).join(), /0 이상/);
  assert.match(bad({ uplift_pct: 12.34 }).join(), /소수 첫째/);
  assert.match(bad({ uplift_pct: null }).join(), /없습니다/);
  assert.match(bad({ sale_weeks: 0 }).join(), /1 이상의 정수/);
  assert.match(bad({ overrides: [{ sku_id: 'SKU-1001', override_uplift_pct: 5 }] }).join(), /더마 리페어 세럼은\(는\) 이 기안의 품목이 아닙니다/);
  assert.match(bad({ basis_as_of: '2026-07-08' }).join(), /확인일보다/);
});

test('도출 CSV 파일이 원본 도출 결과와 같다(export-data.mjs)', () => {
  for (const [file, text] of Object.entries(derivedCsvTexts(raw))) {
    assert.equal(readFileSync(path.join(P1, 'data', file), 'utf8'), text, file);
    const rows = parsePipeCsv(text);
    for (const r of rows) for (const c of ['record_id', 'source_ref', 'effective_at', 'source_type', 'is_synthetic', 'generation_reason']) assert.ok(r[c], `${file} ${c}`);
  }
});

test('모의 회신 자료(S1·S2): 기안 25건 중 PLAN-005 미등록, PLAN-011 지연, PLAN-014 정정, 나머지 기한 내', () => {
  const read = (f) => readFileSync(path.join(P1, 'data', 'synthetic', f), 'utf8');
  assert.deepEqual(read('s1_demand_reply.csv').split('\n')[0].split('|'), [...S1_COLUMNS]);
  assert.deepEqual(read('s2_sku_override.csv').split('\n')[0].split('|'), [...S2_COLUMNS]);
  const planIds = new Set(raw.load(RAW.plans).map((p) => p.plan_id));
  const real = parseS1(parsePipeCsv(read('s1_demand_reply.csv')), planIds);
  assert.equal(real.length, 25);
  assert.equal(new Set(real.map((r) => r.plan_id)).size, 24);
  assert.ok(!real.some((r) => r.plan_id === 'PLAN-005'));
  const pat = (id) => real.filter((r) => r.plan_id === id).map((r) => `${r.reply_pattern}@${r.effective_at}`);
  assert.deepEqual(pat('PLAN-011'), ['late@2026-08-05']);
  assert.deepEqual(pat('PLAN-014'), ['on_time@2026-07-08', 'revised@2026-07-13']);
  assert.equal(real.filter((r) => r.reply_pattern === 'on_time').length, 23);
  const skuIdsOf = (id) => derivePlanSkuMap(raw).filter((m) => m.plan_id === id).map((m) => m.sku_id);
  const realS2 = parseS2(parsePipeCsv(read('s2_sku_override.csv')), new Map(real.map((r) => [r.record_id, r])));
  for (const r of real) {
    const overrides = realS2.filter((o) => o.reply_record_id === r.record_id);
    const f = { uplift_pct: r.confirmed_uplift_pct, sale_start_week: r.confirmed_sale_start_week, sale_weeks: r.confirmed_sale_weeks,
      overrides, submitted_by: r.submitted_by, basis_as_of: r.basis_as_of };
    assert.deepEqual(validateDemandFields(f, { skuIds: skuIdsOf(r.plan_id), today: r.effective_at }), [], r.record_id);
    assert.ok(r.generation_reason && r.source_ref && r.effective_at, r.record_id);
    assert.doesNotMatch(r.reply_text, /지난|작년|전년|과거 실적/, `${r.record_id}: 과거 실적 수치를 쓰지 않는다`);
  }
  const s1 = parseS1(parsePipeCsv(readFileSync(path.join(HERE, 'fixtures', 's1_demand_reply.csv'), 'utf8')), planIds);
  assert.equal(s1.length, 5);
  assert.equal(s1.find((r) => r.record_id === 'T-S1-005').confirmed_uplift_pct, null); // NONE ≠ 0
  const s2 = parseS2(parsePipeCsv(readFileSync(path.join(HERE, 'fixtures', 's2_sku_override.csv'), 'utf8')), new Map(s1.map((r) => [r.record_id, r])));
  assert.equal(s2[0].override_uplift_pct, 5);
  assert.throws(() => parseS1([{ ...s1[0], plan_id: 'PLAN-999', reply_seq: '1', is_synthetic: 'true' }], planIds), /원본에 없는 기안/);
});

test('화면 문장: 반려 사유와 AI 문장에 필드 코드·품목 코드가 남지 않는다', async () => {
  const { humanize } = await import('../src/demand.mjs');
  const names = new Map([['SKU-3001', '색조 벨벳 립'], ['SKU-3003', '색조 아이팔레트']]);
  assert.equal(humanize('uplift_pct가 불명확, SKU-3003의 SKU별 값 없음, sale_weeks 비움', names), '증가율가 불명확, 색조 아이팔레트의 품목별 값 없음, 판매 주수 비움');
  const errs = validateDemandFields({ uplift_pct: null, sale_start_week: '2026-07-22', sale_weeks: 0, overrides: [{ sku_id: 'SKU-9999', override_uplift_pct: 1 }],
    submitted_by: 'x', basis_as_of: '2026-07-01' }, { skuIds: ['SKU-3001'], names, today: '2026-07-07' }).join(' ');
  assert.doesNotMatch(errs, /uplift_pct|sale_start_week|sale_weeks|override|projection|SKU별/);
});
