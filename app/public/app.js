// 화면 셸: 기안 목록 / 기안 상세(진행 요약 + 문제별 탭) / 사건 기록 / 모의 입력·날짜 진행
import { api, ui, esc, tag, krw, table, label } from './common.js';
import { renderWork, modal, guardDirect } from './work.js';

const view = document.getElementById('view');
let meta = null;
const panelCache = new Map();

async function loadPanel(mod) {
  if (!mod.panel) return null;
  if (!panelCache.has(mod.id)) {
    panelCache.set(mod.id, import(`/panels/${mod.id}.js`).then((m) => m.default).catch((err) => ({ error: err.message })));
  }
  return panelCache.get(mod.id);
}

// 화면은 그릴 때마다 서버의 최신 상태를 다시 읽는다. 늦게 끝난 옛 조회·그리기가 새 값을 덮지 않도록 순번으로 막는다.
let routeSeq = 0;
let metaSeq = 0;
async function refreshMeta() {
  const n = ++metaSeq;
  const fresh = await api.get('/api/meta');
  if (n !== metaSeq) return;
  meta = fresh;
  document.getElementById('clock').textContent = meta.sim_clock;
  document.getElementById('ai').textContent = meta.ai.status;
  document.getElementById('legend').innerHTML =
    `자료 구분 ${tag('원본도출')} ${tag('계산')} ${tag('가정')} ${tag('모의회신')} ${tag('사람입력', true)} ${tag(null, false, true)}` +
    ' <span class="muted">시뮬레이션 = 가상 전제(사람입력·모의·가정)에 기대어 계산된 값. 표시는 구역·열 제목에 한 번만 붙인다</span>';
}

// ── 기안 요약 읽기 ──
// 요약 항목: { owner, label, value, source_type, is_synthetic, is_simulation, step? }. step이 있으면 진행 요약의 그 단계 마감이다.
const find = (summaries, owner, lbl) => summaries.find((s) => s.owner === owner && !s.step && (lbl instanceof RegExp ? lbl.test(s.label) : s.label === lbl));
const TONE = [[/부족|거절|불가|철회|기한 경과|미등록|반려/, 'bad'], [/가능|승인|확정|등록|유지/, 'ok']];
const tone = (v) => (v == null ? 'none' : (TONE.find(([re]) => re.test(String(v)))?.[1] ?? 'wait'));
const pill = (v) => (v == null ? '<span class="muted">-</span>' : `<span class="pill ${tone(v)}">${esc(label(v))}</span>`);

// 목록 열: (owner, label). 열 제목에 자료 구분을 한 번만 붙인다
const COLUMNS = [
  { title: '수요 입력', owner: 'p1', label: '수요 입력' },
  { title: '공급 판정', owner: 'p2', label: '공급 판정' },
  { title: '승인권자', owner: 'p3', label: '승인권자' },
  { title: '승인 상태', owner: 'p3', label: '승인 상태' },
  { title: '확정', owner: 'p4', label: '확정' },
  { title: '다음 마감', owner: 'p4', label: /^다음 마감/ },
];
function columnTag(plans, col) {
  const s = plans.map((p) => find(p.summaries, col.owner, col.label)).find(Boolean);
  return s ? tag(s.source_type, s.is_synthetic, s.is_simulation) : '';
}

async function renderPlans(qs, n) {
  const q = new URLSearchParams(qs);
  const { plans } = await api.get('/api/plans');
  if (n !== routeSeq) return;
  const status = q.get('status') ?? '';
  const statusOf = (p) => find(p.summaries, 'p4', '확정')?.value ?? '';
  const shown = plans.filter((p) => !status || (status === '검토 중' ? !['확정', '철회', '기한 경과 확정'].includes(statusOf(p)) : statusOf(p) === status));
  const counts = plans.reduce((m, p) => { const v = ['확정', '철회', '기한 경과 확정'].includes(statusOf(p)) ? statusOf(p) : '검토 중'; m[v] = (m[v] ?? 0) + 1; return m; }, {});
  view.innerHTML = `<h1>기안 ${plans.length}건</h1>
    <p class="muted">원본 <code>mkt_budget_plan_ms.csv</code> ${tag('원본도출')}. 요청액은 표본 스케일이라 현금과 합산하지 않는다.</p>
    <div class="row filters">${['', '검토 중', '확정', '철회', '기한 경과 확정'].map((s) =>
      `<a class="filter ${s === status ? 'on' : ''}" href="#/plans${s ? `?status=${encodeURIComponent(s)}` : ''}">${s || '전체'} <span class="muted">${s ? counts[s] ?? 0 : plans.length}</span></a>`).join('')}</div>
    ${table([
      { label: '기안', render: (p) => `<a href="#/plan/${esc(p.plan_id)}"><b>${esc(p.plan_id)}</b></a><div class="muted small">${esc(p.campaign_name)} · ${esc(p.product_line)}</div>` },
      { label: '확정기한', nowrap: true, render: (p) => esc(p.contract_deadline) },
      ...COLUMNS.map((c) => ({ label: c.title, tag: columnTag(plans, c), nowrap: true, render: (p) => {
        const s = find(p.summaries, c.owner, c.label);
        if (c.title === '다음 마감') return s ? `${esc(s.value)} <span class="muted small">${esc(s.label.replace(/^다음 마감\(?|\)$/g, ''))}</span>` : '<span class="muted">-</span>';
        const extra = c.title === '확정' && find(p.summaries, 'p4', '모의 입력') ? ' <span class="muted small">기본 규칙</span>' : '';
        return s ? pill(s.value) + extra : '<span class="muted">연결 안 됨</span>';
      } })),
    ], shown, { empty: '해당 기안 없음' })}`;
}

// ── 기안 상세: 진행 요약 + 탭 ──
const STEPS = [
  { owner: 'p1', title: '수요 입력', value: (s) => find(s, 'p1', '수요 입력')?.value },
  { owner: 'p2', title: '공급 판정', value: (s) => find(s, 'p2', '공급 판정')?.value },
  { owner: 'p3', title: '승인 경로', value: (s) => [find(s, 'p3', '승인권자')?.value, find(s, 'p3', '승인 상태')?.value].filter(Boolean).join(' · ') || null },
  { owner: 'p4', title: '확정', value: (s) => find(s, 'p4', '확정')?.value },
];
function progress(summaries) {
  return `<ol class="steps">${STEPS.map((st) => {
    const v = st.value(summaries);
    const due = summaries.find((x) => x.step === st.owner);
    return `<li class="step ${tone(v)}"><div class="st-title">${esc(st.title)}</div><div class="st-val">${v ? esc(label(v)) : '<span class="muted">연결 안 됨</span>'}</div>
      <div class="st-due muted small">${due ? `${esc(due.label)} ${esc(due.value)}` : '&nbsp;'}</div></li>`;
  }).join('<li class="arrow">→</li>')}</ol>`;
}

async function renderPlan(planId, qs, n) {
  const q = new URLSearchParams(qs);
  const { plan, summaries, events } = await api.get(`/api/plans/${encodeURIComponent(planId)}`);
  if (n !== routeSeq) return;
  const tabs = [...meta.modules.map((m) => ({ id: m.id, title: m.title })), { id: 'events', title: `사건 ${events.length}` }];
  const active = tabs.some((t) => t.id === q.get('tab')) ? q.get('tab') : tabs[0].id;
  view.innerHTML = `<p><a href="#/plans">← 기안 목록</a> · <a href="#/w/${esc(plan.plan_id)}">업무 화면으로</a></p>
    <h1>${esc(plan.plan_id)} <span class="muted">${esc(plan.campaign_name)}</span></h1>
    <section class="card">
      ${progress(summaries)}
      <p class="muted small">원본 기안 ${tag('원본도출')} 캠페인 ${esc(plan.campaign_id)} · ${esc(plan.product_line)} · 요청액(표본) ${krw(plan.requested_budget_krw)} ·
        집행 예정일 ${esc(plan.settlement_date)} · 확정기한 ${esc(plan.contract_deadline)} · 예상 GMV ${krw(plan.expected_gmv_krw)} <span class="warn">승인 근거 아님(실질 공헌이익 미산정)</span></p>
    </section>
    <nav class="tabs">${tabs.map((t) => `<a class="${t.id === active ? 'on' : ''}" href="#/plan/${esc(plan.plan_id)}?tab=${t.id}">${esc(t.title)}</a>`).join('')}</nav>
    <section class="card tab-body" id="tab-body"></section>`;
  const body = document.getElementById('tab-body');
  if (active === 'events') { body.innerHTML = eventFilterBar(events) + `<div id="ev-list">${eventTable(events)}</div>`; bindEventFilter(body, events); return; }
  const m = meta.modules.find((x) => x.id === active);
  const panel = await loadPanel(m);
  if (!m.loaded && !panel) { body.innerHTML = '<p class="muted">아직 연결되지 않음</p>'; return; }
  if (!panel?.renderPlan) { body.innerHTML = `<p class="muted">${panel?.error ? `패널 오류: ${esc(panel.error)}` : '패널 없음'}</p>`; return; }
  try { await panel.renderPlan(body, { plan, api, ui }); }
  catch (err) { body.innerHTML = `<p class="warn">패널 오류: ${esc(err.message)}</p>`; }
}

// ── 사건 표 ──
function eventTable(events) {
  return table([
    { label: '발생일', nowrap: true, render: (e) => `${esc(e.occurred_at)}<div class="muted small">#${e.seq}</div>` },
    { label: '사건', render: (e) => `<b>${esc(label(e.event_type))}</b><div class="muted small">${esc(e.event_type)} · ${esc(e.event_id)}</div>` },
    { label: '기안', nowrap: true, render: (e) => (e.plan_id === 'NONE' ? '<span class="muted">-</span>' : `<a href="#/plan/${esc(e.plan_id)}">${esc(e.plan_id)}</a>`) },
    { label: '대상', render: (e) => esc([label(e.subject_type), e.subject_id].filter(Boolean).join(' ')) },
    { label: '주체', nowrap: true, render: (e) => `${esc(label(e.actor_dept))}<div class="muted small">${esc(label(e.emitted_by))}</div>` },
    { label: '자료 구분', nowrap: true, render: (e) => tag(e.source_type, e.is_synthetic, e.is_simulation) + (e.scenario_id !== 'BASE' ? ` <span class="small">${esc(label(e.scenario_id))}</span>` : '') },
    { label: '내용', render: (e) => `${esc(e.generation_reason ?? '')}<details><summary class="small">payload</summary><pre>${esc(JSON.stringify(e.payload, null, 2))}</pre></details>` },
  ], events, { empty: '사건이 없습니다' });
}
function eventFilterBar(events) {
  const types = [...new Set(events.map((e) => e.event_type))].sort((a, b) => label(a).localeCompare(label(b), 'ko'));
  return `<div class="row"><label>유형 <select id="ev-type"><option value="">전체 ${events.length}</option>${types.map((t) =>
    `<option value="${esc(t)}">${esc(label(t))} ${events.filter((e) => e.event_type === t).length}</option>`).join('')}</select></label></div>`;
}
function bindEventFilter(root, events) {
  root.querySelector('#ev-type').onchange = (ev) => {
    const t = ev.target.value;
    root.querySelector('#ev-list').innerHTML = eventTable(t ? events.filter((e) => e.event_type === t) : events);
  };
}

async function renderEvents(qs, n) {
  const q = new URLSearchParams(qs);
  const [{ events }, sum, { plans }] = await Promise.all([api.get(`/api/events?${q}&limit=${q.get('limit') ?? 300}`), api.get('/api/events/summary'), api.get('/api/plans')]);
  if (n !== routeSeq) return;
  const types = Object.entries(sum.by_type).sort((a, b) => b[1] - a[1]);
  view.innerHTML = `<h1>사건 기록 <span class="muted">전체 ${sum.total}건</span></h1>
    <form id="filter" class="row card">
      <label>유형 <select name="event_type"><option value="">전체</option>${types.map(([t, n]) =>
        `<option value="${esc(t)}" ${q.get('event_type') === t ? 'selected' : ''}>${esc(label(t))} (${n})</option>`).join('')}</select></label>
      <label>기안 <select name="plan_id"><option value="">전체</option><option value="NONE" ${q.get('plan_id') === 'NONE' ? 'selected' : ''}>기안 없음(공통)</option>${plans.map((p) =>
        `<option ${q.get('plan_id') === p.plan_id ? 'selected' : ''}>${esc(p.plan_id)}</option>`).join('')}</select></label>
      <label>낸 문제 <select name="emitted_by"><option value="">전체</option>${['p1', 'p2', 'p3', 'p4'].map((p) =>
        `<option value="${p}" ${q.get('emitted_by') === p ? 'selected' : ''}>${label(p)}</option>`).join('')}</select></label>
      <label>시나리오 <select name="scenario_id"><option value="">전체</option>${['BASE', 'S-AR-DELAY', 'S4-OI3-A', 'S-SUP-REPLY', 'S-CEO-FLOOR'].map((s) =>
        `<option value="${s}" ${q.get('scenario_id') === s ? 'selected' : ''}>${label(s)}</option>`).join('')}</select></label>
      <button>보기</button>
    </form>
    <p class="muted">${events.length}건 표시 · 최신순${events.length >= Number(q.get('limit') ?? 300) ? ` (최근 ${events.length}건까지)` : ''}</p>${eventTable(events)}`;
  document.getElementById('filter').onsubmit = (ev) => {
    ev.preventDefault();
    const f = new URLSearchParams([...new FormData(ev.target)].filter(([, v]) => v));
    location.hash = `#/events?${f}`;
  };
}

// ── 모의 입력·날짜 진행: 시계·시나리오·일정표를 한눈에, 문제별 모의 입력은 탭 ──
async function renderMock(qs, n) {
  if (n !== routeSeq) return;
  const q = new URLSearchParams(qs);
  const others = meta.modules.filter((m) => m.id !== 'p4');
  const active = others.some((m) => m.id === q.get('tab')) ? q.get('tab') : others[0]?.id;
  view.innerHTML = `<h1>모의 입력·날짜 진행</h1>
    <section class="card">
      <div class="row">
        <span>가상 일자 <b class="big">${esc(meta.sim_clock)}</b> <span class="muted small">영업일 월~금, 공휴일 없음, 뒤로 돌리지 않음</span></span>
        <button id="adv1">1영업일 진행</button>
        <label>이 날짜까지 <input type="date" id="advTo" min="${esc(meta.sim_clock)}"></label><button id="advGo">진행</button>
        <button id="reset" class="danger">전체 초기화(07-01부터)</button>
      </div>
      <p id="msg" class="muted"></p>
    </section>
    <section class="card" id="mock-p4"><h2>${esc(meta.modules.find((m) => m.id === 'p4')?.title ?? '문제 4')} · 시나리오와 사건 순서표</h2><div class="body"></div></section>
    <nav class="tabs">${others.map((m) => `<a class="${m.id === active ? 'on' : ''}" href="#/mock?tab=${m.id}">${esc(m.title)}</a>`).join('')}</nav>
    <section class="card tab-body" id="mock-tab"><div class="body"></div></section>`;
  const msg = document.getElementById('msg');
  const run = async (fn) => { try { msg.textContent = await fn(); await refreshMeta(); await route(); } catch (err) { msg.textContent = `오류: ${err.message}`; } };
  // L8: 직접 처리 기안이 사용자 행동을 기다리면 날짜를 넘기기 전에 알린다
  document.getElementById('adv1').onclick = () => run(async () => {
    if (!(await guardDirect())) return '진행을 취소했습니다';
    const r = await api.post('/api/clock/advance', { days: 1 }); return `${r.from} → ${r.to}`;
  });
  document.getElementById('advGo').onclick = () => run(async () => {
    const to = document.getElementById('advTo').value;
    if (!to) return '날짜를 고르세요';
    if (!(await guardDirect())) return '진행을 취소했습니다';
    const r = await api.post('/api/clock/advance', { to });
    return `${r.from} → ${r.to} (${r.processed.length}영업일)`;
  });
  document.getElementById('reset').onclick = async () => {
    const ok = await modal({ title: '처음(07-01)부터 다시 시작할까요?', body: '<p>실행 기록을 모두 지웁니다.</p>', okLabel: '초기화', danger: true });
    if (ok) run(async () => { await api.post('/api/reset'); return '초기화했습니다'; });
  };
  for (const [m, body] of [[meta.modules.find((x) => x.id === 'p4'), document.querySelector('#mock-p4 .body')], [others.find((x) => x.id === active), document.querySelector('#mock-tab .body')]]) {
    if (!m || !body) continue;
    const panel = await loadPanel(m);
    if (!panel?.renderMock) { body.innerHTML = `<p class="muted">${m.loaded ? '모의 입력 화면 없음' : '아직 연결되지 않음'}</p>`; continue; }
    try { await panel.renderMock(body, { api, ui }); }
    catch (err) { body.innerHTML = `<p class="warn">패널 오류: ${esc(err.message)}</p>`; }
  }
}

async function route() {
  const n = ++routeSeq;
  const hash = location.hash.slice(1) || '/';
  const [p, qs = ''] = hash.split('?');
  try {
    await refreshMeta(); // 초기화·날짜 진행 뒤(다른 화면·창 포함) 상단 가상 일자와 모듈 정보를 다시 읽는다
    if (n !== routeSeq) return;
    // 첫 화면: 좌우 분할(왼쪽 기안 담당자, 오른쪽 데이터 흐름). 기존 화면은 '상세 근거'로 남긴다.
    const work = p === '/' || p === '' || p.startsWith('/w/');
    document.body.classList.toggle('work-mode', work);
    if (work) {
      const [, , planId, sub] = p.split('/');
      return await renderWork(view, { planId: planId ? decodeURIComponent(planId) : null, sub: sub ?? null, onRefreshMeta: refreshMeta });
    }
    if (p.startsWith('/plan/')) return await renderPlan(decodeURIComponent(p.slice(6)), qs, n);
    if (p === '/events') return await renderEvents(qs, n);
    if (p === '/mock') return await renderMock(qs, n);
    return await renderPlans(qs, n);
  } catch (err) {
    if (n === routeSeq) view.innerHTML = `<p class="warn">오류: ${esc(err.message)}</p>`;
  }
}

window.addEventListener('hashchange', route);
// 뒤로·앞으로 가기로 페이지가 캐시에서 되살아나면 옛 화면이 남으므로 다시 그린다
window.addEventListener('pageshow', (ev) => { if (ev.persisted) route(); });
await route();
