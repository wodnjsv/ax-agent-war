// 가상 시계 sim_clock. 시작 2026-07-01, 뒤로 돌리지 않는다. 영업일 단위로 진행한다.
import { SIM_START } from './registry.mjs';
import { addBusinessDays, businessDaysAfter, parseDate } from './calendar.mjs';

export function createClock(store) {
  const dayHandlers = []; // { owner, fn }

  const today = () => store.getMeta('sim_clock') ?? SIM_START;

  return {
    today,
    // 영업일마다 호출된다(새 날짜가 된 직후). 등록 순서 = 모듈 순서(p1→p4).
    onDay(owner, fn) {
      dayHandlers.push({ owner, fn });
    },
    // maxDays: 한 번에 처리할 영업일 수의 상한. 배포 환경(0.5코어)에서 긴 구간을 한 요청으로 돌리면
    // 상태 확인이 응답하지 못해 앱이 재시작되므로, 화면은 하루씩 나눠 부른다. 생략하면 끝까지 처리한다.
    async advance({ to, days, maxDays } = {}) {
      const from = today();
      const target = to ?? addBusinessDays(from, days ?? 1);
      parseDate(target);
      if (target < from) throw new Error(`시계는 뒤로 돌릴 수 없습니다: ${from} → ${target}`);
      const all = businessDaysAfter(from, target);
      const todo = maxDays > 0 ? all.slice(0, maxDays) : all;
      const processed = [];
      for (const d of todo) {
        store.setMeta('sim_clock', d);
        for (const { fn } of dayHandlers) await fn(d);
        processed.push(d);
        await new Promise((resolve) => setImmediate(resolve)); // 하루 처리 뒤 다른 요청(상태 확인)에 차례를 준다
      }
      const done = todo.length === all.length;
      const reached = done ? target : todo[todo.length - 1];
      store.setMeta('sim_clock', reached);
      return { from, to: reached, processed, target, done };
    },
    reset() {
      store.setMeta('sim_clock', SIM_START);
    },
  };
}
