<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue';

import { systemsService } from '../../services/systemsService';
import type { ArbitrageFilters, RouteSecurityPreference } from '../../types/domain';
import { formatNumberInput, parseEuropeanNumber } from '../../utils/formatting';
import { REGIONS, getRegionId } from '../../utils/regions';

const props = defineProps<{
  modelValue: ArbitrageFilters;
  isLoading: boolean;
}>();

const emit = defineEmits<{
  (event: 'update:modelValue', value: ArbitrageFilters): void;
  (event: 'submit'): void;
}>();

const fromSystemSuggestions = ref<Array<{ id: number; name: string; }>>([]);
const toSystemSuggestions = ref<Array<{ id: number; name: string; }>>([]);
const showFromSuggestions = ref(false);
const showToSuggestions = ref(false);
const cargoDisplayValue = ref(formatNumberInput(props.modelValue.maxCargoHold));
const investmentDisplayValue = ref(formatNumberInput(Math.round(props.modelValue.maxInvestment / 1_000_000)));
const minDailyIskDisplayValue = ref(formatNumberInput(props.modelValue.minAvgDailyTradeCount));

onMounted(async () => {
  // Preload systems for autocomplete
  await systemsService.getSystemsByName('');
});

function update<K extends keyof ArbitrageFilters>(key: K, value: ArbitrageFilters[K]): void {
  emit('update:modelValue', {
    ...props.modelValue,
    [key]: value,
  });
}

function updateNumber<K extends keyof ArbitrageFilters>(
  key: K,
  value: number,
): void {
  update(key, value as ArbitrageFilters[K]);
}

function updateText<K extends keyof ArbitrageFilters>(
  key: K,
  value: string,
): void {
  update(key, value as ArbitrageFilters[K]);
}

function updateRouteSecurity(value: string): void {
  update('routeSecurity', value as RouteSecurityPreference);
}

function updateRegion(regionName: string): void {
  const regionId = getRegionId(regionName);
  if (regionId !== undefined) {
    updateNumber('regionId', regionId);
  }
}

function submit(): void {
  emit('submit');
}

function getInputValue(event: Event): string {
  const target = event.target;

  if (target instanceof HTMLInputElement) {
    return target.value;
  }

  return '';
}

function getSelectValue(event: Event): string {
  const target = event.target;

  if (target instanceof HTMLSelectElement) {
    return target.value;
  }

  return '';
}

function getCheckboxValue(event: Event): boolean {
  const target = event.target;

  if (target instanceof HTMLInputElement) {
    return target.checked;
  }

  return false;
}

async function onFromSystemInput(value: string): Promise<void> {
  updateText('fromSystemName', value);
  if (value.length > 0) {
    fromSystemSuggestions.value = await systemsService.getSystemsByName(value);
    showFromSuggestions.value = true;
  } else {
    showFromSuggestions.value = false;
  }
}

async function onToSystemInput(value: string): Promise<void> {
  updateText('toSystemName', value);
  if (value.length > 0) {
    toSystemSuggestions.value = await systemsService.getSystemsByName(value);
    showToSuggestions.value = true;
  } else {
    showToSuggestions.value = false;
  }
}

function selectFromSystem(name: string): void {
  updateText('fromSystemName', name);
  showFromSuggestions.value = false;
}

function selectToSystem(name: string): void {
  updateText('toSystemName', name);
  showToSuggestions.value = false;
}

function onCargoInput(value: string): void {
  const numValue = parseEuropeanNumber(value);
  if (!isNaN(numValue)) {
    updateNumber('maxCargoHold', Math.max(1, numValue));
    cargoDisplayValue.value = formatNumberInput(Math.max(1, numValue));
  }
}

function onInvestmentInput(value: string): void {
  const numValue = parseEuropeanNumber(value);
  if (!isNaN(numValue)) {
    const millions = Math.max(1, numValue);
    updateNumber('maxInvestment', millions * 1_000_000);
    investmentDisplayValue.value = formatNumberInput(millions);
  }
}

function onMinDailyIskInput(value: string): void {
  const numValue = parseEuropeanNumber(value);
  if (!isNaN(numValue)) {
    updateNumber('minAvgDailyTradeCount', Math.max(0, numValue));
    minDailyIskDisplayValue.value = formatNumberInput(Math.max(0, numValue));
  }
}

</script>

<template lang="pug">
form.filters(@submit.prevent="submit")
  h2 Filter Opportunities
  .grid
    label.field
      span Region
      select(
        :value="REGIONS.find(r => r.id === modelValue.regionId)?.name ?? ''"
        @change="updateRegion(getSelectValue($event))"
        :disabled="modelValue.scanAllRegions"
      )
        option(disabled value="") Select a region...
        option(v-for="region in REGIONS" :key="region.id" :value="region.name") {{ region.name }}
    label.checkbox
      input(
        type="checkbox"
        :checked="modelValue.scanAllRegions"
        @change="update('scanAllRegions', getCheckboxValue($event))"
      )
      span Scan All Regions
    label.field
      span From System (Optional)
      .autocomplete-container
        input.autocomplete-input(
          type="text"
          placeholder="Jita"
          :value="modelValue.fromSystemName"
          @input="onFromSystemInput(getInputValue($event))"
          @focus="showFromSuggestions = true"
          @blur="nextTick(() => { showFromSuggestions = false })"
        )
        .autocomplete-suggestions(v-if="showFromSuggestions && fromSystemSuggestions.length > 0")
          div.suggestion(
            v-for="system in fromSystemSuggestions"
            :key="system.id"
            @mousedown.prevent="selectFromSystem(system.name)"
          ) {{ system.name }}
    label.field
      span To System (Optional)
      .autocomplete-container
        input.autocomplete-input(
          type="text"
          placeholder="Amarr"
          :value="modelValue.toSystemName"
          @input="onToSystemInput(getInputValue($event))"
          @focus="showToSuggestions = true"
          @blur="nextTick(() => { showToSuggestions = false })"
        )
        .autocomplete-suggestions(v-if="showToSuggestions && toSystemSuggestions.length > 0")
          div.suggestion(
            v-for="system in toSystemSuggestions"
            :key="system.id"
            @mousedown.prevent="selectToSystem(system.name)"
          ) {{ system.name }}
    label.field
      span Avoid Systems (comma separated)
      input(
        type="text"
        placeholder="Uedama, Niarja"
        :value="modelValue.avoidSystemsInput"
        @input="updateText('avoidSystemsInput', getInputValue($event))"
      )
    label.field
      span Max Cargo Hold (m³)
      input.formatted-number(
        type="text"
        min="1"
        :value="cargoDisplayValue"
        @input="onCargoInput(getInputValue($event))"
        placeholder="0"
      )
    label.field
      span Max Investment (M ISK)
      input.formatted-number(
        type="text"
        min="1"
        :value="investmentDisplayValue"
        @input="onInvestmentInput(getInputValue($event))"
        placeholder="0"
      )
    label.field
      span Min Avg Daily Trades (Jita 90d)
      input.formatted-number(
        type="text"
        min="0"
        :value="minDailyIskDisplayValue"
        @input="onMinDailyIskInput(getInputValue($event))"
        placeholder="0"
      )
    label.field
      span Max Jumps
      input(
        type="number"
        min="0"
        :value="modelValue.maxJumps"
        @input="updateNumber('maxJumps', Number(getInputValue($event)))"
      )
    label.field
      span Route Security
      select(
        :value="modelValue.routeSecurity"
        @change="updateRouteSecurity(getSelectValue($event))"
      )
        option(value="shortest") Shortest
        option(value="secure") Secure
        option(value="insecure") Insecure
    label.field
      span Accounting Level (0-5)
      input(
        type="number"
        min="0"
        max="5"
        :value="modelValue.accountingLevel"
        @input="updateNumber('accountingLevel', Number(getInputValue($event)))"
      )
    label.field
      span Broker Fee (%)
      input(
        type="number"
        min="0"
        max="10"
        step="0.01"
        :value="Number(modelValue.brokerFeePercent).toFixed(2)"
        @input="updateNumber('brokerFeePercent', Number(getInputValue($event)))"
      )
    label.field
      span Route Evaluations
      input(
        type="number"
        min="5"
        max="500"
        :value="modelValue.maxRoutesToEvaluate"
        @input="updateNumber('maxRoutesToEvaluate', Number(getInputValue($event)))"
      )
  button.submit(type="submit" :disabled="isLoading")
    | {{ isLoading ? 'Scanning market...' : 'Find Arbitrage' }}
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

.checkbox {
  align-items: center;
  color: #dce7ff;
  display: flex;
  font-size: 0.85rem;
  gap: 0.5rem;
  grid-column: span 1;
}

.checkbox input[type="checkbox"] {
  accent-color: #64d7ff;
  cursor: pointer;
  height: 1rem;
  width: 1rem;
}

.checkbox span {
  cursor: pointer;
}

input,
select {
  background-color: #09111d;
  border: 1px solid #33455f;
  border-radius: 0.45rem;
  color: #ecf4ff;
  font: inherit;
  padding: 0.48rem 0.58rem;

  &:disabled {
    opacity: 0.6;
  }
}

.autocomplete-container {
  position: relative;
}

.autocomplete-input {
  width: 100%;
}

.autocomplete-suggestions {
  background-color: #09111d;
  border: 1px solid #33455f;
  border-radius: 0.45rem;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  left: 0;
  max-height: 200px;
  overflow-y: auto;
  position: absolute;
  right: 0;
  top: 100%;
  z-index: 10;
}

.suggestion {
  color: #dce7ff;
  cursor: pointer;
  font-size: 0.85rem;
  padding: 0.5rem 0.58rem;
  white-space: nowrap;

  &:hover {
    background-color: #1a2942;
    color: #87ffca;
  }

  &:first-child {
    border-radius: 0.45rem 0.45rem 0 0;
  }

  &:last-child {
    border-radius: 0 0 0.45rem 0.45rem;
  }
}

.formatted-number {
  font-family: 'Monaco', 'Courier New', monospace;
  font-size: 0.9rem;
  letter-spacing: 0.02em;
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
