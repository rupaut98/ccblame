import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Pair {
  metaPath: string;
  jsonlPath: string;
  project: string; // encoded project dir name
  sessionId: string;
  agentId: string;
}

export interface MainSession {
  path: string;
  project: string;
  sessionId: string;
}

export interface Discovery {
  configDirs: string[];
  pairs: Pair[];
  mainSessions: MainSession[];
  manifests: string[]; // <session>/workflows/wf_*.json run manifests (sibling of subagents/)
  cleanupPeriodDays: number | null;
}

const expandTilde = (p: string): string => (p.startsWith("~") ? join(homedir(), p.slice(1)) : p);

const statOr = (p: string): ReturnType<typeof statSync> | null => {
  try {
    return statSync(p);
  } catch {
    return null;
  }
};

const isDir = (p: string): boolean => statOr(p)?.isDirectory() ?? false;
const isFile = (p: string): boolean => statOr(p)?.isFile() ?? false;

/** Read+parse a JSON file; null on missing/unreadable/malformed. */
export const readJsonOr = <T>(path: string): T | null => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
};

/** Mirror ccusage: CLAUDE_CONFIG_DIR overrides; else scan ~/.config/claude and ~/.claude. */
export function resolveConfigDirs(): string[] {
  const env = process.env.CLAUDE_CONFIG_DIR;
  if (env) {
    const dirs = env
      .split(",")
      .map((s) => expandTilde(s.trim()))
      .filter(Boolean)
      .filter((d) => existsSync(join(d, "projects")));
    if (dirs.length === 0) {
      throw new Error("CLAUDE_CONFIG_DIR is set but no path contains a projects/ directory.");
    }
    return dirs;
  }
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const candidates = [join(xdg, "claude"), join(homedir(), ".claude")];
  return [...new Set(candidates)].filter((d) => existsSync(join(d, "projects")));
}

export function readCleanupPeriodDays(configDirs: string[]): number | null {
  for (const d of configDirs) {
    const json = readJsonOr<{ cleanupPeriodDays?: unknown }>(join(d, "settings.json"));
    if (json && typeof json.cleanupPeriodDays === "number") return json.cleanupPeriodDays;
  }
  return null;
}

export function discover(): Discovery {
  const configDirs = resolveConfigDirs();
  const pairs: Pair[] = [];
  const mainSessions: MainSession[] = [];
  const manifests: string[] = [];

  for (const cfg of configDirs) {
    const projectsDir = join(cfg, "projects");
    if (!isDir(projectsDir)) continue;
    for (const project of readdirSync(projectsDir)) {
      const projDir = join(projectsDir, project);
      if (!isDir(projDir)) continue;
      for (const entry of readdirSync(projDir)) {
        const entryPath = join(projDir, entry);
        if (entry.endsWith(".jsonl") && isFile(entryPath)) {
          mainSessions.push({ path: entryPath, project, sessionId: entry.replace(/\.jsonl$/, "") });
          continue;
        }
        const subagentsDir = join(entryPath, "subagents");
        if (!isDir(subagentsDir)) continue;
        // Recurse: plain subagents sit at the top level, but workflow-spawned ones nest under
        // subagents/workflows/wf_<id>/. Both are real subagent invocations.
        collectPairs(subagentsDir, project, entry, pairs);
        // Run manifests sit alongside, in <session>/workflows/wf_*.json — they carry the per-agent
        // label/phase that the workflow subagent .meta.json stubs lack.
        const wfDir = join(entryPath, "workflows");
        if (isDir(wfDir)) {
          for (const f of readdirSync(wfDir)) {
            if (f.startsWith("wf_") && f.endsWith(".json")) manifests.push(join(wfDir, f));
          }
        }
      }
    }
  }

  return {
    configDirs,
    pairs,
    mainSessions,
    manifests,
    cleanupPeriodDays: readCleanupPeriodDays(configDirs),
  };
}

function collectPairs(dir: string, project: string, sessionId: string, pairs: Pair[]): void {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (isDir(p)) {
      collectPairs(p, project, sessionId, pairs);
      continue;
    }
    if (!f.startsWith("agent-") || !f.endsWith(".meta.json")) continue;
    const agentId = f.slice("agent-".length, -".meta.json".length);
    const jsonlPath = join(dir, `agent-${agentId}.jsonl`);
    if (!existsSync(jsonlPath)) continue;
    pairs.push({ metaPath: p, jsonlPath, project, sessionId, agentId });
  }
}
