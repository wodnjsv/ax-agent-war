// 테스트 전용: 임시 루트에 실제 problem2를 연결하고, 문제 1 자리에 최소 대역(stub)을 둔다.
// 대역은 문제 1 명세 9절의 함수 이름만 흉내 낸다. 실제 문제 1 구현과 무관하다.
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../app/main.mjs';

const P2_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const quiet = { log() {}, error() {} };

const P1_STUB = `
export function register(ctx) {
  const num = ctx.toNum;
  const sales = ctx.raw.load('02_masil/inventory/sku_weekly_sales_ms.csv');
  const last4 = [...new Set(sales.map((r) => r.week))].sort().slice(-4);
  const baseline = new Map();
  for (const r of sales) if (last4.includes(r.week)) baseline.set(r.sku_id, (baseline.get(r.sku_id) ?? 0) + num(r.sold_qty) / 4);
  const skus = ctx.raw.load('02_masil/master/m_sku_ms.csv');
  const map = ctx.plans().flatMap((p) => skus.filter((s) => s.category === p.product_line).map((s) => ({
    plan_id: p.plan_id, campaign_id: p.campaign_id, product_line: p.product_line, sku_id: s.sku_id, source_type: '원본도출', source_ref: 'stub' })));
  const inputs = new Map();
  const addDays = ctx.cal.addDays;
  const weekly = (planId, inp, overrides = []) => map.filter((m) => m.plan_id === planId).flatMap((m) => {
    const ov = overrides.find((o) => o.sku_id === m.sku_id);
    const u = ov ? ov.override_uplift_pct : inp.uplift_pct;
    const add = Math.floor(baseline.get(m.sku_id) * u / 100 + 0.5);
    return Array.from({ length: inp.sale_weeks }, (_, k) => ({ demand_input_id: inp.demand_input_id ?? null, version: inp.version ?? null,
      plan_id: planId, sku_id: m.sku_id, week_start: addDays(inp.sale_start_week, 7 * k), baseline_weekly_qty: baseline.get(m.sku_id),
      applied_uplift_pct: u, added_qty_ea: add, source_type: '계산', is_simulation: true }));
  });
  ctx.expose({
    baselineDemand(sku) {
      const all = [...baseline].map(([sku_id, q]) => ({ sku_id, baseline_weekly_qty: Math.round(q * 100) / 100, baseline_demand_version: 'BD-stub-v1',
        method: '최근4주평균', source_type: '계산' }));
      return sku ? all.find((b) => b.sku_id === sku) ?? null : all;
    },
    planSkuMap: ({ plan_id, sku_id } = {}) => map.filter((m) => (!plan_id || m.plan_id === plan_id) && (!sku_id || m.sku_id === sku_id)),
    demandInput: (planId) => inputs.get(planId) ?? null,
    campaignDemandWeekly: ({ plan_id } = {}) => [...inputs.values()].filter((i) => !plan_id || i.plan_id === plan_id)
      .flatMap((i) => weekly(i.plan_id, i, i.overrides)),
    skuOverrides: () => [],
    previewAddedQty: (input) => weekly(input.plan_id, input, input.override_uplift_pct ?? []),
    async __register(planId, inp) {
      const v = (inputs.get(planId)?.version ?? 0) + 1;
      inputs.set(planId, { demand_input_id: 'DI-' + planId, plan_id: planId, version: v, version_status: '유효', source_type: '모의회신', is_synthetic: true, ...inp });
      await ctx.events.emit({ event_type: v === 1 ? 'DEMAND_INPUT_REGISTERED' : 'DEMAND_INPUT_REVISED', source_type: '사람입력', is_synthetic: true,
        plan_id: planId, payload: { demand_input_id: 'DI-' + planId, version: v } });
    },
  });
  ctx.onInit(() => ctx.events.emit({ event_type: 'BASELINE_DEMAND_SET', source_type: '계산', payload: { baseline_demand_version: 'BD-stub-v1' } }));
}`;

// withP1: 문제 1 대역을 둘지. extra: { 'problem3/src/index.mjs': '...' } 같은 추가 대역
export async function makeApp({ withP1 = true, extra = {}, env = {}, fetchImpl } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'w01-p2-'));
  symlinkSync(P2_DIR, path.join(root, 'problem2'), 'dir');
  if (withP1) {
    mkdirSync(path.join(root, 'problem1', 'src'), { recursive: true });
    writeFileSync(path.join(root, 'problem1', 'src', 'index.mjs'), P1_STUB);
  }
  for (const [rel, code] of Object.entries(extra)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), code);
  }
  const app = await createApp({ rootDir: root, dbPath: ':memory:', env, fetchImpl, log: quiet });
  const close = async () => { await app.close(); rmSync(root, { recursive: true, force: true }); };
  return { app, p2: app.module('p2'), p1: app.module('p1'), close };
}

export const pick = (rows, f) => rows.find((r) => Object.entries(f).every(([k, v]) => r[k] === v));
