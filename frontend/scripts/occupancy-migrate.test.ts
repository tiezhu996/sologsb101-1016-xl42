/* v2 → v3 升级迁移验证：先按真实 v2 结构建库写入旧格式走水计划（无 routePondIds/expired、
 * 无 occupancies 表），再调用真实 db.ts 的 initDatabase() 触发 v3.upgrade，
 * 校验字段补齐、占用账建表并自动补排。 */
import { strict as assert } from 'node:assert';
import Dexie from 'dexie';
import { db, DB_NAME, initDatabase } from '../src/utils/db';

const T = '2026-01-01T00:00:00.000Z';

/** 用与 db.ts v1/v2 完全一致的 stores 建一个旧库 */
async function buildV2Database(): Promise<void> {
  const v2 = new Dexie(DB_NAME);
  v2.version(1).stores({
    ponds: 'id, code, seriesName, stage, status, createdAt',
    gates: 'id, fromPondId, toPondId, state',
    observations: 'id, pondId, date, [pondId+date], densityGcm3',
    assays: 'id, pondId, date, [pondId+date], verdict',
    schedules: 'id, pondId, planDate, state, orderIndex',
  });
  v2.version(2).stores({
    ponds: 'id, code, seriesName, stage, status, createdAt, updatedAt',
    gates: 'id, fromPondId, toPondId, state, openingPct',
    observations: 'id, pondId, date, [pondId+date], densityGcm3, evapMm',
    assays: 'id, pondId, date, [pondId+date], verdict, verdictManual',
    schedules: 'id, pondId, planDate, state, orderIndex',
  });
  await v2.open();
  await v2.table('ponds').bulkPut([
    // 起点池小容量、下游 B 空池（面积大、无观测→可用全部），保证旧计划迁移后能拿到占用
    { id: 'p1', code: 'P', seriesName: 's', areaM2: 1000, depthCm: 50, stage: '钠盐', status: '在用', createdAt: T, updatedAt: T, revision: 2 },
    { id: 'b1', code: 'B', seriesName: 's', areaM2: 9000, depthCm: 60, stage: '钾盐', status: '在用', createdAt: T, updatedAt: T, revision: 2 },
  ]);
  await v2.table('gates').bulkPut([
    { id: 'g1', fromPondId: 'p1', toPondId: 'b1', openingPct: 100, widthCm: 100, state: '全开', note: '', createdAt: T, updatedAt: T, revision: 2 },
  ]);
  // 旧格式走水计划：没有 routePondIds / expired 字段
  await v2.table('schedules').bulkPut([
    { id: 'old1', pondId: 'p1', planDate: '2026-10-02', targetDensity: 1.1, volumeM3: 100, operator: 't', state: '已排', orderIndex: 1, createdAt: '2026-10-01T00:00:00Z', updatedAt: T, revision: 2 },
  ]);
  v2.close();
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('deleteDatabase blocked'));
  });
}

async function main() {
  await deleteDatabase(DB_NAME);
  await buildV2Database();

  // 真实代码打开：应执行 db.ts 的 v3.upgrade，且首屏检测到占用账为空后补排
  await initDatabase();

  assert.equal(db.verno, 3, '真实 v2 库升级到 v3');

  const sched = await db.schedules.get('old1');
  assert.ok(sched, '旧计划仍在');
  assert.deepEqual(sched?.routePondIds, ['p1'], 'v3 升级为旧计划补齐默认路径 [起点池]');
  assert.equal(sched?.expired, false, 'v3 升级为旧计划补齐 expired=false');

  // occupancies 表已建立（默认路径仅起点 → 无下游占用行，这是正确的：旧计划没有路径信息）
  const tables = db.tables.map((t) => t.name);
  assert.ok(tables.includes('occupancies'), '新增 occupancies 表');

  // 给旧计划补一条真实下游路径后重排，应能在 b1 拿到占用，证明升级后引擎链路可用
  await db.schedules.update('old1', { routePondIds: ['p1', 'b1'] });
  // 手动触发一次重排（init 时因占用表为空已排过，但当时路径仅起点）
  const { reconcileAndPersist } = await import('../src/utils/db');
  const result = await reconcileAndPersist('2026-10-02');
  assert.equal(result.grantedCount, 1, '补齐路径后旧计划拿到下游占用');
  const rows = await db.occupancies.where('scheduleId').equals('old1').toArray();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pondId, 'b1');
  assert.equal(rows[0].granted, true);
  assert.equal(rows[0].volumeM3, 100, '全开闸无折减');

  await deleteDatabase(DB_NAME);
  console.log('\nv2 → v3 升级迁移验证通过 ✅');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
