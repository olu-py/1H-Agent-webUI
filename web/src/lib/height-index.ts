/** Appendable cumulative heights. Scroll queries and measured-height changes
 * touch O(log N) nodes rather than allocating a full prefix array per frame. */
export class HeightIndex {
  private values: number[] = [];
  private tree: number[] = [0];

  /** Build an installed document in O(N), without two prefix queries for each
   * block. Copy the values: subsequent measurements must not mutate the input. */
  constructor(initialHeights: readonly number[] = []) {
    this.values = initialHeights.slice();
    this.tree = [0, ...initialHeights];
    for (let node = 1; node <= this.length; node += 1) {
      const parent = node + (node & -node);
      if (parent <= this.length) this.tree[parent] += this.tree[node];
    }
  }

  get length(): number { return this.values.length; }
  get total(): number { return this.prefix(this.length); }

  append(height: number): void {
    const end = this.length + 1;
    const start = end - (end & -end);
    this.tree.push(this.prefix(end - 1) - this.prefix(start) + height);
    this.values.push(height);
  }

  truncate(length: number): void {
    if (length >= this.length) return;
    this.values.length = Math.max(0, length);
    this.tree.length = this.values.length + 1;
  }

  set(index: number, height: number): void {
    const delta = height - this.values[index];
    this.values[index] = height;
    for (let node = index + 1; node <= this.length; node += node & -node) {
      this.tree[node] += delta;
    }
  }

  prefix(end: number): number {
    let sum = 0;
    for (let node = Math.min(end, this.length); node > 0; node -= node & -node) sum += this.tree[node];
    return sum;
  }

  /** First prefix >= value, clamped to [0, length], like the window oracle. */
  lowerBound(value: number): number {
    if (value <= 0) return 0;
    let index = 0;
    let sum = 0;
    let step = 1;
    while (step * 2 <= this.length) step *= 2;
    for (; step > 0; step >>= 1) {
      const next = index + step;
      if (next <= this.length && sum + this.tree[next] < value) {
        index = next;
        sum += this.tree[next];
      }
    }
    return Math.min(this.length, index + 1);
  }
}
