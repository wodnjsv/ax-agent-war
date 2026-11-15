import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePipeCsv, toNum, createRawLoader } from '../core/csv.mjs';
import { addBusinessDays, businessDaysBetween, weekStart, isBusinessDay } from '../core/calendar.mjs';
import { RAW_DIR } from '../core/paths.mjs';
import { openStore } from '../core/db.mjs';
import { createClock } from '../core/clock.mjs';
import { createEventBus } from '../core/events.mjs';

test('파이프 CSV: 값은 문자열, NONE은 0으로 바꾸지 않는다', () => {
  const rows = parsePipeCsv('a|b\n1|NONE\n');
  assert.deepEqual(rows, [{ a: '1', b: 'NONE' }]);
  assert.equal(toNum('NONE'), null);
  assert.equal(toNum('12'), 12);
  assert.throws(() => parsePipeCsv('a|b\n1\n'));
});

test('원본 기안 25건, 요청 총액 180,803,272원', () => {
  const raw = createRawLoader(RAW_DIR);
  const plans = raw.load('02_masil/marketing/mkt_budget_plan_ms.csv');
  assert.equal(plans.length, 25);
  assert.equal(plans.reduce((s, p) => s + toNum(p.requested_budget_krw), 0), 180803272);
  assert.throws(() => raw.load('../../package.json'));
  assert.throws(() => { plans[0].plan_id = 'X'; }); // 읽기 전용
});

test('영업일: 07-17 기준 마감 역산 예시(공통_접점 3.4)', () => {
  assert.equal(addBusinessDays('2026-07-17', -1), '2026-07-16');
  assert.equal(addBusinessDays('2026-07-16', -5), '2026-07-09');
  assert.equal(addBusinessDays('2026-07-09', 2), '2026-07-13');
  assert.equal(businessDaysBetween('2026-07-01', '2026-07-17'), 12);
  assert.equal(weekStart('2026-06-30'), '2026-06-29');
  assert.equal(isBusinessDay('2026-07-18'), false);
});

function makeBus() {
  const store = openStore(':memory:');
  const clock = createClock(store);
  return { store, clock, events: createEventBus({ store, clock }) };
}

test('사건: 등록표 밖 이름과 잘못된 source_type은 거부', async () => {
  const { events } = makeBus();
  await assert.rejects(events.emit({ event_type: 'NOPE', source_type: '계산' }));
  await assert.rejects(events.emit({ event_type: 'PLAN_RECEIVED', source_type: '원본' }));
  await assert.rejects(events.emit({ event_type: 'PLAN_RECEIVED', source_type: '원본도출', occurred_at: '미상' }));
});

test('사건: 저장·기본값·seq·구독 연쇄·조회', async () => {
  const { events } = makeBus();
  const seen = [];
  events.on('DEMAND_INPUT_REGISTERED', async (e) => {
    seen.push(e.event_id);
    await events.emit({ event_type: 'REVIEW_OPENED', source_type: '계산', plan_id: e.plan_id, caused_by: e.event_id }, 'p4');
  }, 'p4');
  const a = await events.emit({ event_type: 'DEMAND_INPUT_REGISTERED', source_type: '사람입력', is_synthetic: true, plan_id: 'PLAN-002', payload: { version: 1 } }, 'p1');
  assert.equal(a.event_id, 'EV-000001');
  assert.equal(a.occurred_at, '2026-07-01');
  assert.equal(a.is_simulation, true);
  assert.deepEqual(seen, ['EV-000001']);
  const list = events.query({ plan_id: 'PLAN-002' });
  assert.deepEqual(list.map((e) => [e.event_type, e.seq]), [['DEMAND_INPUT_REGISTERED', 1], ['REVIEW_OPENED', 2]]);
  assert.equal(list[1].caused_by, 'EV-000001');
  assert.equal(list[1].is_simulation, false);
  assert.deepEqual(events.get('EV-000001').payload, { version: 1 });
});

test('시계: 영업일마다 onDay, 뒤로 돌리지 않음', async () => {
  const { clock } = makeBus();
  const days = [];
  clock.onDay('p4', (d) => days.push(d));
  const r = await clock.advance({ to: '2026-07-07' });
  assert.deepEqual(r.processed, ['2026-07-02', '2026-07-03', '2026-07-06', '2026-07-07']);
  assert.deepEqual(days, r.processed);
  assert.equal(clock.today(), '2026-07-07');
  await assert.rejects(clock.advance({ to: '2026-07-06' }));
  await clock.advance({ days: 1 });
  assert.equal(clock.today(), '2026-07-08');
});

test('저장소: 모듈 테이블은 접두어 필수, 초기화는 행만 지운다', () => {
  const { store } = makeBus();
  assert.throws(() => store.defineTable('p2', 'p1_x', 'a TEXT'));
  store.defineTable('p2', 'p2_x', 'a TEXT');
  store.db.prepare('INSERT INTO p2_x VALUES (?)').run('v');
  store.resetAll();
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM p2_x').get().n, 0);
});
