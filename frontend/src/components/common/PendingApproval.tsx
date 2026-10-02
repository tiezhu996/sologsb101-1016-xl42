/**
 * 待批区：未拿到下游池占用的走水计划排队列表
 * 排队规则：已走水状态优先，同状态按提交顺序；超时释放的计划重新排队并标注。
 */
import { For, Show } from 'solid-js';
import { useOccupancyStore } from '../../stores/occupancyStore';
import { usePondStore } from '../../stores/pondStore';
import EmptyPanel from './EmptyPanel';

function fmt(value: number): string {
  return (Math.round(value * 10) / 10).toLocaleString('zh-CN');
}

export default function PendingApproval() {
  const pondStore = usePondStore();
  const occupancyStore = useOccupancyStore();

  const pondLabel = (pondId: string): string => {
    const pond = pondStore.state.ponds.find((item) => item.id === pondId);
    return pond === undefined ? '（池已删除）' : `${pond.code} · ${pond.seriesName}`;
  };

  const queue = () => occupancyStore.board().queuedSchedules;

  return (
    <section class="rounded-xl border border-amber-200 bg-amber-50/40 p-4">
      <header class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 class="text-[15px] font-semibold text-amber-800">待批区（容量排队）</h2>
          <p class="mt-0.5 text-xs text-amber-700/80">
            容量不足或闸门关闭、未拿到下游占用的计划留在这里；取消、出卤或开度 / 水位变化释放容量后按排队顺序自动补占。
          </p>
        </div>
        <span class="rounded-full border border-amber-300 bg-white px-2.5 py-0.5 text-xs font-medium text-amber-700">
          {queue().length} 条排队
        </span>
      </header>

      <Show
        when={queue().length > 0}
        fallback={
          <div class="rounded-lg border border-emerald-200 bg-emerald-50 px-3.5 py-3 text-sm text-emerald-700">
            当前没有排队条目：未执行计划均已拿到下游池占用。
          </div>
        }
      >
        <ul class="space-y-2">
          <For each={queue()}>
            {(entry, index) => (
              <li class="flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-white px-3.5 py-2.5">
                <span class="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-amber-100 text-[11px] font-semibold text-amber-700">
                  {index() + 1}
                </span>
                <div class="min-w-[180px] flex-1">
                  <p class="text-sm font-medium text-slate-800">
                    {pondLabel(entry.schedule.pondId)}
                    <Show when={entry.expired}>
                      <span class="ml-2 rounded border border-rose-300 bg-rose-50 px-1.5 py-0.5 text-[10px] text-rose-600">
                        超时释放
                      </span>
                    </Show>
                  </p>
                  <p class="text-xs text-slate-500">
                    计划日 {entry.schedule.planDate} · 提交于 {entry.schedule.createdAt.slice(0, 10)} · 状态
                    {entry.schedule.state}
                  </p>
                </div>
                <div class="text-xs text-slate-600">
                  申请量 <span class="tabular-nums font-medium text-slate-800">{fmt(entry.schedule.volumeM3)}</span> m³
                </div>
                <div class="flex flex-wrap gap-1.5">
                  <For each={entry.rows}>
                    {(row) => (
                      <span
                        class={`rounded border px-2 py-0.5 text-[11px] ${
                          row.reason === '闸门关闭'
                            ? 'border-slate-400 bg-slate-100 text-slate-600'
                            : 'border-rose-300 bg-rose-50 text-rose-700'
                        }`}
                        title={row.reason === '闸门关闭' ? '路径上的闸门已关闭，路径断流' : `缺口 ${fmt(row.shortfallM3)} m³`}
                      >
                        {pondLabel(row.pondId)}：{fmt(row.volumeM3)} m³ · {row.reason}
                        <Show when={row.reason === '容量不足'}>（缺 {fmt(row.shortfallM3)}）</Show>
                      </span>
                    )}
                  </For>
                </div>
              </li>
            )}
          </For>
        </ul>
      </Show>

      <Show when={queue().length === 0 && occupancyStore.board().grantedCount === 0}>
        <EmptyPanel title="暂无占用数据" description="新建走水计划并选择走水路径后，这里会显示排队情况。" />
      </Show>
    </section>
  );
}
