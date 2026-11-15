// 진입점. 실제 앱은 app/main.mjs
import { createApp } from './app/main.mjs';

const app = await createApp();
const port = await app.listen();
console.log(`[app] W01 운영 시스템 http://localhost:${port} (sim_clock ${app.clock.today()}, AI ${app.ai.status()})`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
