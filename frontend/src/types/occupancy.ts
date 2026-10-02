/**
 * 池容占用账（Occupancy）
 * 走水计划按走水路径与计划量预占下游池容量：
 * - 容量充足：按路径逐池预占，进入「已批占用」；
 * - 容量不足：不写入占用，留在待批区排队（同状态按提交顺序）；
 * - 取消 / 超时：释放占用，后续排队条目自动重排补位；
 * - 水位 / 闸门开度变化：只重算未执行计划的占用，现场事实（走水中 / 已出卤）照旧。
 */
import type { ScheduleState } from './schedule';

/**
 * 走水计划的占用状态（派生值）：
 * - 已批占用：路径上各下游池均已预占；
 * - 排队中：容量不足，未拿到占用，留在待批区；
 * - 已取消：调度员主动取消预占（计划本身保留，可恢复）；
 * - 已超时：计划日期超过宽限期仍未执行，占用已释放；
 * - 走水中 / 已出卤：现场事实，不参与重算（其占用账为历史台账）；
 * - 无下游：源池处于串级末端，直接排走，无下游可占。
 */
export type HoldState = '已批占用' | '排队中' | '已取消' | '已超时' | '走水中' | '已出卤' | '无下游';

/** 未执行（仍参与占用重算）的状态 */
export const PENDING_EXECUTION_STATES: ScheduleState[] = ['待排', '已排'];

/** 占用账中的一条池级预占记录（一条计划对路径上每口下游池各一条） */
export interface Occupancy {
  id: string
  /** 关联走水计划 */
  scheduleId: string
  /** 被预占的下游池 */
  pondId: string
  /** 走水路径上的第几级下游（从 1 开始） */
  hop: number
  /** 预占容量（m³），按计划量 × 该路径分摊比例 */
  reservedM3: number
  /** 预占时该池剩余容量快照（m³） */
  freeAtReserveM3: number
  /** 预占时间 */
  createdAt: string
  updatedAt: string
  revision: number
}

/** 走水路径上的一跳 */
export interface PathHop {
  /** 下游池 */
  pondId: string
  /** 途经闸门（无闸门时为 null，表示直排末端外） */
  gateId: string | null
  /** 该池收到的计划量分摊比例（0–1） */
  share: number
  /** 该级闸门开度（%） */
  openingPct: number
  /** 第几级下游（从 1 开始） */
  hop: number
}

/** 单条计划的占用评估结果 */
export interface AllocationEntry {
  scheduleId: string
  /** 走水路径（末端出卤不占用池容，路径为空表示无下游） */
  path: PathHop[]
  /** 评估后的占用状态 */
  holdState: HoldState
  /** 已批占用时各下游池的预占量；排队时为计划尝试预占量 */
  reserves: Array<{ pondId: string; hop: number; reservedM3: number }>
  /** 未满足的容量缺口（m³）：按池汇总后再按计划聚合，取最大缺口 */
  shortfallM3: number
  /** 各池缺口明细 */
  pondShortfalls: Array<{ pondId: string; gapM3: number }>
  /** 是否超时未执行 */
  timedOut: boolean
  /** 是否被调度员取消预占 */
  cancelled: boolean
}

/** 单口下游池的占用账汇总 */
export interface PondLedger {
  pondId: string
  /** 有效池容（m³） */
  capacityM3: number
  /** 当前存量（m³，按最近水位观测折算） */
  storedM3: number
  /** 空余容量（m³） */
  freeM3: number
  /** 未执行计划已预占容量（m³） */
  reservedM3: number
  /** 现场在走水 / 已出卤计划的占用台账量（m³，仅展示，不重复扣减容量） */
  factualM3: number
  /** 已占容量 = 存量 + 未执行预占（m³） */
  occupiedM3: number
  /** 缺口：排队条目对该池的尝试预占 - 当前空余（m³，≥0） */
  gapM3: number
  /** 占用率（%，0–100） */
  occupiedPct: number
}

/** 占用账汇总（顶部徽标使用） */
export interface OccupancySummary {
  /** 未执行计划已预占容量合计（m³） */
  reservedTotalM3: number
  /** 全部下游池缺口合计（m³） */
  gapTotalM3: number
  /** 排队条目计划量合计（m³） */
  queuedVolumeM3: number
  /** 排队条目数 */
  queuedCount: number
  /** 已批占用条目数 */
  heldCount: number
  /** 超时条目数 */
  timedOutCount: number
  /** 取消条目数 */
  cancelledCount: number
}

/** 占用引擎完整分配结果 */
export interface AllocationResult {
  entries: AllocationEntry[]
  ledgers: Record<string, PondLedger>
  summary: OccupancySummary
}
