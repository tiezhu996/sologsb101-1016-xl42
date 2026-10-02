/* 占用引擎规则验证（Node 直接执行，esbuild 即时编译） */
import { strict as assert } from 'node:assert';
import type { Pond } from '../src/types/pond';
import type { Gate } from '../src/types/gate';
import type { Observation } from '../src/types/observation';
import type { Occupancy } from '../src/types/occupancy';
import type { Schedule } from '../src/types/schedule';
import { reconcileOccupancies, routeDemands, enumerateRoutes, defaultRoute } from '../src/utils/occupancy';

const NOW = '2026-10-02T00:00:00.000Z';
const TODAY = '2026-10-02';
const stampNow = () => NOW;

function pond(id: string, areaM2: number, depthCm: number): Pond {
  return {
    id, code: id, seriesName: 's', areaM2, depthCm, stage: '钠盐', status: '在用',
    createdAt: NOW, updatedAt: NOW, revision: 3,
  };
}
function gate(id: string, fromPondId: string, toPondId: string, openingPct: number): Gate {
  return {
    id, fromPondId, toPondId, openingPct, widthCm: 100,
    state: openingPct <= 0 ? '关闭' : '半开', note: '', createdAt: NOW, updatedAt: NOW, revision: 3,
  };
}
function obs(pondId: string, levelCm: number, date = '2026-10-01'): Observation {
  return {
    id: `o-${pondId}`, pondId, date, densityGcm3: 1.1, tempC: 25, levelCm, windLevel: 2, evapMm: 5,
    createdAt: NOW, updatedAt: NOW, revision: 3,
  };
}
function schedule(partial: Partial<Schedule> & { id: string; pondId: string }): Schedule {
  return {
    ...partial,
    planDate: partial.planDate ?? TODAY,
    targetDensity: partial.targetDensity ?? 1.1,
    volumeM3: partial.volumeM3 ?? 100,
    operator: partial.operator ?? 't',
    state: partial.state ?? '已排',
    orderIndex: partial.orderIndex ?? 1,
    expired: partial.expired ?? false,
    routePondIds: partial.routePondIds ?? [partial.pondId],
    createdAt: partial.createdAt ?? NOW,
    updatedAt: partial.updatedAt ?? NOW,
    revision: 3,
  };
}

// 场景：A(1000㎡×50cm=500m³, 水位40→存量400→可用100) ->闸50%-> B(1000×60=600, 水位0→可用600)
//                        B ->闸0(关闭)-> C；D 与 A 无连接
const ponds = [pond('A', 1000, 50), pond('B', 1000, 60), pond('C', 1000, 40), pond('D', 1000, 40)];
const gates = [gate('g-ab', 'A', 'B', 50), gate('g-bc', 'B', 'C', 0)];
const observations = [obs('A', 40), obs('B', 0)];

// ---------- 1. 路径折减 ----------
{
  const s = schedule({ id: 's1', pondId: 'A', routePondIds: ['A', 'B', 'C'], volumeM3: 1000 });
  const demands = routeDemands(s, gates);
  assert.equal(demands.length, 2, '断流处与之前各一跳');
  assert.equal(demands[0].pondId, 'B');
  assert.equal(demands[0].volumeM3, 500, 'B 到达量 = 1000 × 50%');
  assert.equal(demands[0].blocked, false);
  assert.equal(demands[1].pondId, 'C');
  assert.equal(demands[1].volumeM3, 500, '断流处按上一跳到达量全额挂账');
  assert.equal(demands[1].blocked, true);
  console.log('✓ 路径折减与断流');
}

// ---------- 2. 容量足够 → 拿到占用；容量不足 → 排队 ----------
{
  // 计划 200 m³ → B 到 100 m³（可用 600）→ 可批
  const ok = schedule({ id: 'ok', pondId: 'A', routePondIds: ['A', 'B'], volumeM3: 200, createdAt: '2026-10-01T00:00:00Z' });
  // 计划 2000 m³ → B 到 1000 m³（可用 600），B 先被 ok 占用 100 → 剩 500 → 不足，排队
  const fail = schedule({ id: 'fail', pondId: 'A', routePondIds: ['A', 'B'], volumeM3: 2000, createdAt: '2026-10-02T00:00:00Z' });
  const result = reconcileOccupancies({ schedules: [ok, fail], ponds, gates, observations, occupancies: [], today: TODAY, nowIso: stampNow });
  const okRows = result.occupancies.filter((r) => r.scheduleId === 'ok');
  const failRows = result.occupancies.filter((r) => r.scheduleId === 'fail');
  assert.equal(okRows.length, 1);
  assert.equal(okRows[0].granted, true);
  assert.equal(failRows.length, 1);
  assert.equal(failRows[0].granted, false);
  assert.equal(failRows[0].reason, '容量不足');
  assert.ok(failRows[0].shortfallM3 > 0);
  assert.equal(result.grantedCount, 1);
  assert.equal(result.queuedCount, 1);
  const accB = result.pondAccounts.find((a) => a.pondId === 'B')!;
  assert.equal(accB.occupiedM3, 100);
  assert.equal(accB.queuedM3, 1000);
  assert.ok(accB.shortfallM3 >= 500 - 1e-6, '缺口 = 1000 申请 − 500 剩余');
  assert.equal(result.totals.queuedM3, 1000);
  console.log('✓ 容量预占成功 / 不足排队 + 汇总');
}

// ---------- 3. 排队优先级：状态优先于提交顺序，同状态看提交 ----------
{
  // 两条都申请 B 到达 400 m³（A 800×50%），B 可用 600：只能批一条
  // 已排但提交晚 vs 待排提交早 —— 已排优先
  const laterApproved = schedule({ id: 'approved', pondId: 'A', state: '已排', routePondIds: ['A', 'B'], volumeM3: 800, createdAt: '2026-10-02T00:00:00Z' });
  const earlierPending = schedule({ id: 'pending', pondId: 'A', state: '待排', routePondIds: ['A', 'B'], volumeM3: 800, createdAt: '2026-09-01T00:00:00Z' });
  let result = reconcileOccupancies({ schedules: [laterApproved, earlierPending], ponds, gates, observations, occupancies: [], today: TODAY, nowIso: stampNow });
  assert.equal(result.occupancies.find((r) => r.scheduleId === 'approved')!.granted, true, '已排即使提交晚也优先');
  assert.equal(result.occupancies.find((r) => r.scheduleId === 'pending')!.granted, false);

  // 同状态：提交早优先（各到 400，只批一条）
  const a = schedule({ id: 'a', pondId: 'A', state: '已排', routePondIds: ['A', 'B'], volumeM3: 800, createdAt: '2026-10-01T00:00:00Z' });
  const b = schedule({ id: 'b', pondId: 'A', state: '已排', routePondIds: ['A', 'B'], volumeM3: 800, createdAt: '2026-10-02T00:00:00Z' });
  result = reconcileOccupancies({ schedules: [b, a], ponds, gates, observations, occupancies: [], today: TODAY, nowIso: stampNow });
  assert.equal(result.occupancies.find((r) => r.scheduleId === 'a')!.granted, true, '同状态提交早优先');
  assert.equal(result.occupancies.find((r) => r.scheduleId === 'b')!.granted, false);
  console.log('✓ 排队优先级：状态 → 提交顺序');
}

// ---------- 4. 走水中 locked 现场事实照旧（即便超量），且优先于未执行 ----------
{
  // B 可用 600；走水中占 900（超量，溢流），另有新计划想占 100
  const running = schedule({ id: 'run', pondId: 'A', state: '走水中', routePondIds: ['A', 'B'], volumeM3: 1800, createdAt: '2026-10-01T00:00:00Z' });
  const existing: Occupancy = {
    id: 'occ-run--B', scheduleId: 'run', pondId: 'B', gateId: 'g-ab',
    volumeM3: 900, granted: true, locked: false, reason: null, shortfallM3: 0,
    createdAt: NOW, updatedAt: NOW, revision: 3,
  };
  const fresh = schedule({ id: 'fresh', pondId: 'A', state: '已排', routePondIds: ['A', 'B'], volumeM3: 200, createdAt: '2026-10-02T00:00:00Z' });
  const result = reconcileOccupancies({ schedules: [running, fresh], ponds, gates, observations, occupancies: [existing], today: TODAY, nowIso: stampNow });
  const runRow = result.occupancies.find((r) => r.scheduleId === 'run')!;
  assert.equal(runRow.locked, true);
  assert.equal(runRow.volumeM3, 900, '现场占用照旧，不随开度 / 水位重算');
  const accB = result.pondAccounts.find((a) => a.pondId === 'B')!;
  assert.ok(accB.remainingM3 < 0, '账面剩余为负 = 现场已溢流');
  assert.equal(result.occupancies.find((r) => r.scheduleId === 'fresh')!.granted, false, '容量被现场占满，新计划排队');
  console.log('✓ 走水中占用锁定为现场事实（超量 → 负余量）');
}

// ---------- 5. 已出卤释放占用 ----------
{
  const done = schedule({ id: 'done', pondId: 'A', state: '已出卤', routePondIds: ['A', 'B'], volumeM3: 1000 });
  const old: Occupancy = {
    id: 'occ-done--B', scheduleId: 'done', pondId: 'B', gateId: 'g-ab',
    volumeM3: 500, granted: true, locked: false, reason: null, shortfallM3: 0,
    createdAt: NOW, updatedAt: NOW, revision: 3,
  };
  const result = reconcileOccupancies({ schedules: [done], ponds, gates, observations, occupancies: [old], today: TODAY, nowIso: stampNow });
  assert.equal(result.occupancies.length, 0, '已出卤不产生占用');
  console.log('✓ 已出卤释放占用');
}

// ---------- 6. 超时释放并重新排队 ----------
{
  // 计划日 2026-09-30 已过、仍已排；容量够 → 清掉 expired 重新拿不到？这里容量够则重新排上
  const late = schedule({ id: 'late', pondId: 'A', state: '已排', routePondIds: ['A', 'B'], volumeM3: 200, planDate: '2026-09-30', expired: false, createdAt: '2026-09-01T00:00:00Z' });
  let result = reconcileOccupancies({ schedules: [late], ponds, gates, observations, occupancies: [], today: TODAY, nowIso: stampNow });
  assert.equal(result.expiredReleases, 1, '首次重排判定超时释放 1 条');
  assert.equal(result.schedules.find((s) => s.id === 'late')!.expired, false, '容量够，重新排上，清超时标记');

  // 容量不足时：保持 expired=true 排队
  const lateBig = schedule({ id: 'lateBig', pondId: 'A', state: '已排', routePondIds: ['A', 'B'], volumeM3: 2000, planDate: '2026-09-30', expired: false, createdAt: '2026-09-02T00:00:00Z' });
  result = reconcileOccupancies({ schedules: [lateBig], ponds, gates, observations, occupancies: [], today: TODAY, nowIso: stampNow });
  assert.equal(result.schedules.find((s) => s.id === 'lateBig')!.expired, true);
  assert.equal(result.queuedCount, 1);
  console.log('✓ 超时释放：重新排队，成功则清超时标记');
}

// ---------- 7. 路径枚举 / 默认路径 ----------
{
  const routes = enumerateRoutes('A', gates).map((r) => r.pondIds.join('>'));
  assert.ok(routes.includes('A'));
  assert.ok(routes.includes('A>B'));
  assert.ok(routes.includes('A>B>C'), '断流末端仍保留为可选路径（会挂账）');
  assert.deepEqual(defaultRoute('A', gates), ['A', 'B'], '默认选最长畅通路径，不走进关闭闸');
  assert.deepEqual(defaultRoute('D', gates), ['D'], '无下游闸门 → 仅本池');
  console.log('✓ 路径枚举与默认路径');
}

// ---------- 8. 取消后容量让给下一位（顺序稳定） ----------
{
  // 只能批一条；删掉排第一的后，第二条应拿到占用
  const a = schedule({ id: 'a', pondId: 'A', state: '已排', routePondIds: ['A', 'B'], volumeM3: 800, createdAt: '2026-10-01T00:00:00Z' });
  const b = schedule({ id: 'b', pondId: 'A', state: '已排', routePondIds: ['A', 'B'], volumeM3: 800, createdAt: '2026-10-02T00:00:00Z' });
  const first = reconcileOccupancies({ schedules: [a, b], ponds, gates, observations, occupancies: [], today: TODAY, nowIso: stampNow });
  assert.equal(first.occupancies.find((r) => r.scheduleId === 'a')!.granted, true);
  const second = reconcileOccupancies({ schedules: [b], ponds, gates, observations, occupancies: [], today: TODAY, nowIso: stampNow });
  assert.equal(second.occupancies.find((r) => r.scheduleId === 'b')!.granted, true, '取消 a 后 b 补占');
  console.log('✓ 取消释放后排队条目补占');
}

console.log('\n全部占用引擎规则验证通过 ✅');
