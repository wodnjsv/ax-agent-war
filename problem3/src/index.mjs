// 문제 3 모듈: 현금 구간·약정 원장·지급일·승인 경로·상신·회신 반영.
// 이름: problem4/공통_접점.md 3.3·5.3 / 붙이는 법: app/모듈_계약.md / 규칙: problem3/명세.md
import * as C from './calc.mjs';
import { createDescriber, RULE_TEXT } from './describe.mjs';

const RAW = {
  ar: '02_masil/financials/fin_ar_aging_ms.csv',
  ap: '02_masil/financials/fin_ap_aging_ms.csv',
  po: '02_masil/inventory/sc_purchase_orders_ms.csv',
  cash: '02_masil/financials/fin_cash_daily_ms.csv',
  sku: '02_masil/master/m_sku_ms.csv',
};
const SPEC = 'problem3/명세.md';
const CONFIRMED_PLAN_STATUS = new Set(['확정', '기한 경과 확정']);
const APPROVER_RANK = { GRP_CEO: 3, MS_CEO: 2, MKT_TEAM: 1, SCM: 1 };
const pad = (n, w) => String(n).padStart(w, '0');
const b = (v) => (v ? 1 : 0);
const json = (v) => (v == null ? null : JSON.stringify(v));
const parse = (v, d = null) => (v == null ? d : JSON.parse(v));

export async function register(ctx) {
  const { db } = ctx;

  // ── 테이블 ──
  ctx.defineTable('p3_cash_window', `window_version TEXT PRIMARY KEY, n INTEGER NOT NULL, as_of TEXT, window_basis TEXT,
    scenario_id TEXT, shortfall_window_start TEXT, shortfall_window_end TEXT, shortfall_bd_count INTEGER, threshold INTEGER,
    min_balance_krw INTEGER, min_date TEXT, next_outside_date TEXT, included_sources TEXT, finance_confirmation_status TEXT,
    is_simulation INTEGER, segments TEXT, ar_overrides TEXT, approved_drafts TEXT, finance_reply_id TEXT, mismatch TEXT, event_id TEXT`);
  ctx.defineTable('p3_commitment', `commitment_id TEXT PRIMARY KEY, n INTEGER NOT NULL, commitment_type TEXT, source_id TEXT,
    plan_id TEXT, plan_bundle_id TEXT, supplier_id TEXT, cash_outflow_date TEXT, amount_krw INTEGER, amount_scale TEXT,
    is_new_commitment INTEGER, payment_due_date TEXT, payment_rule_id TEXT, settlement_date TEXT, contract_deadline TEXT,
    planned_order_date TEXT, linked_plan_ids TEXT, draft_version INTEGER, approval_anchor_date TEXT, anchor_basis TEXT,
    route_judgment_id TEXT, approval_route TEXT, approver TEXT, route_rule_id TEXT, group_report_required INTEGER,
    window_version TEXT, approval_status TEXT, approval_request_id TEXT, conditions TEXT, finance_confirmation_status TEXT,
    contribution_margin_status TEXT, source_type TEXT, is_synthetic INTEGER, is_simulation INTEGER, effective_at TEXT,
    source_ref TEXT, active INTEGER NOT NULL DEFAULT 1, plan_status TEXT, draft_approved INTEGER NOT NULL DEFAULT 0`);
  ctx.defineTable('p3_route_judgment', `route_judgment_id TEXT PRIMARY KEY, n INTEGER NOT NULL, commitment_id TEXT,
    window_version TEXT, cash_outflow_date TEXT, in_window INTEGER, approval_route TEXT, approver TEXT, route_rule_id TEXT,
    previous_route_judgment_id TEXT, route_changed INTEGER, already_confirmed INTEGER, is_simulation INTEGER,
    judged_on TEXT, scenario_window TEXT, status_after TEXT, rationale TEXT, event_id TEXT, caused_by TEXT`);
  ctx.defineTable('p3_approval_request', `approval_request_id TEXT PRIMARY KEY, n INTEGER NOT NULL, commitment_ids TEXT,
    approver TEXT, submission_due TEXT, superseded INTEGER NOT NULL DEFAULT 0, submitted_on TEXT, event_id TEXT,
    superseded_commitment_ids TEXT NOT NULL DEFAULT '[]'`);
  // 기존 DB에 새 열을 더한다(CREATE TABLE IF NOT EXISTS는 열을 추가하지 않는다)
  if (!db.prepare('PRAGMA table_info(p3_route_judgment)').all().some((col) => col.name === 'approval_anchor_date')) {
    db.exec('ALTER TABLE p3_route_judgment ADD COLUMN approval_anchor_date TEXT');
  }
  if (!db.prepare('PRAGMA table_info(p3_approval_request)').all().some((col) => col.name === 'superseded_commitment_ids')) {
    db.exec("ALTER TABLE p3_approval_request ADD COLUMN superseded_commitment_ids TEXT NOT NULL DEFAULT '[]'");
  }
  // 발주안 수량 내역(발주 수량 / 기준 수요분 / 캠페인 추가분). 조정자 (E)-(1)·(3)
  if (!db.prepare('PRAGMA table_info(p3_commitment)').all().some((col) => col.name === 'qty_detail')) {
    db.exec('ALTER TABLE p3_commitment ADD COLUMN qty_detail TEXT');
  }
  // 상신에 붙인 문서(초안)와 수정 전 원문
  if (!db.prepare('PRAGMA table_info(p3_approval_request)').all().some((col) => col.name === 'draft_id')) {
    db.exec('ALTER TABLE p3_approval_request ADD COLUMN draft_id TEXT');
  }
  // 공급 위험 수용(승인 상태의 속성)과 Corevia 공급 불가로 인한 약정 취소 기록
  for (const col of ['supply_risk_acceptance', 'supply_cancel', 'cancel_info', 'residual_after_withdrawal', 'withdrawal_info']) {
    if (!db.prepare('PRAGMA table_info(p3_commitment)').all().some((x) => x.name === col)) db.exec(`ALTER TABLE p3_commitment ADD COLUMN ${col} TEXT`);
  }
  // 판정 근거 조각(유출일이 든 하회 조각)
  if (!db.prepare('PRAGMA table_info(p3_route_judgment)').all().some((col) => col.name === 'matched_segment')) {
    db.exec('ALTER TABLE p3_route_judgment ADD COLUMN matched_segment TEXT');
  }
  // 이전 실행에서 취소 사건을 받았지만 상태가 남은 발주안을 바로잡는다
  db.exec(`UPDATE p3_commitment SET approval_status = '취소' WHERE commitment_type = '발주안' AND active = 0 AND approval_status IN ('미상신', '결재 대기')`);
  ctx.defineTable('p3_finance_reply_applied', `finance_reply_id TEXT PRIMARY KEY, event_id TEXT, applied_on TEXT, window_version TEXT`);
  ctx.defineTable('p3_draft', `draft_id TEXT PRIMARY KEY, n INTEGER NOT NULL, commitment_id TEXT, text TEXT, mode TEXT,
    ai_call_id TEXT, review_status TEXT, created_on TEXT`);
  if (!db.prepare('PRAGMA table_info(p3_draft)').all().some((col) => col.name === 'original_text')) {
    db.exec('ALTER TABLE p3_draft ADD COLUMN original_text TEXT'); // 담당자가 고치기 전 초안
  }

  // ── 정적 자료(원본·합성) ──
  const raw = {
    ar: ctx.raw.load(RAW.ar), ap: ctx.raw.load(RAW.ap), po: ctx.raw.load(RAW.po),
    cashLast: ctx.raw.load(RAW.cash).at(-1), sku: ctx.raw.load(RAW.sku),
  };
  const opening = ctx.toNum(raw.cashLast.closing_balance);
  const threshold = ctx.toNum(raw.cashLast.covenant_min_krw);
  const terms = ctx.data.load('s3_01_supplier_payment_terms.csv');
  const bundles = ctx.data.load('s3_02_plan_bundle.csv');
  const roles = ctx.data.load('s3_03_approver_roles.csv');
  const replies = ctx.data.load('s3_04_finance_reply.csv');
  const bundleOf = new Map(bundles.map((r) => [r.plan_id, r]));
  const roleOf = new Map(roles.map((r) => [r.approver, r]));
  const termOf = new Map(terms.map((r) => [r.supplier_id, r]));
  const supplierOfSku = new Map(raw.sku.map((s) => [s.sku_id, s.source_company]));
  // 묶음 총액은 원 기안 기준으로 고정한다(U13)
  const bundleTotals = new Map();
  for (const p of ctx.plans()) {
    const id = bundleOf.get(p.plan_id)?.plan_bundle_id;
    if (id) bundleTotals.set(id, (bundleTotals.get(id) ?? 0) + p.requested_budget_krw);
  }

  const p = (id) => ctx.module(id); // 없으면 null → "연결 안 됨"
  const today = () => ctx.clock.today();

  // ── 현금 구간 ──
  const nextN = (table) => (db.prepare(`SELECT COALESCE(MAX(n), 0) + 1 AS n FROM ${table}`).get().n);
  const windowRow = (version) => db.prepare('SELECT * FROM p3_cash_window WHERE window_version = ?').get(version);
  const latestWindowRow = (scenarioId) => (scenarioId
    ? db.prepare('SELECT * FROM p3_cash_window WHERE scenario_id = ? ORDER BY n DESC LIMIT 1').get(scenarioId)
    : db.prepare('SELECT * FROM p3_cash_window ORDER BY n DESC LIMIT 1').get());
  const toWindow = (r) => (r ? {
    window_version: r.window_version, as_of: r.as_of, window_basis: r.window_basis, scenario_id: r.scenario_id,
    shortfall_window_start: r.shortfall_window_start, shortfall_window_end: r.shortfall_window_end,
    shortfall_bd_count: r.shortfall_bd_count, threshold: r.threshold, min_balance_krw: r.min_balance_krw,
    min_date: r.min_date, next_outside_date: r.next_outside_date, included_sources: parse(r.included_sources, []),
    finance_confirmation_status: r.finance_confirmation_status, is_simulation: r.is_simulation === 1,
    segments: parse(r.segments, []).map(C.segmentView),
  } : null);

  function compute({ arOverrides = {}, drafts = [], variant = 'base' } = {}) {
    const items = C.buildCashItems({ ...raw, arOverrides, extraOutflows: drafts });
    const daily = C.projectCash({ opening_krw: opening, items, threshold_krw: threshold, variant });
    return { daily, ...C.findWindow(daily) };
  }
  const approvedDraftFlows = () => db.prepare(`SELECT * FROM p3_commitment WHERE commitment_type = '발주안' AND active = 1 AND draft_approved = 1 ORDER BY n`)
    .all().map((c) => ({ ref: c.source_id, date: c.payment_due_date, amount_krw: c.amount_krw }));

  async function newWindowVersion({ basis, scenarioId, financeStatus, financeReplyId = null, arOverrides, isSimulation, causedBy, mismatch = null }) {
    const drafts = approvedDraftFlows();
    const w = compute({ arOverrides, drafts });
    const n = nextN('p3_cash_window');
    const version = `CW-${pad(n, 3)}`;
    const sources = [RAW.cash, RAW.ar, `${RAW.ap}(po_id=NONE)`, RAW.po, ...drafts.map((d) => `po_draft:${d.ref}`),
      ...Object.keys(arOverrides).map((k) => `finance_reply:${financeReplyId ?? '-'}:${k}`)];
    db.prepare(`INSERT INTO p3_cash_window VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      version, n, C.AS_OF, basis, scenarioId, w.shortfall_window_start, w.shortfall_window_end, w.shortfall_bd_count, threshold,
      w.min_balance_krw, w.min_date, w.next_outside_date, json(sources), financeStatus, b(isSimulation || drafts.length > 0),
      json(w.segments), json(arOverrides), json(drafts.map((d) => d.ref)), financeReplyId, mismatch, null);
    const row = windowRow(version);
    const plan = recheckPlan();
    const recheckSummary = {
      rechecked: plan.changed.length + plan.kept.length, kept: plan.kept.length, changed: plan.changed.length,
      skipped_terminal: plan.skipped.length,
      kept_rationale: '승인권자·승인 기준일·구간 안팎이 같아 새 판정을 내지 않음',
      changed_commitments: plan.changed, kept_commitment_ids: plan.kept,
    };
    const ev = await ctx.events.emit({
      event_type: 'CASH_WINDOW_REVISED', source_type: '계산', subject_type: 'cash_window', subject_id: version,
      is_simulation: row.is_simulation === 1, scenario_id: scenarioId, caused_by: causedBy ?? null,
      source_ref: sources, spec_ref: `${SPEC}#4.1`, generation_reason: '정책 판단 순서 ① 재전망으로 하회 구간 특정',
      premise_refs: { finance_reply_id: financeReplyId, approved_po_drafts: drafts.map((d) => d.ref) },
      payload: {
        window_version: version, window_basis: basis, shortfall_window_start: row.shortfall_window_start,
        shortfall_window_end: row.shortfall_window_end, threshold, next_outside_date: row.next_outside_date, scenario_id: scenarioId,
        min_balance_krw: row.min_balance_krw, min_date: row.min_date,
        segments: parse(row.segments, []).map(C.segmentView),
        recheck_summary: recheckSummary,
      },
    });
    db.prepare('UPDATE p3_cash_window SET event_id = ? WHERE window_version = ?').run(ev.event_id, version);
    for (const cid of plan.kept) updateCommitment(cid, { window_version: version });
    for (const x of plan.changed) await judge(x.commitment_id, { causedBy: ev.event_id });
    return { row: windowRow(version), event: ev, recheck: recheckSummary };
  }
  const currentWindow = () => latestWindowRow();

  // ── 약정 원장 ──
  const commitRow = (id) => db.prepare('SELECT * FROM p3_commitment WHERE commitment_id = ?').get(id);
  const toCommitment = (r) => (r ? {
    commitment_id: r.commitment_id, commitment_type: r.commitment_type, source_id: r.source_id, plan_id: r.plan_id,
    plan_bundle_id: r.plan_bundle_id, supplier_id: r.supplier_id, cash_outflow_date: r.cash_outflow_date,
    amount_krw: r.amount_krw, amount_scale: r.amount_scale, is_new_commitment: r.is_new_commitment === 1,
    payment_due_date: r.payment_due_date, payment_rule_id: r.payment_rule_id, approval_anchor_date: r.approval_anchor_date,
    anchor_basis: r.anchor_basis, route_judgment_id: r.route_judgment_id, approval_route: r.approval_route,
    approver: r.approver, route_rule_id: r.route_rule_id, group_report_required: r.group_report_required === 1,
    window_version: r.window_version, approval_status: r.approval_status, approval_request_id: r.approval_request_id,
    conditions: parse(r.conditions, []), finance_confirmation_status: r.finance_confirmation_status,
    contribution_margin_status: r.contribution_margin_status, source_type: r.source_type,
    is_synthetic: r.is_synthetic === 1, is_simulation: r.is_simulation === 1, effective_at: r.effective_at, source_ref: r.source_ref,
    active: r.active === 1,
    // 승인권자가 공급 위험을 받아들인 기록(승인 상태의 속성). 공급 상태(Corevia 확약)는 바꾸지 않는다
    supply_risk_acceptance: parse(r.supply_risk_acceptance), supply_cancel: parse(r.supply_cancel),
    // 취소 사유 구분(기안 철회로 취소 / 공급 불가로 취소 / 발주안 취소)과 '기안 철회 뒤 남은 발주'(취소 안 됨, 유출 유지). 한계 L1
    cancel_info: parse(r.cancel_info), residual_after_withdrawal: parse(r.residual_after_withdrawal), withdrawal_info: parse(r.withdrawal_info),
  } : null);
  const financeStatusNow = () => (currentWindow()?.finance_confirmation_status === '확인됨' ? '확인됨' : '재무확인대기');

  function insertCommitment(c) {
    const cols = Object.keys(c);
    db.prepare(`INSERT INTO p3_commitment (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((k) => c[k]));
  }
  function updateCommitment(id, fields) {
    const cols = Object.keys(fields);
    db.prepare(`UPDATE p3_commitment SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE commitment_id = ?`).run(...cols.map((k) => fields[k]), id);
  }

  function ensurePlanCommitment(planId) {
    const id = `CMT-${planId}`;
    if (commitRow(id)) return id;
    const plan = ctx.plans().find((x) => x.plan_id === planId);
    if (!plan) throw new Error(`원본 기안이 없습니다: ${planId}`);
    const anchor = C.anchorFor({ commitment_type: '기안', settlement_date: plan.settlement_date, contract_deadline: plan.contract_deadline });
    insertCommitment({
      commitment_id: id, n: nextN('p3_commitment'), commitment_type: '기안', source_id: planId, plan_id: planId,
      plan_bundle_id: bundleOf.get(planId)?.plan_bundle_id ?? null, supplier_id: 'NONE',
      cash_outflow_date: plan.settlement_date, amount_krw: plan.requested_budget_krw, amount_scale: 'sample',
      is_new_commitment: 1, settlement_date: plan.settlement_date, contract_deadline: plan.contract_deadline,
      approval_anchor_date: anchor.approval_anchor_date, anchor_basis: anchor.anchor_basis, approval_status: '미상신',
      finance_confirmation_status: financeStatusNow(), contribution_margin_status: '미산정', source_type: '원본도출',
      is_synthetic: 0, is_simulation: 0, effective_at: C.AS_OF, source_ref: plan.source_ref, active: 1, conditions: '[]',
    });
    return id;
  }

  function ensureExistingPoCommitments() {
    for (const r of raw.po) {
      const id = `CMT-${r.po_id}`;
      if (commitRow(id)) continue;
      insertCommitment({
        commitment_id: id, n: nextN('p3_commitment'), commitment_type: '기발주', source_id: r.po_id, plan_id: 'NONE',
        supplier_id: r.supplier_id, cash_outflow_date: r.payment_due_date, amount_krw: ctx.toNum(r.amount_krw), amount_scale: 'full',
        is_new_commitment: 0, approval_status: '판정대상아님', route_rule_id: 'R-00', approval_route: C.ROUTE_TEXT['R-00'],
        finance_confirmation_status: '재무확인대기', contribution_margin_status: '미산정', source_type: '원본도출',
        is_synthetic: 0, is_simulation: 0, effective_at: C.AS_OF, source_ref: `${RAW.po}#${r.po_id}`, active: 1, conditions: '[]',
      });
    }
  }

  // 발주안: 지급일 산출(S3-01)과 약정 등록
  async function upsertDraftCommitment(d, causedBy) {
    const id = `CMT-${d.po_draft_id}`;
    const supplier = d.supplier_id || supplierOfSku.get(d.sku_id) || null;
    const term = termOf.get(supplier);
    if (!term) throw new Error(`공급처 결제 조건이 없습니다: ${supplier}`);
    const due = C.paymentDueDate(d.planned_order_date, term);
    const fields = {
      supplier_id: supplier, cash_outflow_date: due, amount_krw: ctx.toNum(d.amount_krw), payment_due_date: due,
      payment_rule_id: term.record_id, planned_order_date: d.planned_order_date, linked_plan_ids: json(d.linked_plan_ids ?? []),
      draft_version: d.draft_version ?? 1, approval_anchor_date: d.planned_order_date, anchor_basis: 'planned_order_date',
      effective_at: today(), is_simulation: 1, active: 1,
      // 수량 내역은 사전 3.2 po_draft.qty_breakdown을 그대로 보관한다(문제 2 소유 값)
      qty_detail: json({ order_qty: d.order_qty ?? null, qty_breakdown: d.qty_breakdown ?? null, sku_id: d.sku_id ?? null }),
    };
    // 기안 철회에 따른 문제 2의 처리 구분을 그대로 남긴다(조정자: 스스로 추정하지 않음). 기안만 뗌 / 발주 전달 뒤 남음
    const wd = d.withdrawal ?? null;
    if (wd) fields.withdrawal_info = json({ plan_id: wd.plan_id, disposition: wd.disposition, withdrawn_event_id: wd.withdrawn_event_id ?? null, linked_plan_ids_before: d.linked_plan_ids_before ?? null, event_id: causedBy ?? null, on: today() });
    if ('orphan_status' in d) {
      fields.residual_after_withdrawal = d.orphan_status === '기안 철회 뒤 남은 발주' ? json({
        plan_ids: d.linked_plan_ids_before ?? (wd ? [wd.plan_id] : []), withdrawn_event_id: wd?.withdrawn_event_id ?? null, marked_on: today(), ordered_on: d.planned_order_date ?? null,
        disposition: wd?.disposition ?? null, note: '기안 철회 뒤 남은 발주(문제 2 표시): 발주가 이미 전달돼 취소하지 않는다. 지급 유출은 그대로 재전망에 남는다. SCM 취소·조정 가능 여부 확인 대상',
      }) : null;
    }
    const before = commitRow(id);
    let windowEvent = null;
    if (before?.supply_cancel && before.draft_version === fields.draft_version && before.amount_krw === fields.amount_krw) {
      return { id, changed: false }; // Corevia 공급 불가로 취소한 발주안은 같은 발주안 사건이 다시 와도 되살리지 않는다
    }
    if (before) {
      const same = before.draft_version === fields.draft_version && before.payment_due_date === due && before.amount_krw === fields.amount_krw && before.active === 1;
      if (same) {
        // 경로에 영향 없는 연결 기안·수량 내역만 바뀌면 그 값만 고친다(판정·사건 없음)
        const keep = { linked_plan_ids: fields.linked_plan_ids, qty_detail: fields.qty_detail,
          ...('withdrawal_info' in fields ? { withdrawal_info: fields.withdrawal_info } : {}),
          ...('residual_after_withdrawal' in fields && (fields.residual_after_withdrawal == null) !== (before.residual_after_withdrawal == null) ? { residual_after_withdrawal: fields.residual_after_withdrawal } : {}) };
        if (Object.keys(keep).some((k) => before[k] !== keep[k])) updateCommitment(id, keep);
        return { id, changed: false };
      }
      updateCommitment(id, { ...fields, approval_status: '미상신', draft_approved: 0 });
      if (before.draft_approved === 1) {
        // 승인됐던 발주안이 바뀌면 기준 재전망에서 빼고 구간을 다시 구한다(R4)
        const w = currentWindow();
        windowEvent = (await newWindowVersion({ basis: w.window_basis, scenarioId: w.scenario_id, financeStatus: w.finance_confirmation_status, financeReplyId: w.finance_reply_id, arOverrides: parse(w.ar_overrides, {}), isSimulation: w.is_simulation === 1, causedBy })).event;
      }
    } else {
      insertCommitment({
        commitment_id: id, n: nextN('p3_commitment'), commitment_type: '발주안', source_id: d.po_draft_id, plan_id: 'NONE',
        plan_bundle_id: null, amount_scale: 'full', is_new_commitment: 1, approval_status: '미상신',
        finance_confirmation_status: financeStatusNow(), contribution_margin_status: '미산정', source_type: '계산',
        is_synthetic: 0, source_ref: `problem2:po_draft#${d.po_draft_id}`, conditions: '[]', ...fields,
      });
    }
    await ctx.events.emit({
      event_type: 'PAYMENT_DATE_SET', source_type: '계산', is_simulation: true, subject_type: 'po_draft', subject_id: d.po_draft_id,
      caused_by: causedBy ?? null, source_ref: [`problem3/data/s3_01_supplier_payment_terms.csv#${term.record_id}`],
      premise_refs: { payment_rule_id: term.record_id, po_draft_id: d.po_draft_id, draft_version: d.draft_version ?? 1 },
      spec_ref: `${SPEC}#4.3`, generation_reason: '발주안 지급 예정일 산출(월 마감 익월 21일, 비영업일이면 다음 영업일)',
      payload: { po_draft_id: d.po_draft_id, payment_due_date: due, payment_rule_id: term.record_id },
    });
    return { id, changed: true, windowEvent };
  }

  // ── 경로 판정 ──
  const rjRow = (id) => db.prepare('SELECT * FROM p3_route_judgment WHERE route_judgment_id = ?').get(id);
  const latestRj = (cid) => db.prepare('SELECT * FROM p3_route_judgment WHERE commitment_id = ? ORDER BY n DESC LIMIT 1').get(cid);
  const toRj = (r) => (r ? {
    route_judgment_id: r.route_judgment_id, commitment_id: r.commitment_id, window_version: r.window_version,
    cash_outflow_date: r.cash_outflow_date, in_window: r.in_window === 1, approval_route: r.approval_route,
    approver: r.approver, route_rule_id: r.route_rule_id, previous_route_judgment_id: r.previous_route_judgment_id,
    route_changed: r.route_changed === 1, already_confirmed: r.already_confirmed === 1,
    matched_segment: parse(r.matched_segment), scenario_window: parse(r.scenario_window),
  } : null);

  function planStatusOf(c) {
    if (c.plan_id === 'NONE') return null;
    return p('p4')?.getPlanState?.(c.plan_id)?.plan_status ?? c.plan_status ?? null;
  }

  // 종결된 기안과 결정이 끝난 발주안은 재판정하지 않는다(조정자 (D)-2 가)
  function isTerminal(c) {
    if (c.commitment_type === '기안') return ['확정', '기한 경과 확정', '철회'].includes(planStatusOf(c) ?? '');
    if (c.commitment_type === '발주안') return ['승인', '거절'].includes(c.approval_status);
    return false;
  }

  // 현행 구간에서 약정의 경로를 계산한다(저장하지 않음)
  function evaluate(c, w = currentWindow()) {
    let segments = parse(w.segments, []);
    let scenarioWindow = null;
    if (c.commitment_type === '발주안' && c.draft_approved !== 1) {
      // R4: 미승인 발주안은 자기 유출을 더한 시나리오 구간과 대조한다
      const sc = compute({ arOverrides: parse(w.ar_overrides, {}), drafts: [...approvedDraftFlows(), { ref: c.source_id, date: c.payment_due_date, amount_krw: c.amount_krw }] });
      segments = sc.segments;
      scenarioWindow = { shortfall_window_start: sc.shortfall_window_start, shortfall_window_end: sc.shortfall_window_end, shortfall_bd_count: sc.shortfall_bd_count, segments: sc.segments.map(C.segmentView) };
    }
    const r = C.judgeRoute({ commitment_type: c.commitment_type, is_new_commitment: c.is_new_commitment === 1, cash_outflow_date: c.cash_outflow_date, amount_krw: c.amount_krw }, segments, bundleTotals.get(c.plan_bundle_id) ?? 0);
    // 판정 근거: 유출일이 든 조각(여러 조각이면 몇 번째인지). 발주안은 자기 유출을 더한 시나리오 구간 기준
    const hit = C.segmentOf(c.cash_outflow_date, segments);
    const matchedSegment = hit ? { ...C.segmentView(hit, segments.indexOf(hit)), segment_count: segments.length, basis: scenarioWindow ? 'scenario_with_own_outflow' : 'current_window' } : null;
    return { r, scenarioWindow, w, matchedSegment, segments };
  }
  const eokText = (n) => `${(n / 1e8).toFixed(2)}억`;
  // 판정 근거 문장: 유출일이 어느 조각에 드는지, 또는 모든 조각 밖인지
  function segmentRationale(c, { matchedSegment: m, segments, scenarioWindow }) {
    const basis = scenarioWindow ? '이 발주안 유출을 더한 시나리오 재전망' : '현행 재전망';
    const list = segments.map((s, i) => `${i + 1}) ${s.start}~${s.end}`).join(', ') || '없음';
    if (!m) return `유출일 ${c.cash_outflow_date}는 ${basis}의 하회 조각 밖(조각: ${list})`;
    return `유출일 ${c.cash_outflow_date}는 ${basis}의 하회 조각 ${m.segment_no}/${m.segment_count}(${m.start}~${m.end}${m.end_at_horizon ? ', 재전망 끝까지' : ''}, 최저 ${eokText(m.min_balance_krw)} ${m.min_date})에 듦${m.segment_count > 1 ? `(조각: ${list})` : ''}`;
  }
  // 결론 = 승인권자·승인 기준일·구간 안팎. 같으면 새 판정 버전을 만들지 않는다
  const sameConclusion = (prev, r, c) => Boolean(prev) && prev.approver === r.approver && (prev.in_window === 1) === r.in_window
    && prev.approval_anchor_date === c.approval_anchor_date && prev.cash_outflow_date === c.cash_outflow_date;

  // 판정 규칙 4.5, 상태 처리 4.8. resubmit: 유출일·금액 변경 또는 거절 뒤 대안 선택
  async function judge(commitmentId, { causedBy = null, resubmit = false, emit = true } = {}) {
    const c = commitRow(commitmentId);
    if (!c || c.active !== 1) return null;
    if (!resubmit && latestRj(commitmentId) && isTerminal(c)) return null;
    const ev0 = evaluate(c);
    const { r, scenarioWindow, w, matchedSegment } = ev0;
    const prev = latestRj(commitmentId);
    if (!resubmit && sameConclusion(prev, r, c)) {
      // 결론이 같으면 판정·사건을 내지 않고 현행 구간 버전만 갱신한다
      if (c.window_version !== w.window_version) updateCommitment(commitmentId, { window_version: w.window_version });
      return null;
    }
    const routeChanged = prev ? prev.approver !== r.approver : false;
    const alreadyConfirmed = CONFIRMED_PLAN_STATUS.has(planStatusOf(c) ?? '');
    const rank = (a) => APPROVER_RANK[a] ?? 0;
    const upgrade = Boolean(c.approver) && rank(r.approver) > rank(c.approver);
    const downgrade = Boolean(c.approver) && rank(r.approver) < rank(c.approver);
    let status = c.approval_status;
    let approver = r.approver;
    let route = r.approval_route;
    let rule = r.route_rule_id;
    let rationale = routeChanged ? '경로 변경' : '결론 변경(구간 안팎 또는 기준일)';
    if (!prev) rationale = '최초 판정';
    if (r.route_rule_id === 'R-00') status = '판정대상아님';
    else if (alreadyConfirmed) {
      if (routeChanged) rationale = '이미 확정되어 되돌릴 수 없음(권한 불일치 확정)';
      approver = c.approver ?? approver; route = c.approval_route ?? route; rule = c.route_rule_id ?? rule;
    } else if (resubmit) {
      if (['결재 대기', '승인', '조건부', '거절'].includes(status)) status = '미상신';
      rationale = '유출일·금액 변경 또는 거절 뒤 대안 → 재상신 대상';
    } else if (downgrade && ['결재 대기', '승인', '조건부'].includes(status)) {
      // 조정자 C(3): 상위 권한으로 상신·승인된 건은 평시 경로로 내려가도 유지하고 재상신하지 않는다
      rationale = `상위 권한(${c.approver}) ${status} 유지, 재상신하지 않음(경로가 ${r.approver}로 내려감)`;
      approver = c.approver; route = c.approval_route; rule = c.route_rule_id;
    } else if (upgrade && ['결재 대기', '승인', '조건부'].includes(status)) {
      status = '미상신';
      rationale = `경로 상향(${c.approver} → ${r.approver}) → 재상신 대상`;
    }
    if (r.route_rule_id !== 'R-00') rationale = `${rationale}. ${segmentRationale(c, ev0)}`;
    const usesSim = (w.is_simulation === 1) || r.uses_bundle || c.commitment_type === '발주안' || scenarioWindow != null;
    const n = nextN('p3_route_judgment');
    const id = `RJ-${pad(n, 6)}`;
    db.prepare(`INSERT INTO p3_route_judgment (route_judgment_id, n, commitment_id, window_version, cash_outflow_date, in_window,
      approval_route, approver, route_rule_id, previous_route_judgment_id, route_changed, already_confirmed, is_simulation,
      judged_on, scenario_window, status_after, rationale, event_id, caused_by, approval_anchor_date, matched_segment)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, n, commitmentId, w.window_version, c.cash_outflow_date, b(r.in_window), r.approval_route, r.approver, r.route_rule_id,
      prev?.route_judgment_id ?? null, b(routeChanged), b(alreadyConfirmed && routeChanged), b(usesSim), today(),
      json(scenarioWindow), status, rationale, null, causedBy, c.approval_anchor_date, json(matchedSegment));
    updateCommitment(commitmentId, {
      route_judgment_id: id, approval_route: route, approver, route_rule_id: rule,
      group_report_required: b(rule === 'R-02'), window_version: w.window_version, approval_status: status,
      is_simulation: b(usesSim || c.commitment_type === '발주안'),
    });
    if (!emit || r.route_rule_id === 'R-00') return toRj(rjRow(id));
    const cc = commitRow(commitmentId);
    const ev = await ctx.events.emit({
      event_type: 'ROUTE_JUDGED', source_type: '계산', plan_id: cc.plan_id, subject_type: 'route_judgment', subject_id: id,
      is_simulation: usesSim, scenario_id: w.scenario_id, caused_by: causedBy,
      premise_refs: { window_version: w.window_version, ...(r.uses_bundle ? { plan_bundle_id: cc.plan_bundle_id } : {}), ...(cc.payment_rule_id ? { payment_rule_id: cc.payment_rule_id } : {}) },
      source_ref: [cc.source_ref, '00_common/approval_authority_policy.md#L6,L9,L11,L18-L22'],
      spec_ref: `${SPEC}#4.5`, generation_reason: '정책 판단 순서 ② 약정의 현금 유출일 대조 → ③ 경로 지정',
      payload: {
        ...toRj(rjRow(id)), commitment_type: cc.commitment_type, plan_id: cc.plan_id,
        approval_anchor_date: cc.approval_anchor_date, anchor_basis: cc.anchor_basis,
        std_approval_bd: cc.approver ? Number(roleOf.get(cc.approver)?.std_approval_bd ?? null) : null,
        group_report_required: cc.group_report_required === 1,
        approval_status: cc.approval_status, rationale, amount_krw: cc.amount_krw,
        ...(cc.commitment_type === '발주안' ? { linked_plan_ids: parse(cc.linked_plan_ids, []) } : {}),
      },
    });
    db.prepare('UPDATE p3_route_judgment SET event_id = ? WHERE route_judgment_id = ?').run(ev.event_id, id);
    return toRj(rjRow(id));
  }
  const activeJudgeable = () => db.prepare(`SELECT commitment_id FROM p3_commitment WHERE active = 1 AND is_new_commitment = 1 ORDER BY n`).all().map((r) => r.commitment_id);

  // 구간이 바뀐 뒤 재대조: 결론이 바뀐 약정만 골라낸다(사건은 내지 않음)
  function recheckPlan() {
    const changed = [];
    const kept = [];
    const skipped = [];
    for (const cid of activeJudgeable()) {
      const c = commitRow(cid);
      const prev = latestRj(cid);
      if (!prev) continue; // 아직 최초 판정 전(접수 사건 대기)
      if (isTerminal(c)) { skipped.push(cid); continue; }
      const { r } = evaluate(c);
      if (sameConclusion(prev, r, c)) kept.push(cid);
      else changed.push({ commitment_id: cid, plan_id: c.plan_id, before: { approver: prev.approver, in_window: prev.in_window === 1 }, after: { approver: r.approver, in_window: r.in_window } });
    }
    return { changed, kept, skipped };
  }

  // ── 상신 ──
  const reqRow = (id) => db.prepare('SELECT * FROM p3_approval_request WHERE approval_request_id = ?').get(id);
  const toReq = (r) => (r ? {
    approval_request_id: r.approval_request_id, commitment_ids: parse(r.commitment_ids, []), approver: r.approver,
    submission_due: r.submission_due, superseded: r.superseded === 1,
    superseded_commitment_ids: parse(r.superseded_commitment_ids, []),
  } : null);
  const isSupersededFor = (req, cid) => Boolean(req) && (req.superseded === 1 || parse(req.superseded_commitment_ids, []).includes(cid));
  const deadlineOf = (cid) => p('p4')?.getDeadlineSchedule?.({ commitment_id: cid }) ?? null;

  // 상신 문서로 쓸 수 있는 초안: 양식 초안, 또는 담당자가 확인·수정한 AI 초안(확인 전·거부된 AI 초안은 쓰지 않는다)
  const draftUsable = (d) => d.mode !== 'AI' || ['확인', '수정 후 확인'].includes(d.review_status);
  async function submitApproval({ commitment_ids, actor_dept, actor_role, effective_at, draft_id = null } = {}) {
    const ids = [...new Set(commitment_ids ?? [])];
    if (ids.length === 0) throw ctx.httpError(400, 'commitment_ids가 비었습니다');
    if (draft_id) {
      const d = db.prepare('SELECT * FROM p3_draft WHERE draft_id = ?').get(draft_id);
      if (!d || !ids.includes(d.commitment_id)) throw ctx.httpError(404, `이 요청의 상신 문서가 아닙니다: ${draft_id}`);
      if (!draftUsable(d)) throw ctx.httpError(409, `확인하지 않은 AI 초안은 상신에 쓸 수 없습니다: ${draft_id} (${d.review_status})`);
    }
    const rows = ids.map((id) => commitRow(id));
    for (const [i, r] of rows.entries()) {
      if (!r) throw ctx.httpError(404, `약정이 없습니다: ${ids[i]}`);
      if (r.active !== 1) throw ctx.httpError(409, `상신할 수 없는 상태입니다: ${r.commitment_id} (${r.approval_status === '취소' ? '취소된 발주안' : '종료된 약정'})`);
      if (r.is_new_commitment !== 1) throw ctx.httpError(400, `판정 대상이 아닌 약정입니다: ${r.commitment_id}`);
      if (r.approval_status !== '미상신') throw ctx.httpError(409, `상신할 수 없는 상태입니다: ${r.commitment_id} (${r.approval_status})`);
    }
    const approver = rows[0].approver;
    if (rows.some((r) => r.approver !== approver)) throw ctx.httpError(400, '한 상신에는 같은 승인권자의 약정만 묶습니다');
    // 같은 약정의 이전 상신은 대체된다(사전 3.3 approval_request "대체")
    // 조정자 C(4): 묶음 상신에서 다시 상신한 건만 대체하고, 같은 묶음의 다른 건은 유지한다
    for (const old of db.prepare('SELECT * FROM p3_approval_request WHERE superseded = 0').all()) {
      const members = parse(old.commitment_ids, []);
      const hit = members.filter((x) => ids.includes(x));
      if (hit.length === 0) continue;
      const sup = [...new Set([...parse(old.superseded_commitment_ids, []), ...hit])];
      db.prepare('UPDATE p3_approval_request SET superseded_commitment_ids = ?, superseded = ? WHERE approval_request_id = ?')
        .run(json(sup), b(members.every((x) => sup.includes(x))), old.approval_request_id);
    }
    const n = nextN('p3_approval_request');
    const id = `APR-${pad(n, 4)}`;
    const due = deadlineOf(ids[0])?.submission_due ?? null;
    db.prepare('INSERT INTO p3_approval_request (approval_request_id, n, commitment_ids, approver, submission_due, superseded, submitted_on, event_id, superseded_commitment_ids, draft_id) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, n, json(ids), approver, due, 0, today(), null, '[]', draft_id);
    for (const cid of ids) updateCommitment(cid, { approval_status: '결재 대기', approval_request_id: id });
    const planIds = [...new Set(rows.map((r) => r.plan_id))];
    const ev = await ctx.events.emit({
      event_type: 'APPROVAL_SUBMITTED', source_type: '사람입력', is_synthetic: true,
      plan_id: planIds.length === 1 ? planIds[0] : 'NONE', subject_type: 'approval_request', subject_id: id,
      actor_dept: actor_dept ?? (rows[0].commitment_type === '발주안' ? 'SCM' : 'MKT'), actor_role: actor_role ?? '상신 담당(시연)',
      effective_at, spec_ref: `${SPEC}#4.6`, generation_reason: '사람 상신(시연 입력)',
      premise_refs: { route_judgment_ids: rows.map((r) => r.route_judgment_id), ...(draft_id ? { draft_id } : {}) },
      payload: { approval_request_id: id, commitment_ids: ids, approver, submission_due: due, draft_id },
    });
    db.prepare('UPDATE p3_approval_request SET event_id = ? WHERE approval_request_id = ?').run(ev.event_id, id);
    return toReq(reqRow(id));
  }

  // 같은 종류·같은 승인권자·같은 상신 마감의 미상신 약정을 묶는다(R6). 기안과 발주안은 섞지 않는다
  // excludeDirect: 자동(모의) 묶음 상신은 문제 4의 직접 처리 기안(사용자가 화면에서 직접 올리는 기안)을 함께 올리지 않는다
  const directPlanIds = () => new Set(p('p4')?.listDirectPlans?.() ?? []);
  function submissionGroup(cid, { excludeDirect = false } = {}) {
    const c = commitRow(cid);
    const due = deadlineOf(cid)?.submission_due ?? null;
    if (!due) return [cid];
    const direct = excludeDirect ? directPlanIds() : new Set();
    return db.prepare(`SELECT commitment_id, plan_id FROM p3_commitment WHERE active = 1 AND is_new_commitment = 1 AND approval_status = '미상신' AND approver = ? AND commitment_type = ? ORDER BY n`)
      .all(c.approver, c.commitment_type).filter((r) => r.commitment_id === cid || (!direct.has(r.plan_id) && deadlineOf(r.commitment_id)?.submission_due === due)).map((r) => r.commitment_id);
  }
  const draftsOfPlan = (planId, { status } = {}) => db.prepare(`SELECT * FROM p3_commitment WHERE commitment_type = '발주안' AND active = 1 ORDER BY n`).all()
    .filter((x) => parse(x.linked_plan_ids, []).includes(planId) && (!status || x.approval_status === status));

  // ── 승인 가정 재전망(조정자 (E) 가): 상태를 바꾸지 않고 "이 약정을 승인하면"의 구간·최저 잔액을 계산한다 ──
  const windowView = (x) => ({
    shortfall_window_start: x.shortfall_window_start, shortfall_window_end: x.shortfall_window_end,
    shortfall_bd_count: x.shortfall_bd_count, min_balance_krw: x.min_balance_krw, min_date: x.min_date, next_outside_date: x.next_outside_date,
    segments: x.segments.map(C.segmentView),
  });
  function approvalImpact({ commitment_id, commitment_ids, scenario_id } = {}) {
    const ids = [...new Set(commitment_ids ?? (commitment_id ? [commitment_id] : []))];
    if (ids.length === 0) throw ctx.httpError(400, 'commitment_id가 비었습니다');
    const w = (scenario_id && latestWindowRow(scenario_id)) || currentWindow();
    const arOverrides = parse(w.ar_overrides, {});
    const approved = approvedDraftFlows();
    const added = [];
    const notes = [];
    for (const cid of ids) {
      const c = commitRow(cid);
      if (!c) throw ctx.httpError(404, `약정이 없습니다: ${cid}`);
      if (c.commitment_type !== '발주안') notes.push(`${cid}: 현금 유출을 더하지 않음(${c.commitment_type === '기안' ? '기안 요청액은 표본 스케일' : '기발주는 이미 재전망에 포함'})`);
      else if (c.active !== 1) notes.push(`${cid}: 취소된 발주안`);
      else if (c.draft_approved === 1) notes.push(`${cid}: 이미 승인되어 재전망에 포함됨`);
      else added.push({ ref: c.source_id, date: c.payment_due_date, amount_krw: c.amount_krw });
    }
    const before = windowView(compute({ arOverrides, drafts: approved }));
    const after = added.length ? windowView(compute({ arOverrides, drafts: [...approved, ...added] })) : before;
    return {
      commitment_ids: ids, window_version: w.window_version, scenario_id: w.scenario_id, threshold,
      before, after, min_balance_delta_krw: after.min_balance_krw - before.min_balance_krw,
      after_below_zero: after.min_balance_krw < 0,
      added_outflows: added.map((x) => ({ po_draft_id: x.ref, payment_due_date: x.date, amount_krw: x.amount_krw })),
      notes, limitations: CASH_LIMITATIONS, source_type: '계산', is_simulation: true,
    };
  }
  // 발주 수량 내역(사전 po_draft.qty_breakdown): 캠페인 추가분 + MOQ·올림분. 비중·금액은 문제 2 값을 그대로 쓰고,
  // 없을 때만 campaign_added_ea ÷ order_qty로 계산한다. 기준 수요 보충분은 발주안에 넣지 않는다(조정자 (F)-1)
  function campaignShareOf(c) {
    const q = parse(c?.qty_detail, {}) ?? {};
    const qb = q.qty_breakdown;
    const orderQty = Number(q.order_qty);
    if (qb?.campaign_added_ea == null || !orderQty) return { provided: false, amount_krw: c?.amount_krw ?? null };
    const share = Number(qb.campaign_added_ea) / orderQty;
    return {
      provided: true, order_qty: orderQty, campaign_added_ea: Number(qb.campaign_added_ea), rounding_ea: qb.rounding_ea ?? null,
      baseline_demand_ea: qb.baseline_demand_ea ?? null, campaign_by_plan: qb.campaign_by_plan ?? [],
      amount_krw: c.amount_krw, campaign_amount_krw: qb.campaign_amount_krw ?? Math.round(c.amount_krw * share),
      campaign_share_pct: qb.campaign_share_pct ?? Math.round(share * 10000) / 100,
    };
  }
  function campaignShareTotal(rows) {
    const got = rows.map(campaignShareOf);
    const known = got.filter((x) => x.provided);
    const amount = got.reduce((s, x) => s + (x.amount_krw ?? 0), 0);
    const campaign = known.reduce((s, x) => s + x.campaign_amount_krw, 0);
    const knownAmount = known.reduce((s, x) => s + x.amount_krw, 0);
    return {
      po_draft_count: rows.length, amount_krw: amount, campaign_amount_krw: known.length ? campaign : null,
      // 비중은 수량 내역이 있는 발주안의 금액만으로 계산한다
      campaign_share_pct: knownAmount ? Math.round((campaign / knownAmount) * 10000) / 100 : null,
      missing_breakdown_count: rows.length - known.length,
    };
  }
  // ── 재무 회신(모의) ──
  async function applyFinanceReply(financeReplyId) {
    const rows = replies.filter((r) => r.finance_reply_id === financeReplyId);
    if (rows.length === 0) throw ctx.httpError(404, `재무 회신 자료가 없습니다: ${financeReplyId}`);
    const done = db.prepare('SELECT * FROM p3_finance_reply_applied WHERE finance_reply_id = ?').get(financeReplyId);
    if (done) return toWindow(windowRow(done.window_version));
    const head = rows[0];
    const cur = currentWindow();
    const overrides = { ...parse(cur.ar_overrides, {}) };
    for (const r of rows) {
      const original = raw.ar.find((a) => a.ar_id === r.ar_id)?.due_date;
      if (original && r.ar_expected_receipt_date !== original) overrides[r.ar_id] = r.ar_expected_receipt_date;
    }
    const isConfirm = head.reply_event_type === 'FINANCE_CONFIRMED';
    const payload = isConfirm ? {
      finance_reply_id: financeReplyId, window_version_ref: cur.window_version,
      confirmed_window_start: head.confirmed_window_start, confirmed_window_end: head.confirmed_window_end,
      min_balance_ack_krw: Number(head.min_balance_ack_krw),
      ar_rows: rows.map((r) => ({ ar_id: r.ar_id, ar_expected_receipt_date: r.ar_expected_receipt_date })),
      buffer_level_status: head.buffer_level_status, scenario_id: head.scenario_id,
    } : {
      ar_id: head.ar_id, ar_expected_receipt_date: head.ar_expected_receipt_date, scenario_id: head.scenario_id, finance_reply_id: financeReplyId,
      ar_rows: rows.map((r) => ({ ar_id: r.ar_id, ar_expected_receipt_date: r.ar_expected_receipt_date, original_due_date: raw.ar.find((a) => a.ar_id === r.ar_id)?.due_date ?? null })),
    };
    const ev = await ctx.events.emit({
      event_type: head.reply_event_type, source_type: '모의회신', is_synthetic: true, actor_dept: 'FIN', actor_role: '재무팀(가상 회신)',
      occurred_at: head.occurred_at, effective_at: head.effective_at, scenario_id: head.scenario_id,
      subject_type: 'finance_reply', subject_id: financeReplyId, source_ref: rows.map((r) => r.source_ref),
      spec_ref: head.spec_ref, generation_reason: head.generation_reason, payload,
    });
    const after = compute({ arOverrides: overrides, drafts: approvedDraftFlows() });
    const mismatch = (after.shortfall_window_start !== head.confirmed_window_start || after.shortfall_window_end !== head.confirmed_window_end)
      ? `회신 구간 ${head.confirmed_window_start}~${head.confirmed_window_end} ≠ 계산 ${after.shortfall_window_start}~${after.shortfall_window_end}` : null;
    const { row } = await newWindowVersion({
      basis: isConfirm ? 'finance_confirmed' : 'scenario', scenarioId: head.scenario_id,
      financeStatus: '확인됨', financeReplyId, arOverrides: overrides, isSimulation: true, causedBy: ev.event_id, mismatch,
    });
    db.prepare('INSERT INTO p3_finance_reply_applied VALUES (?,?,?,?)').run(financeReplyId, ev.event_id, today(), row.window_version);
    db.prepare(`UPDATE p3_commitment SET finance_confirmation_status = '확인됨' WHERE active = 1`).run();
    return toWindow(row);
  }

  // ── 내부 승인과 공급 확약 ──
  const UNCONFIRMED_TYPES = new Set(['inbound_unconfirmed', 'supply_commitment_pending', 'baseline_replenishment_unconfirmed']);
  const internalApprovalLabel = (st) => ({
    승인: '내부 승인됨(구매·지출 허용, 공급 확약 아님)', 조건부: '내부 조건부 승인(구매·지출 허용, 공급 확약 아님)', '결재 대기': '내부 결재 대기',
    미상신: '내부 승인 요청 전', 거절: '내부 승인 거절', 취소: '발주안 취소',
  }[st] ?? st ?? '-');
  // 발주안의 Corevia 공급 확약 상태(문제 2 supply_commitment 최신 회신). 이 시스템은 원료·생산 일정을 계산하지 않고 회신 값만 싣는다
  function supplyStateOf(poDraftId, pd = null) {
    const p2m = p('p2');
    if (!p2m?.supplyCommitments) return { supply_commitment_status: '연결 안 됨', label: '공급 회신 정보 연결 안 됨' };
    const sc = p2m.supplyCommitments({ target_id: poDraftId, latest_only: true })?.[0] ?? null;
    const expected = pd?.expected_arrival_week ?? null;
    if (!sc) return { supply_commitment_status: '확인 대기', label: 'Corevia 공급 회신 전(도착은 발주 예정일 + 리드타임 추정)', expected_arrival_week: expected, waiting_on: 'Corevia 공급 회신' };
    const base = {
      supply_commitment_id: sc.supply_commitment_id, record_id: sc.record_id, reply_version: sc.reply_version, reply_as_of: sc.reply_as_of, replied_by: sc.replied_by,
      requested_qty: sc.requested_qty, committed_qty: sc.committed_qty, uncommitted_qty: sc.uncommitted_qty, offered_eta_date: sc.offered_eta_date,
      expected_eta_date: sc.expected_eta_date, arrives_by_needed_week: sc.arrives_by_needed_week, material_status: sc.material_status,
      material_available_date: sc.material_available_date, production_status: sc.production_status, production_complete_date: sc.production_complete_date,
      remaining_conditions: sc.remaining_conditions, validation_issues: sc.validation_issues ?? [],
    };
    if (sc.validation_status === '확인 필요') return { ...base, supply_commitment_status: '확인 필요', label: `Corevia 회신 확인 필요(${(sc.validation_issues ?? []).join(', ')})`, waiting_on: 'Corevia 정정 회신' };
    if (sc.reply_status === '미확인') return { ...base, supply_commitment_status: '확인 대기', label: 'Corevia 회신: 미확인(공급 가능 여부 미정)', waiting_on: 'Corevia 공급 회신' };
    if (sc.reply_status === '불가') return { ...base, supply_commitment_status: '공급 불가', label: 'Corevia 공급 불가 회신' };
    const done = sc.offered_eta_date && sc.offered_eta_date <= today();
    if (sc.reply_status === '부분 가능') return { ...base, supply_commitment_status: '부분 확약', label: `부분 확약: ${sc.committed_qty}EA(도착 ${sc.offered_eta_date}), 미확약 잔량 ${sc.uncommitted_qty}EA`, waiting_on: '미확약 잔량 회신' };
    return { ...base, supply_commitment_status: done ? '입고 완료' : '확약', label: done ? `입고 완료(확약 도착일 ${sc.offered_eta_date} 경과, 조회 기준)` : `확약: ${sc.committed_qty}EA, 도착 ${sc.offered_eta_date}` };
  }
  const CONDITION_KO = { inbound_unconfirmed: '미확정 입고', reorder_required: '보충 발주 필요', supply_commitment_pending: '공급 확약 대기', baseline_replenishment_unconfirmed: '기준 수요 보충 미확인' };
  const unconfirmedText = (x) => {
    const t = x.condition_type ?? (x.inbound_row_id ? 'inbound_unconfirmed' : null);
    const what = t === 'supply_commitment_pending' ? '승인된 발주안의 Corevia 공급 확약 회신 전'
      : t === 'baseline_replenishment_unconfirmed' ? (x.reason ?? 'SCM 기준 수요 보충 계획 미확인')
      : '입고 예정일 회신 전';
    return { condition_type: t, label: CONDITION_KO[t], sku_id: x.sku_id ?? null, text: `${CONDITION_KO[t]}: ${what}${x.eta_date ? `, 예상 도착 ${x.eta_date}` : ''}${x.after_sale_shortage_ea ? `, 판매 기간 뒤 부족 ${x.after_sale_shortage_ea}EA` : ''}` };
  };
  // 현금 재전망의 한계(사용자 요청 2026-11-15 라·다, 조정자 확정 L6)
  const SCM_WHY_NOT_BASELINE = '정책 재전망 산식에는 앞으로의 판매 대금 유입이 없어 기준 수요 보충 발주의 지급만 넣으면 잔액이 한쪽으로 낮게 왜곡되므로, 기준선(경로 판정)에는 넣지 않고 민감도로 따로 보인다.';
  const CASH_LIMITATIONS = [
    `SCM 기준 수요 정기 보충 발주의 지급은 기준선 재전망에 들어 있지 않다. ${SCM_WHY_NOT_BASELINE} 민감도 금액은 SCM이 확인한 보충 계획 수량 × 원본 발주 단가로 도출한 값이다.`,
    '부분 공급 회신이어도 발주안 지급 금액은 원래 발주 금액 그대로 둔다. 부분 공급 때의 지급 조건은 원본에 근거가 없다.',
  ];

  // ── SCM 정기 보충 발주 민감도(조정자 확정 L6) ──
  // 금액 = SCM 확인 보충 계획 수량(모의 회신) × 원본 발주 단가(sc_purchase_orders_ms amount_krw ÷ order_qty, SKU별), 지급일 = 공급처 결제 조건(S3-01)
  const unitPriceOfSku = new Map(raw.po.map((r) => [r.sku_id, ctx.toNum(r.amount_krw) / ctx.toNum(r.order_qty)]));
  function scmReplenishmentRows() {
    const p2m = p('p2');
    if (!p2m?.baselineReplenishment) return null;
    const out = [];
    for (const s of p2m.baselineReplenishment({}) ?? []) {
      if (s.scm_confirmed !== '확인') continue; // SCM이 확인한 계획만
      const term = termOf.get(supplierOfSku.get(s.sku_id));
      const price = unitPriceOfSku.get(s.sku_id) ?? null;
      for (const r of s.plan_rows ?? []) {
        if (!r.planned_order_date || /^POD-|po_draft/.test(String(r.source_ref ?? ''))) continue; // 캠페인 발주안은 이미 약정으로 셈(이중 계산 방지)
        const due = term ? C.paymentDueDate(r.planned_order_date, term) : null;
        out.push({
          source_ref: r.source_ref, sku_id: s.sku_id, qty: r.qty, planned_order_date: r.planned_order_date, eta_date: r.eta_date ?? null,
          supply_status: r.supply_status ?? null, corevia_committed: s.corevia_committed ?? null, unit_price_krw: price,
          amount_krw: price == null ? null : Math.round(r.qty * price), payment_due_date: due, in_horizon: Boolean(due && due <= C.HORIZON_END),
          record_ids: s.record_ids ?? [],
        });
      }
    }
    return out;
  }
  // 민감도에서 승인권자가 달라지는 약정(경로 판정은 기준선으로 한다)
  function sensitivityRouteDiffs(sensSegments, extraFlows, arOverrides, onlyId) {
    const ids = onlyId ? [onlyId] : activeJudgeable().filter((cid) => !isTerminal(commitRow(cid)));
    const out = [];
    for (const cid of ids) {
      const c = commitRow(cid);
      if (!c || c.active !== 1 || c.is_new_commitment !== 1) continue;
      const base = evaluate(c).r;
      let segs = sensSegments;
      if (c.commitment_type === '발주안' && c.draft_approved !== 1) {
        segs = compute({ arOverrides, drafts: [...approvedDraftFlows(), ...extraFlows, { ref: c.source_id, date: c.payment_due_date, amount_krw: c.amount_krw }] }).segments;
      }
      const sens = C.judgeRoute({ commitment_type: c.commitment_type, is_new_commitment: true, cash_outflow_date: c.cash_outflow_date, amount_krw: c.amount_krw }, segs, bundleTotals.get(c.plan_bundle_id) ?? 0);
      if (sens.approver !== base.approver) {
        out.push({ commitment_id: cid, plan_id: c.plan_id, source_id: c.source_id, commitment_type: c.commitment_type, cash_outflow_date: c.cash_outflow_date,
          baseline_approver: base.approver, sensitivity_approver: sens.approver, label: `정기 보충 발주를 넣으면 ${approverName(sens.approver)} 경로(기준선은 ${approverName(base.approver)})` });
      }
    }
    return out;
  }
  function scmReplenishmentSensitivity({ scenario_id, commitment_id } = {}) {
    const rows = scmReplenishmentRows();
    const w = (scenario_id && latestWindowRow(scenario_id)) || currentWindow();
    const arOverrides = parse(w.ar_overrides, {});
    const approved = approvedDraftFlows();
    const flows = (rows ?? []).filter((r) => r.amount_krw != null && r.in_horizon).map((r) => ({ ref: `SCM-BR:${r.source_ref}`, date: r.payment_due_date, amount_krw: r.amount_krw }));
    const baseCalc = compute({ arOverrides, drafts: approved });
    const sensCalc = flows.length ? compute({ arOverrides, drafts: [...approved, ...flows] }) : baseCalc;
    const sum = (xs) => xs.reduce((t, r) => t + (r.amount_krw ?? 0), 0);
    return {
      connected: rows != null, window_version: w.window_version, scenario_id: w.scenario_id, threshold,
      baseline: windowView(baseCalc), with_scm_replenishment: windowView(sensCalc),
      min_balance_delta_krw: sensCalc.min_balance_krw - baseCalc.min_balance_krw,
      confirmed_row_count: rows?.length ?? 0, amount_total_krw: sum(rows ?? []),
      in_horizon_row_count: flows.length, in_horizon_amount_krw: sum(flows),
      rows: rows ?? [],
      route_differences: rows?.length ? sensitivityRouteDiffs(sensCalc.segments, flows, arOverrides, commitment_id) : [],
      why_not_in_baseline: SCM_WHY_NOT_BASELINE,
      basis: '금액 = SCM이 확인한 보충 계획 수량(모의 회신) × 원본 발주 단가(sc_purchase_orders_ms의 amount_krw ÷ order_qty, SKU별, 원본에서 도출). 지급일 = 공급처 결제 조건(월 마감 익월 21일, 합성 S3-01). 재전망 끝(09-30) 뒤 지급분은 제외. 캠페인 발주안은 약정으로 이미 세므로 넣지 않는다.',
      source_type: '계산', is_simulation: true,
    };
  }
  const scmSummary = (x, cid) => ({
    connected: x.connected, baseline: x.baseline, with_scm_replenishment: x.with_scm_replenishment, min_balance_delta_krw: x.min_balance_delta_krw,
    confirmed_row_count: x.confirmed_row_count, amount_total_krw: x.amount_total_krw, in_horizon_row_count: x.in_horizon_row_count,
    in_horizon_amount_krw: x.in_horizon_amount_krw, route_difference: x.route_differences.find((d) => d.commitment_id === cid) ?? null,
    why_not_in_baseline: x.why_not_in_baseline, basis: x.basis,
  });

  // ── 상신 문서 ──
  function submissionPackage(key) {
    const req = reqRow(key);
    const ids = req ? parse(req.commitment_ids, []) : [key];
    const rows = ids.map((cid) => {
      const c = toCommitment(commitRow(cid));
      if (!c) return null;
      const sj = c.plan_id !== 'NONE' ? p('p2')?.latestSupplyJudgment?.(c.plan_id) ?? null : null;
      const basis = sj?.plan?.condition_basis ?? [];
      const draftById = (id) => p('p2')?.poDrafts?.({ po_draft_id: id })?.[0] ?? null;
      const draftInfo = (poDraftId, extra = {}) => {
        const dc = commitRow(`CMT-${poDraftId}`);
        const pd = draftById(poDraftId);
        const planned = pd?.planned_order_date ?? dc?.planned_order_date ?? null;
        const deadline = extra.order_deadline ?? pd?.order_deadline ?? null;
        const imp = dc ? approvalImpact({ commitment_id: dc.commitment_id }) : null;
        return {
          // 이 발주안을 승인하면: 승인 전후 최저 잔액·하회 구간, 발주액 중 캠페인 추가분(조정자 (E)-(3))
          cash_impact: imp ? { before: imp.before, after: imp.after, after_below_zero: imp.after_below_zero, notes: imp.notes } : null,
          campaign_share: dc ? campaignShareOf(dc) : null, linked_plan_ids: dc ? parse(dc.linked_plan_ids, []) : [],
          po_draft_id: poDraftId, sku_id: extra.sku_id ?? pd?.sku_id ?? null, required_qty: extra.required_qty ?? null,
          order_qty: pd?.order_qty ?? null, planned_order_date: planned,
          order_deadline: deadline ?? planned, order_deadline_basis: deadline ? 'order_deadline' : 'planned_order_date',
          commitment_id: dc?.commitment_id ?? null, payment_due_date: dc?.payment_due_date ?? null, approver: dc?.approver ?? null,
          route_rule_id: dc?.route_rule_id ?? null, approval_status: dc?.approval_status ?? '경로 판정 전',
          matched_segment: dc ? parse(latestRj(dc.commitment_id)?.matched_segment) : null,
          // 내부 승인(구매·지출 허용)과 Corevia 공급 확약(수량·납기 약속)은 다른 상태다
          internal_approval_status: dc?.approval_status ?? '경로 판정 전',
          internal_approval_label: internalApprovalLabel(dc?.approval_status),
          supply_commitment: supplyStateOf(poDraftId, pd),
          residual_after_withdrawal: parse(dc?.residual_after_withdrawal), cancel_info: parse(dc?.cancel_info), withdrawal_info: parse(dc?.withdrawal_info),
        };
      };
      // 보충 발주 필요 조건의 발주안과 발주 시한(이 날까지 발주해야 조건을 지킬 수 있다)
      const reorderIds = new Set(basis.filter((x) => x.condition_type === 'reorder_required' && x.po_draft_id).map((x) => x.po_draft_id));
      const draftConditions = [
        ...basis.filter((x) => x.condition_type === 'reorder_required' && x.po_draft_id).map((x) => draftInfo(x.po_draft_id, x)),
        ...(c.plan_id !== 'NONE' ? draftsOfPlan(c.plan_id).filter((d) => !reorderIds.has(d.source_id)).map((d) => draftInfo(d.source_id)) : []),
        ...(c.commitment_type === '발주안' ? [draftInfo(c.source_id)] : []),
      ];
      // 기안은 그 기안에 걸린 발주안(거절 제외)을 모두 승인했을 때, 발주안은 자신을 승인했을 때의 재전망
      const linked = c.commitment_type === '발주안' ? [commitRow(cid)]
        : c.plan_id !== 'NONE' ? draftsOfPlan(c.plan_id).filter((d) => d.approval_status !== '거절') : [];
      const cashImpact = approvalImpact({ commitment_ids: linked.length ? linked.map((d) => d.commitment_id) : [cid] });
      return {
        po_draft_conditions: draftConditions,
        cash_impact: cashImpact,
        campaign_share: campaignShareTotal(linked),
        commitment: c, route_judgment: toRj(latestRj(cid)),
        supply_judgment: sj ? sj.plan ?? null : null,
        // 조건부 판정의 조건 종류: inbound_unconfirmed(미확정 입고) / reorder_required(보충 발주 필요)
        supply_conditions: basis.map((x) => ({ ...x, condition_type: x.condition_type ?? (x.inbound_row_id ? 'inbound_unconfirmed' : null) })),
        // 공급 확약·확인이 아직 없는 조건(문제 2 v2.0): 승인으로 풀리지 않고 Corevia·SCM 회신으로만 풀린다
        unconfirmed_supply_conditions: basis.filter((x) => UNCONFIRMED_TYPES.has(x.condition_type ?? (x.inbound_row_id ? 'inbound_unconfirmed' : null)))
          .map((x) => unconfirmedText(x)),
        cash_limitations: CASH_LIMITATIONS,
        scm_sensitivity: scmSummary(scmReplenishmentSensitivity({ commitment_id: cid }), cid),
        condition_types: [...new Set(basis.map((x) => x.condition_type ?? (x.inbound_row_id ? 'inbound_unconfirmed' : null)).filter(Boolean))],
        supply_connected: Boolean(p('p2')),
        demand_status_by_plan: c.plan_id !== 'NONE' ? p('p1')?.demandStatusByPlan?.(c.plan_id) ?? null : null,
        demand_connected: Boolean(p('p1')),
        deadline_schedule: deadlineOf(cid),
        contribution_margin_status: '미산정',
      };
    }).filter(Boolean);
    return { approval_request: toReq(req), rows };
  }

  const krwText = (n) => (n == null ? '-' : `${Number(n).toLocaleString('ko-KR')}원`);
  const windowText = (x) => (x.shortfall_window_start ? `${x.shortfall_window_start}~${x.shortfall_window_end}(${x.shortfall_bd_count}영업일)` : '없음');
  // 품목 이름과, 승인권자가 읽는 문서에서 코드를 업무 용어로 바꾸는 도구
  const skuNameOf = (id) => (id ? raw.sku.find((x) => x.sku_id === id)?.sku_name ?? '품목 미상' : '품목 미상');
  const skuOfDraft = (poDraftId) => p('p2')?.poDrafts?.({ po_draft_id: poDraftId })?.[0]?.sku_id ?? parse(commitRow(`CMT-${poDraftId}`)?.qty_detail, {})?.sku_id ?? null;
  const TERM_KO = {
    contract_deadline: '확정기한', settlement_date: '집행 예정일', cash_outflow_date: '현금 유출일', planned_order_date: '발주 예정일',
    order_deadline: '발주 시한', payment_due_date: '지급 예정일', approval_anchor_date: '승인 기준일', submission_due: '상신 마감',
    final_reply_due: '최종 회신 마감', min_balance_krw: '최저 잔액', min_date: '최저 잔액일', shortfall_window_start: '하회 구간 시작',
    shortfall_window_end: '하회 구간 끝', approval_status: '승인 상태', supply_verdict: '공급 판정', demand_status: '수요 입력 상태',
    supply_commitment: '공급 확약', requested_budget_krw: '요청액', amount_krw: '금액', ...CONDITION_KO,
  };
  // AI 출력·양식 문장에 섞인 코드를 화면에 보이기 전에 바꾼다(수치·날짜는 건드리지 않는다)
  function businessTerms(text) {
    return String(text ?? '')
      .replace(/\bCMT-(?=PLAN-|POD-|PD-)/g, '')
      .replace(/\bPLAN-\d{3}\b/g, (m) => { const c = campaignOf(m); return c ? `${c.campaign_name} 캠페인` : '해당 기안'; })
      .replace(/\b(?:POD-\d+|PD-[A-Z0-9]+)\b(?:\s*\(SKU-\d{4}\))?/g, (m) => `${skuNameOf(skuOfDraft(m.replace(/\s*\(.*$/, '')))} 보충 발주`)
      .replace(/\bSKU-\d{4}\b/g, (m) => skuNameOf(m))
      .replace(/\b(GRP_CEO|MS_CEO|MKT_TEAM)\b/g, (m) => approverName(m))
      .replace(/\bR-0[0-4]\b/g, (m) => `'${LABELS.route[m]}' 기준`)
      .replace(/\b[a-z]+(?:_[a-z]+)+\b/g, (m) => TERM_KO[m] ?? m)
      .replace(/\b(?:RJ|CW|APR|DRF)-\d+\b/g, '')
      .replace(/\(\s*(?:,\s*)+/g, '(').replace(/(?:\s*,)+\s*\)/g, ')').replace(/,\s*(?:,\s*)+/g, ', ')
      .replace(/\(\s*\)/g, '').replace(/[ \t]{2,}/g, ' ');
  }
  function templateDraft(pkg) {
    const lines = ['[상신 문서 초안 · 양식(AI 미연결 또는 미사용)]'];
    for (const r of pkg.rows) {
      const c = r.commitment;
      const rj = r.route_judgment;
      // 승인권자가 읽는 문서: 캠페인·품목 이름과 업무 용어만 쓴다(시스템 번호·영문 이름 없음)
      const camp = c.plan_id !== 'NONE' ? campaignOf(c.plan_id) : null;
      const title = c.commitment_type === '발주안' ? `보충 발주(${skuNameOf(skuOfDraft(c.source_id))})` : `캠페인 ${camp ? `${camp.campaign_name}(${camp.product_line})` : '기안'}`;
      lines.push(`- ${title}: 현금 유출일 ${c.cash_outflow_date}, 금액 ${Number(c.amount_krw).toLocaleString('ko-KR')}원${c.amount_scale === 'sample' ? '(표본 스케일)' : ''}.`);
      lines.push(`  승인권자 ${approverName(c.approver)}${c.group_report_required ? '(그룹 보고 필요)' : ''}: ${RULE_TEXT[c.route_rule_id] ?? '-'} 유출일은 하회 구간 ${rj?.in_window ? '안' : '밖'}. 재무 확인 ${c.finance_confirmation_status}.`);
      lines.push(`  승인 기준일 ${c.approval_anchor_date}(${LABELS.anchor_basis[c.anchor_basis] ?? '기준일'}), 상신 마감 ${r.deadline_schedule?.submission_due ?? '연결 안 됨'}, 최종 회신 마감 ${r.deadline_schedule?.final_reply_due ?? '연결 안 됨'}.`);
      lines.push(`  공급 판정 ${r.supply_judgment?.supply_verdict ?? (r.supply_connected ? '없음' : '연결 안 됨')}${r.condition_types.length ? `(조건: ${r.condition_types.map((t) => LABELS.condition_type[t] ?? '기타 조건').join(', ')})` : ''}, 수요 입력 ${r.demand_status_by_plan?.demand_status ?? (r.demand_connected ? '없음' : '연결 안 됨')}.`);
      for (const d of r.po_draft_conditions) {
        lines.push(`  보충 발주(${skuNameOf(d.sku_id ?? skuOfDraft(d.po_draft_id))}): 발주 시한 ${d.order_deadline ?? '-'}${d.order_deadline_basis === 'planned_order_date' ? '(발주 예정일로 대신 표시)' : ''}, 지급 ${d.payment_due_date ?? '-'}, ${approverName(d.approver)} ${d.internal_approval_label}.`);
        if (d.residual_after_withdrawal) lines.push(`    기안 철회 뒤 남은 발주: 발주가 이미 전달돼 취소하지 않음, 지급 유출 유지, SCM 취소·조정 확인 대상.`);
        lines.push(`    Corevia 공급 확약: ${d.supply_commitment?.label ?? '-'}${d.supply_commitment?.remaining_conditions ? `(남은 조건: ${d.supply_commitment.remaining_conditions})` : ''}.`);
        if (d.cash_impact) lines.push(`    승인 시 최저 잔액 ${krwText(d.cash_impact.before.min_balance_krw)} → ${krwText(d.cash_impact.after.min_balance_krw)}, 하회 구간 ${windowText(d.cash_impact.before)} → ${windowText(d.cash_impact.after)}${d.campaign_share?.provided ? `, 발주 ${d.campaign_share.order_qty.toLocaleString('ko-KR')}EA = 캠페인 추가분 ${d.campaign_share.campaign_added_ea.toLocaleString('ko-KR')}EA(${d.campaign_share.campaign_share_pct}%) + MOQ·올림분 ${Number(d.campaign_share.rounding_ea ?? 0).toLocaleString('ko-KR')}EA` : ', 수량 내역 없음'}.`);
      }
      if (r.unconfirmed_supply_conditions.length) lines.push(`  미확인 공급 조건(승인으로 풀리지 않고 Corevia·SCM 회신으로만 풀림): ${r.unconfirmed_supply_conditions.map((x) => `${x.sku_id ? `${skuNameOf(x.sku_id)} ` : ''}${x.text}`).join(' / ')}.`);
      const ci = r.cash_impact;
      lines.push(`  현금 영향(관련 발주안 모두 승인 가정): 최저 잔액 ${krwText(ci.before.min_balance_krw)}(${ci.before.min_date}) → ${krwText(ci.after.min_balance_krw)}(${ci.after.min_date}), 하회 구간 ${windowText(ci.before)} → ${windowText(ci.after)}${ci.after_below_zero ? '. 승인 후 최저 잔액이 0원 미만(Masil 단독 지급 재원 없음)' : ''}.`);
      lines.push(`  현금 재전망 한계: ${r.cash_limitations.join(' ')}`);
      const ss = r.scm_sensitivity;
      if (ss.confirmed_row_count) lines.push(`  SCM 정기 보충 발주 민감도: 확인된 보충 발주 ${ss.confirmed_row_count}건(재전망 기간 지급 ${ss.in_horizon_row_count}건 ${krwText(ss.in_horizon_amount_krw)})을 넣으면 최저 잔액 ${krwText(ss.baseline.min_balance_krw)} → ${krwText(ss.with_scm_replenishment.min_balance_krw)}(${ss.with_scm_replenishment.min_date}), 하회 구간 ${windowText(ss.baseline)} → ${windowText(ss.with_scm_replenishment)}.${ss.route_difference ? ` ${ss.route_difference.label}.` : ''} 승인 경로는 기준선으로 정한다.`);
      if (r.campaign_share.po_draft_count) lines.push(`  발주액 ${krwText(r.campaign_share.amount_krw)} 중 캠페인 추가분 ${r.campaign_share.campaign_share_pct == null ? '수량 내역 없음' : `${krwText(r.campaign_share.campaign_amount_krw)}(${r.campaign_share.campaign_share_pct}%)`}.`);
      lines.push('  실질 공헌이익: 미산정. 예상 GMV는 승인 근거가 아님(쿠폰·반품·광고비·물류비 차감 전).');
    }
    return lines.join('\n');
  }

  // 승인권자가 읽는 문서다. 시스템 번호·영문 필드 이름·규칙 번호·승인권자 코드를 쓰지 않고 캠페인 이름과 업무 용어로 쓴다.
  // 수치·날짜·판정은 상신 자료(시스템 값)에 있는 것만 인용한다
  const SUBMISSION_DRAFT_PROMPT = [
    '너는 Masil 마케팅 기안 담당자를 도와 승인권자에게 올릴 승인 요청 문서 초안을 쓰는 보조자다.',
    '상신 자료에 있는 값만 쓴다. 숫자·날짜·금액·승인권자·판정은 바꾸거나 새로 만들거나 계산하지 않고 그대로 인용한다.',
    '승인권자가 읽는 문서이므로 캠페인 이름과 업무 용어로만 쓴다. 시스템 번호(예: CMT-, PLAN-, RJ-, CW-, APR-, POD-, DRF-로 시작하는 값), 영문 필드 이름(예: contract_deadline, cash_outflow_date), 규칙 번호(예: R-01), 승인권자 코드(예: GRP_CEO, MS_CEO)는 쓰지 않는다.',
    '구성: 요청 내용(캠페인·요청액·집행 예정일) → 승인권자와 그 이유 → 현금 상황(하회 구간, 승인 전후 최저 잔액) → 공급·수요 확인 결과와 조건 → 보충 발주(있으면) → 실질 공헌이익.',
    '발주안의 내부 승인은 구매·지출 허용일 뿐 Corevia 공급 확약이 아니다. 발주안마다 내부 승인 상태와 공급 확약 상태를 따로 적고, 미확인 공급 조건과 현금 재전망 한계를 빠짐없이 그대로 적는다. 확약되지 않은 공급을 확보·확정·입고로 바꿔 쓰지 않는다.',
    '예상 GMV는 승인 근거로 쓰지 않고 "실질 공헌이익: 미산정"을 적는다. 자료에 "연결 안 됨"으로 있는 항목은 "확인되지 않음"으로 쓴다. 한국어 평서문.',
  ].join('\n');
  // AI 입력용 상신 자료: 코드 대신 캠페인 이름과 한국어 항목 이름, 값은 시스템 값을 형식만 바꿔 넣는다
  function submissionDocInput(pkg) {
    const wonT = (n) => (n == null ? '없음' : `${Math.round(Number(n)).toLocaleString('ko-KR')}원`);
    const winT = (x) => {
      if (!x?.shortfall_window_start) return '없음';
      const segs = x.segments ?? [];
      return segs.length > 1 ? segs.map((g) => `${g.start}~${g.end}(${g.bd_count}영업일, 최저 ${wonT(g.min_balance_krw)})`).join(', ') : `${x.shortfall_window_start}~${x.shortfall_window_end}(${x.shortfall_bd_count}영업일)`;
    };
    const skuName = (id) => raw.sku.find((s) => s.sku_id === id)?.sku_name ?? '품목 미상';
    return pkg.rows.map((r) => {
      const c = r.commitment;
      const camp = c.plan_id !== 'NONE' ? campaignOf(c.plan_id) : null;
      const ds = r.deadline_schedule;
      return {
        구분: c.commitment_type === '발주안' ? '보충 발주' : '캠페인 기안',
        캠페인: camp ? `${camp.campaign_name}(${camp.product_line})` : null,
        요청액: `${wonT(c.amount_krw)}${c.amount_scale === 'sample' ? '(표본 스케일 금액)' : ''}`,
        현금_유출일: c.cash_outflow_date,
        승인권자: approverName(c.approver), 그룹_보고_필요: c.group_report_required ? '예' : '아니오',
        승인_이유: RULE_TEXT[c.route_rule_id] ?? '없음',
        유출일과_하회_구간: r.route_judgment?.in_window ? '하회 구간 안' : '하회 구간 밖',
        승인_기준일: `${c.approval_anchor_date}(${LABELS.anchor_basis[c.anchor_basis] ?? '기준일'})`,
        상신_마감: ds?.submission_due ?? '연결 안 됨', 최종_회신_마감: ds?.final_reply_due ?? '연결 안 됨',
        재무_확인: c.finance_confirmation_status,
        현금_하회_구간: winT(r.cash_impact?.before), 현재_최저_잔액: `${wonT(r.cash_impact?.before.min_balance_krw)}(${r.cash_impact?.before.min_date ?? '-'})`,
        관련_발주_모두_승인_시_최저_잔액: r.cash_impact?.added_outflows.length ? `${wonT(r.cash_impact.after.min_balance_krw)}(${r.cash_impact.after.min_date}), 하회 구간 ${winT(r.cash_impact.after)}` : '추가 현금 유출 없음',
        공급_판정: r.supply_judgment?.supply_verdict ?? (r.supply_connected ? '없음' : '연결 안 됨'),
        공급_조건: r.condition_types.map((t) => LABELS.condition_type[t] ?? '기타 조건'),
        미확인_공급_조건: r.unconfirmed_supply_conditions.map((x) => `${x.sku_id ? `${skuNameOf(x.sku_id)}: ` : ''}${businessTerms(x.text)}`),
        현금_재전망_한계: r.cash_limitations,
        정기_보충_발주_민감도: r.scm_sensitivity.confirmed_row_count ? {
          확인된_보충_발주: `${r.scm_sensitivity.confirmed_row_count}건, 재전망 기간 지급 ${r.scm_sensitivity.in_horizon_row_count}건 ${wonT(r.scm_sensitivity.in_horizon_amount_krw)}(원본 단가로 도출, 수량·발주일은 SCM 모의 회신)`,
          기준선: `최저 ${wonT(r.scm_sensitivity.baseline.min_balance_krw)}, 하회 구간 ${winT(r.scm_sensitivity.baseline)}`,
          보충_발주_포함: `최저 ${wonT(r.scm_sensitivity.with_scm_replenishment.min_balance_krw)}, 하회 구간 ${winT(r.scm_sensitivity.with_scm_replenishment)}`,
          승인_경로_차이: r.scm_sensitivity.route_difference?.label ?? '없음(승인 경로는 기준선으로 정함)',
          기준선에_넣지_않는_이유: r.scm_sensitivity.why_not_in_baseline,
        } : '확인된 정기 보충 계획 없음',
        수요_입력: r.demand_status_by_plan?.demand_status ?? (r.demand_connected ? '없음' : '연결 안 됨'),
        보충_발주: r.po_draft_conditions.map((d) => ({
          품목: skuName(d.sku_id), 발주_시한: d.order_deadline, 지급_예정일: d.payment_due_date, 승인권자: approverName(d.approver),
          내부_승인: d.internal_approval_label, Corevia_공급_확약: d.supply_commitment?.label ?? '없음',
          공급_남은_조건: d.supply_commitment?.remaining_conditions ?? '없음', 원료_확보: d.supply_commitment?.material_status ?? '회신 전', 생산_배정: d.supply_commitment?.production_status ?? '회신 전',
          수량_내역: d.campaign_share?.provided ? `발주 ${d.campaign_share.order_qty}EA 중 캠페인 추가분 ${d.campaign_share.campaign_added_ea}EA(${d.campaign_share.campaign_share_pct}%), MOQ·올림분 ${d.campaign_share.rounding_ea ?? 0}EA` : '수량 내역 없음',
        })),
        발주액_중_캠페인_추가분: r.campaign_share.po_draft_count ? (r.campaign_share.campaign_share_pct == null ? '수량 내역 없음' : `${wonT(r.campaign_share.campaign_amount_krw)}(${r.campaign_share.campaign_share_pct}%)`) : '관련 발주 없음',
        실질_공헌이익: '미산정(예상 GMV는 승인 근거가 아님)',
      };
    });
  }
  async function prepareDraft(commitmentId) {
    const pkg = submissionPackage(commitmentId);
    if (pkg.rows.length === 0) throw ctx.httpError(404, `약정이 없습니다: ${commitmentId}`);
    const n = nextN('p3_draft');
    const id = `DRF-${pad(n, 4)}`;
    let text = businessTerms(templateDraft(pkg));
    let mode = '양식';
    let aiCallId = null;
    let review = '해당 없음';
    const r = await ctx.ai.call({
      ai_task_type: 'write', ai_task_name: 'submission_draft', plan_id: pkg.rows[0].commitment.plan_id,
      input_refs: pkg.rows.map((x) => x.commitment.route_judgment_id).filter(Boolean),
      messages: [
        { role: 'system', content: SUBMISSION_DRAFT_PROMPT },
        { role: 'user', content: `상신 자료:\n${JSON.stringify(submissionDocInput(pkg), null, 2)}` },
      ],
    });
    // AI 출력에 코드가 섞여 와도 화면에 보이기 전에 품목 이름·업무 용어로 바꾼다(원문은 AI 호출 기록에 남는다)
    if (r.status === '연결') { text = businessTerms(r.output); mode = 'AI'; aiCallId = r.ai_call_id; review = '확인 대기'; }
    db.prepare('INSERT INTO p3_draft (draft_id, n, commitment_id, text, mode, ai_call_id, review_status, created_on) VALUES (?,?,?,?,?,?,?,?)').run(id, n, commitmentId, text, mode, aiCallId, review, today());
    return db.prepare('SELECT * FROM p3_draft WHERE draft_id = ?').get(id);
  }

  // ── 사건 구독 ──
  ctx.events.on('PLAN_RECEIVED', async (e) => {
    if (!e.plan_id || e.plan_id === 'NONE') return;
    const existed = Boolean(commitRow(`CMT-${e.plan_id}`));
    const id = ensurePlanCommitment(e.plan_id);
    if (!existed || !latestRj(id)) await judge(id, { causedBy: e.event_id });
  });
  ctx.events.on('PO_DRAFT_CREATED', async (e) => {
    const d = e.payload ?? {};
    if (!d.po_draft_id) return;
    const { id, changed, windowEvent } = await upsertDraftCommitment(d, e.event_id);
    if (changed) await judge(id, { causedBy: windowEvent?.event_id ?? e.event_id });
  });
  ctx.events.on('PO_DRAFT_CANCELLED', async (e) => {
    const id = `CMT-${e.payload?.po_draft_id}`;
    const c = commitRow(id);
    if (!c || c.active !== 1) return; // 이미 취소(공급 불가 포함)된 약정이면 유출을 두 번 빼지 않는다
    // 취소된 발주안은 상태를 '취소'로 두고 상신·판정 대상에서 뺀다(active=0이면 판정·묶음·상신·회신이 모두 건너뛴다). 조정자 (F) 가
    // 취소 구분은 문제 2 사건 그대로: withdrawal.disposition='취소'면 기안 철회로 취소. 연결 기안도 문제 2 값(linked_plan_ids_before)
    const pl = e.payload ?? {};
    const reason = pl.cancel_reason ?? null;
    const kind = pl.withdrawal ? '기안 철회로 취소' : '발주안 취소';
    updateCommitment(id, { active: 0, approval_status: '취소', effective_at: today(),
      linked_plan_ids: json(pl.linked_plan_ids ?? parse(c.linked_plan_ids, [])),
      cancel_info: json({ kind, reason, event_id: e.event_id, on: today(), plan_ids: pl.linked_plan_ids_before ?? parse(c.linked_plan_ids, []),
        withdrawal: pl.withdrawal ?? null, outflow_removed: c.draft_approved === 1 }) });
    if (c.draft_approved === 1) {
      const w = currentWindow();
      await newWindowVersion({ basis: w.window_basis, scenarioId: w.scenario_id, financeStatus: w.finance_confirmation_status, financeReplyId: w.finance_reply_id, arOverrides: parse(w.ar_overrides, {}), isSimulation: w.is_simulation === 1, causedBy: e.event_id });
    }
  });
  ctx.events.on('ALTERNATIVE_SELECTED', async (e) => {
    const planId = e.payload?.plan_id ?? e.plan_id;
    const c = planId && planId !== 'NONE' ? commitRow(`CMT-${planId}`) : null;
    if (!c || c.active !== 1) return;
    const pc = e.payload?.plan_change;
    if (pc && (pc.settlement_date || pc.requested_budget_krw != null)) {
      const settlement = pc.settlement_date ?? c.settlement_date;
      const anchor = C.anchorFor({ commitment_type: '기안', settlement_date: settlement, contract_deadline: c.contract_deadline });
      updateCommitment(c.commitment_id, {
        settlement_date: settlement, cash_outflow_date: settlement,
        amount_krw: pc.requested_budget_krw != null ? ctx.toNum(pc.requested_budget_krw) : c.amount_krw,
        approval_anchor_date: anchor.approval_anchor_date, anchor_basis: anchor.anchor_basis, effective_at: pc.effective_at ?? today(),
        source_type: '사람입력', is_synthetic: 1, source_ref: `${c.source_ref};plan_change#${planId}:v${pc.plan_version ?? '?'}`,
      });
      await judge(c.commitment_id, { causedBy: e.event_id, resubmit: true });
    } else if (c.approval_status === '거절') {
      await judge(c.commitment_id, { causedBy: e.event_id, resubmit: true });
    }
  });
  ctx.events.on('APPROVAL_REPLIED', async (e) => {
    const r = e.payload ?? {};
    const req = r.approval_request_id ? reqRow(r.approval_request_id) : null;
    const targets = r.commitment_id ? [r.commitment_id] : parse(req?.commitment_ids, []);
    for (const cid of targets) {
      if (isSupersededFor(req, cid)) { ctx.log(`대체된 상신(${req.approval_request_id})의 ${cid} 회신은 반영하지 않습니다`); continue; }
      const c = commitRow(cid);
      if (!c || c.active !== 1) continue;
      if (!['승인', '조건부', '거절'].includes(r.decision)) continue;
      // 공급 위험 수용: 승인 상태의 속성으로만 남기고 공급 상태는 바꾸지 않는다(문제 4가 payload에 싣는다)
      const riskConds = (r.conditions ?? []).filter((x) => x.acceptance_type === '공급 위험 수용');
      if (r.decision !== '거절' && (r.supply_risk_accepted === true || riskConds.length)) {
        updateCommitment(cid, { supply_risk_acceptance: json({
          accepted: true, accepted_condition_types: r.accepted_condition_types ?? [...new Set(riskConds.map((x) => x.condition_type).filter(Boolean))],
          approver: r.approver ?? null, approval_request_id: r.approval_request_id ?? null, replied_at: r.replied_at ?? e.occurred_at, event_id: e.event_id,
          note: '승인권자가 공급 위험을 받아들인 것이며 Corevia 공급 확약이 아니다. 공급 상태는 그대로다.',
        }) });
      }
      if (c.approval_status !== '결재 대기') {
        // 이미 승인된 약정에 조건 수용 회신이 오면 상태는 두고 조건을 기록한다((D)-2 나)
        if (['승인', '조건부'].includes(c.approval_status) && r.decision !== '거절' && (r.conditions ?? []).length) {
          const merged = [...parse(c.conditions, [])];
          for (const x of r.conditions) if (!merged.some((m) => JSON.stringify(m) === JSON.stringify(x))) merged.push(x);
          updateCommitment(cid, { conditions: json(merged) });
        } else ctx.log(`결재 대기가 아닌 약정의 회신: ${cid} (${c.approval_status}, ${r.decision})`);
        continue;
      }
      updateCommitment(cid, { approval_status: r.decision, conditions: json(r.conditions ?? []) });
      if (c.commitment_type === '발주안' && r.decision === '승인') {
        // R4: 승인된 발주안은 기준 재전망에 편입하고 구간 새 버전을 만든다
        updateCommitment(cid, { draft_approved: 1 });
        const w = currentWindow();
        await newWindowVersion({ basis: w.window_basis, scenarioId: w.scenario_id, financeStatus: w.finance_confirmation_status, financeReplyId: w.finance_reply_id, arOverrides: parse(w.ar_overrides, {}), isSimulation: w.is_simulation === 1, causedBy: e.event_id });
      }
    }
  });
  // Corevia 공급 회신: 발주안이 공급 불가(검증 정상)면 그 발주는 이뤄지지 않으므로 약정을 취소하고 지급 유출을 뺀다.
  // 부분 가능·가능·같은 회신 재처리는 약정·금액·유출을 바꾸지 않는다(부분 공급 금액은 한계로 둠). 뒤 버전이 공급 가능으로 정정하면 되살린다
  ctx.events.on('SUPPLIER_REPLIED', async (e) => {
    const sc = e.payload?.supply_commitment;
    if (!sc || sc.target_type !== '발주안' || sc.validation_status !== '정상') return;
    const id = `CMT-${sc.target_id}`;
    const c = commitRow(id);
    if (!c) return;
    const cancel = parse(c.supply_cancel);
    const recalc = async () => {
      const w = currentWindow();
      await newWindowVersion({ basis: w.window_basis, scenarioId: w.scenario_id, financeStatus: w.finance_confirmation_status, financeReplyId: w.finance_reply_id, arOverrides: parse(w.ar_overrides, {}), isSimulation: w.is_simulation === 1, causedBy: e.event_id });
    };
    if (sc.reply_status === '불가' && c.active === 1) {
      updateCommitment(id, { active: 0, approval_status: '취소', effective_at: today(),
        cancel_info: json({ kind: '공급 불가로 취소', reason: 'Corevia 공급 불가 회신', event_id: e.event_id, on: today(), plan_ids: parse(c.linked_plan_ids, []), outflow_removed: c.draft_approved === 1 }),
        supply_cancel: json({ reason: 'Corevia 공급 불가', record_id: sc.record_id, supply_commitment_id: sc.supply_commitment_id, event_id: e.event_id, prev_approval_status: c.approval_status, prev_draft_approved: c.draft_approved }) });
      if (c.draft_approved === 1) await recalc();
    } else if (['가능', '부분 가능'].includes(sc.reply_status) && cancel && c.active === 0) {
      updateCommitment(id, { active: 1, approval_status: cancel.prev_approval_status, supply_cancel: null, cancel_info: null, effective_at: today() });
      if (cancel.prev_draft_approved === 1) await recalc();
    }
  });
  for (const t of ['PLAN_CONFIRMED', 'PLAN_AUTO_CONFIRMED_BY_DEADLINE', 'PLAN_WITHDRAWN']) {
    ctx.events.on(t, (e) => {
      const id = `CMT-${e.plan_id}`;
      if (!commitRow(id)) return;
      const status = t === 'PLAN_CONFIRMED' ? '확정' : t === 'PLAN_WITHDRAWN' ? '철회' : '기한 경과 확정';
      updateCommitment(id, { plan_status: status, ...(t === 'PLAN_WITHDRAWN' ? { active: 0 } : {}) });
    });
  }
  ctx.events.on('REVIEW_OPENED', async (e) => {
    const { target_type: tt, target_id: tid, rejudge } = e.payload ?? {};
    if (rejudge === false) return; // 조정자 C(5): 이미 다시 계산했으므로 재계산하지 않는다
    let cid = null;
    if (tt === 'commitment') cid = tid;
    else if (tt === 'route_judgment') cid = rjRow(tid)?.commitment_id ?? null;
    if (cid && commitRow(cid)) await judge(cid, { causedBy: e.event_id });
  });

  ctx.clock.onDay((date) => {
    // 판정·재무 확인 마감이 지나도록 재무 회신이 없으면 무회신으로 표시한다(R1: 상신은 계속)
    const p4 = p('p4');
    if (!p4?.getDeadlineSchedule) return;
    for (const c of db.prepare(`SELECT commitment_id FROM p3_commitment WHERE active = 1 AND is_new_commitment = 1 AND finance_confirmation_status = '재무확인대기'`).all()) {
      const due = p4.getDeadlineSchedule({ commitment_id: c.commitment_id })?.judgment_due;
      if (due && date > due) updateCommitment(c.commitment_id, { finance_confirmation_status: '무회신' });
    }
  });

  ctx.onInit(async () => {
    ensureExistingPoCommitments();
    const { row } = await newWindowVersion({ basis: 'policy_recalc', scenarioId: 'BASE', financeStatus: '재무확인대기', arOverrides: {}, isSimulation: false });
    for (const r of raw.po) await judge(`CMT-${r.po_id}`, { causedBy: row.event_id, emit: false });
    // 문제 4가 없으면 PLAN_RECEIVED가 오지 않으므로 원본 기안으로 직접 등록한다
    if (!p('p4')) for (const plan of ctx.plans()) await judge(ensurePlanCommitment(plan.plan_id), { causedBy: row.event_id });
  });

  // 화면에는 코드 대신 한국어 이름을 쓴다(조정자 (E) 화면 지침)
  const approverName = (a) => (a ? (roleOf.get(a)?.approver_name ?? a).replace(/\(.*\)$/, '') : '-');
  const LABELS = {
    approver: Object.fromEntries(roles.map((r) => [r.approver, approverName(r.approver)])),
    route: { 'R-00': '판정 대상 아님(기발주)', 'R-01': '하회 예상 구간 안 유출', 'R-02': '평시: 건별 1천만 원 또는 묶음 1억 원 초과(그룹 보고)', 'R-03': '평시: 마케팅팀 전결', 'R-04': '평시: 재고 발주' },
    anchor_basis: { contract_deadline: '확정기한', settlement_date: '집행 예정일', planned_order_date: '발주 예정일' },
    window_basis: { policy_recalc: '정책 방식 재전망', finance_confirmed: '재무 확인 반영', scenario: '시나리오' },
    scenario: { BASE: '기본', 'S-AR-DELAY': '회수일 지연' },
    condition_type: { inbound_unconfirmed: '미확정 입고', reorder_required: '보충 발주 필요', supply_commitment_pending: '공급 확약 대기', baseline_replenishment_unconfirmed: '기준 수요 보충 미확인' },
  };

  // ── 공개 함수(명세 9절) ──
  const api = {
    cashWindow({ scenario_id, window_version } = {}) {
      return toWindow(window_version ? windowRow(window_version) : latestWindowRow(scenario_id));
    },
    commitment: (id) => toCommitment(commitRow(id)),
    commitmentBySource(sourceId) {
      return toCommitment(db.prepare('SELECT * FROM p3_commitment WHERE source_id = ? ORDER BY n DESC LIMIT 1').get(sourceId));
    },
    listCommitments({ commitment_type, plan_id, approver, approval_status } = {}) {
      const where = [];
      const args = [];
      for (const [k, v] of Object.entries({ commitment_type, plan_id, approver, approval_status })) if (v) { where.push(`${k} = ?`); args.push(v); }
      return db.prepare(`SELECT * FROM p3_commitment ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY n`).all(...args).map(toCommitment);
    },
    routeJudgment: (id) => toRj(rjRow(id)),
    routeJudgmentHistory: (cid) => db.prepare('SELECT * FROM p3_route_judgment WHERE commitment_id = ? ORDER BY n').all(cid).map(toRj),
    approverRole(approver) {
      const r = roleOf.get(approver);
      return r ? { approver: r.approver, approver_name: r.approver_name, policy_ref: r.policy_ref, std_approval_bd: Number(r.std_approval_bd) } : null;
    },
    approvalRequest: (id) => toReq(reqRow(id)),
    approvalRequestsFor: (cid) => db.prepare('SELECT * FROM p3_approval_request ORDER BY n').all().filter((r) => parse(r.commitment_ids, []).includes(cid)).map(toReq),
    submissionPackage,
    approvalImpact,
    scmReplenishmentSensitivity,
    submitApproval,
    applyFinanceReply,
    // 문제 4 사건 순서표(S4-09)의 문제 3 행을 전달한다(문제 4 명세 9.2)
    async deliverMock(mockId) {
      const row = (p('p4')?.getMockSchedule?.({ owner: 'p3' }) ?? []).find((x) => x.mock_id === mockId);
      if (!row) throw ctx.httpError(404, `문제 3 모의 입력 행이 없습니다: ${mockId}`);
      if (row.event_type === 'FINANCE_CONFIRMED' || row.event_type === 'AR_DATE_REVISED') {
        const sc = row.event_type === 'AR_DATE_REVISED' ? (row.scenario_id && row.scenario_id !== 'BASE' ? row.scenario_id : 'S-AR-DELAY') : 'BASE';
        const rep = replies.find((r) => r.reply_event_type === row.event_type && r.scenario_id === sc);
        if (!rep) throw ctx.httpError(404, `재무 회신 자료가 없습니다: ${row.event_type} ${sc}`);
        return { cash_window: await applyFinanceReply(rep.finance_reply_id) };
      }
      if (row.event_type === 'APPROVAL_SUBMITTED') {
        let c = null;
        const direct = commitRow(`CMT-${row.target}`);
        if (direct?.commitment_type === '발주안' || /발주안|po_draft|POD-|PD-/i.test(String(row.target ?? ''))) {
          // 순서표 행의 target에 적힌 발주안만 상신한다. 기안의 최신 발주안을 고르지 않는다((D)-2 다)
          if (!direct || direct.commitment_type !== '발주안') return { skipped: `순서표 target의 발주안이 없음(${row.target})` };
          if (direct.active !== 1) return { skipped: `취소된 발주안(${row.target})` };
          if (direct.approval_status !== '미상신') return { skipped: `상신할 상태 아님(${direct.approval_status})`, approval_request: toReq(reqRow(direct.approval_request_id)) };
          return { approval_request: await submitApproval({ commitment_ids: [direct.commitment_id], actor_dept: 'SCM', actor_role: 'SCM 발주 검토(기본 모의 입력)', effective_at: row.sim_date }) };
        } else if (row.plan_id && row.plan_id !== 'NONE') c = commitRow(`CMT-${row.plan_id}`);
        if (!c) return { skipped: '대상 약정 없음' };
        if (c.approval_status !== '미상신') return { skipped: `상신할 상태 아님(${c.approval_status})`, approval_request: toReq(reqRow(c.approval_request_id)) };
        if (directPlanIds().has(c.plan_id)) return { skipped: `직접 처리 기안이라 자동 상신하지 않음(${c.plan_id})` };
        return { approval_request: await submitApproval({ commitment_ids: submissionGroup(c.commitment_id, { excludeDirect: true }), effective_at: row.sim_date }) };
      }
      throw ctx.httpError(400, `문제 3이 전달하지 않는 사건입니다: ${row.event_type}`);
    },
  };
  // ── 사건 설명 카드(오른쪽 평가자 화면 공통 계약) ──
  const EVENT_KO = {
    SUPPLIER_REPLIED: 'Corevia 공급 회신', INBOUND_SCHEDULE_REVISED: '입고 일정 변경', SUPPLY_JUDGED: '공급 판정', PLAN_WITHDRAWN: '기안 철회',
    PLAN_CONFIRMED: '기안 확정', PLAN_AUTO_CONFIRMED_BY_DEADLINE: '기한 경과 확정', DEMAND_INPUT_REVISED: '수요 입력 정정', PLAN_RECEIVED: '기안 접수', PO_DRAFT_CREATED: '발주안 생성', PO_DRAFT_CANCELLED: '발주안 취소', ALTERNATIVE_SELECTED: '대안 선택',
    APPROVAL_REPLIED: '승인 회신', REVIEW_OPENED: '재검토 시작', FINANCE_CONFIRMED: '재무 확인', AR_DATE_REVISED: '회수일 변경',
  };
  const describeEvent = createDescriber({
    approverName, opening, threshold, raw, log: (m) => ctx.log(m),
    windowRow, prevWindowRow: (n) => db.prepare('SELECT * FROM p3_cash_window WHERE n < ? ORDER BY n DESC LIMIT 1').get(n),
    windowCausedBy: (eventId) => db.prepare('SELECT w.* FROM p3_cash_window w JOIN events e ON e.event_id = w.event_id WHERE e.caused_by = ? ORDER BY w.n LIMIT 1').get(eventId),
    commitment: (id) => commitRow(id),
    commitmentBySource: (sid) => db.prepare('SELECT * FROM p3_commitment WHERE source_id = ? ORDER BY n DESC LIMIT 1').get(sid),
    rjRow, reqRow, draft: (id) => db.prepare('SELECT * FROM p3_draft WHERE draft_id = ?').get(id),
    supersededBy: (reqId) => {
      const r = reqRow(reqId);
      const ids = parse(r?.commitment_ids, []);
      return db.prepare('SELECT * FROM p3_approval_request WHERE n < ? ORDER BY n').all(r?.n ?? 0)
        .filter((o) => parse(o.superseded_commitment_ids, []).some((x) => ids.includes(x))).map((o) => o.approval_request_id);
    },
    appliedReply: (id) => db.prepare('SELECT * FROM p3_finance_reply_applied WHERE finance_reply_id = ?').get(id),
    term: (recordId) => terms.find((t) => t.record_id === recordId) ?? null,
    bundleTotal: (id) => bundleTotals.get(id) ?? null,
    draftByAiCall: (aiCallId) => (aiCallId ? db.prepare('SELECT * FROM p3_draft WHERE ai_call_id = ?').get(aiCallId) : null),
    supplyLabel: (poDraftId) => supplyStateOf(poDraftId, p('p2')?.poDrafts?.({ po_draft_id: poDraftId })?.[0] ?? null).label,
    event: (id) => ctx.events.get(id),
    eventTitle: (ev) => `${EVENT_KO[ev.event_type] ?? describeEvent(ev)?.title ?? '다른 처리'}(${ev.occurred_at})`,
  });
  api.describeEvent = describeEvent;
  api.approvalView = (planId) => approvalView(planId);

  // ── 왼쪽 사용자 화면: 이 기안의 승인 요청 흐름과 상태를 한 번에 ──
  // 승인권자와 이유 확인 → 초안(AI 또는 양식) → 확인·수정 → 상신 → 회신. 계산·판정은 하지 않고 저장된 값만 모은다
  const campaignOf = (planId) => ctx.plans().find((x) => x.plan_id === planId) ?? null;
  const bundleCandidates = (cid) => submissionGroup(cid).filter((id) => id !== cid).map((id) => {
    const x = commitRow(id);
    return { plan_id: x.plan_id, campaign_name: campaignOf(x.plan_id)?.campaign_name ?? null, amount_krw: x.amount_krw, demand_status: p('p1')?.demandStatusByPlan?.(x.plan_id)?.demand_status ?? null };
  });
  function approvalView(planId) {
    const cid = `CMT-${planId}`;
    const c = commitRow(cid);
    if (!c) throw ctx.httpError(404, `이 기안의 약정이 없습니다: ${planId}`);
    const rj = c.route_judgment_id ? rjRow(c.route_judgment_id) : null;
    const w = windowRow(c.window_version) ?? currentWindow();
    const ds = deadlineOf(cid);
    const planStatus = planStatusOf(c);
    const replyEvents = ctx.events.query({ event_type: 'APPROVAL_REPLIED', subject_id: cid, limit: 1000 });
    const requests = api.approvalRequestsFor(cid).map((r) => {
      const row = reqRow(r.approval_request_id);
      const superseded = isSupersededFor(row, cid);
      return {
        approval_request_id: r.approval_request_id, approver: r.approver, approver_name: approverName(r.approver),
        submitted_on: row.submitted_on, submission_due: r.submission_due, draft_id: row.draft_id ?? null,
        request_status: superseded ? '대체됨' : '유효',
        replies: replyEvents.filter((e) => e.payload?.approval_request_id === r.approval_request_id).map((e) => ({
          decision: e.payload.decision, conditions: e.payload.conditions ?? [], replied_at: e.payload.replied_at ?? e.occurred_at,
          approver_name: approverName(e.payload.approver), reason: e.payload.reason ?? null, applied: !superseded, event_id: e.event_id,
        })),
      };
    });
    const drafts = db.prepare('SELECT * FROM p3_draft WHERE commitment_id = ? ORDER BY n DESC').all(cid);
    const latest = drafts[0] ?? null;
    const blockers = [];
    if (c.active !== 1) blockers.push('종료된 약정');
    if (['확정', '기한 경과 확정', '철회'].includes(planStatus ?? '')) blockers.push(`기안이 이미 ${planStatus}`);
    if (c.approval_status !== '미상신') blockers.push(`승인 상태가 '${c.approval_status}'`);
    const canSubmit = blockers.length === 0;
    const candidates = canSubmit ? bundleCandidates(cid) : [];
    const pkgRow = submissionPackage(cid).rows[0];
    const ms = parse(rj?.matched_segment);
    return {
      plan_id: planId, commitment_id: cid, plan_status: planStatus,
      approver: { code: c.approver, name: approverName(c.approver), group_report_required: c.group_report_required === 1, std_approval_bd: c.approver ? Number(roleOf.get(c.approver)?.std_approval_bd ?? null) : null },
      reason: {
        route_rule_id: c.route_rule_id, rule_label: LABELS.route[c.route_rule_id] ?? null, rule_text: RULE_TEXT[c.route_rule_id] ?? null,
        cash_outflow_date: c.cash_outflow_date, in_window: rj?.in_window === 1, matched_segment: ms,
        shortfall_window: w ? { start: w.shortfall_window_start, end: w.shortfall_window_end, segments: parse(w.segments, []).map(C.segmentView), min_balance_krw: w.min_balance_krw, min_date: w.min_date } : null,
        amount_krw: c.amount_krw, amount_scale: c.amount_scale, bundle_total_krw: bundleTotals.get(c.plan_bundle_id) ?? null,
        rationale: rj?.rationale ?? null,
      },
      approval_anchor_date: c.approval_anchor_date, anchor_basis_label: LABELS.anchor_basis[c.anchor_basis] ?? c.anchor_basis,
      deadlines: ds ? { submission_due: ds.submission_due, final_reply_due: ds.final_reply_due } : null,
      approval_status: c.approval_status, conditions: parse(c.conditions, []),
      can_submit: canSubmit, submit_blockers: blockers,
      // 올라가는 것은 이 기안 한 건. bundle_candidates는 사용자가 골라 함께 올릴 수 있는 기안(같은 승인권자·같은 상신 마감)
      submit_group: canSubmit ? [{ commitment_id: cid, plan_id: planId, amount_krw: c.amount_krw }] : [],
      bundle_candidates: candidates,
      draft: latest ? {
        draft_id: latest.draft_id, mode: latest.mode, review_status: latest.review_status,
        text: latest.review_status === '수정 후 확인' ? latest.text : businessTerms(latest.text),
        original_text: latest.original_text ?? null, created_on: latest.created_on, usable: draftUsable(latest),
      } : null,
      requests, latest_reply: requests.flatMap((r) => r.replies).at(-1) ?? null,
      po_drafts: (pkgRow?.po_draft_conditions ?? []).map((x) => ({
        po_draft_id: x.po_draft_id, sku_id: x.sku_id, order_deadline: x.order_deadline, payment_due_date: x.payment_due_date,
        approver_name: approverName(x.approver), approval_status: x.approval_status, campaign_share: x.campaign_share,
        internal_approval_status: x.internal_approval_status, internal_approval_label: x.internal_approval_label, supply_commitment: x.supply_commitment,
        residual_after_withdrawal: x.residual_after_withdrawal,
      })),
      unconfirmed_supply_conditions: pkgRow?.unconfirmed_supply_conditions ?? [],
      supply_risk_acceptance: parse(c.supply_risk_acceptance),
      cash_impact: pkgRow?.cash_impact ? { before: pkgRow.cash_impact.before, after: pkgRow.cash_impact.after, after_below_zero: pkgRow.cash_impact.after_below_zero, limitations: CASH_LIMITATIONS, scm_sensitivity: pkgRow.scm_sensitivity } : null,
      contribution_margin_status: '미산정',
    };
  }
  ctx.expose(api);

  // ── 기안 목록 요약 ──
  ctx.addPlanSummary((planId) => {
    const c = commitRow(`CMT-${planId}`);
    if (!c) return [];
    return [
      { label: '승인권자', value: approverName(c.approver), source_type: '계산', is_synthetic: false, is_simulation: c.is_simulation === 1 },
      { label: '승인 상태', value: c.approval_status, source_type: '계산', is_synthetic: false, is_simulation: c.is_simulation === 1 },
    ];
  });

  // ── API ──
  ctx.route('GET', '/window', ({ query }) => {
    const w = latestWindowRow(query.get('scenario_id') || undefined);
    const sensitivity = ['base', 'incl_asof', 'overdue_now'].map((variant) => {
      const x = compute({ arOverrides: parse(w?.ar_overrides, {}), drafts: approvedDraftFlows(), variant });
      return { variant, shortfall_window_start: x.shortfall_window_start, shortfall_window_end: x.shortfall_window_end, shortfall_bd_count: x.shortfall_bd_count, min_balance_krw: x.min_balance_krw, min_date: x.min_date };
    });
    return { cash_window: toWindow(w), segments: parse(w?.segments, []), mismatch: w?.mismatch ?? null, sensitivity, official_forecast: ctx.raw.load('02_masil/financials/fin_cash_forecast_ms.csv') };
  });
  ctx.route('GET', '/windows', () => ({ labels: LABELS, windows: db.prepare('SELECT * FROM p3_cash_window ORDER BY n').all().map((r) => ({ ...toWindow(r), finance_reply_id: r.finance_reply_id, mismatch: r.mismatch, event_id: r.event_id })) }));
  ctx.route('GET', '/sensitivity/scm-replenishment', ({ query }) => scmReplenishmentSensitivity({ scenario_id: query.get('scenario_id') || undefined }));
  ctx.route('GET', '/impact/:commitment_id', ({ params, query }) => approvalImpact({ commitment_id: params.commitment_id, scenario_id: query.get('scenario_id') || undefined }));
  ctx.route('GET', '/projection', ({ query }) => {
    const w = currentWindow();
    return { variant: query.get('variant') || 'base', window_version: w.window_version, daily: compute({ arOverrides: parse(w.ar_overrides, {}), drafts: approvedDraftFlows(), variant: query.get('variant') || 'base' }).daily };
  });
  ctx.route('GET', '/commitments', ({ query }) => ({ commitments: api.listCommitments({ commitment_type: query.get('commitment_type') || undefined, approver: query.get('approver') || undefined }) }));
  ctx.route('GET', '/commitments/:id', ({ params }) => {
    const c = api.commitment(params.id);
    if (!c) throw ctx.httpError(404, `약정이 없습니다: ${params.id}`);
    return { commitment: c, history: api.routeJudgmentHistory(params.id), requests: api.approvalRequestsFor(params.id), deadline_schedule: deadlineOf(params.id) };
  });
  ctx.route('GET', '/plan/:plan_id', ({ params }) => {
    const cid = `CMT-${params.plan_id}`;
    const c = commitRow(cid);
    if (!c) return { connected: true, commitment: null };
    const drafts = db.prepare(`SELECT * FROM p3_commitment WHERE commitment_type = '발주안' ORDER BY n`).all()
      .filter((x) => parse(x.linked_plan_ids, []).includes(params.plan_id)).map(toCommitment);
    return {
      commitment: toCommitment(c), detail: { settlement_date: c.settlement_date, contract_deadline: c.contract_deadline, plan_status: planStatusOf(c), bundle_total_krw: bundleTotals.get(c.plan_bundle_id) ?? null },
      history: api.routeJudgmentHistory(cid).map((h) => ({ ...h, rationale: rjRow(h.route_judgment_id).rationale, status_after: rjRow(h.route_judgment_id).status_after, judged_on: rjRow(h.route_judgment_id).judged_on, is_simulation: rjRow(h.route_judgment_id).is_simulation === 1 })),
      requests: api.approvalRequestsFor(cid), cash_window: api.cashWindow(), package: submissionPackage(cid),
      drafts: db.prepare('SELECT * FROM p3_draft WHERE commitment_id = ? ORDER BY n DESC').all(cid),
      po_drafts: drafts, connections: { p1: Boolean(p('p1')), p2: Boolean(p('p2')), p4: Boolean(p('p4')) }, labels: LABELS,
    };
  });
  ctx.route('POST', '/submit', async ({ body }) => {
    const ids = body.commitment_ids ?? (body.commitment_id ? submissionGroup(body.commitment_id, { excludeDirect: true }) : null);
    return { approval_request: await submitApproval({ commitment_ids: ids, actor_dept: body.actor_dept, actor_role: body.actor_role, draft_id: body.draft_id ?? null }) };
  });
  // 왼쪽 사용자 화면(마케팅 기안 담당자): 승인권자·이유 → 초안 → 확인·수정 → 상신, 승인 상태·회신을 한 번에
  ctx.route('GET', '/plan/:plan_id/approval', ({ params }) => approvalView(params.plan_id));
  ctx.route('POST', '/plan/:plan_id/approval/submit', async ({ params, body }) => {
    const cid = `CMT-${params.plan_id}`;
    const c = commitRow(cid);
    if (!c) throw ctx.httpError(404, `이 기안의 약정이 없습니다: ${params.plan_id}`);
    // 사용자 화면의 상신은 그 기안 한 건만 올린다. 함께 올릴 기안은 사용자가 고른 것(with_plan_ids)만, 같은 승인권자·같은 상신 마감 후보 안에서 받는다
    const picked = [...new Set(body.with_plan_ids ?? [])].filter((x) => x !== params.plan_id);
    const candidates = new Set(bundleCandidates(cid).map((x) => x.plan_id));
    const bad = picked.filter((x) => !candidates.has(x));
    if (bad.length) throw ctx.httpError(400, `함께 올릴 수 없는 기안입니다(같은 승인권자·같은 상신 마감의 미상신 기안만): ${bad.join(', ')}`);
    const req = await submitApproval({ commitment_ids: [cid, ...picked.map((x) => `CMT-${x}`)], actor_dept: 'MKT', actor_role: '마케팅 기안 담당자', draft_id: body.draft_id ?? null });
    return { approval_request: req, approval: approvalView(params.plan_id) };
  });
  ctx.route('POST', '/draft', async ({ body }) => ({ draft: await prepareDraft(body.commitment_id) }));
  ctx.route('POST', '/draft/:draft_id/review', async ({ params, body }) => {
    const d = db.prepare('SELECT * FROM p3_draft WHERE draft_id = ?').get(params.draft_id);
    if (!d) throw ctx.httpError(404, `초안이 없습니다: ${params.draft_id}`);
    const result = body.review_result ?? '확인';
    const edited = result === '수정 후 확인';
    if (edited && !String(body.text ?? '').trim()) throw ctx.httpError(400, '수정 후 확인에는 고친 문서(text)가 필요합니다');
    if (d.mode !== 'AI' && !edited) throw ctx.httpError(400, '양식 초안은 확인 없이 쓸 수 있고, 고칠 때만 수정 후 확인을 보냅니다');
    // AI 초안의 확인·수정·거부는 AI 호출 기록에 남긴다(AI_OUTPUT_REVIEWED). 양식 초안의 수정은 문서만 바꾼다
    if (d.mode === 'AI') await ctx.ai.review({ ai_call_id: d.ai_call_id, review_result: result, reviewer_role: body.reviewer_role ?? '마케팅 기안 담당자', edited_fields: edited ? ['text'] : [], plan_id: commitRow(d.commitment_id)?.plan_id ?? 'NONE' });
    if (edited) db.prepare('UPDATE p3_draft SET original_text = COALESCE(original_text, text), text = ? WHERE draft_id = ?').run(String(body.text), params.draft_id);
    db.prepare('UPDATE p3_draft SET review_status = ? WHERE draft_id = ?').run(result, params.draft_id);
    return { draft: db.prepare('SELECT * FROM p3_draft WHERE draft_id = ?').get(params.draft_id) };
  });
  ctx.route('POST', '/finance-reply', async ({ body }) => ({ cash_window: await applyFinanceReply(body.finance_reply_id) }));
  ctx.route('GET', '/attributes', () => ({
    supplier_payment_terms: terms, plan_bundle: bundles, approver_roles: roles, finance_reply: replies,
    applied_finance_replies: db.prepare('SELECT * FROM p3_finance_reply_applied').all(),
  }));
}
