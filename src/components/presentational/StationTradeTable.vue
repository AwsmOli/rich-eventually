<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import { eveAuthService } from '../../services/eveAuthService';
import { ordersService } from '../../services/ordersService';
import type { StationTradeOpportunity } from '../../types/domain';
import IskValue from './IskValue.vue';

type SortField = 'marginPercent' | 'profitPerUnit' | 'avgDailyTrades' | 'tradeVolumeIsk' | 'cheapestSellPrice' | 'vsAvg90d' | 'daysOfSupply';
type SortDir = 'asc' | 'desc';

const LS_KEY = 'rich-eventually:pinned-trades';
const LS_HIDDEN_KEY = 'rich-eventually:hidden-trades';

const SORT_OPTIONS: { value: SortField; label: string; }[] = [
  { value: 'tradeVolumeIsk', label: 'ISK Volume' },
  { value: 'marginPercent', label: 'Margin %' },
  { value: 'profitPerUnit', label: 'Profit / Unit' },
  { value: 'avgDailyTrades', label: 'Daily Trades' },
  { value: 'cheapestSellPrice', label: 'Sell Price' },
  { value: 'vsAvg90d', label: 'vs 90d Avg' },
  { value: 'daysOfSupply', label: 'Days of Supply' },
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

// ── Pin state ────────────────────────────────────────────────────────────────
// Stored as full objects so pinned items remain visible even when filtered out.

function loadPinned(): Map<number, StationTradeOpportunity> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return new Map();
    const arr = JSON.parse(raw) as StationTradeOpportunity[];
    return new Map(arr.map((o) => [o.typeId, o]));
  } catch {
    return new Map();
  }
}

function savePinned(map: Map<number, StationTradeOpportunity>): void {
  localStorage.setItem(LS_KEY, JSON.stringify([...map.values()]));
}

const pinnedItems = ref<Map<number, StationTradeOpportunity>>(loadPinned());

// Refresh cached opportunity data whenever fresh rows arrive.
watch(
  () => props.rows,
  (rows) => {
    let changed = false;
    for (const row of rows) {
      if (pinnedItems.value.has(row.typeId)) {
        pinnedItems.value.set(row.typeId, row);
        changed = true;
      }
    }
    if (changed) {
      pinnedItems.value = new Map(pinnedItems.value);
      savePinned(pinnedItems.value);
    }
  },
);

function togglePin(row: StationTradeOpportunity): void {
  const map = new Map(pinnedItems.value);
  if (map.has(row.typeId)) {
    map.delete(row.typeId);
  } else {
    map.set(row.typeId, row);
  }
  pinnedItems.value = map;
  savePinned(map);
}

const pinnedTypeIds = computed(() => new Set(pinnedItems.value.keys()));

// ── Hidden state ─────────────────────────────────────────────────────────────

function loadHidden(): Set<number> {
  try {
    const raw = localStorage.getItem(LS_HIDDEN_KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as number[]);
  } catch {
    return new Set();
  }
}

function saveHidden(set: Set<number>): void {
  localStorage.setItem(LS_HIDDEN_KEY, JSON.stringify([...set]));
}

const hiddenTypeIds = ref<Set<number>>(loadHidden());
const showHidden = ref(false);

function toggleHide(typeId: number): void {
  const next = new Set(hiddenTypeIds.value);
  if (next.has(typeId)) {
    next.delete(typeId);
  } else {
    next.add(typeId);
    // Unpin if hiding
    const pinMap = new Map(pinnedItems.value);
    if (pinMap.delete(typeId)) {
      pinnedItems.value = pinMap;
      savePinned(pinMap);
    }
  }
  hiddenTypeIds.value = next;
  saveHidden(next);
}

const hiddenCount = computed(() => hiddenTypeIds.value.size);

// Live sets of typeIds with open buy/sell orders — updates reactively with ordersService.
const openBuyTypeIds = computed(
  () => new Set(ordersService.openOrders.value.filter((o) => o.isBuyOrder).map((o) => o.typeId)),
);
const openSellTypeIds = computed(
  () => new Set(ordersService.openOrders.value.filter((o) => !o.isBuyOrder).map((o) => o.typeId)),
);

// ── Sorted rows ──────────────────────────────────────────────────────────────
// Pinned rows always appear first (using fresh data if available, else cached).
// Unpinned rows are sorted by the selected field.

const sortedRows = computed(() => {
  const field = sortField.value;
  const dir = sortDir.value === 'asc' ? 1 : -1;

  const liveByType = new Map(props.rows.map((r) => [r.typeId, r]));

  const pinnedRows = [...pinnedItems.value.keys()]
    .filter((id) => showHidden.value || !hiddenTypeIds.value.has(id))
    .map((id) => liveByType.get(id) ?? pinnedItems.value.get(id)!);

  const unpinned = props.rows
    .filter((r) => !pinnedTypeIds.value.has(r.typeId) && (showHidden.value || !hiddenTypeIds.value.has(r.typeId)))
    .sort((a, b) => {
      const av = a[field] ?? -Infinity;
      const bv = b[field] ?? -Infinity;
      return (av - bv) * dir;
    });

  return [...pinnedRows, ...unpinned];
});

// ── Actions ──────────────────────────────────────────────────────────────────

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
  .controls(v-if="sortedRows.length > 0 || rows.length > 0 || hiddenCount > 0")
    label.sort-label Sort by
    select.sort-select(:value="sortField" @change="onSortChange")
      option(v-for="opt in SORT_OPTIONS" :key="opt.value" :value="opt.value") {{ opt.label }}
    label.sort-label.ml Direction
    select.sort-select(:value="sortDir" @change="onSortDirChange")
      option(value="desc") ↓ High → Low
      option(value="asc") ↑ Low → High
    button.show-hidden-btn(v-if="hiddenCount > 0" type="button" @click="showHidden = !showHidden" :class="{ active: showHidden }")
      | {{ showHidden ? '👁 Hide hidden' : `👁 Show hidden (${hiddenCount})` }}
  .loading(v-if="isLoading") Scanning station orders…
  .empty(v-else-if="sortedRows.length === 0") No station trading opportunities found for the current filters.
  .tbl-wrap(v-else)
    table.tbl
      thead
        tr
          th.th-name Item
          th Buy / Sell
          th Margin / Profit
          th Daily / ISK vol
          th 90d avg
          th Days of Supply
      tbody
        tr(:class="['trow', { 'trow--pinned': pinnedTypeIds.has(row.typeId), 'trow--hidden': hiddenTypeIds.has(row.typeId), 'trow--has-inventory': row.hasInventory, 'trow--has-order': openBuyTypeIds.has(row.typeId) || openSellTypeIds.has(row.typeId) }]" v-for="row in sortedRows" :key="row.typeId")
          td.td-name
            .name-row
              button.item-name(type="button" @click="copy(row.itemName); openMarket(row.typeId, $event)" title="Click to copy · Shift+click to open in market") {{ row.itemName }}
              .row-badges
                span.badge.badge--inventory(v-if="row.hasInventory" title="You own this item") own
                span.badge.badge--order-buy(v-if="openBuyTypeIds.has(row.typeId)" title="You have an open buy order") B
                span.badge.badge--order-sell(v-if="openSellTypeIds.has(row.typeId)" title="You have an open sell order") S
                button.pin-btn(:class="{ active: pinnedTypeIds.has(row.typeId) }" type="button" @click.stop="togglePin(row)" :title="pinnedTypeIds.has(row.typeId) ? 'Unpin from top' : 'Pin to top'") 📌
                button.hide-btn(:class="{ active: hiddenTypeIds.has(row.typeId) }" type="button" @click.stop="toggleHide(row.typeId)" :title="hiddenTypeIds.has(row.typeId) ? 'Unhide' : 'Hide'") 🙈
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
          td(data-label="Daily / ISK vol")
            .price-pair
              .price-line {{ Math.round(row.avgDailyTrades).toLocaleString() }} / day
              .price-line
                IskValue(:value="row.tradeVolumeIsk")
          td(data-label="90d avg")
            .price-pair
              .price-line
                template(v-if="row.avg90dPrice !== undefined")
                  IskValue(:value="row.avg90dPrice")
                template(v-else) —
              .price-line
                template(v-if="row.vsAvg90d !== undefined")
                  span(:class="row.vsAvg90d > 0 ? 'positive' : row.vsAvg90d < 0 ? 'negative' : 'neutral'")
                    | {{ row.vsAvg90d > 0 ? '+' : '' }}{{ (row.vsAvg90d * 100).toFixed(1) }}%
                template(v-else) —
          td(data-label="Days of Supply")
            template(v-if="row.daysOfSupply !== undefined")
              span(:class="row.daysOfSupply < 3 ? 'positive' : row.daysOfSupply < 14 ? 'neutral' : 'negative'")
                | {{ row.daysOfSupply.toFixed(1) }}d
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

.name-row {
  align-items: center;
  display: flex;
  gap: 0.4rem;
  justify-content: space-between;
}

.row-badges {
  align-items: center;
  display: flex;
  flex-shrink: 0;
  gap: 0.3rem;
}

.badge {
  border-radius: 0.2rem;
  font-size: 0.62rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  padding: 0.08rem 0.28rem;
  text-transform: uppercase;

  &--inventory {
    background: rgba(125, 255, 155, 0.15);
    color: #7dff9b;
  }

  &--order-buy {
    background: rgba(100, 220, 130, 0.15);
    color: #64dc82;
  }

  &--order-sell {
    background: rgba(255, 90, 90, 0.15);
    color: #ff5a5a;
  }
}

.show-hidden-btn {
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid #33455f;
  border-radius: 0.4rem;
  color: #7a94b2;
  cursor: pointer;
  font-size: 0.78rem;
  margin-left: auto;
  padding: 0.25rem 0.55rem;
  transition: background 0.15s, color 0.15s;

  &:hover {
    background: rgba(255, 255, 255, 0.09);
    color: #ecf4ff;
  }

  &.active {
    background: rgba(255, 180, 50, 0.12);
    border-color: rgba(255, 180, 50, 0.4);
    color: #ffd96a;
  }
}

.pin-btn {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 0.8rem;
  line-height: 1;
  opacity: 0.22;
  padding: 0;
  transition: opacity 0.15s;

  &:hover {
    opacity: 0.65;
  }

  &.active {
    opacity: 1;
  }
}

.trow--pinned td {
  background: rgba(255, 205, 50, 0.04);
}

.trow--pinned td.td-name {
  background: rgba(255, 205, 50, 0.07);
  border-left: 3px solid rgba(255, 205, 50, 0.55);
}

.trow--has-inventory:not(.trow--pinned) td.td-name {
  border-left: 3px solid rgba(125, 255, 155, 0.45);
}

.hide-btn {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 0.8rem;
  line-height: 1;
  opacity: 0.22;
  padding: 0;
  transition: opacity 0.15s;

  &:hover {
    opacity: 0.65;
  }

  &.active {
    opacity: 1;
  }
}

.trow--hidden td {
  opacity: 0.4;
}

.trow--has-order:not(.trow--pinned):not(.trow--has-inventory) td.td-name {
  border-left: 3px solid rgba(100, 180, 255, 0.45);
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
