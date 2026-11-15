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
    async advance({ to, days } = {}) {
      const from = today();
      const target = to ?? addBusinessDays(from, days ?? 1);
      parseDate(target);
      if (target < from) throw new Error(`시계는 뒤로 돌릴 수 없습니다: ${from} → ${target}`);
      const processed = [];
      for (const d of businessDaysAfter(from, target)) {
        store.setMeta('sim_clock', d);
        for (const { fn } of dayHandlers) await fn(d);
        processed.push(d);
      }
      store.setMeta('sim_clock', target);
      return { from, to: target, processed };
    },
    reset() {
      store.setMeta('sim_clock', SIM_START);
    },
  };
}
