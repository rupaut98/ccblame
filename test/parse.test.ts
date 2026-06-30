import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { dedup, parseUsageLines } from "../src/parse.js";
import { addUsage, emptyUsage } from "../src/types.js";

const fixture = fileURLToPath(new URL("./fixtures/agent-dup.jsonl", import.meta.url));

describe("parseUsageLines", () => {
  it("accepts only valid assistant usage lines (skips user / malformed / empty-id)", () => {
    // 3 duplicate msg_1 + 1 msg_2 = 4 accepted; user, empty-id, and malformed lines dropped.
    expect(parseUsageLines(fixture)).toHaveLength(4);
  });

  it("pulls split cache buckets and ids", () => {
    const first = parseUsageLines(fixture)[0]!;
    expect(first.msgId).toBe("msg_1");
    expect(first.usage.cache5m).toBe(100000);
    expect(first.usage.cacheRead).toBe(500000);
    expect(first.slug).toBe("slug-x");
  });
});

describe("dedup", () => {
  it("collapses replayed turns by (msgId, requestId)", () => {
    const lines = dedup(parseUsageLines(fixture));
    expect(lines).toHaveLength(2); // msg_1 (x3 -> 1) + msg_2
  });

  it("sums to the expected usage across the invocation", () => {
    const total = emptyUsage();
    for (const l of dedup(parseUsageLines(fixture))) addUsage(total, l.usage);
    expect(total).toEqual({
      input: 3000, // 1000 + 2000
      output: 2000,
      cache5m: 100000,
      cache1h: 0,
      cacheRead: 500000,
    });
  });
});
