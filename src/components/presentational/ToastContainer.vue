<script setup lang="ts">
import { toastService, type Toast } from '../../services/toastService';

const toasts = toastService.toasts;

const ICONS: Record<Toast['type'], string> = {
  error: '✕',
  warning: '⚠',
  info: 'ℹ',
  success: '✓',
};
</script>

<template lang="pug">
Teleport(to="body")
  .toast-container
    TransitionGroup(name="toast")
      .toast(
        v-for="t in toasts"
        :key="t.id"
        :class="t.type"
        @click="toastService.dismiss(t.id)"
      )
        span.toast-icon {{ ICONS[t.type] }}
        span.toast-msg {{ t.message }}
        span.toast-count(v-if="t.count > 1") ×{{ t.count }}
</template>

<style scoped lang="scss">
.toast-container {
  bottom: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  pointer-events: none;
  position: fixed;
  right: 1.5rem;
  z-index: 9999;
}

.toast {
  align-items: flex-start;
  border-radius: 0.5rem;
  border-left: 3px solid;
  cursor: pointer;
  display: flex;
  font-size: 0.85rem;
  gap: 0.55rem;
  max-width: 22rem;
  padding: 0.65rem 0.85rem;
  pointer-events: all;
  word-break: break-word;

  &.error {
    background: #1a0d0d;
    border-color: #ff4444;
    color: #ffaaaa;
  }

  &.warning {
    background: #1a1400;
    border-color: #ffbb00;
    color: #ffe066;
  }

  &.info {
    background: #0d1525;
    border-color: #4488ff;
    color: #99bbff;
  }

  &.success {
    background: #0a1a0f;
    border-color: #44cc77;
    color: #88ffaa;
  }
}

.toast-icon {
  flex-shrink: 0;
  font-weight: 700;
}

.toast-msg {
  flex: 1;
  line-height: 1.4;
}

.toast-count {
  align-self: center;
  flex-shrink: 0;
  font-size: 0.78rem;
  font-weight: 700;
  opacity: 0.75;
}

// TransitionGroup animations
.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.toast-enter-from {
  opacity: 0;
  transform: translateX(1.5rem);
}

.toast-leave-to {
  opacity: 0;
  transform: translateX(1.5rem);
}
</style>
