<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';

import { eveAuthService } from '../../services/eveAuthService';
import { marketDataService } from '../../services/marketDataService';
import { ordersService, type InventoryItem } from '../../services/ordersService';

const IGNORED_KEY = 'assets-ignored-items';
const IGNORED_SEP = ',';

function loadIgnored(): Set<string> {
  try {
    const raw = localStorage.getItem(IGNORED_KEY) ?? '';
    return new Set(raw ? raw.split(IGNORED_SEP) : []);
  } catch { return new Set(); }
}

function saveIgnored(set: Set<string>): void {
  try { localStorage.setItem(IGNORED_KEY, [...set].join(IGNORED_SEP)); } catch { /* noop */ }
}

function itemKey(typeId: number, locationId: number): string {
  return `${typeId}:${locationId}`;
}

const inventoryItems = ordersService.inventoryItems;
const isEnriching = ref(false);

const now = ref(Date.now());
const nowTimer = setInterval(() => { now.value = Date.now(); }, 10_000);
onUnmounted(() => clearInterval(nowTimer));

const nextUpdateIn = computed(() => {
  const exp = ordersService.esiExpiresAt.value;
  if (!exp) return null;
  const secs = Math.max(0, Math.round((exp - now.value) / 1000));
  if (secs <= 0) return 'soon';
  if (secs < 60) return `${secs}s`;
  return `${Math.ceil(secs / 60)}m`;
});

// Only show the progress overlay before the first enrichment completes.
// After data has loaded once, re-polls run silently in the background.
const hasLoadedOnce = ref(false);
const isProgressVisible = computed(
  () => !hasLoadedOnce.value && (ordersService.isLoading.value || isEnriching.value),
);

// Ensure polling starts even if OrdersPanel is not mounted (e.g. sidebar collapsed).
watch(eveAuthService.character, (c) => {
  if (c) ordersService.startPolling();
}, { immediate: true });

// ── Filters ──────────────────────────────────────────────────────────────

/** Hide assembled items (ships, containers, etc.) when true. */
const filterHideAssembled = ref(true);
/** Show items the user marked as “not for sale”. */
const showIgnored = ref(false);
/** Set of “typeId:locationId” keys the user wants to ignore. */
const ignoredKeys = ref<Set<string>>(loadIgnored());

function toggleIgnore(typeId: number, locationId: number): void {
  const key = itemKey(typeId, locationId);
  const next = new Set(ignoredKeys.value);
  if (next.has(key)) next.delete(key); else next.add(key);
  ignoredKeys.value = next;
  saveIgnored(next);
}

interface EnrichedItem extends InventoryItem {
  locationName: string;
  totalM3: number | undefined;
  canBeAssembled: boolean;
  avgMarketPrice: number | undefined;
  avgMarketProfitPct: number | undefined;
  bestSellOrder: number | undefined;
  sellOrderProfitPct: number | undefined;
  bestInstantSell: number | undefined;
  profitPct: number | undefined;
}

const enrichedItems = ref<EnrichedItem[]>([]);
const enrichProgress = ref({ current: 0, total: 0 });

async function enrich(items: InventoryItem[]): Promise<void> {
  if (items.length === 0) {
    enrichedItems.value = [];
    enrichProgress.value = { current: 0, total: 0 };
    return;
  }
  isEnriching.value = true;
  enrichProgress.value = { current: 0, total: items.length };
  try {
    const locationIds = [...new Set(items.map((i) => i.locationId))];
    const nameMap = await marketDataService.getNames(locationIds);

    const allTypeIds = [...new Set(items.map((i) => i.typeId))];
    const typeDetails = await marketDataService.getTypeDetails(allTypeIds);

    // Build locationId → regionId map. Items already have regionId when the
    // character has an order at that location; for all others, resolve via ESI.
    const locationRegionMap = new Map<number, number>();
    for (const item of items) {
      if (item.regionId !== undefined) locationRegionMap.set(item.locationId, item.regionId);
    }
    await Promise.all(
      locationIds
        .filter((id) => !locationRegionMap.has(id))
        .map(async (id) => {
          const regionId = await marketDataService.resolveLocationRegionId(id);
          if (regionId !== undefined) locationRegionMap.set(id, regionId);
        }),
    );

    // Ensure region orders are cached for BEST INSTANT SELL / BEST SELL ORDER.
    const uniqueRegions = [...new Set(locationRegionMap.values())];
    await Promise.all(
      uniqueRegions
        .filter((r) => !marketDataService.isRegionLoaded(r))
        .map((r) => marketDataService.fetchAndIndexRegion(r)),
    );

    const results: EnrichedItem[] = [];
    for (const item of items) {
      let avgMarketPrice: number | undefined;
      let bestInstantSell: number | undefined;
      let bestSellOrder: number | undefined;

      const regionId = item.regionId ?? locationRegionMap.get(item.locationId);
      if (regionId !== undefined) {
        const summary = await marketDataService.getHistorySummary(regionId, item.typeId);
        avgMarketPrice = summary.avgPrice;
        bestInstantSell = marketDataService.getHighestBuyPrice(regionId, item.typeId);
        bestSellOrder = marketDataService.getLowestSellPrice(regionId, item.typeId);
      }

      const volumeM3 = typeDetails.get(item.typeId)?.volumeM3;
      const totalM3 = volumeM3 !== undefined ? volumeM3 * item.qty : undefined;
      const canBeAssembled = typeDetails.get(item.typeId)?.canBeAssembled ?? false;

      const avgMarketProfitPct =
        avgMarketPrice !== undefined && item.avgBuyPrice > 0
          ? ((avgMarketPrice - item.avgBuyPrice) / item.avgBuyPrice) * 100
          : undefined;

      const profitPct =
        bestInstantSell !== undefined && item.avgBuyPrice > 0
          ? ((bestInstantSell - item.avgBuyPrice) / item.avgBuyPrice) * 100
          : undefined;

      const sellOrderProfitPct =
        bestSellOrder !== undefined && item.avgBuyPrice > 0
          ? ((bestSellOrder - item.avgBuyPrice) / item.avgBuyPrice) * 100
          : undefined;

      results.push({
        ...item,
        locationName: nameMap[item.locationId] ?? `Location ${item.locationId}`,
        totalM3,
        canBeAssembled,
        avgMarketPrice,
        avgMarketProfitPct,
        bestSellOrder,
        sellOrderProfitPct,
        bestInstantSell,
        profitPct,
      });

      enrichProgress.value = { current: results.length, total: items.length };
    }

    enrichedItems.value = results;
  } finally {
    isEnriching.value = false;
    hasLoadedOnce.value = true;
  }
}

type SortField = 'typeName' | 'qty' | 'avgBuyPrice' | 'totalCost' | 'jitaValue' | 'avgMarketPrice' | 'bestSellOrder' | 'bestInstantSell' | 'lastBuyDate';
const sortField = ref<SortField>('jitaValue');
const sortDir = ref<'asc' | 'desc'>('desc');

function setSort(field: SortField): void {
  if (sortField.value === field) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc';
  } else {
    sortField.value = field;
    sortDir.value = field === 'typeName' || field === 'lastBuyDate' ? 'asc' : 'desc';
  }
}

function sortIndicator(field: SortField): string {
  if (sortField.value !== field) return '';
  return sortDir.value === 'asc' ? ' ▲' : ' ▼';
}

function sortedItems(items: EnrichedItem[]): EnrichedItem[] {
  void marketDataService.marketTick.value;
  const dir = sortDir.value === 'asc' ? 1 : -1;
  return [...items].sort((a, b) => {
    switch (sortField.value) {
      case 'typeName': return dir * a.typeName.localeCompare(b.typeName);
      case 'qty': return dir * (a.qty - b.qty);
      case 'avgBuyPrice': return dir * (a.avgBuyPrice - b.avgBuyPrice);
      case 'totalCost': return dir * (a.totalCost - b.totalCost);
      case 'jitaValue': {
        const va = (marketDataService.getHighestBuyPrice(JITA_REGION, a.typeId, JITA_SYSTEM) ?? a.avgBuyPrice) * a.qty;
        const vb = (marketDataService.getHighestBuyPrice(JITA_REGION, b.typeId, JITA_SYSTEM) ?? b.avgBuyPrice) * b.qty;
        return dir * (va - vb);
      }
      case 'avgMarketPrice': return dir * ((a.avgMarketPrice ?? -Infinity) - (b.avgMarketPrice ?? -Infinity));
      case 'bestSellOrder': return dir * ((a.bestSellOrder ?? -Infinity) - (b.bestSellOrder ?? -Infinity));
      case 'bestInstantSell': return dir * ((a.bestInstantSell ?? -Infinity) - (b.bestInstantSell ?? -Infinity));
      case 'lastBuyDate': return dir * a.lastBuyDate.localeCompare(b.lastBuyDate);
      default: return 0;
    }
  });
}

watch(inventoryItems, (items) => { void enrich(items); }, { immediate: true });

// Group by locationName, sorted by total cost desc within each group.
const visibleItems = computed(() => {
  return enrichedItems.value.filter((item) => {
    const ignored = ignoredKeys.value.has(itemKey(item.typeId, item.locationId));
    if (ignored && !showIgnored.value) return false;
    if (filterHideAssembled.value && (item.isAssembled || item.canBeAssembled)) return false;
    return true;
  });
});

const JITA_REGION = 10000002;
const JITA_SYSTEM = 30000142;

function jitaValue(items: EnrichedItem[]): number {
  void marketDataService.marketTick.value;
  return items.reduce((s, i) => {
    const price = marketDataService.getHighestBuyPrice(JITA_REGION, i.typeId, JITA_SYSTEM) ?? i.avgBuyPrice;
    return s + i.qty * price;
  }, 0);
}

const groupedByLocation = computed(() => {
  const groups = new Map<string, EnrichedItem[]>();
  for (const item of visibleItems.value) {
    if (!groups.has(item.locationName)) groups.set(item.locationName, []);
    groups.get(item.locationName)!.push(item);
  }
  return [...groups.entries()]
    .sort((a, b) => jitaValue(b[1]) - jitaValue(a[1]));
});

const totalCost = computed(() => jitaValue(visibleItems.value));

// ── Helpers ──────────────────────────────────────────────────────────────────

function isk(n: number): string {
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function fmtPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
}

function fmtM3(m3: number): string {
  if (m3 >= 1_000_000) return `${(m3 / 1_000_000).toFixed(2)}Mm³`;
  if (m3 >= 1_000) return `${(m3 / 1_000).toFixed(1)}km³`;
  return `${m3.toLocaleString(undefined, { maximumFractionDigits: 1 })}`;
}

async function copyName(name: string): Promise<void> {
  await navigator.clipboard.writeText(name);
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

// Collapsible groups — all open by default.
const collapsedGroups = ref(new Set<string>());
function toggleGroup(name: string): void {
  if (collapsedGroups.value.has(name)) collapsedGroups.value.delete(name);
  else collapsedGroups.value.add(name);
  collapsedGroups.value = new Set(collapsedGroups.value); // trigger reactivity
}


</script>

<template lang="pug">
.assets-tab
  .assets-header
    .assets-summary(v-if="enrichedItems.length > 0")
      span.summary-item {{ visibleItems.length }} items
      span.summary-sep ·
      span.summary-item Total: {{ isk(totalCost) }} ISK
  .filter-bar
    label.filter-check
      input(type="checkbox" v-model="filterHideAssembled")
      span Hide assembled
    label.filter-check
      input(type="checkbox" v-model="showIgnored")
      span Show not-for-sale
    span.next-update(v-if="nextUpdateIn") next update {{ nextUpdateIn }}
  //- Progress bars — absolutely overlaid so they don't shift layout
  .assets-progress(v-show="isProgressVisible")
    .progress-row(v-show="ordersService.isLoading.value")
      .progress-header
        span.progress-label Loading orders…
      .progress-track
        .progress-fill.indeterminate
    .progress-row(v-show="isEnriching")
      .progress-header
        span.progress-label Enriching items
        span.progress-count {{ enrichProgress.current }} / {{ enrichProgress.total }}
      .progress-track
        .progress-fill(:style="{ width: `${enrichProgress.total > 0 ? (enrichProgress.current / enrichProgress.total) * 100 : 0}%` }")

  .empty-state(v-if="!isEnriching && enrichedItems.length === 0")
    p No unlisted inventory found.
    p.hint Make sure you&apos;re logged in and have bought items via buy orders that haven&apos;t been sold yet.

  .location-group(v-for="[locationName, items] in groupedByLocation" :key="locationName")
    .location-header(@click="toggleGroup(locationName)")
      span.collapse-icon {{ collapsedGroups.has(locationName) ? '▶' : '▼' }}
      span.location-name {{ locationName }}
      span.location-meta
        span.location-count {{ items.length }} items
        span.location-sep  · 
        span.location-total {{ isk(jitaValue(items)) }} ISK
    .assets-table-wrap(v-show="!collapsedGroups.has(locationName)")
      table.assets-table
        thead
          tr
            th(@click="setSort('typeName')" style="cursor:pointer") Name{{ sortIndicator('typeName') }}
            th.num(@click="setSort('qty')" style="cursor:pointer") Qty{{ sortIndicator('qty') }}
            th.num(@click="setSort('avgBuyPrice')" style="cursor:pointer") Buy Price{{ sortIndicator('avgBuyPrice') }}
            th.num(@click="setSort('totalCost')" style="cursor:pointer") Total Cost{{ sortIndicator('totalCost') }}
            th.num(@click="setSort('jitaValue')" style="cursor:pointer") Total Value{{ sortIndicator('jitaValue') }}
            th.num(@click="setSort('avgMarketPrice')" style="cursor:pointer") Avg Market{{ sortIndicator('avgMarketPrice') }}
            th.num(@click="setSort('bestSellOrder')" style="cursor:pointer") Best Sell Order{{ sortIndicator('bestSellOrder') }}
            th.num(@click="setSort('bestInstantSell')" style="cursor:pointer") Best Instant Sell{{ sortIndicator('bestInstantSell') }}
            th(@click="setSort('lastBuyDate')" style="cursor:pointer") Last Buy{{ sortIndicator('lastBuyDate') }}
            th
        tbody
          tr(v-for="item in sortedItems(items)" :key="`${item.typeId}:${item.locationId}`" :class="{ 'ignored-row': ignoredKeys.has(itemKey(item.typeId, item.locationId)) }")
            td.name-cell(data-label="Name")
              span(@click="copyName(item.typeName); openMarket(item.typeId, $event)" title="Click to copy · Shift+click to open in market") {{ item.typeName }}
              span.mobile-sub
                span.mobile-qty {{ item.qty.toLocaleString() }}
                span.mobile-m3(v-if="item.totalM3 !== undefined")  · {{ fmtM3(item.totalM3) }} m³
                span.mobile-date(v-if="item.avgBuyPrice > 0") {{ fmtDate(item.lastBuyDate) }}
            td.num(data-label="Qty")
              div {{ item.qty.toLocaleString() }}
              div.sub-pct.muted(v-if="item.totalM3 !== undefined") {{ fmtM3(item.totalM3) }} m³
            td.num(data-label="Buy Price")
              span(v-if="item.avgBuyPrice > 0") {{ isk(item.avgBuyPrice) }}
              span.muted(v-else) —
            td.num(data-label="Total Cost")
              span(v-if="item.avgBuyPrice > 0") {{ isk(item.totalCost) }}
              span.muted(v-else) —
            td.num(data-label="Total Value")
              div(v-if="item.bestInstantSell !== undefined")
                div {{ isk(item.bestInstantSell * item.qty) }}
                div.sub-pct(:class="item.profitPct !== undefined ? (item.profitPct >= 0 ? 'pos' : 'neg') : 'muted'")
                  | {{ item.profitPct !== undefined ? fmtPct(item.profitPct) : '—' }}
              span.muted(v-else) —
            td.num(data-label="Avg Market")
              div(v-if="item.avgMarketPrice !== undefined")
                div {{ isk(item.avgMarketPrice) }}
                div.sub-pct(:class="item.avgMarketProfitPct !== undefined ? (item.avgMarketProfitPct >= 0 ? 'pos' : 'neg') : 'muted'")
                  | {{ item.avgMarketProfitPct !== undefined ? fmtPct(item.avgMarketProfitPct) : '—' }}
              span.muted(v-else) —
            td.num(data-label="Best Sell Order")
              div(v-if="item.bestSellOrder !== undefined")
                div {{ isk(item.bestSellOrder) }}
                div.sub-pct(:class="item.sellOrderProfitPct !== undefined ? (item.sellOrderProfitPct >= 0 ? 'pos' : 'neg') : 'muted'")
                  | {{ item.sellOrderProfitPct !== undefined ? fmtPct(item.sellOrderProfitPct) : '—' }}
              span.muted(v-else) —
            td.num(data-label="Best Instant Sell")
              div(v-if="item.bestInstantSell !== undefined")
                div {{ isk(item.bestInstantSell) }}
                div.sub-pct(:class="item.profitPct !== undefined ? (item.profitPct >= 0 ? 'pos' : 'neg') : 'muted'")
                  | {{ item.profitPct !== undefined ? fmtPct(item.profitPct) : '—' }}
              span.muted(v-else) —
            td.date-cell(data-label="Last Buy")
              span(v-if="item.avgBuyPrice > 0") {{ fmtDate(item.lastBuyDate) }}
              span.muted(v-else) —
            td.btn-cell
              button.ignore-btn(
                :title="ignoredKeys.has(itemKey(item.typeId, item.locationId)) ? 'Mark as for sale' : 'Mark as not for sale'"
                @click.stop="toggleIgnore(item.typeId, item.locationId)"
              ) {{ ignoredKeys.has(itemKey(item.typeId, item.locationId)) ? '↺' : '×' }}
</template>

<style scoped lang="scss">
.assets-tab {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.assets-header {
  align-items: baseline;
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
}

.title-text {
  color: #c8d8e8;
  font-size: 1rem;
  font-weight: 700;
}

.title-hint {
  color: #3a5a7a;
  font-size: 0.8rem;
  font-style: italic;
}

.assets-summary {
  align-items: center;
  color: #6a8aaa;
  display: flex;
  font-size: 0.82rem;
  gap: 0.4rem;
  margin-left: auto;
}

.summary-sep {
  opacity: 0.4;
}

.assets-tab {
  position: relative;
}

.assets-progress {
  background: rgba(10, 20, 35, 0.94);
  border: 1px solid #1a2e44;
  border-radius: 0.4rem;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  left: 0;
  padding: 0.5rem 0.75rem;
  position: absolute;
  right: 0;
  top: 3.5rem;
  z-index: 10;
}

.progress-row {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.progress-header {
  display: flex;
  justify-content: space-between;
}

.progress-label {
  color: #5a8fa8;
  font-size: 0.78rem;
}

.progress-count {
  color: #4a6a8a;
  font-size: 0.78rem;
}

.progress-track {
  background: rgba(255, 255, 255, 0.07);
  border-radius: 2px;
  height: 3px;
  overflow: hidden;
}

.progress-fill {
  background: #5a8fa8;
  border-radius: 2px;
  height: 100%;
  transition: width 0.3s ease;

  &.indeterminate {
    animation: indeterminate 1.4s ease-in-out infinite;
    width: 40% !important;
  }
}

@keyframes indeterminate {
  0% {
    transform: translateX(-100%);
  }

  100% {
    transform: translateX(350%);
  }
}

@keyframes pulse {

  0%,
  100% {
    opacity: 1;
  }

  50% {
    opacity: 0.4;
  }
}

.empty-state {
  color: #5a7a9a;
  padding: 2rem 0;
  text-align: center;

  p {
    margin: 0.25rem 0;
  }

  .hint {
    color: #3a5a7a;
    font-size: 0.82rem;
    font-style: italic;
  }
}

.location-group {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.location-header {
  align-items: baseline;
  border-bottom: 1px solid #1e2e42;
  cursor: pointer;
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem;
  padding: 0.35rem 0.2rem 0.35rem 0;
  user-select: none;

  &:hover .location-name {
    color: #c8eeff;
  }

  @media (max-width: 639px) {
    gap: 0.1rem;
    padding: 0.45rem 0.2rem 0.45rem 0;

    .collapse-icon {
      display: none;
    }

    .location-name {
      width: 100%;
    }

    .location-meta {
      width: 100%;
    }
  }
}

.collapse-icon {
  color: #3a5a7a;
  flex-shrink: 0;
  font-size: 0.65rem;
  width: 0.8rem;
}

.location-name {
  color: #8ed8ff;
  font-size: 0.88rem;
  font-weight: 600;
}

.location-meta {
  color: #4a6a8a;
  font-size: 0.78rem;
  margin-left: auto;

  @media (max-width: 639px) {
    margin-left: 0;
    width: 100%;
  }
}

.location-count {
  color: #4a6a8a;
}

.location-sep {
  color: #2a4a6a;
}

.location-total {
  color: #4a6a8a;
}

.assets-table-wrap {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}

.assets-table {
  border-collapse: collapse;
  font-size: 0.82rem;
  width: 100%;

  thead tr {
    border-bottom: 1px solid #1e2e42;
  }

  th {
    background: #0c1624;
    color: #4a6a8a;
    font-size: 0.74rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    padding: 0.3rem 0.6rem;
    position: sticky;
    text-align: left;
    text-transform: uppercase;
    top: 0;
    user-select: none;
    white-space: nowrap;
    z-index: 2;

    &[style*="cursor"] {
      &:hover {
        color: #7aaabf;
      }
    }

    &.num {
      text-align: right;
    }
  }

  td {
    border-bottom: 1px solid #0e1e30;
    color: #94a8c0;
    padding: 0.35rem 0.6rem;
    vertical-align: middle;

    &.num {
      text-align: right;
    }
  }

  tbody tr:hover td {
    background: #0f1f32;
    color: #c8d8e8;
  }

  tbody tr:hover td.name-cell {
    color: #c8d8e8;
  }

  tbody tr:hover td .muted {
    color: #3a5a7a;
  }
}

.filter-bar {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  padding: 0.25rem 0;
}

.next-update {
  color: #4a7a9f;
  font-size: 0.72rem;
  margin-left: auto;
}

.filter-check {
  align-items: center;
  color: #5a7a9a;
  cursor: pointer;
  display: flex;
  font-size: 0.8rem;
  gap: 0.4rem;
  user-select: none;

  input[type='checkbox'] {
    accent-color: #3a8aaa;
    cursor: pointer;
  }

  &:hover {
    color: #8ebadd;
  }
}

.mobile-sub {
  display: none;
}

.name-cell {
  max-width: 16rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;

  >span {
    cursor: pointer;

    &:hover {
      color: #e0f0ff;
      text-decoration: underline;
      text-underline-offset: 2px;
    }
  }
}

.btn-cell {
  padding: 0.2rem 0.4rem;
  text-align: center;
  white-space: nowrap;
  width: 1rem;
}

.ignore-btn {
  background: none;
  border: 1px solid #2a3a4a;
  border-radius: 0.2rem;
  color: #3a5a7a;
  cursor: pointer;
  flex-shrink: 0;
  font-size: 0.75rem;
  line-height: 1;
  padding: 0.1rem 0.3rem;

  &:hover {
    border-color: #cc4a4a;
    color: #cc4a4a;
  }
}

.ignored-row td {
  opacity: 0.4;
}

.date-cell {
  color: #4a6a8a;
  white-space: nowrap;
}

.muted {
  color: #2a4a6a;
}

.sub-pct {
  font-size: 0.72rem;
  margin-top: 0.1rem;
}

.pos {
  color: #4acc88;
}

.neg {
  color: #ff7c7c;
}

// ── Card layout on mobile ───────────────────────────────────────────────────
// td child order: 1=name, 2=qty, 3=buy, 4=cost, 5=value, 6=avg, 7=bestask, 8=instant, 9=date, 10=btn
@media (max-width: 639px) {
  .assets-table-wrap {
    overflow-x: visible;
  }

  .mobile-sub {
    display: flex;
    align-items: baseline;
    font-size: 0.72rem;
    margin-top: 0.15rem;
    color: #4a6a8a;

    .mobile-qty {
      color: #8aaac8;
      font-weight: 500;
    }

    .mobile-m3 {
      color: #4a6a8a;
    }

    .mobile-date {
      margin-left: auto;
      padding-right: 2.2rem;
      color: #5a7a9a;
      text-align: right;
    }
  }

  .assets-table {
    font-size: 0.84rem;

    thead {
      display: none;
    }

    tbody tr {
      background: #0d1b2b;
      border: 1px solid #1a2a3a;
      border-radius: 0.4rem;
      display: grid;
      grid-template-columns: 1fr 1fr;
      margin-bottom: 0.5rem;
      overflow: hidden;
      position: relative;

      &.ignored-row {
        opacity: 0.4;
      }
    }

    // ── Header ────────────────────────────────────────────────────────
    td.name-cell {
      grid-column: 1 / -1;
      grid-row: 1;
      background: #0b1522;
      border-bottom: 1px solid #1a2a3a;
      display: flex;
      flex-direction: column;
      max-width: none;
      padding: 0.55rem 2.6rem 0.5rem 0.8rem;
      white-space: normal;

      >span:first-child {
        font-size: 0.9rem;
        font-weight: 700;
        color: #ddeeff;
      }
    }

    td:nth-child(2),
    td.date-cell {
      display: none;
    }

    td.btn-cell {
      position: absolute;
      top: 0.45rem;
      right: 0.45rem;
      background: none;
      border: none;
      padding: 0;
      width: auto;
    }

    // ── Price pairs (3 rows × 2 cols) ─────────────────────────────────
    // Row 2: Buy | Cost
    td:nth-child(3) {
      grid-column: 1;
      grid-row: 2;
    }

    td:nth-child(4) {
      grid-column: 2;
      grid-row: 2;
    }

    // Row 3: Value | Avg
    td:nth-child(5) {
      grid-column: 1;
      grid-row: 3;
    }

    td:nth-child(6) {
      grid-column: 2;
      grid-row: 3;
    }

    // Row 4: Ask | Instant
    td:nth-child(7) {
      grid-column: 1;
      grid-row: 4;
    }

    td:nth-child(8) {
      grid-column: 2;
      grid-row: 4;
    }

    td:nth-child(3),
    td:nth-child(4),
    td:nth-child(5),
    td:nth-child(6),
    td:nth-child(7),
    td:nth-child(8) {
      display: flex;
      flex-direction: row; // inline: LABEL  value
      align-items: flex-start;
      gap: 0.45rem;
      padding: 0.42rem 0.8rem;
      overflow: hidden;

      // label prefix from data-label attribute
      &::before {
        color: #3a5a7a;
        content: attr(data-label);
        font-size: 0.65rem;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        flex-shrink: 0;
        margin-top: 0.12rem; // optically align with value text
        white-space: nowrap;
      }
    }

    // value + sub-pct stay stacked inside the flex-row
    td:nth-child(3),
    td:nth-child(4),
    td:nth-child(5),
    td:nth-child(6),
    td:nth-child(7),
    td:nth-child(8) {

      >span,
      >div {
        display: flex;
        flex-direction: column;
      }
    }

    // Row dividers (subtle)
    td:nth-child(5),
    td:nth-child(6) {
      border-top: 1px solid #131e2e;
    }

    td:nth-child(7),
    td:nth-child(8) {
      border-top: 1px solid #131e2e;
      padding-bottom: 0.5rem;
    }

    // First row top padding
    td:nth-child(3),
    td:nth-child(4) {
      padding-top: 0.5rem;
    }

    // Vertical divider between left and right columns
    td:nth-child(3),
    td:nth-child(5),
    td:nth-child(7) {
      border-right: 1px solid #131e2e;
    }

    .sub-pct {
      font-size: 0.72rem;
      margin-top: 0.05rem;
    }

    tbody tr:hover {
      background: #101e30;
    }

    tbody tr:hover td.name-cell {
      background: #0b1522;
    }
  }
}
</style>
