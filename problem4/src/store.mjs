// 문제 4 테이블과 조회. 필드 이름은 problem4/공통_접점.md 3.4.
const J = (v) => (v == null ? null : JSON.stringify(v));
const P = (v) => (v == null ? null : JSON.parse(v));

const TABLES = {
  p4_settings: 'key TEXT PRIMARY KEY, value TEXT',
  p4_deadline: `commitment_id TEXT PRIMARY KEY, plan_id TEXT, commitment_type TEXT, linked_plan_ids TEXT,
    approval_anchor_date TEXT, anchor_basis TEXT, approver TEXT, std_approval_bd INTEGER,
    demand_input_due TEXT, judgment_due TEXT, submission_due TEXT, first_reply_due TEXT, alt_selection_due TEXT, final_reply_due TEXT,
    deadline_rule_version TEXT, computed_status TEXT, route_judgment_id TEXT, event_id TEXT`,
  p4_plan_state: `plan_id TEXT PRIMARY KEY, plan_status TEXT, plan_confirmability TEXT, confirmability_basis TEXT,
    mock_input_absent INTEGER, confirmable_since TEXT, contract_deadline TEXT, decision_snapshot TEXT`,
  p4_info_request: `request_id TEXT PRIMARY KEY, request_topic TEXT, requested_to TEXT, plan_id TEXT, subject_type TEXT, subject_id TEXT,
    request_kind TEXT, request_due_date TEXT, request_status TEXT, questions TEXT, event_id TEXT, caused_by TEXT, emitted_by TEXT,
    replied_event_id TEXT, replied_at TEXT, created_at TEXT`,
  p4_review: `review_id TEXT PRIMARY KEY, review_kind TEXT, trigger_event_id TEXT, target_type TEXT, target_id TEXT, plan_id TEXT,
    commitment_id TEXT, due_date TEXT, review_status TEXT, outcome TEXT, before TEXT, after TEXT, rationale TEXT,
    opened_event_id TEXT, closed_event_id TEXT`,
  p4_hold: `hold_id TEXT PRIMARY KEY, target_type TEXT, target_id TEXT, plan_id TEXT, hold_owner_dept TEXT, hold_due_date TEXT,
    resume_condition TEXT, hold_reason TEXT, hold_status TEXT, event_id TEXT`,
  p4_open_issue: `issue_id TEXT PRIMARY KEY, quote TEXT, source_ref TEXT, closing_rule TEXT, closing_ref TEXT, issue_status TEXT, closed_plans TEXT`,
  p4_warning: `warn_key TEXT PRIMARY KEY, event_id TEXT, warning_rule TEXT, plan_id TEXT, commitment_id TEXT, request_id TEXT,
    missed_field TEXT, due_date TEXT, recipients TEXT, message TEXT, occurred_at TEXT`,
  p4_approval_reply: `approval_reply_id TEXT PRIMARY KEY, approval_request_id TEXT, commitment_id TEXT, plan_id TEXT, decision TEXT,
    conditions TEXT, approver TEXT, replied_at TEXT, supply_judgment_version_at_reply INTEGER, record_id TEXT, event_id TEXT, cash_basis TEXT`,
  p4_mock_delivery: 'mock_key TEXT PRIMARY KEY, mock_id TEXT, sim_date TEXT, plan_id TEXT, status TEXT, event_id TEXT, note TEXT',
  p4_window: 'scenario_id TEXT PRIMARY KEY, window_version TEXT, start TEXT, end TEXT',
};

export function createStore(ctx) {
  for (const [name, ddl] of Object.entries(TABLES)) ctx.defineTable(name, ddl);
  const { db } = ctx;
  // 이전 버전 DB에 없는 열을 더한다(행은 그대로 둔다)
  for (const [name, ddl] of Object.entries(TABLES)) {
    const have = new Set(db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name));
    for (const col of ddl.split(',').map((x) => x.trim().split(/\s+/))) {
      if (col[0] && !have.has(col[0])) db.exec(`ALTER TABLE ${name} ADD COLUMN ${col[0]} ${col[1] ?? 'TEXT'}`);
    }
  }
  const all = (sql, ...a) => db.prepare(sql).all(...a);
  const one = (sql, ...a) => db.prepare(sql).get(...a) ?? null;
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  const upsert = (table, row) => {
    const keys = Object.keys(row);
    run(`INSERT OR REPLACE INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map((k) => row[k]));
  };
  const nextId = (table, col, prefix, width = 4) => {
    const n = one(`SELECT MAX(CAST(substr(${col}, ${prefix.length + 2}) AS INTEGER)) AS n FROM ${table}`).n ?? 0;
    return `${prefix}-${String(n + 1).padStart(width, '0')}`;
  };

  const deadline = (r) => r && ({
    commitment_id: r.commitment_id, plan_id: r.plan_id, approval_anchor_date: r.approval_anchor_date, anchor_basis: r.anchor_basis,
    approver: r.approver, std_approval_bd: r.std_approval_bd, demand_input_due: r.demand_input_due, judgment_due: r.judgment_due,
    submission_due: r.submission_due, first_reply_due: r.first_reply_due, alt_selection_due: r.alt_selection_due,
    final_reply_due: r.final_reply_due, deadline_rule_version: r.deadline_rule_version, computed_status: r.computed_status,
  });
  const planState = (r) => r && ({
    plan_id: r.plan_id, plan_status: r.plan_status, plan_confirmability: r.plan_confirmability,
    confirmability_basis: P(r.confirmability_basis), default_mock_input: r.mock_input_absent === 1,
    decision_snapshot: P(r.decision_snapshot ?? null),
  });
  const request = (r) => r && ({
    request_id: r.request_id, request_topic: r.request_topic, requested_to: r.requested_to, plan_id: r.plan_id,
    subject_type: r.subject_type, subject_id: r.subject_id, request_kind: r.request_kind, request_due_date: r.request_due_date,
    request_status: r.request_status,
  });
  const review = (r) => r && ({
    review_id: r.review_id, review_kind: r.review_kind, trigger_event_id: r.trigger_event_id, target_type: r.target_type,
    target_id: r.target_id, due_date: r.due_date, review_status: r.review_status, outcome: r.outcome,
    before: P(r.before), after: P(r.after), rationale: r.rationale,
  });
  const hold = (r) => r && ({
    hold_id: r.hold_id, target_type: r.target_type, target_id: r.target_id, hold_owner_dept: r.hold_owner_dept,
    hold_due_date: r.hold_due_date, resume_condition: P(r.resume_condition), hold_reason: r.hold_reason, hold_status: r.hold_status,
  });
  const issue = (r) => r && ({
    issue_id: r.issue_id, quote: r.quote, source_ref: r.source_ref, closing_rule: r.closing_rule,
    closing_ref: P(r.closing_ref), issue_status: r.issue_status,
  });
  const warning = (r) => r && ({
    event_id: r.event_id, warning_rule: r.warning_rule, plan_id: r.plan_id, commitment_id: r.commitment_id, request_id: r.request_id,
    missed_field: r.missed_field, due_date: r.due_date, recipients: P(r.recipients), message: r.message, occurred_at: r.occurred_at,
  });
  const reply = (r) => r && ({
    approval_reply_id: r.approval_reply_id, approval_request_id: r.approval_request_id, commitment_id: r.commitment_id,
    decision: r.decision, conditions: P(r.conditions), approver: r.approver, replied_at: r.replied_at,
    plan_id: r.plan_id, supply_judgment_version_at_reply: r.supply_judgment_version_at_reply, record_id: r.record_id,
    cash_basis: P(r.cash_basis),
  });

  return {
    J, P, upsert, nextId,
    setting: (key) => P(one('SELECT value FROM p4_settings WHERE key = ?', key)?.value ?? null),
    setSetting: (key, value) => upsert('p4_settings', { key, value: J(value) }),

    // 마감
    deadlineRaw: (commitmentId) => one('SELECT * FROM p4_deadline WHERE commitment_id = ?', commitmentId),
    deadlineByPlan: (planId) => deadline(one("SELECT * FROM p4_deadline WHERE plan_id = ? AND commitment_type = '기안'", planId)),
    deadlineById: (commitmentId) => deadline(one('SELECT * FROM p4_deadline WHERE commitment_id = ?', commitmentId)),
    deadlinesRaw: () => all('SELECT * FROM p4_deadline ORDER BY approval_anchor_date, commitment_id'),
    deadlines: (f = {}) => all('SELECT * FROM p4_deadline ORDER BY approval_anchor_date, commitment_id').map(deadline)
      .filter((d) => (!f.approver || d.approver === f.approver) && (!f.submission_due || d.submission_due === f.submission_due)),
    saveDeadline: (row) => upsert('p4_deadline', row),

    // 기안 상태
    planStateRaw: (planId) => one('SELECT * FROM p4_plan_state WHERE plan_id = ?', planId),
    planState: (planId) => planState(one('SELECT * FROM p4_plan_state WHERE plan_id = ?', planId)),
    planStatesRaw: () => all('SELECT * FROM p4_plan_state ORDER BY plan_id'),
    planStates: () => all('SELECT * FROM p4_plan_state ORDER BY plan_id').map(planState),
    savePlanState: (row) => upsert('p4_plan_state', row),

    // 확인 요청
    requestRaw: (id) => one('SELECT * FROM p4_info_request WHERE request_id = ?', id),
    request: (id) => request(one('SELECT * FROM p4_info_request WHERE request_id = ?', id)),
    requestByEvent: (eventId) => one('SELECT * FROM p4_info_request WHERE event_id = ?', eventId),
    requestsRaw: (where = '1=1', ...args) => all(`SELECT * FROM p4_info_request WHERE ${where} ORDER BY request_id`, ...args),
    requests: (f = {}) => all('SELECT * FROM p4_info_request ORDER BY request_id').filter((r) =>
      (!f.plan_id || r.plan_id === f.plan_id) && (!f.request_topic || r.request_topic === f.request_topic)
      && (!f.request_status || r.request_status === f.request_status) && (!f.requested_to || r.requested_to === f.requested_to)).map(request),
    saveRequest: (row) => upsert('p4_info_request', row),
    nextRequestId: () => nextId('p4_info_request', 'request_id', 'REQ'),

    // 재검토
    reviewRaw: (id) => one('SELECT * FROM p4_review WHERE review_id = ?', id),
    reviewsRaw: (where = '1=1', ...args) => all(`SELECT * FROM p4_review WHERE ${where} ORDER BY review_id`, ...args),
    reviews: (f = {}) => all('SELECT * FROM p4_review ORDER BY review_id').filter((r) =>
      (!f.plan_id || r.plan_id === f.plan_id) && (!f.target_type || r.target_type === f.target_type)
      && (!f.target_id || r.target_id === f.target_id) && (!f.review_status || r.review_status === f.review_status)).map(review),
    saveReview: (row) => upsert('p4_review', row),
    nextReviewId: () => nextId('p4_review', 'review_id', 'RV'),

    // 보류
    holdRaw: (id) => one('SELECT * FROM p4_hold WHERE hold_id = ?', id),
    holdsRaw: (where = '1=1', ...args) => all(`SELECT * FROM p4_hold WHERE ${where} ORDER BY hold_id`, ...args),
    holds: (f = {}) => all('SELECT * FROM p4_hold ORDER BY hold_id').filter((r) =>
      (!f.plan_id || r.plan_id === f.plan_id) && (!f.target_type || r.target_type === f.target_type)
      && (!f.target_id || r.target_id === f.target_id) && (!f.hold_status || r.hold_status === f.hold_status)).map(hold),
    saveHold: (row) => upsert('p4_hold', row),
    nextHoldId: () => nextId('p4_hold', 'hold_id', 'HD', 3),

    // 미결
    issueRaw: (id) => one('SELECT * FROM p4_open_issue WHERE issue_id = ?', id),
    issues: () => all('SELECT * FROM p4_open_issue ORDER BY issue_id').map(issue),
    saveIssue: (row) => upsert('p4_open_issue', row),

    // 경고
    warningExists: (key) => Boolean(one('SELECT 1 AS x FROM p4_warning WHERE warn_key = ?', key)),
    saveWarning: (row) => upsert('p4_warning', row),
    warnings: (f = {}) => all('SELECT * FROM p4_warning ORDER BY occurred_at, warn_key').filter((r) =>
      (!f.plan_id || r.plan_id === f.plan_id) && (!f.commitment_id || r.commitment_id === f.commitment_id)
      && (!f.request_id || r.request_id === f.request_id) && (!f.warning_rule || r.warning_rule === f.warning_rule)).map(warning),

    // 승인 회신(모의)
    replyForRequest: (approvalRequestId, commitmentId) => reply(one(
      'SELECT * FROM p4_approval_reply WHERE approval_request_id = ? AND commitment_id = ?', approvalRequestId, commitmentId)),
    latestReply: (commitmentId) => reply(one(
      'SELECT * FROM p4_approval_reply WHERE commitment_id = ? ORDER BY approval_reply_id DESC LIMIT 1', commitmentId)),
    replies: (f = {}) => all('SELECT * FROM p4_approval_reply ORDER BY approval_reply_id').map(reply)
      .filter((r) => (!f.plan_id || r.plan_id === f.plan_id) && (!f.commitment_id || r.commitment_id === f.commitment_id)),
    saveReply: (row) => upsert('p4_approval_reply', row),
    nextReplyId: () => nextId('p4_approval_reply', 'approval_reply_id', 'ARP'), // 문제 3 상신 ID(APR-)와 구분

    // 모의 입력 전달
    delivery: (key) => one('SELECT * FROM p4_mock_delivery WHERE mock_key = ?', key),
    deliveries: () => all('SELECT * FROM p4_mock_delivery ORDER BY sim_date, mock_key'),
    saveDelivery: (row) => upsert('p4_mock_delivery', row),

    window: (scenarioId) => one('SELECT * FROM p4_window WHERE scenario_id = ?', scenarioId),
    saveWindow: (row) => upsert('p4_window', row),
  };
}
