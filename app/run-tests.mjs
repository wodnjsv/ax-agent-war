// npm test: app/test 와 problem*/test 의 *.test.mjs 를 node --test 로 모두 돌린다.
import { readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { ROOT_DIR } from './core/paths.mjs';

const dirs = [path.join(ROOT_DIR, 'app', 'test'), ...[1, 2, 3, 4].map((n) => path.join(ROOT_DIR, `problem${n}`, 'test'))];
const files = dirs.filter(existsSync).flatMap((d) =>
  readdirSync(d, { recursive: true }).filter((f) => f.endsWith('.test.mjs')).map((f) => path.join(d, f)));

if (files.length === 0) {
  console.error('테스트 파일이 없습니다');
  process.exit(1);
}
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', env: { ...process.env, W01_DB_PATH: ':memory:' } });
process.exit(result.status ?? 1);
