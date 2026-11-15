// 첫 화면(사용자 결정 2026-11-15): 왼쪽 = 마케팅 기안 담당자 업무 화면, 오른쪽 = 평가자용 데이터 흐름과 판단.
// 왼쪽에는 코드·영문 식별자·자료 구분 표시를 내지 않는다(꼭 필요한 주의 문구만). 자료 구분은 오른쪽 카드에서 보인다.
import { api, esc, tag, eok, label } from './common.js';

const md = (d) => (d ? `${Number(d.slice(5, 7))}월 ${Number(d.slice(8, 10))}일` : '-');
const planNo = (id) => `기안 ${String(id).replace(/^PLAN-/, '')}`;
const won = (v) => (v == null ? '-' : `${Number(v).toLocaleString('ko-KR')}원`);
const dleft = (n, overdue) => (n == null ? '' : overdue || n < 0 ? '<span class="due over">마감 지남</span>' : n === 0 ? '<span class="due today">오늘 마감</span>' : `<span class="due${n <= 2 ? ' near' : ''}">${n}영업일 남음</span>`);
const SOURCE_TAG = { 원본: '원본도출', 계산: '계산', 가정: '가정', 모의회신: '모의회신', 사람입력: '사람입력', 합성: '가정' };
const ACTOR_CLASS = { 사람: 'a-human', AI: 'a-ai', '규칙·계산': 'a-rule', '모의 입력': 'a-mock' };

// ── 왼쪽 화면용 문구 정리: 다른 모듈이 준 문장에 섞인 코드·영문 식별자를 업무 언어로 바꾼다 ──
const APPROVER_KO = { GRP_CEO: '그룹 CEO', MS_CEO: 'Masil 대표', MKT_TEAM: '마케팅팀' };
const FIELD_KO = { uplift_pct: '증가율', sale_start_week: '판매 시작 주', sale_weeks: '판매 주수', sku_overrides: '품목별 증가율', rationale_text: '근거 메모' };
export function plain(t, names = new Map()) {
  if (t == null) return t;
  return String(t)
    .replace(/\bSCM-BR:SKU-\d{4}:(\d+)/g, 'SCM 보충 $1차')
    .replace(/\bSKU-\d{4}\b/g, (m) => names.get(m) ?? '해당 품목')
    .replace(/\(?\bPOD-\d{4}\)?/g, (m) => (m.startsWith('(') ? '' : '보충 발주안'))
    .replace(/\bIN_TRANSIT:/g, '운송 중 ').replace(/\bSPO-\d{4}\b/g, '기발주분').replace(/\bIS-v(\d+)\b/g, '입고 일정 $1차')
    .replace(/\bCMT-PLAN-(\d{3})\b/g, '기안 $1').replace(/\bPLAN-(\d{3})\b/g, '기안 $1')
    .replace(/\b(GRP_CEO|MS_CEO|MKT_TEAM)\b/g, (m) => APPROVER_KO[m])
    .replace(/\b(uplift_pct|sale_start_week|sale_weeks|sku_overrides|rationale_text)\b/g, (m) => FIELD_KO[m])
    .replace(/(\d[\d,.]*)\s?EA\b/g, '$1개').replace(/\bEA\b/g, '개')
    .replace(/\bSKU 구성/g, '품목 구성').replace(/\bSKU\b/g, '품목')
    .replace(/\bcovenant\b/gi, '재무 약정')
    .replace(/,\s*문제 [1-4](?=\))/g, '').replace(/\(문제 [1-4]\)/g, '').replace(/문제 3 재판정/g, '승인 경로 재판정')
    .replace(/\s*\((?:S|S4)-[A-Z0-9-]+\)/g, '') // 시나리오 코드(예: (S-SUP-REPLY))는 왼쪽에 내지 않는다
    .replace(/(\d{4})-(\d{2})-(\d{2})/g, (_, y, mo, d) => `${Number(mo)}월 ${Number(d)}일`);
}

// ── 오래 걸리는 동작(AI 초안 약 30초, 날짜 진행) 중에는 진행 표시를 띄우고 화면을 잠근다 ──
export async function busy(msg, fn) {
  let el = document.getElementById('busy');
  if (!el) { el = document.createElement('div'); el.id = 'busy'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
  const t0 = Date.now();
  el.innerHTML = `<div class="busy-box"><div class="spinner"></div><div><b>${esc(msg)}</b><div class="muted small">끝날 때까지 다른 버튼은 잠깁니다 · <span id="busy-t">0초</span></div></div></div>`;
  el.className = 'show';
  const h = setInterval(() => { const x = el.querySelector('#busy-t'); if (x) x.textContent = `${Math.round((Date.now() - t0) / 1000)}초`; }, 1000);
  try { return await fn(); } finally { clearInterval(h); el.className = ''; }
}

// ── 확인 창(브라우저 대화상자 대신 화면 안에서) ──
export function modal({ title, body, okLabel = '확인', danger = false, needText = null, extra = null }) {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'modal-back';
    el.innerHTML = `<div class="modal" role="dialog" aria-modal="true"><h3>${esc(title)}</h3><div class="modal-body">${body}</div>
      ${needText ? `<textarea id="m-text" rows="3" placeholder="${esc(needText)}"></textarea>` : ''}
      <div class="row end"><button id="m-cancel">취소</button>${extra ? `<button id="m-extra" class="btn-secondary">${esc(extra.label)}</button>` : ''}<button id="m-ok" class="${danger ? 'btn-danger' : 'btn-primary'}">${esc(okLabel)}</button></div></div>`;
    document.body.appendChild(el);
    const close = (v) => { el.remove(); resolve(v); };
    el.querySelector('#m-cancel').onclick = () => close(null);
    if (extra) el.querySelector('#m-extra').onclick = () => close(extra.value);
    el.querySelector('#m-ok').onclick = () => {
      const text = needText ? el.querySelector('#m-text').value.trim() : true;
      if (needText && !text) { el.querySelector('#m-text').focus(); return; }
      close(text);
    };
  });
}

// L8: 직접 처리 기안이 사용자의 행동을 기다리는데 날짜를 넘기려 하면 먼저 알린다.
// 돌려주는 값: 'go'(그대로 진행) / 'auto'(모두 자동 처리로 바꾼 뒤 진행) / null(취소)
export async function guardDirect() {
  const sc = await api.get('/api/p4/direct');
  const pend = sc.pending ?? [];
  if (!pend.length) return 'go';
  const choice = await modal({
    title: `직접 처리 기안 ${pend.length}건이 사용자의 행동을 기다리고 있습니다`,
    body: `<ul>${pend.map((x) => `<li><b>${esc(x.campaign_name)}</b>(${esc(planNo(x.plan_id))}) — ${esc(x.label)}${x.due ? ` · ${md(x.due)}까지` : ''}</li>`).join('')}</ul>
      <p class="muted small">직접 처리 기안에는 자동 모의 입력이 들어가지 않습니다. 처리하지 않고 날짜를 넘기면 마감을 놓치고, 확정기한이 지나면 기한 경과 확정(담당자 입력 없음)으로 끝납니다.</p>`,
    okLabel: '모두 자동 처리로 바꾸고 진행', extra: { label: '그대로 진행', value: 'go' },
  });
  if (choice === true) { await api.post('/api/p4/direct/all-auto', {}); return 'auto'; }
  return choice;
}

// ════════════════ 왼쪽: 기안 담당자 ════════════════
async function renderHome(el) {
  const h = await api.get('/api/p4/user/home');
  for (const x of [...h.todo, ...h.waiting]) for (const k of ['label', 'text', 'waiting_on', 'sentence']) x[k] = plain(x[k]);
  for (const a of h.alerts) a.text = plain(a.text);
  const row = (x, kind) => `<a class="task ${x.overdue ? 'overdue' : ''}" href="#/w/${esc(x.plan_id)}">
      <div class="task-main"><div class="task-title">${esc(x.campaign_name)} <span class="muted small">${esc(planNo(x.plan_id))} · ${esc(x.product_line)}</span></div>
        <div class="task-sub">${kind === 'todo' ? `<b>${esc(x.label)}</b> — ${esc(x.text ?? '')}` : kind === 'wait' ? `${esc(x.waiting_on ?? '')}의 <b>${esc(x.label)}</b>${x.due ? ` · ${md(x.due)}까지` : ''}` : ''}</div></div>
      <div class="task-side">${kind === 'todo' ? `${x.due ? `<div>${md(x.due)}</div>` : ''}${dleft(x.days_left, x.overdue)}` : kind === 'wait' ? (x.auto ? '<span class="chip-soft">자동 처리</span>' : '') : ''}</div></a>`;
  el.innerHTML = `
    <div class="l-head"><h1>내 기안</h1><div class="muted">오늘 ${md(h.sim_clock)} 기준</div></div>
    ${h.alerts.length ? `<div class="alert"><b>기한 경고 ${h.alerts.length}건</b><ul>${h.alerts.map((a) => `<li><a href="#/w/${esc(a.plan_id)}">${esc(a.campaign_name)}</a>: ${esc(a.text)}${a.due_date ? ` (${md(a.due_date)})` : ''}</li>`).join('')}</ul></div>` : ''}
    ${(h.direct ?? []).length ? `<section class="l-sec direct-sec"><h2>내가 직접 처리하는 기안 <span class="count">${h.direct.length}</span></h2>
      <p class="muted small">이 기안들은 자동 모의 입력이 들어가지 않습니다. 수요 입력·승인 요청·대안 선택·확정을 하지 않으면 진행되지 않고, 확정기한이 지나면 기한 경과 확정으로 끝납니다.</p>
      <ul class="direct-list">${h.direct.map((x) => `<li class="${x.mine ? 'mine' : ''}"><a href="#/w/${esc(x.plan_id)}">${esc(x.campaign_name)}</a> <span class="muted small">${esc(planNo(x.plan_id))}</span> — ${esc(plain(x.state))}${x.due ? ` · ${md(x.due)}까지` : ''}</li>`).join('')}</ul></section>` : ''}
    <section class="l-sec"><h2>지금 내가 할 일 <span class="count">${h.todo.length}</span></h2>
      ${h.todo.length ? h.todo.map((x) => row(x, 'todo')).join('') : '<p class="empty">지금 처리할 일이 없습니다.</p>'}</section>
    <section class="l-sec"><h2>다른 부서를 기다리는 중 <span class="count">${h.waiting.length}</span></h2>
      ${h.waiting.length ? h.waiting.map((x) => row(x, 'wait')).join('') : '<p class="empty">기다리는 일이 없습니다.</p>'}</section>
    <section class="l-sec"><h2>끝난 기안 <span class="count">${h.done.length}</span></h2>
      ${h.done.length ? `<div class="done-list">${h.done.map((x) => `<a href="#/w/${esc(x.plan_id)}" class="done-item"><span>${esc(x.campaign_name)}</span><span class="st st-${esc(x.status)}">${esc(x.status)}</span><span class="muted small">${md(x.decided_at)}</span></a>`).join('')}</div>` : '<p class="empty">아직 없습니다.</p>'}</section>
    <p class="muted small">${esc(h.notice)}</p>`;
}

function stepsHtml(steps) {
  return `<ol class="wsteps">${steps.map((s) => `<li class="ws ws-${esc(s.state)}"><div class="ws-name">${esc(s.name)}</div><div class="ws-text">${esc(s.text)}</div></li>`).join('')}</ol>`;
}

async function renderPlan(el, planId, ctx) {
  const v = await api.get(`/api/p4/user/plans/${encodeURIComponent(planId)}`);
  const names = new Map((v.entry?.reference?.skus ?? []).map((x) => [x.sku_id, x.sku_name]));
  const P = (t) => plain(t, names);
  v.sentence = P(v.sentence);
  v.steps.forEach((x) => { x.text = P(x.text); });
  v.actions.forEach((x) => { x.blocked_reason = P(x.blocked_reason); });
  const w = v.why;
  if (w.supply) { w.supply.summary = P(w.supply.summary); w.supply.groups = (w.supply.groups ?? []).map(P); w.supply.details = (w.supply.details ?? []).map(P); w.supply.headline = P(w.supply.headline); w.supply.reasons = w.supply.reasons.map(P); w.supply.conditions.forEach((c) => { c.text = P(c.text); }); w.supply.last_change = P(w.supply.last_change); }
  if (w.approval) { w.approval.rule = P(w.approval.rule); w.approval.rule_text = P(w.approval.rule_text); if (w.approval.latest_reply) w.approval.latest_reply.reason = P(w.approval.latest_reply.reason); }
  (v.lapse_story?.steps ?? []).forEach((x) => { x.text = P(x.text); });
  (w.supply_commit ?? []).forEach((x) => { x.text = P(x.text); });
  w.next_actions = (w.next_actions ?? []).map(P);
  if (w.recommend) { w.recommend.title = P(w.recommend.title); w.recommend.reason = P(w.recommend.reason); w.recommend.what_changes = P(w.recommend.what_changes); }
  (w.po_fate ?? []).forEach((x) => { x.text = P(x.text); });
  if (w.cash) { w.cash.impact = P(w.cash.impact); if (w.cash.sensitivity) w.cash.sensitivity.text = P(w.cash.sensitivity.text); }
  if (v.decision) { v.decision.headline = P(v.decision.headline); for (const a of v.decision.alternatives ?? []) for (const k of ['title', 'what_changes', 'expected_verdict', 'expected_note', 'why_not', 'remaining_checks', 'recommend_reason']) a[k] = P(a[k]); }
  if (v.approval) { if (v.approval.reason) { v.approval.reason.rule_label = P(v.approval.reason.rule_label); v.approval.reason.rule_text = P(v.approval.reason.rule_text); } v.approval.submit_blockers = (v.approval.submit_blockers ?? []).map(P); }
  if (v.entry?.reference) v.entry.reference.notice = P(v.entry.reference.notice);
  if (v.entry?.pending) { v.entry.pending.missing_fields = (v.entry.pending.missing_fields ?? []).map(P); v.entry.pending.unclear_reasons = (v.entry.pending.unclear_reasons ?? []).map(P); }
  const p = v.plan;
  const btn = (a) => `<button class="${a.primary ? 'btn-primary big' : a.kind === 'withdraw' ? 'btn-ghost-danger' : 'btn-secondary big'}" data-act="${a.kind}" ${a.enabled ? '' : 'disabled'}
      title="${esc(a.blocked_reason ?? '')}">${esc(a.label)}</button>`;
  const why = v.why;
  const lapse = v.lapse_story;
  el.innerHTML = `
    <p><a href="#/">← 내 기안</a></p>
    <div class="l-head"><h1>${esc(p.campaign_name)}</h1><div class="muted">${esc(planNo(p.plan_id))} · ${esc(p.product_line)} · 집행 예정 ${md(p.settlement_date)} · 확정기한 ${md(p.contract_deadline)}${v.direct ? '' : ' · <span class="chip-soft">자동 처리 중(모의)</span>'}</div></div>
    <div class="status-line">${esc(v.sentence)}</div>
    ${stepsHtml(v.steps)}
    <div class="actions">${v.actions.filter((a) => a.kind !== 'withdraw').map(btn).join('')}${btn(v.actions.find((a) => a.kind === 'withdraw'))}</div>
    ${!v.direct && v.plan_status === '검토 중' ? '<p class="muted small">이 기안은 자동 처리(모의 입력) 중입니다. 직접 처리하려면 오른쪽 시연 조작에서 켜세요. 직접 하셔도 됩니다.</p>' : ''}
    ${lapse ? `<div class="why-box warn-box"><b>왜 기한 경과 확정이 됐나요?</b><ol class="lapse-list">${lapse.steps.map((s) => `<li><b>${esc(s.step)}</b> ${md(s.date)} — ${esc(s.text)}</li>`).join('')}</ol></div>` : ''}
    <section class="l-sec"><h2>근거</h2>
      ${why.supply ? `<div class="why"><div class="why-k">공급</div><div>${why.supply.summary
        ? `${esc(why.supply.summary)}${(why.supply.groups ?? []).length ? `<ul class="commit-list">${why.supply.groups.map((g) => `<li>${esc(g)}</li>`).join('')}</ul>` : ''}
          ${(why.supply.details ?? []).length ? `<details class="fold"><summary class="small">품목·회차별 상세</summary><ul class="commit-list small">${why.supply.details.map((d) => `<li>${esc(d)}</li>`).join('')}</ul></details>` : ''}`
        : `${esc(why.supply.headline)}${why.supply.conditions.length ? `<div class="muted small">조건: ${esc(why.supply.conditions.map((c) => c.text).join(' / '))}</div>` : ''}`}</div></div>` : ''}
      ${why.approval ? `<div class="why"><div class="why-k">승인</div><div>${esc(why.approval.approver)}의 승인이 필요합니다. ${esc(why.approval.rule ?? '')}${why.approval.outflow ? ` — 집행일 ${md(why.approval.outflow)}이 현금이 기준 아래로 내려가는 기간 ${why.approval.in_window ? '안' : '밖'}입니다.` : ''}${why.approval.group_report ? ' 그룹에도 보고합니다.' : ''}
        ${why.approval.latest_reply ? `<div class="muted small">최근 회신: ${esc(why.approval.latest_reply.decision)}(${md(why.approval.latest_reply.replied_at)})${why.approval.latest_reply.reason ? ` · ${esc(why.approval.latest_reply.reason)}` : ''}</div>` : ''}</div></div>` : ''}
      ${(why.supply_commit ?? []).length ? `<div class="why"><div class="why-k">공급 확약</div><div><ul class="commit-list">${why.supply_commit.slice(0, 5).map((l) => `<li class="ck-${esc(l.kind)}">${esc(l.text)}</li>`).join('')}</ul>
        ${why.supply_commit.length > 5 ? `<details class="fold"><summary class="small">나머지 ${why.supply_commit.length - 5}줄 보기</summary><ul class="commit-list">${why.supply_commit.slice(5).map((l) => `<li class="ck-${esc(l.kind)}">${esc(l.text)}</li>`).join('')}</ul></details>` : ''}
        <div class="muted small">내부 승인은 구매·지출을 허용할 뿐 공급 확약이 아닙니다. 확약은 Corevia·SCM 회신으로만 정해집니다.</div>
        ${(why.next_actions ?? []).length ? `<div class="small"><b>다음 조치</b> ${why.next_actions.map((x) => esc(x)).join(' ')}</div>` : ''}</div></div>` : ''}
      ${(why.po ?? []).length ? `<div class="why"><div class="why-k">보충 발주</div><div>${why.po.map((r) => r.decision === '거절'
        ? `${md(r.replied_at)} ${esc(r.approver)}가 보충 발주안을 거절했습니다. 승인하면 현금 최저 잔액이 ${eok(r.after_min_balance_krw)}로 기준 ${eok(r.floor_krw)}보다 낮아지기 때문입니다${r.scenario ? '(그룹 CEO 조건, 가정 시나리오)' : ''}. 공급 조건을 채우지 못해 대안을 고르거나 접어야 합니다.`
        : `${md(r.replied_at)} ${esc(r.approver)}가 보충 발주안을 내부 승인했습니다(구매·지출 허용, 공급 확약은 아님).`).join('<br>')}</div></div>` : ''}
      ${why.recommend && v.plan_status === '검토 중' ? `<div class="why"><div class="why-k">권장 대안</div><div><b>${esc(why.recommend.title)}</b>${why.recommend.what_changes ? ` — ${esc(why.recommend.what_changes)}` : ''}${why.recommend.reason ? `<div class="muted small">이유: ${esc(why.recommend.reason)}</div>` : ''}</div></div>` : ''}
      ${(why.po_fate ?? []).length ? `<div class="why"><div class="why-k">철회 뒤 보충 발주</div><div><ul class="commit-list">${why.po_fate.map((x) => `<li class="ck-${x.kind === 'cancelled' ? 'ok' : x.kind === 'residual' ? 'bad' : 'wait'}">${esc(x.text)}</li>`).join('')}</ul></div></div>` : ''}
      ${why.cash ? `<div class="why"><div class="why-k">현금 영향</div><div>${why.cash.impact ? esc(why.cash.impact) : ''}
        ${why.cash.sensitivity ? `<div class="small sens"><span class="chip-soft">참고</span> ${esc(why.cash.sensitivity.text)}<div class="muted small">${esc(why.cash.sensitivity.basis)}</div></div>` : ''}</div></div>` : ''}
      <div class="why"><div class="why-k">마감</div><div>${why.deadlines.map((d) => `${esc(d.label)} ${md(d.date)}${d.passed ? '(지남)' : ''}`).join(' · ')}</div></div>
      <details class="fold"><summary>숫자와 상세 보기</summary>
        ${why.supply ? `<p><b>공급 판정 근거</b></p><ul>${why.supply.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>${why.supply.last_change ? `<p class="muted small">마지막 변경: ${esc(why.supply.last_change)}</p>` : ''}` : ''}
        ${why.approval?.rule_text ? `<p><b>승인권자 규칙</b></p><p class="small">${esc(why.approval.rule_text)}</p>` : ''}
        ${v.entry?.current ? `<p><b>등록된 수요</b> 증가율 ${esc(v.entry.current.uplift_pct)}% · ${md(v.entry.current.sale_start_week)} 주부터 ${esc(v.entry.current.sale_weeks)}주 · 추가 ${Number(v.entry.current.total_added_qty_ea ?? 0).toLocaleString('ko-KR')}개</p>
          <table class="ltable"><tr><th>품목</th><th>주당 추가</th><th>합계</th></tr>${(v.entry.current.added_qty_by_sku ?? []).map((x) => `<tr><td>${esc(x.sku_name)}</td><td>${Number(x.added_qty_ea_per_week).toLocaleString('ko-KR')}개</td><td>${Number(x.total_added_qty_ea).toLocaleString('ko-KR')}개</td></tr>`).join('')}</table>` : ''}
        <p class="muted small">요청액 ${won(p.requested_budget_krw)}(표본 스케일). ${esc(v.notices.join(' '))}</p>
      </details></section>
    <div id="l-panel"></div>`;
  el.querySelectorAll('[data-act]').forEach((b) => { b.onclick = () => openAction(b.dataset.act, v, el, ctx); });
  const want = ctx.sub;
  if (want) openAction(want, v, el, ctx);
}

async function openAction(kind, v, el, ctx) {
  const panel = el.querySelector('#l-panel');
  const id = v.plan.plan_id;
  const done = async (msg) => { ctx.toast(msg); await ctx.refresh(); };
  if (kind === 'confirm') {
    const ok = await modal({ title: '이 기안을 확정할까요?', body: `<p>${esc(v.plan.campaign_name)}을(를) 확정합니다. 확정하면 되돌릴 수 없습니다.</p><p class="muted">${esc(v.sentence)}</p>`, okLabel: '확정' });
    if (!ok) return;
    try { await busy('확정하는 중입니다…', () => api.post(`/api/p4/plans/${id}/confirm`)); await done('확정했습니다.'); } catch (err) { ctx.toast(`확정할 수 없습니다: ${err.message}`, true); }
    return;
  }
  if (kind === 'withdraw') {
    const reason = await modal({ title: '이 기안을 철회할까요?', body: `<p>${esc(v.plan.campaign_name)}을(를) 접습니다. 철회하면 되돌릴 수 없습니다.</p>`, okLabel: '철회', danger: true, needText: '철회 사유(필수)' });
    if (!reason) return;
    try { await busy('철회하는 중입니다…', () => api.post(`/api/p4/plans/${id}/withdraw`, { reason })); await done('철회했습니다.'); } catch (err) { ctx.toast(`철회할 수 없습니다: ${err.message}`, true); }
    return;
  }
  if (kind === 'demand') return demandPanel(panel, v, ctx);
  if (kind === 'alternatives') return alternativesPanel(panel, v, ctx);
  if (kind === 'approval') return approvalPanel(panel, v, ctx);
}

// 수요 입력 참고 표의 한 줄(문제 1 v2: headroom_committed = Corevia 확약 입고만으로 본 여지, baseline_plan = SCM 기준 수요 보충 계획)
export function demandRefRow(s) {
  const h = s.headroom_committed;
  const room = !h ? '-' : h.headroom_state === 'none' ? '제한 없음(보충 발주로 맞출 수 있음)' : `${Number(h.min_residual_headroom_qty ?? 0).toLocaleString('ko-KR')}개`;
  const bp = s.baseline_plan;
  const plan = !bp ? '-' : `${bp.status}${bp.plan_qty_total ? ` · ${Number(bp.plan_qty_total).toLocaleString('ko-KR')}개` : ''}`;
  return `<tr><td>${esc(s.sku_name)}</td><td>${esc(room)}</td><td>${s.first_stockout_week ? md(s.first_stockout_week) : '없음'}</td><td>${esc(plan)}</td></tr>`;
}

// (3) 수요 입력: 자유 서술 → AI 정리 → 확인·수정 → 등록. 값 직접 입력도 된다.
function demandPanel(panel, v, ctx) {
  const e = v.entry;
  if (!e) { panel.innerHTML = '<div class="panel"><p>수요 입력 화면에 연결되지 않았습니다.</p></div>'; return; }
  const cur = e.current;
  const pend = e.pending;
  const f = pend?.extracted_fields ?? {};
  const val = (k) => f[k] ?? cur?.[k] ?? '';
  const ovList = pend ? (f.sku_overrides ?? []) : (cur?.overrides ?? []);
  const ovOf = (sku) => ovList.find((o) => o.sku_id === sku)?.override_uplift_pct ?? '';
  const ref = (e.reference?.skus ?? []).map((s) => demandRefRow(s)).join('');
  panel.innerHTML = `<div class="panel" id="demand"><h2>${cur ? '수요 정정' : '수요 입력'}</h2>
    <p class="muted">입력 마감 ${md(e.deadline?.demand_input_due)} · 확정기한 ${md(e.deadline?.contract_deadline)}</p>
    <details class="fold" open><summary>입력 전에 참고: 받을 수 있는 여지와 품절 예상</summary>
      <table class="ltable"><tr><th>품목</th><th>더 받을 수 있는 수량(확약 입고 기준, 최소)</th><th>품절 예상 주</th><th>기존 판매분 보충 계획(SCM)</th></tr>${ref}</table>
      <p class="muted small">${esc(e.reference?.notice ?? '')}</p></details>
    <h3>1. 자유롭게 적기</h3>
    <textarea id="d-text" rows="3" placeholder="예: 8월 셋째 주부터 3주 동안 평소보다 25% 정도 더 팔릴 것 같습니다."></textarea>
    <div class="row"><button id="d-ai" class="btn-secondary">${e.ai_status === '연결' ? 'AI로 정리하기' : '보내기(AI 미연결: 아래에서 값 확인)'}</button></div>
    ${pend ? `<div class="ai-box"><b>${pend.ai_status === '구조화됨' || pend.extracted_fields ? 'AI가 정리한 값' : '정리 대기'}</b> <span class="muted small">원문: “${esc(pend.reply_text ?? '')}”</span>
      ${(pend.missing_fields ?? []).length ? `<div class="warn small">비어 있는 값: ${esc(pend.missing_fields.join(', '))}${(pend.unclear_reasons ?? []).length ? ` — ${esc(pend.unclear_reasons.join(' / '))}` : ''}</div>` : ''}</div>` : ''}
    <h3>2. 값 확인${pend ? '·수정 후 등록' : '(직접 입력)'}</h3>
    <div class="form-grid">
      <label>증가율(%)<input id="d-up" type="number" step="0.1" min="0" value="${esc(val('uplift_pct'))}"></label>
      <label>판매 시작 주(월요일)<input id="d-start" type="date" value="${esc(val('sale_start_week'))}"></label>
      <label>판매 주수<input id="d-weeks" type="number" min="1" step="1" value="${esc(val('sale_weeks'))}"></label>
    </div>
    <div class="ov"><span class="muted small">품목별 증가율(다르게 볼 품목만, 비우면 공통 값)</span>
      ${(e.reference?.skus ?? []).map((sk) => `<label>${esc(sk.sku_name)}<input type="number" step="0.1" min="0" data-ov="${esc(sk.sku_id)}" value="${esc(ovOf(sk.sku_id))}" placeholder="공통"></label>`).join('')}</div>
    <label class="full">근거 메모<input id="d-note" value="${esc(f.rationale_text ?? '')}" placeholder="이 값을 정한 이유(선택)"></label>
    <div class="row"><button id="d-preview" class="btn-ghost">추가 수량 미리보기</button><span id="d-prev-out" class="muted small"></span></div>
    <div class="row end">${pend ? '<button id="d-reject" class="btn-ghost">다시 쓰기</button>' : ''}<button id="d-save" class="btn-primary">${pend ? '확인하고 등록' : '등록'}</button></div>
    <p class="muted small">추가 수량은 증가율이 판매 기간 내 매주 같다고 본 시뮬레이션 값입니다.</p></div>`;
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const fields = () => ({ uplift_pct: Number(panel.querySelector('#d-up').value), sale_start_week: panel.querySelector('#d-start').value,
    sale_weeks: Number(panel.querySelector('#d-weeks').value), rationale_text: panel.querySelector('#d-note').value || undefined,
    overrides: [...panel.querySelectorAll('[data-ov]')].filter((x) => x.value !== '').map((x) => ({ sku_id: x.dataset.ov, override_uplift_pct: Number(x.value) })) });
  const id = v.plan.plan_id;
  panel.querySelector('#d-ai').onclick = async () => {
    const text = panel.querySelector('#d-text').value.trim();
    if (!text) { panel.querySelector('#d-text').focus(); return; }
    try { await busy(e.ai_status === '연결' ? 'AI가 입력을 정리하는 중입니다(최대 30초)…' : '보내는 중입니다…', () => api.post(`/api/p1/entry/${id}/text`, { reply_text: text })); await ctx.refresh({ sub: 'demand' }); ctx.toast('정리된 값을 확인하세요.'); } catch (err) { ctx.toast(err.message, true); }
  };
  panel.querySelector('#d-preview').onclick = async () => {
    const x = fields();
    try {
      const r = await api.post('/api/p1/preview', { plan_id: id, sale_start_week: x.sale_start_week, sale_weeks: x.sale_weeks, uplift_pct: x.uplift_pct, override_uplift_pct: x.overrides });
      const tot = (r.rows ?? []).reduce((a, y) => a + (y.added_qty_ea ?? 0), 0);
      panel.querySelector('#d-prev-out').textContent = `추가 수량 합계 ${tot.toLocaleString('ko-KR')}개(${new Set((r.rows ?? []).map((y) => y.sku_id)).size}개 품목)`;
    } catch (err) { panel.querySelector('#d-prev-out').textContent = `확인 필요: ${err.message}`; }
  };
  if (pend) panel.querySelector('#d-reject').onclick = async () => {
    try { await api.post(`/api/p1/entry/${id}/confirm`, { version: pend.version, decision: '거부', fields: {} }); await ctx.refresh({ sub: 'demand' }); } catch (err) { ctx.toast(err.message, true); }
  };
  panel.querySelector('#d-save').onclick = async () => {
    const x = fields();
    if (!x.sale_start_week || !x.sale_weeks || Number.isNaN(x.uplift_pct)) { ctx.toast('증가율·시작 주·주수를 모두 넣어 주세요.', true); return; }
    try {
      const r = await busy('수요를 등록하고 공급을 확인하는 중입니다…', () => (pend ? api.post(`/api/p1/entry/${id}/confirm`, { version: pend.version, decision: '확인', fields: x })
        : api.post(`/api/p1/entry/${id}/direct`, { fields: x })));
      const res = r.result ?? {};
      if (res.ok === false || res.rejected || res.decision === '거부') { ctx.toast(`등록되지 않았습니다: ${res.reason ?? res.reject_reason ?? '값을 확인하세요'}`, true); await ctx.refresh({ sub: 'demand' }); return; }
      ctx.toast('수요를 등록했습니다. 공급 확인이 이어집니다.'); await ctx.refresh();
    } catch (err) { ctx.toast(`등록할 수 없습니다: ${err.message}`, true); }
  };
}

// (4) 대안 비교
function alternativesPanel(panel, v, ctx) {
  const d = v.decision;
  const alts = d?.alternatives ?? [];
  panel.innerHTML = `<div class="panel" id="alts"><h2>대안 비교</h2><p>${esc(d?.headline ?? '')}</p>
    <div class="alt-grid">${alts.map((a) => `<div class="alt ${a.recommended ? 'rec' : ''} ${a.feasible ? '' : 'off'}">
      ${a.recommended ? '<div class="badge-rec">권장</div>' : ''}<h3>${esc(a.title)}</h3>
      ${a.recommended && a.recommend_reason ? `<div class="muted small">권장 이유: ${esc(a.recommend_reason)}</div>` : ''}
      <div><span class="muted small">바뀌는 것</span><div>${esc(a.what_changes ?? '-')}</div></div>
      <div><span class="muted small">고르면 예상</span><div><b>${esc(a.expected_verdict ?? '회신 전에는 알 수 없음')}</b>${a.expected_note ? ` — ${esc(a.expected_note)}` : ''}</div></div>
      ${a.remaining_checks ? `<div class="muted small">남은 확인: ${esc(a.remaining_checks)}</div>` : ''}
      ${a.feasible ? (a.selected ? '<div class="chip-soft">선택함</div>' : `<button class="btn-primary" data-alt="${esc(a.alternative_id)}">이 대안 선택</button>`) : `<div class="muted small">고를 수 없음: ${esc(a.why_not ?? '')}</div>`}
    </div>`).join('') || '<p>지금 고를 수 있는 대안이 없습니다.</p>'}</div></div>`;
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  panel.querySelectorAll('[data-alt]').forEach((b) => { b.onclick = async () => {
    const a = alts.find((x) => x.alternative_id === b.dataset.alt);
    const ok = await modal({ title: `“${a.title}”를 고를까요?`, body: `<p>바뀌는 것: ${esc(a.what_changes ?? '-')}</p><p>예상: ${esc(a.expected_verdict ?? '-')} ${esc(a.expected_note ?? '')}</p>`, okLabel: '선택' });
    if (!ok) return;
    // 화면에서 사람이 고른 것이므로 모의 입력이 아니다(is_mock: false)
    try { await busy('대안을 반영해 다시 판정하는 중입니다…', () => api.post(a.select.path, { ...(a.select.body ?? {}), is_mock: false, actor_dept: 'MKT' })); ctx.toast('대안을 골랐습니다.'); await ctx.refresh(); } catch (err) { ctx.toast(err.message, true); }
  }; });
}

// (5) 승인 요청: 승인권자와 이유, 초안 보고 고쳐서 올린다
function approvalPanel(panel, v, ctx) {
  const a = v.approval;
  if (!a) { panel.innerHTML = '<div class="panel"><p>승인 경로에 연결되지 않았습니다.</p></div>'; return; }
  const dr = a.draft;
  panel.innerHTML = `<div class="panel" id="appr"><h2>승인 요청</h2>
    <p><b>${esc(a.approver?.name ?? '-')}</b>에게 올립니다. ${esc(a.reason?.rule_label ?? '')}${a.approver?.group_report_required ? ' · 그룹 보고 대상' : ''}</p>
    <p class="muted small">${esc(a.reason?.rule_text ?? '')}</p>
    <p class="muted">승인 요청 마감 ${md(a.deadlines?.submission_due)} · 최종 회신 마감 ${md(a.deadlines?.final_reply_due)} · 결재 소요 ${a.approver?.std_approval_bd ?? '-'}영업일</p>
    ${(a.submit_group ?? []).length > 1 ? `<p class="muted small">같은 승인권자·같은 마감의 기안 ${a.submit_group.length}건이 함께 올라갑니다.</p>` : ''}
    ${a.can_submit ? '' : `<p class="warn">지금은 올릴 수 없습니다: ${esc((a.submit_blockers ?? []).join(', '))}</p>`}
    <h3>요청 문서</h3>
    ${dr ? `<p class="muted small">${dr.mode === 'AI' ? `AI가 쓴 초안입니다(${esc(dr.review_status ?? '')}). 고쳐서 확인하세요.` : '양식으로 쓴 초안입니다. 필요하면 고치세요.'}</p>
      <textarea id="a-text" rows="9">${esc(dr.text ?? '')}</textarea>
      <div class="row end"><button id="a-ok" class="btn-secondary">${dr.mode === 'AI' ? '이대로 확인' : '이대로 사용'}</button><button id="a-edit" class="btn-secondary">고친 내용으로 확인</button>
        <button id="a-submit" class="btn-primary" ${a.can_submit ? '' : 'disabled'}>승인 요청 올리기</button></div>`
      : `<div class="row"><button id="a-draft" class="btn-secondary">초안 만들기</button></div>`}</div>`;
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const id = v.plan.plan_id;
  const again = async () => ctx.refresh({ sub: 'approval' });
  panel.querySelector('#a-draft')?.addEventListener('click', async () => {
    try { await busy('AI가 승인 요청 초안을 쓰는 중입니다(약 30초)…', () => api.post('/api/p3/draft', { commitment_id: a.commitment_id })); await again(); } catch (err) { ctx.toast(err.message, true); }
  });
  const review = async (result) => {
    try { await busy('초안을 확인하는 중입니다…', () => api.post(`/api/p3/draft/${dr.draft_id}/review`, { review_result: result, text: panel.querySelector('#a-text').value })); ctx.toast('초안을 확인했습니다.'); await again(); } catch (err) { ctx.toast(err.message, true); }
  };
  panel.querySelector('#a-ok')?.addEventListener('click', () => review('확인'));
  panel.querySelector('#a-edit')?.addEventListener('click', () => review('수정 후 확인'));
  panel.querySelector('#a-submit')?.addEventListener('click', async () => {
    const ok = await modal({ title: '승인 요청을 올릴까요?', body: `<p>${esc(a.approver?.name ?? '')}에게 올립니다. 회신은 ${a.approver?.std_approval_bd ?? '-'}영업일 뒤 예정입니다.</p>`, okLabel: '올리기' });
    if (!ok) return;
    try { await busy('승인 요청을 올리는 중입니다…', () => api.post(`/api/p3/plan/${id}/approval/submit`, { draft_id: dr?.draft_id })); ctx.toast('승인 요청을 올렸습니다.'); await ctx.refresh(); } catch (err) { ctx.toast(`올릴 수 없습니다: ${err.message}`, true); }
  });
}

// ════════════════ 오른쪽: 데이터 흐름과 판단 ════════════════
const FLOW_BOXES = [['p1', '수요 입력', '문제 1'], ['p2', '공급 판정', '문제 2'], ['p3', '승인 경로', '문제 3'], ['p4', '마감·재검토·확정', '문제 4']];
function flowDiagram(group) {
  const mods = new Set(group?.modules ?? []);
  const src = new Set(group?.sources ?? []);
  const orig = src.has('원본');
  const syn = ['가정', '모의회신', '합성', '사람입력'].some((x) => src.has(x));
  return `<div class="fd"><div class="fd-src"><span class="fd-data ${orig ? 'on' : ''}">원본 자료</span><span class="fd-data ${syn ? 'on' : ''}">합성·모의 자료</span><span class="fd-data ${src.has('계산') ? 'on' : ''}">계산값</span></div>
    <div class="fd-row">${FLOW_BOXES.map(([id, name, sub]) => `<div class="fd-box ${mods.has(id) ? 'on' : ''}"><b>${name}</b><span>${sub}</span></div>`).join('<span class="fd-arrow">→</span>')}</div></div>`;
}
const SHOW_INPUTS = 4; // '사용한 데이터'는 앞의 4줄만 보이고 나머지는 접는다
const inputLi = (i) => `<li>${esc(i.label)}: <b>${esc(i.value)}</b> ${tag(SOURCE_TAG[i.source] ?? i.source)}${i.ref ? ` <span class="muted small">${esc(i.ref)}</span>` : ''}</li>`;
function cardHtml(c) {
  const ev = c.event;
  return `<div class="fcard"><div class="fc-head"><span class="actor ${ACTOR_CLASS[c.actor_kind] ?? ''}">${esc(c.actor_kind)}</span><span class="muted small">${esc(c.actor_label ?? '')} · ${esc(ev.module)} · ${md(ev.occurred_at)}</span>
      ${tag(SOURCE_TAG[ev.source_type] ?? ev.source_type, ev.is_synthetic, ev.is_simulation)}${ev.scenario_id && ev.scenario_id !== 'BASE' ? `<span class="chip-soft">${esc(ev.scenario_id)}</span>` : ''}</div>
    <div class="fc-title">${esc(c.title)}</div>
    ${(c.inputs ?? []).length ? `<div class="fc-k">사용한 데이터</div><ul class="fc-in">${c.inputs.slice(0, SHOW_INPUTS).map(inputLi).join('')}</ul>
      ${c.inputs.length > SHOW_INPUTS ? `<details class="fc-more"><summary>나머지 ${c.inputs.length - SHOW_INPUTS}개 보기</summary><ul class="fc-in">${c.inputs.slice(SHOW_INPUTS).map(inputLi).join('')}</ul></details>` : ''}` : ''}
    ${c.rule ? `<div class="fc-k">규칙</div><div class="fc-v">${esc(c.rule)}</div>` : ''}
    ${c.result ? `<div class="fc-k">결과</div><div class="fc-v">${esc(c.result)}</div>` : ''}
    ${c.next ? `<div class="fc-k">다음</div><div class="fc-v">${esc(c.next)}</div>` : ''}
    ${(c.also ?? []).map((x) => `<div class="fc-also">문제 ${esc(x.owner.slice(1))}: ${esc(x.title)}${x.result ? ` — ${esc(x.result)}` : ''}</div>`).join('')}
    <div class="muted tiny">${esc(ev.event_label)} · ${esc(ev.event_id)}${ev.caused_by ? ` ← ${esc(ev.caused_by)}` : ''}</div></div>`;
}

async function renderRight(el, planId, ctx) {
  const [f, sched, sc] = await Promise.all([api.get(`/api/p4/flow?limit=8${planId ? `&plan_id=${encodeURIComponent(planId)}` : ''}`), api.get('/api/p4/schedule'), api.get('/api/p4/direct')]);
  const g0 = f.groups[0];
  const atStart = sched.sim_clock === '2026-07-01';
  const upcoming = sched.rows.filter((r) => r.active && r.status === '대기').slice(0, 5);
  const scen = [['S-AR-DELAY', '회수일 지연'], ['S-CEO-FLOOR', '그룹 CEO 최저 잔액 조건(가정)'], ['S4-OI3-A', '그룹 배분 대상 회신']];
  el.innerHTML = `
    <div class="r-head"><h2>데이터 흐름과 판단</h2><span class="muted small">평가자 화면 · ${planId ? `${esc(planId)}만` : '전체'}</span>${planId ? ' <a href="#/" class="small">전체 보기</a>' : ''}</div>
    ${flowDiagram(g0)}
    <section class="r-sec"><h3>방금 일어난 일</h3>
      ${g0 ? `<div class="trigger">시작: <span class="actor ${ACTOR_CLASS[g0.trigger.actor_kind] ?? ''}">${esc(g0.trigger.actor_kind)}</span> ${esc(g0.trigger.title)} <span class="muted small">(${md(g0.started_at)}, 이어진 사건 ${g0.total}건${g0.truncated ? `, 앞 ${g0.cards.length}건 표시` : ''})</span></div>
        ${g0.cards.map(cardHtml).join('')}` : '<p class="muted">아직 사건이 없습니다.</p>'}
      ${f.groups.length > 1 ? `<details class="fold"><summary>그 전에 일어난 일 ${f.groups.length - 1}건</summary>${f.groups.slice(1).map((g) => `<details class="fold sub"><summary><span class="actor ${ACTOR_CLASS[g.trigger.actor_kind] ?? ''}">${esc(g.trigger.actor_kind)}</span> ${esc(g.trigger.title)} <span class="muted small">${md(g.started_at)} · ${g.total}건</span></summary>${g.cards.map(cardHtml).join('')}</details>`).join('')}</details>` : ''}
    </section>
    <section class="r-sec demo"><h3>시연 조작</h3>
      <div class="row"><span>가상 일자 <b>${md(sched.sim_clock)}</b>(${esc(sched.sim_clock)})</span>
        <button id="r-1">1영업일 진행</button><button id="r-next" ${sched.next_date ? '' : 'disabled'}>다음 일정(${md(sched.next_date)})까지</button><button id="r-reset" class="danger">초기화</button></div>
      <div class="row small">시나리오(07-01에서만): ${scen.map(([id, name]) => `<label><input type="checkbox" data-scen="${id}" ${sched.scenarios.includes(id) ? 'checked' : ''} ${atStart ? '' : 'disabled'}> ${name}</label>`).join(' ')}</div>
      <div class="row small">직접 처리(마케팅 담당자 행동을 화면에서): ${sc.direct_plans.map((x) => `<span class="chip-soft">${esc(x)}</span>`).join(' ') || '없음'}
        ${(sc.pending ?? []).length ? `<span class="warn">· 사용자 행동을 기다리는 기안 ${sc.pending.length}건</span>` : ''}
        ${planId ? `<button id="r-direct">${sc.direct_plans.includes(planId) ? `${esc(planId)} 자동 처리로` : `${esc(planId)} 직접 처리로`}</button>` : ''}</div>
      ${upcoming.length ? `<div class="small muted">다음 모의 입력: ${upcoming.map((r) => `${md(r.sim_date)} ${esc(label(r.event_type))}${r.plan_id && r.plan_id !== 'NONE' ? ` ${esc(r.plan_id)}` : ''}`).join(' · ')}</div>` : ''}
      <p id="r-msg" class="muted small"></p></section>
    <section class="r-sec"><h3>상세 근거</h3><div class="row small">
      ${planId ? `<a href="#/plan/${esc(planId)}">이 기안의 문제별 탭</a> · <a href="#/events?plan_id=${esc(planId)}">이 기안의 사건 기록</a> · ` : ''}<a href="#/plans">기안 목록(전체 상태)</a> · <a href="#/events">사건 기록</a> · <a href="#/mock">모의 입력·순서표</a></div></section>`;
  const msg = el.querySelector('#r-msg');
  const go = async (body) => {
    try {
      const g = await guardDirect();
      if (!g) return;
      const r = await busy(`날짜를 진행하는 중입니다${body.to ? `(${md(body.to)}까지)` : '(1영업일)'}. 다른 부서의 모의 회신과 마감 점검을 처리합니다…`, () => api.post('/api/clock/advance', body));
      msg.textContent = `${r.from} → ${r.to}`; await ctx.refresh();
    } catch (err) { msg.textContent = `오류: ${err.message}`; }
  };
  el.querySelector('#r-1').onclick = () => go({ days: 1 });
  el.querySelector('#r-next').onclick = () => go({ to: sched.next_date });
  el.querySelector('#r-reset').onclick = async () => {
    const ok = await modal({ title: '처음(07-01)부터 다시 시작할까요?', body: '<p>실행 기록을 모두 지웁니다. 시나리오와 직접 처리 설정은 유지합니다.</p>', okLabel: '초기화', danger: true });
    if (!ok) return;
    try { await busy('처음(7월 1일)부터 다시 준비하는 중입니다…', () => api.post('/api/reset')); await ctx.refresh(); } catch (err) { msg.textContent = `오류: ${err.message}`; }
  };
  el.querySelectorAll('[data-scen]').forEach((c) => { c.onchange = async () => {
    try { await api.post('/api/p4/scenarios', { scenarios: [...el.querySelectorAll('[data-scen]:checked')].map((x) => x.dataset.scen) }); await ctx.refresh(); } catch (err) { msg.textContent = `오류: ${err.message}`; }
  }; });
  el.querySelector('#r-direct')?.addEventListener('click', async () => {
    try { await busy('설정을 바꾸는 중입니다…', () => api.post(`/api/p4/plans/${planId}/direct`, { on: !sc.direct_plans.includes(planId) })); await ctx.refresh(); } catch (err) { msg.textContent = `오류: ${err.message}`; }
  });
}

// ── 좌우 분할 화면 ──
export async function renderWork(view, { planId = null, sub = null, onRefreshMeta }) {
  if (!view.querySelector('.split')) view.innerHTML = '<div class="split"><div class="left" id="w-left"></div><div class="right" id="w-right"></div></div><div id="toast"></div>';
  const L = view.querySelector('#w-left');
  const R = view.querySelector('#w-right');
  const ctx = {
    sub,
    toast(text, bad = false) { const t = view.querySelector('#toast'); t.textContent = text; t.className = `show${bad ? ' bad' : ''}`; clearTimeout(t._h); t._h = setTimeout(() => { t.className = ''; }, 3500); },
    async refresh(opts = {}) {
      await onRefreshMeta?.();
      ctx.sub = opts.sub ?? null;
      const keep = L.scrollTop;
      await Promise.all([planId ? renderPlan(L, planId, ctx) : renderHome(L), renderRight(R, planId, ctx)]);
      if (opts.sub) L.scrollTop = keep;
    },
  };
  try {
    await Promise.all([planId ? renderPlan(L, planId, ctx) : renderHome(L), renderRight(R, planId, ctx)]);
  } catch (err) {
    L.innerHTML = `<p class="warn">오류: ${esc(err.message)}</p>`;
  }
}
export { eok };
