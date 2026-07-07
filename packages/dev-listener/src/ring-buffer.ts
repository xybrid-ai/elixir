/** Fixed-capacity FIFO buffer: pushing past capacity evicts the oldest item. */
export class RingBuffer<T> {
  private items: T[] = [];

  constructor(readonly capacity: number = 500) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`RingBuffer: capacity must be a positive integer, got ${capacity}`);
    }
  }

  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.capacity) this.items.shift();
  }

  /** Oldest → newest. */
  toArray(): T[] {
    return [...this.items];
  }

  get size(): number {
    return this.items.length;
  }
}
