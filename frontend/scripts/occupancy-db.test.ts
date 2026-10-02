/* DB v3 占用账集成验证（Node + fake-indexeddb，通过 esbuild --inject 预置 indexedDB）：
 * 播种 → 占用自动补排 → 取消释放/补占 → 出卤释放 → 开度变化重排 → 超时。 */
import { strict as assert } from 'node:assert';
import {
  db,
  DB_SCHEMA_VERSION,
  initDatabase,
  listSchedules,
  putGate,
  removeSchedule,
  advanceScheduleState,
  reconcileAndPersist,
} from '../src/utils/db';
import { occupancyId } from '../src/utils/occupancy';

async function rowsFor(scheduleId: string) {
  return db.occupancies.where('scheduleId').equals(scheduleId).toArray();
}

async function main() {
  assert.equal(DB_SCHEMA_VERSION, 3);
  await initDatabase();
  assert.equal(db.verno, 3, '全新库直接建到 v3');

  const schedules = await listSchedules();
  const ids = schedules.map((s) => s.id).sort();
  assert.ok(ids.includes('schedule-a1'), '播种 6 条走水计划（含超时示例）');
  assert.ok(ids.includes('schedule-a2'), '含超时示例 schedule-a2');

  // a1: 500 × 65% → B 325；再 ×40% → C 130。B 可用 360、C 可用 252 → 拿到占用
  const a1 = await rowsFor('schedule-a1');
  assert.ok(a1.length >= 2, 'a1 对 B/C 两个下游各一行');
  assert.ok(a1.every((r) => r.granted), 'a1 全部已批占用');

  // b1 走水中：占用 locked
  const b1 = await rowsFor('schedule-b1');
  assert.ok(b1.length > 0 && b1.every((r) => r.locked), '走水中占用锁定');

  // d1: 1600×80% → E 1280，E 可用仅 144 → 排队
  const d1 = await rowsFor('schedule-d1');
  assert.ok(d1.some((r) => !r.granted && r.reason === '容量不足'), 'd1 容量不足排队');

  // a2 计划日 2026-09-29 已过：expired=true（E 容量不够，保持超时排队）
  const a2 = await db.schedules.get('schedule-a2');
  assert.ok(a2?.expired === true, 'a2 超时标记置位');
  const a2Rows = await rowsFor('schedule-a2');
  assert.ok(a2Rows.some((r) => !r.granted), 'a2 超时后仍在排队');

  // e1 已出卤：无占用
  const e1 = await rowsFor('schedule-e1');
  assert.equal(e1.length, 0, '已出卤占用已释放');

  // 取消 a1（B/C 各释放 325/130）→ 排队条目按顺序重排
  await removeSchedule('schedule-a1');
  assert.equal(await db.occupancies.where('scheduleId').equals('schedule-a1').count(), 0, '取消即释放占用');
  // d1 仍因 E 容量不足排队（释放发生在 B/C，与 E 无关）
  const d1After = await rowsFor('schedule-d1');
  assert.ok(d1After.some((r) => !r.granted), 'd1 不受 B/C 释放影响，仍排队');

  // 开度变化：把 d-e 闸从 80% 关到 0，d1 应转为闸门关闭断流
  const gateDE = await db.gates.get('gate-d-e');
  await putGate({ ...(gateDE as NonNullable<typeof gateDE>), openingPct: 0, state: '关闭' });
  const d1Closed = await rowsFor('schedule-d1');
  assert.ok(d1Closed.some((r) => !r.granted && r.reason === '闸门关闭'), '关闸后 d1 变为断流排队');

  // 恢复开度，d1 回到容量不足排队
  await putGate({ ...(gateDE as NonNullable<typeof gateDE>), openingPct: 80, state: '半开' });
  const d1Reopen = await rowsFor('schedule-d1');
  assert.ok(d1Reopen.some((r) => !r.granted && r.reason === '容量不足'), '恢复开度后回到容量排队');

  // 走水中 b1 完成出卤 → 占用释放
  await advanceScheduleState('schedule-b1', '已出卤', 1.2);
  assert.equal((await rowsFor('schedule-b1')).length, 0, '出卤释放占用');
  const b1Schedule = await db.schedules.get('schedule-b1');
  assert.equal(b1Schedule?.state, '已出卤');

  // 手动重排接口可用（回滚重试路径不抛错）
  const result = await reconcileAndPersist('2026-10-02');
  assert.ok(result.queuedCount >= 1, '仍有排队条目（d1）');

  // 占用主键稳定
  const some = await db.occupancies.toArray();
  for (const row of some) {
    assert.equal(row.id, occupancyId(row.scheduleId, row.pondId));
  }

  console.log('\nDB v3 集成验证通过 ✅ 占用行数：', some.length);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
