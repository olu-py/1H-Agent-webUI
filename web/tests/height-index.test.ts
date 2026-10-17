import { describe, expect, it } from "vitest";
import { HeightIndex } from "../src/lib/height-index";

describe("appendable document heights", () => {
  it("keeps nonbinary CSS estimates and measured resize values within subpixel precision", () => {
    const heights = Array.from({ length: 513 }, (_, n) => 18 + (n % 11 + 1) * 14 * 1.55);
    const index = new HeightIndex(heights);
    for (let n = 0; n < heights.length; n += 7) {
      heights[n] = 20.3 + (n % 9) * 17.7;
      index.set(n, heights[n]);
    }
    let sum = 0;
    for (let n = 0; n < heights.length; n += 1) {
      sum += heights[n];
      expect(index.prefix(n + 1)).toBeCloseTo(sum, 8);
      expect(index.lowerBound(sum - 0.000001)).toBe(n + 1);
      expect(index.lowerBound(sum + 0.000001)).toBe(Math.min(heights.length, n + 2));
    }
  });

  it("bulk installation preserves queries, measurements and later appends", () => {
    for (const length of [0, 1, 2, 3, 7, 8, 9, 255, 256, 257, 8193]) {
      const source = Array.from({ length }, (_, n) => 28 + (n % 17) * 0.25);
      const heights = source.slice();
      const index = new HeightIndex(source);
      if (length) {
        source[0] = 9999; // The caller's estimates are not a live height cache.
        const changed = Math.floor(length / 2);
        heights[changed] += 0.75;
        index.set(changed, heights[changed]);
      }
      for (const height of [0, 48.25, 61.5, 29]) {
        heights.push(height);
        index.append(height);
      }
      let sum = 0;
      expect(index.prefix(0)).toBe(0);
      for (let n = 0; n < heights.length; n += 1) {
        sum += heights[n];
        expect(index.prefix(n + 1)).toBe(sum);
        const target = sum + 0.125;
        let oracle = 0;
        let found = heights.length;
        for (let k = 0; k < heights.length; k += 1) {
          oracle += heights[k];
          if (oracle >= target) { found = k + 1; break; }
        }
        expect(index.lowerBound(target)).toBe(found);
      }
      expect(index.total).toBe(sum);
    }
  });

  it("matches a prefix oracle across power-of-two growth and earlier measurements", () => {
    const index = new HeightIndex();
    const heights: number[] = [];
    for (let n = 0; n < 257; n++) {
      heights.push(28 + n % 13);
      index.append(heights[n]);
      if (n % 7 === 0) {
        const changed = Math.floor(n / 3);
        heights[changed] += 0.75;
        index.set(changed, heights[changed]);
      }
      const offsets = [0];
      for (const height of heights) offsets.push(offsets.at(-1)! + height);
      expect(index.total).toBe(offsets.at(-1));
      for (let k = 0; k < offsets.length; k++) {
        expect(index.prefix(k)).toBe(offsets[k]);
        for (const target of [offsets[k] - 0.5, offsets[k], offsets[k] + 0.5]) {
          const found = offsets.findIndex(offset => offset >= target);
          expect(index.lowerBound(target)).toBe(found < 0 ? heights.length : found);
        }
      }
    }
  });

  it("retains exact fractional anchors after resize replaces every estimate", () => {
    const index = new HeightIndex();
    for (const height of [32, 48, 61, 29]) index.append(height);
    [48.25, 91.5, 112.75, 32].forEach((height, n) => index.set(n, height));
    expect(index.prefix(3) + 7.5).toBe(260);
    expect(index.lowerBound(260)).toBe(4);
    expect(new HeightIndex().lowerBound(1)).toBe(0);
  });
  it("retains earlier measurements when replacing a streamed suffix and regrowing", () => {
    const index = new HeightIndex([10, 20, 30, 40, 50, 60, 70, 80]);
    index.set(1, 22.5);
    index.truncate(3);
    for (const height of [14, 16, 18, 20, 22]) index.append(height);
    const oracle = [10, 22.5, 30, 14, 16, 18, 20, 22];
    expect(index.total).toBe(oracle.reduce((a, b) => a + b, 0));
    oracle.forEach((_, n) => expect(index.prefix(n + 1)).toBe(oracle.slice(0, n + 1).reduce((a, b) => a + b, 0)));
    index.truncate(0); index.append(12.25);
    expect(index.total).toBe(12.25);
  });

});
