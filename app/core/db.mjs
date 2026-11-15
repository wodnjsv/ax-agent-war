// SQLite 저장소. 사건 테이블(공통 필드)과 모듈 테이블 등록, 전체 초기화.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const CORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS core_meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  effective_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  seq INTEGER NOT NULL,
  plan_id TEXT NOT NULL DEFAULT 'NONE',
  subject_type TEXT,
  subject_id TEXT,
  actor_dept TEXT NOT NULL,
  actor_role TEXT,
  source_type TEXT NOT NULL,
  is_synthetic INTEGER NOT NULL,
  is_simulation INTEGER NOT NULL,
  source_ref TEXT,
  generation_reason TEXT,
  premise_refs TEXT,
  caused_by TEXT,
  scenario_id TEXT NOT NULL DEFAULT 'BASE',
  spec_ref TEXT,
  payload TEXT,
  emitted_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_plan ON events(plan_id);
CREATE INDEX IF NOT EXISTS events_type ON events(event_type);
CREATE INDEX IF NOT EXISTS events_time ON events(occurred_at, seq);
`;

export function openStore(dbPath) {
  if (dbPath !== ':memory:') mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  if (dbPath !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec(CORE_SCHEMA);
  const moduleTables = new Map(); // name -> owner

  return {
    db,
    getMeta(key) {
      return db.prepare('SELECT value FROM core_meta WHERE key = ?').get(key)?.value ?? null;
    },
    setMeta(key, value) {
      db.prepare('INSERT INTO core_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
    },
    // 모듈 테이블 등록. 이름은 '<모듈id>_'로 시작해야 한다(예: p1_demand_input).
    defineTable(owner, name, columnsDdl) {
      if (!/^[a-z0-9_]+$/.test(name) || !name.startsWith(`${owner}_`)) {
        throw new Error(`테이블 이름은 '${owner}_'로 시작하는 소문자 스네이크여야 합니다: ${name}`);
      }
      db.exec(`CREATE TABLE IF NOT EXISTS ${name} (${columnsDdl})`);
      moduleTables.set(name, owner);
    },
    tables: () => [...moduleTables.keys()],
    // 전체 초기화: 사건, 메타, 모듈 테이블의 행을 모두 지운다(스키마는 유지).
    resetAll() {
      db.exec('BEGIN');
      try {
        for (const name of moduleTables.keys()) db.exec(`DELETE FROM ${name}`);
        db.exec('DELETE FROM events; DELETE FROM core_meta;');
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    close: () => db.close(),
  };
}
