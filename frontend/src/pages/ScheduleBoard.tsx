/**
 * /schedules 走水与出卤编排
 * 走水计划按路径和计划量预占下游池容：容量足够才拿到占用（可开始走水），
 * 不足或闸门关闭则按「已走水状态优先、同状态提交顺序」排队，留在待批区。
 * 水位 / 闸门开度变化后只重算未执行计划；取消或超时释放占用；汇总已占 / 缺口 / 排队量。
 * 消费模型：Schedule、Gate、Assay、Occupancy；
 * 复用组件：<FilterBar>、<EmptyPanel>、<StatBadge>、<OccupancyLedger>、<PendingApproval>
 */
import { For, Show, createMemo, createSignal, onMount } from 'solid-js';
import { createStore } from 'solid-js/store';
import AppDialog from '../components/common/AppDialog';
import EmptyPanel from '../components/common/EmptyPanel';
import FilterBar from '../components/common/FilterBar';
import OccupancyLedger from '../components/common/OccupancyLedger';
import PendingApproval from '../components/common/PendingApproval';
import StatBadge from '../components/common/StatBadge';
import StageTag from '../components/common/StageTag';
import { useOccupancyStore } from '../stores/occupancyStore';
import { usePondStore } from '../stores/pondStore';
import { useScheduleStore } from '../stores/scheduleStore';
import { SCHEDULE_STATE_OPTIONS, type Schedule, type ScheduleDraft, type ScheduleState } from '../types/schedule';
import { effectiveVerdict } from '../utils/brine';
import { enumerateRoutes } from '../utils/occupancy';
import { today } from '../utils/id';

const INPUT =
  'w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-brine-500 focus:ring-1 focus:ring-brine-400';
const BTN_PRIMARY =
  'rounded-md bg-brine-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-brine-700 disabled:opacity-50';
const BTN_GHOST =
  'rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-sm text-slate-700 transition hover:bg-slate-100';
const BTN_DANGER = 'rounded-md bg-rose-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-rose-700';

const STATE_STYLE: Record<ScheduleState, string> = {
  待排: 'border-slate-300 bg-slate-100 text-slate-600',
  已排: 'border-sky-300 bg-sky-50 text-sky-700',
  走水中: 'border-amber-300 bg-amber-50 text-amber-700',
  已出卤: 'border-emerald-300 bg-emerald-50 text-emerald-700',
};

function emptyDraft(pondId: string, routePondIds: string[], orderIndex: number): ScheduleDraft {
  return {
    pondId,
    routePondIds,
    planDate: today(),
    targetDensity: 1.15,
    volumeM3: 800,
    operator: '',
    state: '待排',
    orderIndex,
    expired: false,
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
  const [draft, setDraft] = createStore<ScheduleDraft>(emptyDraft('', [], 1));

  onMount(() => {
    void pondStore.loadAll();
  });

  const pondOf = (pondId: string) => pondStore.state.ponds.find((pond) => pond.id === pondId) ?? null;
  const pondLabel = (pondId: string): string => {
    const pond = pondOf(pondId);
    return pond === null ? '（池已删除）' : `${pond.code} · ${pond.seriesName}`;
  };
  const gateOf = (fromPondId: string, toPondId: string) =>
    pondStore.state.gates.find((gate) => gate.fromPondId === fromPondId && gate.toPondId === toPondId);

  /** 起点池可选的全部下游路径（含仅本池） */
  const routeOptions = createMemo(() =>
    draft.pondId === '' ? [] : enumerateRoutes(draft.pondId, pondStore.state.gates),
  );

  const ordered = createMemo<Schedule[]>(() =>
    [...scheduleStore.state.rows].sort((a, b) => a.orderIndex - b.orderIndex || a.planDate.localeCompare(b.planDate)),
  );

  const filtered = createMemo<Schedule[]>(() => {
    const current = scheduleStore.filters();
    const series = pondStore.state.currentSeries;
    const keyword = current.keyword.trim().toLowerCase();
    return ordered().filter((row) => {
      const pond = pondOf(row.pondId);
      if (series !== null && pond?.seriesName !== series) return false;
      if (current.state !== 'all' && row.state !== current.state) return false;
      if (keyword === '') return true;
      return (
        pondLabel(row.pondId).toLowerCase().includes(keyword) ||
        row.operator.toLowerCase().includes(keyword) ||
        row.planDate.includes(keyword)
      );
    });
  });

  const stats = createMemo(() => {
    const list = ordered();
    const board = occupancyStore.board();
    return {
      total: list.length,
      pending: list.filter((row) => row.state === '待排').length,
      running: list.filter((row) => row.state === '走水中').length,
      done: list.filter((row) => row.state === '已出卤').length,
      queued: board.queuedCount,
      volume: Math.round(list.reduce((acc, row) => acc + row.volumeM3, 0) * 10) / 10,
      donePct: list.length === 0 ? 0 : Math.round((list.filter((row) => row.state === '已出卤').length / list.length) * 1000) / 10,
    };
  });

  /** 路径文字：A → B → C */
  const routeText = (row: Schedule): string =>
    (row.routePondIds ?? [row.pondId]).map((id) => pondOf(id)?.code ?? '?').join(' → ');

  const openCreate = (): void => {
    const pondId = pondStore.pondsOfSeries(pondStore.state.currentSeries)[0]?.id ?? pondStore.state.ponds[0]?.id ?? '';
    setEditingId(null);
    const routes = pondId === '' ? [] : enumerateRoutes(pondId, pondStore.state.gates);
    const defaultRoute = routes.find((option) => option.open && option.pondIds.length > 1)?.pondIds ??
      routes[0]?.pondIds ?? [pondId];
    setDraft(emptyDraft(pondId, defaultRoute, ordered().length + 1));
    setDialogOpen(true);
  };

  const openEdit = (row: Schedule): void => {
    setEditingId(row.id);
    setDraft({
      pondId: row.pondId,
      routePondIds: row.routePondIds ?? [row.pondId],
      planDate: row.planDate,
      targetDensity: row.targetDensity,
      volumeM3: row.volumeM3,
      operator: row.operator,
      state: row.state,
      orderIndex: row.orderIndex,
      expired: row.expired,
    });
    setDialogOpen(true);
  };

  /** 切换起点池：路径重置为默认路径 */
  const changePond = (pondId: string): void => {
    const routes = pondId === '' ? [] : enumerateRoutes(pondId, pondStore.state.gates);
    const defaultRoute = routes.find((option) => option.open && option.pondIds.length > 1)?.pondIds ??
      routes[0]?.pondIds ?? [pondId];
    setDraft('pondId', pondId);
    setDraft('routePondIds', defaultRoute);
  };

  const changeRoute = (key: string): void => {
    const found = routeOptions().find((option) => option.pondIds.join('>') === key);
    if (found !== undefined) setDraft('routePondIds', found.pondIds);
  };

  /** 表单内的路径占用预估（各下游池到达量与账面剩余） */
  const routePreview = createMemo(() => {
    if (draft.pondId === '' || draft.routePondIds.length < 2) return [];
    let carry = draft.volumeM3;
    const steps: Array<{ pondId: string; gateOpen: number | null; arrive: number; remaining: number | null; blocked: boolean }> = [];
    for (let i = 1; i < draft.routePondIds.length; i += 1) {
      const gate = gateOf(draft.routePondIds[i - 1], draft.routePondIds[i]);
      if (gate === undefined || gate.openingPct <= 0) {
        steps.push({ pondId: draft.routePondIds[i], gateOpen: gate?.openingPct ?? null, arrive: carry, remaining: occupancyStore.accountOf(draft.routePondIds[i])?.remainingM3 ?? null, blocked: true });
        break;
      }
      carry = carry * (gate.openingPct / 100);
      steps.push({ pondId: draft.routePondIds[i], gateOpen: gate.openingPct, arrive: Math.round(carry * 10) / 10, remaining: occupancyStore.accountOf(draft.routePondIds[i])?.remainingM3 ?? null, blocked: false });
    }
    return steps;
  });

  const submit = async (): Promise<void> => {
    if (draft.pondId === '') {
      scheduleStore.setMessage('请选择蒸发池');
      return;
    }
    if (editingId() === null) {
      const row = await scheduleStore.createSchedule({ ...draft });
      scheduleStore.setMessage(`已新建走水计划：${row.planDate}，下游占用已自动预占或排队`);
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

  /** 逐条占用徽标 */
  const occupancyBadge = (row: Schedule) => {
    const status = scheduleStore.occupancyStatus(row);
    if (status.kind === 'none') {
      return <span class="rounded border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] text-slate-500">无下游占用</span>;
    }
    if (status.kind === 'locked') {
      return (
        <span class="rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700" title="走水中：占用为现场事实，重算照旧">
          现场占用 {status.rows.length} 池
        </span>
      );
    }
    if (status.kind === 'granted') {
      return (
        <span class="rounded border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-700">
          已预占 {status.rows.length} 池
        </span>
      );
    }
    const blocked = status.rows.some((item) => item.reason === '闸门关闭');
    return (
      <span class="rounded border border-rose-300 bg-rose-50 px-2 py-0.5 text-[11px] text-rose-700">
        {row.expired ? '超时排队' : blocked ? '闸门断流' : '排队待容量'}
      </span>
    );
  };

  return (
    <div class="space-y-3.5">
      <div class="flex flex-wrap gap-3">
        <StatBadge label="走水计划" value={stats().total} suffix="条" tone="primary" />
        <StatBadge label="待排" value={stats().pending} suffix="条" tone="default" />
        <StatBadge label="走水中" value={stats().running} suffix="条" tone="warning" />
        <StatBadge label="已出卤" value={stats().done} suffix="条" tone="success" />
        <StatBadge label="排队待批" value={stats().queued} suffix="条" tone="danger" />
        <StatBadge label="计划总量" value={stats().volume} suffix="m³" tone="info" />
        <StatBadge label="出卤完成率" value={`${stats().donePct}%`} percent={stats().donePct} tone="success" />
      </div>

      <Show when={scheduleStore.state.lastMessage !== ''}>
        <div class="rounded-lg border border-brine-200 bg-brine-50 px-3.5 py-2 text-sm text-brine-800">
          {scheduleStore.state.lastMessage}
        </div>
      </Show>

      <PendingApproval />
      <OccupancyLedger />

      <section class="rounded-xl border border-slate-200 bg-white p-4">
        <header class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 class="text-[15px] font-semibold text-slate-800">走水与出卤编排</h2>
          <div class="flex items-center gap-2">
            <button type="button" class={BTN_GHOST} onClick={() => void scheduleStore.reconcileNow()}>
              立即重排占用
            </button>
            <button type="button" class={BTN_PRIMARY} onClick={openCreate} disabled={pondStore.state.ponds.length === 0}>
              + 新建走水计划
            </button>
          </div>
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
          resultText={`命中 ${filtered().length} / ${ordered().length} 条`}
        />

        <Show when={ordered().length === 0}>
          <EmptyPanel
            title="还没有走水编排"
            description="为蒸发池选择走水路径、计划日期与计划量，系统会按闸门开度折减后预占下游池容；容量不足自动排队，出卤后释放占用。"
            actionText="新建第一条走水计划"
            onAction={openCreate}
          />
        </Show>

        <Show when={ordered().length > 0}>
          <ul class="space-y-2">
            <For each={filtered()}>
              {(row, index) => (
                <li
                  draggable={true}
                  class={`flex flex-wrap items-center gap-3 rounded-lg border bg-white px-3.5 py-3 transition ${
                    dragOverId() === row.id ? 'border-brine-500 ring-1 ring-brine-400' : 'border-slate-200'
                  }`}
                  onDragStart={() => scheduleStore.setDraggingId(row.id)}
                  onDragOver={(event) => {
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
                    {index() + 1}
                  </span>
                  <span class="cursor-grab text-slate-300" title="按住拖拽调整顺序">
                    ⠿
                  </span>
                  <div class="min-w-[200px] flex-1">
                    <p class="text-sm font-medium text-slate-800">{pondLabel(row.pondId)}</p>
                    <p class="text-xs text-slate-500">
                      路径 <span class="text-slate-600">{routeText(row)}</span>
                    </p>
                    <p class="text-xs text-slate-500">
                      计划日期 {row.planDate} · 调度员 {row.operator === '' ? '未填写' : row.operator}
                    </p>
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
                    <p>
                      组分判定{' '}
                      <span class="font-medium text-slate-800">
                        {(() => {
                          const list = pondStore.state.assays
                            .filter((item) => item.pondId === row.pondId)
                            .sort((a, b) => a.date.localeCompare(b.date));
                          return list.length === 0 ? '未化验' : effectiveVerdict(list[list.length - 1]);
                        })()}
                      </span>
                    </p>
                  </div>
                  <div class="flex flex-col items-start gap-1">
                    <span class={`rounded border px-2 py-0.5 text-[11px] ${STATE_STYLE[row.state]}`}>{row.state}</span>
                    {occupancyBadge(row)}
                  </div>
                  <div class="flex flex-wrap items-center gap-2">
                    <button
                      class="rounded-md border border-brine-300 bg-brine-50 px-2.5 py-1 text-xs text-brine-700 transition hover:bg-brine-100 disabled:opacity-50"
                      disabled={row.state === '已出卤'}
                      title={
                        row.state === '已排' && scheduleStore.occupancyStatus(row).kind === 'queued'
                          ? '尚未拿到下游池占用，不能开始走水'
                          : ''
                      }
                      onClick={async () => {
                        const next = await scheduleStore.advance(row.id);
                        if (next === null && row.state === '已排') {
                          // 未拿到占用时 advance 已写入提示
                        } else if (next === null) {
                          scheduleStore.setMessage('该计划已处于「已出卤」状态');
                        }
                      }}
                    >
                      {nextStateLabel(row.state)}
                    </button>
                    <button class="text-xs text-brine-700 hover:underline" onClick={() => openEdit(row)}>
                      编辑
                    </button>
                    <button class="text-xs text-rose-600 hover:underline" onClick={() => setDeleting(row)}>
                      取消
                    </button>
                  </div>
                </li>
              )}
            </For>
          </ul>
        </Show>

        <Show when={ordered().length > 0 && filtered().length === 0}>
          <EmptyPanel
            title="没有符合筛选条件的走水计划"
            description="可以切换池系或状态筛选条件，或直接重置筛选。"
            actionText="重置筛选"
            onAction={() => scheduleStore.resetFilters()}
          />
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
            <span>起点蒸发池</span>
            <select class={INPUT} value={draft.pondId} onChange={(event) => changePond(event.currentTarget.value)}>
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
            <span>走水路径（按下游闸门逐跳预占）</span>
            <select class={INPUT} value={draft.routePondIds.join('>')} onChange={(event) => changeRoute(event.currentTarget.value)}>
              <For each={routeOptions()}>
                {(option) => (
                  <option value={option.pondIds.join('>')}>
                    {option.pondIds.map((id) => pondOf(id)?.code ?? '?').join(' → ')}
                    {option.pondIds.length === 1 ? '（仅本池，无下游占用）' : option.open ? '' : '（末端闸已关闭）'}
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
            <span>排序序号（越小越先走水）</span>
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

        <Show when={routePreview().length > 0}>
          <div class="mt-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
            <p class="mb-1 text-xs font-medium text-slate-600">下游占用预估（按当前闸门开度折减）</p>
            <ul class="space-y-1">
              <For each={routePreview()}>
                {(step) => (
                  <li class="text-xs text-slate-600">
                    → {pondLabel(step.pondId)}：到达{' '}
                    <span class="tabular-nums font-medium text-slate-800">{step.arrive}</span> m³
                    <Show when={step.gateOpen !== null}>
                      <span class="text-slate-400">（开度 {step.gateOpen}%）</span>
                    </Show>
                    <Show when={step.remaining !== null}>
                      <span class={step.remaining !== null && step.arrive > step.remaining ? 'text-rose-600' : 'text-emerald-600'}>
                        ，账面剩余 {step.remaining === null ? '—' : step.remaining} m³
                        {step.remaining !== null && step.arrive > step.remaining ? '，容量不足将排队' : '，可预占'}
                      </span>
                    </Show>
                    <Show when={step.blocked}>
                      <span class="text-slate-500">，闸门关闭：路径断流，将挂账排队</span>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </div>
        </Show>

        <p class="mt-3 rounded-md bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-500">
          保存后按路径逐跳预占下游容量：全部下游可容才拿到占用，否则整条按「走水中 &gt; 已排 &gt; 待排、同状态提交顺序」排队。
          状态推进到「走水中」后占用转为现场事实；出卤或取消会释放占用并自动补排排队条目。
        </p>
      </AppDialog>

      <AppDialog
        open={deleting() !== null}
        title="确认取消走水计划？"
        width="max-w-lg"
        onClose={() => setDeleting(null)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setDeleting(null)}>
              再想想
            </button>
            <button class={BTN_DANGER} onClick={() => void confirmDelete()}>
              取消并释放占用
            </button>
          </>
        }
      >
        <p class="text-sm leading-relaxed text-slate-600">
          将取消「{pondLabel(deleting()?.pondId ?? '')}」在 {deleting()?.planDate} 的走水计划（路径
          {deleting() ? ` ${routeText(deleting() as Schedule)}` : ''}），其下游占用立即释放，排队条目按顺序自动补占。
        </p>
      </AppDialog>
    </div>
  );
}
