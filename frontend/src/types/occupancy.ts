/**
 * 池容占用账（Occupancy）
 * 走水计划按路径与计划量预占下游蒸发池容量时产生的台账行：
 * - granted=true：已拿到该下游池的容量占用（走水中后转为 locked 现场事实，重排照旧）
 * - granted=false：容量不足或路径断流，条目挂账排队，留在待批区
 * 一条走水计划在路径上的每个下游池各有一行，主键由 scheduleId + pondId 派生。
 */

/** 占用排队原因（容量不足 / 闸关闭断流） */
export type OccupancyReason = '容量不足' | '闸门关闭'

export interface Occupancy {
  id: string
  /** 所属走水计划 */
  scheduleId: string
  /** 被占用（或申请占用）的下游池 */
  pondId: string
  /** 到达该池经过的闸门 id（断流挂账时为关闭的闸） */
  gateId: string | null
  /** 占用量 / 排队申请量（m³，已按沿程闸门开度折减） */
  volumeM3: number
  /** 是否已批占用：false 表示挂账排队（待批区） */
  granted: boolean
  /** 现场锁定：走水中计划的占用为现场事实，重算时一律照旧 */
  locked: boolean
  /** 排队原因，仅 granted=false 时有值 */
  reason: OccupancyReason | null
  /** 该池容量缺口（m³），仅排队挂账时大于 0 */
  shortfallM3: number
  createdAt: string
  updatedAt: string
  revision: number
}
