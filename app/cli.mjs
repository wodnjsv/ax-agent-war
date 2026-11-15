// 사용: node app/cli.mjs reset   — 실행 기록(var/w01.sqlite)을 비우고 07-01부터 다시 시작
import { createApp } from './main.mjs';

const [command] = process.argv.slice(2);
if (command !== 'reset') {
  console.error('사용: node app/cli.mjs reset');
  process.exit(1);
}
const app = await createApp();
await app.reset();
console.log(`[app] 초기화 완료. sim_clock ${app.clock.today()}, 사건 ${app.events.query({ limit: 1_000_000 }).length}건`);
await app.close();
