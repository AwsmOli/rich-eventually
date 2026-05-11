<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';

import { eveAuthService } from '../../services/eveAuthService';
import { marketDataService } from '../../services/marketDataService';
import { ordersService, type CharacterOrder } from '../../services/ordersService';

const character = eveAuthService.character;
const openOrders = ordersService.openOrders;
const orderHistory = ordersService.orderHistory;
const isLoading = ordersService.isLoading;
const lastUpdatedAt = ordersService.lastUpdatedAt;
const esiExpiresAt = ordersService.esiExpiresAt;
const marketTick = marketDataService.marketTick;

const now = ref(Date.now());
const nowTimer = setInterval(() => { now.value = Date.now(); }, 10_000);
onUnmounted(() => clearInterval(nowTimer));

const nextUpdateIn = computed(() => {
  const exp = esiExpiresAt.value;
  if (!exp) return null;
  const secs = Math.max(0, Math.round((exp - now.value) / 1000));
  if (secs <= 0) return 'soon';
  if (secs < 60) return `${secs}s`;
  return `${Math.ceil(secs / 60)}m`;
});

// Start polling whenever this panel is visible and a character is logged in.
watch(character, (c) => {
  if (c) ordersService.startPolling();
  else ordersService.stopPolling();
}, { immediate: true });

// ── Derived ──────────────────────────────────────────────────────────────────

const openBuy = computed(() =>
  openOrders.value.filter((o) => o.isBuyOrder).sort((a, b) => b.price - a.price),
);
const openSell = computed(() =>
  openOrders.value.filter((o) => !o.isBuyOrder).sort((a, b) => a.price - b.price),
);

const historyFilled = computed(() =>
  orderHistory.value
    .filter((o) => o.state === 'closed')
    .sort((a, b) => new Date(b.issued).getTime() - new Date(a.issued).getTime()),
);

const RECENT_WINDOW_MS = 48 * 60 * 60 * 1000;

interface RecentTrade {
  typeId: number;
  typeName: string;
  isBuyOrder: boolean;
  price: number;
  totalVolume: number;
  totalProfit: number | undefined;
  closedAt: number;
}

const recentlyTraded = computed((): RecentTrade[] => {
  const cutoff = now.value - RECENT_WINDOW_MS;
  // Keys of sides that still have open orders — suppress those
  const openKeys = new Set(openOrders.value.map((o) => `${o.typeId}-${o.isBuyOrder}`));

  const groups = new Map<string, { orders: CharacterOrder[]; latestClose: number; }>();
  for (const o of orderHistory.value) {
    // Best proxy for "when this order closed" = issued + duration days
    const closedAt = new Date(o.issued).getTime() + (o.duration ?? 0) * 24 * 60 * 60 * 1000;
    if (closedAt < cutoff) continue;
    const key = `${o.typeId}-${o.isBuyOrder}`;
    if (openKeys.has(key)) continue; // still has an open order on this side
    if (!groups.has(key)) groups.set(key, { orders: [], latestClose: 0 });
    const g = groups.get(key)!;
    g.orders.push(o);
    if (closedAt > g.latestClose) g.latestClose = closedAt;
  }

  return Array.from(groups.values())
    .map(({ orders, latestClose }) => {
      // Pick the most recent order as the display representative
      const sample = orders.reduce((best, o) => {
        const t = new Date(o.issued).getTime() + (o.duration ?? 0) * 24 * 60 * 60 * 1000;
        const bt = new Date(best.issued).getTime() + (best.duration ?? 0) * 24 * 60 * 60 * 1000;
        return t > bt ? o : best;
      });
      const totalVolume = orders.reduce((s, o) => s + o.volumeTotal - o.volumeRemain, 0);
      const totalProfit = orders.reduce((s, o) => s + (o.estimatedProfit ?? 0), 0);
      return {
        typeId: sample.typeId,
        typeName: sample.typeName,
        isBuyOrder: sample.isBuyOrder,
        price: sample.price,
        totalVolume,
        totalProfit: totalProfit !== 0 ? totalProfit : undefined,
        closedAt: latestClose,
      };
    })
    .sort((a, b) => b.closedAt - a.closedAt);
});

const totalOpenValue = computed(() =>
  openOrders.value.reduce((s, o) => s + o.price * o.volumeRemain, 0),
);
const totalEstimatedProfit = computed(() =>
  historyFilled.value.reduce((s, o) => s + (o.estimatedProfit ?? 0), 0),
);

// ── Outbid detection ─────────────────────────────────────────────────────────
// Reactive to openOrders; reads in-memory market cache (populated by scan).
interface OutbidInfo { label: string; competitorPrice: number; }
const outbidMap = computed(() => {
  void marketTick.value; // reactive dependency — recompute when market data updates
  const map = new Map<number, OutbidInfo>();
  for (const o of openOrders.value) {
    if (!o.isBuyOrder) {
      const best = marketDataService.getLowestSellPrice(o.regionId, o.typeId, o.systemId);
      if (best !== undefined && best < o.price)
        map.set(o.orderId, { label: 'UNDERCUT', competitorPrice: best });
    } else {
      const best = marketDataService.getHighestBuyPrice(o.regionId, o.typeId, o.systemId);
      if (best !== undefined && best > o.price)
        map.set(o.orderId, { label: 'OUTBID', competitorPrice: best });
    }
  }
  return map;
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function isk(n: number): string {
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function pct(order: CharacterOrder): number {
  return order.volumeTotal > 0
    ? Math.round(((order.volumeTotal - order.volumeRemain) / order.volumeTotal) * 100)
    : 0;
}

function relativeTime(iso: string): string {
  return relativeTimeMs(new Date(iso).getTime());
}

function relativeTimeMs(ms: number): string {
  const diff = Date.now() - ms;
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

async function copyName(name: string): Promise<void> {
  await navigator.clipboard.writeText(name);
}

async function openMarket(typeId: number, event: MouseEvent): Promise<void> {
  if (!event.shiftKey || !character.value) return;
  const token = await eveAuthService.getAccessToken();
  if (!token) return;
  await fetch(
    `https://esi.evetech.net/latest/ui/openwindow/marketdetails/?datasource=tranquility&type_id=${typeId}`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
  );
}
</script>

<template lang="pug">
.orders-panel
  .panel-header
    span.panel-title Orders
    span.panel-meta(v-if="nextUpdateIn") next update {{ nextUpdateIn }}
    span.panel-meta.panel-meta--updated(v-else-if="lastUpdatedAt") updated {{ relativeTime(new Date(lastUpdatedAt).toISOString()) }}
    span.panel-loading(v-if="isLoading") ⟳

  .not-logged-in(v-if="!character")
    p Log in with EVE Online to view your orders.

  template(v-else)
    //- Summary row
    .summary-row
      .summary-item
        span.lbl Open orders
        span.val {{ openOrders.length }}
      .summary-item
        span.lbl Open value
        span.val {{ isk(totalOpenValue) }} ISK
      .summary-item(v-if="historyFilled.length > 0")
        span.lbl Est. profit (history)
        span.val(:class="totalEstimatedProfit >= 0 ? 'pos' : 'neg'") {{ totalEstimatedProfit >= 0 ? '+' : '' }}{{ isk(totalEstimatedProfit) }} ISK

    //- Open orders
    section.order-section(v-if="openOrders.length > 0")
      h3.section-title Open Orders
      .order-group(v-if="openSell.length > 0")
        .group-label Sell
        .order-row(v-for="o in openSell" :key="o.orderId" :class="{ outbid: outbidMap.has(o.orderId), 'recently-updated': outbidMap.has(o.orderId) && now - new Date(o.issued).getTime() < 300000 }" :style="{ '--fill-pct': pct(o) + '%' }")
          .order-top
            span.order-name(@click="copyName(o.typeName); openMarket(o.typeId, $event)" title="Click to copy · Shift+click to open in market") {{ o.typeName }}
            span.outbid-badge(v-if="outbidMap.has(o.orderId)") {{ outbidMap.get(o.orderId)?.label }}
          .order-bottom
            span.price(:class="{ 'price-beaten': outbidMap.has(o.orderId) }") {{ isk(o.price) }}
            template(v-if="outbidMap.has(o.orderId)")
              span.beat-arrow ←
              span.beat-price {{ isk(outbidMap.get(o.orderId)?.competitorPrice ?? 0) }}
            span.qty-fill
              | {{ (o.volumeTotal - o.volumeRemain).toLocaleString() }}/{{ o.volumeTotal.toLocaleString() }}
      .order-group(v-if="openBuy.length > 0")
        .group-label Buy
        .order-row(v-for="o in openBuy" :key="o.orderId" :class="{ outbid: outbidMap.has(o.orderId), 'recently-updated': outbidMap.has(o.orderId) && now - new Date(o.issued).getTime() < 300000 }" :style="{ '--fill-pct': pct(o) + '%' }")
          .order-top
            span.order-name(@click="copyName(o.typeName); openMarket(o.typeId, $event)" title="Click to copy · Shift+click to open in market") {{ o.typeName }}
            span.outbid-badge(v-if="outbidMap.has(o.orderId)") {{ outbidMap.get(o.orderId)?.label }}
          .order-bottom
            span.price(:class="{ 'price-beaten': outbidMap.has(o.orderId) }") {{ isk(o.price) }}
            template(v-if="outbidMap.has(o.orderId)")
              span.beat-arrow ←
              span.beat-price {{ isk(outbidMap.get(o.orderId)?.competitorPrice ?? 0) }}
            span.qty-fill
              | {{ (o.volumeTotal - o.volumeRemain).toLocaleString() }}/{{ o.volumeTotal.toLocaleString() }}

    //- Order history — filled
    section.order-section(v-if="historyFilled.length > 0")
      h3.section-title Filled Orders
      .order-row(v-for="o in historyFilled" :key="o.orderId")
        .order-name {{ o.typeName }}
        .order-detail
          span.side-badge(:class="o.isBuyOrder ? 'buy' : 'sell'") {{ o.isBuyOrder ? 'B' : 'S' }}
          span.price {{ isk(o.price) }}
          span.qty {{ o.volumeTotal.toLocaleString() }}
          span.time {{ relativeTime(o.issued) }}
          span.profit(v-if="o.estimatedProfit !== undefined" :class="o.estimatedProfit >= 0 ? 'pos' : 'neg'")
            | {{ o.estimatedProfit >= 0 ? '+' : '' }}{{ isk(o.estimatedProfit) }}

    //- Recently traded (last 48 h, no open order on the same side)
    section.order-section(v-if="recentlyTraded.length > 0")
      h3.section-title Recently Traded
      .recent-trade-row(v-for="t in recentlyTraded" :key="`${t.typeId}-${t.isBuyOrder}`")
        span.side-badge(:class="t.isBuyOrder ? 'buy' : 'sell'") {{ t.isBuyOrder ? 'B' : 'S' }}
        span.trade-name(@click="copyName(t.typeName); openMarket(t.typeId, $event)" title="Click to copy · Shift+click to open in market") {{ t.typeName }}
        span.time {{ relativeTimeMs(t.closedAt) }}

    .empty-state(v-if="openOrders.length === 0 && orderHistory.length === 0 && !isLoading")
      | No orders found.
</template>

<style scoped lang="scss">
.orders-panel {
  background: #0c1624;
  border-right: 1px solid #1e2e42;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  height: 100%;
  overflow-y: auto;
  padding: 0.85rem;
  width: 100%;
}

.panel-header {
  align-items: center;
  display: flex;
  gap: 0.6rem;
}

.panel-title {
  color: #c8d8e8;
  font-size: 0.95rem;
  font-weight: 700;
  letter-spacing: 0.03em;
}

.panel-meta {
  color: #4a6a8a;
  font-size: 0.75rem;
  margin-left: auto;
}

.panel-loading {
  animation: spin 1s linear infinite;
  color: #5a8fa8;
  font-size: 0.85rem;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.not-logged-in {
  color: #5a7a9a;
  font-size: 0.85rem;
  padding: 1rem 0;
  text-align: center;
}

.summary-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.summary-item {
  background: #0e1c2e;
  border: 1px solid #1e2e42;
  border-radius: 0.4rem;
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 6rem;
  padding: 0.4rem 0.6rem;
}

.lbl {
  color: #4a6a8a;
  font-size: 0.72rem;
  text-transform: uppercase;
}

.val {
  color: #c8d8e8;
  font-size: 0.88rem;
  font-weight: 600;
}

.order-section {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.section-title {
  border-bottom: 1px solid #1e2e42;
  color: #6a8aaa;
  cursor: default;
  font-size: 0.78rem;
  font-weight: 600;
  letter-spacing: 0.05em;
  margin: 0;
  padding-bottom: 0.25rem;
  text-transform: uppercase;

  // <details> summary resets
  &::marker {
    content: '';
  }

  list-style: none;
}

.section-hint {
  color: #3a5a7a;
  font-size: 0.73rem;
  font-style: italic;
  margin: 0.1rem 0 0.3rem;
}

details>summary.section-title {
  cursor: pointer;

  &:hover {
    color: #9ab4cc;
  }
}

.order-group {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  margin-bottom: 0.35rem;
}

.group-label {
  color: #4a6a8a;
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.order-row {
  background: #0e1c2e;
  border: 1px solid #1a2a3a;
  border-radius: 0.35rem;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  overflow: hidden;
  padding: 0.4rem 0.55rem;
  position: relative;

  &::after {
    background: linear-gradient(to right, #4a9a7a var(--fill-pct, 0%), transparent var(--fill-pct, 0%));
    bottom: 0;
    content: '';
    height: 2px;
    left: 0;
    position: absolute;
    width: 100%;
  }

  &.outbid {
    border-color: #5a2020;
    background: #130d0d;

    &::after {
      background: linear-gradient(to right, #7a3030 var(--fill-pct, 0%), transparent var(--fill-pct, 0%));
    }
  }

  &.outbid.recently-updated {
    background: #131006;
    border-color: #5a4a10;

    &::after {
      background: linear-gradient(to right, #7a6a20 var(--fill-pct, 0%), transparent var(--fill-pct, 0%));
    }

    .outbid-badge {
      background: #3a2a0a;
      color: #d4a020;
    }

    .beat-arrow,
    .beat-price {
      color: #d4a020;
    }

    .price.price-beaten {
      color: #5a4a1a;
    }
  }
}

.order-top {
  align-items: center;
  display: flex;
  gap: 0.45rem;
  min-width: 0;
}

.order-name {
  color: #c0d4e8;
  cursor: pointer;
  flex: 1;
  font-size: 0.82rem;
  font-weight: 500;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;

  &:hover {
    color: #e8f4ff;
    text-decoration: underline dotted;
  }
}

.order-bottom {
  align-items: center;
  display: flex;
  gap: 0.45rem;
}

.price {
  color: #8ebadd;
  flex-shrink: 0;
  font-size: 0.82rem;
  font-weight: 600;

  &.price-beaten {
    color: #7a6a6a;
    text-decoration: line-through;
  }
}

.beat-arrow {
  color: #e05050;
  flex-shrink: 0;
  font-size: 0.75rem;
}

.beat-price {
  color: #e05050;
  flex-shrink: 0;
  font-size: 0.82rem;
  font-weight: 700;
}

.qty-fill {
  color: #4a6a8a;
  flex-shrink: 0;
  font-size: 0.74rem;
  margin-left: auto;
}

.time {
  color: #3a5a7a;
  font-size: 0.74rem;
  margin-left: auto;
}

.outbid-badge {
  background: #3a0f0f;
  border-radius: 0.2rem;
  color: #e05050;
  flex-shrink: 0;
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  padding: 0.08rem 0.35rem;
  text-transform: uppercase;
}

.side-badge {
  border-radius: 0.2rem;
  font-size: 0.7rem;
  font-weight: 700;
  padding: 0.05rem 0.3rem;
  text-transform: uppercase;

  &.buy {
    background: #0d2a1a;
    color: #4acc88;
  }

  &.sell {
    background: #2a0d0d;
    color: #cc4a4a;
  }
}

.state-badge {
  color: #4a5a6a;
  font-size: 0.72rem;
}

.recent-trade-row {
  align-items: center;
  background: #0e1c2e;
  border: 1px solid #1a2a3a;
  border-radius: 0.35rem;
  display: flex;
  gap: 0.5rem;
  padding: 0.35rem 0.55rem;
}

.trade-name {
  color: #c0d4e8;
  cursor: pointer;
  flex: 1;
  font-size: 0.82rem;
  font-weight: 500;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;

  &:hover {
    color: #e8f4ff;
    text-decoration: underline dotted;
  }
}

.profit {
  font-size: 0.8rem;
  font-weight: 600;
  margin-left: auto;
}

.pos {
  color: #4acc88;
}

.neg {
  color: #cc4a4a;
}

.empty-state {
  color: #3a5a7a;
  font-size: 0.85rem;
  padding: 1.5rem 0;
  text-align: center;
}
</style>
