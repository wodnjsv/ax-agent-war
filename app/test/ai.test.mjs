import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../core/db.mjs';
import { createClock } from '../core/clock.mjs';
import { createEventBus } from '../core/events.mjs';
import { createAiClient } from '../core/ai.mjs';

function setup(env, fetchImpl) {
  const store = openStore(':memory:');
  const clock = createClock(store);
  const events = createEventBus({ store, clock });
  return { events, ai: createAiClient({ env, fetchImpl, events }) };
}

test('키가 없으면 AI 미연결: 호출 기록을 남기지 않는다', async () => {
  const { events, ai } = setup({}, () => { throw new Error('호출되면 안 됨'); });
  assert.equal(ai.status(), '미연결');
  const r = await ai.call({ owner: 'p1', ai_task_type: 'structure', ai_task_name: 'demand_reply_structure', messages: [] });
  assert.equal(r.status, '미연결');
  assert.equal(events.query({}).length, 0);
});

test('모델 고정: 기본값, 환경 변수 변경, openrouter/auto 금지', () => {
  assert.deepEqual(setup({}).ai.models(), { structure: 'anthropic/claude-opus-5.5', write: 'anthropic/claude-fable-5.2' });
  assert.equal(setup({ AI_MODEL_WRITE: 'x/y' }).ai.models().write, 'x/y');
  assert.throws(() => setup({ AI_MODEL_STRUCTURE: 'openrouter/auto' }).ai.models());
});

test('구조화 호출: AI_CALL_RECORDED에 모델·작업·입력 참조·출력·null 필드, 확인은 AI_OUTPUT_REVIEWED', async () => {
  let sent;
  const fetchImpl = async (url, init) => {
    sent = { url, init, body: JSON.parse(init.body) };
    return { ok: true, json: async () => ({ model: 'anthropic/claude-opus-5.5', choices: [{ message: { content: JSON.stringify({ uplift_pct: 30, sale_weeks: null, unclear_reasons: ['판매 주수 언급 없음'] }) } }] }) };
  };
  const { events, ai } = setup({ OPENROUTER_API_KEY: 'test-key' }, fetchImpl);
  const r = await ai.call({ owner: 'p1', ai_task_type: 'structure', ai_task_name: 'demand_reply_structure', messages: [{ role: 'user', content: '...' }], input_refs: ['EV-000009'], plan_id: 'PLAN-002' });
  assert.equal(sent.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(sent.body.model, 'anthropic/claude-opus-5.5');
  assert.equal(sent.init.headers.Authorization, 'Bearer test-key');
  const [rec] = events.query({ event_type: 'AI_CALL_RECORDED' });
  assert.equal(rec.emitted_by, 'p1');
  assert.equal(rec.payload.ai_call_id, r.ai_call_id);
  assert.deepEqual(rec.payload.null_fields, ['sale_weeks']);
  assert.deepEqual(rec.payload.input_refs, ['EV-000009']);
  assert.equal(rec.payload.review_status, '확인 대기');
  assert.equal(JSON.stringify(rec).includes('test-key'), false);
  await ai.review({ owner: 'p1', ai_call_id: r.ai_call_id, review_result: '확인', reviewer_role: 'MKT-LINE-OWNER', plan_id: 'PLAN-002' });
  assert.equal(events.query({ event_type: 'AI_OUTPUT_REVIEWED' })[0].payload.review_result, '확인');
});

test('구조화 출력: ```json 코드 블록을 벗겨 읽고, JSON이 아니면 오류', async () => {
  const { parseJsonOutput } = await import('../core/ai.mjs');
  assert.deepEqual(parseJsonOutput('```json\n{"uplift_pct": 25, "sale_weeks": null}\n```'), { uplift_pct: 25, sale_weeks: null });
  assert.deepEqual(parseJsonOutput('{"a":1}'), { a: 1 });
  assert.throws(() => parseJsonOutput('증가율 25%'), /JSON이 아닙니다/);
});
