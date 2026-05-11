<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import { kvGet } from '../../services/idbService';
import { ordersService } from '../../services/ordersService';
import IskValue from '../presentational/IskValue.vue';

// ── Net-worth history ────────────────────────────────────────────────────────

interface Snapshot { date: string; value: number; }

const snapshots = ref<Snapshot[]>([]);

onMounted(async () => {
  snapshots.value = (await kvGet<Snapshot[]>('networth-snapshots')) ?? [];
});

// ── Trades from order history ────────────────────────────────────────────────

const closedSells = computed(() =>
  ordersService.orderHistory.value
    // Any sell order where at least some volume was filled (closed, expired, or cancelled).
    .filter((o) => !o.isBuyOrder && o.volumeRemain < o.volumeTotal)
    .sort((a, b) => b.issued.localeCompare(a.issued)),
);

const totalProfit = computed(() =>
  closedSells.value.reduce((s, o) => s + (o.estimatedProfit ?? 0), 0),
);

const profitableCount = computed(
  () => closedSells.value.filter((o) => (o.estimatedProfit ?? 0) > 0).length,
);

// Trades in the last 7 days
const recentCutoff = computed(() => {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString();
});

const recentProfit = computed(() =>
  closedSells.value
    .filter((o) => o.issued >= recentCutoff.value)
    .reduce((s, o) => s + (o.estimatedProfit ?? 0), 0),
);

// ── Top performers ────────────────────────────────────────────────────────────

interface ItemPerf {
  typeId: number;
  typeName: string;
  totalProfit: number;
  trades: number;
  avgProfit: number;
}

const topPerformers = computed<ItemPerf[]>(() => {
  const map = new Map<number, ItemPerf>();
  for (const o of closedSells.value) {
    if (o.estimatedProfit === undefined) continue;
    let p = map.get(o.typeId);
    if (!p) {
      p = { typeId: o.typeId, typeName: o.typeName, totalProfit: 0, trades: 0, avgProfit: 0 };
      map.set(o.typeId, p);
    }
    p.totalProfit += o.estimatedProfit;
    p.trades += 1;
  }
  return [...map.values()]
    .map((p) => ({ ...p, avgProfit: p.totalProfit / p.trades }))
    .sort((a, b) => b.totalProfit - a.totalProfit)
    .slice(0, 10);
});

// ── SVG Sparkline ─────────────────────────────────────────────────────────────

const CHART_W = 600;
const CHART_H = 120;
const PAD = { top: 12, right: 12, bottom: 28, left: 10 };

const chartData = computed(() => {
  const pts = snapshots.value;
  if (pts.length < 2) return null;

  const minV = Math.min(...pts.map((p) => p.value));
  const maxV = Math.max(...pts.map((p) => p.value));
  const range = maxV - minV || 1;

  const w = CHART_W - PAD.left - PAD.right;
  const h = CHART_H - PAD.top - PAD.bottom;

  const coords = pts.map((p, i) => ({
    x: PAD.left + (i / (pts.length - 1)) * w,
    y: PAD.top + h - ((p.value - minV) / range) * h,
    date: p.date,
    value: p.value,
  }));

  const line = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
  const area = `${line} L${coords[coords.length - 1].x.toFixed(1)},${(PAD.top + h).toFixed(1)} L${PAD.left.toFixed(1)},${(PAD.top + h).toFixed(1)} Z`;

  // Y-axis ticks (3 labels)
  const yTicks = [0, 0.5, 1].map((f) => ({
    y: PAD.top + h - f * h,
    label: formatIskShort(minV + f * range),
  }));

  // X-axis: first and last date
  const xLabels = [
    { x: PAD.left, label: pts[0].date.slice(5) },
    { x: PAD.left + w, label: pts[pts.length - 1].date.slice(5) },
  ];

  const latest = pts[pts.length - 1];
  const prev = pts[pts.length - 2];
  const delta = latest.value - prev.value;

  return { coords, line, area, yTicks, xLabels, latest, delta };
});

function formatIskShort(v: number): string {
  if (Math.abs(v) >= 1e12) return `${(v / 1e12).toFixed(1)}T`;
  if (Math.abs(v) >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(0);
}

// Tooltip state
const tooltip = ref<{ x: number; y: number; date: string; value: number; } | null>(null);

function onMouseMove(e: MouseEvent): void {
  if (!chartData.value) return;
  const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
  const mx = ((e.clientX - rect.left) / rect.width) * CHART_W;
  const pts = chartData.value.coords;
  let closest = pts[0];
  for (const p of pts) {
    if (Math.abs(p.x - mx) < Math.abs(closest.x - mx)) closest = p;
  }
  tooltip.value = closest;
}

function onMouseLeave(): void {
  tooltip.value = null;
}
</script>

<template lang="pug">
.journal-tab
  //- ── Stats bar ──────────────────────────────────────────────────────────
  .stats-bar
    .stat-card
      .stat-label Total profit (history)
      .stat-value(:class="totalProfit >= 0 ? 'positive' : 'negative'")
        IskValue(:value="totalProfit")
    .stat-card
      .stat-label Last 7 days profit
      .stat-value(:class="recentProfit >= 0 ? 'positive' : 'negative'")
        IskValue(:value="recentProfit")
    .stat-card
      .stat-label Profitable sells
      .stat-value {{ profitableCount }} / {{ closedSells.length }}
    .stat-card(v-if="ordersService.walletBalance.value !== undefined")
      .stat-label Wallet
      .stat-value
        IskValue(:value="ordersService.walletBalance.value")

  //- ── Net-worth chart ────────────────────────────────────────────────────
  .section(v-if="chartData")
    .section-header
      h2 Net Worth
      span.section-sub (wallet + inventory cost basis · daily snapshot)
      span.delta(:class="chartData.delta >= 0 ? 'positive' : 'negative'")
        | {{ chartData.delta >= 0 ? '▲' : '▼' }} {{ formatIskShort(Math.abs(chartData.delta)) }} today
    .chart-wrap
      svg.chart(:viewBox="`0 0 ${600} ${120}`" @mousemove="onMouseMove" @mouseleave="onMouseLeave")
        defs
          linearGradient#area-gradient(x1="0" y1="0" x2="0" y2="1")
            stop(offset="0%" stop-color="#64d7ff" stop-opacity="0.18")
            stop(offset="100%" stop-color="#64d7ff" stop-opacity="0")
        //- grid lines
        line(v-for="t in chartData.yTicks" :key="t.label" :x1="PAD.left" :y1="t.y" :x2="600 - PAD.right" :y2="t.y" stroke="#1e2e42" stroke-width="1")
        //- area fill
        path(:d="chartData.area" fill="url(#area-gradient)")
        //- line
        path(:d="chartData.line" fill="none" stroke="#64d7ff" stroke-width="1.5" stroke-linejoin="round")
        //- y-axis labels
        text(v-for="t in chartData.yTicks" :key="'y' + t.label" :x="PAD.left + 2" :y="t.y - 3" class="axis-label") {{ t.label }}
        //- x-axis labels
        text(v-for="l in chartData.xLabels" :key="l.label" :x="l.x" :y="120 - 6" class="axis-label" :text-anchor="l.x === PAD.left ? 'start' : 'end'") {{ l.label }}
        //- tooltip dot
        template(v-if="tooltip")
          line(:x1="tooltip.x" :y1="PAD.top" :x2="tooltip.x" :y2="120 - PAD.bottom" stroke="#ffffff22" stroke-width="1" stroke-dasharray="3,3")
          circle(:cx="tooltip.x" :cy="tooltip.y" r="4" fill="#64d7ff" stroke="#0f1622" stroke-width="2")
          text(:x="tooltip.x" :y="PAD.top - 2" class="tooltip-label" :text-anchor="tooltip.x > 400 ? 'end' : 'start'")
            | {{ tooltip.date }} · {{ formatIskShort(tooltip.value) }}
  .section-empty(v-else-if="snapshots.length < 2")
    p.hint Net worth chart will appear after data has been collected across multiple days.

  //- ── Top performers ──────────────────────────────────────────────────────
  .section(v-if="topPerformers.length > 0")
    .section-header
      h2 Top Performers
      span.section-sub (by total profit, closed sell orders)
    table.perf-table
      thead
        tr
          th Item
          th Trades
          th Avg profit
          th Total profit
      tbody
        tr(v-for="p in topPerformers" :key="p.typeId")
          td.td-name {{ p.typeName }}
          td {{ p.trades }}
          td
            span(:class="p.avgProfit >= 0 ? 'positive' : 'negative'")
              IskValue(:value="p.avgProfit")
          td
            span(:class="p.totalProfit >= 0 ? 'positive' : 'negative'")
              IskValue(:value="p.totalProfit")

  //- ── Trade log ───────────────────────────────────────────────────────────
  .section
    .section-header
      h2 Trade Log
      span.section-sub (closed sell orders, newest first)
    .empty(v-if="closedSells.length === 0") No completed sell orders found in history.
    .tbl-wrap(v-else)
      table.trade-table
        thead
          tr
            th Date
            th Item
            th Qty
            th Sell price
            th Est. profit
        tbody
          tr(v-for="o in closedSells" :key="o.orderId" :class="{ 'row--profit': (o.estimatedProfit ?? 0) > 0, 'row--loss': (o.estimatedProfit ?? 0) < 0 }")
            td.td-date {{ new Date(o.issued).toLocaleDateString() }}
            td.td-name {{ o.typeName }}
            td {{ (o.volumeTotal - o.volumeRemain).toLocaleString() }}
            td
              IskValue(:value="o.price")
            td
              template(v-if="o.estimatedProfit !== undefined")
                span(:class="o.estimatedProfit >= 0 ? 'positive' : 'negative'")
                  | {{ o.estimatedProfit >= 0 ? '+' : '' }}
                  IskValue(style="display:inline" :value="o.estimatedProfit")
              template(v-else)
                span.muted —
</template>

<style scoped lang="scss">
.journal-tab {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

// ── Stats bar ────────────────────────────────────────────────────────────────

.stats-bar {
  display: grid;
  gap: 0.75rem;
  grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr));
}

.stat-card {
  background: #0f1622;
  border: 1px solid #2a3b52;
  border-radius: 0.65rem;
  padding: 0.85rem 1rem;
}

.stat-label {
  color: #5e7a99;
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.stat-value {
  font-size: 1.1rem;
  font-weight: 700;
  margin-top: 0.3rem;
}

// ── Section ──────────────────────────────────────────────────────────────────

.section {
  background: #0f1622;
  border: 1px solid #2a3b52;
  border-radius: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 1rem;
}

.section-empty {
  color: #5e7a99;
  font-size: 0.85rem;
  text-align: center;
  padding: 0.5rem 0;
}

.section-header {
  align-items: baseline;
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;

  h2 {
    color: #b8d4ff;
    font-size: 0.92rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    margin: 0;
    text-transform: uppercase;
  }
}

.section-sub {
  color: #5e7a99;
  font-size: 0.75rem;
}

.delta {
  font-size: 0.8rem;
  font-weight: 700;
  margin-left: auto;
}

// ── Chart ────────────────────────────────────────────────────────────────────

.chart-wrap {
  width: 100%;
}

.chart {
  display: block;
  overflow: visible;
  width: 100%;

  .axis-label {
    fill: #3a5a7a;
    font-size: 9px;
  }

  .tooltip-label {
    fill: #b8d4ff;
    font-size: 9px;
    font-weight: 600;
  }
}

// ── Top performers table ──────────────────────────────────────────────────────

.perf-table {
  border-collapse: collapse;
  font-size: 0.85rem;
  width: 100%;

  th {
    border-bottom: 1px solid #253448;
    color: #5e7a99;
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    padding: 0.4rem 0.75rem;
    text-align: right;
    text-transform: uppercase;

    &:first-child {
      text-align: left;
    }
  }

  td {
    border-bottom: 1px solid #1a2535;
    color: #ecf4ff;
    font-weight: 600;
    padding: 0.45rem 0.75rem;
    text-align: right;

    &.td-name {
      text-align: left;
    }
  }

  tr:hover td {
    background: rgba(255, 255, 255, 0.02);
  }
}

// ── Trade log table ───────────────────────────────────────────────────────────

.tbl-wrap {
  overflow-x: auto;
}

.trade-table {
  border-collapse: collapse;
  font-size: 0.85rem;
  width: 100%;

  th {
    border-bottom: 1px solid #253448;
    color: #5e7a99;
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    padding: 0.4rem 0.75rem;
    text-align: right;
    text-transform: uppercase;
    white-space: nowrap;

    &:first-child,
    &:nth-child(2) {
      text-align: left;
    }
  }

  td {
    border-bottom: 1px solid #1a2535;
    color: #ecf4ff;
    font-weight: 600;
    padding: 0.45rem 0.75rem;
    text-align: right;
    white-space: nowrap;

    &.td-name,
    &.td-date {
      text-align: left;
    }
  }

  tr:hover td {
    background: rgba(255, 255, 255, 0.02);
  }

  .row--profit td.td-name {
    border-left: 2px solid rgba(125, 255, 155, 0.35);
  }

  .row--loss td.td-name {
    border-left: 2px solid rgba(255, 107, 107, 0.35);
  }
}

.empty {
  color: #5e7a99;
  font-size: 0.85rem;
  padding: 0.5rem 0;
  text-align: center;
}

.hint {
  color: #5e7a99;
  font-size: 0.82rem;
  margin: 0;
}

// ── Shared ────────────────────────────────────────────────────────────────────

.positive {
  color: #7dff9b;
}

.negative {
  color: #ff6b6b;
}

.muted {
  color: #5e7a99;
}
</style>
