<script setup lang="ts">
import { ref, toRaw, watch, onMounted } from 'vue';

import { arbitrageService } from '../../services/arbitrageService';
import { clipboardService } from '../../services/clipboardService';
import { eveAuthService } from '../../services/eveAuthService';
import { kvGet, kvSet } from '../../services/idbService';
import { marketScannerService } from '../../services/marketScannerService';
import { ordersService } from '../../services/ordersService';
import { stationTradeService } from '../../services/stationTradeService';
import { toastService } from '../../services/toastService';
import type { ArbitrageFilters, MarketOpportunity, StationTradeFilters, StationTradeOpportunity } from '../../types/domain';
import type { CharacterSkills } from '../../services/characterService';
import ArbitrageTable from '../presentational/ArbitrageTable.vue';
import AssetsTab from './AssetsTab.vue';
import CharacterPanel from './CharacterPanel.vue';
import FilterPanel from '../presentational/FilterPanel.vue';
import OrdersPanel from './OrdersPanel.vue';
import StationTradeFilterPanel from '../presentational/StationTradeFilterPanel.vue';
import StationTradeTable from '../presentational/StationTradeTable.vue';

type Tab = 'arbitrage' | 'station' | 'assets' | 'orders';

function tabFromHash(): Tab {
  const hash = window.location.hash.slice(1);
  if (hash === 'station') return 'station';
  if (hash === 'assets') return 'assets';
  if (hash === 'orders') return 'orders';
  return 'arbitrage';
}

const activeTab = ref<Tab>(tabFromHash());
const showOrdersPanel = ref(!!eveAuthService.character.value);

watch(activeTab, (tab) => {
  history.replaceState(null, '', `#${tab}`);
});

onMounted(() => {
  window.addEventListener('hashchange', () => {
    activeTab.value = tabFromHash();
  });
  // Handle OAuth callback redirect (EVE SSO returns ?code=...)
  void eveAuthService.handleCallback();

  // Load filters and opportunities from IDB.
  void kvGet<ArbitrageFilters>('arbitrage-filters').then((saved) => {
    if (saved) filters.value = { ...DEFAULT_FILTERS, ...saved };
  });
  void loadOpportunities().then((ops) => {
    opportunities.value = ops;
    selectedId.value = ops[0]?.id;
  });

  void kvGet<StationTradeFilters>('station-trade-filters').then((saved) => {
    if (saved) stationFilters.value = { ...DEFAULT_STATION_FILTERS, ...saved };
  });

  // Start orders polling if already authenticated.
  if (eveAuthService.character.value) ordersService.startPolling();

  // If market data was already restored from localStorage, run analyses immediately.
  if (lastOrdersFetchedAt.value !== undefined) {
    void findArbitrage();
    void findStationTrades();
  }
});

// ── Arbitrage tab ───────────────────────────────────────────────────────────

const DEFAULT_FILTERS: ArbitrageFilters = {
  regionId: 10000002,
  scanAllRegions: false,
  fromSystemName: '',
  toSystemName: '',
  avoidSystemsInput: '',
  maxCargoHold: 100000,
  maxInvestment: 10000000000,
  maxJumps: 50,
  routeSecurity: 'shortest',
  accountingLevel: 5,
  brokerFeePercent: 3,
  maxRoutesToEvaluate: 180,
  minAvgDailyTradeCount: 0,
};

function loadFilters(): ArbitrageFilters {
  // Filters are loaded async (IDB) after mount; this gives the reactive default.
  return { ...DEFAULT_FILTERS };
}

async function loadOpportunities(): Promise<MarketOpportunity[]> {
  try {
    return (await kvGet<MarketOpportunity[]>('arbitrage-opportunities')) ?? [];
  } catch { /* ignore */ }
  return [];
}

const filters = ref<ArbitrageFilters>(loadFilters());
const opportunities = ref<MarketOpportunity[]>([]);
const selectedId = ref<string | undefined>(undefined);
const warnings = ref<string[]>([]);
const isAnalyzing = ref(false);
const copyFeedback = ref('');
const lastAnalyzedAt = ref<number | undefined>(undefined);

// Background market data scanner — auto-started on import, runs independently.
const { isFetchingOrders, fetchProgress, lastOrdersFetchedAt, nextRefreshIn } = marketScannerService;
const { analyzeProgress } = arbitrageService;

watch(
  filters,
  (val) => { void kvSet('arbitrage-filters', toRaw(val)); },
  { deep: true },
);

// Auto re-analyze when the scanner completes a refresh.
// lastOrdersFetchedAt fires once per region (~16s apart for 18 regions) so we
// debounce — wait until 60s with no new region completions before running, so
// the analysis triggers once per full 5-min scan cycle instead of 18 times.
let reanalyzeTimer: ReturnType<typeof setTimeout> | undefined;
watch(lastOrdersFetchedAt, () => {
  if (reanalyzeTimer !== undefined) clearTimeout(reanalyzeTimer);
  reanalyzeTimer = setTimeout(() => {
    reanalyzeTimer = undefined;
    if (lastAnalyzedAt.value !== undefined && !isAnalyzing.value) {
      void findArbitrage();
    }
    if (!isStationAnalyzing.value) {
      void findStationTrades();
    }
  }, 60_000);
});

async function findArbitrage(): Promise<void> {
  isAnalyzing.value = true;
  warnings.value = [];

  try {
    const result = await arbitrageService.findOpportunities(filters.value);
    opportunities.value = result.opportunities;
    warnings.value = result.warnings;
    lastAnalyzedAt.value = result.fetchedAt;
    selectedId.value = result.opportunities[0]?.id;
    void kvSet('arbitrage-opportunities', result.opportunities.map((o) => toRaw(o)));
  } catch (error: unknown) {
    toastService.push(error instanceof Error ? error.message : 'Unexpected error during analysis.');
  } finally {
    isAnalyzing.value = false;
  }
}

// ── Station Trading tab ─────────────────────────────────────────────────────

const DEFAULT_STATION_FILTERS: StationTradeFilters = {
  hubSystemId: 30000142, // Jita
  minMarginPercent: 5,
  minProfitPerUnit: 0,
  brokerFeePercent: 3,
  accountingLevel: 5,
  minAvgDailyTrades: 10,
  minItemValue: 0,
  maxItemValue: 0,
};

function loadStationFilters(): StationTradeFilters {
  // Loaded async from IDB after mount.
  return { ...DEFAULT_STATION_FILTERS };
}

const stationFilters = ref<StationTradeFilters>(loadStationFilters());
const stationOpportunities = ref<StationTradeOpportunity[]>([]);
const isStationAnalyzing = ref(false);
const stationEverRan = ref(false);
const { progress: stationProgress } = stationTradeService;

watch(
  stationFilters,
  (val) => { void kvSet('station-trade-filters', toRaw(val)); },
  { deep: true },
);

async function findStationTrades(): Promise<void> {
  isStationAnalyzing.value = true;
  stationEverRan.value = true;
  try {
    stationOpportunities.value = await stationTradeService.findOpportunities(stationFilters.value);
  } catch (error: unknown) {
    toastService.push(error instanceof Error ? error.message : 'Unexpected error.');
  } finally {
    isStationAnalyzing.value = false;
  }
}

// ── Shared ──────────────────────────────────────────────────────────────────

function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function onSkillsLoaded(skills: CharacterSkills): void {
  // Auto-fill fee fields for both tabs from actual character skills.
  filters.value = { ...filters.value, accountingLevel: skills.accounting, brokerFeePercent: brokerFeeFromLevel(skills.brokerRelations) };
  stationFilters.value = { ...stationFilters.value, accountingLevel: skills.accounting, brokerFeePercent: brokerFeeFromLevel(skills.brokerRelations) };
  // Show orders panel automatically when a character logs in.
  showOrdersPanel.value = true;
  ordersService.startPolling();
}

/** Approximate broker fee % from Broker Relations skill level (base 3%, -0.3% per level). */
function brokerFeeFromLevel(level: number): number {
  return Math.max(0.1, 3 - level * 0.3);
}

async function copyText(text: string): Promise<void> {
  try {
    await clipboardService.copy(text);
    copyFeedback.value = `Copied: ${text}`;
    toastService.push(`Copied: ${text}`, 'success', 1500);
  } catch {
    toastService.push('Could not access clipboard.', 'warning');
  }
  setTimeout(() => { copyFeedback.value = ''; }, 1500);
}
</script>

<template lang="pug">
.dashboard
  .header
    h1 EvEntually Rich
    CharacterPanel(@skills-loaded="onSkillsLoaded")
  .tabs
    button.tab(:class="{ active: activeTab === 'arbitrage' }" @click="activeTab = 'arbitrage'") Hauling
    button.tab(:class="{ active: activeTab === 'station' }" @click="activeTab = 'station'") Station
    button.tab(:class="{ active: activeTab === 'assets' }" @click="activeTab = 'assets'") Assets
    button.tab.orders-tab-mobile(
      v-if="eveAuthService.character.value"
      :class="{ active: activeTab === 'orders' }"
      @click="activeTab = 'orders'"
    ) Orders
    button.tab.orders-toggle(
      v-if="eveAuthService.character.value"
      :class="{ active: showOrdersPanel }"
      @click="showOrdersPanel = !showOrdersPanel"
    ) {{ showOrdersPanel ? '◀ Orders' : '▶ Orders' }}
  .main-layout(:class="{ 'with-panel': showOrdersPanel }")
    .orders-sidebar(v-if="showOrdersPanel")
      OrdersPanel
    .main-content
      template(v-if="activeTab === 'orders'")
        OrdersPanel.orders-fullpage
      template(v-if="activeTab === 'arbitrage'")
        FilterPanel(v-model="filters" :is-loading="isAnalyzing" @submit="findArbitrage")
        .analyze-progress(v-if="isAnalyzing && analyzeProgress")
          .fetch-progress__header
            span.refresh-status {{ analyzeProgress.step }}
            span.refresh-status {{ analyzeProgress.current }} / {{ analyzeProgress.total }}
          .progress-track
            .progress-fill(:style="{ width: `${analyzeProgress.total > 0 ? (analyzeProgress.current / analyzeProgress.total) * 100 : 0}%` }")
        p.feedback(v-if="copyFeedback") {{ copyFeedback }}
        ul.warnings(v-if="warnings.length > 0")
          li(v-for="warning in warnings" :key="warning") {{ warning }}
        .status-bar
          p.timestamp(v-if="lastAnalyzedAt") Last analyzed: {{ new Date(lastAnalyzedAt).toLocaleTimeString() }}
          .fetch-progress(v-if="isFetchingOrders")
            .fetch-progress__header
              span.refresh-status Scanning market data...
              span.refresh-status {{ fetchProgress.current }} / {{ fetchProgress.total }} pages
            .progress-track
              .progress-fill(:style="{ width: `${fetchProgress.total > 0 ? (fetchProgress.current / fetchProgress.total) * 100 : 0}%` }")
            p.first-scan-hint(v-if="!lastOrdersFetchedAt") First scan takes a few minutes — subsequent refreshes are much faster once data is cached.
          template(v-else)
            p.timestamp(v-if="lastOrdersFetchedAt") Market data: {{ new Date(lastOrdersFetchedAt).toLocaleTimeString() }}
            p.refresh-status(v-if="nextRefreshIn !== undefined") Next refresh in {{ formatCountdown(nextRefreshIn) }}
            button.refresh-btn(type="button" @click="marketScannerService.forceRefresh()") ↻ Refresh now
        .content
          ArbitrageTable(
            :rows="opportunities"
            :selected-id="selectedId"
            :is-loading="isAnalyzing"
            @select="(id) => (selectedId = id)"
            @copy="copyText"
          )
      template(v-if="activeTab === 'station'")
        StationTradeFilterPanel(v-model="stationFilters" :is-loading="isStationAnalyzing" @submit="findStationTrades")
        .analyze-progress(v-if="isStationAnalyzing && stationProgress")
          .fetch-progress__header
            span.refresh-status {{ stationProgress.step }}
            span.refresh-status {{ stationProgress.current }} / {{ stationProgress.total }}
          .progress-track
            .progress-fill(:style="{ width: `${stationProgress.total > 0 ? (stationProgress.current / stationProgress.total) * 100 : 0}%` }")
        p.feedback(v-if="copyFeedback") {{ copyFeedback }}
        p.data-loading-hint(v-if="stationEverRan && stationOpportunities.length === 0 && isFetchingOrders && !isStationAnalyzing")
          | Market data is still loading — will re-run automatically when ready…
        .status-bar
          .fetch-progress(v-if="isFetchingOrders")
            .fetch-progress__header
              span.refresh-status Scanning market data...
              span.refresh-status {{ fetchProgress.current }} / {{ fetchProgress.total }} pages
            .progress-track
              .progress-fill(:style="{ width: `${fetchProgress.total > 0 ? (fetchProgress.current / fetchProgress.total) * 100 : 0}%` }")
            p.first-scan-hint(v-if="!lastOrdersFetchedAt") First scan takes a few minutes — subsequent refreshes are much faster once data is cached.
          template(v-else)
            p.timestamp(v-if="lastOrdersFetchedAt") Market data: {{ new Date(lastOrdersFetchedAt).toLocaleTimeString() }}
            p.refresh-status(v-if="nextRefreshIn !== undefined") Next refresh in {{ formatCountdown(nextRefreshIn) }}
            button.refresh-btn(type="button" @click="marketScannerService.forceRefresh()") ↻ Refresh now
        .content
          StationTradeTable(
            :rows="stationOpportunities"
            :is-loading="isStationAnalyzing"
            @copy="copyText"
          )
      template(v-if="activeTab === 'assets'")
        AssetsTab
</template>

<style scoped lang="scss">
.dashboard {
  display: grid;
  gap: 1rem;
}

.header {
  align-items: end;
  display: flex;
  flex-wrap: wrap;
  gap: 0.8rem;
  justify-content: space-between;
}

h1 {
  font-size: clamp(1.6rem, 4vw, 2.6rem);
  margin: 0;
}

.tabs {
  display: flex;
  gap: 0.25rem;
  border-bottom: 1px solid #2a3b52;
  padding-bottom: 0;
  overflow-x: auto;
  scrollbar-width: none;
  -webkit-overflow-scrolling: touch;

  // Mobile-only Orders tab is hidden on desktop
  .orders-tab-mobile {
    display: none;
  }

  // Desktop-only Orders toggle hidden on mobile
  .orders-toggle {
    display: flex;
  }

  @media (max-width: 639px) {
    .orders-tab-mobile {
      display: flex;
    }

    .orders-toggle {
      display: none;
    }
  }
}

.tab {
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  border-radius: 0.4rem 0.4rem 0 0;
  color: #7a94b2;
  cursor: pointer;
  font-size: 0.92rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  padding: 0.5rem 1.1rem;
  transition: color 0.15s, border-color 0.15s;
  white-space: nowrap;

  &:hover {
    color: #b8d4ff;
  }

  &.active {
    border-bottom-color: #64d7ff;
    color: #64d7ff;
  }

  @media (max-width: 639px) {
    font-size: 0.82rem;
    padding: 0.45rem 0.75rem;
  }

  &.orders-toggle {
    margin-left: auto;
    border-bottom-color: transparent;
    color: #5a7a9a;

    &.active {
      border-bottom-color: #4acc88;
      color: #4acc88;
    }
  }
}

.main-layout {
  display: grid;
  gap: 1rem;
  grid-template-columns: 1fr;

  &.with-panel {
    grid-template-columns: 18rem 1fr;
  }

  @media (max-width: 639px) {
    &.with-panel {
      grid-template-columns: 1fr;
    }

    .orders-sidebar {
      display: none;
    }
  }
}

.orders-fullpage {
  // Reset OrdersPanel's sidebar styles when shown as full-page tab
  border-right: none !important;
  height: auto !important;
  overflow-y: visible !important;
  border-radius: 0.6rem;
  border: 1px solid #1e2e42;
  display: none; // hidden on desktop — sidebar is used instead

  @media (max-width: 639px) {
    display: flex;
  }
}

.orders-sidebar {
  border-radius: 0.6rem;
  height: calc(100vh - 8rem);
  overflow: hidden;
  position: sticky;
  top: 1rem;

  @media (max-width: 639px) {
    display: none;
  }
}

.main-content {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  min-width: 0;
}

.content {
  align-items: start;
  display: grid;
  gap: 1rem;
}

.content> :first-child {
  border-radius: 0.75rem;
}

.feedback {
  background: rgba(12, 22, 36, 0.94);
  border: 1px solid #2f4f72;
  border-radius: 0.45rem;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  color: #8ed8ff;
  margin: 0;
  max-width: min(70vw, 34rem);
  overflow: hidden;
  padding: 0.45rem 0.6rem;
  pointer-events: none;
  position: fixed;
  right: 1rem;
  text-overflow: ellipsis;
  top: 1rem;
  white-space: nowrap;
  z-index: 50;
}

.error {
  color: #ff7c7c;
  margin: 0;
}

.data-loading-hint {
  color: #7a94b2;
  font-size: 0.85rem;
  font-style: italic;
  margin: 0;
}

.warnings {
  color: #ffd79a;
  margin: 0;
  padding-left: 1.15rem;
}

.status-bar {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  width: 100%;
}

.fetch-progress,
.analyze-progress {
  display: flex;
  flex-direction: column;
  flex: 1;
  gap: 0.3rem;
  min-width: 14rem;
  width: 100%;
}

.fetch-progress__header {
  display: flex;
  justify-content: space-between;
}

.progress-track {
  background: rgba(255, 255, 255, 0.08);
  border-radius: 2px;
  height: 3px;
  overflow: hidden;
}

.progress-fill {
  background: #5a8fa8;
  border-radius: 2px;
  height: 100%;
  transition: width 0.4s ease;
}

.timestamp {
  color: #94a8c0;
  font-size: 0.82rem;
  margin: 0;
}

.refresh-status {
  color: #5a8fa8;
  font-size: 0.82rem;
  margin: 0;
}

.first-scan-hint {
  color: #7a94b2;
  font-size: 0.8rem;
  font-style: italic;
  margin: 0.2rem 0 0;
}

.refresh-btn {
  background: none;
  border: 1px solid #2f4f72;
  border-radius: 0.35rem;
  color: #5a8fa8;
  cursor: pointer;
  font-size: 0.8rem;
  padding: 0.2rem 0.55rem;
  transition: border-color 0.15s, color 0.15s;

  &:hover {
    border-color: #5a8fa8;
    color: #8ed8ff;
  }
}
</style>
