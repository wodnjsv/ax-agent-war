// AI 클라이언트. problem4/공통_접점.md 8절.
// OpenRouter chat completions. 키는 환경 변수에서만 읽고 저장하지 않는다. openrouter/auto는 쓰지 않는다.
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODELS = { structure: 'anthropic/claude-opus-5.5', write: 'anthropic/claude-fable-5.2' };
const MODEL_ENV = { structure: 'AI_MODEL_STRUCTURE', write: 'AI_MODEL_WRITE' };

// 구조화 출력은 JSON만 받는다. 모델이 ```json … ``` 코드 블록으로 감싸 보내는 경우만 벗겨 낸다.
export function parseJsonOutput(text) {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(text);
  try {
    return JSON.parse(fenced ? fenced[1] : text);
  } catch (err) {
    throw new Error(`구조화 출력이 JSON이 아닙니다: ${err.message}`);
  }
}

export function createAiClient({ env = process.env, fetchImpl = globalThis.fetch, events }) {
  const modelFor = (taskType) => {
    if (!(taskType in DEFAULT_MODELS)) throw new Error(`ai_task_type 값이 아닙니다: ${taskType}`);
    const model = env[MODEL_ENV[taskType]] || DEFAULT_MODELS[taskType];
    if (model === 'openrouter/auto') throw new Error('openrouter/auto는 쓰지 않습니다(재현 불가)');
    return model;
  };
  const connected = () => Boolean(env.OPENROUTER_API_KEY);

  return {
    status: () => (connected() ? '연결' : '미연결'),
    models: () => ({ structure: modelFor('structure'), write: modelFor('write') }),

    // 반환: { status:'미연결' } 또는 { status:'연결', ai_call_id, model, output, event_id }
    // structure는 JSON 출력을 기대한다. 회신에 없는 값은 null + unclear_reasons로 받는다.
    async call({ owner, ai_task_type, ai_task_name, messages, input_refs = [], plan_id = 'NONE', scenario_id, actor_dept = 'SYSTEM' }) {
      const model = modelFor(ai_task_type);
      if (!connected()) return { status: '미연결', output: null };
      const body = { model, messages };
      if (ai_task_type === 'structure') body.response_format = { type: 'json_object' };
      const res = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`OpenRouter 호출 실패: HTTP ${res.status}`);
      const data = await res.json();
      const usedModel = data.model ?? model;
      const text = data.choices?.[0]?.message?.content ?? '';
      let output = text;
      let nullFields = [];
      let unclearReasons = [];
      if (ai_task_type === 'structure') {
        output = parseJsonOutput(text);
        nullFields = Object.entries(output.fields ?? output).filter(([, v]) => v === null).map(([k]) => k);
        unclearReasons = Array.isArray(output.unclear_reasons) ? output.unclear_reasons : [];
      }
      const aiCallId = `AI-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const event = await events.emit({
        event_type: 'AI_CALL_RECORDED', source_type: '계산', plan_id, scenario_id, actor_dept,
        subject_type: 'ai_call', subject_id: aiCallId,
        payload: {
          ai_call_id: aiCallId, ai_task_type, ai_task_name, model: usedModel, input_refs, output,
          null_fields: nullFields, unclear_reasons: unclearReasons, review_status: '확인 대기', reviewer_role: null,
        },
      }, owner);
      return { status: '연결', ai_call_id: aiCallId, model: usedModel, output, event_id: event.event_id };
    },

    // 담당자 확인: review_result = '확인' | '수정 후 확인' | '거부'
    async review({ owner, ai_call_id, review_result, reviewer_role, edited_fields = [], plan_id = 'NONE' }) {
      if (!['확인', '수정 후 확인', '거부'].includes(review_result)) throw new Error(`review_result 값이 아닙니다: ${review_result}`);
      return events.emit({
        event_type: 'AI_OUTPUT_REVIEWED', source_type: '사람입력', is_synthetic: true, plan_id,
        subject_type: 'ai_call', subject_id: ai_call_id,
        payload: { ai_call_id, review_result, reviewer_role, edited_fields },
      }, owner);
    },
  };
}
