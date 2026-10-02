/**
 * 演示数据播种（幂等）
 * 父 → 子 → 孙三层链路：蒸发池 → 闸门串级 / 卤水日观测 → 离子组分分析 → 走水编排 → 池容占用账
 * 所有 id 固定，保证 /gates、/observations、/assays、/schedules 打开就有真实串级与数据。
 */
import { db, ROW_REVISION } from './db';
import type { Pond } from '../types/pond';
import type { Gate } from '../types/gate';
import type { Observation } from '../types/observation';
import type { Assay } from '../types/assay';
import type { Schedule } from '../types/schedule';
import type { Occupancy } from '../types/occupancy';
import { autoVerdict, estimateEvapMm } from './brine';
import { allocateOccupancy, buildDesiredOccupancies, latestLevels } from './occupancy';

const SEED_TIME = '2026-09-01T00:30:00.000Z';

/** 占用评估基准日：与「今天」对齐，保证演示数据的超时 / 排队状态开箱即见 */
const SEED_TODAY = '2026-10-02';

/** 固定 id，便于文档与深链验证 */
export const SEED_IDS = {
  pondA: 'pond-north-01',
  pondB: 'pond-north-02',
  pondC: 'pond-north-03',
  pondD: 'pond-south-04',
  pondE: 'pond-south-05',
} as const;

function wrap<T>(row: Omit<T, 'createdAt' | 'updatedAt' | 'revision'>): T {
  return { ...row, createdAt: SEED_TIME, updatedAt: SEED_TIME, revision: ROW_REVISION } as T;
}

/** 生成观测记录，evapMm 由经验公式估算 */
function observation(
  id: string,
  pondId: string,
  date: string,
  densityGcm3: number,
  tempC: number,
  levelCm: number,
  windLevel: number,
): Observation {
  return wrap<Observation>({
    id,
    pondId,
    date,
    densityGcm3,
    tempC,
    levelCm,
    windLevel,
    evapMm: estimateEvapMm(densityGcm3, tempC, levelCm, windLevel),
  });
}

/** 生成化验记录，verdict 默认自动判定 */
function assay(
  id: string,
  pondId: string,
  date: string,
  liGpl: number,
  kGpl: number,
  mgGpl: number,
  naGpl: number,
  labName: string,
  manual?: { verdict: Assay['verdict']; verdictManual: true },
): Assay {
  return wrap<Assay>({
    id,
    pondId,
    date,
    liGpl,
    kGpl,
    mgGpl,
    naGpl,
    labName,
    verdict: manual?.verdict ?? autoVerdict(liGpl, kGpl),
    verdictManual: manual?.verdictManual ?? false,
  });
}

/** 走水计划的便捷构造（占用取消标记默认关闭，createdAt 可显式指定用于演示排队顺序） */
function schedule(
  id: string,
  pondId: string,
  planDate: string,
  targetDensity: number,
  volumeM3: number,
  operator: string,
  state: Schedule['state'],
  orderIndex: number,
  createdAt: string = SEED_TIME,
  holdCancelledAt: string | null = null,
): Schedule {
  return {
    id,
    pondId,
    planDate,
    targetDensity,
    volumeM3,
    operator,
    state,
    orderIndex,
    holdCancelledAt,
    createdAt,
    updatedAt: SEED_TIME,
    revision: ROW_REVISION,
  };
}

export async function seedDatabase(): Promise<void> {
  const exists = await db.ponds.count();
  if (exists > 0) return;

  // ---------------- 蒸发池（5 口，跨 2 个池系、3 个阶段） ----------------
  const ponds: Pond[] = [
    wrap<Pond>({ id: SEED_IDS.pondA, code: '北-01', seriesName: '北部一系', areaM2: 12000, depthCm: 45, stage: '钠盐', status: '在用' }),
    wrap<Pond>({ id: SEED_IDS.pondB, code: '北-02', seriesName: '北部一系', areaM2: 9000, depthCm: 40, stage: '钾盐', status: '在用' }),
    wrap<Pond>({ id: SEED_IDS.pondC, code: '北-03', seriesName: '北部一系', areaM2: 6800, depthCm: 35, stage: '锂盐', status: '在用' }),
    wrap<Pond>({ id: SEED_IDS.pondD, code: '南-04', seriesName: '南部二系', areaM2: 15000, depthCm: 50, stage: '钠盐', status: '在用' }),
    wrap<Pond>({ id: SEED_IDS.pondE, code: '南-05', seriesName: '南部二系', areaM2: 7200, depthCm: 38, stage: '钾盐', status: '清池中' }),
  ];

  // ---------------- 闸门串级（上游 → 下游，形成完整走向链） ----------------
  const gates: Gate[] = [
    wrap<Gate>({ id: 'gate-a-b', fromPondId: SEED_IDS.pondA, toPondId: SEED_IDS.pondB, openingPct: 65, widthCm: 120, state: '半开', note: '北部一系主走水通道' }),
    wrap<Gate>({ id: 'gate-b-c', fromPondId: SEED_IDS.pondB, toPondId: SEED_IDS.pondC, openingPct: 40, widthCm: 100, state: '半开', note: '进入锂盐阶段前的控流闸' }),
    wrap<Gate>({ id: 'gate-d-e', fromPondId: SEED_IDS.pondD, toPondId: SEED_IDS.pondE, openingPct: 80, widthCm: 140, state: '半开', note: '南部二系主走水通道' }),
    wrap<Gate>({ id: 'gate-b-e', fromPondId: SEED_IDS.pondB, toPondId: SEED_IDS.pondE, openingPct: 0, widthCm: 90, state: '关闭', note: '跨池系调水备用闸，当前关闭' }),
  ];

  // ---------------- 卤水日观测（每池 2–4 条，密度随日期递增） ----------------
  const observations: Observation[] = [
    observation('obs-a1', SEED_IDS.pondA, '2026-08-20', 1.045, 28, 45, 2),
    observation('obs-a2', SEED_IDS.pondA, '2026-08-30', 1.062, 30, 43, 3),
    observation('obs-a3', SEED_IDS.pondA, '2026-09-10', 1.086, 29, 41, 2),
    observation('obs-a4', SEED_IDS.pondA, '2026-09-22', 1.108, 26, 39, 3),
    observation('obs-b1', SEED_IDS.pondB, '2026-08-22', 1.112, 27, 40, 2),
    observation('obs-b2', SEED_IDS.pondB, '2026-09-02', 1.14, 29, 38, 3),
    observation('obs-b3', SEED_IDS.pondB, '2026-09-14', 1.168, 28, 36, 2),
    observation('obs-c1', SEED_IDS.pondC, '2026-08-25', 1.195, 26, 35, 1),
    observation('obs-c2', SEED_IDS.pondC, '2026-09-05', 1.222, 27, 33, 2),
    observation('obs-c3', SEED_IDS.pondC, '2026-09-18', 1.248, 25, 31, 2),
    observation('obs-d1', SEED_IDS.pondD, '2026-08-21', 1.038, 30, 50, 4),
    observation('obs-d2', SEED_IDS.pondD, '2026-09-01', 1.055, 31, 48, 3),
    observation('obs-d3', SEED_IDS.pondD, '2026-09-12', 1.074, 29, 46, 2),
    observation('obs-d4', SEED_IDS.pondD, '2026-09-24', 1.092, 27, 44, 3),
    observation('obs-e1', SEED_IDS.pondE, '2026-08-24', 1.12, 28, 38, 2),
    observation('obs-e2', SEED_IDS.pondE, '2026-09-04', 1.146, 29, 36, 2),
  ];

  // ---------------- 离子组分分析（含达标 / 接近 / 未达标三种判定） ----------------
  const assays: Assay[] = [
    assay('assay-a1', SEED_IDS.pondA, '2026-09-22', 0.12, 6.4, 42.5, 88.2, '盐湖中心化验室'),
    assay('assay-b1', SEED_IDS.pondB, '2026-09-14', 0.72, 15.5, 21.8, 58.4, '盐湖中心化验室'),
    assay('assay-c1', SEED_IDS.pondC, '2026-09-05', 1.05, 18.2, 9.6, 26.1, '盐湖中心化验室'),
    assay('assay-c2', SEED_IDS.pondC, '2026-09-18', 1.32, 22.6, 8.4, 24.3, '盐湖中心化验室'),
    assay('assay-d1', SEED_IDS.pondD, '2026-09-24', 0.08, 4.2, 48.9, 96.5, '南部化验站'),
    assay('assay-e1', SEED_IDS.pondE, '2026-09-04', 0.48, 13.6, 24.2, 61.7, '南部化验站', {
      verdict: '接近',
      verdictManual: true,
    }),
  ];

  // ---------------- 走水编排（覆盖已批占用 / 排队 / 取消 / 超时 / 现场事实） ----------------
  // 排队顺序：已排优先于待排，同状态按 createdAt；北-02 / 南-05 空余有限，后批计划会排队。
  const schedules: Schedule[] = [
    schedule('schedule-a1', SEED_IDS.pondA, '2026-10-02', 1.115, 250, '韩江', '已排', 1, '2026-09-25T08:00:00.000Z'),
    schedule('schedule-d1', SEED_IDS.pondD, '2026-10-04', 1.098, 120, '王锐', '已排', 2, '2026-09-25T08:20:00.000Z'),
    schedule('schedule-b1', SEED_IDS.pondB, '2026-10-06', 1.175, 700, '韩江', '已排', 3, '2026-09-26T09:00:00.000Z'),
    schedule('schedule-a2', SEED_IDS.pondA, '2026-10-08', 1.12, 1500, '韩江', '待排', 4, '2026-09-28T10:00:00.000Z'),
    schedule('schedule-b2', SEED_IDS.pondB, '2026-10-09', 1.18, 600, '李文', '待排', 5, '2026-09-28T11:00:00.000Z'),
    schedule('schedule-d2', SEED_IDS.pondD, '2026-10-10', 1.1, 1100, '王锐', '待排', 6, '2026-09-29T09:30:00.000Z'),
    schedule('schedule-d3', SEED_IDS.pondD, '2026-10-11', 1.102, 300, '王锐', '待排', 7, '2026-09-29T10:00:00.000Z'),
    schedule('schedule-a3', SEED_IDS.pondA, '2026-10-12', 1.125, 1000, '韩江', '待排', 8, '2026-09-30T08:00:00.000Z', '2026-09-30T12:00:00.000Z'),
    schedule('schedule-d4', SEED_IDS.pondD, '2026-09-27', 1.095, 1400, '王锐', '待排', 9, '2026-09-20T08:00:00.000Z'),
    schedule('schedule-run1', SEED_IDS.pondB, '2026-10-01', 1.172, 500, '韩江', '走水中', 10, '2026-09-24T08:00:00.000Z'),
    schedule('schedule-e1', SEED_IDS.pondE, '2026-09-28', 1.15, 700, '王锐', '已出卤', 11, '2026-09-18T08:00:00.000Z'),
  ];

  // ---------------- 池容占用账（由占用引擎按池容 / 水位 / 闸门 / 计划量算出） ----------------
  const allocation = allocateOccupancy({
    ponds,
    gates,
    schedules,
    levelsByPond: latestLevels(observations),
    occupancies: [],
    today: SEED_TODAY,
  });
  const occupancies: Occupancy[] = buildDesiredOccupancies(allocation, schedules, [], SEED_TIME, ROW_REVISION);

  await db.transaction(
    'rw',
    [db.ponds, db.gates, db.observations, db.assays, db.schedules, db.occupancies],
    async () => {
      await db.ponds.bulkPut(ponds);
      await db.gates.bulkPut(gates);
      await db.observations.bulkPut(observations);
      await db.assays.bulkPut(assays);
      await db.schedules.bulkPut(schedules);
      await db.occupancies.bulkPut(occupancies);
    },
  );
}
