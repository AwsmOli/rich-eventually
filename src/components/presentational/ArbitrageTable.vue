<script setup lang="ts">
import { computed, ref } from 'vue';

import { formattingService } from '../../services/formattingService';
import type { MarketOpportunity } from '../../types/domain';
import IskValue from './IskValue.vue';
import RouteSecurityStrip from './RouteSecurityStrip.vue';

type SortField = 'profitPerJump' | 'netProfit' | 'investment' | 'jumps' | 'cargoM3';
type SortDir = 'asc' | 'desc';

const SORT_OPTIONS: { value: SortField; label: string; }[] = [
  { value: 'profitPerJump', label: 'Profit / Jump' },
  { value: 'netProfit', label: 'Net Profit' },
  { value: 'jumps', label: 'Jumps' },
  { value: 'investment', label: 'Investment' },
  { value: 'cargoM3', label: 'Cargo (m³)' },
];

const props = defineProps<{
  rows: MarketOpportunity[];
  selectedId?: string;
  isLoading: boolean;
}>();

const emit = defineEmits<{
  (event: 'select', id: string): void;
  (event: 'copy', value: string): void;
}>();

const sortField = ref<SortField>('profitPerJump');
const sortDir = ref<SortDir>('desc');

const sortedRows = computed(() => {
  const field = sortField.value;
  const dir = sortDir.value === 'desc' ? -1 : 1;
  return [...props.rows].sort((a, b) => (a[field] - b[field]) * dir);
});

function toggleDir(): void {
  sortDir.value = sortDir.value === 'desc' ? 'asc' : 'desc';
}

function copy(value: string): void {
  emit('copy', value);
}
</script>

<template lang="pug">
.table-card
  .empty(v-if="!isLoading && rows.length === 0") No opportunities found for the current filters.
  .loading(v-else-if="isLoading") Pulling market pages and route data...
  template(v-else)
    .sort-bar
      label.sort-label Sort by
      select.sort-select(v-model="sortField")
        option(v-for="opt in SORT_OPTIONS" :key="opt.value" :value="opt.value") {{ opt.label }}
      button.sort-dir(@click="toggleDir" type="button" :title="sortDir === 'desc' ? 'Descending' : 'Ascending'") {{ sortDir === 'desc' ? '↓' : '↑' }}
    .cards
      article.deal-card(
        v-for="row in sortedRows"
        :key="row.id"
        :class="{ selected: row.id === selectedId }"
        @click="emit('select', row.id)"
      )
        .card-header
          button.item(type="button" @click.stop="copy(row.itemName)") {{ row.itemName }}
          .profit-pair
            .profit-col
              span.profit-label Instant
              IskValue.profit-value(:value="row.instantSellProfit")
            .profit-col
              span.profit-label Sell Order
              IskValue.profit-value(v-if="row.sellOrderProfit != null" :value="row.sellOrderProfit")
              span.profit-value(v-else) —
        .stations
          .station-line
            span.label Buy at
            button.link(type="button" @click.stop="copy(row.buyAtLocationName)") {{ row.buyAtLocationName }}
          .station-line
            span.label Sell at
            button.link(type="button" @click.stop="copy(row.sellToLocationName)") {{ row.sellToLocationName }}
        .metrics
          .metric
            span.metric-label Buy for
            IskValue.metric-value(:value="row.buyPrice")
          .metric
            span.metric-label Sell order for
            IskValue.metric-value(v-if="row.bestSellPriceAtBuyLocation != null" :value="row.bestSellPriceAtBuyLocation")
            span.metric-value(v-else) —
          .metric
            span.metric-label Instant sell for
            IskValue.metric-value(:value="row.sellPrice")
          .metric
            span.metric-label Instant vs 90d avg
            span.metric-value(
              v-if="row.instantSellVsAvg90d != null"
              :class="row.instantSellVsAvg90d >= 0 ? 'positive' : 'negative'"
            ) {{ (row.instantSellVsAvg90d >= 0 ? '+' : '') + (row.instantSellVsAvg90d * 100).toFixed(1) }}%
            span.metric-value(v-else) —
          .metric
            span.metric-label Sell order vs 90d avg
            span.metric-value(
              v-if="row.sellOrderVsAvg90d != null"
              :class="row.sellOrderVsAvg90d >= 0 ? 'positive' : 'negative'"
            ) {{ (row.sellOrderVsAvg90d >= 0 ? '+' : '') + (row.sellOrderVsAvg90d * 100).toFixed(1) }}%
            span.metric-value(v-else) —
          .metric
            span.metric-label Units to buy
            span.metric-value {{ row.units.toLocaleString() }}
          .metric
            span.metric-label Investment
            IskValue.metric-value(:value="row.investment")
          .metric
            span.metric-label Instant profit / jump
            IskValue.metric-value.positive(:value="row.instantSellProfitPerJump")
          .metric
            span.metric-label Sell order profit / jump
            IskValue.metric-value.positive(v-if="row.sellOrderProfitPerJump != null" :value="row.sellOrderProfitPerJump")
            span.metric-value(v-else) —
          .metric
            span.metric-label Cargo
            span.metric-value {{ formattingService.m3(row.cargoM3) }}
          .metric
            span.metric-label Jumps
            span.metric-value {{ row.jumps }}
          .metric
            span.metric-label Avg trades / day
            span.metric-value {{ row.avgDailyTradeCount != null ? Math.round(row.avgDailyTradeCount).toLocaleString() : '—' }}
        .route-sec
          span.route-label Route Sec
          RouteSecurityStrip(:squares="row.route.squares")
</template>

<style scoped lang="scss">
.table-card {
  background-color: #0f1622;
  border: 1px solid #2a3b52;
  border-radius: 0.75rem;
  display: flex;
  flex-direction: column;
  height: 100%;
}

.loading,
.empty {
  color: #b8c7da;
  padding: 1rem;
  text-align: center;
}

.sort-bar {
  align-items: center;
  border-bottom: 1px solid #1e2f45;
  display: flex;
  flex-shrink: 0;
  gap: 0.5rem;
  padding: 0.6rem 0.8rem;
}

.sort-label {
  color: #92a7c4;
  font-size: 0.78rem;
  text-transform: uppercase;
}

.sort-select {
  background-color: #0d1524;
  border: 1px solid #2a3b52;
  border-radius: 0.35rem;
  color: #d9e8ff;
  font-size: 0.82rem;
  padding: 0.25rem 0.45rem;
}

.sort-dir {
  background: #0d1524;
  border: 1px solid #2a3b52;
  border-radius: 0.35rem;
  color: #91d4ff;
  cursor: pointer;
  font-size: 0.9rem;
  line-height: 1;
  padding: 0.2rem 0.5rem;
}

.sort-dir:hover {
  border-color: #3a648f;
}

.cards {
  display: grid;
  flex: 1;
  gap: 0.7rem;
  overflow-y: auto;
  padding: 0.8rem;
}

.cards::-webkit-scrollbar {
  width: 0;
}

.cards {
  -ms-overflow-style: none;
  scrollbar-width: none;
}

.deal-card {
  background: linear-gradient(145deg, #121d2e, #0f1726);
  border: 1px solid #233750;
  border-radius: 0.7rem;
  cursor: pointer;
  display: grid;
  gap: 0.65rem;
  padding: 0.8rem;
  transition: transform 120ms ease, border-color 120ms ease, box-shadow 120ms ease;
}

.deal-card:hover {
  border-color: #3a648f;
  box-shadow: 0 5px 16px rgba(16, 35, 58, 0.45);
  transform: translateY(-1px);
}

.deal-card.selected {
  border-color: #5ea4e8;
  box-shadow: 0 0 0 1px rgba(94, 164, 232, 0.35) inset;
}

.card-header {
  align-items: start;
  display: flex;
  gap: 0.6rem;
  justify-content: space-between;
}

.item {
  background: none;
  border: none;
  color: #91d4ff;
  cursor: pointer;
  font-size: 1rem;
  font-weight: 700;
  line-height: 1.2;
  padding: 0;
  text-align: left;
  text-decoration: underline;
}

.profit-pair {
  align-items: stretch;
  background-color: #0d1524;
  border: 1px solid #1e2f45;
  border-radius: 0.45rem;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  min-width: 18rem;
}

.profit-col {
  display: grid;
  gap: 0.1rem;
  padding: 0.35rem 0.45rem;
}

.profit-col+.profit-col {
  border-left: 1px solid #1e2f45;
}

.profit-label {
  color: #8ea2be;
  font-size: 0.68rem;
  text-transform: uppercase;
}

.profit-value {
  color: #7dff9b;
  font-size: 0.82rem;
  font-weight: 800;
  white-space: nowrap;
}

.stations {
  display: grid;
  gap: 0.25rem;
}

.station-line {
  align-items: baseline;
  display: flex;
  gap: 0.4rem;
}

.label {
  color: #92a7c4;
  font-size: 0.78rem;
  min-width: 3.5rem;
  text-transform: uppercase;
}

.link {
  background: none;
  border: none;
  color: #d9e8ff;
  cursor: pointer;
  font: inherit;
  padding: 0;
  text-decoration: underline;
}

.metrics {
  display: grid;
  gap: 0.45rem;
  grid-template-columns: repeat(5, minmax(0, 1fr));
}

.metric {
  background-color: #0d1524;
  border: 1px solid #1e2f45;
  border-radius: 0.45rem;
  display: grid;
  gap: 0.1rem;
  padding: 0.35rem 0.45rem;
}

.metric-label {
  color: #8ea2be;
  font-size: 0.7rem;
  text-transform: uppercase;
}

.metric-value {
  color: #e5efff;
  font-size: 0.82rem;
  font-weight: 700;
}

.positive {
  color: #7dff9b;
  font-weight: 700;
}

.negative {
  color: #ff6b6b;
  font-weight: 700;
}

.route-sec {
  align-items: center;
  display: flex;
  gap: 0.5rem;
}

.route-label {
  color: #9db2cd;
  font-size: 0.72rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

@media (max-width: 760px) {
  .profit-pair {
    min-width: 0;
    width: 100%;
  }

  .card-header {
    align-items: stretch;
    flex-direction: column;
  }

  .metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
