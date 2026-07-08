import { describe, expect, it } from "vitest";

import { RingBuffer } from "./ring-buffer.ts";

describe("RingBuffer", () => {
  it("keeps at most `capacity` items, evicting the oldest first", () => {
    const buf = new RingBuffer<number>(3);
    for (const n of [1, 2, 3, 4, 5]) buf.push(n);
    expect(buf.toArray()).toEqual([3, 4, 5]);
    expect(buf.size).toBe(3);
  });

  it("returns items oldest → newest below capacity", () => {
    const buf = new RingBuffer<string>(500);
    buf.push("a");
    buf.push("b");
    expect(buf.toArray()).toEqual(["a", "b"]);
  });

  it("rejects a non-positive capacity", () => {
    expect(() => new RingBuffer(0)).toThrow(/capacity/);
  });
});
