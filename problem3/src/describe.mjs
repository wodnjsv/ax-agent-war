// 문제 3 사건 설명 카드(오른쪽 평가자 화면용 공통 계약 describeEvent, 사용자 결정 2026-11-15).
// 카드만 읽고 '어떤 데이터로, 어떤 규칙으로, 무엇이 바뀌었는지' 알 수 있게 한국어 업무 용어와 실제 값으로 쓴다.
// 계산·판정은 하지 않고, 사건 payload와 그때 저장된 기록(구간 버전·판정 버전)만 읽는다.

const won = (n) => (n == null ? '-' : `${Math.round(Number(n)).toLocaleString('ko-KR')}원`);
const eok = (n) => (n == null ? '-' : `${(Number(n) / 1e8).toFixed(2)}억 원`);
const parse = (v, d = null) => (v == null ? d : typeof v === 'string' ? JSON.parse(v) : v);

export const RULE_TEXT = {
  'R-01': '현금 잔액이 재무 약정상 최소 잔액(30억 원) 아래로 내려갈 것으로 예상되는 구간에 현금이 나가는 신규 약정은 그룹 CEO 결재를 받는다(승인 권한 정책 11·18~22행).',
  'R-02': '하회 구간 밖이면 평시 기준을 쓴다. 건별 1천만 원 초과 또는 기안 묶음 총액 1억 원 초과는 Masil 대표가 승인하고 그룹에 보고한다(승인 권한 정책 9행).',
  'R-03': '하회 구간 밖이고 건별 1천만 원 이하, 기안 묶음 총액 1억 원 이하이면 마케팅팀 전결이다(승인 권한 정책 9행).',
  'R-04': '하회 구간 밖의 재고 발주는 평시처럼 SCM이 승인한다(승인 권한 정책 6행).',
};
const RULE_SHORT = { 'R-01': '유출일이 하회 구간 안', 'R-02': '평시 금액 기준 초과', 'R-03': '평시 전결 범위', 'R-04': '평시 재고 발주' };
const ANCHOR = { contract_deadline: '확정기한', settlement_date: '집행 예정일', planned_order_date: '발주 예정일', same: '확정기한(=집행 예정일)' };
const WINDOW_BASIS = { policy_recalc: '정책 방식 재전망', finance_confirmed: '재무 확인 반영', scenario: '시나리오' };
const SCENARIO = { BASE: '기본', 'S-AR-DELAY': '회수일 지연', 'S-CEO-FLOOR': '그룹 CEO 잔액 하한', 'S-SUP-REPLY': '공급 요청 회신', 'S4-OI3-A': '그룹 배정 회신' };

const segText = (s) => `${s.start}~${s.end}${s.end_at_horizon ? '(재전망 끝까지)' : ''}, ${s.bd_count ?? s.bd}영업일, 최저 ${eok(s.min_balance_krw)}`;
function windowText(w) {
  if (!w?.shortfall_window_start) return '하회 구간 없음';
  const segs = parse(w.segments, []);
  if (segs.length > 1) return `${segs.length}조각: ${segs.map((s, i) => `${i + 1}) ${segText(s)}`).join(' / ')}`;
  return `${w.shortfall_window_start}~${w.shortfall_window_end}(${w.shortfall_bd_count}영업일)`;
}

// h: index.mjs가 넘기는 읽기 도구
export function createDescriber(h) {
  const name = (a) => h.approverName(a);
  // 판정 사유 문장에 남은 승인권자 코드를 한국어 이름으로 바꾼다(한계 L9)
  const koCodes = (t) => String(t ?? '').replace(/\b(GRP_CEO|MS_CEO|MKT_TEAM)\b/g, (m) => name(m));
  const planRef = (planId) => `02_masil/marketing/mkt_budget_plan_ms.csv#${planId}`;

  function cashWindowRevised(e) {
    const p = e.payload ?? {};
    const w = h.windowRow(p.window_version);
    if (!w) return null;
    const prev = h.prevWindowRow(w.n);
    const drafts = parse(w.approved_drafts, []);
    const draftRows = drafts.map((id) => h.commitmentBySource(id)).filter(Boolean);
    const overrides = parse(w.ar_overrides, {});
    const rs = p.recheck_summary;
    const cause = e.caused_by ? h.event(e.caused_by) : null;
    const inputs = [
      { label: '기초 잔액(06-30 종가)', value: won(h.opening), source: '원본', ref: '02_masil/financials/fin_cash_daily_ms.csv#2026-06-30' },
      { label: '재무 약정상 최소 현금 잔액', value: won(h.threshold), source: '원본', ref: '02_masil/financials/fin_cash_daily_ms.csv#covenant_min_krw' },
      { label: '미수금 회수 예정', value: `${h.raw.ar.length}건, 만기일에 회수(07-01 만기 2건은 기본 제외)`, source: '원본', ref: '02_masil/financials/fin_ar_aging_ms.csv' },
      { label: '일반 지급(발주 외)', value: `${h.raw.ap.filter((r) => r.po_id === 'NONE').length}건`, source: '원본', ref: '02_masil/financials/fin_ap_aging_ms.csv(po_id=NONE)' },
      { label: '기발주 지급', value: `${h.raw.po.length}건 ${eok(h.raw.po.reduce((s, r) => s + Number(r.amount_krw), 0))}, 07-21 지급`, source: '원본', ref: '02_masil/inventory/sc_purchase_orders_ms.csv' },
    ];
    if (draftRows.length) inputs.push({ label: '내부 승인된 발주안 지급(지출 허용 기준, 공급 확약과 무관)', value: `${draftRows.length}건 ${eok(draftRows.reduce((s, c) => s + c.amount_krw, 0))}`, source: '계산', ref: drafts.join(', ') });
    for (const [ar, date] of Object.entries(overrides)) inputs.push({ label: `회수 예정일 변경(${ar})`, value: `${h.raw.ar.find((r) => r.ar_id === ar)?.due_date ?? '-'} → ${date}`, source: '모의회신', ref: w.finance_reply_id ?? '-' });
    if (cause) inputs.push({ label: '계기', value: h.eventTitle(cause), source: cause.source_type === '모의회신' ? '모의회신' : cause.source_type === '사람입력' ? '사람입력' : '계산', ref: cause.event_id });
    const now = `${windowText(w)}, 최저 ${eok(w.min_balance_krw)}(${w.min_date})`;
    const spans = (x) => JSON.stringify(parse(x.segments, []).map((s) => [s.start, s.end]));
    const changed = prev && spans(prev) !== spans(w);
    return {
      title: prev ? `현금 하회 구간 ${changed ? '변경' : '재계산(구간 그대로)'}: ${windowText(w)}` : `현금 하회 구간 산출: ${windowText(w)}`,
      actor_kind: '규칙·계산', actor_label: '시스템(현금 재전망)',
      inputs,
      rule: '06-30 종가에서 영업일마다 미수금 회수를 더하고 일반 지급·발주 지급을 빼 잔액을 누적한다. 30억 원 아래인 날이 이어지는 기간이 하회 구간이다(정책 방식 재전망). 발주안 지급은 내부 승인(지출 허용) 때 한 번 넣고, Corevia 공급 불가로 발주안이 취소되면 뺀다. 재무팀 공식 전망은 판정에 쓰지 않는다. 한계: SCM 기준 수요 정기 보충 발주의 지급은 금액 근거가 없어 넣지 않았다.',
      result: prev
        ? `${windowText(prev)}(최저 ${eok(prev.min_balance_krw)}) → ${now}. 기준: ${WINDOW_BASIS[w.window_basis] ?? w.window_basis}·${SCENARIO[w.scenario_id] ?? w.scenario_id}.${rs ? ` 약정 ${rs.rechecked}건을 다시 대조해 결론이 바뀐 ${rs.changed}건만 재판정하고 ${rs.kept}건은 유지(종결 제외 ${rs.skipped_terminal}건).` : ''}`
        : `${now}. 기준: ${WINDOW_BASIS[w.window_basis] ?? w.window_basis}.`,
      next: rs?.changed ? `결론이 바뀐 약정 재판정: ${rs.changed_commitments.map((x) => `${x.plan_id !== 'NONE' ? x.plan_id : x.commitment_id} ${name(x.before.approver)} → ${name(x.after.approver)}`).join(', ')}` : '승인 경로가 바뀌는 약정 없음',
    };
  }

  function financeReply(e) {
    const p = e.payload ?? {};
    const applied = h.appliedReply(p.finance_reply_id);
    const w = applied ? h.windowRow(applied.window_version) : null;
    const isConfirm = e.event_type === 'FINANCE_CONFIRMED';
    const rows = p.ar_rows ?? [{ ar_id: p.ar_id, ar_expected_receipt_date: p.ar_expected_receipt_date }];
    const inputs = rows.map((r) => ({ label: `회수 예정일 ${r.ar_id}`, value: `${r.ar_expected_receipt_date}(원본 만기 ${h.raw.ar.find((a) => a.ar_id === r.ar_id)?.due_date ?? '-'})`, source: '모의회신', ref: `problem3/data/s3_04_finance_reply.csv#${p.finance_reply_id}` }));
    if (isConfirm) {
      inputs.push({ label: '재무팀이 확인한 하회 구간', value: `${p.confirmed_window_start}~${p.confirmed_window_end}`, source: '모의회신', ref: p.finance_reply_id });
      inputs.push({ label: '재무팀이 인지한 최저 잔액', value: won(p.min_balance_ack_krw), source: '모의회신', ref: p.finance_reply_id });
    }
    return {
      title: isConfirm ? `재무 확인(가상 회신): 하회 구간 ${p.confirmed_window_start}~${p.confirmed_window_end}` : `미수금 회수일 변경(가상 회신): ${rows.map((r) => `${r.ar_id} → ${r.ar_expected_receipt_date}`).join(', ')}`,
      actor_kind: '모의 입력', actor_label: '재무팀(가상 회신)',
      inputs,
      rule: '재무팀 회신의 회수 예정일을 재전망에 반영해 하회 구간을 다시 계산한다. 회신 구간과 계산 구간이 다르면 불일치로 남긴다.',
      result: w ? `재전망 결과 ${windowText(w)}, 최저 ${eok(w.min_balance_krw)}(${w.min_date})${w.mismatch ? `. 불일치: ${w.mismatch}` : ''}. 모든 약정의 재무 확인 상태가 '확인됨'이 된다.` : '반영 결과 없음',
      next: w ? `현금 하회 구간 새 버전 ${w.window_version}` : null,
    };
  }

  function paymentDateSet(e) {
    const p = e.payload ?? {};
    const c = h.commitmentBySource(p.po_draft_id);
    const term = h.term(p.payment_rule_id);
    return {
      title: `발주안 ${p.po_draft_id} 지급일 산출: ${p.payment_due_date}`,
      actor_kind: '규칙·계산', actor_label: '시스템(지급일 산출)',
      inputs: [
        { label: '발주 예정일', value: c?.planned_order_date ?? '-', source: '계산', ref: `문제 2 발주안 ${p.po_draft_id}` },
        { label: '발주 금액', value: won(c?.amount_krw), source: '계산', ref: `문제 2 발주안 ${p.po_draft_id}` },
        { label: '공급처 결제 조건', value: term ? `${term.supplier_id}: 청구월 마감, ${term.payment_month_offset}개월 뒤 ${term.payment_day}일 지급` : '-', source: '합성', ref: `problem3/data/s3_01_supplier_payment_terms.csv#${p.payment_rule_id}` },
      ],
      rule: '발주 예정일이 속한 달을 마감해 다음 달 21일에 지급하고, 그날이 주말이면 다음 영업일로 미룬다. 원본 기발주 14건의 지급일을 모두 재현하는 조건이다.',
      result: `지급 예정일 ${p.payment_due_date}. 이 날짜가 발주안 약정의 현금 유출일이 되어 약정 원장에 등록된다.`,
      next: '이 유출일로 승인 경로를 판정한다',
    };
  }

  function routeJudged(e) {
    const p = e.payload ?? {};
    const rj = h.rjRow(p.route_judgment_id) ?? {};
    const c = h.commitment(p.commitment_id) ?? {};
    const isDraft = p.commitment_type === '발주안';
    const w = h.windowRow(p.window_version);
    const seg = parse(rj.matched_segment);
    const sw = parse(rj.scenario_window);
    const inputs = [
      isDraft
        ? { label: '약정', value: `발주안 ${c.source_id} ${won(p.amount_krw ?? c.amount_krw)}(연결 기안 ${(p.linked_plan_ids ?? []).join(', ') || '-'})`, source: '계산', ref: c.source_ref }
        : { label: '약정', value: `기안 ${p.plan_id} 요청액 ${won(p.amount_krw ?? c.amount_krw)}(표본 스케일)`, source: c.source_type === '사람입력' ? '사람입력' : '원본', ref: c.source_ref ?? planRef(p.plan_id) },
      { label: '현금 유출일', value: p.cash_outflow_date, source: isDraft ? '계산' : c.source_type === '사람입력' ? '사람입력' : '원본', ref: isDraft ? `지급일 산출(${c.payment_rule_id ?? '-'})` : `${planRef(p.plan_id)}(집행 예정일)` },
      { label: isDraft ? '하회 구간(이 발주안 지급을 더한 재전망)' : '하회 구간(현행)', value: sw ? windowText(sw) : windowText(w), source: '계산', ref: p.window_version },
    ];
    if (rj.route_rule_id === 'R-02' || rj.route_rule_id === 'R-03') inputs.push({ label: '기안 묶음 총액(원 기안 기준)', value: won(h.bundleTotal(c.plan_bundle_id)), source: '합성', ref: `problem3/data/s3_02_plan_bundle.csv#${c.plan_bundle_id}` });
    inputs.push({ label: '승인 기준일', value: `${p.approval_anchor_date}(${ANCHOR[p.anchor_basis] ?? p.anchor_basis})`, source: isDraft ? '계산' : '원본', ref: isDraft ? c.source_ref : planRef(p.plan_id) });
    const where = seg
      ? `유출일 ${p.cash_outflow_date}이 하회 구간${seg.segment_count > 1 ? ` ${seg.segment_count}조각 중 ${seg.segment_no}번째` : ''}(${seg.start}~${seg.end}) 안`
      : `유출일 ${p.cash_outflow_date}이 하회 구간 밖`;
    const first = !p.previous_route_judgment_id;
    return {
      title: `승인 경로 판정: ${name(p.approver)}(${RULE_SHORT[p.route_rule_id] ?? p.route_rule_id})${first ? ' · 약정 등록' : p.route_changed ? ' · 경로 변경' : ''}`,
      actor_kind: '규칙·계산', actor_label: '시스템(승인 경로 판정)',
      inputs,
      rule: `${RULE_TEXT[p.route_rule_id] ?? ''}${isDraft ? ' 발주안은 그 발주안 지급을 더한 재전망과 대조한다.' : ''}`,
      result: `${where} → 승인권자 ${name(p.approver)}${p.group_report_required ? '(그룹 보고 필요)' : ''}. ${first ? `${isDraft ? '발주안' : '기안'} 약정을 원장에 등록하고 최초 판정.` : koCodes(rj.rationale?.split('. ')[0])} 승인 상태: ${p.approval_status}.`,
      next: p.approval_status === '미상신' ? `${isDraft ? 'SCM이' : '마케팅 기안 담당자가'} ${name(p.approver)}에게 승인 요청을 올린다(결재 소요 ${p.std_approval_bd ?? '-'}영업일 가정)` : null,
    };
  }

  function approvalSubmitted(e) {
    const p = e.payload ?? {};
    const rows = (p.commitment_ids ?? []).map((id) => h.commitment(id)).filter(Boolean);
    const req = h.reqRow(p.approval_request_id);
    const mock = /모의|시연/.test(e.actor_role ?? '') || /모의/.test(e.generation_reason ?? '');
    const draft = req?.draft_id ? h.draft(req.draft_id) : null;
    const inputs = rows.map((c) => ({ label: c.commitment_type === '발주안' ? `발주안 ${c.source_id}` : `기안 ${c.plan_id}`, value: `${won(c.amount_krw)}, 유출일 ${c.cash_outflow_date}`, source: c.commitment_type === '발주안' ? '계산' : '원본', ref: c.route_judgment_id }));
    if (draft) inputs.push({ label: '상신 문서', value: `${draft.draft_id}(${draft.mode === 'AI' ? 'AI 초안' : '양식'}, ${draft.review_status})`, source: draft.mode === 'AI' ? '계산' : '사람입력', ref: draft.ai_call_id ?? draft.draft_id });
    if (p.submission_due) inputs.push({ label: '상신 마감', value: p.submission_due, source: '계산', ref: '문제 4 마감표' });
    const superseded = h.supersededBy(p.approval_request_id);
    return {
      title: `승인 요청 상신: ${name(p.approver)}에게 ${rows.length}건`,
      actor_kind: mock ? '모의 입력' : '사람', actor_label: rows[0]?.commitment_type === '발주안' ? 'SCM' : '마케팅 기안 담당자',
      inputs,
      rule: '같은 승인권자·같은 상신 마감의 미상신 약정을 한 번에 올린다. 같은 약정을 다시 올리면 이전 요청의 그 약정은 대체된다.',
      result: `${rows.map((c) => c.plan_id !== 'NONE' ? c.plan_id : c.source_id).join(', ')}의 승인 상태가 '결재 대기'가 된다.${superseded.length ? ` 대체된 이전 요청: ${superseded.join(', ')}.` : ''}`,
      next: `${name(p.approver)}의 회신을 기다린다`,
    };
  }

  // 승인 회신은 문제 4가 내는 사건이다. 문제 3은 그 회신을 약정 상태에 반영한 결과를 설명한다
  function approvalReplied(e) {
    const p = e.payload ?? {};
    const c = h.commitment(p.commitment_id);
    if (!c) return null;
    const req = h.reqRow(p.approval_request_id);
    const superseded = req && (req.superseded === 1 || parse(req.superseded_commitment_ids, []).includes(p.commitment_id));
    const cb = p.cash_basis;
    const inputs = [
      { label: '회신 대상', value: `${c.commitment_type === '발주안' ? `발주안 ${c.source_id}` : `기안 ${c.plan_id}`} · 요청 ${p.approval_request_id}`, source: '계산', ref: p.approval_request_id },
      { label: '결정', value: `${p.decision}${(p.conditions ?? []).length ? `(조건: ${p.conditions.map((x) => x.text ?? x.condition_type).join(' / ')})` : ''}`, source: '모의회신', ref: e.source_ref?.[0] ?? e.event_id },
    ];
    if (cb) inputs.push({ label: '승인 가정 재전망 최저 잔액', value: `${eok(cb.before?.min_balance_krw)} → ${eok(cb.after?.min_balance_krw)}(하한 ${eok(cb.floor_krw ?? 0)})`, source: '계산', ref: cb.window_version ?? '-' });
    const win = c.commitment_type === '발주안' && p.decision === '승인' ? h.windowCausedBy(e.event_id) : null;
    const isDraft = c.commitment_type === '발주안';
    const risk = p.supply_risk_accepted === true || (p.conditions ?? []).some((x) => x.acceptance_type === '공급 위험 수용');
    if (risk) inputs.push({ label: '공급 위험 수용', value: '승인권자가 미확인 공급 조건을 알고 받아들임(공급 상태는 그대로)', source: '모의회신', ref: e.event_id });
    const supplyNote = isDraft && p.decision !== '거절' ? ` 내부 승인은 구매·지출을 허용한 것이며 Corevia 공급 확약이 아니다. 현재 공급 확약 상태: ${h.supplyLabel(c.source_id)}.` : '';
    return {
      title: `${isDraft ? '내부 승인 회신' : '승인 회신'}: ${name(p.approver)} ${p.decision}${isDraft ? ` · 발주안 ${c.source_id}` : ` · ${c.plan_id}`}${risk ? ' · 공급 위험 수용' : ''}`,
      actor_kind: '모의 입력', actor_label: name(p.approver),
      inputs,
      rule: '결재 대기 약정에 회신 결정을 반영한다. 대체된 요청에 온 회신은 반영하지 않고, 이미 승인된 약정에 온 조건부 회신은 조건만 기록한다. 승인된 발주안은 재전망에 넣어 하회 구간을 다시 계산한다.',
      result: superseded ? '대체된 요청에 대한 회신이라 반영하지 않음.' : `약정 승인 상태 반영: ${p.decision}${p.reason ? `. 사유: ${p.reason}` : ''}.${win ? ` 하회 구간 새 버전 ${win.window_version}: ${windowText(win)}, 최저 ${eok(win.min_balance_krw)}.` : ''}${risk ? ' 공급 위험 수용은 승인 상태에만 기록하고 공급 판정·입고 상태는 바꾸지 않는다.' : ''}${supplyNote}`,
      next: p.decision === '거절' ? '거절된 약정은 대안 선택(물량 상한·시기 이동) 또는 철회로 간다' : null,
    };
  }

  // 문제 3이 부른 AI(승인 요청 문서 초안)의 호출·확인 기록. 작업 이름은 한국어로 쓴다(한계 L9)
  const AI_TASK_KO = { submission_draft: '승인 요청 문서 초안 작성' };
  const REVIEW_KO = { 확인: '그대로 확인', '수정 후 확인': '고친 뒤 확인', 거부: '거부' };
  function aiCall(e) {
    const p = e.payload ?? {};
    if (e.emitted_by && e.emitted_by !== 'p3') return null;
    const task = AI_TASK_KO[p.ai_task_name];
    if (!task) return null;
    const d = h.draftByAiCall(p.ai_call_id);
    return {
      title: `AI 작성: ${task}${e.plan_id && e.plan_id !== 'NONE' ? ` · ${e.plan_id}` : ''}`,
      actor_kind: 'AI', actor_label: p.model ?? 'AI',
      inputs: [
        { label: '입력 자료', value: '상신 자료(캠페인·승인권자와 이유·하회 구간·현금 영향·공급 확약 상태·미확인 조건, 시스템 값 그대로)', source: '계산', ref: (p.input_refs ?? []).join(', ') || '-' },
        ...(d ? [{ label: '초안', value: d.draft_id, source: '계산', ref: d.draft_id }] : []),
      ],
      rule: 'AI는 문서를 쓰기만 하고 숫자·날짜·승인권자·판정을 바꾸거나 새로 만들지 않는다. 시스템 번호·영문 필드 이름 없이 업무 용어로 쓴다.',
      result: '초안을 확인 대기로 저장했다. 담당자가 확인하거나 고치기 전에는 상신에 쓸 수 없다.',
      next: '마케팅 기안 담당자가 초안을 확인·수정한다',
    };
  }
  function aiReviewed(e) {
    const p = e.payload ?? {};
    if (e.emitted_by && e.emitted_by !== 'p3') return null;
    const d = h.draftByAiCall(p.ai_call_id);
    if (!d) return null;
    return {
      title: `담당자 확인: 승인 요청 문서 초안을 ${REVIEW_KO[p.review_result] ?? p.review_result}`,
      actor_kind: '사람', actor_label: '마케팅 기안 담당자',
      inputs: [{ label: 'AI 초안', value: d.draft_id, source: '계산', ref: p.ai_call_id }],
      rule: 'AI 초안은 담당자가 확인하거나 고친 뒤에만 상신 문서로 쓴다. 고치면 원문을 따로 남긴다.',
      result: p.review_result === '거부' ? '초안을 쓰지 않는다.' : `상신 문서로 쓸 수 있다${p.review_result === '수정 후 확인' ? '(고친 문서, 원문 보관)' : ''}.`,
    };
  }

  const handlers = {
    AI_CALL_RECORDED: aiCall, AI_OUTPUT_REVIEWED: aiReviewed,
    CASH_WINDOW_REVISED: cashWindowRevised, FINANCE_CONFIRMED: financeReply, AR_DATE_REVISED: financeReply,
    PAYMENT_DATE_SET: paymentDateSet, ROUTE_JUDGED: routeJudged, APPROVAL_SUBMITTED: approvalSubmitted, APPROVAL_REPLIED: approvalReplied,
  };
  return function describeEvent(event) {
    const fn = event && handlers[event.event_type];
    if (!fn) return null;
    try { return fn(event); } catch (err) { h.log?.(`describeEvent 실패 ${event.event_id}: ${err.message}`); return null; }
  };
}
