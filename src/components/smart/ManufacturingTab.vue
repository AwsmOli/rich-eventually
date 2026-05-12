<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';

import { eveAuthService } from '../../services/eveAuthService';
import { manufacturingService, type ManufacturingJob } from '../../services/manufacturingService';
import { marketScannerService } from '../../services/marketScannerService';
import IskValue from '../presentational/IskValue.vue';

// ── Region ───────────────────────────────────────────────────────────────────

// Default to The Forge (Jita) — same region the market scanner uses.
const JITA_REGION_ID = 10000002;

const character = eveAuthService.character;
const { isLoading, blueprints, opportunities, jobs, progress, lastError, needsRelogin } = manufacturingService;
const { lastOrdersFetchedAt } = marketScannerService;

// ── Sort ─────────────────────────────────────────────────────────────────────

type SortField = 'marginVs90d' | 'marginVsSell' | 'netProfitVs90d' | 'materialCost' | 'iskPerHour';
const sortField = ref<SortField>('marginVs90d');
const sortDir = ref<'asc' | 'desc'>('desc');
// ── Volume filter ─────────────────────────────────────────────────

// Minimum avg daily traded volume (0 = no filter)
const minVolume = ref(0);
// ── Expand ────────────────────────────────────────────────────────────────────

const expanded = ref<Set<number>>(new Set());

function toggleExpand(bpTypeId: number): void {
  const next = new Set(expanded.value);
  if (next.has(bpTypeId)) next.delete(bpTypeId); else next.add(bpTypeId);
  expanded.value = next;
}

function handleRowClick(row: (typeof opportunities.value)[0], event: MouseEvent): void {
  if (event.shiftKey) {
    window.open(`https://everef.net/type/${row.productTypeId}`, '_blank', 'noopener');
    return;
  }
  toggleExpand(row.blueprintTypeId);
}

// ── Sorted opportunities ─────────────────────────────────────────────────────

const UNOWNED_CAP = 200;

const sortedOpportunities = computed(() => {
  const dir = sortDir.value === 'asc' ? 1 : -1;
  const cmp = (a: (typeof opportunities.value)[0], b: (typeof opportunities.value)[0]) => {
    const val = (o: (typeof opportunities.value)[0]): number => {
      if (sortField.value === 'iskPerHour') return profitPerHour(o) ?? -Infinity;
      if (sortField.value === 'marginVs90d' || sortField.value === 'marginVsSell') return conservativeMargin(o) ?? -Infinity;
      if (sortField.value === 'netProfitVs90d') return conservativeProfit(o) ?? -Infinity;
      return (o[sortField.value] as number | undefined) ?? -Infinity;
    };
    return (val(a) - val(b)) * dir;
  };
  const minVol = minVolume.value;
  const passesVolumeFilter = (o: (typeof opportunities.value)[0]) =>
    o.ownedBlueprint !== undefined || // always show owned
    minVol === 0 ||
    (o.product90dDailyVolume !== undefined && o.product90dDailyVolume >= minVol);
  const filtered = opportunities.value.filter(passesVolumeFilter);
  const owned = filtered.filter((o) => o.ownedBlueprint !== undefined).sort(cmp);
  const unowned = filtered.filter((o) => o.ownedBlueprint === undefined).sort(cmp).slice(0, UNOWNED_CAP);
  return [...owned, ...unowned];
});

// Auto-reload when the market scanner finishes a full refresh cycle.
watch(lastOrdersFetchedAt, () => {
  if (!isLoading.value) {
    void manufacturingService.scan(JITA_REGION_ID);
  }
});

// On mount: if market data is already loaded (restored from IDB), trigger a scan.
onMounted(() => {
  if (lastOrdersFetchedAt.value !== undefined && !isLoading.value && opportunities.value.length === 0) {
    void manufacturingService.scan(JITA_REGION_ID);
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDuration(seconds: number): string {
  if (seconds <= 0) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function timeUntil(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return 'done';
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function jobStatusLabel(job: ManufacturingJob): string {
  switch (job.status) {
    case 'active': return `${job.percentComplete}% · done in ${timeUntil(job.endDate)}`;
    case 'ready': return 'Ready to deliver';
    case 'delivered': return 'Delivered';
    case 'paused': return 'Paused';
    case 'cancelled': return 'Cancelled';
    default: return job.status;
  }
}

function marginClass(margin: number | undefined): string {
  if (margin === undefined) return 'neutral';
  if (margin >= 0.1) return 'positive';
  if (margin >= 0) return 'neutral';
  return 'negative';
}

/** Returns the more conservative (lower) profit — min of 90d and sell when both are available. */
function conservativeProfit(row: (typeof opportunities.value)[0]): number | undefined {
  const { netProfitVs90d, netProfitVsSell } = row;
  if (netProfitVs90d !== undefined && netProfitVsSell !== undefined)
    return Math.min(netProfitVs90d, netProfitVsSell);
  return netProfitVs90d ?? netProfitVsSell;
}

/** Returns the more conservative (lower) margin — min of 90d and sell when both are available. */
function conservativeMargin(row: (typeof opportunities.value)[0]): number | undefined {
  const { marginVs90d, marginVsSell } = row;
  if (marginVs90d !== undefined && marginVsSell !== undefined)
    return Math.min(marginVs90d, marginVsSell);
  return marginVs90d ?? marginVsSell;
}

function profitPerHour(row: (typeof opportunities.value)[0]): number | undefined {
  const profit = conservativeProfit(row);
  if (profit === undefined || row.baseTimeSec <= 0) return undefined;
  return profit / row.baseTimeSec * 3600;
}

function profitPerHourValue(row: (typeof opportunities.value)[0]): number { return profitPerHour(row) ?? 0; }
function profitPerHourCls(row: (typeof opportunities.value)[0]): string {
  const pph = profitPerHour(row);
  return marginClass(pph !== undefined ? pph / row.materialCost : undefined);
}

function onSortFieldChange(e: Event): void {
  sortField.value = (e.target as HTMLSelectElement).value as SortField;
  sortDir.value = 'desc';
}

function onSortDirChange(e: Event): void {
  sortDir.value = (e.target as HTMLSelectElement).value as 'asc' | 'desc';
}

function onMinVolumeChange(e: Event): void {
  minVolume.value = Number((e.target as HTMLSelectElement).value);
}
</script>

<template lang="pug">
.mfg-tab
  //- Header action bar — always visible
  .tab-header
    .tab-title Manufacturing
    .spinner(v-if="isLoading")
    span.progress-step-inline(v-if="isLoading && progress.step") {{ progress.step }}{{ progress.total > 0 ? ` (${progress.current}/${progress.total})` : '' }}
    .tab-meta(v-if="opportunities.length > 0 && !isLoading")
      span(v-if="blueprints.length > 0") {{ blueprints.length }} owned bp{{ blueprints.length !== 1 ? 's' : '' }} ·&nbsp;
      | {{ sortedOpportunities.length }} shown
    .scan-btns
      button.scan-btn(
        type="button"
        :disabled="isLoading || !lastOrdersFetchedAt"
        @click="manufacturingService.scan(JITA_REGION_ID)"
        :title="lastOrdersFetchedAt ? (character ? 'Scan market + your owned blueprints' : 'Scan market for profitable blueprints') : 'Waiting for market data…'"
      ) {{ isLoading ? 'Scanning…' : '⟳ Scan' }}

  //- Re-login required (missing scopes or blueprint/industry error)
  .relogin-notice(v-if="needsRelogin || (character && eveAuthService.scopesMissing.value)")
    p.relogin-msg New permissions are needed. Please re-login to grant all required scopes.
    button.relogin-btn(type="button" @click="eveAuthService.login()") Re-login with EVE Online

  //- Error feedback
  .mfg-error(v-else-if="lastError") {{ lastError }}

  //- Market data not ready yet
  .hint(v-if="!lastOrdersFetchedAt && !isLoading")
    | Market data is still loading — wait for the market scan to finish, then click a scan button.

  //- Active / recent jobs
  template(v-if="jobs.length > 0")
    .section-title Jobs
    .jobs-grid
      .job-card(
        v-for="job in jobs"
        :key="job.jobId"
        :class="{ 'job-card--ready': job.status === 'ready', 'job-card--done': job.status === 'delivered' }"
      )
        .job-top
          span.job-name {{ job.productName }}
          span.job-status(:class="`job-status--${job.status}`") {{ jobStatusLabel(job) }}
        .job-bar(v-if="job.status === 'active' || job.status === 'ready'")
          .job-bar-fill(:style="{ width: `${job.percentComplete}%` }")
        .job-bottom
          .job-meta runs × {{ job.runs }} · output × {{ job.outputQty }}
          .job-prices(v-if="job.expectedRevenue !== undefined")
            span sell
            IskValue.inline(:value="job.expectedRevenue")
            span(v-if="job.expectedProfit !== undefined")
              | ·
              span(:class="job.expectedProfit >= 0 ? 'positive' : 'negative'")
                | {{ job.expectedProfit >= 0 ? '+' : '' }}
                IskValue.inline(:value="job.expectedProfit")
                |  profit
            span.job-note(v-else) (no revenue data)
          .job-meta(v-else) no market data

  //- Opportunities table
  template(v-if="opportunities.length > 0 || (isLoading === false && blueprints.length > 0)")
    .section-title
      | Blueprint Opportunities
      .sort-controls
        label.sort-lbl Sort
        select.sort-sel(:value="sortField" @change="onSortFieldChange")
          option(value="marginVs90d") Margin vs 90d avg
          option(value="marginVsSell") Margin vs sell
          option(value="netProfitVs90d") Profit vs 90d avg
          option(value="iskPerHour") ISK / hour
          option(value="materialCost") Material cost
        select.sort-sel(:value="sortDir" @change="onSortDirChange")
          option(value="desc") ↓ High → Low
          option(value="asc") ↑ Low → High
        span.sort-sep |
        label.sort-lbl Min vol/day
        select.sort-sel(:value="minVolume" @change="onMinVolumeChange")
          option(value="0") Any
          option(value="5") 5
          option(value="10") 10
          option(value="25") 25
          option(value="50") 50
          option(value="100") 100
          option(value="250") 250

    .empty(v-if="!isLoading && opportunities.length === 0")
      | No manufacturing blueprints found. Make sure market data is loaded and your blueprints are accessible.

    .opp-table-wrap(v-else)
      table.opp-tbl
        thead
          tr
            th.th-name Product / Blueprint
            th Materials
            th Run time
            th.th-vol Vol/day
            th.th-prices Revenue / 90d avg
            th.th-profit Profit / Margin

        tbody
          template(v-for="row in sortedOpportunities" :key="row.blueprintTypeId")
            tr.opp-row(
              :class="{ 'opp-row--owned': row.ownedBlueprint !== undefined, 'opp-row--expanded': expanded.has(row.blueprintTypeId), 'opp-row--skills-missing': row.skillsMet === false }"
              @click="handleRowClick(row, $event)"
              role="button"
              title="Click to expand · Shift+click to open in browser"
            )
              td.td-name
                .name-cell
                  span.product-name {{ row.productName }}
                  span.qty-badge(v-if="row.producesQty > 1") × {{ row.producesQty }}
                .bp-cell
                  span.bp-name {{ row.blueprintName }}
                  .bp-badges
                    span.badge.badge--owned(v-if="row.ownedBlueprint") own
                    span.badge.badge--bpo(v-if="row.ownedBlueprint?.isOriginal") BPO
                    span.badge.badge--bpc(v-if="row.ownedBlueprint && !row.ownedBlueprint.isOriginal") BPC
                    span.badge.badge--me(v-if="row.ownedBlueprint") ME{{ row.ownedBlueprint.materialEfficiency }}
                    span.badge.badge--skills-ok(v-if="row.skillsMet === true && row.requiredSkills.length > 0") skills ✓
                    span.badge.badge--skills-no(v-if="row.skillsMet === false") skills ✗
              td
                IskValue(:value="row.materialCost")
              td
                .run-time-cell
                  span {{ formatDuration(row.baseTimeSec) }}
                  template(v-if="profitPerHour(row) !== undefined")
                    span.profit-per-hour(:class="profitPerHourCls(row)")
                      | {{ profitPerHourValue(row) >= 0 ? '+' : '' }}
                      IskValue.inline(:value="profitPerHourValue(row)")
                      | /h
              td.td-vol
                template(v-if="row.product90dDailyVolume !== undefined")
                  | {{ Math.round(row.product90dDailyVolume).toLocaleString() }}
                template(v-else) —
              td.td-prices
                .price-pair
                  .price-line
                    span.sub-lbl sell&nbsp;
                    template(v-if="row.productSellPrice !== undefined")
                      IskValue(:value="row.productSellPrice")
                    template(v-else) —
                  .price-line
                    span.sub-lbl 90d&nbsp;
                    template(v-if="row.product90dAvg !== undefined")
                      IskValue(:value="row.product90dAvg")
                    template(v-else) —
              td.td-profit
                .price-pair
                  .price-line
                    span(:class="marginClass(conservativeMargin(row))")
                      template(v-if="conservativeProfit(row) !== undefined")
                        | {{ (conservativeProfit(row) || 0) >= 0 ? '+' : '' }}
                        IskValue.inline(:value="conservativeProfit(row) || 0")
                      template(v-else) —
                  .price-line
                    span(:class="marginClass(conservativeMargin(row))")
                      template(v-if="conservativeMargin(row) !== undefined")
                        | {{ ((conservativeMargin(row) || 0) * 100).toFixed(1) }}%
                      template(v-else) —

            //- Expanded material breakdown
            tr.mat-row(v-if="expanded.has(row.blueprintTypeId)")
              td(colspan="6")
                .mat-breakdown
                  .mat-header
                    span.mat-col-name Material
                    span.mat-col-qty Base qty
                    span.mat-col-qty ME adj
                    span.mat-col-price Unit cost
                    span.mat-col-price Total
                  .mat-line(v-for="mat in row.materials" :key="mat.typeId")
                    span.mat-col-name {{ mat.typeName }}
                    span.mat-col-qty {{ mat.baseQty.toLocaleString() }}
                    span.mat-col-qty(
                      :class="mat.adjustedQty < mat.baseQty ? 'positive' : ''"
                    ) {{ mat.adjustedQty.toLocaleString() }}
                    span.mat-col-price
                      IskValue(:value="mat.unitCost")
                    span.mat-col-price
                      IskValue(:value="mat.totalCost")
                  .mat-total
                    span Total material cost
                    IskValue(:value="row.materialCost")
                  template(v-if="!row.ownedBlueprint && row.blueprintSellPrice !== undefined")
                    .mat-total.bp-cost-row
                      span Blueprint cost (est.)
                      IskValue(:value="row.blueprintSellPrice")
                  template(v-if="row.requiredSkills.length > 0")
                    .mat-header.skills-header
                      span.mat-col-name Required Skills
                      span.mat-col-qty Level
                      span.mat-col-qty Yours
                    .mat-line(v-for="sk in row.requiredSkills" :key="sk.typeId")
                      span.mat-col-name {{ sk.name }}
                      span.mat-col-qty {{ sk.level }}
                      span.mat-col-qty(
                        v-if="sk.characterLevel !== undefined"
                        :class="{ positive: sk.characterLevel >= sk.level, negative: sk.characterLevel < sk.level }"
                      ) {{ sk.characterLevel }}
                      span.mat-col-qty(v-else) —
</template>

<style scoped lang="scss">
.mfg-tab {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.not-logged-in {
  color: #7a94b2;
  padding: 2rem 0;
  text-align: center;
}

// ── Header ────────────────────────────────────────────────────────────────────

.tab-header {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
}

.tab-title {
  color: #ecf4ff;
  font-size: 1.1rem;
  font-weight: 700;
}

.tab-meta {
  color: #5e7a99;
  font-size: 0.82rem;
  margin-right: auto;
}

.scan-btns {
  display: flex;
  gap: 0.5rem;
  margin-left: auto;
}

.scan-btn {
  background: rgba(100, 215, 255, 0.08);
  border: 1px solid rgba(100, 215, 255, 0.25);
  border-radius: 0.4rem;
  color: #64d7ff;
  cursor: pointer;
  font-size: 0.85rem;
  font-weight: 600;
  padding: 0.35rem 0.85rem;
  transition: background 0.15s;

  &:hover:not(:disabled) {
    background: rgba(100, 215, 255, 0.16);
  }

  &:disabled {
    color: #3a5a7a;
    cursor: default;
    border-color: rgba(100, 215, 255, 0.08);
  }

  &--market {
    background: rgba(100, 255, 180, 0.06);
    border-color: rgba(100, 255, 180, 0.22);
    color: #64ffa0;

    &:hover:not(:disabled) { background: rgba(100, 255, 180, 0.13); }
    &:disabled { color: #2a6a4a; border-color: rgba(100, 255, 180, 0.08); }
  }
}

// ── Progress ──────────────────────────────────────────────────────────────────

.spinner {
  animation: spin 0.8s linear infinite;
  border: 2px solid rgba(100, 215, 255, 0.15);
  border-radius: 50%;
  border-top-color: #64d7ff;
  flex-shrink: 0;
  height: 1rem;
  width: 1rem;
}

.progress-step-inline {
  color: #5e7a99;
  font-size: 0.78rem;
  margin-right: auto;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.relogin-notice {
  align-items: flex-start;
  background: rgba(255, 200, 80, 0.07);
  border: 1px solid rgba(255, 200, 80, 0.25);
  border-radius: 0.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  padding: 0.85rem 1rem;

  .relogin-msg {
    color: #ffd79a;
    font-size: 0.875rem;
    margin: 0;
  }

  .relogin-btn {
    background: #2a4a6a;
    border: 1px solid #3a6a9a;
    border-radius: 0.4rem;
    color: #8ed8ff;
    cursor: pointer;
    font-size: 0.8rem;
    padding: 0.35rem 0.75rem;

    &:hover { background: #345a7a; }
  }
}

.mfg-error {
  background: rgba(255, 80, 80, 0.07);
  border: 1px solid rgba(255, 80, 80, 0.25);
  border-radius: 0.5rem;
  color: #ff9a9a;
  font-size: 0.8rem;
  padding: 0.6rem 0.85rem;
}

.hint {
  color: #5e7a99;
  font-size: 0.85rem;
}

// ── Section title ─────────────────────────────────────────────────────────────

.section-title {
  align-items: center;
  border-bottom: 1px solid #1e2e42;
  color: #5e7a99;
  display: flex;
  font-size: 0.72rem;
  font-weight: 600;
  gap: 0.75rem;
  letter-spacing: 0.06em;
  padding-bottom: 0.4rem;
  text-transform: uppercase;
}

.sort-controls {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin-left: auto;
}

.sort-sep {
  color: #2a3b52;
  margin: 0 0.1rem;
  user-select: none;
}

.sort-lbl {
  color: #5e7a99;
  font-size: 0.78rem;
  text-transform: none;
  letter-spacing: 0;
}

.sort-sel {
  background: #09111d;
  border: 1px solid #2a3b52;
  border-radius: 0.35rem;
  color: #b8c7da;
  font-size: 0.78rem;
  padding: 0.2rem 0.4rem;
}

// ── Jobs ──────────────────────────────────────────────────────────────────────

.jobs-grid {
  display: grid;
  gap: 0.5rem;
  grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr));
}

.job-card {
  background: #0b1626;
  border: 1px solid #1a2b3e;
  border-radius: 0.55rem;
  padding: 0.65rem 0.85rem;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;

  &--ready {
    border-color: rgba(100, 220, 130, 0.45);
    background: rgba(100, 220, 130, 0.04);
  }

  &--done {
    opacity: 0.55;
  }
}

.job-top {
  align-items: baseline;
  display: flex;
  gap: 0.5rem;
  justify-content: space-between;
}

.job-name {
  color: #b8d4ff;
  font-size: 0.85rem;
  font-weight: 600;
}

.job-status {
  font-size: 0.72rem;
  font-weight: 600;

  &--active { color: #64d7ff; }
  &--ready  { color: #64dc82; }
  &--delivered { color: #5e7a99; }
  &--paused { color: #f0a030; }
  &--cancelled { color: #ff5a5a; }
  &--reverted { color: #ff5a5a; }
}

.job-bar {
  background: #0a1422;
  border-radius: 0.2rem;
  height: 3px;
  overflow: hidden;
}

.job-bar-fill {
  background: #64d7ff;
  height: 100%;
  transition: width 0.4s ease;
}

.job-bottom {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}

.job-meta {
  color: #4a6680;
  font-size: 0.72rem;
}

.job-prices {
  align-items: center;
  color: #7a94b2;
  display: flex;
  font-size: 0.75rem;
  gap: 0.35rem;
}

.job-note {
  color: #3a5a7a;
  font-size: 0.72rem;
  font-style: italic;
}

// ── Opportunities table ───────────────────────────────────────────────────────

.empty {
  color: #5e7a99;
  font-size: 0.85rem;
  padding: 1rem 0;
}

.opp-table-wrap {
  overflow-x: auto;
}

.opp-tbl {
  border-collapse: collapse;
  font-size: 0.85rem;
  width: 100%;

  th {
    border-bottom: 1px solid #1e2e42;
    color: #3d5a7a;
    font-size: 0.7rem;
    font-weight: 600;
    letter-spacing: 0.05em;
    padding: 0.4rem 0.65rem;
    text-align: right;
    text-transform: uppercase;
    white-space: nowrap;

    &.th-name { text-align: left; }
    &.th-prices { text-align: right; }
    &.th-profit { text-align: right; }
    &.th-vol { text-align: right; min-width: 4.5rem; }
  }

  td {
    border-bottom: 1px solid #111d2b;
    color: #c8d8ec;
    font-weight: 600;
    padding: 0.45rem 0.65rem;
    text-align: right;
    white-space: nowrap;

    &.td-name { text-align: left; }
    &.td-prices { text-align: right; }
    &.td-profit { text-align: right; }
    &.td-vol { text-align: right; color: #7a9ab8; font-size: 0.82rem; }
  }
}

.run-time-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  white-space: nowrap;
}

.profit-per-hour {
  font-size: 0.78rem;
  opacity: 0.85;
}

.opp-row {
  cursor: pointer;
  transition: background 0.1s;

  &:hover td {
    background: rgba(255, 255, 255, 0.025);
  }

  &--owned td.td-name {
    border-left: 3px solid rgba(100, 220, 130, 0.6);
  }

  &--expanded td {
    background: rgba(100, 215, 255, 0.03);
  }
}

.mat-row td {
  background: rgba(0, 0, 0, 0.2);
  padding: 0 !important;
}

.name-cell {
  align-items: center;
  display: flex;
  gap: 0.4rem;
}

.product-name {
  color: #b8d4ff;
  font-weight: 600;
}

.qty-badge {
  background: rgba(100, 215, 255, 0.1);
  border-radius: 0.25rem;
  color: #64d7ff;
  font-size: 0.7rem;
  padding: 0.05rem 0.3rem;
}

.bp-cell {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.bp-name {
  color: #7a94b2;
  font-size: 0.78rem;
  font-weight: 400;
}

.bp-badges {
  display: flex;
  gap: 0.25rem;
}

.badge {
  border-radius: 0.2rem;
  font-size: 0.62rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  padding: 0.07rem 0.28rem;
  text-transform: uppercase;

  &--owned {
    background: rgba(100, 220, 130, 0.15);
    color: #64dc82;
  }

  &--bpo {
    background: rgba(100, 215, 255, 0.12);
    color: #64d7ff;
  }

  &--bpc {
    background: rgba(160, 130, 255, 0.12);
    color: #a882ff;
  }

  &--me {
    background: rgba(255, 190, 60, 0.12);
    color: #ffbe3c;
  }

  &--skills-ok {
    background: rgba(100, 220, 130, 0.12);
    color: #64dc82;
  }

  &--skills-no {
    background: rgba(255, 80, 80, 0.12);
    color: #ff5050;
  }
}

.price-pair {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  text-align: right;
}

.price-line {
  align-items: center;
  display: flex;
  gap: 0.2rem;
  justify-content: flex-end;
}

.sub-lbl {
  color: #3d5a7a;
  font-size: 0.7rem;
  font-weight: 400;
}

.positive { color: #64dc82; }
.neutral  { color: #b8c7da; }
.negative { color: #ff5a5a; }
.inline   { display: inline; }

// ── Material breakdown ────────────────────────────────────────────────────────

.mat-breakdown {
  border-top: 1px solid #0e1c2c;
  font-size: 0.8rem;
  padding: 0.5rem 0.65rem 0.65rem;
}

.mat-header,
.mat-line {
  align-items: center;
  column-gap: 0.5rem;
  display: grid;
  grid-template-columns: 2fr 1fr 1fr 1.5fr 1.5fr;
  padding: 0.2rem 0;
}

.mat-header {
  border-bottom: 1px solid #0e1c2c;
  color: #3d5a7a;
  font-size: 0.68rem;
  font-weight: 600;
  letter-spacing: 0.05em;
  margin-bottom: 0.25rem;
  padding-bottom: 0.25rem;
  text-transform: uppercase;
}

.mat-col-name { color: #7a94b2; }
.mat-col-qty  { color: #b8c7da; text-align: right; }
.mat-col-price { text-align: right; }

.mat-total {
  border-top: 1px solid #0e1c2c;
  color: #ecf4ff;
  display: flex;
  font-weight: 700;
  justify-content: space-between;
  margin-top: 0.4rem;
  padding-top: 0.4rem;
  font-size: 0.82rem;

  &.bp-cost-row {
    color: #7a94b2;
    font-weight: 500;
    font-size: 0.78rem;
  }
}

.skills-header {
  border-top: 1px solid #0e1c2c;
  grid-template-columns: 2fr 1fr 1fr;
  margin-top: 0.6rem;
  padding-top: 0.25rem;
}

.skills-header ~ .mat-line {
  grid-template-columns: 2fr 1fr 1fr;
}

.opp-row--skills-missing td {
  opacity: 0.7;
}
</style>
