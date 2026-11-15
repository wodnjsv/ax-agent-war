// 평가자 화면용 사건 설명 카드(describeEvent). 계산·판정은 하지 않고, 저장된 값과 사건을 업무 용어로 풀어 쓴다.
// 카드: { title, actor_kind: '사람'|'AI'|'규칙·계산'|'모의 입력', actor_label, inputs: [{ label, value, source, ref }], rule, result, next }
import { addedQtyEa } from './demand.mjs';

const WEEKLY_SALES = '01_참가자_배포용/04_원본데이터/02_masil/inventory/sku_weekly_sales_ms.csv';
const PATTERN = { on_time: '기한 내', late: '기한 지남', revised: '정정', missing: '미등록' };
const KIND = { initial: '최초 요청', rerequest: '재요청', correction: '정정 요청' };
const FIELD = { uplift_pct: '증가율', sale_start_week: '판매 시작 주', sale_weeks: '판매 주수', sku_overrides: '품목별 증가율', rationale_text: '근거' };
const AI_RESULT = { 확인: '그대로 확인', '수정 후 확인': '고쳐서 확인', 거부: '거부' };

const pct = (v) => (v == null ? '비움' : `${Number(v).toFixed(1)}%`);
const md = (d) => (d ? d.slice(5) : '-');
const period = (start, weeks) => (start ? `${md(start)} 주부터 ${weeks ?? '?'}주` : '비움');
const n = (v) => Number(v).toLocaleString('ko-KR');

export function createDescriber({ events, getVersionRow, findRow, validRow, overridesOf, weeklyOf, skuNames, baselineBySku, skusOf, plansById }) {
  const name = (sku) => skuNames.get(sku) ?? sku;
  const rowOf = (e) => {
    const p = e.payload ?? {};
    if (p.demand_input_id && p.version != null) return getVersionRow(p.demand_input_id, Number(p.version));
    const [id, v] = String(e.subject_id ?? '').split('#');
    return id && v ? getVersionRow(id, Number(v)) : null;
  };
  // 누가 넣은 값인가: 모의 자료(S1) 또는 기본 모의 입력이면 '모의 입력', 화면에서 넣었으면 '사람'
  const altIsMock = (row) => {
    const sel = row?.reply_event_id ? events.get(row.reply_event_id) : null;
    return Boolean(sel && ((sel.source_ref ?? []).length || /모의/.test(sel.generation_reason ?? '')));
  };
  const humanActor = (row, label = '마케팅 기안 담당자') => {
    const mock = row?.origin === 'alternative' ? altIsMock(row) : Boolean(row?.mock_record_id);
    return mock ? { actor_kind: '모의 입력', actor_label: `${label}(모의)` } : { actor_kind: '사람', actor_label: label };
  };
  const valueSource = (row) => (humanActor(row).actor_kind === '모의 입력' ? '모의회신' : '사람입력');
  const valueRef = (row) => (row?.mock_record_id ? `problem1/data/synthetic/s1_demand_reply.csv#${row.mock_record_id}` : row?.reply_event_id ?? null);

  // 추가 수량 계산을 실제 수치로: "색조 벨벳 립 882.5 × 20.0% = 176.5 → 177 EA/주 × 4주 = 708 EA"
  function calcLines(row) {
    const ov = new Map(overridesOf(row.demand_input_id, row.version).map((o) => [o.sku_id, o.override_uplift_pct]));
    const weekly = weeklyOf(row.demand_input_id, row.version);
    let total = 0;
    const lines = skusOf(row.plan_id).map((sku) => {
      const b = baselineBySku.get(sku).baseline_weekly_qty;
      const p = ov.has(sku) ? ov.get(sku) : row.uplift_pct;
      const per = addedQtyEa(b, p);
      const sum = weekly.filter((w) => w.sku_id === sku).reduce((a, w) => a + w.added_qty_ea, 0);
      total += sum;
      const raw = Math.round(b * p) / 100;
      return `${name(sku)} ${n(b)} × ${pct(p)} = ${n(raw)} → ${n(per)} EA/주 × ${row.sale_weeks}주 = ${n(sum)} EA`;
    });
    return { lines, total };
  }
  const baselineInputs = (planId) => skusOf(planId).map((sku) => {
    const b = baselineBySku.get(sku);
    return { label: `기준 수요 · ${name(sku)}`, value: `${n(b.baseline_weekly_qty)} EA/주 (${md(b.window_start)}~${md(b.window_end)} 주 4주 평균)`,
      source: '계산', ref: `${WEEKLY_SALES}#${sku}` };
  });
  const valueInputs = (row) => {
    const src = valueSource(row);
    const ref = valueRef(row);
    return [
      { label: '증가율(라인 공통)', value: pct(row.uplift_pct), source: src, ref },
      { label: '판매 기간', value: period(row.sale_start_week, row.sale_weeks), source: src, ref },
      ...overridesOf(row.demand_input_id, row.version).map((o) => ({ label: `품목별 증가율 · ${name(o.sku_id)}`, value: pct(o.override_uplift_pct), source: src, ref })),
    ];
  };
  const RULE_EA = '추가 수량 = 기준 수요(원본 주간 판매 최근 4주 평균) × 증가율 ÷ 100을 품목·주마다 0.5 올림해 정수로 낸다. 판매 기간 안에서는 매주 같은 증가율이라 짧게 몰리는 캠페인의 정점 주를 낮게 잡을 수 있다.';

  function registered(e, row, revised) {
    const { lines, total } = calcLines(row);
    const by = row.origin === 'alternative' ? '대안 선택' : '마케팅 회신';
    const changed = (e.payload?.changed_fields ?? []).map((f) => FIELD[f] ?? f);
    const prev = revised ? getVersionRow(row.demand_input_id, row.version - 1) : null;
    return {
      title: `${revised ? '수요 입력 정정' : '수요 입력 등록'} v${row.version}: 증가율 ${pct(row.uplift_pct)}, ${period(row.sale_start_week, row.sale_weeks)}`,
      ...humanActor(row),
      inputs: [...valueInputs(row), ...baselineInputs(row.plan_id),
        ...(revised && changed.length ? [{ label: '바뀐 항목', value: changed.join(', '), source: '계산', ref: e.event_id }] : [])],
      rule: `${by} 값을 담당자가 확인해 검증(월요일 시작, 07-06 주 이후, 12-28 주 이내, 기안의 품목만)을 통과했다. ${RULE_EA}`,
      result: `${lines.join('; ')}. 합계 ${n(total)} EA(시뮬레이션). v${row.version}이 유효가 되어 공급 판정에 쓰인다${revised && prev ? `(이전 v${prev.version} 대체)` : ''}.`,
      next: '문제 2가 이 기안과 같은 품목을 쓰는 뒤 순번 기안을 다시 판정하고, 문제 4가 수요 요청을 회신됨으로 닫는다.',
    };
  }

  return function describeEvent(e) {
    if (!e?.event_type) return null;
    const p = e.payload ?? {};
    const plan = plansById.get(e.plan_id);
    switch (e.event_type) {
      case 'BASELINE_DEMAND_SET': {
        const rows = [...baselineBySku.values()];
        return {
          title: `기준 수요 설정: 품목 ${rows.length}개, ${md(p.window_start)}~${md(p.window_end)} 주 평균`,
          actor_kind: '규칙·계산', actor_label: '시스템',
          inputs: rows.map((b) => ({ label: `주간 판매 4주 · ${name(b.sku_id)}`, value: `${n(b.baseline_weekly_qty)} EA/주`, source: '원본', ref: `${WEEKLY_SALES}#${b.sku_id}` })),
          rule: '품목별 최근 4주 주간 판매량의 평균(계산 정의 문서 1.3절 재고 커버의 분모와 같은 정의). 기준일 이후에도 같은 값을 쓴다.',
          result: `${md(p.window_start)}~${md(p.window_end)} 주 평균으로 품목별 기준 수요를 정했다. 캠페인 추가 수량은 모두 이 값 × 증가율로 계산된다.`,
          next: '문제 2가 이 값으로 추가분 0 재고 전개와 잔여 여지를 낸다.',
        };
      }
      case 'INFO_REQUESTED': {
        if (p.request_topic !== 'demand_input') return null;
        return {
          title: `수요 입력 요청(${KIND[p.request_kind] ?? p.request_kind}): ${e.plan_id} → 마케팅`,
          actor_kind: '규칙·계산', actor_label: '시스템(마감 역산)',
          inputs: [
            { label: '확정기한', value: plan?.contract_deadline ?? '-', source: '원본', ref: `mkt_budget_plan_ms.csv#${e.plan_id}` },
            { label: '집행 예정일', value: plan?.settlement_date ?? '-', source: '원본', ref: `mkt_budget_plan_ms.csv#${e.plan_id}` },
            { label: '회신 기한', value: p.request_due_date ?? '-', source: '계산', ref: e.event_id },
          ],
          rule: '기안에는 품목·수량·판매 기간이 없어 마케팅에게 기준 수요 대비 증가율과 판매 기간을 받는다. 회신 기한은 상신 마감 2영업일 전이다.',
          result: `수요 입력 요청${p.request_id ? `(요청 번호 ${p.request_id})` : ''}이 회신 대기가 됐다.`,
          next: '회신이 오면 AI가 구조화하고 담당자가 확인해야 판정에 쓰인다. 기한이 지나도 판매 기간 기본값은 넣지 않는다.',
        };
      }
      case 'INFO_REPLIED': {
        if (e.emitted_by !== 'p1') return null;
        const v = findRow('reply_event_id', e.event_id);
        const mock = (e.source_ref ?? []).some((r) => String(r).includes('s1_demand_reply'));
        return {
          title: `수요 회신 도착(${PATTERN[p.reply_pattern] ?? '화면 입력'}): ${e.plan_id}`,
          ...(mock ? { actor_kind: '모의 입력', actor_label: '마케팅 기안 담당자(모의)' } : { actor_kind: '사람', actor_label: '마케팅 기안 담당자' }),
          inputs: [{ label: '회신 원문', value: p.reply_text ?? '', source: mock ? '모의회신' : '사람입력', ref: (e.source_ref ?? [])[0] ?? e.event_id },
            ...(p.request_id ? [{ label: '응답한 요청', value: p.request_id, source: '계산', ref: e.caused_by }] : [])],
          rule: '회신 원문은 담당자가 확인하기 전까지 판정에 쓰지 않는다.',
          result: v ? `v${v.version}을 확인 대기로 만들었다.` : '확인 대기 버전을 만든다.',
          next: v?.mock_record_id ? 'AI 호출 없음(자동 처리): 모의 자료의 확인된 값으로 바로 확인·등록한다.'
            : v?.ai_status === '구조화됨' || v?.ai_call_id ? 'AI가 원문에서 증가율·판매 기간을 뽑는다.' : 'AI가 연결돼 있지 않으면 담당자가 값을 직접 넣는다.',
        };
      }
      case 'DEMAND_INPUT_STRUCTURED': {
        const r = rowOf(e);
        const ex = p.extracted_fields ?? {};
        const stored = r?.extracted_json ? JSON.parse(r.extracted_json) : {};
        const unclear = stored.unclear_reasons ?? [];
        const ai = r?.ai_call_id ? events.query({ subject_id: r.ai_call_id, event_type: 'AI_CALL_RECORDED', limit: 1 })[0] : null;
        const got = [`증가율 ${pct(ex.uplift_pct)}`, `시작 주 ${ex.sale_start_week ? md(ex.sale_start_week) : '비움'}`, `주수 ${ex.sale_weeks ?? '비움'}`,
          ...(ex.sku_overrides ?? []).map((o) => `${name(o.sku_id)} ${pct(o.override_uplift_pct)}`)];
        const missing = (p.missing_fields ?? []).map((f) => FIELD[f] ?? f);
        return {
          title: `AI 구조화: ${got.slice(0, 3).join(' · ')}`,
          actor_kind: 'AI', actor_label: ai?.payload?.model ?? 'AI(구조화)',
          inputs: [{ label: '회신 원문', value: r?.reply_text ?? '', source: r?.mock_record_id ? '모의회신' : '사람입력', ref: e.caused_by },
            { label: '기안의 품목', value: skusOf(e.plan_id).map(name).join(', '), source: '원본', ref: `plan_sku_map#${e.plan_id}` }],
          rule: '회신에 적힌 값만 옮긴다. 연도가 없으면 가상 기준 연도로 날짜를 만들고, 하나의 주·주수로 정할 수 없을 때만 비운다. 담당자 확인 전 결과는 판정에 쓰지 않는다.',
          result: `뽑은 값: ${got.join(', ')}.${missing.length ? ` 비운 값: ${missing.join(', ')}${unclear.length ? `(사유: ${unclear.join('; ')})` : ''}.` : ' 비운 값 없음.'}`,
          next: '담당자가 값을 확인하거나 고쳐서 등록한다.',
        };
      }
      case 'AI_CALL_RECORDED': {
        if (e.emitted_by !== 'p1' || p.ai_task_name !== 'demand_reply_structure') return null;
        return {
          title: 'AI 호출: 수요 회신 구조화', actor_kind: 'AI', actor_label: p.model ?? 'AI',
          inputs: (p.input_refs ?? []).map((ref) => ({ label: '입력 사건', value: ref, source: '사람입력', ref })),
          rule: '구조화 작업: 정해진 칸에 맞춘 결과만 받는다. 모델 자동 선택은 쓰지 않는다.',
          result: `출력이 확인 대기로 기록됐다${(p.null_fields ?? []).length ? `(비운 칸 ${(p.null_fields ?? []).length}개)` : ''}.`,
          next: '담당자 확인',
        };
      }
      case 'AI_OUTPUT_REVIEWED': {
        if (e.emitted_by !== 'p1') return null;
        const r = p.ai_call_id ? findRow('ai_call_id', p.ai_call_id) : null;
        const edited = (p.edited_fields ?? []).map((f) => FIELD[f] ?? f);
        return {
          title: `담당자 확인: AI 결과를 ${AI_RESULT[p.review_result] ?? p.review_result}${edited.length ? `(${edited.join(', ')} 고침)` : ''}`,
          ...humanActor(r),
          inputs: [{ label: 'AI 출력', value: p.ai_call_id, source: '계산', ref: p.ai_call_id }],
          rule: 'AI가 뽑은 값은 사람이 확인한 뒤에만 반영한다. 고친 칸을 기록한다.',
          result: p.review_result === '거부' ? 'AI 결과를 쓰지 않았다.' : '확인한 값으로 등록 검증을 한다.',
        };
      }
      case 'DEMAND_INPUT_REGISTERED': { const r = rowOf(e); return r ? registered(e, r, false) : null; }
      case 'DEMAND_INPUT_REVISED': { const r = rowOf(e); return r ? registered(e, r, true) : null; }
      case 'DEMAND_INPUT_REJECTED': {
        const r = rowOf(e);
        const byPerson = e.source_type === '사람입력';
        const valid = r ? validRow(r.plan_id) : null;
        return {
          title: `수요 입력 반려 v${p.version}: ${p.reject_reason}`,
          ...(byPerson ? humanActor(r) : { actor_kind: '규칙·계산', actor_label: '시스템(입력 검증)' }),
          inputs: [...(r?.reply_text ? [{ label: '회신 원문', value: r.reply_text, source: valueSource(r), ref: valueRef(r) }] : [])],
          rule: byPerson ? '담당자가 확인에서 거부했다.' : '검증 규칙: 증가율 0 이상(소수 1자리), 시작 주는 월요일이며 07-06 주 이후, 판매 종료 주는 12-28 주 이내, 품목별 증가율은 이 기안의 품목만.',
          result: `v${p.version}을 반려했다. ${valid ? `유효 버전 v${valid.version}이 그대로 판정에 쓰인다.` : '유효 버전이 없어 공급 판정은 판정불가(방향 판단만)로 남는다.'}`,
          next: '문제 4가 같은 마감으로 재요청을 낸다.',
        };
      }
      default:
        return null;
    }
  };

}
