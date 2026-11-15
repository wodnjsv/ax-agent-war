// 문제 1 계산 함수(순수 함수). 같은 입력이면 같은 결과를 낸다.
// 이름은 problem4/공통_접점.md 3.1, 규칙은 problem1/명세.md 3.2·4.2·4.3.

export const RAW = {
  plans: '02_masil/marketing/mkt_budget_plan_ms.csv',
  campaigns: '02_masil/master/m_campaign_ms.csv',
  skus: '02_masil/master/m_sku_ms.csv',
  weeklySales: '02_masil/inventory/sku_weekly_sales_ms.csv',
  orders: '02_masil/marketing/mkt_orders_ms.csv',
  adSpend: '02_masil/marketing/mkt_ad_spend_ms.csv',
};

// 사전 2절의 주 격자. 문제 2 grid()가 없을 때만 쓰는 기본값이다.
export const GRID_DEFAULT = Object.freeze({
  first_week_start: '2026-07-06', horizon_end_week: '2026-09-28', projection_end_week: '2026-12-28',
});
export const EFFECTIVE_FROM = '2026-07-01'; // 가상기업 기준일
export const DEMAND_ALT_TYPES = Object.freeze(['시기이동', '물량상한', '구성이동']);
const DAY_MS = 86400000;

const num = (v) => {
  const n = Number(v);
  if (v === '' || v === null || v === undefined || v === 'NONE' || Number.isNaN(n)) return null;
  return n;
};
export const addWeeks = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 7 * DAY_MS).toISOString().slice(0, 10);
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const isMonday = (s) => new Date(`${s}T00:00:00Z`).getUTCDay() === 1;
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round2 = (x) => Math.round(x * 100) / 100;

// ── 원본 도출 ──

// plan_sku_map: 기안 → 캠페인 → product_line = m_sku_ms.category → sku_id
export function derivePlanSkuMap(raw) {
  const campaigns = new Map(raw.load(RAW.campaigns).map((c) => [c.campaign_id, c]));
  const skus = raw.load(RAW.skus);
  const rows = [];
  for (const p of raw.load(RAW.plans)) {
    const c = campaigns.get(p.campaign_id);
    if (!c) throw new Error(`캠페인이 없습니다: ${p.campaign_id}`);
    for (const s of skus.filter((x) => x.category === c.product_line)) {
      rows.push({
        plan_id: p.plan_id, campaign_id: p.campaign_id, product_line: c.product_line, sku_id: s.sku_id,
        source_type: '원본도출',
        source_ref: `${RAW.plans}#${p.plan_id};${RAW.campaigns}#${p.campaign_id};${RAW.skus}#${s.sku_id}`,
      });
    }
  }
  return rows;
}

// baseline_demand: SKU별 최근 4주 평균 주간판매량(calculation_definitions 1.3)
export function deriveBaselineDemand(raw) {
  const sales = raw.load(RAW.weeklySales);
  const weeks = [...new Set(sales.map((r) => r.week))].sort();
  const last4 = weeks.slice(-4);
  const windowStart = last4[0];
  const windowEnd = last4[3];
  const version = `BD-${windowEnd}`;
  return raw.load(RAW.skus).map((s) => {
    const rows = sales.filter((r) => r.sku_id === s.sku_id && last4.includes(r.week));
    if (rows.length !== 4) throw new Error(`${s.sku_id}의 최근 4주 판매가 4행이 아닙니다`);
    return {
      sku_id: s.sku_id,
      baseline_weekly_qty: round2(rows.reduce((a, r) => a + num(r.sold_qty), 0) / 4),
      baseline_demand_version: version, method: '최근4주평균',
      window_start: windowStart, window_end: windowEnd, effective_at: EFFECTIVE_FROM,
      source_ref: `${RAW.weeklySales}#${s.sku_id}@${windowStart}~${windowEnd}`, source_type: '계산',
    };
  });
}

// 요청 화면의 참고 지표(문제 1 내부). 승인 근거로 넘기지 않는다.
export function deriveReferenceMetrics(raw) {
  const campaigns = new Map(raw.load(RAW.campaigns).map((c) => [c.campaign_id, c]));
  const orders = raw.load(RAW.orders);
  const byCampaign = new Map();
  for (const o of orders) {
    const c = byCampaign.get(o.campaign_id) ?? { orders: 0, gmv: 0, sku: new Map() };
    c.orders += 1;
    c.gmv += num(o.gmv_krw);
    c.sku.set(o.sku_id, (c.sku.get(o.sku_id) ?? 0) + 1);
    byCampaign.set(o.campaign_id, c);
  }
  const spend = new Map();
  for (const a of raw.load(RAW.adSpend)) spend.set(a.campaign_id, (spend.get(a.campaign_id) ?? 0) + num(a.ad_cost_krw));
  const lineCampaigns = new Map();
  for (const cid of byCampaign.keys()) {
    const line = campaigns.get(cid)?.product_line;
    lineCampaigns.set(line, (lineCampaigns.get(line) ?? 0) + 1);
  }
  const sales = raw.load(RAW.weeklySales);
  const skuShape = new Map();
  for (const s of raw.load(RAW.skus)) {
    const q = sales.filter((r) => r.sku_id === s.sku_id).map((r) => num(r.sold_qty));
    skuShape.set(s.sku_id, round2(Math.max(...q) / median(q)));
  }
  const out = new Map();
  for (const p of raw.load(RAW.plans)) {
    const line = campaigns.get(p.campaign_id)?.product_line;
    const c = byCampaign.get(p.campaign_id) ?? { orders: 0, gmv: 0, sku: new Map() };
    const sp = spend.get(p.campaign_id) ?? 0;
    out.set(p.plan_id, {
      plan_id: p.plan_id, campaign_id: p.campaign_id, product_line: line,
      plan_multiplier: round2(num(p.expected_gmv_krw) / num(p.requested_budget_krw)),
      sample_orders: c.orders,
      nominal_roas: sp > 0 ? round2(c.gmv / sp) : null,
      line_sample_campaigns: lineCampaigns.get(line) ?? 0,
      thin_sample: (lineCampaigns.get(line) ?? 0) <= 1,
      sku_order_share: [...c.sku.entries()].sort().map(([sku_id, n]) => ({ sku_id, orders: n, share_pct: round2((n / c.orders) * 100) })),
      sku_sales_max_over_median: Object.fromEntries([...skuShape].filter(([sku]) => c.sku.has(sku))),
      source_type: '계산',
    });
  }
  return out;
}

// ── 추가 수량 (K1) ──

// round_half_up(baseline × pct ÷ 100). 정수 연산으로 부동소수 오차를 없앤다.
export function addedQtyEa(baselineWeeklyQty, upliftPct) {
  const b = Math.round(baselineWeeklyQty * 100); // 소수 둘째 자리
  const p = Math.round(upliftPct * 10);          // 소수 첫째 자리
  return Math.floor((b * p + 50000) / 100000);
}

// campaign_demand_weekly 행. overrides: [{ sku_id, override_uplift_pct }]
export function computeDemandWeekly({ demand_input_id = null, version = null, plan_id, sku_ids, baselineBySku,
  uplift_pct, overrides = [], sale_start_week, sale_weeks }) {
  const ov = new Map(overrides.map((o) => [o.sku_id, Number(o.override_uplift_pct)]));
  const rows = [];
  for (const sku_id of sku_ids) {
    const base = baselineBySku.get(sku_id);
    if (!base) throw new Error(`기준 수요가 없습니다: ${sku_id}`);
    const applied = ov.has(sku_id) ? ov.get(sku_id) : Number(uplift_pct);
    for (let i = 0; i < sale_weeks; i += 1) {
      rows.push({
        demand_input_id, version, plan_id, sku_id, week_start: addWeeks(sale_start_week, i),
        baseline_weekly_qty: base.baseline_weekly_qty, applied_uplift_pct: applied,
        added_qty_ea: addedQtyEa(base.baseline_weekly_qty, applied),
        baseline_demand_version: base.baseline_demand_version, source_type: '계산', is_simulation: true,
      });
    }
  }
  return rows;
}

// ── 검증 (명세 4.2-3) ──

const oneDecimal = (x) => Math.abs(Math.round(x * 10) - x * 10) < 1e-9;

export function validateDemandFields(f, { skuIds, grid = GRID_DEFAULT, today, names = new Map() }) {
  const nameOf = (sku) => names.get(sku) ?? sku;
  const errors = [];
  const uplift = num(f.uplift_pct);
  if (uplift === null) errors.push('증가율이 없습니다');
  else if (uplift < 0) errors.push('증가율은 0 이상이어야 합니다');
  else if (!oneDecimal(uplift)) errors.push('증가율은 소수 첫째 자리까지 넣습니다');
  if (!isDate(f.sale_start_week)) errors.push('판매 시작 주가 날짜가 아닙니다');
  else {
    if (!isMonday(f.sale_start_week)) errors.push('판매 시작 주는 월요일이어야 합니다');
    if (f.sale_start_week < grid.first_week_start) errors.push(`판매 시작 주는 ${grid.first_week_start} 주 이후여야 합니다`);
  }
  const weeks = num(f.sale_weeks);
  if (weeks === null || !Number.isInteger(weeks) || weeks < 1) errors.push('판매 주수는 1 이상의 정수여야 합니다');
  if (isDate(f.sale_start_week) && weeks !== null && Number.isInteger(weeks) && weeks >= 1) {
    const end = addWeeks(f.sale_start_week, weeks - 1);
    if (end > grid.projection_end_week) errors.push(`판매 종료 주 ${end}가 전망 마지막 주 ${grid.projection_end_week}를 넘습니다`);
  }
  for (const o of f.overrides ?? []) {
    if (!skuIds.includes(o.sku_id)) errors.push(`${nameOf(o.sku_id)}은(는) 이 기안의 품목이 아닙니다`);
    const v = num(o.override_uplift_pct);
    if (v === null || v < 0 || !oneDecimal(v)) errors.push(`${nameOf(o.sku_id)}의 품목별 증가율이 올바르지 않습니다`);
  }
  if (!f.submitted_by) errors.push('작성자가 없습니다');
  if (!isDate(f.basis_as_of)) errors.push('기준 시점이 날짜가 아닙니다');
  else {
    if (f.basis_as_of < EFFECTIVE_FROM) errors.push('기준 시점은 2026-07-01 이후여야 합니다');
    if (today && f.basis_as_of > today) errors.push('기준 시점은 확인일보다 늦을 수 없습니다');
  }
  return errors;
}

// 사용자에게 보이는 문장에서 필드 코드·품목 코드를 업무 용어·품목 이름으로 바꾼다(AI가 코드를 섞어 쓴 경우 대비).
const FIELD_WORDS = [['sku_overrides', '품목별 증가율'], ['override_uplift_pct', '품목별 증가율'], ['uplift_pct', '증가율'],
  ['sale_start_week', '판매 시작 주'], ['sale_weeks', '판매 주수'], ['rationale_text', '근거'], ['SKU별', '품목별'], ['SKU 별', '품목별']];
export const FIELD_LABELS = Object.freeze({ uplift_pct: '증가율', sale_start_week: '판매 시작 주', sale_weeks: '판매 주수', sku_overrides: '품목별 증가율', rationale_text: '근거' });
export function humanize(text, names = new Map()) {
  if (text == null) return text;
  let s = String(text).replace(/SKU-\d{4}/g, (m) => names.get(m) ?? m);
  for (const [code, word] of FIELD_WORDS) s = s.split(code).join(word);
  return s;
}

// ── 모의 회신 자료 형식 (명세 3.3 S1·S2) ──

export const S1_FILE = 'synthetic/s1_demand_reply.csv';
export const S2_FILE = 'synthetic/s2_sku_override.csv';
export const S1_COLUMNS = Object.freeze(['record_id', 'plan_id', 'reply_seq', 'reply_pattern', 'reply_text',
  'confirmed_decision', 'confirmed_uplift_pct', 'confirmed_sale_start_week', 'confirmed_sale_weeks',
  'submitted_by', 'basis_as_of', 'rationale_text',
  'source_ref', 'effective_at', 'source_type', 'is_synthetic', 'scenario_id', 'generation_reason', 'spec_ref']);
export const S2_COLUMNS = Object.freeze(['record_id', 'reply_record_id', 'plan_id', 'sku_id', 'override_uplift_pct',
  'source_ref', 'effective_at', 'source_type', 'is_synthetic', 'generation_reason']);
const REPLY_PATTERNS = ['on_time', 'late', 'revised'];

// CSV 행을 검사해 형식을 맞춘다. 문제가 있으면 오류를 던진다(조용히 넘기지 않는다).
export function parseS1(rows, planIds) {
  return rows.map((r, i) => {
    const where = `${S1_FILE} ${i + 2}행`;
    for (const c of S1_COLUMNS) if (!(c in r)) throw new Error(`${where}: ${c} 열이 없습니다`);
    if (!planIds.has(r.plan_id)) throw new Error(`${where}: 원본에 없는 기안 ${r.plan_id}`);
    if (!REPLY_PATTERNS.includes(r.reply_pattern)) throw new Error(`${where}: reply_pattern ${r.reply_pattern}`);
    if (!['확인', '거부'].includes(r.confirmed_decision)) throw new Error(`${where}: confirmed_decision ${r.confirmed_decision}`);
    if (r.source_type !== '모의회신' || r.is_synthetic !== 'true') throw new Error(`${where}: 모의회신·is_synthetic=true여야 합니다`);
    return {
      ...r, reply_seq: Number(r.reply_seq), is_synthetic: true,
      confirmed_uplift_pct: num(r.confirmed_uplift_pct), confirmed_sale_weeks: num(r.confirmed_sale_weeks),
      confirmed_sale_start_week: r.confirmed_sale_start_week === 'NONE' ? null : r.confirmed_sale_start_week,
    };
  }).sort((a, b) => a.plan_id.localeCompare(b.plan_id) || a.reply_seq - b.reply_seq);
}

export function parseS2(rows, s1ById) {
  return rows.map((r, i) => {
    const where = `${S2_FILE} ${i + 2}행`;
    for (const c of S2_COLUMNS) if (!(c in r)) throw new Error(`${where}: ${c} 열이 없습니다`);
    const reply = s1ById.get(r.reply_record_id);
    if (!reply) throw new Error(`${where}: S1에 없는 회신 ${r.reply_record_id}`);
    if (reply.plan_id !== r.plan_id) throw new Error(`${where}: 회신의 기안과 다릅니다`);
    return { ...r, override_uplift_pct: num(r.override_uplift_pct), is_synthetic: true };
  });
}

// CSV 직렬화(파이프 구분). 값에 '|'나 줄바꿈이 있으면 거부한다.
export function toPipeCsv(columns, rows) {
  const cell = (v) => {
    const s = v === null || v === undefined ? 'NONE' : String(v);
    if (/[|\r\n]/.test(s)) throw new Error(`CSV 값에 구분자·줄바꿈이 있습니다: ${s}`);
    return s;
  };
  return `${[columns.join('|'), ...rows.map((r) => columns.map((c) => cell(r[c])).join('|'))].join('\n')}\n`;
}
