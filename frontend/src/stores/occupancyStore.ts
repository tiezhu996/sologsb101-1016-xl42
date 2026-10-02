/**
 * 池容占用账状态管理（Solid 原生能力）
 *
 * - 订阅 ponds / gates / observations / schedules / occupancies，用纯函数引擎实时派生
 *   各下游池的已占容量、缺口与排队量（界面展示始终与最新数据一致）；
 * - 当「事实数据」变化（池容、水位、闸门开度、计划增删改、取消 / 恢复）后，自动串行
 *   重排 occupancies 表：只重算未执行计划，走水中 / 已出卤台账照旧；
 * - 重排事务失败会整体回滚原占用账并自动重试，界面展示回退到旧账，不会出现半空账。
 */
import { createRoot } from 'solid-js';
import { createStore } from 'solid-js/store';
import { liveQuery } from 'dexie';
import type { Gate } from '../types/gate';
import type { Observation } from '../types/observation';
import type { Pond } from '../types/pond';
import type { Schedule } from '../types/schedule';
import type { AllocationEntry, AllocationResult, Occupancy, PondLedger } from '../types/occupancy';
import { db, initDatabase, rebuildOccupancies, setScheduleHoldCancelled } from '../utils/db';
import { today } from '../utils/id';
import { allocateOccupancy, latestLevels } from '../utils/occupancy';

interface OccupancyStoreState {
  ponds: Pond[];
  gates: Gate[];
  observations: Observation[];
  schedules: Schedule[];
  occupancies: Occupancy[];
  result: AllocationResult | null;
  /** 正在后台重排占用账 */
  rebuilding: boolean;
  /** 最近一次重排错误（成功后清空）；出错时界面仍展示回滚后的旧账 */
  error: string;
  lastRebuiltAt: string;
  lastMessage: string;
}

function createOccupancyStore() {
  const [state, setState] = createStore<OccupancyStoreState>({
    ponds: [],
    gates: [],
    observations: [],
    schedules: [],
    occupancies: [],
    result: null,
    rebuilding: false,
    error: '',
    lastRebuiltAt: '',
    lastMessage: '',
  });

  // 串行化重排：同一时刻只有一个事务在写 occupancies，后到的请求合并
  let rebuildChain: Promise<void> = Promise.resolve();
  let rebuildQueued = false;
  // 重排进行中又有新事实变更：结束后必须再跑一次，直到占用账与事实一致
  let rebuildDirty = false;
  // 事实表（池 / 闸 / 观测 / 计划）指纹：占用表自身的写入不改指纹，天然防止回环
  let lastFactKey = '';

  function factKey(ponds: Pond[], gates: Gate[], observations: Observation[], schedules: Schedule[]): string {
    const part = (rows: Array<{ id: string; updatedAt?: string }>): string =>
      rows.map((row) => `${row.id}:${row.updatedAt ?? ''}`).join('|');
    return `${part(ponds)}#${part(gates)}#${part(observations)}#${part(
      schedules.map((row) => ({ id: row.id, updatedAt: `${row.updatedAt}:${row.holdCancelledAt ?? ''}` })),
    )}`;
  }

  void initDatabase();

  liveQuery(async () => {
    const [ponds, gates, observations, schedules, occupancies] = await Promise.all([
      db.ponds.toArray(),
      db.gates.toArray(),
      db.observations.toArray(),
      db.schedules.toArray(),
      db.occupancies.toArray(),
    ]);
    return { ponds, gates, observations, schedules, occupancies };
  }).subscribe({
    next: ({ ponds, gates, observations, schedules, occupancies }) => {
      setState({ ponds, gates, observations, schedules, occupancies });
      const result = allocateOccupancy({
        ponds,
        gates,
        schedules,
        levelsByPond: latestLevels(observations),
        occupancies,
        today: today(),
      });
      setState('result', result);
      // 事实数据变化后自动重排；occupancies 自身被重排改写时指纹不变，不再触发
      const key = factKey(ponds, gates, observations, schedules);
      if (schedules.length > 0 && key !== lastFactKey) {
        lastFactKey = key;
        if (rebuildQueued) {
          rebuildDirty = true;
        } else {
          void requestRebuild('数据变化');
        }
      }
    },
    error: (err: unknown) => {
      setState('error', err instanceof Error ? err.message : '读取池容占用账失败');
    },
  });

  /**
   * 请求重排占用账。多次调用会合并：进行中则在结束后再跑一次（吃到最新数据）。
   * rebuildOccupancies 内部自带事务回滚 + 重试；这里再失败则保留旧账并提示。
   */
  function requestRebuild(reason: string): Promise<void> {
    if (rebuildQueued) {
      // 已有重排在跑 / 排队：记下脏标记，结束后补跑一次吃到最新事实
      rebuildDirty = true;
      return rebuildChain;
    }
    rebuildQueued = true;
    rebuildDirty = false;
    setState('rebuilding', true);
    rebuildChain = rebuildChain
      .then(async () => {
        try {
          // 循环到占用账追上最新事实为止（重排期间发生的变更会置 dirty）
          for (;;) {
            rebuildDirty = false;
            await rebuildOccupancies();
            if (!rebuildDirty) break;
          }
          setState('error', '');
          setState('lastRebuiltAt', new Date().toISOString());
          if (reason !== '数据变化') setState('lastMessage', `占用账已按${reason}重排`);
        } catch (err) {
          setState('error', err instanceof Error ? err.message : '占用账重排失败，已恢复原占用账');
        } finally {
          rebuildQueued = false;
          setState('rebuilding', false);
        }
      });
    return rebuildChain;
  }

  function setMessage(message: string): void {
    setState('lastMessage', message);
  }

  function entryOf(scheduleId: string): AllocationEntry | null {
    return state.result?.entries.find((entry) => entry.scheduleId === scheduleId) ?? null;
  }

  function ledgerOf(pondId: string): PondLedger | null {
    return state.result?.ledgers[pondId] ?? null;
  }

  /** 取消预占：释放占用，计划留在待批区 */
  async function cancelHold(scheduleId: string): Promise<void> {
    await setScheduleHoldCancelled(scheduleId, true);
    setState('lastMessage', '已取消预占并释放下游容量，计划留在待批区');
  }

  /** 恢复预占 / 超时重报：清除取消或超时释放标记，立即重新参与排队占用 */
  async function restoreHold(scheduleId: string): Promise<void> {
    await setScheduleHoldCancelled(scheduleId, false);
    setState('lastMessage', '已恢复占用申请，正在按最新容量重新排队');
  }

  return {
    state,
    requestRebuild,
    setMessage,
    entryOf,
    ledgerOf,
    cancelHold,
    restoreHold,
  };
}

const store = createRoot(createOccupancyStore);

export function useOccupancyStore() {
  return store;
}
