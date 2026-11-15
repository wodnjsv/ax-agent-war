// 사건 저장·조회·구독. 필드는 problem4/공통_접점.md 3.4 `event`.
import { EVENT_TYPES, SOURCE_TYPES, ACTOR_DEPTS } from './registry.mjs';

const JSON_FIELDS = ['source_ref', 'premise_refs', 'payload'];
const SIMULATED_SOURCES = new Set(['사람입력', '모의회신', '가정']);

function rowToEvent(row) {
  if (!row) return null;
  const e = { ...row };
  for (const f of JSON_FIELDS) e[f] = row[f] == null ? null : JSON.parse(row[f]);
  e.is_synthetic = row.is_synthetic === 1;
  e.is_simulation = row.is_simulation === 1;
  return e;
}

export function createEventBus({ store, clock, now = () => new Date().toISOString() }) {
  const { db } = store;
  const handlers = []; // { types:Set|null, fn, owner }
  const queue = [];
  let dispatching = false;
  const errors = [];

  const insert = db.prepare(`INSERT INTO events (event_id, event_type, occurred_at, effective_at, recorded_at, seq,
    plan_id, subject_type, subject_id, actor_dept, actor_role, source_type, is_synthetic, is_simulation,
    source_ref, generation_reason, premise_refs, caused_by, scenario_id, spec_ref, payload, emitted_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const nextSeq = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM events WHERE occurred_at = ?');
  const maxId = db.prepare("SELECT MAX(CAST(substr(event_id, 4) AS INTEGER)) AS n FROM events");

  async function drain() {
    if (dispatching) return;
    dispatching = true;
    try {
      while (queue.length) {
        const event = queue.shift();
        for (const h of handlers) {
          if (h.types && !h.types.has(event.event_type)) continue;
          try {
            await h.fn(event);
          } catch (err) {
            errors.push({ event_id: event.event_id, owner: h.owner, message: err.message });
            console.error(`[events] ${h.owner} 처리 오류 (${event.event_type} ${event.event_id}): ${err.message}`);
          }
        }
      }
    } finally {
      dispatching = false;
    }
  }

  return {
    errors,
    // 사건을 저장하고 구독자에게 알린다. 구독자가 낸 사건은 큐에 쌓여 순서대로 처리된다.
    async emit(input, emittedBy) {
      const e = input ?? {};
      if (!(e.event_type in EVENT_TYPES)) throw new Error(`등록표에 없는 사건입니다: ${e.event_type}`);
      if (!SOURCE_TYPES.includes(e.source_type)) throw new Error(`source_type 값이 아닙니다: ${e.source_type}`);
      const actorDept = e.actor_dept ?? 'SYSTEM';
      if (!ACTOR_DEPTS.includes(actorDept)) throw new Error(`actor_dept 값이 아닙니다: ${actorDept}`);
      const occurred = e.occurred_at ?? clock.today();
      if (occurred === '미상' && !e.effective_at) throw new Error('occurred_at이 미상이면 effective_at이 필요합니다');
      const effective = e.effective_at ?? occurred;
      const isSynthetic = e.is_synthetic ?? false;
      const isSimulation = e.is_simulation ?? (isSynthetic || SIMULATED_SOURCES.has(e.source_type));
      const eventId = `EV-${String((maxId.get().n ?? 0) + 1).padStart(6, '0')}`;
      const row = {
        event_id: eventId, event_type: e.event_type, occurred_at: occurred, effective_at: effective,
        recorded_at: now(), seq: nextSeq.get(occurred).n, plan_id: e.plan_id ?? 'NONE',
        subject_type: e.subject_type ?? null, subject_id: e.subject_id ?? null, actor_dept: actorDept,
        actor_role: e.actor_role ?? null, source_type: e.source_type, is_synthetic: isSynthetic ? 1 : 0,
        is_simulation: isSimulation ? 1 : 0, source_ref: e.source_ref ?? null,
        generation_reason: e.generation_reason ?? null, premise_refs: e.premise_refs ?? null,
        caused_by: e.caused_by ?? null, scenario_id: e.scenario_id ?? 'BASE', spec_ref: e.spec_ref ?? null,
        payload: e.payload ?? null, emitted_by: emittedBy ?? 'core',
      };
      insert.run(...Object.entries(row).map(([k, v]) => (JSON_FIELDS.includes(k) && v != null ? JSON.stringify(v) : v)));
      const event = { ...row, is_synthetic: isSynthetic, is_simulation: isSimulation };
      queue.push(event);
      await drain();
      return event;
    },
    // types: 사건 이름, 이름 배열, 또는 '*'
    on(types, fn, owner = 'core') {
      const set = types === '*' ? null : new Set([].concat(types));
      if (set) for (const t of set) if (!(t in EVENT_TYPES)) throw new Error(`등록표에 없는 사건입니다: ${t}`);
      handlers.push({ types: set, fn, owner });
    },
    get(eventId) {
      return rowToEvent(db.prepare('SELECT * FROM events WHERE event_id = ?').get(eventId));
    },
    // filter: { plan_id, event_type(문자열·배열), subject_id, scenario_id, emitted_by, since(날짜), limit, order:'asc'|'desc' }
    query(filter = {}) {
      const where = [];
      const args = [];
      for (const key of ['plan_id', 'subject_id', 'scenario_id', 'emitted_by']) {
        if (filter[key]) { where.push(`${key} = ?`); args.push(filter[key]); }
      }
      if (filter.event_type) {
        const types = [].concat(filter.event_type);
        where.push(`event_type IN (${types.map(() => '?').join(',')})`);
        args.push(...types);
      }
      if (filter.since) { where.push('occurred_at >= ?'); args.push(filter.since); }
      const order = filter.order === 'desc' ? 'DESC' : 'ASC';
      const sql = `SELECT * FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY occurred_at ${order}, seq ${order}, event_id ${order} LIMIT ?`;
      return db.prepare(sql).all(...args, filter.limit ?? 1000).map(rowToEvent);
    },
  };
}
