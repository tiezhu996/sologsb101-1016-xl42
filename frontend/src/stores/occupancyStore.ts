/**
 * 池容占用账派生状态（Solid 原生能力）
 * 占用行由 db 层事务化重排落库；这里在前端用同一套纯引擎按最新
 * ponds / gates / observations / schedules / occupancies 再算一遍汇总，
 * 保证「已占容量 / 缺口 / 排队量」随水位、开度、计划任意变化即时刷新。
 */
import { createMemo, createRoot } from 'solid-js';
import type { Occupancy } from '../types/occupancy';
import type { Schedule } from '../types/schedule';
import { reconcileOccupancies, type PondAccount } from '../utils/occupancy';
import { today } from '../utils/id';
import { usePondStore } from './pondStore';
import { useScheduleStore } from './scheduleStore';

export interface QueuedEntry {
  schedule: Schedule;
  rows: Occupancy[];
  expired: boolean;
}

export interface OccupancyBoard {
  pondAccounts: PondAccount[];
  totals: {
    occupiedM3: number;
    shortfallM3: number;
    queuedM3: number;
    capacityM3: number;
  };
  /** 排队条目（未拿到占用的计划，去重），按排队优先级排序 */
  queuedSchedules: QueuedEntry[];
  grantedCount: number;
  queuedCount: number;
}

function queueRank(state: Schedule['state']): number {
  return state === '走水中' ? 0 : state === '已排' ? 1 : 2;
}

function createOccupancyStore() {
  const pondStore = usePondStore();

  const board = createMemo<OccupancyBoard>(() => {
    const scheduleStore = useScheduleStore();
    const result = reconcileOccupancies({
      schedules: pondStore.state.schedules,
      ponds: pondStore.state.ponds,
      gates: pondStore.state.gates,
      observations: pondStore.state.observations,
      occupancies: scheduleStore.state.occupancies,
      today: today(),
      nowIso: () => new Date(0).toISOString(),
    });
    const bySchedule = new Map<string, Occupancy[]>();
    for (const row of result.occupancies) {
      if (row.granted) continue;
      const list = bySchedule.get(row.scheduleId) ?? [];
      list.push(row);
      bySchedule.set(row.scheduleId, list);
    }
    const queuedSchedules: QueuedEntry[] = [];
    for (const [scheduleId, rows] of bySchedule) {
      const schedule = pondStore.state.schedules.find((row) => row.id === scheduleId);
      if (schedule !== undefined) queuedSchedules.push({ schedule, rows, expired: schedule.expired });
    }
    queuedSchedules.sort(
      (a, b) =>
        queueRank(a.schedule.state) - queueRank(b.schedule.state) ||
        a.schedule.createdAt.localeCompare(b.schedule.createdAt),
    );
    return {
      pondAccounts: result.pondAccounts,
      totals: result.totals,
      queuedSchedules,
      grantedCount: result.grantedCount,
      queuedCount: result.queuedCount,
    };
  });

  function accountOf(pondId: string): PondAccount | null {
    return board().pondAccounts.find((account) => account.pondId === pondId) ?? null;
  }

  return { board, accountOf };
}

const store = createRoot(createOccupancyStore);

export function useOccupancyStore() {
  return store;
}
