/**
 * 池容占用账面板
 * 汇总各下游池的已占容量 / 账面剩余 / 缺口 / 排队量，以及全局合计；
 * 数据由 occupancyStore 用占用引擎实时派生。
 */
import { For, Show } from 'solid-js';
import StatBadge from './StatBadge';
import { useOccupancyStore } from '../../stores/occupancyStore';
import { usePondStore } from '../../stores/pondStore';

function fmt(value: number): string {
  return (Math.round(value * 10) / 10).toLocaleString('zh-CN');
}

export default function OccupancyLedger() {
  const pondStore = usePondStore();
  const occupancyStore = useOccupancyStore();

  const pondOf = (pondId: string) => pondStore.state.ponds.find((pond) => pond.id === pondId);

  return (
    <section class="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
      <header class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 class="text-[15px] font-semibold text-slate-800">池容占用账</h2>
          <p class="mt-0.5 text-xs text-slate-500">
            走水计划按路径与开度折减后的到达量预占下游池容；水位或闸门开度变化后只重算未执行计划，走水中现场事实照旧。
          </p>
        </div>
      </header>

      <div class="flex flex-wrap gap-3">
        <StatBadge
          label="已占容量"
          value={fmt(occupancyStore.board().totals.occupiedM3)}
          suffix="m³"
          tone="primary"
          size="sm"
          hint="全部已批（含走水中锁定）占用合计"
        />
        <StatBadge
          label="容量缺口"
          value={fmt(occupancyStore.board().totals.shortfallM3)}
          suffix="m³"
          tone="danger"
          size="sm"
          hint="排队条目相对账面剩余的缺口合计"
        />
        <StatBadge
          label="排队量"
          value={fmt(occupancyStore.board().totals.queuedM3)}
          suffix="m³"
          tone="warning"
          size="sm"
          hint="未拿到占用、留在待批区的申请量合计"
        />
        <StatBadge
          label="排队条目"
          value={occupancyStore.board().queuedCount}
          suffix="条"
          tone="warning"
          size="sm"
        />
        <StatBadge
          label="已批条目"
          value={occupancyStore.board().grantedCount}
          suffix="条"
          tone="success"
          size="sm"
        />
        <StatBadge
          label="池系总有效容量"
          value={fmt(occupancyStore.board().totals.capacityM3)}
          suffix="m³"
          tone="info"
          size="sm"
        />
      </div>

      <div class="overflow-x-auto">
        <table class="w-full min-w-[920px] border-collapse text-sm">
          <thead>
            <tr class="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
              <th class="px-3 py-2">下游池</th>
              <th class="px-3 py-2 text-right">有效体积</th>
              <th class="px-3 py-2 text-right">当前存量</th>
              <th class="px-3 py-2 text-right">可用容量</th>
              <th class="px-3 py-2 text-right">已占容量</th>
              <th class="px-3 py-2 text-right">账面剩余</th>
              <th class="px-3 py-2 text-right">排队量</th>
              <th class="px-3 py-2 text-right">缺口</th>
              <th class="px-3 py-2 w-40">占用率</th>
            </tr>
          </thead>
          <tbody>
            <For each={occupancyStore.board().pondAccounts}>
              {(account) => {
                const pond = () => pondOf(account.pondId);
                const rate = (): number => {
                  if (account.occupiedM3 <= 0) return 0;
                  // 可用容量为 0（满水位）或现场已顶爆：占用率按 100%
                  if (account.availableM3 <= 0) return 100;
                  return Math.round(Math.min(1, account.occupiedM3 / account.availableM3) * 1000) / 10;
                };
                const overflow = (): boolean => account.remainingM3 < 0;
                return (
                  <tr class="border-b border-slate-100 hover:bg-slate-50/60">
                    <td class="px-3 py-2.5">
                      <Show when={pond() !== undefined} fallback={<span class="text-slate-400">（池已删除）</span>}>
                        <span class="font-medium text-slate-800">{pond()?.code}</span>
                        <span class="ml-1.5 text-xs text-slate-500">{pond()?.seriesName}</span>
                      </Show>
                    </td>
                    <td class="px-3 py-2.5 text-right tabular-nums text-slate-600">{fmt(account.capacityM3)}</td>
                    <td class="px-3 py-2.5 text-right tabular-nums text-slate-600">{fmt(account.storageM3)}</td>
                    <td class="px-3 py-2.5 text-right tabular-nums text-slate-600">{fmt(account.availableM3)}</td>
                    <td class="px-3 py-2.5 text-right tabular-nums font-medium text-brine-700">
                      {fmt(account.occupiedM3)}
                    </td>
                    <td
                      class={`px-3 py-2.5 text-right tabular-nums font-medium ${
                        overflow() ? 'text-rose-600' : 'text-slate-700'
                      }`}
                      title={overflow() ? '走水中现场占用已超过账面可用（现场溢流）' : ''}
                    >
                      {fmt(account.remainingM3)}
                    </td>
                    <td class="px-3 py-2.5 text-right tabular-nums text-amber-700">
                      {account.queuedM3 > 0 ? fmt(account.queuedM3) : '—'}
                    </td>
                    <td class="px-3 py-2.5 text-right tabular-nums text-rose-600">
                      {account.shortfallM3 > 0 ? fmt(account.shortfallM3) : '—'}
                    </td>
                    <td class="px-3 py-2.5">
                      <div class="flex items-center gap-2">
                        <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100">
                          <div
                            class={`h-full rounded-full ${overflow() ? 'bg-rose-500' : 'bg-brine-600'}`}
                            style={{ width: `${Math.min(100, rate())}%` }}
                          />
                        </div>
                        <span class="w-12 text-right text-xs tabular-nums text-slate-500">{rate()}%</span>
                      </div>
                    </td>
                  </tr>
                );
              }}
            </For>
          </tbody>
        </table>
      </div>
    </section>
  );
}
