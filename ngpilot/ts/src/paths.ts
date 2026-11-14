import * as fs from "fs";
import * as path from "path";
import {
  loadUserConfig,
  parseRootsEnv,
  saveUserConfig,
  USER_CONFIG_PATH,
} from "./user_config";

/** Installed package / tool root (parent of ts/). */
export const TOOL_ROOT = path.resolve(__dirname, "..", "..");

/** Shown in help / docs for the durable user config file. */
export const USER_CONFIG_HINT = USER_CONFIG_PATH;

export function defaultLogsDir(): string {
  return path.join(TOOL_ROOT, "logs");
}

export function defaultRunsDir(logsDir?: string): string {
  return path.join(logsDir || defaultLogsDir(), "runs");
}

export function defaultImpactLogBase(logsDir?: string): string {
  return path.join(
    logsDir || defaultLogsDir(),
    "components_impact_area.csv"
  );
}

/**
 * Resolve a configured impact-log path into sibling JSON + CSV paths.
 * Accepts `.json`, `.csv`, or a base path without those extensions.
 */
export function pairImpactLogPaths(configuredPath: string): {
  jsonPath: string;
  csvPath: string;
} {
  const resolved = path.resolve(configuredPath);
  const ext = path.extname(resolved).toLowerCase();
  if (ext === ".json") {
    return {
      jsonPath: resolved,
      csvPath: resolved.slice(0, -5) + ".csv",
    };
  }
  if (ext === ".csv") {
    return {
      jsonPath: resolved.slice(0, -4) + ".json",
      csvPath: resolved,
    };
  }
  return {
    jsonPath: resolved + ".json",
    csvPath: resolved + ".csv",
  };
}

export function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

/**
 * Resolve logs directory.
 * Priority: explicit override → env NGPILOT_LOGS → saved config → default tool logs/.
 * Does not write config; callers persist CLI/interactive values explicitly.
 */
export function resolveLogsDir(override?: string | null): {
  dir: string;
  source: "cli" | "env" | "config" | "default";
} {
  if (override && override.trim()) {
    return { dir: path.resolve(override.trim()), source: "cli" };
  }
  const env = process.env.NGPILOT_LOGS?.trim();
  if (env) {
    return { dir: path.resolve(env), source: "env" };
  }
  const saved = loadUserConfig().logsDir?.trim();
  if (saved) {
    return { dir: path.resolve(saved), source: "config" };
  }
  return { dir: defaultLogsDir(), source: "default" };
}

/**
 * Resolve runs directory.
 * Priority: override → env NGPILOT_RUNS → saved config → $logs/runs → default.
 */
export function resolveRunsDir(
  override?: string | null,
  logsDirResolved?: { dir: string; source: string }
): { dir: string; source: "cli" | "env" | "config" | "derived" | "default" } {
  if (override && override.trim()) {
    return { dir: path.resolve(override.trim()), source: "cli" };
  }
  const env = process.env.NGPILOT_RUNS?.trim();
  if (env) {
    return { dir: path.resolve(env), source: "env" };
  }
  const saved = loadUserConfig().runsDir?.trim();
  if (saved) {
    return { dir: path.resolve(saved), source: "config" };
  }
  const logs = logsDirResolved || resolveLogsDir();
  return {
    dir: defaultRunsDir(logs.dir),
    source: logs.source === "default" ? "default" : "derived",
  };
}

/**
 * Resolve impact log sibling paths.
 * Priority: override → env NGPILOT_IMPACT_LOG → saved config → $logs/components_impact_area.csv.
 */
export function resolveImpactLogPaths(override?: string | null): {
  jsonPath: string;
  csvPath: string;
  configuredPath: string;
  source: "cli" | "env" | "config" | "derived" | "default";
} {
  if (override && override.trim()) {
    const configuredPath = path.resolve(override.trim());
    const pair = pairImpactLogPaths(configuredPath);
    return { ...pair, configuredPath, source: "cli" };
  }
  const env = process.env.NGPILOT_IMPACT_LOG?.trim();
  if (env) {
    const configuredPath = path.resolve(env);
    const pair = pairImpactLogPaths(configuredPath);
    return { ...pair, configuredPath, source: "env" };
  }
  const saved = loadUserConfig().impactLog?.trim();
  if (saved) {
    const configuredPath = path.resolve(saved);
    const pair = pairImpactLogPaths(configuredPath);
    return { ...pair, configuredPath, source: "config" };
  }
  const logs = resolveLogsDir();
  const configuredPath = defaultImpactLogBase(logs.dir);
  const pair = pairImpactLogPaths(configuredPath);
  return {
    ...pair,
    configuredPath,
    source: logs.source === "default" ? "default" : "derived",
  };
}

/**
 * Resolve repository roots (not yet normalized to absolute existing paths).
 * Priority: override → env NGPILOT_ROOTS → saved config → undefined (caller prompts or cwd).
 */
export function resolveRootsInput(overrideRoots?: string[] | null): {
  roots: string[] | undefined;
  source: "cli" | "env" | "config" | "unset";
} {
  if (overrideRoots && overrideRoots.length) {
    return { roots: overrideRoots, source: "cli" };
  }
  const envRoots = parseRootsEnv(process.env.NGPILOT_ROOTS);
  if (envRoots) {
    return { roots: envRoots, source: "env" };
  }
  const saved = loadUserConfig().roots;
  if (saved && saved.length) {
    return { roots: saved, source: "config" };
  }
  return { roots: undefined, source: "unset" };
}

export function persistRoots(roots: string[]): void {
  saveUserConfig({ roots });
}

export function persistImpactLog(configuredPath: string): void {
  saveUserConfig({ impactLog: path.resolve(configuredPath) });
}

export function persistLogsDir(dir: string): void {
  saveUserConfig({ logsDir: path.resolve(dir) });
}

export function persistRunsDir(dir: string): void {
  saveUserConfig({ runsDir: path.resolve(dir) });
}
