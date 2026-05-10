<script setup lang="ts">
import { computed } from 'vue';

interface Props {
  value: number;
  showSuffix?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  showSuffix: true,
});

// Split into main part (everything except last 6 digits) and small part
// Only apply the split for values >= 1 million (7+ digits)
const parts = computed(() => {
  const absValue = Math.abs(Math.round(props.value));
  const str = absValue.toString();

  if (str.length <= 6) {
    // For values under 1 million, don't split
    return {
      main: str,
      small: '',
      isSplit: false,
    };
  }

  const splitIndex = str.length - 6;
  return {
    main: str.slice(0, splitIndex),
    small: str.slice(splitIndex),
    isSplit: true,
  };
});

const mainFormatted = computed(() => {
  if (!parts.value.main) return '';
  return parts.value.main.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
});

const smallFormatted = computed(() => {
  const small = parts.value.small;
  if (!small) return '';
  // For split values, add comma: e.g., "123,456"
  return small.slice(0, -3) + ',' + small.slice(-3);
});

const isNegative = computed(() => props.value < 0);
</script>

<template lang="pug">
span.isk-value(:class="{ negative: isNegative }")
  template(v-if="parts.isSplit")
    span.isk-main {{ mainFormatted }},
    span.isk-small {{ smallFormatted }}
  template(v-else)
    span.isk-full {{ mainFormatted }}
  template(v-if="showSuffix")
    span.isk-suffix  ISK
</template>

<style scoped lang="scss">
.isk-value {
  font-variant-numeric: tabular-nums;

  &.negative {
    color: #d75656;
  }
}

.isk-main {
  font-size: 1em;
  font-weight: 500;
}

.isk-full {
  font-size: 1em;
  font-weight: 400;
}

.isk-small {
  font-size: 0.75em;
  opacity: 0.85;
}

.isk-suffix {
  margin-left: 0.2em;
  font-size: 0.85em;
  opacity: 0.7;
}
</style>
