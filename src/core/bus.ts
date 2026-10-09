// A tiny event emitter: parts of the shell tell each other things happened without importing each other.
export class Bus<T> {
  private listeners = new Set<(value: T) => void>();

  on(listener: (value: T) => void, signal?: AbortSignal): () => void {
    this.listeners.add(listener);
    const off = () => this.listeners.delete(listener);
    signal?.addEventListener('abort', off, { once: true });
    return off;
  }

  emit(value: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(value);
      } catch (error) {
        // One broken listener must not stop the others being told.
        console.error(error);
      }
    }
  }
}
