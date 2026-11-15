import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../main.mjs';

const quiet = { log() {}, error() {} };

test('모듈이 없어도 앱이 뜨고 /healthz, 기안 25건, 화면을 준다', async () => {
  const emptyRoot = mkdtempSync(path.join(tmpdir(), 'w01-'));
  const app = await createApp({ rootDir: emptyRoot, dbPath: ':memory:', env: {}, log: quiet });
  const port = await app.listen(0, '127.0.0.1');
  try {
    const base = `http://127.0.0.1:${port}`;
    assert.equal(await (await fetch(`${base}/healthz`)).text(), 'ok');
    const { plans } = await (await fetch(`${base}/api/plans`)).json();
    assert.equal(plans.length, 25);
    assert.equal(plans[0].plan_id, 'PLAN-001');
    assert.equal(plans[0].product_line, '기초');
    assert.equal(plans[0].source_type, '원본도출');
    const meta = await (await fetch(`${base}/api/meta`)).json();
    assert.equal(meta.sim_clock, '2026-07-01');
    assert.equal(meta.ai.status, '미연결');
    assert.deepEqual(meta.modules.map((m) => m.loaded), [false, false, false, false]);
    assert.match(await (await fetch(`${base}/`)).text(), /W01 운영 시스템/);
    assert.equal((await fetch(`${base}/api/p9/x`)).status, 404);
    assert.equal((await fetch(`${base}/panels/p1.js`)).status, 404);
    // (E) 사건 기록 화면: 유형별 건수(걸러보기 선택지)
    const sum = await (await fetch(`${base}/api/events/summary`)).json();
    assert.equal(sum.total, Object.values(sum.by_type).reduce((a, b) => a + b, 0));
    assert.equal(typeof sum.by_type, 'object');
  } finally {
    await app.close();
    rmSync(emptyRoot, { recursive: true, force: true });
  }
});

test('모듈 규약: register(ctx), 테이블·경로·초기화·요약·다른 모듈 API·시계', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'w01-'));
  for (const n of [1, 2]) mkdirSync(path.join(root, `problem${n}`, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'problem1', 'src', 'index.mjs'), `
    export function register(ctx) {
      ctx.defineTable('p1_baseline', 'sku_id TEXT PRIMARY KEY, baseline_weekly_qty REAL');
      ctx.onInit(() => ctx.db.prepare('INSERT INTO p1_baseline VALUES (?, ?)').run('SKU-3001', 882.5));
      ctx.expose({ baseline: (sku) => ctx.db.prepare('SELECT baseline_weekly_qty AS q FROM p1_baseline WHERE sku_id = ?').get(sku)?.q ?? null });
      ctx.route('GET', '/baseline/:sku', ({ params }) => ({ q: ctx.module('p1').baseline(params.sku) }));
    }`);
  writeFileSync(path.join(root, 'problem2', 'src', 'index.mjs'), `
    export function register(ctx) {
      ctx.addPlanSummary((planId) => planId === 'PLAN-002' ? { label: '기준 수요', value: ctx.module('p1').baseline('SKU-3001'), source_type: '계산' } : []);
      ctx.events.on('PLAN_RECEIVED', async (e) => { await ctx.events.emit({ event_type: 'SUPPLY_JUDGED', source_type: '계산', plan_id: e.plan_id }); });
      ctx.clock.onDay((d) => ctx.events.emit({ event_type: 'SUPPLY_PROJECTED', source_type: '계산' }));
    }`);
  writeFileSync(path.join(root, 'problem2', 'src', 'panel.js'), 'export default { id: "p2" };');
  const app = await createApp({ rootDir: root, dbPath: ':memory:', env: {}, log: quiet });
  const port = await app.listen(0, '127.0.0.1');
  try {
    const base = `http://127.0.0.1:${port}`;
    assert.deepEqual(await (await fetch(`${base}/api/p1/baseline/SKU-3001`)).json(), { q: 882.5 });
    const { plans } = await (await fetch(`${base}/api/plans`)).json();
    assert.equal(plans.find((p) => p.plan_id === 'PLAN-002').summaries[0].value, 882.5);
    assert.equal(plans.find((p) => p.plan_id === 'PLAN-002').summaries[0].owner, 'p2');
    await app.events.emit({ event_type: 'PLAN_RECEIVED', source_type: '원본도출', plan_id: 'PLAN-002' }, 'p4');
    assert.equal(app.events.query({ event_type: 'SUPPLY_JUDGED' })[0].emitted_by, 'p2');
    const adv = await (await fetch(`${base}/api/clock/advance`, { method: 'POST', body: JSON.stringify({ days: 2 }) })).json();
    assert.equal(adv.to, '2026-07-03');
    assert.equal(app.events.query({ event_type: 'SUPPLY_PROJECTED' }).length, 2);
    assert.equal((await fetch(`${base}/panels/p2.js`)).status, 200);
    await fetch(`${base}/api/reset`, { method: 'POST' });
    assert.equal(app.clock.today(), '2026-07-01');
    assert.equal(app.events.query({}).length, 0);
    assert.equal(app.module('p1').baseline('SKU-3001'), 882.5); // onInit가 다시 돌았다
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('(E) 화면 도구: 코드의 한국어 이름, 자료 구분은 줄바꿈 없는 한 덩어리, 억 단위', async () => {
  const { label, tag, eok, fold, section } = await import('../public/common.js');
  assert.equal(label('GRP_CEO'), '그룹 CEO');
  assert.equal(label('MS_CEO'), 'Masil 대표');
  assert.equal(label('on_schedule'), '예정대로 입고');
  assert.equal(label('PLAN_AUTO_CONFIRMED_BY_DEADLINE'), '기한 경과 확정');
  assert.equal(label('모르는 코드'), '모르는 코드');
  assert.match(tag('계산', false, true), /^<span class="tags">.*시뮬레이션.*<\/span>$/);
  assert.equal(eok(-6186000000), '−61.86억');
  assert.match(fold('재검토', 'x', { count: 3 }), /^<details class="fold"><summary>재검토 <span class="muted">\(3\)<\/span><\/summary>x<\/details>$/);
  assert.match(section('마감', 'x', { tag: '[t]' }), /<h3>마감\[t\]<\/h3>x/);
});

test('화면 조회는 캐시 없이 서버의 최신 상태를 읽는다(초기화·날짜 진행 뒤 옛 값 방지)', async () => {
  const { api } = await import('../public/common.js');
  const orig = globalThis.fetch;
  let init;
  globalThis.fetch = async (_url, i) => { init = i; return { ok: true, json: async () => ({ sim_clock: '2026-07-01' }) }; };
  try {
    await api.get('/api/meta');
    assert.equal(init.cache, 'no-store');
  } finally {
    globalThis.fetch = orig;
  }
});

test('왼쪽 화면 문구 정리: 품목 코드·발주안 번호·승인권자 코드·EA·날짜를 업무 언어로', async () => {
  const { plain } = await import('../public/work.js');
  const names = new Map([['SKU-2002', '기초 수분 크림']]);
  assert.equal(plain('SKU-2002 보충 발주(POD-0005)가 2026-07-31까지 승인·발주돼야 합니다.', names), '기초 수분 크림 보충 발주가 7월 31일까지 승인·발주돼야 합니다.');
  assert.equal(plain('캠페인 추가분 2,358 EA가 모자람 · 발주안 POD-0001 승인', names), '캠페인 추가분 2,358개가 모자람 · 발주안 보충 발주안 승인');
  assert.equal(plain('MS_CEO → GRP_CEO · PLAN-004 · SKU 구성 바꾸기 · 비운 값 sale_weeks'), 'Masil 대표 → 그룹 CEO · 기안 004 · 품목 구성 바꾸기 · 비운 값 판매 주수');
  assert.equal(plain('SKU-9999 가능'), '해당 품목 가능');
  assert.equal(plain('공급 위험을 안고 확정할지(승인권자 위험 수용, 문제 4) 정하세요. 경로(문제 3)'), '공급 위험을 안고 확정할지(승인권자 위험 수용) 정하세요. 경로');
  assert.equal(plain('입고 확정: IN_TRANSIT:SKU-2002(2026-07-06), SPO-0010(2026-08-03)', names), '입고 확정: 운송 중 기초 수분 크림(7월 6일), 기발주분(8월 3일)');
  // 문제 2 v2.0 SCM 보충 계획 입고 행 출처(SCM-BR:<품목>:<차수>)
  assert.equal(plain('SKU-2002 SCM 기준 수요 보충 입고 SCM-BR:SKU-2002:1(2026-09-28), SCM-BR:SKU-2002:2(2026-10-26)', names), '기초 수분 크림 SCM 기준 수요 보충 입고 SCM 보충 1차(9월 28일), SCM 보충 2차(10월 26일)');
  // 대안의 남은 확인에 섞인 시나리오 코드
  assert.equal(plain('Corevia 회신 필요(S-SUP-REPLY). 회신 전에는 가능하다고 가정하지 않음'), 'Corevia 회신 필요. 회신 전에는 가능하다고 가정하지 않음');
  assert.equal(plain('SKU 구성 바꾸기'), '품목 구성 바꾸기');
  assert.equal(plain('마케팅 선택 → 문제 3 재판정. 판매 기간은 바꾸지 않음'), '마케팅 선택 → 승인 경로 재판정. 판매 기간은 바꾸지 않음');
  assert.equal(plain(null), null);
});

test('수요 입력 참고 표: 문제 1 새 필드(headroom_committed, baseline_plan)를 쓴다 — 없어진 예상 입고 포함 여지·정기 보충 시작 주를 쓰지 않는다', async () => {
  const { demandRefRow } = await import('../public/work.js');
  const row = demandRefRow({ sku_name: '기초 수분 크림', first_stockout_week: '2026-08-17',
    headroom_committed: { headroom_state: 'room', min_residual_headroom_qty: 1200 },
    unpreventable_headroom: { on_schedule: { headroom_state: 'room', min_residual_headroom_qty: 9999 } }, covered_from_week: '2026-07-27',
    baseline_plan: { status: 'SCM 확인·Corevia 미확약', plan_qty_total: 24000 } });
  assert.match(row, /1,200개/);
  assert.match(row, /SCM 확인·Corevia 미확약 · 24,000개/);
  assert.match(row, /8월 17일/);
  assert.doesNotMatch(row, /9,999|7월 27일/);
  assert.match(demandRefRow({ sku_name: 'A', headroom_committed: { headroom_state: 'none', min_residual_headroom_qty: null }, baseline_plan: { status: 'SCM 미확인', plan_qty_total: 0 } }), /제한 없음.*SCM 미확인<\/td>/);
  assert.match(demandRefRow({ sku_name: 'B', headroom_committed: null, baseline_plan: null }), /<td>-<\/td><td>없음<\/td><td>-<\/td>/);
});

test('승인 요청 초안 확인 상태: 양식 초안(AI 미연결)은 화면에서 이대로 사용을 누르면 확인, AI 초안은 문제 3 확인 기록으로', async () => {
  const { draftConfirmed } = await import('../public/work.js');
  const seen = new Set();
  const form = { draft_id: 'DR-1', mode: '양식', review_status: '해당 없음', usable: true };
  assert.equal(draftConfirmed(form, seen), false); // 누르기 전에는 확인 전(올리기 잠김)
  seen.add('DR-1');
  assert.equal(draftConfirmed(form, seen), true); // 문제 3은 양식 초안의 단순 확인을 받지 않으므로 화면이 기억한다
  assert.equal(draftConfirmed({ ...form, review_status: '수정 후 확인' }, new Set()), true);
  const ai = { draft_id: 'DR-2', mode: 'AI', review_status: '확인 대기', usable: false };
  assert.equal(draftConfirmed(ai, new Set(['DR-2'])), false); // AI 초안은 화면 기억으로 확인되지 않는다
  assert.equal(draftConfirmed({ ...ai, review_status: '확인', usable: true }), true);
  assert.equal(draftConfirmed(null), false);
});

test('접속 비밀번호: APP_PASSWORD가 있으면 로그인 전에는 화면·API를 주지 않는다', async () => {
  const emptyRoot = mkdtempSync(path.join(tmpdir(), 'w01-'));
  const app = await createApp({ rootDir: emptyRoot, dbPath: ':memory:', env: { APP_PASSWORD: 'test-pw' }, log: quiet });
  const port = await app.listen(0, '127.0.0.1');
  try {
    const base = `http://127.0.0.1:${port}`;
    const login = (password) => fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
    assert.equal(await (await fetch(`${base}/healthz`)).text(), 'ok'); // 상태 확인은 막지 않는다
    assert.match(await (await fetch(`${base}/`)).text(), /비밀번호/);
    assert.equal((await fetch(`${base}/api/plans`)).status, 401);
    assert.equal((await fetch(`${base}/app.js`)).status, 401);
    assert.equal((await login('wrong')).status, 401);
    assert.equal((await login()).status, 401);
    const ok = await login('test-pw');
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get('set-cookie').split(';')[0];
    assert.ok(!cookie.includes('test-pw'));
    assert.equal((await fetch(`${base}/api/plans`, { headers: { cookie } })).status, 200);
    assert.match(await (await fetch(`${base}/`, { headers: { cookie } })).text(), /W01 운영 시스템<\/title>/);
    assert.equal((await fetch(`${base}/api/plans`, { headers: { cookie: 'w01_auth=0000' } })).status, 401);
  } finally {
    await app.close();
    rmSync(emptyRoot, { recursive: true, force: true });
  }
});
