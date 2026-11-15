// 앱 조립: 저장소·시계·사건·AI·라우터·모듈 로딩·화면 제공.
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT_DIR, RAW_DIR, DEFAULT_DB_PATH, PUBLIC_DIR, problemDir } from './core/paths.mjs';
import { createRawLoader, createProblemDataLoader, toNum } from './core/csv.mjs';
import * as calendar from './core/calendar.mjs';
import { openStore } from './core/db.mjs';
import { createClock } from './core/clock.mjs';
import { createEventBus } from './core/events.mjs';
import { createAiClient } from './core/ai.mjs';
import { createRouter, readJsonBody, sendJson, HttpError } from './core/router.mjs';

const MODULE_IDS = [1, 2, 3, 4];
const PANEL_TITLES = { 1: '문제 1 · 수요 입력', 2: '문제 2 · 공급 판정', 3: '문제 3 · 승인 경로', 4: '문제 4 · 마감·재검토·확정 가능' };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

export async function createApp({
  rootDir = ROOT_DIR, rawDir = RAW_DIR, dbPath = process.env.W01_DB_PATH || DEFAULT_DB_PATH,
  env = process.env, fetchImpl = globalThis.fetch, log = console,
} = {}) {
  const store = openStore(dbPath);
  const clock = createClock(store);
  const events = createEventBus({ store, clock });
  const ai = createAiClient({ env, fetchImpl, events });
  const router = createRouter();
  const raw = createRawLoader(rawDir);
  const problemData = createProblemDataLoader((n) => problemDir(rootDir, n));

  const exposed = new Map();     // 'p1' -> API
  const initHooks = [];          // { owner, fn }
  const resetHooks = [];
  const summaryFns = [];         // { owner, fn(plan_id) }
  const moduleInfo = [];

  // 원본 기안 25건 + 캠페인 제품라인(원본 조인)
  const basePlans = () => {
    const campaigns = new Map(raw.load('02_masil/master/m_campaign_ms.csv').map((c) => [c.campaign_id, c]));
    return raw.load('02_masil/marketing/mkt_budget_plan_ms.csv').map((p) => ({
      plan_id: p.plan_id, campaign_id: p.campaign_id,
      campaign_name: campaigns.get(p.campaign_id)?.campaign_name ?? null,
      product_line: campaigns.get(p.campaign_id)?.product_line ?? null,
      requested_budget_krw: toNum(p.requested_budget_krw), expected_gmv_krw: toNum(p.expected_gmv_krw),
      settlement_date: p.settlement_date, contract_deadline: p.contract_deadline,
      source_type: '원본도출', source_ref: `02_masil/marketing/mkt_budget_plan_ms.csv#${p.plan_id}`,
    }));
  };
  const summariesFor = async (planId) => {
    const out = [];
    for (const { owner, fn } of summaryFns) {
      try { out.push(...[].concat(await fn(planId) ?? []).map((s) => ({ owner, ...s }))); }
      catch (err) { out.push({ owner, label: '요약 오류', value: err.message }); }
    }
    return out;
  };

  function makeCtx(n) {
    const id = `p${n}`;
    return {
      id, problem: n, rootDir, problemDir: problemDir(rootDir, n),
      raw, cal: calendar, toNum,
      data: { load: (file, opts) => problemData.load(n, file, opts), loadFrom: (m, file, opts) => problemData.load(m, file, opts) },
      db: store.db,
      defineTable: (name, ddl) => store.defineTable(id, name, ddl),
      events: {
        emit: (e) => events.emit(e, id), on: (types, fn) => events.on(types, fn, id),
        query: events.query, get: events.get,
      },
      clock: { today: clock.today, onDay: (fn) => clock.onDay(id, fn) },
      ai: {
        status: ai.status, models: ai.models,
        call: (args) => ai.call({ ...args, owner: id }), review: (args) => ai.review({ ...args, owner: id }),
      },
      route: (method, subpath, handler) => router.add(method, `/api/${id}${subpath}`, handler, id),
      httpError: (status, message) => new HttpError(status, message),
      expose: (api) => exposed.set(id, api),
      module: (otherId) => exposed.get(otherId) ?? null,
      plans: basePlans,
      onInit: (fn) => initHooks.push({ owner: id, fn }),
      onReset: (fn) => resetHooks.push({ owner: id, fn }),
      addPlanSummary: (fn) => summaryFns.push({ owner: id, fn }),
      log: (...args) => log.log(`[${id}]`, ...args),
    };
  }

  for (const n of MODULE_IDS) {
    const dir = problemDir(rootDir, n);
    const entry = path.join(dir, 'src', 'index.mjs');
    const info = { id: `p${n}`, title: PANEL_TITLES[n], loaded: false, panel: existsSync(path.join(dir, 'src', 'panel.js')), error: null };
    if (existsSync(entry)) {
      try {
        const mod = await import(pathToFileURL(entry).href);
        if (typeof mod.register !== 'function') throw new Error('register(ctx)를 내보내지 않습니다');
        await mod.register(makeCtx(n));
        info.loaded = true;
      } catch (err) {
        info.error = err.message;
        log.error(`[app] problem${n} 모듈을 붙이지 못했습니다: ${err.message}`);
      }
    }
    moduleInfo.push(info);
  }

  async function runInit() {
    for (const { fn } of initHooks) await fn();
    store.setMeta('initialized', clock.today());
  }
  async function reset() {
    store.resetAll();
    clock.reset();
    for (const { fn } of resetHooks) await fn();
    await runInit();
  }
  if (!store.getMeta('initialized')) {
    clock.reset();
    await runInit();
  }

  // ── 공통 API ──
  router.add('GET', '/api/meta', () => ({
    sim_clock: clock.today(), ai: { status: ai.status(), models: ai.models() },
    modules: moduleInfo, routes: router.list(), event_count: events.query({ limit: 1_000_000 }).length,
  }));
  router.add('GET', '/api/plans', async () => ({
    sim_clock: clock.today(),
    plans: await Promise.all(basePlans().map(async (p) => ({ ...p, summaries: await summariesFor(p.plan_id) }))),
  }));
  router.add('GET', '/api/plans/:plan_id', async ({ params }) => {
    const plan = basePlans().find((p) => p.plan_id === params.plan_id);
    if (!plan) throw new HttpError(404, `기안이 없습니다: ${params.plan_id}`);
    return { plan, summaries: await summariesFor(plan.plan_id), events: events.query({ plan_id: plan.plan_id, order: 'desc', limit: 200 }) };
  });
  router.add('GET', '/api/events', ({ query }) => ({
    events: events.query({
      plan_id: query.get('plan_id') || undefined, event_type: query.get('event_type') || undefined,
      scenario_id: query.get('scenario_id') || undefined, emitted_by: query.get('emitted_by') || undefined,
      order: 'desc', limit: Number(query.get('limit') || 500),
    }),
  }));
  // 사건 기록 화면의 유형 걸러보기: 유형별 건수
  router.add('GET', '/api/events/summary', () => {
    const by_type = {};
    let total = 0;
    for (const e of events.query({ limit: 1_000_000 })) { by_type[e.event_type] = (by_type[e.event_type] ?? 0) + 1; total += 1; }
    return { total, by_type };
  });
  router.add('GET', '/api/clock', () => ({ sim_clock: clock.today() }));
  router.add('POST', '/api/clock/advance', async ({ body }) => clock.advance({ to: body.to, days: body.days }));
  router.add('POST', '/api/reset', async () => { await reset(); return { ok: true, sim_clock: clock.today() }; });

  // ── HTTP 처리 ──
  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('ok');
      }
      if (url.pathname.startsWith('/api/')) {
        const m = router.match(req.method, url.pathname);
        if (!m) throw new HttpError(404, `없는 경로입니다: ${req.method} ${url.pathname}`);
        const body = req.method === 'GET' ? {} : await readJsonBody(req);
        const result = await m.handler({ params: m.params, query: url.searchParams, body, req, res });
        if (!res.writableEnded) sendJson(res, 200, result ?? { ok: true });
        return;
      }
      return serveStatic(url.pathname, res);
    } catch (err) {
      const status = err.status ?? 500;
      if (status >= 500) log.error(`[app] ${req.method} ${url.pathname}: ${err.stack ?? err.message}`);
      if (!res.headersSent) sendJson(res, status, { error: err.message });
    }
  }

  function serveStatic(pathname, res) {
    let file = null;
    const panel = /^\/panels\/p([1-4])\.js$/.exec(pathname);
    if (panel) file = path.join(problemDir(rootDir, Number(panel[1])), 'src', 'panel.js');
    else {
      const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
      const full = path.resolve(PUBLIC_DIR, rel);
      if (full.startsWith(PUBLIC_DIR + path.sep)) file = full;
    }
    if (!file || !existsSync(file)) throw new HttpError(404, `없는 파일입니다: ${pathname}`);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(readFileSync(file));
  }

  let server = null;
  return {
    store, clock, events, ai, router, raw, modules: moduleInfo, reset, handle, basePlans,
    module: (id) => exposed.get(id) ?? null,
    listen(port = Number(env.PORT || 8080), host = '0.0.0.0') {
      server = createServer(handle);
      return new Promise((resolve) => server.listen(port, host, () => resolve(server.address().port)));
    },
    async close() {
      if (server) await new Promise((resolve) => server.close(resolve));
      store.close();
    },
  };
}
