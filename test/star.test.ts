import { describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { maybeStar } from "../src/render.js";

function fakeTTY(isTTY: boolean) {
  const lines: string[] = [];
  return {
    isTTY,
    write: (s: string) => {
      lines.push(s);
      return true;
    },
    lines,
  } as unknown as NodeJS.WriteStream & { lines: string[] };
}

describe("maybeStar", () => {
  it("prints once then throttles, and stays silent when piped", () => {
    rmSync(join(homedir(), ".cache", "ccblame", "star"), { force: true });

    const first = fakeTTY(true);
    maybeStar(first);
    expect(first.lines.join("")).toContain("star ccblame");

    // second call within 3 days: marker is fresh → no output
    const second = fakeTTY(true);
    maybeStar(second);
    expect(second.lines).toHaveLength(0);

    // non-TTY (piped/redirected): never prints, regardless of marker
    const piped = fakeTTY(false);
    maybeStar(piped);
    expect(piped.lines).toHaveLength(0);
  });
});
