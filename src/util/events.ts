/** Internal typed event subscriptions. A failing listener does not block others. */
export class Events<T extends object> {
  private listeners = new Map<keyof T, Set<(event: any) => void>>();
  on<K extends keyof T>(name: K, listener: (event: T[K]) => void): () => void {
    let listeners = this.listeners.get(name);
    if (!listeners) this.listeners.set(name, listeners = new Set());
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }
  emit<K extends keyof T>(name: K, event: T[K]): void {
    for (const listener of [...this.listeners.get(name) ?? []]) {
      try { listener(event); } catch (error) { console.error('Event listener failed.', error); }
    }
  }
  clear(): void { this.listeners.clear(); }
}
