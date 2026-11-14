import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface NgPilotUserConfig {
  roots?: string[];
  impactLog?: string;
  logsDir?: string;
  runsDir?: string;
  githubUserName?: string;
}

const CONFIG_DIR = path.join(os.homedir(), ".ngpilot");
export const USER_CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

export function loadUserConfig(): NgPilotUserConfig {
  try {
    if (!fs.existsSync(USER_CONFIG_PATH)) {
      return {};
    }
    const raw = fs.readFileSync(USER_CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as NgPilotUserConfig;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function saveUserConfig(patch: NgPilotUserConfig): NgPilotUserConfig {
  const current = loadUserConfig();
  const next: NgPilotUserConfig = { ...current, ...patch };
  // Clear keys explicitly set to empty string / empty array if needed
  for (const key of Object.keys(patch) as Array<keyof NgPilotUserConfig>) {
    const value = patch[key];
    if (value === undefined) {
      continue;
    }
    (next as Record<string, unknown>)[key] = value;
  }
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(next, null, 2), "utf8");
  return next;
}

export function parseRootsEnv(raw: string | undefined): string[] | undefined {
  if (!raw || !raw.trim()) {
    return undefined;
  }
  const parts = raw
    .split(/[;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : undefined;
}
