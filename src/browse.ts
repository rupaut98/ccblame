import { spawnSync } from "node:child_process";
import { money } from "./render.js";
import type { Invocation } from "./types.js";

const day = (ts: number): string => new Date(ts).toISOString().slice(0, 10);

function clip(s: string, n: number): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length > n ? `${clean.slice(0, n - 1)}…` : clean;
}

/** field 1 = sessionId (hidden, drives the preview); field 2 = the padded display row. */
export function browseLines(subs: Invocation[]): string {
  return subs
    .map((i) => {
      const row = `${day(i.startedAt)}  ${i.sessionId.slice(0, 8)}  ${clip(i.agentType, 24).padEnd(
        24,
      )}  ${clip(i.description, 36).padEnd(36)}  ${money(i.cost).padStart(8)}`;
      return `${i.sessionId}\t${row}`;
    })
    .join("\n");
}

/**
 * Interactive drill via fzf: one fuzzy-searchable list, preview shows the highlighted row's session
 * broken down by agent type; enter opens that session's full ranked table. Returns false if fzf
 * isn't on PATH so the caller can fall back to the static table.
 */
export function browse(subs: Invocation[]): boolean {
  if (subs.length === 0) {
    process.stdout.write("No subagent invocations found.\n");
    return true;
  }
  const ordered = [...subs].sort((a, b) => b.startedAt - a.startedAt); // recent first → days cluster
  const self = `"${process.execPath}" "${process.argv[1]}"`;
  // ponytail: the preview re-parses the whole dataset per row; fzf caches per line. Add a
  // --session fast-path to buildDataset if it ever drags.
  const r = spawnSync(
    "fzf",
    [
      "--delimiter=\t",
      "--with-nth=2",
      "--no-sort",
      "--header=day         session   agent                     task                                  cost   ·   enter: open session",
      "--preview",
      `${self} --session {1} --by type`,
      "--preview-window=down,60%,wrap",
    ],
    { input: browseLines(ordered), stdio: ["pipe", "pipe", "inherit"], encoding: "utf8" },
  );
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    process.stderr.write(
      "browse needs fzf on PATH (e.g. `brew install fzf`) — showing the table instead.\n",
    );
    return false;
  }
  const sid = (r.stdout ?? "").trim().split("\t")[0];
  if (sid) {
    spawnSync(process.execPath, [process.argv[1]!, "--session", sid], { stdio: "inherit" });
  }
  return true;
}
