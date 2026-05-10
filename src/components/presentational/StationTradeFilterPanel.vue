<script setup lang="ts">
import type { StationTradeFilters } from '../../types/domain';
import { TRADE_HUBS } from '../../services/stationTradeService';

const props = defineProps<{
  modelValue: StationTradeFilters;
  isLoading: boolean;
}>();

const emit = defineEmits<{
  (event: 'update:modelValue', value: StationTradeFilters): void;
  (event: 'submit'): void;
}>();

function update<K extends keyof StationTradeFilters>(key: K, value: StationTradeFilters[K]): void {
  emit('update:modelValue', { ...props.modelValue, [key]: value });
}

function getInputValue(event: Event): string {
  const target = event.target;
  return target instanceof HTMLInputElement ? target.value : '';
}

function getSelectValue(event: Event): string {
  const target = event.target;
  return target instanceof HTMLSelectElement ? target.value : '';
}

function submit(): void {
  emit('submit');
}
</script>

<template lang="pug">
form.filters(@submit.prevent="submit")
  h2 Station Trading Filters
  .grid
    label.field
      span Trade Hub
      select(
        :value="modelValue.hubSystemId"
        @change="update('hubSystemId', Number(getSelectValue($event)))"
      )
        option(v-for="hub in TRADE_HUBS" :key="hub.systemId" :value="hub.systemId") {{ hub.name }}
    label.field
      span Min Margin (%)
      input(
        type="number"
        min="0"
        max="1000"
        step="0.1"
        :value="modelValue.minMarginPercent"
        @input="update('minMarginPercent', Number(getInputValue($event)))"
      )
    label.field
      span Accounting Level (0-5)
      input(
        type="number"
        min="0"
        max="5"
        :value="modelValue.accountingLevel"
        @input="update('accountingLevel', Number(getInputValue($event)))"
      )
    label.field
      span Broker Fee (%)
      input(
        type="number"
        min="0"
        max="10"
        step="0.01"
        :value="Number(modelValue.brokerFeePercent).toFixed(2)"
        @input="update('brokerFeePercent', Number(getInputValue($event)))"
      )
    label.field
      span Min Avg Daily Trades (90d)
      input(
        type="number"
        min="0"
        :value="modelValue.minAvgDailyTrades"
        @input="update('minAvgDailyTrades', Number(getInputValue($event)))"
      )
    label.field
      span Min Item Value (ISK)
      input(
        type="number"
        min="0"
        step="1000"
        placeholder="0 = no limit"
        :value="modelValue.minItemValue || ''"
        @input="update('minItemValue', Number(getInputValue($event)))"
      )
    label.field
      span Max Item Value (ISK)
      input(
        type="number"
        min="0"
        step="1000"
        placeholder="0 = no limit"
        :value="modelValue.maxItemValue || ''"
        @input="update('maxItemValue', Number(getInputValue($event)))"
      )
  button.submit(type="submit" :disabled="isLoading")
    | {{ isLoading ? 'Scanning...' : 'Find Station Trades' }}
</template>

<style scoped lang="scss">
.filters {
  background: linear-gradient(160deg, #1d2a3f, #101722 65%);
  border: 1px solid #2f415c;
  border-radius: 0.75rem;
  display: grid;
  gap: 1rem;
  padding: 1.25rem;
}

h2 {
  font-size: 1.1rem;
  letter-spacing: 0.01em;
  margin: 0;
}

.grid {
  display: grid;
  gap: 0.75rem;
  grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
}

.field {
  color: #dce7ff;
  display: grid;
  font-size: 0.85rem;
  gap: 0.35rem;
  position: relative;
}

input,
select {
  background-color: #09111d;
  border: 1px solid #33455f;
  border-radius: 0.45rem;
  color: #ecf4ff;
  font: inherit;
  padding: 0.48rem 0.58rem;
}

.submit {
  background: linear-gradient(120deg, #64d7ff, #87ffca);
  border: none;
  border-radius: 0.45rem;
  color: #071522;
  cursor: pointer;
  font-size: 0.95rem;
  font-weight: 700;
  justify-self: start;
  letter-spacing: 0.02em;
  padding: 0.55rem 0.95rem;

  &:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }
}
</style>
