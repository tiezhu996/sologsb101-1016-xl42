/**
 * 走水编排状态管理（Solid 原生能力）
 * 用 createStore 维护走水顺序与状态推进；出卤完成后回写池阶段与实际密度。
 * 池容占用账（occupancies）随 schedules / gates / observations / ponds 任意变化重排，
 * 这里只读订阅，供「池容占用账 / 待批区 / 逐条占用徽标」消费。
 */
import { createMemo, createRoot, createSignal } from 'solid-js';
import { createStore } from 'solid-js/store';
import { liveQuery } from 'dexie';
import type { Occupancy } from '../types/occupancy';
import type { Schedule, ScheduleDraft, ScheduleState } from '../types/schedule';
import { SCHEDULE_STATE_FLOW } from '../types/schedule';
import {
  advanceScheduleState,
  db,
  initDatabase,
  putSchedule,
  reconcileAndPersist,
  removeSchedule,
  reorderSchedules,
} from '../utils/db';
import { nowIso, uuid } from '../utils/id';
import { usePondStore } from './pondStore';

/** 走水编排筛选条件 */
export interface ScheduleFilters {
  keyword: string;
  seriesName: string | 'all';
  state: ScheduleState | 'all';
}

const EMPTY_FILTERS: ScheduleFilters = { keyword: '', seriesName: 'all', state: 'all' };

interface ScheduleState_ {
  rows: Schedule[];
  occupancies: Occupancy[];
  loading: boolean;
  error: string;
  lastMessage: string;
}

function createScheduleStore() {
  const [state, setState] = createStore<ScheduleState_>({
    rows: [],
    occupancies: [],
    loading: true,
    error: '',
    lastMessage: '',
  });
  const [filters, setFilters] = createSignal<ScheduleFilters>({ ...EMPTY_FILTERS });
  const [draggingId, setDraggingId] = createSignal<string | null>(null);

  // 同 observationStore：建库必须放在 querier 外，否则 liveQuery 采集不到可观测性集合，
  // 数据库变更后不会重查 —— 走水计划条数与拖拽后的顺序都不会原地刷新。
  void initDatabase();

  liveQuery(async () => {
    return db.schedules.toArray();
  }).subscribe({
    next: (list) => {
      setState('rows', [...list].sort((a, b) => a.orderIndex - b.orderIndex || a.planDate.localeCompare(b.planDate)));
      setState('loading', false);
      setState('error', '');
    },
    error: (err: unknown) => {
      setState({ loading: false, error: err instanceof Error ? err.message : '读取走水编排失败' });
    },
  });

  // 占用账由 db 层在每次相关写入后的事务内重排，这里只订阅结果
  liveQuery(async () => db.occupancies.toArray()).subscribe({
    next: (list) => setState('occupancies', list),
    error: (err: unknown) => {
      setState('error', err instanceof Error ? err.message : '读取池容占用账失败');
    },
  });

  /** 计划 id → 其全部占用行 */
  const occupanciesBySchedule = createMemo<Map<string, Occupancy[]>>(() => {
    const map = new Map<string, Occupancy[]>();
    for (const row of state.occupancies) {
      const list = map.get(row.scheduleId) ?? [];
      list.push(row);
      map.set(row.scheduleId, list);
    }
    return map;
  });

  function occupanciesOf(scheduleId: string): Occupancy[] {
    return occupanciesBySchedule().get(scheduleId) ?? [];
  }

  /** 计划占用状态：已批占用 / 排队中（未拿到占用，留在待批区）/ 无下游占用 / 现场锁定 */
  function occupancyStatus(schedule: Schedule): {
    kind: 'granted' | 'queued' | 'none' | 'locked';
    rows: Occupancy[];
  } {
    const rows = occupanciesOf(schedule.id);
    if (rows.length === 0) return { kind: 'none', rows };
    if (rows.some((row) => row.locked)) return { kind: 'locked', rows };
    if (rows.some((row) => !row.granted)) return { kind: 'queued', rows };
    return { kind: 'granted', rows };
  }

  function patchFilters(patch: Partial<ScheduleFilters>): void {
    setFilters({ ...filters(), ...patch });
  }

  function resetFilters(): void {
    setFilters({ ...EMPTY_FILTERS });
  }

  function setMessage(message: string): void {
    setState('lastMessage', message);
  }

  async function createSchedule(draft: ScheduleDraft): Promise<Schedule> {
    const stamp = nowIso();
    const row: Schedule = {
      id: uuid('schedule'),
      pondId: draft.pondId,
      routePondIds: draft.routePondIds,
      planDate: draft.planDate,
      targetDensity: draft.targetDensity,
      volumeM3: draft.volumeM3,
      operator: draft.operator.trim(),
      state: draft.state,
      orderIndex: draft.orderIndex,
      expired: draft.expired,
      createdAt: stamp,
      updatedAt: stamp,
      revision: 3,
    };
    await putSchedule(row);
    setState('lastMessage', `已新建走水计划：${row.planDate}`);
    return row;
  }

  async function updateSchedule(scheduleId: string, draft: ScheduleDraft): Promise<void> {
    const existing = state.rows.find((row) => row.id === scheduleId);
    if (existing === undefined) return;
    await putSchedule({
      ...existing,
      pondId: draft.pondId,
      routePondIds: draft.routePondIds,
      planDate: draft.planDate,
      targetDensity: draft.targetDensity,
      volumeM3: draft.volumeM3,
      operator: draft.operator.trim(),
      state: draft.state,
      orderIndex: draft.orderIndex,
      expired: draft.expired,
    });
    setState('lastMessage', '走水计划已更新，下游池占用已重排');
  }

  async function deleteSchedule(scheduleId: string): Promise<void> {
    await removeSchedule(scheduleId);
    setState('lastMessage', '已取消走水计划并释放占用，排队条目已重新分配');
  }

  async function advance(scheduleId: string): Promise<ScheduleState | null> {
    const existing = state.rows.find((row) => row.id === scheduleId);
    if (existing === undefined) return null;
    const index = SCHEDULE_STATE_FLOW.indexOf(existing.state);
    if (index < 0 || index >= SCHEDULE_STATE_FLOW.length - 1) return null;
    const next = SCHEDULE_STATE_FLOW[index + 1];
    // 开始走水前必须已拿到下游池占用；未拿到占用的条目只能留在待批区
    if (next === '走水中') {
      const status = occupancyStatus(existing);
      if (status.kind === 'queued') {
        setState('lastMessage', '该计划尚未拿到下游池占用，暂不能开始走水，请等待容量释放或调整开度 / 计划量');
        return null;
      }
    }
    const pondStore = usePondStore();
    const stat = pondStore.statOf(existing.pondId);
    const actualDensity = stat.currentDensity > 0 ? stat.currentDensity : existing.targetDensity;
    await advanceScheduleState(scheduleId, next, actualDensity);
    await pondStore.refreshCounts();
    setState(
      'lastMessage',
      next === '已出卤'
        ? `已出卤：池阶段已推进，实际密度回写为 ${actualDensity} g/cm³，下游占用已释放`
        : next === '走水中'
          ? '已开始走水：该条占用转为现场事实，重排只调整未执行计划'
          : `状态已推进为「${next}」`,
    );
    return next;
  }

  /** 手动触发一次占用重排（水位 / 开度变化后的「立即重排」） */
  async function reconcileNow(): Promise<void> {
    try {
      const result = await reconcileAndPersist();
      setState(
        'lastMessage',
        `占用账已重排：${result.grantedCount} 条已占用、${result.queuedCount} 条排队` +
          (result.expiredReleases > 0 ? `，其中 ${result.expiredReleases} 条超时释放后重新排队` : ''),
      );
    } catch (err) {
      setState('lastMessage', `重排失败，已恢复原占用账：${err instanceof Error ? err.message : '未知错误'}`);
    }
  }

  /** 拖拽排序：把 fromId 移动到 toId 之前 */
  async function moveBefore(fromId: string, toId: string): Promise<void> {
    if (fromId === toId) return;
    const list = [...state.rows].sort((a, b) => a.orderIndex - b.orderIndex);
    const fromIndex = list.findIndex((row) => row.id === fromId);
    const toIndex = list.findIndex((row) => row.id === toId);
    if (fromIndex < 0 || toIndex < 0) return;
    const [moved] = list.splice(fromIndex, 1);
    list.splice(toIndex, 0, moved);
    await reorderSchedules(list.map((row) => row.id));
    setState('lastMessage', `已调整走水顺序：${moved.planDate} 移动到第 ${toIndex + 1} 位`);
  }

  async function moveToIndex(id: string, targetIndex: number): Promise<void> {
    const list = [...state.rows].sort((a, b) => a.orderIndex - b.orderIndex);
    const fromIndex = list.findIndex((row) => row.id === id);
    if (fromIndex < 0) return;
    const [moved] = list.splice(fromIndex, 1);
    const index = Math.max(0, Math.min(list.length, targetIndex));
    list.splice(index, 0, moved);
    await reorderSchedules(list.map((row) => row.id));
    setState('lastMessage', `已把 ${moved.planDate} 调整到第 ${index + 1} 位`);
  }

  return {
    state,
    filters,
    patchFilters,
    resetFilters,
    draggingId,
    setDraggingId,
    setMessage,
    occupanciesOf,
    occupancyStatus,
    createSchedule,
    updateSchedule,
    deleteSchedule,
    advance,
    reconcileNow,
    moveBefore,
    moveToIndex,
  };
}

const store = createRoot(createScheduleStore);

export function useScheduleStore() {
  return store;
}
