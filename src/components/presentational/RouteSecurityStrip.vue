<script setup lang="ts">
import { ref } from 'vue';

import type { RouteSecuritySquare } from '../../types/domain';

defineProps<{
  squares: RouteSecuritySquare[];
}>();

const hoveredSquare = ref<RouteSecuritySquare | undefined>();

function onSquareEnter(square: RouteSecuritySquare): void {
  hoveredSquare.value = square;
}

function onSquareLeave(): void {
  hoveredSquare.value = undefined;
}
</script>

<template lang="pug">
.route-security-strip
  .squares
    .square(
      v-for="square in squares"
      :key="square.systemId"
      :style="{ backgroundColor: square.color }"
      @mouseenter="onSquareEnter(square)"
      @mouseleave="onSquareLeave"
    )
  .tooltip(v-if="hoveredSquare")
    | {{ hoveredSquare.systemName }}
    |  ({{ hoveredSquare.securityStatus.toFixed(1) }})
</template>

<style scoped lang="scss">
.route-security-strip {
  align-items: center;
  display: flex;
  gap: 0.35rem;
  position: relative;
}

.squares {
  align-items: center;
  display: flex;
  gap: 0.2rem;
}

.square {
  border-radius: 0.08rem;
  height: 0.7rem;
  width: 0.7rem;
}

.tooltip {
  background-color: rgba(7, 12, 19, 0.95);
  border: 1px solid #304560;
  border-radius: 0.3rem;
  color: #d9e7ff;
  font-size: 0.72rem;
  line-height: 1.2;
  padding: 0.2rem 0.35rem;
  position: absolute;
  top: -1.8rem;
  white-space: nowrap;
  z-index: 2;
}
</style>
