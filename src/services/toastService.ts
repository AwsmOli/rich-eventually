import { ref } from "vue";

export type ToastType = "error" | "warning" | "info" | "success";

export interface Toast {
  id: number;
  message: string;
  type: ToastType;
  count: number;
}

let nextId = 0;

class ToastService {
  public readonly toasts = ref<Toast[]>([]);

  public push(
    message: string,
    type: ToastType = "error",
    durationMs = 6000,
  ): void {
    // If the most recent toast has the same message, just bump its counter.
    const last = this.toasts.value.at(-1);
    if (last && last.message === message && last.type === type) {
      last.count += 1;
      return;
    }

    const id = nextId++;
    this.toasts.value.push({ id, message, type, count: 1 });
    setTimeout(() => this.dismiss(id), durationMs);
  }

  public dismiss(id: number): void {
    const idx = this.toasts.value.findIndex((t) => t.id === id);
    if (idx !== -1) this.toasts.value.splice(idx, 1);
  }
}

export const toastService = new ToastService();
