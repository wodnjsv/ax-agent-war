// 사용자 결정(2026-11-15) 화면용 묶음: 왼쪽(마케팅 기안 담당자) 홈·기안 화면, 오른쪽(평가자) 행동 단위 사건 사슬.
// 계산·판정 규칙은 바꾸지 않는다. 각 문제의 공개 함수 결과를 모아 업무 문장으로 바꿀 뿐이다.
import { KO, EVENT_KO, koText } from './describe.mjs';

// AI 작업 이름(사전 8.4)의 한국어
const AI_TASK_KO = { submission_draft: '승인 요청 문서 초안 작성', event_impact_summary: '사건 영향 요약', demand_reply_structure: '수요 회신 정리', supplier_eta_structure: '공급처 납기 회신 정리', judgment_change_explain: '판정 변경 설명', alternative_compare: '대안 비교 설명' };

const ko = (x) => (x == null ? '-' : KO[x] ?? x);
const md = (d) => (d ? `${Number(d.slice(5, 7))}월 ${Number(d.slice(8, 10))}일` : '-');
const SRC = { 원본도출: '원본', 계산: '계산', 사람입력: '사람입력', 모의회신: '모의회신', 가정: '가정' };
const TERMINAL = new Set(['확정', '철회', '기한 경과 확정']);
const MODULE_OF = { p1: '수요 입력', p2: '공급 판정', p3: '승인 경로', p4: '마감·재검토·확정' };

export function createUserViews({ ctx, store, engine, describeOwn, lapseStory, poRepliesFor = () => [] }) {
  const m = (id) => ctx.module(id);
  const safe = (fn, fb = null) => { try { return fn() ?? fb; } catch { return fb; } };
  const today = () => ctx.clock.today();
  const plansById = () => new Map(ctx.plans().map((p) => [p.plan_id, p]));
  const left = (D, due) => (due ? ctx.cal.businessDaysBetween(D, due) : null);

  // ── 설명 카드: 모든 모듈의 describeEvent를 묻고, 사건을 낸 모듈의 카드를 앞에 둔다. 없으면 사건 이름과 payload 요약 ──
  function describeAny(e) {
    const cards = [];
    for (const id of ['p1', 'p2', 'p3', 'p4']) {
      const fn = id === 'p4' ? describeOwn : m(id)?.describeEvent;
      const card = fn ? safe(() => fn(e)) : null;
      if (card) cards.push({ owner: id, ...card });
    }
    cards.sort((a, b) => (a.owner === e.emitted_by ? -1 : b.owner === e.emitted_by ? 1 : 0));
    const main = cards[0] ?? aiFallback(e) ?? {
      owner: e.emitted_by, title: `${EVENT_KO[e.event_type] ?? e.event_type}${e.plan_id && e.plan_id !== 'NONE' ? ` · ${e.plan_id}` : ''}`,
      actor_kind: e.source_type === '사람입력' ? (e.is_synthetic ? '모의 입력' : '사람') : e.source_type === '모의회신' ? '모의 입력' : '규칙·계산',
      actor_label: ko(e.actor_dept), inputs: [], rule: koText(e.generation_reason ?? ''),
      // 영문 필드 이름은 싣지 않는다(L9): 아는 이름만 한국어로, 모르는 이름은 값만
      result: Object.entries(e.payload ?? {}).filter(([, v]) => v != null && typeof v !== 'object').slice(0, 5).map(([k, v]) => (KO[k] ? `${KO[k]}: ${v}` : String(v))).join(', '),
      fallback: true,
    };
    return {
      ...main, also: cards.slice(1).map((c) => ({ owner: c.owner, title: c.title, result: c.result })),
      event: { event_id: e.event_id, event_type: e.event_type, event_label: EVENT_KO[e.event_type] ?? e.event_type, occurred_at: e.occurred_at, plan_id: e.plan_id,
        emitted_by: e.emitted_by, module: MODULE_OF[e.emitted_by] ?? e.emitted_by, source_type: SRC[e.source_type] ?? e.source_type,
        is_synthetic: e.is_synthetic, is_simulation: e.is_simulation, scenario_id: e.scenario_id, caused_by: e.caused_by },
    };
  }

  // AI 호출·확인 기록을 낸 모듈이 카드를 주지 않으면 공통 형식으로 쓴다(호출 기록은 app/core/ai.mjs가 남긴다)
  function aiFallback(e) {
    const p = e.payload ?? {};
    if (e.event_type === 'AI_CALL_RECORDED') {
      return { owner: e.emitted_by, title: `AI ${p.ai_task_type === 'write' ? '작성' : '구조화'} · ${AI_TASK_KO[p.ai_task_name] ?? koText(p.ai_task_name ?? '')}${e.plan_id !== 'NONE' ? ` · ${e.plan_id}` : ''}`,
        actor_kind: 'AI', actor_label: p.model ?? 'AI', inputs: (p.input_refs ?? []).slice(0, 4).map((r) => ({ label: '입력', value: r, source: '계산', ref: r })),
        rule: 'AI는 정리·작성만 하고 판정하지 않는다. 사람이 확인하기 전에는 반영하지 않는다.',
        result: `${p.status ?? '기록'} · ${p.review_status ?? ''}${(p.null_fields ?? []).length ? ` · 비운 칸 ${p.null_fields.map(koText).join(', ')}` : ''}` };
    }
    if (e.event_type === 'AI_OUTPUT_REVIEWED') {
      return { owner: e.emitted_by, title: `AI 결과 확인 · ${p.review_result ?? ''}${e.plan_id !== 'NONE' ? ` · ${e.plan_id}` : ''}`,
        actor_kind: '사람', actor_label: p.reviewer_role === 'MKT-LINE-OWNER' || !p.reviewer_role ? '마케팅 기안 담당자' : p.reviewer_role,
        inputs: [{ label: 'AI 호출', value: p.ai_call_id ?? '-', source: '계산', ref: p.ai_call_id ?? null }],
        rule: 'AI가 만든 결과는 담당자가 확인·수정·거부한 뒤에만 쓴다.', result: `${p.review_result ?? '-'}${(p.edited_fields ?? []).length ? `(고친 칸: ${p.edited_fields.map(koText).join(', ')})` : ''}` };
    }
    return null;
  }

  // ── 오른쪽: 행동 단위 사건 사슬(caused_by로 같은 시작점에 이어진 사건들) ──
  function flow({ plan_id = null, limit = 8, per_group = 60 } = {}) {
    const all = ctx.events.query({ limit: 1e9 });
    const byId = new Map(all.map((e) => [e.event_id, e]));
    const rootOf = new Map();
    // 사람(화면 사용자)의 행동은 그 자체로 시작점이다. 위로 거슬러 올라가다 사람 행동을 만나면 거기서 멈춘다.
    const humanCache = new Map();
    const isHuman = (e) => {
      if (!humanCache.has(e.event_id)) humanCache.set(e.event_id, (e.source_type === '사람입력' || e.event_type === 'AI_OUTPUT_REVIEWED') && describeAny(e).actor_kind === '사람');
      return humanCache.get(e.event_id);
    };
    const root = (e) => {
      if (rootOf.has(e.event_id)) return rootOf.get(e.event_id);
      let cur = e;
      for (let n = 0; !isHuman(cur) && cur.caused_by && byId.has(cur.caused_by) && n < 40; n += 1) cur = byId.get(cur.caused_by);
      rootOf.set(e.event_id, cur.event_id);
      return cur.event_id;
    };
    const groups = new Map();
    for (const e of all) {
      const r = root(e);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(e);
    }
    let list = [...groups.entries()].map(([r, evs]) => ({ root: byId.get(r), events: evs.sort((a, b) => a.event_id.localeCompare(b.event_id)) }));
    // 묶음 상신처럼 기안 칸이 '공통'인 사건도 내용에 그 기안이 들어 있으면 그 기안의 흐름으로 본다
    const touches = (e) => e.plan_id === plan_id || (e.plan_id === 'NONE' && JSON.stringify(e.payload ?? {}).includes(`${plan_id}"`));
    if (plan_id) list = list.filter((g) => g.events.some(touches));
    list.sort((a, b) => (b.events.at(-1).event_id.localeCompare(a.events.at(-1).event_id)));
    const out = list.slice(0, limit).map((g) => {
      const evs = g.events.filter((e) => !plan_id || touches(e) || e.plan_id === 'NONE' || e.event_id === g.root.event_id);
      const cards = evs.slice(0, per_group).map(describeAny);
      return {
        root_event_id: g.root.event_id, started_at: g.root.occurred_at, trigger: cards[0] ?? describeAny(g.root),
        cards, total: evs.length, truncated: evs.length > per_group,
        modules: [...new Set(evs.map((e) => e.emitted_by))],
        sources: [...new Set(cards.flatMap((c) => (c.inputs ?? []).map((i) => i.source)).filter(Boolean))],
      };
    });
    const isUser = (g) => g.trigger.actor_kind === '사람';
    return { sim_clock: today(), plan_id, groups: out, latest_user_action: out.find(isUser)?.root_event_id ?? null, total_events: all.length };
  }

  // ── 왼쪽: 기안 하나의 지금 상태 ──
  function planCore(planId, D) {
    const plan = plansById().get(planId);
    const st = store.planStateRaw(planId);
    const d = store.deadlineByPlan(planId);
    const c = m('p3') ? safe(() => m('p3').commitmentBySource(planId)) : null;
    const sj = m('p2') ? safe(() => m('p2').latestSupplyJudgment(planId)?.plan) : null;
    const demand = m('p1') ? safe(() => m('p1').demandInput(planId)) : null;
    const submits = c ? ctx.events.query({ event_type: 'APPROVAL_SUBMITTED', limit: 1e9 }).filter((e) => (e.payload?.commitment_ids ?? []).includes(c.commitment_id)) : [];
    const std = c ? safe(() => m('p3').approverRole(c.approver)?.std_approval_bd) ?? d?.std_approval_bd ?? 2 : null;
    const replyDue = submits.length && c?.approval_status === '결재 대기' ? ctx.cal.addBusinessDays(submits.at(-1).occurred_at, std) : null;
    const pa = m('p2')?.planAlternatives ? safe(() => m('p2').planAlternatives(planId)) : null;
    // 끝난 기안은 마지막 판정의 조건(기다리는 회신)을 더 보이지 않는다(철회 뒤 취소된 발주안의 확약 대기 등)
    const decision = sj?.supply_verdict === '조건부' && st?.plan_status === '검토 중' && m('p2')?.planDecision ? safe(() => m('p2').planDecision(planId)) : null;
    const facts = sj?.supply_verdict && sj.supply_verdict !== '판정불가' ? supplyFacts(planId, decision) : { lines: [], waiting: [] };
    return { plan, st, d, c, sj, demand, replyDue, pa, facts, direct: engine.isDirect(planId) };
  }

  // ── 공급 확약 사실(사용자 요청 2026-11-15 마): 문제 2의 Corevia 회신·도착 예정·조건을 업무 문장으로 ──
  // 내부 승인(지출 허용)과 Corevia 공급 확약과 입고를 나눠 말한다. 계산하지 않고 문제 2 값만 읽는다.
  function supplyFacts(planId, decision = null) {
    const p2 = m('p2');
    if (!p2) return { lines: [], waiting: [] };
    const names = new Map((m('p1')?.entryView ? safe(() => m('p1').entryView(planId)?.reference?.skus, []) : []).map((x) => [x.sku_id, x.sku_name]));
    const nm = (sku) => names.get(sku) ?? '해당 품목';
    // 발주안 대상은 연결 기안으로, 기발주 대상(문제 2 v2.1)은 이 기안의 품목으로 찾는다. 기발주의 제때 확약은 줄이지 않고 알릴 것(지연·부분·불가·미확인·확인 필요·정정)만 보인다
    const commits = p2.supplyCommitments ? safe(() => p2.supplyCommitments({}), []).filter((c) => (c.target_type === '기발주'
      ? names.has(c.sku_id) && !(c.reply_status === '가능' && c.validation_status === '정상' && !(Number(c.delay_weeks) > 0) && !c.supersedes_record_id)
      : (c.linked_plan_ids ?? []).includes(planId))) : [];
    const pending = p2.pendingSupplyCommitments ? safe(() => p2.pendingSupplyCommitments(), []) : [];
    const myPos = new Set((p2.poDrafts ? safe(() => p2.poDrafts({}), []) : []).filter((d) => (d.linked_plan_ids ?? []).includes(planId)).map((d) => d.po_draft_id));
    const lines = [];
    const waiting = [];
    for (const x of pending.filter((y) => y.po_draft_id && myPos.has(y.po_draft_id) && !commits.some((c) => c.target_id === y.po_draft_id))) {
      lines.push({ cond: true, kind: 'pending', text: `보충 발주는 내부 승인됐지만 Corevia 공급 확약을 기다리는 중입니다(회신 예정 ${md(x.due_date)}).` });
      waiting.push({ from: 'Corevia', what: '보충 발주의 공급 확약 회신', due: x.due_date });
    }
    for (const c of commits) {
      const what = `${nm(c.sku_id)} ${c.target_type === '기발주' ? '기존 발주분' : '보충 발주'}`;
      if (c.validation_status === '확인 필요') { lines.push({ kind: 'check', text: `${what}: Corevia 회신 내용이 서로 맞지 않아 확인이 필요합니다(${(c.validation_issues ?? []).join(', ') || '날짜·수량·조건'}). 입고는 예상 그대로입니다.` }); waiting.push({ from: 'Corevia', what: `${what} 회신 정정`, due: null }); continue; }
      if (c.reply_status === '불가') { lines.push({ kind: 'bad', text: `${what}: Corevia가 공급 불가로 회신했습니다. 이 물량에 기대던 공급은 막혔습니다.` }); continue; }
      if (c.reply_status === '미확인') { lines.push({ kind: 'wait', text: `${what}: Corevia가 아직 공급 가능 여부를 확인하지 못했습니다(원료 ${c.material_status ?? '미확인'}, 생산 ${c.production_status ?? '미확인'}).` }); waiting.push({ from: 'Corevia', what: `${what} 공급 확약`, due: null }); continue; }
      if (c.reply_status === '부분 가능') lines.push({ kind: 'partial', text: `${what}: 부분 확약 — ${Number(c.committed_qty ?? 0).toLocaleString('ko-KR')}개 확약, ${Number(c.uncommitted_qty ?? 0).toLocaleString('ko-KR')}개 미확약.` });
      else if (Number(c.delay_weeks) > 0) lines.push({ kind: 'delay', text: `${what}: ${/원료/.test(`${c.eta_basis ?? ''}${c.remaining_conditions ?? ''}`) && c.material_status !== '확보' ? '원료 지연으로' : '생산·납기 사정으로'} 도착이 ${md(c.offered_eta_date)}로 밀렸습니다(${c.delay_weeks}주 지연, 확약 ${Number(c.committed_qty ?? 0).toLocaleString('ko-KR')}개).` });
      else lines.push({ kind: 'ok', text: `${what}: Corevia가 ${c.supersedes_record_id ? '앞 회신을 정정해 ' : ''}${Number(c.committed_qty ?? 0).toLocaleString('ko-KR')}개를 ${md(c.offered_eta_date)} 도착으로 확약했습니다.` });
    }
    // 입고 처리(문제 2 v2.2 L7): 입고 완료(입고 실적, 모의 입력)와 도착 예정일 경과·미확약
    const SRC_KO = (r) => (/^IN_TRANSIT/.test(r.source_ref) ? '운송 중 물량' : /^SPO-/.test(r.source_ref) ? '기존 발주분' : /^POD-/.test(r.source_ref) ? '보충 발주'
      : /^SCM-BR:[^:]+:(\d+)/.test(r.source_ref) ? `SCM 보충 ${r.source_ref.match(/:(\d+)$/)?.[1] ?? ''}차` : '입고');
    const inbound = (p2.inboundSchedule ? safe(() => p2.inboundSchedule({})?.rows, []) : []).filter((r) => names.has(r.sku_id));
    for (const r of inbound.filter((x) => x.supply_status === '예정일 경과·미확약')) {
      lines.push({ kind: 'overdue', text: `${nm(r.sku_id)} ${SRC_KO(r)}: 도착 예정일 ${md(r.original_eta_date ?? r.eta_date)}이 지났는데 공급 확약이 없습니다. 지금은 ${md(r.expected_now_week)} 주 도착으로 보고, 확약 입고만 보는 판정에서는 빠집니다.` });
      waiting.push({ from: /^SCM-BR/.test(r.source_ref) ? 'SCM·Corevia' : 'Corevia', what: `${nm(r.sku_id)} ${SRC_KO(r)} 도착 확약`, due: null });
    }
    const arrived = inbound.filter((x) => x.supply_status === '입고 완료');
    for (const sku of [...new Set(arrived.map((x) => x.sku_id))]) {
      const rs = arrived.filter((x) => x.sku_id === sku);
      lines.push({ kind: 'arrived', text: `${nm(sku)}: 입고 완료 — ${rs.map((x) => `${SRC_KO(x)} ${Number(x.received_qty ?? x.qty).toLocaleString('ko-KR')}개(${md(x.received_on ?? x.eta_date)})`).join(', ')}. 입고 실적은 확약 수량 그대로 넣은 모의 입력입니다.` });
    }
    const toldPo = new Set(commits.filter((c) => c.target_type === '기발주').map((c) => c.sku_id));
    for (const cond of decision?.conditions ?? []) {
      if (cond.condition_type === 'baseline_replenishment_unconfirmed') {
        // SCM이 보충 계획을 확인했어도 Corevia 확약 전이면 같은 조건이다. 누구를 기다리는지 나눠 말한다
        const br = p2.baselineReplenishment ? safe(() => p2.baselineReplenishment({ sku_id: cond.sku_id }), [])[0] : null;
        if (br?.plan_status === 'SCM 확인·Corevia 미확약') {
          lines.push({ cond: true, kind: 'wait', text: `${nm(cond.sku_id)}: SCM 기준 수요 보충 계획은 확인됐지만 Corevia 공급 확약 전입니다. 판매 기간 뒤 기존 판매분이 모자랄 수 있습니다.` });
          waiting.push({ from: 'Corevia', what: `${nm(cond.sku_id)} 기준 수요 보충분 공급 확약`, due: null });
        } else {
          lines.push({ cond: true, kind: 'wait', text: `${nm(cond.sku_id)}: SCM 기준 수요 보충 계획이 확인되지 않았습니다. 판매 기간 뒤 기존 판매분이 모자랄 수 있습니다.` });
          waiting.push({ from: 'SCM', what: `${nm(cond.sku_id)} 기준 수요 보충 계획 회신`, due: null });
        }
      }
      if (cond.condition_type === 'inbound_unconfirmed' && !toldPo.has(cond.sku_id)) { lines.push({ cond: true, kind: 'wait', text: `${nm(cond.sku_id)}: 기존 발주분 입고가 아직 확약되지 않았습니다.` }); waiting.push({ from: 'Corevia·SCM', what: `${nm(cond.sku_id)} 기존 발주 입고 확약`, due: null }); }
      if (cond.condition_type === 'supply_commitment_pending' && !lines.some((l) => l.kind === 'pending')) { lines.push({ cond: true, kind: 'pending', text: `${nm(cond.sku_id)}: 보충 발주는 내부 승인됐지만 Corevia 공급 확약을 기다리는 중입니다.` }); waiting.push({ from: 'Corevia', what: `${nm(cond.sku_id)} 공급 확약 회신`, due: null }); }
    }
    const seen = new Set();
    return { lines: lines.filter((l) => !seen.has(l.text) && seen.add(l.text)), waiting };
  }

  // 지금 할 일(사용자) 또는 기다리는 일(다른 부서). 판정 규칙은 문제 1·2·3·4가 정한 상태를 읽기만 한다.
  function nextStep(core, D) {
    const { st, d, c, sj, demand, replyDue, pa } = core;
    const verdict = sj?.supply_verdict ?? null;
    const appr = c?.approval_status ?? '미상신';
    const deadline = st.contract_deadline;
    if (TERMINAL.has(st.plan_status)) return null;
    if (!demand) return { who: 'me', action: 'demand', label: '수요 입력', due: d?.demand_input_due ?? deadline, text: '캠페인 증가율과 판매 기간을 입력해야 공급을 확인할 수 있습니다.' };
    if (appr === '거절') return { who: 'me', action: 'alternatives', label: '대안 선택(승인 거절)', due: d?.alt_selection_due && d.alt_selection_due >= D ? d.alt_selection_due : deadline, text: '승인이 거절됐습니다. 대안을 고르거나 기안을 접어야 합니다.' };
    if (verdict === '부족') return { who: 'me', action: 'alternatives', label: '대안 선택', due: d?.alt_selection_due && d.alt_selection_due >= D ? d.alt_selection_due : deadline,
      text: pa?.has_feasible ? '공급이 부족합니다. 대안을 골라 바꾸거나 기안을 접어야 합니다.' : '공급이 부족하고 실행할 수 있는 대안이 없습니다. 접는 것을 검토하세요.' };
    if (st.plan_confirmability === '확정 가능') return { who: 'me', action: 'confirm', label: '확정', due: deadline, text: '공급과 승인이 모두 확인됐습니다. 확정기한 안에 확정하세요.' };
    if (st.plan_confirmability === '위험 수용 확정 가능') return { who: 'me', action: 'confirm', label: '확정(공급 위험 수용)', due: deadline, text: '공급은 아직 확약되지 않았지만 승인권자가 그 위험을 수용했습니다. 확정하면 공급 미확약 상태로 확정됩니다.' };
    if (appr === '미상신' && ['가능', '조건부'].includes(verdict)) return { who: 'me', action: 'approval', label: '승인 요청 올리기', due: d?.submission_due ?? deadline,
      text: `${ko(c?.approver)} 승인이 필요합니다.` };
    if (!verdict || verdict === '판정불가') return { who: 'other', action: null, label: '공급 판정', waiting_on: '공급 확인(SCM·시스템)', due: d?.judgment_due ?? null, text: '수요 입력으로 공급 판정을 기다리는 중입니다.' };
    if (appr === '결재 대기') return { who: 'other', action: null, label: '승인 회신', waiting_on: ko(c?.approver), due: replyDue ?? d?.first_reply_due ?? null, text: `${ko(c?.approver)}의 승인 회신을 기다리는 중입니다.` };
    if (st.plan_confirmability === '조건부 대기') {
      const reason = JSON.parse(st.confirmability_basis || '{}').reason ?? '';
      if (/발주안 .* 승인 전/.test(reason)) return { who: 'other', action: null, label: '보충 발주안 내부 승인', waiting_on: 'SCM 상신·승인권자', due: null, text: '보충 발주안의 내부 승인을 기다리는 중입니다.' };
      const w = core.facts?.waiting?.[0];
      return { who: 'other', action: null, label: w ? w.what : '공급 확약 회신', waiting_on: w ? w.from : 'Corevia·SCM', due: w?.due ?? null,
        text: '내부 승인과 별개로 공급 확약(또는 보충 계획) 회신을 기다리는 중입니다. 승인으로는 풀리지 않습니다.' };
    }
    const reason = JSON.parse(st.confirmability_basis || '{}').reason ?? '';
    return { who: 'other', action: null, label: '재검토', waiting_on: '시스템(전제 변경 재검토)', due: null, text: reason || '바뀐 전제를 다시 확인하는 중입니다.' };
  }

  function sentence(core, step, D) {
    const { st, sj, c, replyDue } = core;
    if (st.plan_status === '확정') { const sn = JSON.parse(st.decision_snapshot || '{}'); return sn.confirmed_under_risk ? `공급 미확약 상태로 확정한 기안입니다(${md(sn.decided_at)}, 승인권자 위험 수용). 공급 확약 회신은 계속 확인해야 합니다.` : `확정한 기안입니다(${md(sn.decided_at)}).`; }
    if (st.plan_status === '철회') return `철회한 기안입니다(${md(JSON.parse(st.decision_snapshot || '{}').decided_at)}).`;
    if (st.plan_status === '기한 경과 확정') return '확정기한까지 결정이 없어 기한 경과 확정됐습니다. 승인 없이 집행되는 것과 같은 효과입니다.';
    const v = sj?.supply_verdict;
    const types = new Set((sj?.condition_basis ?? []).map((x) => x.condition_type));
    const condLabel = types.has('reorder_required') ? '보충 발주 필요' : types.has('supply_commitment_pending') ? 'Corevia 공급 확약 대기' : types.has('baseline_replenishment_unconfirmed') ? 'SCM 기준 수요 보충 미확인' : types.has('inbound_unconfirmed') ? '기존 입고 미확약' : '조건 확인 필요';
    const supply = !v || v === '판정불가' ? '공급은 아직 판정 전입니다' : v === '가능' ? '공급은 가능합니다' : v === '조건부' ? `공급은 조건부(${condLabel})입니다` : '공급이 부족합니다';
    const appr = c?.approval_status ?? '미상신';
    const approval = appr === '승인' ? `${ko(c?.approver)} 승인을 받았습니다` : appr === '결재 대기' ? `${ko(c?.approver)} 승인을 기다리는 중입니다${replyDue ? `. 회신 예정 ${md(replyDue)}` : ''}`
      : appr === '거절' ? `${ko(c?.approver)}가 승인을 거절했습니다` : appr === '조건부' ? `${ko(c?.approver)}가 조건부로 승인했습니다` : '승인 요청은 아직 올리지 않았습니다';
    const due = step?.due ? (step.due < D ? `(${md(step.due)} 마감 지남)` : step.due === D ? `(오늘 ${md(step.due)} 마감)` : `(${md(step.due)}까지, ${left(D, step.due)}영업일 남음)`) : '';
    const tail = step?.who === 'me' ? ` 지금 할 일: ${step.label}${due}.` : '';
    const fact = (core.facts?.lines ?? []).find((l) => ['pending', 'partial', 'delay', 'bad', 'check'].includes(l.kind));
    const riskNote = st.plan_confirmability === '위험 수용 확정 가능' ? ' 승인권자가 공급 위험을 수용해 확정할 수 있지만 공급은 아직 확약되지 않았습니다.' : '';
    return `${supply}${v === '부족' ? '.' : ','} ${approval}.${fact ? ` ${fact.text}` : ''}${riskNote}${tail}`;
  }

  function steps(core) {
    const { st, sj, c, demand } = core;
    const v = sj?.supply_verdict;
    const appr = c?.approval_status ?? '미상신';
    const term = TERMINAL.has(st.plan_status);
    return [
      { name: '수요 입력', state: demand ? 'done' : term ? 'skip' : 'todo', text: demand ? `증가율 ${demand.uplift_pct}% · ${md(demand.sale_start_week)} 주부터 ${demand.sale_weeks}주` : '입력 전' },
      { name: '공급 확인', state: v === '가능' ? 'done' : v === '조건부' ? 'wait' : v === '부족' ? 'bad' : term ? 'skip' : 'todo',
        text: v ? (v === '판정불가' ? '수요 입력 필요' : v === '조건부' ? `조건부 · ${core.facts?.waiting?.[0] ? `${core.facts.waiting[0].from} 회신 대기` : '확약 대기'}` : v) : '판정 전' },
      { name: '승인', state: appr === '승인' ? 'done' : appr === '거절' ? 'bad' : appr === '결재 대기' || appr === '조건부' ? 'wait' : term ? 'skip' : 'todo', text: `${ko(c?.approver)} · ${appr}` },
      { name: '확정', state: st.plan_status === '확정' ? 'done' : st.plan_status === '검토 중' ? (['확정 가능', '위험 수용 확정 가능'].includes(st.plan_confirmability) ? 'todo' : 'wait') : 'bad',
        text: st.plan_status === '검토 중' ? st.plan_confirmability : st.plan_status === '확정' && JSON.parse(st.decision_snapshot || '{}').confirmed_under_risk ? '확정(공급 미확약·위험 수용)' : st.plan_status },
    ];
  }

  function home() {
    const D = today();
    const todo = []; const waiting = []; const done = [];
    for (const p of ctx.plans()) {
      const core = planCore(p.plan_id, D);
      const base = { plan_id: p.plan_id, campaign_name: p.campaign_name, product_line: p.product_line, direct: core.direct, contract_deadline: p.contract_deadline };
      if (TERMINAL.has(core.st.plan_status)) {
        const sn = JSON.parse(core.st.decision_snapshot || '{}');
        done.push({ ...base, status: sn.confirmed_under_risk ? '확정(위험 수용)' : core.st.plan_status, decided_at: sn.decided_at ?? null, supply_note: sn.supply_note ?? null });
        continue;
      }
      const s = nextStep(core, D);
      const item = { ...base, ...s, days_left: left(D, s?.due), overdue: s?.due ? s.due < D : false, sentence: sentence(core, s, D) };
      if (s?.who === 'me' && core.direct) todo.push(item);
      else waiting.push(core.direct ? item : { ...item, waiting_on: s?.who === 'me' ? '자동 처리(모의 입력)' : item.waiting_on, auto: true });
    }
    const byDue = (a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999');
    const open = new Set([...todo, ...waiting].map((x) => x.plan_id));
    const alerts = ctx.events.query({ event_type: 'DEADLINE_WARNED', order: 'desc', limit: 200 })
      .filter((e) => open.has(e.plan_id) && e.occurred_at >= ctx.cal.addBusinessDays(D, -3))
      .map((e) => ({ plan_id: e.plan_id, campaign_name: plansById().get(e.plan_id)?.campaign_name ?? '', occurred_at: e.occurred_at,
        // 왼쪽 화면이므로 기안 코드는 빼고 경고 내용만 쓴다
        text: (describeOwn(e)?.title ?? '기한 경고').replace(/^기한 경고 · /, '').split(' · ')[0], due_date: e.payload?.due_date, direct: engine.isDirect(e.plan_id) }))
      .sort((a, b) => Number(b.direct) - Number(a.direct)).slice(0, 8);
    return { sim_clock: D, alerts, todo: todo.sort(byDue), waiting: waiting.sort(byDue), done: done.sort((a, b) => (b.decided_at ?? '').localeCompare(a.decided_at ?? '')),
      direct_plans: engine.getDirectPlans(),
      // L8: 직접 처리 기안이 무엇이고 지금 무엇을 기다리는지(자동으로 진행되지 않는다)
      direct: engine.getDirectPlans().map((id) => {
        const item = [...todo, ...waiting].find((x) => x.plan_id === id);
        const fin = done.find((x) => x.plan_id === id);
        return { plan_id: id, campaign_name: plansById().get(id)?.campaign_name ?? id, state: fin ? `끝남(${fin.status})` : item ? (item.who === 'me' ? `내 차례: ${item.label}` : `${item.waiting_on ?? '다른 부서'} 대기: ${item.label}`) : '-',
          due: item?.due ?? null, mine: item?.who === 'me' };
      }),
      notice: '요청액은 표본 스케일이라 현금과 합산하지 않습니다.' };
  }

  function planView(planId) {
    const D = today();
    const core = planCore(planId, D);
    if (!core.plan || !core.st) throw ctx.httpError(404, `기안이 없습니다: ${planId}`);
    const s = nextStep(core, D);
    const entry = m('p1')?.entryView ? safe(() => m('p1').entryView(planId)) : null;
    const decision = m('p2')?.planDecision ? safe(() => m('p2').planDecision(planId)) : null;
    const approval = m('p3')?.approvalView ? safe(() => m('p3').approvalView(planId)) : null;
    const open = !TERMINAL.has(core.st.plan_status);
    const actions = [
      { kind: 'demand', label: core.demand ? '수요 정정' : '수요 입력', enabled: open && Boolean(entry?.actions?.can_submit_text || entry?.actions?.can_enter_direct), primary: s?.action === 'demand' },
      { kind: 'alternatives', label: '대안 보기·선택', enabled: open && (decision?.alternatives ?? []).some((a) => a.feasible && !a.selected), primary: s?.action === 'alternatives' },
      { kind: 'approval', label: '승인 요청 올리기', enabled: open && Boolean(approval?.can_submit), primary: s?.action === 'approval', blocked_reason: approval?.can_submit ? null : (approval?.submit_blockers ?? [])[0] ?? null },
      { kind: 'confirm', label: core.st.plan_confirmability === '위험 수용 확정 가능' ? '확정(공급 위험 수용)' : '확정', enabled: open && ['확정 가능', '위험 수용 확정 가능'].includes(core.st.plan_confirmability) && core.st.contract_deadline >= D, primary: s?.action === 'confirm' },
      { kind: 'withdraw', label: '철회', enabled: open, primary: false },
    ];
    const dl = core.d;
    const supplyBrief = decision ? supplySummary(core, decision, entry) : null;
    return {
      sim_clock: D, plan: core.plan, direct: core.direct, plan_status: core.st.plan_status, confirmability: core.st.plan_confirmability,
      sentence: sentence(core, s, D), next: s, steps: steps(core), actions,
      why: {
        supply: decision ? { headline: decision.headline, reasons: decision.reasons ?? [], conditions: decision.conditions ?? [], last_change: decision.last_change ?? null,
          ...supplyBrief } : null,
        // Corevia 공급 확약·SCM 보충: 내부 승인과 나눠 보인다. 다음 조치는 문제 2 판정이 정한 문장
        // 근거 > 공급의 조건 목록과 같은 내용(조건에서 나온 줄)은 두 번 보이지 않는다
        supply_commit: (core.facts?.lines ?? []).filter((l) => !(l.cond && supplyBrief?.summary)).map((l) => ({ kind: l.kind, text: l.text })),
        waiting: core.facts?.waiting ?? [],
        next_actions: open ? decision?.next_actions ?? [] : [], // 끝난 기안에는 기다리는 회신·다음 조치를 보이지 않는다
        approval: approval ? { approver: approval.approver?.name ?? ko(core.c?.approver), rule: approval.reason?.rule_label ?? null, rule_text: approval.reason?.rule_text ?? null,
          outflow: approval.reason?.cash_outflow_date ?? null, in_window: approval.reason?.in_window ?? null, window: approval.reason?.shortfall_window ?? null,
          status: approval.approval_status, latest_reply: approval.latest_reply ?? null, group_report: approval.approver?.group_report_required ?? false } : null,
        // 이 기안이 기대는 보충 발주안의 승인 회신(현금 규칙). 거절이면 왜 공급 조건을 못 채웠는지 담당자에게 보인다
        po: poRepliesFor(planId).map((r) => ({ decision: r.decision, replied_at: r.replied_at, approver: ko(r.approver),
          after_min_balance_krw: r.cash_basis?.after?.min_balance_krw ?? null, floor_krw: r.cash_basis?.floor_krw ?? 0,
          scenario: r.cash_basis?.floor_scenario_id && r.cash_basis.floor_scenario_id !== 'BASE' ? r.cash_basis.floor_scenario_id : null })),
        // L4: 권장 대안과 그 이유(문제 2가 고르면 예상되는 판정으로 매긴 순위)
        recommend: (() => { const a = (decision?.alternatives ?? []).find((x) => x.recommended); return a ? { title: a.title, what_changes: a.what_changes, expected_verdict: a.expected_verdict, reason: a.recommend_reason ?? null } : null; })(),
        // L1: 기안을 철회했을 때 걸려 있던 보충 발주안이 어떻게 됐는지
        po_fate: core.st.plan_status === '철회' ? withdrawPoFate(planId) : [],
        // 현금 영향과 SCM 정기 보충 민감도(참고, L6)
        cash: cashView(approval, core.c),
        deadlines: dl ? [['수요 입력', dl.demand_input_due], ['공급 판정', dl.judgment_due], ['승인 요청', dl.submission_due], ['1차 회신', dl.first_reply_due], ['최종 회신', dl.final_reply_due], ['확정기한', core.st.contract_deadline]]
          .filter(([, v]) => v).map(([label, date]) => ({ label, date, days_left: left(D, date), passed: date < D })) : [],
      },
      entry, decision, approval, lapse_story: lapseStory(planId),
      notices: ['요청액은 표본 스케일이라 현금과 합산하지 않습니다.', '추가 수량은 시뮬레이션 값입니다.'],
    };
  }

  // 철회 뒤 보충 발주안의 처리(조정자 확정 L1, 문제 2 v2.3): 문제 2 사건의 `withdrawal.disposition`이 기준이다.
  // 취소 / 기안만 뗌 / 기안만 뗌(수량 재계산, 다시 승인) / 발주 전달 뒤 남음 / 기안만 뗌(발주 전달 뒤). 금액은 문제 3 약정, SCM 확인 요청은 po_draft_orphaned
  const DISPOSITION_KIND = { 취소: 'cancelled', '기안만 뗌': 'detached', '기안만 뗌(수량 재계산, 다시 승인)': 'requantified', '발주 전달 뒤 남음': 'residual', '기안만 뗌(발주 전달 뒤)': 'shared' };
  function withdrawPoFate(planId) {
    const all = ctx.events.query({ limit: 1e9 });
    const marks = all.filter((e) => ['PO_DRAFT_CREATED', 'PO_DRAFT_CANCELLED'].includes(e.event_type) && e.payload?.withdrawal?.plan_id === planId);
    if (!marks.length) return [];
    const cms = new Map((m('p3')?.listCommitments ? safe(() => m('p3').listCommitments({ commitment_type: '발주안' }), []) : []).map((c) => [c.source_id, c]));
    const eokOf = (id) => { const c = cms.get(id); return c?.amount_krw == null ? '' : `${(Number(c.amount_krw) / 1e8).toFixed(2)}억 원`; };
    const who = (ids) => (ids ?? []).filter((x) => x !== planId).map((x) => x.replace(/^PLAN-/, '기안 ')).join(', ');
    const out = [];
    for (const e of marks) {
      const p = e.payload;
      const id = p.po_draft_id;
      if (out.some((o) => o.po_draft_id === id)) continue;
      const d = p.withdrawal.disposition;
      const dr = p.sku_id ? p : (m('p2')?.poDrafts ? safe(() => m('p2').poDrafts({ po_draft_id: id, latest_only: false }), []) : []).at(-1) ?? {}; // 취소 사건에는 품목·수량이 없을 수 있다
      const what = `${dr.sku_id ? `${dr.sku_id} ` : ''}${dr.order_qty ? `${Number(dr.order_qty).toLocaleString('ko-KR')}개` : ''}`.trim() || id;
      const req = all.find((x) => x.event_type === 'INFO_REQUESTED' && x.payload?.request_topic === 'po_draft_orphaned' && (x.payload?.subject_id ?? x.subject_id) === id);
      const text = {
        취소: `보충 발주(${what})는 발주 전이라 취소했습니다. 약정과 현금 유출${eokOf(id) ? `(${eokOf(id)})` : ''}에서 뺐습니다.`,
        '기안만 뗌': `보충 발주(${what})는 다른 기안(${who(p.linked_plan_ids) || '-'})도 쓰고 있어 그대로 두고 이 기안 몫만 뺐습니다.`,
        '기안만 뗌(수량 재계산, 다시 승인)': `다른 기안과 함께 걸린 보충 발주에서 이 기안 몫을 빼고 수량을 다시 계산했습니다(${what}, 다시 승인 필요).`,
        '발주 전달 뒤 남음': `보충 발주(${what})는 발주가 이미 나가 취소하지 않고 남았습니다(기안 철회 뒤 남은 발주). 현금 유출${eokOf(id) ? ` ${eokOf(id)}` : ''}은 그대로입니다.${req ? ' SCM에 Corevia 취소·수량 조정이 가능한지 물었습니다.' : ''}`,
        '기안만 뗌(발주 전달 뒤)': `보충 발주(${what})는 발주가 이미 나갔고 다른 기안(${who(p.linked_plan_ids) || '-'})도 쓰고 있어 그대로 둡니다. 이 기안 몫만 뺐습니다.`,
      }[d] ?? `보충 발주(${what}): ${d}`;
      out.push({ kind: DISPOSITION_KIND[d] ?? 'detached', disposition: d, po_draft_id: id, request_id: req?.payload?.request_id ?? null, text });
    }
    return out;
  }
  // 공급 근거 요약(화면 다듬기): 결론 한 문장 + 조건을 종류별로 묶은 짧은 목록 + 품목·회차별 상세(접음). 문제 2 condition_basis에서 만든다
  function supplySummary(core, decision, entry) {
    const cb = core.sj?.supply_verdict === '조건부' ? (core.sj.condition_basis ?? []) : [];
    if (!cb.length) return { summary: null, groups: [], details: [] };
    const names = new Map((entry?.reference?.skus ?? []).map((x) => [x.sku_id, x.sku_name]));
    const nm = (k) => names.get(k) ?? '해당 품목';
    const line = core.plan?.product_line ?? '';
    const eaK = (n) => `${Number(n).toLocaleString('ko-KR')}개`;
    const groups = []; const details = [];
    const br = cb.filter((c) => c.condition_type === 'baseline_replenishment_unconfirmed');
    if (br.length) {
      const rows = br.flatMap((c) => c.inbound_rows ?? []);
      const first = rows.map((r) => r.eta_date).sort()[0];
      const unconfirmedScm = br.some((c) => !/미확약/.test(c.reason ?? ''));
      groups.push(`${unconfirmedScm ? 'SCM 확인·Corevia 확약을 기다리는 입고' : 'Corevia 확약을 기다리는 입고'}: ${br.length > 1 ? `${line} ${br.length}개 품목` : nm(br[0].sku_id)}의 정기 보충 ${rows.length}건${first ? `, 가장 빠른 도착 ${md(first)}` : ''}`);
      for (const c of br) details.push(`${nm(c.sku_id)} 정기 보충: ${(c.inbound_rows ?? []).map((r, i) => `${i + 1}회차 ${md(r.eta_date)} ${eaK(r.qty)}`).join(', ')}`);
    }
    const iu = cb.filter((c) => c.condition_type === 'inbound_unconfirmed');
    if (iu.length) {
      groups.push(`확정되지 않은 기존 발주: ${iu.map((c) => `${nm(c.sku_id)} ${(c.inbound_rows ?? [c]).length}건`).join(', ')}`);
      for (const c of iu) details.push(`${nm(c.sku_id)} 기존 발주: ${(c.inbound_rows ?? [c]).map((r) => `${md(r.eta_date)} 도착 예정 ${r.qty ? eaK(r.qty) : ''}`.trim()).join(', ')}`);
    }
    const po = cb.filter((c) => ['reorder_required', 'supply_commitment_pending'].includes(c.condition_type));
    const pend = m('p2')?.pendingSupplyCommitments ? safe(() => m('p2').pendingSupplyCommitments(), []) : [];
    for (const c of po) {
      // 공급 확약 대기 조건은 발주안 번호를 입고 행 출처(POD-)로 갖는다
      const poId = c.po_draft_id ?? (c.inbound_rows ?? []).map((r) => r.source_ref).find((x) => /^POD-/.test(x ?? '')) ?? (/^POD-/.test(c.source_ref ?? '') ? c.source_ref : null);
      const qty = c.po_draft_preview?.order_qty ?? c.qty ?? (c.inbound_rows ?? [])[0]?.qty ?? null;
      const pc = poId ? commitmentOfPo(poId) : null;
      const due = pend.find((x) => x.po_draft_id === poId)?.due_date ?? null;
      const item = `${nm(c.sku_id)}${qty ? ` ${eaK(qty)}` : ''}`;
      if (pc?.approval_status === '취소') groups.push(`취소된 보충 발주: ${item}(${pc.cancel_info?.kind ?? '발주안 취소'})`);
      else if (c.condition_type === 'supply_commitment_pending' || pc?.approval_status === '승인') groups.push(`내부 승인만 난 보충 발주: ${item}${due ? `, 회신 예정 ${md(due)}` : ', Corevia 확약 회신 대기'}`);
      else groups.push(`승인 전 보충 발주: ${item}${c.order_deadline ? `, ${md(c.order_deadline)}까지 승인·발주` : ''}`);
      if (c.needed_by_week) details.push(`${nm(c.sku_id)} 보충 발주: 캠페인 추가분 ${eaK(c.additional_reorder_qty_ea ?? c.uncovered_qty_ea ?? 0)}이 ${md(c.needed_by_week)} 주까지 필요`);
    }
    // 결론: 검토 중이면 '조건이 채워지면 공급 가능', 끝난 기안이면 결정 시점의 상태. 조건이 하나면 한 문장, 여럿이면 종류별 목록
    const status = core.st?.plan_status;
    const sn = JSON.parse(core.st?.decision_snapshot || '{}');
    const head = status === '철회' ? '철회 때 공급은 조건부였습니다'
      : status === '확정' && sn.confirmed_under_risk ? '공급이 확약되지 않은 채 확정했습니다(승인권자 위험 수용)'
        : status === '기한 경과 확정' ? '기한 경과 때 공급은 조건부였습니다' : '조건이 채워지면 공급할 수 있습니다';
    const tail = status === '검토 중' ? '남은 조건' : '남아 있던 조건';
    if (groups.length === 1) return { summary: `${head} — ${groups[0]}.`, groups: [], details };
    return { summary: `${head}. ${tail} ${groups.length}가지:`, groups, details };
  }
  const commitmentOfPo = (poId) => (m('p3')?.commitmentBySource ? safe(() => m('p3').commitmentBySource(poId)) : null);
  // 현금 영향(승인하면 최저 잔액)과 SCM 정기 보충 민감도(참고). 기준선에는 넣지 않는다(문제 3 L6)
  function cashView(approval, c) {
    const ci = approval?.cash_impact ?? null;
    let sens = ci?.scm_sensitivity ?? null;
    if (!sens && c && m('p3')?.scmReplenishmentSensitivity) sens = safe(() => m('p3').scmReplenishmentSensitivity({ commitment_id: c.commitment_id }));
    if (!ci && !sens?.connected) return null;
    const win = (x) => (x?.shortfall_window_start ? `${md(x.shortfall_window_start)}~${md(x.shortfall_window_end)}` : '없음');
    const bal = (x) => (x?.min_balance_krw == null ? '-' : `${(x.min_balance_krw / 1e8).toFixed(2)}억 원(${md(x.min_date)})`);
    const rd = sens?.route_difference ?? (sens?.route_differences ?? []).find((d) => d.commitment_id === c?.commitment_id) ?? null;
    return {
      impact: ci ? `승인하면 현금 최저 잔액 ${bal(ci.before)} → ${bal(ci.after)}, 기준(30억 원) 아래 기간 ${win(ci.before)} → ${win(ci.after)}.` : null,
      sensitivity: sens?.connected ? {
        text: `SCM이 확인한 기준 수요 정기 보충 발주 ${sens.confirmed_row_count}건(재전망 기간 지급 ${sens.in_horizon_row_count}건, ${(Number(sens.in_horizon_amount_krw ?? 0) / 1e8).toFixed(2)}억 원)을 넣으면 최저 잔액 ${bal(sens.baseline)} → ${bal(sens.with_scm_replenishment)}, 기준 아래 기간 ${win(sens.baseline)} → ${win(sens.with_scm_replenishment)}.${rd ? ` ${rd.label ?? '승인권자가 달라질 수 있습니다'}.` : ''}`,
        basis: '금액은 원본 발주 단가(SKU별 발주 금액 ÷ 수량)로 도출한 값이고, 수량·발주일은 SCM 모의 회신입니다. 앞으로의 판매 대금 유입이 재전망 산식에 없어 이 지급만 넣으면 잔액이 낮게 왜곡되므로 기준선에는 넣지 않고 참고로만 보입니다.',
      } : null,
    };
  }
  // L8: 직접 처리 기안 중 지금 사용자의 행동을 기다리는 것(날짜를 넘기기 전 시연 조작에서 알린다)
  function directPending() {
    const D = today();
    return engine.getDirectPlans().map((id) => {
      const core = planCore(id, D);
      if (!core.plan || !core.st || TERMINAL.has(core.st.plan_status)) return null;
      const s = nextStep(core, D);
      return s?.who === 'me' ? { plan_id: id, campaign_name: core.plan.campaign_name, label: s.label, due: s.due ?? null } : null;
    }).filter(Boolean);
  }

  return { home, planView, flow, describeAny, directPending };
}
