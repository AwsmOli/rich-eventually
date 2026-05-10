<script setup lang="ts">
import { computed, ref } from 'vue';

import { eveAuthService } from '../../services/eveAuthService';
import type { StationTradeOpportunity } from '../../types/domain';
import IskValue from './IskValue.vue';

type SortField = 'marginPercent' | 'profitPerUnit' | 'avgDailyTrades' | 'tradeVolumeIsk' | 'cheapestSellPrice' | 'vsAvg90d';
type SortDir = 'asc' | 'desc';

const SORT_OPTIONS: { value: SortField; label: string; }[] = [
  { value: 'tradeVolumeIsk', label: 'ISK Volume' },
  { value: 'marginPercent', label: 'Margin %' },
  { value: 'profitPerUnit', label: 'Profit / Unit' },
  { value: 'avgDailyTrades', label: 'Daily Trades' },
  { value: 'cheapestSellPrice', label: 'Sell Price' },
  { value: 'vsAvg90d', label: 'vs 90d Avg' },
];

const props = defineProps<{
  rows: StationTradeOpportunity[];
  isLoading: boolean;
}>();

const emit = defineEmits<{
  (event: 'copy', value: string): void;
}>();

const sortField = ref<SortField>('tradeVolumeIsk');
const sortDir = ref<SortDir>('desc');

const sortedRows = computed(() => {
  const field = sortField.value;
  const dir = sortDir.value === 'asc' ? 1 : -1;
  return [...props.rows].sort((a, b) => {
    const av = a[field] ?? -Infinity;
    const bv = b[field] ?? -Infinity;
    return (av - bv) * dir;
  });
});

function copy(value: string): void {
  emit('copy', value);
}

async function openMarket(typeId: number, event: MouseEvent): Promise<void> {
  if (!event.shiftKey || !eveAuthService.character.value) return;
  const token = await eveAuthService.getAccessToken();
  if (!token) return;
  await fetch(
    `https://esi.evetech.net/latest/ui/openwindow/marketdetails/?datasource=tranquility&type_id=${typeId}`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
  );
}

function onSortChange(event: Event): void {
  sortField.value = (event.target as HTMLSelectElement).value as SortField;
  sortDir.value = 'desc';
}

function onSortDirChange(event: Event): void {
  sortDir.value = (event.target as HTMLSelectElement).value as SortDir;
}
</script>

<template lang="pug">
.table-card
  .controls(v-if="rows.length > 0")
    label.sort-label Sort by
    select.sort-select(:value="sortField" @change="onSortChange")
      option(v-for="opt in SORT_OPTIONS" :key="opt.value" :value="opt.value") {{ opt.label }}
    label.sort-label.ml Direction
    select.sort-select(:value="sortDir" @change="onSortDirChange")
      option(value="desc") ↓ High → Low
      option(value="asc") ↑ Low → High
  .loading(v-if="isLoading") Scanning station orders…
  .empty(v-else-if="rows.length === 0") No station trading opportunities found for the current filters.
  .tbl-wrap(v-else)
    table.tbl
      thead
        tr
          th.th-name Item
          th Buy / Sell
          th Margin / Profit
          th Daily trades
          th ISK vol / day
          th 90d avg price
          th vs 90d avg
      tbody
        tr.trow(v-for="row in sortedRows" :key="row.typeId")
          td.td-name
            button.item-name(type="button" @click="copy(row.itemName); openMarket(row.typeId, $event)" title="Click to copy · Shift+click to open in market") {{ row.itemName }}
          td(data-label="Buy / Sell")
            .price-pair
              .price-line
                span.sub-lbl b 
                IskValue(:value="row.highestBuyPrice")
              .price-line
                span.sub-lbl s 
                IskValue(:value="row.cheapestSellPrice")
          td(data-label="Margin / Profit")
            .price-pair
              .price-line
                span(:class="row.marginPercent >= 10 ? 'positive' : row.marginPercent >= 0 ? 'neutral' : 'negative'")
                  | {{ row.marginPercent.toFixed(2) }}%
              .price-line
                span(:class="row.profitPerUnit > 0 ? 'positive' : 'negative'")
                  | {{ row.profitPerUnit > 0 ? '+' : '' }}
                  IskValue(style="display:inline" :value="row.profitPerUnit")
          td(data-label="Daily trades") {{ Math.round(row.avgDailyTrades).toLocaleString() }}
          td(data-label="ISK vol / day")
            IskValue(:value="row.tradeVolumeIsk")
          td(data-label="90d avg price")
            template(v-if="row.avg90dPrice !== undefined")
              IskValue(:value="row.avg90dPrice")
            template(v-else) —
          td(data-label="vs 90d avg")
            template(v-if="row.vsAvg90d !== undefined")
              span(:class="row.vsAvg90d > 0 ? 'positive' : row.vsAvg90d < 0 ? 'negative' : 'neutral'")
                | {{ row.vsAvg90d > 0 ? '+' : '' }}{{ (row.vsAvg90d * 100).toFixed(1) }}%
            template(v-else) —
</template>

<style scoped lang="scss">
.table-card {
  background-color: #0f1622;
  border: 1px solid #2a3b52;
  border-radius: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 1rem;
}

.controls {
  align-items: center;
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.sort-label {
  color: #7a94b2;
  font-size: 0.8rem;

  &.ml {
    margin-left: 0.75rem;
  }
}

.sort-select {
  background-color: #09111d;
  border: 1px solid #33455f;
  border-radius: 0.4rem;
  color: #ecf4ff;
  font-size: 0.85rem;
  padding: 0.3rem 0.5rem;
}

.loading,
.empty {
  color: #b8c7da;
  padding: 1rem;
  text-align: center;
}

.tbl-wrap {
  overflow-x: auto;
}

.tbl {
  border-collapse: collapse;
  font-size: 0.85rem;
  width: 100%;

  th {
    border-bottom: 1px solid #253448;
    color: #5e7a99;
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    padding: 0.45rem 0.75rem;
    text-align: right;
    text-transform: uppercase;
    white-space: nowrap;

    &.th-name {
      text-align: left;
    }
  }

  td {
    border-bottom: 1px solid #1a2535;
    color: #ecf4ff;
    font-weight: 600;
    padding: 0.5rem 0.75rem;
    text-align: right;
    white-space: nowrap;

    &.td-name {
      text-align: left;
    }
  }

  .trow:hover td {
    background: rgba(255, 255, 255, 0.03);
  }
}

.item-name {
  background: none;
  border: none;
  color: #b8d4ff;
  cursor: pointer;
  font-size: 0.85rem;
  font-weight: 600;
  padding: 0;
  text-align: left;

  &:hover {
    color: #87ffca;
    text-decoration: underline;
  }
}

.positive {
  color: #7dff9b;
}

.negative {
  color: #ff6b6b;
}

.neutral {
  color: #ffd96a;
}

.price-pair {
  display: flex;
  flex-direction: column;
  gap: 0.18rem;
}

.price-line {
  display: flex;
  align-items: baseline;
  justify-content: flex-end;
}

.sub-lbl {
  color: #3a5a7a;
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.03em;
  text-transform: uppercase;
}

@media (max-width: 639px) {
  .tbl-wrap {
    overflow-x: visible;
  }

  .tbl {
    font-size: 0.84rem;

    thead {
      display: none;
    }

    tbody tr.trow {
      background: #0e1c2e;
      border: 1px solid #1a2a3a;
      border-radius: 0.45rem;
      display: grid;
      grid-template-columns: 1fr 1fr;
      margin-bottom: 0.5rem;
      overflow: hidden;
    }

    // Item name spans full width as card header
    td.td-name {
      grid-column: 1 / -1;
      background: #0c1624;
      border-bottom: 1px solid #1a2a3a;
      padding: 0.5rem 0.65rem;
      text-align: left;
      white-space: normal;
    }

    // Data cells: label on top, value below
    td[data-label] {
      border-bottom: 1px solid #0e1e30;
      display: flex;
      flex-direction: column;
      padding: 0.35rem 0.65rem;
      text-align: left;
      white-space: normal;

      &::before {
        color: #3a5a7a;
        content: attr(data-label);
        font-size: 0.68rem;
        font-weight: 600;
        letter-spacing: 0.04em;
        margin-bottom: 0.15rem;
        text-transform: uppercase;
      }
    }

    .trow:hover td {
      background: transparent;
    }

    .trow:hover {
      background: #101e30;
    }

    .trow:hover td.td-name {
      background: #0c1624;
    }
  }
}
</style>
