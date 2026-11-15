// 문제 4 사건의 설명 카드(평가자 화면 오른쪽). 사용자 결정 2026-11-15, 계약은 app/모듈_계약.md 11절.
// { title, actor_kind: '사람'|'AI'|'규칙·계산'|'모의 입력', actor_label, inputs[{label, value, source, ref}], rule, result, next }
// 저장된 표와 사건 payload만 읽고 다시 계산하지 않는다. 한국어 업무 용어와 실제 값으로 쓴다.

export const KO = {
  GRP_CEO: '그룹 CEO', MS_CEO: 'Masil 대표', MKT_TEAM: '마케팅팀', SCM: 'SCM',
  MKT: '마케팅', FIN: '재무', MS_MGMT: 'Masil 경영', GROUP: '그룹', COREVIA: 'Corevia', SYSTEM: '시스템',
  demand_input: '수요 입력', inbound_eta: '입고 예정일', supply_request: '공급 요청', po_draft_overdue: '발주 예정일 경과',
  finance_confirmation: '재무 확인', group_report: '그룹 보고', group_allocation: '그룹 300억 배분', settlement_unapproved: '미승인 집행',
  source_unknown: '출처 미상', baseline_replenishment: '기준 수요 정기 보충',
  supply_judgment: '공급 판정', route_judgment: '승인 경로 판정', commitment: '약정(승인 요청)', info_request: '확인 요청',
  plan_bundle: '기안 묶음', cash_window: '현금 하회 구간', plan: '기안', open_issue: '회의록 미결', inbound_schedule: '입고 일정', po_draft: '발주안',
  demand_input_due: '수요 입력 마감', judgment_due: '판정·재무 확인 마감', submission_due: '승인 요청(상신) 마감',
  first_reply_due: '1차 회신 마감', alt_selection_due: '대안 선택 마감', final_reply_due: '최종 회신 마감', approval_anchor_date: '승인 기준일',
  request_due_date: '회신 기한', planned_order_date: '발주 예정일', contract_deadline: '확정기한', settlement_date: '집행 예정일',
  initial: '최초', rerequest: '재요청', correction: '정정 요청',
  // L9: 카드 문장에 섞여 들어오는 영문 이름(재검토 근거·사유 문장)
  po_draft_orphaned: '기안 철회 뒤 남은 발주', supply_commitment: '공급 확약', recheck_summary: '구간 재확인 요약', closed_plans: '종결 기안',
  cash_outflow_date: '현금 유출일', window_version: '구간 버전', shortfall_window_start: '하회 구간 시작', shortfall_window_end: '하회 구간 끝',
  reorder_required: '보충 발주 필요', inbound_unconfirmed: '기존 입고 미확정', supply_commitment_pending: 'Corevia 공급 확약 대기',
  baseline_replenishment_unconfirmed: 'SCM 기준 수요 보충 미확인', plan_confirmability: '확정 가능 상태', supply_verdict: '공급 판정', approval_status: '승인 상태',
  uplift_pct: '증가율', sale_start_week: '판매 시작 주', sale_weeks: '판매 주수', plan_state: '기안 상태', decision_snapshot: '결정 시점 기록',
};
// 사건 이름(한국어). 오른쪽 카드·사건 사슬 제목에 쓴다
export const EVENT_KO = {
  BASELINE_DEMAND_SET: '기준 수요 설정', DEMAND_INPUT_STRUCTURED: '수요 회신 구조화', DEMAND_INPUT_REJECTED: '수요 입력 반려',
  DEMAND_INPUT_REGISTERED: '수요 입력 등록', DEMAND_INPUT_REVISED: '수요 입력 정정', SUPPLY_PROJECTED: '공급 전개', INBOUND_SCHEDULE_REVISED: '입고 일정 변경',
  SUPPLIER_REPLIED: '공급처 회신', SUPPLY_JUDGED: '공급 판정', ALTERNATIVES_COMPUTED: '대안 계산', ALTERNATIVE_SELECTED: '대안 선택',
  PO_DRAFT_CREATED: '발주안 생성', PO_DRAFT_CANCELLED: '발주안 취소', CASH_WINDOW_REVISED: '현금 하회 구간 산출', FINANCE_CONFIRMED: '재무 확인',
  AR_DATE_REVISED: '회수일 변경', PAYMENT_DATE_SET: '지급일 산정', ROUTE_JUDGED: '승인 경로 판정', APPROVAL_SUBMITTED: '승인 요청(상신)',
  PLAN_RECEIVED: '기안 접수', OPEN_ISSUE_RAISED: '미결 등록', OPEN_ISSUE_CLOSED: '미결 종결', INFO_REQUESTED: '확인 요청', INFO_REPLIED: '확인 회신',
  DEADLINES_SET: '마감 산출', DEADLINES_RECOMPUTED: '마감 재산출', APPROVAL_REPLIED: '승인 회신', HOLD_PLACED: '보류', HOLD_RESUMED: '보류 재개',
  HOLD_CANCELLED: '보류 해제', REVIEW_OPENED: '재검토 개시', REVIEW_CLOSED: '재검토 종결', DEADLINE_WARNED: '기한 경고',
  PLAN_CONFIRMABILITY_CHANGED: '확정 가능 상태 변경', PLAN_CONFIRMED: '기안 확정', PLAN_WITHDRAWN: '기안 철회',
  PLAN_AUTO_CONFIRMED_BY_DEADLINE: '기한 경과 확정', AI_CALL_RECORDED: 'AI 호출 기록', AI_OUTPUT_REVIEWED: 'AI 출력 확인',
};
// 문장 속 영문 이름(사건 이름·대문자 코드·snake_case 필드)을 한국어로. 모르는 이름은 그대로 두어 점검에서 드러나게 한다
const IDENT = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b|\b[a-z]+(?:_[a-z0-9]+)+\b/g;
export const koText = (t) => (t == null ? t : String(t).replace(IDENT, (x) => EVENT_KO[x] ?? KO[x] ?? x));
const ko = (x) => (x == null ? '-' : KO[x] ?? x);
const SRC = { 원본도출: '원본', 계산: '계산', 사람입력: '사람입력', 모의회신: '모의회신', 가정: '가정' };
const WARN = {
  W1: '수요 입력 마감 경과', W2: '판정·재무 확인 마감 경과', W3: '승인 요청(상신) 마감 경과', W4: '1차 회신 마감 경과',
  W5: '최종 회신 마감(묵시적 승인 경고)', W6: '발주 예정일 경과(미승인)', W7: '확인 요청 회신 기한 경과',
};
// 재검토 전후 값을 사람이 읽는 한 줄로(객체를 JSON 그대로 싣지 않는다)
const BRIEF_KEY = { supply_verdict: '판정', supply_judgment_version: '판정 버전', first_shortage_week: '첫 부족 주', approver: '승인권자', submission_due: '승인 요청 마감',
  shortfall_window_start: '구간 시작', shortfall_window_end: '구간 끝', closed_reason: '종결 사유', plan_status: '기안 상태', request_status: '요청 상태', approval_request_id: '승인 요청' };
const brief = (o) => {
  if (o == null) return '-';
  if (typeof o !== 'object') return String(o);
  const parts = Object.entries(o).filter(([k, v]) => BRIEF_KEY[k] && v != null && typeof v !== 'object').map(([k, v]) => `${BRIEF_KEY[k]} ${KO[v] ?? v}`);
  return parts.length ? parts.join(' · ') : '-';
};
const won = (v) => (v == null ? '-' : `${Math.round(v).toLocaleString('ko-KR')}원`);
const eok = (v) => (v == null ? '-' : `${v < 0 ? '−' : ''}${(Math.abs(v) / 1e8).toFixed(2)}억 원`);
const planLabel = (plans, id) => (id && id !== 'NONE' ? `${id}${plans.get(id) ? `(${plans.get(id).campaign_name})` : ''}` : '기안 공통');
const humanOrMock = (e, human = '마케팅 기안 담당자') => {
  if (e.source_type === '사람입력' && !/^기본 모의 입력|시연 모의 입력|사건 순서표/.test(e.generation_reason ?? '')) return { actor_kind: '사람', actor_label: human };
  return { actor_kind: '모의 입력', actor_label: `${human}(모의)` };
};

export function createDescriber({ ctx, store, data }) {
  const plans = () => new Map(ctx.plans().map((p) => [p.plan_id, p]));

  return function describeEvent(e) {
    const c = card(e);
    if (!c) return null;
    return { ...c, title: koText(c.title), rule: koText(c.rule), result: koText(c.result), next: koText(c.next),
      inputs: (c.inputs ?? []).map((i) => ({ ...i, label: koText(i.label), value: koText(i.value) })) };
  };
  function card(e) {
    if (!e || e.emitted_by !== 'p4') return null;
    const p = e.payload ?? {};
    const P = plans();
    const who = planLabel(P, e.plan_id);
    switch (e.event_type) {
      case 'PLAN_RECEIVED': {
        const pl = P.get(e.plan_id) ?? {};
        return {
          title: `기안 접수 · ${who}`, actor_kind: '규칙·계산', actor_label: '시스템',
          inputs: [
            { label: '요청액(표본 스케일)', value: won(p.requested_budget_krw), source: '원본', ref: (e.source_ref ?? [])[0] ?? null },
            { label: '집행 예정일', value: p.settlement_date ?? pl.settlement_date, source: '원본', ref: (e.source_ref ?? [])[0] ?? null },
            { label: '확정기한', value: p.contract_deadline ?? pl.contract_deadline, source: '원본', ref: (e.source_ref ?? [])[0] ?? null },
          ],
          rule: '원본 마케팅 예산 기안을 검토 대상으로 올린다. 접수일은 원본에 없어 미상으로 둔다. 예상 매출(GMV)은 승인 근거로 쓰지 않는다.',
          result: '검토 중으로 시작한다. 문제 3이 승인 경로를 판정하면 마감을 산출한다.',
        };
      }
      case 'OPEN_ISSUE_RAISED': case 'OPEN_ISSUE_CLOSED':
        return {
          title: `${e.event_type === 'OPEN_ISSUE_RAISED' ? '회의록 미결 등록' : '회의록 미결 종결'} · ${p.issue_id}`, actor_kind: '규칙·계산', actor_label: '시스템',
          inputs: [{ label: '회의록 원문', value: p.quote ?? '-', source: '원본', ref: p.source_ref ?? (e.source_ref ?? [])[0] ?? null }],
          rule: p.closing_rule ?? '회의록에서 정해지지 않은 항목을 미결로 추적한다.',
          result: e.event_type === 'OPEN_ISSUE_RAISED' ? '미결로 열어 두고 닫는 근거가 오면 닫는다.' : `닫음: ${p.closing_ref ?? p.reason ?? '-'}`,
        };
      case 'INFO_REQUESTED': {
        const topic = ko(p.request_topic);
        const ruleByTopic = {
          demand_input: p.request_kind === 'rerequest' ? '수요 입력 마감이 지나 경고(W1)를 내고 다시 요청한다.' : '승인 요청 마감 2영업일 전까지 수요(증가율·판매 기간)를 받는다.',
          group_report: 'Masil 대표 승인 건은 그룹에 보고한다(승인 권한 정책 9행).',
          finance_confirmation: '가장 이른 판정 마감까지 재무 재전망 확인을 받는다.',
          group_allocation: '회의록 미결(그룹 300억 배분 대상 여부)을 그룹에 묻는다.',
          po_draft_overdue: '미승인 발주안이 발주 예정일을 넘겼음을 SCM에 알린다.',
          po_draft_orphaned: '연결 기안이 모두 철회됐는데 발주가 이미 전달된 발주안은 취소하지 않고 남긴다. SCM에 Corevia 취소·수량 조정이 가능한지 묻는다(현금 유출은 그대로).',
          baseline_replenishment: 'SCM 기준 수요 보충 계획(수량·발주 예정일·도착 예정일·Corevia 확약 여부)을 SKU마다 한 번 확인한다. 회신 기한이 없고 확정을 막지 않는다.',
        };
        return {
          title: `확인 요청 · ${topic} → ${ko(p.requested_to)}${e.plan_id !== 'NONE' ? ` · ${who}` : ''}`, actor_kind: '규칙·계산', actor_label: '시스템',
          inputs: [
            { label: '대상', value: `${ko(p.subject_type)} ${p.subject_id ?? ''}`.trim(), source: '계산', ref: e.subject_id },
            { label: '회신 기한', value: p.request_due_date ?? '없음', source: '계산', ref: 'S4-01' },
          ],
          rule: ruleByTopic[p.request_topic] ?? `${topic} 확인을 요청한다(${ko(p.request_kind)}).`,
          result: `${p.request_id} 회신 대기.`,
          next: (p.questions ?? [])[0] ? `질문: ${p.questions[0]}` : undefined,
        };
      }
      case 'INFO_REPLIED':
        return {
          title: `확인 회신 · ${ko(e.actor_dept)}${p.decision ? `: ${p.decision}` : ''}`, ...humanOrMock(e, ko(e.actor_dept)),
          inputs: [{ label: '회신 내용', value: p.reply_text ?? '-', source: SRC[e.source_type] ?? e.source_type, ref: (e.source_ref ?? [])[0] ?? null }],
          rule: '회신이 오면 그 요청과 그 요청으로 이관된 원 요청의 후속 재검토를 닫는다.',
          result: `${p.request_id ?? '-'} 회신됨.`,
        };
      case 'DEADLINES_SET': case 'DEADLINES_RECOMPUTED': {
        const isPo = String(p.commitment_id ?? '').includes('POD-');
        const dueLine = ['demand_input_due', 'judgment_due', 'submission_due', 'first_reply_due', 'final_reply_due'].filter((k) => p[k]).map((k) => `${ko(k)} ${p[k]}`).join(', ');
        return {
          title: `${e.event_type === 'DEADLINES_SET' ? '마감 산출' : '마감 재산출'} · ${isPo ? `발주안 ${String(p.commitment_id).replace(/^CMT-/, '')}` : who}`, actor_kind: '규칙·계산', actor_label: '시스템',
          inputs: [
            { label: '승인 기준일', value: `${p.approval_anchor_date}(${ko(p.anchor_basis)})`, source: '계산', ref: p.route_judgment_id ?? null },
            { label: '승인권자', value: ko(p.approver), source: '계산', ref: p.route_judgment_id ?? null },
            { label: '표준 결재 소요', value: `${p.std_approval_bd}영업일`, source: '가정', ref: 'S3-03 / S4-01' },
          ],
          rule: '최종 회신 = 기준일 1영업일 전, 승인 요청 = 최종 회신 − (2 × 결재 소요 + 1)영업일, 판정 = 승인 요청 1영업일 전, 수요 입력 = 승인 요청 2영업일 전, 1차 회신 = 승인 요청 + 결재 소요.',
          result: `${dueLine}${p.computed_status && p.computed_status !== '정상' ? ` (${p.computed_status})` : ''}${p.previous_values ? `. 이전: 승인권자 ${ko(p.previous_values.approver)}, 승인 요청 마감 ${p.previous_values.submission_due}` : ''}`,
        };
      }
      case 'APPROVAL_REPLIED': {
        const cb = p.cash_basis;
        const isPo = String(p.commitment_id ?? '').includes('POD-');
        const inputs = [{ label: '승인 요청', value: p.approval_request_id ?? '-', source: '계산', ref: e.caused_by }];
        if (cb) {
          inputs.push({ label: '승인 전 재전망 최저 잔액', value: `${eok(cb.before?.min_balance_krw)}(${cb.before?.min_date ?? '-'})`, source: '계산', ref: `문제 3 승인 영향 ${p.commitment_id}` });
          inputs.push({ label: '승인했을 때 최저 잔액', value: `${eok(cb.after?.min_balance_krw)}(${cb.after?.min_date ?? '-'})`, source: '계산', ref: `문제 3 승인 영향 ${p.commitment_id}` });
          inputs.push({ label: '기준', value: eok(cb.floor_krw ?? 0), source: '가정', ref: cb.floor_record_id ?? 'S4-08-97' });
        } else {
          inputs.push({ label: '회신 자료', value: (e.source_ref ?? [])[0]?.split('#')[1] ?? '-', source: '모의회신', ref: (e.source_ref ?? [])[0] ?? null });
        }
        const conds = (p.conditions ?? []).map((c) => c.text ?? c.condition_type).join(' / ');
        return {
          title: `승인 회신 · ${ko(p.approver)}: ${p.decision} · ${isPo ? `발주안 ${String(p.commitment_id).replace(/^CMT-/, '')}` : who}`,
          actor_kind: e.source_type === '사람입력' ? '사람' : '모의 입력', actor_label: `${ko(p.approver)}${e.source_type === '사람입력' ? '' : '(모의)'}`,
          inputs,
          rule: cb ? '발주안 모의 승인 규칙: 그 발주안을 승인했을 때의 재전망 최저 잔액이 기준 미만이면 거절, 아니면 승인. 상신 순서대로 회신한다.'
            : (e.generation_reason ?? '승인권자의 모의 회신(상신일 + 표준 결재 소요일).'),
          result: `${p.decision}${conds ? `, 조건: ${conds}` : ''}${p.reason ? `. ${p.reason}` : ''}`,
          next: '문제 3이 약정 승인 상태에 반영하고, 문제 4가 확정 가능 상태를 다시 계산한다.',
        };
      }
      case 'HOLD_PLACED': case 'HOLD_RESUMED': case 'HOLD_CANCELLED':
        return {
          title: `${{ HOLD_PLACED: '보류', HOLD_RESUMED: '보류 재개', HOLD_CANCELLED: '보류 해제' }[e.event_type]} · ${who}`, ...humanOrMock(e),
          inputs: [{ label: '보류', value: p.hold_id ?? '-', source: '사람입력', ref: e.subject_id }],
          rule: '보류해도 마감은 멈추지 않는다. 재개 조건 사건이 오거나 재개 기한이 지나면 재개한다.',
          result: p.resume_reason ?? p.hold_reason ?? '-',
        };
      case 'REVIEW_OPENED': {
        const trig = p.trigger_event_id ? ctx.events.get(p.trigger_event_id) : null;
        return {
          title: `재검토 개시 · ${ko(p.target_type)}${e.plan_id !== 'NONE' ? ` · ${who}` : ''}`, actor_kind: '규칙·계산', actor_label: '시스템',
          inputs: [{ label: '계기 사건', value: trig ? `${trig.event_type}(${trig.occurred_at})` : '-', source: '계산', ref: p.trigger_event_id }],
          rule: p.review_kind === '기한 경과 후속' ? '회신 기한이 지난 확인 요청을 후속으로 연다(확정을 막지 않는다).'
            : p.review_kind === '사람 판단' ? '규칙으로 정할 수 없는 항목이라 사람이 유지·변경을 정한다.'
              : `전제가 바뀌면 그 전제를 쓴 ${ko(p.target_type)}를 다시 본다. ${p.rejudge === false ? '소유 문제가 이미 다시 계산했으므로 직전 결과와 비교해 닫는다.' : '소유 문제의 재계산을 기다린다.'}`,
          result: `${p.review_id} 열림${p.due_date ? `, 기한 ${p.due_date}` : ''}. ${p.review_kind === '기한 경과 후속' ? '' : '열려 있는 동안 확정 가능이 되지 않는다.'}`,
        };
      }
      case 'REVIEW_CLOSED':
        return {
          title: `재검토 종결 · ${p.outcome ?? '종결'}${e.plan_id !== 'NONE' ? ` · ${who}` : ''}`, actor_kind: e.source_type === '사람입력' ? '사람' : '규칙·계산',
          actor_label: e.source_type === '사람입력' ? '검토 담당' : '시스템',
          inputs: [
            { label: '전', value: brief(p.before), source: '계산', ref: p.review_id },
            { label: '후', value: brief(p.after), source: '계산', ref: p.review_id },
          ],
          rule: '전후 결론을 비교해 같으면 유지, 다르면 변경으로 닫고 근거를 남긴다.',
          result: p.rationale ?? '-',
        };
      case 'DEADLINE_WARNED':
        return {
          title: `기한 경고 · ${WARN[p.warning_rule] ?? p.warning_rule}${e.plan_id !== 'NONE' ? ` · ${who}` : ''}`, actor_kind: '규칙·계산', actor_label: '시스템',
          inputs: [{ label: ko(p.missed_field), value: p.due_date, source: '계산', ref: p.commitment_id ?? p.request_id }],
          rule: `${p.warning_rule}: ${p.message ?? '마감이 지났는데 필요한 처리가 없다.'}`,
          result: `${(p.recipients ?? []).map(ko).join('·')}에 알린다.`,
        };
      case 'PLAN_CONFIRMABILITY_CHANGED': {
        const b = p.confirmability_basis ?? {};
        return {
          title: `확정 가능 상태 · ${p.previous} → ${p.current} · ${who}`, actor_kind: '규칙·계산', actor_label: '시스템',
          inputs: [
            { label: '공급 판정', value: b.supply_judgment_version ? `v${b.supply_judgment_version}` : '없음', source: '계산', ref: b.supply_judgment_id ?? null },
            { label: '승인 상태', value: b.approval_status ?? '-', source: '계산', ref: e.plan_id },
            { label: '열린 재검토·보류', value: `${(b.open_review_ids ?? []).length}건 · ${(b.hold_ids ?? []).length}건`, source: '계산', ref: null },
          ],
          rule: '공급 판정·승인 상태·조건·열린 재검토·보류를 함께 보고 확정 가능 / 조건부 대기 / 불가 / 미확인을 정한다(명세 4.5).',
          result: b.reason ?? p.current,
        };
      }
      case 'PLAN_CONFIRMED': case 'PLAN_WITHDRAWN': {
        const sn = p.decision_snapshot ?? {};
        const confirm = e.event_type === 'PLAN_CONFIRMED';
        return {
          title: `${confirm ? '기안 확정' : '기안 철회'} · ${who}`, ...humanOrMock(e),
          inputs: [
            { label: '결정 시점 공급 판정', value: `${sn.supply_verdict ?? '-'}${sn.supply_judgment_version ? ` v${sn.supply_judgment_version}` : ''}`, source: '계산', ref: sn.supply_judgment_id ?? null },
            { label: '승인 상태', value: sn.approval_status ?? '-', source: '계산', ref: e.plan_id },
            ...(confirm ? [] : [{ label: '사유', value: p.reason ?? '-', source: e.source_type === '사람입력' ? '사람입력' : '가정', ref: null }]),
          ],
          rule: confirm ? '확정 가능인 기안만 확정기한 안에 확정할 수 있다.' : '검토 중인 기안만 철회할 수 있다. 기본 모의 입력은 확정기한 전 영업일에도 부족이면 철회한다.',
          result: `${confirm ? '확정' : '철회'}(${sn.decided_at ?? e.occurred_at}). 이후 판정은 동결된다.`,
        };
      }
      case 'PLAN_AUTO_CONFIRMED_BY_DEADLINE':
        return {
          title: `기한 경과 확정 · ${who}${p.direct_no_input ? ' · 담당자 입력 없음' : ''}`, actor_kind: '규칙·계산', actor_label: '시스템',
          inputs: [
            { label: '확정기한', value: p.contract_deadline ?? '-', source: '원본', ref: e.plan_id },
            { label: '마지막 승인 상태', value: p.last_approval_status ?? p.decision_snapshot?.approval_status ?? '-', source: '계산', ref: e.plan_id },
            ...(p.direct_no_input ? [{ label: '직접 처리 기안', value: p.direct_no_input.awaited.length ? `담당자가 하지 않은 일: ${p.direct_no_input.awaited.join(', ')}` : '다른 부서 회신을 기다리던 중', source: '계산', ref: e.plan_id }] : []),
          ],
          rule: '확정기한까지 확정·철회 결정이 없으면 승인자 없이 기한 경과 확정으로 기록한다. 묵시적 승인과 같은 효과다(정책 38~39행).',
          result: '기한 경과 확정. 남은 후속 재검토는 종결(회신 없음)로 닫는다.',
        };
      default:
        return null;
    }
  }
}
