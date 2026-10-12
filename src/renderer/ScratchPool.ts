/** Engine-owned temporary passes. Logical sizes vary; allocated capacity only grows. */
export class ScratchPool {
  constructor(private readonly release: (work: () => void) => void = work => work()) {}
  private readonly resources = new Map<string, {dispose(): void; getMemoryBytes?(): number; reserveCapacity?(): void}>();
  get<T extends {dispose(): void; getMemoryBytes?(): number; reserveCapacity?(): void}>(key: string, create: () => T): T {
    let value = this.resources.get(key);
    if (!value) {value = create(); value.reserveCapacity?.(); this.resources.set(key, value);}
    return value as T;
  }
  getMemoryBytes() {return Array.from(this.resources.values()).reduce((sum, item) => sum + (item.getMemoryBytes?.() ?? 0), 0);}
  dispose() {const items = Array.from(this.resources.values()); this.resources.clear(); this.release(() => {for (const item of items) item.dispose();});}
}
