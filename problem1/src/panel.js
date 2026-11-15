// 문제 1 화면 패널(전체 폭). 서버 계산을 보여주고 입력만 받는다(계산·판정은 서버).
// 화면 지침: 결론을 먼저, 긴 표는 접고, 자료 구분 표시는 구역 제목에 한 번, 코드는 한국어 이름으로.
const STYLE = `<style>
.p1 .tag{white-space:nowrap}
.p1 h3{display:flex;flex-wrap:wrap;align-items:center;gap:4px;font-size:14px;margin:14px 0 6px}
.p1 .p1-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px;margin:6px 0}
.p1 .p1-card{border:1px solid var(--line,#dde1e8);border-radius:6px;padding:8px 10px;background:#fafbfc}
.p1 .p1-card .k{color:var(--muted,#6b7385);font-size:12px}
.p1 .p1-card .v{font-size:15px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.p1 .p1-card .v.w{white-space:normal;font-size:13px;font-weight:500}
.p1 .p1-card .s{color:var(--muted,#6b7385);font-size:12px}
.p1 .p1-head{display:flex;flex-wrap:wrap;gap:6px 16px;align-items:baseline;padding:6px 10px;background:#eef3fb;border-radius:6px}
.p1 details{margin:6px 0}
.p1 details>summary{cursor:pointer;color:var(--accent,#2457c5)}
.p1 td,.p1 th{white-space:nowrap}
.p1 td.wrap{white-space:normal;min-width:220px}
.p1 .p1-confirm{border:2px solid var(--accent,#2457c5);border-radius:6px;padding:8px 10px;margin:8px 0;background:#fff}
.p1 .p1-confirm input{margin-right:4px}
.p1 .warn{white-space:normal}
</style>`;

// 코드 → 한국어 이름(표시용)
const NAME = {
  inbound_scenario: { on_schedule: '예상 입고 포함', not_arrived: '확약 입고만' },
  approver: { GRP_CEO: '그룹 CEO', MS_CEO: 'Masil 대표', MKT_TEAM: '마케팅팀', SCM: 'SCM' },
  request_kind: { initial: '최초 요청', rerequest: '재요청', correction: '정정 요청' },
  origin: { reply: '마케팅 회신', alternative: '대안 선택' },
  reply_pattern: { on_time: '기한 내', late: '지연', revised: '정정', missing: '미등록' },
  dept: { MKT: '마케팅', SCM: 'SCM', FIN: '재무', MS_MGMT: 'Masil 경영', GROUP: '그룹', COREVIA: 'Corevia', SYSTEM: '시스템' },
};
const nm = (kind, v) => NAME[kind]?.[v] ?? v ?? '-';

// 다른 모듈 값: 연결 안 됨 / 오류 / 없음 / 값
function ext(x, ui, render, empty = '없음') {
  if (!x || x.connected === false) return '<span class="muted">연결 안 됨</span>';
  if (x.error) return `<span class="warn">오류: ${ui.esc(x.error)}</span>`;
  if (x.value == null || (Array.isArray(x.value) && !x.value.length)) return `<span class="muted">${ui.esc(empty)}</span>`;
  return render(x.value);
}
const card = (ui, k, v, s = '', wrap = false) => `<div class="p1-card"><div class="k">${ui.esc(k)}</div><div class="v${wrap ? ' w' : ''}" title="${ui.esc(String(v).replace(/<[^>]+>/g, ''))}">${v}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`;
const fold = (ui, summary, body, open = false) => `<details${open ? ' open' : ''}><summary>${ui.esc(summary)}</summary>${body}</details>`;
const skuLabel = (ui, names, id) => `${ui.esc(names.get(id) ?? id)} <span class="muted">${ui.esc(id.slice(4))}</span>`;
const pctText = (v) => (v == null ? '-' : `${Number(v).toFixed(1)}%`);
const period = (v) => (v?.sale_start_week ? `${v.sale_start_week.slice(5)} 주부터 ${v.sale_weeks}주` : '-');

function weeklyTables(rows, ui, names) {
  if (!rows.length) return { summary: '<p class="muted">유효한 수요 입력이 없어 추가 수량이 없다.</p>', detail: '' };
  const skus = [...new Set(rows.map((r) => r.sku_id))].sort();
  const weeks = [...new Set(rows.map((r) => r.week_start))].sort();
  const summary = ui.table([
    { label: 'SKU', render: (r) => skuLabel(ui, names, r.sku_id) },
    { label: '기준 수요(주)', render: (r) => ui.num(r.baseline_weekly_qty) },
    { label: '적용 증가율', render: (r) => pctText(r.applied_uplift_pct) },
    { label: '주당 추가(EA)', render: (r) => ui.num(r.added_qty_ea) },
    { label: '판매 주', render: (r) => `${r.first.slice(5)} ~ ${r.last.slice(5)} (${r.n}주)` },
    { label: '합계(EA)', render: (r) => `<b>${ui.num(r.total)}</b>` },
  ], skus.map((s) => {
    const rs = rows.filter((r) => r.sku_id === s);
    return { ...rs[0], first: rs[0].week_start, last: rs.at(-1).week_start, n: rs.length, total: rs.reduce((a, r) => a + r.added_qty_ea, 0) };
  }));
  const head = `<tr><th>SKU</th>${weeks.map((w) => `<th>${ui.esc(w.slice(5))}</th>`).join('')}</tr>`;
  const body = skus.map((s) => {
    const by = new Map(rows.filter((r) => r.sku_id === s).map((r) => [r.week_start, r.added_qty_ea]));
    return `<tr><td>${skuLabel(ui, names, s)}</td>${weeks.map((w) => `<td>${ui.num(by.get(w))}</td>`).join('')}</tr>`;
  }).join('');
  return { summary, detail: fold(ui, `주차별 표 (${weeks.length}주)`, `<div class="scroll"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>`) };
}

// 잔여 여지 문장: 없음(보충 가능 구간뿐) / 0 / 최소값
function headroomText(r, ui) {
  const until = r.reorder_reach_week ? `${r.reorder_reach_week.slice(5)} 주 전까지` : '전개 끝까지';
  if (r.headroom_state === 'none') return `해당 없음: 막을 수 없는 구간이 없어 전 구간을 보충 발주로 확보할 수 있다`;
  if (r.headroom_state === 'zero') return `<span class="warn">0 EA: ${ui.esc(until)} 추가분을 받을 여지가 없다</span> <span class="muted">(${ui.esc(r.min_week_start.slice(5))} 주에 0)</span>`;
  return `최소 ${ui.num(r.min_residual_headroom_qty)} EA <span class="muted">(${ui.esc(r.min_week_start.slice(5))} 주, ${ui.esc(until)})</span>`;
}

function confirmForm(v, ui) {
  const ex = v.extracted_fields ?? {};
  const val = (k) => ui.esc(ex[k] ?? '');
  const missing = v.missing_fields?.length ? `<span class="warn">AI가 비운 항목: ${ui.esc(v.missing_fields.join(', '))}</span>` : '';
  return `<form class="p1-confirm" data-id="${ui.esc(v.demand_input_id)}" data-version="${v.version}">
    <div><b>확인 대기 v${v.version}</b> · ${ui.esc(nm('origin', v.origin))} ${ui.esc(v.occurred_at)} · AI ${ui.esc(v.ai_status)} ${missing}</div>
    <p class="muted">회신 원문: ${ui.esc(v.reply_text)}</p>
    <div class="row">
      <label>증가율(%) <input name="uplift_pct" size="6" value="${val('uplift_pct')}"></label>
      <label>판매 시작 주(월) <input name="sale_start_week" type="date" value="${val('sale_start_week')}"></label>
      <label>판매 주수 <input name="sale_weeks" size="3" value="${val('sale_weeks')}"></label>
      <label>근거 <input name="rationale_text" size="30" value="${val('rationale_text')}"></label>
      <button name="decision" value="확인">확인</button> <button name="decision" value="거부" class="danger">거부</button>
    </div>
    <p class="muted">AI가 채운 값은 확인 전 판정에 쓰이지 않는다. 확인하면 담당자 입력(가상)으로 기록된다.</p>
  </form>`;
}

async function renderPlan(el, { plan, api, ui }) {
  const d = await api.get(`/api/p1/plans/${encodeURIComponent(plan.plan_id)}`);
  const names = new Map(d.plan_sku_map.map((r) => [r.sku_id, r.sku_name ?? r.sku_id]));
  const st = d.demand_status_by_plan;
  const x = d.external;
  const valid = d.versions.find((v) => v.version_status === '유효');
  const pending = d.versions.filter((v) => v.version_status === '확인대기');
  const ref = d.reference_metrics;
  const reqs = x.info_requests?.value ?? [];
  const lastReq = reqs.at(-1);
  const due = x.deadline?.value?.demand_input_due;
  const wk = weeklyTables(d.campaign_demand_weekly, ui, names);
  const changed = d.versions.filter((v) => v.version_status === '대체됨' || v.version_status === '반려');

  el.innerHTML = `${STYLE}<div class="p1">
  <div class="p1-head">
    <span>수요 입력 <b>${ui.esc(st.demand_status)}${st.version ? ` v${st.version}` : ''}</b></span>
    <span>마감 <b>${ui.esc(due ?? (x.deadline?.connected === false ? '연결 안 됨' : '-'))}</b></span>
    <span>요청 <b>${ui.esc(lastReq ? `${nm('request_kind', lastReq.request_kind)} · ${lastReq.request_status}` : (x.info_requests?.connected === false ? '연결 안 됨' : '없음'))}</b></span>
    <span>AI <b>${ui.esc(d.ai_status)}</b></span>
    <span class="muted">가상 일자 ${ui.esc(d.sim_clock)}</span>
  </div>

  <h3>① 수요 입력 ${valid ? ui.tag('사람입력', valid.is_synthetic) : ''}</h3>
  ${pending.map((v) => confirmForm(v, ui)).join('')}
  ${valid ? `<div class="p1-cards">
    ${card(ui, '증가율(라인 공통)', pctText(valid.uplift_pct), valid.overrides.length ? `SKU별: ${valid.overrides.map((o) => `${ui.esc(names.get(o.sku_id) ?? o.sku_id)} ${pctText(o.override_uplift_pct)}`).join(', ')}` : 'SKU별 조정 없음')}
    ${card(ui, '판매 기간', ui.esc(period(valid)))}
    ${card(ui, '출처', ui.esc(`${nm('origin', valid.origin)} v${valid.version}`), `${ui.esc(valid.occurred_at)} 접수 · ${ui.esc(valid.effective_at ?? '')} 확인`)}
    ${card(ui, '근거', ui.esc(valid.rationale_text ?? '-'), '', true)}
  </div>` : `<p class="warn">유효한 수요 입력이 없다. 판매 기간에 기본값을 넣지 않으며, 공급 판정은 방향 판단만 낸다.</p>`}
  ${changed.length ? fold(ui, `지난 버전 ${changed.length}건 (대체·반려)`, ui.table([
    { label: '버전', render: (v) => `v${v.version}` }, { label: '상태', key: 'version_status' },
    { label: '증가율', render: (v) => pctText(v.uplift_pct) }, { label: '판매 기간', render: (v) => ui.esc(period(v)) },
    { label: '출처', render: (v) => ui.esc(`${nm('origin', v.origin)} ${v.occurred_at}`) },
    { label: '반려 사유', render: (v) => `<span class="wrap">${ui.esc(v.reject_reason ?? '')}</span>` },
  ], changed)) : ''}

  <h3>② 추가 수량(EA) ${ui.tag('계산', false, true)}</h3>
  ${wk.summary}${wk.detail}
  <p class="muted">${ui.esc(d.notice)}</p>

  <h3>③ 요청 화면 내용 ${ui.tag('계산')}</h3>
  <div class="p1-cards">
    ${card(ui, '승인 경로', ext(x.commitment, ui, (c) => ui.esc(nm('approver', c.approver))), ext(x.commitment, ui, (c) => ui.esc(c.approval_route ?? ''), ''))}
    ${card(ui, '방향 판단(문제 2)', ext(x.supply_judgment, ui, (j) => ui.esc(j.plan?.supply_verdict ?? '-')), ext(x.supply_judgment, ui, (j) => ui.esc(j.plan?.direction_note ?? ''), ''))}
    ${card(ui, '보류', ext(x.holds, ui, (hs) => ui.esc(hs.filter((h) => h.hold_status === '보류 중').length ? '보류 중' : '없음')))}
    ${card(ui, '표본 참고', ref.thin_sample ? '<span class="warn">표본 얇음</span>' : `${ui.num(ref.sample_orders)}건`, `같은 라인 표본 캠페인 ${ref.line_sample_campaigns}개`)}
  </div>
  ${ext(x.supply_summary, ui, (rows) => ui.table([
    { label: 'SKU', render: (r) => skuLabel(ui, names, r.sku_id) },
    { label: '입고 경우', render: (r) => ui.esc(nm('inbound_scenario', r.inbound_scenario)) },
    { label: '막을 수 없는 구간의 잔여 여지', render: (r) => headroomText(r, ui) },
    { label: '추가분 0이어도 품절 첫 주', render: (r) => ui.esc(r.first_stockout_week?.slice(5) ?? '없음') },
  ], rows), '잔여 여지 없음')}
  <p class="muted">주별 전개와 판정 근거는 문제 2 구역에 있다.</p>
  ${fold(ui, '참고 지표 (표본 계열의 비율·순위, 승인 근거 아님)', `<dl class="kv">
    <dt>기안 배수(예상 GMV ÷ 요청액)</dt><dd>${ui.esc(ref.plan_multiplier)}배</dd>
    <dt>같은 캠페인 표본 명목 ROAS</dt><dd>${ui.esc(ref.nominal_roas ?? '-')}배</dd>
    <dt>표본 주문</dt><dd>${ui.num(ref.sample_orders)}건 · 같은 제품라인 표본 캠페인 ${ref.line_sample_campaigns}개${ref.thin_sample ? ' <span class="warn">표본 얇음</span>' : ''}</dd>
    <dt>SKU별 표본 주문 비중</dt><dd>${ref.sku_order_share.map((s) => `${ui.esc(names.get(s.sku_id) ?? s.sku_id)} ${s.share_pct}%`).join(' · ')}</dd>
    <dt>전사 주간판매 최대/중앙값</dt><dd>${Object.entries(ref.sku_sales_max_over_median).map(([k, v]) => `${ui.esc(names.get(k) ?? k)} ${v}배`).join(' · ')}</dd>
  </dl>`)}
  ${fold(ui, `기준 수요 (${d.baseline_demand.length} SKU, 최근 4주 평균)`, ui.table([
    { label: 'SKU', render: (b) => skuLabel(ui, names, b.sku_id) },
    { label: '기준 수요(주, EA)', render: (b) => ui.num(b.baseline_weekly_qty) },
    { label: '기간', render: (b) => `${ui.esc(b.window_start)} ~ ${ui.esc(b.window_end)} 주` },
  ], d.baseline_demand) + `<p class="muted">제품라인 ${ui.esc(d.plan_sku_map[0]?.product_line)} = SKU 분류로 전개 ${ui.tag('원본도출')}. 국가별 가용 재고는 확인 불가.</p>`)}
  ${reqs.length > 1 || (x.reviews?.value ?? []).length ? fold(ui, `요청 ${reqs.length}건 · 재검토 ${(x.reviews?.value ?? []).length}건`, ui.table([
    { label: '요청', key: 'request_id' }, { label: '종류', render: (r) => ui.esc(nm('request_kind', r.request_kind)) },
    { label: '기한', key: 'request_due_date' }, { label: '상태', key: 'request_status' },
  ], reqs)) : ''}
  ${fold(ui, '회신 원문 입력(모의)', `<form class="p1-reply"><input name="reply_text" size="70" placeholder="예: 판매는 7/20 주부터 4주, 기준 대비 30% 증가 예상"> <button>회신 등록</button></form>`)}
  <p class="p1-msg muted"></p>
  </div>`;

  const msg = el.querySelector('.p1-msg');
  const rerender = () => renderPlan(el, { plan, api, ui });
  for (const f of el.querySelectorAll('.p1-confirm')) {
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      const fd = new FormData(f);
      try {
        const r = await api.post(`/api/p1/demand-inputs/${encodeURIComponent(f.dataset.id)}/versions/${f.dataset.version}/confirm`, {
          decision: ev.submitter?.value ?? '확인',
          fields: { uplift_pct: fd.get('uplift_pct'), sale_start_week: fd.get('sale_start_week'), sale_weeks: fd.get('sale_weeks'), rationale_text: fd.get('rationale_text') },
        });
        msg.textContent = `${r.version_status}${r.reject_reason ? `: ${r.reject_reason}` : ''}`;
        await rerender();
      } catch (err) { msg.textContent = `오류: ${err.message}`; }
    };
  }
  const reply = el.querySelector('.p1-reply');
  if (reply) reply.onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      await api.post(`/api/p1/plans/${encodeURIComponent(plan.plan_id)}/replies`, { reply_text: new FormData(ev.target).get('reply_text') });
      await rerender();
    } catch (err) { msg.textContent = `오류: ${err.message}`; }
  };
}

async function renderMock(el, { api, ui }) {
  const d = await api.get('/api/p1/mock');
  const done = d.rows.filter((r) => r.delivered).length;
  el.innerHTML = `${STYLE}<div class="p1">
    <div class="p1-head"><span>수요 회신 모의 자료 <b>${d.rows.length}행</b> ${ui.tag('모의회신')}</span><span>전달 <b>${done}</b> / 대기 <b>${d.rows.length - done}</b></span>
    <span>문제 4 순서표 <b>${d.schedule.connected === false ? '연결 안 됨' : `${(d.schedule.value ?? []).length}행`}</b></span></div>
    ${fold(ui, '회신 목록', ui.table([
      { label: '기안', render: (r) => `${ui.esc(r.plan_id)} <span class="muted">#${r.reply_seq}</span>` },
      { label: '유형', render: (r) => ui.esc(nm('reply_pattern', r.reply_pattern)) },
      { label: '도착(적용)일', key: 'effective_at' },
      { label: '전달', render: (r) => (r.delivered ? `${ui.esc(r.delivered.delivered_at)} <span class="muted">${ui.esc(r.delivered.event_id)}</span>` : `<button data-rec="${ui.esc(r.record_id)}">지금 전달</button>`) },
    ], d.rows, { empty: '모의 회신 행 없음' }), done < d.rows.length)}
    <p class="muted">PLAN-005는 미등록 사례라 회신 행이 없다. 보통은 문제 4 순서표가 날짜에 맞춰 전달한다.</p>
    <p class="p1-mock-msg muted"></p></div>`;
  for (const b of el.querySelectorAll('button[data-rec]')) {
    b.onclick = async () => {
      try { await api.post(`/api/p1/mock/${encodeURIComponent(b.dataset.rec)}/deliver`, {}); await renderMock(el, { api, ui }); }
      catch (err) { el.querySelector('.p1-mock-msg').textContent = `오류: ${err.message}`; }
    };
  }
}

export default { renderPlan, renderMock };
