/**
 * 池容占用分配引擎（纯函数，便于单测与重放）
 *
 * 规则：
 * 1. 走水计划按「路径 + 计划量」预占下游池容量，容量逐池扣减；
 * 2. 容量不足的计划不写入占用，留在待批区排队 —— 先按已走水状态（待排 / 已排）排队，
 *    同状态按提交顺序（createdAt，其次 orderIndex、id）；
 * 3. 已执行计划（走水中 / 已出卤）为现场事实，占用账照旧，不参与重算；
 * 4. 取消 / 超时的计划释放占用；
 * 5. 水位或闸门开度变化后只重算未执行计划：空余容量按最新水位折算，路径按最新闸门重推。
 */
import type { Gate } from '../types/gate';
import type { Observation } from '../types/observation';
import type { Pond } from '../types/pond';
import type { Schedule } from '../types/schedule';
import type {
  AllocationEntry,
  AllocationResult,
  Occupancy,
  PathHop,
  PondLedger,
} from '../types/occupancy';
import { PENDING_EXECUTION_STATES } from '../types/occupancy';
import { pondVolumeM3, round1 } from './brine';

/** 超时宽限期：计划日期过后多少天未执行即超时释放占用 */
export const DEFAULT_TIMEOUT_DAYS = 3;

/** 沿闸门串级向下游走的最大跳数（防止拓扑成环） */
const MAX_HOPS = 8;

/** 排队顺序：已批状态（已排）优先于待排，同状态看提交顺序 */
const STATE_QUEUE_RANK: Record<string, number> = { 待排: 1, 已排: 0 };

interface EngineInput {
  ponds: Pond[];
  gates: Gate[];
  schedules: Schedule[];
  /** 各池最近一次水位观测（cm） */
  levelsByPond: Record<string, number>;
  /** 已落库的占用记录（取消 / 释放后会被删除） */
  occupancies: Occupancy[];
  /** 评估基准日期（YYYY-MM-DD） */
  today: string;
  /** 超时宽限天数 */
  timeoutDays?: number;
}

function daysBetween(a: string, b: string): number {
  const start = new Date(`${a}T00:00:00`).getTime();
  const end = new Date(`${b}T00:00:00`).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.round((end - start) / 86400000);
}

/** 打开的闸门才参与走水路径 */
function gateIsOpen(gate: Gate): boolean {
  return gate.state !== '关闭' && gate.openingPct > 0;
}

/**
 * 从源池沿打开的闸门推导走水路径。
 * 每口池只取开度最大的一条出流闸门（盐田串级实际为单通道；并列时取 id 稳定兜底）。
 */
export function tracePath(sourcePondId: string, gates: Gate[]): PathHop[] {
  const hops: PathHop[] = [];
  let current = sourcePondId;
  const visited = new Set<string>([current]);
  for (let hop = 1; hop <= MAX_HOPS; hop += 1) {
    const outbound = gates
      .filter((gate) => gate.fromPondId === current && gateIsOpen(gate) && !visited.has(gate.toPondId))
      .sort((a, b) => b.openingPct - a.openingPct || a.id.localeCompare(b.id));
    if (outbound.length === 0) break;
    const gate = outbound[0];
    hops.push({
      pondId: gate.toPondId,
      gateId: gate.id,
      share: 1,
      openingPct: gate.openingPct,
      hop,
    });
    current = gate.toPondId;
    visited.add(current);
  }
  return hops;
}

/** 某池最近水位折算的当前存量（m³）= 面积 × 水位 */
function storedVolume(pond: Pond, levelCm: number | undefined): number {
  if (levelCm === undefined || !Number.isFinite(levelCm) || levelCm <= 0) return 0;
  const level = Math.min(pond.depthCm, levelCm);
  return round1(pond.areaM2 * (level / 100));
}

/** 提交顺序：orderIndex（可拖拽调整）→ createdAt → id */
function submissionCompare(a: Schedule, b: Schedule): number {
  return (
    a.orderIndex - b.orderIndex ||
    a.createdAt.localeCompare(b.createdAt) ||
    a.id.localeCompare(b.id)
  );
}

/** 排队优先级：已走水状态（待排在先），同状态看提交顺序 */
function queueCompare(a: Schedule, b: Schedule): number {
  const rank = STATE_QUEUE_RANK[a.state] - STATE_QUEUE_RANK[b.state];
  if (rank !== 0) return rank;
  return submissionCompare(a, b);
}

/**
 * 核心分配：按排队顺序逐条尝试预占，容量账本随批随扣；
 * 任一下游池容量不足则整条计划回滚（不在任何池留占用），标记排队与缺口。
 */
export function allocateOccupancy(input: EngineInput): AllocationResult {
  const { schedules, occupancies, today: todayDate } = input;
  const timeoutDays = input.timeoutDays ?? DEFAULT_TIMEOUT_DAYS;

  // ---- 池账：容量 / 存量 / 空余（空余只被未执行计划的占用扣减） ----
  const ledgers = new Map<string, PondLedger>();
  input.ponds.forEach((pond) => {
    const capacity = pondVolumeM3(pond.areaM2, pond.depthCm);
    const stored = storedVolume(pond, input.levelsByPond[pond.id]);
    ledgers.set(pond.id, {
      pondId: pond.id,
      capacityM3: capacity,
      storedM3: stored,
      freeM3: round1(Math.max(0, capacity - stored)),
      reservedM3: 0,
      factualM3: 0,
      occupiedM3: round1(stored),
      gapM3: 0,
      occupiedPct: capacity <= 0 ? 0 : Math.min(100, Math.round((stored / capacity) * 1000) / 10),
    });
  });

  const activeBySchedule = new Map<string, Occupancy[]>();
  occupancies.forEach((occ) => {
    if (!activeBySchedule.has(occ.scheduleId)) activeBySchedule.set(occ.scheduleId, []);
    activeBySchedule.get(occ.scheduleId)!.push(occ);
  });

  const entries: AllocationEntry[] = [];

  // ---- 现场事实：走水中 / 已出卤的占用账照旧（仅台账展示，不扣空余） ----
  // 无历史占用记录时（升级库 / 新播种）按当前闸门串级补台账，但绝不参与重算扣减。
  schedules
    .filter((row) => row.state === '走水中' || row.state === '已出卤')
    .forEach((row) => {
      const list = activeBySchedule.get(row.id) ?? [];
      let path: PathHop[];
      let reserves: Array<{ pondId: string; hop: number; reservedM3: number }>;
      if (list.length > 0) {
        path = list
          .slice()
          .sort((a, b) => a.hop - b.hop)
          .map((occ) => ({ pondId: occ.pondId, gateId: null, share: 1, openingPct: 0, hop: occ.hop }));
        reserves = list.map((occ) => ({ pondId: occ.pondId, hop: occ.hop, reservedM3: occ.reservedM3 }));
      } else {
        path = tracePath(row.pondId, input.gates);
        reserves = path.map((hop) => ({ pondId: hop.pondId, hop: hop.hop, reservedM3: round1(row.volumeM3 * hop.share) }));
      }
      reserves.forEach((item) => {
        const ledger = ledgers.get(item.pondId);
        if (ledger !== undefined) ledger.factualM3 = round1(ledger.factualM3 + item.reservedM3);
      });
      entries.push({
        scheduleId: row.id,
        path,
        holdState: row.state as '走水中' | '已出卤',
        reserves,
        shortfallM3: 0,
        pondShortfalls: [],
        timedOut: false,
        cancelled: false,
      });
    });

  // ---- 未执行计划：取消 / 超时 → 排队（按最新状态与水位重算） ----
  const pending = schedules
    .filter((row) => PENDING_EXECUTION_STATES.includes(row.state))
    .sort(queueCompare);

  for (const row of pending) {
    const cancelled = isMarkedCancelled(row);
    const timedOut = !cancelled && daysBetween(row.planDate, todayDate) > timeoutDays;

    if (cancelled || timedOut) {
      entries.push({
        scheduleId: row.id,
        path: [],
        holdState: cancelled ? '已取消' : '已超时',
        reserves: [],
        shortfallM3: 0,
        pondShortfalls: [],
        timedOut,
        cancelled,
      });
      continue;
    }

    const path = tracePath(row.pondId, input.gates);
    if (path.length === 0) {
      entries.push({
        scheduleId: row.id,
        path: [],
        holdState: '无下游',
        reserves: [],
        shortfallM3: 0,
        pondShortfalls: [],
        timedOut: false,
        cancelled: false,
      });
      continue;
    }

    const need = path.map((hop) => ({
      pondId: hop.pondId,
      hop: hop.hop,
      reservedM3: round1(row.volumeM3 * hop.share),
    }));

    // 容量校验：逐池检查扣减后的空余是否仍 ≥ 0
    const trial = new Map<string, number>();
    const shortfalls: Array<{ pondId: string; gapM3: number }> = [];
    let fit = true;
    for (const item of need) {
      const ledger = ledgers.get(item.pondId);
      if (ledger === undefined) {
        // 下游池已删除：路径失效，按排队处理
        fit = false;
        shortfalls.push({ pondId: item.pondId, gapM3: item.reservedM3 });
        continue;
      }
      const used = (trial.get(item.pondId) ?? 0) + item.reservedM3;
      trial.set(item.pondId, used);
      if (used > ledger.freeM3 - ledger.reservedM3 + 0.001) {
        fit = false;
        const gap = round1(used - (ledger.freeM3 - ledger.reservedM3));
        shortfalls.push({ pondId: item.pondId, gapM3: Math.max(0, gap) });
      }
    }

    if (fit) {
      need.forEach((item) => {
        const ledger = ledgers.get(item.pondId);
        if (ledger === undefined) return;
        ledger.reservedM3 = round1(ledger.reservedM3 + item.reservedM3);
      });
      entries.push({
        scheduleId: row.id,
        path,
        holdState: '已批占用',
        reserves: need,
        shortfallM3: 0,
        pondShortfalls: [],
        timedOut: false,
        cancelled: false,
      });
    } else {
      // 排队：缺口记到池账上（同池多条排队计划累加）
      shortfalls.forEach((item) => {
        const ledger = ledgers.get(item.pondId);
        if (ledger !== undefined) ledger.gapM3 = round1(ledger.gapM3 + item.gapM3);
      });
      entries.push({
        scheduleId: row.id,
        path,
        holdState: '排队中',
        reserves: need,
        shortfallM3: round1(Math.max(0, ...shortfalls.map((item) => item.gapM3))),
        pondShortfalls: shortfalls,
        timedOut: false,
        cancelled: false,
      });
    }
  }

  // ---- 汇总 ----
  const ledgerRecord: Record<string, PondLedger> = {};
  let reservedTotal = 0;
  let gapTotal = 0;
  ledgers.forEach((ledger) => {
    ledger.occupiedM3 = round1(ledger.storedM3 + ledger.reservedM3);
    ledger.occupiedPct =
      ledger.capacityM3 <= 0 ? 0 : Math.min(100, Math.round((ledger.occupiedM3 / ledger.capacityM3) * 1000) / 10);
    ledger.freeM3 = round1(Math.max(0, ledger.capacityM3 - ledger.storedM3 - ledger.reservedM3));
    ledgerRecord[ledger.pondId] = ledger;
    reservedTotal += ledger.reservedM3;
    gapTotal += ledger.gapM3;
  });

  const scheduleById = new Map(schedules.map((row) => [row.id, row]));
  const queuedEntries = entries.filter((entry) => entry.holdState === '排队中');
  const queuedVolume = queuedEntries.reduce((acc, entry) => {
    const row = scheduleById.get(entry.scheduleId);
    return acc + (row?.volumeM3 ?? 0);
  }, 0);

  return {
    entries: entries.sort((a, b) => {
      const sa = scheduleById.get(a.scheduleId);
      const sb = scheduleById.get(b.scheduleId);
      if (sa && sb) return queueCompare(sa, sb);
      return a.scheduleId.localeCompare(b.scheduleId);
    }),
    ledgers: ledgerRecord,
    summary: {
      reservedTotalM3: round1(reservedTotal),
      gapTotalM3: round1(gapTotal),
      queuedVolumeM3: round1(queuedVolume),
      queuedCount: queuedEntries.length,
      heldCount: entries.filter((entry) => entry.holdState === '已批占用').length,
      timedOutCount: entries.filter((entry) => entry.holdState === '已超时').length,
      cancelledCount: entries.filter((entry) => entry.holdState === '已取消').length,
    },
  };
}

/** 取消标记落在计划表上（holdCancelledAt 字段），不依赖占用记录是否仍存在 */
function isMarkedCancelled(row: Schedule): boolean {
  return typeof row.holdCancelledAt === 'string' && row.holdCancelledAt !== '';
}

/** 取各池最近一次观测水位（cm） */
export function latestLevels(observations: Observation[]): Record<string, number> {
  const result: Record<string, number> = {};
  const latestDate: Record<string, string> = {};
  observations.forEach((obs) => {
    if (latestDate[obs.pondId] === undefined || obs.date > latestDate[obs.pondId]) {
      latestDate[obs.pondId] = obs.date;
      result[obs.pondId] = obs.levelCm;
    }
  });
  return result;
}

/**
 * 根据分配结果构造应落库的占用行（稳定 id：occ-{scheduleId}-{hop}）：
 * - 已批占用：按排队处理顺序累计扣减，记录预占后空余快照；
 * - 现场事实（走水中 / 已出卤）：沿用既有台账，缺失时按当前串级补建（freeAtReserve=0）。
 */
export function buildDesiredOccupancies(
  result: AllocationResult,
  schedules: Schedule[],
  existing: Occupancy[],
  stamp: string,
  revision: number,
): Occupancy[] {
  const scheduleById = new Map(schedules.map((row) => [row.id, row]));
  const desired: Occupancy[] = [];
  const runningUsed: Record<string, number> = {};
  const initialFree: Record<string, number> = {};
  Object.values(result.ledgers).forEach((ledger) => {
    initialFree[ledger.pondId] = ledger.capacityM3 - ledger.storedM3;
  });

  result.entries
    .filter((entry) => entry.holdState === '已批占用')
    .forEach((entry) => {
      const row = scheduleById.get(entry.scheduleId);
      entry.reserves.forEach((item) => {
        const before = runningUsed[item.pondId] ?? 0;
        const freeAtReserve = Math.round((initialFree[item.pondId] - before - item.reservedM3) * 10) / 10;
        runningUsed[item.pondId] = before + item.reservedM3;
        desired.push({
          id: `occ-${entry.scheduleId}-${item.hop}`,
          scheduleId: entry.scheduleId,
          pondId: item.pondId,
          hop: item.hop,
          reservedM3: item.reservedM3,
          freeAtReserveM3: Math.max(0, freeAtReserve),
          createdAt: row?.createdAt ?? stamp,
          updatedAt: stamp,
          revision,
        });
      });
    });

  result.entries
    .filter((entry) => entry.holdState === '走水中' || entry.holdState === '已出卤')
    .forEach((entry) => {
      const row = scheduleById.get(entry.scheduleId);
      const existingForSchedule = existing.filter((occ) => occ.scheduleId === entry.scheduleId);
      if (existingForSchedule.length > 0) {
        desired.push(...existingForSchedule);
        return;
      }
      entry.reserves.forEach((item) => {
        desired.push({
          id: `occ-${entry.scheduleId}-${item.hop}`,
          scheduleId: entry.scheduleId,
          pondId: item.pondId,
          hop: item.hop,
          reservedM3: item.reservedM3,
          freeAtReserveM3: 0,
          createdAt: row?.createdAt ?? stamp,
          updatedAt: stamp,
          revision,
        });
      });
    });

  return desired;
}
