/**
 * /schedules 走水与出卤编排（接入池容占用账）
 * - 计划按走水路径与计划量预占下游容量；容量不足按「已排优先、同状态按提交顺序」排队，留在待批区；
 * - 取消 / 超时释放占用；走水中 / 已出卤为现场事实，不参与重算；
 * - 顶部与池容账面板汇总已占容量、缺口与排队量。
 * 消费模型：Schedule、Gate、Occupancy；复用组件：<FilterBar>、<EmptyPanel>、<StatBadge>
 */
import { For, Show, createMemo, createSignal, onMount } from 'solid-js';
import { createStore } from 'solid-js/store';
import AppDialog from '../components/common/AppDialog';
import EmptyPanel from '../components/common/EmptyPanel';
import FilterBar from '../components/common/FilterBar';
import StatBadge from '../components/common/StatBadge';
import StageTag from '../components/common/StageTag';
import { usePondStore } from '../stores/pondStore';
import { useScheduleStore } from '../stores/scheduleStore';
import { useOccupancyStore } from '../stores/occupancyStore';
import { SCHEDULE_STATE_OPTIONS, type Schedule, type ScheduleDraft, type ScheduleState } from '../types/schedule';
import type { HoldState } from '../types/occupancy';
import { today } from '../utils/id';

const INPUT =
  'w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-brine-500 focus:ring-1 focus:ring-brine-400';
const BTN_PRIMARY =
  'rounded-md bg-brine-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-brine-700 disabled:opacity-50';
const BTN_GHOST =
  'rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-sm text-slate-700 transition hover:bg-slate-100';

const STATE_STYLE: Record<ScheduleState, string> = {
  待排: 'border-slate-300 bg-slate-100 text-slate-600',
  已排: 'border-sky-300 bg-sky-50 text-sky-700',
  走水中: 'border-amber-300 bg-amber-50 text-amber-700',
  已出卤: 'border-emerald-300 bg-emerald-50 text-emerald-700',
};

const HOLD_STYLE: Record<HoldState, string> = {
  已批占用: 'border-emerald-300 bg-emerald-50 text-emerald-700',
  排队中: 'border-rose-300 bg-rose-50 text-rose-700',
  已取消: 'border-slate-300 bg-slate-100 text-slate-500',
  已超时: 'border-orange-300 bg-orange-50 text-orange-700',
  走水中: 'border-amber-300 bg-amber-50 text-amber-700',
  已出卤: 'border-emerald-300 bg-emerald-50 text-emerald-700',
  无下游: 'border-slate-300 bg-slate-50 text-slate-500',
};

function emptyDraft(pondId: string, orderIndex: number): ScheduleDraft {
  return {
    pondId,
    planDate: today(),
    targetDensity: 1.15,
    volumeM3: 800,
    operator: '',
    state: '待排',
    orderIndex,
  };
}

export default function ScheduleBoard() {
  const pondStore = usePondStore();
  const scheduleStore = useScheduleStore();
  const occupancyStore = useOccupancyStore();

  const [dialogOpen, setDialogOpen] = createSignal(false);
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [deleting, setDeleting] = createSignal<Schedule | null>(null);
  const [dragOverId, setDragOverId] = createSignal<string | null>(null);
  const [draft, setDraft] = createStore<ScheduleDraft>(emptyDraft('', 1));

  onMount(() => {
    void pondStore.loadAll();
  });

  const pondOf = (pondId: string) => pondStore.state.ponds.find((pond) => pond.id === pondId) ?? null;
  const pondCode = (pondId: string): string => pondOf(pondId)?.code ?? '（池已删除）';
  const pondLabel = (pondId: string): string => {
    const pond = pondOf(pondId);
    return pond === null ? '（池已删除）' : `${pond.code} · ${pond.seriesName}`;
  };

  const summary = () => occupancyStore.state.result?.summary ?? null;

  const ordered = createMemo<Schedule[]>(() =>
    [...scheduleStore.state.rows].sort((a, b) => a.orderIndex - b.orderIndex || a.createdAt.localeCompare(b.createdAt)),
  );

  const matchFilters = (row: Schedule): boolean => {
    const current = scheduleStore.filters();
    const series = pondStore.state.currentSeries;
    const keyword = current.keyword.trim().toLowerCase();
    const pond = pondOf(row.pondId);
    if (series !== null && pond?.seriesName !== series) return false;
    if (current.state !== 'all' && row.state !== current.state) return false;
    if (keyword === '') return true;
    return (
      pondLabel(row.pondId).toLowerCase().includes(keyword) ||
      row.operator.toLowerCase().includes(keyword) ||
      row.planDate.includes(keyword)
    );
  };

  const pendingRows = createMemo<Schedule[]>(() =>
    ordered().filter((row) => (row.state === '待排' || row.state === '已排') && matchFilters(row)),
  );
  const factualRows = createMemo<Schedule[]>(() =>
    ordered().filter((row) => (row.state === '走水中' || row.state === '已出卤') && matchFilters(row)),
  );

  /** 排队序号（容量不足条目在待批区里的先后） */
  const queuePosition = createMemo<Map<string, number>>(() => {
    const map = new Map<string, number>();
    let position = 0;
    occupancyStore.state.result?.entries.forEach((entry) => {
      if (entry.holdState === '排队中') {
        position += 1;
        map.set(entry.scheduleId, position);
      }
    });
    return map;
  });

  /** 下游池容占用账：只展示有进水闸门的池 */
  const downstreamLedgers = createMemo(() => {
    const downstreamIds = new Set(pondStore.state.gates.map((gate) => gate.toPondId));
    return Object.values(occupancyStore.state.result?.ledgers ?? {})
      .filter((ledger) => downstreamIds.has(ledger.pondId))
      .sort((a, b) => pondCode(a.pondId).localeCompare(pondCode(b.pondId), 'zh-Hans-CN'));
  });

  const stats = createMemo(() => {
    const list = ordered();
    return {
      total: list.length,
      pending: list.filter((row) => row.state === '待排').length,
      running: list.filter((row) => row.state === '走水中').length,
      done: list.filter((row) => row.state === '已出卤').length,
      volume: Math.round(list.reduce((acc, row) => acc + row.volumeM3, 0) * 10) / 10,
      donePct: list.length === 0 ? 0 : Math.round((list.filter((row) => row.state === '已出卤').length / list.length) * 1000) / 10,
    };
  });

  const openCreate = (): void => {
    const pondId = pondStore.pondsOfSeries(pondStore.state.currentSeries)[0]?.id ?? pondStore.state.ponds[0]?.id ?? '';
    setEditingId(null);
    setDraft(emptyDraft(pondId, ordered().length + 1));
    setDialogOpen(true);
  };

  const openEdit = (row: Schedule): void => {
    setEditingId(row.id);
    setDraft({
      pondId: row.pondId,
      planDate: row.planDate,
      targetDensity: row.targetDensity,
      volumeM3: row.volumeM3,
      operator: row.operator,
      state: row.state,
      orderIndex: row.orderIndex,
    });
    setDialogOpen(true);
  };

  const submit = async (): Promise<void> => {
    if (draft.pondId === '') {
      scheduleStore.setMessage('请选择蒸发池');
      return;
    }
    if (editingId() === null) {
      const row = await scheduleStore.createSchedule({ ...draft });
      scheduleStore.setMessage(`已提交走水计划：${row.planDate}，正按下游池容排队占用`);
    } else {
      await scheduleStore.updateSchedule(editingId() as string, { ...draft });
    }
    setDialogOpen(false);
  };

  const confirmDelete = async (): Promise<void> => {
    const row = deleting();
    if (row === null) return;
    await scheduleStore.deleteSchedule(row.id);
    setDeleting(null);
  };

  const handleDrop = async (targetId: string): Promise<void> => {
    const fromId = scheduleStore.draggingId();
    setDragOverId(null);
    scheduleStore.setDraggingId(null);
    if (fromId === null || fromId === targetId) return;
    await scheduleStore.moveBefore(fromId, targetId);
  };

  const nextStateLabel = (state: ScheduleState): string => {
    if (state === '待排') return '标记已排';
    if (state === '已排') return '开始走水';
    if (state === '走水中') return '完成出卤';
    return '已出卤';
  };

  const PathChips = (row: Schedule) => {
    const entry = occupancyStore.entryOf(row.id);
    return (
      <div class="flex flex-wrap items-center gap-1 text-[11px]">
        <span class="text-slate-400">走水路径</span>
        <span class="rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">{pondCode(row.pondId)}</span>
        <Show
          when={entry !== null && entry.path.length > 0}
          fallback={<span class="text-slate-400">→ 末端无下游（直接排走）</span>}
        >
          <For each={entry?.path ?? []}>
            {(hop) => (
              <>
                <span class="text-brine-500">→</span>
                <span class="rounded bg-brine-50 px-1.5 py-0.5 text-brine-700">{pondCode(hop.pondId)}</span>
              </>
            )}
          </For>
        </Show>
      </div>
    );
  };

  const renderRow = (row: Schedule) => {
    const entry = () => occupancyStore.entryOf(row.id);
    const hold = (): HoldState | null => entry()?.holdState ?? null;
    const canStart = (): boolean => hold() === '已批占用' || hold() === '无下游';
    return (
      <li
        draggable={row.state === '待排' || row.state === '已排'}
        class={`flex flex-wrap items-center gap-3 rounded-lg border bg-white px-3.5 py-3 transition ${
          dragOverId() === row.id ? 'border-brine-500 ring-1 ring-brine-400' : 'border-slate-200'
        } ${hold() === '排队中' ? 'border-l-4 border-l-rose-400' : ''} ${
          hold() === '已取消' || hold() === '已超时' ? 'opacity-70' : ''
        }`}
        onDragStart={() => scheduleStore.setDraggingId(row.id)}
        onDragOver={(event) => {
          if (row.state !== '待排' && row.state !== '已排') return;
          event.preventDefault();
          setDragOverId(row.id);
        }}
        onDragLeave={() => setDragOverId(null)}
        onDrop={(event) => {
          event.preventDefault();
          void handleDrop(row.id);
        }}
      >
        <span class="grid h-7 w-7 shrink-0 cursor-grab place-items-center rounded-full bg-slate-100 text-xs font-semibold text-slate-500">
          {row.orderIndex}
        </span>
        <span class="cursor-grab text-slate-300" title="按住拖拽调整提交顺序（同状态排队先后）">
          ⠿
        </span>
        <div class="min-w-[180px] flex-1">
          <p class="text-sm font-medium text-slate-800">{pondLabel(row.pondId)}</p>
          <p class="text-xs text-slate-500">
            计划日期 {row.planDate} · 调度员 {row.operator === '' ? '未填写' : row.operator}
          </p>
          <div class="mt-1">{PathChips(row)}</div>
        </div>
        <div class="flex items-center gap-2">
          <StageTag stage={pondOf(row.pondId)?.stage ?? null} size="sm" />
        </div>
        <div class="text-xs text-slate-600">
          <p>
            目标密度 <span class="tabular-nums font-medium text-slate-800">{row.targetDensity}</span> g/cm³
          </p>
          <p>
            当前密度{' '}
            <span class="tabular-nums font-medium text-brine-700">
              {pondStore.statOf(row.pondId).currentDensity || '—'}
            </span>
          </p>
        </div>
        <div class="text-xs text-slate-600">
          <p>
            计划量 <span class="tabular-nums font-medium text-slate-800">{row.volumeM3}</span> m³
          </p>
          <Show when={hold() === '已批占用'}>
            <p class="text-emerald-700">
              已预占 <span class="tabular-nums font-medium">{entry()?.reserves.reduce((a, r) => a + r.reservedM3, 0) ?? 0}</span> m³
            </p>
          </Show>
          <Show when={hold() === '排队中'}>
            <p class="text-rose-700">
              排队第 <span class="font-medium">{queuePosition().get(row.id) ?? '-'}</span> 位 · 缺口{' '}
              <span class="tabular-nums font-medium">{entry()?.shortfallM3 ?? 0}</span> m³
            </p>
          </Show>
        </div>
        <div class="flex flex-col items-start gap-1">
          <span class={`rounded border px-2 py-0.5 text-[11px] ${STATE_STYLE[row.state]}`}>{row.state}</span>
          <Show when={hold() !== null}>
            <span class={`rounded border px-2 py-0.5 text-[11px] ${HOLD_STYLE[hold()!]}`}>
              {hold()}
              <Show when={hold() === '排队中'}> · #{queuePosition().get(row.id) ?? '-'}</Show>
            </span>
          </Show>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <Show when={row.state !== '已出卤'}>
            <button
              class="rounded-md border border-brine-300 bg-brine-50 px-2.5 py-1 text-xs text-brine-700 transition hover:bg-brine-100 disabled:opacity-50"
              disabled={row.state === '走水中' || (row.state === '已排' && !canStart())}
              title={row.state === '已排' && !canStart() ? '未拿到下游容量占用，不能开始走水' : ''}
              onClick={async () => {
                const next = await scheduleStore.advance(row.id);
                if (next === null) {
                  const h = occupancyStore.entryOf(row.id)?.holdState;
                  scheduleStore.setMessage(
                    h === '排队中' || h === '已取消' || h === '已超时'
                      ? `该计划当前为「${h}」，未拿到下游容量占用，不能开始走水`
                      : '该计划已处于最终状态',
                  );
                }
              }}
            >
              {nextStateLabel(row.state)}
            </button>
          </Show>
          <Show when={hold() === '已批占用' || hold() === '排队中'}>
            <button
              class="rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs text-amber-700 transition hover:bg-amber-100"
              onClick={() => void occupancyStore.cancelHold(row.id)}
            >
              取消预占
            </button>
          </Show>
          <Show when={hold() === '已取消'}>
            <button
              class="rounded-md border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-xs text-emerald-700 transition hover:bg-emerald-100"
              onClick={() => void occupancyStore.restoreHold(row.id)}
            >
              恢复占用
            </button>
          </Show>
          <Show when={hold() === '已超时'}>
            <button
              class="rounded-md border border-orange-300 bg-orange-50 px-2.5 py-1 text-xs text-orange-700 transition hover:bg-orange-100"
              onClick={() => void scheduleStore.requeueExpired(row.id)}
            >
              延期重报
            </button>
          </Show>
          <button class="text-xs text-brine-700 hover:underline" onClick={() => openEdit(row)}>
            编辑
          </button>
          <button class="text-xs text-rose-600 hover:underline" onClick={() => setDeleting(row)}>
            删除
          </button>
        </div>
      </li>
    );
  };

  return (
    <div class="space-y-3.5">
      <div class="flex flex-wrap gap-3">
        <StatBadge label="走水计划" value={stats().total} suffix="条" tone="primary" />
        <StatBadge label="已批占用" value={summary()?.heldCount ?? 0} suffix="条" tone="success" />
        <StatBadge
          label="已占容量"
          value={summary()?.reservedTotalM3 ?? 0}
          suffix="m³"
          tone="info"
          hint="未执行计划在各下游池预占容量合计（现场走水中台账另计，不重复扣减）"
        />
        <StatBadge
          label="容量缺口"
          value={summary()?.gapTotalM3 ?? 0}
          suffix="m³"
          tone="danger"
          hint="排队条目对下游池的未满足预占量合计"
        />
        <StatBadge
          label="排队量"
          value={summary()?.queuedVolumeM3 ?? 0}
          suffix={`m³ · ${summary()?.queuedCount ?? 0} 条`}
          tone="warning"
        />
        <StatBadge label="超时 / 取消" value={`${summary()?.timedOutCount ?? 0} / ${summary()?.cancelledCount ?? 0}`} suffix="条" tone="default" />
        <StatBadge label="出卤完成率" value={`${stats().donePct}%`} percent={stats().donePct} tone="success" />
      </div>

      <Show when={scheduleStore.state.lastMessage !== ''}>
        <div class="rounded-lg border border-brine-200 bg-brine-50 px-3.5 py-2 text-sm text-brine-800">
          {scheduleStore.state.lastMessage}
        </div>
      </Show>
      <Show when={occupancyStore.state.error !== ''}>
        <div class="rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2 text-sm text-rose-700">
          占用账重排失败，已恢复原占用账并重试：{occupancyStore.state.error}
        </div>
      </Show>
      <Show when={occupancyStore.state.rebuilding}>
        <div class="rounded-lg border border-sky-200 bg-sky-50 px-3.5 py-2 text-xs text-sky-700">
          正在按最新水位与闸门开度重排未执行计划的占用账…
        </div>
      </Show>

      <section class="rounded-xl border border-slate-200 bg-white p-4">
        <header class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 class="text-[15px] font-semibold text-slate-800">下游池容占用账</h2>
          <button
            type="button"
            class="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-700 transition hover:bg-slate-100"
            onClick={() => void occupancyStore.requestRebuild('最新水位与开度')}
          >
            立即重算占用
          </button>
        </header>
        <Show
          when={downstreamLedgers().length > 0}
          fallback={<p class="text-sm text-slate-500">还没有下游池：先在 /gates 配置串级闸门。</p>}
        >
          <div class="overflow-x-auto">
            <table class="w-full min-w-[900px] border-collapse text-sm">
              <thead>
                <tr class="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
                  <th class="px-3 py-2">下游池</th>
                  <th class="px-3 py-2 text-right">有效池容</th>
                  <th class="px-3 py-2 text-right">当前存量</th>
                  <th class="px-3 py-2 text-right">未执行预占</th>
                  <th class="px-3 py-2 text-right">现场台账</th>
                  <th class="px-3 py-2 w-48">已占 / 池容</th>
                  <th class="px-3 py-2 text-right">空余</th>
                  <th class="px-3 py-2 text-right">缺口</th>
                </tr>
              </thead>
              <tbody>
                <For each={downstreamLedgers()}>
                  {(ledger) => (
                    <tr class={`border-b border-slate-100 ${ledger.gapM3 > 0 ? 'bg-rose-50/40' : ''}`}>
                      <td class="px-3 py-2.5">
                        <div class="flex items-center gap-2">
                          <span class="font-medium text-slate-800">{pondCode(ledger.pondId)}</span>
                          <StageTag stage={pondOf(ledger.pondId)?.stage ?? null} size="sm" />
                        </div>
                      </td>
                      <td class="px-3 py-2.5 text-right tabular-nums text-slate-600">{ledger.capacityM3}</td>
                      <td class="px-3 py-2.5 text-right tabular-nums text-slate-600">{ledger.storedM3}</td>
                      <td class="px-3 py-2.5 text-right tabular-nums font-medium text-emerald-700">{ledger.reservedM3}</td>
                      <td class="px-3 py-2.5 text-right tabular-nums text-amber-700" title="走水中 / 已出卤计划的历史占用，现场事实照旧">
                        {ledger.factualM3}
                      </td>
                      <td class="px-3 py-2.5">
                        <div class="flex items-center gap-2">
                          <div class="h-1.5 w-24 overflow-hidden rounded-full bg-slate-100">
                            <div
                              class={`h-full rounded-full ${ledger.occupiedPct >= 95 ? 'bg-rose-500' : 'bg-brine-600'}`}
                              style={{ width: `${Math.min(100, ledger.occupiedPct)}%` }}
                            />
                          </div>
                          <span class="w-12 text-right text-xs tabular-nums text-slate-600">{ledger.occupiedPct}%</span>
                        </div>
                      </td>
                      <td class="px-3 py-2.5 text-right tabular-nums text-slate-600">{ledger.freeM3}</td>
                      <td class={`px-3 py-2.5 text-right tabular-nums font-medium ${ledger.gapM3 > 0 ? 'text-rose-600' : 'text-slate-400'}`}>
                        {ledger.gapM3 > 0 ? ledger.gapM3 : '—'}
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
        <p class="mt-2 text-xs leading-relaxed text-slate-400">
          存量按各池最近水位观测折算（面积 × 水位）；水位或闸门开度变化后只重算待排 / 已排计划的占用，
          走水中 / 已出卤的现场台账不重复扣减容量。容量单位均为 m³。
        </p>
      </section>

      <section class="rounded-xl border border-slate-200 bg-white p-4">
        <header class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 class="text-[15px] font-semibold text-slate-800">走水与出卤编排</h2>
          <button type="button" class={BTN_PRIMARY} onClick={openCreate} disabled={pondStore.state.ponds.length === 0}>
            + 新建走水计划
          </button>
        </header>

        <FilterBar
          keyword={scheduleStore.filters().keyword}
          onKeyword={(value) => scheduleStore.patchFilters({ keyword: value })}
          fields={[
            { key: 'series', label: '池系', options: pondStore.seriesOptions() },
            { key: 'state', label: '状态', options: [...SCHEDULE_STATE_OPTIONS] },
          ]}
          values={{ series: pondStore.state.currentSeries ?? 'all', state: scheduleStore.filters().state }}
          onChange={(key, value) => {
            if (key === 'series') pondStore.setCurrentSeries(value === 'all' ? null : value);
            if (key === 'state') scheduleStore.patchFilters({ state: value as ScheduleState | 'all' });
          }}
          onReset={() => {
            scheduleStore.resetFilters();
            pondStore.setCurrentSeries(pondStore.seriesOptions()[0] ?? null);
          }}
          resultText={`待批 ${pendingRows().length} 条 · 现场 ${factualRows().length} 条`}
        />

        <Show when={ordered().length === 0}>
          <EmptyPanel
            title="还没有走水编排"
            description="提交后计划按走水路径与计划量预占下游池容量；容量不足会留在待批区排队（已排优先、同状态按提交顺序），取消或超时自动释放占用。"
            actionText="新建第一条走水计划"
            onAction={openCreate}
          />
        </Show>

        <Show when={ordered().length > 0}>
          <h3 class="mb-2 mt-3 text-[13px] font-semibold text-slate-700">待批区（未执行计划，参与占用重算）</h3>
          <Show when={pendingRows().length === 0}>
            <p class="rounded-lg bg-slate-50 px-3.5 py-3 text-sm text-slate-500">当前筛选下没有未执行计划。</p>
          </Show>
          <ul class="space-y-2">
            <For each={pendingRows()}>{(row) => renderRow(row)}</For>
          </ul>

          <h3 class="mb-2 mt-5 text-[13px] font-semibold text-slate-700">现场事实（走水中 / 已出卤，占用账照旧）</h3>
          <Show when={factualRows().length === 0}>
            <p class="rounded-lg bg-slate-50 px-3.5 py-3 text-sm text-slate-500">暂无现场执行中的走水。</p>
          </Show>
          <ul class="space-y-2">
            <For each={factualRows()}>{(row) => renderRow(row)}</For>
          </ul>
        </Show>
      </section>

      <AppDialog
        open={dialogOpen()}
        title={editingId() === null ? '新建走水计划' : '编辑走水计划'}
        onClose={() => setDialogOpen(false)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setDialogOpen(false)}>
              取消
            </button>
            <button class={BTN_PRIMARY} onClick={() => void submit()}>
              保存
            </button>
          </>
        }
      >
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>蒸发池（走水源头）</span>
            <select class={INPUT} value={draft.pondId} onChange={(event) => setDraft('pondId', event.currentTarget.value)}>
              <option value="">请选择</option>
              <For each={pondStore.state.ponds}>
                {(pond) => (
                  <option value={pond.id}>
                    {pond.code} · {pond.seriesName} · {pond.stage}
                  </option>
                )}
              </For>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>计划走水日期</span>
            <input type="date" class={INPUT} value={draft.planDate} onInput={(event) => setDraft('planDate', event.currentTarget.value)} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>目标密度（g/cm³）</span>
            <input
              type="number"
              step="0.001"
              class={INPUT}
              value={draft.targetDensity}
              onInput={(event) => setDraft('targetDensity', Number(event.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>计划量（m³）</span>
            <input
              type="number"
              step="10"
              class={INPUT}
              value={draft.volumeM3}
              onInput={(event) => setDraft('volumeM3', Number(event.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>调度员</span>
            <input class={INPUT} value={draft.operator} onInput={(event) => setDraft('operator', event.currentTarget.value)} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>走水状态</span>
            <select class={INPUT} value={draft.state} onChange={(event) => setDraft('state', event.currentTarget.value as ScheduleState)}>
              <For each={SCHEDULE_STATE_OPTIONS}>{(state) => <option value={state}>{state}</option>}</For>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>排序序号（同状态排队先后）</span>
            <input
              type="number"
              min="1"
              step="1"
              class={INPUT}
              value={draft.orderIndex}
              onInput={(event) => setDraft('orderIndex', Number(event.currentTarget.value))}
            />
          </label>
        </div>
        <p class="mt-3 rounded-md bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-500">
          提交后按 /gates 的串级走向确定下游路径，并按计划量逐池预占容量：容量充足即「已批占用」，
          不足则留在待批区「排队中」（已排优先、同状态按提交顺序）。只有已批占用的计划才能开始走水；
          取消或超时（计划日期过后 3 天）会释放占用并让排队条目补位。
        </p>
      </AppDialog>

      <AppDialog
        open={deleting() !== null}
        title="确认删除走水计划？"
        width="max-w-lg"
        onClose={() => setDeleting(null)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setDeleting(null)}>
              取消
            </button>
            <button class="rounded-md bg-rose-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-rose-700" onClick={() => void confirmDelete()}>
              确认删除
            </button>
          </>
        }
      >
        <p class="text-sm leading-relaxed text-slate-600">
          将删除「{pondLabel(deleting()?.pondId ?? '')}」在 {deleting()?.planDate} 的走水计划，
          其下游容量预占将同步释放，排队条目自动补位。
        </p>
      </AppDialog>
    </div>
  );
}
