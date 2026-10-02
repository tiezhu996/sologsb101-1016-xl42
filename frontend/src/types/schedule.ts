/**
 * 走水编排（Schedule）
 * 按日期排序的走水与出卤计划，可通过拖拽调整先后顺序。
 */

/** 走水状态：待排 / 已排 / 走水中 / 已出卤 */
export type ScheduleState = '待排' | '已排' | '走水中' | '已出卤'

export const SCHEDULE_STATE_OPTIONS: ScheduleState[] = ['待排', '已排', '走水中', '已出卤']

/** 状态推进顺序 */
export const SCHEDULE_STATE_FLOW: ScheduleState[] = ['待排', '已排', '走水中', '已出卤']

/**
 * 排队优先级：已走水的现场状态（走水中）高于未执行计划；
 * 同状态之间按提交顺序（createdAt）排队。
 * 已出卤已完成、不再占用池容，不参与排队。
 */
export const SCHEDULE_PRIORITY_RANK: Record<ScheduleState, number> = {
  走水中: 0,
  已排: 1,
  待排: 2,
  已出卤: 9,
}

/** 未执行（占用量可随水位 / 开度重算）的状态 */
export const PENDING_STATES: ScheduleState[] = ['待排', '已排']

/** 已走水（占用为现场事实，重算照旧）的状态 */
export const LOCKED_STATES: ScheduleState[] = ['走水中']

export interface Schedule {
  id: string
  /** 所属蒸发池（路径起点） */
  pondId: string
  /**
   * 走水路径：从起点池到最下游池的 pondId 序列（含起点）。
   * 计划沿路径在每个下游池预占容量；空数组等价于「仅本池、无下游占用」。
   */
  routePondIds: string[]
  /** 计划走水日期 YYYY-MM-DD */
  planDate: string
  /** 目标密度（g/cm³） */
  targetDensity: number
  /** 计划量（m³） */
  volumeM3: number
  /** 调度员 */
  operator: string
  /** 走水状态 */
  state: ScheduleState
  /** 手工拖拽后的排序序号，越小越先走水 */
  orderIndex: number
  /** 占用是否已超时释放（计划日已过仍未执行），重排成功后自动清零 */
  expired: boolean
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑走水编排的表单草稿 */
export interface ScheduleDraft {
  pondId: string
  routePondIds: string[]
  planDate: string
  targetDensity: number
  volumeM3: number
  operator: string
  state: ScheduleState
  orderIndex: number
  expired: boolean
}
