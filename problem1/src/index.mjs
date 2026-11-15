// 문제 1 모듈 — 캠페인 수요 입력. 명세: problem1/명세.md, 이름: problem4/공통_접점.md, 붙이는 방법: app/모듈_계약.md
import {
  derivePlanSkuMap, deriveBaselineDemand, deriveReferenceMetrics, computeDemandWeekly, validateDemandFields,
  parseS1, parseS2, S1_FILE, S2_FILE, GRID_DEFAULT, DEMAND_ALT_TYPES, humanize, FIELD_LABELS,
} from './demand.mjs';
import { createDescriber } from './describe.mjs';

const ROLE = 'MKT-LINE-OWNER';
const SPEC = 'problem1/명세.md';
const FIELD_KEYS = ['uplift_pct', 'sale_start_week', 'sale_weeks'];
const AUTO_NO_AI = 'AI 호출 없음(자동 처리)';

export async function register(ctx) {
  // ── 테이블 ──
  ctx.defineTable('p1_demand_input', `
    demand_input_id TEXT NOT NULL, version INTEGER NOT NULL, plan_id TEXT NOT NULL,
    version_status TEXT NOT NULL, uplift_pct REAL, sale_start_week TEXT, sale_weeks INTEGER,
    submitted_by TEXT, basis_as_of TEXT, baseline_demand_version TEXT, rationale_text TEXT,
    origin TEXT NOT NULL, occurred_at TEXT NOT NULL, effective_at TEXT,
    source_type TEXT NOT NULL, is_synthetic INTEGER NOT NULL, scenario_id TEXT NOT NULL,
    request_id TEXT, reply_event_id TEXT, reply_text TEXT, mock_record_id TEXT,
    ai_status TEXT, ai_call_id TEXT, extracted_json TEXT, missing_json TEXT, reject_reason TEXT,
    PRIMARY KEY (demand_input_id, version)`);
  ctx.defineTable('p1_sku_override', `
    demand_input_id TEXT NOT NULL, version INTEGER NOT NULL, plan_id TEXT NOT NULL, sku_id TEXT NOT NULL,
    override_uplift_pct REAL NOT NULL, source_type TEXT NOT NULL, is_synthetic INTEGER NOT NULL,
    PRIMARY KEY (demand_input_id, version, sku_id)`);
  ctx.defineTable('p1_demand_weekly', `
    demand_input_id TEXT, version INTEGER, plan_id TEXT NOT NULL, sku_id TEXT NOT NULL, week_start TEXT NOT NULL,
    baseline_weekly_qty REAL NOT NULL, applied_uplift_pct REAL NOT NULL, added_qty_ea INTEGER NOT NULL,
    baseline_demand_version TEXT NOT NULL, PRIMARY KEY (demand_input_id, version, sku_id, week_start)`);
  ctx.defineTable('p1_mock_delivery', `
    record_id TEXT PRIMARY KEY, mock_id TEXT, event_id TEXT NOT NULL, demand_input_id TEXT, version INTEGER, delivered_at TEXT NOT NULL`);

  // ── 원본 도출(등록 시 한 번, 원본은 읽기 전용) ──
  const planSkuRows = derivePlanSkuMap(ctx.raw);
  const baselineRows = deriveBaselineDemand(ctx.raw);
  const baselineBySku = new Map(baselineRows.map((b) => [b.sku_id, b]));
  const referenceByPlan = deriveReferenceMetrics(ctx.raw);
  const plansById = new Map(ctx.plans().map((p) => [p.plan_id, p]));
  const skusOf = (planId) => planSkuRows.filter((r) => r.plan_id === planId).map((r) => r.sku_id);
  const skuNames = new Map(ctx.raw.load('02_masil/master/m_sku_ms.csv').map((s) => [s.sku_id, s.sku_name]));

  // ── 모의 회신 자료(S1·S2). 값은 (C) 단계에서 채운다. 지금은 형식과 로더만 ──
  let mock = null;
  const loadMock = () => {
    if (!mock) {
      const s1 = parseS1(ctx.data.load(S1_FILE, { optional: true }), plansById);
      const s1ById = new Map(s1.map((r) => [r.record_id, r]));
      const s2 = parseS2(ctx.data.load(S2_FILE, { optional: true }), s1ById);
      mock = { s1, s1ById, s2 };
    }
    return mock;
  };

  // ── 다른 모듈(없으면 null → '연결 안 됨') ──
  const other = (id) => ctx.module(id);
  const safe = (id, fn) => {
    const m = other(id);
    if (!m) return { connected: false };
    try { return { connected: true, value: fn(m) }; }
    catch (err) { return { connected: true, error: err.message }; }
  };
  const grid = () => {
    const g = safe('p2', (m) => m.grid?.());
    return g.value ? { ...GRID_DEFAULT, ...g.value, source: 'p2' } : { ...GRID_DEFAULT, source: '사전 2절 기본값(문제 2 연결 안 됨)' };
  };

  // ── 저장소 접근 ──
  const db = ctx.db;
  const diId = (planId) => `DI-${planId}`;
  const rowToInput = (r) => (r ? {
    demand_input_id: r.demand_input_id, plan_id: r.plan_id, version: r.version, version_status: r.version_status,
    uplift_pct: r.uplift_pct, sale_start_week: r.sale_start_week, sale_weeks: r.sale_weeks,
    submitted_by: r.submitted_by, basis_as_of: r.basis_as_of, baseline_demand_version: r.baseline_demand_version,
    rationale_text: r.rationale_text, origin: r.origin, occurred_at: r.occurred_at, effective_at: r.effective_at,
    source_type: r.source_type, is_synthetic: r.is_synthetic === 1, scenario_id: r.scenario_id,
  } : null);
  const versionsOf = (planId) => db.prepare('SELECT * FROM p1_demand_input WHERE plan_id = ? ORDER BY version').all(planId);
  const getVersionRow = (id, version) => db.prepare('SELECT * FROM p1_demand_input WHERE demand_input_id = ? AND version = ?').get(id, version);
  const validRow = (planId) => db.prepare("SELECT * FROM p1_demand_input WHERE plan_id = ? AND version_status = '유효'").get(planId);
  const overridesOf = (id, version) => db.prepare('SELECT * FROM p1_sku_override WHERE demand_input_id = ? AND version = ? ORDER BY sku_id')
    .all(id, version).map((o) => ({ ...o, is_synthetic: o.is_synthetic === 1 }));
  const weeklyOf = (id, version) => db.prepare('SELECT * FROM p1_demand_weekly WHERE demand_input_id = ? AND version = ? ORDER BY sku_id, week_start')
    .all(id, version).map((w) => ({ ...w, source_type: '계산', is_simulation: true }));

  function demandStatus(planId) {
    const all = versionsOf(planId);
    const valid = all.find((r) => r.version_status === '유효');
    const everValid = all.filter((r) => ['유효', '대체됨'].includes(r.version_status)).length;
    const last = all.at(-1);
    let status = '미입력';
    if (last?.version_status === '확인대기') status = '확인대기';
    else if (valid) status = everValid > 1 ? '정정됨' : '등록됨';
    return {
      plan_id: planId, demand_input_id: valid?.demand_input_id ?? null, version: valid?.version ?? null,
      demand_status: status, sale_start_week: valid?.sale_start_week ?? null, sale_weeks: valid?.sale_weeks ?? null,
      uplift_pct: valid?.uplift_pct ?? null, is_synthetic: valid ? valid.is_synthetic === 1 : null,
    };
  }

  // ── 처리 ──

  // 회신을 확인대기 버전으로 만들고(AI가 연결돼 있으면) 구조화한다.
  async function handleReply(event) {
    const planId = event.plan_id;
    if (!plansById.has(planId)) return;
    if (event.emitted_by !== 'p1') {
      const req = safe('p4', (m) => m.getInfoRequest?.(event.payload?.request_id));
      if (req.value?.request_topic !== 'demand_input') return;
    }
    if (db.prepare('SELECT 1 FROM p1_demand_input WHERE reply_event_id = ?').get(event.event_id)) return;
    const id = diId(planId);
    const version = (db.prepare('SELECT MAX(version) AS v FROM p1_demand_input WHERE demand_input_id = ?').get(id).v ?? 0) + 1;
    const ref = [].concat(event.source_ref ?? []).find((x) => typeof x === 'string' && x.includes(S1_FILE));
    const mockRecordId = ref ? ref.split('#')[1] : null;
    db.prepare(`INSERT INTO p1_demand_input (demand_input_id, version, plan_id, version_status, origin, occurred_at,
      source_type, is_synthetic, scenario_id, request_id, reply_event_id, reply_text, mock_record_id, ai_status)
      VALUES (?, ?, ?, '확인대기', 'reply', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, version, planId, event.occurred_at, event.source_type, event.is_synthetic ? 1 : 0, event.scenario_id,
      event.payload?.request_id ?? null, event.event_id, event.payload?.reply_text ?? '', mockRecordId,
      mockRecordId ? AUTO_NO_AI : 'AI 미연결');
    // 자동 처리(모의 자료)로 들어온 회신은 자료의 확인된 값을 쓰므로 AI를 부르지 않는다. AI 구조화는 화면에서 사람이 넣을 때만.
    if (!mockRecordId) await structure(planId, id, version, event);
  }

  async function structure(planId, id, version, replyEvent) {
    if (ctx.ai.status() !== '연결') return;
    const plan = plansById.get(planId);
    const messages = [
      { role: 'system', content: [
        '너는 마케팅 수요 회신을 구조화하는 도구다. 회신 원문에 적힌 값만 옮긴다. 추측하거나 계산하지 않는다.',
        'JSON 하나만 출력한다: {"fields":{"uplift_pct":숫자|null,"sale_start_week":"YYYY-MM-DD"|null,"sale_weeks":정수|null,',
        '"sku_overrides":[{"sku_id":"SKU-nnnn","override_uplift_pct":숫자}],"rationale_text":문자열|null},"unclear_reasons":[문자열]}',
        'uplift_pct는 기준 수요 대비 증가율(%)이다. 35%면 35, "1.15배"면 15, "3할"이면 30. sale_start_week는 판매 시작 주의 월요일 날짜다.',
        `날짜 규칙: 오늘(가상 일자)은 ${ctx.clock.today()}이고 기준 연도는 ${ctx.clock.today().slice(0, 4)}년이다. 연도가 없는 날짜는 기준 연도로 본다.`,
        '주는 월요일에 시작한다. "08-17 주", "8/17 주"처럼 날짜가 적힌 주는 그 날짜가 속한 주의 월요일로 바꾼다. "N월 첫 주"는 N월 1일이 속한 주가 아니라 N월의 첫 월요일이 시작하는 주다.',
        '연도를 알 수 있어 날짜로 바꿀 수 있으면 null로 두지 않는다. "9월 하순", "한 달가량"처럼 하나의 주나 주수로 정할 수 없을 때만 null로 두고 unclear_reasons에 이유를 적는다.',
        '회신에 없는 값은 null로 둔다. sku_overrides는 회신에 품목별 값이 있을 때만 넣는다.',
        'unclear_reasons와 rationale_text는 마케팅 기안 담당자가 읽는 문장이다. 필드 이름(uplift_pct 같은 영문)이나 품목 코드(SKU-0000)를 쓰지 말고 "증가율", "판매 시작 주", "판매 주수", "품목별 증가율" 같은 업무 용어와 품목 이름으로 쓴다.',
      ].join('\n') },
      { role: 'user', content: `기안 ${planId} (제품라인 ${plan.product_line}, SKU ${skusOf(planId).join(', ')}, SKU 이름 ${skusOf(planId).map((s) => `${s}=${skuNames.get(s)}`).join(', ')})\n회신 원문:\n${replyEvent.payload?.reply_text ?? ''}` },
    ];
    let r;
    try {
      r = await ctx.ai.call({ ai_task_type: 'structure', ai_task_name: 'demand_reply_structure', messages,
        input_refs: [replyEvent.event_id], plan_id: planId, scenario_id: replyEvent.scenario_id, actor_dept: 'MKT' });
    } catch (err) {
      db.prepare('UPDATE p1_demand_input SET ai_status = ? WHERE demand_input_id = ? AND version = ?').run(`AI 실패: ${err.message}`, id, version);
      ctx.log(`AI 구조화 실패(${planId} v${version}): ${err.message}. 담당자 직접 입력으로 넘긴다`);
      return;
    }
    if (r.status !== '연결') return;
    const f = r.output?.fields ?? {};
    const extracted = {
      uplift_pct: f.uplift_pct ?? null, sale_start_week: f.sale_start_week ?? null, sale_weeks: f.sale_weeks ?? null,
      sku_overrides: Array.isArray(f.sku_overrides) ? f.sku_overrides : [], rationale_text: f.rationale_text ?? null,
    };
    const missing = FIELD_KEYS.filter((k) => extracted[k] === null);
    db.prepare(`UPDATE p1_demand_input SET ai_status = '구조화됨', ai_call_id = ?, extracted_json = ?, missing_json = ?
      WHERE demand_input_id = ? AND version = ?`).run(r.ai_call_id, JSON.stringify({ ...extracted, rationale_text: humanize(extracted.rationale_text, skuNames),
        unclear_reasons: (r.output?.unclear_reasons ?? []).map((x) => humanize(x, skuNames)) }),
      JSON.stringify(missing), id, version);
    await ctx.events.emit({
      event_type: 'DEMAND_INPUT_STRUCTURED', source_type: '계산', plan_id: planId,
      subject_type: 'demand_input', subject_id: `${id}#${version}`, actor_dept: 'SYSTEM',
      is_simulation: true, caused_by: replyEvent.event_id, scenario_id: replyEvent.scenario_id, spec_ref: `${SPEC} 4.2`,
      payload: { demand_input_id: id, version, extracted_fields: extracted, missing_fields: missing },
    });
  }

  // 담당자 확인. decision: '확인' | '거부'. fields: { uplift_pct, sale_start_week, sale_weeks, overrides[], rationale_text, submitted_by, basis_as_of }
  async function confirmDemandInput({ demand_input_id, version, decision = '확인', fields = {}, reviewer_role = ROLE, is_synthetic = true }) {
    const row = getVersionRow(demand_input_id, Number(version));
    if (!row) throw ctx.httpError(404, `수요 입력 버전이 없습니다: ${demand_input_id} v${version}`);
    if (row.version_status !== '확인대기') throw ctx.httpError(409, `확인대기 버전이 아닙니다(${row.version_status})`);
    const planId = row.plan_id;
    const today = ctx.clock.today();
    const input = {
      uplift_pct: fields.uplift_pct === '' ? null : fields.uplift_pct == null ? null : Number(fields.uplift_pct),
      sale_start_week: fields.sale_start_week || null,
      sale_weeks: fields.sale_weeks === '' || fields.sale_weeks == null ? null : Number(fields.sale_weeks),
      overrides: (fields.overrides ?? []).map((o) => ({ sku_id: o.sku_id, override_uplift_pct: Number(o.override_uplift_pct) })),
      rationale_text: fields.rationale_text ?? null,
      submitted_by: fields.submitted_by || ROLE,
      basis_as_of: fields.basis_as_of || row.occurred_at,
    };
    const base = { plan_id: planId, subject_type: 'demand_input', subject_id: `${demand_input_id}#${row.version}`,
      actor_dept: 'MKT', actor_role: reviewer_role, is_synthetic, scenario_id: row.scenario_id,
      caused_by: row.reply_event_id, spec_ref: `${SPEC} 4.2` };

    // AI 출력 확인 기록(AI가 쓰였을 때만)
    if (row.ai_call_id) {
      const ex = JSON.parse(row.extracted_json ?? '{}');
      const edited = FIELD_KEYS.filter((k) => String(ex[k] ?? '') !== String(input[k] ?? ''));
      const exOv = JSON.stringify((ex.sku_overrides ?? []).map((o) => [o.sku_id, Number(o.override_uplift_pct)]).sort());
      const inOv = JSON.stringify(input.overrides.map((o) => [o.sku_id, o.override_uplift_pct]).sort());
      if (exOv !== inOv) edited.push('sku_overrides');
      const result = decision === '거부' ? '거부' : edited.length ? '수정 후 확인' : '확인';
      await ctx.ai.review({ ai_call_id: row.ai_call_id, review_result: result, reviewer_role, edited_fields: edited, plan_id: planId });
    }

    const reject = async (reason, sourceType) => {
      db.prepare(`UPDATE p1_demand_input SET version_status = '반려', reject_reason = ?, effective_at = ?
        WHERE demand_input_id = ? AND version = ?`).run(reason, today, demand_input_id, row.version);
      const e = await ctx.events.emit({ ...base, event_type: 'DEMAND_INPUT_REJECTED', source_type: sourceType,
        payload: { demand_input_id, version: row.version, reject_reason: reason } });
      return { version_status: '반려', reject_reason: reason, event_id: e.event_id };
    };
    if (decision === '거부') return reject('담당자 확인 거부', '사람입력');
    const errors = validateDemandFields(input, { skuIds: skusOf(planId), grid: grid(), today, names: skuNames });
    if (errors.length) return reject(errors.join('; '), '계산');
    return activate({ row, input, base, today, origin: 'reply' });
  }

  // 버전을 유효로 만들고 EA를 계산해 사건을 낸다.
  async function activate({ row, input, base, today, origin, causedBy }) {
    const prev = validRow(row.plan_id);
    const id = row.demand_input_id;
    const baselineVersion = baselineRows[0].baseline_demand_version;
    const weekly = computeDemandWeekly({ demand_input_id: id, version: row.version, plan_id: row.plan_id, sku_ids: skusOf(row.plan_id),
      baselineBySku, uplift_pct: input.uplift_pct, overrides: input.overrides, sale_start_week: input.sale_start_week, sale_weeks: input.sale_weeks });
    db.exec('BEGIN');
    try {
      if (prev) db.prepare("UPDATE p1_demand_input SET version_status = '대체됨' WHERE demand_input_id = ? AND version = ?").run(prev.demand_input_id, prev.version);
      db.prepare(`UPDATE p1_demand_input SET version_status = '유효', uplift_pct = ?, sale_start_week = ?, sale_weeks = ?,
        submitted_by = ?, basis_as_of = ?, rationale_text = ?, baseline_demand_version = ?, effective_at = ?
        WHERE demand_input_id = ? AND version = ?`).run(input.uplift_pct, input.sale_start_week, input.sale_weeks,
        input.submitted_by, input.basis_as_of, input.rationale_text, baselineVersion, today, id, row.version);
      const ins = db.prepare('INSERT INTO p1_sku_override VALUES (?, ?, ?, ?, ?, ?, ?)');
      const ovSource = row.mock_record_id ? '모의회신' : '사람입력';
      for (const o of input.overrides) ins.run(id, row.version, row.plan_id, o.sku_id, o.override_uplift_pct, ovSource, base.is_synthetic ? 1 : 0);
      const insW = db.prepare('INSERT INTO p1_demand_weekly VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const w of weekly) insW.run(id, row.version, w.plan_id, w.sku_id, w.week_start, w.baseline_weekly_qty, w.applied_uplift_pct, w.added_qty_ea, w.baseline_demand_version);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    const firstValid = !prev;
    const changed = [];
    if (prev) {
      for (const k of FIELD_KEYS) if (String(prev[k]) !== String(input[k])) changed.push(k);
      const prevOv = JSON.stringify(overridesOf(id, prev.version).map((o) => [o.sku_id, o.override_uplift_pct]));
      const nowOv = JSON.stringify([...input.overrides].sort((a, b) => a.sku_id.localeCompare(b.sku_id)).map((o) => [o.sku_id, o.override_uplift_pct]));
      if (prevOv !== nowOv) changed.push('sku_overrides');
    }
    const e = await ctx.events.emit({
      ...base, caused_by: causedBy ?? base.caused_by,
      event_type: firstValid ? 'DEMAND_INPUT_REGISTERED' : 'DEMAND_INPUT_REVISED', source_type: '사람입력',
      premise_refs: [{ baseline_demand_version: baselineVersion }],
      payload: firstValid ? { demand_input_id: id, version: row.version }
        : { demand_input_id: id, version: row.version, origin, changed_fields: changed },
    });
    return { version_status: '유효', event_id: e.event_id, event_type: e.event_type, weekly_rows: weekly.length };
  }

  // 대안 선택(시기이동·물량상한·구성이동) → 새 버전
  async function handleAlternative(event) {
    const p = event.payload ?? {};
    const sel = p.alternative_selection ?? p;
    const type = sel.alternative_type ?? p.alternative_type;
    const planId = sel.plan_id ?? event.plan_id;
    if (!DEMAND_ALT_TYPES.includes(type)) return;
    const prev = validRow(planId);
    if (!prev) { ctx.log(`${planId}: 유효 수요 입력이 없어 대안(${type})을 반영하지 않았다`); return; }
    const id = prev.demand_input_id;
    const version = db.prepare('SELECT MAX(version) AS v FROM p1_demand_input WHERE demand_input_id = ?').get(id).v + 1;
    const prevOv = overridesOf(id, prev.version).map((o) => ({ sku_id: o.sku_id, override_uplift_pct: o.override_uplift_pct }));
    const input = {
      uplift_pct: sel.new_uplift_pct ?? prev.uplift_pct, sale_start_week: sel.new_sale_start_week ?? prev.sale_start_week,
      sale_weeks: sel.new_sale_weeks ?? prev.sale_weeks,
      overrides: Array.isArray(sel.new_override_uplift_pct) && sel.new_override_uplift_pct.length ? sel.new_override_uplift_pct : prevOv,
      rationale_text: `대안 선택(${type}) ${sel.alternative_id ?? p.alternative_id ?? ''}`.trim(),
      submitted_by: sel.selected_by ?? ROLE, basis_as_of: ctx.clock.today(),
    };
    db.prepare(`INSERT INTO p1_demand_input (demand_input_id, version, plan_id, version_status, origin, occurred_at,
      source_type, is_synthetic, scenario_id, reply_event_id, ai_status) VALUES (?, ?, ?, '확인대기', 'alternative', ?, '사람입력', ?, ?, ?, '해당 없음')`)
      .run(id, version, planId, event.occurred_at, event.is_synthetic ? 1 : 0, event.scenario_id, event.event_id);
    const row = getVersionRow(id, version);
    const today = ctx.clock.today();
    const base = { plan_id: planId, subject_type: 'demand_input', subject_id: `${id}#${version}`, actor_dept: event.actor_dept === 'SYSTEM' ? 'MKT' : event.actor_dept,
      actor_role: sel.selected_by ?? event.actor_role, is_synthetic: event.is_synthetic, scenario_id: event.scenario_id,
      caused_by: event.event_id, spec_ref: `${SPEC} 4.5` };
    const errors = validateDemandFields(input, { skuIds: skusOf(planId), grid: grid(), today, names: skuNames });
    if (errors.length) {
      db.prepare(`UPDATE p1_demand_input SET version_status = '반려', reject_reason = ?, effective_at = ? WHERE demand_input_id = ? AND version = ?`)
        .run(errors.join('; '), today, id, version);
      await ctx.events.emit({ ...base, event_type: 'DEMAND_INPUT_REJECTED', source_type: '계산',
        payload: { demand_input_id: id, version, reject_reason: errors.join('; ') } });
      return;
    }
    await activate({ row, input, base, today, origin: 'alternative', causedBy: event.event_id });
  }

  // 재검토가 수요 입력을 가리키면 정정 요청을 문제 4에 맡긴다.
  async function handleReview(event) {
    const p = event.payload ?? {};
    if (p.target_type !== 'demand_input') return;
    if (p.rejudge === false) return; // 이미 다시 처리했다는 뜻(사전 5.4). 정정 요청을 중복으로 내지 않는다
    const m = other('p4');
    if (!m?.requestInfo) { ctx.log(`${event.plan_id}: 문제 4 연결 안 됨, 정정 요청을 내지 못했다`); return; }
    await m.requestInfo({ request_topic: 'demand_input', requested_to: 'MKT', plan_id: event.plan_id,
      subject_type: 'demand_input', subject_id: p.target_id, request_kind: 'correction', caused_by: event.event_id });
  }

  // 회신이 가리킬 요청(문제 4). 없으면 null.
  function openDemandRequest(planId) {
    const list = safe('p4', (m) => m.listInfoRequests?.({ plan_id: planId, request_topic: 'demand_input' }) ?? []).value ?? [];
    const req = [...list].reverse().find((r) => r.request_status === '회신 대기') ?? list.at(-1) ?? null;
    if (!req) return { request: null, eventId: null };
    const ev = ctx.events.query({ plan_id: planId, event_type: 'INFO_REQUESTED', limit: 1000 })
      .find((e) => e.payload?.request_id === req.request_id);
    return { request: req, eventId: ev?.event_id ?? null };
  }

  // 회신 원문을 받는다(화면 입력 또는 모의 회신 전달). INFO_REPLIED를 내면 구독자가 버전을 만든다.
  async function receiveReply({ plan_id, reply_text, reply_pattern = null, source_type = '모의회신',
    is_synthetic = true, source_ref = null, generation_reason = null }) {
    if (!plansById.has(plan_id)) throw ctx.httpError(404, `기안이 없습니다: ${plan_id}`);
    if (!reply_text || !String(reply_text).trim()) throw ctx.httpError(400, '회신 원문이 비어 있습니다');
    const { request, eventId } = openDemandRequest(plan_id);
    const e = await ctx.events.emit({
      event_type: 'INFO_REPLIED', source_type, is_synthetic, plan_id,
      subject_type: 'info_request', subject_id: request?.request_id ?? null, actor_dept: 'MKT', actor_role: ROLE,
      caused_by: eventId, source_ref, generation_reason, spec_ref: `${SPEC} 3.3 S1`,
      payload: { request_id: request?.request_id ?? null, reply_text: String(reply_text), reply_pattern },
    });
    // 다른 사건 처리 중에 불려 구독자가 아직 돌지 않았으면 여기서 처리한다(handleReply는 같은 사건을 두 번 처리하지 않는다).
    if (!db.prepare('SELECT 1 FROM p1_demand_input WHERE reply_event_id = ?').get(e.event_id)) await handleReply(e);
    const row = db.prepare('SELECT * FROM p1_demand_input WHERE reply_event_id = ?').get(e.event_id);
    return { event_id: e.event_id, request_linked: Boolean(request), demand_input_id: row?.demand_input_id ?? null, version: row?.version ?? null };
  }

  // S1 행 하나를 전달한다. auto_confirm이면 가상 확인자의 확정값으로 확인까지 한다. 같은 행은 한 번만.
  async function deliverMockRecord(record_id, { mock_id = null, auto_confirm = true } = {}) {
    const done = db.prepare('SELECT * FROM p1_mock_delivery WHERE record_id = ?').get(record_id);
    if (done) return { already_delivered: true, ...done };
    const rec = loadMock().s1ById.get(record_id);
    if (!rec) throw ctx.httpError(404, `S1에 없는 회신입니다: ${record_id}`);
    const r = await receiveReply({ plan_id: rec.plan_id, reply_text: rec.reply_text, reply_pattern: rec.reply_pattern,
      source_ref: [`problem1/data/${S1_FILE}#${record_id}`], generation_reason: `${rec.generation_reason} · ${AUTO_NO_AI}` });
    let confirm = null;
    if (auto_confirm && r.demand_input_id) {
      confirm = await confirmDemandInput({
        demand_input_id: r.demand_input_id, version: r.version, decision: rec.confirmed_decision, is_synthetic: true,
        fields: {
          uplift_pct: rec.confirmed_uplift_pct, sale_start_week: rec.confirmed_sale_start_week, sale_weeks: rec.confirmed_sale_weeks,
          overrides: loadMock().s2.filter((o) => o.reply_record_id === record_id).map((o) => ({ sku_id: o.sku_id, override_uplift_pct: o.override_uplift_pct })),
          rationale_text: rec.rationale_text, submitted_by: rec.submitted_by, basis_as_of: rec.basis_as_of,
        },
      });
    }
    db.prepare('INSERT INTO p1_mock_delivery VALUES (?, ?, ?, ?, ?, ?)').run(record_id, mock_id, r.event_id, r.demand_input_id, r.version, ctx.clock.today());
    return { record_id, ...r, confirm };
  }

  // 문제 4 순서표(S4-09)가 부른다. mock_id의 기안에서 아직 전달하지 않은 첫 S1 행을 전달한다.
  async function deliverMock(mock_id) {
    const row = safe('p4', (m) => (m.getMockSchedule?.({ owner: 'p1' }) ?? []).find((x) => x.mock_id === mock_id));
    if (!row.connected) throw new Error('문제 4 연결 안 됨: 순서표를 읽을 수 없다');
    if (!row.value) throw new Error(`순서표에 없는 mock_id: ${mock_id}`);
    const delivered = new Set(db.prepare('SELECT record_id FROM p1_mock_delivery').all().map((x) => x.record_id));
    const rec = loadMock().s1.find((x) => x.plan_id === row.value.plan_id && !delivered.has(x.record_id));
    if (!rec) return { delivered: false, reason: `${row.value.plan_id}에 전달할 S1 행이 없다(미등록 사례이면 정상)` };
    return deliverMockRecord(rec.record_id, { mock_id });
  }

  // 요청 화면용 요약(명세 4.1). 문제 2 값을 SKU·입고 경우별로 모으기만 한다(다시 계산하지 않는다).
  // 막을 수 없는 구간 = reorder_reach_week 이전 주. 문제 2 행에 그 값이 없으면 전 구간 최소로 보이고 그렇게 표시한다.
  function supplySummary(headroom, shortfall) {
    const out = [];
    const keys = [...new Set(headroom.map((r) => `${r.sku_id}|${r.inbound_scenario}`))];
    for (const k of keys) {
      const [sku_id, inbound_scenario] = k.split('|');
      const rows = headroom.filter((r) => r.sku_id === sku_id && r.inbound_scenario === inbound_scenario);
      // 문제 2 행: supply_window='reorder'(보충 가능 구간)이면 residual_headroom_qty=null. 막을 수 없는 구간 행만 최소를 본다.
      const reach = rows.find((r) => r.reorder_reach_week)?.reorder_reach_week
        ?? rows.find((r) => r.supply_window === 'reorder')?.week_start ?? null;
      const win = rows.filter((r) => r.residual_headroom_qty != null && (!reach || r.week_start < reach));
      const min = win.reduce((a, r) => (a == null || r.residual_headroom_qty < a.residual_headroom_qty ? r : a), null);
      const sf = shortfall.find((x) => x.sku_id === sku_id && x.inbound_scenario === inbound_scenario);
      // headroom_state: none = 막을 수 없는 구간이 없음(전 구간 보충 가능), zero = 여지 0, room = 여지 있음
      const state = !min ? 'none' : min.residual_headroom_qty <= 0 ? 'zero' : 'room';
      out.push({ sku_id, inbound_scenario, reorder_reach_week: reach, headroom_state: state,
        min_residual_headroom_qty: min?.residual_headroom_qty ?? null, min_week_start: min?.week_start ?? null,
        first_stockout_week: sf?.first_stockout_week ?? null });
    }
    return out;
  }

  // 요청 화면에 붙는 내용(명세 4.1)
  function planView(planId) {
    const plan = plansById.get(planId);
    if (!plan) throw ctx.httpError(404, `기안이 없습니다: ${planId}`);
    const skus = skusOf(planId);
    const versions = versionsOf(planId).map((r) => ({
      ...rowToInput(r), reply_text: r.reply_text, request_id: r.request_id, reply_event_id: r.reply_event_id,
      ai_status: r.ai_status, ai_call_id: r.ai_call_id, extracted_fields: r.extracted_json ? JSON.parse(r.extracted_json) : null,
      missing_fields: r.missing_json ? JSON.parse(r.missing_json) : null, reject_reason: r.reject_reason,
      overrides: overridesOf(r.demand_input_id, r.version),
    }));
    const valid = validRow(planId);
    const ext = {
      grid: grid(),
      supply_summary: safe('p2', (m) => supplySummary(m.residualHeadroom?.({ plan_id: planId }) ?? [],
        skus.flatMap((sku) => m.baseOnlyShortfall?.({ sku_id: sku }) ?? []))),
      supply_judgment: safe('p2', (m) => m.latestSupplyJudgment?.(planId) ?? null),
      commitment: safe('p3', (m) => {
        const c = m.commitmentBySource?.(planId);
        return c ? { plan_id: c.plan_id, approval_route: c.approval_route, approver: c.approver } : null;
      }),
      deadline: safe('p4', (m) => m.getDeadlineSchedule?.({ plan_id: planId }) ?? null),
      info_requests: safe('p4', (m) => m.listInfoRequests?.({ plan_id: planId, request_topic: 'demand_input' }) ?? []),
      reviews: safe('p4', (m) => m.listReviews?.({ plan_id: planId, target_type: 'demand_input' }) ?? []),
      holds: safe('p4', (m) => m.listHolds?.({ plan_id: planId }) ?? []),
    };
    return {
      plan, sim_clock: ctx.clock.today(), ai_status: ctx.ai.status(),
      plan_sku_map: planSkuRows.filter((r) => r.plan_id === planId).map((r) => ({ ...r, sku_name: skuNames.get(r.sku_id) ?? null })),
      baseline_demand: skus.map((s) => baselineBySku.get(s)),
      reference_metrics: referenceByPlan.get(planId),
      demand_status_by_plan: demandStatus(planId),
      versions,
      campaign_demand_weekly: valid ? weeklyOf(valid.demand_input_id, valid.version) : [],
      mock_replies: loadMock().s1.filter((r) => r.plan_id === planId).map((r) => ({ record_id: r.record_id, reply_pattern: r.reply_pattern,
        delivered: Boolean(db.prepare('SELECT 1 FROM p1_mock_delivery WHERE record_id = ?').get(r.record_id)) })),
      external: ext,
      notice: '추가 수량은 증가율이 판매 기간 내 매주 같다고 두고 계산한 시뮬레이션 결과다. 짧은 기간에 몰리는 캠페인의 정점 주 수요를 낮게 잡을 수 있다.',
    };
  }

  // ── 마케팅 기안 담당자 화면(명세 9.5) ──
  const CLOSED = ['확정', '기한 경과 확정', '철회'];
  function closedReason(planId) {
    const st = safe('p4', (m) => m.getPlanState?.(planId)).value;
    return st && CLOSED.includes(st.plan_status) ? `이 기안은 이미 '${st.plan_status}' 상태라 수요 입력을 바꿀 수 없다` : null;
  }
  const weeklySummary = (row) => {
    if (!row) return [];
    const ov = new Map(overridesOf(row.demand_input_id, row.version).map((o) => [o.sku_id, o.override_uplift_pct]));
    const w = weeklyOf(row.demand_input_id, row.version);
    return skusOf(row.plan_id).map((sku) => {
      const rs = w.filter((x) => x.sku_id === sku);
      return { sku_id: sku, sku_name: skuNames.get(sku), baseline_weekly_qty: baselineBySku.get(sku).baseline_weekly_qty,
        applied_uplift_pct: ov.has(sku) ? ov.get(sku) : row.uplift_pct, added_qty_ea_per_week: rs[0]?.added_qty_ea ?? 0,
        weeks: rs.length, total_added_qty_ea: rs.reduce((a, x) => a + x.added_qty_ea, 0), source_type: '계산', is_simulation: true };
    });
  };
  // AI가 정리한 값을 기안 담당자가 읽는 한 문장으로
  const aiSummary = (ex) => {
    const parts = [`증가율 ${ex.uplift_pct == null ? '비어 있음' : `${Number(ex.uplift_pct).toFixed(1)}%`}`,
      `판매 시작 주 ${ex.sale_start_week ? `${ex.sale_start_week.slice(5)} 주` : '비어 있음'}`, `판매 주수 ${ex.sale_weeks ?? '비어 있음'}`];
    for (const o of ex.sku_overrides ?? []) parts.push(`${skuNames.get(o.sku_id) ?? '품목'} ${Number(o.override_uplift_pct).toFixed(1)}%`);
    return parts.join(', ');
  };
  function entryView(planId) {
    const plan = plansById.get(planId);
    if (!plan) throw ctx.httpError(404, `기안이 없습니다: ${planId}`);
    const skus = skusOf(planId);
    const valid = validRow(planId);
    const pendingRow = versionsOf(planId).filter((r) => r.version_status === '확인대기').at(-1) ?? null;
    const summary = safe('p2', (m) => supplySummary(m.residualHeadroom?.({ plan_id: planId }) ?? [], skus.flatMap((sku) => m.baseOnlyShortfall?.({ sku_id: sku }) ?? [])));
    const cover = safe('p2', (m) => m.baselineReplenishment?.({}) ?? []);
    const deadline = safe('p4', (m) => m.getDeadlineSchedule?.({ plan_id: planId }));
    const reqs = safe('p4', (m) => m.listInfoRequests?.({ plan_id: planId, request_topic: 'demand_input' }) ?? []);
    const closed = closedReason(planId);
    const ex = pendingRow?.extracted_json ? JSON.parse(pendingRow.extracted_json) : null;
    const g = grid();
    return {
      plan: { plan_id: plan.plan_id, campaign_name: plan.campaign_name, product_line: plan.product_line,
        requested_budget_krw: plan.requested_budget_krw, settlement_date: plan.settlement_date, contract_deadline: plan.contract_deadline },
      sim_clock: ctx.clock.today(), ai_status: ctx.ai.status(),
      status: demandStatus(planId),
      deadline: { demand_input_due: deadline.value?.demand_input_due ?? null, contract_deadline: plan.contract_deadline, connected: deadline.connected },
      request: (reqs.value ?? []).at(-1) ?? null,
      current: valid ? { ...rowToInput(valid), overrides: overridesOf(valid.demand_input_id, valid.version).map((o) => ({ sku_id: o.sku_id, override_uplift_pct: o.override_uplift_pct })),
        added_qty_by_sku: weeklySummary(valid), total_added_qty_ea: weeklySummary(valid).reduce((a, x) => a + x.total_added_qty_ea, 0) } : null,
      pending: pendingRow ? { demand_input_id: pendingRow.demand_input_id, version: pendingRow.version, reply_text: pendingRow.reply_text,
        occurred_at: pendingRow.occurred_at, ai_status: pendingRow.ai_status,
        extracted_fields: ex ? { uplift_pct: ex.uplift_pct, sale_start_week: ex.sale_start_week, sale_weeks: ex.sale_weeks, sku_overrides: ex.sku_overrides ?? [], rationale_text: humanize(ex.rationale_text, skuNames) } : null,
        // 화면용: 비운 값은 업무 용어로(missing_fields), 코드는 missing_field_keys에 둔다
        missing_fields: (pendingRow.missing_json ? JSON.parse(pendingRow.missing_json) : []).map((k) => FIELD_LABELS[k] ?? k),
        missing_field_keys: pendingRow.missing_json ? JSON.parse(pendingRow.missing_json) : [],
        unclear_reasons: (ex?.unclear_reasons ?? []).map((x) => humanize(x, skuNames)),
        summary: ex ? aiSummary(ex) : null } : null,
      history: versionsOf(planId).map((r) => ({ version: r.version, version_status: r.version_status, origin: r.origin, occurred_at: r.occurred_at,
        uplift_pct: r.uplift_pct, sale_start_week: r.sale_start_week, sale_weeks: r.sale_weeks, reject_reason: r.reject_reason })),
      reference: {
        connected: { supply: summary.connected, baseline_cover: cover.connected },
        skus: skus.map((sku) => {
          const rows = (summary.value ?? []).filter((x) => x.sku_id === sku);
          const at = (sc) => rows.find((x) => x.inbound_scenario === sc) ?? null;
          const pick = (x) => (x ? { headroom_state: x.headroom_state, min_residual_headroom_qty: x.min_residual_headroom_qty, min_week_start: x.min_week_start, reorder_reach_week: x.reorder_reach_week } : null);
          const bp = (cover.value ?? []).find((c) => c.sku_id === sku) ?? null;
          // 문제 2 v2.0: not_arrived = 확약 입고만, on_schedule = 예상(공급 확인 대기) 입고까지
          return { sku_id: sku, sku_name: skuNames.get(sku), baseline_weekly_qty: baselineBySku.get(sku).baseline_weekly_qty,
            unpreventable_headroom: { on_schedule: pick(at('on_schedule')), not_arrived: pick(at('not_arrived')) },
            headroom_committed: pick(at('not_arrived')), headroom_expected: pick(at('on_schedule')),
            // 품절 예상 주는 확약 입고만으로 본 값(보수적). 예상 입고까지 넣은 값은 따로 준다
            first_stockout_week: at('not_arrived')?.first_stockout_week ?? null,
            first_stockout_week_committed: at('not_arrived')?.first_stockout_week ?? null,
            first_stockout_week_expected: at('on_schedule')?.first_stockout_week ?? null,
            baseline_plan: bp ? { status: bp.plan_status, scm_confirmed: bp.scm_confirmed, corevia_committed: bp.corevia_committed,
              plan_qty_total: bp.plan_qty_total, plan_rows: (bp.plan_rows ?? []).map((r) => ({ qty: r.qty, eta_date: r.eta_date, supply_status: r.supply_status })) } : null };
        }),
        sample: referenceByPlan.get(planId),
        notice: '받을 수 있는 여지는 지금 발주해도 막을 수 없는 구간에서 기존 판매에 품절을 만들지 않고 더 받을 수 있는 수량이다. Corevia가 확약한 입고만으로 본 값이 기준이고, 확약 전(예상) 입고까지 넣은 값은 참고다. 기준 수요의 SCM 보충 계획이 확인·확약되지 않은 품목은 그만큼 불확실하다. SCM 정기 발주의 금액은 자료에 없어 현금 재전망에 들어가지 않는다.',
      },
      input_rules: { first_week_start: g.first_week_start, projection_end_week: g.projection_end_week,
        uplift_pct: '0 이상, 소수 첫째 자리까지(기준 수요 대비 %)', sale_weeks: '1 이상의 정수', sale_start_week: '월요일', override_skus: skus },
      actions: {
        closed_reason: closed,
        can_submit_text: !closed && !pendingRow, can_enter_direct: !closed && !pendingRow,
        confirm_target: pendingRow && !closed ? { demand_input_id: pendingRow.demand_input_id, version: pendingRow.version } : null,
        mode: valid ? '정정' : '최초 입력',
      },
      notice: '추가 수량은 증가율이 판매 기간 내 매주 같다고 두고 계산한 시뮬레이션 결과다.',
    };
  }
  // 값 직접 입력: 확인대기 버전을 만들고 같은 자리에서 확인(검증)까지 한다. AI를 거치지 않는다.
  async function enterDirect({ plan_id, fields = {}, reviewer_role = ROLE }) {
    if (!plansById.has(plan_id)) throw ctx.httpError(404, `기안이 없습니다: ${plan_id}`);
    const id = diId(plan_id);
    const version = (db.prepare('SELECT MAX(version) AS v FROM p1_demand_input WHERE demand_input_id = ?').get(id).v ?? 0) + 1;
    const { request } = openDemandRequest(plan_id);
    db.prepare(`INSERT INTO p1_demand_input (demand_input_id, version, plan_id, version_status, origin, occurred_at,
      source_type, is_synthetic, scenario_id, request_id, reply_text, ai_status) VALUES (?, ?, ?, '확인대기', 'reply', ?, '사람입력', 1, 'BASE', ?, '(직접 입력)', '해당 없음(직접 입력)')`)
      .run(id, version, plan_id, ctx.clock.today(), request?.request_id ?? null);
    return confirmDemandInput({ demand_input_id: id, version, decision: '확인', fields, reviewer_role });
  }
  const guardOpen = (planId) => { const r = closedReason(planId); if (r) throw ctx.httpError(409, r); };
  const describeEvent = createDescriber({ events: ctx.events, getVersionRow, validRow, overridesOf, weeklyOf, skuNames, baselineBySku, skusOf, plansById,
    findRow: (col, val) => (['reply_event_id', 'ai_call_id'].includes(col) ? db.prepare(`SELECT * FROM p1_demand_input WHERE ${col} = ?`).get(val) ?? null : null) });

  // ── 공개 함수(명세 9절) ──
  ctx.expose({
    planSkuMap: ({ plan_id, sku_id } = {}) => planSkuRows.filter((r) => (!plan_id || r.plan_id === plan_id) && (!sku_id || r.sku_id === sku_id)).map((r) => ({ ...r })),
    baselineDemand: (sku_id) => (sku_id ? (baselineBySku.get(sku_id) ? { ...baselineBySku.get(sku_id) } : null) : baselineRows.map((r) => ({ ...r }))),
    demandInput: (plan_id, { version } = {}) => rowToInput(version == null ? validRow(plan_id) : getVersionRow(diId(plan_id), Number(version))),
    demandInputVersions: (plan_id) => versionsOf(plan_id).map(rowToInput),
    skuOverrides: (demand_input_id, version) => overridesOf(demand_input_id, Number(version)),
    campaignDemandWeekly: ({ plan_id, sku_id, demand_input_id, version } = {}) => {
      let pairs;
      if (demand_input_id && version != null) pairs = [[demand_input_id, Number(version)]];
      else pairs = db.prepare("SELECT demand_input_id, version FROM p1_demand_input WHERE version_status = '유효'" + (plan_id ? ' AND plan_id = ?' : ''))
        .all(...(plan_id ? [plan_id] : [])).map((r) => [r.demand_input_id, r.version]);
      return pairs.flatMap(([i, v]) => weeklyOf(i, v)).filter((w) => !sku_id || w.sku_id === sku_id);
    },
    demandStatusByPlan: (plan_id) => (plan_id ? (plansById.has(plan_id) ? demandStatus(plan_id) : null) : [...plansById.keys()].map(demandStatus)),
    previewAddedQty: ({ plan_id, sale_start_week, sale_weeks, uplift_pct, override_uplift_pct = [] }) => {
      const input = { uplift_pct, sale_start_week, sale_weeks, overrides: override_uplift_pct, submitted_by: 'preview', basis_as_of: ctx.clock.today() };
      const errors = validateDemandFields(input, { skuIds: skusOf(plan_id), grid: grid(), names: skuNames });
      if (errors.length) throw new Error(errors.join('; '));
      return computeDemandWeekly({ plan_id, sku_ids: skusOf(plan_id), baselineBySku, uplift_pct: Number(uplift_pct),
        overrides: override_uplift_pct, sale_start_week, sale_weeks: Number(sale_weeks) });
    },
    mockDemandReplies: ({ plan_id } = {}) => loadMock().s1.filter((r) => !plan_id || r.plan_id === plan_id).map((r) => ({
      record_id: r.record_id, plan_id: r.plan_id, reply_seq: r.reply_seq, reply_pattern: r.reply_pattern, reply_text: r.reply_text,
      effective_at: r.effective_at, source_type: r.source_type, is_synthetic: true, scenario_id: r.scenario_id, spec_ref: r.spec_ref,
    })),
    deliverMock,
    deliverMockRecord,
    receiveReply,
    confirmDemandInput,
    describeEvent,
    entryView,
    enterDirect,
  });

  // ── 사건 ──
  ctx.events.on('INFO_REPLIED', handleReply);
  ctx.events.on('ALTERNATIVE_SELECTED', handleAlternative);
  ctx.events.on('REVIEW_OPENED', handleReview);

  ctx.onReset(() => { mock = null; });
  ctx.onInit(async () => {
    const b = baselineRows[0];
    await ctx.events.emit({
      event_type: 'BASELINE_DEMAND_SET', source_type: '계산', subject_type: 'baseline_demand', subject_id: b.baseline_demand_version,
      source_ref: [`01_참가자_배포용/04_원본데이터/02_masil/inventory/sku_weekly_sales_ms.csv@${b.window_start}~${b.window_end}`],
      generation_reason: '캠페인 추가분 EA의 기준 수요(명세 3.2)', spec_ref: `${SPEC} 3.2`,
      payload: { baseline_demand_version: b.baseline_demand_version, window_start: b.window_start, window_end: b.window_end },
    });
  });

  ctx.addPlanSummary((planId) => {
    const s = demandStatus(planId);
    return { label: '수요 입력', value: s.version ? `${s.demand_status} v${s.version}` : s.demand_status,
      source_type: s.version ? '사람입력' : '계산', is_synthetic: Boolean(s.is_synthetic), is_simulation: Boolean(s.version) };
  });

  // ── API 경로 (/api/p1/...) ──
  ctx.route('GET', '/plans/:plan_id', ({ params }) => planView(params.plan_id));
  ctx.route('POST', '/plans/:plan_id/replies', ({ params, body }) => receiveReply({ plan_id: params.plan_id, reply_text: body.reply_text,
    generation_reason: '화면에서 입력한 모의 회신' }));
  ctx.route('POST', '/demand-inputs/:demand_input_id/versions/:version/confirm', ({ params, body }) => confirmDemandInput({
    demand_input_id: params.demand_input_id, version: params.version, decision: body.decision ?? '확인', fields: body.fields ?? {},
    reviewer_role: body.reviewer_role ?? ROLE, is_synthetic: true }));
  ctx.route('POST', '/preview', ({ body }) => {
    try { return { rows: ctx.module('p1').previewAddedQty(body) }; }
    catch (err) { throw ctx.httpError(400, err.message); }
  });
  ctx.route('GET', '/plan-sku-map', ({ query }) => ({ rows: ctx.module('p1').planSkuMap({ plan_id: query.get('plan_id') || undefined, sku_id: query.get('sku_id') || undefined }) }));
  ctx.route('GET', '/baseline-demand', () => ({ rows: baselineRows }));
  ctx.route('GET', '/campaign-demand-weekly', ({ query }) => ({ rows: ctx.module('p1').campaignDemandWeekly({ plan_id: query.get('plan_id') || undefined }) }));
  ctx.route('GET', '/demand-status', () => ({ rows: ctx.module('p1').demandStatusByPlan() }));
  ctx.route('GET', '/mock', () => {
    const delivered = new Map(db.prepare('SELECT * FROM p1_mock_delivery').all().map((d) => [d.record_id, d]));
    return {
      sim_clock: ctx.clock.today(), file: `problem1/data/${S1_FILE}`,
      rows: loadMock().s1.map((r) => ({ record_id: r.record_id, plan_id: r.plan_id, reply_seq: r.reply_seq, reply_pattern: r.reply_pattern,
        effective_at: r.effective_at, delivered: delivered.get(r.record_id) ?? null })),
      schedule: safe('p4', (m) => m.getMockSchedule?.({ owner: 'p1' }) ?? []),
    };
  });
  // 마케팅 기안 담당자 화면(명세 9.5). 응답마다 갱신된 entry를 함께 준다
  ctx.route('GET', '/entry/:plan_id', ({ params }) => entryView(params.plan_id));
  ctx.route('POST', '/entry/:plan_id/text', async ({ params, body }) => {
    guardOpen(params.plan_id);
    const result = await receiveReply({ plan_id: params.plan_id, reply_text: body.reply_text, source_type: '사람입력', is_synthetic: true,
      source_ref: ['ui:p1-entry'], generation_reason: '기안 담당자 화면에서 입력한 자유 서술' });
    return { result, entry: entryView(params.plan_id) };
  });
  ctx.route('POST', '/entry/:plan_id/direct', async ({ params, body }) => {
    guardOpen(params.plan_id);
    const result = await enterDirect({ plan_id: params.plan_id, fields: body.fields ?? {} });
    return { result, entry: entryView(params.plan_id) };
  });
  ctx.route('POST', '/entry/:plan_id/confirm', async ({ params, body }) => {
    guardOpen(params.plan_id);
    const result = await confirmDemandInput({ demand_input_id: body.demand_input_id ?? diId(params.plan_id), version: body.version,
      decision: body.decision ?? '확인', fields: body.fields ?? {} });
    return { result, entry: entryView(params.plan_id) };
  });
  ctx.route('GET', '/describe/:event_id', ({ params }) => {
    const e = ctx.events.get(params.event_id);
    if (!e) throw ctx.httpError(404, `사건이 없습니다: ${params.event_id}`);
    return { event_id: e.event_id, card: describeEvent(e) };
  });
  ctx.route('POST', '/mock/:record_id/deliver', ({ params, body }) => deliverMockRecord(params.record_id, { auto_confirm: body.auto_confirm !== false }));
}
