import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parsePipeCsv, toNum, createRawLoader } from '../../app/core/csv.mjs';
import { RAW_DIR, ROOT_DIR } from '../../app/core/paths.mjs';
import * as cal from '../../app/core/calendar.mjs';

const load = (f) => parsePipeCsv(readFileSync(path.join(ROOT_DIR, 'problem4', 'data', f), 'utf8'));
const loadFrom2 = (f) => parsePipeCsv(readFileSync(path.join(ROOT_DIR, 'problem2', 'data', f), 'utf8'));
const FILES = ['s4_01_deadline_offsets.csv', 's4_02_warning_rules.csv', 's4_06_group_allocation.csv', 's4_08_approval_replies.csv', 's4_09_mock_schedule.csv', 's4_10_po_cash_floor.csv', 'd4_open_issues.csv'];
const META = ['record_id', 'source_ref', 'effective_at', 'source_type', 'is_synthetic', 'generation_reason'];
const SOURCE_TYPES = ['원본도출', '계산', '사람입력', '모의회신', '가정'];

test('문제 4 자료: 행마다 추가 행 필수 항목(A05 §6)과 자료 구분', () => {
  for (const f of FILES) {
    const rows = load(f);
    assert.ok(rows.length > 0, f);
    for (const r of rows) {
      for (const k of META) assert.ok(r[k] !== undefined && r[k] !== '', `${f} ${r.record_id} ${k}`);
      assert.ok(SOURCE_TYPES.includes(r.source_type), `${f} ${r.source_type}`);
      assert.ok(['true', 'false'].includes(r.is_synthetic));
    }
  }
});

test('원본 수치: 기안 25건, 확정기한별 금액, settlement 기준일 12건', () => {
  const plans = createRawLoader(RAW_DIR).load('02_masil/marketing/mkt_budget_plan_ms.csv');
  assert.equal(plans.length, 25);
  const sum = (d) => plans.filter((p) => p.contract_deadline === d).reduce((s, p) => s + toNum(p.requested_budget_krw), 0);
  assert.equal(sum('2026-07-17'), 70902290);
  assert.equal(sum('2026-08-14'), 80734739);
  assert.equal(sum('2026-09-11'), 29166243);
  const settlementFirst = plans.filter((p) => p.settlement_date < p.contract_deadline).map((p) => p.plan_id);
  assert.deepEqual(settlementFirst, ['PLAN-007', 'PLAN-008', 'PLAN-009', 'PLAN-014', 'PLAN-015', 'PLAN-016', 'PLAN-018', 'PLAN-021', 'PLAN-022', 'PLAN-023', 'PLAN-024', 'PLAN-025']);
  const anchors = plans.map((p) => (p.settlement_date < p.contract_deadline ? p.settlement_date : p.contract_deadline)).sort();
  assert.equal(anchors[0], '2026-07-17');
});

test('회의록 미결 3건은 원본 행의 문장을 그대로 인용한다', () => {
  const lines = createRawLoader(RAW_DIR).text('00_common/mkt_meeting_notes_ms.md').split('\n');
  for (const oi of load('d4_open_issues.csv')) {
    assert.ok(lines[Number(oi.source_line) - 1].includes(oi.quote), `${oi.issue_id} ${oi.source_line}행`);
  }
});

test('운영 가정값과 사건 순서표 날짜(사용자 결정 U11, 조정자 K6)', () => {
  const off = Object.fromEntries(load('s4_01_deadline_offsets.csv').map((r) => [r.param, Number(r.value_bd)]));
  assert.equal(off.demand_input_due_offset_bd, -2);
  assert.equal(off.judgment_due_offset_bd, -1);
  const sched = Object.fromEntries(load('s4_09_mock_schedule.csv').map((r) => [r.mock_id, r]));
  assert.equal(sched.M03.sim_date, '2026-07-07');
  assert.equal(sched.M05.sim_date, '2026-07-10');
  assert.equal(sched.M05.scenario_id, 'S-AR-DELAY');
  assert.equal(sched.M07.sim_date, '2026-07-13');
  // 문제 2 v2.1: 07-13 기초 입고 지연 행은 Corevia 원료 지연 정정 회신으로 대체됐다. 기발주 회신은 날짜 고정 행(문제 2가 그날 묶어 반영)
  assert.equal(sched.M07.action, 'coreviaPoReply');
  assert.deepEqual(JSON.parse(sched.M07.params).record_ids, ['S2-CVC-SPO-0005-2', 'S2-CVC-SPO-0006-2', 'S2-CVC-SPO-0007-2']);
  assert.deepEqual(['M21', 'M22', 'M23'].map((k) => [sched[k].sim_date, sched[k].action]),
    [['2026-07-08', 'coreviaPoReply'], ['2026-07-15', 'coreviaPoReply'], ['2026-08-06', 'coreviaPoReply']]);
  // 순서표의 기발주 회신 record_id는 모두 문제 2 자료에 있다
  const cvc = new Set(loadFrom2('s2_corevia_commitment.csv').map((r) => r.record_id));
  for (const k of ['M07', 'M21', 'M22', 'M23', 'M26']) for (const id of JSON.parse(sched[k].params).record_ids) assert.ok(cvc.has(id), id);
  // 문제 2 v2.2(L2·L7)·SCM 후속 회신: 원료 지연 정정(SPO-0010, 07-17), SCM 보충 후속 회신(08-07), 입고 처리(동적 행)
  assert.deepEqual([sched.M26.sim_date, sched.M26.action], ['2026-07-17', 'coreviaPoReply']);
  assert.deepEqual([sched.M24.sim_date, sched.M24.action], ['2026-08-07', 'applyBaselinePlan']);
  assert.ok(loadFrom2('s2_scm_replenishment.csv').some((r) => r.occurred_at === '2026-08-07'));
  assert.deepEqual([sched.M25.sim_date, sched.M25.action, sched.M25.source_type], ['@arrivals', 'processArrivals', '사람입력']);
  // 문제 3 재설계(L5): 회수일 지연은 MAR-0004·0005 각 14일
  assert.match(sched.M05.description, /MAR-0004·0005를 각 14일/);
  assert.equal(sched.M08.sim_date, '2026-07-13');
  assert.equal(sched.M11.sim_date, '2026-08-05');
  // (F)-나: 쓰이지 않던 PLAN-001 보충 발주 선택 행(M09)은 지웠다. 보충 발주안은 문제 2가 판정과 함께 SKU 단위로 만든다
  assert.equal(sched.M09, undefined);
  for (const r of Object.values(sched)) if (/^\d/.test(r.sim_date)) assert.ok(cal.isBusinessDay(r.sim_date), r.mock_id);
});

test('승인 회신 모의 자료: 거절·조건부 포함, 대체된 상신은 2차(재상신)로만', () => {
  const rows = load('s4_08_approval_replies.csv');
  const by = (t, r) => rows.find((x) => x.target === t && x.round === String(r));
  assert.equal(by('PLAN-003', 1).decision, '거절');
  assert.equal(by('PLAN-003', 2).decision, '승인');
  assert.equal(by('PLAN-005', 1).decision, '조건부');
  assert.equal(JSON.parse(by('PLAN-005', 1).conditions)[0].condition_type, '수요·공급 확인 후');
  assert.equal(by('PLAN-004', 2).scenario_id, 'S-AR-DELAY');
  assert.equal(rows.some((x) => x.target === 'PLAN-004' && x.round === '1'), false);
  assert.ok(rows.find((x) => x.target === 'DEFAULT'));
  // 발주안 회신은 현금 규칙 행(S4-08-97)으로만 정한다. 쓰이지 않던 PO:PLAN-001 행(S4-08-07)은 지웠다
  assert.equal(rows.some((x) => x.target.startsWith('PO:')), false);
  assert.equal(rows.find((x) => x.target === 'PO_CASH_RULE').record_id, 'S4-08-97');
  assert.deepEqual(rows.map((x) => x.record_id), ['S4-08-01', 'S4-08-02', 'S4-08-03', 'S4-08-04', 'S4-08-05', 'S4-08-06', 'S4-08-97', 'S4-08-98', 'S4-08-99', 'S4-08-10', 'S4-08-12']);
  // 공급 위험 수용은 지정 사례(round=RISK)에만 둔다(사용자 요청 2026-11-15 다)
  // 조정자 지시 2026-11-15 (가): 종전 지정 PLAN-021·019는 새 자료에서 확정기한 전 가능이 되어, 확정기한까지 조건부로 남는 PLAN-011로 다시 정했다
  assert.deepEqual(rows.filter((x) => x.round === 'RISK').map((x) => [x.target, x.scenario_id, x.decision]), [['PLAN-011', 'BASE', '승인'], ['PLAN-011', 'S-CEO-FLOOR', '미수용']]);
  for (const r of rows.filter((x) => x.round === 'RISK' && x.decision === '승인')) assert.equal(JSON.parse(r.conditions)[0].acceptance_type, '공급 위험 수용');
  // 조정자 마지막 조정: S-CEO-FLOOR는 그룹 CEO가 보수적이라 위험 수용 회신이 없다(가정). 시나리오 구분과 생성 이유를 남긴다
  const floor = rows.find((x) => x.record_id === 'S4-08-12');
  assert.equal(floor.source_type, '가정');
  assert.match(floor.generation_reason, /위험 수용 회신이 오지 않는다.*철회.*발주 전달 전 발주안은 취소/);
});

test('발주안 최저 잔액 기준(S4-10): 기본 0원, 그룹 CEO 조건 시나리오 15억(가정, 값은 자료에서 바꾼다)', () => {
  const rows = Object.fromEntries(load('s4_10_po_cash_floor.csv').map((r) => [r.scenario_id, r]));
  assert.equal(Number(rows.BASE.floor_krw), 0);
  assert.equal(rows.BASE.approver, '*');
  assert.equal(Number(rows['S-CEO-FLOOR'].floor_krw), 1_500_000_000);
  assert.match(rows['S-CEO-FLOOR'].generation_reason, /값 변경 10억→15억.*11\.81억/); // 바꾼 이유를 생성 이유에 남긴다
  assert.equal(rows['S-CEO-FLOOR'].approver, 'GRP_CEO');
  for (const r of Object.values(rows)) { assert.equal(r.source_type, '가정'); assert.equal(r.is_synthetic, 'true'); }
  assert.match(rows['S-CEO-FLOOR'].generation_reason, /가정한 불리한 회신 시나리오/);
});
