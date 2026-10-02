/**
 * 池容占用账引擎（纯函数）
 *
 * 规则：
 * - 走水计划沿「路径」（routePondIds）逐闸下泄，闸门开度按比例折减到达量：
 *   到达下游池的量 = 上一池到达量 × (openingPct / 100)；闸门关闭则路径断流。
 * - 下游池可用容量 = 有效体积 − 当前存量；当前存量由最近一次观测水位折算
 *   （存量 = 面积 × 水位cm / 100；无观测视为空池，可容全部有效体积）。
 * - 排队优先级：已走水状态（走水中）优先于未执行计划；同状态按提交顺序（createdAt）。
 * - 路径上任一下游池容量不足（或路径断流），整条计划拿不到占用，留在待批区排队。
 * - 走水中计划的占用是现场事实（locked），重算时照旧，哪怕占用量已超过账面余量。
 * - 已出卤计划已完成走水，释放占用，不再参与排队。
 * - 计划日已过且仍未执行者，其占用视为超时释放，再按普通优先级重新排队。
 */
import type { Gate } from '../types/gate';
import type { Observation } from '../types/observation';
import type { Occupancy, OccupancyReason } from '../types/occupancy';
import type { Pond } from '../types/pond';
import { LOCKED_STATES, PENDING_STATES, SCHEDULE_PRIORITY_RANK, type Schedule } from '../types/schedule';
import { pondVolumeM3 } from './brine';

/** 数值容差（m³），低于该值的占用 / 缺口视为 0 */
const EPS = 1e-6;

/** 占用账主键：一条计划对一个下游池至多一行 */
export function occupancyId(scheduleId: string, pondId: string): string {
  return `occ-${scheduleId}--${pondId}`;
}

/** 规整为 1 位小数 */
function r1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** 取某池最近一次观测的水位（cm）；无观测返回 null */
export function latestLevelCm(pondId: string, observations: Observation[]): number | null {
  let latest: Observation | null = null;
  for (const row of observations) {
    if (row.pondId !== pondId) continue;
    if (latest === null || row.date > latest.date) latest = row;
  }
  return latest === null ? null : latest.levelCm;
}

/** 池有效体积（m³） */
export function capacityOf(pond: Pond): number {
  return pondVolumeM3(pond.areaM2, pond.depthCm);
}

/** 池当前存量（m³）= 面积 × 最近水位；无观测按空池计 */
export function storageOf(pond: Pond, levelCm: number | null): number {
  if (levelCm === null) return 0;
  const level = Math.max(0, Math.min(pond.depthCm, levelCm));
  return r1(pond.areaM2 * (level / 100));
}

/** 池当前可用容量（m³）= 有效体积 − 当前存量 */
export function availableOf(pond: Pond, levelCm: number | null): number {
  return r1(Math.max(0, capacityOf(pond) - storageOf(pond, levelCm)));
}

/** 路径上一跳的闸门 */
export function gateBetween(gates: Gate[], fromPondId: string, toPondId: string): Gate | undefined {
  return gates.find((gate) => gate.fromPondId === fromPondId && gate.toPondId === toPondId);
}

/** 路径上某一下游池的到达申请 */
export interface RouteDemand {
  /** 下游池 id（不含起点） */
  pondId: string;
  /** 从上一跳过来的闸门；路径首跳缺少闸门时为 null */
  gateId: string | null;
  /** 申请占用量（m³，已沿程折减） */
  volumeM3: number;
  /** 是否断流（闸门关闭或缺失）：到达量按 0 处理但仍挂账申请原量 */
  blocked: boolean;
}

/**
 * 计算一条计划沿路径对各下游池的占用申请。
 * 遇到关闭 / 缺失的闸门后路径断流：断流处按计划量全额挂账（原因「闸门关闭」），
 * 更下游不再申请（水根本到不了）。
 */
export function routeDemands(schedule: Schedule, gates: Gate[]): RouteDemand[] {
  const route = schedule.routePondIds ?? [];
  const demands: RouteDemand[] = [];
  let carry = schedule.volumeM3;
  for (let i = 1; i < route.length; i += 1) {
    const toPondId = route[i];
    const gate = gateBetween(gates, route[i - 1], toPondId);
    if (gate === undefined || gate.openingPct <= 0 || gate.state === '关闭') {
      demands.push({ pondId: toPondId, gateId: gate?.id ?? null, volumeM3: r1(carry), blocked: true });
      break;
    }
    carry = carry * (gate.openingPct / 100);
    demands.push({ pondId: toPondId, gateId: gate.id, volumeM3: r1(carry), blocked: false });
  }
  return demands;
}

/** 占用账引擎输入快照 */
export interface ReconcileInput {
  schedules: Schedule[];
  ponds: Pond[];
  gates: Gate[];
  observations: Observation[];
  /** 现存占用账（走水中 locked 行作为现场事实读入） */
  occupancies: Occupancy[];
  /** 判定超时用的当前日期 YYYY-MM-DD；默认取计划日比较 */
  today: string;
  nowIso: () => string;
}

/** 重排结果 */
export interface ReconcileResult {
  /** 重排后各计划的超时标记（expired 字段需要落库的计划） */
  schedules: Schedule[];
  /** 重排后的占用账（全部行） */
  occupancies: Occupancy[];
  /** 各池容量汇总 */
  pondAccounts: PondAccount[];
  /** 全局汇总 */
  totals: OccupancyTotals;
  /** 本次重排超时释放的计划数 */
  expiredReleases: number;
  /** 本次重排新拿到占用的计划数 */
  grantedCount: number;
  /** 重排后仍在排队的计划数 */
  queuedCount: number;
}

/** 单池容量账 */
export interface PondAccount {
  pondId: string;
  /** 有效体积 */
  capacityM3: number;
  /** 当前存量（水位折算） */
  storageM3: number;
  /** 可用容量 */
  availableM3: number;
  /** 已占容量（granted + locked） */
  occupiedM3: number;
  /** 账面剩余（可用 − 已占，locked 现场事实可能为负） */
  remainingM3: number;
  /** 排队缺口（排队申请 − 账面剩余，排队池 > 0） */
  shortfallM3: number;
  /** 排队量（排队申请合计） */
  queuedM3: number;
}

export interface OccupancyTotals {
  occupiedM3: number;
  shortfallM3: number;
  queuedM3: number;
  capacityM3: number;
}

interface QueueEntry {
  schedule: Schedule;
  demands: RouteDemand[];
  /** 计划日已过仍未执行：原占用已超时释放，本次按新申请排队 */
  expired: boolean;
}

/** 计划是否已超时：计划日已过且仍未执行 */
export function isScheduleExpired(schedule: Schedule, todayDate: string): boolean {
  if (!PENDING_STATES.includes(schedule.state)) return false;
  return schedule.planDate < todayDate;
}

/** 排队顺序：状态优先级（走水中 > 已排 > 待排），同状态按提交顺序 */
function queueRank(a: QueueEntry, b: QueueEntry): number {
  const rankDiff = SCHEDULE_PRIORITY_RANK[a.schedule.state] - SCHEDULE_PRIORITY_RANK[b.schedule.state];
  if (rankDiff !== 0) return rankDiff;
  const timeDiff = a.schedule.createdAt.localeCompare(b.schedule.createdAt);
  if (timeDiff !== 0) return timeDiff;
  return a.schedule.id.localeCompare(b.schedule.id);
}

function makeOccupancy(
  schedule: Schedule,
  demand: RouteDemand,
  granted: boolean,
  locked: boolean,
  reason: OccupancyReason | null,
  shortfallM3: number,
  stamp: string,
): Occupancy {
  return {
    id: occupancyId(schedule.id, demand.pondId),
    scheduleId: schedule.id,
    pondId: demand.pondId,
    gateId: demand.gateId,
    volumeM3: demand.volumeM3,
    granted,
    locked,
    reason,
    shortfallM3: r1(shortfallM3),
    createdAt: stamp,
    updatedAt: stamp,
    revision: 3,
  };
}

/**
 * 重算全部占用账（纯函数，不落库）。
 * 调用方负责在 Dexie 事务内持久化，并在失败时恢复快照后重试（见 db.reconcileAndPersist）。
 */
export function reconcileOccupancies(input: ReconcileInput): ReconcileResult {
  const stamp = input.nowIso();
  const existing = new Map(input.occupancies.map((row) => [row.id, row]));

  // 各池账面剩余：从「可用容量」起扣
  const remaining = new Map<string, number>();
  const pondAccounts = new Map<string, PondAccount>();
  for (const pond of input.ponds) {
    const level = latestLevelCm(pond.id, input.observations);
    const available = availableOf(pond, level);
    remaining.set(pond.id, available);
    pondAccounts.set(pond.id, {
      pondId: pond.id,
      capacityM3: capacityOf(pond),
      storageM3: storageOf(pond, level),
      availableM3: available,
      occupiedM3: 0,
      remainingM3: available,
      shortfallM3: 0,
      queuedM3: 0,
    });
  }

  let expiredReleases = 0;
  let grantedCount = 0;
  let queuedCount = 0;
  const nextRows: Occupancy[] = [];
  const queuedBySchedule = new Set<string>();
  const grantedBySchedule = new Set<string>();

  // 1) 现场事实优先：走水中计划的现存 locked 占用照旧扣账（可能导致剩余为负 = 现场已溢流）
  const running = input.schedules.filter((row) => LOCKED_STATES.includes(row.state));
  for (const schedule of running) {
    const demands = routeDemands(schedule, input.gates);
    for (const demand of demands) {
      const account = pondAccounts.get(demand.pondId);
      const old = existing.get(occupancyId(schedule.id, demand.pondId));
      if (old !== undefined) {
        // 已在走水中：占用账照旧（含 granted / reason / 旧路径），只同步 updatedAt
        const kept: Occupancy = { ...old, locked: true, updatedAt: stamp, revision: 3 };
        nextRows.push(kept);
        if (account !== undefined) {
          account.occupiedM3 = r1(account.occupiedM3 + kept.volumeM3);
          remaining.set(demand.pondId, (remaining.get(demand.pondId) ?? 0) - kept.volumeM3);
        }
      } else {
        // 刚从「已排」推进到「走水中」：现场补账，按申请量全额锁定
        const row = makeOccupancy(schedule, demand, true, true, null, 0, stamp);
        nextRows.push(row);
        if (account !== undefined) {
          account.occupiedM3 = r1(account.occupiedM3 + row.volumeM3);
          remaining.set(demand.pondId, (remaining.get(demand.pondId) ?? 0) - row.volumeM3);
        }
      }
    }
  }

  // 2) 未执行计划排队重排（已出卤不参与 = 释放占用）
  const queue: QueueEntry[] = [];
  for (const schedule of input.schedules) {
    if (!PENDING_STATES.includes(schedule.state)) continue;
    const expired = isScheduleExpired(schedule, input.today);
    if (expired && !schedule.expired) expiredReleases += 1;
    queue.push({ schedule, demands: routeDemands(schedule, input.gates), expired });
  }
  queue.sort(queueRank);

  // 重排后计划的 expired 标记：拿到占用即清零，仍排队则按超时判定
  const nextExpired = new Map<string, boolean>();

  for (const entry of queue) {
    const { schedule, demands, expired } = entry;
    // 超时只影响本次重排起点（原占用视为已释放，从空账参与排队）；
    // 真能拿到占用时说明已重新排上，清除超时标记；否则保持超时挂账。
    let feasible = true;
    const needs: Array<{ demand: RouteDemand; gap: number }> = [];
    for (const demand of demands) {
      const left = remaining.get(demand.pondId) ?? 0;
      if (demand.blocked) {
        feasible = false;
        needs.push({ demand, gap: demand.volumeM3 });
        continue;
      }
      const gap = demand.volumeM3 - left;
      if (gap > EPS) {
        feasible = false;
        needs.push({ demand, gap: r1(gap) });
      } else {
        needs.push({ demand, gap: 0 });
      }
    }

    if (feasible) {
      // 有下游申请则逐池预占扣账；无下游（路径仅起点 / 末端出卤池）视为已批、不产生占用行
      for (const demand of demands) {
        const row = makeOccupancy(schedule, demand, true, false, null, 0, stamp);
        nextRows.push(row);
        const left = (remaining.get(demand.pondId) ?? 0) - demand.volumeM3;
        remaining.set(demand.pondId, left);
        const account = pondAccounts.get(demand.pondId);
        if (account !== undefined) account.occupiedM3 = r1(account.occupiedM3 + demand.volumeM3);
      }
      grantedBySchedule.add(schedule.id);
      grantedCount += 1;
      nextExpired.set(schedule.id, false);
    } else {
      // 整条排队：每个申请池挂一行账
      for (const item of needs) {
        const reason: OccupancyReason = item.demand.blocked ? '闸门关闭' : '容量不足';
        const row = makeOccupancy(schedule, item.demand, false, false, reason, item.gap, stamp);
        nextRows.push(row);
        const account = pondAccounts.get(item.demand.pondId);
        if (account !== undefined) {
          account.queuedM3 = r1(account.queuedM3 + item.demand.volumeM3);
          account.shortfallM3 = r1(account.shortfallM3 + item.gap);
        }
      }
      queuedBySchedule.add(schedule.id);
      queuedCount += 1;
      nextExpired.set(schedule.id, expired);
    }
  }

  // 3) 汇总各池剩余 / 缺口
  const accounts: PondAccount[] = [];
  let totals: OccupancyTotals = { occupiedM3: 0, shortfallM3: 0, queuedM3: 0, capacityM3: 0 };
  for (const account of pondAccounts.values()) {
    account.remainingM3 = r1((remaining.get(account.pondId) ?? account.availableM3));
    if (account.remainingM3 < 0 && account.queuedM3 <= EPS) {
      // 现场事实把池子顶爆但没有排队条目时，负值本身就是缺口提示
      account.shortfallM3 = r1(Math.max(account.shortfallM3, -account.remainingM3));
    }
    accounts.push(account);
    totals.occupiedM3 = r1(totals.occupiedM3 + account.occupiedM3);
    totals.shortfallM3 = r1(totals.shortfallM3 + account.shortfallM3);
    totals.queuedM3 = r1(totals.queuedM3 + account.queuedM3);
    totals.capacityM3 = r1(totals.capacityM3 + account.capacityM3);
  }
  accounts.sort((a, b) => b.occupiedM3 + b.queuedM3 - (a.occupiedM3 + a.queuedM3));

  const schedules = input.schedules.map((schedule) =>
    nextExpired.has(schedule.id) ? { ...schedule, expired: nextExpired.get(schedule.id) as boolean } : schedule,
  );

  return {
    schedules,
    occupancies: nextRows,
    pondAccounts: accounts,
    totals,
    expiredReleases,
    grantedCount,
    queuedCount,
  };
}

/* ------------------------------ 路径枚举（UI 用） ------------------------------ */

export interface RouteOption {
  /** 路径上的 pondId 序列（含起点） */
  pondIds: string[];
  /** 路径是否全程畅通（无关闭 / 缺失闸门） */
  open: boolean;
}

/** 邻接表（仅保留下游方向） */
function adjacency(gates: Gate[]): Map<string, Array<{ toPondId: string; open: boolean }>> {
  const map = new Map<string, Array<{ toPondId: string; open: boolean }>>();
  for (const gate of gates) {
    const list = map.get(gate.fromPondId) ?? [];
    list.push({ toPondId: gate.toPondId, open: gate.openingPct > 0 && gate.state !== '关闭' });
    map.set(gate.fromPondId, list);
  }
  return map;
}

/**
 * 枚举起点池的全部简单下游路径（BFS，防环）。
 * 每条路径在首个断流闸处终止（该下游池仍保留在路径里，便于挂账）。
 */
export function enumerateRoutes(fromPondId: string, gates: Gate[], maxHops = 8): RouteOption[] {
  const adj = adjacency(gates);
  const options: RouteOption[] = [{ pondIds: [fromPondId], open: true }];
  const queue: Array<{ pondIds: string[]; open: boolean }> = [{ pondIds: [fromPondId], open: true }];
  while (queue.length > 0) {
    const current = queue.shift() as { pondIds: string[]; open: boolean };
    if (current.pondIds.length - 1 >= maxHops) continue;
    const nextList = adj.get(current.pondIds[current.pondIds.length - 1]) ?? [];
    for (const next of nextList) {
      if (current.pondIds.includes(next.toPondId)) continue;
      const option = { pondIds: [...current.pondIds, next.toPondId], open: current.open && next.open };
      options.push(option);
      // 断流后不再继续向下枚举
      if (option.open) queue.push(option);
    }
  }
  return options;
}

/** 取默认走水路径：畅通路径中最长（到最下游）者；无畅通路径则退回仅起点 */
export function defaultRoute(fromPondId: string, gates: Gate[]): string[] {
  const options = enumerateRoutes(fromPondId, gates).filter((option) => option.open);
  if (options.length === 0) return [fromPondId];
  return options.reduce((best, option) => (option.pondIds.length > best.pondIds.length ? option : best)).pondIds;
}

/** 规范化路径：必须以起点开头、相邻池之间存在闸门；非法时退回默认路径 */
export function normalizeRoute(fromPondId: string, routePondIds: string[] | undefined, gates: Gate[]): string[] {
  const candidate = routePondIds ?? [];
  if (candidate[0] !== fromPondId) return defaultRoute(fromPondId, gates);
  for (let i = 1; i < candidate.length; i += 1) {
    if (gateBetween(gates, candidate[i - 1], candidate[i]) === undefined) return defaultRoute(fromPondId, gates);
  }
  return candidate;
}
