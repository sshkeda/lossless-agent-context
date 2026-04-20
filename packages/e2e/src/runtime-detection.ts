import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type RealLogPaths = {
  pi?: string;
  claude?: string;
  codex?: string;
};

type RealLogPathLists = {
  pi: string[];
  claude: string[];
  codex: string[];
};

function readDirLatestJsonl(dir: string): string | undefined {
  try {
    const jsonlPaths = collectJsonlFiles(dir).sort();
    return jsonlPaths.at(-1);
  } catch {
    return undefined;
  }
}

function readDirRecentJsonl(dir: string, limit: number): string[] {
  try {
    const jsonlPaths = collectJsonlFiles(dir).sort();
    return jsonlPaths.slice(Math.max(0, jsonlPaths.length - limit));
  } catch {
    return [];
  }
}

function collectJsonlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];

  const out: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectJsonlFiles(fullPath));
      continue;
    }
    if (entry.isFile() && fullPath.endsWith(".jsonl")) {
      out.push(fullPath);
      continue;
    }

    // Some providers may store logs behind symlinks.
    if (entry.isSymbolicLink()) {
      const stat = statSync(fullPath, { throwIfNoEntry: false });
      if (!stat) continue;
      if (stat.isDirectory()) {
        out.push(...collectJsonlFiles(fullPath));
      } else if (stat.isFile() && fullPath.endsWith(".jsonl")) {
        out.push(fullPath);
      }
    }
  }
  return out;
}

export function detectRealLogPaths(): RealLogPaths {
  return {
    pi: process.env.LAC_REAL_PI_SESSION ?? readDirLatestJsonl(join(homedir(), ".pi/agent/sessions")),
    claude: process.env.LAC_REAL_CLAUDE_SESSION ?? readDirLatestJsonl(join(homedir(), ".claude/projects")),
    codex: process.env.LAC_REAL_CODEX_SESSION ?? readDirLatestJsonl(join(homedir(), ".codex/archived_sessions")),
  };
}

export function detectRecentRealLogPaths(limit = 3): RealLogPathLists {
  const piOverride = process.env.LAC_REAL_PI_SESSION;
  const claudeOverride = process.env.LAC_REAL_CLAUDE_SESSION;
  const codexOverride = process.env.LAC_REAL_CODEX_SESSION;

  return {
    pi: piOverride ? [piOverride] : readDirRecentJsonl(join(homedir(), ".pi/agent/sessions"), limit),
    claude: claudeOverride ? [claudeOverride] : readDirRecentJsonl(join(homedir(), ".claude/projects"), limit),
    codex: codexOverride ? [codexOverride] : readDirRecentJsonl(join(homedir(), ".codex/archived_sessions"), limit),
  };
}

export function requireRealLogPaths(): RealLogPaths {
  const paths = detectRealLogPaths();
  const missing: string[] = [];

  if (!paths.pi || !existsSync(paths.pi)) missing.push("pi");
  if (!paths.claude || !existsSync(paths.claude)) missing.push("claude");
  if (!paths.codex || !existsSync(paths.codex)) missing.push("codex");

  if (missing.length > 0) {
    throw new Error(
      `Missing required real session logs for: ${missing.join(", ")}. ` +
        `Set LAC_REAL_PI_SESSION / LAC_REAL_CLAUDE_SESSION / LAC_REAL_CODEX_SESSION or ensure the default log locations exist.`,
    );
  }

  return paths;
}
